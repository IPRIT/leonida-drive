// Main battle tank controllable: TankPhysics (skid steering) + procedural model, turret/gun aiming at the camera's
// aim point with ballistic drop compensation, pooled shells, armour on top of E's VehicleDamage, crushing.
import * as THREE from 'three';
import { buildTankModel, TANK } from './TankModel.js';
import { TankPhysics, TANK_SPEC } from './TankPhysics.js';
import { TankCamera } from './TankCamera.js';
import { TankHud } from './TankHud.js';
import { Shells, SHELL_BLAST, findVehicle, destroyVehicle, destroyAgent } from './Shells.js';
import { initHeadlightPool, claimHeadlights, releaseHeadlights } from '../headlights.js';
import { WreckFx, seededRandom, wreckPlan } from './Wreck.js';

export const TANK_WEAPON = { reload: 3, speed: 320, yawRate: 0.9, pitchRate: 0.55, pitchMin: -0.14, pitchMax: 0.35, recoil: 0.55 };
// armour loss per event (1 = destroyed): a direct shell hit costs direct + blast ≈ 0.29 → four hits
export const TANK_ARMOR = { shellDirect: 0.22, shellBlast: 0.05, blast: 0.06, bigBlast: 1.5, crushed: 0.1, crash: 0.06, front: 0.85, rear: 1.3 };

let UID = 0;
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _f = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mr = new THREE.Matrix4();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const HEAD_INTENSITY = 30;
const POOLS = new WeakMap();

export class Tank {
  /**
   * @param {object} game
   * @param {{position, yaw?, color?, entry?, env?, quality?: 'high'|'low', remote?: boolean}} o
   */
  constructor(game, o = {}) {
    this.game = game;
    this.uid = ++UID;
    this.scene = game.scene;
    const entry = o.entry || null;
    this.entry = entry;
    this.kind = 'tank';
    this.catalogId = entry?.id || 'tank';
    this.name = entry?.name || 'Mastodon';
    this.brand = entry?.brand || 'Ironwood';
    this.engineSound = entry?.engineSound || 'diesel';
    this.occupied = false;
    this.destroyed = false;
    this.remote = !!o.remote;
    this.color = o.color ?? entry?.palette?.[0] ?? 0xc2a878;
    this.physics = new TankPhysics({
      RAPIER: game.RAPIER, world: game.world, position: o.position || { x: 0, y: 0, z: 0 }, yaw: o.yaw || 0,
      env: o.env ?? game.vehicles?.env, quality: o.quality,
    });
    this.spec = TANK_SPEC;
    const model = (this.model = buildTankModel({ color: this.color }));
    this.materials = model.materials;
    this.parts = model.parts;
    this.object3d = new THREE.Group();
    this.object3d.name = 'vehicle:tank';
    this.object3d.userData.vehicle = this;
    model.root.position.y = -TANK.originY; // object3d sits at the rigid body origin
    this.object3d.add(model.root);
    this.scene?.add(this.object3d);
    this.dims = { ...model.dims };
    this.seats = [{
      pos: new THREE.Vector3(TANK.seat[0], TANK.seat[1] - TANK.originY, TANK.seat[2]),
      exit: new THREE.Vector3(-(TANK.width / 2 + 0.75), -TANK.originY, -1.3),
      pose: 'car', driver: true, recline: 0.12,
    }];
    const oy = TANK.originY;
    this.doors = [new THREE.Vector3(-TANK.width / 2, 1.0 - oy, -1.3)];
    this.enginePos = new THREE.Vector3(0, 1.25 - oy, 2.7);
    this.exhaustPos = new THREE.Vector3(0, 1.3 - oy, 3.76);
    // hints for E's damage system
    this.explosionPower = 2.4;
    this.damageMeshes = model.damageMeshes;

    this.camera = game.camera ? TankCamera.get(game) : null;
    this.shells = Shells.get(game);
    this.turretYaw = 0;
    this.barrelPitch = 0.02;
    this.aimPoint = null;
    this.reloadLeft = 0;
    this.fireSeq = 0;
    this.armor = 1;
    this.fireHeld = false; // external trigger (touch FIRE button, scripts)
    this._fireCbs = new Set();
    this._recoil = 0;
    this._flashT = 0;
    this._turretMoving = false;
    this._turretSpeed = 0;
    this._ctl = { realPad: false, throttle: 0, brake: 0, steer: 0 };
    this._handbrake = false;
    this._lockAskT = 0;
    this._lockFailed = false;
    this._pendingKill = false;
    this._wheelY = new Float32Array(TANK.rwZ.length * 2).fill(TANK.rwY);
    this._wheelYDrawn = new Float32Array(TANK.rwZ.length * 2).fill(TANK.rwY);
    this._emit = { dustL: 0, dustR: 0, exhaust: 0 };
    const reps = Math.max(1, Math.round(model.loop.len / 0.36));
    this._vk = reps / model.loop.len;
    this._time = 0;

    // pooled headlight beams (same protocol as Vehicle: never create lights at runtime)
    this.headlightsOn = false;
    this._lampAnchors = [-1, 1].map((sx) => {
      const a = new THREE.Object3D();
      a.position.set(sx * 1.42, 1.57, -2.9);
      model.hull.add(a);
      return a;
    });
    if (this.scene) POOLS.set(this, initHeadlightPool(this.scene));
    this._offs = [];
    if (game.events) this._offs.push(game.events.on('vehicle:destroyed', (e) => { if (e?.vehicle === this) this._onDestroyed(); }));
    this.updateVisual(1, 0);
  }

