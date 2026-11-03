// WebSocket connection: handshake with the stored session token, binary decoding (straight into the remote store's
// ring buffers inside onmessage, so the render loop only interpolates), clock sync, reconnect with exponential
// backoff + jitter, and an "offline" state when the server can't be reached.
import {
  HF_TOKEN, HF_RESUME, S_WELCOME, S_CELL, S_GLOBAL, S_RADAR, S_INFO, S_WALLET, S_RANK, S_PONG, S_SPAWN_ACK, S_CORRECTION, S_NICK,
  S_EVENT, S_KICK, S_NOTICE, S_TICK, S_DENSITY, S_ECON, S_OWNED, S_PROGRESS, KICK, STATE_SIZE, STATE_EXT_SIZE, S_FX, S_DAMAGE, S_GARAGE,
  S_LIST, FX, S_PULSE, LIST, S_QUEUE, S_ADMIT,
} from './shared/constants.js';
import {
  encodeHello, encodePing, decodeWelcome, decodeGlobal, readRecord, cellX0, cellZ0, CELL_HDR, GONE_SIZE, decodeWallet, decodeEconReply,
  decodeOwned, decodeProgress, readInfo, RADAR_HDR, RADAR_ENTRY, readRadarEntry, radarWinX0, radarWinZ0, encodeInfoReq,
  writeState, decodeNick, readServerEvent, readFx, readHit, readDamage, decodeGarage, decodeListPage, readPulse, unwrapTick, decodeQueue,
  encodeList,
} from './shared/protocol.js';
import { RemoteStore } from './RemoteStore.js';
import { RadarTracks } from './RadarTracks.js';
import { nickName } from './shared/nicknames.js';
import { ClockSync } from './ClockSync.js';
import { itemOfCode, lookOfCodes } from './shared/outfit-codes.js';

const TOKEN_KEY = 'leonida.mp.token';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Server URL: VITE_MP_URL, else the local dev server on localhost, else production. */
export function serverUrl() {
  let env = '';
  try { env = import.meta.env?.VITE_MP_URL || ''; } catch { /* not bundled by Vite */ }
  if (env) return env;
  const host = typeof location !== 'undefined' ? location.hostname : 'localhost';
  if (LOCAL_HOSTS.has(host)) {
    // dev override (localhost only, so a link can't send someone's token elsewhere): ?mp=ws://host:port/ws
    try { const q = new URLSearchParams(location.search).get('mp'); if (q && /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(q)) return q; } catch { /* ignore */ }
    return 'ws://127.0.0.1:8787/ws';
  }
  return 'wss://mp.leonida-drive.io/ws';
}

