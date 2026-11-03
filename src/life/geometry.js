import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Low-poly prop geometry kit. Every part becomes non-indexed with attributes:
// position, normal, color (linear), aTint (0..1: how much of the instance colour applies), aEmit (night emission rgb)
// and optionally uv. All geometries are built once at init.

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function lin(hex) { _c.set(hex); return [_c.r, _c.g, _c.b]; }

export class Kit {
  constructor({ uv = false } = {}) { this.parts = []; this.uv = uv; }

  // o: { x,y,z, rx,ry,rz, tint, emit:[r,g,b]|hex, face:(tri)=>{color,tint,emit} }
  push(geo, color, o = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    geo !== g && geo.dispose();
    _e.set(o.rx || 0, o.ry || 0, o.rz || 0, 'XYZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(o.x || 0, o.y || 0, o.z || 0), _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3), tint = new Float32Array(n), emit = new Float32Array(n * 3);
    const base = lin(color);
    const em = o.emit === undefined || o.emit === null ? [0, 0, 0] : Array.isArray(o.emit) ? o.emit : lin(o.emit);
    for (let i = 0; i < n; i++) {
      let c = base, t = o.tint || 0, e = em;
      if (o.face) {
        const f = o.face(Math.floor(i / 3));
        if (f) { if (f.color !== undefined) c = lin(f.color); if (f.tint !== undefined) t = f.tint; if (f.emit) e = f.emit; }
      }
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      tint[i] = t;
      emit[i * 3] = e[0]; emit[i * 3 + 1] = e[1]; emit[i * 3 + 2] = e[2];
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
    g.setAttribute('aEmit', new THREE.BufferAttribute(emit, 3));
    if (this.uv) { if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2)); } else if (g.attributes.uv) g.deleteAttribute('uv');
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'aTint', 'aEmit', 'uv'].includes(k)) g.deleteAttribute(k);
    if (o.flip) flip(g);
    this.parts.push(g);
    return this;
  }

  box(w, h, d, color, o) { return this.push(new THREE.BoxGeometry(w, h, d), color, o); }
  cyl(rTop, rBot, h, seg, color, o = {}) { return this.push(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, !!o.open), color, o); }
  cone(r, h, seg, color, o = {}) { return this.push(new THREE.ConeGeometry(r, h, seg, 1, !!o.open), color, o); }

  build() {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// reverse triangle winding (undersides of canopies)
function flip(g) {
  const p = g.attributes.position.array, nm = g.attributes.normal?.array;
  const swap = (a, i, j) => { for (let k = 0; k < 3; k++) { const t = a[i + k]; a[i + k] = a[j + k]; a[j + k] = t; } };
  for (let t = 0; t < p.length; t += 9) { swap(p, t + 3, t + 6); if (nm) swap(nm, t + 3, t + 6); }
  if (nm) for (let i = 0; i < nm.length; i++) nm[i] = -nm[i];
}

// palette (sRGB)
const C = {
  white: 0xf4f1ea, offwhite: 0xe8e2d6, grey: 0x8b9096, darkgrey: 0x3a3d42, steel: 0x6f757c, black: 0x1c1d20,
  wood: 0x9c7451, darkwood: 0x6b4b33, plank: 0xb08a62, straw: 0xc9a25e, strawDark: 0x8f6e3c, sand: 0xe6d6a8,
  glass: 0x6d93a8, red: 0xd8392f, orange: 0xff7a2f, chrome: 0xc9ccd1, teak: 0xa87a4f, navy: 0x1f3550,
};
const WARM = [1.0, 0.72, 0.38];
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

// ---------------------------------------------------------------- beach
export function umbrellaGeo() {
  const k = new Kit();
  k.cyl(0.035, 0.035, 2.5, 5, C.white, { y: 1.25 });
  const stripes = (tri) => (Math.floor(tri / 2) % 2 ? { color: C.white, tint: 0 } : { color: 0xffffff, tint: 1 });
  k.cone(1.35, 0.55, 8, 0xffffff, { y: 2.42, open: true, face: stripes });
  k.cone(1.33, 0.52, 8, 0xffffff, { y: 2.40, open: true, face: stripes, flip: true });
  k.cyl(0.06, 0.02, 0.18, 5, C.white, { y: 2.78 });
  return k.build();
}

export function loungerGeo() {
  const k = new Kit();
  // frame along z (head at -z), cushion tinted
  k.box(0.66, 0.08, 1.35, C.white, { y: 0.34, z: 0.25 });
  k.box(0.6, 0.06, 1.3, 0xffffff, { y: 0.4, z: 0.25, tint: 1 });
  // backrest rises from the head end of the seat, leaning back (-z end up)
  k.box(0.66, 0.07, 0.75, C.white, { y: 0.62, z: -0.67, rx: 0.75 });
  k.box(0.6, 0.05, 0.7, 0xffffff, { y: 0.67, z: -0.63, rx: 0.75, tint: 1 });
  for (const [x, z] of [[-0.28, 0.85], [0.28, 0.85], [-0.28, -0.35], [0.28, -0.35]]) k.box(0.05, 0.32, 0.05, C.white, { x, y: 0.16, z });
  return k.build();
}

// art-deco lifeguard tower; front (+z) faces the sea; cabin colour = instance colour
export function towerGeo() {
  const k = new Kit();
  for (const [x, z] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) k.box(0.2, 2.5, 0.2, C.offwhite, { x, y: 1.25, z });
  k.box(1.2 * 2 + 0.2, 0.12, 0.12, C.offwhite, { y: 0.9, z: 1.2 });
  k.box(1.2 * 2 + 0.2, 0.12, 0.12, C.offwhite, { y: 0.9, z: -1.2 });
  k.box(3.5, 0.22, 3.8, C.plank, { y: 2.55 });
  k.box(2.6, 2.1, 2.4, 0xffffff, { y: 3.72, tint: 1 });
  k.box(2.64, 0.28, 2.44, C.white, { y: 3.18 });
  k.box(2.64, 0.12, 2.44, C.white, { y: 4.05 });
  k.box(1.9, 0.75, 0.06, C.glass, { y: 4.15, z: 1.22, emit: scale3(WARM, 0.35) });
  k.box(0.06, 0.6, 1.2, C.glass, { x: 1.31, y: 4.1, z: 0.3, emit: scale3(WARM, 0.25) });
  k.box(0.06, 0.6, 1.2, C.glass, { x: -1.31, y: 4.1, z: 0.3, emit: scale3(WARM, 0.25) });
  k.box(3.1, 0.22, 3.0, C.white, { y: 4.9 });
  k.cyl(0.7, 0.7, 0.55, 8, 0xffffff, { y: 5.28, z: 0.2, tint: 1 });
  k.box(1.6, 0.12, 0.08, C.white, { y: 5.62, z: 0.2 });
  // railing around the platform front + sides
  k.box(3.5, 0.06, 0.06, C.white, { y: 3.55, z: 1.88 });
  k.box(0.06, 0.06, 3.8, C.white, { x: 1.73, y: 3.55 });
  k.box(0.06, 0.06, 3.8, C.white, { x: -1.73, y: 3.55 });
  for (const x of [-1.73, 0, 1.73]) k.box(0.06, 1.0, 0.06, C.white, { x, y: 3.1, z: 1.88 });
  // ramp down the back
  k.box(1.0, 0.12, 4.1, C.plank, { y: 1.28, z: -3.4, rx: -0.66 });
  // flag + life ring
  k.cyl(0.04, 0.04, 2.2, 4, C.white, { x: 1.45, y: 6.0, z: -1.0 });
  // lifeguard flag: red over yellow halves
  k.box(0.9, 0.28, 0.03, C.red, { x: 1.92, y: 6.89, z: -1.0 });
  k.box(0.9, 0.28, 0.03, 0xffd23a, { x: 1.92, y: 6.61, z: -1.0 });
  k.push(new THREE.TorusGeometry(0.32, 0.08, 4, 10), C.orange, { x: 1.36, y: 3.9, z: 0.6, ry: Math.PI / 2 });
  return k.build();
}

export function netGeo() {
  const k = new Kit();
  for (const x of [-4.6, 4.6]) k.cyl(0.06, 0.06, 2.6, 5, C.white, { x, y: 1.3 });
  k.box(9.1, 0.9, 0.025, 0xdedede, { y: 2.0 });
  k.box(9.1, 0.07, 0.04, C.white, { y: 2.48 });
  const L = (w, d, x, z) => k.box(w, 0.02, d, C.white, { x, y: 0.03, z });
  L(8, 0.07, 0, 8); L(8, 0.07, 0, -8); L(0.07, 16, 4, 0); L(0.07, 16, -4, 0);
  return k.build();
}

export function hutGeo() {
  const k = new Kit();
  for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) k.cyl(0.1, 0.12, 2.55, 5, C.darkwood, { x, y: 1.27, z });
  k.cone(2.9, 1.7, 7, C.straw, { y: 3.3, open: true, face: (t) => ({ color: Math.floor(t / 2) % 2 ? C.straw : 0xbd9452 }) });
  k.cone(2.86, 1.66, 7, C.strawDark, { y: 3.26, open: true, flip: true });
  k.cone(0.35, 0.45, 5, C.strawDark, { y: 4.3 });
  k.cyl(0.65, 0.65, 0.07, 8, C.wood, { y: 0.78 });
  k.cyl(0.07, 0.07, 0.75, 4, C.darkwood, { y: 0.38 });
  return k.build();
}

