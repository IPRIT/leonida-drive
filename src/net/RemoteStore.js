// Remote players: snapshot buffers, adaptive jitter buffer, C1 interpolation. Pure JS (no three.js, no DOM) so the
// smoothness test runs in Node.
//
//  - Records arrive sparsely (10 Hz at most): the server only sends an entity when its dead reckoning along the
//    yaw-rate arc would be off by more than a threshold (or as a keyframe), so between records the client
//    extrapolates exactly the model the server mirrors, which keeps the error below the threshold by construction.
//  - Rendering runs `delay` ms behind the server clock. The delay adapts to measured arrival jitter (time-warping
//    the render clock by ≤ 2 % so it never jumps).
//  - Between two snapshots the path is a cubic Hermite curve through positions AND velocities (C1: no velocity
//    discontinuities). Yaw uses Hermite on the shortest-path unwrapped angle with yaw rate as tangents.
//  - When new data changes the curve, the visual discontinuity is absorbed into an error offset that decays with a
//    critically damped spring: positions stay continuous, nothing ever snaps. Jumps > 50 m or a server teleport
//    counter change play a dissolve (scale out at the old place, scale in at the new one) instead of sliding.
import { wrapAngle, hermite, hermiteVel, hermiteAcc, dampOffset3, dampOffset, lerpAngle } from './interp.js';
import { drArc } from './shared/dr.js';
import { F_TPC, REC_FULL, REC_ROT, REC_STEER, REC_TURRET } from './shared/constants.js';
import { GONE_LEFT as GONE_LEFT_ID } from './shared/protocol.js';

const K = 8; // snapshots per entity
const S = 16; // stride: t x y z vx vy vz yaw yawRate pitch roll steer model flags turret barrel
const OMEGA = 14; // offset filter: third-order critically damped (settles in ~0.5 s, no acceleration spikes)
const SNAP_DIST = 50; // m: bigger discontinuities dissolve instead of sliding
// ms: keep extrapolating this long past the newest message of any kind when the stream stalls. There is no heartbeat:
// every moving entity gets a keyframe at least every 2 s (near) / 4 s (far), and the 10 s pulse carries the tick.
const EXTRAP_STALE = 2600;
const FADE_IN = 0.3, FADE_OUT = 0.3, TP_OUT = 0.15, TP_IN = 0.25;
const ORPHAN_MS = 600; // a "moved to another cell" entity disappears if no other stream picks it up
// Records are sent on deviation: an entity that moves predictably (or stands still) is silent between keyframes (near:
// 2 s moving / 20 s parked, far: 4 s / 30 s). Departures are explicit ("gone" over TCP), so silence limits are only a
// safety net, and dead reckoning past the newest record is exact up to the server's thresholds.
const MAX_SILENCE = [45000, 65000]; // ms without a record before an entity is considered gone (near, far)
const MAX_EXTRAP = [2600, 5000]; // ms of dead reckoning past the newest record (keyframes every 2 / 4 s when moving)
const LAT_N = 64;
const AGE_CAP = 510; // the full representable uplink age: high-ping senders need buffer time as well as receivers

export class RemoteStore {
  constructor({ tickDt = 50, max = 4096 } = {}) {
    this.tickDt = tickDt;
    this.max = max;
    this.byId = new Map();
    this.list = []; // live entities (render order irrelevant)
    this.pool = [];
    this.selfId = -1;
    this.t0 = 0; this.tick0 = 0; this.timed = false;
    // jitter buffer
    this.lat = new Float64Array(LAT_N); this.latN = 0; this.latI = 0;
    this.delay = 150; // ms behind the server clock
    this.warp = 0; // ms/s: current rate of change of the delay
    this.target = 150;
    this.renderT = 0;
    this.liveT = 0; // server time of the newest heartbeat/record seen
    this.minBuffer = 50; this.maxBuffer = 250;
    this.vclassOf = new Uint8Array(256);
    this.onInfoWanted = null; // (entity) → void
    this.stats = { records: 0, dropsOld: 0, teleports: 0, fades: 0 };
  }

