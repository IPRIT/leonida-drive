import { Builder, K } from '../kit.js';

// Static parked aircraft (instanced props). Original simple low-poly shapes, no real airline marks:
// the tail, engine cowls and a cheat line take the per-instance livery colour (K.TINT).
// Local frame: nose towards -z, y up, origin on the ground under the wing root.

const WHITE = 0xf2f3f4, GREY = 0xa9adb2, DARK = 0x2a2d31, GLASS = 0x1c2630;

// ring of n points around the fuselage axis (x right, y up) at z, CW in x/y so the loft runs nose -> tail (+z)
function ring(z, cy, rx, ry, n = 10, squashTop = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = -(i / n) * Math.PI * 2 + Math.PI / 2;
    const s = Math.sin(t);
    out.push([Math.cos(t) * rx, cy + s * ry * (s > 0 ? squashTop : 1), z]);
  }
  return out;
}

// tapered, swept, flat wing panel from root (x0) to tip (x1): chord, sweep of the leading edge, dihedral
function wing(b, side, { x0, x1, y0, zLe0, c0, zLe1, c1, t0 = 0.5, t1 = 0.15, dy = 1 }) {
  const s = side;
  const X0 = x0 * s, X1 = x1 * s, Y1 = y0 + dy;
  const p = (x, y, z) => [x, y, z];
  // top / bottom surfaces (front-to-back), leading / trailing faces and tip
  const r0 = [p(X0, y0 + t0 / 2, zLe0), p(X0, y0 + t0 / 2, zLe0 + c0), p(X0, y0 - t0 / 2, zLe0 + c0), p(X0, y0 - t0 / 2, zLe0)];
  const r1 = [p(X1, Y1 + t1 / 2, zLe1), p(X1, Y1 + t1 / 2, zLe1 + c1), p(X1, Y1 - t1 / 2, zLe1 + c1), p(X1, Y1 - t1 / 2, zLe1)];
  const prev = b.orient;
  b.orient = [(X0 + X1) / 2, (y0 + Y1) / 2, (zLe0 + c0 / 2 + zLe1 + c1 / 2) / 2];
  const q = (a, bb, c, d) => b.quad(a, bb, c, d);
  q(r0[0], r1[0], r1[1], r0[1]); // top
  q(r0[2], r1[2], r1[3], r0[3]); // bottom
  q(r0[3], r1[3], r1[0], r0[0]); // leading edge
  q(r0[1], r1[1], r1[2], r0[2]); // trailing edge
  q(r1[0], r1[3], r1[2], r1[1]); // tip
  b.orient = prev;
  return { tipX: X1, tipY: Y1, tipZ: zLe1, tipC: c1 };
}

// nacelle along z: centre (x, y), from z0 (intake) to z1
function nacelle(b, x, y, z0, z1, r, tint = true) {
  const rings = [];
  const n = 8;
  for (const [z, rr] of [[z0, r * 0.92], [z0 + (z1 - z0) * 0.15, r], [z0 + (z1 - z0) * 0.75, r * 0.95], [z1, r * 0.6]]) {
    rings.push(ring(z, y, rr, rr, n).map(([px, py, pz]) => [px + x, py, pz]));
  }
  b.paint(tint ? WHITE : GREY, tint ? K.TINT : K.METAL);
  b.loft(rings, { capEnd: true });
  b.paint(DARK, K.PLAIN);
  b.loft([rings[0], ring(z0 + 0.3, y, r * 0.75, r * 0.75, n).map(([px, py, pz]) => [px + x, py, pz])], { capEnd: true });
}

// vertical fin as a closed slab of half-thickness th around the outline [root-front, top-front, top-back, root-back]
function finSlab(b, fin, th) {
  let cy = 0, cz = 0;
  for (const p of fin) { cy += p[1] / 4; cz += p[2] / 4; }
  b.orient = [0, cy, cz];
  const P = fin.map(([, y, z]) => [th, y, z]), N = fin.map(([, y, z]) => [-th, y, z]);
  b.quad(P[0], P[1], P[2], P[3]);
  b.quad(N[0], N[1], N[2], N[3]);
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; b.quad(P[i], P[j], N[j], N[i]); }
  b.orient = null;
}

