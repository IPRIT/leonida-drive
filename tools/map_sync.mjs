#!/usr/bin/env node
// Synchronise the committed cartography with roads.json without requiring the
// original raster/OSM caches. Only r0..r3 are replaced; land, buildings,
// labels, routes and independent airport/park geometry are preserved.
import fs from 'node:fs';
import zlib from 'node:zlib';

const DIR = new URL('../public/data/', import.meta.url);
const roads = JSON.parse(fs.readFileSync(new URL('roads.json', DIR)));
const input = fs.readFileSync(new URL('map.bin', DIR));
const raw = input[0] === 0x1f && input[1] === 0x8b ? zlib.gunzipSync(input) : input;
const headerLength = raw.readUInt32LE(8);
const header = JSON.parse(raw.subarray(12, 12 + headerLength).toString('utf8'));
const blobStart = 12 + headerLength;
const arrays = new Map();
for (const [name, [type, offset, length]] of Object.entries(header.arrays)) {
  arrays.set(name, { type, data: raw.subarray(blobStart + offset, blobStart + offset + length * (type === 'int16' ? 2 : type === 'uint8' ? 1 : 4)) });
}
const typed = (type, data) => type === 'int16' ? new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2)
  : type === 'int32' ? new Int32Array(data.buffer, data.byteOffset, data.byteLength / 4)
    : type === 'uint8' ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);

const P = typed('int32', arrays.get('r0.parts').data);
const D = typed('int16', arrays.get('r0.coords').data);
const decoded = [];
let offset = 0;
for (let i = 0; i < P.length / 4; i++) {
  const n = P[i * 4 + 2], p = [];
  let x = 0, z = 0;
  for (let k = 0; k < n; k++) {
    x += D[(offset + k) * 2]; z += D[(offset + k) * 2 + 1];
    p.push([header.origin[0] + x * header.q, header.origin[1] + z * header.q]);
  }
  decoded.push({ cls: P[i * 4 + 1], width: P[i * 4 + 3], p });
  offset += n;
}

// Independent park paths are retained, but their former copies of graph dirt
// roads are not. Nearest graph vertices are sufficient for classification:
// source points are at most eight metres apart and the threshold is only 3 m.
const CELL = 32, pointGrid = new Map();
for (const e of roads.edges) for (let i = 0; i < e.p.length; i += 2) {
  const key = `${Math.floor(e.p[i] / CELL)},${Math.floor(e.p[i + 1] / CELL)}`;
  if (!pointGrid.has(key)) pointGrid.set(key, []);
  pointGrid.get(key).push(e.p[i], e.p[i + 1]);
}
function nearestPoint(x, z) {
  let best = Infinity;
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let ring = 0; ring < 4 && best === Infinity; ring++) for (let i = cx - ring; i <= cx + ring; i++) for (let j = cz - ring; j <= cz + ring; j++) {
    const a = pointGrid.get(`${i},${j}`) || [];
    for (let k = 0; k < a.length; k += 2) best = Math.min(best, Math.hypot(x - a[k], z - a[k + 1]));
  }
  return best;
}
const independent = [];
const hasProvenance = decoded.some((part) => part.cls & 512);
let parkParts = 0, airportParts = 0, tunnelParts = 0;
for (const part of decoded) {
  const cls = part.cls & 15;
  // Bit 9 is container provenance, ignored by the renderer. It makes this
  // repair idempotent instead of re-classifying already filtered park paths.
  if (part.cls & 512) {
    independent.push(part);
    if (cls === 4 || cls === 5) airportParts++;
    else if (part.cls & 256) tunnelParts++;
    else parkParts++;
    continue;
  }
  if (cls === 4 || cls === 5) { part.cls |= 512; independent.push(part); airportParts++; continue; }
  if (part.cls & 256) { part.cls |= 512; independent.push(part); tunnelParts++; continue; }
  // On later runs every independent path already carries provenance; all
  // unmarked class-3 parts are freshly generated graph edges.
  if (cls !== 3 || hasProvenance) continue;
  const distances = part.p.map(([x, z]) => nearestPoint(x, z)).sort((a, b) => a - b);
  if (distances[Math.floor(distances.length / 2)] > 3) { part.cls |= 512; independent.push(part); parkParts++; }
}

