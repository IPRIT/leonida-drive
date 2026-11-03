import { K, LOD } from '../kit.js';
import { L } from '../lights.js';
import { signBoard, signQuad, windsock } from '../parts.js';
import { FONT } from '../atlas.js';

// Airfield furniture shared by every airport: runway edge / threshold / end lights, approach lighting with
// sequenced flashers, PAPIs, painted runway numbers, blue taxiway edge lights, yellow/black taxiway signs
// at junctions, red mandatory signs at runway holding points, windsocks.

const WHITE = 0xfff4dc, GREEN = 0x30ff70, RED = 0xff2a1a, BLUE = 0x3a6bff, AMBER = 0xffc040;
const MAX_TAXI_CELLS = 32;

export function runwayNumber(dx, dz) {
  const hdg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  const n = Math.round(hdg / 10) % 36 || 36;
  return String(n).padStart(2, '0');
}

// surface height (drawn runway pavement, else road deck, else terrain)
export function deckY(ctx, x, z) {
  const d = ctx.L?.deckAt?.(x, z);
  if (d != null) return d;
  const t = ctx.groundY(x, z);
  const n = ctx.roads?.nearest?.(x, z, 50);
  if (n && n.dist < n.edge.w / 2 + 0.5) return Math.max(t, n.y + 0.07);
  return t;
}

export function runwayFurniture(ctx, runways, { approach = 420, papi = true, numbers = true, socks = true, edgeStep = 60 } = {}) {
  const { lights, b, gsign, atlas } = ctx;
  for (const rw of runways) {
    const { x0, z0, dx, dz, len, w } = rw;
    const nx = -dz, nz = dx; // left of the x0 -> x1 direction
    const at = (t, s) => [x0 + dx * t + nx * s, z0 + dz * t + nz * s];
    const y = (x, z) => deckY(ctx, x, z) + 0.35;
    // edge lights (both sides), last 600 m amber "caution" on each landing direction is omitted for clarity
    const n = Math.max(2, Math.round(len / edgeStep));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * len;
      for (const s of [-1, 1]) { const [x, z] = at(t, s * (w / 2 + 1.2)); lights.add(x, y(x, z), z, WHITE, 1.0, L.STEADY, 0, 7000); }
    }
    // centreline lights (every 30 m, white)
    for (let t = 30; t < len - 15; t += 30) { const [x, z] = at(t, 0); lights.add(x, y(x, z) - 0.25, z, 0xfff8ee, 0.5, L.STEADY, 0, 3500); }
    // thresholds (green, facing out) + end bars (red) at both ends
    for (const [t, dir] of [[0, -1], [len, 1]]) {
      for (let s = -w / 2; s <= w / 2 + 0.01; s += 4) {
        const [gx, gz] = at(t + dir * 1.5, s);
        lights.add(gx, y(gx, gz), gz, GREEN, 1.25, L.STEADY, 0, 7000);
        const [rx, rz] = at(t + dir * 0.2, s);
        lights.add(rx, y(rx, rz), rz, RED, 0.7, L.STEADY, 0, 4000);
      }
      // approach lighting system: bars every 30 m, 5 lights each, crossbar at 300 m, sequenced flashers
      const N = Math.floor(approach / 30);
      for (let k = 1; k <= N; k++) {
        const d = k * 30;
        const [cx, cz] = at(t + dir * (d + 2), 0);
        const g = ctx.groundY(cx, cz);
        if (g < -4) continue;
        if (!clearSpot(ctx, cx, cz)) continue;
        const ly = Math.max(g, 0.3) + 0.6 + (g < 0 ? 0.6 : 0);
        for (let j = -2; j <= 2; j++) { const [lx, lz] = at(t + dir * (d + 2), j * 1.1); lights.add(lx, ly, lz, WHITE, 1.25, L.STEADY, 0, 7000); }
        if (d === 300) for (let j = -7; j <= 7; j++) { if (Math.abs(j) < 3) continue; const [lx, lz] = at(t + dir * (d + 2), j * 2.2); lights.add(lx, ly, lz, WHITE, 1.25, L.STEADY, 0, 7000); }
        lights.add(cx, ly + 0.4, cz, 0xffffff, 1.6, L.STROBE, (1 - k / (N + 1)) * 0.9, 7000);
        // posts (pier stubs over water / low ground), near detail
        b.lod = LOD.NEAR;
        b.paint(0x8a8f94, K.METAL);
        b.box(cx - 0.15, Math.min(g, 0) - 2, cz - 0.15, cx + 0.15, ly - 0.1, cz + 0.15);
        b.paint(0x5d6166, K.METAL);
        b.beam(cx - nx * 2.6, ly - 0.18, cz - nz * 2.6, cx + nx * 2.6, ly - 0.18, cz + nz * 2.6, 0.18, 0.15, 0b1111);
        b.lod = LOD.BOTH;
      }
      // PAPI: 4 units on the left of the landing direction, 300 m in
      if (papi) {
        const tp = t - dir * 300, side = -dir; // landing direction is -dir; its left side
        for (let i = 0; i < 4; i++) {
          const [px, pz] = at(tp, side * (w / 2 + 15 + i * 9));
          const py = ctx.groundY(px, pz);
          b.lod = LOD.NEAR;
          b.paint(0x3d4146, K.PLAIN);
          b.box(px - 0.8, py, pz - 0.6, px + 0.8, py + 0.9, pz + 0.6);
          b.lod = LOD.BOTH;
          lights.add(px, py + 0.75, pz, i < 2 ? 0xffffff : RED, 1.1, L.STEADY, 0, 6000);
        }
      }
      // painted runway number near the threshold (reads for aircraft landing towards -dir)
      if (numbers) {
        const ldx = -dir * dx, ldz = -dir * dz; // landing direction
        const num = runwayNumber(ldx, ldz);
        const cell = atlas.text(`rw${num}`, num, { w: 160, h: 128, font: FONT.mono, fg: '#f4f4f4', bg: '#2f3034', size: 120 });
        const [cx, cz] = at(t - dir * 48, 0);
        const cy = deckY(ctx, cx, cz) + 0.03;
        gsign.push();
        gsign.translate(cx, cy, cz).rotY(Math.atan2(ldx, ldz) + Math.PI).rotX(-Math.PI / 2);
        // quad in local x/y (flat after rotX), text bottom towards the threshold
        signQuad(gsign, cell, -6, -9, 6, 9, 0, { lit: 0 });
        gsign.pop();
      }
      // windsock beside the touchdown zone
      if (socks) {
        const td = t - dir * 160;
        for (const s of [1, -1]) {
          const [wx, wz] = at(td, s * (w / 2 + 75));
          if (ctx.groundY(wx, wz) > 0.3 && clearSpot(ctx, wx, wz, 6)) { windsock(b, lights, wx, wz, ctx.groundY(wx, wz), Math.atan2(-0.3, 1)); break; }
        }
      }
    }
  }
}

