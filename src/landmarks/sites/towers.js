import { K, LOD, W, obb, hull2d, superellipse } from '../kit.js';
import { L } from '../lights.js';
import { signQuad } from '../parts.js';
import { FONT } from '../atlas.js';

// Downtown / Tequesta signature towers (original designs inspired by Miami's skyline types: stepped lit
// tower, arched crown, spire, slanted roof, open lattice crown) and an art-deco tower with a clock.
// Each replaces the generic footprint(s) at its position; the shaft keeps the footprint's oriented rectangle.

function take(ctx, pts, r = 10, minArea = 150) {
  const fs = [];
  for (const [x, z] of pts) for (const f of ctx.footprints(x, z, r, minArea)) { fs.push(f); ctx.remove({ ids: [f.id] }); }
  return fs;
}

// rectangle with one (or two) semicircular ends along local x: plan of stepped towers
function dPlan(len, wid, round = 1, n = 6) {
  const hw = wid / 2, hl = len / 2;
  const out = [[-hl, -hw], [hl - hw * round, -hw]];
  for (let i = 1; i < n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI; out.push([hl - hw * round + Math.cos(a) * hw * round, Math.sin(a) * hw]); }
  out.push([hl - hw * round, hw], [-hl, hw]);
  return out;
}

function chamfer(len, wid, c) {
  const hl = len / 2, hw = wid / 2;
  return [[-hl + c, -hw], [hl - c, -hw], [hl, -hw + c], [hl, hw - c], [hl - c, hw], [-hl + c, hw], [-hl, hw - c], [-hl, -hw + c]];
}

function frame(ctx, fs, fallback) {
  const pts = fs.flatMap((f) => f.poly);
  const ob = pts.length >= 3 ? obb(pts) : null;
  return ob || fallback;
}

// ---------- stepped tower with colour-changing tiers (night icon of the skyline) ----------
export function steppedTower(ctx, def) {
  const { b, lights } = ctx;
  const fs = take(ctx, def.take || [[def.x, def.z]], 12, 300);
  const ob = frame(ctx, fs, { cx: def.x, cz: def.z, yaw: 0, len: 44, wid: 32 });
  const g = Math.min(...fs.map((f) => f.rec.base), ctx.groundY(ob.cx, ob.cz)) - 0.6;
  b.push(); b.translate(ob.cx, g, ob.cz).rotY(ob.yaw);
  const len = Math.min(ob.len, 56), wid = Math.min(ob.wid, 36);
  // garage podium
  b.paint(0xd8d4cc, K.WIN, W.GARAGE);
  b.prism(chamfer(len, wid, 2), 0, 30, { topPaint: [0x9a9c9e, K.ROOF] });
  // shaft (glass, rounded east end) + three stepped tiers with LED facades
  const H = def.h || 150;
  b.paint(0x5e7f99, K.GLASS, 0);
  b.prism(dPlan(len * 0.82, wid * 0.86), 30, H - 36, { top: false });
  b.colPrism(chamfer(len, wid, 2), 0, H - 36);
  const tiers = [[0.78, H - 36, H - 22], [0.62, H - 22, H - 10], [0.46, H - 10, H]];
  for (const [s, y0, y1] of tiers) {
    b.paint(0xf6f6f2, K.LED, 3);
    b.prism(dPlan(len * 0.82 * s / 0.78 * 0.98, wid * 0.86 * s / 0.78 * 0.98, 1, 8), y0, y1, { topPaint: [0xd9dcdf, K.ROOF] });
  }
  b.colPrism(dPlan(len * 0.6, wid * 0.66), H - 36, H);
  // mast + obstacle lights
  b.paint(0xcfd3d6, K.METAL);
  b.cyl(len * 0.1, 0, H, H + 22, 0.6, 0.2, 6);
  const top = b.world(len * 0.1, H + 22.5, 0);
  lights.obstacle(top[0], top[1], top[2], 2);
  for (const [sx, sz] of [[1, 1], [-1, -1]]) { const p = b.world(sx * len * 0.3, H + 0.5, sz * wid * 0.25); lights.obstacle(p[0], p[1], p[2], 1.2); }
  b.pop();
  ctx.view([ob.cx - 260, g + 120, ob.cz + 210], [ob.cx, g + H * 0.7, ob.cz], 'stepped tower');
}