const overpassEdges = new Map();
for (const o of roads.overpasses || []) for (const ei of o.upper || []) {
  if (!overpassEdges.has(ei)) overpassEdges.set(ei, []);
  overpassEdges.get(ei).push(o);
}
function levelAt(e, ei, k) {
  if (e.tunnel) return -1;
  for (const o of overpassEdges.get(ei) || []) {
    if (Math.hypot(e.p[k * 2] - o.x, e.p[k * 2 + 1] - o.z) <= o.radius + 12) return 1;
  }
  const br = e.br?.[k] && e.br?.[Math.min(k + 1, e.p.length / 2 - 1)];
  return br ? 1 : 0;
}
function edgeParts(e, ei) {
  const cls = e.cl ?? (e.k === 'highway' ? 0 : e.k === 'dirt' ? 3 : 2);
  if (cls === 4 || cls === 5) return []; // exact landmark geometry is independent
  const out = [];
  let points = [[e.p[0], e.p[1]]], previous = null;
  const flush = () => {
    if (points.length > 1 && previous) out.push({ cls: previous.flags, width: Math.round(e.w * 10), p: points });
  };
  for (let k = 0; k + 1 < e.p.length / 2; k++) {
    const level = levelAt(e, ei, k) === 1 && levelAt(e, ei, k + 1) === 1 ? 1 : e.tunnel ? -1 : 0;
    const br = !e.tunnel && !!e.br?.[k] && !!e.br?.[k + 1];
    const flags = cls | (br ? 16 : 0) | ((level + 1) << 5) | (e.rp ? 128 : 0) | (e.tunnel ? 256 : 0);
    if (previous && flags !== previous.flags) {
      const mid = [(e.p[k * 2 - 2] + e.p[k * 2]) / 2, (e.p[k * 2 - 1] + e.p[k * 2 + 1]) / 2];
      points.push(mid); flush(); points = [mid];
    }
    points.push([e.p[k * 2 + 2], e.p[k * 2 + 3]]);
    previous = { flags };
  }
  flush();
  return out;
}
// Join continuous strokes before packing. One Path2D per graph edge is
// needlessly expensive; pairing the straightest compatible arms reproduces
// map_build.py's stroke model without changing any centreline vertex.
function joinedGraphParts() {
  const adj = roads.nodes.map(() => []);
  roads.edges.forEach((e, ei) => { adj[e.a].push([ei, 0]); if (e.b !== e.a) adj[e.b].push([ei, 1]); });
  const baseKey = (ei) => {
    const e = roads.edges[ei], cls = e.cl ?? (e.k === 'highway' ? 0 : e.k === 'dirt' ? 3 : 2);
    return `${cls}|${e.rp ? 1 : 0}|${Math.round(e.w)}|${e.tunnel ? 1 : 0}`;
  };
  const outward = (ei, end) => {
    const p = roads.edges[ei].p, n = p.length / 2, k = Math.min(3, n - 1);
    const a = end ? n - 1 : 0, b = end ? n - 1 - k : k;
    const dx = p[b * 2] - p[a * 2], dz = p[b * 2 + 1] - p[a * 2 + 1], l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const pairs = new Map();
  for (const ports of adj) {
    const candidates = [];
    for (let i = 0; i < ports.length; i++) for (let j = i + 1; j < ports.length; j++) {
      const [ae, ai] = ports[i], [be, bi] = ports[j];
      if (ae === be || baseKey(ae) !== baseKey(be)) continue;
      const a = outward(ae, ai), b = outward(be, bi), dot = a[0] * b[0] + a[1] * b[1];
      if (dot < -0.8829) candidates.push([dot, ports[i], ports[j]]);
    }
    candidates.sort((a, b) => a[0] - b[0]);
    const used = new Set();
    for (const [, a, b] of candidates) {
      const ak = `${a[0]}:${a[1]}`, bk = `${b[0]}:${b[1]}`;
      if (used.has(ak) || used.has(bk)) continue;
      pairs.set(ak, b); pairs.set(bk, a); used.add(ak); used.add(bk);
    }
  }
  const seen = new Set(), lines = [];
  for (let first = 0; first < roads.edges.length; first++) {
    if (seen.has(first)) continue;
    const seq = [[first, true]]; seen.add(first);
    for (const forward of [false, true]) {
      let ei = first, end = forward ? 1 : 0;
      while (true) {
        const next = pairs.get(`${ei}:${end}`);
        if (!next || seen.has(next[0])) break;
        const [ne, neEnd] = next, fwd = neEnd === 1;
        if (forward) seq.push([ne, fwd]); else seq.unshift([ne, fwd]);
        // `fwd` means the neighbouring edge's b-end touches this node.
        seen.add(ne); ei = ne; end = forward ? (fwd ? 1 : 0) : (fwd ? 0 : 1);
      }
    }
    for (const [ei, fwd] of seq) {
      let parts = edgeParts(roads.edges[ei], ei);
      if (!fwd) parts = parts.reverse().map((part) => ({ ...part, p: part.p.slice().reverse() }));
      for (const part of parts) {
        const last = lines[lines.length - 1];
        if (last && last.cls === part.cls && last.width === part.width) {
          const a = last.p[last.p.length - 1], b = part.p[0];
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.1) { last.p.push(...part.p.slice(1)); continue; }
        }
        lines.push(part);
      }
    }
  }
  return lines;
}
const graphParts = joinedGraphParts();

