import { K, LOD, W, superellipse, rng } from '../kit.js';
import { L } from '../lights.js';
import { signQuad, mast } from '../parts.js';
import { FONT } from '../atlas.js';
import { mooredBoats } from './parking.js';

// Sports venues: indoor arena (oval drum, LED crown band), ballpark (seating bowl, diamond, parked retractable
// roof panels, light banks, LED scoreboard), tennis bowl, small football stadium, marine grandstand.
// Seating uses K.METAL ribs (row stripes); floodlights are emissive heads + light points.

const SEAT = [0x2f6f9f, 0x2f8f7f, 0xc0303a, 0x3a3f8f];

// ring of a superellipse scaled by s at height y (local)
function ringAt(a, bb, e, n, s, y, dx = 0, dz = 0) { return superellipse(a * s, bb * s, n, e).map(([x, z]) => [x + dx, y, z + dz]); }

// sloped seating tier between scale s0 (inner, low) and s1 (outer, high); `arc` limits it to a fraction of the
// ring centred on angle `ang` (radians, 0 = +x); rings are written inward-facing (visible from the field)
function tier(b, a, bb, e, n, s0, y0, s1, y1, color, { arc = 1, ang = 0, steps = 3 } = {}) {
  const full = superellipse(1, 1, n, e);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const t = Math.atan2(full[i][1], full[i][0]);
    let d = Math.abs(((t - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d <= arc * Math.PI + 1e-6) idx.push(i);
  }
  const closed = idx.length === n;
  b.paint(color, K.METAL);
  for (let k = 0; k < steps; k++) {
    const sa = s0 + (s1 - s0) * k / steps, sb = s0 + (s1 - s0) * (k + 1) / steps;
    const ya = y0 + (y1 - y0) * k / steps, yb = y0 + (y1 - y0) * (k + 1) / steps;
    for (let j = 0; j < (closed ? idx.length : idx.length - 1); j++) {
      const i0 = idx[j], i1 = idx[(j + 1) % idx.length];
      const p = (i, s, y) => [full[i][0] * a * s, y, full[i][1] * bb * s];
      // tread (horizontal) + riser (vertical), both facing the centre / up
      b.quad(p(i0, sa, ya), p(i1, sa, ya), p(i1, sa, yb), p(i0, sa, yb));
      b.quad(p(i0, sa, yb), p(i1, sa, yb), p(i1, sb, yb), p(i0, sb, yb));
    }
  }
}

// ---------- indoor arena ----------
export function arena(ctx, def) {
  const { b, sign, atlas, lights } = ctx;
  const { x, z } = def;
  for (const [fx, fz] of def.footprints || []) for (const f of ctx.footprints(fx, fz, 8, 1000)) ctx.remove({ ids: [f.id] });
  ctx.hideTrees({ circle: [x, z, 85] });
  const g = ctx.groundY(x, z) - 0.6;
  const A = def.a || 76, B = def.b || 58, e = 4, n = 48;
  b.push(); b.translate(x, g, z).rotY(def.yaw || 0);
  // glass lobby podium + entrance canopies
  b.paint(0x7aa3bd, K.GLASS, 1);
  b.prism(superellipse(A, B, n, e), 0, 9, { top: false });
  b.paint(0xe8e8e6, K.PLAIN);
  b.prism(superellipse(A + 3, B + 3, n, e), 9, 10.2, { topPaint: [0xd0d2d4, K.ROOF] });
  // drum with vertical fins
  b.paint(0xd9dcdf, K.METAL);
  b.prism(superellipse(A - 6, B - 6, n, e), 10.2, 25.5, { top: false });
  b.lod = LOD.NEAR;
  b.paint(0xf4f4f4, K.PLAIN);
  const ring = superellipse(A - 5.4, B - 5.4, n, e);
  for (let i = 0; i < n; i += 2) {
    const [px, pz] = ring[i];
    const l = Math.hypot(px / (A * A), pz / (B * B)) || 1;
    const nx = px / (A * A) / l, nz = pz / (B * B) / l;
    b.beam(px, 10.2, pz, px + nx * 0.6, 25.5, pz + nz * 0.6, 0.9, 0.5, 0b1111);
  }
  b.lod = LOD.BOTH;
  // Broad white shell and shallow roof; keep the daytime silhouette architectural.
  b.paint(0xf0eeea, K.PLAIN);
  b.prism(superellipse(A - 4.5, B - 4.5, n, e), 25.5, 30, { top: false });
  b.paint(0xeceeef, K.METAL);
  const prof = [[1, 30], [0.92, 32.5], [0.75, 34.2], [0.5, 35.3], [0.25, 35.8], [0.001, 36]];
  const rings = prof.map(([s, y]) => ringAt(A - 4.5, B - 4.5, e, n, s, y));
  b.orient = [0, 12, 0];
  for (let k = 0; k < rings.length - 1; k++) {
    const R0 = rings[k], R1 = rings[k + 1];
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.quad(R0[j], R1[j], R1[i], R0[i]); }
  }
  b.orient = null;
  b.colPrism(superellipse(A, B, 16, e), 0, 36);
  // Recessed, glazed waterside entrance beneath a large white cantilever.
  b.paint(0x415a64, K.GLASS, 1);
  b.box(A - 3, 4, -30, A + 2, 22, 30);
  b.paint(0xf4f1e9, K.PLAIN);
  b.box(A - 5, 22, -34, A + 12, 30, 34);
  for (const z0 of [-33, 29]) b.box(A - 3, 0, z0, A + 7, 22, z0 + 4);
  // entrance canopies on the long sides
  for (const s of [1, -1]) {
    b.paint(0xf2f2f2, K.PLAIN);
    b.box(-22, 8.5, s * (B - 1), 22, 9.4, s * (B + 9));
    b.lod = LOD.NEAR;
    b.paint(0x9aa0a6, K.METAL);
    for (const cx of [-20, -7, 7, 20]) b.cyl(cx, s * (B + 8), 0, 8.5, 0.35, 0.35, 6);
    b.lod = LOD.BOTH;
  }
  // roof edge lights
  for (let i = 0; i < 12; i++) {
    const [px, pz] = ring[Math.floor((i / 12) * n)];
    const p = b.world(px * 0.98, 30.4, pz * 0.98);
    lights.add(p[0], p[1], p[2], 0xfff2e0, 1.2, L.STEADY, 0, 2500);
  }
  b.pop();
  const cell = atlas.text(`arena-${def.id}`, def.sign || 'BAYSIDE ARENA', { w: 768, h: 88, font: FONT.block, fg: '#ffffff', bg: null, glow: true });
  for (const s of [1, -1]) {
    sign.push();
    sign.translate(x, g, z).rotY((def.yaw || 0) + (s > 0 ? 0 : Math.PI));
    signQuad(sign, cell, -24, 15.5, 24, 20.8, B - 5.6, { lit: 3 });
    sign.pop();
  }
  ctx.view([x + A * 1.6, g + 45, z + B * 2.2], [x, g + 18, z], 'arena');
  ctx.view([x - A * 2.4, g + 60, z - B * 1.2], [x, g + 20, z], 'arena far');
}

