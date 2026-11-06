// Highway / ramp surface steps: ray-casts the game's road colliders (as tools/tests/roadprobe.test.mjs builds them)
// across the whole carriageway of every highway edge and reports height steps above 3 cm between neighbouring
// cross-sections or across ribbon / fill joins.
// Usage: node tools/tests/roadsteps.test.mjs [--edge N] [--near x,z,r] [--th 0.03] [--top N] [--json out.json]
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Terrain } from '../../src/world/Terrain.js';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const JSON_OUT = opt('--json', null);
const NEAR = opt('--near', null)?.split(',').map(Number);
const ONLY = opt('--edge', null);
const TH = +opt('--th', 0.03);
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


// ---- scan: highways and ramps, the whole carriageway ----
// Longitudinal rows at lateral offsets every 1.5 m across the ribbon (0.4 m inside each edge), samples every 0.5 m.
// A step is a jump between neighbouring samples beyond the local slope (longitudinal: along a row; lateral:
// between neighbouring rows at the same station, beyond the cross slope trend). Kerbs, parapets and other roads
// on the carriageway are left out: only this edge's ribbon / junction fills / joints count as its surface.
const H = 0.5, LAT = 1.5, LIFT = 0.07;
const sel = R.edges.filter((e) => (ONLY ? String(e.i) === ONLY : (args.includes('--all') || e.kind === 1) && !e.runway) && e.len >= 2 && !e.tunnel &&
  (!NEAR || e.pts.some((v, k) => k % 2 === 0 && Math.hypot(v - NEAR[0], e.pts[k + 1] - NEAR[1]) < NEAR[2])));
