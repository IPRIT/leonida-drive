// Node helpers for the economy tools/tests: load public/data (roads, districts, terrain heights, ground classes).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.resolve(here, '../../public/data');

const gz = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);

export function loadWorld(dir = DATA) {
  const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
  const roads = JSON.parse(fs.readFileSync(path.join(dir, 'roads.json'), 'utf8'));
  const hb = gz(fs.readFileSync(path.join(dir, 'height.bin')));
  const h = new Int16Array(hb.buffer, hb.byteOffset, hb.byteLength >> 1);
  const gb = gz(fs.readFileSync(path.join(dir, 'ground.bin')));
  const { gw, gh, hs, ts, tw, th } = world;
  const [x0, z0] = world.bounds;
  const W = gw + 1;
  // same interpolation as src/world/Terrain.js heightAt
  const heightAt = (x, z) => {
    let fx = (x - x0) / hs, fz = (z - z0) / hs;
    if (fx < 0) fx = 0; else if (fx > gw - 1e-4) fx = gw - 1e-4;
    if (fz < 0) fz = 0; else if (fz > gh - 1e-4) fz = gh - 1e-4;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const h00 = h[iz * W + ix], h10 = h[iz * W + ix + 1], h01 = h[(iz + 1) * W + ix], h11 = h[(iz + 1) * W + ix + 1];
    const v = tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
    return v * 0.1;
  };
  const G = world.ground;
  const groundAt = (x, z) => {
    const i = Math.floor((x - x0) / ts), j = Math.floor((z - z0) / ts);
    if (i < 0 || j < 0 || i >= tw || j >= th) return G.water;
    return gb[j * tw + i];
  };
  return { world, roads, heightAt, groundAt, G };
}
