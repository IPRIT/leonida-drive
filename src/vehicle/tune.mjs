// Headless tuning harness.
//   node src/vehicle/tune.mjs                 legacy suite (6 original presets) + representative catalog table
//   node src/vehicle/tune.mjs id1 id2 …       catalog table for these ids  (--cat=sports,truck  --all)
//   node src/vehicle/tune.mjs --legacy id…    full legacy test suite for these ids
//   node src/vehicle/tune.mjs --calibrate [ids|--cat=…]  fit engine torque to the catalog 0-100 / 0-60 targets
//   node src/vehicle/tune.mjs --slopes [ids]   standstill hold on 5–30 % grades / 10 % cross slope, hill starts
//   node src/vehicle/tune.mjs --bikes [ids]    two-wheeler step steer / lateral g / corner exit / slalom / weave
//   node src/vehicle/tune.mjs --bounce [ids]   bumpy road: takeoffs and airtime per km, vertical velocity
//                                             and rewrite calibration.js
import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from './physics/VehiclePhysics.js';
import { PRESET_ORDER, VEHICLE_PRESETS } from './presets.js';
import { VEHICLE_CATALOG, getCatalogEntry } from './catalog.js';
import { CALIBRATION, MEASURED } from './calibration.js';
import { writeFileSync } from 'node:fs';
import { GROUPS, groups } from './groups.js';
import { TankPhysics } from './tank/TankPhysics.js';

const DT = 1 / 60;
const KMH = 1 / 3.6;

await RAPIER.init();

function makeWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(6000, 0.5, 6000).setTranslation(0, -0.5, 0).setFriction(0.9).setCollisionGroups(groups(GROUPS.GROUND)),
    gb,
  );
  world.step();
  return world;
}

function spawn(preset, opts = {}) {
  const world = makeWorld();
  const v = new VehiclePhysics({ RAPIER, world, preset, position: { x: 0, y: 0, z: opts.z ?? 2500 }, yaw: 0, env: opts.env });
  if (opts.assists) Object.assign(v.assists, opts.assists);
  // settle
  for (let i = 0; i < 90; i++) step(v, world, {});
  return { world, v };
}

function step(v, world, input) {
  v.fixedUpdate(DT, input);
  world.step();
}

const fwdOf = (v) => {
  const q = v.body.rotation();
  // rotate (0,0,-1)
  const x = -(2 * (q.x * q.z + q.w * q.y));
  const y = -(2 * (q.y * q.z - q.w * q.x));
  const z = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return { x, y, z };
};
const yawOf = (v) => {
  const f = fwdOf(v);
  return Math.atan2(-f.x, -f.z);
};
const speedOf = (v) => {
  const l = v.body.linvel();
  return Math.hypot(l.x, l.y, l.z);
};
const fwdSpeed = (v) => {
  const l = v.body.linvel();
  const f = fwdOf(v);
  return l.x * f.x + l.y * f.y + l.z * f.z;
};

/** Put the car at a forward speed with matching wheel spin and a sensible gear. */
function prime(v, world, speed) {
  const f = fwdOf(v);
  v.body.setLinvel({ x: f.x * speed, y: 0, z: f.z * speed }, true);
  for (const w of v.wheels) w.omega = speed / w.radius;
  const dt = v.drivetrain;
  let g = 1;
  for (; g < dt.gearCount; g++) {
    const rpm = ((speed / v.spec.wheelRadius) * dt.ratio(g) * 60) / (2 * Math.PI);
    if (rpm < v.spec.engine.redline * 0.8) break;
  }
  dt.gear = g;
  dt.shiftTo = g;
  dt.shiftTimer = 0;
  dt.sinceShift = 1;
  v.predVel = null;
}

function holdSpeed(v, target, integ) {
  const e = target - fwdSpeed(v);
  integ.i = Math.max(-2, Math.min(2, integ.i + e * DT * 0.6));
  const u = e * 0.35 + integ.i;
  return { throttle: Math.max(0, Math.min(1, u)), brake: u < -0.6 ? Math.min(1, -u - 0.6) : 0 };
}

function testIdle(preset) {
  const { world, v } = spawn(preset);
  let maxV = 0;
  let maxW = 0;
  for (let i = 0; i < 600; i++) {
    step(v, world, {});
    if (i > 300) {
      maxV = Math.max(maxV, speedOf(v));
      const a = v.body.angvel();
      maxW = Math.max(maxW, Math.hypot(a.x, a.y, a.z));
    }
  }
  const p = v.body.translation();
  return { maxV, maxW, y: p.y, sleeping: v.body.isSleeping() };
}

function testSlopeHold(preset, deg = 15) {
  // park on a 15 deg slope facing uphill, downhill and across; report the worst drift over 7 s
  let worst = 0, worstV = 0;
  for (const heading of [0, Math.PI, Math.PI / 2]) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = DT;
    const a = (deg * Math.PI) / 180;
    const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const q = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }; // surface rises toward -Z
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 200).setRotation(q).setTranslation(0, -0.5, 0).setCollisionGroups(groups(GROUPS.GROUND)), gb);
    world.step();
    const v = new VehiclePhysics({ RAPIER, world, preset, position: { x: 0, y: 0.05, z: 0 }, yaw: heading });
    const qy = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
    // slope rotation (world X axis) applied after the yaw
    const qr = {
      w: q.w * qy.w - q.x * qy.x,
      x: q.w * qy.x + q.x * qy.w,
      y: q.w * qy.y + q.y * qy.w + (q.z * qy.x - q.x * qy.z) * 0 + q.x * qy.z * 0 - (q.x * qy.z - q.z * qy.x) * 0,
      z: q.w * qy.z + q.x * qy.y - q.y * qy.x + q.z * qy.w,
    };
    qr.y = q.w * qy.y + q.y * qy.w + q.z * qy.x - q.x * qy.z;
    v.body.setRotation(qr, true);
    let start = null, maxV = 0;
    for (let i = 0; i < 600; i++) {
      step(v, world, {});
      if (i === 180) start = { ...v.body.translation() };
      if (i > 180) maxV = Math.max(maxV, speedOf(v));
    }
    const p = v.body.translation();
    worst = Math.max(worst, Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z));
    worstV = Math.max(worstV, maxV);
  }
  return { maxV: worstV, drift: worst };
}

function testAccel(preset) {
  const { world, v } = spawn(preset);
  let t = 0;
  let t100 = null;
  let vmax = 0;
  let tPlateau = 0;
  let last = 0;
  let maxSlip = 0;
  while (t < 90) {
    step(v, world, { throttle: 1 });
    t += DT;
    const s = fwdSpeed(v);
    if (t100 === null && s >= 100 * KMH) t100 = t;
    if (t < 6) maxSlip = Math.max(maxSlip, Math.max(...v.wheels.map((w) => w.slipRatio)));
    if (s > vmax + 0.01) {
      vmax = s;
      tPlateau = t;
    }
    if (t - tPlateau > 6 && t > 20) break;
    last = s;
  }
  return { t100, vmaxKmh: vmax * 3.6, gear: v.drivetrain.gear, rpm: v.drivetrain.rpm, maxSlip };
}

function testBrake(preset) {
  const { world, v } = spawn(preset);
  prime(v, world, 100 * KMH);
  for (let i = 0; i < 3; i++) step(v, world, { throttle: 0.4 });
  const p0 = { ...v.body.translation() };
  let t = 0;
  let maxDecel = 0;
  let prev = fwdSpeed(v);
  while (t < 15) {
    step(v, world, { brake: 1 });
    t += DT;
    const s = fwdSpeed(v);
    maxDecel = Math.max(maxDecel, (prev - s) / DT);
    prev = s;
    if (s < 0.05) break;
  }
  const p = v.body.translation();
  return { dist: Math.hypot(p.x - p0.x, p.z - p0.z), time: t, maxDecelG: maxDecel / 9.81, yaw: (yawOf(v) * 180) / Math.PI };
}

