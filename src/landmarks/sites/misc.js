import { K, LOD, W, obb, rng, hull2d, superellipse } from '../kit.js';
import { L } from '../lights.js';
import { signQuad, signBoard, antenna, fenceLine, waterTower, mast } from '../parts.js';
import { FONT } from '../atlas.js';
import { scatterPark } from './parking.js';

// State prison (cell blocks inside a double fence with six guard towers and sweeping searchlights), power
// station (containment domes, turbine halls, striped stacks), Mt. Kalaga summit observatory + TV mast,
// golden aquarium dome, fly's-eye sculpture dome, mall sign pylon + atrium, casino with LED chase canopy,
// town water towers, memorial obelisk.

const clearRect = (ctx, x, z, yaw, hx, hz, pad = 2) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const [a, bb] of [[0, 0], [hx, hz], [-hx, hz], [hx, -hz], [-hx, -hz], [hx, 0], [-hx, 0], [0, hz], [0, -hz]]) {
    if (!ctx.clearOfRoads(x + c * a + s * bb, z - s * a + c * bb, pad)) return false;
  }
  return true;
};

// ---------- prison ----------
export function prison(ctx, def) {
  const { b, lights, beams, sign, atlas } = ctx;
  const towers = def.towers;
  const hull = hull2d(towers);
  ctx.remove({ poly: hull });
  ctx.hideTrees({ poly: hull });
  // perimeter: double fence along the tower hexagon (outer 8 m out), gaps at road crossings
  const cx = towers.reduce((a, p) => a + p[0], 0) / towers.length, cz = towers.reduce((a, p) => a + p[1], 0) / towers.length;
  const out = hull.map(([x, z]) => { const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz); return [x + dx / l * 8, z + dz / l * 8]; });
  for (const ring of [hull, out]) {
    const path = [...ring, ring[0]];
    const gaps = [];
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1], L0 = Math.hypot(bx - ax, bz - az);
      for (let t = 0; t <= L0; t += 3) { const x = ax + (bx - ax) * t / L0, z = az + (bz - az) * t / L0; if (!ctx.clearOfRoads(x, z, 1.5)) gaps.push([x, z, 6]); }
    }
    fenceLine(b, path, (x, z) => ctx.groundY(x, z), { h: 4.2, step: 5, gaps, barbed: true });
  }
  // cell blocks: long 3-storey blocks with narrow slit windows, aligned to the main axis
  const ax = Math.atan2(-(towers[1][1] - towers[0][1]), towers[1][0] - towers[0][0]);
  const R = rng(77);
  let blocks = 0;
  const placedB = [];
  for (const [x, z] of def.blocks) {
    if (placedB.some(([px, pz]) => Math.hypot(px - x, pz - z) < 52)) continue;
    const yaw = ax + (R() < 0.5 ? 0 : Math.PI / 2);
    const len = 46 + R() * 18, wid = 15;
    if (!clearRect(ctx, x, z, yaw, len / 2 + 2, wid / 2 + 2)) continue;
    const g = ctx.groundY(x, z) - 0.5;
    b.push(); b.translate(x, g, z).rotY(yaw);
    b.paint(0xcfc8b8, K.WIN, W.INDUSTRIAL);
    b.box(-len / 2, 0, -wid / 2, len / 2, 10.5, wid / 2);
    b.paint(0x9c9a94, K.ROOF);
    b.box(-len / 2 - 0.3, 10.5, -wid / 2 - 0.3, len / 2 + 0.3, 11.2, wid / 2 + 0.3);
    b.colBox(-len / 2, 0, -wid / 2, len / 2, 11.2, wid / 2);
    b.lod = LOD.NEAR;
    b.paint(0x8a8f94, K.METAL);
    b.box(-3, 11.2, -3, 3, 13, 3);
    b.lod = LOD.BOTH;
    b.pop();
    placedB.push([x, z]);
    blocks++;
  }
  // admin block with sign at the main gate
  const [gx, gz] = def.gate;
  const gy = ctx.groundY(gx, gz) - 0.5;
  b.push(); b.translate(gx, gy, gz).rotY(ax);
  b.paint(0xe2dccd, K.WIN, W.GRID);
  b.box(-18, 0, -8, 18, 9, 8);
  b.colBox(-18, 0, -8, 18, 9, 8);
  b.pop();
  const cell = atlas.text('prison', def.sign || 'LEONIDA STATE CORRECTIONAL FACILITY', { w: 768, h: 64, font: FONT.bold, fg: '#ffffff', bg: '#2a3b2f' });
  sign.push(); sign.translate(gx, gy, gz).rotY(ax);
  signQuad(sign, cell, -14, 6.2, 14, 8.4, 8.1, { lit: 1 });
  signQuad(sign, cell, -14, 6.2, 14, 8.4, -8.1, { lit: 1, facing: -1 });
  sign.pop();
  // guard towers with sweeping searchlights
  towers.forEach(([x, z], i) => {
    const g = ctx.groundY(x, z) - 0.4;
    b.paint(0xd9d3c4, K.PLAIN);
    b.box(x - 1.8, g, z - 1.8, x + 1.8, g + 13, z + 1.8);
    b.paint(0x3c4a52, K.GLASS, 1);
    b.box(x - 2.8, g + 13, z - 2.8, x + 2.8, g + 15.6, z + 2.8);
    b.paint(0x55595e, K.METAL);
    b.cyl(x, z, g + 15.6, g + 17.2, 3.8, 0.6, 4, { phase: Math.PI / 4 });
    b.colBox(x - 2, g, z - 2, x + 2, g + 16, z + 2);
    const ph = Math.atan2(cz - z, cx - x);
    beams.add(x, g + 16.2, z, { length: 140, radius: 9, speed: 0.35 + (i % 3) * 0.07, phase: -ph, mode: 1, pitch: -0.22, r0: 0.4 });
    lights.add(x, g + 16.4, z, 0xfff2d8, 1.6, L.ALWAYS, 0, 4000);
    lights.obstacle(x, g + 17.6, z, 1);
  });
  // yard floodlight masts
  for (let i = 0; i < hull.length; i++) {
    const [x0, z0] = hull[i], [x1, z1] = hull[(i + 1) % hull.length];
    const mx = (x0 + x1) / 2 + (cx - (x0 + x1) / 2) * 0.12, mz = (z0 + z1) / 2 + (cz - (z0 + z1) / 2) * 0.12;
    if (ctx.clearOfRoads(mx, mz, 2)) mast(b, lights, mx, mz, ctx.groundY(mx, mz) - 0.3, 22, { heads: 3, color: 0xfff6e8, size: 3, yaw: Math.atan2(cz - mz, -(cx - mx)) });
  }
  // patrol cars, a transport bus and staff vans in the yards (catalog models)
  scatterPark(ctx, cx, cz, { r: 160, n: 7, step: 9, seed: 41, keys: ['police:cruiser', 'police:patrol_suv', 'car:city_bus', 'car:pickup'], colors: [0xf4f4f2, 0xe9e7e1] });
  ctx.view([cx + 260, 140, cz + 200], [cx, 5, cz], 'prison');
  ctx.view([towers[0][0] + 40, 22, towers[0][1] + 60], [towers[0][0], 12, towers[0][1]], 'guard tower');
  return { blocks };
}

