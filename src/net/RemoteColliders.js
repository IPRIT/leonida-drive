// Colliders for the remote vehicles closest to the local player (≤ 12 within 60 m), so you can bump into other
// players. Bodies are pooled (created once, never destroyed).
//
// Mode 'follower' (default): a 1500 kg dynamic body without gravity that tracks the interpolated pose by setting its
// velocity every fixed step (capped at the remote car's own speed + 6 m/s). Collisions exchange momentum like two
// real cars. Mode 'kinematic': setNextKinematicTranslation/Rotation (infinite mass: hitting it is like hitting a wall,
// and a car driving through you launches you).
import * as THREE from 'three';
import { VCLASS } from './shared/constants.js';

const POOL = 12, RANGE = 60, MASS = 1500, PUSH = 6;
const PARK = { x: 0, y: -2000, z: 0 };
const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _o = new THREE.Vector3();

// Prediction is fine for rendering, but must not become an invisible physical
// wall. Keep normal bumping on a healthy connection; uncertain poses are visual.
export function collisionPoseSafe(e, net, now) {
  const c = net?.client;
  if (c && (!c.online || c.clock?.rtt > 500)) return false;
  if (Math.max(net?.store?.delay || 0, net?.store?.target || 0) > 450) return false;
  if (e.state === 'out' || !e.model || e.model === 255 || e.alpha < .9 || e.tp || !e.hasCurve) return false;
  if (!(e.sampleDelay <= 450)) return false;
  if (e.off && Math.hypot(e.off[0], e.off[3], e.off[6]) > 2) return false;
  if (Math.hypot(e.vx, e.vy, e.vz) > .5 && now - e.recvAt > 3000) return false;
  return true;
}

export class RemoteColliders {
  constructor(game, vehicles, { mode = 'follower' } = {}) {
    this.game = game;
    this.vehicles = vehicles;
    this.mode = mode;
    const { RAPIER, world } = game;
    const G = game.groups?.GROUPS;
    const pack = game.groups?.groups;
    // like AI traffic: hit by the player's vehicle and characters, ignored by the world
    const cg = G && pack ? pack(G.TRAFFIC, G.VEHICLE | G.CHARACTER) : undefined;
    this.slots = [];
    for (let i = 0; i < POOL; i++) {
      const desc = mode === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.dynamic().setGravityScale(0).enabledRotations(false, false, false).setLinearDamping(0).setCcdEnabled(true);
      const body = world.createRigidBody(desc.setTranslation(PARK.x, PARK.y - i * 10, PARK.z));
      const cd = RAPIER.ColliderDesc.cuboid(0.9, 0.7, 2.2).setFriction(0.4).setRestitution(0.1).setMass(MASS);
      if (cg !== undefined) cd.setCollisionGroups(cg);
      const col = world.createCollider(cd, body);
      body.setEnabled(false);
      col.userData = { remotePlayer: true };
      this.slots.push({ body, col, id: -1, model: -1, dims: null, shape: null, ent: null, parked: true });
    }
    this.pick = [];
    this.enabled = true;
  }

