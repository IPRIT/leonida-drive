// Drivable-surface probe. Rebuilds exactly the colliders the game streams (terrain heightfield chunks + road
// trimesh buckets with junction fills, kerbs, parapets and tunnel walls) for the whole map with Rapier, then
// ray-casts down along every road like a wheel does: both lane centres of every edge plus paths through every
// junction, at 0.75 m steps. Reports, ranked by severity:
//   step   vertical step > 3 cm between neighbouring samples (seams: ribbon / junction fill / disc / deck / kerb)
//   crest  convex kink that launches a car below its design speed (vertical accel > 1 g)
//   sag    concave kink that slams the suspension (> 1.5 g at design speed)
//   poke   terrain heightfield above the asphalt inside the carriageway (wheels ride the terrain)
//   gap    no road surface where the carriageway should be and the ground below it
//   grade  > 10 % over 10 m
//   net    VehicleManager.postStep safety net would teleport a car resting there
//   foreign another road's surface (or a kerb) on this lane at a different height
// Usage: node tools/tests/roadprobe.test.mjs [--top N] [--json out.json] [--near x,z,r]
// DATA=dir overrides public/data; ROADS_JS=path probes another Roads.js; LEGACY_NET=1 the old safety net.
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Terrain } from '../../src/world/Terrain.js';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TOP = +opt('--top', 30);
const JSON_OUT = opt('--json', null);
const NEAR = opt('--near', null)?.split(',').map(Number);
const DIR = process.env.DATA || './public/data';

// ROADS_JS=path: probe another Roads.js (e.g. the pre-fix version for before/after numbers)
const { Roads } = await import(process.env.ROADS_JS ? path.resolve(process.env.ROADS_JS) : '../../src/world/Roads.js');
await RAPIER.init();
const t0 = performance.now();
const gz = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
const world = JSON.parse(fs.readFileSync(`${DIR}/world.json`));
const roads = JSON.parse(fs.readFileSync(`${DIR}/roads.json`));
const hb = gz(fs.readFileSync(`${DIR}/height.bin`));
const gb = gz(fs.readFileSync(`${DIR}/ground.bin`));
// optional junction shapes from the source map (tools/junction_shapes.py), loaded by the game too (src/core/data.js)
const junctions = fs.existsSync(`${DIR}/junctions.json`) ? JSON.parse(fs.readFileSync(`${DIR}/junctions.json`)) : null;
const data = { junctions, world, roads, heights: new Int16Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.byteLength)), groundTex: new Uint8Array(gb) };

// ---- record which ribbon owns which triangle range of each physics bucket ----
const own = new Map(); // bucket object -> [[t0, t1, edge], ...]
const origRibbon = Roads.prototype.ribbon;
Roads.prototype.ribbon = function (e, bget, lit) {
  const touched = new Map();
  const bg = (x, z) => { const b = bget(x, z); if (!touched.has(b)) touched.set(b, b.idx.length); return b; };
  origRibbon.call(this, e, bg, lit);
  for (const [b, s] of touched) if (b.idx.length > s) { if (!own.has(b)) own.set(b, []); own.get(b).push([s / 3, b.idx.length / 3, e.i]); }
};
const scene = new THREE.Scene();
const T = new Terrain(data, scene);
const R = new Roads(data, T, scene);
Roads.prototype.ribbon = origRibbon;
const tBuild = performance.now() - t0;

