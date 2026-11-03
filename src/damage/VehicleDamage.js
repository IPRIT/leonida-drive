import * as THREE from 'three';
import { Deformer } from './Deformer.js';
import { splitTriangles, LMAX } from './Split.js';

// zone of detachable parts (model.parts from the vehicles workstream)
const DETACH = { frontBumper: 'front', rearBumper: 'rear', hood: 'front', trunk: 'rear', doorFL: 'side', doorFR: 'side', doorRL: 'side', doorRR: 'side' };
// explosion power per kind (0 = does not burn/explode)
const POWER = { car: 1, van: 1.1, small: 0.75, truck: 1.6, bus: 1.7, motorcycle: 0.55, bicycle: 0, heli: 1.8, plane: 2.1, boat: 1.2 };
const CARLIKE = new Set(['car', 'van', 'small', 'truck', 'bus']);
const CHAR = new THREE.Color(0x15120f);
const CRACKED = new THREE.Color(0x7d8b93);
const SHATTERED = new THREE.Color(0x050607);
// panels bend, then hang, then come off: part damage at which the latch / clips let go (detach stays at > 1)
const LOOSE_AT = 0.42;
const WHEEL = { burstE: 0.4, offE: 0.95, burstR: 0.8, offR: 0.4, burstGrip: 0.55, offGrip: 0.3, burstDrag: 90, offDrag: 260 };
const PART_LIFE = 90; // s, detached panels / wheels stay on the road
// Explosions: ignition chance from the blast energy at the car, q = power × falloff (falloff = (1 - d/R)^1.2).
// Below q0 a blast practically never ignites (debris pops, the edge of a small blast); from q1 on it always does
// (a car bomb next to it). Cumulative engine damage still ignites at <= 15 % as before.
export const IGNITE = { q0: 0.08, q1: 0.6, k: 1.6 };
export function igniteChance(q) {
  const x = (q - IGNITE.q0) / (IGNITE.q1 - IGNITE.q0);
  return x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, IGNITE.k);
}
const REFINE_KINDS = new Set(['car', 'van', 'small', 'truck', 'bus', 'motorcycle']);

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _box = new THREE.Box3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _pt = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _sparkO = { speed: 4, spread: 0.6, life: 0.35 };
const rnd = Math.random;

function boxIn(space, obj, out = new THREE.Box3()) {
  out.makeEmpty();
  _inv.copy(space.matrixWorld).invert();
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _m.multiplyMatrices(_inv, o.matrixWorld);
    out.union(_box.copy(o.geometry.boundingBox).applyMatrix4(_m));
  });
  return out;
}

// Per-vehicle damage state (stored as controllable.damage).
export class VehicleDamage {
  constructor(sys, v) {
    this.sys = sys;
    this.game = sys.game;
    this.v = v;
    this.root = v.object3d;
    this.engine = 1; // 0..1, drives smoke -> fire -> explosion
    this.body = 1; // 0..1, cosmetic/body integrity
    this.state = 'ok'; // ok | burning | destroyed
    this.kind = v.kind || 'car';
    this.power = v.explosionPower ?? POWER[this.kind] ?? 1;
    this.flammable = this.power > 0;
    this.disposed = false;
    this.root.updateMatrixWorld(true);
    const meshes = this._collectMeshes();
    const pre = new THREE.Box3();
    for (const m of meshes) pre.union(boxIn(this.root, m, _box.clone()));
    const len = Math.max(1, pre.isEmpty() ? 4.5 : pre.max.z - pre.min.z);
    this.sizeK = THREE.MathUtils.clamp(len / 4.5, 0.5, 2.5);
    this.deformer = new Deformer(this.root, meshes, { maxCrumple: THREE.MathUtils.clamp(0.1 * len, 0.22, 0.85) });
    this.bbox = this.deformer.bounds();
    if (this.bbox.isEmpty()) this.bbox.set(new THREE.Vector3(-0.9, -0.3, -2.2), new THREE.Vector3(0.9, 1.1, 2.2));
    this.size = this.bbox.getSize(new THREE.Vector3());
    this.center = this.bbox.getCenter(new THREE.Vector3());
    this.enginePos = this._enginePos();
    this.parts = this._collectParts();
    this.lamps = this._collectLamps();
    this.mats = this._collectMaterials();
    this.wheels = this._collectWheels();
    this.looseN = 0; // panels hanging loose (swing simulated in update)
    this.leakT = 0; // s leaking fuel (engine < 30 %): stains under the car, they catch fire with it
    this.puddles = [];
    this.glass = 0; // 0 intact, 1 cracked, 2 shattered
    this.burnT = 0;
    this.fuse = 0;
    this.wreckT = 0;
    this.upsideT = 0;
    this.steamT = 0;
    this.fireH = null;
    this.smokeH = null;
    this.smokeKind = null;
    this.steamH = null;
    this.suppress = 0;
    this.hasPrev = false;
    this.pl = { x: 0, y: 0, z: 0 };
    this.pp = { x: 0, y: 0, z: 0 };
    this.lastImpact = 0;
    this._refine = REFINE_KINDS.has(this.kind) && !v.damageMeshes && !v.trafficWreck ? this._refineJob() : null;
    this._patch();
  }

  get health() { return this.engine; }
  get burning() { return this.state === 'burning'; }
  get destroyed() { return this.state === 'destroyed'; }

  // ---------- setup ----------

  _collectMeshes() {
    const v = this.v;
    if (Array.isArray(v.damageMeshes)) return v.damageMeshes;
    const skip = new Set();
    for (const w of v.model?.wheels || v.wheelVisuals || []) skip.add(w.pivot || w);
    for (const w of v.model?.parts?.wheels || []) skip.add(w);
    const out = [];
    const walk = (o) => {
      if (skip.has(o)) return;
      if (o.isMesh && !o.isInstancedMesh && !/wheel|tire|rim|spoke|rotor|propeller|blade/i.test(o.name)) out.push(o);
      for (const c of o.children) walk(c);
    };
    walk(this.root);
    return out;
  }

  _enginePos() {
    const v = this.v;
    if (v.enginePos?.isVector3) return v.enginePos.clone();
    const ep = v.model?.enginePos;
    const body = v.model?.body;
    if (ep && body) {
      _inv.copy(this.root.matrixWorld).invert();
      _m.multiplyMatrices(_inv, body.matrixWorld);
      const p = new THREE.Vector3(ep[0] ?? ep.x, ep[1] ?? ep.y, ep[2] ?? ep.z).applyMatrix4(_m);
      if (this.bbox.clone().expandByScalar(0.5).containsPoint(p)) return p;
    }
    const b = this.bbox, s = this.size;
    return new THREE.Vector3(0, b.min.y + s.y * 0.55, b.min.z + s.z * 0.2);
  }

