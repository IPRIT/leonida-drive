// Combat rules shared by the server (authority) and the client (prediction/visuals). Pure, allocation-free helpers.
// Conventions: yaw rotates about +Y like three.js (forward = (-sin yaw, 0, -cos yaw)); pitch > 0 aims up.
import { VCLASS } from './constants.js';

// Weapons by id (wire u8). The tank cannon: one shell every 3 s, ballistic, explodes on impact.
export const WEAPON = Object.freeze({
  CANNON: 1,
});
export const WEAPONS = Object.freeze({
  1: Object.freeze({
    id: 'cannon',
    // matches workstream A's tank (src/vehicle/tank: TANK_WEAPON, Shells LIFE/G)
    reloadMs: 3000, // server-enforced minimum between two shots
    speed: 320, // m/s muzzle velocity
    gravity: 9.81, // m/s² (the shell drops: aim above far targets)
    range: 1920, // m of flight path (6 s) before the shell self-destructs
    maxFlightS: 6,
    splash: 9, // m splash radius (SHELL_POWER 1.6 → fx radius 7 + 5·√1.6 ≈ 13 m visual; damage falls off by 9 m)
    muzzleSlack: 10, // m: muzzle position vs the server-known vehicle position (barrel tip ≈ 7.5 m from the body origin)
    aimSlack: 0.45, // rad: barrel direction vs the replicated turret pose
  }),
});

// Vehicles that carry a weapon: catalog `kind` / id → weapon id
export function weaponOfModel(m) {
  if (!m) return 0;
  return m.kind === 'tank' || m.id === 'tank' || m.weapon === 'cannon' ? WEAPON.CANNON : 0;
}
export const isTankModel = (m) => !!m && (m.kind === 'tank' || m.id === 'tank');

// Hit volumes: oriented boxes per class [half width x, half height y, half length z, centre height above the origin].
// Origins: vehicles report their rigid-body origin (cars ≈ wheel-centre height, the tank 0.9 m above the ground);
// on-foot players are reported at the feet.
export const BOXES = Object.freeze({
  [VCLASS.FOOT]: [0.35, 0.9, 0.35, 0.9],
  [VCLASS.CAR]: [1.0, 0.75, 2.35, 0.42],
  [VCLASS.BIKE]: [0.4, 0.75, 1.1, 0.4],
  [VCLASS.HELI]: [1.4, 1.4, 5.0, 1.4],
  [VCLASS.PLANE]: [6.0, 1.5, 6.0, 1.2],
  [VCLASS.BOAT]: [1.3, 1.0, 3.5, 0.8],
});
export const TANK_BOX = Object.freeze([1.83, 1.39, 3.84, 0.49]); // TankModel: 3.66 × 2.78 × 7.67 m
export const boxOf = (vclass, tank) => (tank ? TANK_BOX : BOXES[vclass] || BOXES[VCLASS.CAR]);

// Damage as a fraction of the victim's health/integrity (1 = destroyed).
export const DAMAGE = Object.freeze({
  // a tank takes 4 direct hits (A's armour model: 0.22 per hit); the victim's client applies tank armour itself
  direct: Object.freeze({ [VCLASS.FOOT]: 1, [VCLASS.CAR]: 1, [VCLASS.BIKE]: 1, [VCLASS.HELI]: 1, [VCLASS.PLANE]: 1, [VCLASS.BOAT]: 0.85, tank: 0.22 }),
  splash: Object.freeze({ [VCLASS.FOOT]: 1, [VCLASS.CAR]: 0.7, [VCLASS.BIKE]: 0.9, [VCLASS.HELI]: 0.6, [VCLASS.PLANE]: 0.6, [VCLASS.BOAT]: 0.5, tank: 0.05 }),
});
/** Splash damage at distance d from the explosion (linear falloff, nothing beyond the radius). */
export function splashDamage(vclass, tank, d, radius) {
  if (!(d < radius)) return 0;
  const k = tank ? DAMAGE.splash.tank : DAMAGE.splash[vclass] ?? 0.7;
  return k * (1 - d / radius) ** 1.2;
}

