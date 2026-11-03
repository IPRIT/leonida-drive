export const MIN_RENDER_SCALE = 0.5;
export const MAX_RENDER_SCALE = 2;
export const clampRenderScale = (v) => v !== null && v !== '' && Number.isFinite(+v) ? Math.max(MIN_RENDER_SCALE, Math.min(MAX_RENDER_SCALE, +v)) : 1;

export function antialiasingModes(samples = []) {
  return ['auto', 'none', 'fxaa', 'smaa', ...[2, 4].filter((n) => samples.includes(n)).map((n) => `msaa${n}`)];
}

// Manual 100% means native display pixels, independent of the quality preset.
// Bound the frame allocation as well as texture dimensions before allocating RTs.
export function renderSize({ width, height, dpr = 1, basePR = 1, scale = 1, auto = true, maxDimension = 16384, maxPixels = 32e6 }) {
  const w = Math.max(1, width), h = Math.max(1, height);
  const base = auto ? basePR : dpr, wanted = base * clampRenderScale(scale);
  const pr = Math.max(1 / Math.max(w, h), Math.min(wanted, maxDimension / w, maxDimension / h, Math.sqrt(maxPixels / (w * h))));
  return { pr, width: Math.max(1, Math.floor(w * pr)), height: Math.max(1, Math.floor(h * pr)),
    appliedScale: pr / base, limited: pr < wanted - 0.001 };
}
