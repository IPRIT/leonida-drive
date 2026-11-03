// Street furniture placement along the raised sidewalks (init only, pure data; testable in node).
// Sidewalk: from e.w/2 to e.w/2 + roads.sidewalkWidth(e) either side of the centreline, top at road y + 0.21.
import { rng, hash2, PointGrid } from './util.js';

export const STREET_TYPES = ['bin', 'bench', 'hydrant', 'shelter', 'news', 'mail', 'meter', 'palm', 'shrub', 'rack', 'cafe'];

// collider half-extents (box) or radius/half-height (cyl), break behaviour:
//   light: knocked over on any real hit (low contact-force threshold), car keeps ~95 % speed;
//   fixed: solid until the hit exceeds `thr` (N), then breaks loose and the car keeps ~85 %.
export const STREET_PHYS = {
  bin: { shape: 'cyl', r: 0.3, h: 0.52, mass: 18, light: true },
  hydrant: { shape: 'cyl', r: 0.17, h: 0.4, mass: 45, light: true, water: true },
  news: { shape: 'box', hx: 0.25, hy: 0.56, hz: 0.23, mass: 30, light: true },
  mail: { shape: 'box', hx: 0.29, hy: 0.62, hz: 0.25, mass: 40, light: true },
  meter: { shape: 'cyl', r: 0.11, h: 0.75, mass: 12, light: true },
  rack: { shape: 'box', hx: 0.8, hy: 0.42, hz: 0.33, mass: 25, light: true },
  cafe: { shape: 'box', hx: 0.85, hy: 0.4, hz: 0.42, mass: 15, light: true },
  bench: { shape: 'box', hx: 0.92, hy: 0.45, hz: 0.33, mass: 45, light: true },
  palm: { shape: 'box', hx: 0.5, hy: 0.25, hz: 0.5, mass: 220, thr: 60000 },
  shrub: { shape: 'box', hx: 0.5, hy: 0.25, hz: 0.5, mass: 220, thr: 60000 },
  shelter: { shape: 'box', hx: 1.75, hy: 1.25, hz: 0.75, mass: 260, thr: 110000 },
};

const DOWNTOWN = new Set(['Downtown', 'Ocean Beach', 'Washington Beach', 'Little Cuba', 'Vice Decor District', 'Shoreline', 'Bayside', 'Crosstown', 'Tequesta']);
const CAFE_AREAS = new Set(['Ocean Beach', 'Washington Beach', 'Downtown', 'Little Cuba', 'Vice Decor District', 'Shoreline', 'Capri', 'Key Lento']);
const METER_AREAS = new Set(['Downtown', 'Ocean Beach', 'Washington Beach', 'Little Cuba', 'Vice Decor District', 'Bayside', 'Tequesta']);

export const BIN_COLORS = { city: 0x2f5d3a, beach: 0x2f7fd8, rich: 0x2b2d33, poor: 0x6d7a72 };
const NEWS_COLORS = [0xd8392f, 0x2f6fd8, 0xf2c230, 0x2e9a54, 0xf1efe9, 0x9b4dcc];
const PARASOLS = [0xff4fa3, 0x29d0e0, 0xffd23a, 0xff8a3d, 0x2f6fd8, 0x6ac259];
const CAPS = { bin: 7000, bench: 3200, hydrant: 3200, shelter: 320, news: 2200, mail: 1400, meter: 3000, palm: 2600, shrub: 2600, rack: 900, cafe: 1500 };

function polyDist(p, x, z) {
  // > 0 outside: distance to the polygon boundary; inside → -1
  const n = p.length / 2;
  let inside = false, best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xj - xi, dz = zj - zi, L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / L2));
    const d = Math.hypot(x - xi - dx * t, z - zi - dz * t);
    if (d < best) best = d;
  }
  return inside ? -1 : best;
}

