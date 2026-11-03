import { K, LOD, rng, obb, hull2d } from '../kit.js';
import { L } from '../lights.js';
import { mast, fenceLine, signQuad } from '../parts.js';
import { FONT } from '../atlas.js';

// Open-air sports grounds painted on the source map: football pitches, an American-football stadium with a
// running track, a baseball diamond, tennis courts, golf greens / fairways, and the raceway grandstands.
// The playing surfaces follow the ground: the sport-class texels of the terrain are flooded from the POI and
// fitted with a rectangle (or a fan for the diamond); turf and markings are thin decals draped on the terrain
// (ctx.paint, polygon offset), so one draw call per cluster carries every line.

const WHITE = 0xf4f4f0;

// ---------- ground helpers ----------

// texel centres of the connected region of ground classes `cls` nearest to (x,z) (within r), flood limited
// to `reach` around the seed -> [[x, z], ...] or null
export function groundRegion(ctx, x, z, cls, { r = 120, reach = 400 } = {}) {
  const T = ctx.terrain;
  if (!T?.ground || !T.G) return null;
  const ts = T.ts, tw = T.tw, th = T.th, ground = T.ground;
  const want = new Uint8Array(256);
  for (const c of cls) if (T.G[c] != null) want[T.G[c]] = 1;
  const ci = Math.floor((x - T.x0) / ts), cj = Math.floor((z - T.z0) / ts);
  const R = Math.ceil(r / ts);
  let seed = -1, bd = Infinity;
  for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
    if (i < 0 || j < 0 || i >= tw || j >= th || !want[ground[j * tw + i]]) continue;
    const d = (i - ci) ** 2 + (j - cj) ** 2;
    if (d < bd) { bd = d; seed = j * tw + i; }
  }
  if (seed < 0) return null;
  const RR = Math.ceil(reach / ts), si = seed % tw, sj = (seed - si) / tw, WW = 2 * RR + 1;
  const seen = new Uint8Array(WW * WW), queue = [seed], pts = [];
  const mark = (i, j) => { const k = (j - sj + RR) * WW + (i - si + RR); if (seen[k]) return false; seen[k] = 1; return true; };
  mark(si, sj);
  while (queue.length) {
    const k = queue.pop(), i = k % tw, j = (k - i) / tw;
    pts.push([T.x0 + (i + 0.5) * ts, T.z0 + (j + 0.5) * ts]);
    for (let d = 0; d < 4; d++) {
      const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0), nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (ni < 0 || nj < 0 || ni >= tw || nj >= th || Math.abs(ni - si) > RR || Math.abs(nj - sj) > RR) continue;
      if (!want[ground[nj * tw + ni]] || !mark(ni, nj)) continue;
      queue.push(nj * tw + ni);
    }
  }
  return pts;
}

// fitted rectangle of a region: {cx, cz, ux, uz, len, wid} (u along the long side); texel centres -> edges
function fitRect(pts, ts = 4) {
  const o = obb(pts);
  if (!o) return null;
  return { ...o, len: o.len + ts, wid: o.wid + ts };
}

// local frame: (u, v) -> world [x, z]
function frame(cx, cz, ux, uz) {
  return { cx, cz, ux, uz, at: (u, v) => [cx + ux * u - uz * v, cz + uz * u + ux * v] };
}

// one upward-facing draped quad / triangle (points [x, z], uvs)
function upFace(b, P, yAt, lift, uvs) {
  let a = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; }
  // CCW seen from above (+y) means clockwise in (x, z) with z pointing down-screen: keep a < 0
  // layers 5+ cm apart at the far end of the depth buffer still fight: lifts are scaled up
  let pts = P.map(([x, z]) => [x, yAt(x, z) + lift * 2.2, z]), uv = uvs;
  if (a > 0) { pts = [pts[0], ...pts.slice(1).reverse()]; uv = uvs && [uvs[0], ...uvs.slice(1).reverse()]; }
  b.face(pts, uv);
}

// rectangle u0..u1 x v0..v1 of frame F draped as a grid (uv = local metres)
function drape(b, F, u0, u1, v0, v1, yAt, { lift = 0.05, step = 8 } = {}) {
  const nu = Math.max(1, Math.ceil((u1 - u0) / step)), nv = Math.max(1, Math.ceil((v1 - v0) / step));
  for (let i = 0; i < nu; i++) {
    const ua = u0 + ((u1 - u0) * i) / nu, ub = u0 + ((u1 - u0) * (i + 1)) / nu;
    for (let j = 0; j < nv; j++) {
      const va = v0 + ((v1 - v0) * j) / nv, vb = v0 + ((v1 - v0) * (j + 1)) / nv;
      upFace(b, [F.at(ua, va), F.at(ub, va), F.at(ub, vb), F.at(ua, vb)], yAt, lift, [[ua, va], [ub, va], [ub, vb], [ua, vb]]);
    }
  }
}

// straight line of width w between local points
function line(b, F, ua, va, ub, vb, w, yAt, lift = 0.09) {
  const L0 = Math.hypot(ub - ua, vb - va);
  if (L0 < 1e-3) return;
  const n = Math.max(1, Math.ceil(L0 / 8)), nu = (-(vb - va) / L0) * (w / 2), nv = ((ub - ua) / L0) * (w / 2);
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n;
    const a0 = ua + (ub - ua) * t0, b0 = va + (vb - va) * t0, a1 = ua + (ub - ua) * t1, b1 = va + (vb - va) * t1;
    upFace(b, [F.at(a0 - nu, b0 - nv), F.at(a1 - nu, b1 - nv), F.at(a1 + nu, b1 + nv), F.at(a0 + nu, b0 + nv)], yAt, lift);
  }
}
const rectLines = (b, F, u0, v0, u1, v1, w, yAt) => {
  line(b, F, u0, v0, u1, v0, w, yAt); line(b, F, u1, v0, u1, v1, w, yAt);
  line(b, F, u1, v1, u0, v1, w, yAt); line(b, F, u0, v1, u0, v0, w, yAt);
};
// arc of radius r around local (cu, cv), angles a0..a1 (0 = +u)
function arc(b, F, cu, cv, r, a0, a1, w, yAt, lift = 0.09) {
  const n = Math.max(3, Math.ceil((Math.abs(a1 - a0) * r) / 2.5));
  for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n, t1 = a0 + ((a1 - a0) * (k + 1)) / n;
    const p = (t, rr) => F.at(cu + Math.cos(t) * rr, cv + Math.sin(t) * rr);
    upFace(b, [p(t0, r - w / 2), p(t1, r - w / 2), p(t1, r + w / 2), p(t0, r + w / 2)], yAt, lift);
  }
}
// filled disc / ellipse (local), draped (fan)
function disc(b, F, cu, cv, ru, rv, yAt, lift = 0.07, seg = 20, rot = 0) {
  const c = F.at(cu, cv);
  const p = (k) => { const t = (k / seg) * Math.PI * 2, a = Math.cos(t) * ru, d = Math.sin(t) * rv; return F.at(cu + a * Math.cos(rot) - d * Math.sin(rot), cv + a * Math.sin(rot) + d * Math.cos(rot)); };
  for (let k = 0; k < seg; k++) upFace(b, [c, p(k), p(k + 1)], yAt, lift);
}

