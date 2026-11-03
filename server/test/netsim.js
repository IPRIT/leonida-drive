// Network simulation for the netcode smoothness test and tools/smoothness-report.mjs. End-to-end: a car drives a demanding path (launch, S-curves, braking, optionally a crash), the
// sender samples at 20 Hz and uploads on deviation like the browser (src/net/shared/uplink.js), the REAL hub encodes
// its error-driven 10 Hz cell stream (partial records), a simulated network drops 5% of messages,
// adds 30 ms jitter and reorders, and the REAL client RemoteStore renders at 60 fps. We measure tracking error and
// continuity (per-frame acceleration of the rendered motion: a snap or velocity jump shows up as a spike).
import { createShared, views, ARENA_MAX_ENTRIES, ARENA_HDR, KIND_NEAR, H_T0, H_TICK_DT } from '../src/shared-mem.js';
import { Hub } from '../src/hub.js';
import { RemoteStore } from '../../src/net/RemoteStore.js';
import { readRecord, cellX0, cellZ0, CELL_HDR, GONE_SIZE, unwrapTick } from '../../src/net/shared/protocol.js';
import { uplinkDue, rememberUplink } from '../../src/net/shared/uplink.js';
import { S_CELL, S_TICK, SLOT_BITS, GRID_CELLS, F_TPC } from '../../src/net/shared/constants.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ground truth: integrate a car with a speed profile and steering, 1 ms steps
function makeTruth(seconds, teleportAt = -1, crashAt = -1) {
  const dt = 0.001, n = Math.ceil(seconds / dt) + 1;
  const X = new Float64Array(n), Z = new Float64Array(n), YAW = new Float64Array(n), V = new Float64Array(n), YR = new Float64Array(n);
  let x = 1700, z = -700, yaw = 0, v = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const target = t < 6 ? 38 : t < 14 ? 30 : t < 18 ? 8 : t < 24 ? 33 : 15; // launch, cruise, brake, again
    v += Math.max(-9, Math.min(5.5, (target - v) * 1.2)) * dt;
    const yr = (0.55 * Math.sin(t * 0.9) + 0.25 * Math.sin(t * 2.3)) * Math.min(1, v / 12);
    yaw += yr * dt;
    x += -Math.sin(yaw) * v * dt;
    z += -Math.cos(yaw) * v * dt;
    if (teleportAt > 0 && Math.abs(t - teleportAt) < dt / 2) { x += 400; z -= 250; }
    // a crash: the car loses most of its speed in 60 ms and spins (heading kicked by 0.6 rad over 300 ms)
    if (crashAt > 0 && t >= crashAt && t < crashAt + 0.06) v *= 0.96;
    if (crashAt > 0 && t >= crashAt && t < crashAt + 0.3) yaw += 2 * dt;
    X[i] = x; Z[i] = z; YAW[i] = yaw; V[i] = v; YR[i] = yr;
  }
  // linear interpolation between the 1 ms integration steps (no artificial timestamp noise)
  const at = (t) => {
    const f = Math.max(0, Math.min(n - 1.000001, t / dt)), i = Math.floor(f), u = f - i;
    const L = (A) => A[i] + (A[i + 1] - A[i]) * u;
    const yaw = L(YAW), v = L(V);
    return { x: L(X), z: L(Z), yaw, vx: -Math.sin(yaw) * v, vz: -Math.cos(yaw) * v, yawRate: L(YR), v };
  };
  return at;
}