function gear(b, x, z, h, w = 0.5) {
  b.paint(0x777b80, K.METAL);
  b.box(x - 0.12, 0.6, z - 0.12, x + 0.12, h, z + 0.12);
  b.paint(0x1c1c1e, K.PLAIN);
  b.box(x - w, 0, z - 0.6, x + w, 1.1, z + 0.6, 0b111111);
}

// generic airliner: len, span, r (fuselage radius), axisY, engines (x offsets), engR, tail height, windows
function airliner(o) {
  const b = new Builder({ far: false });
  const L = o.len, hl = L / 2, r = o.r, ay = o.axisY;
  // fuselage: nose cone -> barrel -> upswept tail cone
  const sec = [
    [-hl, 0.06, -0.25], [-hl + r * 0.35, 0.42, -0.12], [-hl + r * 0.9, 0.74, -0.05], [-hl + r * 1.7, 0.93, 0], [-hl + r * 2.6, 1, 0],
    [hl - r * 4.2, 1, 0], [hl - r * 2.6, 0.86, 0.18], [hl - r * 1.2, 0.55, 0.45], [hl, 0.16, 0.75],
  ];
  const rings = sec.map(([z, k, dy]) => ring(z, ay + dy * r, r * k, r * k * 1.03, 12, 1));
  b.paint(WHITE, K.PLAIN);
  b.loft(rings, { capStart: true, capEnd: true });
  // belly fairing + grey lower half hint
  b.paint(GREY, K.PLAIN);
  b.box(-r * 0.75, ay - r * 1.0, -r * 1.8, r * 0.75, ay - r * 0.55, r * 1.8);
  // cheat line (livery) + window band + cockpit
  b.paint(WHITE, K.TINT);
  const zW0 = -hl + r * 2.4, zW1 = hl - r * 4.6;
  for (const s of [1, -1]) {
    const x = s * r * 1.012;
    const q = (a, bb, c, d) => { b.orient = [0, a[1], (a[2] + c[2]) / 2]; b.quad(a, bb, c, d); b.orient = null; };
    q([x, ay - r * 0.28, zW1], [x, ay - r * 0.08, zW1], [x, ay - r * 0.08, zW0], [x, ay - r * 0.28, zW0]);
    // cabin windows: a row of individual panes (lit at night), door outlines at the front and rear
    b.paint(GLASS, K.NIGHTWIN);
    const pitch = 1.02, pw = 0.38, wy0 = ay + r * 0.13, wy1 = ay + r * 0.29;
    for (let z = zW0 + 1.6; z < zW1 - 0.4; z += pitch) {
      if (Math.abs(z - (zW0 + 0.6)) < 1.2 || Math.abs(z - (zW1 - 1.6)) < 1.4) continue; // doors
      q([x * 1.003, wy0, z + pw], [x * 1.003, wy1, z + pw], [x * 1.003, wy1, z], [x * 1.003, wy0, z]);
    }
    b.paint(0x8a9096, K.PLAIN);
    for (const zd of [zW0 + 0.6, zW1 - 1.6]) {
      const d0 = zd - 0.5, d1 = zd + 0.5, y0 = ay - r * 0.42, y1 = ay + r * 0.42;
      q([x * 1.004, y0, d1], [x * 1.004, y1, d1], [x * 1.004, y1, d1 - 0.08], [x * 1.004, y0, d1 - 0.08]);
      q([x * 1.004, y0, d0 + 0.08], [x * 1.004, y1, d0 + 0.08], [x * 1.004, y1, d0], [x * 1.004, y0, d0]);
      q([x * 1.004, y1 - 0.08, d1], [x * 1.004, y1, d1], [x * 1.004, y1, d0], [x * 1.004, y1 - 0.08, d0]);
    }
    b.paint(0x10161c, K.PLAIN);
    const zc = -hl + r * 0.75;
    q([x * 0.78, ay + r * 0.2, zc + r * 0.5], [x * 0.66, ay + r * 0.42, zc + r * 0.55], [x * 0.5, ay + r * 0.42, zc], [x * 0.62, ay + r * 0.2, zc - r * 0.05]);
    b.paint(WHITE, K.TINT);
  }
  // wings (low) + winglets
  b.paint(0xe3e6e9, K.METAL);
  const span = o.span / 2;
  for (const s of [1, -1]) {
    const tip = wing(b, s, { x0: r * 0.8, x1: span, y0: ay - r * 0.55, zLe0: o.wingZ - o.chord * 0.55, c0: o.chord, zLe1: o.wingZ - o.chord * 0.55 + span * o.sweep, c1: o.chord * 0.22, t0: r * 0.3, t1: 0.15, dy: span * 0.06 });
    b.paint(WHITE, K.TINT);
    b.quad([tip.tipX, tip.tipY, tip.tipZ + tip.tipC], [tip.tipX + s * 0.4 * 0, tip.tipY + o.r * 0.9, tip.tipZ + tip.tipC + 0.6], [tip.tipX, tip.tipY + o.r * 0.9, tip.tipZ + 0.9], [tip.tipX, tip.tipY, tip.tipZ]);
    b.quad([tip.tipX, tip.tipY, tip.tipZ], [tip.tipX, tip.tipY + o.r * 0.9, tip.tipZ + 0.9], [tip.tipX, tip.tipY + o.r * 0.9, tip.tipZ + tip.tipC + 0.6], [tip.tipX, tip.tipY, tip.tipZ + tip.tipC]);
    b.paint(0xe3e6e9, K.METAL);
  }
  // engines under the wings
  for (const ex of o.engines) {
    for (const s of [1, -1]) {
      const x = ex * s, zLe = o.wingZ - o.chord * 0.55 + Math.abs(ex) * o.sweep;
      const y = ay - r * 0.55 + Math.abs(ex) * 0.06 - o.engR * 1.25;
      nacelle(b, x, y, zLe - o.engR * 3.0, zLe + o.engR * 0.8, o.engR);
      b.paint(GREY, K.PLAIN);
      b.box(x - 0.15, y + o.engR * 0.7, zLe - o.engR * 1.2, x + 0.15, y + o.engR * 1.35, zLe + o.engR * 1.0);
    }
  }
  // horizontal stabiliser
  b.paint(0xe3e6e9, K.METAL);
  const hs = o.span * 0.18;
  for (const s of [1, -1]) wing(b, s, { x0: r * 0.3, x1: hs, y0: ay + r * 0.45, zLe0: hl - r * 3.2, c0: r * 1.9, zLe1: hl - r * 3.2 + hs * 0.65, c1: r * 0.7, t0: 0.35, t1: 0.1, dy: hs * 0.05 });
  // fin (livery)
  b.paint(WHITE, K.TINT);
  const fz0 = hl - r * 4.0, fc = r * 2.5, top = o.tailH;
  const rootY = ay + r * 0.75;
  const fin = [[0, rootY, fz0], [0, top, fz0 + (top - rootY) * 0.85], [0, top, fz0 + (top - rootY) * 0.85 + fc * 0.45], [0, rootY + 0.2, fz0 + fc * 1.25]];
  const th = 0.22;
  finSlab(b, fin, th);
  // gear
  gear(b, 0, -hl + r * 2.2, ay - r * 0.9, 0.35);
  for (const s of [1, -1]) gear(b, s * r * 1.05, o.wingZ + o.chord * 0.15, ay - r * 0.7, 0.55);
  // beacon lights (emissive dots: red on top/belly, green/red wing tips)
  b.paint(0xff2a1a, K.EMIT, 2);
  b.box(-0.15, ay + r * 0.98, -0.3, 0.15, ay + r * 1.12, 0.3);
  return b.near.geometry();
}

