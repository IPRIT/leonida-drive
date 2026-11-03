import { K, LOD, W, rng, obb, inside } from '../kit.js';
import { L } from '../lights.js';
import { signQuad, signBoard, mast, tank, antenna, fenceLine } from '../parts.js';
import { FONT } from '../atlas.js';
import { AIRCRAFT, AIRCRAFT_SIZE, LIVERIES } from './aircraft.js';
import { parkingRow } from './parking.js';
import { LOT_CARS } from '../vehicles.js';

// Airport building blocks: terminal halls and concourses built along a path (adaptive depth, raised over
// roads), jet bridges, aircraft stands with ground paint, control tower, hangars, fuel farm, garages,
// cargo sheds, fire station, radar. All coordinates world space (builders keep an identity transform).

const ROOF = 0xdfe3e6, FASCIA = 0xf4f5f6, GLASS_T = 0x6c8fa6, CONC = 0xc9c5bc, DARKM = 0x55595e;

// ---------- path helpers ----------
export function smoothPath(pts, iters = 2) {
  let p = pts.map((q) => [q[0], q[1]]);
  for (let k = 0; k < iters; k++) {
    const o = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    o.push(p[p.length - 1]);
    p = o;
  }
  return p;
}

export function resample(pts, step) {
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L0 = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= L0 - 1e-6) { out.push([ax + (bx - ax) * t / L0, az + (bz - az) * t / L0]); t += step; }
    carry = L0 - (t - step);
  }
  const last = pts[pts.length - 1];
  const pl = out[out.length - 1];
  if (Math.hypot(last[0] - pl[0], last[1] - pl[1]) > step * 0.35) out.push(last.slice()); else out[out.length - 1] = last.slice();
  return out;
}

// distance (m) along direction (dx,dz) from (x,z) until a road surface comes within `pad` (max `max`)
function freeRun(ctx, x, z, dx, dz, max, pad = 2.5) {
  for (let d = 0; d <= max; d += 1.5) {
    if (!ctx.clearOfRoads(x + dx * d, z + dz * d, pad)) return Math.max(0, d - 1.5);
  }
  return max;
}

