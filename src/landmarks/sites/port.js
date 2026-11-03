import { K, LOD, W, rng } from '../kit.js';
import { L } from '../lights.js';
import { scatterPark, mooredBoats } from './parking.js';
import { signQuad } from '../parts.js';
import { FONT } from '../atlas.js';

// Ports: ship-to-shore gantry cranes with booms over the water, container stacks on the paved yard with
// rubber-tyred gantries, cruise terminal signage and two docked cruise ships (fictional line, no real marks).

const BOX = [0xc8352b, 0x1f5fa8, 0x2f8f5a, 0xe0a020, 0x8a8f94, 0xd8d8d0, 0x6c3fa0, 0xe8682a, 0x14707a, 0x9c2a2a, 0x2a3a6a];

// direction from (x,z) towards the lowest ground (open water)
export function seaward(ctx, x, z, rs = [30, 60, 90]) {
  let best = 0, bestH = Infinity;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    let h = 0;
    for (const r of rs) h += ctx.groundY(x + Math.cos(a) * r, z + Math.sin(a) * r);
    if (h < bestH) { bestH = h; best = a; }
  }
  return [Math.cos(best), Math.sin(best)];
}

// ship-to-shore crane; local +z = seaward boom, x = along the quay rails
export function stsCrane(ctx, x, z, sx, sz, { col = 0xc8352b, alt = 0xf2f2f2, h = 44, out = 52, back = 24, gauge = 28, seed = 1 } = {}) {
  const { b, lights } = ctx;
  const g = ctx.groundY(x, z) - 0.3;
  const yaw = Math.atan2(sx, sz);
  b.push(); b.translate(x, g, z).rotY(yaw);
  const lx = 9;
  // legs (two portal frames along the rails) + sill beams
  b.paint(col, K.METAL);
  for (const zz of [0, -gauge]) {
    for (const xx of [-lx, lx]) b.beam(xx, 0, zz, xx, h, zz, 1.6, 1.6, 0b1111);
    b.beam(-lx, h - 3, zz, lx, h - 3, zz, 1.4, 2.2, 0b1111);
    b.beam(-lx, 12, zz, lx, 12, zz, 0.9, 1.2, 0b1111);
  }
  for (const xx of [-lx, lx]) {
    b.beam(xx, h - 1, 0, xx, h - 1, -gauge, 1.4, 2.0, 0b1111);
    b.beam(xx, 3, 0, xx, h - 6, -gauge, 0.6, 0.6, 0b1111);
  }
  b.paint(0x2a2d31, K.METAL);
  for (const zz of [0, -gauge]) for (const xx of [-lx, lx]) b.box(xx - 1.6, 0, zz - 2.4, xx + 1.6, 1.4, zz + 2.4);
  b.colBox(-lx - 0.8, 0, -0.8, -lx + 0.8, h, 0.8); b.colBox(lx - 0.8, 0, -0.8, lx + 0.8, h, 0.8);
  b.colBox(-lx - 0.8, 0, -gauge - 0.8, -lx + 0.8, h, -gauge + 0.8); b.colBox(lx - 0.8, 0, -gauge - 0.8, lx + 0.8, h, -gauge + 0.8);
  // boom (box girder) over the water + back reach with machinery house
  const by = h + 2;
  b.paint(alt, K.METAL);
  for (const xx of [-1.6, 1.6]) b.beam(xx, by, -gauge - back, xx, by, out, 1.0, 3.2, 0b1111);
  b.lod = LOD.NEAR;
  for (let zz = -gauge - back; zz < out; zz += 8) b.beam(-1.6, by - 1.4, zz, 1.6, by - 1.4, zz, 0.4, 0.4, 0b1111);
  b.lod = LOD.BOTH;
  b.paint(0xe9e9e4, K.WIN, W.INDUSTRIAL);
  b.box(-5, by + 1.6, -gauge - back + 1, 5, by + 7.5, -gauge - back + 13);
  // trolley + operator cab under the boom
  b.paint(0x30343a, K.METAL);
  b.box(-2.6, by - 2.6, 10, 2.6, by - 0.4, 16);
  b.paint(0x3c5566, K.GLASS, 1);
  b.box(-1.5, by - 5.2, 11.5, 1.5, by - 2.6, 14.5);
  // apex A-frame + forestays / backstays
  const ay = h + 30;
  b.paint(col, K.METAL);
  for (const xx of [-lx + 1, lx - 1]) {
    b.beam(xx, h, 0, 0, ay, -4, 1.2, 1.2, 0b1111);
    b.beam(xx, h, -gauge, 0, ay, -4, 1.2, 1.2, 0b1111);
  }
  b.paint(0x9aa0a6, K.METAL);
  b.beam(0, ay, -4, 0, by + 1.5, out - 2, 0.35, 0.35, 0b1111);
  b.beam(0, ay, -4, 0, by + 1.5, 20, 0.35, 0.35, 0b1111);
  b.beam(0, ay, -4, 0, by + 1.5, -gauge - back + 2, 0.35, 0.35, 0b1111);
  const tip = b.world(0, ay + 0.6, -4), boom = b.world(0, by + 2.2, out);
  b.pop();
  lights.obstacle(tip[0], tip[1], tip[2], 1.8);
  lights.obstacle(boom[0], boom[1], boom[2], 1.4);
  // deck floodlights under the boom (container handling area)
  const fl = (lz) => { const c = Math.cos(yaw), s = Math.sin(yaw); return [x + s * lz, g + h - 4, z + c * lz]; };
  for (const lz of [-gauge / 2, 6]) { const p = fl(lz); lights.add(p[0], p[1], p[2], 0xfff0d0, 2.4, L.STEADY, 0, 3500); }
  return { yaw };
}