// ---------- tower with an arched crown ----------
export function archTower(ctx, def) {
  const { b, lights } = ctx;
  const fs = take(ctx, def.take || [[def.x, def.z]], 8, 300);
  const ob = frame(ctx, fs, { cx: def.x, cz: def.z, yaw: 0, len: 34, wid: 28 });
  const g = Math.min(...fs.map((f) => f.rec.base), ctx.groundY(ob.cx, ob.cz)) - 0.6;
  const H = def.h || 205, rise = def.rise || 34;
  const len = ob.len, wid = ob.wid;
  b.push(); b.translate(ob.cx, g, ob.cz).rotY(ob.yaw);
  b.paint(0x6f93ab, K.GLASS, 0);
  b.prism(chamfer(len, wid, 3), 0, H, { top: false });
  b.colPrism(chamfer(len, wid, 3), 0, H + rise * 0.6);
  // crown: arched profile along the long axis, extruded across the width
  const n = 14, hl = len / 2, hw = wid / 2;
  const arch = [];
  for (let i = 0; i <= n; i++) { const t = -1 + (2 * i) / n; arch.push([t * hl, H + rise * Math.sqrt(Math.max(0, 1 - t * t))]); }
  b.paint(0x86a9be, K.GLASS, 0);
  for (const s of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const [x0, y0] = arch[i], [x1, y1] = arch[i + 1];
      if (s > 0) b.quad([x0, H, hw], [x1, H, hw], [x1, y1, hw], [x0, y0, hw]);
      else b.quad([x1, H, -hw], [x0, H, -hw], [x0, y0, -hw], [x1, y1, -hw]);
    }
  }
  b.paint(0xdfe5ea, K.METAL);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = arch[i], [x1, y1] = arch[i + 1];
    b.quad([x0, y0, hw], [x1, y1, hw], [x1, y1, -hw], [x0, y0, -hw]);
  }
  // lit arch edge (both faces)
  b.paint(0xbfe3ff, K.EMIT, 0);
  for (const s of [1, -1]) for (let i = 0; i < n; i++) {
    const [x0, y0] = arch[i], [x1, y1] = arch[i + 1];
    b.beam(x0, y0 + 0.2, s * (hw + 0.15), x1, y1 + 0.2, s * (hw + 0.15), 0.5, 0.6, 0b1111);
  }
  const p = b.world(0, H + rise + 0.6, 0);
  lights.obstacle(p[0], p[1], p[2], 2);
  b.pop();
  ctx.view([ob.cx + 330, g + 160, ob.cz - 120], [ob.cx, g + H * 0.8, ob.cz], 'arch crown');
}

