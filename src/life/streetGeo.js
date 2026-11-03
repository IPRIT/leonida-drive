import * as THREE from 'three';
import { Kit } from './geometry.js';

// Original low-poly street furniture. Local frame: origin on the sidewalk top, +y up, +z = facing the road
// (benches, shelters and boxes face the street). Instance colour applies where aTint = 1.

const C = {
  steel: 0x6f757c, dark: 0x2c2f35, black: 0x1c1d20, white: 0xf1efe9, concrete: 0xbab5ab, wood: 0xa8774c,
  woodDark: 0x7d5534, glass: 0x9cc7d6, green: 0x3f7a35, leaf: 0x4f9a3a, leafDark: 0x3b7d2c, trunk: 0x8a6a45, soil: 0x5a4330,
};
const WARM = [1.0, 0.75, 0.42];

// trash bin (tint = body colour)
export function binGeo() {
  const k = new Kit();
  k.cyl(0.3, 0.27, 0.86, 8, 0xffffff, { y: 0.43, tint: 1 });
  k.cyl(0.32, 0.32, 0.08, 8, C.dark, { y: 0.9 });
  k.cyl(0.24, 0.3, 0.12, 8, 0xffffff, { y: 1.0, tint: 1 });
  k.box(0.3, 0.06, 0.04, C.black, { y: 0.98, z: 0.25 });
  k.box(0.62, 0.04, 0.04, C.white, { y: 0.55, z: 0.0 }); // band
  return k.build();
}

// bench facing +z (the road)
export function benchGeo() {
  const k = new Kit();
  for (let i = 0; i < 3; i++) k.box(1.8, 0.05, 0.13, i % 2 ? C.wood : C.woodDark, { y: 0.46, z: -0.16 + i * 0.16 });
  for (let i = 0; i < 2; i++) k.box(1.8, 0.12, 0.04, i % 2 ? C.wood : C.woodDark, { y: 0.66 + i * 0.17, z: -0.3, rx: -0.18 });
  for (const x of [-0.75, 0.75]) {
    k.box(0.06, 0.46, 0.06, 0xffffff, { x, y: 0.23, z: 0.14, tint: 1 });
    k.box(0.06, 0.9, 0.06, 0xffffff, { x, y: 0.45, z: -0.24, tint: 1 });
    k.box(0.06, 0.05, 0.5, 0xffffff, { x, y: 0.42, z: -0.04, tint: 1 });
    k.box(0.06, 0.05, 0.42, 0xffffff, { x, y: 0.62, z: 0.0, tint: 1 }); // armrest
  }
  return k.build();
}

// fire hydrant (tint = red / yellow)
export function hydrantGeo() {
  const k = new Kit();
  k.cyl(0.16, 0.18, 0.08, 8, C.dark, { y: 0.04 });
  k.cyl(0.12, 0.13, 0.5, 8, 0xffffff, { y: 0.32, tint: 1 });
  k.cyl(0.15, 0.15, 0.06, 8, 0xffffff, { y: 0.56, tint: 1 });
  k.cone(0.12, 0.14, 8, 0xffffff, { y: 0.66, tint: 1 });
  k.cyl(0.03, 0.03, 0.05, 5, C.steel, { y: 0.75 });
  for (const s of [-1, 1]) k.cyl(0.055, 0.055, 0.12, 6, 0xffffff, { x: s * 0.16, y: 0.4, rz: Math.PI / 2, tint: 1 });
  k.cyl(0.07, 0.07, 0.1, 6, C.steel, { y: 0.4, z: 0.16, rx: Math.PI / 2 });
  return k.build();
}

// bus shelter (open towards +z) with a bus-stop sign pole at +x; tint = frame colour
export function shelterGeo() {
  const k = new Kit();
  const W = 3.4, D = 1.4, H = 2.45;
  for (const x of [-W / 2 + 0.05, W / 2 - 0.05]) for (const z of [-D / 2 + 0.05, D / 2 - 0.25]) k.box(0.08, H, 0.08, 0xffffff, { x, y: H / 2, z, tint: 1 });
  k.box(W + 0.3, 0.12, D + 0.35, 0xffffff, { y: H + 0.04, z: 0.1, tint: 1 });
  k.box(W - 0.1, H - 0.35, 0.04, C.glass, { y: (H - 0.35) / 2 + 0.25, z: -D / 2 + 0.05 });
  k.box(0.04, H - 0.35, D - 0.4, C.glass, { x: -W / 2 + 0.05, y: (H - 0.35) / 2 + 0.25, z: -0.15 });
  // lit ad panel on the closed side
  k.box(0.1, 1.7, 1.0, C.dark, { x: W / 2 - 0.05, y: 1.25, z: -0.15 });
  k.box(0.12, 1.5, 0.82, 0xfff6e8, { x: W / 2 - 0.05, y: 1.25, z: -0.15, emit: [1.2, 1.0, 0.85] });
  // bench
  k.box(2.2, 0.06, 0.38, C.wood, { y: 0.46, z: -0.35 });
  for (const x of [-0.9, 0.9]) k.box(0.05, 0.46, 0.3, C.steel, { x, y: 0.23, z: -0.35 });
  // roof light strip
  k.box(W - 0.4, 0.04, 0.1, 0xfff2d6, { y: H - 0.04, z: 0.2, emit: WARM });
  // bus stop sign pole
  k.cyl(0.04, 0.04, 2.9, 6, C.steel, { x: W / 2 + 0.6, y: 1.45, z: 0.55 });
  k.cyl(0.32, 0.32, 0.05, 12, 0xffd23a, { x: W / 2 + 0.6, y: 2.7, z: 0.55, rx: Math.PI / 2 });
  k.box(0.36, 0.1, 0.06, C.dark, { x: W / 2 + 0.6, y: 2.7, z: 0.59 });
  k.box(0.3, 0.42, 0.04, C.white, { x: W / 2 + 0.6, y: 2.12, z: 0.57 });
  return k.build();
}

