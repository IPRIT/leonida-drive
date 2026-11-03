// Low-poly part geometries for HumanBatch. Every geometry is non-indexed with attributes
// position, normal, aT (0 at the part top .. 1 at the bottom: clothing ranges), aStyle (bit index for masked extras,
// -1 = always shown) and aChan (color channel, see the material in HumanBatch.js).
// Canonical spaces: limbs/torso span y in [-1, 0] with radius 1; head is a unit sphere; extras live in their host's space.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HX, HY, CX, PX, AX } from './lookcodes.js';

const CH = { body: 0, A: 1, B: 2, C: 3, black: 4, white: 5, shadeA: 6, gold: 7, screen: 8, shadeC: 9, lips: 10, shadeB: 11, steel: 12, lens: 13, gem: 14 };
export { CH };

// style: -1 = always drawn, otherwise a bitmask of the look styles that show this piece
const bits = (b) => (b === -1 ? -1 : Array.isArray(b) ? b.reduce((m, i) => m | (1 << i), 0) : 1 << b);

function prep(geo, chan = 0, style = -1, tFn = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const n = pos.count;
  const aT = new Float32Array(n), aS = new Float32Array(n).fill(style), aC = new Float32Array(n).fill(chan);
  for (let i = 0; i < n; i++) aT[i] = tFn ? tFn(pos.getX(i), pos.getY(i), pos.getZ(i)) : Math.min(1, Math.max(0, -pos.getY(i)));
  g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  g.setAttribute('aStyle', new THREE.BufferAttribute(aS, 1));
  g.setAttribute('aChan', new THREE.BufferAttribute(aC, 1));
  return g;
}

function box(x0, x1, y0, y1, z0, z1) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

function merge(list) {
  const g = mergeGeometries(list, false);
  g.computeBoundingSphere();
  return g;
}

// keep icosphere triangles whose centroid passes keep(cx,cy,cz); optional per-vertex displacement
function sphereCap(r, detail, keep, displace = null) {
  const ico = new THREE.IcosahedronGeometry(r, detail);
  const src = ico.index ? ico.toNonIndexed() : ico;
  const p = src.attributes.position.array;
  const out = [];
  for (let i = 0; i < p.length; i += 9) {
    const cx = (p[i] + p[i + 3] + p[i + 6]) / 3, cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3, cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3;
    if (!keep(cx / r, cy / r, cz / r)) continue;
    for (let k = 0; k < 9; k += 3) {
      let x = p[i + k], y = p[i + k + 1], z = p[i + k + 2];
      if (displace) [x, y, z] = displace(x, y, z);
      out.push(x, y, z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}

const hash3 = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};
const lumpy = (amp) => (x, y, z) => {
  const k = 1 + (hash3(Math.round(x * 50), Math.round(y * 50), Math.round(z * 50)) - 0.5) * amp;
  return [x * k, y * k, z * k];
};

// ---------------- body parts ----------------
export function prismGeometry() {
  const g = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false, Math.PI / 8);
  g.translate(0, -0.5, 0);
  return prep(g, CH.body);
}

// thin quad facing -Z (face decals: eyes, brows, mouth)
function quad(x0, x1, y0, y1, z) {
  const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
  g.rotateY(Math.PI);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return g;
}

export function headGeometry() {
  const s = new THREE.IcosahedronGeometry(1, 1);
  const p = s.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y < 0) x *= 1 - 0.24 * Math.pow(-y, 1.4);
    if (z > 0 && y > -0.3) z *= 1.06;
    if (y < -0.5 && z < 0) z *= 0.95;
    p.setXYZ(i, x, y, z);
  }
  const t = () => 0.5;
  const parts = [
    prep(s, CH.body, -1, t),
    prep(box(-0.12, 0.12, -0.26, 0.06, -1.06, -0.86), CH.body, -1, t), // nose
    prep(quad(-0.5, -0.24, 0.07, 0.17, -0.93), CH.black, -1, t), // eyes
    prep(quad(0.24, 0.5, 0.07, 0.17, -0.93), CH.black, -1, t),
    prep(quad(-0.54, -0.2, 0.25, 0.31, -0.94), CH.A, -1, t), // brows
    prep(quad(0.2, 0.54, 0.25, 0.31, -0.94), CH.A, -1, t),
    prep(quad(-0.2, 0.2, -0.5, -0.43, -0.875), CH.lips, -1, t), // mouth
    prep(box(-1.04, -0.9, -0.2, 0.18, -0.08, 0.2), CH.body, -1, t), // ears
    prep(box(0.9, 1.04, -0.2, 0.18, -0.08, 0.2), CH.body, -1, t),
  ];
  return merge(parts);
}

export function handGeometry() {
  const g = new THREE.CylinderGeometry(1, 0.75, 1, 4, 1, false, Math.PI / 4);
  g.translate(0, -0.5, 0);
  // thumb on the palm side towards the front
  const th = box(-0.35, 0.35, -0.55, -0.1, -1.5, -0.7);
  return merge([prep(g, CH.body), prep(th, CH.body)]);
}

