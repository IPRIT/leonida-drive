import { GLOBAL_UNIFORMS, WEATHER_GLSL_UNIFORMS, weatherGlslFor } from '../core/globals.js';

// Adds wet look (darker albedo, glossy film, puddles with rain ripples) and moving cloud shadows to a
// MeshStandardMaterial shader inside onBeforeCompile. `worldPos` = GLSL expression of the world position.
export function patchWeather(sh, { worldPos = 'vWorld', porosity = 0.6, puddles = true } = {}) {
  for (const k of Object.keys(WEATHER_GLSL_UNIFORMS)) {
    if (!sh.uniforms[k] && GLOBAL_UNIFORMS[k]) sh.uniforms[k] = GLOBAL_UNIFORMS[k];
  }
  const decl = weatherGlslFor(sh.fragmentShader);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${decl}\nfloat gCloudSh = 1.0;`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec3 wnW = inverseTransformDirection(normal, viewMatrix);
        WeatherWet ww = weatherWet(${worldPos}, ${puddles ? 'wnW.y' : '0.0'});
        diffuseColor.rgb = weatherWetAlbedo(diffuseColor.rgb, ww, ${porosity.toFixed(2)});
        roughnessFactor = weatherWetRoughness(roughnessFactor, ww);
        normal = weatherWetNormal(normal, ww, viewMatrix);
        gCloudSh = cloudShadow(${worldPos}.xz);
      }`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      reflectedLight.directDiffuse *= gCloudSh;
      reflectedLight.directSpecular *= gCloudSh;`);
}
