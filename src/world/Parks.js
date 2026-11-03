import * as THREE from 'three';
import { Scatter } from './Scatter.js';
import { LAMP_MAP_UNIFORMS, LAMP_MAP_GLSL } from './LampLightMap.js';
import { patchWeather } from './weatherPatch.js';
import { Kit } from '../life/geometry.js';
import { propMaterial } from '../life/materials.js';
import { ColliderField } from '../life/colliders.js';
import { BUILD } from '../core/version.js';
import { ParkRoutes } from './ParkRoutes.js';

// Parks (tools/parks.py -> public/data/parks.json): every park of the YANIS map with its footpath network, plazas,
// courts and playgrounds, benches, bins, lamps, picnic tables, fountains, planters, railings, signs and its own tree
// layout. Everything is applied here at load, so a later tools/export.py run never undoes it:
//   - ground: park texels the export left as plain grass / town become park (sport on fields)
//   - vegetation: the export's random scatter inside parks is hidden, the park layout is added to the same scatters
//     (trees stay breakable, keep their colliders)
//   - buildings standing on open park on the source map are removed
//   - lamps join the street-lamp system (light pools, glow, breakable): shorter pedestrian poles (Lamps.lampScale)
//   - paths: low ribbons on the terrain (border strip + surface), merged per 1 km cell, one material; the ends at
//     street gates ramp up onto the sidewalk slab (no kerb lip). Not roads: no traffic, no routing; drivable ground.
//   - props: one InstancedMesh per kind (life prop material: one shared program), static colliders around the player
// Pedestrians stroll the path graph (pathGraph()).
const URL = `${import.meta.env.BASE_URL}data/parks.json${BUILD === 'dev' ? '' : `?v=${BUILD}`}`;
// fetched as soon as the module is imported (in parallel with the world data)
const pending = typeof fetch === 'function' ? fetch(URL).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null);

const CELL = 1024; // path meshes: one per 1 km cell (a view over a park draws 2-6)
const LAMP_SY = 0.56; // park lamps: 4.8 m poles (street lamps are 8.5 m)
const KERB_TOP = 0.07 + 0.14; // Roads.js: road lift + kerb height
const VEG_TYPES = ['palm', 'tree', 'pine', 'bush'];
// path colours by kind (paved, promenade pavers, gravel trail) and their border strips
const COL = {
  surf: [[0.74, 0.71, 0.65], [0.79, 0.68, 0.6], [0.66, 0.58, 0.45]],
  edge: [[0.52, 0.5, 0.47], [0.56, 0.48, 0.42], [0.5, 0.45, 0.36]],
  plaza: [0.77, 0.74, 0.68],
  plazaEdge: [0.55, 0.53, 0.5],
  court: [0.23, 0.42, 0.52], courtOut: [0.3, 0.48, 0.36], line: [0.92, 0.92, 0.9],
  play: [0.66, 0.33, 0.26], playEdge: [0.45, 0.43, 0.41],
};

// sRGB -> linear (vertex colours are linear, like the life Kit's)
for (const k of Object.keys(COL)) {
  const lin = (c) => c.map((v) => Math.pow(v, 2.2));
  COL[k] = Array.isArray(COL[k][0]) ? COL[k].map(lin) : lin(COL[k]);
}

export async function createParks(game, data) {
  if (typeof location !== 'undefined' && /[?&]noparks\b/.test(location.search)) return null; // A/B: the world without
  const json = await pending;
  if (!json?.parks?.length) return null;
  try {
    const parks = new Parks(game, data, json);
    game.register({ lateUpdate: (dt) => parks.update(dt, game.camera), parks }, 50);
    return parks;
  } catch (e) {
    console.warn('[parks] disabled', e);
    return null;
  }
}

export class Parks {
  constructor(game, data, json) {
    const t0 = performance.now();
    this.game = game;
    this.data = json;
    this.terrain = game.terrain;
    this.roads = game.roads;
    this.parks = json.parks;
    this.stats = {};
    this._masks();
    this._ground();
    this._vegetation();
    this._buildings();
    this._lamps();
    this.group = new THREE.Group();
    this.group.name = 'parks';
    game.scene.add(this.group);
    this._paths();
    this._props();
    this.stats.ms = Math.round(performance.now() - t0);
    console.info(`[parks] ${this.parks.length} parks, ${json.paths.length} paths, ${this.stats.tris} tris in ${this.meshes.length} meshes, ${this.stats.trees} trees, ${this.stats.lamps} lamps, ${this.stats.ms} ms`);
  }

