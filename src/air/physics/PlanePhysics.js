// Fixed-wing flight model: lift ∝ v²·Cl(α) with stall and flat-plate post-stall, induced/parasitic drag,
// prop/jet thrust with spool, stability + control moments scaled by dynamic pressure (prop wash at low speed),
// assists (auto-trim with bank compensation, g-limit, turn coordination, gentle wing leveling),
// raycast landing gear (suspension, brakes, nose/tail-wheel steering, retraction), floats for seaplanes. DOM-free.
import { Craft } from './Craft.js';
import { G, RHO, clamp, approach, smoothstep, lerp, v3, set, dot, normalize, cross } from './math.js';

export class PlanePhysics extends Craft {
  constructor(o) {
    super(o);
    const spec = this.spec;
    this.throttle = 0;
    this.thrAct = 0;
    this.flaps = 0;
    this.flapsTarget = 0;
    this.gearDown = true;
    this.gearPos = 1;
    this.autoTrim = spec.wing.alphaTrim;
    this.stallRoll = 0;
    this.stalled = false;
    this.assist = true;
    this.onGround = false;
    this.flood = 0;
    this.brake = 0;
    this.steerAngle = 0;
    this.propPhase = 0;
    this.wheels = (spec.wheels || []).map((w) => ({
      ...w, comp: 0, prevComp: 0, contact: false, load: 0, dist: w.travel, prevDist: w.travel, spin: 0, prevSpin: 0, omega: 0,
      mountW: v3(), point: v3(), normal: v3(0, 1, 0),
    }));
    this.input = { pitch: 0, roll: 0, yaw: 0 };
    this.aero = { alpha: 0, beta: 0, cl: 0, q: 0 };
    this._f = v3(); this._s = v3(); this._n = v3(); this._lift = v3(); this._vh = v3();
    this.reset(o.position, o.yaw, o.state);
  }

  onReset(state = {}) {
    const air = !!state.air;
    this.throttle = this.thrAct = air ? (state.throttle ?? 0.72) : 0;
    this.gearDown = !air || !this.spec.retract;
    this.gearPos = this.gearDown ? 1 : 0;
    this.flaps = this.flapsTarget = 0;
    this.flood = 0;
    this.floatWet = false;
    this.autoTrim = this.spec.wing.alphaTrim;
    this.stallRoll = 0;
    if (this.wheels) for (const w of this.wheels) { w.comp = w.prevComp = 0; w.contact = false; w.dist = w.prevDist = w.travel; w.omega = 0; }
  }

  onRepair() { this.flood = 0; }

  setFlaps(target) { this.flapsTarget = clamp(target, 0, 1); }

  toggleGear() {
    if (!this.spec.retract) return false;
    if (this.gearDown && this.onGround) return false; // weight on wheels
    this.gearDown = !this.gearDown;
    return true;
  }

  /** Cl(α) including flaps, stall break and flat-plate post-stall behaviour. */
  cl(alpha) {
    const w = this.spec.wing;
    const fl = this.flaps;
    const aS = w.aStall - 0.035 * fl;
    const cl0 = w.cl0 + w.dClFlap * fl;
    const flat = 1.05 * Math.sin(2 * alpha);
    if (alpha > aS) return Math.max(flat, cl0 + w.clA * aS - (alpha - aS) * w.clA * 1.1);
    const aN = -w.aStall * 0.85;
    if (alpha < aN) return Math.min(flat, cl0 + w.clA * aN - (alpha - aN) * w.clA * 1.1);
    return cl0 + w.clA * alpha;
  }