function clearSpot(ctx, x, z, r = 3) {
  if (!ctx.clearOfRoads(x, z, r)) return false;
  const B = ctx.buildings;
  if (B?.query) for (const id of B.query(x, z, r + 30)) { const rec = B.recs[id]; if (rec && Math.hypot(rec.cx - x, rec.cz - z) < r + Math.sqrt(30)) return false; }
  return true;
}

// taxiway chains: walk airside non-runway edges through degree-2 nodes, give each chain a letter
function taxiChains(roads, inZone, hidden) {
  const edges = roads.edges.filter((e) => e.airside && !e.runway && !hidden?.has(e.i) && inZone(e));
  const isTaxi = new Set(edges.map((e) => e.i));
  const chainOf = new Map();
  const chains = [];
  for (const e of edges) {
    if (chainOf.has(e.i)) continue;
    const id = chains.length, list = [e];
    chainOf.set(e.i, id);
    for (const start of [e.a, e.b]) {
      let ni = start, cur = e;
      for (let guard = 0; guard < 200; guard++) {
        const arms = roads.adj[ni].filter((ei) => isTaxi.has(ei) && ei !== cur.i);
        if (roads.adj[ni].length !== 2 || arms.length !== 1) break;
        const nx = roads.edges[arms[0]];
        if (chainOf.has(nx.i)) break;
        chainOf.set(nx.i, id); list.push(nx);
        ni = nx.a === ni ? nx.b : nx.a; cur = nx;
      }
    }
    let len = 0, cx = 0, cz = 0;
    for (const c of list) { len += c.len; cx += c.pts[0]; cz += c.pts[1]; }
    chains.push({ id, list, len, cx: cx / list.length, cz: cz / list.length });
  }
  // letters by position (west -> east), long chains first get single letters
  const order = chains.slice().sort((a, b) => b.len - a.len).slice(0, 40).sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  const AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  order.forEach((c, i) => { c.letter = i < AB.length ? AB[i] : AB[Math.floor(i / AB.length) - 1] + AB[i % AB.length]; });
  return { edges, chainOf, chains };
}