  setTiming(tick, serverTime) { this.tick0 = tick; this.t0 = serverTime; this.timed = true; }
  tickTime(T) { return this.t0 + (T - this.tick0) * this.tickDt; }

  /** Stream liveness: called for every heartbeat / cell message (local ms, clock offset ms). */
  arrival(tick, localNow, offset) {
    const t = this.tickTime(tick);
    if (t > this.liveT) this.liveT = t;
    if (offset !== undefined) this.offset = offset;
  }

  resetLatency() { this.latN = 0; this.latI = 0; this.delay = this.target = 150; this.warp = 0; this.lastOffset = undefined; }

  // end-to-end lateness of a record (sender sample → our screen): what the jitter buffer must cover
  _late(late) {
    if (!this.latN && !this.list.some((e) => e.alpha > .05)) {
      this.delay = this.target = Math.max(50, late + this.minBuffer); this.warp = 0;
    }
    this.lat[this.latI] = late;
    this.latI = (this.latI + 1) % LAT_N;
    if (this.latN < LAT_N) this.latN++;
    if ((this.latI & 7) === 0) this._retarget();
  }

  _retarget() {
    const n = this.latN;
    const a = Array.prototype.slice.call(this.lat, 0, n).sort((x, y) => x - y);
    const min = a[0], p95 = a[Math.min(n - 1, Math.floor(n * 0.95))];
    let target = p95 + 15; // the newest sample is in hand when we render its time
    target = Math.max(min + this.minBuffer, Math.min(min + this.maxBuffer, target));
    this.target = target;
    this.latMin = min;
    this.jitter = p95 - min;
  }

  // ---------------- ingest ----------------
  _entity(id) {
    let e = this.byId.get(id);
    if (e) return e;
    if (this.list.length >= this.max) return null;
    e = this.pool.pop() || makeEntity();
    resetEntity(e, id);
    this.byId.set(id, e);
    e.index = this.list.length;
    this.list.push(e);
    return e;
  }

  _remove(e) {
    this.byId.delete(e.id);
    const i = e.index, last = this.list.pop();
    if (last !== e) { this.list[i] = last; last.index = i; }
    this.pool.push(e);
  }

