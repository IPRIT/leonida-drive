import * as THREE from 'three';
import { FONT } from '../atlas.js';
import { runwayNumber } from './airfield.js';

// Clean runways: every runway is an exact rectangle on its fitted axis (Roads.findRunways), constant width,
// 7.5 m shoulders, blast pads with chevrons, procedural markings (runwayMaterial), a smooth longitudinal
// profile that never dips below the ground or a taxiway joining it, and flat continuous colliders (convex
// slabs per 25 m). The road-graph ribbons of runway edges and of the source map's stray runway-wide pieces are
// skipped (Roads hooks, see airside.js), so nothing wobbly is drawn underneath; the edges stay in the graph
// (airside routing, plane spawns). The grass around the runways is the terrain itself (sites/infield.js).

const SHOULDER = 7.5, PAD = 60, STEP = 25, RAMP = 14, SKIRT = 5;

// highest terrain grid height within r of (x,z). The terrain mesh is displaced on the GPU from its exact 8 m
// grid heights, so a surface laid over it must clear every grid vertex under it, not just heightAt samples.
export function terrainMax(terrain, x, z, r) {
  const { x0, z0, hs, gw, gh, h } = terrain;
  const W = gw + 1;
  const i0 = Math.max(0, Math.floor((x - r - x0) / hs)), i1 = Math.min(gw, Math.ceil((x + r - x0) / hs));
  const j0 = Math.max(0, Math.floor((z - r - z0) / hs)), j1 = Math.min(gh, Math.ceil((z + r - z0) / hs));
  let m = -Infinity;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const v = h[j * W + i]; if (v > m) m = v; }
  return m === -Infinity ? terrain.heightAt(x, z) : m;
}