export function footGeometry() {
  // wedge: ankle at the origin, sole at y=-1, toe at z=-1, heel at z=+0.35
  const v = [
    [-1, 0, 0.35], [1, 0, 0.35], [1, 0, -0.25], [-1, 0, -0.25], // top (ankle)
    [-1, -1, 0.35], [1, -1, 0.35], [1, -1, -1], [-1, -1, -1], // sole
    [-0.9, -0.45, -1], [0.9, -0.45, -1], // toe top
  ];
  const f = [
    [0, 1, 2], [0, 2, 3], // top
    [4, 6, 5], [4, 7, 6], // sole
    [0, 4, 5], [0, 5, 1], // heel
    [3, 2, 9], [3, 9, 8], // instep
    [8, 9, 6], [8, 6, 7], // toe front
    [1, 5, 6], [1, 6, 9], [1, 9, 2], // right
    [0, 3, 8], [0, 8, 7], [0, 7, 4], // left
  ];
  const pos = [];
  for (const t of f) for (const i of t) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return prep(g, CH.body);
}

// ---------------- head extras (hair, facial hair, hats, glasses) ----------------

function hairCap(r, keep, amp = 0) {
  return sphereCap(r, 1, keep, amp ? lumpy(amp) : null);
}
const shortKeep = (x, y, z) => (z < -0.45 ? y > 0.36 : z < 0.2 && Math.abs(x) > 0.7 ? y > -0.05 : y > -0.42);

export const HAIR_BITS = bits([HX.buzz, HX.short, HX.long, HX.ponytail, HX.afro, HX.bun, HX.mohawk, HX.curly, HX.bob, HX.sidepart]);
export const HAIR2_BITS = bits([HX.slick, HX.pompadour, HX.locs, HX.cornrows, HX.spiky, HX.mullet, HX.topknot]); // salon styles
export const FACE_BITS = bits([HX.beard, HX.mustache, HX.goatee, HX.stubble, HX.chops, HX.handlebar]);
export const HAT_S_BITS = bits([HY.cap, HY.capback, HY.trucker, HY.beanie, HY.visor, HY.beret]);
export const HAT_W_BITS = bits([HY.bucket, HY.sunhat, HY.fedora, HY.cowboy, HY.bandBlack, HY.bandGold]);
export const HAT_BITS = HAT_S_BITS | HAT_W_BITS;
export const EYE_BITS = bits([HY.shades, HY.round, HY.clear, HY.aviator, HY.cateye, HY.shield, HY.browline]);
export const EAR_BITS = bits([HY.studs, HY.hoops, HY.diamonds]);

const beardKeep = (x, y, z) => y < -0.1 && z < 0.3 && !(Math.abs(x) < 0.26 && y > -0.56 && y < -0.36 && z < 0);

