// Helicopter flight model: rotor spool, collective thrust with ground effect and translational lift,
// cyclic attitude control (assisted auto-level/hover or manual rate mode), tail-rotor yaw with weathervane,
// body drag, rotor-strike detection, water flooding. DOM-free.
import { Craft } from './Craft.js';
import { G, RHO, clamp, approach, smoothstep, set, dot } from './math.js';
import { GROUPS } from '../../vehicle/groups.js';

export class HeliPhysics extends Craft {
  constructor(o) {
    super(o);
    this.rpm = 0;
    this.engineOn = false;
    this.collective = 0;
    this.cInt = 0;
    this.assist = true;
    this.grounded = false;
    this.rotorBroken = false;
    this.flood = 0;
    this.strikeStep = 0;
    this.rotorPhase = 0;
    this.groundT = 0;
    this.overWater = false;
    this.input = { collective: 0, pitch: 0, roll: 0, yaw: 0 };
    this._p = { x: 0, y: 0, z: 0 };
    this._d = { x: 0, y: 0, z: 0 };
    this.reset(o.position, o.yaw, o.state);
  }

  onReset(state = {}) {
    this.landed = !state.air;
    this.rotorBroken = false;
    this.flood = 0;
    this.collective = state.air ? 1 / this.spec.thrustRatio : 0;
    this.cInt = 0;
    if (state.air) { this.rpm = 1; this.engineOn = true; }
    else if (!state.keepRotor) { this.rpm = 0; this.engineOn = false; }
  }

  onRepair() { this.rotorBroken = false; this.flood = 0; }
  onDestroyed() { this.engineOn = false; }

