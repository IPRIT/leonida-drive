// Renders one map tile (water + bathymetry, land use, hillshade, buildings, roads) from the vector dataset.
// No DOM access: runs in the tile worker (OffscreenCanvas) or on the main thread as a fallback.
// Geometry is bucketed per cell; Path2D objects are built lazily per (set, cell, class, width bucket) and cached.

import { addRing, addLine, addPolygon } from './mapData.js';
import { computeHillshade } from './relief.js';
import {
  TILE, GUTTER, levelMpp, tileWorld, areaLod, roadLod, AREA_RMAX, PALETTES, roadPx, roadVisible, BUILDING_MAX_CMPP,
  heightClass, depthLod, DEPTH_RMAX, shadeFade, ROAD_ORDER,
} from './style.js';

const ROAD_NAMES = ['highway', 'primary', 'street', 'path', 'runway', 'taxiway'];
// road colour for (style, class, closeness 0..1, bridge deck), cached as css strings
const _colors = new Map();
function roadColor(style, P, name, near, bridge) {
  const nq = Math.round(near * 16);
  const key = `${style}|${name}|${nq}|${bridge}`;
  let c = _colors.get(key);
  if (c) return c;
  const hex = (h) => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  const a = hex(P.road[name] || P.road.street), b = hex(P.roadHi[name] || P.roadHi.street);
  let rgb = a.map((x, i) => x + (b[i] - x) * (nq / 16));
  if (bridge && P.bridgeTint) rgb = rgb.map((x) => x + (255 - x) * P.bridgeTint);
  c = `rgb(${rgb.map((x) => Math.round(x)).join(', ')})`;
  _colors.set(key, c);
  return c;
}
const groupOrder = (a, b) => a.level - b.level || a.ord - b.ord || a.bridge - b.bridge || a.w - b.w;

export class TileRenderer {
  // map: parsed map data (all sets). relief: { heights: Int16Array, gw, gh, hs } or null.
  constructor(map, { heights = null, gw = 0, gh = 0, hs = 8, makeCanvas }) {
    this.map = map;
    this.bounds = map.bounds;
    this.heights = heights;
    this.gw = gw; this.gh = gh; this.hs = hs;
    this.makeCanvas = makeCanvas;
    this.areaClasses = map.header.areaClasses;
    // part flag bits of the road sets (older map.bin files only have the bridge bit)
    this.roadBits = map.header.roadBits || { bridge: map.header.bridgeBit || 16, levelShift: 0, ramp: 0, tunnel: 0 };
    this.index = {};
    for (const [name, set] of Object.entries(map.sets)) if (name !== 'st' && name !== 'rt') this.index[name] = this.buildIndex(set);
    this.paths = new Map();
    this.rasters = {};
    this.stats = { tiles: 0, ms: 0 };
  }

  // cell -> { parts: Int32Array, bbox } with the bbox of the actual content
  buildIndex(set) {
    const byCell = new Map();
    const { parts, xy, start, n } = set;
    for (let i = 0; i < n; i++) {
      const c = parts[i * 4];
      let e = byCell.get(c);
      if (!e) byCell.set(c, (e = { list: [], bbox: [Infinity, Infinity, -Infinity, -Infinity] }));
      e.list.push(i);
      const b = e.bbox;
      for (let k = start[i]; k < start[i + 1]; k++) {
        const x = xy[k * 2], z = xy[k * 2 + 1];
        if (x < b[0]) b[0] = x; if (x > b[2]) b[2] = x;
        if (z < b[1]) b[1] = z; if (z > b[3]) b[3] = z;
      }
    }
    const cells = [];
    for (const [cell, e] of byCell) cells.push({ cell, parts: Int32Array.from(e.list), bbox: e.bbox });
    return cells;
  }

  setRaster(key, r) { this.rasters[key] = r; }

  raster(key) {
    if (this.rasters[key] !== undefined) return this.rasters[key];
    if (this.noRasterCompute) return null;
    if (!this.heights) return (this.rasters[key] = null);
    const r = computeHillshade(this.heights, this.gw, this.gh, this.hs);
    const cv = this.makeCanvas(r.w, r.h);
    const cx = cv.getContext('2d');
    const img = cx.createImageData(r.w, r.h);
    img.data.set(r.data);
    cx.putImageData(img, 0, 0);
    return (this.rasters[key] = { canvas: cv, w: r.w, h: r.h, mpp: this.hs });
  }

