import * as THREE from 'three';
import { VehicleDamage, igniteChance } from './VehicleDamage.js';
import { TrafficWreckDamage, WreckTemplates } from './TrafficWreck.js';
import { Destruction } from './Destruction.js';
import { GROUPS } from '../vehicle/groups.js';

// Velocity change in one physics step (m/s) that counts as a crash, and the step that maps to "full" energy.
export const VEHICLE_IMPACT = { minDv: 3.0, zeroDv: 2.5, fullDv: 21.5 };
// AI traffic: damage per contact = (Δv - minDv) / scale; smoke < 0.45, fire <= 0.12
export const TRAFFIC_DAMAGE = { mass: 1400, minDv: 3.5, scale: 26 };
// AI traffic dents (TrafficWreck.js): an AI car whose own Δv in a step passes VEHICLE_IMPACT gets its own dentable
// body. soft/hard: max dented cars (above soft, far / unseen ones are recycled first); stopE: impact energy that
// stops the AI driver (below it the car limps on slower); budgetMs: promotion time per frame (more work waits for
// the next frames: explosions); prewarm*: background template builds for models within prewarmR of the camera;
// demoteR: a dented car still driving further than this goes back to the shared batch. A model without a template yet
// (spawned a moment ago) gets it built first in urgentMs slices; the dent is applied when it is ready (a few frames).
export const TRAFFIC_WRECKS = { soft: 10, hard: 16, stopE: 0.1, budgetMs: 2.5, prewarmMs: 0.5, urgentMs: 1.5, prewarmR: 120, demoteR: 160, templates: 8 };
const WAIT = 'wait'; // promote(): the model's template is still being built (the work is queued, never done in one go)

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pt = new THREE.Vector3();
const _in = new THREE.Vector3();
const _agentOut = { x: 0, y: 0, z: 0 };
const _frustum = new THREE.Frustum();
const _mat = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const rnd = Math.random;

