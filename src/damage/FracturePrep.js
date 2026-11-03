// Small predictive cache: nearby buildings prepare in the background; a first
// hit outside that cache is replayed once ready, never discarded or downgraded.
export class FracturePrep {
  constructor(owner) {
    this.owner = owner;
    this.cache = new Map(); this.pending = new Map(); this.failed = new Set(); this.pinned = new Set(); this.timer = 0;
    this.stats = { prepared: 0, used: 0, deferred: 0 };
    if (typeof Worker === 'undefined' || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('noworldworkers'))) return;
    try {
      this.worker = new Worker(new URL('./fractureWorker.js', import.meta.url), { type: 'module', name: 'leonida-fracture' });
      this.worker.onmessage = ({ data: m }) => {
        const job = this.pending.get(m.id);
        if (!job) return;
        clearTimeout(job.timeout); this.pending.delete(m.id);
        if (m.error) this.failed.add(m.id);
        else { this.cache.set(m.id, m.result); this.stats.prepared++; }
        if (job.callbacks.length && !m.error) this.pinned.add(m.id);
        for (const fn of job.callbacks) this.owner.queue(fn, m.id);
        // Keep requested results until their callbacks run. Evict only unused prefetch.
        for (const id of this.cache.keys()) {
          if (this.cache.size <= 32) break;
          if (!this.pinned.has(id)) this.cache.delete(id);
        }
      };
      this.worker.onerror = () => this.dispose(true);
    } catch { this.worker = null; }
  }

  request(id) {
    if (!this.worker || this.failed.has(id) || this.cache.has(id) || this.pending.has(id) || this.owner.map.has(id)) return;
    const B = this.owner.game.buildings, r = B?.recs[id];
    if (!r || r.removed) return;
    const job = { callbacks: [], timeout: setTimeout(() => this.dispose(true), 10000) };
    this.pending.set(id, job);
    try { this.worker.postMessage({ id, building: B.list[id], rec: { cx: r.cx, cz: r.cz } }); }
    catch { this.dispose(true); }
  }

  waiting(id) {
    if (!this.worker || this.failed.has(id) || this.cache.has(id)) return false;
    this.request(id);
    return this.pending.has(id);
  }

  defer(id, fn) {
    if (!this.waiting(id)) return false;
    this.pending.get(id).callbacks.push(fn); this.stats.deferred++;
    return true;
  }

  take(id) {
    const value = this.cache.get(id);
    if (value) { this.cache.delete(id); this.pinned.delete(id); this.stats.used++; }
    return value;
  }

  update(dt) {
    if (!this.worker || (this.timer -= dt) > 0) return;
    this.timer = 0.7;
    const p = this.owner.game.player?.focus, B = this.owner.game.buildings;
    if (!p || !B?.query) return;
    const ids = B.query(p.x, p.z, 160).filter((id) => !B.recs[id].removed);
    ids.sort((a, b) => Math.hypot(B.recs[a].cx - p.x, B.recs[a].cz - p.z) - Math.hypot(B.recs[b].cx - p.x, B.recs[b].cz - p.z));
    for (const id of ids.slice(0, 24)) { if (this.pending.size >= 8) break; this.request(id); }
  }

  dispose(replay = false) {
    this.worker?.terminate(); this.worker = null;
    for (const [id, j] of this.pending) {
      clearTimeout(j.timeout);
      if (replay) for (const fn of j.callbacks) this.owner.queue(fn, id);
    }
    this.pending.clear(); this.cache.clear(); this.pinned.clear();
  }
}
