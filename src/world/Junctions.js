import * as THREE from 'three';

// Junction shaping, control and markings for src/world/Roads.js (US / Florida urban practice, low-poly but correct):
//  - kerb returns: every corner between two neighbouring arms is a circular fillet tangent to both kerb lines. The
//    radius comes from the source map where it shows the corner (tools/junction_shapes.py measures it on the raster:
//    square downtown corners, sweeping suburban flares), blended with a radius by road class (local 7.5 m,
//    collector 10 m, arterial 13 m, highway ramp 15 m);
//  - control: signalised junctions (the traffic lights' rule) stop every leg; other junctions of streets are two-way
//    stops (minor legs) or all-way stops (equal local streets); highway merges / diverges are free flowing;
//  - markings per ribbon end, encoded as a bit code in the road shader's aEnd attribute (CODE): crosswalk
//    (continental, or ladder at signals), stop bar or yield teeth on the approach half, turn arrows on two-lane
//    approaches; lane and centre lines stop cleanly at the stop bar (approach) / after the crosswalk (departure);
//  - curb ramps with a detectable-warning patch where crosswalks meet sidewalks (Roads.sidewalks), stop signs.

// Layout along an arm, metres past its trim (the end of the junction fill = the kerb return's tangent point).
export const MARK = {
  XW0: 0.3, XW1: 3.3, // crosswalk band (3 m wide) at the end of the kerb return; the curb ramps' flush kerb spans it
  FLARE: 1.5, // ramp rising back to full kerb height beyond the band
  SB_GAP: 1.2, SB_W: 0.45, // stop bar 1.2 m behind the crosswalk, 45 cm wide
  NO_XW_SB: 0.9, // stop bar / yield line without a crosswalk: just past the trim
  ARROW: 6.0, // turn arrows: head this far behind the stop bar
};
export const CODE = { XW: 1, STOP: 2, LADDER: 4, YIELD: 8, LEFT: 16, THRU: 32, RIGHT: 64, JUNC: 128, DEAD: 256 };

/** [near, far] distance of the stop bar (or yield line) past the trim for a ribbon-end code */
// painted zone of a ribbon end past its trim: crosswalk and stop bar / yield line (0 = none)
function zoneLen(code) {
  if (!(code & CODE.JUNC)) return 0;
  if (code & (CODE.STOP | CODE.YIELD)) return stopBarAt(code)[1];
  return code & CODE.XW ? MARK.XW1 : 0;
}

// the zone's footprint: quad over the full width (x, z corners)
function zoneQuad(R, a, L) {
  const t = R.trims[a.e.i][a.fromA ? 0 : 1].t, out = [];
  for (const s of [t, t + L]) {
    const p = R.pointAt(a.e, a.fromA ? s : a.e.len - s), hw = p.w / 2;
    out.push([p.x - p.tz * hw, p.z + p.tx * hw], [p.x + p.tz * hw, p.z - p.tx * hw]);
  }
  return [out[0], out[1], out[3], out[2]];
}

// convex quads overlap (separating axis test on both quads' edges)
function quadsOverlap(A, B) {
  for (const P of [A, B]) for (let i = 0; i < 4; i++) {
    const p = P[i], q = P[(i + 1) % 4], nx = q[1] - p[1], nz = p[0] - q[0];
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const v of A) { const d = v[0] * nx + v[1] * nz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
    for (const v of B) { const d = v[0] * nx + v[1] * nz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

/**
 * Arms close together (forks, acute corners) can paint into each other: a crosswalk or stop bar over the
 * neighbouring arm's lanes. Where two arms' painted zones overlap, the crosswalks go (minor arm first), then the
 * stop bars (minor arm first; that approach is then uncontrolled for the AI too, Traffic: reservation only).
 */
function separateMarkings(R, J, stopKeys) {
  const arms = J.allArms.filter((a) => !a.e.internal && a.e.a !== a.e.b && R.trims[a.e.i][a.fromA ? 0 : 1]);
  const tr = (a) => R.trims[a.e.i][a.fromA ? 0 : 1];
  const rank = (a) => (a.e.kind === 1 ? 3 : a.e.kind === 0 ? 2 : 0) * 1000 + a.e.w * 10;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      const A = arms[i], B = arms[j], cA = tr(A).code || 0, cB = tr(B).code || 0;
      const LA = zoneLen(cA), LB = zoneLen(cB);
      if (!LA && !LB) continue;
      // a zone against the other arm's zone, or (no zone there) its first metres of carriageway
      if (!quadsOverlap(zoneQuad(R, A, Math.max(LA, 1)), zoneQuad(R, B, Math.max(LB, 1)))) continue;
      const [m, M] = rank(A) <= rank(B) ? [A, B] : [B, A];
      const dropXW = (a) => { const t = tr(a); if (!(t.code & CODE.XW)) return false; t.code &= ~(CODE.XW | CODE.LADDER); t.xwalk = 0; return true; };
      const dropSB = (a) => {
        const t = tr(a);
        if (!(t.code & (CODE.STOP | CODE.YIELD))) return false;
        t.code &= ~(CODE.STOP | CODE.YIELD | CODE.LEFT | CODE.THRU | CODE.RIGHT);
        stopKeys?.delete(a.e.i * 2 + (a.fromA ? 0 : 1));
        return true;
      };
      if (dropXW(m) || dropXW(M) || dropSB(m) || dropSB(M)) changed = true;
    }
    if (!changed) break;
  }
}

export function stopBarAt(code) {
  const a = code & CODE.XW ? MARK.XW1 + MARK.SB_GAP : MARK.NO_XW_SB;
  return [a, a + MARK.SB_W];
}

// kerb-return radius by road class (US practice)
export function classRadius(e) {
  if (e.kind === 2) return 5;
  if (e.kind === 1) return e.rp ? 15 : 18;
  if (e.cl === 1 || e.w >= 11.5) return 13;
  return e.w >= 8.5 ? 10 : 7.5;
}

// Source-map junction shapes (public/data/junctions.json, tools/junction_shapes.py), matched by position / angles.
export class ShapeIndex {
  constructor(js) {
    this.cells = new Map();
    this.islands = [];
    if (!js || js.v !== 1) return;
    for (const j of js.j || []) {
      const k = this.key(j[0], j[1]);
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k).push(j);
    }
    this.islands = js.isl || [];
  }

  key(x, z) { return Math.floor(x / 16) * 100003 + Math.floor(z / 16); }

  /** measured corner between arms at angles a, b (radians, atan2(dz, dx)) of the junction at (x, z): {r, conf} */
  corner(x, z, a, b) {
    let best = null, bd = 2.5;
    const ci = Math.floor(x / 16), cj = Math.floor(z / 16);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      for (const J of this.cells.get(i * 100003 + j) || []) {
        const d = Math.hypot(J[0] - x, J[1] - z);
        if (d < bd) { bd = d; best = J; }
      }
    }
    if (!best) return null;
    const da = (u, v) => Math.abs(((((u - v) % 360) + 540) % 360) - 180);
    const A = (a * 180) / Math.PI, B = (b * 180) / Math.PI;
    for (const c of best[2]) if (da(c[0], A) < 14 && da(c[1], B) < 14) return { r: c[2], conf: c[3] };
    return null;
  }
}

// point on segment helpers (x, z)
const cross2 = (ax, az, bx, bz) => ax * bz - az * bx;

/**
 * Line (P, direction d) meets line (Q, direction e): returns [x, z, u, v] with X = P + d u = Q + e v, or null.
 */
export function meet(px, pz, dx, dz, qx, qz, ex, ez) {
  const den = cross2(dx, dz, ex, ez);
  if (Math.abs(den) < 1e-6) return null;
  const wx = qx - px, wz = qz - pz;
  const u = cross2(wx, wz, ex, ez) / den, v = cross2(wx, wz, dx, dz) / den;
  return [px + dx * u, pz + dz * u, u, v];
}

/**
 * Kerb return between corner PA (end row of arm A, outward direction dA) and PB (arm B, outward dB): straight kerb
 * from PA towards the node to the tangent point, a circular arc (rational quadratic Bézier, exact for equal tangent
 * lengths) of tangent length <= Lt, straight out to PB. Returns the points strictly between PA and PB ([x, z, f]
 * with f = 0..1 the position along the kerb for height interpolation), or null when the corners do not frame a
 * corner (kerb lines meet behind a corner).
 */
export function filletPoints(PA, dA, PB, dB, Lt) {
  const V = meet(PA[0], PA[2], -dA[0], -dA[1], PB[0], PB[2], -dB[0], -dB[1]);
  if (!V) return null;
  const la = V[2], lb = V[3];
  if (la < 0.3 || lb < 0.3 || la > 80 || lb > 80) return null;
  const L = Math.min(la, lb, Lt);
  if (L < 0.4) return null;
  const vx = V[0], vz = V[1];
  const TA = [vx + dA[0] * L, vz + dA[1] * L], TB = [vx + dB[0] * L, vz + dB[1] * L];
  const cosV = Math.max(-1, Math.min(1, dA[0] * dB[0] + dA[1] * dB[1]));
  const thV = Math.acos(cosV); // interior angle at the sharp corner
  const w = Math.sin(thV / 2); // conic weight: a circle for equal tangent lengths
  const turn = Math.PI - thV;
  const m = Math.max(2, Math.min(7, Math.ceil(turn / 0.36)));
  const out = [];
  const total = la - L + (lb - L) + L * 2; // rough kerb length for f
  let run = 0;
  if (la - L > 0.3) { run = la - L; out.push([TA[0], TA[1], run / total]); }
  for (let k = 1; k < m; k++) {
    const t = k / m, a0 = (1 - t) * (1 - t), a1 = 2 * t * (1 - t) * w, a2 = t * t;
    const s = a0 + a1 + a2;
    out.push([(a0 * TA[0] + a1 * vx + a2 * TB[0]) / s, (a0 * TA[1] + a1 * vz + a2 * TB[1]) / s, (la - L + 2 * L * t) / total]);
  }
  if (lb - L > 0.3) out.push([TB[0], TB[1], (la + L) / total]);
  return out;
}