  // ---- controllable surface ----
  get body() { return this.physics.body; }
  get telemetry() { return this.physics.telemetry; }
  get drowned() { return this.physics.drowned; }
  set drowned(v) { this.physics.drowned = v; }
  get env() { return this.physics.env; }
  set env(v) { this.physics.env = v; }
  get fallen() { return false; }
  get siren() { return false; }
  set siren(v) { /* no siren */ }
  get hasSiren() { return false; }
  get spots() { const pool = POOLS.get(this); return pool && pool.owner === this ? pool.lights : null; }
  /** True: this controllable has a turret (G's HUD shows the crosshair). */
  get turret() { return this.model.turret; }

  // E's VehicleDamage is attached after spawn (VehicleManager.spawn → damage.attach): wrap it with armour
  get damage() { return this._damage || null; }
  set damage(st) {
    this._damage = st || null;
    if (st && !st.__tank) this._patchDamage(st);
  }

  _patchDamage(st) {
    st.__tank = true;
    st.flammable = false; // no fuel fires: a tank is destroyed when its armour is gone
    const self = this;
    const impact = st.applyImpact, blast = st.applyExplosion, repair = st.repair, explode = st.explode;
    // fire reaching a badly holed tank cooks the ammunition off; healthy armour shrugs it off
    st.ignite = function () { if (self.armor < 0.35) self._startCookOff('fire'); };
    // any direct explode() (scripts, net, other systems) still goes through the cook-off → blast → turret toss
    st.explode = function () {
      if (self._blasting || self.destroyed || this.state === 'destroyed') return explode.call(this);
      self._startCookOff('explode', 0.35);
    };
    st.__explode = explode;
    st.applyImpact = function (p, inward, e, info = {}) {
      if (info.explosion !== undefined) return impact.call(this, p, inward, e * 0.3, info);
      impact.call(this, p, inward, e * 0.15, info);
      self._hurt(Math.max(0, e - 0.3) * TANK_ARMOR.crash, 'crash');
    };
    st.applyExplosion = function (pos, Pw, R, d) {
      const f = Math.pow(clamp(1 - d / R, 0, 1), 1.2);
      blast.call(this, pos, Pw * 0.5, R, d); // dents, lamps, hatch (engine/body are rewritten from the armour)
      // big blasts (another tank, a tanker) hurt more; a car the tank itself just crushed barely scratches it
      const k = SHELL_BLAST.active ? TANK_ARMOR.shellBlast : TANK_ARMOR.blast * (Pw >= 2 ? TANK_ARMOR.bigBlast : 1) * (self._crushing ? TANK_ARMOR.crushed : 1);
      self._hurt(Pw * f * k, SHELL_BLAST.active ? 'shell' : 'blast');
    };
    st.repair = function () {
      repair.call(this);
      self._repairWreck();
      self._sync();
    };
    this._sync();
  }

  _sync() {
    const st = this._damage;
    if (!st || st.state === 'destroyed') return;
    const a = clamp(this.armor, 0, 1);
    st.engine = 0.16 + 0.84 * a; // light smoke below ~50 % armour, dark below ~25 % (VehicleDamage thresholds)
    st.body = 0.15 + 0.85 * a;
  }

  _hurt(amount, cause) {
    if (this.destroyed) return;
    if (amount > 0) {
      this.armor = Math.max(0, this.armor - amount);
      if (this.armor <= 0) this._pendingKill = cause || true;
      this.game.events?.emit('tank:damage', { tank: this, armor: this.armor, cause });
    }
    this._sync();
  }

  /** Direct shell hit (the blast part arrives through fx.explode → damage.onExplosion). */
  takeShellHit(pos, dir, shooter) {
    if (this.destroyed) return;
    _f.set(0, 0, -1).applyQuaternion(this.object3d.quaternion);
    const facing = -(dir.x * _f.x + dir.y * _f.y + dir.z * _f.z); // 1 = hit on the nose
    const k = facing > 0.55 ? TANK_ARMOR.front : facing < -0.55 ? TANK_ARMOR.rear : 1;
    this._hurt(TANK_ARMOR.shellDirect * k, 'shell');
    this.game.fx?.sparks?.(pos, { x: -dir.x, y: 0.4, z: -dir.z }, 26, { speed: 14, spread: 0.6 });
    this.game.events?.emit('tank:struck', { tank: this, shooter, position: pos, armor: this.armor });
    if (this.armor <= 0) this._pendingKill ||= 'shell';
  }

