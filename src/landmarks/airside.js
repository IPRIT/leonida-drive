import { findRunways } from '../air/runways.js';

// Airport clean-up of the road graph, run from two Roads hooks while the road meshes are built (index.js):
//   Roads.afterAirside(roads)   -> refineAirside(): every taxiway inside an airport becomes airside (yellow
//                                  taxiway markings, no street lamps / sidewalks / AI traffic), and the stray
//                                  pieces the source map leaves on an airfield are flagged hidden
//   Roads.skipRibbon(e, roads)  -> hidden edges get no ribbon, collider, lamps or junction cap
// Hidden: every runway edge and the road edge of each small airstrip (src/landmarks draws both as exact
// rectangles), runway-wide forks / turn pads / stopways on a runway or its extended centreline, dead-end stubs
// inside a runway strip, and short isolated pieces on airfield pavement. Hidden edges stay in the graph
// (routing, airside flags, plane spawns).

const REACH = 550; // airport zone: distance from a runway (m)
const cache = new WeakMap();
let STRIP_POIS = []; // [x, z] of small airstrips (sites with strip: true), set by index.js before `new Roads`

export function setStripSites(list) { STRIP_POIS = list; }

// per-edge bounding boxes [x0, z0, x1, z1] (cheap rejects before the per-point tests)
const boxCache = new WeakMap();
function edgeBoxes(roads) {
  let b = boxCache.get(roads);
  if (b) return b;
  const E = roads.edges;
  b = new Float32Array(E.length * 4);
  for (let i = 0; i < E.length; i++) {
    const P = E[i].pts, n = E[i].n;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = P[2 * k], z = P[2 * k + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    b[4 * i] = x0; b[4 * i + 1] = z0; b[4 * i + 2] = x1; b[4 * i + 3] = z1;
  }
  boxCache.set(roads, b);
  return b;
}

// small strip: the straight, isolated road edge nearest to the POI is the runway (pieces split at junction
// stubs are chained through degree-2 nodes while they stay collinear) -> {edge, edges, rect}
export function findStripEdge(roads, x, z) {
  let best = null;
  const deg = (ni) => roads.adj[ni].length;
  const B = edgeBoxes(roads);
  for (const e of roads.edges) {
    if (e.w < 8 || e.len < 60 || e.runway) continue;
    const bi = 4 * e.i;
    if (x < B[bi] - 120 || x > B[bi + 2] + 120 || z < B[bi + 1] - 120 || z > B[bi + 3] + 120) continue;
    const da = deg(e.a), db = deg(e.b);
    if (Math.min(da, db) > 2 || Math.max(da, db) > 3) continue; // an airstrip is its own piece of the graph
    const P = e.pts, n = e.n;
    let dmin = Infinity;
    for (let k = 0; k < n; k++) dmin = Math.min(dmin, Math.hypot(P[2 * k] - x, P[2 * k + 1] - z));
    if (dmin > 120) continue;
    const chord = Math.hypot(P[2 * n - 2] - P[0], P[2 * n - 1] - P[1]);
    if (chord / e.len < 0.92) continue;
    if (!best || dmin < best.d - 5 || (Math.abs(dmin - best.d) <= 5 && e.len > best.e.len)) best = { d: dmin, e, chord };
  }
  if (!best) return null;
  // chain collinear neighbours through degree-2 nodes
  const e0 = best.e, P0 = e0.pts, n0 = e0.n;
  let ax = P0[0], az = P0[1], bx = P0[2 * n0 - 2], bz = P0[2 * n0 - 1];
  const ux = (bx - ax) / best.chord, uz = (bz - az) / best.chord;
  const edges = [e0];
  for (const [startNode, sign] of [[e0.b, 1], [e0.a, -1]]) {
    let ni = startNode, cur = e0;
    for (let guard = 0; guard < 8; guard++) {
      if (deg(ni) !== 2) break;
      const nx = roads.edges[roads.adj[ni].find((ei) => ei !== cur.i)];
      if (!nx || nx.runway || Math.abs(nx.w - e0.w) > 4) break;
      const Q = nx.pts, m = nx.n;
      const far = nx.a === ni ? [Q[2 * m - 2], Q[2 * m - 1]] : [Q[0], Q[1]];
      const near = nx.a === ni ? [Q[0], Q[1]] : [Q[2 * m - 2], Q[2 * m - 1]];
      const vx = far[0] - near[0], vz = far[1] - near[1], l = Math.hypot(vx, vz) || 1;
      if ((vx * ux + vz * uz) * sign / l < 0.98) break;
      if (sign > 0) { bx = far[0]; bz = far[1]; } else { ax = far[0]; az = far[1]; }
      edges.push(nx);
      ni = nx.a === ni ? nx.b : nx.a; cur = nx;
    }
  }
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 100) return null;
  // drawn at least 18 m wide (small-airfield runway), whatever width the road graph gives it
  return { edge: e0, edges, rect: { x0: ax, z0: az, x1: bx, z1: bz, dx: (bx - ax) / len, dz: (bz - az) / len, len, w: Math.max(e0.w, 18), y: e0.y[0], cx: (ax + bx) / 2, cz: (az + bz) / 2, airport: 'strip', strip: true } };
}