function simplify(points, tolerance) {
  if (points.length < 3 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), A = points[a], B = points[b];
    const dx = B[0] - A[0], dz = B[1] - A[1], ll = dx * dx + dz * dz;
    let farthest = -1, error = tolerance;
    for (let i = a + 1; i < b; i++) {
      const P = points[i];
      const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dz) / (ll || 1)));
      const d = Math.hypot(P[0] - A[0] - dx * t, P[1] - A[1] - dz * t);
      if (d > error) { error = d; farthest = i; }
    }
    if (farthest > 0) { keep[farthest] = 1; stack.push([a, farthest], [farthest, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
function cellOf(p, cell) {
  const b = header.bounds;
  const x = (p[0][0] + p[p.length - 1][0]) / 2, z = (p[0][1] + p[p.length - 1][1]) / 2;
  const cols = Math.ceil((b[2] - b[0]) / cell), rows = Math.ceil((b[3] - b[1]) / cell);
  const cx = Math.max(0, Math.min(cols - 1, Math.floor((x - b[0]) / cell)));
  const cz = Math.max(0, Math.min(rows - 1, Math.floor((z - b[1]) / cell)));
  return cz * cols + cx;
}
function geometry(name, parts) {
  const all = [...graphParts, ...independent];
  const classes = name === 'r0' || name === 'r1' ? new Set([0, 1, 2, 3, 4, 5]) : name === 'r2' ? new Set([0, 1, 2, 4]) : new Set([0, 1, 4]);
  const ramps = name !== 'r3';
  const cell = header.sets[name].cell, selected = [];
  for (const part of all) {
    const cls = part.cls & 15;
    if (!classes.has(cls) || ((part.cls & 128) && !ramps)) continue;
    const p = simplify(part.p, header.sets[name].tol);
    if (p.length > 1) selected.push({ ...part, p, cell: cellOf(p, cell) });
  }
  selected.sort((a, b) => a.cell - b.cell);
  const pp = [], dd = [];
  for (const part of selected) {
    const q = part.p.map(([x, z]) => [Math.round((x - header.origin[0]) / header.q), Math.round((z - header.origin[1]) / header.q)]);
    const unique = q.filter((v, i) => !i || v[0] !== q[i - 1][0] || v[1] !== q[i - 1][1]);
    pp.push(part.cell, part.cls, unique.length, part.width);
    for (let i = 0; i < unique.length; i++) dd.push(i ? unique[i][0] - unique[i - 1][0] : unique[i][0], i ? unique[i][1] - unique[i - 1][1] : unique[i][1]);
  }
  arrays.set(`${name}.parts`, { type: 'int32', data: Buffer.from(new Int32Array(pp).buffer) });
  arrays.set(`${name}.coords`, { type: 'int16', data: Buffer.from(new Int16Array(dd).buffer) });
  header.sets[name].parts = selected.length;
  header.sets[name].points = dd.length / 2;
}
for (const name of ['r0', 'r1', 'r2', 'r3']) geometry(name);

const chunks = []; let blobLength = 0;
for (const [name, entry] of arrays) {
  while (blobLength % 4) { chunks.push(Buffer.alloc(1)); blobLength++; }
  header.arrays[name][1] = blobLength;
  header.arrays[name][2] = entry.data.byteLength / (entry.type === 'int16' ? 2 : entry.type === 'uint8' ? 1 : 4);
  chunks.push(entry.data); blobLength += entry.data.byteLength;
}
let headerBuffer = Buffer.from(JSON.stringify(header));
while (headerBuffer.length % 4) headerBuffer = Buffer.concat([headerBuffer, Buffer.from(' ')]);
const prefix = Buffer.alloc(12); prefix.write('LDMAP1\0\0', 0, 'binary'); prefix.writeUInt32LE(headerBuffer.length, 8);
const output = zlib.gzipSync(Buffer.concat([prefix, headerBuffer, ...chunks]), { level: 9 });
const target = new URL('map.bin', DIR);
fs.writeFileSync(target, output);
console.log(JSON.stringify({ graphEdges: roads.edges.length, graphParts: graphParts.length, parkParts, airportParts, tunnelParts,
  r0Parts: header.sets.r0.parts, r0Points: header.sets.r0.points, bytes: output.length }, null, 2));
