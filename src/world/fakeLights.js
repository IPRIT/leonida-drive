import * as THREE from 'three';
import { WET_UNIFORMS, MAX_WET_LAMPS } from '../weather/wetMaterial.js';

// Cheap "local lights" for street lamps and traffic signals. Real three.js lights would multiply the per-pixel
// cost of every material and recompile shaders when their number changes, so instead the nearest lamp heads
// (uploaded by Weather into uWxLamps) and signal heads (uploaded by Traffic into uSig*) are evaluated as a small
// diffuse term inside patched materials: characters, cars, facades. Fixed uniform arrays = zero hitches.
export const MAX_SIGNALS = 6;
export const SIGNAL_UNIFORMS = {
  uSig: { value: Array.from({ length: MAX_SIGNALS }, () => new THREE.Vector4()) }, // xyz head, w intensity
  uSigCol: { value: Array.from({ length: MAX_SIGNALS }, () => new THREE.Vector3()) },
  uSigCount: { value: 0 },
};

const GLSL = (declareLamps) => /* glsl */`
  ${declareLamps ? `uniform vec4 uWxLamps[${MAX_WET_LAMPS}]; uniform float uWxLampCount; uniform vec3 uWxLampColor;` : ''}
  uniform vec4 uSig[${MAX_SIGNALS}]; uniform vec3 uSigCol[${MAX_SIGNALS}]; uniform float uSigCount;
  varying vec3 vFLWorld;
  vec3 fakeLocalLights(vec3 wp, vec3 n) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < ${MAX_WET_LAMPS}; i++) {
      if (float(i) >= uWxLampCount) break;
      vec4 L = uWxLamps[i];
      vec3 d = L.xyz - wp;
      float d2 = dot(d, d);
      float att = L.w * 70.0 / (d2 + 20.0) * (1.0 - smoothstep(500.0, 1100.0, d2));
      acc += uWxLampColor * att * max(dot(n, d * inversesqrt(d2)), 0.0);
    }
    for (int i = 0; i < ${MAX_SIGNALS}; i++) {
      if (float(i) >= uSigCount) break;
      vec4 S = uSig[i];
      vec3 d = S.xyz - wp;
      float d2 = dot(d, d);
      float att = S.w * 16.0 / (d2 + 6.0) * (1.0 - smoothstep(150.0, 420.0, d2));
      acc += uSigCol[i] * att * max(dot(n, d * inversesqrt(d2)), 0.15);
    }
    return acc;
  }`;

/** Adds lamp/signal lighting to a MeshStandardMaterial (chains existing onBeforeCompile). Call before first use. */
export function patchFakeLights(mat, { strength = 1 } = {}) {
  if (!mat || mat.userData.fakeLights) return mat;
  mat.userData.fakeLights = true;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (sh, renderer) {
    if (prev) prev.call(this, sh, renderer);
    const declareLamps = !/uniform\s+vec4\s+uWxLamps/.test(sh.fragmentShader);
    sh.uniforms.uWxLamps ??= WET_UNIFORMS.uWxLamps;
    sh.uniforms.uWxLampCount ??= WET_UNIFORMS.uWxLampCount;
    sh.uniforms.uWxLampColor ??= WET_UNIFORMS.uWxLampColor;
    Object.assign(sh.uniforms, SIGNAL_UNIFORMS);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFLWorld;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vFLWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vFLWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL(declareLamps)}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directDiffuse += diffuseColor.rgb * fakeLocalLights(vFLWorld, inverseTransformDirection(normal, viewMatrix)) * ${strength.toFixed(2)};`);
  };
  mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|fl1'; };
  mat.needsUpdate = true;
  return mat;
}

/** Patch every material under an object (vehicles, props). Shared materials are patched once. */
export function patchFakeLightsDeep(obj, opts) {
  obj?.traverse?.((o) => {
    const m = o.material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) if (x.isMeshStandardMaterial) patchFakeLights(x, opts);
  });
}