// ---------- ballpark with parked retractable roof ----------
export function ballpark(ctx, def) {
  const { b, sign, atlas, lights } = ctx;
  const { x, z } = def;
  ctx.remove({ poly: def.clear });
  ctx.hideTrees({ poly: def.clear });
  const g = ctx.groundY(x, z) - 0.5;
  const A = def.a || 86, B = def.b || 80, e = 2.4, n = 44;
  const yaw = def.yaw || 0; // home plate towards local -z
  b.push(); b.translate(x, g, z).rotY(yaw);
  // outer facade: white panels with glass concourse bands
  b.paint(0xeef0ee, K.WIN, W.OFFICE);
  b.prism(superellipse(A, B, n, e), 0, 33, { top: false });
  b.paint(0x0f5f8f, K.PLAIN);
  b.prism(superellipse(A + 0.4, B + 0.4, n, e), 31, 33.6, { top: false });
  b.colPrism(superellipse(A, B, 16, e), 0, 33);
  // field
  b.paint(0x4f9a3a, K.GRASS);
  b.cap(superellipse(A - 2, B - 2, n, e), 0.9);
  b.lod = LOD.NEAR;
  b.paint(0xb0764a, K.PAINT);
  // infield diamond (rotated square) towards home plate at -z
  const hp = [0, -B * 0.55];
  const dia = [[hp[0], hp[1]], [hp[0] + 19, hp[1] + 19], [hp[0], hp[1] + 38], [hp[0] - 19, hp[1] + 19]];
  b.cap(dia.map(([px, pz]) => [px * 1.25, pz + (pz - hp[1]) * 0.25]), 0.95);
  b.paint(0x5aa846, K.GRASS);
  b.cap(dia.map(([px, pz]) => [px * 0.78, hp[1] + (pz - hp[1]) * 0.78 + 3]), 1.0);
  b.paint(0xffffff, K.PLAIN);
  for (const [px, pz] of dia.slice(1)) b.box(px - 0.5, 0.95, pz - 0.5, px + 0.5, 1.15, pz + 0.5);
  b.lod = LOD.BOTH;
  // seating bowl: three tiers around home plate (arc ~ 270 deg facing the outfield opening at +z)
  tier(b, A - 3, B - 3, e, n, 0.78, 1.5, 0.95, 12, SEAT[0], { arc: 0.78, ang: -Math.PI / 2, steps: 4 });
  b.paint(0xd6d8d8, K.PLAIN);
  b.prism(superellipse((A - 3) * 0.95, (B - 3) * 0.95, n, e), 12, 13.4, { top: false });
  tier(b, A - 3, B - 3, e, n, 0.86, 14, 0.99, 26, SEAT[0], { arc: 0.7, ang: -Math.PI / 2, steps: 3 });
  // outfield bleachers (low)
  tier(b, A - 3, B - 3, e, n, 0.9, 1.5, 0.97, 7, SEAT[1], { arc: 0.28, ang: Math.PI / 2, steps: 2 });
  // LED scoreboard in the outfield
  b.paint(0x111418, K.PLAIN);
  b.box(-22, 14, B - 12, 22, 27, B - 9);
  b.paint(0x48a0ff, K.LED, 1);
  b.box(-20.5, 15.2, B - 12.05, 20.5, 25.8, B - 11.9, 0b000001);
  // retractable roof: three arched panels parked over the east side on rails
  const panels = [[0.5, 64], [0.3, 60], [0.12, 56]];
  panels.forEach(([off, h], i) => {
    const cx = A * off + 10 + i * 4;
    b.paint(i % 2 ? 0xe2e5e7 : 0xd5d9dc, K.METAL);
    b.vault(cx - 14, cx + 14, -B * 0.95, B * 0.95, h - 8, 8, 6, { ends: true, walls: 2 });
    b.paint(0x8f979e, K.METAL);
    b.box(cx - 14, h - 10.5, -B * 0.95, cx + 14, h - 10, B * 0.95, 0b001100);
  });
  // rail trusses (A-frames) at both ends of the parked panels, standing outside the bowl
  b.paint(0xb6bcc1, K.METAL);
  for (const s of [-1, 1]) {
    const zz = s * (B + 4);
    for (const xx of [8, 44, 78]) b.beam(xx, 0, zz, xx * 0.92 + 6, 53, zz * 0.97, 1.6, 1.6, 0b1111);
    b.beam(4, 53, zz * 0.97, A * 0.9 + 4, 53, zz * 0.97, 1.8, 1.4, 0b1111);
  }
  // light banks on the upper rim
  for (const t of [-0.9, -0.55, -0.2, 0.2, 0.55, 0.9]) {
    const ang = -Math.PI / 2 + t * 2.2;
    const px = Math.cos(ang) * (A - 4), pz = Math.sin(ang) * (B - 4);
    b.paint(0x6c7177, K.METAL);
    b.beam(px, 26, pz, px, 40, pz, 0.6, 0.6, 0b1111);
    b.paint(0xfff4dc, K.EMIT, 1);
    b.push(); b.translate(px, 40, pz).rotY(-ang + Math.PI / 2);
    b.box(-3, 0, -0.4, 3, 2.6, 0.4);
    b.pop();
    const p = b.world(px * 0.98, 41.3, pz * 0.98);
    lights.add(p[0], p[1], p[2], 0xfff4dc, 4, L.STEADY, 0, 5000);
  }
  b.pop();
  const cell = atlas.text(`ballpark-${def.id}`, def.sign || 'VICE CITY BALLPARK', { w: 768, h: 88, font: FONT.block, fg: '#0f5f8f', bg: null });
  sign.push(); sign.translate(x, g, z).rotY(yaw + Math.PI);
  signQuad(sign, cell, -30, 24, 30, 30.5, B + 0.4, { lit: 3 });
  sign.pop();
  ctx.view([x - A * 0.2 + Math.sin(yaw) * B * 2.4, g + 90, z + Math.cos(yaw) * B * 2.4], [x, g + 10, z], 'ballpark');
  ctx.view([x + A * 1.8, g + 30, z - B * 1.6], [x, g + 22, z], 'ballpark outside');
}

