// Pure helpers for the touch controls (no DOM, no allocations): node-testable (src/mobile/test.mjs).

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

// DriveInput (src/vehicle/Input.js) maps the left stick X as: deadzone 0.12, rescale, then |x|^1.6 (thumbstick
// response curve). Touch steering already has its own curve, so the virtual pad sends the inverse: DriveInput
// then yields exactly `s` (before its own speed-sensitive reduction).
export const DRIVE_DEAD = 0.12;
export const DRIVE_EXP = 1.6;
export function driveAxis(s) {
  const a = Math.abs(s);
  if (a < 1e-4) return 0;
  return sign(s) * (DRIVE_DEAD + (1 - DRIVE_DEAD) * Math.pow(Math.min(1, a), 1 / DRIVE_EXP));
}
// Inverse of DriveInput's mapping (for tests): pad axis → steer.
export function driveSteerFromAxis(ax) {
  const m = Math.abs(ax);
  if (m < DRIVE_DEAD) return 0;
  return sign(ax) * Math.pow((m - DRIVE_DEAD) / (1 - DRIVE_DEAD), DRIVE_EXP);
}

// InputManager.axis(i, dead = 0.15): linear rescale after the deadzone. Inverse so consumers read exactly `s`.
export const AXIS_DEAD = 0.15;
export function linAxis(s, dead = AXIS_DEAD) {
  const a = Math.abs(s);
  if (a < 1e-4) return 0;
  return sign(s) * (dead + (1 - dead) * Math.min(1, a));
}
export function axisFromPad(v, dead = AXIS_DEAD) {
  return Math.abs(v) < dead ? 0 : (v - sign(v) * dead) / (1 - dead);
}

// Touch steering response: linear near the ends, softer around the centre. expo 1 = linear.
export function steerCurve(x, expo = 1.35) {
  const a = Math.min(1, Math.abs(x));
  return sign(x) * Math.pow(a, expo);
}

// Steering angle from a DeviceOrientation event (degrees) for the current screen rotation (0/90/180/270).
// Uses the gravity direction projected on the screen plane, so it works in any tilt-back pose (not only flat):
// positive = device turned clockwise from the player's point of view (= steer right). Radians.
// Returns NaN when the screen is nearly flat (projection too short to be reliable).
const D2R = Math.PI / 180;
export function tiltAngle(beta, gamma, screenAngle) {
  const b = beta * D2R, g = gamma * D2R;
  // world "up" in device coordinates (W3C Z-X'-Y'' Euler angles): (-cos b sin g, sin b, cos b cos g)
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  const a = (((screenAngle % 360) + 360) % 360) * D2R;
  const ca = Math.cos(a), sa = Math.sin(a);
  const sx = ux * ca - uy * sa; // component along screen-right
  const sy = ux * sa + uy * ca; // component along screen-up
  if (sx * sx + sy * sy < 0.04) return NaN; // within ~11.5° of flat
  return Math.atan2(-sx, sy);
}

// Floating stick: offset (px) → normalised vector in `out` = { x, y, mag, over } (over = raw distance / radius).
export function stickVector(dx, dy, radius, dead, out) {
  const d = Math.hypot(dx, dy);
  const over = d / radius;
  let mag = Math.min(1, over);
  mag = mag <= dead ? 0 : (mag - dead) / (1 - dead);
  if (d > 1e-6) { out.x = (dx / d) * mag; out.y = (dy / d) * mag; } else { out.x = 0; out.y = 0; }
  out.mag = mag;
  out.over = over;
  return out;
}

// Frame limiter step (see perf.js). acc: accumulated ms since the last rendered frame (in/out via state).
// Returns true when this rAF tick should run the game loop. tolerance absorbs vsync jitter.
export function frameGate(state, now, capFps, tolerance = 1.5) {
  if (!capFps) { state.last = now; state.acc = 0; return true; }
  if (state.last < 0) { state.last = now; state.acc = 0; return true; }
  const d = now - state.last;
  state.last = now;
  if (d <= 0 || d > 250) { state.acc = 0; return true; } // clock reset / long stall: just run
  const interval = 1000 / capFps;
  state.acc += d;
  if (state.acc < interval - tolerance) return false;
  state.acc = clamp(state.acc - interval, 0, interval);
  return true;
}
