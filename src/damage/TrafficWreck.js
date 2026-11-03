import * as THREE from 'three';
import { VehicleDamage } from './VehicleDamage.js';
import { DEFORM_CELL, binKey, jitterRange } from './Deformer.js';
import { splitTriangles, LMAX } from './Split.js';

export { splitTriangles, LMAX };

// AI traffic is drawn as one InstancedMesh per model, so an instance has no vertices of its own to dent. When an AI
// car takes a real hit it is "promoted": it leaves the shared batch and gets its own copy of the same baked body
// (same traffic material and shader program, same pose, same paint), drawn as an InstancedMesh of one, and a
// VehicleDamage (TrafficWreckDamage) that dents it with the player's Deformer, breaks lamps and glass and throws off
// bumpers, hood, trunk and doors. The swap is invisible: identical surface, shading and transform.
//
// The baked low-LOD bodies have large flat triangles (edges up to 4-5 m) that cannot show a dent, so each model gets
// a template once: triangles are split until no edge is longer than LMAX (× size^0.75). The split
// decision depends only on the edge itself, so neighbouring triangles always split a shared edge at the same point
// (no T-junction cracks when vertices move). Templates also carry the vertex bins of the Deformer, lamp / glass /
// part vertex sets and shared GPU attributes; they are built in idle time (time-sliced) for models near the camera.

const DETACH_ZONE = { frontBumper: 'front', rearBumper: 'rear', hood: 'front', trunk: 'rear', doorFL: 'side', doorFR: 'side', doorRL: 'side', doorRR: 'side' };
const MASS = { hood: 18, trunk: 16, frontBumper: 12, rearBumper: 12 };
const CHAR = new THREE.Color(0x15120f);
const CRACKED = new THREE.Color(0x7d8b93);
const SHATTERED = new THREE.Color(0x050607);
const DEAD_LAMP = new THREE.Color(0x1a1c1f);
const LOG_MAX = 16;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const rnd = Math.random;

// ---------------------------------------------------------------- templates

/** Per-triangle group of the baked geometry: bake metadata (src/vehicle/bake.js `groups`) or a fallback that only
 *  knows lamps (aEmit) per side. */
function triGroups(baked, ntri) {
  const geo = baked.geo;
  const tg = new Uint16Array(ntri);
  if (baked.groups?.length) {
    const groups = baked.groups;
    for (let g = 0; g < groups.length; g++) {
      const t0 = (groups[g].start / 3) | 0, t1 = Math.min(ntri, ((groups[g].start + groups[g].count) / 3) | 0);
      for (let t = t0; t < t1; t++) tg[t] = g;
    }
    return { tg, groups };
  }
  const groups = [
    { mat: 'body', part: 'body' },
    { mat: 'head', part: 'lights', lamp: 'headL', kind: 'head' }, { mat: 'head', part: 'lights', lamp: 'headR', kind: 'head' },
    { mat: 'tail', part: 'lights', lamp: 'tailL', kind: 'tail' }, { mat: 'tail', part: 'lights', lamp: 'tailR', kind: 'tail' },
  ];
  const E = geo.attributes.aEmit?.array, P = geo.attributes.position.array;
  if (E) {
    for (let t = 0; t < ntri; t++) {
      const v = t * 3;
      const head = E[v * 2] > 0.5, tail = E[v * 2 + 1] > 0.5;
      if (!head && !tail) continue;
      const right = P[v * 3] + P[v * 3 + 3] + P[v * 3 + 6] > 0;
      tg[t] = (head ? 1 : 3) + (right ? 1 : 0);
    }
  }
  return { tg, groups };
}

/**
 * Template builder as a generator (yields every few hundred triangles / few thousand vertices so the work can be
 * spread over frames). Returns the template object.
 */
