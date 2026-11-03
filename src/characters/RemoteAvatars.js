// Remote players on foot (multiplayer, workstream J): seeded looks, procedural animation, instanced rendering.
// Visual only by default; optional kinematic capsules make them solid for the local player's controller.
import * as THREE from 'three';
import { NJ, ROOT, makeDims, fk, pelvisMatrix, mulLocal } from './rig.js';
import * as PZ from './poses.js';
import { lookFromSeed, lookData } from './looks.js';
import { outfitToLook, outfitKey } from './wardrobe.js';
import { HumanBatch } from './HumanBatch.js';
import { GROUPS, groups } from '../vehicle/groups.js';
import { wrapAngle } from './util.js';

const _frustum = new THREE.Frustum(), _m4 = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 1.3);
const _M = new Float32Array(12);

function hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

class Avatar {
  constructor(owner, id, slot, look, dims) {
    this.owner = owner;
    this.id = id;
    this.slot = slot;
    this.look = look;
    this.dims = dims;
    this.P = PZ.newPose();
    this.T = PZ.newPose();
    this.W = new Float32Array(NJ * 12);
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.yaw = 0;
    this.targetYaw = 0;
    this.speed = 0;
    this.netSpeed = null;
    this.vy = 0;
    this.state = 'idle';
    this.phase = Math.random() * 6;
    this.t = Math.random() * 10;
    this.fresh = true;
    this.visible = true;
    this.body = null;
  }

  /**
   * Network state: { x, y, z (feet), yaw, speed (m/s), state: 'idle'|'walk'|'run'|'jump'|'fall'|'drive'|'ragdoll'|'swim',
   * outfit?: wardrobe outfit ({ slot: { id, color } }, or decodeOutfit(codes)), look?: a looks.js look }
   * Seated in a vehicle (multiplayer riders): state 'seat' + seat: { M (vehicle matrix, 12 floats as in rig.js),
   * pos (hip in vehicle space), pose ('car'|'bike'|'bicycle'|...), recline, legDrop, steer, pedal } — the same pose
   * the local player uses (poses.poseSeat); x/y/z = the hip in the world (culling).
   */
  set(s) {
    if (s.seat !== undefined) this.seat = s.seat;
    if (s.outfit !== undefined && s.outfit !== this._outfitRef) this.owner._dress(this, s.outfit);
    if (s.look && s.look !== this.look) this.owner._restyle(this, s.look);
    if (s.x !== undefined) this.target.set(s.x, s.y ?? this.target.y, s.z);
    if (s.yaw !== undefined) this.targetYaw = s.yaw;
    if (s.speed !== undefined) this.netSpeed = s.speed;
    if (s.state) this.state = s.state;
    if (this.fresh) { this.position.copy(this.target); this.yaw = this.targetYaw; this.fresh = false; }
    return this;
  }

  tick(dt) {
    if (this.state === 'seat') { this.position.copy(this.target); this.speed = 0; this.vy = 0; this.t += dt; return; } // rides the vehicle pose
    const prevX = this.position.x, prevY = this.position.y, prevZ = this.position.z;
    if (this.position.distanceToSquared(this.target) > 64) this.position.copy(this.target);
    else this.position.lerp(this.target, 1 - Math.exp(-dt * 10));
    this.yaw += wrapAngle(this.targetYaw - this.yaw) * Math.min(1, dt * 10);
    if (dt > 0) {
      const v = Math.hypot(this.position.x - prevX, this.position.z - prevZ) / dt;
      this.speed += ((this.netSpeed ?? v) - this.speed) * Math.min(1, dt * 8);
      this.vy += ((this.position.y - prevY) / dt - this.vy) * Math.min(1, dt * 10);
    }
    this.t += dt;
  }

  pose(dt) {
    const d = this.dims, T = this.T;
    let k = 1 - Math.exp(-dt * 12);
    const st = this.seat;
    if (this.state === 'seat' && st) {
      PZ.poseSeat(T, st.pose, st.steer || 0, this.t, d, st.pedal || 0, st.recline, st.legDrop);
      PZ.blendPose(this.P, T, k);
      const P = this.P;
      mulLocal(_M, 0, st.M, 0, st.pos.x + P[ROOT], st.pos.y + P[ROOT + 1], st.pos.z + P[ROOT + 2], P[ROOT + 3], P[ROOT + 4], P[ROOT + 5]);
      fk(this.W, _M, P, d);
      return;
    }
    switch (this.state) {
      case 'jump': case 'fall': PZ.poseAir(T, this.t, this.state === 'jump' ? Math.max(1, this.vy) : Math.min(-3, this.vy), d); k = 1 - Math.exp(-dt * 7); break;
      case 'ragdoll': PZ.poseLie(T, false, this.t, d, this.slot); k = 1 - Math.exp(-dt * 6); break;
      case 'swim': this.phase += dt * (1.3 + this.speed * 1.6); PZ.poseSwim(T, this.phase, this.speed, this.t, d); break;
      default: {
        const sp = this.state === 'idle' ? Math.min(this.speed, 0.2) : Math.max(this.speed, this.state === 'run' ? 3.5 : 1.2);
        if (sp < 0.25) PZ.poseIdle(T, this.t, this.slot, d);
        else {
          this.phase += (dt * Math.PI * sp) / PZ.stepLength(sp, d);
          PZ.poseGait(T, this.phase, sp, d);
        }
      }
    }
    PZ.blendPose(this.P, T, k);
    const p = this.position;
    pelvisMatrix(_M, p.x, this.state === 'swim' ? p.y : p.y, p.z, this.yaw, this.P, d);
    fk(this.W, _M, this.P, d);
  }

