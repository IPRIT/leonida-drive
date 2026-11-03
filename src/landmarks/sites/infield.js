import { AIRCRAFT_SIZE } from './aircraft.js';
import { K, hull2d } from '../kit.js';
import { L as LK } from '../lights.js';
import { terrainMax } from './runways.js';

// Grass infield. The source map paints a whole airport as one flat paved area (plus darker bands around the
// runways); a real airfield is grass between the runways, taxiways and aprons. The terrain's ground classes
// (4 m texels; drawn by the terrain shader with organic, domain-warped borders and read by the vehicles for
// tyre grip) are switched to grass over the airfield: a flood fill from the runway axes over paved / road
// texels within `reach` of a runway. Kept paved: under the drawn runways (the border hides under the
// shoulders), under every visible road ribbon (taxiways keep asphalt grip), around buildings and landmark
// structures (hangar fronts) and under parked aircraft: each stand is an oriented rectangle, neighbouring stands
// share one apron, and an apron that does not touch a taxiway gets a straight taxilane to the nearest taxiway or
// runway (paved, yellow centreline, blue edge lights). No extra meshes (paint goes into the site's paint layer);
// the caller uploads the ground texture once.
export function* grassInfield(L, runways, { // generator: yields between phases (sliced build)
  reach = 520, ribbon = 0.6, deckIn = 3.5, bigArea = 2500, bigMargin = 40, smallMargin = 12, structMargin = 18,
  planeMargin = 20, lane = 11.5, cluster = null,
} = {}) {
  const t0 = performance.now();
  let skew = 0; // time spent paused at the yields
  const T = L.game.terrain, roads = L.game.roads, B = L.game.buildings;
  if (!T?.ground || !T.G || !runways?.length) return { changed: 0 };
  const G = T.G, ts = T.ts, tw = T.tw, th = T.th, ground = T.ground;
  // texel window around the runways
  let mx = Infinity, Mx = -Infinity, mz = Infinity, Mz = -Infinity;
  for (const r of runways) for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z1]]) { mx = Math.min(mx, x); Mx = Math.max(Mx, x); mz = Math.min(mz, z); Mz = Math.max(Mz, z); }
  const i0 = Math.max(0, Math.floor((mx - reach - T.x0) / ts)), i1 = Math.min(tw - 1, Math.ceil((Mx + reach - T.x0) / ts));
  const j0 = Math.max(0, Math.floor((mz - reach - T.z0) / ts)), j1 = Math.min(th - 1, Math.ceil((Mz + reach - T.z0) / ts));
  const W = i1 - i0 + 1, H = j1 - j0 + 1, N = W * H;
  if (W <= 0 || H <= 0) return { changed: 0 };
  const Tx0 = T.x0, Tz0 = T.z0;
  const X = (i) => Tx0 + (i0 + i + 0.5) * ts, Z = (j) => Tz0 + (j0 + j + 0.5) * ts;
  const state = new Uint8Array(N); // 1 = paved candidate within reach, 2 = flooded
  const keep = new Uint8Array(N);
  // runway / deck frames as flat arrays (tight loop over ~10^6 texels)
  const nr = runways.length, RW = new Float64Array(nr * 5);
  runways.forEach((r, q) => RW.set([r.x0, r.z0, r.dx, r.dz, r.len], q * 5));
  // decks of this airport only (their pavement keeps the texels under it)
  const decks = (L.runwayDecks || []).filter((d) => {
    const ex = d.x0 + d.dx * d.S[d.S.length - 1], ez = d.z0 + d.dz * d.S[d.S.length - 1];
    return Math.max(d.x0, ex) > mx - reach && Math.min(d.x0, ex) < Mx + reach && Math.max(d.z0, ez) > mz - reach && Math.min(d.z0, ez) < Mz + reach;
  });
  const nd = decks.length, DK = new Float64Array(nd * 7);
  decks.forEach((d, q) => DK.set([d.x0, d.z0, d.dx, d.dz, d.S[0], d.S[d.S.length - 1], d.ow - deckIn], q * 7));
  // paved / road texels, and the painted footprints of the source map (building class) inside the airfield
  const R2 = reach * reach, GP = G.paved, GR = G.road, GB = G.building ?? -1;
  // candidate test, evaluated lazily by the flood (only texels it reaches): paved / road ground within reach
  // of a runway; texels under the drawn runway pavement are kept (border hidden beneath the shoulders)
  // per 16x16-texel block: whole block within reach of one runway (capsules are convex: all four corners
  // inside is enough) / a deck may touch the block — most texels then skip the per-texel tests
  const BS = 16, BW = Math.ceil(W / BS), BH = Math.ceil(H / BS), blk = new Uint8Array(BW * BH);
  const bNear = new Uint8Array(BW * BH), bDeck = new Uint8Array(BW * BH);
  const inReach = (q, x, z) => {
    const ox = x - RW[q], oz = z - RW[q + 1];
    const u = ox * RW[q + 2] + oz * RW[q + 3], v = oz * RW[q + 2] - ox * RW[q + 3];
    const du = u < 0 ? u : u > RW[q + 4] ? u - RW[q + 4] : 0;
    return du * du + v * v < R2;
  };
  for (let bj = 0; bj < BH; bj++) {
    for (let bi = 0; bi < BW; bi++) {
      const xa = X(bi * BS), xb = X(Math.min(W - 1, bi * BS + BS - 1)), za = Z(bj * BS), zb = Z(Math.min(H - 1, bj * BS + BS - 1));
      for (let q = 0; q < nr * 5; q += 5) if (inReach(q, xa, za) && inReach(q, xb, za) && inReach(q, xa, zb) && inReach(q, xb, zb)) { bNear[bj * BW + bi] = 1; break; }
      const cx = (xa + xb) / 2, cz = (za + zb) / 2, rad = (BS * ts) * 0.72 + 1;
      for (let q = 0; q < nd * 7; q += 7) {
        const ox = cx - DK[q], oz = cz - DK[q + 1];
        const u = ox * DK[q + 2] + oz * DK[q + 3], v = oz * DK[q + 2] - ox * DK[q + 3];
        if (u > DK[q + 4] - rad && u < DK[q + 5] + rad && Math.abs(v) < DK[q + 6] + rad) { bDeck[bj * BW + bi] = 1; break; }
      }
    }
  }
  const accept = (k) => {
    const i = k % W, j = (k - i) / W;
    const g = ground[(j0 + j) * tw + i0 + i];
    if (g !== GP && g !== GR && g !== GB) return false;
    const x = X(i), z = Z(j), b = ((j / BS) | 0) * BW + ((i / BS) | 0);
    if (!bNear[b]) {
      let near = false;
      for (let q = 0; q < nr * 5; q += 5) if (inReach(q, x, z)) { near = true; break; }
      if (!near) return false;
    }
    if (bDeck[b]) for (let q = 0; q < nd * 7; q += 7) {
      const ox = x - DK[q], oz = z - DK[q + 1];
      const u = ox * DK[q + 2] + oz * DK[q + 3], v = oz * DK[q + 2] - ox * DK[q + 3];
      if (u >= DK[q + 4] && u <= DK[q + 5] && v < DK[q + 6] && v > -DK[q + 6]) { keep[k] = 1; break; }
    }
    return true;
  };
  const tA = performance.now();
  // flood from the runway axes (state: 0 unseen, 2 flooded, 3 rejected)
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  let fi0 = W, fi1 = -1, fj0 = H, fj1 = -1; // flooded window
  // blk: flooded 16x16-texel blocks; stamps over blocks without flooded texels are skipped
  const visit = (k) => {
    if (state[k] !== 0) return;
    if (!accept(k)) { state[k] = 3; return; }
    state[k] = 2; queue[qt++] = k;
    const i = k % W, j = (k - i) / W;
    if (i < fi0) fi0 = i; if (i > fi1) fi1 = i; if (j < fj0) fj0 = j; if (j > fj1) fj1 = j;
    blk[((j / BS) | 0) * BW + ((i / BS) | 0)] = 1;
  };
  const anyBlk = (ia, ib, ja, jb) => {
    for (let bj = (ja / BS) | 0, bj1 = (jb / BS) | 0; bj <= bj1; bj++) for (let bi = (ia / BS) | 0, bi1 = (ib / BS) | 0; bi <= bi1; bi++) if (blk[bj * BW + bi]) return true;
    return false;
  };
  for (const r of runways) {
    for (let u = 0; u <= r.len; u += ts / 2) {
      const i = Math.floor((r.x0 + r.dx * u - T.x0) / ts) - i0, j = Math.floor((r.z0 + r.dz * u - T.z0) / ts) - j0;
      if (i >= 0 && j >= 0 && i < W && j < H) visit(j * W + i);
    }
  }
  while (qh < qt) {
    const k = queue[qh++], i = k % W;
    if (i > 0) visit(k - 1);
    if (i < W - 1) visit(k + 1);
    if (k >= W) visit(k - W);
    if (k < N - W) visit(k + W);
  }
  const tB = performance.now();
  yield;
  const tB_ = performance.now(); skew += tB_ - tB;
  // ---------- keep-paved stamps ----------
  if (qt === 0) return { changed: 0, flooded: 0 };
  const span = (a, b) => [Math.max(fi0, Math.floor((a - T.x0) / ts) - i0), Math.min(fi1, Math.floor((b - T.x0) / ts) - i0)];
  const spanZ = (a, b) => [Math.max(fj0, Math.floor((a - T.z0) / ts) - j0), Math.min(fj1, Math.floor((b - T.z0) / ts) - j0)];
  // stamps only matter inside the flooded window
  const x0w = T.x0 + (i0 + fi0) * ts, z0w = T.z0 + (j0 + fj0) * ts, x1w = T.x0 + (i0 + fi1 + 1) * ts, z1w = T.z0 + (j0 + fj1 + 1) * ts;
  const stampRect = (ax, az, bx, bz, test) => {
    if (bx < x0w || ax > x1w || bz < z0w || az > z1w) return;
    const [ia, ib] = span(ax, bx), [ja, jb] = spanZ(az, bz);
    if (ia > ib || ja > jb || !anyBlk(ia, ib, ja, jb)) return;
    for (let j = ja; j <= jb; j++) {
      const z = Z(j);
      for (let i = ia; i <= ib; i++) { const k = j * W + i; if (state[k] === 2 && !keep[k] && test(X(i), z)) keep[k] = 1; }
    }
  };
  const segD2 = (x, z, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t - x, pz = az + dz * t - z;
    return px * px + pz * pz;
  };
  // visible road ribbons (taxiways, service roads): asphalt under them. Segments from the roads' own grid
  // (64 m cells -> [edge, segment] pairs) over the window; a segment listed in several cells is stamped again
  // (idempotent).
  if (roads?.grid && roads.edges) {
    const c = roads.cell || 64, E = roads.edges, hidden = L.hidden;
    for (let ci = Math.floor(x0w / c); ci <= Math.floor(x1w / c); ci++) {
      for (let cj = Math.floor(z0w / c); cj <= Math.floor(z1w / c); cj++) {
        const l = roads.grid.get(ci * 100003 + cj);
        if (!l) continue;
        // this cell's texels (each segment is stamped only inside the cell that lists it: no repeats)
        const ci0 = Math.max(fi0, Math.floor((ci * c - T.x0) / ts) - i0), ci1 = Math.min(fi1, Math.floor(((ci + 1) * c - T.x0) / ts) - i0 - 1);
        const cj0 = Math.max(fj0, Math.floor((cj * c - T.z0) / ts) - j0), cj1 = Math.min(fj1, Math.floor(((cj + 1) * c - T.z0) / ts) - j0 - 1);
        if (ci0 > ci1 || cj0 > cj1 || !anyBlk(ci0, ci1, cj0, cj1)) continue;
        for (let q = 0; q < l.length; q += 2) {
          if (hidden?.has(l[q])) continue;
          const e = E[l[q]], k = l[q + 1], P = e.pts;
          const ax = P[2 * k], az = P[2 * k + 1], bx = P[2 * k + 2], bz = P[2 * k + 3];
          const r = (e.wp ? Math.max(e.wp[k], e.wp[k + 1]) : e.w) / 2 + ribbon, r2 = r * r;
          // the grid lists a segment by its end points only: let the ribbon reach r into the neighbour cells
          const pad = Math.ceil(r / ts);
          const ia = Math.max(ci0 - pad, fi0, Math.floor((Math.min(ax, bx) - r - T.x0) / ts) - i0), ib = Math.min(ci1 + pad, fi1, Math.floor((Math.max(ax, bx) + r - T.x0) / ts) - i0);
          const ja = Math.max(cj0 - pad, fj0, Math.floor((Math.min(az, bz) - r - T.z0) / ts) - j0), jb = Math.min(cj1 + pad, fj1, Math.floor((Math.max(az, bz) + r - T.z0) / ts) - j0);
          if (ia > ib || ja > jb || !anyBlk(ia, ib, ja, jb)) continue;
          const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
          for (let j = ja; j <= jb; j++) {
            const z = Tz0 + (j0 + j + 0.5) * ts;
            for (let i = ia; i <= ib; i++) {
              const kk = j * W + i;
              if (state[kk] !== 2 || keep[kk]) continue;
              const x = Tx0 + (i0 + i + 0.5) * ts;
              let t = ((x - ax) * dx + (z - az) * dz) / L2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const px = ax + dx * t - x, pz = az + dz * t - z;
              if (px * px + pz * pz <= r2) keep[kk] = 1;
            }
          }
        }
      }
    }
  }
  const tC = performance.now();
  // building footprints: aprons in front of big buildings (terminals, hangars), a margin around small ones
  if (B?.query) {
    const cx = (x0w + x1w) / 2, cz = (z0w + z1w) / 2;
    for (const id of B.query(cx, cz, Math.hypot(x1w - x0w, z1w - z0w) / 2 + 50)) {
      const p = B.list[id].p, n = p.length / 2;
      let area = 0, ax = Infinity, az = Infinity, bx = -Infinity, bz = -Infinity;
      for (let q = 0; q < n; q++) {
        const x = p[2 * q], z = p[2 * q + 1], x2 = p[2 * ((q + 1) % n)], z2 = p[2 * ((q + 1) % n) + 1];
        area += x * z2 - x2 * z;
        ax = Math.min(ax, x); az = Math.min(az, z); bx = Math.max(bx, x); bz = Math.max(bz, z);
      }
      const m = Math.abs(area) / 2 > bigArea ? bigMargin : smallMargin, m2 = m * m;
      stampRect(ax - m, az - m, bx + m, bz + m, (x, z) => {
        let c = false, d2 = Infinity;
        for (let q = 0, w = n - 1; q < n; w = q++) {
          const xi = p[2 * q], zi = p[2 * q + 1], xj = p[2 * w], zj = p[2 * w + 1];
          if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
          d2 = Math.min(d2, segD2(x, z, xi, zi, xj, zj));
        }
        return c || d2 <= m2;
      });
    }
  }
  const tD = performance.now();
  yield;
  const tD_ = performance.now(); skew += tD_ - tD;
  // landmark structures (terminals, concourses, hangars, tanks, tower...): their colliders + a margin
  for (const it of L.colliders?.items || []) {
    if (typeof it.tag === 'string' && it.tag.endsWith(':runway')) continue;
    // big structures (terminals, concourses, hangars) stand on a wide apron
    const m = it.reach > 25 ? bigMargin : structMargin;
    if (it.shape === 0) {
      if (Math.min(it.a, it.c) < 1.5 || it.b < 1.5) continue; // fences, kerbs, thin parts
      const yaw = 2 * Math.atan2(it.q.y, it.q.w), c = Math.cos(yaw), s = Math.sin(yaw), R = it.reach + m;
      stampRect(it.x - R, it.z - R, it.x + R, it.z + R, (x, z) => {
        const dx = x - it.x, dz = z - it.z;
        return Math.abs(c * dx - s * dz) <= it.a + m && Math.abs(s * dx + c * dz) <= it.c + m;
      });
    } else {
      const r = it.shape === 1 ? it.a : it.reach * 0.8;
      if (r < 3 || r > 60) continue; // masts / posts; long slabs
      const R = r + m, R2 = R * R;
      stampRect(it.x - R, it.z - R, it.x + R, it.z + R, (x, z) => (x - it.x) ** 2 + (z - it.z) ** 2 <= R2);
    }
  }
  const tE = performance.now();
  // ---------- aprons under parked aircraft ----------
  const insideConvex = (P, x, z) => {
    let sg = 0;
    for (let q = 0, n = P.length; q < n; q++) {
      const [ax, az] = P[q], [bx, bz] = P[(q + 1) % n];
      const c = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      if (c > 1e-9) { if (sg < 0) return false; sg = 1; } else if (c < -1e-9) { if (sg > 0) return false; sg = -1; }
    }
    return true;
  };
  const stampPoly = (P) => {
    let ax = Infinity, az = Infinity, bx = -Infinity, bz = -Infinity;
    for (const [x, z] of P) { ax = Math.min(ax, x); az = Math.min(az, z); bx = Math.max(bx, x); bz = Math.max(bz, z); }
    stampRect(ax, az, bx, bz, (x, z) => insideConvex(P, x, z));
  };
  const planes = [];
  for (const t of L.instTypes?.values() || []) {
    const size = AIRCRAFT_SIZE[t.type.key];
    if (!size) continue;
    for (const [x, y, z, yaw, , sc = 1] of t.list) {
      if (x < x0w - 60 || x > x1w + 60 || z < z0w - 60 || z > z1w + 60) continue; // another airport
      // fuselage along local z (instance yaw about +Y): local (lx, lz) -> (x + c lx + s lz, z - s lx + c lz)
      const p = { x, y, z, c: Math.cos(yaw), s: Math.sin(yaw), hx: (size[1] / 2) * sc + planeMargin * 0.7, hz: (size[0] / 2) * sc + planeMargin };
      p.r = Math.hypot(p.hx, p.hz);
      p.k = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [x + p.c * a * p.hx + p.s * b * p.hz, z - p.s * a * p.hx + p.c * b * p.hz]);
      planes.push(p);
    }
  }
  // parked real models standing on the ground (catalog planes, apron vehicles): the same oriented aprons
  for (const v of L.vehicles || []) {
    const m = v.m;
    if (m.kind === 'boat' || v.x < x0w - 60 || v.x > x1w + 60 || v.z < z0w - 60 || v.z > z1w + 60) continue;
    if (Math.abs(v.y - T.heightAt(v.x, v.z)) > 1.5) continue; // on a roof / deck
    const air = m.kind === 'plane' || m.kind === 'heli';
    const c = Math.cos(v.yaw), sn = Math.sin(v.yaw);
    const ox = v.x + c * m.cx + sn * m.cz, oz = v.z - sn * m.cx + c * m.cz;
    const p = { x: ox, y: v.y, z: oz, c, s: sn, hx: m.wid / 2 + (air ? planeMargin * 0.6 : 2), hz: m.len / 2 + (air ? planeMargin * 0.8 : 2.5) };
    p.r = Math.hypot(p.hx, p.hz);
    p.k = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [ox + c * a * p.hx + sn * b * p.hz, oz - sn * a * p.hx + c * b * p.hz]);
    planes.push(p);
  }
  for (const p of planes) stampPoly(p.k);
  const apronPolys = (L.apronPolys ||= []);
  for (const p of planes) apronPolys.push(p.k);
  // neighbouring stands share one apron (hull of each close pair); groups by union-find
  const up = planes.map((_, q) => q);
  const find = (q) => { while (up[q] !== q) q = up[q] = up[up[q]]; return q; };
  for (let a = 0; a < planes.length; a++) {
    for (let b = a + 1; b < planes.length; b++) {
      const A = planes[a], Bp = planes[b];
      if (Math.hypot(A.x - Bp.x, A.z - Bp.z) > A.r + Bp.r) continue;
      const hp = hull2d(A.k.concat(Bp.k));
      stampPoly(hp);
      apronPolys.push(hp);
      up[find(a)] = find(b);
    }
  }
  // taxilanes: an apron group away from every taxiway gets a straight paved lane to the nearest taxiway / runway
  const groups = new Map();
  planes.forEach((p, q) => { const g = find(q); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); });
  let lanes = 0;
  const hidden = L.hidden;
  const yAt = (x, z) => terrainMax(T, x, z, 5) + 0.02;
  for (const list of groups.values()) {
    let best = null;
    for (const p of list) {
      const n = roads?.nearest?.(p.x, p.z, 260, (e) => e.airside && !hidden?.has(e.i));
      if (n) {
        const gap = n.dist - (n.edge.wp ? n.edge.wp[n.seg] : n.edge.w) / 2 - p.r * 0.7;
        if (!best || gap < best.gap) best = { gap, p, tx: n.x, tz: n.z };
      }
      for (const d of decks) {
        const u = (p.x - d.x0) * d.dx + (p.z - d.z0) * d.dz, v = (p.x - d.x0) * -d.dz + (p.z - d.z0) * d.dx;
        const uc = Math.max(d.S[0] + 20, Math.min(d.S[d.S.length - 1] - 20, u)), hw = d.ow - 7.5;
        const vc = Math.sign(v) * Math.max(0, hw - 2);
        const tx = d.x0 + d.dx * uc - d.dz * vc, tz = d.z0 + d.dz * uc + d.dx * vc;
        const gap = Math.hypot(p.x - tx, p.z - tz) - p.r * 0.7;
        if (!best || gap < best.gap) best = { gap, p, tx, tz };
      }
    }
    if (!best || best.gap < 12 || best.gap > 260) continue;
    const { p, tx, tz } = best;
    const ax = p.x, az = p.z, r2 = lane * lane;
    stampRect(Math.min(ax, tx) - lane, Math.min(az, tz) - lane, Math.max(ax, tx) + lane, Math.max(az, tz) + lane, (x, z) => segD2(x, z, ax, az, tx, tz) <= r2);
    lanes++;
    { const l = Math.hypot(tx - ax, tz - az) || 1, nx = -(tz - az) / l * lane, nz = (tx - ax) / l * lane; apronPolys.push([[ax + nx, az + nz], [tx + nx, tz + nz], [tx - nx, tz - nz], [ax - nx, az - nz]]); }
    // yellow centreline from the apron edge to the taxiway / runway, blue edge lights
    const len = Math.hypot(tx - ax, tz - az), ux = (tx - ax) / len, uz = (tz - az) / len;
    const s0 = Math.min(len - 5, p.r * 0.6);
    if (cluster?.paint) {
      cluster.paint.lod = 0;
      cluster.paint.paint(0xf2c200, K.PAINT);
      cluster.paint.ribbon([[ax + ux * s0, az + uz * s0], [tx, tz]], 0.35, yAt, 0.04);
    }
    for (let sd = s0 + 15; sd < len - 25; sd += 30) {
      for (const side of [-1, 1]) {
        const lx = ax + ux * sd - uz * side * (lane + 0.8), lz = az + uz * sd + ux * side * (lane + 0.8);
        if (L.roadHit(lx, lz, 0.3) >= 0) continue;
        L.lights.add(lx, yAt(lx, lz) + 0.3, lz, 0x3a6bff, 0.55, LK.STEADY, 0, 2600);
      }
    }
  }
  const tF = performance.now();
  yield;
  const tF_ = performance.now(); skew += tF_ - tF;
  // ---------- convert ----------
  let changed = 0, flooded = 0;
  for (let j = fj0; j <= fj1; j++) {
    for (let i = fi0; i <= fi1; i++) {
      const k = j * W + i;
      if (state[k] !== 2) continue;
      flooded++;
      if (keep[k]) continue;
      ground[(j0 + j) * tw + i0 + i] = G.grass;
      changed++;
    }
  }
  // specks the source map leaves inside the airfield (small urban / dirt / footprint islands enclosed by the
  // flooded area) become grass too
  const GG = G.grass, isSpeck = (g) => g === G.urban || g === G.dirt || g === G.building;
  const comp = new Int32Array(256);
  for (let j = Math.max(1, fj0); j <= Math.min(H - 2, fj1); j++) {
    for (let i = Math.max(1, fi0); i <= Math.min(W - 2, fi1); i++) {
      const k0 = j * W + i;
      if (state[k0] !== 0 && state[k0] !== 3) continue;
      // islands start next to the flooded area
      if (state[k0 - 1] !== 2 && state[k0 + 1] !== 2 && state[k0 - W] !== 2 && state[k0 + W] !== 2) continue;
      if (!isSpeck(ground[(j0 + j) * tw + i0 + i])) continue;
      // flood the island (max 256 texels); enclosed when every outside neighbour is flooded
      let n = 0, h = 0, enclosed = true, kept = 0, open = 0;
      comp[n++] = k0; state[k0] = 4;
      while (h < n && enclosed) {
        const k = comp[h++], ci = k % W, cj = (k - ci) / W;
        for (let d = 0; d < 4; d++) {
          const qi = d === 0 ? ci - 1 : d === 1 ? ci + 1 : ci, qj = d === 2 ? cj - 1 : d === 3 ? cj + 1 : cj;
          if (qi < 1 || qj < 1 || qi > W - 2 || qj > H - 2) { enclosed = false; break; }
          const q = qj * W + qi;
          if (state[q] === 2) { if (keep[q]) kept++; else open++; continue; }
          if (state[q] === 4) continue;
          if (state[q] === 5 || n >= 256 || !isSpeck(ground[(j0 + qj) * tw + i0 + qi])) { enclosed = false; break; }
          state[q] = 4; comp[n++] = q;
        }
      }
      if (!enclosed) { for (let q = 0; q < n; q++) state[comp[q]] = 5; continue; } // part of an open region
      // inside an apron it becomes apron, in the grass it becomes grass
      const to = kept > open ? G.paved : GG;
      for (let q = 0; q < n; q++) { const k = comp[q], ci = k % W, cj = (k - ci) / W; ground[(j0 + cj) * tw + i0 + ci] = to; changed++; }
    }
  }
  const f = (a, b) => +(b - a).toFixed(1);
  return { changed, flooded, aprons: groups.size, lanes, ms: f(t0, performance.now() - skew), phases: { scan: f(t0, tA), flood: f(tA, tB), ribbons: f(tB_, tC), buildings: f(tC, tD), structures: f(tD_, tE), aprons: f(tE, tF), convert: f(tF_, performance.now()) } };
}