// full-detail hair and facial hair (headX), split so that a figure only draws the groups it uses
export function headExtrasGeometry() {
  const parts = { hair: [], hair2: [], face: [] };
  const add = (g, chan, bit, t = () => 0.5) => {
    const m = bits(bit);
    parts[m & FACE_BITS ? 'face' : m & HAIR2_BITS ? 'hair2' : 'hair'].push(prep(g, chan, m, t));
  };
  // hair
  add(hairCap(1.05, (x, y, z) => (z < -0.5 ? y > 0.42 : y > -0.2)), CH.A, HX.buzz);
  add(hairCap(1.11, shortKeep), CH.A, [HX.short, HX.long, HX.ponytail, HX.bun, HX.sidepart]);
  add(hairCap(1.11, shortKeep), CH.A, [HX.pompadour, HX.locs, HX.spiky, HX.mullet]);
  add(box(-0.95, 0.95, -2.0, 0.3, 0.3, 1.08), CH.A, HX.long);
  add(box(-1.1, -0.82, -1.55, 0.25, -0.5, 0.65), CH.A, HX.long);
  add(box(0.82, 1.1, -1.55, 0.25, -0.5, 0.65), CH.A, HX.long);
  {
    const tail = new THREE.CylinderGeometry(0.24, 0.1, 1.7, 6);
    tail.rotateX(-0.35);
    tail.translate(0, -0.45, 1.32);
    add(tail, CH.A, HX.ponytail);
    add(box(-0.15, 0.15, 0.25, 0.48, 0.95, 1.2), CH.shadeA, HX.ponytail);
  }
  {
    const bun = new THREE.IcosahedronGeometry(0.42, 0);
    bun.translate(0, 0.92, 0.62);
    add(bun, CH.A, HX.bun);
  }
  add(sphereCap(1.42, 1, (x, y, z) => y > -0.42 && !(z < -0.3 && y < 0.38), lumpy(0.22)).translate(0, 0.18, 0.12), CH.A, HX.afro);
  for (let i = 0; i < 6; i++) {
    const th = -0.9 + i * 0.42;
    const b = box(-0.11, 0.11, -0.3, 0.32, -0.22, 0.22);
    b.rotateX(th);
    b.translate(0, 1.12 * Math.cos(th), 1.12 * Math.sin(th));
    add(b, CH.A, HX.mohawk);
  }
  add(sphereCap(1.13, 1, shortKeep, lumpy(0.18)), CH.A, HX.curly);
  add(hairCap(1.12, (x, y, z) => (z < -0.45 ? y > 0.38 : y > -0.85)), CH.A, HX.bob);
  {
    const sweep = box(-0.9, 0.25, 0.75, 1.0, -0.85, 0.2);
    sweep.rotateZ(0.12);
    add(sweep, CH.shadeA, HX.sidepart);
  }
  // slicked back: tight cap, comb lines and a little roll at the nape
  add(hairCap(1.07, (x, y, z) => (z < -0.55 ? y > 0.45 : y > -0.15)), CH.A, HX.slick);
  for (const x of [-0.3, 0, 0.3]) add(box(x - 0.035, x + 0.035, 1.02, 1.08, -0.6, 0.7), CH.shadeA, HX.slick);
  add(box(-0.62, 0.62, -0.35, 0.05, 0.9, 1.12), CH.A, HX.slick);
  // pompadour: a big rounded quiff at the front
  {
    const q = new THREE.IcosahedronGeometry(0.62, 1);
    q.scale(1.25, 0.72, 0.95);
    q.translate(0, 1.0, -0.42);
    add(q, CH.A, HX.pompadour);
  }
  // locs: strands hanging around the back and sides
  for (let i = 0; i < 13; i++) {
    const a = -1.95 + (i / 12) * 3.9; // around the back (+z), from one side to the other
    const x = Math.sin(a) * 1.05, z = Math.cos(a) * 1.0;
    const len = 1.2 + 0.35 * Math.abs(Math.sin(i * 2.3));
    const c = new THREE.CylinderGeometry(0.1, 0.085, len, 4);
    c.translate(x, 0.2 - len / 2, z);
    add(c, i % 3 ? CH.A : CH.shadeA, HX.locs);
  }
  // cornrows: a tight cap with rows front to back
  add(hairCap(1.03, (x, y, z) => (z < -0.5 ? y > 0.48 : y > -0.25)), CH.shadeA, HX.cornrows);
  for (let i = 0; i < 6; i++) {
    const x = -0.62 + i * 0.25;
    const row = sphereCap(1.07, 2, (cx, cy, cz) => Math.abs(cx - x) < 0.07 && cy > 0.1 - 0.4 * Math.abs(x) && cz > -0.85);
    add(row, CH.A, HX.cornrows);
  }
  // spiky
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2, r = i % 2 ? 0.55 : 0.25;
    const c = new THREE.ConeGeometry(0.17, 0.62, 4);
    const dir = new THREE.Vector3(Math.cos(a) * r, 1, Math.sin(a) * r - 0.15).normalize();
    c.translate(0, 0.31, 0);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    c.translate(dir.x * 0.95, dir.y * 0.95, dir.z * 0.95);
    add(c, CH.A, HX.spiky);
  }
  // mullet: short on top, long at the back
  add(box(-0.72, 0.72, -1.55, 0.15, 0.45, 1.07), CH.A, HX.mullet);
  // top knot: short sides, a small bun on the crown
  {
    const k = new THREE.IcosahedronGeometry(0.34, 0);
    k.translate(0, 1.22, 0.22);
    add(hairCap(1.05, (x, y, z) => (z < -0.5 ? y > 0.42 : y > -0.2)), CH.A, HX.topknot);
    add(k, CH.A, HX.topknot);
    add(box(-0.14, 0.14, 0.98, 1.06, 0.08, 0.36), CH.shadeA, HX.topknot);
  }
  // facial hair (color B, stubble color C)
  add(sphereCap(1.05, 1, beardKeep), CH.B, HX.beard);
  add(box(-0.27, 0.27, -0.4, -0.3, -0.97, -0.84), CH.B, [HX.beard, HX.mustache]);
  add(box(-0.17, 0.17, -0.85, -0.52, -0.92, -0.72), CH.B, HX.goatee);
  add(sphereCap(1.012, 2, (x, y, z) => beardKeep(x, y, z) && y > -0.98), CH.C, HX.stubble);
  for (const sx of [-1, 1]) add(box(sx * 0.9 - 0.1, sx * 0.9 + 0.1, -0.55, 0.12, -0.32, 0.12), CH.B, HX.chops);
  add(box(-0.3, 0.3, -0.42, -0.3, -0.97, -0.84), CH.B, HX.handlebar);
  for (const sx of [-1, 1]) {
    const c = box(-0.06, 0.06, -0.28, 0, -0.95, -0.86);
    c.rotateZ(sx * 0.5);
    c.translate(sx * 0.36, -0.36, 0);
    add(c, CH.B, HX.handlebar);
  }
  return { hair: merge(parts.hair), hair2: merge(parts.hair2), face: merge(parts.face) };
}

