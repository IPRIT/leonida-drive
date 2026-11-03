// Tile pool: renders map tiles in Web Workers (OffscreenCanvas -> ImageBitmap), keeps per-style LRU caches and
// draws a view (any centre / zoom / rotation) from cached tiles.
//
// Sharpness rule: a tile is never magnified. The level is the coarsest one that is at least as sharp as the
// screen (half-octave levels, so tiles are shown at 0.71..1x). While a tile is pending we draw finer cached
// tiles (minified) or, failing that, the vector content directly on the main thread for the missing area.
// Without module workers / OffscreenCanvas everything is rendered on the main thread (time-sliced).

import { TILE, GUTTER, levelMpp, tileWorld, levelFor, MAX_LEVEL, PALETTES } from './style.js';
import { TileRenderer } from './TileRenderer.js';
import { parseMapBuffer } from './mapData.js';

const STYLES = ['map', 'radar'];
const SID = { map: 0, radar: 1 };
const SPAN = 8192;
const LV = 32;
const keyOf = (s, L, tx, ty) => ((s * LV + L) * SPAN + ty) * SPAN + tx;
const now = () => performance.now();

export class TilePool {
  constructor({ buffer, relief, bounds, dpr = { map: 1, radar: 1 }, maxTiles = { map: 48, radar: 24 }, workers = 2, useWorkers = true }) {
    this.buffer = buffer;
    this.relief = relief; // { heights: Int16Array, gw, gh, hs } | null
    this.bounds = bounds;
    this.dpr = { ...dpr };
    this.maxTiles = maxTiles;
    this.caches = STYLES.map(() => new Map());
    this.wants = new Map();   // key -> { s, L, tx, ty, prio, t }
    this.inflight = new Set();
    this.workers = [];
    this.direct = null;       // main-thread renderer: pending tiles (direct vector) and the no-worker fallback
    this.onTile = null;       // callback(style) when a tile arrived
    this.miss = new Float64Array(4 * 64);
    this.working = [0, 0]; // tiles touched by the last drawTiles() per style
    this.stats = { rendered: 0, ms: 0, worker: false, last: 0, direct: 0, directMs: 0 };
    this.pinned = new Set();  // keys never evicted (coarse overview tiles: instant placeholder anywhere)
    this.pinQueue = [];       // pinned tiles still to render (lowest priority)
    this.pinLevel = [-1, -1];  // per style
    this.ready = this.start(useWorkers ? workers : 0);
  }