  /**
   * Ammunition cook-off: flame jets from the hatches and pops for 1–2 s (seeded), then the main blast
   * (VehicleDamage.explode → 'vehicle:destroyed' → _onDestroyed: turret toss, fires, secondary explosions).
   */
  _startCookOff(cause = 'armor', duration) {
    if (this._cook || this.destroyed || this.disposed) return;
    const seed = (this.wreckSeed = (Math.random() * 0x7fffffff) | 0);
    const plan = wreckPlan(seededRandom(seed));
    const dur = duration ?? plan.cook;
    this._cook = { seed, cause, t0: this._time };
    this.fireHeld = false;
    const rnd = seededRandom(seed ^ 0x51ed);
    this.game.events?.emit('tank:cookoff', { tank: this, seed, duration: dur, cause, position: this.object3d.position.clone() });
    WreckFx.get(this.game).cookOff({
      owner: this, hull: this.model.root, turret: this.model.turret, duration: dur, rnd,
      onBlast: () => this._blast(),
    });
  }

  _blast() {
    if (this.destroyed || this.disposed) return;
    this._blasting = true;
    try {
      if (this._damage) (this._damage.__explode || this._damage.explode).call(this._damage);
      else {
        this.game.fx?.explode?.(this.body.translation(), this.explosionPower, { exclude: [this.body], source: this });
        this._onDestroyed();
      }
    } finally { this._blasting = false; }
  }

  _onDestroyed() {
    if (this.disposed) return;
    this.destroyed = true;
    this._pendingKill = false;
    this.reloadLeft = 0;
    this._flashT = 0;
    this.fireHeld = false;
    this._cook = null;
    WreckFx.get(this.game).cancel(this); // a cook-off still running (direct explode) stops here
    if (this.wreckSeed === undefined || this.wreckSeed === null) this.wreckSeed = (Math.random() * 0x7fffffff) | 0;
    const seed = this.wreckSeed;
    const plan = (this._wreckPlan = wreckPlan(seededRandom(seed)));
    const rnd = seededRandom(seed ^ 0x7a11);
    const b = this.body;
    // VehicleDamage lifts car wrecks; a 55 t hull only rocks — the turret is what flies
    const lv = b.linvel(), av = b.angvel();
    b.setLinvel({ x: lv.x * 0.3, y: Math.min(lv.y, 2.0), z: lv.z * 0.3 }, true);
    b.setAngvel({ x: av.x * 0.15, y: av.y * 0.3, z: av.z * 0.15 }, true);
    try { this.physics.colliders[1]?.setEnabled(false); } catch { /* collider gone */ } // turret ring collider
    const sys = WreckFx.get(this.game);
    const t = this.model.turret;
    if (t.parent && !this._turretHome) {
      const barrel = this.model.barrel;
      this._turretHome = {
        parent: t.parent, pos: t.position.clone(), quat: t.quaternion.clone(), scale: t.scale.clone(),
        barrel: { parent: barrel.parent, pos: barrel.position.clone(), quat: barrel.quaternion.clone(), scale: barrel.scale.clone() },
      };
      this._damage?.deformer?.setSkip?.(t, true);
      const items = sys.throwTurret(t, { owner: this, rnd, vel: lv, hullQuat: this.object3d.quaternion, barrel: plan.barrel });
      this._turretItem = items?.turret || null;
      this._barrelItem = items?.barrel || null;
      if (!items) this._turretHome = null; // no FX: the turret stays (nothing to restore)
    }
    sys.aftermath({ owner: this, hull: this.model.root, rnd, duration: 26 });
    for (const side of plan.links) {
      sys.trackLinks(this.model.root, side, rnd);
      const tk = this.model.tracks.find((x) => x.side === side);
      if (tk) tk.mesh.visible = false; // thrown track
    }
    this._sag = plan.sag;
    this.game.events?.emit('tank:destroyed', {
      tank: this, seed, position: this.object3d.position.clone(), quaternion: this.object3d.quaternion.clone(),
      turretYaw: this.turretYaw, barrelPitch: this.barrelPitch, color: this.color,
    });
  }

  // repair (E's damage.repair or a respawn in place): turret, gun, tracks, colliders and FX back to new
  _repairWreck() {
    WreckFx.get(this.game).cancel(this);
    const fx = this.game.fx;
    const h = this._turretHome;
    if (h) {
      const t = this.model.turret, barrel = this.model.barrel;
      for (const it of [this._turretItem, this._barrelItem]) if (it && !it.removed) fx?.debrisSys?.removeMesh?.(it, false);
      h.parent.add(t);
      t.position.copy(h.pos); t.quaternion.copy(h.quat); t.scale.copy(h.scale);
      h.barrel.parent.add(barrel);
      barrel.position.copy(h.barrel.pos); barrel.quaternion.copy(h.barrel.quat); barrel.scale.copy(h.barrel.scale);
      this._damage?.deformer?.setSkip?.(t, false);
    }
    this.model.barrel.rotation.set(this.barrelPitch, 0, 0);
    this._turretItem = this._barrelItem = null;
    this._turretHome = null;
    for (const tk of this.model.tracks) tk.mesh.visible = true;
    try { this.physics.colliders[1]?.setEnabled(true); } catch { /* collider gone */ }
    this._sag = null;
    this._cook = null;
    this._pendingKill = false;
    this.wreckSeed = null;
    this.armor = 1;
    this.destroyed = false;
  }