// ---------- terminal / concourse strip ----------
// path: [[x,z]...]; left = landside for halls. Options:
//   wl, wr: max half widths left / right of the path; adapt: shrink each side to keep `pad` m from roads
//   h: wall height; rise: roof arch; canopy: roof overhang beyond the left facade; bridge: raise slices over roads
//   (deck at bridgeY), allBridge: skybridge; facade styles per side.
export function strip(ctx, path, o) {
  const { b } = ctx;
  const step = o.step || 6;
  const P = resample(o.smooth ? smoothPath(path, o.smooth) : path, step);
  const n = P.length;
  const y0 = o.y0 ?? Math.min(...P.map(([x, z]) => ctx.groundY(x, z))) - 0.8;
  const H = o.h ?? 14;
  const bridgeY = o.bridgeY ?? 6.5;
  // per-sample frame
  const S = P.map(([x, z], i) => {
    const a = P[Math.max(0, i - 1)], c = P[Math.min(n - 1, i + 1)];
    let tx = c[0] - a[0], tz = c[1] - a[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    return { x, z, tx, tz, lx: tz, lz: -tx };
  });
  // adaptive widths (moving minimum then smoothing)
  for (const s of S) {
    s.wl = o.adapt ? Math.max(o.minW ?? 6, freeRun(ctx, s.x, s.z, s.lx, s.lz, o.wl, o.pad ?? 3)) : o.wl;
    s.wr = o.adapt ? Math.max(o.minW ?? 6, freeRun(ctx, s.x, s.z, -s.lx, -s.lz, o.wr, o.pad ?? 3)) : o.wr;
  }
  if (o.adapt) for (let k = 0; k < 3; k++) for (const key of ['wl', 'wr']) {
    const v = S.map((s) => s[key]);
    S.forEach((s, i) => { s[key] = Math.min(v[i], (v[Math.max(0, i - 1)] + v[i] * 2 + v[Math.min(n - 1, i + 1)]) / 4 + 0.5); });
  }
  // bridge flags: any road across the slice footprint
  for (let i = 0; i < n; i++) {
    const s = S[i];
    if (o.allBridge) { s.br = true; continue; }
    if (!o.bridge) { s.br = false; continue; }
    let hit = false;
    for (const f of [-0.9, -0.45, 0, 0.45, 0.9]) {
      const w = f < 0 ? s.wr * -f : s.wl * f;
      const sx = s.x + s.lx * w * Math.sign(f || 1), sz = s.z + s.lz * w * Math.sign(f || 1);
      for (const g of [-0.5, 0.5]) if (!ctx.clearOfRoads(sx + s.tx * step * g, sz + s.tz * step * g, 0.8)) hit = true;
    }
    s.br = hit;
  }
  // grow bridge runs by one slice each way (clearance at the road edges)
  const br0 = S.map((s) => s.br);
  S.forEach((s, i) => { s.br = br0[i] || (o.bridge && (br0[i - 1] || br0[i + 1])); });

  const L_ = (s) => [s.x + s.lx * s.wl, s.z + s.lz * s.wl];
  const R_ = (s) => [s.x - s.lx * s.wr, s.z - s.lz * s.wr];
  let uL = 0, uR = 0;
  const lowL = o.lowL ?? 0, lowR = o.lowR ?? 4.5; // solid service band height on each side
  for (let i = 0; i < n - 1; i++) {
    const A = S[i], B = S[i + 1];
    const yb = (A.br && B.br) ? y0 + bridgeY : y0; // slice bottom
    const [alx, alz] = L_(A), [blx, blz] = L_(B), [arx, arz] = R_(A), [brx, brz] = R_(B);
    const top = y0 + H;
    // left facade (walk B->A so the wall faces left/out)
    const segL = Math.hypot(alx - blx, alz - blz), segR = Math.hypot(arx - brx, arz - brz);
    band(b, alx, alz, blx, blz, yb, top, uL, y0, lowL, o.styleL ?? 1, o.lowColor);
    band(b, brx, brz, arx, arz, yb, top, uR, y0, lowR, o.styleR ?? 1, o.lowColor);
    uL += segL; uR += segR;
    // fascia (white band under the roof edge)
    b.paint(FASCIA, K.PLAIN);
    b.wall(alx, alz, blx, blz, top - 1.6, top + 0.4);
    b.wall(brx, brz, arx, arz, top - 1.6, top + 0.4);
    // roof: arched section from right eave to left eave (+ canopy)
    const prof = (s) => {
      const out = [];
      const cl = o.canopy || 0;
      const k = 7;
      for (let j = 0; j <= k; j++) {
        const f = j / k; // 0 right eave -> 1 left eave (+canopy)
        const w = -s.wr - 1.2 + (s.wr + s.wl + 1.2 + cl) * f;
        const inner = Math.min(1, (w + s.wr) / (s.wr + s.wl));
        const wave = o.wave ? Math.sin((uL / o.wave) * Math.PI * 2) * 0.6 : 0;
        const y = top + 0.4 + (o.rise ?? 3) * Math.sin(Math.PI * Math.max(0, Math.min(1, inner))) * (1 + wave * 0.5) - (w > s.wl ? (w - s.wl) * 0.12 : 0);
        out.push([s.x + s.lx * w, y, s.z + s.lz * w]);
      }
      return out;
    };
    const pa = prof(A), pb = prof(B);
    b.paint(o.roof ?? ROOF, K.METAL);
    for (let j = 0; j < pa.length - 1; j++) b.quad(pa[j], pb[j], pb[j + 1], pa[j + 1]);
    // canopy soffit (seen from the curb)
    if (o.canopy) {
      b.paint(0xc4c8cc, K.PLAIN);
      const ja = pa.findIndex((p, j) => j > 0 && Math.hypot(p[0] - A.x, p[2] - A.z) >= A.wl - 0.5 && (p[0] - A.x) * A.lx + (p[2] - A.z) * A.lz > 0);
      const j0 = Math.max(1, ja);
      for (let j = j0; j < pa.length - 1; j++) b.quad(pa[j + 1], pb[j + 1], pb[j], pa[j]);
      // soffit back to the facade top
      b.quad(pa[j0], pb[j0], [blx, top + 0.4, blz], [alx, top + 0.4, alz]);
    }
    // bridge slice: deck underside + side beams; columns at run ends (off the road)
    if (A.br && B.br) {
      b.paint(CONC, K.PLAIN);
      b.quad([alx, yb, alz], [blx, yb, blz], [brx, yb, brz], [arx, yb, arz]);
    }
    // collider: oriented box per slice from its bottom to the roof
    const cx = (A.x + B.x) / 2, cz = (A.z + B.z) / 2, len = Math.hypot(B.x - A.x, B.z - A.z);
    const wl = (A.wl + B.wl) / 2, wr = (A.wr + B.wr) / 2;
    const off = (wl - wr) / 2;
    if (b.colliders && len > 0.5) b.colliders.box(cx + A.lx * off, (yb + top) / 2, cz + A.lz * off, len / 2 + 0.3, (top - yb) / 2, (wl + wr) / 2, Math.atan2(-(B.z - A.z), B.x - A.x), b.colTag);
  }
  // end walls (glass) at both ends, and columns where bridge runs meet the ground
  for (const [i, sgn] of [[0, -1], [n - 1, 1]]) {
    const s = S[i];
    const yb = s.br ? y0 + bridgeY : y0;
    const [lx, lz] = L_(s), [rx, rz] = R_(s);
    if (sgn < 0) band(b, rx, rz, lx, lz, yb, y0 + H, 0, y0, 0, o.styleEnd ?? 1);
    else band(b, lx, lz, rx, rz, yb, y0 + H, 0, y0, 0, o.styleEnd ?? 1);
    if (!o.noEndCap) {
      const pr = [];
      const k = 7;
      for (let j = 0; j <= k; j++) {
        const f = j / k, w = -s.wr - 1.2 + (s.wr + s.wl + 1.2 + (o.canopy || 0)) * f;
        const inner = Math.min(1, (w + s.wr) / (s.wr + s.wl));
        pr.push([s.x + s.lx * w, y0 + H + 0.4 + (o.rise ?? 3) * Math.sin(Math.PI * Math.max(0, Math.min(1, inner))), s.z + s.lz * w]);
      }
      b.paint(FASCIA, K.PLAIN);
      for (let j = 0; j < k; j++) {
        const a = pr[j], c = pr[j + 1];
        const tri = [[a[0], y0 + H + 0.4, a[2]], a, c, [c[0], y0 + H + 0.4, c[2]]];
        if (sgn > 0) b.quad(tri[3], tri[2], tri[1], tri[0]); else b.quad(...tri);
      }
    }
  }
  b.paint(0xd0ccc4, K.PLAIN);
  for (let i = 0; i < n; i++) {
    const s = S[i];
    if (!s.br) continue;
    const prev = S[i - 1], next = S[i + 1];
    if ((prev && !prev.br) || (next && !next.br) || i === 0 || i === n - 1) {
      for (const [px, pz] of [L_(s), R_(s)]) {
        const ix = px - s.lx * Math.sign((px - s.x) * s.lx + (pz - s.z) * s.lz) * 0.9, iz = pz - s.lz * Math.sign((px - s.x) * s.lx + (pz - s.z) * s.lz) * 0.9;
        if (!ctx.clearOfRoads(ix, iz, 0.6)) continue;
        b.box(ix - 0.7, y0, iz - 0.7, ix + 0.7, y0 + bridgeY, iz + 0.7);
        b.colCyl(ix, iz, y0, y0 + bridgeY, 0.8);
      }
    }
  }
  return { S, y0, top: y0 + H, step };
}

// one facade band from (ax,az) to (bx,bz): solid low band (service level) + glass curtain above
function band(b, ax, az, bx, bz, yb, top, u0, ybase, low, style, lowColor = CONC) {
  const lowTop = Math.max(yb, ybase + low);
  if (lowTop > yb + 0.05) {
    b.paint(lowColor, K.WIN, W.INDUSTRIAL);
    b.wall(ax, az, bx, bz, yb, Math.min(lowTop, top - 1.6), u0, ybase);
  }
  b.paint(GLASS_T, K.GLASS, style);
  b.wall(ax, az, bx, bz, Math.max(yb, lowTop), top - 1.6, u0, ybase);
}

// stands along one side of a strip: every `spacing` m where the aircraft footprint is clear of roads
// side: +1 left, -1 right. Returns [{F (facade point), N (outward), T, type}]
export function standsAlong(ctx, st, side, { spacing = 58, types = ['narrow'], from = 0.1, to = 0.95, gap = 7, floor = 4.6 } = {}) {
  const { S } = st;
  const out = [];
  let acc = 0, total = 0;
  const cum = [0];
  for (let i = 1; i < S.length; i++) { total += Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z); cum.push(total); }
  let k = 0;
  for (let d = total * from + spacing / 2; d < total * to; d += spacing, k++) {
    let i = 1;
    while (i < S.length - 1 && cum[i] < d) i++;
    const A = S[i - 1], B = S[i];
    if (A.br || B.br) continue;
    const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t;
    const w = side > 0 ? A.wl + (B.wl - A.wl) * t : A.wr + (B.wr - A.wr) * t;
    const N = [A.lx * side, A.lz * side], T = [A.tx, A.tz];
    const F = [x + N[0] * w, z + N[1] * w];
    const type = types[k % types.length];
    const [len, span] = AIRCRAFT_SIZE[type];
    // footprint test: nose at F + N*gap, tail at F + N*(gap+len)
    let ok = true;
    for (const fl of [0.02, 0.35, 0.65, 0.98]) for (const fs of [-0.5, 0, 0.5]) {
      const px = F[0] + N[0] * (gap + len * fl) + T[0] * span * fs * (fl > 0.25 && fl < 0.75 ? 1 : 0.25);
      const pz = F[1] + N[1] * (gap + len * fl) + T[1] * span * fs * (fl > 0.25 && fl < 0.75 ? 1 : 0.25);
      if (!ctx.clearOfRoads(px, pz, 2) || ctx.groundY(px, pz) < 0.2) ok = false;
    }
    if (!ok) continue;
    out.push({ F, N, T, type, gap, floor: st.y0 + floor, y: ctx.groundY(F[0] + N[0] * (gap + len / 2), F[1] + N[1] * (gap + len / 2)) });
  }
  return out;
}

