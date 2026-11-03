// Pooled billboard particles (single THREE.Points) for tire smoke, dust and water splash.
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aRot;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
varying float vRot;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
  vAlpha = aAlpha;
  vColor = aColor;
  vRot = aRot;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
varying float vRot;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
  vec4 t = texture2D(uMap, p);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * (0.82 + 0.18 * t.r), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function makeSprite() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(235,235,235,0.75)');
  grd.addColorStop(0.7, 'rgba(210,210,210,0.25)');
  grd.addColorStop(1, 'rgba(200,200,200,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  // a few soft lumps for a puffy look
  for (let i = 0; i < 6; i++) {
    const x = size / 2 + (Math.random() - 0.5) * size * 0.35;
    const y = size / 2 + (Math.random() - 0.5) * size * 0.35;
    const r = size * (0.12 + Math.random() * 0.12);
    const gg = g.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, 'rgba(255,255,255,0.35)');
    gg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gg;
    g.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export const SMOKE_PRESETS = {
  smoke: { color: 0xe6e6e6, life: 2.0, size0: 0.8, size1: 4.0, alpha: 0.26, rise: 0.7, drag: 1.4 },
  dust: { color: 0xb89a6c, life: 1.6, size0: 0.7, size1: 3.4, alpha: 0.38, rise: 0.4, drag: 1.8 },
  grass: { color: 0x8a8a5a, life: 1.2, size0: 0.5, size1: 2.4, alpha: 0.3, rise: 0.3, drag: 2.2 },
  splash: { color: 0xcfe9ff, life: 0.8, size0: 0.5, size1: 1.8, alpha: 0.55, rise: 3.2, drag: 0.8, gravity: 7 },
  exhaust: { color: 0x9a9a9a, life: 0.6, size0: 0.25, size1: 1.0, alpha: 0.18, rise: 0.4, drag: 2.0 },
};

export class TireSmoke {
  /**
   * @param {THREE.Scene} scene
   * @param {{max?:number}} opts
   */
  constructor(scene, opts = {}) {
    this.max = opts.max ?? 900;
    const n = this.max;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    this.rot = new Float32Array(n);
    this.age = new Float32Array(n).fill(1e9);
    this.life = new Float32Array(n).fill(1);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.next = 0;
    this.alive = 0;
    const g = new THREE.BufferGeometry();
    this.attrs = {
      position: new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
      aSize: new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
      aAlpha: new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage),
      aColor: new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage),
      aRot: new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage),
    };
    for (const [k, a] of Object.entries(this.attrs)) g.setAttribute(k, a);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uScale: { value: 400 } }]),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.material.uniforms.uMap.value = makeSprite();
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.name = 'tireSmoke';
    scene.add(this.points);
    this._c = new THREE.Color();
  }

  /** Spawn one particle. kind: key of SMOKE_PRESETS or a preset-like object. */
  emit(kind, x, y, z, vx = 0, vy = 0, vz = 0, scale = 1) {
    const p = typeof kind === 'string' ? SMOKE_PRESETS[kind] : kind;
    if (!p) return;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    const j = 0.6;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * j;
    this.vel[i * 3 + 1] = vy + p.rise * (0.6 + Math.random() * 0.8);
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * j;
    this.age[i] = 0;
    this.life[i] = p.life * (0.75 + Math.random() * 0.5);
    this.s0[i] = p.size0 * scale;
    this.s1[i] = p.size1 * scale * (0.8 + Math.random() * 0.4);
    this.a0[i] = p.alpha;
    this.grav[i] = p.gravity || 0;
    this.drag[i] = p.drag;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = (Math.random() - 0.5) * 1.2;
    this._c.set(p.color);
    const shade = 0.9 + Math.random() * 0.15;
    this.color[i * 3] = this._c.r * shade;
    this.color[i * 3 + 1] = this._c.g * shade;
    this.color[i * 3 + 2] = this._c.b * shade;
  }

  /**
   * @param {number} dt
   * @param {THREE.PerspectiveCamera} [camera] for size attenuation
   * @param {number} [viewportHeight] drawing buffer height in px
   */
  update(dt, camera, viewportHeight) {
    const h = viewportHeight || (typeof window !== 'undefined' ? window.innerHeight * Math.min(window.devicePixelRatio || 1, 2) : 800);
    const fov = camera && camera.fov ? camera.fov : 60;
    this.material.uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          this.size[i] = 0;
        }
        continue;
      }
      alive++;
      const a = (this.age[i] += dt);
      const t = Math.min(1, a / this.life[i]);
      const d = Math.exp(-this.drag[i] * dt);
      const k = i * 3;
      this.vel[k] *= d;
      this.vel[k + 1] = this.vel[k + 1] * d - this.grav[i] * dt;
      this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - t) * (1 - t));
      const fadeIn = Math.min(1, a * 8);
      this.alpha[i] = this.a0[i] * fadeIn * (1 - t) * (1 - t * 0.3);
      this.rot[i] += this.spin[i] * dt;
    }
    this.alive = alive;
    for (const a of Object.values(this.attrs)) a.needsUpdate = true;
  }

  clear() {
    this.age.fill(1e9);
    this.alpha.fill(0);
    this.size.fill(0);
  }

  dispose() {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.material.uniforms.uMap.value?.dispose();
    this.material.dispose();
  }
}