// container stacks on a grid aligned with (ux,uz), around (cx,cz) within rx x rz, on paved ground clear of roads
export function containerYard(ctx, cx, cz, ux, uz, rx, rz, { seed = 3, maxH = 4, rtg = 4, density = 0.85 } = {}) {
  const { b, lights } = ctx;
  const R = rng(seed);
  const vx = -uz, vz = ux;
  const G = ctx.terrain.G;
  const cols = 6, cw = 2.5, len = 12.4;
  const bw = cols * cw;
  let blocks = 0;
  const rows = [];
  for (let i = -Math.floor(rx / (len + 4)); i <= Math.floor(rx / (len + 4)); i++) {
    for (let j = -Math.floor(rz / (bw + 7)); j <= Math.floor(rz / (bw + 7)); j++) {
      const px = cx + ux * i * (len + 4) + vx * j * (bw + 7), pz = cz + uz * i * (len + 4) + vz * j * (bw + 7);
      if (R() > density) continue;
      let ok = true;
      for (const [a, c] of [[0, 0], [len / 2, bw / 2], [-len / 2, bw / 2], [len / 2, -bw / 2], [-len / 2, -bw / 2]]) {
        const qx = px + ux * a + vx * c, qz = pz + uz * a + vz * c;
        if (!ctx.clearOfRoads(qx, qz, 3) || (G && ctx.terrain.groundAt(qx, qz) !== G.paved && ctx.terrain.groundAt(qx, qz) !== G.dirt) || ctx.groundY(qx, qz) < 0.3) { ok = false; break; }
      }
      if (!ok) continue;
      const g = ctx.groundY(px, pz) - 0.1;
      b.push(); b.translate(px, g, pz).rotY(Math.atan2(-uz, ux));
      b.lod = LOD.NEAR;
      let hsum = 0;
      for (let c = 0; c < cols; c++) {
        const hgt = 1 + Math.floor(R() * maxH);
        hsum += hgt;
        const z0 = -bw / 2 + c * cw;
        // one box per container (own colour, a dark seam between tiers, ends slightly staggered)
        for (let t = 0; t < hgt; t++) {
          const j = (R() - 0.5) * 0.25;
          b.paint(BOX[Math.floor(R() * BOX.length)], K.METAL);
          b.box(-len / 2 + 0.1 + j, t * 2.6, z0 + 0.08, len / 2 - 0.1 + j, t * 2.6 + 2.5, z0 + cw - 0.08);
          b.paint(0x2a2c30, K.PLAIN);
          b.box(-len / 2 + 0.3 + j, t * 2.6 + 2.5, z0 + 0.2, len / 2 - 0.3 + j, t * 2.6 + 2.6, z0 + cw - 0.2, 0b110011);
        }
      }
      b.lod = LOD.FAR;
      b.paint(BOX[Math.floor(R() * BOX.length)], K.METAL);
      b.box(-len / 2, 0, -bw / 2, len / 2, (hsum / cols) * 2.6, bw / 2);
      b.lod = LOD.BOTH;
      b.colBox(-len / 2, 0, -bw / 2, len / 2, 2.6 * 2, bw / 2);
      b.pop();
      rows.push([px, pz]);
      blocks++;
    }
  }
  // rubber-tyred gantries straddling some blocks
  for (let k = 0; k < Math.min(rtg, rows.length); k++) {
    const [px, pz] = rows[Math.floor(R() * rows.length)];
    const g = ctx.groundY(px, pz) - 0.1;
    b.push(); b.translate(px, g, pz).rotY(Math.atan2(-uz, ux));
    b.paint(0xf2c200, K.METAL);
    for (const s of [-1, 1]) {
      for (const xx of [-5, 5]) b.beam(xx, 0, s * (bw / 2 + 2), xx, 18, s * (bw / 2 + 2), 0.9, 0.9, 0b1111);
      b.beam(-5, 18, s * (bw / 2 + 2), 5, 18, s * (bw / 2 + 2), 0.9, 1.4, 0b1111);
    }
    b.beam(-4, 18.5, -bw / 2 - 2, -4, 18.5, bw / 2 + 2, 1.0, 1.2, 0b1111);
    b.beam(4, 18.5, -bw / 2 - 2, 4, 18.5, bw / 2 + 2, 1.0, 1.2, 0b1111);
    b.paint(0x30343a, K.PLAIN);
    for (const s of [-1, 1]) for (const xx of [-5, 5]) b.box(xx - 1, 0, s * (bw / 2 + 2) - 0.8, xx + 1, 1.3, s * (bw / 2 + 2) + 0.8);
    b.pop();
  }
  // yard light masts
  for (let k = 0; k < rows.length; k += 9) {
    const [px, pz] = rows[k];
    const qx = px + vx * (bw / 2 + 3.5), qz = pz + vz * (bw / 2 + 3.5);
    if (!ctx.clearOfRoads(qx, qz, 1.5)) continue;
    b.paint(0x9aa0a6, K.METAL);
    b.cyl(qx, qz, ctx.groundY(qx, qz), ctx.groundY(qx, qz) + 30, 0.4, 0.25, 6);
    lights.add(qx, ctx.groundY(qx, qz) + 30.4, qz, 0xffe9c4, 3, L.STEADY, 0, 4000);
  }
  return blocks;
}