/** turn movements available to traffic arriving on arm `a` of junction J: CODE.LEFT | THRU | RIGHT */
export function movements(J, a) {
  const tx = -a.dx, tz = -a.dz; // travel direction into the node
  let bits = 0;
  for (const b of J.allArms) {
    if (b === a || b.e === a.e) continue;
    const c = tx * b.dx + tz * b.dz;
    if (c > 0.72) { bits |= CODE.THRU; continue; }
    // right of travel (right-hand traffic) is (-tz, tx) in the (x, z) plane
    const r = -tz * b.dx + tx * b.dz;
    if (c < -0.9) continue; // U-turn back alongside
    bits |= r > 0 ? CODE.RIGHT : CODE.LEFT;
  }
  return bits;
}

/**
 * Who stops where. Signalised (the traffic lights' rule, Roads.isSignalised): every leg. Highway-only nodes
 * (merges, diverges): free flow. Otherwise the major road is the straightest pair of the highest-ranked arms (paved
 * highway > street > dirt, then width): every other leg that carries traffic into the node stops (two-way stop); a
 * highway ramp joining a street at a flat angle yields. No major pair among equal local streets: all-way stop.
 * Sets R.control[ni] = { type, stop: Set(edge*2+end) } and the ribbon-end codes R.trims[e][end].code.
 */
