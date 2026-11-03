// Pooled ballistic tank shells (one module per game): gravity, a ray cast along every physics step against the
// Rapier world, glowing tracer streaks. All meshes/materials are created once; idle shells are zero-scale instances.
import * as THREE from 'three';
import { GROUPS, groups } from '../groups.js';

const POOL = 16;
const LIFE = 6;
const G = 9.81;
const HIT_MASK = GROUPS.GROUND | GROUPS.STATIC | GROUPS.VEHICLE | GROUPS.TRAFFIC | GROUPS.PROP | GROUPS.CHARACTER;
export const SHELL_POWER = 1.6;

/** Set while a shell detonation is being applied (tank armour treats it differently from other blasts). */
export const SHELL_BLAST = { active: false, owner: null };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const _sc = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const instances = new WeakMap();

/** Controllable owning a rigid body (null for traffic, props, buildings). */
export function findVehicle(game, body) {
  if (!body) return null;
  const st = game.damage?.byHandle?.get(body.handle);
  if (st?.v) return st.v;
  for (const v of game.vehicles?.active || []) if (v.body && v.body.handle === body.handle) return v;
  return null;
}

/** Make a full-physics vehicle explode now (no-op for wrecks). */
export function destroyVehicle(game, v) {
  if (!v || v.destroyed || v.kind === 'tank') return false;
  const st = game.damage?.get?.(v) || v.damage;
  if (st?.explode) { st.explode(); return true; }
  const t = v.body.translation();
  game.fx?.explode?.({ x: t.x, y: t.y + 0.5, z: t.z }, 1, { exclude: [v.body], source: v });
  v.destroyed = true;
  return true;
}

/** Make an AI traffic car explode now (crashes it into physics first). */
export function destroyAgent(game, a, dir) {
  const tr = game.traffic, dmg = game.damage;
  if (!a || !tr?.agents?.includes(a)) return false;
  if (!dmg?.agentHit) { tr.crash?.(a, dir); return true; }
  const rec = dmg.agentHit(a, 0.01);
  if (!rec || rec.state === 'wreck') return false;
  tr.crash?.(a, dir);
  const n = game.vehicles?.active.length ?? 0;
  dmg.igniteAgent(rec, 0);
  if (dmg.agents.get(a) === rec) dmg.explodeAgent(rec);
  else {
    // trafficMode 'takeover': the agent became a full vehicle
    const v = game.vehicles?.active[game.vehicles.active.length - 1];
    if (v && game.vehicles.active.length > n) destroyVehicle(game, v);
  }
  return true;
}

export class Shells {
  /** The shell system of a game (created and registered on first use). */
  static get(game) {
    let s = instances.get(game);
    if (!s) { s = new Shells(game); instances.set(game, s); }
    return s;
  }

