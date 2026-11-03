// Headless drive test: the game's own raycast-wheel car (src/vehicle/physics/VehiclePhysics.js) driven by a
// simple lane follower over the real colliders (terrain heightfield chunks + road trimesh buckets, exactly as
// streamed in the game) through given spots, with the VehicleManager safety net applied after every step.
// Reports per spot: vertical acceleration spikes of the body, airborne time, safety-net pops, lost runs.
// Usage:
//   node tools/tests/roaddrive.test.mjs --spots probe.json [--n 20] [--kmh 90]   worst lane spots of a probe run
//   node tools/tests/roaddrive.test.mjs --at x,z [--kmh 90]                       one spot
//   node tools/tests/roaddrive.test.mjs --corners N [--kmh 40] [--cut 2]           N junction corners (every
//        k-th junction, every pair of neighbouring arms 40-140 deg apart) driven cutting the corner: from one
//        arm's lane through a point --cut m outside the fill's rim between the two arms into the other arm
// Env: DATA=dir (default public/data), ROADS_JS=path of a Roads.js variant, LEGACY_NET=1 (old safety net).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Terrain } from '../../src/world/Terrain.js';
import { VehiclePhysics } from '../../src/vehicle/physics/VehiclePhysics.js';
import { GROUPS, groups } from '../../src/vehicle/groups.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = process.env.DATA || './public/data';
const { Roads } = await import(process.env.ROADS_JS ? path.resolve(process.env.ROADS_JS) : '../../src/world/Roads.js');
const KMH = +opt('--kmh', 90);
const DT = 1 / 60;
const SETTLE = 1.5;

await RAPIER.init();
const gz = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
const world = JSON.parse(fs.readFileSync(`${DIR}/world.json`));
const roads = JSON.parse(fs.readFileSync(`${DIR}/roads.json`));
const hb = gz(fs.readFileSync(`${DIR}/height.bin`));
const gb = gz(fs.readFileSync(`${DIR}/ground.bin`));
// optional junction shapes from the source map (tools/junction_shapes.py), loaded by the game too (src/core/data.js)
const junctions = fs.existsSync(`${DIR}/junctions.json`) ? JSON.parse(fs.readFileSync(`${DIR}/junctions.json`)) : null;
const data = { junctions, world, roads, heights: new Int16Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.byteLength)), groundTex: new Uint8Array(gb) };
const T = new Terrain(data, new THREE.Scene());
const R = new Roads(data, T, new THREE.Scene());
const W = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
W.timestep = DT;
if (W.integrationParameters) W.integrationParameters.numSolverIterations = 6;
const G_GROUND = groups(GROUPS.GROUND, 0xffff);
const cx = (T.x0 + T.x1) / 2, cz = (T.z0 + T.z1) / 2;
T.updateColliders(RAPIER, W, cx, cz, 30000, G_GROUND);
R.updateColliders(RAPIER, W, cx, cz, 30000, G_GROUND, 1e9);
// colliders stream in (src/world/colliderStream.js: only the nearest are built at once): build them all now
while (T.colStream?.step(1e9, true));
while (R.colStream?.step(1e9, true));
W.step();
const env = { waterLevel: 0, getSurface: () => ({ name: 'asphalt', grip: 1, rolling: 0, dust: false }) };
const netRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
const NET_GROUPS = (((0xffff) << 16) | GROUPS.GROUND) >>> 0;

// VehicleManager.postStep (current, or LEGACY_NET=1: the old centreline-height test)
function safetyNet(b) {
  const t = b.translation();
  let ground = null;
  if (process.env.LEGACY_NET) {
    let g = T.heightAt(t.x, t.z);
    const n = R.nearest(t.x, t.z, 12);
    if (n?.edge.tunnel && n.dist < n.edge.w / 2 + 2) g = n.y + 0.07;
    else if (n && n.dist < n.edge.w / 2 + 0.5 && Math.abs(n.y - t.y) < 4) g = Math.max(g, n.y + 0.07);
    if (g < -0.5 || t.y >= g + 0.12) return false;
    ground = g;
  } else {
    netRay.origin.x = t.x; netRay.origin.y = t.y + 1.2; netRay.origin.z = t.z;
    const hit = W.castRay(netRay, 1.18, true, undefined, NET_GROUPS, undefined, b);
    if (hit) ground = t.y + 1.2 - hit.timeOfImpact;
    else {
      const h = T.heightAt(t.x, t.z);
      if (h < -0.5 || t.y > h - 0.3) return false;
      netRay.origin.y = t.y;
      if (W.castRay(netRay, 3, true, undefined, NET_GROUPS, undefined, b)) return false;
      ground = h;
    }
  }
  b.setTranslation({ x: t.x, y: ground + 0.95, z: t.z }, true);
  const lv = b.linvel();
  if (lv.y < 0) b.setLinvel({ x: lv.x * 0.8, y: 0, z: lv.z * 0.8 }, true);
  return true;
}

