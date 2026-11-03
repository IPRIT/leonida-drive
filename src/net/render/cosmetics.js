import * as THREE from 'three';
import { trafficBodyMaterial } from '../../world/TrafficModels.js';

// Per-instance cosmetics: a crowd still uses one draw call per model. Finish
// indices are the shared economy's color / metallic / pearl wire values.
export function remoteBodyMaterial(uniforms) {
  const mat = trafficBodyMaterial(uniforms), base = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => {
    base(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlass; attribute vec2 aCosmetic; varying vec4 vCosmetic;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCosmetic = vec4(aGlass * aCosmetic.x, aPaint, aCosmetic.y, 0.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vCosmetic;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0012, 0.0015, 0.0018), vCosmetic.x * 0.92);')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float finish = vCosmetic.z;
        if (finish > 0.5) roughnessFactor = mix(roughnessFactor, finish > 1.5 ? 0.2 : 0.3, vCosmetic.y);
        roughnessFactor = mix(roughnessFactor, 0.04, vCosmetic.x);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (vCosmetic.z > 0.5) metalnessFactor = mix(metalnessFactor, vCosmetic.z > 1.5 ? 0.45 : 0.75, vCosmetic.y);
        metalnessFactor = mix(metalnessFactor, 0.85, vCosmetic.x);`);
  };
  mat.customProgramCacheKey = () => 'remote-body-cosmetics-v1';
  return mat;
}

export function glassAttribute(baked, geo) {
  const mask = new Float32Array(geo.attributes.position.count);
  for (const g of baked.groups || []) if (/glass|window|windscreen/i.test(g.mat || '')) mask.fill(1, g.start, Math.min(mask.length, g.start + g.count));
  return new THREE.BufferAttribute(mask, 1);
}
