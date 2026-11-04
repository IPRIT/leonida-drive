// Gateway: one per I/O thread. Owns a uWS app (or the `ws` fallback), the sessions of its slot range, strict
// decoding/validation of client messages, and publishes the hub's pre-encoded cell buffers to its local pub/sub
// topics every tick (the transport fans them out in C++; nothing is re-encoded per client).
import { Buffer } from 'node:buffer';
import { GRID_CELLS, RADAR_CELLS, KICK, SLOT_MASK } from '../../src/net/shared/constants.js';
import { encodeKick, encodeQueue } from '../../src/net/shared/protocol.js';
import { enter, leave, position, release, etaSec, stats as queueStats, Q_VERSION } from './queue.js';
import { Session } from './session.js';
import { originAllowed } from './config.js';
import {
  ARENA_MAX_ENTRIES, ARENA_HDR, KIND_NEAR, KIND_FAR, KIND_RADAR, KIND_GLOBAL, KIND_PLAYER, STATS, ipSlot,
  STAT_CONN, STAT_MSGS_IN, STAT_BYTES_IN, STAT_PUB_BYTES, STAT_SESSIONS, STAT_REJECTED_UPGRADES, STAT_PUBLISHES, STAT_LAG_TICKS, H_T0, H_TICK_DT,
} from './shared-mem.js';
import { renderHealth, renderMetrics } from './metrics.js';
import { exportPool } from '../../src/economy/rules.js';
import { loadBlocklist } from './names.js';
import { setIpSecret, ipForLog } from './privacy.js';
import { MAP_HEADER, MAP_ENTRY, MAP_PAGE } from '../../src/net/shared/extensions.js';
import { AdminAuth } from './admin.js';
import { playerPose, travelDestination } from './admin-travel.js';

export const serverNow = () => performance.timeOrigin + performance.now();

export class Gateway {
  /**
   * @param {object} o { id, v (shared views), cfg, app (uWS-like), db (port-like: postMessage/on), world, vehicles, prices, range: [s0, s1], log }
   */
  constructor(o) {
    Object.assign(this, { id: o.id, v: o.v, cfg: o.cfg, app: o.app, db: o.db, world: o.world, vehicles: o.vehicles, log: o.log || console });
    setIpSecret(o.cfg.ipHashSecret);
    this.adminAuth = new AdminAuth(o.cfg.adminPasswordHash);
    this.adminTravelWait = new Map();
    this.toHub = o.toHub || (() => {});
    this.range = o.range;
    this.bySlot = new Map(); // slot → Session (direct hub messages: damage, hit confirmations)
    this.wardrobe = o.wardrobe || null;
    this.blocklist = loadBlocklist();
    const pricesObj = Object.fromEntries(o.prices);
    this.econCtx = {
      prices: o.prices, pricesObj, exportPool: exportPool(pricesObj), vehicles: o.vehicles, world: o.world, trials: o.trials || null,
      wardrobe: o.wardrobe || null,
    };
    this.starterCar = [...o.prices].find(([id, p]) => p.starter && o.vehicles.byId.get(id)?.vclass === 1)?.[0] || '';
    this.nextSid = 1;
    this.sessions = new Map(); // sid → Session
    this.byHash = new Map(); // token hash hex → Session (for kicks from the DB thread)
    this.free = [];
    for (let s = o.range[1] - 1; s >= o.range[0]; s--) this.free.push(s);
    this.lastTick = 0;
    this.sweepI = 0;
    this.connRate = new Map(); // ip → { n, t } new connections per minute (per thread)
    this.statBase = this.id * STATS;
    // topic names, pre-encoded (binary topics avoid string conversion on every publish)
    this.topics = [[], [], [], [Buffer.from('g')]];
    this.flushT = serverNow();
    this.pendingLoads = new Map();
    this.closing = false;
    // waiting queue (server full): ticket → session. Queued sessions are not in `sessions` (no sweep, no flush, no
    // per-tick work); their positions are refreshed in slices, only after someone ahead left or was admitted.
    this.queued = new Map();
    this.qIter = null; this.qPassVer = -1; this.qVer = 0;
    this.db.on('message', (m) => this.onDb(m));
    this._bind();
  }