// light masts at local points, heads aimed at local (tu, tv)
function masts(ctx, F, pts, h, tu, tv, yAt, heads = 4) {
  const { b, lights } = ctx;
  for (const [u, v] of pts) {
    const [x, z] = F.at(u, v), [tx, tz] = F.at(tu, tv);
    if (!ctx.clearOfRoads(x, z, 1.5)) continue;
    const yaw = Math.atan2(-(tz - z), tx - x) + Math.PI / 2;
    mast(b, lights, x, z, yAt(x, z), h, { heads, size: 3, yaw });
    b.colCyl(x, z, yAt(x, z), yAt(x, z) + h, 0.5);
  }
}

// face whose normal is turned towards local direction d
function faceTo(b, P, d) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], c = P[(i + 1) % P.length];
    nx += (a[1] - c[1]) * (a[2] + c[2]); ny += (a[2] - c[2]) * (a[0] + c[0]); nz += (a[0] - c[0]) * (a[1] + c[1]);
  }
  b.face(nx * d[0] + ny * d[1] + nz * d[2] < 0 ? [P[0], ...P.slice(1).reverse()] : P);
}

// stepped stand of `rows` rows along local u (u0..u1) rising away from the field towards +v from v0
// (y0 = ground at the front), seats in `color`; covered: roof canopy on back columns
function bleacher(b, F, u0, u1, v0, rows, y0, color, { rowD = 0.85, rowH = 0.42, front = 1.0, covered = false, back = 0xc8ccd0 } = {}) {
  const depth = rows * rowD, top = y0 + front + rows * rowH;
  const yaw = Math.atan2(-F.uz, F.ux);
  b.push();
  const [ox, oz] = F.at(0, 0);
  // local frame: x = u, z = v (rotY(yaw) maps local +x to F.u and local +z to F.v)
  b.translate(ox, 0, oz).rotY(yaw);
  b.paint(back, K.PLAIN);
  b.box(u0, y0, v0, u1, y0 + front, v0 + 0.25);
  for (const u of [u0, u1]) faceTo(b, [[u, y0, v0], [u, y0 + front, v0], [u, top + 1.1, v0 + depth], [u, y0, v0 + depth]], [u === u0 ? -1 : 1, 0, 0]);
  b.paint(0x8e959c, K.METAL); // ribbed steel back sheeting
  b.box(u0, y0, v0 + depth, u1, top + 1.1, v0 + depth + 0.3, 0b111111);
  // rows: tread + riser, seat colour with metal ribs
  b.paint(color, K.METAL);
  for (let r = 0; r < rows; r++) {
    const ya = y0 + front + r * rowH, yb = ya + rowH, va = v0 + r * rowD, vb = va + rowD;
    faceTo(b, [[u0, ya, va], [u1, ya, va], [u1, yb, va], [u0, yb, va]], [0, 0, -1]);
    faceTo(b, [[u0, yb, va], [u1, yb, va], [u1, yb, vb], [u0, yb, vb]], [0, 1, 0]);
  }
  b.colBox(u0, y0, v0, u1, top, v0 + depth);
  if (covered) {
    b.paint(0x8c939a, K.METAL);
    const span = u1 - u0, n = Math.max(2, Math.round(span / 12)), vb = v0 + depth + 0.15;
    for (let i = 0; i <= n; i++) {
      const u = u0 + (span * i) / n;
      b.beam(u, y0, vb, u, top + 5.5, vb, 0.5, 0.5, 0b1111);
      b.beam(u, top + 5.5, vb, u, top + 4.6, v0 - 1.5, 0.35, 0.6, 0b1111);
    }
    b.paint(0xe6e8ea, K.METAL);
    const roof = [[u0, top + 5.9, vb + 0.45], [u1, top + 5.9, vb + 0.45], [u1, top + 4.9, v0 - 2], [u0, top + 4.9, v0 - 2]];
    faceTo(b, roof, [0, 1, 0]);
    faceTo(b, roof.map(([x, y, z]) => [x, y - 0.3, z]), [0, -1, 0]);
    b.paint(0x2a2e33, K.PLAIN);
    b.box(u0, top + 4.4, v0 - 2.05, u1, top + 5.0, v0 - 1.7);
  }
  b.pop();
  return { top, depth };
}

// goal frame (white tubes + net) on local u = gu, opening towards -dir*u, width w, height h
function goal(b, F, gu, gv, dir, w, h, yAt, depth = 2) {
  const P = (u, v) => F.at(gu + u * dir, gv + v);
  const [cx, cz] = P(0, 0), y = yAt(cx, cz);
  const at = (u, v, yy) => { const [x, z] = P(u, v); return [x, y + yy, z]; };
  b.lod = LOD.NEAR;
  b.paint(WHITE, K.PLAIN);
  for (const s of [-1, 1]) { const a = at(0, s * w / 2, 0), c = at(0, s * w / 2, h); b.beam(...a, ...c, 0.12, 0.12, 0b1111); }
  b.beam(...at(0, -w / 2, h), ...at(0, w / 2, h), 0.12, 0.12, 0b1111);
  b.paint(0xd8dcdc, K.FENCE);
  const net = (A, B2, C, D) => { b.face([A, B2, C, D]); b.face([D, C, B2, A]); };
  net(at(0, -w / 2, h), at(0, w / 2, h), at(depth * 0.6, w / 2, h * 0.85), at(depth * 0.6, -w / 2, h * 0.85));
  net(at(depth * 0.6, -w / 2, h * 0.85), at(depth * 0.6, w / 2, h * 0.85), at(depth, w / 2, 0), at(depth, -w / 2, 0));
  for (const s of [-1, 1]) {
    const A = at(0, s * w / 2, 0), B2 = at(0, s * w / 2, h), C = at(depth * 0.6, s * w / 2, h * 0.85), D = at(depth, s * w / 2, 0);
    b.face([A, B2, C, D]); b.face([D, C, B2, A]);
  }
  b.lod = LOD.BOTH;
}

// generic footprints standing on the playing area go (the map paints the ground; the buildings layer may
// still carry a stray block there)
function clearArea(ctx, F, u0, u1, v0, v1) {
  const poly = [F.at(u0, v0), F.at(u1, v0), F.at(u1, v1), F.at(u0, v1)];
  ctx.remove({ poly });
  ctx.hideTrees({ poly });
  return poly;
}

function fitted(ctx, def, cls = ['sport']) {
  const pts = groundRegion(ctx, def.x, def.z, cls, { r: def.seekR || 80, reach: def.reach || 160 });
  if (!pts || pts.length < 8) return null;
  const R = fitRect(pts, ctx.terrain.ts);
  return R && { ...R, pts };
}

