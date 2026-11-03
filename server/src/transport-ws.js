// Fallback transport on the pure-JS `ws` package, exposing the subset of the uWebSockets.js API the gateway uses.
// Pub/sub fan-out happens in JS here, but every published payload is still encoded once and the same Buffer is
// written to all subscribers (no per-client encoding).
import http from 'node:http';
import { WebSocketServer } from 'ws';

class Res {
  constructor(nodeRes, socket) { this.r = nodeRes; this.socket = socket; this.status = 200; this.headers = {}; this.done = false; }
  writeStatus(s) { this.status = parseInt(s, 10) || 200; this.statusText = s; return this; }
  writeHeader(k, v) { this.headers[k] = v; return this; }
  cork(fn) { fn(); return this; }
  getRemoteAddressAsText() { return new TextEncoder().encode((this.r?.socket || this.socket)?.remoteAddress || '').buffer; }
  end(body = '') {
    if (this.done) return this;
    this.done = true;
    if (this.r) { this.r.writeHead(this.status, this.headers); this.r.end(body); } else if (this.socket) {
      this.socket.end(`HTTP/1.1 ${this.statusText || this.status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
    return this;
  }
}
class Req {
  constructor(nodeReq) { this.q = nodeReq; }
  getHeader(k) { const v = this.q.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v || ''; }
  getUrl() { return this.q.url.split('?')[0]; }
}

class Sock {
  constructor(app, ws, userData) { this.app = app; this.ws = ws; this.ud = userData; this.topics = new Set(); }
  getUserData() { return this.ud; }
  getBufferedAmount() { return this.ws.bufferedAmount; }
  send(data, isBinary = true) {
    if (this.ws.readyState !== 1) return 2;
    if (this.ws.bufferedAmount > this.app.behavior.maxBackpressure) return 2;
    this.ws.send(toBuf(data), { binary: isBinary });
    return 1;
  }
  subscribe(t) { const k = key(t); this.topics.add(k); let s = this.app.topics.get(k); if (!s) this.app.topics.set(k, (s = new Set())); s.add(this); return true; }
  unsubscribe(t) { const k = key(t); this.topics.delete(k); const s = this.app.topics.get(k); if (s) { s.delete(this); if (!s.size) this.app.topics.delete(k); } return true; }
  end(code = 1000, reason = '') { try { this.ws.close(code, reason); } catch { this.ws.terminate(); } }
  close() { this.ws.terminate(); }
  cork(fn) { fn(); return this; }
}

const key = (t) => (typeof t === 'string' ? t : Buffer.from(t.buffer ? t.buffer : t, t.byteOffset || 0, t.byteLength ?? t.length).toString('latin1'));
const toBuf = (d) => (Buffer.isBuffer(d) ? d : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : Buffer.from(d));

class App {
  constructor() {
    this.routes = [];
    this.topics = new Map();
    this.behavior = null;
    this.server = http.createServer((req, res) => this._http(req, res));
    this.wss = null;
  }
  get(p, h) { this.routes.push(['GET', p, h]); return this; }
  options(p, h) { this.routes.push(['OPTIONS', p, h]); return this; }
  any(p, h) { this.routes.push(['*', p, h]); return this; }
  _http(req, res) {
    const url = req.url.split('?')[0];
    for (const [m, p, h] of this.routes) {
      if ((m === '*' || m === req.method) && (p === url || p === '/*')) { h(new Res(res), new Req(req)); return; }
    }
    res.writeHead(404).end();
  }
  ws(pattern, behavior) {
    this.behavior = { maxBackpressure: 1 << 21, ...behavior };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: behavior.maxPayloadLength || 512, perMessageDeflate: false });
    this.server.on('upgrade', (req, socket, head) => {
      const res = new Res(null, socket);
      res.upgrade = (userData) => {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          ws.binaryType = 'arraybuffer';
          const s = new Sock(this, ws, userData);
          let alive = true;
          ws.on('pong', () => { alive = true; });
          const idle = (behavior.idleTimeout || 32) * 1000;
          const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; try { ws.ping(); } catch { /* closing */ } }, idle / 2);
          ws.on('message', (data, isBinary) => behavior.message?.(s, data instanceof ArrayBuffer ? data : toAB(data), isBinary));
          ws.on('close', (code, reason) => {
            clearInterval(ping);
            for (const t of s.topics) { const set = this.topics.get(t); if (set) { set.delete(s); if (!set.size) this.topics.delete(t); } }
            behavior.close?.(s, code, reason);
          });
          ws.on('error', () => {});
          behavior.open?.(s);
        });
      };
      if (behavior.upgrade) behavior.upgrade(res, new Req(req), null);
      else res.upgrade({});
    });
    return this;
  }
  publish(topic, data) {
    const set = this.topics.get(key(topic));
    if (!set || !set.size) return false;
    const buf = Buffer.from(toBuf(data)); // one copy (the source may be a shared arena that is rewritten next tick)
    for (const s of set) s.send(buf, true);
    return true;
  }
  numSubscribers(topic) { return this.topics.get(key(topic))?.size || 0; }
  listen(host, port, cb) {
    if (typeof host === 'number') { cb = port; port = host; host = '0.0.0.0'; }
    this.server.once('error', () => cb(false));
    this.server.listen(port, host, () => cb(this.server));
    return this;
  }
  close() {
    for (const c of this.wss?.clients || []) c.terminate();
    this.server.close();
    this.server.closeAllConnections?.();
    return this;
  }
}

function toAB(d) {
  if (Array.isArray(d)) d = Buffer.concat(d);
  return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
}

export function AppFactory() { return new App(); }
export { AppFactory as App };
