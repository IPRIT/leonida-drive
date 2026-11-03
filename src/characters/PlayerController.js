// Player controller (replaces core/BasicPlayer): on foot with a kinematic capsule + procedural animation,
// enter/exit and carjacking, visible seated driver, health/armor/money, ragdolls, wasted/respawn.
// Public API is a superset of BasicPlayer (see INTEGRATION.md).
import * as THREE from 'three';
import { ChaseCamera, DriveInput, GROUPS, groups } from '../vehicle/index.js';
import { FreeCamera } from '../cam/FreeCamera.js';
import { roadSpawn, headingYaw, recoverVehicle } from '../core/BasicPlayer.js';
import { NJ, ROOT, makeDims, fk, pelvisMatrix, quatToMat, mulLocal, matToQuat } from './rig.js';
import * as PZ from './poses.js';
import { lookData, makeLook, lookFromSeed, rng } from './looks.js';
import { WARDROBE, WARDROBE_BY_ID, DEFAULT_OUTFIT, normalizeOutfit, outfitToLook, outfitKey, createCharacterPreview } from './wardrobe.js';
import { HumanBatch } from './HumanBatch.js';
import { CharacterMotor } from './CharacterMotor.js';
import { OrbitCamera } from './OrbitCamera.js';
import { getRagdolls } from './Ragdoll.js';
import { vehicleKnock, blastKnock, pushVehicle, hoodRamp } from './impact.js';
import { Cash } from './Cash.js';
import {
  tr, seatFor, vehicleBox, agentBox, boxLocal, takeOverTraffic, groundY, surfaceAt, sidewalkSpawn, nearestHospital,
  clamp, wrapAngle,
} from './util.js';

const WALK = 1.55, RUN = 4.3, SPRINT = 7.1;
// swimming: normal crawl, sprint (Shift / gamepad A / touch stick pushed to the edge) and the sprint speed once the
// swim stamina (14 s of sprinting, refills in 6 s) runs out (still faster than the crawl: no frustrating stops)
const SWIM = 1.8, SWIM_FAST = 3.3, SWIM_TIRED = 2.5;
const JUMP_V = 4.7;
const HOSPITAL_FEE = 100;
const SEA = 0;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _V = new Float32Array(12), _Ma = new Float32Array(12), _Mb = new Float32Array(12);
const _qa = {}, _qb = {};
const _box = {}, _loc = {}, _kn = {};
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

// out = lerp(A, B, t) for 3x4 rigid matrices (slerped rotation)
function lerpMat(out, A, B, t) {
  matToQuat(A, 0, _qa); matToQuat(B, 0, _qb);
  _q1.set(_qa.x, _qa.y, _qa.z, _qa.w);
  _q2.set(_qb.x, _qb.y, _qb.z, _qb.w);
  _q1.slerp(_q2, t);
  quatToMat(out, 0, A[9] + (B[9] - A[9]) * t, A[10] + (B[10] - A[10]) * t, A[11] + (B[11] - A[11]) * t, _q1.x, _q1.y, _q1.z, _q1.w);
  return out;
}

const _lp = new THREE.Vector3(), _lq = new THREE.Quaternion(), _ls = new THREE.Vector3(), _loff = new THREE.Vector3();
function vehicleMatrix(v, out) {
  const o = v.object3d;
  // two-wheelers lean visually (leanPivot); the rider must lean with the bike, not stay upright with the frame
  if (v.leanPivot && v.spec?.com && (v.spec.twoWheel || v.kind === 'motorcycle' || v.kind === 'bicycle')) {
    v.leanPivot.updateWorldMatrix(true, false);
    v.leanPivot.matrixWorld.decompose(_lp, _lq, _ls);
    _loff.set(0, v.spec.com.y, v.spec.com.z).applyQuaternion(_lq);
    quatToMat(out, 0, _lp.x - _loff.x, _lp.y - _loff.y, _lp.z - _loff.z, _lq.x, _lq.y, _lq.z, _lq.w);
    return out;
  }
  quatToMat(out, 0, o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w);
  return out;
}

export class PlayerController {
  /**
   * @param {object} game
   * @param {{x,y,z,yaw}} spawnPoint
   * @param {{startOnFoot?: boolean, look?: object, money?: number}} [opts]
   */
  constructor(game, spawnPoint, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.mode = 'foot';
    this.state = 'foot'; // foot | enter | vehicle | exit | ragdoll | getup
    this.health = 1;
    this.armor = 0;
    this.money = opts.money ?? 0;
    this.god = false;
    this.waypoint = null;
    this.route = null;
    this.routeTimer = 0;
    this.wastedT = 0;
    this.lastSafe = null;
    this.focus = new THREE.Vector3(spawnPoint.x, spawnPoint.y, spawnPoint.z);
    this.spawnPoint = spawnPoint;
    this.controllable = null;
    this.lastVehicle = null;
    this.driveInput = new DriveInput();
    const dom = game.renderer.domElement;
    const camRay = new game.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this.chase = new ChaseCamera(game.camera, dom, {
      getGroundHeight: (x, z) => game.roads?.tunnelFloorAt?.(x, z) ?? Math.max(game.terrain.heightAt(x, z), 0),
      input: this.driveInput,
      raycast: (o, d, max) => {
        camRay.origin = { x: o.x, y: o.y, z: o.z };
        camRay.dir = { x: d.x, y: d.y, z: d.z };
        const hit = game.world.castRay(camRay, max, true, undefined, groups(0xffff, GROUPS.STATIC));
        return hit ? hit.timeOfImpact : null;
      },
    });
    this.free = new FreeCamera(game.camera, dom, { getGroundHeight: (x, z) => game.terrain.heightAt(x, z) });
    this.orbit = new OrbitCamera(game);

    // ---- character ----
    // appearance: an explicit look/seed, else the outfit (economy's saved outfit, opts.outfit, the protagonist)
    if (!game.wardrobe) game.wardrobe = { items: WARDROBE, byId: WARDROBE_BY_ID };
    if (!game.characters) game.characters = {};
    if (!game.characters.createPreview) game.characters.createPreview = (el, o) => createCharacterPreview(game, el, o);
    this.outfit = normalizeOutfit(opts.outfit || game.economy?.outfit || DEFAULT_OUTFIT);
    this._outfitKey = outfitKey(this.outfit);
    this.look = opts.look || (opts.lookSeed !== undefined ? lookFromSeed(opts.lookSeed) : outfitToLook(this.outfit));
    this.dims = makeDims(this.look);
    this.lookData = lookData(this.look, this.dims);
    // draw through the pedestrians' batch when it exists (no extra draw calls); it flushes after lateUpdate
    const shared = game.peds?.batch;
    this.slot = shared ? shared.alloc() : -1;
    if (this.slot >= 0) { this.batch = shared; this.ownBatch = false; } else {
      this.batch = new HumanBatch(game.scene, 4, { far: false, mid: false });
      this.ownBatch = true;
      this.slot = this.batch.alloc();
    }
    this.batch.setLook(this.slot, this.lookData);
    this.pose = PZ.newPose();
    this.target = PZ.newPose();
    this._seatP = PZ.newPose();
    this.W = new Float32Array(NJ * 12);
    this.M = new Float32Array(12);
    this.motor = new CharacterMotor(game.RAPIER, game.world, { radius: 0.3, height: this.dims.h, pos: spawnPoint });
    this.motor.setEnabled(false);
    this.pos = new THREE.Vector3(spawnPoint.x, spawnPoint.y, spawnPoint.z); // interpolated feet
    this.yaw = spawnPoint.yaw ?? 0;
    this.hv = { x: 0, z: 0 };
    this.speed = 0;
    this.phase = 0;
    this.animT = 0;
    this.act = null; // roll | bail | climb
    this.actT = 0;
    this.landK = 0;
    this.swim = false;
    this.swimStamina = 1; // 0..1, sprint swimming (UI may show it)
    this.diving = false;
    this.breath = 1;
    this.sinceDamage = 99;
    this.hitCool = 0;
    this.walkToggle = false;
    this.jumpReq = false;
    this.seq = null;
    this.rd = null;
    this.getup = null;
    this.steer = 0;
    this.pedal = 0;
    this.camBlend = null;
    this.helpT = 0;
    this.safeT = 0;
    this._lastStep = 0;
    this.fires = new Map();
    this.ragdolls = getRagdolls(game);
    if (!game.cash) {
      game.cash = new Cash(game);
      game.register(game.cash, 20);
    }
    game.peds?.attach?.(game);
    this._startOnFoot = !!opts.startOnFoot;
    this._char = { position: this.pos, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, state: 'foot', swimming: false, grounded: true, ragdoll: null, dims: this.dims, look: this.look };
    const ev = game.events;
    this._off = [
      ev.on('explosion', (e) => this.onExplosion(e)),
      ev.on('fire:start', (e) => { if (e?.position) this.fires.set(e.target ?? `${e.position.x | 0},${e.position.z | 0}`, e.position); }),
      ev.on('fire:stop', (e) => { this.fires.delete(e?.target ?? `${e?.position?.x | 0},${e?.position?.z | 0}`); }),
      ev.on('vehicle:destroyed', (e) => this.onVehicleDestroyed(e)),
      // wardrobe: the economy (L) persists the outfit; the UI (G) calls setOutfit directly as well
      ev.on('economy:outfit', (e) => { if (e?.outfit) this.setOutfit(e.outfit); }),
    ];
  }