// ---- physics world with everything streamed in (exactly the game's colliders) ----
const W = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const grp = (m, f) => (((m & 0xffff) << 16) | (f & 0xffff)) >>> 0;
const cx = (T.x0 + T.x1) / 2, cz = (T.z0 + T.z1) / 2;
T.updateColliders(RAPIER, W, cx, cz, 30000, grp(0x1, 0xffff));
R.updateColliders(RAPIER, W, cx, cz, 30000, grp(0x2, 0xffff), 1e9);
// colliders stream in (src/world/colliderStream.js: only the nearest are built at once): build them all now
while (T.colStream?.step(1e9, true));
while (R.colStream?.step(1e9, true));
const kindOf = new Map();
for (const [, c] of T.colliders) kindOf.set(c.handle, 'terrain');
for (const [, c] of R.colliders) kindOf.set(c.handle, 'road');
W.step();
// label world: the same road triangles split per part (Rapier does not report trimesh triangle ids), used to
// name what a ray hit: ribbon of edge N, junction / joint fill, kerb + sidewalk (+ tunnel wall), bridge parapet,
// embankment apron
const LW = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const labelOf = new Map();
for (const [b, list] of own) {
  const pb = R.physBuckets.get(b.key);
  if (!pb) continue;
  const nIdx = b.idx.length / 3, nKerb = (b.kidx?.length || 0) / 3, nAll = pb.idx.length / 3, nApron = pb.nApron || 0;
  const ribEnd = Math.max(...list.map((r) => r[1]));
  const parts = list.map(([a, c, e]) => [a, c, { part: 'ribbon', edge: e }]);
  parts.push([ribEnd, nIdx, { part: 'junction' }], [nIdx, nIdx + nKerb, { part: 'kerb' }], [nIdx + nKerb, nAll - nApron, { part: 'parapet' }], [nAll - nApron, nAll, { part: 'apron' }]);
  for (const [a, c, lab] of parts) {
    if (c <= a) continue;
    const col = LW.createCollider(RAPIER.ColliderDesc.trimesh(pb.verts, pb.idx.slice(a * 3, c * 3)));
    labelOf.set(col.handle, lab);
  }
}
LW.step();
const Q_ALL = grp(0xffff, 0x3), Q_ROAD = grp(0xffff, 0x2);
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
function cast(x, y, z, groups, maxToi = 9, w = W) {
  ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
  const h = w.castRay(ray, maxToi, true, undefined, groups);
  if (!h) return null;
  return { y: y - h.timeOfImpact, c: w === W ? kindOf.get(h.collider.handle) : labelOf.get(h.collider.handle) };
}
// what the wheel stands on at a sample: terrain / ribbon of edge N / junction / kerb / parapet / none
function ownerOf(p) {
  if (p.own) return p.own;
  if (!Number.isFinite(p.yp)) return (p.own = { part: 'none' });
  if (p.hitT === 'terrain') return (p.own = { part: 'terrain' });
  const h = cast(p.x, p.yp + 0.02, p.z, undefined, 0.08, LW);
  return (p.own = h?.c || { part: 'road?' });
}
const lab = (o) => `${o.part}${o.edge !== undefined ? '#' + o.edge : ''}`;

