import * as THREE from 'three';
import { noiseTexture, FIRE_RAMP_GLSL } from './textures.js';

// GPU-friendly pooled particles: one InstancedBufferGeometry quad per system, one draw call.
// Particles are stored densely (swap-remove), CPU arrays double as instance attributes.

const VERT = /* glsl */`
  attribute vec4 iA; // xyz, size
  attribute vec4 iB; // rgb, alpha
  attribute vec4 iC; // rot, t (0..1), seed, heat
  attribute vec3 iD; // velocity (stretch)
  uniform float uStretch;
  varying vec2 vUv;
  varying vec4 vCol;
  varying vec4 vMisc;
  varying float vDepth;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vCol = iB;
    vMisc = iC;
    vec4 mvPosition = viewMatrix * vec4(iA.xyz, 1.0);
    vec2 corner = position.xy;
    float size = iA.w;
    vec2 off;
    if (uStretch > 0.0) {
      vec3 vv = (viewMatrix * vec4(iD, 0.0)).xyz;
      float L = length(vv.xy);
      vec2 dir = L > 1e-3 ? vv.xy / L : vec2(0.0, 1.0);
      float len = size + L * uStretch;
      off = dir * corner.y * len + vec2(-dir.y, dir.x) * corner.x * size;
    } else {
      float c = cos(iC.x), s = sin(iC.x);
      off = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    }
    mvPosition.xy += off;
    vDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FOG_PREMUL = /* glsl */`
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor *= 1.0 - fogF;
  #endif
`;

const FRAG_HEAD = /* glsl */`
  uniform sampler2D uNoise;
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;
  varying vec4 vCol;
  varying vec4 vMisc;
  varying float vDepth;
  #include <fog_pars_fragment>
`;

// alpha-blended smoke / dust / steam, cheap spherical lighting + fire under-glow
const FRAG_PUFF = FRAG_HEAD + /* glsl */`
  uniform vec3 uSunView;
  uniform float uAmbient;
  uniform float uSunLight;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float seed = vMisc.z, t = vMisc.y;
    vec4 n = texture2D(uNoise, vUv * 0.5 + vec2(seed * 7.13, seed * 3.71 - t * 0.15));
    float r = length(p);
    float edge = r + (n.r - 0.5) * 0.75 + (n.g - 0.5) * 0.3;
    float mask = 1.0 - smoothstep(0.35, 1.0, edge);
    float a = mask * vCol.a * smoothstep(0.4, 2.2, vDepth);
    if (a < 0.003) discard;
    vec3 nrm = normalize(vec3(p * 0.9, sqrt(max(0.05, 1.0 - r * r))));
    float lit = clamp(dot(nrm, uSunView) * 0.5 + 0.5, 0.0, 1.0);
    float shade = uAmbient + uSunLight * lit * (0.7 + 0.6 * n.b);
    vec3 col = vCol.rgb * shade;
    col += vec3(1.0, 0.36, 0.07) * vMisc.w * (1.0 - r) * 1.8;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// premultiplied flames / fireballs (blend One, OneMinusSrcAlpha => additive glow that also occludes a bit)
const FRAG_FLAME = FRAG_HEAD + FIRE_RAMP_GLSL + /* glsl */`
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float t = vMisc.y;
    float ball = step(10.0, vMisc.z);
    float seed = fract(vMisc.z);
    float heat = vMisc.w;
    float n1 = texture2D(uNoise, vec2(vUv.x * 0.7 + seed, vUv.y * 0.55 - uTime * 0.9 - seed * 3.0)).r;
    float n2 = texture2D(uNoise, vec2(vUv.x * 1.6 - seed * 2.0, vUv.y * 1.2 - uTime * 1.7 + seed)).g;
    float n = n1 * 0.65 + n2 * 0.35;
    float shape;
    if (ball > 0.5) {
      shape = 1.0 - length(p) * 1.08 + (n - 0.5) * 0.95;
    } else {
      float y = vUv.y;
      float w = mix(0.95, 0.12, y);
      shape = 1.0 - abs(p.x + (n2 - 0.5) * 0.35 * y) / max(w, 0.05) - y * 0.3 + (n - 0.5) * 1.1;
      shape *= smoothstep(1.0, 0.7, y + (n - 0.5) * 0.35) * smoothstep(0.0, 0.12, y);
    }
    float f = clamp(shape * 1.7, 0.0, 1.0);
    float h = f * heat;
    float a = f * vCol.a;
    if (a < 0.004) discard;
    vec3 col = fireRamp(h) * (0.35 + 1.5 * h * h) * uIntensity;
    gl_FragColor = vec4(col * a, a * 0.6);
    ${FOG_PREMUL}
  }
`;