export function cargoPort(ctx, def) {
  const cranes = def.cranes;
  let ax = 0, az = 0;
  const yawList = [];
  cranes.forEach(([x, z], i) => {
    ctx.remove({ circle: [x, z, 22] });
    ctx.hideTrees({ circle: [x, z, 20] });
    const [sx, sz] = seaward(ctx, x, z);
    ax += sx; az += sz;
    // step back onto the quay until all four legs (portal 18 x 28 m) stand on dry ground
    let qx = x, qz = z;
    const yawC = Math.atan2(sx, sz);
    for (let k = 0; k < 25 && !ctx.dryRect(qx - sx * 14, qz - sz * 14, yawC, 10.5, 15.5, 0.4); k++) { qx -= sx * 3; qz -= sz * 3; }
    const r = stsCrane(ctx, qx, qz, sx, sz, { col: def.col ?? 0xc8352b, alt: def.alt ?? 0xf2f2f2, seed: i });
    yawList.push(r.yaw);
  });
  const l = Math.hypot(ax, az) || 1;
  ax /= l; az /= l;
  // yard behind the cranes ('auto': centred landward of the crane line)
  if (def.yard === 'auto') {
    const mx = cranes.reduce((s, c) => s + c[0], 0) / cranes.length, mz = cranes.reduce((s, c) => s + c[1], 0) / cranes.length;
    const span = Math.max(...cranes.map(([x, z]) => Math.abs((x - mx) * -az + (z - mz) * ax)));
    containerYard(ctx, mx - ax * 80, mz - az * 80, -az, ax, span + 30, 32, { seed: def.seed || 3, rtg: def.rtg ?? 2 });
  } else if (def.yard) {
    const [yx, yz, rx, rz] = def.yard;
    const [ux, uz] = def.yardAxis || [-az, ax];
    containerYard(ctx, yx, yz, ux, uz, rx, rz, { seed: def.seed || 3, rtg: def.rtg ?? 4 });
  }
  // container trucks (catalog Behemoth tractor + landmark trailer with a 40 ft box) queued under the cranes
  // along the quay, a few waiting in the yard
  const R = rng((def.seed || 3) * 17);
  cranes.forEach(([x, z], i) => {
    const [sx, sz] = seaward(ctx, x, z);
    const yawQ = Math.atan2(sz, -sx); // along the quay
    for (const off of [-8, 8]) if (R() < 0.75) containerTruck(ctx, x - sx * 6 + sz * off, z - sz * 6 - sx * off, yawQ + (R() < 0.5 ? Math.PI : 0), R);
  });
  {
    const mx = cranes.reduce((s, c) => s + c[0], 0) / cranes.length, mz = cranes.reduce((s, c) => s + c[1], 0) / cranes.length;
    for (let i = 0; i < 6; i++) {
      const px = mx - ax * (40 + R() * 90) + -az * (R() - 0.5) * 160, pz = mz - az * (40 + R() * 90) + ax * (R() - 0.5) * 160;
      containerTruck(ctx, px, pz, Math.atan2(-az, ax) + (R() < 0.5 ? Math.PI : 0) + Math.PI / 2, R);
    }
  }
  const [cx, cz] = cranes[Math.floor(cranes.length / 2)];
  ctx.view([cx + ax * 150 - az * 90, 60, cz + az * 150 + ax * 90], [cx, 25, cz], 'cranes');
  ctx.view([cx - ax * 40 - az * 45, 9, cz - az * 40 + ax * 45], [cx - ax * 6, 3, cz - az * 6], 'quay trucks');
  ctx.view([cx - ax * 220, 110, cz - az * 220], [cx - ax * 60, 0, cz - az * 60], 'container yard');
}

