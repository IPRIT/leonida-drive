import * as THREE from 'three';

// Geometry kit for landmark models: growable typed buffers, a mesh builder with a transform stack and
// near/far LOD routing, and the low-poly primitives every generator uses (boxes, prisms, cylinders, vaults,
// lathes, beams, ribbons). Everything is written straight into typed arrays: no THREE.Vector3 per vertex,
// so whole airports build in a few milliseconds.

// surface kinds (aFx.w), interpreted by the landmark material (materials.js)
export const K = {
  PLAIN: 0, // matte vertex colour
  WIN: 1, // facade with windows; style = pattern (see W)
  GLASS: 2, // curtain wall with mullions; style 0 office, 1 public hall (lit at night), 2 dark
  METAL: 3, // sheet metal (ribbed), hangar roofs, cranes, aircraft skins
  EMIT: 4, // self-lit colour (neon, lamps, light panels); style 0 neon, 1 night panel, 2 always on
  NIGHTWIN: 5, // dark strip by day, warm lit cells at night (aircraft/ship windows, window bands)
  PAINT: 6, // ground paint, matte
  FENCE: 7, // chain-link mesh (alpha-tested pattern)
  LED: 8, // animated colour (arena bands, tower crowns); style 0 hue cycle, 1 chase, 2 slow pulse
  TINT: 9, // multiplied by the instance colour (liveries)
  ROOF: 10, // roof membrane / gravel, slight noise
  GRASS: 11, // sports turf with mowing stripes
};
// window styles for K.WIN
export const W = { DECO: 1, OFFICE: 2, HOTEL: 3, INDUSTRIAL: 4, GRID: 5, GARAGE: 6, TOWER: 7 };

const _c = new THREE.Color();
export function rgb(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }

// deterministic PRNG
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Grow {
  constructor(Type, n = 1024) { this.a = new Type(n); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    let m = this.a.length * 2;
    while (m < this.n + k) m *= 2;
    const b = new this.a.constructor(m);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  view() { return this.a.slice(0, this.n); }
}

// one renderable buffer set: position f32x3, normal i8x3, colour u8x3, aFx f32x4 (u, v, style, kind), index u32
export class MeshData {
  constructor(uv = false) {
    this.pos = new Grow(Float32Array, 4096);
    this.nrm = new Grow(Int8Array, 4096);
    this.col = new Grow(Uint8Array, 4096);
    this.fx = new Grow(Float32Array, 4096);
    this.uv = uv ? new Grow(Float32Array, 2048) : null;
    this.idx = new Grow(Uint32Array, 4096);
    this.vcount = 0;
    this.box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  }

  get tris() { return this.idx.n / 3; }

  vert(x, y, z, nx, ny, nz, r, g, b, u, v, style, kind, tu = 0, tv = 0) {
    const P = this.pos; P.need(3);
    P.a[P.n++] = x; P.a[P.n++] = y; P.a[P.n++] = z;
    const N = this.nrm; N.need(3);
    N.a[N.n++] = Math.round(nx * 127); N.a[N.n++] = Math.round(ny * 127); N.a[N.n++] = Math.round(nz * 127);
    const C = this.col; C.need(3);
    C.a[C.n++] = r * 255 + 0.5; C.a[C.n++] = g * 255 + 0.5; C.a[C.n++] = b * 255 + 0.5;
    const F = this.fx; F.need(4);
    F.a[F.n++] = u; F.a[F.n++] = v; F.a[F.n++] = style; F.a[F.n++] = kind;
    if (this.uv) { const T = this.uv; T.need(2); T.a[T.n++] = tu; T.a[T.n++] = tv; }
    const bx = this.box;
    if (x < bx[0]) bx[0] = x; if (y < bx[1]) bx[1] = y; if (z < bx[2]) bx[2] = z;
    if (x > bx[3]) bx[3] = x; if (y > bx[4]) bx[4] = y; if (z > bx[5]) bx[5] = z;
    return this.vcount++;
  }

  tri(a, b, c) { const I = this.idx; I.need(3); I.a[I.n++] = a; I.a[I.n++] = b; I.a[I.n++] = c; }

  // darken / restore a vertex range (damage or debug)
  geometry() {
    if (!this.vcount) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view(), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.view(), 3, true));
    g.setAttribute('aFx', new THREE.BufferAttribute(this.fx.view(), 4));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(this.uv.view(), 2));
    // explicit zero cluster index: never read a stale generic attribute value (see LOD_UNIFORMS)
    g.setAttribute('aClu', new THREE.BufferAttribute(new Uint8Array(this.vcount), 1));
    g.setIndex(new THREE.BufferAttribute(this.idx.view(), 1));
    const b = this.box;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    return g;
  }
}

