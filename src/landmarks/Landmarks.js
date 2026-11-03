import * as THREE from 'three';
import { Builder, rgb, inside } from './kit.js';
import { solidMaterial, signMaterial, lightsMaterial, beamMaterial, SPIN_UNIFORMS, MAX_SPIN, LOD_UNIFORMS, MAX_CLUSTERS } from './materials.js';
import { SignAtlas } from './atlas.js';
import { LightList, BeamList } from './lights.js';
import { ColliderField } from './colliders.js';
import { RunwayMesh, runwaySurface, drawnRunways } from './sites/runways.js';
import { hiddenEdges, stripRunways } from './airside.js';
import { grassInfield } from './sites/infield.js';
import { runwayMaterial, vehicleMaterial } from './materials.js';
import { vehicleModel, VEHICLE_BAKE_MS, bakeVehicleArrays, vehicleGeometry } from './vehicles.js';
import { auditPlacements } from './audit.js';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
// footprint sample points (unit rectangle): centre, corners, edge midpoints
const SPOT_PTS = [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1], [0.5, 1], [-0.5, 1], [0.5, -1], [-0.5, -1]];

// Landmarks & airports (workstream M). Procedural low-poly models generated at load from site definitions
// (sites/*.js). Geometry is merged per cluster and material (near detail + far silhouette meshes, switched by
// camera distance); lights are one Points draw call, beams one mesh, aircraft one InstancedMesh per type.
export class Landmarks {
  // defer: the caller drives buildSteps() itself (createLandmarksAsync: a few sites per frame during loading)
  constructor(game, { sites = [], log = true, prewarm = false, defer = false } = {}) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'landmarks';
    game.scene.add(this.root);
    this.mat = {
      solid: solidMaterial(),
      paint: solidMaterial({ polygonOffset: true }),
      lights: lightsMaterial(),
      beams: beamMaterial(),
    };
    this.atlas = new SignAtlas();
    this.lights = new LightList();
    this.beams = new BeamList();
    this.colliders = new ColliderField(game);
    this.runwayMesh = new RunwayMesh();
    this.runwayDecks = []; // drawn runway pavements (frame + station heights), see deckAt()
    this.warned = new Set();
    this.vehicles = []; // parked real models (catalog cars / trucks, planes, helicopters, boats), one BatchedMesh
    this.mapExtras = []; // map features of special sites (blimp pad...), exported by tools/landmark_geom.mjs
    this.infields = []; // grass infield requests (airports), applied in finalize() once every structure is placed
    this.hidden = game.roads ? hiddenEdges(game.roads) : new Set(); // road edges without a drawn ribbon
    this.clusters = new Map();
    this.sites = [];
    this.instTypes = new Map();
    this.dynamic = [];
    this.removed = new Set();
    this.spinners = 0;
    this.hiddenTrees = 0;
    this.timing = {};
    const q = game.quality || {};
    this.distScale = q.drawDistance ?? 1;
    this.steps = this.buildSteps(sites, { log, prewarm });
    if (!defer) for (const _ of this.steps); // eslint-disable-line no-unused-vars
  }

  // the whole build, yielding between sites and finalize phases (the main-thread time is timing.total; wall-clock
  // time with the frames in between is timing.wall)
  *buildSteps(sites, { log, prewarm }) {
    const game = this.game;
    let t0 = performance.now(), busy = 0, maxStep = 0;
    const tw = t0;
    const pause = () => { const d = performance.now() - t0; busy += d; if (d > maxStep) maxStep = d; };
    const resume = () => { t0 = performance.now(); };
    for (const def of sites) {
      let ts = performance.now(), ms = 0;
      try {
        for (const _ of this.buildSiteSteps(def)) { ms += performance.now() - ts; pause(); yield; resume(); ts = performance.now(); } // eslint-disable-line no-unused-vars
      } catch (e) { console.warn('[landmarks] site failed', def.id, e); }
      this.timing[def.id] = +(ms + performance.now() - ts).toFixed(1);
      pause(); yield; resume();
    }
    // the Roads hooks hide every runway / airstrip ribbon: one whose airport site was not built (labs with
    // `only`) still gets its plain pavement here
    if (game.roads) {
      for (const rw of (game.roads.runways || []).concat(stripRunways(game.roads))) {
        const covered = [0.1, 0.5, 0.9].every((f) => this.deckAt(rw.x0 + (rw.x1 - rw.x0) * f, rw.z0 + (rw.z1 - rw.z0) * f) != null);
        if (covered) continue;
        try {
          this.buildSite({ id: `runway-${Math.round(rw.cx)}-${Math.round(rw.cz)}`, name: 'Runway', kind: 'runway', x: rw.cx, z: rw.cz, near: 900, build: (ctx) => { runwaySurface(ctx, rw.strip ? rw : drawnRunways(ctx, [rw])[0], { pads: !rw.strip }); } }); // whole hidden runway, as the airport site draws it
        } catch (e) { console.warn('[landmarks] runway fallback failed', e); }
      }
    }
    pause(); yield; resume();
    let tf = performance.now(), fin = 0;
    for (const _ of this.finalize()) { fin += performance.now() - tf; pause(); yield; resume(); tf = performance.now(); } // eslint-disable-line no-unused-vars
    fin += performance.now() - tf;
    this.timing.finalize = +fin.toFixed(1);
    this.refresh(0, true);
    this.colliders.update(0, true);
    pause();
    this.timing.total = +busy.toFixed(1);
    this.timing.wall = +(performance.now() - tw).toFixed(1);
    this.timing.maxStep = +maxStep.toFixed(1); // longest uninterrupted piece
    this.stats = this.computeStats();
    if (prewarm) this.prewarm();
    if (log) console.info('[landmarks] built', this.stats.sites, 'sites in', this.timing.total, 'ms', this.stats);
  }

  // ---------- building ----------
  cluster(key, { near = 750 } = {}) {
    let c = this.clusters.get(key);
    if (!c) {
      const b = new Builder();
      b.colliders = this.colliders;
      c = {
        key, b, nearDist: near,
        sign: new Builder({ uv: true, far: false }),
        gsign: new Builder({ uv: true, far: false }),
        paint: new Builder({ far: false }),
        meshes: {}, isNear: false, box: null,
      };
      this.clusters.set(key, c);
    }
    c.nearDist = Math.max(c.nearDist, near);
    return c;
  }

  buildSite(def) {
    const it = this.buildSiteSteps(def);
    let r;
    while (!(r = it.next()).done);
    return r.value;
  }

  // a site's build may be a generator (function*): each `yield` lets the sliced build hand back the frame
  *buildSiteSteps(def) {
    const g = this.game;
    const c = this.cluster(def.cluster || def.id, { near: def.near || 750 });
    for (const bb of [c.b, c.sign, c.gsign, c.paint]) { bb.colTag = def.id; bb.m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]; bb.yaw = 0; bb.stack.length = 0; bb.lod = 0; }
    const site = { id: def.id, name: def.name, kind: def.kind, x: def.x, z: def.z, views: [], removed: 0, cluster: c.key, laps: {} };
    let lapT = performance.now();
    const ctx = {
      game: g, L: this, site, def, cluster: c,
      terrain: g.terrain, roads: g.roads, buildings: g.buildings,
      b: c.b, sign: c.sign, gsign: c.gsign, paint: c.paint,
      atlas: this.atlas, lights: this.lights, beams: this.beams, colliders: this.colliders,
      groundY: (x, z) => g.terrain.heightAt(x, z),
      remove: (opts) => { const n = this.removeBuildings(opts); site.removed += n; return n; },
      hideTrees: (opts) => this.hideTrees(opts),
      instance: (type, x, y, z, yaw, color, s) => this.addInstance(type, c, x, y, z, yaw, color, s),
      // parked real model ('car:<id>', 'police:<id>', 'plane:<id>', 'heli:<id>', 'boat:<id>'), forward = -Z
      // after yaw; returns the model ({len, wid, h, ...}) or null
      vehicle: (key, x, z, yaw, o) => this.addVehicle(key, c, def.id, x, z, yaw, o),
      // same, only when the footprint is clear of roads, buildings, structures and other vehicles (null if not)
      park: (key, x, z, yaw, o) => this.park(key, c, def.id, x, z, yaw, o),
      spotFree: (x, z, yaw, hx, hz, o) => this.spotFree(x, z, yaw, hx, hz, o),
      vehicleModel: (key) => this.model(key),
      dynamic: (obj) => { obj.cluster = c; this.dynamic.push(obj); return obj; },
      view: (pos, look, label = '') => site.views.push({ pos, look, label }),
      // view framing world points [[x, z], ...] (default: the parked models this site placed so far, optionally
      // only those whose key matches `only`), seen from direction `from` ([dx, dz], default: away from the site)
      frameView: (pts, label = '', { from = null, only = null, k = 2.4, min = 24, elev = 0.62 } = {}) => {
        if (!pts) pts = this.vehicles.filter((v) => v.tag === def.id && (!only || only.test(v.m.key))).map((v) => [v.x, v.z, v.y + v.m.h / 2]);
        if (!pts.length) return false;
        let cx = 0, cz = 0, cy = 0;
        for (const p of pts) { cx += p[0]; cz += p[1]; cy += p[2] ?? g.terrain.heightAt(p[0], p[1]); }
        cx /= pts.length; cz /= pts.length; cy /= pts.length;
        let r = 0;
        for (const p of pts) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cz));
        let [dx, dz] = from || [cx - def.x, cz - def.z];
        const dl = Math.hypot(dx, dz);
        if (dl < 1) { dx = 0.7; dz = 0.7; } else { dx /= dl; dz /= dl; }
        const D = Math.max(min, r * k + 10);
        site.views.push({ pos: [cx + dx * D, cy + D * elev, cz + dz * D], look: [cx, cy, cz], label });
        return true;
      },
      lap: (label) => { const t = performance.now(); site.laps[label] = +(t - lapT).toFixed(1); lapT = t; },
      spot: (x, z, r, o) => this.findSpot(x, z, r, o),
      // original footprints (not yet removed) with centroid within r of (x,z): [{id, poly, area, rec}] largest first
      footprints: (x, z, r, minArea = 0) => this.footprints(x, z, r, minArea),
      // rotating part: world pivot, unit axis, speed rad/s -> index for Builder.spinIdx (-1 when full)
      spinner: (x, y, z, axis = [0, 1, 0], speed = 1, phase = 0) => {
        if (this.spinners >= MAX_SPIN) return -1;
        const i = this.spinners++;
        SPIN_UNIFORMS.uSpin.value[i].set(x, y, z, speed);
        const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
        SPIN_UNIFORMS.uSpinAxis.value[i].set(axis[0] / l, axis[1] / l, axis[2] / l, phase);
        return i;
      },
      clearOfRoads: (x, z, r) => this.roadHit(x, z, r) < 0,
      dryDisc: (x, z, r, h) => this.dryDisc(x, z, r, h),
      dryRect: (x, z, yaw, hx, hz, h) => this.dryRect(x, z, yaw, hx, hz, h),
      dryPoly: (poly, h) => this.dryPoly(poly, h),
      roadHit: (x, z, r, skip) => this.roadHit(x, z, r, skip),
      roadTop: (x, z, r) => this.roadTop(x, z, r),
      // grass infield around these runways (see sites/infield.js); applied after all sites are built
      infield: (runways, opts = {}) => this.infields.push({ runways, opts: { ...opts, cluster: c }, site: site.id }),
    };
    let res = def.build(ctx, def);
    if (res && typeof res.next === 'function') {
      let r;
      while (!(r = res.next()).done) yield;
      res = r.value;
    }
    if (res && typeof res === 'object') Object.assign(site, res);
    this.sites.push(site);
    return site;
  }

  footprints(x, z, r, minArea = 0) {
    const B = this.game.buildings;
    if (!B?.query) return [];
    const out = [];
    for (const id of B.query(x, z, r)) {
      const rec = B.recs[id];
      if (!rec || rec.removed) continue;
      const p = B.list[id].p, poly = [];
      for (let i = 0; i < p.length; i += 2) poly.push([p[i], p[i + 1]]);
      const area = footArea(p);
      // only footprints standing fully on land: a landmark never replaces a building that is in the sea
      if (area >= minArea && this.dryPoly(poly, 0.15)) out.push({ id, poly, area, rec });
    }
    return out.sort((a, b) => b.area - a.area);
  }

  // true when no road surface comes within r of (x,z). Allocation-free scan of the roads' own segment grid
  // (Roads.grid: 64 m cells -> [edgeIndex, segment, ...]); thousands of calls per airport.
  clearOfRoads(x, z, r) { return this.roadHit(x, z, r) < 0; }

  // index of a road edge whose surface comes within r of (x,z) (ignoring edge `skip`), or -1
  roadHit(x, z, r, skip = -1) {
    const roads = this.game.roads;
    const grid = roads?.grid;
    if (!grid) return -1;
    const c = roads.cell || 64, E = roads.edges;
    const R = r + 23;
    for (let ci = Math.floor((x - R) / c), c1 = Math.floor((x + R) / c); ci <= c1; ci++) {
      for (let cj = Math.floor((z - R) / c), cj1 = Math.floor((z + R) / c); cj <= cj1; cj++) {
        const l = grid.get(ci * 100003 + cj);
        if (!l) continue;
        for (let i = 0; i < l.length; i += 2) {
          const ei = l[i];
          if (ei === skip || this.hidden.has(ei)) continue;
          const e = E[ei], k = l[i + 1], P = e.pts;
          const ax = P[2 * k], az = P[2 * k + 1], bx = P[2 * k + 2], bz = P[2 * k + 3];
          const hw = (e.wp ? Math.max(e.wp[k], e.wp[k + 1]) : e.w) / 2 + r;
          // quick reject on the segment bbox
          if (x < Math.min(ax, bx) - hw || x > Math.max(ax, bx) + hw || z < Math.min(az, bz) - hw || z > Math.max(az, bz) + hw) continue;
          const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
          let t = ((x - ax) * dx + (z - az) * dz) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t - x, pz = az + dz * t - z;
          if (px * px + pz * pz < hw * hw) return ei;
        }
      }
    }
    return -1;
  }

  // height of the drawn runway pavement (incl. shoulders and blast pads) at (x,z), highest if several, else null
  deckAt(x, z) {
    let best = null;
    for (const d of this.runwayDecks) {
      const u = (x - d.x0) * d.dx + (z - d.z0) * d.dz, v = (x - d.x0) * -d.dz + (z - d.z0) * d.dx;
      const S = d.S, Y = d.Y, n = S.length;
      if (u < S[0] || u > S[n - 1] || Math.abs(v) > d.ow) continue;
      let i = 0;
      while (i < n - 2 && u > S[i + 1]) i++;
      const f = (u - S[i]) / (S[i + 1] - S[i] || 1);
      const B = d.B, bank = B ? B[i] + (B[i + 1] - B[i]) * f : 0; // cross slope (m per m, + = rises to the right)
      const y = Y[i] + (Y[i + 1] - Y[i]) * f + bank * v;
      if (best === null || y > best) best = y;
    }
    return best;
  }

  // highest road surface (centreline height) of any edge whose ribbon comes within r of (x,z), or -Infinity.
  // Same allocation-free grid scan as roadHit; used to keep runway pavement above taxiway ribbons and caps.
  roadTop(x, z, r) {
    const roads = this.game.roads;
    const grid = roads?.grid;
    if (!grid) return -Infinity;
    const c = roads.cell || 64, E = roads.edges;
    const R = r + 23;
    let top = -Infinity;
    for (let ci = Math.floor((x - R) / c), c1 = Math.floor((x + R) / c); ci <= c1; ci++) {
      for (let cj = Math.floor((z - R) / c), cj1 = Math.floor((z + R) / c); cj <= cj1; cj++) {
        const l = grid.get(ci * 100003 + cj);
        if (!l) continue;
        for (let i = 0; i < l.length; i += 2) {
          if (this.hidden.has(l[i])) continue;
          const e = E[l[i]], k = l[i + 1], P = e.pts;
          const ax = P[2 * k], az = P[2 * k + 1], bx = P[2 * k + 2], bz = P[2 * k + 3];
          const hw = (e.wp ? Math.max(e.wp[k], e.wp[k + 1]) : e.w) / 2 + r;
          if (x < Math.min(ax, bx) - hw || x > Math.max(ax, bx) + hw || z < Math.min(az, bz) - hw || z > Math.max(az, bz) + hw) continue;
          const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
          let t = ((x - ax) * dx + (z - az) * dz) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t - x, pz = az + dz * t - z;
          if (px * px + pz * pz >= hw * hw) continue;
          const y = e.y[k] + (e.y[k + 1] - e.y[k]) * t;
          if (y > top) top = y;
        }
      }
    }
    return top;
  }

  // nearest spot to (x,z) (spiral search) with no road within r and (optionally) dry land / open water
  // nearest spot to (x,z) (spiral search) for an object of radius r: no road within r and (optionally) the whole
  // disc on dry land (centre + two rings of samples) or in open water. Returns [x, z]; `null` when nothing fits
  // and strict is set, else the start point.
  findSpot(x, z, r, { land = true, water = false, maxR = 160, step = 6, dryR = r, strict = false } = {}) {
    const ok = (px, pz) => {
      if (land && !this.dryDisc(px, pz, dryR)) return false;
      if (water && this.game.terrain.heightAt(px, pz) > -1.5) return false;
      return this.clearOfRoads(px, pz, r);
    };
    if (ok(x, z)) return [x, z];
    for (let rr = step; rr <= maxR; rr += step) {
      const n = Math.max(8, Math.round((2 * Math.PI * rr) / step));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
        if (ok(px, pz)) return [px, pz];
      }
    }
    return strict ? null : [x, z];
  }

  // whole disc of radius r on dry land (no part of a land structure may stand in the sea)
  dryDisc(x, z, r, minH = 0.3) {
    const t = this.game.terrain;
    if (t.heightAt(x, z) < minH) return false;
    for (const k of [0.55, 1]) for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (t.heightAt(x + Math.cos(a) * r * k, z + Math.sin(a) * r * k) < minH) return false;
    }
    return true;
  }

  // oriented rectangle (centre, yaw as Builder.rotY, half sizes along local x / z) entirely on dry land
  dryRect(x, z, yaw, hx, hz, minH = 0.3) {
    const t = this.game.terrain, c = Math.cos(yaw), s = Math.sin(yaw);
    const nx = Math.max(1, Math.ceil(hx / 6)), nz = Math.max(1, Math.ceil(hz / 6));
    for (let i = -nx; i <= nx; i++) for (let j = -nz; j <= nz; j++) {
      const lx = (i / nx) * hx, lz = (j / nz) * hz;
      if (t.heightAt(x + c * lx + s * lz, z - s * lx + c * lz) < minH) return false;
    }
    return true;
  }

  // footprint polygon on dry land (vertices + centroid)
  dryPoly(poly, minH = 0.3) {
    const t = this.game.terrain;
    let cx = 0, cz = 0;
    for (const [x, z] of poly) { if (t.heightAt(x, z) < minH) return false; cx += x; cz += z; }
    return t.heightAt(cx / poly.length, cz / poly.length) >= minH;
  }

  // remove original footprints: circle [x,z,r] (centroid inside), poly [[x,z]...] (centroid inside), ids
  removeBuildings({ circle = null, poly = null, ids = null, filter = null, minArea = 0 } = {}) {
    const B = this.game.buildings;
    if (!B?.recs) return 0;
    let n = 0;
    const kill = (id) => {
      const r = B.recs[id];
      if (!r || r.removed || this.removed.has(id)) return;
      if (filter && !filter(r, id)) return;
      if (minArea > 0 && footArea(B.list[id].p) < minArea) return;
      if (B.remove(id)) { this.removed.add(id); n++; }
    };
    if (ids) ids.forEach(kill);
    if (circle) for (const id of B.query(circle[0], circle[1], circle[2])) kill(id);
    if (poly) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.hypot(x1 - x0, z1 - z0) / 2 + 5;
      for (const id of B.query(cx, cz, r)) {
        const rec = B.recs[id];
        if (rec && inside(poly, rec.cx, rec.cz)) kill(id);
      }
    }
    return n;
  }

  // hide vegetation instances inside a circle or polygon (models stand where trees used to be)
  hideTrees({ circle = null, poly = null } = {}) {
    const veg = this.game.veg;
    if (!veg?.query || !veg.scatters) return 0;
    let x, z, r;
    if (circle) [x, z, r] = circle;
    else {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [px, pz] of poly) { x0 = Math.min(x0, px); x1 = Math.max(x1, px); z0 = Math.min(z0, pz); z1 = Math.max(z1, pz); }
      x = (x0 + x1) / 2; z = (z0 + z1) / 2; r = Math.hypot(x1 - x0, z1 - z0) / 2;
    }
    let n = 0;
    for (const t of veg.query(x, z, r)) {
      const sc = veg.scatters[t.type];
      const raw = sc?.raw;
      if (!raw) continue;
      if (poly && !inside(poly, raw[t.id * 6], raw[t.id * 6 + 2])) continue;
      sc.hidden.add(t.id);
      sc._timer = 0;
      n++;
    }
    this.hiddenTrees += n;
    return n;
  }

  // static instanced props (aircraft): type = { key, geometry(), shadow }
  // is an oriented footprint (centre, yaw, half sizes; local +x / +z) clear of road ribbons, building footprints,
  // landmark structures (their colliders) and other parked vehicles, and on dry land?
  spotFree(x, z, yaw, hx, hz, o = {}) {
    const t0 = performance.now();
    const r = this._spotFree(x, z, yaw, hx, hz, o);
    this.spotMs = (this.spotMs || 0) + performance.now() - t0;
    this.spotN = (this.spotN || 0) + 1;
    return r;
  }

  _spotFree(x, z, yaw, hx, hz, { roads = true, structures = true, buildings = true, dry = true, pad = 0.3 } = {}) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const B = this.game.buildings;
    const ids = buildings && B?.query ? B.query(x, z, Math.hypot(hx, hz) + 45) : [];
    for (const [a, b] of SPOT_PTS) {
      const lx = a * (hx + pad), lz = b * (hz + pad);
      const px = x + c * lx + s * lz, pz = z - s * lx + c * lz;
      if (roads && this.roadHit(px, pz, 0.2) >= 0) return false;
      if (structures && this.colliders.blocked(px, pz, 0, ':runway')) return false;
      if (dry && this.game.terrain.heightAt(px, pz) < 0.25) return false;
      for (const id of ids) {
        const p = B.list[id].p;
        let inPoly = false;
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
          const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
          if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inPoly = !inPoly;
        }
        if (inPoly) return false;
      }
    }
    return true;
  }

  // place a vehicle only where its footprint is free (see spotFree); returns the model or null
  disableColliders(range) {
    if (!range) return;
    for (let k = range[0]; k < range[1]; k++) if (this.colliders.items[k]) this.colliders.items[k].off = true;
  }

  // bake the parked models that have no geometry yet: in a module worker (typed arrays transferred), else on
  // the main thread one model per frame; then build the BatchedMesh (buildVehicleMesh)
  bakeVehicles() {
    const todo = [...new Set(this.vehicles.map((v) => v.m))].filter((m) => !m.ready);
    if (!todo.length) { this.buildVehicleMesh(); return; }
    const t0 = performance.now();
    const byKey = new Map(todo.map((m) => [m.key, m]));
    const land = (m, attrs) => {
      m.geo = vehicleGeometry(attrs);
      m.ready = true;
      const n = m.geo.attributes.position.count;
      if (n !== m.verts) { m.verts = n; m.tris = n / 3; this.dimsStale = (this.dimsStale || 0) + 1; }
    };
    const done = () => {
      if (this.disposed) return;
      this.timing['vehicle-bake-wall'] = +(performance.now() - t0).toFixed(1);
      if (this.dimsStale) console.warn(`[landmarks] ${this.dimsStale} parked models differ from vehicle-dims.js; rerun tools/landmark_geom.mjs`);
      this.buildVehicleMesh();
    };
    const later = (f) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(f, 0));
    const fallback = () => { // main thread, one model per frame
      const left = todo.filter((m) => !m.ready);
      const step = () => {
        if (this.disposed) return;
        const m = left.shift();
        if (m) {
          try { land(m, bakeVehicleArrays(m.key).attrs); } catch (e) { this.dropModel(m, e); }
          return later(step);
        }
        done();
      };
      later(step);
    };
    let w;
    try { w = typeof Worker === 'function' ? new Worker(new URL('./vehicleWorker.js', import.meta.url), { type: 'module' }) : null; } catch { w = null; }
    if (!w) { fallback(); return; }
    this.vehicleWorker = w;
    w.onmessage = (ev) => {
      const r = ev.data;
      if (r.done) { w.terminate(); this.vehicleWorker = null; return todo.some((m) => !m.ready) ? fallback() : done(); }
      const m = byKey.get(r.key);
      if (!m) return;
      if (r.error) this.dropModel(m, r.error); else land(m, r.attrs);
    };
    w.onerror = (e) => { console.warn('[landmarks] vehicle worker failed, baking on the main thread', e.message || e); w.terminate(); this.vehicleWorker = null; fallback(); };
    w.postMessage({ keys: todo.map((m) => m.key) });
  }

  // stand-in BatchedMesh (one buried triangle, same material, colours and shadow flags as the real one) so the
  // loading-time shader prewarm compiles the batched programs before the worker's geometry arrives
  warmVehicleMesh() {
    this.mat.vehicle ??= vehicleMaterial();
    const g = new THREE.BufferGeometry();
    const f = (n, k) => new THREE.BufferAttribute(new Float32Array(n * k), k);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0, 0.01]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    g.setAttribute('color', f(3, 3));
    g.setAttribute('aPaint', f(3, 1));
    g.setAttribute('aEmit', f(3, 2));
    const bm = new THREE.BatchedMesh(1, 3, 3, this.mat.vehicle);
    const id = bm.addInstance(bm.addGeometry(g));
    bm.setMatrixAt(id, _m.makeTranslation(this.game.camera?.position?.x ?? 0, -500, this.game.camera?.position?.z ?? 0));
    bm.setColorAt(id, _col.setHex(0xffffff));
    bm.name = 'lmk-vehicles-warm';
    bm.castShadow = true;
    bm.receiveShadow = true;
    bm.frustumCulled = false;
    bm.perObjectFrustumCulled = false;
    this.root.add(bm);
    this.vehicleWarm = bm;
    g.dispose();
  }

  // a model that failed to bake: its placements go (colliders off)
  dropModel(m, e) {
    m.ready = true; m.failed = true;
    if (!this.warned.has(m.key)) { this.warned.add(m.key); console.warn('[landmarks] vehicle', m.key, e); }
    for (const v of this.vehicles) if (v.m === m) for (const k of v.cols || []) if (this.colliders.items[k]) this.colliders.items[k].off = true;
    this.vehicles = this.vehicles.filter((v) => v.m !== m);
  }

  buildVehicleMesh() {
    const t0 = performance.now();
    if (!this.vehicles.length || this.disposed) return;
    const models = [...new Set(this.vehicles.map((v) => v.m))];
    const verts = models.reduce((a, m) => a + m.verts, 0);
    this.mat.vehicle ??= vehicleMaterial();
    if (this.vehicleWarm) { this.root.remove(this.vehicleWarm); this.vehicleWarm.dispose(); this.vehicleWarm = null; }
    const bm = new THREE.BatchedMesh(this.vehicles.length, verts, verts, this.mat.vehicle);
    const gid = new Map(models.map((m) => [m, bm.addGeometry(m.geo)]));
    for (const v of this.vehicles) {
      v.id = bm.addInstance(gid.get(v.m));
      _q.setFromAxisAngle(_y, v.yaw);
      _m.compose(_p.set(v.x, v.y, v.z), _q, _s.set(1, 1, 1));
      bm.setMatrixAt(v.id, _m);
      bm.setColorAt(v.id, _col.setHex(v.color));
      v.vis = undefined;
    }
    bm.name = 'lmk-vehicles';
    bm.castShadow = true;
    bm.receiveShadow = true;
    bm.computeBoundingBox();
    bm.computeBoundingSphere();
    this.root.add(bm);
    this.vehicleMesh = bm;
    this.vehicleTris = this.vehicles.reduce((a, v) => a + v.m.tris, 0);
    this.vehicleModels = models.length;
    this.timing['vehicle-mesh'] = +(performance.now() - t0).toFixed(1);
  }

  // baked model for a vehicle key, or null (warned once per key)
  model(key) {
    try { return vehicleModel(key); } catch (e) {
      if (!this.warned.has(key)) { this.warned.add(key); console.warn('[landmarks] vehicle', key, e); }
      return null;
    }
  }

  park(key, cluster, tag, x, z, yaw, o = {}) {
    const m = this.model(key);
    if (!m) return null;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const cx = x + cs * m.cx + sn * m.cz, cz = z - sn * m.cx + cs * m.cz;
    if (!this.spotFree(cx, cz, yaw, m.wid / 2, m.len / 2, o)) return null;
    return this.addVehicle(key, cluster, tag, x, z, yaw, o);
  }

  addVehicle(key, cluster, tag, x, z, yaw = 0, { y = null, color = null, collider = true } = {}) {
    const m = this.model(key);
    if (!m) return null;
    const gy = y ?? this.game.terrain.heightAt(x, z);
    const pal = m.palette;
    const col = color ?? pal[Math.abs(Math.floor(x * 7.31 + z * 3.17)) % pal.length];
    const v = { m, x, y: gy, z, yaw, color: col, cluster, tag, id: -1, vis: true, cols: [0, 0] };
    this.vehicles.push(v);
    if (collider && m.kind !== 'boat') {
      // oriented box (bake frame: forward -Z); aircraft: the fuselage only (no invisible walls under wings / rotors)
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      const air = m.kind === 'plane' || m.kind === 'heli';
      const hx = air ? Math.min(1.3, m.wid / 2) : m.wid / 2, hz = air ? m.len * (m.kind === 'heli' ? 0.3 : 0.45) : m.len / 2;
      const hy = air ? m.h * 0.3 : m.h / 2;
      const ox = cs * m.cx + sn * m.cz, oz = -sn * m.cx + cs * m.cz;
      const id = this.colliders.box(x + ox, gy + m.y0 + hy, z + oz, hx, hy, hz, yaw, tag);
      if (id >= 0) { v.cols = [id, id + 1]; this.colliders.items[id].vehicle = true; }
    }
    return m;
  }

  addInstance(type, cluster, x, y, z, yaw = 0, color = 0xffffff, s = 1) {
    let t = this.instTypes.get(type.key);
    if (!t) this.instTypes.set(type.key, (t = { type, list: [], clusters: new Set() }));
    const e = [x, y, z, yaw, color, s];
    t.list.push(e);
    t.clusters.add(cluster);
    const c0 = this.colliders.items.length;
    if (type.collider) type.collider(this.colliders, x, y, z, yaw, s, cluster.b.colTag);
    e.cols = [c0, this.colliders.items.length];
    return t.list.length - 1;
  }

  *finalize() {
    const { solid, paint, lights, beams } = this.mat;
    let tf = performance.now();
    const lap = (k) => { const t = performance.now(); this.timing['fin-' + k] = +(t - tf).toFixed(1); tf = t; };
    // placement audit: every aircraft / vehicle / boat / structure against generic buildings, other objects,
    // roads and water; hits are fixed (generic building removed or object dropped), then counted again
    this.auditReport = { before: auditPlacements(this, { fix: true }) };
    this.auditReport.after = auditPlacements(this, { fix: false });
    lap('audit');
    yield;
    tf = performance.now();
    // grass infields: terrain ground classes paved -> grass between runways, taxiways and aprons (one upload)
    this.infieldStats = [];
    for (const req of this.infields) {
      const it = grassInfield(this, req.runways, req.opts);
      let r;
      while (!(r = it.next()).done) { yield; tf = performance.now(); }
      this.infieldStats.push({ site: req.site, ...r.value });
      yield;
      tf = performance.now();
    }
    if ((this.groundDirty || this.infieldStats.some((s) => s.changed > 0)) && this.game.terrain?.groundTex) this.game.terrain.groundTex.needsUpdate = true;
    lap('infield');
    this.timing['fin-infield'] = +(this.timing['fin-infield'] + this.infieldStats.reduce((a, s) => a + s.ms, 0)).toFixed(1);
    const tex = this.atlas.texture(this.game.renderer);
    this.mat.sign = signMaterial(tex);
    this.mat.gsign = signMaterial(tex, { polygonOffset: true });
    lap('atlas');
    for (const c of this.clusters.values()) {
      const mk = (data, mat, name, shadow = true) => {
        const geo = data?.geometry();
        if (!geo) return null;
        const m = new THREE.Mesh(geo, mat);
        m.name = `lmk-${c.key}-${name}`;
        m.castShadow = shadow;
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        this.root.add(m);
        return m;
      };
      c.meshes.near = mk(c.b.near, solid, 'near');
      c.meshes.sign = mk(c.sign.near, this.mat.sign, 'sign', false);
      c.meshes.gsign = mk(c.gsign.near, this.mat.gsign, 'gsign', false);
      c.meshes.paint = mk(c.paint.near, paint, 'paint', false);
      // cluster bounds = union of everything it drew (far silhouette included)
      const box = new THREE.Box3();
      for (const m of Object.values(c.meshes)) if (m) box.union(m.geometry.boundingBox);
      const fb = c.b.far.box;
      if (c.b.far.vcount) box.union(new THREE.Box3(new THREE.Vector3(fb[0], fb[1], fb[2]), new THREE.Vector3(fb[3], fb[4], fb[5])));
      c.box = box;
      c.tris = { near: c.b.near.tris, far: c.b.far.tris, sign: c.sign.near.tris + c.gsign.near.tris, paint: c.paint.near.tris };
    }
    lap('clusters');
    yield;
    tf = performance.now();
    this.farMesh = this.mergeFar();
    lap('far');
    if (this.farMesh) this.root.add(this.farMesh);
    for (const c of this.clusters.values()) c.b = c.sign = c.gsign = c.paint = null; // free builders
    const rg = this.runwayMesh.geometry();
    if (rg) {
      this.mat.runway = runwayMaterial(tex);
      this.runwaysMesh = new THREE.Mesh(rg, this.mat.runway);
      this.runwaysMesh.name = 'lmk-runways';
      this.runwaysMesh.receiveShadow = true;
      this.runwaysMesh.matrixAutoUpdate = false;
      this.root.add(this.runwaysMesh);
      this.runwayTris = rg.index.count / 3;
    }
    this.lightsMesh = this.lights.mesh(lights);
    if (this.lightsMesh) this.root.add(this.lightsMesh);
    this.beamsMesh = this.beams.mesh(beams);
    if (this.beamsMesh) this.root.add(this.beamsMesh);
    for (const t of this.instTypes.values()) {
      const geo = t.type.geometry();
      const im = new THREE.InstancedMesh(geo, solid, t.list.length);
      im.name = `lmk-inst-${t.type.key}`;
      im.castShadow = t.type.shadow !== false;
      im.receiveShadow = true;
      t.list.forEach(([x, y, z, yaw, color, s], i) => {
        _q.setFromAxisAngle(_y, yaw);
        _m.compose(_p.set(x, y, z), _q, _s.set(s, s, s));
        im.setMatrixAt(i, _m);
        im.setColorAt(i, _col.setHex(color));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingBox();
      im.computeBoundingSphere();
      this.root.add(im);
      t.mesh = im;
      t.tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      t.box = im.boundingBox.clone();
    }
    lap('lights+instances');
    // every parked real model in one BatchedMesh (one draw call; per-instance culling and distance hiding). The
    // placements are final here; the geometry is baked in a worker (bakeVehicles) and the mesh appears once it lands
    if (this.vehicles.length) {
      this.vehicleTris = this.vehicles.reduce((a, v) => a + v.m.tris, 0);
      this.vehicleModels = new Set(this.vehicles.map((v) => v.m)).size;
      this.warmVehicleMesh();
      this.bakeVehicles();
    }
    lap('vehicles');
    this.timing['vehicle-bakes'] = +Object.values(VEHICLE_BAKE_MS).reduce((a, b) => a + b, 0).toFixed(1);
    this.timing['vehicle-spots'] = +(this.spotMs || 0).toFixed(1);
    this.timing['vehicle-spot-n'] = this.spotN || 0;
    for (const d of this.dynamic) d.init?.(this, this.root);
  }

  // one mesh with every cluster's far silhouette; aClu = cluster index (1-based) for the near/far switch
  mergeFar() {
    const list = [...this.clusters.values()].filter((c) => c.b.far.vcount);
    if (!list.length) return null;
    let nv = 0, ni = 0;
    for (const c of list) { nv += c.b.far.vcount; ni += c.b.far.idx.n; }
    const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 3), col = new Uint8Array(nv * 3), fx = new Float32Array(nv * 4), clu = new Uint8Array(nv);
    const idx = new Uint32Array(ni);
    let v = 0, i = 0, k = 0;
    if (list.length >= MAX_CLUSTERS) console.warn('[landmarks] too many clusters for the far LOD switch', list.length);
    list.forEach((c) => {
      const F = c.b.far;
      c.index = Math.min(MAX_CLUSTERS - 1, ++k);
      pos.set(F.pos.a.subarray(0, F.vcount * 3), v * 3);
      nrm.set(F.nrm.a.subarray(0, F.vcount * 3), v * 3);
      col.set(F.col.a.subarray(0, F.vcount * 3), v * 3);
      fx.set(F.fx.a.subarray(0, F.vcount * 4), v * 4);
      clu.fill(c.index, v, v + F.vcount);
      const I = F.idx.a;
      for (let k = 0; k < F.idx.n; k++) idx[i + k] = I[k] + v;
      v += F.vcount; i += F.idx.n;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    g.setAttribute('aFx', new THREE.BufferAttribute(fx, 4));
    g.setAttribute('aClu', new THREE.BufferAttribute(clu, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.mat.solid);
    m.name = 'lmk-far-all';
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    this.farTris = ni / 3;
    return m;
  }

  // ---------- per frame ----------
  // module hooks: colliders stream on the logic tick, visibility / LOD after the camera moved
  update(dt) { this.colliders.update(dt); }
  lateUpdate(dt) { this.refresh(dt); }

  refresh(dt, force = false) {
    const g = this.game, cam = g.camera;
    if (!cam) return;
    const p = cam.position;
    const ds = this.distScale;
    for (const c of this.clusters.values()) {
      if (!c.box) continue;
      const d = c.box.distanceToPoint(p);
      const lim = c.nearDist * ds;
      const near = c.isNear ? d < lim + 60 : d < lim;
      if (near !== c.isNear || force) {
        c.isNear = near;
        const M = c.meshes;
        if (M.near) M.near.visible = near;
        if (c.index) LOD_UNIFORMS.uNearC.value[c.index] = near ? 1 : 0;
        if (M.sign) M.sign.visible = near;
        if (M.gsign) M.gsign.visible = near;
        if (M.paint) M.paint.visible = near;
      }
      c.dist = d;
    }
    for (const t of this.instTypes.values()) {
      if (!t.mesh) continue;
      const d = t.box.distanceToPoint(p);
      t.mesh.visible = d < (t.type.maxDist ?? 2600) * ds;
    }
    if (this.vehicleMesh) {
      let any = false;
      for (const v of this.vehicles) {
        const dx = v.x - p.x, dy = v.y - p.y, dz = v.z - p.z, r = v.m.maxDist * ds;
        const vis = dx * dx + dy * dy + dz * dz < r * r;
        if (vis !== v.vis || force) { v.vis = vis; this.vehicleMesh.setVisibleAt(v.id, vis); }
        any ||= vis;
      }
      this.vehicleMesh.visible = any;
    }
    if (this.lightsMesh) {
      const u = this.mat.lights.uniforms;
      const rt = g.render?.sceneRT;
      const h = rt ? rt.height : g.renderer?.domElement?.height || 800;
      u.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
      u.uFog.value = g.scene.fog?.density ?? 0;
      this.mat.beams.uniforms.uFog.value = u.uFog.value;
    }
    for (const d of this.dynamic) d.update?.(dt, cam, this);
  }

  computeStats() {
    let near = 0, far = 0, sign = 0, paint = 0, draws = 0;
    for (const c of this.clusters.values()) {
      near += c.tris.near; far += c.tris.far; sign += c.tris.sign; paint += c.tris.paint;
      draws += Object.values(c.meshes).filter(Boolean).length;
    }
    let inst = 0;
    for (const t of this.instTypes.values()) { inst += t.tris * t.list.length; draws++; }
    if (this.lightsMesh) draws++;
    if (this.beamsMesh) draws++;
    if (this.farMesh) draws++;
    if (this.runwaysMesh) draws++;
    if (this.vehicleMesh) draws++;
    draws += this.dynamic.reduce((a, d) => a + (d.draws || 0), 0);
    const per = {};
    for (const c of this.clusters.values()) per[c.key] = { near: c.tris.near, far: c.tris.far, sign: c.tris.sign, paint: c.tris.paint };
    return {
      sites: this.sites.length, clusters: this.clusters.size, meshes: draws,
      tris: { near, far, sign, paint, instanced: inst, vehicles: this.vehicleTris || 0 }, lights: this.lights.count, beams: this.beams.n,
      vehicles: { count: this.vehicles.length, models: this.vehicleModels || 0 },
      colliders: this.colliders.items.length, removedBuildings: this.removed.size, hiddenTrees: this.hiddenTrees,
      instances: Object.fromEntries([...this.instTypes.values()].map((t) => [t.type.key, t.list.length])),
      atlasRows: this.atlas.used, perCluster: per, timing: this.timing,
    };
  }

  // QA: colliders of land structures resting on ground that is below sea level (should be none, except the
  // sites listed in `allow`: ships, reef light on piles)
  // structures standing in water, per site (piers of the marinas, the cruise terminal's ships and the reef light
  // are meant to); parked vehicles are checked by the placement audit
  wetReport(allow = ['port-cruise', 'lighthouse-reef']) {
    const t = this.game.terrain, out = {};
    for (const it of this.colliders.items) {
      if (it.off || it.vehicle || allow.includes(it.tag) || (typeof it.tag === 'string' && it.tag.startsWith('marina-'))) continue;
      const bottom = it.y - (it.shape === 2 ? 0 : it.b);
      if (it.shape === 2) continue;
      const g = t.heightAt(it.x, it.z);
      if (g < 0.05 && bottom < g + 3) (out[it.tag] ||= []).push([Math.round(it.x), Math.round(it.z), +g.toFixed(1)]);
    }
    return out;
  }

  // draw calls currently submitted by landmarks (visible meshes; shadow passes excluded)
  visibleDraws() {
    let n = 0;
    this.root.traverseVisible((o) => { if (o.isMesh || o.isPoints) n++; });
    return n;
  }

  // compile every landmark program into the HDR target the game renders to (only needed when landmarks are
  // created after bootstrap's render.prewarm(); renderer.compile visits hidden meshes too)
  prewarm() {
    const g = this.game, r = g.renderer;
    if (!r?.compile) return;
    const prev = r.getRenderTarget();
    try {
      if (g.render?.sceneRT) r.setRenderTarget(g.render.sceneRT);
      r.compile(this.root, g.camera, g.scene);
    } catch (e) { console.warn('[landmarks] prewarm', e); }
    r.setRenderTarget(prev);
  }

  dispose() {
    this.disposed = true;
    this.vehicleWorker?.terminate();
    this.vehicleMesh?.dispose();
    this.vehicleWarm?.dispose();
    this.colliders.dispose();
    this.game.scene.remove(this.root);
  }
}

function footArea(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  return Math.abs(a) / 2;
}

export { rgb };