  async start(nWorkers) {
    const map = parseMapBuffer(this.buffer);
    const makeCanvas = (w, h) => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
    };
    this.makeCanvas = makeCanvas;
    this.direct = new TileRenderer(map, { ...(this.relief || {}), makeCanvas });
    if (nWorkers > 0 && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        this.direct.noRasterCompute = true; // rasters arrive from the first worker
        const ws = [];
        for (let i = 0; i < nWorkers; i++) ws.push(await this.spawn(i === 0));
        this.workers = ws;
        this.stats.worker = true;
        return;
      } catch (e) {
        console.warn('[map] tile workers unavailable, rendering on the main thread:', e?.message || e);
        for (const w of this.workers) w.worker.terminate();
        this.workers = [];
        this.direct.noRasterCompute = false;
      }
    }
  }

  spawn(sendRasters) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      const w = { worker, busy: false };
      const timer = setTimeout(() => reject(new Error('worker init timeout')), 20000);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { clearTimeout(timer); worker.onmessage = (ev) => this.onMessage(w, ev.data); resolve(w); }
        else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.error)); }
      };
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'worker error')); };
      const r = this.relief;
      worker.postMessage({
        type: 'init', map: this.buffer, styles: STYLES, sendRasters,
        heights: r?.heights ? r.heights.buffer.slice(r.heights.byteOffset, r.heights.byteOffset + r.heights.byteLength) : null,
        gw: r?.gw, gh: r?.gh, hs: r?.hs,
      });
    });
  }

  onMessage(w, m) {
    if (m.type === 'rasters') {
      for (const [k, r] of Object.entries(m.rasters)) this.direct.setRaster(k, r);
      return;
    }
    w.busy = false;
    if (m.type !== 'tile') return;
    this.inflight.delete(m.key);
    if (m.bitmap) {
      this.insert(m.key, m.bitmap);
      this.stats.rendered++;
      this.stats.ms += m.ms || 0;
      this.stats.last = m.ms || 0;
    } else if (m.error) console.warn('[map] tile failed', m.error);
    this.pump();
  }

  insert(key, img) {
    const s = Math.floor(key / (LV * SPAN * SPAN));
    this.caches[s].set(key, { img, t: now() });
    this.trim(s);
    this.onTile?.(STYLES[s]);
  }

  // keep every tile of level L of a style cached (rendered in the background when workers are idle)
  pin(style, L) {
    const s = SID[style], S = tileWorld(L), B = this.bounds;
    const nx = Math.ceil((B[2] - B[0]) / S), nz = Math.ceil((B[3] - B[1]) / S);
    this.pinLevel[s] = L;
    for (let ty = 0; ty < nz; ty++) for (let tx = 0; tx < nx; tx++) {
      const key = keyOf(s, L, tx, ty);
      this.pinned.add(key);
      this.pinQueue.push({ key, s, L, tx, ty, prio: 1e6, t: 0 });
    }
    this.pump();
  }

  // evict least recently used tiles that were not drawn in the last 250 ms
  trim(s) {
    const cache = this.caches[s];
    // never evict below the working set of the current view (visible + prefetched), or tiles would thrash
    const max = Math.max(this.maxTiles[STYLES[s]], (this.working[s] || 0) + 4) + (this.pinLevel[s] >= 0 ? this.pinnedCount(s) : 0);
    if (cache.size <= max) return;
    const cut = now() - 250;
    const old = [...cache.entries()].filter(([k, e]) => e.t < cut && !this.pinned.has(k)).sort((a, b) => a[1].t - b[1].t);
    for (let i = 0; i < old.length && cache.size > max; i++) {
      old[i][1].img.close?.();
      cache.delete(old[i][0]);
    }
  }

  get(s, L, tx, ty, t) {
    const e = this.caches[s].get(keyOf(s, L, tx, ty));
    if (e && t) e.t = t;
    return e;
  }

  has(s, L, tx, ty) { return this.caches[s].has(keyOf(s, L, tx, ty)); }

  want(s, L, tx, ty, prio, t) {
    const key = keyOf(s, L, tx, ty);
    if (this.inflight.has(key) || this.caches[s].has(key)) return;
    const w = this.wants.get(key);
    if (w) { w.prio = prio; w.t = t; return; }
    this.wants.set(key, { key, s, L, tx, ty, prio, t });
  }

  pick(t) {
    let best = null;
    for (const w of this.wants.values()) {
      if (t - w.t > 400 || this.caches[w.s].has(w.key)) { this.wants.delete(w.key); continue; }
      if (!best || w.prio < best.prio) best = w;
    }
    if (best) { this.wants.delete(best.key); return best; }
    // idle: render the pinned overview tiles
    while (this.pinQueue.length) {
      const j = this.pinQueue.pop();
      if (!this.caches[j.s].has(j.key) && !this.inflight.has(j.key)) return j;
    }
    return null;
  }

  pinnedCount(s) {
    let n = 0;
    for (const k of this.pinned) if (Math.floor(k / (LV * SPAN * SPAN)) === s) n++;
    return n;
  }

  // send the best wanted tiles to idle workers; main-thread fallback renders within `budgetMs`
  pump(budgetMs = 5) {
    if (!this.wants.size && !this.pinQueue.length) return;
    const t = now();
    if (this.workers.length) {
      for (const wk of this.workers) {
        if (wk.busy) continue;
        const job = this.pick(t);
        if (!job) break;
        wk.busy = true;
        this.inflight.add(job.key);
        const style = STYLES[job.s];
        wk.worker.postMessage({ type: 'tile', key: job.key, style, L: job.L, tx: job.tx, ty: job.ty, dpr: this.dpr[style] });
      }
    } else if (this.direct) {
      const end = t + budgetMs;
      do {
        const job = this.pick(t);
        if (!job) break;
        const style = STYLES[job.s];
        const c = this.makeCanvas(TILE + 2 * GUTTER, TILE + 2 * GUTTER);
        const t0 = now();
        this.direct.render(c.getContext('2d'), style, job.L, job.tx, job.ty, this.dpr[style]);
        this.stats.rendered++;
        this.stats.last = now() - t0;
        this.stats.ms += this.stats.last;
        this.insert(job.key, c);
      } while (now() < end);
    }
  }

  setDpr(style, dpr) {
    if (this.dpr[style] === dpr) return;
    this.dpr[style] = dpr;
    const s = SID[style];
    for (const e of this.caches[s].values()) e.img.close?.();
    this.caches[s].clear();
    if (this.pinLevel[s] >= 0) {
      for (const k of [...this.pinned]) if (Math.floor(k / (LV * SPAN * SPAN)) === s) this.pinned.delete(k);
      this.pin(style, this.pinLevel[s]);
    }
  }

  // release most tiles of a style (e.g. when the full map closes)
  shrink(style, keep = 8) {
    const cache = this.caches[SID[style]];
    if (cache.size <= keep) return;
    const all = [...cache.entries()].filter(([k]) => !this.pinned.has(k)).sort((a, b) => b[1].t - a[1].t);
    for (let i = keep; i < all.length; i++) { all[i][1].img.close?.(); cache.delete(all[i][0]); }
  }

  memoryMB() {
    let n = 0;
    for (const c of this.caches) n += c.size;
    return (n * (TILE + 2 * GUTTER) ** 2 * 4) / 1048576;
  }

  dispose() {
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
    for (const c of this.caches) { for (const e of c.values()) e.img.close?.(); c.clear(); }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Draw tiles for a view. view: { cx, cz, mpp (CSS m/px), rot, ox, oy (screen anchor, CSS px), w, h, dpr }
// Leaves the context with the world -> device transform set (callers draw world-space overlays next).
// Allocation-free when all tiles are cached. Returns the number of tiles that were not ready.
// opts: margin (coverage radius factor), prefetchUp (coarser level), direct (vector fallback for pending tiles)
export function drawTiles(ctx, pool, style, view, opts) {
  const s = SID[style];
  const t = now();
  const dpr = view.dpr;
  const dm = view.mpp / dpr;
  const L = levelFor(dm);
  const S = tileWorld(L);
  const m = levelMpp(L);
  const rot = view.rot || 0;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const k = dpr / view.mpp;
  const ta = k * cos, tb = k * sin, tc = -k * sin, td = k * cos;
  const te = dpr * view.ox - k * (cos * view.cx - sin * view.cz);
  const tf = dpr * view.oy - k * (sin * view.cx + cos * view.cz);
  ctx.setTransform(ta, tb, tc, td, te, tf);
  // world-space coverage
  let x0, z0, x1, z1;
  if (rot) {
    const r = Math.max(Math.hypot(view.ox, view.oy), Math.hypot(view.w - view.ox, view.oy), Math.hypot(view.ox, view.h - view.oy),
      Math.hypot(view.w - view.ox, view.h - view.oy)) * view.mpp;
    x0 = view.cx - r; x1 = view.cx + r; z0 = view.cz - r; z1 = view.cz + r;
  } else {
    x0 = view.cx - view.ox * view.mpp; x1 = view.cx + (view.w - view.ox) * view.mpp;
    z0 = view.cz - view.oy * view.mpp; z1 = view.cz + (view.h - view.oy) * view.mpp;
  }
  const B = pool.bounds;
  const bx = B[0], bz = B[1];
  const nx = Math.ceil((B[2] - bx) / S), nz = Math.ceil((B[3] - bz) / S);
  const tx0 = Math.max(0, Math.floor((x0 - bx) / S)), tx1 = Math.min(nx - 1, Math.floor((x1 - bx) / S));
  const ty0 = Math.max(0, Math.floor((z0 - bz) / S)), ty1 = Math.min(nz - 1, Math.floor((z1 - bz) / S));
  const ccx = (view.cx - bx) / S - 0.5, ccz = (view.cz - bz) / S - 0.5;
  let missing = 0;
  pool._touch = Math.max(0, tx1 - tx0 + 1) * Math.max(0, ty1 - ty0 + 1);
  ctx.imageSmoothingEnabled = true;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const X = bx + tx * S, Z = bz + ty * S;
      const e = pool.get(s, L, tx, ty, t);
      if (e) {
        // 1 px overlap from the gutter hides seams between neighbouring tiles
        ctx.drawImage(e.img, GUTTER - 1, GUTTER - 1, TILE + 2, TILE + 2, X - m, Z - m, S + 2 * m, S + 2 * m);
        continue;
      }
      const d = (tx - ccx) * (tx - ccx) + (ty - ccz) * (ty - ccz);
      pool.want(s, L, tx, ty, d, t);
      // placeholder while the tile renders: finer cached tiles (minified, sharp), else coarser ones (magnified,
      // soft for a few frames) — both far cheaper than drawing the vector content on the main thread every frame
      // the pinned overview (very soft) is only used once drawing the vectors directly turned out expensive
      if (drawCached(ctx, pool, s, L, X, Z, S, t, pool.stats.directMs > 3)) continue;
      // remember for the direct vector pass
      if (missing * 4 >= pool.miss.length) { const a = new Float64Array(pool.miss.length * 2); a.set(pool.miss); pool.miss = a; }
      pool.miss[missing * 4] = X; pool.miss[missing * 4 + 1] = Z; pool.miss[missing * 4 + 2] = X + S; pool.miss[missing * 4 + 3] = Z + S;
      missing++;
    }
  }
  if (missing && pool.direct && opts?.direct !== false) {
    // crisp placeholder: vector content drawn straight into the view, clipped to the pending tiles
    const t0 = now();
    let ax0 = Infinity, az0 = Infinity, ax1 = -Infinity, az1 = -Infinity;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < missing; i++) {
      const q = i * 4, M = pool.miss;
      ctx.rect(M[q], M[q + 1], M[q + 2] - M[q], M[q + 3] - M[q + 1]);
      if (M[q] < ax0) ax0 = M[q]; if (M[q + 1] < az0) az0 = M[q + 1];
      if (M[q + 2] > ax1) ax1 = M[q + 2]; if (M[q + 3] > az1) az1 = M[q + 3];
    }
    ctx.clip();
    ax0 = Math.max(ax0, x0); az0 = Math.max(az0, z0); ax1 = Math.min(ax1, x1); az1 = Math.min(az1, z1);
    ctx.fillStyle = PALETTES[style].water;
    ctx.fillRect(ax0, az0, ax1 - ax0, az1 - az0);
    pool.direct.drawContent(ctx, style, dm, dpr, ax0, az0, ax1, az1);
    ctx.restore();
    ctx.setTransform(ta, tb, tc, td, te, tf);
    pool.stats.direct++;
    pool.stats.directMs = now() - t0;
  } else pool.stats.directMs *= 0.9; // re-allow sharp direct drawing a few frames after an expensive one
  // warm the neighbouring levels so zoom / speed changes find tiles ready
  if (opts?.prefetchUp !== false && L < MAX_LEVEL) prefetch(pool, s, L + 1, x0, z0, x1, z1, 100, t);
  if (opts?.prefetchDown && L > 0) prefetch(pool, s, L - 1, view.cx - (view.cx - x0) * 0.6, view.cz - (view.cz - z0) * 0.6,
    view.cx + (x1 - view.cx) * 0.6, view.cz + (z1 - view.cz) * 0.6, 200, t);
  if (opts?.margin) {
    const mx = (x1 - x0) * opts.margin, mz = (z1 - z0) * opts.margin;
    prefetch(pool, s, L, x0 - mx, z0 - mz, x1 + mx, z1 + mz, 60, t);
  }
  pool.working[s] = pool._touch;
  pool.pump();
  if (t - (pool._trimT || 0) > 500) { pool._trimT = t; pool.trim(s); }
  return missing;
}