  /**
   * Dress the player. outfit: { slot: { id, color } } (wardrobe.js; UI slot aliases and the economy's
   * { slot: itemId, colors: { itemId: hex } } work too). Missing slots keep the current items; null takes one off.
   * Emits 'player:outfit' { outfit } (canonical form) when the look changed.
   */
  setOutfit(outfit) {
    const o = normalizeOutfit(outfit, this.outfit);
    const key = outfitKey(o);
    this.outfit = o;
    if (key === this._outfitKey && this.look) return o;
    this._outfitKey = key;
    this.setLook(outfitToLook(o));
    this.game.events?.emit?.('player:outfit', { outfit: o });
    return o;
  }

  // ---------------- public API ----------------
  get character() {
    const c = this._char;
    c.yaw = this.yaw;
    c.state = this.state;
    c.swimming = this.swim;
    c.grounded = this.motor.grounded;
    c.ragdoll = this.rd;
    c.velocity.x = this.motor.vel.x; c.velocity.y = this.motor.vel.y; c.velocity.z = this.motor.vel.z;
    return c;
  }

  get heading() {
    // compass bearing: 0 = north (-z), +pi/2 = east
    if (this.mode === 'free' || !this.controllable || this.state !== 'vehicle') {
      const d = this.game.camera.getWorldDirection(_v);
      return Math.atan2(d.x, -d.z);
    }
    const f = _v.set(0, 0, -1).applyQuaternion(this.controllable.object3d.quaternion);
    return Math.atan2(f.x, -f.z);
  }

  get onFoot() { return this.state !== 'vehicle'; }

  /**
   * Gameplay income. reason: 'pickup'|'drift'|'stunt'|'nearmiss'|'collectible'|'race'|'other'.
   * Routed through game.economy.earn when present, else game.net.claim (server wallet sets player.money), else local.
   */
  addMoney(n, pos, reason = 'other') {
    n = Math.round(n);
    if (!n) return;
    const g = this.game;
    const p = pos ? { x: pos.x, y: pos.y, z: pos.z } : { x: this.focus.x, y: this.focus.y, z: this.focus.z };
    if (g.economy?.earn) g.economy.earn(reason, n, p); // central economy (it delegates to the server online)
    else if (g.net?.claim) g.net.claim(reason, n, p);
    else this.money = Math.max(0, this.money + n);
    g.events.emit('money:pickup', { amount: n, position: p, reason });
  }

  // cheats / sandbox helpers (no-ops online: game.can gates them)
  refill() { if (this._can('godMode')) { this.health = 1; this.armor = 1; } }

  setGod(on) { this.god = !!on && this._can('godMode'); }

  _can(cap) { return this.game.can ? this.game.can(cap) : true; }

  setWaypoint(w) {
    this.waypoint = w;
    // route right away: the map shows it while the menu is open (paused offline, so updateRoute doesn't run)
    const f = this.focus, roads = this.game?.roads;
    const router = this.mode === 'foot' && this.game.parks ? this.game.parks : roads;
    this.route = w && f && router?.route ? router.route(f.x, f.z, w.x, w.z, f.y, w.y) : null;
    this.routeTimer = 1.5;
  }

  /** Change the player's appearance (look object from looks.js, or a numeric seed for lookFromSeed). */
  setLook(look) {
    this.look = typeof look === 'number' ? lookFromSeed(look) : look;
    this.dims = makeDims(this.look);
    this.lookData = lookData(this.look, this.dims);
    this.batch.setLook(this.slot, this.lookData);
    this._char.dims = this.dims;
    this._char.look = this.look;
  }

  /** Put the player into a vehicle immediately (bootstrap, garage, end of the enter animation). */
  enter(v) {
    const g = this.game;
    if (this._startOnFoot) {
      this._startOnFoot = false;
      v.occupied = false;
      this.lastVehicle = v;
      this._placeBeside(v);
      return;
    }
    if (this.mode === 'free') this.setFree(false);
    if (this.controllable && this.controllable !== v) this.controllable.occupied = false;
    const fromFoot = this.state !== 'vehicle';
    this._endRagdoll();
    this._dropNpc();
    this.seq = null;
    this.act = null;
    this.swim = false;
    this.controllable = v;
    this.lastVehicle = v;
    v.occupied = true;
    this.motor.setEnabled(false);
    this.state = 'vehicle';
    this.mode = 'vehicle';
    this.chase.enabled = true;
    if (fromFoot && this._camReady) this._captureCam(0.55);
    (v.camera || this.chase).snap(v);
    g.audio?.attachVehicle?.(v);
    g.events.emit('vehicle:enter', { vehicle: v });
  }

  /**
   * Leave the current vehicle. Slow: short exit animation; above ~20 km/h: bail out and roll.
   * @param {{instant?: boolean}} [o]
   */
  exit(o = {}) {
    const g = this.game;
    const v = this.controllable;
    if (!v || this.state !== 'vehicle') return false;
    if (this.mode === 'free') this.setFree(false);
    const lv = v.body.linvel();
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    const seat = seatFor(v, this.dims);
    v.occupied = false;
    this.controllable = null;
    this.lastVehicle = v;
    this.mode = 'foot';
    g.audio?.detachVehicle?.(v);
    g.events.emit('vehicle:exit', { vehicle: v });
    this._captureCam(0.5);
    const vb = vehicleBox(v, _box);
    this.orbit.snap(_v.set(vb.x, vb.y + 1, vb.z), vb.yaw);
    this.yaw = vb.yaw;
    const air = v.kind === 'heli' || v.kind === 'plane';
    const water = v.kind === 'boat' || (v.telemetry?.submerged ?? 0) > 0.3 || v.drowned;
    if (o.instant || speed > 20 / 3.6 || (air && v.telemetry?.airborne) || water) {
      const door = this._doorPoint(v, seat);
      this._exitTo(door, vb.yaw);
      if (seat.doors) this._door(v, seat, 1); // bailing out leaves the door open
      if (speed > 20 / 3.6 && !water && !(air && door.y - g.terrain.heightAt(door.x, door.z) > 2)) {
        // bail out: keep most of the vehicle's momentum, push away from the door side
        const sx = Math.cos(vb.yaw), sz = -Math.sin(vb.yaw);
        const side = seat.pos.x < 0 ? -1 : 1;
        const vel = { x: lv.x * 0.85 + sx * side * 2.5, y: Math.max(0, lv.y) + 1.5, z: lv.z * 0.85 + sz * side * 2.5 };
        if (speed > 75 / 3.6) {
          this._renderFoot(0.016);
          this.startRagdoll(vel, { x: 0, y: 2, z: 4 * side });
          this.damage(0.08 + speed * 0.006, 'fall');
        } else {
          this.hv.x = vel.x; this.hv.z = vel.z;
          this.yaw = Math.atan2(-vel.x, -vel.z);
          this.act = 'bail';
          this.actT = 0;
          this.damage(0.03 + speed * 0.003, 'fall');
        }
      } else {
        this.hv.x = lv.x * 0.6; this.hv.z = lv.z * 0.6;
        this.motor.vy = Math.min(0, lv.y);
      }
      return true;
    }
    this.state = 'exit';
    this.seq = { v, seat, phase: 'exit', t: 0, dur: 0.55, door: new THREE.Vector3(), yaw: vb.yaw };
    this._door(v, seat, 1);
    return true;
  }

