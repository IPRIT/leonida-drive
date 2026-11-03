// Hub: the 20 Hz simulation/broadcast step. Reads validated player state from shared memory, maintains the uniform
// interest grid and encodes every cell's stream ONCE per tick into the shared arena; gateways publish those buffers
// to per-cell pub/sub topics and the transport fans them out in C++.
//
// Streams are error-driven: for each cell and stream (near 20 Hz, far 10 Hz) the hub mirrors exactly what every
// subscriber has (the last record sent + linear dead reckoning) and only sends entities whose predicted error exceeds a
// threshold, prioritised by error, with a hard per-cell budget. Bandwidth therefore follows how unpredictable players
// move, not how many there are, and is capped per cell even in crowds.
import {
  CELL, GRID_NX, GRID_NZ, GRID_CELLS, RADAR_NX, RADAR_NZ, RADAR_CELLS, RADAR_MAX, REC_SIZE, SLOT_BITS, STREAM_NEAR, STREAM_FAR,
  F_TPC, F_INFO, F_INFO_SHIFT, SE_JOIN, SE_LEAVE, AGE_UNIT, F_EXT, VCLASS, FX, DMG, SLOT_MASK,
  REC_FULL, REC_ROT, REC_STEER, REC_ALL,
} from '../../src/net/shared/constants.js';
import {
  cellOf, cellX0, cellZ0, wrapAngle, writeRecord, writeCellHeader, writeGone, CELL_HDR, GONE_SIZE, GONE_LEFT,
  writeRadarHeader, writeRadarEntry, RADAR_HDR, RADAR_ENTRY, radarWinX0, radarWinZ0, encodeGlobal, writeServerEvent, SEVENT_SIZE,
  encodeDensity, recSize, writeFx, FX_SIZE, writeDamage, DAMAGE_SIZE, writeHit, HIT_SIZE, writePulse, PULSE_SIZE,
} from '../../src/net/shared/protocol.js';
import {
  WEAPONS, boxOf, DAMAGE, splashDamage, CRUSH, aimDir, shellPos, segmentBox, pointBoxDistance, crushes, isTankModel,
} from '../../src/net/shared/combat.js';
import { worldClock } from '../../src/net/shared/worldclock.js';
import { drArc } from '../../src/net/shared/dr.js';
import {
  ARENA_BUFFERS, ARENA_MAX_ENTRIES, ARENA_HDR, KIND_NEAR, KIND_FAR, KIND_RADAR, KIND_GLOBAL, KIND_PLAYER, slotName,
  H_TICK, H_TICK_MS, H_TICK_MS_MAX, H_ONLINE, H_VISIBLE, H_ARENA_BYTES, H_TOTAL_PLAYERS, H_TICK_P99, H_ENC_RECORDS, H_DROPPED_TICKS, H_EGRESS, H_BUDGET,
  H_BOARD_VER,
} from './shared-mem.js';

// Send-on-deviation thresholds per stream: an entity is sent when what every subscriber renders (the last record,
// dead-reckoned along its yaw-rate arc) is off by more than these — position (m), yaw (rad), velocity (m/s), yaw rate,
// pitch/roll (rad), steer, turret/barrel — or as a keyframe after maxAge s (moving) / parkedAge s (standing still).
export const THRESHOLDS = [
  { pos: 0.1, yaw: 0.02, vel: 0.45, yawRate: 0.15, rot: 0.07, steer: 0.12, turret: 0.03, barrel: 0.02, maxAge: 2.0, parkedAge: 20.0, freshAge: 0.2 }, // near
  { pos: 1.0, yaw: 0.12, vel: 3.0, yawRate: 0.6, rot: 0.3, steer: 1e9, turret: 0.15, barrel: 0.1, maxAge: 4.0, parkedAge: 30.0, freshAge: 0.4 }, // far
];
// Streams are only encoded on even ticks (10 Hz): every message of a tick leaves in one TCP write per client, and
// a quiet tick costs nothing — a packet's TCP/IP + TLS overhead (≈ 74 B) dominates small payloads.
export const SEND_EVERY = 2;
const CS = 16; // cur stride: x y z vx vy vz yaw pitch roll yawRate steer time model flags turret barrel
const LS = 17; // last-sent stride: x y z yaw vx vy vz yawRate pitch roll steer time tick flags model turret barrel
const L_T = 11, L_TICK = 12, L_FLAGS = 13, L_MODEL = 14, L_TUR = 15, L_BAR = 16;
const SHELL_STEP_MS = 20;
const MAX_SHELLS = 4096;
const RADAR_PERIOD = 40; // ticks (2 s at 20 Hz); radar cells are staggered across the even ticks of the period
const GLOBAL_PERIOD = 40; // board snapshot (served on request)
const PULSE_PERIOD = 200; // 10 s: online count + board version + tick on the global topic. There is no separate
// heartbeat: moving entities get a keyframe at least every maxAge s, which is all the liveness a client needs.
const RADAR_STILL_EVERY = 4; // standing players are repeated in every 4th radar summary (8 s); moving ones in all
const DENSITY_PERIOD = 120; // heatmap snapshot (served on request)
const FRESH_TICKS = 40; // after a new viewer subscribes to a cell, its records carry every part for 2 s
const PARKED_V = 0.3, PARKED_YR = 0.05;
const RADAR_STILL_V2 = 0.5 * 0.5; // (m/s)²: below this a player counts as standing for the radar
// a near-stream error this many times its threshold (a crash, a sudden stop or swerve) is sent on the next tick
// instead of waiting for the next send tick; ordinary driving stays well below (thresholds are judged 100 ms ahead)
const URGENT = 4;
// precomputed inverse (squared for distances) thresholds per stream
const makeInv = (hz) => THRESHOLDS.map((t) => ({
  p: 1 / (t.pos * t.pos), v: 1 / (t.vel * t.vel), y: 1 / t.yaw, yr: 1 / t.yawRate, r: 1 / t.rot, s: 1 / t.steer,
  age: 1 / (hz * t.maxAge), ageParked: 1 / (hz * t.parkedAge), ageFresh: 1 / (hz * t.freshAge), tu: 1 / t.turret, ba: 1 / t.barrel,
  keyTicks: hz * t.maxAge * 0.95, rotHalf: t.rot * 0.5, steerHalf: t.steer * 0.5,
}));
// clients upload on deviation too (≥ 4 Hz heartbeat): a sample older than this means a stalled sender — hold it,
// dead-reckoned this far, with zero velocity
const STALE_MS = 450;
const MAX_AGE_MS = 255 * AGE_UNIT; // the record's age byte covers 0..510 ms
const HYST = 3; // m: an entity changes cell only after moving this far past the border (no flapping)