function testSkidpad(preset) {
  // constant speed 60 km/h, slowly increase steering; report max quasi-steady lateral g
  const { world, v } = spawn(preset);
  prime(v, world, 60 * KMH);
  const integ = { i: 0.2 };
  let best = 0;
  let bestSteer = 0;
  const window = [];
  let t = 0;
  const T = 24;
  while (t < T) {
    const steer = Math.min(1, t / (T * 0.85));
    const c = holdSpeed(v, 60 * KMH, integ);
    step(v, world, { throttle: c.throttle, brake: c.brake, steer: -steer });
    t += DT;
    const l = v.body.linvel();
    const a = v.body.angvel();
    const vh = Math.hypot(l.x, l.z);
    const lat = Math.abs(vh * a.y);
    window.push(lat);
    if (window.length > 30) window.shift();
    const avg = window.reduce((s, x) => s + x, 0) / window.length;
    if (t > 2 && Math.abs(fwdSpeed(v) - 60 * KMH) < 3 && avg / 9.81 > best) {
      best = avg / 9.81;
      bestSteer = steer;
    }
  }
  return { latG: best, steer: bestSteer };
}

function testLaneChange(preset, assists = true) {
  const { world, v } = spawn(preset, { assists: assists ? {} : { esc: false, steerAssist: false, tcs: false, abs: false } });
  prime(v, world, 120 * KMH);
  const integ = { i: 0.4 };
  const p0 = { ...v.body.translation() };
  const yaw0 = yawOf(v);
  let t = 0;
  let maxBeta = 0;
  let maxYawErr = 0;
  let maxLat = 0;
  const A = 0.4;
  const T = 2.4;
  let frozen = 0.3;
  while (t < 7) {
    let steer = 0;
    if (t > 0.3 && t < 0.3 + T) steer = A * Math.sin((2 * Math.PI * (t - 0.3)) / T);
    const c = holdSpeed(v, 120 * KMH, integ);
    if (t < 0.3) frozen = c.throttle;
    step(v, world, { throttle: t < 0.3 ? c.throttle : frozen, brake: 0, steer });
    t += DT;
    maxBeta = Math.max(maxBeta, Math.abs(v.telemetry.slipAngle));
    const ye = Math.abs(yawOf(v) - yaw0);
    maxYawErr = Math.max(maxYawErr, ye);
    const p = v.body.translation();
    maxLat = Math.max(maxLat, Math.abs(p.x - p0.x));
  }
  const p = v.body.translation();
  return {
    offset: p.x - p0.x,
    maxLat,
    maxBetaDeg: (maxBeta * 180) / Math.PI,
    finalYawDeg: ((yawOf(v) - yaw0) * 180) / Math.PI,
    finalYawRate: v.body.angvel().y,
    endKmh: fwdSpeed(v) * 3.6,
  };
}

function testHandbrake(preset) {
  const { world, v } = spawn(preset);
  prime(v, world, 70 * KMH);
  let t = 0;
  let yawAcc = 0;
  let prevYaw = yawOf(v);
  let maxRot = 0;
  let recovered = null;
  while (t < 9) {
    let input;
    if (t < 0.9) input = { steer: -1, handbrake: true, throttle: 0 };
    else if (t < 2.0) input = { steer: -0.3, throttle: 0.35 };
    else input = { steer: 0, throttle: 0.3 };
    step(v, world, input);
    t += DT;
    const y = yawOf(v);
    let d = y - prevYaw;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    yawAcc += d;
    prevYaw = y;
    maxRot = Math.max(maxRot, Math.abs(yawAcc));
    const yr = Math.abs(v.body.angvel().y);
    if (t > 2.5 && recovered === null && yr < 0.15 && Math.abs(v.telemetry.slipAngle) < 0.15) recovered = t;
  }
  const up = 1 - 2 * (v.body.rotation().x ** 2 + v.body.rotation().z ** 2);
  return { rotDeg: (maxRot * 180) / Math.PI, recoveredAt: recovered, finalYawRate: v.body.angvel().y, upright: up > 0.8, endKmh: fwdSpeed(v) * 3.6 };
}


function addStatic(world, desc) {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(desc.setCollisionGroups(groups(GROUPS.STATIC)), b);
}

function testCrash(preset) {
  // 300 km/h (or top speed) head-on into a concrete wall, then a 30 deg glancing hit
  const { world, v } = spawn(preset);
  addStatic(world, RAPIER.ColliderDesc.cuboid(20, 3, 1).setTranslation(0, 3, 2500 - 120));
  addStatic(world, RAPIER.ColliderDesc.cuboid(1, 3, 60).setTranslation(-8, 3, 2500 - 300));
  world.step();
  const speed = Math.min(300, (typeof preset === 'string' ? VEHICLE_PRESETS[preset] : preset).gearbox.topSpeedKmh) * KMH;
  prime(v, world, speed);
  let maxV = 0, maxW = 0, bad = false, hit = false;
  for (let i = 0; i < 360; i++) {
    step(v, world, { throttle: 1 });
    const l = v.body.linvel(), a = v.body.angvel(), p = v.body.translation();
    if (![l.x, l.y, l.z, a.x, a.y, a.z, p.x, p.y, p.z].every(Number.isFinite)) bad = true;
    if (v.telemetry.impactId > 0) hit = true;
    if (hit) maxV = Math.max(maxV, Math.hypot(l.x, l.y, l.z));
    maxW = Math.max(maxW, Math.hypot(a.x, a.y, a.z));
  }
  const p = v.body.translation();
  // glancing: new car heading -Z, slightly yawed toward the side wall
  const g = spawn(preset);
  addStatic(g.world, RAPIER.ColliderDesc.cuboid(1, 3, 200).setTranslation(-6, 3, 2500 - 200));
  g.world.step();
  g.v.reset({ x: 0, y: 0, z: 2500 }, (25 * Math.PI) / 180);
  for (let i = 0; i < 30; i++) step(g.v, g.world, {});
  prime(g.v, g.world, 160 * KMH);
  let gMaxW = 0;
  for (let i = 0; i < 240; i++) {
    step(g.v, g.world, { throttle: 0.5 });
    const a = g.v.body.angvel();
    gMaxW = Math.max(gMaxW, Math.hypot(a.x, a.y, a.z));
  }
  const gp = g.v.body.translation();
  return { bad, maxV, maxW, behindWall: p.z > 2500 - 121, y: p.y, impacts: v.telemetry.impactId, glanceMaxW: gMaxW, glanceX: gp.x, glanceUp: upOf(g.v) };
}

const upOf = (v) => {
  const q = v.body.rotation();
  return 1 - 2 * (q.x * q.x + q.z * q.z);
};

