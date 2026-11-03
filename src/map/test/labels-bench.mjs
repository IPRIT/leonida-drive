// Label placement benchmark + stability check (node, no DOM):
//   node src/map/test/labels-bench.mjs
// Decodes public/data/map.bin, builds the LabelLayer with an approximate text measurer and
//  1) times place() at several zoom levels over dense areas,
//  2) sweeps zoom monotonically and pans at constant zoom, counting visibility flips per label
//     (a label that turns on -> off -> on during a monotonic zoom or a pan is "flicker").
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMapBuffer } from '../mapData.js';
import { LabelLayer } from '../Labels.js';
import { REGIONS } from '../../world/regions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const raw = gunzipSync(readFileSync(join(root, 'public', 'data', 'map.bin')));
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const t0 = performance.now();
const map = parseMapBuffer(buf, { sets: ['st'] });
const tParse = performance.now() - t0;
// Oswald is condensed: ~0.5 em per character on average
const measure = (text, st) => text.length * st.size * (st.font.includes('Russo') ? 0.68 : 0.5) + (st.spacing || 0) * (text.length - 1);
const L = new LabelLayer(map, REGIONS, { measure, makeCanvas: () => null, dpr: 2 });
console.log(`parse ${tParse.toFixed(1)} ms; static labels ${L.static.length}, POIs ${L.pois.length}, street paths ${L.streetPaths.length}`);

const W = 1600, H = 900;
const spots = { 'Vice City': [-700, -300], 'Ocean Beach': [1700, -700], Keys: [-2500, 5900], Overview: [-2560, 0] };
let worst = 0;
console.log('\nplacement time (avg / max over 40 passes, panning):');
for (const [name, [cx, cz]] of Object.entries(spots)) {
  const row = [];
  for (const mpp of [0.35, 0.8, 1.6, 3, 6, 12, 24]) {
    const view = { cx, cz, mpp, w: W, h: H };
    L.place(view); // warm (widths cache)
    let sum = 0, max = 0;
    for (let i = 0; i < 40; i++) {
      view.cx = cx + i * 9 * mpp;
      const t = performance.now();
      L.place(view);
      const d = performance.now() - t;
      sum += d; max = Math.max(max, d);
    }
    worst = Math.max(worst, max);
    row.push(`${mpp}:${(sum / 40).toFixed(2)}/${max.toFixed(2)}ms(${L.placed.length})`);
  }
  console.log(`  ${name.padEnd(12)} ${row.join('  ')}`);
}

function sweep(views) {
  const flips = new Map();
  const state = new Map();
  for (const v of views) {
    L.place(v);
    for (const [id, c] of L.live) {
      const on = c.target === 1;
      const prev = state.get(id) ?? false;
      if (on !== prev) flips.set(id, (flips.get(id) || 0) + 1);
      state.set(id, on);
    }
    for (const [id, prev] of state) if (!L.live.has(id) && prev) { state.set(id, false); flips.set(id, (flips.get(id) || 0) + 1); }
  }
  return flips;
}

// 1) monotonic zoom in (labels may appear and disappear once: <= 2 flips; 3+ = flicker)
console.log('\nzoom sweep 14 -> 0.4 m/px (240 steps):');
for (const [name, [cx, cz]] of Object.entries(spots).slice(0, 3)) {
  L.live.clear();
  for (const c of L.static) { c.static = false; c.target = 0; }
  const views = [];
  for (let i = 0; i <= 240; i++) views.push({ cx, cz, mpp: 14 * Math.pow(0.4 / 14, i / 240), w: W, h: H });
  const flips = sweep(views);
  const bad = [...flips.entries()].filter(([, n]) => n > 2);
  console.log(`  ${name.padEnd(12)} labels seen ${flips.size}, flickering ${bad.length}${bad.length ? ': ' + bad.slice(0, 6).map(([id, n]) => `${id}x${n}`).join(' ') : ''}`);
}

// 2) pan at constant zoom: labels only change when they enter / leave the screen
console.log('\npan sweep (300 steps of 6 px):');
for (const mpp of [0.6, 2, 6]) {
  const [cx, cz] = spots['Vice City'];
  L.live.clear();
  for (const c of L.static) { c.static = false; c.target = 0; }
  const views = [];
  for (let i = 0; i <= 300; i++) views.push({ cx: cx + i * 6 * mpp, cz: cz + i * 2 * mpp, mpp, w: W, h: H });
  const flips = sweep(views);
  const bad = [...flips.entries()].filter(([, n]) => n > 2);
  console.log(`  mpp ${String(mpp).padEnd(4)} labels seen ${flips.size}, flickering ${bad.length}${bad.length ? ': ' + bad.slice(0, 6).map(([id, n]) => `${id}x${n}`).join(' ') : ''}`);
}
console.log(`\nworst single placement pass: ${worst.toFixed(2)} ms ${worst < 4 ? '(OK)' : '(SLOW)'}`);
