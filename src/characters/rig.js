// Humanoid rig shared by the player, pedestrians and ragdolls: joint hierarchy, body proportions,
// part layout and forward kinematics. No THREE dependency (runs in Node tests).
//
// Matrices are 3x4 affine stored column-major like three.js (x axis, y axis, z axis, translation) = 12 floats.
// Character space: Y up, facing -Z, left = -X. Rest pose: standing, arms hanging straight down.
// Angle conventions (Euler XYZ per joint): +rx swings legs/arms forward, bends elbows; knees bend with -rx;
// spine/neck/head lean forward with -rx; arm abduction is rz = side * a (side -1 left, +1 right).

export const J = {
  PELVIS: 0, SPINE: 1, CHEST: 2, NECK: 3, HEAD: 4,
  UARM_L: 5, LARM_L: 6, HAND_L: 7, UARM_R: 8, LARM_R: 9, HAND_R: 10,
  ULEG_L: 11, LLEG_L: 12, FOOT_L: 13, ULEG_R: 14, LLEG_R: 15, FOOT_R: 16,
};
export const NJ = 17;
export const PARENT = [-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15];
// pose = NJ * 3 Euler angles + root channels: offX, offY, offZ (metres, character space), rotX, rotY, rotZ
export const ROOT = NJ * 3;
export const POSE_LEN = ROOT + 6;

export const BUILDS = ['thin', 'average', 'athletic', 'heavy', 'elderly'];

// Render parts. mesh: which instanced mesh draws it; k = instance index within that mesh for this figure.
export const PARTS = [
  { name: 'pelvis', joint: J.PELVIS, mesh: 'prism', k: 0 },
  { name: 'abdomen', joint: J.SPINE, mesh: 'prism', k: 1 },
  { name: 'chest', joint: J.CHEST, mesh: 'prism', k: 2 },
  { name: 'neck', joint: J.NECK, mesh: 'prism', k: 3 },
  { name: 'uArmL', joint: J.UARM_L, mesh: 'prism', k: 4 },
  { name: 'lArmL', joint: J.LARM_L, mesh: 'prism', k: 5 },
  { name: 'uArmR', joint: J.UARM_R, mesh: 'prism', k: 6 },
  { name: 'lArmR', joint: J.LARM_R, mesh: 'prism', k: 7 },
  { name: 'uLegL', joint: J.ULEG_L, mesh: 'prism', k: 8 },
  { name: 'lLegL', joint: J.LLEG_L, mesh: 'prism', k: 9 },
  { name: 'uLegR', joint: J.ULEG_R, mesh: 'prism', k: 10 },
  { name: 'lLegR', joint: J.LLEG_R, mesh: 'prism', k: 11 },
  { name: 'head', joint: J.HEAD, mesh: 'head', k: 0 },
  { name: 'handL', joint: J.HAND_L, mesh: 'hand', k: 0 },
  { name: 'handR', joint: J.HAND_R, mesh: 'hand', k: 1 },
  { name: 'footL', joint: J.FOOT_L, mesh: 'foot', k: 0 },
  { name: 'footR', joint: J.FOOT_R, mesh: 'foot', k: 1 },
  { name: 'headX', joint: J.HEAD, mesh: 'headX', k: 0 },
  { name: 'chestX', joint: J.CHEST, mesh: 'chestX', k: 0 },
  { name: 'hipX', joint: J.PELVIS, mesh: 'hipX', k: 0 },
  { name: 'handXL', joint: J.HAND_L, mesh: 'handX', k: 0 },
  { name: 'handXR', joint: J.HAND_R, mesh: 'handX', k: 1 },
  { name: 'headY', joint: J.HEAD, mesh: 'headY', k: 0 }, // hats, glasses, earrings
];
export const NP = PARTS.length;
export const PART = Object.fromEntries(PARTS.map((p, i) => [p.name, i]));
// instances per figure for each instanced mesh
export const MESH_MULT = { prism: 12, head: 1, hand: 2, foot: 2, headX: 1, chestX: 1, hipX: 1, handX: 2, headY: 1 };

