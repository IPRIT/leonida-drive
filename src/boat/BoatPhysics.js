// Boat model: per-point buoyancy against the wave surface, lateral/keel resistance distributed along the hull,
// forward hull drag with planing (lift + drag drop + bow rise at the hump), prop/jet/fan thrust and steering,
// banking into turns, beaching on land and (airboat) skimming over wetland/grass. DOM-free.
import { Craft } from '../air/physics/Craft.js';
import { G, clamp, approach, smoothstep, dot } from '../air/physics/math.js';

export class BoatPhysics extends Craft {
  constructor(o) {
    super(o);
    const spec = this.spec;
    this.throttle = 0;
    this.thrAct = 0;
    this.steer = 0;
    this.onLand = false;
    this.planing = 0;
    this.propOut = false;
    this.landFriction = -1;
    const h = spec.hull;
    // buoyancy grid on the hull bottom; last value = lateral resistance weight (keel/skeg aft)
    this.points = [];
    for (let i = 0; i < h.nz; i++) {
      const fz = h.nz === 1 ? 0 : i / (h.nz - 1);
      const z = -h.length / 2 + fz * h.length;
      const taper = 1 - (1 - fz) ** 3 * (h.bowTaper ?? 0.6); // narrower bow
      for (let j = 0; j < h.nx; j++) {
        const x = h.nx === 1 ? 0 : (-0.5 + j / (h.nx - 1)) * h.width * taper;
        this.points.push([x, h.bottomY, z, 0.6 + fz * (h.keelAft ?? 1.6)]);
      }
    }
    this.buoyK = (spec.mass * G) / (this.points.length * h.draft);
    this.reset(o.position, o.yaw, o.state);
  }

  onReset() {
    this.throttle = this.thrAct = 0;
    this.steer = 0;
  }

