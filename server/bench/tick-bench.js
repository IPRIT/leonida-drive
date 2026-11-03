// Microbenchmark: the hub tick with N simulated players in-process (no sockets), plus per-client bandwidth from the
// actual encoded arena, gateway-side message cost and memory per player.
//
//   node bench/tick-bench.js [players=100000] [ticks=200] [--dist=clustered|roads] [--egress=Mbps]
//
// --dist=clustered (default, worst case): 85% of players around the map's districts (weighted by building count,
//   σ = 0.45 r), 15% uniform. --dist=roads: spread over the road network (by length).
// 80% drive (5–35 m/s, steering held for 2–6 s then eased to a new value, like real input), 20% walk. Every player
// subscribes to its near (3×3) and far (5×5 ring) cells and its radar cell, exactly like the gateways do.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShared, views, ARENA_MAX_ENTRIES, ARENA_HDR, KIND_NEAR, KIND_FAR, KIND_RADAR, H_T0, H_TICK_DT } from '../src/shared-mem.js';
import { Hub } from '../src/hub.js';
import { Session } from '../src/session.js';
import { Movement } from '../src/validate.js';
import { loadVehicles } from '../src/vehicles.js';
import { cellOf, radarOf, writeState } from '../../src/net/shared/protocol.js';
import { GRID_NX, GRID_NZ, GRID_CELLS, NEAR_R, FAR_R, WORLD, STATE_SIZE, SLOT_BITS } from '../../src/net/shared/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const N = +(pos[0] ?? 100000);
const TICKS = +(pos[1] ?? 200);
const DIST = opt.dist || 'clustered';
const WARM = 40;
const world = JSON.parse(fs.readFileSync(path.resolve(here, '../../public/data/world.json'), 'utf8'));
const districts = world.districts.filter((d) => d.type === 'd');
const wsum = districts.reduce((s, d) => s + d.n, 0);

let seed = 12345;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const memBase = process.memoryUsage();
const cfg = { tickHz: 20, nearBudget: 16, farBudget: 8, egressMbps: +(opt.egress || 0) };
const v = views(createShared(Math.max(N, 64), 1));
v.hub[H_T0] = 0; v.hub[H_TICK_DT] = 50;
const hub = new Hub(v, cfg, { log: { info() {}, warn() {} } });
const memHub = process.memoryUsage();

// ---- players ----
const px = new Float64Array(N), pz = new Float64Array(N), yaw = new Float64Array(N), spd = new Float64Array(N), yr = new Float64Array(N), foot = new Uint8Array(N);
const yrTarget = new Float64Array(N), hold = new Float64Array(N);
let roads = null, roadLen = 0;
if (DIST === 'roads') {
  roads = JSON.parse(fs.readFileSync(path.resolve(here, '../../public/data/roads.json'), 'utf8')).edges.map((e) => {
    let L = 0; for (let k = 2; k < e.p.length; k += 2) L += Math.hypot(e.p[k] - e.p[k - 2], e.p[k + 1] - e.p[k - 1]);
    roadLen += L; return { p: e.p, L };
  });
}
for (let i = 0; i < N; i++) {
  if (roads) {
    let r = rnd() * roadLen, e = roads[0];
    for (const ee of roads) { if ((r -= ee.L) <= 0) { e = ee; break; } }
    const k = 2 * Math.floor(rnd() * (e.p.length / 2));
    px[i] = e.p[k] + gauss() * 4; pz[i] = e.p[k + 1] + gauss() * 4;
  } else if (rnd() < 0.85) {
    let r = rnd() * wsum, d = districts[0];
    for (const dd of districts) { if ((r -= dd.n) <= 0) { d = dd; break; } }
    px[i] = d.x + gauss() * d.r * 0.45; pz[i] = d.z + gauss() * d.r * 0.45;
  } else { px[i] = -8000 + rnd() * 11500; pz[i] = -8500 + rnd() * 17500; }
  px[i] = Math.min(WORLD.x1 - 20, Math.max(WORLD.x0 + 20, px[i])); pz[i] = Math.min(WORLD.z1 - 20, Math.max(WORLD.z0 + 20, pz[i]));
  foot[i] = rnd() < 0.2 ? 1 : 0;
  spd[i] = foot[i] ? 1.4 : 5 + rnd() * 30;
  yaw[i] = rnd() * 6.283;
  v.gen[i] = 1; v.color[i] = i % 24; v.vclass[i] = foot[i] ? 0 : 1;
}

