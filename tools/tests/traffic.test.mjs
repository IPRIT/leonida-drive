// Headless traffic soak test: spawns dense traffic, steps the simulation and reports overlaps between
// moving AI cars (cars passing through each other), stuck cars and one-way violations.
import fs from 'node:fs';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Roads } from '../../src/world/Roads.js';
import { Traffic } from '../../src/world/Traffic.js';

await RAPIER.init();
const roads = JSON.parse(fs.readFileSync('./public/data/roads.json'));
const terrain = { G: { urban: 7, paved: 8, building: 9, sport: 11, road: 10 }, heightAt: () => 0, groundAt: () => 7 };
const scene = new THREE.Scene();
const R = new Roads({ roads }, terrain, scene);
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const groups = (m, f) => ((m << 16) | f) >>> 0;
const T = new Traffic({ scene, roads: R, terrain, RAPIER, world, collisionGroups: groups(0x10, 0x4 | 0x20 | (process.env.NOCOL ? 0 : 0x10)), max: 80, game: null });
const cam = new THREE.PerspectiveCamera(62, 1.6, 0.3, 4000);
const focus = new THREE.Vector3(+(process.argv[2] ?? 1745), 0, +(process.argv[3] ?? -640));
cam.position.set(focus.x, 300, focus.z); cam.lookAt(focus.x, 0, focus.z + 1); cam.updateMatrixWorld();
const SECS = +(process.argv[4] ?? 90), dt = 1 / 60;
let overlaps = 0, worst = 0, frames = 0, wrongWay = 0, maxAgents = 0;
const pairs = new Set();
const t0 = performance.now();
for (let f = 0; f < SECS * 60; f++) {
  T.fixedUpdate(dt);
  world.step();
  T.postStep(dt);
  if (f % 2 === 0) {
    T.update(dt * 2, focus, cam, { position: null, velocity: null }, null);
    T.targetCount = T.max;
  }
  frames++;
  const A = T.agents.filter((a) => !a.crashed && !a.parked);
  maxAgents = Math.max(maxAgents, A.length);
  for (const a of A) if (a.mode === 'lane' && a.edge.oneway && a.dir !== a.edge.oneway) wrongWay++;
  if (f % 6) continue;
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    const a = A[i], b = A[j];
    const d = Math.hypot(a.cur.x - b.cur.x, a.cur.z - b.cur.z);
    if (Math.abs(a.cur.y - b.cur.y) > 3) continue;
    // centre distance smaller than the sum of half widths means the bodies interpenetrate for sure
    const minD = (a.type.baked.width + b.type.baked.width) * 0.45;
    if (d < minD && process.env.DEBUG && !pairs.has([a, b].map((x) => T.agents.indexOf(x)).join('-'))) {
      const info = (x) => ({ mode: x.mode, e: x.edge.i, dir: x.dir, lane: x.lane, s: +x.s.toFixed(1), len: +x.edge.len.toFixed(1), ow: x.edge.oneway, kind: x.edge.kind, v: +x.v.toFixed(1), res: x.res, end: T.endNode(x), turnTo: x.turn ? [x.turn.e.i, x.turn.dir, x.turn.lane] : null, err: +x.err.toFixed(2) });
      console.log('OVERLAP t=' + (f / 60).toFixed(1), d.toFixed(2), JSON.stringify(info(a)), JSON.stringify(info(b)));
    }
    if (d < minD) { overlaps++; worst = Math.max(worst, minD - d); pairs.add([a, b].map((x) => T.agents.indexOf(x)).join('-')); }
  }
}
const A = T.agents.filter((a) => !a.crashed && !a.parked);
const stuck = A.filter((a) => a.v < 0.2).length;
const stalled20 = A.filter((a) => (a.stall || 0) > 20).length;
const avgKmh = +(A.reduce((s2, a) => s2 + a.v, 0) / Math.max(1, A.length) * 3.6).toFixed(1);
console.log(JSON.stringify({ sim_s: SECS, wall_ms: Math.round(performance.now() - t0), maxAgents, alive: A.length, crashed: T.agents.filter((a) => a.crashed).length, lost: A.filter((a) => a.lost).length, stopped_at_end: stuck, stalled20, avgKmh, recycled: T._recycled || 0, overlapSamples: overlaps, overlapPairs: pairs.size, worstPenetration: +worst.toFixed(2), wrongWayFrames: wrongWay, holders: T.holders.size }));