  /** ctl: { active, throttle -1..1 (negative = reverse), steer -1..1 (+ = right), boost? } */
  fixedUpdate(dt, ctl) {
    if (this.disposed || this.parked) return;
    const spec = this.spec, S = this.S, tel = this.telemetry, body = this.body;
    const active = !!ctl.active;
    if (body.isSleeping() && !active) { this.idleTelemetry(); return; }
    this.beginStep(dt);
    const m = spec.mass, h = spec.hull;
    const lin = S.lin, ang = S.ang, up = S.up, fwd = S.fwd, right = S.right;
    const env = this.env;
    const t = env.time();

    // ---- inputs ----
    const thrT = active && !this.destroyed ? clamp(ctl.throttle || 0, -1, 1) : 0;
    this.throttle = thrT;
    this.thrAct = approach(this.thrAct, thrT, dt / (spec.spool || 0.8));
    const steerT = active ? clamp(ctl.steer || 0, -1, 1) : 0;
    this.steer = approach(this.steer, steerT, dt * 4);

    // ---- buoyancy + water resistance per point ----
    let sub = 0;
    let wetN = 0;
    const p = S.p, vp = S.vp;
    const kB = this.buoyK;
    const cB = (m / this.points.length) * spec.heave;
    const maxD = h.draft * 3;
    const latK = spec.lateral;
    for (const lp of this.points) {
      this.toWorld(p, lp[0], lp[1], lp[2]);
      const th = env.heightAt(p.x, p.z);
      const wh = env.waterHeight(p.x, p.z, t, th);
      if (th > wh - 0.05) continue;
      const depth = wh - p.y;
      if (depth <= 0) continue;
      wetN++;
      const d = Math.min(depth, maxD);
      sub += d / maxD;
      this.pointVel(vp, p);
      let fy = kB * d - cB * vp.y;
      if (fy < 0) fy *= 0.3;
      const vR = dot(vp, right);
      const w = Math.min(1, d / h.draft);
      const fR = -(latK * vR * Math.abs(vR) + latK * 0.8 * vR) * lp[3] * w;
      this.impulse(right.x * fR, fy + right.y * fR, right.z * fR, dt, p);
    }
    const wet = wetN / this.points.length;
    sub = this.points.length ? sub / this.points.length : 0;

    // ---- land contact ----
    const th0 = env.heightAt(S.com.x, S.com.z);
    const wh0 = env.waterHeight(S.com.x, S.com.z, t, th0);
    const ground = this.groundHeight(S.com.x, S.com.y + 0.5, S.com.z, 30);
    const landGap = S.pos.y + h.bottomY - ground;
    this.onLand = landGap < 0.35 && (th0 > wh0 - 0.25 || wet < 0.3);
    this.agl = Math.max(0, S.pos.y + h.bottomY - Math.max(ground, th0 < wh0 ? wh0 : -1e9));
    // hull friction against the ground (airboat skims, others grind to a halt)
    const fr = this.onLand && env.landFriction ? env.landFriction(S.com.x, S.com.z, spec.skims) : (spec.skims ? 0.08 : 0.55);
    if (Math.abs(fr - this.landFriction) > 0.01) {
      this.landFriction = fr;
      for (const c of this.colliders) c.setFriction(fr);
    }

    // ---- hull drag & planing ----
    const vF = dot(lin, fwd);
    const speed = Math.hypot(lin.x, lin.y, lin.z);
    const plane = smoothstep(spec.planeV0, spec.planeV1, vF) * (wet > 0.15 ? 1 : 0);
    this.planing = plane;
    const wetF = clamp(wet * 1.4, 0, 1);
    const Cf = spec.cf * (vF < 0 ? 3 : 1 - spec.planeDrop * plane); // the transom ploughs when going astern
    const dF = -(Cf * vF * Math.abs(vF) + spec.cfLin * vF) * wetF;
    this.impulse(fwd.x * dF, fwd.y * dF, fwd.z * dF, dt);
    if (plane > 0 && wet > 0.1) {
      const L = m * G * spec.planeLift * plane;
      this.impulse(up.x * L * 0.4, L, up.z * L * 0.4, dt);
    }
    // land drag (airboat on grass/mud): linear in speed
    if (this.onLand) {
      const c = env.landDrag ? env.landDrag(S.com.x, S.com.z, spec.skims) : 600;
      const k = (spec.skims ? 1 : 2.5) * c;
      this.impulse(-lin.x * k, 0, -lin.z * k, dt);
    }

    // ---- thrust ----
    const sp = spec.prop;
    this.toWorld(p, 0, sp.y, sp.z);
    const pTh = env.heightAt(p.x, p.z);
    const pWh = env.waterHeight(p.x, p.z, t, pTh);
    const propWet = sp.air ? true : p.y < pWh + 0.05 && pTh < pWh - 0.1;
    this.propOut = !propWet;
    let T = 0;
    if (propWet && !this.destroyed) {
      const thr = this.thrAct >= 0 ? this.thrAct : this.thrAct * spec.reverse;
      // props lose bite quickly going astern: reverse tops out around 18-20 % of top speed
      const shape = thr >= 0 ? Math.max(0.1, 1 - Math.max(0, vF) / (spec.vTop * 1.35)) : Math.max(0, 1 - Math.max(0, -vF) / (spec.vTop * 0.2));
      T = thr * spec.thrust * shape;
      // apply horizontally below the CoM (squat)
      const hx = fwd.x, hz = fwd.z;
      const hl = Math.hypot(hx, hz) || 1;
      this.impulse((hx / hl) * T, 0, (hz / hl) * T, dt, sp.air ? null : { x: S.com.x, y: S.com.y - 0.15, z: S.com.z });
    }

    // ---- steering, banking, trim ----
    const wx = dot(ang, right), wp = dot(ang, fwd), wr = -dot(ang, up);
    const steerWet = sp.air ? 1 : wetF;
    let aYaw = this.steer * (spec.rudder * clamp(vF / spec.rudderV, -0.6, 1) + spec.thrustSteer * Math.abs(this.thrAct)) * steerWet;
    if (sp.air && this.onLand) aYaw *= 0.6;
    aYaw -= spec.yawDamp * wr * (0.4 + wetF);
    const roll = Math.atan2(-right.y, up.y);
    const bankT = this.steer * spec.bank * smoothstep(3, 14, vF);
    let aRoll = (spec.bankK * (bankT - roll) - 2.2 * wp) * wetF;
    // planing hulls lean into the turn: torque on the scale of the hull's buoyant roll stiffness
    const lean = bankT * m * G * h.width * 0.6 * wetF;
    if (lean) this.torque(fwd.x * lean, fwd.y * lean, fwd.z * lean, dt);
    // bow rises at the hump, settles when planing; extra pitch/roll damping in the water
    const hump = Math.sin(clamp((vF - spec.planeV0 * 0.5) / (spec.planeV1 - spec.planeV0 * 0.5), 0, 1) * Math.PI);
    let aPitch = (spec.humpPitch * hump * (this.thrAct > 0 ? 1 : 0.3) + spec.trimPitch * plane) * wetF - 1.6 * wx * wetF;
    if (!wetF) { aRoll = 0; aPitch = 0; }
    this.bodyAccel(aPitch, aYaw, aRoll, dt);

    // ---- events / telemetry ----
    this.waterEntry(wet > 0.05);
    this.baseTelemetry(dt);
    tel.throttle = Math.abs(this.thrAct);
    tel.rpm = (spec.idleRpm || 800) + ((spec.maxRpm || 6000) - (spec.idleRpm || 800)) * Math.min(1, Math.abs(this.thrAct) * (this.propOut ? 1.15 : 0.85) + Math.abs(vF) / spec.vTop * 0.15);
    tel.maxRpm = spec.maxRpm || 6000;
    tel.gear = this.thrAct < -0.05 ? -1 : 1;
    tel.reversing = this.thrAct < -0.05;
    tel.planing = plane;
    tel.onLand = this.onLand;
    tel.inWater = wet > 0.05;
    tel.onWater = wet > 0.05;
    tel.submerged = sub;
    tel.wet = wet;
    tel.airborne = wet < 0.02 && !this.onLand;
    tel.propOut = this.propOut;
    tel.steer = this.steer;
    tel.speed = speed;
    this.endStep(dt);
  }

  idleTelemetry() {
    const tel = this.telemetry;
    tel.speedKmh = 0; tel.throttle = 0; tel.rpm = 0; tel.planing = 0;
    this.predVel = null;
  }
}