// Airside of an airport: flood from the runway axes over paved / road ground texels within `reach` (the same
// rule as the grass infield, without crossing building footprints). has(x, z) -> true on the airfield.
export function airsideMask(L, runways, { reach = 520 } = {}) {
  const T = L.game.terrain;
  if (!T?.ground || !T.G || !runways?.length) return { has: () => false };
  const G = T.G, ts = T.ts, tw = T.tw, th = T.th, ground = T.ground;
  let mx = Infinity, Mx = -Infinity, mz = Infinity, Mz = -Infinity;
  for (const r of runways) for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z1]]) { mx = Math.min(mx, x); Mx = Math.max(Mx, x); mz = Math.min(mz, z); Mz = Math.max(Mz, z); }
  const i0 = Math.max(0, Math.floor((mx - reach - T.x0) / ts)), i1 = Math.min(tw - 1, Math.ceil((Mx + reach - T.x0) / ts));
  const j0 = Math.max(0, Math.floor((mz - reach - T.z0) / ts)), j1 = Math.min(th - 1, Math.ceil((Mz + reach - T.z0) / ts));
  const W = i1 - i0 + 1, H = j1 - j0 + 1, N = W * H;
  const state = new Uint8Array(N), queue = new Int32Array(N);
  const R2 = reach * reach;
  const nr = runways.length, RW = new Float64Array(nr * 5);
  runways.forEach((r, q) => RW.set([r.x0, r.z0, r.dx, r.dz, r.len], q * 5));
  const near = (x, z) => {
    for (let q = 0; q < nr * 5; q += 5) {
      const ox = x - RW[q], oz = z - RW[q + 1];
      const u = ox * RW[q + 2] + oz * RW[q + 3], v = oz * RW[q + 2] - ox * RW[q + 3];
      const du = u < 0 ? u : u > RW[q + 4] ? u - RW[q + 4] : 0;
      if (du * du + v * v < R2) return true;
    }
    return false;
  };
  let qh = 0, qt = 0;
  const visit = (k) => {
    if (state[k]) return;
    const i = k % W, j = (k - i) / W, g = ground[(j0 + j) * tw + i0 + i];
    if ((g !== G.paved && g !== G.road) || !near(T.x0 + (i0 + i + 0.5) * ts, T.z0 + (j0 + j + 0.5) * ts)) { state[k] = 3; return; }
    state[k] = 2; queue[qt++] = k;
  };
  for (const r of runways) for (let u = 0; u <= r.len; u += ts / 2) {
    const i = Math.floor((r.x0 + r.dx * u - T.x0) / ts) - i0, j = Math.floor((r.z0 + r.dz * u - T.z0) / ts) - j0;
    if (i >= 0 && j >= 0 && i < W && j < H) visit(j * W + i);
  }
  while (qh < qt) {
    const k = queue[qh++], i = k % W;
    if (i > 0) visit(k - 1);
    if (i < W - 1) visit(k + 1);
    if (k >= W) visit(k - W);
    if (k < N - W) visit(k + W);
  }
  return {
    has(x, z) {
      const i = Math.floor((x - T.x0) / ts) - i0, j = Math.floor((z - T.z0) / ts) - j0;
      return i >= 0 && j >= 0 && i < W && j < H && state[j * W + i] === 2;
    },
  };
}