  /** Choose which entities get a collider (per frame, cheap). */
  assign(entities, now = performance.now()) {
    const f = this.game.player?.focus;
    const pick = this.pick;
    pick.length = 0;
    if (this.enabled && f) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!collisionPoseSafe(e, this.game.net, now)) continue;
        const vc = e.vclass;
        if (vc === VCLASS.PLANE && e.y - f.y > 8) continue; // flying overhead
        const d = Math.hypot(e.x - f.x, e.z - f.z);
        if (d > RANGE) continue;
        e._cd = d;
        pick.push(e);
      }
      if (pick.length > POOL) pick.sort((a, b) => a._cd - b._cd).length = POOL;
    }
    // keep existing assignments stable, park the rest
    for (const s of this.slots) {
      if (s.ent && pick.includes(s.ent) && s.ent.id === s.id && s.dims === this.vehicles.dims(s.ent.model)) continue;
      this._park(s);
    }
    for (const e of pick) {
      if (this.slots.some((s) => s.ent === e)) continue;
      const s = this.slots.find((x) => !x.ent);
      if (!s) break;
      if ((s.model !== e.model || !s.shape || s.dims !== this.vehicles.dims(e.model)) && !this._shape(s, e.model)) continue;
      // start at the entity, no sweep from the parking spot
      this._pose(e, 0, s);
      // Never materialise a returned/reseated proxy inside the local player.
      if (this._overlapsPlayer(s)) continue;
      s.ent = e; s.id = e.id;
      s.body.setTranslation(_pos, true);
      s.body.setRotation(_q, true);
      s.body.setLinvel(ZERO3, false);
      s.body.setEnabled(true);
      s.parked = false;
    }
  }

  _park(s) {
    s.ent = null; s.id = -1;
    if (s.parked) return;
    s.body.setEnabled(false);
    s.body.setLinvel(ZERO3, false);
    s.body.setTranslation(PARK, false);
    s.parked = true;
  }

  _overlapsPlayer(s) {
    const p = this.game.player;
    for (const body of [p?.controllable?.body, p?.motor?.body]) {
      if (!body?.isEnabled()) continue;
      for (let i = 0; i < body.numColliders(); i++) {
        if (body.collider(i).contactShape(s.shape, _pos, _q, .2)) return true;
      }
    }
    return false;
  }

  _shape(s, model) {
    const d = this.vehicles.dims(model);
    if (!d) return false; // wait for the worker's real dimensions, not a permanent generic box
    s.model = model; s.dims = d;
    s.halfY = Math.max(0.4, d.height * 0.42);
    s.cy = (d.originY || 0) + s.halfY + 0.15; // collider centre above the transmitted pose
    s.cz = d.center ? d.center.z : 0;
    const x = Math.max(.4, d.width * .47), z = Math.max(.8, d.length * .47);
    s.col.setHalfExtents({ x, y: s.halfY, z });
    s.shape = new this.game.RAPIER.Cuboid(x, s.halfY, z);
    return true;
  }

  _pose(e, ahead, s) {
    _q.setFromEuler(_e.set(e.pitch, e.yaw, e.roll, 'YXZ'));
    _o.set(0, s?.cy ?? 0.7, s?.cz ?? 0).applyQuaternion(_q);
    _pos.x = e.x + e.vx * ahead + _o.x; _pos.y = e.y + e.vy * ahead + _o.y; _pos.z = e.z + e.vz * ahead + _o.z;
  }

  /** Every fixed step: steer the bodies to where the remote cars will be at the end of this step. */
  fixedUpdate(dt, stepIndex) {
    for (const s of this.slots) {
      if (!s.ent) continue;
      const e = s.ent;
      if (!this.enabled || !collisionPoseSafe(e, this.game.net, performance.now()) || s.model !== e.model) { this._park(s); continue; }
      this._pose(e, dt * (stepIndex + 1), s); // the render pose is updated once per frame; lead it per sub-step
      const p = s.body.translation();
      if (Math.hypot(_pos.x - p.x, _pos.y - p.y, _pos.z - p.z) > 8) { this._park(s); continue; }
      if (this.mode === 'kinematic') {
        s.body.setNextKinematicTranslation(_pos);
        s.body.setNextKinematicRotation(_q);
        continue;
      }
      // velocity that reaches the target this step, but never pushes harder than the remote car really moves
      let vx = (_pos.x - p.x) / dt, vy = (_pos.y - p.y) / dt, vz = (_pos.z - p.z) / dt;
      const dx = vx - e.vx, dy = vy - e.vy, dz = vz - e.vz, ex = Math.hypot(dx, dy, dz);
      if (ex > PUSH) { const k = PUSH / ex; vx = e.vx + dx * k; vy = e.vy + dy * k; vz = e.vz + dz * k; }
      _vel.x = vx; _vel.y = vy; _vel.z = vz;
      s.body.setLinvel(_vel, true);
      s.body.setRotation(_q, true);
    }
  }

  setEnabled(v) { this.enabled = v; if (!v) for (const s of this.slots) this._park(s); }

  dispose() {
    const w = this.game.world;
    for (const s of this.slots) w.removeRigidBody(s.body);
    this.slots.length = 0;
  }
}
const _pos = { x: 0, y: 0, z: 0 }, _vel = { x: 0, y: 0, z: 0 }, ZERO3 = { x: 0, y: 0, z: 0 };
