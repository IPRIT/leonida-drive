// Loading of generated world data (public/data). Binary files are gzip streams.

import { BUILD } from './version.js';

const BASE = `${import.meta.env.BASE_URL}data/`;
// world data files keep their names across deploys: a per-build query keeps browsers from mixing old data with new code
const V = BUILD === 'dev' ? '' : `?v=${BUILD}`;

async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf; // already decoded by the server
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body || !onBytes) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

export async function loadWorldData(onProgress) {
  const files = [
    ['world', 'world.json', 'json', 60e3],
    ['height', 'height.bin', 'bin', 2.1e6],
    ['ground', 'ground.bin', 'bin', 0.5e6],
    ['roads', 'roads.json', 'json', 1.5e6],
    ['buildings', 'buildings.json', 'json', 1.6e6],
    ['veg', 'veg.bin', 'bin', 1.9e6],
  ];
  const expected = files.reduce((s, f) => s + f[3], 0);
  let loaded = 0;
  const bump = (n) => { loaded += n; onProgress?.(Math.min(0.99, loaded / expected)); };
  const out = {};
  // optional: real-world building massing (tools/irl_build.py, OSM data); the world builds fine without it
  const irl = fetch(BASE + 'irl.json' + V).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // optional: junction shapes measured on the source map (tools/junction_shapes.py: kerb-return radii, islands)
  const jsh = fetch(BASE + 'junctions.json' + V).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  await Promise.all(files.map(async ([key, file, kind]) => {
    const buf = await fetchWithProgress(BASE + file + V, bump);
    if (kind === 'json') out[key] = JSON.parse(new TextDecoder().decode(buf));
    else out[key] = await gunzip(buf);
  }));
  out.irl = await irl;
  out.junctions = await jsh;
  const w = out.world;
  out.heights = new Int16Array(out.height); // decimetres, (gh+1) x (gw+1)
  out.groundTex = new Uint8Array(out.ground); // th x tw
  return out;
}

export const MAP_IMAGE_URL = BASE + 'map.webp' + V;
export const MAP_SMALL_URL = BASE + 'map_small.webp' + V;
