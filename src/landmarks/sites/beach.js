import { K, LOD, W, obb, rng, inside } from '../kit.js';
import { L } from '../lights.js';
import { signQuad, signBoard, antenna, windsock } from '../parts.js';
import { FONT } from '../atlas.js';
import { parkingRow, scatterPark } from './parking.js';
import { LOT_CARS } from '../vehicles.js';

// "H" landing pad texture (shared by the hospital and the police HQ roofs)
function helipadCell(atlas) {
  return atlas.add('helipad', 256, 256, (gx, x, y, w, h) => {
    gx.fillStyle = 'rgba(60,62,66,0.55)'; gx.fillRect(x, y, w, h);
    gx.strokeStyle = '#f2c200'; gx.lineWidth = 10; gx.beginPath(); gx.arc(x + w / 2, y + h / 2, w * 0.42, 0, 7); gx.stroke();
    gx.fillStyle = '#ffffff'; gx.font = FONT.block.replace('{s}', 150); gx.textAlign = 'center'; gx.textBaseline = 'middle'; gx.fillText('H', x + w / 2, y + h / 2 + 8);
  });
}

// Ocean Drive art-deco hotel row (pastel facades, eyebrow ledges, rounded corners, vertical fins with neon
// names, stepped parapets), art-deco and modern police stations with real patrol cars (catalog models) and a
// roof helipad at the HQ, beach medical centre with a rooftop helipad, air ambulance and ambulances. All names
// are invented.

const PASTEL = [0xf7b3cc, 0xa6e6d8, 0xfde7a0, 0xcdbdf5, 0xffcfa8, 0xb0dcf6, 0xfbf7ef, 0xf6d6e4, 0xc9f0c4];
const TRIM = [0xffffff, 0xf3efe6, 0x2f8f9f, 0xe0457b];
const NEON_CSS = ['#ff4fa8', '#2ff0e0', '#b45cff', '#ff9a3d', '#58d8ff', '#ff6464'];
const NAMES = ['CORALINE', 'AZULITA', 'SEAFOAM', 'VELVET TIDE', 'SUNWAVE', 'MIRAMAR DECO', 'FLAMINIA', 'NEPTUNA', 'PALMETTA', 'LA BRISA',
  'AQUAMARA', 'ROSEWATER', 'MOONBEAM', 'HIBISCUS', 'PEARLITA', 'SAILFISH', 'CASA LUMINA', 'OCEANA VISTA', 'DUNEHAVEN', 'LIDO ROSA', 'MARISOLA', 'TIDEWELL'];

// orient an OBB so local +z faces direction (fx, fz); returns {yaw, w (along x), d (along z)}
function faceTo(ob, fx, fz) {
  let best = null;
  for (let k = 0; k < 4; k++) {
    const yaw = ob.yaw + (k * Math.PI) / 2;
    const dot = Math.sin(yaw) * fx + Math.cos(yaw) * fz;
    if (!best || dot > best.dot) best = { yaw, dot, w: k % 2 ? ob.wid : ob.len, d: k % 2 ? ob.len : ob.wid };
  }
  return best;
}