// stretched sparks, glints, flashes (pure additive via premultiplied alpha = 0)
const FRAG_SPARK = FRAG_HEAD + /* glsl */`
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float g = pow(max(0.0, 1.0 - r), 1.7);
    float a = g * vCol.a;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vCol.rgb * a * uIntensity, 0.0);
    ${FOG_PREMUL}
  }
`;

const FRAGS = { puff: FRAG_PUFF, flame: FRAG_FLAME, spark: FRAG_SPARK };

export class BillboardSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {{capacity:number, kind:'puff'|'flame'|'spark', stretch?:number, renderOrder?:number, name?:string}} o
   */
  constructor(scene, o) {
    const n = (this.capacity = Math.max(16, o.capacity | 0));
    this.kind = o.kind;
    this.count = 0;
    this.iA = new Float32Array(n * 4);
    this.iB = new Float32Array(n * 4);
    this.iC = new Float32Array(n * 4);
    this.iD = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.c0 = new Float32Array(n * 3);
    this.c1 = new Float32Array(n * 3);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.delay = new Float32Array(n);
    this.heat0 = new Float32Array(n);
    this.fin = new Float32Array(n);
    this.wind = new Float32Array(n);
    this.floor = new Float32Array(n);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (arr, k) => new THREE.InstancedBufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [mk(this.iA, 4), mk(this.iB, 4), mk(this.iC, 4), mk(this.iD, 3)];
    g.setAttribute('iA', this.attrs[0]);
    g.setAttribute('iB', this.attrs[1]);
    g.setAttribute('iC', this.attrs[2]);
    g.setAttribute('iD', this.attrs[3]);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = g;

    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uNoise: { value: null }, uTime: { value: 0 }, uIntensity: { value: 1 }, uStretch: { value: o.stretch || 0 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) }, uAmbient: { value: 0.6 }, uSunLight: { value: 0.6 },
    }]);
    this.uniforms.uNoise.value = noiseTexture();
    const emissive = o.kind !== 'puff';
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAGS[o.kind],
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: emissive ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? 3;
    this.mesh.name = o.name || `fx:${o.kind}`;
    scene.add(this.mesh);
    this.windVec = { x: 0, z: 0 };
  }

  /**
   * Spawn one particle. Fields (all optional except position): x,y,z, vx,vy,vz, life, size0, size1,
   * r,g,b (start colour), r1,g1,b1 (end colour), alpha, drag, grav (+down), rot, spin, heat, seed, delay,
   * fadeIn (s), wind (0..1 drift), floor (y the particle can't sink below).
   */
  emit(p) {
    let i = this.count;
    const lim = Math.max(16, Math.min(this.capacity, this.limit ?? this.capacity));
    if (i >= lim) i = (Math.random() * Math.min(i, lim)) | 0; // full: overwrite a random one
    else this.count++;
    const i3 = i * 3, i4 = i * 4;
    this.iA[i4] = p.x; this.iA[i4 + 1] = p.y; this.iA[i4 + 2] = p.z; this.iA[i4 + 3] = 0;
    this.iD[i3] = p.vx || 0; this.iD[i3 + 1] = p.vy || 0; this.iD[i3 + 2] = p.vz || 0;
    this.age[i] = 0;
    this.life[i] = p.life || 1;
    this.s0[i] = p.size0 ?? 1;
    this.s1[i] = p.size1 ?? this.s0[i];
    this.a0[i] = p.alpha ?? 1;
    const r = p.r ?? 1, g = p.g ?? 1, b = p.b ?? 1;
    this.c0[i3] = r; this.c0[i3 + 1] = g; this.c0[i3 + 2] = b;
    this.c1[i3] = p.r1 ?? r; this.c1[i3 + 1] = p.g1 ?? g; this.c1[i3 + 2] = p.b1 ?? b;
    this.drag[i] = p.drag ?? 0;
    this.grav[i] = p.grav ?? 0;
    this.spin[i] = p.spin ?? 0;
    this.delay[i] = p.delay ?? 0;
    this.heat0[i] = p.heat ?? 0;
    this.fin[i] = p.fadeIn ?? 0.08;
    this.wind[i] = p.wind ?? 0;
    this.floor[i] = p.floor ?? -1e9;
    this.iC[i4] = p.rot ?? Math.random() * 6.283;
    this.iC[i4 + 1] = 0;
    this.iC[i4 + 2] = p.seed ?? Math.random();
    this.iC[i4 + 3] = this.heat0[i];
    this.iB[i4] = r; this.iB[i4 + 1] = g; this.iB[i4 + 2] = b; this.iB[i4 + 3] = 0;
    return i;
  }

  _kill(i) {
    const j = --this.count;
    if (i === j) return;
    const c4 = (a) => { a[i * 4] = a[j * 4]; a[i * 4 + 1] = a[j * 4 + 1]; a[i * 4 + 2] = a[j * 4 + 2]; a[i * 4 + 3] = a[j * 4 + 3]; };
    const c3 = (a) => { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; };
    c4(this.iA); c4(this.iB); c4(this.iC); c3(this.iD); c3(this.c0); c3(this.c1);
    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    this.a0[i] = this.a0[j]; this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j]; this.spin[i] = this.spin[j];
    this.delay[i] = this.delay[j]; this.heat0[i] = this.heat0[j]; this.fin[i] = this.fin[j]; this.wind[i] = this.wind[j];
    this.floor[i] = this.floor[j];
  }

  update(dt) {
    const { iA, iB, iC, iD, age, life } = this;
    const wx = this.windVec.x, wz = this.windVec.z;
    const flame = this.kind === 'flame';
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        iB[i * 4 + 3] = 0;
        continue;
      }
      const a = (age[i] += dt);
      if (a >= life[i]) { this._kill(i); continue; }
      const t = a / life[i];
      const i3 = i * 3, i4 = i * 4;
      const d = Math.exp(-this.drag[i] * dt);
      let vx = iD[i3], vy = iD[i3 + 1], vz = iD[i3 + 2];
      const w = this.wind[i];
      if (w > 0) {
        const k = Math.min(1, w * dt);
        vx += (wx - vx) * k;
        vz += (wz - vz) * k;
      }
      vx *= d; vz *= d;
      vy = vy * d - this.grav[i] * dt;
      let y = iA[i4 + 1] + vy * dt;
      if (y < this.floor[i]) { y = this.floor[i]; vy = Math.abs(vy) * 0.25; vx *= 0.6; vz *= 0.6; }
      iA[i4] += vx * dt; iA[i4 + 1] = y; iA[i4 + 2] += vz * dt;
      iD[i3] = vx; iD[i3 + 1] = vy; iD[i3 + 2] = vz;
      const e = 1 - (1 - t) * (1 - t);
      iA[i4 + 3] = this.s0[i] + (this.s1[i] - this.s0[i]) * e;
      const fin = this.fin[i] > 0 ? Math.min(1, a / this.fin[i]) : 1;
      iB[i4] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      iB[i4 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      iB[i4 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      iB[i4 + 3] = this.a0[i] * fin * (flame ? (1 - t * t) : (1 - t) * (1 - t * 0.4));
      iC[i4] += this.spin[i] * dt;
      iC[i4 + 1] = t;
      iC[i4 + 3] = this.heat0[i] * (flame ? Math.pow(1 - t, 1.3) : Math.max(0, 1 - t * 5));
    }
    const n = this.count;
    this.geometry.instanceCount = n;
    for (const at of this.attrs) {
      at.clearUpdateRanges();
      if (n) at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = n > 0;
    }
  }

  clear() { this.count = 0; this.geometry.instanceCount = 0; }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// Small lit solid fragments (glass shards, leaves, wood chips, metal bits) simulated on the CPU with
