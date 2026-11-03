// Clip a ribbon against an overlapping junction. Newly created seam vertices
// use the junction plane, so the visible surface and its collider meet exactly.
// Record layout: position(3), lane(2), info(4), end(4).
const EPS = 1e-7;
const cross = (a, b, p) => (b[0] - a[0]) * (p[2] - a[2]) - (b[2] - a[2]) * (p[0] - a[0]);
const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[2] - q[0] * p[i][2]; } return Math.abs(a) / 2; };

function split(poly, a, b, sign) {
  const inside = [], outside = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const d = cross(a, b, p) * sign, e = cross(a, b, q) * sign;
    if (d >= -EPS) inside.push(p);
    if (d <= EPS) outside.push(p);
    if ((d > EPS && e < -EPS) || (d < -EPS && e > EPS)) {
      const t = d / (d - e), r = p.map((v, k) => v + (q[k] - v) * t);
      inside.push(r); outside.push(r);
    }
  }
  return [inside, outside];
}

export function subtractSurface(poly, triangle, plane, lift = 0.07, seamOverlap = 0) {
  const sign = Math.sign(cross(triangle[0], triangle[1], triangle[2])) || 1;
  let overlap = poly;
  for (let i = 0; i < 3 && overlap.length >= 3; i++) overlap = split(overlap, triangle[i], triangle[(i + 1) % 3], sign)[0];
  if (overlap.length < 3 || area(overlap) < 1e-6) return [poly];
  const pieces = [];
  let remaining = poly;
  for (let i = 0; i < 3 && remaining.length >= 3; i++) {
    const [a, b] = split(remaining, triangle[i], triangle[(i + 1) % 3], sign);
    if (b.length >= 3 && area(b) > 1e-6) pieces.push(b);
    remaining = a;
  }
  for (const piece of pieces) for (let i = 0; i < piece.length; i++) {
    const p = piece[i];
    if (triangle.every((a, k) => cross(a, triangle[(k + 1) % 3], p) * sign >= -EPS)) {
      const q = p.slice();
      if (seamOverlap) {
        const dx = (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3 - q[0];
        const dz = (triangle[0][2] + triangle[1][2] + triangle[2][2]) / 3 - q[2];
        const l = Math.hypot(dx, dz) || 1;
        q[0] += dx / l * seamOverlap; q[2] += dz / l * seamOverlap;
      }
      q[1] = plane.at(q[0], q[2]) + lift; piece[i] = q;
    }
  }
  return pieces;
}

export function surfaceTriangle(b, a, c, d, cuts) {
  if (!cuts.length) { b.idx.push(a, c, d); return; }
  const ids = [a, c, d];
  const x0 = Math.min(...ids.map((i) => b.pos[i * 3])), x1 = Math.max(...ids.map((i) => b.pos[i * 3]));
  const z0 = Math.min(...ids.map((i) => b.pos[i * 3 + 2])), z1 = Math.max(...ids.map((i) => b.pos[i * 3 + 2]));
  const near = cuts.filter((J) => x0 < J.bb[1] && x1 > J.bb[0] && z0 < J.bb[3] && z1 > J.bb[2]);
  if (!near.length) { b.idx.push(a, c, d); return; }
  const vertex = (i) => [...b.pos.slice(i * 3, i * 3 + 3), ...b.lane.slice(i * 2, i * 2 + 2), ...b.info.slice(i * 4, i * 4 + 4), ...b.end.slice(i * 4, i * 4 + 4)];
  const original = ids.map(vertex);
  let pieces = [original];
  for (const J of near) {
    const cy = original.reduce((s, p) => s + p[1], 0) / 3;
    if (Math.abs(J.plane.at((x0 + x1) / 2, (z0 + z1) / 2) + 0.07 - cy) > 2) continue;
    for (const tri of J.cutTriangles) {
      pieces = pieces.flatMap((p) => subtractSurface(p, tri, J.plane));
      if (!pieces.length) break;
    }
  }
  if (pieces.length === 1 && pieces[0] === original) { b.idx.push(a, c, d); return; }
  for (const piece of pieces) {
    const start = b.pos.length / 3;
    for (const p of piece) { b.pos.push(...p.slice(0, 3)); b.lane.push(...p.slice(3, 5)); b.info.push(...p.slice(5, 9)); b.end.push(...p.slice(9, 13)); }
    for (let k = 1; k < piece.length - 1; k++) b.idx.push(start, start + k, start + k + 1);
  }
}
