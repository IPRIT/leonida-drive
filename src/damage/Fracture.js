import * as THREE from 'three';
import { FracturePrep } from './FracturePrep.js';
import { GROUPS, groups } from '../vehicle/groups.js';

// Real facade fracture for buildings (destruction workstream).
//
// A hit building is rebuilt as its own meshes, cheaply and lazily:
//  - "base" part: everything that is not a wall (roofs, gables, crowns, neon bands, piers) split by structural region,
//    plus the walls as a coarse "shell": one quad per (wall edge, storey band, region run). ~100 quads for a tower.
//  - "cell" parts (4 storeys x one structural region), built only where something happens: every bay x storey of the
//    cell becomes a panel with an outer face (procedural windows, same shader as the merged city), an inner face inset
//    by the wall thickness, side jambs (shown when the neighbour panel is gone), and floor slabs with thickness.
// The walls are captured from Buildings.addBuilding (prism -> panelWall), so IRL multi-part massing, crowns and
// roofs fracture exactly as they are drawn. Damage state lives in a per-session record (persists when a fractured
// building is evicted far away and rebuilt on return).

const SINK = 2.0; // walls start this far below the ground (Buildings.js)
const T = 0.34; // wall thickness: inner face inset
const SLAB = 0.3; // floor slab thickness
const BAND_ROWS = 4;
const STREAM_R = 420; // fractured colliders exist within this distance of the player
const MAX_FRACTURED = 40;
const IN_COL = [0.085, 0.08, 0.075];
const SLAB_TOP = [0.23, 0.22, 0.2];
const SLAB_BOT = [0.12, 0.115, 0.11];
const SLAB_EDGE = [0.33, 0.32, 0.3];
const CORE = [0.36, 0.34, 0.31];

export function floorH(style) { return style > 2.5 && style < 3.5 ? 3.1 : 3.6; }
function bayW(style) { return style > 1.5 && style < 2.5 ? 1.6 : style > 3.5 && style < 4.5 ? 6.0 : 3.1; }
function panelW(style) { const b = bayW(style); return b * Math.max(1, Math.round(3.1 / b)); }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// first storey line above a wall bottom y0 (the sunken part + first storey form the ground row)
function firstLine(y0, vb, fh) {
  let y = vb + Math.max(1, Math.floor((y0 - vb) / fh) + 1) * fh;
  if (y - y0 < fh * 0.4) y += fh;
  return y;
}

// attribute uploads: a full re-upload must not be cut down to the small ranges added in the same frame
// (three.js uploads only the update ranges when there are any)
function fullUpload(a) { hookUpload(a); a.clearUpdateRanges(); a._full = true; a.needsUpdate = true; }
function rangeUpload(a, start, count) { hookUpload(a); if (!a._full) a.addUpdateRange(start, count); a.needsUpdate = true; }
function hookUpload(a) { if (!a._hooked) { a._hooked = true; a.onUpload(() => { a._full = false; }); } }

// growable typed vertex soup (same attribute layout as the merged building buckets)
class Geo {
  constructor(v = 512) {
    this.cap = v;
    this.p = new Float32Array(v * 3); this.n = new Float32Array(v * 3); this.c = new Float32Array(v * 3);
    this.f = new Float32Array(v * 4); this.e = new Float32Array(v * 3);
    this.icap = v * 2;
    this.i = new Uint32Array(this.icap); this.ph = new Uint8Array(this.icap / 3 + 1);
    this.nv = 0; this.ni = 0;
  }

  _growV() {
    const c = this.cap * 2;
    const g = (a, k) => { const b = new Float32Array(c * k); b.set(a); return b; };
    this.p = g(this.p, 3); this.n = g(this.n, 3); this.c = g(this.c, 3); this.f = g(this.f, 4); this.e = g(this.e, 3);
    this.cap = c;
  }

  _growI() {
    const c = this.icap * 2;
    const i = new Uint32Array(c); i.set(this.i); this.i = i;
    const ph = new Uint8Array(c / 3 + 1); ph.set(this.ph); this.ph = ph;
    this.icap = c;
  }

  vtx(x, y, z, nx, ny, nz, c, fu, fv, fs, fk) {
    if (this.nv >= this.cap) this._growV();
    const o = this.nv * 3, o4 = this.nv * 4;
    this.p[o] = x; this.p[o + 1] = y; this.p[o + 2] = z;
    this.n[o] = nx; this.n[o + 1] = ny; this.n[o + 2] = nz;
    this.c[o] = c[0]; this.c[o + 1] = c[1]; this.c[o + 2] = c[2];
    this.f[o4] = fu; this.f[o4 + 1] = fv; this.f[o4 + 2] = fs; this.f[o4 + 3] = fk;
    return this.nv++;
  }

  // vertex from a 16-float record: pos3 nrm3 col3 fac4 neon3
  vtxRec(r, o = 0) {
    if (this.nv >= this.cap) this._growV();
    const v = this.nv, o3 = v * 3, o4 = v * 4;
    this.p[o3] = r[o]; this.p[o3 + 1] = r[o + 1]; this.p[o3 + 2] = r[o + 2];
    this.n[o3] = r[o + 3]; this.n[o3 + 1] = r[o + 4]; this.n[o3 + 2] = r[o + 5];
    this.c[o3] = r[o + 6]; this.c[o3 + 1] = r[o + 7]; this.c[o3 + 2] = r[o + 8];
    this.f[o4] = r[o + 9]; this.f[o4 + 1] = r[o + 10]; this.f[o4 + 2] = r[o + 11]; this.f[o4 + 3] = r[o + 12];
    this.e[o3] = r[o + 13]; this.e[o3 + 1] = r[o + 14]; this.e[o3 + 2] = r[o + 15];
    return this.nv++;
  }

  tri(a, b, c, phys) {
    if (this.ni + 3 > this.icap) this._growI();
    this.ph[this.ni / 3] = phys;
    this.i[this.ni++] = a; this.i[this.ni++] = b; this.i[this.ni++] = c;
  }

  quad(b, phys) { this.tri(b, b + 1, b + 2, phys); this.tri(b, b + 2, b + 3, phys); }
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function area2(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length]; a += x0 * z1 - x1 * z0; }
  return a;
}

// Sutherland-Hodgman clip of a (u,v) polygon by an axis-aligned rectangle
function clipRect(poly, uA, uB, vA, vB) {
  let out = poly;
  const planes = [[0, uA, 1], [0, uB, -1], [1, vA, 1], [1, vB, -1]];
  for (const [ax, val, s] of planes) {
    const inp = out;
    out = [];
    if (inp.length < 3) return [];
    for (let i = 0; i < inp.length; i++) {
      const P = inp[i], Q = inp[(i + 1) % inp.length];
      const dp = s * (P[ax] - val), dq = s * (Q[ax] - val);
      if (dp >= 0) out.push(P);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
  }
  const res = [];
  for (const p of out) { const q = res[res.length - 1]; if (!q || Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) > 0.02) res.push(p); }
  if (res.length > 1) { const a = res[0], b = res[res.length - 1]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 0.02) res.pop(); }
  return res.length >= 3 ? res : [];
}

function triangulate(pts) {
  try { return THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), []); } catch { return []; }
}

// ---------- the fractured building ----------

export class FracturedBuilding {
  constructor(F, id, prepared = null, prepareOnly = false) {
    this.F = F;
    this.id = id;
    this.game = F.game;
    const B = (this.B = F.game.buildings);
    const r = B.recs[id], o = B.list[id];
    this.r = r;
    this.rec = F.record(id);
    this.external = true; // Buildings.js: colliders / remove / damage are handled here
    this.base = o.y;
    this.style = o.s;
    this.fh = floorH(o.s);
    this.parts = [];
    this.cells = new Map(); // band * 64 + region -> part
    this.panelByKey = new Map();
    this.groundTotal = [];
    this.groundOut = [];
    this.sideTotal = [];
    this.sideOut = [];
    // every storey of every region carries what is above it: walls standing per (region, storey) and per side
    this.stTotal = new Map(); // region * 512 + storey -> [all, +u, -u, +v, -v]
    this.stOut = new Map();
    if ((r.health ?? 1) < 0.999 && this.rec.tint === 1) this.rec.tint = 0.45 + 0.55 * r.health; // scorched before it fractured
    if (prepared) {
      Object.assign(this, prepared.state);
      this.basePart = this._part(prepared.geo, -1, -1);
    } else {
      this.preparing = prepareOnly;
      this._capture(o);
      this._frame(o);
      this._layout();
      this._buildBase();
    }
    if (prepareOnly) return;
    // hide the merged original (restorable on eviction)
    const g0 = B.buckets.get(r.key).mesh.geometry.index;
    this.idxBackup = g0.array.slice(r.iStart, r.iEnd);
    g0.array.fill(0, r.iStart, r.iEnd);
    g0.addUpdateRange(r.iStart, r.iEnd - r.iStart);
    g0.needsUpdate = true;
    const c = B.colliders.get(id);
    if (c) { try { F.game.world.removeCollider(c, false); } catch { /* gone */ } B.colliders.delete(id); }
    r.frac = this;
    // re-apply persisted damage (building rebuilt after eviction)
    for (const k of this.rec.failed) this._removeRegion(k);
    if (this.rec.failed.size) this._cutColumns();
    const cells = new Set();
    for (const key of [...this.rec.out, ...this.rec.glass, ...this.rec.dmg.keys()]) {
      const c2 = this.keyCell(key);
      if (c2 >= 0) cells.add(c2);
    }
    // damaged cells come back one per job (a heavily damaged tower would otherwise rebuild in one go)
    for (const c2 of cells) F.queue(() => { if (!this.disposed) this.activateCell(c2 >> 6, c2 & 63); }, id);
    if (this.rec.tint !== 1) this.tint(this.rec.tint);
  }