export class RunwayMesh {
  constructor() { this.pos = []; this.rw = []; this.na = []; this.nb = []; this.idx = []; this.count = 0; }
  geometry() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(this.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((this.pos.length / 3) * 2), 2));
    g.setAttribute('aRw', new THREE.Float32BufferAttribute(this.rw, 4));
    g.setAttribute('aNumA', new THREE.Float32BufferAttribute(this.na, 4));
    g.setAttribute('aNumB', new THREE.Float32BufferAttribute(this.nb, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// Runways as drawn: copies of the fitted rectangles, extended over hidden runway-wide road pieces that continue
// them straight past an end (the source map's runway runs on, e.g. beyond a crossing). A shorter straight stub
// past an end becomes a longer blast pad instead. Adds padA / padB (pad length at the x0 / x1 end).
export function drawnRunways(ctx, runways) {
  const E = ctx.roads?.edges || [], hidden = ctx.L.hidden || new Set();
  return runways.map((r) => {
    const over = [[], []];
    for (const i of hidden) {
      const e = E[i];
      if (!e || e.w < 30) continue; // the runway edge itself too: it may run on past the fitted rectangle
      for (let k = 0; k < e.n; k++) {
        const x = e.pts[2 * k], z = e.pts[2 * k + 1];
        const u = (x - r.x0) * r.dx + (z - r.z0) * r.dz, v = Math.abs((x - r.x0) * -r.dz + (z - r.z0) * r.dx);
        if (v > r.w / 2 + 8) continue;
        if (u < 0 && u > -400) over[0].push(-u);
        else if (u > r.len && u < r.len + 400) over[1].push(u - r.len);
      }
    }
    // contiguous overshoot from the end (points every few metres; a gap > 80 m ends it — a crossing runway
    // between the end and the continuation leaves a gap of about its width)
    const reach = (l) => { l.sort((a, b) => a - b); let m = 0; for (const o of l) { if (o - m > 80) break; m = o; } return m; };
    const eA = reach(over[0]), eB = reach(over[1]);
    const out = { ...r, padA: PAD, padB: PAD };
    if (eA >= 150) { out.x0 -= r.dx * eA; out.z0 -= r.dz * eA; out.len += eA; } else if (eA > 0) out.padA = Math.min(160, Math.max(PAD, eA + 10));
    if (eB >= 150) { out.x1 += r.dx * eB; out.z1 += r.dz * eB; out.len += eB; } else if (eB > 0) out.padB = Math.min(160, Math.max(PAD, eB + 10));
    out.cx = (out.x0 + out.x1) / 2; out.cz = (out.z0 + out.z1) / 2;
    return out;
  });
}

// rw: {x0, z0, x1, z1, dx, dz, len, w, padA?, padB?}; primary: runways drawn on top of this one (crossings)
export function runwaySurface(ctx, rw, { primary = [], pads = true, minY = -Infinity } = {}) {
  const { atlas } = ctx;
  const M = ctx.L.runwayMesh;
  const hw = rw.w / 2, ow = hw + SHOULDER;
  const rx = -rw.dz, rz = rw.dx; // right of A->B
  const P = (s, t) => [rw.x0 + rw.dx * s + rx * t, rw.z0 + rw.dz * s + rz * t];
  // blast pads only over dry ground
  const padLen = (dir) => {
    if (!pads) return 0;
    const max = dir < 0 ? rw.padA ?? PAD : rw.padB ?? PAD;
    let l = 0;
    for (let d = 10; d <= max; d += 10) {
      const s = dir < 0 ? -d : rw.len + d;
      if ([-hw, 0, hw].some((t) => { const [x, z] = P(s, t); return ctx.groundY(x, z) < 0.25; })) break;
      l = d;
    }
    return l;
  };
  const s0 = -padLen(-1), s1 = rw.len + padLen(1);
  // stations along the runway; heights: highest ground / old deck across the full width + lift, smoothed
  // small strips sit on hillsides: shorter stations follow the ground closer
  const step = rw.strip ? 10 : STEP;
  const S = [];
  for (let s = s0; s < s1 - 1e-3; s += step) S.push(s);
  S.push(s1);
  // every road ribbon / junction cap under the pavement (taxiways joining the ends or crossing the pads) stays
  // below it: sampled at the station and halfway to both neighbours, across the full paved width. Per lateral
  // sample t: the height the surface must reach there
  const TS = [-ow, -hw, -hw / 2, 0, hw / 2, hw, ow];
  const needT = S.map((s) => TS.map((t) => {
    const [x, z] = P(s, t);
    let h = Math.max(minY, terrainMax(ctx.terrain, x, z, step / 2 + 2) + 0.07);
    for (const ds of [-step / 2, 0, step / 2]) {
      const [qx, qz] = P(s + ds, t);
      h = Math.max(h, ctx.roadTop(qx, qz, 1) + 0.13);
    }
    return h;
  }));
  // cross slope (bank, m per m of t): follows a side slope up to 1.5 % (runways) / 8 % (strips) so the slab
  // does not stand metres proud of the downhill side; the centre height then clears every lateral sample
  const maxBank = rw.strip ? 0.08 : 0.015;
  let B = needT.map((n) => Math.max(-maxBank, Math.min(maxBank, (n[6] - n[0]) / (2 * ow))));
  for (let it = 0; it < 3; it++) B = B.map((b, i) => (B[Math.max(0, i - 1)] + 2 * b + B[Math.min(B.length - 1, i + 1)]) / 4);
  const need = needT.map((n, i) => Math.max(...n.map((h, q) => h - B[i] * TS[q])));
  // smooth (max-preserving): moving average, then lift to the requirement, repeated
  let Y = need.slice();
  for (let it = 0; it < 4; it++) {
    Y = Y.map((y, i) => (Y[Math.max(0, i - 1)] + 2 * y + Y[Math.min(Y.length - 1, i + 1)]) / 4);
    Y = Y.map((y, i) => Math.max(y, need[i]));
  }
  const yAt = (i, t) => Y[i] + B[i] * t; // surface height at station i, lateral t
  // crossing runways: slices fully inside a primary runway are dropped; partly covered ones stay, a few cm
  // lower than the primary so it is drawn on top
  const inPrim = (x, z) => primary.some((p) => {
    const u = (x - p.x0) * p.dx + (z - p.z0) * p.dz, v = (x - p.x0) * -p.dz + (z - p.z0) * p.dx;
    return u > -1 && u < p.len + 1 && Math.abs(v) < p.w / 2 + SHOULDER;
  });
  const cover = (i) => { let c = 0; for (const s of [S[i], S[i + 1]]) for (const t of [-ow, ow]) { const [x, z] = P(s, t); if (inPrim(x, z)) c++; } return c; };
  const covered = S.slice(0, -1).map((_, i) => cover(i));
  const insidePrimary = (sMid) => { const i = S.findIndex((s, k) => k < S.length - 1 && sMid >= s && sMid <= S[k + 1]); return i >= 0 && covered[i] === 4; };
  covered.forEach((c, i) => { if (c > 0 && c < 4) { Y[i] -= 0.06; Y[i + 1] -= 0.06; } });
  // no trees on the pavement or its shoulders (100 m chunks keep each vegetation query small)
  for (let i = 0; i < S.length - 1; i += 4) {
    const a = S[i] - 5, b = S[Math.min(S.length - 1, i + 4)] + 5, t = ow + 6;
    ctx.hideTrees({ poly: [P(a, -t), P(b, -t), P(b, t), P(a, t)] });
  }
  // furniture (edge / centreline / threshold lights) sits on this pavement: Landmarks.deckAt()
  const deck = { x0: rw.x0, z0: rw.z0, dx: rw.dx, dz: rw.dz, ow, S, Y, B, len: rw.len, w: rw.w, airport: rw.airport || ctx.site.name, numA: runwayNumber(rw.dx, rw.dz), numB: runwayNumber(-rw.dx, -rw.dz), site: ctx.site.id, ends: [], skirts: 0 };
  ctx.L.runwayDecks.push(deck);
  // designators (atlas cells shared with the old painted numbers)
  const numA = runwayNumber(rw.dx, rw.dz), numB = runwayNumber(-rw.dx, -rw.dz);
  const cell = (n) => atlas.text(`rw${n}`, n, { w: 160, h: 128, font: FONT.mono, fg: '#f4f4f4', bg: '#2f3034', size: 120 });
  const ca = cell(numA), cb = cell(numB);
  const rectA = [ca.u0, ca.v0, ca.u1, ca.v1], rectB = [cb.u0, cb.v0, cb.u1, cb.v1];
  const T = [-ow, -hw, hw, ow];
  const base = M.count;
  S.forEach((s, i) => {
    for (const t of T) {
      const [x, z] = P(s, t);
      M.pos.push(x, yAt(i, t), z);
      M.rw.push(s, t, rw.len, hw);
      M.na.push(...rectA); M.nb.push(...rectB);
    }
  });
  M.count += S.length * 4;
  for (let i = 0; i < S.length - 1; i++) {
    if (insidePrimary((S[i] + S[i + 1]) / 2)) continue;
    for (let j = 0; j < 3; j++) {
      const a = base + i * 4 + j, b = a + 1, c = a + 4, d = a + 5;
      // counter-clockwise seen from above: (a, c, b), (b, c, d) — right (+t) is x right / z down in A->B frame
      M.idx.push(a, b, c, b, d, c);
    }
  }
  // colliders: convex slab per slice, top = the drawn surface (continuous, no steps)
  for (let i = 0; i < S.length - 1; i++) {
    if (insidePrimary((S[i] + S[i + 1]) / 2)) continue;
    const pts = [];
    for (const [k, s] of [[i, S[i]], [i + 1, S[i + 1]]]) for (const t of [-ow, ow]) {
      const [x, z] = P(s, t);
      pts.push(x, yAt(k, t), z, x, yAt(k, t) - 1.2, z);
    }
    ctx.colliders.hull(pts, `${ctx.site.id}:runway`);
  }
  // no vertical edges: the slab stands up to ~0.4 m proud of the ground, so its ends ramp down over RAMP m and
  // its long sides over a SKIRT m bevel to just above the terrain (drawn and collided; a car leaving the
  // runway at speed, or driving onto it off the grass, rolls over instead of hitting a kerb)
  const gnd = (x, z) => ctx.terrain.heightAt(x, z) + 0.05; // bevel feet meet the ground (grid max overshoots on slopes)
  const row = (pts) => { // [[x, y, z, s, t], ...] -> first index
    const b0 = M.count;
    for (const [x, y, z, s, t] of pts) { M.pos.push(x, y, z); M.rw.push(s, t, rw.len, hw); M.na.push(...rectA); M.nb.push(...rectB); }
    M.count += pts.length;
    return b0;
  };
  const quad = (a, b, c, d) => { // a-b near edge, c-d far edge (same direction); both windings: seen from above
    M.idx.push(a, b, c, b, d, c, a, c, b, b, c, d);
  };
  const hullOf = (P4) => { const pts = []; for (const [x, y, z] of P4) pts.push(x, y, z, x, Math.min(y, P4.reduce((m, q) => Math.min(m, q[1]), Infinity)) - 1.2, z); ctx.colliders.hull(pts, `${ctx.site.id}:runway`); };
  const rampsBuilt = [];
  for (const [k, dir] of [[0, -1], [S.length - 1, 1]]) {
    const se = S[k];
    // ramp length: ~4 % for small steps, 10-30 m
    const at = (L0) => T.map((t) => { const [x, z] = P(se + dir * L0, t); return [x, gnd(x, z), z, se + dir * L0, t]; });
    const drop0 = Math.max(...at(RAMP).map((f) => yAt(k, f[4]) - f[1]));
    const len = Math.max(10, Math.min(30, drop0 * 25)), sr = se + dir * len;
    const far = at(len);
    const cx = P(sr, 0);
    const why = inPrim(cx[0], cx[1]) ? 'runway' : far.some(([x, , z]) => ctx.groundY(x, z) < 0.25) ? 'water' : far.every(([, y, , , t]) => y >= yAt(k, t) - 0.02) ? 'level' : null;
    if (why) { deck.ends.push({ s: se, why }); continue; }
    deck.ends.push({ s: se, ramp: +len.toFixed(1), drop: +drop0.toFixed(2) });
    rampsBuilt.push({ k, sr });
    const near = T.map((t) => { const [x, z] = P(se, t); return [x, yAt(k, t), z, se, t]; });
    const a = row(near), b = row(far);
    for (let j = 0; j < 3; j++) quad(a + j, a + j + 1, b + j, b + j + 1);
    ctx.hideTrees({ poly: [P(se, -ow - 6), P(sr + dir * 5, -ow - 6), P(sr + dir * 5, ow + 6), P(se, ow + 6)] });
    hullOf([...near, ...far]);
  }
  // bevel width per station and side (shared by neighbouring slices, so the bevel has no gaps): ~10 % slope for
  // the step at the edge, 3-30 m (embankments over gullies)
  // foot of the bevel: the first point outwards where the ground meets a 10 % slope down from the slab edge
  // (a ditch beside the strip ends under the bevel, rising ground ends it early)
  const SW = [-1, 1].map((sd) => S.map((s, i) => {
    const ye = yAt(i, sd * ow);
    for (let d = 3; d <= 30; d += 1) { const [x, z] = P(s, sd * (ow + d)); if (gnd(x, z) >= ye - 0.1 * d) return d; }
    return 30;
  }));
  const outerAt = (i, sd) => { const t = sd * (ow + SW[sd > 0 ? 1 : 0][i]), [x, z] = P(S[i], t); return [x, gnd(x, z), z, S[i], t]; };
  for (let i = 0; i < S.length - 1; i++) {
    if (covered[i] > 0) continue;
    for (const sd of [-1, 1]) {
      const inner = [i, i + 1].map((k) => { const [x, z] = P(S[k], sd * ow); return [x, yAt(k, sd * ow), z, S[k], sd * ow]; });
      const outer = [outerAt(i, sd), outerAt(i + 1, sd)];
      if (outer.every(([, y], q) => y >= inner[q][1] - 0.02)) continue;
      deck.skirts++;
      const a = row(inner), b = row(outer);
      quad(a, a + 1, b, b + 1);
      const sw = Math.max(outer[0][4] * sd, outer[1][4] * sd) - ow;
      if (sw > 6) ctx.hideTrees({ poly: [P(S[i], sd * ow), P(S[i + 1], sd * ow), P(S[i + 1], sd * (ow + sw + 2)), P(S[i], sd * (ow + sw + 2))] });
      hullOf([...inner, ...outer]);
    }
  }
  // corners between an end ramp and the side bevels: one triangle each (slab corner, ramp corner, bevel corner)
  for (const r of rampsBuilt) {
    for (const sd of [-1, 1]) {
      if (covered[r.k === 0 ? 0 : S.length - 2] > 0) continue;
      const [cx, cz] = P(S[r.k], sd * ow), [fx, fz] = P(r.sr, sd * ow);
      const A = [cx, yAt(r.k, sd * ow), cz, S[r.k], sd * ow], Bp = [fx, gnd(fx, fz), fz, r.sr, sd * ow], C = outerAt(r.k, sd);
      if (C[1] >= A[1] - 0.02) continue;
      const a = row([A, Bp, C]);
      M.idx.push(a, a + 1, a + 2, a, a + 2, a + 1);
      hullOf([A, Bp, C]);
    }
  }
  return { s0, s1, y: Y };
}