// subscriptions (what the gateways maintain)
const subCell = new Int32Array(N).fill(-1), subRadar = new Int32Array(N).fill(-1);
function resubscribe(i, cell) {
  const apply = (c, d) => {
    const cx = c % GRID_NX, cz = (c / GRID_NX) | 0;
    for (let dz = -FAR_R; dz <= FAR_R; dz++) for (let dx = -FAR_R; dx <= FAR_R; dx++) {
      const gx = cx + dx, gz = cz + dz;
      if (gx < 0 || gz < 0 || gx >= GRID_NX || gz >= GRID_NZ) continue;
      const id = gz * GRID_NX + gx;
      if (Math.abs(dx) <= NEAR_R && Math.abs(dz) <= NEAR_R) v.subNear[id] += d; else v.subFar[id] += d;
      if (d > 0) v.subDirty[id] = 1;
    }
  };
  if (subCell[i] >= 0) apply(subCell[i], -1);
  apply(cell, 1);
  subCell[i] = cell;
  const rc = radarOf(px[i], pz[i]);
  if (rc !== subRadar[i]) { if (subRadar[i] >= 0) v.subRadar[subRadar[i]]--; v.subRadar[rc]++; subRadar[i] = rc; }
}

function simulate(tMs, dt) {
  for (let i = 0; i < N; i++) {
    // steering like a driver: hold a turn rate for 2–6 s, ease into the next one
    if ((hold[i] -= dt) <= 0) { hold[i] = 2 + rnd() * 4; yrTarget[i] = rnd() < 0.5 ? 0 : (rnd() - 0.5) * 0.8; }
    yr[i] += (yrTarget[i] - yr[i]) * Math.min(1, dt * 2);
    yaw[i] += yr[i] * dt;
    let nx = px[i] - Math.sin(yaw[i]) * spd[i] * dt, nz = pz[i] - Math.cos(yaw[i]) * spd[i] * dt;
    if (nx < WORLD.x0 + 20 || nx > WORLD.x1 - 20 || nz < WORLD.z0 + 20 || nz > WORLD.z1 - 20) { yaw[i] += Math.PI; nx = px[i]; nz = pz[i]; }
    px[i] = nx; pz[i] = nz;
    // the gateway's seqlocked write
    const p = i * 3, r = i * 5;
    Atomics.add(v.seq, i, 1);
    v.pos[p] = nx; v.pos[p + 1] = 2; v.pos[p + 2] = nz;
    v.vel[p] = -Math.sin(yaw[i]) * spd[i]; v.vel[p + 1] = 0; v.vel[p + 2] = -Math.cos(yaw[i]) * spd[i];
    v.rot[r] = yaw[i]; v.rot[r + 3] = yr[i];
    v.sampleT[i] = tMs - 10 - (i % 50);
    v.model[i] = foot[i] ? 0 : 1 + (i % 90);
    v.flags[i] = 0;
    Atomics.add(v.seq, i, 1);
    v.alive[i] = 1;
    const c = cellOf(nx, nz);
    if (c !== subCell[i]) resubscribe(i, c);
  }
}

// ---- per-client bandwidth from the real arena ----
const SAMPLE = Math.min(3000, N);
const sample = Array.from({ length: SAMPLE }, () => Math.floor(rnd() * N));
const cBytes = new Float64Array(SAMPLE), cMsgs = new Float64Array(SAMPLE);
let popNear = 0, popFar = 0, popN = 0;
function population() {
  for (let s = 0; s < SAMPLE; s += 10) {
    const c = subCell[sample[s]], cx = c % GRID_NX, cz = (c / GRID_NX) | 0;
    for (let dz = -FAR_R; dz <= FAR_R; dz++) for (let dx = -FAR_R; dx <= FAR_R; dx++) {
      const gx = cx + dx, gz = cz + dz;
      if (gx < 0 || gz < 0 || gx >= GRID_NX || gz >= GRID_NZ) continue;
      const n = hub.count[gz * GRID_NX + gx];
      if (Math.abs(dx) <= NEAR_R && Math.abs(dz) <= NEAR_R) popNear += n; else popFar += n;
    }
    popN++;
  }
}
function account(b) {
  const h = b * ARENA_HDR, n = v.arenaHdr[h + 1], base = b * ARENA_MAX_ENTRIES * 3;
  const near = new Map(), far = new Map(), radar = new Map();
  let global = 0, globalMsgs = 0;
  for (let i = 0; i < n; i++) {
    const k = v.arenaIdx[base + i * 3], len = v.arenaIdx[base + i * 3 + 2] + (v.arenaIdx[base + i * 3 + 2] < 126 ? 2 : 4);
    const kind = k >>> 24, id = k & 0xffffff;
    const m = kind === KIND_NEAR ? near : kind === KIND_FAR ? far : kind === KIND_RADAR ? radar : null;
    if (!m) { global += len; globalMsgs++; continue; }
    const e = m.get(id) || [0, 0];
    e[0] += len; e[1]++;
    m.set(id, e);
  }
  for (let s = 0; s < SAMPLE; s++) {
    const i = sample[s], c = subCell[i], cx = c % GRID_NX, cz = (c / GRID_NX) | 0;
    let bytes = global, msgs = globalMsgs;
    for (let dz = -FAR_R; dz <= FAR_R; dz++) for (let dx = -FAR_R; dx <= FAR_R; dx++) {
      const gx = cx + dx, gz = cz + dz;
      if (gx < 0 || gz < 0 || gx >= GRID_NX || gz >= GRID_NZ) continue;
      const id = gz * GRID_NX + gx, isNear = Math.abs(dx) <= NEAR_R && Math.abs(dz) <= NEAR_R;
      const e = (isNear ? near : far).get(id);
      if (e) { bytes += e[0]; msgs += e[1]; }
    }
    const r = radar.get(subRadar[i]);
    if (r) { bytes += r[0]; msgs += r[1]; }
    cBytes[s] += bytes; cMsgs[s] += msgs;
  }
}

