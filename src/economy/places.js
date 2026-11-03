// Economy places (docs/ECONOMY.md → Jobs): delivery depots in industrial/port areas, export yards at the docks, body
// shops. Anchors are hand-picked near district centres of public/data/world.json; at runtime (and in the node tools)
// each one snaps to the kerb lane of the nearest urban (kind-0) road, so the marker is always drivable.
// Pure module (no three.js, no DOM): the server can import it to validate job origins/destinations.

export const DEPOTS = Object.freeze([
  { id: 'portvc', name: 'Port of Vice City Freight', area: 'Port Vice City', x: 600, z: 560 },
  { id: 'stockyard', name: 'Stockyard Freight', area: 'Stockyard', x: -352, z: -1792 },
  { id: 'vcia', name: 'VCIA Air Cargo', area: 'Vice City International Airport', x: -2396, z: 674 },
  { id: 'allied', name: 'Allied Crystal Plant', area: 'Ambrosia', x: -2911, z: -3652 },
  { id: 'hamlet', name: 'Hamlet Freight Yard', area: 'Hamlet', x: -2683, z: 3391 },
  { id: 'gellhorn', name: 'Port Gellhorn Freight', area: 'Port Gellhorn', x: -6600, z: -3700 },
]);

export const YARDS = Object.freeze([
  { id: 'vcdocks', name: 'Vice City Docks Export', area: 'Port Vice City', x: 950, z: 380 },
  { id: 'capri', name: 'Capri Marine Export', area: 'Capri', x: -6742, z: -96 },
  { id: 'keylento', name: 'Key Lento Export', area: 'Leonida Keys', x: -2482, z: 5872 },
]);

export const BODY_SHOPS = Object.freeze([
  { id: 'oceanbeach', name: 'Ocean Beach Body Shop', area: 'Ocean Beach', x: 1778, z: -483 },
  { id: 'littlecuba', name: 'Little Cuba Auto Body', area: 'Little Cuba', x: -1194, z: -60 },
  { id: 'southside', name: 'Southside Paint & Body', area: 'Southside', x: -1777, z: 2059 },
  { id: 'ambrosia', name: 'Ambrosia Garage', area: 'Ambrosia', x: -2769, z: -3882 },
]);

export const PLACE_RADIUS = 6; // m: drive into the ring

const KERB_FILTER = (e) => e.kind === 0 && !e.br;

/**
 * Snap an anchor to the kerb lane of the nearest kind-0, non-bridge road. `nearest` = game.roads.nearest (grid index);
 * without it (node tools) the edges are searched brute force — same result. → { x, y, z, yaw, w } or null.
 */
export function snapToKerb(edges, x, z, maxR = 700, heightAt = null, nearest = null) {
  let best = null, bd = maxR;
  if (nearest) {
    const n = nearest(x, z, maxR, KERB_FILTER);
    if (n) best = { e: n.edge, k: n.seg, t: n.t, px: n.x, pz: n.z, tx: n.dir[0], tz: n.dir[1] };
  } else for (const e of edges) {
    if (e.kind !== 0 || e.br) continue;
    for (let k = 0; k < e.n - 1; k++) {
      const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bd) {
        const L = Math.sqrt(L2);
        bd = d;
        best = { e, k, t, px, pz, tx: dx / L, tz: dz / L };
      }
    }
  }
  if (!best) return null;
  const { e, k, t, px, pz, tx, tz } = best;
  // the kerb lane on the anchor's side of the road
  const rx = -tz, rz = tx; // right of the edge direction
  const side = (x - px) * rx + (z - pz) * rz >= 0 ? 1 : -1;
  const off = Math.max(1.2, e.w / 2 - 2);
  const sx = px + rx * off * side, sz = pz + rz * off * side;
  const ry = e.y ? e.y[k] + (e.y[k + 1] - e.y[k]) * t : 0;
  const y = Math.max(heightAt ? heightAt(sx, sz) : ry, ry, 0);
  const fx = tx * side, fz = tz * side;
  return { x: r1(sx), y: r1(y), z: r1(sz), yaw: Math.round(Math.atan2(-fx, -fz) * 1000) / 1000, w: e.w };
}
const r1 = (v) => Math.round(v * 10) / 10;

/** Snap every place list. → { depots, yards, shops } with { ...anchor, x, y, z, yaw, ax, az } */
export function buildPlaces(edges, heightAt = null, nearest = null) {
  const snap = (list) => list.map((p) => {
    const s = snapToKerb(edges, p.x, p.z, 700, heightAt, nearest);
    return s ? { ...p, ax: p.x, az: p.z, x: s.x, y: s.y, z: s.z, yaw: s.yaw } : { ...p, ax: p.x, az: p.z, y: Math.max(0, heightAt?.(p.x, p.z) ?? 0), yaw: 0 };
  });
  return { depots: snap(DEPOTS), yards: snap(YARDS), shops: snap(BODY_SHOPS) };
}

/**
 * Delivery drop points: kerb positions every ~220 m along urban roads (deterministic). → Float32Array [x, z, y, …]
 */
export function buildDropPoints(edges, heightAt = null, step = 220) {
  const out = [];
  for (const e of edges) {
    if (e.kind !== 0 || e.len < 60) continue;
    for (let s = 30; s <= e.len - 30; s += step) {
      let k = 0;
      while (k < e.n - 2 && e.cum[k + 1] < s) k++;
      if (e.br && (e.br[k] || e.br[k + 1])) continue;
      const seg = e.cum[k + 1] - e.cum[k] || 1;
      const t = (s - e.cum[k]) / seg;
      const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
      const tx = (bx - ax) / seg, tz = (bz - az) / seg;
      const off = Math.max(1.2, e.w / 2 - 2);
      const x = ax + (bx - ax) * t - tz * off, z = az + (bz - az) * t + tx * off;
      const ry = e.y ? e.y[k] + (e.y[k + 1] - e.y[k]) * t : 0;
      const h = heightAt ? heightAt(x, z) : ry;
      if (h < 0.3) continue;
      out.push(x, z, Math.max(h, ry, 0));
    }
  }
  return Float32Array.from(out);
}

/** Length of a flat [x, z, x, z, …] polyline (roads.route output). */
export function polylineLength(p) {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}