// lane route through (x, z): back 220 m and ahead 220 m along the straightest continuation, right-hand lane
function route(x, z, heading) {
  const nn = R.nearest(x, z, 60, args.includes('--airside') ? undefined : (e) => !e.airside);
  if (!nn) return null;
  const e0 = nn.edge;
  const s0 = e0.cum[nn.seg] + nn.t * (e0.cum[nn.seg + 1] - e0.cum[nn.seg]);
  let dir = 1;
  if (heading) dir = nn.dir[0] * heading[0] + nn.dir[1] * heading[1] >= 0 ? 1 : -1;
  const walk = (e, s, d, len) => {
    const out = [];
    let left = len;
    for (let guard = 0; guard < 40 && left > 0; guard++) {
      const end = d > 0 ? e.len : 0;
      const step = Math.min(left, Math.abs(end - s));
      for (let u = 0; u <= step; u += 2) { const p = R.pointAt(e, s + d * u); out.push({ x: p.x, z: p.z, y: p.y, w: p.w, tx: p.tx * d, tz: p.tz * d }); }
      left -= step;
      if (left <= 0) break;
      const ni = d > 0 ? e.b : e.a;
      const din = R.armDir(e, ni);
      let best = null, bc = -0.5;
      for (const ei of R.adj[ni]) {
        const f = R.edges[ei];
        if (f === e) continue;
        const df = R.armDir(f, ni);
        const c = -(din[0] * df[0] + din[1] * df[1]);
        if (c > bc) { bc = c; best = f; }
      }
      if (!best) break;
      d = best.a === ni ? 1 : -1;
      s = d > 0 ? 0 : best.len;
      e = best;
    }
    return out;
  };
  const back = walk(e0, s0, -dir, 220).reverse().map((p) => ({ ...p, tx: -p.tx, tz: -p.tz }));
  const ahead = walk(e0, s0, dir, 220);
  const pts = [...back, ...ahead];
  // right-hand lane: offset to the right of travel by a quarter of the width
  return pts.map((p) => ({ x: p.x - p.tz * p.w * 0.25, z: p.z + p.tx * p.w * 0.25, y: p.y }));
}