  /** Walk to the nearest vehicle (or traffic car) and get in. */
  requestEnter() {
    const g = this.game;
    if (this.state !== 'foot' || this.act || this.wastedT > 0) return false;
    const f = this.motor.cur;
    const near = g.vehicles?.nearestEnterable({ x: f.x, y: f.y + 0.8, z: f.z }, 5);
    if (!near) return false;
    let v = near.vehicle, jack = null;
    if (near.type === 'traffic') {
      const a = near.agent;
      const lookSeed = (a.col?.handle ?? 1) * 7919 + ((g.time * 1000) | 0);
      const area = g.world3d?.areaAt?.(a.cur.x, a.cur.z);
      jack = makeLook(rng(lookSeed), { wealth: area?.wealth ?? 0.5, night: g.sky?.night ?? 0 });
      const spec = takeOverTraffic(g, a);
      if (!spec) return false;
      v = g.vehicles.spawn(spec.id, spec.pos, spec.yaw, { color: spec.color });
      if (!v) return false;
    }
    if (!v || v.destroyed) return false;
    const seat = seatFor(v, this.dims);
    this.state = 'enter';
    this.seq = { v, seat, phase: 'approach', t: 0, door: new THREE.Vector3(), yaw: this.yaw, jack: null };
    if (jack) {
      const dims = makeDims(jack);
      const slot = this.batch.alloc();
      if (slot >= 0) {
        const data = lookData(jack, dims);
        this.batch.setLook(slot, data);
        this.seq.jack = { look: jack, dims, data, slot, pose: PZ.newPose(), P: PZ.newPose(), W: new Float32Array(NJ * 12), M: new Float32Array(12), x: 0, y: 0, z: 0, yaw: 0 };
      }
    }
    return true;
  }

  teleport(x, z) {
    const g = this.game;
    if (this.mode === 'free') {
      const h = Math.max(g.terrain.heightAt(x, z), 0);
      g.camera.position.set(x, h + 160, z + 200);
      g.camera.lookAt(x, h, z);
      this.free.enable(g.camera);
      this.focus.set(x, h, z);
      return;
    }
    if (this.state === 'vehicle' && this.controllable) {
      const sp = roadSpawn(g, x, z);
      this.focus.set(sp.x, sp.y, sp.z);
      this.controllable.reset(new THREE.Vector3(sp.x, sp.y, sp.z), sp.yaw);
      g.streaming?.run(true);
      (this.controllable.camera || this.chase).snap(this.controllable);
      this.routeTimer = 0;
      return;
    }
    this._endRagdoll();
    this._dropNpc();
    this.seq = null;
    this.act = null;
    this.getup = null;
    const sp = sidewalkSpawn(g, x, z);
    this._placeOnFoot(sp.x, sp.z, sp.yaw, sp.y, false, true);
    this.routeTimer = 0;
  }

  setFree(on) {
    const g = this.game;
    if (on) {
      this.mode = 'free';
      this.free.enable(g.camera);
      this.chase.enabled = false;
      g.ui?.setMode?.(tr(g, 'mode.free', 'FREE CAMERA'));
    } else {
      this.free.disable();
      this.mode = this.state === 'vehicle' && this.controllable ? 'vehicle' : 'foot';
      this.chase.enabled = true;
      if (this.mode === 'vehicle') {
        const v = this.controllable;
        const t = v.body.translation();
        this.focus.set(t.x, t.y, t.z);
        g.streaming?.run(true);
        const gy = g.roads?.tunnelFloorAt?.(t.x, t.z) ?? Math.max(g.terrain.heightAt(t.x, t.z), 0); // tunnel floor, not the hill above
        if (t.y < gy - 3) v.reset(new THREE.Vector3(t.x, gy + 0.5, t.z), headingYaw(v.object3d));
        (v.camera || this.chase).snap(v);
      } else {
        this.focus.copy(this.pos);
        g.streaming?.run(true);
        this.orbit._snapped = false;
      }
      g.ui?.setMode?.('');
    }
  }

  /** Apply damage 0..1. kind: 'vehicle'|'fall'|'explosion'|'fire'|'drown'|'generic'. Armor absorbs all but falls/drowning. */
  damage(amount, kind = 'generic') {
    if ((this.god && this._can('godMode')) || this.wastedT > 0 || !(amount > 0)) return;
    if (kind !== 'fall' && kind !== 'drown' && this.armor > 0) {
      const a = Math.min(this.armor, amount);
      this.armor -= a;
      amount -= a;
    }
    this.health = Math.max(0, this.health - amount);
    this.sinceDamage = 0;
    this.game.events.emit('player:damage', { amount, kind, health: this.health, armor: this.armor });
    if (this.health <= 0) this.die(kind);
  }

  die(kind = 'generic') {
    if (this.wastedT > 0) return;
    const g = this.game;
    this.health = 0;
    this.wastedT = 4.5;
    this.diedIn = this.state === 'vehicle' ? this.controllable : null;
    this.deathKind = kind;
    if (this.state !== 'vehicle' && !this.rd) {
      this._renderFoot(0.016);
      this.startRagdoll({ x: this.motor.vel.x * 0.5, y: 0, z: this.motor.vel.z * 0.5 }, { x: 0.6, y: 0, z: 0.4 });
    }
    g.ui?.wasted?.(true);
    g.events.emit('wasted', { kind });
  }

  /** Physics ragdoll for the player (knocked by cars, explosions, high-speed bail-outs). */
  startRagdoll(vel, spin = { x: 0, y: 0, z: 0 }) {
    if (this.rd) return this.rd;
    const rd = this.ragdolls.spawn(this.W, this.dims, vel, { spin, priority: 3, owner: this });
    this.seq = null;
    this.act = null;
    this.swim = false;
    if (!rd) return null;
    this.rd = rd;
    this.state = 'ragdoll';
    this.motor.setEnabled(false);
    this._dropNpc();
    return rd;
  }