// head wear (headY): small hats, brimmed hats (color A, brims shadeA), glasses (frame B, lenses C), earrings —
// four meshes, so a figure only processes the vertices of what it wears
export function wearGeometry() {
  const parts = { hatS: [], hatW: [], eyes: [], ears: [] };
  const add = (g, chan, bit, t = () => 0.5) => {
    const m = bits(bit);
    parts[m & HAT_S_BITS ? 'hatS' : m & HAT_W_BITS ? 'hatW' : m & EAR_BITS ? 'ears' : 'eyes'].push(prep(g, chan, m, t));
  };
  const crownCyl = (r0, r1, h, y, seg = 10, dent = 0) => {
    const c = new THREE.CylinderGeometry(r0, r1, h, seg);
    if (dent) { const p = c.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setY(i, p.getY(i) - dent * Math.max(0, 1 - Math.abs(p.getX(i)) / r0)); }
    c.translate(0, y, 0);
    return c;
  };
  // baseball cap (+ backwards)
  for (const [bit, back] of [[HY.cap, false], [HY.capback, true]]) {
    const crown = sphereCap(1.14, 1, (x, y) => y > 0.14);
    const brim = box(-0.72, 0.72, 0.25, 0.33, -1.75, -0.75);
    if (back) { crown.rotateY(Math.PI); brim.rotateY(Math.PI); }
    add(crown, CH.A, bit);
    add(brim, CH.shadeA, bit);
  }
  // trucker: coloured front, white mesh back, flat brim
  add(sphereCap(1.15, 1, (x, y, z) => y > 0.14 && z < 0.05), CH.A, HY.trucker);
  add(sphereCap(1.14, 1, (x, y, z) => y > 0.14 && z >= 0.05), CH.white, HY.trucker);
  add(box(-0.75, 0.75, 0.24, 0.31, -1.8, -0.75), CH.A, HY.trucker);
  // beanie: knitted dome with a folded band
  add(sphereCap(1.17, 1, (x, y) => y > -0.02, lumpy(0.05)).translate(0, 0.06, 0), CH.A, HY.beanie);
  add(crownCyl(1.2, 1.2, 0.34, 0.12, 12), CH.shadeA, HY.beanie);
  // sun visor: headband + long front brim
  add(new THREE.CylinderGeometry(1.1, 1.1, 0.22, 12, 1, true).translate(0, 0.42, 0), CH.A, HY.visor);
  add(box(-0.85, 0.85, 0.36, 0.43, -1.95, -0.8), CH.A, HY.visor);
  // bucket hat: crown, sloping brim, band
  add(crownCyl(0.92, 1.1, 0.72, 0.72, 10), CH.A, HY.bucket);
  add(new THREE.CylinderGeometry(1.1, 1.75, 0.36, 12, 1, true).translate(0, 0.25, 0), CH.A, HY.bucket);
  add(crownCyl(1.12, 1.12, 0.12, 0.42, 10), CH.shadeA, HY.bucket);
  // sun hat (wide brim)
  add(crownCyl(0.88, 1.1, 0.7, 0.72, 10), CH.A, HY.sunhat);
  add(crownCyl(2.1, 2.2, 0.07, 0.38, 14), CH.A, HY.sunhat);
  add(crownCyl(1.06, 1.1, 0.16, 0.48, 10), CH.shadeA, HY.sunhat);
  // beret: flat soft disc tilted to one side
  {
    const b = new THREE.IcosahedronGeometry(1.12, 1);
    b.scale(1.08, 0.34, 1.08);
    b.rotateZ(-0.2);
    b.translate(0.12, 0.82, 0.05);
    add(b, CH.A, HY.beret);
    add(box(-0.05, 0.05, 1.1, 1.24, -0.05, 0.05), CH.shadeA, HY.beret);
  }
  // fedora: pinched crown, medium brim; band variants
  add(crownCyl(0.82, 1.04, 0.8, 0.8, 10, 0.18), CH.A, HY.fedora);
  {
    const brim = new THREE.CylinderGeometry(1.72, 1.75, 0.07, 14);
    const p = brim.attributes.position;
    for (let i = 0; i < p.count; i++) { const z = p.getZ(i), x = p.getX(i); p.setY(i, p.getY(i) + (z > 0.6 ? 0.12 * (z - 0.6) : 0) + (Math.abs(x) > 1.2 ? 0.08 : 0)); }
    brim.translate(0, 0.4, 0);
    add(brim, CH.A, HY.fedora);
  }
  add(crownCyl(1.06, 1.06, 0.16, 0.5, 10), CH.shadeA, HY.fedora);
  add(crownCyl(1.075, 1.075, 0.17, 0.5, 10), CH.black, HY.bandBlack);
  add(crownCyl(1.075, 1.075, 0.17, 0.5, 10), CH.gold, HY.bandGold);
  // wide-brim (western-style) hat: tall dented crown, brim curled up at the sides
  add(crownCyl(0.86, 1.06, 0.95, 0.88, 10, 0.25), CH.A, HY.cowboy);
  {
    const brim = new THREE.CylinderGeometry(2.05, 2.1, 0.08, 16);
    const p = brim.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i); p.setY(i, p.getY(i) + 0.22 * Math.max(0, Math.abs(x) - 0.9) ** 1.5); }
    brim.translate(0, 0.4, 0);
    add(brim, CH.A, HY.cowboy);
  }
  add(crownCyl(1.08, 1.08, 0.15, 0.52, 10), CH.shadeA, HY.cowboy);
  // ---- glasses: lenses at z ~ -1.0 (face), frame colour B, lenses C ----
  const temples = (bit, y = 0.16) => {
    add(box(-1.0, -0.94, y - 0.03, y + 0.03, -1.0, 0.15), CH.B, bit);
    add(box(0.94, 1.0, y - 0.03, y + 0.03, -1.0, 0.15), CH.B, bit);
  };
  // classic shades (squarish)
  for (const sx of [-1, 1]) {
    add(box(sx > 0 ? 0.17 : -0.56, sx > 0 ? 0.56 : -0.17, 0.02, 0.24, -1.03, -0.97), CH.lens, HY.shades);
    add(box(sx > 0 ? 0.15 : -0.58, sx > 0 ? 0.58 : -0.15, 0.22, 0.28, -1.04, -0.98), CH.B, HY.shades);
  }
  add(box(-0.17, 0.17, 0.15, 0.21, -1.03, -0.98), CH.B, HY.shades);
  temples(HY.shades, 0.2);
  // round
  for (const sx of [-1, 1]) {
    const l = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8);
    l.rotateX(Math.PI / 2);
    l.translate(sx * 0.36, 0.12, -1.0);
    add(l, CH.lens, HY.round);
    const r = new THREE.CylinderGeometry(0.235, 0.235, 0.03, 8, 1, true);
    r.rotateX(Math.PI / 2);
    r.translate(sx * 0.36, 0.12, -1.01);
    add(r, CH.B, HY.round);
  }
  add(box(-0.16, 0.16, 0.15, 0.19, -1.03, -0.99), CH.B, HY.round);
  temples(HY.round);
  // clear frames (thick rims, pale lenses)
  for (const sx of [-1, 1]) {
    const x0 = sx > 0 ? 0.16 : -0.56, x1 = sx > 0 ? 0.56 : -0.16;
    add(box(x0, x1, 0.0, 0.26, -1.0, -0.97), CH.lens, HY.clear);
    add(box(x0 - 0.03, x1 + 0.03, 0.24, 0.3, -1.04, -0.97), CH.B, HY.clear);
    add(box(x0 - 0.03, x1 + 0.03, -0.03, 0.02, -1.04, -0.97), CH.B, HY.clear);
    add(box(x0 - 0.03, x0 + 0.02, -0.03, 0.3, -1.04, -0.97), CH.B, HY.clear);
    add(box(x1 - 0.02, x1 + 0.03, -0.03, 0.3, -1.04, -0.97), CH.B, HY.clear);
  }
  add(box(-0.16, 0.16, 0.14, 0.2, -1.03, -0.98), CH.B, HY.clear);
  temples(HY.clear, 0.2);
  // aviators: teardrop lenses, double bridge, thin metal frame
  for (const sx of [-1, 1]) {
    const l = new THREE.CylinderGeometry(0.24, 0.24, 0.04, 9);
    l.rotateX(Math.PI / 2);
    const p = l.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setY(i, y > 0 ? y * 0.75 : y * 1.15); p.setX(i, p.getX(i) * (y < 0 ? 1 - 0.25 * (-y / 0.24) * (sx * p.getX(i) < 0 ? 1 : 0.2) : 1)); }
    l.translate(sx * 0.37, 0.09, -1.0);
    add(l, CH.lens, HY.aviator);
  }
  add(box(-0.18, 0.18, 0.23, 0.26, -1.03, -0.99), CH.B, HY.aviator);
  add(box(-0.14, 0.14, 0.15, 0.18, -1.03, -0.99), CH.B, HY.aviator);
  temples(HY.aviator, 0.2);
  // cat-eye: lenses swept up at the outer corners
  for (const sx of [-1, 1]) {
    const l = box(-0.2, 0.2, -0.1, 0.1, -0.02, 0.02);
    l.rotateZ(sx * 0.22);
    l.translate(sx * 0.37, 0.13, -1.0);
    add(l, CH.lens, HY.cateye);
    const f = box(-0.24, 0.26, 0.09, 0.15, -0.025, 0.025);
    f.rotateZ(sx * 0.22);
    f.translate(sx * 0.4, 0.17, -1.01);
    add(f, CH.B, HY.cateye);
  }
  add(box(-0.15, 0.15, 0.13, 0.18, -1.03, -0.99), CH.B, HY.cateye);
  temples(HY.cateye, 0.2);
  // sport shield: one wrap-around lens
  {
    const l = new THREE.CylinderGeometry(1.06, 1.06, 0.3, 14, 1, true, Math.PI - 1.05, 2.1);
    l.translate(0, 0.13, 0);
    add(l, CH.lens, HY.shield);
    add(box(-0.9, 0.9, 0.27, 0.31, -1.03, -0.6), CH.B, HY.shield);
    temples(HY.shield, 0.22);
  }
  // browline: heavy top bar, thin lower rims
  for (const sx of [-1, 1]) {
    const x0 = sx > 0 ? 0.16 : -0.56, x1 = sx > 0 ? 0.56 : -0.16;
    add(box(x0, x1, 0.0, 0.22, -1.0, -0.97), CH.lens, HY.browline);
    add(box(x0 - 0.03, x1 + 0.03, 0.2, 0.3, -1.05, -0.97), CH.B, HY.browline);
    add(box(x0, x1, -0.02, 0.01, -1.02, -0.97), CH.steel, HY.browline);
  }
  add(box(-0.16, 0.16, 0.15, 0.19, -1.03, -0.98), CH.steel, HY.browline);
  temples(HY.browline, 0.22);
  // earrings
  for (const sx of [-1, 1]) {
    const e = new THREE.OctahedronGeometry(0.09, 0);
    e.translate(sx * 1.0, -0.3, 0.05);
    add(e, CH.gold, HY.studs);
    const d = new THREE.OctahedronGeometry(0.11, 0);
    d.translate(sx * 1.0, -0.3, 0.05);
    add(d, CH.gem, HY.diamonds);
    const h = new THREE.TorusGeometry(0.17, 0.03, 3, 10);
    h.rotateY(Math.PI / 2);
    h.translate(sx * 1.02, -0.48, 0.05);
    add(h, CH.gold, HY.hoops);
  }
  return { hatS: merge(parts.hatS), hatW: merge(parts.hatW), eyes: merge(parts.eyes), ears: merge(parts.ears) };
}