function testCurbAndJump(preset) {
  const { world, v } = spawn(preset);
  // curbs across the path (15 cm) then a 1.4 m kicker ramp
  addStatic(world, RAPIER.ColliderDesc.cuboid(6, 0.075, 0.25).setTranslation(0, 0.075, 2500 - 40));
  addStatic(world, RAPIER.ColliderDesc.cuboid(6, 0.075, 0.25).setTranslation(0, 0.075, 2500 - 46));
  const ang = Math.atan2(1.4, 9);
  const q = { x: Math.sin(ang / 2), y: 0, z: 0, w: Math.cos(ang / 2) };
  addStatic(world, RAPIER.ColliderDesc.cuboid(4, 0.3, 4.6).setRotation(q).setTranslation(0, 0.7 - 0.3, 2500 - 120));
  world.step();
  prime(v, world, 90 * KMH);
  let maxVy = 0, air = 0, maxAir = 0, minUp = 1, maxPitch = 0;
  const integ = { i: 0.3 };
  for (let i = 0; i < 600; i++) {
    const c = holdSpeed(v, 90 * KMH, integ);
    step(v, world, { throttle: c.throttle });
    const l = v.body.linvel();
    const p = v.body.translation();
    if (p.z > 2500 - 60) maxVy = Math.max(maxVy, Math.abs(l.y));
    if (v.telemetry.airborne) air += DT;
    else air = 0;
    maxAir = Math.max(maxAir, air);
    minUp = Math.min(minUp, upOf(v));
  }
  // big ramp: 3.2 m over 15 m at 110 km/h
  const g = spawn(preset);
  const ang2 = Math.atan2(3.2, 15);
  const q2 = { x: Math.sin(ang2 / 2), y: 0, z: 0, w: Math.cos(ang2 / 2) };
  addStatic(g.world, RAPIER.ColliderDesc.cuboid(4.5, 0.3, 7.65).setRotation(q2).setTranslation(0, 1.6 - 0.3, 2500 - 100));
  g.world.step();
  prime(g.v, g.world, 110 * KMH);
  let rMinUp = 1, rAir = 0, rMaxAir = 0, maxPitchRate = 0;
  for (let i = 0; i < 480; i++) {
    step(g.v, g.world, { throttle: 0.6 });
    if (g.v.telemetry.airborne) rAir += DT;
    else rAir = 0;
    rMaxAir = Math.max(rMaxAir, rAir);
    rMinUp = Math.min(rMinUp, upOf(g.v));
    const p = g.v.body.translation();
    if (p.z > 2500 - 108) maxPitchRate = Math.max(maxPitchRate, Math.abs(g.v.body.angvel().x));
  }
  return { curbVy: maxVy, airTime: maxAir, minUp, upright: upOf(v) > 0.9, rampAir: rMaxAir, rampMinUp: rMinUp, rampPitchRate: maxPitchRate, rampUpright: upOf(g.v) > 0.9 };
}

function testPowerOversteer(preset) {
  const { world, v } = spawn(preset);
  prime(v, world, 45 * KMH);
  let maxBeta = 0, rot = 0, prevYaw = yawOf(v);
  for (let i = 0; i < 300; i++) {
    const t = i * DT;
    step(v, world, { throttle: t < 3 ? 1 : 0, steer: t < 3 ? -0.8 : 0 });
    maxBeta = Math.max(maxBeta, Math.abs(v.telemetry.slipAngle));
    const y = yawOf(v);
    let d = y - prevYaw;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    rot += d;
    prevYaw = y;
  }
  return { maxBetaDeg: (maxBeta * 180) / Math.PI, rotDeg: (rot * 180) / Math.PI, finalYawRate: v.body.angvel().y };
}

function testHighSpeedSteer(preset, assists = true) {
  const { world, v } = spawn(preset, { assists: assists ? {} : { esc: false, steerAssist: false } });
  prime(v, world, 160 * KMH);
  let maxBeta = 0, maxLat = 0, frozen = 0.4;
  const integ = { i: 0.5 };
  for (let i = 0; i < 300; i++) {
    const t = i * DT;
    const c = holdSpeed(v, 160 * KMH, integ);
    if (t < 0.2) frozen = c.throttle;
    step(v, world, { throttle: t < 0.2 ? c.throttle : frozen, steer: t > 0.2 && t < 2.5 ? 1 : 0 });
    maxBeta = Math.max(maxBeta, Math.abs(v.telemetry.slipAngle));
    const l = v.body.linvel();
    maxLat = Math.max(maxLat, Math.abs(Math.hypot(l.x, l.z) * v.body.angvel().y));
  }
  return { maxBetaDeg: (maxBeta * 180) / Math.PI, latG: maxLat / 9.81, finalYawRate: v.body.angvel().y };
}

function testLiftOff(preset) {
  // steady ~0.8 g corner at 100 km/h, then abrupt lift: report beta / yaw-rate excursion
  const { world, v } = spawn(preset);
  prime(v, world, 100 * KMH);
  const integ = { i: 0.4 };
  let thr = 0.5, yr0 = 0, maxBeta = 0, maxYr = 0, steer = 0;
  for (let i = 0; i < 420; i++) {
    const t = i * DT;
    if (t < 4) {
      const c = holdSpeed(v, 100 * KMH, integ);
      thr = c.throttle;
      steer = Math.min(0.55, t * 0.4);
      step(v, world, { throttle: thr, steer: -steer });
      if (t > 3.8) yr0 = Math.abs(v.body.angvel().y);
    } else {
      step(v, world, { throttle: 0, steer: -steer });
      maxBeta = Math.max(maxBeta, Math.abs(v.telemetry.slipAngle));
      maxYr = Math.max(maxYr, Math.abs(v.body.angvel().y));
    }
  }
  return { maxBetaDeg: (maxBeta * 180) / Math.PI, yawOvershoot: yr0 > 0 ? maxYr / yr0 : 0 };
}

function testRoadStep(preset) {
  // 8 cm road slab (like a trimesh road over terrain), crossed straight and at 25 deg, up and down at 80 km/h
  let maxVy = 0, maxRate = 0;
  for (const ang of [0, 0.44]) {
    const { world, v } = spawn(preset);
    addStatic(world, RAPIER.ColliderDesc.cuboid(30, 0.04, 6).setTranslation(0, 0.04, 2500 - 40));
    world.step();
    v.reset({ x: 0, y: 0, z: 2500 }, ang);
    for (let i = 0; i < 30; i++) step(v, world, {});
    prime(v, world, 80 * KMH);
    const integ = { i: 0.3 };
    for (let i = 0; i < 40; i++) step(v, world, { throttle: holdSpeed(v, 80 * KMH, integ).throttle });
    let prevVy = v.body.linvel().y;
    for (let i = 0; i < 140; i++) {
      const c = holdSpeed(v, 80 * KMH, integ);
      step(v, world, { throttle: c.throttle });
      const l = v.body.linvel(), a = v.body.angvel();
      const pz = v.body.translation().z - (2500 - 40);
      if (Math.abs(Math.abs(pz) - 6) < 5) maxVy = Math.max(maxVy, Math.abs(l.y - prevVy) / DT / 9.81); // vertical jolt (g) near the edges
      prevVy = l.y;
      maxRate = Math.max(maxRate, Math.hypot(a.x, a.z));
    }
  }
  return { maxVy, maxRate };
}

const f = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '  -  ' : Number(x).toFixed(d));

// ---------------- catalog tests (all kinds) ----------------

function timeTo(preset, kmh, tmax = 60) {
  const { world, v } = spawn(preset);
  let t = 0;
  while (t < tmax) {
    step(v, world, { throttle: 1 });
    t += DT;
    if (fwdSpeed(v) >= kmh * KMH) return t;
  }
  return Infinity;
}

function testBrakeFrom(preset, kmh) {
  const { world, v } = spawn(preset);
  prime(v, world, kmh * KMH);
  for (let i = 0; i < 3; i++) step(v, world, { throttle: 0.3 });
  const p0 = { ...v.body.translation() };
  let t = 0;
  while (t < 20) {
    step(v, world, { brake: 1 });
    t += DT;
    if (fwdSpeed(v) < 0.05) break;
  }
  const p = v.body.translation();
  return Math.hypot(p.x - p0.x, p.z - p0.z);
}

