// Engine + automatic gearbox + torque converter. Pure math, no Rapier/THREE.

const RPM_TO_RAD = (2 * Math.PI) / 60;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target));

export class Drivetrain {
  constructor(spec) {
    this.spec = spec; // derived spec from VehiclePhysics
    const e = spec.engine;
    this.curve = e.curve;
    this.maxTorque = Math.max(...e.curve.map((p) => p[1]));
    this.gearCount = spec.gearbox.gears.length;
    this.reset();
  }

  reset() {
    this.gear = 1;
    this.rpm = this.spec.engine.idle;
    this.shiftTimer = 0;
    this.shiftTo = 1;
    this.sinceShift = 1;
    this.limiterTimer = 0;
    this.torqueOut = 0;
    this.engineTorque = 0;
    this.coupling = 0;
    this.shifting = false;
    this.lastShiftDir = 0;
    this.shiftId = 0;
  }

  ratio(g) {
    const gb = this.spec.gearbox;
    if (g > 0) return gb.gears[g - 1] * gb.finalDrive;
    if (g < 0) return -gb.reverse * gb.finalDrive;
    return 0;
  }

  torqueAt(rpm) {
    const c = this.curve;
    if (rpm <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i][0]) {
        const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return lerp(c[i - 1][1], c[i][1], t);
      }
    }
    return c[c.length - 1][1];
  }

  /** Force a gear immediately (used for R <-> D selection). */
  select(g) {
    if (g === this.gear && this.shiftTimer <= 0) return;
    this.gear = g;
    this.shiftTo = g;
    this.shiftTimer = 0.12;
    this.sinceShift = 0;
    this.lastShiftDir = 0;
    this.shiftId++;
  }

  _startShift(to, time) {
    this.lastShiftDir = Math.sign(to - this.gear);
    this.shiftTo = to;
    this.shiftTimer = time;
    this.shiftId++;
  }

  /**
   * @param dt step
   * @param throttle 0..1 (effective, after reverse logic and TCS)
   * @param wheelOmega average driven wheel angular velocity (rad/s, signed, + = forward)
   * @param opts { boosting, allowShift, submerged }
   * @returns drive torque at the driven axle(s), signed (+ = forward)
   */
  update(dt, throttle, wheelOmega, opts) {
    const e = this.spec.engine;
    const gb = this.spec.gearbox;
    this.sinceShift += dt;

    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) {
        this.gear = this.shiftTo;
        this.sinceShift = 0;
      }
    }
    const shifting = this.shiftTimer > 0;
    this.shifting = shifting;
    const g = shifting ? this.shiftTo : this.gear;
    const ratio = this.ratio(g);
    const rpmWheels = Math.abs(wheelOmega * ratio) / RPM_TO_RAD;
    this.rpmWheels = rpmWheels;

    // automatic shifting
    if (!shifting && this.gear >= 1 && opts.allowShift && this.sinceShift > 0.45) {
      const thr = clamp((throttle - 0.15) / 0.7, 0, 1);
      const upRpm = lerp(e.redline * 0.52, e.redline * 0.975, thr);
      if (rpmWheels > upRpm && this.gear < this.gearCount && !(this.lastShiftDir < 0 && this.sinceShift < 0.9)) {
        this._startShift(this.gear + 1, gb.shiftTime);
      } else if (this.gear > 1) {
        const lowerRpm = (rpmWheels * this.ratio(this.gear - 1)) / this.ratio(this.gear);
        const downRpm = lerp(e.redline * 0.3, e.redline * 0.58, thr);
        if (rpmWheels < downRpm && lowerRpm < e.redline * 0.86 && !(this.lastShiftDir > 0 && this.sinceShift < 0.9)) {
          this._startShift(this.gear - 1, gb.shiftTime * 0.6);
        }
      }
    }

    const stall = e.idle + throttle * (e.stallRpm - e.idle);
    let tcMult = 1;
    let coupling = 0;
    if (!shifting && g !== 0) {
      let target;
      if (rpmWheels >= stall) {
        target = rpmWheels;
        coupling = 1;
      } else {
        // torque converter slip
        target = stall;
        const s = rpmWheels / Math.max(stall, 1);
        coupling = s;
        tcMult = 1 + 0.45 * (1 - s);
      }
      this.rpm = lerp(this.rpm, Math.max(target, e.idle), Math.min(1, dt * 30));
    } else {
      const target = Math.max(e.idle, g === 0 ? e.idle + throttle * (e.redline - e.idle) : rpmWheels);
      this.rpm = approach(this.rpm, target, 14000 * dt);
    }
    if (this.rpm > e.limiter) this.limiterTimer = 0.07;
    if (this.limiterTimer > 0) this.limiterTimer -= dt;
    this.coupling = coupling;

    let Te = 0;
    if (!shifting && g !== 0 && !opts.submerged) {
      const cut = this.limiterTimer > 0;
      Te = cut ? 0 : throttle * this.torqueAt(this.rpm);
    }
    this.engineTorque = Te;
    const eff = Te > 0 ? gb.efficiency * tcMult : 1;
    this.torqueOut = Te * ratio * eff;
    return this.torqueOut;
  }

  /** Engine-braking torque magnitude at the driven axle(s) when off throttle (applied like a brake). */
  engineBrakeTorque() {
    if (this.shifting || this.gear === 0) return 0;
    const e = this.spec.engine;
    const f = clamp((this.rpm - e.idle) / (e.redline - e.idle), 0, 1.2);
    const fade = clamp(this.rpmWheels / (e.idle * 1.5), 0, 1);
    return e.brakeFrac * this.maxTorque * (0.3 + f) * Math.abs(this.ratio(this.gear)) * fade;
  }

  /** Engine inertia reflected to the driven wheels (total). */
  reflectedInertia() {
    if (this.shifting || this.gear === 0) return 0;
    const r = this.ratio(this.gear);
    return this.spec.engine.inertia * r * r * this.coupling;
  }
}

export { RPM_TO_RAD };