export function planStreets(game, { beachGrid = null } = {}) {
  const t0 = performance.now();
  const { roads, buildings, world3d } = game;
  const out = {};
  for (const t of STREET_TYPES) out[t] = [];
  // clearance grids: street lamps, traffic signal poles, everything we place
  const lampGrid = new PointGrid(32), lightGrid = new PointGrid(32), placed = new PointGrid(16);
  const L = game.lamps?.scatter;
  if (L?.raw) for (let i = 0; i < L.count; i++) lampGrid.add(L.raw[i * 6], L.raw[i * 6 + 2]);
  const TL = game.traffic?.lights?.nodes;
  if (TL) for (const n of TL.values()) for (const a of n.approaches) lightGrid.add(a.x, a.z);

  const nearBuilding = (x, z, margin, reach = 40) => {
    if (!buildings?.query) return false;
    for (const id of buildings.query(x, z, reach)) {
      const d = polyDist(buildings.list[id].p, x, z);
      if (d < margin) return true;
    }
    return false;
  };

  let candidates = 0;
  const reject = { sep: 0, lamp: 0, junction: 0, building: 0, bridge: 0 };
  for (const e of roads.edges) {
    const W = roads.sidewalkWidth?.(e) || 0;
    if (!W || e.internal || e.tunnel || e.len < 24) continue;
    const tr = roads.trims?.[e.i];
    const sA = (tr?.[0]?.t ?? 0) + 3 + 1, sB = e.len - (tr?.[1]?.t ?? 0) - 3 - 1;
    if (sB - sA < 6) continue;
    const hw = e.w / 2;
    const mid = roads.pointAt(e, e.len / 2);
    const area = world3d?.areaAt?.(mid.x, mid.z);
    const name = area?.name || '';
    const wealth = area?.wealth ?? 0.4;
    const downtown = DOWNTOWN.has(name);
    const beachy = !!beachGrid?.nearest(mid.x, mid.z, 320);
    const dens = Math.min(1.7, 0.45 + wealth * 0.8 + (downtown ? 0.35 : 0) + (beachy ? 0.2 : 0));
    const R = rng(e.i * 7919 + 13);
    const binColor = beachy ? BIN_COLORS.beach : wealth > 0.8 ? BIN_COLORS.rich : wealth < 0.3 ? BIN_COLORS.poor : BIN_COLORS.city;

    // place one prop at arc length s on side sd (+1 right of a→b, -1 left), `off` metres from the centreline
    const put = (type, s, sd, off, { sep = 2.2, lamp = 3, color = 0xffffff, building = 0.5, along = 0 } = {}) => {
      if (out[type].length >= CAPS[type] || s < sA || s > sB) return false;
      candidates++;
      const p = roads.pointAt(e, s);
      if (e.br && (e.br[p.k] || e.br[p.k + 1])) { reject.bridge++; return false; }
      const nx = -p.tz * sd, nz = p.tx * sd; // outward normal of this side
      const x = p.x + nx * off, z = p.z + nz * off, y = p.y + 0.21;
      if (placed.any(x, z, sep)) { reject.sep++; return false; }
      if (lampGrid.any(x, z, lamp) || lightGrid.any(x, z, 3)) { reject.lamp++; return false; }
      if (along > 0) { // long props: check their ends too
        for (const k of [-1, 1]) if (lampGrid.any(x + p.tx * along * k, z + p.tz * along * k, 1.8)) { reject.lamp++; return false; }
      }
      if (roads.inJunction?.(x, z, p.y) || roads.sidewalkBlocked?.(e, x, z, p.y)) { reject.junction++; return false; }
      if (building >= 0 && nearBuilding(x, z, building)) { reject.building++; return false; }
      const yaw = Math.atan2(-nx, -nz); // local +z faces the road
      out[type].push({ x, y, z, yaw, color, e: e.i });
      placed.add(x, z);
      return true;
    };

    // trash bins every ~35-60 m (sparser in poor suburbs), alternating sides, at the kerb
    let side = R() < 0.5 ? 1 : -1;
    const binStep = Math.max(30, Math.min(95, (35 + R() * 25) / dens));
    for (let s = sA + R() * 12; s < sB; s += binStep) { put('bin', s, side, hw + 0.45, { color: binColor }); side = -side; }
    // fire hydrants near the corners
    if (R() < 0.6) put('hydrant', sA + 0.5 + R() * 2, R() < 0.5 ? 1 : -1, hw + 0.35, { color: wealth > 0.7 && R() < 0.5 ? 0xf2c230 : 0xd8392f, lamp: 2.5 });
    if (R() < 0.45) put('hydrant', sB - 0.5 - R() * 2, R() < 0.5 ? 1 : -1, hw + 0.35, { color: 0xd8392f, lamp: 2.5 });
    // benches: wide downtown / beach sidewalks
    if (W >= 2.6 && (dens > 0.95 || beachy)) {
      const step = beachy ? 42 : 75 / dens;
      for (let s = sA + 8 + R() * 15, k = 0; s < sB; s += step * (0.8 + R() * 0.4), k++) put('bench', s, k % 2 ? 1 : -1, hw + W - 0.45, { color: 0x2c2f35, along: 1 });
    }
    // bus stops every ~400 m on the wide lit avenues
    if (e.w >= 12.5 && e.lit && sB - sA > 80) {
      for (let s = sA + 40 + hash2(e.i, 3, 7) * 200, k = 0; s < sB - 20; s += 400, k++) {
        put('shelter', s, (e.i + k) % 2 ? 1 : -1, hw + W - 0.85, { color: downtown ? 0x2c2f35 : 0x3f7f8a, sep: 5, lamp: 2.5, along: 2.4, building: 0.3 });
      }
    }
    // newspaper / vending boxes near downtown corners
    if (downtown || (wealth >= 0.7 && e.lit)) {
      for (const [s0, dir] of [[sA + 2, 1], [sB - 2, -1]]) {
        if (R() > 0.55) continue;
        const sd = R() < 0.5 ? 1 : -1, n = 2 + Math.floor(R() * 2);
        for (let i = 0; i < n; i++) put('news', s0 + dir * i * 0.62, sd, hw + 0.5, { color: NEWS_COLORS[Math.floor(R() * NEWS_COLORS.length)], sep: 0.55, lamp: 2.5 });
      }
    }
    // mailboxes
    if (R() < 0.18 + 0.25 * dens) put('mail', sA + (sB - sA) * (0.3 + R() * 0.4), R() < 0.5 ? 1 : -1, hw + 0.5, { color: 0x2f5fa8 });
    // parking meters along downtown kerbs (one side)
    if (METER_AREAS.has(name) && W >= 2.6 && e.w < 16) {
      const sd = e.i % 2 ? 1 : -1;
      for (let s = sA + 2; s < sB - 2; s += 8) put('meter', s, sd, hw + 0.32, { sep: 1.6, lamp: 2.2 });
    }
    // planters between the lamps on the widest sidewalks
    if (W >= 3.2 && dens > 0.9) {
      const palmy = beachy || wealth >= 0.8;
      for (let s = sA + 12 + R() * 6, k = 0; s < sB; s += 24 + R() * 8, k++) {
        put(palmy ? 'palm' : 'shrub', s, k % 2 ? 1 : -1, hw + 0.95, { color: palmy ? 0xd9c7a8 : 0xbab5ab, sep: 3, along: 0.5 });
      }
    }
    // bike racks downtown / near beaches
    if ((downtown || beachy) && W >= 2.6) {
      for (let s = sA + 20 + R() * 40; s < sB; s += 150 + R() * 60) put('rack', s, R() < 0.5 ? 1 : -1, hw + W - 0.5, { along: 0.9, sep: 3 });
    }
    // café table clusters outside shops (a building right behind the sidewalk)
    if (CAFE_AREAS.has(name) && W >= 2.6) {
      for (let s = sA + 8 + R() * 20; s < sB - 6; s += 55 + R() * 40) {
        if (R() > 0.75) continue;
        const sd = R() < 0.5 ? 1 : -1;
        const p = roads.pointAt(e, s);
        const nx = -p.tz * sd, nz = p.tx * sd;
        if (!nearBuilding(p.x + nx * (hw + W + 1), p.z + nz * (hw + W + 1), 9, 40)) continue; // a shop front nearby
        const n = 2 + Math.floor(R() * 2), color = PARASOLS[Math.floor(R() * PARASOLS.length)];
        for (let i = 0; i < n; i++) put('cafe', s + i * 2.3, sd, hw + W - 0.75, { color, sep: 2.0, lamp: 2.5, building: 0.15 });
      }
    }
  }
  const counts = {};
  for (const t of STREET_TYPES) counts[t] = out[t].length;
  return { props: out, counts, candidates, reject, ms: performance.now() - t0 };
}
