import { bakeModel } from './bake.js';
import { unpackModel } from './modelTransfer.js';

export class ModelBaker {
  constructor() { this.cache = new Map(); this.pending = new Map(); this.disabled = false; }
  bake(id, kind) {
    const key = `${kind}:${id}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const fallback = () => bakeModel(id, kind);
    if (this.disabled || typeof Worker === 'undefined') return fallback();
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./modelWorker.js', import.meta.url), { type: 'module', name: 'leonida-remote-models' });
        this.worker.onmessage = ({ data: m }) => {
          const job = this.pending.get(m.key); if (!job) return;
          clearTimeout(job.timer); this.pending.delete(m.key);
          try {
            if (m.error) job.fallback().then(job.resolve); else job.resolve(unpackModel(m.result));
          } catch { job.fallback().then(job.resolve); }
        };
        this.worker.onerror = () => this.stop();
      } catch { this.disabled = true; return fallback(); }
    }
    const p = new Promise((resolve) => {
      const timer = setTimeout(() => this.stop(), 15000);
      this.pending.set(key, { resolve, fallback, timer });
      try { this.worker.postMessage({ key, id, kind }); } catch { this.stop(); }
    });
    this.cache.set(key, p);
    return p;
  }
  stop(dispose = false) {
    this.worker?.terminate(); this.worker = null; this.disabled = true;
    for (const job of this.pending.values()) { clearTimeout(job.timer); if (dispose) job.resolve(null); else job.fallback().then(job.resolve); }
    this.pending.clear();
    if (dispose) this.cache.clear();
  }
}
