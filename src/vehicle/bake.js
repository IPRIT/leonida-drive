// Traffic baking: one merged low-LOD BufferGeometry per catalog vehicle (cached).
// Frame: same as TrafficModels.bakeCar — origin on the ground (y = 0 = tyre contact), x = 0 centreline,
// z = 0 midway between the front and rear axle, forward = -Z.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { deriveSpec } from './physics/VehiclePhysics.js';
import { buildCarModel } from './CarModel.js';
import { getCatalogEntry } from './catalog.js';

const PAINT_KEYS = new Set(['paint']);
const HEAD_KEYS = new Set(['head']);
const TAIL_KEYS = new Set(['tail', 'amber']);
const SKIP_KEYS = new Set(['sirenRed', 'sirenBlue', 'reverse']);

const cache = new Map();
const _m = new THREE.Matrix4();

function colorize(g, c, paint, head, tail) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), pa = new Float32Array(n), em = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    pa[i] = paint;
    em[i * 2] = head;
    em[i * 2 + 1] = tail;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(pa, 1));
  g.setAttribute('aEmit', new THREE.BufferAttribute(em, 2));
}

function matKey(materials, mat) {
  for (const k of Object.keys(materials)) if (materials[k] === mat) return k;
  return '';
}

function strip(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/**
 * Bake a catalog vehicle for instanced traffic rendering.
 * @param {string} id catalog / preset id
 * @returns {{ id, spec, geo: THREE.BufferGeometry, wheelGeo: THREE.BufferGeometry, wheel: THREE.BufferGeometry,
 *   wheels: Array<{x,y,z,r,w,front,left}>, length, width, height, wheelbase, track: number[], radius, palette, tris }}
 */
export function bakeVehicle(id) {
  let b = cache.get(id);
  if (b) return b;
  const entry = getCatalogEntry(id);
  if (typeof entry?.bake === 'function') {
    b = entry.bake();
    cache.set(id, b);
    return b;
  }
  const spec = deriveSpec(id);
  // damage partition on (same triangles, only grouped differently): every merged vertex range is recorded in
  // `groups` so a crashed traffic car can dent / lose lamps, glass and bumpers like a full vehicle (src/damage)
  const model = buildCarModel(spec, { color: 0xffffff, lod: 'low', parts: true, castShadow: false });
  const parts = [];
  const groups = [];
  let start = 0;
  model.body.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.body.matrixWorld).invert();
  model.body.traverse((m) => {
    if (!m.isMesh || SKIP_KEYS.has(m.name) || !m.visible) return;
    const g = strip(m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
    g.applyMatrix4(_m.multiplyMatrices(inv, m.matrixWorld));
    colorize(g, m.material.color, PAINT_KEYS.has(m.name) ? 1 : 0, HEAD_KEYS.has(m.name) ? 1 : 0, TAIL_KEYS.has(m.name) ? 1 : 0);
    const count = g.attributes.position.count;
    const ud = m.userData;
    const mat = m.name || matKey(model.materials, m.material);
    groups.push({ start, count, mat, part: ud.lamp ? 'lights' : ud.part || 'body', lamp: ud.lamp || null, kind: ud.lamp ? ud.kind || mat : null });
    start += count;
    parts.push(g);
  });
  const geo = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  // single wheel, centred, axle along X, outer face at +X
  const w0 = model.wheels.find((w) => !w.left) || model.wheels[0];
  const wparts = [];
  w0.pivot.updateMatrixWorld(true);
  const winv = new THREE.Matrix4().copy(w0.pivot.matrixWorld).invert();
  w0.pivot.traverse((m) => {
    if (!m.isMesh) return;
    const g = strip(m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
    g.applyMatrix4(_m.multiplyMatrices(winv, m.matrixWorld));
    colorize(g, m.material.color, 0, 0, 0);
    wparts.push(g);
  });
  const wheelGeo = mergeGeometries(wparts, false);
  for (const g of wparts) g.dispose();
  const wheels = model.wheels.map((w) => ({ x: w.x, y: w.r, z: w.z, r: w.r, w: w.pivot.userData.wheel?.w ?? spec.tireWidth[0], front: !!w.steer, left: !!w.left }));
  const bb = geo.boundingBox;
  for (const m of Object.values(model.materials)) m.dispose();
  b = {
    id, name: id, spec, geo, wheelGeo, wheel: wheelGeo, wheels,
    length: bb.max.z - bb.min.z, width: bb.max.x - bb.min.x, height: bb.max.y - bb.min.y,
    wheelbase: spec.wheelbase, track: spec.track, radius: spec.wheelRadius,
    palette: entry?.palette || [spec.color],
    kind: spec.kind || entry?.kind || 'car',
    tris: geo.attributes.position.count / 3,
    groups, // [{ start, count, mat, part, lamp, kind }] vertex ranges of `geo` (material key, damage part, lamp)
  };
  cache.set(id, b);
  return b;
}

/** Drop cached bakes (e.g. after a quality change). */
export function clearBakeCache() {
  for (const b of cache.values()) {
    b.geo.dispose();
    b.wheelGeo.dispose();
  }
  cache.clear();
}