  // ---------------- events ----------------
  onExplosion(e) {
    if (!e?.position || this.wastedT > 0) return;
    const R = (e.radius ?? 8) * 1.5;
    const power = e.power ?? 1;
    let px, py, pz;
    if (this.state === 'vehicle') {
      return; // vehicle damage (E) handles occupants; destroyed vehicles kill via vehicle:destroyed
    } else if (this.rd) {
      const t = this.ragdolls.pelvis(this.rd); px = t.x; py = t.y; pz = t.z;
    } else { px = this.pos.x; py = this.pos.y + 1; pz = this.pos.z; }
    const dx = px - e.position.x, dy = py - e.position.y, dz = pz - e.position.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > R) return;
    const k = 1 - d / R;
    this.damage(power * k * k * 1.15, 'explosion');
    if (k > 0.3) {
      const kn = blastKnock(dx, dy, dz, R, power, _kn);
      if (this.rd) for (const b of this.rd.bodies) b.applyImpulse({ x: kn.x * b.mass() * 0.5, y: kn.y * b.mass() * 0.5, z: kn.z * b.mass() * 0.5 }, true);
      else if (this.state === 'foot' || this.state === 'getup') {
        this._renderFoot(0.016);
        this.startRagdoll({ x: kn.x, y: kn.y, z: kn.z }, { x: kn.sx, y: kn.sy, z: kn.sz });
      }
    }
  }

  onVehicleDestroyed(e) {
    const v = e?.vehicle;
    if (!v) return;
    if (v === this.controllable && this.state === 'vehicle') {
      const lv = v.body.linvel();
      this.exit({ instant: true });
      this.act = null;
      this._renderFoot(0.016);
      this.startRagdoll({ x: lv.x + (Math.random() - 0.5) * 6, y: 7, z: lv.z + (Math.random() - 0.5) * 6 }, { x: 3, y: 1, z: 2 });
      this.damage(1.2, 'explosion');
    }
    if (this.seq?.v === v) this._cancelSeq();
  }

  // ---------------- loop ----------------
  fixedUpdate(dt, game) {
    const v = this.controllable;
    if (v && this.mode === 'vehicle' && this.state === 'vehicle') {
      const tel = v.telemetry || {};
      const drive = this.wastedT <= 0;
      // online the menu does not pause the game: the vehicle coasts with neutral input while it is open
      const inp = !drive ? { throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false }
        : game.ui?.isOpen ? { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false }
          : this.driveInput.update(dt, tel.speedKmh ?? 0);
      inp.driver = drive;
      v.fixedUpdate(dt, inp);
    }
    if (this.mode === 'free') return;
    if (this.state === 'foot' || (this.state === 'enter' && this.seq?.phase === 'approach')) {
      this._stepFoot(dt);
      this._checkHits(dt);
    }
    if (this.state !== 'vehicle' && this.fires.size && this.wastedT <= 0) {
      const p = this.rd ? this.ragdolls.pelvis(this.rd) : this.motor.cur;
      for (const f of this.fires.values()) {
        if (Math.hypot(f.x - p.x, f.z - p.z) < 1.8 && Math.abs((f.y ?? p.y) - p.y) < 2.5) { this.damage(0.25 * dt, 'fire'); break; }
      }
    }
  }

  update(dt, game, alpha = 1) {
    const inp = game.input;
    // the economy may load the saved outfit after the player was created
    if (!this._ecoDressed && game.economy?.outfit) { this._ecoDressed = true; this.setOutfit(game.economy.outfit); }
    this.animT += dt;
    this.sinceDamage += dt;
    this.hitCool -= dt;
    if (!game.paused && !game.ui?.isOpen) this._keys(inp, game);
    // interpolated feet position
    const m = this.motor;
    if (this.state === 'foot' || (this.state === 'enter' && this.seq?.phase === 'approach')) {
      this.pos.set(m.prev.x + (m.cur.x - m.prev.x) * alpha, m.prev.y + (m.cur.y - m.prev.y) * alpha, m.prev.z + (m.cur.z - m.prev.z) * alpha);
    }
    // focus (streaming, UI, audio)
    const v = this.controllable;
    if (this.mode === 'free') this.focus.copy(game.camera.position);
    else if (this.state === 'vehicle' && v) { const t = v.body.translation(); this.focus.set(t.x, t.y, t.z); }
    else if (this.rd) { const t = this.ragdolls.pelvis(this.rd); this.focus.set(t.x, t.y, t.z); }
    else this.focus.copy(this.pos);
    // auto headlights
    if (v && !this.manualLights) {
      if (game.sky.night > 0.35 && !v.headlightsOn) v.setHeadlights?.(true);
      if (game.sky.night < 0.2 && v.headlightsOn) v.setHeadlights?.(false);
    }
    // health regenerates slowly up to 50%
    if (this.wastedT <= 0 && this.health > 0 && this.health < 0.5 && this.sinceDamage > 5) this.health = Math.min(0.5, this.health + dt * 0.012);
    this.landK = Math.max(0, this.landK - dt * 3.2);
    this._updateSeq(dt);
    this._updateDoor(dt);
    this._updateRagdoll(dt);
    this._helpPrompts(dt);
    this.updateWasted(dt, game);
    this.updateRoute(dt, game);
  }

  lateUpdate(dt, game) {
    const inp = game.input;
    if (this.mode === 'free') this.free.update(dt);
    else if (this.state === 'vehicle' && this.controllable) {
      const v = this.controllable;
      if (inp.mouse?.locked && (inp.mouse.dx || inp.mouse.dy) && !v.camera && this.chase._orbitYaw !== undefined) {
        const s = 0.0035 * (game.settings?.camSens ?? 1);
        this.chase._orbitYaw -= inp.mouse.dx * s;
        this.chase._orbitPitch = clamp(this.chase._orbitPitch + inp.mouse.dy * s * (game.settings?.invertY ? -1 : 1), -0.35, 0.9);
        this.chase._orbitIdle = 0;
      }
      (v.camera || this.chase).update(dt, v);
    } else {
      if (this.wastedT <= 0 && !game.paused && !game.ui?.isOpen) this.orbit.look(dt);
      const t = this._camTarget(_v2);
      const lv = this.seq?.v || this.lastVehicle;
      const ex = lv?.body && game.vehicles?.active.includes(lv) && Math.hypot(lv.object3d.position.x - this.pos.x, lv.object3d.position.z - this.pos.z) < 12 ? lv.body : undefined;
      this.orbit.update(dt, t, { moving: this.speed > 1 && this.state === 'foot', yaw: this.yaw, sprint: this.speed > 5.5, swim: this.swim, exclude: ex });
    }
    this._applyCamBlend(dt);
    this._camReady = true;
    this._animate(dt);
    if (this.ownBatch || !this.game.peds) this.batch.flush();
  }

  // ---------------- input ----------------
  _keys(inp, game) {
    const timeSkip = inp.pressed('KeyT') && this._can('time');
    if (inp.pressed('KeyV') && (this.mode === 'free' || this._can('freeCam'))) this.setFree(this.mode !== 'free');
    if (this.mode === 'free') { if (timeSkip) game.sky.setTime(game.sky.time + 1, { smooth: true }); return; }
    const v = this.state === 'vehicle' ? this.controllable : null;
    if (inp.pressed('KeyC')) { if (v) this.chase.nextMode(); else this.orbit.nextMode(); }
    if (inp.pressed('KeyH') && v) { v.setHeadlights?.(!v.headlightsOn); this.manualLights = true; }
    if (inp.pressed('KeyL') && v) v.siren = !v.siren;
    if (inp.pressed('KeyR') && v) {
      recoverVehicle(game, v);
    }
    if (timeSkip) game.sky.setTime(game.sky.time + 1, { smooth: true });
    if (this.wastedT > 0) return;
    if (inp.pressed('KeyF') || inp.gpPressedBtn?.(3)) {
      if (this.state === 'vehicle') this.exit();
      else if (this.state === 'foot') this.requestEnter();
      else if (this.state === 'enter' && this.seq?.phase === 'approach') this._cancelSeq();
    }
    if (this.state === 'foot') {
      if (inp.pressed('Space') || inp.gpPressedBtn?.(2)) this.jumpReq = true;
      if (inp.pressed('CapsLock')) this.walkToggle = !this.walkToggle;
      if (inp.pressed('Mouse0') && !inp.mouse?.locked) inp.lockPointer?.();
    }
  }

  _readMove() {
    if (this.game.ui?.isOpen) return { ix: 0, iy: 0, mag: 0, sprint: false, walk: false, dive: false };
    const inp = this.game.input;
    const k = (a, b) => (inp.held(a) || inp.held(b) ? 1 : 0);
    let iy = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown') - (inp.axis?.(1) || 0);
    let ix = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft') + (inp.axis?.(0) || 0);
    const l = Math.hypot(ix, iy);
    const mag = Math.min(1, l);
    if (l > 1) { ix /= l; iy /= l; }
    const pad = Math.abs(inp.axis?.(0) || 0) + Math.abs(inp.axis?.(1) || 0) > 0;
    const sprint = inp.held('ShiftLeft') || inp.held('ShiftRight') || inp.gpHeld?.(0);
    const walk = this.walkToggle || inp.held('AltLeft') || inp.held('AltRight') || (pad && mag < 0.55);
    const dive = inp.held('ControlLeft') || inp.held('ControlRight') || inp.gpHeld?.(1);
    return { ix, iy, mag, sprint, walk, dive };
  }

  // ---------------- on foot ----------------
  _stepFoot(dt) {
    const g = this.game, m = this.motor;
    if (!m.enabled) return;
    const f = m.cur;
    const bottom = g.terrain.heightAt(f.x, f.z);
    // water: swim when the water reaches the chest and the bottom is out of reach
    if (!this.swim && f.y < SEA - 1.05 && bottom < SEA - 1.25) {
      this.swim = true;
      this.act = null;
      if (m.vy < -4) g.events.emit('splash', { position: { x: f.x, y: SEA, z: f.z }, strength: Math.min(1, -m.vy / 15) });
      m.vy = Math.max(m.vy, -3);
    } else if (this.swim && (bottom > SEA - 1.15 || f.y > SEA - 0.7)) this.swim = false;

    let wx = 0, wz = 0, sp = 0, inputMag = 0;
    const seqWalk = this.state === 'enter' && this.seq?.phase === 'approach';
    const mv = this._readMove();
    if (seqWalk) {
      const s = this.seq;
      this._doorWorld(s.v, s.seat, s.door);
      const dx = s.door.x - f.x, dz = s.door.z - f.z, dist = Math.hypot(dx, dz);
      s.t += dt;
      if (dist < 0.35 || s.t > 3.5) { this._beginDoor(); return; }
      if (dist > 12) { this._cancelSeq(); return; }
      wx = dx / dist; wz = dz / dist; inputMag = 1;
      sp = Math.min(RUN, 0.8 + dist * 2.5);
    } else if (!this.act && this.wastedT <= 0 && this.mode === 'foot' && !this.game.paused) {
      const cy = this.orbit.yaw;
      const fx = -Math.sin(cy), fz = -Math.cos(cy), rx = Math.cos(cy), rz = -Math.sin(cy);
      wx = fx * mv.iy + rx * mv.ix; wz = fz * mv.iy + rz * mv.ix;
      const l = Math.hypot(wx, wz);
      if (l > 1e-3) { wx /= l; wz /= l; }
      inputMag = mv.mag;
      const swimSprint = this.swim && mv.sprint && inputMag > 0.1;
      if (this.swim || this.swimStamina < 1) this.swimStamina = Math.min(1, Math.max(0, (this.swimStamina ?? 1) + (swimSprint ? -dt / 14 : dt / 6)));
      const fast = SWIM_TIRED + (SWIM_FAST - SWIM_TIRED) * Math.min(1, (this.swimStamina ?? 1) * 3);
      sp = inputMag * (this.swim ? (mv.sprint ? fast : SWIM) : mv.sprint ? SPRINT : mv.walk ? WALK : RUN);
    }
    // facing
    if (inputMag > 0.08 && !this.act) {
      const ty = Math.atan2(-wx, -wz);
      this.yaw += wrapAngle(ty - this.yaw) * Math.min(1, dt * (m.grounded || this.swim ? 11 : 3));
    }
    // horizontal velocity
    let jump = 0;
    if (this.act === 'roll' || this.act === 'bail') {
      this.actT += dt;
      const dec = Math.exp(-dt * (this.act === 'bail' ? 2.2 : 3.5));
      this.hv.x *= dec; this.hv.z *= dec;
      if (this.actT > (this.act === 'bail' ? 1.0 : 0.75)) this.act = null;
    } else if (this.act === 'climb') {
      this._stepClimb(dt);
      return;
    } else {
      // move mostly along the facing direction so turns look natural
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const align = Math.max(0, fx * wx + fz * wz);
      const tx = (wx * 0.35 + fx * 0.65 * align) * sp, tz = (wz * 0.35 + fz * 0.65 * align) * sp;
      const acc = this.swim ? 5.5 : m.grounded ? (sp < Math.hypot(this.hv.x, this.hv.z) ? 9 : 7) : 1.2;
      const k = Math.min(1, dt * acc);
      this.hv.x += (tx - this.hv.x) * k;
      this.hv.z += (tz - this.hv.z) * k;
      if (this.jumpReq) {
        this.jumpReq = false;
        if (m.grounded && !this.swim) {
          if (!this._tryClimb()) jump = JUMP_V;
          else return;
        } else if (this.swim && this._tryClimb(2.8)) return; // pull up onto a pier, quay or boat deck
      }
      // swimming into a quay wall or pier edge with the stick held: climb out by itself
      if (this.swim && inputMag > 0.5 && m.blocked > 0.6) {
        this.swimPush = (this.swimPush || 0) + dt;
        if (this.swimPush > 0.35) { this.swimPush = 0; if (this._tryClimb(2.8)) return; }
      } else this.swimPush = 0;
    }
    // swimming height / diving
    let swimY = null;
    if (this.swim) {
      this.diving = mv.dive && this.mode === 'foot';
      swimY = this.diving ? Math.max(bottom + 0.6, f.y - 1.4) : SEA - 1.32 + Math.sin(this.animT * 1.7) * 0.04;
    } else this.diving = false;
    m.step(dt, this.hv.x, this.hv.z, { jump, swimY });
    // breath
    const headY = m.cur.y + this.dims.h * 0.93;
    if (headY < SEA - 0.05) {
      this.breath = Math.max(0, this.breath - dt / 14);
      if (this.breath <= 0) this.damage(0.1 * dt, 'drown');
    } else this.breath = Math.min(1, this.breath + dt / 3);
    // landing
    if (m.landSpeed > 0) {
      const ls = m.landSpeed;
      const hs = Math.hypot(this.hv.x, this.hv.z);
      g.events.emit('footstep', { position: { x: m.cur.x, y: m.cur.y, z: m.cur.z }, surface: surfaceAt(g.terrain, m.cur.x, m.cur.z), run: true, land: ls });
      if (ls > 10.5) this.damage((ls - 10.5) / 10.5, 'fall');
      if (this.health > 0) {
        if (ls > 8 && hs > 2.2) { this.act = 'roll'; this.actT = 0; } else if (ls > 3) this.landK = Math.min(1, ls / 9);
      }
    }
    // remember a safe spot on land
    this.safeT -= dt;
    if (this.safeT <= 0 && m.grounded && !this.swim && g.terrain.heightAt(m.cur.x, m.cur.z) > 0.2) {
      this.safeT = 1;
      this.lastSafe = { x: m.cur.x, z: m.cur.z };
    }
  }

  // ledge vault: obstacle 0.5..1.7 m high right in front
  _tryClimb(maxH = 1.75) {
    const g = this.game, f = this.motor.cur;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const R = g.RAPIER;
    const ray = this._climbRay || (this._climbRay = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
    const mask = groups(0xffff, GROUPS.STATIC | GROUPS.GROUND | GROUPS.PROP | GROUPS.VEHICLE);
    ray.origin = { x: f.x, y: f.y + 0.45, z: f.z };
    ray.dir = { x: fx, y: 0, z: fz };
    const wall = g.world.castRay(ray, 0.9, true, undefined, mask, this.motor.collider);
    if (!wall) return false;
    const reach = wall.timeOfImpact + 0.35;
    const px = f.x + fx * reach, pz = f.z + fz * reach;
    const reachUp = maxH + 0.25;
    ray.origin = { x: px, y: f.y + reachUp, z: pz };
    ray.dir = { x: 0, y: -1, z: 0 };
    const top = g.world.castRay(ray, reachUp, true, undefined, mask, this.motor.collider);
    if (!top) return false;
    const ty = f.y + reachUp - top.timeOfImpact;
    const hgt = ty - f.y;
    if (hgt < 0.45 || hgt > maxH) return false;
    // room to stand on top?
    const shape = new R.Capsule(this.motor.hh, this.motor.r * 0.9);
    const hit = g.world.intersectionWithShape({ x: px, y: ty + this.motor.lift + 0.05, z: pz }, { x: 0, y: 0, z: 0, w: 1 }, shape, undefined, mask, this.motor.collider);
    if (hit) return false;
    this.act = 'climb';
    this.actT = 0;
    this.climb = { x0: f.x, y0: f.y, z0: f.z, x1: px, y1: ty + 0.02, z1: pz, dur: 0.45 + hgt * 0.3 };
    this.hv.x = this.hv.z = 0;
    return true;
  }

  _stepClimb(dt) {
    const c = this.climb, m = this.motor;
    this.actT += dt;
    const u = Math.min(1, this.actT / c.dur);
    const up = smooth(u / 0.65), fw = smooth((u - 0.45) / 0.55);
    const x = c.x0 + (c.x1 - c.x0) * fw, z = c.z0 + (c.z1 - c.z0) * fw, y = c.y0 + (c.y1 - c.y0) * up;
    m.prev.x = m.cur.x; m.prev.y = m.cur.y; m.prev.z = m.cur.z;
    m.cur.x = x; m.cur.y = y; m.cur.z = z;
    m.pos.x = x; m.pos.y = y + m.lift + 0.02; m.pos.z = z;
    m.body.setNextKinematicTranslation(m.pos);
    m.vy = 0;
    if (u >= 1) { this.act = null; m.grounded = true; }
  }

  // vehicles and traffic running into the player
  _checkHits() {
    const g = this.game;
    if (this.hitCool > 0 || this.wastedT > 0 || this.act === 'climb') return;
    const f = this.motor.cur;
    const test = (b) => {
      const dx = b.x - f.x, dz = b.z - f.z;
      if (dx * dx + dz * dz > 81 || b.speed < 2.5) return false;
      if (Math.abs(b.y - (f.y + 0.9)) > 2.5) return false;
      boxLocal(b, f.x, f.z, _loc);
      if (Math.abs(_loc.lx) > b.hw + 0.45 || Math.abs(_loc.lz) > b.hl + 0.45) return false;
      const rvx = b.vx - this.motor.vel.x, rvz = b.vz - this.motor.vel.z;
      const rel = Math.hypot(rvx, rvz);
      if (rel < 3 || rvx * (f.x - b.x) + rvz * (f.z - b.z) <= 0) return false;
      this._hitBy(b, rel);
      return true;
    };
    for (const v of g.vehicles?.active || []) {
      if (v.destroyed && !v.body) continue;
      if (test(vehicleBox(v, _box))) return;
    }
    for (const a of g.traffic?.agents || []) if (test(agentBox(a, _box))) return;
  }

  _hitBy(b, rel) {
    const g = this.game;
    this.hitCool = 1.2;
    const f = this.motor.cur;
    // same believable model as pedestrians: mostly along the car's motion, capped lift and spin
    boxLocal(b, f.x, f.z, _loc);
    const kn = vehicleKnock(b, this.motor.vel.x, this.motor.vel.z, _loc.lx / (b.hw + 0.3), _kn);
    g.events.emit('impact', { position: { x: f.x, y: f.y + 1, z: f.z }, strength: Math.min(1, rel / 25), kind: 'ped', material: 'body', source: b.ref });
    this._renderFoot(0.016);
    const mass = Math.min(92, Math.max(70, 80 * this.dims.g * (this.dims.h / 1.76)));
    pushVehicle(b, mass, kn.h);
    if (this.startRagdoll({ x: kn.x, y: kn.y, z: kn.z }, { x: kn.sx, y: kn.sy, z: kn.sz }) && kn.rel > 11) this.ragdolls.addRamp(b.ref?.body, hoodRamp(b.ref));
    this.damage(Math.max(0, (rel - 3) / 24), 'vehicle');
  }

  // ---------------- ragdoll -> get up ----------------
  _updateRagdoll(dt) {
    const g = this.game;
    if (this.state === 'ragdoll') {
      if (!this.rd || this.rd.released) { this.rd = null; this._standHere(); return; }
      if (this.wastedT > 0 || !this.rd.settled) return;
      const t = this.ragdolls.pelvis(this.rd);
      if (t.y < SEA - 0.4 && g.terrain.heightAt(t.x, t.z) < SEA - 1.3) {
        // landed in deep water: swim
        this._endRagdoll();
        this._placeOnFoot(t.x, t.z, this.yaw, SEA - 1.3, true);
        this.swim = true;
        return;
      }
      const gy = groundY(g, t.x, t.z, t.y + 0.5);
      const info = this.ragdolls.toPose(this.rd, this.pose, this.W, gy);
      this.ragdolls.release(this.rd);
      this.rd = null;
      this.state = 'getup';
      this.getup = { u: 0, faceUp: info.faceUp };
      this.yaw = info.yaw;
      this.pos.set(info.x, gy, info.z);
      this.motor.teleport(info.x, gy + 0.02, info.z);
    } else if (this.state === 'getup') {
      this.getup.u += dt / 1.35;
      if (this.getup.u >= 1) {
        this.getup = null;
        this._standHere();
      }
    }
  }

  _standHere() {
    this.state = 'foot';
    this.motor.setEnabled(true);
    this.motor.teleport(this.pos.x, this.pos.y + 0.02, this.pos.z);
    this.hv.x = this.hv.z = 0;
  }

  _endRagdoll() {
    if (this.rd) { this.ragdolls.release(this.rd); this.rd = null; }
    this.getup = null;
  }

  // ---------------- enter / exit sequences ----------------
  _doorWorld(v, seat, out) {
    v.object3d.updateMatrixWorld();
    out.copy(seat.exit).applyMatrix4(v.object3d.matrixWorld);
    return out;
  }

  _seatWorld(v, seat, out) {
    v.object3d.updateMatrixWorld();
    return out.copy(seat.pos).applyMatrix4(v.object3d.matrixWorld);
  }

  // a free standing point beside the vehicle (driver door, other side, then on top)
  _doorPoint(v, seat) {
    const g = this.game, R = g.RAPIER;
    const shape = new R.Capsule(this.motor.hh, this.motor.r);
    const mask = groups(0xffff, GROUPS.STATIC | GROUPS.VEHICLE | GROUPS.TRAFFIC | GROUPS.PROP);
    const cands = [seat.exit, new THREE.Vector3(-seat.exit.x, seat.exit.y, seat.exit.z), new THREE.Vector3(0, seat.exit.y, localBoxMinZ(v, seat) - 0.8)];
    v.object3d.updateMatrixWorld();
    let first = null;
    for (const c of cands) {
      const p = _v.copy(c).applyMatrix4(v.object3d.matrixWorld);
      const gy = Math.max(groundY(g, p.x, p.z, p.y + 1.5), v.kind === 'boat' ? -50 : -1e9);
      const y = this.swim || gy < SEA - 1.2 ? Math.max(gy, SEA - 1.3) : gy;
      const pt = new THREE.Vector3(p.x, y, p.z);
      if (!first) first = pt;
      const hit = g.world.intersectionWithShape({ x: pt.x, y: pt.y + this.motor.lift + 0.05, z: pt.z }, { x: 0, y: 0, z: 0, w: 1 }, shape, undefined, mask, this.motor.collider, v.body);
      if (!hit) return pt;
    }
    return first;
  }

  _exitTo(door, yaw) {
    this.state = 'foot';
    this.seq = null;
    this._placeOnFoot(door.x, door.z, yaw, door.y, true);
  }

  _beginDoor() {
    const s = this.seq;
    s.phase = s.seat.doors ? 'open' : 'sit';
    s.t = 0;
    s.door.set(this.motor.cur.x, this.motor.cur.y, this.motor.cur.z);
    const sw = this._seatWorld(s.v, s.seat, _v);
    s.yaw = Math.atan2(-(sw.x - s.door.x), -(sw.z - s.door.z));
    this.motor.setEnabled(false);
    this.hv.x = this.hv.z = 0;
    this.pos.copy(s.door);
  }

  _updateSeq(dt) {
    const s = this.seq;
    if (!s) return;
    const g = this.game;
    if (!g.vehicles?.active.includes(s.v) || s.v.destroyed) { this._cancelSeq(); return; }
    if (s.phase === 'approach') return;
    s.t += dt;
    if (s.phase === 'open' && s.t < dt * 1.5) this._door(s.v, s.seat, 1);
    if (s.phase === 'open' && s.t >= 0.3) { s.phase = s.jack ? 'pull' : 'sit'; s.t = 0; }
    else if (s.phase === 'pull' && s.t >= 0.45) { this._ejectNpc(); s.phase = 'sit'; s.t = 0; }
    else if (s.phase === 'sit' && s.t >= 0.55) { const v = s.v, seat = s.seat; this.enter(v); this._door(v, seat, 0, 0.15); }
    else if (s.phase === 'exit' && s.t >= s.dur) {
      const v = s.v, seat = s.seat;
      const door = this._doorPoint(v, seat);
      this._exitTo(door, s.yaw);
      this._door(v, seat, 0, 0.35);
    }
  }

  // driver door swing (CarModel parts with hinges); target 0 closed .. 1 open, optional delay before moving
  _door(v, seat, target, delay = 0) {
    const part = v?.model?.parts?.[seat.pos.x < 0 ? 'doorFL' : 'doorFR'];
    const h = part?.userData?.hinge;
    if (!h || !part.parent) return;
    if (!this.doorAnim || this.doorAnim.part !== part) this.doorAnim = { part, h, cur: part.rotation[h.axis] / (h.sign * h.max * 0.8) || 0 };
    this.doorAnim.target = target;
    this.doorAnim.delay = delay;
  }

  _updateDoor(dt) {
    const d = this.doorAnim;
    if (!d) return;
    if (d.delay > 0) { d.delay -= dt; return; }
    const step = dt * (d.target > d.cur ? 4.5 : 3.2);
    d.cur += Math.max(-step, Math.min(step, d.target - d.cur));
    if (!d.part.parent) { this.doorAnim = null; return; }
    d.part.rotation[d.h.axis] = d.h.sign * d.h.max * 0.8 * smooth(d.cur);
    if (d.cur === d.target && d.target === 0) this.doorAnim = null;
  }

  _cancelSeq() {
    const s = this.seq;
    if (!s) return;
    this._dropNpc();
    this.seq = null;
    if (this.state === 'enter' || this.state === 'exit') {
      this.state = 'foot';
      if (!this.motor.enabled) this._placeOnFoot(this.pos.x, this.pos.z, this.yaw, this.pos.y);
    }
  }

  _ejectNpc() {
    const j = this.seq?.jack;
    if (!j) return;
    const g = this.game;
    const fx = this.pos.x, fz = this.pos.z;
    g.peds?.adopt?.({ look: j.look, dims: j.dims, data: j.data, x: j.x, y: j.y, z: j.z, yaw: j.yaw, pose: j.pose, state: 'stumble', fleeFrom: { x: fx, z: fz } });
    g.events.emit('ped:carjacked', { position: { x: j.x, y: j.y, z: j.z }, vehicle: this.seq.v });
    this._dropNpc();
  }

  _dropNpc() {
    const j = this.seq?.jack;
    if (!j) return;
    this.batch.release(j.slot);
    this.seq.jack = null;
  }

  _placeBeside(v) {
    const seat = seatFor(v, this.dims);
    const door = this._doorPoint(v, seat);
    const vb = vehicleBox(v, _box);
    this._placeOnFoot(door.x, door.z, vb.yaw, door.y, true);
  }

  _placeOnFoot(x, z, yaw, y = null, exact = false, stream = false) {
    const g = this.game;
    this.focus.set(x, y ?? 0, z);
    if (stream) g.streaming?.run(true);
    // colliders around a far spawn may still be streaming in: the ray can miss the road/sidewalk deck and hit the
    // terrain below it, then the capsule ends up stuck inside the deck once it loads. Never go below the known surface.
    const hit = exact && y !== null ? y : groundY(g, x, z, (y ?? g.terrain.heightAt(x, z)) + 3);
    const gy = y !== null && !exact ? Math.max(hit, y) : hit;
    this.motor.setEnabled(true);
    this.motor.teleport(x, gy + 0.03, z);
    this.pos.set(x, gy, z);
    this.yaw = yaw;
    this.hv.x = this.hv.z = 0;
    this.state = 'foot';
    if (this.mode !== 'free') this.mode = 'foot';
    this.orbit.snap(_v.set(x, gy + this.dims.h * 0.9, z), yaw);
  }

  // ---------------- prompts ----------------
  _helpPrompts(dt) {
    const g = this.game;
    this.helpT -= dt;
    if (this.helpT > 0 || this.state !== 'foot' || this.mode !== 'foot') return;
    this.helpT = 0.5;
    const near = g.vehicles?.nearestEnterable({ x: this.pos.x, y: this.pos.y + 0.8, z: this.pos.z }, 4);
    const key = near ? (near.vehicle || near.agent) : null;
    if (key && key !== this._helpFor) {
      this._helpFor = key;
      const txt = near.type === 'traffic'
        ? tr(g, 'help.carjack', 'Press <b>F</b> to take this car')
        : tr(g, 'help.enter', 'Press <b>F</b> to get in');
      g.ui?.showHelp?.(txt, 2.5);
      this.helpT = 4;
    } else if (!key) this._helpFor = null;
    if (!this._shownFootHelp) {
      this._shownFootHelp = true;
      g.ui?.showHelp?.(tr(g, 'help.onFoot', '<b>WASD</b> move · <b>Shift</b> sprint · <b>Space</b> jump/climb · <b>F</b> enter vehicle · click to look around'), 6);
    }
  }

  // ---------------- camera ----------------
  _camTarget(out) {
    const h = this.dims.h;
    if (this.rd) {
      const t = this.ragdolls.pelvis(this.rd);
      return out.set(t.x, t.y + 0.7, t.z);
    }
    if (this.seq && this.seq.phase !== 'approach') {
      return out.set(this.W[9], this.W[10] + h * 0.38, this.W[11]);
    }
    const crouch = this.state === 'getup' ? 0.5 : 0;
    return out.set(this.pos.x, this.pos.y + h * (0.9 - crouch * 0.4) + (this.swim ? 0.2 : 0), this.pos.z);
  }

  _captureCam(dur) {
    const c = this.game.camera;
    this.camBlend = { pos: c.position.clone(), quat: c.quaternion.clone(), fov: c.fov, t: 0, dur };
  }

  _applyCamBlend(dt) {
    const b = this.camBlend;
    if (!b) return;
    b.t += dt;
    const k = smooth(b.t / b.dur);
    if (k >= 1 || this.mode === 'free') { this.camBlend = null; return; }
    const c = this.game.camera;
    c.position.lerpVectors(b.pos, c.position, k);
    c.quaternion.slerpQuaternions(b.quat, c.quaternion, k);
  }

  // ---------------- animation / rendering ----------------
  _animate(dt) {
    const d = this.dims, cur = this.pose, P = this.target;
    const st = this.state;
    if (this.rd && !this.rd.released) {
      this.ragdolls.writeJoints(this.rd, this.W);
    } else if (st === 'vehicle' && this.controllable) {
      const v = this.controllable;
      const seat = seatFor(v, d);
      const tel = v.telemetry || {};
      const steerIn = v.physics ? this.driveInput.state.steer : (tel.steer ?? this.game.input.axis?.(0) ?? 0);
      this.steer += (clamp(steerIn, -1, 1) - this.steer) * Math.min(1, dt * 8);
      this.pedal += dt * Math.min(12, Math.abs(tel.speedKmh ?? 0) / 3.6 / 0.45);
      PZ.poseSeat(P, seat.pose, this.steer, this.animT, d, this.pedal, seat.recline, seat.legDrop);
      PZ.blendPose(cur, P, 1 - Math.exp(-dt * 12));
      vehicleMatrix(v, _V);
      mulLocal(this.M, 0, _V, 0, seat.pos.x + cur[ROOT], seat.pos.y + cur[ROOT + 1], seat.pos.z + cur[ROOT + 2], cur[ROOT + 3], cur[ROOT + 4], cur[ROOT + 5]);
      fk(this.W, this.M, cur, d);
    } else if (this.seq && this.seq.phase !== 'approach') {
      this._animSeq(dt);
    } else if (st === 'getup' && this.getup) {
      PZ.poseGetUp(P, this.getup.u, this.getup.faceUp, d);
      PZ.blendPose(cur, P, 1 - Math.exp(-dt * 9));
      pelvisMatrix(this.M, this.pos.x, this.pos.y, this.pos.z, this.yaw, cur, d);
      fk(this.W, this.M, cur, d);
    } else {
      this._renderFoot(dt);
    }
    // hide the body when a wall pushed the camera into the head
    const close = this.state !== 'vehicle' && this.mode !== 'free' && (this.orbit.len ?? 3) < 0.75;
    if (!close) this.batch.writeFigure(this.slot, this.W, d);
    const j = this.seq?.jack;
    if (j) {
      this._animNpc(dt, j);
      this.batch.writeFigure(j.slot, j.W, j.dims);
    }
  }

  // on-foot pose + FK (also used to refresh W right before spawning a ragdoll)
  _renderFoot(dt) {
    const d = this.dims, cur = this.pose, P = this.target, m = this.motor;
    const sp = Math.hypot(m.vel.x, m.vel.z);
    this.speed += (sp - this.speed) * Math.min(1, dt * 10);
    let k = 1 - Math.exp(-dt * 14);
    if (this.swim) {
      this.phase += dt * (1.3 + this.speed * 1.9); // faster strokes when sprinting
      PZ.poseSwim(P, this.phase, this.speed, this.animT, d, this.diving ? 1 : 0);
      k = 1 - Math.exp(-dt * 6);
    } else if (this.act === 'roll' || this.act === 'bail') {
      PZ.poseRoll(P, Math.min(1, this.actT / (this.act === 'bail' ? 1.0 : 0.75)), d);
      cur[ROOT + 3] = P[ROOT + 3];
      k = 1 - Math.exp(-dt * 20);
    } else if (this.act === 'climb') {
      PZ.poseClimb(P, Math.min(1, this.actT / this.climb.dur), d);
      k = 1 - Math.exp(-dt * 18);
    } else if (!m.grounded && m.airTime > 0.12) {
      PZ.poseAir(P, this.animT, m.vy, d);
      k = 1 - Math.exp(-dt * 7);
    } else if (this.speed < 0.25) {
      PZ.poseIdle(P, this.animT, 0, d);
    } else {
      const prev = Math.floor(this.phase / Math.PI);
      this.phase += (dt * Math.PI * this.speed) / PZ.stepLength(this.speed, d);
      PZ.poseGait(P, this.phase, this.speed, d);
      if (Math.floor(this.phase / Math.PI) !== prev && dt > 0.001) {
        const g = this.game;
        g.events.emit('footstep', { position: { x: this.pos.x, y: this.pos.y, z: this.pos.z }, surface: surfaceAt(g.terrain, this.pos.x, this.pos.z), run: this.speed > 3 });
      }
    }
    if (this.landK > 0 && !this.swim && !this.act) PZ.landOverlay(P, this.landK, d);
    if (this.state === 'enter' && this.seq?.phase === 'approach' && !this.act) { /* plain gait */ }
    PZ.blendPose(cur, P, k);
    pelvisMatrix(this.M, this.pos.x, this.pos.y, this.pos.z, this.yaw, cur, d);
    fk(this.W, this.M, cur, d);
  }

  _animSeq(dt) {
    const s = this.seq, d = this.dims, cur = this.pose, P = this.target, v = s.v, seat = s.seat;
    PZ.poseIdle(P, this.animT, 0, d);
    let u;
    if (s.phase === 'exit') {
      u = 1 - smooth(s.t / s.dur);
      this._doorWorld(v, seat, s.door);
      s.yaw = vehicleBox(v, _box).yaw;
    } else if (s.phase === 'sit') u = smooth(s.t / 0.55);
    else { u = 0; PZ.poseReach(P, smooth(s.t / 0.3)); }
    if (u > 0) {
      PZ.poseSeat(this._seatP, seat.pose, 0, this.animT, d, 0, seat.recline, seat.legDrop);
      PZ.lerpPose(P, P, this._seatP, u);
    }
    PZ.blendPose(cur, P, 1 - Math.exp(-dt * 16));
    pelvisMatrix(_Ma, s.door.x, s.door.y, s.door.z, s.yaw, cur, d);
    vehicleMatrix(v, _V);
    mulLocal(_Mb, 0, _V, 0, seat.pos.x, seat.pos.y, seat.pos.z, 0, 0, 0);
    lerpMat(this.M, _Ma, _Mb, u);
    fk(this.W, this.M, cur, d);
    this.pos.set(this.M[9], s.door.y, this.M[11]);
  }

  // carjacked driver: seated, then dragged out to the side of the car
  _animNpc(dt, j) {
    const s = this.seq, v = s.v, seat = s.seat, d = j.dims;
    PZ.poseSeat(j.P, seat.pose, 0, this.animT, d, 0, seat.recline, seat.legDrop);
    vehicleMatrix(v, _V);
    mulLocal(_Mb, 0, _V, 0, seat.pos.x, seat.pos.y, seat.pos.z, 0, 0, 0);
    let u = 0;
    if (s.phase === 'pull') {
      u = smooth(s.t / 0.45);
      const out = _v.copy(seat.exit).add(_v2.set(seat.exit.x < 0 ? -0.9 : 0.9, 0, -0.5)).applyMatrix4(v.object3d.matrixWorld);
      j.x = out.x; j.z = out.z;
      j.y = groundY(this.game, out.x, out.z, out.y + 1.5);
      j.yaw = s.yaw + Math.PI * 0.75;
      const st = PZ.newPose();
      PZ.poseGait(st, this.animT * 6, 1.5, d, { stumble: 1, time: this.animT });
      PZ.lerpPose(j.P, j.P, st, u);
    }
    PZ.blendPose(j.pose, j.P, 1 - Math.exp(-dt * 14));
    if (u > 0) {
      pelvisMatrix(_Ma, j.x, j.y, j.z, j.yaw, j.pose, d);
      lerpMat(j.M, _Mb, _Ma, u);
    } else j.M.set(_Mb);
    fk(j.W, j.M, j.pose, d);
  }

  // ---------------- wasted / respawn ----------------
  updateWasted(dt, game) {
    const v = this.state === 'vehicle' ? this.controllable : null;
    if (v && this.wastedT <= 0) {
      const p = v.body.translation();
      const tel = v.telemetry || {};
      if (p.y > 0.3 && game.terrain.heightAt(p.x, p.z) > 0.2 && (tel.speedKmh ?? 0) < 200) this.lastSafe = { x: p.x, z: p.z };
      // sinking car: climb out and swim (boats and aircraft handle water themselves)
      if ((v.drowned || (tel.submerged ?? 0) > 0.75) && v.kind !== 'boat' && v.kind !== 'plane' && v.kind !== 'heli') this.exit({ instant: true });
      else if (p.y < -30) this.die('fall');
    }
    if (this.state !== 'vehicle' && this.wastedT <= 0) {
      const f = this.rd ? this.ragdolls.pelvis(this.rd) : this.motor.cur;
      if (f.y < -60) this.die('fall');
    }
    if (this.wastedT <= 0 && this.health <= 0) this.die('generic');
    if (this.wastedT > 0) {
      game.timeScale = 0.3;
      this.wastedT -= dt;
      const gr = game.render?.grade?.uniforms;
      if (gr) {
        gr.uWasted.value = Math.min(1, gr.uWasted.value + dt * 1.5);
        gr.uFade.value = this.wastedT < 0.8 ? 1 - this.wastedT / 0.8 : 0;
      }
      if (this.wastedT <= 0) this._respawn();
    }
  }

  _respawn() {
    const g = this.game;
    const gr = g.render?.grade?.uniforms;
    const v = this.diedIn;
    if (v && this.state === 'vehicle' && this.controllable === v && !v.destroyed) {
      // as before: back on the road at the last safe point, vehicle repaired
      const s = this.lastSafe || this.spawnPoint;
      const sp = roadSpawn(g, s.x, s.z);
      v.reset(new THREE.Vector3(sp.x, sp.y, sp.z), sp.yaw);
      v.drowned = false;
      v.damage?.repair?.();
      this.focus.set(sp.x, sp.y, sp.z);
      g.streaming?.run(true);
      (v.camera || this.chase).snap(v);
    } else {
      // hospital, on foot
      const at = this.rd ? this.ragdolls.pelvis(this.rd) : this.focus;
      const slot = g.spawns?.pickSpawn?.('hospital', { x: at.x, z: at.z });
      const h = slot ? { x: slot.x, z: slot.z, name: slot.name ?? nearestHospital(g, slot.x, slot.z)?.name } : nearestHospital(g, at.x, at.z);
      if (this.state === 'vehicle') this.exit({ instant: true });
      this._endRagdoll();
      this._dropNpc();
      this.seq = null;
      this.act = null;
      this.swim = false;
      const sp = sidewalkSpawn(g, h.x, h.z);
      this._placeOnFoot(sp.x, sp.z, sp.yaw, sp.y, false, true);
      this.pose.fill(0);
      // hospital bill: central economy (5% of cash, $50..$5k), else server wallet online, else local purse
      if (g.economy?.charge) g.economy.charge('hospital');
      else if (g.online ?? g.mode === 'online') g.net?.charge?.('hospital', HOSPITAL_FEE);
      else if (this.money > 0) this.money = Math.max(0, this.money - Math.min(5000, Math.max(50, Math.round(this.money * 0.05))));
      g.ui?.toast?.(tr(g, 'respawn.hospital', 'HOSPITAL'), (h.name || '').toUpperCase(), 3);
    }
    this.health = 1;
    this.breath = 1;
    this.diedIn = null;
    g.timeScale = 1;
    g.ui?.wasted?.(false);
    if (gr) { gr.uWasted.value = 0; gr.uFade.value = 0; }
    g.events.emit('respawn', {});
  }

  updateRoute(dt, game) {
    if (!this.waypoint) return;
    this.routeTimer -= dt;
    const wp = this.waypoint, f = this.focus;
    if (Math.hypot(f.x - wp.x, f.z - wp.z) < (this.mode === 'foot' ? 8 : 40)) {
      game.ui?.toast?.(tr(game, 'gps.arrived', 'ARRIVED'), game.world3d.areaAt(wp.x, wp.z).name.toUpperCase(), 3);
      this.setWaypoint(null);
      game.events.emit('waypoint:reached', {});
    } else if (this.routeTimer <= 0) {
      const router = this.mode === 'foot' && game.parks ? game.parks : game.roads;
      this.route = router.route(f.x, f.z, wp.x, wp.z, f.y, wp.y);
      this.routeTimer = 1.5;
    }
  }

  dispose() {
    for (const off of this._off) off();
    this._endRagdoll();
    this.motor.dispose();
    if (this.ownBatch) this.batch.dispose(); else this.batch.release(this.slot);
    this.chase.dispose?.();
    this.driveInput.dispose?.();
  }
}

function localBoxMinZ(v, seat) {
  return v.spec?.size ? -v.spec.size.length / 2 : seat.pos.z - 2;
}