// ---------- power station ----------
export function powerStation(ctx, def) {
  const { b, lights, sign, atlas } = ctx;
  for (const [x, z] of def.clear) for (const f of ctx.footprints(x, z, 30, 150)) ctx.remove({ ids: [f.id] });
  // every part on dry land: move a part inland (spiral search) when its spot is wet, drop it if nothing fits
  const dryAt = (x, z, r) => ctx.spot(x, z, 2, { maxR: 120, step: 8, dryR: r, strict: true });
  def = { ...def, domes: def.domes.map(([x, z]) => dryAt(x, z, 21)).filter(Boolean), stacks: def.stacks.map(([x, z]) => dryAt(x, z, 6)).filter(Boolean),
    halls: def.halls.filter(([x, z, yaw, len, wid]) => ctx.dryRect(x, z, yaw, len / 2, wid / 2, 0.3)) };
  // containment buildings: cylinder + dome
  for (const [x, z] of def.domes) {
    const g = ctx.groundY(x, z) - 0.5;
    ctx.hideTrees({ circle: [x, z, 30] });
    b.paint(0xe6e3dc, K.PLAIN);
    b.cyl(x, z, g, g + 38, 20, 20, 20);
    b.dome(x, g + 38, z, 20, 20, 5, { squash: 0.55 });
    b.paint(0xd2cec4, K.PLAIN);
    b.cyl(x, z, g + 36, g + 38.5, 20.4, 20.4, 20, { open: true });
    b.colCyl(x, z, g, g + 49, 20);
    lights.obstacle(x, g + 49.6, z, 1.4);
  }
  // turbine halls (long ribbed sheds) on the old footprints
  for (const [x, z, yaw, len, wid] of def.halls) {
    const g = ctx.groundY(x, z) - 0.5;
    b.push(); b.translate(x, g, z).rotY(yaw);
    b.paint(0xc9ced2, K.METAL);
    b.box(-len / 2, 0, -wid / 2, len / 2, 24, wid / 2);
    b.paint(0x2f6db5, K.PLAIN);
    b.box(-len / 2 - 0.1, 18, -wid / 2 - 0.1, len / 2 + 0.1, 20, wid / 2 + 0.1, 0b110011);
    b.paint(0xa8acb0, K.ROOF);
    b.box(-len / 2, 24, -wid / 2, len / 2, 25, wid / 2);
    b.colBox(-len / 2, 0, -wid / 2, len / 2, 25, wid / 2);
    b.pop();
  }
  // striped stacks
  for (const [x, z] of def.stacks) {
    const g = ctx.groundY(x, z) - 0.5;
    const H = 120;
    for (let k = 0; k < 8; k++) {
      b.paint(k % 2 ? 0xffffff : 0xd8342a, K.PLAIN);
      b.cyl(x, z, g + (k * H) / 8, g + ((k + 1) * H) / 8, 5 - k * 0.35, 5 - (k + 1) * 0.35, 12, { top: k === 7 });
    }
    b.colCyl(x, z, g, g + H, 5);
    lights.obstacle(x, g + H + 0.6, z, 2);
    lights.obstacle(x + 2.4, g + H * 0.5, z, 1.4);
  }
  // switchyard pylons towards the mainland
  for (const [x, z] of def.pylons || []) antenna(b, lights, x, z, ctx.groundY(x, z) - 0.3, 34, { w: 3, color: 0x9aa0a6, alt: 0x9aa0a6 });
  const [sx, sz] = def.signAt;
  const cell = atlas.text('power', def.sign || 'FUZZARD POWER STATION', { w: 768, h: 72, font: FONT.block, fg: '#ffffff', bg: '#2f6db5' });
  sign.push(); sign.translate(sx, ctx.groundY(sx, sz) + 14, sz).rotY(def.signYaw || 0);
  signQuad(sign, cell, -16, 0, 16, 3, 0, { lit: 1 });
  sign.pop();
  const [dx, dz] = def.domes[0] || [def.x, def.z];
  // works vehicles around the halls (catalog trucks and pickups)
  const hx = def.halls.length ? def.halls.reduce((a, h) => a + h[0], 0) / def.halls.length : dx;
  const hz = def.halls.length ? def.halls.reduce((a, h) => a + h[1], 0) / def.halls.length : dz;
  scatterPark(ctx, hx, hz, { r: 140, n: 7, step: 8, seed: 23, keys: ['car:tanker', 'car:semi', 'car:pickup', 'car:pickup', 'car:box_truck'] });
  ctx.view([dx + 220, 90, dz - 160], [dx, 25, dz + 80], 'power station');
}

