// Runway detection from the road graph (airport runways are very wide, straight 'highway' edges) and
// placement helpers for spawning aircraft and boats.
const AIRPORTS = [
  { name: 'Vice City International Airport', x: -2146, z: 724, r: 1700 },
  { name: 'Goose Key Airfield', x: -6900, z: 6550, r: 1100 },
  { name: 'Keys Airfield', x: -5400, z: 6900, r: 1500 },
];

const _cache = new WeakMap();

function fitLine(pts) {
  let cx = 0, cz = 0;
  for (const [x, z] of pts) { cx += x; cz += z; }
  cx /= pts.length; cz /= pts.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const [x, z] of pts) { const dx = x - cx, dz = z - cz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
  const a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  return { cx, cz, dx: Math.cos(a), dz: Math.sin(a) };
}

/** Detect runways once per roads instance. Returns [{ x0,z0,x1,z1,cx,cz,dx,dz,len,w,y,airport }]. */
export function findRunways(roads) {
  if (_cache.has(roads)) return _cache.get(roads);
  const cands = [];
  for (const e of roads.edges) {
    if (e.w < 38 || e.len < 150) continue;
    const pts = [];
    const ys = [];
    const k0 = Math.floor(e.n * 0.08), k1 = Math.ceil(e.n * 0.92);
    for (let k = k0; k < Math.max(k1, k0 + 2) && k < e.n; k++) { pts.push([e.pts[2 * k], e.pts[2 * k + 1]]); ys.push(e.y[k]); }
    if (pts.length < 2) continue;
    const L = fitLine(pts);
    let rms = 0, tMin = 1e9, tMax = -1e9;
    for (const [x, z] of pts) {
      const d = (x - L.cx) * -L.dz + (z - L.cz) * L.dx;
      rms += d * d;
    }
    rms = Math.sqrt(rms / pts.length);
    if (rms > 9) continue;
    for (let k = 0; k < e.n; k++) {
      const x = e.pts[2 * k], z = e.pts[2 * k + 1];
      const d = Math.abs((x - L.cx) * -L.dz + (z - L.cz) * L.dx);
      if (d > 14) continue;
      const t = (x - L.cx) * L.dx + (z - L.cz) * L.dz;
      tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
    }
    ys.sort((a, b) => a - b);
    cands.push({ ...L, tMin, tMax, w: e.w, y: ys[ys.length >> 1], yRange: ys[ys.length - 1] - ys[0], rms, pts, edges: [e.i] });
  }
  // merge collinear neighbours (runways split at taxiway junctions)
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const A = cands[i], B = cands[j];
        const cos = Math.abs(A.dx * B.dx + A.dz * B.dz);
        if (cos < Math.cos(0.09)) continue;
        const perp = Math.abs((B.cx - A.cx) * -A.dz + (B.cz - A.cz) * A.dx);
        if (perp > 16) continue;
        const s = (B.dx * A.dx + B.dz * A.dz) < 0 ? -1 : 1;
        const tb = (B.cx - A.cx) * A.dx + (B.cz - A.cz) * A.dz;
        const b0 = tb + Math.min(B.tMin * s, B.tMax * s), b1 = tb + Math.max(B.tMin * s, B.tMax * s);
        const gap = Math.max(A.tMin - b1, b0 - A.tMax);
        if (gap > 150) continue;
        const pts = A.pts.concat(B.pts);
        const L = fitLine(pts);
        const all = [A.tMin, A.tMax].map((t) => [A.cx + A.dx * t, A.cz + A.dz * t]).concat([B.tMin, B.tMax].map((t) => [B.cx + B.dx * t, B.cz + B.dz * t]));
        let tMin = 1e9, tMax = -1e9;
        for (const [x, z] of all) { const t = (x - L.cx) * L.dx + (z - L.cz) * L.dz; tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }
        cands[i] = { ...L, tMin, tMax, w: Math.max(A.w, B.w), y: (A.y + B.y) / 2, yRange: Math.max(A.yRange, B.yRange), rms: Math.max(A.rms, B.rms), pts, edges: A.edges.concat(B.edges) };
        cands.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  const out = [];
  for (const c of cands) {
    const len = c.tMax - c.tMin;
    const cx = c.cx + c.dx * (c.tMin + c.tMax) / 2, cz = c.cz + c.dz * (c.tMin + c.tMax) / 2;
    const ap = AIRPORTS.find((a) => Math.hypot(cx - a.x, cz - a.z) < a.r);
    const ok = ap ? len >= 600 : len >= 1000 && c.rms < 3 && c.yRange < 4;
    if (!ok) continue;
    out.push({
      x0: c.cx + c.dx * c.tMin, z0: c.cz + c.dz * c.tMin, x1: c.cx + c.dx * c.tMax, z1: c.cz + c.dz * c.tMax,
      cx, cz, dx: c.dx, dz: c.dz, len, w: c.w, y: c.y, airport: ap ? ap.name : 'Airstrip',
    });
  }
  out.sort((a, b) => b.len - a.len);
  _cache.set(roads, out);
  return out;
}