// aircraft + jet bridge + paint + ground equipment at a stand
export function dressStand(ctx, s, { name = '', livery = 0, bridge = true, vehicles = true, plane = true, seed = 1, numberCell = null } = {}) {
  const { b, paint, gsign, sign, atlas } = ctx;
  const R = rng(seed);
  const type = AIRCRAFT[s.type];
  const [len] = AIRCRAFT_SIZE[s.type];
  const hl = len / 2;
  const cx = s.F[0] + s.N[0] * (s.gap + hl), cz = s.F[1] + s.N[1] * (s.gap + hl);
  const yaw = Math.atan2(s.N[0], s.N[1]); // local +z (tail) -> outward
  const gy = s.y;
  if (plane) ctx.instance(type, cx, gy, cz, yaw, LIVERIES[livery % LIVERIES.length], 1);
  // ground paint: lead-in line, stop bar, safety box
  const yAt = (x, z) => ctx.groundY(x, z);
  paint.paint(0xf2c200, K.PAINT);
  paint.ribbon([[s.F[0] + s.N[0] * (s.gap - 2), s.F[1] + s.N[1] * (s.gap - 2)], [s.F[0] + s.N[0] * (s.gap + len + 45), s.F[1] + s.N[1] * (s.gap + len + 45)]], 0.3, yAt, 0.05);
  const sb = [s.F[0] + s.N[0] * (s.gap + 1.5), s.F[1] + s.N[1] * (s.gap + 1.5)];
  paint.ribbon([[sb[0] - s.T[0] * 2.5, sb[1] - s.T[1] * 2.5], [sb[0] + s.T[0] * 2.5, sb[1] + s.T[1] * 2.5]], 0.5, yAt, 0.05);
  const span = AIRCRAFT_SIZE[s.type][1] + 6;
  paint.paint(0xc8232c, K.PAINT);
  const c0 = [s.F[0] + s.N[0] * 3, s.F[1] + s.N[1] * 3], c1 = [s.F[0] + s.N[0] * (s.gap + len + 4), s.F[1] + s.N[1] * (s.gap + len + 4)];
  for (const sg of [-1, 1]) paint.ribbon([[c0[0] + s.T[0] * span / 2 * sg, c0[1] + s.T[1] * span / 2 * sg], [c1[0] + s.T[0] * span / 2 * sg, c1[1] + s.T[1] * span / 2 * sg]], 0.25, yAt, 0.05);
  // stand number on the ground, readable when taxiing in
  if (numberCell) {
    const p = [s.F[0] + s.N[0] * (s.gap + len + 12), s.F[1] + s.N[1] * (s.gap + len + 12)];
    gsign.push();
    gsign.translate(p[0], yAt(p[0], p[1]) + 0.05, p[1]).rotY(yaw).rotX(-Math.PI / 2);
    signQuad(gsign, numberCell, -3, -2.2, 3, 2.2, 0, { lit: 0 });
    gsign.pop();
  }
  // jet bridge to the L1 door (aircraft left = local -x)
  const ac = DOOR[s.type];
  if (bridge && ac) {
    const lx = Math.cos(yaw), lz = -Math.sin(yaw); // local +x in world
    const zx = Math.sin(yaw), zz = Math.cos(yaw); // local +z in world
    const door = [cx - lx * (ac.x + 1.2) + zx * ac.z, cz - lz * (ac.x + 1.2) + zz * ac.z];
    jetBridge(ctx, s, door, gy + ac.y, R);
  }
  // gate sign on the facade
  if (name) {
    const cell = atlas.text(`gate-${name}`, name, { w: 144, h: 48, font: FONT.bold, fg: '#ffffff', bg: '#16324f' });
    sign.push();
    sign.translate(s.F[0] + s.N[0] * 0.3, s.floor + 4.4, s.F[1] + s.N[1] * 0.3).rotY(yaw);
    signBoard(sign, cell, -1.9, 0, 1.9, 1.25, -0.25, 0.05, { lit: 1, frame: 0x16324f, white: atlas.white });
    sign.pop();
  }
  if (vehicles && plane) {
    // ground handling on the right (service) side: real catalog vehicles for the tug, catering and fuel trucks,
    // apron-specific baggage carts and belt loader as models of their own
    const sc = len / 38, c = Math.cos(yaw), sn = Math.sin(yaw);
    const W = (lx, lz) => [cx + c * lx + sn * lz, cz - sn * lx + c * lz];
    b.push();
    b.translate(cx, gy, cz).rotY(yaw);
    b.lod = LOD.NEAR;
    const train = R() < 0.8, belt = R() < 0.6, cater = R() < 0.5, fuel = R() < 0.4 && len > 30;
    if (train) bagCarts(b, 7 * sc, 6 * sc, R);
    if (belt) beltLoader(b, 3.2 * sc, 8 * sc);
    b.pop();
    if (train) { const [x, z] = W(7 * sc - 1.0, 6 * sc - 2.6); ctx.vehicle('car:pickup', x, z, yaw + 0.3, { y: gy, color: 0xf2c200 }); }
    if (cater) { const [x, z] = W(2.2 * sc + 5.6, -6 * sc); ctx.vehicle('car:box_truck', x, z, yaw - Math.PI / 2, { y: gy, color: 0xf4f4f2 }); }
    if (fuel) { const [x, z] = W(13 * sc, -1 * sc); ctx.vehicle('car:tanker', x, z, yaw, { y: gy, color: 0xf4f4f2 }); }
  }
}