/** Constant speed, ramp the steering to `steer` and hold. Reports steady lateral g, min up, max roll, lean, fall. */
function testTurn(preset, kmh, steer = 1, T = 8) {
  const { world, v } = spawn(preset);
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  let minUp = 1, maxRoll = 0, latG = 0, lean = 0, fell = false, maxBeta = 0;
  const win = [];
  for (let t = 0; t < T; t += DT) {
    const c = holdSpeed(v, kmh * KMH, integ);
    step(v, world, { throttle: c.throttle, brake: c.brake, steer: -Math.min(1, t / 1.0) * steer });
    const u = upOf(v);
    minUp = Math.min(minUp, u);
    const q = v.body.rotation();
    const rightY = 2 * (q.x * q.y + q.w * q.z);
    maxRoll = Math.max(maxRoll, Math.abs(Math.asin(Math.max(-1, Math.min(1, rightY)))));
    const l = v.body.linvel();
    win.push(Math.abs(Math.hypot(l.x, l.z) * v.body.angvel().y));
    if (win.length > 60) win.shift();
    if (t > T - 2) latG = win.reduce((a, b) => a + b, 0) / win.length / 9.81;
    if (t > T - 2) lean = Math.abs(v.telemetry.lean || 0);
    maxBeta = Math.max(maxBeta, Math.abs(v.telemetry.slipAngle));
    if (v.physics?.fallen || v.fallen) fell = true;
  }
  return { latG, minUp, rollDeg: (maxRoll * 180) / Math.PI, leanDeg: (lean * 180) / Math.PI, fell, endKmh: fwdSpeed(v) * 3.6, betaDeg: (maxBeta * 180) / Math.PI };
}

/** Sine slalom at speed: amplitude a, period T. Two-wheelers must not fall, cars must not flip. */
function testSlalom(preset, kmh, a = 0.6, T = 2.0) {
  const { world, v } = spawn(preset);
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  let fell = false, minUp = 1, maxBeta = 0;
  for (let t = 0; t < 8; t += DT) {
    const c = holdSpeed(v, kmh * KMH, integ);
    step(v, world, { throttle: c.throttle, brake: c.brake, steer: a * Math.sin((2 * Math.PI * t) / T) });
    if (v.fallen) fell = true;
    minUp = Math.min(minUp, upOf(v));
    maxBeta = Math.max(maxBeta, Math.abs(v.telemetry.slipAngle));
  }
  const p = v.body.translation();
  return { fell, minUp, betaDeg: (maxBeta * 180) / Math.PI, endKmh: fwdSpeed(v) * 3.6, drift: Math.abs(p.x) };
}

function testWallFall(preset, kmh = 50) {
  const { world, v } = spawn(preset);
  addStatic(world, RAPIER.ColliderDesc.cuboid(20, 3, 1).setTranslation(0, 3, 2500 - 40));
  world.step();
  prime(v, world, kmh * KMH);
  for (let i = 0; i < 240; i++) step(v, world, { throttle: 0.5 });
  return { fell: !!v.fallen, impacts: v.telemetry.impactId };
}

function catalogRow(id) {
  const e = getCatalogEntry(id);
  const preset = id;
  const P = VEHICLE_PRESETS[id];
  const kind = e?.kind || P.kind || 'car';
  const heavy = kind === 'truck' || kind === 'bus';
  const two = kind === 'motorcycle' || kind === 'bicycle';
  const idle = testIdle(preset);
  const acc = testAccel(preset);
  const tgt = e?.accelTarget;
  const tAcc = tgt ? timeTo(preset, tgt.kmh, 90) : null;
  const t100 = acc.t100;
  const brakeKmh = kind === 'bicycle' ? 25 : heavy ? 60 : 100;
  const br = testBrakeFrom(preset, brakeKmh);
  const turnKmh = kind === 'bicycle' ? 20 : heavy || kind === 'small' ? 40 : two ? 60 : 60;
  const turn = testTurn(preset, turnKmh, two ? 0.85 : 1);
  const fastKmh = Math.min(kind === 'bicycle' ? 28 : heavy ? 70 : 110, (P.gearbox.topSpeedKmh || 100) * 0.8);
  const turnFast = testTurn(preset, fastKmh, two ? 0.7 : 0.6);
  const sl = testSlalom(preset, Math.min(two ? 70 : heavy ? 50 : 90, (P.gearbox.topSpeedKmh || 100) * 0.7), two ? 0.6 : 0.4, two ? 2.4 : 2.2);
  const crash = two ? testWallFall(preset, 45) : null;
  return { id, kind, cat: e?.category, idle, acc, t100, tgt, tAcc, br, brakeKmh, turn, turnKmh, turnFast, fastKmh, sl, crash };
}

function printCatalog(rows) {
  console.log('');
  console.log('id               kind        0-100 s (tgt)  0-x s (tgt)     top km/h (tgt)  brake m (from)  turn: g, roll°/lean°, minUp @km/h   fast turn: g, roll/lean, minUp      slalom: fall/flip, β°   idle |v|  crash→fall');
  console.log('-'.repeat(196));
  for (const r of rows) {
    const e = getCatalogEntry(r.id);
    const two = r.kind === 'motorcycle' || r.kind === 'bicycle';
    console.log([
      r.id.padEnd(16), r.kind.padEnd(10),
      `${f(r.t100, 2)} (${f(e?.accel0100, 1)})`.padEnd(14),
      r.tgt ? `${f(r.tAcc, 2)} (${r.tgt.s}@${r.tgt.kmh})`.padEnd(15) : ''.padEnd(15),
      `${f(r.acc.vmaxKmh, 0)} (${e?.topSpeedKmh ?? '-'})`.padEnd(15),
      `${f(r.br, 1)} (${r.brakeKmh})`.padEnd(15),
      `${f(r.turn.latG, 2)}, ${f(two ? r.turn.leanDeg : r.turn.rollDeg, 1)}, ${f(r.turn.minUp, 2)} @${r.turnKmh}${r.turn.fell ? ' FELL' : ''}`.padEnd(36),
      `${f(r.turnFast.latG, 2)}, ${f(two ? r.turnFast.leanDeg : r.turnFast.rollDeg, 1)}, ${f(r.turnFast.minUp, 2)} @${f(r.fastKmh, 0)}${r.turnFast.fell ? ' FELL' : ''}`.padEnd(35),
      `${r.sl.fell ? 'FELL' : r.sl.minUp < 0.5 ? 'FLIP' : 'ok'}, ${f(r.sl.betaDeg, 1)}`.padEnd(23),
      f(r.idle.maxV, 4).padStart(8),
      r.crash ? `  ${r.crash.fell ? 'fell' : 'NO FALL'}` : '',
    ].join(' '));
  }
  console.log('');
}

// ---------------- calibration ----------------

function scaledPreset(id, k) {
  const p = JSON.parse(JSON.stringify(VEHICLE_PRESETS[id]));
  p.engine.curve = p.engine.curve.map(([r, t]) => [r, t * k]);
  p.gearbox.finalDrive = null;
  p.aero.cda = null;
  return p;
}

function calibrateOne(id) {
  const e = getCatalogEntry(id);
  const tgt = e?.accelTarget;
  if (!e || e.legacy || !tgt) return null;
  const tmax = Math.max(30, tgt.s * 4);
  const T = (k) => timeTo(scaledPreset(id, k), tgt.kmh, tmax);
  let lo = 0.25, hi = 4;
  let tHi = T(hi);
  while (!Number.isFinite(tHi) && hi > 1.05) tHi = T((hi /= 1.4)); // too much torque flips light vehicles
  let goal = tgt.s, limited = false;
  if (tHi > tgt.s * 1.02) {
    goal = tHi * 1.03;
    limited = true;
  }
  for (let i = 0; i < 10; i++) {
    const mid = Math.sqrt(lo * hi);
    if (T(mid) > goal) lo = mid;
    else hi = mid;
  }
  let k = Math.sqrt(lo * hi);
  if (limited) k = Math.max(1, Math.min(k, 1.6)); // traction/gearing bound: keep the nominal power
  return { id, k, factor: (CALIBRATION[id] ?? 1) * k, t: T(k), target: tgt, limited };
}