// container truck: catalog tractor unit (Behemoth) + landmark skeletal trailer with a 40 ft container; only
// where the whole rig is free. Bake frame: forward -Z, the tractor's rear end at local z = cz + len / 2.
function containerTruck(ctx, x, z, yaw, R) {
  const m = ctx.vehicleModel('car:semi');
  if (!m) return false;
  const rear = m.cz + m.len / 2, fw = rear - 1.4, t0 = fw - 1.0, t1 = t0 + 12.8;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const zc = (m.cz - m.len / 2 + t1) / 2, hl = (t1 - (m.cz - m.len / 2)) / 2;
  if (!ctx.spotFree(x + s * zc, z + c * zc, yaw, 1.6, hl, { pad: 0.4 })) return false;
  if (!ctx.vehicle('car:semi', x, z, yaw, { color: [0xd8342c, 0x1f5fbf, 0xf4f4f2, 0x2f8f3a, 0x111111][Math.floor(R() * 5)] })) return false;
  const g = ctx.groundY(x + s * zc, z + c * zc);
  const { b } = ctx;
  b.push(); b.translate(x, g, z).rotY(yaw);
  b.lod = LOD.NEAR;
  // chassis rails, landing legs, three axles
  b.paint(0x26282c, K.METAL);
  b.box(-0.55, 1.05, t0, -0.35, 1.35, t1); b.box(0.35, 1.05, t0, 0.55, 1.35, t1);
  b.box(-1.25, 1.2, t0 + 0.2, 1.25, 1.35, t0 + 1.2); b.box(-1.25, 1.2, t1 - 1.0, 1.25, 1.35, t1);
  b.box(-0.9, 0, t0 + 3.2, -0.75, 1.1, t0 + 3.4); b.box(0.75, 0, t0 + 3.2, 0.9, 1.1, t0 + 3.4);
  b.paint(0x141516, K.PLAIN);
  for (const az of [t1 - 1.6, t1 - 2.9, t1 - 4.2]) for (const sx of [-1, 1]) {
    b.push(); b.translate(sx * 0.95, 0.52, az).rotZ(Math.PI / 2); b.cyl(0, 0, -0.32, 0.32, 0.52, 0.52, 8, { top: true, bottom: true }); b.pop();
  }
  b.lod = LOD.BOTH;
  // the container (also in the far silhouette)
  b.paint(BOX[Math.floor(R() * BOX.length)], K.METAL);
  b.box(-1.22, 1.38, t0 + 0.3, 1.22, 3.98, t1 - 0.2);
  b.colBox(-1.25, 0.2, t0, 1.25, 4.0, t1);
  b.pop();
  return true;
}