// door positions (local: x = half-width offset of the L1 door, y = sill height, z = along, nose at -len/2)
const DOOR = {
  narrow: { x: 1.98, y: 3.4, z: -18.8 + 5.4 },
  wide: { x: 2.82, y: 5.0, z: -31.8 + 8.4 },
  widecargo: null,
  turboprop: null,
  light: null,
  bizjet: null,
};

export function jetBridge(ctx, s, door, doorY, R) {
  const { b } = ctx;
  // rotunda 5 m out from the facade, offset towards the door side
  const side = Math.sign((door[0] - s.F[0]) * s.T[0] + (door[1] - s.F[1]) * s.T[1]) || 1;
  const rx = s.F[0] + s.N[0] * 5 + s.T[0] * side * 2, rz = s.F[1] + s.N[1] * 5 + s.T[1] * side * 2;
  const g = ctx.groundY(rx, rz);
  const fy = s.floor;
  b.lod = LOD.BOTH;
  b.paint(0xb8bdc2, K.METAL);
  b.cyl(rx, rz, g, fy + 3.4, 0.45, 0.45, 6);
  b.paint(0xd7dadd, K.METAL);
  b.cyl(rx, rz, fy - 0.3, fy + 3.3, 2.3, 2.3, 10);
  b.colCyl(rx, rz, g, fy + 3.3, 0.6);
  // fixed link building -> rotunda
  tunnel(b, [s.F[0] - s.N[0] * 0.5 + s.T[0] * side * 2, fy, s.F[1] - s.N[1] * 0.5 + s.T[1] * side * 2], [rx, fy, rz], 2.8, 3.0);
  // telescoping tunnel: two sections + cab
  const dx = door[0] - rx, dz = door[1] - rz;
  const Ltot = Math.hypot(dx, dz);
  const ux = dx / Ltot, uz = dz / Ltot;
  const endY = doorY;
  const mid = 0.55;
  const p0 = [rx + ux * 2.2, fy, rz + uz * 2.2];
  const p1 = [rx + ux * Ltot * mid, fy + (endY - fy) * mid, rz + uz * Ltot * mid];
  const p2 = [door[0] - ux * 2.4, endY, door[1] - uz * 2.4];
  tunnel(b, p0, p1, 3.2, 3.2);
  tunnel(b, [p1[0] - ux * 0.6, p1[1] - 0.05, p1[2] - uz * 0.6], p2, 2.8, 2.9);
  // cab angled to the fuselage
  b.push();
  b.translate(p2[0] + ux * 1.3, endY, p2[2] + uz * 1.3).rotY(Math.atan2(-uz, ux));
  b.paint(0x8f959b, K.METAL);
  b.box(-1.3, -0.3, -1.9, 1.3, 2.9, 1.9);
  b.paint(0x1d2a33, K.GLASS, 2);
  b.box(-1.0, 0.9, -1.92, 1.0, 2.3, 1.92, 0b000011);
  b.pop();
  // drive column (A-frame) with wheel bogie under the second section
  const qx = rx + ux * Ltot * 0.75, qz = rz + uz * Ltot * 0.75, qy = fy + (endY - fy) * 0.75;
  const qg = ctx.groundY(qx, qz);
  b.paint(0x6d7378, K.METAL);
  b.beam(qx - uz * 1.2, qg + 0.8, qz + ux * 1.2, qx, qy - 0.2, qz, 0.25, 0.25, 0b1111);
  b.beam(qx + uz * 1.2, qg + 0.8, qz - ux * 1.2, qx, qy - 0.2, qz, 0.25, 0.25, 0b1111);
  b.paint(0x222426, K.PLAIN);
  b.box(qx - 1.6, qg, qz - 1.6, qx + 1.6, qg + 0.9, qz + 1.6);
  b.colCyl(qx, qz, qg, qg + 1, 1.2);
}

function tunnel(b, a, c, w, h) {
  const dx = c[0] - a[0], dz = c[2] - a[2];
  const L0 = Math.hypot(dx, dz);
  if (L0 < 0.3) return;
  b.push();
  b.translate(a[0], a[1], a[2]).rotY(Math.atan2(-dz, dx));
  const slope = (c[1] - a[1]) / L0;
  // sheared box: write faces by hand so the floor follows the slope
  const P = (x, y, z) => [x, y + x * slope, z];
  const hw = w / 2;
  b.paint(0xd9dcdf, K.METAL);
  b.quad(P(0, 0, hw), P(L0, 0, hw), P(L0, h, hw), P(0, h, hw));
  b.quad(P(L0, 0, -hw), P(0, 0, -hw), P(0, h, -hw), P(L0, h, -hw));
  b.quad(P(0, h, hw), P(L0, h, hw), P(L0, h, -hw), P(0, h, -hw));
  b.paint(0x7c8288, K.METAL);
  b.quad(P(0, 0, -hw), P(L0, 0, -hw), P(L0, 0, hw), P(0, 0, hw));
  b.lod = LOD.NEAR;
  b.paint(0x24323c, K.NIGHTWIN);
  b.quad(P(0.4, 1.1, hw + 0.02), P(L0 - 0.4, 1.1, hw + 0.02), P(L0 - 0.4, 2.2, hw + 0.02), P(0.4, 2.2, hw + 0.02));
  b.quad(P(L0 - 0.4, 1.1, -hw - 0.02), P(0.4, 1.1, -hw - 0.02), P(0.4, 2.2, -hw - 0.02), P(L0 - 0.4, 2.2, -hw - 0.02));
  b.lod = LOD.BOTH;
  b.pop();
}