// ---------- football (soccer) pitch ----------
export function soccerField(ctx, def) {
  const yAt = (x, z) => ctx.groundY(x, z);
  const R = fitted(ctx, def);
  if (!R) return { skipped: true, why: 'no sport ground' };
  const F = frame(R.cx, R.cz, R.ux, R.uz);
  const s = Math.min(1, (R.len - 6) / 105, (R.wid - 6) / 68);
  const hl = 52.5 * s, hw = 34 * s;
  const { paint, b } = ctx;
  clearArea(ctx, F, -hl - 8, hl + 8, -hw - 8, hw + 8);
  paint.paint(0x4e9a3e, K.GRASS);
  drape(paint, F, -hl - 4, hl + 4, -hw - 4, hw + 4, yAt, { lift: 0.05 });
  paint.paint(WHITE, K.PAINT);
  const w = 0.14;
  rectLines(paint, F, -hl, -hw, hl, hw, w, yAt);
  line(paint, F, 0, -hw, 0, hw, w, yAt);
  arc(paint, F, 0, 0, 9.15 * s, 0, Math.PI * 2, w, yAt);
  disc(paint, F, 0, 0, 0.25, 0.25, yAt, 0.1, 8);
  for (const d of [-1, 1]) {
    const gu = d * hl;
    const pa = 16.5 * s, pw = 20.15 * s, ga = 5.5 * s, gw = 9.16 * s;
    line(paint, F, gu, -pw, gu - d * pa, -pw, w, yAt); line(paint, F, gu - d * pa, -pw, gu - d * pa, pw, w, yAt); line(paint, F, gu - d * pa, pw, gu, pw, w, yAt);
    line(paint, F, gu, -gw, gu - d * ga, -gw, w, yAt); line(paint, F, gu - d * ga, -gw, gu - d * ga, gw, w, yAt); line(paint, F, gu - d * ga, gw, gu, gw, w, yAt);
    const spot = gu - d * 11 * s;
    disc(paint, F, spot, 0, 0.2, 0.2, yAt, 0.1, 8);
    // penalty arc outside the area
    const a = Math.acos(Math.min(1, (pa - 11 * s) / (9.15 * s)));
    arc(paint, F, spot, 0, 9.15 * s, d > 0 ? Math.PI - a : -a, d > 0 ? Math.PI + a : a, w, yAt);
    goal(b, F, gu, 0, d, 7.32 * Math.max(0.8, s), 2.44, yAt);
  }
  // corner flags
  b.lod = LOD.NEAR;
  for (const [u, v] of [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]]) {
    const [x, z] = F.at(u, v), y = yAt(x, z);
    b.paint(0xf0f0f0, K.PLAIN); b.beam(x, y, z, x, y + 1.5, z, 0.05, 0.05, 0b1111);
    b.paint(0xffc020, K.PLAIN); b.face([[x, y + 1.5, z], [x, y + 1.1, z], [x + 0.45, y + 1.3, z]]); b.face([[x + 0.45, y + 1.3, z], [x, y + 1.1, z], [x, y + 1.5, z]]);
  }
  b.lod = LOD.BOTH;
  // stand on the +v side, team shelters on the -v side
  const sideV = def.standSide ?? 1;
  const F2 = sideV > 0 ? F : frame(R.cx, R.cz, -R.ux, -R.uz);
  const [fx, fz] = F2.at(0, hw + 6);
  bleacher(b, F2, -18, 18, hw + 5, 6, yAt(fx, fz) - 0.2, def.seats ?? 0x2f6f9f, { covered: true });
  b.paint(0x30363c, K.PLAIN);
  for (const u of [-7, 7]) {
    b.push();
    const [x, z] = F2.at(u, -hw - 4), y = yAt(x, z);
    b.translate(x, y, z).rotY(Math.atan2(-F2.uz, F2.ux));
    b.paint(0x3a4047, K.PLAIN); b.box(-3, 0, -0.1, 3, 2.2, 0.1); b.box(-3.1, 2.2, -0.2, 3.1, 2.4, 1.6);
    b.paint(0x9fd0ff, K.GLASS, 2); b.box(-3, 0.4, 0, -2.9, 2.2, 1.5); b.box(2.9, 0.4, 0, 3, 2.2, 1.5);
    b.pop();
  }
  masts(ctx, F, [[-hl - 6, -hw - 7], [hl + 6, -hw - 7], [hl + 6, hw + 7], [-hl - 6, hw + 7]], 20, 0, 0, yAt, 4);
  const [vx, vz] = F.at(-hl - 40, -hw - 50);
  ctx.view([vx, yAt(vx, vz) + 34, vz], [R.cx, yAt(R.cx, R.cz), R.cz], 'pitch');
  return { report: { len: +R.len.toFixed(0), wid: +R.wid.toFixed(0), scale: +s.toFixed(2) } };
}