// ---------------- slopes (standstill hold, hill starts) ----------------

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false, driver: false };
const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const qrot = (q, v) => {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return { x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x };
};

/**
 * World with one inclined plane through the origin. axis 'x': grade along Z (rises towards -Z, i.e. uphill for
 * yaw 0); axis 'z': cross slope (rises towards +X). Returns { world, q (plane rotation) }.
 */
function slopeWorld(gradePct, axis = 'x', friction = 0.9) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const a = Math.atan(gradePct / 100);
  const q = axis === 'x' ? { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) } : { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) };
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const n = qrot(q, { x: 0, y: 1, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(600, 0.5, 600).setRotation(q).setTranslation(-n.x * 0.5, -n.y * 0.5, -n.z * 0.5)
    .setFriction(friction).setCollisionGroups(groups(GROUPS.GROUND)), gb);
  world.step();
  return { world, q, n };
}

/** Place a vehicle (VehiclePhysics or anything with body/reset) at rest on the plane, heading yaw. */
function placeOnSlope(v, sw, yaw, restHeight) {
  const qy = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  const r = qmul(sw.q, qy);
  const h = restHeight + 0.03;
  v.body.setTranslation({ x: sw.n.x * h, y: sw.n.y * h, z: sw.n.z * h }, true);
  v.body.setRotation(r, true);
  v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  if (v.prevPos) { v.prevPos.x = sw.n.x * h; v.prevPos.y = sw.n.y * h; v.prevPos.z = sw.n.z * h; }
  v.predVel = null;
}

/**
 * Standstill hold: settle 2 s, then drift over 10 s. mode 'driver' (player in, no input) or 'parked' (NEUTRAL).
 * case: 'up' | 'down' (grade along the heading) | 'cross' (side slope).
 */
export function testHoldOn(preset, gradePct, kase, mode = 'driver', make) {
  const sw = slopeWorld(gradePct, kase === 'cross' ? 'z' : 'x');
  const yaw = kase === 'down' ? Math.PI : 0;
  const v = make ? make(sw.world) : new VehiclePhysics({ RAPIER, world: sw.world, preset, position: { x: 0, y: 0, z: 0 }, yaw });
  placeOnSlope(v, sw, yaw, v.spec.restHeight ?? 0.9);
  const inp = mode === 'parked' ? NEUTRAL : {};
  for (let i = 0; i < 120; i++) { v.fixedUpdate(DT, inp); sw.world.step(); }
  const p0 = { ...v.body.translation() };
  let maxV = 0;
  for (let i = 0; i < 600; i++) { v.fixedUpdate(DT, inp); sw.world.step(); maxV = Math.max(maxV, speedOf(v)); }
  const p = v.body.translation();
  const q = v.body.rotation();
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  return { drift: Math.hypot(p.x - p0.x, p.y - p0.y, p.z - p0.z), maxV, upY, settleDrop: 0 };
}

/**
 * Released while rolling: on the grade, the vehicle is already rolling `v0` m/s downhill (nose down, or rolling back
 * when facing uphill) and the player lets go of every input. Returns distance to standstill and the 10 s drift after.
 */
export function testRollStop(preset, gradePct, kase = 'down', v0 = 1.5, mode = 'driver') {
  const sw = slopeWorld(gradePct, 'x');
  const yaw = kase === 'down' ? Math.PI : 0;
  const v = new VehiclePhysics({ RAPIER, world: sw.world, preset, position: { x: 0, y: 0, z: 0 }, yaw });
  placeOnSlope(v, sw, yaw, v.spec.restHeight);
  const inp = mode === 'parked' ? NEUTRAL : {};
  for (let i = 0; i < 60; i++) { v.fixedUpdate(DT, inp); sw.world.step(); }
  const down = qrot(sw.q, { x: 0, y: 0, z: 1 }); // downhill direction
  v.setVelocity({ x: down.x * v0, y: down.y * v0, z: down.z * v0 });
  const p0 = { ...v.body.translation() };
  let stopT = null, stopD = 0, aMax = 0, vPrev = v0;
  for (let i = 0; i < 60 * 15; i++) {
    v.fixedUpdate(DT, inp);
    sw.world.step();
    const lv = v.body.linvel();
    const vd = lv.x * down.x + lv.y * down.y + lv.z * down.z;
    aMax = Math.max(aMax, Math.abs(vd - vPrev) / DT);
    vPrev = vd;
    if (stopT === null && Math.hypot(lv.x, lv.y, lv.z) < 0.05) {
      stopT = i * DT;
      const p = v.body.translation();
      stopD = Math.hypot(p.x - p0.x, p.y - p0.y, p.z - p0.z);
      break;
    }
  }
  if (stopT === null) {
    const p = v.body.translation();
    return { stopT: null, stopD: Math.hypot(p.x - p0.x, p.y - p0.y, p.z - p0.z), drift: null, aMax };
  }
  for (let i = 0; i < 60; i++) { v.fixedUpdate(DT, inp); sw.world.step(); } // suspension settles after the stop
  const p1 = { ...v.body.translation() };
  const trace = [];
  for (let i = 0; i < 600; i++) {
    v.fixedUpdate(DT, inp); sw.world.step();
    if (i % 30 === 0) { const p = v.body.translation(); trace.push(Math.hypot(p.x - p1.x, p.y - p1.y, p.z - p1.z)); }
  }
  const p = v.body.translation();
  return { stopT, stopD, drift: Math.hypot(p.x - p1.x, p.y - p1.y, p.z - p1.z), aMax, trace };
}

/** Hill start on an uphill grade: hold 2 s, then throttle; rollback, time to 10 km/h, first-second jerk. */
export function testHillStart(preset, gradePct, throttle = 0.6) {
  const sw = slopeWorld(gradePct, 'x');
  const v = new VehiclePhysics({ RAPIER, world: sw.world, preset, position: { x: 0, y: 0, z: 0 }, yaw: 0 });
  placeOnSlope(v, sw, 0, v.spec.restHeight);
  for (let i = 0; i < 120; i++) { v.fixedUpdate(DT, {}); sw.world.step(); }
  const p0 = { ...v.body.translation() };
  const up = qrot(sw.q, { x: 0, y: 0, z: -1 }); // uphill direction
  let roll = 0, t10 = null, aMax = 0, vPrev = 0;
  for (let i = 0; i < 60 * 12; i++) {
    v.fixedUpdate(DT, { throttle });
    sw.world.step();
    const p = v.body.translation();
    const d = (p.x - p0.x) * up.x + (p.y - p0.y) * up.y + (p.z - p0.z) * up.z;
    roll = Math.min(roll, d);
    const vf = fwdSpeed(v);
    if (i < 60) aMax = Math.max(aMax, Math.abs(vf - vPrev) / DT);
    vPrev = vf;
    if (t10 === null && vf * 3.6 >= 10) { t10 = (i + 1) * DT; break; }
  }
  return { rollback: -roll, t10, aMax };
}

/** Reverse by holding brake at standstill on flat ground (GTA style) still works. */
export function testReverse(preset) {
  const { world, v } = spawn(preset);
  for (let i = 0; i < 60 * 3; i++) step(v, world, { brake: 1 });
  return fwdSpeed(v);
}

function tankHold(g, kase, mode) {
  return testHoldOn('tank', g, kase, mode, (world) => new TankPhysics({ RAPIER, world, position: { x: 0, y: 0, z: 0 }, yaw: kase === 'down' ? Math.PI : 0 }));
}