  drawRaster(ctx, R, X0, Z0, S) {
    if (!R) return;
    const bx = this.bounds[0], bz = this.bounds[1];
    // source rect (raster px) covering the tile plus a margin, clamped
    const sx0 = Math.max(0, Math.floor((X0 - bx) / R.mpp) - 1), sz0 = Math.max(0, Math.floor((Z0 - bz) / R.mpp) - 1);
    const sx1 = Math.min(R.w, Math.ceil((X0 + S - bx) / R.mpp) + 1), sz1 = Math.min(R.h, Math.ceil((Z0 + S - bz) / R.mpp) + 1);
    if (sx1 <= sx0 || sz1 <= sz0) return;
    ctx.drawImage(R.canvas, sx0, sz0, sx1 - sx0, sz1 - sz0, bx + sx0 * R.mpp, bz + sz0 * R.mpp, (sx1 - sx0) * R.mpp, (sz1 - sz0) * R.mpp);
  }

  cellsIn(setName, x0, z0, x1, z1) {
    const out = [];
    const cells = this.index[setName];
    if (!cells) return out;
    for (const c of cells) {
      const b = c.bbox;
      if (b[2] < x0 || b[0] > x1 || b[3] < z0 || b[1] > z1) continue;
      out.push(c);
    }
    return out;
  }

  // ---- cached Path2D groups ----
  areaPaths(setName, cell, rmax) {
    const key = `${setName}|${cell.cell}`;
    let g = this.paths.get(key);
    if (g) return g;
    const set = this.map.sets[setName];
    g = new Map(); // cls -> Path2D
    for (const i of cell.parts) {
      const cls = set.parts[i * 4 + 1];
      let p = g.get(cls);
      if (!p) g.set(cls, (p = new Path2D()));
      addRing(p, set.xy, set.start[i], set.start[i + 1] - set.start[i], rmax);
    }
    this.paths.set(key, g);
    return g;
  }

  // road groups of a cell: one Path2D per (level, class/ramp, bridge, tunnel, width bucket)
  roadPaths(setName, cell) {
    const key = `${setName}|${cell.cell}`;
    let g = this.paths.get(key);
    if (g) return g;
    const set = this.map.sets[setName];
    const B = this.roadBits;
    const groups = new Map();
    for (const i of cell.parts) {
      const raw = set.parts[i * 4 + 1];
      const cls = raw & 15;
      const bridge = (raw & B.bridge) ? 1 : 0;
      const tunnel = B.tunnel && (raw & B.tunnel) ? 1 : 0;
      const ramp = B.ramp && (raw & B.ramp) ? 1 : 0;
      const level = B.levelShift ? ((raw >> B.levelShift) & 3) - 1 : bridge;
      const w = set.parts[i * 4 + 3] / 10;
      const wb = w < 12 ? Math.max(3, Math.round(w)) : Math.round(w / 2) * 2; // 1 m buckets (2 m for wide roads)
      const name = cls === 0 && ramp ? 'ramp' : ROAD_NAMES[cls] || 'street';
      const k = `${level}|${name}|${bridge}|${tunnel}|${wb}`;
      let gr = groups.get(k);
      if (!gr) {
        groups.set(k, (gr = { cls, name, ord: ROAD_ORDER[name] ?? 3, level, bridge, tunnel, w: wb, path: new Path2D(),
          butt: cls === 4 || bridge || tunnel || level > 0 }));
      }
      addLine(gr.path, set.xy, set.start[i], set.start[i + 1] - set.start[i]);
    }
    g = [...groups.values()].sort(groupOrder);
    this.paths.set(key, g);
    return g;
  }

  buildingPaths(cell) {
    const key = `b0|${cell.cell}`;
    let g = this.paths.get(key);
    if (g) return g;
    const set = this.map.sets.b0;
    g = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (const i of cell.parts) {
      const hc = heightClass(set.parts[i * 4 + 3]);
      addPolygon(g[hc], set.xy, set.start[i], set.start[i + 1] - set.start[i]);
    }
    this.paths.set(key, g);
    return g;
  }

