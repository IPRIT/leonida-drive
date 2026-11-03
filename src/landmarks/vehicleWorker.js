// Bakes parked-vehicle / aircraft / boat models off the main thread (see Landmarks.bakeVehicles). Message in:
// { keys: [...] }; out, per key: { key, attrs } (typed arrays transferred) or { key, error }; finally { done: true }.
import { bakeVehicleArrays } from './vehicles.js';

self.onmessage = (ev) => {
  for (const key of ev.data.keys || []) {
    try {
      const r = bakeVehicleArrays(key);
      self.postMessage(r, Object.values(r.attrs).map((a) => a.buffer));
    } catch (e) {
      self.postMessage({ key, error: String(e?.message || e) });
    }
  }
  self.postMessage({ done: true });
};