export function* templateJob(name, baked) {
  const geo = baked.geo;
  const A = geo.attributes;
  const P = A.position.array, N = A.normal?.array, C = A.color?.array, PA = A.aPaint?.array, EM = A.aEmit?.array;
  const ntri = (A.position.count / 3) | 0;
  const { tg, groups } = triGroups(baked, ntri);
  if (!geo.boundingBox) geo.computeBoundingBox();
  const len = baked.length || geo.boundingBox.max.z - geo.boundingBox.min.z || 4.5;
  const sizeK = THREE.MathUtils.clamp(len / 4.5, 0.5, 2.5);
  const lmax = LMAX * Math.pow(sizeK, 0.75);
  const L2 = lmax * lmax;

  // ---- split long edges (positions + normals, source triangle per output triangle); lamps stay whole
  const sp = yield* splitTriangles(P, N, ntri, L2, (t) => !!groups[tg[t]].lamp);
  let pos = sp.pos, nrm = sp.nrm;
  const src = sp.src, n = sp.n;

  // ---- per-vertex attributes (constant per source triangle) + classification
  const nv = n * 3;
  const col = new Float32Array(nv * 3), pa = new Float32Array(nv), em = new Float32Array(nv * 2);
  const partTris = new Map(), lampTris = new Map(), glass = [];
  const box = new THREE.Box3();
  let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
  for (let i = 0; i < n; i++) {
    const s = src[i] * 3; // first vertex of the source triangle
    const g = groups[tg[src[i]]];
    for (let k = 0; k < 3; k++) {
      const v = i * 3 + k;
      if (C) { col[v * 3] = C[s * 3]; col[v * 3 + 1] = C[s * 3 + 1]; col[v * 3 + 2] = C[s * 3 + 2]; }
      else col[v * 3] = col[v * 3 + 1] = col[v * 3 + 2] = 0.6;
      pa[v] = PA ? PA[s] : 0;
      if (EM) { em[v * 2] = EM[s * 2]; em[v * 2 + 1] = EM[s * 2 + 1]; }
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
      if (g.mat === 'glass') glass.push(v);
    }
    if (g.lamp) { let l = lampTris.get(g.lamp); if (!l) lampTris.set(g.lamp, (l = { kind: g.kind || g.mat, tris: [] })); l.tris.push(i); }
    else if (DETACH_ZONE[g.part]) { let l = partTris.get(g.part); if (!l) partTris.set(g.part, (l = [])); l.push(i); }
    if ((i & 511) === 511) yield;
  }
  box.min.set(minx, miny, minz);
  box.max.set(maxx, maxy, maxz);

  const triBox = (tris, b) => {
    b.makeEmpty();
    for (const i of tris) for (let k = 0; k < 9; k += 3) b.expandByPoint(_v.set(pos[i * 9 + k], pos[i * 9 + k + 1], pos[i * 9 + k + 2]));
    return b;
  };
  const parts = [];
  for (const [key, tris] of partTris) {
    const b = triBox(tris, new THREE.Box3());
    if (b.isEmpty()) continue;
    parts.push({ key, zone: DETACH_ZONE[key], tris, center: b.getCenter(new THREE.Vector3()), half: b.getSize(new THREE.Vector3()).multiplyScalar(0.5), radius: b.getSize(_v).length() / 2, box: b });
  }
  const lamps = [];
  for (const [name, l] of lampTris) {
    const b = triBox(l.tris, new THREE.Box3());
    const verts = new Int32Array(l.tris.length * 3);
    l.tris.forEach((i, j) => { verts[j * 3] = i * 3; verts[j * 3 + 1] = i * 3 + 1; verts[j * 3 + 2] = i * 3 + 2; });
    const center = b.getCenter(new THREE.Vector3());
    // a lamp sitting on a detachable panel (headlamp in the bumper, tail lamp in the trunk lid) leaves with it
    let part = null;
    for (const p of parts) if (p.box.clone().expandByScalar(0.06).containsPoint(center)) { part = p; break; }
    if (part) part.tris = part.tris.concat(l.tris);
    lamps.push({ name, kind: l.kind, verts, center, part: part?.key ?? null });
  }
  for (const p of parts) { p.tris = Int32Array.from(p.tris); delete p.box; }
  yield;

  // ---- Deformer bins (same cell / key as Deformer._bins, built from the template = original positions)
  const s = 1 / DEFORM_CELL;
  const lists = new Map();
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (let i = 0; i < nv; i++) {
    const ix = Math.floor(pos[i * 3] * s), iy = Math.floor(pos[i * 3 + 1] * s), iz = Math.floor(pos[i * 3 + 2] * s);
    if (ix < x0) x0 = ix; if (ix > x1) x1 = ix;
    if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
    if (iz < z0) z0 = iz; if (iz > z1) z1 = iz;
    const key = binKey(ix, iy, iz);
    let l = lists.get(key);
    if (!l) lists.set(key, (l = []));
    l.push(i);
    if ((i & 4095) === 4095) yield;
  }
  const bins = new Map();
  let nb = 0;
  for (const [k, l] of lists) { bins.set(k, Int32Array.from(l)); if ((++nb & 511) === 0) yield; }
  // Deformer per-vertex jitter of the template positions (shared, copy-on-write when a panel is removed)
  const jit = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i += 4096) { jitterRange(pos, jit, i, Math.min(nv, i + 4096)); yield; }

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return {
    name, baked, kind: baked.kind || 'car', lmax, tris: n, srcTris: ntri,
    pos, nrm, col, paint: pa, emit: em,
    nrmAttr: new THREE.BufferAttribute(nrm, 3), paintAttr: new THREE.BufferAttribute(pa, 1),
    box, sphere, bins, range: [x0, x1, y0, y1, z0, z1], jit,
    parts, lamps, glass: Int32Array.from(glass),
    bytes: n * 9 * 4 * 4 + nv * 3 * 4 + nv * 4 + nv * 16, used: 0,
  };
}