// ---------- tennis / small bowls ----------
export function bowlStadium(ctx, def) {
  const { b, sign, atlas, lights } = ctx;
  const [x, z] = def.spot ? ctx.spot(def.x, def.z, def.a * 0.6, { maxR: 160, dryR: Math.max(def.a, def.b ?? def.a) + 4 }) : [def.x, def.z];
  ctx.remove({ circle: [x, z, def.a * 1.1] });
  ctx.hideTrees({ circle: [x, z, def.a * 1.2] });
  const g = ctx.groundY(x, z) - 0.5;
  const A = def.a, B = def.b ?? def.a, e = def.e ?? 3.2, n = 36, H = def.h ?? 18;
  b.push(); b.translate(x, g, z).rotY(def.yaw || 0);
  b.paint(def.wall ?? 0xe9e5dc, K.WIN, W.GRID);
  b.prism(superellipse(A, B, n, e), 0, H, { top: false });
  b.paint(0xd1ccc2, K.PLAIN);
  b.prism(superellipse(A + 0.6, B + 0.6, n, e), H, H + 1.2, { top: false });
  b.colPrism(superellipse(A, B, 16, e), 0, H);
  b.paint(def.court ?? 0x2f6aa8, K.PAINT);
  b.cap(superellipse(A * 0.6, B * 0.6, n, e), 0.8);
  // court / pitch along the bowl's long axis; the grass inlay is the rectangle inside the lines (it used to be a
  // 4-point superellipse, i.e. a green diamond lying across the tennis court lines)
  const cw = Math.min(A, B) * 0.22, cl = Math.min(A, B) * 0.42;
  const alongX = A > B * 1.05, hx = alongX ? cl : cw, hz = alongX ? cw : cl;
  b.paint(0x5a9a50, K.GRASS);
  b.prism([[-hx - 1, -hz - 1], [hx + 1, -hz - 1], [hx + 1, hz + 1], [-hx - 1, hz + 1]], 0.8, 0.85, {});
  tier(b, A - 1, B - 1, e, n, 0.62, 1, 0.98, H - 1, def.seats ?? SEAT[3], { steps: 5 });
  // white court lines
  b.lod = LOD.NEAR;
  b.paint(0xffffff, K.PLAIN);
  const mid = alongX ? [0, -hz, 0, hz] : [-hx, 0, hx, 0];
  for (const [x0, z0, x1, z1] of [[-hx, -hz, hx, -hz], [-hx, hz, hx, hz], [-hx, -hz, -hx, hz], [hx, -hz, hx, hz], mid]) b.beam(x0, 0.9, z0, x1, 0.9, z1, 0.25, 0.04, 0b1111);
  b.lod = LOD.BOTH;
  // light masts (football) or roof-edge lights (tennis)
  if (def.masts) {
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) mast(b, lights, sx * (A + 6), sz * (B + 6), 0, H + 20, { heads: 4, color: 0xfff6e0, size: 3.6, yaw: Math.atan2(sz, -sx) });
  } else {
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const p = b.world(Math.cos(a) * A * 0.98, H + 1.5, Math.sin(a) * B * 0.98); lights.add(p[0], p[1], p[2], 0xfff4dc, 1.1, L.STEADY, 0, 3000); }
  }
  b.pop();
  if (def.sign) {
    const cell = atlas.text(`bowl-${def.id}`, def.sign, { w: 768, h: 96, font: FONT.block, fg: '#ffffff', bg: '#1f3b5a' });
    sign.push(); sign.translate(x, g, z).rotY(def.yaw || 0);
    signQuad(sign, cell, -A * 0.45, H - 5, A * 0.45, H - 5 + A * 0.11, B + 0.3, { lit: 1 });
    sign.pop();
  }
  ctx.view([x + A * 1.8, g + H * 2.4, z + B * 1.9], [x, g + 6, z], def.kind);
}

