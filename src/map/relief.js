// Hillshade raster computed from the height grid (Int16 decimetres, (gh+1) x (gw+1) samples, hs metres apart):
// signed light/shadow alpha over land (8 m/px) plus a faint elevation tint. A smooth field drawn only at zoom levels
// where it is barely magnified (see shadeFade in style.js); bathymetry is vector (depth bands in map.bin).
// Pure function (no DOM): used by the tile worker and by the main-thread fallback.

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function computeHillshade(heights, gw, gh, hs, strength = 1) {
  const W = gw, H = gh;
  const data = new Uint8ClampedArray(W * H * 4);
  const row = gw + 1;
  const zf = 2.2; // vertical exaggeration
  // light from the north-west, 45 degrees up (x east, z south)
  const lx = -0.5, ly = 0.7071, lz = -0.5;
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      const a = heights[i * row + j], b = heights[i * row + j + 1];
      const c = heights[(i + 1) * row + j], d = heights[(i + 1) * row + j + 1];
      const hAvg = (a + b + c + d) / 40;
      const o = (i * W + j) * 4;
      if (hAvg <= 0.4) { data[o + 3] = 0; continue; }
      const dzdx = ((b + d) - (a + c)) / (20 * hs) * zf;
      const dzdz = ((c + d) - (a + b)) / (20 * hs) * zf;
      const inv = 1 / Math.sqrt(dzdx * dzdx + 1 + dzdz * dzdz);
      const shade = (-dzdx * lx + ly - dzdz * lz) * inv;
      let v = (shade - ly) * 1.6;
      // ignore the tiny bumps of the flat lowlands
      v = Math.sign(v) * Math.max(0, Math.abs(v) - 0.015);
      v += sstep(20, 320, hAvg) * 0.16; // higher ground slightly lighter
      const al = Math.min(1, Math.abs(v) * strength);
      const c255 = v > 0 ? 255 : 0;
      data[o] = c255; data[o + 1] = c255; data[o + 2] = c255;
      data[o + 3] = al * 255;
    }
  }
  return { w: W, h: H, mpp: hs, data };
}
