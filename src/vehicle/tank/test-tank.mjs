// Headless tank physics checks: node src/vehicle/tank/test-tank.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { TankPhysics } from './TankPhysics.js';
import { TANK } from './TankModel.js';
import { GROUPS, groups } from '../groups.js';

const DT = 1 / 60;
const KMH = 1 / 3.6;
await RAPIER.init();

function world0(extra) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(0.9).setCollisionGroups(groups(GROUPS.GROUND)), gb);
  extra?.(world, gb);
  world.step();
  return world;
}
function spawn(extra, pos = { x: 0, y: 0, z: 0 }, yaw = 0) {
  const world = world0(extra);
  const t = new TankPhysics({ RAPIER, world, position: pos, yaw });
  for (let i = 0; i < 120; i++) { t.fixedUpdate(DT, {}); world.step(); }
  return { world, t };
}
const run = (w, t, inp, n, fn) => { for (let i = 0; i < n; i++) { t.fixedUpdate(DT, inp); w.step(); if (fn && fn(i) === false) break; } };
const fwd = (t) => { const q = t.body.rotation(); return { x: -2 * (q.x * q.z + q.w * q.y), y: -2 * (q.y * q.z - q.w * q.x), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) }; };
const upY = (t) => { const q = t.body.rotation(); return 1 - 2 * (q.x * q.x + q.z * q.z); };
const yaw = (t) => { const f = fwd(t); return Math.atan2(-f.x, -f.z); };
const vF = (t) => { const l = t.body.linvel(), f = fwd(t); return l.x * f.x + l.y * f.y + l.z * f.z; };
const f2 = (x) => x.toFixed(2);
const out = [];
const check = (name, ok, info) => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };

