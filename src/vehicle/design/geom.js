// Low-level geometry toolkit for the procedural vehicles.
// Everything works on raw non-indexed triangle position arrays (Float32Array, 9 floats per triangle):
// cheap to transform, slice, classify and merge. Model space: y = 0 ground, -Z forward, x = right.
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

/** THREE geometry -> flat triangle positions. */
export function tris(g) {
  const geo = g.index ? g.toNonIndexed() : g;
  const a = geo.attributes.position.array;
  const out = new Float32Array(a.length);
  out.set(a);
  g.dispose();
  if (geo !== g) geo.dispose();
  return out;
}

export function xform(a, m) {
  for (let i = 0; i < a.length; i += 3) {
    _v.set(a[i], a[i + 1], a[i + 2]).applyMatrix4(m);
    a[i] = _v.x; a[i + 1] = _v.y; a[i + 2] = _v.z;
  }
  return a;
}

export function translate(a, x, y, z) {
  for (let i = 0; i < a.length; i += 3) { a[i] += x; a[i + 1] += y; a[i + 2] += z; }
  return a;
}

export function rotate(a, rx = 0, ry = 0, rz = 0, order = 'XYZ') {
  if (!rx && !ry && !rz) return a;
  return xform(a, _m.makeRotationFromEuler(_e.set(rx, ry, rz, order)));
}

export function scale(a, sx, sy, sz) {
  for (let i = 0; i < a.length; i += 3) { a[i] *= sx; a[i + 1] *= sy; a[i + 2] *= sz; }
  return a;
}

/** In-place vertex warp: fn(v: Vector3) mutates v. */
export function warp(a, fn) {
  for (let i = 0; i < a.length; i += 3) {
    _v.set(a[i], a[i + 1], a[i + 2]);
    fn(_v);
    a[i] = _v.x; a[i + 1] = _v.y; a[i + 2] = _v.z;
  }
  return a;
}

/** Mirror across x = 0 (keeps the winding outward). */
export function mirrorX(a) {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 9) {
    // swap vertices 1 and 2 to flip winding back
    o[i] = -a[i]; o[i + 1] = a[i + 1]; o[i + 2] = a[i + 2];
    o[i + 3] = -a[i + 6]; o[i + 4] = a[i + 7]; o[i + 5] = a[i + 8];
    o[i + 6] = -a[i + 3]; o[i + 7] = a[i + 4]; o[i + 8] = a[i + 5];
  }
  return o;
}

export function concat(list) {
  let n = 0;
  for (const a of list) n += a.length;
  const o = new Float32Array(n);
  let k = 0;
  for (const a of list) { o.set(a, k); k += a.length; }
  return o;
}

// ---------- primitives ----------

export function box(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const a = tris(new THREE.BoxGeometry(w, h, d));
  rotate(a, rx, ry, rz);
  return translate(a, x, y, z);
}

/** Cylinder. axis 'y' (default), 'x' or 'z'. */
export function cyl(r1, r2, h, seg, x = 0, y = 0, z = 0, axis = 'y', open = false) {
  const a = tris(new THREE.CylinderGeometry(r1, r2, h, seg, 1, open));
  if (axis === 'x') rotate(a, 0, 0, Math.PI / 2);
  else if (axis === 'z') rotate(a, Math.PI / 2, 0, 0);
  return translate(a, x, y, z);
}

/** Cylinder (or cone) between two points. */
export function tube(p0, p1, r0, r1 = r0, seg = 6) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const a = tris(new THREE.CylinderGeometry(r1, r0, len, seg, 1, false));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
  _m.compose(new THREE.Vector3((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  return xform(a, _m);
}

/** Box-section bar between two points (w across, h up). */
export function bar(p0, p1, w, h) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const a = tris(new THREE.BoxGeometry(w, h, len));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dx / len, dy / len, dz / len));
  _m.compose(new THREE.Vector3((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  return xform(a, _m);
}

export function sphere(r, ws, hs, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const a = tris(new THREE.SphereGeometry(r, ws, hs));
  scale(a, sx, sy, sz);
  return translate(a, x, y, z);
}

/** Lathe around the Y axis from [[radius, y], ...]. */
export function lathe(pts, seg, phiStart = 0, phiLen = Math.PI * 2) {
  return tris(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y)), seg, phiStart, phiLen));
}

/** Torus ring around the X axis (wheel rims, tyres for bikes). */
export function ring(R, r, radial, tubular, x = 0, y = 0, z = 0) {
  const a = tris(new THREE.TorusGeometry(R, r, radial, tubular));
  rotate(a, 0, Math.PI / 2, 0);
  return translate(a, x, y, z);
}

/**
 * Extrude a side profile [[z, y], ...] across the width (along X), centred on x = 0, with chamfered edges.
 */