// high-wing twin turboprop with T-tail
function turboprop() {
  const b = new Builder({ far: false });
  const L = 27, hl = L / 2, r = 1.45, ay = 2.4;
  const sec = [[-hl, 0.1, -0.2], [-hl + 0.8, 0.55, -0.08], [-hl + 2.2, 0.92, 0], [-hl + 3.5, 1, 0], [hl - 6, 1, 0], [hl - 3, 0.7, 0.35], [hl, 0.18, 0.75]];
  b.paint(WHITE, K.PLAIN);
  b.loft(sec.map(([z, k, dy]) => ring(z, ay + dy * r, r * k, r * k, 10)), { capStart: true, capEnd: true });
  for (const s of [1, -1]) {
    const x = s * r * 1.01;
    const q = (a, bb, c, d) => { b.orient = [0, a[1], (a[2] + c[2]) / 2]; b.quad(a, bb, c, d); b.orient = null; };
    b.paint(GLASS, K.NIGHTWIN);
    q([x, ay + 0.1, hl - 6.5], [x, ay + 0.42, hl - 6.5], [x, ay + 0.42, -hl + 4], [x, ay + 0.1, -hl + 4]);
    b.paint(WHITE, K.TINT);
    q([x, ay - 0.6, hl - 4], [x, ay - 0.35, hl - 4], [x, ay - 0.35, -hl + 2], [x, ay - 0.6, -hl + 2]);
  }
  b.paint(0xe3e6e9, K.METAL);
  for (const s of [1, -1]) wing(b, s, { x0: 0.5, x1: 13.5, y0: ay + r * 1.05, zLe0: -2.6, c0: 2.6, zLe1: -2.2, c1: 1.4, t0: 0.4, t1: 0.15, dy: -0.2 });
  b.box(-1.2, ay + r * 0.7, -2.8, 1.2, ay + r * 1.1, 0.2);
  for (const s of [1, -1]) {
    const x = s * 4.1;
    b.paint(WHITE, K.TINT);
    b.loft([ring(-4.6, ay + r * 0.75, 0.55, 0.65, 8).map(([px, py, pz]) => [px + x, py, pz]), ring(-3.2, ay + r * 0.75, 0.75, 0.9, 8).map(([px, py, pz]) => [px + x, py, pz]), ring(1.4, ay + r * 0.6, 0.55, 0.6, 8).map(([px, py, pz]) => [px + x, py, pz])], { capStart: true, capEnd: true });
    b.paint(DARK, K.PLAIN);
    // propeller disc blades (crossed)
    b.box(x - 0.12, ay + r * 0.75 - 1.95, -4.85, x + 0.12, ay + r * 0.75 + 1.95, -4.75);
    b.box(x - 1.95, ay + r * 0.75 - 0.12, -4.85, x + 1.95, ay + r * 0.75 + 0.12, -4.75);
    gear(b, x * 0.95, -0.5, ay + r * 0.2, 0.4);
  }
  // T-tail
  b.paint(WHITE, K.TINT);
  const th = 0.18, fz = hl - 5, top = ay + r + 5.4;
  const fin = [[0, ay + r * 0.7, fz], [0, top, fz + 2.6], [0, top, fz + 4.4], [0, ay + r * 0.8, hl - 0.4]];
  finSlab(b, fin, th);
  b.paint(0xe3e6e9, K.METAL);
  for (const s of [1, -1]) wing(b, s, { x0: 0, x1: 3.9, y0: top, zLe0: fz + 2.4, c0: 2.1, zLe1: fz + 3.2, c1: 1.2, t0: 0.25, t1: 0.1, dy: 0 });
  gear(b, 0, -hl + 2, ay - r * 0.7, 0.3);
  b.paint(0xff2a1a, K.EMIT, 2);
  b.box(-0.12, ay + r, -0.3, 0.12, ay + r + 0.15, 0.3);
  return b.near.geometry();
}

