// Tank handling metrics (headless): node src/vehicle/tank/handling.mjs
// step steer @30/@60 km/h (yaw-rate overshoot, rise time, oscillation, sideslip), lane change settling @50,
// slalom @50, 60→0 braking, top speed over bumps.
import RAPIER from '@dimforge/rapier3d-compat';
import { TankPhysics } from './TankPhysics.js';
import { GROUPS, groups } from '../groups.js';

const DT = 1 / 60;
const KMH = 1 / 3.6;
await RAPIER.init();

function world0(bumps) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(0.9).setCollisionGroups(groups(GROUPS.GROUND)), gb);
  if (bumps) {
    // uneven road: ridges and potholes' edges 4–12 cm high under one track or both, every 1.5–5 m along -Z
    let z = -10, s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    while (z > -1500) {
      const h = 0.04 + rnd() * 0.08, len = 0.3 + rnd() * 1.5, k = rnd();
      const x = k < 0.35 ? -1.45 : k < 0.7 ? 1.45 : 0, w = k < 0.7 ? 0.5 : 2.5;
      world.createCollider(RAPIER.ColliderDesc.cuboid(w, h / 2, len / 2).setTranslation(x, h / 2, z).setFriction(0.9).setCollisionGroups(groups(GROUPS.GROUND)), gb);
      z -= 1.5 + rnd() * 3.5;
    }
  }
  world.step();
  return world;
}
const fwdOf = (b) => { const q = b.rotation(); return { x: -2 * (q.x * q.z + q.w * q.y), y: -2 * (q.y * q.z - q.w * q.x), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) }; };
const yawOf = (b) => { const f = fwdOf(b); return Math.atan2(-f.x, -f.z); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function state(t) {
  const b = t.body, l = b.linvel(), f = fwdOf(b);
  const vF = l.x * f.x + l.y * f.y + l.z * f.z;
  const rx = -f.z, rz = f.x; // right in the ground plane
  const vR = l.x * rx + l.z * rz;
  const q = b.rotation();
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  return { vF, vR, r: -b.angvel().y /* clockwise + */, beta: Math.atan2(vR, Math.max(0.5, Math.abs(vF))), yaw: yawOf(b), upY, av: b.angvel(), y: b.translation().y };
}
function spawn(bumps) {
  const world = world0(bumps);
  const t = new TankPhysics({ RAPIER, world, position: { x: 0, y: 0, z: 0 }, yaw: 0 });
  for (let i = 0; i < 90; i++) { t.fixedUpdate(DT, {}); world.step(); }
  return { world, t };
}
const step = (w, t, inp) => { t.fixedUpdate(DT, inp); w.step(); };
function cruise(w, t, kmh, secs = 0) {
  const thr = Math.min(1, (kmh * KMH) / t.spec.topSpeed);
  for (let i = 0; i < 60 * 40; i++) { step(w, t, { throttle: thr }); if (state(t).vF >= kmh * KMH - 0.05 && i > 60) break; }
  for (let i = 0; i < 60 * secs; i++) step(w, t, { throttle: thr });
  return thr;
}

export function stepSteer(kmh, steer = 1) {
  const { world, t } = spawn();
  const thr = cruise(world, t, kmh, 2);
  const rs = [], betas = [];
  for (let i = 0; i < 60 * 6; i++) { step(world, t, { throttle: thr, steer }); const s = state(t); rs.push(s.r); betas.push(Math.abs(s.beta)); }
  const ss = rs.slice(-60).reduce((a, b) => a + b, 0) / 60;
  const peak = Math.max(...rs);
  const t90 = rs.findIndex((r) => r >= 0.9 * ss) / 60;
  // oscillation: sign changes of (r - ss) after first reaching 90 %
  let osc = 0, prev = 0;
  for (let i = Math.max(0, Math.round(t90 * 60)); i < rs.length; i++) { const d = rs[i] - ss; if (Math.abs(d) > 0.01 * Math.abs(ss) && Math.sign(d) !== prev) { if (prev) osc++; prev = Math.sign(d); } }
  return { kmh, ss, peak, overshoot: (peak - ss) / ss, t90, osc, betaMax: Math.max(...betas) * 57.3, speedEnd: state(t).vF / KMH };
}

export function laneChange(kmh = 50, hold = 0.8) {
  const { world, t } = spawn();
  const thr = cruise(world, t, kmh, 2);
  const yaw0 = state(t).yaw;
  const n1 = Math.round(hold * 60);
  for (let i = 0; i < n1; i++) step(world, t, { throttle: thr, steer: 1 });
  for (let i = 0; i < n1; i++) step(world, t, { throttle: thr, steer: -1 });
  let settle = null, maxErr = 0, betaMax = 0;
  for (let i = 0; i < 60 * 8; i++) {
    step(world, t, { throttle: thr });
    const s = state(t);
    betaMax = Math.max(betaMax, Math.abs(s.beta));
    const quiet = Math.abs(s.r) < 0.01 && Math.abs(s.vR) < 0.08;
    if (quiet && settle === null) settle = i / 60;
    if (!quiet) settle = null;
    maxErr = Math.max(maxErr, Math.abs(wrap(s.yaw - yaw0)));
  }
  const s = state(t);
  return { kmh, settle, headingErr: wrap(s.yaw - yaw0) * 57.3, betaMax: betaMax * 57.3 };
}

export function slalom(kmh = 50, period = 2.4, secs = 14) {
  const { world, t } = spawn();
  const thr = cruise(world, t, kmh, 1);
  let betaMax = 0, rMax = 0, minUp = 1;
  const yaw0 = state(t).yaw;
  let headMax = 0;
  for (let i = 0; i < 60 * secs; i++) {
    const steer = Math.sin((i / 60) * 2 * Math.PI / period) > 0 ? 1 : -1;
    step(world, t, { throttle: thr, steer });
    const s = state(t);
    betaMax = Math.max(betaMax, Math.abs(s.beta)); rMax = Math.max(rMax, Math.abs(s.r)); minUp = Math.min(minUp, s.upY);
    headMax = Math.max(headMax, Math.abs(wrap(s.yaw - yaw0)));
  }
  return { kmh, betaMax: betaMax * 57.3, rMax, headMax: headMax * 57.3, minUp, speedEnd: state(t).vF / KMH, spun: headMax > Math.PI / 2 };
}

export function brake(kmh = 60) {
  const { world, t } = spawn();
  const thr = cruise(world, t, kmh, 1);
  const p0 = { ...t.body.translation() };
  const yaw0 = state(t).yaw;
  let pitchMax = 0, yawDev = 0, time = 0;
  for (let i = 0; i < 60 * 10; i++) {
    step(world, t, { brake: 1 });
    time += DT;
    const s = state(t), f = fwdOf(t.body);
    pitchMax = Math.max(pitchMax, -Math.asin(f.y)); // nose down +
    yawDev = Math.max(yawDev, Math.abs(wrap(s.yaw - yaw0)));
    if (s.vF < 0.05) break;
  }
  const p1 = t.body.translation();
  return { kmh, dist: Math.hypot(p1.x - p0.x, p1.z - p0.z), time, pitchMax: pitchMax * 57.3, yawDev: yawDev * 57.3 };
}

export function bumpy(throttle = 1, secs = 25) {
  const { world, t } = spawn(true);
  let n = 0, sumRoll = 0, sumPitch = 0, sumYaw = 0, maxYaw = 0, minUp = 1;
  const yaw0 = state(t).yaw;
  let maxHead = 0, sumVy = 0;
  for (let i = 0; i < 60 * secs; i++) {
    step(world, t, { throttle });
    if (i < 60 * 8) continue; // at speed
    const s = state(t), f = fwdOf(t.body);
    const rx = -f.z, rz = f.x;
    const wr = s.av.x * f.x + s.av.z * f.z, wp = s.av.x * rx + s.av.z * rz;
    sumRoll += wr * wr; sumPitch += wp * wp; sumYaw += s.r * s.r; n++;
    sumVy += t.body.linvel().y ** 2;
    maxYaw = Math.max(maxYaw, Math.abs(s.r)); minUp = Math.min(minUp, s.upY);
    maxHead = Math.max(maxHead, Math.abs(wrap(s.yaw - yaw0)));
  }
  const rms = (x) => Math.sqrt(x / n);
  return { speed: state(t).vF / KMH, rollRms: rms(sumRoll), pitchRms: rms(sumPitch), yawRms: rms(sumYaw), vyRms: rms(sumVy), maxYawRate: maxYaw, heading: maxHead * 57.3, minUp };
}

export function report() {
  const f = (x, d = 2) => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toFixed(d) : String(x));
  const out = [];
  for (const k of [30, 60]) {
    const r = stepSteer(k);
    out.push(`step steer @${k}: ss ${f(r.ss, 3)} rad/s, peak ${f(r.peak, 3)}, overshoot ${f(r.overshoot * 100, 1)} %, t90 ${f(r.t90)} s, oscillations ${r.osc}, max sideslip ${f(r.betaMax, 1)}°, end speed ${f(r.speedEnd, 1)} km/h`);
  }
  for (const k of [30, 60]) {
    const r = stepSteer(k, 0.5);
    out.push(`half steer @${k}: ss ${f(r.ss, 3)} rad/s, overshoot ${f(r.overshoot * 100, 1)} %, t90 ${f(r.t90)} s, osc ${r.osc}`);
  }
  for (const k of [50, 60]) {
    const r = laneChange(k);
    out.push(`lane change @${k}: settling ${f(r.settle)} s after release, final heading err ${f(r.headingErr, 1)}°, max sideslip ${f(r.betaMax, 1)}°`);
  }
  const s = slalom(50);
  out.push(`slalom @50 (±1, 2.4 s): max sideslip ${f(s.betaMax, 1)}°, max yaw rate ${f(s.rMax, 3)}, max heading dev ${f(s.headMax, 1)}°, end speed ${f(s.speedEnd, 1)} km/h, spun ${s.spun}, min up.y ${f(s.minUp, 3)}`);
  const b = brake(60);
  out.push(`brake 60→0: ${f(b.dist, 1)} m in ${f(b.time)} s, nose dive ${f(b.pitchMax, 2)}°, heading change ${f(b.yawDev, 2)}°`);
  const u = bumpy();
  out.push(`bumpy road full throttle: ${f(u.speed, 1)} km/h, roll-rate rms ${f(u.rollRms, 3)}, pitch-rate rms ${f(u.pitchRms, 3)}, yaw-rate rms ${f(u.yawRms, 4)} (max ${f(u.maxYawRate, 3)}), vy rms ${f(u.vyRms, 3)}, heading drift ${f(u.heading, 2)}°, min up.y ${f(u.minUp, 3)}`);
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(report());
