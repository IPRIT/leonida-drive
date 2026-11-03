// Protocol-level Node client (tests, load-test bots). Decodes every server message type; keeps the latest record per
// remote entity. Uses the `ws` package (installed in server/).
import WebSocket from 'ws';
import { S_FEATURES, S_ADMIN, S_MAP, readJson } from '../../src/net/shared/extensions.js';
import {
  HF_TOKEN, HF_RESUME, S_WELCOME, S_CELL, S_GLOBAL, S_RADAR, S_INFO, S_WALLET, S_RANK, S_PONG, S_SPAWN_ACK, S_CORRECTION, S_NICK,
  S_EVENT, S_KICK, S_NOTICE, S_TICK, S_DENSITY, S_ECON, S_OWNED, S_PROGRESS, STATE_SIZE, STATE_EXT_SIZE, S_FX, S_DAMAGE, S_GARAGE, S_LIST, FX,
  S_PULSE, REC_FULL, REC_ROT, REC_STEER, REC_TURRET, S_QUEUE, S_ADMIT,
} from '../../src/net/shared/constants.js';
import {
  encodeHello, writeState, encodePing, encodeClaim, encodeSpawn, encodeInfoReq, encodeReroll, encodeEvent, encodeEcon, decodeWelcome,
  decodeGlobal, readRecord, cellX0, cellZ0, CELL_HDR, GONE_SIZE, decodeWallet, decodeEconReply, decodeOwned, decodeProgress, readInfo,
  decodeNick, readServerEvent, readFx, readHit, readDamage, decodeGarage, decodeListPage, encodeFire, encodeService, encodeOutfit, encodeNickReq,
  encodeList, readPulse, unwrapTick, encodeVis, decodeQueue, readRadarEntry, radarWinX0, radarWinZ0, RADAR_HDR, RADAR_ENTRY,
} from '../../src/net/shared/protocol.js';

export class TestClient {
  constructor(url, { token = null, origin = 'http://localhost:5317', resume = false, keepRecords = true, localAddress } = {}) {
    this.url = url;
    this.token = token;
    this.origin = origin;
    this.resume = resume;
    this.keepRecords = keepRecords;
    this.localAddress = localAddress;
    this.handlers = new Map();
    this.records = new Map(); // netId → { ...record, tick }
    this.welcome = null;
    this.global = null;
    this.bytesIn = 0; this.msgsIn = 0; this.cellMsgs = 0; this.recordsIn = 0;
    this.lastTick = 0;
    this.lastParts = new Map(); // netId → last record (partial records reuse model/flags/rotation/steer/turret)
    this.seq = 0;
    this.corr = 0;
    this.stateBuf = new ArrayBuffer(STATE_SIZE);
    this.stateDV = new DataView(this.stateBuf);
    this.stateExtBuf = new ArrayBuffer(STATE_EXT_SIZE);
    this.stateExtDV = new DataView(this.stateExtBuf);
    this.closed = false;
    this.kick = null;
  }

  on(type, fn) { let l = this.handlers.get(type); if (!l) this.handlers.set(type, (l = [])); l.push(fn); return this; }
  _emit(type, p) { const l = this.handlers.get(type); if (l) for (const fn of [...l]) fn(p); }