  // ---------------------------------------------------------------------------------------------------- masks
  _masks() {
    const T = this.terrain;
    this.maskOf = this.parks.map((p) => {
      const [i0, j0, w, h, ...runs] = p.mask;
      const m = new Uint8Array(w * h);
      let o = 0, v = 0;
      for (const n of runs) { if (v) m.fill(1, o, o + n); o += n; v ^= 1; }
      return { i0, j0, w, h, m, x0: T.x0 + i0 * T.ts, z0: T.z0 + j0 * T.ts };
    });
  }

  /** index of the park at (x, z), -1 outside every park */
  parkAt(x, z) {
    const ts = this.terrain.ts;
    for (let k = 0; k < this.maskOf.length; k++) {
      const M = this.maskOf[k];
      const i = Math.floor((x - M.x0) / ts), j = Math.floor((z - M.z0) / ts);
      if (i >= 0 && j >= 0 && i < M.w && j < M.h && M.m[j * M.w + i]) return k;
    }
    return -1;
  }

  _ground() {
    const T = this.terrain, g = this.data.ground || [];
    let n = 0;
    for (let k = 0; k < g.length; k += 4) {
      const j = g[k], i = g[k + 1], len = g[k + 2], c = g[k + 3];
      if (j < 0 || j >= T.th) continue;
      const o = j * T.tw;
      for (let q = 0; q < len; q++) if (i + q >= 0 && i + q < T.tw) { T.ground[o + i + q] = c; n++; }
    }
    if (n && T.groundTex) T.groundTex.needsUpdate = true;
    this.stats.ground = n;
  }

  // the export's random scatter inside the parks goes; the park layout joins the same scatters
  _vegetation() {
    const V = this.game.veg, T = this.terrain;
    if (!V?.scatters) return;
    let hidden = 0;
    for (const t of Object.keys(V.scatters)) {
      const sc = V.scatters[t];
      if (!sc.raw) continue;
      for (const p of this.parks) {
        const [x0, z0, x1, z1] = p.bbox;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.hypot(x1 - x0, z1 - z0) / 2 + 4;
        for (const id of sc.near(cx, cz, r)) {
          if (sc.hidden.has(id)) continue;
          if (this.parkAt(sc.raw[id * 6], sc.raw[id * 6 + 2]) >= 0) { sc.hidden.add(id); hidden++; }
        }
      }
    }
    const tr = this.data.trees || [];
    const add = { palm: [], tree: [], pine: [], bush: [] };
    const tint = new THREE.Color();
    for (let k = 0; k < tr.length; k += 4) {
      const x = tr[k], z = tr[k + 1], type = VEG_TYPES[tr[k + 2]], s = tr[k + 3];
      if (!add[type] || !V.scatters[type]) continue;
      const y = T.heightAt(x, z);
      if (y < 0.15) continue;
      const i = k >> 2;
      const hue = 0.92 + ((i * 7919) % 100) / 100 * 0.18;
      tint.setRGB(hue, 0.95 + ((i * 104729) % 100) / 1000, hue * 0.95);
      add[type].push(x, y - 0.1, z, ((i * 2654435761) % 6283) / 1000, type === 'bush' ? s * 1.1 : s, tint.getHex());
    }
    let n = 0;
    for (const [t, list] of Object.entries(add)) n += appendScatter(V.scatters[t], list);
    this.stats.vegHidden = hidden;
    this.stats.trees = n;
    V.bakeCanopy(T);
  }

  _buildings() {
    const B = this.game.buildings, h = this.data.hide || [];
    let n = 0;
    if (!B?.query || !B.remove) return;
    for (let k = 0; k < h.length; k += 2) {
      for (const id of B.query(h[k], h[k + 1], 30)) {
        const p = B.list[id]?.p;
        if (!p) continue;
        let cx = 0, cz = 0;
        for (let q = 0; q < p.length; q += 2) { cx += p[q]; cz += p[q + 1]; }
        cx /= p.length / 2; cz /= p.length / 2;
        if (Math.hypot(cx - h[k], cz - h[k + 1]) < 1.0 && B.remove(id)) n++;
      }
    }
    this.stats.buildingsRemoved = n;
  }