// ---------- Mt. Kalaga summit: observatory + TV mast ----------
export function summit(ctx, def) {
  const { b, lights } = ctx;
  // find the actual summit near the POI
  let bx = def.x, bz = def.z, bh = -1e9;
  for (let dx = -450; dx <= 450; dx += 15) for (let dz = -450; dz <= 450; dz += 15) {
    const h = ctx.groundY(def.x + dx, def.z + dz);
    if (h > bh) { bh = h; bx = def.x + dx; bz = def.z + dz; }
  }
  ctx.remove({ circle: [bx, bz, 40] });
  ctx.hideTrees({ circle: [bx, bz, 32] });
  const g = Math.min(bh, ctx.groundY(bx + 10, bz), ctx.groundY(bx - 10, bz), ctx.groundY(bx, bz + 10), ctx.groundY(bx, bz - 10)) - 1;
  // observatory: drum + white dome with a dark slit
  b.paint(0xeeeae2, K.WIN, W.GRID);
  b.cyl(bx, bz, g, g + 9, 9, 9, 16);
  b.paint(0xf7f7f7, K.METAL);
  b.dome(bx, g + 9, bz, 9.4, 16, 5);
  b.lod = LOD.NEAR;
  b.paint(0x1d2024, K.PLAIN);
  b.box(bx - 1.1, g + 11, bz + 5.6, bx + 1.1, g + 17.8, bz + 7.4);
  b.lod = LOD.BOTH;
  b.colCyl(bx, bz, g, g + 18, 9.4);
  // visitor centre + viewing deck
  b.paint(0xd9cfbd, K.WIN, W.HOTEL);
  b.box(bx + 14, g, bz - 7, bx + 34, g + 5, bz + 7);
  b.paint(0x8c6b4a, K.PLAIN);
  b.box(bx + 13, g + 5, bz - 8, bx + 35, g + 5.5, bz + 8);
  b.colBox(bx + 14, g, bz - 7, bx + 34, g + 5.5, bz + 7);
  // TV mast
  antenna(b, lights, bx - 22, bz + 6, g, 90, { w: 4.5 });
  lights.add(bx, g + 9.6 + 9.4, bz, 0xfff0c8, 0.9, L.STEADY, 0, 8000);
  ctx.view([bx + 90, g + 40, bz + 70], [bx, g + 15, bz], 'summit');
  ctx.view([bx + 900, g + 160, bz + 700], [bx, g, bz], 'mountain');
  return { summit: [bx, g, bz] };
}

