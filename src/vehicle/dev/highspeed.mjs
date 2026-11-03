// High-speed handling harness (supercars vs a sedan control), headless:
//   node src/vehicle/dev/highspeed.mjs [ids]        smooth (gamepad-like) path-following driver
//   KB=1 node src/vehicle/dev/highspeed.mjs [ids]   keyboard player through the real DriveInput (LEGACY=1: without the
//       cars' keyboard yaw-rate steering). The player wants a lateral acceleration (path curvature seen ~0.4 s ahead +
//       a PD/I on the lateral error, KBG=ω,ζ, default 2,0.9), knows how much a key gives, taps the key so its average
//       follows (sigma-delta, key states ≥ 0.08 s) and reacts 0.12 s late but anticipates it.
//   Tuning knobs: KBS='{"tauIn":0.15}' (VehiclePhysics.KB_STEER), RAMP='{"up":6}' (Input.KB_RAMP),
//   TRACE=id,R,kmh (log one curve run).
// Columns: steady lateral g at full steer @150/220/280; peak sideslip when lifting + braking mid-corner @160/220;
// keyboard yank (0.8 s full key) peak sideslip / yaw rate; 3.5 m lane change in 1.6 s @150/220/280 (ok = max path
// error < 1 m, sideslip < 6°); max stable speed on R200 / R400 arcs after a 1.5 s straight (error < 1.5 m from 1 s
// into the arc, sideslip < 8°) and its g.
import { spawn, step, prime, holdSpeed, fwdSpeed, testTurn } from '../tune.mjs';
import { getCatalogEntry } from '../catalog.js';
import { DriveInput, KB_RAMP } from '../Input.js';
import { KB_STEER } from '../physics/VehiclePhysics.js';
if (process.env.KBS) Object.assign(KB_STEER, JSON.parse(process.env.KBS));
if (process.env.RAMP) Object.assign(KB_RAMP, JSON.parse(process.env.RAMP));
const LEGACY = process.env.LEGACY === '1';
const HOLD = +(process.env.HOLD ?? 5), DELAY = +(process.env.DELAY ?? 7);
let KBG = (process.env.KBG || '2,0.9').split(',').map(Number); // keyboard without the yaw-rate steering assist (the pre-assist car path)
// the real DriveInput driven by a key set; returns the input object the game would pass to the vehicle
function keyboard() {
  const di = new DriveInput({ target: new EventTarget() });
  return {
    di,
    update(key, kmh, extra = {}) {
      di.down.clear();
      if (key > 0) di.down.add('KeyD'); else if (key < 0) di.down.add('KeyA');
      const s = { ...di.update(DT, kmh), ...extra };
      if (LEGACY) { s.digital = false; delete s.steerKb; }
      return s;
    },
  };
}
const DT = 1 / 60, KMH = 1 / 3.6;
const pre = (id) => getCatalogEntry(id).preset;
const fwdOf = (v) => { const q = v.body.rotation(); return { x: -(2 * (q.x * q.z + q.w * q.y)), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) }; };
// path follower on p(s) (arc length s → x,z)
function drive(v, world, path, kmh, T, kb, settle = 0) {
  const keyQ = []; const kbIn = keyboard(); let lastKey = 0, acc = 0, held = 0, kI = 0;
  const integ = { i: 0.3 };
  let maxErr = 0, maxBeta = 0, spun = false, sMax = 0, ie = 0;
  const st = v.spec.steering;
  for (let t = 0; t < T; t += DT) {
    const p = v.body.translation(), f = fwdOf(v), sp = fwdSpeed(v);
    // nearest s (search forward)
    let best = 1e9, bs = sMax;
    for (let s = sMax; s < sMax + 20; s += 0.25) { const q = path(s); const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < best) { best = d; bs = s; } }
    sMax = bs;
    if (t >= settle) maxErr = Math.max(maxErr, Math.sqrt(best));
    // Stanley + curvature feed-forward + integral on cross-track
    const q0 = path(bs), q1 = path(bs + 1), q2 = path(bs + 2);
    const tx = q1.x - q0.x, tz = q1.z - q0.z, tn = Math.hypot(tx, tz);
    const hx = q2.x - q1.x, hz = q2.z - q1.z;
    const nx = -tz / tn, nz = tx / tn; // path right
    const kapR = (hx * nx + hz * nz) / (tn * tn); // + = path bends right
    const e = (p.x - q0.x) * nx + (p.z - q0.z) * nz; // + = car right of path
    const he = Math.atan2(f.x * nx + f.z * nz, (f.x * tx + f.z * tz) / tn); // + = car heading right of tangent
    ie = Math.max(-3, Math.min(3, ie + e * DT));
    const delta = Math.atan(v.spec.wheelbase * kapR) - Math.atan((1.0 * e + 0.5 * ie) / Math.max(sp, 5)) - 0.9 * he;
    const lock = (st.maxLockDeg * Math.PI / 180) / (1 + Math.abs(sp) / st.speedRef);
    const c = holdSpeed(v, kmh * KMH, integ);
    let u = Math.max(-1, Math.min(1, delta / lock));
    let inp = { throttle: c.throttle, brake: c.brake, steer: u };
    if (kb) {
      // keyboard player: wants a continuous steer input u and taps the key so that its average follows u
      // (sigma-delta), 0.12 s reaction delay. u is what this car's steering needs: a wheel-angle share (legacy) or a
      // yaw-rate share of the grip (keyboard steering assist)
      // the same lateral-error PID for both steering models, in lateral acceleration (ω, ζ from KBG); the player
      // has learned how much lateral g a key share gives: a wheel angle (legacy) or a share of the grip (assist)
      const [wn, zeta] = KBG;
      // the player anticipates his own reaction delay (where the car will be when the key takes effect)
      const Td = DELAY * DT;
      const aRel = -v.body.angvel().y * sp - kapR * sp * sp; // lateral accel relative to the path, + = right
      const eDot = sp * Math.sin(he) + aRel * Td;
      const eP = e + sp * Math.sin(he) * Td + 0.5 * aRel * Td * Td;
      kI = Math.max(-30, Math.min(30, kI + e * DT));
      // the player sees the road ahead: the bend's feed-forward comes from where the car will be in ~0.4 s
      const qa = path(bs + sp * (Td + 0.25)), qb = path(bs + sp * (Td + 0.25) + 1), qc = path(bs + sp * (Td + 0.25) + 2);
      const t1x = qb.x - qa.x, t1z = qb.z - qa.z, t1n = Math.hypot(t1x, t1z);
      const kapP = ((qc.x - qb.x) * (-t1z / t1n) + (qc.z - qb.z) * (t1x / t1n)) / (t1n * t1n);
      const aDes = kapP * sp * sp - (wn * wn * eP + 2 * zeta * wn * eDot + 0.15 * wn * wn * kI);
      const gain = LEGACY
        ? (sp * sp * lock * (1 - 0.32 * Math.max(0, Math.min(1, (sp * 3.6 - 40) / 160)))) / v.spec.wheelbase
        : v.spec.tire.mu * 9.81 * 0.95 * (1 + (0.5 * 1.225 * v.spec.aero.cla * sp * sp) / (v.spec.mass * 9.81));
      let uDes = aDes / gain;
      uDes = Math.max(-1, Math.min(1, uDes));
      acc = Math.max(-0.2, Math.min(0.2, acc + (uDes - lastKey) * DT));
      // a key state lasts at least 0.08 s (≤ ~6 taps a second)
      const want = acc > 0.04 ? 1 : acc < -0.04 ? -1 : 0;
      if (want !== lastKey && held >= HOLD) { lastKey = want; held = 0; } else held++;
      keyQ.push(lastKey);
      const key = keyQ.length > DELAY ? keyQ.shift() : 0;
      inp = kbIn.update(key, sp * 3.6, { throttle: c.throttle, brake: c.brake });
      if (process.env.TRACE && Math.round(t * 60) % 6 === 0) console.log(t.toFixed(2), 'e', e.toFixed(2), 'he', (he * 57.3).toFixed(1), 'u', uDes.toFixed(2), 'r', v.body.angvel().y.toFixed(3), 'acc', acc.toFixed(2), 'key', key, 'kb', (inp.steerKb ?? inp.steer).toFixed(2), 'st', (v.steerAngle * 57.3).toFixed(2), 'b', (v.telemetry.slipAngle * 57.3).toFixed(1));
    }
    step(v, world, inp);
    const b = Math.abs(v.telemetry.slipAngle || 0) * 57.3;
    maxBeta = Math.max(maxBeta, b);
    if (b > 45) spun = true;
  }
  return { maxErr, maxBeta, spun, end: fwdSpeed(v) * 3.6 };
}
function curveTest(id, R, kmh, T = 7, kb) {
  const { world, v } = spawn(pre(id));
  prime(v, world, kmh * KMH);
  const p0 = v.body.translation();
  // 1.5 s of straight, then a right-hand arc (centre at +x); the error counts from 1 s into the arc (holding the
  // bend; entry is a separate skill)
  const S0 = kmh * KMH * 1.5;
  const path = (s) => (s < S0 ? { x: p0.x, z: p0.z - s } : { x: p0.x + R - R * Math.cos((s - S0) / R), z: p0.z - S0 - R * Math.sin((s - S0) / R) });
  const r = drive(v, world, path, kmh, T + 1.5, kb, 2.5);
  return r;
}
function laneChange(id, kmh, kb) {
  const { world, v } = spawn(pre(id));
  prime(v, world, kmh * KMH);
  const p0 = v.body.translation();
  const D = kmh * KMH * 1.6, S0 = 15;
  const path = (s) => { const u = Math.max(0, Math.min(1, (s - S0) / D)); return { x: p0.x + 3.5 * (1 - Math.cos(Math.PI * u)) / 2, z: p0.z - s }; };
  return drive(v, world, path, kmh, 1.6 + 4 + S0 / (kmh * KMH), kb);
}
function maxStable(id, R, kb) {
  let best = 0;
  for (let k = 80; k <= 340; k += 10) {
    const r = curveTest(id, R, k, 7, kb);
    if (r.spun || r.maxErr > 1.5 || r.maxBeta > 8 || r.end < k - 15) break;
    best = k;
  }
  return best;
}
function yank(id, kmh) {
  // full right key for 0.8 s then release: peak sideslip / yaw rate
  const { world, v } = spawn(pre(id));
  prime(v, world, kmh * KMH);
  const integ = { i: 0.3 };
  const kbIn = keyboard();
  let maxB = 0, maxR = 0;
  for (let t = 0; t < 4; t += DT) {
    const c = holdSpeed(v, kmh * KMH, integ);
    step(v, world, kbIn.update(t < 0.8 ? 1 : 0, fwdSpeed(v) * 3.6, { throttle: c.throttle, brake: c.brake }));
    maxB = Math.max(maxB, Math.abs(v.telemetry.slipAngle || 0) * 57.3);
    maxR = Math.max(maxR, Math.abs(v.body.angvel().y));
  }
  return `${maxB.toFixed(1)}°/${maxR.toFixed(2)}`;
}
function liftOff(id, kmh, R = 250) {
  // steady corner near the limit, then snap the throttle shut and stab the brakes: peak sideslip
  const { world, v } = spawn(pre(id));
  prime(v, world, kmh * KMH);
  const p0 = v.body.translation();
  const path = (s) => ({ x: p0.x + R - R * Math.cos(s / R), z: p0.z - R * Math.sin(s / R) });
  // reuse drive for 3 s, then brake 0.6 while still steering
  drive(v, world, path, kmh, 3);
  let maxB = 0;
  for (let t = 0; t < 2; t += DT) { step(v, world, { throttle: 0, brake: t < 1 ? 0.6 : 0, steer: v.input.steer }); maxB = Math.max(maxB, Math.abs(v.telemetry.slipAngle || 0) * 57.3); }
  return maxB.toFixed(1);
}
const KB = process.env.KB === '1';
if (process.env.TRACE) { const [id, R, k] = process.env.TRACE.split(','); console.log(curveTest(id, +R, +k, 5, true)); process.exit(0); }
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['tempesta', 'saetta', 'peregrine', 'aurora', 'super', 'orkan_ts', 'meridian'];
console.log('id        | ss g @150 220 280 | lane chg 150/220/280 (err m, beta°)              | max km/h R200 (g) | R400 (g)');
for (const id of ids) {
  const g = [150, 220, 280].map((k) => testTurn(pre(id), k, 1, 6).latG.toFixed(2)).join(' ');
  const lc = [150, 220, 280].map((k) => { const r = laneChange(id, k, KB); return `${r.spun ? 'SPIN' : r.maxErr < 1 && r.maxBeta < 6 ? 'ok' : 'FAIL'} ${r.maxErr.toFixed(2)}/${r.maxBeta.toFixed(1)}`; }).join(' | ');
  const m2 = maxStable(id, 200, KB), m4 = maxStable(id, 400, KB);
  console.log(`${id.padEnd(9)} | ${g} | lift ${[160,220].map((k)=>liftOff(id,k)).join('/')}° | yank ${[150,220,280].map((k)=>yank(id,k)).join(' ')} | ${lc} | ${m2} (${((m2 / 3.6) ** 2 / 200 / 9.81).toFixed(2)}) | ${m4} (${((m4 / 3.6) ** 2 / 400 / 9.81).toFixed(2)})`);
}