// one art-deco hotel in the local frame (front = +z), size w x d, floors n
export function decoHotel(ctx, cx, cz, yaw, w, d, n, R, name, { y0 = null, colour = null } = {}) {
  const { b, sign, atlas, lights } = ctx;
  const g = y0 ?? ctx.groundY(cx, cz) - 0.5;
  const col = colour ?? PASTEL[Math.floor(R() * PASTEL.length)];
  const trim = TRIM[Math.floor(R() * 2)];
  const neon = NEON_CSS[Math.floor(R() * NEON_CSS.length)];
  const neonHex = parseInt(neon.slice(1), 16);
  const fh = 3.2, H = n * fh + 1.2;
  const hw = w / 2, hd = d / 2;
  b.push(); b.translate(cx, g, cz).rotY(yaw);
  // body with rounded front corners (chamfer polygon approximating quarter circles)
  const rc = Math.min(3.5, w * 0.16);
  // quarter circles centred at (hw-rc, hd-rc) and (-hw+rc, hd-rc)
  const poly = [];
  poly.push([-hw, -hd], [hw, -hd]);
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * (Math.PI / 2); poly.push([hw - rc + Math.cos(a) * rc, hd - rc + Math.sin(a) * rc]); }
  for (let i = 0; i <= 4; i++) { const a = Math.PI / 2 + (i / 4) * (Math.PI / 2); poly.push([-hw + rc + Math.cos(a) * rc, hd - rc + Math.sin(a) * rc]); }
  b.paint(col, K.WIN, W.DECO);
  b.prism(poly, 0, H, { topPaint: [0xd9d4cc, K.ROOF] });
  b.colBox(-hw, 0, -hd, hw, H, hd);
  // eyebrow ledges over every floor on the front + sides of the rounded corners
  b.lod = LOD.NEAR;
  b.paint(trim, K.PLAIN);
  for (let f = 1; f < n; f++) b.box(-hw + 0.2, f * fh - 0.25, hd - 0.1, hw - 0.2, f * fh, hd + 0.75);
  // ground-floor terrace: low wall, steps
  b.paint(0xf4f0e8, K.PLAIN);
  b.box(-hw + 0.5, 0, hd, hw - 0.5, 0.9, hd + 4.5, 0b111011);
  b.lod = LOD.BOTH;
  // parapet: stepped centre ("ziggurat") + neon line along the front roof edge
  b.paint(trim, K.PLAIN);
  b.box(-hw, H, hd - 0.6, hw, H + 1.2, hd);
  const pw = Math.min(w * 0.42, 9);
  b.box(-pw / 2, H, hd - 2.2, pw / 2, H + 3.2, hd + 0.05);
  b.box(-pw / 3.2, H + 3.2, hd - 1.6, pw / 3.2, H + 4.8, hd + 0.05);
  b.paint(neonHex, K.EMIT, 0);
  b.box(-hw + 0.3, H - 0.55, hd + 0.02, hw - 0.3, H - 0.3, hd + 0.18);
  b.box(-pw / 2 + 0.2, H + 2.75, hd + 0.05, pw / 2 - 0.2, H + 2.95, hd + 0.2);
  // vertical fin carrying the name (half the hotels) or horizontal name on the parapet
  const vertical = R() < 0.55 && H > 11;
  const finX = (R() - 0.5) * w * 0.3;
  if (vertical) {
    b.paint(trim, K.PLAIN);
    b.box(finX - 0.7, fh, hd, finX + 0.7, H + 6, hd + 1.4);
    b.paint(neonHex, K.EMIT, 0);
    b.box(finX - 0.08, H + 6, hd + 0.6, finX + 0.08, H + 7.4, hd + 0.8);
  }
  b.pop();
  // signs
  const fl = R() < 0.12 ? 1 + R() * 5 : 0;
  sign.push(); sign.translate(cx, g, cz).rotY(yaw);
  if (vertical) {
    const cell = atlas.stack(`hotel-v-${name}`, name.replace(/ /g, ''), { w: 64, h: Math.round(name.replace(/ /g, '').length * 46), fg: neon, bg: '#f4efe6' });
    const hgt = Math.min(H + 4, (cell.h / cell.w) * 1.2);
    for (const s of [1, -1]) {
      sign.push(); sign.translate(finX, 0, hd + 0.7).rotY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
      signQuad(sign, cell, -0.62, H + 5 - hgt, 0.62, H + 5, 0.71, { lit: 2, flicker: fl });
      sign.pop();
    }
  } else {
    const cell = atlas.text(`hotel-h-${name}`, name, { w: 384, h: 72, font: FONT.deco, fg: neon, bg: null, glow: true });
    signQuad(sign, cell, -pw / 2 + 0.3, H + 0.2, pw / 2 - 0.3, H + 0.2 + (pw - 0.6) * 0.17, hd + 0.1, { lit: 3, flicker: fl });
    const cell2 = atlas.text('hotel-word', 'HOTEL', { w: 256, h: 64, font: FONT.deco, fg: '#ffffff', bg: null, glow: true });
    signQuad(sign, cell2, -1.6, H + 3.25, 1.6, H + 4.25, hd + 0.1, { lit: 3 });
  }
  sign.pop();
  // warm porch lights
  for (const s of [-0.3, 0.3]) {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const lx = cx + c * s * w + sn * (hd + 0.4), lz = cz - sn * s * w + c * (hd + 0.4);
    lights.add(lx, g + 3.4, lz, 0xffd29a, 0.7, L.STEADY, 0, 900);
  }
  return H;
}