// ---------------- chest extras ----------------
export function chestExtrasGeometry() {
  const L = [];
  const add = (g, chan, bit, t = () => 0.5) => L.push(prep(g, chan, bits(bit), t));
  // backpack + straps
  add(box(-0.68, 0.68, -0.98, -0.08, 0.95, 2.25), CH.B, CX.backpack);
  add(box(-0.5, 0.5, -0.6, -0.3, 2.25, 2.45), CH.shadeB, CX.backpack);
  for (const s of [-1, 1]) {
    add(box(s * 0.36 - 0.08, s * 0.36 + 0.08, -0.8, 0.02, -1.0, -0.9), CH.shadeB, CX.backpack);
    add(box(s * 0.36 - 0.08, s * 0.36 + 0.08, -0.02, 0.06, -0.98, 1.0), CH.shadeB, CX.backpack);
  }
  // bust (follows the top's clothing range/pattern: chan body)
  for (const s of [-1, 1]) {
    const b = new THREE.IcosahedronGeometry(1, 0);
    b.scale(0.38, 0.3, 0.32);
    b.translate(s * 0.4, -0.6, -0.78);
    add(b, CH.body, CX.bust, () => 0.5);
  }
  // hood
  {
    const h = box(-0.72, 0.72, -0.3, 0.14, 0.5, 1.12);
    add(h, CH.A, CX.hood);
    add(box(-0.5, 0.5, 0.12, 0.25, 0.55, 1.0), CH.shadeA, CX.hood);
  }
  // collar
  {
    const c = new THREE.CylinderGeometry(0.4, 0.46, 0.16, 8, 1, true);
    c.scale(0.85, 1, 1.2);
    c.translate(0, 0.05, 0.02);
    add(c, CH.A, CX.collar);
  }
  // neck chains (gold, silver, rope, cuban link), medallion pendant, pearls
  const chain = (r, chan, bit, sy = 1, seg = 10) => {
    const c = new THREE.TorusGeometry(0.44, r, 3, seg);
    c.scale(1, 1, sy);
    c.rotateX(Math.PI / 2 - 0.55);
    c.scale(1, 1, 1.5);
    c.translate(0, -0.12, -0.38);
    add(c, chan, bit);
  };
  chain(0.04, CH.gold, CX.chain);
  chain(0.035, CH.steel, CX.silver);
  chain(0.075, CH.gold, CX.rope, 1, 14);
  chain(0.1, CH.gold, CX.cuban, 0.45, 12);
  {
    const m = new THREE.CylinderGeometry(0.17, 0.17, 0.04, 10);
    m.rotateX(Math.PI / 2 - 0.12);
    m.translate(0, -0.55, -1.0);
    add(m, CH.gold, CX.medallion);
    add(box(-0.07, 0.07, -0.6, -0.5, -1.04, -1.0), CH.gem, CX.medallion);
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const b = new THREE.OctahedronGeometry(0.06, 0);
    const x = Math.cos(a) * 0.44, z0 = Math.sin(a) * 0.44;
    const z = z0 * 1.5 * Math.cos(Math.PI / 2 - 0.55), y = -z0 * Math.sin(Math.PI / 2 - 0.55);
    b.translate(x, y - 0.12, z - 0.38);
    add(b, CH.white, CX.pearls);
  }
  // jacket collars: lapels (open jackets) and a ribbed band collar (bombers, track jackets)
  for (const sx of [-1, 1]) {
    const l = box(-0.13, 0.13, -0.62, 0.02, -0.03, 0.03);
    l.rotateZ(sx * -0.42);
    l.rotateY(sx * 0.25);
    l.translate(sx * 0.32, -0.12, -1.0);
    add(l, CH.A, CX.lapels);
  }
  add(new THREE.CylinderGeometry(0.5, 0.56, 0.2, 10, 1, true).scale(0.9, 1, 1.25).translate(0, 0.06, 0.02), CH.shadeA, CX.band);
  // bow tie
  for (const sx of [-1, 1]) {
    const b = new THREE.ConeGeometry(0.11, 0.2, 3);
    b.rotateZ(sx * Math.PI / 2);
    b.translate(sx * 0.1, -0.06, -0.97);
    add(b, CH.black, CX.bowtie);
  }
  add(box(-0.04, 0.04, -0.1, -0.02, -1.0, -0.94), CH.black, CX.bowtie);
  return merge(L);
}