// beach bar kiosk; serving side (+z) faces the sea; walls = instance colour
export function kioskGeo() {
  const k = new Kit();
  k.box(4.0, 2.6, 3.0, 0xffffff, { y: 1.3, tint: 1 });
  k.box(3.3, 1.05, 0.06, 0x3b2a1f, { y: 1.75, z: 1.51, emit: scale3(WARM, 0.55) });
  k.box(4.3, 0.12, 0.62, C.wood, { y: 1.18, z: 1.78 });
  k.box(4.4, 0.2, 3.4, C.white, { y: 2.7 });
  for (let i = 0; i < 6; i++) {
    const x = -1.875 + i * 0.75;
    k.box(0.75, 0.06, 1.2, i % 2 ? C.white : 0xffffff, { x, y: 2.45, z: 2.05, rx: 0.42, tint: i % 2 ? 0 : 1 });
  }
  k.box(3.0, 0.7, 0.12, 0xffd9ec, { y: 3.2, z: 1.2, emit: [1.1, 0.12, 0.5] });
  k.box(3.1, 0.06, 0.13, 0x29f0e0, { y: 2.83, z: 1.21, emit: [0.1, 1.0, 0.95] });
  for (const x of [-1.2, 0, 1.2]) {
    k.cyl(0.2, 0.2, 0.08, 6, C.red, { x, y: 0.82, z: 2.35 });
    k.cyl(0.04, 0.04, 0.8, 4, C.chrome, { x, y: 0.4, z: 2.35 });
  }
  return k.build();
}