// ---------- ground support equipment (local aircraft frame, nose -z) ----------
// baggage carts trailing a tug at (x, z) (the tug itself is a catalog vehicle, see dressStand)
function bagCarts(b, x, z, R) {
  for (let i = 1; i <= 3; i++) {
    const zz = z + i * 3.3 * Math.cos(0.3), xx = x + i * 3.3 * Math.sin(0.3);
    b.push(); b.translate(xx, 0, zz).rotY(0.3);
    b.paint(0x2c2e31, K.PLAIN); b.box(-0.8, 0.3, -1.3, 0.8, 0.55, 1.3);
    b.paint(R() < 0.5 ? 0x3b5f8a : 0x8a8f94, K.METAL); b.box(-0.75, 0.55, -1.25, 0.75, 1.9, 1.25);
    b.pop();
  }
}
function beltLoader(b, x, z) {
  b.push(); b.translate(x, 0, z).rotY(0.0);
  b.paint(0xe0e0e0, K.PLAIN); b.box(-0.9, 0.2, -3, 0.9, 1.1, 3);
  b.paint(0x303236, K.PLAIN);
  b.beam(0, 1.1, 2.5, 0, 3.1, -3.5, 1.0, 0.25);
  b.pop();
}
// ---------- control tower ----------
export function controlTower(ctx, x, z, { h = 72, y0 = null, name = 'VCI', beacon = true } = {}) {
  const { b, lights, sign, atlas } = ctx;
  const g = y0 ?? ctx.groundY(x, z) - 0.5;
  // shaft: slender, slightly tapered octagon with a vertical glass slot (stair core) and fins
  b.paint(0xe9e6df, K.PLAIN);
  b.cyl(x, z, g, g + h - 14, 5.2, 4.2, 8, { phase: Math.PI / 8 });
  b.colCyl(x, z, g, g + h, 5.4);
  b.lod = LOD.NEAR;
  b.paint(0x5d7f95, K.GLASS, 1);
  b.box(x + 3.9, g + 6, z - 0.8, x + 5.0, g + h - 16, z + 0.8);
  b.lod = LOD.BOTH;
  // flared transition + equipment floor
  b.paint(0xdcd8d0, K.PLAIN);
  b.cyl(x, z, g + h - 14, g + h - 9, 4.2, 8.2, 8, { phase: Math.PI / 8 });
  b.paint(0xcfcac2, K.WIN, W.GRID);
  b.cyl(x, z, g + h - 9, g + h - 6, 8.2, 8.2, 8, { phase: Math.PI / 8 });
  // cab: outward-leaning glass (inverted frustum), dark mullion ring, roof disc + antennas
  b.paint(0x3c5566, K.GLASS, 1);
  b.cyl(x, z, g + h - 6, g + h - 1.2, 7.4, 8.9, 12, { phase: Math.PI / 12, top: false });
  b.paint(0x2b2f33, K.METAL);
  b.cyl(x, z, g + h - 1.2, g + h, 9.3, 9.3, 12, { phase: Math.PI / 12 });
  b.paint(0xe2e2e2, K.METAL);
  b.cyl(x, z, g + h, g + h + 1.6, 6.5, 5.5, 12);
  b.lod = LOD.NEAR;
  b.paint(0xa0a5aa, K.METAL);
  for (const [ax, az, ah] of [[2, 1, 7], [-2.5, -1.5, 5], [0.5, -3, 4]]) b.cyl(x + ax, z + az, g + h + 1.6, g + h + 1.6 + ah, 0.12, 0.06, 4);
  b.lod = LOD.BOTH;
  lights.obstacle(x + 2, g + h + 8.8, z + 1);
  lights.obstacle(x, g + h + 1.8, z + 6.4, 1.2);
  if (beacon) lights.add(x - 2.5, g + h + 7, z - 1.5, 0xffffff, 2.6, L.BEACON, 0, 9000);
  // name board on two sides of the equipment floor
  const cell = atlas.text(`twr-${name}`, name, { w: 256, h: 96, font: FONT.block, fg: '#ffffff', bg: '#1f3b5a' });
  for (const a of [0, Math.PI]) {
    sign.push();
    sign.translate(x, g + h - 8.6, z).rotY(a);
    signQuad(sign, cell, -4.5, 0, 4.5, 2.2, 8.3, { lit: 1 });
    sign.pop();
  }
  return g + h;
}

// ---------- hangar: barrel-vault roof over a box, big sliding doors on the front (+z local) ----------
export function hangar(ctx, cx, cz, yaw, len, dep, h, { name = '', color = 0xd9dde0, door = 0x8d969d, y0 = null, rise = null, signFace = true } = {}) {
  const { b, sign, atlas, lights } = ctx;
  const g = y0 ?? ctx.groundY(cx, cz) - 0.6;
  b.push();
  b.translate(cx, g, cz).rotY(yaw);
  const hw = len / 2, hd = dep / 2, wall = h * 0.62, rs = rise ?? h - wall;
  // side + back walls
  b.paint(color, K.METAL);
  b.wall(-hw, -hd, hw, -hd, 0, wall); // back (-z)
  b.wall(hw, -hd, hw, hd, 0, wall);
  b.wall(-hw, hd, -hw, -hd, 0, wall);
  // vault across the length (axis along local z = depth), arch spans x
  b.paint(0xe6e8e9, K.METAL);
  b.vault(-hw, hw, -hd, hd, wall, rs, 10, { ends: true });
  // front: door panels + header
  b.paint(door, K.METAL);
  const panels = Math.max(2, Math.round(len / 9));
  for (let i = 0; i < panels; i++) {
    const x0 = -hw + (i / panels) * len, x1 = -hw + ((i + 1) / panels) * len;
    b.box(x0 + 0.05, 0, hd - 0.3 - (i % 2) * 0.35, x1 - 0.05, wall - 0.6, hd + 0.05 - (i % 2) * 0.35, 0b110010);
  }
  b.paint(0x50565c, K.PLAIN);
  b.box(-hw, wall - 0.6, hd - 0.2, hw, wall + 0.4, hd + 0.2, 0b001010);
  // side annex (offices) along one side
  b.lod = LOD.NEAR;
  b.paint(0xcac6bd, K.WIN, W.GRID);
  b.box(hw, 0, -hd, hw + 6, 7.2, hd * 0.6);
  b.paint(0xa9aaa6, K.ROOF);
  b.box(hw, 7.2, -hd, hw + 6, 7.5, hd * 0.6);
  b.lod = LOD.BOTH;
  b.colBox(-hw, 0, -hd, hw, wall, hd);
  b.colBox(-hw * 0.7, wall, -hd, hw * 0.7, wall + rs * 0.85, hd);
  // apron flood lights over the doors
  for (const fx of [-0.33, 0.33]) {
    const p = b.world(fx * len, wall + 0.8, hd + 0.6);
    lights.add(p[0], p[1], p[2], 0xfff0d0, 1.4, L.STEADY, 0, 3500);
  }
  const top = b.world(0, wall + rs + 0.3, 0);
  if (h > 20) lights.obstacle(top[0], top[1], top[2], 1.2);
  b.pop();
  if (name && signFace) {
    const cell = atlas.text(`hgr-${name}`, name, { w: 512, h: 72, font: FONT.block, fg: '#ffffff', bg: '#24435f' });
    sign.push();
    sign.translate(cx, g, cz).rotY(yaw);
    const sw = Math.min(len * 0.6, 34);
    signQuad(sign, cell, -sw / 2, wall + rs * 0.15, sw / 2, wall + rs * 0.15 + sw * 0.14, hd + rs * 0.02 + 0.6, { lit: 1 });
    sign.pop();
  }
}