  // pedestrian lamps join the street-lamp system: Lamps (constructed after the parks) reads roads.lamps + lampScale
  _lamps() {
    const R = this.roads, L = this.data.props?.lamp || [], T = this.terrain;
    if (!R?.lamps) return;
    const n0 = R.lamps.length / 4;
    R.lampScale = R.lampScale || new Array(n0).fill(1);
    let n = 0;
    for (let k = 0; k < L.length; k += 3) {
      const y = T.heightAt(L[k], L[k + 1]);
      if (y < 0.35) continue;
      R.lamps.push(L[k], y, L[k + 1], L[k + 2]);
      R.lampScale.push(LAMP_SY);
      n++;
    }
    this.stats.lamps = n;
  }

  // ---------------------------------------------------------------------------------------------------- paths
  _paths() {
    const J = this.data, T = this.terrain;
    const cells = new Map();
    const cellOf = (x, z) => {
      const key = Math.floor(x / CELL) * 100000 + Math.floor(z / CELL);
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { pos: [], col: [], idx: [] }));
      return c;
    };
    const deg = new Map();
    for (const p of J.paths) for (const n of [p.a, p.b]) deg.set(n, (deg.get(n) || 0) + 1);
    this.graph = []; // for pedestrians: { pts: Float32Array x,y,z, len, a, b, w }
    let snapped = 0;
    for (const p of J.paths) {
      let P = [];
      for (let k = 0; k < p.p.length; k += 2) P.push([p.p[k], p.p[k + 1]]);
      P = resample(P, 1.6);
      if (P.length < 2) continue;
      const ys = P.map(([x, z]) => T.heightAt(x, z));
      // street gates: the end steps onto the sidewalk slab (or the road edge), ramping up over its last metres
      for (const end of [0, 1]) {
        const ni = end ? p.b : p.a;
        const node = J.nodes[ni];
        if (!node || !node[2] || deg.get(ni) !== 1) continue;
        const s = this._snapGate(P, ys, end);
        if (s) snapped++;
      }
      const c = cellOf(P[P.length >> 1][0], P[P.length >> 1][1]);
      const hw = p.w / 2;
      ribbon(c, P, ys, hw + 0.2, COL.edge[p.k] || COL.edge[0], 0.04);
      ribbon(c, P, ys, hw, COL.surf[p.k] || COL.surf[0], 0.06);
      const pts = new Float32Array(P.length * 3);
      P.forEach(([x, z], i) => { pts[i * 3] = x; pts[i * 3 + 1] = ys[i] + 0.06; pts[i * 3 + 2] = z; });
      this.graph.push({ pts, n: P.length, a: p.a, b: p.b, w: p.w, park: p.park });
    }
    for (const [x, z, r, kind] of J.plazas) {
      const c = cellOf(x, z);
      disc(c, T, x, z, r + 0.25, COL.plazaEdge, 0.05);
      disc(c, T, x, z, r, COL.plaza, 0.07);
      if (kind === 2) disc(c, T, x, z, r * 0.45, [0.36, 0.5, 0.3], 0.075);
    }
    for (const s of J.surfaces || []) {
      const c = cellOf(s.x, s.z);
      if (s.k === 'court') {
        rect(c, T, s.x, s.z, s.yaw, s.w + 2.4, s.l + 3, COL.courtOut, 0.07);
        rect(c, T, s.x, s.z, s.yaw, s.w, s.l, COL.court, 0.08);
        courtLines(c, T, s);
      } else {
        rect(c, T, s.x, s.z, s.yaw, s.w + 0.6, s.l + 0.6, COL.playEdge, 0.07);
        rect(c, T, s.x, s.z, s.yaw, s.w, s.l, COL.play, 0.08);
      }
    }
    this.material = pathMaterial();
    this.meshes = [];
    let tris = 0;
    for (const c of cells.values()) {
      if (!c.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(c.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(c.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(c.idx, 1) : new THREE.Uint16BufferAttribute(c.idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, this.material);
      m.receiveShadow = true;
      m.castShadow = false;
      m.matrixAutoUpdate = false;
      m.name = 'park-paths';
      this.group.add(m);
      this.meshes.push(m);
      tris += c.idx.length / 3;
    }
    this.stats.tris = tris;
    this.stats.gates = snapped;
  }

  // gate end (end 0 = first point, 1 = last): extend to the sidewalk's outer edge and ramp the height to its slab
  _snapGate(P, ys, end) {
    const R = this.roads;
    if (!R?.nearest) return false;
    const i = end ? P.length - 1 : 0;
    const [x, z] = P[i];
    const n = R.nearest(x, z, 30, (e) => e.kind !== 1 && !e.tunnel && !e.airside);
    if (!n) return false;
    const e = n.edge;
    const hw = (e.wp ? e.wp[n.seg] + (e.wp[n.seg + 1] - e.wp[n.seg]) * n.t : e.w) / 2;
    const sw = typeof R.sidewalkWidth === 'function' ? R.sidewalkWidth(e) : 0;
    if (n.dist > hw + sw + 9 || n.dist < hw * 0.6) return false;
    const ux = (x - n.x) / n.dist, uz = (z - n.z) / n.dist;
    const reach = sw ? hw + sw - 0.3 : hw - 0.2; // tucked 0.3 m under the slab edge / onto the asphalt edge
    const tx = n.x + ux * reach, tz = n.z + uz * reach;
    const ty = sw ? Math.max(n.y + KERB_TOP, this.terrain.heightAt(tx, tz) + 0.03) - 0.07 : n.y + 0.07 - 0.07;
    const d = Math.hypot(tx - x, tz - z);
    if (d > 12) return false;
    if (d > 0.4) {
      const steps = Math.max(1, Math.ceil(d / 1.6));
      const add = [];
      for (let s = 1; s <= steps; s++) add.push([x + (tx - x) * s / steps, z + (tz - z) * s / steps]);
      if (end) { for (const q of add) { P.push(q); ys.push(this.terrain.heightAt(q[0], q[1])); } } else { for (const q of add) { P.unshift(q); ys.unshift(this.terrain.heightAt(q[0], q[1])); } }
    }
    // ramp: the last 3.5 m blend from the ground to the slab top (never below the ground)
    const L = P.length;
    let acc = 0;
    for (let k = 0; k < L; k++) {
      const idx = end ? L - 1 - k : k;
      if (k > 0) {
        const pr = end ? idx + 1 : idx - 1;
        acc += Math.hypot(P[idx][0] - P[pr][0], P[idx][1] - P[pr][1]);
      }
      if (acc > 3.5) break;
      const f = 1 - acc / 3.5;
      ys[idx] = Math.max(ys[idx], ys[idx] + (ty - ys[idx]) * f);
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------- props
  _props() {
    const P = this.data.props || {}, T = this.terrain, g = this.game;
    const mat = propMaterial();
    this.propMaterial = mat;
    const q = g.settings?.drawDist ?? 1;
    const defs = {
      bench: [benchGeo, 300], bin: [binGeo, 220], picnic: [picnicGeo, 300], planter: [planterGeo, 300], fountain: [fountainGeo, 650],
      playground: [playgroundGeo, 600], hoop: [hoopGeo, 450], railing: [railingGeo, 380], sign: [signGeo, 300],
    };
    this.scatters = {};
    this.field = new ColliderField(g, { radius: 80, budget: 24, interval: 0.2 });
    let n = 0;
    for (const [kind, [geo, radius]] of Object.entries(defs)) {
      const L = P[kind];
      if (!L?.length) continue;
      const sc = new Scatter(this.group, geo(), mat, { capacity: Math.min(L.length / 3, 6000), radius: radius * q, castShadow: kind === 'fountain' || kind === 'playground' || kind === 'bench' || kind === 'picnic', shadowRadius: 70 });
      sc.mesh.name = 'park-' + kind;
      for (let k = 0; k < L.length; k += 3) {
        const x = L[k], z = L[k + 1], yaw = L[k + 2];
        const g0 = T.heightAt(x, z);
        if (g0 < 0.35) continue; // the shore slopes into the water there: no bench / railing in the surf
        const y = g0 + (kind === 'fountain' || kind === 'playground' ? 0.07 : 0.0);
        sc.add(x, y, z, yaw, 1, 0xffffff);
        this._collider(kind, x, y, z, yaw);
        n++;
      }
      sc.finalize();
      sc.baseRadius = sc.radius;
      this.scatters[kind] = sc;
    }
    this.stats.props = n;
  }

  _collider(kind, x, y, z, yaw) {
    const F = this.field, c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    switch (kind) {
      case 'bench': F.box(x, y + 0.45, z, 0.9, 0.45, 0.28, yaw); break;
      case 'bin': F.cyl(x, y + 0.5, z, 0.3, 0.5); break;
      case 'picnic': F.box(x, y + 0.4, z, 0.95, 0.4, 0.8, yaw); break;
      case 'planter': F.box(x, y + 0.3, z, 0.55, 0.3, 0.55, yaw); break;
      case 'fountain': F.cyl(x, y + 0.4, z, 3.0, 0.4); F.cyl(x, y + 1.4, z, 0.5, 1.4); break;
      case 'hoop': { const [px, pz] = at(0, -0.9); F.cyl(px, y + 1.6, pz, 0.1, 1.6); break; }
      case 'sign': F.box(x, y + 0.9, z, 0.85, 0.9, 0.08, yaw); break;
      case 'railing': F.box(x, y + 0.5, z, 1.15, 0.5, 0.05, yaw); break;
      case 'playground': {
        for (const [lx, lz, hx, hy, hz] of [[-4, 0, 1.2, 1.4, 1.2], [3.5, -2, 2.4, 1.3, 0.2], [3.5, 2, 2.4, 1.3, 0.2]]) {
          const [px, pz] = at(lx, lz);
          F.box(px, y + hy, pz, hx, hy, hz, yaw);
        }
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------------------------------------------- per frame
  update(dt, camera) {
    const p = camera.position, T = this.terrain;
    const alt = Math.max(0, p.y - T.heightAt(p.x, p.z));
    const far = 950 * (1 + alt / 400);
    for (const m of this.meshes) {
      const b = m.geometry.boundingBox;
      const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x), dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
      m.visible = Math.hypot(dx, dz) < far;
    }
    for (const sc of Object.values(this.scatters)) { sc.update(camera, dt); sc.mesh.visible = sc.mesh.count > 0; }
    this.field.update(dt);
  }

  /** path graph for pedestrians: [{pts (x, y, z), n, a, b, w, park}] (a / b: node ids shared at junctions) */
  pathGraph() { return this.graph; }

  route(x0, z0, x1, z1, startY, endY) {
    this.routes ||= new ParkRoutes(this.data);
    return this.routes.route({ x: x0, z: z0, y: startY }, { x: x1, z: z1, y: endY }, (x, z) => this.parkAt(x, z),
      (a, b) => this.roads.route(a.x, a.z, b.x, b.z, a.y, b.y));
  }
}

// ---------------------------------------------------------------------------------------------------- geometry
function resample(P, step) {
  const out = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const [ax, az] = P[i - 1], [bx, bz] = P[i];
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  return out;
}

// strip of half width hw along P (heights ys + lift), mitred joints, round-ish caps (a half disc at both ends)
function ribbon(c, P, ys, hw, col, lift) {
  const n = P.length, base = c.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    let nx = -tz, nz = tx;
    // mitre: scale by 1/cos of the half turn (limited)
    if (i > 0 && i < n - 1) {
      const ux = P[i][0] - P[i - 1][0], uz = P[i][1] - P[i - 1][1], ul = Math.hypot(ux, uz) || 1;
      const m = Math.max(0.6, (-uz / ul) * nx + (ux / ul) * nz);
      nx /= m; nz /= m;
    }
    const y = ys[i] + lift;
    c.pos.push(P[i][0] + nx * hw, y, P[i][1] + nz * hw, P[i][0] - nx * hw, y, P[i][1] - nz * hw);
    c.col.push(...col, ...col);
    if (i) { const v = base + i * 2; c.idx.push(v - 2, v, v - 1, v - 1, v, v + 1); }
  }
  // caps
  for (const [i, dir] of [[0, -1], [n - 1, 1]]) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cb = c.pos.length / 3;
    c.pos.push(P[i][0], ys[i] + lift, P[i][1]);
    c.col.push(...col);
    const seg = 5;
    for (let k = 0; k <= seg; k++) {
      const t = ang + (dir > 0 ? -Math.PI / 2 + (k / seg) * Math.PI : Math.PI / 2 + (k / seg) * Math.PI);
      c.pos.push(P[i][0] + Math.cos(t) * hw, ys[i] + lift, P[i][1] + Math.sin(t) * hw);
      c.col.push(...col);
      if (k) c.idx.push(cb, cb + k + 1, cb + k);
    }
  }
}

function disc(c, T, x, z, r, col, lift) {
  const seg = Math.max(16, Math.min(40, Math.round(r * 4))), cb = c.pos.length / 3;
  c.pos.push(x, T.heightAt(x, z) + lift, z);
  c.col.push(...col);
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    c.pos.push(px, T.heightAt(px, pz) + lift, pz);
    c.col.push(...col);
    if (k) c.idx.push(cb, cb + k + 1, cb + k);
  }
}

// rectangle w (local x) by l (local z), yaw about +y, subdivided so it follows the ground
function rect(c, T, x, z, yaw, w, l, col, lift) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const nu = Math.max(1, Math.ceil(w / 4)), nv = Math.max(1, Math.ceil(l / 4)), cb = c.pos.length / 3;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const lx = -w / 2 + (w * i) / nu, lz = -l / 2 + (l * j) / nv;
      const px = x + lx * cs + lz * sn, pz = z - lx * sn + lz * cs;
      c.pos.push(px, T.heightAt(px, pz) + lift, pz);
      c.col.push(...col);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = cb + j * (nu + 1) + i, b = a + 1, d = a + nu + 1, e = d + 1;
      c.idx.push(a, d, b, b, d, e);
    }
  }
}

