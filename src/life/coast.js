// Coast analysis (init only): finds beach sand with its seaward direction, straight coast for piers and quiet water
// next to rich waterfronts for moored yachts. Pure data: returns placement lists; Beach.js turns them into instances.
import { hash2, PointGrid, rng } from './util.js';

// Beaches that get furniture (umbrellas, loungers, towers...). Boxes in world metres.
export const BEACH_ZONES = [
  { id: 'vice-beach', x0: 1650, x1: 2650, z0: -2900, z1: 1200, density: 1.0, towers: true, piers: 3, kiosks: true },
  { id: 'waning-sands', x0: 200, x1: 1200, z0: -4950, z1: -3150, density: 0.65, towers: true, piers: 1, kiosks: true },
  { id: 'south-keys', x0: -950, x1: 2150, z0: 900, z1: 3450, density: 0.55, towers: true, piers: 1, kiosks: true },
  { id: 'key-lento', x0: -3500, x1: -1450, z0: 4850, z1: 6950, density: 0.4, towers: false, piers: 1, kiosks: true },
  { id: 'capri', x0: -7600, x1: -5850, z0: -1400, z1: 1400, density: 0.55, towers: true, piers: 1, kiosks: true },
];

// Waterfronts with moored yachts
export const MARINA_ZONES = [
  { id: 'starfish', x0: 250, x1: 1350, z0: -1800, z1: 50, max: 34 },
  { id: 'bayside-beach', x0: 1250, x1: 1800, z0: -2700, z1: 700, max: 26 },
  { id: 'tequesta', x0: -800, x1: 400, z0: 700, z1: 1500, max: 14 },
  { id: 'keys', x0: 300, x1: 2100, z0: 1000, z1: 2000, max: 14 },
  { id: 'capri', x0: -7400, x1: -5900, z0: -900, z1: 1000, max: 14 },
];

export const UMBRELLA_COLORS = [0xff4fa3, 0x29d0e0, 0xffd23a, 0xff8a3d, 0xa24dff, 0x3fa6ff, 0x6ac259, 0xe8423b, 0xffffff];
export const PASTELS = [0xf7a8c4, 0x9fe3d6, 0xfde59a, 0xc8b6f2, 0xffc9a3, 0xa7d8f5, 0xb8f0c0];
export const ACCENTS = [0x1f3550, 0x1aa6a0, 0xc9a23a, 0xc0392b, 0x22252a, 0x3fa6ff, 0xff4fa3];

const DIRS = 12;
const CS = [], SN = [];
for (let i = 0; i < DIRS; i++) { CS.push(Math.cos((i / DIRS) * Math.PI * 2)); SN.push(Math.sin((i / DIRS) * Math.PI * 2)); }

// direction & distance to the nearest point matching `test(h)` (marching rays). Returns null if none within maxR.
function probe(terrain, x, z, test, maxR = 96, step = 6, dirStep = 1) {
  let sx = 0, sz = 0, best = Infinity;
  for (let d = 0; d < DIRS; d += dirStep) {
    for (let r = step; r <= maxR; r += step) {
      if (test(terrain.heightAt(x + CS[d] * r, z + SN[d] * r), x + CS[d] * r, z + SN[d] * r)) {
        const w = 1 / r;
        sx += CS[d] * w; sz += SN[d] * w;
        if (r < best) best = r;
        break;
      }
    }
  }
  const L = Math.hypot(sx, sz);
  if (!Number.isFinite(best) || L < 1e-6) return null;
  return { dx: sx / L, dz: sz / L, dist: best };
}

// refine the distance along a direction (1 m resolution)
function distAlong(terrain, x, z, dx, dz, test, maxR) {
  for (let r = 1; r <= maxR; r += 1) if (test(terrain.heightAt(x + dx * r, z + dz * r))) return r;
  return Infinity;
}

const isWater = (h) => h < -0.2;
const isLand = (h) => h > 0.35;

