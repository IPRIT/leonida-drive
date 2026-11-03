// One worker rather than one per subsystem: bounded memory and usable on phones.
// A failure resolves the pending stages to null, preserving the synchronous path.
export function prepareWorld(data, { enabled = true, timeout = 90000 } = {}) {
  let worker, timer;
  const pending = new Map();
  const result = {};
  for (const key of ['roads', 'buildings']) result[key] = new Promise((r) => pending.set(key, r));
  const stop = () => {
    clearTimeout(timer); worker?.terminate();
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };
  result.dispose = stop;
  if (!enabled || typeof Worker === 'undefined') { stop(); return result; }
  try {
    worker = new Worker(new URL('./worldWorker.js', import.meta.url), { type: 'module', name: 'leonida-world' });
    worker.onmessage = ({ data: m }) => {
      if (m.error) { console.warn('[world worker]', m.error); stop(); return; }
      pending.get(m.phase)?.(m.result); pending.delete(m.phase);
      if (!pending.size) stop();
    };
    worker.onerror = (e) => { console.warn('[world worker]', e.message); stop(); };
    timer = setTimeout(stop, timeout);
    worker.postMessage({ world: data.world, heights: data.heights, groundTex: data.groundTex, roads: data.roads, junctions: data.junctions,
      buildings: data.buildings, irl: typeof location !== 'undefined' && new URLSearchParams(location.search).get('irl') === '0' ? null : data.irl });
  } catch (e) { console.warn('[world worker]', e.message); stop(); }
  return result;
}