// ---------- fuel farm ----------
export function fuelFarm(ctx, cx, cz, yaw = 0, { tanks = 4, r = 9, h = 13 } = {}) {
  const { b } = ctx;
  const g = ctx.groundY(cx, cz) - 0.3;
  b.push();
  b.translate(cx, g, cz).rotY(yaw);
  const cols = Math.ceil(tanks / 2);
  const W0 = cols * (r * 2 + 6) + 8, D0 = 2 * (r * 2 + 6) + 8;
  // bund wall + gravel floor
  b.paint(0xbdb7aa, K.PLAIN);
  b.box(-W0 / 2, 0, -D0 / 2, W0 / 2, 0.25, D0 / 2);
  b.paint(0xd2cdc2, K.PLAIN);
  for (const [x0, z0, x1, z1] of [[-W0 / 2, -D0 / 2, W0 / 2, -D0 / 2 + 0.8], [-W0 / 2, D0 / 2 - 0.8, W0 / 2, D0 / 2], [-W0 / 2, -D0 / 2, -W0 / 2 + 0.8, D0 / 2], [W0 / 2 - 0.8, -D0 / 2, W0 / 2, D0 / 2]]) b.box(x0, 0, z0, x1, 1.6, z1);
  for (let i = 0; i < tanks; i++) {
    const c = i % cols, rr = Math.floor(i / cols);
    const x = -W0 / 2 + 4 + r + 3 + c * (r * 2 + 6), z = -D0 / 2 + 4 + r + 3 + rr * (r * 2 + 6);
    tank(b, x, z, 0.25, r, h, { color: 0xeceee9, band: i % 2 ? 0x2f6db5 : 0xd04030 });
  }
  // pipe rack + pump house
  b.lod = LOD.NEAR;
  b.paint(0x9aa1a7, K.METAL);
  b.beam(-W0 / 2 + 2, 1.2, 0, W0 / 2 + 10, 1.2, 0, 0.5, 0.5);
  b.beam(-W0 / 2 + 2, 1.9, 0.9, W0 / 2 + 10, 1.9, 0.9, 0.4, 0.4);
  b.lod = LOD.BOTH;
  b.paint(0xd6d1c6, K.WIN, W.INDUSTRIAL);
  b.box(W0 / 2 + 4, 0, -5, W0 / 2 + 16, 5, 5);
  b.colBox(W0 / 2 + 4, 0, -5, W0 / 2 + 16, 5, 5);
  b.pop();
  const fence = [];
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const corner = (x, z) => [cx + x * cs + z * sn, cz - x * sn + z * cs];
  for (const [x, z] of [[-W0 / 2 - 4, -D0 / 2 - 4], [W0 / 2 + 20, -D0 / 2 - 4], [W0 / 2 + 20, D0 / 2 + 4], [-W0 / 2 - 4, D0 / 2 + 4], [-W0 / 2 - 4, -D0 / 2 - 4]]) fence.push(corner(x, z));
  fenceLine(b, fence, (x, z) => ctx.groundY(x, z), { h: 2.4, step: 5, gaps: [[...corner(W0 / 2 + 20, 0), 4]] });
}

// ---------- multi-storey car park on a footprint polygon ----------
export function garage(ctx, poly, { levels = 5, lh = 3.1, name = 'P', seed = 7 } = {}) {
  const { b, sign, atlas, lights } = ctx;
  const R = rng(seed);
  const g = Math.min(...poly.map(([x, z]) => ctx.groundY(x, z))) - 0.5;
  for (let k = 0; k < levels; k++) {
    const y = g + k * lh;
    b.paint(0xd7d3ca, K.PLAIN);
    b.prism(poly, y + lh - 0.55, y + lh, { top: k === levels - 1, topPaint: [0x8e9196, K.ROOF] });
    b.paint(0x6c6f72, K.WIN, W.GARAGE);
    b.prism(poly, y, y + lh - 0.55, { top: false, vBase: y - 0.0 });
  }
  b.colPrism(poly, g, g + levels * lh);
  // roof deck: parapet, light poles, parked cars (real catalog cars in painted bays, rows of nose-in bays
  // back to back with 6.5 m aisles)
  const top = g + levels * lh;
  const ob = obb(poly);
  if (ob) {
    const yaw = ob.yaw;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const P = (lx, lz) => [ob.cx + c * lx + sn * lz, ob.cz - sn * lx + c * lz];
    const bay = 2.7, depth = 5.2, aisle = 6.5;
    const n = Math.floor((ob.len - 9) / bay);
    // a sparsely used roof (the cars are real catalog models: keep the count moderate)
    let budget = 36;
    for (let z0 = -ob.wid / 2 + 3, k = 0; z0 + depth <= ob.wid / 2 - 3 && budget > 0; k++) {
      // bays facing +z (nose-in), then the next row facing -z sharing the same aisle side
      const flip = k % 2 === 1;
      const o = P(-ob.len / 2 + 4.5, flip ? z0 + depth : z0);
      const res = parkingRow(ctx, {
        x: o[0], z: o[1], ux: c, uz: -sn, vx: flip ? -sn : sn, vz: flip ? -c : c, n, bay, depth, max: Math.min(budget, 10),
        keys: LOT_CARS, fill: Math.min(0.6, 12 / Math.max(1, n)), seed: seed + k * 31, y: top, check: { structures: false, roads: false, buildings: false },
      });
      budget -= res.placed;
      z0 += depth + (flip ? aisle : 0);
    }
    for (let i = 0; i < 4; i++) {
      const t = (i + 0.5) / 4 - 0.5;
      const p = [ob.cx + Math.cos(yaw) * t * ob.len * 0.8, ob.cz - Math.sin(yaw) * t * ob.len * 0.8];
      mast(b, lights, p[0], p[1], top, 8, { heads: 2, color: 0xfff4e0, size: 1.8 });
    }
    // big "P" signs on the long faces
    const cell = atlas.text(`garage-${name}`, name, { w: 128, h: 128, font: FONT.block, fg: '#ffffff', bg: '#1e5aa8' });
    for (const s of [1, -1]) {
      sign.push();
      sign.translate(ob.cx, top - lh * 0.9, ob.cz).rotY(yaw + (s > 0 ? 0 : Math.PI));
      signQuad(sign, cell, -2.6, 0, 2.6, 5.2, ob.wid / 2 + 0.25, { lit: 1 });
      sign.pop();
    }
  }
  return top;
}

