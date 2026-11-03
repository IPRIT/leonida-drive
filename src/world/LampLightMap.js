import * as THREE from 'three';

// Street-lamp light map: every lamp around the camera is splatted (additive radial falloff) into a 1 km
// render target, re-centred when the camera moves. Roads, junctions, sidewalks and terrain all sample the same
// texture, so pools spill naturally across surfaces (no seams at ribbon ends) and a knocked-down lamp goes dark.
const SIZE = 1024; // metres covered
const RES = 512; // texels (2 m)
const MAX = 3000;

export const LAMP_MAP_UNIFORMS = {
  uLampMap: { value: null },
  uLampMapRect: { value: new THREE.Vector4(0, 0, SIZE, 0) }, // x0, z0, size, intensity (night)
};

export const LAMP_MAP_GLSL = /* glsl */`
  uniform sampler2D uLampMap; uniform vec4 uLampMapRect;
  vec3 lampMapLight(vec3 wp) {
    // the ortho capture has north (-z) at the top of the target, so v grows towards -z
    vec2 uv = vec2(wp.x - uLampMapRect.x, uLampMapRect.y + uLampMapRect.z - wp.z) / uLampMapRect.z;
    if (uLampMapRect.w <= 0.001 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
    vec2 e = smoothstep(0.0, 0.06, uv) * smoothstep(0.0, 0.06, 1.0 - uv); // fade at the map border
    return texture2D(uLampMap, uv).rgb * uLampMapRect.w * e.x * e.y;
  }`;

export class LampLightMap {
  // signals: optional () => array of [x, z, r, g, b] (traffic signal heads with their current colour)
  constructor(renderer, lamps, signals = null) {
    this.renderer = renderer;
    this.lamps = lamps;
    this.signals = signals;
    this.sigTimer = 0;
    this.rt = new THREE.WebGLRenderTarget(RES, RES, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    LAMP_MAP_UNIFORMS.uLampMap.value = this.rt.texture;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-SIZE / 2, SIZE / 2, SIZE / 2, -SIZE / 2, -10, 10);
    this.cam.up.set(0, 0, -1);
    this.cam.lookAt(0, -1, 0);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float k = exp(-r2 * 4.2) * (1.0 - r2);
          gl_FragColor = vec4(vec3(1.0, 0.62, 0.3) * k * 0.6, 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.scene.add(this.mesh);
    // traffic signal glow: same falloff, per-instance colour
    const sgeo = geo.clone();
    this.sigCol = new THREE.InstancedBufferAttribute(new Float32Array(600 * 3), 3);
    sgeo.setAttribute('aCol', this.sigCol);
    const smat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aCol; varying vec2 vUv; varying vec3 vCol;
        void main() { vUv = uv * 2.0 - 1.0; vCol = aCol; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv; varying vec3 vCol;
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          gl_FragColor = vec4(vCol * exp(-r2 * 3.5) * (1.0 - r2) * 0.3, 1.0);
        }`,
    });
    this.sigMesh = new THREE.InstancedMesh(sgeo, smat, 600);
    this.sigMesh.frustumCulled = false;
    this.sigMesh.count = 0;
    this.scene.add(this.sigMesh);
    this.center = new THREE.Vector2(1e9, 1e9);
    this.dirty = true;
    this._m = new THREE.Matrix4();
    this._ids = [];
  }

  invalidate() { this.dirty = true; }

  /**
   * Loading screen: draw both splat passes once (one microscopic instance each), so their shader programs are
   * compiled and first used now instead of at the first dusk (a 30 ms hitch when the street lights come on).
   */
  prewarm() {
    const R = this.renderer, prevRT = R.getRenderTarget();
    const n0 = this.mesh.count, s0 = this.sigMesh.count;
    this._m.makeScale(1e-3, 1, 1e-3);
    this.mesh.setMatrixAt(0, this._m);
    this.sigMesh.setMatrixAt(0, this._m);
    this.mesh.count = 1;
    this.sigMesh.count = 1;
    this.mesh.instanceMatrix.needsUpdate = this.sigMesh.instanceMatrix.needsUpdate = true;
    try {
      R.setRenderTarget(this.rt);
      R.render(this.scene, this.cam);
    } catch (e) { console.warn('[lampMap] prewarm', e); }
    R.setRenderTarget(prevRT);
    this.mesh.count = n0;
    this.sigMesh.count = s0;
    this.dirty = true;
  }

  update(camera, night, dt = 0) {
    LAMP_MAP_UNIFORMS.uLampMapRect.value.w = night;
    if (night < 0.01) return;
    const cx = camera.position.x, cz = camera.position.z;
    // signals change colour: refresh a few times per second (a 512² additive pass, ~0.1 ms of GPU)
    if (this.signals && (this.sigTimer -= dt) <= 0) { this.sigTimer = 0.3; this.dirty = true; }
    if (!this.dirty && Math.abs(cx - this.center.x) < SIZE * 0.18 && Math.abs(cz - this.center.y) < SIZE * 0.18) return;
    this.dirty = false;
    // snap to the texel grid so pools don't shimmer when the map moves
    const step = SIZE / RES;
    const ox = Math.round(cx / step) * step, oz = Math.round(cz / step) * step;
    this.center.set(ox, oz);
    const sc = this.lamps.scatter, r = sc.raw;
    const ids = sc.near(ox, oz, SIZE * 0.72, (this._ids.length = 0, this._ids));
    let n = 0;
    const m = this._m;
    for (const id of ids) {
      if (n >= MAX) break;
      if (this.lamps.broken?.has?.(id) || sc.hidden?.has?.(id)) continue;
      const yaw = r[id * 6 + 3];
      // pool centred under the lamp head (arm reaches 2 m over the road), radius ~11 m
      const x = r[id * 6] + Math.sin(yaw) * 2.6 - ox, z = r[id * 6 + 2] + Math.cos(yaw) * 2.6 - oz;
      m.makeScale(22, 1, 22).setPosition(x, 0, z);
      this.mesh.setMatrixAt(n++, m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    let ns = 0;
    if (this.signals) {
      for (const [x, z, cr, cg, cb] of this.signals()) {
        if (ns >= 600) break;
        const lx = x - ox, lz = z - oz;
        if (Math.abs(lx) > SIZE / 2 || Math.abs(lz) > SIZE / 2) continue;
        m.makeScale(9, 1, 9).setPosition(lx, 0, lz);
        this.sigMesh.setMatrixAt(ns, m);
        this.sigCol.setXYZ(ns++, cr, cg, cb);
      }
    }
    this.sigMesh.count = ns;
    this.sigMesh.instanceMatrix.needsUpdate = true;
    this.sigCol.needsUpdate = true;
    const R = this.renderer;
    const prevRT = R.getRenderTarget(), prevClear = R.getClearAlpha(), prevColor = R.getClearColor(new THREE.Color());
    const prevAuto = R.autoClear;
    R.setRenderTarget(this.rt);
    R.setClearColor(0x000000, 1);
    R.autoClear = true;
    R.clear(true, false, false);
    R.render(this.scene, this.cam);
    R.setRenderTarget(prevRT);
    R.setClearColor(prevColor, prevClear);
    R.autoClear = prevAuto;
    LAMP_MAP_UNIFORMS.uLampMapRect.value.set(ox - SIZE / 2, oz - SIZE / 2, SIZE, night);
  }
}
