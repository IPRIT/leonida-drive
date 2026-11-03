// Real collision surfaces at every planned crossing: clear driving space below
// the bridge, and separate route nodes for the two levels.
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { worldFixture } from './world-fixture.mjs';

await RAPIER.init();
const { roads: r } = worldFixture();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
r.updateColliders(RAPIER, world, 0, 0, 30000, 0xffffffff);
while (r.colStream?.step(1e9, true));
world.step();
const hit = (x, y, z) => {
  const p = world.castRay(new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }), 5, true);
  return p ? y - p.timeOfImpact : null;
};
let samples = 0, minimum = Infinity;
const failures = [];
for (const c of r.overpasses) {
  assert.notEqual(c.ni, c.nj);
  assert.ok(!r.adj[c.ni].some((id) => r.adj[c.nj].includes(id)), 'crossing levels share an edge');
  const [ux, uz] = c.dir;
  const upperW = Math.min(...r.adj[c.nj].map((i) => r.edges[i].w)) / 2;
  const lowerW = Math.min(...r.adj[c.ni].map((i) => r.edges[i].w)) / 2;
  const [vx, vz] = r.armDir(r.edges[r.adj[c.ni][0]], c.ni);
  for (const s of [-0.6, 0, 0.6]) for (const t of [-0.6, 0, 0.6]) {
    const x = c.x + ux * lowerW * s - uz * upperW * t;
    const z = c.z + uz * lowerW * s + ux * upperW * t;
    if (Math.abs((x - c.x) * -vz + (z - c.z) * vx) > lowerW * 0.75) continue;
    const upper = hit(x, r.nodeY[c.nj] + 2, z), lower = hit(x, r.nodeY[c.ni] + 2, z);
    const clearance = upper === null || lower === null ? -1 : upper - lower - 1.35;
    samples++;
    minimum = Math.min(minimum, clearance);
    if (clearance < 4.7) failures.push({ node: c.ni, x, z, upper, lower, clearance });
  }
}
world.free();
console.log(JSON.stringify({ crossings: r.overpasses.length, samples, minimumClearance: minimum, failures }));
assert.ok(r.overpasses.length > 0, 'no separated crossings');
assert.equal(failures.length, 0, 'a crossing has missing pavement or insufficient vehicle clearance');
