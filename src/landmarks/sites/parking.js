import { K, rng } from '../kit.js';
import { terrainMax } from './runways.js';

// Parking with the game's real vehicles (ctx.park -> vehicles.js). A row of nose-in bays: (x, z) is the aisle
// end of the first bay line, u = (ux, uz) runs along the row, the bays extend `depth` metres to the side v
// (default: u turned 90° right, v = (-uz, ux)). Each car is placed only where its footprint is clear of roads,
// buildings, structures and other vehicles; painted bay lines mark every usable bay.
export function parkingRow(ctx, {
  x, z, ux, uz, vx = -uz, vz = ux, n, bay = 2.9, depth = 5.8, keys, fill = 0.85, seed = 1, lines = true,
  y = null, colors = null, noseIn = true, check = {}, max = Infinity,
} = {}) {
  const R = rng(seed);
  const T = ctx.terrain;
  const yAt = y === null ? (px, pz) => terrainMax(T, px, pz, 3) + 0.02 : () => y + 0.02;
  // facing: nose into the bay (+v) or out to the aisle (-v); bake forward is -Z: yaw = atan2(-fx, -fz)
  const fx = noseIn ? vx : -vx, fz = noseIn ? vz : -vz;
  const yaw = Math.atan2(-fx, -fz);
  const placed = [], usable = [];
  for (let i = 0; i < n; i++) {
    const cx = x + ux * (i + 0.5) * bay + vx * depth / 2, cz = z + uz * (i + 0.5) * bay + vz * depth / 2;
    if (!ctx.spotFree(cx, cz, yaw, bay / 2 - 0.15, depth / 2 - 0.1, { ...check, pad: 0 })) continue;
    usable.push(i);
    if (placed.length >= max || R() > fill) continue;
    const key = keys[Math.floor(R() * keys.length)];
    const m = ctx.vehicleModel(key);
    if (!m) continue;
    // bay centre minus the model's own bbox offset, nudged 0.3 m towards the bay end
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ox = c * m.cx + s * m.cz, oz = -s * m.cx + c * m.cz;
    const px = cx - ox + vx * 0.3 * (noseIn ? 1 : -1), pz = cz - oz + vz * 0.3 * (noseIn ? 1 : -1);
    const color = colors ? colors[Math.floor(R() * colors.length)] : null;
    if (ctx.park(key, px, pz, yaw, { ...check, y: y ?? undefined, color: color ?? undefined, pad: 0.15 })) placed.push(i);
  }
  if (lines && usable.length) {
    const P = ctx.paint;
    P.lod = 0;
    P.paint(0xf2f2ee, K.PAINT);
    const drawn = new Set();
    for (const i of usable) {
      for (const k of [i, i + 1]) {
        if (drawn.has(k)) continue;
        drawn.add(k);
        const ax = x + ux * k * bay, az = z + uz * k * bay;
        P.ribbon([[ax + vx * 0.3, az + vz * 0.3], [ax + vx * depth, az + vz * depth]], 0.12, yAt, 0.03);
      }
    }
  }
  return { placed: placed.length, usable: usable.length, yaw };
}

// a few vehicles in a loose line (trucks at a gate, buses at a kerb): spots along u every `gap` metres, each
// parked parallel to u (forward = +u), only where free
export function vehicleLine(ctx, { x, z, ux, uz, n, gap, keys, seed = 1, y = null, colors = null, check = {}, reverse = false }) {
  const R = rng(seed);
  const yaw = Math.atan2(reverse ? ux : -ux, reverse ? uz : -uz);
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const key = keys[Math.floor(R() * keys.length)];
    const px = x + ux * i * gap, pz = z + uz * i * gap;
    const color = colors ? colors[Math.floor(R() * colors.length)] : undefined;
    if (ctx.park(key, px, pz, yaw, { ...check, y: y ?? undefined, color })) placed++;
  }
  return placed;
}

// up to n vehicles on free ground around (cx, cz) within r: each parked parallel to the nearest road (as if at
// the kerb of a yard), never on a road, a building, a structure or another vehicle. Returns how many.
export function scatterPark(ctx, cx, cz, { r = 60, n = 4, keys, seed = 1, colors = null, step = 7 } = {}) {
  const R = rng(seed);
  let placed = 0;
  for (let ring = 0; ring * step <= r && placed < n; ring++) {
    const k = Math.max(1, Math.round((2 * Math.PI * ring * step) / 9));
    const a0 = R() * Math.PI * 2;
    for (let i = 0; i < k && placed < n; i++) {
      const a = a0 + (i / k) * Math.PI * 2;
      const x = cx + Math.cos(a) * ring * step, z = cz + Math.sin(a) * ring * step;
      const hit = ctx.roads.nearest(x, z, 80);
      const dir = hit ? hit.dir : [Math.cos(a), Math.sin(a)];
      const flip = R() < 0.5 ? 1 : -1;
      const yaw = Math.atan2(-dir[0] * flip, -dir[1] * flip);
      const key = keys[Math.floor(R() * keys.length)];
      const color = colors ? colors[Math.floor(R() * colors.length)] : undefined;
      if (ctx.park(key, x, z, yaw, { color, pad: 0.6 })) placed++;
    }
  }
  return placed;
}

// boats moored in a row along u starting at (x, z): only on open water (every footprint corner at least `depth`
// metres deep), spaced `gap` metres, bows pointing along v = (vx, vz)
export function mooredBoats(ctx, { x, z, ux, uz, vx, vz, n, gap = 9, keys, seed = 1, depth = 0.8, colors = null }) {
  const R = rng(seed);
  const yaw = Math.atan2(-vx, -vz);
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const key = keys[Math.floor(R() * keys.length)];
    const m = ctx.vehicleModel(key);
    if (!m) continue;
    const px = x + ux * i * gap, pz = z + uz * i * gap;
    let wet = true;
    const lx = -vz, lz = vx; // beam direction
    for (const [a, b] of [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const qx = px + lx * a * m.wid / 2 + vx * b * m.len / 2, qz = pz + lz * a * m.wid / 2 + vz * b * m.len / 2;
      if (ctx.groundY(qx, qz) > -depth) { wet = false; break; }
    }
    if (!wet) continue;
    ctx.vehicle(key, px, pz, yaw + (R() - 0.5) * 0.15, { y: 0, collider: false, color: colors ? colors[Math.floor(R() * colors.length)] : undefined });
    placed++;
  }
  return placed;
}