  remove() { this.owner.remove(this.id); }
}

export class RemoteAvatars {
  /**
   * @param {object} game
   * @param {{max?: number, colliders?: boolean, lodNear?: number}} [opts]
   *   colliders: kinematic capsules so the local player can't walk through remote players (default off)
   */
  constructor(game, { max = 200, colliders = false, lodNear = 25 } = {}) {
    this.game = game;
    this.max = max;
    this.lodNear = lodNear; // full detail
    this.lodMid = Math.max(lodNear, 70); // boxy mid LOD, impostor beyond
    this.shadowDist = 35;
    this.batch = new HumanBatch(game.scene, max, { far: true });
    this.map = new Map();
    this.colliders = colliders;
    if (colliders) {
      const m = game.player?.motor;
      if (m) m.queryGroups = groups(GROUPS.CHARACTER, GROUPS.GROUND | GROUPS.STATIC | GROUPS.PROP | GROUPS.VEHICLE | GROUPS.TRAFFIC | GROUPS.CHARACTER);
    }
  }

  get count() { return this.map.size; }

  /**
   * Add (or get) an avatar. Appearance: outfit (wardrobe, what the player bought), else look, else a seed (defaults
   * to a hash of id, so every client derives the same look).
   */
  add(id, { seed, look, outfit } = {}) {
    if (this.map.has(id)) { const a = this.map.get(id); if (outfit) this._dress(a, outfit); return a; }
    const slot = this.batch.alloc();
    if (slot < 0) return null;
    const lk = outfit ? outfitToLook(outfit) : look || lookFromSeed(seed ?? hashId(id));
    const dims = makeDims(lk);
    this.batch.setLook(slot, lookData(lk, dims));
    const a = new Avatar(this, id, slot, lk, dims);
    if (this.colliders) {
      const { RAPIER, world } = this.game;
      a.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const hh = dims.h / 2 - 0.3;
      world.createCollider(RAPIER.ColliderDesc.capsule(hh, 0.3).setTranslation(0, hh + 0.3, 0)
        .setCollisionGroups(groups(GROUPS.CHARACTER, GROUPS.CHARACTER)), a.body);
    }
    if (outfit) { a._outfitRef = outfit; a._outfitKey = outfitKey(outfit); }
    this.map.set(id, a);
    return a;
  }

  // wardrobe outfit changed (cheap when it did not: the key is compared first)
  _dress(a, outfit) {
    a._outfitRef = outfit;
    if (!outfit) return;
    const key = outfitKey(outfit);
    if (key === a._outfitKey) return;
    a._outfitKey = key;
    this._restyle(a, outfitToLook(outfit));
  }

  _restyle(a, look) {
    a.look = look;
    a.dims = makeDims(look);
    this.batch.setLook(a.slot, lookData(look, a.dims));
  }

  get(id) { return this.map.get(id) || null; }

  remove(id) {
    const a = this.map.get(id);
    if (!a) return;
    this.map.delete(id);
    this.batch.release(a.slot);
    if (a.body) this.game.world.removeRigidBody(a.body);
  }

  clear() { for (const id of [...this.map.keys()]) this.remove(id); }

  /** Call once per frame (after network state was applied). */
  update(dt) {
    const cam = this.game.camera;
    _frustum.setFromProjectionMatrix(_m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const cp = cam.position;
    for (const a of this.map.values()) {
      a.tick(dt);
      const p = a.position;
      if (a.body) {
        const hidden = a.state === 'drive' || a.state === 'ragdoll' || a.state === 'seat';
        a.body.setNextKinematicTranslation({ x: p.x, y: hidden ? -1000 : p.y, z: p.z });
      }
      if (a.state === 'drive' || !a.visible) continue;
      _sph.center.set(p.x, p.y + 0.9, p.z);
      if (!_frustum.intersectsSphere(_sph)) continue;
      const dc = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
      if (dc < this.lodMid) {
        a.pose(dt);
        this.batch.writeFigure(a.slot, a.W, a.dims, dc < this.lodNear ? 0 : 1, dc < this.shadowDist);
      } else if (a.state !== 'seat') { // riders are only drawn up close (the vehicle covers them from afar)
        const moving = a.state === 'walk' || a.state === 'run' || a.speed > 0.5;
        if (moving) a.phase += (dt * Math.PI * a.speed) / 0.75;
        const lying = a.state === 'ragdoll';
        this.batch.writeFar(a.slot, p.x, p.y + (lying ? 0.12 : 0), p.z, a.yaw, a.dims.h, a.phase, moving ? Math.min(0.85, 0.3 + a.speed * 0.12) : 0, lying ? -Math.PI / 2 : 0);
      }
    }
    this.batch.flush();
  }

  dispose() {
    this.clear();
    this.batch.dispose();
  }
}

export function createRemoteAvatars(game, opts) { return new RemoteAvatars(game, opts); }