// ---------- domes ----------
export function goldenDome(ctx, def) {
  const { b, lights, sign, atlas } = ctx;
  const f = ctx.footprints(def.x, def.z, 25, 1000)[0];
  const [x, z] = f && ctx.dryDisc(f.rec.cx, f.rec.cz, (def.r || 25) + 1) ? [f.rec.cx, f.rec.cz] : ctx.spot(def.x, def.z, 4, { maxR: 120, dryR: (def.r || 25) + 1 });
  if (f) ctx.remove({ ids: [f.id] });
  const r = def.r || 25;
  let g = Infinity;
  for (let i = 0; i < 8; i++) g = Math.min(g, ctx.groundY(x + Math.cos(i * 0.785) * r, z + Math.sin(i * 0.785) * r));
  g = Math.min(g, ctx.groundY(x, z)) - 1;
  b.paint(0xe8e2d2, K.PLAIN);
  b.cyl(x, z, g, g + 6, r + 1, r + 1, 24);
  b.paint(0xd7a531, K.METAL);
  // faceted geodesic look: dome with alternating ring colours
  const rings = 6;
  for (let k = 0; k < rings; k++) {
    const a0 = (k / rings) * Math.PI / 2, a1 = ((k + 1) / rings) * Math.PI / 2;
    b.paint(k % 2 ? 0xe2b440 : 0xc9952a, K.METAL);
    b.lathe(x, z, [[Math.cos(a0) * r, g + 6 + Math.sin(a0) * r * 0.8], [Math.cos(a1) * r + (k === rings - 1 ? 0 : 0), g + 6 + Math.sin(a1) * r * 0.8]], 24 - k * 2, { capTop: k === rings - 1, phase: k * 0.13 });
  }
  b.colCyl(x, z, g, g + 6 + r * 0.8, r);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; lights.add(x + Math.cos(a) * (r + 2), g + 1, z + Math.sin(a) * (r + 2), 0xffd690, 1.6, L.STEADY, 0, 2500); }
  if (def.sign) {
    const cell = atlas.text(`dome-${def.id}`, def.sign, { w: 768, h: 96, font: FONT.deco, fg: '#ffffff', bg: '#0f6f8f' });
    sign.push(); sign.translate(x, g, z);
    signQuad(sign, cell, -12, 3, 12, 6, r + 1.1, { lit: 1 });
    sign.pop();
  }
  ctx.view([x + 70, g + 30, z + 60], [x, g + 12, z], 'dome');
}