// ---------- cargo shed with loading docks on one long side (local +z) ----------
export function cargoShed(ctx, ob, { h = 14, name = 'CARGO', side = 1, y0 = null } = {}) {
  const { b, sign, atlas, lights } = ctx;
  const g = y0 ?? ctx.groundY(ob.cx, ob.cz) - 0.6;
  const yaw = ob.yaw + (side < 0 ? Math.PI : 0);
  b.push(); b.translate(ob.cx, g, ob.cz).rotY(yaw);
  const hl = ob.len / 2, hw = ob.wid / 2;
  b.paint(0xd8d4cb, K.WIN, W.INDUSTRIAL);
  b.box(-hl, 0, -hw, hl, h, hw);
  b.paint(0xa6a8aa, K.METAL);
  // saw-tooth roof lights
  const n = Math.max(2, Math.round(ob.len / 12));
  for (let i = 0; i < n; i++) {
    const x0 = -hl + (i / n) * ob.len, x1 = -hl + ((i + 1) / n) * ob.len;
    b.quad([x0, h, -hw], [x0, h, hw], [x1, h + 2.4, hw], [x1, h + 2.4, -hw]);
    b.paint(0x5c7a90, K.GLASS, 2);
    b.quad([x1, h, hw], [x1, h, -hw], [x1, h + 2.4, -hw], [x1, h + 2.4, hw]);
    b.paint(0xa6a8aa, K.METAL);
  }
  // dock doors + canopy along +z
  b.paint(0x4f6f8f, K.METAL);
  const docks = Math.floor(ob.len / 9);
  for (let i = 0; i < docks; i++) {
    const x = -hl + 4.5 + i * 9;
    b.box(x - 1.8, 0.4, hw, x + 1.8, 4.6, hw + 0.15, 0b000010);
  }
  b.paint(0xc9ccd0, K.METAL);
  b.box(-hl, 6.2, hw, hl, 6.6, hw + 6, 0b111111);
  b.colBox(-hl, 0, -hw, hl, h + 2, hw);
  for (let i = 0; i < 4; i++) {
    const p = b.world(-hl * 0.75 + i * hl * 0.5, 6.0, hw + 5);
    lights.add(p[0], p[1], p[2], 0xfff0d0, 1.2, L.STEADY, 0, 2500);
  }
  b.pop();
  // box trucks backed into every other dock (catalog Carrier 26), a few tractor units waiting further out
  {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const W = (lx, lz) => [ob.cx + c * lx + sn * lz, ob.cz - sn * lx + c * lz];
    const R = rng(Math.abs(ob.cx | 0) + 3);
    for (let i = 0; i < docks; i += 2) {
      if (R() < 0.3) continue;
      const m = ctx.vehicleModel('car:box_truck');
      if (!m) break;
      const [px, pz] = W(-hl + 4.5 + i * 9, hw + 1.2 + m.len / 2 - m.cz);
      ctx.park('car:box_truck', px, pz, yaw + Math.PI, { y: g + 0.6 });
    }
    for (let i = 0; i < 3; i++) {
      const [px, pz] = W(-hl + 8 + i * 6, hw + 22);
      ctx.park('car:semi', px, pz, yaw + Math.PI, { y: g + 0.6 });
    }
  }
  const cell = atlas.text(`cargo-${name}`, name, { w: 512, h: 80, font: FONT.block, fg: '#1d2b3a', bg: '#f2f2f2' });
  sign.push(); sign.translate(ob.cx, g, ob.cz).rotY(yaw);
  signQuad(sign, cell, -12, h - 4, 12, h - 0.5, hw + 0.2, { lit: 1 });
  sign.pop();
}

// ---------- airport rescue & fire-fighting station ----------
export function fireStation(ctx, x, z, yaw) {
  const { b, sign, atlas, lights } = ctx;
  const g = ctx.groundY(x, z) - 0.5;
  b.push(); b.translate(x, g, z).rotY(yaw);
  b.paint(0xe6e1d6, K.WIN, W.GRID);
  b.box(-26, 0, -12, 26, 9, 10);
  b.paint(0xb2b0aa, K.ROOF);
  b.box(-26, 9, -12, 26, 9.4, 10);
  b.paint(0xc8202a, K.METAL);
  for (let i = 0; i < 5; i++) b.box(-24 + i * 9.6, 0.2, 10, -17 + i * 9.6, 6.4, 10.2, 0b000010);
  // watch room on a short tower
  b.paint(0xe6e1d6, K.PLAIN);
  b.box(18, 9, -12, 26, 15, -4);
  b.paint(0x3c5566, K.GLASS, 1);
  b.box(17.5, 15, -12.5, 26.5, 18.5, -3.5);
  b.paint(0x2b2f33, K.METAL);
  b.box(17, 18.5, -13, 27, 19.2, -3);
  b.colBox(-26, 0, -12, 26, 9.4, 10);
  b.colBox(18, 9, -12, 26, 19, -4);
  const p = b.world(22, 19.5, -8);
  lights.add(p[0], p[1], p[2], 0xff3020, 1.2, L.SLOW, 0.3, 4000);
  b.pop();
  // crash tenders / engines on the apron in front of three bays, facing out
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  for (let i = 0; i < 3; i++) {
    const lx = -20.5 + i * 9.6, lz = 10 + 8;
    ctx.park('car:fire_engine', x + c * lx + sn * lz, z - sn * lx + c * lz, yaw + Math.PI, { y: g + 0.5 });
  }
  const cell = atlas.text('arff', 'FIRE · RESCUE', { w: 512, h: 72, font: FONT.block, fg: '#ffffff', bg: '#b3141e' });
  sign.push(); sign.translate(x, g, z).rotY(yaw);
  signQuad(sign, cell, -12, 7, 12, 8.6, 10.25, { lit: 1 });
  sign.pop();
}

