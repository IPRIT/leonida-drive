import * as THREE from 'three';

const _inv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _box = new THREE.Box3();
const OWNER = new WeakMap(); // geometry -> deformer that owns it (clone shared geometry on first claim)
const OFF = 512;

/** Default bin cell (m) and bin key, exported for code that pre-builds bins (see setBins). */
export const DEFORM_CELL = 0.4;
export function binKey(ix, iy, iz) { return ((ix + OFF) * 1024 + (iy + OFF)) * 1024 + (iz + OFF); }

/** Per-vertex jitter (h1, h2-0.5, h3-0.5, h4-0.5) of original positions o for vertices [i0, i1) into out (n×4). */
export function jitterRange(o, out, i0, i1) {
  for (let i = i0; i < i1; i++) {
    const i3 = i * 3, i4 = i * 4;
    const hx = Math.round(o[i3] * 200), hy = Math.round(o[i3 + 1] * 200), hz = Math.round(o[i3 + 2] * 200);
    out[i4] = hash3(hx, hy, hz); out[i4 + 1] = hash3(hz, hx, hy) - 0.5; out[i4 + 2] = hash3(hy, hz, hx) - 0.5; out[i4 + 3] = hash3(hx + 7, hy - 3, hz + 11) - 0.5;
  }
  return out;
}