// ---------------- hip extras ----------------
export function hipExtrasGeometry() {
  const L = [];
  const add = (g, chan, bit, t) => L.push(prep(g, chan, bits(bit), t));
  const skirt = (len, r1) => {
    const g = new THREE.CylinderGeometry(1.06, r1, len, 8, 1, true, Math.PI / 8);
    g.translate(0, -0.12 - len / 2, 0);
    return g;
  };
  add(skirt(2.3, 1.55), CH.body, PX.skirt, (x, y) => Math.min(1, (-y - 0.12) / 2.3));
  add(skirt(4.4, 1.85), CH.body, PX.longskirt, (x, y) => Math.min(1, (-y - 0.12) / 4.4));
  add(box(-0.55, 0.55, -0.5, -0.12, -1.42, -0.92), CH.B, PX.beltbag, () => 0.5);
  add(box(-0.62, 0.62, -0.3, -0.22, -1.0, 1.0), CH.shadeB, PX.beltbag, () => 0.5);
  {
    const b = new THREE.CylinderGeometry(1.03, 1.03, 0.12, 8, 1, true, Math.PI / 8);
    b.translate(0, -0.08, 0);
    add(b, CH.black, PX.belt, () => 0.5);
    add(box(-0.14, 0.14, -0.15, -0.01, -1.02, -0.94), CH.steel, PX.belt, () => 0.5);
  }
  return merge(L);
}