// ---------------------------------------------------------------- piers (deck top at local y = 0)
export function pierModuleGeo() {
  const k = new Kit();
  const shades = [C.plank, 0xa47f58, 0xb8936a, 0x9a764f];
  for (let i = 0; i < 6; i++) k.box(4.0, 0.14, 0.92, shades[i % 4], { y: -0.07, z: -2.5 + i });
  k.box(0.22, 0.3, 6.0, C.darkwood, { x: 1.6, y: -0.3 });
  k.box(0.22, 0.3, 6.0, C.darkwood, { x: -1.6, y: -0.3 });
  for (const x of [-1.75, 1.75]) for (const z of [-2.9, 2.9]) k.cyl(0.16, 0.18, 7.0, 6, C.darkwood, { x, y: -3.5, z });
  for (const x of [-1.95, 1.95]) {
    k.box(0.07, 0.07, 6.0, C.white, { x, y: 1.0 });
    k.box(0.05, 0.05, 6.0, C.white, { x, y: 0.55 });
    k.box(0.08, 1.05, 0.08, C.white, { x, y: 0.5, z: -2.9 });
  }
  return k.build();
}

// ramp from the sand up to the deck: top end at z = +4 (y = 0), bottom end at z = -4 (y = -1.6)
export function pierRampGeo() {
  const k = new Kit();
  k.box(4.0, 0.16, 8.16, C.plank, { y: -0.8, rx: -0.197 });
  for (const x of [-1.95, 1.95]) k.box(0.07, 0.07, 8.16, C.white, { x, y: 0.2, rx: -0.197 });
  for (const x of [-1.95, 1.95]) for (const z of [-3.9, 0, 3.9]) k.box(0.08, 1.0, 0.08, C.white, { x, y: -0.8 + z * 0.2 + 0.4, z });
  return k.build();
}

