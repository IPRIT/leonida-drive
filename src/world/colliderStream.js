// Static colliders streamed around a point (terrain chunks, road buckets, buildings), driven by src/world/Streaming.js.
//
//  - In range: the colliders within `urgent` metres of the point are built at once (what the player stands on, lands
//    on or is teleported onto); the others are queued nearest first and built by step() within a time budget per
//    frame or in idle time (a teleport or an aircraft spawn used to build everything at once: 10-13 ms frames).
//  - Out of range: with a cache, a collider is disabled (no contacts, no scene queries) and kept, least recently used
//    dropped first; coming back enables it again instead of rebuilding it (a road bucket is a trimesh with
//    internal-edge fixing: ~0.4 ms per 1000 triangles, up to ~4.5 ms; enabling is ~free). Without one, removed.
//  - Prefetch (roads): the whole set is built disabled in idle time, nearest first, so that even a first visit
//    (teleport, aircraft spawn at a far runway) only enables colliders. Disabled colliders cost nothing per physics
//    step or scene query (measured), only memory: all 179 road buckets (355k triangles) fit in the physics heap
//    without growing it.
export class ColliderStream {
  /**
   * @param {object} o
   * @param {(key: number) => object|null} o.build creates the collider (null: nothing to build)
   * @param {(key: number) => number} o.estimate expected build time (ms)
   * @param {number} [o.cache] disabled colliders kept for a return (0: removed)
   * @param {Map} [o.live] the owner's key -> collider map (shared: the owner may remove entries itself)
   */
  constructor({ build, estimate, cache = 0, live = new Map() }) {
    this.build = build;
    this.estimate = estimate;
    this.cacheMax = cache;
    this.live = live;
    this.cached = new Map();
    this.pending = [];
    this.prefetch = []; // keys to build disabled into the cache in idle time (cache must hold them all)
    this.world = null;
    this._need = new Set();
  }

  /**
   * @param {object} world Rapier world
   * @param {(visit: (key: number, dist: number) => void) => void} each calls visit for every key in range with its
   *   distance from the point (0 inside)
   * @param {number} urgent built now when closer than this (m)
   */
  update(world, each, urgent) {
    this.world = world;
    const need = this._need;
    need.clear();
    const todo = [];
    each((key, d) => {
      need.add(key);
      if (this.live.has(key)) return;
      const c = this.cached.get(key);
      if (c) { this.cached.delete(key); c.setEnabled(true); this.live.set(key, c); return; }
      if (d <= urgent) this._make(key);
      else todo.push(d, key);
    });
    const order = [];
    for (let i = 0; i < todo.length; i += 2) order.push(i);
    order.sort((a, b) => todo[a] - todo[b]);
    this.pending = order.map((i) => todo[i + 1]);
    for (const [key, c] of this.live) if (!need.has(key)) { this.live.delete(key); this._retire(key, c); }
  }

  _make(key) {
    const c = this.build(key);
    if (c) this.live.set(key, c);
  }

  _retire(key, c) {
    if (this.cacheMax <= 0) { this.world.removeCollider(c, false); return; }
    c.setEnabled(false);
    this.cached.set(key, c);
    if (this.cached.size > this.cacheMax) {
      const [k0, c0] = this.cached.entries().next().value;
      this.cached.delete(k0);
      this.world.removeCollider(c0, false);
    }
  }

  /**
   * Builds queued colliders, nearest first, that fit in `ms` (estimated). `force`: also the first one that does not
   * fit (a large road bucket waiting for idle time that never came). Returns true while some are left.
   */
  step(ms, force = false) {
    const list = this.pending;
    if (!list.length) return false;
    const t0 = performance.now();
    const keep = [];
    let built = 0;
    for (const key of list) {
      if (this.live.has(key)) continue;
      const left = ms - (performance.now() - t0);
      if (this.estimate(key) > left && !(force && built === 0)) { keep.push(key); continue; }
      this._make(key);
      built++;
    }
    this.pending = keep;
    return keep.length > 0;
  }

  /**
   * Idle time: build prefetch keys (disabled, into the cache) that fit in `ms`; force: the next one even if it does
   * not (idle time too short for it). Returns true while some are left.
   */
  stepPrefetch(ms, force = false) {
    const list = this.prefetch;
    if (!list.length || !this.world) return false;
    const t0 = performance.now();
    let built = 0;
    while (list.length) {
      const key = list[list.length - 1];
      if (this.live.has(key) || this.cached.has(key)) { list.pop(); continue; }
      if (this.estimate(key) > ms - (performance.now() - t0) && !(force && built === 0)) break;
      list.pop();
      built++;
      const c = this.build(key);
      if (!c) continue;
      c.setEnabled(false);
      this.cached.set(key, c);
    }
    return list.length > 0;
  }

  /** Prefetch every key of `keys`, nearest to (x, z) first (`pos(key)` → [x, z]). */
  prefetchAll(keys, x, z, pos) {
    const d = (k) => { const p = pos(k); return Math.hypot(p[0] - x, p[1] - z); };
    this.prefetch = [...keys].sort((a, b) => d(b) - d(a)); // popped from the end: nearest first
  }

  /** Remove everything (live, cached, queued). */
  clear() {
    for (const c of this.live.values()) this.world?.removeCollider(c, false);
    for (const c of this.cached.values()) this.world?.removeCollider(c, false);
    this.live.clear();
    this.cached.clear();
    this.pending = [];
  }
}