function printSlopes(ids) {
  const grades = [5, 10, 20, 30];
  console.log('');
  console.log('standstill drift over 10 s (cm), player in / no input | parked (handbrake, no driver); worst of uphill/downhill heading');
  console.log('id               | ' + grades.map((g) => `${g}%`.padEnd(13)).join(' | ') + ' | cross 10%     | hill start 20%: rollback cm, t10 s | 30%            | reverse km/h');
  console.log('-'.repeat(170));
  for (const id of ids) {
    const cells = [];
    for (const g of grades) {
      const dr = Math.max(testHoldOn(id, g, 'up').drift, testHoldOn(id, g, 'down').drift);
      const pk = Math.max(testHoldOn(id, g, 'up', 'parked').drift, testHoldOn(id, g, 'down', 'parked').drift);
      cells.push(`${f(dr * 100, 2)} / ${f(pk * 100, 2)}`.padEnd(13));
    }
    const cr = testHoldOn(id, 10, 'cross'), crp = testHoldOn(id, 10, 'cross', 'parked');
    cells.push(`${f(cr.drift * 100, 2)} / ${f(crp.drift * 100, 2)}`.padEnd(13));
    const h20 = testHillStart(id, 20), h30 = testHillStart(id, 30);
    cells.push(`${f(h20.rollback * 100, 1)}, ${h20.t10 === null ? '—' : f(h20.t10, 2)}`.padEnd(34));
    cells.push(`${f(h30.rollback * 100, 1)}, ${h30.t10 === null ? '—' : f(h30.t10, 2)}`.padEnd(14));
    cells.push(f(testReverse(id) * 3.6, 1));
    console.log(`${id.padEnd(16)} | ${cells.join(' | ')}`);
  }
  {
    const cells = [];
    for (const g of grades) {
      const dr = Math.max(tankHold(g, 'up').drift, tankHold(g, 'down').drift);
      const pk = Math.max(tankHold(g, 'up', 'parked').drift, tankHold(g, 'down', 'parked').drift);
      cells.push(`${f(dr * 100, 2)} / ${f(pk * 100, 2)}`.padEnd(13));
    }
    cells.push(`${f(tankHold(10, 'cross').drift * 100, 2)} / ${f(tankHold(10, 'cross', 'parked').drift * 100, 2)}`.padEnd(13));
    console.log(`${'tank (TankPhysics)'.padEnd(16)} | ${cells.join(' | ')}`);
  }
  console.log('');
  console.log('released while rolling 1.5 m/s downhill, no input: stop distance m / time s / peak decel m/s² / drift over 10 s after settling cm  (nose downhill | rolling back facing uphill)');
  console.log('id               | ' + [10, 20, 30].map((g) => `${g}% down`.padEnd(26) + ' | ' + `${g}% back`.padEnd(26)).join(' | '));
  console.log('-'.repeat(190));
  for (const id of ids) {
    const cells = [];
    for (const g of [10, 20, 30]) for (const k of ['down', 'up']) {
      const r = testRollStop(id, g, k);
      cells.push((r.stopT === null ? `NO STOP (${f(r.stopD, 1)} m in 15 s)` : `${f(r.stopD, 2)} / ${f(r.stopT, 2)} / ${f(r.aMax, 1)} / ${f(r.drift * 100, 2)}`).padEnd(26));
    }
    console.log(`${id.padEnd(16)} | ${cells.join(' | ')}`);
  }
}

// ---------------- two-wheeler handling ----------------

/** Step steer at a held speed: yaw-rate rise time, overshoot, steady lateral g, radius, sideslip. ramp: steer/s (0 = step). */
export function bikeStep(preset, kmh, steer = 1, ramp = 0, T = 6) {
  const { world, v } = spawn(preset);
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  for (let t = 0; t < 1; t += DT) { const c = holdSpeed(v, kmh * KMH, integ); step(v, world, { throttle: c.throttle, brake: c.brake }); }
  const rs = [], gs = [];
  let betaMax = 0, fell = false;
  for (let t = 0; t < T; t += DT) {
    const c = holdSpeed(v, kmh * KMH, integ);
    const s = ramp > 0 ? Math.min(1, t * ramp) * steer : steer;
    step(v, world, { throttle: c.throttle, brake: c.brake, steer: s });
    const l = v.body.linvel(), r = -v.body.angvel().y;
    rs.push(r);
    gs.push((Math.hypot(l.x, l.z) * r) / 9.81);
    betaMax = Math.max(betaMax, Math.abs(v.telemetry.slipAngle));
    if (v.fallen) fell = true;
  }
  const n = Math.round(1 / DT);
  const ss = rs.slice(-n).reduce((a, b) => a + b, 0) / n;
  const g = gs.slice(-n).reduce((a, b) => a + b, 0) / n;
  const peak = ss >= 0 ? Math.max(...rs) : Math.min(...rs);
  const t90 = rs.findIndex((r) => Math.abs(r) >= 0.9 * Math.abs(ss)) * DT;
  const vEnd = fwdSpeed(v);
  return { ss, g, t90, overshoot: (peak - ss) / (ss || 1), radius: Math.abs(vEnd / (ss || 1e-6)), betaDeg: betaMax * 57.3, fell, endKmh: vEnd * 3.6 };
}

/** Corner exit: steady full-lean turn at kmh, then full throttle for 3 s. Ratio of lateral g kept while accelerating. */
export function bikeExit(preset, kmh = 60) {
  const { world, v } = spawn(preset);
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  const gs = [];
  for (let t = 0; t < 4; t += DT) { const c = holdSpeed(v, kmh * KMH, integ); step(v, world, { throttle: c.throttle, brake: c.brake, steer: 1 }); }
  const l0 = v.body.linvel(); const g0 = (Math.hypot(l0.x, l0.z) * -v.body.angvel().y) / 9.81;
  let rMin = Infinity, fell = false;
  for (let t = 0; t < 3; t += DT) {
    step(v, world, { throttle: 1, steer: 1 });
    const l = v.body.linvel();
    const r = -v.body.angvel().y;
    rMin = Math.min(rMin, r);
    gs.push((Math.hypot(l.x, l.z) * r) / 9.81);
    if (v.fallen) fell = true;
  }
  return { g0, gAccel: gs.reduce((a, b) => a + b, 0) / gs.length, rMin, endKmh: fwdSpeed(v) * 3.6, fell };
}

/** Slalom at kmh: full steer alternating every half period; sideslip, yaw rate, lateral swing, fall. */
export function bikeSlalom(preset, kmh = 80, period = 2.0, T = 10) {
  const { world, v } = spawn(preset);
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  let betaMax = 0, rMax = 0, fell = false, xMin = 0, xMax = 0;
  for (let t = 0; t < T; t += DT) {
    const c = holdSpeed(v, kmh * KMH, integ);
    step(v, world, { throttle: c.throttle, brake: c.brake, steer: Math.sin((2 * Math.PI * t) / period) >= 0 ? 1 : -1 });
    betaMax = Math.max(betaMax, Math.abs(v.telemetry.slipAngle));
    rMax = Math.max(rMax, Math.abs(v.body.angvel().y));
    if (v.fallen) fell = true;
    if (t > 2) { const p = v.body.translation(); xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x); }
  }
  return { betaDeg: betaMax * 57.3, rMax, swing: xMax - xMin, fell, endKmh: fwdSpeed(v) * 3.6 };
}

/** Straight line at top speed, no steer: weave (yaw rate rms) and lean rms. */
export function bikeWeave(preset) {
  const { world, v } = spawn(preset);
  const top = (v.spec.vTop || 40) * 0.97;
  prime(v, world, top);
  let n = 0, rr = 0, ll = 0, rMax = 0;
  for (let t = 0; t < 8; t += DT) {
    step(v, world, { throttle: 1 });
    if (t < 2) continue;
    const r = v.body.angvel().y;
    rr += r * r; ll += (v.telemetry.lean || 0) ** 2; n++; rMax = Math.max(rMax, Math.abs(r));
  }
  return { kmh: fwdSpeed(v) * 3.6, yawRms: Math.sqrt(rr / n), leanRmsDeg: Math.sqrt(ll / n) * 57.3, rMax };
}