  // ---------- capture what Buildings.addBuilding draws ----------
  _capture(o) {
    const B = this.B;
    const tb = { key: -1, pos: [], nrm: [], col: [], fac: [], neon: [], idx: [], phys: [], physIdx: [] };
    const edges = [], prisms = [];
    const keys = ['bucketFor', 'panelWall', 'prism', '_panels'];
    const saved = keys.map((k) => [Object.prototype.hasOwnProperty.call(B, k), B[k]]);
    const basePrism = B.prism;
    let cur = -1;
    B.bucketFor = () => tb;
    B._panels = [];
    // vb: height the facade's storey grid starts from (window v = y - vb)
    B.panelWall = (b, ax, az, bx, bz, L, nx, nz, y0, y1, u0, style, col, vb) => {
      const dx = bx - ax, dz = bz - az;
      edges.push({ ax, az, bx, bz, dx, dz, L, tx: dx / L, tz: dz / L, nx, nz, y0, y1, u0, style, col: [col[0], col[1], col[2]], vb: vb ?? y0 + SINK, p: cur });
    };
    B.prism = function (...args) {
      const [, poly, y0, y1, , style, roofCol, , kindWall = 0, , vBase = null] = args;
      const keep = kindWall === 0 && poly.length >= 3;
      if (keep) { cur = prisms.length; prisms.push({ poly: poly.map((q) => [q[0], q[1]]), y0, y1, style, vb: vBase ?? y0 + SINK, roofCol: roofCol ? [roofCol[0], roofCol[1], roofCol[2]] : [0.6, 0.6, 0.6], e0: edges.length, e1: 0 }); }
      const res = basePrism.apply(this, args);
      if (keep) { prisms[cur].e1 = edges.length; cur = -1; }
      return res;
    };
    try { B.addBuilding(o, this.id); } finally {
      keys.forEach((k, i) => { if (saved[i][0]) B[k] = saved[i][1]; else delete B[k]; });
    }
    if (!edges.length) throw new Error('no walls captured');
    this.tb = tb;
    this.edges = edges;
    this.prisms = prisms;
  }