export function computeControl(R) {
  R.control = new Array(R.nodes.length);
  for (let ni = 0; ni < R.nodes.length; ni++) {
    const J = R.junctions[ni];
    if (!J) continue;
    const arms = J.allArms.filter((a) => !a.e.internal && a.e.a !== a.e.b);
    const sig = R.isSignalised(ni);
    const allHw = arms.every((a) => a.e.kind === 1);
    const into = (a) => R.allowedFrom(a.e, a.fromA ? a.e.b : a.e.a); // traffic on this arm heads into the node
    const stops = new Set(), yields = new Set();
    let type = 'none';
    if (sig) {
      type = 'signal';
      for (const a of arms) if (into(a)) stops.add(a);
    } else if (!allHw && arms.length >= 3) {
      const rank = (a) => (a.e.kind === 1 ? 3 : a.e.kind === 0 ? 2 : 0) * 1000 + Math.round(a.e.w * 10);
      const paved = arms.filter((a) => a.e.kind !== 2);
      let major = null, bestC = -0.72;
      const top = Math.max(...paved.map(rank));
      for (const A of paved) for (const B of paved) {
        if (A === B) continue;
        const c = A.dx * B.dx + A.dz * B.dz;
        // straight pair, favouring the higher ranked (within a lane's width of the widest)
        const rk = Math.min(rank(A), rank(B));
        if (top - rk > 25 && paved.some((q) => q !== A && q !== B && rank(q) > rk + 25)) continue;
        if (c < bestC) { bestC = c; major = [A, B]; }
      }
      const minor = arms.filter((a) => !major?.includes(a));
      const equal = paved.length === arms.length && Math.max(...paved.map(rank)) - Math.min(...paved.map(rank)) <= 15;
      if (!major && equal && arms.every((a) => a.e.kind === 0 && a.e.w < 11)) {
        type = 'allway';
        for (const a of arms) if (into(a)) stops.add(a);
      } else {
        if (!major) {
          // no straight pair: the two highest ranked arms are the through road
          const s = paved.slice().sort((p, q) => rank(q) - rank(p));
          major = s.slice(0, 2);
        }
        type = 'twoway';
        for (const a of arms) {
          if (major.includes(a) || a.e.kind === 2 || !into(a)) continue;
          stops.add(a);
          // a ramp merging at a flat angle into the major road yields instead of stopping
          if (a.e.kind === 1 && major.some((m) => a.dx * m.dx + a.dz * m.dz < -0.75 || a.dx * m.dx + a.dz * m.dz > 0.75)) {
            const t = -a.dx * major[0].dx - a.dz * major[0].dz;
            if (Math.abs(t) > 0.8) yields.add(a);
          }
        }
      }
    }
    const swOf = (a) => R.sidewalkWidth(a.e) > 0;
    const stopKeys = new Set();
    const n = J.allArms.length;
    J.allArms.forEach((a, i) => {
      const end = a.fromA ? 0 : 1;
      const tr = R.trims[a.e.i][end];
      if (!tr) return;
      if (a.e.internal || a.e.a === a.e.b) { tr.code = 0; tr.xwalk = 0; return; }
      let code = CODE.JUNC;
      const free = a.e.len - (R.trims[a.e.i][0]?.t || 0) - (R.trims[a.e.i][1]?.t || 0);
      const prev = J.allArms[(i + n - 1) % n], next = J.allArms[(i + 1) % n];
      // crosswalk: urban legs (a sidewalk on the leg, or on both legs beside it) with room on the ribbon
      const urbanLeg = a.e.kind !== 2 && !a.e.airside && (swOf(a) || (swOf(prev) && swOf(next)));
      const xw = urbanLeg && free > MARK.XW1 + 8 && (sig || stops.has(a) || type === 'allway') && (a.e.kind === 0 || sig);
      if (xw) code |= CODE.XW | (sig ? CODE.LADDER : 0);
      if (stops.has(a)) {
        code |= yields.has(a) ? CODE.YIELD : CODE.STOP;
        if (!yields.has(a)) stopKeys.add(a.e.i * 2 + end); // full stop (AI: Traffic stop signs); yield: reservation only
        code |= movements(J, a);
      }
      tr.code = code;
      tr.xwalk = code & CODE.XW ? 1 : 0;
    });
    separateMarkings(R, J, stopKeys);
    R.control[ni] = { type, stop: stopKeys };
  }
  // a short link between two junctions: both ends' painted zones must leave >= 4 m of plain lane between them
  // (crosswalks go first at the smaller junction's end, then the other's; then the smaller end's stop bar)
  for (const e of R.edges) {
    const T = R.trims[e.i];
    if (!T?.[0]?.code || !T[1]?.code || e.a === e.b) continue;
    const free = () => e.len - T[0].t - T[1].t - zoneLen(T[0].code) - zoneLen(T[1].code);
    if (free() >= 4) continue;
    const size = (end) => R.adj[end ? e.b : e.a].length * 100 - T[end].t;
    const order = size(0) <= size(1) ? [0, 1] : [1, 0];
    const steps = [];
    for (const end of order) steps.push(() => { if (!(T[end].code & CODE.XW)) return false; T[end].code &= ~(CODE.XW | CODE.LADDER); T[end].xwalk = 0; return true; });
    for (const end of order) steps.push(() => {
      if (!(T[end].code & (CODE.STOP | CODE.YIELD))) return false;
      T[end].code &= ~(CODE.STOP | CODE.YIELD | CODE.LEFT | CODE.THRU | CODE.RIGHT);
      R.control[end ? e.b : e.a]?.stop.delete(e.i * 2 + end);
      return true;
    });
    for (const st of steps) { if (free() >= 4) break; st(); }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Road shader chunk: junction markings on the ribbons (replaces the old zebra / stop line). Needs: kind, hw, x, v
// (lane coordinates), vEnd (dA, dB, codeA, codeB), col; defines markCut(): where lines may run.
export const ROAD_MARK_GLSL_FUNCS = /* glsl */ `
  float jSegAA(vec2 p, vec2 a, vec2 b, float w) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(pa - ba * h);
    float fw = fwidth(d) + 1e-4;
    return 1.0 - smoothstep(w - fw, w + fw, d);
  }
  float jTri(vec2 p, vec2 tip, vec2 dir, float len, float hwid) {
    vec2 q = p - tip;
    float al = -dot(q, dir), lt = abs(dot(q, vec2(-dir.y, dir.x)));
    return step(0.0, al) * step(al, len) * step(lt, hwid * al / len);
  }
  // turn arrow glyph, p = (lateral to the driver's right, along towards the junction), tail at 0, head at 4.8
  float jArrow(vec2 p, int t) {
    float m = 0.0;
    if ((t & 2) != 0) { m = max(m, jSegAA(p, vec2(0.0, 0.0), vec2(0.0, 3.1), 0.12)); m = max(m, jTri(p, vec2(0.0, 4.8), vec2(0.0, 1.0), 1.8, 0.5)); }
    for (int s = 0; s < 2; s++) {
      if ((t & (s == 0 ? 1 : 4)) == 0) continue;
      float sg = s == 0 ? -1.0 : 1.0;
      vec2 q = vec2(p.x * sg, p.y);
      m = max(m, jSegAA(q, vec2(0.0, 0.0), vec2(0.0, 2.0), 0.12));
      m = max(m, jSegAA(q, vec2(0.0, 1.9), vec2(0.75, 2.65), 0.12));
      m = max(m, jTri(q, vec2(1.6, 3.5), vec2(0.7071, 0.7071), 1.25, 0.5));
    }
    return m;
  }
  // distance past the trim before which lines of one half do not run: approach half up to the stop bar,
  // departure half from the crosswalk on; plain ends (no junction): run to the end
  float jCut(float c, bool approach) {
    int ic = int(c + 0.5);
    if ((ic & ${CODE.DEAD}) != 0) return 2.0; // lines end short of a dead end's cap
    if ((ic & ${CODE.JUNC}) == 0) return -1.0;
    bool xw = (ic & ${CODE.XW}) != 0;
    if (approach) {
      if ((ic & ${CODE.STOP | CODE.YIELD}) != 0) return (xw ? ${(MARK.XW1 + MARK.SB_GAP + MARK.SB_W).toFixed(2)} : ${(MARK.NO_XW_SB + MARK.SB_W).toFixed(2)});
      return xw ? ${(MARK.XW1 + 0.4).toFixed(2)} : 0.4;
    }
    return xw ? ${(MARK.XW1 + 0.4).toFixed(2)} : 0.4;
  }
`;

// in the colour block (after `col` holds the lane markings): crosswalks, stop bars / yield teeth, arrows
export const ROAD_MARK_GLSL_APPLY = /* glsl */ `
  if (kind < 1.5 && noMark < 0.5) {
    float jm = 0.0;
    for (int s = 0; s < 2; s++) {
      float d = s == 0 ? vEnd.x : vEnd.y;
      int c = int((s == 0 ? vEnd.z : vEnd.w) + 0.5);
      if ((c & ${CODE.JUNC}) == 0 || d > 22.0) continue;
      // approach half: traffic towards end A drives on x > 0, towards B on x < 0 (right-hand traffic);
      // one-way carriageways: the whole width approaches the end the flow runs to
      float ows = kind > 1.15 ? (kind > 1.32 ? -1.0 : 1.0) : 0.0;
      float sg = s == 0 ? 1.0 : -1.0;
      float xa = x * sg; // lateral, positive on the approach half (driver's right for approaching traffic)
      bool appr = ows == 0.0 ? xa > 0.0 : (ows > 0.0) == (s == 1);
      if (ows != 0.0) xa = (ows > 0.0) == (s == 1) ? hw - x * ows : -1.0;
      if ((c & ${CODE.XW}) != 0 && d > ${MARK.XW0.toFixed(2)} && d < ${MARK.XW1.toFixed(2)} && abs(x) < hw - 0.3) {
        // continental bars along the traffic (0.6 m on 1.2 m), ladder: + transverse edge lines at signals
        float bars = step(0.5, fract((x + hw) / 1.2 + 0.25));
        float lad = (c & ${CODE.LADDER}) != 0 ? max(step(d, ${(MARK.XW0 + 0.3).toFixed(2)}), step(${(MARK.XW1 - 0.3).toFixed(2)}, d)) : 0.0;
        jm = max(jm, max(bars, lad));
      }
      if (appr && (c & ${CODE.STOP | CODE.YIELD}) != 0) {
        float sb0 = (c & ${CODE.XW}) != 0 ? ${(MARK.XW1 + MARK.SB_GAP).toFixed(2)} : ${MARK.NO_XW_SB.toFixed(2)};
        float lo = ows == 0.0 ? 0.25 : 0.3;
        if ((c & ${CODE.STOP}) != 0) {
          jm = max(jm, step(sb0, d) * step(d, sb0 + ${MARK.SB_W.toFixed(2)}) * step(lo, xa) * step(xa, (ows == 0.0 ? hw : 2.0 * hw) - 0.3));
        } else {
          // yield: shark teeth pointing at the approaching driver (0.6 m base, 0.9 m tall, 0.9 m pitch)
          float u = (d - sb0) / 0.9;
          float f = fract((xa - lo) / 0.9) * 0.9;
          jm = max(jm, step(0.0, u) * step(u, 1.0) * step(abs(f - 0.45), 0.3 * (1.0 - u)) * step(lo, xa) * step(xa, (ows == 0.0 ? hw : 2.0 * hw) - 0.4));
        }
        // turn arrows: two lanes per direction, one glyph per lane centred on it
        float lnA = ows == 0.0 ? (hw > 6.2 ? 2.0 : 1.0) : clamp(floor(2.0 * hw / 3.7 + 0.5), 1.0, 4.0);
        int mv = (c >> 4) & 7;
        if (lnA > 1.5 && mv != 0 && (ows == 0.0 || lnA < 2.5)) {
          float lw = (ows == 0.0 ? hw : 2.0 * hw) / lnA;
          float li = floor(xa / lw);
          float along = sb0 + ${MARK.SB_W.toFixed(2)} + ${MARK.ARROW.toFixed(2)} + 4.8 - d;
          if (li >= 0.0 && li < lnA && along > -0.2 && along < 5.0) {
            bool L = (mv & 1) != 0, S = (mv & 2) != 0, Rr = (mv & 4) != 0;
            int t = 2;
            if (li < 0.5) t = L ? (S ? 3 : 1) : (S ? 2 : (Rr ? 4 : 2));
            else t = Rr ? (S ? 6 : 4) : 2;
            jm = max(jm, jArrow(vec2(xa - (li + 0.5) * lw, along), t));
          }
        }
      }
    }
    col = mix(col, vec3(0.9), clamp(jm, 0.0, 1.0) * 0.92);
  }
`;

// ---------------------------------------------------------------------------------------------------------------
// Stop signs (US R1-1: red octagon, white border, white legend bar suggested), low-poly, instanced.
export function stopSignGeometry() {
  const parts = [];
  const add = (g, color) => {
    const ng = g.index ? g.toNonIndexed() : g;
    const n = ng.attributes.position.count;
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (ng.attributes.uv) ng.deleteAttribute('uv');
    parts.push(ng);
  };
  const post = new THREE.BoxGeometry(0.07, 2.55, 0.07); post.translate(0, 1.275, -0.04); add(post, 0x8a8f96);
  // octagon plate: white rim behind, red face in front, legend bar; faces +z (towards approaching traffic)
  const oct = (r, z, color, depth) => {
    const g = new THREE.CylinderGeometry(r, r, depth, 8, 1);
    g.rotateX(Math.PI / 2);
    g.rotateZ(Math.PI / 8);
    g.translate(0, 2.2, z);
    add(g, color);
  };
  oct(0.4, 0.0, 0xf2f2f2, 0.025);
  oct(0.36, 0.008, 0xc8141e, 0.022);
  const bar = new THREE.BoxGeometry(0.42, 0.09, 0.012); bar.translate(0, 2.2, 0.021); add(bar, 0xf2f2f2);
  const merged = mergeColored(parts);
  return merged;
}

function mergeColored(parts) {
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o * 3);
    nrm.set(p.attributes.normal.array, o * 3);
    col.set(p.attributes.color.array, o * 3);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** Instanced field of static props (stop signs) shown around a focus point, refreshed every 0.5 s. */
export class PropField {
  constructor(geometry, material, spots, scene, max = 400) {
    this.spots = spots; // [{x, y, z, yaw}]
    this.mesh = new THREE.InstancedMesh(geometry, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.max = max;
    this.t = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    scene.add(this.mesh);
  }

  update(dt, focus, R = 450) {
    this.t -= dt;
    if (this.t > 0 || !focus) return;
    this.t = 0.5;
    let n = 0;
    for (const s of this.spots) {
      if (Math.abs(s.x - focus.x) > R || Math.abs(s.z - focus.z) > R) continue;
      if (n >= this.max) break;
      this._m.compose(this._p.set(s.x, s.y, s.z), this._q.setFromAxisAngle(this._up, s.yaw), this._s);
      this.mesh.setMatrixAt(n++, this._m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Sidewalk corners between neighbouring arms that both have sidewalks: a slab whose inner edge is the fill's rim
 * between the two arms' end-row corners (the kerb return: straight kerb, arc, straight kerb) with a 14 cm kerb face
 * along it, and whose outer edge squares off at the property corner (where the two sidewalks' outer edges meet), or
 * follows the rim at sidewalk width along straight sides / outer bends; at a narrow fork the two sidewalks close
 * into one nose. Physics: the slab with its rim edge on the fill (a mountable ramp: a car cutting the corner rides
 * up instead of striking a step), plus a drivable apron from the outer edge down to the ground.
 */
export function sidewalkCorners(R, bget, LIFT) {
  const H = 0.14, T = R.terrain;
  const v2 = (q) => new THREE.Vector2(q[0], q[1]);
  for (let ni = 0; ni < R.nodes.length; ni++) {
    const J = R.junctions[ni];
    if (!J || !J.ring?.length) continue;
    const arms = J.allArms, n = arms.length, ring = J.ring;
    if (arms.some((a) => a.e.tunnel || a.e.lifted || R.endFrame[a.e.i][a.fromA ? 0 : 1]?.isB)) continue;
    const own = new Set(arms.map((a) => a.e));
    const [cx0, , cz0] = J.center;
    for (let i = 0; i < n; i++) {
      const A = arms[i], B = arms[(i + 1) % n];
      const WA = R.sidewalkWidth(A.e), WB = R.sidewalkWidth(B.e);
      if (!WA || !WB || !A.cL || !B.cR) continue;
      const ia = ring.indexOf(A.cL), ib = ring.indexOf(B.cR);
      if (ia < 0 || ib < 0) continue;
      const run = [];
      for (let k = ia, g = 0; g <= ring.length; k = (k + 1) % ring.length, g++) { run.push(ring[k]); if (k === ib) break; }
      if (run[run.length - 1] !== B.cR || run.length < 2) continue;
      let runLen = 0;
      for (let k = 1; k < run.length; k++) runLen += Math.hypot(run[k][0] - run[k - 1][0], run[k][2] - run[k - 1][2]);
      if (runLen > 90) continue;
      const PA = run[0], PB = run[run.length - 1];
      const uA = [-A.oz, A.ox], uB = [B.oz, -B.ox]; // outward (away from the carriageway) at the two corners
      const OA = [PA[0] + uA[0] * WA, PA[2] + uA[1] * WA], OB = [PB[0] + uB[0] * WB, PB[2] + uB[1] * WB];
      const gap = J.wedges?.[i]?.gap ?? Math.PI;
      let outer, mode;
      const C = gap < Math.PI - 0.1 ? meet(OA[0], OA[1], -A.ox, -A.oz, OB[0], OB[1], -B.ox, -B.oz) : null;
      const mid = [(OA[0] + OB[0]) / 2, (OA[1] + OB[1]) / 2];
      if (C && C[2] > 0.05 && C[3] > 0.05 && Math.hypot(C[0] - mid[0], C[1] - mid[1]) < 45) { outer = [OB, [C[0], C[1]], OA]; mode = 'corner'; }
      else if (C && C[2] < -0.05 && C[3] < -0.05 && Math.hypot(C[0] - mid[0], C[1] - mid[1]) < 45) { outer = [[C[0], C[1]]]; mode = 'nose'; }
      else {
        // follow the rim at sidewalk width: outward normals of the (counter-clockwise) rim, averaged at its points
        const segN = [];
        for (let k = 1; k < run.length; k++) {
          const dx = run[k][0] - run[k - 1][0], dz = run[k][2] - run[k - 1][2], l = Math.hypot(dx, dz) || 1;
          segN.push([dz / l, -dx / l]);
        }
        const off = [];
        let acc = 0;
        for (let k = 0; k < run.length; k++) {
          if (k) acc += Math.hypot(run[k][0] - run[k - 1][0], run[k][2] - run[k - 1][2]);
          const w = WA + (WB - WA) * (acc / (runLen || 1));
          let nx, nz;
          if (k === 0) [nx, nz] = uA;
          else if (k === run.length - 1) [nx, nz] = uB;
          else { nx = segN[k - 1][0] + segN[k][0]; nz = segN[k - 1][1] + segN[k][1]; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; }
          off.push([run[k][0] + nx * w, run[k][2] + nz * w]);
        }
        outer = off.reverse();
        mode = 'strip';
      }
      // heights: the slab top sits 14 cm over the fill (on the junction's plane where it has one)
      const yA = PA[1] + H, yB = PB[1] + H;
      const topAt = (x, z) => {
        if (J.plane) return J.plane.at(x, z) + LIFT + H;
        const da = Math.hypot(x - PA[0], z - PA[2]), db = Math.hypot(x - PB[0], z - PB[2]);
        return (yA * db + yB * da) / (da + db || 1);
      };
      // not over another carriageway (a third road squeezing between the arms, a merging ramp), nor reaching into
      // a carriageway of its own arms (acute corners, arms of very different widths)
      const yRef = (yA + yB) / 2;
      const probe = [...outer, [(PA[0] + OB[0]) / 2, (PA[2] + OB[1]) / 2], [(PB[0] + OA[0]) / 2, (PB[2] + OA[1]) / 2]];
      if (probe.some((r) => R.onOtherRoad(r[0], r[1], yRef, own, 0.1) || R.onOtherRoad(r[0], r[1], yRef, null, -0.25))) continue;
      if (mode !== 'nose' && outer.some((r) => pointInRing(r[0], r[1], ring))) continue;
      // polygon: rim (inner, kerb) PA..PB, then the outer edge back to PA
      const poly = [...run.map((q) => [q[0], q[2], true]), ...outer.map((o) => [o[0], o[1], false])];
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(poly.map(v2), []); } catch { continue; }
      if (!tris.length) continue;
      const b = bget(PA[0], PA[2]);
      if (!b.spos) { b.spos = []; b.snrm = []; b.suv = []; b.sidx = []; }
      if (!b.kpos) { b.kpos = []; b.kidx = []; }
      const base = b.spos.length / 3, kb = b.kpos.length / 3;
      // a crosswalk on either arm: the corner drops flush to the road at that arm's end row (curb ramp flare,
      // continuing the ramp of the arm's sidewalk, Roads.sidewalks)
      const xwA = (R.trims[A.e.i][A.fromA ? 0 : 1]?.code || 0) & CODE.XW, xwB = (R.trims[B.e.i][B.fromA ? 0 : 1]?.code || 0) & CODE.XW;
      const flushAt = (x, z) => (xwA && (Math.hypot(x - PA[0], z - PA[2]) < 0.05 || Math.hypot(x - OA[0], z - OA[1]) < 0.05)) || (xwB && (Math.hypot(x - PB[0], z - PB[2]) < 0.05 || Math.hypot(x - OB[0], z - OB[1]) < 0.05));
      const ys0 = poly.map(([x, z, inner]) => {
        const t = topAt(x, z);
        return inner ? t : Math.max(t, T.heightAt(x, z) + 0.03);
      });
      const ys = poly.map(([x, z], k) => (flushAt(x, z) ? topAt(x, z) - H + 0.015 : ys0[k]));
      poly.forEach(([x, z, inner], k) => {
        b.spos.push(x, ys[k], z); b.snrm.push(0, 1, 0); b.suv.push(0, 1);
        b.kpos.push(x, inner ? ys0[k] - H : ys[k], z);
      });
      for (const [p, q, r] of tris) {
        const ax = poly[q][0] - poly[p][0], az = poly[q][1] - poly[p][1], bx = poly[r][0] - poly[p][0], bz = poly[r][1] - poly[p][1];
        const up = az * bx - ax * bz > 0; // faces up (+y) in the (x, z) plane
        if (up) { b.sidx.push(base + p, base + q, base + r); b.kidx.push(kb + p, kb + q, kb + r); } else { b.sidx.push(base + p, base + r, base + q); b.kidx.push(kb + p, kb + r, kb + q); }
      }
      PA.swCorner = true; // Roads.buildMeshes: no rim apron under this corner
      // kerb face along the rim, facing the carriageway
      for (let k = 1; k < run.length; k++) {
        const P = run[k - 1], Q = run[k];
        const L = Math.hypot(Q[0] - P[0], Q[2] - P[2]);
        if (L < 0.02) continue;
        let fx = -(Q[2] - P[2]) / L, fz = (Q[0] - P[0]) / L; // left of the ccw rim = into the fill
        const kbase = b.spos.length / 3;
        const tP = ys[k - 1], tQ = ys[k];
        for (const [r, yy] of [[P, P[1] - 0.05], [P, tP], [Q, Q[1] - 0.05], [Q, tQ]]) { b.spos.push(r[0], yy, r[2]); b.snrm.push(fx, 0, fz); b.suv.push(0, -1); }
        // wound to face the carriageway (left of the counter-clockwise rim)
        b.sidx.push(kbase, kbase + 2, kbase + 1, kbase + 1, kbase + 2, kbase + 3);
      }
      if (mode === 'nose') continue;
      // outer faces down into the ground (no floating slab edge on a slope) and a drivable apron beyond
      const oy = outer.map((o) => (flushAt(o[0], o[1]) ? topAt(o[0], o[1]) - H + 0.015 : Math.max(topAt(o[0], o[1]), T.heightAt(o[0], o[1]) + 0.03)));
      const nOut = (P0, P1) => {
        let ox = P1[1] - P0[1], oz = -(P1[0] - P0[0]);
        const ol = Math.hypot(ox, oz) || 1;
        if (ox * ((P0[0] + P1[0]) / 2 - cx0) + oz * ((P0[1] + P1[1]) / 2 - cz0) < 0) { ox = -ox; oz = -oz; }
        return [ox / ol, oz / ol];
      };
      for (let k = 1; k < outer.length; k++) {
        const P0 = outer[k - 1], P1 = outer[k];
        const t0 = oy[k - 1], t1 = oy[k];
        const g0 = Math.min(t0 - H - 0.05, T.heightAt(P0[0], P0[1]) - 0.25), g1 = Math.min(t1 - H - 0.05, T.heightAt(P1[0], P1[1]) - 0.25);
        const [ox, oz] = nOut(P0, P1);
        const ob = b.spos.length / 3;
        for (const [r, yy] of [[P0, g0], [P0, t0], [P1, g1], [P1, t1]]) { b.spos.push(r[0], yy, r[1]); b.snrm.push(ox, 0, oz); b.suv.push(0, -2); }
        // single-sided, facing away from the node (P0 -> P1 runs either way round: wind by the normal)
        const ux = P1[0] - P0[0], uz = P1[1] - P0[1];
        if (uz * ox - ux * oz > 0) b.sidx.push(ob, ob + 1, ob + 2, ob + 1, ob + 3, ob + 2); else b.sidx.push(ob, ob + 2, ob + 1, ob + 1, ob + 2, ob + 3);
      }
      const ap = [];
      for (let k = 0; k < outer.length; k++) {
        let ux = 0, uz = 0;
        if (k > 0) { const [x, z] = nOut(outer[k - 1], outer[k]); ux += x; uz += z; }
        if (k < outer.length - 1) { const [x, z] = nOut(outer[k], outer[k + 1]); ux += x; uz += z; }
        ap.push([outer[k][0], oy[k], outer[k][1], ux, uz, 0.15, true]);
      }
      R.skirt(b, ap, own);
    }
  }
}

function pointInRing(x, z, P) {
  let inside = false;
  for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
    const xa = P[a][0], za = P[a][2], xb = P[b][0], zb = P[b][2];
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Signal pole spots (US mast arms): for each approach of a signalised junction, the far-side right corner — from the
 * approach lane's right edge straight on across the junction until the line leaves the fill and every
 * carriageway, then 0.8 m further (corner sidewalk / verge). The arm reaches back over the approach lanes; heads
 * face the approaching traffic. Fallback: near side, past the crosswalk. Returns Map(ni -> Map(edge -> spot)).
 */
export function signalSpots(R, LIFT) {
  const out = new Map();
  for (let ni = 0; ni < R.nodes.length; ni++) {
    const J = R.junctions[ni];
    if (!J || !R.isSignalised(ni)) continue;
    const m = new Map();
    for (const a of J.allArms) {
      if (m.has(a.e.i)) continue;
      const s = poleSpot(R, J, a, LIFT);
      if (s) m.set(a.e.i, s);
    }
    out.set(ni, m);
  }
  return out;
}

function groundY(R, J, x, z, LIFT, kerb) {
  const g = R.terrain?.heightAt ? R.terrain.heightAt(x, z) : -1e9;
  const road = (J.plane ? J.plane.at(x, z) : J.center[1]) + LIFT + (kerb ? 0.14 : 0);
  return kerb ? Math.max(g, road) : Math.max(g, road - 0.15);
}

function poleSpot(R, J, a, LIFT) {
  const tx = -a.dx, tz = -a.dz; // straight on through the junction
  const rx = -tz, rz = tx; // driver's right
  const [nx, ny, nz] = J.center;
  const lat = a.hw + 1.1;
  let d0 = 2.5;
  for (const b of J.allArms) if (b !== a && Math.abs(b.dx * tx + b.dz * tz) < 0.7) d0 = Math.max(d0, b.hw);
  const kerb = J.allArms.some((b) => R.sidewalkWidth(b.e) > 0);
  for (let d = d0; d < 48; d += 1) {
    const x = nx + rx * lat + tx * d, z = nz + rz * lat + tz * d;
    if (pointInRing(x, z, J.ring) || R.onOtherRoad(x, z, ny, null, 0.5)) continue;
    const px = x + tx * 0.8, pz = z + tz * 0.8;
    if (pointInRing(px, pz, J.ring) || R.onOtherRoad(px, pz, ny, null, 0.4)) continue;
    return { x: px, y: groundY(R, J, px, pz, LIFT, kerb), z: pz, yaw: Math.atan2(-tx, -tz), far: true };
  }
  // near side: on the approach's right kerb, past the crosswalk
  const tr = R.trims[a.e.i][a.fromA ? 0 : 1];
  const s = (tr?.t || 0) + MARK.XW1 + 0.8;
  if (s > a.e.len * 0.6) return null;
  const p = R.pointAt(a.e, a.fromA ? s : a.e.len - s);
  const ox = a.fromA ? p.tx : -p.tx, oz = a.fromA ? p.tz : -p.tz;
  const x = p.x + oz * (p.w / 2 + 1.0), z = p.z - ox * (p.w / 2 + 1.0);
  return { x, y: groundY(R, J, x, z, LIFT, kerb), z, yaw: Math.atan2(ox, oz), far: false };
}

/** Stop signs: right of every stop-controlled approach (not at signals), level with its stop bar. */
export function signSpots(R, LIFT) {
  const out = [];
  for (let ni = 0; ni < R.nodes.length; ni++) {
    const J = R.junctions[ni], C = R.control?.[ni];
    if (!J || !C || C.type === 'signal' || C.type === 'none') continue;
    for (const a of J.allArms) {
      const end = a.fromA ? 0 : 1;
      const tr = R.trims[a.e.i][end];
      if (!tr || !(tr.code & CODE.STOP)) continue;
      const s = tr.t + stopBarAt(tr.code)[1] + 0.3;
      if (s > a.e.len * 0.7) continue;
      const p = R.pointAt(a.e, a.fromA ? s : a.e.len - s);
      const ox = a.fromA ? p.tx : -p.tx, oz = a.fromA ? p.tz : -p.tz; // outward; traffic travels -o
      const sw = R.sidewalkWidth(a.e);
      const off = p.w / 2 + (sw ? 0.6 : 1.2);
      // driver's right for traffic travelling (-ox, -oz) is (oz, -ox)
      const x = p.x + oz * off, z = p.z - ox * off;
      if (R.onOtherRoad(x, z, p.y, a.e, 0.3)) continue;
      const g = R.terrain?.heightAt ? R.terrain.heightAt(x, z) : p.y;
      const y = sw ? p.y + LIFT + 0.14 : Math.min(p.y, Math.max(g, p.y - 1.5));
      out.push({ x, y, z, yaw: Math.atan2(ox, oz) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Keep the ground under the junction surfaces. The data pipeline (tools/export.py) lowers the 8 m heightfield
 * under every ribbon and its own model of the junction fills; the kerb returns reach further into the corners, so
 * here the drawn + physics ground is lowered (least change, on Terrain.heightAt's triangle split) wherever it comes
 * within `margin` of: the fills (plane / fan), the arms' first metres while their end rows tilt onto the plane,
 * and the corner sidewalks (rim height). Returns the number of vertices lowered.
 */
export function conformJunctionGround(R, LIFT) {
  const T = R.terrain;
  if (!T?.h || !T.heightAt) return 0;
  const S = []; // x, z, y (surface), margin - only samples where the ground is too high now
  const add = (x, z, y, m) => { if (T.heightAt(x, z) > y - m - 0.002) S.push(x, z, y, m); };
  for (let ni = 0; ni < R.nodes.length; ni++) {
    const J = R.junctions[ni];
    if (!J || !J.ring?.length) continue;
    if (J.allArms.some((a) => a.e.tunnel || a.e.lifted || R.endFrame[a.e.i][a.fromA ? 0 : 1]?.isB)) continue;
    const ring = J.ring, [cx, cy, cz] = J.center;
    const apex = cy + LIFT;
    const surf = (x, z) => {
      if (J.plane) return J.plane.at(x, z) + LIFT;
      for (let i = 0, n = ring.length; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const d = (p[2] - q[2]) * (cx - q[0]) + (q[0] - p[0]) * (cz - q[2]);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((p[2] - q[2]) * (x - q[0]) + (q[0] - p[0]) * (z - q[2])) / d;
        const l2 = ((q[2] - cz) * (x - q[0]) + (cx - q[0]) * (z - q[2])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * apex + l2 * p[1] + l3 * q[1];
      }
      return apex;
    };
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const q of ring) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
    if ((x1 - x0) * (z1 - z0) > 160 * 160) continue;
    // ground minus a (piecewise) planar fill is piecewise linear: its maximum over the fill lies on the terrain's
    // own vertices inside, on the rim's corners or where the rim crosses grid lines (rim sampled every 2 m)
    const hs = T.hs;
    for (let gx = Math.ceil((x0 - T.x0) / hs); T.x0 + gx * hs <= x1; gx++) for (let gz = Math.ceil((z0 - T.z0) / hs); T.z0 + gz * hs <= z1; gz++) {
      const x = T.x0 + gx * hs, z = T.z0 + gz * hs;
      if (pointInRing(x, z, ring)) add(x, z, surf(x, z), 0.06);
    }
    for (let i = 0, n = ring.length; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n];
      const L = Math.hypot(q[0] - p[0], q[2] - p[2]), m = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k < m; k++) {
        const t = k / m, x = p[0] + (q[0] - p[0]) * t, z = p[2] + (q[2] - p[2]) * t;
        add(x + (cx - x) * 0.02, z + (cz - z) * 0.02, p[1] + (q[1] - p[1]) * t, 0.06);
      }
    }
    // arms: from the node out past the end row while it tilts onto the plane (Roads.ribbon blends it back)
    for (const a of J.allArms) {
      const f = R.endFrame[a.e.i][a.fromA ? 0 : 1];
      const t = R.trims[a.e.i][a.fromA ? 0 : 1]?.t || 0;
      if (a.e.internal) continue;
      const L = Math.min(a.e.len * 0.5, t + (f?.tiltD || 0) + 4);
      for (let s = 0; s <= L; s += 3) {
        const p = R.pointAt(a.e, a.fromA ? s : a.e.len - s);
        const nx = -p.tz, nz = p.tx, hw = p.w / 2;
        let u = 0;
        if (s > t && f?.tiltD) { u = Math.max(0, (s - t) / f.tiltD); u = u >= 1 ? 0 : 1 - u * u * (3 - 2 * u); } else if (s <= t) u = 1;
        for (const k of [-1.05, 0, 1.05]) {
          const x = p.x + nx * hw * k, z = p.z + nz * hw * k;
          let y;
          if (s <= t) y = J.plane ? J.plane.at(x, z) + LIFT : surf(x, z);
          else {
            // lateral offset blend of the tilted end row (l side at k = +1 in the edge's a->b frame)
            const side = k * (a.fromA ? 1 : 1);
            const off = f ? ((f.dl || 0) * (1 + side) + (f.dr || 0) * (1 - side)) / 2 : 0;
            y = p.y + LIFT + off * u;
          }
          add(x, z, Math.min(y, p.y + LIFT), 0.06);
        }
      }
    }
  }
  bulbSamples(R, add);
  return conformGround(T, S);
}

/** Lower heightfield vertices so the ground at every sample (x, z, y, margin) lies >= margin under y. */
export function conformGround(T, S) {
  const W = T.gw + 1, hs = T.hs, h = T.h;
  const n = S.length / 4;
  const vi = new Int32Array(n * 3), bw = new Float32Array(n * 3), tg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let fx = (S[4 * i] - T.x0) / hs, fz = (S[4 * i + 1] - T.z0) / hs;
    fx = Math.max(0, Math.min(T.gw - 1e-4, fx)); fz = Math.max(0, Math.min(T.gh - 1e-4, fz));
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    if (tx + tz <= 1) {
      vi[3 * i] = iz * W + ix; vi[3 * i + 1] = iz * W + ix + 1; vi[3 * i + 2] = (iz + 1) * W + ix;
      bw[3 * i] = 1 - tx - tz; bw[3 * i + 1] = tx; bw[3 * i + 2] = tz;
    } else {
      vi[3 * i] = (iz + 1) * W + ix + 1; vi[3 * i + 1] = (iz + 1) * W + ix; vi[3 * i + 2] = iz * W + ix + 1;
      bw[3 * i] = tx + tz - 1; bw[3 * i + 1] = 1 - tx; bw[3 * i + 2] = 1 - tz;
    }
    tg[i] = S[4 * i + 2] - S[4 * i + 3];
  }
  let list = [];
  for (let i = 0; i < n; i++) list.push(i);
  const touched = new Set();
  const want = new Map();
  for (let it = 0; it < 40 && list.length; it++) {
    want.clear();
    const bad = [];
    for (const i of list) {
      const a = vi[3 * i], b = vi[3 * i + 1], c = vi[3 * i + 2];
      const wa = bw[3 * i], wb = bw[3 * i + 1], wc = bw[3 * i + 2];
      const exc = h[a] * wa + h[b] * wb + h[c] * wc - tg[i];
      if (exc <= 0.002) continue;
      bad.push(i);
      if (it < 32) {
        const s2 = wa * wa + wb * wb + wc * wc;
        for (const [v, w] of [[a, wa], [b, wb], [c, wc]]) {
          const nh = h[v] - ((exc + 0.01) * w) / s2;
          const cur = want.get(v);
          if (cur === undefined || nh < cur) want.set(v, nh);
        }
      } else {
        for (const v of [a, b, c]) {
          const nh = h[v] - exc - 0.01;
          const cur = want.get(v);
          if (cur === undefined || nh < cur) want.set(v, nh);
        }
      }
    }
    for (const [v, nh] of want) if (nh < h[v]) { h[v] = nh; touched.add(v); }
    list = bad;
  }
  if (touched.size && T.heightTex) T.heightTex.needsUpdate = true;
  return touched.size;
}

// ---------------------------------------------------------------------------------------------------------------
// fill surface height of junction J at (x, z): its plane, else the fan from the node over the rim
export function fillY(J, x, z, LIFT) {
  if (J.plane) return J.plane.at(x, z) + LIFT;
  const ring = J.ring, [cx, cy, cz] = J.center, apex = (J.apex ?? cy + LIFT);
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const d = (p[2] - q[2]) * (cx - q[0]) + (q[0] - p[0]) * (cz - q[2]);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((p[2] - q[2]) * (x - q[0]) + (q[0] - p[0]) * (z - q[2])) / d;
    const l2 = ((q[2] - cz) * (x - q[0]) + (cx - q[0]) * (z - q[2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * apex + l2 * p[1] + l3 * q[1];
  }
  return apex;
}

/** the junction whose fill contains (x, z) near height y, or null */
export function junctionAt(R, x, z, y = null) {
  for (const J of R.jList(x, z)) {
    if (y !== null && Math.abs(J.center[1] - y) > 3) continue;
    if (pointInRing(x, z, J.ring)) return J;
  }
  return null;
}

// render-only decal triangles in the road mesh of bucket b (Roads.buildMeshes appends them after physics):
// verts [x, y, z, u, v], kind 5 white / 6 yellow, mode 0 hatch, 1 solid, 2 chevrons
function pushDecal(b, verts, tris, kind, mode) {
  if (!b.dpos) { b.dpos = []; b.dlane = []; b.dinfo = []; b.dend = []; b.didx = []; }
  const base = b.dpos.length / 3;
  for (const v of verts) { b.dpos.push(v[0], v[1], v[2]); b.dlane.push(v[3], v[4]); b.dinfo.push(kind, mode, 0, 0); b.dend.push(99, 99, 0, 0); }
  for (const [i, j, k] of tris) {
    const A = verts[i], B = verts[j], C = verts[k];
    const up = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]) > 0;
    if (up) b.didx.push(base + i, base + j, base + k); else b.didx.push(base + i, base + k, base + j);
  }
}

// one Chaikin pass (rounds a pixel outline into a kerb line)
function chaikin(P) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length];
    out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
  }
  return out;
}

// polylines the AI's turns through junction J could take (Traffic.planTurn: from nodeR + 2.5 on the way in, lane
// centres, quadratic through the tangents' meeting) - islands they would cross are painted, not raised
function aiTurns(R, ni, J) {
  const out = [];
  const rN = R.nodeR[ni] + 2.5;
  const lanes = (e) => {
    const n = e.oneway ? Math.max(1, Math.min(4, Math.round(e.w / 3.7))) : e.kind === 1 ? Math.max(1, Math.min(3, Math.round(e.w / 7.4))) : e.kind === 2 ? 1 : e.w >= 12.5 ? 2 : 1;
    const w = (e.oneway ? e.w : e.w / 2) / n;
    const o = [];
    for (let l = 0; l < n; l++) o.push(e.oneway ? (l + 0.5) * w - e.w / 2 : (l + 0.5) * w);
    return o;
  };
  for (const A of J.allArms) for (const B of J.allArms) {
    if (A === B || A.e.internal && B.e.internal) continue;
    if (!R.allowedFrom(A.e, A.fromA ? A.e.b : A.e.a) || !R.allowedFrom(B.e, B.fromA ? B.e.a : B.e.b)) continue;
    const pa = R.pointAt(A.e, A.fromA ? Math.min(rN, A.e.len) : A.e.len - Math.min(rN, A.e.len));
    const sB = Math.min(rN, B.e.len * 0.4);
    const pb = R.pointAt(B.e, B.fromA ? sB : B.e.len - sB);
    const t0x = A.fromA ? -pa.tx : pa.tx, t0z = A.fromA ? -pa.tz : pa.tz; // travel into the node
    const t2x = B.fromA ? pb.tx : -pb.tx, t2z = B.fromA ? pb.tz : -pb.tz; // travel out
    const oa = lanes(A.e), ob = lanes(B.e);
    for (const [la, lb] of [[0, 0], [oa.length - 1, ob.length - 1]]) {
      const o0 = oa[la], o2 = ob[Math.min(lb, ob.length - 1)];
      const p0 = [pa.x - t0z * o0, pa.z + t0x * o0], p2 = [pb.x - t2z * o2, pb.z + t2x * o2];
      const d = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
      const c1 = [p0[0] + t0x * d * 0.5, p0[1] + t0z * d * 0.5], c2 = [p2[0] - t2x * d * 0.5, p2[1] - t2z * d * 0.5];
      const p1 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
      const pts = [];
      for (let k = 0; k <= 10; k++) {
        const u = k / 10, m = 1 - u;
        pts.push([m * m * p0[0] + 2 * m * u * p1[0] + u * u * p2[0], m * m * p0[1] + 2 * m * u * p1[1] + u * u * p2[1]]);
      }
      out.push(pts);
    }
  }
  return out;
}

const segPt = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
};

/**
 * Channelising islands, roundabout centres and median tips the source map shows inside junction areas
 * (tools/junction_shapes.py): where the AI's turns stay clear, a raised kerbed island (15 cm, concrete; grass when
 * larger than 40 m2; physics: a mountable ramp from the rim, like the sidewalk corners); where a turn would cross
 * it, a painted island (white hatch with a solid border, flush, render only).
 */
export function junctionIslands(R, bget, LIFT) {
  const stats = { raised: 0, painted: 0, skipped: 0 };
  const turns = new Map();
  const H = 0.15, T = R.terrain;
  const v2 = (q) => new THREE.Vector2(q[0], q[1]);
  for (const raw of R.shapes?.islands || []) {
    let P = raw.map((p) => [p[0], p[1]]);
    let A = 0;
    for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; A += p[0] * q[1] - q[0] * p[1]; }
    if (A < 0) P.reverse();
    A = Math.abs(A) / 2;
    if (A < 15 || A > 2500) { stats.skipped++; continue; }
    let cx = 0, cz = 0;
    for (const p of P) { cx += p[0]; cz += p[1]; }
    cx /= P.length; cz /= P.length;
    const J = junctionAt(R, cx, cz);
    if (!J || J.apex !== undefined || J.allArms.some((a) => a.e.lifted || a.e.tunnel)) { stats.skipped++; continue; }
    P = chaikin(P);
    // mostly on this junction's fill (generalised widths differ from the map's): else leave it
    const inside = P.filter((p) => pointInRing(p[0], p[1], J.ring)).length;
    if (inside < P.length * 0.7) { stats.skipped++; continue; }
    const ni = J.ni ?? J.allArms[0]?.ni;
    if (!turns.has(J)) turns.set(J, aiTurns(R, ni, J));
    let crossed = false;
    for (const path of turns.get(J)) {
      for (const [x, z] of path) {
        if (pointInRing(x, z, P.map((p) => [p[0], 0, p[1]]))) { crossed = true; break; }
        for (let i = 0; i < P.length && !crossed; i++) { const p = P[i], q = P[(i + 1) % P.length]; if (segPt(x, z, p[0], p[1], q[0], q[1]) < 1.1) crossed = true; }
        if (crossed) break;
      }
      if (crossed) break;
    }
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(P.map(v2), []); } catch { stats.skipped++; continue; }
    if (!tris.length) { stats.skipped++; continue; }
    const b = bget(cx, cz);
    const fy = P.map((p) => fillY(J, p[0], p[1], LIFT));
    if (crossed) {
      // painted: inner hatch + a 25 cm solid border band (inset by averaged edge normals)
      const inset = P.map((p, i) => {
        const a = P[(i + P.length - 1) % P.length], c = P[(i + 1) % P.length];
        let nx = -(p[1] - a[1]) - (c[1] - p[1]), nz = (p[0] - a[0]) + (c[0] - p[0]);
        const l = Math.hypot(nx, nz) || 1;
        return [p[0] + (nx / l) * 0.25, p[1] + (nz / l) * 0.25];
      });
      pushDecal(b, inset.map((p, i) => [p[0], fy[i] + 0.02, p[1], p[0], p[1]]), tris, 5, 0);
      const ring = [], rt = [];
      for (let i = 0; i < P.length; i++) { ring.push([P[i][0], fy[i] + 0.02, P[i][1], 0, 0], [inset[i][0], fy[i] + 0.02, inset[i][1], 0, 0]); }
      for (let i = 0; i < P.length; i++) { const a = 2 * i, c = 2 * ((i + 1) % P.length); rt.push([a, c, a + 1], [c, c + 1, a + 1]); }
      pushDecal(b, ring, rt, 5, 1);
      stats.painted++;
      continue;
    }
    // raised island: slab + kerb faces (sidewalk material), physics ramp from the rim
    if (!b.spos) { b.spos = []; b.snrm = []; b.suv = []; b.sidx = []; }
    if (!b.kpos) { b.kpos = []; b.kidx = []; }
    const code = A > 40 ? -4 : 1; // grass top, or concrete
    const base = b.spos.length / 3, kb = b.kpos.length / 3;
    P.forEach((p, i) => { b.spos.push(p[0], fy[i] + H, p[1]); b.snrm.push(0, 1, 0); b.suv.push(0, code); b.kpos.push(p[0], fy[i], p[1]); });
    let ix = 0, iz = 0;
    for (const p of P) { ix += p[0]; iz += p[1]; }
    for (const [p, q, r] of tris) {
      const ax = P[q][0] - P[p][0], az = P[q][1] - P[p][1], bx = P[r][0] - P[p][0], bz = P[r][1] - P[p][1];
      const up = az * bx - ax * bz > 0;
      if (up) { b.sidx.push(base + p, base + q, base + r); } else { b.sidx.push(base + p, base + r, base + q); }
    }
    // physics: a ramp from the rim up to a raised core (the island's centroid at slab height)
    const kc = b.kpos.length / 3;
    const ccx = ix / P.length, ccz = iz / P.length;
    b.kpos.push(ccx, fillY(J, ccx, ccz, LIFT) + H, ccz);
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const up = (p[1] - ccz) * (q[0] - ccx) - (p[0] - ccx) * (q[1] - ccz) > 0;
      b.kidx.push(kc, kb + (up ? i : (i + 1) % P.length), kb + (up ? (i + 1) % P.length : i));
    }
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const nx = (q[1] - p[1]) / L, nz = -(q[0] - p[0]) / L; // outward of a ccw outline
      const k0 = b.spos.length / 3;
      for (const [r, yy] of [[p, fy[i] - 0.05], [p, fy[i] + H], [q, fy[(i + 1) % P.length] - 0.05], [q, fy[(i + 1) % P.length] + H]]) { b.spos.push(r[0], yy, r[1]); b.snrm.push(nx, 0, nz); b.suv.push(0, -1); }
      b.sidx.push(k0, k0 + 2, k0 + 1, k0 + 1, k0 + 2, k0 + 3, k0, k0 + 1, k0 + 2, k0 + 1, k0 + 3, k0 + 2);
    }
    stats.raised++;
  }
  R.islandStats = stats;
  return stats;
}

/**
 * Gore areas between two highway carriageways forking at a node (diverge / merge): from the point where their
 * inner edges meet to the nose at the end rows, white chevrons inside solid edge lines (render only, on the fill).
 */
export function goreDecals(R, bget, LIFT) {
  let n = 0;
  for (const J of R.junctions) {
    if (!J?.wedges) continue;
    const arms = J.allArms, m = arms.length;
    J.wedges.forEach((W, i) => {
      if (!W.gore) return;
      const A = arms[i], B = arms[(i + 1) % m];
      if (!A.cL || !B.cR) return;
      const edge = (a, s, side) => {
        const p = R.pointAt(a.e, a.fromA ? s : a.e.len - s);
        const ox = a.fromA ? p.tx : -p.tx, oz = a.fromA ? p.tz : -p.tz, hw = p.w / 2;
        return [p.x - oz * hw * side, p.z + ox * hw * side];
      };
      const VA = edge(A, Math.min(W.gore.ta, A.t - 0.5), 1), VB = edge(B, Math.min(W.gore.tb, B.t - 0.5), -1);
      const V = [(VA[0] + VB[0]) / 2, (VA[1] + VB[1]) / 2];
      const PA = [A.cL[0], A.cL[2]], PB = [B.cR[0], B.cR[2]];
      const M = [(PA[0] + PB[0]) / 2, (PA[1] + PB[1]) / 2];
      let ax = M[0] - V[0], az = M[1] - V[1];
      const L = Math.hypot(ax, az);
      if (L < 1.5 || Math.hypot(PA[0] - PB[0], PA[1] - PB[1]) < 0.8) return;
      ax /= L; az /= L;
      const uv = (p) => [(p[0] - V[0]) * -az + (p[1] - V[1]) * ax, (p[0] - V[0]) * ax + (p[1] - V[1]) * az];
      const y = (p) => fillY(J, p[0], p[1], LIFT) + 0.02;
      const b = bget(M[0], M[1]);
      const vert = (p) => [p[0], y(p), p[1], ...uv(p)];
      pushDecal(b, [vert(V), vert(PA), vert(PB)], [[0, 1, 2]], 5, 2);
      // solid edge lines along both sides (25 cm, inside the triangle)
      for (const P of [PA, PB]) {
        const ex = P[0] - V[0], ez = P[1] - V[1], el = Math.hypot(ex, ez) || 1;
        let nx = -ez / el, nz = ex / el;
        if (nx * (M[0] - P[0]) + nz * (M[1] - P[1]) < 0) { nx = -nx; nz = -nz; }
        const V2 = [V[0] + nx * 0.25, V[1] + nz * 0.25], P2 = [P[0] + nx * 0.25, P[1] + nz * 0.25];
        pushDecal(b, [vert(V), vert(P), vert(P2), vert(V2)], [[0, 1, 2], [0, 2, 3]], 5, 1);
      }
      n++;
    });
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Dead ends (tools/export.py `roads.ends`: {n, end, r?}): cul-de-sac bulbs, water stops, paved blends.

/** plan the bulbs once the end rows exist (before the ground conform): R.bulbs[ni] = {cx, cz, y, r, ox, oz, f, e, end} */
export function planDeadEnds(R) {
  R.bulbs = new Map();
  for (const [ni, info] of R.endInfo || []) {
    if (info.end !== 'cds' || !(info.r > 0) || R.adj[ni]?.length !== 1) continue;
    const e = R.edges[R.adj[ni][0]];
    const end = e.a === ni ? 0 : 1;
    const f = R.endFrame[e.i]?.[end];
    if (!f || e.a === e.b || e.kind === 2 || e.br || e.tunnel || e.airside || e.lifted) continue;
    const hw = f.hw * (f.ms || 1);
    const r = Math.min(Math.max(info.r, hw + 1.5), 20);
    const ox = end ? f.tx : -f.tx, oz = end ? f.tz : -f.tz;
    const mx = (f.l[0] + f.r[0]) / 2, mz = (f.l[2] + f.r[2]) / 2, y = (f.l[1] + f.r[1]) / 2;
    const d = Math.sqrt(r * r - hw * hw); // the circle passes through both end-row corners
    const cx = mx + ox * d, cz = mz + oz * d;
    // room for it: no other carriageway inside, the ground there (not the sea)
    let ok = R.terrain?.heightAt ? R.terrain.heightAt(cx, cz) > 0.3 : true;
    for (let k = 0; k < 12 && ok; k++) {
      const a = (k / 12) * Math.PI * 2, px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
      if (R.onOtherRoad(px, pz, y, e, 0.3) || R.inJunction(px, pz, y)) ok = false;
    }
    if (ok) R.bulbs.set(ni, { cx, cz, y, r, ox, oz, f, e, end, hw });
  }
}

/** ground samples under the bulbs (for conformGround) */
export function bulbSamples(R, add) {
  for (const B of R.bulbs?.values() || []) {
    for (let rr = 0; rr <= B.r + 0.5; rr += 2.5) for (let k = 0, m = Math.max(1, Math.ceil((rr * 6.3) / 3)); k < m; k++) {
      const a = (k / m) * Math.PI * 2;
      add(B.cx + Math.cos(a) * Math.min(rr, B.r), B.cz + Math.sin(a) * Math.min(rr, B.r), B.y, 0.06);
    }
  }
}

// arc points (x, z) of bulb B from its end row's l corner round the far side to r
function bulbArc(B) {
  const { f, cx, cz, r } = B;
  const a0 = Math.atan2(f.l[2] - cz, f.l[0] - cx), a1 = Math.atan2(f.r[2] - cz, f.r[0] - cx);
  // the far side: the way round that passes the point straight ahead (centre + o r)
  const af = Math.atan2(B.oz, B.ox);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let d = norm(a1 - a0);
  if (norm(af - a0) > d) d -= 2 * Math.PI; // go the other way
  const m = Math.max(8, Math.ceil(Math.abs(d) / 0.3));
  const out = [];
  for (let k = 1; k < m; k++) { const a = a0 + (d * k) / m; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r, a]); }
  return out;
}

/**
 * Draw a dead end at node ni (deg 1). Returns true when handled here (cul-de-sac bulb, water stop, paved blend),
 * false for the plain rounded cap. push/tri append to the road bucket (fill attributes), as Roads' fans do.
 */
export function deadEnd(R, ni, bget, LIFT, kind) {
  const info = R.endInfo?.get(ni);
  if (!info) return false;
  const e = R.edges[R.adj[ni][0]], end = e.a === ni ? 0 : 1, f = R.endFrame[e.i]?.[end];
  if (!f) return false;
  if (info.end === 'paved') return true; // the asphalt ends flush into the paving around it: a straight cut
  if (info.end === 'water') { waterStop(R, e, end, f, bget); return true; }
  const B = R.bulbs?.get(ni);
  if (!B) return false;
  const arc = bulbArc(B);
  const b = bget(B.cx, B.cz), base = b.pos.length / 3;
  const ring = [f.l, ...arc.map(([x, z]) => [x, B.y, z]), f.r];
  const push = (q) => { b.pos.push(q[0], q[1], q[2]); b.lane.push(0, 0); b.info.push(kind, 30, 1, 0); b.end.push(99, 99, 0, 0); };
  push([B.cx, B.y, B.cz]);
  ring.forEach(push);
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const up = (p[2] - B.cz) * (q[0] - B.cx) - (p[0] - B.cx) * (q[2] - B.cz) > 0;
    b.idx.push(base, base + 1 + (up ? i : (i + 1) % n), base + 1 + (up ? (i + 1) % n : i));
  }
  const W = R.sidewalkWidth(e), T = R.terrain, H = 0.14;
  const out = (x, z) => { const dx = x - B.cx, dz = z - B.cz, l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  if (W) {
    // kerb + sidewalk round the bulb, joined to the street's own sidewalks at the end row
    if (!b.spos) { b.spos = []; b.snrm = []; b.suv = []; b.sidx = []; }
    if (!b.kpos) { b.kpos = []; b.kidx = []; }
    const pts = [[f.l[0], f.l[2]], ...arc, [f.r[0], f.r[2]]];
    let prev = -1, prevK = -1;
    const apr = [];
    for (const [x, z] of pts) {
      const [ux, uz] = out(x, z);
      const ox_ = x + ux * W, oz_ = z + uz * W;
      const to = Math.max(B.y + H, T.heightAt(ox_, oz_) + 0.03), gb = Math.min(B.y - 0.05, T.heightAt(ox_, oz_) - 0.25);
      const vb = b.spos.length / 3;
      b.spos.push(x, B.y - 0.05, z, x, B.y + H, z, x, B.y + H, z, ox_, to, oz_, ox_, to, oz_, ox_, gb, oz_);
      b.snrm.push(-ux, 0, -uz, -ux, 0, -uz, 0, 1, 0, 0, 1, 0, ux, 0, uz, ux, 0, uz);
      b.suv.push(0, -1, 0, -1, 0, 0, 0, W, 0, -2, 0, -2);
      const kb = b.kpos.length / 3;
      b.kpos.push(x, B.y - 0.05, z, x, B.y + H, z, ox_, to, oz_);
      apr.push([ox_, to, oz_, ux, uz, 0.15, true]);
      if (prev >= 0) {
        const P = b.spos, ax = P[3 * vb] - P[3 * prev], az = P[3 * vb + 2] - P[3 * prev + 2];
        const ccw = ax * uz - az * ux > 0; // walking round with the outside on the left/right
        // outside on the left of the walk: the street sidewalks' left-side winding (Roads.sidewalks, side > 0)
        const q = (a0, a1, b0, b1) => (ccw ? b.sidx.push(a0, a1, b0, a1, b1, b0) : b.sidx.push(a0, b0, a1, a1, b0, b1));
        q(prev, prev + 1, vb, vb + 1); q(prev + 2, prev + 3, vb + 2, vb + 3); q(prev + 4, prev + 5, vb + 4, vb + 5);
        b.kidx.push(prevK, kb, prevK + 1, prevK + 1, kb, kb + 1, prevK + 1, kb + 1, prevK + 2, prevK + 2, kb + 1, kb + 2);
        b.kidx.push(prevK, prevK + 1, kb, prevK + 1, kb + 1, kb, prevK + 1, prevK + 2, kb + 1, prevK + 2, kb + 2, kb + 1);
      }
      prev = vb; prevK = kb;
    }
    R.skirt(b, apr, e);
  } else {
    // no sidewalk: an apron round the rim down to the ground
    const pts = [[f.l[0], f.l[2]], ...arc, [f.r[0], f.r[2]]].map(([x, z]) => { const [ux, uz] = out(x, z); return [x, B.y, z, ux, uz, 0.15, true]; });
    R.skirt(b, pts, e);
  }
  return true;
}

// water end: a low concrete kerb wall across the end row with three bollards, in the road physics
function waterStop(R, e, end, f, bget) {
  const b = bget(f.l[0], f.l[2]);
  if (!b.bpos) { b.bpos = []; b.bidx = []; b.ppos = []; b.pidx = []; b.pillars = []; }
  const ox = end ? f.tx : -f.tx, oz = end ? f.tz : -f.tz;
  const y = (f.l[1] + f.r[1]) / 2;
  const box = (x, z, hx, hz, h, ax, az) => {
    // oriented box: half extents hx along (ax, az), hz across, height h from y - 0.1
    const px = -az, pz = ax, i0 = b.bpos.length / 3;
    for (const [sa, sp] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) for (const yy of [y - 0.1, y + h]) b.bpos.push(x + ax * hx * sa + px * hz * sp, yy, z + az * hx * sa + pz * hz * sp);
    const Q = [[0, 2, 4, 6], [1, 7, 5, 3], [0, 1, 3, 2], [2, 3, 5, 4], [4, 5, 7, 6], [6, 7, 1, 0]];
    for (const [a, c, d, g] of Q) b.bidx.push(i0 + a, i0 + c, i0 + d, i0 + a, i0 + d, i0 + g, i0 + a, i0 + d, i0 + c, i0 + a, i0 + g, i0 + d);
    const k0 = b.ppos.length / 3;
    for (let k = 0; k < 8; k++) b.ppos.push(b.bpos[3 * (i0 + k)], b.bpos[3 * (i0 + k) + 1], b.bpos[3 * (i0 + k) + 2]);
    for (const [a, c, d, g] of Q) b.pidx.push(k0 + a, k0 + c, k0 + d, k0 + a, k0 + d, k0 + g);
  };
  const mx = (f.l[0] + f.r[0]) / 2 + ox * 0.4, mz = (f.l[2] + f.r[2]) / 2 + oz * 0.4;
  const lx = f.l[0] - f.r[0], lz = f.l[2] - f.r[2], L = Math.hypot(lx, lz) || 1;
  box(mx, mz, L / 2 + 0.3, 0.25, 0.55, lx / L, lz / L); // kerb wall
  for (const t of [-0.35, 0, 0.35]) box(mx - ox * 0.9 + (lx / L) * L * t, mz - oz * 0.9 + (lz / L) * L * t, 0.13, 0.13, 0.95, lx / L, lz / L); // bollards
}
