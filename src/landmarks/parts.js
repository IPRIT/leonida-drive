import { K, LOD } from './kit.js';
import { L } from './lights.js';

// Reusable low-poly parts shared by the site generators. All take a Builder already positioned in the site's
// local frame unless noted; world-space helpers say so.

// textured sign quad at local z facing +z (or -z with facing = -1). lit: 0 painted, 1 back-lit, 2 neon letters
export function signQuad(sb, cell, x0, y0, x1, y1, z, { lit = 1, facing = 1, flicker = 0 } = {}) {
  sb.paint(0xffffff, lit, flicker);
  const t = [[cell.u0, cell.v0], [cell.u1, cell.v0], [cell.u1, cell.v1], [cell.u0, cell.v1]];
  if (facing > 0) sb.face([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], null, t);
  else sb.face([[x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z]], null, [t[0], t[1], t[2], t[3]]);
}

// sign board (box) with the texture on the front (+z) and optionally the back, sides in `frame` colour
export function signBoard(sb, cell, x0, y0, x1, y1, z0, z1, { lit = 1, back = false, frame = 0x2a2c30, white } = {}) {
  sb.paint(frame, 0);
  const W = white || cell;
  const tw = [[W.u0, W.v0], [W.u1, W.v0], [W.u1, W.v1], [W.u0, W.v1]];
  // sides + top in frame colour (white atlas cell so the vertex colour shows)
  sb.face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], null, tw);
  sb.face([[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], null, tw);
  sb.face([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], null, tw);
  if (!back) sb.face([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], null, tw);
  signQuad(sb, cell, x0, y0, x1, y1, z1, { lit });
  if (back) signQuad(sb, cell, x0, y0, x1, y1, z0, { lit, facing: -1 });
}

// light mast (apron / stadium / car park): pole + head; glow points at the head (world coords from the builder)
export function mast(b, lights, x, z, y0, h, { heads = 2, color = 0xfff2d6, size = 2.4, yaw = 0, pole = 0x9a9ea3, kind = L.STEADY } = {}) {
  b.push();
  b.paint(pole, K.METAL);
  b.cyl(x, z, y0, y0 + h, 0.32, 0.18, 6);
  b.translate(x, y0 + h, z).rotY(yaw);
  b.paint(0x4a4d52, K.PLAIN);
  b.box(-heads * 0.7, -0.2, -0.35, heads * 0.7, 0.35, 0.35);
  b.paint(color, K.EMIT, 1);
  b.box(-heads * 0.7 + 0.1, -0.32, -0.3, heads * 0.7 - 0.1, -0.2, 0.3);
  for (let i = 0; i < heads; i++) {
    const p = b.world(-heads * 0.7 + 0.7 + i * 1.4 - 0.35 * 0, -0.4, 0);
    lights.add(p[0], p[1], p[2], color, size, kind, 0, 5000);
  }
  b.pop();
}

// windsock: pole + striped orange/white cone pointing along local +x after rotY(yaw)
export function windsock(b, lights, x, z, y0, yaw = 0) {
  b.push();
  b.paint(0xdedede, K.METAL);
  b.cyl(x, z, y0, y0 + 6.5, 0.12, 0.08, 5);
  b.translate(x, y0 + 6.2, z).rotY(yaw).rotZ(-0.18);
  for (let i = 0; i < 5; i++) {
    b.paint(i % 2 ? 0xffffff : 0xff6a10, K.PLAIN);
    const r0 = 0.45 - i * 0.05, r1 = 0.45 - (i + 1) * 0.05;
    b.push(); b.rotZ(-Math.PI / 2);
    b.cyl(0, 0, i * 0.7, (i + 1) * 0.7, r0, r1, 6, { top: false });
    b.pop();
  }
  b.pop();
  const p = b.world(x, y0 + 6.7, z);
  lights.add(p[0], p[1], p[2], 0xff3020, 0.8, L.STEADY, 0, 2500);
}

// lattice mast / antenna with obstacle lights (world-space lights through the builder transform)
export function antenna(b, lights, x, z, y0, h, { w = 1.6, color = 0xc83a2a, alt = 0xeeeeee } = {}) {
  const segs = Math.max(2, Math.round(h / 12));
  for (let i = 0; i < segs; i++) {
    const ya = y0 + (i / segs) * h, yb = y0 + ((i + 1) / segs) * h;
    const wa = w * (1 - 0.5 * i / segs), wb = w * (1 - 0.5 * (i + 1) / segs);
    b.paint(i % 2 ? alt : color, K.METAL);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.beam(x + sx * wa / 2, ya, z + sz * wa / 2, x + sx * wb / 2, yb, z + sz * wb / 2, 0.14, 0.14, 0b1111);
    b.beam(x - wa / 2, ya, z - wa / 2, x + wb / 2, yb, z + wb / 2, 0.08, 0.08, 0b1111);
  }
  for (const f of [0.5, 1]) {
    const p = b.world(x, y0 + h * f + 0.3, z);
    lights.obstacle(p[0], p[1], p[2], f === 1 ? 1.8 : 1.3);
  }
}