// ---------- American football stadium with a running track ----------
export function footballStadium(ctx, def) {
  const yAt = (x, z) => ctx.groundY(x, z);
  const R = fitted(ctx, def);
  if (!R) return { skipped: true, why: 'no sport ground' };
  const F = frame(R.cx, R.cz, R.ux, R.uz);
  const { paint, b, sign, atlas } = ctx;
  // track: two straights + two bends, 6 lanes
  const lanes = 6, laneW = 1.22, Rout = Math.min(R.wid / 2 - 1, 46), Rin = Rout - lanes * laneW;
  const straight = Math.max(20, Math.min(84.4, R.len - 2 * Rout - 2));
  const hs = straight / 2;
  const fw = Math.min(48.8, 2 * Rin * 0.82), fl = Math.min(109.7, 2 * (hs + Math.sqrt(Math.max(0, (Rin - 1) ** 2 - (fw / 2) ** 2))));
  const hl = fl / 2, hw = fw / 2;
  clearArea(ctx, F, -hs - Rout - 4, hs + Rout + 4, -Rout - 22, Rout + 22);
  // infield turf
  paint.paint(0x4c9a3a, K.GRASS);
  drape(paint, F, -hs - Rin, hs + Rin, -Rin, Rin, yAt, { lift: 0.04 });
  // track surface ring (stadium shape), lanes
  const ringPath = (r) => {
    const pts = [];
    for (let k = 0; k <= 16; k++) { const t = -Math.PI / 2 + (k / 16) * Math.PI; pts.push([hs + Math.cos(t) * r, Math.sin(t) * r]); }
    for (let k = 0; k <= 16; k++) { const t = Math.PI / 2 + (k / 16) * Math.PI; pts.push([-hs + Math.cos(t) * r, Math.sin(t) * r]); }
    pts.push(pts[0]);
    return pts;
  };
  const band = (r0, r1, lift) => {
    const A = ringPath(r0), B2 = ringPath(r1);
    for (let k = 0; k < A.length - 1; k++) {
      const seg = Math.hypot(A[k + 1][0] - A[k][0], A[k + 1][1] - A[k][1]);
      const n = Math.max(1, Math.ceil(seg / 8));
      for (let q = 0; q < n; q++) {
        const t0 = q / n, t1 = (q + 1) / n;
        const lerp = (P, t, k2) => [P[k2][0] + (P[k2 + 1][0] - P[k2][0]) * t, P[k2][1] + (P[k2 + 1][1] - P[k2][1]) * t];
        const a0 = lerp(A, t0, k), a1 = lerp(A, t1, k), b0 = lerp(B2, t0, k), b1 = lerp(B2, t1, k);
        upFace(paint, [F.at(...a0), F.at(...a1), F.at(...b1), F.at(...b0)], yAt, lift);
      }
    }
  };
  paint.paint(0xb4553c, K.PAINT);
  band(Rin, Rout, 0.05);
  paint.paint(WHITE, K.PAINT);
  for (let l = 0; l <= lanes; l++) band(Rin + l * laneW - 0.03, Rin + l * laneW + 0.03, 0.08);
  // field: end zones + yard lines every 5 yards
  const ez = fl * 0.0833, yard = (fl - 2 * ez) / 100;
  paint.paint(def.endzone ?? 0x1f4f8f, K.PAINT);
  drape(paint, F, -hl, -hl + ez, -hw, hw, yAt, { lift: 0.07 });
  drape(paint, F, hl - ez, hl, -hw, hw, yAt, { lift: 0.07 });
  paint.paint(WHITE, K.PAINT);
  rectLines(paint, F, -hl, -hw, hl, hw, 0.2, yAt);
  for (let yd = 0; yd <= 100; yd += 5) {
    const u = -hl + ez + yd * yard;
    line(paint, F, u, -hw, u, hw, yd % 10 === 0 ? 0.16 : 0.1, yAt);
    if (yd % 10 === 0) for (const v of [-hw * 0.38, hw * 0.38]) line(paint, F, u - 0.4, v, u + 0.4, v, 0.12, yAt);
  }
  // logo disc at midfield
  paint.paint(def.logo ?? 0xe0b030, K.PAINT);
  disc(paint, F, 0, 0, 4.2, 4.2, yAt, 0.1, 18);
  // goalposts (yellow), behind each end line
  b.paint(0xf2c418, K.METAL);
  for (const d of [-1, 1]) {
    const [x, z] = F.at(d * (hl + 0.5), 0), y = yAt(x, z);
    const [ax, az] = F.at(d * (hl + 0.5), -2.8), [bx, bz] = F.at(d * (hl + 0.5), 2.8);
    const [px, pz] = F.at(d * (hl + 2.2), 0);
    b.beam(px, y, pz, px, y + 3.05, pz, 0.22, 0.22, 0b1111);
    b.beam(px, y + 3.05, pz, x, y + 3.05, z, 0.18, 0.18, 0b1111);
    b.beam(ax, y + 3.05, az, bx, y + 3.05, bz, 0.16, 0.16, 0b1111);
    for (const [ux, uz] of [[ax, az], [bx, bz]]) b.beam(ux, y + 3.05, uz, ux, y + 9.1, uz, 0.12, 0.12, 0b1111);
    b.colCyl(px, pz, y, y + 3, 0.3);
  }
  // stands on both straights (home side covered, with a press box), outside the track
  const gy = yAt(R.cx, R.cz);
  const home = bleacher(b, F, -hs * 0.95, hs * 0.95, Rout + 2, 14, gy - 0.3, def.seats ?? 0x8a2a2a, { covered: true });
  const Fb = frame(R.cx, R.cz, -R.ux, -R.uz);
  bleacher(b, Fb, -hs * 0.7, hs * 0.7, Rout + 2, 9, gy - 0.3, def.seats2 ?? 0x2f4f8f);
  // press box on the home stand
  b.push();
  const [hx, hz] = F.at(0, Rout + 2 + home.depth - 3);
  b.translate(hx, home.top + 5.9, hz).rotY(Math.atan2(-F.uz, F.ux));
  b.paint(0xe0e2e4, K.PLAIN); b.box(-12, 0, -3, 12, 3.4, 3);
  b.paint(0x2a3c4c, K.NIGHTWIN); b.box(-11.5, 0.9, 3, 11.5, 2.7, 3.05, 0b000001);
  b.pop();
  // scoreboard behind one end
  b.push();
  const [sx, sz] = F.at(-hs - Rout - 8, 0), sy = yAt(sx, sz);
  b.translate(sx, sy, sz).rotY(Math.atan2(-F.uz, F.ux) + Math.PI / 2);
  b.paint(0x6c7177, K.METAL);
  for (const u of [-5, 5]) b.box(u - 0.3, 0, -0.3, u + 0.3, 7, 0.3);
  b.paint(0x14181c, K.PLAIN); b.box(-8, 7, -0.6, 8, 13, 0.6);
  b.paint(0xffb020, K.LED, 2); b.box(-7.4, 7.6, -0.62, 7.4, 12.4, -0.58, 0b000010);
  b.colBox(-8, 0, -0.6, 8, 13, 0.6);
  b.pop();
  if (def.sign) {
    const cell = atlas.text(`fb-${def.id}`, def.sign, { w: 768, h: 88, font: FONT.block, fg: '#ffffff', bg: '#7a2020' });
    sign.push();
    const [px, pz] = F.at(0, Rout + 2 + home.depth - 3);
    sign.translate(px, home.top + 5.9, pz).rotY(Math.atan2(-F.uz, F.ux));
    signQuad(sign, cell, -10, 3.5, 10, 5.4, 3.1, { lit: 2, facing: -1 });
    sign.pop();
  }
  masts(ctx, F, [[-hs - 10, -Rout - 6], [hs + 10, -Rout - 6], [hs + 10, Rout + 18], [-hs - 10, Rout + 18]], 26, 0, 0, yAt, 5);
  const [vx, vz] = F.at(-hs - 90, -Rout - 70);
  ctx.view([vx, gy + 45, vz], [R.cx, gy, R.cz], 'football stadium');
  return { report: { len: +R.len.toFixed(0), wid: +R.wid.toFixed(0), straight: +straight.toFixed(1), Rout: +Rout.toFixed(1) } };
}