// small high-wing single (Cessna-class), strut-braced, tricycle gear
function lightPlane() {
  const b = new Builder({ far: false });
  const ay = 1.45, r = 0.62;
  const sec = [[-4, 0.45, -0.1], [-3.4, 0.85, 0], [-2.2, 1, 0.05], [0.4, 1, 0.1], [2.2, 0.6, 0.3], [4.3, 0.22, 0.55]];
  b.paint(WHITE, K.PLAIN);
  b.loft(sec.map(([z, k, dy]) => ring(z, ay + dy, r * k, r * k * 1.15, 8)), { capStart: true, capEnd: true });
  b.paint(GLASS, K.PLAIN);
  b.box(-r * 0.92, ay + 0.15, -2.3, r * 0.92, ay + r * 1.05, -0.4);
  b.paint(WHITE, K.TINT);
  for (const s of [1, -1]) {
    const x = s * r * 1.01;
    const q = (a, bb, c, d) => { b.orient = [0, a[1], (a[2] + c[2]) / 2]; b.quad(a, bb, c, d); b.orient = null; };
    q([x, ay - 0.2, 3.5], [x, ay - 0.05, 3.5], [x, ay - 0.05, -3.6], [x, ay - 0.2, -3.6]);
  }
  b.paint(0xf0f1f2, K.PLAIN);
  for (const s of [1, -1]) wing(b, s, { x0: 0.2, x1: 5.5, y0: ay + r * 1.2, zLe0: -1.9, c0: 1.6, zLe1: -1.8, c1: 1.2, t0: 0.18, t1: 0.1, dy: 0.15 });
  b.paint(0x9a9ea3, K.METAL);
  for (const s of [1, -1]) b.beam(s * r * 0.9, ay - 0.35, -1.2, s * 2.8, ay + r * 1.12, -1.2, 0.08, 0.05);
  b.paint(WHITE, K.TINT);
  const fin = [[0, ay + 0.3, 2.6], [0, ay + 1.75, 3.6], [0, ay + 1.75, 4.2], [0, ay + 0.35, 4.35]];
  finSlab(b, fin, 0.06);
  b.paint(0xf0f1f2, K.PLAIN);
  for (const s of [1, -1]) wing(b, s, { x0: 0, x1: 1.7, y0: ay + 0.4, zLe0: 3.4, c0: 0.9, zLe1: 3.6, c1: 0.6, t0: 0.08, t1: 0.05, dy: 0 });
  b.paint(DARK, K.PLAIN);
  b.box(-0.06, ay - 0.85, -4.12, 0.06, ay + 0.85, -4.05);
  b.paint(0x1c1c1e, K.PLAIN);
  for (const [x, z] of [[0, -3.1], [1.1, -0.4], [-1.1, -0.4]]) b.box(x - 0.1, 0, z - 0.25, x + 0.1, 0.5, z + 0.25, 0b111111);
  b.paint(0x777b80, K.METAL);
  for (const s of [1, -1]) b.beam(s * 0.3, ay - 0.45, -0.4, s * 1.1, 0.3, -0.4, 0.06, 0.06);
  b.beam(0, ay - 0.5, -3.1, 0, 0.3, -3.1, 0.06, 0.06);
  return b.near.geometry();
}

