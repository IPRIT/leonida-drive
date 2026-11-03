// Label layer for the full map: region / area / district / natural / POI / street labels, POI markers and
// clusters, remote player names. Screen-space collision with priorities (bounding boxes in a uniform grid),
// hysteresis (placed labels keep their spot), per-label fade in/out, more labels as you zoom in, street names
// curved along the road and kept upright, text sprites with halos cached per (style, text).
//
// Placement is DOM-free (measure() is injectable) so tools can benchmark it in node.

import { CATEGORIES, FLAG, isGeneric, naturalKind, poiRank, drawMarker } from './poi.js';
import { shieldSprite, shieldSize } from './shields.js';

// route shields: priority, max CSS m/px shown, world spacing (m) between shields at 1 m/px (doubles per octave)
const ROUTE_STYLE = {
  I: { pri: 590, max: 26, spacing: 700 },
  US: { pri: 560, max: 7.5, spacing: 640 },
  SR: { pri: 540, max: 4.5, spacing: 600 },
};
const EXIT_MAX = 2.4;  // exit numbers only close up
const STREET_SHIELD = { i: 'I', h: 'H', r: 'SR' }; // shields for route names that only exist as POI street names

const OSWALD = 'Oswald, "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const RUSSO = '"Russo One", Oswald, "Arial Black", sans-serif';

export const LABEL_STYLES = {
  region: { font: RUSSO, weight: 400, size: 21, color: '#ffffff', halo: 'rgba(5, 9, 16, 0.82)', haloW: 3.5, upper: true, spacing: 2.6 },
  regionWater: { font: OSWALD, weight: 500, size: 17, color: '#a8d3ff', halo: 'rgba(5, 15, 30, 0.75)', haloW: 3, upper: true, spacing: 3, italic: true },
  area: { font: OSWALD, weight: 500, size: 14.5, color: '#f4f4f4', halo: 'rgba(6, 9, 14, 0.85)', haloW: 3, upper: true, spacing: 1.6, wrap: 15 },
  district: { font: OSWALD, weight: 500, size: 12, color: '#cbd3df', halo: 'rgba(6, 9, 14, 0.85)', haloW: 2.8, upper: true, spacing: 1.4, wrap: 15 },
  water: { font: OSWALD, weight: 400, size: 12.5, color: '#9ccbf5', halo: 'rgba(6, 18, 34, 0.8)', haloW: 2.6, italic: true, spacing: 0.8 },
  peak: { font: OSWALD, weight: 500, size: 12, color: '#eadfc6', halo: 'rgba(10, 10, 8, 0.85)', haloW: 2.6, prefix: '▲ ' },
  island: { font: OSWALD, weight: 500, size: 12, color: '#efe9da', halo: 'rgba(10, 10, 8, 0.8)', haloW: 2.6, italic: true, spacing: 0.5 },
  nature: { font: OSWALD, weight: 400, size: 12, color: '#bfe5c6', halo: 'rgba(6, 12, 8, 0.85)', haloW: 2.6, italic: true },
  poi: { font: OSWALD, weight: 400, size: 12, color: '#e9ecf1', halo: 'rgba(8, 10, 14, 0.9)', haloW: 2.8 },
  landmark: { font: OSWALD, weight: 500, size: 12.5, color: '#ffe3a1', halo: 'rgba(12, 9, 4, 0.9)', haloW: 3 },
  street: { font: OSWALD, weight: 400, size: 11.5, color: '#eef0f3', halo: 'rgba(9, 11, 15, 0.92)', haloW: 2.8, spacing: 0.5 },
  bridge: { font: OSWALD, weight: 500, size: 11.5, color: '#f1e6cf', halo: 'rgba(9, 11, 15, 0.92)', haloW: 2.8, spacing: 0.5, italic: true },
  player: { font: OSWALD, weight: 500, size: 12.5, color: '#ffffff', halo: 'rgba(0, 0, 0, 0.85)', haloW: 3 },
};

const FADE = 1 / 0.22; // alpha units per second
const MARKER_R = 8.5;
const CLUSTER_CELL = 58;
const CLUSTER_ABOVE = 1.5; // cluster markers when zoomed out beyond this many CSS m/px
const CLUSTER_MAX = 9;     // further out only landmarks are shown

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const bucketOf = (mpp) => Math.round(Math.log2(mpp)); // octave buckets: cluster grids nest (clusters only split when zooming in)