export function extrudeSide(pts, width, bevel = 0.06, bevelSize = bevel, curveSegments = 1) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const t = Math.min(bevel, width * 0.45);
  const depth = Math.max(0.01, width - 2 * t);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: t > 0, bevelThickness: t, bevelSize, bevelOffset: -bevelSize, bevelSegments: 1, curveSegments,
  });
  const a = tris(g);
  rotate(a, 0, -Math.PI / 2, 0);
  return translate(a, depth / 2, 0, 0);
}

/** Prism from a side profile extruded across [x0, x1]. */
export function slab(pts, x0, x1, bevel = 0) {
  const a = extrudeSide(pts, x1 - x0, bevel);
  return translate(a, (x0 + x1) / 2, 0, 0);
}

/** Plan-view prism: polygon [[x, z], ...] extruded from y0 to y1. */
export function plate(pts, y0, y1, bevel = 0) {
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  const t = Math.min(bevel, (y1 - y0) * 0.45);
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.005, y1 - y0 - 2 * t), bevelEnabled: t > 0, bevelThickness: t, bevelSize: t, bevelOffset: -t, bevelSegments: 1 });
  const a = tris(g);
  rotate(a, -Math.PI / 2, 0, 0);
  return translate(a, 0, y0 + t, 0);
}

/** Points of a wheel arch around (zc, yc), starting/ending at height ySill. */
export function arch(zc, yc, R, ySill, n = 7, flat = 0) {
  const phi = Math.asin(Math.max(-0.99, Math.min(0.99, (yc - ySill) / R)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.PI + phi - ((Math.PI + 2 * phi) * i) / n;
    let y = yc + R * Math.sin(t);
    // flattened (squared-off) arches for trucks / off-roaders
    if (flat > 0 && y > yc) y = yc + (y - yc) * (1 - flat) + R * flat * Math.min(1, Math.sin(t) * 1.6);
    pts.push([zc + R * Math.cos(t), y]);
  }
  return pts;
}

/** Rounded corner points from a to b around corner c (quadratic Bezier), n segments. */
export function corner(a, c, b, n = 3) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/** Polyline offset helpers on a closed side profile. */
export class Profile {
  constructor(pts) {
    this.pts = pts;
  }
  _cross(axis, v) {
    const p = this.pts, out = [];
    const o = axis === 'y' ? 1 : 0, k = 1 - o;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if ((a[o] - v) * (b[o] - v) <= 0 && a[o] !== b[o]) {
        const t = (v - a[o]) / (b[o] - a[o]);
        out.push(a[k] + (b[k] - a[k]) * t);
      }
    }
    return out;
  }
  /** Front-most z at height y. */
  frontAt(y) {
    const c = this._cross('y', y);
    return c.length ? Math.min(...c) : null;
  }
  rearAt(y) {
    const c = this._cross('y', y);
    return c.length ? Math.max(...c) : null;
  }
  topAt(z) {
    const c = this._cross('z', z);
    return c.length ? Math.max(...c) : null;
  }
  bottomAt(z) {
    const c = this._cross('z', z);
    return c.length ? Math.min(...c) : null;
  }
}

// ---------- slicing / classification ----------

/** Split every triangle crossing the plane (axis = 0|1|2, value). Watertight for shared edges. */
export function slice(a, axis, value) {
  const n = [0, 0, 0];
  n[axis] = 1;
  return slicePlane(a, n[0], n[1], n[2], value);
}

/** Split triangles by the plane n·p = value. */
export function slicePlane(a, nx, ny, nz, value) {
  const out = [];
  const eps = 1e-5;
  let changed = false;
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const d = [0, 0, 0];
  const lerp3 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  for (let i = 0; i < a.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      P[k][0] = a[i + k * 3]; P[k][1] = a[i + k * 3 + 1]; P[k][2] = a[i + k * 3 + 2];
      d[k] = P[k][0] * nx + P[k][1] * ny + P[k][2] * nz - value;
    }
    const pos = (d[0] > eps) + (d[1] > eps) + (d[2] > eps);
    const neg = (d[0] < -eps) + (d[1] < -eps) + (d[2] < -eps);
    if (pos === 0 || neg === 0) {
      for (let k = 0; k < 9; k++) out.push(a[i + k]);
      continue;
    }
    changed = true;
    // one vertex exactly on the plane: split into two triangles
    const on = [Math.abs(d[0]) <= eps, Math.abs(d[1]) <= eps, Math.abs(d[2]) <= eps];
    const onIdx = on.indexOf(true);
    if (onIdx >= 0) {
      const A = P[onIdx], B = P[(onIdx + 1) % 3], C = P[(onIdx + 2) % 3];
      const db = d[(onIdx + 1) % 3], dc = d[(onIdx + 2) % 3];
      const M = lerp3(B, C, db / (db - dc));
      out.push(...A, ...B, ...M, ...A, ...M, ...C);
      continue;
    }
    // lone vertex: the one whose sign differs from the other two
    let lone;
    if ((d[0] > 0) !== (d[1] > 0) && (d[0] > 0) !== (d[2] > 0)) lone = 0;
    else if ((d[1] > 0) !== (d[0] > 0) && (d[1] > 0) !== (d[2] > 0)) lone = 1;
    else lone = 2;
    const A = P[lone], B = P[(lone + 1) % 3], C = P[(lone + 2) % 3];
    const da = d[lone], db = d[(lone + 1) % 3], dc = d[(lone + 2) % 3];
    const Pab = lerp3(A, B, da / (da - db));
    const Qac = lerp3(A, C, da / (da - dc));
    out.push(...A, ...Pab, ...Qac, ...Pab, ...B, ...C, ...Pab, ...C, ...Qac);
  }
  return changed ? new Float32Array(out) : a;
}

