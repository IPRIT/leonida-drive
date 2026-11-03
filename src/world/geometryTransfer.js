import * as THREE from 'three';

// Only numeric geometry crosses the worker boundary; shaders and GPU resources
// are owned by the renderer. Bounds are computed once, in the worker.
export function packGeometry(g) {
  const attributes = {};
  for (const [k, a] of Object.entries(g.attributes)) attributes[k] = { array: a.array, itemSize: a.itemSize, normalized: a.normalized };
  return { attributes, index: g.index?.array, sphere: g.boundingSphere && [g.boundingSphere.center.x, g.boundingSphere.center.y, g.boundingSphere.center.z, g.boundingSphere.radius],
    box: g.boundingBox && [...g.boundingBox.min.toArray(), ...g.boundingBox.max.toArray()] };
}

export function unpackGeometry(p) {
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(p.attributes)) g.setAttribute(k, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (p.index) g.setIndex(new THREE.BufferAttribute(p.index, 1));
  if (p.sphere) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...p.sphere.slice(0, 3)), p.sphere[3]);
  if (p.box) g.boundingBox = new THREE.Box3(new THREE.Vector3(...p.box.slice(0, 3)), new THREE.Vector3(...p.box.slice(3)));
  return g;
}

export function packMeshes(group, materials) {
  return group.children.map((m) => {
    const material = Object.keys(materials).find((k) => materials[k] === m.material);
    if (!material) throw new Error(`Unregistered worker material: ${m.name}`);
    return { geometry: packGeometry(m.geometry), material, name: m.name, castShadow: m.castShadow, receiveShadow: m.receiveShadow,
      visible: m.visible, matrix: m.matrix.toArray(), matrixAutoUpdate: m.matrixAutoUpdate };
  });
}

export function unpackMeshes(packets, group, materials) {
  return packets.map((p) => {
    const m = new THREE.Mesh(unpackGeometry(p.geometry), materials[p.material]);
    m.name = p.name; m.castShadow = p.castShadow; m.receiveShadow = p.receiveShadow; m.visible = p.visible;
    m.matrix.fromArray(p.matrix); m.matrix.decompose(m.position, m.quaternion, m.scale); m.matrixAutoUpdate = p.matrixAutoUpdate;
    group.add(m);
    return m;
  });
}

export function transferBuffers(value) {
  const buffers = new Set(), seen = new Set();
  const visit = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) { buffers.add(v.buffer); return; }
    if (v instanceof ArrayBuffer) { buffers.add(v); return; }
    if (v instanceof Map) { for (const [k, x] of v) { visit(k); visit(x); } return; }
    if (v instanceof Set) { for (const x of v) visit(x); return; }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(value);
  return [...buffers];
}