// ---------------- hand extras ----------------
export function handExtrasGeometry() {
  const L = [];
  const add = (g, chan, bit) => L.push(prep(g, chan, bits(bit), () => 0.5));
  // phone (thin along x, against the palm)
  add(box(-0.18, 0.18, -1.05, -0.08, -1.6, 1.6), CH.black, AX.phone);
  add(box(-0.22, -0.17, -0.98, -0.18, -1.4, 1.4), CH.screen, AX.phone);
  add(box(0.17, 0.22, -0.98, -0.18, -1.4, 1.4), CH.screen, AX.phone);
  // shopping bag
  add(box(-1.5, 1.5, -3.9, -1.15, -6.5, 6.5), CH.B, AX.bag);
  add(box(-1.55, 1.55, -2.9, -2.3, -3.0, 3.0), CH.white, AX.bag);
  for (const s of [-1, 1]) add(box(-0.12, 0.12, -1.2, -0.3, s * 2.2 - 0.3, s * 2.2 + 0.3), CH.black, AX.bag);
  // briefcase
  add(box(-0.95, 0.95, -3.5, -1.25, -8.5, 8.5), CH.B, AX.briefcase);
  add(box(-0.3, 0.3, -1.3, -0.5, -2.5, 2.5), CH.black, AX.briefcase);
  add(box(-1.0, 1.0, -1.35, -1.2, -6.0, -5.0), CH.steel, AX.briefcase);
  add(box(-1.0, 1.0, -1.35, -1.2, 5.0, 6.0), CH.steel, AX.briefcase);
  // coffee cup
  {
    const c = new THREE.CylinderGeometry(1.0, 0.8, 0.75, 8);
    c.scale(1.1, 1, 1.9);
    c.translate(0, -0.62, -1.3);
    add(c, CH.white, AX.cup);
    const s = new THREE.CylinderGeometry(1.03, 0.92, 0.3, 8);
    s.scale(1.1, 1, 1.9);
    s.translate(0, -0.66, -1.3);
    add(s, CH.B, AX.cup);
  }
  // wrist watches (steel, gold, diamond bezel, digital, smart), bracelet, rings
  add(box(-1.12, 1.12, 0.02, 0.16, -1.25, 1.25), CH.steel, AX.watch);
  add(box(-1.2, -1.1, 0.0, 0.18, -0.9, 0.9), CH.black, AX.watch);
  add(box(-1.12, 1.12, 0.02, 0.16, -1.25, 1.25), CH.gold, [AX.watchGold, AX.watchDiamond]);
  add(box(-1.2, -1.1, 0.0, 0.18, -0.9, 0.9), CH.black, AX.watchGold);
  add(box(-1.24, -1.1, -0.03, 0.21, -1.0, 1.0), CH.gem, AX.watchDiamond);
  add(box(-1.12, 1.12, 0.02, 0.16, -1.25, 1.25), CH.black, [AX.digital, AX.smart]);
  add(box(-1.22, -1.1, 0.0, 0.18, -0.85, 0.85), CH.screen, AX.digital);
  add(box(-1.25, -1.1, -0.04, 0.22, -1.05, 1.05), CH.screen, AX.smart);
  add(box(-1.18, 1.18, 0.0, 0.1, -1.3, 1.3), CH.gold, AX.bracelet);
  add(box(-0.35, 0.35, -0.82, -0.72, -1.12, -0.9), CH.gold, AX.rings);
  add(box(-0.35, 0.35, -0.82, -0.72, -0.45, -0.25), CH.gold, AX.rings);
  return merge(L);
}

// ---------------- mid LOD (25..70 m): boxy limbs, 8-sided head, no hands or face details ----------------
export function prism4Geometry() {
  const g = new THREE.CylinderGeometry(1.25, 1.25, 1, 4, 1, false, Math.PI / 4);
  g.translate(0, -0.5, 0);
  return prep(g, CH.body);
}

export function head8Geometry() {
  const g = new THREE.CylinderGeometry(0.86, 0.72, 1.95, 8, 1, false, Math.PI / 8);
  return prep(g, CH.body, -1, () => 0.5);
}

export const MID_HEAD_BITS = HAIR_BITS | HAIR2_BITS | bits(HX.beard);
export function hairMidGeometry() {
  const L = [];
  const add = (g, chan, b) => L.push(prep(g, chan, bits(b), () => 0.5));
  const capped = [HX.buzz, HX.short, HX.long, HX.ponytail, HX.bun, HX.mohawk, HX.curly, HX.bob, HX.sidepart,
    HX.slick, HX.pompadour, HX.locs, HX.cornrows, HX.spiky, HX.mullet, HX.topknot];
  const cap = new THREE.CylinderGeometry(0.95, 1.08, 0.8, 8, 1, false, Math.PI / 8);
  cap.translate(0, 0.6, 0.04);
  add(cap, CH.A, capped);
  add(box(-0.95, 0.95, -1.9, 0.3, 0.35, 1.08), CH.A, HX.long);
  add(box(-1.0, 1.0, -1.4, 0.3, 0.3, 1.1), CH.A, HX.locs);
  add(box(-0.72, 0.72, -1.5, 0.2, 0.45, 1.05), CH.A, HX.mullet);
  add(box(-1.12, 1.12, -0.85, 0.3, -0.4, 0.7), CH.A, HX.bob);
  add(box(-0.18, 0.18, -1.3, 0.3, 0.95, 1.4), CH.A, HX.ponytail);
  const bun = new THREE.OctahedronGeometry(0.42, 0);
  bun.translate(0, 0.95, 0.6);
  add(bun, CH.A, HX.bun);
  const knot = new THREE.OctahedronGeometry(0.32, 0);
  knot.translate(0, 1.2, 0.2);
  add(knot, CH.A, HX.topknot);
  add(box(-0.75, 0.75, 0.7, 1.35, -1.0, -0.1), CH.A, HX.pompadour);
  add(box(-0.7, 0.7, 0.8, 1.45, -0.6, 0.6), CH.A, HX.spiky);
  const afro = new THREE.CylinderGeometry(1.2, 1.4, 1.5, 8, 1, false, Math.PI / 8);
  afro.translate(0, 0.55, 0.12);
  add(afro, CH.A, HX.afro);
  add(box(-0.12, 0.12, 0.6, 1.4, -0.8, 0.95), CH.A, HX.mohawk);
  add(box(-0.62, 0.62, -1.0, -0.35, -0.9, -0.4), CH.B, HX.beard);
  return merge(L);
}