export function oceanDrive(ctx, def) {
  const R = rng(1984);
  const fs = [];
  const B = ctx.buildings;
  for (const id of B.query(def.x, def.z, 700)) {
    const rec = B.recs[id];
    if (!rec || rec.removed || !inside(def.row, rec.cx, rec.cz)) continue;
    const name = B.list[id].n || '';
    if (!(rec.style === 5 || /hotel/i.test(name) || (rec.style === 1 && rec.height >= 10))) continue;
    const p = B.list[id].p, poly = [];
    for (let i = 0; i < p.length; i += 2) poly.push([p[i], p[i + 1]]);
    fs.push({ id, poly, rec });
  }
  fs.sort((a, b) => a.rec.cz - b.rec.cz);
  let k = 0;
  for (const f of fs) {
    const ob = obb(f.poly);
    if (!ob || ob.len < 9 || ob.wid < 7) continue;
    const road = ctx.roads.nearest(ob.cx + 30, ob.cz, 120); // Ocean Drive lies east of the row
    const fx = road ? road.x - ob.cx : 1, fz = road ? road.z - ob.cz : 0;
    const o = faceTo(ob, fx, fz);
    if (!ctx.dryRect(ob.cx, ob.cz, o.yaw, o.w / 2, o.d / 2, 0.15)) continue; // never build a hotel in the sea
    ctx.remove({ ids: [f.id] });
    const big = ob.len * ob.wid > 700;
    const n = big ? 5 + Math.floor(R() * 3) : 3 + Math.floor(R() * 3);
    decoHotel(ctx, ob.cx, ob.cz, o.yaw, Math.max(8, o.w - 0.6), Math.max(7, o.d - 0.6), n, R, NAMES[k % NAMES.length], { y0: f.rec.base - 2 });
    k++;
  }
  ctx.view([def.x + 120, 30, def.z - 160], [def.x - 20, 10, def.z], 'Ocean Drive');
  ctx.view([def.x + 70, 8, def.z + 40], [def.x - 10, 12, def.z - 60], 'street level');
  return { hotels: k };
}