function hash3(x, y, z) {
  let h = Math.imul((x * 73856093) | 0, 0x27d4eb2d) ^ Math.imul((y * 19349663) | 0, 0x165667b1) ^ Math.imul((z * 83492791) | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

// Crumple deformation of a set of meshes (in the space of a root Object3D).
// Vertices are binned per mesh on a coarse grid (original positions), so one impact touches only nearby vertices.
export class Deformer {
  /**
   * @param {THREE.Object3D} root vehicle root (impact points/directions are given in its local space)
   * @param {THREE.Mesh[]} meshes
   * @param {{maxCrumple?:number, cell?:number}} o
   */
  constructor(root, meshes, { maxCrumple = 0.35, cell = DEFORM_CELL } = {}) {
    this.root = root;
    this.maxCrumple = maxCrumple;
    this.cell = cell;
    this.entries = [];
    root.updateMatrixWorld(true);
    _inv.copy(root.matrixWorld).invert();
    for (const mesh of meshes) {
      let geo = mesh.geometry;
      const pos = geo?.attributes?.position;
      if (!pos || pos.count < 3) continue;
      const owner = OWNER.get(geo);
      if (owner && owner !== this) { geo = mesh.geometry = geo.clone(); }
      else if (owner === this) { geo = mesh.geometry = geo.clone(); }
      OWNER.set(geo, this);
      const attr = geo.attributes.position;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      if (!geo.boundingBox) geo.computeBoundingBox();
      const e = {
        mesh, geo, attr, orig: attr.array.slice(), bins: null,
        sphere: geo.boundingSphere.clone(), flat: !!mesh.material?.flatShading, dirty: false,
      };
      e.sphere.radius += maxCrumple;
      geo.boundingSphere.radius += maxCrumple;
      this.entries.push(e);
    }
  }

  /** Bounding box of all meshes in root space. */
  bounds(out = new THREE.Box3()) {
    out.makeEmpty();
    this.root.updateMatrixWorld(true);
    _inv.copy(this.root.matrixWorld).invert();
    for (const e of this.entries) {
      _rel.multiplyMatrices(_inv, e.mesh.matrixWorld);
      _box.copy(e.geo.boundingBox).applyMatrix4(_rel);
      out.union(_box);
    }
    return out;
  }

  _bins(e) {
    if (e.bins) return e.bins;
    const bins = new Map();
    const a = e.orig, s = 1 / this.cell;
    const n = a.length / 3;
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let i = 0; i < n; i++) {
      const ix = Math.floor(a[i * 3] * s), iy = Math.floor(a[i * 3 + 1] * s), iz = Math.floor(a[i * 3 + 2] * s);
      if (ix < x0) x0 = ix; if (ix > x1) x1 = ix;
      if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
      if (iz < z0) z0 = iz; if (iz > z1) z1 = iz;
      const k = ((ix + OFF) * 1024 + (iy + OFF)) * 1024 + (iz + OFF);
      let l = bins.get(k);
      if (!l) bins.set(k, (l = []));
      l.push(i);
    }
    for (const [k, l] of bins) bins.set(k, Int32Array.from(l));
    e.range = [x0, x1, y0, y1, z0, z1];
    if (!e.jit) e.jit = jitterRange(a, new Float32Array(n * 4), 0, n);
    return (e.bins = bins);
  }

  /**
   * Use vertex bins built elsewhere for this mesh (same cell size, built from its current = original positions),
   * e.g. a template shared by many copies of one geometry. Bins are only read, never modified.
   */
  setBins(mesh, bins, range, jit = null) {
    for (const e of this.entries) if (e.mesh === mesh) { e.bins = bins; e.range = range; if (jit) { e.jit = jit; e.jitShared = true; } }
  }

  /**
   * Collapse vertices (indices into `mesh`'s position attribute) onto one point and keep them there: the original
   * position moves too, so later impacts displace them together (removed triangles stay degenerate).
   */
  collapse(mesh, indices, point) {
    for (const e of this.entries) {
      if (e.mesh !== mesh) continue;
      const p = e.attr.array, o = e.orig;
      if (e.jit && e.jitShared) { e.jit = e.jit.slice(); e.jitShared = false; } // copy-on-write (template jitter)
      const J = e.jit;
      for (let q = 0; q < indices.length; q++) {
        const i3 = indices[q] * 3;
        p[i3] = o[i3] = point.x; p[i3 + 1] = o[i3 + 1] = point.y; p[i3 + 2] = o[i3 + 2] = point.z;
        if (J) { const i4 = indices[q] * 4; J[i4] = 0.5; J[i4 + 1] = J[i4 + 2] = J[i4 + 3] = 0; }
      }
      e.attr.needsUpdate = true;
      e.dirty = true;
    }
  }

  /**
   * Swap `mesh` to an undeformed refined copy of its shape (same surface, more vertices). Bins / jitter are rebuilt
   * lazily (warm()). Only valid before the mesh is dented. Returns the old geometry (caller disposes it).
   */
  replaceGeometry(mesh, geo) {
    for (const e of this.entries) {
      if (e.mesh !== mesh) continue;
      const old = e.geo;
      if (OWNER.get(old) === this) OWNER.delete(old);
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      if (!geo.boundingBox) geo.computeBoundingBox();
      e.sphere = geo.boundingSphere.clone();
      e.sphere.radius += this.maxCrumple;
      geo.boundingSphere.radius += this.maxCrumple;
      e.geo = geo;
      e.attr = geo.attributes.position;
      e.orig = e.attr.array.slice();
      e.bins = null; e.range = null; e.jit = null; e.jitShared = false; e.dirty = false;
      OWNER.set(geo, this);
      mesh.geometry = geo;
      return old;
    }
    return null;
  }

  /** Pre-build vertex bins within a time budget (call per frame after spawn). Returns true when done. */
  warm(budgetMs = 0.5) {
    const t0 = performance.now();
    for (const e of this.entries) {
      if (e.bins) continue;
      this._bins(e);
      if (performance.now() - t0 > budgetMs) return false;
    }
    return true;
  }

  /**
   * Push vertices within `radius` of `point` along `dir` (root space, dir = into the body).
   * depth: max displacement at the centre (m). Returns touched vertex count.
   */
  deform(point, dir, radius, depth, { noise = 0.35 } = {}) {
    const root = this.root;
    root.updateMatrixWorld(true);
    const maxC = this.maxCrumple, maxC2 = maxC * maxC;
    const cs = this.cell, s = 1 / cs;
    const R2 = radius * radius;
    let touched = 0;
    for (const e of this.entries) {
      if (e.skip || !e.mesh.parent) continue; // detached part flying away
      _inv.copy(e.mesh.matrixWorld).invert().multiply(root.matrixWorld); // root -> mesh
      _c.copy(point).applyMatrix4(_inv);
      _d.copy(dir).transformDirection(_inv);
      if (_c.distanceTo(e.sphere.center) > e.sphere.radius + radius) continue;
      const bins = this._bins(e);
      const pad = radius + maxC, rg = e.range;
      const x0 = Math.max(rg[0], Math.floor((_c.x - pad) * s)), x1 = Math.min(rg[1], Math.floor((_c.x + pad) * s));
      const y0 = Math.max(rg[2], Math.floor((_c.y - pad) * s)), y1 = Math.min(rg[3], Math.floor((_c.y + pad) * s));
      const z0 = Math.max(rg[4], Math.floor((_c.z - pad) * s)), z1 = Math.min(rg[5], Math.floor((_c.z + pad) * s));
      if (x0 > x1 || y0 > y1 || z0 > z1) continue;
      const p = e.attr.array, o = e.orig, J = e.jit;
      let any = false;
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
        const l = bins.get(((ix + OFF) * 1024 + (iy + OFF)) * 1024 + (iz + OFF));
        if (!l) continue;
        for (let q = 0; q < l.length; q++) {
          const i3 = l[q] * 3;
          const px = p[i3], py = p[i3 + 1], pz = p[i3 + 2];
          const dx = px - _c.x, dy = py - _c.y, dz = pz - _c.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= R2) continue;
          let w = 1 - d2 / R2;
          w *= w;
          // per-vertex jitter from the original position so duplicated (flat-shaded) vertices stay welded
          const ox = o[i3], oy = o[i3 + 1], oz = o[i3 + 2];
          let h1, h2, h3, h4;
          if (J) { const i4 = l[q] * 4; h1 = J[i4]; h2 = J[i4 + 1]; h3 = J[i4 + 2]; h4 = J[i4 + 3]; }
          else {
            const hx = Math.round(ox * 200), hy = Math.round(oy * 200), hz = Math.round(oz * 200);
            h1 = hash3(hx, hy, hz); h2 = hash3(hz, hx, hy) - 0.5; h3 = hash3(hy, hz, hx) - 0.5; h4 = hash3(hx + 7, hy - 3, hz + 11) - 0.5;
          }
          const amt = depth * w * (1 - noise * 0.5 + noise * h1);
          const j = depth * w * noise * 0.6;
          let nx = px + _d.x * amt + h2 * j, ny = py + _d.y * amt + h3 * j, nz = pz + _d.z * amt + h4 * j;
          // cumulative crumple limit
          const fx = nx - ox, fy = ny - oy, fz = nz - oz;
          const f2 = fx * fx + fy * fy + fz * fz;
          if (f2 > maxC2) {
            const k = maxC / Math.sqrt(f2);
            nx = ox + fx * k; ny = oy + fy * k; nz = oz + fz * k;
          }
          p[i3] = nx; p[i3 + 1] = ny; p[i3 + 2] = nz;
          touched++;
          any = true;
        }
      }
      if (any) {
        e.attr.needsUpdate = true;
        e.dirty = true;
        if (!e.flat) e.geo.computeVertexNormals();
      }
    }
    return touched;
  }

  /** Exclude/include all meshes under obj (detached parts). */
  setSkip(obj, on) {
    const set = new Set();
    obj.traverse((o) => set.add(o));
    for (const e of this.entries) if (set.has(e.mesh)) e.skip = on;
  }

  /** Restore the original shape. */
  reset() {
    for (const e of this.entries) {
      if (!e.dirty) continue;
      e.attr.array.set(e.orig);
      e.attr.needsUpdate = true;
      if (!e.flat) e.geo.computeVertexNormals();
      e.dirty = false;
    }
  }

  dispose() {
    for (const e of this.entries) if (OWNER.get(e.geo) === this) OWNER.delete(e.geo);
    this.entries.length = 0;
  }
}