function loadToken() {
  try {
    const s = localStorage.getItem(TOKEN_KEY);
    if (!s) return null;
    const bin = atob(s);
    if (bin.length !== 32) return null;
    const u8 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch { return null; }
}
function saveToken(u8) {
  try { localStorage.setItem(TOKEN_KEY, btoa(String.fromCharCode(...u8))); } catch { /* private mode: session-only identity */ }
}

const REPLAY = new Set(['welcome', 'owned', 'progress', 'rank', 'wallet', 'garage']);
const _rec = {};
const _info = {};
const _radar = {};

export class NetClient {
  constructor(opts = {}) {
    this.url = opts.url || serverUrl();
    this.store = new RemoteStore({ tickDt: 50 });
    this.clock = new ClockSync();
    this.status = 'idle'; // idle | connecting | queued | online | reconnecting | offline | kicked
    this.queue = null; // { position, waiting, etaSec, capacity, at } while waiting in line (server full)
    this.cancelled = false; // the player left the line (or chose offline): no reconnects until rejoin()
    this.handlers = new Map();
    this.lastMsg = {};
    this.welcome = null;
    this.global = null;
    this.ws = null;
    this.attempt = 0;
    this.everOnline = false;
    this.kickCode = 0;
    this.pingId = 0;
    this.pingT = 0;
    this.pings = 0;
    this.token = loadToken();
    this.models = []; // index → { id, vclass }
    this.modelIndex = new Map(); // catalog id → index
    this.radar = { n: 0, total: 0, x: new Float32Array(256), z: new Float32Array(256), color: new Uint8Array(256), yaw: new Float32Array(256), vclass: new Uint8Array(256), t: 0 };
    this.tracks = new RadarTracks(); // smooth minimap blips for players outside the interest rings
    this.density = null;
    this.infoQueue = new Set();
    this.radarInfoQueue = new Set();
    this.radarNames = new Map();
    this.infoT = 0;
    this.bytesIn = 0; this.bytesOut = 0;
    this.statsT = 0; this.kbps = 0; this._bytesAt = 0;
    this.stateBuf = new ArrayBuffer(STATE_SIZE);
    this.stateDV = new DataView(this.stateBuf);
    this.stateExtBuf = new ArrayBuffer(STATE_EXT_SIZE); // turret vehicles
    this.stateExtDV = new DataView(this.stateExtBuf);
    this.wardrobe = []; // wardrobe item ids by wire index - 1 (S_GARAGE)
    this.wardrobeSlots = [];
    this.store.onInfoWanted = (e) => this.infoQueue.add(e.id);
    this._timer = null;
    this._welcomeTimer = null;
    this.offlineSince = 0; // performance.now() when offline play started (server unreachable), 0 = not offline
    this.playedOffline = false;
  }

  on(type, fn) { let l = this.handlers.get(type); if (!l) this.handlers.set(type, (l = new Set())); l.add(fn); return () => l.delete(fn); }
  _emit(type, p) {
    if (REPLAY.has(type)) this.lastMsg[type] = p;
    const l = this.handlers.get(type);
    if (l) for (const fn of l) { try { fn(p); } catch (e) { console.error('[net]', e); } }
  }

  /** Subscribe and immediately receive the latest state message of that type (modules created after it arrived). */
  onState(type, fn) {
    const off = this.on(type, fn);
    if (this.lastMsg[type] !== undefined) { try { fn(this.lastMsg[type]); } catch (e) { console.error('[net]', e); } }
    return off;
  }

  _setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    this._emit('status', s);
  }

  // ---------------- connection ----------------
  connect() {
    if (this.ws || this.status === 'kicked' || this.cancelled) return;
    if (typeof WebSocket === 'undefined') { this._setStatus('offline'); return; }
    this._setStatus(this.everOnline ? 'reconnecting' : this.attempt ? (this.status === 'offline' ? 'offline' : 'reconnecting') : 'connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch { this._scheduleReconnect(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      // after a disconnect, or after playing offline, the player may have moved on: tell the server for how long
      const offS = this.offlineSince ? (performance.now() - this.offlineSince) / 1000 : 0;
      const flags = (this.token ? HF_TOKEN : 0) | (this.everOnline || this.playedOffline ? HF_RESUME : 0);
      ws.send(encodeHello(this.token, flags, 1, offS));
      this.bytesOut += 40;
    };
    // the event's timeStamp is when the message arrived, even if the main thread was busy rendering a frame
    ws.onmessage = (ev) => this._onMessage(ev.data, ev.timeStamp > 0 && ev.timeStamp <= performance.now() ? ev.timeStamp : performance.now());
    ws.onclose = () => this._onClose();
    ws.onerror = () => { /* onclose follows */ };
    // no WELCOME within 4 s on the very first attempt: play offline meanwhile (we keep retrying)
    clearTimeout(this._welcomeTimer);
    this._welcomeTimer = setTimeout(() => { if (!this.welcome && !this.everOnline) this._goOffline(); }, 4000);
  }

  // the server can't be reached: play offline (local rules) and keep retrying in the background
  _goOffline() {
    if (!this.offlineSince) this.offlineSince = performance.now();
    this.playedOffline = true;
    this._setStatus('offline');
  }

  _onClose() {
    this.ws = null;
    clearTimeout(this._welcomeTimer);
    const wasOnline = this.status === 'online';
    if (this.welcome) this.lastWelcome = this.welcome;
    this.welcome = null; // nothing but HELLO may be sent until the next WELCOME
    if (this.status === 'kicked' || this.cancelled) return;
    if (this.status === 'queued') { this.queue = null; this._setStatus(this.everOnline ? 'reconnecting' : 'connecting'); }
    if (wasOnline) this._emit('disconnect', {});
    this._scheduleReconnect();
  }

  _scheduleReconnect(minDelay = 0) {
    this.attempt++;
    // 1 s, 2 s, 4 s … 15 s (with jitter): an offline player picks the server up within seconds once it is back
    const base = Math.min(15000, 1000 * 2 ** Math.min(this.attempt - 1, 4));
    if (this.protoMismatch) minDelay = Math.max(minDelay, Math.min(300000, 60000 * 2 ** (this.protoMismatch - 1)));
    if (this.serverFull) minDelay = Math.max(minDelay, 45000 + Math.random() * 30000); // queue full too: try again later
    const delay = Math.max(minDelay, base * (0.7 + Math.random() * 0.6));
    clearTimeout(this._welcomeTimer);
    if (this.everOnline && !this.protoMismatch) {
      this._setStatus('reconnecting');
      if (!this.offlineSince) this.offlineSince = performance.now();
    } else this._goOffline(); // never reached the server yet: play offline right away (no 4 s wait)
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.connect(), delay);
  }

  /** Manual reconnect (e.g. "play here" after a duplicate-tab kick). */
  retry() {
    if (this.ws) return;
    this.kickCode = 0;
    if (this.status === 'kicked') this.status = 'offline';
    this.attempt = 0;
    clearTimeout(this._timer);
    this.connect();
  }

  close() {
    clearTimeout(this._timer);
    clearTimeout(this._welcomeTimer);
    this.status = 'kicked';
    try { this.ws?.close(); } catch { /* closed */ }
    this.ws = null;
  }

  get online() { return this.status === 'online'; }

  send(buf) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || !this.welcome) return false;
    ws.send(buf);
    this.bytesOut += buf.byteLength;
    return true;
  }

  /** STATE upload; skipped when the socket is backed up (a newer state supersedes it anyway). */
  sendState(s) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || !this.welcome || ws.bufferedAmount > 32 << 10) return false;
    if (s.ext) {
      writeState(this.stateExtDV, s);
      ws.send(this.stateExtBuf);
      this.bytesOut += STATE_EXT_SIZE;
      return true;
    }
    writeState(this.stateDV, s);
    ws.send(this.stateBuf);
    this.bytesOut += STATE_SIZE;
    return true;
  }

  // ---------------- receive ----------------
  _onMessage(ab, now = performance.now()) {
    if (!(ab instanceof ArrayBuffer) || ab.byteLength < 1) return;
    this.bytesIn += ab.byteLength;
    const dv = new DataView(ab);
    const type = dv.getUint8(0);
    try {
      switch (type) {
        case S_CELL: this._cell(dv, now); break;
        case S_TICK: if (this.welcome) { this.lastTick = dv.getUint32(4, true); this.store.arrival(this.lastTick, now, this.clock.synced ? this.clock.offset : undefined); } break;
        case S_PULSE: {
          const p = readPulse(dv);
          const g = this.global || (this.global = { top: [], online: 0, total: 0 });
          g.online = p.online; g.total = p.total; g.boardVer = p.boardVer; g.at = now;
          if (this.welcome && p.tick > this.lastTick) { this.lastTick = p.tick; this.store.arrival(p.tick, now, this.clock.synced ? this.clock.offset : undefined); }
          this._emit('global', g);
          break;
        }
        case S_WELCOME: this._welcome(dv, now); break;
        case S_QUEUE: this._queue(dv, now); break;
        case S_ADMIT: this.queue = null; this._setStatus('connecting'); this._emit('admit', {}); break;
        case S_GLOBAL: { // the top-10 board (on request); keep the pulse's live counters
          const g = this.global || (this.global = {});
          const online = g.online, ver = g.boardVer;
          decodeGlobal(dv, g);
          if (online !== undefined) g.online = Math.max(online, 0) || g.online;
          g.boardVer = ver; g.boardAt = now; g.at = now;
          this.boardVer = ver;
          this._emit('global', g);
          this._emit('board', g);
          break;
        }
        case S_RADAR: this._radar(dv, now); break;
        case S_DENSITY: this._density(dv); break;
        case S_INFO: this._infoMsg(dv); break;
        case S_PONG: {
          const was = this.clock.synced;
          this.clock.sample(dv.getFloat64(4, true), dv.getFloat64(12, true), now);
          if (!was && this.clock.synced) this.store.resetLatency(); // lateness measured before the sync is meaningless
          this._emit('pong', this.clock.rtt);
          break;
        }
        case S_WALLET: this._emit('wallet', decodeWallet(dv)); break;
        case S_ECON: this._emit('econ', decodeEconReply(dv)); break;
        case S_OWNED: this._emit('owned', decodeOwned(dv)); break;
        case S_PROGRESS: { const p = decodeProgress(dv); if (p) this._emit('progress', p); break; }
        case S_RANK: this._emit('rank', { rank: dv.getUint32(4, true), total: dv.getUint32(8, true) }); break;
        case S_SPAWN_ACK: this._emit('spawnAck', { code: dv.getUint8(1), reqId: dv.getUint16(2, true), model: dv.getUint8(4), waitS: dv.getUint16(6, true) / 10 }); break;
        case S_CORRECTION: this._emit('correction', { reason: dv.getUint8(1), corr: dv.getUint8(2), x: dv.getInt32(4, true) / 100, y: dv.getInt32(8, true) / 100, z: dv.getInt32(12, true) / 100, yaw: (dv.getUint16(16, true) / 65536) * Math.PI * 2 }); break;
        case S_NICK: this._emit('nick', decodeNick(dv)); break;
        case S_EVENT: this._emit('event', readServerEvent(dv)); break;
        case S_FX: {
          const kind = dv.getUint8(1) & 0x0f;
          if (kind === FX.HIT) this._emit('hit', readHit(dv));
          else { const f = readFx(dv); f.at = now; this._emit(kind === FX.SHOT ? 'shot' : 'boom', f); }
          break;
        }
        case S_DAMAGE: this._emit('damage', readDamage(dv)); break;
        case S_GARAGE: {
          const g = decodeGarage(dv);
          if (!g) break;
          if (Array.isArray(g.wardrobe)) { this.wardrobe = g.wardrobe; this.wardrobeSlots = Array.isArray(g.wardrobeSlots) ? g.wardrobeSlots : []; }
          this._emit('garage', g);
          break;
        }
        case S_LIST: this._emit('list', decodeListPage(dv)); break;
        case S_NOTICE: this._emit('notice', { code: dv.getUint8(1), param: dv.getFloat64(4, true) }); break;
        case S_KICK: this._kick(dv.getUint8(1)); break;
        default: break;
      }
    } catch (e) {
      console.warn('[net] bad message', type, e);
    }
  }

  _welcome(dv, now) {
    const w = decodeWelcome(dv);
    clearTimeout(this._welcomeTimer);
    if (w.token) { this.token = w.token; saveToken(w.token); }
    this.welcome = w;
    w.offlineS = this.offlineSince ? (performance.now() - this.offlineSince) / 1000 : 0;
    w.afterOffline = this.playedOffline && !this.everOnline;
    this.offlineSince = 0;
    this.models = [null, ...w.models];
    this.modelIndex = new Map(w.models.map((m, i) => [m.id, i + 1]));
    for (let i = 1; i < this.models.length; i++) this.store.vclassOf[i] = this.models[i].vclass;
    this.store.tickDt = 1000 / w.tickHz;
    this.store.setTiming(w.tick, w.serverTime);
    this.lastTick = w.tick;
    this.store.selfId = w.netId;
    this.store.clear();
    this.tracks.clear();
    this.radarInfoQueue.clear(); this.radarNames.clear();
    this.clock.reset();
    this.attempt = 0;
    this.pings = 0;
    this.pingT = 0;
    const first = !this.everOnline;
    this.everOnline = true;
    this.protoMismatch = 0;
    this.serverFull = 0;
    this.queue = null;
    // answer right away, from the message handler (works in a background tab): an admitted client keeps its place
    try { this.ws?.send(encodePing(++this.pingId, performance.now())); this.pings++; this.pingT = performance.now(); } catch { /* closing */ }
    this._setStatus('online');
    this._emit('welcome', { ...w, first });
  }

  // the server is full: we hold a place in line (only this socket; nothing is sent while waiting)
  _queue(dv, now) {
    const q = decodeQueue(dv);
    if (!q) return;
    clearTimeout(this._welcomeTimer);
    // waiting after a reconnect mid-game: the game goes on offline meanwhile (like an unreachable server)
    if (this.everOnline && !this.offlineSince) this.offlineSince = now;
    this.queue = { ...q, at: now };
    this._setStatus('queued');
    this._emit('queue', this.queue);
  }

  /** Leave the line (or stop retrying): the socket closes, the place is gone. rejoin() starts over at the back. */
  leaveQueue() {
    this.cancelled = true;
    this.queue = null;
    clearTimeout(this._timer);
    clearTimeout(this._welcomeTimer);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* closed */ }
    if (this.everOnline || this.playedOffline) this._goOffline(); else this._setStatus('idle');
  }

  /** Connect again after leaveQueue() (a new place at the back of the line if the server is still full). */
  rejoin() {
    this.cancelled = false;
    this.attempt = 0;
    this.protoMismatch = 0;
    this.serverFull = 0;
    if (this.status === 'kicked') this.status = 'offline';
    clearTimeout(this._timer);
    if (!this.ws) this.connect();
  }

  _cell(dv, now) {
    if (!this.welcome) return;
    const stream = dv.getUint8(1), cell = dv.getUint16(2, true), tick = unwrapTick(dv.getUint16(4, true), this.lastTick || 0), n = dv.getUint8(6), g = dv.getUint8(7);
    if (tick > this.lastTick) this.lastTick = tick;
    const len = dv.byteLength;
    if (len < CELL_HDR + g * GONE_SIZE) return;
    const st = this.store;
    st.arrival(tick, now, this.clock.synced ? this.clock.offset : undefined);
    // gone first (they lead the message): a record for the same id later in it (or another stream) re-adopts it
    let o = CELL_HDR;
    for (let i = 0; i < g; i++, o += GONE_SIZE) st.gone(dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16), dv.getUint16(o + 3, true), now);
    const x0 = cellX0(cell), z0 = cellZ0(cell);
    for (let i = 0; i < n && o + 19 <= len; i++) {
      const r = readRecord(dv, o, x0, z0, _rec);
      if (o + r.size > len) break;
      o += r.size;
      st.ingest(r, tick, stream, now);
    }
  }

  _radar(dv, now) {
    if (!this.welcome) return;
    const rc = dv.getUint16(2, true), n = Math.min(dv.getUint16(8, true), 256, Math.floor((dv.byteLength - RADAR_HDR) / RADAR_ENTRY)), total = dv.getUint16(10, true);
    const r = this.radar, wx0 = radarWinX0(rc), wz0 = radarWinZ0(rc);
    const ts = this.store.tickTime(dv.getUint32(4, true)), self = this.welcome.netId;
    const tNow = this.clock.synced ? this.clock.now(now) : ts;
    for (let i = 0; i < n; i++) {
      readRadarEntry(dv, RADAR_HDR + i * RADAR_ENTRY, wx0, wz0, _radar);
      r.x[i] = _radar.x; r.z[i] = _radar.z; r.color[i] = _radar.color; r.yaw[i] = _radar.yaw; r.vclass[i] = _radar.vclass;
      if (_radar.id !== self) this.tracks.ingest(_radar, ts, tNow, now);
    }
    r.n = n; r.total = total; r.t = now; r.rc = rc;
    this._emit('radar', r);
  }

  _density(dv) {
    const nx = dv.getUint16(2, true), nz = dv.getUint16(4, true);
    const counts = new Uint16Array(nx * nz);
    for (let i = 0; i < nx * nz; i++) counts[i] = dv.getUint16(6 + i * 2, true);
    this.density = { nx, nz, counts };
    this._emit('density', this.density);
  }

  _infoMsg(dv) {
    const n = dv.getUint8(1);
    let o = 2;
    for (let i = 0; i < n; i++) {
      o = readInfo(dv, o, _info);
      const e = this.store.info(_info);
      this.radarInfoQueue.delete(_info.netId);
      if (this.radarNames.size >= 1024 && !this.radarNames.has(_info.netId)) this.radarNames.delete(this.radarNames.keys().next().value);
      this.radarNames.set(_info.netId, { name: this.displayName(_info), at: performance.now() });
      if (e) this._emit('info', e);
    }
  }

  /** Ask for the top-10 board + our rank (scoreboard / pause menu open; the server answers ≤ 1/s). */
  requestBoard() { this.send(encodeList(LIST.WORTH, 0, 0)); }
  /** Ask for the player heatmap (full map open). */
  requestDensity() { this.send(encodeList(LIST.DENSITY, 0, 0)); }

  /** Name to show for a remote entity / top entry / event ({ nickCode, name }): custom name or the generated one. */
  displayName(e) { return e?.name || (e ? nickName(e.nickCode) : ''); }

  /** Our own name after a paid change (S_NICK OK). */
  setMyName(nickCode, name) {
    for (const w of [this.welcome, this.lastWelcome]) if (w) { w.nickCode = nickCode; w.name = name || ''; }
    this._emit('me', { nickCode, name });
  }

  /** Wardrobe item ids of an outfit (INFO outfit codes). */
  outfitIds(codes) { const out = []; for (const c of codes || []) { const it = itemOfCode(c); if (it) out.push(it.id); } return out; }

  /**
   * A remote player's outfit in D's canonical shape { slot: { id, color } } (decodeOutfit of the INFO codes; cached
   * per INFO update), or null without one: what createRemoteAvatars' add/set take.
   */
  outfitOf(e) {
    if (!e?.outfit?.length) return null;
    if (!e.look) e.look = lookOfCodes(e.outfit);
    return e.look;
  }

  _kick(code) {
    this.kickCode = code;
    this._emit('kick', code);
    if (code === KICK.SHUTDOWN) { try { this.ws?.close(); } catch { /* closing */ } this.ws = null; this._scheduleReconnect(2000 + Math.random() * 3000); return; }
    if (code === KICK.PROTOCOL) {
      // client and server versions differ (a deploy in progress, or this page is old): play offline, retry rarely
      // (1, 2, 4, 5 min) so a server updated after us is picked up by itself; the UI offers a reload. Never a loop.
      this.protoMismatch = (this.protoMismatch || 0) + 1;
      this._goOffline();
      try { this.ws?.close(); } catch { /* closing */ }
      return;
    }
    if (code === KICK.FULL) { this.serverFull = (this.serverFull || 0) + 1; return; } // the close follows: retry later
    if (code === KICK.DUPLICATE || code === KICK.BANNED) {
      this._setStatus('kicked');
      clearTimeout(this._timer);
      try { this.ws?.close(); } catch { /* closing */ }
    }
  }

  // ---------------- per frame ----------------
  update(dt, now = performance.now()) {
    this.clock.update(dt);
    if (this.status !== 'online') return;
    // ping: quickly at first (clock sync), then every 6 s (clock drift is tiny; RTT for the HUD)
    if (now - this.pingT > (this.pings < 6 ? 250 : 6000)) {
      this.pingT = now;
      this.pings++;
      this.send(encodePing(++this.pingId, now));
    }
    // batched INFO requests (≤ 32 ids, ≤ 5 per second)
    if ((this.infoQueue.size || this.radarInfoQueue.size) && now - this.infoT > 200) {
      this.infoT = now;
      const ids = [];
      for (const id of this.infoQueue) { ids.push(id); this.infoQueue.delete(id); if (ids.length >= 32) break; }
      let far = 0;
      for (const id of this.radarInfoQueue) {
        if (ids.length >= 32 || far >= 8) break;
        this.radarInfoQueue.delete(id);
        if (!ids.includes(id)) { ids.push(id); far++; }
      }
      this.send(encodeInfoReq(ids));
    }
    if (now - this.statsT > 1000) {
      const span = Math.max(0.001, (now - this.statsT) / 1000);
      this.kbps = ((this.bytesIn - this._bytesAt) * 8) / 1000 / span;
      this._bytesAt = this.bytesIn;
      this.statsT = now;
    }
  }
}

export { KICK };
