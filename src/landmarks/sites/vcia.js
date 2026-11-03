import { K, LOD, W, obb, rng } from '../kit.js';
import { L } from '../lights.js';
import { signQuad, signBoard, mast, fenceLine, windsock } from '../parts.js';
import { FONT } from '../atlas.js';
import { AIRCRAFT, LIVERIES } from './aircraft.js';
import { strip, standsAlong, dressStand, controlTower, hangar, fuelFarm, garage, cargoShed, fireStation, radarTower, clearAirside } from './airport.js';
import { airsideMask } from './infield.js';
import { runwayFurniture, taxiwayFurniture } from './airfield.js';
import { runwaySurface, drawnRunways } from './runways.js';

// VCI — Vice City International. Terminal horseshoe around the two garages, concourses D (north-west), F (west),
// J (south) and the satellite E with a skybridge, control tower rising from the west hall, maintenance and GA
// hangars, cargo sheds, fire station, radar, fuel farm, apron masts, airfield lighting and signage.
// Coordinates follow the community-map footprints of the real-world-inspired terminal area.

const NAME = 'Vice City International Airport';
// body colours of parked light aircraft (mostly white, as on a real GA apron)
export const GA_COLORS = [0xf4f2ee, 0xf4f2ee, 0xf4f2ee, 0xe9e5da, 0x1f5fbf, 0xd23a3a, 0x2f8f3a, 0x111111];