// ---------- baseball diamond ----------
export function baseballField(ctx, def) {
  const yAt = (x, z) => ctx.groundY(x, z);
  const pts = groundRegion(ctx, def.x, def.z, ['sport'], { r: 60, reach: 140 });
  if (!pts || pts.length < 20) return { skipped: true, why: 'no sport ground' };
  // home plate: the sharpest corner of the fan-shaped field (its hull), axis towards the region centroid
  const H = hull2d(pts);
  let cx = 0, cz = 0;
  for (const [x, z] of pts) { cx += x; cz += z; }
  cx /= pts.length; cz /= pts.length;
  let home = null, best = Infinity;
  for (let i = 0; i < H.length; i++) {
    const p = H[i];
    // angle between the hull directions to points ~15 m away on both sides
    let a = null, c = null;
    for (let k = 1; k < H.length && !a; k++) { const q = H[(i - k + H.length) % H.length]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 15) a = q; }
    for (let k = 1; k < H.length && !c; k++) { const q = H[(i + k) % H.length]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 15) c = q; }
    if (!a || !c) continue;
    const ax = a[0] - p[0], az = a[1] - p[1], bx = c[0] - p[0], bz = c[1] - p[1];
    const ang = Math.acos((ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz)));
    if (ang < best) { best = ang; home = p; }
  }
  if (!home) return { skipped: true, why: 'no corner' };
  let ux = cx - home[0], uz = cz - home[1];
  const l0 = Math.hypot(ux, uz) || 1;
  ux /= l0; uz /= l0;
  // pull home plate a little inside the corner
  const F = frame(home[0] + ux * 6, home[1] + uz * 6, ux, uz);
  const rs = [];
  for (const [x, z] of pts) { const u = (x - F.cx) * ux + (z - F.cz) * uz, v = -(x - F.cx) * uz + (z - F.cz) * ux; if (Math.abs(v) < u * 0.6) rs.push(Math.hypot(u, v)); }
  rs.sort((a, c) => a - c);
  let Rf = rs.length ? rs[Math.floor(rs.length * 0.92)] : 80;
  Rf = Math.max(60, Math.min(110, Rf));
  const { paint, b } = ctx;
  const fan = [[0, 0]];
  for (let k = 0; k <= 16; k++) { const t = -Math.PI / 4 + (k / 16) * (Math.PI / 2); fan.push([Math.cos(t) * Rf, Math.sin(t) * Rf]); }
  ctx.remove({ poly: fan.map(([u, v]) => F.at(u, v)) });
  ctx.hideTrees({ poly: fan.map(([u, v]) => F.at(u, v)) });
  ctx.hideTrees({ poly: H }); // the whole fitted ground (foul territory included)
  // outfield turf (fan, draped)
  paint.paint(0x4f9c3c, K.GRASS);
  for (let k = 1; k < fan.length - 1; k++) {
    const [u1, v1] = fan[k], [u2, v2] = fan[k + 1];
    for (let q = 0; q < 6; q++) {
      const t0 = q / 6, t1 = (q + 1) / 6;
      upFace(paint, [F.at(u1 * t0, v1 * t0), F.at(u1 * t1, v1 * t1), F.at(u2 * t1, v2 * t1), F.at(u2 * t0, v2 * t0)], yAt, 0.04, [[t0 * 40, 0], [t1 * 40, 0], [t1 * 40, 1], [t0 * 40, 1]]);
    }
  }
  // infield skin (dirt arc ~29 m from the mound), grass diamond inside, base paths
  const base = 27.43, d2 = base / Math.SQRT2;
  paint.paint(0xb37a4c, K.PAINT);
  const skin = [];
  for (let k = 0; k <= 12; k++) { const t = -Math.PI / 4 + (k / 12) * (Math.PI / 2); skin.push([18.4 + Math.cos(t) * 29, Math.sin(t) * 29]); }
  for (let k = 0; k < skin.length - 1; k++) upFace(paint, [F.at(0, 0), F.at(...skin[k]), F.at(...skin[k + 1])], yAt, 0.07);
  paint.paint(0x55a443, K.GRASS);
  const dia = [[3.5, 0], [d2, -d2 + 3.2], [2 * d2 - 3.5, 0], [d2, d2 - 3.2]];
  upFace(paint, dia.map(([u, v]) => F.at(u, v)), yAt, 0.1, dia);
  paint.paint(0xb37a4c, K.PAINT);
  disc(paint, F, 18.44, 0, 2.7, 2.7, yAt, 0.13, 14);
  disc(paint, F, 0, 0, 4, 4, yAt, 0.13, 14);
  paint.paint(WHITE, K.PAINT);
  for (const s of [-1, 1]) line(paint, F, 0, 0, Rf * Math.SQRT1_2, s * Rf * Math.SQRT1_2, 0.1, yAt, 0.15);
  b.lod = LOD.NEAR;
  b.paint(WHITE, K.PLAIN);
  for (const [u, v] of [[d2, -d2], [2 * d2, 0], [d2, d2], [0, 0]]) {
    const [x, z] = F.at(u, v), y = yAt(x, z);
    b.box(x - 0.2, y, z - 0.2, x + 0.2, y + 0.12, z + 0.2);
  }
  b.lod = LOD.BOTH;
  // outfield wall (green padded panels), backstop net behind home, dugouts along the baselines
  b.paint(0x24563a, K.PLAIN);
  const wallR = Rf + 1;
  for (let k = 0; k < 16; k++) {
    const t0 = -Math.PI / 4 + (k / 16) * (Math.PI / 2), t1 = -Math.PI / 4 + ((k + 1) / 16) * (Math.PI / 2);
    const [ax, az] = F.at(Math.cos(t0) * wallR, Math.sin(t0) * wallR), [bx, bz] = F.at(Math.cos(t1) * wallR, Math.sin(t1) * wallR);
    const ya = yAt(ax, az), yb = yAt(bx, bz);
    const P = [[ax, ya - 0.3, az], [bx, yb - 0.3, bz], [bx, yb + 2.4, bz], [ax, ya + 2.4, az]];
    b.face(P); b.face(P.slice().reverse());
    b.colliders?.box((ax + bx) / 2, (ya + yb) / 2 + 1.2, (az + bz) / 2, Math.hypot(bx - ax, bz - az) / 2, 1.2, 0.2, Math.atan2(-(bz - az), bx - ax), b.colTag);
  }
  const back = [];
  for (let k = 0; k <= 8; k++) { const t = Math.PI * 0.75 + (k / 8) * (Math.PI / 2); back.push(F.at(Math.cos(t) * 18, Math.sin(t) * 18)); }
  fenceLine(b, back, yAt, { h: 7, step: 4, barbed: false });
  for (const s of [-1, 1]) {
    b.push();
    const [x, z] = F.at(14, s * 22), y = yAt(x, z);
    b.translate(x, y, z).rotY(Math.atan2(-F.uz, F.ux) + Math.PI / 4 * -s);
    b.paint(0x3a4047, K.PLAIN); b.box(-6, -0.6, -1.4, 6, 2.4, 1.4, 0b111011);
    b.paint(0x1f6aa8, K.PLAIN); b.box(-6.2, 2.4, -1.6, 6.2, 2.7, 1.6);
    b.colBox(-6, 0, -1.4, 6, 2.7, 1.4);
    b.pop();
  }
  // bleachers behind the backstop, both sides
  const Fs = frame(F.cx, F.cz, -F.uz, F.ux);
  if ([[-10, 20], [10, 20], [-10, 25], [10, 25]].every(([u, v]) => ctx.clearOfRoads(...Fs.at(u, v), 2))) bleacher(b, Fs, -10, 10, 20, 5, yAt(...F.at(-22, 0)) - 0.2, def.seats ?? 0x2f5f8f);
  masts(ctx, F, [[-12, -26], [-12, 26], [Rf * 0.62, -Rf * 0.72], [Rf * 0.62, Rf * 0.72]], 24, Rf * 0.4, 0, yAt, 4);
  const [vx, vz] = F.at(-60, -55);
  const [lx, lz] = F.at(40, 0);
  ctx.view([vx, yAt(vx, vz) + 40, vz], [lx, yAt(lx, lz), lz], 'diamond');
  return { report: { Rf: +Rf.toFixed(0), cornerDeg: +((best * 180) / Math.PI).toFixed(0), home: [Math.round(F.cx), Math.round(F.cz)], axis: [+ux.toFixed(2), +uz.toFixed(2)] } };
}

