// Compact visual car damage for replication (C_VIS DAMAGE → INFO, sent on change only, ≤ 31 bytes):
//   u8 panels  — detached panels, bit i = PANELS[i] (E's VehicleDamage DETACH keys)
//   u8 glass | lamps << 2 — glass 0 intact / 1 cracked / 2 shattered; lamps broken: bit 0 head-left, 1 head-right,
//                           2 tail-left, 3 tail-right
//   u8 n       — impacts (≤ 4: the strongest), 7 bytes each:
//                i8 x, y, z (model ground frame: y = 0 ground; 1/16 m) | i8 dx, dy, dz (inward, ×127)
//                | u8 energy ×50 (7 bits, ≤ 2.54) + bit 7 scrape
// Pure JS (server-safe; the server treats the payload as opaque bytes).

export const PANELS = ['frontBumper', 'rearBumper', 'hood', 'trunk', 'doorFL', 'doorFR', 'doorRL', 'doorRR'];
export const IMPACTS_MAX = 4;
const P = 16; // position units per metre

const i8 = (v) => Math.max(-127, Math.min(127, Math.round(v))) & 255;
const s8 = (b) => (b > 127 ? b - 256 : b);

/** Lamp bit of a lamp kind + model-space x (left = negative x). */
export function lampBit(kind, x) {
  const head = /head|front|fog|drl/i.test(String(kind || ''));
  return (head ? 0 : 2) + (x < 0 ? 0 : 1);
}

/** s = { panels: Set|array of keys, glass, lamps (4-bit mask), impacts: [{ p:[x,y,z], d:[x,y,z], e, s }] } → Uint8Array */
export function encodeDamage(s) {
  const imp = (s.impacts || []).slice(0, IMPACTS_MAX);
  const out = new Uint8Array(3 + imp.length * 7);
  let mask = 0;
  for (const k of s.panels || []) { const i = PANELS.indexOf(k); if (i >= 0) mask |= 1 << i; }
  out[0] = mask;
  out[1] = (Math.max(0, Math.min(2, s.glass | 0))) | ((s.lamps & 15) << 2);
  out[2] = imp.length;
  let o = 3;
  for (const m of imp) {
    out[o] = i8(m.p[0] * P); out[o + 1] = i8(m.p[1] * P); out[o + 2] = i8(m.p[2] * P);
    const l = Math.hypot(m.d[0], m.d[1], m.d[2]) || 1;
    out[o + 3] = i8((m.d[0] / l) * 127); out[o + 4] = i8((m.d[1] / l) * 127); out[o + 5] = i8((m.d[2] / l) * 127);
    out[o + 6] = Math.max(0, Math.min(127, Math.round((m.e || 0) * 50))) | (m.s ? 128 : 0);
    o += 7;
  }
  return out;
}

/** Inverse of encodeDamage (null for an empty / malformed payload). Impacts carry `key` (their bytes) for dedup. */
export function decodeDamage(b) {
  if (!b || b.length < 3) return null;
  const n = Math.min(IMPACTS_MAX, b[2]);
  if (b.length < 3 + n * 7) return null;
  const panels = [];
  for (let i = 0; i < PANELS.length; i++) if (b[0] & (1 << i)) panels.push(PANELS[i]);
  const impacts = [];
  for (let k = 0, o = 3; k < n; k++, o += 7) {
    impacts.push({
      p: [s8(b[o]) / P, s8(b[o + 1]) / P, s8(b[o + 2]) / P], d: [s8(b[o + 3]) / 127, s8(b[o + 4]) / 127, s8(b[o + 5]) / 127],
      e: (b[o + 6] & 127) / 50, s: b[o + 6] >> 7, key: Array.prototype.join.call(b.subarray(o, o + 7), '.'),
    });
  }
  return { panels, glass: b[1] & 3, lamps: (b[1] >> 2) & 15, impacts };
}