// ---- sampling paths ----
const H = 0.75;
const LIFT = 0.07;
const G = 9.81;
const vDesign = (kind) => (kind === 1 ? 33.3 : kind === 2 ? 15 : 25);
const paths = [];
const inNear = (x, z) => !NEAR || Math.hypot(x - NEAR[0], z - NEAR[1]) < NEAR[2];
for (const e of R.edges) {
  if (e.len < 2) continue;
  const n = Math.max(2, Math.ceil(e.len / H) + 1);
  // vertex tangents (average of the adjacent segments), interpolated along each segment: a continuous lane line
  // like the one a car follows (offsetting by the raw segment normal would jump sideways at every vertex)
  const vt = [];
  for (let k = 0; k < e.n; k++) {
    const k0 = Math.max(0, k - 1), k1 = Math.min(e.n - 1, k + 1);
    let tx = e.pts[2 * k1] - e.pts[2 * k0], tz = e.pts[2 * k1 + 1] - e.pts[2 * k0 + 1];
    const l = Math.hypot(tx, tz) || 1;
    vt.push([tx / l, tz / l]);
  }
  for (const side of [-1, 1]) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const s = (i / (n - 1)) * e.len;
      const p = R.pointAt(e, s);
      const f = Math.max(0, Math.min(1, (s - e.cum[p.k]) / ((e.cum[p.k + 1] - e.cum[p.k]) || 1)));
      let tx = vt[p.k][0] * (1 - f) + vt[p.k + 1][0] * f, tz = vt[p.k][1] * (1 - f) + vt[p.k + 1][1] * f;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const off = side * p.w * 0.25; // lane centre (half of the half-width)
      pts.push({ x: p.x - tz * off, z: p.z + tx * off, yd: p.y, s, edge: e.i });
    }
    if (pts.some((p) => inNear(p.x, p.z))) paths.push({ type: 'lane', e, kind: e.kind, v: vDesign(e.kind), pts, deadA: R.adj[e.a].length === 1, deadB: R.adj[e.b].length === 1 });
  }
}
// junction crossings: from every arm's inbound lane to every other arm's outbound lane (quadratic through the node)
let nJ = 0;
for (let ni = 0; ni < R.nodes.length; ni++) {
  const inc = R.adj[ni].filter((ei) => R.edges[ei].a !== R.edges[ei].b);
  if (inc.length < 3) continue;
  const [nx, nz] = R.nodes[ni];
  if (!inNear(nx, nz)) continue;
  nJ++;
  const arms = inc.map((ei) => {
    const e = R.edges[ei];
    const fromA = e.a === ni;
    const d = Math.min(e.len * 0.5, (R.trims?.[ei]?.[fromA ? 0 : 1]?.t || 0) + 6);
    const p = R.pointAt(e, fromA ? d : e.len - d);
    const dx = fromA ? p.tx : -p.tx, dz = fromA ? p.tz : -p.tz; // pointing away from the node
    return { e, p, dx, dz, hw: p.w / 2 };
  });
  for (const A of arms) for (const B of arms) {
    if (A === B) continue;
    // inbound on A: right-hand lane when driving towards the node = left of the outward direction
    const ax = A.p.x - A.dz * A.hw * 0.5 * -1, az = A.p.z + A.dx * A.hw * 0.5 * -1;
    const bx = B.p.x + B.dz * B.hw * 0.5 * -1, bz = B.p.z - B.dx * B.hw * 0.5 * -1;
    const straight = A.dx * B.dx + A.dz * B.dz < -0.7;
    const L = Math.hypot(bx - ax, bz - az) + 4;
    const n = Math.max(3, Math.ceil(L / H) + 1);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * nx + t * t * bx;
      const z = (1 - t) * (1 - t) * az + 2 * (1 - t) * t * nz + t * t * bz;
      const yd = (1 - t) * A.p.y + t * B.p.y + 2 * t * (1 - t) * (R.nodeY[ni] - (A.p.y + B.p.y) / 2);
      pts.push({ x, z, yd, s: t * L, node: ni });
    }
    const kind = Math.max(A.e.kind, B.e.kind);
    paths.push({ type: straight ? 'cross' : 'turn', node: ni, kind, v: straight ? vDesign(Math.min(A.e.kind, B.e.kind)) : 12, pts });
  }
}