  _collectParts() {
    const P = this.v.model?.parts;
    if (!P) return [];
    const out = [];
    for (const key of Object.keys(DETACH)) {
      const obj = P[key];
      if (!obj?.isObject3D || !obj.parent) continue;
      const rb = boxIn(this.root, obj);
      if (rb.isEmpty()) continue;
      const lb = boxIn(obj, obj);
      out.push({
        key, zone: DETACH[key], obj, parent: obj.parent,
        pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone(),
        center: rb.getCenter(new THREE.Vector3()), radius: rb.getSize(new THREE.Vector3()).length() / 2,
        half: lb.getSize(new THREE.Vector3()).multiplyScalar(0.5), lcenter: lb.getCenter(new THREE.Vector3()),
        dmg: 0, detached: false, item: null,
        hinge: obj.userData?.hinge ? { ...obj.userData.hinge } : null, loose: false, ang: 0, angV: 0, rest: 0, max: 0,
        axis: null, sign: 1, H: null, c0: null,
      });
    }
    return out;
  }

  _collectLamps() {
    const out = [];
    const lm = this.v.model?.lampMeshes;
    if (lm) {
      for (const mesh of Object.values(lm)) {
        if (!mesh?.isMesh) continue;
        const b = boxIn(this.root, mesh);
        out.push({ mesh, kind: mesh.userData?.kind || mesh.name, mat: mesh.material, center: b.getCenter(new THREE.Vector3()), broken: false });
      }
    }
    return out;
  }

