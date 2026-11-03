import { K, LOD, W, rng } from '../kit.js';
import { L } from '../lights.js';
import { signQuad, windsock, tank, antenna, mast } from '../parts.js';
import { FONT } from '../atlas.js';
import { AIRCRAFT, LIVERIES } from './aircraft.js';
import { hangar, fuelFarm, clearAirside } from './airport.js';
import { airsideMask } from './infield.js';
import { runwayFurniture, taxiwayFurniture } from './airfield.js';
import { runwaySurface, drawnRunways } from './runways.js';
import { findStripEdge } from '../airside.js';
import { GA_COLORS } from './vcia.js';

// Goose Key Airfield (crossed runways on a paved key, island-style tower, radomes) and the small strips
// (LTF, Watson Bay, Port Gellhorn): hangar, office, fuel tank, windsock, edge lights, parked light aircraft.

export function gooseKey(ctx, def) {
  const { b, lights, sign, atlas } = ctx;
  const runways = (ctx.roads.runways || []).filter((r) => r.airport === 'Goose Key Airfield');
  const zone = (x, z) => Math.hypot(x - -6950, z - 6600) < 900;
  // tower: square shaft, overhanging glass cab (island-airfield style)
  const [tx, tz] = ctx.spot(-6668, 6492, 6, { maxR: 80, dryR: 7 });
  ctx.remove({ circle: [tx, tz, 12] });
  const g = ctx.groundY(tx, tz) - 0.4;
  b.paint(0xefe9dc, K.WIN, W.GRID);
  b.box(tx - 3.6, g, tz - 3.6, tx + 3.6, g + 26, tz + 3.6);
  b.colBox(tx - 4, g, tz - 4, tx + 4, g + 34, tz + 4);
  b.paint(0x2b2f33, K.METAL);
  b.box(tx - 5.6, g + 26, tz - 5.6, tx + 5.6, g + 27, tz + 5.6);
  b.paint(0x3c5566, K.GLASS, 1);
  b.cyl(tx, tz, g + 27, g + 31.5, 6.2, 7.2, 8, { phase: Math.PI / 8, top: false });
  b.paint(0xe9e9e9, K.METAL);
  b.cyl(tx, tz, g + 31.5, g + 32.6, 7.6, 7.6, 8, { phase: Math.PI / 8 });
  b.lod = LOD.NEAR;
  b.paint(0xa0a5aa, K.METAL);
  b.cyl(tx + 2, tz + 1, g + 32.6, g + 39, 0.1, 0.05, 4);
  b.lod = LOD.BOTH;
  lights.obstacle(tx + 2, g + 39.2, tz + 1);
  lights.add(tx - 2, g + 34, tz - 2, 0xffffff, 2.2, L.BEACON, 0.4, 9000);
  // radomes on short lattice towers (radar + weather)
  for (const [x0, z0, r, h] of [[-6702, 6378, 7, 14], [-6725, 6318, 5, 10]]) {
    const [rx, rz] = ctx.spot(x0, z0, r + 2, { maxR: 80, dryR: r + 1 });
    ctx.remove({ circle: [rx, rz, r + 4] });
    const gy = ctx.groundY(rx, rz) - 0.3;
    antenna(b, lights, rx, rz, gy, h, { w: r * 0.9, color: 0x9aa0a6, alt: 0x9aa0a6 });
    b.paint(0xf4f4f2, K.PLAIN);
    b.sphere(rx, gy + h + r * 0.85, rz, r, 14, 8);
    b.colCyl(rx, rz, gy, gy + h + r * 1.7, r);
    lights.obstacle(rx, gy + h + r * 1.85 + 0.3, rz);
  }
  // hangars facing the runways (west)
  for (const [x, z] of [[-6626, 6330], [-6630, 6362]]) for (const f of ctx.footprints(x, z, 25, 150)) ctx.remove({ ids: [f.id] });
  const hy = ctx.groundY(-6625, 6345) - 0.5;
  for (const [hz, nm] of [[6312, 'GOOSE KEY AIRFIELD'], [6372, '']]) {
    if (ctx.dryRect(-6622, hz, -Math.PI / 2, 26, 20)) hangar(ctx, -6622, hz, -Math.PI / 2, 44, 36, 15, { name: nm, y0: hy });
  }
  // operations building + fuel tanks
  if (ctx.dryRect(tx + 22, tz, 0, 13.5, 10.5)) {
    b.paint(0xf2ede2, K.WIN, W.HOTEL);
    b.box(tx + 10, g, tz - 9, tx + 34, g + 7, tz + 9);
    b.paint(0x5a7f9a, K.METAL);
    b.box(tx + 9, g + 7, tz - 10, tx + 35, g + 7.5, tz + 10);
    b.colBox(tx + 10, g, tz - 9, tx + 34, g + 7.5, tz + 9);
  }
  for (const [i, dz] of [[0, -24], [1, -8]]) if (ctx.dryDisc(tx + 52, tz + dz, 6.5)) tank(b, tx + 52, tz + dz, ctx.groundY(tx + 52, tz + dz) - 0.4, 5, 7, { band: i ? 0x2f6db5 : 0xd04030 });
  // parked aircraft on the apron west of the hangars
  const R = rng(5);
  let k = 0;
  for (let z = 6290; z <= 6420; z += 18) {
    const x = -6680 - (k % 2) * 6;
    // regional turboprops (landmark model) and catalog GA aircraft: Solstice 7 jets, Pipit 150 trainers
    const turbo = k % 5 === 2, key = k % 3 === 1 ? 'plane:plane_jet' : k % 4 === 3 ? 'plane:plane_stunt' : 'plane:plane_trainer';
    const r = turbo ? 15 : key === 'plane:plane_jet' ? 9 : 7;
    const yaw = Math.PI / 2 + (R() - 0.5) * 0.15;
    if (fitsFree(ctx, x, z, r)) {
      if (turbo) ctx.instance(AIRCRAFT.turboprop, x, ctx.groundY(x, z), z, yaw, LIVERIES[Math.floor(R() * LIVERIES.length)], 1);
      else ctx.vehicle(key, x, z, yaw, { color: GA_COLORS[Math.floor(R() * GA_COLORS.length)] });
    }
    k++;
  }
  // apron masts
  for (const z of [6300, 6390]) mast(b, lights, -6655, z, ctx.groundY(-6655, z) - 0.2, 18, { heads: 3, color: 0xffe9c4, size: 2.2 });
  const drawn = drawnRunways(ctx, runways);
  const byLen = drawn.slice().sort((a, b) => b.len - a.len);
  byLen.forEach((r, i) => runwaySurface(ctx, r, { primary: byLen.slice(0, i) }));
  runwayFurniture(ctx, drawn, { approach: 420, numbers: false });
  taxiwayFurniture(ctx, zone, { runways: drawn, signs: true });
  clearAirside(ctx, airsideMask(ctx.L, drawn, { reach: 450 }), -6950, 6600, 1200);
  ctx.infield(drawn, { reach: 450 });
  ctx.view([tx - 90, 40, tz + 70], [tx, 18, tz], 'tower');
  ctx.view([-6560, 70, 6250], [-6680, 10, 6380], 'hangars & radomes');
  ctx.view([-7200, 300, 7300], [-6900, 0, 6550], 'airfield');
}

