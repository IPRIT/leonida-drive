import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../core/globals.js';
import { patchWeather } from '../world/weatherPatch.js';

const U = GLOBAL_UNIFORMS;

// All materials are created once at init. Night intensity, flicker, bobbing and pulses are pure shader math on the
// global uniforms (uTime, uNight) — no runtime material changes, no lights.

// Low-poly prop material: vertex colours; `aTint` (0..1) mixes in the instance colour; `aEmit` (rgb) is emitted at night
// (windows, kiosk signs, lamps); `bob` makes instances float on the water (heave + roll + pitch from the instance position).
export function propMaterial({ bob = false, side = THREE.FrontSide, roughness = 0.8, metalness = 0.04, weather = true } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness, metalness, side });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aTint; attribute vec3 aEmit;
        uniform float uTime;
        varying vec3 vEmit; varying vec3 vLifeW;`)
      .replace('#include <color_vertex>', `
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR )
          vColor = vec4( 1.0 );
        #endif
        #ifdef USE_COLOR_ALPHA
          vColor *= color;
        #elif defined( USE_COLOR )
          vColor.rgb *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aTint);
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vEmit = aEmit;
        ${bob ? `
        #ifdef USE_INSTANCING
        {
          float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
          float r1 = sin(uTime * 0.83 + ph) * 0.03, r2 = sin(uTime * 0.61 + ph * 1.7) * 0.018;
          float c1 = cos(r1), s1 = sin(r1), c2 = cos(r2), s2 = sin(r2);
          transformed.xy = vec2(c1 * transformed.x - s1 * transformed.y, s1 * transformed.x + c1 * transformed.y);
          transformed.zy = vec2(c2 * transformed.z - s2 * transformed.y, s2 * transformed.z + c2 * transformed.y);
          transformed.y += sin(uTime * 0.9 + ph * 2.3) * 0.13;
        }
        #endif` : ''}
        #ifdef USE_INSTANCING
          vLifeW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vLifeW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying vec3 vEmit; varying vec3 vLifeW;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vEmit * (0.03 + 1.7 * uNight);`);
    if (weather) patchWeather(sh, { worldPos: 'vLifeW', porosity: 0.35, puddles: false });
  };
  mat.customProgramCacheKey = () => `life-prop-${bob ? 'b' : ''}${side}${weather ? 'w' : ''}`;
  return mat;
}

// Self-lit material (neon, rings, markers, flashes): MeshBasicMaterial whose output is scaled by a day/night intensity,
// an optional pulse, per-instance flicker (aData.z > 0) and a distance fade (additive variants).
// With `atlas`, aData.xy is the atlas cell origin (UV units) and `cell` its size.
export function glowMaterial({
  color = 0xffffff, day = 0.5, night = 3.0, pulse = 0, pulseSpeed = 4, additive = false, map = null, cell = null,
  vertexColors = false, side = THREE.FrontSide, fadeFar = 0, fadeNear = 0, data = false, opacity = 1, key = '', heightFade = false,
} = {}) {
  const mat = new THREE.MeshBasicMaterial({
    color, map, vertexColors, side, transparent: additive || opacity < 1, opacity,
    depthWrite: !additive, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: !additive,
  });
  const u = {
    uGlowDay: { value: day }, uGlowNight: { value: night }, uPulse: { value: pulse }, uPulseSpeed: { value: pulseSpeed },
    uFadeFar: { value: fadeFar }, uFadeNear: { value: fadeNear }, uCell: { value: new THREE.Vector2(cell ? cell[0] : 1, cell ? cell[1] : 1) },
  };
  mat.userData.glow = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${data ? 'attribute vec4 aData;' : ''}
        uniform vec2 uCell;
        varying vec3 vGlowW; varying float vFlick; varying float vGain; varying float vH;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vH = position.y;
        #ifdef USE_INSTANCING
          vGlowW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vGlowW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        ${data ? 'vFlick = aData.z; vGain = aData.w > 0.0 ? aData.w : 1.0;' : 'vFlick = 0.0; vGain = 1.0;'}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        ${data && map ? '#ifdef USE_MAP\n vMapUv = (aData.xy + uv * uCell); \n#endif' : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uNight; uniform float uGlowDay; uniform float uGlowNight;
        uniform float uPulse; uniform float uPulseSpeed; uniform float uFadeFar; uniform float uFadeNear;
        varying vec3 vGlowW; varying float vFlick; varying float vGain; varying float vH;`)
      .replace('#include <opaque_fragment>', `
        {
          float k = mix(uGlowDay, uGlowNight, uNight) * vGain;
          k *= 1.0 + uPulse * sin(uTime * uPulseSpeed);
          if (vFlick > 0.0) {
            float n = fract(sin(floor(uTime * 11.0) * 12.9898 + vFlick * 78.233) * 43758.5453);
            float n2 = fract(sin(floor(uTime * 2.3) * 4.1414 + vFlick * 19.19) * 23421.631);
            k *= (n < 0.28 && n2 < 0.6) ? 0.08 : 1.0;
          }
          ${heightFade ? 'k *= 1.0 - smoothstep(0.0, 1.0, vH);' : ''}
          if (uFadeFar > 0.0) k *= 1.0 - smoothstep(uFadeFar * 0.55, uFadeFar, distance(vGlowW, cameraPosition));
          // fade out when the camera is inside / right next to it (start markers around the player's car)
          if (uFadeNear > 0.0) k *= mix(0.12, 1.0, smoothstep(uFadeNear * 0.45, uFadeNear, distance(vGlowW.xz, cameraPosition.xz)));
          outgoingLight *= k;
          ${additive ? 'diffuseColor.a *= 1.0;' : ''}
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `life-glow-${key}-${additive ? 'a' : 'o'}-${data ? 'd' : ''}-${map ? 'm' : ''}-${vertexColors ? 'v' : ''}-${heightFade ? 'h' : ''}`;
  return mat;
}

// Billboard faces: atlas ad (aData.xy = cell origin, z = broken flag, w = seed), lit at night by the frame lamps.
export function billboardFaceMaterial(atlas, cell) {
  const mat = new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.62, metalness: 0.0 });
  const uCell = { value: new THREE.Vector2(cell[0], cell[1]) };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uNight = U.uNight;
    sh.uniforms.uCell = uCell;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aData; uniform vec2 uCell;
        varying vec4 vAd; varying vec2 vFaceUv; varying vec3 vLifeW;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = aData.xy + uv * uCell;
        #endif
        vAd = aData; vFaceUv = uv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vLifeW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vLifeW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uNight;
        varying vec4 vAd; varying vec2 vFaceUv; varying vec3 vLifeW;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // flood lamps sit below the board: brighter at the bottom edge, pools of light between the lamps
          float pool = 0.65 + 0.35 * pow(abs(cos(vFaceUv.x * 3.14159 * 2.0)), 2.0);
          float lamp = mix(1.25, 0.55, vFaceUv.y) * pool;
          float k = 0.015 + 1.05 * uNight * lamp;
          if (vAd.z > 0.5) {
            float n = fract(sin(floor(uTime * 13.0) * 12.9898 + vAd.w * 78.233) * 43758.5453);
            float n2 = fract(sin(floor(uTime * 1.7) * 4.1414 + vAd.w * 9.19) * 23421.631);
            k *= (n < 0.4 && n2 < 0.55) ? 0.06 : (n2 > 0.92 ? 0.35 : 1.0);
          }
          totalEmissiveRadiance += diffuseColor.rgb * k;
        }`);
    patchWeather(sh, { worldPos: 'vLifeW', porosity: 0.1, puddles: false });
  };
  mat.customProgramCacheKey = () => 'life-billboard-face';
  return mat;
}