function printBikes(ids) {
  console.log('');
  console.log('two-wheelers: full step steer (gamepad) / keyboard ramp — t90 s, overshoot %, steady lateral g, radius m, max sideslip°');
  for (const id of ids) {
    const e = getCatalogEntry(id);
    const top = e?.topSpeedKmh ?? 200;
    const speeds = [30, 60, 110, 160].filter((k) => k <= top * 0.92);
    const parts = [];
    for (const k of speeds) {
      const a = bikeStep(id, k), b = bikeStep(id, k, 1, 3.2);
      parts.push(`@${k}: ${f(a.t90, 2)}/${f(b.t90, 2)} s, ${f(a.overshoot * 100, 0)}%, ${f(a.g, 2)} g, R ${f(a.radius, 0)} m, β ${f(a.betaDeg, 1)}°${a.fell ? ' FELL' : ''}`);
    }
    console.log(`${id.padEnd(10)} ${parts.join(' | ')}`);
    const ex = bikeExit(id, Math.min(60, top * 0.6));
    const sl = bikeSlalom(id, Math.min(80, top * 0.75));
    const wv = bikeWeave(id);
    console.log(`${''.padEnd(10)} corner exit: ${f(ex.g0, 2)} g → ${f(ex.gAccel, 2)} g under full throttle (min r ${f(ex.rMin, 2)}, ${f(ex.endKmh, 0)} km/h${ex.fell ? ', FELL' : ''}) | slalom @${Math.round(Math.min(80, top * 0.75))}: β ${f(sl.betaDeg, 1)}°, yaw ${f(sl.rMax, 2)} rad/s, swing ${f(sl.swing, 1)} m${sl.fell ? ', FELL' : ''} | top ${f(wv.kmh, 0)} km/h straight: yaw rms ${f(wv.yawRms, 4)}, lean rms ${f(wv.leanRmsDeg, 2)}°`);
  }
}

export { spawn, step, prime, holdSpeed, fwdSpeed, testTurn };

// ---------------- bounce (bumpy road) ----------------

/** Deterministic bumpy road along -Z from z0: seams, bumps, 8–12 cm slabs (road/kerb edges) across the lane. */
function addBumpyRoad(world, z0, length, seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const add = (hx, hy, hz, x, y, z) => world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.9).setCollisionGroups(groups(GROUPS.GROUND)), gb);
  let z = z0 - 20;
  while (z > z0 - length) {
    const k = rnd();
    if (k < 0.35) add(8, 0.01, 0.15, 0, 0.01, z); // seam 2 cm
    else if (k < 0.7) { const h = 0.04 + rnd() * 0.03, l = 0.3 + rnd() * 0.5; add(8, h / 2, l, 0, h / 2, z - l); z -= 2 * l; } // bump 4–7 cm
    else { const h = 0.08 + rnd() * 0.04, l = 3 + rnd() * 6; add(8, h / 2, l, 0, h / 2, z - l); z -= 2 * l; } // slab 8–12 cm (kerb / road edge)
    z -= 4 + rnd() * 11;
  }
  world.step();
}

/** Drive over the bumpy road at kmh: takeoffs and airtime per km, peak / rms vertical velocity. */
export function testBounce(preset, kmh) {
  const length = 1100;
  const world = makeWorld();
  addBumpyRoad(world, 2500, length + 200);
  const v = new VehiclePhysics({ RAPIER, world, preset, position: { x: 0, y: 0, z: 2500 }, yaw: 0 });
  for (let i = 0; i < 90; i++) step(v, world, {});
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  const z0 = v.body.translation().z;
  let air = 0, takeoffs = 0, inAir = 0, vyMax = 0, vyRms = 0, n = 0, fell = false;
  for (let i = 0; i < 60 * 120; i++) {
    const c = holdSpeed(v, kmh * KMH, integ);
    step(v, world, { throttle: c.throttle, brake: c.brake });
    const contacts = v.wheels.filter((w) => w.contact).length;
    if (contacts === 0) { air += DT; inAir++; if (inAir === 3) takeoffs++; } else inAir = 0;
    const vy = v.body.linvel().y;
    vyMax = Math.max(vyMax, vy); vyRms += vy * vy; n++;
    if (v.fallen) fell = true;
    if (z0 - v.body.translation().z > length) break;
  }
  const km = Math.max(0.001, (z0 - v.body.translation().z) / 1000);
  return { takeoffsKm: takeoffs / km, airKm: air / km, vyMax, vyRms: Math.sqrt(vyRms / n), fell, km };
}

/** Ramp jump: 15° kicker 1.3 m high at kmh — airtime and peak height (real jumps must still fly). */
export function testRampJump(preset, kmh = 80) {
  const world = makeWorld();
  const a = (15 * Math.PI) / 180, len = 1.3 / Math.sin(a);
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const q = { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }; // rises towards -Z
  const zc = 2500 - 40 - (len * Math.cos(a)) / 2;
  world.createCollider(RAPIER.ColliderDesc.cuboid(3, 0.05, len / 2).setRotation(q).setTranslation(0, (len * Math.sin(a)) / 2 - 0.05, zc).setCollisionGroups(groups(GROUPS.GROUND)), gb);
  world.step();
  const v = new VehiclePhysics({ RAPIER, world, preset, position: { x: 0, y: 0, z: 2500 }, yaw: 0 });
  for (let i = 0; i < 60; i++) step(v, world, {});
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  let air = 0, maxAir = 0, yMax = 0, launched = false, fell = false;
  for (let i = 0; i < 60 * 6; i++) {
    const c = holdSpeed(v, kmh * KMH, integ);
    step(v, world, { throttle: c.throttle });
    const contacts = v.wheels.filter((w) => w.contact).length;
    const z = v.body.translation().z;
    if (z < zc - (len * Math.cos(a)) / 2) launched = true;
    if (launched && contacts === 0) { air += DT; maxAir = Math.max(maxAir, air); yMax = Math.max(yMax, v.body.translation().y); } else air = 0;
    if (v.fallen) fell = true;
  }
  return { airtime: maxAir, height: yMax, fell };
}

function printBounce(ids) {
  console.log('');
  console.log('bumpy road (seams 2 cm, bumps 4–7 cm, 8–12 cm slabs, every 4–15 m): takeoffs/km, airtime s/km, peak vy m/s, rms vy m/s');
  for (const id of ids) {
    const e = getCatalogEntry(id);
    const top = e?.topSpeedKmh ?? 200;
    const speeds = e?.kind === 'bicycle' ? [20, 30] : [60, 120, 200].filter((k) => k <= top * 0.95);
    const parts = speeds.map((k) => { const r = testBounce(id, k); return `@${k}: ${f(r.takeoffsKm, 0)} / ${f(r.airKm, 2)} s / ${f(r.vyMax, 2)} / ${f(r.vyRms, 3)}${r.fell ? ' FELL' : ''}`; });
    const j = testRampJump(id, e?.kind === 'bicycle' ? 30 : 80);
    console.log(`${id.padEnd(10)} ${parts.join(' | ')} | ramp jump @${e?.kind === 'bicycle' ? 30 : 80}: ${f(j.airtime, 2)} s air, ${f(j.height, 2)} m${j.fell ? ' FELL' : ''}`);
  }
}

// ---------------- main ----------------

const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
if (IS_MAIN) main();

