import { Buildings } from '../world/Buildings.js';
import { FracturedBuilding } from './Fracture.js';

// Capture, partition, triangulate and generate the intact fracture shell without
// touching the live mesh or physics world. The same functions serve both paths.
export function prepareFracture(id, building, rec) {
  const B = Object.create(Buildings.prototype);
  B.list = []; B.list[id] = building;
  B.recs = []; B.recs[id] = rec;
  const record = () => ({ out: new Set(), glass: new Set(), dmg: new Map(), failed: new Set(), tint: 1 });
  const f = new FracturedBuilding({ game: { buildings: B }, record }, id, null, true);
  const keys = ['base', 'style', 'fh', 'edges', 'prisms', 'fr', 'nRegions', 'size', 'BH', 'top', 'nBands', 'misc', 'pieces',
    'groundTotal', 'groundOut', 'sideTotal', 'sideOut', 'stTotal', 'stOut'];
  return { state: Object.fromEntries(keys.map((k) => [k, f[k]])), geo: { ...f.baseGeo } };
}