// chain-link fence along a world-space polyline (identity transform), posts every `step` m,
// height h, optional gaps [[x,z,r]] (gates / road crossings). Adds thin box colliders per run.
export function fenceLine(b, path, yAt, { h = 2.6, step = 4, gaps = [], colliders = true, barbed = true } = {}) {
  const blocked = (x, z) => gaps.some(([gx, gz, gr]) => Math.hypot(x - gx, z - gz) < gr);
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    const L0 = Math.hypot(bx - ax, bz - az);
    if (L0 < 0.5) continue;
    const n = Math.max(1, Math.round(L0 / step));
    let run = null;
    const flush = (endT) => {
      if (!run) return;
      const x0 = ax + (bx - ax) * run, z0 = az + (bz - az) * run, x1 = ax + (bx - ax) * endT, z1 = az + (bz - az) * endT;
      if (colliders && b.colliders) {
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, len = Math.hypot(x1 - x0, z1 - z0);
        const y = yAt(cx, cz);
        b.colliders.box(cx, y + h / 2, cz, len / 2, h / 2, 0.15, Math.atan2(-(z1 - z0), x1 - x0), b.colTag);
      }
      run = null;
    };
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      if (blocked((x0 + x1) / 2, (z0 + z1) / 2)) { flush(t0); continue; }
      if (run === null) run = t0;
      const y0 = yAt(x0, z0), y1 = yAt(x1, z1);
      const seg = Math.hypot(x1 - x0, z1 - z0), u0 = (i * 1000 + k * seg) % 997;
      b.lod = LOD.NEAR;
      b.paint(0x8c9196, K.FENCE);
      // mesh both ways (double-sided)
      b.face([[x0, y0, z0], [x0, y0 + h, z0], [x1, y1 + h, z1], [x1, y1, z1]], [[u0, 0], [u0, h], [u0 + seg, h], [u0 + seg, 0]]);
      b.face([[x1, y1, z1], [x1, y1 + h, z1], [x0, y0 + h, z0], [x0, y0, z0]], [[u0 + seg, 0], [u0 + seg, h], [u0, h], [u0, 0]]);
      b.paint(0x6f7479, K.METAL);
      b.beam(x0, y0 - 0.3, z0, x0, y0 + h + (barbed ? 0.5 : 0.05), z0, 0.1, 0.1, 0b1111);
      b.beam(x0, y0 + h, z0, x1, y1 + h, z1, 0.06, 0.06, 0b1111);
      if (barbed) b.beam(x0, y0 + h + 0.45, z0, x1, y1 + h + 0.45, z1, 0.05, 0.05, 0b1111);
      b.lod = LOD.BOTH;
    }
    flush(1);
  }
}

// cylindrical tank (fuel farm, water tank) with roof cone and ring stairs hint
export function tank(b, x, z, y0, r, h, { color = 0xe9ebe6, band = 0xd04030, seg = 14 } = {}) {
  b.paint(color, K.METAL);
  b.cyl(x, z, y0, y0 + h, r, r, seg, { top: false });
  b.paint(color, K.PLAIN);
  b.cyl(x, z, y0 + h, y0 + h + r * 0.18, r, r * 0.15, seg);
  if (band) { b.paint(band, K.PLAIN); b.cyl(x, z, y0 + h * 0.72, y0 + h * 0.8, r + 0.03, r + 0.03, seg, { top: false }); }
  b.lod = LOD.NEAR;
  b.paint(0x6b6f73, K.METAL);
  b.beam(x + r + 0.3, y0, z, x + r + 0.3, y0 + h, z, 0.25, 0.6, 0b1111);
  b.lod = LOD.BOTH;
  b.colCyl(x, z, y0, y0 + h, r);
}

// classic water tower: legs + bowl + name band
export function waterTower(b, lights, x, z, y0, { h = 34, r = 6.5, color = 0xd8e4ea, legs = 6 } = {}) {
  b.paint(0x8f9aa2, K.METAL);
  const top = y0 + h - r * 1.2;
  for (let i = 0; i < legs; i++) {
    const a = (i / legs) * Math.PI * 2;
    b.beam(x + Math.cos(a) * r * 0.9, y0, z + Math.sin(a) * r * 0.9, x + Math.cos(a) * r * 0.7, top, z + Math.sin(a) * r * 0.7, 0.4, 0.4, 0b1111);
  }
  b.lod = LOD.NEAR;
  b.cyl(x, z, y0, top + 2, 0.6, 0.6, 6);
  b.lod = LOD.BOTH;
  b.paint(color, K.PLAIN);
  b.lathe(x, z, [[0.8, top - 1], [r * 0.8, top + r * 0.2], [r, top + r * 0.6], [r, top + r * 1.1], [r * 0.6, top + r * 1.35], [0, top + r * 1.45]], 14);
  b.colCyl(x, z, y0, top + r * 1.4, r * 0.9);
  const p = b.world(x, top + r * 1.5, z);
  lights.obstacle(p[0], p[1], p[2]);
  return top + r * 1.45;
}

// palm-free planter / bollard etc. small helpers
export function bollards(b, x0, z0, x1, z1, y, n = 6) {
  b.lod = LOD.NEAR;
  b.paint(0xd8d2c4, K.PLAIN);
  for (let i = 0; i <= n; i++) { const t = i / n; b.cyl(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, y, y + 0.9, 0.18, 0.18, 5); }
  b.lod = LOD.BOTH;
}