export function sliceMany(a, axis, values) {
  for (const v of values) a = slice(a, axis, v);
  return a;
}

/**
 * Split triangles into buckets: fn(nx, ny, nz, cx, cy, cz) -> key | null (drop).
 * Returns { key: Float32Array }.
 */
export function classify(a, fn) {
  const buckets = {};
  for (let i = 0; i < a.length; i += 9) {
    const ax = a[i], ay = a[i + 1], az = a[i + 2];
    const e1x = a[i + 3] - ax, e1y = a[i + 4] - ay, e1z = a[i + 5] - az;
    const e2x = a[i + 6] - ax, e2y = a[i + 7] - ay, e2z = a[i + 8] - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l; ny /= l; nz /= l;
    const k = fn(nx, ny, nz, (ax + a[i + 3] + a[i + 6]) / 3, (ay + a[i + 4] + a[i + 7]) / 3, (az + a[i + 5] + a[i + 8]) / 3);
    if (k === null || k === undefined) continue;
    (buckets[k] ||= []).push(i);
  }
  const res = {};
  for (const k of Object.keys(buckets)) {
    const idx = buckets[k];
    const o = new Float32Array(idx.length * 9);
    idx.forEach((i, j) => o.set(a.subarray(i, i + 9), j * 9));
    res[k] = o;
  }
  return res;
}

export function triCount(a) {
  return a.length / 9;
}

/** Bounding box of a triangle array: [minx,miny,minz,maxx,maxy,maxz]. */
export function bounds(a, bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]) {
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] < bb[0]) bb[0] = a[i];
    if (a[i + 1] < bb[1]) bb[1] = a[i + 1];
    if (a[i + 2] < bb[2]) bb[2] = a[i + 2];
    if (a[i] > bb[3]) bb[3] = a[i];
    if (a[i + 1] > bb[4]) bb[4] = a[i + 1];
    if (a[i + 2] > bb[5]) bb[5] = a[i + 2];
  }
  return bb;
}

/** Flat triangle array -> BufferGeometry with face normals. */
export function toGeometry(a) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a, 3));
  g.computeVertexNormals();
  return g;
}

// ---------- bucket container ----------

/** Collects triangle arrays per material key (and optional lamp/part tags). */
export class Parts {
  constructor() {
    this.mats = {}; // matKey -> [Float32Array]
    this.lamps = []; // { kind, name, mat, geo: Float32Array, attach }
    this.fixed = []; // { part, mat, geo } triangles forced into a damage part
    this.extra = {}; // named groups (animated parts): name -> { mat -> [arrays], pivot }
  }
  add(mat, a) {
    if (a && a.length) (this.mats[mat] ||= []).push(a);
    return a;
  }
  /** Symmetric pair: fn(sx) returns geometry for side sx (+1 right, -1 left). */
  pair(mat, fn) {
    this.add(mat, fn(1));
    this.add(mat, fn(-1));
  }
  /** Lamps are kept as separate meshes (breakable). kind: head|tail|reverse|amber|brake|sirenRed|sirenBlue|beacon */
  lamp(kind, name, a, attach = 'body', mat = kind) {
    if (a && a.length) this.lamps.push({ kind, name, mat, geo: a, attach });
  }
  /** Geometry forced into a damage part (e.g. a separate bumper box). */
  part(part, mat, a) {
    if (a && a.length) this.fixed.push({ part, mat, geo: a });
  }
  group(name, mat, a, pivot) {
    const g = (this.extra[name] ||= { mats: {}, pivot: pivot || [0, 0, 0] });
    if (pivot) g.pivot = pivot;
    if (a && a.length) (g.mats[mat] ||= []).push(a);
  }
}
