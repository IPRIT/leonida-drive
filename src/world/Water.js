import * as THREE from 'three';
import { GLOBAL_UNIFORMS, weatherGlslFor } from '../core/globals.js';

// Sea-level water (workstream F): depth-aware colour from the terrain height texture, wind-driven waves,
// rain ring ripples, sky reflections from the sky probe (same sky as the dome), sun/moon glints, shore foam
// and storm whitecaps. Writes depth and marks itself in the colour alpha (= 0) so the SSR pass reflects
// the city in it on high/ultra. Seen from below it renders a Snell's-window underside.
const FRAG_HEAD = /* glsl */`
  uniform highp sampler2D uHeight;
  uniform vec2 uOrigin, uGridMax;
  uniform samplerCube uEnv;
  uniform float uNight, uEnvOn;
  uniform vec3 uSunCol, uLightCol, uMoonDir, uMoonCol, uAmbient, uHorizonCol;
  varying vec3 vWorld;
`;

const FRAG_BODY = /* glsl */`
  float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y); }
  float terrainH(vec2 xz) {
    vec2 g = (xz - uOrigin) / 8.0;
    if (g.x < 0.0 || g.y < 0.0 || g.x > uGridMax.x || g.y > uGridMax.y) return -40.0;
    ivec2 i = ivec2(floor(g)); vec2 f = fract(g);
    ivec2 mx = ivec2(uGridMax);
    float a = texelFetch(uHeight, clamp(i, ivec2(0), mx), 0).r;
    float b = texelFetch(uHeight, clamp(i + ivec2(1,0), ivec2(0), mx), 0).r;
    float c = texelFetch(uHeight, clamp(i + ivec2(0,1), ivec2(0), mx), 0).r;
    float d = texelFetch(uHeight, clamp(i + ivec2(1,1), ivec2(0), mx), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  vec2 waveGrad(vec2 p, float t, float chop) {
    vec2 g = vec2(0.0);
    vec2 wd = length(uWind.xz) > 0.01 ? normalize(uWind.xz) : vec2(0.8, 0.6);
    vec2 d1 = wd, d2 = normalize(wd + vec2(-0.6, 0.5)), d3 = normalize(wd + vec2(0.7, -0.5)), d4 = normalize(vec2(-wd.y, wd.x) + wd * 0.3);
    g += d1 * cos(dot(p, d1) * 0.21 + t * 1.3) * 0.21 * 0.35;
    g += d2 * cos(dot(p, d2) * 0.37 + t * 1.7) * 0.37 * 0.22;
    g += d3 * cos(dot(p, d3) * 0.83 + t * 2.6) * 0.83 * 0.08 * chop;
    g += d4 * cos(dot(p, d4) * 1.71 + t * 3.4) * 1.71 * 0.035 * chop;
    float e = 0.35;
    vec2 q = p * 0.55 + t * 0.35 * (0.6 + wd);
    float n0 = noise(q);
    g += vec2(noise(q + vec2(e, 0.0)) - n0, noise(q + vec2(0.0, e)) - n0) / e * 0.18 * chop;
    return g;
  }
  vec3 envSample(vec3 R, float lod) {
    if (uEnvOn < 0.5) return mix(uHorizonCol, uAmbient * 1.5, clamp(R.y * 2.0, 0.0, 1.0));
    return textureLod(uEnv, R, lod).rgb;
  }
  void main() {
    float t = uWxTime;
    vec3 V = normalize(cameraPosition - vWorld);
    float dist = length(cameraPosition - vWorld);
    float th = terrainH(vWorld.xz);
    float depth = max(-th, 0.0);
    float windK = clamp(length(uWind) / 10.0, 0.0, 1.5);
    if (!gl_FrontFacing) {
      // underside: Snell's window + total internal reflection tint
      float cosT = clamp(-V.y, 0.0, 1.0);
      vec3 deepTint = vec3(0.01, 0.1, 0.11) * (0.1 + 0.9 * (1.0 - uNight));
      vec3 win = envSample(vec3(-V.x, -V.y, -V.z) * vec3(1.0, -1.0, 1.0), 2.0) * 0.8;
      vec3 col = mix(deepTint, win, smoothstep(0.62, 0.75, cosT));
      gl_FragColor = vec4(col, 1.0);
      return;
    }
    float calm = smoothstep(0.0, 3.0, depth);
    float lodf = 1.0 - smoothstep(300.0, 2500.0, dist);
    float chop = 0.7 + windK * 0.9;
    vec2 g = waveGrad(vWorld.xz, t, chop) * (0.25 + 0.75 * calm) * (0.35 + 0.65 * lodf) * (0.8 + windK * 0.5);
    // rain ripples (close range)
    if (uRain > 0.01 && dist < 140.0) g += rainRipples(vWorld.xz * 1.1) * 1.3 * (1.0 - smoothstep(30.0, 140.0, dist));
    vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
    // body colour: turquoise shallows -> deep blue, darker and greyer in storms
    vec3 shallow = vec3(0.07, 0.62, 0.64);
    vec3 mid = vec3(0.015, 0.38, 0.55);
    vec3 deep = vec3(0.01, 0.14, 0.32);
    vec3 water = mix(shallow, mid, smoothstep(0.4, 5.0, depth));
    water = mix(water, deep, smoothstep(5.0, 26.0, depth));
    water = mix(water, vec3(0.05, 0.13, 0.15), uCloudCover * 0.45);
    vec3 light = uLightCol * max(uSunDir.y, 0.0) * 0.32 + uAmbient * 1.4;
    vec3 body = water * light;
    // subsurface glow through wave crests toward the sun
    body += shallow * uLightCol * pow(max(dot(-V, uSunDir), 0.0), 4.0) * 0.12 * (1.0 - calm * 0.5);
    // reflections from the sky probe (blurrier with distance / rough water)
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    float rough = 0.04 + 0.12 * (1.0 - lodf) + windK * 0.05 + uRain * 0.05;
    vec3 refl = envSample(R, clamp(rough * 9.0, 0.0, 5.0));
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    // sun + moon glints
    float rs = max(dot(R, uSunDir), 0.0);
    vec3 glint = uSunCol * (pow(rs, 2400.0) * 9.0 + pow(rs, 300.0) * 0.12) * step(0.0, uSunDir.y);
    float rm = max(dot(R, uMoonDir), 0.0);
    glint += uMoonCol * (pow(rm, 500.0) * 6.0 + pow(rm, 40.0) * 0.08);
    glint *= 1.0 - 0.85 * smoothstep(0.6, 1.0, uCloudCover);
    // foam: shore bands + storm whitecaps
    float fn = noise(vWorld.xz * 0.35 + vec2(t * 0.25, -t * 0.18));
    float band = sin(depth * 5.5 - t * 1.7 + fn * 4.0) * 0.5 + 0.5;
    float foam = (1.0 - smoothstep(0.05, 0.9, depth)) * smoothstep(0.35, 0.9, band + fn * 0.4);
    foam += (1.0 - smoothstep(0.0, 0.18, depth)) * 0.8;
    float caps = smoothstep(0.78, 0.95, noise(vWorld.xz * 0.12 + t * 0.2) * 0.6 + noise(vWorld.xz * 0.5 - t * 0.3) * 0.4) * smoothstep(0.6, 1.2, windK) * calm;
    foam = clamp(foam + caps * 0.7, 0.0, 1.0);
    vec3 foamCol = vec3(0.95, 0.98, 1.0) * (light * 1.6 + uLightCol * 0.15);
    float a = mix(0.5, 1.0, smoothstep(0.2, 3.5, depth));
    // premultiplied: transmitted body + reflection on top
    vec3 rgb = body * (1.0 - F) * a + refl * F + glint;
    float alpha = a * (1.0 - F) + F;
    rgb = mix(rgb, foamCol, foam * 0.85);
    alpha = mix(alpha, 1.0, foam * 0.85);
    gl_FragColor = vec4(rgb / max(alpha, 1e-3), alpha);
    #include <fog_fragment>
    gl_FragColor.rgb *= gl_FragColor.a;
  }
`;

