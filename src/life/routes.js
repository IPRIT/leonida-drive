// Point-to-point race routes generated on the road graph (pure logic, no DOM/three; testable in node).

// Start spots, preferred heading and target length. Names are original.
export const RACE_DEFS = [
  { id: 'beachfront', name: 'Beachfront Sprint', x: 1700, z: -2180, dir: [0, 1], len: [2400, 3600] },
  { id: 'causeway', name: 'Causeway Rush', x: 1740, z: -700, dir: [-1, 0.25], len: [3000, 5200] },
  { id: 'downtown', name: 'Downtown Dash', x: -660, z: 100, dir: [0.1, -1], len: [2200, 3600] },
  // 40 m up the street from the Little Cuba body shop ring (src/economy/places.js): the two markers used to overlap
  { id: 'runway', name: 'Interstate Express', x: -1230, z: -60, dir: [-1, 0.5], len: [2200, 3800] },
  { id: 'swamp', name: 'Grassrivers Getaway', x: -2690, z: 3190, dir: [-0.4, 1], len: [2800, 4600] },
  { id: 'canefield', name: 'Cane Field Charge', x: -2800, z: -3970, dir: [1, 0.2], len: [2500, 4400] },
  { id: 'keys', name: 'Overseas Dash', x: -2510, z: 5890, dir: [1, -0.6], len: [2500, 4600] },
  { id: 'kalaga', name: 'Kalaga Hill Climb', x: -3300, z: -5600, uphill: true, len: [1800, 4200] },
];

const SPEED = [28, 42, 18]; // m/s reference pace per road kind (road, highway, dirt)

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (v[p] <= v[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const k = this.k, v = this.v, top = k[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

// Build a route for a definition: Dijkstra (true metres) from the nearest non-dirt road, finish = best node in the
// length window by heading / climb score. Returns { def, pts:[{x,y,z,w,kind}], length, checkpoints, par } or null.
export function buildRoute(roads, def) {
  const A = roads.nearest(def.x, def.z, 900, (e) => e.kind !== 2 && !e.br);
  if (!A) return null;
  const N = roads.nodes.length;
  const dist = new Float64Array(N).fill(Infinity);
  const cost = new Float64Array(N).fill(Infinity);
  const prevE = new Int32Array(N).fill(-1);
  const prevN = new Int32Array(N).fill(-1);
  const e0 = A.edge;
  const s0 = e0.cum[A.seg] + A.t * (e0.cum[A.seg + 1] - e0.cum[A.seg]);
  const heap = new Heap();
  const mul = (e) => (e.kind === 2 ? 2.5 : e.kind === 1 ? 0.9 : 1);
  const seed = (n, d) => { if (d < cost[n]) { cost[n] = d * mul(e0); dist[n] = d; heap.push(n, cost[n]); } };
  seed(e0.a, s0);
  if (e0.b !== e0.a) seed(e0.b, e0.len - s0);
  const maxLen = def.len[1];
  const done = new Uint8Array(N);
  while (heap.size) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (dist[cur] > maxLen) continue;
    for (const ei of roads.adj[cur]) {
      const e = roads.edges[ei];
      if (e === e0) continue;
      const nb = e.a === cur ? e.b : e.a;
      const nc = cost[cur] + e.len * mul(e);
      if (nc < cost[nb]) { cost[nb] = nc; dist[nb] = dist[cur] + e.len; prevE[nb] = ei; prevN[nb] = cur; heap.push(nb, nc); }
    }
  }
  // choose the finish node
  let dx = def.dir ? def.dir[0] : 0, dz = def.dir ? def.dir[1] : 0;
  const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
  const sy = A.y;
  let best = -1, bs = -Infinity;
  for (let n = 0; n < N; n++) {
    const d = dist[n];
    if (!(d >= def.len[0] && d <= def.len[1]) || !done[n]) continue;
    const [nx, nz] = roads.nodes[n];
    const ox = nx - A.x, oz = nz - A.z;
    const straight = Math.hypot(ox, oz);
    if (straight < d * 0.35) continue; // no loops back to the start
    let score = def.uphill ? ((roads.nodeY?.[n] ?? 0) - sy) * 40 + straight * 0.2 : (ox * dx + oz * dz) + straight * 0.35;
    score -= Math.abs(d - (def.len[0] + def.len[1]) / 2) * 0.05;
    if (score > bs) { bs = score; best = n; }
  }
  if (best < 0) return null;
  // backtrack to the start node
  const chain = [];
  let c = best;
  while (prevE[c] >= 0) { chain.push([prevE[c], prevN[c]]); c = prevN[c]; }
  chain.reverse();
  const first = c; // e0.a or e0.b
  const pts = [];
  const push = (x, z, y, e) => {
    const L = pts[pts.length - 1];
    if (L && Math.hypot(L.x - x, L.z - z) < 0.5) return;
    pts.push({ x, z, y, w: e.w, kind: e.kind });
  };
  push(A.x, A.z, A.y, e0);
  if (first === e0.a) for (let k = A.seg; k >= 0; k--) push(e0.pts[2 * k], e0.pts[2 * k + 1], e0.y[k], e0);
  else for (let k = A.seg + 1; k < e0.n; k++) push(e0.pts[2 * k], e0.pts[2 * k + 1], e0.y[k], e0);
  for (const [ei, from] of chain) {
    const e = roads.edges[ei];
    if (e.a === from) for (let k = 0; k < e.n; k++) push(e.pts[2 * k], e.pts[2 * k + 1], e.y[k], e);
    else for (let k = e.n - 1; k >= 0; k--) push(e.pts[2 * k], e.pts[2 * k + 1], e.y[k], e);
  }
  if (pts.length < 3) return null;
  return finishRoute(def, pts);
}

function finishRoute(def, pts) {
  const n = pts.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  const length = cum[n - 1];
  const at = (s) => {
    s = Math.max(0, Math.min(length, s));
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, w: b.w, kind: b.kind, tx: (b.x - a.x) / seg, tz: (b.z - a.z) / seg };
  };
  const heading = (s) => { const p = at(s); return Math.atan2(p.tx, p.tz); };
  const turnAt = (s) => { let d = heading(s + 22) - heading(s - 22); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };
  // checkpoints: every ~210 m and at sharp corners
  const cps = [];
  let last = 0, par = 0, turns = 0;
  for (let s = 40; s < length - 70; s += 10) {
    const sharp = turnAt(s) > 0.95 && s - last > 70;
    if (s - last >= 210 || sharp) {
      if (sharp) turns++;
      cps.push(s); last = s;
    }
  }
  cps.push(length);
  for (let s = 0; s < length; s += 20) par += Math.min(20, length - s) / SPEED[at(s).kind] ;
  par += turns * 1.2 + 2.5; // corners + standing start
  const checkpoints = cps.map((s, i) => {
    const p = at(s);
    const R = Math.max(6, Math.min(12, p.w * 0.5 + 2));
    return { s, x: p.x, y: p.y, z: p.z, yaw: Math.atan2(p.tx, p.tz), R, finish: i === cps.length - 1 };
  });
  const s0 = at(0);
  return {
    def, pts, length, checkpoints, par: par * 1000,
    start: { x: s0.x, y: s0.y, z: s0.z, yaw: Math.atan2(s0.tx, s0.tz), w: s0.w },
  };
}

export function buildAllRoutes(roads, defs = RACE_DEFS) {
  const out = [];
  for (const d of defs) {
    try { const r = buildRoute(roads, d); if (r) out.push(r); } catch (e) { console.warn('[life] route', d.id, e); }
  }
  return out;
}
