import * as THREE from 'three';
import { noiseTexture } from './textures.js';
import { GROUPS, groups } from '../vehicle/groups.js';

const GRID = 5; // ground decals: GRID x GRID vertices conformed to the surface
const VPD = GRID * GRID;
const IPD = (GRID - 1) * (GRID - 1) * 6;

const VERT = /* glsl */`
  attribute vec4 aP; // seed, alpha, kind (0 scorch, 1 hole), heat
  varying vec2 vUv;
  varying vec4 vP;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vP = aP;
    vec4 mvPosition = viewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;
const FRAG = /* glsl */`
  uniform sampler2D uNoise;
  uniform float uTime;
  uniform float uLight;
  varying vec2 vUv;
  varying vec4 vP;
  #include <fog_pars_fragment>
  void main() {
    if (vP.y <= 0.001) discard;
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    vec4 n = texture2D(uNoise, vUv * 0.7 + vP.x * 13.1);
    vec4 n2 = texture2D(uNoise, vUv * 2.3 - vP.x * 5.7);
    float edge = r + (n.r - 0.5) * 0.7 + (n2.g - 0.5) * 0.25;
    float m = 1.0 - smoothstep(0.3, 1.0, edge);
    float core = 1.0 - smoothstep(0.0, 0.6, edge);
    vec3 col = mix(vec3(0.07, 0.06, 0.05), vec3(0.012, 0.01, 0.009), core);
    float a = m * (0.55 + 0.45 * n2.b) * 0.92;
    if (vP.z > 2.5) {
      // radial cracks + chipped rim around an impact / shell hole (the hole itself stays clear)
      float ang = atan(p.y, p.x);
      float k = abs(fract(ang * 1.4324 + vP.x * 7.0 + (n.r - 0.5) * 0.45 + (n2.g - 0.5) * 0.5 * r) - 0.5);
      float wdt = mix(0.075, 0.014, smoothstep(0.25, 1.0, r));
      float crack = (1.0 - smoothstep(wdt * 0.5, wdt, k)) * smoothstep(0.22, 0.34, r) * (1.0 - smoothstep(0.62, 1.0, r + (n.b - 0.5) * 0.5));
      float k2 = abs(fract(ang * 3.1831 + vP.x * 3.0 + (n2.r - 0.5) * 0.8) - 0.5);
      crack = max(crack, (1.0 - smoothstep(0.006, 0.014, k2)) * smoothstep(0.3, 0.45, r) * (1.0 - smoothstep(0.5, 0.75, r + (n2.b - 0.5) * 0.4)));
      float rim = smoothstep(0.16, 0.24, r) * (1.0 - smoothstep(0.26, 0.42, edge * 0.8));
      col = mix(vec3(0.32, 0.3, 0.28) * (0.8 + 0.4 * n2.r) * uLight, vec3(0.02, 0.018, 0.016), crack);
      a = max(crack * 0.95, rim * 0.7 * (0.6 + 0.4 * n.g));
      if (r < 0.17 + (n.g - 0.5) * 0.05) a = 0.0;
    } else if (vP.z > 1.5) {
      // dust / rubble footprint
      col = vec3(0.4, 0.38, 0.35) * (0.72 + 0.5 * n2.r) * uLight;
      a = m * (0.45 + 0.4 * n.g) * 0.9;
    } else if (vP.z > 0.5) { a = max(a, (1.0 - smoothstep(0.25, 0.5, edge)) ); col = mix(col, vec3(0.0), core); }
    a *= vP.y;
    float ember = vP.w * core * smoothstep(0.45, 0.75, n2.r) * (0.7 + 0.3 * sin(uTime * 7.0 + n.b * 20.0)) * step(vP.z, 1.5);
    col += vec3(1.0, 0.28, 0.04) * ember * 3.0;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
    #include <fog_fragment>
  }