  /** rec: { id, x, y, z, yaw, pitch, roll, vx, vy, vz, yawRate, steer, model, flags } from readRecord. */
  ingest(rec, tick, stream, localNow) {
    if (rec.id === this.selfId) return;
    // optional record parts: missing ones are the entity's last known values; a newcomer needs a full record first
    const parts = rec.parts ?? 0xff;
    const known = this.byId.get(rec.id);
    if (!(parts & REC_FULL) && !known?.hasFull) { this.stats.waitFull = (this.stats.waitFull || 0) + 1; return; }
    if (parts !== 0xff) {
      const k = known;
      if (parts & REC_FULL) { if (k) { k.km = rec.model; k.kf = rec.flags; } } else { rec.model = k.km; rec.flags = k.kf; }
      if (parts & REC_ROT) { if (k) { k.kp = rec.pitch; k.kr = rec.roll; } } else { rec.pitch = k ? k.kp : 0; rec.roll = k ? k.kr : 0; }
      if (parts & REC_STEER) { if (k) k.ks = rec.steer; } else rec.steer = k ? k.ks : 0;
      if (!(parts & REC_TURRET)) { rec.turret = 0; rec.barrel = 0; }
    }
    const tt = this.tickTime(tick), t = tt - (rec.age || 0); // the sample's own time
    // Include uplink delay for moving entities. Parked keyframes can carry old
    // timestamps without indicating latency and should not inflate the buffer.
    const moving = Math.hypot(rec.vx, rec.vy, rec.vz) > .3;
    if (this.offset !== undefined) this._late(localNow + this.offset - Math.max(t, tt - (moving ? AGE_CAP : 120)));
    const e = known || this._entity(rec.id);
    if (!e) return;
    if (!known) { e.hasFull = true; e.km = rec.model; e.kf = rec.flags; e.kp = rec.pitch || 0; e.kr = rec.roll || 0; e.ks = rec.steer || 0; }
    this.stats.records++;
    e.orphanAt = 0;
    e.recvAt = localNow;
    e.stream = stream;
    if (e.lastT >= t) {
      // duplicate (near + far) or reordered: insert only if it is genuinely new
      if (!insertOld(e, t, rec)) this.stats.dropsOld++;
      return;
    }
    // teleport: server counter changed, or a jump the dead reckoning can't explain
    const tpc = rec.flags & F_TPC;
    if (e.n > 0) {
      const k = e.head * S, dt = (t - e.snap[k]) / 1000;
      const px = e.snap[k + 1] + e.snap[k + 4] * dt, pz = e.snap[k + 3] + e.snap[k + 6] * dt;
      const jump = Math.hypot(rec.x - px, rec.z - pz);
      if (tpc !== e.tpc || jump > SNAP_DIST + Math.hypot(rec.vx, rec.vz) * 0.5) {
        this.stats.teleports++;
        e.tp = 1; e.tpT = 0; // play the dissolve, then restart the curve at the new place
        e.n = 0;
      }
    }
    e.tpc = tpc;
    pushSnap(e, t, rec);
    if (e.state === 'out') { e.state = 'live'; }
    // info (nick / colour / paint) — ask when unknown or changed
    const iv = (rec.flags >>> 12) & 7; // (info version: the flags of the latest full part)
    if (e.infoVer !== iv && !e.infoWanted) { e.infoWanted = true; e.wantVer = iv; this.onInfoWanted?.(e); }
    e.lastT = t;
  }

  /** The entity left this cell. toCell = GONE_LEFT_ID: left the server (fade now). */
  gone(id, toCell, localNow) {
    const e = this.byId.get(id);
    if (!e) return;
    if (toCell === GONE_LEFT_ID) { e.state = 'out'; e.left = true; return; }
    e.orphanAt = localNow; // another subscribed stream should pick it up within ORPHAN_MS
  }

  /** i = decoded INFO record (protocol.readInfo): nick, colour, paint, cosmetics, outfit, worth, custom name. */
  info(i) {
    const e = this.byId.get(i.netId);
    if (!e) return null;
    e.nickCode = i.nickCode; e.color = i.color; e.infoVer = i.infoVer; e.paint = i.paint; e.finish = i.finish | 0;
    e.name = i.name || ''; e.neon = i.neon ?? null; e.tint = !!i.tint; e.horn = i.horn ?? null; e.armor = !!i.armor;
    e.outfit = i.outfit ? i.outfit.slice() : []; e.look = null; e.worth = i.worth || 0;
    const now = performance.now();
    e.infoWanted = false; e.hasInfo = true; e.infoAt = now;
    // visual state (C_VIS on the sender's side): a tank wreck seed with its age, car damage bytes with a version
    if (!i.wreck) e.wreck = null;
    else if (e.wreck?.seed !== i.wreck.seed) e.wreck = { seed: i.wreck.seed, short: i.wreck.short, at: now - (i.wreck.ageMs || 0) };
    e.away = !!i.away; // tab in the background: frozen in place (the server holds it still), AFK badge
    if (!i.damage) { if (e.damage) e.damage = null; } else if (!e.damage || e.damage.ver !== i.damage.ver) e.damage = { ver: i.damage.ver, data: i.damage.data };
    return e;
  }

