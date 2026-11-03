import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import * as THREE from 'three';
import { Terrain } from '../../src/world/Terrain.js';
import { Roads } from '../../src/world/Roads.js';
import { Buildings } from '../../src/world/Buildings.js';
import '../../src/landmarks/index.js';
import { PlayerOverlay } from '../../src/map/Players.js';
import { prepareFracture } from '../../src/damage/fractureBuild.js';
import { Fracturer, FracturedBuilding } from '../../src/damage/Fracture.js';
import { unpackModel } from '../../src/net/render/modelTransfer.js';
import { glassAttribute } from '../../src/net/render/cosmetics.js';
import { VEHICLE_CATALOG } from '../../src/vehicle/catalog.js';
import { AIR_CATALOG } from '../../src/air/catalog.js';
import { BOAT_CATALOG } from '../../src/boat/catalog.js';
import { VEHICLE_DESCRIPTIONS_AR } from '../../src/i18n/vehicle-descriptions-ar.js';
import { ParkRoutes } from '../../src/world/ParkRoutes.js';
import { subtractSurface } from '../../src/world/RoadSurface.js';
import { Avatars } from '../../src/net/render/Avatars.js';
import { bakeModel, proxyModel } from '../../src/net/render/bake.js';

const worker = (name) => new Worker(new URL('./browser-worker.mjs', import.meta.url), { workerData: new URL(name, import.meta.url).href });
function messages(w, n) {
  return new Promise((resolve, reject) => {
    const out = [], timer = setTimeout(() => reject(new Error('worker timeout')), 60000);
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
    w.on('message', (m) => {
      if (m.error) { clearTimeout(timer); reject(new Error(m.error)); return; }
      out.push(m);
      if (out.length === n) { clearTimeout(timer); resolve(out); }
    });
  });
}
function equalGeometry(a, b) {
  assert.deepEqual(Object.keys(a.attributes), Object.keys(b.attributes));
  for (const k of Object.keys(a.attributes)) assert.deepEqual(a.attributes[k].array, b.attributes[k].array, k);
  assert.deepEqual(a.index?.array, b.index?.array);
}

test('real world worker preserves geometry, colliders, graph and terrain cuts', async () => {
  const dir = './public/data', json = (s) => JSON.parse(fs.readFileSync(`${dir}/${s}.json`));
  const bin = (s) => zlib.gunzipSync(fs.readFileSync(`${dir}/${s}.bin`));
  const h = bin('height');
  const data = { world: json('world'), roads: json('roads'), buildings: json('buildings'), irl: json('irl'), junctions: json('junctions'),
    heights: new Int16Array(h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength)), groundTex: new Uint8Array(bin('ground')) };
  const w = worker('../../src/world/worldWorker.js');
  try {
    const ready = messages(w, 2); w.postMessage(data);
    const scene = new THREE.Scene(), t = new Terrain(structuredClone(data), scene);
    const r = new Roads(structuredClone(data), t, scene), b = new Buildings(structuredClone(data), t, scene);
    const packets = await ready;
    const t2 = new Terrain(data, new THREE.Scene());
    const r2 = new Roads(data, t2, new THREE.Scene(), packets.find((p) => p.phase === 'roads').result);
    const b2 = new Buildings(data, t2, new THREE.Scene(), packets.find((p) => p.phase === 'buildings').result);
    assert.deepEqual(t.h, t2.h); assert.deepEqual(t.physOverride, t2.physOverride);
    assert.equal(r.group.children.length, r2.group.children.length);
    for (let i = 0; i < r.group.children.length; i++) equalGeometry(r.group.children[i].geometry, r2.group.children[i].geometry);
    for (const [key, pb] of r.physBuckets) assert.deepEqual(pb, r2.physBuckets.get(key));
    assert.deepEqual(r.adj, r2.adj);
    for (let i = 0; i < r.edges.length; i += 57) {
      const e = r.edges[i]; assert.deepEqual(r.pointAt(e, e.len / 3), r2.pointAt(r2.edges[i], e.len / 3));
    }
    assert.deepEqual(b.recs, b2.recs);
    for (let i = 0; i < b.group.children.length; i++) equalGeometry(b.group.children[i].geometry, b2.group.children[i].geometry);
  } finally { await w.terminate(); }
});