export function analyzeCoast(game) {
  const { terrain, roads } = game;
  const G = terrain.G;
  const t0 = performance.now();
  const out = {
    samples: [], umbrellas: [], loungers: [], towers: [], nets: [], huts: [], kiosks: [], piers: [], buoys: [], yachts: [],
    beachGrid: new PointGrid(96), waterGrid: new PointGrid(160),
  };
  const offRoad = (x, z, clear) => {
    const n = roads.nearest(x, z, clear + 16);
    return !n || n.dist > n.edge.w * 0.5 + clear;
  };
  const noBuilding = (x, z, r) => !game.buildings?.query || game.buildings.query(x, z, r).length === 0;

  // ---- 1. beach samples
  const STEP = 12;
  out.prof = { samples: 0, place: 0 };
  let tz = performance.now();
  for (const zone of BEACH_ZONES) {
    const zs = [];
    for (let z = zone.z0; z < zone.z1; z += STEP) {
      for (let x = zone.x0; x < zone.x1; x += STEP) {
        const jx = x + (hash2(x, z, 1) - 0.5) * 6, jz = z + (hash2(x, z, 2) - 0.5) * 6;
        if (terrain.groundAt(jx, jz) !== G.sand) continue;
        const h = terrain.heightAt(jx, jz);
        if (h < 0.25 || h > 7) continue;
        const sea = probe(terrain, jx, jz, isWater, 104, 8, 1);
        if (!sea) continue;
        const s = { x: jx, z: jz, y: h, sx: sea.dx, sz: sea.dz, dw: sea.dist, zone, i: out.samples.length };
        out.samples.push(s);
        zs.push(s);
        if (hash2(jx, jz, 3) < 0.25) out.beachGrid.add(jx, jz, s);
      }
    }
    const tp = performance.now();
    out.prof.samples += tp - tz;
    placeBeach(game, zone, zs, out, offRoad, noBuilding);
    out.prof.place += performance.now() - tp;
    tz = performance.now();
  }
  out.prof.marina = performance.now();

  // ---- 2. marinas
  for (const mz of MARINA_ZONES) placeMarina(game, mz, out, offRoad);

  out.prof.marina = performance.now() - out.prof.marina;
  const tw = performance.now();
  // water grid for pelicans (coastal water, any zone around the city)
  for (let z = -4800; z < 6800; z += 80) {
    for (let x = -7600; x < 3000; x += 80) {
      const h = terrain.heightAt(x, z);
      if (h > -1 || h < -25) continue;
      if (terrain.heightAt(x + 120, z) > 0.3 || terrain.heightAt(x - 120, z) > 0.3 || terrain.heightAt(x, z + 120) > 0.3 || terrain.heightAt(x, z - 120) > 0.3) out.waterGrid.add(x, z, { x, z });
    }
  }
  out.prof.water = performance.now() - tw;
  out.ms = performance.now() - t0;
  return out;
}

