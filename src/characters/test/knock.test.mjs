// Knock-down believability (headless): node src/characters/test/knock.test.mjs
// Car hits at 30/80 km/h and an explosion, with the previous model (legacy launch formula + ragdoll tuning,
// reproduced here) and the current one (impact.js + RAGDOLL_TUNING). Prints throw distance, peak height,
// spin, bounces, settle time, car slowdown, and the scripted-tumble distance for the same launch.
import RAPIER from '@dimforge/rapier3d-compat';
import { Ragdolls, RAGDOLL_TUNING } from '../Ragdoll.js';
import { makeDims, fk, pelvisMatrix, NJ } from '../rig.js';
import { newPose, poseGait } from '../poses.js';
import { vehicleKnock, blastKnock, pushVehicle, tumbleStep } from '../impact.js';
const RAMP = { hw: 0.92 * 0.9, z0: -2.25, y0: 0.21, z1: 0.0 + 0.2, y1: 0.89 };
import { GROUPS, groups } from '../../vehicle/groups.js';

// deterministic runs: the knock model adds a little random yaw spin (Math.random); seed it so results are repeatable
let _seed = 0x2f6b4f;
Math.random = () => { _seed = (_seed + 0x6d2b79f5) | 0; let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

await RAPIER.init();
const LEGACY_TUNING = { linDamp: 0.12, angDampCore: 1.6, angDampLimb: 1.1, friction: 0.85, restitution: 0.05, caps: false, mass: null };
const legacyCar = (b, px, pz) => {
  const dx = px - b.x, dz = pz - b.z, n = Math.hypot(dx, dz) || 1;
  const v = { x: b.vx * 0.8 + (dx / n) * 1.6, y: 2.2 + b.speed * 0.17, z: b.vz * 0.8 + (dz / n) * 1.6 };
  return { ...v, sx: -v.z * 0.35, sy: 0.9, sz: v.x * 0.35 };
};
const legacyBlast = (dx, dy, dz, R, power) => {
  const d = Math.hypot(dx, dy, dz), k = 1 - d / (R * 0.85), n = Math.hypot(dx, dz) || 1, s = (4 + 9 * k) * power;
  return { x: (dx / n) * s, y: 3 + 5 * k, z: (dz / n) * s, sx: (dz / n) * 4, sy: 1.5, sz: -(dx / n) * 4 };
};

const HW = 0.92, HL = 2.2;
function scene(withCar, speed) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  world.createCollider(RAPIER.ColliderDesc.cuboid(300, 0.5, 300).setTranslation(0, -0.5, 0).setFriction(1).setCollisionGroups(groups(GROUPS.GROUND, 0xffff)));
  let car = null;
  if (withCar) {
    car = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.75, 0).setLinvel(0, 0, -speed).enabledRotations(false, true, false));
    const cg = groups(GROUPS.VEHICLE, 0xffff);
    // hull with a sloped nose + cabin: like a hatchback
    world.createCollider(RAPIER.ColliderDesc.cuboid(HW, 0.33, HL).setMass(1100).setFriction(0.05).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setCollisionGroups(cg), car);
    world.createCollider(RAPIER.ColliderDesc.cuboid(HW * 0.78, 0.26, 1.05).setTranslation(0, 0.58, 0.35).setMass(300).setFriction(0.3).setCollisionGroups(cg), car);
  }
  return { world, car };
}

