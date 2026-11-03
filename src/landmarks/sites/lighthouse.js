import { K, LOD } from '../kit.js';
import { L } from '../lights.js';

// Lighthouses: 'tower' (white conical masonry tower with black lantern, keeper's cottage), 'skeletal'
// (iron frame around a central stair tube, white cottage on stilts), 'reef' (tall rust-brown octagonal
// pyramid on piles in open water). Rotating twin beams at night.
export function lighthouse(ctx, def) {
  const { b, lights, beams } = ctx;
  const style = def.style || 'tower';
  const [x, z] = def.water ? [def.x, def.z] : ctx.spot(def.x, def.z, 9, { maxR: 120, dryR: style === 'skeletal' ? 9 : 6 });
  const ground = def.water ? 0 : ctx.groundY(x, z);
  const y0 = ground - 0.6;
  ctx.remove({ circle: [x, z, 14] });
  ctx.hideTrees({ circle: [x, z, 9] });
  b.push();
  b.translate(x, 0, z).rotY(def.yaw || 0);
  let lampY;
  // ancillary house: first candidate offset on dry land clear of roads (local frame = world axes here)
  // (the whole cottage + porch footprint must be on dry land; no house at all rather than one in the sea)
  let house = null;
  for (const d of [15, 19, 24, 30]) {
    for (let i = 0; i < 12 && !house; i++) {
      const a = (i / 12) * Math.PI * 2 + 2.7, ox = Math.cos(a) * d, oz = Math.sin(a) * d;
      const yaw = style === 'tower' ? 0.35 : 0;
      if (ctx.dryRect(x + ox, z + oz, yaw, 7.2, 8.4, 0.5) && ctx.clearOfRoads(x + ox, z + oz, 9)) {
        let gmin = Infinity;
        for (const [px, pz] of [[-6, -5], [6, -5], [6, 8], [-6, 8], [0, 0]]) gmin = Math.min(gmin, ctx.groundY(x + ox + px, z + oz + pz));
        house = [ox, oz, gmin - 0.4];
      }
    }
    if (house) break;
  }
  def = { ...def, house };
  if (style === 'tower') lampY = masonry(b, y0, def);
  else if (style === 'skeletal') lampY = skeletal(b, y0, def, false);
  else lampY = skeletal(b, y0, def, true);
  // lamp glow + beams
  const p = b.world(0, lampY, 0);
  lights.add(p[0], p[1], p[2], 0xfff1c8, 1.6, L.ALWAYS, 0, 9000);
  beams.add(p[0], p[1], p[2], { length: def.beam || 320, radius: 26, speed: 0.55, phase: (x * 0.01) % 6.28, twin: true, r0: 0.7 });
  b.pop();
  ctx.view([x + 46, ground + 22, z + 38], [x, ground + 16, z], 'lighthouse');
  ctx.view([x - 70, ground + 40, z - 90], [x, ground + lampY * 0.5 - y0 * 0.5, z], 'far');
  return { top: lampY };
}

function lantern(b, y, r = 1.9) {
  // gallery deck + railing
  b.paint(0x26282b, K.METAL);
  b.cyl(0, 0, y - 0.35, y, r + 1.6, r + 1.6, 16, { bottom: true });
  b.lod = LOD.NEAR;
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    b.box(Math.cos(a) * (r + 1.45) - 0.05, y, Math.sin(a) * (r + 1.45) - 0.05, Math.cos(a) * (r + 1.45) + 0.05, y + 1.1, Math.sin(a) * (r + 1.45) + 0.05);
  }
  b.cyl(0, 0, y + 1.05, y + 1.15, r + 1.5, r + 1.5, 20, { open: true });
  b.lod = LOD.BOTH;
  // lantern room: dark base, glazing, warm lamp, domed cap, vent ball, rod
  b.paint(0x2b2d30, K.METAL);
  b.cyl(0, 0, y, y + 0.9, r, r, 10);
  b.paint(0x9fc3cc, K.GLASS, 2);
  b.cyl(0, 0, y + 0.9, y + 3.3, r * 0.96, r * 0.96, 10, { top: false });
  b.paint(0xffe2a0, K.EMIT, 1);
  b.cyl(0, 0, y + 1.3, y + 2.9, 0.75, 0.75, 8);
  b.paint(0x1f2124, K.METAL);
  b.dome(0, y + 3.3, 0, r * 1.08, 10, 3, { squash: 0.75 });
  b.sphere(0, y + 3.3 + r * 0.85, 0, 0.32, 6, 4);
  b.lod = LOD.NEAR;
  b.cyl(0, 0, y + 3.3 + r * 0.9, y + 3.3 + r * 0.9 + 2.2, 0.05, 0.03, 4);
  b.lod = LOD.BOTH;
  return y + 2.1;
}