// Crushing: a moving tank overlapping a car/bike (never another tank) destroys it.
export const CRUSH = Object.freeze({ minSpeed: 1.2, maxDy: 2.2, overlap: 0.55, cooldownMs: 4000 });

/** Unit direction of a barrel aimed at world yaw / pitch → out {x, y, z}. */
export function aimDir(yaw, pitch, out) {
  const c = Math.cos(pitch);
  out.x = -Math.sin(yaw) * c; out.y = Math.sin(pitch); out.z = -Math.cos(yaw) * c;
  return out;
}

/** Shell position t seconds after leaving the muzzle (ox,oy,oz) along unit dir d. */
export function shellPos(ox, oy, oz, dx, dy, dz, speed, gravity, t, out) {
  out.x = ox + dx * speed * t;
  out.y = oy + dy * speed * t - 0.5 * gravity * t * t;
  out.z = oz + dz * speed * t;
  return out;
}

/**
 * Segment a→b against an oriented box (centre c, yaw, half extents hx, hy, hz). Returns the entry parameter in [0, 1]
 * or -1 for a miss (slab test in the box frame).
 */
export function segmentBox(ax, ay, az, bx, by, bz, cx, cy, cz, yaw, hx, hy, hz) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  // world → box local: lx = wx*cos - wz*sin, lz = wx*sin + wz*cos (inverse of three.js rotation.y)
  const ax0 = ax - cx, az0 = az - cz, bx0 = bx - cx, bz0 = bz - cz;
  const p0x = ax0 * cs - az0 * sn, p0z = ax0 * sn + az0 * cs, p0y = ay - cy;
  const p1x = bx0 * cs - bz0 * sn, p1z = bx0 * sn + bz0 * cs, p1y = by - cy;
  let t0 = 0, t1 = 1;
  const slab = (p, q, h) => {
    const d = q - p;
    if (Math.abs(d) < 1e-9) return p >= -h && p <= h;
    let e0 = (-h - p) / d, e1 = (h - p) / d;
    if (e0 > e1) { const tmp = e0; e0 = e1; e1 = tmp; }
    if (e0 > t0) t0 = e0;
    if (e1 < t1) t1 = e1;
    return t0 <= t1;
  };
  if (!slab(p0x, p1x, hx) || !slab(p0y, p1y, hy) || !slab(p0z, p1z, hz)) return -1;
  return t0;
}

/** Distance from point p to an oriented box (0 inside). */
export function pointBoxDistance(px, py, pz, cx, cy, cz, yaw, hx, hy, hz) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const dx = px - cx, dz = pz - cz;
  const lx = Math.abs(dx * cs - dz * sn) - hx, lz = Math.abs(dx * sn + dz * cs) - hz, ly = Math.abs(py - cy) - hy;
  const ox = Math.max(lx, 0), oy = Math.max(ly, 0), oz = Math.max(lz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz);
}

/**
 * Tank crush test in the tank's frame: the victim's centre lies inside the tank footprint grown by `overlap` of the
 * victim's half size. Returns true when the boxes overlap enough to count as driving over it.
 */
export function crushes(tx, ty, tz, tyaw, vx, vy, vz, vhx, vhz) {
  if (Math.abs(vy - ty) > CRUSH.maxDy) return false;
  const cs = Math.cos(tyaw), sn = Math.sin(tyaw), dx = vx - tx, dz = vz - tz;
  const lx = Math.abs(dx * cs - dz * sn), lz = Math.abs(dx * sn + dz * cs);
  return lx < TANK_BOX[0] + vhx * (1 - CRUSH.overlap) && lz < TANK_BOX[2] + vhz * (1 - CRUSH.overlap);
}
