import { prepareFracture } from './fractureBuild.js';
import { transferBuffers } from '../world/geometryTransfer.js';
self.onmessage = ({ data: { id, building, rec } }) => {
  try {
    const result = prepareFracture(id, building, rec);
    self.postMessage({ id, result }, transferBuffers(result));
  } catch (e) { self.postMessage({ id, error: String(e?.message || e) }); }
};