function masonry(b, y0, def) {
  const H = def.height || 27, r0 = 4.4, r1 = 3.0;
  b.paint(0xf3f1ea, K.PLAIN);
  b.cyl(0, 0, y0, y0 + H, r0, r1, 14);
  b.colCyl(0, 0, y0, y0 + H, r0 * 0.9);
  // corbelled cornice under the gallery
  b.paint(0xe6e2d8, K.PLAIN);
  b.cyl(0, 0, y0 + H - 1.2, y0 + H, r1, r1 + 0.9, 14);
  b.lod = LOD.NEAR;
  // door + small slit windows spiralling up
  b.paint(0x3a2c22, K.PLAIN);
  b.push(); b.rotY(0.4); b.box(r0 - 0.15, y0 + 0.6, -0.7, r0 + 0.25, y0 + 3.2, 0.7); b.pop();
  b.paint(0x1d2226, K.PLAIN);
  for (let i = 0; i < 6; i++) {
    const t = (i + 1) / 7, r = r0 + (r1 - r0) * t + 0.05, a = 0.4 + i * 1.9;
    b.push(); b.rotY(a); b.box(r - 0.2, y0 + H * t - 0.6, -0.3, r + 0.08, y0 + H * t + 0.6, 0.3); b.pop();
  }
  b.lod = LOD.BOTH;
  const lamp = lantern(b, y0 + H);
  if (!def.house) return lamp;
  // keeper's cottage: white walls, green shutters, red hip roof, porch (own ground level)
  y0 = def.house[2];
  b.push();
  b.translate(def.house[0], 0, def.house[1]).rotY(0.35);
  b.paint(0xf6f2e8, K.WIN, 3);
  b.box(-6, y0, -4.5, 6, y0 + 4.8, 4.5);
  b.colBox(-6, y0, -4.5, 6, y0 + 4.8, 4.5);
  b.paint(0xb84a36, K.PLAIN);
  roofHip(b, -6.6, -5.1, 6.6, 5.1, y0 + 4.8, 2.8);
  b.lod = LOD.NEAR;
  b.paint(0xf6f2e8, K.PLAIN);
  b.box(-5.5, y0 + 0.4, 4.5, 5.5, y0 + 0.6, 7.5);
  for (const px of [-5.3, -1.8, 1.8, 5.3]) b.box(px - 0.12, y0 + 0.6, 7.2, px + 0.12, y0 + 3.6, 7.45);
  b.paint(0xb84a36, K.PLAIN);
  b.quad([-5.8, y0 + 3.6, 7.8], [5.8, y0 + 3.6, 7.8], [5.8, y0 + 4.6, 4.5], [-5.8, y0 + 4.6, 4.5]);
  b.lod = LOD.BOTH;
  b.pop();
  return lamp;
}