// T-head at the end of a pier: 14 x 10 deck, bait shack, two lamps
export function pierEndGeo() {
  const k = new Kit();
  for (let i = 0; i < 10; i++) k.box(14, 0.14, 0.92, i % 2 ? C.plank : 0xa98560, { y: -0.07, z: -4.5 + i });
  for (const x of [-6.8, -2.3, 2.3, 6.8]) for (const z of [-4.8, 4.8]) k.cyl(0.18, 0.2, 7.0, 6, C.darkwood, { x, y: -3.5, z });
  for (const z of [-4.95, 4.95]) { k.box(14, 0.07, 0.07, C.white, { y: 1.0, z }); k.box(14, 0.05, 0.05, C.white, { y: 0.55, z }); }
  for (const x of [-6.95, 6.95]) { k.box(0.07, 0.07, 10, C.white, { x, y: 1.0 }); k.box(0.05, 0.05, 10, C.white, { x, y: 0.55 }); }
  k.box(3.2, 2.5, 2.6, 0xffffff, { x: -4.5, y: 1.25, z: -2.5, tint: 1 });
  k.box(3.6, 0.18, 3.0, C.white, { x: -4.5, y: 2.6, z: -2.5 });
  k.box(1.6, 0.8, 0.05, 0x3b2a1f, { x: -4.5, y: 1.6, z: -1.18, emit: scale3(WARM, 0.8) });
  for (const x of [-6.6, 6.6]) {
    k.cyl(0.06, 0.08, 4.2, 5, C.darkgrey, { x, y: 2.1, z: 4.6 });
    k.box(0.4, 0.3, 0.4, 0xfff2d0, { x, y: 4.25, z: 4.6, emit: [2.2, 1.7, 1.0] });
  }
  for (const x of [1, 4]) { k.box(1.8, 0.08, 0.5, C.wood, { x, y: 0.45, z: 4.0 }); k.box(1.8, 0.45, 0.08, C.wood, { x, y: 0.7, z: 4.3 }); }
  return k.build();
}