// ---------- marine stadium: cantilevered folded-plate roof over a grandstand facing the water ----------
export function marineStadium(ctx, def) {
  const { b, lights } = ctx;
  // the grandstand (100 x 34 m) must stand on land; the roof may cantilever over the water
  let x = def.x, z = def.z;
  const yw = def.yaw || 0, bx = -Math.sin(yw), bz = -Math.cos(yw); // towards the water (local -z)
  for (let k = 0; k < 30 && !ctx.dryRect(x, z, yw, 52, 18, 0.3); k++) { x -= bx * 4; z -= bz * 4; }
  ctx.remove({ circle: [x, z, 60] });
  ctx.hideTrees({ circle: [x, z, 60] });
  const g = ctx.groundY(x, z) - 0.4;
  const yaw = def.yaw || 0; // grandstand faces local -z (the water)
  b.push(); b.translate(x, g, z).rotY(yaw);
  const Wd = 100, D = 34;
  // raked seating (concrete, faded paint)
  b.paint(0xd9d4c8, K.METAL);
  for (let k = 0; k < 12; k++) {
    const z0 = -D / 2 + k * (D - 6) / 12, y = 1 + k * 1.15;
    b.box(-Wd / 2, 0, z0, Wd / 2, y, z0 + (D - 6) / 12 + 0.01, 0b001011);
  }
  b.paint(0xc8c2b4, K.PLAIN);
  b.box(-Wd / 2 - 1, 0, -D / 2, -Wd / 2, 15, D / 2);
  b.box(Wd / 2, 0, -D / 2, Wd / 2 + 1, 15, D / 2);
  b.box(-Wd / 2, 0, D / 2 - 6, Wd / 2, 15, D / 2);
  b.colBox(-Wd / 2, 0, -D / 2, Wd / 2, 15, D / 2);
  // folded plate roof: alternating ridges/valleys cantilevered towards the water, few slender columns
  b.paint(0xf1efe8, K.PLAIN);
  const folds = 8, fw = Wd / folds;
  for (let i = 0; i < folds; i++) {
    const x0 = -Wd / 2 + i * fw, xm = x0 + fw / 2, x1 = x0 + fw;
    const back = D / 2 - 2, front = -D / 2 - 10;
    const yr = 24, yv = 20.5, yf = 21.5;
    b.quad([x0, yv, back], [xm, yr, back], [xm, yr + 1.2, front], [x0, yf - 1.5, front]);
    b.quad([xm, yr, back], [x1, yv, back], [x1, yf - 1.5, front], [xm, yr + 1.2, front]);
    b.quad([x0, yf - 1.5, front], [xm, yr + 1.2, front], [xm, yr, back], [x0, yv, back]);
    b.quad([xm, yr + 1.2, front], [x1, yf - 1.5, front], [x1, yv, back], [xm, yr, back]);
  }
  b.paint(0xe6e2d8, K.PLAIN);
  for (let i = 1; i < folds; i += 2) b.box(-Wd / 2 + i * fw - 0.6, 0, D / 2 - 4, -Wd / 2 + i * fw + 0.6, 21, D / 2 - 2.8);
  b.pop();
  // race boats lined up on the basin facing the grandstand, a yacht and jet skis among them (src/boat models)
  {
    const ax = Math.cos(yaw), az = -Math.sin(yaw); // along the stand
    // first open water in front of the stand (at least 1.2 m deep), then two rows of moorings
    let shore = D / 2;
    while (shore < 260 && ctx.groundY(x + bx * shore, z + bz * shore) > -1.2) shore += 5;
    for (const [off, n, keys, seed] of [[12, 7, ['boat:boat_speed', 'boat:boat_speed', 'boat:boat_jetski'], 3], [36, 4, ['boat:boat_cruiser', 'boat:boat_speed'], 9]]) {
      const ox = x + bx * (shore + off) - ax * 36, oz = z + bz * (shore + off) - az * 36;
      mooredBoats(ctx, { x: ox, z: oz, ux: ax, uz: az, vx: -bx, vz: -bz, n, gap: 72 / n, keys, seed });
    }
    ctx.frameView(null, 'boats', { only: /^boat:/, from: [-bx + ax * 0.5, -bz + az * 0.5], k: 1.3, elev: 0.45 });
  }
  ctx.view([x + Math.sin(yaw) * -90 + Math.cos(yaw) * 40, g + 26, z + Math.cos(yaw) * -90 - Math.sin(yaw) * 40], [x, g + 12, z], 'marine stadium');
}