function wrapText(text, max) {
  if (!max || text.length <= max) return [text];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) return [lines[0], lines.slice(1).join(' ')];
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
export class LabelLayer {
  // map: parsed map data (pois, streets, districts, sets.st); regions: REGIONS from src/world/regions.js
  constructor(map, regions, { measure = null, makeCanvas = null, dpr = 1 } = {}) {
    this.map = map;
    this.dpr = dpr;
    this.makeCanvas = makeCanvas || ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
    this._mctx = null;
    this.measureFn = measure;
    this.widths = new Map();
    this.boxes2 = new Map();
    this.sprites = new Map();
    this.spriteBudget = 0;
    this.spriteDeadline = 0;
    this.spritePending = false;
    this.poiOn = true;
    this.cats = new Set(Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].on));
    this.players = [];
    this.live = new Map(); // id -> candidate (anything that may be drawn)
    this.placed = [];      // candidates placed in the last pass (for hit tests)
    this.grid = null;
    this.boxes = new Float32Array(4 * 4096);
    this.nBoxes = 0;
    this.lastView = { cx: NaN, cz: NaN, mpp: NaN, w: 0, h: 0 };
    this.lastPlace = -1e9;
    this.clusterCache = null;
    this.hoverId = null;
    this.selectedId = null;
    this.stats = { place: 0, placeMs: 0, candidates: 0 };
    this.buildStatic(regions);
  }

  // ---- static candidates --------------------------------------------------------------------------------------
  buildStatic(regions) {
    const S = [];
    const regionNames = new Set(regions.map((r) => r.name));
    for (const r of regions) {
      S.push({ id: `r|${r.name}`, kind: 'text', style: r.water ? 'regionWater' : 'region', text: r.name, x: r.x, z: r.z,
        pri: r.water ? 880 : 900 + Math.min(40, r.r / 100), min: r.water ? 1.6 : 3.2, max: 80 });
    }
    const seen = new Set();
    const dist = [...this.map.districts].sort((a, b) => (a.type === 'd' ? -1 : 1) - (b.type === 'd' ? -1 : 1) || b.n - a.n);
    for (const d of dist) {
      if (regionNames.has(d.name) || seen.has(d.name) || d.name === 'Leonida' || /County$/.test(d.name)) continue;
      if (d.n < 5) continue;
      seen.add(d.name);
      if (d.type === 'a') {
        S.push({ id: `a|${d.name}`, kind: 'text', style: 'area', text: d.name, x: d.x, z: d.z,
          pri: 700 + Math.min(d.n, 300) / 10, min: 0.6, max: clamp(d.r / 70, 4, 14) });
      } else {
        S.push({ id: `d|${d.name}`, kind: 'text', style: 'district', text: d.name, x: d.x, z: d.z,
          pri: 600 + Math.min(d.n, 300) / 10, min: 0.3, max: clamp(d.r / 85, 2.6, 7.5) });
      }
    }
    // POIs: named natural features become map labels; the rest are POI markers
    this.pois = [];
    for (const p of this.map.pois) {
      const nk = naturalKind(p);
      if (nk && !seen.has(p.name) && !regionNames.has(p.name)) {
        seen.add(p.name);
        S.push({ id: `n|${p.i}`, kind: 'text', style: nk, text: p.name.replace(/"/g, ''), x: p.x, z: p.z, poi: p,
          pri: 520 + (nk === 'water' ? 10 : 0), min: 0.25, max: nk === 'water' ? 12 : 10 });
        continue;
      }
      p.rank = poiRank(p);
      p.generic = isGeneric(p.name);
      this.pois.push(p);
    }
    // streets (paths from the 'st' set), grouped per street name
    const st = this.map.sets.st;
    this.streetPaths = [];
    if (st) {
      for (let i = 0; i < st.n; i++) {
        const sIdx = st.parts[i * 4];
        const info = this.map.streets[sIdx];
        const n = st.start[i + 1] - st.start[i];
        const xy = st.xy.subarray(st.start[i] * 2, st.start[i + 1] * 2);
        const cum = new Float32Array(n);
        let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
        for (let k = 0; k < n; k++) {
          const x = xy[k * 2], z = xy[k * 2 + 1];
          if (k) cum[k] = cum[k - 1] + Math.hypot(x - xy[k * 2 - 2], z - xy[k * 2 - 1]);
          bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
        }
        const route = /^(Historic )?(Route|Interstate) (\d+)$/.exec(info.name);
        this.streetPaths.push({ i, name: info.name, kind: info.kind, xy, cum, len: cum[n - 1], n, bbox: [bx0, bz0, bx1, bz1], total: info.len || cum[n - 1],
          shield: route ? route[3] : null, shieldKind: route ? (route[2] === 'Interstate' ? 'i' : route[1] ? 'h' : 'r') : null });
      }
    }
    // numbered routes (interstate / US / state road shields) and interstate exits, from map_build
    this.routePaths = buildPaths(this.map.sets.rt, (r) => this.map.routes?.[r]);
    const numbered = new Set((this.map.routes || []).map((r) => r.num));
    for (const P of this.streetPaths) {
      // a POI street name like "Route 1" whose number is already a numbered route gets no second shield
      if (P.shield && (numbered.has(P.shield) && P.shieldKind !== 'h')) P.shield = null;
    }
    this.exits = (this.map.exits || []).map(([x, z, r, num], i) => ({ i, x, z, num: String(num), route: this.map.routes?.[r] }));
    S.sort((a, b) => b.pri - a.pri);
    for (const c of S) { c.a = 0; c.target = 0; }
    this.static = S;
  }

  // ---- text measuring / sprites --------------------------------------------------------------------------------
  fontOf(st) { return `${st.italic ? 'italic ' : ''}${st.weight} ${st.size}px ${st.font}`; }

  measure(text, styleKey) {
    const key = styleKey + '|' + text;
    let w = this.widths.get(key);
    if (w !== undefined) return w;
    const st = LABEL_STYLES[styleKey];
    const lines = this.lines(text, st);
    if (this.measureFn) w = Math.max(...lines.map((l) => this.measureFn(l, st)));
    else {
      const ctx = (this._mctx ||= this.makeCanvas(8, 8).getContext('2d'));
      ctx.font = this.fontOf(st);
      w = Math.max(...lines.map((l) => ctx.measureText(l).width + (st.spacing || 0) * Math.max(0, l.length - 1)));
    }
    this.widths.set(key, w);
    return w;
  }

  lines(text, st) {
    let t = (st.prefix || '') + text;
    if (st.upper) t = t.toUpperCase();
    return wrapText(t, st.wrap);
  }

  boxSize(text, styleKey) {
    const key = styleKey + '|' + text;
    let b = this.boxes2.get(key);
    if (!b) {
      const st = LABEL_STYLES[styleKey];
      const n = this.lines(text, st).length;
      this.boxes2.set(key, (b = [this.measure(text, styleKey) + 4, n * st.size * 1.18 + 2]));
    }
    return b;
  }

  // sprite: { canvas, w, h, glyphs: [x0, x1, ...] (CSS px, single line only) }
  sprite(text, styleKey) {
    const key = styleKey + '|' + text;
    let sp = this.sprites.get(key);
    if (sp || sp === null) return sp;
    // new sprites per frame: at most 40 and ~2 ms (the first map open would otherwise rasterise every visible
    // label in one frame); the rest follow in the next frames, while those labels are still fading in
    if (this.spriteBudget <= 0 || performance.now() > this.spriteDeadline) { this.spritePending = true; return null; }
    this.spriteBudget--;
    const st = LABEL_STYLES[styleKey];
    const lines = this.lines(text, st);
    const dpr = this.dpr;
    const pad = Math.ceil(st.haloW + 2);
    const lh = st.size * 1.18;
    const w = Math.ceil(this.measure(text, styleKey)) + pad * 2;
    const h = Math.ceil(lines.length * lh) + pad * 2;
    const c = this.makeCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.font = this.fontOf(st);
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    const glyphs = lines.length === 1 ? [] : null;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lw = g.measureText(line).width + (st.spacing || 0) * Math.max(0, line.length - 1);
      let x = (w - lw) / 2;
      const y = pad + lh * (li + 0.5);
      const chars = st.spacing || glyphs ? [...line] : [line];
      const xs = [];
      let cx = x;
      for (const ch of chars) { xs.push(cx); cx += g.measureText(ch).width + (st.spacing || 0); }
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 0) { g.strokeStyle = st.halo; g.lineWidth = st.haloW * 2; } else g.fillStyle = st.color;
        for (let k = 0; k < chars.length; k++) {
          if (pass === 0) g.strokeText(chars[k], xs[k], y); else g.fillText(chars[k], xs[k], y);
        }
      }
      if (glyphs) for (let k = 0; k < chars.length; k++) glyphs.push(xs[k], (k + 1 < chars.length ? xs[k + 1] : cx) - (st.spacing || 0));
    }
    sp = { canvas: c, w, h, pad, glyphs, text: lines[0] };
    this.sprites.set(key, sp);
    if (this.sprites.size > 900) { const k0 = this.sprites.keys().next().value; this.sprites.delete(k0); }
    return sp;
  }

  clearSprites() { this.sprites.clear(); this.widths.clear(); this.boxes2.clear(); }
  setDpr(dpr) { if (dpr !== this.dpr) { this.dpr = dpr; this.sprites.clear(); } }

  // ---- settings ----------------------------------------------------------------------------------------------
  setPoi(on, cats) {
    this.poiOn = !!on;
    if (cats) this.cats = new Set(cats);
    this.clusterCache = null;
    this.lastPlace = -1e9;
  }

  setPlayers(list) { this.players = list || []; }

  // ---- collision grid ----------------------------------------------------------------------------------------
  resetGrid(w, h) {
    const M = 80;
    const cs = 48;
    const cols = Math.ceil((w + 2 * M) / cs), rows = Math.ceil((h + 2 * M) / cs);
    if (!this.grid || this.grid.cols !== cols || this.grid.rows !== rows) {
      this.grid = { cols, rows, cs, M, cells: Array.from({ length: cols * rows }, () => []) };
    } else for (const c of this.grid.cells) c.length = 0;
    this.nBoxes = 0;
  }

  // box test with optional shrink (hysteresis); returns true if free
  free(x0, y0, x1, y1) {
    const g = this.grid, B = this.boxes;
    const c0 = clamp(Math.floor((x0 + g.M) / g.cs), 0, g.cols - 1), c1 = clamp(Math.floor((x1 + g.M) / g.cs), 0, g.cols - 1);
    const r0 = clamp(Math.floor((y0 + g.M) / g.cs), 0, g.rows - 1), r1 = clamp(Math.floor((y1 + g.M) / g.cs), 0, g.rows - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = g.cells[r * g.cols + c];
        for (let i = 0; i < cell.length; i++) {
          const b = cell[i] * 4;
          if (x0 < B[b + 2] && x1 > B[b] && y0 < B[b + 3] && y1 > B[b + 1]) return false;
        }
      }
    }
    return true;
  }

  insert(x0, y0, x1, y1) {
    if (this.nBoxes * 4 >= this.boxes.length) { const nb = new Float32Array(this.boxes.length * 2); nb.set(this.boxes); this.boxes = nb; }
    const g = this.grid, i = this.nBoxes++;
    this.boxes.set([x0, y0, x1, y1], i * 4);
    const c0 = clamp(Math.floor((x0 + g.M) / g.cs), 0, g.cols - 1), c1 = clamp(Math.floor((x1 + g.M) / g.cs), 0, g.cols - 1);
    const r0 = clamp(Math.floor((y0 + g.M) / g.cs), 0, g.rows - 1), r1 = clamp(Math.floor((y1 + g.M) / g.cs), 0, g.rows - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g.cells[r * g.cols + c].push(i);
  }

  // try a list of boxes [x0,y0,x1,y1,...]; pad > 0 for new labels, < 0 (shrink) for already visible ones
  tryBoxes(bs, n, pad) {
    for (let i = 0; i < n; i += 4) if (!this.free(bs[i] - pad, bs[i + 1] - pad, bs[i + 2] + pad, bs[i + 3] + pad)) return false;
    for (let i = 0; i < n; i += 4) this.insert(bs[i], bs[i + 1], bs[i + 2], bs[i + 3]);
    return true;
  }

  // ---- candidates per view -------------------------------------------------------------------------------------
  get(id, make) {
    let c = this.live.get(id);
    if (!c) { c = make(); c.id = id; c.a = 0; c.target = 0; c.ta = 0; this.live.set(id, c); }
    return c;
  }

  clusters(mpp) {
    const b = bucketOf(mpp);
    const sig = `${b}|${this.poiOn}|${[...this.cats].join(',')}`;
    if (this.clusterCache?.sig === sig) return this.clusterCache.list;
    const cell = CLUSTER_CELL * Math.pow(2, b);
    const groups = new Map();
    for (const p of this.pois) {
      if (!this.cats.has(p.cat) || (p.flags & FLAG.landmark)) continue;
      const key = Math.floor(p.x / cell) * 100000 + Math.floor(p.z / cell);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, n: 0, sx: 0, sz: 0, members: [], cats: new Map() }));
      g.n++; g.sx += p.x; g.sz += p.z; g.members.push(p);
      g.cats.set(p.cat, (g.cats.get(p.cat) || 0) + 1);
    }
    const list = [];
    for (const g of groups.values()) {
      if (g.n === 1) { list.push({ single: g.members[0] }); continue; }
      let top = null, tn = 0;
      for (const [k, v] of g.cats) if (v > tn) { tn = v; top = k; }
      list.push({ id: `c|${b}|${g.key}`, x: g.sx / g.n, z: g.sz / g.n, n: g.n, cat: top, members: g.members, bucket: b });
    }
    this.clusterCache = { sig, list };
    return list;
  }

  // view: { cx, cz, mpp (CSS m/px), w, h } (north-up). Returns true when something changed (needs redraw).
  update(view, dt, force = false) {
    const lv = this.lastView;
    const moved = force || lv.cx !== view.cx || lv.cz !== view.cz || lv.mpp !== view.mpp || lv.w !== view.w || lv.h !== view.h;
    const t = performance.now();
    if (moved || t - this.lastPlace > 300) {
      this.place(view);
      lv.cx = view.cx; lv.cz = view.cz; lv.mpp = view.mpp; lv.w = view.w; lv.h = view.h;
      this.lastPlace = t;
    }
    // fades
    let anim = moved;
    const step = dt * FADE;
    for (const [id, c] of this.live) {
      if (c.a !== c.target) {
        c.a = c.a < c.target ? Math.min(c.target, c.a + step) : Math.max(c.target, c.a - step);
        anim = true;
      }
      const tt = c.textOn ? 1 : 0;
      if (c.ta !== undefined && c.ta !== tt) { c.ta = c.ta < tt ? Math.min(tt, c.ta + step) : Math.max(tt, c.ta - step); anim = true; }
      if (c.a === 0 && c.target === 0 && !c.static) this.live.delete(id);
    }
    return anim || this.spritePending; // labels still waiting for their sprite: draw again
  }

  place(view) {
    const t0 = performance.now();
    const { mpp, w, h } = view;
    const sx = (x) => (x - view.cx) / mpp + w / 2;
    const sy = (z) => (z - view.cz) / mpp + h / 2;
    this.resetGrid(w, h);
    const M = 60;
    const inView = (x, y, m = M) => x > -m && x < w + m && y > -m && y < h + m;
    const cands = [];
    const pass = (this.passId = (this.passId || 0) + 1);
    const push = (c) => { c.pass = pass; cands.push(c); };
    // static labels (regions, areas, districts, natural features)
    for (const c of this.static) {
      if (!c.static) { c.static = true; this.live.set(c.id, c); }
      c.sx = sx(c.x); c.sy = sy(c.z);
      if (mpp >= c.min && mpp <= c.max && inView(c.sx, c.sy, 200)) push(c);
    }
    // remote players
    for (const p of this.players) {
      if (!p.name) continue;
      const c = this.get(`pl|${p.id}`, () => ({ kind: 'player', style: 'player', pri: 1000 }));
      c.text = p.name; c.x = p.x; c.z = p.z; c.sx = sx(p.x); c.sy = sy(p.z) - 15; c.color = p.color;
      if (inView(c.sx, c.sy)) push(c);
    }
    // POIs: markers (+ text when zoomed in), clusters when zoomed out
    if (this.poiOn) {
      const clustered = mpp > CLUSTER_ABOVE;
      const clustersOn = mpp <= CLUSTER_MAX;
      const addPoi = (p) => {
        const x = sx(p.x), y = sy(p.z);
        if (!inView(x, y)) return;
        const lm = (p.flags & FLAG.landmark) !== 0;
        if (lm && mpp > 10) return;
        const c = this.get(`p|${p.i}`, () => ({ kind: 'poi', poi: p, cat: p.cat }));
        c.sx = x; c.sy = y;
        const named = p.name && !p.generic;
        c.text = named ? p.name : null;
        c.style = lm ? 'landmark' : 'poi';
        c.textWanted = named && (lm ? mpp <= 4.5 : p.rank >= 3 ? mpp <= 2.0 : mpp <= 1.15);
        c.pri = lm ? 500 + p.rank : c.textWanted ? 400 + p.rank * 10 : 250 + p.rank;
        push(c);
      };
      for (const p of this.pois) if ((p.flags & FLAG.landmark) && this.cats.has(p.cat)) addPoi(p);
      if (!clustered) {
        for (const p of this.pois) if (!(p.flags & FLAG.landmark) && this.cats.has(p.cat)) addPoi(p);
      } else if (clustersOn) {
        for (const g of this.clusters(mpp)) {
          if (g.single) { addPoi(g.single); continue; }
          const x = sx(g.x), y = sy(g.z);
          if (!inView(x, y)) continue;
          const c = this.get(g.id, () => ({ kind: 'cluster', cluster: g, pri: 450 + Math.log2(g.n) }));
          c.sx = x; c.sy = y; c.cat = g.cat; c.n = g.n; c.cluster = g;
          push(c);
        }
      }
    }
    // streets: anchors at fixed world spacing per zoom bucket (stable while panning)
    if (mpp <= 4.2) this.streetCandidates(view, sx, sy, push);
    // numbered route shields + interstate exit numbers
    this.routeCandidates(view, sx, sy, push);

    cands.sort((a, b) => (b.pri - a.pri) || ((b.target || 0) - (a.target || 0)));
    const bs = this._bs || (this._bs = new Float32Array(256));
    const placed = [];
    // same-name street labels / route shields keep a minimum distance (a street may be split into fragments)
    const named = this._named || (this._named = new Map());
    named.clear();
    const tooClose = (key, x, y, d) => {
      const l = named.get(key);
      if (l) for (let i = 0; i < l.length; i += 2) if (Math.abs(l[i] - x) < d && Math.abs(l[i + 1] - y) < d) return true;
      return false;
    };
    const remember = (key, x, y) => { let l = named.get(key); if (!l) named.set(key, (l = [])); l.push(x, y); };
    for (const c of cands) {
      const was = c.target === 1;
      const pad = was ? -2 : 3;
      let ok = false;
      if (c.kind === 'text' || c.kind === 'player') {
        const [bw, bh] = this.boxSize(c.text, c.style);
        bs[0] = c.sx - bw / 2; bs[1] = c.sy - bh / 2; bs[2] = c.sx + bw / 2; bs[3] = c.sy + bh / 2;
        ok = this.tryBoxes(bs, 4, pad);
      } else if (c.kind === 'poi') {
        const r = MARKER_R + 1;
        c.textOn = false;
        if (c.text && c.textWanted) {
          const [bw, bh] = this.boxSize(c.text, c.style);
          // text right of the marker, else left
          for (const side of c.side === -1 ? [-1, 1] : [1, -1]) {
            bs[0] = c.sx - r; bs[1] = c.sy - r; bs[2] = c.sx + r; bs[3] = c.sy + r;
            if (side > 0) { bs[4] = c.sx + r + 1; bs[6] = c.sx + r + 3 + bw; } else { bs[4] = c.sx - r - 3 - bw; bs[6] = c.sx - r - 1; }
            bs[5] = c.sy - bh / 2; bs[7] = c.sy + bh / 2;
            if (this.tryBoxes(bs, 8, pad)) { ok = true; c.textOn = true; c.side = side; c.tw = bw; break; }
          }
        }
        if (!ok) {
          bs[0] = c.sx - r; bs[1] = c.sy - r; bs[2] = c.sx + r; bs[3] = c.sy + r;
          ok = this.tryBoxes(bs, 4, pad);
        }
      } else if (c.kind === 'cluster') {
        const r = clusterR(c.n) + 1;
        bs[0] = c.sx - r; bs[1] = c.sy - r; bs[2] = c.sx + r; bs[3] = c.sy + r;
        ok = this.tryBoxes(bs, 4, pad);
      } else if (c.kind === 'street') {
        ok = this.placeStreet(c, view, sx, sy, bs, pad);
        if (ok) {
          const p = pointAt(c.path, c.s0 + c.L / 2);
          const x = sx(p[0]), y = sy(p[1]);
          if (tooClose('s|' + c.text, x, y, 240)) ok = false; // boxes stay reserved: harmless, it is rare
          else remember('s|' + c.text, x, y);
        }
      } else if (c.kind === 'shield' || c.kind === 'exit') {
        const key = (c.kind === 'exit' ? 'x|' : 'h|') + c.shieldKind + c.text;
        if (!tooClose(key, c.sx, c.sy, c.minD || 200)) {
          const hw = c.bw / 2 + 1, hh = c.bh / 2 + 1;
          bs[0] = c.sx - hw; bs[1] = c.sy - hh; bs[2] = c.sx + hw; bs[3] = c.sy + hh;
          ok = this.tryBoxes(bs, 4, pad + (c.kind === 'exit' ? 2 : 5));
          if (ok) remember(key, c.sx, c.sy);
        }
      }
      c.target = ok ? 1 : 0;
      if (ok) placed.push(c);
    }
    // everything that was not a candidate in this pass fades out
    for (const c of this.live.values()) if (c.pass !== pass) c.target = 0;
    this.placed = placed;
    this.stats.place++;
    this.stats.candidates = cands.length;
    this.stats.placeMs = performance.now() - t0;
  }

  streetCandidates(view, sx, sy, push) {
    const { mpp, w, h } = view;
    const b = bucketOf(mpp);
    const spacing = 460 * Math.pow(2, b); // world metres between label anchors
    const x0 = view.cx - (w / 2 + 50) * mpp, x1 = view.cx + (w / 2 + 50) * mpp;
    const z0 = view.cz - (h / 2 + 50) * mpp, z1 = view.cz + (h / 2 + 50) * mpp;
    const used = this._usedStreets || (this._usedStreets = new Set());
    used.clear();
    for (const P of this.streetPaths) {
      const bb = P.bbox;
      if (bb[2] < x0 || bb[0] > x1 || bb[3] < z0 || bb[1] > z1) continue;
      const isRoute = !!P.shield;
      const textOk = mpp <= (P.kind === 'bridge' ? 3.2 : isRoute ? 2.6 : 2.3);
      const n = Math.max(1, Math.floor(P.len / spacing));
      const step = P.len / n;
      for (let k = 0; k < n; k++) {
        const s = step * (k + 0.5);
        if (textOk) {
          const c = this.get(`s|${P.i}|${b}|${k}`, () => ({ kind: 'street', path: P, style: P.kind === 'bridge' ? 'bridge' : 'street', text: P.name, s }));
          c.s = s;
          // same priority for all fragments of a street, so the visible one keeps its place (hysteresis tiebreak)
          c.pri = 300 + Math.min(50, P.total / 60) + (P.kind === 'bridge' ? 20 : 0);
          push(c);
        }
        if (isRoute && mpp <= 9 && (k % 2 === 1 || n === 1)) {
          // shield, offset along the path from the text anchor
          const sh = Math.min(P.len, s + (n === 1 ? 0 : step * 0.5));
          const id = `h|${P.i}|${b}|${k}`;
          const c = this.get(id, () => ({ kind: 'shield', path: P, text: P.shield, shieldKind: STREET_SHIELD[P.shieldKind] || 'SR' }));
          const pt = pointAt(P, n === 1 && textOk ? Math.min(P.len, s + 60) : sh);
          c.x = pt[0]; c.z = pt[1]; c.sx = sx(pt[0]); c.sy = sy(pt[1]);
          [c.bw, c.bh] = shieldSize(c.shieldKind, c.text);
          c.pri = 350;
          if (c.sx > -20 && c.sx < w + 20 && c.sy > -20 && c.sy < h + 20) push(c);
        }
      }
    }
  }

  // route shields at fixed world spacing along each numbered route (stable while panning: the anchors only change
  // per zoom octave), interstate exit numbers close up
  routeCandidates(view, sx, sy, push) {
    const { mpp, w, h } = view;
    const b = bucketOf(mpp);
    const x0 = view.cx - (w / 2 + 40) * mpp, x1 = view.cx + (w / 2 + 40) * mpp;
    const z0 = view.cz - (h / 2 + 40) * mpp, z1 = view.cz + (h / 2 + 40) * mpp;
    for (const P of this.routePaths) {
      const R = ROUTE_STYLE[P.kind];
      if (!R || mpp > R.max) continue;
      const bb = P.bbox;
      if (bb[2] < x0 || bb[0] > x1 || bb[3] < z0 || bb[1] > z1) continue;
      const spacing = R.spacing * Math.pow(2, b);
      const n = Math.max(1, Math.round(P.len / spacing));
      const step = P.len / n;
      for (let k = 0; k < n; k++) {
        const s = step * (k + 0.5);
        const pt = pointAt(P, s);
        const x = sx(pt[0]), y = sy(pt[1]);
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
        const c = this.get(`R|${P.i}|${b}|${k}`, () => ({ kind: 'shield', text: P.num, shieldKind: P.kind }));
        c.x = pt[0]; c.z = pt[1]; c.sx = x; c.sy = y;
        [c.bw, c.bh] = shieldSize(P.kind, P.num);
        c.pri = R.pri + (P.kind === 'I' ? 0 : Math.min(8, P.total / 1500));
        c.minD = P.kind === 'I' ? 190 : 230;
        push(c);
      }
    }
    if (mpp <= EXIT_MAX) {
      for (const e of this.exits) {
        const x = sx(e.x), y = sy(e.z);
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
        const c = this.get(`X|${e.i}`, () => ({ kind: 'exit', text: e.num, shieldKind: e.route ? e.route.num : '' }));
        c.x = e.x; c.z = e.z; c.sx = x; c.sy = y;
        [c.bw, c.bh] = shieldSize('exit', e.num);
        c.pri = 380;
        c.minD = 40;
        push(c);
      }
    }
  }

  // lay the text along the path around arc length c.s; fills c.glyphPos for drawing. Returns placed.
  placeStreet(c, view, sx, sy, bs, pad) {
    const P = c.path;
    const tw = this.measure(c.text, c.style);
    const L = tw * view.mpp; // world length of the text
    if (L > P.len * 0.96) return false;
    let s0 = c.s - L / 2;
    if (s0 < 0) s0 = 0;
    if (s0 + L > P.len) s0 = P.len - L;
    // direction check: keep upright (reading left -> right)
    const ax = pointAt(P, s0)[0];
    const rev = pointAt(P, s0 + L)[0] < ax;
    // sample tangents along the window; reject sharp bends
    const N = 6;
    let prev = null, total = 0;
    for (let i = 0; i <= N; i++) {
      const ang = tangentAt(P, s0 + (L * i) / N);
      if (prev !== null) {
        let d = ang - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(d) > 0.42) return false;
        total += d;
      }
      prev = ang;
    }
    if (Math.abs(total) > 0.75) return false;
    const st = LABEL_STYLES[c.style];
    const hh = st.size * 0.62;
    // boxes every ~14 px along the text
    const nb = Math.max(1, Math.min(60, Math.ceil(tw / 14)));
    let k = 0;
    for (let i = 0; i < nb; i++) {
      const p = pointAt(P, s0 + (L * (i + 0.5)) / nb);
      const x = sx(p[0]), y = sy(p[1]);
      if (x < -20 || x > view.w + 20 || y < -20 || y > view.h + 20) return false;
      const half = Math.max(hh, tw / nb / 2 + 1);
      bs[k++] = x - half; bs[k++] = y - hh; bs[k++] = x + half; bs[k++] = y + hh;
      if (k >= bs.length - 4) break;
    }
    if (!this.tryBoxes(bs, k, pad)) return false;
    c.s0 = s0; c.L = L; c.rev = rev;
    return true;
  }

  // ---- drawing ------------------------------------------------------------------------------------------------
  // ctx transform: CSS px (caller sets dpr scale). Draws in increasing priority (most important on top).
  draw(ctx, view) {
    this.spriteBudget = 40;
    this.spriteDeadline = performance.now() + 2;
    this.spritePending = false;
    const { mpp, w, h } = view;
    const sx = (x) => (x - view.cx) / mpp + w / 2;
    const sy = (z) => (z - view.cz) / mpp + h / 2;
    const list = [];
    for (const c of this.live.values()) if (c.a > 0.004) list.push(c);
    list.sort((a, b) => a.pri - b.pri);
    for (const c of list) {
      const A = easeAlpha(c.a);
      if (c.kind === 'text' || c.kind === 'player') {
        const sp = this.sprite(c.text, c.style);
        if (!sp) continue;
        const x = c.kind === 'player' ? sx(c.x) : sx(c.x), y = c.kind === 'player' ? sy(c.z) - 15 : sy(c.z);
        ctx.globalAlpha = A;
        ctx.drawImage(sp.canvas, x - sp.w / 2, y - sp.h / 2, sp.w, sp.h);
      } else if (c.kind === 'poi') {
        const x = sx(c.poi.x), y = sy(c.poi.z);
        const hot = this.hoverId === c.id || this.selectedId === c.id;
        drawMarker(ctx, c.cat, x, y, hot ? MARKER_R + 2 : MARKER_R, A, hot);
        if (c.text && c.ta > 0.004) {
          const sp = this.sprite(c.text, c.style);
          if (sp) {
            ctx.globalAlpha = A * easeAlpha(c.ta);
            const r = MARKER_R + 3 - sp.pad;
            const tx = (c.side || 1) > 0 ? x + r : x - r - sp.w;
            ctx.drawImage(sp.canvas, tx, y - sp.h / 2, sp.w, sp.h);
          }
        }
      } else if (c.kind === 'cluster') {
        const x = sx(c.cluster.x), y = sy(c.cluster.z);
        drawCluster(ctx, c, x, y, A, this.hoverId === c.id);
      } else if (c.kind === 'street') {
        if (c.s0 === undefined) continue;
        const sp = this.sprite(c.text, c.style);
        if (!sp || !sp.glyphs) continue;
        ctx.globalAlpha = A;
        this.drawAlong(ctx, c, sp, sx, sy, mpp);
      } else if (c.kind === 'shield' || c.kind === 'exit') {
        if (!c.sprite || c.spriteDpr !== this.dpr) { c.sprite = shieldSprite(c.kind === 'exit' ? 'exit' : c.shieldKind, c.text, this.dpr); c.spriteDpr = this.dpr; }
        const sp = c.sprite;
        ctx.globalAlpha = A;
        ctx.drawImage(sp.canvas, sx(c.x) - sp.w / 2, sy(c.z) - sp.h / 2, sp.w, sp.h);
      }
    }
    ctx.globalAlpha = 1;
  }

  // draw a sprite glyph by glyph along the path (text slices rotated to the local tangent)
  drawAlong(ctx, c, sp, sx, sy, mpp) {
    const P = c.path, dpr = sp.canvas.width / sp.w;
    const g = sp.glyphs;
    const tw = g.length ? g[g.length - 1] - g[0] : sp.w;
    const startX = g[0];
    for (let i = 0; i < g.length; i += 2) {
      const gx0 = g[i], gx1 = g[i + 1];
      const mid = (gx0 + gx1) / 2 - startX;
      const f = mid / tw;
      const s = c.rev ? c.s0 + c.L * (1 - f) : c.s0 + c.L * f;
      const p = pointAt(P, s);
      const x = sx(p[0]), y = sy(p[1]);
      let ang = tangentAt(P, s);
      if (c.rev) ang += Math.PI;
      // first / last glyph keep their outer halo
      const el = i === 0 ? sp.pad : 1, er = i + 2 >= g.length ? sp.pad : 1;
      const gw = gx1 - gx0 + el + er;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.drawImage(sp.canvas, (gx0 - el) * dpr, 0, gw * dpr, sp.canvas.height, -(gx1 - gx0) / 2 - el, -sp.h / 2, gw, sp.h);
      ctx.restore();
    }
  }

  // topmost marker / cluster / label under a screen point
  hit(x, y) {
    for (let i = 0; i < this.placed.length; i++) {
      const c = this.placed[i];
      if (c.a < 0.3) continue;
      if (c.kind === 'poi' || c.kind === 'cluster') {
        const r = (c.kind === 'cluster' ? clusterR(c.n) : MARKER_R) + 4;
        const d = Math.hypot(x - c.sx, y - c.sy);
        if (d <= r) return c;
        if (c.kind === 'poi' && c.textOn) {
          const x0 = c.side > 0 ? c.sx + MARKER_R : c.sx - MARKER_R - c.tw;
          if (x >= x0 && x <= x0 + c.tw && Math.abs(y - c.sy) < 9) return c;
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// label paths of a polyline set (st / rt): arc length + bbox per part; info(cell) gives the attached record
function buildPaths(set, info) {
  const out = [];
  if (!set) return out;
  for (let i = 0; i < set.n; i++) {
    const rec = info(set.parts[i * 4]);
    if (!rec) continue;
    const n = set.start[i + 1] - set.start[i];
    if (n < 2) continue;
    const xy = set.xy.subarray(set.start[i] * 2, set.start[i + 1] * 2);
    const cum = new Float32Array(n);
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = xy[k * 2], z = xy[k * 2 + 1];
      if (k) cum[k] = cum[k - 1] + Math.hypot(x - xy[k * 2 - 2], z - xy[k * 2 - 1]);
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
    }
    out.push({ i, kind: rec.kind, num: rec.num, name: rec.name, xy, cum, len: cum[n - 1], n, bbox: [bx0, bz0, bx1, bz1], total: rec.len || cum[n - 1] });
  }
  return out;
}

const easeAlpha = (a) => a * a * (3 - 2 * a);
const clusterR = (n) => Math.min(17, 10 + Math.log2(n) * 1.6);

function drawCluster(ctx, c, x, y, A, hot) {
  const r = clusterR(c.n) + (hot ? 1.5 : 0);
  const col = CATEGORIES[c.cat]?.color || '#888';
  ctx.globalAlpha = A;
  ctx.beginPath();
  ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(8, 10, 14, 0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = hot ? '#fff' : 'rgba(255,255,255,0.85)';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `500 ${c.n >= 100 ? 11 : 12}px ${OSWALD}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(c.n), x, y + 0.5);
  ctx.globalAlpha = 1;
}

// path helpers (arc-length parametrisation over the world polyline)
const _pt = [0, 0];
function seg(P, s) {
  const cum = P.cum;
  if (s <= 0) return 0;
  if (s >= P.len) return P.n - 2;
  let lo = 0, hi = P.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  return lo;
}
export function pointAt(P, s) {
  const k = seg(P, s);
  const l = P.cum[k + 1] - P.cum[k] || 1;
  const t = clamp((s - P.cum[k]) / l, 0, 1);
  const xy = P.xy;
  _pt[0] = xy[k * 2] + (xy[k * 2 + 2] - xy[k * 2]) * t;
  _pt[1] = xy[k * 2 + 1] + (xy[k * 2 + 3] - xy[k * 2 + 1]) * t;
  return _pt; // scratch: copy before the next call
}
export function tangentAt(P, s) {
  // smoothed: direction over a short window around s
  const a = pointAt(P, Math.max(0, s - 6));
  const ax = a[0], az = a[1];
  const b = pointAt(P, Math.min(P.len, s + 6));
  return Math.atan2(b[1] - az, b[0] - ax);
}