  /**
   * ctl: { active, throttleRate -1..1, pitch -1..1 (+ = nose up / pull), roll -1..1 (+ = right), yaw -1..1 (+ = right),
   *        brake 0..1, assist }
   */
  fixedUpdate(dt, ctl) {
    if (this.disposed || this.parked) return;
    const spec = this.spec, S = this.S, tel = this.telemetry, body = this.body;
    const active = !!ctl.active;
    if (body.isSleeping() && !active) { this.idleTelemetry(); return; }
    this.beginStep(dt);
    if (this.updateHold(dt, spec.restHeight + 0.6)) { this.baseTelemetry(dt); this.endStep(dt); return; }
    this.assist = ctl.assist !== false;
    const m = spec.mass, W = spec.wing;
    const lin = S.lin, ang = S.ang, up = S.up, fwd = S.fwd, right = S.right;
    const v = Math.hypot(lin.x, lin.y, lin.z);

    // ---- inputs ----
    const inp = this.input;
    const k = 1 - Math.exp(-dt * 8);
    inp.pitch += ((active ? ctl.pitch : 0) - inp.pitch) * k;
    inp.roll += ((active ? ctl.roll : 0) - inp.roll) * k;
    inp.yaw += ((active ? ctl.yaw : 0) - inp.yaw) * k;
    if (active) this.throttle = clamp(this.throttle + (ctl.throttleRate || 0) * dt * 0.55, 0, 1);
    else this.throttle = 0;
    this.brake = active ? clamp(ctl.brake || 0, 0, 1) : 1;
    const engineOk = !this.destroyed && this.flood < 0.4;
    const spool = spec.engine.type === 'jet' ? 2.2 : 0.6;
    this.thrAct = approach(this.thrAct, engineOk ? this.throttle : 0, dt / spool);
    this.flaps = approach(this.flaps, this.flapsTarget, dt * 0.45);
    this.gearPos = approach(this.gearPos, this.gearDown ? 1 : 0, dt / (spec.gearTime || 3));

    // ---- surroundings ----
    const env = this.env;
    const t = env.time();
    const th = env.heightAt(S.com.x, S.com.z);
    const wh = env.waterHeight(S.com.x, S.com.z, t, th);
    const gy = this.groundHeight(S.com.x, S.com.y + 0.3, S.com.z, 800);
    const overWater = th < wh - 0.3 && gy < wh;
    const surf = overWater ? wh : gy;
    this.groundY = surf;
    this.agl = S.pos.y - spec.restHeight - surf;

    // ---- landing gear ----
    const steerIn = clamp(inp.yaw + inp.roll * (1 - smoothstep(6, 28, v)), -1, 1);
    this.steerAngle = steerIn * spec.steerMax * (1 - 0.8 * smoothstep(4, 32, v));
    const contacts = this.wheels.length ? this.updateWheels(dt) : 0;
    this.onGround = contacts > 0;

    // ---- aerodynamics ----
    const vh = this._vh;
    let alpha = 0, beta = 0, q = 0, Cl = 0;
    const u = dot(lin, fwd), wv = dot(lin, up), sv = dot(lin, right);
    const pitchAtt = Math.asin(clamp(fwd.y, -1, 1));
    if (v > 0.5) {
      alpha = Math.atan2(-wv, u);
      beta = Math.asin(clamp(sv / v, -1, 1));
      q = 0.5 * RHO * v * v;
      set(vh, lin.x / v, lin.y / v, lin.z / v);
      Cl = this.cl(alpha);
      // ground effect: more lift, less induced drag in the flare
      const hW = Math.max(0, this.agl + spec.restHeight * 0.5);
      const geK = hW < W.span * 0.5 ? 1 - hW / (W.span * 0.5) : 0;
      const ClGe = Cl * (1 + 0.12 * geK);
      const sa = Math.sin(alpha);
      const Cd = spec.cd0 + W.k * Cl * Cl * (1 - 0.4 * geK) + W.cdFlap * this.flaps + spec.cdGear * this.gearPos + 1.15 * sa * sa;
      const L = q * W.area * ClGe;
      const Dr = q * W.area * Cd;
      const lift = this._lift;
      const uv = dot(up, vh);
      set(lift, up.x - vh.x * uv, up.y - vh.y * uv, up.z - vh.z * uv);
      const ll = Math.hypot(lift.x, lift.y, lift.z);
      const Fs = -q * spec.sideArea * 0.9 * Math.sin(beta);
      let fx = -vh.x * Dr + right.x * Fs, fy = -vh.y * Dr + right.y * Fs, fz = -vh.z * Dr + right.z * Fs;
      if (ll > 1e-3) { fx += (lift.x / ll) * L; fy += (lift.y / ll) * L; fz += (lift.z / ll) * L; }
      this.impulse(fx, fy, fz, dt);
    }
    const aS = W.aStall - 0.035 * this.flaps;
    this.stalled = !this.onGround && v > 8 && Math.abs(alpha) > aS;
    this.aero.alpha = alpha; this.aero.beta = beta; this.aero.q = q; this.aero.cl = Cl;

    // ---- thrust ----
    const vr = v / spec.vTop;
    const thrustShape = spec.engine.type === 'jet' ? 1 - 0.12 * vr : Math.max(0.05, 1 - 0.62 * vr);
    const T = this.thrAct * spec.engine.thrust * thrustShape;
    this.impulse(fwd.x * T, fwd.y * T, fwd.z * T, dt);
    this.propPhase = (this.propPhase + (0.15 + this.thrAct * 0.85) * (engineOk ? 1 : Math.min(1, v / 40)) * 40 * dt) % (Math.PI * 2);

    // ---- moments ----
    const C = spec.ctl;
    const qn = q / spec.qRef;
    const qs = Math.min(qn, 4);
    const sq = Math.sqrt(qs);
    const qc = qs + (spec.engine.type === 'prop' ? C.propWash * this.thrAct : 0);
    const wx = dot(ang, right), wp = dot(ang, fwd), wr = -dot(ang, up);
    const bank = Math.atan2(-right.y, up.y);
    const aUse = lerp(pitchAtt, alpha, smoothstep(2, 9, v));
    const ClA = W.clA;
    const cl0f = W.cl0 + W.dClFlap * this.flaps;
    const surface = this.onGround || this.floatWet; // wheels or floats carry the airframe
    if (this.assist) {
      if (surface) { if (Math.abs(inp.pitch) < 0.06) this.autoTrim = approach(this.autoTrim, clamp(aUse, -0.1, aS - 0.08), dt * 1.5); }
      else if (Math.abs(inp.pitch) < 0.06 && q > 1) {
        // straight flight path: lift = weight·cos(γ), more lift in a banked turn
        const cosG = Math.sqrt(Math.max(0, 1 - (lin.y / Math.max(v, 1)) ** 2));
        const n = cosG * (Math.abs(bank) < 1.35 ? Math.min(2, 1 / Math.max(0.5, Math.cos(bank))) : 1);
        const aReq = (n * m * G / (q * W.area) - cl0f) / ClA;
        this.autoTrim = approach(this.autoTrim, clamp(aReq, -0.12, aS - 0.045), dt * 0.5);
      }
    }
    const aTrim = this.assist ? this.autoTrim : W.alphaTrim;
    // the gear pins α on the ground: give the elevator the extra authority needed to rotate near take-off speed
    const rotK = surface ? 1 + (this.floatWet ? 4 : 2.5) * smoothstep(0.55 * spec.vStallFlaps, spec.vStallFlaps, v) : 1;
    let aPitch;
    if (this.assist) {
      const dAmax = Math.min(C.dAlphaMax, ((spec.nMax - 1) * m * G) / (Math.max(q, 1) * W.area * ClA));
      // α command with g-limit and stall protection
      const aCmd = Math.min(aS - 0.015, aTrim + inp.pitch * (inp.pitch > 0 ? Math.max(0.05, dAmax) : Math.min(0.2, Math.max(0.06, dAmax * 1.4))));
      aPitch = qc * C.pitchStab * (aCmd - aUse) * rotK - (C.pitchDamp * sq + 0.8) * wx;
    } else {
      aPitch = qc * C.pitchStab * C.dAlphaMax * inp.pitch * rotK - qs * C.pitchStab * (aUse - aTrim) - (C.pitchDamp * sq + 0.8) * wx;
    }
    let aRoll = qc * C.rollAuth * inp.roll - (C.rollDamp * sq + 0.6) * wp;
    if (this.assist && !this.onGround && Math.abs(inp.roll) < 0.05 && Math.abs(bank) < 1.2) aRoll += qc * C.rollAuth * clamp(-bank * C.level, -0.35, 0.35);
    let aYaw = qc * C.yawAuth * inp.yaw + qs * C.yawStab * beta * (this.assist ? 1.5 : 1) - (C.yawDamp * sq + 0.6) * wr;
    if (this.assist && !this.onGround && v > 20) aYaw += Math.min(qs, 1) * 2.2 * ((G * Math.sin(bank)) / v - wr);
    // stall: buffet + wing drop
    if (this.stalled) {
      if (!this.stallRoll) this.stallRoll = Math.random() < 0.5 ? -1 : 1;
      const depth = clamp((Math.abs(alpha) - aS) / 0.15, 0, 1);
      aRoll += this.stallRoll * depth * qs * C.wingDrop;
      aPitch += (Math.random() - 0.5) * depth * 1.2;
    } else this.stallRoll = 0;
    // on the ground: no aerodynamic yaw-into-turn, wheels steer
    this.bodyAccel(aPitch, aYaw, aRoll, dt);

    // ---- water: floats (seaplane) or ditching ----
    const fl = spec.float;
    let sub = 0;
    if (fl) {
      const plane = smoothstep(fl.planeV0, fl.planeV1, u);
      const kB = (m * G / fl.points.length / fl.depth) * (1 - this.flood);
      sub = this.floatPoints(fl.points, dt, {
        k: kB, c: (m / fl.points.length) * 3.2, maxDepth: fl.depth * 2.2,
        dragF: fl.dragF * (1 - 0.8 * plane), dragS: fl.dragS, linS: fl.linS || 0, dragV: fl.dragV || 0,
      });
      const wet = sub > 0.01;
      this.floatWet = wet && !!fl.seaplane;
      if (wet && fl.rudder) {
        const ay = steerIn * fl.rudder * clamp(u / 6, -1, 1) + steerIn * fl.rudder * 0.6 * this.thrAct;
        this.bodyAccel(0, ay - wr * 1.2, 0, dt);
      }
      if (wet && !fl.seaplane) this.flood = Math.min(1, this.flood + dt / spec.floodTime);
      this.waterEntry(wet);
      if (wet && !fl.seaplane && this.wetPrev && !this._ditched) {
        this._ditched = true;
        if (v > 12) this.damage(clamp((v - 12) / 45, 0.1, 1));
      }
      if (!wet) this._ditched = false;
      if (wet && fl.seaplane && Math.abs(lin.y) > 7) this.damage(dt * 3);
    }
    this.updateDrowning(dt, fl?.seaplane ? 4 : 3);

    // ---- telemetry ----
    this.baseTelemetry(dt);
    tel.airspeed = v * 3.6;
    tel.airspeedKmh = tel.airspeed;
    tel.throttle = this.throttle;
    if (spec.engine.type === 'jet') { tel.rpm = 22 + 78 * this.thrAct; tel.maxRpm = 100; }
    else { tel.rpm = engineOk ? 650 + (spec.maxRpm - 650) * Math.min(1, this.thrAct + v / spec.vTop * 0.25) : v * 12; tel.maxRpm = spec.maxRpm; }
    tel.aoa = (alpha * 180) / Math.PI;
    tel.stall = this.stalled;
    tel.flaps = this.flaps;
    tel.flapsTarget = this.flapsTarget;
    tel.gearDown = this.gearDown;
    tel.gearPos = this.gearPos;
    tel.brake = this.brake;
    tel.braking = this.brake > 0.1 && this.onGround;
    tel.onGround = this.onGround;
    tel.landed = this.onGround || sub > 0.01;
    tel.airborne = !this.onGround && sub < 0.01;
    tel.assist = this.assist;
    tel.engineOn = engineOk && active;
    tel.inWater = sub > 0.01;
    tel.onWater = sub > 0.01;
    tel.submerged = sub;
    tel.gear = 0;
    this.endStep(dt);
  }