// ---------- police stations ----------
export function policeStation(ctx, def) {
  const { b, sign, atlas, lights } = ctx;
  const f = ctx.footprints(def.x, def.z, 25, 600)[0];
  const ob = f ? obb(f.poly) : { cx: def.x, cz: def.z, yaw: 0, len: 40, wid: 26 };
  if (f) ctx.remove({ ids: [f.id] });
  ctx.hideTrees({ circle: [ob.cx, ob.cz, Math.hypot(ob.len, ob.wid) / 2 + 4] });
  const road = ctx.roads.nearest(ob.cx, ob.cz, 150);
  const o = faceTo(ob, road ? road.x - ob.cx : 1, road ? road.z - ob.cz : 0);
  const g = (f ? f.rec.base : ctx.groundY(ob.cx, ob.cz)) - 1;
  const w = o.w - 1, d = o.d - 1, hw = w / 2, hd = d / 2;
  const R = rng(def.x | 0);
  if (def.style === 'deco') {
    decoHotel(ctx, ob.cx, ob.cz, o.yaw, w, d, 5, R, 'POLICE', { y0: g, colour: 0xf6f2ea });
    // blue neon blade "POLICE" on the corner + flag
    const cell = atlas.stack('police-v', 'POLICE', { w: 64, h: 280, fg: '#3a7bff', bg: '#f6f2ea' });
    sign.push(); sign.translate(ob.cx, g, ob.cz).rotY(o.yaw);
    for (const s of [1, -1]) { sign.push(); sign.translate(hw - 2, 0, hd + 0.9).rotY(s * Math.PI / 2); signQuad(sign, cell, -0.7, 6, 0.7, 6 + 1.4 * 280 / 64, 0.7, { lit: 2 }); sign.pop(); }
    sign.pop();
    b.push(); b.translate(ob.cx, g, ob.cz).rotY(o.yaw);
    b.paint(0xf6f2ea, K.PLAIN); b.box(hw - 2.7, 3.2, hd, hw - 1.3, 20, hd + 1.6);
    b.pop();
  } else {
    b.push(); b.translate(ob.cx, g, ob.cz).rotY(o.yaw);
    b.paint(0xd9d6cf, K.WIN, W.GRID);
    b.box(-hw, 0, -hd, hw, 24, hd);
    b.paint(0x1f3d66, K.GLASS, 1);
    b.box(-hw * 0.5, 0, hd, hw * 0.5, 9, hd + 0.4, 0b110010);
    b.paint(0xe9e7e1, K.PLAIN);
    b.box(-hw * 0.55, 9, hd - 0.4, hw * 0.55, 10, hd + 6);
    b.paint(0xa8aaa8, K.ROOF);
    b.box(-hw, 24, -hd, hw, 24.6, hd);
    b.colBox(-hw, 0, -hd, hw, 24.6, hd);
    antenna(b, lights, hw * 0.5, -hd * 0.4, 24.6, 26, { w: 1.6 });
    // rooftop helipad with the force's helicopter
    const pr = Math.min(hw * 0.45, hd * 0.8, 9);
    b.paint(0x5a5f64, K.METAL);
    b.box(-hw * 0.45 - pr, 24.6, -pr, -hw * 0.45 + pr, 25.1, pr);
    b.pop();
    const pad = helipadCell(atlas);
    sign.push(); sign.translate(ob.cx, g + 25.14, ob.cz).rotY(o.yaw).translate(-hw * 0.45, 0, 0).rotX(-Math.PI / 2);
    signQuad(sign, pad, -pr + 0.3, -pr + 0.3, pr - 0.3, pr - 0.3, 0, { lit: 0 });
    sign.pop();
    const hx = ob.cx + Math.cos(o.yaw) * -hw * 0.45, hz = ob.cz - Math.sin(o.yaw) * -hw * 0.45;
    ctx.vehicle('heli:heli_police', hx, hz, o.yaw + 0.6, { y: g + 25.1, color: 0x1d2a44 });
    ctx.frameView(null, 'police helicopter', { only: /^heli:/, min: 34, elev: 0.75 });
    const cell = atlas.text('vcpd', 'POLICE HEADQUARTERS', { w: 768, h: 96, font: FONT.block, fg: '#ffffff', bg: '#1f3d66' });
    sign.push(); sign.translate(ob.cx, g, ob.cz).rotY(o.yaw);
    signQuad(sign, cell, -hw * 0.8, 19.5, hw * 0.8, 19.5 + hw * 0.2, hd + 0.05, { lit: 1 });
    sign.pop();
  }
  // patrol cars (catalog Sentry cruisers and Sawgrass patrol SUVs, glowing lightbars) nose-in in front of the
  // station, then behind it and along the sides until def.cars are parked; staff cars fill the rest
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
  const P = (lx, lz) => [ob.cx + c * lx + s * lz, ob.cz - s * lx + c * lz];
  const X = [c, -s], Z = [s, c], depth = 5.8, bay = 2.9;
  const rows = [
    { o: P(-hw + 0.5, hd + 1.2 + depth), u: X, v: [-Z[0], -Z[1]], n: Math.floor((2 * hw - 1) / bay) }, // front, facing the station
    { o: P(-hw + 0.5, -hd - 1.2 - depth), u: X, v: Z, n: Math.floor((2 * hw - 1) / bay) }, // back
    { o: P(hw + 1.2 + depth, -hd + 0.5), u: Z, v: [-X[0], -X[1]], n: Math.floor((2 * hd - 1) / bay) }, // right side
    { o: P(-hw - 1.2 - depth, -hd + 0.5), u: Z, v: X, n: Math.floor((2 * hd - 1) / bay) }, // left side
  ];
  let need = def.cars || 4, k = 0;
  for (const r of rows) {
    const police = need > 0;
    const res = parkingRow(ctx, {
      x: r.o[0], z: r.o[1], ux: r.u[0], uz: r.u[1], vx: r.v[0], vz: r.v[1], n: r.n, bay, depth, seed: (def.x | 0) + k++,
      keys: police ? ['police:cruiser', 'police:cruiser', 'police:patrol_suv'] : LOT_CARS, fill: police ? 1 : 0.6,
      max: police ? need : 8,
    });
    need -= res.placed;
  }
  ctx.frameView(null, 'patrol cars', { only: /^police:/ });
  ctx.view([ob.cx + s * 70 + c * 30, g + 26, ob.cz + c * 70 - s * 30], [ob.cx, g + 10, ob.cz], def.kind);
}