// ---------- tennis courts ----------
export function tennisCourts(ctx, def) {
  const yAt = (x, z) => ctx.groundY(x, z);
  const R = fitted(ctx, def);
  if (!R || R.len < 22 || R.wid < 12) return { skipped: true, why: R ? `small ${R.len.toFixed(0)}x${R.wid.toFixed(0)}` : 'no sport ground' };
  const F = frame(R.cx, R.cz, R.ux, R.uz);
  const bl = Math.min(36.6, R.len), bw = 18.3;
  const n = Math.max(1, Math.min(def.max ?? 4, Math.floor((R.wid + 2) / bw)));
  const { paint, b } = ctx;
  const W2 = (n * bw) / 2, hl = bl / 2;
  clearArea(ctx, F, -hl - 1, hl + 1, -W2 - 1, W2 + 1);
  const s = Math.min(1, (bl - 4) / 23.77);
  paint.paint(def.surround ?? 0x3f7a52, K.PAINT);
  drape(paint, F, -hl, hl, -W2, W2, yAt, { lift: 0.05, step: 6 });
  for (let c = 0; c < n; c++) {
    const v0 = -W2 + c * bw + bw / 2;
    const cl = 11.885 * s, cw = 5.485, sw = 4.115;
    paint.paint(def.court ?? 0x2f5f9a, K.PAINT);
    drape(paint, F, -cl - 0.6, cl + 0.6, v0 - cw - 0.6, v0 + cw + 0.6, yAt, { lift: 0.07, step: 6 });
    paint.paint(WHITE, K.PAINT);
    const w = 0.07;
    rectLines(paint, F, -cl, v0 - cw, cl, v0 + cw, w, yAt);
    line(paint, F, -cl, v0 - sw, cl, v0 - sw, w, yAt); line(paint, F, -cl, v0 + sw, cl, v0 + sw, w, yAt);
    line(paint, F, -6.4 * s, v0 - sw, -6.4 * s, v0 + sw, w, yAt); line(paint, F, 6.4 * s, v0 - sw, 6.4 * s, v0 + sw, w, yAt);
    line(paint, F, -6.4 * s, v0, 6.4 * s, v0, w, yAt);
    // net: posts + mesh with a white band, sagging to 0.914 m in the middle
    const [ax, az] = F.at(0, v0 - cw - 0.9), [bx, bz] = F.at(0, v0 + cw + 0.9), [mx, mz] = F.at(0, v0);
    const ya = yAt(ax, az), yb = yAt(bx, bz), ym = yAt(mx, mz);
    b.lod = LOD.NEAR;
    b.paint(0x2c3034, K.METAL);
    b.beam(ax, ya, az, ax, ya + 1.07, az, 0.1, 0.1, 0b1111); b.beam(bx, yb, bz, bx, yb + 1.07, bz, 0.1, 0.1, 0b1111);
    b.paint(0x1c1f22, K.FENCE);
    const net = [[ax, ya + 0.05, az], [mx, ym + 0.05, mz], [mx, ym + 0.914, mz], [ax, ya + 1.07, az]], net2 = [[mx, ym + 0.05, mz], [bx, yb + 0.05, bz], [bx, yb + 1.07, bz], [mx, ym + 0.914, mz]];
    for (const P of [net, net2]) { b.face(P); b.face(P.slice().reverse()); }
    b.paint(WHITE, K.PLAIN);
    b.beam(ax, ya + 1.07, az, mx, ym + 0.914, mz, 0.05, 0.08, 0b1111); b.beam(mx, ym + 0.914, mz, bx, yb + 1.07, bz, 0.05, 0.08, 0b1111);
    b.lod = LOD.BOTH;
  }
  // chain-link fence around the block (gate gap in the middle of one long side)
  const P = [F.at(-hl, -W2), F.at(hl, -W2), F.at(hl, W2), F.at(-hl, W2), F.at(-hl, -W2)];
  const gate = F.at(0, -W2);
  fenceLine(b, P, yAt, { h: 3.2, step: 4, barbed: false, gaps: [[gate[0], gate[1], 1.6]] });
  if (n >= 2) masts(ctx, F, [[-hl, -W2], [hl, W2], [hl, -W2], [-hl, W2]], 10, 0, 0, yAt, 2);
  const [vx, vz] = F.at(-hl - 30, -W2 - 26);
  ctx.view([vx, yAt(vx, vz) + 22, vz], [R.cx, yAt(R.cx, R.cz), R.cz], 'tennis courts');
  return { report: { courts: n, len: +R.len.toFixed(0), wid: +R.wid.toFixed(0) } };
}