// ---------------------------------------------------------------- boats (waterline at y = 0, bow towards +z)
function hull(w, h, len, bowTaper = 0.08) {
  const g = new THREE.BoxGeometry(w, h, len, 1, 1, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i);
    const z = p.getZ(i);
    if (y < 0) x *= 0.45; // V hull
    if (z > len * 0.49) { x *= bowTaper; if (y < 0) y += h * 0.35; }
    else if (z > -0.01 && z < 0.01) x *= 0.96;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

export function yachtGeo() {
  const k = new Kit();
  k.push(hull(4.4, 2.2, 15), C.white, { y: 0.0 });
  k.box(4.0, 0.16, 11.5, 0xffffff, { y: 0.55, z: -0.8, tint: 1 });
  k.box(3.7, 0.1, 3.2, C.teak, { y: 1.12, z: -5.6 });
  k.box(3.2, 1.35, 6.4, C.white, { y: 1.75, z: -1.4 });
  k.box(3.26, 0.5, 5.6, 0x1e3448, { y: 1.85, z: -1.2, emit: scale3(WARM, 0.55) });
  k.box(2.6, 0.85, 3.4, C.white, { y: 2.85, z: -2.2 });
  k.box(2.5, 0.45, 0.06, 0x1e3448, { y: 3.0, z: -0.48, rx: -0.5 });
  k.cyl(0.05, 0.05, 1.6, 4, C.chrome, { y: 4.0, z: -2.6 });
  k.box(1.0, 0.12, 0.12, C.chrome, { y: 4.6, z: -2.6 });
  k.box(0.12, 0.12, 0.12, 0xff3030, { x: -1.7, y: 1.3, z: 3.0, emit: [1.8, 0.1, 0.1] });
  k.box(0.12, 0.12, 0.12, 0x30ff60, { x: 1.7, y: 1.3, z: 3.0, emit: [0.1, 1.8, 0.3] });
  return k.build();
}

export function sailboatGeo() {
  const k = new Kit();
  k.push(hull(3.2, 1.7, 11, 0.06), C.white, { y: 0.0 });
  k.box(2.9, 0.12, 8.5, 0xffffff, { y: 0.4, z: -0.5, tint: 1 });
  k.box(2.0, 0.7, 3.4, C.white, { y: 1.15, z: -0.6 });
  k.box(2.05, 0.25, 3.0, 0x1e3448, { y: 1.2, z: -0.5, emit: scale3(WARM, 0.4) });
  k.cyl(0.08, 0.1, 14, 5, C.chrome, { y: 7.8, z: 1.2 });
  k.box(0.1, 0.1, 5.0, C.chrome, { y: 2.2, z: -1.3 });
  k.cyl(0.2, 0.2, 4.6, 6, 0xffffff, { y: 2.42, z: -1.3, rx: Math.PI / 2, tint: 1 });
  k.box(0.18, 0.18, 0.18, 0xffffff, { y: 14.8, z: 1.2, emit: [2.2, 2.2, 2.0] });
  return k.build();
}

export function buoyGeo() {
  const k = new Kit();
  k.cyl(0.42, 0.5, 1.0, 7, 0xffffff, { y: 0.1, tint: 1 });
  k.cyl(0.43, 0.43, 0.18, 7, C.white, { y: 0.35 });
  k.cone(0.32, 0.6, 6, 0xffffff, { y: 0.9, tint: 1 });
  k.box(0.14, 0.18, 0.14, 0xfff0c0, { y: 1.27, emit: [1.8, 1.3, 0.5] });
  return k.build();
}

// ---------------------------------------------------------------- signage
// highway monopole billboard: board centre at y = 13.7 (faces are separate geometry)
export const BOARD = { w: 14, h: 4.9, cyTall: 13.7, cyRoof: 6.6, depth: 0.62 };
export function billboardFrameGeo(roof = false) {
  const k = new Kit();
  const cy = roof ? BOARD.cyRoof : BOARD.cyTall;
  const bottom = cy - 2.7;
  if (roof) {
    for (const x of [-5.2, 0, 5.2]) {
      k.box(0.3, bottom + 2, 0.3, C.steel, { x, y: (bottom - 2) / 2, z: -0.8 });
      k.box(0.24, 0.24, 3.2, C.steel, { x, y: bottom * 0.45, z: -0.6, rx: -0.85 });
    }
    k.box(14.4, 0.25, 0.25, C.steel, { y: bottom * 0.5, z: -0.8 });
  } else {
    k.cyl(0.55, 0.65, bottom + 0.3, 8, C.steel, { y: (bottom + 0.3) / 2 });
    k.box(4.0, 0.5, 0.5, C.steel, { y: bottom - 0.2 });
  }
  k.box(BOARD.w + 0.6, BOARD.h + 0.5, BOARD.depth, C.darkgrey, { y: cy });
  for (const z of [-1.0, 1.0]) {
    k.box(BOARD.w + 0.6, 0.08, 1.0, 0x55585c, { y: bottom - 0.05, z });
    k.box(BOARD.w + 0.6, 0.05, 0.05, C.steel, { y: bottom + 0.8, z: z * 1.45 });
  }
  for (const z of [-1.4, 1.4]) for (const x of [-5.25, -1.75, 1.75, 5.25]) {
    k.box(0.08, 0.08, 0.9, C.darkgrey, { x, y: bottom + 0.15, z: z * 0.8 });
    k.box(0.45, 0.22, 0.35, 0x2a2c30, { x, y: bottom + 0.25, z, rx: z > 0 ? -0.6 : 0.6, emit: [2.4, 2.2, 1.8] });
  }
  return k.build();
}

export function billboardFaceGeo() {
  return new THREE.PlaneGeometry(BOARD.w, BOARD.h);
}

// neon blade sign: plane 1.5 x 5.6 (letters stacked vertically), the backing box is part of signBackGeo
export const BLADE = { w: 1.5, h: 5.6 };
export function bladeBackGeo() {
  const k = new Kit();
  k.box(0.35, BLADE.h + 0.5, BLADE.w + 0.4, C.darkgrey, {});
  // brackets back to the wall (local -z; the sign centre sits 1.2 m in front of the facade)
  k.box(0.12, 0.12, 0.5, C.steel, { y: BLADE.h / 2 - 0.2, z: -1.05 });
  k.box(0.12, 0.12, 0.5, C.steel, { y: -BLADE.h / 2 + 0.2, z: -1.05 });
  return k.build();
}
export function bladeFaceGeo() {
  // two faces (both sides of the blade), plane in the YZ plane facing +x / -x
  const a = new THREE.PlaneGeometry(BLADE.w, BLADE.h); a.rotateY(Math.PI / 2); a.translate(0.19, 0, 0);
  const b = new THREE.PlaneGeometry(BLADE.w, BLADE.h); b.rotateY(-Math.PI / 2); b.translate(-0.19, 0, 0);
  return mergeGeometries([a, b], false);
}

// neon band: unit length along x (scaled per instance), 1 m tall (scaled by sy), 0.3 m deep
export function neonStripGeo() {
  return new THREE.BoxGeometry(1, 1, 0.3);
}

// ---------------------------------------------------------------- speed camera (+x = towards the road, +z = facing traffic)
export function speedCamGeo() {
  const k = new Kit();
  k.cyl(0.13, 0.16, 6.2, 6, C.steel, { y: 3.1 });
  k.box(2.4, 0.16, 0.16, C.steel, { x: 1.1, y: 6.05 });
  k.box(0.65, 0.55, 1.0, C.darkgrey, { x: 2.1, y: 5.75 });
  k.box(0.67, 0.12, 1.02, 0xffd23a, { x: 2.1, y: 5.98 });
  k.box(0.9, 1.25, 0.06, C.white, { y: 3.2, z: 0.18 });
  k.box(0.72, 0.18, 0.065, C.red, { y: 3.65, z: 0.18 });
  return k.build();
}
export function flashGeo() {
  return new THREE.BoxGeometry(0.42, 0.3, 0.08).translate(2.1, 5.72, 0.53);
}

// ---------------------------------------------------------------- race & collectibles
export function ringGeo() {
  return new THREE.TorusGeometry(1, 0.055, 6, 44);
}

// glowing corona cylinder (y 0..1); vertex colours fade towards the top (used additively)
export function coronaGeo() {
  const g = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true);
  g.translate(0, 0.5, 0);
  return g;
}