  _collectMaterials() {
    const mats = new Map();
    const add = (m) => {
      if (!m || mats.has(m) || !m.color) return;
      mats.set(m, {
        color: m.color.getHex(), emissive: m.emissive ? m.emissive.getHex() : null,
        roughness: m.roughness, metalness: m.metalness,
      });
    };
    for (const m of Object.values(this.v.materials || {})) add(m);
    this.root.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(add); });
    return mats;
  }

  // wrap the controllable's fixedUpdate so a wrecked/limping vehicle can't be driven normally
  _patch() {
    const v = this.v;
    if (typeof v.fixedUpdate !== 'function') return;
    this._own = Object.prototype.hasOwnProperty.call(v, 'fixedUpdate');
    const orig = (this._origFU = v.fixedUpdate);
    const self = this;
    const tmp = {};
    v.fixedUpdate = function (dt, input) {
      if (input && (self.state === 'destroyed' || self.engine < 0.35)) input = self._filter(input, tmp);
      return orig.call(this, dt, input);
    };
  }

  _unpatch() {
    if (!this._origFU) return;
    if (this._own) this.v.fixedUpdate = this._origFU;
    else delete this.v.fixedUpdate;
    this._origFU = null;
  }

  _filter(inp, out) {
    Object.assign(out, inp);
    if (this.state === 'destroyed') {
      out.throttle = 0; out.boost = false; out.handbrake = true; out.brake = Math.max(inp.brake || 0, 0.2);
    } else {
      out.throttle = (inp.throttle || 0) * (0.35 + this.engine * 1.5);
      out.boost = !!inp.boost && this.engine > 0.25;
    }
    return out;
  }

  // ---------- coordinate helpers ----------

  _toLocal(p, out) {
    const b = this.v.body;
    const t = b.translation(), r = b.rotation();
    _qi.set(r.x, r.y, r.z, r.w).invert();
    return out.set(p.x - t.x, p.y - t.y, p.z - t.z).applyQuaternion(_qi);
  }

  _dirToLocal(d, out) {
    const r = this.v.body.rotation();
    _qi.set(r.x, r.y, r.z, r.w).invert();
    return out.set(d.x, d.y, d.z).applyQuaternion(_qi).normalize();
  }

  _toWorld(p, out) {
    const b = this.v.body;
    const t = b.translation(), r = b.rotation();
    return out.copy(p).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_w.set(t.x, t.y, t.z));
  }

  /** World position of the engine (fire source). */
  engineWorld(out = new THREE.Vector3()) { return this._toWorld(this.enginePos, out); }

  // nearest point on the local bbox surface in direction -dir from the centre (for impacts without contacts)
  surfacePoint(dirLocal, out) {
    const h = this.size;
    const tx = Math.abs(dirLocal.x) > 1e-4 ? (h.x / 2) / Math.abs(dirLocal.x) : 1e9;
    const ty = Math.abs(dirLocal.y) > 1e-4 ? (h.y / 2) / Math.abs(dirLocal.y) : 1e9;
    const tz = Math.abs(dirLocal.z) > 1e-4 ? (h.z / 2) / Math.abs(dirLocal.z) : 1e9;
    const t = Math.min(tx, ty, tz);
    return out.copy(this.center).addScaledVector(dirLocal, -t);
  }

  // ---------- damage ----------

  /**
   * Collision damage. pointW/inwardW in world space (inward = into the vehicle), e = energy 0..~1.3.
   * info: { scrape, material, kind, explosion }
   */
  applyImpact(pointW, inwardW, e, info = {}) {
    if (this.disposed || e <= 0.01) return;
    if (this._refine) this.refineNow(); // a dent on a half-refined body would crack along the seams
    const pl = this._toLocal(pointW, new THREE.Vector3());
    const dl = this._dirToLocal(inwardW, new THREE.Vector3());
    const R = this._dent(pl, dl, e, !!info.scrape);
    this.sys.stats.lastDeformMs = this._dentMs;
    this.lastImpact = this.game.time;
    if (this.wheels.length && e > WHEEL.burstE) this._wheelHits(pl, R, e);

    // health
    if (this.state !== 'destroyed') {
      const prox = 1 - THREE.MathUtils.clamp(pl.distanceTo(this.enginePos) / (this.size.z * 0.6), 0, 1);
      this.engine = Math.max(0, this.engine - e * (0.3 + 0.7 * prox) * 0.425); // half the old rate: fires take twice as many hits
      this.body = Math.max(0, this.body - e * 0.6);
      if (e > 1.05 && this.flammable) this.engine = Math.min(this.engine, 0.12);
      const front = pl.z < this.center.z - this.size.z * 0.25;
      if (front && e > 0.25 && this.engine > 0.15) this.steamT = Math.max(this.steamT, 3 + e * 6);
    }
    // parts
    for (const p of this.parts) {
      if (p.detached) continue;
      const w = THREE.MathUtils.clamp(1 - pl.distanceTo(p.center) / (R + p.radius * 0.6), 0, 1);
      p.dmg += e * w * 1.5;
      if (p.dmg > 1 && e > 0.3) this.detach(p, inwardW, e);
      else if (!p.loose && p.dmg > LOOSE_AT && e > 0.12) this._loosen(p, pl, e);
    }
    // lamps
    if (e > 0.18) {
      if (this.lamps.length) {
        for (const l of this.lamps) if (!l.broken && pl.distanceTo(l.center) < R * 0.9 + 0.15) this.breakLamp(l);
      } else {
        if (pl.z < this.center.z - this.size.z * 0.3) this.breakLamp(null, 'head');
        if (pl.z > this.center.z + this.size.z * 0.3) this.breakLamp(null, 'tail');
      }
    }
    // glass
    const upper = pl.y > this.bbox.min.y + this.size.y * 0.45;
    if ((upper && e > 0.75) || e > 1.1 || info.explosion > 0.3) this.setGlass(2, pointW, inwardW);
    else if ((upper && e > 0.22) || e > 0.48 || this.body < 0.55) this.setGlass(1, pointW, inwardW);
    // fx
    const fx = this.game.fx;
    if (fx && !info.quiet) {
      _v.copy(inwardW).negate();
      fx.hit(pointW, { normal: _v, strength: Math.min(1, e), material: 'metal' });
    }
  }

  // dent at a body-space point (inward direction dl) with impact energy e; returns the dent radius
  _dent(pl, dl, e, scrape = false) {
    const k = this.sizeK;
    const R = (0.42 + 1.1 * Math.min(e, 1.2)) * Math.sqrt(k);
    const depth = (0.07 + 0.4 * Math.min(e, 1.3)) * k * (scrape ? 0.45 : 1); // ~35 % deeper dents
    const t0 = performance.now();
    this.deformer.deform(pl, dl, R, depth);
    // structure: crumple zones fold the whole nose / tail, side hits push the door in, a roof landing flattens the roof
    if (e > 0.2 && !scrape) {
      if (Math.abs(dl.z) > 0.7) {
        _v.set(pl.x * 0.4, this.center.y, dl.z > 0 ? this.bbox.min.z : this.bbox.max.z);
        this.deformer.deform(_v, dl, R * 1.35, depth * 0.45);
      } else if (Math.abs(dl.x) > 0.7) {
        this.deformer.deform(pl, dl, R * 0.55, depth * 0.5);
      } else if (dl.y < -0.6) {
        _v.set(this.center.x, this.bbox.max.y, pl.z);
        this.deformer.deform(_v, dl, Math.max(R * 1.2, this.size.x * 0.6), depth * 0.6);
      }
    }
    this._dentMs = performance.now() - t0;
    return R;
  }

  // ---------- refinement: smooth dents on coarse bodies ----------

  /**
   * Coarse bodies (the hand-made original designs have ~500 triangles, many models have 1-5 m panels) cannot show a
   * dent: the long triangles are split like the traffic wreck templates (edges <= LMAX × size^0.75, conforming, so
   * no seams open up). Runs in the background after spawn, one mesh swap per frame (spreads the GPU uploads); an
   * impact before it is done finishes it synchronously first. Each mesh keeps its part / material.
   */
  *_refineJob() {
    const lmax = LMAX * Math.pow(this.sizeK, 0.75), L2 = lmax * lmax;
    for (const e of [...this.deformer.entries]) {
      const mesh = e.mesh;
      if (mesh.userData?.lamp || e.dirty || !mesh.parent) continue;
      let g = e.geo;
      if (g.index) g = g.toNonIndexed();
      const P = g.attributes.position.array, N = g.attributes.normal?.array || null;
      const nt = (P.length / 9) | 0;
      let long = false;
      for (let t = 0; t < nt && !long; t++) {
        const i = t * 9;
        long = (P[i] - P[i + 3]) ** 2 + (P[i + 1] - P[i + 4]) ** 2 + (P[i + 2] - P[i + 5]) ** 2 > L2
          || (P[i + 3] - P[i + 6]) ** 2 + (P[i + 4] - P[i + 7]) ** 2 + (P[i + 5] - P[i + 8]) ** 2 > L2
          || (P[i + 6] - P[i]) ** 2 + (P[i + 7] - P[i + 1]) ** 2 + (P[i + 8] - P[i + 2]) ** 2 > L2;
      }
      if (!long) continue;
      const r = yield* splitTriangles(P, N, nt, L2);
      if (e.dirty || this.disposed) continue; // dented meanwhile (cannot happen: impacts finish the job first)
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
      ng.setAttribute('normal', new THREE.BufferAttribute(r.nrm, 3));
      const old = this.deformer.replaceGeometry(mesh, ng);
      if (old && old !== ng) old.dispose();
      if (g !== e.geo && g !== old) g.dispose?.();
      this.refined = (this.refined || 0) + 1;
      this._warm = false;
      yield 'swap';
    }
  }

  /** Background refinement step (update): up to `budgetMs`, at most one mesh swap. */
  _stepRefine(budgetMs = 0.5) {
    const t0 = performance.now();
    while (this._refine && performance.now() - t0 < budgetMs) {
      const r = this._refine.next();
      if (r.done) { this._refine = null; this._refineMs = (this._refineMs || 0) + performance.now() - t0; return; }
      if (r.value === 'swap') break;
    }
    this._refineMs = (this._refineMs || 0) + performance.now() - t0;
  }

  /** Finish refinement now (before the first dent, carjack restore). */
  refineNow() {
    if (!this._refine) return;
    const t0 = performance.now();
    let r;
    do r = this._refine.next(); while (!r.done);
    this._refine = null;
    const ms = performance.now() - t0;
    this._refineMs = (this._refineMs || 0) + ms;
    this.sys.stats.lastRefineSyncMs = ms;
  }

  applyExplosion(pos, Pw, R, d) {
    if (this.disposed) return;
    const f = Math.pow(THREE.MathUtils.clamp(1 - d / R, 0, 1), 1.2);
    if (f <= 0) return;
    const c = this._toWorld(this.center, new THREE.Vector3());
    const inward = new THREE.Vector3().subVectors(c, pos);
    if (inward.lengthSq() < 1e-4) inward.set(0, -1, 0);
    inward.normalize();
    const dl = this._dirToLocal(inward, new THREE.Vector3());
    const pl = this.surfacePoint(dl, new THREE.Vector3());
    const e = Math.min(1.3, Pw * f * 1.5);
    const pw = this._toWorld(pl, new THREE.Vector3());
    this.applyImpact(pw, inward, e, { explosion: f, quiet: true });
    if (e > 0.5) {
      pl.x += (rnd() - 0.5) * this.size.x * 0.5;
      pl.y += (rnd() - 0.3) * this.size.y * 0.4;
      this.deformer.deform(pl, dl, 0.8 * Math.sqrt(this.sizeK), 0.15 * e * this.sizeK);
    }
    if (this.state !== 'destroyed') {
      this.engine = Math.max(0, this.engine - Pw * f * 1.4);
      this.body = Math.max(0, this.body - Pw * f);
    }
    if (f > 0.5) for (const l of this.lamps) if (!l.broken) this.breakLamp(l);
    for (const p of this.parts) {
      if (p.detached) continue;
      p.dmg += f * 2.2 * (0.6 + rnd() * 0.8);
      if (p.dmg > 1) this.detach(p, inward, f * 1.5);
    }
    this.suppress = 3;
    if (this.flammable && this.state === 'ok') {
      // ignition scales with the blast energy here (power × falloff), see IGNITE
      if (this.engine <= 0.15 || rnd() < igniteChance(Pw * f)) this.ignite(3.5 + rnd() * 3.5);
    }
  }

  setGlass(level, pointW, dirW, quiet = false) {
    const g = this.v.materials?.glass;
    if (level <= this.glass) return;
    this.glass = level;
    if (g) {
      if (level === 1) { g.color.copy(CRACKED); g.roughness = 0.55; g.metalness = 0.3; }
      else { g.color.copy(SHATTERED); g.roughness = 1; g.metalness = 0; }
    }
    if (level === 1 && pointW && this.game.fx && !quiet) this.game.fx.glass(pointW, dirW ? _w.copy(dirW).multiplyScalar(0.15) : { x: 0, y: 0.2, z: 0 }, 7);
    if (level === 2 && this.game.fx && !quiet) {
      const p = pointW || this._toWorld(_v.set(this.center.x, this.bbox.max.y - this.size.y * 0.25, this.center.z), new THREE.Vector3());
      this.game.fx.glass(p, dirW ? _w.copy(dirW).multiplyScalar(0.4) : { x: 0, y: 0.3, z: 0 }, 36);
    }
  }

  breakLamp(l, kind, quiet = false) {
    const fx = quiet ? null : this.game.fx;
    if (l) {
      if (l.broken) return;
      l.broken = true;
      l.mesh.material = this.sys.brokenLampMat;
      if (fx) {
        const p = this._toWorld(l.center, new THREE.Vector3());
        fx.glass(p, { x: 0, y: 0.2, z: 0 }, 8);
        fx.sparks(p, { x: 0, y: 0.5, z: 0 }, 4, { speed: 2.5, life: 0.25 }); // the filament shorts
      }
      if (l.kind === 'head') this._spotsOff(l.center.x);
      return;
    }
    const m = this.v.materials?.[kind];
    if (!m || m.userData.__broken) return;
    m.userData.__broken = true;
    if (m.emissive) m.emissive.setHex(0x000000);
    m.color.multiplyScalar(0.25);
    if (kind === 'head') this._spotsOff(null);
    if (fx) {
      const z = kind === 'head' ? this.bbox.min.z + 0.1 : this.bbox.max.z - 0.1;
      fx.glass(this._toWorld(_v.set(0, this.center.y, z), new THREE.Vector3()), { x: 0, y: 0.2, z: 0 }, 12);
    }
  }

  // headlight beams are pooled by the vehicles workstream: only dim them, never change their config
  _spotsOff(x) {
    this.v.breakHeadlight?.(x); // the vehicle re-sets beam intensity every frame, so it must know the lamp is gone
    for (const s of this.v.spots || []) {
      if (x !== null && Math.sign(s.position.x) !== Math.sign(x) && Math.abs(x) > 0.1) continue;
      s.intensity = 0;
    }
  }

  detach(p, dirW, e = 1) {
    const fx = this.game.fx;
    if (p.detached || !fx?.debrisSys || !p.obj.parent) return;
    p.detached = true;
    if (p.loose) { p.loose = false; this.looseN--; }
    const b = this.v.body;
    const lv = b.linvel();
    const s = 2.5 + 4 * Math.min(1.3, e);
    const side = p.zone === 'side';
    const out = side ? this._toWorld(_v.copy(p.center), new THREE.Vector3()).sub(this._toWorld(_w.set(0, p.center.y, p.center.z), new THREE.Vector3())).normalize() : null;
    const vel = {
      x: lv.x * 0.8 - (dirW?.x || 0) * s * 0.3 + (out ? out.x * s : (rnd() - 0.5) * 2),
      y: lv.y * 0.5 + 2 + rnd() * 3 * e,
      z: lv.z * 0.8 - (dirW?.z || 0) * s * 0.3 + (out ? out.z * s : (rnd() - 0.5) * 2),
    };
    // move the object to world space keeping its current transform
    p.obj.updateMatrixWorld(true);
    p.obj.matrixWorld.decompose(p.obj.position, p.obj.quaternion, p.obj.scale);
    p.obj.removeFromParent();
    this.deformer.setSkip(p.obj, true);
    p.item = fx.debrisSys.spawnMesh(p.obj, {
      half: p.half, center: p.lcenter, mass: p.key.startsWith('door') ? 28 : p.key === 'hood' ? 18 : 12,
      vel, angvel: { x: (rnd() - 0.5) * 8, y: (rnd() - 0.5) * 6, z: (rnd() - 0.5) * 8 }, life: PART_LIFE,
      onExpire: (it) => it.obj.removeFromParent(),
    });
    fx.sparks(this._toWorld(p.center, new THREE.Vector3()), { x: vel.x, y: 1, z: vel.z }, 14);
    this.game.events?.emit('vehicle:part', { vehicle: this.v, part: p.key });
  }

  ignite(fuse) {
    if (!this.flammable || this.state !== 'ok' || this.disposed) return;
    this.state = 'burning';
    this.engine = Math.min(this.engine, 0.12);
    this.burnT = 0;
    this.fuse = fuse ?? 6 + rnd() * 6;
    const fx = this.game.fx;
    if (this.smokeH) { this.smokeH.stop(1); this.smokeH = null; this.smokeKind = null; }
    if (this.steamH) { this.steamH.stop(0.5); this.steamH = null; }
    // leaked fuel under the car goes up with it
    if (fx) for (const p of this.puddles) fx.fire(p, { size: 0.45, duration: 7 + rnd() * 5, smoke: 'black', light: false });
    this.puddles.length = 0;
    if (fx) {
      const off = this.enginePos.clone();
      off.y = Math.max(off.y, this.bbox.max.y - this.size.y * 0.35);
      this.fireH = fx.fire(this.engineWorld(), {
        size: 0.85 * Math.sqrt(this.sizeK), attachTo: this.root, offset: off, smoke: 'black', target: this.v, smokeDensity: 0.8,
      });
    }
    this.game.events?.emit('vehicle:burning', { vehicle: this.v });
  }

  explode() {
    if (this.state === 'destroyed' || this.disposed) return;
    if (this._refine) this.refineNow();
    const game = this.game;
    const fx = game.fx;
    const wasBurning = this.state === 'burning';
    this.state = 'destroyed';
    this.v.destroyed = true;
    this.engine = 0;
    this.body = Math.min(this.body, 0.1);
    const b = this.v.body;
    const p = this.engineWorld(new THREE.Vector3());
    if (fx && this.power > 0) fx.explode(p, this.power, { exclude: [b], source: this.v });
    // lift and spin the wreck
    const m = b.mass();
    b.applyImpulse({ x: (rnd() - 0.5) * m * 2, y: m * (7.5 + rnd() * 3) * Math.min(1.4, this.power), z: (rnd() - 0.5) * m * 2 }, true);
    b.applyTorqueImpulse({ x: (rnd() - 0.5) * m * 2.8, y: (rnd() - 0.5) * m * 1.2, z: (rnd() - 0.5) * m * 3.2 }, true);
    // crumple
    for (let i = 0; i < 4; i++) {
      const d = _v.set(rnd() - 0.5, -0.3 - rnd() * 0.7, rnd() - 0.5).normalize();
      const pl = this.surfacePoint(d, _w);
      this.deformer.deform(pl, d.clone(), 1.1 * Math.sqrt(this.sizeK), 0.22 * this.sizeK);
    }
    this.setGlass(2);
    for (const l of this.lamps) if (!l.broken) this.breakLamp(l);
    if (!this.lamps.length) { this.breakLamp(null, 'head'); this.breakLamp(null, 'tail'); }
    for (const part of this.parts) {
      const chance = part.key === 'hood' ? 0.85 : part.key === 'trunk' ? 0.6 : part.key.includes('Bumper') ? 0.5 : 0.35;
      if (!part.detached && rnd() < chance) this.detach(part, { x: 0, y: -1, z: 0 }, 1.4);
      else if (!part.detached) { this._loosen(part, part.center, 1.4); part.angV += 4 + rnd() * 4; }
    }
    for (const wd of this.wheels) if (wd.state < 2) { if (rnd() < 0.25 && !this.v.spec?.twoWheel) this.wheelOff(wd, 1.4); else this.burst(wd, true); }
    this._char(1);
    // fire keeps burning on the shell for a while, smoke lingers
    if (fx) {
      if (!this.fireH?.alive) {
        this.fireH = fx.fire(p, { size: 0.6 * Math.sqrt(this.sizeK), attachTo: this.root, offset: this.enginePos.clone(), smoke: 'black', target: this.v });
      }
      this.fireH.size = 1.15 * Math.sqrt(this.sizeK);
      this.fireH.spread = 0.9;
      this.wreckFire = 16 + rnd() * 12;
      this.smokeH?.stop(0.5);
      this.smokeH = fx.smoke(p, { color: 'dark', attachTo: this.root, offset: new THREE.Vector3(this.center.x, this.bbox.max.y, this.center.z), rate: 6, size: 1.3 * Math.sqrt(this.sizeK), duration: 75 });
      this.smokeKind = 'wreck';
    }
    // occupants
    const pl = game.player;
    if (pl && pl.controllable === this.v && pl.mode === 'vehicle') this.sys.hurtPlayer(10, this.v);
    this.wreckT = 0;
    game.events?.emit('vehicle:destroyed', { vehicle: this.v, wasBurning });
  }

  // darken all materials towards a charred shell (k 0..1)
  _char(k) {
    for (const [m, o] of this.mats) {
      if (m === this.sys.brokenLampMat || m === this.v.materials?.glass) continue;
      m.color.setHex(o.color).lerp(CHAR, k * 0.96);
      if (m.roughness !== undefined) m.roughness = THREE.MathUtils.lerp(o.roughness, 1, k);
      if (m.metalness !== undefined) m.metalness = THREE.MathUtils.lerp(o.metalness, 0.15, k);
      if (m.emissive && o.emissive !== null) m.emissive.setHex(o.emissive).multiplyScalar(1 - k);
    }
  }

  // ---------- per frame ----------

  update(dt) {
    if (this.disposed) return;
    const v = this.v;
    const fx = this.game.fx;
    const tel = v.telemetry;
    if (this.looseN > 0 && dt > 0) this._swing(dt);
    if (this.wheels.length && fx) this._rims(dt, fx);
    if (this.state === 'ok' && this.flammable && this.engine < 0.3 && CARLIKE.has(this.kind)) this._leak(dt, tel);
    if (this.state === 'ok') {
      // overturned cars catch fire (GTA rule)
      if (this.flammable && CARLIKE.has(this.kind) && tel?.upsideDown && (tel.speedKmh ?? 0) < 8) {
        this.upsideT += dt;
        if (this.upsideT > 5) { this.ignite(); return; }
      } else this.upsideT = 0;
      if (this._refine) this._stepRefine(0.5);
      else if (!this._warm) this._warm = this.deformer.warm(0.4);
      if (this.engine <= 0.15 && this.flammable) { this.ignite(); return; }
      // engine smoke
      const want = this.engine > 0.6 ? null : this.engine > 0.35 ? 'light' : 'dark';
      if (want !== this.smokeKind && fx) {
        this.smokeH?.stop(1.2);
        const off = new THREE.Vector3(this.enginePos.x, Math.max(this.enginePos.y, this.bbox.max.y - this.size.y * 0.4), this.enginePos.z);
        this.smokeH = want ? fx.smoke(this.engineWorld(), { color: want, attachTo: this.root, offset: off, size: 0.5 }) : null;
        this.smokeKind = want;
      }
      if (this.smokeH) {
        this.smokeH.rate = 4 + (0.6 - this.engine) * 30;
        this.smokeH.size = (0.45 + (0.6 - this.engine) * 1.2) * Math.sqrt(this.sizeK);
      }
      // radiator steam after frontal hits
      if (this.steamT > 0) {
        this.steamT -= dt;
        if (!this.steamH && fx) {
          const off = new THREE.Vector3(0, this.enginePos.y, this.bbox.min.z + 0.25);
          this.steamH = fx.steam(this.engineWorld(), { attachTo: this.root, offset: off, size: 0.5 * Math.sqrt(this.sizeK), rate: 16 });
        }
        if (this.steamT <= 0 && this.steamH) { this.steamH.stop(1); this.steamH = null; }
      }
    } else if (this.state === 'burning') {
      this.burnT += dt;
      const glow = Math.min(1, this.burnT / 4) * (0.75 + 0.25 * Math.sin(this.burnT * 11) * Math.sin(this.burnT * 4.3));
      const paint = v.materials?.paint;
      if (paint?.emissive) paint.emissive.setRGB(0.22 * glow, 0.045 * glow, 0.006 * glow);
      if (this.fireH) this.fireH.size = (0.85 + Math.min(0.35, this.burnT * 0.05)) * Math.sqrt(this.sizeK);
      if (this.burnT >= this.fuse) this.sys.requestExplosion(this);
    } else if (this.state === 'destroyed') {
      this.wreckT += dt;
      const paint = v.materials?.paint;
      const glow = Math.max(0, 1 - this.wreckT / 10);
      if (paint?.emissive) paint.emissive.setRGB(0.2 * glow, 0.04 * glow, 0.006 * glow);
      if (this.fireH?.alive) {
        const left = this.wreckFire - this.wreckT;
        if (left < 6) this.fireH.size = Math.max(0.2, 1.15 * Math.sqrt(this.sizeK) * (left / 6));
        if (left <= 0) { this.fireH.stop(3); }
      }
      if (this.smokeH?.alive && this.smokeKind === 'wreck') {
        this.smokeH.rate = Math.max(1.5, 6 - this.wreckT * 0.08);
        if (this.wreckT > 35) this.smokeH.setLook('light');
      }
    }
  }

  // ---------- hanging panels ----------

  /**
   * Latch / clips gone: the panel swings on its hinge (hood, trunk lid, doors: model.parts userData.hinge) or hangs
   * from the far end (bumpers). Driven in update() by the car's acceleration and gravity until it falls off.
   */
  _loosen(p, pl, e = 0.5) {
    if (p.loose || p.detached || !p.obj?.parent || this.kind === 'tank') return;
    const parent = p.parent;
    this.root.updateMatrixWorld(true);
    // part centre in the panel's parent space
    const c = _t.copy(p.center).applyMatrix4(this.root.matrixWorld);
    parent.worldToLocal(c);
    if (p.hinge) {
      p.axis = new THREE.Vector3(p.hinge.axis === 'x' ? 1 : 0, p.hinge.axis === 'y' ? 1 : 0, p.hinge.axis === 'z' ? 1 : 0);
      p.sign = p.hinge.sign || 1;
      p.max = p.hinge.max || 1.1;
      p.H = p.pos.clone();
      // a buckled bonnet / boot lid never closes flat again, a sprung door hangs ajar
      const door = p.key.startsWith('door');
      p.rest = (door ? 0.08 + rnd() * 0.22 : p.key === 'hood' ? 0.06 + rnd() * 0.12 : 0.03 + rnd() * 0.08) * Math.min(1.2, 0.5 + e);
      p.ang = p.rest + (door ? 0.05 + rnd() * 0.12 : 0.08 + rnd() * 0.15);
    } else {
      // bumper: the clips on the hit side let go, it hangs from the other end
      const right = (pl?.x ?? 0) > this.center.x;
      const endX = p.lcenter.x + (right ? -p.half.x : p.half.x) * 0.92;
      p.H = new THREE.Vector3(endX, p.lcenter.y + p.half.y * 0.6, p.lcenter.z).applyQuaternion(p.quat).add(p.pos);
      p.axis = new THREE.Vector3(0, 0, 1);
      p.sign = right ? -1 : 1;
      p.max = 0.5 + rnd() * 0.15;
      p.rest = 0;
      p.ang = 0.06;
    }
    p.c0 = c.clone().sub(p.H);
    p.angV = 0;
    p.loose = true;
    this.looseN++;
    this._pose(p);
  }

  _pose(p) {
    const q = _q2.setFromAxisAngle(p.axis, p.sign * p.ang);
    p.obj.quaternion.multiplyQuaternions(q, p.quat);
    p.obj.position.copy(p.pos).sub(p.H).applyQuaternion(q).add(p.H);
  }

  // 1-DOF swing of every loose panel: inertial pseudo-force of the car + gravity (car frame), air load at speed,
  // hinge friction, hard stops with a bounce. A door / lid slammed into its stop at speed tears off.
  _swing(dt) {
    const b = this.v.body;
    let lv, r;
    try { lv = b.linvel(); r = b.rotation(); } catch { return; }
    if (!this._lv) { this._lv = new THREE.Vector3(lv.x, lv.y, lv.z); return; }
    const k = 1 / Math.max(dt, 1 / 240);
    _qi.set(r.x, r.y, r.z, r.w).invert();
    _f.set(-(lv.x - this._lv.x) * k, -(lv.y - this._lv.y) * k - 9.81, -(lv.z - this._lv.z) * k);
    if (_f.lengthSq() > 3600) _f.setLength(60); // crash spikes
    _f.applyQuaternion(_qi);
    this._lv.set(lv.x, lv.y, lv.z);
    const sp2 = lv.x * lv.x + lv.z * lv.z;
    const damp = Math.exp(-dt * 2.2);
    for (const p of this.parts) {
      if (!p.loose || p.detached) continue;
      _t.copy(p.c0).applyAxisAngle(p.axis, p.sign * p.ang);
      _t2.crossVectors(p.axis, _t).multiplyScalar(p.sign); // d(centre) / d(angle)
      let acc = _f.dot(_t2) / Math.max(0.05, p.c0.lengthSq());
      if (p.hinge) acc -= sp2 * 0.0035 * Math.sin(p.ang - p.rest); // airflow pushes doors / lids back
      p.angV = (p.angV + acc * dt) * damp;
      p.ang += p.angV * dt;
      if (p.ang < p.rest) { p.ang = p.rest; if (p.angV < 0) p.angV *= -0.25; }
      else if (p.ang > p.max) {
        p.ang = p.max;
        if (p.angV > 0) {
          if (p.angV > 6 && p.hinge && rnd() < 0.5) { this.detach(p, null, 0.5); continue; }
          p.angV *= -0.3;
        }
      }
      this._pose(p);
    }
  }

  // ---------- tyres / wheels ----------

  _collectWheels() {
    const v = this.v, ph = v.physics;
    if (!ph?.wheels?.length || !v.wheelVisuals?.length || !(CARLIKE.has(this.kind) || this.kind === 'motorcycle')) return [];
    this._wheelVis0 = v.wheelVisuals.slice();
    return ph.wheels.map((w) => ({
      w, r0: w.radius, state: 0, sparkT: 0, item: null, pivot: null, parent: null,
      vis: v.wheelVisuals.filter((x) => (x.phys ?? 0) === w.index),
      center: new THREE.Vector3(w.x, 0, w.z), // body space: origin at wheel-centre height
    }));
  }

  _wheelHits(pl, R, e) {
    const twoWheel = !!this.v.spec?.twoWheel;
    for (const wd of this.wheels) {
      if (wd.state >= 2) continue;
      const d = pl.distanceTo(wd.center);
      if (!twoWheel && e > WHEEL.offE && d < R * 0.5 && rnd() < 0.55) this.wheelOff(wd, e);
      else if (wd.state === 0 && d < R * 0.8 && rnd() < 0.3 + e * 0.45) this.burst(wd);
    }
  }

  /** Tyre bursts: the corner drops onto the rim, grip goes, the wheel drags (the car pulls that way), rim sparks. */
  burst(wd, quiet = false) {
    if (wd.state >= 1) return;
    wd.state = 1;
    const w = wd.w;
    const m = (this.v.spec?.mass ?? 1400) / 1400;
    w.radius = wd.r0 * WHEEL.burstR;
    w.gripK = WHEEL.burstGrip;
    w.dragTorque = WHEEL.burstDrag * m;
    for (const vis of wd.vis) vis.spin.scale.set(1, WHEEL.burstR, WHEEL.burstR);
    const fx = this.game.fx;
    if (fx && !quiet) {
      const p = this._toWorld(_v.copy(wd.center).setY(-wd.r0 * 0.5), new THREE.Vector3());
      fx.bits(p, { material: 'metal', count: 6, speed: 4, size: 0.07, life: 2 });
      fx.dust?.(p, 0.6, { color: 'dust', count: 4 });
    }
    this.game.events?.emit('vehicle:tire', { vehicle: this.v, wheel: w.index, kind: 'burst' });
  }

  /** Wheel torn off: it rolls away as debris, the hub scrapes the road (big drag, sparks). */
  wheelOff(wd, e = 1) {
    if (wd.state >= 2) return;
    const fx = this.game.fx;
    const v = this.v, w = wd.w;
    const m = (v.spec?.mass ?? 1400) / 1400;
    wd.state = 2;
    w.radius = wd.r0 * WHEEL.offR;
    w.gripK = WHEEL.offGrip;
    w.dragTorque = WHEEL.offDrag * m;
    const vis = wd.vis[0];
    for (const x of wd.vis) { const i = v.wheelVisuals.indexOf(x); if (i >= 0) v.wheelVisuals.splice(i, 1); }
    for (const x of wd.vis.slice(1)) x.pivot.visible = false; // duals / tandem: one wheel flies, the rest is gone
    if (!vis || !fx?.debrisSys) return;
    const b = v.body;
    const lv = b.linvel();
    vis.pivot.updateMatrixWorld(true);
    wd.parent = vis.pivot.parent;
    vis.pivot.matrixWorld.decompose(vis.pivot.position, vis.pivot.quaternion, vis.pivot.scale);
    vis.pivot.removeFromParent();
    wd.pivot = vis.pivot;
    const out = this._toWorld(_v.set(Math.sign(w.x || 1) * 2, 0, w.z), new THREE.Vector3()).sub(this._toWorld(_w.set(0, 0, w.z), new THREE.Vector3())).normalize();
    const s = 3 + 3 * Math.min(1.3, e);
    wd.item = fx.debrisSys.spawnMesh(vis.pivot, {
      half: { x: Math.max(0.08, (w.width || 0.22) / 2), y: wd.r0 * 0.9, z: wd.r0 * 0.9 }, mass: 22,
      vel: { x: lv.x * 0.85 + out.x * s, y: lv.y * 0.5 + 1.5 + rnd() * 2, z: lv.z * 0.85 + out.z * s },
      angvel: { x: (rnd() - 0.5) * 20, y: (rnd() - 0.5) * 4, z: (rnd() - 0.5) * 4 }, life: PART_LIFE,
      onExpire: (it) => it.obj.removeFromParent(),
    });
    fx.sparks(vis.pivot.position, { x: out.x, y: 0.6, z: out.z }, 18);
    this.game.events?.emit('vehicle:tire', { vehicle: v, wheel: w.index, kind: 'off' });
    this.game.events?.emit('vehicle:part', { vehicle: v, part: `wheel${w.index}` });
  }

  _refit(wd) {
    const w = wd.w, v = this.v;
    w.radius = wd.r0;
    w.gripK = 1;
    w.dragTorque = 0;
    for (const vis of wd.vis) { vis.spin.scale.set(1, 1, 1); vis.pivot.visible = true; }
    if (wd.state === 2) {
      if (wd.item && !wd.item.removed) this.game.fx?.debrisSys.removeMesh(wd.item, false);
      wd.item = null;
      const pv = wd.pivot;
      if (pv && wd.parent) { wd.parent.add(pv); pv.scale.set(1, 1, 1); pv.quaternion.identity(); }
      wd.pivot = null;
      if (this._wheelVis0) { v.wheelVisuals.length = 0; v.wheelVisuals.push(...this._wheelVis0); }
    }
    wd.state = 0;
  }

  // burst / missing wheels on the road: sparks from the rim or the hub
  _rims(dt, fx) {
    for (const wd of this.wheels) {
      if (!wd.state) continue;
      const w = wd.w;
      if (!w.contact || !w.point) continue;
      const sp = Math.abs(w.omega * w.radius);
      if (sp < 2.5) continue;
      wd.sparkT -= dt;
      if (wd.sparkT > 0) continue;
      wd.sparkT = wd.state === 2 ? 0.035 : 0.08;
      const f = this.v.physics?.telemetry;
      _pt.x = w.point.x; _pt.y = w.point.y + 0.03; _pt.z = w.point.z;
      const lv = this.v.body.linvel();
      const l = Math.hypot(lv.x, lv.z) || 1;
      _dir.x = -lv.x / l; _dir.y = 0.35; _dir.z = -lv.z / l;
      _sparkO.speed = 3 + sp * 0.18;
      fx.sparks(_pt, _dir, wd.state === 2 ? 5 : 2, _sparkO);
      if (f && wd.state === 2 && rnd() < 0.15) fx.dust?.(_pt, 0.4, { color: 'dust', count: 1 });
    }
  }

  // ---------- fuel leak ----------

  // below 30 % engine the tank / lines leak: a stain grows under the car while it stands (catches fire with it)
  _leak(dt, tel) {
    this.leakT += dt;
    if ((tel?.speedKmh ?? 0) > 6 || this.puddles.length >= 3) return;
    if (this.leakT < 1.5 + this.puddles.length * 3) return;
    const fx = this.game.fx;
    if (!fx?.decals) return;
    // drips under the engine bay, the stain spreads out from under the side of the car
    this._leakSide ??= rnd() < 0.5 ? -1 : 1;
    const n = this.puddles.length;
    const p = this._toWorld(_v.set(this.enginePos.x + this._leakSide * this.size.x * (0.22 + n * 0.12), this.bbox.min.y, this.enginePos.z + n * 0.25), new THREE.Vector3());
    fx.decals.addGround(p, 0.9 + n * 0.6, { life: 75, heat: 0, kind: 0 });
    this.puddles.push(p);
  }

  // ---------- lifecycle ----------

  repair() {
    if (this.disposed) return;
    this.v.repairHeadlights?.();
    this.engine = 1;
    this.body = 1;
    this.state = 'ok';
    this.v.destroyed = false;
    this.burnT = this.fuse = this.wreckT = this.upsideT = this.steamT = 0;
    this.deformer.reset();
    for (const [m, o] of this.mats) {
      m.color.setHex(o.color);
      if (m.emissive && o.emissive !== null) m.emissive.setHex(o.emissive);
      if (o.roughness !== undefined) m.roughness = o.roughness;
      if (o.metalness !== undefined) m.metalness = o.metalness;
      delete m.userData.__broken;
    }
    this.glass = 0;
    for (const l of this.lamps) { l.mesh.material = l.mat; l.broken = false; }
    if (this.v.headlightsOn) this.v.setHeadlights?.(true);
    for (const p of this.parts) this._reattach(p);
    for (const wd of this.wheels) this._refit(wd);
    this.looseN = 0;
    this.leakT = 0;
    this.puddles.length = 0;
    this._lv = null;
    this._killFx();
    this.suppress = 3;
    this.hasPrev = false;
  }

  /**
   * Re-apply damage recorded on another body of the same model (a dented AI traffic car that becomes this vehicle:
   * carjacking, takeover). snap = TrafficWreckDamage.snapshot(): points in the model's ground frame (y = 0 ground,
   * z = 0 between the axles); `lift` = height of this vehicle's local origin above that ground. No effects, parts
   * that already fell off are simply missing (their debris is still lying where it fell).
   */
  restore(snap, lift = 0) {
    if (!snap || this.disposed) return;
    this.refineNow();
    const pl = new THREE.Vector3(), dl = new THREE.Vector3();
    for (const im of snap.impacts || []) {
      pl.set(im.p[0], im.p[1] - lift, im.p[2]);
      dl.set(im.d[0], im.d[1], im.d[2]).normalize();
      this._dent(pl, dl, im.e, !!im.s);
    }
    for (const b of snap.lamps || []) {
      pl.set(b.c[0], b.c[1] - lift, b.c[2]);
      let best = null, bd = 0.6;
      for (const l of this.lamps) {
        if (l.broken) continue;
        const d = l.center.distanceTo(pl) + (l.kind === b.kind ? 0 : 0.25);
        if (d < bd) { bd = d; best = l; }
      }
      if (best) this.breakLamp(best, null, true);
      else if (!this.lamps.length) this.breakLamp(null, b.kind === 'head' ? 'head' : 'tail', true);
    }
    if (snap.glass) this.setGlass(snap.glass, null, null, true);
    for (const key of snap.parts || []) {
      const p = this.parts.find((q) => q.key === key);
      if (!p || p.detached || !p.obj.parent) continue;
      p.detached = true;
      p.dmg = 1;
      p.obj.removeFromParent();
      this.deformer.setSkip(p.obj, true);
    }
    if (snap.engine !== undefined) this.engine = Math.min(this.engine, snap.engine);
    if (snap.body !== undefined) this.body = Math.min(this.body, snap.body);
  }

  _reattach(p) {
    p.dmg = 0;
    p.loose = false;
    p.ang = p.angV = 0;
    if (!p.detached) { p.obj.position.copy(p.pos); p.obj.quaternion.copy(p.quat); return; }
    if (p.item && !p.item.removed) this.game.fx?.debrisSys.removeMesh(p.item, false);
    p.item = null;
    p.parent.add(p.obj);
    p.obj.position.copy(p.pos);
    p.obj.quaternion.copy(p.quat);
    p.obj.scale.copy(p.scale);
    this.deformer.setSkip(p.obj, false);
    p.detached = false;
  }

  _killFx() {
    for (const h of [this.fireH, this.smokeH, this.steamH]) if (h) h.kill();
    this.fireH = this.smokeH = this.steamH = null;
    this.smokeKind = null;
  }

  dispose() {
    if (this.disposed) return;
    this._killFx();
    for (const p of this.parts) {
      if (p.detached && p.item && !p.item.removed) this.game.fx?.debrisSys.removeMesh(p.item, false);
      if (p.detached) p.obj.removeFromParent();
    }
    for (const wd of this.wheels) if (wd.item && !wd.item.removed) { this.game.fx?.debrisSys.removeMesh(wd.item, false); wd.pivot?.removeFromParent(); }
    this._unpatch();
    this.deformer.dispose();
    this.disposed = true;
    this.sys._remove(this);
    if (this.v.damage === this) this.v.damage = null;
  }
}
