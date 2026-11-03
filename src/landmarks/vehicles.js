import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeVehicle } from '../vehicle/bake.js';
import { getCatalogEntry } from '../vehicle/catalog.js';
import { buildCarModel } from '../vehicle/CarModel.js';
import { deriveSpec } from '../vehicle/physics/VehiclePhysics.js';
import { buildPlaneModel } from '../air/models/planes.js';
import { buildHeliModel } from '../air/models/helis.js';
import { PLANE_SPECS, HELI_SPECS } from '../air/specs.js';
import { buildBoatModel } from '../boat/models.js';
import { VEHICLE_DIMS } from './vehicle-dims.js';

// Parked props made of the game's real models: catalog cars / trucks / buses (the same low-LOD bake traffic
// uses, wheels merged in), catalog planes and helicopters (src/air) and boats (src/boat). Every model becomes one
// non-indexed geometry with the traffic vertex layout (position, normal, color, aPaint, aEmit); all placements
// of all models share one BatchedMesh and one material (vehicleMaterial), so the whole set is a single draw call.
//
// Model keys: 'car:<catalog id>', 'police:<catalog id>' (car + glowing lightbar), 'plane:<air id>',
// 'heli:<air id>', 'boat:<boat id>'. Frame: forward = -Z, y = 0 on the ground (cars, planes, helicopters) or
// on the waterline (boats).

const PLANE_SPEC_ID = { plane_trainer: 'pipit', plane_stunt: 'vortica', plane_seaplane: 'tarpon', plane_jet: 'solstice' };
// show parked props up to this distance (m, scaled by the quality draw distance)
const MAX_DIST = { car: 420, truck: 600, plane: 1400, heli: 900, boat: 900 };

const cache = new Map();
const failed = new Set();
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();

// geometry with the traffic layout from one mesh (world matrix relative to `inv`)
function layout(src, matrix, color, paint, emit) {
  const g = (src.index ? src.toNonIndexed() : src.clone());
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.applyMatrix4(matrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), pa = new Float32Array(n), em = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; pa[i] = paint; em[i * 2] = emit; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(pa, 1));
  g.setAttribute('aEmit', new THREE.BufferAttribute(em, 2));
  return g;
}

// copy of a baked traffic geometry with parked lamps (no head / tail glow)
function parkedCopy(src) {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'color', 'aPaint']) g.setAttribute(k, src.attributes[k].clone());
  g.setAttribute('aEmit', new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 2), 2));
  return g;
}

function carModel(id, police) {
  const b = bakeVehicle(id);
  const parts = [parkedCopy(b.geo)];
  // wheels: the bake keeps one (axle along X, outer face +X); left wheels are turned around
  const wg = parkedCopy(b.wheelGeo || b.wheel);
  for (const w of b.wheels) {
    const g = wg.clone();
    _m.makeRotationY(w.left ? Math.PI : 0).setPosition(w.x, w.y, w.z);
    g.applyMatrix4(_m);
    parts.push(g);
  }
  wg.dispose();
  // police: the lightbar lenses (the traffic bake skips them) glow softly in their own colour
  if (police) {
    const model = buildCarModel(deriveSpec(id), { color: 0xffffff, lod: 'low', parts: true, castShadow: false });
    model.body.updateMatrixWorld(true);
    _inv.copy(model.body.matrixWorld).invert();
    model.body.traverse((m) => {
      if (!m.isMesh || (m.name !== 'sirenRed' && m.name !== 'sirenBlue')) return;
      parts.push(layout(m.geometry, _m.multiplyMatrices(_inv, m.matrixWorld), m.material.emissive, 0, 1));
    });
    for (const m of Object.values(model.materials)) m.dispose();
  }
  const geo = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  const entry = getCatalogEntry(id);
  const kind = /truck|bus/.test(b.kind) || b.length > 7 ? 'truck' : 'car';
  return finish(geo, { palette: entry?.palette || b.palette || [0xffffff], kind, ground: false });
}

// any src/air or src/boat model group -> one geometry
function groupModel(root, { kind, palette, ground }) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const parts = [];
  root.traverseVisible((m) => {
    if (!m.isMesh || m.name === 'blurDisc') return;
    const mat = m.material;
    if (!mat?.isMeshStandardMaterial || mat.transparent) return;
    // nav / landing lamps with a strong emissive: their emissive colour, softly glowing; everything else matte
    const lamp = mat.emissiveIntensity >= 0.5 && mat.emissive && (mat.emissive.r + mat.emissive.g + mat.emissive.b) > 0.3;
    const paint = mat.name === 'paint' ? 1 : 0;
    parts.push(layout(m.geometry, _m.multiplyMatrices(_inv, m.matrixWorld), lamp ? mat.emissive : mat.color, paint, lamp ? 0.6 : 0));
  });
  const geo = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  root.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
  return finish(geo, { palette, kind, ground });
}

