// Procedural poses for the humanoid rig (see rig.js for conventions). Every function writes a full target pose;
// callers blend the current pose towards it (blendPose) so transitions stay smooth without per-state blend trees.
import { J, ROOT, POSE_LEN, legExtent } from './rig.js';

const { sin, cos, max, min, abs, PI } = Math;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

export const newPose = () => new Float32Array(POSE_LEN);
const X = (j) => j * 3, Y = (j) => j * 3 + 1, Z = (j) => j * 3 + 2;

export function blendPose(cur, tgt, k) {
  for (let i = 0; i < POSE_LEN; i++) cur[i] += (tgt[i] - cur[i]) * k;
}
export function lerpPose(out, a, b, t) {
  for (let i = 0; i < POSE_LEN; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

function arms(P, abd, elbow, fwd = 0) {
  P[Z(J.UARM_L)] = -abd; P[Z(J.UARM_R)] = abd;
  P[X(J.UARM_L)] = fwd; P[X(J.UARM_R)] = fwd;
  P[X(J.LARM_L)] = elbow; P[X(J.LARM_R)] = elbow;
}

// put the lower (stance) foot on the ground: pelvis height from leg geometry
export function groundLegs(P, d) {
  const eL = legExtent(d, P[X(J.ULEG_L)], P[X(J.LLEG_L)]);
  const eR = legExtent(d, P[X(J.ULEG_R)], P[X(J.LLEG_R)]);
  P[ROOT + 1] += max(eL, eR) - (d.thigh + d.shin);
}

// age / build specific posture on top of any upright pose
export function posture(P, d, k = 1) {
  if (d.stoop) {
    P[X(J.SPINE)] -= 0.14 * k; P[X(J.CHEST)] -= 0.12 * k; P[X(J.NECK)] += 0.1 * k; P[X(J.HEAD)] += 0.1 * k;
    P[X(J.LLEG_L)] -= 0.08 * k; P[X(J.LLEG_R)] -= 0.08 * k; P[X(J.ULEG_L)] += 0.05 * k; P[X(J.ULEG_R)] += 0.05 * k;
  }
  if (d.build === 'heavy') { P[Z(J.UARM_L)] -= 0.1 * k; P[Z(J.UARM_R)] += 0.1 * k; P[X(J.SPINE)] += 0.04 * k; }
}

// ---------- standing ----------
export function poseIdle(P, t, seed, d) {
  P.fill(0);
  const br = sin(t * 1.7 + seed);
  P[X(J.CHEST)] = 0.018 * br;
  P[X(J.NECK)] = -0.01 * br;
  const ws = sin(t * 0.42 + seed * 3.1);
  P[Z(J.PELVIS)] = 0.035 * ws;
  P[ROOT] = 0.018 * ws * d.h;
  P[Z(J.ULEG_L)] = -0.035 * ws; P[Z(J.ULEG_R)] = -0.035 * ws;
  P[Z(J.SPINE)] = -0.03 * ws;
  const l = max(0, ws), r = max(0, -ws);
  P[X(J.ULEG_L)] = 0.03 + 0.06 * l; P[X(J.LLEG_L)] = -0.04 - 0.12 * l; P[X(J.FOOT_L)] = 0.04 * l;
  P[X(J.ULEG_R)] = 0.03 + 0.06 * r; P[X(J.LLEG_R)] = -0.04 - 0.12 * r; P[X(J.FOOT_R)] = 0.04 * r;
  arms(P, 0.08, 0.14 + 0.02 * br, 0.03);
  const look = sin(t * 0.21 + seed * 7.3);
  P[Y(J.HEAD)] = 0.42 * look * look * look;
  P[Y(J.NECK)] = 0.12 * look;
  P[X(J.HEAD)] = 0.05 * sin(t * 0.13 + seed);
  posture(P, d);
  groundLegs(P, d);
  return P;
}

// ---------- locomotion: walk (~1.4 m/s) .. run (~4) .. sprint (~7) ----------
// opts: { limp 0..1, carry 0..1 (left hand bag), carryR 0..1, phoneR (0 none, 1 ear, 2 text), stumble 0..1, time }
export function poseGait(P, phase, speed, d, opts = null) {
  P.fill(0);
  const r = smooth(1.9, 4.2, speed);
  const s = smooth(4.8, 7.2, speed);
  const w = clamp(speed / 1.3, 0, 1);
  const hipAmp = (lerp(0.4, 0.68, r) + 0.24 * s) * w;
  const kneeSw = (lerp(0.72, 1.45, r) + 0.45 * s) * w;
  const kneeSt = lerp(0.06, 0.32, r);
  const armAmp = (lerp(0.3, 0.55, r) + 0.38 * s) * w;
  const elbow = lerp(0.18, 1.35, r) + 0.12 * s;
  const lean = lerp(0.03, 0.15, r) + 0.16 * s;
  const limp = opts?.limp || 0;
  for (let side = 0; side < 2; side++) {
    const p = phase + side * PI;
    const sn = sin(p), cs = cos(p);
    const ul = side ? J.ULEG_R : J.ULEG_L, ll = side ? J.LLEG_R : J.LLEG_L, ft = side ? J.FOOT_R : J.FOOT_L;
    const stiff = side === 1 ? limp : 0;
    P[X(ul)] = hipAmp * sn * (1 - 0.45 * stiff) + 0.12 * r;
    P[X(ll)] = -(kneeSt + kneeSw * Math.pow(max(0, cs), 1.4)) * (1 - 0.8 * stiff);
    P[X(ft)] = 0.18 * cs * w - 0.12 * r * max(0, -sn);
    const ua = side ? J.UARM_R : J.UARM_L, la = side ? J.LARM_R : J.LARM_L;
    // arm swings with the opposite leg
    P[X(ua)] = -armAmp * sn + 0.05 * r;
    P[Z(ua)] = (side ? 1 : -1) * (0.07 + 0.1 * r);
    P[X(la)] = elbow + 0.35 * r * max(0, -sn);
  }
  P[Y(J.PELVIS)] = 0.1 * sin(phase) * (0.6 + r);
  P[Z(J.PELVIS)] = 0.045 * cos(phase) * w;
  P[Y(J.CHEST)] = -0.16 * sin(phase) * (0.6 + r);
  P[X(J.SPINE)] = -lean;
  P[X(J.CHEST)] = -0.02 * r;
  P[X(J.NECK)] = lean * 0.5;
  P[X(J.HEAD)] = lean * 0.4;
  if (limp) {
    P[Z(J.SPINE)] = 0.1 * limp * sin(phase);
    P[Z(J.UARM_L)] -= 0.25 * limp;
  }
  if (opts) {
    if (opts.carry) { P[X(J.UARM_L)] *= 0.25; P[X(J.LARM_L)] = 0.08; P[Z(J.UARM_L)] = -0.14; }
    if (opts.carryR) { P[X(J.UARM_R)] *= 0.25; P[X(J.LARM_R)] = 0.08; P[Z(J.UARM_R)] = 0.14; }
    if (opts.phoneR === 1) phoneEar(P);
    else if (opts.phoneR === 2) phoneText(P, true);
    if (opts.stumble) {
      const t = opts.time || 0, k = opts.stumble;
      P[Z(J.SPINE)] += 0.28 * k * sin(t * 4.3);
      P[X(J.SPINE)] -= 0.25 * k;
      P[Z(J.UARM_L)] -= k * (0.6 + 0.5 * sin(t * 7.1));
      P[Z(J.UARM_R)] += k * (0.6 + 0.5 * sin(t * 6.3 + 1));
      P[ROOT] += 0.08 * k * sin(t * 3.1) * d.h;
    }
  }
  posture(P, d, 1 - r * 0.6);
  // pelvis bob from leg geometry (stance foot planted) plus a little extra bounce when running
  groundLegs(P, d);
  P[ROOT + 1] += 0.025 * r * abs(cos(phase)) * d.h * (1 - limp);
  return P;
}

export function stepLength(speed, d) {
  const r = smooth(1.9, 4.2, speed), s = smooth(4.8, 7.2, speed);
  return (lerp(0.68, 1.3, r) + 0.5 * s) * (d.h / 1.76);
}

// ---------- overlays (modify an existing pose) ----------
export function phoneEar(P) {
  P[X(J.UARM_R)] = 0.55; P[Z(J.UARM_R)] = 0.42; P[Y(J.UARM_R)] = -0.3; P[X(J.LARM_R)] = 2.35;
  P[Z(J.HEAD)] = 0.08;
}
export function phoneText(P, walking = false) {
  P[X(J.UARM_R)] = 0.32; P[Z(J.UARM_R)] = 0.12; P[X(J.LARM_R)] = 1.5; P[Y(J.LARM_R)] = 0.5;
  if (!walking) { P[X(J.UARM_L)] = 0.3; P[Z(J.UARM_L)] = -0.12; P[X(J.LARM_L)] = 1.45; P[Y(J.LARM_L)] = -0.4; }
  P[X(J.HEAD)] = -0.42; P[X(J.NECK)] = -0.12;
}
export function poseChat(P, t, seed) {
  const v = seed % 3;
  const g1 = max(0, sin(t * 2.3 + seed)), g2 = sin(t * 3.1 + seed * 2);
  if (v < 1) { // gesturing with the right hand
    P[X(J.UARM_R)] = 0.35 + 0.3 * g1; P[Z(J.UARM_R)] = 0.18; P[X(J.LARM_R)] = 1.0 + 0.45 * g2; P[Y(J.LARM_R)] = 0.3;
  } else if (v < 2) { // hands on hips
    P[Z(J.UARM_L)] = -0.62; P[Z(J.UARM_R)] = 0.62; P[X(J.LARM_L)] = 1.7; P[X(J.LARM_R)] = 1.7;
    P[Y(J.UARM_L)] = 0.5; P[Y(J.UARM_R)] = -0.5;
  } else { // arms crossed
    P[X(J.UARM_L)] = 0.45; P[X(J.UARM_R)] = 0.48; P[X(J.LARM_L)] = 1.9; P[X(J.LARM_R)] = 1.95;
    P[Y(J.LARM_L)] = -0.9; P[Y(J.LARM_R)] = 0.9; P[Z(J.UARM_L)] = -0.08; P[Z(J.UARM_R)] = 0.08;
  }
  P[X(J.HEAD)] += 0.07 * sin(t * 2.7 + seed);
  P[Y(J.HEAD)] += 0.12 * sin(t * 0.7 + seed);
}
// reach forward-right (door handle)
export function poseReach(P, u) {
  P[X(J.UARM_R)] = lerp(P[X(J.UARM_R)], 1.25, u); P[Z(J.UARM_R)] = lerp(P[Z(J.UARM_R)], 0.3, u);
  P[X(J.LARM_R)] = lerp(P[X(J.LARM_R)], 0.25, u);
  P[Y(J.CHEST)] = lerp(P[Y(J.CHEST)], -0.2, u);
}

// ---------- air ----------
export function poseAir(P, t, vy, d) {
  P.fill(0);
  const up = clamp(vy / 4.5, -1, 1);
  if (up > -0.3) { // take-off tuck
    P[X(J.ULEG_L)] = 0.75; P[X(J.LLEG_L)] = -1.1; P[X(J.ULEG_R)] = -0.05; P[X(J.LLEG_R)] = -0.65;
    P[X(J.FOOT_L)] = 0.2; P[X(J.FOOT_R)] = -0.3;
    arms(P, 0.38, 0.5, 0.55);
    P[X(J.UARM_R)] = -0.25;
    P[X(J.SPINE)] = -0.08;
  } else { // falling: limbs out, flailing
    const f = sin(t * 9), g = sin(t * 7.3 + 1);
    P[X(J.ULEG_L)] = 0.3 + 0.25 * f; P[X(J.LLEG_L)] = -0.5 - 0.3 * g;
    P[X(J.ULEG_R)] = 0.3 - 0.25 * f; P[X(J.LLEG_R)] = -0.5 + 0.3 * g;
    P[Z(J.ULEG_L)] = -0.12; P[Z(J.ULEG_R)] = 0.12;
    arms(P, 1.05 + 0.25 * f, 0.4, 0.25 * g);
    P[X(J.SPINE)] = 0.08;
    P[X(J.HEAD)] = -0.2;
  }
  return P;
}

// landing absorb (k 0..1) on top of a pose
export function landOverlay(P, k, d) {
  if (k <= 0) return;
  P[X(J.ULEG_L)] += 0.95 * k; P[X(J.ULEG_R)] += 0.95 * k;
  P[X(J.LLEG_L)] -= 1.6 * k; P[X(J.LLEG_R)] -= 1.6 * k;
  P[X(J.FOOT_L)] += 0.55 * k; P[X(J.FOOT_R)] += 0.55 * k;
  P[X(J.SPINE)] -= 0.35 * k;
  P[X(J.UARM_L)] += 0.4 * k; P[X(J.UARM_R)] += 0.4 * k;
  P[ROOT + 1] = 0;
  groundLegs(P, d);
}

// forward roll (u 0..1); body curls, root spins around the pelvis
export function poseRoll(P, u, d) {
  P.fill(0);
  const c = sin(u * PI); // curl amount
  P[X(J.ULEG_L)] = 1.0 + 1.0 * c; P[X(J.ULEG_R)] = 0.9 + 1.0 * c;
  P[X(J.LLEG_L)] = -1.4 - 0.9 * c; P[X(J.LLEG_R)] = -1.3 - 0.9 * c;
  P[X(J.SPINE)] = -0.5 * c; P[X(J.CHEST)] = -0.3 * c; P[X(J.NECK)] = -0.4 * c; P[X(J.HEAD)] = -0.3 * c;
  arms(P, 0.3, 1.6, 1.2 * c);
  P[ROOT + 3] = -2 * PI * smooth(0.05, 0.95, u);
  P[ROOT + 1] = -(d.hipH - 0.42 * d.h * (0.55 + 0.45 * (1 - c)));
  return P;
}

// ---------- water ----------
export function poseSwim(P, phase, speed, t, d, under = 0) {
  P.fill(0);
  const k = clamp(speed / 1.6, 0, 1);
  P[ROOT + 3] = -lerp(0.35, 1.38, k) - 0.35 * under;
  P[ROOT + 1] = 0.3 * k * d.h / 1.76; // float higher when lying flat
  for (let side = 0; side < 2; side++) {
    const s = side ? 1 : -1;
    const p = phase + side * PI;
    const ua = side ? J.UARM_R : J.UARM_L, la = side ? J.LARM_R : J.LARM_L;
    const ul = side ? J.ULEG_R : J.ULEG_L, ll = side ? J.LLEG_R : J.LLEG_L;
    // crawl (moving) / sculling (treading)
    P[X(ua)] = lerp(0.35 * sin(t * 3 + side), 1.7 + 1.45 * sin(p), k);
    P[Z(ua)] = s * lerp(0.95 + 0.2 * sin(t * 3 + side), 0.35 + 0.35 * max(0, cos(p)), k);
    P[X(la)] = lerp(0.6, 0.35 + 0.5 * max(0, -sin(p)), k);
    P[X(ul)] = lerp(0.45 + 0.35 * sin(t * 2.6 + side * PI), 0.22 * sin(phase * 3 + side * PI), k);
    P[X(ll)] = lerp(-0.85 - 0.45 * cos(t * 2.6 + side * PI), -0.25 - 0.2 * max(0, sin(phase * 3 + side * PI)), k);
    P[X(side ? J.FOOT_R : J.FOOT_L)] = -0.5 * k;
  }
  // breathe: turn head every other stroke
  P[Y(J.HEAD)] = 0.75 * k * max(0, sin(phase)) ** 3;
  P[X(J.HEAD)] = 0.9 * k;
  P[X(J.NECK)] = 0.3 * k;
  return P;
}

// ---------- vehicles ----------
// kind: 'car'|'bike'|'bicycle'|'heli'|'plane'|'boat'; steer -1..1; pedal phase (bicycle)
export function poseSeat(P, kind, steer, t, d, pedal = 0, recl = null, legDrop = null) {
  P.fill(0);
  if (kind === 'bike' || kind === 'bicycle' || kind === 'motorcycle') {
    P[X(J.SPINE)] = -0.38; P[X(J.CHEST)] = -0.14; P[X(J.NECK)] = 0.24; P[X(J.HEAD)] = 0.22;
    P[X(J.ULEG_L)] = P[X(J.ULEG_R)] = 1.05; P[X(J.LLEG_L)] = P[X(J.LLEG_R)] = -1.7;
    P[X(J.FOOT_L)] = P[X(J.FOOT_R)] = 0.3;
    P[Z(J.ULEG_L)] = -0.12; P[Z(J.ULEG_R)] = 0.12;
    if (kind === 'bicycle') {
      P[X(J.ULEG_L)] = 0.95 + 0.35 * sin(pedal); P[X(J.LLEG_L)] = -1.25 - 0.55 * cos(pedal);
      P[X(J.ULEG_R)] = 0.95 + 0.35 * sin(pedal + PI); P[X(J.LLEG_R)] = -1.25 - 0.55 * cos(pedal + PI);
    }
    arms(P, 0.2, 0.32, 1.15);
    P[X(J.UARM_L)] += 0.12 * steer; P[X(J.UARM_R)] -= 0.12 * steer;
    P[Y(J.HEAD)] = -0.25 * steer;
    return P;
  }
  if (kind === 'boat') { // standing at the console
    P[X(J.ULEG_L)] = 0.08; P[X(J.ULEG_R)] = 0.12; P[X(J.LLEG_L)] = -0.14; P[X(J.LLEG_R)] = -0.2;
    P[Z(J.ULEG_L)] = -0.08; P[Z(J.ULEG_R)] = 0.08;
    arms(P, 0.1, 0.8, 0.7);
    P[X(J.UARM_L)] += 0.25 * steer; P[X(J.UARM_R)] -= 0.25 * steer;
    P[Y(J.HEAD)] = -0.3 * steer;
    P[X(J.HEAD)] = 0.03 * sin(t * 1.3);
    groundLegs(P, d);
    return P;
  }
  // seated: car, heli, plane
  const recline = recl ?? (kind === 'car' ? 0.2 : 0.06);
  P[X(J.SPINE)] = recline; P[X(J.CHEST)] = 0.04; P[X(J.NECK)] = -recline * 0.6; P[X(J.HEAD)] = -recline * 0.5;
  const hip = 1.38 + recline * 0.3;
  P[X(J.ULEG_L)] = P[X(J.ULEG_R)] = hip;
  let knee = -0.95;
  if (legDrop !== null) {
    // feet on the floor: the shin covers what is left of the hip-to-floor drop
    const rem = legDrop - d.thigh * cos(hip) - d.ankleH;
    knee = clamp(Math.acos(clamp(rem / d.shin, -0.3, 1)) - hip, -2.1, -0.12);
  }
  P[X(J.LLEG_L)] = P[X(J.LLEG_R)] = knee;
  P[X(J.FOOT_L)] = P[X(J.FOOT_R)] = 0.3;
  P[Z(J.ULEG_L)] = -0.06; P[Z(J.ULEG_R)] = 0.06;
  if (kind === 'heli' || kind === 'plane') {
    P[X(J.UARM_R)] = 0.55 + 0.12 * steer; P[Z(J.UARM_R)] = 0.12; P[X(J.LARM_R)] = 0.95;
    P[X(J.UARM_L)] = 0.4; P[Z(J.UARM_L)] = -0.22; P[X(J.LARM_L)] = 1.1;
    P[Y(J.HEAD)] = -0.18 * steer + 0.06 * sin(t * 0.5);
  } else {
    const reach = 1.12 - recline; // arms reach the wheel in world space whatever the seat recline
    P[X(J.UARM_L)] = reach + 0.28 * steer; P[X(J.UARM_R)] = reach - 0.28 * steer;
    P[Z(J.UARM_L)] = -0.12 + 0.12 * steer; P[Z(J.UARM_R)] = 0.12 + 0.12 * steer;
    P[X(J.LARM_L)] = 0.6 - 0.12 * steer; P[X(J.LARM_R)] = 0.6 + 0.12 * steer;
    P[Y(J.CHEST)] = -0.05 * steer;
    P[Y(J.HEAD)] = -0.32 * steer;
  }
  return P;
}

// ---------- down & getting up ----------
// lying on the ground: faceUp true = on the back. Pelvis rests ~0.11*h above the ground.
export function poseLie(P, faceUp, t, d, seed = 0) {
  P.fill(0);
  P[ROOT + 3] = faceUp ? PI / 2 : -PI / 2;
  P[ROOT + 1] = -(d.hipH - 0.075 * d.h);
  const sp = 0.4 + 0.3 * sin(seed * 5.1);
  P[Z(J.UARM_L)] = -sp - 0.3; P[Z(J.UARM_R)] = sp + 0.3;
  P[X(J.UARM_L)] = faceUp ? 0.2 : 0.4; P[X(J.UARM_R)] = faceUp ? 0.1 : 0.5;
  P[X(J.LARM_L)] = 0.5; P[X(J.LARM_R)] = 0.3;
  P[Z(J.ULEG_L)] = -0.15; P[Z(J.ULEG_R)] = 0.2;
  P[X(J.ULEG_L)] = 0.2 * sin(seed); P[X(J.LLEG_L)] = -0.25;
  P[X(J.LLEG_R)] = -0.1;
  P[X(J.FOOT_L)] = faceUp ? -0.3 : -1.0; P[X(J.FOOT_R)] = faceUp ? -0.4 : -1.0;
  P[Y(J.HEAD)] = 0.4 * sin(seed * 3);
  P[X(J.CHEST)] = 0.015 * sin(t * 1.6);
  return P;
}

const _kA = newPose(), _kB = newPose();
function seatedOnGround(P, d) {
  P.fill(0);
  P[ROOT + 3] = 0.3;
  P[ROOT + 1] = -(d.hipH - 0.075 * d.h);
  P[X(J.ULEG_L)] = P[X(J.ULEG_R)] = 1.25; P[X(J.LLEG_L)] = -0.9; P[X(J.LLEG_R)] = -0.3;
  P[X(J.SPINE)] = -0.25; P[X(J.CHEST)] = -0.2;
  arms(P, 0.25, 0.2, -0.6);
}
function pushUp(P, d) {
  P.fill(0);
  P[ROOT + 3] = -0.55;
  P[X(J.ULEG_L)] = P[X(J.ULEG_R)] = 1.5; P[X(J.LLEG_L)] = P[X(J.LLEG_R)] = -2.1;
  P[X(J.FOOT_L)] = P[X(J.FOOT_R)] = -0.6;
  arms(P, 0.12, 0.1, 1.0);
  P[X(J.HEAD)] = 0.4;
  P[ROOT + 1] = -(d.hipH - 0.24 * d.h);
}
function crouch(P, d) {
  P.fill(0);
  P[X(J.ULEG_L)] = 1.7; P[X(J.ULEG_R)] = 1.45; P[X(J.LLEG_L)] = -2.2; P[X(J.LLEG_R)] = -1.9;
  P[X(J.FOOT_L)] = P[X(J.FOOT_R)] = 0.5;
  P[X(J.SPINE)] = -0.55; P[X(J.CHEST)] = -0.15; P[X(J.HEAD)] = 0.35;
  arms(P, 0.15, 0.6, 0.6);
  groundLegs(P, d);
}

// u 0..1 from lying to standing
export function poseGetUp(P, u, faceUp, d) {
  const A = _kA, B = _kB;
  if (u < 0.35) {
    poseLie(A, faceUp, 0, d);
    if (faceUp) seatedOnGround(B, d); else pushUp(B, d);
    lerpPose(P, A, B, smooth(0, 0.35, u));
  } else if (u < 0.7) {
    if (faceUp) seatedOnGround(A, d); else pushUp(A, d);
    crouch(B, d);
    lerpPose(P, A, B, smooth(0.35, 0.7, u));
  } else {
    crouch(A, d);
    poseIdle(B, 0, 0, d);
    lerpPose(P, A, B, smooth(0.7, 1, u));
  }
  return P;
}

// dodge dive (u 0..1 of the flight), root yaw = dive direction
export function poseDive(P, u, d) {
  P.fill(0);
  P[ROOT + 3] = -lerp(0.4, 1.45, smooth(0, 0.5, u));
  arms(P, 0.25, 0.3, 2.7);
  P[X(J.ULEG_L)] = -0.15; P[X(J.ULEG_R)] = 0.1; P[X(J.LLEG_L)] = -0.3; P[X(J.LLEG_R)] = -0.6;
  P[X(J.HEAD)] = 0.45;
  P[ROOT + 1] = -d.hipH * 0.45 * smooth(0.3, 1, u);
  return P;
}

// knocked airborne tumble (not physics): limbs spread, root spin set by the caller
export function poseTumble(P, t, d) {
  P.fill(0);
  const f = sin(t * 11), g = sin(t * 8.3 + 2);
  arms(P, 1.2 + 0.4 * f, 0.6 + 0.4 * g, 0.6 * g);
  P[X(J.ULEG_L)] = 0.6 + 0.4 * f; P[X(J.ULEG_R)] = -0.2 + 0.4 * g;
  P[X(J.LLEG_L)] = -0.9; P[X(J.LLEG_R)] = -0.4;
  P[Z(J.ULEG_L)] = -0.3; P[Z(J.ULEG_R)] = 0.3;
  P[X(J.SPINE)] = 0.3 * g;
  return P;
}

export function poseCower(P, t, d) {
  crouch(P, d);
  P[X(J.UARM_L)] = 2.3; P[X(J.UARM_R)] = 2.4; P[Z(J.UARM_L)] = -0.35; P[Z(J.UARM_R)] = 0.35;
  P[X(J.LARM_L)] = 2.0; P[X(J.LARM_R)] = 2.0;
  P[X(J.HEAD)] = -0.45; P[X(J.SPINE)] = -0.7;
  P[Y(J.SPINE)] = 0.05 * sin(t * 13);
  return P;
}

// climbing a ledge (u 0..1): hands up, knee up, then push
export function poseClimb(P, u, d) {
  P.fill(0);
  const a = sin(u * PI);
  arms(P, 0.2, 0.4 + 0.8 * a, 2.6 - 1.6 * smooth(0.4, 1, u));
  P[X(J.ULEG_L)] = 1.4 * a; P[X(J.LLEG_L)] = -1.8 * a;
  P[X(J.ULEG_R)] = 0.3 * a; P[X(J.LLEG_R)] = -0.5 * a;
  P[X(J.SPINE)] = -0.45 * a;
  return P;
}

// ---------- beach ----------
// sunbathing on a towel. faceUp: on the back (variant 0 arms by the sides, 1 hands behind the head, 2 one knee up);
// face down: arms folded under the head.
export function poseSunbathe(P, faceUp, variant, t, d) {
  P.fill(0);
  P[ROOT + 3] = faceUp ? PI / 2 : -PI / 2;
  P[ROOT + 1] = -(d.hipH - 0.072 * d.h);
  const br = sin(t * 1.3 + variant);
  P[X(J.CHEST)] = 0.015 * br;
  if (faceUp) {
    if (variant === 1) { // hands behind the head
      P[X(J.UARM_L)] = P[X(J.UARM_R)] = 2.75; P[Z(J.UARM_L)] = -0.55; P[Z(J.UARM_R)] = 0.55;
      P[X(J.LARM_L)] = P[X(J.LARM_R)] = 2.3; P[Y(J.LARM_L)] = -0.6; P[Y(J.LARM_R)] = 0.6;
    } else {
      P[Z(J.UARM_L)] = -0.18; P[Z(J.UARM_R)] = 0.18; P[X(J.LARM_L)] = P[X(J.LARM_R)] = 0.1;
    }
    if (variant === 2) { P[X(J.ULEG_R)] = 0.95; P[X(J.LLEG_R)] = -1.75; P[X(J.FOOT_R)] = 0.75; }
    P[Z(J.ULEG_L)] = -0.06; P[Z(J.ULEG_R)] = 0.06;
    P[X(J.FOOT_L)] = -0.5; if (variant !== 2) P[X(J.FOOT_R)] = -0.5;
    P[Y(J.HEAD)] = 0.25 * sin(variant * 2.1);
  } else {
    P[X(J.UARM_L)] = P[X(J.UARM_R)] = 2.6; P[Z(J.UARM_L)] = -0.5; P[Z(J.UARM_R)] = 0.5;
    P[X(J.LARM_L)] = P[X(J.LARM_R)] = 2.2; P[Y(J.LARM_L)] = -0.9; P[Y(J.LARM_R)] = 0.9;
    P[X(J.HEAD)] = 0.35; P[Y(J.HEAD)] = 0.6 * (variant % 2 ? 1 : -1);
    P[X(J.FOOT_L)] = P[X(J.FOOT_R)] = -1.2;
    if (variant === 2) { P[X(J.LLEG_L)] = -1.2 - 0.35 * max(0, sin(t * 0.9)); }
  }
  return P;
}

// sitting on the sand. variant 0 leaning back on the hands, 1 hugging the knees, 2 cross-legged.
export function poseSitGround(P, variant, t, d) {
  P.fill(0);
  P[ROOT + 1] = -(d.hipH - 0.075 * d.h);
  const br = sin(t * 1.5 + variant * 2);
  if (variant === 0) {
    P[ROOT + 3] = 0.45;
    P[X(J.ULEG_L)] = 1.3; P[X(J.ULEG_R)] = 1.75; P[X(J.LLEG_L)] = -0.25; P[X(J.LLEG_R)] = -1.5;
    P[X(J.SPINE)] = -0.1; P[X(J.NECK)] = -0.15; P[X(J.HEAD)] = -0.15;
    P[X(J.UARM_L)] = P[X(J.UARM_R)] = -0.75; P[Z(J.UARM_L)] = -0.3; P[Z(J.UARM_R)] = 0.3;
    P[X(J.LARM_L)] = P[X(J.LARM_R)] = 0.1;
  } else if (variant === 1) {
    P[ROOT + 3] = 0.12;
    P[X(J.ULEG_L)] = P[X(J.ULEG_R)] = 2.15; P[X(J.LLEG_L)] = P[X(J.LLEG_R)] = -2.35;
    P[Z(J.ULEG_L)] = -0.08; P[Z(J.ULEG_R)] = 0.08;
    P[X(J.SPINE)] = -0.35; P[X(J.CHEST)] = -0.15; P[X(J.HEAD)] = 0.35;
    P[X(J.UARM_L)] = P[X(J.UARM_R)] = 0.75; P[Z(J.UARM_L)] = -0.08; P[Z(J.UARM_R)] = 0.08;
    P[X(J.LARM_L)] = P[X(J.LARM_R)] = 1.25; P[Y(J.LARM_L)] = -0.7; P[Y(J.LARM_R)] = 0.7;
  } else {
    P[ROOT + 3] = 0.05;
    P[X(J.ULEG_L)] = P[X(J.ULEG_R)] = 1.45; P[Z(J.ULEG_L)] = -0.85; P[Z(J.ULEG_R)] = 0.85;
    P[Y(J.ULEG_L)] = 0.5; P[Y(J.ULEG_R)] = -0.5;
    P[X(J.LLEG_L)] = P[X(J.LLEG_R)] = -2.4;
    P[X(J.SPINE)] = -0.12;
    P[X(J.UARM_L)] = P[X(J.UARM_R)] = 0.5; P[Z(J.UARM_L)] = -0.25; P[Z(J.UARM_R)] = 0.25;
    P[X(J.LARM_L)] = P[X(J.LARM_R)] = 0.7;
  }
  P[X(J.CHEST)] += 0.015 * br;
  const look = sin(t * 0.17 + variant * 3.3);
  P[Y(J.HEAD)] += 0.45 * look * look * look;
  return P;
}
