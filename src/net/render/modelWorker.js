import { bakeModel } from './bake.js';
import { packModel } from './modelTransfer.js';
import { transferBuffers } from '../../world/geometryTransfer.js';
self.onmessage = async ({ data: { key, id, kind } }) => {
  try {
    const result = packModel(await bakeModel(id, kind));
    self.postMessage({ key, result }, transferBuffers(result));
  } catch (e) { self.postMessage({ key, error: String(e?.message || e) }); }
};