// loss: dropped messages (what a gateway does to a client over its backpressure limit). tcp: the same loss rate as TCP
// sees it: nothing is dropped, a lost segment is retransmitted ~200 ms later and holds back everything behind it.
export function simulate({ loss = 0, jitter = 0, reorder = 0, seconds = 30, seed = 1, teleportAt = -1, crashAt = -1, uplink: upMode = 'dev', tcp = false } = {}) {
  const r = rng(seed);
  const truth = makeTruth(seconds + 1, teleportAt, crashAt);
  const cfg = { tickHz: 20, nearBudget: 16, farBudget: 8 };
  const v = views(createShared(64, 1));
  const tickDt = 50;
  v.hub[H_T0] = 0; v.hub[H_TICK_DT] = tickDt;
  const hub = new Hub(v, cfg, { log: { info() {}, warn() {} } });
  v.subNear.fill(1); // everybody watches every cell (one viewer)
  const slot = 3, gen = 1, netId = slot | (gen << SLOT_BITS);
  v.gen[slot] = gen;
  const store = new RemoteStore({ tickDt });
  store.setTiming(0, 0);
  const events = []; // network events: { at (local ms), kind, payload }
  const UP_LAT = 40, DOWN_LAT = 45, CLOCK_OFF = 12345; // client local clock = server + offset error-free here
  let offMin = Infinity, tpc = 0, lastX = null;
  let bytes = 0, records = 0, ups = 0, tcpAt = 0;
  // uplink: client samples its physics every 3rd 60 Hz step (20 Hz) and uploads on deviation (or every sample)
  const uplink = [], st = { y: 2, vy: 0, pitch: 0, roll: 0, steer: 0, model: 1, flags: 0, ext: false, health: 1 };
  let lastUp = null, lastUpT = 0;
  for (let k = 0; k * 50 <= seconds * 1000; k++) {
    const tc = k * 50 + (r() - 0.5) * 2; // physics-aligned sample time (client clock, here = server clock)
    Object.assign(st, truth(tc / 1000));
    if (upMode === 'dev' && !uplinkDue(lastUp, st, tc - lastUpT)) continue;
    lastUp = rememberUplink(st, lastUp || {}); lastUpT = tc;
    uplink.push({ tc, recv: tc + UP_LAT + r() * jitter });
  }
  ups = uplink.length;
  uplink.sort((a, b) => a.recv - b.recv);
  let ui = 0;
  const writeState = (s, sampleT) => {
    const p = slot * 3, q = slot * 5;
    Atomics.add(v.seq, slot, 1);
    v.pos[p] = s.x; v.pos[p + 1] = 2; v.pos[p + 2] = s.z;
    v.vel[p] = s.vx; v.vel[p + 1] = 0; v.vel[p + 2] = s.vz;
    v.rot[q] = s.yaw; v.rot[q + 1] = 0; v.rot[q + 2] = 0; v.rot[q + 3] = s.yawRate; v.rot[q + 4] = 0;
    v.sampleT[slot] = sampleT; v.model[slot] = 1; v.flags[slot] = tpc & F_TPC;
    Atomics.add(v.seq, slot, 1);
    Atomics.store(v.alive, slot, 1);
  };
  for (let T = 1; T * tickDt <= seconds * 1000; T++) {
    const tMs = T * tickDt;
    while (ui < uplink.length && uplink[ui].recv <= tMs) {
      const u = uplink[ui++];
      const s = truth(u.tc / 1000);
      if (lastX !== null && Math.hypot(s.x - lastX.x, s.z - lastX.z) > 100) tpc = (tpc + 1) & 3; // server-approved jump
      lastX = s;
      // the client is clock-synced (ping/pong), so it stamps samples in server time: the gateway uses them as-is
      writeState(s, Math.min(u.recv, u.tc));
    }
    const b = hub.step(T, tMs);
    // collect this tick's near-stream messages + heartbeat
    const h = b * ARENA_HDR, n = v.arenaHdr[h + 1], base = b * ARENA_MAX_ENTRIES * 3;
    for (let i = 0; i < n; i++) {
      const kind = v.arenaIdx[base + i * 3] >>> 24, off = v.arenaIdx[base + i * 3 + 1], len = v.arenaIdx[base + i * 3 + 2];
      const type = v.arenaData[off];
      if (kind !== KIND_NEAR && type !== S_TICK) continue;
      if (type !== S_CELL && type !== S_TICK) continue;
      const lost = r() < loss;
      if (lost && !tcp) continue;
      let at = tMs + DOWN_LAT + r() * jitter;
      if (tcp) { if (lost) at += 200 + r() * 60; at = tcpAt = Math.max(at, tcpAt); } // retransmit, head-of-line blocking
      else if (r() < reorder) at += 20 + r() * 40; // occasionally overtaken by a later message
      events.push({ at, buf: v.arenaData.slice(off, off + len) });
      if (type === S_CELL || type === S_TICK) bytes += len + 2;
    }
  }
  events.sort((a, b) => a.at - b.at);
  // client: 60 fps render loop with a little frame jitter; deliver messages that arrived before each frame
  let prevT0 = null;
  let ei = 0, t = 0, prev = null, prevV = null, prevT = null, prevTV = null, lastTick = 0;
  const res = { maxErr: 0, errs: [], maxAcc: 0, accs: [], maxStep: 0, frames: 0, alphaMin: 1, sawDissolve: false, snaps: 0 };
  const offset = -CLOCK_OFF; // server = local + offset
  while (t < seconds * 1000 - 300) {
    const dtf = 1000 / 60 + (r() - 0.5) * 3;
    t += dtf;
    const local = t + CLOCK_OFF;
    while (ei < events.length && events[ei].at <= t) {
      const dv = new DataView(events[ei].buf.buffer, events[ei].buf.byteOffset, events[ei].buf.byteLength);
      const type = dv.getUint8(0);
      if (type === S_TICK) { lastTick = Math.max(lastTick, dv.getUint32(4, true)); store.arrival(dv.getUint32(4, true), local, offset); }
      else {
        const cell = dv.getUint16(2, true), tick = unwrapTick(dv.getUint16(4, true), lastTick), cnt = dv.getUint8(6), gcount = dv.getUint8(7);
        if (tick > lastTick) lastTick = tick;
        store.arrival(tick, local, offset);
        let o = CELL_HDR;
        for (let g = 0; g < gcount; g++, o += GONE_SIZE) store.gone(dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16), dv.getUint16(o + 3, true), local);
        for (let k = 0; k < cnt; k++) { const rec = readRecord(dv, o, cellX0(cell), cellZ0(cell), {}); o += rec.size; store.ingest(rec, tick, 0, local); records++; }
      }
      ei++;
    }
    store.update(local, offset, dtf / 1000);
    const e = store.byId.get(netId);
    if (!e || e.alpha < 1 || store.renderT < 2000) { if (e && e.alpha < res.alphaMin) res.alphaMin = e.alpha; if (e?.tp) res.sawDissolve = true; prev = null; prevV = null; prevT = null; prevTV = null; continue; }
    const tr = truth(store.renderT / 1000);
    // truth sampled at the same render instants: its own frame-to-frame acceleration is the reference
    let trueAcc = 0;
    if (prevT) {
      const tvx = (tr.x - prevT.x) / (dtf / 1000), tvz = (tr.z - prevT.z) / (dtf / 1000);
      if (prevTV) trueAcc = Math.hypot(tvx - prevTV.vx, tvz - prevTV.vz) / (dtf / 1000);
      prevTV = { vx: tvx, vz: tvz };
    }
    prevT = { x: tr.x, z: tr.z };
    const err = Math.hypot(e.x - tr.x, e.z - tr.z);
    res.errs.push(err);
    res.maxErr = Math.max(res.maxErr, err);
    if (prev) {
      const vx = (e.x - prev.x) / (dtf / 1000), vz = (e.z - prev.z) / (dtf / 1000);
      res.maxStep = Math.max(res.maxStep, Math.hypot(e.x - prev.x, e.z - prev.z));
      // a visible snap: this frame's step differs from the true motion's step by more than 25 cm
      if (prevT0 && Math.hypot((e.x - prev.x) - (tr.x - prevT0.x), (e.z - prev.z) - (tr.z - prevT0.z)) > 0.25) res.snaps++;
      if (prevV) {
        // excess acceleration over the true motion's (a snap or a velocity step shows up as a spike here)
        const acc = Math.max(0, Math.hypot(vx - prevV.vx, vz - prevV.vz) / (dtf / 1000) - trueAcc);
        res.accs.push(acc);
        res.maxAcc = Math.max(res.maxAcc, acc);
      }
      prevV = { vx, vz };
    }
    prev = { x: e.x, z: e.z };
    prevT0 = { x: tr.x, z: tr.z };
    res.frames++;
  }
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  res.p99Err = q(res.errs, 0.99);
  res.p99Acc = q(res.accs, 0.99);
  res.bytesPerSec = bytes / seconds;
  res.recordsPerSec = records / seconds;
  res.upPerSec = ups / seconds;
  res.teleports = store.stats.teleports;
  res.delay = store.delay;
  return res;
}

export const fmt = (r) => `maxErr ${r.maxErr.toFixed(3)} m, p99Err ${r.p99Err.toFixed(3)} m, max excess acc ${r.maxAcc.toFixed(1)} m/s², p99 ${r.p99Acc.toFixed(1)} m/s², maxStep ${r.maxStep.toFixed(3)} m/frame, snaps ${r.snaps}, ${r.recordsPerSec.toFixed(1)} rec/s, ${r.bytesPerSec.toFixed(0)} B/s down, ${r.upPerSec.toFixed(1)} up/s, delay ${r.delay.toFixed(0)} ms`;
