// Headless checks for full-vehicle damage (node src/damage/dev/test-vehicle-damage.mjs):
// refinement of coarse bodies (triangles, surface kept, panels / materials kept, time slices), dent smoothness,
// carjack restore on a refined body, and the explosion ignition curve.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle } from '../../vehicle/Vehicle.js';
import { VehicleDamage, igniteChance } from '../VehicleDamage.js';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const scene = new THREE.Scene();
const sys = { game: { time: 0, events: null, fx: null }, stats: {}, brokenLampMat: new THREE.MeshStandardMaterial(), _remove() {} };
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };

const area = (p) => {
  let s = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    s += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
  }
  return s;
};
const nonIndexed = (g) => (g.index ? g.toNonIndexed() : g).attributes.position.array;
const spawn = (id) => new Vehicle({ RAPIER, world, scene, preset: id, position: new THREE.Vector3(0, 0, 0), spotLights: false });
const moved = (st) => {
  let n = 0;
  for (const e of st.deformer.entries) {
    const p = e.attr.array, o = e.orig;
    for (let i = 0; i < p.length; i += 3) if (Math.hypot(p[i] - o[i], p[i + 1] - o[i + 1], p[i + 2] - o[i + 2]) > 0.01) n++;
  }
  return n;
};

const rows = [];
for (const id of ['comet', 'muscle', 'super', 'suv', 'pickup', 'cruiser', 'meridian', 'saam', 'box_truck', 'city_bus']) {
  const v = spawn(id);
  const st = new VehicleDamage(sys, v);
  const before = st.deformer.entries.map((e) => ({ mesh: e.mesh, parent: e.mesh.parent, mat: e.mesh.material, tris: nonIndexed(e.geo).length / 9, area: area(nonIndexed(e.geo)) }));
  // background: 0.5 ms slices, one swap per frame
  let frames = 0, maxSlice = 0;
  while (st._refine && frames < 5000) {
    const t0 = performance.now();
    st._stepRefine(0.5);
    maxSlice = Math.max(maxSlice, performance.now() - t0);
    frames++;
  }
  const after = st.deformer.entries.map((e) => ({ tris: nonIndexed(e.geo).length / 9, area: area(nonIndexed(e.geo)), parent: e.mesh.parent, mat: e.mesh.material, geo: e.mesh.geometry === e.geo }));
  let tb = 0, ta = 0, areaErr = 0, kept = true;
  before.forEach((b, i) => {
    tb += b.tris; ta += after[i].tris;
    areaErr = Math.max(areaErr, Math.abs(after[i].area - b.area) / Math.max(1e-6, b.area));
    kept &&= after[i].parent === b.parent && after[i].mat === b.mat && after[i].geo;
  });
  check(areaErr < 1e-3, `${id}: refinement keeps the surface (${areaErr})`);
  check(kept, `${id}: meshes keep their part group and material`);
  // a 60 km/h-ish frontal dent
  const pl = new THREE.Vector3(0, 0.2, st.bbox.min.z + 0.05), dl = new THREE.Vector3(0, 0, 1);
  st._dent(pl, dl, 0.36);
  rows.push({ id, tris: `${tb} -> ${ta}`, frames, maxSliceMs: +maxSlice.toFixed(2), refineMs: +(st._refineMs || 0).toFixed(1), dentVerts: moved(st) });
  st.dispose();
  v.dispose();
}
console.table(rows);

// carjack: a pickup dented at ~70 km/h (energy 0.45 at the front) restored on a fresh, unrefined vehicle
{
  const snap = { impacts: [{ p: [0, 0.62, -2.58], d: [0, 0, 1], e: 0.45, s: 0 }], lamps: [], glass: 0, parts: [], engine: 0.85, body: 0.7 };
  const v = spawn('pickup');
  const st = new VehicleDamage(sys, v);
  const t0 = performance.now();
  st.restore(snap, v.spec.wheelRadius);
  const ms = performance.now() - t0;
  const n = moved(st);
  check(n > 600, `carjacked pickup keeps a visible dent (${n} vertices moved)`);
  console.log(`carjack restore on pickup: ${n} vertices moved (was 117 on the coarse body), ${ms.toFixed(1)} ms incl. synchronous refinement`);
  st.dispose();
  v.dispose();
}

// explosion ignition: chance vs power and distance (radius = 10 + 7·sqrt(power))
const R = (p) => 10 + 7 * Math.sqrt(Math.max(0.1, p));
const chance = (p, d) => igniteChance(p * Math.pow(Math.max(0, 1 - d / R(p)), 1.2));
const table = [];
for (const [what, p] of [['debris pop 0.2', 0.2], ['small 0.5', 0.5], ['car 1.0', 1], ['truck 1.6', 1.6]]) {
  table.push({ blast: what, '1 m': chance(p, 1).toFixed(2), '3 m': chance(p, 3).toFixed(2), '6 m': chance(p, 6).toFixed(2), '9 m': chance(p, 9).toFixed(2), '12 m': chance(p, 12).toFixed(2) });
}
console.table(table);
check(chance(0.2, 6) < 0.05, 'weak blast a few metres away rarely ignites');
check(chance(1, 1.5) === 1, 'a car bomb next to the car always ignites');
console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