// ---- cast + analyse ----
const flags = []; // {cls, x, z, y, sev, val, why, edge?, node?}
const water = { edges: new Set(), samples: 0, holes: 0, below: 0, steps: 0, bad: [] };
let nSamples = 0, nCasts = 0, narrowSeamSamples = 0;
const flag = (cls, p, sev, val, why, extra = {}) => flags.push({ cls, x: +p.x.toFixed(1), z: +p.z.toFixed(1), y: +(p.yp ?? p.yd).toFixed(2), sev: +sev.toFixed(2), val: +val.toFixed(3), why, ...extra });
const near = (x, z) => R.nearest(x, z, 12);
for (const path of paths) {
  const P = path.pts;
  for (const p of P) {
    const top = p.yd + 2.2;
    const all = cast(p.x, top, p.z, Q_ALL); nCasts++;
    const road = all?.c === 'road' ? all : cast(p.x, top, p.z, Q_ROAD); nCasts++;
    p.yp = all ? all.y : NaN;
    p.hitT = all?.c;
    p.road = road;
    p.ter = T.heightAt(p.x, p.z);
    // the ground the physics has here (differs from the drawn one only over tunnels: Terrain.physOverride)
    const tp = cast(p.x, top, p.z, grp(0xffff, 0x1));
    p.terP = tp ? tp.y : p.ter;
    nSamples++;
  }
  const n = P.length;
  // turning paths are approximate: samples that clip a corner kerb are ignored, not reported
  if (path.type === 'turn') for (const p of P) if (p.hitT === 'road' && Math.abs(p.yp - p.yd - LIFT) > 0.06 && ownerOf(p).part === 'kerb') p.yp = NaN;
  // the last 2.5 m of a dead end (the rounded cap: a car leaving it drives onto the ground) is not ride surface
  const capped = (i) => path.type === 'lane' && ((path.deadA && P[i].s < 2.5) || (path.deadB && path.e.len - P[i].s < 2.5));
  const ok = (i) => i >= 0 && i < n && Number.isFinite(P[i].yp) && !capped(i);
  const tag = path.type === 'lane' ? { edge: path.e.i, kind: path.kind } : { node: path.node, kind: path.kind, path: path.type };
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const tip = path.type === 'lane' && ((path.deadA && p.s < 1.5) || (path.deadB && path.e.len - p.s < 1.5));
    // gap: no asphalt here and the ground is clearly below the design surface
    if (!tip && path.type !== 'turn') {
      const r = p.road;
      // (a road surface a few dm below the centreline profile is a tilted junction plane, not a hole)
      if ((!r || r.y < p.yd - 0.8) && p.hitT !== 'road' && (!Number.isFinite(p.yp) || p.yp < p.yd + LIFT - 0.06)) {
        // Rapier can miss an exact shared float32 edge. Verify both sides of
        // a 4 mm span before calling a single-ray miss a hole in the road.
        let seam = false;
        for (const [dx, dz] of [[0.002, 0], [0, 0.002]]) {
          const a = cast(p.x - dx, p.yd + 2.2, p.z - dz, Q_ROAD);
          const b = cast(p.x + dx, p.yd + 2.2, p.z + dz, Q_ROAD);
          nCasts += 2;
          if (a && b && Math.min(a.y, b.y) >= p.yd - 0.8 && Math.abs(a.y - b.y) < 0.03) { seam = true; break; }
        }
        if (seam) narrowSeamSamples++;
        else flag('gap', p, Math.min(10, (p.yd + LIFT - (Number.isFinite(p.yp) ? p.yp : p.yd - 2)) / 0.05), p.yd + LIFT - (p.yp || 0), 'no road surface', tag);
      }
    }
    // poke: terrain above the asphalt
    if (p.road && p.terP > p.road.y - 0.005 && p.terP - p.road.y < 3) flag('poke', p, (p.terP - p.road.y + 0.005) / 0.03, p.terP - p.road.y, 'terrain above asphalt', tag);
    // foreign surface on the lane (another edge's ribbon / kerb / parapet) at a different height than ours
    if (path.type !== 'turn' && p.hitT === 'road' && Math.abs(p.yp - (p.yd + LIFT)) > 0.03) {
      const o = ownerOf(p);
      // junction paths run over the fill and the arms of their own node
      // (a cluster link is plain asphalt on its junctions' planes: fill surface, wherever it shows)
      const fill = o.part === 'ribbon' && R.edges[o.edge]?.internal;
      const mine = path.type === 'lane' ? (o.part === 'ribbon' && o.edge === path.e.i) || (fill && [path.e.a, path.e.b].some((n) => R.edges[o.edge].a === n || R.edges[o.edge].b === n)) : o.part === 'junction' || (o.part === 'ribbon' && R.adj[path.node].includes(o.edge));
      if (!mine && o.part !== 'junction') flag('foreign', p, Math.abs(p.yp - p.yd - LIFT) / 0.03, p.yp - p.yd - LIFT, `${lab(o)} on lane`, tag);
    }
    // safety net (VehicleManager.postStep) for a small car resting here: origin = surface + wheel radius 0.32.
    // LEGACY_NET=1 simulates the old centreline-based test.
    if (path.type === 'lane' && Number.isFinite(p.yp) && i % 2 === 0) {
      const oy = p.yp + 0.32;
      if (process.env.LEGACY_NET) {
        let ground = p.ter;
        const nn = near(p.x, p.z);
        if (nn?.edge.tunnel && nn.dist < nn.edge.w / 2 + 2) ground = nn.y + 0.07;
        else if (nn && nn.dist < nn.edge.w / 2 + 0.5 && Math.abs(nn.y - oy) < 4) ground = Math.max(ground, nn.y + 0.07);
        if (ground >= -0.5 && oy < ground + 0.12) flag('net', p, 10, ground + 0.12 - oy, `safety net pops car (nearest edge ${nn?.edge.i} y ${nn ? nn.y.toFixed(2) : '-'})`, tag);
      } else {
        const h = cast(p.x, oy + 1.2, p.z, Q_ALL, 1.18);
        let pop = h ? h.y : null;
        if (pop === null && p.ter >= -0.5 && oy < p.ter - 0.3 && !cast(p.x, oy, p.z, Q_ALL, 3)) pop = p.ter;
        if (pop !== null) flag('net', p, 10, pop + 0.12 - oy, `safety net pops car (surface ${pop.toFixed(2)} above the wheels' ${p.yp.toFixed(2)})`, tag);
      }
    }
    // step between neighbouring samples relative to the local slope
    if (ok(i) && ok(i + 1) && ok(i - 2) && ok(i + 3)) {
      const d = P[i + 1].yp - P[i].yp;
      const ref = ((P[i].yp - P[i - 2].yp) + (P[i + 3].yp - P[i + 1].yp)) / 4;
      const st = d - ref;
      if (Math.abs(st) > 0.03) flag('step', P[i], Math.abs(st) / 0.03, st, `${lab(ownerOf(P[i]))} -> ${lab(ownerOf(P[i + 1]))}`, tag);
    }
    // kinks over 3 m and 9 m baselines: vertical acceleration at the design speed
    for (const k of [4, 12]) {
      if (!(ok(i - k) && ok(i + k) && ok(i))) continue;
      const B = k * H;
      const g1 = (P[i].yp - P[i - k].yp) / B, g2 = (P[i + k].yp - P[i].yp) / B;
      const curv = (g2 - g1) / B;
      const acc = path.v * path.v * curv;
      if (acc < -G) flag('crest', P[i], -acc / G, g2 - g1, `grade ${(g1 * 100).toFixed(1)}% -> ${(g2 * 100).toFixed(1)}% over ${B} m; airborne above ${(Math.sqrt(G / -curv) * 3.6).toFixed(0)} km/h (${lab(ownerOf(P[i]))})`, tag);
      else if (acc > 1.5 * G) flag('sag', P[i], acc / (1.5 * G), g2 - g1, `grade ${(g1 * 100).toFixed(1)}% -> ${(g2 * 100).toFixed(1)}% over ${B} m; ${(acc / G).toFixed(1)} g at ${(path.v * 3.6).toFixed(0)} km/h (${lab(ownerOf(P[i]))})`, tag);
    }
    if (path.type === 'lane' && ok(i - 7) && ok(i + 7) && i % 4 === 0) {
      const gr = (P[i + 7].yp - P[i - 7].yp) / (14 * H);
      if (Math.abs(gr) > 0.1) flag('grade', P[i], Math.abs(gr) / 0.1, gr, `grade ${(gr * 100).toFixed(1)}%${path.e.tunnel ? ' (tunnel)' : ''}`, tag);
    }
  }
  // water crossings (sea / canal under the lane: terrain below the 0 m water plane)
  if (path.type === 'lane') {
    let wet = 0, holeRun = 0, holes = 0, below = 0, steps = 0;
    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (p.ter >= 0) { holeRun = 0; continue; }
      wet++;
      const surf = p.road ? p.road.y : NaN;
      if (!(surf > -1e9)) { holeRun += H; if (holeRun > 1.0 && holeRun - H <= 1.0) holes++; } else holeRun = 0;
      if (surf > -1e9 && surf < 0.3) below++;
      if (i + 1 < n && P[i + 1].ter < 0 && ok(i) && ok(i + 1) && ok(i - 2) && ok(i + 3)) {
        const st = P[i + 1].yp - P[i].yp - ((P[i].yp - P[i - 2].yp) + (P[i + 3].yp - P[i + 1].yp)) / 4;
        if (Math.abs(st) > 0.03) steps++;
      }
    }
    if (wet) {
      water.edges.add(path.e.i);
      water.samples += wet; water.holes += holes; water.below += below; water.steps += steps;
      if (holes || below) water.bad.push({ edge: path.e.i, x: +P[0].x.toFixed(0), z: +P[0].z.toFixed(0), holes, below });
    }
  }
  for (const p of P) { p.road = null; p.own = null; }
}