// ---------- cruise ship (fictional line) ----------
function cruiseShip(ctx, cx, cz, dx, dz, { len = 250, beam = 34, name = 'SEA CELESTE', funnel = 0x1f5fa8, seed = 1 } = {}) {
  const { b, sign, atlas, lights } = ctx;
  const R = rng(seed);
  const yaw = Math.atan2(-dz, dx); // local +x = bow direction
  const hl = len / 2, hb = beam / 2;
  b.push(); b.translate(cx, 0, cz).rotY(yaw);
  // hull: lofted cross-sections from stern (-x) to bow (+x)
  const sec = (x, k, deck = 14, keel = -8) => {
    const w = hb * k;
    return [[x, deck, -w], [x, deck * 0.5, -w * 1.0], [x, 0.5, -w * 0.98], [x, -4, -w * 0.82], [x, keel, -w * 0.35], [x, keel, w * 0.35], [x, -4, w * 0.82], [x, 0.5, w * 0.98], [x, deck * 0.5, w * 1.0], [x, deck, w]];
  };
  const stations = [[-hl, 0.92], [-hl + 12, 1], [hl - 70, 1], [hl - 35, 0.85], [hl - 15, 0.55], [hl - 4, 0.22], [hl, 0.04]];
  const rings = stations.map(([x, k]) => sec(x, k));
  b.orient = null;
  for (let s = 0; s < rings.length - 1; s++) {
    const A = rings[s], Bq = rings[s + 1];
    for (let i = 0; i < A.length - 1; i++) {
      const below = i >= 2 && i <= 6;
      b.paint(below ? 0x1b2b4a : 0xf6f7f8, K.PLAIN);
      b.orient = [(A[i][0] + Bq[i][0]) / 2, 3, 0];
      b.quad(A[i], Bq[i], Bq[i + 1], A[i + 1]);
    }
  }
  b.orient = null;
  // transom + main deck
  b.paint(0xf6f7f8, K.PLAIN);
  b.orient = [0, 3, 0];
  const T = rings[0];
  for (let i = 1; i < T.length - 1; i++) b.face([T[0], T[i], T[i + 1]], null);
  b.orient = null;
  b.cap(stations.map(([x, k]) => [x, -hb * k]).concat(stations.slice().reverse().map(([x, k]) => [x, hb * k])), 14);
  // waterline stripe (livery)
  b.paint(funnel, K.PLAIN);
  for (const s of [1, -1]) b.box(-hl + 3, 1.2, s * (hb + 0.02) - 0.2 * s, hl - 30, 2.4, s * (hb + 0.22), 0b000011);
  // superstructure: stepped decks with balcony cabins (lit cells at night)
  const decks = [[14, 30, -hl + 14, hl - 42, 0.96], [30, 42, -hl + 20, hl - 54, 0.9], [42, 50, -hl + 34, hl - 66, 0.82]];
  for (const [y0, y1, x0, x1, k] of decks) {
    b.paint(0xf9f9f9, K.WIN, W.HOTEL);
    b.box(x0, y0, -hb * k, x1, y1, hb * k);
    b.paint(0x24323c, K.NIGHTWIN);
    for (let y = y0 + 1.2; y < y1 - 1; y += 3.2) for (const s of [1, -1]) b.box(x0 + 2, y, s * hb * k - (s > 0 ? 0 : 0.05), x1 - 2, y + 1.5, s * (hb * k + 0.06), 0b000011);
  }
  // bridge with wrap-around glass
  b.paint(0xf9f9f9, K.PLAIN);
  b.box(hl - 60, 42, -hb * 0.98, hl - 48, 47, hb * 0.98);
  b.paint(0x1f2c38, K.GLASS, 1);
  b.box(hl - 48.2, 43.4, -hb * 0.96, hl - 47.8, 46.2, hb * 0.96, 0b100000);
  // lifeboats in davits along both sides
  b.lod = LOD.NEAR;
  b.paint(0xff7a1a, K.PLAIN);
  for (let x = -hl + 30; x < hl - 70; x += 11) for (const s of [1, -1]) b.box(x, 22, s * (hb + 0.4), x + 8.5, 25, s * (hb + 3.2));
  // pool deck + slides
  b.paint(0x2fb5d8, K.PAINT);
  b.box(-20, 50, -8, 10, 50.15, 8, 0b001000);
  b.paint(0xf2c200, K.PLAIN);
  for (let k = 0; k < 6; k++) { const a0 = k * 0.9, a1 = (k + 1) * 0.9; b.beam(-hl + 46 + Math.cos(a0) * 6, 58 - k * 1.3, Math.sin(a0) * 6, -hl + 46 + Math.cos(a1) * 6, 58 - (k + 1) * 1.3, Math.sin(a1) * 6, 1.4, 1.4, 0b1111); }
  b.lod = LOD.BOTH;
  // funnel
  b.paint(0xf6f7f8, K.PLAIN);
  b.box(-hl + 40, 50, -5, -hl + 56, 64, 5);
  b.paint(funnel, K.PLAIN);
  b.box(-hl + 40.5, 60, -5.05, -hl + 55.5, 64.4, 5.05);
  b.colBox(-hl, -8, -hb, hl - 10, 50, hb);
  const mastTop = b.world(hl - 54, 58, 0);
  b.paint(0xd8d8d8, K.METAL);
  b.beam(hl - 54, 47, 0, hl - 54, 57.5, 0, 0.5, 0.5, 0b1111);
  b.pop();
  lights.obstacle(mastTop[0], mastTop[1], mastTop[2], 1.4);
  // deck lights along the top decks
  for (let i = 0; i < 10; i++) {
    const t = -hl + 20 + (i / 9) * (len - 80);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const side of [1, -1]) lights.add(cx + c * t + s * side * hb * 0.8, 50.6, cz - s * t + c * side * hb * 0.8, 0xffe6b0, 1.1, L.STEADY, 0, 3000);
  }
  // hull name near the bow (both sides)
  const cell = atlas.text(`ship-${name}`, name, { w: 768, h: 96, font: FONT.deco, fg: '#1b2b4a', bg: null });
  sign.push(); sign.translate(cx, 0, cz).rotY(yaw);
  sign.push(); sign.translate(hl - 50, 0, 0).rotY(-Math.PI / 2);
  signQuad(sign, cell, -12, 8, 12, 11, hb * 0.86 + 0.15, { lit: 3 });
  sign.pop();
  sign.push(); sign.translate(hl - 50, 0, 0).rotY(Math.PI / 2);
  signQuad(sign, cell, -12, 8, 12, 11, hb * 0.86 + 0.15, { lit: 3 });
  sign.pop();
  sign.pop();
}

