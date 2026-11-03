// Vehicle preview images for the UI. Prefers the vehicles workstream service `game.thumbnails`
// ({ get(id), request(id, priority), onReady(cb), createTurntable(el, id) }); falls back to
// renderVehicleThumbnail(id, renderer, size) from src/vehicle (rendered lazily, one per frame); otherwise null
// (callers show the category icon).
const OPTIONAL = import.meta.glob(['../vehicle/thumbnail.js', '../vehicle/thumbnails.js', '../vehicle/catalog.js']);

export class Thumbs {
  constructor(game) {
    this.game = game;
    this.cache = new Map(); // fallback renders: id → canvas | dataURL
    this.queue = [];
    this.listeners = new Set();
    this.render = null;
    this._svcHooked = null;
    for (const load of Object.values(OPTIONAL)) {
      load().then((m) => {
        const fn = m.renderVehicleThumbnailCanvas || m.renderVehicleThumbnail;
        if (typeof fn === 'function' && !this.render) { this.render = fn; this.emit('*'); }
      }).catch(() => { /* optional */ });
    }
  }

  get svc() {
    const s = this.game.thumbnails;
    if (s && this._svcHooked !== s) {
      this._svcHooked = s;
      s.onReady?.((id) => this.emit(id));
    }
    return s || null;
  }

  available() { return !!(this.svc || (this.render && this.game.renderer)); }

  // canvas | ImageBitmap | HTMLImageElement | dataURL string | null
  get(id) {
    const s = this.svc;
    if (s) return s.get(id) || null;
    return this.cache.get(id) || null;
  }

  // priority: 1 = visible now, 0 = prefetch
  request(id, priority = 1) {
    const s = this.svc;
    if (s) { s.request?.(id, priority); return; }
    if (!this.render || !this.game.renderer || this.cache.has(id) || this.queue.includes(id)) return;
    if (priority > 0) this.queue.unshift(id); else this.queue.push(id);
  }

  onReady(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(id) { for (const fn of [...this.listeners]) { try { fn(id); } catch (e) { console.error('[ui] thumb listener', e); } } }

  // live rotating preview (service only) → { setId, dispose } | null
  turntable(el, id) { return this.svc?.createTurntable?.(el, id) || null; }

  // fallback renderer: one thumbnail per call (call once per frame while a list is visible)
  pump() {
    if (this.svc || !this.render || !this.game.renderer || !this.queue.length) return;
    if (this._skip > 0) { this._skip--; return; } // after an expensive render, give the next frames back
    const id = this.queue.shift();
    try {
      const t0 = performance.now();
      const out = this.render(id, this.game.renderer, 256);
      const ms = performance.now() - t0;
      this._skip = ms > 6 ? Math.min(4, Math.floor(ms / 6)) : 0;
      this.cache.set(id, out || '');
      if (out) this.emit(id);
    } catch (e) {
      console.warn('[ui] thumbnail failed', id, e);
      this.cache.set(id, '');
    }
  }
}

// Draws a thumbnail source into a canvas element, cover-fitted, at the element's CSS size × DPR.
// cssW/cssH: the size when the caller already knows it (e.g. from an IntersectionObserver entry) — no layout read.
export function drawThumb(canvas, src, cssW, cssH) {
  if (!canvas || !src) return false;
  if (typeof src === 'string') {
    const img = new Image();
    img.onload = () => drawThumb(canvas, img, cssW, cssH);
    img.src = src;
    return true;
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if (!w || !h) return false;
  const r = cssW > 0 && cssH > 0 ? { width: cssW, height: cssH } : canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.max(1, Math.round((r.width || 192) * dpr)), ch = Math.max(1, Math.round((r.height || 108) * dpr));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  const k = Math.max(cw / w, ch / h) * 0.98;
  const dw = w * k, dh = h * k;
  ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  return true;
}