test('10,000 player blips remain bounded, offscreen points are culled, clusters account for everyone', () => {
  const layer = new PlayerOverlay(() => {}, { budget: 160 });
  const players = Array.from({ length: 10000 }, (_, id) => ({ id, x: id % 100, z: Math.floor(id / 100), heading: 0, name: `Player ${id}` }));
  const v = { w: 1000, h: 800, cx: 50, cz: 50, mpp: 0.2, rot: 0 };
  const cells = layer.layout(players, v);
  assert.ok(cells.length <= 160); assert.equal(cells.reduce((s, c) => s + c.n, 0), 10000);
  assert.equal(layer.layout([{ id: 1, x: Infinity, z: 0 }, { id: 2, x: 1e8, z: 0 }], v).length, 0);
  assert.equal(layer.layout([], v).length, 0);
});

test('prepared fracture shell and panel activation match synchronous destruction', () => {
  for (const style of [0, 1, 2, 3, 4, 5]) {
    const building = { p: [-10, -9, 10, -9, 10, 9, -10, 9], y: 0, h: style === 2 ? 90 : 14, s: style, f: 4 };
    const setup = () => {
      const B = new Buildings({ buildings: [structuredClone(building)] }, null, new THREE.Scene());
      const game = { buildings: B, camera: { position: new THREE.Vector3() }, world: { removeCollider() {} } };
      return new Fracturer(game);
    };
    const a = new FracturedBuilding(setup(), 0);
    const packet = structuredClone(prepareFracture(0, building, { cx: 0, cz: 0 }));
    const b = new FracturedBuilding(setup(), 0, packet);
    equalGeometry(a.basePart.geo, b.basePart.geo);
    equalGeometry(a.activateCell(0, 0).geo, b.activateCell(0, 0).geo);
    assert.deepEqual(a.stTotal, b.stTotal);
  }
});

test('remote vehicle worker transfers cars, articulated tank and aircraft with usable glass masks', async () => {
  const w = worker('../../src/net/render/modelWorker.js');
  try {
    const jobs = [['pip', 'car'], ['tank', 'car'], ['plane_trainer', 'plane'], ['boat_speed', 'boat']];
    const ready = messages(w, jobs.length);
    for (const [id, kind] of jobs) w.postMessage({ key: id, id, kind });
    for (const m of await ready) {
      const b = unpackModel(m.result);
      assert.ok(b.geo.attributes.position.count > 100); assert.ok(b.geo.boundingSphere.radius > 0);
      if (m.key === 'tank') assert.ok(b.turret && b.barrel);
      if (m.key === 'pip') assert.ok(glassAttribute(b, b.geo).array.some((x) => x === 1));
    }
  } finally { await w.terminate(); }
});

test('every vehicle description has Arabic copy', () => {
  for (const v of [...VEHICLE_CATALOG, ...AIR_CATALOG, ...BOAT_CATALOG]) if (v.desc) {
    assert.ok(/[\u0600-\u06ff]/.test(VEHICLE_DESCRIPTIONS_AR[v.id] || ''), v.id);
  }
});

test('a temporary vehicle proxy cannot poison the real driver-seat cache', async () => {
  const avatars = new Avatars({ scene: new THREE.Scene() }, { factory: () => ({}) });
  let baked = proxyModel('car');
  avatars.vehicles = { dims: () => baked };
  const e = { id: 1, model: 1 };
  assert.equal(avatars._seat(e), null);
  baked = await bakeModel('pip', 'car');
  const seat = avatars._seat(e);
  assert.ok(seat && seat.pos.y < 0.2);
  const before = seat;
  baked = { ...baked, spec: { ...baked.spec, collider: { ...baked.spec.collider, belt: 1.2 } } };
  assert.notEqual(avatars._seat(e), before);
});

test('walking GPS follows a park loop around a pond and joins its street gates', () => {
  const nav = new ParkRoutes({ nodes: [[0, 0, 1], [20, 0, 1]], paths: [
    { park: 0, a: 0, b: 1, p: [0, 0, 0, 10, 20, 10, 20, 0] },
    { park: 0, a: 0, b: 1, p: [0, 0, 20, 0] },
  ] });
  const path = nav.path(0, 0, 5, 20, 5);
  assert.ok(path.length > 8);
  for (let i = 0; i < path.length; i += 2) assert.ok(path[i] === 0 || path[i] === 20 || path[i + 1] === 0 || path[i + 1] === 10);
  let bridge = null;
  const mixed = nav.route({ x: -30, z: 0 }, { x: 20, z: 5 }, (x) => x < 0 ? -1 : 0, (a, b) => { bridge = [a.x, a.z, b.x, b.z]; return bridge; });
  assert.deepEqual(bridge, [-30, 0, 0, 0]); assert.deepEqual(mixed.slice(-2), [20, 5]);
});