// ---------- surveillance radar: lattice tower + rotating antenna (spinner) ----------
export function radarTower(ctx, x, z, { h = 26, speed = 2.1 } = {}) {
  const { b, lights } = ctx;
  const g = ctx.groundY(x, z) - 0.3;
  b.paint(0xe2ded6, K.WIN, W.GRID);
  b.box(x - 6, g, z - 4, x + 6, g + 4.5, z + 4);
  b.colBox(x - 6, g, z - 4, x + 6, g + 4.5, z + 4);
  antenna(b, lights, x, z + 9, g, h, { w: 4, color: 0xd8d8d8, alt: 0xc83a2a });
  b.paint(0x3a3d41, K.METAL);
  b.box(x - 1.6, g + h, z + 9 - 1.6, x + 1.6, g + h + 1.2, z + 9 + 1.6);
  const si = ctx.spinner(x, g + h + 1.6, z + 9, [0, 1, 0], speed, 0);
  b.push();
  b.spinIdx = si;
  b.paint(0xeeeeee, K.METAL);
  // curved reflector (3 tilted panels) + feed horn
  for (let i = -1; i <= 1; i++) {
    b.push(); b.translate(x, g + h + 2.6, z + 9).rotY(i * 0.28);
    b.box(-0.15, -1.2, -2.6 * 0.95, 0.15, 1.2, 2.6 * 0.95);
    b.pop();
  }
  b.paint(0x3a3d41, K.METAL);
  b.box(x + 0.15, g + h + 1.2, z + 9 - 0.3, x + 2.2, g + h + 2.0, z + 9 + 0.3);
  b.pop();
  b.colCyl(x, z + 9, g, g + h, 2.5);
}

export { ROOF, FASCIA, GLASS_T, CONC };

// ---------- airside clean-up ----------
// Generic city buildings standing on the airfield (surrounded by apron / taxiway / runway-strip ground: at least
// half of a ring 6 m outside the footprint lies on the airside mask) are removed. The large ones that are clear of
// parked aircraft, vehicles and roads are rebuilt as airport buildings (low white ops / service blocks with a
// blue fascia, sheds with industrial cladding) instead of apartment blocks. Returns { removed, rebuilt }.
export function clearAirside(ctx, mask, cx, cz, R, { rebuildArea = 900 } = {}) {
  const B = ctx.buildings;
  if (!B?.query) return { removed: 0, rebuilt: 0 };
  let removed = 0, rebuilt = 0;
  const placed = ctx.L.vehicles, inst = [...ctx.L.instTypes.values()];
  for (const id of B.query(cx, cz, R)) {
    const rec = B.recs[id];
    if (!rec || rec.removed) continue;
    const p = B.list[id].p, n = p.length / 2;
    let ax = 0, az = 0, area = 0;
    for (let i = 0; i < n; i++) { ax += p[2 * i]; az += p[2 * i + 1]; const j = (i + 1) % n; area += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; }
    ax /= n; az /= n; area = Math.abs(area) / 2;
    let on = 0, tot = 0;
    for (let i = 0; i < n; i++) {
      for (const f of [0, 0.5]) {
        const j = (i + 1) % n, x = p[2 * i] + (p[2 * j] - p[2 * i]) * f, z = p[2 * i + 1] + (p[2 * j + 1] - p[2 * i + 1]) * f;
        const dx = x - ax, dz = z - az, l = Math.hypot(dx, dz) || 1;
        tot++;
        if (mask.has(x + (dx / l) * 6, z + (dz / l) * 6)) on++;
      }
    }
    if (!tot || on / tot < 0.5) continue;
    const poly = [];
    for (let i = 0; i < n; i++) poly.push([p[2 * i], p[2 * i + 1]]);
    // anything parked or a road on the footprint: just clear it
    const r = Math.sqrt(area / Math.PI) + 40;
    const blocked = placed.some((v) => Math.hypot(v.x - ax, v.z - az) < r && inside(poly, v.x, v.z))
      || inst.some((t) => t.list.some((e) => Math.hypot(e[0] - ax, e[2] - az) < r + 30 && inside(poly, e[0], e[2])))
      || poly.some(([x, z]) => !ctx.clearOfRoads(x, z, 1));
    ctx.remove({ ids: [id] });
    removed++;
    if (area < rebuildArea || blocked || !ctx.dryPoly(poly, 0.3)) continue;
    opsBuilding(ctx, poly, Math.max(5, Math.min(rec.height || 8, area > 4000 ? 14 : 9)), area > 3500);
    rebuilt++;
  }
  return { removed, rebuilt };
}

export function opsBuilding(ctx, poly, h, shed) {
  const { b, lights } = ctx;
  const g = Math.min(...poly.map(([x, z]) => ctx.groundY(x, z))) - 0.4;
  b.paint(shed ? 0xd6d8d6 : 0xeeece6, K.WIN, shed ? W.INDUSTRIAL : W.GRID);
  b.prism(poly, g, g + h - 1.1, { top: false });
  b.paint(0x1f5fa8, K.PLAIN);
  b.prism(poly, g + h - 1.1, g + h, { top: true, topPaint: [0xb7babc, K.ROOF] });
  b.colPrism(poly, g, g + h);
  // rooftop plant
  const ob = obb(poly);
  if (ob && ob.len > 14 && ob.wid > 10) {
    b.push(); b.translate(ob.cx, g + h, ob.cz).rotY(ob.yaw);
    b.lod = LOD.NEAR;
    b.paint(0x8e9296, K.METAL);
    b.box(-ob.len * 0.25 - 2, 0, -2, -ob.len * 0.25 + 2, 1.8, 2);
    b.box(ob.len * 0.2 - 1.5, 0, -1.5, ob.len * 0.2 + 1.5, 1.4, 1.5);
    b.lod = 0;
    b.pop();
    const p = [ob.cx, g + h + 0.4, ob.cz];
    lights.add(p[0], p[1], p[2], 0xff3020, 0.5, L.STEADY, 0, 1800);
  }
}