function drive(x, z, kmh, heading, given) {
  const P = given || route(x, z, heading);
  if (!P || P.length < 40) return { skipped: true };
  const p0 = P[0], p1 = P[3];
  const yaw = Math.atan2(-(p1.x - p0.x), -(p1.z - p0.z));
  const car = new VehiclePhysics({ RAPIER, world: W, preset: 'comet', position: { x: p0.x, y: p0.y + 0.1, z: p0.z }, yaw, env });
  const target = kmh / 3.6;
  // start rolling at speed
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  car.body.setLinvel({ x: fx * target, y: 0, z: fz * target }, true);
  for (const w of car.wheels) w.omega = target / w.radius;
  let k = 0, vyPrev = 0, maxUp = 0, maxDown = 0, maxAir = 0, airEvents = 0, pops = 0, lost = false, worstAt = null, t = 0;
  const acc = [];
  while (k < P.length - 12 && t < 40) {
    const b = car.body, q = b.rotation(), pos = b.translation(), lv = b.linvel();
    // progress + pure pursuit
    let bd = 1e9;
    for (let j = Math.max(0, k - 5); j < Math.min(P.length, k + 30); j++) { const d = Math.hypot(P[j].x - pos.x, P[j].z - pos.z); if (d < bd) { bd = d; k = j; } }
    if (bd > 12) { lost = true; if (process.env.DEBUG) console.log('lost at', pos.x.toFixed(1), pos.z.toFixed(1), 'k', k, 'P', P[k].x.toFixed(1), P[k].z.toFixed(1), 't', t.toFixed(1)); break; }
    const v = Math.hypot(lv.x, lv.z);
    const tgt = P[Math.min(P.length - 1, k + Math.max(4, Math.round((v * 0.55) / 2)))];
    const f = { x: -(2 * (q.x * q.z + q.w * q.y)), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) };
    const dx = tgt.x - pos.x, dz = tgt.z - pos.z;
    const lat = dx * -f.z + dz * f.x, lon = dx * f.x + dz * f.z;
    const steer = Math.max(-1, Math.min(1, Math.atan2(lat, Math.max(1, lon)) * 2.2));
    // slow for the bends ahead (lateral <= 5 m/s^2), like a driver would
    let vt = target;
    for (let j = k + 2; j < Math.min(P.length - 2, k + 40); j++) {
      const ax = P[j].x - P[j - 2].x, az = P[j].z - P[j - 2].z, bx = P[j + 2].x - P[j].x, bz = P[j + 2].z - P[j].z;
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      const curv = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)))) / ((la + lb) / 2);
      const dist = Math.hypot(P[j].x - pos.x, P[j].z - pos.z);
      vt = Math.min(vt, Math.sqrt(5 / Math.max(curv, 1e-5) + 2 * 6 * dist * 0.5));
    }
    const input = { throttle: v < vt ? Math.min(1, (vt - v) / 4) : 0, brake: v > vt + 1 ? Math.min(1, (v - vt) / 6) : 0, steer, handbrake: false, boost: false, driver: true };
    car.fixedUpdate(DT, input);
    W.step();
    if (safetyNet(car.body)) pops++;
    t += DT;
    const vy = car.body.linvel().y;
    const a = (vy - vyPrev) / DT;
    vyPrev = vy;
    acc.push(a);
    if (acc.length > 3) acc.shift();
    if (t > SETTLE) { // the first 1.5 s settle the spawn (dropped at speed onto a slope it can bounce)
      const am = acc.reduce((s, x) => s + x, 0) / acc.length; // 50 ms average: ignore single-step solver noise
      if (am > maxUp) {
        maxUp = am;
        const nr = R.nearest(pos.x, pos.z, 30);
        worstAt = { x: +pos.x.toFixed(0), z: +pos.z.toFixed(0), offLane: +bd.toFixed(1), offRoad: nr ? +(nr.dist - nr.edge.w / 2).toFixed(1) : null, kmh: +(v * 3.6).toFixed(0) };
      }
      maxDown = Math.min(maxDown, am);
    }
    if (t > SETTLE && car.airTime > maxAir) maxAir = car.airTime;
    if (process.env.TRACE && (car.airTime > 0 || Math.abs(a) > 15)) { const p2 = car.body.translation(); console.log('trace t', t.toFixed(2), 'pos', p2.x.toFixed(1), p2.y.toFixed(2), p2.z.toFixed(1), 'vy', vy.toFixed(2), 'air', car.airTime.toFixed(2), 'a', a.toFixed(1), 'contacts', car.wheels.map((w) => (w.contact ? 1 : 0)).join('')); }
    if (t > SETTLE && car.airTime > 0.15 && car.airTime - DT <= 0.15) airEvents++;
  }
  car.dispose?.();
  return { kmh, maxUpG: +(maxUp / 9.81).toFixed(2), maxDownG: +(-maxDown / 9.81).toFixed(2), maxAir: +maxAir.toFixed(2), airEvents, pops, lost, worstAt, s: +t.toFixed(1) };
}