// ---- run ----
const times = [];
let simMs = 0, arenaBytes = 0, records = 0;
for (let T = 1; T <= WARM + TICKS; T++) {
  const tMs = T * 50;
  const s0 = performance.now();
  simulate(tMs, 0.05);
  simMs += performance.now() - s0;
  const t0 = performance.now();
  const b = hub.step(T, tMs);
  const dt = performance.now() - t0;
  if (T > WARM) {
    times.push(dt);
    arenaBytes += v.arenaHdr[b * ARENA_HDR + 2];
    records += hub.encRecords;
    account(b);
    if (T % 20 === 0) population();
  }
}
times.sort((a, b) => a - b);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const perSec = Array.from(cBytes, (x) => (x / TICKS) * 20).sort((a, b) => a - b);
const msgsPerSec = Array.from(cMsgs, (x) => (x / TICKS) * 20).sort((a, b) => a - b);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// ---- gateway-side cost per STATE message (decode + validate + shared write) ----
const vehicles = loadVehicles();
const gw = { nextSid: 1, world: { heightAt: () => 0, hospitals: [] }, v, vehicles, cfg: { spawnCooldownS: 8 }, statAdd() {}, log: { info() {} }, sub() {}, unsub() {} };
const ws = { send() { return 1; }, getBufferedAmount() { return 0; }, subscribe() {}, unsubscribe() {} };
const sess = new Session(gw, ws, '127.0.0.1', 0);
sess.state = 'active'; sess.slot = 0; sess.model = 1; sess.econ = { owned: new Set(['pip']) }; sess.joinedAt = 0;
sess.mv.setClass(1, 60, 0); sess.mv.place(1300, 2, 0, 0, 0);
const buf = new ArrayBuffer(STATE_SIZE), sdv = new DataView(buf);
const M = 200000;
let z = 0;
const g0 = performance.now();
for (let k = 0; k < M; k++) {
  const th = k * 0.00333; // 20 m/s around a 300 m circle
  writeState(sdv, { seq: k, t: k * 50, serverClock: false, x: 1000 + 300 * Math.cos(th), y: 2, z: 300 * Math.sin(th), yaw: -th, pitch: 0, roll: 0, vx: -20 * Math.sin(th), vy: 0, vz: 20 * Math.cos(th), yawRate: 0.0667, steer: 0, model: 1, tpc: 0, flags: 0, health: 1 });
  sess.onMessage(buf, true, k * 50);
}
const perMsgUs = ((performance.now() - g0) / M) * 1000;

// ---- memory per player: a session + its movement history (the uWS socket itself is measured by the load test) ----
globalThis.gc?.();
const h0 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
const keep = [];
for (let k = 0; k < 10000; k++) { const s = new Session(gw, ws, '127.0.0.1', 0); s.mv = new Movement(gw.world); keep.push(s); }
globalThis.gc?.();
const h1 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
const perSession = (h1 - h0) / keep.length;

const out = {
  players: N, ticks: TICKS,
  hubTickMs: { mean: +mean(times).toFixed(2), p50: +q(times, 0.5).toFixed(2), p99: +q(times, 0.99).toFixed(2), max: +times[times.length - 1].toFixed(2), budgetPct: +((mean(times) / 50) * 100).toFixed(1) },
  stateWritesMsPerTick: +(simMs / (WARM + TICKS)).toFixed(2),
  encodedPerTick: { records: Math.round(records / TICKS), arenaKB: +(arenaBytes / TICKS / 1024).toFixed(1), recordsPerPlayerPerSec: +((records / TICKS) * 20 / N).toFixed(2) },
  perClientDownlink: { meanBps: Math.round(mean(perSec)), p50Bps: Math.round(q(perSec, 0.5)), p95Bps: Math.round(q(perSec, 0.95)), p99Bps: Math.round(q(perSec, 0.99)), maxBps: Math.round(perSec[perSec.length - 1]), meanMsgsPerSec: +mean(msgsPerSec).toFixed(1) },
  aoiPopulation: { near: Math.round(popNear / popN), far: Math.round(popFar / popN) },
  totalEgressGbit: +((mean(perSec) * N * 8) / 1e9).toFixed(2),
  hubEgressEstimateGbit: +((hub.egress * 8) / 1e9).toFixed(2), budgetScale: +hub.budgetScale.toFixed(2), dist: DIST,
  gatewayUsPerStateMsg: +perMsgUs.toFixed(2),
  memory: { sharedAndHubMB: +((memHub.rss - memBase.rss) / 1048576).toFixed(0), sessionBytes: Math.round(perSession) },
};
console.log(JSON.stringify(out, null, 1));