  // ---------------- per frame ----------------
  /**
   * Advance the render clock and evaluate every entity at it. localNow = performance.now(), offset = server clock
   * offset (ms), dt = frame seconds.
   */
  update(localNow, offset, dt) {
    if (!this.timed || this.offset === undefined) return; // wait for the clock sync
    // a corrected clock offset must not move the render clock: shift the delay and the lateness history with it
    if (this.lastOffset !== undefined && offset !== this.lastOffset) {
      const d = offset - this.lastOffset;
      this.delay += d; this.target += d;
      for (let i = 0; i < this.latN; i++) this.lat[i] += d;
      if (this.latMin !== undefined) this.latMin += d;
    }
    this.lastOffset = offset;
    dt = Math.min(Math.max(dt, 0), 0.1);
    // Adapt without rewinding the render clock when Wi-Fi suddenly gets worse.
    // Large deficits catch up gradually; ordinary jitter stays within 1% speed.
    const diff = this.target - this.delay;
    {
      const limit = diff > 250 ? 80 : 10;
      const want = Math.max(-10, Math.min(limit, diff * 0.8));
      const dw = want - this.warp, maxStep = 15 * dt; // ramp the warp at ≤ 15 ms/s²
      this.warp += Math.max(-maxStep, Math.min(maxStep, dw));
      this.delay += this.warp * dt;
    }
    const prevT = this.renderT;
    const rt = localNow + offset - this.delay;
    this.renderT = rt;
    const stallLimit = this.liveT + EXTRAP_STALE;
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      // lifetime: orphaned, silent, or leaving
      if (e.state !== 'out') {
        if (e.orphanAt && localNow - e.orphanAt > ORPHAN_MS) e.state = 'out';
        else if (e.n && this.liveT - e.lastT > MAX_SILENCE[e.stream] && rt > e.lastT) e.state = 'out';
      }
      evaluate(e, rt, prevT, Math.min(stallLimit, e.lastT + MAX_EXTRAP[e.stream]), dt,
        this.target > 500 || this.delay > 500 || localNow + offset - this.liveT > 500);
      // presence (scale) animation
      if (e.tp) {
        e.tpT += dt;
        if (e.tp === 1) { e.alpha = Math.max(0, 1 - e.tpT / TP_OUT); if (e.tpT >= TP_OUT) { e.tp = 2; e.tpT = 0; e.snapNext = true; } }
        else { e.alpha = Math.min(1, e.tpT / TP_IN); if (e.tpT >= TP_IN) e.tp = 0; }
      } else if (e.state === 'out') {
        e.alpha -= dt / FADE_OUT;
        if (e.alpha <= 0) { this.stats.fades++; this._remove(e); continue; }
      } else if (e.alpha < 1) e.alpha = Math.min(1, e.alpha + dt / FADE_IN);
      e.vclass = this.vclassOf[e.model];
    }
  }

  clear() { for (const e of [...this.list]) this._remove(e); }
}

// ---------------- entity internals ----------------
function makeEntity() {
  return {
    id: 0, index: 0, snap: new Float64Array(K * S), n: 0, head: 0, lastT: -1e15, tpc: 0, stream: 0,
    // rendered state
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, speed: 0, vx: 0, vy: 0, vz: 0, model: 0, flags: 0, vclass: 0,
    turret: 0, barrel: 0, // turret yaw (relative to the hull) and barrel pitch of turret vehicles (tanks)
    alpha: 0, state: 'live', tp: 0, tpT: 0, snapNext: false, left: false,
    // curve continuity
    off: new Float64Array(12), // per axis x, y, z, yaw: offset, offset velocity, offset acceleration
    cx: 0, cy: 0, cz: 0, cyaw: 0, cvx: 0, cvy: 0, cvz: 0, cyr: 0, cax: 0, cay: 0, caz: 0, hasCurve: false,
    orphanAt: 0, recvAt: 0,
    // info
    nickCode: 0, color: 0, paint: 0, infoVer: -1, wantVer: 0, infoWanted: false, hasInfo: false, infoAt: 0,
    hasFull: false, km: 0, kf: 0, kp: 0, kr: 0, ks: 0, // last known optional record parts (model, flags, pitch, roll, steer)
    name: '', finish: 0, neon: null, tint: false, horn: null, armor: false, outfit: [], look: null, worth: 0, wreck: null, damage: null, wreckH: null, away: false,
    // renderer scratch
    dist: 0, slot: -1, render: null, wheelSpin: 0, animPhase: 0,
  };
}
function resetEntity(e, id) {
  e.id = id; e.n = 0; e.head = 0; e.lastT = -1e15; e.tpc = -1; e.stream = 0;
  e.alpha = 0; e.state = 'live'; e.tp = 0; e.tpT = 0; e.snapNext = false; e.left = false;
  e.off.fill(0); e.hasCurve = false; e.orphanAt = 0; e.recvAt = 0;
  e.nickCode = 0; e.color = 0; e.paint = 0; e.infoVer = -1; e.infoWanted = false; e.hasInfo = false; e.infoAt = 0;
  e.hasFull = false; e.km = 0; e.kf = 0; e.kp = 0; e.kr = 0; e.ks = 0;
  e.name = ''; e.finish = 0; e.neon = null; e.tint = false; e.horn = null; e.armor = false; e.outfit = []; e.look = null; e.worth = 0; e.wreck = null; e.damage = null; e.wreckH = null; e.away = false;
  e.turret = 0; e.barrel = 0;
  e.dist = 0; e.slot = -1; e.wheelSpin = 0; e.animPhase = Math.random() * 6.283;
}