function finish(geo, { palette, kind, ground }) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  // planes / helicopters: lowest point (tyres, skids) on y = 0
  if (ground) { geo.translate(0, -bb.min.y, 0); geo.computeBoundingBox(); }
  geo.computeBoundingSphere();
  const b = geo.boundingBox;
  return {
    geo, kind, palette,
    len: b.max.z - b.min.z, wid: b.max.x - b.min.x, h: b.max.y - b.min.y,
    cx: (b.max.x + b.min.x) / 2, cz: (b.max.z + b.min.z) / 2, y0: b.min.y,
    tris: geo.attributes.position.count / 3, verts: geo.attributes.position.count,
    maxDist: MAX_DIST[kind] ?? 500,
  };
}

// build cost (ms) per model key, for the landmark timing report
export const VEHICLE_BAKE_MS = {};

/**
 * Parked model for a key (cached per key). With a dimensions entry in vehicle-dims.js (written by
 * tools/landmark_geom.mjs) this costs nothing: the model has its sizes but no geometry yet (geo = null, ready =
 * false) and the geometry is baked later off the main thread (vehicleWorker.js, see Landmarks.bakeVehicles).
 * Without an entry, or with globalThis.LMK_SYNC_BAKE set (node tools), it is baked right here.
 */
export function vehicleModel(key) {
  let m = cache.get(key);
  if (m) return m;
  if (failed.has(key)) throw new Error(`vehicle model ${key} unavailable`);
  const d = VEHICLE_DIMS[key];
  if (d && !globalThis.LMK_SYNC_BAKE) {
    m = { ...d, palette: d.palette.slice(), key, geo: null, ready: false, maxDist: MAX_DIST[d.kind] ?? 500 };
    cache.set(key, m);
    return m;
  }
  const t0 = performance.now();
  try { m = buildModel(key); } catch (e) { failed.add(key); throw e; }
  m.ready = true;
  VEHICLE_BAKE_MS[key] = +(performance.now() - t0).toFixed(1);
  return m;
}

/** Bake the geometry of a key (worker or main-thread fallback); plain attribute arrays. */
export function bakeVehicleArrays(key) {
  const m = buildModel(key, false);
  const a = m.geo.attributes, out = {};
  for (const k of ['position', 'normal', 'color', 'aPaint', 'aEmit']) out[k] = a[k].array;
  return { key, attrs: out, len: m.len, wid: m.wid, h: m.h, verts: m.verts };
}

/** Geometry from baked arrays. */
export function vehicleGeometry(attrs) {
  const g = new THREE.BufferGeometry();
  const size = { position: 3, normal: 3, color: 3, aPaint: 1, aEmit: 2 };
  for (const k of Object.keys(size)) g.setAttribute(k, new THREE.BufferAttribute(attrs[k], size[k]));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Dimensions table entry of a built model (tools/landmark_geom.mjs writes vehicle-dims.js from these). */
export function vehicleDimsEntry(m) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return { kind: m.kind, palette: m.palette, len: r(m.len), wid: r(m.wid), h: r(m.h), cx: r(m.cx), cz: r(m.cz), y0: r(m.y0), tris: m.tris, verts: m.verts };
}

/** Dimensions of every model baked so far, keyed and sorted (for vehicle-dims.js). */
export function vehicleDimsTable() {
  const out = {};
  for (const k of [...cache.keys()].sort()) if (cache.get(k).geo) out[k] = vehicleDimsEntry(cache.get(k));
  return out;
}

function buildModel(key, store = true) {
  let m;
  const [type, id] = key.split(':');
  if (type === 'car' || type === 'police') m = carModel(id, type === 'police');
  else if (type === 'plane') {
    const mats = buildPlaneModel(id, PLANE_SPECS[PLANE_SPEC_ID[id]]);
    m = groupModel(mats.root, { kind: 'plane', palette: [0xf4f2ee, 0xd23a3a, 0x1f5fbf, 0xf2a71b, 0x2f8f3a, 0x111111], ground: true });
    for (const x of Object.values(mats.materials)) x.dispose?.();
  } else if (type === 'heli') {
    const mats = buildHeliModel(id, HELI_SPECS[id]);
    m = groupModel(mats.root, { kind: 'heli', palette: [0xf3f1ec], ground: true });
    for (const x of Object.values(mats.materials)) x.dispose?.();
  } else if (type === 'boat') {
    const mats = buildBoatModel(id);
    m = groupModel(mats.root, { kind: 'boat', palette: [0xe0303f, 0x1d3157, 0xf2f2ee, 0x14b8c4], ground: false });
    for (const x of Object.values(mats.materials)) x.dispose?.();
  } else throw new Error(`unknown vehicle model ${key}`);
  m.key = key;
  if (store) cache.set(key, m);
  return m;
}

/** Civilian cars for parking lots (common traffic models, varied body styles). */
// (few models: every one is a bake at load time; all are common traffic models whose bakes traffic reuses)
export const LOT_CARS = ['car:meridian', 'car:kitsune', 'car:suv', 'car:pickup'];