// blue edge lights on taxiways + junction signs. zone(x,z) limits the work to this airport.
export function taxiwayFurniture(ctx, zone, { step = 32, signs = true, runways = [] } = {}) {
  const { roads, lights, sign, atlas, b } = ctx;
  if (!roads?.edges) return { signs: 0 };
  const inZone = (e) => zone(e.pts[0], e.pts[1]) || zone(e.pts[e.pts.length - 2], e.pts[e.pts.length - 1]);
  const { edges, chainOf, chains } = taxiChains(roads, inZone, ctx.L?.hidden);
  // edge lights
  for (const e of edges) {
    const n = Math.max(1, Math.round(e.len / step));
    for (let k = 0; k <= n; k++) {
      const p = roads.pointAt(e, (k / n) * e.len);
      const tx = p.tx, tz = p.tz, hw = (p.w || e.w) / 2 + 0.8;
      for (const s of [-1, 1]) {
        const lx = p.x - tz * s * hw, lz = p.z + tx * s * hw;
        if (ctx.roadHit(lx, lz, 0.3, e.i) >= 0) continue; // inside another pavement
        lights.add(lx, (p.y ?? ctx.groundY(lx, lz)) + 0.35, lz, BLUE, 0.55, L.STEADY, 0, 2600);
      }
    }
  }
  if (!signs) return { signs: 0 };
  // junction signs
  const rwNames = new Map();
  for (const rw of runways) rwNames.set(rw, `${runwayNumber(rw.dx, rw.dz)}-${runwayNumber(-rw.dx, -rw.dz)}`);
  const W = atlas.white;
  let count = 0;
  const seen = new Set();
  for (const e of edges) {
    for (const ni of [e.a, e.b]) {
      if (seen.has(ni)) continue;
      seen.add(ni);
      const arms = roads.adj[ni];
      if (arms.length < 3) continue;
      const taxiArms = arms.filter((ei) => chainOf.has(ei));
      if (!taxiArms.length) continue;
      const rwArm = arms.map((ei) => roads.edges[ei]).find((x) => x.runway);
      const [nx0, nz0] = roads.nodes[ni];
      let placed = 0;
      for (const ei of taxiArms) {
        if (placed >= 2) break;
        const arm = roads.edges[ei];
        const d = roads.armDir(arm, ni); // from node out along the arm
        const back = rwArm ? Math.max(40, rwArm.w / 2 + 35) : 22;
        if (arm.len < back + 5) continue;
        // holding / approach side: driver on the arm heading towards the node; sign on their left
        const sx = nx0 + d[0] * back + d[1] * (arm.w / 2 + 5.5), sz = nz0 + d[1] * back - d[0] * (arm.w / 2 + 5.5);
        if (!ctx.clearOfRoads(sx, sz, 2.2)) continue;
        const letter = chains[chainOf.get(ei)]?.letter || '';
        let segs;
        if (rwArm) segs = [{ t: rwNames.get(runways.find((r) => rwArm && Math.abs(r.dx * (rwArm.pts[2] - rwArm.pts[0]) + r.dz * (rwArm.pts[3] - rwArm.pts[1])) > 0.9 * Math.hypot(rwArm.pts[2] - rwArm.pts[0], rwArm.pts[3] - rwArm.pts[1])) ) || 'RWY', kind: 'mand' }, { t: letter, kind: 'loc' }];
        else {
          segs = [{ t: letter, kind: 'loc' }];
          for (const oj of taxiArms) {
            if (oj === ei) continue;
            const ol = chains[chainOf.get(oj)]?.letter;
            if (!ol || ol === letter) continue;
            const od = roads.armDir(roads.edges[oj], ni);
            const cross = -d[0] * od[1] + d[1] * od[0];
            segs.push({ t: cross > 0 ? `${ol} →` : `← ${ol}`, kind: 'dir' });
            if (segs.length >= 3) break;
          }
          if (segs.length < 2) continue;
        }
        // unique sign faces share one atlas budget (MAX_TAXI_CELLS over all airports); 40 px rows are plenty
        // for a 1.15 m board
        const key = 'tx:' + segs.map((s) => s.kind + s.t).join('|');
        if (!atlas.cells.has(key) && (atlas.taxiCells || 0) >= MAX_TAXI_CELLS) continue;
        if (!atlas.cells.has(key)) atlas.taxiCells = (atlas.taxiCells || 0) + 1;
        const cell = atlas.taxi(key, segs, 40);
        const wm = Math.min(9, (cell.w / 40) * 1.15), hm = 1.15;
        const gy = ctx.groundY(sx, sz);
        sign.push();
        sign.translate(sx, gy, sz).rotY(Math.atan2(d[0], d[1]));
        signBoard(sign, cell, -wm / 2, 0.45, wm / 2, 0.45 + hm, -0.15, 0.15, { lit: 1, back: false, frame: 0x222222, white: W });
        sign.pop();
        b.push();
        b.translate(sx, gy, sz).rotY(Math.atan2(d[0], d[1]));
        b.lod = LOD.NEAR;
        b.paint(0x2a2a2a, K.PLAIN);
        b.box(-wm / 2 + 0.3, 0, -0.08, -wm / 2 + 0.45, 0.5, 0.08);
        b.box(wm / 2 - 0.45, 0, -0.08, wm / 2 - 0.3, 0.5, 0.08);
        b.pop();
        placed++; count++;
      }
    }
  }
  return { signs: count, chains: chains.length };
}