// business jet: rear engines, T-tail, swept low wing
function bizjet() {
  const b = new Builder({ far: false });
  const L = 20, hl = L / 2, r = 1.0, ay = 1.75;
  const sec = [[-hl, 0.06, -0.3], [-hl + 0.7, 0.5, -0.12], [-hl + 1.8, 0.88, 0], [-hl + 3, 1, 0], [hl - 5.5, 1, 0.05], [hl - 2.5, 0.65, 0.3], [hl, 0.2, 0.6]];
  b.paint(WHITE, K.PLAIN);
  b.loft(sec.map(([z, k, dy]) => ring(z, ay + dy * r, r * k, r * k, 10)), { capStart: true, capEnd: true });
  for (const s of [1, -1]) {
    const x = s * r * 1.01;
    const q = (a, bb, c, d) => { b.orient = [0, a[1], (a[2] + c[2]) / 2]; b.quad(a, bb, c, d); b.orient = null; };
    b.paint(GLASS, K.NIGHTWIN);
    q([x, ay + 0.05, hl - 7], [x, ay + 0.35, hl - 7], [x, ay + 0.35, -hl + 3.2], [x, ay + 0.05, -hl + 3.2]);
    b.paint(WHITE, K.TINT);
    q([x, ay - 0.4, hl - 3], [x, ay - 0.22, hl - 3], [x, ay - 0.22, -hl + 1.5], [x, ay - 0.4, -hl + 1.5]);
  }
  b.paint(0xe3e6e9, K.METAL);
  for (const s of [1, -1]) wing(b, s, { x0: 0.6, x1: 9.5, y0: ay - r * 0.6, zLe0: -1.8, c0: 3.2, zLe1: 2.6, c1: 1.0, t0: 0.3, t1: 0.1, dy: 0.5 });
  for (const s of [1, -1]) {
    nacelle(b, s * 1.75, ay + 0.35, hl - 6.8, hl - 3.4, 0.55);
    b.paint(GREY, K.PLAIN);
    b.box(s > 0 ? 0.6 : -1.35, ay + 0.2, hl - 5.6, s > 0 ? 1.35 : -0.6, ay + 0.5, hl - 4.2);
  }
  b.paint(WHITE, K.TINT);
  const th = 0.16, fz = hl - 4.2, top = ay + 4.6;
  const fin = [[0, ay + r * 0.6, fz], [0, top, fz + 2.6], [0, top, fz + 3.9], [0, ay + r * 0.6, hl - 0.2]];
  finSlab(b, fin, th);
  b.paint(0xe3e6e9, K.METAL);
  for (const s of [1, -1]) wing(b, s, { x0: 0, x1: 3.4, y0: top, zLe0: fz + 2.5, c0: 1.6, zLe1: fz + 3.6, c1: 0.9, t0: 0.18, t1: 0.08, dy: 0 });
  gear(b, 0, -hl + 2.2, ay - 0.8, 0.25);
  for (const s of [1, -1]) gear(b, s * 1.4, 0.8, ay - 0.6, 0.3);
  return b.near.geometry();
}

