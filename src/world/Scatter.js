import * as THREE from 'three';

const CELL = 256;

// Instanced scatter of many static props. All instance matrices are precomputed; every refresh the
// instances of cells inside radius & frustum are packed into one InstancedMesh (1 draw call per type).
export class Scatter {
  constructor(scene, geometry, material, { capacity = 40000, radius = 1600, castShadow = true, shadowRadius = 160 } = {}) {
    this.geometry = geometry;
    this.radius = radius;
    this.shadowRadius = shadowRadius;
    this.cells = new Map(); // key -> {minY,maxY,cx,cz, idx: []}
    this.mats = []; // Float32Array chunks of 16 floats
    this.colors = [];
    this.count = 0;
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._last = new THREE.Vector3(1e9, 0, 0);
    this._lastDir = new THREE.Vector3();
    this._timer = 0;
    this.hidden = new Set();
  }

  // finalize after adding all instances
  add(x, y, z, rotY, scale, color = 0xffffff, sy = scale) {
    const key = Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { minY: y, maxY: y, cx: Math.floor(x / CELL) * CELL, cz: Math.floor(z / CELL) * CELL, idx: [] }));
    c.minY = Math.min(c.minY, y);
    c.maxY = Math.max(c.maxY, y + 15 * sy);
    c.idx.push(this.count);
    this.mats.push(x, y, z, rotY, scale, sy);
    const col = new THREE.Color(color);
    this.colors.push(col.r, col.g, col.b);
    this.count++;
    return this.count - 1;
  }

  finalize() {
    this.raw = Float32Array.from(this.mats);
    this.rawCol = Float32Array.from(this.colors);
    this.mats = this.colors = null;
    // precompute full matrices
    const n = this.count;
    this.M = new Float32Array(n * 16);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const r = this.raw;
      p.set(r[i * 6], r[i * 6 + 1], r[i * 6 + 2]);
      q.setFromAxisAngle(up, r[i * 6 + 3]);
      s.set(r[i * 6 + 4], r[i * 6 + 5], r[i * 6 + 4]);
      m.compose(p, q, s);
      m.toArray(this.M, i * 16);
    }
    this.cellList = [...this.cells.values()];
  }

  position(i, out) { return out.set(this.raw[i * 6], this.raw[i * 6 + 1], this.raw[i * 6 + 2]); }

  update(camera, dt, force = false) {
    this._timer -= dt;
    const p = camera.position;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    if (!force && this._timer > 0 && p.distanceToSquared(this._last) < 400 && dir.dot(this._lastDir) > 0.995) return;
    this._timer = 0.25;
    this._last.copy(p);
    this._lastDir.copy(dir);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    const R = this.radius, R2 = R * R, SR = this.shadowRadius;
    const dst = this.mesh.instanceMatrix.array;
    const dcol = this.mesh.instanceColor.array;
    let k = 0;
    const cap = this.capacity;
    for (const c of this.cellList) {
      const dx = Math.max(c.cx - p.x, 0, p.x - c.cx - CELL);
      const dz = Math.max(c.cz - p.z, 0, p.z - c.cz - CELL);
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      if (d2 > SR * SR) {
        this._box.min.set(c.cx, c.minY - 2, c.cz);
        this._box.max.set(c.cx + CELL, c.maxY + 5, c.cz + CELL);
        if (!this._frustum.intersectsBox(this._box)) continue;
      }
      // thin out far cells
      const far = Math.sqrt(d2) / R;
      const stride = far > 0.7 ? 3 : far > 0.45 ? 2 : 1;
      const idx = c.idx;
      for (let j = 0; j < idx.length; j += stride) {
        const i = idx[j];
        if (this.hidden.size && this.hidden.has(i)) continue;
        if (k >= cap) break;
        dst.set(this.M.subarray(i * 16, i * 16 + 16), k * 16);
        dcol[k * 3] = this.rawCol[i * 3]; dcol[k * 3 + 1] = this.rawCol[i * 3 + 1]; dcol[k * 3 + 2] = this.rawCol[i * 3 + 2];
        k++;
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, k * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.clearUpdateRanges();
    this.mesh.instanceColor.addUpdateRange(0, k * 3);
    this.mesh.instanceColor.needsUpdate = true;
  }

  // indices of instances within r of (x,z)
  near(x, z, r, out = []) {
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const c = this.cells.get(i * 100000 + j);
      if (!c) continue;
      for (const id of c.idx) {
        const dx = this.raw[id * 6] - x, dz = this.raw[id * 6 + 2] - z;
        if (dx * dx + dz * dz <= r * r) out.push(id);
      }
    }
    return out;
  }
}

export function swayMaterial(uniforms, { amp = 0.12, color = 0xffffff, side = THREE.FrontSide } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, color, side });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float ph = ip.x * 0.11 + ip.z * 0.07;
          float hgt = max(position.y, 0.0);
          float sw = hgt * hgt * ${amp.toFixed(3)} * 0.02;
          transformed.x += sin(uTime * 1.4 + ph) * sw;
          transformed.z += cos(uTime * 1.1 + ph * 1.3) * sw * 0.7;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'sway' + amp;
  return mat;
}
