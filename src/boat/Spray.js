// Pooled water/dust particles (spray, mist, splash, dust, smoke) and a fading foam-wake ribbon on the sea surface.
// One instance per scene, shared by all boats and aircraft. Uses game.fx when the FX workstream provides it.
import * as THREE from 'three';

const KIND = { spray: 0, mist: 1, splash: 2, dust: 3, smoke: 4, trail: 5 };
const COLORS = [[0.92, 0.96, 1.0], [0.9, 0.94, 0.98], [0.95, 0.98, 1.0], [0.62, 0.54, 0.42], [0.16, 0.15, 0.15], [0.97, 0.97, 0.97]];
const GRAV = [1, 0.06, 1, -0.04, -0.12, -0.004];
const DRAG = [0.6, 1.4, 0.4, 1.6, 0.8, 0.35];
const GROW = [0.8, 2.2, 1.0, 2.5, 2.0, 4.0];

const _cache = new WeakMap();

export class SprayFX {
  static get(scene) {
    let s = _cache.get(scene);
    if (!s) { s = new SprayFX(scene); _cache.set(scene, s); }
    return s;
  }

  constructor(scene, max = 2400) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.data = new Float32Array(max * 4); // size, alpha, kind, unused
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.next = 0;
    this.alive = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aData', this.aData);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.uniforms = {
      uScale: { value: 600 },
      uColors: { value: COLORS.map((c) => new THREE.Vector3(...c)) },
      uLight: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute vec4 aData; uniform float uScale; uniform vec3 uColors[6]; uniform float uLight;
        varying vec4 vCol;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aData.x * uScale / max(0.5, -mv.z);
          int k = int(aData.z + 0.5);
          vec3 c = uColors[0];
          if (k == 1) c = uColors[1]; else if (k == 2) c = uColors[2]; else if (k == 3) c = uColors[3]; else if (k == 4) c = uColors[4]; else if (k == 5) c = uColors[5];
          vCol = vec4(c * uLight, aData.y);
        }`,
      fragmentShader: /* glsl */`
        varying vec4 vCol;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          gl_FragColor = vec4(vCol.rgb, vCol.a * (1.0 - r) * (1.0 - r));
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);
    for (let i = 0; i < max; i++) this.data[i * 4 + 1] = 0;
    this.foam = new FoamTrail(scene);
  }

  emit(kind, x, y, z, vx, vy, vz, size = 0.5, life = 1, alpha = 0.8) {
    const k = KIND[kind] ?? 0;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = size; this.alpha0[i] = alpha;
    this.kind[i] = k;
    this.data[i * 4] = size; this.data[i * 4 + 1] = alpha; this.data[i * 4 + 2] = k;
  }

  /** Burst of splash droplets + mist ring (strength 0..1). */
  splash(x, y, z, strength = 0.5, vx = 0, vz = 0) {
    const n = Math.round(10 + strength * 70);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random();
      const up = 3 + Math.random() * 9 * strength;
      this.emit('splash', x + Math.cos(a) * r, y + 0.1, z + Math.sin(a) * r, Math.cos(a) * (1 + r * 4 * strength) + vx * 0.2, up, Math.sin(a) * (1 + r * 4 * strength) + vz * 0.2, 0.5 + strength * 0.9, 1.0 + Math.random() * 0.6, 0.85);
    }
    for (let i = 0; i < n / 3; i++) {
      const a = Math.random() * Math.PI * 2;
      this.emit('mist', x + Math.cos(a) * 1.5, y + 0.4, z + Math.sin(a) * 1.5, Math.cos(a) * 2, 0.6, Math.sin(a) * 2, 1.5 + strength * 2, 1.6 + Math.random(), 0.35);
    }
  }

  update(dt, camera, heightPx, night = 0) {
    this.uniforms.uScale.value = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.uniforms.uLight.value = 1 - night * 0.75;
    const P = this.pos, V = this.vel, D = this.data;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { D[i * 4 + 1] = 0; continue; }
      alive++;
      const k = this.kind[i];
      const t = 1 - this.life[i] / this.maxLife[i];
      const drag = Math.exp(-DRAG[k] * dt);
      V[i * 3] *= drag; V[i * 3 + 2] *= drag;
      V[i * 3 + 1] = V[i * 3 + 1] * drag - 9.81 * GRAV[k] * dt;
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
      if ((k === 0 || k === 2) && P[i * 3 + 1] < -0.05 && V[i * 3 + 1] < 0) { this.life[i] = Math.min(this.life[i], 0.12); }
      D[i * 4] = this.size0[i] * (1 + GROW[k] * t);
      D[i * 4 + 1] = this.alpha0[i] * (1 - t) * Math.min(1, t * 8 + 0.3);
    }
    this.alive = alive;
    this.aPos.needsUpdate = true;
    this.aData.needsUpdate = true;
    this.foam.update(dt, night);
  }
}