/** Distance from (x,z) to the runway centre line segment, plus along-track position t (0..len). */
export function runwayDistance(rw, x, z) {
  const t = Math.max(0, Math.min(rw.len, (x - rw.x0) * rw.dx + (z - rw.z0) * rw.dz));
  const px = rw.x0 + rw.dx * t, pz = rw.z0 + rw.dz * t;
  return { d: Math.hypot(x - px, z - pz), t };
}

export function nearestRunway(runways, x, z) {
  let best = null, bd = Infinity;
  for (const r of runways) {
    const { d } = runwayDistance(r, x, z);
    if (d < bd) { bd = d; best = r; }
  }
  return best ? { runway: best, dist: bd } : null;
}

/** Take-off position on runway rw: the threshold nearest to (x,z), facing down the runway. */
export function runwayStart(rw, x, z, inset = 60) {
  const d0 = Math.hypot(x - rw.x0, z - rw.z0), d1 = Math.hypot(x - rw.x1, z - rw.z1);
  const fromStart = d0 <= d1;
  const sx = fromStart ? rw.x0 + rw.dx * inset : rw.x1 - rw.dx * inset;
  const sz = fromStart ? rw.z0 + rw.dz * inset : rw.z1 - rw.dz * inset;
  const fx = fromStart ? rw.dx : -rw.dx, fz = fromStart ? rw.dz : -rw.dz;
  return { x: sx, z: sz, yaw: Math.atan2(-fx, -fz), fx, fz };
}

/** Driving surface height at (x,z): road deck if any, else terrain. */
export function surfaceY(game, x, z) {
  const th = game.terrain.heightAt(x, z);
  const n = game.roads?.nearest?.(x, z, 40);
  if (n && n.dist < n.edge.w * 0.5 + 1) return Math.max(th, n.y + 0.08);
  return th;
}

/** Nearest open water (terrain below `depth`) to (x,z) with a heading towards the longest open stretch. */
export function nearestWater(game, x, z, depth = -1.5, maxR = 4000, maxRun = 400) {
  const t = game.terrain;
  const wet = (px, pz, d = depth) => t.inBounds(px, pz, 2) ? t.heightAt(px, pz) < d : true;
  const open = (px, pz) => wet(px, pz) && wet(px + 8, pz) && wet(px - 8, pz) && wet(px, pz + 8) && wet(px, pz - 8);
  let found = open(x, z) ? { x, z } : null;
  for (let r = 16; !found && r <= maxR; r += 16) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / 16));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (open(px, pz)) { found = { x: px, z: pz }; break; }
    }
  }
  if (!found) return null;
  let bestA = 0, bestRun = -1;
  const step = maxRun > 600 ? 20 : 10;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const fx = Math.cos(a), fz = Math.sin(a);
    let run = 0;
    for (let s = step; s <= maxRun; s += step) { if (!wet(found.x + fx * s, found.z + fz * s, depth * 0.6)) break; run = s; }
    if (run > bestRun) { bestRun = run; bestA = a; }
  }
  const fx = Math.cos(bestA), fz = Math.sin(bestA);
  return { x: found.x, z: found.z, yaw: Math.atan2(-fx, -fz), run: bestRun };
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** Highest building top within r of (x,z) (0 if none). */
export function obstacleTop(game, x, z, r) {
  const B = game.buildings;
  if (!B?.query) return 0;
  let top = 0;
  for (const id of B.query(x, z, r + 60)) {
    const rec = B.recs?.[id];
    if (!rec) continue;
    if (Math.hypot(rec.cx - x, rec.cz - z) > r + 60) continue;
    top = Math.max(top, rec.top ?? (rec.base + rec.height));
  }
  return top;
}

/** True when no building footprint comes within r of (x,z). */
export function isClear(game, x, z, r) {
  const B = game.buildings;
  if (!B?.query) return true;
  for (const id of B.query(x, z, r + 80)) {
    const inf = B.info(id);
    if (!inf) continue;
    const fp = inf.footprint;
    let inside = false;
    for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
      const [xi, zi] = fp[i], [xj, zj] = fp[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      if (segDist(x, z, xi, zi, xj, zj) < r) return false;
    }
    if (inside) return false;
  }
  return true;
}

/** Nearest dry spot to (x,z) with no buildings within r (spiral search), or null. */
export function clearSpot(game, x, z, r, maxR = 300) {
  const t = game.terrain;
  const ok = (px, pz) => t.heightAt(px, pz) > 0.2 && isClear(game, px, pz, r);
  if (ok(x, z)) return { x, z };
  for (let rr = 8; rr <= maxR; rr += 8) {
    const n = Math.max(8, Math.round((2 * Math.PI * rr) / 10));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      if (ok(px, pz)) return { x: px, z: pz };
    }
  }
  return null;
}