function writeSnap(a, k, t, r) {
  a[k] = t; a[k + 1] = r.x; a[k + 2] = r.y; a[k + 3] = r.z; a[k + 4] = r.vx; a[k + 5] = r.vy; a[k + 6] = r.vz;
  a[k + 7] = r.yaw; a[k + 8] = r.yawRate; a[k + 9] = r.pitch; a[k + 10] = r.roll; a[k + 11] = r.steer; a[k + 12] = r.model; a[k + 13] = r.flags;
  a[k + 14] = r.turret || 0; a[k + 15] = r.barrel || 0;
}
function pushSnap(e, t, r) {
  e.head = e.n ? (e.head + 1) % K : 0;
  writeSnap(e.snap, e.head * S, t, r);
  if (e.n < K) e.n++;
}
// out-of-order record: keep the ring sorted by time (rare: only reordering in tests or near/far races)
function insertOld(e, t, r) {
  const a = e.snap;
  for (let j = 0; j < e.n; j++) {
    const k = ((e.head - j + K) % K) * S;
    if (a[k] === t) return false;
  }
  if (e.n < 2) return false;
  const oldest = ((e.head - e.n + 1 + K) % K) * S;
  if (t < a[oldest]) return false;
  // rebuild in order
  const tmp = [];
  for (let j = e.n - 1; j >= 0; j--) { const k = ((e.head - j + K) % K) * S; tmp.push(Array.prototype.slice.call(a, k, k + S)); }
  tmp.push([t, r.x, r.y, r.z, r.vx, r.vy, r.vz, r.yaw, r.yawRate, r.pitch, r.roll, r.steer, r.model, r.flags, r.turret || 0, r.barrel || 0]);
  tmp.sort((p, q) => p[0] - q[0]);
  while (tmp.length > K) tmp.shift();
  e.n = tmp.length;
  for (let j = 0; j < tmp.length; j++) a.set(tmp[j], j * S);
  e.head = e.n - 1;
  return true;
}

const _c = { x: 0, y: 0, z: 0, yaw: 0, yawRate: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, pitch: 0, roll: 0, steer: 0, model: 0, flags: 0, turret: 0, barrel: 0 };

