// Headless check of the real-world (OSM) building massing: builds src/world/Buildings.js with and without
// public/data/irl.json and reports build time, triangles, NaNs, and exercises fracture / punch / colliders.
// Run: node tools/irl_check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buildings } from '../src/world/Buildings.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', f), 'utf8'));
const scene = { add() {} };

function tris(B) {
  let t = 0, nan = 0;
  for (const b of B.buckets.values()) {
    const g = b.mesh.geometry;
    t += g.index.count / 3;
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) nan++;
  }
  return { tris: t, nan };
}

function run(irl) {
  const data = { buildings: read('buildings.json'), irl };
  const t0 = performance.now();
  const B = new Buildings(data, null, scene);
  return { B, ms: performance.now() - t0, ...tris(B) };
}

const irl = fs.existsSync(path.join(ROOT, 'public', 'data', 'irl.json')) ? read('irl.json') : null;
// warm-up (JIT) then measure each variant twice
run(null); run(irl);
const a = [run(null), run(null)].sort((x, y) => x.ms - y.ms)[0];
const b = [run(irl), run(irl)].sort((x, y) => x.ms - y.ms)[0];
console.log(`without IRL: ${a.ms.toFixed(0)} ms, ${a.tris} tris, NaN ${a.nan}`);
console.log(`with IRL:    ${b.ms.toFixed(0)} ms, ${b.tris} tris (+${b.tris - a.tris}, IRL buildings ${b.B.stats.irl}, their tris ${b.B.stats.irlTris}), NaN ${b.nan}`);

// destruction + colliders on IRL buildings
const B = b.B;
const RAPIER = { ColliderDesc: { trimesh: (v, i) => ({ kind: 'trimesh', n: i.length / 3, v }), convexHull: (p) => ({ kind: 'hull', n: p.length / 3, p }) } };
const kinds = {};
let bad = 0, checked = 0;
for (const [id] of B.irl) {
  const r = B.recs[id];
  if (!r) continue;
  const d = B.colliderDesc(RAPIER, id);
  kinds[d.kind] = (kinds[d.kind] || 0) + 1;
  const arr = d.v || d.p;
  for (let i = 1; i < arr.length; i += 3) if (arr[i] > r.top + 60 || arr[i] < r.base - 5) { bad++; break; }
  checked++;
}
console.log('colliders', kinds, 'out of range', bad, '/', checked);
let fr = 0, punched = 0, support = 0;
const ids = [...B.irl.keys()].filter((id) => B.recs[id]).slice(0, 60);
for (const id of ids) {
  const f = B.fracture(id);
  if (!f) continue;
  fr++;
  const r = B.recs[id];
  const q = f.panels.find((p) => p.y < r.base + 3.4) || f.panels[0];
  if (!q) continue;
  punched += B.punch(id, { x: q.x, y: q.y, z: q.z }, 3).length;
  if (B.supportLost(id)) support++;
  const d = B.colliderDesc(RAPIER, id);
  if (d.kind !== 'trimesh') throw new Error('fractured collider should be a trimesh');
}
console.log(`fracture ok on ${fr}/${ids.length}, panels punched ${punched}, supportLost ${support}`);