function placeBeach(game, zone, zs, out, offRoad, noBuilding) {
  const { terrain } = game;
  const R = rng(zone.x0 * 31 + zone.z0 * 17);
  const taken = new PointGrid(32);
  const dens = zone.density;
  const yawOf = (s) => Math.atan2(s.sx, s.sz);
  const ok = (x, z, r) => !taken.any(x, z, r) && terrain.groundAt(x, z) === terrain.G.sand && offRoad(x, z, 3) && noBuilding(x, z, 9);

  // piers first (they need clean straight coast)
  const pierGrid = new PointGrid(256);
  let piers = 0;
  const order = zs.filter((s) => s.dw >= 8 && s.dw <= 26).sort((a, b) => hash2(a.x, a.z, 9) - hash2(b.x, b.z, 9));
  for (const s of order) {
    if (piers >= zone.piers) break;
    if (pierGrid.any(s.x, s.z, 650)) continue;
    // straight coast: neighbours agree on the sea direction
    let agree = 0, n = 0;
    for (const o of zs) {
      const d2 = (o.x - s.x) ** 2 + (o.z - s.z) ** 2;
      if (d2 > 70 * 70 || o === s) continue;
      n++;
      if (o.sx * s.sx + o.sz * s.sz > 0.965) agree++;
    }
    if (n < 6 || agree / n < 0.85) continue;
    const pier = layoutPier(game, s, offRoad);
    if (!pier) continue;
    out.piers.push(pier);
    pierGrid.add(s.x, s.z);
    for (let d = -6; d <= pier.length; d += 8) taken.add(s.x + s.sx * d, s.z + s.sz * d);
    piers++;
  }

  const pick = (filter, spacing, reserve, maxN, prob, fn) => {
    const grid = new PointGrid(Math.max(32, spacing));
    let n = 0;
    for (const s of zs) {
      if (n >= maxN) break;
      if (!filter(s) || hash2(s.x, s.z, 11 + spacing) > prob) continue;
      if (grid.any(s.x, s.z, spacing) || !ok(s.x, s.z, reserve)) continue;
      if (fn(s) === false) continue;
      grid.add(s.x, s.z);
      taken.add(s.x, s.z);
      n++;
    }
  };

  if (zone.towers) {
    pick((s) => s.dw >= 18 && s.dw <= 42, 230, 8, 40, 0.5, (s) => {
      out.towers.push({ x: s.x, y: s.y, z: s.z, yaw: yawOf(s), color: PASTELS[Math.floor(R() * PASTELS.length)] });
      // swim-zone buoys offshore
      const tx = -s.sz, tz = s.sx;
      const wx = s.x + s.sx * (s.dw + 55), wz = s.z + s.sz * (s.dw + 55);
      for (let k = -2; k <= 2; k++) {
        const bx = wx + tx * k * 22, bz = wz + tz * k * 22;
        if (terrain.heightAt(bx, bz) > -0.8) continue;
        out.buoys.push({ x: bx, z: bz, color: k % 2 ? 0xffd23a : 0xe8423b });
      }
    });
  }
  pick((s) => s.dw >= 38 && s.dw <= 85, 260, 11, 20, 0.35 * dens + 0.1, (s) => {
    out.nets.push({ x: s.x, y: s.y, z: s.z, yaw: yawOf(s) });
  });
  if (zone.kiosks) {
    pick((s) => s.dw >= 45 && s.dw <= 115, 240, 6, 30, 0.6, (s) => {
      out.kiosks.push({ x: s.x, y: s.y, z: s.z, yaw: yawOf(s), color: PASTELS[Math.floor(R() * PASTELS.length)] });
    });
  }
  pick((s) => s.dw >= 28 && s.dw <= 95, 110, 5, 60, 0.5 * dens, (s) => {
    out.huts.push({ x: s.x, y: s.y, z: s.z, yaw: R() * Math.PI });
  });
  // umbrellas with loungers (the bulk)
  pick((s) => s.dw >= 10 && s.dw <= 55, 6, 3.5, 5000, 0.45 * dens, (s) => {
    const color = UMBRELLA_COLORS[Math.floor(R() * UMBRELLA_COLORS.length)];
    const yaw = yawOf(s);
    out.umbrellas.push({ x: s.x, y: s.y, z: s.z, yaw: R() * 6.28, color, tilt: (R() - 0.5) * 0.18 });
    const tx = -s.sz, tz = s.sx;
    if (R() < 0.75 * dens + 0.1) {
      // a neighbour a few metres along the shore (busy beach)
      const k = R() < 0.5 ? -1 : 1, d = 5 + R() * 2, j = (R() - 0.5) * 3;
      const ux = s.x + tx * k * d + s.sx * j, uz = s.z + tz * k * d + s.sz * j;
      if (ok(ux, uz, 3.5)) {
        const c2 = UMBRELLA_COLORS[Math.floor(R() * UMBRELLA_COLORS.length)];
        out.umbrellas.push({ x: ux, y: terrain.heightAt(ux, uz), z: uz, yaw: R() * 6.28, color: c2, tilt: (R() - 0.5) * 0.18 });
        taken.add(ux, uz);
        const lx = ux + tx * k * 1.0 + s.sx * 0.3, lz = uz + tz * k * 1.0 + s.sz * 0.3;
        out.loungers.push({ x: lx, y: terrain.heightAt(lx, lz), z: lz, yaw: yaw + (R() - 0.5) * 0.3, color: c2 });
      }
    }
    const nL = R() < 0.25 ? 1 : 2;
    const lc = R() < 0.5 ? color : UMBRELLA_COLORS[Math.floor(R() * UMBRELLA_COLORS.length)];
    for (let k = 0; k < nL; k++) {
      const side = nL === 1 ? (R() < 0.5 ? -1 : 1) : k ? 1 : -1;
      const lx = s.x + tx * side * 0.9 + s.sx * 0.3, lz = s.z + tz * side * 0.9 + s.sz * 0.3;
      out.loungers.push({ x: lx, y: terrain.heightAt(lx, lz), z: lz, yaw: yaw + (R() - 0.5) * 0.3, color: lc });
    }
  });
}

