export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// frame-rate independent exponential approach
export const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
export const dbToGain = (db) => Math.pow(10, db / 20);

// Smoothly drive an AudioParam towards a value; skips redundant automation events.
export function ramp(param, value, t, tau = 0.03, eps = 1e-4) {
  if (!param) return;
  const last = param._lv;
  if (last !== undefined && Math.abs(value - last) <= eps * Math.max(1, Math.abs(value))) return;
  param._lv = value;
  param.setTargetAtTime(value, t, tau);
}

// Jump an AudioParam immediately (cancels pending automation).
export function snap(param, value, t) {
  if (!param) return;
  param.cancelScheduledValues(t);
  param.setValueAtTime(value, t);
  param._lv = value;
}

export function posOf(o, out) {
  if (!o) return null;
  if (o.isObject3D) {
    if (!o.parent || o.parent.isScene) { out.x = o.position.x; out.y = o.position.y; out.z = o.position.z; }
    else { const e = o.matrixWorld.elements; out.x = e[12]; out.y = e[13]; out.z = e[14]; }
    return out;
  }
  if (typeof o.x === 'number') { out.x = o.x; out.y = o.y ?? 0; out.z = o.z; return out; }
  return null;
}

export function disconnectAll(...nodes) {
  for (const n of nodes) { try { n?.disconnect(); } catch { /* already disconnected */ } }
}

export const t_ = (game, key, fallback) => game?.i18n?.t?.(key) ?? fallback;
