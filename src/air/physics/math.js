// Tiny allocation-free vector/quaternion helpers for the physics cores (no three.js, Node-friendly).
export const G = 9.81;
export const RHO = 1.225;
export const RHO_WATER = 1025;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const approach = (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target));
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const set = (o, x, y, z) => ((o.x = x), (o.y = y), (o.z = z), o);
export const copy = (o, a) => ((o.x = a.x), (o.y = a.y), (o.z = a.z), o);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const scale = (o, a, s) => set(o, a.x * s, a.y * s, a.z * s);
export const addScaled = (o, a, s) => ((o.x += a.x * s), (o.y += a.y * s), (o.z += a.z * s), o);

export function cross(o, a, b) {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return set(o, x, y, z);
}

export function normalize(o) {
  const l = Math.hypot(o.x, o.y, o.z);
  if (l > 1e-9) { o.x /= l; o.y /= l; o.z /= l; }
  return o;
}

/** o = q * v (rotate vector by unit quaternion). */
export function rotate(o, q, v) {
  const { x, y, z } = v;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return set(o,
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx);
}

/** Quaternion from yaw (rotation about +Y; 0 = facing -Z). */
export function yawQuat(yaw, o = { x: 0, y: 0, z: 0, w: 1 }) {
  o.x = 0; o.y = Math.sin(yaw / 2); o.z = 0; o.w = Math.cos(yaw / 2);
  return o;
}

/** Quaternion from yaw then pitch (nose up positive) then roll (right wing down positive). */
export function eulerQuat(yaw, pitch, roll, o = { x: 0, y: 0, z: 0, w: 1 }) {
  // q = qYaw(about +Y) * qPitch(about +X) * qRoll(about -Z)
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const rz = Math.sin(-roll / 2), rw = Math.cos(-roll / 2);
  const mx = sp * rw, my = -sp * rz, mz = cp * rz, mw = cp * rw;
  o.x = cy * mx + sy * mz;
  o.y = cy * my + sy * mw;
  o.z = cy * mz - sy * mx;
  o.w = cy * mw - sy * my;
  return o;
}

/** Heading of a forward vector as compass bearing in radians (0 = north/-Z, +PI/2 = east/+X). */
export const bearing = (f) => Math.atan2(f.x, -f.z);
