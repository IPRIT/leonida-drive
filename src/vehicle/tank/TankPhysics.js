// Tracked-vehicle physics on Rapier: one heavy rigid body, raycast road wheels on spring/damper units, and
// skid steering (each track is driven towards its own surface speed; the hull turns by the speed difference).
// Track forces use an implicit friction model: per contact, the force that would cancel the slip in one step,
// capped by the friction limit, so standstill holds without creep and pivot turns stay stable.
import { GROUPS, groups, WHEEL_RAY_MASK } from '../groups.js';
import { TANK } from './TankModel.js';

const G = 9.81;
const DEFAULT_SURFACE = { name: 'asphalt', grip: 1, rolling: 0, dust: false };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, t, s) => (v < t ? Math.min(v + s, t) : Math.max(v - s, t));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const set = (o, x, y, z) => ((o.x = x), (o.y = y), (o.z = z), o);
const copy = (o, a) => ((o.x = a.x), (o.y = a.y), (o.z = a.z), o);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
function rot(out, q, v) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return set(out, ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
}
function cross(out, a, b) { return set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
function norm(o) { const l = Math.hypot(o.x, o.y, o.z) || 1; o.x /= l; o.y /= l; o.z /= l; return o; }

export const TANK_SPEC = {
  name: 'tank',
  kind: 'tank',
  mass: 55000,
  com: { x: 0, y: 0.95 - TANK.originY, z: 0.2 },
  inertia: { x: 2.7e5, y: 3.1e5, z: 0.95e5 },
  topSpeed: 65 / 3.6,
  reverseSpeed: 25 / 3.6,
  accel: 1.55, // m/s² track ramp (slow, heavy)
  coastDecel: 2.0,
  brakeDecel: 6.5,
  pivotRate: 0.8, // rad/s on the spot
  turnAccel: 6.0, // m/s²: yaw authority at speed = turnAccel / v (≈ 0.6 g, inside the side grip; 0.36 rad/s at 60 km/h)
  minTurnRate: 0.32, // rad/s floor: never less than 40 % of the pivot rate, even at top speed
  steerTau: [0.14, 0.36], // s: steering response, standstill → speed (heavy, progressive)
  steerJerk: 1.4, // rad/s²: max change rate of the commanded yaw rate
  scrub: 0.17, // rad/s-equivalent extra track speed difference that overcomes track scrub (Coulomb-like)
  pivotScrub: 2.4, // extra scrub per rad/s above 0.4 rad/s when pivoting on the spot
  yawKp: 0.8, // yaw-rate feedback (also damps heading wobble when driving straight)
  yawKi: 1.5, // slow, leaky, clamped trim (only near the target, so no windup / overshoot)
  power: 1.1e6, // W at the tracks
  travel: 0.32,
  restComp: 0.11,
  k: 3.5e5, // per road wheel, N/m (14 wheels carry the weight at restComp)
  cBump: 4.0e4, // ζ ≈ 0.55 / 0.7: a planted, heavy ride over bumps at speed
  cRebound: 5.2e4,
  muLong: 1.0,
  muLat: 0.78,
  idle: 700,
  maxRpm: 2600,
  gearTops: [3.2, 6.6, 11.5, 18.6],
  // for code that expects a vehicle spec
  size: { length: TANK.length, width: TANK.width, height: TANK.height },
  wheelRadius: TANK.originY, // body origin height above the ground (cars: wheel centre)
  wheelbase: TANK.rwZ[6] - TANK.rwZ[0],
};

export class TankPhysics {
  /** @param {{RAPIER, world, position, yaw, env, quality?: 'high'|'low'}} o */
  constructor(o) {
    const { RAPIER, world } = o;
    this.RAPIER = RAPIER;
    this.world = world;
    this.env = o.env || null;
    this.spec = TANK_SPEC;
    this.quality = o.quality || 'high';
    this.drowned = false;
    this.disposed = false;
    const S = this.spec;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setCcdEnabled(true)
      .setLinearDamping(0.02)
      .setAngularDamping(0.4)
      .setAdditionalMassProperties(S.mass, S.com, S.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = world.createRigidBody(desc);
    this.body.userData = { type: 'vehicle', vehicle: this, tank: true };
    const cg = groups(GROUPS.VEHICLE, GROUPS.ALL);
    // hull: convex hull with sloped nose / tail so kerbs and wrecks push it up instead of stopping it
    const prof = [[-3.92, 1.12], [-3.36, 0.47], [3.28, 0.47], [3.68, 0.85], [3.7, 1.6], [3.5, 1.66], [-2.5, 1.66]];
    const hw = TANK.width / 2 - 0.05;
    const pts = new Float32Array(prof.length * 6);
    const oy = TANK.originY;
    prof.forEach(([z, y], i) => pts.set([-hw, y - oy, z, hw, y - oy, z], i * 6));
    const hullDesc = (RAPIER.ColliderDesc.convexHull(pts) || RAPIER.ColliderDesc.cuboid(hw, 0.6, 3.7).setTranslation(0, 1.07 - oy, 0))
      .setDensity(0).setFriction(0.35).setRestitution(0.05).setCollisionGroups(cg);
    // turret as a round cylinder: orientation independent of the turret yaw
    const turDesc = RAPIER.ColliderDesc.cylinder(0.38, 1.62)
      .setTranslation(TANK.turret[0], TANK.turret[1] + 0.4 - oy, TANK.turret[2] + 0.2)
      .setDensity(0).setFriction(0.3).setRestitution(0.05).setCollisionGroups(cg);
    this.colliders = [world.createCollider(hullDesc, this.body), world.createCollider(turDesc, this.body)];
    this.rayGroups = groups(GROUPS.ALL, WHEEL_RAY_MASK);
    this.rayFlags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    this.ray = new RAPIER.Ray(v3(), v3(0, -1, 0));

    // contact units: idler, 7 road wheels, sprocket per side (idler/sprocket only touch obstacles)
    this.wheels = [];
    for (const side of [-1, 1]) {
      const add = (z, cy, R, road) => this.wheels.push({
        side, left: side < 0, road, x: side * TANK.trackX, z, cy, R, mountY: cy - TANK.originY + S.travel - S.restComp,
        contact: false, comp: 0, prevComp: 0, dist: S.travel - S.restComp, prevDist: S.travel - S.restComp,
        susForce: 0, load: 0, point: v3(), normal: v3(0, 1, 0), ground: null, groundCollider: null, surface: DEFAULT_SURFACE,
        fl: 0, ft: 0, slip: 0, inWater: false,
      });
      add(TANK.idler[0], TANK.idler[1], TANK.idler[2] + TANK.th, false);
      for (const z of TANK.rwZ) add(z, TANK.rwY, TANK.rwR + TANK.th, true);
      add(TANK.sprocket[0], TANK.sprocket[1], TANK.sprocket[2] + TANK.th, false);
    }
    this.prevPos = v3();
    this.prevRot = { x: 0, y: 0, z: 0, w: 1 };
    this.input = { throttle: 0, brake: 0, steer: 0 };
    this.cmdV = 0;
    this.cmdW = 0;
    this.wI = 0;
    this.reverse = false;
    this.revT = 0;
    this.trackL = 0; // track surface speeds (m/s, + = forward)
    this.trackR = 0;
    this.trackDistL = 0; // integrated, for the tread scroll / wheel spin
    this.trackDistR = 0;
    this.anchor = null;
    this.predVel = null;
    this.lastVel = v3();
    this.accel = v3();
    this.rpm = S.idle;
    this.gear = 1;
    this.upsideT = 0;
    this.airT = 0;
    this.rayHits = []; // colliders touched by the running gear this step (crush detection)
    this._s = {
      pos: v3(), lin: v3(), ang: v3(), com: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, up: v3(), fwd: v3(), right: v3(),
      tmp: v3(), tmp2: v3(), mount: v3(), vp: v3(), t: v3(), l: v3(), F: v3(), lin2: v3(), ang2: v3(),
    };
    this.telemetry = {
      preset: 'tank', kind: 'tank', speedKmh: 0, forwardSpeed: 0, rpm: S.idle, maxRpm: S.maxRpm, idleRpm: S.idle, gear: 1,
      throttle: 0, brake: 0, engineLoad: 0, shifting: false, shiftId: 0, limiter: false, boost: 1, boosting: false,
      wheels: [0, 1, 2, 3].map(() => ({ contact: false, slipRatio: 0, slipAngle: 0, load: 0, surface: 'asphalt', skid: 0, compression: 0, inWater: false })),
      drifting: false, airborne: false, slipAngle: 0, latAccel: 0, longAccel: 0, yawRate: 0, maxSkid: 0, handbrake: false,
      braking: false, reversing: false, inWater: false, submerged: 0, upsideDown: false, impactId: 0, impactStrength: 0,
      lean: 0, wheelie: 0, fallen: false, trackL: 0, trackR: 0, trackSpeed: 0, turretYaw: 0, barrelPitch: 0, turretSpeed: 0,
    };
    this.reset(o.position || v3(), o.yaw || 0);
  }

  reset(position, yaw = 0) {
    const b = this.body;
    const y = (position.y || 0) + TANK.originY + 0.06;
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    b.setTranslation({ x: position.x || 0, y, z: position.z || 0 }, true);
    b.setRotation(q, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.resetForces(true);
    b.resetTorques(true);
    set(this.prevPos, position.x || 0, y, position.z || 0);
    Object.assign(this.prevRot, q);
    for (const w of this.wheels) {
      w.contact = false; w.comp = w.prevComp = 0; w.dist = w.prevDist = this.spec.travel - this.spec.restComp; w.load = 0;
    }
    this.cmdV = this.cmdW = this.wI = 0;
    this.reverse = false;
    this.anchor = null;
    this.predVel = null;
    set(this.lastVel, 0, 0, 0);
    this.drowned = false;
    this.upsideT = 0;
  }

  setVelocity(v) {
    this.body.setLinvel({ x: v.x || 0, y: v.y || 0, z: v.z || 0 }, true);
    this.predVel = null;
    const f = rot(this._s.tmp, this.body.rotation(), set(this._s.tmp2, 0, 0, -1));
    this.cmdV = (v.x || 0) * f.x + (v.y || 0) * f.y + (v.z || 0) * f.z;
  }

  clearForces() {
    this.body.resetForces(false);
    this.body.resetTorques(false);
  }

  _surface(x, z) {
    const env = this.env;
    return (env && typeof env.getSurface === 'function' && env.getSurface(x, z)) || DEFAULT_SURFACE;
  }

  /**
   * One fixed step (call before world.step).
   * @param {number} dt
   * @param {{throttle?: number, brake?: number, steer?: number, driver?: boolean, disabled?: boolean}} input
   *   steer > 0 = turn right (clockwise from above); disabled = destroyed (no drive, tracks locked)
   */
  fixedUpdate(dt, input = {}) {
    if (this.disposed) return;
    const S = this.spec, s = this._s, body = this.body, tel = this.telemetry;
    const inp = this.input;
    inp.throttle = clamp(+input.throttle || 0, 0, 1);
    inp.brake = clamp(+input.brake || 0, 0, 1);
    inp.steer = clamp(+input.steer || 0, -1, 1);
    const disabled = !!input.disabled || this.drowned;
    if (disabled) inp.throttle = inp.brake = inp.steer = 0;
    this.rayHits.length = 0;

    body.resetForces(false);
    body.resetTorques(false);
    const pos = copy(s.pos, body.translation());
    const r = body.rotation();
    const q = s.q;
    q.x = r.x; q.y = r.y; q.z = r.z; q.w = r.w;
    copy(this.prevPos, pos);
    Object.assign(this.prevRot, q);
    for (const w of this.wheels) { w.prevDist = w.dist; w.prevComp = w.comp; }
    const lin = copy(s.lin, body.linvel());
    const ang = copy(s.ang, body.angvel());
    const com = copy(s.com, body.worldCom());
    const up = rot(s.up, q, set(s.tmp, 0, 1, 0));
    const fwd = rot(s.fwd, q, set(s.tmp, 0, 0, -1));
    const right = rot(s.right, q, set(s.tmp, 1, 0, 0));

    // impacts: velocity change not explained by our own forces + gravity
    if (this.predVel) {
      const dv = Math.hypot(lin.x - this.predVel.x, lin.y - this.predVel.y, lin.z - this.predVel.z);
      if (dv > 2.5) { tel.impactId++; tel.impactStrength = clamp((dv - 2.5) / 12, 0.05, 1); }
    }
    const ax = (lin.x - this.lastVel.x) / dt, ay = (lin.y - this.lastVel.y) / dt, az = (lin.z - this.lastVel.z) / dt;
    this.accel.x += (ax - this.accel.x) * 0.2; this.accel.y += (ay - this.accel.y) * 0.2; this.accel.z += (az - this.accel.z) * 0.2;
    copy(this.lastVel, lin);

    const vF = dot(lin, fwd);
    const speed = Math.hypot(lin.x, lin.y, lin.z);
    const idle = inp.throttle < 0.02 && inp.brake < 0.02 && Math.abs(inp.steer) < 0.02;
    if (body.isSleeping()) {
      if (idle) { this.predVel = null; this._idleTelemetry(dt); return; }
      body.wakeUp();
    }

    // ---- commands: GTA-style reverse (hold brake when stopped), ramped track speeds ----
    if (!this.reverse) {
      this.revT = inp.brake > 0.1 && inp.throttle < 0.1 && vF < 0.5 ? this.revT + dt : 0;
      if (this.revT > 0.15) this.reverse = true;
    } else if (inp.throttle > 0.1 && inp.brake < 0.1 && vF > -0.5) { this.reverse = false; this.revT = 0; }
    let target, rate;
    if (!this.reverse) {
      if (inp.brake > 0.05 && vF > 0.3) { target = 0; rate = S.coastDecel + (S.brakeDecel - S.coastDecel) * inp.brake; }
      else { target = inp.throttle * S.topSpeed; rate = target > this.cmdV ? S.accel * (1 - 0.55 * smooth(0, S.topSpeed, this.cmdV)) : S.coastDecel; }
    } else if (inp.throttle > 0.05 && vF < -0.3) { target = 0; rate = S.brakeDecel; }
    else { target = -inp.brake * S.reverseSpeed; rate = target < this.cmdV ? S.accel : S.coastDecel; }
    if (disabled) { target = 0; rate = S.brakeDecel; }
    this.cmdV = approach(this.cmdV, target, rate * dt);
    this.cmdV = clamp(this.cmdV, vF - 2.5, vF + 2.5); // a blocked tank doesn't wind its tracks up
    // ---- steering: speed-sensitive yaw authority, filtered command, scrub feed-forward + light feedback ----
    const vAbs = Math.abs(vF);
    const maxW = Math.min(S.pivotRate, Math.max(S.minTurnRate, S.turnAccel / Math.max(vAbs, 0.5)));
    let wT = disabled ? 0 : inp.steer * maxW;
    if (this.reverse && target < -0.1) wT = -wT; // car-like steering while reversing
    // letting go recentres faster than turning in, so the hull settles quickly after a correction
    const tau = (S.steerTau[0] + (S.steerTau[1] - S.steerTau[0]) * smooth(2, 14, vAbs)) * (Math.abs(wT) < Math.abs(this.cmdW) ? 0.55 : 1);
    const dCmd = (wT - this.cmdW) * (1 - Math.exp(-dt / tau));
    this.cmdW += clamp(dCmd, -S.steerJerk * dt, S.steerJerk * dt);
    if (Math.abs(this.cmdW) > maxW) this.cmdW = Math.sign(this.cmdW) * maxW; // speeding up never tightens the turn
    const wNow = -dot(ang, up); // clockwise positive
    const aw = Math.abs(this.cmdW), sw = Math.sign(this.cmdW);
    const still = 1 - smooth(0.5, 3, vAbs); // on the spot every road wheel scrubs sideways
    const scrub = aw < 1e-4 ? 0 : sw * ((S.scrub + 0.2 * still) * Math.tanh(aw / 0.05) + S.pivotScrub * Math.max(0, aw - 0.4) * still);
    const eW = this.cmdW - wNow;
    if (aw > 0.02 && !disabled && Math.abs(eW) < 0.1) this.wI = clamp(this.wI + eW * dt * S.yawKi, -0.25, 0.25);
    this.wI *= 1 - dt * (aw > 0.02 ? 0.3 : 3);
    const dW = disabled ? 0 : this.cmdW + scrub + eW * S.yawKp + this.wI;
    const B = TANK.trackX * 2;
    let sL = this.cmdV + dW * B * 0.5;
    let sR = this.cmdV - dW * B * 0.5;

    // standstill hold: pull back to the anchor point (no creep on slopes)
    const holding = Math.abs(target) < 1e-3 && Math.abs(wT) < 1e-3 && Math.abs(this.cmdV) < 0.05 && Math.abs(vF) < 0.4;
    let latT = 0;
    if (holding) {
      if (!this.anchor) this.anchor = v3(pos.x, pos.y, pos.z);
      const ex = pos.x - this.anchor.x, ey = pos.y - this.anchor.y, ez = pos.z - this.anchor.z;
      const ef = ex * fwd.x + ey * fwd.y + ez * fwd.z, er = ex * right.x + ey * right.y + ez * right.z;
      if (Math.hypot(ef, er) > 1.5) this.anchor = v3(pos.x, pos.y, pos.z);
      const adj = clamp(-ef * 2.5, -0.4, 0.4);
      sL += adj; sR += adj;
      latT = clamp(-er * 2.5, -0.4, 0.4);
    } else this.anchor = null;

    // ---- water ----
    const waterLevel = this.env && typeof this.env.waterLevel === 'number' ? this.env.waterLevel : -Infinity;
    const submerged = clamp((waterLevel - (pos.y + 0.5)) / 1.6, 0, 1);
    if (pos.y + 1.75 < waterLevel) this.drowned = true;

    // ---- running gear raycasts ----
    const world = this.world, ray = this.ray;
    set(ray.dir, -up.x, -up.y, -up.z);
    const offs = this.quality === 'low' ? [0] : [0, -0.6, 0.6];
    let contacts = 0, roadContacts = 0;
    const linImp = set(s.lin2, 0, 0, 0), angImp = set(s.ang2, 0, 0, 0);
    const add = (F, p) => {
      linImp.x += F.x * dt; linImp.y += F.y * dt; linImp.z += F.z * dt;
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      angImp.x += (ry * F.z - rz * F.y) * dt; angImp.y += (rz * F.x - rx * F.z) * dt; angImp.z += (rx * F.y - ry * F.x) * dt;
    };
    const pvel = (o, p) => {
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      return set(o, lin.x + ang.y * rz - ang.z * ry, lin.y + ang.z * rx - ang.x * rz, lin.z + ang.x * ry - ang.y * rx);
    };
    for (const w of this.wheels) {
      const m = rot(s.mount, q, set(s.tmp, w.x, w.mountY, w.z));
      m.x += pos.x; m.y += pos.y; m.z += pos.z;
      let best = Infinity, hit = null, bestOff = 0, bestToi = 0;
      for (let k = 0; k < offs.length; k++) {
        const a = offs[k] * w.R;
        const drop = Math.sqrt(w.R * w.R - a * a);
        set(ray.origin, m.x + fwd.x * a, m.y + fwd.y * a, m.z + fwd.z * a);
        const h = world.castRayAndGetNormal(ray, S.travel + drop + 0.15, true, this.rayFlags, this.rayGroups, undefined, body);
        if (h) { const d = h.timeOfImpact - drop; if (d < best) { best = d; hit = h; bestOff = a; bestToi = h.timeOfImpact; } }
      }
      const was = w.contact;
      w.contact = false;
      w.ground = null;
      w.groundCollider = null;
      if (hit) {
        const n = hit.normal;
        if (bestToi > 1e-4) set(w.normal, n.x, n.y, n.z); else copy(w.normal, up);
        let comp = S.travel - best;
        if (dot(w.normal, up) > 0.3 && (comp > 0 || was)) {
          set(w.point, m.x + fwd.x * bestOff - up.x * bestToi, m.y + fwd.y * bestOff - up.y * bestToi, m.z + fwd.z * bestOff - up.z * bestToi);
          if (was) {
            const vp = pvel(s.vp, w.point);
            const maxC = w.comp + (Math.max(0, -dot(vp, w.normal)) + 1.4) * dt;
            if (comp > maxC) comp = maxC;
            const minC = w.comp - (Math.max(0, dot(vp, w.normal)) + 0.9) * dt;
            if (comp < minC) comp = minC;
          }
          if (comp > 0) {
            w.contact = true;
            contacts++;
            if (w.road) roadContacts++;
            w.comp = comp;
            w.dist = Math.max(0, S.travel - comp);
            w.groundCollider = hit.collider;
            const p = hit.collider.parent();
            w.ground = p && p.isDynamic() ? p : null;
            if (p && !p.isFixed()) this.rayHits.push(hit.collider);
            w.surface = this._surface(w.point.x, w.point.z);
            w.inWater = w.point.y < waterLevel;
          }
        }
      }
      if (!w.contact) { w.comp = 0; w.dist = approach(w.dist, S.travel, 3 * dt); w.load = 0; }
    }
    this.airT = contacts === 0 ? this.airT + dt : 0;

    // ---- suspension ----
    for (const w of this.wheels) {
      w.susForce = 0;
      if (!w.contact) continue;
      const vp = pvel(s.vp, w.point);
      if (w.ground) { const gv = w.ground.velocityAtPoint(w.point); vp.x -= gv.x; vp.y -= gv.y; vp.z -= gv.z; }
      const cv = clamp(-dot(vp, w.normal), -4, 4);
      let F = S.k * Math.min(w.comp, S.travel) + (cv > 0 ? S.cBump * cv : S.cRebound * cv);
      // progressive bump stop over the last 6 cm; beyond full travel only cancel the approach speed (no launch)
      if (w.comp > S.travel - 0.06) F += S.k * 5 * (Math.min(w.comp, S.travel + 0.04) - (S.travel - 0.06));
      if (w.comp > S.travel) { const vn = dot(vp, w.normal); if (vn < 0) F += ((S.mass / Math.max(contacts, 7)) * -vn) / dt * 0.4; }
      w.susForce = clamp(F, 0, S.mass * G * 0.3);
      set(s.F, up.x * w.susForce, up.y * w.susForce, up.z * w.susForce);
      add(s.F, w.point);
      w.load = w.susForce * Math.max(0, dot(up, w.normal));
    }

    // ---- track forces (implicit friction toward the commanded track speed) ----
    const mEff = S.mass / Math.max(contacts, 7);
    const beta = 0.45;
    let pPos = 0, pNeg = 0;
    let maxSlip = 0;
    for (const w of this.wheels) {
      w.fl = w.ft = 0;
      if (!w.contact || w.load <= 0) continue;
      const n = w.normal;
      const t = s.t;
      const fn = dot(fwd, n);
      norm(set(t, fwd.x - n.x * fn, fwd.y - n.y * fn, fwd.z - n.z * fn));
      const l = norm(cross(s.l, t, n));
      const vp = pvel(s.vp, w.point);
      if (w.ground) { const gv = w.ground.velocityAtPoint(w.point); vp.x -= gv.x; vp.y -= gv.y; vp.z -= gv.z; }
      const vl = dot(vp, t), vlat = dot(vp, l);
      const grip = 0.75 + 0.25 * (w.surface.grip ?? 1);
      const muL = S.muLong * grip * (w.inWater ? 0.8 : 1), muT = S.muLat * grip;
      const sTrack = w.side < 0 ? sL : sR;
      // combined-slip friction ellipse with smooth (tanh) saturation that keeps the force direction: grip fades into
      // scrub progressively (no snap at the limit), and a spinning track loses side grip like a real one
      const capL = muL * w.load, capT = muT * w.load;
      const ex = ((sTrack - vl) * mEff / dt * beta) / capL, ey = ((latT - vlat) * mEff / dt * beta) / capT;
      const em = Math.hypot(ex, ey);
      const ek = em > 1e-6 ? Math.tanh(em) / em : 1;
      let fl = ex * ek * capL;
      let ft = ey * ek * capT;
      w.fl = fl; w.ft = ft;
      w.slip = Math.abs(sTrack - vl) + Math.abs(vlat) * 0.5;
      if (w.slip > maxSlip) maxSlip = w.slip;
      const pw = fl * sTrack;
      if (pw > 0) pPos += pw; else pNeg += pw;
    }
    // regenerative steering: the braked inner track feeds the outer one, so the limit is on net power
    const pScale = pPos + pNeg > S.power ? clamp((S.power - pNeg) / pPos, 0, 1) : 1;
    const pDrive = pPos + pNeg;
    for (const w of this.wheels) {
      if (!w.contact || (!w.fl && !w.ft)) continue;
      const sTrack = w.side < 0 ? sL : sR;
      if (w.fl * sTrack > 0) w.fl *= pScale;
      const n = w.normal, t = s.t;
      const fn = dot(fwd, n);
      norm(set(t, fwd.x - n.x * fn, fwd.y - n.y * fn, fwd.z - n.z * fn));
      const l = norm(cross(s.l, t, n));
      set(s.F, t.x * w.fl + l.x * w.ft, t.y * w.fl + l.y * w.ft, t.z * w.fl + l.z * w.ft);
      add(s.F, w.point);
      if (w.ground) w.ground.applyImpulseAtPoint({ x: -s.F.x * dt, y: -s.F.y * dt, z: -s.F.z * dt }, w.point, true);
    }

    // ---- keep it upright (tanks don't roll over in normal driving) ----
    const I = S.inertia;
    if (!disabled && up.y < 0.8) {
      const lev = cross(s.tmp, up, set(s.tmp2, 0, 1, 0));
      const k = (0.8 - up.y) * 9 * (I.x + I.z) * 0.5;
      angImp.x += lev.x * k * dt; angImp.y += lev.y * k * dt; angImp.z += lev.z * k * dt;
    }
    if (this.airT > 0.15) {
      const wx = dot(ang, right), wz = dot(ang, fwd);
      angImp.x -= (right.x * wx * I.x + fwd.x * wz * I.z) * 1.2 * dt;
      angImp.y -= (right.y * wx * I.x + fwd.y * wz * I.z) * 1.2 * dt;
      angImp.z -= (right.z * wx * I.x + fwd.z * wz * I.z) * 1.2 * dt;
    }
    if (submerged > 0) {
      const c = S.mass * 0.9 * submerged;
      set(s.F, -lin.x * c, -lin.y * c, -lin.z * c);
      add(s.F, com);
    }

    // ---- apply ----
    const settled = holding && speed < 0.05 && Math.hypot(ang.x, ang.y, ang.z) < 0.05;
    const inv = 1 / dt;
    body.addForce(set(s.tmp, linImp.x * inv, linImp.y * inv, linImp.z * inv), !settled);
    body.addTorque(set(s.tmp, angImp.x * inv, angImp.y * inv, angImp.z * inv), !settled);
    if (!disabled) {
      // roll / pitch rate limit
      const wr = dot(ang, fwd), wp = dot(ang, right);
      if (Math.abs(wr) > 2.2 || Math.abs(wp) > 2.2) {
        const cr = clamp(wr, -2.2, 2.2) - wr, cp = clamp(wp, -2.2, 2.2) - wp;
        body.setAngvel({ x: ang.x + fwd.x * cr + right.x * cp, y: ang.y + fwd.y * cr + right.y * cp, z: ang.z + fwd.z * cr + right.z * cp }, true);
      }
    }
    const im = 1 / S.mass;
    this.predVel = this.predVel || v3();
    set(this.predVel, lin.x + linImp.x * im, lin.y + linImp.y * im - G * dt, lin.z + linImp.z * im);

    // ---- track kinematics: surface speed follows the ground under each track ----
    let gl = 0, nl = 0, gr = 0, nr = 0;
    for (const w of this.wheels) {
      if (!w.contact || !w.road) continue;
      const vp = pvel(s.vp, w.point);
      const v = dot(vp, fwd);
      if (w.side < 0) { gl += v; nl++; } else { gr += v; nr++; }
    }
    this.trackL = nl ? gl / nl : approach(this.trackL, sL, 8 * dt);
    this.trackR = nr ? gr / nr : approach(this.trackR, sR, 8 * dt);
    this.trackDistL += this.trackL * dt;
    this.trackDistR += this.trackR * dt;

    // ---- engine (for audio / HUD) ----
    const vt = Math.max(Math.abs(this.trackL), Math.abs(this.trackR), Math.abs(sL), Math.abs(sR));
    const tops = S.gearTops;
    let g = tops.length;
    for (let i = 0; i < tops.length; i++) if (vt < tops[i] * 0.97) { g = i + 1; break; }
    if (g !== this.gear) { if (g > this.gear) tel.shiftId++; this.gear = g; }
    const lo = g > 1 ? tops[g - 2] * 0.55 : 0;
    const frac = clamp((vt - lo) / (tops[g - 1] - lo), 0, 1);
    const effort = Math.max(inp.throttle, inp.brake, Math.abs(inp.steer) * 0.8);
    let rpmT = S.idle + (S.maxRpm - S.idle) * (0.12 + 0.78 * frac) * (vt > 0.2 ? 1 : 0);
    rpmT = Math.max(rpmT, S.idle + (S.maxRpm - S.idle) * 0.55 * effort);
    if (disabled) rpmT = this.drowned ? 0 : S.idle;
    this.rpm = approach(this.rpm, rpmT, 2600 * dt);

    // ---- telemetry ----
    const upside = up.y < 0.1;
    this.upsideT = upside && speed < 3 ? this.upsideT + dt : 0;
    tel.speedKmh = Math.abs(vF) * 3.6;
    tel.forwardSpeed = vF;
    tel.rpm = this.rpm;
    tel.gear = this.reverse ? -1 : this.gear;
    tel.throttle = Math.max(inp.throttle, this.reverse ? inp.brake : 0, Math.abs(inp.steer) * 0.6);
    tel.brake = this.reverse ? inp.throttle : inp.brake;
    tel.engineLoad = clamp(Math.max(0, pPos * pScale + pNeg) / S.power + effort * 0.25, 0, 1);
    tel.braking = !this.reverse && inp.brake > 0.05 && vF > 0.3;
    tel.reversing = this.reverse;
    tel.airborne = this.airT > 0.1;
    tel.inWater = submerged > 0 || this.wheels.some((w) => w.inWater);
    tel.submerged = submerged;
    tel.upsideDown = this.upsideT > 1.5;
    tel.latAccel = dot(this.accel, right);
    tel.longAccel = dot(this.accel, fwd);
    tel.yawRate = dot(ang, up);
    tel.maxSkid = clamp((maxSlip - 0.6) * 0.4, 0, 1);
    tel.trackL = this.trackL;
    tel.trackR = this.trackR;
    tel.trackSpeed = (this.trackL + this.trackR) / 2;
    // four summary "wheels" for tyre/foley consumers: left/right x front/rear halves
    for (let i = 0; i < 4; i++) {
      const tw = tel.wheels[i], side = i % 2 ? 1 : -1, front = i < 2;
      let c = false, load = 0, comp = 0, surf = 'asphalt', wet = false;
      for (const w of this.wheels) {
        if (w.side !== side || !w.road || (w.z < 0) !== front || !w.contact) continue;
        c = true; load += w.load; comp = Math.max(comp, w.comp / S.travel); surf = w.surface.name; wet = wet || w.inWater;
      }
      tw.contact = c; tw.load = load; tw.compression = comp; tw.surface = c ? surf : 'air'; tw.inWater = wet;
      tw.skid = tel.maxSkid * 0.5; tw.slipRatio = 0;
    }
    this.contacts = contacts;
    this.roadContacts = roadContacts;
  }

  _idleTelemetry(dt) {
    const tel = this.telemetry;
    tel.speedKmh = 0;
    tel.forwardSpeed = 0;
    tel.throttle = tel.brake = 0;
    tel.maxSkid = 0;
    this.trackL = this.trackR = 0;
    tel.trackL = tel.trackR = tel.trackSpeed = 0;
    this.rpm = approach(this.rpm, this.drowned ? 0 : this.spec.idle, 2600 * dt);
    tel.rpm = this.rpm;
    for (const w of this.wheels) { w.prevDist = w.dist; w.prevComp = w.comp; }
    const p = this.body.translation(), r = this.body.rotation();
    copy(this.prevPos, p);
    this.prevRot.x = r.x; this.prevRot.y = r.y; this.prevRot.z = r.z; this.prevRot.w = r.w;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.world.removeRigidBody(this.body); } catch { /* world already gone */ }
  }
}