// mid LOD hats (from headY)
export const MID_HAT_BITS = HAT_BITS;
export function hatMidGeometry() {
  const L = [];
  const add = (g, chan, b) => L.push(prep(g, chan, bits(b), () => 0.5));
  const cyl = (r0, r1, h, y) => new THREE.CylinderGeometry(r0, r1, h, 8, 1, false, Math.PI / 8).translate(0, y, 0);
  add(cyl(0.98, 1.1, 0.7, 0.62), CH.A, [HY.cap, HY.capback, HY.trucker, HY.beanie, HY.bucket, HY.sunhat, HY.fedora, HY.cowboy]);
  add(box(-0.72, 0.72, 0.25, 0.33, -1.75, -0.75), CH.shadeA, [HY.cap, HY.trucker, HY.visor]);
  add(box(-0.72, 0.72, 0.25, 0.33, 0.75, 1.75), CH.shadeA, HY.capback);
  add(cyl(1.1, 1.7, 0.3, 0.25), CH.A, HY.bucket);
  add(cyl(2.1, 2.2, 0.08, 0.38), CH.A, [HY.sunhat, HY.cowboy]);
  add(cyl(1.7, 1.75, 0.08, 0.4), CH.A, HY.fedora);
  add(new THREE.CylinderGeometry(1.15, 1.15, 0.35, 8).scale(1, 1, 1).translate(0.1, 0.85, 0), CH.A, HY.beret);
  add(cyl(1.1, 1.1, 0.2, 0.42), CH.A, HY.visor);
  return merge(L);
}

export const MID_CHEST_BITS = bits([CX.backpack, CX.bust, CX.hood]);
export function chestMidGeometry() {
  const L = [];
  const add = (g, chan, b) => L.push(prep(g, chan, bits(b), () => 0.5));
  add(box(-0.68, 0.68, -0.98, -0.08, 0.95, 2.25), CH.B, CX.backpack);
  add(box(-0.78, 0.78, -0.86, -0.36, -1.08, -0.7), CH.body, CX.bust);
  add(box(-0.72, 0.72, -0.3, 0.14, 0.5, 1.12), CH.A, CX.hood);
  return merge(L);
}

export const MID_HIP_BITS = bits([PX.skirt, PX.longskirt]);
export function hipMidGeometry() {
  const L = [];
  const skirt = (len, r1, b) => {
    const g = new THREE.CylinderGeometry(1.15, r1, len, 4, 1, true, Math.PI / 4);
    g.translate(0, -0.12 - len / 2, 0);
    L.push(prep(g, CH.body, bits(b), (x, y) => Math.min(1, (-y - 0.12) / len)));
  };
  skirt(2.3, 1.7, PX.skirt);
  skirt(4.4, 2.0, PX.longskirt);
  return merge(L);
}

export const MID_HAND_BITS = bits([AX.bag, AX.briefcase]);
export function handMidGeometry() {
  const L = [];
  L.push(prep(box(-1.5, 1.5, -3.9, -1.15, -6.5, 6.5), CH.B, bits(AX.bag), () => 0.5));
  L.push(prep(box(-0.95, 0.95, -3.5, -1.25, -8.5, 8.5), CH.B, bits(AX.briefcase), () => 0.5));
  return merge(L);
}

// ---------------- far LOD: whole figure in one mesh, unit height ----------------
// aLimb: 0 static, 1 left leg, 2 right leg, 3 left arm, 4 right arm. aChan: 1 top, 2 bottom, 3 skin, 4 hair
export function farGeometry() {
  const L = [];
  const add = (g, chan, limb) => {
    const p = prep(g, chan, -1, () => 0);
    const n = p.attributes.position.count;
    p.setAttribute('aLimb', new THREE.BufferAttribute(new Float32Array(n).fill(limb), 1));
    L.push(p);
  };
  add(box(-0.105, -0.01, 0.0, 0.53, -0.055, 0.055), 2, 1);
  add(box(0.01, 0.105, 0.0, 0.53, -0.055, 0.055), 2, 2);
  add(box(-0.11, 0.11, 0.5, 0.58, -0.07, 0.07), 2, 0);
  add(box(-0.13, 0.13, 0.57, 0.82, -0.075, 0.075), 1, 0);
  add(box(-0.18, -0.13, 0.47, 0.81, -0.04, 0.04), 1, 3);
  add(box(0.13, 0.18, 0.47, 0.81, -0.04, 0.04), 1, 4);
  add(box(-0.025, 0.025, 0.81, 0.86, -0.025, 0.025), 3, 0);
  add(box(-0.06, 0.06, 0.85, 0.98, -0.07, 0.06), 3, 0);
  add(box(-0.065, 0.065, 0.94, 1.0, -0.06, 0.075), 4, 0);
  return merge(L);
}