// dead ends of the graph that stop over water / on a bridge deck (a bridge that does not reach the other bank)
let deadWet = 0;
const deadWetList = [];
for (let ni = 0; ni < R.nodes.length; ni++) {
  if (R.adj[ni].length !== 1) continue;
  const e = R.edges[R.adj[ni][0]];
  const k = e.a === ni ? 0 : e.n - 1;
  const [x, z] = R.nodes[ni];
  if (inNear(x, z) && ((e.br && e.br[k]) || T.heightAt(x, z) < 0)) { deadWet++; deadWetList.push([Math.round(x), Math.round(z), e.i]); }
}
water.deadEnds = deadWet;

// ---- cluster into spots (15 m cells), rank ----
const CLS = ['step', 'crest', 'sag', 'poke', 'gap', 'grade', 'net', 'foreign'];
const spots = new Map();
for (const f of flags) {
  const key = `${Math.round(f.x / 15)},${Math.round(f.z / 15)}`;
  let s = spots.get(key);
  if (!s) spots.set(key, (s = { x: f.x, z: f.z, y: f.y, sev: 0, n: 0, cls: {}, worst: null }));
  s.n++;
  s.cls[f.cls] = Math.max(s.cls[f.cls] || 0, f.sev);
  if (f.sev > s.sev) { s.sev = f.sev; s.worst = f; s.x = f.x; s.z = f.z; s.y = f.y; }
}
const list = [...spots.values()].sort((a, b) => b.sev - a.sev);
const byCls = {};
for (const c of CLS) {
  const fl = flags.filter((f) => f.cls === c);
  const cells = new Set(fl.map((f) => `${Math.round(f.x / 15)},${Math.round(f.z / 15)}`));
  byCls[c] = { samples: fl.length, spots: cells.size, severe: new Set(fl.filter((f) => f.sev >= 2).map((f) => `${Math.round(f.x / 15)},${Math.round(f.z / 15)}`)).size };
}
const summary = {
  narrowSeamSamples,
  highwayLaneGaps: flags.filter((f) => f.cls === 'gap' && f.kind === 1 && f.edge !== undefined).length,
  build_ms: Math.round(tBuild), probe_ms: Math.round(performance.now() - t0 - tBuild), paths: paths.length, junctions: nJ, samples: nSamples, casts: nCasts,
  badSpots: list.length, severeSpots: list.filter((s) => s.sev >= 2).length, byClass: byCls,
  water: { crossingEdges: water.edges.size, laneSamplesOverWater: water.samples, holesOver1m: water.holes, belowWaterSamples: water.below, deckSteps: water.steps, deadEndsOverWater: water.deadEnds },
};
console.log(JSON.stringify(summary));
console.log('worst spots:');
for (const s of list.slice(0, TOP)) {
  const w = s.worst;
  console.log(`  ${w.cls.padEnd(7)} sev ${String(s.sev).padStart(6)} at (${s.x}, ${s.z}) y ${s.y}  ${w.why}  [${w.edge !== undefined ? 'edge ' + w.edge + ' kind ' + w.kind : 'node ' + w.node + ' ' + w.path}] also: ${Object.entries(s.cls).filter(([c]) => c !== w.cls).map(([c, v]) => c + ' ' + v.toFixed(1)).join(', ')}`);
}
if (deadWetList.length) console.log('dead ends over water:', JSON.stringify(deadWetList.slice(0, 20)));
if (water.bad.length) console.log('water-crossing lanes with holes / low deck:', JSON.stringify(water.bad.slice(0, 12)));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, spots: list, flags, water: water.bad }));
if (args.includes('--assert-highways') && (summary.highwayLaneGaps || water.holes || water.below)) process.exitCode = 1;
