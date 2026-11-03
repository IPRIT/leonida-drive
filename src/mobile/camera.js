// Touch camera look: a drag on the free part of the screen behaves like a mouse drag on the active camera.
// Uses each camera's own drag path / fields (same formulas as their mouse-drag handlers), so it is frame-rate
// independent and exact; unknown cameras fall back to the right stick (axes 2/3) for one frame.
import { clamp, linAxis } from './math.js';

const TOUCH_K = 0.0055; // rad per CSS px at camSens 1 (≈ 125° for half a phone screen)

const _s = { k: TOUCH_K, inv: 1 }; // reused: no per-frame allocation
function sens(game) {
  const s = game.settings || {};
  _s.k = TOUCH_K * (s.camSens ?? 1) * (s.touchLookSens ?? 1);
  _s.inv = s.invertY ? -1 : 1;
  return _s;
}

/**
 * Apply a drag of (dx, dy) CSS px to whichever camera is active.
 * Returns false when no known camera took it (the caller then emulates the right stick for a frame).
 */
export function applyLook(game, dx, dy) {
  const p = game.player;
  if (!p) return true;
  const { k, inv } = sens(game);
  // free camera (FreeCamera: yaw/pitch, pitch + = look up)
  if (p.mode === 'free' && p.free && typeof p.free.yaw === 'number') {
    p.free.yaw -= dx * k;
    p.free.pitch = clamp(p.free.pitch - dy * k * inv, -1.55, 1.55);
    return true;
  }
  const v = p.mode === 'vehicle' ? p.controllable : null;
  if (v) {
    // aircraft / boats with their own camera (AirCamera.orbit(dx, dy) = its mouse-drag handler, 0.005 rad/px)
    if (v.camera?.orbit) { const f = k / 0.005; v.camera.orbit(dx * f, dy * f * inv); return true; }
    // tank: TankCamera.look(dx, dy) is its mouse path (0.0032 rad/px × camSens, invertY, slower in the sight);
    // the drag aims the turret (the screen centre is the aim point)
    if (typeof v.camera?.look === 'function') {
      const f = (TOUCH_K * (game.settings?.touchLookSens ?? 1)) / 0.0032;
      v.camera.look(dx * f, dy * f);
      return true;
    }
    // ChaseCamera orbit override (same fields PlayerController uses for pointer-lock mouse look)
    const c = p.chase;
    if (c && typeof c._orbitYaw === 'number') {
      c._orbitYaw -= dx * k * 1.1;
      c._orbitPitch = clamp(c._orbitPitch + dy * k * 0.75 * inv, -0.35, 0.9);
      c._orbitIdle = 0;
      return true;
    }
  } else if (p.orbit && typeof p.orbit.yaw === 'number') {
    // on foot: OrbitCamera (pitch + = camera higher, looking down — like its mouse path)
    const o = p.orbit;
    o.yaw -= dx * k;
    o.pitch = clamp(o.pitch + dy * k * inv, -0.75, 1.25);
    o.idle = 0;
    return true;
  }
  return false;
}

/** Right-stick emulation for cameras that only read axes 2/3 (rate based): deflection ∝ drag speed. */
export function lookStick(dx, dy, dt, pad) {
  const rate = 1 / Math.max(1 / 240, dt);
  pad.setAxis(2, linAxis(clamp(dx * rate * 0.0016, -1, 1)));
  pad.setAxis(3, linAxis(clamp(dy * rate * 0.0016, -1, 1)));
}

/** A finger rests on the camera area without moving: keep the cameras from auto-recentring. */
export function holdLook(game) {
  const p = game.player;
  if (!p) return;
  const v = p.mode === 'vehicle' ? p.controllable : null;
  if (v?.camera && typeof v.camera.idle === 'number') v.camera.idle = 0;
  else if (v && p.chase && typeof p.chase._orbitIdle === 'number') p.chase._orbitIdle = 0;
  else if (!v && p.orbit && typeof p.orbit.idle === 'number') p.orbit.idle = 0;
}