  /**
   * ctl: { active, collective -1..1 (up/down), pitch -1..1 (+ = nose down / forward), roll -1..1 (+ = right),
   *        yaw -1..1 (+ = nose right), assist }
   */
  fixedUpdate(dt, ctl) {
    if (this.disposed || this.parked) return;
    const spec = this.spec, S = this.S, tel = this.telemetry;
    const body = this.body;
    const active = !!ctl.active;
    if (body.isSleeping() && !active && this.rpm < 0.01) { this.idleTelemetry(); return; }
    this.beginStep(dt);
    if (this.updateHold(dt, -spec.skidY + 0.6)) { this.baseTelemetry(dt); this.endStep(dt); return; }
    this.assist = ctl.assist !== false;
    const m = spec.mass;
    const lin = S.lin, ang = S.ang, up = S.up, fwd = S.fwd, right = S.right;

    // ---- surroundings ----
    const env = this.env;
    const t = env.time();
    const th = env.heightAt(S.com.x, S.com.z);
    const wh = env.waterHeight(S.com.x, S.com.z, t, th);
    const gy = this.groundHeight(S.com.x, S.com.y + 0.3, S.com.z, 600);
    this.overWater = th < wh - 0.3 && gy < wh;
    const surf = this.overWater ? wh : gy;
    this.groundY = surf;
    this.agl = S.pos.y + spec.skidY * Math.max(0.3, up.y) - surf;
    const grounded = !this.overWater && this.agl < 0.3 && Math.abs(lin.y) < 2.5 && up.y > 0.6;
    this.groundT = grounded ? this.groundT + dt : 0;
    this.grounded = grounded;

    // ---- engine / rotor ----
    const canRun = !this.destroyed && !this.rotorBroken && this.flood < 0.5;
    this.engineOn = active && canRun;
    if (this.engineOn) this.rpm = approach(this.rpm, 1, dt / spec.spool);
    else this.rpm = approach(this.rpm, 0, dt / (this.rotorBroken || this.destroyed ? 2.5 : spec.spinDown));
    this.rotorPhase = (this.rotorPhase + this.rpm * spec.rotorRps * Math.PI * 2 * dt) % (Math.PI * 2);
    const rpm2 = this.rpm * this.rpm;

    // ---- inputs ----
    const inp = this.input;
    const k = 1 - Math.exp(-dt * 7);
    inp.collective += ((active ? ctl.collective : -1) - inp.collective) * k;
    inp.pitch += ((active ? ctl.pitch : 0) - inp.pitch) * k;
    inp.roll += ((active ? ctl.roll : 0) - inp.roll) * k;
    inp.yaw += ((active ? ctl.yaw : 0) - inp.yaw) * k;

    // ---- body-frame velocities ----
    const vF = dot(lin, fwd), vR = dot(lin, right), vU = dot(lin, up);
    const vh = Math.hypot(lin.x, lin.z);
    const vy = lin.y;

    // ---- thrust efficiency: ground effect + translational lift ----
    const D = spec.rotor.radius * 2;
    const hubH = this.agl + spec.rotor.hubY - spec.skidY;
    const ge = hubH < D ? 0.2 * (1 - hubH / D) ** 2 : 0;
    const etl = 0.14 * smoothstep(5, 18, vh) - 0.05 * smoothstep(40, 80, vh);
    const eff = (1 + ge) * (1 + etl);

    // ---- collective ----
    const u = inp.collective;
    // landed latch: stays planted (even when bumped) until the pilot pulls collective
    if (this.landed && u > 0.1) this.landed = false;
    else if (!this.landed && grounded && this.groundT > 0.4 && u <= 0.05) this.landed = true;
    if (this.assist) {
      let vyT = u >= 0 ? u * spec.climbRate : u * spec.descendRate;
      if (u < 0) vyT = Math.max(vyT, -(0.7 + Math.max(0, this.agl) * 0.55)); // auto-flare near the ground
      let cT;
      if (this.landed) { cT = 0.12; this.cInt = 0; }
      else {
        const tilt = Math.max(0.35, up.y);
        const cFF = 1 / (spec.thrustRatio * Math.max(0.15, rpm2 * eff) * tilt);
        const err = vyT - vy;
        this.cInt = clamp(this.cInt * (1 - dt * 0.3) + err * dt * 0.05, -0.2, 0.2);
        cT = cFF + 0.12 * err + this.cInt;
      }
      this.collective = approach(this.collective, clamp(cT, 0, 1), dt * 3);
    } else {
      this.collective = clamp(this.collective + u * dt * 0.5, 0, 1);
    }
    if (!active) this.collective = approach(this.collective, 0, dt * 0.3);
    const T = spec.thrustRatio * m * G * this.collective * rpm2 * eff;
    this.impulse(up.x * T, up.y * T, up.z * T, dt);

    // ---- attitude ----
    const pitch = Math.asin(clamp(fwd.y, -1, 1));
    const roll = Math.atan2(-right.y, up.y);
    const wx = dot(ang, right); // pitch rate (+ nose up)
    const wp = dot(ang, fwd); // roll rate (+ right wing down)
    const wr = -dot(ang, up); // yaw rate (+ nose right)
    const groundF = grounded && this.collective < 0.6 / spec.thrustRatio ? 0.2 : 1;
    const auth = clamp(rpm2 * 1.25, 0, 1) * groundF;
    let aPitch, aRoll, aYaw;
    if (this.assist) {
      let thT = -inp.pitch * spec.maxPitch;
      let phT = inp.roll * spec.maxRoll;
      // hover hold: flare to brake and cancel drift when the stick is centred
      if (!grounded) {
        if (Math.abs(inp.pitch) < 0.1) thT += clamp(vF * 0.03, -0.3, 0.3);
        if (Math.abs(inp.roll) < 0.1 && vh < 20) phT -= clamp(vR * 0.05, -0.18, 0.18);
      }
      aPitch = spec.kAtt * (thT - pitch) - spec.dAtt * wx;
      aRoll = spec.kAtt * (phT - roll) - spec.dAtt * wp;
    } else {
      aPitch = spec.kRate * (-inp.pitch * spec.rateMax - wx);
      aRoll = spec.kRate * (inp.roll * spec.rateMax - wp);
    }
    let rT = inp.yaw * spec.yawRate;
    if (this.assist && vh > 14 && !grounded) rT += clamp((G * Math.tan(clamp(roll, -1.2, 1.2))) / vh, -1.2, 1.2) * 0.85;
    aYaw = spec.kYaw * (rT - wr);
    // tail fin weathervane at speed
    if (vF > 6) aYaw += spec.vane * Math.atan2(vR, vF) * Math.min(1, vF / 35);
    aYaw *= grounded ? 0.35 * this.rpm : 1;
    this.bodyAccel(aPitch * auth, aYaw * Math.max(auth, vF > 6 ? 0.4 : 0), aRoll * auth, dt);

    // ---- drag ----
    const q = 0.5 * RHO;
    const dF = -q * spec.cdFront * vF * Math.abs(vF);
    const dR = -q * spec.cdSide * vR * Math.abs(vR);
    const dU = -q * spec.cdTop * vU * Math.abs(vU);
    this.impulse(fwd.x * dF + right.x * dR + up.x * dU, fwd.y * dF + right.y * dR + up.y * dU, fwd.z * dF + right.z * dR + up.z * dU, dt);

    // ---- rotor strike ----
    if (this.rpm > 0.2 && !this.rotorBroken && (this.strikeStep++ & 1) === 0) this.checkRotorStrike();

    // ---- water ----
    const fl = spec.float;
    const kB = (m * G / fl.points.length / fl.depth) * 1.15 * (1 - this.flood);
    const sub = this.floatPoints(fl.points, dt, { k: kB, c: m / fl.points.length * 3, maxDepth: fl.depth * 1.6, dragF: m * 0.004, dragS: m * 0.01, dragV: m * 0.01 });
    const wet = sub > 0.02;
    if (wet) this.flood = Math.min(1, this.flood + dt / spec.floodTime);
    this.waterEntry(wet);
    if (wet && this.wetPrev && !this._splashed && Math.hypot(lin.x, lin.y, lin.z) > 9) { this.damage(0.35); this._splashed = true; }
    if (!wet) this._splashed = false;
    this.updateDrowning(dt, 2.5);

    // ---- telemetry ----
    this.baseTelemetry(dt);
    tel.throttle = this.collective;
    tel.collective = this.collective;
    tel.rotorRpm = this.rpm;
    tel.rotor = this.rpm;
    tel.yawRate = wr;
    tel.rpm = this.rpm * spec.maxRpm;
    tel.maxRpm = spec.maxRpm;
    tel.airborne = !grounded;
    tel.grounded = grounded;
    tel.landed = this.landed;
    tel.assist = this.assist;
    tel.engineOn = this.engineOn;
    tel.inWater = wet;
    tel.submerged = sub;
    tel.onWater = wet;
    tel.groundEffect = ge;
    tel.rotorBroken = this.rotorBroken;
    tel.gear = 0;
    this.endStep(dt);
  }