function fitsFree(ctx, x, z, r) {
  if (!ctx.dryDisc(x, z, r, 0.2)) return false;
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) if (!ctx.clearOfRoads(x + ox, z + oz, 1.5)) return false;
  return !ctx.footprints(x, z, r + 15, 20).some((f) => Math.hypot(f.rec.cx - x, f.rec.cz - z) < r + 6);
}

// small strip: the straight wide road edge nearest to the POI is the runway
export function airstrip(ctx, def) {
  const { b, lights, sign, atlas } = ctx;
  const rw = findStrip(ctx, def.x, def.z);
  if (!rw) return { skipped: true };
  // clean strip surface (the strip's road ribbon is hidden by the Roads hooks, see airside.js), edge / threshold
  // lights, short approach bars, windsock; grass around it
  runwaySurface(ctx, rw, { pads: false });
  runwayFurniture(ctx, [rw], { approach: 90, papi: false, numbers: false, socks: true, edgeStep: 50 });
  ctx.infield([rw], { reach: 140 });
  // hangar + office + tank beside the strip, on dry land clear of roads
  const nx = -rw.dz, nz = rw.dx;
  let placed = null;
  for (const t of [0.3, 0.5, 0.7, 0.2, 0.8]) for (const s of [1, -1]) for (const off of [55, 75, 95]) {
    if (placed) break;
    const x = rw.x0 + rw.dx * rw.len * t + nx * s * off, z = rw.z0 + rw.dz * rw.len * t + nz * s * off;
    if (!fitsFree(ctx, x, z, 26) || !ctx.clearOfRoads(x, z, 30)) continue;
    if (!ctx.dryRect(x, z, Math.atan2(-nx * s, -nz * s), 22, 16)) continue;
    placed = { x, z, s };
  }
  if (placed) {
    const { x, z, s } = placed;
    ctx.remove({ circle: [x, z, 30] });
    ctx.hideTrees({ circle: [x, z, 34] });
    const yaw = Math.atan2(-nx * s, -nz * s); // doors (local +z) face the strip
    hangar(ctx, x, z, yaw, 30, 26, 10, { name: def.sign || def.name.toUpperCase() });
    const ox = x + rw.dx * 30, oz = z + rw.dz * 30;
    const gy = ctx.groundY(ox, oz) - 0.3;
    if (ctx.dryRect(ox, oz, yaw, 7, 6) && ctx.clearOfRoads(ox, oz, 7)) {
      b.push(); b.translate(ox, gy, oz).rotY(yaw);
      b.paint(0xf1ece0, K.WIN, W.HOTEL);
      b.box(-6, 0, -5, 6, 4, 5);
      b.paint(0x9a4a36, K.PLAIN);
      b.box(-6.5, 4, -5.5, 6.5, 4.4, 5.5);
      b.colBox(-6, 0, -5, 6, 4.4, 5);
      b.pop();
    }
    const tkx = x - rw.dx * 26, tkz = z - rw.dz * 26;
    if (ctx.dryDisc(tkx, tkz, 4.5) && ctx.clearOfRoads(tkx, tkz, 4.5)) tank(b, tkx, tkz, ctx.groundY(tkx, tkz) - 0.3, 3.5, 5, { band: 0xd04030 });
    // light aircraft tied down in front of the hangar
    const R = rng(Math.abs(x | 0));
    for (let i = -1; i <= 1; i++) {
      const px = x - nx * s * 26 + rw.dx * i * 14, pz = z - nz * s * 26 + rw.dz * i * 14;
      if (R() < 0.8 && fitsFree(ctx, px, pz, 6)) ctx.vehicle(i === 1 ? 'plane:plane_stunt' : 'plane:plane_trainer', px, pz, yaw + Math.PI + (R() - 0.5) * 0.3, { color: GA_COLORS[Math.floor(R() * GA_COLORS.length)] });
    }
    ctx.view([x + nx * s * 60 + rw.dx * 50, 22, z + nz * s * 60 + rw.dz * 50], [x, 6, z], 'hangar');
  }
  { // three-quarter view from beside the threshold, high enough to clear the trees
    const gy = ctx.groundY(rw.cx, rw.cz), n2x = -rw.dz, n2z = rw.dx;
    ctx.view([rw.x0 - rw.dx * 90 + n2x * 110, gy + 70, rw.z0 - rw.dz * 90 + n2z * 110], [rw.cx, gy, rw.cz], 'strip');
  }
  return { strip: rw };
}

