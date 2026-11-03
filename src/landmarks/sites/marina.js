import { K, LOD, rng } from '../kit.js';
import { L } from '../lights.js';

// Marina (source-map "#marina" markers): finger piers from the nearest shore into open water with the game's
// real boats (src/boat models) moored alongside, bows out. Piers: timber deck on posts with a collider; every
// boat only where the water is at least 0.7 m deep along its whole hull.

const BOATS = ['boat:boat_speed', 'boat:boat_speed', 'boat:boat_cruiser', 'boat:boat_jetski', 'boat:boat_cruiser'];

// shore point near (x, z): land (>= 0.3 m) with open water (<= -0.8 m: marina basins are shallow) beyond it
// shore candidates around (x,z), nearest first: a land point (>= 0.3 m) looking out over water that is
// deeper than 0.8 m from 26 m out (a shallow fringe of up to ~24 m is crossed by the piers)
function shoreCandidates(ctx, x, z, maxR = 260) {
  const out = [];
  for (let rr = 0; rr <= maxR; rr += 12) {
    const n = Math.max(1, Math.round((2 * Math.PI * rr) / 12));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      if (ctx.groundY(px, pz) < 0.3) continue;
      for (let k = 0; k < 24; k++) {
        const b = (k / 24) * Math.PI * 2, dx = Math.cos(b), dz = Math.sin(b);
        if (ctx.groundY(px + dx * 12, pz + dz * 12) > 0.3) continue;
        let ok = true;
        for (const d of [26, 40, 54]) if (ctx.groundY(px + dx * d, pz + dz * d) > -0.8) { ok = false; break; }
        if (!ok) continue;
        // walk to the waterline
        let d0 = 0;
        while (d0 < 14 && ctx.groundY(px + dx * (d0 + 1), pz + dz * (d0 + 1)) > 0.2) d0++;
        out.push({ x: px + dx * d0, z: pz + dz * d0, dx, dz, dist: rr });
      }
    }
    if (out.length > 160) break;
  }
  return out;
}

// pier layout for one shore candidate: [{ox, oz, len}] (roots on the waterline, clear of every road)
function pierPlan(ctx, sh, piers, gap, why) {
  const px = -sh.dz, pz = sh.dx;
  const plan = [];
  for (let p = 0; p < piers; p++) {
    const off = (p - (piers - 1) / 2) * gap;
    let ox = sh.x + px * off, oz = sh.z + pz * off;
    let k = 0;
    while (k < 20 && ctx.groundY(ox, oz) > 0.3) { ox += sh.dx; oz += sh.dz; k++; }
    while (k < 40 && ctx.groundY(ox - sh.dx, oz - sh.dz) < 0.3) { ox -= sh.dx; oz -= sh.dz; k++; }
    // length: across the shallow fringe, then as far as the water stays deeper than 0.8 m (max 64 m)
    let len = 4;
    while (len < 26 && ctx.groundY(ox + sh.dx * len, oz + sh.dz * len) > -0.8) len += 2;
    if (len >= 26) len = 0;
    else while (len < 64 && ctx.groundY(ox + sh.dx * (len + 4), oz + sh.dz * (len + 4)) < -0.8) len += 4;
    if (len < 16) { why.push('short ' + len); continue; }
    let clear = true;
    for (let s = -2; s <= len + 8 && clear; s += 4) if (!ctx.clearOfRoads(ox + sh.dx * s, oz + sh.dz * s, 9)) clear = false;
    if (!clear) { why.push('road'); continue; }
    plan.push({ ox, oz, len });
  }
  return plan;
}

export function marina(ctx, def) {
  const { b, lights } = ctx;
  const R = rng(Math.abs(def.x | 0) + 7);
  const piers = def.piers ?? 2, gap = 26;
  const why = [];
  // nearest shore spot whose piers stay clear of the roads (bridges / causeways run along many shores)
  let sh = null, plan = [];
  for (const c of shoreCandidates(ctx, def.x, def.z)) {
    const pl = pierPlan(ctx, c, piers, gap, why);
    if (pl.length > plan.length) { sh = c; plan = pl; }
    if (plan.length === piers) break;
  }
  if (!sh) return { skipped: true, why: why.length ? `no clear shore (${[...new Set(why)].join(',')})` : 'no shore' };
  const px = -sh.dz, pz = sh.dx; // along the shore
  let boats = 0, built = 0;
  for (const { ox, oz, len } of plan) {
    built++;
    const y = 1.1, hw = 1.5, yaw = Math.atan2(sh.dx, sh.dz);
    b.push(); b.translate(ox, 0, oz).rotY(yaw);
    b.paint(0x9a7a56, K.PLAIN);
    b.box(-hw, y - 0.25, -2, hw, y, len, 0b111111);
    b.lod = LOD.NEAR;
    b.paint(0x5a4a3a, K.PLAIN);
    for (let s = 0; s <= len; s += 6) for (const sx of [-hw + 0.2, hw - 0.2]) b.box(sx - 0.15, -2.5, s - 0.15, sx + 0.15, y - 0.25, s + 0.15);
    b.lod = LOD.BOTH;
    b.colBox(-hw, y - 0.6, -2, hw, y, len);
    b.pop();
    lights.add(ox + sh.dx * len, y + 1.2, oz + sh.dz * len, 0x30ff70, 0.6, L.STEADY, 0, 2000);
    // boats along both sides, bows towards open water
    for (let s = 8; s < len - 2; s += 13.5) {
      for (const side of [-1, 1]) {
        if (R() < 0.25) continue;
        const key = BOATS[Math.floor(R() * BOATS.length)];
        const m = ctx.vehicleModel(key);
        if (!m) continue;
        const lat = hw + 0.8 + m.wid / 2;
        const bx = ox + sh.dx * s + px * side * lat, bz = oz + sh.dz * s + pz * side * lat;
        let deep = true;
        for (const [a, c] of [[0, 0], [m.len / 2, m.wid / 2], [-m.len / 2, m.wid / 2], [m.len / 2, -m.wid / 2], [-m.len / 2, -m.wid / 2]]) {
          if (ctx.groundY(bx + sh.dx * a + px * c, bz + sh.dz * a + pz * c) > -0.7) { deep = false; break; }
        }
        if (!deep) continue;
        // bake frame: bow towards -Z; bow out along the pier = forward (sh.dx, sh.dz)
        ctx.vehicle(key, bx, bz, Math.atan2(-sh.dx, -sh.dz), { y: 0, collider: false });
        boats++;
      }
    }
  }
  if (!boats) return { skipped: true, why: why.join(',') || `piers ${built}, no deep berths` };
  ctx.view([sh.x - sh.dx * 30 + px * 50, 16, sh.z - sh.dz * 30 + pz * 50], [sh.x + sh.dx * 25, 0, sh.z + sh.dz * 25], 'marina');
  return { boats };
}