/** Foam ribbons on the water surface (y slightly above sea level), widening and fading with age. */
export class FoamTrail {
  constructor(scene, maxQuads = 1800) {
    this.maxQuads = maxQuads;
    const nv = maxQuads * 4;
    this.center = new Float32Array(nv * 3);
    this.side = new Float32Array(nv * 3);
    this.params = new Float32Array(nv * 3); // birth, width0, strength
    const idx = new Uint32Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const v = q * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }
    const g = new THREE.BufferGeometry();
    this.aCenter = new THREE.BufferAttribute(this.center, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSide = new THREE.BufferAttribute(this.side, 3).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.BufferAttribute(this.params, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aCenter);
    g.setAttribute('aSide', this.aSide);
    g.setAttribute('aParams', this.aParams);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    for (let i = 0; i < nv; i++) this.params[i * 3] = -1e6;
    this.uniforms = { uTime: { value: 0 }, uLife: { value: 9 }, uSpread: { value: 0.55 }, uLight: { value: 1 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      vertexShader: /* glsl */`
        attribute vec3 aSide; attribute vec3 aParams; uniform float uTime; uniform float uLife; uniform float uSpread;
        varying float vA; varying vec2 vW;
        void main() {
          float age = uTime - aParams.x;
          float w = aParams.y + age * uSpread;
          vec3 p = position + aSide * w;
          vA = aParams.z * clamp(1.0 - age / uLife, 0.0, 1.0);
          vW = p.xz;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uLight; varying float vA; varying vec2 vW;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        void main() {
          float foam = smoothstep(0.35, 0.75, n(vW * 1.3) * 0.6 + n(vW * 4.1) * 0.4);
          float a = vA * (0.35 + 0.65 * foam);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.95, 0.98, 1.0) * uLight, a);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.next = 0;
    this.trails = new Map();
    this.dirty = false;
  }

  /** Add a point to trail `id` at (x, z) with heading direction (dx, dz), half width and strength 0..1. */
  add(id, x, y, z, dx, dz, halfW, strength) {
    const t = this.uniforms.uTime.value;
    let tr = this.trails.get(id);
    if (!tr) { tr = { x, y, z, sx: -dz, sz: dx, w: halfW, s: strength, t, live: true }; this.trails.set(id, tr); return; }
    const d = Math.hypot(x - tr.x, z - tr.z);
    if (d < 0.9) return;
    if (d > 12 || !tr.live) { Object.assign(tr, { x, y, z, sx: -dz, sz: dx, w: halfW, s: strength, t, live: true }); return; }
    const l = Math.hypot(dx, dz) || 1;
    const sx = -dz / l, sz = dx / l;
    const q = this.next;
    this.next = (this.next + 1) % this.maxQuads;
    const v = q * 4;
    const put = (vi, cx, cy, cz, ssx, ssz, sign, birth, w, s) => {
      this.center.set([cx, cy, cz], vi * 3);
      this.side.set([ssx * sign, 0, ssz * sign], vi * 3);
      this.params.set([birth, w, s], vi * 3);
    };
    put(v, tr.x, tr.y, tr.z, tr.sx, tr.sz, -1, tr.t, tr.w, tr.s);
    put(v + 1, tr.x, tr.y, tr.z, tr.sx, tr.sz, 1, tr.t, tr.w, tr.s);
    put(v + 2, x, y, z, sx, sz, -1, t, halfW, strength);
    put(v + 3, x, y, z, sx, sz, 1, t, halfW, strength);
    Object.assign(tr, { x, y, z, sx, sz, w: halfW, s: strength, t });
    this.dirty = true;
  }

  end(id) {
    const tr = this.trails.get(id);
    if (tr) tr.live = false;
  }

  remove(id) { this.trails.delete(id); }

  update(dt, night = 0) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uLight.value = 1 - night * 0.7;
    if (this.dirty) {
      this.aCenter.needsUpdate = true;
      this.aSide.needsUpdate = true;
      this.aParams.needsUpdate = true;
      this.dirty = false;
    }
  }
}
