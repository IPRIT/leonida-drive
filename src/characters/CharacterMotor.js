// Kinematic capsule driven by Rapier's KinematicCharacterController: walking, autostep, slopes, snap-to-ground,
// gravity, jumping and swimming at sea level. Positions are feet positions (bottom of the capsule).
// The capsule only blocks against the world through KCC queries: vehicles/traffic are obstacles for the character,
// but the character is not a solid obstacle for them (collisions with cars are handled as hits by the controller).
// A vehicle that drives (slowly) into the capsule pushes it out: the step then queries only the static world, so the
// character slides along walls instead of being squeezed through them.
import { GROUPS, groups } from '../vehicle/groups.js';

const DEG = Math.PI / 180;
const SUPPORT_Y = Math.cos(52 * DEG);

export class CharacterMotor {
  /**
   * @param {object} RAPIER
   * @param {object} world RAPIER.World
   * @param {{radius?:number, height?:number, pos:{x,y,z}}} o pos = feet position
   */
  constructor(RAPIER, world, o) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.r = o.radius ?? 0.3;
    this.height = o.height ?? 1.78;
    this.hh = Math.max(0.1, this.height / 2 - this.r);
    this.lift = this.hh + this.r; // feet -> capsule centre
    const p = o.pos;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y + this.lift + 0.02, p.z));
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(this.hh, this.r)
        .setCollisionGroups(groups(GROUPS.CHARACTER, GROUPS.GROUND | GROUPS.STATIC | GROUPS.PROP))
        .setFriction(0),
      this.body,
    );
    const c = world.createCharacterController(0.03);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setMaxSlopeClimbAngle(52 * DEG);
    c.setMinSlopeSlideAngle(42 * DEG);
    c.enableAutostep(0.42, 0.18, true);
    c.enableSnapToGround(0.35);
    c.setSlideEnabled(true);
    c.setApplyImpulsesToDynamicBodies(true);
    c.setCharacterMass(80);
    this.ctrl = c;
    this.queryGroups = groups(GROUPS.CHARACTER, GROUPS.GROUND | GROUPS.STATIC | GROUPS.PROP | GROUPS.VEHICLE | GROUPS.TRAFFIC);
    this.staticGroups = groups(GROUPS.CHARACTER, GROUPS.GROUND | GROUPS.STATIC | GROUPS.PROP);
    this.vehicleGroups = groups(GROUPS.CHARACTER, GROUPS.VEHICLE | GROUPS.TRAFFIC);
    this.filterFlags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    this.push = { x: 0, z: 0, d: 0, cap: 0 }; // vehicle push-out of the last step (unit dir away from it, depth m)
    this.pushOut = true;
    this._ct = null;
    this._supportHit = null;
    this._rot = { x: 0, y: 0, z: 0, w: 1 };
    this._pushCb = (c) => this._pushFrom(c);
    this.pos = { x: p.x, y: p.y + this.lift + 0.02, z: p.z }; // capsule centre after the pending step
    this.prev = { x: p.x, y: p.y, z: p.z }; // feet, previous step
    this.cur = { x: p.x, y: p.y, z: p.z }; // feet, current step
    this.vel = { x: 0, y: 0, z: 0 }; // actual velocity of the last step
    this.vy = 0;
    this.grounded = false;
    this.airTime = 0;
    this.landSpeed = 0; // > 0 on the step we landed (impact speed m/s)
    this.blocked = 0; // fraction of the wanted horizontal motion that was blocked
    this.gravity = 9.81;
    this.enabled = true;
    this._d = { x: 0, y: 0, z: 0 };
  }

  get feet() { return this.cur; }

  setEnabled(on) {
    this.enabled = on;
    this.collider.setEnabled(on);
  }

  teleport(x, feetY, z) {
    const y = feetY + this.lift + 0.02;
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.prev.x = this.cur.x = x; this.prev.y = this.cur.y = feetY; this.prev.z = this.cur.z = z;
    this.vy = 0;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.grounded = false;
    this.airTime = 0;
  }

  /**
   * One fixed step.
   * @param {number} dt
   * @param {number} vx wanted horizontal velocity
   * @param {number} vz
   * @param {{jump?:number, swimY?:number|null}} [o] jump = take-off speed; swimY = target feet height while swimming
   */
  step(dt, vx, vz, o = {}) {
    this.landSpeed = 0;
    if (!this.enabled) return;
    const swim = o.swimY !== undefined && o.swimY !== null;
    if (swim) {
      this.vy = Math.max(-3, Math.min(2.5, (o.swimY - this.cur.y) * 2.5));
    } else if (o.jump && this.grounded) {
      this.vy = o.jump;
      this.grounded = false;
    } else if (this.grounded && this.vy <= 0) {
      this.vy = -1.5; // keep contact on slopes / steps down
    } else {
      this.vy = Math.max(this.vy - this.gravity * dt, -55);
    }
    // vehicles overlapping the capsule: drop the wanted motion into them and push out (static world still blocks)
    let qg = this.queryGroups;
    if (this.pushOut && this._vehiclePush()) {
      const P = this.push, into = vx * P.x + vz * P.z;
      if (into < 0) { vx -= into * P.x; vz -= into * P.z; }
      const pv = Math.min(P.d / dt, P.cap);
      vx += P.x * pv; vz += P.z * pv;
      qg = this.staticGroups;
    }
    const d = this._d;
    d.x = vx * dt; d.y = this.vy * dt; d.z = vz * dt;
    this.ctrl.computeColliderMovement(this.collider, d, this.filterFlags, qg);
    const mv = this.ctrl.computedMovement();
    const wasGrounded = this.grounded;
    const fallV = this.vy;
    this.grounded = !swim && this.ctrl.computedGrounded();
    // On trimesh kerbs KCC sometimes reports `grounded=false` while its actual
    // collision normal points up and gravity is blocked. Recognise that support
    // instead of accumulating a fictitious multi-second fall on a 14 cm step.
    if (!this.grounded && !swim && d.y < 0 && mv.y > d.y + 1e-5) {
      for (let i = 0; i < this.ctrl.numComputedCollisions(); i++) {
        const hit = this.ctrl.computedCollision(i, this._supportHit || undefined);
        if (hit) this._supportHit = hit;
        if (hit?.normal1.y >= SUPPORT_Y) { this.grounded = true; break; }
      }
    }
    this.pos.x += mv.x; this.pos.y += mv.y; this.pos.z += mv.z;
    this.body.setNextKinematicTranslation(this.pos);
    this.prev.x = this.cur.x; this.prev.y = this.cur.y; this.prev.z = this.cur.z;
    this.cur.x = this.pos.x; this.cur.y = this.pos.y - this.lift; this.cur.z = this.pos.z;
    this.vel.x = mv.x / dt; this.vel.y = mv.y / dt; this.vel.z = mv.z / dt;
    const want = Math.hypot(d.x, d.z);
    this.blocked = want > 1e-5 ? Math.max(0, 1 - Math.hypot(mv.x, mv.z) / want) : 0;
    if (this.grounded) {
      if (!wasGrounded && fallV < -1) this.landSpeed = -fallV;
      if (this.vy < 0) this.vy = 0;
      this.airTime = 0;
    } else {
      this.airTime += dt;
      // A steep slope/obstacle may clip the fall without becoming walkable.
      // Keep gravity's velocity consistent with the movement actually applied.
      if (d.y < 0 && mv.y > d.y + 1e-5) this.vy = Math.max(this.vy, Math.min(0, mv.y / dt));
      if (d.y > 0 && mv.y < d.y * 0.3) this.vy = Math.min(this.vy, 0); // head bump
    }
  }

  _vehiclePush() {
    const P = this.push;
    P.x = P.z = P.d = 0; P.cap = 3;
    try {
      this.world.intersectionsWithShape(this.pos, this._rot, this.collider.shape, this._pushCb, this.filterFlags, this.vehicleGroups, this.collider);
    } catch { return false; }
    const l = Math.hypot(P.x, P.z);
    if (l < 0.01) { P.x = P.z = 0; return false; }
    P.x /= l; P.z /= l; P.d = l;
    return true;
  }

  _pushFrom(c) {
    if (c.userData?.ramp) return true;
    const ct = this.collider.contactCollider(c, 0, this._ct || undefined);
    if (!ct) return true;
    this._ct = ct;
    const depth = -ct.distance;
    if (depth <= 0.005) return true;
    const nx = -ct.normal1.x, nz = -ct.normal1.z, h = Math.hypot(nx, nz);
    if (h < 0.3) return true; // vehicle above/below: standing on it or under a wing
    this.push.x += (nx / h) * depth;
    this.push.z += (nz / h) * depth;
    const b = c.parent();
    if (b) { const v = b.linvel(); this.push.cap = Math.max(this.push.cap, Math.hypot(v.x, v.z) + 2); }
    return true;
  }

  // collisions of the last step (for pushing / hit reactions)
  collisions(out = []) {
    out.length = 0;
    const n = this.ctrl.numComputedCollisions();
    for (let i = 0; i < n; i++) out.push(this.ctrl.computedCollision(i));
    return out;
  }

  dispose() {
    this.world.removeCharacterController(this.ctrl);
    this.world.removeRigidBody(this.body);
  }
}
