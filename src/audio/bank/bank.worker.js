// Renders procedural sound-bank items off the main thread.
import { renderItem } from './generators.js';

self.onmessage = (e) => {
  const { sr, names, seed } = e.data;
  for (const name of names) {
    try {
      const vars = renderItem(name, sr, seed);
      const transfer = [];
      for (const v of vars) for (const c of v) transfer.push(c.buffer);
      self.postMessage({ name, vars }, transfer);
    } catch (err) {
      self.postMessage({ name, error: String(err?.stack || err) });
    }
  }
  self.postMessage({ done: true });
};
