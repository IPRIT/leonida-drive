// Rapier ragdolls for knocked characters: 11 rigid bodies + impulse joints per figure, capped pool.
// Body frames coincide with rig joint frames so a ragdoll can be built from (and read back into) joint matrices.
import { J, NJ, PARENT, ROOT, mulLocal, quatToMat, matToQuat, relEuler } from './rig.js';
import { GROUPS, groups } from '../vehicle/groups.js';

const BODY_JOINTS = [J.PELVIS, J.SPINE, J.NECK, J.UARM_L, J.LARM_L, J.UARM_R, J.LARM_R, J.ULEG_L, J.LLEG_L, J.ULEG_R, J.LLEG_R];
// joints without a body: rendered rigidly attached to their parent body
const MERGED = [[J.CHEST, J.SPINE], [J.HEAD, J.NECK], [J.HAND_L, J.LARM_L], [J.HAND_R, J.LARM_R], [J.FOOT_L, J.LLEG_L], [J.FOOT_R, J.LLEG_R]];
const _q = { x: 0, y: 0, z: 0, w: 1 };
const _e = new Float32Array(3);
const _Y = new Float32Array(12);
const MAX_SPIN = 7, MAX_UP = 6.5, MAX_H = 30;

// physics tuning: no bounce, ground friction so bodies slide to a stop, air drag, capped spin/lift
export const RAGDOLL_TUNING = { linDamp: 0.3, angDampCore: 2.4, angDampLimb: 1.8, friction: 1.0, restitution: 0, caps: true, mass: [70, 92] };

export class Ragdolls {
  constructor(game, { max = 6, tuning = RAGDOLL_TUNING } = {}) {
    this.tuning = tuning;
    this.game = game;
    this.RAPIER = game.RAPIER;
    this.world = game.world;
    this.max = max;
    this.list = [];
    this.enabled = true;
    this.groups = groups(GROUPS.CHARACTER, GROUPS.GROUND | GROUPS.STATIC | GROUPS.PROP | GROUPS.VEHICLE | GROUPS.TRAFFIC);
    this.order = 15;
    this.ramps = [];
  }

