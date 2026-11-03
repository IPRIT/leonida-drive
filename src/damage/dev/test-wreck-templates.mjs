// Headless checks for AI-traffic wreck templates (node src/damage/dev/test-wreck-templates.mjs).
// Every traffic model: bake metadata covers the geometry, the split template keeps the surface (area), lamps / glass /
// panels are found, the shared jitter equals the Deformer's own, and a removed panel stays collapsed under later dents.
import * as THREE from 'three';
import { VEHICLE_CATALOG } from '../../vehicle/catalog.js';
import { bakeVehicle } from '../../vehicle/bake.js';
import { templateJob } from '../TrafficWreck.js';
import { Deformer } from '../Deformer.js';

const area = (p) => {
  let s = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    s += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
  }
  return s;
};

let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };
const ids = VEHICLE_CATALOG.filter((e) => (e.trafficWeight ?? 1) > 0).map((e) => e.id);
const tris = [], ms = [];
for (const id of ids) {
  const baked = bakeVehicle(id);
  const n = baked.geo.attributes.position.count;
  check(!baked.groups || baked.groups.reduce((s, g) => s + g.count, 0) === n, `${id}: bake groups cover the geometry`);
  const t0 = performance.now();
  const gen = templateJob(id, baked);
  let r;
  do r = gen.next(); while (!r.done);
  ms.push(performance.now() - t0);
  const tpl = r.value;
  tris.push(tpl.tris);
  const a0 = area(baked.geo.attributes.position.array), a1 = area(tpl.pos);
  check(Math.abs(a1 - a0) / a0 < 1e-3, `${id}: split keeps the surface (${a0.toFixed(2)} vs ${a1.toFixed(2)} m²)`);
  check(tpl.lamps.length > 0, `${id}: lamps found`);
  if (baked.kind === 'car') check(tpl.parts.length > 0 && tpl.glass.length > 0, `${id}: panels and glass found`);
}
// jitter + collapse on one model
{
  const baked = bakeVehicle('pickup');
  const gen = templateJob('pickup', baked);
  let r;
  do r = gen.next(); while (!r.done);
  const tpl = r.value;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(tpl.pos.slice(), 3));
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ flatShading: true }));
  root.add(mesh);
  const own = new Deformer(root, [mesh]);
  own.warm(1e9);
  let d = 0;
  for (let i = 0; i < tpl.jit.length; i++) d = Math.max(d, Math.abs(tpl.jit[i] - own.entries[0].jit[i]));
  check(d === 0, 'template jitter equals the Deformer jitter');
  const def = new Deformer(root, [mesh]);
  def.setBins(mesh, tpl.bins, tpl.range, tpl.jit);
  const part = tpl.parts.find((p) => p.key === 'frontBumper') || tpl.parts[0];
  const verts = new Int32Array(part.tris.length * 3);
  part.tris.forEach((t, i) => { verts[i * 3] = t * 3; verts[i * 3 + 1] = t * 3 + 1; verts[i * 3 + 2] = t * 3 + 2; });
  def.collapse(mesh, verts, part.center);
  def.deform(part.center.clone(), new THREE.Vector3(0, 0, 1), 1.5, 0.3);
  const p = mesh.geometry.attributes.position.array;
  let spread = 0;
  for (let i = 0; i < verts.length; i += 3) {
    const a = verts[i] * 3, b = verts[i + 1] * 3, c = verts[i + 2] * 3;
    spread = Math.max(spread, Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]), Math.hypot(p[a] - p[c], p[a + 1] - p[c + 1], p[a + 2] - p[c + 2]));
  }
  check(spread < 1e-6, `removed panel stays collapsed after a dent (spread ${spread})`);
  check(tpl.jit[verts[0] * 4] === own.entries[0].jit[verts[0] * 4] && def.entries[0].jit !== tpl.jit, 'shared template jitter untouched (copy-on-write)');
}
tris.sort((a, b) => a - b);
ms.sort((a, b) => a - b);
console.log(`${ids.length} models: template triangles median ${tris[tris.length >> 1]}, max ${tris.at(-1)}; build median ${ms[ms.length >> 1].toFixed(1)} ms (node)`);
console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