  // ---- input ----
  _playerDriving() {
    const p = this.game.player;
    return !!p && p.controllable === this && p.mode === 'vehicle';
  }

  fixedUpdate(dt, input = {}) {
    const driver = input.driver !== false;
    let thr = +input.throttle || 0, brk = +input.brake || 0, st = +input.steer || 0;
    if (driver && this._ctl.realPad && this._playerDriving()) {
      // physical gamepad: RT is the trigger, so drive with the left stick (+ keys); keep VehicleDamage's limp factor
      const limp = this._damage && this._damage.engine < 0.35 ? clamp(0.35 + 1.5 * this._damage.engine, 0, 1) : 1;
      thr = this._ctl.throttle * limp;
      brk = this._ctl.brake;
      st = this._ctl.steer;
    }
    if (!driver) thr = brk = st = 0;
    this._handbrake = driver && !!input.handbrake;
    this.physics.fixedUpdate(dt, { throttle: thr, brake: brk, steer: st, disabled: this.destroyed || !!this._cook });
    if (!this.destroyed) this._crush();
  }

  // read the trigger and (with a physical pad) the drive axes; returns true while the trigger is held
  _controls() {
    const game = this.game, inp = game.input;
    const c = this._ctl;
    if (!inp) { c.realPad = false; return this.fireHeld; }
    let real = false;
    try { const pads = navigator.getGamepads?.() || []; for (const p of pads) if (p && p.connected) { real = true; break; } } catch { real = false; }
    c.realPad = real && !!inp.gamepad;
    const blocked = game.paused || game.ui?.isOpen;
    if (c.realPad) {
      const k = (a, b) => (inp.held(a) || inp.held(b) ? 1 : 0);
      const ly = inp.axis(1), lx = inp.axis(0);
      c.throttle = Math.max(k('KeyW', 'ArrowUp'), ly < 0 ? -ly : 0);
      c.brake = Math.max(k('KeyS', 'ArrowDown'), ly > 0 ? ly : 0, inp.gpValue(6));
      // same feel as DriveInput: progressive stick curve, keys stay digital (the physics filters the command)
      const ls = Math.sign(lx) * Math.pow(Math.abs(lx), 1.5);
      c.steer = clamp(k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft') + ls, -1, 1);
    }
    let fire = this.fireHeld || this._handbrake;
    if (blocked) return false;
    const locked = !!inp.mouse?.locked;
    if (locked) fire = fire || inp.held('Mouse0');
    else if (inp.pressed('Mouse0') && !inp.touch) {
      // first click captures the mouse for aiming; if the browser refuses pointer lock, clicks fire directly
      if (this._lockFailed) fire = true;
      else { inp.lockPointer?.(); this._lockAskT = performance.now(); }
    }
    if (this._lockAskT && !locked && performance.now() - this._lockAskT > 700) { this._lockFailed = true; this._lockAskT = 0; }
    if (locked) this._lockAskT = 0;
    if (c.realPad && inp.gpValue(7) > 0.5) fire = true;
    return fire;
  }

  // ---- turret & gun ----
  _aim(dt) {
    const P = this.aimPoint;
    if (!P || this.destroyed) { this._turretSpeed = 0; return; }
    const o = this.object3d;
    // trunnion in world space (current turret yaw)
    _v.set(TANK.trunnion[0], TANK.trunnion[1], TANK.trunnion[2]).applyAxisAngle(_n.set(0, 1, 0), this.turretYaw);
    _v.x += TANK.turret[0]; _v.y += TANK.turret[1] - TANK.originY; _v.z += TANK.turret[2];
    _p.copy(_v).applyQuaternion(o.quaternion).add(o.position);
    const dx = P.x - _p.x, dy = P.y - _p.y, dz = P.z - _p.z;
    const dh = Math.hypot(dx, dz);
    if (dh < 2) { this._turretSpeed = 0; return; }
    // low ballistic solution for the muzzle velocity
    const v = TANK_WEAPON.speed, g = 9.81, v2 = v * v;
    const disc = v2 * v2 - g * (g * dh * dh + 2 * dy * v2);
    const th = disc > 0 ? Math.atan((v2 - Math.sqrt(disc)) / (g * dh)) : Math.atan2(dy, dh);
    _d.set((dx / dh) * Math.cos(th), Math.sin(th), (dz / dh) * Math.cos(th));
    _qi.copy(o.quaternion).invert();
    _d.applyQuaternion(_qi);
    const yawT = Math.atan2(-_d.x, -_d.z);
    const pitchT = Math.asin(clamp(_d.y, -1, 1));
    const W = TANK_WEAPON;
    const dyaw = clamp(wrap(yawT - this.turretYaw), -W.yawRate * dt, W.yawRate * dt);
    this.turretYaw = wrap(this.turretYaw + dyaw);
    // less depression over the engine deck
    const rearArc = Math.abs(this.turretYaw) > 2.3;
    const pmin = rearArc ? -0.02 : W.pitchMin;
    this.barrelPitch = clamp(this.barrelPitch + clamp(pitchT - this.barrelPitch, -W.pitchRate * dt, W.pitchRate * dt), pmin, W.pitchMax);
    this._turretSpeed = dt > 0 ? Math.abs(dyaw) / dt : 0;
  }

  /** World muzzle position and bore direction. */
  muzzleWorld(outPos = new THREE.Vector3(), outDir = new THREE.Vector3()) {
    const m = this.model;
    this.object3d.updateMatrixWorld(true);
    m.muzzle.getWorldPosition(outPos);
    m.barrel.getWorldQuaternion(_q0);
    outDir.set(0, 0, -1).applyQuaternion(_q0).normalize();
    return outPos;
  }

  /** Point the gun currently aims at (same range as the aim point), for reticles. */
  gunAimPoint(out = new THREE.Vector3()) {
    this.muzzleWorld(out, _w);
    const dist = this.aimPoint ? Math.max(10, out.distanceTo(this.aimPoint)) : 300;
    return out.addScaledVector(_w, dist);
  }

  /** Gunner's sight in world space (TankCamera 'sight' mode). */
  sightWorld(out = new THREE.Vector3()) {
    out.set(TANK.sight[0], TANK.sight[1], TANK.sight[2]);
    return this.model.turret.localToWorld(out);
  }

  /** Fire if loaded. Returns true when a shell left the barrel. */
  fire() {
    if (this.destroyed || this._cook || this.reloadLeft > 0 || this.drowned || this._turretHome) return false;
    const pos = this.muzzleWorld(_p, _d);
    const origin = { x: pos.x + _d.x * 0.2, y: pos.y + _d.y * 0.2, z: pos.z + _d.z * 0.2 };
    const dir = { x: _d.x, y: _d.y, z: _d.z };
    this.shells.spawn({ origin, dir, speed: TANK_WEAPON.speed, owner: this, ownerBody: this.body });
    this._afterShot(origin, dir, true);
    return true;
  }

  /** Multiplayer: replay a shot fired by the remote owner of this tank (visual shell, no damage by default). */
  remoteFire({ origin, dir, speed = TANK_WEAPON.speed, damage = false } = {}) {
    if (!origin || !dir) return;
    this.shells.spawn({ origin, dir, speed, owner: this, ownerBody: this.body, damage });
    this._afterShot(origin, dir, false);
  }

  _afterShot(origin, dir, local) {
    const game = this.game;
    this.reloadLeft = TANK_WEAPON.reload;
    this._recoil = 1;
    this._flashT = 0.11;
    if (this.model.flash) this.model.flash.rotation.z = Math.random() * Math.PI;
    this.fireSeq++;
    if (local) {
      // recoil rocks the hull (well below the impact thresholds)
      _v.set(TANK.turret[0], TANK.turret[1] + 0.4 - TANK.originY, TANK.turret[2]).applyMatrix4(this.object3d.matrixWorld);
      const J = 26000;
      this.body.applyImpulseAtPoint({ x: -dir.x * J, y: -dir.y * J * 0.3, z: -dir.z * J }, { x: _v.x, y: _v.y, z: _v.z }, true);
    }
    const fx = game.fx;
    if (fx) {
      fx.smoke?.({ x: origin.x + dir.x * 1.2, y: origin.y, z: origin.z + dir.z * 1.2 }, { color: 'light', count: 9, size: 1.4, velocity: { x: dir.x * 5, y: 0.6, z: dir.z * 5 } });
      const t = this.body.translation();
      if (this.barrelPitch < 0.12) fx.dust?.({ x: origin.x - dir.x * 1.5, y: t.y + 0.2, z: origin.z - dir.z * 1.5 }, 2.2, { count: 10, speed: 4, rise: 0.4 });
    }
    const ev = { origin, position: origin, dir, speed: TANK_WEAPON.speed, t: game.time ?? 0, tank: this, remote: !local };
    game.events?.emit('tank:fire', ev);
    for (const cb of this._fireCbs) { try { cb(ev); } catch (e) { console.error('[tank] onFire', e); } }
    for (const cb of this.shells.listeners) { try { cb(ev); } catch (e) { console.error('[tank] onFire', e); } }
    if (this._playerDriving()) {
      game.events?.emit('tank:reload', { t: TANK_WEAPON.reload, total: TANK_WEAPON.reload, tank: this });
      game.events?.emit('camera:shake', { amount: 0.55 });
    }
  }

  /** Subscribe to this tank's shots: cb({origin, dir, speed, t, tank, remote}). Returns unsubscribe. */
  onFire(cb) {
    this._fireCbs.add(cb);
    return () => this._fireCbs.delete(cb);
  }

  // ---- crushing: any wheeled vehicle touching the hull or running gear explodes ----
  _crush() {
    const game = this.game, world = game.world;
    if (!world) return;
    const tr = game.traffic;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    const test = (other, touching) => {
      if (!other || seen.has(other.handle)) return;
      seen.add(other.handle);
      const a = tr?.colliderMap?.get(other.handle);
      if (a) {
        if (!touching()) return;
        const t = this.body.translation();
        const l = Math.hypot(a.cur.x - t.x, a.cur.z - t.z) || 1;
        const dir = { x: (a.cur.x - t.x) / l, z: (a.cur.z - t.z) / l };
        this._crushing = true;
        let ok = false;
        try { ok = destroyAgent(game, a, dir); } finally { this._crushing = false; }
        if (ok) game.events?.emit('tank:crush', { tank: this, agent: a, position: { x: a.cur.x, y: a.cur.y, z: a.cur.z } });
        return;
      }
      const ob = other.parent?.();
      if (!ob || ob.isFixed() || ob.handle === this.body.handle) return;
      const v = findVehicle(game, ob);
      if (!v || v === this || v.kind === 'tank' || v.destroyed || !touching()) return;
      const p = v.body.translation();
      this._crushing = true;
      let ok = false;
      try { ok = destroyVehicle(game, v); } finally { this._crushing = false; }
      if (ok) game.events?.emit('tank:crush', { tank: this, vehicle: v, position: { x: p.x, y: p.y, z: p.z } });
    };
    for (const col of this.physics.colliders) {
      world.contactPairsWith(col, (other) => {
        test(other, () => {
          let hit = false;
          world.contactPair(col, other, (m) => {
            const n = m.numContacts();
            for (let k = 0; k < n && !hit; k++) if (m.contactDist(k) < 0.06) hit = true;
          });
          return hit;
        });
      });
    }
    for (const c of this.physics.rayHits) test(c, () => true);
  }

  // ---- per frame ----
  updateVisual(alpha = 1, frameDt = 0) {
    const ph = this.physics, body = ph.body, m = this.model;
    const t = body.translation(), r = body.rotation();
    const pp = ph.prevPos, pr = ph.prevRot;
    this.object3d.position.set(pp.x + (t.x - pp.x) * alpha, pp.y + (t.y - pp.y) * alpha, pp.z + (t.z - pp.z) * alpha);
    _q0.set(pr.x, pr.y, pr.z, pr.w);
    _q1.set(r.x, r.y, r.z, r.w);
    this.object3d.quaternion.slerpQuaternions(_q0, _q1, alpha);
    const dt = frameDt;
    const player = this._playerDriving();
    if (dt > 0) {
      this._time += dt;
      if (this._pendingKill && !this.destroyed) {
        const cause = this._pendingKill;
        this._pendingKill = false;
        this._startCookOff(typeof cause === 'string' ? cause : 'armor');
      }
      if (this.reloadLeft > 0) {
        this.reloadLeft = Math.max(0, this.reloadLeft - dt);
        if (this.reloadLeft === 0 && player) this.game.events?.emit('tank:reload', { t: 0, total: TANK_WEAPON.reload, tank: this, ready: true });
      }
      if (!this.remote) {
        const trigger = player ? this._controls() : this.fireHeld;
        if (player || this.aimPoint) this._aim(dt);
        if (trigger && this.reloadLeft <= 0) this.fire();
      }
      const moving = this._turretSpeed > 0.05;
      if (moving !== this._turretMoving && player) {
        this._turretMoving = moving;
        this.game.events?.emit('tank:turret', { tank: this, moving });
      }
      this._recoil = Math.max(0, this._recoil - dt * 1.5);
      this._flashT = Math.max(0, this._flashT - dt);
    }
    const tel = ph.telemetry;
    tel.turretYaw = this.turretYaw;
    tel.barrelPitch = this.barrelPitch;
    tel.turretSpeed = this._turretSpeed;
    // turret, gun, recoil, flash
    m.turret.rotation.y = this.turretYaw;
    m.barrel.rotation.x = this.barrelPitch;
    const rc = this._recoil;
    m.recoil.position.z = TANK_WEAPON.recoil * (rc > 0.85 ? (1 - rc) / 0.15 : rc / 0.85) * (rc > 0 ? 1 : 0);
    if (m.flash) {
      const k = this._flashT / 0.11;
      m.flash.scale.setScalar(k > 0 ? 0.35 + k * (1.1 + Math.random() * 0.25) : 0.0001);
    }
    this._runningGear(alpha);
    this._lights(dt);
    if (dt > 0) this._effects(dt);
    if (player) TankHud.get(this.game).update(this);
    else if (this._hudShown !== false) { TankHud.get(this.game).release(this); this._hudShown = false; }
    if (player) this._hudShown = true;
  }

  _runningGear(alpha) {
    const ph = this.physics, m = this.model, T = TANK;
    const dL = ph.trackDistL, dR = ph.trackDistR;
    // tread scroll (one material per side)
    for (const tk of m.tracks) {
      const map = tk.mat.map;
      if (!map) continue;
      const d = tk.side < 0 ? dL : dR;
      map.offset.y = -((d * this._vk) % 1);
    }
    for (let i = 0; i < 2; i++) {
      const d = i === 0 ? dL : dR;
      m.sprockets[i].rotation.x = -d / (T.sprocket[2] + T.th);
      m.idlers[i].rotation.x = -d / (T.idler[2] + T.th);
    }
    // road wheels follow their suspension; spin from the track travel
    const n = T.rwZ.length;
    let k = 0;
    for (const w of ph.wheels) {
      if (!w.road) continue;
      const dist = w.prevDist + (w.dist - w.prevDist) * alpha;
      this._wheelY[k++] = w.mountY - dist + TANK.originY;
    }
    const rw = m.roadWheels;
    if (rw.disc) {
      for (let i = 0; i < rw.list.length; i++) {
        const wl = rw.list[i];
        const spin = -(wl.side < 0 ? dL : dR) / T.rwR;
        _mr.makeRotationX(spin);
        _m.makeTranslation(wl.x, this._wheelY[i], wl.z).multiply(_mr);
        rw.disc.setMatrixAt(i, _m);
        rw.tyre.setMatrixAt(i, _m);
      }
      rw.disc.instanceMatrix.needsUpdate = true;
      rw.tyre.instanceMatrix.needsUpdate = true;
    }
    // lower track run follows the road wheels
    let change = 0;
    for (let i = 0; i < this._wheelY.length; i++) change = Math.max(change, Math.abs(this._wheelY[i] - this._wheelYDrawn[i]));
    const sag = this._sag || null;
    if (change > 0.003 || sag !== this._sagDrawn) {
      this._sagDrawn = sag;
      this._wheelYDrawn.set(this._wheelY);
      const zs = [T.idler[0], ...T.rwZ, T.sprocket[0]];
      for (const tk of m.tracks) {
        const off = tk.side < 0 ? 0 : n;
        const ys = [0];
        for (let i = 0; i < n; i++) ys.push(this._wheelY[off + i] - T.rwY);
        ys.push(0);
        const attr = tk.mesh.geometry.attributes.position;
        const a = attr.array, b = tk.base;
        const sg = sag ? sag[tk.side < 0 ? 0 : 1] : 0;
        for (let i = 0; i < a.length; i += 3) {
          const y0 = b[i + 1];
          const z = b[i + 2];
          if (y0 > 0.62) {
            // wrecked: the upper run hangs slack between the idler and the sprocket
            if (sg) { const u = clamp((z - T.idler[0]) / (T.sprocket[0] - T.idler[0]), 0, 1); a[i + 1] = y0 - sg * Math.sin(Math.PI * u) * (y0 > 0.8 ? 1 : 0.4); }
            else a[i + 1] = y0;
            continue;
          }
          let j = 0;
          while (j < zs.length - 2 && z > zs[j + 1]) j++;
          const u = clamp((z - zs[j]) / (zs[j + 1] - zs[j]), 0, 1);
          const dy = ys[j] + (ys[j + 1] - ys[j]) * u;
          const wgt = y0 < T.rwY ? 1 : (0.62 - y0) / (0.62 - T.rwY);
          a[i + 1] = y0 + dy * wgt;
        }
        attr.needsUpdate = true;
      }
    }
  }

  _lights(dt) {
    const on = this.headlightsOn && !this.destroyed;
    const mt = this.materials;
    mt.head.emissiveIntensity = on ? 2.2 : 0.1;
    mt.tail.emissiveIntensity = (on ? 0.7 : 0.2) + (this.physics.telemetry.braking ? 1.4 : 0);
    const pool = POOLS.get(this);
    if (!pool || pool.owner !== this) return;
    if (!on) { for (const s of pool.lights) s.intensity = 0; return; }
    this.object3d.updateMatrixWorld(true);
    _f.set(0, 0, -1).applyQuaternion(this.object3d.quaternion);
    _n.set(0, 1, 0).applyQuaternion(this.object3d.quaternion);
    for (let i = 0; i < pool.lights.length; i++) {
      const s = pool.lights[i], a = this._lampAnchors[i];
      if (!a) { s.intensity = 0; continue; }
      a.getWorldPosition(s.position);
      s.target.position.copy(s.position).addScaledVector(_f, 20).addScaledVector(_n, -1.8);
      s.target.updateMatrixWorld();
      s.intensity = HEAD_INTENSITY;
    }
  }

  _effects(dt) {
    const ph = this.physics, game = this.game;
    const smoke = game.vehicles?.smoke, skids = game.vehicles?.skid;
    if (!smoke && !skids) return;
    const lv = this.body.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    const tel = ph.telemetry;
    // exhaust puffs under load
    if (smoke && !this.destroyed && !this.drowned) {
      this._emit.exhaust += dt * (2 + tel.engineLoad * 14);
      if (this._emit.exhaust >= 1) {
        this._emit.exhaust = 0;
        _p.copy(this.exhaustPos).applyMatrix4(this.object3d.matrixWorld);
        _f.set(0, 0, 1).applyQuaternion(this.object3d.quaternion);
        smoke.emit(tel.engineLoad > 0.55 ? 'smoke' : 'exhaust', _p.x, _p.y, _p.z, _f.x * 1.5 + lv.x * 0.5, 0.6, _f.z * 1.5 + lv.z * 0.5, 0.8 + tel.engineLoad * 0.6);
      }
    }
    // dust / grass behind each track, scuff marks on hard ground while pivoting
    const pivot = Math.abs(ph.trackL - ph.trackR) > 0.6;
    for (let side = 0; side < 2; side++) {
      const sx = side ? 1 : -1;
      let w = null;
      for (const x of ph.wheels) if (x.road && x.side === sx && x.contact && (!w || x.z > w.z)) w = x;
      const id = `tank${this.uid}${side}`;
      if (!w) { skids?.end(id); continue; }
      const surf = w.surface.name;
      const loose = w.surface.dust || surf === 'dirt' || surf === 'sand' || surf === 'grass';
      const ts = Math.abs(side ? ph.trackR : ph.trackL);
      if (skids) {
        const mark = loose ? ts > 0.3 : pivot;
        if (mark && !w.inWater) {
          _p.set(w.point.x, w.point.y, w.point.z);
          _n.set(w.normal.x, w.normal.y, w.normal.z);
          _w.set(1, 0, 0).applyQuaternion(this.object3d.quaternion);
          skids.emit(id, _p, _w, _n, TANK.trackW, loose ? 0.45 : 0.35);
        } else skids.end(id);
      }
      if (smoke && loose && (speed > 2 || ts > 1)) {
        const key = side ? 'dustR' : 'dustL';
        this._emit[key] += dt * Math.min(30, speed * 1.6 + ts * 2) * (surf === 'grass' ? 0.5 : 1);
        while (this._emit[key] >= 1) {
          this._emit[key] -= 1;
          smoke.emit(surf === 'grass' ? 'grass' : 'dust', w.point.x + (Math.random() - 0.5) * 0.6, w.point.y + 0.2, w.point.z + (Math.random() - 0.5) * 0.6, lv.x * 0.2, 0.3, lv.z * 0.2, 1.3);
        }
      }
    }
  }

  // ---- misc controllable API ----
  reset(position, yaw = 0) {
    this.physics.reset(position, yaw);
    this.updateVisual(1, 0);
  }

  clearForces() { this.physics.clearForces(); }
  setVelocity(v) { this.physics.setVelocity(v); }

  setColor(hex) {
    this.color = hex;
    const m = this.materials.paint;
    m.color.set(hex);
    const s = this._damage?.mats?.get?.(m);
    if (s) s.color = m.color.getHex();
  }

  /** Respray (economy): tanks keep a matte finish, only the colour changes. */
  setPaint({ color } = {}) {
    if (color !== undefined && color !== null) this.setColor(color);
  }

  setHeadlights(on) {
    this.headlightsOn = !!on;
    const pool = POOLS.get(this);
    if (!pool) return;
    if (this.headlightsOn && (!pool.owner || pool.owner === this || this.occupied || !pool.owner.occupied || !pool.owner.headlightsOn)) claimHeadlights(pool, this);
    if (pool.owner === this && !this.headlightsOn) for (const s of pool.lights) s.intensity = 0;
  }

  setIndicator() { /* none */ }

  /** Replicated pose for multiplayer (J). */
  netState(out = {}) {
    out.turretYaw = this.turretYaw;
    out.barrelPitch = this.barrelPitch;
    out.trackL = this.physics.trackL;
    out.trackR = this.physics.trackR;
    out.fireSeq = this.fireSeq;
    out.armor = this.armor;
    out.reload = this.reloadLeft;
    out.destroyed = !!this.destroyed;
    out.cookOff = !!this._cook;
    out.wreckSeed = this.wreckSeed ?? 0;
    return out;
  }

  /** Apply a replicated pose (remote puppet). Shots are replayed with remoteFire(). */
  applyNetState(s, dt = 0) {
    if (!s) return;
    this.remote = true;
    if (Number.isFinite(s.turretYaw)) this.turretYaw = s.turretYaw;
    if (Number.isFinite(s.barrelPitch)) this.barrelPitch = s.barrelPitch;
    if (Number.isFinite(s.armor)) this.armor = s.armor;
    const ph = this.physics;
    if (Number.isFinite(s.trackL)) { ph.trackL = s.trackL; if (dt > 0) ph.trackDistL += s.trackL * dt; }
    if (Number.isFinite(s.trackR)) { ph.trackR = s.trackR; if (dt > 0) ph.trackDistR += s.trackR * dt; }
  }

  dispose() {
    const pool = POOLS.get(this);
    releaseHeadlights(pool, this);
    for (const off of this._offs) off();
    TankHud.get(this.game).release(this);
    WreckFx.get(this.game).cancel(this);
    for (const it of [this._turretItem, this._barrelItem]) if (it && !it.removed) this.game.fx?.debrisSys?.removeMesh?.(it, false);
    this.model.turret.removeFromParent();
    this.model.barrel.removeFromParent();
    const skids = this.game.vehicles?.skid;
    if (skids) for (let i = 0; i < 2; i++) skids.tracks?.delete?.(`tank${this.uid}${i}`);
    this.object3d.removeFromParent();
    const geos = new Set();
    this.object3d.traverse((o) => { if (o.isMesh) geos.add(o.geometry); });
    this.model.turret.traverse((o) => { if (o.isMesh) geos.add(o.geometry); });
    this.model.barrel.traverse((o) => { if (o.isMesh) geos.add(o.geometry); });
    for (const g of geos) g.dispose();
    for (const mt of Object.values(this.materials)) {
      if (mt.map && (mt === this.materials.trackL || mt === this.materials.trackR)) mt.map.dispose();
      mt.dispose();
    }
    this.physics.dispose();
    this.disposed = true;
  }
}