export function flyEye(ctx, def) {
  const { b } = ctx;
  const [x, z] = ctx.spot(def.x, def.z, 7, { maxR: 80, dryR: 8 });
  ctx.remove({ circle: [x, z, 8] });
  const g = ctx.groundY(x, z) - 0.2;
  const r = 6;
  b.paint(0xe9edf0, K.METAL);
  b.sphere(x, g + r * 0.85, z, r, 10, 7);
  b.lod = LOD.NEAR;
  // round "lenses": dark discs on a ring of directions
  b.paint(0x26394a, K.GLASS, 2);
  for (let i = 0; i < 16; i++) {
    const a = (i / 8) * Math.PI * 2 + (i >= 8 ? 0.4 : 0), el = i >= 8 ? 0.85 : 0.3;
    const nx = Math.cos(a) * Math.cos(el), ny = Math.sin(el), nz = Math.sin(a) * Math.cos(el);
    const px = x + nx * r * 0.96, py = g + r * 0.85 + ny * r * 0.96, pz = z + nz * r * 0.96;
    b.beam(px, py, pz, px + nx * 0.25, py + ny * 0.25, pz + nz * 0.25, 1.9, 1.9);
  }
  b.lod = LOD.BOTH;
  b.colCyl(x, z, g, g + r * 1.6, r);
  ctx.view([x + 18, g + 7, z + 14], [x, g + 5, z], 'dome sculpture');
}

// ---------- mall sign pylon + glass atrium ----------
export function mallSign(ctx, def) {
  const { b, sign, atlas, lights } = ctx;
  const [x, z] = ctx.spot(def.x, def.z, 4, { maxR: 80, dryR: 7 });
  ctx.remove({ circle: [x, z, 6] });
  const g = ctx.groundY(x, z) - 0.3;
  const yaw = def.yaw || 0;
  b.push(); b.translate(x, g, z).rotY(yaw);
  b.paint(0x2f7f5a, K.PLAIN);
  b.box(-1.6, 0, -1.6, 1.6, 30, 1.6);
  b.paint(0xf2efe6, K.PLAIN);
  b.box(-6, 22, -1.2, 6, 34, 1.2);
  b.paint(0x2f7f5a, K.PLAIN);
  b.cyl(0, 0, 34, 41, 3.4, 0.2, 6);
  b.colBox(-1.8, 0, -1.8, 1.8, 30, 1.8);
  b.pop();
  const cell = atlas.text('mall', def.sign || 'EVERGREEN MALL', { w: 512, h: 112, font: FONT.deco, fg: '#2f7f5a', bg: '#f2efe6', border: '#2f7f5a' });
  const tenants = atlas.text('mall-t', 'STORES · DINING · CINEMA', { w: 768, h: 96, font: FONT.bold, fg: '#ffffff', bg: '#2f7f5a' });
  sign.push(); sign.translate(x, g, z).rotY(yaw);
  for (const s of [1, -1]) {
    sign.push(); if (s < 0) sign.rotY(Math.PI);
    signQuad(sign, cell, -5.6, 28, 5.6, 33.4, 1.22, { lit: 1 });
    signQuad(sign, tenants, -5.6, 22.6, 5.6, 26.4, 1.22, { lit: 1 });
    sign.pop();
  }
  sign.pop();
  lights.add(x, g + 41.6, z, 0xff2a1a, 1.2, L.OBSTACLE, 0.2, 5000);
  // glass atrium entrance on the biggest mall block nearby
  const f = ctx.footprints(def.mallX ?? x, def.mallZ ?? z, 120, 2000)[0];
  if (f) {
    const ob = obb(f.poly);
    const road = ctx.roads.nearest(ob.cx, ob.cz, 200);
    const fx = road ? road.x - ob.cx : 1, fz = road ? road.z - ob.cz : 0, l = Math.hypot(fx, fz) || 1;
    // put the atrium on the facade facing the road
    const ex = ob.cx + fx / l * (ob.wid / 2 + 2), ez = ob.cz + fz / l * (ob.wid / 2 + 2);
    const gy = f.rec.base - 1;
    b.push(); b.translate(ex, gy, ez).rotY(Math.atan2(fx / l, fz / l));
    b.paint(0x8ab7cf, K.GLASS, 1);
    b.box(-10, 0, -4, 10, 12, 4);
    b.paint(0xe9e9e9, K.METAL);
    b.vault(-10.5, 10.5, -4.5, 4.5, 12, 4, 6, { ends: true });
    b.colBox(-10, 0, -4, 10, 14, 4);
    b.pop();
  }
  ctx.view([x + 40, g + 25, z + 50], [x, g + 26, z], 'mall sign');
}