function courtLines(c, T, s) {
  const { x, z, yaw, w, l } = s;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const seg = (ax, az, bx, bz) => { // local segment as a 0.1 m line
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, len = Math.hypot(bx - ax, bz - az);
    const a = Math.atan2(bx - ax, bz - az);
    rect(c, T, x + mx * cs + mz * sn, z - mx * sn + mz * cs, yaw + a, 0.1, len, COL.line, 0.09);
  };
  const hw = w / 2 - 0.3, hl = l / 2 - 0.3;
  seg(-hw, -hl, hw, -hl); seg(-hw, hl, hw, hl); seg(-hw, -hl, -hw, hl); seg(hw, -hl, hw, hl); seg(-hw, 0, hw, 0);
  for (const sd of [-1, 1]) { // keys
    seg(-2.45, sd * hl, -2.45, sd * (hl - 5.8)); seg(2.45, sd * hl, 2.45, sd * (hl - 5.8)); seg(-2.45, sd * (hl - 5.8), 2.45, sd * (hl - 5.8));
  }
}

function pathMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, LAMP_MAP_UNIFORMS);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        ${LAMP_MAP_GLSL}
        varying vec3 vWorld;
        float pkHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float pkNoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(pkHash(i), pkHash(i+vec2(1,0)), f.x), mix(pkHash(i+vec2(0,1)), pkHash(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 0.9 + 0.12 * pkNoise(vWorld.xz * 0.9) + 0.06 * pkNoise(vWorld.xz * 5.0);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * lampMapLight(vWorld) * 1.5;`);
    patchWeather(sh, { worldPos: 'vWorld', porosity: 0.55 });
  };
  mat.customProgramCacheKey = () => 'park-paths-v1';
  return mat;
}

// append instances to a finalized Scatter (src/world/Scatter.js): list = [x, y, z, rotY, scale, colorHex] * n
function appendScatter(sc, list) {
  const n = list.length / 6;
  if (!n || !sc?.raw || !sc.M) return 0;
  const n0 = sc.count;
  const raw = new Float32Array((n0 + n) * 6), rawCol = new Float32Array((n0 + n) * 3), M = new Float32Array((n0 + n) * 16);
  raw.set(sc.raw); rawCol.set(sc.rawCol); M.set(sc.M);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const CELLS = 256;
  for (let k = 0; k < n; k++) {
    const i = n0 + k, o = k * 6;
    const x = list[o], y = list[o + 1], z = list[o + 2], r = list[o + 3], sc_ = list[o + 4];
    raw.set([x, y, z, r, sc_, sc_], i * 6);
    col.setHex(list[o + 5]);
    rawCol.set([col.r, col.g, col.b], i * 3);
    m.compose(p.set(x, y, z), q.setFromAxisAngle(up, r), s.set(sc_, sc_, sc_));
    m.toArray(M, i * 16);
    const key = Math.floor(x / CELLS) * 100000 + Math.floor(z / CELLS);
    let cell = sc.cells.get(key);
    if (!cell) sc.cells.set(key, (cell = { minY: y, maxY: y, cx: Math.floor(x / CELLS) * CELLS, cz: Math.floor(z / CELLS) * CELLS, idx: [] }));
    cell.minY = Math.min(cell.minY, y);
    cell.maxY = Math.max(cell.maxY, y + 15 * sc_);
    cell.idx.push(i);
  }
  sc.raw = raw; sc.rawCol = rawCol; sc.M = M; sc.count = n0 + n;
  sc.cellList = [...sc.cells.values()];
  sc._timer = 0;
  return n;
}

// ---------------------------------------------------------------------------------------------------- models
// Original low-poly park furniture (life prop style). Local frame: origin on the ground, +z = front.
const K = {
  wood: 0xa8774c, woodDark: 0x7d5534, iron: 0x2f3237, steel: 0x8a9096, white: 0xeeeae2, stone: 0xc8c0b0, stoneDark: 0xa39b8c,
  water: 0x4f9fc4, leaf: 0x4f9a3a, leafDark: 0x3b7d2c, soil: 0x5a4330, red: 0xd2483a, yellow: 0xf2c23a, blue: 0x3b7fd0, green: 0x3f9a5a,
  sign: 0x2f5d3a, signEdge: 0xd9cfae, orange: 0xe0702a,
};
function benchGeo() {
  const k = new Kit();
  for (let i = 0; i < 3; i++) k.box(1.8, 0.05, 0.13, i % 2 ? K.wood : K.woodDark, { y: 0.46, z: -0.16 + i * 0.16 });
  for (let i = 0; i < 2; i++) k.box(1.8, 0.12, 0.04, i % 2 ? K.wood : K.woodDark, { y: 0.66 + i * 0.17, z: -0.3, rx: -0.18 });
  for (const x of [-0.75, 0.75]) {
    k.box(0.07, 0.46, 0.07, K.iron, { x, y: 0.23, z: 0.14 });
    k.box(0.07, 0.9, 0.07, K.iron, { x, y: 0.45, z: -0.24 });
    k.box(0.07, 0.05, 0.5, K.iron, { x, y: 0.42, z: -0.04 });
    k.box(0.07, 0.05, 0.42, K.iron, { x, y: 0.62, z: 0.0 });
  }
  return k.build();
}
function binGeo() {
  const k = new Kit();
  k.cyl(0.28, 0.25, 0.86, 8, 0x2f5a3c, { y: 0.43 });
  k.cyl(0.3, 0.3, 0.08, 8, K.iron, { y: 0.9 });
  k.cyl(0.08, 0.08, 0.1, 6, K.iron, { y: 0.98 });
  return k.build();
}
function picnicGeo() {
  const k = new Kit();
  for (let i = 0; i < 4; i++) k.box(0.2, 0.05, 1.9, i % 2 ? K.wood : K.woodDark, { x: -0.3 + i * 0.2, y: 0.76 });
  for (const sx of [-1, 1]) {
    k.box(0.3, 0.05, 1.9, K.woodDark, { x: sx * 0.75, y: 0.45 });
    for (const z of [-0.7, 0.7]) {
      k.box(0.06, 0.82, 0.08, K.woodDark, { x: sx * 0.35, y: 0.4, z, rz: sx * -0.42 });
      k.box(1.6, 0.06, 0.08, K.woodDark, { y: 0.42, z });
    }
  }
  return k.build();
}
function planterGeo() {
  const k = new Kit();
  k.box(1.2, 0.55, 1.2, K.stone, { y: 0.275 });
  k.box(1.04, 0.04, 1.04, K.soil, { y: 0.56 });
  k.push(new THREE.IcosahedronGeometry(0.55, 0), K.leaf, { y: 0.95 });
  k.push(new THREE.IcosahedronGeometry(0.35, 0), K.leafDark, { x: 0.25, y: 1.25, z: 0.1 });
  return k.build();
}
function fountainGeo() {
  const k = new Kit();
  k.cyl(3.0, 3.1, 0.5, 20, K.stone, { y: 0.25 });
  k.cyl(2.65, 2.65, 0.06, 20, K.water, { y: 0.44, emit: [0.02, 0.05, 0.07] });
  k.cyl(0.45, 0.6, 1.4, 10, K.stoneDark, { y: 0.9 });
  k.cyl(1.3, 0.35, 0.35, 14, K.stone, { y: 1.75 });
  k.cyl(1.15, 1.15, 0.05, 14, K.water, { y: 1.9, emit: [0.02, 0.05, 0.07] });
  k.cyl(0.18, 0.25, 0.8, 8, K.stoneDark, { y: 2.3 });
  k.cyl(0.42, 0.12, 0.25, 10, K.stone, { y: 2.75 });
  k.cone(0.22, 0.5, 8, 0xbfe3f2, { y: 3.1, emit: [0.03, 0.06, 0.08] });
  return k.build();
}
function playgroundGeo() {
  const k = new Kit();
  // climbing tower + slide (-x end)
  for (const [x, z] of [[-5, -1], [-3, -1], [-5, 1], [-3, 1]]) k.box(0.14, 2.6, 0.14, K.blue, { x, y: 1.3, z });
  k.box(2.3, 0.1, 2.3, K.woodDark, { x: -4, y: 1.4 });
  k.cone(1.7, 1.0, 4, K.red, { x: -4, y: 3.1, ry: Math.PI / 4 });
  k.box(0.9, 0.06, 3.4, K.yellow, { x: -4, y: 0.75, z: 2.5, rx: 0.5 });
  k.box(0.08, 0.25, 3.4, K.yellow, { x: -4.45, y: 0.9, z: 2.5, rx: 0.5 });
  k.box(0.08, 0.25, 3.4, K.yellow, { x: -3.55, y: 0.9, z: 2.5, rx: 0.5 });
  for (let i = 0; i < 5; i++) k.box(0.9, 0.05, 0.08, K.steel, { x: -4, y: 0.25 + i * 0.28, z: -1.6 - i * 0.1 });
  // swings (+x end)
  for (const sz of [-2, 2]) {
    for (const sx of [1.2, 5.8]) { k.box(0.1, 2.7, 0.1, K.green, { x: sx, y: 1.3, z: sz - 0.55, rx: 0.2 }); k.box(0.1, 2.7, 0.1, K.green, { x: sx, y: 1.3, z: sz + 0.55, rx: -0.2 }); }
    k.box(4.8, 0.1, 0.1, K.green, { x: 3.5, y: 2.6, z: sz });
    for (const sx of [2.5, 4.5]) {
      k.box(0.03, 1.9, 0.03, K.steel, { x: sx - 0.25, y: 1.65, z: sz });
      k.box(0.03, 1.9, 0.03, K.steel, { x: sx + 0.25, y: 1.65, z: sz });
      k.box(0.6, 0.05, 0.25, K.red, { x: sx, y: 0.7, z: sz });
    }
  }
  // spring riders + sandbox
  k.cyl(0.08, 0.1, 0.5, 6, K.steel, { x: 0, y: 0.25, z: 3.5 });
  k.box(0.3, 0.4, 0.8, K.orange, { x: 0, y: 0.7, z: 3.5 });
  k.box(3.0, 0.2, 0.15, K.woodDark, { x: 0, y: 0.1, z: -3.5 }); k.box(3.0, 0.2, 0.15, K.woodDark, { x: 0, y: 0.1, z: -5.5 });
  k.box(0.15, 0.2, 2.0, K.woodDark, { x: -1.5, y: 0.1, z: -4.5 }); k.box(0.15, 0.2, 2.0, K.woodDark, { x: 1.5, y: 0.1, z: -4.5 });
  k.box(2.85, 0.06, 1.85, 0xe2cf98, { x: 0, y: 0.1, z: -4.5 });
  return k.build();
}
function hoopGeo() {
  const k = new Kit();
  k.cyl(0.08, 0.1, 3.3, 8, K.iron, { y: 1.65, z: -0.9 });
  k.box(0.08, 0.08, 1.0, K.iron, { y: 3.2, z: -0.45 });
  k.box(1.8, 1.05, 0.06, K.white, { y: 3.4, z: 0 });
  k.box(0.6, 0.45, 0.07, K.red, { y: 3.2, z: 0.0 });
  k.push(new THREE.TorusGeometry(0.23, 0.02, 4, 12), K.orange, { y: 3.05, z: 0.27, rx: Math.PI / 2 });
  return k.build();
}
function railingGeo() {
  const k = new Kit();
  for (const x of [-1.15, 0, 1.15]) k.box(0.06, 1.05, 0.06, K.white, { x, y: 0.52 });
  k.box(2.36, 0.06, 0.08, K.white, { y: 1.03 });
  k.box(2.3, 0.04, 0.04, K.white, { y: 0.55 });
  return k.build();
}
function signGeo() {
  const k = new Kit();
  for (const x of [-0.7, 0.7]) k.box(0.1, 1.8, 0.1, K.woodDark, { x, y: 0.9 });
  k.box(1.7, 0.9, 0.08, K.signEdge, { y: 1.3 });
  k.box(1.5, 0.72, 0.1, K.sign, { y: 1.3 });
  k.box(1.1, 0.08, 0.11, K.signEdge, { y: 1.45 });
  k.box(0.8, 0.06, 0.11, K.signEdge, { y: 1.25 });
  k.box(1.0, 0.06, 0.11, K.signEdge, { y: 1.1 });
  k.box(1.9, 0.1, 0.25, K.woodDark, { y: 1.8 });
  return k.build();
}