// 1. rest / idle drift
{
  const { world, t } = spawn();
  const p0 = { ...t.body.translation() };
  let maxV = 0;
  run(world, t, { driver: false }, 300, () => { const l = t.body.linvel(); maxV = Math.max(maxV, Math.hypot(l.x, l.y, l.z)); });
  const p1 = t.body.translation();
  const drift = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  check('rest height', Math.abs(p1.y - TANK.originY) < 0.05, `origin ${f2(p1.y)} m above ground (expected ${TANK.originY})`);
  check('idle drift', drift < 0.01, `${(drift * 100).toFixed(2)} cm, max v ${maxV.toFixed(3)}, sleeping=${t.body.isSleeping()}`);
}
// 2. acceleration / top speed / braking
{
  const { world, t } = spawn();
  const marks = { 20: null, 40: null, 60: null };
  let time = 0, maxPitch = 0;
  run(world, t, { throttle: 1 }, 60 * 45, () => {
    time += DT;
    const s = vF(t) / KMH;
    for (const k of Object.keys(marks)) if (marks[k] === null && s >= +k) marks[k] = time;
    const f = fwd(t);
    maxPitch = Math.max(maxPitch, Math.abs(Math.asin(f.y)));
  });
  const top = vF(t) / KMH;
  check('accel', marks[40] !== null && marks[40] > 5 && marks[40] < 16, `0-20 ${f2(marks[20])} s, 0-40 ${f2(marks[40])} s, 0-60 ${marks[60] === null ? '—' : f2(marks[60])} s, pitch ${f2(maxPitch * 57.3)}°`);
  check('top speed', top > 60 && top < 68, `${f2(top)} km/h`);
  const z0 = t.body.translation().z;
  let bt = 0;
  run(world, t, { brake: 1 }, 600, () => { bt += DT; if (vF(t) < 0.2) return false; });
  check('brake 65-0', Math.abs(t.body.translation().z - z0) < 40, `${f2(Math.abs(t.body.translation().z - z0))} m in ${f2(bt)} s`);
}
// 3. pivot turn on the spot
{
  const { world, t } = spawn();
  const p0 = { ...t.body.translation() };
  const y0 = yaw(t);
  run(world, t, { steer: 1 }, 60 * 4);
  const rate = t.body.angvel().y;
  const p1 = t.body.translation();
  check('pivot turn', Math.abs(rate) > 0.6 && Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.6, `yaw rate ${f2(rate)} rad/s (right = negative), turned ${f2((yaw(t) - y0) * 57.3)}°, moved ${f2(Math.hypot(p1.x - p0.x, p1.z - p0.z))} m`);
  check('pivot direction', rate < 0, 'steer +1 turns clockwise');
}
// 4. hard turn at speed: no flip
{
  const { world, t } = spawn();
  run(world, t, { throttle: 1 }, 60 * 20);
  const s0 = vF(t) / KMH;
  let minUp = 1, maxRate = 0;
  run(world, t, { throttle: 1, steer: 1 }, 60 * 8, () => { minUp = Math.min(minUp, upY(t)); maxRate = Math.max(maxRate, Math.abs(t.body.angvel().y)); });
  check('turn at speed', minUp > 0.9, `from ${f2(s0)} km/h: yaw rate ${f2(maxRate)} rad/s, min up.y ${f2(minUp)} (roll ${f2(Math.acos(minUp) * 57.3)}°), now ${f2(vF(t) / KMH)} km/h`);
  // slalom-ish reversal at speed
  minUp = 1;
  for (let k = 0; k < 6; k++) run(world, t, { throttle: 1, steer: k % 2 ? 1 : -1 }, 60, () => { minUp = Math.min(minUp, upY(t)); });
  check('slalom', minUp > 0.9, `min up.y ${f2(minUp)}`);
}
// 5. reverse
{
  const { world, t } = spawn();
  run(world, t, { brake: 1 }, 60 * 8);
  check('reverse', vF(t) / KMH < -20, `${f2(vF(t) / KMH)} km/h`);
}
// 6. kerb (0.25 m) and step (0.6 m) at 15 km/h
for (const h of [0.25, 0.6, 0.9]) {
  const { world, t } = spawn((w, gb) => {
    w.createCollider(RAPIER.ColliderDesc.cuboid(20, h / 2, 40).setTranslation(0, h / 2, -50).setFriction(0.9).setCollisionGroups(groups(GROUPS.STATIC)), gb);
  });
  let minUp = 1, onTop = -1;
  run(world, t, { throttle: 0.4 }, 60 * 14, () => {
    minUp = Math.min(minUp, upY(t));
    const p = t.body.translation();
    if (p.z < -30 && p.z > -70) onTop = Math.max(onTop, p.y);
  });
  onTop -= TANK.originY;
  check(`climb ${h} m`, onTop > h - 0.1 || h > 0.7, `height on the block ${f2(onTop)} m, min up.y ${f2(minUp)}`);
}
// 7. slopes: hold on 20°, climb 30°
for (const deg of [20, 30]) {
  const a = (deg * Math.PI) / 180;
  const { world, t } = spawn((w, gb) => {
    const q = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }; // rises towards -Z
    w.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.5, 60).setRotation(q).setTranslation(0, Math.sin(a) * 60 - 0.5 * Math.cos(a), -60 * Math.cos(a) - 8).setFriction(0.9).setCollisionGroups(groups(GROUPS.GROUND)), gb);
  });
  run(world, t, { throttle: 0.6 }, 60 * 9);
  run(world, t, {}, 60 * 5);
  const p0 = { ...t.body.translation() };
  const onSlope = Math.asin(Math.max(-1, Math.min(1, fwd(t).y))) * 57.3;
  run(world, t, {}, 60 * 5);
  const p1 = t.body.translation();
  const d = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
  check(`slope ${deg}°`, onSlope > deg - 4 && d < 0.05, `pitch on slope ${f2(onSlope)}°, y ${f2(p0.y)} m, hold drift ${(d * 100).toFixed(1)} cm`);
}
// 8. pushing a parked car-sized box
{
  const { world, t } = spawn((w) => {
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.8, -12));
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.7, 2.2).setMass(1400).setCollisionGroups(groups(GROUPS.VEHICLE)), b);
  });
  run(world, t, { throttle: 1 }, 60 * 6);
  check('push 1.4 t box', vF(t) / KMH > 15 && upY(t) > 0.95, `${f2(vF(t) / KMH)} km/h, rayHits ${t.rayHits.length}`);
}
// perf
{
  const { world, t } = spawn();
  let ms = 0;
  for (let i = 0; i < 600; i++) { const a = performance.now(); t.fixedUpdate(DT, { throttle: 1, steer: Math.sin(i / 50) }); ms += performance.now() - a; world.step(); }
  check('cost', ms / 600 < 0.6, `${(ms / 600 * 1000).toFixed(0)} µs per fixedUpdate (18 contact units × 3 rays)`);
}
console.log(out.join('\n'));
// drop from 0.6 m onto a raised strip under one track (kerb / sidewalk spawn): must settle, not bounce
{
  const { world, t } = spawn((w, gb) => {
    w.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.15, 20).setTranslation(-2.2, 0.15, 0).setFriction(0.9).setCollisionGroups(groups(GROUPS.STATIC)), gb);
  }, { x: 0, y: 0.6, z: 0 });
  let maxY = -1;
  run(world, t, {}, 120, () => { maxY = Math.max(maxY, t.body.translation().y); });
  const l = t.body.linvel();
  console.log(`${maxY < 0.75 + TANK.originY && Math.abs(l.y) < 0.05 ? 'PASS' : 'FAIL'}  drop on a kerb  max y after settle ${maxY.toFixed(2)}, vy ${l.y.toFixed(3)}, up.y ${upY(t).toFixed(3)}`);
}