// ---------- generic crowned glass tower on an existing footprint: spire | slant | lattice ----------
export function crownTower(ctx, def) {
  const { b, lights } = ctx;
  const fs = take(ctx, def.take || [[def.x, def.z]], 8, 150);
  if (!fs.length) return { skipped: true };
  const f = fs[0];
  const ob = frame(ctx, [f], null);
  const g = f.rec.base - 2;
  const H = Math.max(def.h || 0, f.rec.height + 2);
  const style = def.style || 'spire';
  const poly = hull2d(f.poly);
  b.paint(def.facade ?? def.glass ?? 0x5d86a3, def.facade ? K.WIN : K.GLASS, def.facade ? W.TOWER : 0);
  b.prism(poly, g, g + H, { top: style !== 'slant', topPaint: [0xb8bcc0, K.ROOF] });
  b.colPrism(poly, g, g + H);
  b.push(); b.translate(ob.cx, g + H, ob.cz).rotY(ob.yaw);
  const len = ob.len, wid = ob.wid;
  if (style === 'colonnade') {
    // Pale, stepped crown and visible vertical piers from the Bayfront reference.
    b.paint(0xc8c3b9, K.PLAIN);
    b.box(-len * 0.43, 0, -wid * 0.43, len * 0.43, 8, wid * 0.43);
    for (let i = -2; i <= 2; i++) for (const side of [-1, 1]) {
      const x = i * len * 0.18;
      b.box(x - 1.2, 8, side * wid * 0.38 - 1.2, x + 1.2, 17, side * wid * 0.38 + 1.2);
    }
    b.box(-len * 0.4, 16, -wid * 0.4, len * 0.4, 18, wid * 0.4);
    b.paint(0x7b827f, K.METAL); b.cyl(0, 0, 18, 33, 0.4, 0.15, 6);
    const p = b.world(0, 33.2, 0); lights.obstacle(p[0], p[1], p[2], 1.3);
  } else if (style === 'spire') {
    b.paint(0x7aa0b8, K.GLASS, 0);
    b.prism(chamfer(len * 0.7, wid * 0.7, 2), 0, 10, { topPaint: [0xb8bcc0, K.ROOF] });
    b.paint(0x5d86a3, K.GLASS, 0);
    b.prism(chamfer(len * 0.45, wid * 0.45, 1.5), 10, 18, { topPaint: [0xb8bcc0, K.ROOF] });
    b.paint(0xe9edf0, K.METAL);
    b.cyl(0, 0, 18, 18 + (def.spire || 45), 1.4, 0.15, 6);
    b.paint(0xbfe3ff, K.EMIT, 0);
    b.prism(chamfer(len * 0.72, wid * 0.72, 2), 9, 10.3, { top: false });
    const p = b.world(0, 18 + (def.spire || 45) + 0.5, 0);
    lights.obstacle(p[0], p[1], p[2], 2);
  } else if (style === 'slant') {
    // roof slopes up along the long axis; lit top edge
    const hl = len / 2, hw = wid / 2, r = def.rise || len * 0.55;
    b.orient = [0, r * 0.25, 0];
    b.paint(0x7aa0b8, K.GLASS, 0);
    b.quad([-hl, 0, hw], [hl, 0, hw], [hl, r, hw], [-hl, 0.1, hw]);
    b.quad([hl, 0, -hw], [-hl, 0, -hw], [-hl, 0.1, -hw], [hl, r, -hw]);
    b.quad([hl, 0, hw], [hl, 0, -hw], [hl, r, -hw], [hl, r, hw]);
    b.paint(0xd6dce0, K.METAL);
    b.quad([-hl, 0.1, hw], [hl, r, hw], [hl, r, -hw], [-hl, 0.1, -hw]);
    b.orient = null;
    b.paint(0x9ff0ff, K.EMIT, 0);
    for (const s of [1, -1]) b.beam(-hl, 0.3, s * (hw + 0.1), hl, r + 0.2, s * (hw + 0.1), 0.5, 0.5, 0b1111);
    const p = b.world(hl - 1, r + 1, 0);
    lights.obstacle(p[0], p[1], p[2], 1.8);
  } else {
    // open lattice crown with LED frame
    const hl = len * 0.42, hw = wid * 0.42, ch = def.crown || 22;
    b.paint(0xd9dee2, K.METAL);
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) b.beam(sx * hl, 0, sz * hw, sx * hl * 0.6, ch, sz * hw * 0.6, 0.8, 0.8, 0b1111);
    b.paint(0xff5fb0, K.LED, 2);
    for (const y of [ch * 0.35, ch * 0.7, ch]) {
      const k = 1 - 0.4 * y / ch;
      b.beam(-hl * k, y, -hw * k, hl * k, y, -hw * k, 0.6, 0.6, 0b1111);
      b.beam(hl * k, y, -hw * k, hl * k, y, hw * k, 0.6, 0.6, 0b1111);
      b.beam(hl * k, y, hw * k, -hl * k, y, hw * k, 0.6, 0.6, 0b1111);
      b.beam(-hl * k, y, hw * k, -hl * k, y, -hw * k, 0.6, 0.6, 0b1111);
    }
    b.paint(0xe9edf0, K.METAL);
    b.cyl(0, 0, ch, ch + 14, 0.5, 0.12, 6);
    const p = b.world(0, ch + 14.5, 0);
    lights.obstacle(p[0], p[1], p[2], 1.8);
  }
  b.pop();
  ctx.view([ob.cx + 190, g + H * 0.9, ob.cz + 150], [ob.cx, g + H * 0.9, ob.cz], style);
}

// Residential waterfront shafts: balconies and open roof frames instead of
// interchangeable office-glass boxes. Footprint and height still come from the mapped site.
export function balconyTower(ctx, def) {
  const { b, lights } = ctx;
  // A road cut can put one corner of a mapped downtown foundation a few
  // centimetres below sea level. Resolve the mapped lot by its land class;
  // do not discard the entire tower because that corner fails dryPoly().
  const B = ctx.buildings;
  const fs = B.query(def.x, def.z, 12).filter((id) => {
    const r = B.recs[id];
    return r && !r.removed && !r.procedural && ctx.terrain.groundAt(r.cx, r.cz) !== ctx.terrain.G.water;
  }).map((id) => ({ id, rec: B.recs[id], poly: Array.from({ length: B.list[id].p.length / 2 }, (_, k) => B.list[id].p.slice(k * 2, k * 2 + 2)) }));
  if (!fs.length) return { skipped: true, why: 'no mapped land footprint' };
  const f = fs[0], ob = frame(ctx, [f], null), g = f.rec.base - 0.4;
  ctx.remove({ ids: [f.id] });
  const H = def.h || f.rec.height;
  const len = Math.min(ob.len * 0.86, 72), wid = Math.min(ob.wid * 0.82, 42);
  b.push(); b.translate(ob.cx, g, ob.cz).rotY(ob.yaw);
  b.paint(0xbcbeb7, K.WIN, W.GARAGE);
  b.box(-ob.len / 2, 0, -ob.wid / 2, ob.len / 2, 13, ob.wid / 2);
  b.paint(def.color || 0xd1cec2, K.WIN, W.TOWER);
  b.box(-len / 2, 13, -wid / 2, len / 2, H, wid / 2);
  b.colBox(-len / 2, 0, -wid / 2, len / 2, H + 8, wid / 2);
  b.lod = LOD.NEAR;
  b.paint(0xe7e3d8, K.PLAIN);
  for (let y = 16; y < H - 1; y += 3.3) {
    for (const side of [-1, 1]) b.box(-len / 2 - 0.5, y, side * wid / 2 - 0.9, len / 2 + 0.5, y + 0.22, side * wid / 2 + 0.9);
  }
  b.lod = LOD.BOTH;
  b.paint(0xeee9dc, K.PLAIN);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * len * 0.4 - 1.8, H, sz * wid * 0.4 - 1.8, sx * len * 0.4 + 1.8, H + 11, sz * wid * 0.4 + 1.8);
  b.box(-len * 0.44, H + 9, -wid * 0.44, len * 0.44, H + 12, wid * 0.44);
  const p = b.world(0, H + 12.5, 0); lights.obstacle(p[0], p[1], p[2], 1.2);
  b.pop();
  return { sourceFootprint: f.id };
}