export function postcardGeo() {
  const g = new THREE.BoxGeometry(1.2, 0.8, 0.035);
  // faces: px nx py ny pz nz (4 verts each); pz = picture (left half), nz = back (right half), edges = white corner
  const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      const u0 = uv.getX(i), v0 = uv.getY(i);
      if (f === 4) uv.setXY(i, u0 * 0.5, v0);
      else if (f === 5) uv.setXY(i, 0.5 + u0 * 0.5, v0);
      else uv.setXY(i, 0.999, 0.999);
    }
  }
  return g;
}

// bird: forward = +z, wings along x. aWing = side (-1/0/+1), aSpan = 0 at the root .. 1 at the tip
export function birdGeo() {
  const pos = [], col = [], wing = [], span = [];
  const W = [1, 1, 1], G = [0.62, 0.64, 0.68], D = [0.18, 0.18, 0.2];
  const tri = (a, b, c, ca, cb, cc, s) => {
    for (const [p, cl] of [[a, ca], [b, cb], [c, cc]]) {
      pos.push(...p); col.push(...cl);
      wing.push(s === 0 ? 0 : Math.sign(p[0]) || s);
      span.push(Math.min(1, Math.abs(p[0]) / 0.85));
    }
  };
  const nose = [0, 0, 0.36], tail = [0, 0.02, -0.3], top = [0, 0.08, 0.02], bot = [0, -0.07, 0.04], l = [-0.08, 0, 0.06], r = [0.08, 0, 0.06];
  tri(nose, l, top, W, W, W, 0); tri(nose, top, r, W, W, W, 0); tri(nose, bot, l, W, W, W, 0); tri(nose, r, bot, W, W, W, 0);
  tri(tail, top, l, W, W, W, 0); tri(tail, r, top, W, W, W, 0); tri(tail, l, bot, W, W, W, 0); tri(tail, bot, r, W, W, W, 0);
  // tail fan
  tri([0, 0.02, -0.24], [-0.1, 0.02, -0.42], [0.1, 0.02, -0.42], W, G, G, 0);
  for (const s of [-1, 1]) {
    const rf = [s * 0.06, 0.01, 0.12], rb = [s * 0.06, 0.01, -0.1], mf = [s * 0.46, 0.0, 0.07], mb = [s * 0.46, 0.0, -0.13], tip = [s * 0.86, 0.0, -0.16];
    if (s < 0) { tri(rf, mb, mf, W, G, G, s); tri(rf, rb, mb, W, W, G, s); tri(mf, mb, tip, G, G, D, s); }
    else { tri(rf, mf, mb, W, G, G, s); tri(rf, mb, rb, W, G, W, s); tri(mf, tip, mb, G, D, G, s); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col.map((v) => v), 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.setAttribute('aSpan', new THREE.Float32BufferAttribute(span, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export { C as PALETTE };