export class Hub {
  constructor(v, cfg, opts = {}) {
    this.v = v;
    this.cfg = cfg;
    this.hz = cfg.tickHz;
    // deviations are judged one send interval ahead: the next chance to correct is SEND_EVERY ticks away
    this.lookAhead = (SEND_EVERY * 1000) / cfg.tickHz;
    this.log = opts.log || console;
    const N = v.N;
    this.N = N;
    // current snapshot per slot, interleaved (one 128-byte block per entity: the hot loop touches 2 blocks, not 20
    // scattered arrays). Time = the sample's own time: position and velocity agree.
    this.cur = new Float64Array(N * CS);
    this.hasSnap = new Uint8Array(N);
    // sessions & grid
    this.sess = new Int16Array(N).fill(-1); // generation the hub is tracking for the slot, -1 = none
    this.seen = new Uint8Array(N); // the session has been visible at least once (join event sent)
    this.visible = new Uint8Array(N);
    this.cellOf = new Int32Array(N).fill(-1);
    this.next = new Int32Array(N).fill(-1);
    this.prev = new Int32Array(N).fill(-1);
    this.head = new Int32Array(GRID_CELLS).fill(-1);
    this.count = new Int32Array(GRID_CELLS);
    // last record sent per stream (exactly what subscribers decoded), interleaved like `cur`
    this.ls = [new Float64Array(N * LS), new Float64Array(N * LS)];
    for (const l of this.ls) for (let s = 0; s < N; s++) l[s * LS + L_TICK] = -1;
    // gone records: near (this tick) and far (accumulated until the next far tick)
    this.gone = [makeGoneList(GRID_CELLS, N), makeGoneList(GRID_CELLS, N)];
    // events this tick
    this.evSlot = new Int32Array(4096); this.evKind = new Uint8Array(4096); this.evCell = new Int32Array(4096); this.evId = new Int32Array(4096);
    this.evN = 0;
    // scratch
    this.cand = new Int32Array(N);
    this.prio = new Float32Array(N);
    this.prioN = new Float32Array(N); // priorities computed in the sequential slot scan (cache-friendly)
    this.prioF = new Float32Array(N);
    this.deq = new Float64Array(8);
    this.parts = new Uint8Array(256);
    this.rs = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, roll: 0, yawRate: 0, steer: 0, model: 0, flags: 0, turret: 0, barrel: 0, age: 0 };
    this.fresh = new Uint8Array(GRID_CELLS);
    this.fullUntil = new Int32Array(GRID_CELLS).fill(-1); // records carry every part until this tick (new viewer)
    this.radarSubs = new Int32Array(RADAR_CELLS); // subscriber counts at the last summary (growth = a new viewer)
    this.urgent = new Int32Array(GRID_CELLS).fill(-1); // tick at which a cell got an urgent (between send ticks) record
    this.radarCand = new Int32Array(v.gen.length);
    this.boardVer = 0; this.boardSig = '';
    this.pulseScratch = new DataView(new ArrayBuffer(PULSE_SIZE));
    this.board = { top: [], total: 0 };
    this.tickTimes = new Float64Array(600);
    this.tickTimesN = 0;
    this.densityCounts = new Uint32Array(RADAR_CELLS);
    this.globalScratch = new DataView(new ArrayBuffer(4096));
    this.tick = 0;
    this.encRecords = 0;
    this.inv = makeInv(this.hz);
    // egress controller: the hub knows every topic's subscriber count, so it knows the exact fan-out bytes of each
    // tick. Above the target (EGRESS_MBPS), per-cell budgets shrink (fewer records per crowded cell per tick; motion
    // stays smooth through dead reckoning) and recover when there is headroom.
    this.egressTarget = (cfg.egressMbps || 0) * 125000; // bytes/s, 0 = unlimited
    this.egress = 0; // EWMA bytes/s
    this.budgetScale = 1;
    // combat: tanks (by model index), shells in flight (server-resolved hits), crush cooldowns
    this.world = opts.world || null;
    this.isTank = new Uint8Array(256);
    for (const m of opts.vehicles?.models || []) if (m && isTankModel(m)) this.isTank[m.index] = 1;
    this.shotQueue = [];
    this.shells = [];
    this.tanks = new Int32Array(4096);
    this.tankN = 0;
    this.crushT = new Float64Array(N);
    this.combat = { shots: 0, hits: 0, crushes: 0 };
  }

  /** A shot validated by a gateway: { netId, seq, weapon, time, x, y, z, yaw, pitch, clear }. Applied next tick. */
  queueShot(m) { if (this.shotQueue.length < MAX_SHELLS) this.shotQueue.push(m); }

  /** Leaderboard from the DB thread: { top: [{netId, nickCode, color, money}], total }. */
  setBoard(b) { this.board = b; }

  // ---------------- grid ----------------
  _link(s, cell) {
    const h = this.head[cell];
    this.next[s] = h; this.prev[s] = -1;
    if (h >= 0) this.prev[h] = s;
    this.head[cell] = s;
    this.cellOf[s] = cell;
    this.count[cell]++;
  }
  _unlink(s) {
    const cell = this.cellOf[s];
    if (cell < 0) return;
    const n = this.next[s], p = this.prev[s];
    if (p >= 0) this.next[p] = n; else this.head[cell] = n;
    if (n >= 0) this.prev[n] = p;
    this.next[s] = this.prev[s] = -1;
    this.cellOf[s] = -1;
    this.count[cell]--;
  }
  _gone(s, fromCell, toCell) {
    const id = this._id(s);
    pushGone(this.gone[0], fromCell, id, toCell);
    pushGone(this.gone[1], fromCell, id, toCell);
  }
  _id(s) { return (s | (this.v.gen[s] << SLOT_BITS)) & 0xffffff; }
  _resetLs(s) { this.ls[0][s * LS + L_TICK] = -1; this.ls[1][s * LS + L_TICK] = -1; }

  _event(kind, s, cell) {
    if (this.evN >= this.evSlot.length) return;
    const i = this.evN++;
    this.evKind[i] = kind; this.evSlot[i] = s; this.evCell[i] = cell; this.evId[i] = this._id(s);
  }

  // read one slot (seqlock) into the snapshot. Samples keep their own time (no extrapolation: the record carries the
  // sample age), except a stalled sender, which is held dead-reckoned STALE_MS ahead with zero velocity.
  _read(s, tMs) {
    const v = this.v;
    const q1 = Atomics.load(v.seq, s);
    if (q1 & 1) return false;
    const p = s * 3, r = s * 5;
    let x = v.pos[p], y = v.pos[p + 1], z = v.pos[p + 2];
    let vx = v.vel[p], vy = v.vel[p + 1], vz = v.vel[p + 2];
    let yaw = v.rot[r], yr = v.rot[r + 3];
    const pitch = v.rot[r + 1], roll = v.rot[r + 2], steer = v.rot[r + 4];
    let st = v.sampleT[s];
    const model = v.model[s], flags = v.flags[s];
    const tur = v.ext[s * 2], bar = v.ext[s * 2 + 1];
    if (Atomics.load(v.seq, s) !== q1) return false;
    if (tMs - st > STALE_MS) {
      const d = STALE_MS / 1000;
      x += vx * d; y += vy * d; z += vz * d; yaw = wrapAngle(yaw + yr * d);
      vx = vy = vz = yr = 0;
      st = tMs - MAX_AGE_MS; // time is irrelevant for a stopped entity: keep it representable
    } else {
      // move the sample to the record's time grid (tick - k * AGE_UNIT): (position, velocity, time) stay consistent
      // to the sub-millimetre, which keeps the client's Hermite curve free of timestamp noise
      const q = tMs - Math.min(255, Math.max(0, Math.round((tMs - st) / AGE_UNIT))) * AGE_UNIT;
      const d = (q - st) / 1000;
      x += vx * d; y += vy * d; z += vz * d; yaw = wrapAngle(yaw + yr * d);
      st = q;
    }
    const c = this.cur, k = s * CS;
    c[k] = x; c[k + 1] = y; c[k + 2] = z; c[k + 3] = vx; c[k + 4] = vy; c[k + 5] = vz;
    c[k + 6] = yaw; c[k + 7] = pitch; c[k + 8] = roll; c[k + 9] = yr; c[k + 10] = steer; c[k + 11] = st;
    c[k + 12] = model; c[k + 13] = flags; c[k + 14] = tur; c[k + 15] = bar;
    this.hasSnap[s] = 1;
    return true;
  }

  // ---------------- tick ----------------
  /** Run tick T (scheduled server time tMs). Returns the arena buffer index used, or -1 if the tick was dropped. */
  step(T, tMs) {
    const t0 = performance.now();
    const v = this.v;
    const b = T % ARENA_BUFFERS;
    if (Atomics.load(v.arenaHdr, b * ARENA_HDR + 3) > 0) { // a gateway is still publishing from this buffer
      v.hub[H_DROPPED_TICKS]++;
      return -1;
    }
    this.tick = T;
    this.tMs = tMs;
    this.encRecords = 0;
    const w = this._arena = { b, base: b * v.arenaBytes, off: 0, entries: 0, idx: b * ARENA_MAX_ENTRIES * 3, limit: v.arenaBytes };
    let online = 0, visibleN = 0;

    const subNear = v.subNear, subFar = v.subFar, subDirty = v.subDirty;
    const send = T % SEND_EVERY === 0;
    // cells that just got a subscriber are refreshed quickly (and with every record part for a while)
    if (send) {
      for (let c = 0; c < GRID_CELLS; c++) {
        if (subDirty[c] && Atomics.exchange(subDirty, c, 0)) { this.fresh[c] = 1; this.fullUntil[c] = T + FRESH_TICKS; } else this.fresh[c] = 0;
      }
    }
    // far cells: every 4th tick, in two halves on alternating send ticks (the work is even, no extra packets)
    const farPhase = (T >> 1) & 1;
    // under egress pressure crowded cells are published less often (fewer, fuller messages): every 2, 4 or 8 ticks
    const P = this.budgetScale < 0.35 ? 4 : this.budgetScale < 0.7 ? 2 : 1, nearPhase = (T >> 1) % P;
    const prioN = this.prioN, prioF = this.prioF;

    // 1) sessions, snapshots, grid, and every entity's send priority (sequential over slots: prefetch-friendly)
    const N = this.N, alive = v.alive, gen = v.gen;
    this.tankN = 0;
    for (let s = 0; s < N; s++) {
      const a = alive[s];
      const tracked = this.sess[s];
      if (tracked >= 0 && (a === 0 || gen[s] !== tracked)) { // session ended or slot reused
        const cell = this.cellOf[s];
        if (this.visible[s]) { this._gone(s, cell, GONE_LEFT); this._unlink(s); this.visible[s] = 0; }
        if (this.seen[s]) this._event(SE_LEAVE, s, cell >= 0 ? cell : this._lastCell(s));
        this.sess[s] = -1; this.seen[s] = 0; this.hasSnap[s] = 0;
      }
      if (a === 0) continue;
      online++;
      if (this.sess[s] < 0) { this.sess[s] = gen[s]; this.seen[s] = 0; this.hasSnap[s] = 0; }
      if (a !== 1) { // connected but hidden (joining or away)
        if (this.visible[s]) { this._gone(s, this.cellOf[s], GONE_LEFT); this._unlink(s); this.visible[s] = 0; }
        continue;
      }
      if (!this._read(s, tMs) && !this.hasSnap[s]) continue;
      const px = this.cur[s * CS], pz = this.cur[s * CS + 2];
      let cell = cellOf(px, pz);
      if (this.visible[s] && cell !== this.cellOf[s] && insideWithMargin(this.cellOf[s], px, pz, HYST)) cell = this.cellOf[s];
      if (!this.visible[s]) {
        this._link(s, cell);
        this.visible[s] = 1;
        this._resetLs(s);
        if (!this.seen[s]) { this.seen[s] = 1; this._event(SE_JOIN, s, cell); }
      } else if (cell !== this.cellOf[s]) {
        this._gone(s, this.cellOf[s], cell);
        this._unlink(s);
        this._link(s, cell);
        this._resetLs(s);
      }
      visibleN++;
      if (this.isTank[this.cur[s * CS + 12]] && this.tankN < this.tanks.length) this.tanks[this.tankN++] = s;
      // near priorities every tick: between send ticks only urgent motion (a crash, a sudden stop) goes out at once
      const pn = prioN[s] = subNear[cell] > 0 && cell % P === nearPhase ? this._prio(s, 0, cell) : 0;
      if (!send && pn >= URGENT && pn < 1e5) this.urgent[cell] = T;
      prioF[s] = send && subFar[cell] > 0 && (T & 2) === 0 && (cell & 1) === farPhase ? this._prio(s, 1, cell) : 0;
    }

    // 1b) combat: new shots, shells in flight, tanks crushing cars
    if (this.shotQueue.length) this._shots(tMs);
    if (this.shells.length) this._shells(tMs);
    if (this.tankN) this._crush(tMs);

    // 2) streams (send ticks only; departures accumulate in between)
    if (send) {
      const nearBudget = Math.min(255, Math.max(2, Math.round(this.cfg.nearBudget * SEND_EVERY * 0.75 * this.budgetScale * P)));
      const farBudget = Math.max(1, Math.round(this.cfg.farBudget * this.budgetScale));
      const gN = this.gone[0];
      for (let c = 0; c < GRID_CELLS; c++) {
        if (subNear[c] <= 0) continue;
        const full = c % P === nearPhase;
        if (gN.head[c] < 0 && (!full || this.head[c] < 0)) continue;
        this._encodeCell(c, STREAM_NEAR, full ? nearBudget : 0);
      }
      // far stream: each cell re-evaluated every 4th tick (5 Hz); departures announced on every send tick
      const gF = this.gone[1], farTick = (T & 2) === 0;
      for (let c = 0; c < GRID_CELLS; c++) {
        if (subFar[c] <= 0) continue;
        const full = farTick && (c & 1) === farPhase;
        if (gF.head[c] < 0 && (!full || this.head[c] < 0)) continue;
        this._encodeCell(c, STREAM_FAR, full ? farBudget : 0);
      }
      clearGone(gF);
      clearGone(gN);
    } else {
      const urgent = this.urgent;
      const nearBudget = Math.min(255, Math.max(2, Math.round(this.cfg.nearBudget * 0.75 * this.budgetScale * P)));
      for (let c = 0; c < GRID_CELLS; c++) if (urgent[c] === T && subNear[c] > 0) this._encodeCell(c, STREAM_NEAR, nearBudget, URGENT);
    }

    // 3) join/leave events → the near topic of the cell (send ticks)
    for (let i = 0; send && i < this.evN; i++) {
      const cell = this.evCell[i];
      if (cell < 0 || subNear[cell] <= 0) continue;
      const o = this._alloc(SEVENT_SIZE);
      if (o < 0) break;
      const s = this.evSlot[i];
      writeServerEvent(v.arenaDV, o, this.evKind[i], this.evId[i], v.nick[s], v.color[s], slotName(v, s));
      this._entry(KIND_NEAR, cell, o, SEVENT_SIZE);
    }
    if (send) this.evN = 0;

    // 4) radar (every 2 s per radar cell), board/density snapshots (served on request), pulse
    if (send) this._radar(T);
    if (T % DENSITY_PERIOD === 8) this._density();
    if (T % GLOBAL_PERIOD === 0) this._global(T, tMs, online);
    if (T % PULSE_PERIOD === 0) this._pulse(T, online);

    // 5) fan-out estimate (exact: bytes x subscribers) and the egress controller
    let fan = 0;
    for (let i = 0, idx = v.arenaIdx, base = w.idx; i < w.entries; i++) {
      const k = idx[base + i * 3], len = idx[base + i * 3 + 2] + (idx[base + i * 3 + 2] < 126 ? 2 : 4);
      const kind = k >>> 24, id = k & 0xffffff;
      fan += len * (kind === KIND_NEAR ? subNear[id] : kind === KIND_FAR ? subFar[id] : kind === KIND_RADAR ? v.subRadar[id] : kind === KIND_PLAYER ? 1 : online);
    }
    this.egress = this.egress * 0.9 + fan * this.hz * 0.1;
    if (this.egressTarget > 0) {
      if (this.egress > this.egressTarget) this.budgetScale = Math.max(0.15, this.budgetScale * 0.97);
      else if (this.egress < this.egressTarget * 0.8) this.budgetScale = Math.min(1, this.budgetScale * 1.01);
    }
    v.hub[H_EGRESS] = this.egress;
    v.hub[H_BUDGET] = this.budgetScale;

    // 6) publish the arena
    const h = b * ARENA_HDR;
    v.arenaHdr[h + 1] = w.entries;
    v.arenaHdr[h + 2] = w.off;
    Atomics.store(v.arenaHdr, h, T);

    const ms = performance.now() - t0;
    this.tickTimes[this.tickTimesN++ % this.tickTimes.length] = ms;
    v.hub[H_TICK] = T;
    v.hub[H_TICK_MS] = v.hub[H_TICK_MS] * 0.95 + ms * 0.05;
    if (ms > v.hub[H_TICK_MS_MAX]) v.hub[H_TICK_MS_MAX] = ms;
    v.hub[H_ONLINE] = online;
    v.hub[H_VISIBLE] = visibleN;
    v.hub[H_ARENA_BYTES] = w.off;
    v.hub[H_ENC_RECORDS] = this.encRecords;
    if ((T & 63) === 0) v.hub[H_TICK_P99] = percentile(this.tickTimes, Math.min(this.tickTimesN, this.tickTimes.length), 0.99);
    return b;
  }

  _lastCell(s) { return cellOf(this.cur[s * CS], this.cur[s * CS + 2]); }

  // ---------------- arena ----------------
  _alloc(len) {
    const w = this._arena;
    if (w.off + len > w.limit || w.entries >= ARENA_MAX_ENTRIES) return -1;
    const o = w.base + w.off;
    w.off += len;
    return o;
  }
  _entry(kind, id, absOff, len) {
    const w = this._arena, idx = this.v.arenaIdx, i = w.idx + w.entries * 3;
    idx[i] = (kind << 24) | id; idx[i + 1] = absOff; idx[i + 2] = len;
    w.entries++;
  }

  // ---------------- streams ----------------
  // send priority of slot s on a stream: 0 = nothing to send, ≥ 1 = error over threshold (bigger = more urgent)
  _prio(s, stream, cell) {
    const ls = this.ls[stream], cur = this.cur, k = s * LS, j = s * CS;
    const lt = ls[k + L_TICK];
    if (lt < 0) return 1e6; // new in this cell's stream
    if (cur[j + 13] !== ls[k + L_FLAGS] || cur[j + 12] !== ls[k + L_MODEL]) return 1e5; // discrete state change
    const t = this.inv[stream];
    // what every subscriber renders: the last record + dead reckoning along the yaw-rate arc, compared with the latest
    // sample dead-reckoned the same way. Both are taken at the tick time, not the sample's: clients upload on deviation,
    // so a cruising car's sample can be 250 ms old, and a velocity error grows with time.
    const tEval = (this.tMs > cur[j + 11] ? this.tMs : cur[j + 11]) + this.lookAhead;
    const d = drArc(_dr, ls[k], ls[k + 1], ls[k + 2], ls[k + 4], ls[k + 5], ls[k + 6], ls[k + 3], ls[k + 7], (tEval - ls[k + L_T]) / 1000);
    let cx = cur[j], cy = cur[j + 1], cz = cur[j + 2], cvx = cur[j + 3], cvy = cur[j + 4], cvz = cur[j + 5], cyaw = cur[j + 6];
    if (tEval - cur[j + 11] > 20) {
      const c = drArc(_dc, cx, cy, cz, cvx, cvy, cvz, cyaw, cur[j + 9], (tEval - cur[j + 11]) / 1000);
      cx = c.x; cy = c.y; cz = c.z; cvx = c.vx; cvy = c.vy; cvz = c.vz; cyaw = c.yaw;
    }
    const ex = d.x - cx, ey = d.y - cy, ez = d.z - cz;
    let q = (ex * ex + ey * ey + ez * ez) * t.p;
    const dvx = d.vx - cvx, dvy = d.vy - cvy, dvz = d.vz - cvz;
    const qv = (dvx * dvx + dvy * dvy + dvz * dvz) * t.v;
    if (qv > q) q = qv;
    let e = wrapAngle(d.yaw - cyaw) * t.y;
    let ea = e < 0 ? -e : e;
    e = (ls[k + 7] - cur[j + 9]) * t.yr; if (e < 0) e = -e; if (e > ea) ea = e;
    e = (ls[k + 8] - cur[j + 7]) * t.r; if (e < 0) e = -e; if (e > ea) ea = e;
    e = wrapAngle(ls[k + 9] - cur[j + 8]) * t.r; if (e < 0) e = -e; if (e > ea) ea = e;
    e = (ls[k + 10] - cur[j + 10]) * t.s; if (e < 0) e = -e; if (e > ea) ea = e;
    if (cur[j + 13] & F_EXT) {
      e = wrapAngle(ls[k + L_TUR] - cur[j + 14]) * t.tu; if (e < 0) e = -e; if (e > ea) ea = e;
      e = (ls[k + L_BAR] - cur[j + 15]) * t.ba; if (e < 0) e = -e; if (e > ea) ea = e;
    }
    const parked = cur[j + 3] * cur[j + 3] + cur[j + 5] * cur[j + 5] < PARKED_V * PARKED_V && (cur[j + 9] < PARKED_YR && cur[j + 9] > -PARKED_YR);
    e = (this.tick - lt) * (this.fresh[cell] ? t.ageFresh : parked ? t.ageParked : t.age); if (e > ea) ea = e;
    if (q < 1 && ea < 1) return 0;
    q = Math.sqrt(q);
    return ea > q ? ea : q;
  }

  // minPrio > 1: an urgent message between send ticks (motion errors only, no departures)
  _encodeCell(c, stream, budget, minPrio = 1) {
    const T = this.tick, ls = this.ls[stream], cur = this.cur;
    const pr = stream === STREAM_NEAR ? this.prioN : this.prioF;
    const cand = this.cand, prio = this.prio, urgentOnly = minPrio > 1;
    let n = 0;
    if (budget > 0) {
      for (let s = this.head[c]; s >= 0; s = this.next[s]) {
        const p = pr[s];
        if (p >= minPrio && (!urgentOnly || p < 1e5)) { cand[n] = s; prio[n] = p; n++; }
      }
    }
    const gl = this.gone[stream];
    let goneN = 0;
    if (!urgentOnly) for (let g = gl.head[c]; g >= 0; g = gl.next[g]) goneN++;
    if (n === 0 && goneN === 0) return;
    if (n > budget) { selectTop(cand, prio, n, budget); n = budget; }
    const v = this.v, dv = v.arenaDV;
    // which parts each record carries: motion always; model/flags, pitch/roll, steer only when changed since the last
    // record of this stream (the receiver keeps the rest), everything for new viewers, new arrivals and keyframes
    const parts = this.parts, inv = this.inv[stream], allCell = this.fullUntil[c] >= T;
    let recBytes = 0;
    for (let i = 0; i < n; i++) {
      const s = cand[i], j = s * CS, k = s * LS, lt = ls[k + L_TICK];
      let p = 0;
      if (allCell || lt < 0 || T - lt >= inv.keyTicks) p = REC_ALL;
      else {
        if (cur[j + 13] !== ls[k + L_FLAGS] || cur[j + 12] !== ls[k + L_MODEL]) p |= REC_FULL;
        let d = cur[j + 7] - ls[k + 8]; if (d > inv.rotHalf || d < -inv.rotHalf) p |= REC_ROT;
        d = wrapAngle(cur[j + 8] - ls[k + 9]); if (d > inv.rotHalf || d < -inv.rotHalf) p |= REC_ROT;
        if (stream === STREAM_NEAR) { d = cur[j + 10] - ls[k + 10]; if (d > inv.steerHalf || d < -inv.steerHalf) p |= REC_STEER; }
      }
      parts[i] = p;
      recBytes += recSize(p, cur[j + 13]);
    }
    // gone records may need several messages (u8 count); entities fit in one (budget <= 255). Layout: header, gones, records
    let gi = urgentOnly ? -1 : gl.head[c];
    let first = true;
    const r = this.rs;
    while (first || gi >= 0) {
      const recs = first ? n : 0;
      let gcount = 0;
      for (let g = gi; g >= 0 && gcount < 255; g = gl.next[g]) gcount++;
      const len = CELL_HDR + gcount * GONE_SIZE + (first ? recBytes : 0);
      const o0 = this._alloc(len);
      if (o0 < 0) return;
      let o = writeCellHeader(dv, o0, stream, c, T, recs, gcount);
      for (let k = 0; k < gcount; k++) { o = writeGone(dv, o, gl.id[gi], gl.to[gi]); gi = gl.next[gi]; }
      if (recs) {
        const x0 = cellX0(c), z0 = cellZ0(c), deq = this.deq, tMs = this.tMs;
        for (let i = 0; i < recs; i++) {
          const s = cand[i], j = s * CS, k = s * LS, p = parts[i];
          r.x = cur[j]; r.y = cur[j + 1]; r.z = cur[j + 2]; r.vx = cur[j + 3]; r.vy = cur[j + 4]; r.vz = cur[j + 5];
          r.yaw = cur[j + 6]; r.pitch = cur[j + 7]; r.roll = cur[j + 8]; r.yawRate = cur[j + 9]; r.steer = cur[j + 10];
          r.model = cur[j + 12]; r.flags = cur[j + 13]; r.turret = cur[j + 14]; r.barrel = cur[j + 15];
          r.age = Math.min(255, Math.max(0, Math.round((tMs - cur[j + 11]) / AGE_UNIT)));
          o = writeRecord(dv, o, this._id(s), x0, z0, r, p, deq);
          ls[k] = deq[0]; ls[k + 1] = deq[1]; ls[k + 2] = deq[2]; ls[k + 3] = deq[3];
          ls[k + 4] = deq[4]; ls[k + 5] = deq[5]; ls[k + 6] = deq[6]; ls[k + 7] = deq[7];
          if (p & REC_ROT) { ls[k + 8] = r.pitch; ls[k + 9] = r.roll; }
          if (p & REC_STEER) ls[k + 10] = r.steer;
          if (p & REC_FULL) { ls[k + L_FLAGS] = r.flags; ls[k + L_MODEL] = r.model; }
          ls[k + L_T] = tMs - r.age * AGE_UNIT; ls[k + L_TICK] = T;
          ls[k + L_TUR] = r.turret; ls[k + L_BAR] = r.barrel;
        }
        this.encRecords += recs;
      }
      this._entry(stream === STREAM_NEAR ? KIND_NEAR : KIND_FAR, c, o0, len);
      first = false;
    }
  }

  // ---------------- combat ----------------
  // Shots arrive validated by the owning gateway (weapon, reload, muzzle position, aim vs turret). The hub broadcasts
  // the shot to everyone around the muzzle (clients fly the same shell locally) and resolves the flight itself:
  // terrain, the shooter's reported free path (static geometry it saw), and oriented boxes around every player along
  // the way, at their current server-known positions. Damage goes to the victims directly (KIND_PLAYER).
  _shots(tMs) {
    const v = this.v;
    for (const m of this.shotQueue) {
      const s = m.netId & SLOT_MASK;
      if (v.alive[s] === 0 || this._id(s) !== m.netId) continue;
      const w = WEAPONS[m.weapon];
      if (!w) continue;
      const d = aimDir(m.yaw, m.pitch, { x: 0, y: 0, z: 0 });
      const t0 = Math.min(tMs, Math.max(tMs - 1000, m.time));
      this.shells.push({
        slot: s, netId: m.netId, seq: m.seq, weapon: m.weapon, w, t0, tSim: t0,
        ox: m.x, oy: m.y, oz: m.z, dx: d.x, dy: d.y, dz: d.z, clear: m.clear > 0 ? Math.min(m.clear + 2, w.range) : w.range,
      });
      this.combat.shots++;
      this._fxAround(FX.SHOT, m.seq, m.netId, t0, m.x, m.y, m.z, m.yaw, m.pitch, m.weapon);
    }
    this.shotQueue.length = 0;
    if (this.shells.length > MAX_SHELLS) this.shells.splice(0, this.shells.length - MAX_SHELLS);
  }

  /** FX to the near + far topics of the cell at (x, z): everyone within ~2 cells sees it (clients dedupe by netId/seq). */
  _fxAround(kind, seq, netId, t, x, y, z, yaw, pitch, weapon) {
    const cell = cellOf(x, z), v = this.v;
    for (const kindT of [KIND_NEAR, KIND_FAR]) {
      if ((kindT === KIND_NEAR ? v.subNear[cell] : v.subFar[cell]) <= 0) continue;
      const o = this._alloc(FX_SIZE);
      if (o < 0) return;
      writeFx(v.arenaDV, o, kind, seq, netId, t, x, y, z, yaw, pitch, weapon);
      this._entry(kindT, cell, o, FX_SIZE);
    }
  }

  _shells(tMs) {
    const v = this.v, cur = this.cur, p = _pa, q = _pb;
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i], w = sh.w;
      const tEnd = Math.min(tMs, sh.t0 + w.maxFlightS * 1000);
      let done = false;
      while (sh.tSim < tEnd && !done) {
        const ta = sh.tSim, tb = Math.min(tEnd, ta + SHELL_STEP_MS);
        shellPos(sh.ox, sh.oy, sh.oz, sh.dx, sh.dy, sh.dz, w.speed, w.gravity, (ta - sh.t0) / 1000, p);
        shellPos(sh.ox, sh.oy, sh.oz, sh.dx, sh.dy, sh.dz, w.speed, w.gravity, (tb - sh.t0) / 1000, q);
        // 1) players along the segment (boxes at their positions at time tb)
        let best = 2, bestSlot = -1;
        const cell = cellOf(q.x, q.z), gx = cell % GRID_NX, gz = (cell / GRID_NX) | 0;
        for (let dz = -1; dz <= 1; dz++) {
          const zz = gz + dz;
          if (zz < 0 || zz >= GRID_NZ) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = gx + dx;
            if (xx < 0 || xx >= GRID_NX) continue;
            for (let o = this.head[zz * GRID_NX + xx]; o >= 0; o = this.next[o]) {
              if (o === sh.slot && tb - sh.t0 < 400) continue; // leaving our own barrel
              const k = o * CS, b = boxOf(v.vclass[o], this.isTank[cur[k + 12]]);
              const e = Math.max(-0.5, Math.min(0.5, (tb - cur[k + 11]) / 1000));
              const hit = segmentBox(p.x, p.y, p.z, q.x, q.y, q.z, cur[k] + cur[k + 3] * e, cur[k + 1] + cur[k + 4] * e + b[3], cur[k + 2] + cur[k + 5] * e, cur[k + 6], b[0], b[1], b[2]);
              if (hit >= 0 && hit < best) { best = hit; bestSlot = o; }
            }
          }
        }
        // 2) static geometry the shooter's client reported (free path length) and terrain
        const travelled = (w.speed * (tb - sh.t0)) / 1000;
        let stop = 2;
        if (travelled >= sh.clear) stop = Math.max(0, Math.min(1, 1 - (travelled - sh.clear) / Math.max(1e-6, w.speed * (tb - ta) / 1000)));
        const ground = this.world ? this.world.heightAt(q.x, q.z) : -1e9;
        if (q.y < ground) {
          const g0 = this.world.heightAt(p.x, p.z);
          const f = p.y - g0 > 0 ? (p.y - g0) / Math.max(1e-6, (p.y - g0) - (q.y - ground)) : 0;
          if (f < stop) stop = f;
        }
        if (bestSlot >= 0 && best <= stop) {
          this._explode(sh, p.x + (q.x - p.x) * best, p.y + (q.y - p.y) * best, p.z + (q.z - p.z) * best, ta + (tb - ta) * best, bestSlot, tMs);
          done = true;
        } else if (stop <= 1) {
          this._explode(sh, p.x + (q.x - p.x) * stop, p.y + (q.y - p.y) * stop, p.z + (q.z - p.z) * stop, ta + (tb - ta) * stop, -1, tMs);
          done = true;
        }
        sh.tSim = tb;
      }
      if (done || sh.tSim >= sh.t0 + w.maxFlightS * 1000 - 1) this.shells.splice(i, 1);
    }
  }

  _explode(sh, x, y, z, tHit, direct, tMs) {
    const v = this.v, cur = this.cur, w = sh.w;
    this._fxAround(FX.BOOM, sh.seq, sh.netId, tHit, x, y, z, 0, 0, sh.weapon);
    const R = w.splash, cell = cellOf(x, z), gx = cell % GRID_NX, gz = (cell / GRID_NX) | 0;
    let victims = 0;
    for (let dz = -1; dz <= 1; dz++) {
      const zz = gz + dz;
      if (zz < 0 || zz >= GRID_NZ) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = gx + dx;
        if (xx < 0 || xx >= GRID_NX) continue;
        for (let o = this.head[zz * GRID_NX + xx]; o >= 0; o = this.next[o]) {
          const k = o * CS, tank = this.isTank[cur[k + 12]], vc = v.vclass[o], b = boxOf(vc, tank);
          let amount = 0, kind = DMG.SPLASH;
          if (o === direct) { amount = tank ? DAMAGE.direct.tank : DAMAGE.direct[vc] ?? 1; kind = DMG.SHELL; }
          else {
            const e = Math.max(-0.5, Math.min(0.5, (tHit - cur[k + 11]) / 1000));
            const d = pointBoxDistance(x, y, z, cur[k] + cur[k + 3] * e, cur[k + 1] + cur[k + 4] * e + b[3], cur[k + 2] + cur[k + 5] * e, cur[k + 6], b[0], b[1], b[2]);
            amount = splashDamage(vc, tank, d, R);
          }
          if (!(amount > 0.01)) continue;
          const destroyed = amount >= 0.999;
          this._damage(o, kind, sh.seq, sh.netId, amount, x, y, z, Math.atan2(-(cur[k] - x), -(cur[k + 2] - z)), destroyed);
          if (o !== sh.slot && victims < 6) { this._hit(sh.slot, sh.seq, this._id(o), amount, destroyed); victims++; }
          this.combat.hits++;
        }
      }
    }
  }

  _damage(slot, kind, seq, attacker, amount, x, y, z, dirYaw, destroyed) {
    const o = this._alloc(DAMAGE_SIZE);
    if (o < 0) return;
    writeDamage(this.v.arenaDV, o, kind, seq, attacker, amount, x, y, z, dirYaw, destroyed);
    this._entry(KIND_PLAYER, slot, o, DAMAGE_SIZE);
  }

  _hit(slot, seq, victim, damage, destroyed) {
    const o = this._alloc(HIT_SIZE);
    if (o < 0) return;
    writeHit(this.v.arenaDV, o, seq, victim, damage, destroyed);
    this._entry(KIND_PLAYER, slot, o, HIT_SIZE);
  }

  // a moving tank over a car or bike destroys it (tank vs tank: no crush)
  _crush(tMs) {
    const v = this.v, cur = this.cur;
    for (let i = 0; i < this.tankN; i++) {
      const t = this.tanks[i], k = t * CS;
      if (Math.hypot(cur[k + 3], cur[k + 5]) < CRUSH.minSpeed) continue;
      const cell = this.cellOf[t];
      if (cell < 0) continue;
      const gx = cell % GRID_NX, gz = (cell / GRID_NX) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = gz + dz;
        if (zz < 0 || zz >= GRID_NZ) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx;
          if (xx < 0 || xx >= GRID_NX) continue;
          for (let o = this.head[zz * GRID_NX + xx]; o >= 0; o = this.next[o]) {
            if (o === t) continue;
            const j = o * CS, vc = v.vclass[o];
            if ((vc !== VCLASS.CAR && vc !== VCLASS.BIKE) || this.isTank[cur[j + 12]]) continue;
            if (tMs - this.crushT[o] < CRUSH.cooldownMs) continue;
            const b = boxOf(vc, false);
            if (!crushes(cur[k], cur[k + 1], cur[k + 2], cur[k + 6], cur[j], cur[j + 1], cur[j + 2], b[0], b[2])) continue;
            this.crushT[o] = tMs;
            this.combat.crushes++;
            const tid = this._id(t);
            this._damage(o, DMG.CRUSH, 0, tid, 1, cur[j], cur[j + 1], cur[j + 2], cur[k + 6], true);
            this._hit(t, 0, this._id(o), 1, true);
            this._fxAround(FX.BOOM, 0, tid, tMs, cur[j], cur[j + 1] + 0.8, cur[j + 2], 0, 0, 0);
          }
        }
      }
    }
  }

  // ---------------- radar / density / global ----------------
  _radar(T) {
    // called on send ticks: RADAR_PERIOD / SEND_EVERY phases, each radar cell once per period
    const v = this.v, dv = v.arenaDV, step = RADAR_PERIOD / SEND_EVERY, phase = (T / SEND_EVERY | 0) % step;
    const period = (T / RADAR_PERIOD) | 0, cand = this.radarCand, cur = this.cur;
    for (let rc = phase; rc < RADAR_CELLS; rc += step) {
      const subs = v.subRadar[rc], fresh = subs > this.radarSubs[rc]; // a new viewer gets everybody at once
      this.radarSubs[rc] = subs;
      if (subs <= 0) continue;
      const rx = rc % RADAR_NX, rz = (rc / RADAR_NX) | 0;
      const gx0 = Math.max(0, (rx - 1) * 8), gx1 = Math.min(GRID_NX, (rx + 2) * 8);
      const gz0 = Math.max(0, (rz - 1) * 8), gz1 = Math.min(GRID_NZ, (rz + 2) * 8);
      // moving players are in every summary; standing ones only in every RADAR_STILL_EVERY-th (staggered by slot),
      // clients keep standing tracks that long
      let total = 0, n = 0;
      for (let gz = gz0; gz < gz1; gz++) {
        for (let gx = gx0; gx < gx1; gx++) {
          for (let s = this.head[gz * GRID_NX + gx]; s >= 0; s = this.next[s]) {
            total++;
            const k = s * CS, vx = cur[k + 3], vz = cur[k + 5];
            if (fresh || vx * vx + vz * vz > RADAR_STILL_V2 || (s + period) % RADAR_STILL_EVERY === 0) cand[n++] = s;
          }
        }
      }
      if (!n) continue;
      const take = Math.min(n, RADAR_MAX), stride = n / take;
      const o0 = this._alloc(RADAR_HDR + take * RADAR_ENTRY);
      if (o0 < 0) return;
      let o = writeRadarHeader(dv, o0, rc, T, take, total);
      const wx0 = radarWinX0(rc), wz0 = radarWinZ0(rc);
      for (let i = 0; i < take; i++) {
        const s = cand[Math.floor(i * stride)], k = s * CS;
        o = writeRadarEntry(dv, o, wx0, wz0, cur[k], cur[k + 2], v.color[s], cur[k + 6], v.vclass[s], this._id(s), cur[k + 3], cur[k + 5]);
      }
      this._entry(KIND_RADAR, rc, o0, RADAR_HDR + take * RADAR_ENTRY);
    }
  }

  _density() {
    const c = this.densityCounts;
    c.fill(0);
    for (let gz = 0; gz < GRID_NZ; gz++) {
      for (let gx = 0; gx < GRID_NX; gx++) {
        const n = this.count[gz * GRID_NX + gx];
        if (n) c[((gz >> 3) * RADAR_NX) + (gx >> 3)] += n;
      }
    }
    // kept for requests (the full map asks while it is open) instead of being broadcast to everyone
    const buf = new Uint8Array(encodeDensity(c, RADAR_NX, RADAR_NZ));
    const v = this.v;
    v.densityMsg.set(buf, 0);
    v.densityLen[0] = buf.length;
    Atomics.add(v.densityLen, 1, 1);
  }

  _global(T, tMs, online) {
    const v = this.v;
    const wc = worldClock(tMs);
    const g = {
      online, total: Math.max(this.board.total || 0, online), serverTime: tMs, tick: T, hour: wc.hour, timeScale: wc.timeScale,
      weatherIndex: wc.weatherIndex, prevIndex: wc.prevIndex, transition: wc.transition, transitionS: wc.transitionS, top: this.board.top || [],
    };
    // the board (top 10 by net worth) is served on request (scoreboard / pause menu); everyone only gets its version
    const len = encodeGlobal(g, this.globalScratch);
    const src = new Uint8Array(this.globalScratch.buffer, 0, len);
    let sig = '';
    for (const t of g.top) sig += `${t.netId}:${t.nickCode}:${t.name || ''}:${Math.round(t.money)}:${t.color};`;
    if (sig !== this.boardSig) { this.boardSig = sig; this.boardVer = (this.boardVer + 1) & 0xffff; }
    v.globalMsg.set(src, 0);
    v.globalLen[0] = len;
    Atomics.add(v.globalLen, 1, 1);
    v.hub[H_TOTAL_PLAYERS] = g.total;
    v.hub[H_BOARD_VER] = this.boardVer;
  }

  // every 5 s on the global topic: online count, registered players, board version, tick (16 bytes)
  _pulse(T, online) {
    const v = this.v, total = Math.max(this.board.total || 0, online);
    const o = this._alloc(PULSE_SIZE);
    if (o >= 0) { writePulse(v.arenaDV, o, this.boardVer, online, total, T); this._entry(KIND_GLOBAL, 0, o, PULSE_SIZE); }
    writePulse(this.pulseScratch, 0, this.boardVer, online, total, T);
    v.pulseMsg.set(new Uint8Array(this.pulseScratch.buffer, 0, PULSE_SIZE), 0);
  }
}

