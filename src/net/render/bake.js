// Baked, single-draw-call geometry for remote vehicles. Ground vehicles reuse the catalog bake of workstream A
// (src/vehicle/bake.js, the traffic format); aircraft and boats are merged from workstream B's model builders. Any
// failure falls back to a simple procedural proxy so a remote player is never invisible.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const cache = new Map();
const _m = new THREE.Matrix4();

function colorize(g, c, paint = 0) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), pa = new Float32Array(n), em = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; pa[i] = paint; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(pa, 1));
  g.setAttribute('aEmit', new THREE.BufferAttribute(em, 2));
  return g;
}
function strip(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

// merge every visible mesh under `root` (in root space) into one vertex-coloured geometry
function mergeObject(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const parts = [];
  root.traverse((m) => {
    if (!m.isMesh || !m.visible || m.material?.transparent || m.name === 'blurDisc') return;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!mat?.color) return;
    const g = strip(m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
    g.applyMatrix4(_m.multiplyMatrices(inv, m.matrixWorld));
    colorize(g, mat.color, 0);
    parts.push(g);
  });
  if (!parts.length) return null;
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function result(id, kind, geo, extra = {}) {
  const bb = geo.boundingBox;
  return {
    id, kind, geo, wheelGeo: null, wheels: [], radius: 0.35, originY: 0,
    length: bb.max.z - bb.min.z, width: bb.max.x - bb.min.x, height: bb.max.y - bb.min.y, center: bb.getCenter(new THREE.Vector3()),
    palette: [0xffffff], ...extra,
  };
}

// procedural stand-ins
function proxy(kind) {
  const parts = [];
  const add = (geo, color, x = 0, y = 0, z = 0) => { geo.translate(x, y, z); parts.push(colorize(strip(geo.index ? geo.toNonIndexed() : geo), new THREE.Color(color))); };
  if (kind === 'plane') {
    add(new THREE.CylinderGeometry(0.55, 0.4, 8, 8).rotateX(Math.PI / 2), 0xf2f2f2, 0, 1.6, 0);
    add(new THREE.BoxGeometry(10, 0.15, 1.6), 0xd23a3a, 0, 1.7, -0.5);
    add(new THREE.BoxGeometry(3.4, 0.12, 0.9), 0xd23a3a, 0, 1.9, 3.5);
    add(new THREE.BoxGeometry(0.12, 1.4, 1), 0xd23a3a, 0, 2.4, 3.6);
  } else if (kind === 'heli') {
    add(new THREE.SphereGeometry(1.2, 10, 8).scale(1, 0.9, 1.5), 0x1f5fbf, 0, 1.4, 0);
    add(new THREE.CylinderGeometry(0.18, 0.12, 4.5, 6).rotateX(Math.PI / 2), 0xf2f2f2, 0, 1.6, 3.2);
    add(new THREE.BoxGeometry(9, 0.05, 0.25), 0x333333, 0, 2.6, 0);
    add(new THREE.BoxGeometry(0.1, 0.1, 2.6), 0x444444, 0.8, 0.1, 0);
    add(new THREE.BoxGeometry(0.1, 0.1, 2.6), 0x444444, -0.8, 0.1, 0);
  } else if (kind === 'boat') {
    add(new THREE.BoxGeometry(2.2, 0.9, 6).translate(0, 0, 0), 0xf4f4f2, 0, 0.3, 0);
    add(new THREE.ConeGeometry(1.1, 2, 4).rotateX(-Math.PI / 2).rotateZ(Math.PI / 4), 0xe0303f, 0, 0.3, -4);
    add(new THREE.BoxGeometry(1.4, 0.8, 1.6), 0x1b2b4f, 0, 1.1, 0.6);
  } else {
    add(new THREE.BoxGeometry(1.8, 0.7, 4.2), 0xb3202e, 0, 0.65, 0);
    add(new THREE.BoxGeometry(1.5, 0.5, 2), 0x222831, 0, 1.25, 0.2);
  }
  const geo = mergeGeometries(parts, false);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Bake a vehicle model for instancing. Returns { geo, wheelGeo, wheels[{x,y,z,r,front,left}], radius, originY, ... }.
 * originY: offset (local up) from the transmitted pose (the vehicle's object3d) to the baked origin.
 */
export async function bakeModel(id, kind) {
  const key = id || `proxy:${kind}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    try {
      if (kind === 'heli' || kind === 'plane' || kind === 'boat') return await bakeCraft(id, kind);
      const { bakeVehicle } = await import('../../vehicle/bake.js');
      const b = bakeVehicle(id);
      // Vehicle.object3d sits at the rigid body; the car model's origin (tyre contact) is a wheel radius lower
      const out = { ...b, originY: -(b.spec?.wheelRadius ?? b.radius ?? 0.33) };
      if (b.turretGeo && b.hullGeo) {
        // articulated tank (A's bakeTank): hull instanced as the body, turret (turret space, pivot in model space) and
        // gun (gun space, pivot = trunnion in turret space) as their own instanced parts, posed from the replicated state
        const v3 = (a) => ({ x: a?.[0] ?? 0, y: a?.[1] ?? 0, z: a?.[2] ?? 0 });
        out.geo = b.hullGeo;
        out.turret = { geo: b.turretGeo, pivot: v3(b.turretPivot) };
        if (b.barrelGeo) out.barrel = { geo: b.barrelGeo, pivot: v3(b.barrelPivot) };
      }
      return out;
    } catch (e) {
      console.warn(`[net] bake ${id} (${kind}) failed, using a proxy:`, e?.message || e);
      return result(id, kind, proxy(kind));
    }
  })();
  cache.set(key, p);
  return p;
}

async function bakeCraft(id, kind) {
  let built = null;
  if (kind === 'heli') {
    const [{ buildHeliModel }, { HELI_SPECS }] = await Promise.all([import('../../air/models/helis.js'), import('../../air/specs.js')]);
    built = buildHeliModel(id, HELI_SPECS[id]);
  } else if (kind === 'plane') {
    const [{ buildPlaneModel }, { PLANE_SPECS }, { PLANE_SPEC_ID }] = await Promise.all([
      import('../../air/models/planes.js'), import('../../air/specs.js'), import('../../air/Plane.js'),
    ]);
    built = buildPlaneModel(id, PLANE_SPECS[PLANE_SPEC_ID[id]]);
  } else {
    const { buildBoatModel } = await import('../../boat/models.js');
    built = buildBoatModel(id);
  }
  const root = built?.root || built;
  const geo = root ? mergeObject(root) : null;
  if (built?.materials) for (const m of Object.values(built.materials)) m?.dispose?.();
  if (!geo) throw new Error('empty model');
  return result(id, kind, geo);
}

export function proxyModel(kind) { return result(`proxy:${kind}`, kind, proxy(kind)); }