export function cruisePort(ctx, def) {
  const [ax, az] = def.quayA, [bx, bz] = def.quayB;
  const L0 = Math.hypot(bx - ax, bz - az);
  const dx = (bx - ax) / L0, dz = (bz - az) / L0;
  let nx = -dz, nz = dx; // pick the normal pointing to deeper water
  if (ctx.groundY((ax + bx) / 2 + nx * 80, (az + bz) / 2 + nz * 80) > ctx.groundY((ax + bx) / 2 - nx * 80, (az + bz) / 2 - nz * 80)) { nx = -nx; nz = -nz; }
  const ships = def.ships || [];
  let placed = 0;
  ships.forEach((s, i) => {
    const t = s.t;
    const px = ax + dx * L0 * t, pz = az + dz * L0 * t;
    const hl = (s.len || 250) / 2, hb = 17;
    for (let d = 20; d < 160; d += 4) {
      const cx = px + nx * d, cz = pz + nz * d;
      let ok = true;
      for (const [a, c] of [[0, 0], [hl, 0], [-hl, 0], [hl * 0.8, hb], [-hl * 0.9, hb], [hl * 0.8, -hb], [-hl * 0.9, -hb]]) {
        if (ctx.groundY(cx + dx * a + nx * c, cz + dz * a + nz * c) > -1.2) { ok = false; break; }
      }
      if (!ok) continue;
      cruiseShip(ctx, cx, cz, s.reverse ? -dx : dx, s.reverse ? -dz : dz, { len: s.len || 250, name: s.name, funnel: s.funnel, seed: i + 1 });
      placed++;
      if (placed === 1) ctx.view([cx + nx * 160 + dx * 120, 45, cz + nz * 160 + dz * 120], [cx, 25, cz], 'cruise ship');
      break;
    }
  });
  // terminal signage on the largest terminal building near the quay centre
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const f = ctx.footprints(mx, mz, 120, 500)[0];
  if (f) {
    const cell = ctx.atlas.text('cruise-term', def.sign || 'PORT VICE CITY · CRUISE TERMINAL', { w: 768, h: 72, font: FONT.block, fg: '#ffffff', bg: '#0f5f8f' });
    ctx.sign.push(); ctx.sign.translate(f.rec.cx, f.rec.top + 0.2, f.rec.cz).rotY(Math.atan2(nx, nz));
    signQuad(ctx.sign, cell, -16, 0, 16, 3, 0, { lit: 1 });
    ctx.sign.pop();
  }
  // coaches and taxis waiting landside of the terminal, launches moored off the quay
  scatterPark(ctx, mx - nx * 45, mz - nz * 45, { r: 90, n: 9, keys: ['car:city_bus', 'car:taxi', 'car:taxi'], seed: 7 });
  mooredBoats(ctx, { x: ax + nx * 24 + dx * 30, z: az + nz * 24 + dz * 30, ux: dx, uz: dz, vx: dx, vz: dz, n: 5, gap: 16, keys: ['boat:boat_cruiser', 'boat:boat_speed'], seed: 5 });
  ctx.view([mx - nx * 60 - dx * 260, 70, mz - nz * 60 - dz * 260], [mx + nx * 60, 20, mz + nz * 60], 'cruise port');
  ctx.view([mx - nx * 110 + dx * 40, 18, mz - nz * 110 + dz * 40], [mx - nx * 45, 2, mz - nz * 45], 'coaches');
  return { ships: placed };
}