// ---------- golf: tees, fairways, greens, bunkers, flags ----------
export function* golfCourse(ctx, def) { // generator: yields between layout attempts (sliced build)
  const yAt = (x, z) => ctx.groundY(x, z);
  const T = ctx.terrain;
  const pts = groundRegion(ctx, def.x, def.z, def.ground || ['park'], { r: 120, reach: def.reach || 700 });
  if (!pts || pts.length < 200) return { skipped: true, why: 'no course ground' };
  // clearance map over the region: distance (m) to the nearest texel outside it (water, road, buildings...)
  const ts = T.ts;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const W = Math.round((x1 - x0) / ts) + 3, Hh = Math.round((z1 - z0) / ts) + 3;
  const ox = x0 - ts, oz = z0 - ts;
  const dist = new Float32Array(W * Hh);
  for (const [x, z] of pts) dist[Math.round((z - oz) / ts) * W + Math.round((x - ox) / ts)] = 1e9;
  // two-pass chamfer distance (in texels)
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!dist[k]) continue;
    let d = dist[k];
    if (i > 0) d = Math.min(d, dist[k - 1] + 1);
    if (j > 0) d = Math.min(d, dist[k - W] + 1);
    if (i > 0 && j > 0) d = Math.min(d, dist[k - W - 1] + 1.414);
    if (i < W - 1 && j > 0) d = Math.min(d, dist[k - W + 1] + 1.414);
    dist[k] = d;
  }
  for (let j = Hh - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    if (!dist[k]) continue;
    let d = dist[k];
    if (i < W - 1) d = Math.min(d, dist[k + 1] + 1);
    if (j < Hh - 1) d = Math.min(d, dist[k + W] + 1);
    if (i < W - 1 && j < Hh - 1) d = Math.min(d, dist[k + W + 1] + 1.414);
    if (i > 0 && j < Hh - 1) d = Math.min(d, dist[k + W - 1] + 1.414);
    dist[k] = d;
  }
  yield;
  const clear = (x, z) => {
    const i = Math.round((x - ox) / ts), j = Math.round((z - oz) / ts);
    return i < 0 || j < 0 || i >= W || j >= Hh ? 0 : dist[j * W + i] * ts;
  };
  // the generic buildings (clubhouse) keep a margin too
  const nearBld = (x, z, r) => (ctx.buildings?.query ? ctx.buildings.query(x, z, r).length > 0 : false);
  // a fairway may carry over a water hazard, but tee shot zone and approach stay on dry turf
  const segClear = (ax, az, bx, bz, need) => {
    const L0 = Math.hypot(bx - ax, bz - az), n = Math.ceil(L0 / 6);
    let ok = 0;
    for (let k = 0; k <= n; k++) {
      const t = k / n, d = t * L0, c = clear(ax + (bx - ax) * t, az + (bz - az) * t);
      if ((d < 25 || d > L0 - 50) && c < 8) return false;
      if (c >= need) ok++;
    }
    return ok >= 0.7 * (n + 1);
  };
  const segD = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
    return Math.hypot(px - ax - dx * t, pz - az - dz * t);
  };
  const segSeg = (a, c) => Math.min(segD(a[0], a[1], c[0], c[1], c[2], c[3]), segD(a[2], a[3], c[0], c[1], c[2], c[3]), segD(c[0], c[1], a[0], a[1], a[2], a[3]), segD(c[2], c[3], a[0], a[1], a[2], a[3]));
  const cand = pts.filter(([x, z]) => clear(x, z) >= 16);
  if (cand.length < 10) return { skipped: true, why: 'course too narrow' };
  // first tee: the roomiest spot near the clubhouse POI
  let tee0 = null, bd = Infinity;
  const [sx, sz] = def.start || [def.x, def.z];
  for (const [x, z] of cand) { const d = Math.hypot(x - sx, z - sz); if (d < bd && !nearBld(x, z, 18)) { bd = d; tee0 = [x, z]; } }
  const maxHoles = def.holes ?? 9;
  // a few seeded layouts, the one with most holes wins
  const layout = (seed) => {
    const R = rng(seed), holes = [];
    let tee = tee0;
    for (let h = 0; h < maxHoles && tee; h++) {
      let bestHole = null;
      const PARS = [4, 4, 3, 5, 4, 3, 4, 4, 5];
      for (let tries = 0; tries < 160; tries++) {
        // the planned par first, any par later
        const par = tries < 80 ? PARS[h % PARS.length] : [3, 4, 5][Math.floor(R() * 3)];
        const len = par === 3 ? 120 + R() * 60 : par === 4 ? 240 + R() * 90 : 380 + R() * 70;
        const a = R() * Math.PI * 2;
        const gx = tee[0] + Math.cos(a) * len, gz = tee[1] + Math.sin(a) * len;
        const cg = clear(gx, gz);
        if (cg < 16 || nearBld(gx, gz, 24)) continue;
        if (!segClear(tee[0], tee[1], gx, gz, 10)) continue;
        const seg = [tee[0], tee[1], gx, gz];
        if (holes.some((o) => segSeg(seg, o.seg) < 38)) continue;
        // roomy greens (room for the next holes around them), planned par preferred
        const score = Math.min(cg, 60) + (tries < 80 ? 40 : 0);
        if (!bestHole || score > bestHole.score) bestHole = { seg, par, len, score, tee: tee.slice(), green: [gx, gz] };
      }
      if (!bestHole) break;
      holes.push(bestHole);
      // next tee: 25-60 m beyond the green, clear of the fairways so far
      let next = null;
      for (let tries = 0; tries < 60 && !next; tries++) {
        const a = R() * Math.PI * 2, d = 42 + R() * 30;
        const tx = bestHole.green[0] + Math.cos(a) * d, tz = bestHole.green[1] + Math.sin(a) * d;
        if (clear(tx, tz) < 12 || holes.some((o) => segD(tx, tz, ...o.seg) < 40)) continue;
        next = [tx, tz];
      }
      tee = next;
    }
    return holes;
  };
  let holes = [];
  for (let k = 0; k < (def.tries ?? 6) && holes.length < maxHoles; k++) { const hs = layout((def.seed ?? 4242) + k * 977); if (hs.length > holes.length) holes = hs; yield; }
  const R = rng((def.seed ?? 4242) + 1);
  if (!holes.length) return { skipped: true, why: 'no hole fits' };
  const { paint, b, lights } = ctx;
  const fwHalf = (hole) => (hole.par === 3 ? 12 : 17);
  holes.forEach((hole, i) => {
    const [tx, tz] = hole.tee, [gx, gz] = hole.green;
    const L0 = hole.len, ux = (gx - tx) / L0, uz = (gz - tz) / L0;
    const F = frame(tx, tz, ux, uz);
    // no trees on the fairway, tee or green
    ctx.hideTrees({ poly: [F.at(-8, -8), F.at(L0 + 20, -(fwHalf(hole) + 4)), F.at(L0 + 20, fwHalf(hole) + 4), F.at(-8, 8)] });
    ctx.hideTrees({ circle: [gx, gz, 20] });
    // fairway (mowing stripes across), tee box, green with fringe, bunkers
    paint.paint(0x6bb84c, K.GRASS);
    const fw = hole.par === 3 ? 0 : 30;
    if (fw) {
      const n = Math.ceil((L0 - 70) / 8);
      for (let k = 0; k < n; k++) {
        const u0 = 50 + ((L0 - 70) * k) / n, u1 = 50 + ((L0 - 70) * (k + 1)) / n;
        // gentle dog-leg-free taper: narrower near the tee
        const w0 = fw * (0.7 + 0.3 * Math.min(1, (u0 - 50) / 60)) / 2, w1 = fw * (0.7 + 0.3 * Math.min(1, (u1 - 50) / 60)) / 2;
        const [mx0, mz0] = F.at((u0 + u1) / 2, 0);
        if (yAt(mx0, mz0) < 0.15) continue; // carry over the water hazard
        upFace(paint, [F.at(u0, -w0), F.at(u1, -w1), F.at(u1, w1), F.at(u0, w0)], yAt, 0.05, [[u0, -w0], [u1, -w1], [u1, w1], [u0, w0]]);
      }
    }
    paint.paint(0x63b046, K.GRASS);
    drape(paint, F, -5, 5, -4, 4, yAt, { lift: 0.07, step: 5 });
    paint.paint(0x5aa83e, K.GRASS);
    disc(paint, F, L0, 0, 17, 14, yAt, 0.07, 22, R() * 3);
    paint.paint(0x82cf63, K.GRASS);
    disc(paint, F, L0, 0, 13.5, 11, yAt, 0.09, 22, R() * 3);
    paint.paint(0xe9dcac, K.PAINT);
    const nb = 1 + Math.floor(R() * 2.5);
    for (let k = 0; k < nb; k++) {
      const side = R() < 0.5 ? -1 : 1, au = L0 - 6 + R() * 14, av = side * (16 + R() * 4);
      disc(paint, F, au, av, 4 + R() * 3, 2.6 + R() * 1.6, yAt, 0.08, 14, R() * 3);
    }
    if (fw && R() < 0.8) disc(paint, F, L0 * (0.55 + R() * 0.2), (R() < 0.5 ? -1 : 1) * (fw / 2 + 4), 6, 3.4, yAt, 0.08, 14, R());
    // flag on the green, tee markers
    const [px, pz] = F.at(L0 + (R() - 0.5) * 8, (R() - 0.5) * 6), py = yAt(px, pz);
    b.lod = LOD.NEAR;
    b.paint(0xf2f2f2, K.PLAIN);
    b.beam(px, py, pz, px, py + 2.3, pz, 0.04, 0.04, 0b1111);
    b.paint(0xd8262a, K.PLAIN);
    const fl = [[px, py + 2.3, pz], [px, py + 1.85, pz], [px + 0.6, py + 2.08, pz + 0.12]];
    b.face(fl); b.face(fl.slice().reverse());
    for (const v of [-2.5, 2.5]) { const [mx, mz] = F.at(2, v); const my = yAt(mx, mz); b.paint(i % 2 ? 0x1f5fbf : 0xf0f0f0, K.PLAIN); b.box(mx - 0.15, my, mz - 0.15, mx + 0.15, my + 0.3, mz + 0.15); }
    b.lod = LOD.BOTH;
    lights.add(px, py + 2.4, pz, 0xffe0a0, 0.25, L.STEADY, 0, 700);
  });
  // tour views: first hole and an overview
  const h0 = holes[0];
  ctx.view([h0.tee[0] - (h0.green[0] - h0.tee[0]) * 0.15, yAt(h0.tee[0], h0.tee[1]) + 14, h0.tee[1] - (h0.green[1] - h0.tee[1]) * 0.15], [h0.green[0], yAt(h0.green[0], h0.green[1]), h0.green[1]], 'golf hole 1');
  let mx = 0, mz = 0;
  for (const hh of holes) { mx += hh.green[0]; mz += hh.green[1]; }
  mx /= holes.length; mz /= holes.length;
  ctx.view([mx + 260, 210, mz + 260], [mx, 0, mz], 'golf course');
  return { report: { holes: holes.length, pars: holes.map((h) => h.par).join('') } };
}