  constructor(game) {
    this.game = game;
    this.order = 58;
    this.pool = Array.from({ length: POOL }, (_, i) => ({
      i, active: false, p: new THREE.Vector3(), prev: new THREE.Vector3(), v: new THREE.Vector3(), age: 0,
      owner: null, ownerBody: null, damage: true, speed: 0,
    }));
    this.alive = 0;
    this.listeners = new Set();
    const RAPIER = game.RAPIER;
    this.ray = RAPIER ? new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) : null;
    this.mask = groups(GROUPS.ALL, HIT_MASK);
    this.flags = RAPIER?.QueryFilterFlags?.EXCLUDE_SENSORS;
    if (game.scene) {
      const bodyGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.6, 6).rotateX(Math.PI / 2);
      this.bodyMat = new THREE.MeshBasicMaterial({ color: 0xffd8a0, toneMapped: false });
      this.tracerMat = new THREE.MeshBasicMaterial({
        color: 0xff9a40, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      this.bodyMesh = new THREE.InstancedMesh(bodyGeo, this.bodyMat, POOL);
      this.tracerMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.tracerMat, POOL);
      for (const m of [this.bodyMesh, this.tracerMesh]) {
        m.frustumCulled = false;
        m.castShadow = false;
        m.receiveShadow = false;
        m.renderOrder = 4;
        for (let i = 0; i < POOL; i++) m.setMatrixAt(i, ZERO);
        game.scene.add(m);
      }
      this.bodyMesh.name = 'tankShells';
      this.tracerMesh.name = 'tankTracers';
    }
    game.register?.(this, this.order);
  }

  /** Global fire listener (every tank of this game): cb({origin, dir, speed, t, tank}). Returns unsubscribe. */
  onFire(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Launch a shell.
   * @param {{origin, dir, speed?: number, owner?: object, ownerBody?: object, damage?: boolean}} o
   *   damage=false: visual only (remote shots in multiplayer when another client is authoritative)
   */
  spawn(o) {
    let s = this.pool.find((x) => !x.active);
    if (!s) s = this.pool.reduce((a, b) => (a.age > b.age ? a : b));
    const d = _d.set(o.dir.x, o.dir.y, o.dir.z).normalize();
    s.active = true;
    s.age = 0;
    s.speed = o.speed ?? 320;
    s.p.set(o.origin.x, o.origin.y, o.origin.z);
    s.prev.copy(s.p);
    s.v.copy(d).multiplyScalar(s.speed);
    s.owner = o.owner || null;
    s.ownerBody = o.ownerBody || o.owner?.body || null;
    s.damage = o.damage !== false;
    return s;
  }

  /** Visual-only shell for a shot fired by another client. */
  spawnRemote(o) {
    return this.spawn({ ...o, damage: false });
  }

  fixedUpdate(dt) {
    const game = this.game;
    const world = game.world;
    const water = game.vehicles?.env?.waterLevel ?? 0;
    let alive = 0;
    for (const s of this.pool) {
      if (!s.active) continue;
      s.age += dt;
      s.prev.copy(s.p);
      s.v.y -= G * dt;
      const nx = s.p.x + s.v.x * dt, ny = s.p.y + s.v.y * dt, nz = s.p.z + s.v.z * dt;
      const len = Math.hypot(nx - s.p.x, ny - s.p.y, nz - s.p.z);
      let hit = null;
      if (world && this.ray && len > 1e-4) {
        this.ray.origin.x = s.p.x; this.ray.origin.y = s.p.y; this.ray.origin.z = s.p.z;
        this.ray.dir.x = (nx - s.p.x) / len; this.ray.dir.y = (ny - s.p.y) / len; this.ray.dir.z = (nz - s.p.z) / len;
        let ownerOk = true;
        try { ownerOk = !s.ownerBody || world.getRigidBody(s.ownerBody.handle) === s.ownerBody; } catch { ownerOk = false; }
        hit = world.castRayAndGetNormal(this.ray, len, true, this.flags, this.mask, undefined, ownerOk ? s.ownerBody : undefined);
      }
      if (hit) {
        const t = hit.timeOfImpact;
        _p.set(s.p.x + this.ray.dir.x * t, s.p.y + this.ray.dir.y * t, s.p.z + this.ray.dir.z * t);
        s.p.copy(_p);
        this._impact(s, _p, hit.collider);
        continue;
      }
      s.p.set(nx, ny, nz);
      // terrain without colliders (far from the player) and the sea
      const th = game.terrain?.heightAt?.(nx, nz);
      if (th !== undefined && ny < th) { s.p.y = th; this._impact(s, s.p, null, th < water ? 'water' : 'ground'); continue; }
      if (ny < water) { s.p.y = water; this._impact(s, s.p, null, 'water'); continue; }
      if (s.age > LIFE) { s.active = false; continue; }
      alive++;
    }
    this.alive = alive;
  }

  _impact(s, pt, collider, kindHint) {
    const game = this.game;
    const fx = game.fx;
    s.active = false;
    const dir = _d.copy(s.v).normalize();
    const dirOut = { x: dir.x, y: dir.y, z: dir.z };
    const pos = { x: pt.x, y: pt.y, z: pt.z };
    let kind = kindHint || 'ground', target = null;
    if (collider) {
      const agent = game.traffic?.colliderMap?.get(collider.handle);
      const memb = collider.collisionGroups() >>> 16;
      if (agent) { kind = 'traffic'; target = agent; }
      else {
        const v = findVehicle(game, collider.parent());
        if (v) { target = v; kind = v.kind === 'tank' ? 'tank' : 'vehicle'; }
        else if (collider.userData?.building !== undefined || memb & GROUPS.STATIC) kind = 'building';
        else if (memb & GROUPS.CHARACTER) kind = 'character';
        else if (memb & GROUPS.PROP) kind = 'prop';
        else kind = 'ground';
      }
    }
    // step back a little so the blast centre is outside the surface
    const back = { x: pos.x - dir.x * 0.3, y: pos.y - dir.y * 0.3 + 0.1, z: pos.z - dir.z * 0.3 };
    if (kind === 'water') {
      fx?.splash?.(pos, 2.2);
      if (s.damage) {
        SHELL_BLAST.active = true; SHELL_BLAST.owner = s.owner;
        try { fx?.explode?.(back, 1.0, { source: s.owner, exclude: s.ownerBody ? [s.ownerBody] : undefined, scorch: false, debris: false }); } finally { SHELL_BLAST.active = false; SHELL_BLAST.owner = null; }
      }
    } else if (s.damage) {
      SHELL_BLAST.active = true; SHELL_BLAST.owner = s.owner;
      try {
        if (fx?.explode) fx.explode(back, SHELL_POWER, { source: s.owner, exclude: s.ownerBody ? [s.ownerBody] : undefined });
        else game.damage?.onExplosion?.(new THREE.Vector3(back.x, back.y, back.z), SHELL_POWER, 7 + 5 * Math.sqrt(SHELL_POWER), { source: s.owner });
      } finally { SHELL_BLAST.active = false; SHELL_BLAST.owner = null; }
      if (kind === 'tank') target.takeShellHit?.(pos, dirOut, s.owner);
      else if (kind === 'vehicle') destroyVehicle(game, target);
      else if (kind === 'traffic') destroyAgent(game, target, dirOut);
    } else {
      fx?.explode?.(back, SHELL_POWER, { noWorld: true, noPhysics: true, source: s.owner });
    }
    game.events?.emit('tank:hit', { position: pos, dir: dirOut, kind, target, tank: s.owner, remote: !s.damage });
  }

  update(dt, game, alpha = 1) {
    if (!this.bodyMesh) return;
    let dirty = this._dirty || false;
    for (const s of this.pool) {
      const i = s.i;
      if (!s.active) {
        if (s._shown) { this.bodyMesh.setMatrixAt(i, ZERO); this.tracerMesh.setMatrixAt(i, ZERO); s._shown = false; dirty = true; }
        continue;
      }
      _p.lerpVectors(s.prev, s.p, alpha);
      _d.copy(s.v);
      const sp = _d.length() || 1;
      _d.multiplyScalar(1 / sp);
      _q.setFromUnitVectors(Z, _d);
      _m.compose(_p, _q, _s.set(1, 1, 1));
      this.bodyMesh.setMatrixAt(i, _m);
      // tracer streak behind the shell (shorter in the first metres so it starts at the muzzle)
      const L = Math.min(sp * 0.045, 15, s.age * sp + 0.5);
      const w = 0.16 + Math.min(0.25, game.camera ? game.camera.position.distanceTo(_p) * 0.0012 : 0);
      _m.compose(_s.copy(_p).addScaledVector(_d, -L / 2), _q, _sc.set(w, w, L));
      this.tracerMesh.setMatrixAt(i, _m);
      s._shown = true;
      dirty = true;
    }
    if (dirty) {
      this.bodyMesh.instanceMatrix.needsUpdate = true;
      this.tracerMesh.instanceMatrix.needsUpdate = true;
    }
    this._dirty = false;
  }

  dispose() {
    this.game.unregister?.(this);
    for (const m of [this.bodyMesh, this.tracerMesh]) { if (!m) continue; m.removeFromParent(); m.geometry.dispose(); }
    this.bodyMat?.dispose();
    this.tracerMat?.dispose();
    instances.delete(this.game);
  }
}