export const LOD = { BOTH: 0, NEAR: 1, FAR: 2 };

// Mesh builder: current paint (colour, kind, style), an affine transform stack and LOD routing into two
// MeshData (near detail / far silhouette). Optional collider sink receives world-space boxes / cylinders.
export class Builder {
  constructor({ uv = false, far = true } = {}) {
    this.near = new MeshData(uv);
    this.far = far ? new MeshData(uv) : null;
    this.lod = LOD.BOTH;
    this.m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]; // row-major 3x4
    this.yaw = 0;
    this.stack = [];
    this.r = 0.8; this.g = 0.8; this.b = 0.8;
    this.kind = K.PLAIN; this.style = 0;
    this.colliders = null; // ColliderField
    this.colTag = null;
    this.orient = null; // optional local point: faces are flipped to point away from it
    this.spinIdx = -1; // >= 0: faces rotate with landmark spinner #spinIdx (see SPIN_UNIFORMS)
    this._v = new Float64Array(12);
  }

  // ---------- state ----------
  paint(hex, kind = K.PLAIN, style = 0) {
    if (Array.isArray(hex)) { this.r = hex[0]; this.g = hex[1]; this.b = hex[2]; } else { _c.setHex(hex); this.r = _c.r; this.g = _c.g; this.b = _c.b; }
    this.kind = kind; this.style = style;
    return this;
  }
  push() { this.stack.push([this.m.slice(), this.yaw, this.lod, this.r, this.g, this.b, this.kind, this.style, this.spinIdx]); return this; }
  pop() { const s = this.stack.pop(); this.m = s[0]; this.yaw = s[1]; this.lod = s[2]; this.r = s[3]; this.g = s[4]; this.b = s[5]; this.kind = s[6]; this.style = s[7]; this.spinIdx = s[8]; return this; }
  translate(x, y, z) {
    const m = this.m;
    m[3] += m[0] * x + m[1] * y + m[2] * z;
    m[7] += m[4] * x + m[5] * y + m[6] * z;
    m[11] += m[8] * x + m[9] * y + m[10] * z;
    return this;
  }
  // rotation about +Y (yaw, radians, counter-clockwise seen from above: +X turns towards -Z)
  rotY(a) {
    const c = Math.cos(a), s = Math.sin(a), m = this.m;
    for (let r = 0; r < 3; r++) {
      const x = m[r * 4], z = m[r * 4 + 2];
      m[r * 4] = x * c - z * s;
      m[r * 4 + 2] = x * s + z * c;
    }
    this.yaw += a;
    return this;
  }
  rotX(a) {
    const c = Math.cos(a), s = Math.sin(a), m = this.m;
    for (let r = 0; r < 3; r++) {
      const y = m[r * 4 + 1], z = m[r * 4 + 2];
      m[r * 4 + 1] = y * c + z * s;
      m[r * 4 + 2] = -y * s + z * c;
    }
    return this;
  }
  rotZ(a) {
    const c = Math.cos(a), s = Math.sin(a), m = this.m;
    for (let r = 0; r < 3; r++) {
      const x = m[r * 4], y = m[r * 4 + 1];
      m[r * 4] = x * c + y * s;
      m[r * 4 + 1] = -x * s + y * c;
    }
    return this;
  }
  scale(sx, sy = sx, sz = sx) {
    const m = this.m;
    for (let r = 0; r < 3; r++) { m[r * 4] *= sx; m[r * 4 + 1] *= sy; m[r * 4 + 2] *= sz; }
    return this;
  }
  // world position of a local point
  world(x, y, z, out = [0, 0, 0]) {
    const m = this.m;
    out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    return out;
  }

  // ---------- raw emit ----------
  // polygon (3 or 4 local points, CCW seen from the front) with per-vertex (u,v) facade coordinates
  face(pts, uvs, tuv = null) {
    const m = this.m, v = this._v, n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      v[i * 3] = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
      v[i * 3 + 1] = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7];
      v[i * 3 + 2] = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
    }
    // Newell normal (robust for slightly non-planar quads)
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = v[i * 3], ay = v[i * 3 + 1], az = v[i * 3 + 2], bx = v[j * 3], by = v[j * 3 + 1], bz = v[j * 3 + 2];
      nx += (ay - by) * (az + bz); ny += (az - bz) * (ax + bx); nz += (ax - bx) * (ay + by);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (this.orient) {
      const o = this.world(this.orient[0], this.orient[1], this.orient[2]);
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += v[i * 3]; cy += v[i * 3 + 1]; cz += v[i * 3 + 2]; }
      if ((cx / n - o[0]) * nx + (cy / n - o[1]) * ny + (cz / n - o[2]) * nz < 0) {
        nx = -nx; ny = -ny; nz = -nz;
        // reverse winding (keep vertex 0, flip the rest)
        for (let i = 1, j = n - 1; i < j; i++, j--) {
          for (let k = 0; k < 3; k++) { const t = v[i * 3 + k]; v[i * 3 + k] = v[j * 3 + k]; v[j * 3 + k] = t; }
        }
        if (uvs) uvs = [uvs[0], ...uvs.slice(1).reverse()];
        if (tuv) tuv = [tuv[0], ...tuv.slice(1).reverse()];
      }
    }
    const spin = this.spinIdx >= 0;
    const kind = spin ? this.kind + 16 : this.kind, style = spin ? this.spinIdx : this.style;
    const lod = this.lod;
    if (lod !== LOD.FAR) this._emit(this.near, v, n, nx, ny, nz, uvs, tuv, style, kind);
    if (lod !== LOD.NEAR && this.far) this._emit(this.far, v, n, nx, ny, nz, uvs, tuv, style, kind);
  }

  // hot path: one capacity check per face, direct typed-array writes
  _emit(T, v, n, nx, ny, nz, uvs, tuv, style, kind) {
    T.pos.need(n * 3); T.nrm.need(n * 3); T.col.need(n * 3); T.fx.need(n * 4); T.idx.need(6);
    const P = T.pos.a, N = T.nrm.a, C = T.col.a, F = T.fx.a, box = T.box;
    let pi = T.pos.n, ci = T.col.n, fi = T.fx.n;
    const inx = Math.round(nx * 127), iny = Math.round(ny * 127), inz = Math.round(nz * 127);
    const r = this.r * 255 + 0.5, g = this.g * 255 + 0.5, b = this.b * 255 + 0.5;
    const i0 = T.vcount;
    for (let i = 0; i < n; i++) {
      const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
      P[pi++] = x; P[pi++] = y; P[pi++] = z;
      N[ci] = inx; N[ci + 1] = iny; N[ci + 2] = inz;
      C[ci] = r; C[ci + 1] = g; C[ci + 2] = b; ci += 3;
      const uv = uvs ? uvs[i] : ZERO2;
      F[fi++] = uv[0]; F[fi++] = uv[1]; F[fi++] = style; F[fi++] = kind;
      if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
      if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
    }
    if (T.uv) {
      T.uv.need(n * 2);
      const U = T.uv.a;
      let ui = T.uv.n;
      for (let i = 0; i < n; i++) { U[ui++] = tuv ? tuv[i][0] : 0; U[ui++] = tuv ? tuv[i][1] : 0; }
      T.uv.n = ui;
    }
    T.pos.n = pi; T.nrm.n = ci; T.col.n = ci; T.fx.n = fi;
    T.vcount += n;
    const I = T.idx.a;
    let ii = T.idx.n;
    I[ii++] = i0; I[ii++] = i0 + 1; I[ii++] = i0 + 2;
    if (n === 4) { I[ii++] = i0; I[ii++] = i0 + 2; I[ii++] = i0 + 3; }
    T.idx.n = ii;
  }

  quad(a, b, c, d, uvs = null, tuv = null) { this.face([a, b, c, d], uvs, tuv); return this; }
  tri(a, b, c, uvs = null) { this.face([a, b, c], uvs); return this; }

  // wall quad from (ax,az) to (bx,bz), outward normal on the right when walking a->b seen from above with -z up
  // (i.e. walls of a clockwise-in-screen polygon face out). v = height above vBase, u from u0 along the wall.
  wall(ax, az, bx, bz, y0, y1, u0 = 0, vBase = y0) {
    const L = Math.hypot(bx - ax, bz - az);
    this.face([[ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz]],
      [[u0, y0 - vBase], [u0, y1 - vBase], [u0 + L, y1 - vBase], [u0 + L, y0 - vBase]]);
    return L;
  }

  // ---------- primitives ----------
  // axis-aligned box in the local frame. faces: bit mask px nx py ny pz nz (default all but bottom)
  box(x0, y0, z0, x1, y1, z1, faces = 0b111011, vBase = y0) {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    const dx = x1 - x0, dz = z1 - z0, h0 = y0 - vBase, h1 = y1 - vBase;
    if (faces & 0b100000) this.face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [[0, h0], [0, h1], [dz, h1], [dz, h0]]); // +x
    if (faces & 0b010000) this.face([[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], [[0, h0], [0, h1], [dz, h1], [dz, h0]]); // -x
    if (faces & 0b001000) this.face([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [[x0, z0], [x0, z1], [x1, z1], [x1, z0]]); // +y
    if (faces & 0b000100) this.face([[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], [[x0, z1], [x0, z0], [x1, z0], [x1, z1]]); // -y
    if (faces & 0b000010) this.face([[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], [[0, h0], [0, h1], [dx, h1], [dx, h0]]); // +z
    if (faces & 0b000001) this.face([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [[0, h0], [0, h1], [dx, h1], [dx, h0]]); // -z
    return this;
  }

  // box from centre + half sizes
  cbox(cx, cy, cz, hx, hy, hz, faces) { return this.box(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz, faces); }

  // extruded polygon [[x,z],...] (any winding) from y0 to y1, walls + top cap (+ bottom)
  prism(poly, y0, y1, { top = true, bottom = false, u0 = 0, vBase = y0, topPaint = null } = {}) {
    const P = cw(poly);
    let u = u0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      u += this.wall(a[0], a[1], b[0], b[1], y0, y1, u, vBase);
    }
    if (top || bottom) {
      const tris = triangulate(P);
      if (top) {
        if (topPaint) { this.push(); this.paint(...topPaint); }
        for (const t of tris) this._flat(P, t, y1, false);
        if (topPaint) this.pop();
      }
      if (bottom) for (const t of tris) this._flat(P, t, y0, true);
    }
    return u;
  }

  // flat polygon (cap) at height y, facing up (or down)
  cap(poly, y, down = false) {
    const P = cw(poly);
    for (const t of triangulate(P)) this._flat(P, t, y, down);
    return this;
  }

  // one horizontal triangle of polygon P, oriented up (or down)
  _flat(P, [i, j, k], y, down) {
    let A = P[i], B = P[j], C = P[k];
    const cr = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if ((cr > 0) !== down) { const t = B; B = C; C = t; }
    this.face([[A[0], y, A[1]], [B[0], y, B[1]], [C[0], y, C[1]]], [[A[0], A[1]], [B[0], B[1]], [C[0], C[1]]]);
  }

  // vertical frustum around (x,z): radii r0 (bottom) r1 (top), seg sides
  cyl(x, z, y0, y1, r0, r1 = r0, seg = 8, { top = true, bottom = false, phase = 0, open = false } = {}) {
    const ang = (i) => phase + (i / seg) * Math.PI * 2;
    let u = 0;
    const circ0 = 2 * Math.PI * Math.max(r0, r1) / seg;
    for (let i = 0; i < seg; i++) {
      const a0 = ang(i), a1 = ang(i + 1);
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const h = y1 - y0;
      if (r1 > 1e-4) this.face([[x + c0 * r0, y0, z + s0 * r0], [x + c0 * r1, y1, z + s0 * r1], [x + c1 * r1, y1, z + s1 * r1], [x + c1 * r0, y0, z + s1 * r0]], [[u, 0], [u, h], [u + circ0, h], [u + circ0, 0]]);
      else this.face([[x + c0 * r0, y0, z + s0 * r0], [x, y1, z], [x + c1 * r0, y0, z + s1 * r0]], [[u, 0], [u, h], [u + circ0, 0]]);
      if (open) continue;
      if (top && r1 > 1e-4) this.face([[x, y1, z], [x + c1 * r1, y1, z + s1 * r1], [x + c0 * r1, y1, z + s0 * r1]], [[x, z], [x + c1 * r1, z + s1 * r1], [x + c0 * r1, z + s0 * r1]]);
      if (bottom && r0 > 1e-4) this.face([[x, y0, z], [x + c0 * r0, y0, z + s0 * r0], [x + c1 * r0, y0, z + s1 * r0]], [[x, z], [x + c0 * r0, z + s0 * r0], [x + c1 * r0, z + s1 * r0]]);
      u += circ0;
    }
    return this;
  }

  // surface of revolution around (x,z): profile [[r, y], ...] bottom to top
  lathe(x, z, profile, seg = 12, { phase = 0, capTop = true } = {}) {
    for (let k = 0; k < profile.length - 1; k++) {
      const [ra, ya] = profile[k], [rb, yb] = profile[k + 1];
      for (let i = 0; i < seg; i++) {
        const a0 = phase + (i / seg) * Math.PI * 2, a1 = phase + ((i + 1) / seg) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const u0 = i * 2 * Math.PI * Math.max(ra, rb) / seg, u1 = u0 + 2 * Math.PI * Math.max(ra, rb) / seg;
        if (ra < 1e-4) this.face([[x, ya, z], [x + c0 * rb, yb, z + s0 * rb], [x + c1 * rb, yb, z + s1 * rb]], [[u0, ya], [u0, yb], [u1, yb]]);
        else if (rb < 1e-4) this.face([[x + c0 * ra, ya, z + s0 * ra], [x, yb, z], [x + c1 * ra, ya, z + s1 * ra]], [[u0, ya], [u0, yb], [u1, ya]]);
        else this.face([[x + c0 * ra, ya, z + s0 * ra], [x + c0 * rb, yb, z + s0 * rb], [x + c1 * rb, yb, z + s1 * rb], [x + c1 * ra, ya, z + s1 * ra]], [[u0, ya], [u0, yb], [u1, yb], [u1, ya]]);
      }
    }
    const [rt, yt] = profile[profile.length - 1];
    if (capTop && rt > 1e-4) this.cyl(x, z, yt, yt, rt, rt, seg, { top: true, phase, open: false });
    return this;
  }

  // dome (half sphere, or a spherical cap down to `minLat` radians above the equator)
  dome(x, y, z, r, seg = 12, rings = 4, { squash = 1, minLat = 0 } = {}) {
    const prof = [];
    for (let k = 0; k <= rings; k++) {
      const lat = minLat + (k / rings) * (Math.PI / 2 - minLat);
      prof.push([Math.cos(lat) * r, y + Math.sin(lat) * r * squash - Math.sin(minLat) * r * squash]);
    }
    prof[prof.length - 1][0] = 0;
    return this.lathe(x, z, prof, seg, { capTop: false });
  }

  sphere(x, y, z, r, seg = 10, rings = 6) {
    const prof = [];
    for (let k = 0; k <= rings; k++) {
      const lat = -Math.PI / 2 + (k / rings) * Math.PI;
      prof.push([Math.max(0, Math.cos(lat) * r), y + Math.sin(lat) * r]);
    }
    prof[0][0] = 0; prof[rings][0] = 0;
    return this.lathe(x, z, prof, seg, { capTop: false });
  }

  // connect consecutive rings of points (same count, ordered counter-clockwise when looking from ring 0
  // towards the last ring) with quads; optional flat caps. Used for fuselages, roofs, hulls.
  loft(rings, { capStart = false, capEnd = false, closed = true } = {}) {
    const n = rings[0].length;
    let v = 0;
    for (let k = 0; k < rings.length - 1; k++) {
      const A = rings[k], B = rings[k + 1];
      const dv = Math.hypot(B[0][0] - A[0][0], B[0][1] - A[0][1], B[0][2] - A[0][2]);
      let u = 0;
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const j = (i + 1) % n;
        const du = Math.hypot(A[j][0] - A[i][0], A[j][1] - A[i][1], A[j][2] - A[i][2]);
        this.face([A[i], B[i], B[j], A[j]], [[u, v], [u, v + dv], [u + du, v + dv], [u + du, v]]);
        u += du;
      }
      v += dv;
    }
    const fan = (R, rev) => {
      let cx = 0, cy = 0, cz = 0;
      for (const p of R) { cx += p[0]; cy += p[1]; cz += p[2]; }
      const c = [cx / n, cy / n, cz / n];
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (rev) this.face([c, R[j], R[i]], null); else this.face([c, R[i], R[j]], null); }
    };
    if (capStart) fan(rings[0], false);
    if (capEnd) fan(rings[rings.length - 1], true);
    return this;
  }

  // straight member between two local points with a w x h rectangular section (crane lattice, rails, masts)
  beam(ax, ay, az, bx, by, bz, w = 0.4, h = w, faces = 0b111111) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return this;
    // local frame: f = along, s = side (horizontal), t = f x s
    const fx = dx / L, fy = dy / L, fz = dz / L;
    let sx = -fz, sy = 0, sz = fx;
    let sl = Math.hypot(sx, sz);
    if (sl < 1e-4) { sx = 1; sz = 0; sl = 1; }
    sx /= sl; sz /= sl;
    const tx = fy * sz - fz * sy, ty = fz * sx - fx * sz, tz = fx * sy - fy * sx;
    const hw = w / 2, hh = h / 2;
    const P = (t, a, b) => [ax + dx * t + sx * a + tx * b, ay + dy * t + sy * a + ty * b, az + dz * t + sz * a + tz * b];
    const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (let i = 0; i < 4; i++) {
      if (!(faces & (1 << i))) continue;
      const [a0, b0] = c[i], [a1, b1] = c[(i + 1) % 4];
      this.face([P(0, a0, b0), P(1, a0, b0), P(1, a1, b1), P(0, a1, b1)].reverse(), [[0, 0], [L, 0], [L, 1], [0, 1]]);
    }
    if (faces & 0b10000) this.face([P(0, -hw, -hh), P(0, -hw, hh), P(0, hw, hh), P(0, hw, -hh)], null);
    if (faces & 0b100000) this.face([P(1, -hw, -hh), P(1, hw, -hh), P(1, hw, hh), P(1, -hw, hh)], null);
    return this;
  }

  // barrel vault along local z from z0 to z1, spanning x0..x1, springing at y0, rise above that.
  // ends: closed gable-like arch ends. Optional wall height below the springing line.
  vault(x0, x1, z0, z1, y0, rise, seg = 8, { ends = true, walls = 0 } = {}) {
    const cx = (x0 + x1) / 2, hw = (x1 - x0) / 2;
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const t = Math.PI - (i / seg) * Math.PI;
      pts.push([cx + Math.cos(t) * hw, y0 + Math.sin(t) * rise]);
    }
    let u = 0;
    for (let i = 0; i < seg; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const L = Math.hypot(bx - ax, by - ay);
      this.face([[ax, ay, z1], [bx, by, z1], [bx, by, z0], [ax, ay, z0]], [[u, z1], [u + L, z1], [u + L, z0], [u, z0]]);
      u += L;
    }
    if (walls > 0) {
      this.wall(x0, z1, x0, z0, y0 - walls, y0, 0, y0 - walls);
      this.wall(x1, z0, x1, z1, y0 - walls, y0, 0, y0 - walls);
    }
    if (ends) {
      for (const [z, s] of [[z1, 1], [z0, -1]]) {
        for (let i = 0; i < seg; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
          const A = [ax, ay, z], B = [bx, by, z], C = [cx, y0 - walls, z];
          if (s > 0) this.face([C, B, A], [[cx - x0, 0], [bx - x0, by - y0 + walls], [ax - x0, ay - y0 + walls]]);
          else this.face([C, A, B], [[cx - x0, 0], [ax - x0, ay - y0 + walls], [bx - x0, by - y0 + walls]]);
        }
        if (walls > 0) {
          if (s > 0) this.face([[x0, y0 - walls, z], [x1, y0 - walls, z], [x1, y0, z], [x0, y0, z]], null);
          else this.face([[x0, y0 - walls, z], [x0, y0, z], [x1, y0, z], [x1, y0 - walls, z]], null);
        }
      }
    }
    return this;
  }

  // flat ribbon lying on a surface: path [[x,z],...] (local), width w, height function y(x,z) (world coords!)
  // used for ground paint; written with an identity transform expected.
  ribbon(path, w, yAt, lift = 0.06, step = 6) {
    const hw = w / 2;
    let u = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-4) continue;
      const nx = -(bz - az) / L * hw, nz = (bx - ax) / L * hw;
      const n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
        const p = [[x0 - nx, z0 - nz], [x0 + nx, z0 + nz], [x1 + nx, z1 + nz], [x1 - nx, z1 - nz]];
        this.face(p.map(([x, z]) => [x, yAt(x, z) + lift, z]), [[u + L * t0, 0], [u + L * t0, w], [u + L * t1, w], [u + L * t1, 0]]);
      }
      u += L;
    }
    return this;
  }

  // ---------- colliders (world space, via the transform's translation + yaw) ----------
  colBox(x0, y0, z0, x1, y1, z1) {
    if (!this.colliders) return this;
    const c = this.world((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.colliders.box(c[0], c[1], c[2], Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, this.yaw, this.colTag);
    return this;
  }
  colCyl(x, z, y0, y1, r) {
    if (!this.colliders) return this;
    const c = this.world(x, (y0 + y1) / 2, z);
    this.colliders.cyl(c[0], c[1], c[2], r, (y1 - y0) / 2, this.colTag);
    return this;
  }
  // convex hull of a local polygon extruded y0..y1
  colPrism(poly, y0, y1) {
    if (!this.colliders) return this;
    const pts = [];
    for (const [x, z] of poly) { pts.push(...this.world(x, y0, z), ...this.world(x, y1, z)); }
    this.colliders.hull(pts, this.colTag);
    return this;
  }
}

const ZERO2 = [0, 0];

// ---------- 2D helpers ----------
export function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length]; a += x0 * z1 - x1 * z0; }
  return a / 2;
}
// walls are emitted with outward normals for polygons with positive shoelace area in (x,z)
export function cw(p) { return signedArea(p) < 0 ? p.slice().reverse() : p; }

