// Minimal WebSocket client for the load test: raw TCP + RFC 6455 framing, no per-message allocations on receive.
// The `ws` package costs ~5-10 µs per received message; a bot process receiving 300k messages/s cannot keep up
// and starts behaving like a broken client (late pongs, bursty uploads). This client only scans frame headers and
// hands (type, buffer, offset, length) to a callback, so one process can drive thousands of bots.
import net from 'node:net';
import crypto from 'node:crypto';
import { encodeHello, writeState, encodePing } from '../../src/net/shared/protocol.js';
import { STATE_SIZE, HF_TOKEN, S_WELCOME, S_PONG, S_CORRECTION, S_QUEUE, S_KICK } from '../../src/net/shared/constants.js';

const toBuf = (x) => (Buffer.isBuffer(x) ? x : x instanceof ArrayBuffer ? Buffer.from(x) : Buffer.from(x.buffer, x.byteOffset, x.byteLength));

export class RawClient {
  /** onMsg(type, buf, off, len) is called for every binary message. */
  constructor(url, { origin = 'http://localhost:5317', token = null, onMsg = null } = {}) {
    this.url = new URL(url);
    this.origin = origin;
    this.token = token;
    this.onMsg = onMsg;
    this.sock = null;
    this.closed = false;
    this.open = false;
    this.carry = null;
    this.seq = 0;
    this.corr = 0;
    this.offset = undefined;
    this.bestRtt = Infinity;
    this.welcome = null;
    this._st = { pitch: 0, roll: 0, yawRate: 0, steer: 0, flags: 0, health: 1, model: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const { hostname, port, pathname } = this.url;
      const s = net.connect({ host: hostname, port: +port || 80, noDelay: true });
      this.sock = s;
      let hs = Buffer.alloc(0), done = false;
      const fail = (e) => { if (done) return; done = true; clearTimeout(t); s.destroy(); this.closed = true; reject(e); };
      const t = setTimeout(() => fail(new Error('connect timeout')), timeoutMs);
      s.once('error', (e) => fail(e));
      s.on('close', () => { this.closed = true; this.open = false; if (!done) fail(new Error('closed during handshake')); });
      s.once('connect', () => {
        const key = crypto.randomBytes(16).toString('base64');
        s.write(`GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
          + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${this.origin}\r\n\r\n`);
      });
      const onData = (chunk) => {
        if (!this.open) {
          hs = Buffer.concat([hs, chunk]);
          const end = hs.indexOf('\r\n\r\n');
          if (end < 0) return;
          const status = hs.toString('latin1', 0, 12);
          if (!/ 101/.test(status)) return fail(new Error(`HTTP ${status.slice(9, 12)}`));
          this.open = true;
          const rest = hs.subarray(end + 4);
          this.send(encodeHello(this.token, this.token ? HF_TOKEN : 0));
          this._wait = (w) => { if (done) return; done = true; clearTimeout(t); resolve(w); };
          if (rest.length) this._frames(rest);
          return;
        }
        this._frames(chunk);
      };
      s.on('data', onData);
    });
  }

  _frames(chunk) {
    let b = chunk;
    if (this.carry) { b = Buffer.concat([this.carry, chunk]); this.carry = null; }
    let o = 0;
    const n = b.length;
    while (n - o >= 2) {
      const op = b[o] & 0x0f;
      let len = b[o + 1] & 0x7f, h = 2;
      if (len === 126) { if (n - o < 4) break; len = b.readUInt16BE(o + 2); h = 4; }
      else if (len === 127) { if (n - o < 10) break; len = Number(b.readBigUInt64BE(o + 2)); h = 10; }
      if (n - o < h + len) break;
      const p = o + h;
      if (op === 0x2 && len > 0) {
        const type = b[p];
        if (type === S_WELCOME && !this.welcome) { this.welcome = { netId: b.readUInt32LE(p + 4) }; this._wait?.(this.welcome); }
        else if (type === S_QUEUE && len >= 16) { // server full: waiting in line (connect() resolves with { queue })
          this.queue = { position: b.readUInt32LE(p + 4), waiting: b.readUInt32LE(p + 8) };
          this.queueMsgs = (this.queueMsgs || 0) + 1;
          this._wait?.({ queue: this.queue });
        } else if (type === S_KICK) this.kick = b[p + 1];
        else if (type === S_CORRECTION) this.corr = b[p + 2];
        else if (type === S_PONG && len >= 20) {
          // pong: NTP-style offset from the lowest-RTT sample (same as the browser's ClockSync)
          const now = performance.now(), sent = b.readDoubleLE(p + 4), rtt = now - sent;
          this.lastRtt = rtt;
          if (rtt <= this.bestRtt) { this.bestRtt = rtt; this.offset = b.readDoubleLE(p + 12) - (sent + rtt / 2); }
        }
        if (this.onMsg) this.onMsg(type, b, p, len);
      } else if (op === 0x9) this._ctrl(0x8a, b.subarray(p, p + len)); // ping → pong
      else if (op === 0x8) { this.terminate(); return; }
      o = p + len;
    }
    if (o < n) this.carry = Buffer.from(b.subarray(o));
  }

  _ctrl(op, payload) {
    const f = Buffer.allocUnsafe(6 + payload.length);
    f[0] = op; f[1] = 0x80 | payload.length; f.writeUInt32BE(0, 2);
    payload.copy(f, 6);
    this.sock.write(f);
  }

  /** One masked binary frame (zero mask key: the payload goes out as is). */
  send(x) {
    if (!this.open || this.closed) return;
    const p = toBuf(x), len = p.length, h = len < 126 ? 6 : 8;
    const f = Buffer.allocUnsafe(h + len);
    f[0] = 0x82;
    if (len < 126) { f[1] = 0x80 | len; f.writeUInt32BE(0, 2); }
    else { f[1] = 0x80 | 126; f.writeUInt16BE(len, 2); f.writeUInt32BE(0, 4); }
    p.copy(f, h);
    this.sock.write(f);
  }

  sendState(s) {
    if (!this.open || this.closed) return;
    const st = Object.assign(this._st, s);
    st.seq = (this.seq = (this.seq + 1) & 0xffff);
    st.tpc = this.corr;
    const f = Buffer.allocUnsafe(6 + STATE_SIZE);
    f[0] = 0x82; f[1] = 0x80 | STATE_SIZE; f.writeUInt32BE(0, 2);
    writeState(new DataView(f.buffer, f.byteOffset + 6, STATE_SIZE), st);
    this.sock.write(f);
  }

  ping(id = 1) { this.send(encodePing(id, performance.now())); }
  terminate() { this.closed = true; this.open = false; try { this.sock?.destroy(); } catch { /* gone */ } }
}