function info(roads) {
  let s = cache.get(roads);
  if (s) return s;
  s = { hidden: new Set(), taxiways: new Set(), runways: [], strips: [] };
  cache.set(roads, s);
  let runways = roads.runways;
  if (!runways) { try { runways = findRunways(roads) || []; } catch { runways = []; } }
  for (const [x, z] of STRIP_POIS) {
    const f = findStripEdge(roads, x, z);
    if (!f || f.edge.runway) continue;
    s.strips.push(f.rect);
    for (const e of f.edges) s.hidden.add(e.i);
  }
  runways = runways.concat(s.strips);
  s.runways = runways;
  if (!runways.length) return s;
  const E = roads.edges, adj = roads.adj, T = roads.terrain;
  const G = T?.G || {};
  const deg = (ni) => adj[ni].length;
  const airfieldGround = (x, z) => { const g = T?.groundAt?.(x, z); return g === G.paved || g === G.road; };
  // each runway's reach (zone or extended centreline) as a box: edges outside every box are skipped
  const reach = runways.map((r) => {
    const m = Math.max(r.strip ? 200 : REACH, 400 + r.w / 2 + 40);
    return [Math.min(r.x0, r.x1) - m, Math.min(r.z0, r.z1) - m, Math.max(r.x0, r.x1) + m, Math.max(r.z0, r.z1) + m];
  });
  const B = edgeBoxes(roads), near = [];
  for (const e of E) {
    if (e.runway || s.hidden.has(e.i)) { s.hidden.add(e.i); continue; }
    const bi = 4 * e.i;
    near.length = 0;
    for (let q = 0; q < runways.length; q++) {
      const R = reach[q];
      if (B[bi] <= R[2] && B[bi + 2] >= R[0] && B[bi + 1] <= R[3] && B[bi + 3] >= R[1]) near.push(runways[q]);
    }
    if (!near.length) continue;
    let ext = 0, strip = 0, zone = 0, dmin = Infinity;
    for (let k = 0; k < e.n; k++) {
      const x = e.pts[2 * k], z = e.pts[2 * k + 1];
      let inExt = false, inStrip = false, inZone = false;
      for (const r of near) {
        const u = (x - r.x0) * r.dx + (z - r.z0) * r.dz, v = Math.abs((x - r.x0) * -r.dz + (z - r.z0) * r.dx);
        const uc = u < 0 ? 0 : u > r.len ? r.len : u, d = Math.hypot(u - uc, v);
        if (d < dmin) dmin = d;
        if (d < (r.strip ? 200 : REACH)) inZone = true;
        if (u > -400 && u < r.len + 400 && v < r.w / 2 + 40) inExt = true;
        if (u >= 0 && u <= r.len && v < r.w / 2 + (r.strip ? 20 : 75)) inStrip = true;
      }
      if (inExt) ext++;
      if (inStrip) strip++;
      if (inZone) zone++;
    }
    if (!zone) continue;
    const n = e.n, dead = deg(e.a) === 1 || deg(e.b) === 1, isolated = deg(e.a) === 1 && deg(e.b) === 1;
    // runway-wide pieces on the runway or its extended centreline: forks, turn pads, stopways of the source map
    if (e.w >= 28 && ext / n >= 0.5) { s.hidden.add(e.i); continue; }
    // dead-end stubs inside a runway strip
    if (dead && strip / n >= 0.5 && e.len < 300) { s.hidden.add(e.i); continue; }
    // airfield ground on both sides (the source map paints whole airports as one paved area)
    let side = 0, samples = 0;
    for (let k = 0; k < n - 1; k += 2) {
      const dx = e.pts[2 * k + 2] - e.pts[2 * k], dz = e.pts[2 * k + 3] - e.pts[2 * k + 1], L = Math.hypot(dx, dz) || 1;
      const o = e.w / 2 + 8;
      for (const sd of [-1, 1]) { samples++; if (airfieldGround(e.pts[2 * k] - (dz / L) * o * sd, e.pts[2 * k + 1] + (dx / L) * o * sd)) side++; }
    }
    const onField = samples ? side / samples : 0;
    // short isolated pieces on the airfield (not landside: within 400 m of a runway)
    if (isolated && e.len < 300 && onField > 0.6 && dmin < 400) { s.hidden.add(e.i); continue; }
    // taxiways: inside the airport zone, airfield pavement on both sides, not a dirt track
    if (e.kind !== 2 && zone / n > 0.8 && onField > 0.75) s.taxiways.add(e.i);
  }
  return s;
}

// Roads.afterAirside hook: taxiways inside airports become airside (before lamps / sidewalks / ribbons are decided)
export function refineAirside(roads) {
  const s = info(roads);
  for (const i of s.taxiways) roads.edges[i].airside = true;
  for (const i of s.hidden) roads.edges[i].airside = true;
}

// edges the road meshes skip (drawn by src/landmarks or stray airfield pieces)
export function hiddenEdges(roads) { return info(roads).hidden; }
export function taxiwayEdges(roads) { return info(roads).taxiways; }
// small airstrip rectangles found for the strip sites (same order as STRIP_POIS, missing ones skipped)
export function stripRunways(roads) { return info(roads).strips; }
