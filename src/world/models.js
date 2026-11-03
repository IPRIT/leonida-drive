import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural low-poly props. Each returns a non-indexed BufferGeometry with vertex colours.
const C = new THREE.Color();
function paint(geo, hex, jitter = 0, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  let s = seed;
  for (let i = 0; i < n; i += 3) {
    s = (s * 16807) % 2147483647;
    const j = 1 + (((s % 1000) / 1000) - 0.5) * jitter;
    C.setHex(hex);
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = C.r * j; col[(i + k) * 3 + 1] = C.g * j; col[(i + k) * 3 + 2] = C.b * j; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function merge(list) {
  const g = mergeGeometries(list.map((x) => { x.deleteAttribute?.('uv'); return x; }), false);
  g.computeBoundingSphere();
  return g;
}

export function palmGeometry() {
  const parts = [];
  // curved trunk
  const segs = 7, H = 10;
  let px = 0, pz = 0;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const r0 = 0.32 - t0 * 0.12, r1 = 0.32 - t1 * 0.12;
    const cyl = new THREE.CylinderGeometry(r1, r0, H / segs + 0.05, 6, 1, true);
    const bend0 = 0.9 * t0 * t0, bend1 = 0.9 * t1 * t1;
    cyl.translate(0, H / segs / 2, 0);
    cyl.rotateZ(-(bend1 - bend0) * 0.9);
    cyl.translate(px, t0 * H, pz);
    px = bend1 * 1.4;
    parts.push(paint(cyl, i % 2 ? 0x8a7458 : 0x7a6650, 0.1, i + 3));
  }
  const top = new THREE.Vector3(px, H, pz);
  // crown bulb
  const bulb = new THREE.IcosahedronGeometry(0.45, 0);
  bulb.translate(top.x, top.y, top.z);
  parts.push(paint(bulb, 0x5a6b2c, 0.1, 9));
  // fronds: drooping strips
  const fronds = 9;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + (f % 2) * 0.2;
    const L = 4.2 + (f % 3) * 0.5;
    const pos = [];
    const steps = 4;
    const pts = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const out = t * L;
      const y = Math.sin(t * Math.PI * 0.75) * 1.3 - t * t * 2.6 + (f % 2 ? 0.25 : 0);
      pts.push(new THREE.Vector3(Math.cos(a) * out, y, Math.sin(a) * out).add(top));
    }
    const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    for (let s = 0; s < steps; s++) {
      const w0 = 0.85 * Math.sin(((s + 0.5) / steps) * Math.PI) + 0.12;
      const w1 = 0.85 * Math.sin(((s + 1.5) / steps) * Math.PI) * (s === steps - 1 ? 0 : 1) + 0.05;
      const p0 = pts[s], p1 = pts[s + 1];
      const l0 = p0.clone().addScaledVector(side, w0), r0 = p0.clone().addScaledVector(side, -w0);
      const l1 = p1.clone().addScaledVector(side, w1), r1 = p1.clone().addScaledVector(side, -w1);
      const mid0 = p0.clone().add(new THREE.Vector3(0, 0.12, 0)), mid1 = p1.clone().add(new THREE.Vector3(0, 0.12, 0));
      pos.push(...l0.toArray(), ...mid0.toArray(), ...l1.toArray(), ...mid0.toArray(), ...mid1.toArray(), ...l1.toArray());
      pos.push(...mid0.toArray(), ...r0.toArray(), ...r1.toArray(), ...mid0.toArray(), ...r1.toArray(), ...mid1.toArray());
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    parts.push(paint(g, f % 3 === 0 ? 0x4f8a2c : f % 3 === 1 ? 0x5f9a34 : 0x6aa63a, 0.15, f + 20));
  }
  return merge(parts);
}

export function treeGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.22, 0.38, 3.2, 5);
  trunk.translate(0, 1.6, 0);
  parts.push(paint(trunk, 0x6e5640, 0.1, 2));
  const blobs = [[0, 4.6, 0, 2.6], [1.3, 4.0, 0.6, 1.9], [-1.1, 4.2, -0.7, 2.0], [0.2, 5.6, -0.4, 1.7]];
  blobs.forEach(([x, y, z, r], i) => {
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.scale(1, 0.82, 1);
    b.translate(x, y, z);
    parts.push(paint(b, i % 2 ? 0x4e8a34 : 0x5b9a3c, 0.22, i + 5));
  });
  return merge(parts);
}

export function pineGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.3, 4, 5);
  trunk.translate(0, 2, 0);
  parts.push(paint(trunk, 0x5e4632, 0.1, 3));
  [[3.6, 2.9, 3.0], [5.6, 2.3, 2.8], [7.4, 1.6, 2.6], [9.0, 0.9, 2.2]].forEach(([y, r, h], i) => {
    const c = new THREE.ConeGeometry(r, h, 6);
    c.translate(0, y, 0);
    parts.push(paint(c, i % 2 ? 0x2f5f34 : 0x386b3a, 0.18, i + 11));
  });
  return merge(parts);
}

export function bushGeometry() {
  const parts = [];
  [[0, 0.7, 0, 1.0], [0.7, 0.55, 0.3, 0.75], [-0.6, 0.5, -0.3, 0.7]].forEach(([x, y, z, r], i) => {
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.scale(1, 0.75, 1);
    b.translate(x, y, z);
    parts.push(paint(b, i % 2 ? 0x4c7f2e : 0x5d8f36, 0.25, i + 30));
  });
  return merge(parts);
}

export function cypressGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.2, 0.55, 3.0, 6);
  trunk.translate(0, 1.5, 0);
  parts.push(paint(trunk, 0x6b5a46, 0.1, 4));
  const c = new THREE.CylinderGeometry(0.6, 1.9, 6.5, 7);
  c.translate(0, 6.0, 0);
  parts.push(paint(c, 0x5d7a3a, 0.25, 40));
  const t = new THREE.ConeGeometry(0.9, 2.2, 7);
  t.translate(0, 10.3, 0);
  parts.push(paint(t, 0x66843f, 0.2, 41));
  return merge(parts);
}

export function reedGeometry() {
  const pos = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const dx = Math.cos(a) * 0.35, dz = Math.sin(a) * 0.35;
    const w = 0.09;
    const sx = -Math.sin(a) * w, sz = Math.cos(a) * w;
    pos.push(sx, 0, sz, -sx, 0, -sz, dx, 1.5 + (i % 3) * 0.25, dz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return paint(g, 0x8a9a4a, 0.25, 50);
}

export function lampGeometry() {
  const parts = [];
  const pole = new THREE.CylinderGeometry(0.09, 0.14, 8.5, 6);
  pole.translate(0, 4.25, 0);
  parts.push(paint(pole, 0x6d7177, 0.05, 5));
  const base = new THREE.CylinderGeometry(0.22, 0.26, 0.6, 6);
  base.translate(0, 0.3, 0);
  parts.push(paint(base, 0x55585c, 0.05, 6));
  const arm = new THREE.BoxGeometry(0.08, 0.08, 2.0);
  arm.translate(0, 8.4, 1.0);
  parts.push(paint(arm, 0x6d7177, 0.05, 7));
  const head = new THREE.BoxGeometry(0.42, 0.16, 0.8);
  head.translate(0, 8.35, 2.0);
  parts.push(paint(head, 0x3f4246, 0.05, 8));
  return merge(parts);
}