// skeletal iron lighthouse: 4 (or 8 for reef) splayed legs with cross bracing around a central stair tube
function skeletal(b, y0, def, reef) {
  const H = def.height || (reef ? 40 : 30);
  const base = reef ? 9 : 6.5, top = reef ? 3.2 : 2.6;
  const n = reef ? 8 : 4;
  const legCol = reef ? 0x6e4632 : 0x34383c;
  if (reef) {
    // pile foundation on the sea floor up to deck level
    b.paint(0x5b4a40, K.METAL);
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + Math.PI / n; b.cyl(Math.cos(a) * base, Math.sin(a) * base, -6, 2.5, 0.45, 0.45, 6); }
    y0 = 2.5;
    b.paint(0x3c3530, K.PLAIN);
    b.cyl(0, 0, y0 + 9.5, y0 + 10.2, base * 0.82, base * 0.82, 8, { bottom: true });
    b.paint(0xd8d2c0, K.WIN, 3);
    b.prism(octagon(base * 0.55), y0 + 10.2, y0 + 13.6);
  }
  b.paint(legCol, K.METAL);
  const leg = (i, t) => { const a = (i / n) * Math.PI * 2 + Math.PI / n, r = base + (top - base) * t; return [Math.cos(a) * r, y0 + H * t, Math.sin(a) * r]; };
  for (let i = 0; i < n; i++) {
    const A = leg(i, 0), B = leg(i, 1);
    b.beam(A[0], A[1], A[2], B[0], B[1], B[2], 0.45, 0.45, 0b1111);
  }
  b.lod = LOD.NEAR;
  const bays = reef ? 6 : 5;
  for (let k = 0; k < bays; k++) {
    const t0 = k / bays, t1 = (k + 1) / bays;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const A = leg(i, t0), B = leg(j, t1), C = leg(j, t0), D = leg(i, t1);
      b.beam(A[0], A[1], A[2], B[0], B[1], B[2], 0.16, 0.16, 0b1111);
      b.beam(C[0], C[1], C[2], D[0], D[1], D[2], 0.16, 0.16, 0b1111);
      b.beam(D[0], D[1], D[2], leg(j, t1)[0], D[1], leg(j, t1)[2], 0.2, 0.2, 0b1111);
    }
  }
  b.lod = LOD.BOTH;
  // central stair tube
  b.paint(reef ? 0x7a5038 : 0xf2f0ea, K.PLAIN);
  b.cyl(0, 0, y0 + (reef ? 13.6 : 0), y0 + H, 1.2, 1.2, 8);
  b.colCyl(0, 0, y0, y0 + H, reef ? base * 0.7 : base * 0.6);
  if (!reef && def.house) {
    // keeper's house on stilts beside it (own ground level)
    const yt = y0;
    y0 = def.house[2];
    b.push(); b.translate(def.house[0], 0, def.house[1]);
    b.paint(0xffffff, K.PLAIN);
    for (const [px, pz] of [[-5, -4], [5, -4], [5, 4], [-5, 4]]) b.box(px - 0.2, y0, pz - 0.2, px + 0.2, y0 + 3, pz + 0.2);
    b.paint(0xf5f3ee, K.WIN, 3);
    b.box(-5.5, y0 + 3, -4.5, 5.5, y0 + 7, 4.5);
    b.colBox(-5.5, y0, -4.5, 5.5, y0 + 7, 4.5);
    b.paint(0x4d6b5c, K.METAL);
    roofHip(b, -6.5, -5.5, 6.5, 5.5, y0 + 7, 2.6);
    b.pop();
    y0 = yt;
  }
  return lantern(b, y0 + H, reef ? 2.2 : 1.8);
}

function octagon(r) { const p = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; p.push([Math.cos(a) * r, Math.sin(a) * r]); } return p; }

// hip roof over an axis-aligned rectangle (local)
export function roofHip(b, x0, z0, x1, z1, y, rise) {
  const cx = (x0 + x1) / 2, inset = Math.min(x1 - x0, z1 - z0) / 2;
  const rx0 = Math.min(cx, x0 + inset), rx1 = Math.max(cx, x1 - inset), zc = (z0 + z1) / 2;
  const T0 = [rx0, y + rise, zc], T1 = [rx1, y + rise, zc];
  b.quad([x0, y, z1], [x1, y, z1], T1, T0);
  b.quad([x1, y, z0], [x0, y, z0], T0, T1);
  b.tri([x1, y, z1], [x1, y, z0], T1);
  b.tri([x0, y, z0], [x0, y, z1], T0);
}