// Body proportions from a look: { h (m), fem (0..1), build }.
export function makeDims(look) {
  const h = look.h ?? 1.76;
  const fem = look.fem ?? 0;
  const build = look.build || 'average';
  const g = { thin: 0.84, average: 1, athletic: 1.05, heavy: 1.3, elderly: 1.0 }[build] ?? 1;
  const belly = build === 'heavy' ? 1.32 : build === 'elderly' ? 1.08 : build === 'athletic' ? 0.94 : 1;
  const muscle = build === 'athletic' ? 1.2 : build === 'thin' ? 0.86 : build === 'heavy' ? 1.12 : 1;
  const d = { h, fem, build, g, stoop: build === 'elderly' ? 1 : 0 };
  d.ankleH = 0.042 * h;
  d.shin = 0.228 * h;
  d.thigh = 0.245 * h;
  d.hipH = d.ankleH + d.shin + d.thigh;
  d.pelvisH = 0.05 * h;
  d.abdomenH = 0.11 * h;
  d.chestH = 0.155 * h;
  d.neckH = 0.04 * h;
  d.headH = 0.125 * h;
  d.shoulderW = (0.104 - 0.011 * fem + (build === 'athletic' ? 0.007 : 0)) * h;
  d.shoulderY = d.chestH * 0.8;
  d.hipW = (0.047 + 0.009 * fem) * h * Math.sqrt(g);
  d.upperArm = 0.168 * h;
  d.foreArm = 0.145 * h;
  d.handL = 0.092 * h;
  // half extents
  d.chestW = (0.1 - 0.012 * fem) * h * (0.55 + 0.45 * g) * (build === 'athletic' ? 1.08 : 1);
  d.chestD = 0.06 * h * (0.6 + 0.4 * g) * (build === 'athletic' ? 1.06 : 1);
  d.waistW = (0.082 - 0.006 * fem) * h * g * belly;
  d.waistD = 0.058 * h * g * belly * (build === 'heavy' ? 1.18 : 1);
  d.pelvisW = d.hipW + (0.041 + 0.006 * fem) * h * Math.sqrt(g);
  d.pelvisD = 0.058 * h * Math.sqrt(g) * (1 + 0.05 * fem);
  d.neckR = 0.024 * h * (build === 'athletic' ? 1.15 : build === 'heavy' ? 1.12 : 1);
  d.armR = 0.026 * h * muscle * (1 - 0.1 * fem);
  d.foreR = 0.022 * h * Math.sqrt(muscle) * (1 - 0.08 * fem);
  d.thighR = 0.044 * h * Math.sqrt(g) * (build === 'athletic' ? 1.06 : 1);
  d.shinR = 0.03 * h * Math.sqrt(g);
  d.headW = 0.057 * h * (1 - 0.03 * fem);
  d.headD = 0.064 * h;
  d.handW = 0.022 * h;
  d.handD = 0.012 * h;
  d.footW = 0.03 * h;
  d.footL = 0.112 * h;
  d.off = restOffsets(d);
  d.parts = partLocals(d);
  return d;
}

// joint offsets in parent space (rest pose), Float32Array(NJ*3)
function restOffsets(d) {
  const o = new Float32Array(NJ * 3);
  const set = (j, x, y, z) => { o[j * 3] = x; o[j * 3 + 1] = y; o[j * 3 + 2] = z; };
  set(J.SPINE, 0, d.pelvisH, 0);
  set(J.CHEST, 0, d.abdomenH, 0);
  set(J.NECK, 0, d.chestH, 0);
  set(J.HEAD, 0, d.neckH, 0);
  set(J.UARM_L, -d.shoulderW, d.shoulderY, 0.004 * d.h);
  set(J.UARM_R, d.shoulderW, d.shoulderY, 0.004 * d.h);
  set(J.LARM_L, 0, -d.upperArm, 0);
  set(J.LARM_R, 0, -d.upperArm, 0);
  set(J.HAND_L, 0, -d.foreArm, 0);
  set(J.HAND_R, 0, -d.foreArm, 0);
  set(J.ULEG_L, -d.hipW, 0, 0);
  set(J.ULEG_R, d.hipW, 0, 0);
  set(J.LLEG_L, 0, -d.thigh, 0);
  set(J.LLEG_R, 0, -d.thigh, 0);
  set(J.FOOT_L, 0, -d.shin, 0);
  set(J.FOOT_R, 0, -d.shin, 0);
  return o;
}