  topic(kind, id) {
    const list = this.topics[kind];
    let t = list[id];
    if (!t) t = list[id] = Buffer.from([0x6e + kind, id & 0xff, id >> 8]); // 'n' 'o' 'p' + id
    return kind === KIND_GLOBAL ? this.topics[3][0] : t;
  }

  statAdd(i, n) { this.v.stats[this.statBase + i] += n; }

  requestAdminTravel(session, target, bring, id, now) {
    if (!playerPose(this.v, target)) return Promise.resolve({ ok: false, reason: 'player' });
    if (this.adminTravelWait.size >= 64) return Promise.resolve({ ok: false, reason: 'busy' });
    const key = `${session.sid}:${id}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.adminTravelWait.delete(key); resolve({ ok: false, reason: 'timeout' }); }, 35000);
      this.adminTravelWait.set(key, result => { clearTimeout(timer); this.adminTravelWait.delete(key); resolve(result); });
      this.toHub({ t: 'admin-travel', owner: this.id, sid: session.sid, id, actor: session.netId,
        mover: bring ? target : session.netId, anchor: bring ? session.netId : target, expires: now + 5000 });
    });
  }

  onAdminTravel(m) {
    const slot = m.mover & SLOT_MASK;
    if (slot < this.range[0] || slot >= this.range[1]) return;
    const reply = result => this.toHub({ t: 'admin-travel-result', owner: m.owner, sid: m.sid, id: m.id, result });
    const now = serverNow(), moving = this.bySlot.get(slot);
    const anchor = playerPose(this.v, m.anchor), actor = playerPose(this.v, m.actor);
    if (!moving || moving.netId !== m.mover || !anchor || !actor || now > m.expires) return reply({ ok: false, reason: 'player' });
    if (!moving.exactPlacement) return reply({ ok: false, reason: 'update' });
    if (moving.corrPending || moving.travelPending) return reply({ ok: false, reason: 'busy' });
    if (moving.health <= 0 || now < moving.deadUntil) return reply({ ok: false, reason: 'dead' });
    const pose = travelDestination(this.world, moving._vclass(), anchor);
    if (!pose) return reply({ ok: false, reason: 'space' });
    moving.beginAdminTravel(pose, now, reply);
  }

  onAdminTravelResult(m) { this.adminTravelWait.get(`${m.sid}:${m.id}`)?.(m.result); }

  /** Scheduled server time of tick T (the hub labels every tick with it). */
  tickTime(T) { return this.v.hub[H_T0] + T * this.v.hub[H_TICK_DT]; }

  // ---------------- transport ----------------
  _bind() {
    const cfg = this.cfg;
    this.app.ws('/*', {
      compression: 0,
      maxPayloadLength: 512,
      maxBackpressure: 1 << 21,
      closeOnBackpressureLimit: false,
      idleTimeout: 32,
      sendPingsAutomatically: true,
      upgrade: (res, req, ctx) => {
        const origin = req.getHeader('origin');
        const key = req.getHeader('sec-websocket-key');
        const proto = req.getHeader('sec-websocket-protocol');
        const ext = req.getHeader('sec-websocket-extensions');
        let ip = '';
        if (cfg.trustProxy) ip = req.getHeader('x-real-ip') || (req.getHeader('x-forwarded-for') || '').split(',')[0].trim();
        if (!ip) ip = Buffer.from(res.getRemoteAddressAsText()).toString();
        const reject = (status) => { this.statAdd(STAT_REJECTED_UPGRADES, 1); res.writeStatus(status).end(); };
        if (this.closing) return reject('503 Service Unavailable');
        if (!originAllowed(origin, cfg)) return reject('403 Forbidden');
        const slot = ipSlot(ip);
        if (Atomics.load(this.v.ipTable, slot) >= cfg.maxConnPerIp) return reject('429 Too Many Requests');
        const now = serverNow();
        let r = this.connRate.get(ip);
        if (!r || now - r.t > 60000) { r = { n: 0, t: now }; this.connRate.set(ip, r); }
        if (++r.n > cfg.connRatePerIp) return reject('429 Too Many Requests');
        // no capacity check here: a full server queues the connection after its HELLO (or refuses it when the queue
        // itself is full), so the client can show its place in line
        res.upgrade({ ip, ipSlot: slot, session: null }, key, proto, ext, ctx);
      },
      open: (ws) => {
        const ud = ws.getUserData();
        Atomics.add(this.v.ipTable, ud.ipSlot, 1);
        const s = new Session(this, ws, ud.ip, serverNow());
        ud.session = s;
        this.sessions.set(s.sid, s);
        this.statAdd(STAT_CONN, 1);
        this.statAdd(STAT_SESSIONS, 1);
      },
      message: (ws, ab, isBinary) => {
        const s = ws.getUserData().session;
        this.statAdd(STAT_MSGS_IN, 1);
        this.statAdd(STAT_BYTES_IN, ab.byteLength);
        // never let an exception escape into the transport: log it and drop the connection
        if (s) try { s.onMessage(ab, isBinary, serverNow()); } catch (e) { this.log.error(`message handler: ${e.stack || e}`); s.kick(KICK.INVALID, 'server error'); }
      },
      close: (ws) => {
        const ud = ws.getUserData();
        Atomics.sub(this.v.ipTable, ud.ipSlot, 1);
        const s = ud.session;
        if (!s) return;
        this.statAdd(STAT_SESSIONS, -1);
        try { s.onClose(); } catch (e) { this.log.error(`close handler: ${e.stack || e}`); }
        this.sessions.delete(s.sid);
        if (s.hash) { const k = s.hash.toString('hex'); if (this.byHash.get(k) === s) this.byHash.delete(k); }
      },
    });
    this.app.get('/health', (res, req) => this._http(res, req, 'health'));
    this.app.get('/status', (res, req) => this._status(res, req));
    this.app.options('/status', (res, req) => this._status(res, req, true));
    this.app.get('/metrics', (res, req) => this._http(res, req, 'metrics'));
    this.app.get('/', (res) => { res.writeHeader('Content-Type', 'text/plain').end('Leonida Drive multiplayer server. WebSocket: /ws\n'); });
    this.app.any('/*', (res) => { res.writeStatus('404 Not Found').end(); });
  }

  _http(res, req, what) {
    if (what === 'metrics' && this.cfg.metricsToken && req.getHeader('authorization') !== `Bearer ${this.cfg.metricsToken}`) {
      res.writeStatus('401 Unauthorized').end();
      return;
    }
    const body = what === 'health' ? renderHealth(this.v, this.cfg) : renderMetrics(this.v, this.cfg);
    res.cork(() => {
      res.writeHeader('Content-Type', what === 'health' ? 'application/json' : 'text/plain; version=0.0.4');
      res.writeHeader('Cache-Control', 'no-store');
      res.end(body);
    });
  }

  /**
   * Public, cacheable player count for the start screen: { ok, online, queue, capacity } from shared counters (O(1)).
   * CORS for the allowed origins (the game page is on another host).
   */
  _status(res, req, preflight = false) {
    const origin = req.getHeader('origin');
    const st = queueStats(this.v.q);
    const body = preflight ? '' : JSON.stringify({ ok: !this.closing, online: st.active, queue: st.waiting, capacity: this.cfg.capacity });
    res.cork(() => {
      res.writeHeader('Content-Type', 'application/json');
      res.writeHeader('Cache-Control', 'public, max-age=5');
      if (origin && originAllowed(origin, this.cfg)) {
        res.writeHeader('Access-Control-Allow-Origin', origin);
        res.writeHeader('Vary', 'Origin');
        if (preflight) { res.writeHeader('Access-Control-Allow-Methods', 'GET'); res.writeHeader('Access-Control-Max-Age', '86400'); }
      }
      res.end(body);
    });
  }

  // ---------------- admission & waiting queue ----------------
  /** After a valid HELLO: 'in' (capacity taken), 'queued' (waiting, QUEUE sent) or 'full' (queue full too). */
  enterOrQueue(session, now) {
    const q = this.v.q, cfg = this.cfg;
    const r = enter(q, this.id, cfg.capacity, cfg.queueMax);
    if (r.admitted) { session.counted = true; return 'in'; }
    if (r.full) return 'full';
    session.ticket = r.ticket;
    session.queuedAt = now;
    session.state = 'queued';
    this.sessions.delete(session.sid);
    this.queued.set(r.ticket, session);
    this._sendQueue(session, now, true);
    return 'queued';
  }

  _sendQueue(s, now, force = false) {
    const q = this.v.q, pos = position(q, s.ticket);
    if (!pos || (!force && pos === s.qPos)) return;
    if (!force && now - s.qSentT < 3000) { this.qDeferred = true; return; } // at most one update per 3 s: next pass
    s.qPos = pos; s.qSentT = now;
    s.send(encodeQueue(pos, Atomics.load(q.hdr, 2), etaSec(q, pos), this.cfg.capacity));
  }

  /** Socket closed while waiting: the place is gone (no reservation). */
  leaveQueue(session) {
    if (session.ticket < 0) return;
    leave(this.v.q, session.ticket);
    this.queued.delete(session.ticket);
    session.ticket = -1;
  }

  releaseCapacity() { release(this.v.q); }

  /** The admitter picked our ticket: ADMIT + join, or give the capacity back if the client left meanwhile. */
  onAdmit(ticket) {
    const s = this.queued.get(ticket);
    this.queued.delete(ticket);
    if (!s || s.closed) { release(this.v.q); return; }
    s.counted = true;
    this.sessions.set(s.sid, s);
    s.admit(serverNow());
  }

  // positions: a slice per tick (every queued client every 4 s), and only when someone ahead left or got in
  _queueTick(now) {
    if (!this.queued.size) { this.qIter = null; return; }
    if (!this.qIter) {
      const ver = Atomics.load(this.v.q.hdr, Q_VERSION);
      if (ver === this.qPassVer) return;
      this.qVer = ver;
      this.qDeferred = false;
      this.qIter = this.queued.values();
    }
    let n = Math.ceil(this.queued.size / 80);
    while (n-- > 0) {
      const it = this.qIter.next();
      if (it.done) { this.qIter = null; if (!this.qDeferred) this.qPassVer = this.qVer; return; }
      if (!it.value.closed) this._sendQueue(it.value, now);
    }
  }

  // ---------------- slots ----------------
  allocSlot() { return this.free.length ? this.free.pop() : -1; }
  freeSlot(s) { this.free.push(s); }

  // ---------------- interest ----------------
  sub(session, kind, id) {
    const v = this.v;
    if (session.closed) return;
    session.ws.subscribe(this.topic(kind, id));
    if (kind === KIND_NEAR) { Atomics.add(v.subNear, id, 1); Atomics.store(v.subDirty, id, 1); }
    else if (kind === KIND_FAR) { Atomics.add(v.subFar, id, 1); Atomics.store(v.subDirty, id, 1); }
    else if (kind === KIND_RADAR) Atomics.add(v.subRadar, id, 1);
  }
  unsub(session, kind, id) {
    const v = this.v;
    try { session.ws.unsubscribe(this.topic(kind, id)); } catch { /* socket already closed: uWS drops its topics */ }
    if (kind === KIND_NEAR) Atomics.sub(v.subNear, id, 1);
    else if (kind === KIND_FAR) Atomics.sub(v.subFar, id, 1);
    else if (kind === KIND_RADAR) Atomics.sub(v.subRadar, id, 1);
  }

  /** Right after WELCOME: the latest pulse (online count, board version). */
  sendGlobal(session) {
    const v = this.v;
    if (v.pulseMsg[0]) session.send(v.pulseMsg.slice(0, 16));
  }

  /** On request (scoreboard / pause menu open): the top-10 board. */
  sendBoard(session) {
    const v = this.v, len = v.globalLen[0];
    if (len > 0) session.send(v.globalMsg.slice(0, len));
  }

  /** On request (full map open): the player heatmap. */
  sendDensity(session) {
    const v = this.v, len = v.densityLen[0];
    if (len > 0) session.send(v.densityMsg.slice(0, len));
  }

  sendMap(session, cursor, now) {
    const v = this.v;
    Atomics.store(v.mapMeta, 2, this.lastTick);
    if (!cursor || !session.mapSnapshot || now - session.mapSnapshotAt > 30000) {
      if (now - (session.mapAskedAt ?? -1e12) < 1800) return;
      session.mapAskedAt = now;
      const ver = Atomics.load(v.mapMeta, 0), len = Atomics.load(v.mapMeta, 1);
      if ((ver & 1) || !len) { session.mapAskedAt = -1e12; return; }
      if (this.mapVersion !== ver) {
        const copy = v.mapMsg.slice(0, len);
        if (Atomics.load(v.mapMeta, 0) !== ver) { session.mapAskedAt = -1e12; return; }
        this.mapSnapshot = copy; this.mapVersion = ver;
      }
      session.mapSnapshot = this.mapSnapshot; session.mapSnapshotAt = now; cursor = 0;
    }
    const source = session.mapSnapshot, dv = new DataView(source.buffer), total = dv.getUint32(4, true);
    if (cursor > total) return;
    const n = Math.min(MAP_PAGE, total - cursor), end = cursor + n;
    const out = new Uint8Array(MAP_HEADER + n * MAP_ENTRY), view = new DataView(out.buffer);
    out.set(source.subarray(0, MAP_HEADER));
    view.setUint8(1, end === total ? 1 : 0); view.setUint16(2, n, true); view.setUint32(8, cursor, true);
    out.set(source.subarray(MAP_HEADER + cursor * MAP_ENTRY, MAP_HEADER + end * MAP_ENTRY), MAP_HEADER);
    session.send(out);
    if (end === total) session.mapSnapshot = null;
  }

  // ---------------- tick: publish the hub's arena ----------------
  onTick(T, b) {
    const v = this.v, h = b * ARENA_HDR;
    Atomics.add(v.arenaHdr, h + 3, 1);
    try {
      if (Atomics.load(v.arenaHdr, h) !== T) { this.statAdd(STAT_LAG_TICKS, 1); return; } // overwritten: we fell behind
      if (T > this.lastTick + 1 && this.lastTick) this.statAdd(STAT_LAG_TICKS, T - this.lastTick - 1);
      this.lastTick = T;
      const n = v.arenaHdr[h + 1];
      const idx = v.arenaIdx, base = b * ARENA_MAX_ENTRIES * 3, data = v.arenaData, app = this.app;
      const sample = (T % 20) === 7; // estimate egress bytes on one tick in 20 (off the global/radar phase)
      let bytes = 0;
      for (let i = 0; i < n; i++) {
        const k = idx[base + i * 3], off = idx[base + i * 3 + 1], len = idx[base + i * 3 + 2];
        if ((k >>> 24) === KIND_PLAYER) { // direct message to one player (damage, hit confirmation): only its gateway acts
          const s = this.bySlot.get(k & 0xffffff);
          if (s) s.onHub(data.subarray(off, off + len), off);
          continue;
        }
        const topic = this.topic(k >>> 24, k & 0xffffff);
        app.publish(topic, data.subarray(off, off + len), true, false);
        if (sample) bytes += (len + (len < 126 ? 2 : 4)) * app.numSubscribers(topic);
      }
      this.statAdd(STAT_PUBLISHES, n);
      if (sample) this.statAdd(STAT_PUB_BYTES, bytes * 20);
    } finally {
      Atomics.sub(v.arenaHdr, h + 3, 1);
    }
    this._housekeeping(T);
  }

  _housekeeping(T) {
    const now = serverNow();
    // sweep a tenth of the sessions per tick (each one every 0.5 s)
    const k = T % 10;
    for (const s of this.sessions.values()) {
      if (s.sid % 10 !== k) continue;
      try { s.sweep(now); } catch (e) { this.log.error(`sweep: ${e.stack || e}`); }
    }
    if (now - this.flushT >= this.cfg.flushMs) { this.flushT = now; this.flush(now, false); }
    if ((T % 1200) === 0) for (const [ip, r] of this.connRate) if (now - r.t > 60000) this.connRate.delete(ip);
    this._queueTick(now);
  }

  // ---------------- persistence (DB thread) ----------------
  dbLoad(session) {
    const k = session.hash.toString('hex');
    const old = this.byHash.get(k);
    this.byHash.set(k, session);
    if (old && old !== session) old.kick(KICK.DUPLICATE, 'same profile reconnected');
    this.pendingLoads.set(session.sid, session);
    this.db.postMessage({ t: 'load', w: this.id, sid: session.sid, hash: new Uint8Array(session.hash), netId: session.netId });
  }

  dbRelease(session, rec) {
    this.pendingLoads.delete(session.sid);
    this.db.postMessage({ t: 'release', w: this.id, sid: session.sid, hash: new Uint8Array(session.hash), rec });
  }

  flushNow(session) {
    session.dirtyFast = false;
    session.dirtyPos = false;
    session.lastPosSave = serverNow();
    this.db.postMessage({ t: 'save', recs: [session.record()] });
  }

  flush(now, all) {
    const recs = [];
    for (const s of this.sessions.values()) {
      if (s.state !== 'active') continue;
      if (all || s.dirtyFast || (s.dirtyPos && now - s.lastPosSave >= this.cfg.posFlushMs)) {
        recs.push(s.record());
        s.dirtyFast = false;
        s.dirtyPos = false;
        s.lastPosSave = now;
      }
    }
    if (recs.length) this.db.postMessage({ t: 'save', recs });
    return recs.length;
  }

  securityLog(session, kind, detail) {
    // never the raw IP: the /24 (/48) network and a keyed tag that changes daily (src/privacy.js)
    const who = ipForLog(session.ip);
    this.log.warn?.(`[security] ${kind} ${who} id=${session.netId} ${detail}`);
    this.db.postMessage({ t: 'log', hash: session.hash ? new Uint8Array(session.hash) : null, kind, detail: `${detail} ${who}` });
  }

  onDb(m) {
    if (m.t === 'loaded') {
      const s = this.pendingLoads.get(m.sid);
      this.pendingLoads.delete(m.sid);
      if (s && !s.closed) s.onLoaded(m.rec, serverNow());
      else if (s) this.db.postMessage({ t: 'release', w: this.id, sid: m.sid, hash: m.hash, rec: null });
    } else if (m.t === 'nick') {
      const s = this.sessions.get(m.sid);
      if (s) s.onNickResult(m);
    } else if (m.t === 'kick') {
      const s = this.sessions.get(m.sid);
      if (s) s.kick(m.code || KICK.DUPLICATE, 'db kick');
      else this.db.postMessage({ t: 'release', w: this.id, sid: m.sid, hash: m.hash, rec: null });
    }
  }

  /** Graceful shutdown: tell clients, save everyone, close sockets. */
  shutdown() {
    this.closing = true;
    const now = serverNow();
    const n = this.flush(now, true);
    for (const s of this.sessions.values()) {
      try { s.ws.send(encodeKick(KICK.SHUTDOWN), true, false); } catch { /* closed */ }
      s.state = 'closing';
    }
    for (const s of [...this.sessions.values()]) {
      s.hash = null; // already saved above: closing must not re-save
      try { s.ws.end(1001, 'shutdown'); } catch { /* closed */ }
    }
    for (const s of [...this.queued.values()]) {
      s.hash = null;
      try { s.ws.send(encodeKick(KICK.SHUTDOWN), true, false); s.ws.end(1001, 'shutdown'); } catch { /* closed */ }
    }
    return n;
  }
}

export { GRID_CELLS, RADAR_CELLS };