  // ---------- oriented frame + structural regions ----------
  _frame(o) {
    let bestL = 0, ux = 1, uz = 0;
    const p = o.p;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      const L = Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]);
      if (L > bestL) { bestL = L; ux = (p[j] - p[i]) / L; uz = (p[j + 1] - p[i + 1]) / L; }
    }
    const vx = -uz, vz = ux;
    const cx = this.r.cx, cz = this.r.cz;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const pr of this.prisms) for (const [x, z] of pr.poly) {
      const u = (x - cx) * ux + (z - cz) * uz, v = (x - cx) * vx + (z - cz) * vz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const nU = clamp(Math.round((u1 - u0) / 11), 1, 3), nV = clamp(Math.round((v1 - v0) / 11), 1, 3);
    this.fr = { cx, cz, ux, uz, vx, vz, u0, u1, v0, v1, nU, nV, du: (u1 - u0) / nU, dv: (v1 - v0) / nV };
    this.nRegions = nU * nV;
    for (const E of this.edges) {
      E.au = (E.ax - cx) * ux + (E.az - cz) * uz; E.av = (E.ax - cx) * vx + (E.az - cz) * vz;
      E.bu = (E.bx - cx) * ux + (E.bz - cz) * uz; E.bv = (E.bx - cx) * vx + (E.bz - cz) * vz;
    }
    this.size = Math.max(u1 - u0, v1 - v0);
  }

  toUV(x, z) { const f = this.fr; return [(x - f.cx) * f.ux + (z - f.cz) * f.uz, (x - f.cx) * f.vx + (z - f.cz) * f.vz]; }
  toXZ(u, v) { const f = this.fr; return [f.cx + f.ux * u + f.vx * v, f.cz + f.uz * u + f.vz * v]; }

  regionOf(x, z) {
    const f = this.fr;
    const [u, v] = this.toUV(x, z);
    const iu = clamp(Math.floor((u - f.u0) / f.du), 0, f.nU - 1), iv = clamp(Math.floor((v - f.v0) / f.dv), 0, f.nV - 1);
    return iu + iv * f.nU;
  }

  regionRect(k) {
    const f = this.fr, iu = k % f.nU, iv = (k / f.nU) | 0;
    return { uA: f.u0 + iu * f.du, uB: f.u0 + (iu + 1) * f.du, vA: f.v0 + iv * f.dv, vB: f.v0 + (iv + 1) * f.dv };
  }

  regionCenter(k) {
    const R = this.regionRect(k);
    const [x, z] = this.toXZ((R.uA + R.uB) / 2, (R.vA + R.vB) / 2);
    return { x, z };
  }

  /** Regions whose rectangle comes within r of (x, z). */
  regionsNear(x, z, r) {
    const [u, v] = this.toUV(x, z);
    const out = [];
    for (let k = 0; k < this.nRegions; k++) {
      const R = this.regionRect(k);
      const du = Math.max(R.uA - u, 0, u - R.uB), dv = Math.max(R.vA - v, 0, v - R.vB);
      if (du * du + dv * dv <= r * r) out.push(k);
    }
    return out.length ? out : [this.regionOf(x, z)];
  }

  neighbours(k) {
    const f = this.fr, iu = k % f.nU, iv = (k / f.nU) | 0, out = [];
    if (iu > 0) out.push(k - 1);
    if (iu < f.nU - 1) out.push(k + 1);
    if (iv > 0) out.push(k - f.nU);
    if (iv < f.nV - 1) out.push(k + f.nU);
    return out;
  }

  bandOf(y) { return clamp(Math.floor((y - this.base) / this.BH), 0, this.nBands - 1); }

  // cell id (band << 6 | region) of a persisted panel key "edge:col:row", -1 when unknown
  keyCell(key) {
    const [e, c, r] = key.split(':').map(Number);
    const E = this.edges[e];
    if (!E || E.rowBand[r] === undefined || E.colRegion[c] === undefined) return -1;
    return (E.rowBand[r] << 6) | E.colRegion[c];
  }

  // ---------- panel grid (bays aligned with the window cells, rows with the storeys) ----------
  _layout() {
    this.BH = BAND_ROWS * this.fh;
    let top = this.base;
    for (const E of this.edges) top = Math.max(top, E.y1);
    this.top = top;
    this.nBands = Math.max(1, Math.floor((top - 0.01 - this.base) / this.BH) + 1);
    for (let k = 0; k < this.nRegions; k++) { this.groundTotal[k] = 0; this.groundOut[k] = 0; this.sideTotal[k] = [0, 0, 0, 0]; this.sideOut[k] = [0, 0, 0, 0]; }
    for (const E of this.edges) {
      const P = panelW(E.style), fh = floorH(E.style);
      const cols = [0];
      for (let u = Math.ceil((E.u0 + 0.01) / P) * P; u < E.u0 + E.L - 0.01; u += P) cols.push((u - E.u0) / E.L);
      cols.push(1);
      const minT = (0.35 * P) / E.L;
      if (cols.length > 2 && cols[1] - cols[0] < minT) cols.splice(1, 1);
      if (cols.length > 2 && cols[cols.length - 1] - cols[cols.length - 2] < minT) cols.splice(cols.length - 2, 1);
      const rows = [E.y0];
      for (let y = firstLine(E.y0, E.vb, fh); y < E.y1 - 0.01; y += fh) rows.push(y);
      rows.push(E.y1);
      if (rows.length > 2 && rows[rows.length - 1] - rows[rows.length - 2] < fh * 0.45) rows.splice(rows.length - 2, 1);
      const colRegion = [];
      for (let c = 0; c < cols.length - 1; c++) {
        const t = (cols[c] + cols[c + 1]) / 2;
        colRegion.push(this.regionOf(E.ax + E.dx * t - E.nx * 0.6, E.az + E.dz * t - E.nz * 0.6));
      }
      const rowBand = [], rowStorey = [];
      for (let r = 0; r < rows.length - 1; r++) {
        const mid = (rows[r] + rows[r + 1]) / 2;
        rowBand.push(this.bandOf(mid));
        rowStorey.push(Math.max(0, Math.floor((mid - this.base) / this.fh)));
      }
      E.cols = cols; E.rows = rows; E.colRegion = colRegion; E.rowBand = rowBand; E.rowStorey = rowStorey;
      E.jc = [0, 1, 2].map((i) => E.col[i] * 0.55 + CORE[i] * 0.45);
      E.ground = E.y0 < this.base - 1; // the main walls, standing on the ground
      // which side of the building the wall faces (frame axes): 0 +u, 1 -u, 2 +v, 3 -v
      const du = E.nx * this.fr.ux + E.nz * this.fr.uz, dv = E.nx * this.fr.vx + E.nz * this.fr.vz;
      E.side = Math.abs(du) >= Math.abs(dv) ? (du > 0 ? 0 : 1) : (dv > 0 ? 2 : 3);
      if (E.ground) for (let c = 0; c < cols.length - 1; c++) { this.groundTotal[colRegion[c]]++; this.sideTotal[colRegion[c]][E.side]++; }
      for (let r = 0; r < rows.length - 1; r++) for (let c = 0; c < cols.length - 1; c++) {
        const key = colRegion[c] * 512 + rowStorey[r];
        let t = this.stTotal.get(key);
        if (!t) this.stTotal.set(key, (t = [0, 0, 0, 0, 0]));
        t[0]++; t[1 + E.side]++;
      }
    }
    // slab tiles per prism and region (floor slabs, roof tiles)
    const f = this.fr, eps = 0.01;
    for (const pr of this.prisms) {
      if (area2(pr.poly) < 0) pr.poly.reverse();
      pr.fh = floorH(pr.style);
      pr.tiles = [];
      const uv = pr.poly.map(([x, z]) => this.toUV(x, z));
      for (let k = 0; k < this.nRegions; k++) {
        const R = this.regionRect(k);
        const cl = this.nRegions === 1 ? uv : clipRect(uv, R.uA - (R.uA <= f.u0 + eps ? 1 : 0), R.uB + (R.uB >= f.u1 - eps ? 1 : 0), R.vA - (R.vA <= f.v0 + eps ? 1 : 0), R.vB + (R.vB >= f.v1 - eps ? 1 : 0));
        if (cl.length < 3) continue;
        let pts = cl.map(([u, v]) => this.toXZ(u, v));
        if (area2(pts) < 0) pts = pts.reverse();
        if (Math.abs(area2(pts)) < 0.6) continue;
        const tris = triangulate(pts);
        if (tris.length) pr.tiles.push({ k, pts, tris });
      }
    }
  }

  // ---------- geometry emitters ----------
  _outer(g, E, tA, tB, ya, yb, col, phys = 1) {
    const xA = E.ax + E.dx * tA, zA = E.az + E.dz * tA, xB = E.ax + E.dx * tB, zB = E.az + E.dz * tB;
    const uA = E.u0 + E.L * tA, uB = E.u0 + E.L * tB, vA = ya - E.vb, vB = yb - E.vb;
    const s = E.style, b = g.nv;
    g.vtx(xA, ya, zA, E.nx, 0, E.nz, col, uA, vA, s, 0);
    g.vtx(xA, yb, zA, E.nx, 0, E.nz, col, uA, vB, s, 0);
    g.vtx(xB, yb, zB, E.nx, 0, E.nz, col, uB, vB, s, 0);
    g.vtx(xB, ya, zB, E.nx, 0, E.nz, col, uB, vA, s, 0);
    g.quad(b, phys);
    return b;
  }

  _inner(g, E, tA, tB, ya, yb, extA = 0, extB = 0, phys = 1) {
    const ox = -E.nx * T, oz = -E.nz * T;
    const xA = E.ax + E.dx * tA - E.tx * extA + ox, zA = E.az + E.dz * tA - E.tz * extA + oz;
    const xB = E.ax + E.dx * tB + E.tx * extB + ox, zB = E.az + E.dz * tB + E.tz * extB + oz;
    const s = E.style, b = g.nv;
    g.vtx(xB, ya, zB, -E.nx, 0, -E.nz, IN_COL, 0, 0, s, 3);
    g.vtx(xB, yb, zB, -E.nx, 0, -E.nz, IN_COL, 0, 0, s, 3);
    g.vtx(xA, yb, zA, -E.nx, 0, -E.nz, IN_COL, 0, 0, s, 3);
    g.vtx(xA, ya, zA, -E.nx, 0, -E.nz, IN_COL, 0, 0, s, 3);
    g.quad(b, phys);
  }

  // side face of the wall thickness at parameter t; side -1 faces the previous column, +1 the next one
  _jamb(g, E, t, ya, yb, side, col) {
    const x = E.ax + E.dx * t, z = E.az + E.dz * t, xi = x - E.nx * T, zi = z - E.nz * T;
    const nx = E.tx * side, nz = E.tz * side, s = E.style, b = g.nv;
    if (side < 0) {
      g.vtx(xi, ya, zi, nx, 0, nz, col, 0, 0, s, 3); g.vtx(xi, yb, zi, nx, 0, nz, col, 0, 0, s, 3);
      g.vtx(x, yb, z, nx, 0, nz, col, 0, 0, s, 3); g.vtx(x, ya, z, nx, 0, nz, col, 0, 0, s, 3);
    } else {
      g.vtx(x, ya, z, nx, 0, nz, col, 0, 0, s, 3); g.vtx(x, yb, z, nx, 0, nz, col, 0, 0, s, 3);
      g.vtx(xi, yb, zi, nx, 0, nz, col, 0, 0, s, 3); g.vtx(xi, ya, zi, nx, 0, nz, col, 0, 0, s, 3);
    }
    g.quad(b, 0);
    return b;
  }

  // floor slab tile with thickness: top face at y, bottom at y - SLAB, side faces (seen at holes and cuts)
  _slab(g, tile, y, { top = true, bottom = true, sides = true, topCol = SLAB_TOP, kindTop = 3, style = this.style } = {}) {
    const pts = tile.pts, n = pts.length;
    if (top) {
      const b = g.nv;
      for (const [x, z] of pts) g.vtx(x, y, z, 0, 1, 0, topCol, 0, 0, style, kindTop);
      for (const [i0, i1, i2] of tile.tris) {
        const ax = pts[i1][0] - pts[i0][0], az = pts[i1][1] - pts[i0][1], bx = pts[i2][0] - pts[i0][0], bz = pts[i2][1] - pts[i0][1];
        if (az * bx - ax * bz > 0) g.tri(b + i0, b + i1, b + i2, 1); else g.tri(b + i0, b + i2, b + i1, 1);
      }
    }
    if (bottom) {
      const b = g.nv, yb = y - SLAB;
      for (const [x, z] of pts) g.vtx(x, yb, z, 0, -1, 0, SLAB_BOT, 0, 0, style, 3);
      for (const [i0, i1, i2] of tile.tris) {
        const ax = pts[i1][0] - pts[i0][0], az = pts[i1][1] - pts[i0][1], bx = pts[i2][0] - pts[i0][0], bz = pts[i2][1] - pts[i0][1];
        if (az * bx - ax * bz > 0) g.tri(b + i0, b + i2, b + i1, 0); else g.tri(b + i0, b + i1, b + i2, 0);
      }
    }
    if (sides) {
      for (let i = 0; i < n; i++) {
        let [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % n];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 0.05) continue;
        const nx = (z1 - z0) / L, nz = -(x1 - x0) / L;
        // edges on the facade sit a little behind the wall plane (no z-fighting with the outer face);
        // edges on region cuts stay exact so neighbouring tiles close up
        if (!this._onCut(x0, z0, x1, z1)) { x0 -= nx * 0.07; z0 -= nz * 0.07; x1 -= nx * 0.07; z1 -= nz * 0.07; }
        const b = g.nv;
        g.vtx(x0, y - SLAB, z0, nx, 0, nz, SLAB_EDGE, 0, 0, style, 3); g.vtx(x0, y, z0, nx, 0, nz, SLAB_EDGE, 0, 0, style, 3);
        g.vtx(x1, y, z1, nx, 0, nz, SLAB_EDGE, 0, 0, style, 3); g.vtx(x1, y - SLAB, z1, nx, 0, nz, SLAB_EDGE, 0, 0, style, 3);
        g.quad(b, 0);
      }
    }
  }

  // both ends on the same interior region line (a cut between slab tiles), not on the facade
  _onCut(x0, z0, x1, z1) {
    const f = this.fr;
    const [u0, v0] = this.toUV(x0, z0), [u1, v1] = this.toUV(x1, z1);
    for (let i = 1; i < f.nU; i++) { const u = f.u0 + i * f.du; if (Math.abs(u0 - u) < 0.03 && Math.abs(u1 - u) < 0.03) return true; }
    for (let i = 1; i < f.nV; i++) { const v = f.v0 + i * f.dv; if (Math.abs(v0 - v) < 0.03 && Math.abs(v1 - v) < 0.03) return true; }
    return false;
  }

  // ---------- base part: misc (by region) + roof tiles + coarse wall shell ----------
  // non-wall geometry (roofs, gables, neon bands, crowns) as 16-float vertex records, cut along the region grid so
  // every piece belongs to exactly one region (a long neon band must not stay floating over a collapsed corner)
  _splitMisc() {
    const tb = this.tb, P = tb.pos, F = tb.fac, N = tb.nrm, C = tb.col, E = tb.neon;
    const f = this.fr;
    const rec = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2], C[i * 3], C[i * 3 + 1], C[i * 3 + 2],
      F[i * 4], F[i * 4 + 1], F[i * 4 + 2], F[i * 4 + 3], E[i * 3], E[i * 3 + 1], E[i * 3 + 2]];
    const uOf = (v) => (v[0] - f.cx) * f.ux + (v[2] - f.cz) * f.uz, vOf = (v) => (v[0] - f.cx) * f.vx + (v[2] - f.cz) * f.vz;
    const lines = [];
    for (let i = 1; i < f.nU; i++) lines.push([uOf, f.u0 + i * f.du]);
    for (let i = 1; i < f.nV; i++) lines.push([vOf, f.v0 + i * f.dv]);
    const cut = (poly, fn, c) => {
      const A = [], B = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const dp = fn(p) - c, dq = fn(q) - c;
        if (dp <= 0) A.push(p);
        if (dp >= 0) B.push(p);
        if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
          const t = dp / (dp - dq), m = p.map((x, k) => x + (q[k] - x) * t);
          A.push(m); B.push(m);
        }
      }
      return [A, B];
    };
    const verts = [], regs = [];
    for (let t = 0; t < tb.idx.length; t += 3) {
      const a = tb.idx[t], b = tb.idx[t + 1], c = tb.idx[t + 2];
      const ya = P[a * 3 + 1], yb = P[b * 3 + 1], yc = P[c * 3 + 1];
      const mx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, mz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
      // flat roofs of the wall prisms are re-tiled per region (with slab thickness) instead
      if (N[a * 3 + 1] > 0.99 && F[a * 4 + 3] === 1 && Math.abs(ya - yb) < 1e-3 && Math.abs(ya - yc) < 1e-3) {
        const pr = this.prisms.find((q) => Math.abs(q.y1 - ya) < 1e-3 && pointInPoly(mx, mz, q.poly));
        if (pr) { pr.hasRoof = true; pr.roofCol = [C[a * 3], C[a * 3 + 1], C[a * 3 + 2]]; continue; }
      }
      if (Math.max(ya, yb, yc) <= this.base + 0.3) { verts.push(rec(a), rec(b), rec(c)); regs.push(-1); continue; }
      let polys = [[rec(a), rec(b), rec(c)]];
      for (const [fn, cc] of lines) {
        const next = [];
        for (const pg of polys) {
          let lo = Infinity, hi = -Infinity;
          for (const v of pg) { const x = fn(v); lo = Math.min(lo, x); hi = Math.max(hi, x); }
          if (lo >= cc - 1e-4 || hi <= cc + 1e-4) { next.push(pg); continue; }
          for (const h of cut(pg, fn, cc)) if (h.length >= 3) next.push(h);
        }
        polys = next;
      }
      for (const pg of polys) {
        let sx = 0, sz = 0;
        for (const v of pg) { sx += v[0]; sz += v[2]; }
        const region = this.regionOf(sx / pg.length, sz / pg.length);
        for (let i = 1; i + 1 < pg.length; i++) { verts.push(pg[0], pg[i], pg[i + 1]); regs.push(region); }
      }
    }
    const v16 = new Float32Array(verts.length * 16);
    verts.forEach((r, i) => v16.set(r, i * 16));
    this.misc = { v: v16, region: Int16Array.from(regs) };
    this.tb = null; // captured soup no longer needed
  }

  _buildBase() {
    this._splitMisc();
    const M = this.misc, nt = M.region.length;
    const g = new Geo(nt * 3 + 256);
    const buckets = new Map();
    for (let t = 0; t < nt; t++) { const r = M.region[t]; let l = buckets.get(r); if (!l) buckets.set(r, (l = [])); l.push(t); }
    this.pieces = { misc: new Map(), roof: new Map(), shell: [] };
    for (const [region, l] of buckets) {
      const i0 = g.ni;
      for (const t of l) { const a = g.vtxRec(M.v, t * 48), b = g.vtxRec(M.v, t * 48 + 16), c = g.vtxRec(M.v, t * 48 + 32); g.tri(a, b, c, 1); }
      if (region >= 0) this.pieces.misc.set(region, [i0, g.ni - i0]);
    }
    for (const pr of this.prisms) {
      if (!pr.hasRoof) continue;
      for (const tile of pr.tiles) {
        const i0 = g.ni;
        this._slab(g, tile, pr.y1, { bottom: false, sides: false, topCol: pr.roofCol, kindTop: 1, style: pr.style });
        let l = this.pieces.roof.get(tile.k);
        if (!l) this.pieces.roof.set(tile.k, (l = []));
        l.push([i0, g.ni - i0]);
      }
    }
    // shell: per edge, band and run of columns in the same region
    for (const E of this.edges) {
      const { cols, rows, colRegion, rowBand } = E;
      let r = 0;
      while (r < rows.length - 1) {
        const k = rowBand[r];
        let r1 = r;
        while (r1 + 1 < rows.length - 1 && rowBand[r1 + 1] === k) r1++;
        let c = 0;
        while (c < cols.length - 1) {
          const reg = colRegion[c];
          let c1 = c;
          while (c1 + 1 < cols.length - 1 && colRegion[c1 + 1] === reg) c1++;
          const i0 = g.ni;
          this._outer(g, E, cols[c], cols[c1 + 1], rows[r], rows[r1 + 1], E.col);
          this.pieces.shell.push({ band: k, region: reg, i0, n: 6 });
          c = c1 + 1;
        }
        r = r1 + 1;
      }
    }
    if (this.preparing) this.baseGeo = g;
    else this.basePart = this._part(g, -1, -1);
  }

  _part(g, band, region) {
    const geo = new THREE.BufferGeometry();
    const nv = g.nv;
    geo.setAttribute('position', new THREE.BufferAttribute(g.p.slice(0, nv * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(g.n.slice(0, nv * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(g.c.slice(0, nv * 3), 3));
    geo.setAttribute('aFacade', new THREE.BufferAttribute(g.f.slice(0, nv * 4), 4));
    geo.setAttribute('aNeon', new THREE.BufferAttribute(g.e.slice(0, nv * 3), 3));
    const idx = g.i.slice(0, g.ni);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.F.material());
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = `bld-frac:${this.id}:${band}:${region}`;
    this.B.group.add(mesh);
    const part = {
      band, region, mesh, geo, idx, idx0: idx.slice(), phys: g.ph.slice(0, g.ni / 3), col0: geo.attributes.color.array.slice(),
      collider: null, colDirty: true, dMin: Infinity, dMax: -1, panels: null, slabs: null,
    };
    this.parts.push(part);
    if (band >= 0) this.cells.set((band << 6) | region, part);
    if (this.rec.tint !== 1) this._tintPart(part, this.rec.tint);
    return part;
  }

  _zero(part, i0, n) { part.idx.fill(0, i0, i0 + n); this._mark(part, i0, n); }
  _restore(part, i0, n) { part.idx.set(part.idx0.subarray(i0, i0 + n), i0); this._mark(part, i0, n); }
  _mark(part, i0, n) { if (i0 < part.dMin) part.dMin = i0; if (i0 + n > part.dMax) part.dMax = i0 + n; }

  /** Upload index edits of all parts and rebuild the colliders that changed (call once per operation). */
  flush(deferColliders = false) {
    const dirty = [];
    for (const part of this.parts) {
      if (part.dMax < 0) continue;
      const a = part.geo.index;
      a.addUpdateRange(part.dMin, part.dMax - part.dMin);
      a.needsUpdate = true;
      part.dMin = Infinity; part.dMax = -1;
      part.colDirty = true;
      dirty.push(part);
    }
    if (!this.colliding) return;
    if (!deferColliders) { this.ensureColliders(true); return; }
    // big edits (a section collapsing): one collider rebuild per job over the next frames
    for (const part of dirty) {
      if (part.pending) continue;
      part.pending = true;
      this.F.queue(() => { part.pending = false; if (!this.disposed && this.colliding && part.colDirty === true && this.parts.includes(part)) this._rebuildCollider(part); }, this.id);
    }
  }

  _rebuildCollider(part) {
    if (part.collider) { try { this.game.world.removeCollider(part.collider, false); } catch { /* gone */ } part.collider = null; }
    part.collider = this._collider(part);
    part.colDirty = part.collider ? false : 'none';
  }

  // ---------- cell activation (4 storeys x one region) ----------
  cellActive(k, reg) { return this.cells.has((k << 6) | reg); }

  activateCell(k, reg) {
    if (k < 0 || k >= this.nBands || reg < 0 || reg >= this.nRegions || this.disposed) return null;
    const have = this.cells.get((k << 6) | reg);
    if (have) return have;
    if (this.rec.failed.has(reg)) return null;
    const g = new Geo(256);
    const list = [];
    const edges = this.edges;
    for (let e = 0; e < edges.length; e++) {
      const E = edges[e];
      const { cols, rows, colRegion, rowBand } = E;
      for (let r = 0; r < rows.length - 1; r++) {
        if (rowBand[r] !== k) continue;
        const ya = rows[r], yb = rows[r + 1];
        for (let c = 0; c < cols.length - 1; c++) {
          if (colRegion[c] !== reg) continue;
          const tA = cols[c], tB = cols[c + 1], tm = (tA + tB) / 2;
          const p = {
            key: `${e}:${c}:${r}`, e, c, r, band: k, region: reg, ya, yb, w: E.L * (tB - tA), h: yb - Math.max(ya, this.base),
            x: E.ax + E.dx * tm, z: E.az + E.dz * tm, y: (Math.max(ya, this.base) + yb) / 2, nx: E.nx, nz: E.nz,
            ground: E.ground && r === 0, out: false, glass: false, dmg: 0, part: null,
          };
          p.i0 = g.ni;
          p.oV = this._outer(g, E, tA, tB, ya, yb, E.col);
          this._inner(g, E, tA, tB, ya, yb);
          p.jl = g.ni; this._jamb(g, E, tA, ya, yb, -1, E.jc);
          p.jr = g.ni; this._jamb(g, E, tB, ya, yb, 1, E.jc);
          p.n = g.ni - p.i0;
          list.push(p);
        }
      }
    }
    // slabs at every storey line inside the band (both edges of the band), ceilings under the roofs
    const slabs = [];
    const y0 = this.base + k * this.BH, y1 = y0 + this.BH;
    for (const pr of this.prisms) {
      const tile = pr.tiles.find((t) => t.k === reg);
      if (!tile) continue;
      for (let y = firstLine(pr.y0, pr.vb, pr.fh); y < pr.y1 - 0.6; y += pr.fh) {
        if (y < y0 - 0.05 || y > y1 + 0.05) continue;
        const i0 = g.ni;
        this._slab(g, tile, y);
        slabs.push({ region: reg, i0, n: g.ni - i0 });
      }
      if (pr.y1 > y0 && pr.y1 <= y1 + 0.05) {
        const i0 = g.ni;
        this._slab(g, tile, pr.y1 - 0.02, { top: false, sides: false });
        slabs.push({ region: reg, i0, n: g.ni - i0 });
      }
    }
    if (!g.ni) return null;
    // the coarse shell of this cell goes away
    for (const s of this.pieces.shell) if (s.band === k && s.region === reg) this._zero(this.basePart, s.i0, s.n);
    const part = this._part(g, k, reg);
    part.panels = list;
    part.slabs = slabs;
    for (const p of list) { p.part = part; this.panelByKey.set(p.key, p); this._zero(part, p.jl, 6); this._zero(part, p.jr, 6); }
    // jambs facing already-open neighbours in other cells, persisted damage
    for (const p of list) {
      const d = this.rec.dmg.get(p.key);
      if (d) this.shade(p, d);
      if (this.rec.glass.has(p.key)) this.breakGlass(p);
    }
    for (const p of list) if (this.rec.out.has(p.key)) { p.out = false; this.knock(p, true); }
    for (const p of list) {
      if (p.out) continue;
      const L = this.neighbour(p, -1), R = this.neighbour(p, 1);
      if ((L && L.out) || (!L && this._keyOut(p, -1))) this._restore(part, p.jl, 6);
      if ((R && R.out) || (!R && this._keyOut(p, 1))) this._restore(part, p.jr, 6);
    }
    this.F.stats.cells++;
    this.flush();
    return part;
  }

  _keyOut(p, dc) { return this.rec.out.has(`${p.e}:${p.c + dc}:${p.r}`); }

  /** All cells of storey band k (optionally only regions in `regs`). */
  activateBand(k, regs = null) {
    let last = null;
    for (let reg = 0; reg < this.nRegions; reg++) if (!regs || regs.includes(reg)) last = this.activateCell(k, reg) || last;
    return last;
  }

  /** Make sure the panels within r of p exist (only the cells the sphere touches). */
  ensureAround(p, r) {
    const a = this.bandOf(p.y - r), b = this.bandOf(p.y + r);
    const regs = this.regionsNear(p.x, p.z, r);
    for (let k = a; k <= b; k++) for (const reg of regs) this.activateCell(k, reg);
  }

  /** Panels (of active cells) within r of p: [{panel, d}] */
  panelsNear(p, r, vy = 0.85) {
    const out = [];
    for (const part of this.parts) {
      if (part.band < 0) continue;
      const by0 = this.base + part.band * this.BH - SINK, by1 = by0 + this.BH + SINK;
      if (p.y + r < by0 - 1 || p.y - r > by1 + 1) continue;
      for (const q of part.panels) {
        if (q.out) continue;
        const dx = q.x - p.x, dz = q.z - p.z;
        if (Math.abs(dx) > r + q.w || Math.abs(dz) > r + q.w) continue;
        const d = Math.hypot(dx, (q.y - p.y) * vy, dz);
        if (d <= r + Math.max(q.w, q.h) * 0.5) out.push({ panel: q, d });
      }
    }
    return out;
  }

  neighbour(p, dc, dr = 0) { return this.panelByKey.get(`${p.e}:${p.c + dc}:${p.r + dr}`) || null; }

  // ---------- panel operations (geometry only; effects are done by Destruction) ----------
  knock(p, quiet = false) {
    if (!p || p.out) return false;
    p.out = true;
    this.rec.out.add(p.key);
    this._zero(p.part, p.i0, p.n);
    const L = this.neighbour(p, -1), R = this.neighbour(p, 1);
    if (L && !L.out) this._restore(L.part, L.jr, 6);
    if (R && !R.out) this._restore(R.part, R.jl, 6);
    const E = this.edges[p.e];
    if (p.ground) { this.groundOut[p.region]++; this.sideOut[p.region][E.side]++; }
    const sk = p.region * 512 + E.rowStorey[p.r];
    let o = this.stOut.get(sk);
    if (!o) this.stOut.set(sk, (o = [0, 0, 0, 0, 0]));
    o[0]++; o[1 + E.side]++;
    if (!quiet) this.dirty = true;
    return true;
  }

  breakGlass(p) {
    if (!p) return false;
    const was = p.glass;
    p.glass = true;
    this.rec.glass.add(p.key);
    const a = p.part.geo.attributes.aNeon;
    for (let v = 0; v < 4; v++) a.array[(p.oV + v) * 3] = -1;
    rangeUpload(a, p.oV * 3, 12);
    return !was;
  }

  /** Cracked look of a damaged panel (0..1): crack network drawn by the facade shader (aNeon.y), a little grime. */
  shade(p, d) {
    p.dmg = d;
    this.rec.dmg.set(p.key, d);
    const part = p.part, k = 1 - 0.15 * Math.min(1, d);
    const E = this.edges[p.e], ca = part.geo.attributes.color, na = part.geo.attributes.aNeon, t = this.rec.tint;
    for (let v = 0; v < 4; v++) {
      const o = (p.oV + v) * 3;
      for (let i = 0; i < 3; i++) { part.col0[o + i] = E.col[i] * k; ca.array[o + i] = part.col0[o + i] * t; }
      na.array[o + 1] = Math.min(1, d);
    }
    rangeUpload(ca, p.oV * 3, 12);
    rangeUpload(na, p.oV * 3, 12);
  }

  /** Panels left hanging (the one below and both side neighbours gone) drop too. Returns them. */
  hanging(seed) {
    const out = [];
    let front = seed;
    const gone = (x) => !!x && x.out;
    for (let it = 0; it < 3 && front.length; it++) {
      const next = [];
      for (const p of front) {
        for (const q of [this.neighbour(p, 0, 1), this.neighbour(p, -1), this.neighbour(p, 1)]) {
          if (!q || q.out || q.ground) continue;
          const below = this.neighbour(q, 0, -1), l = this.neighbour(q, -1), r = this.neighbour(q, 1);
          if (gone(below) && gone(l) && gone(r)) { this.knock(q); out.push(q); next.push(q); }
        }
      }
      front = next;
    }
    return out;
  }

  /** Ground-storey wall support of a region (1 = intact); null for interior regions without ground walls. */
  support(k) {
    const n = this.groundTotal[k];
    if (!n) return null;
    return 1 - this.groundOut[k] / n;
  }

  /**
   * Does region k give way? Too little of its ground storey left overall, or one whole side of it knocked out
   * (that wall carried the floors above). null for interior regions without walls of their own.
   */
  fails(k, thrTotal, thrSide) { const s = this.failStorey(k, thrTotal, thrSide); return s === null ? null : s >= 0; }

  /**
   * Lowest storey of region k that no longer carries what is above it (any storey, not only the ground one: blasts
   * and shells high up a tower take out middle floors), or -1. A storey fails with too little of its walls left
   * overall, or with one side (>= 3 bays) knocked out: that wall carried the floors, a slab on one column falls.
   * null for interior regions without walls of their own.
   */
  failStorey(k, thrTotal, thrSide) {
    if (!this.groundTotal[k] && ![...this.stTotal.keys()].some((x) => ((x / 512) | 0) === k)) return null;
    let best = -1;
    for (const [key, o] of this.stOut) {
      if (((key / 512) | 0) !== k) continue;
      const t = this.stTotal.get(key);
      if (!t || t[0] < 2) continue;
      const st = key % 512;
      if (best >= 0 && st >= best) continue;
      let gone = 1 - o[0] / t[0] < thrTotal;
      for (let s = 0; s < 4 && !gone; s++) if (t[1 + s] >= 3 && 1 - o[1 + s] / t[1 + s] < thrSide) gone = true;
      if (gone) best = st;
    }
    return best;
  }

  /** Outward direction {x, z} of the side of region k that lost the most of its support (at storey st). */
  weakDir(k, st = 0) {
    let best = -1, bs = 0;
    const t = this.stTotal.get(k * 512 + st), o = this.stOut.get(k * 512 + st);
    if (t && o) for (let s = 0; s < 4; s++) { const m = t[1 + s]; if (m && o[1 + s] / m > bs) { bs = o[1 + s] / m; best = s; } }
    const f = this.fr;
    return [{ x: f.ux, z: f.uz }, { x: -f.ux, z: -f.uz }, { x: f.vx, z: f.vz }, { x: -f.vx, z: -f.vz }][best] || null;
  }

  // ---------- regions ----------
  _removeRegion(k) {
    for (const s of this.pieces.shell) if (s.region === k) this._zero(this.basePart, s.i0, s.n);
    const m = this.pieces.misc.get(k);
    if (m) this._zero(this.basePart, m[0], m[1]);
    for (const [i0, n] of this.pieces.roof.get(k) || []) this._zero(this.basePart, i0, n);
    for (const part of this.parts) {
      if (part.band === -2 && part.region === k) { this._zero(part, 0, part.idx.length); continue; }
      if (part.band < 0) continue;
      if (part.region === k) { this._zero(part, 0, part.idx.length); for (const p of part.panels) p.out = true; continue; }
      for (const p of part.panels) {
        if (p.out) continue;
        for (const [dc, j] of [[-1, p.jl], [1, p.jr]]) {
          const q = this.neighbour(p, dc);
          if (q?.region === k) this._restore(part, j, 6);
        }
      }
    }
  }

  /** Regions lose their support: their whole stack goes (the caller drops blocks). The cut opens up over time. */
  failRegions(list) {
    for (const k of list) { this.rec.failed.add(k); this._removeRegion(k); }
    this._cutColumns();
    this.flush(true);
    // the neighbours of the cut show their insides: build their cells bottom-up over the next frames
    const regs = new Set();
    for (const k of list) for (const n of this.neighbours(k)) if (!this.rec.failed.has(n)) regs.add(n);
    for (let b = 0; b < this.nBands; b++) for (const reg of regs) this.F.queue(() => { if (!this.disposed) this._openCut(b, reg); }, this.id);
  }

  // exposed concrete columns along every cut line: the slabs left at the edge of a collapsed section visibly sit on
  // columns (they never read as floating plates). One small part per standing region next to a cut.
  _cutColumns() {
    for (const part of this.parts.filter((p) => p.band === -2)) { part.mesh.removeFromParent(); part.geo.dispose(); this.parts.splice(this.parts.indexOf(part), 1); if (part.collider) { try { this.game.world.removeCollider(part.collider, false); } catch { /* gone */ } } }
    const failed = this.rec.failed;
    const byReg = new Map();
    const C = 0.32; // column half width
    const col = [0.3, 0.29, 0.27];
    for (const pr of this.prisms) {
      for (const tile of pr.tiles) {
        if (failed.has(tile.k)) continue;
        const pts = tile.pts, n = pts.length;
        for (let i = 0; i < n; i++) {
          const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % n];
          const L = Math.hypot(x1 - x0, z1 - z0);
          if (L < 0.5 || !this._onCut(x0, z0, x1, z1)) continue;
          const nx = (z1 - z0) / L, nz = -(x1 - x0) / L; // outward of the tile = towards the other region
          if (!failed.has(this.regionOf((x0 + x1) / 2 + nx * 1.5, (z0 + z1) / 2 + nz * 1.5))) continue;
          let g = byReg.get(tile.k);
          if (!g) byReg.set(tile.k, (g = new Geo(256)));
          const m = Math.max(1, Math.ceil(L / 6));
          for (let j = 0; j <= m; j++) {
            const t = j / m;
            const cx = x0 + (x1 - x0) * t - nx * (C + 0.05), cz = z0 + (z1 - z0) * t - nz * (C + 0.05);
            const ya = Math.max(pr.y0, this.base - 0.5), yb = pr.y1;
            // four side faces of a square column (each face: quad seen from outside)
            for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const fx = cx + ox * C, fz = cz + oz * C, tx = -oz * C, tz = ox * C;
              const b = g.nv;
              g.vtx(fx - tx, ya, fz - tz, ox, 0, oz, col, 0, 0, this.style, 3);
              g.vtx(fx - tx, yb, fz - tz, ox, 0, oz, col, 0, 0, this.style, 3);
              g.vtx(fx + tx, yb, fz + tz, ox, 0, oz, col, 0, 0, this.style, 3);
              g.vtx(fx + tx, ya, fz + tz, ox, 0, oz, col, 0, 0, this.style, 3);
              g.quad(b, 1);
            }
          }
        }
      }
    }
    for (const [reg, g] of byReg) if (g.ni) this._part(g, -2, reg);
  }

  _openCut(b, reg) {
    const part = this.activateCell(b, reg);
    if (!part) return;
    let changed = false;
    for (const p of part.panels) {
      if (p.out) continue;
      for (const [dc, j] of [[-1, p.jl], [1, p.jr]]) {
        const E = this.edges[p.e];
        const c = p.c + dc;
        if (c >= 0 && c < E.colRegion.length && this.rec.failed.has(E.colRegion[c])) { this._restore(part, j, 6); changed = true; }
      }
    }
    if (changed) this.flush();
  }

  // ---------- blocks for collapses ----------
  _clipEdge(E, R) {
    const eps = 0.06;
    let t0 = 0, t1 = 1;
    const pu = E.au, du = E.bu - E.au, pv = E.av, dv = E.bv - E.av;
    const tests = [[-du, pu - (R.uA - eps)], [du, R.uB + eps - pu], [-dv, pv - (R.vA - eps)], [dv, R.vB + eps - pv]];
    for (const [p, q] of tests) {
      if (Math.abs(p) < 1e-9) { if (q < 0) return null; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return t1 - t0 > 1e-3 ? [t0, t1] : null;
  }

  /**
   * Geometry of the part of the building inside frame rect R and heights [yA, yB], in the local frame of a box body.
   * Returns { geometry, pos {x,y,z}, quat {x,y,z,w}, half {x,y,z}, col [r,g,b] linear, vol } or null.
   */
  blockGeometry(R, yA, yB) {
    const g = new Geo(256);
    let col = null;
    const regs = new Set();
    for (let k = 0; k < this.nRegions; k++) {
      const Q = this.regionRect(k);
      if (Q.uB > R.uA + 0.05 && Q.uA < R.uB - 0.05 && Q.vB > R.vA + 0.05 && Q.vA < R.vB - 0.05) regs.add(k);
    }
    for (const E of this.edges) {
      const tt = this._clipEdge(E, R);
      if (!tt) continue;
      const ya = Math.max(yA, E.y0), yb = Math.min(yB, E.y1);
      if (yb - ya < 0.3) continue;
      if (!col) col = E.col;
      this._outer(g, E, tt[0], tt[1], ya, yb, E.col, 0);
      this._inner(g, E, tt[0], tt[1], ya, yb, 0, 0, 0);
      this._jamb(g, E, tt[0], ya, yb, -1, E.jc);
      this._jamb(g, E, tt[1], ya, yb, 1, E.jc);
    }
    for (const pr of this.prisms) {
      if (pr.y1 < yA || pr.y0 > yB) continue;
      const uv = pr.poly.map(([x, z]) => this.toUV(x, z));
      const cl = clipRect(uv, R.uA - 0.02, R.uB + 0.02, R.vA - 0.02, R.vB + 0.02);
      if (cl.length < 3) continue;
      let pts = cl.map(([u, v]) => this.toXZ(u, v));
      if (area2(pts) < 0) pts = pts.reverse();
      const tile = { pts, tris: triangulate(pts) };
      if (!tile.tris.length) continue;
      for (let y = firstLine(pr.y0, pr.vb, pr.fh); y < pr.y1 - 0.6; y += pr.fh) if (y > yA + 0.2 && y <= yB + 0.05) this._slab(g, tile, y);
      if (yA > pr.y0 + 0.5 && yA > pr.vb + 0.5) this._slab(g, tile, yA + SLAB, { top: false });
      if (pr.y1 >= yA && pr.y1 <= yB + 0.05) this._slab(g, tile, pr.y1, { bottom: true, sides: false, topCol: pr.roofCol, kindTop: pr.hasRoof ? 1 : 3, style: pr.style });
    }
    // roofs, gables, crowns, neon bands of the covered regions (already cut along the region grid)
    const M = this.misc, MV = M.v;
    for (let t = 0; t < M.region.length; t++) {
      if (!regs.has(M.region[t])) continue;
      const o = t * 48;
      const my = (MV[o + 1] + MV[o + 17] + MV[o + 33]) / 3;
      if (my < yA || my > yB + 0.5) continue;
      const [mu, mv] = this.toUV((MV[o] + MV[o + 16] + MV[o + 32]) / 3, (MV[o + 2] + MV[o + 18] + MV[o + 34]) / 3);
      if (mu < R.uA - 0.3 || mu > R.uB + 0.3 || mv < R.vA - 0.3 || mv > R.vB + 0.3) continue;
      const a = g.vtxRec(MV, o), b = g.vtxRec(MV, o + 16), c = g.vtxRec(MV, o + 32);
      g.tri(a, b, c, 0);
    }
    if (!g.ni) return null;
    // local frame: x = u, y = up, z = v, centred on the AABB of the geometry
    const f = this.fr, nv = g.nv, p = g.p, n = g.n;
    let lu0 = Infinity, lu1 = -Infinity, ly0 = Infinity, ly1 = -Infinity, lv0 = Infinity, lv1 = -Infinity;
    for (let i = 0; i < nv * 3; i += 3) {
      const u = (p[i] - f.cx) * f.ux + (p[i + 2] - f.cz) * f.uz, v = (p[i] - f.cx) * f.vx + (p[i + 2] - f.cz) * f.vz;
      lu0 = Math.min(lu0, u); lu1 = Math.max(lu1, u); lv0 = Math.min(lv0, v); lv1 = Math.max(lv1, v);
      ly0 = Math.min(ly0, p[i + 1]); ly1 = Math.max(ly1, p[i + 1]);
    }
    const cu = (lu0 + lu1) / 2, cv = (lv0 + lv1) / 2, cy = (ly0 + ly1) / 2;
    for (let i = 0; i < nv * 3; i += 3) {
      const u = (p[i] - f.cx) * f.ux + (p[i + 2] - f.cz) * f.uz, v = (p[i] - f.cx) * f.vx + (p[i + 2] - f.cz) * f.vz;
      p[i] = u - cu; p[i + 1] -= cy; p[i + 2] = v - cv;
      const nx = n[i], nz = n[i + 2];
      n[i] = nx * f.ux + nz * f.uz; n[i + 2] = nx * f.vx + nz * f.vz;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p.slice(0, nv * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(n.slice(0, nv * 3), 3));
    const ca = g.c.slice(0, nv * 3);
    if (this.rec.tint !== 1) for (let i = 0; i < ca.length; i++) ca[i] *= this.rec.tint;
    geo.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    geo.setAttribute('aFacade', new THREE.BufferAttribute(g.f.slice(0, nv * 4), 4));
    geo.setAttribute('aNeon', new THREE.BufferAttribute(g.e.slice(0, nv * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(g.i.slice(0, g.ni), 1));
    geo.computeBoundingSphere();
    const [wx, wz] = this.toXZ(cu, cv);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(f.ux, 0, f.uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(f.vx, 0, f.vz));
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const half = { x: Math.max(0.3, (lu1 - lu0) / 2 - 0.12), y: Math.max(0.3, (ly1 - ly0) / 2 - 0.08), z: Math.max(0.3, (lv1 - lv0) / 2 - 0.12) };
    return { geometry: geo, pos: { x: wx, y: cy, z: wz }, quat: { x: q.x, y: q.y, z: q.z, w: q.w }, half, col: col || [0.6, 0.58, 0.55], vol: 8 * half.x * half.y * half.z };
  }

  /** Rect (frame coords) of region k, or of the whole building. */
  rect(k = -1) {
    if (k >= 0) return this.regionRect(k);
    const f = this.fr;
    return { uA: f.u0, uB: f.u1, vA: f.v0, vB: f.v1 };
  }

  // ---------- colliders ----------
  _collider(part) {
    const { RAPIER, world } = this.game;
    const ia = part.idx, ph = part.phys;
    const nt = ia.length / 3;
    const out = new Uint32Array(ia.length);
    let n = 0;
    for (let t = 0; t < nt; t++) {
      if (!ph[t]) continue;
      const a = ia[t * 3], b = ia[t * 3 + 1];
      if (a === b) continue;
      out[n++] = a; out[n++] = b; out[n++] = ia[t * 3 + 2];
    }
    if (!n) return null;
    const desc = RAPIER.ColliderDesc.trimesh(part.geo.attributes.position.array, out.slice(0, n))
      .setFriction(0.6).setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(15000)
      .setCollisionGroups(this.F.staticGroups);
    const c = world.createCollider(desc);
    c.userData = { building: this.id, frac: true };
    return c;
  }

  ensureColliders(on) {
    const world = this.game.world;
    this.colliding = on;
    for (const part of this.parts) {
      if (on && part.pending) continue; // rebuild already queued (spread over frames)
      if (!on || part.colDirty === true) {
        if (part.collider) { try { world.removeCollider(part.collider, false); } catch { /* gone */ } part.collider = null; }
      }
      if (on && !part.collider && part.colDirty !== 'none') {
        part.collider = this._collider(part);
        part.colDirty = part.collider ? false : 'none';
      }
    }
  }

  // ---------- look ----------
  _tintPart(part, k) {
    const a = part.geo.attributes.color;
    for (let i = 0; i < a.array.length; i++) a.array[i] = part.col0[i] * k;
    fullUpload(a);
  }

  tint(k) {
    this.rec.tint = k;
    for (const part of this.parts) this._tintPart(part, k);
  }

  dispose(restore = false) {
    if (this.disposed) return;
    this.disposed = true;
    this.ensureColliders(false);
    for (const part of this.parts) { part.mesh.removeFromParent(); part.geo.dispose(); }
    this.parts.length = 0;
    this.cells.clear();
    const r = this.r;
    if (restore && !r.removed) {
      const g0 = this.B.buckets.get(r.key).mesh.geometry.index;
      g0.array.set(this.idxBackup, r.iStart);
      g0.addUpdateRange(r.iStart, r.iEnd - r.iStart);
      g0.needsUpdate = true;
      r.frac = null;
    }
    this.F.map.delete(this.id);
  }

  get damaged() { return this.rec.failed.size > 0 || this.rec.out.size > 4; }

  // legacy shape: code that predates `external` (r.frac.mesh / r.frac.panels) must never throw on this object
  get mesh() { return this.basePart?.mesh ?? EMPTY_MESH; }
  get panels() { return NO_PANELS; }
}
const EMPTY_MESH = new THREE.Mesh(new THREE.BufferGeometry().setIndex([]));
const NO_PANELS = Object.freeze([]);

// ---------- manager ----------

export class Fracturer {
  constructor(game) {
    this.game = game;
    this.map = new Map();
    this.records = new Map();
    this.jobs = [];
    this.staticGroups = groups(GROUPS.STATIC, 0xffff);
    this.broken = new Set(); // ids whose capture failed (left to the legacy path)
    this.evicted = new Set();
    this._t = 0;
    this._mat = null;
    this.prep = new FracturePrep(this);
    this.stats = { fractured: 0, lastMs: 0, maxMs: 0, cells: 0, evicted: 0, rebuilt: 0, jobMs: 0, maxJobMs: 0 };
  }

  record(id) {
    let r = this.records.get(id);
    if (!r) this.records.set(id, (r = { out: new Set(), glass: new Set(), dmg: new Map(), failed: new Set(), tint: 1 }));
    return r;
  }

  /** The fractured building `id` (built on demand), or null. */
  get(id, create = true) {
    const f = this.map.get(id);
    if (f || !create) return f || null;
    const B = this.game.buildings;
    const r = B?.recs?.[id];
    if (!r || r.removed || this.broken.has(id) || !B.addBuilding) return null;
    if (r.frac && !r.frac.external) return null;
    const t0 = performance.now();
    let fb;
    if (this.prep.waiting(id)) return null;
    const prepared = this.prep.take(id);
    try { fb = new FracturedBuilding(this, id, prepared); } catch (e) {
      console.warn('[destruction] fracture failed', id, e);
      this.broken.add(id);
      return null;
    }
    this.map.set(id, fb);
    this.evicted.delete(id);
    const ms = performance.now() - t0;
    this.stats.fractured++;
    this.stats.lastMs = ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    const pf = this.game.player?.focus;
    if (pf) fb.ensureColliders(Math.hypot(r.cx - pf.x, r.cz - pf.z) < STREAM_R);
    this._evict();
    return fb;
  }

  /** Deferred work (cell activations, blasts), run within a per-frame budget. */
  queue(fn, tag = null, delay = 0) { this.jobs.push({ fn, tag, t: (this.game.time ?? 0) + delay }); }

  /** Facade material: the city building material + shattered-window look (aNeon.x < 0). Compiled at prewarm. */
  material() {
    if (this._mat) return this._mat;
    const base = this.game.buildings.material;
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: base.roughness, metalness: base.metalness, flatShading: true });
    let warned = false;
    m.onBeforeCompile = function (sh, renderer) {
      base.onBeforeCompile.call(this, sh, renderer);
      const fs = sh.fragmentShader
        .replace('float gGlass = 0.0;', 'float gGlass = 0.0; float gBrk = 0.0;')
        .replace('diffuseColor.rgb = mix(diffuseColor.rgb, gcol, w);', `
          if (vNeon.x < -0.5) {
            // shattered pane: dark room behind, jagged shards left in the frame
            vec2 wq = (f - r.xz) / max(r.yw - r.xz, vec2(1e-3));
            float ed = min(min(wq.x, 1.0 - wq.x), min(wq.y, 1.0 - wq.y));
            float ang = atan(wq.y - 0.5, wq.x - 0.5);
            float jag = 0.04 + 0.2 * hash12(vec2(floor(ang * 2.6 + h * 17.0), cell.x * 3.1 + cell.y * 7.7)) * (0.6 + 0.4 * step(wq.y, 0.2));
            float shard = 1.0 - smoothstep(jag - 0.015, jag + 0.015, ed);
            shard = mix(shard, 0.25, farAll);
            vec3 room = mix(vec3(0.03, 0.027, 0.024), vec3(0.012, 0.011, 0.01), wq.y);
            gcol = mix(room, gcol * 1.15, shard);
            gBrk = 1.0 - shard;
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, gcol, w);
          if (vNeon.y > 0.02 && farAll < 0.99) {
            // cracked wall: cellular crack network on the facade, more cells crack as the panel takes damage
            vec2 cp = vec2(fu * 0.9, fv * 0.75);
            vec2 ci = floor(cp), cf = fract(cp);
            float d1 = 8.0, d2 = 8.0; vec2 c1 = ci;
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
              vec2 o = vec2(float(i), float(j));
              vec2 hp = vec2(hash12(ci + o + 0.37), hash12(ci + o + 17.3));
              float dd = length(o + hp - cf);
              if (dd < d1) { d2 = d1; d1 = dd; c1 = ci + o; } else if (dd < d2) d2 = dd;
            }
            float on = step(hash12(c1 * 1.31 + 5.7), vNeon.y * 1.15);
            float wid = 0.025 + 0.03 * vNeon.y;
            float crk = (1.0 - smoothstep(wid * 0.5, wid, d2 - d1)) * on * (1.0 - farAll);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.04, 0.035), crk * (0.9 - 0.4 * w));
            diffuseColor.rgb *= 1.0 - 0.12 * vNeon.y * (1.0 - w);
          }`)
        .replace('gGlass = w;', 'gGlass = w * (1.0 - gBrk);')
        .replace('totalEmissiveRadiance += gEmit;', 'totalEmissiveRadiance += gEmit * (1.0 - 0.55 * gBrk);');
      const ok = fs.includes('float gBrk = 0.0;') && fs.includes('gBrk = 1.0 - shard') && fs.includes('w * (1.0 - gBrk)');
      if (ok) sh.fragmentShader = fs;
      else if (!warned) { warned = true; console.warn('[destruction] building shader changed: shattered windows fall back to plain glass'); }
    };
    const key = base.customProgramCacheKey?.bind(base);
    m.customProgramCacheKey = () => `${key ? key() : 'bld'}|frac2`;
    this._mat = m;
    return m;
  }

  prewarmObjects() {
    if (!this.game.buildings?.material) return [];
    const g = new THREE.BoxGeometry(0.1, 0.1, 0.1).toNonIndexed();
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('aNeon', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    const m = new THREE.Mesh(g, this.material());
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;
    return [m];
  }

  update(dt) {
    const game = this.game;
    const now = game.time ?? 0;
    this.prep.update(dt);
    // deferred jobs within budget
    const t0 = performance.now();
    for (let i = 0; i < this.jobs.length;) {
      const j = this.jobs[i];
      if (j.t > now) { i++; continue; }
      this.jobs.splice(i, 1);
      const s = performance.now();
      try { j.fn(); } catch (e) { console.warn('[destruction] job', e); }
      const ms = performance.now() - s;
      this.stats.jobMs = ms;
      this.stats.maxJobMs = Math.max(this.stats.maxJobMs, ms);
      if (performance.now() - t0 > 1.2) break;
    }
    // collider streaming + rebuild on return (~3 Hz)
    this._t -= dt;
    if (this._t > 0) return;
    this._t = 0.3;
    const pf = game.player?.focus || game.camera.position;
    for (const fb of this.map.values()) fb.ensureColliders(Math.hypot(fb.r.cx - pf.x, fb.r.cz - pf.z) < STREAM_R);
    for (const id of this.evicted) {
      const r = game.buildings.recs[id];
      if (!r || r.removed) { this.evicted.delete(id); continue; }
      if (Math.hypot(r.cx - pf.x, r.cz - pf.z) < 260) {
        this.evicted.delete(id);
        this.queue(() => { if (this.get(id)) this.stats.rebuilt++; }, id);
      }
    }
  }

  // keep the number of fractured buildings bounded: far, lightly damaged ones go back to the merged mesh
  _evict() {
    if (this.map.size <= MAX_FRACTURED) return;
    const cam = this.game.camera.position;
    let worst = null, wd = 0;
    for (const fb of this.map.values()) {
      if (fb.damaged) continue;
      const d = Math.hypot(fb.r.cx - cam.x, fb.r.cz - cam.z);
      if (d > 300 && d > wd) { wd = d; worst = fb; }
    }
    if (!worst) return;
    const id = worst.id;
    worst.dispose(true);
    this.evicted.add(id);
    this.stats.evicted++;
  }

  clear() {
    this.prep.dispose();
    for (const fb of [...this.map.values()]) fb.dispose(true);
    this.jobs.length = 0;
  }
}
