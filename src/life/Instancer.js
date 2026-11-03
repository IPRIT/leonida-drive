import * as THREE from 'three';

const CELL = 128;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

// Distance-streamed static instances (one InstancedMesh = one draw call). All matrices are precomputed at init;
// a refresh (only when the viewer moved > `moveStep` m, every `refresh` s, or after hide/show) packs the instances of
// the grid cells inside `radius` into the mesh. No per-frame allocations.
export class Instancer {
  constructor(parent, geometry, material, {
    capacity = 2000, radius = 900, castShadow = false, receiveShadow = true, colors = true,
    data = null, refresh = 1.0, moveStep = 25, name = 'life', renderOrder = 0, dynamic = 0,
  } = {}) {
    capacity += dynamic;
    this.radius = radius;
    this.refresh = refresh;
    this.moveStep = moveStep;
    this.dataName = data;
    const geo = data ? geometry.clone() : geometry;
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = receiveShadow;
    this.mesh.renderOrder = renderOrder;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colors) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    if (data) {
      this.dataAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      this.dataAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(data, this.dataAttr);
    }
    this.capacity = capacity;
    parent.add(this.mesh);
    this._M = []; this._C = []; this._D = []; this._P = [];
    this.count = 0;
    this.cells = new Map();
    this.hidden = null; // Uint8Array after finalize
    this._lx = 1e9; this._lz = 1e9;
    this._timer = 0;
    this.dirty = true;
    const bb = (geometry.boundingBox || (geometry.computeBoundingBox(), geometry.boundingBox));
    this._top = bb.max.y;
    // dynamic overlay (tumbling pieces): matrices written every frame after the static instances
    this.dynCap = dynamic;
    this.dynM = new Float32Array(Math.max(1, dynamic) * 16);
    this.dynC = new Float32Array(Math.max(1, dynamic) * 3);
    this.dynN = 0;
    this.staticK = 0;
  }

  // n dynamic instances from dynM / dynC (filled by the caller) are drawn after the static ones
  setDynamic(n) {
    n = Math.min(n, this.dynCap);
    if (n === 0 && this.dynN === 0) return;
    this.dynN = n;
    this._flushDyn();
  }

  _flushDyn() {
    const k = this.staticK, n = this.dynN;
    if (k + n > this.capacity) return;
    const im = this.mesh.instanceMatrix, dst = im.array, M = this.dynM;
    for (let i = 0; i < n * 16; i++) dst[k * 16 + i] = M[i];
    if (n) { im.addUpdateRange(k * 16, n * 16); im.needsUpdate = true; }
    const ic = this.mesh.instanceColor;
    if (ic && n) {
      for (let i = 0; i < n * 3; i++) ic.array[k * 3 + i] = this.dynC[i];
      ic.addUpdateRange(k * 3, n * 3); ic.needsUpdate = true;
    }
    this.mesh.count = k + n;
  }

  // yaw: rotation about +Y (radians); pitch/roll optional; sx/sy/sz scale; color hex; data [a,b,c,d]
  add(x, y, z, yaw = 0, sx = 1, sy = sx, sz = sx, color = 0xffffff, data = null, pitch = 0, roll = 0) {
    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    const e = _m.elements;
    for (let i = 0; i < 16; i++) this._M.push(e[i]);
    _c.set(color);
    this._C.push(_c.r, _c.g, _c.b);
    if (data) this._D.push(data[0] || 0, data[1] || 0, data[2] || 0, data[3] || 0); else this._D.push(0, 0, 0, 0);
    this._P.push(x, y, z);
    const key = Math.floor(x / CELL) * 65536 + Math.floor(z / CELL);
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { cx: Math.floor(x / CELL) * CELL, cz: Math.floor(z / CELL) * CELL, idx: [] }));
    c.idx.push(this.count);
    return this.count++;
  }

  finalize() {
    this.M = Float32Array.from(this._M);
    this.C = Float32Array.from(this._C);
    this.D = Float32Array.from(this._D);
    this.P = Float32Array.from(this._P);
    this._M = this._C = this._D = this._P = null;
    this.hidden = new Uint8Array(this.count);
    this.cellList = [...this.cells.values()].map((c) => ({ cx: c.cx, cz: c.cz, idx: Int32Array.from(c.idx) }));
    return this;
  }

  setHidden(i, on) {
    if (!this.hidden || i < 0 || i >= this.count) return;
    const v = on ? 1 : 0;
    if (this.hidden[i] !== v) { this.hidden[i] = v; this.dirty = true; }
  }

  // change the per-instance colour of instance i (takes effect on the next refresh)
  setColor(i, hex) {
    _c.set(hex);
    this.C[i * 3] = _c.r; this.C[i * 3 + 1] = _c.g; this.C[i * 3 + 2] = _c.b;
    this.dirty = true;
  }

  setData(i, a, b, c, d) {
    const D = this.D;
    if (a !== undefined) D[i * 4] = a;
    if (b !== undefined) D[i * 4 + 1] = b;
    if (c !== undefined) D[i * 4 + 2] = c;
    if (d !== undefined) D[i * 4 + 3] = d;
    this.dirty = true;
  }

  // indices within r of (x,z) (allocates: init / low-rate use only)
  near(x, z, r, out = []) {
    const P = this.P, r2 = r * r;
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
        const c = this.cells.get(i * 65536 + j);
        if (!c) continue;
        for (const id of c.idx) {
          const dx = P[id * 3] - x, dz = P[id * 3 + 2] - z;
          if (dx * dx + dz * dz <= r2) out.push(id);
        }
      }
    }
    return out;
  }

  update(px, pz, dt, force = false) {
    if (!this.cellList) return false;
    this._timer -= dt;
    const dx = px - this._lx, dz = pz - this._lz;
    if (!force && !this.dirty && this._timer > 0 && dx * dx + dz * dz < this.moveStep * this.moveStep) return false;
    this._timer = this.refresh;
    this._lx = px; this._lz = pz;
    this.dirty = false;
    const R = this.radius, R2 = R * R;
    const M = this.M, C = this.C, D = this.D, H = this.hidden;
    const dst = this.mesh.instanceMatrix.array;
    const dcol = this.mesh.instanceColor ? this.mesh.instanceColor.array : null;
    const ddat = this.dataAttr ? this.dataAttr.array : null;
    const cap = this.capacity - this.dynCap;
    let k = 0;
    const cells = this.cellList;
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      const ex = Math.max(c.cx - px, 0, px - c.cx - CELL);
      const ez = Math.max(c.cz - pz, 0, pz - c.cz - CELL);
      if (ex * ex + ez * ez > R2) continue;
      const idx = c.idx;
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j];
        if (H[i] || k >= cap) continue;
        const so = i * 16, d = k * 16;
        for (let q = 0; q < 16; q++) dst[d + q] = M[so + q];
        if (dcol) { dcol[k * 3] = C[i * 3]; dcol[k * 3 + 1] = C[i * 3 + 1]; dcol[k * 3 + 2] = C[i * 3 + 2]; }
        if (ddat) { ddat[k * 4] = D[i * 4]; ddat[k * 4 + 1] = D[i * 4 + 1]; ddat[k * 4 + 2] = D[i * 4 + 2]; ddat[k * 4 + 3] = D[i * 4 + 3]; }
        k++;
      }
    }
    this.mesh.count = k;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, k * 16); im.needsUpdate = true;
    if (dcol) { const a = this.mesh.instanceColor; a.clearUpdateRanges(); a.addUpdateRange(0, k * 3); a.needsUpdate = true; }
    if (ddat) { const a = this.dataAttr; a.clearUpdateRanges(); a.addUpdateRange(0, k * 4); a.needsUpdate = true; }
    this.staticK = k;
    if (this.dynN) this._flushDyn();
    return true;
  }
}