// ---------- hospital with rooftop helipad ----------
export function hospital(ctx, def) {
  const { b, sign, atlas, lights } = ctx;
  const f = ctx.footprints(def.x, def.z, 25, 600)[0];
  if (!f) return { skipped: true };
  const ob = obb(f.poly);
  ctx.remove({ ids: [f.id] });
  const road = ctx.roads.nearest(ob.cx, ob.cz, 150);
  const o = faceTo(ob, road ? road.x - ob.cx : 1, road ? road.z - ob.cz : 0);
  const g = f.rec.base - 2, H = Math.max(40, f.rec.height);
  const hw = o.w / 2 - 0.5, hd = o.d / 2 - 0.5;
  b.push(); b.translate(ob.cx, g, ob.cz).rotY(o.yaw);
  b.paint(0xf1f2ef, K.WIN, W.GRID);
  b.box(-hw, 0, -hd, hw, H, hd);
  b.paint(0x2a8fbd, K.GLASS, 0);
  for (const s of [1, -1]) b.box(-0.25 + s * hw * 0.4 - 2, 6, hd, s * hw * 0.4 + 2, H - 2, hd + 0.35, 0b110010);
  b.colBox(-hw, 0, -hd, hw, H + 2, hd);
  // emergency canopy
  b.paint(0xe8e8e8, K.PLAIN);
  b.box(-hw * 0.6, 4.4, hd, hw * 0.6, 5.1, hd + 9);
  b.lod = LOD.NEAR;
  b.paint(0x9aa0a6, K.METAL);
  for (const s of [-1, 1]) b.cyl(s * hw * 0.55, hd + 8.3, 0, 4.4, 0.25, 0.25, 6);
  b.lod = LOD.BOTH;
  // helipad deck on the roof
  const pr = Math.min(hw, hd) * 0.95;
  b.paint(0x5a5f64, K.METAL);
  b.box(-pr, H, -pr, pr, H + 2, pr);
  b.paint(0x3a3d40, K.PAINT);
  b.box(-pr + 0.2, H + 2, -pr + 0.2, pr - 0.2, H + 2.1, pr - 0.2, 0b001000);
  b.pop();
  const pad = helipadCell(atlas);
  sign.push(); sign.translate(ob.cx, g + H + 2.14, ob.cz).rotY(o.yaw).rotX(-Math.PI / 2);
  signQuad(sign, pad, -pr + 0.4, -pr + 0.4, pr - 0.4, pr - 0.4, 0, { lit: 0 });
  sign.pop();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const p = [ob.cx + Math.cos(a) * pr * 0.92, g + H + 2.3, ob.cz + Math.sin(a) * pr * 0.92];
    lights.add(p[0], p[1], p[2], i % 2 ? 0x30ff70 : 0xffffff, 0.6, L.STEADY, 0, 2500);
  }
  windsock(b, lights, ob.cx + Math.cos(o.yaw) * (hw - 1), ob.cz - Math.sin(o.yaw) * (hw - 1), g + H + 2, 0.4);
  // air ambulance on the pad (catalog Vella N2 in white), ambulances under the emergency canopy
  ctx.vehicle('heli:heli_news', ob.cx, ob.cz, o.yaw + 0.4, { y: g + H + 2.1, color: 0xf6f4ef });
  {
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    // backed in under / beside the canopy, nose out towards the drive; first free spots of a small grid
    let n = 0;
    for (const lz of [hd + 4.8, hd + 3.6, hd + 7]) for (const lx of [-hw * 0.3, hw * 0.3, -hw * 0.55, hw * 0.55, -hw * 0.75, hw * 0.75]) {
      if (n >= 2) break;
      const x = ob.cx + c * lx + s * lz, z = ob.cz - s * lx + c * lz;
      if (!ctx.park('car:ambulance', x, z, o.yaw + Math.PI, { structures: false, color: 0xf6f4ef })) continue;
      n++;
    }
    if (n < 2) scatterPark(ctx, ob.cx + s * (hd + 12), ob.cz + c * (hd + 12), { r: 45, n: 2 - n, keys: ['car:ambulance'], colors: [0xf6f4ef], seed: 5 });
    ctx.frameView(null, 'emergency', { only: /ambulance/, min: 30, elev: 1.0, from: [s, c] });
    ctx.frameView(null, 'air ambulance', { only: /^heli:/, min: 30, elev: 0.9 });
  }
  const er = atlas.text('emergency', 'EMERGENCY', { w: 512, h: 96, font: FONT.block, fg: '#ffffff', bg: '#c8202a' });
  const nm = atlas.text('hosp-name', def.sign || 'VICE BEACH MEDICAL CENTER', { w: 768, h: 72, font: FONT.bold, fg: '#1d4f91', bg: null });
  sign.push(); sign.translate(ob.cx, g, ob.cz).rotY(o.yaw);
  signBoard(sign, er, -5, 5.1, 5, 6.3, hd + 8.6, hd + 9.1, { lit: 1, frame: 0xc8202a, white: atlas.white });
  signQuad(sign, nm, -hw * 0.9, H - 4.5, hw * 0.9, H - 4.5 + hw * 0.18, hd + 0.4, { lit: 3 });
  sign.pop();
  ctx.view([ob.cx + Math.sin(o.yaw) * 120, g + H + 40, ob.cz + Math.cos(o.yaw) * 120], [ob.cx, g + H * 0.7, ob.cz], 'hospital');
}