`;

const _ray = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: -1, z: 0 } };

// Scorch decals on the ground (conformed to terrain/roads by raycasts) and on facades, merged in one mesh.
export class Decals {
  constructor(game, capacity = 64) {
    this.game = game;
    this.cap = capacity;
    const n = capacity;
    this.pos = new Float32Array(n * VPD * 3);
    this.uv = new Float32Array(n * VPD * 2);
    this.par = new Float32Array(n * VPD * 4);
    const idx = new Uint32Array(n * IPD);
    for (let d = 0; d < n; d++) {
      let k = d * IPD;
      for (let j = 0; j < GRID - 1; j++) {
        for (let i = 0; i < GRID - 1; i++) {
          const a = d * VPD + j * GRID + i, b = a + 1, c = a + GRID, e = c + 1;
          idx[k++] = a; idx[k++] = c; idx[k++] = b;
          idx[k++] = b; idx[k++] = c; idx[k++] = e;
        }
      }
      for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
        const v = d * VPD + j * GRID + i;
        this.uv[v * 2] = i / (GRID - 1);
        this.uv[v * 2 + 1] = j / (GRID - 1);
      }
    }
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aPar = new THREE.BufferAttribute(this.par, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    g.setAttribute('aP', this.aPar);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNoise: { value: null }, uTime: { value: 0 }, uLight: { value: 1 } }]),
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.material.uniforms.uNoise.value = noiseTexture();
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'fx:decals';
    game.scene.add(this.mesh);
    this.slots = Array.from({ length: n }, () => ({ alive: false, age: 0, life: 0, alpha: 0, heat: 0, seq: 0 }));
    this.seq = 0;
    this.groundGroups = groups(0xffff, GROUPS.GROUND);
  }

  _slot() {
    let best = null;
    for (const s of this.slots) {
      if (!s.alive) return s;
      if (!best || s.seq < best.seq) best = s;
    }
    return best;
  }

  // surface height under (x,z): raycast ground/roads/roofs, fall back to the terrain
  groundY(x, z, fromY) {
    const { world, RAPIER, terrain } = this.game;
    const th = Math.max(terrain?.heightAt?.(x, z) ?? 0, -50);
    if (world && RAPIER) {
      if (!this._ray) this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
      const top = (fromY ?? th) + 3;
      this._ray.origin = { x, y: top, z };
      this._ray.dir = _ray.dir;
      const hit = world.castRay(this._ray, 40, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, this.groundGroups);
      if (hit) return top - hit.timeOfImpact;
    }
    return th;
  }

  /** Ground scorch at (x, z) of radius ~size/2. */
  addGround(pos, size = 4, { life = 120, heat = 1, kind = 0 } = {}) {
    const s = this._slot();
    const d = this.slots.indexOf(s);
    const rot = Math.random() * Math.PI * 2;
    const c = Math.cos(rot), sn = Math.sin(rot);
    const h = size / 2;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const u = (i / (GRID - 1)) * 2 - 1, v = (j / (GRID - 1)) * 2 - 1;
      const x = pos.x + (u * c - v * sn) * h, z = pos.z + (u * sn + v * c) * h;
      const y = this.groundY(x, z, pos.y) + 0.06;
      const k = (d * VPD + j * GRID + i) * 3;
      this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    }
    this._activate(s, d, life, heat, kind);
    return s;
  }

  /** Facade decal: centre on the wall, outward normal {x,z} (horizontal). */
  addWall(pos, normal, size = 4, { life = 180, heat = 0.6, kind = 1 } = {}) {
    const s = this._slot();
    const d = this.slots.indexOf(s);
    const nl = Math.hypot(normal.x, normal.z) || 1;
    const nx = normal.x / nl, nz = normal.z / nl;
    const tx = -nz, tz = nx;
    const h = size / 2;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const u = ((i / (GRID - 1)) * 2 - 1) * h, v = ((j / (GRID - 1)) * 2 - 1) * h;
      const k = (d * VPD + j * GRID + i) * 3;
      this.pos[k] = pos.x + tx * u + nx * 0.09;
      this.pos[k + 1] = pos.y + v;
      this.pos[k + 2] = pos.z + tz * u + nz * 0.09;
    }
    this._activate(s, d, life, heat, kind);
    return s;
  }

  _activate(s, d, life, heat, kind) {
    Object.assign(s, { alive: true, age: 0, life, alpha: 1, heat0: heat, heat, kind, seed: Math.random(), seq: this.seq++ });
    this.aPos.addUpdateRange(d * VPD * 3, VPD * 3);
    this.aPos.needsUpdate = true;
    this._writePar(d, s);
  }

  _writePar(d, s) {
    for (let v = 0; v < VPD; v++) {
      const k = (d * VPD + v) * 4;
      this.par[k] = s.seed; this.par[k + 1] = s.alive ? s.alpha : 0; this.par[k + 2] = s.kind; this.par[k + 3] = s.heat;
    }
    this.aPar.addUpdateRange(d * VPD * 4, VPD * 4);
    this.aPar.needsUpdate = true;
  }

  update(dt) {
    this.material.uniforms.uTime.value += dt;
    // light-coloured decals (dust, chipped plaster) are unlit: follow the day / night ambient
    this.material.uniforms.uLight.value = 1 - 0.85 * (this.game.uniforms?.uNight?.value ?? 0);
    for (let d = 0; d < this.cap; d++) {
      const s = this.slots[d];
      if (!s.alive) continue;
      s.age += dt;
      const a = Math.min(1, (s.life - s.age) / 10);
      if (a <= 0) { s.alive = false; this._writePar(d, s); continue; }
      const heat = s.heat0 * Math.max(0, 1 - s.age / 14);
      if (Math.abs(a - s.alpha) > 0.02 || heat !== s.heat) {
        s.alpha = a;
        s.heat = heat;
        this._writePar(d, s);
      }
    }
  }

  clear() {
    this.slots.forEach((s, d) => { s.alive = false; this._writePar(d, s); });
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