function run(label, { kind, kmh = 0, dist = 0, legacy, keepDriving = false }) {
  const speed = kmh / 3.6;
  const { world, car } = scene(kind === 'car', speed);
  const ctl = kind === 'car' ? scene(true, speed) : null;
  const pool = new Ragdolls({ RAPIER, world }, { max: 6, tuning: legacy ? LEGACY_TUNING : RAGDOLL_TUNING });
  const d = makeDims({ h: 1.76, fem: 0, build: 'average' });
  const P = newPose();
  poseGait(P, 0.8, 1.3, d);
  const W = new Float32Array(NJ * 12), M = new Float32Array(12);
  // pedestrian crossing in front of the car (walking +x), car driving -z
  let pz = kind === 'car' ? -(HL + (legacy ? (speed > 15 ? -0.07 : 0.16) : speed > 15 ? 0.6 : 0.35)) : 0;
  const px = 0.25;
  let kn;
  const b = { x: 0, y: 0.75, z: 0, vx: 0, vy: 0, vz: -speed, speed, yaw: 0, hw: HW, hl: HL, ref: car ? { body: car } : null };
  if (kind === 'car') {
    if (legacy) kn = legacyCar(b, px, pz);
    else {
      if (-pz < HL + 0.35) pz = -(HL + 0.35); // new code: start outside the car body
      kn = vehicleKnock(b, 1.3, 0, px / (HW + 0.3));
      pushVehicle(b, 80, kn.h);
    }
  } else {
    const dx = dist, dy = 0.5, dz = 0;
    kn = legacy ? legacyBlast(dx, dy, dz, 8, 1) : blastKnock(dx, dy, dz, 8 * 0.85, 1);
  }
  pelvisMatrix(M, kind === 'car' ? px : dist, 0, kind === 'car' ? pz : 0, -Math.PI / 2, P, d);
  fk(W, M, P, d);
  const rd = pool.spawn(W, d, { x: kn.x, y: kn.y, z: kn.z }, { spin: { x: kn.sx, y: kn.sy, z: kn.sz }, priority: 3 });
  if (!legacy && car && kn.rel > 11) pool.addRamp(car, RAMP);
  const p0 = rd.bodies[0].translation();
  const x0 = p0.x, z0 = p0.z;
  let maxY = 0, maxHead = 0, maxW = 0, bounces = 0, prevVy = 0, settle = null, hood = false, carV05 = null, ctlV05 = null;
  const brake = (c, i) => { // driver reaction 0.4 s, then 7 m/s^2 braking (or keeps the speed)
    if (!c) return;
    const v = c.linvel();
    if (keepDriving) { if (i > 0) c.setLinvel({ x: v.x, y: v.y, z: Math.min(v.z, -speed) }, true); return; }
    if (i >= 24 && v.z < 0) c.setLinvel({ x: v.x, y: v.y, z: Math.min(0, v.z + 7 / 60) }, true);
  };
  for (let i = 0; i < 600; i++) {
    brake(car, i); brake(ctl?.car, i);
    pool.fixedUpdate(1 / 60);
    world.step();
    pool.postStep();
    ctl?.world.step();
    pool.update(1 / 60);
    const t = rd.bodies[0].translation(), v = rd.bodies[0].linvel(), w = rd.bodies[1].angvel();
    const hy = rd.bodies[2].translation().y;
    maxY = Math.max(maxY, t.y); maxHead = Math.max(maxHead, hy);
    maxW = Math.max(maxW, Math.hypot(w.x, w.y, w.z));
    if (t.y < 0.45 && prevVy < -1 && v.y > 0.5) bounces++;
    prevVy = v.y;
    if (car) {
      const c = car.translation(), tt = rd.bodies[1].translation();
      if (Math.abs(tt.x - c.x) < HW && Math.abs(tt.z - c.z) < HL && tt.y > 1.0) hood = true;
      if (i === 21) { carV05 = -car.linvel().z; ctlV05 = -ctl.car.linvel().z; }
    }
    if (settle === null && rd.settled) settle = (i + 1) / 60;
  }
  const t = rd.bodies[0].translation();
  const throwD = Math.hypot(t.x - x0, t.z - z0);
  // scripted tumble with the same launch (only meaningful for the new model)
  const kh = Math.hypot(kn.x, kn.z), ks = kn.carry > kh ? kn.carry / kh : 1;
  const tb = { x: 0, y: 1, z: 0, vx: kn.x * ks, vy: kn.y, vz: kn.z * ks, air: true, spin: 3, h0: Math.max(0.5, kh * ks), rot: 0 };
  let tt = 0;
  while (!tumbleStep(tb, 1 / 60, 0) && tt < 20) tt += 1 / 60;
  const res = {
    label, throw: +throwD.toFixed(1), tumble: +Math.hypot(tb.x, tb.z).toFixed(1), peakPelvis: +maxY.toFixed(2), peakHead: +maxHead.toFixed(2),
    maxSpin: +maxW.toFixed(1), bounces, settle, hood,
    launch: `${Math.hypot(kn.x, kn.z).toFixed(1)}h/${kn.y.toFixed(1)}v`,
  };
  if (car) res.carLossKmh = +((ctlV05 - carV05) * 3.6).toFixed(1);
  return res;
}

const rows = [];
for (const legacy of [true, false]) {
  const tag = legacy ? 'before' : 'after ';
  rows.push(run(`${tag} car 30 km/h`, { kind: 'car', kmh: 30, legacy }));
  rows.push(run(`${tag} car 80 km/h`, { kind: 'car', kmh: 80, legacy }));
  rows.push(run(`${tag} car 120 km/h`, { kind: 'car', kmh: 120, legacy }));
  rows.push(run(`${tag} blast 3 m`, { kind: 'blast', dist: 3, legacy }));
  rows.push(run(`${tag} blast 6 m`, { kind: 'blast', dist: 6, legacy }));
  rows.push(run(`${tag} 50 km/h no brake`, { kind: 'car', kmh: 50, legacy, keepDriving: true }));
}
console.table(rows);
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails++; };
const A = (l) => rows.find((r) => r.label === l);
ok(A('after  car 30 km/h').throw >= 2 && A('after  car 30 km/h').throw <= 9, '30 km/h: knocked a few metres');
ok(A('after  car 80 km/h').throw > A('after  car 30 km/h').throw * 2.5, '80 km/h: thrown much further');
ok(rows.filter((r) => r.label.startsWith('after')).every((r) => r.peakPelvis < 3.2), 'never launched into the sky (pelvis < 3.2 m)');
ok(rows.filter((r) => r.label.startsWith('after')).every((r) => r.maxSpin <= 7.05), 'spin capped at 7 rad/s');
ok(rows.filter((r) => r.label.startsWith('after')).every((r) => r.bounces <= 2 && r.peakPelvis < 1.8), 'no bouncing (only rolling contacts)');
ok(A('after  car 80 km/h').carLossKmh > 1, 'the car feels the hit');
ok(rows.filter((r) => r.label.startsWith('after') && !r.label.includes('no brake') && !r.label.includes('120')).every((r) => Math.abs(r.tumble - r.throw) <= Math.max(3, r.throw * 0.35)), 'scripted tumbles land close to the ragdolls (up to 80 km/h)');
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