  // ---- tile ----
  // ctx: 2D context of a (TILE + 2*GUTTER)^2 canvas. style: 'map' | 'radar'.
  render(ctx, style, L, tx, ty, dpr = 1) {
    const t0 = performance.now();
    const m = levelMpp(L);           // device metres per pixel
    const S = tileWorld(L);
    const X0 = this.bounds[0] + tx * S, Z0 = this.bounds[1] + ty * S;
    const g = GUTTER * m;
    const k = 1 / m;
    const size = TILE + 2 * GUTTER;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = PALETTES[style].water;
    ctx.fillRect(0, 0, size, size);
    ctx.setTransform(k, 0, 0, k, -(X0 - g) * k, -(Z0 - g) * k);
    this.drawContent(ctx, style, m, dpr, X0 - g, Z0 - g, X0 + S + g, Z0 + S + g);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.stats.tiles++;
    this.stats.ms += performance.now() - t0;
  }

  // Vector content of a world rect into a context whose transform already maps world -> device pixels at
  // `m` device metres per pixel (used for tiles and, on the main thread, directly for pending tiles).
  drawContent(ctx, style, m, dpr, qx0, qz0, qx1, qz1, { rasters = true } = {}) {
    const P = PALETTES[style];
    const radar = style === 'radar';
    const cmpp = m * dpr;            // CSS metres per pixel (drives what is shown and how wide)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const S = Math.max(qx1 - qx0, qz1 - qz0);

    // bathymetry: nested vector depth bands, deep -> shallow (the tile background is the deepest colour)
    const wl = depthLod(m), wset = `w${wl}`;
    if (this.index[wset]) {
      const wcells = this.cellsIn(wset, qx0, qz0, qx1, qz1);
      for (let li = 0; li < P.depth.length; li++) {
        ctx.fillStyle = P.depth[li];
        for (const c of wcells) {
          const p = this.areaPaths(wset, c, DEPTH_RMAX[wl]).get(li);
          if (p) ctx.fill(p, 'evenodd');
        }
      }
    }

    // land use
    const al = areaLod(m);
    const aset = `a${al}`;
    const acells = this.cellsIn(aset, qx0, qz0, qx1, qz1);
    for (let ci = 0; ci < this.areaClasses.length; ci++) {
      const name = this.areaClasses[ci];
      ctx.fillStyle = P.area[name];
      for (const c of acells) {
        const p = this.areaPaths(aset, c, AREA_RMAX[al]).get(ci);
        if (p) ctx.fill(p, 'evenodd');
      }
      if (name === 'land') {
        // hillshade right on top of the base land colour, under the land-use patches
        const fade = shadeFade(m);
        const H = rasters && fade > 0 ? this.raster('shade') : null;
        if (H) { ctx.globalAlpha = P.shade * fade; this.drawRaster(ctx, H, qx0, qz0, S); ctx.globalAlpha = 1; }
      }
    }

    // buildings
    if (cmpp <= BUILDING_MAX_CMPP && this.index.b0) {
      const fade = Math.min(1, (BUILDING_MAX_CMPP - cmpp) / 0.9);
      const bcells = this.cellsIn('b0', qx0, qz0, qx1, qz1);
      if (bcells.length) {
        ctx.globalAlpha = fade;
        // soft drop shadow (south-east), then the roofs by height class
        const sh = Math.max(0.8 * m * dpr, 1.6);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        ctx.translate(sh, sh * 1.2);
        for (const c of bcells) { const gp = this.buildingPaths(c); for (let h = 0; h < 4; h++) ctx.fill(gp[h]); }
        ctx.translate(-sh, -sh * 1.2);
        for (let h = 0; h < 4; h++) {
          ctx.fillStyle = P.building[h];
          for (const c of bcells) ctx.fill(this.buildingPaths(c)[h]);
        }
        if (cmpp < 1.2) {
          ctx.strokeStyle = P.buildingEdge;
          ctx.lineWidth = 0.8 * m * dpr;
          for (const c of bcells) { const gp = this.buildingPaths(c); for (let h = 0; h < 4; h++) ctx.stroke(gp[h]); }
        }
        ctx.globalAlpha = 1;
      }
    }

    // roads: per level (tunnels, ground, overpasses / bridges) all casings first, then all fills
    const rl = roadLod(m);
    const rset = `r${rl}`;
    const rcells = this.cellsIn(rset, qx0 - 40, qz0 - 40, qx1 + 40, qz1 + 40);
    const groups = this._groups || (this._groups = []);
    groups.length = 0;
    for (const c of rcells) for (const gr of this.roadPaths(rset, c)) if (roadVisible(gr.name, cmpp)) groups.push(gr);
    if (groups.length) {
      groups.sort(groupOrder);
      this.drawRoads(ctx, groups, P, style, cmpp, radar, dpr * m);
      groups.length = 0;
    }
    ctx.globalAlpha = 1;
  }

