import * as THREE from 'three';
import { GLOBAL_UNIFORMS, WEATHER_GLSL_UNIFORMS, weatherGlslFor } from '../core/globals.js';

// Street lamps near the camera, written by Weather (night + wet only). xyz = head position, w = intensity.
export const MAX_WET_LAMPS = 12;
export const WET_UNIFORMS = {
  uWxLamps: { value: Array.from({ length: MAX_WET_LAMPS }, () => new THREE.Vector4()) },
  uWxLampCount: { value: 0 },
  uWxLampColor: { value: new THREE.Color(1.0, 0.62, 0.3) },
};

const LAMP_GLSL = /* glsl */`
  uniform vec4 uWxLamps[${MAX_WET_LAMPS}];
  uniform float uWxLampCount;
  uniform vec3 uWxLampColor;
  // anisotropic (view-stretched) reflection streaks of street lamps on a wet, near-horizontal surface
  vec3 wetLampStreaks(vec3 wp, float wet, float rough) {
    vec3 acc = vec3(0.0);
    if (uWxLampCount < 0.5 || wet < 0.04) return acc;
    vec3 V = normalize(cameraPosition - wp);
    vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), V) + vec3(1e-4, 0.0, 0.0));
    vec3 b = cross(t, vec3(0.0, 1.0, 0.0));
    float ax = 0.035 + rough * 0.12, ay = 0.3 + rough * 0.4;
    for (int i = 0; i < ${MAX_WET_LAMPS}; i++) {
      if (float(i) >= uWxLampCount) break;
      vec4 lp = uWxLamps[i];
      vec3 L = lp.xyz - wp;
      float d2 = dot(L, L);
      L *= inversesqrt(d2);
      vec3 H = normalize(L + V);
      float ht = dot(H, t) / ax, hb = dot(H, b) / ay;
      float s = exp(-(ht * ht + hb * hb) / max(H.y * H.y, 1e-3));
      acc += s * lp.w / (1.0 + d2 * 0.0012);
    }
    return uWxLampColor * acc * wet;
  }
`;

/**
 * Adds the weather look to a MeshStandardMaterial / MeshPhysicalMaterial (also ones that already have their own
 * onBeforeCompile): wet albedo/roughness, puddles with rain ripples, cloud shadows on direct light,
 * street-lamp streaks on wet ground at night and the SSR mirror mask (written to the colour alpha).
 *
 * opts.porosity     GLSL float expression (default '0.7'), e.g. '0.35 * (1.0 - gGlass)' for buildings
 * opts.puddles      0..1 scale of puddles on flat parts (default 1)
 * opts.lampStreaks  bool (default true)
 * opts.cloudShadows bool (default true)
 * opts.ssrMask      bool (default true; ignored for transparent materials)
 * opts.dryRoughness minimum roughness when dry (default 0.6 = no sun glare on big surfaces; 0 for car paint)
 */
export function patchWeatherMaterial(mat, opts = {}) {
  if (mat.userData.weatherPatched) return mat;
  mat.userData.weatherPatched = true;
  const o = { porosity: '0.7', puddles: 1, lampStreaks: true, cloudShadows: true, ssrMask: true, dryRoughness: 0.6, ...opts };
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (sh, renderer) {
    if (prev) prev.call(this, sh, renderer);
    for (const name of Object.keys(WEATHER_GLSL_UNIFORMS)) if (!sh.uniforms[name]) sh.uniforms[name] = GLOBAL_UNIFORMS[name];
    Object.assign(sh.uniforms, WET_UNIFORMS);
    // the material may already carry the wet look (e.g. src/world/weatherPatch.js): then only add the extras
    const base = /WEATHER_GLSL_FUNCS/.test(sh.fragmentShader);
    const fsHead = (base ? '' : weatherGlslFor(sh.fragmentShader)) + (o.lampStreaks ? LAMP_GLSL : '') + '\nvarying vec3 vWxWp;\n';
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWxWp;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wxP = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          wxP = batchingMatrix * wxP;
        #endif
        #ifdef USE_INSTANCING
          wxP = instanceMatrix * wxP;
        #endif
        vWxWp = (modelMatrix * wxP).xyz;`);
    let fs = sh.fragmentShader.replace('#include <common>', `#include <common>\n${fsHead}`);
    const wetState = `
        vec3 wxN = normalize(cross(dFdx(vWxWp), dFdy(vWxWp)));
        WeatherWet wx = weatherWet(vWxWp, wxN.y);
        wx.puddle *= ${Number(o.puddles).toFixed(3)};`;
    if (base) {
      fs = fs.replace('#include <roughnessmap_fragment>', `${wetState}
#include <roughnessmap_fragment>`);
    } else {
      fs = fs.replace('#include <roughnessmap_fragment>', `${wetState}
        diffuseColor.rgb = weatherWetAlbedo(diffuseColor.rgb, wx, clamp(${o.porosity}, 0.0, 1.0));
        #include <roughnessmap_fragment>
        roughnessFactor = max(roughnessFactor, ${Number(o.dryRoughness).toFixed(3)});
        roughnessFactor = mix(roughnessFactor, min(roughnessFactor, 0.28), wx.wet);
        roughnessFactor = mix(roughnessFactor, 0.035, wx.puddle);`);
      fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = weatherWetNormal(normal, wx, viewMatrix);`);
    }
    let light = '';
    if (o.cloudShadows && !base) light += 'float wxCs = cloudShadow(vWxWp.xz); reflectedLight.directDiffuse *= wxCs; reflectedLight.directSpecular *= wxCs;\n';
    if (o.lampStreaks) light += 'reflectedLight.directSpecular += wetLampStreaks(vWxWp, max(wx.wet * smoothstep(0.6, 0.95, wxN.y), wx.puddle), roughnessFactor);\n';
    if (light) fs = fs.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n${light}`);
    if (o.ssrMask && !mat.transparent) {
      fs = fs.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        gl_FragColor.a = 1.0 - 0.5 * weatherMirror(wx) * smoothstep(0.5, 0.9, wxN.y);`);
    }
    sh.fragmentShader = fs;
  };
  const own = prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey;
  const tag = `|wx2|${o.porosity}|${o.puddles}|${o.dryRoughness}|${+o.lampStreaks}${+o.cloudShadows}${+o.ssrMask}`;
  mat.customProgramCacheKey = function () { return (own ? prevKey.call(this) : String(prev || '')) + tag; };
  mat.needsUpdate = true;
  return mat;
}

// Convenience: patch the integrator's world materials (terrain, roads, buildings) once.
export function patchWorldMaterials(game) {
  if (game.terrain?.material) patchWeatherMaterial(game.terrain.material, { porosity: '0.85', puddles: 0.6 });
  if (game.roads?.material) patchWeatherMaterial(game.roads.material, { porosity: '0.7', puddles: 1 });
  if (game.buildings?.material) {
    const glass = /gGlass/.test(String(game.buildings.material.onBeforeCompile)) ? '0.4 * (1.0 - gGlass)' : '0.4';
    patchWeatherMaterial(game.buildings.material, { porosity: glass, puddles: 0.8, lampStreaks: false });
  }
}