/** Wreck templates per traffic model: time-sliced background builds, synchronous fallback, LRU pruning. */
export class WreckTemplates {
  constructor() {
    this.map = new Map(); // model name -> template
    this.queue = []; // traffic types waiting for a template
    this.urgent = new Set(); // types a dented car is waiting for (built first, bigger time slices)
    this.job = null; // { T, gen, ms }
    this.stats = { built: 0, lastBuildMs: 0, maxBuildMs: 0, syncBuilds: 0, maxSliceMs: 0 };
  }

  get(T) {
    const t = this.map.get(T.name);
    if (!t || t.baked !== T.baked) return null;
    t.used = performance.now();
    return t;
  }

  /** Ask for a template in the background (no-op when ready); urgent = a dented car waits for it. */
  want(T, urgent = false) {
    if (!T?.baked?.geo || this.get(T)) return;
    if (urgent) this.urgent.add(T);
    if (this.job?.T === T) return;
    const i = this.queue.indexOf(T);
    if (urgent) { if (i >= 0) this.queue.splice(i, 1); this.queue.unshift(T); }
    else if (i < 0) this.queue.push(T);
  }

  get pressing() { return this.urgent.size > 0; }

  /** Advance background builds for up to `budgetMs`. */
  step(budgetMs = 0.6) {
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (!this.job) {
        const T = this.queue.shift();
        if (!T) break;
        if (this.get(T)) continue;
        this.job = { T, gen: templateJob(T.name, T.baked), ms: 0 };
      }
      const j = this.job;
      const s0 = performance.now();
      const r = j.gen.next();
      const sl = performance.now() - s0;
      j.ms += sl;
      this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, sl);
      if (r.done) this._finish(j, r.value);
    }
  }

  /** Template now (finishes a running background job for this model, or builds it synchronously). */
  build(T) {
    if (!T?.baked?.geo) return null;
    const ready = this.get(T);
    if (ready) return ready;
    let j = this.job?.T === T ? this.job : { T, gen: templateJob(T.name, T.baked), ms: 0 };
    const t0 = performance.now();
    let r;
    do r = j.gen.next(); while (!r.done);
    j.ms += performance.now() - t0;
    this.stats.syncBuilds++;
    const i = this.queue.indexOf(T);
    if (i >= 0) this.queue.splice(i, 1);
    return this._finish(j, r.value);
  }

  _finish(j, tpl) {
    if (this.job === j) this.job = null;
    this.urgent.delete(j.T);
    tpl.used = performance.now();
    tpl.buildMs = j.ms;
    this.map.set(j.T.name, tpl);
    this.stats.built++;
    this.stats.lastBuildMs = j.ms;
    this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, j.ms);
    return tpl;
  }

  /** Drop templates nobody needs (not in `keep`), oldest first, down to `max`. */
  prune(keep, max = 12) {
    if (this.map.size <= max) return;
    const list = [...this.map.entries()].filter(([name]) => !keep.has(name)).sort((a, b) => a[1].used - b[1].used);
    for (const [name] of list) {
      if (this.map.size <= max) break;
      this.map.delete(name);
    }
  }

  get bytes() { let b = 0; for (const t of this.map.values()) b += t.bytes; return b; }

  dispose() { this.map.clear(); this.queue.length = 0; this.urgent.clear(); this.job = null; }
}

