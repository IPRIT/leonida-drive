// Interpolation helpers for remote entities (pure math, no allocations).
const TAU = Math.PI * 2;

export function wrapAngle(a) {
  a %= TAU;
  if (a >= Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}

// cubic Hermite basis at s ∈ [0, 1]
export function hermite(p0, v0, p1, v1, dt, s) {
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * dt * v0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * dt * v1;
}
// derivative d/dt of the Hermite curve
export function hermiteVel(p0, v0, p1, v1, dt, s) {
  const s2 = s * s;
  return ((6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * dt * v0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * dt * v1) / dt;
}

// second derivative d²/dt² of the Hermite curve
export function hermiteAcc(p0, v0, p1, v1, dt, s) {
  return ((12 * s - 6) * p0 + (6 * s - 4) * dt * v0 + (-12 * s + 6) * p1 + (6 * s - 2) * dt * v1) / (dt * dt);
}

/**
 * Third-order critically damped decay of an error offset (triple pole at -omega): offset, its velocity AND its
 * acceleration start continuous, so absorbing a correction never produces a velocity step or an acceleration spike.
 * st[i..i+2] = offset, offset velocity, offset acceleration.
 */
export function dampOffset3(st, i, omega, dt) {
  const w2 = omega * omega, w3 = w2 * omega;
  let o = st[i], v = st[i + 1], a = st[i + 2];
  const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
  for (let k = 0; k < n; k++) {
    const j = -w3 * o - 3 * w2 * v - 3 * omega * a;
    a += j * h; v += a * h; o += v * h;
  }
  st[i] = o; st[i + 1] = v; st[i + 2] = a;
}

/**
 * Critically damped decay of an error offset (exact solution, unconditionally stable).
 * state: Float64Array/obj with [offset, offsetVelocity] at index i, i+1. omega = 2π / settle-ish period.
 */
export function dampOffset(st, i, omega, dt) {
  const o = st[i], ov = st[i + 1];
  const e = Math.exp(-omega * dt);
  const tmp = (ov + omega * o) * dt;
  st[i] = (o + tmp) * e;
  st[i + 1] = (ov - omega * tmp) * e;
}

/** Angle lerp along the shortest path. */
export function lerpAngle(a, b, t) { return a + wrapAngle(b - a) * t; }