// newspaper / vending box (tint = box colour)
export function newsBoxGeo() {
  const k = new Kit();
  for (const x of [-0.18, 0.18]) k.box(0.05, 0.3, 0.05, C.steel, { x, y: 0.15 });
  k.box(0.48, 0.78, 0.42, 0xffffff, { y: 0.69, tint: 1 });
  k.box(0.38, 0.3, 0.02, 0xcfe4ea, { y: 0.84, z: 0.215 });
  k.box(0.4, 0.05, 0.03, C.dark, { y: 0.6, z: 0.22 });
  k.box(0.5, 0.05, 0.44, 0xffffff, { y: 1.1, tint: 1 });
  return k.build();
}

// mailbox: rounded top on a post (tint = body colour)
export function mailboxGeo() {
  const k = new Kit();
  for (const x of [-0.2, 0.2]) k.box(0.06, 0.36, 0.06, C.dark, { x, y: 0.18 });
  k.box(0.56, 0.62, 0.48, 0xffffff, { y: 0.67, tint: 1 });
  k.cyl(0.24, 0.24, 0.56, 8, 0xffffff, { y: 0.98, rz: Math.PI / 2, tint: 1 });
  k.box(0.32, 0.05, 0.03, C.dark, { y: 0.9, z: 0.25 });
  k.box(0.3, 0.12, 0.02, C.white, { y: 0.66, z: 0.245 });
  return k.build();
}

export function meterGeo() {
  const k = new Kit();
  k.cyl(0.04, 0.05, 1.1, 6, C.steel, { y: 0.55 });
  k.box(0.2, 0.3, 0.16, C.dark, { y: 1.22 });
  k.cyl(0.11, 0.11, 0.16, 8, 0xc9ccd1, { y: 1.38, rx: Math.PI / 2 });
  k.box(0.12, 0.08, 0.02, 0x8fe08a, { y: 1.27, z: 0.085, emit: [0.15, 0.5, 0.15] });
  return k.build();
}

// concrete planter with a small palm
export function planterPalmGeo() {
  const k = new Kit();
  k.box(1.0, 0.5, 1.0, 0xffffff, { y: 0.25, tint: 1 });
  k.box(0.86, 0.04, 0.86, C.soil, { y: 0.5 });
  k.cyl(0.07, 0.1, 1.9, 6, C.trunk, { y: 1.4, rz: 0.05 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.box(0.16, 0.03, 1.0, i % 2 ? C.leaf : C.leafDark, { x: Math.sin(a) * 0.45, y: 2.25, z: Math.cos(a) * 0.45, ry: a, rx: 0.45 });
  }
  return k.build();
}

// concrete planter with a round shrub
export function planterShrubGeo() {
  const k = new Kit();
  k.box(1.0, 0.5, 1.0, 0xffffff, { y: 0.25, tint: 1 });
  k.push(new THREE.IcosahedronGeometry(0.55, 0), C.leaf, { y: 0.92 });
  k.push(new THREE.IcosahedronGeometry(0.32, 0), C.leafDark, { x: 0.25, y: 1.25, z: 0.1 });
  return k.build();
}

// bike rack: three inverted-U hoops along x
export function rackGeo() {
  const k = new Kit();
  for (const x of [-0.7, 0, 0.7]) {
    for (const z of [-0.3, 0.3]) k.box(0.05, 0.8, 0.05, 0xc9ccd1, { x, y: 0.4, z });
    k.box(0.05, 0.05, 0.65, 0xc9ccd1, { x, y: 0.8 });
  }
  k.box(1.6, 0.04, 0.05, C.steel, { y: 0.05, z: -0.3 });
  k.box(1.6, 0.04, 0.05, C.steel, { y: 0.05, z: 0.3 });
  return k.build();
}

// café set: round table with a parasol and two chairs (tint = parasol colour)
export function cafeGeo() {
  const k = new Kit();
  k.cyl(0.4, 0.4, 0.04, 10, C.white, { y: 0.74 });
  k.cyl(0.04, 0.04, 0.72, 5, C.steel, { y: 0.36 });
  k.cyl(0.22, 0.22, 0.03, 8, C.steel, { y: 0.02 });
  k.cyl(0.025, 0.025, 1.6, 5, C.steel, { y: 1.5 });
  const stripes = (tri) => (Math.floor(tri / 2) % 2 ? { color: C.white, tint: 0 } : { color: 0xffffff, tint: 1 });
  k.cone(1.05, 0.4, 8, 0xffffff, { y: 2.2, open: true, face: stripes });
  k.cone(1.03, 0.38, 8, 0xffffff, { y: 2.18, open: true, face: stripes, flip: true });
  for (const s of [-1, 1]) {
    const x = s * 0.62;
    k.box(0.42, 0.04, 0.42, C.wood, { x, y: 0.45 });
    k.box(0.04, 0.46, 0.42, C.wood, { x: x + s * 0.2, y: 0.68 });
    for (const dx of [-0.17, 0.17]) for (const dz of [-0.17, 0.17]) k.box(0.03, 0.45, 0.03, C.dark, { x: x + dx, y: 0.22, z: dz });
  }
  return k.build();
}