// pier from a beach sample straight out to sea. Deck height = sand height + 1.6 (via an 8 m ramp).
function layoutPier(game, s, offRoad) {
  const { terrain } = game;
  const dx = s.sx, dz = s.sz;
  // start the ramp a bit inland
  const x0 = s.x - dx * 4, z0 = s.z - dz * 4;
  if (!offRoad(x0, z0, 6) || !offRoad(s.x, s.z, 6)) return null;
  const h0 = Math.max(0.3, terrain.heightAt(x0, z0));
  const Y = h0 + 1.6;
  const shore = distAlong(terrain, x0, z0, dx, dz, (h) => h < 0, 120);
  if (!Number.isFinite(shore)) return null;
  const N = Math.max(12, Math.min(24, Math.round((shore + 70) / 6)));
  const length = 8 + N * 6 + 10;
  for (let d = 8; d <= length; d += 3) {
    const h = terrain.heightAt(x0 + dx * d, z0 + dz * d);
    if (h > Y - 0.9) return null; // dune in the way
    if (d > length * 0.55 && h > -0.8) return null; // far half must be over water
    const tx = -dz * 7, tz = dx * 7;
    if (d > length - 11 && (terrain.heightAt(x0 + dx * d + tx, z0 + dz * d + tz) > Y - 1 || terrain.heightAt(x0 + dx * d - tx, z0 + dz * d - tz) > Y - 1)) return null;
  }
  for (let d = 0; d < length; d += 10) if (!offRoad(x0 + dx * d, z0 + dz * d, 4)) return null;
  return { x0, z0, y0: h0, Y, dx, dz, yaw: Math.atan2(dx, dz), N, length };
}

function placeMarina(game, mz, out, offRoad) {
  const { terrain, world3d } = game;
  const G = terrain.G;
  const R = rng(mz.x0 * 13 + mz.z0 * 7);
  const grid = new PointGrid(48);
  let n = 0;
  const cands = [];
  for (let z = mz.z0; z < mz.z1; z += 10) {
    for (let x = mz.x0; x < mz.x1; x += 10) {
      const h = terrain.heightAt(x, z);
      if (h > -1.6 || h < -16) continue;
      // cheap pre-filter: some land within ~36 m, none within ~12 m
      let far = false, near = false;
      for (let d = 0; d < DIRS; d += 2) {
        if (isLand(terrain.heightAt(x + CS[d] * 36, z + SN[d] * 36))) far = true;
        if (isLand(terrain.heightAt(x + CS[d] * 12, z + SN[d] * 12))) { near = true; break; }
      }
      if (!far || near) continue;
      const land = probe(terrain, x, z, isLand, 44, 4);
      if (!land || land.dist < 14 || land.dist > 34) continue;
      const gx = x + land.dx * (land.dist + 6), gz = z + land.dz * (land.dist + 6);
      const g = terrain.groundAt(gx, gz);
      if (g === G.sand || g === G.wetland || g === G.water) continue;
      const wealth = world3d?.wealthAt ? world3d.wealthAt(x, z) : 0.6;
      if (wealth < 0.55) continue;
      cands.push({ x, z, ldx: land.dx, ldz: land.dz, ld: land.dist, k: hash2(x, z, 21) });
    }
  }
  cands.sort((a, b) => a.k - b.k);
  for (const c of cands) {
    if (n >= mz.max) break;
    if (grid.any(c.x, c.z, 26)) continue;
    if (!offRoad(c.x, c.z, 28)) continue;
    // keep the whole hull over open water
    const tx = -c.ldz, tz = c.ldx;
    let clear = true;
    for (const d of [-11, -6, 0, 6, 11]) if (terrain.heightAt(c.x + tx * d, c.z + tz * d) > -1.2) { clear = false; break; }
    if (!clear) continue;
    let pierHit = false;
    for (const p of out.piers) {
      const rx = c.x - p.x0, rz = c.z - p.z0, along = rx * p.dx + rz * p.dz, across = Math.abs(rx * p.dz - rz * p.dx);
      if (along > -20 && along < p.length + 20 && across < 30) { pierHit = true; break; }
    }
    if (pierHit) continue;
    const sail = R() < 0.35;
    const scale = sail ? 0.9 + R() * 0.35 : 0.8 + R() * 0.55;
    out.yachts.push({ x: c.x, z: c.z, yaw: Math.atan2(tx, tz) + (R() < 0.5 ? Math.PI : 0), scale, sail, color: ACCENTS[Math.floor(R() * ACCENTS.length)] });
    grid.add(c.x, c.z);
    n++;
  }
}
