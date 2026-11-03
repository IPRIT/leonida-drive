// Headless destruction checks (real Rapier, no WebGL): node src/damage/test-destruction.mjs
// Covers the fracture state machine against Buildings.js (colliderDesc / damage / punch / supportLost / remove in every
// state: merged, fractured, partly collapsed, evicted + rebuilt, removed), explosions next to buildings while colliders
// stream, collapses (blocks -> debris -> rubble) and the per-event budgets.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Buildings } from '../world/Buildings.js';
import { Destruction } from './Destruction.js';
import { Debris } from '../fx/Debris.js';
import { GROUPS, groups } from '../vehicle/groups.js';

await RAPIER.init();
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  FAIL', msg); } };
const section = (s) => console.log(`- ${s}`);

// ---------- a small synthetic city ----------
const rect = (cx, cz, w, d) => [cx - w / 2, cz - d / 2, cx + w / 2, cz - d / 2, cx + w / 2, cz + d / 2, cx - w / 2, cz + d / 2];
const list = [];
for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
  const tower = (i + j) % 7 === 3 || (i === 5 && j === 3);
  list.push({ p: rect(i * 45, j * 45, tower ? 26 : 14 + (i % 3) * 6, tower ? 22 : 11 + (j % 2) * 7), y: 0, h: tower ? 96 : 7 + ((i * 3 + j) % 4) * 3.6, s: tower ? 2 : [0, 1, 3, 4, 5][(i + j) % 5], f: 3 });
}
// IRL-style multi-part building (podium + setback tower)
const irlIdx = list.length;
list.push({ p: rect(300, 0, 30, 24), y: 0, h: 60, s: 5, f: 16 });
const irl = { b: [{ i: irlIdx, c: [300, 0], m: 'L1', h: 60, s: 5, parts: [{ p: rect(300, 0, 30, 24), h: 14 }, { p: rect(300, 0, 16, 12), h: 60 }] }] };

const scene = new THREE.Scene();
const B = new Buildings({ buildings: list, irl }, null, scene);
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;
const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setCollisionGroups(groups(GROUPS.GROUND)), gb);
const events = { l: new Map(), on(n, f) { (this.l.get(n) || this.l.set(n, []).get(n)).push(f); return () => {}; }, emit(n, p) { for (const f of this.l.get(n) || []) f(p); } };
const game = {
  RAPIER, world, scene, events, time: 0, frame: 0, buildings: B,
  camera: new THREE.PerspectiveCamera(),
  player: { focus: new THREE.Vector3(100, 0, 60) },
  terrain: { heightAt: () => 0 },
  uniforms: {},
};
game.camera.position.set(100, 10, 60);
// FX stand-in: the real physics debris pool, everything visual is a no-op
const noop = () => {};
game.quality = { debrisMax: 150 };
game.fx = {
  debrisSys: null, chunks: { emit: noop }, sparkSys: { emit: noop }, puffs: { emit: noop },
  decals: { groundY: () => 0, addGround: noop, addWall: noop },
  _lodAt: () => 1, _floorFast: () => 0, dust: noop, bits: noop, sparks: noop, glass: noop, hit: noop, smoke: noop,
  flash: noop, addShake: noop, wallScorch: noop, leaves: noop, debris: noop,
};
game.fx.debrisSys = new Debris(game);
const sys = { byHandle: new Map(), vehicles: [], brokenLampMat: null, agentHit() {} };
const D = new Destruction(game, sys);
const F = D.fracturer;
const STATIC = groups(GROUPS.STATIC, 0xffff);
const stream = () => B.updateColliders(RAPIER, world, game.player.focus.x, game.player.focus.z, 350, STATIC, 5000);
const tick = (n = 1) => {
  for (let i = 0; i < n; i++) {
    game.time += 1 / 60; game.frame++;
    world.step();
    D.update(1 / 60);
    if (i % 20 === 0) stream();
  }
};
const legacyCalls = (id, punch = true) => {
  // every Buildings.js entry point that touches r.frac must survive the current state
  // (punch on a merged building starts a legacy fracture: only used where the new one can't be built)
  B.colliderDesc(RAPIER, id);
  B.damage(id, 0.001);
  if (punch || B.recs[id].frac) B.punch(id, { x: B.recs[id].cx, y: 2, z: B.recs[id].cz }, 2);
  B.supportLost(id);
  B.info(id);
};
const guard = (name, fn) => { try { fn(); } catch (e) { fails++; console.log('  FAIL', name, e.stack?.split('\n').slice(0, 3).join(' | ')); } };
stream();