// evaluate the snapshot curve at time t into _c (returns false without data). tx = extrapolation time limit.
function curve(e, t, tx) {
  if (!e.n) return false;
  const a = e.snap;
  // newest snapshot at or before t
  let j = 0, k = e.head * S;
  while (j < e.n - 1 && a[k] > t) { j++; k = ((e.head - j + K) % K) * S; }
  if (a[k] > t) {
    // before our first snapshot: hold it
    copyAt(a, k, 0);
    return true;
  }
  if (j === 0) {
    // past the newest: dead reckoning (the server's model), frozen when the stream is stale
    const d = (Math.min(t, Math.max(tx, a[k])) - a[k]) / 1000;
    copyAt(a, k, d);
    return true;
  }
  const k1 = ((e.head - j + 1 + K) % K) * S;
  const t0 = a[k], t1 = a[k1];
  const dt = (t1 - t0) / 1000;
  const s = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  const x0 = a[k + 1], y0 = a[k + 2], z0 = a[k + 3], x1 = a[k1 + 1], y1 = a[k1 + 2], z1 = a[k1 + 3];
  const vx0 = a[k + 4], vy0 = a[k + 5], vz0 = a[k + 6], vx1 = a[k1 + 4], vy1 = a[k1 + 5], vz1 = a[k1 + 6];
  // Hermite needs velocities consistent with the displacement; otherwise (impacts) fall back to linear
  const span = Math.hypot(x1 - x0, z1 - z0), vspan = (Math.hypot(vx0, vz0) + Math.hypot(vx1, vz1)) * 0.5 * dt;
  if (span > vspan * 3 + 2) {
    _c.x = x0 + (x1 - x0) * s; _c.y = y0 + (y1 - y0) * s; _c.z = z0 + (z1 - z0) * s;
    _c.vx = (x1 - x0) / dt; _c.vy = (y1 - y0) / dt; _c.vz = (z1 - z0) / dt;
    _c.ax = _c.ay = _c.az = 0;
  } else {
    _c.x = hermite(x0, vx0, x1, vx1, dt, s); _c.y = hermite(y0, vy0, y1, vy1, dt, s); _c.z = hermite(z0, vz0, z1, vz1, dt, s);
    _c.vx = hermiteVel(x0, vx0, x1, vx1, dt, s); _c.vy = hermiteVel(y0, vy0, y1, vy1, dt, s); _c.vz = hermiteVel(z0, vz0, z1, vz1, dt, s);
    _c.ax = hermiteAcc(x0, vx0, x1, vx1, dt, s); _c.ay = hermiteAcc(y0, vy0, y1, vy1, dt, s); _c.az = hermiteAcc(z0, vz0, z1, vz1, dt, s);
  }
  const yaw0 = a[k + 7], yaw1 = yaw0 + wrapAngle(a[k1 + 7] - yaw0);
  _c.yaw = wrapAngle(hermite(yaw0, a[k + 8], yaw1, a[k1 + 8], dt, s));
  _c.yawRate = hermiteVel(yaw0, a[k + 8], yaw1, a[k1 + 8], dt, s);
  _c.pitch = lerpAngle(a[k + 9], a[k1 + 9], s);
  _c.roll = lerpAngle(a[k + 10], a[k1 + 10], s);
  _c.steer = a[k + 11] + (a[k1 + 11] - a[k + 11]) * s;
  _c.turret = lerpAngle(a[k + 14], a[k1 + 14], s);
  _c.barrel = a[k + 15] + (a[k1 + 15] - a[k + 15]) * s;
  const late = s >= 0.5 ? k1 : k;
  _c.model = a[late + 12]; _c.flags = a[late + 13];
  return true;
}
// dead reckoning from snapshot k, d seconds ahead: the same arc model the server mirrors (shared/dr.js)
const _d = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
function copyAt(a, k, d) {
  if (d > 0) {
    drArc(_d, a[k + 1], a[k + 2], a[k + 3], a[k + 4], a[k + 5], a[k + 6], a[k + 7], a[k + 8], d);
    _c.x = _d.x; _c.y = _d.y; _c.z = _d.z; _c.vx = _d.vx; _c.vy = _d.vy; _c.vz = _d.vz; _c.yaw = wrapAngle(_d.yaw);
    // centripetal acceleration of the arc (continuity of the offset filter)
    const w = a[k + 8];
    _c.ax = w * _d.vz; _c.ay = 0; _c.az = -w * _d.vx;
  } else {
    _c.x = a[k + 1]; _c.y = a[k + 2]; _c.z = a[k + 3]; _c.vx = a[k + 4]; _c.vy = a[k + 5]; _c.vz = a[k + 6];
    _c.yaw = a[k + 7]; _c.ax = _c.ay = _c.az = 0;
  }
  _c.yawRate = a[k + 8];
  _c.pitch = a[k + 9]; _c.roll = a[k + 10]; _c.steer = a[k + 11]; _c.model = a[k + 12]; _c.flags = a[k + 13];
  _c.turret = a[k + 14]; _c.barrel = a[k + 15];
}