// ---------------------------------------------------------------- wreck damage

function disposeDebris(it) {
  it.obj.removeFromParent();
  it.obj.geometry?.dispose();
  it.obj.dispose?.();
}

/**
 * VehicleDamage for a promoted AI traffic car: same dents (Deformer), lamp / glass breakage and part detachment as
 * the player's car, expressed with vertex attributes of its own body copy (the traffic material is shared, so no
 * material is ever touched). Gameplay health (smoke, fire, explosion) stays with DamageSystem's agent records; this
 * object is the visual state, plus radiator steam after frontal hits.
 */
export class TrafficWreckDamage extends VehicleDamage {
  /** Promote agent `a` of traffic `tr` with template `tpl`. */
  static create(sys, tr, a, tpl) {
    const lift = a.lift + a.halfH;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tpl.pos.slice(), 3));
    geo.setAttribute('normal', tpl.nrmAttr); // shared (never modified)
    geo.setAttribute('color', new THREE.BufferAttribute(tpl.col.slice(), 3));
    geo.setAttribute('aPaint', tpl.paintAttr); // shared
    geo.setAttribute('aEmit', new THREE.BufferAttribute(tpl.emit.slice(), 2));
    const tint = new THREE.InstancedBufferAttribute(new Float32Array([a.paint.r, a.paint.g, a.paint.b]), 3);
    const brake = new THREE.InstancedBufferAttribute(new Float32Array([a.brake || 0]), 1);
    tint.setUsage(THREE.DynamicDrawUsage);
    brake.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTint', tint);
    geo.setAttribute('aBrake', brake);
    geo.boundingBox = tpl.box.clone();
    geo.boundingSphere = tpl.sphere.clone();
    const mesh = new THREE.InstancedMesh(geo, tr.material, 1);
    mesh.name = 'traffic:wreck';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(0, -lift, 0); // model origin is on the ground, the body centre lift+halfH above it
    const root = new THREE.Group();
    root.name = 'traffic:wreckRoot';
    root.position.copy(a.cur);
    root.quaternion.copy(a.cq);
    root.add(mesh);
    tr.scene.add(root);
    const v = {
      body: a.body, object3d: root, mesh, kind: tpl.kind, explosionPower: 0, materials: {}, model: null,
      agent: a, tpl, lift, trafficWreck: true,
    };
    return new TrafficWreckDamage(sys, v);
  }

  constructor(sys, v) {
    super(sys, v); // the _collect* overrides below read this.v.tpl
    this.agent = v.agent;
    this.tpl = v.tpl;
    this.mesh = v.mesh;
    this.lift = v.lift;
    this.log = [];
    this.flammable = false; // fire / explosion are driven by the agent record (DamageSystem.agentHit)
    this.deformer.setBins(this.mesh, this.tpl.bins, this.tpl.range, this.tpl.jit);
    this._warm = true;
    this.mesh.computeBoundingSphere(); // InstancedMesh culling sphere, after the Deformer grew the geometry's
    v.damage = this;
  }

  // ---------- setup overrides (VehicleDamage constructor) ----------

  _collectMeshes() { return [this.v.mesh]; }

  _collectParts() {
    const lift = this.v.lift;
    return this.v.tpl.parts.map((p) => ({
      key: p.key, zone: p.zone, tris: p.tris,
      cg: p.center.clone(), // template (ground) space
      center: p.center.clone().setY(p.center.y - lift), // body space
      radius: p.radius, half: p.half.clone(), dmg: 0, detached: false, item: null,
    }));
  }

  _collectLamps() {
    const lift = this.v.lift;
    return this.v.tpl.lamps.map((l) => ({
      name: l.name, kind: l.kind, verts: l.verts, part: l.part, cg: l.center.clone(),
      center: l.center.clone().setY(l.center.y - lift), broken: false,
    }));
  }

  _collectMaterials() { return new Map(); } // the traffic material is shared: never charred / tinted per car

  // ---------- damage ----------

  applyImpact(pointW, inwardW, e, info = {}) {
    if (this.disposed || e <= 0.01) return;
    this._record(pointW, inwardW, e, info);
    super.applyImpact(pointW, inwardW, e, info);
  }

  // impacts in the model's ground frame, for handing the damage over to a full vehicle (carjacking / takeover)
  _record(pointW, inwardW, e, info) {
    const pl = this._toLocal(pointW, _v);
    const dl = this._dirToLocal(inwardW, _w);
    const rec = { p: [pl.x, pl.y + this.lift, pl.z], d: [dl.x, dl.y, dl.z], e, s: info.scrape ? 1 : 0 };
    if (this.log.length < LOG_MAX) { this.log.push(rec); return; }
    let mi = 0;
    for (let i = 1; i < this.log.length; i++) if (this.log[i].e < this.log[mi].e) mi = i;
    if (this.log[mi].e < e) this.log[mi] = rec;
  }

  setGlass(level, pointW, dirW, quiet = false) {
    if (level <= this.glass) return;
    this.glass = level;
    this._paintVerts(this.tpl.glass, level === 1 ? CRACKED : SHATTERED);
    if (level === 1 && pointW && this.game.fx && !quiet && this.tpl.glass.length) this.game.fx.glass(pointW, dirW ? _w.copy(dirW).multiplyScalar(0.15) : { x: 0, y: 0.2, z: 0 }, 7);
    if (level === 2 && this.game.fx && !quiet && this.tpl.glass.length) {
      const p = pointW || this._toWorld(_v.set(this.center.x, this.bbox.max.y - this.size.y * 0.25, this.center.z), new THREE.Vector3());
      this.game.fx.glass(p, dirW ? _w.copy(dirW).multiplyScalar(0.4) : { x: 0, y: 0.3, z: 0 }, 36);
    }
  }

  breakLamp(l, kind, quiet = false) {
    if (!l) {
      for (const x of this.lamps) if (!x.broken && (x.kind === kind || (kind === 'tail' && x.kind === 'amber' && x.center.z > this.center.z))) this.breakLamp(x, null, quiet);
      return;
    }
    if (l.broken) return;
    l.broken = true;
    const geo = this.mesh.geometry;
    const E = geo.attributes.aEmit;
    for (let q = 0; q < l.verts.length; q++) { const v = l.verts[q]; E.array[v * 2] = 0; E.array[v * 2 + 1] = 0; }
    E.needsUpdate = true;
    this._paintVerts(l.verts, DEAD_LAMP);
    if (this.game.fx && !quiet) {
      const p = this._toWorld(l.center, new THREE.Vector3());
      this.game.fx.glass(p, { x: 0, y: 0.2, z: 0 }, 8);
      this.game.fx.sparks(p, { x: 0, y: 0.5, z: 0 }, 4, { speed: 2.5, life: 0.25 });
    }
  }

  _spotsOff() {}

  _paintVerts(verts, c) {
    if (!verts?.length) return;
    const A = this.mesh.geometry.attributes.color;
    const C = A.array;
    for (let q = 0; q < verts.length; q++) { const v = verts[q] * 3; C[v] = c.r; C[v + 1] = c.g; C[v + 2] = c.b; }
    A.needsUpdate = true;
  }

  // the part's triangles (as dented now) become a debris body; they collapse to a point in the car
  detach(p, dirW, e = 1) {
    const fx = this.game.fx;
    if (p.detached || this.disposed || !fx?.debrisSys || !p.tris.length) return;
    p.detached = true;
    const tpl = this.tpl;
    const geo = this.mesh.geometry;
    const Pa = geo.attributes.position.array, Ca = geo.attributes.color.array, Ea = geo.attributes.aEmit.array;
    const tris = p.tris, n = tris.length, c = p.cg;
    const pos = new Float32Array(n * 9), nrm = new Float32Array(n * 9), col = new Float32Array(n * 9);
    const pa = new Float32Array(n * 3), em = new Float32Array(n * 6), verts = new Int32Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = tris[i] * 3 + k, o = i * 3 + k;
        verts[o] = v;
        pos[o * 3] = Pa[v * 3] - c.x; pos[o * 3 + 1] = Pa[v * 3 + 1] - c.y; pos[o * 3 + 2] = Pa[v * 3 + 2] - c.z;
        nrm[o * 3] = tpl.nrm[v * 3]; nrm[o * 3 + 1] = tpl.nrm[v * 3 + 1]; nrm[o * 3 + 2] = tpl.nrm[v * 3 + 2];
        col[o * 3] = Ca[v * 3]; col[o * 3 + 1] = Ca[v * 3 + 1]; col[o * 3 + 2] = Ca[v * 3 + 2];
        pa[o] = tpl.paint[v];
        em[o * 2] = Ea[v * 2]; em[o * 2 + 1] = Ea[v * 2 + 1];
      }
    }
    for (const l of this.lamps) if (l.part === p.key) l.broken = true; // left with the panel
    this.deformer.collapse(this.mesh, verts, c);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPaint', new THREE.BufferAttribute(pa, 1));
    g.setAttribute('aEmit', new THREE.BufferAttribute(em, 2));
    const paint = this.agent.paint;
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array([paint.r, paint.g, paint.b]), 3));
    g.setAttribute('aBrake', new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
    g.computeBoundingSphere();
    const obj = new THREE.InstancedMesh(g, this.mesh.material, 1);
    obj.name = `traffic:part:${p.key}`;
    obj.castShadow = obj.receiveShadow = true;
    this.root.updateMatrixWorld(true);
    obj.position.copy(c).applyMatrix4(this.mesh.matrixWorld);
    this.root.getWorldQuaternion(obj.quaternion);
    const lv = this.v.body.linvel();
    const s = 2.5 + 4 * Math.min(1.3, e);
    const side = p.zone === 'side';
    const out = side ? this._toWorld(_v.copy(p.center), new THREE.Vector3()).sub(this._toWorld(_w.set(0, p.center.y, p.center.z), new THREE.Vector3())).normalize() : null;
    const vel = {
      x: lv.x * 0.8 - (dirW?.x || 0) * s * 0.3 + (out ? out.x * s : (rnd() - 0.5) * 2),
      y: lv.y * 0.5 + 2 + rnd() * 3 * e,
      z: lv.z * 0.8 - (dirW?.z || 0) * s * 0.3 + (out ? out.z * s : (rnd() - 0.5) * 2),
    };
    p.item = fx.debrisSys.spawnMesh(obj, {
      half: p.half, center: { x: 0, y: 0, z: 0 }, mass: p.key.startsWith('door') ? 28 : MASS[p.key] ?? 14,
      vel, angvel: { x: (rnd() - 0.5) * 8, y: (rnd() - 0.5) * 6, z: (rnd() - 0.5) * 8 }, life: 90, onExpire: disposeDebris,
    });
    fx.sparks(this._toWorld(p.center, new THREE.Vector3()), { x: vel.x, y: 1, z: vel.z }, 14);
    this.game.events?.emit('vehicle:part', { vehicle: this.v, agent: this.agent, part: p.key, traffic: true });
  }

  _char(k) {
    const A = this.mesh.geometry.attributes.color;
    const C = A.array, O = this.tpl.col;
    const f = k * 0.96;
    for (let i = 0; i < C.length; i += 3) {
      C[i] = O[i] + (CHAR.r - O[i]) * f;
      C[i + 1] = O[i + 1] + (CHAR.g - O[i + 1]) * f;
      C[i + 2] = O[i + 2] + (CHAR.b - O[i + 2]) * f;
    }
    if (this.glass) this._paintVerts(this.tpl.glass, this.glass === 1 ? CRACKED : SHATTERED);
    for (const l of this.lamps) if (l.broken) this._paintVerts(l.verts, DEAD_LAMP);
    A.needsUpdate = true;
  }

  ignite() {} // see DamageSystem.igniteAgent

  /** Visual blast of the car itself (DamageSystem.explodeAgent does the explosion, fire and smoke). */
  explode() {
    if (this.state === 'destroyed' || this.disposed) return;
    this.state = 'destroyed';
    this.engine = 0;
    this.body = Math.min(this.body, 0.1);
    for (let i = 0; i < 4; i++) {
      const d = _v.set(rnd() - 0.5, -0.3 - rnd() * 0.7, rnd() - 0.5).normalize();
      const pl = this.surfacePoint(d, _w);
      this.deformer.deform(pl, d.clone(), 1.1 * Math.sqrt(this.sizeK), 0.22 * this.sizeK);
    }
    this.setGlass(2);
    for (const l of this.lamps) if (!l.broken) this.breakLamp(l, null, true);
    for (const part of this.parts) {
      const chance = part.key === 'hood' ? 0.85 : part.key === 'trunk' ? 0.6 : part.key.includes('Bumper') ? 0.5 : 0.35;
      if (!part.detached && rnd() < chance) this.detach(part, { x: 0, y: -1, z: 0 }, 1.4);
    }
    this._char(1);
  }

  update(dt) {
    if (this.disposed) return;
    // radiator steam after frontal hits (engine smoke / fire come from the agent record)
    if (this.steamT > 0) {
      this.steamT -= dt;
      const fx = this.game.fx;
      if (!this.steamH && fx && this.state === 'ok') {
        const off = new THREE.Vector3(0, this.enginePos.y, this.bbox.min.z + 0.25);
        this.steamH = fx.steam(this.engineWorld(), { attachTo: this.root, offset: off, size: 0.5 * Math.sqrt(this.sizeK), rate: 16 });
      }
      if ((this.steamT <= 0 || this.state !== 'ok') && this.steamH) { this.steamH.stop(1); this.steamH = null; }
    }
  }

  repair() {}

  /** Damage to hand over to a full vehicle of the same model (see VehicleDamage.restore). */
  snapshot() {
    return {
      impacts: this.log.map((r) => ({ p: r.p.slice(), d: r.d.slice(), e: r.e, s: r.s })),
      lamps: this.lamps.filter((l) => l.broken).map((l) => ({ kind: l.kind, c: [l.cg.x, l.cg.y, l.cg.z] })),
      glass: this.glass,
      parts: this.parts.filter((p) => p.detached).map((p) => p.key),
      engine: this.engine,
      body: this.body,
    };
  }

  /** Per frame (Traffic.updateVisual): pose of the body centre, paint and brake lamps. */
  sync(pos, quat, paint, brake) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    const A = this.mesh.geometry.attributes;
    const t = A.aTint, b = A.aBrake;
    if (t.array[0] !== paint.r || t.array[1] !== paint.g || t.array[2] !== paint.b) { t.array[0] = paint.r; t.array[1] = paint.g; t.array[2] = paint.b; t.needsUpdate = true; }
    if (b.array[0] !== brake) { b.array[0] = brake; b.needsUpdate = true; }
  }

  /** Back to the shared batch / gone with the agent. Debris already flying keeps living unless `dropDebris`. */
  dispose(dropDebris = false) {
    if (this.disposed) return;
    this._killFx();
    if (dropDebris) for (const p of this.parts) if (p.detached && p.item && !p.item.removed) this.game.fx?.debrisSys.removeMesh(p.item, true);
    this.deformer.dispose();
    this.disposed = true;
    const g = this.mesh.geometry;
    g.deleteAttribute('normal'); // shared template buffers stay on the GPU for the other copies
    g.deleteAttribute('aPaint');
    g.dispose();
    this.mesh.dispose?.();
    this.root.removeFromParent();
    this.sys._removeWreck?.(this);
    if (this.agent.wreck === this) this.agent.wreck = null;
  }
}