  /**
   * Temporary sloped "hood ramp" on a vehicle body that just hit someone: bodies roll up over the hood and roof
   * instead of being bulldozed by box-shaped cabin colliders. Only ragdolls (CHARACTER) touch it; no mass.
   * @param {object} body vehicle RigidBody
   * @param {{hw,z0,y0,z1,y1}} r ramp in the body's local frame (z0/y0 front-low, z1/y1 rear-high)
   */
  addRamp(body, r, ttl = 1.6) {
    if (!body || !r) return;
    const R = this.RAPIER;
    const dz = r.z1 - r.z0, dy = r.y1 - r.y0, len = Math.hypot(dz, dy);
    const a = -Math.atan2(dy, dz);
    try {
      // thick slab (top face = the slope) so fast limbs can't tunnel through it
      const T = 0.35, ny = Math.cos(a), nz = -Math.sin(a); // slab normal (local up rotated by a about x)
      const c = this.world.createCollider(R.ColliderDesc.cuboid(r.hw, T, len / 2 + 0.1)
        .setTranslation(0, (r.y0 + r.y1) / 2 - ny * T, (r.z0 + r.z1) / 2 - nz * T)
        .setRotation({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) })
        .setDensity(0).setFriction(0.05).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0)
        .setCollisionGroups(groups(GROUPS.VEHICLE, GROUPS.CHARACTER)), body);
      c.userData = { ramp: true };
      this.ramps.push({ c, ttl });
    } catch { /* body already removed */ }
  }

  _updateRamps(dt) {
    for (let i = this.ramps.length - 1; i >= 0; i--) {
      const r = this.ramps[i];
      r.ttl -= dt;
      if (r.ttl > 0) continue;
      this.ramps.splice(i, 1);
      try { if (r.c.isValid?.() !== false) this.world.removeCollider(r.c, true); } catch { /* removed with its body */ }
    }
  }

  get count() { return this.list.length; }

  // can a ragdoll of this priority be created now (possibly by evicting a lower-priority one)?
  available(priority = 0) {
    if (!this.enabled && priority < 2) return false;
    if (this.list.length < this.max) return true;
    return this.list.some((r) => r.priority < priority || (r.priority === priority && r.settled));
  }

  /**
   * @param {Float32Array} W joint world matrices (NJ*12) of the current pose
   * @param {object} d dims (rig.makeDims)
   * @param {{x,y,z}} vel initial linear velocity
   * @param {{spin?:{x,y,z}, priority?:number, onEvict?:Function}} [o]
   */
  spawn(W, d, vel, o = {}) {
    const priority = o.priority ?? 0;
    if (!this.available(priority)) return null;
    if (this.list.length >= this.max) {
      let victim = null;
      for (const r of this.list) {
        if (r.priority > priority || (r.priority === priority && !r.settled)) continue;
        if (!victim || r.priority < victim.priority || r.age > victim.age) victim = r;
      }
      if (!victim) return null;
      victim.onEvict?.(victim);
      this.release(victim);
    }
    const R = this.RAPIER, world = this.world;
    const h = d.h;
    const rd = {};
    // 70..92 kg spread over the parts (part masses below sum to 76)
    const T = this.tuning;
    const massK = (T.mass ? Math.min(T.mass[1], Math.max(T.mass[0], 80 * d.g * (h / 1.76))) : 76 * d.g * (h / 1.76)) / 76;
    rd.mass = massK * 76;
    const spin = o.spin || { x: 0, y: 0, z: 0 };
    const px = W[9], py = W[10], pz = W[11];
    Object.assign(rd, { bodies: [], joints: [], d, age: 0, still: 0, settled: false, priority, onEvict: o.onEvict, owner: o.owner });
    const shapes = this._shapes(d);
    for (let i = 0; i < BODY_JOINTS.length; i++) {
      const j = BODY_JOINTS[i];
      const b = j * 12;
      matToQuat(W, b, _q);
      const x = W[b + 9], y = W[b + 10], z = W[b + 11];
      // v = v0 + w x r
      const rx = x - px, ry = y - py, rz = z - pz;
      const desc = R.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(_q)
        .setLinvel(vel.x + spin.y * rz - spin.z * ry, vel.y + spin.z * rx - spin.x * rz, vel.z + spin.x * ry - spin.y * rx)
        .setAngvel(spin)
        .setLinearDamping(T.linDamp)
        .setAngularDamping(i < 3 ? T.angDampCore : T.angDampLimb)
        .setCcdEnabled(i < 2);
      const body = world.createRigidBody(desc);
      for (const s of shapes[i]) {
        const cd = s.desc.setTranslation(s.t[0], s.t[1], s.t[2]).setMass(s.m * massK).setFriction(T.friction).setRestitution(T.restitution)
          .setRestitutionCombineRule(R.CoefficientCombineRule.Min)
          .setCollisionGroups(this.groups);
        world.createCollider(cd, body);
      }
      rd.bodies.push(body);
    }
    const B = (j) => rd.bodies[BODY_JOINTS.indexOf(j)];
    const sph = (j1, j2, a1, damp) => {
      const jd = R.JointData.spherical({ x: a1[0], y: a1[1], z: a1[2] }, { x: 0, y: 0, z: 0 });
      const jt = world.createImpulseJoint(jd, B(j1), B(j2), true);
      jt.setContactsEnabled(false);
      // spherical joints have no motors in rapier3d-compat 0.21: joint friction comes from angular damping
      if (jt.configureMotorVelocity) for (const ax of [R.JointAxis.AngX, R.JointAxis.AngY, R.JointAxis.AngZ]) jt.configureMotorVelocity(ax, 0, damp);
      rd.joints.push(jt);
    };
    const rev = (j1, j2, a1, lo, hi, damp) => {
      const jd = R.JointData.revolute({ x: a1[0], y: a1[1], z: a1[2] }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      jd.limitsEnabled = true;
      jd.limits = [lo, hi];
      const jt = world.createImpulseJoint(jd, B(j1), B(j2), true);
      jt.setContactsEnabled(false);
      jt.configureMotorVelocity(0, damp);
      rd.joints.push(jt);
    };
    const off = d.off;
    const o3 = (j) => [off[j * 3], off[j * 3 + 1], off[j * 3 + 2]];
    sph(J.PELVIS, J.SPINE, o3(J.SPINE), 3);
    sph(J.SPINE, J.NECK, [0, d.abdomenH + d.chestH, 0], 2);
    for (const [ua, la] of [[J.UARM_L, J.LARM_L], [J.UARM_R, J.LARM_R]]) {
      const a = o3(ua);
      sph(J.SPINE, ua, [a[0], d.abdomenH + a[1], a[2]], 0.6);
      rev(ua, la, o3(la), 0, 2.5, 0.4);
    }
    for (const [ul, ll] of [[J.ULEG_L, J.LLEG_L], [J.ULEG_R, J.LLEG_R]]) {
      sph(J.PELVIS, ul, o3(ul), 1.2);
      rev(ul, ll, o3(ll), -2.5, 0, 0.6);
    }
    this.list.push(rd);
    return rd;
  }

  _shapes(d) {
    const R = this.RAPIER;
    const cap = (len, r) => R.ColliderDesc.capsule(Math.max(0.01, len / 2 - r), r);
    const pelLen = d.pelvisH + 0.06 * d.h;
    const torsoLen = d.abdomenH + d.chestH;
    const fa = d.foreArm + d.handL * 0.75;
    return [
      [{ desc: R.ColliderDesc.cuboid(d.pelvisW * 0.85, pelLen / 2, d.pelvisD * 0.85), t: [0, d.pelvisH - pelLen / 2, 0], m: 11 }],
      [{ desc: R.ColliderDesc.cuboid(d.chestW * 0.82, torsoLen / 2, Math.max(d.chestD, d.waistD) * 0.85), t: [0, torsoLen / 2, 0], m: 24 }],
      [{ desc: R.ColliderDesc.ball(d.headW * 1.05), t: [0, d.neckH + d.headH * 0.5, 0], m: 5 }],
      [{ desc: cap(d.upperArm, d.armR), t: [0, -d.upperArm / 2, 0], m: 2.2 }],
      [{ desc: cap(fa, d.foreR), t: [0, -fa / 2, 0], m: 1.8 }],
      [{ desc: cap(d.upperArm, d.armR), t: [0, -d.upperArm / 2, 0], m: 2.2 }],
      [{ desc: cap(fa, d.foreR), t: [0, -fa / 2, 0], m: 1.8 }],
      [{ desc: cap(d.thigh, d.thighR * 0.9), t: [0, -d.thigh / 2, 0], m: 9 }],
      [{ desc: cap(d.shin, d.shinR), t: [0, -d.shin / 2, 0], m: 4 }, { desc: R.ColliderDesc.cuboid(d.footW, d.ankleH / 2, d.footL * 0.62), t: [0, -d.shin - d.ankleH / 2, -d.footL * 0.32], m: 1 }],
      [{ desc: cap(d.thigh, d.thighR * 0.9), t: [0, -d.thigh / 2, 0], m: 9 }],
      [{ desc: cap(d.shin, d.shinR), t: [0, -d.shin / 2, 0], m: 4 }, { desc: R.ColliderDesc.cuboid(d.footW, d.ankleH / 2, d.footL * 0.62), t: [0, -d.shin - d.ankleH / 2, -d.footL * 0.32], m: 1 }],
    ];
  }

  release(rd) {
    const i = this.list.indexOf(rd);
    if (i < 0) return;
    this.list.splice(i, 1);
    for (const jt of rd.joints) this.world.removeImpulseJoint(jt, false);
    for (const b of rd.bodies) this.world.removeRigidBody(b);
    rd.bodies.length = 0;
    rd.released = true;
  }

  // joint world matrices from the bodies
  writeJoints(rd, W) {
    const d = rd.d, off = d.off;
    for (let i = 0; i < BODY_JOINTS.length; i++) {
      const b = rd.bodies[i];
      const t = b.translation(), r = b.rotation();
      quatToMat(W, BODY_JOINTS[i] * 12, t.x, t.y, t.z, r.x, r.y, r.z, r.w);
    }
    for (const [j, p] of MERGED) mulLocal(W, j * 12, W, p * 12, off[j * 3], off[j * 3 + 1], off[j * 3 + 2], 0, 0, 0);
    return W;
  }

  pelvis(rd) { return rd.bodies[0].translation(); }

  speed(rd) {
    let m = 0;
    for (let i = 0; i < 2; i++) {
      const v = rd.bodies[i].linvel();
      m = Math.max(m, Math.hypot(v.x, v.y, v.z));
    }
    return m;
  }

  /**
   * Convert the current ragdoll configuration into a pose + root transform (for blending into a get-up).
   * @returns {{x:number, z:number, yaw:number, faceUp:boolean, pelvisY:number}}
   */
  toPose(rd, P, W, groundY) {
    this.writeJoints(rd, W);
    const d = rd.d;
    const upX = W[3], upY = W[4], upZ = W[5];
    const fX = -W[6], fY = -W[7], fZ = -W[8];
    const faceUp = fY > 0;
    let yaw;
    if (Math.abs(upY) > 0.7) yaw = Math.atan2(-fX, -fZ);
    else yaw = faceUp ? Math.atan2(upX, upZ) : Math.atan2(-upX, -upZ);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    _Y.set([cy, 0, -sy, 0, 1, 0, sy, 0, cy, 0, 0, 0]);
    relEuler(_Y, 0, W, 0, _e);
    P.fill(0);
    P[ROOT + 3] = _e[0]; P[ROOT + 4] = _e[1]; P[ROOT + 5] = _e[2];
    for (let j = 1; j < NJ; j++) {
      relEuler(W, PARENT[j] * 12, W, j * 12, _e);
      P[j * 3] = _e[0]; P[j * 3 + 1] = _e[1]; P[j * 3 + 2] = _e[2];
    }
    const pelvisY = W[10];
    P[ROOT + 1] = pelvisY - groundY - d.hipH;
    return { x: W[9], z: W[11], yaw, faceUp, pelvisY };
  }

  postStep() { this._clamp(); }

  fixedUpdate(dt) {
    this._clamp();
    this._water(dt);
  }

  _clamp() {
    for (const rd of this.tuning.caps ? this.list : []) {
      // keep tumbles believable: capped spin, no skyward launches (e.g. depenetration from a car body)
      for (const b of rd.bodies) {
        const w = b.angvel();
        const wl = Math.hypot(w.x, w.y, w.z);
        if (wl > MAX_SPIN) b.setAngvel({ x: (w.x * MAX_SPIN) / wl, y: (w.y * MAX_SPIN) / wl, z: (w.z * MAX_SPIN) / wl }, true);
        const v = b.linvel();
        const vh = Math.hypot(v.x, v.z);
        if (v.y > MAX_UP || vh > MAX_H) {
          const kh = vh > MAX_H ? MAX_H / vh : 1;
          b.setLinvel({ x: v.x * kh, y: Math.min(v.y, MAX_UP), z: v.z * kh }, true);
        }
      }
    }
  }

  // buoyancy + drag in water (sea level y = 0)
  _water(dt) {
    for (const rd of this.list) {
      for (let i = 0; i < 3; i++) {
        const b = rd.bodies[i];
        const t = b.translation();
        if (t.y > 0) continue;
        const depth = Math.min(1, -t.y / 0.4);
        b.applyImpulse({ x: 0, y: b.mass() * 9.81 * 1.6 * depth * dt, z: 0 }, true);
        const v = b.linvel();
        b.setLinvel({ x: v.x * 0.97, y: v.y * 0.95, z: v.z * 0.97 }, true);
      }
    }
  }

  update(dt) {
    this._updateRamps(dt);
    for (const rd of this.list) {
      rd.age += dt;
      const s = this.speed(rd);
      if (s < 0.35) rd.still += dt; else rd.still = 0;
      const y = rd.bodies[0].translation().y;
      rd.settled = rd.still > 0.6 || rd.age > 7 || (y < -0.3 && rd.age > 2.5);
      if (y < -60) rd.settled = true;
    }
  }

  clear() { while (this.list.length) { const r = this.list[0]; r.onEvict?.(r); this.release(r); } }
}

// one shared pool per game (registered as a module for buoyancy/settle tracking)
export function getRagdolls(game) {
  if (!game.ragdolls) {
    const max = game.quality?.ragdollsMax ?? (game.quality?.name === 'low' ? 3 : 6);
    game.ragdolls = new Ragdolls(game, { max });
    game.register?.(game.ragdolls, 15);
  }
  return game.ragdolls;
}