function main() {

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const catArg = args.find((a) => a.startsWith('--cat='));
let ids = args.filter((a) => !a.startsWith('-'));
if (catArg) ids = VEHICLE_CATALOG.filter((e) => (e.preset || e.legacy) && catArg.slice(6).split(',').includes(e.category)).map((e) => e.id);
if (flag('--all')) ids = VEHICLE_CATALOG.filter((e) => e.preset || e.legacy).map((e) => e.id);

if (flag('--calibrate')) {
  const list = ids.length ? ids : VEHICLE_CATALOG.filter((e) => !e.legacy && e.preset && e.accelTarget).map((e) => e.id);
  const out = { ...CALIBRATION };
  const meas = { ...MEASURED };
  for (const id of list) {
    const r = calibrateOne(id);
    if (!r) continue;
    out[id] = Math.round(r.factor * 1000) / 1000;
    meas[id] = [r.target.kmh, Math.round(r.t * 100) / 100];
    console.log(`${id.padEnd(16)} k=${r.k.toFixed(3)} factor=${out[id]}  t=${f(r.t, 2)}s for 0-${r.target.kmh} (target ${r.target.s})${r.limited ? '  [traction/gearing limited]' : ''}`);
  }
  const body = Object.keys(out).sort().map((k) => `  ${JSON.stringify(k)}: ${out[k]},`).join('\n');
  const mbody = Object.keys(meas).sort().map((k) => `  ${JSON.stringify(k)}: [${meas[k].join(', ')}],`).join('\n');
  writeFileSync(new URL('./calibration.js', import.meta.url), `// Generated by \`node src/vehicle/tune.mjs --calibrate\`: engine torque scale per catalog id so that the
// simulated 0-100 km/h (or the entry's own low-speed target) matches the catalog figure. Do not edit by hand.
export const CALIBRATION = {
${body}
};

// simulated [km/h, seconds] after calibration (traction-limited cars keep their nominal power)
export const MEASURED = {
${mbody}
};
`);
  console.log('calibration.js written');
  process.exit(0);
}

if (flag('--bounce')) {
  printBounce(ids.length ? ids : ['fulmine', 'roadhouse', 'piccola', 'arashi', 'rattler', 'aero', 'pip', 'meridian', 'tempesta', 'monarch', 'semi']);
  process.exit(0);
}

if (flag('--bikes')) {
  printBikes(ids.length ? ids : ['fulmine', 'roadhouse', 'piccola', 'arashi', 'rattler', 'aero', 'kickflip']);
  process.exit(0);
}

if (flag('--slopes')) {
  printSlopes(ids.length ? ids : ['pip', 'meridian', 'tempesta', 'monarch', 'kazoku', 'semi', 'city_bus', 'saam', 'fulmine', 'roadhouse', 'piccola', 'aero', 'boardwalk']);
  process.exit(0);
}

if (flag('--legacy') || !ids.length) {
  const list = flag('--legacy') && ids.length ? ids : PRESET_ORDER;
  const rows = [];
  for (const name of list) {
    const t0 = Date.now();
    const idle = testIdle(name);
    const slope = testSlopeHold(name);
    const acc = testAccel(name);
    const br = testBrake(name);
    const sk = testSkidpad(name);
    const lc = testLaneChange(name);
    const hb = testHandbrake(name);
    const crash = testCrash(name);
    const cj = testCurbAndJump(name);
    const po = testPowerOversteer(name);
    const hs = testHighSpeedSteer(name);
    const hsOff = testHighSpeedSteer(name, false);
    const lcOff = testLaneChange(name, false);
    const lift = testLiftOff(name);
    const rstep = testRoadStep(name);
    rows.push({ name, idle, slope, acc, br, sk, lc, hb, crash, cj, po, hs, hsOff, lcOff, lift, rstep, ms: Date.now() - t0 });
  }
  const targets = { comet: [4.2, 245], muscle: [5.0, 220], super: [3.0, 300], suv: [7.0, 185], pickup: [null, 175], cruiser: [null, 232] };
  console.log('');
  console.log('preset   | crash 300: NaN, maxV after hit, maxω, glance maxω, up | curb vy, jump air s, min up | ramp110: pitchω, air s, min up | RWD power: maxβ°, rot° | 160 full-lock: β° on/off, lat g | lane chg no assists: maxβ°, yaw° | lift-off: maxβ°, yaw ovs | 8cm step: vert jolt g, roll/pitch ω');
  console.log('-'.repeat(150));
  for (const r of rows) {
    console.log([
      r.name.padEnd(8),
      `${r.crash.bad ? 'NaN!' : 'ok'}, ${f(r.crash.maxV, 1)}, ${f(r.crash.maxW, 1)}, ${f(r.crash.glanceMaxW, 1)}, ${f(r.crash.glanceUp, 2)}`.padEnd(48),
      `${f(r.cj.curbVy, 2)}, ${f(r.cj.airTime, 2)}, ${f(r.cj.minUp, 2)}`.padEnd(26),
      `${f(r.cj.rampPitchRate, 2)}, ${f(r.cj.rampAir, 2)}, ${f(r.cj.rampMinUp, 2)}${r.cj.rampUpright ? '' : ' FLIP'}`.padEnd(22),
      `${f(r.po.maxBetaDeg, 1)}, ${f(r.po.rotDeg, 0)}`.padEnd(22),
      `${f(r.hs.maxBetaDeg, 1)}/${f(r.hsOff.maxBetaDeg, 1)}, ${f(r.hs.latG, 2)}`.padEnd(30),
      `${f(r.lcOff.maxBetaDeg, 1)}, ${f(r.lcOff.finalYawDeg, 1)}`.padEnd(14),
      `${f(r.lift.maxBetaDeg, 1)}, ${f(r.lift.yawOvershoot, 2)}`.padEnd(14),
      `${f(r.rstep.maxVy, 2)}, ${f(r.rstep.maxRate, 2)}`,
    ].join(' | '));
  }
  console.log('');
  console.log('preset   | 0-100 s | top km/h (tgt) | 100-0 m | skidpad g | lane chg: off m, maxβ°, yaw° | hbrake: rot°, recov s | idle |v| m/s | slope15 drift m');
  console.log('-'.repeat(150));
  for (const r of rows) {
    const tg = targets[r.name] || [];
    console.log([
      r.name.padEnd(8),
      `${f(r.acc.t100, 2).padStart(5)}${tg[0] ? ` (${tg[0]})` : '      '}`,
      `${f(r.acc.vmaxKmh, 0).padStart(4)} (${tg[1] ?? VEHICLE_PRESETS[r.name]?.gearbox?.topSpeedKmh})`.padEnd(14),
      f(r.br.dist, 1).padStart(6),
      f(r.sk.latG, 2).padStart(8),
      `${f(r.lc.offset, 1).padStart(6)}, ${f(r.lc.maxBetaDeg, 1).padStart(4)}, ${f(r.lc.finalYawDeg, 1).padStart(5)}`.padEnd(29),
      `${f(r.hb.rotDeg, 0).padStart(5)}, ${f(r.hb.recoveredAt, 1).padStart(5)}${r.hb.upright ? '' : ' FLIP'}`.padEnd(21),
      f(r.idle.maxV, 4).padStart(8),
      f(r.slope.drift, 4).padStart(8),
    ].join(' | '));
  }
  console.log('');
  if (flag('--legacy')) process.exit(0);
  ids = ['pip', 'meridian', 'kanzler_s', 'chantry', 'orkan_ts', 'tempesta', 'hammerhead', 'grandview', 'monarch', 'prospector', 'sawbuck', 'kazoku', 'regent_stretch', 'taxi',
    'box_truck', 'semi', 'dump', 'fire_engine', 'city_bus', 'coach', 'bolla', 'birdie', 'saam', 'hatake', 'fulmine', 'roadhouse', 'piccola', 'arashi', 'rattler', 'aero', 'kickflip', 'boardwalk'];
}

const rows = [];
for (const id of ids) {
  if (!VEHICLE_PRESETS[id]) {
    console.log('unknown id', id);
    continue;
  }
  rows.push(catalogRow(id));
  if (flag('-v')) console.log(JSON.stringify(rows[rows.length - 1]));
}
printCatalog(rows);
}
