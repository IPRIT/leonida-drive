import * as THREE from 'three';
import { MAX_WET_LAMPS } from './wetMaterial.js';

// GPU rain: world-fixed drops wrapped in a box around the camera (correct parallax), wind-slanted,
// stretched by the drop velocity relative to the camera, lit by ambient sky, backlit sun and nearby
// street lamps. Ground splashes are short-lived crowns at random spots (terrain height from a texture).

const TERRAIN_GLSL = /* glsl */`
  uniform highp sampler2D uHeight;
  uniform vec2 uOrigin, uGridMax;
  float groundH(vec2 xz) {
    vec2 g = (xz - uOrigin) / 8.0;
    if (g.x < 0.0 || g.y < 0.0 || g.x > uGridMax.x || g.y > uGridMax.y) return 0.0;
    ivec2 i = ivec2(floor(g)); vec2 f = fract(g); ivec2 mx = ivec2(uGridMax);
    float a = texelFetch(uHeight, clamp(i, ivec2(0), mx), 0).r;
    float b = texelFetch(uHeight, clamp(i + ivec2(1, 0), ivec2(0), mx), 0).r;
    float c = texelFetch(uHeight, clamp(i + ivec2(0, 1), ivec2(0), mx), 0).r;
    float d = texelFetch(uHeight, clamp(i + ivec2(1, 1), ivec2(0), mx), 0).r;
    return max(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), 0.0);
  }
`;

const LIGHT_GLSL = /* glsl */`
  uniform vec3 uAmbient, uSunCol, uSunDir, uLampCol;
  uniform vec4 uLamps[${MAX_WET_LAMPS}];
  uniform float uLampCount, uFlash;
  vec3 dropLight(vec3 wp, vec3 viewDir) {
    vec3 c = uAmbient;
    c += uSunCol * pow(max(dot(viewDir, uSunDir), 0.0), 6.0) * 2.5;
    for (int i = 0; i < ${MAX_WET_LAMPS}; i++) {
      if (float(i) >= uLampCount) break;
      vec3 d = uLamps[i].xyz - wp;
      c += uLampCol * uLamps[i].w * 3.0 / (1.0 + dot(d, d) * 0.06);
    }
    return c + vec3(0.8, 0.85, 1.0) * uFlash * 2.0;
  }
`;

const DROP_VERT = /* glsl */`
  attribute vec4 aSeed;
  attribute vec2 aCorner;
  uniform vec3 uCam, uWind, uCamVel;
  uniform float uTime, uBox, uHeightBox, uPixel, uCover, uAlpha;
  varying vec2 vC;
  varying float vA;
  varying vec3 vCol;
  ${TERRAIN_GLSL}
  ${LIGHT_GLSL}
  void main() {
    float speed = 8.0 + aSeed.w * 3.0;
    vec3 vel = vec3(uWind.x * 0.6, -speed, uWind.z * 0.6);
    float B = uBox * 2.0;
    vec3 p = aSeed.xyz * vec3(B, uHeightBox, B) + vel * uTime;
    vec3 rel = p - uCam;
    rel.xz = mod(rel.xz + uBox, B) - uBox;
    rel.y = mod(rel.y + uHeightBox * 0.4, uHeightBox) - uHeightBox * 0.4;
    vec3 wp = uCam + rel;
    float dist = length(rel);
    float a = smoothstep(uBox, uBox * 0.6, length(rel.xz)) * smoothstep(1.2, 4.0, dist);
    a *= step(groundH(wp.xz), wp.y);
    a *= 1.0 - uCover * smoothstep(16.0, 5.0, length(rel.xz));
    vec3 rv = vel - uCamVel;
    float rl = length(rv);
    vec3 dir = rv / max(rl, 1e-3);
    float len = clamp(rl * 0.05, 0.3, 2.2);
    vec3 toCam = normalize(uCam - wp);
    vec3 side = normalize(cross(dir, toCam) + 1e-5);
    float w = max(0.007, dist * uPixel * 0.9);
    a *= min(1.0, 0.012 / w) * (0.6 + 0.4 * aSeed.w);
    vec3 pos = wp + side * aCorner.x * w + dir * (aCorner.y - 0.5) * len;
    vC = aCorner;
    vA = a * uAlpha;
    vCol = dropLight(wp, -toCam);
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

const DROP_FRAG = /* glsl */`
  varying vec2 vC;
  varying float vA;
  varying vec3 vCol;
  void main() {
    float across = 1.0 - abs(vC.x);
    float along = smoothstep(0.0, 0.25, vC.y) * smoothstep(1.0, 0.6, vC.y);
    float a = vA * across * across * along;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vCol * a, a);
  }
`;

const SPLASH_VERT = /* glsl */`
  attribute vec4 aSeed;
  attribute vec2 aCorner;
  uniform vec3 uCam;
  uniform float uTime, uRadius, uAlpha, uCover;
  varying vec2 vC;
  varying float vA, vPh;
  varying vec3 vCol;
  ${TERRAIN_GLSL}
  ${LIGHT_GLSL}
  float h1(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    float T = 0.38 + aSeed.w * 0.25;
    float tt = uTime / T + aSeed.z * 13.0;
    float k = floor(tt);
    float ph = fract(tt);
    vec2 r = vec2(h1(k * 12.9898 + aSeed.x * 78.233), h1(k * 39.3468 + aSeed.y * 11.135)) * 2.0 - 1.0;
    vec2 xz = uCam.xz + r * uRadius;
    vec3 wp = vec3(xz.x, groundH(xz) + 0.03, xz.y);
    float s = 0.07 + ph * 0.22;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    mv.xy += vec2(aCorner.x * s, aCorner.y * s * 0.8);
    float d = length(wp - uCam);
    vA = uAlpha * (1.0 - ph) * (1.0 - ph) * smoothstep(uRadius, uRadius * 0.5, length(r * uRadius)) * smoothstep(1.0, 3.0, d)
      * (1.0 - uCover * smoothstep(16.0, 5.0, length(r * uRadius)));
    vC = aCorner;
    vPh = ph;
    vCol = dropLight(wp, normalize(wp - uCam));
    gl_Position = projectionMatrix * mv;
  }