// ---------- 1. state machine ----------
section('fracture state machine');
guard('states', () => {
  const id = 1;
  B.colliderDesc(RAPIER, id); B.damage(id, 0.001); B.supportLost(id); // merged (punch would start a legacy fracture)
  const fb = F.get(id);
  ok(fb && B.recs[id].frac === fb && fb.external, 'fractured object installed');
  ok(B.colliderDesc(RAPIER, id) === null, 'Buildings does not build a collider for an external fracture');
  legacyCalls(id); // fractured
  ok(B.recs[id].frac === fb, 'legacy punch/damage keep the external fracture');
  fb.ensureColliders(true);
  ok(fb.parts.some((p) => p.collider), 'fracture colliders exist');
  const cell = fb.activateCell(0, fb.regionOf(fb.edges[0].ax, fb.edges[0].az));
  ok(cell?.panels.length > 0, 'cell built with panels');
  for (const p of cell.panels.slice(0, 3)) fb.knock(p);
  fb.flush();
  ok(fb.rec.out.size === 3, 'knocked panels recorded');
  legacyCalls(id);
  // eviction restores the merged mesh, the record survives, rebuild re-applies it
  fb.dispose(true);
  ok(!B.recs[id].frac, 'evicted: merged original back');
  legacyCalls(id, false);
  ok(B.colliderDesc(RAPIER, id) !== null, 'evicted: Buildings builds its own collider again');
  const fb2 = F.get(id);
  tick(5); // damaged cells come back over the next frames
  ok(fb2 && fb2.rec.out.size === 3 && fb2.parts.length >= 2 && fb2.parts.some((p) => p.panels?.some((q) => q.out)), 'rebuilt with persisted damage');
  // removal in the fractured state
  B.remove(id);
  ok(fb2.disposed && fb2.parts.length === 0, 'remove disposes the fracture');
  legacyCalls(id);
  ok(F.get(id) === null, 'no fracture of a removed building');
});

// ---------- 2. impacts + structure ----------
section('impacts, partial and full collapse');
guard('impacts', () => {
  const id = list.findIndex((o, i) => o.h < 13 && B.recs[i] && !B.recs[i].removed && i > 2);
  const info = B.info(id);
  const fb = F.get(id);
  const p = { x: fb.edges[0].ax + fb.edges[0].dx * 0.5 + fb.edges[0].nx * 0.3, y: 0.7, z: fb.edges[0].az + fb.edges[0].dz * 0.5 + fb.edges[0].nz * 0.3 };
  const t0 = performance.now();
  D._impact(id, { J: 20000, point: p, normal: { x: fb.edges[0].nx, y: 0, z: fb.edges[0].nz }, vel: { x: -fb.edges[0].nx * 28, y: 0, z: -fb.edges[0].nz * 28 }, body: null, mass: 1400 });
  const ms = performance.now() - t0;
  ok(fb.rec.out.size > 0, `100 km/h ram knocks out wall panels (${fb.rec.out.size})`);
  ok(fb.rec.glass.size > 0, `and shatters panes (${fb.rec.glass.size})`);
  console.log(`  impact processing ${ms.toFixed(2)} ms (cold)`);
  // take out the ground storey: the building has to come down
  for (const part of fb.parts) for (const q of part.panels || []) if (q.ground) fb.knock(q);
  for (let k = 0; k < fb.nRegions; k++) fb.ensureAround({ x: fb.regionCenter(k).x, y: 1, z: fb.regionCenter(k).z }, 12);
  for (const part of fb.parts) for (const q of part.panels || []) if (q.ground) fb.knock(q);
  fb.flush();
  D._structure(id, fb, info, { x: 1, z: 0 }, 1);
  ok(D._state(id, info).collapsing, 'ground storey gone -> collapse started');
  tick(240);
  ok(B.recs[id].removed, 'small building fully collapsed');
  legacyCalls(id);
});

