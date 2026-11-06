import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import test from 'node:test';
import { addLine, parseMapBuffer } from '../../src/map/mapData.js';

const roads = JSON.parse(fs.readFileSync(new URL('../../public/data/roads.json', import.meta.url)));
const raw = fs.readFileSync(new URL('../../public/data/map.bin', import.meta.url));
const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const map = parseMapBuffer(arrayBuffer, { sets: ['r0'] }).sets.r0;
const CELL = 32;
const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

function indexSegments(parts) {
  const grid = new Map();
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    for (let k = 0; k + 3 < p.length; k += 2) {
      const x0 = Math.min(p[k], p[k + 2]), x1 = Math.max(p[k], p[k + 2]);
      const z0 = Math.min(p[k + 1], p[k + 3]), z1 = Math.max(p[k + 1], p[k + 3]);
      for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
        for (let z = Math.floor(z0 / CELL); z <= Math.floor(z1 / CELL); z++) {
          const id = `${x},${z}`;
          let list = grid.get(id);
          if (!list) grid.set(id, (list = []));
          list.push(p[k], p[k + 1], p[k + 2], p[k + 3]);
        }
      }
      count++;
    }
  }
  return { grid, count };
}

function distance(x, z, index) {
  let best = Infinity;
  // Always inspect the neighbouring cells too: a segment immediately across a
  // cell border can be closer than every segment in the point's own cell.
  for (let ring = 0; ring <= 1; ring++) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = cx - ring; i <= cx + ring; i++) for (let j = cz - ring; j <= cz + ring; j++) {
      const list = index.grid.get(`${i},${j}`);
      if (!list) continue;
      for (let k = 0; k < list.length; k += 4) {
        const ax = list[k], az = list[k + 1], dx = list[k + 2] - ax, dz = list[k + 3] - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
      }
    }
  }
  return best;
}

function percentile(values, q) {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * q))];
}

test('map corner smoothing is bounded and preserves endpoints', () => {
  const calls = [];
  const path = {
    moveTo: (...v) => calls.push(['M', ...v]),
    lineTo: (...v) => calls.push(['L', ...v]),
    quadraticCurveTo: (...v) => calls.push(['Q', ...v]),
  };
  addLine(path, Float32Array.from([0, 0, 10, 0, 10, 10]), 0, 3);
  assert.deepEqual(calls[0], ['M', 0, 0]);
  assert.deepEqual(calls.at(-1), ['L', 10, 10]);
  const qi = calls.findIndex((c) => c[0] === 'Q'), q = calls[qi], start = calls[qi - 1];
  // At t=0.5 the quadratic is 12.5 cm inside the source corner.
  const x = 0.25 * start[1] + 0.5 * q[1] + 0.25 * q[3];
  const y = 0.25 * start[2] + 0.5 * q[2] + 0.25 * q[4];
  assert.ok(Math.hypot(10 - x, y) <= 0.250001);
});

test('LOD0 cartography preserves every road centreline', () => {
  const mapParts = [];
  for (let i = 0; i < map.n; i++) mapParts.push(map.xy.subarray(map.start[i] * 2, map.start[i + 1] * 2));
  const mapIndex = indexSegments(mapParts);
  const errors = [];
  const missing = [];
  for (let ei = 0; ei < roads.edges.length; ei++) {
    // Airports are deliberately drawn from the same exact landmark outlines
    // in both the 3D scene and the map, not from their routing centrelines.
    if ((roads.edges[ei].cl ?? -1) >= 4) continue;
    const p = roads.edges[ei].p;
    for (let k = 0; k < p.length; k += 2) {
      const d = distance(p[k], p[k + 1], mapIndex);
      errors.push(d);
      // 0.45 m RDP + 0.354 m quantisation + a small midpoint-spline margin.
      if (d > 1.5) missing.push({ edge: ei, point: [p[k], p[k + 1]], distance: d });
    }
  }
  assert.equal(missing.length, 0, JSON.stringify(missing.slice(0, 12)));
  assert.ok(percentile(errors, 0.99) < 0.8, `p99 centreline error ${percentile(errors, 0.99)}`);
});

test('every planned interchange has an upper deck on the map', () => {
  for (const crossing of roads.overpasses || []) {
    let found = false;
    for (let i = 0; i < map.n && !found; i++) {
      const level = ((map.parts[i * 4 + 1] >> 5) & 3) - 1;
      if (level <= 0) continue;
      for (let k = map.start[i] * 2; k < map.start[i + 1] * 2; k += 2) {
        if (Math.hypot(map.xy[k] - crossing.x, map.xy[k + 1] - crossing.z) <= crossing.radius + 12) { found = true; break; }
      }
    }
    assert.ok(found, `missing upper deck at ${crossing.x},${crossing.z}`);
  }
});

test('LOD0 cartography has no road strokes absent from the driving graph', () => {
  const roadParts = roads.edges.map((e) => Float32Array.from(e.p));
  const roadIndex = indexSegments(roadParts);
  const errors = [];
  const extra = [];
  for (let i = 0; i < map.n; i++) {
    const flags = map.parts[i * 4 + 1], cls = flags & 15;
    // Independent park paths, runtime-generated tunnels and exact airport
    // landmarks are audited by their own producers, not by this graph test.
    if (cls >= 3 || (flags & 256)) continue;
    for (let k = map.start[i] * 2; k < map.start[i + 1] * 2; k += 2) {
      const d = distance(map.xy[k], map.xy[k + 1], roadIndex);
      errors.push(d);
      // Attribute transitions split a map segment at its midpoint, so only a
      // slightly wider tolerance is needed than in the opposite direction.
      if (d > 2.1) extra.push({ part: i, point: [map.xy[k], map.xy[k + 1]], distance: d });
    }
  }
  assert.equal(extra.length, 0, JSON.stringify(extra.slice(0, 12)));
  assert.ok(percentile(errors, 0.99) < 1.2, `p99 reverse centreline error ${percentile(errors, 0.99)}`);
});