const steps = [];
let nS = 0, nMine = 0;
for (const e of sel) {
  const n = Math.max(2, Math.ceil(e.len / H) + 1);
  const vt = [];
  for (let k = 0; k < e.n; k++) {
    const k0 = Math.max(0, k - 1), k1 = Math.min(e.n - 1, k + 1);
    let tx = e.pts[2 * k1] - e.pts[2 * k0], tz = e.pts[2 * k1 + 1] - e.pts[2 * k0 + 1];
    const l = Math.hypot(tx, tz) || 1;
    vt.push([tx / l, tz / l]);
  }
  // stations
  const st = [];
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * e.len;
    const p = R.pointAt(e, s);
    const f = Math.max(0, Math.min(1, (s - e.cum[p.k]) / ((e.cum[p.k + 1] - e.cum[p.k]) || 1)));
    let tx = vt[p.k][0] * (1 - f) + vt[p.k + 1][0] * f, tz = vt[p.k][1] * (1 - f) + vt[p.k + 1][1] * f;
    const tl = Math.hypot(tx, tz) || 1;
    st.push({ s, x: p.x, z: p.z, y: p.y, w: p.w, nx: -tz / tl, nz: tx / tl });
  }
  const hwMax = Math.max(...st.map((q) => q.w)) / 2;
  const nr = Math.max(1, Math.floor((2 * hwMax - 0.8) / LAT) + 1);
  const grid = []; // [row][i] = {y, own} | null
  for (let r = 0; r < nr; r++) {
    const off = -hwMax + 0.4 + (nr === 1 ? hwMax - 0.4 : (r * (2 * hwMax - 0.8)) / (nr - 1));
    const row = [];
    for (const q of st) {
      if (Math.abs(off) > q.w / 2 - 0.4) { row.push(null); continue; }
      const x = q.x + q.nx * off, z = q.z + q.nz * off;
      const h = cast(x, q.y + 2.2, z, Q_ROAD, 4.4);
      nS++;
      if (!h) { row.push(null); continue; }
      const p = { x, z, yp: h.y, hitT: 'road' };
      const o = ownerOf(p);
      const mine = (o.part === 'ribbon' && (o.edge === e.i || R.edges[o.edge]?.internal)) || o.part === 'junction';
      if (mine) nMine++;
      row.push(mine ? { x, z, y: h.y, o } : null);
    }
    grid.push(row);
  }
  const ok = (r, i) => r >= 0 && r < nr && i >= 0 && i < n && grid[r][i];
  const fwd = (r, i) => {
    if (!ok(r, i) || !ok(r, i + 1)) return false;
    const A = grid[r][i], B = grid[r][i + 1], d = Math.hypot(B.x - A.x, B.z - A.z);
    return d > 0.15 && d < 1.5 && (B.x - A.x) * st[i].nz - (B.z - A.z) * st[i].nx > 0;
  };
  for (let r = 0; r < nr; r++) for (let i = 0; i < n; i++) {
    if (!ok(r, i)) continue;
    const Y = (rr, ii) => grid[rr][ii].y;
    // along the row (only where the row is a proper path: on a bend tighter than the offset the offset line
    // folds back on itself and neighbouring samples land metres apart on the inner edge)
    if (ok(r, i + 1) && ok(r, i - 2) && ok(r, i + 3) && [-2, -1, 0, 1, 2].every((d) => fwd(r, i + d))) {
      const d = Y(r, i + 1) - Y(r, i), ref = ((Y(r, i) - Y(r, i - 2)) + (Y(r, i + 3) - Y(r, i + 1))) / 4;
      if (Math.abs(d - ref) > TH) steps.push({ dir: 'long', edge: e.i, rp: e.rp, x: +grid[r][i].x.toFixed(1), z: +grid[r][i].z.toFixed(1), s: +st[i].s.toFixed(1), row: r, val: +(d - ref).toFixed(3), from: { x: grid[r][i].x, z: grid[r][i].z }, to: { x: grid[r][i + 1].x, z: grid[r][i + 1].z }, a: lab(grid[r][i].o), b: lab(grid[r][i + 1].o) });
    }
    // across, between neighbouring rows
    if (ok(r + 1, i) && ok(r - 1, i) && ok(r + 2, i)) {
      const d = Y(r + 1, i) - Y(r, i), ref = ((Y(r, i) - Y(r - 1, i)) + (Y(r + 2, i) - Y(r + 1, i))) / 2;
      if (Math.abs(d - ref) > TH) steps.push({ dir: 'lat', edge: e.i, rp: e.rp, x: +grid[r][i].x.toFixed(1), z: +grid[r][i].z.toFixed(1), s: +st[i].s.toFixed(1), row: r, val: +(d - ref).toFixed(3), from: { x: grid[r][i].x, z: grid[r][i].z }, to: { x: grid[r + 1][i].x, z: grid[r + 1][i].z }, a: lab(grid[r][i].o), b: lab(grid[r + 1][i].o) });
    }
  }
}
// spots: steps within 6 m of each other on one edge count once (the biggest)
steps.sort((a, b) => Math.abs(b.val) - Math.abs(a.val));
const spots = [];
for (const f of steps) if (!spots.some((q) => q.edge === f.edge && Math.hypot(q.x - f.x, q.z - f.z) < 6)) spots.push(f);
// A coarse residual also flags continuous changes of grade on banked bends.
// Optional 1 cm ray sweep distinguishes actual ledges from those creases.
const fillNodeAt = (x, z) => {
  const inside = (ring) => {
    let v = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[2] > z) !== (b[2] > z) && x < (b[0] - a[0]) * (z - a[2]) / (b[2] - a[2]) + a[0]) v = !v;
    }
    return v;
  };
  const fills = [];
  for (let ni = 0; ni < R.junctions.length; ni++) if (R.junctions[ni]) fills.push([ni, R.junctions[ni].ring]);
  for (const b of R.bends) fills.push([b.ni, b.ring]);
  for (const [ni, ring] of fills) if (inside(ring)) return ni;
  // Rounded dead-end caps are fills too, although they have no stored polygon.
  for (let ni = 0; ni < R.nodes.length; ni++) if (R.adj[ni].length === 1) {
    const n = R.nodes[ni], e = R.edges[R.adj[ni][0]];
    if (Math.hypot(x - n[0], z - n[1]) <= e.w / 2 + 0.5) return ni;
  }
  let best = null, bd = 0.25;
  for (const [ni, ring] of fills) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i], dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
    const d = Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t);
    if (d < bd) { bd = d; best = ni; }
  }
  return best;
};
if (args.includes('--refine')) for (const f of spots) {
  const e = R.edges[f.edge], p = R.pointAt(e, f.s), high = p.y + 3;
  const dx = f.to.x - f.from.x, dz = f.to.z - f.from.z, len = Math.hypot(dx, dz), n = Math.max(2, Math.ceil(len / 0.01));
  let prev = null, maxJump = 0;
  for (let k = 0; k <= n; k++) {
    const x = f.from.x + dx * k / n, z = f.from.z + dz * k / n;
    const q = cast(x, high, z, Q_ROAD, 6);
    if (q && prev !== null && Math.abs(q.y - prev.y) > maxJump) {
      maxJump = Math.abs(q.y - prev.y);
      f.jumpOwners = [ownerOf({ x: prev.x, z: prev.z, yp: prev.y, hitT: 'road' }), ownerOf({ x, z, yp: q.y, hitT: 'road' })].map(lab);
      f.jumpAt = [x, z];
    }
    prev = q ? { x, z, y: q.y } : null;
  }
  f.jump1cm = +maxJump.toFixed(4);
  if (f.jump1cm > TH) {
    f.fillNode = f.jumpAt ? fillNodeAt(f.jumpAt[0], f.jumpAt[1]) : null;
    f.foreignFill = f.fillNode !== null && f.fillNode !== R.edges[f.edge].a && f.fillNode !== R.edges[f.edge].b;
  }
}
const byEdge = {};
for (const f of spots) byEdge[f.edge] = (byEdge[f.edge] || 0) + 1;
const summary = { edges: sel.length, samples: nS, onSurface: nMine, stepSamples: steps.length, spots: spots.length, ramps: spots.filter((f) => f.rp).length,
  over10cm: spots.filter((f) => Math.abs(f.val) > 0.1).length, long: spots.filter((f) => f.dir === 'long').length, lat: spots.filter((f) => f.dir === 'lat').length,
  ...(args.includes('--refine') ? { verifiedSteps: spots.filter(f => f.jump1cm > TH && !f.foreignFill).length,
    foreignFillSteps: spots.filter(f => f.jump1cm > TH && f.foreignFill).length,
    continuousGradeChanges: spots.filter(f => f.jump1cm <= TH).length } : {}),
  ms: Math.round(performance.now() - t0) };
console.log(JSON.stringify(summary));
for (const f of spots.slice(0, +opt('--top', 25))) console.log(JSON.stringify(f));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, spots, byEdge }));
if (args.includes('--assert')) {
  if (!args.includes('--refine')) throw new Error('--assert requires --refine (coarse grade changes are not discontinuities)');
  if (summary.verifiedSteps) process.exitCode = 1;
}