  // k = world units per CSS px
  drawRoads(ctx, groups, P, style, cmpp, radar, k) {
    const near = cmpp < 1.4 ? Math.min(1, (1.4 - cmpp) / 0.8) : 0;
    const streetAlpha = cmpp <= 6 ? 1 : Math.max(P.streetFar, 1 - (cmpp - 6) / 28 * (1 - P.streetFar));
    const rampAlpha = cmpp <= 7 ? 1 : Math.max(0, 1 - (cmpp - 7) / 4);
    const alphaOf = (gr) => (gr.tunnel ? 0.5 : 1) * (gr.name === 'street' ? streetAlpha : gr.name === 'ramp' ? rampAlpha : 1);
    ctx.lineJoin = 'round';
    for (let i = 0; i < groups.length;) {
      const level = groups[i].level;
      let j = i;
      while (j < groups.length && groups[j].level === level) j++;
      // casings (outline + the gap that separates a deck from the roads below it)
      for (let q = i; q < j; q++) {
        const gr = groups[q];
        if (gr.tunnel || (gr.name === 'runway' && cmpp > 4)) continue;
        const [fw, cw] = roadPx(gr.name, gr.w, cmpp, radar);
        const deck = gr.level > 0;
        ctx.globalAlpha = alphaOf(gr);
        ctx.lineCap = gr.butt ? 'butt' : 'round';
        ctx.strokeStyle = deck ? P.bridgeCasing : (P.casingOf[gr.name] || P.casing);
        ctx.lineWidth = (fw + 2 * cw * (deck ? 1.7 : 1)) * k;
        ctx.stroke(gr.path);
      }
      // fills
      for (let q = i; q < j; q++) {
        const gr = groups[q];
        const [fw] = roadPx(gr.name, gr.w, cmpp, radar);
        ctx.globalAlpha = alphaOf(gr);
        ctx.lineCap = gr.butt ? 'butt' : 'round';
        ctx.strokeStyle = roadColor(style, P, gr.name, near, gr.bridge);
        ctx.lineWidth = fw * k;
        if (gr.tunnel) ctx.setLineDash([Math.max(6 * k, fw * k * 1.2), Math.max(4 * k, fw * k * 0.8)]);
        else if (gr.name === 'path' && cmpp < 1.5) ctx.setLineDash([4 * k, 3 * k]);
        ctx.stroke(gr.path);
        if (gr.tunnel || gr.name === 'path') ctx.setLineDash([]);
        // runway centre line (dashed, in metres) close up
        if (gr.name === 'runway' && cmpp < 2.6) {
          ctx.globalAlpha = Math.min(1, (2.6 - cmpp) / 0.8);
          ctx.strokeStyle = P.runwayMark;
          ctx.lineCap = 'butt';
          ctx.lineWidth = Math.max(0.9, 0.8 * k);
          ctx.setLineDash([36, 24]);
          ctx.stroke(gr.path);
          ctx.setLineDash([]);
        }
      }
      i = j;
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
  }

  // drop cached paths (memory pressure)
  trim(maxGroups = 4000) {
    if (this.paths.size <= maxGroups) return;
    const drop = this.paths.size - maxGroups;
    let i = 0;
    for (const key of this.paths.keys()) { if (i++ >= drop) break; this.paths.delete(key); }
  }
}