// ---------- art-deco tower: setbacks, vertical piers, neon trims, clock faces, spire ----------
export function decoTower(ctx, def) {
  const { b, lights, sign, atlas } = ctx;
  const [x, z] = ctx.spot(def.x, def.z, 8, { maxR: 80, dryR: 11 });
  ctx.remove({ circle: [x, z, 14] });
  ctx.hideTrees({ circle: [x, z, 12] });
  const g = ctx.groundY(x, z) - 0.5;
  b.push(); b.translate(x, g, z).rotY(def.yaw || 0);
  const steps = [[15, 0, 30], [12, 30, 38], [9.4, 38, 44], [6.6, 44, 49]];
  for (const [w, y0, y1] of steps) {
    b.paint(0xf3e9d8, K.WIN, W.DECO);
    b.box(-w / 2, y0, -w / 2, w / 2, y1, w / 2);
    // vertical piers on each face
    b.lod = LOD.NEAR;
    b.paint(0xf0c9c0, K.PLAIN);
    for (let i = -1; i <= 1; i++) {
      for (const [a, s] of [[0, 1], [Math.PI / 2, 1], [Math.PI, 1], [-Math.PI / 2, 1]]) {
        b.push(); b.rotY(a);
        b.box(i * w / 3.4 - 0.35, y0 + 1, w / 2, i * w / 3.4 + 0.35, y1 + 1.2, w / 2 + 0.45 * s);
        b.pop();
      }
    }
    b.lod = LOD.BOTH;
    b.paint(0xff5fb0, K.EMIT, 0);
    b.box(-w / 2 - 0.2, y1 - 0.5, -w / 2 - 0.2, w / 2 + 0.2, y1, w / 2 + 0.2, 0b111011);
  }
  b.colBox(-7.5, 0, -7.5, 7.5, 49, 7.5);
  b.paint(0xe8dcc6, K.PLAIN);
  b.cyl(0, 0, 49, 52, 2.6, 1.6, 8);
  b.paint(0xdfe3e6, K.METAL);
  b.cyl(0, 0, 52, 66, 0.9, 0.1, 6);
  const p = b.world(0, 66.4, 0);
  lights.obstacle(p[0], p[1], p[2], 1.4);
  b.pop();
  // clock faces on the third setback (drawn in the atlas)
  const clock = atlas.add('clock', 128, 128, (gx, cx0, cy0, cw, ch) => {
    gx.fillStyle = 'rgba(245,240,226,1)'; gx.beginPath(); gx.arc(cx0 + cw / 2, cy0 + ch / 2, cw * 0.47, 0, 7); gx.fill();
    gx.strokeStyle = '#3a2a1a'; gx.lineWidth = 5; gx.stroke();
    gx.fillStyle = '#3a2a1a';
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; gx.fillRect(cx0 + cw / 2 + Math.cos(a) * cw * 0.38 - 3, cy0 + ch / 2 + Math.sin(a) * ch * 0.38 - 3, 6, 6); }
    gx.lineWidth = 6; gx.beginPath(); gx.moveTo(cx0 + cw / 2, cy0 + ch / 2); gx.lineTo(cx0 + cw / 2 + 24, cy0 + ch / 2 - 30); gx.moveTo(cx0 + cw / 2, cy0 + ch / 2); gx.lineTo(cx0 + cw / 2 - 30, cy0 + ch / 2 + 8); gx.stroke();
  });
  for (let a = 0; a < 4; a++) {
    sign.push(); sign.translate(x, g, z).rotY((def.yaw || 0) + a * Math.PI / 2);
    signQuad(sign, clock, -2.8, 39.5, 2.8, 45.1, 4.75, { lit: 1 });
    sign.pop();
  }
  ctx.view([x + 60, g + 34, z + 70], [x, g + 34, z], 'deco tower');
}