// corner-cutting path at junction ni between neighbouring arms A -> B: 40 m in on A's lane, a quadratic curve through
// a point `cut` m outside the rim chord between the arms' corners, 40 m out on B's lane
function cornerPath(ni, A, B, cut) {
  const J = R.junctions[ni];
  const lane = (a, s, out) => {
    const e = a.e, d = a.fromA ? 1 : -1, s0 = a.fromA ? 0 : e.len;
    const p = R.pointAt(e, Math.max(0, Math.min(e.len, s0 + d * s)));
    // direction of travel: towards the node on the way in, away from it on the way out
    const tx = p.tx * d * (out ? 1 : -1), tz = p.tz * d * (out ? 1 : -1);
    return { x: p.x - tz * p.w * 0.25, z: p.z + tx * p.w * 0.25, y: p.y };
  };
  const tA = R.trims[A.e.i][A.fromA ? 0 : 1]?.t || 0, tB = R.trims[B.e.i][B.fromA ? 0 : 1]?.t || 0;
  if (A.e.len < tA + 45 || B.e.len < tB + 45) return null;
  const fa = R.endFrame[A.e.i][A.fromA ? 0 : 1], fb = R.endFrame[B.e.i][B.fromA ? 0 : 1];
  if (!fa || !fb) return null;
  // the corners of the two end rows that face each other (closest pair)
  let best = null;
  for (const ca of [fa.l, fa.r]) for (const cb of [fb.l, fb.r]) { const d = Math.hypot(ca[0] - cb[0], ca[2] - cb[2]); if (!best || d < best.d) best = { d, ca, cb }; }
  const mx = (best.ca[0] + best.cb[0]) / 2, mz = (best.ca[2] + best.cb[2]) / 2;
  let ox = mx - J.center[0], oz = mz - J.center[2];
  const ol = Math.hypot(ox, oz) || 1;
  const apex = { x: mx + (ox / ol) * cut, z: mz + (oz / ol) * cut };
  const P = [];
  for (let s = tA + 45; s >= tA + 6; s -= 2) P.push(lane(A, s, false));
  const a0 = P[P.length - 1], b0 = lane(B, tB + 6, true);
  // quadratic through the apex at t = 0.5: control = 2 apex - (a0 + b0) / 2
  const cx = 2 * apex.x - (a0.x + b0.x) / 2, cz = 2 * apex.z - (a0.z + b0.z) / 2;
  const L = Math.hypot(apex.x - a0.x, apex.z - a0.z) + Math.hypot(b0.x - apex.x, b0.z - apex.z);
  const n = Math.max(4, Math.ceil(L / 2));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    P.push({ x: (1 - t) * (1 - t) * a0.x + 2 * (1 - t) * t * cx + t * t * b0.x, z: (1 - t) * (1 - t) * a0.z + 2 * (1 - t) * t * cz + t * t * b0.z, y: a0.y });
  }
  for (let s = tB + 6; s <= tB + 45; s += 2) P.push(lane(B, s, true));
  return P;
}
const spots = [];
if (opt('--corners', null)) {
  const N = +opt('--corners'), CUT = +opt('--cut', 2);
  const cands = [];
  R.junctions.forEach((J, ni) => {
    if (!J || J.allArms.length < 3 || J.allArms.some((a) => a.e.lifted || a.e.tunnel || a.e.internal)) return;
    const arms = J.allArms, n = arms.length;
    for (let i = 0; i < n; i++) {
      const A = arms[i], B = arms[(i + 1) % n];
      let gap = B.ang - A.ang;
      if (gap <= 0) gap += 2 * Math.PI;
      if (gap < 0.7 || gap > 2.45) continue;
      cands.push([ni, A, B]);
    }
  });
  if (opt('--node', null)) cands.splice(0, cands.length, ...cands.filter((c) => c[0] === +opt('--node')));
  const step = Math.max(1, Math.floor(cands.length / N));
  const res = [];
  for (let c = 0; c < cands.length && res.length < N; c += step) {
    const [ni, A, B] = cands[c];
    for (const [X, Y] of [[A, B], [B, A]]) {
      const P = cornerPath(ni, X, Y, CUT);
      if (!P) continue;
      const r = drive(0, 0, KMH, null, P);
      res.push({ node: ni, at: R.nodes[ni].map(Math.round), arms: [X.e.i, Y.e.i], kerbs: R.sidewalkWidth(X.e) > 0 || R.sidewalkWidth(Y.e) > 0, ...r });
    }
  }
  // corners with sidewalks are cut over a 14 cm kerb (a kerb strike, not a fall): reported apart
  for (const [name, set] of [['open corners', res.filter((r) => !r.skipped && !r.kerbs)], ['kerbed corners', res.filter((r) => !r.skipped && r.kerbs)]]) {
    const bad = set.filter((r) => r.maxUpG > 1.5 || r.maxAir > 0.25 || r.pops);
    console.log(JSON.stringify({ [name]: set.length, hard: bad.length, worstUpG: set.length ? Math.max(...set.map((r) => r.maxUpG)) : 0, over1g: set.filter((r) => r.maxUpG > 1).length, airEvents: set.reduce((s, r) => s + r.airEvents, 0), pops: set.reduce((s, r) => s + r.pops, 0), lost: set.filter((r) => r.lost).length }));
  }
  for (const r of res.sort((a, b) => b.maxUpG - a.maxUpG)) console.log(JSON.stringify(r));
  process.exit(0);
}
// --forks N [--nodes a,b,..]: real cars through N Y forks (three arms, two of them < 75 deg apart), every movement
// between the arms in the right-hand lane: in 40 m on one arm, through the node on a quadratic, out 40 m on the other.
// A hole in the fork's surface shows up as a fall: safety-net pops, airtime, a hard landing (maxDownG / maxUpG)
if (opt('--forks', null)) {
  const N = +opt('--forks');
  const want = opt('--nodes', null)?.split(',').map(Number);
  const cands = [];
  R.junctions.forEach((J, ni) => {
    if (!J || J.allArms.length !== 3 || J.allArms.some((a) => a.e.lifted || a.e.tunnel || a.e.internal || a.e.a === a.e.b)) return;
    if (want && !want.includes(ni)) return;
    const A = J.allArms;
    let fork = false;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (A[i].dx * A[j].dx + A[i].dz * A[j].dz > Math.cos(75 * Math.PI / 180)) fork = true;
    if (fork || want) cands.push(ni);
  });
  const step = want ? 1 : Math.max(1, Math.floor(cands.length / N));
  const lanePt = (a, s, out) => {
    const e = a.e, d = a.fromA ? 1 : -1, s0 = a.fromA ? 0 : e.len;
    const p = R.pointAt(e, Math.max(0, Math.min(e.len, s0 + d * s)));
    const tx = p.tx * d * (out ? 1 : -1), tz = p.tz * d * (out ? 1 : -1);
    return { x: p.x - tz * p.w * 0.25, z: p.z + tx * p.w * 0.25, y: p.y };
  };
  const res = [];
  for (let c = 0; c < cands.length && res.length < N * 6; c += step) {
    const ni = cands[c], J = R.junctions[ni], [nx, nz] = R.nodes[ni];
    for (const A of J.allArms) for (const B of J.allArms) {
      if (A === B || A.e.len < 50 || B.e.len < 50) continue;
      if (!R.allowedFrom(A.e, A.fromA ? A.e.b : A.e.a) || !R.allowedFrom(B.e, B.fromA ? B.e.a : B.e.b)) continue;
      const P = [];
      for (let s = 45; s >= 6; s -= 2) P.push(lanePt(A, s, false));
      const a0 = P[P.length - 1], b0 = lanePt(B, 6, true);
      for (let i = 1; i < 8; i++) { const t = i / 8; P.push({ x: (1 - t) * (1 - t) * a0.x + 2 * (1 - t) * t * nx + t * t * b0.x, z: (1 - t) * (1 - t) * a0.z + 2 * (1 - t) * t * nz + t * t * b0.z, y: a0.y }); }
      for (let s = 6; s <= 45; s += 2) P.push(lanePt(B, s, true));
      const r = drive(0, 0, KMH, null, P);
      if (!r.skipped) res.push({ node: ni, at: [Math.round(nx), Math.round(nz)], arms: [A.e.i, B.e.i], ...r });
    }
  }
  const bad = res.filter((r) => r.pops || r.airEvents || r.lost || r.maxDownG > 1.2 || r.maxUpG > 1.5);
  console.log(JSON.stringify({ forks: new Set(res.map((r) => r.node)).size, runs: res.length, bad: bad.length, pops: res.reduce((s, r) => s + r.pops, 0), airEvents: res.reduce((s, r) => s + r.airEvents, 0), lost: res.filter((r) => r.lost).length, worstUpG: Math.max(0, ...res.map((r) => r.maxUpG)), worstDownG: Math.max(0, ...res.map((r) => r.maxDownG)) }));
  for (const r of res.sort((a, b) => b.maxUpG - a.maxUpG).slice(0, 12)) console.log(JSON.stringify(r));
  process.exit(0);
}
if (opt('--at', null)) {
  const [x, z, hx, hz] = opt('--at').split(',').map(Number);
  spots.push({ x, z, heading: Number.isFinite(hx) ? [hx, hz] : null });
} else {
  const d = JSON.parse(fs.readFileSync(opt('--spots', '/tmp/probe.json')));
  const N = +opt('--n', 20);
  const seen = [];
  for (const s of d.spots) {
    const w = s.worst;
    if (w.path || w.cls === 'grade') continue;
    if (seen.some((q) => Math.hypot(q.x - s.x, q.z - s.z) < 150)) continue;
    seen.push(s);
    spots.push({ x: s.x, z: s.z, cls: w.cls, heading: null });
    if (spots.length >= N) break;
  }
}
const res = [];
for (const s of spots) {
  for (const hd of s.heading ? [s.heading] : [null, 'rev']) {
    let heading = hd;
    if (hd === 'rev') { const nn = R.nearest(s.x, s.z, 60); heading = nn ? [-nn.dir[0], -nn.dir[1]] : null; }
    const r = drive(s.x, s.z, KMH, heading);
    res.push({ at: [s.x, s.z], cls: s.cls, ...r });
  }
}
const ok = res.filter((r) => !r.skipped);
const bad = ok.filter((r) => r.maxUpG > 1.0 || r.maxAir > 0.25 || r.pops || r.lost);
console.log(JSON.stringify({ runs: ok.length, bumpy: bad.length, worstUpG: Math.max(...ok.map((r) => r.maxUpG)), totalAirEvents: ok.reduce((s, r) => s + r.airEvents, 0), totalPops: ok.reduce((s, r) => s + r.pops, 0), lost: ok.filter((r) => r.lost).length }));
for (const r of res) console.log(JSON.stringify(r));