function findStrip(ctx, x, z) {
  return findStripEdge(ctx.roads, x, z)?.rect || stripFromGround(ctx, x, z);
}

// airstrips the road graph does not carry: the source map draws them as a thin grey bar, classified as road /
// paved ground. Connected road / paved texels near the marker that no road ribbon covers, fitted with a principal
// axis; accepted when long and narrow (>= 200 m, <= 45 m wide, ratio >= 6).
function stripFromGround(ctx, x, z, maxR = 420) {
  const T = ctx.terrain, G = T.G;
  if (!T.ground || !G) return null;
  const ts = T.ts, tw = T.tw;
  const ok = (i, j) => {
    const g = T.ground[j * tw + i];
    if (g !== G.road && g !== G.paved) return false;
    const px = T.x0 + (i + 0.5) * ts, pz = T.z0 + (j + 0.5) * ts;
    return Math.hypot(px - x, pz - z) < maxR && ctx.clearOfRoads(px, pz, 2);
  };
  const seen = new Set();
  let best = null;
  const ic = Math.floor((x - T.x0) / ts), jc = Math.floor((z - T.z0) / ts), R = Math.ceil(maxR / ts);
  for (let dj = -R; dj <= R; dj += 2) for (let di = -R; di <= R; di += 2) {
    const i = ic + di, j = jc + dj, k = j * tw + i;
    if (seen.has(k) || !ok(i, j)) continue;
    const comp = [], st = [[i, j]];
    seen.add(k);
    while (st.length && comp.length < 1500) {
      const [a, c] = st.pop();
      comp.push([T.x0 + (a + 0.5) * ts, T.z0 + (c + 0.5) * ts]);
      for (const [da, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const kk = (c + dc) * tw + a + da;
        if (seen.has(kk) || !ok(a + da, c + dc)) continue;
        seen.add(kk); st.push([a + da, c + dc]);
      }
    }
    if (comp.length < 25 || comp.length >= 1500) continue;
    let mx = 0, mz = 0;
    for (const [px, pz] of comp) { mx += px; mz += pz; }
    mx /= comp.length; mz /= comp.length;
    let sxx = 0, sxz = 0, szz = 0;
    for (const [px, pz] of comp) { sxx += (px - mx) ** 2; sxz += (px - mx) * (pz - mz); szz += (pz - mz) ** 2; }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz), dx = Math.cos(ang), dz = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [px, pz] of comp) {
      const u = (px - mx) * dx + (pz - mz) * dz, v = (pz - mz) * dx - (px - mx) * dz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const len = u1 - u0 + ts, wid = v1 - v0 + ts;
    if (len < 200 || wid > 45 || len / wid < 6) continue;
    const d = Math.hypot(mx - x, mz - z);
    if (best && best.d <= d) continue;
    const vm = (v0 + v1) / 2;
    const ox = mx + -dz * vm, oz = mz + dx * vm; // axis through the middle of the bar
    best = {
      d, rect: {
        x0: ox + dx * (u0 - ts / 2), z0: oz + dz * (u0 - ts / 2), x1: ox + dx * (u1 + ts / 2), z1: oz + dz * (u1 + ts / 2), dx, dz, len,
        w: Math.max(18, Math.min(30, wid)), y: ctx.groundY(mx, mz), cx: ox + dx * (u0 + u1) / 2, cz: oz + dz * (u0 + u1) / 2, airport: 'strip', strip: true,
      },
    };
  }
  return best?.rect || null;
}