// ---------- casino with LED chase canopy and neon pylon ----------
export function casino(ctx, def) {
  const { b, sign, atlas, lights } = ctx;
  const f = ctx.footprints(def.x, def.z, 40, 1500)[0];
  if (!f) return { skipped: true };
  const ob = obb(f.poly);
  ctx.remove({ ids: [f.id] });
  const road = ctx.roads.nearest(ob.cx, ob.cz, 200);
  const fx = road ? road.x - ob.cx : 1, fz = road ? road.z - ob.cz : 0;
  let yaw = ob.yaw, w = ob.len, d = ob.wid;
  for (let k = 0; k < 4; k++) { const y = ob.yaw + k * Math.PI / 2; if (Math.sin(y) * fx + Math.cos(y) * fz > Math.sin(yaw) * fx + Math.cos(yaw) * fz) { yaw = y; w = k % 2 ? ob.wid : ob.len; d = k % 2 ? ob.len : ob.wid; } }
  const g = f.rec.base - 1.5, hw = w / 2 - 0.5, hd = d / 2 - 0.5;
  b.push(); b.translate(ob.cx, g, ob.cz).rotY(yaw);
  b.paint(0x2a1f3a, K.WIN, W.OFFICE);
  b.box(-hw, 0, -hd, hw, 14, hd);
  b.paint(0xd8b25a, K.METAL);
  b.box(-hw - 0.3, 14, -hd - 0.3, hw + 0.3, 16, hd + 0.3);
  b.paint(0xff3fa4, K.LED, 1);
  b.box(-hw - 0.4, 14.4, -hd - 0.4, hw + 0.4, 15.6, hd + 0.4, 0b110011);
  // entrance porte-cochère with chase lights
  b.paint(0xf2e2b0, K.PLAIN);
  b.box(-14, 6, hd, 14, 7.4, hd + 14);
  b.paint(0xffd040, K.LED, 1);
  b.box(-14.2, 5.6, hd + 13.9, 14.2, 6.0, hd + 14.3);
  b.lod = LOD.NEAR;
  b.paint(0xd8b25a, K.METAL);
  for (const s of [-1, 1]) b.cyl(s * 12, hd + 12.5, 0, 6, 0.6, 0.6, 8);
  b.lod = LOD.BOTH;
  b.colBox(-hw, 0, -hd, hw, 16, hd);
  // neon pylon
  b.paint(0x2a1f3a, K.PLAIN);
  b.box(hw - 8, 0, hd + 18, hw - 5, 26, hd + 21);
  b.pop();
  const cell = atlas.text('casino', def.sign || 'VICE CITY CASINO', { w: 768, h: 96, font: FONT.script, fg: '#ffd040', bg: null, glow: true });
  const v = atlas.stack('casino-v', 'CASINO', { w: 64, h: 300, fg: '#ff3fa4', bg: '#2a1f3a' });
  sign.push(); sign.translate(ob.cx, g, ob.cz).rotY(yaw);
  signQuad(sign, cell, -hw * 0.7, 8.6, hw * 0.7, 8.6 + hw * 0.18, hd + 14.4, { lit: 3, flicker: 0 });
  for (const s of [1, -1]) { sign.push(); sign.translate(hw - 6.5, 0, hd + 19.5).rotY(s * Math.PI / 2); signQuad(sign, v, -1.4, 6, 1.4, 6 + 2.8 * 5, 1.55, { lit: 2 }); sign.pop(); }
  sign.pop();
  ctx.view([ob.cx + Math.sin(yaw) * 90 + Math.cos(yaw) * 30, g + 20, ob.cz + Math.cos(yaw) * 90 - Math.sin(yaw) * 30], [ob.cx, g + 8, ob.cz], 'casino');
}