// Vehicle damage (health, deformation, fire chain, explosions), AI-traffic wrecks, trees & buildings.
export class DamageSystem {
  constructor(game) {
    this.game = game;
    this.order = 55;
    this.vehicles = [];
    this.byHandle = new Map();
    this.agents = new Map(); // traffic agent -> {hp, state, fire, smoke, ...}
    this.trafficMode = 'instanced'; // 'instanced' (cheap burning wrecks) | 'takeover' (convert to full Vehicle)
    this.emitImpacts = true; // emit 'impact' events for vehicle crashes
    this.hurtOnFoot = false; // characters workstream handles on-foot explosion damage via the 'explosion' event
    this.stats = { impacts: 0, lastImpactMs: 0, lastDeformMs: 0, maxImpactMs: 0 };
    this.brokenLampMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.85, metalness: 0.2, flatShading: true });
    this.destruction = new Destruction(game, this);
    this._step = 0;
    this.explodeQueue = []; // vehicles/agents whose fuse ran out; detonated one by one (chain reactions stagger)
    this.explodeGap = 0.18; // s between queued detonations
    this.maxBurningAgents = 8;
    this._explodeCd = 0;
    // dented AI traffic (see TRAFFIC_WRECKS)
    this.wrecks = [];
    this.templates = new WreckTemplates();
    this.wreckQueue = []; // deferred wreck work { agent, fn } (promotion budget used up this frame)
    this._promoMs = 0;
    this._wreckT = 0;
    Object.assign(this.stats, { promotions: 0, lastPromoteMs: 0, maxPromoteMs: 0, agentImpacts: 0, evictions: 0, lastAgentImpact: null });
    this._offs = [
      game.events.on('contact', (p) => this.onContact(p)),
      game.events.on('vehicle:despawn', (p) => p?.vehicle?.damage?.dispose?.()),
    ];
    // vehicles spawned before this module existed (the first player car)
    for (const v of game.vehicles?.active || []) this.attach(v);
  }

  // ---------- vehicles ----------

  /** Attach damage to a controllable (called by VehicleManager.spawn). Returns the VehicleDamage (= v.damage). */
  attach(v) {
    if (!v || !v.body || !v.object3d) return null;
    if (v.damage instanceof VehicleDamage && !v.damage.disposed) return v.damage;
    const st = new VehicleDamage(this, v);
    v.damage = st;
    this.vehicles.push(st);
    this.byHandle.set(v.body.handle, st);
    this._takeoverDamage(v, st);
    return st;
  }

  // a dented AI car that was just taken over (carjacking, takeover mode) keeps its dents on the full vehicle
  _takeoverDamage(v, st) {
    const lt = this.game.traffic?.lastTakeOver;
    if (!lt || lt.used || !lt.spec.damage || this.game.time - lt.t > 2) return;
    const s = lt.spec;
    if ((v.catalogId ?? v.preset) !== s.id) return;
    const p = v.body.translation();
    if (Math.hypot(p.x - s.pos.x, p.z - s.pos.z) > 8) return;
    lt.used = true;
    try { st.restore(s.damage, v.spec?.wheelRadius ?? 0.35); } catch (e) { console.warn('[damage] takeover restore', e); }
  }

  _remove(st) {
    const i = this.vehicles.indexOf(st);
    if (i >= 0) this.vehicles.splice(i, 1);
    for (const [h, s] of this.byHandle) if (s === st) this.byHandle.delete(h);
  }

  get(v) { return v?.damage instanceof VehicleDamage ? v.damage : null; }

  /** Queue a detonation (VehicleDamage or traffic record); processed with a minimum gap. */
  requestExplosion(target) {
    if (!this.explodeQueue.includes(target)) this.explodeQueue.push(target);
  }

  /** Throw-away meshes using materials that only appear later (rubble, broken lamps) for fx.prewarm. */
  prewarmObjects() {
    if (!this._prewarm) {
      const g = new THREE.BoxGeometry(0.1, 0.1, 0.1).toNonIndexed();
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(0.5), 3));
      this._prewarm = [new THREE.Mesh(g, this.destruction.rubbleMat), new THREE.Mesh(g, this.brokenLampMat)];
      for (const m of this._prewarm) { m.castShadow = m.receiveShadow = true; m.frustumCulled = false; }
      this._prewarm.push(...(this.destruction.prewarmObjects?.() || [])); // fractured-facade material
    }
    return this._prewarm;
  }
  repair(v) { this.get(v)?.repair(); }
  ignite(v, fuse) { this.get(v)?.ignite(fuse); }
  explode(v) { this.get(v)?.explode(); }

  /** Damage the player as a fraction of max health. */
  hurtPlayer(frac, source) {
    const p = this.game.player;
    if (!p || !(frac > 0)) return;
    const max = p.maxHealth ?? (p.health > 1.5 ? 100 : 1);
    if (typeof p.takeDamage === 'function') p.takeDamage(frac * max, { source, kind: 'explosion' });
    else p.health = Math.max(0, (p.health ?? max) - frac * max);
  }

  // impact detection after each physics step
  postStep(dt) {
    const world = this.game.world;
    const cam = this.game.camera.position;
    this._step++;
    for (const st of this.vehicles) {
      const b = st.v.body;
      if (st.disposed || !b) continue;
      let lin, pos;
      try { lin = b.linvel(); pos = b.translation(); } catch { continue; }
      if (st.hasPrev && !b.isSleeping()) {
        const dvx = lin.x - st.pl.x, dvy = lin.y - st.pl.y + 9.81 * dt, dvz = lin.z - st.pl.z;
        const dv = Math.hypot(dvx, dvy, dvz);
        const moved = Math.hypot(pos.x - st.pp.x, pos.y - st.pp.y, pos.z - st.pp.z);
        const expect = Math.hypot(st.pl.x, st.pl.y, st.pl.z) * dt;
        const teleport = moved > expect * 3 + 2;
        if (!teleport && st.suppress <= 0 && dv > VEHICLE_IMPACT.minDv) this._vehicleImpact(st, dv, dvx, dvy, dvz, world);
        else if (!teleport && (this._step & 1) === 0) {
          const sp = Math.hypot(lin.x, lin.z);
          if (sp > 4 && (pos.x - cam.x) ** 2 + (pos.z - cam.z) ** 2 < 150 * 150) this._scrape(st, lin, sp, world);
        }
      }
      if (st.suppress > 0) st.suppress--;
      st.pl.x = lin.x; st.pl.y = lin.y; st.pl.z = lin.z;
      st.pp.x = pos.x; st.pp.y = pos.y; st.pp.z = pos.z;
      st.hasPrev = true;
    }
    this._agentStep(dt, world);
  }

  // AI traffic: Δv of every agent in the last step = velocity after the step (Traffic.postStep: a.v1) minus the
  // velocity it entered the step with (Traffic.fixedUpdate: a.v0 = the commanded velocity of a driving car, or the
  // current one of a crashed car, so impulses applied between steps never count as a hit)
  _agentStep(dt, world) {
    const tr = this.game.traffic;
    if (!tr?.agents) return;
    let hits = null;
    for (const a of tr.agents) {
      const v0 = a.v0, v1 = a.v1;
      if (!v0 || !v1 || !v0.ok) continue;
      v0.ok = false;
      const dvx = v1.x - v0.x, dvy = v1.y - v0.y + 9.81 * dt, dvz = v1.z - v0.z;
      const dv = Math.hypot(dvx, dvy, dvz);
      if (dv > VEHICLE_IMPACT.minDv) (hits ||= []).push(a, dv, dvx, dvy, dvz);
    }
    if (!hits) return;
    for (let i = 0; i < hits.length; i += 5) this._agentImpact(hits[i], hits[i + 1], hits[i + 2], hits[i + 3], hits[i + 4], world);
  }

  _agentImpact(a, dv, dvx, dvy, dvz, world) {
    const tr = this.game.traffic;
    if (!tr.agents.includes(a)) return;
    const b = a.body;
    let e = THREE.MathUtils.clamp((dv - VEHICLE_IMPACT.zeroDv) / (VEHICLE_IMPACT.fullDv - VEHICLE_IMPACT.zeroDv), 0, 1.3);
    let c = null;
    try { c = this._contacts(b, world); } catch { c = null; }
    const t = b.translation(), r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const point = new THREE.Vector3(), inward = new THREE.Vector3();
    if (c) {
      point.copy(c.point);
      inward.copy(c.inward);
      if (inward.dot(_v.set(t.x - point.x, t.y - point.y, t.z - point.z)) < 0) inward.negate();
    } else {
      // no manifold left: the face of the body box opposite to the velocity change
      inward.set(dvx, dvy, dvz).normalize();
      const dl = _v.copy(inward).applyQuaternion(_q.clone().invert());
      const hx = (a.type?.baked?.width ?? 1.8) * 0.47, hz = a.halfLen ?? 2.2, hy = a.halfH ?? 0.5;
      const k = Math.min(Math.abs(dl.x) > 1e-4 ? hx / Math.abs(dl.x) : 1e9, Math.abs(dl.y) > 1e-4 ? hy / Math.abs(dl.y) : 1e9, Math.abs(dl.z) > 1e-4 ? hz / Math.abs(dl.z) : 1e9);
      point.copy(dl).multiplyScalar(-k).applyQuaternion(_q).add(_pt.set(t.x, t.y, t.z));
    }
    const other = c?.other;
    let kind = 'prop', material = 'metal';
    const ud = other?.userData;
    const memb = other ? other.collisionGroups() >>> 16 : 0;
    const ob = other?.parent?.();
    if (ud?.building !== undefined || memb & GROUPS.STATIC) { kind = 'building'; material = 'concrete'; }
    else if (ud?.tree !== undefined) { kind = 'tree'; material = 'wood'; }
    else if (tr.colliderMap?.has(other?.handle) || ob?.userData?.type === 'vehicle' || memb & (GROUPS.VEHICLE | GROUPS.TRAFFIC)) kind = 'vehicle';
    else if (memb & GROUPS.GROUND) {
      kind = 'prop'; material = 'asphalt';
      if (_v.copy(inward).applyQuaternion(_q.invert()).y > 0.6) e *= 0.2; // landing on the underside
    }
    if (e < 0.02) return;
    // a tracked vehicle on the other side shows its own sparks for the same contact
    const quiet = !!(ob && this.byHandle.has(ob.handle));
    this.stats.agentImpacts++;
    this.stats.lastAgentImpact = { dv, e, kind, memb, contact: !!c, at: this.game.time };
    this.wreckOp(a, (st) => st.applyImpact(point, inward, e, { kind, material, quiet }));
    // the AI driver: a real hit stops the car (it becomes a physics wreck), a scrape makes it limp on slower
    if (!a.crashed) {
      if (e >= TRAFFIC_WRECKS.stopE) tr.crash(a);
      else if (!a.parked) { a.v *= 0.6; a.vmaxK = Math.min(a.vmaxK ?? 1, 0.8); a.vmax *= 0.8; }
    }
  }

  // ---------- dented AI traffic ----------

  /** Run fn(wreckDamage) for agent `a` now, promoting it if needed (deferred when this frame's budget is used up). */
  wreckOp(a, fn) {
    const st = a.wreck;
    if (st && !st.disposed) { fn(st); return true; }
    if (this._promoMs < TRAFFIC_WRECKS.budgetMs) {
      const s2 = this.promote(a);
      if (s2 === WAIT) { this.wreckQueue.push({ agent: a, fn }); return false; }
      if (s2) fn(s2);
      return !!s2;
    }
    this.wreckQueue.push({ agent: a, fn });
    return false;
  }

  /** Give AI traffic agent `a` its own dentable body (TrafficWreckDamage); returns it, null, or 'wait' (template). */
  promote(a) {
    const tr = this.game.traffic;
    if (a?.wreck && !a.wreck.disposed) return a.wreck;
    if (!tr?.material || !a?.type?.baked?.geo || !tr.agents.includes(a)) return null;
    const t0 = performance.now();
    const tpl = this.templates.get(a.type);
    if (!tpl) { this.templates.want(a.type, true); return WAIT; }
    if (!this._makeRoom(a)) return null;
    let st = null;
    try { st = TrafficWreckDamage.create(this, tr, a, tpl); } catch (e) { console.warn('[damage] traffic wreck', e); return null; }
    a.wreck = st;
    this.wrecks.push(st);
    const ms = performance.now() - t0;
    this._promoMs += ms;
    this.stats.promotions++;
    this.stats.lastPromoteMs = ms;
    this.stats.maxPromoteMs = Math.max(this.stats.maxPromoteMs, ms);
    return st;
  }

  _removeWreck(st) {
    const i = this.wrecks.indexOf(st);
    if (i >= 0) this.wrecks.splice(i, 1);
  }

  // keep the number of dented cars bounded: recycle far / unseen ones first, visible ones only above the hard cap
  _makeRoom(a) {
    if (this.wrecks.length < TRAFFIC_WRECKS.soft) return true;
    const cam = this.game.camera;
    if (cam) _frustum.setFromProjectionMatrix(_mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    let hidden = null, hd = -1, any = null, ad = -1;
    for (const st of this.wrecks) {
      const g = st.agent;
      if (g === a) continue;
      const d = cam ? Math.hypot(g.cur.x - cam.position.x, g.cur.z - cam.position.z) : 0;
      const seen = cam && d < 60 && _frustum.intersectsSphere(_sph.set(g.cur, 4));
      if (!seen && d > hd) { hd = d; hidden = st; }
      if (d > ad) { ad = d; any = st; }
    }
    if (hidden) { this._evict(hidden, true); return true; }
    if (this.wrecks.length < TRAFFIC_WRECKS.hard) return true;
    if (any) { this._evict(any, false); return true; }
    return false;
  }

  // unseen crashed wrecks are cleared away (agent removed); others go back to the shared batch
  _evict(st, unseen) {
    const a = st.agent, tr = this.game.traffic;
    this.stats.evictions++;
    if (unseen && a.crashed && tr?.agents.includes(a)) tr.remove(a);
    else st.dispose();
  }

  // sum contact impulses on the vehicle's colliders: impulse-weighted point, inward normal, main other collider
  _contacts(b, world) {
    let J = 0, px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, best = null, bestJ = 0;
    const n = b.numColliders();
    for (let i = 0; i < n; i++) {
      const col = b.collider(i);
      world.contactPairsWith(col, (other) => {
        world.contactPair(col, other, (m, flipped) => {
          const nc = m.numContacts();
          let j = 0;
          for (let k = 0; k < nc; k++) j += m.contactImpulse(k);
          const ns = m.numSolverContacts();
          if (j <= 1e-3 || !ns) return;
          let cx = 0, cy = 0, cz = 0;
          for (let k = 0; k < ns; k++) { const p = m.solverContactPoint(k); cx += p.x; cy += p.y; cz += p.z; }
          const nn = m.normal();
          const s = flipped ? 1 : -1;
          J += j;
          px += (cx / ns) * j; py += (cy / ns) * j; pz += (cz / ns) * j;
          nx += nn.x * s * j; ny += nn.y * s * j; nz += nn.z * s * j;
          if (j > bestJ) { bestJ = j; best = other; }
        });
      });
    }
    return J > 0 ? { J, point: _pt.set(px / J, py / J, pz / J), inward: _in.set(nx, ny, nz).normalize(), other: best } : null;
  }

  _vehicleImpact(st, dv, dvx, dvy, dvz, world) {
    const t0 = performance.now();
    const b = st.v.body;
    let e = THREE.MathUtils.clamp((dv - VEHICLE_IMPACT.zeroDv) / (VEHICLE_IMPACT.fullDv - VEHICLE_IMPACT.zeroDv), 0, 1.3);
    let c = null;
    try { c = this._contacts(b, world); } catch { c = null; }
    const point = new THREE.Vector3(), inward = new THREE.Vector3();
    const t = b.translation();
    if (c) {
      point.copy(c.point);
      inward.copy(c.inward);
      if (inward.dot(_v.set(t.x - point.x, t.y - point.y, t.z - point.z)) < 0) inward.negate();
    } else {
      inward.set(dvx, dvy, dvz).normalize();
      const dl = st._dirToLocal(inward, new THREE.Vector3());
      st._toWorld(st.surfacePoint(dl, new THREE.Vector3()), point);
    }
    const other = c?.other;
    let kind = 'prop', material = 'metal';
    const ud = other?.userData;
    const memb = other ? other.collisionGroups() >>> 16 : 0;
    const ob = other?.parent?.();
    if (ud?.building !== undefined || memb & GROUPS.STATIC) { kind = 'building'; material = 'concrete'; }
    else if (ud?.tree !== undefined) { kind = 'tree'; material = 'wood'; }
    else if (this.game.traffic?.colliderMap?.has(other?.handle) || ob?.userData?.type === 'vehicle' || memb & (GROUPS.VEHICLE | GROUPS.TRAFFIC)) kind = 'vehicle';
    else if (memb & GROUPS.GROUND) {
      kind = 'prop'; material = 'asphalt';
      // landing on the underside: suspension bottoming out, not a crash
      const up = st._dirToLocal(inward, new THREE.Vector3()).y;
      if (up > 0.6) e *= 0.2;
    }
    if (e < 0.02) return;
    st.applyImpact(point, inward, e, { kind, material });
    this.stats.impacts++;
    if (this.emitImpacts) {
      this.game.events?.emit('impact', { position: { x: point.x, y: point.y, z: point.z }, strength: Math.min(1, e), kind, material, source: st.v });
    }
    const ms = performance.now() - t0;
    this.stats.lastImpactMs = ms;
    this.stats.maxImpactMs = Math.max(this.stats.maxImpactMs, ms);
  }

  // metal scraping: sparks where the body slides on something
  _scrape(st, lin, sp, world) {
    const fx = this.game.fx;
    if (!fx) return;
    const b = st.v.body;
    const n = b.numColliders();
    for (let i = 0; i < n; i++) {
      const col = b.collider(i);
      world.contactPairsWith(col, (other) => {
        if (other.userData?.tree !== undefined) return;
        const ob = other.parent();
        if (ob && ob.isDynamic() && ob.mass() < 200) return;
        world.contactPair(col, other, (m) => {
          const ns = m.numSolverContacts();
          if (!ns) return;
          const p = m.solverContactPoint(0);
          fx.sparks(p, { x: -lin.x / sp, y: 0.35, z: -lin.z / sp }, Math.min(8, 1 + sp * 0.2), { speed: 3 + sp * 0.35, spread: 0.45, life: 0.45 });
        });
      });
    }
  }

  // ---------- contacts: trees, buildings, traffic ----------

  onContact(p) {
    const { c1, c2, force } = p;
    for (let k = 0; k < 2; k++) {
      const c = k ? c2 : c1, o = k ? c1 : c2;
      const ud = c?.userData;
      if (!ud) continue;
      if (ud.building !== undefined) this.destruction.onBuildingContact(ud.building, c, o, force);
      else if (ud.tree !== undefined) this.destruction.onTreeContact(ud.tree, ud.id, c, o, force);
    }
    const tr = this.game.traffic;
    if (tr?.colliderMap) {
      const dv = force / 60 / TRAFFIC_DAMAGE.mass;
      if (dv > TRAFFIC_DAMAGE.minDv) {
        const amt = (dv - TRAFFIC_DAMAGE.minDv) / TRAFFIC_DAMAGE.scale;
        const a1 = c1 && tr.colliderMap.get(c1.handle), a2 = c2 && tr.colliderMap.get(c2.handle);
        if (a1) this.agentHit(a1, amt);
        if (a2) this.agentHit(a2, amt);
      }
    }
  }

  // ---------- explosions (called by fx.explode before the blast impulse) ----------

  onExplosion(pos, Pw, R, o = {}) {
    const src = o.source;
    for (const st of [...this.vehicles]) {
      if (st.v === src || st.disposed) continue;
      const t = st.v.body.translation();
      const d = Math.hypot(t.x - pos.x, t.y - pos.y, t.z - pos.z);
      if (d < R * 1.05) st.applyExplosion(pos, Pw, R, d);
    }
    const tr = this.game.traffic;
    if (tr?.agents) {
      for (const a of [...tr.agents]) {
        if (a === src) continue;
        const d = Math.hypot(a.cur.x - pos.x, a.cur.y - pos.y, a.cur.z - pos.z);
        if (d > R) continue;
        const l = Math.hypot(a.cur.x - pos.x, a.cur.z - pos.z) || 1;
        tr.crash?.(a, { x: (a.cur.x - pos.x) / l, z: (a.cur.z - pos.z) / l });
        const f = Math.pow(1 - d / R, 1.2);
        if (f > 0.04) this.wreckOp(a, (st) => st.applyExplosion(pos, Pw, R, d));
        const rec = this.agentHit(a, Pw * f * 1.6);
        if (rec?.state === 'ok' && rnd() < igniteChance(Pw * f)) this.igniteAgent(rec, 3 + rnd() * 4); // energy-scaled (IGNITE)
      }
    }
    const pl = this.game.player;
    if (this.hurtOnFoot && pl && pl.mode === 'foot' && pl.focus) {
      const d = pl.focus.distanceTo(pos);
      if (d < R) this.hurtPlayer(Pw * Math.pow(1 - d / R, 1.3) * 0.9, src);
    }
    this.destruction.onExplosion(pos, Pw, R);
  }

  // ---------- AI traffic wrecks ----------

  agentHit(a, amount) {
    if (!a || !(amount > 0)) return null;
    let rec = this.agents.get(a);
    if (!rec) this.agents.set(a, (rec = { agent: a, hp: 1, state: 'ok', t: 0, fuse: 0, fire: null, smoke: null }));
    if (rec.state !== 'ok') return rec;
    rec.hp -= amount;
    const fx = this.game.fx;
    if (rec.hp < 0.45 && fx) {
      const look = rec.hp < 0.3 ? 'dark' : 'light';
      if (rec.smokeLook !== look) {
        rec.smoke?.stop(1);
        rec.smoke = fx.smoke(this._agentEngine(a) || a.cur, { color: look, attachTo: () => this._agentEngine(a, 0.6), size: 0.6, rate: 10 });
        rec.smokeLook = look;
      }
    }
    if (rec.hp <= 0.12) this.igniteAgent(rec);
    return rec;
  }

  igniteAgent(rec, fuse) {
    if (rec.state !== 'ok') return;
    let burning = 0;
    for (const r of this.agents.values()) if (r.state === 'burning') burning++;
    if (burning >= this.maxBurningAgents) return; // cap simultaneous traffic fires (stays smoking)
    const game = this.game;
    const a = rec.agent;
    const tr = game.traffic;
    if (this.trafficMode === 'takeover' && tr?.takeOver && game.vehicles?.spawn) {
      const spec = tr.takeOver(a);
      if (spec) {
        rec.smoke?.kill();
        this.agents.delete(a);
        const v = game.vehicles.spawn(spec.id, spec.pos, spec.yaw, { color: spec.color, spotLights: false });
        if (spec.velocity) v.body.setLinvel(spec.velocity, true);
        this.attach(v)?.ignite(fuse);
        return;
      }
    }
    rec.state = 'burning';
    rec.t = 0;
    rec.fuse = fuse ?? 6 + rnd() * 6;
    a.burning = true;
    tr?.crash?.(a);
    rec.smoke?.stop(1);
    rec.smoke = null;
    const fx = game.fx;
    if (fx) rec.fire = fx.fire(this._agentEngine(a) || a.cur, { size: 0.6, attachTo: () => this._agentEngine(a, 0.45), smoke: 'black', target: a });
  }

  explodeAgent(rec) {
    const a = rec.agent;
    const p = this._agentEngine(a);
    rec.state = 'wreck';
    rec.t = 0;
    if (!p) return;
    const pos = { x: p.x, y: p.y, z: p.z };
    a.paint?.setRGB?.(0.03, 0.027, 0.024);
    this.wreckOp(a, (st) => st.explode());
    const fx = this.game.fx;
    if (fx) {
      fx.explode(pos, 0.9, { source: a });
      if (rec.fire) rec.fire.size = 0.8;
      rec.fireLeft = 14 + rnd() * 10;
      rec.smoke = fx.smoke(pos, { color: 'dark', attachTo: () => this._agentEngine(a, 0.8), rate: 5, size: 1.1, duration: 60 });
    }
    this.game.events?.emit('traffic:destroyed', { agent: a, position: pos });
  }

  // engine position of an AI car in world space (null when the agent is gone)
  _agentEngine(a, up = 0.3) {
    const tr = this.game.traffic;
    if (!tr || !tr.agents.includes(a)) return null;
    let t, r;
    try { t = a.body.translation(); r = a.body.rotation(); } catch { return null; }
    const L = a.type?.baked?.length ?? 4.5;
    _v.set(0, (a.halfH ?? 0.5) * up, -L * 0.3).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
    _agentOut.x = t.x + _v.x; _agentOut.y = t.y + _v.y; _agentOut.z = t.z + _v.z;
    return _agentOut;
  }

  // ---------- per frame ----------

  update(dt, game) {
    const sdt = dt * (game.timeScale ?? 1);
    for (const st of [...this.vehicles]) st.update(sdt);
    const tr = game.traffic;
    for (const [a, rec] of this.agents) {
      if (!tr || !tr.agents.includes(a)) {
        rec.fire?.kill(); rec.smoke?.kill();
        this.agents.delete(a);
        continue;
      }
      rec.t += sdt;
      if (rec.state === 'burning' && rec.t >= rec.fuse) this.requestExplosion(rec);
      else if (rec.state === 'wreck' && rec.fire?.alive && rec.t > rec.fireLeft) rec.fire.stop(4);
    }
    // staggered detonations
    this._explodeCd -= sdt;
    while (this._explodeCd <= 0 && this.explodeQueue.length) {
      const t = this.explodeQueue.shift();
      if (t instanceof VehicleDamage) { if (t.disposed || t.state !== 'burning') continue; t.explode(); }
      else { if (t.state !== 'burning' || !this.agents.has(t.agent)) continue; this.explodeAgent(t); }
      this._explodeCd = this.explodeGap;
    }
    this.destruction.update(sdt);
    this._updateWrecks(sdt, game);
  }

  _updateWrecks(dt, game) {
    const tr = game.traffic;
    if (!tr?.agents) return;
    // deferred wreck work from previous steps (explosion chains), within the frame budget
    for (let n = this.wreckQueue.length; n > 0 && this.wreckQueue.length && this._promoMs < TRAFFIC_WRECKS.budgetMs; n--) {
      const { agent, fn } = this.wreckQueue.shift();
      if (tr.agents.includes(agent)) this.wreckOp(agent, fn);
    }
    for (const st of [...this.wrecks]) {
      if (st.disposed) continue;
      if (!tr.agents.includes(st.agent)) { st.dispose(); continue; } // removed without Traffic.remove hook
      st.update(dt);
    }
    // ~4 Hz: recycle far dented cars, background templates for models near the camera
    this._wreckT -= dt;
    const cam = game.camera?.position;
    if (this._wreckT <= 0 && cam) {
      this._wreckT = 0.25;
      const keep = new Set();
      for (const st of [...this.wrecks]) {
        const a = st.agent;
        keep.add(a.type.name);
        if (!a.crashed && Math.hypot(a.cur.x - cam.x, a.cur.z - cam.z) > TRAFFIC_WRECKS.demoteR) st.dispose();
      }
      const R2 = TRAFFIC_WRECKS.prewarmR ** 2;
      for (const a of tr.agents) {
        if ((a.cur.x - cam.x) ** 2 + (a.cur.z - cam.z) ** 2 > R2) continue;
        keep.add(a.type.name);
        if (!a.wreck) this.templates.want(a.type);
      }
      this.templates.prune(keep, TRAFFIC_WRECKS.templates);
    }
    if (this.templates.queue.length || this.templates.job) this.templates.step(this.templates.pressing ? TRAFFIC_WRECKS.urgentMs : TRAFFIC_WRECKS.prewarmMs);
    this._promoMs = 0; // promotions in the next steps / frame start a fresh budget
  }

  dispose() {
    for (const off of this._offs) off();
    for (const st of [...this.wrecks]) st.dispose(true);
    this.templates.dispose();
    for (const st of [...this.vehicles]) st.dispose();
    for (const rec of this.agents.values()) { rec.fire?.kill(); rec.smoke?.kill(); }
    this.agents.clear();
    this.destruction.dispose();
    this.brokenLampMat.dispose();
  }
}