// ground bounce. One InstancedMesh draw call.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

export class ChunkSystem {
  constructor(scene, capacity = 400) {
    const n = (this.capacity = capacity);
    this.count = 0;
    // flat irregular shard (two triangles folded) — reads as glass, leaf or chip depending on scale/colour
    const g = new THREE.BufferGeometry();
    const v = [0, 0, -0.5, 0.45, 0.06, 0.1, -0.35, -0.05, 0.4, 0, 0, -0.5, -0.35, -0.05, 0.4, -0.4, 0.08, -0.15];
    const both = [];
    for (let i = 0; i < v.length; i += 9) {
      both.push(...v.slice(i, i + 9));
      both.push(v[i + 6], v[i + 7], v[i + 8], v[i + 3], v[i + 4], v[i + 5], v[i], v[i + 1], v[i + 2]);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(both, 3));
    g.computeVertexNormals();
    this.material = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.45, metalness: 0.3 });
    this.mesh = new THREE.InstancedMesh(g, this.material, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'fx:chunks';
    scene.add(this.mesh);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.rot = new Float32Array(n * 4);
    this.axis = new Float32Array(n * 3);
    this.spin = new Float32Array(n);
    this.scale = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.floor = new Float32Array(n);
    this.rest = new Uint8Array(n);
    this.flutter = new Float32Array(n);
  }

  /** p: x,y,z, vx,vy,vz, size, sx,sy,sz (scale multipliers), r,g,b, life, drag, floor, spin, flutter */
  emit(p) {
    let i = this.count;
    if (i >= this.capacity) i = (Math.random() * this.capacity) | 0;
    else this.count++;
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = p.vx || 0; this.vel[i3 + 1] = p.vy || 0; this.vel[i3 + 2] = p.vz || 0;
    _q.setFromEuler(_e.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
    this.rot[i * 4] = _q.x; this.rot[i * 4 + 1] = _q.y; this.rot[i * 4 + 2] = _q.z; this.rot[i * 4 + 3] = _q.w;
    _ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.axis[i3] = _ax.x; this.axis[i3 + 1] = _ax.y; this.axis[i3 + 2] = _ax.z;
    this.spin[i] = p.spin ?? (4 + Math.random() * 10);
    const s = p.size ?? 0.1;
    this.scale[i3] = s * (p.sx ?? 1); this.scale[i3 + 1] = s * (p.sy ?? 1); this.scale[i3 + 2] = s * (p.sz ?? 1);
    this.col[i3] = p.r ?? 1; this.col[i3 + 1] = p.g ?? 1; this.col[i3 + 2] = p.b ?? 1;
    this.age[i] = 0;
    this.life[i] = p.life ?? 3;
    this.drag[i] = p.drag ?? 0.3;
    this.floor[i] = p.floor ?? -1e9;
    this.rest[i] = 0;
    this.flutter[i] = p.flutter ?? 0;
  }

  _kill(i) {
    const j = --this.count;
    if (i === j) return;
    const c = (a, k) => { for (let q = 0; q < k; q++) a[i * k + q] = a[j * k + q]; };
    c(this.pos, 3); c(this.vel, 3); c(this.rot, 4); c(this.axis, 3); c(this.scale, 3); c(this.col, 3);
    this.spin[i] = this.spin[j]; this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.drag[i] = this.drag[j];
    this.floor[i] = this.floor[j]; this.rest[i] = this.rest[j]; this.flutter[i] = this.flutter[j];
  }

  update(dt, time) {
    const im = this.mesh.instanceMatrix.array;
    const ic = this.mesh.instanceColor.array;
    for (let i = this.count - 1; i >= 0; i--) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) { this._kill(i); continue; }
      const i3 = i * 3;
      if (!this.rest[i]) {
        const d = Math.exp(-this.drag[i] * dt);
        let vx = this.vel[i3] * d, vy = this.vel[i3 + 1] * d - 9.81 * dt, vz = this.vel[i3 + 2] * d;
        const fl = this.flutter[i];
        if (fl > 0) { // leaves: terminal velocity + sideways sway
          vy = Math.max(vy, -1.6);
          vx += Math.sin(time * 3.1 + i) * fl * dt;
          vz += Math.cos(time * 2.7 + i * 1.3) * fl * dt;
        }
        let y = this.pos[i3 + 1] + vy * dt;
        if (y < this.floor[i]) {
          y = this.floor[i];
          if (Math.abs(vy) < 1.2) { this.rest[i] = 1; vx = vy = vz = 0; }
          else { vy = -vy * 0.3; vx *= 0.55; vz *= 0.55; this.spin[i] *= 0.5; }
        }
        this.pos[i3] += vx * dt; this.pos[i3 + 1] = y; this.pos[i3 + 2] += vz * dt;
        this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
        _ax.set(this.axis[i3], this.axis[i3 + 1], this.axis[i3 + 2]);
        _q.set(this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2], this.rot[i * 4 + 3]);
        _q.multiply(_q2.setFromAxisAngle(_ax, this.spin[i] * dt));
        this.rot[i * 4] = _q.x; this.rot[i * 4 + 1] = _q.y; this.rot[i * 4 + 2] = _q.z; this.rot[i * 4 + 3] = _q.w;
      }
    }
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const left = this.life[i] - this.age[i];
      const k = left < 0.6 ? left / 0.6 : 1;
      _p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      _q.set(this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2], this.rot[i * 4 + 3]);
      _s.set(this.scale[i3] * k, this.scale[i3 + 1] * k, this.scale[i3 + 2] * k);
      _m.compose(_p, _q, _s);
      _m.toArray(im, i * 16);
      ic[i3] = this.col[i3]; ic[i3 + 1] = this.col[i3 + 1]; ic[i3 + 2] = this.col[i3 + 2];
    }
    this.mesh.count = n;
    const at = this.mesh.instanceMatrix;
    at.clearUpdateRanges();
    if (n) at.addUpdateRange(0, n * 16);
    at.needsUpdate = n > 0;
    const ac = this.mesh.instanceColor;
    ac.clearUpdateRanges();
    if (n) ac.addUpdateRange(0, n * 3);
    ac.needsUpdate = n > 0;
  }

  clear() { this.count = 0; this.mesh.count = 0; }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