  updateWheels(dt) {
    const S = this.S, spec = this.spec, env = this.env;
    const up = S.up;
    let total = 0, contacts = 0;
    for (const w of this.wheels) {
      w.prevDist = w.dist;
      w.prevSpin = w.spin;
      w.contact = false;
      const deployed = !w.retract || this.gearPos > 0.97;
      const L = w.travel + w.radius;
      if (!deployed) { w.comp = w.prevComp = 0; continue; }
      const o = this.toWorld(w.mountW, w.x, w.y, w.z);
      const hit = this.cast(o.x, o.y, o.z, -up.x, -up.y, -up.z, L + 0.1);
      let d = Infinity;
      if (hit) { d = hit.toi; set(w.normal, hit.normal.x, hit.normal.y, hit.normal.z); }
      else if (up.y > 0.5) {
        const th = env.heightAt(o.x, o.z); // streaming lag fallback
        const dd = (o.y - th) / up.y;
        if (dd < L && dd > -0.5) { d = Math.max(0, dd); set(w.normal, 0, 1, 0); }
      }
      if (d > L) {
        w.dist = approach(w.dist, w.travel, dt * 3);
        w.comp = w.prevComp = 0;
        w.spin += w.omega * dt;
        w.omega *= 0.995;
        continue;
      }
      const comp = L - d;
      const cv = (comp - w.prevComp) / dt;
      w.prevComp = comp;
      w.comp = comp;
      let F = w.k * comp + w.c * cv;
      if (comp > w.travel) F += w.k * 6 * (comp - w.travel); // bump stop
      F = clamp(F, 0, spec.mass * G * 6);
      w.load = F;
      w.contact = true;
      w.dist = Math.max(0, d - w.radius);
      set(w.point, o.x - up.x * d, o.y - up.y * d, o.z - up.z * d);
      total += F;
      contacts++;
    }
    if (!contacts) return 0;
    if (total < 1) return contacts;
    const f = this._f, s = this._s, vp = S.vp;
    for (const w of this.wheels) {
      if (!w.contact) continue;
      const F = w.load;
      const n = w.normal;
      // strut force along the contact normal (no spurious push when the airframe is pitched)
      this.impulse(n.x * F, n.y * F, n.z * F, dt, w.point);
      const st = w.steer ? this.steerAngle * (w.steer < 0 ? -1 : 1) : 0;
      const cs = Math.cos(st), sn = Math.sin(st);
      set(f, S.fwd.x * cs + S.right.x * sn, S.fwd.y * cs + S.right.y * sn, S.fwd.z * cs + S.right.z * sn);
      const fn = dot(f, n);
      f.x -= n.x * fn; f.y -= n.y * fn; f.z -= n.z * fn;
      normalize(f);
      cross(s, f, n);
      this.pointVel(vp, w.point);
      const vL = dot(vp, f), vS = dot(vp, s);
      const surf = env.surface ? env.surface(w.point.x, w.point.z) : null;
      const grip = surf ? surf.grip : 1;
      const mEff = spec.mass * (F / total) * 0.85;
      const maxLat = spec.tireMu * grip * F * dt;
      const jS = clamp(-vS * mEff, -maxLat, maxLat);
      const rr = (spec.rolling + (surf ? surf.rolling : 0)) * F + (w.brake ? this.brake * spec.brakeMu * grip * F : 0);
      const jL = clamp(-vL * mEff, -rr * dt, rr * dt);
      const J = S.F;
      set(J, f.x * jL + s.x * jS, f.y * jL + s.y * jS, f.z * jL + s.z * jS);
      this.body.applyImpulseAtPoint(J, w.point, true);
      this.linImp.x += J.x; this.linImp.y += J.y; this.linImp.z += J.z;
      w.omega = vL / w.radius;
      w.spin += w.omega * dt;
      w.slip = Math.abs(vS) > 3 || (w.brake && this.brake > 0.5 && Math.abs(vL) > 4);
    }
    return contacts;
  }

  idleTelemetry() {
    const tel = this.telemetry;
    tel.speedKmh = 0; tel.airspeed = 0; tel.verticalSpeed = 0; tel.throttle = 0; tel.rpm = 0;
    tel.airborne = false; tel.onGround = true;
    this.predVel = null;
  }
}
