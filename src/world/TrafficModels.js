import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildCarModel } from '../vehicle/CarModel.js';
import { deriveSpec } from '../vehicle/index.js';

// Bake the player car designs into single-draw-call instanced bodies for traffic.
// attributes: color (base), aPaint (1 = takes per-instance paint), aEmit (rgb emissive, x = head, y = tail)
const PAINT_KEYS = new Set(['paint']);
const HEAD_KEYS = new Set(['head']);
const TAIL_KEYS = new Set(['tail', 'amber']);
const SKIP_KEYS = new Set(['sirenRed', 'sirenBlue', 'reverse']);

export function bakeCar(presetName) {
  const spec = deriveSpec(presetName);
  const model = buildCarModel(spec, { color: 0xffffff });
  const parts = [];
  model.body.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.body.matrixWorld).invert();
  model.body.traverse((m) => {
    if (!m.isMesh || SKIP_KEYS.has(m.name)) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    const mat = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    g.applyMatrix4(mat);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3), paint = new Float32Array(n), emit = new Float32Array(n * 2);
    const c = m.material.color;
    const isPaint = PAINT_KEYS.has(m.name);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      paint[i] = isPaint ? 1 : 0;
      emit[i * 2] = HEAD_KEYS.has(m.name) ? 1 : 0;
      emit[i * 2 + 1] = TAIL_KEYS.has(m.name) ? 1 : 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPaint', new THREE.BufferAttribute(paint, 1));
    g.setAttribute('aEmit', new THREE.BufferAttribute(emit, 2));
    parts.push(g);
  });
  const geo = mergeGeometries(parts, false);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  // wheel geometry (single wheel, centred, axis = x)
  const w = model.wheels[1];
  w.pivot.updateMatrixWorld(true);
  const winv = new THREE.Matrix4().copy(w.pivot.matrixWorld).invert();
  const wparts = [];
  w.pivot.traverse((m) => {
    if (!m.isMesh) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(winv, m.matrixWorld));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = m.material.color;
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    wparts.push(g);
  });
  const wheel = mergeGeometries(wparts, false);
  const bb = geo.boundingBox;
  return {
    name: presetName, spec, geo, wheel,
    length: bb.max.z - bb.min.z, width: bb.max.x - bb.min.x, height: bb.max.y - bb.min.y,
    wheelbase: spec.wheelbase, track: spec.track, radius: spec.wheelRadius,
  };
}

export function trafficBodyMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.42, metalness: 0.25 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uniforms.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPaint; attribute vec2 aEmit; attribute vec3 aTint; attribute float aBrake;
        varying vec2 vEmit; varying float vBrake;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb = mix(vColor.rgb, aTint, aPaint);
        vEmit = aEmit; vBrake = aBrake;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight; varying vec2 vEmit; varying float vBrake;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.93, 0.8) * vEmit.x * (0.15 + 3.5 * uNight);
        totalEmissiveRadiance += vec3(1.0, 0.04, 0.05) * vEmit.y * (0.25 + 1.6 * uNight + 3.0 * vBrake);`);
  };
  mat.customProgramCacheKey = () => 'traffic-body';
  return mat;
}