function prefetch(pool, s, L, x0, z0, x1, z1, base, t) {
  const B = pool.bounds, S = tileWorld(L);
  const nx = Math.ceil((B[2] - B[0]) / S), nz = Math.ceil((B[3] - B[1]) / S);
  const a0 = Math.max(0, Math.floor((x0 - B[0]) / S)), a1 = Math.min(nx - 1, Math.floor((x1 - B[0]) / S));
  const b0 = Math.max(0, Math.floor((z0 - B[1]) / S)), b1 = Math.min(nz - 1, Math.floor((z1 - B[1]) / S));
  const cx = (a0 + a1) / 2, cz = (b0 + b1) / 2;
  pool._touch += Math.max(0, a1 - a0 + 1) * Math.max(0, b1 - b0 + 1);
  for (let ty = b0; ty <= b1; ty++) for (let tx = a0; tx <= a1; tx++) {
    // touch cached ones (they are part of the working set), request the rest
    if (!pool.get(s, L, tx, ty, t)) pool.want(s, L, tx, ty, base + (tx - cx) * (tx - cx) + (ty - cz) * (ty - cz), t);
  }
}

// draw the rect [X, Z, S] from cached tiles of other levels: finer first (minified = still sharp), then coarser
// (magnified placeholder). Returns true if fully covered.
const ORDER = [-1, -2, 1, 2, 3, 99];
function drawCached(ctx, pool, s, L, X, Z, S, t, blurryOk) {
  const B = pool.bounds;
  for (let oi = 0; oi < ORDER.length; oi++) {
    const Lf = ORDER[oi] === 99 ? pool.pinLevel[s] : L + ORDER[oi];
    if (ORDER[oi] === 99 && (Lf <= L + 3 || !blurryOk)) continue;
    if (Lf < 0 || Lf > MAX_LEVEL) continue;
    const Sf = tileWorld(Lf), mf = levelMpp(Lf);
    const a0 = Math.floor((X - B[0]) / Sf), a1 = Math.floor((X + S - B[0] - 1e-6) / Sf);
    const b0 = Math.floor((Z - B[1]) / Sf), b1 = Math.floor((Z + S - B[1] - 1e-6) / Sf);
    if ((a1 - a0 + 1) * (b1 - b0 + 1) > 9) continue;
    let ok = true;
    for (let ty = b0; ty <= b1 && ok; ty++) for (let tx = a0; tx <= a1; tx++) if (!pool.has(s, Lf, tx, ty)) { ok = false; break; }
    if (!ok) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(X, Z, S, S);
    ctx.clip();
    for (let ty = b0; ty <= b1; ty++) for (let tx = a0; tx <= a1; tx++) {
      const e = pool.get(s, Lf, tx, ty, t);
      const FX = B[0] + tx * Sf, FZ = B[1] + ty * Sf;
      ctx.drawImage(e.img, GUTTER - 1, GUTTER - 1, TILE + 2, TILE + 2, FX - mf, FZ - mf, Sf + 2 * mf, Sf + 2 * mf);
    }
    ctx.restore();
    return true;
  }
  return false;
}
