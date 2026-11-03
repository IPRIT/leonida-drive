// Base rigid-body craft for aircraft and boats (DOM-free: runs in the browser and in Node tests).
// Owns the Rapier body + colliders, interpolation snapshot, impact detection, buoyancy and ground probing.
// Subclasses implement step(dt, ctl) and push gameplay events into this.events (drained by the THREE wrapper).
import { G, clamp, v3, set, copy, dot, rotate, cross, eulerQuat, bearing } from './math.js';
import { GROUPS, groups, WHEEL_RAY_MASK } from '../../vehicle/groups.js';

const MAX_LINVEL = 420;
const MAX_ANGVEL = 14;

export class Craft {
  /**
   * @param {object} o
   * @param {object} o.RAPIER initialized Rapier module
   * @param {object} o.world RAPIER.World
   * @param {object} o.spec physics spec (mass, com, inertia, colliders, ...)
   * @param {{x,y,z}} o.position body origin position (spec.rest places the origin above the ground)
   * @param {number} [o.yaw] heading, three.js rotation.y (0 = facing -Z)
   * @param {object} o.env { heightAt(x,z), waterHeight(x,z,t), time(), groundFriction?(x,z) }
   */
  constructor(o) {
    const { RAPIER, world, spec } = o;
    this.RAPIER = RAPIER;
    this.world = world;
    this.spec = spec;
    this.env = o.env;
    this.disposed = false;
    this.events = [];
    this.health = 1;
    this.destroyed = false;
    this.drowned = false;
    this.parked = false;
    this.holdT = 0;
    this.holdPos = v3();

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setCcdEnabled(true)
      .setLinearDamping(0)
      .setAngularDamping(spec.angularDamping ?? 0.05)
      .setCanSleep(true)
      .setAdditionalMassProperties(spec.mass, spec.com, spec.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = world.createRigidBody(desc);
    this.body.userData = { type: 'vehicle', craft: this };
    const cg = groups(GROUPS.VEHICLE, GROUPS.ALL);
    this.colliders = [];
    for (const c of spec.colliders) {
      let d;
      if (c.shape === 'capsule') d = RAPIER.ColliderDesc.capsule(c.hh, c.r);
      else if (c.shape === 'ball') d = RAPIER.ColliderDesc.ball(c.r);
      else if (c.shape === 'hull') d = RAPIER.ColliderDesc.convexHull(new Float32Array(c.points));
      else d = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz);
      if (!d) continue;
      d.setTranslation(c.x || 0, c.y || 0, c.z || 0);
      if (c.axis === 'x') d.setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 });
      else if (c.axis === 'z') d.setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
      else if (c.rot) d.setRotation(c.rot);
      d.setDensity(0).setFriction(c.friction ?? 0.5).setRestitution(c.restitution ?? 0.1).setCollisionGroups(cg);
      if (c.minFriction) d.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
      const col = world.createCollider(d, this.body);
      col.userData = { tag: c.tag || 'hull' };
      this.colliders.push(col);
    }

    this.ray = new RAPIER.Ray(v3(), v3(0, -1, 0));
    this.rayFlags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    this.wheelRayGroups = groups(GROUPS.ALL, WHEEL_RAY_MASK);
    this.solidRayGroups = groups(GROUPS.ALL, GROUPS.GROUND | GROUPS.STATIC);
    this.strikeRayGroups = groups(GROUPS.ALL, GROUPS.GROUND | GROUPS.STATIC | GROUPS.PROP | GROUPS.TRAFFIC | GROUPS.VEHICLE);

    this.prevPos = v3();
    this.prevRot = { x: 0, y: 0, z: 0, w: 1 };
    this.predVel = null;
    this.lastVel = v3();
    this.accel = v3();
    this.linImp = v3();
    this.waterT = 0; // seconds with the body below water (aircraft drowning)
    this.wetPrev = false;
    this.S = {
      pos: v3(), rot: { x: 0, y: 0, z: 0, w: 1 }, lin: v3(), ang: v3(), com: v3(),
      right: v3(), up: v3(), fwd: v3(), tmp: v3(), tmp2: v3(), p: v3(), vp: v3(), F: v3(),
    };
    this.telemetry = {
      kind: spec.kind, speedKmh: 0, forwardSpeed: 0, airspeed: 0, verticalSpeed: 0, altitude: 0, altitudeAsl: 0,
      heading: 0, pitch: 0, roll: 0, throttle: 0, rpm: 0, maxRpm: spec.maxRpm || 3000, idleRpm: 0, gear: 0,
      airborne: false, upsideDown: false, impactId: 0, impactStrength: 0, inWater: false, submerged: 0, onWater: false,
      health: 1, destroyed: false, gForce: 1, braking: false, reversing: false, drifting: false,
    };
    this.upsideTimer = 0;
    this.agl = 0;
    this.groundY = 0;
    // subclasses call this.reset(o.position, o.yaw, o.state) once their own state exists
  }

  /** Teleport. state: { air:true, speed (m/s), pitch, roll } for airborne starts. */
  reset(position, yaw = 0, state = {}) {
    const b = this.body;
    const q = eulerQuat(yaw, state.pitch || 0, state.roll || 0);
    b.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    b.setRotation(q, true);
    const sp = state.speed || 0;
    const f = rotate(v3(), q, v3(0, 0, -1));
    b.setLinvel({ x: f.x * sp, y: f.y * sp, z: f.z * sp }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.resetForces(true);
    b.resetTorques(true);
    copy(this.prevPos, position);
    Object.assign(this.prevRot, q);
    this.predVel = null;
    copy(this.lastVel, b.linvel());
    this.drowned = false;
    this.waterT = 0;
    this.upsideTimer = 0;
    this.holdT = state.air ? 0 : (state.hold ?? 2.5);
    copy(this.holdPos, position);
    if (this.parked) this.park(false);
    this.onReset?.(state);
  }

  repair() {
    this.health = 1;
    this.destroyed = false;
    this.telemetry.destroyed = false;
    this.telemetry.health = 1;
    this.onRepair?.();
  }

  /** Disable the body far from the player (no colliders streamed there). */
  park(on) {
    if (this.parked === on) return;
    this.parked = on;
    this.body.setEnabled(!on);
    if (!on) this.body.wakeUp();
  }

  // ---------- per-step frame ----------
  beginStep(dt) {
    const S = this.S;
    const body = this.body;
    const pos = copy(S.pos, body.translation());
    const r = body.rotation();
    S.rot.x = r.x; S.rot.y = r.y; S.rot.z = r.z; S.rot.w = r.w;
    copy(this.prevPos, pos);
    Object.assign(this.prevRot, S.rot);
    const lin = copy(S.lin, body.linvel());
    copy(S.ang, body.angvel());
    copy(S.com, body.worldCom());
    rotate(S.right, S.rot, set(S.tmp, 1, 0, 0));
    rotate(S.up, S.rot, set(S.tmp, 0, 1, 0));
    rotate(S.fwd, S.rot, set(S.tmp, 0, 0, -1));
    // impact: velocity change not explained by our own impulses + gravity
    if (this.predVel) {
      const dv = Math.hypot(lin.x - this.predVel.x, lin.y - this.predVel.y, lin.z - this.predVel.z);
      if (dv > 2.5) this.onImpact(dv);
    }
    const ax = (lin.x - this.lastVel.x) / dt, ay = (lin.y - this.lastVel.y) / dt, az = (lin.z - this.lastVel.z) / dt;
    this.accel.x += (ax - this.accel.x) * 0.15;
    this.accel.y += (ay - this.accel.y) * 0.15;
    this.accel.z += (az - this.accel.z) * 0.15;
    copy(this.lastVel, lin);
    set(this.linImp, 0, 0, 0);
  }

  endStep(dt) {
    const S = this.S;
    const im = 1 / this.spec.mass;
    this.predVel = this.predVel || v3();
    set(this.predVel, S.lin.x + this.linImp.x * im, S.lin.y + this.linImp.y * im - G * dt, S.lin.z + this.linImp.z * im);
    // safety caps
    const lin = this.body.linvel();
    const sp = Math.hypot(lin.x, lin.y, lin.z);
    if (!Number.isFinite(sp)) this.recoverNaN();
    else if (sp > MAX_LINVEL) this.body.setLinvel({ x: lin.x * MAX_LINVEL / sp, y: lin.y * MAX_LINVEL / sp, z: lin.z * MAX_LINVEL / sp }, true);
    const av = this.body.angvel();
    const w = Math.hypot(av.x, av.y, av.z);
    if (w > MAX_ANGVEL) this.body.setAngvel({ x: av.x * MAX_ANGVEL / w, y: av.y * MAX_ANGVEL / w, z: av.z * MAX_ANGVEL / w }, true);
  }

  recoverNaN() {
    const p = this.prevPos;
    this.body.setTranslation({ x: Number.isFinite(p.x) ? p.x : 0, y: Number.isFinite(p.y) ? p.y + 1 : 50, z: Number.isFinite(p.z) ? p.z : 0 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  }

  impulse(fx, fy, fz, dt, point) {
    if (fx * fx + fy * fy + fz * fz < 1e-8) return; // keep resting bodies asleep
    const J = this.S.F;
    set(J, fx * dt, fy * dt, fz * dt);
    if (point) this.body.applyImpulseAtPoint(J, point, true);
    else this.body.applyImpulse(J, true);
    this.linImp.x += J.x; this.linImp.y += J.y; this.linImp.z += J.z;
  }

  torque(tx, ty, tz, dt) {
    if (tx * tx + ty * ty + tz * tz < 1e-8) return;
    const J = this.S.tmp2;
    set(J, tx * dt, ty * dt, tz * dt);
    this.body.applyTorqueImpulse(J, true);
  }

  /** Torque from desired body-frame angular accelerations: pitch (+nose up), yaw (+nose right), roll (+right wing down). */
  bodyAccel(aPitch, aYaw, aRoll, dt) {
    const S = this.S, I = this.spec.inertia;
    const tp = I.x * aPitch, ty = -I.y * aYaw, tr = I.z * aRoll;
    this.torque(
      S.right.x * tp + S.up.x * ty + S.fwd.x * tr,
      S.right.y * tp + S.up.y * ty + S.fwd.y * tr,
      S.right.z * tp + S.up.z * ty + S.fwd.z * tr, dt);
  }

  /** World position of a local point. */
  toWorld(o, lx, ly, lz) {
    rotate(o, this.S.rot, set(o, lx, ly, lz));
    o.x += this.S.pos.x; o.y += this.S.pos.y; o.z += this.S.pos.z;
    return o;
  }

  /** Velocity of a world point. */
  pointVel(o, p) {
    const S = this.S;
    const rx = p.x - S.com.x, ry = p.y - S.com.y, rz = p.z - S.com.z;
    const w = S.ang;
    return set(o, S.lin.x + w.y * rz - w.z * ry, S.lin.y + w.z * rx - w.x * rz, S.lin.z + w.x * ry - w.y * rx);
  }

  /** Raycast (excluding self). Returns {toi, normal, collider} or null. */
  cast(ox, oy, oz, dx, dy, dz, max, filterGroups = this.wheelRayGroups) {
    const ray = this.ray;
    ray.origin = { x: ox, y: oy, z: oz };
    ray.dir = { x: dx, y: dy, z: dz };
    const hit = this.world.castRayAndGetNormal(ray, max, true, this.rayFlags, filterGroups, undefined, this.body);
    return hit ? { toi: hit.timeOfImpact, normal: hit.normal, collider: hit.collider } : null;
  }

  /** Ground height under (x,z) near y (raycast with analytic terrain fallback). */
  groundHeight(x, y, z, maxDown = 400) {
    const hit = this.cast(x, y, z, 0, -1, 0, maxDown, this.solidRayGroups);
    const th = this.env.heightAt(x, z);
    if (hit) return Math.max(y - hit.toi, th);
    return th;
  }

  onImpact(dv) {
    const tel = this.telemetry;
    tel.impactId++;
    tel.impactStrength = clamp((dv - 2.5) / 16, 0.05, 1);
    const crash = this.spec.crashDv || 14;
    if (dv > 4) this.damage((dv - 4) / crash);
    this.events.push({ type: 'impact', strength: tel.impactStrength, dv });
  }

  damage(amount) {
    if (this.destroyed) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.health = 0;
    this.events.push({ type: 'destroyed' });
    this.onDestroyed?.();
  }

  /**
   * Buoyancy + water drag from sample points (local coords). Returns submerged fraction (0..1).
   * opt: { k: N/m per point, c: damping N per (m/s) per point, maxDepth, dragF, dragS, dragV (N per (m/s)^2) }
   */
  floatPoints(points, dt, opt) {
    const S = this.S;
    const env = this.env;
    const t = env.time();
    const p = S.p, vp = S.vp;
    let sub = 0;
    for (let i = 0; i < points.length; i++) {
      const lp = points[i];
      this.toWorld(p, lp[0], lp[1], lp[2]);
      const th = env.heightAt(p.x, p.z);
      const wh = env.waterHeight(p.x, p.z, t, th);
      if (th > wh - 0.05) continue; // dry land under this point
      const depth = wh - p.y;
      if (depth <= 0) continue;
      const d = Math.min(depth, opt.maxDepth);
      sub += d / opt.maxDepth;
      this.pointVel(vp, p);
      let fy = opt.k * d - opt.c * vp.y;
      if (fy < 0) fy *= 0.25;
      // per-point quadratic water drag (body axes)
      const vF = dot(vp, S.fwd), vR = dot(vp, S.right), vU = dot(vp, S.up);
      const w = Math.min(1, d / (opt.maxDepth * 0.5));
      const fF = -opt.dragF * vF * Math.abs(vF) * w;
      const fR = -opt.dragS * vR * Math.abs(vR) * w - (opt.linS || 0) * vR * w;
      const fU = -(opt.dragV || 0) * vU * Math.abs(vU) * w;
      this.impulse(
        S.fwd.x * fF + S.right.x * fR + S.up.x * fU,
        fy + S.fwd.y * fF + S.right.y * fR + S.up.y * fU,
        S.fwd.z * fF + S.right.z * fR + S.up.z * fU, dt, p);
    }
    return points.length ? sub / points.length : 0;
  }

  /** Hold the body still after spawning until the ground colliders under it are streamed in. */
  updateHold(dt, probeY) {
    if (this.holdT <= 0) return false;
    const S = this.S;
    const hit = this.cast(S.pos.x, S.pos.y + 0.5, S.pos.z, 0, -1, 0, (probeY ?? 3) + 0.5, this.solidRayGroups);
    if (hit) { this.holdT = 0; return false; }
    this.holdT -= dt;
    this.body.setTranslation(this.holdPos, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return this.holdT > 0;
  }

  /** Shared telemetry (call at the end of step). */
  baseTelemetry(dt) {
    const S = this.S, tel = this.telemetry;
    const lin = S.lin;
    const sp = Math.hypot(lin.x, lin.y, lin.z);
    const vF = dot(lin, S.fwd);
    tel.speedKmh = sp * 3.6;
    tel.forwardSpeed = vF;
    tel.airspeed = sp * 3.6;
    tel.verticalSpeed = lin.y;
    tel.altitudeAsl = S.pos.y;
    tel.altitude = this.agl;
    let hdg = bearing(S.fwd) * 180 / Math.PI;
    if (hdg < 0) hdg += 360;
    tel.heading = hdg;
    tel.pitch = Math.asin(clamp(S.fwd.y, -1, 1)) * 180 / Math.PI;
    tel.roll = Math.atan2(-S.right.y, S.up.y) * 180 / Math.PI;
    const upside = S.up.y < 0.1;
    this.upsideTimer = upside && sp < 4 ? this.upsideTimer + dt : 0;
    tel.upsideDown = this.upsideTimer > 1.5;
    tel.health = this.health;
    tel.destroyed = this.destroyed;
    const a = this.accel;
    tel.gForce = (a.x * S.up.x + (a.y + G) * S.up.y + a.z * S.up.z) / G;
  }

  /** Drowning for aircraft: CoM under water for `limit` seconds. */
  updateDrowning(dt, limit = 3) {
    const S = this.S;
    const wh = this.env.waterHeight(S.com.x, S.com.z, this.env.time(), this.env.heightAt(S.com.x, S.com.z));
    const under = S.com.y < wh - 0.6 && this.env.heightAt(S.com.x, S.com.z) < wh - 0.5;
    this.waterT = under ? this.waterT + dt : Math.max(0, this.waterT - dt * 2);
    if (this.waterT > limit && !this.drowned) {
      this.drowned = true;
      this.events.push({ type: 'drowned' });
    }
  }

  /** Splash detection on the first water contact (strength from the vertical speed). */
  waterEntry(wet) {
    if (wet && !this.wetPrev) {
      const v = this.S.lin;
      const s = clamp((Math.abs(v.y) + Math.hypot(v.x, v.z) * 0.15) / 14, 0.1, 1);
      this.events.push({ type: 'splash', strength: s });
    }
    this.wetPrev = wet;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.world.removeRigidBody(this.body); } catch { /* world already freed */ }
  }
}

export { cross };
