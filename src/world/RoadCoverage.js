import { subtractSurface } from './RoadSurface.js';

// Close genuine holes in paved driving corridors after ribbons and
// junctions have been joined. Subtract existing asphalt with a millimetre seam
// tolerance, keeping the different levels of an interchange independent.
const CELL = 24;
const key = (x, z) => Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
const cross = (a, b, x, z) => (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);

export function closeRoadCoverage(roads, buckets, bget, skip) {
  const grid = new Map();
  const add = (p) => {
    p = p.map((v) => [Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2])]);
    const [a, b, c] = p, den = cross(a, b, c[0], c[2]);
    if (Math.abs(den) < 1e-7) return;
    const dx = ((b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2])) / den;
    const dz = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / den;
    const tri = { p, sign: Math.sign(den), plane: { at: (x, z) => a[1] + dx * (x - a[0]) + dz * (z - a[2]) } };
    const x0 = Math.min(a[0], b[0], c[0]), x1 = Math.max(a[0], b[0], c[0]);
    const z0 = Math.min(a[2], b[2], c[2]), z1 = Math.max(a[2], b[2], c[2]);
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const k = i * 100003 + j;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(tri);
    }
    return tri;
  };
  for (const b of buckets.values()) for (let i = 0; i < b.idx.length; i += 3) add(b.idx.slice(i, i + 3).map((v) => b.pos.slice(v * 3, v * 3 + 3)));
  const covered = (x, y, z) => {
    x = Math.fround(x); z = Math.fround(z);
    const list = grid.get(key(x, z));
    if (!list) return false;
    for (const t of list) {
      if (Math.abs(t.plane.at(x, z) - y) > 2) continue;
      if (t.p.every((p, i) => cross(p, t.p[(i + 1) % 3], x, z) * t.sign >= -1e-5)) return true;
    }
    return false;
  };
  const record = (x, y, z) => [x, y, z, 0, 0, 0, 30, 1, 0, 99, 99, 0, 0];
  let gaps = 0, triangles = 0;
  const misses = [];
  for (const e of roads.edges) {
    if (e.kind === 2 || e.airside || e.tunnel || e.len < 1 || skip?.(e, roads)) continue;
    const tangents = [];
    for (let k = 0; k < e.n; k++) {
      const a = Math.max(0, k - 1) * 2, b = Math.min(e.n - 1, k + 1) * 2;
      const dx = e.pts[b] - e.pts[a], dz = e.pts[b + 1] - e.pts[a + 1], l = Math.hypot(dx, dz) || 1;
      tangents.push([dx / l, dz / l]);
    }
    const row = (s) => {
      const p = roads.pointAt(e, s), k = Math.min(p.k, e.n - 2);
      const t = (s - e.cum[k]) / (e.cum[k + 1] - e.cum[k] || 1);
      let dx = tangents[k][0] * (1 - t) + tangents[k + 1][0] * t, dz = tangents[k][1] * (1 - t) + tangents[k + 1][1] * t;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const point = (f) => {
        const x = p.x - dz * p.w * f, z = p.z + dx * p.w * f;
        let y = p.y + 0.07;
        for (const [ni, d, end] of [[e.a, s, 0], [e.b, e.len - s, 1]]) {
          const J = roads.junctions[ni];
          if (J?.plane && d <= (roads.trims[e.i][end]?.t || 0)) { y = J.plane.at(x, z) + 0.07; break; }
        }
        return record(x, y, z);
      };
      return { point, p };
    };
    const n = Math.max(1, Math.ceil(e.len / 0.75));
    for (let k = 0; k <= n; k++) {
      const s = e.len * k / n, r = row(s);
      if ((roads.adj[e.a].length === 1 && s < 2.5) || (roads.adj[e.b].length === 1 && e.len - s < 2.5)) continue;
      const missing = [-0.25, 0, 0.25].map((f) => r.point(f)).filter((p) =>
        !covered(p[0], p[1], p[2]) || !covered(p[0] - 0.15, p[1], p[2]) || !covered(p[0] + 0.15, p[1], p[2])
        || !covered(p[0], p[1], p[2] - 0.15) || !covered(p[0], p[1], p[2] + 0.15));
      if (!missing.length) continue;
      misses.push(...missing.map((p) => ({ edge: e.i, p: p.slice(0, 3) })));
      const a = row(Math.max(0, s - 2.1)), b = row(Math.min(e.len, s + 2.1));
      const quad = [a.point(-0.4), a.point(0.4), r.point(0.4), r.point(-0.4), b.point(0.4), b.point(-0.4)];
      const x0 = Math.min(...quad.map((p) => p[0])) - 0.4, x1 = Math.max(...quad.map((p) => p[0])) + 0.4;
      const z0 = Math.min(...quad.map((p) => p[2])) - 0.4, z1 = Math.max(...quad.map((p) => p[2])) + 0.4;
      const cuts = new Set();
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        for (const t of grid.get(i * 100003 + j) || []) if (Math.abs(t.plane.at(r.p.x, r.p.z) - r.p.y - 0.07) <= 2) cuts.add(t);
      }
      let pieces = [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]], [quad[3], quad[2], quad[4]], [quad[3], quad[4], quad[5]]];
      // Rounded caps support a tyre where a tight bend or a junction endpoint
      // falls just outside the chord between the preceding and following rows.
      for (const p of missing) for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, b = (i + 1) * Math.PI / 4;
        pieces.push([p, record(p[0] + Math.cos(a) * 0.35, p[1], p[2] + Math.sin(a) * 0.35),
          record(p[0] + Math.cos(b) * 0.35, p[1], p[2] + Math.sin(b) * 0.35)]);
      }
      for (const t of cuts) {
        // A 3 mm coplanar overlap absorbs float32 rounding at long world
        // coordinates, where mathematically shared triangle edges can separate.
        pieces = pieces.flatMap((p) => subtractSurface(p, t.p, t.plane, 0, 0.003));
        if (!pieces.length) break;
      }
      if (!pieces.length) continue;
      gaps++;
      const bucket = bget(r.p.x, r.p.z);
      const written = [];
      for (const piece of pieces) {
        let remaining = [piece];
        for (const t of written) remaining = remaining.flatMap((p) => subtractSurface(p, t.p, t.plane, 0));
        for (const p of remaining) {
        const start = bucket.pos.length / 3;
        for (const v of p) { bucket.pos.push(...v.slice(0, 3)); bucket.lane.push(...v.slice(3, 5)); bucket.info.push(...v.slice(5, 9)); bucket.end.push(...v.slice(9, 13)); }
        for (let i = 1; i < p.length - 1; i++) {
          const t = [p[0], p[i], p[i + 1]];
          if (cross(t[0], t[1], t[2][0], t[2][2]) > 0) bucket.idx.push(start, start + i + 1, start + i);
          else bucket.idx.push(start, start + i, start + i + 1);
          const added = add(t);
          if (added) written.push(added);
          triangles++;
        }
        }
      }
    }
  }
  const unresolved = misses.filter(({ p }) => !covered(p[0], p[1], p[2]));
  return { gaps, triangles, unresolved: unresolved.length, examples: unresolved.slice(0, 12) };
}