function evaluate(e, rt, prevT, tx, dt, uncertain = false) {
  const o = e.off;
  // continuity: how much did the curve itself change at the previous render time since last frame (new data)?
  // The position, velocity AND acceleration differences go into the offset filter, so the rendered motion stays
  // continuous up to the acceleration (no snaps, no velocity steps, no jolts).
  if (e.hasCurve && !e.snapNext && curve(e, prevT, tx)) {
    const dx = e.cx - _c.x, dy = e.cy - _c.y, dz = e.cz - _c.z, dyaw = wrapAngle(e.cyaw - _c.yaw);
    if (dx * dx + dz * dz > SNAP_DIST * SNAP_DIST) { o.fill(0); }
    else if (dx !== 0 || dz !== 0 || dy !== 0 || dyaw !== 0 || e.cvx !== _c.vx || e.cvz !== _c.vz || e.cax !== _c.ax || e.caz !== _c.az) {
      o[0] += dx; o[1] += e.cvx - _c.vx; o[2] += e.cax - _c.ax;
      o[3] += dy; o[4] += e.cvy - _c.vy; o[5] += e.cay - _c.ay;
      o[6] += dz; o[7] += e.cvz - _c.vz; o[8] += e.caz - _c.az;
      o[9] += dyaw; o[10] += e.cyr - _c.yawRate;
    }
  }
  if (!curve(e, rt, tx)) return;
  if (e.snapNext || !e.hasCurve) { o.fill(0); e.snapNext = false; }
  e.cx = _c.x; e.cy = _c.y; e.cz = _c.z; e.cyaw = _c.yaw; e.hasCurve = true;
  e.cvx = _c.vx; e.cvy = _c.vy; e.cvz = _c.vz; e.cyr = _c.yawRate; e.cax = _c.ax; e.cay = _c.ay; e.caz = _c.az;
  if (e.tp === 1) return; // dissolving out at the old place: keep the old pose
  // Under heavy latency the Hermite acceleration is poorly constrained: feeding
  // it back into a stiff C2 spring amplifies the arrival burst. Keep C1 continuity
  // and ease large corrections more slowly instead of racing to the new pose.
  if (uncertain) {
    const omega = Math.min(3.5, 18 / Math.max(1, Math.hypot(o[0], o[6])));
    for (let i = 0; i < 12; i += 3) { dampOffset(o, i, omega, dt); o[i + 2] = 0; }
  } else for (let i = 0; i < 12; i += 3) dampOffset3(o, i, OMEGA, dt);
  e.x = _c.x + o[0]; e.y = _c.y + o[3]; e.z = _c.z + o[6];
  e.yaw = wrapAngle(_c.yaw + o[9]);
  e.vx = _c.vx + o[1]; e.vy = _c.vy + o[4]; e.vz = _c.vz + o[7];
  e.pitch = _c.pitch; e.roll = _c.roll; e.steer = _c.steer;
  e.speed = Math.hypot(e.vx, e.vz);
  e.model = _c.model; e.flags = _c.flags;
  // turret pose: eased toward the curve (new samples never snap the gun)
  const ka = 1 - Math.exp(-18 * dt);
  e.turret = wrapAngle(e.turret + wrapAngle(_c.turret - e.turret) * ka);
  e.barrel += (_c.barrel - e.barrel) * ka;
}
