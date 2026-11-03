import * as THREE from 'three';
import { packGeometry, unpackGeometry } from '../../world/geometryTransfer.js';

export function packModel(b) {
  const meta = {};
  for (const [k, v] of Object.entries(b)) if (!v?.isBufferGeometry && k !== 'turret' && k !== 'barrel') meta[k] = v;
  const out = { meta: JSON.parse(JSON.stringify(meta)), geo: packGeometry(b.geo), wheelGeo: b.wheelGeo && packGeometry(b.wheelGeo) };
  for (const k of ['turret', 'barrel']) if (b[k]) out[k] = { pivot: b[k].pivot, geo: packGeometry(b[k].geo) };
  return out;
}

export function unpackModel(p) {
  const b = { ...p.meta, geo: unpackGeometry(p.geo), wheelGeo: p.wheelGeo ? unpackGeometry(p.wheelGeo) : null };
  b.wheel = b.wheelGeo;
  if (b.center) b.center = new THREE.Vector3(b.center.x, b.center.y, b.center.z);
  for (const k of ['turret', 'barrel']) if (p[k]) b[k] = { pivot: p[k].pivot, geo: unpackGeometry(p[k].geo) };
  return b;
}