export function* vcia(ctx, def) { // generator: yields between sections (sliced build)
  const { b, sign, atlas, lights } = ctx;
  const runways = (ctx.roads.runways || []).filter((r) => r.airport === NAME);
  const zone = (x, z) => x > -3700 && x < -1650 && z > -60 && z < 1700;

  // ---------- clear the generic footprints the new terminal replaces ----------
  const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  for (const poly of [
    rect(-2402, 556, -2312, 862), // west hall + tower
    [[-2362, 858], [-2300, 858], [-2236, 898], [-1996, 902], [-1996, 978], [-2362, 978]], // south hall
    rect(-2200, 960, -2132, 1212), // concourse J
    rect(-2628, 498, -2380, 560), rect(-2425, 522, -2330, 612), // concourse D + link
    rect(-2475, 596, -2370, 760), // concourse F
    rect(-2642, 688, -2524, 852), rect(-2526, 738, -2400, 802), // satellite E + skybridge
  ]) ctx.remove({ poly });
  ctx.hideTrees({ poly: rect(-2650, 500, -1990, 1215) });
  // tidy forecourt inside the horseshoe: small leftover blocks between the curb road and the garages
  ctx.remove({ poly: rect(-2300, 615, -1975, 905), filter: (r, id) => r.height < 16 && !ctx.footprints(r.cx, r.cz, 1, 3500).some((f) => f.id === id) });
  ctx.lap('clear');

  // ---------- main terminal hall (landside on the left) ----------
  const spine = [[-2345, 600], [-2345, 790], [-2328, 852], [-2290, 898], [-2228, 924], [-2120, 930], [-2008, 930]];
  const hall = strip(ctx, spine, { smooth: 2, step: 8, wl: 21, wr: 27, adapt: true, pad: 2.5, minW: 10, h: 19, rise: 4.5, canopy: 10, lowL: 0, lowR: 5, wave: 120 });
  // concourses
  const D = strip(ctx, [[-2352, 600], [-2394, 540], [-2614, 526]], { step: 6, wl: 12, wr: 12, h: 13, rise: 2.6, bridge: true, lowL: 4.5, lowR: 4.5, y0: hall.y0 });
  const F = strip(ctx, [[-2366, 712], [-2474, 712]], { step: 6, wl: 11, wr: 11, h: 12, rise: 2.2, bridge: true, lowL: 4.5, lowR: 4.5, y0: hall.y0 });
  const J = strip(ctx, [[-2165, 945], [-2165, 1192]], { step: 6, wl: 12, wr: 12, h: 13, rise: 2.6, bridge: true, lowL: 4.5, lowR: 4.5, y0: hall.y0 });
  strip(ctx, [[-2366, 768], [-2578, 768]], { step: 6, wl: 3.6, wr: 3.6, h: 11, rise: 1.2, allBridge: true, bridgeY: 6.6, lowL: 0, lowR: 0, y0: hall.y0, noEndCap: true });
  const E = strip(ctx, [[-2600, 700], [-2600, 842]], { step: 6, wl: 21, wr: 21, h: 14, rise: 4, bridge: true, lowL: 4.5, lowR: 4.5, y0: hall.y0 });
  ctx.lap('strips');

  yield;
  // ---------- stands, jet bridges, gate signs ----------
  let liv = 0, seed = 11;
  const numCells = (pfx, n) => atlas.text(`std-${pfx}${n}`, `${pfx}${n}`, { w: 96, h: 64, font: FONT.mono, fg: '#f2c200', bg: '#3a3b3f' });
  const dress = (list, pfx, opts = {}) => list.forEach((s, i) => {
    const n = i + 1;
    const empty = ((seed * 7 + i * 13) % 10) < (opts.emptyShare ?? 2);
    dressStand(ctx, s, { name: `${pfx}${n}`, livery: liv++, seed: seed++, plane: !empty, numberCell: numCells(pfx, n) });
  });
  dress(standsAlong(ctx, hall, -1, { spacing: 64, types: ['narrow', 'wide', 'narrow'], from: 0.04, to: 0.97 }), 'H');
  const d = [...standsAlong(ctx, D, 1, { spacing: 50, from: 0.32, to: 0.98 }), ...standsAlong(ctx, D, -1, { spacing: 50, from: 0.32, to: 0.98 })];
  dress(d, 'D');
  dress([...standsAlong(ctx, F, 1, { spacing: 46, types: ['narrow'], from: 0.2 }), ...standsAlong(ctx, F, -1, { spacing: 46, types: ['narrow'], from: 0.2 })], 'F');
  dress([...standsAlong(ctx, J, 1, { spacing: 70, types: ['wide', 'narrow'], from: 0.15 }), ...standsAlong(ctx, J, -1, { spacing: 70, types: ['narrow', 'wide'], from: 0.15 })], 'J');
  dress([...standsAlong(ctx, E, -1, { spacing: 72, types: ['wide'], from: 0.0, to: 1.0 }), ...standsAlong(ctx, E, 1, { spacing: 66, types: ['wide', 'narrow'], from: 0.0, to: 1.0 })], 'E', { emptyShare: 3 });

  ctx.lap('stands');
  yield;
  // ---------- remote stands on open apron (pushback towards the nearest taxilane) ----------
  const remote = [];
  for (let x = -2900; x <= -1900; x += 40) for (let z = 380; z <= 1300; z += 40) {
    if (remote.length >= 10) break;
    const type = remote.length % 3 === 2 ? 'wide' : 'narrow';
    const r = type === 'wide' ? 34 : 22;
    if (!fits(ctx, x, z, r) || remote.some((p) => Math.hypot(p[0] - x, p[1] - z) < r * 2.4)) continue;
    // stay out of the runway strips (graded grass +-75 m from each runway centreline)
    if (runways.some((rw) => { const u = (x - rw.x0) * rw.dx + (z - rw.z0) * rw.dz, v = (x - rw.x0) * -rw.dz + (z - rw.z0) * rw.dx; return u > -120 && u < rw.len + 120 && Math.abs(v) < rw.w / 2 + 80 + r; })) continue;
    // must be on paved apron: no grass under the tail / wing tips
    if (ctx.terrain.groundAt && [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].some(([ox, oz]) => ctx.terrain.groundAt(x + ox, z + oz) !== ctx.terrain.G?.paved)) continue;
    const hit = ctx.roads.nearest(x, z, 140);
    if (!hit || hit.dist > 110) continue;
    const tx = hit.x - x, tz = hit.z - z, l = Math.hypot(tx, tz) || 1;
    remote.push([x, z]);
    const yaw = Math.atan2(tx / l, tz / l);
    ctx.instance(AIRCRAFT[type], x, ctx.groundY(x, z), z, yaw, LIVERIES[(liv++) % LIVERIES.length], 1);
    // apron bus at the forward left door (catalog Metro 40), parked parallel to the fuselage
    const c = Math.cos(yaw), sn = Math.sin(yaw), lx = -(type === 'wide' ? 9 : 8), lz = type === 'wide' ? -14 : -9;
    ctx.park('car:city_bus', x + c * lx + sn * lz, z - sn * lx + c * lz, yaw, { color: 0xf4f4f2 });
  }
  ctx.lap('remote');
  // ---------- apron flood masts along the airside faces ----------
  const masts = (st, side, every = 120, off = 46) => {
    const S = st.S;
    for (let i = 2; i < S.length - 2; i += Math.max(1, Math.round(every / st.step))) {
      const s = S[i];
      const w = side > 0 ? s.wl : s.wr;
      const x = s.x + s.lx * side * (w + off), z = s.z + s.lz * side * (w + off);
      if (!ctx.clearOfRoads(x, z, 2.5) || ctx.groundY(x, z) < 0.3) continue;
      mast(b, lights, x, z, ctx.groundY(x, z) - 0.2, 26, { heads: 4, color: 0xffe9c4, size: 2.6 });
    }
  };
  masts(hall, -1, 110, 72); masts(D, 1, 100, 52); masts(D, -1, 100, 52); masts(J, 1, 110, 74); masts(J, -1, 110, 74); masts(E, -1, 100, 74);

  yield;
  // ---------- control tower rising from the west hall ----------
  controlTower(ctx, -2352, 776, { h: 78, y0: hall.y0, name: 'VCI' });

  // ---------- landside signage ----------
  const big = atlas.text('vci-big', 'VCI  ·  VICE CITY INTERNATIONAL', { w: 1280, h: 96, font: FONT.block, fg: '#ffffff', bg: null, glow: true });
  const s0 = hall.S[Math.floor(hall.S.length * 0.18)];
  sign.push();
  sign.translate(s0.x + s0.lx * (s0.wl + 0.5), hall.top + 3.2, s0.z + s0.lz * (s0.wl + 0.5)).rotY(Math.atan2(s0.lx, s0.lz));
  signQuad(sign, big, -38, 0, 38, 5.5, 0, { lit: 3 });
  sign.pop();
  const dep = atlas.text('departures', '✈  DEPARTURES', { w: 512, h: 80, font: FONT.bold, fg: '#ffffff', bg: '#123d66' });
  const arr = atlas.text('arrivals', '✈  ARRIVALS  ·  BAGGAGE', { w: 512, h: 80, font: FONT.bold, fg: '#123d66', bg: '#f2c200' });
  for (const f of [0.08, 0.32, 0.55, 0.78]) {
    const s = hall.S[Math.floor(hall.S.length * f)];
    for (const [cell, y] of [[dep, hall.top - 4.2], [arr, hall.y0 + 5.6]]) {
      sign.push();
      sign.translate(s.x + s.lx * (s.wl + 0.4), y, s.z + s.lz * (s.wl + 0.4)).rotY(Math.atan2(s.lx, s.lz));
      signBoard(sign, cell, -5, 0, 5, 1.6, -0.3, 0.1, { lit: 1, frame: 0x1a1d21, white: atlas.white });
      sign.pop();
    }
  }
  const airside = atlas.text('vci-air', 'VICE CITY', { w: 768, h: 112, font: FONT.block, fg: '#ffffff', bg: null, glow: true });
  const s1 = E.S[Math.floor(E.S.length / 2)];
  sign.push();
  sign.translate(s1.x - s1.lx * (s1.wr + 0.5), E.top + 3, s1.z - s1.lz * (s1.wr + 0.5)).rotY(Math.atan2(-s1.lx, -s1.lz));
  signQuad(sign, airside, -16, 0, 16, 4.6, 0, { lit: 3 });
  sign.pop();

  // ---------- garages in the horseshoe ----------
  for (const [x, z, name] of [[-2117, 702, 'P1'], [-2128, 840, 'P2']]) {
    const f = ctx.footprints(x, z, 40, 4000)[0];
    if (!f) continue;
    ctx.remove({ ids: [f.id] });
    garage(ctx, f.poly, { levels: 5, name, seed: x | 0 });
  }

  yield;
  // ---------- maintenance base: big wide-body hangar (doors north) ----------
  ctx.remove({ circle: [-2147, 459, 30] });
  hangar(ctx, -2152, 466, Math.PI, 150, 62, 30, { name: 'LEONIDA AIR TECHNICAL BASE' });
  // GA hangar row on the north apron, doors south
  for (const [x, z] of [[-2960, 26], [-2923, 42], [-2889, 37], [-2853, 44], [-2812, 28], [-2780, 35]]) {
    const f = ctx.footprints(x, z, 20, 1500)[0];
    if (f) ctx.remove({ ids: [f.id] });
  }
  [-2960, -2924, -2888, -2852, -2816, -2780].forEach((x, i) => hangar(ctx, x, 36, 0, 34, 64, i % 2 ? 18 : 16, { name: i === 2 ? 'SKYWAY AVIATION' : i === 4 ? 'SUNCOAST CHARTER' : '', color: i % 2 ? 0xd6dadc : 0xe4e2dc }));

  // ---------- cargo ----------
  for (const [x, z, name] of [[-1843, 1181, 'LEONIDA CARGO'], [-1846, 1418, 'SOUTHERN FREIGHT'], [-3188, 964, 'ISLAND CARGO']]) {
    const f = ctx.footprints(x, z, 40, 1200)[0];
    if (!f) continue;
    ctx.remove({ ids: [f.id] });
    if (x < -3000) { const g2 = ctx.footprints(-3208, 978, 30, 800)[0]; if (g2) ctx.remove({ ids: [g2.id] }); }
    const ob = obb(f.poly);
    // docks face the apron (towards the airport centre)
    const to = [-2500 - ob.cx, 900 - ob.cz];
    const zx = Math.sin(ob.yaw), zz = Math.cos(ob.yaw);
    cargoShed(ctx, ob, { h: 13, name, side: zx * to[0] + zz * to[1] > 0 ? 1 : -1 });
    // freighters on the cargo apron in front of the docks
    const side = zx * to[0] + zz * to[1] > 0 ? 1 : -1;
    const nx = zx * side, nz = zz * side;
    for (const t of [-0.25, 0.25]) {
      const px = ob.cx + Math.cos(ob.yaw) * ob.len * t + nx * (ob.wid / 2 + 52), pz = ob.cz - Math.sin(ob.yaw) * ob.len * t + nz * (ob.wid / 2 + 52);
      if (!fits(ctx, px, pz, 36)) continue;
      ctx.instance(AIRCRAFT.widecargo, px, ctx.groundY(px, pz), pz, Math.atan2(nx, nz), LIVERIES[(liv++) % LIVERIES.length], 1);
    }
  }

  yield;
  // ---------- fire station, radar, fuel farm ----------
  const fs = ctx.footprints(-3161, 590, 30, 500)[0];
  if (fs) ctx.remove({ circle: [-3155, 585, 28] });
  fireStation(ctx, -3160, 590, Math.PI);
  const [rx, rz] = ctx.spot(-3255, 546, 12, { maxR: 80, dryR: 12 });
  radarTower(ctx, rx, rz, { h: 26 });
  const fuel = findClear(ctx, [[-3060, 460], [-3300, 420], [-1960, 560], [-2980, 1200]], 60);
  if (fuel) fuelFarm(ctx, fuel[0], fuel[1], 0.2, { tanks: 6, r: 9, h: 13 });

  // ---------- GA apron: light aircraft + business jets in front of the hangars ----------
  const R = rng(91);
  let k = 0;
  // catalog aircraft: Pipit 150 trainers, Vortica aerobatic planes and Solstice 7 business jets
  for (let x = -2985; x < -2755; x += 16) {
    const z = 108 + (k % 2) * 4;
    const key = k % 4 === 1 ? 'plane:plane_jet' : k % 5 === 3 ? 'plane:plane_stunt' : 'plane:plane_trainer';
    if (fits(ctx, x, z, key === 'plane:plane_jet' ? 9 : 6)) ctx.vehicle(key, x, z, Math.PI + (R() - 0.5) * 0.2, { color: GA_COLORS[Math.floor(R() * GA_COLORS.length)] });
    k++;
  }
  // regional turboprops on remote stands west of the satellite
  for (let i = 0; i < 4; i++) {
    const x = -2700 - i * 34, z = 900;
    if (fits(ctx, x, z, 15)) ctx.instance(AIRCRAFT.turboprop, x, ctx.groundY(x, z), z, Math.PI, LIVERIES[(i * 3 + 2) % LIVERIES.length], 1);
  }

  ctx.lap('buildings');
  yield;
  // ---------- airfield lighting, signs, windsocks ----------
  const drawn = drawnRunways(ctx, runways);
  const byLen = drawn.slice().sort((a, b) => b.len - a.len);
  byLen.forEach((rw, i) => runwaySurface(ctx, rw, { primary: byLen.slice(0, i) }));
  runwayFurniture(ctx, drawn, { approach: 720, numbers: false });
  ctx.lap('runways');
  const tx = taxiwayFurniture(ctx, zone, { runways: drawn });
  ctx.lap('taxiways');
  // no generic city blocks on the airfield: airside footprints removed, large ones rebuilt as airport buildings
  yield;
  const cleared = clearAirside(ctx, airsideMask(ctx.L, drawn, { reach: 520 }), -2600, 760, 1700);
  // grass between runways, taxiways and aprons (terrain ground classes, applied after every site is placed)
  ctx.infield(drawn, { reach: 520 });

  // ---------- north perimeter fence (behind the GA hangars) ----------
  fenceLine(b, [[-3560, -36], [-3000, -36], [-2740, -14], [-2560, 30]], (x, z) => ctx.groundY(x, z), { h: 2.6, step: 5, gaps: autoGaps(ctx, [[-3560, -36], [-3000, -36], [-2740, -14], [-2560, 30]]) });

  // ---------- tour views ----------
  ctx.view([-2232, 46, 690], [-2346, 14, 742], 'terminal landside');
  ctx.view([-2620, 150, 1010], [-2345, 0, 760], 'apron overview');
  const js = J.S[Math.floor(J.S.length * 0.55)];
  ctx.view([js.x + js.lx * 95 + js.tx * 60, 26, js.z + js.lz * 95 + js.tz * 60], [js.x + js.lx * 18, 6, js.z + js.lz * 18], 'gates & jet bridges');
  ctx.view([-2450, 96, 860], [-2352, 74, 776], 'control tower');
  ctx.view([-2860, 34, 190], [-2870, 8, 60], 'GA hangars');
  ctx.view([-2150, 40, 330], [-2152, 14, 466], 'maintenance hangar');
  ctx.view([-3860, 30, 262], [-3500, 0, 258], 'approach lights');
  ctx.view([-1990, 50, 1080], [-1850, 6, 1250], 'cargo');
  ctx.view([-2300, 520, 2100], [-2500, 0, 700], 'airport from above');
  return { taxiSigns: tx.signs, cleared };
}

// aircraft-sized clear spot: no roads within r, dry ground, no buildings
function fits(ctx, x, z, r) {
  if (!ctx.dryDisc(x, z, r, 0.2)) return false;
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) if (!ctx.clearOfRoads(x + ox, z + oz, 2)) return false;
  return !ctx.footprints(x, z, r + 15, 30).some((f) => Math.hypot(f.rec.cx - x, f.rec.cz - z) < r + 8);
}

function findClear(ctx, cands, r) {
  for (const [x, z] of cands) {
    const [sx, sz] = ctx.spot(x, z, r, { maxR: 180, step: 20 });
    if (fits(ctx, sx, sz, r * 0.8)) return [sx, sz];
  }
  return null;
}

// gaps where a road crosses a fence polyline
export function autoGaps(ctx, path) {
  const gaps = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    const L0 = Math.hypot(bx - ax, bz - az);
    for (let t = 0; t <= L0; t += 3) {
      const x = ax + (bx - ax) * t / L0, z = az + (bz - az) * t / L0;
      if (!ctx.clearOfRoads(x, z, 1.5)) gaps.push([x, z, 5]);
    }
  }
  return gaps;
}
