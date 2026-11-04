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
      col.userData = { remotePlayer: true };
      this.slots.push({ body, col, id: -1, model: -1, ent: null, parked: true });
    }
    this.pick = [];
    this.enabled = true;
  }

  /** Choose which entities get a collider (per frame, cheap). */
  assign(entities) {
    const f = this.game.player?.focus;
    const pick = this.pick;
    pick.length = 0;
    if (this.enabled && f) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.model || e.model === 255 || e.alpha < 0.9 || e.tp || !e.hasCurve) continue;
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
      if (s.ent && pick.includes(s.ent) && s.ent.id === s.id) continue;
      s.ent = null; s.id = -1;
    }
    for (const e of pick) {
      if (this.slots.some((s) => s.ent === e)) continue;
      const s = this.slots.find((x) => !x.ent);
      if (!s) break;
      s.ent = e; s.id = e.id;
      if (s.model !== e.model) this._shape(s, e.model);
      // start at the entity, no sweep from the parking spot
      this._pose(e, 0);
      s.body.setTranslation(_pos, true);
      s.body.setRotation(_q, true);
      s.parked = false;
    }
    for (const s of this.slots) {
      if (!s.ent && !s.parked) { s.body.setTranslation(PARK, false); if (this.mode !== 'kinematic') s.body.setLinvel(ZERO3, false); s.parked = true; }
    }
  }

  _shape(s, model) {
    s.model = model;
    const d = this.vehicles.dims(model);
    if (!d) return;
    s.halfY = Math.max(0.4, d.height * 0.42);
    s.cy = (d.originY || 0) + s.halfY + 0.15; // collider centre above the transmitted pose
    s.cz = d.center ? d.center.z : 0;
    s.col.setHalfExtents({ x: Math.max(0.4, d.width * 0.47), y: s.halfY, z: Math.max(0.8, d.length * 0.47) });
  }

  _pose(e, ahead) {
    _q.setFromEuler(_e.set(e.pitch, e.yaw, e.roll, 'YXZ'));
    const s = this.slots.find((x) => x.ent === e);
    _o.set(0, s?.cy ?? 0.7, s?.cz ?? 0).applyQuaternion(_q);
    _pos.x = e.x + e.vx * ahead + _o.x; _pos.y = e.y + e.vy * ahead + _o.y; _pos.z = e.z + e.vz * ahead + _o.z;
  }

  /** Every fixed step: steer the bodies to where the remote cars will be at the end of this step. */
  fixedUpdate(dt, stepIndex) {
    for (const s of this.slots) {
      if (!s.ent) continue;
      const e = s.ent;
      if (s.model !== e.model) this._shape(s, e.model);
      this._pose(e, dt * (stepIndex + 1)); // the render pose is updated once per frame; lead it per sub-step
      if (this.mode === 'kinematic') {
        s.body.setNextKinematicTranslation(_pos);
        s.body.setNextKinematicRotation(_q);
        continue;
      }
      // velocity that reaches the target this step, but never pushes harder than the remote car really moves
      const p = s.body.translation();
      let vx = (_pos.x - p.x) / dt, vy = (_pos.y - p.y) / dt, vz = (_pos.z - p.z) / dt;
      const dx = vx - e.vx, dy = vy - e.vy, dz = vz - e.vz, ex = Math.hypot(dx, dy, dz);
      if (ex > PUSH) { const k = PUSH / ex; vx = e.vx + dx * k; vy = e.vy + dy * k; vz = e.vz + dz * k; }
      if (Math.hypot(_pos.x - p.x, _pos.z - p.z) > 8) { s.body.setTranslation(_pos, true); vx = e.vx; vy = e.vy; vz = e.vz; } // lost it: re-seat
      _vel.x = vx; _vel.y = vy; _vel.z = vz;
      s.body.setLinvel(_vel, true);
      s.body.setRotation(_q, true);
    }
  }

  setEnabled(v) { this.enabled = v; }

  dispose() {
    const w = this.game.world;
    for (const s of this.slots) w.removeRigidBody(s.body);
    this.slots.length = 0;
  }
}
const _pos = { x: 0, y: 0, z: 0 }, _vel = { x: 0, y: 0, z: 0 }, ZERO3 = { x: 0, y: 0, z: 0 };