// ---------- raceway grandstands ----------
// def.stands: [{x, z, len, rows, covered, name}] -> each faces the nearest track (road) edge
export function grandstands(ctx, def) {
  const yAt = (x, z) => ctx.groundY(x, z);
  const { b, sign, atlas } = ctx;
  let built = 0;
  for (const st of def.stands) {
    const near = ctx.roads?.nearest(st.x, st.z, 220);
    if (!near) continue;
    // facing: towards the track; the stand's long axis runs along it
    let fx = near.x - st.x, fz = near.z - st.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    // frame: u along the track, +v away from it (rows climb away from the track)
    const F = frame(st.x, st.z, -fz, fx);
    const G = F;
    const rows = st.rows ?? 12, depth = rows * 0.85;
    const hl = st.len / 2, v0 = -depth / 2;
    const poly = [G.at(-hl - 2, v0 - 3), G.at(hl + 2, v0 - 3), G.at(hl + 2, v0 + depth + 2), G.at(-hl - 2, v0 + depth + 2)];
    ctx.remove({ poly });
    for (const f of ctx.footprints(st.x, st.z, Math.max(st.len, 30))) {
      // footprints mostly under the stand go too (their centroid may sit just outside)
      let inside = 0;
      for (let i = 0; i < f.poly.length; i++) { const [px, pz] = f.poly[i]; const u = (px - st.x) * G.ux + (pz - st.z) * G.uz, v = -(px - st.x) * G.uz + (pz - st.z) * G.ux; if (Math.abs(u) < hl + 4 && v > v0 - 4 && v < v0 + depth + 4) inside++; }
      if (inside >= f.poly.length / 2) ctx.remove({ ids: [f.id] });
    }
    ctx.hideTrees({ poly: [G.at(-hl - 5, v0 - 8), G.at(hl + 5, v0 - 8), G.at(hl + 5, v0 + depth + 5), G.at(-hl - 5, v0 + depth + 5)] });
    let gy = Infinity;
    for (const [px, pz] of poly) gy = Math.min(gy, yAt(px, pz));
    const res = bleacher(b, G, -hl, hl, v0, rows, gy - 0.2, st.seats ?? (st.covered ? 0x2f4f9f : 0xd23a30), { covered: !!st.covered, rowD: 0.85, rowH: 0.5, front: 1.6 });
    // concrete apron in front + walkway
    ctx.paint.paint(0xb9b6ae, K.PAINT);
    drape(ctx.paint, G, -hl, hl, v0 - 3, v0, yAt, { lift: 0.06, step: 8 });
    if (st.name) {
      const cell = atlas.text(`gs-${def.id}-${built}`, st.name, { w: 768, h: 88, font: FONT.block, fg: '#ffffff', bg: '#1d2a5c' });
      sign.push();
      const [sx, sz] = G.at(0, v0 + depth + 0.32);
      sign.translate(sx, res.top + 1.1, sz).rotY(Math.atan2(-G.uz, G.ux)); // facing +v (the paddock side)
      signQuad(sign, cell, -Math.min(hl - 2, 18), -3.4, Math.min(hl - 2, 18), -0.6, 0.0, { lit: 2 });
      sign.pop();
    }
    if (built === 0) {
      const [vx, vz] = G.at(-hl - 40, v0 - 60);
      ctx.view([vx, gy + 26, vz], [st.x, gy + 6, st.z], 'grandstands');
    }
    built++;
  }
  return built ? { report: { stands: built } } : { skipped: true, why: 'no track found' };
}

// ---------- Spaceship House (original saucer design) ----------
export function spaceshipHouse(ctx, def) {
  const { b, lights, paint } = ctx;
  const yAt = (x, z) => ctx.groundY(x, z);
  // keep 16 m from the road and on dry land
  let x = def.x, z = def.z;
  const near = ctx.roads?.nearest(x, z, 60);
  const need = (near?.edge?.w ?? 12) / 2 + 15;
  if (near && near.dist < need) { const d = near.dist || 1; x += ((x - near.x) / d) * (need - d); z += ((z - near.z) / d) * (need - d); }
  for (let k = 0; k < 12 && !ctx.dryDisc(x, z, 10, 0.4); k++) { const nr = ctx.roads?.nearest(x, z, 200); if (!nr) break; x += (nr.x - x) * 0.08; z += (nr.z - z) * 0.08; }
  ctx.hideTrees({ circle: [x, z, 16] });
  ctx.remove({ circle: [x, z, 12] });
  const g = yAt(x, z);
  const yaw = near ? Math.atan2(-(near.z - z), near.x - x) : 0; // door / ramp towards the road
  const F = frame(x, z, Math.cos(-yaw), Math.sin(-yaw));
  // gravel ring garden
  paint.paint(0xd4ccb6, K.PAINT);
  disc(paint, F, 0, 0, 11.5, 11.5, yAt, 0.06, 28);
  paint.paint(0x8a8f7a, K.PAINT);
  arc(paint, F, 0, 0, 10.5, 0, Math.PI * 2, 0.4, yAt, 0.09);
  b.push();
  b.translate(x, g, z).rotY(yaw);
  // plinth, stair core, three splayed legs
  b.paint(0xbdbab2, K.PLAIN);
  b.cyl(0, 0, -0.5, 0.35, 4.2, 4.2, 18);
  b.paint(0xe8e6e0, K.PLAIN);
  b.cyl(0, 0, 0.35, 3.4, 1.9, 1.9, 14);
  b.paint(0x5f6c78, K.METAL);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
    b.beam(Math.cos(a) * 8.2, -0.3, Math.sin(a) * 8.2, Math.cos(a) * 4.6, 3.1, Math.sin(a) * 4.6, 0.55, 0.55, 0b1111);
    b.cyl(Math.cos(a) * 8.2, Math.sin(a) * 8.2, -0.3, 0.2, 0.7, 0.7, 8);
  }
  // saucer: lens body (lathe), smoked window band, upper shell, glass cupola, antenna
  b.paint(0xc9ced3, K.METAL);
  b.lathe(0, 0, [[0.2, 3.0], [4.6, 3.05], [8.4, 3.55], [9.7, 4.25]], 28, { capTop: false });
  b.paint(0x24323e, K.NIGHTWIN);
  b.lathe(0, 0, [[9.7, 4.25], [9.75, 4.6], [9.55, 5.05]], 28, { capTop: false });
  b.paint(0xf1f1ee, K.PLAIN);
  b.lathe(0, 0, [[9.55, 5.05], [8.6, 5.55], [6.8, 6.15], [4.2, 6.6], [2.6, 6.8]], 28, { capTop: false });
  b.paint(0xd7dbe0, K.PLAIN);
  for (let k = 0; k < 14; k++) { const a = (k / 14) * Math.PI * 2; b.beam(Math.cos(a) * 9.5, 5.1, Math.sin(a) * 9.5, Math.cos(a) * 2.7, 6.82, Math.sin(a) * 2.7, 0.14, 0.06, 0b1111); }
  b.paint(0x7fb4d8, K.GLASS, 1);
  b.dome(0, 6.8, 0, 2.6, 14, 4, { squash: 0.62 });
  b.paint(0x6a7178, K.METAL);
  b.beam(0, 8.3, 0, 0, 11.2, 0, 0.12, 0.12, 0b1111);
  b.sphere(0, 11.3, 0, 0.22, 8, 4);
  // fold-down ramp from the hatch to the ground (towards the road, local +x)
  b.paint(0xb4bac0, K.METAL);
  b.face([[2.6, 3.0, -0.9], [2.6, 3.0, 0.9], [8.6, 0.05, 0.9], [8.6, 0.05, -0.9]]);
  b.face([[8.6, 0.05, -0.9], [8.6, 0.05, 0.9], [2.6, 3.0, 0.9], [2.6, 3.0, -0.9]]);
  b.paint(0x5f6c78, K.METAL);
  for (const s of [-1, 1]) b.beam(2.6, 3.9, s * 0.95, 8.6, 1.0, s * 0.95, 0.06, 0.06, 0b1111);
  // landing pads glowing under the rim (cool cyan, slow pulse)
  b.paint(0x7ff0ff, K.LED, 2);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; b.cyl(Math.cos(a) * 8.6, Math.sin(a) * 8.6, 3.5, 3.62, 0.45, 0.45, 8); }
  b.colCyl(0, 0, 2.9, 6.9, 9.7);
  b.colCyl(0, 0, 0, 3.0, 2.0);
  const top = b.world(0, 11.35, 0);
  lights.add(top[0], top[1], top[2], 0xff3a2a, 1.1, L.OBSTACLE, 0.3, 3500);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; const p = b.world(Math.cos(a) * 8.6, 3.4, Math.sin(a) * 8.6); lights.add(p[0], p[1], p[2], 0x8ff4ff, 0.7, L.STEADY, 0, 1800); }
  b.pop();
  ctx.view([x + 34, g + 14, z + 26], [x, g + 4, z], 'spaceship house');
  return { report: { moved: +Math.hypot(x - def.x, z - def.z).toFixed(1) } };
}