function boxCollider(field, x, y, z, yaw, s, tag, len, span, fuseW, fuseH, wingY) {
  field.box(x, y + fuseH / 2 + 0.6, z, fuseW / 2 * s, fuseH / 2 * s, len / 2 * s, yaw, tag);
  field.box(x, y + wingY * s, z, span / 2 * s, 0.4 * s, Math.max(2, len * 0.12) * s, yaw, tag);
}

// instanced prop types (geometry is built lazily at finalize)
export const AIRCRAFT = {
  narrow: { key: 'narrow', geometry: () => airliner({ len: 37.6, span: 35.8, r: 1.98, axisY: 3.25, engines: [5.8], engR: 1.0, tailH: 11.8, wingZ: 1.0, chord: 6.6, sweep: 0.42 }), maxDist: 2600, collider: (f, x, y, z, yaw, s, t) => boxCollider(f, x, y, z, yaw, s, t, 37, 34, 4, 4.2, 1.9) },
  wide: { key: 'wide', geometry: () => airliner({ len: 63.7, span: 60.3, r: 2.82, axisY: 4.6, engines: [9.9], engR: 1.6, tailH: 17.5, wingZ: 2.0, chord: 10.5, sweep: 0.5 }), maxDist: 3200, collider: (f, x, y, z, yaw, s, t) => boxCollider(f, x, y, z, yaw, s, t, 63, 58, 5.6, 5.8, 2.6) },
  widecargo: { key: 'widecargo', geometry: () => airliner({ len: 70, span: 64, r: 3.1, axisY: 4.9, engines: [10.5, 20.5], engR: 1.45, tailH: 19, wingZ: 2.4, chord: 11, sweep: 0.55 }), maxDist: 3200, collider: (f, x, y, z, yaw, s, t) => boxCollider(f, x, y, z, yaw, s, t, 70, 62, 6.2, 6.2, 2.8) },
  turboprop: { key: 'turboprop', geometry: turboprop, maxDist: 2200, collider: (f, x, y, z, yaw, s, t) => boxCollider(f, x, y, z, yaw, s, t, 27, 27, 2.9, 3, 4.2) },
  light: { key: 'light', geometry: lightPlane, maxDist: 1500, collider: (f, x, y, z, yaw, s, t) => { f.box(x, y + 1.2, z, 0.8 * s, 0.9 * s, 4 * s, yaw, t); } },
  bizjet: { key: 'bizjet', geometry: bizjet, maxDist: 2000, collider: (f, x, y, z, yaw, s, t) => boxCollider(f, x, y, z, yaw, s, t, 20, 19, 2, 2.2, 1.2) },
};

// footprint (length, span) per type for stand fitting
export const AIRCRAFT_SIZE = { narrow: [38, 36], wide: [64, 61], widecargo: [70, 65], turboprop: [27, 27], light: [8.5, 11], bizjet: [20.5, 19.5] };

// fictional liveries (tail / cowl / cheat-line colour)
export const LIVERIES = [0x1f5fa8, 0xd6283b, 0x14a39a, 0xf2a71b, 0x6c3fa0, 0x0f2f5c, 0xe8618c, 0x2f8f3a, 0x111111, 0xff7a1a];