guard('partial collapse of a big building', () => {
  const id = list.findIndex((o, i) => o.h > 90 && B.recs[i] && !B.recs[i].removed);
  const info = B.info(id);
  const fb = F.get(id);
  ok(fb.nRegions > 1, `tower has ${fb.nRegions} structural regions`);
  const corner = 0;
  const c = fb.regionCenter(corner);
  fb.ensureAround({ x: c.x, y: 1, z: c.z }, 14);
  for (const part of fb.parts) for (const q of part.panels || []) if (q.ground && q.region === corner) fb.knock(q);
  fb.flush();
  D._structure(id, fb, info, { x: 1, z: 0 }, 1);
  const st = D._state(id, info);
  ok(!st.collapsing && st.pending.has(corner), 'one corner gone -> partial collapse, tower stands');
  tick(30);
  legacyCalls(id);
  tick(400);
  ok(fb.rec.failed.has(corner) && !B.recs[id].removed, 'corner section dropped, rest standing');
  ok(D.collapses.records.length > 0, `rubble piles baked (${D.collapses.records.length})`);
  legacyCalls(id);
});

// ---------- 2b. middle storeys: whatever is above a destroyed storey must come down ----------
section('mid-storey loss (no floating floors)');
guard('mid storey', () => {
  const towers = list.map((o, i) => i).filter((i) => list[i].h > 90 && B.recs[i] && !B.recs[i].removed && !F.records.has(i));
  // (a) one storey high up taken out in a single region -> that region's whole stack drops, the rest stands
  const id = towers[0];
  if (id === undefined) throw new Error('no fresh tower');
  const info = B.info(id);
  const fb = F.get(id);
  const storeyY = fb.base + 9.5 * fb.fh; // storey 9
  const k = 0;
  const c = fb.regionCenter(k);
  fb.ensureAround({ x: c.x, y: storeyY, z: c.z }, 14);
  let n = 0;
  for (const part of fb.parts) for (const q of part.panels || []) if (q.region === k && fb.edges[q.e].rowStorey[q.r] === 9) { fb.knock(q); n++; }
  fb.flush();
  ok(n > 0, `knocked ${n} panels of storey 9 in region ${k}`);
  ok(fb.failStorey(k, 0.45, 0.35) === 9, 'storey 9 reported as the failing storey');
  D._structure(id, fb, info, { x: 1, z: 0 }, 1);
  const st = D._state(id, info);
  ok(st.pending.has(k) && !st.collapsing, 'region above the gap is collapsing (partial), tower stands');
  tick(420);
  ok(fb.rec.failed.has(k) && !B.recs[id].removed, 'region stack removed: no floating block above the gap');
  // (b) "one column left": all but one bay of a storey gone across every region -> the whole tower comes down
  const id2 = towers.find((x) => x !== id && B.recs[x] && !B.recs[x].removed) ?? null;
  const ids = id2 === null ? [] : [id2];
  for (const t of ids) {
    const info2 = B.info(t), fb2 = F.get(t);
    const y = fb2.base + 5.5 * fb2.fh;
    for (let r = 0; r < fb2.nRegions; r++) { const cc = fb2.regionCenter(r); fb2.ensureAround({ x: cc.x, y, z: cc.z }, 14); }
    const ps = [];
    for (const part of fb2.parts) for (const q of part.panels || []) if (fb2.edges[q.e].rowStorey[q.r] === 5) ps.push(q);
    ps.slice(1).forEach((q) => fb2.knock(q)); // one bay (column) left standing
    fb2.flush();
    D._structure(t, fb2, info2, { x: 1, z: 0 }, 1);
    ok(D._state(t, info2).collapsing, `storey 5 down to one column (${ps.length - 1}/${ps.length} gone) -> full collapse`);
    tick(500);
    ok(B.recs[t].removed, 'nothing left floating: tower removed, debris baked');
  }
  if (!ids.length) console.log('  (only one tower in the synthetic city: one-column case skipped)');
});