export class Water {
  constructor(scene, terrain, sky) {
    this.terrain = terrain;
    this.sky = sky;
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uHeight: { value: null },
      uOrigin: { value: new THREE.Vector2(terrain.x0, terrain.z0) },
      uGridMax: { value: new THREE.Vector2(terrain.gw, terrain.gh) },
      uNight: { value: 0 },
      uEnv: { value: null },
      uEnvOn: { value: 0 },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) },
      uLightCol: { value: new THREE.Vector3(1, 1, 1) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonCol: { value: new THREE.Vector3() },
      uAmbient: { value: new THREE.Vector3(0.2, 0.25, 0.3) },
      uHorizonCol: { value: new THREE.Vector3(0.6, 0.7, 0.8) },
    }]);
    this.uniforms.uHeight.value = terrain.heightTex;
    for (const k of ['uWxTime', 'uRain', 'uWind', 'uSunDir', 'uCloudCover', 'uWetness', 'uLightning', 'uCloudOffset']) this.uniforms[k] = GLOBAL_UNIFORMS[k];
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: true,
      fog: true,
      side: THREE.DoubleSide,
      // premultiplied colour; alpha channel forced to 0 = "water" in the SSR mirror mask
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.ZeroFactor,
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `${FRAG_HEAD}\n#include <fog_pars_fragment>\n${weatherGlslFor(FRAG_HEAD)}\n${FRAG_BODY}`,
    });
    this.material = mat;
    const geo = new THREE.PlaneGeometry(80000, 80000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1; // first transparent: particles above the surface draw over it, below it are hidden
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  attach(game) { this.game = game; }

  update(dt, camera, night) {
    const u = this.uniforms, sky = this.sky;
    u.uNight.value = night;
    if (sky) {
      u.uEnv.value = sky.envTexture || null;
      u.uEnvOn.value = sky.envTexture && sky.envEnabled !== false ? 1 : 0;
      const L = sky.sunCSM?.visible ? sky.sunCSM : sky.sun;
      u.uLightCol.value.set(L.color.r, L.color.g, L.color.b).multiplyScalar(L.intensity);
      const disc = sky.uniforms.uSunDisc?.value;
      if (disc) u.uSunCol.value.copy(disc).multiplyScalar(1 / 140);
      u.uMoonDir.value.copy(sky.moonDir);
      const mb = sky.uniforms.uMoonBright?.value ?? 0;
      u.uMoonCol.value.set(0.7, 0.78, 1.0).multiplyScalar(mb * night * (0.4 + 0.6 * (sky.moonIllum ?? 1)) * (sky.moonDir.y > 0 ? 1 : 0));
      const h = sky.hemi;
      u.uAmbient.value.set(h.color.r, h.color.g, h.color.b).multiplyScalar(h.intensity * 0.35);
      u.uHorizonCol.value.set(sky.horizon.r, sky.horizon.g, sky.horizon.b);
    }
    this.mesh.position.set(Math.round(camera.position.x / 100) * 100, 0, Math.round(camera.position.z / 100) * 100);
  }
}