`;

const SPLASH_FRAG = /* glsl */`
  varying vec2 vC;
  varying float vA, vPh;
  varying vec3 vCol;
  void main() {
    // crown: a thin arc opening upwards + a few droplets
    vec2 c = vC;
    float r = length(vec2(c.x, (c.y + 0.25) * 1.5));
    float crown = smoothstep(0.18, 0.0, abs(r - 0.55 - vPh * 0.3)) * smoothstep(-0.4, 0.2, c.y);
    float drops = smoothstep(0.12, 0.0, length(c - vec2(-0.35, 0.5 + vPh * 0.3))) + smoothstep(0.12, 0.0, length(c - vec2(0.4, 0.6 + vPh * 0.2)));
    float a = vA * clamp(crown + drops * 0.7, 0.0, 1.0);
    if (a < 0.003) discard;
    gl_FragColor = vec4(vCol * a, a);
  }
`;

function quads(n) {
  const seed = new Float32Array(n * 4 * 4);
  const corner = new Float32Array(n * 4 * 2);
  const idx = n * 4 > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (let v = 0; v < 4; v++) seed.set(s, (i * 4 + v) * 4);
    corner.set([-1, 0, 1, 0, 1, 1, -1, 1], i * 8);
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class Rain {
  constructor(scene, terrain, lampUniforms) {
    this.scene = scene;
    const common = {
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uHeight: { value: terrain?.heightTex || null },
      uOrigin: { value: new THREE.Vector2(terrain?.x0 ?? 0, terrain?.z0 ?? 0) },
      uGridMax: { value: new THREE.Vector2(terrain ? terrain.gw : -1, terrain ? terrain.gh : -1) },
      uAmbient: { value: new THREE.Vector3(0.2, 0.22, 0.25) },
      uSunCol: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uLampCol: lampUniforms.uWxLampColor,
      uLamps: lampUniforms.uWxLamps,
      uLampCount: lampUniforms.uWxLampCount,
      uFlash: { value: 0 },
      uCover: { value: 0 },
    };
    this.uniforms = {
      ...common,
      uWind: { value: new THREE.Vector3() },
      uCamVel: { value: new THREE.Vector3() },
      uBox: { value: 22 },
      uHeightBox: { value: 24 },
      uPixel: { value: 0.002 },
      uAlpha: { value: 0 },
    };
    this.splashUniforms = { ...common, uRadius: { value: 16 }, uAlpha: { value: 0 } };
    const blend = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, fog: false };
    this.dropMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: DROP_VERT, fragmentShader: DROP_FRAG, ...blend });
    this.splashMat = new THREE.ShaderMaterial({ uniforms: this.splashUniforms, vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, ...blend });
    this.drops = null;
    this.splashes = null;
    this.setBudget(12000, 900);
  }

  setBudget(maxDrops, maxSplashes) {
    if (this.maxDrops === maxDrops && this.maxSplashes === maxSplashes) return;
    this.maxDrops = maxDrops;
    this.maxSplashes = maxSplashes;
    // smaller budgets reuse the existing buffers (draw range only): no allocation hitch on downgrades
    if (this.drops && maxDrops <= this._capDrops && maxSplashes <= this._capSplashes) return;
    this._capDrops = maxDrops;
    this._capSplashes = maxSplashes;
    for (const m of [this.drops, this.splashes]) if (m) { this.scene.remove(m); m.geometry.dispose(); }
    this.drops = new THREE.Mesh(quads(maxDrops), this.dropMat);
    this.splashes = new THREE.Mesh(quads(maxSplashes), this.splashMat);
    for (const m of [this.drops, this.splashes]) { m.frustumCulled = false; m.renderOrder = 5; m.visible = false; this.scene.add(m); }
  }

  // rain 0..1, camera, wind Vector3, camera velocity, lighting {ambient, sunCol, sunDir}, cover 0..1
  update(dt, rain, camera, wind, camVel, light, cover, flash, enabled = true) {
    const on = enabled && rain > 0.005;
    this.drops.visible = this.splashes.visible = on;
    if (!on) return;
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(camera.position);
    u.uWind.value.copy(wind);
    u.uCamVel.value.copy(camVel);
    u.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(300, window.innerHeight);
    u.uAlpha.value = 0.22 + 0.3 * rain;
    u.uAmbient.value.copy(light.ambient);
    u.uSunCol.value.copy(light.sunCol);
    u.uSunDir.value.copy(light.sunDir);
    u.uFlash.value = flash;
    u.uCover.value = cover;
    const n = Math.round(this.maxDrops * Math.min(1, 0.12 + rain * 0.95));
    this.drops.geometry.setDrawRange(0, n * 6);
    const s = this.splashUniforms;
    s.uAlpha.value = 0.55 * Math.min(1, rain * 1.4);
    this.splashes.geometry.setDrawRange(0, Math.round(this.maxSplashes * Math.min(1, 0.1 + rain)) * 6);
  }

  dispose() {
    for (const m of [this.drops, this.splashes]) if (m) { this.scene.remove(m); m.geometry.dispose(); }
    this.dropMat.dispose();
    this.splashMat.dispose();
  }
}
