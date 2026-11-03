// Tile worker: owns a TileRenderer and renders requested tiles into an OffscreenCanvas, returned as ImageBitmaps.
import { parseMapBuffer } from './mapData.js';
import { TileRenderer } from './TileRenderer.js';
import { TILE, GUTTER } from './style.js';

let R = null, canvas = null, ctx = null;
const SIZE = TILE + 2 * GUTTER;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const map = parseMapBuffer(m.map);
      R = new TileRenderer(map, {
        heights: m.heights ? new Int16Array(m.heights) : null, gw: m.gw, gh: m.gh, hs: m.hs,
        makeCanvas: (w, h) => new OffscreenCanvas(w, h),
      });
      canvas = new OffscreenCanvas(SIZE, SIZE);
      ctx = canvas.getContext('2d');
      if (!ctx || typeof Path2D === 'undefined') throw new Error('no 2D context in worker');
      // warm-up: rasters + one tiny render so the first real tile is fast
      R.raster('shade');
      self.postMessage({ type: 'ready' });
      // the main thread draws pending tiles as direct vector and needs the same smooth rasters
      if (m.sendRasters) {
        const out = {}, transfer = [];
        Promise.all(Object.entries(R.rasters).filter(([, r]) => r).map(async ([key, r]) => {
          const bmp = await createImageBitmap(r.canvas);
          out[key] = { canvas: bmp, w: r.w, h: r.h, mpp: r.mpp };
          transfer.push(bmp);
        })).then(() => self.postMessage({ type: 'rasters', rasters: out }, transfer));
      }
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err?.stack || err) });
    }
    return;
  }
  if (m.type === 'tile') {
    try {
      const t0 = performance.now();
      R.render(ctx, m.style, m.L, m.tx, m.ty, m.dpr);
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage({ type: 'tile', key: m.key, bitmap, ms: performance.now() - t0 }, [bitmap]);
      R.trim();
    } catch (err) {
      self.postMessage({ type: 'tile', key: m.key, bitmap: null, error: String(err?.stack || err) });
    }
  }
};