// ---------------- helpers ----------------
const _dr = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
const _dc = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
const _pa = { x: 0, y: 0, z: 0 }, _pb = { x: 0, y: 0, z: 0 };
function insideWithMargin(cell, x, z, m) {
  const x0 = cellX0(cell), z0 = cellZ0(cell);
  return x >= x0 - m && x < x0 + CELL + m && z >= z0 - m && z < z0 + CELL + m;
}
function makeGoneList(cells, cap) {
  return { head: new Int32Array(cells).fill(-1), next: new Int32Array(cap), id: new Int32Array(cap), to: new Int32Array(cap), cell: new Int32Array(cap), n: 0, cap };
}
function pushGone(l, cell, id, to) {
  if (cell < 0 || l.n >= l.cap) return;
  const i = l.n++;
  l.id[i] = id; l.to[i] = to; l.cell[i] = cell;
  l.next[i] = l.head[cell];
  l.head[cell] = i;
}
function clearGone(l) {
  for (let i = 0; i < l.n; i++) l.head[l.cell[i]] = -1;
  l.n = 0;
}

// partial selection: move the k highest-priority candidates to the front (quickselect, O(n))
function selectTop(cand, prio, n, k) {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = prio[(lo + hi) >>> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (prio[i] > pivot) i++;
      while (prio[j] < pivot) j--;
      if (i <= j) {
        const tp = prio[i]; prio[i] = prio[j]; prio[j] = tp;
        const tc = cand[i]; cand[i] = cand[j]; cand[j] = tc;
        i++; j--;
      }
    }
    if (k - 1 <= j) hi = j;
    else if (k - 1 >= i) lo = i;
    else break;
  }
}

function percentile(arr, n, q) {
  const a = Array.from(arr.subarray(0, n)).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0;
}

export { F_TPC, F_INFO, F_INFO_SHIFT };