test('a ribbon clipped by a junction has a continuous height at the new seam', () => {
  const record = (x, z) => [x, 1, z, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const pieces = subtractSurface([record(-2, -1), record(2, -1), record(0, 2)], [[0, 0, -10], [10, 0, -10], [0, 0, 10]], { at: () => 0 });
  assert.ok(pieces.length);
  for (const poly of pieces) for (const p of poly) {
    assert.ok(p[0] <= 1e-7);
    if (Math.abs(p[0]) < 1e-7) assert.equal(p[1], 0.07);
  }
});

test('recovering an overturned car earns no stunt reward, while a real jump still does', async () => {
  const { Score } = await import('../../src/world/Score.js');
  const tel = { airborne: true, upsideDown: false, speedKmh: 0 };
  const payouts = [];
  const game = { player: { mode: 'vehicle', controllable: { kind: 'car', telemetry: tel },
    focus: { x: 0, y: 2, z: 0 }, addMoney: (n) => payouts.push(n) }, terrain: { heightAt: () => 0 }, events: { emit() {} } };
  const score = new Score(game);
  score.update(1, game);
  tel.upsideDown = true;
  for (let i = 0; i < 30; i++) score.update(1, game);
  tel.airborne = false; tel.upsideDown = false;
  score.update(0.016, game);
  assert.equal(payouts.length, 0);
  tel.airborne = true; game.player.focus.y = 5;
  score.update(2, game);
  tel.airborne = false;
  score.update(0.016, game);
  assert.ok(payouts[0] > 0);
});

test('vehicle recovery stays on its current level of a stacked road', async () => {
  const { recoverVehicle } = await import('../../src/core/BasicPlayer.js');
  const { default: RAPIER } = await import('@dimforge/rapier3d-compat');
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  try {
    for (const top of [0, 8]) world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.25, 20).setTranslation(0, top - 0.25, 0).setCollisionGroups(0x0002ffff));
    world.step();
    const game = { world, RAPIER, terrain: { heightAt: () => -3 } };
    let bodyY = 9, resetY;
    const vehicle = { body: { translation: () => ({ x: 0, y: bodyY, z: 0 }) }, object3d: new THREE.Object3D(), reset: (p) => { resetY = p.y; } };
    recoverVehicle(game, vehicle);
    assert.ok(Math.abs(resetY - 8.5) < 0.001);
    bodyY = 1;
    recoverVehicle(game, vehicle);
    assert.ok(Math.abs(resetY - 0.5) < 0.001);
  } finally { world.free(); }
});

function routingFixture() {
  const r = Object.create(Roads.prototype);
  r.nodes = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0], [100, 0]];
  r.nodeY = [0, 0, 0, 0, 8, 8]; r.edges = []; r.adj = r.nodes.map(() => []);
  r.add = (a, b, middle = []) => {
    const p = [r.nodes[a], ...middle, r.nodes[b]], cum = [0];
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    const e = { i: r.edges.length, a, b, pts: p.flat(), cum, len: cum.at(-1), n: p.length, w: 8, kind: 0, oneway: 1,
      y: p.map((_, i) => r.nodeY[a] + (r.nodeY[b] - r.nodeY[a]) * cum[i] / cum.at(-1)) };
    r.edges.push(e); r.adj[a].push(e.i); r.adj[b].push(e.i);
  };
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5]]) r.add(a, b);
  r.buildSpatialIndex();
  return r;
}

test('GPS follows a one-way road directly ahead and uses its loop for a destination behind', () => {
  const r = routingFixture();
  const ahead = r.route(20, 0, 80, 0, 1, 1);
  assert.ok(ahead.filter((_, i) => i % 2 === 0).every((x) => x <= 80));
  assert.ok(ahead.filter((_, i) => i % 2).every((z) => z === 0));
  const behind = r.route(80, 0, 20, 0, 1, 1);
  assert.ok(behind.filter((_, i) => i % 2).includes(100));
  assert.deepEqual(behind.slice(-4), [0, 0, 20, 0]);
});

test('GPS cannot turn between stacked roads and reaches the lower level through a real ramp', () => {
  const r = routingFixture();
  assert.ok(r.route(20, 0, 80, 0, 9, 9));
  assert.equal(r.route(20, 0, 80, 0, 9, 1), null);
  r.add(5, 2, [[120, 50]]); r.buildSpatialIndex();
  const route = r.route(20, 0, 80, 0, 9, 1);
  assert.ok(route.filter((_, i) => i % 2 === 0).includes(120));
  assert.ok(route.filter((_, i) => i % 2).includes(100));
});