// ---------- 4. legacy fracture (Buildings.punch on a merged building) ----------
section('legacy fracture path');
guard('legacy', () => {
  const id = list.findIndex((o, i) => B.recs[i] && !B.recs[i].removed && !B.recs[i].frac && !F.records.has(i));
  if (id < 0) throw new Error('no untouched building left');
  const gone = B.punch(id, { x: B.recs[id].cx, y: 2, z: B.recs[id].cz }, 30);
  ok(B.recs[id].frac && !B.recs[id].frac.external, `legacy fracture made by punch (${gone.length} panels)`);
  ok(F.get(id) === null, 'fracturer leaves a legacy fracture alone');
  legacyCalls(id);
  D._impact(id, { J: 30000, point: { x: B.recs[id].cx, y: 1, z: B.recs[id].cz }, normal: { x: 1, y: 0, z: 0 }, vel: { x: -25, y: 0, z: 0 }, body: null, mass: 1400 });
  tick(60);
  legacyCalls(id);
});

// ---------- 3. explosions next to buildings while colliders stream ----------
section('explosions + collider streaming stress');
guard('blasts', () => {
  let maxEx = 0, maxUp = 0;
  const ids = B.query(120, 60, 400);
  for (let n = 0; n < 60; n++) {
    const id = ids[(n * 7) % ids.length];
    const r = B.recs[id];
    if (!r || r.removed) continue;
    const pos = new THREE.Vector3(r.cx + 9 + (n % 3), 1 + (n % 5) * 3, r.cz + (n % 4) - 2);
    game.player.focus.set(r.cx + (n % 2 ? 0 : 500), 0, r.cz);
    stream();
    const t0 = performance.now();
    D.onExplosion(pos, n % 9 === 0 ? 4 : 1 + (n % 3) * 0.3, 17);
    maxEx = Math.max(maxEx, performance.now() - t0);
    for (let i = 0; i < 6; i++) {
      game.time += 1 / 60; world.step();
      const t1 = performance.now();
      D.update(1 / 60);
      game.fx.debrisSys.update(1 / 60);
      maxUp = Math.max(maxUp, performance.now() - t1);
      if (i % 2) stream();
      for (const k of ids.slice(0, 12)) legacyCalls(k, false);
    }
  }
  tick(300);
  console.log(`  onExplosion max ${maxEx.toFixed(2)} ms, Destruction.update max ${maxUp.toFixed(2)} ms (warm-up included)`);
  // invariants
  for (const id of ids) {
    const r = B.recs[id];
    if (r.removed) ok(!B.colliders.has(id), `removed ${id} has no Buildings collider`);
    if (r.frac?.external) ok(!B.colliders.has(id) || !r.frac.parts.length, `fractured ${id}: no duplicate Buildings collider`);
  }
  ok(D.collapses.blocks.length <= 24, 'falling blocks capped');
});

// ---------- 5. IRL multi-part ----------
section('IRL multi-part massing');
guard('irl', () => {
  const fb = F.get(irlIdx);
  ok(fb && fb.prisms.length >= 2, `parts captured as wall prisms (${fb?.prisms.length})`);
  fb.ensureAround({ x: 300 + 15, y: 30, z: 0 }, 6);
  ok(fb.parts.some((p) => p.band > 0 && p.panels?.length), 'upper setback cells build');
  legacyCalls(irlIdx);
});

console.log('  collapse start worst', D.collapses.stats.maxGoMs?.toFixed(2), 'ms', JSON.stringify(D.collapses.stats.maxGoSplit));
console.log(fails ? `${fails} FAILED` : 'all destruction checks passed');
process.exit(fails ? 1 : 0);
