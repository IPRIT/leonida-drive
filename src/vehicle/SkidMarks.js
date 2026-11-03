// Ring-buffer skid mark strips in a single mesh. Old quads fade out in the shader by age.
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aAlpha;
attribute float aBirth;
uniform float uTime;
uniform float uLife;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float age = uTime - aBirth;
  vAlpha = aAlpha * clamp(1.0 - age / uLife, 0.0, 1.0) * clamp(age * 4.0 + 0.6, 0.0, 1.0);
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4(uColor, vAlpha * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class SkidMarks {
  /**
   * @param {THREE.Scene} scene
   * @param {{maxQuads?:number, lifetime?:number, color?:number, opacity?:number}} opts
   */
  constructor(scene, opts = {}) {
    this.max = opts.maxQuads ?? 4000;
    this.lifetime = opts.lifetime ?? 45;
    this.time = 0;
    this.head = 0;
    this.tracks = new Map();
    const n = this.max * 4;
    this.positions = new Float32Array(n * 3);
    this.alphas = new Float32Array(n);
    this.births = new Float32Array(n).fill(-1e6);
    const idx = new Uint32Array(this.max * 6);
    for (let q = 0; q < this.max; q++) {
      const v = q * 4, i = q * 6;
      idx[i] = v; idx[i + 1] = v + 2; idx[i + 2] = v + 1;
      idx[i + 3] = v + 1; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    this.birthAttr = new THREE.BufferAttribute(this.births, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aAlpha', this.alphaAttr);
    g.setAttribute('aBirth', this.birthAttr);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uLife: { value: this.lifetime }, uColor: { value: new THREE.Color(opts.color ?? 0x0c0c0c) }, uOpacity: { value: opts.opacity ?? 0.72 } },
      ]),
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skidMarks';
    scene.add(this.mesh);
    this._dirtyStart = -1;
    this._dirtyEnd = -1;
  }

  /**
   * Continue (or start) a strip for a track id (e.g. vehicle wheel).
   * point/side/normal: world-space THREE.Vector3-like; side = unit lateral direction of the tire.
   */
  emit(trackId, point, side, normal, width, intensity) {
    const hw = width * 0.5;
    const lift = 0.02;
    const lx = point.x - side.x * hw + normal.x * lift, ly = point.y - side.y * hw + normal.y * lift, lz = point.z - side.z * hw + normal.z * lift;
    const rx = point.x + side.x * hw + normal.x * lift, ry = point.y + side.y * hw + normal.y * lift, rz = point.z + side.z * hw + normal.z * lift;
    let t = this.tracks.get(trackId);
    if (!t) {
      t = { l: [lx, ly, lz], r: [rx, ry, rz], p: [point.x, point.y, point.z], a: intensity, active: true };
      this.tracks.set(trackId, t);
      return;
    }
    if (!t.active) {
      t.l = [lx, ly, lz]; t.r = [rx, ry, rz]; t.p = [point.x, point.y, point.z]; t.a = intensity; t.active = true;
      return;
    }
    const dx = point.x - t.p[0], dy = point.y - t.p[1], dz = point.z - t.p[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 0.09) return; // ~30 cm segments
    if (d2 > 16) {
      // teleport or huge jump: restart strip
      t.l = [lx, ly, lz]; t.r = [rx, ry, rz]; t.p = [point.x, point.y, point.z]; t.a = intensity;
      return;
    }
    this._quad(t.l, t.r, [lx, ly, lz], [rx, ry, rz], t.a, intensity);
    t.l = [lx, ly, lz]; t.r = [rx, ry, rz]; t.p = [point.x, point.y, point.z]; t.a = intensity;
  }

  /** Break the strip of a track (wheel stopped sliding / left the ground). */
  end(trackId) {
    const t = this.tracks.get(trackId);
    if (t) t.active = false;
  }

  _quad(l0, r0, l1, r1, a0, a1) {
    const q = this.head;
    this.head = (this.head + 1) % this.max;
    const v = q * 4;
    const P = this.positions;
    P.set(l0, v * 3); P.set(r0, v * 3 + 3); P.set(l1, v * 3 + 6); P.set(r1, v * 3 + 9);
    this.alphas[v] = this.alphas[v + 1] = a0;
    this.alphas[v + 2] = this.alphas[v + 3] = a1;
    const b = this.time;
    this.births[v] = this.births[v + 1] = this.births[v + 2] = this.births[v + 3] = b;
    if (this._dirtyStart < 0) {
      this._dirtyStart = q;
      this._dirtyEnd = q;
    } else this._dirtyEnd = q;
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    if (this._dirtyStart < 0) return;
    const attrs = [
      [this.posAttr, 12],
      [this.alphaAttr, 4],
      [this.birthAttr, 4],
    ];
    const s = this._dirtyStart, e = this._dirtyEnd;
    // ranges accumulate until the renderer uploads them (it clears them after upload)
    for (const [attr, per] of attrs) {
      if (e >= s) attr.addUpdateRange(s * per, (e - s + 1) * per);
      else {
        attr.addUpdateRange(s * per, (this.max - s) * per);
        attr.addUpdateRange(0, (e + 1) * per);
      }
      attr.needsUpdate = true;
    }
    this._dirtyStart = this._dirtyEnd = -1;
  }

  clear() {
    this.births.fill(-1e6);
    this.birthAttr.clearUpdateRanges();
    this.birthAttr.needsUpdate = true;
    this.tracks.clear();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