// ---------- water towers (one cluster for all of them) ----------
export function waterTowers(ctx, def) {
  const { b, lights, sign, atlas } = ctx;
  let n = 0;
  for (const t of def.towers) {
    const [x, z] = ctx.spot(t.x, t.z, 8, { maxR: 100, dryR: (t.r || 6.5) + 2 });
    ctx.remove({ circle: [x, z, 10] });
    ctx.hideTrees({ circle: [x, z, 9] });
    const g = ctx.groundY(x, z) - 0.4;
    const top = waterTower(b, lights, x, z, g, { h: t.h || 34, r: t.r || 6.5, color: t.color || 0xd8e4ea });
    if (t.name) {
      const cell = atlas.text(`wt-${t.name}`, t.name, { w: 384, h: 64, font: FONT.block, fg: t.fg || '#1d4f91', bg: null });
      const r = t.r || 6.5;
      for (let a = 0; a < 4; a++) {
        sign.push(); sign.translate(x, top - r * 0.95, z).rotY(a * Math.PI / 2);
        signQuad(sign, cell, -r * 0.62, 0, r * 0.62, r * 0.25, r * 1.01, { lit: 0 });
        sign.pop();
      }
    }
    if (n === 0) ctx.view([x + 45, g + 30, z + 35], [x, g + 26, z], t.name || 'water tower');
    n++;
  }
  return { towers: n };
}

// ---------- memorial obelisk on a stepped base ----------
export function obelisk(ctx, def) {
  const { b, lights } = ctx;
  const [x, z] = ctx.spot(def.x, def.z, 5, { maxR: 80, dryR: 8.5 });
  ctx.remove({ circle: [x, z, 8] });
  ctx.hideTrees({ circle: [x, z, 7] });
  const g = ctx.groundY(x, z) - 0.2;
  b.paint(0xe6e0d2, K.PLAIN);
  b.box(x - 6, g, z - 6, x + 6, g + 1, z + 6);
  b.box(x - 4.5, g + 1, z - 4.5, x + 4.5, g + 2, z + 4.5);
  b.box(x - 2.4, g + 2, z - 2.4, x + 2.4, g + 5, z + 2.4);
  b.cyl(x, z, g + 5, g + 26, 1.9, 1.1, 4, { phase: Math.PI / 4, top: false });
  b.cyl(x, z, g + 26, g + 28.4, 1.1, 0, 4, { phase: Math.PI / 4 });
  b.colBox(x - 6, g, z - 6, x + 6, g + 2, z + 6);
  b.colCyl(x, z, g, g + 28, 2.4);
  for (const [dx, dz] of [[5, 5], [-5, 5], [5, -5], [-5, -5]]) lights.add(x + dx, g + 1.4, z + dz, 0xfff0d0, 0.45, L.STEADY, 0, 1500);
  ctx.view([x + 24, g + 12, z + 20], [x, g + 14, z], 'obelisk');
}