  /** Wait for the next message of `type` matching pred (with a timeout). */
  next(type, pred = () => true, ms = 3000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { const l = this.handlers.get(type); const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); rej(new Error(`timeout waiting for 0x${type.toString(16)}`)); }, ms);
      const fn = (p) => { if (pred(p)) { clearTimeout(t); const l = this.handlers.get(type); l.splice(l.indexOf(fn), 1); res(p); } };
      this.on(type, fn);
    });
  }

  /** Open + HELLO; resolves on the first WELCOME ({ welcome }) or QUEUE ({ queue }), rejects on a kick. */
  join(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const done = (r) => { clearTimeout(t); resolve(r); };
      const t = setTimeout(() => reject(new Error('join timeout')), timeoutMs);
      this.on(S_QUEUE, (q) => done({ queue: q }));
      this.connect(timeoutMs).then((w) => done({ welcome: w }), (e) => { clearTimeout(t); reject(e); });
    });
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: this.origin ? { Origin: this.origin } : {}, perMessageDeflate: false, localAddress: this.localAddress });
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const t = setTimeout(() => { reject(new Error('connect timeout')); ws.terminate(); }, timeoutMs);
      ws.on('open', () => {
        const tok = this.token ? new Uint8Array(this.token) : null;
        ws.send(encodeHello(tok, (tok ? HF_TOKEN : 0) | (this.resume ? HF_RESUME : 0)));
      });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('error', (e) => { clearTimeout(t); reject(e); });
      ws.on('unexpected-response', (req, res) => { clearTimeout(t); reject(new Error(`HTTP ${res.statusCode}`)); });
      ws.on('close', (code) => { this.closed = true; this.closeCode = code; this._emit('close', code); });
      this.on(S_WELCOME, (w) => { clearTimeout(t); resolve(w); });
      this.on(S_QUEUE, () => clearTimeout(t)); // waiting in line: connected, the WELCOME comes when admitted
      this.on(S_KICK, (code) => { clearTimeout(t); reject(Object.assign(new Error(`kicked ${code}`), { code })); });
    });
  }

  _onMessage(ab) {
    this.bytesIn += ab.byteLength;
    this.msgsIn++;
    const dv = new DataView(ab);
    const type = dv.getUint8(0);
    switch (type) {
      case S_FEATURES: case S_ADMIN: this._emit(type, readJson(dv)); break;
      case S_MAP: this._emit(type, dv); break;
      case S_WELCOME: {
        const w = decodeWelcome(dv);
        this.welcome = w;
        this.lastTick = w.tick;
        if (w.token) this.token = w.token;
        this._emit(S_WELCOME, w);
        break;
      }
      case S_CELL: {
        this.cellMsgs++;
        const stream = dv.getUint8(1), cell = dv.getUint16(2, true), tick = unwrapTick(dv.getUint16(4, true), this.lastTick), n = dv.getUint8(6), g = dv.getUint8(7);
        this.lastTick = Math.max(this.lastTick, tick);
        this.recordsIn += n;
        const x0 = cellX0(cell), z0 = cellZ0(cell);
        const gone = [];
        let o = CELL_HDR;
        for (let i = 0; i < g; i++, o += GONE_SIZE) {
          const id = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16);
          gone.push({ id, to: dv.getUint16(o + 3, true) });
          this.lastParts.delete(id);
        }
        const recs = [];
        for (let i = 0; i < n; i++) {
          const r = readRecord(dv, o, x0, z0, {});
          o += r.size;
          r.tick = tick; r.stream = stream;
          // v4 records carry the low-rate parts only when they changed: fill them in from the last known record
          const prev = this.lastParts.get(r.id);
          if (!(r.parts & REC_FULL) && prev) { r.model = prev.model; r.flags = prev.flags; }
          if (!(r.parts & REC_ROT)) { r.pitch = prev?.pitch ?? 0; r.roll = prev?.roll ?? 0; }
          if (!(r.parts & REC_STEER)) r.steer = prev?.steer ?? 0;
          if (!(r.parts & REC_TURRET) && prev?.turret !== undefined && r.flags & 0x8000) { r.turret = prev.turret; r.barrel = prev.barrel; }
          this.lastParts.set(r.id, r);
          if (this.keepRecords) this.records.set(r.id, r);
          recs.push(r);
        }
        this._emit(S_CELL, { stream, cell, tick, recs, gone });
        break;
      }
      case S_GLOBAL: this.global = decodeGlobal(dv); this._emit(S_GLOBAL, this.global); break;
      case S_QUEUE: this.queue = decodeQueue(dv); this._emit(S_QUEUE, this.queue); break;
      case S_ADMIT: this.admitted = true; this._emit(S_ADMIT, true); break;
      case S_PULSE: this.pulse = readPulse(dv); this.lastTick = Math.max(this.lastTick, this.pulse.tick); this._emit(S_PULSE, this.pulse); break;
      case S_TICK: this.lastTick = Math.max(this.lastTick, dv.getUint32(4, true)); this._emit(S_TICK, this.lastTick); break;
      case S_WALLET: { const w = decodeWallet(dv); this.money = w.balance; this._emit(S_WALLET, w); break; }
      case S_ECON: { const r = decodeEconReply(dv); this.money = r.money; this._emit(S_ECON, r); break; }
      case S_OWNED: this.owned = decodeOwned(dv); this._emit(S_OWNED, this.owned); break;
      case S_PROGRESS: this.progress = decodeProgress(dv); this._emit(S_PROGRESS, this.progress); break;
      case S_RANK: this.rank = { rank: dv.getUint32(4, true), total: dv.getUint32(8, true) }; this._emit(S_RANK, this.rank); break;
      case S_PONG: {
        const p = { id: dv.getUint16(2, true), clientTime: dv.getFloat64(4, true), serverTime: dv.getFloat64(12, true) };
        const rtt = performance.now() - p.clientTime;
        if (!(rtt > this.bestRtt)) { this.bestRtt = rtt; this.offset = p.serverTime - (p.clientTime + rtt / 2); }
        this._emit(S_PONG, p);
        break;
      }
      case S_SPAWN_ACK: this._emit(S_SPAWN_ACK, { code: dv.getUint8(1), reqId: dv.getUint16(2, true), model: dv.getUint8(4), waitS: dv.getUint16(6, true) / 10 }); break;
      case S_CORRECTION: {
        const c = { reason: dv.getUint8(1), corr: dv.getUint8(2), x: dv.getInt32(4, true) / 100, y: dv.getInt32(8, true) / 100, z: dv.getInt32(12, true) / 100 };
        this.corr = c.corr;
        this._emit(S_CORRECTION, c);
        break;
      }
      case S_NICK: { const r = decodeNick(dv); if (r.money >= 0) this.money = r.money; this._emit(S_NICK, r); break; }
      case S_EVENT: this._emit(S_EVENT, readServerEvent(dv)); break;
      case S_INFO: {
        const n = dv.getUint8(1), out = [];
        let o = 2;
        for (let i = 0; i < n; i++) { const r = {}; o = readInfo(dv, o, r); out.push(r); }
        this._emit(S_INFO, out);
        break;
      }
      case S_FX: { const kind = dv.getUint8(1) & 0x0f; this._emit(S_FX, kind === FX.HIT ? readHit(dv) : readFx(dv)); break; }
      case S_DAMAGE: this._emit(S_DAMAGE, readDamage(dv)); break;
      case S_GARAGE: this.garage = decodeGarage(dv); this._emit(S_GARAGE, this.garage); break;
      case S_LIST: this._emit(S_LIST, decodeListPage(dv)); break;
      case S_RADAR: {
        const rc = dv.getUint16(2, true), count = dv.getUint16(8, true), total = dv.getUint16(10, true), entries = [];
        for (let i = 0; i < count && RADAR_HDR + (i + 1) * RADAR_ENTRY <= dv.byteLength; i++) entries.push(readRadarEntry(dv, RADAR_HDR + i * RADAR_ENTRY, radarWinX0(rc), radarWinZ0(rc), {}));
        this._emit(S_RADAR, { rc, tick: dv.getUint32(4, true), count, total, entries });
        break;
      }
      case S_DENSITY: this._emit(S_DENSITY, { nx: dv.getUint16(2, true), nz: dv.getUint16(4, true) }); break;
      case S_NOTICE: this._emit(S_NOTICE, { code: dv.getUint8(1), param: dv.getFloat64(4, true) }); break;
      case S_KICK: this.kick = dv.getUint8(1); this._emit(S_KICK, this.kick); break;
      default: break;
    }
  }

  /** s: { x, y, z, yaw, vx, vy, vz, model, flags, ... } — t defaults to now (ms). */
  sendState(s) {
    const st = { pitch: 0, roll: 0, yawRate: 0, steer: 0, flags: 0, health: 1, model: 0, vx: 0, vy: 0, vz: 0, yaw: 0, ...s };
    st.seq = ++this.seq;
    // server-clock stamps once a pong arrived (like the browser), otherwise the client's own clock
    if (s.t === undefined) { st.serverClock = this.offset !== undefined; st.t = Math.round(performance.now() + (this.offset ?? 0)) >>> 0; }
    st.tpc = this.corr;
    if (s.turret !== undefined) { writeState(this.stateExtDV, st); return this.send(this.stateExtBuf); }
    writeState(this.stateDV, st);
    return this.send(this.stateBuf);
  }
  fire(f) { this.send(encodeFire({ weapon: 1, seq: ++this.seq, t: Math.round(performance.now() + (this.offset ?? 0)) >>> 0, clear: 0, ...f })); }
  service(op, model = 0, opt = 255, rgb = 0, item = 0, reqId = ++this.seq) { this.send(encodeService(op, reqId, model, opt, rgb, item)); return reqId; }
  outfit(items) { this.send(encodeOutfit(items)); }
  vis(kind, data) { this.send(encodeVis(kind, data)); }
  nick(op, name = '', reqId = ++this.seq) { this.send(encodeNickReq(op, reqId, name)); return reqId; }
  list(order = 0, cursor = 0, reqId = ++this.seq) { this.send(encodeList(order, reqId, cursor)); return reqId; }
  send(buf) { if (this.ws?.readyState !== 1) return false; this.ws.send(buf); return true; }
  ping(id = 1) { this.send(encodePing(id, performance.now())); }
  claim(c) { this.send(encodeClaim({ seq: ++this.seq, ...c })); }
  econ(op, model, param = 0, reqId = ++this.seq) { this.send(encodeEcon(op, reqId, model, param)); return reqId; }
  spawn(model, rgb, x, z, reqId = 1) { this.send(encodeSpawn(reqId, model, rgb, x, z)); }
  infoReq(ids) { this.send(encodeInfoReq(ids)); }
  reroll(reqId = 1) { this.send(encodeReroll(reqId)); }
  event(kind, param = 0) { this.send(encodeEvent(kind, ++this.seq, param)); }
  close() { try { this.ws?.close(); } catch { /* closed */ } }
  terminate() { try { this.ws?.terminate(); } catch { /* closed */ } }
  modelIndex(id) { return this.welcome.models.findIndex((m) => m.id === id) + 1; }
}