// per part: [tx, ty, tz, sx, sy, sz, taper] in joint space; canonical geometry spans y in [-1, 0] (top at 0)
function partLocals(d) {
  const h = d.h;
  const P = new Float32Array(NP * 7);
  const set = (name, tx, ty, tz, sx, sy, sz, taper = 1) => P.set([tx, ty, tz, sx, sy, sz, taper], PART[name] * 7);
  const pelLen = d.pelvisH + 0.06 * h;
  set('pelvis', 0, d.pelvisH, 0, d.pelvisW, pelLen, d.pelvisD, 0.8);
  set('abdomen', 0, d.abdomenH + 0.012 * h, 0, d.waistW, d.abdomenH + 0.02 * h, d.waistD, d.pelvisW / d.waistW);
  set('chest', 0, d.chestH + 0.006 * h, 0, d.chestW, d.chestH + 0.012 * h, d.chestD, d.waistW / d.chestW);
  set('neck', 0, d.neckH + 0.025 * h, 0, d.neckR, d.neckH + 0.04 * h, d.neckR, 1.12);
  for (const s of ['L', 'R']) {
    set(`uArm${s}`, 0, 0.016 * h, 0, d.armR, d.upperArm + 0.022 * h, d.armR * 0.95, 0.8);
    set(`lArm${s}`, 0, 0.008 * h, 0, d.foreR, d.foreArm + 0.01 * h, d.foreR * 0.9, 0.7);
    set(`uLeg${s}`, 0, 0.03 * h, 0, d.thighR, d.thigh + 0.035 * h, d.thighR, 0.64);
    set(`lLeg${s}`, 0, 0.012 * h, 0, d.shinR, d.shin + 0.016 * h, d.shinR, 0.62);
    set(`hand${s}`, 0, 0.004 * h, 0, d.handW, d.handL, d.handD);
    set(`foot${s}`, 0, 0, 0, d.footW, d.ankleH, d.footL);
    set(`handX${s}`, 0, 0.004 * h, 0, d.handW, d.handL, d.handD);
  }
  set('head', 0, d.headH * 0.5, -0.004 * h, d.headW, d.headH * 0.52, d.headD);
  set('headX', 0, d.headH * 0.5, -0.004 * h, d.headW, d.headH * 0.52, d.headD);
  set('headY', 0, d.headH * 0.5, -0.004 * h, d.headW, d.headH * 0.52, d.headD);
  set('chestX', 0, d.chestH + 0.006 * h, 0, d.chestW, d.chestH + 0.012 * h, d.chestD);
  set('hipX', 0, d.pelvisH, 0, d.pelvisW, pelLen, d.pelvisD);
  return P;
}

// ---------- 3x4 matrix helpers ----------
export const mat12 = () => new Float32Array(12);

// rotation from Euler XYZ (same as THREE.Matrix4.makeRotationFromEuler 'XYZ') into m[o..o+8]
export function eulerToMat(m, o, x, y, z) {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  m[o] = c * e; m[o + 1] = af + be * d; m[o + 2] = bf - ae * d;
  m[o + 3] = -c * f; m[o + 4] = ae - bf * d; m[o + 5] = be + af * d;
  m[o + 6] = d; m[o + 7] = -b * c; m[o + 8] = a * c;
}

// out(oo) = A(ao) * [R(euler) | t] where t is a local translation in A's frame
const _r = new Float32Array(9);
export function mulLocal(out, oo, A, ao, tx, ty, tz, rx, ry, rz) {
  const a00 = A[ao], a10 = A[ao + 1], a20 = A[ao + 2], a01 = A[ao + 3], a11 = A[ao + 4], a21 = A[ao + 5];
  const a02 = A[ao + 6], a12 = A[ao + 7], a22 = A[ao + 8];
  out[oo + 9] = A[ao + 9] + a00 * tx + a01 * ty + a02 * tz;
  out[oo + 10] = A[ao + 10] + a10 * tx + a11 * ty + a12 * tz;
  out[oo + 11] = A[ao + 11] + a20 * tx + a21 * ty + a22 * tz;
  if (rx === 0 && ry === 0 && rz === 0) {
    out[oo] = a00; out[oo + 1] = a10; out[oo + 2] = a20;
    out[oo + 3] = a01; out[oo + 4] = a11; out[oo + 5] = a21;
    out[oo + 6] = a02; out[oo + 7] = a12; out[oo + 8] = a22;
    return;
  }
  eulerToMat(_r, 0, rx, ry, rz);
  for (let c = 0; c < 3; c++) {
    const b0 = _r[c * 3], b1 = _r[c * 3 + 1], b2 = _r[c * 3 + 2];
    out[oo + c * 3] = a00 * b0 + a01 * b1 + a02 * b2;
    out[oo + c * 3 + 1] = a10 * b0 + a11 * b1 + a12 * b2;
    out[oo + c * 3 + 2] = a20 * b0 + a21 * b1 + a22 * b2;
  }
}