export function triangulate(P) {
  try {
    return THREE.ShapeUtils.triangulateShape(P.map(([x, z]) => new THREE.Vector2(x, z)), []);
  } catch { return []; }
}

export function centroid(p) {
  let x = 0, z = 0;
  for (const q of p) { x += q[0]; z += q[1]; }
  return [x / p.length, z / p.length];
}

export function hull2d(points) {
  const p = points.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// minimum-area oriented rectangle of a point set: {cx, cz, yaw, len (along yaw dir), wid}
// yaw follows the Builder convention: local +x maps to (cos yaw, -sin yaw) in world xz.
export function obb(points) {
  const h = hull2d(points);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i], [bx, bz] = h[(i + 1) % h.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of h) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { A, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, len: u1 - u0, wid: v1 - v0 };
    }
  }
  if (!best) return null;
  // make len the longer side
  if (best.wid > best.len) { const t = best.len; best.len = best.wid; best.wid = t; const ux = best.ux; best.ux = -best.uz; best.uz = ux; }
  best.yaw = Math.atan2(-best.uz, best.ux);
  return best;
}

// point in polygon
export function inside(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

// rounded rectangle / superellipse outline centred at 0 (n points), useful for stadium bowls & arenas
export function superellipse(a, b, n = 32, e = 2.5) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    out.push([a * Math.sign(c) * Math.pow(Math.abs(c), 2 / e), b * Math.sign(s) * Math.pow(Math.abs(s), 2 / e)]);
  }
  return out;
}

// polygon offset (positive = outward for any winding), simple miter with clamp
export function offsetPoly(poly, d) {
  const P = cw(poly), n = P.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n];
    const ax = p1[0] - p0[0], az = p1[1] - p0[1], bx = p2[0] - p1[0], bz = p2[1] - p1[1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    // outward normals for positive-area polygons: (dz, -dx)? walls use (a->b) with outward = right side
    const n1x = az / la, n1z = -ax / la, n2x = bz / lb, n2z = -bx / lb;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const cosh = Math.max(0.35, mx * n1x + mz * n1z);
    out.push([p1[0] - mx * d / cosh, p1[1] - mz * d / cosh]);
  }
  return out;
}