  checkRotorStrike() {
    const spec = this.spec, S = this.S;
    const R = spec.rotor.radius * 0.96;
    const env = this.env;
    const t = env.time();
    const hub = this._p, d = this._d;
    for (const h of spec.rotor.hubs) {
      this.toWorld(hub, h[0], h[1], h[2]);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + this.rotorPhase;
        const c = Math.cos(a), s = Math.sin(a);
        set(d, S.right.x * c + S.fwd.x * s, S.right.y * c + S.fwd.y * s, S.right.z * c + S.fwd.z * s);
        const rx = hub.x + d.x * R, ry = hub.y + d.y * R, rz = hub.z + d.z * R;
        const th = env.heightAt(rx, rz);
        const wh = env.waterHeight(rx, rz, t, th);
        let kind = null;
        if (ry < th - 0.05) kind = 'ground';
        else if (ry < wh - 0.05 && th < wh) kind = 'water';
        else {
          const hit = this.cast(hub.x, hub.y, hub.z, d.x, d.y, d.z, R, this.strikeRayGroups);
          if (hit) {
            const mem = (hit.collider.collisionGroups() >>> 16) & 0xffff;
            kind = mem & GROUPS.PROP ? 'prop' : mem & (GROUPS.TRAFFIC | GROUPS.VEHICLE | GROUPS.CHARACTER) ? 'vehicle' : 'solid';
            if (kind === 'prop' || kind === 'vehicle') {
              this.events.push({ type: 'rotorHit', kind, collider: hit.collider, point: { x: hub.x + d.x * hit.toi, y: hub.y + d.y * hit.toi, z: hub.z + d.z * hit.toi } });
              this.rpm *= 0.75;
              this.damage(kind === 'prop' ? 0.12 : 0.2);
              return;
            }
          }
        }
        if (kind) {
          const strength = this.rpm;
          this.rotorBroken = true;
          this.rpm *= 0.25;
          this.events.push({ type: 'rotorStrike', kind, strength, point: { x: rx, y: ry, z: rz } });
          this.damage(0.4 + strength * 0.9);
          return;
        }
      }
    }
  }

  idleTelemetry() {
    const tel = this.telemetry;
    tel.speedKmh = 0; tel.airspeed = 0; tel.verticalSpeed = 0; tel.rotorRpm = 0; tel.rpm = 0; tel.throttle = 0;
    tel.airborne = false; tel.grounded = true;
    this.predVel = null;
  }
}