// pelvis matrix for a figure standing at ground point (x,y,z) facing yaw, with pose root channels applied
export function pelvisMatrix(out, x, y, z, yaw, P, d) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const ox = P[ROOT], oy = P[ROOT + 1] + d.hipH, oz = P[ROOT + 2];
  // Ry(yaw)
  _base[0] = cy; _base[1] = 0; _base[2] = -sy;
  _base[3] = 0; _base[4] = 1; _base[5] = 0;
  _base[6] = sy; _base[7] = 0; _base[8] = cy;
  _base[9] = x; _base[10] = y; _base[11] = z;
  mulLocal(out, 0, _base, 0, ox, oy, oz, P[ROOT + 3], P[ROOT + 4], P[ROOT + 5]);
  return out;
}
const _base = new Float32Array(12);

// Forward kinematics: W (NJ*12) from the pelvis matrix (12) and pose angles.
export function fk(W, pelvis, P, d) {
  const off = d.off;
  mulLocal(W, 0, pelvis, 0, 0, 0, 0, P[0], P[1], P[2]);
  for (let j = 1; j < NJ; j++) {
    const p = PARENT[j];
    mulLocal(W, j * 12, W, p * 12, off[j * 3], off[j * 3 + 1], off[j * 3 + 2], P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
  }
  return W;
}

// matrix from a position + quaternion into m[o..o+11]
export function quatToMat(m, o, px, py, pz, qx, qy, qz, qw) {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  m[o] = 1 - (yy + zz); m[o + 1] = xy + wz; m[o + 2] = xz - wy;
  m[o + 3] = xy - wz; m[o + 4] = 1 - (xx + zz); m[o + 5] = yz + wx;
  m[o + 6] = xz + wy; m[o + 7] = yz - wx; m[o + 8] = 1 - (xx + yy);
  m[o + 9] = px; m[o + 10] = py; m[o + 11] = pz;
}

// quaternion {x,y,z,w} of a rotation stored in m[o..o+8]
export function matToQuat(m, o, out = {}) {
  const m11 = m[o], m21 = m[o + 1], m31 = m[o + 2], m12 = m[o + 3], m22 = m[o + 4], m32 = m[o + 5];
  const m13 = m[o + 6], m23 = m[o + 7], m33 = m[o + 8];
  const tr = m11 + m22 + m33;
  let s;
  if (tr > 0) {
    s = 0.5 / Math.sqrt(tr + 1);
    out.w = 0.25 / s; out.x = (m32 - m23) * s; out.y = (m13 - m31) * s; out.z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    out.w = (m32 - m23) / s; out.x = 0.25 * s; out.y = (m12 + m21) / s; out.z = (m13 + m31) / s;
  } else if (m22 > m33) {
    s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    out.w = (m13 - m31) / s; out.x = (m12 + m21) / s; out.y = 0.25 * s; out.z = (m23 + m32) / s;
  } else {
    s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    out.w = (m21 - m12) / s; out.x = (m13 + m31) / s; out.y = (m23 + m32) / s; out.z = 0.25 * s;
  }
  return out;
}

// Euler XYZ of R = A^T * B (B relative to A), both rotations in 12-float matrices
export function relEuler(A, ao, B, bo, out) {
  // r = A^T B; only the entries needed for the XYZ decomposition
  const dot = (i, j) => A[ao + i * 3] * B[bo + j * 3] + A[ao + i * 3 + 1] * B[bo + j * 3 + 1] + A[ao + i * 3 + 2] * B[bo + j * 3 + 2];
  // matrix element (row i, col j) = dot(column i of A, column j of B)
  const m11 = dot(0, 0), m12 = dot(0, 1), m13 = dot(0, 2), m22 = dot(1, 1), m23 = dot(1, 2), m32 = dot(2, 1), m33 = dot(2, 2);
  const y = Math.asin(Math.max(-1, Math.min(1, m13)));
  let x, z;
  if (Math.abs(m13) < 0.9999999) { x = Math.atan2(-m23, m33); z = Math.atan2(-m12, m11); } else { x = Math.atan2(m32, m22); z = 0; }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

// leg vertical extent (hip to ankle) for hip flexion a and knee angle b (b <= 0), plus pelvis/hip roll ignored
export function legExtent(d, a, b) {
  return d.thigh * Math.cos(a) + d.shin * Math.cos(a + b);
}
