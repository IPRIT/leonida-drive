// Raycast-wheel vehicle physics on top of a Rapier rigid body.
// No THREE / DOM dependencies: runs in Node (see ../tune.mjs).

import { GROUPS, groups, WHEEL_RAY_MASK } from '../groups.js';
import { resolvePreset } from '../presets.js';
import { Drivetrain, RPM_TO_RAD } from './Drivetrain.js';

const G = 9.81;
const RHO = 1.225;
const V_MIN_SLIP = 2.0; // slip-ratio denominator floor (m/s)
const STATIC_LO = 0.8; // below: pure static-friction model
const STATIC_HI = 3.5; // above: pure slip-based tire model
const STATIC_GAIN = 0.7;
const DROOP_PROBE = 0.14; // extra ray length beyond full droop
const TIRE_DROP = 0.6; // m/s: wheel extension rate when the ground drops away
// arcade assist on top of the per-model tyres: a bit more peak grip and a gentler slide past the peak
const GRIP = 1.08;
const YAW_DAMP = 2.5; // 1/s, sideslip-rate damping at speed (cars)
// keyboard yaw-rate steering (cars): blend-in speed range m/s, full-key share of the grip, PI gains, yaw-target
// low-pass time constants (s) into a turn / back towards straight
export const KB_STEER = { v0: 5, v1: 12, g: 0.95, kp: 0.8, ki: 3.0, tauIn: 0.15, tauOut: 0.06 };
const AUTO_HOLD = 0.6; // max brake share of the no-pedal stop between 0.6 and 1.5 m/s (steep downhills); full hold below
const SLIDE_KEEP = 0.8; // 1 = model falloff, <1 keeps more lateral grip while sliding
const TIRE_RISE = 1.0; // m/s: how fast a terrain step can push the wheel up (tire + bushing compliance)
const MAX_ANGVEL = 16;
const MAX_LINVEL = 140;

export const DEFAULT_SURFACE = Object.freeze({ name: 'asphalt', grip: 1, rolling: 0, dust: false });
const LOOSE = { dirt: true, grass: true, sand: true };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---- tiny vector helpers on plain {x,y,z} ----
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const set = (o, x, y, z) => ((o.x = x), (o.y = y), (o.z = z), o);
const copy = (o, a) => ((o.x = a.x), (o.y = a.y), (o.z = a.z), o);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
function cross(o, a, b) {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}
function normalize(o) {
  const l = Math.hypot(o.x, o.y, o.z);
  if (l > 1e-9) {
    o.x /= l;
    o.y /= l;
    o.z /= l;
  }
  return o;
}
function rotate(o, q, v) {
  const vx = v.x, vy = v.y, vz = v.z;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  o.x = vx + qw * tx + qy * tz - qz * ty;
  o.y = vy + qw * ty + qz * tx - qx * tz;
  o.z = vz + qw * tz + qx * ty - qy * tx;
  return o;
}

// Simplified magic formula on normalized combined slip.
// s = 1 at peak; C controls post-peak falloff (sliding = sin(C*pi/2) of peak).
function curve(s, C) {
  const B = Math.tan(Math.PI / (2 * C));
  return Math.sin(C * Math.atan(B * s));
}
const _tire = { fx: 0, fy: 0, s: 0 };
function tireCombined(kappa, alpha, kPeak, aPeak, Clong, Clat) {
  const sx = kappa / kPeak;
  const sy = alpha / aPeak;
  const s = Math.hypot(sx, sy);
  _tire.s = s;
  if (s < 1e-9) {
    _tire.fx = 0;
    _tire.fy = 0;
    return _tire;
  }
  const wx = (sx * sx) / (s * s);
  const f = curve(s, Clat + (Clong - Clat) * wx);
  _tire.fx = (f * sx) / s;
  _tire.fy = (-f * sy) / s;
  return _tire;
}

/** Derive all numeric parameters from a preset. */
export function deriveSpec(presetIn) {
  const p = resolvePreset(presetIn);
  const m = p.mass;
  const r = p.wheelRadius;
  const L = p.wheelbase;
  const wf = p.weightFront;
  const spec = JSON.parse(JSON.stringify(p));
  spec.zFront = -L / 2;
  spec.zRear = L / 2;
  spec.com = { x: 0, y: p.cgHeight - r, z: L / 2 - wf * L };
  const sz = p.size;
  const lx = sz.length * 0.92, wx = sz.width * 0.92, hx = sz.height * 0.85;
  const isc = p.inertiaScale;
  spec.inertia = {
    x: (m / 12) * (hx * hx + lx * lx) * isc.pitch,
    y: (m / 12) * (wx * wx + lx * lx) * isc.yaw,
    z: (m / 12) * (wx * wx + hx * hx) * isc.roll,
  };
  // suspension per axle
  const s = p.suspension;
  const perAxle = p.wheelLayout === 'bike' ? 1 : 2;
  spec.axles = [0, 1].map((ai) => {
    const cornerMass = (m * (ai === 0 ? wf : 1 - wf)) / perAxle;
    const w = 2 * Math.PI * s.freq[ai];
    const k = cornerMass * w * w;
    const staticComp = G / (w * w);
    const crit = 2 * Math.sqrt(k * cornerMass);
    return {
      cornerMass,
      k,
      cBump: s.bump * crit,
      cRebound: s.rebound * crit,
      staticComp,
      mountY: s.travel - staticComp,
      arbK: s.arb[ai] * k,
      rollCenter: s.rollCenter[ai],
      track: p.track[ai],
      z: ai === 0 ? spec.zFront : spec.zRear,
      grip: p.tire.grip[ai],
      falloffLat: p.tire.falloffLat[ai],
      stiffness: p.tire.stiffness[ai],
      tireWidth: p.tireWidth[ai],
    };
  });
  spec.restHeight = r; // body origin above ground at rest
  // brakes
  const brakeTotal = p.brakes.decelG * m * G * r;
  spec.brakeTorque = [(brakeTotal * p.brakes.bias) / perAxle, (brakeTotal * (1 - p.brakes.bias)) / perAxle];
  // wheel inertia
  spec.wheelInertia = [0, 1].map((ai) => 1.15 * (r / 0.33) ** 2 * (p.tireWidth[ai] / 0.24));
  // gearing: top gear reaches redline at 1.04 * topSpeed
  const gb = spec.gearbox;
  const vTop = gb.topSpeedKmh / 3.6;
  const gTop = gb.gears[gb.gears.length - 1];
  if (!gb.finalDrive) gb.finalDrive = (p.engine.redline * RPM_TO_RAD * r) / (vTop * 1.04 * gTop);
  spec.vTop = vTop;
  // drag area so that available power balances drag at vTop
  if (!spec.aero.cda) {
    const rpm = ((vTop / r) * gTop * gb.finalDrive) / RPM_TO_RAD;
    const dtr = new Drivetrain(spec);
    const T = dtr.torqueAt(rpm);
    const P = T * rpm * RPM_TO_RAD * gb.efficiency;
    const down = 0.5 * RHO * spec.aero.cla * vTop * vTop;
    const Froll = p.tire.rolling * (m * G + down);
    spec.aero.cda = Math.max(0.3, (2 * ((P / vTop) * 0.975 - Froll)) / (RHO * vTop * vTop));
  }
  spec.driven = p.drive === 'AWD' ? [true, true] : p.drive === 'FWD' ? [true, false] : [false, true];
  spec.twoWheel = p.wheelLayout === 'bike';
  // effective mass seen by a horizontal push at the tyre line (pitch coupling): keeps the low-speed
  // static-friction solver from over-correcting on light, tall vehicles (bicycles)
  {
    const h = spec.com.y + r - s.antiPitch * p.cgHeight;
    const mEff = 1 / (1 / m + (h * h) / spec.inertia.x);
    spec.staticScale = clamp(mEff / m, 0.2, 1);
  }
  spec.rollAssist = p.rollAssist ?? 0.35;
  if (spec.twoWheel) {
    const b = p.bike || {};
    spec.bike = {
      maxLean: ((b.maxLeanDeg ?? 45) * Math.PI) / 180,
      leanRate: b.leanRate ?? 3.2,
      wheelie: !!b.wheelie,
      kickstand: ((b.kickstand ?? 12) * Math.PI) / 180,
      fallDv: b.fallDv ?? 7.5,
    };
    // cornering g at full lean (arcade): sport bikes ≈ 1.05 g, cruisers ≈ 0.85, bicycles ≈ 0.7
    spec.bike.pedal = p.kind === 'bicycle';
    spec.bike.gripG = b.gripG ?? (spec.bike.pedal ? clamp(Math.tan(spec.bike.maxLean), 0.55, 0.72) : clamp(Math.tan(spec.bike.maxLean) + 0.3, 0.82, 1.05));
  }
  return spec;
}

export class VehiclePhysics {
  /**
   * @param {object} o { RAPIER, world, preset, position, yaw, env, quality:'high'|'low' }
   */
  constructor(o) {
    const { RAPIER, world } = o;
    this.RAPIER = RAPIER;
    this.world = world;
    this.env = o.env || null;
    this.spec = deriveSpec(o.preset || 'comet');
    this.presetName = this.spec.name;
    this.assists = { ...this.spec.assists };
    this.drowned = false;
    this.quality = o.quality || 'high';
    this.drivetrain = new Drivetrain(this.spec);
    this.disposed = false;

    const spec = this.spec;
    const r = spec.wheelRadius;

    // ---- rigid body ----
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setCcdEnabled(true)
      .setLinearDamping(0.0)
      .setAngularDamping(0.25)
      .setAdditionalMassProperties(spec.mass, spec.com, spec.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = world.createRigidBody(desc);
    this.body.userData = { type: 'vehicle', vehicle: this };

    const cg = groups(GROUPS.VEHICLE, GROUPS.ALL);
    const c = spec.collider;
    const sz = spec.size;
    const br = 0.08;
    const width = Math.max(sz.width, spec.track[0] + spec.tireWidth[0], spec.track[1] + spec.tireWidth[1]);
    // lower body: convex hull with approach/departure ramps so curbs push the nose up instead of stopping it
    const hw = width / 2 - br;
    const zf = -sz.length / 2 + br, zr = sz.length / 2 - br;
    const yb = Math.max(c.clearance, 0.19) + br - r, yt = c.belt - br - r;
    const rise = Math.min(0.2, (c.belt - c.clearance) * 0.35);
    const prof = [
      [zf, yb + rise], [spec.zFront - 0.1, yb], [spec.zRear + 0.1, yb], [zr, yb + rise * 0.8],
      [zr, yt - 0.08], [zr - 0.35, yt], [zf + 0.45, yt], [zf, yt - 0.12],
    ];
    const pts = new Float32Array(prof.length * 6);
    prof.forEach(([z, y], i) => {
      pts.set([-hw, y, z, hw, y, z], i * 6);
    });
    const lowDesc = (RAPIER.ColliderDesc.roundConvexHull(pts, br) || RAPIER.ColliderDesc.roundCuboid(hw, (yt - yb) / 2, zr, br).setTranslation(0, (yt + yb) / 2, 0))
      .setDensity(0)
      .setFriction(0.3)
      .setRestitution(0.12)
      .setCollisionGroups(cg);
    const cab = c.cabin;
    const cabH = (cab.top - c.belt) / 2 + 0.04;
    const cabDesc = RAPIER.ColliderDesc.roundCuboid(cab.width / 2 - br, cabH - br, (cab.z1 - cab.z0) / 2 - br, br)
      .setTranslation(0, c.belt - 0.04 + cabH - r, (cab.z0 + cab.z1) / 2)
      .setDensity(0)
      .setFriction(0.3)
      .setRestitution(0.1)
      .setCollisionGroups(cg);
    this.colliders = [world.createCollider(lowDesc, this.body), world.createCollider(cabDesc, this.body)];

    this.rayGroups = groups(GROUPS.ALL, WHEEL_RAY_MASK);
    this.ray = new RAPIER.Ray(v3(), v3(0, -1, 0));
    this.rayFlags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;

    // ---- wheels: FL, FR, RL, RR (two-wheelers: F, R on the centreline) ----
    this.wheels = [];
    const nW = spec.twoWheel ? 2 : 4;
    for (let i = 0; i < nW; i++) {
      const ai = spec.twoWheel ? i : i < 2 ? 0 : 1;
      const ax = spec.axles[ai];
      const left = spec.twoWheel ? false : i % 2 === 0;
      this.wheels.push({
        index: i,
        axle: ai,
        front: ai === 0,
        left,
        x: spec.twoWheel ? 0 : (left ? -1 : 1) * (ax.track / 2),
        z: ax.z,
        mountY: ax.mountY,
        radius: r,
        width: ax.tireWidth,
        driven: spec.driven[ai],
        inertia: spec.wheelInertia[ai],
        // state
        steer: 0,
        omega: 0,
        spin: 0,
        contact: false,
        comp: 0,
        prevComp: 0,
        dist: spec.suspension.travel - ax.staticComp, // wheel center distance below mount
        load: 0,
        susForce: 0,
        slipRatio: 0,
        slipAngle: 0,
        slipSpeed: 0,
        latSlipSpeed: 0,
        longSlipSpeed: 0,
        skid: 0,
        surface: DEFAULT_SURFACE,
        point: v3(),
        normal: v3(0, 1, 0),
        fwd: v3(0, 0, -1),
        side: v3(1, 0, 0),
        groundBody: null,
        inWater: false,
        fx: 0,
        fy: 0,
        anchor: v3(),
        anchorSet: false,
        driveTorque: 0,
        brakeTorque: 0,
      });
    }
    this.axleWheels = [this.wheels.filter((w) => w.axle === 0), this.wheels.filter((w) => w.axle === 1)];
    // two-wheeler state
    this.lean = 0; // intended lean (drives the steering), rad, + = right
    this.leanVel = 0;
    this.leanVisual = 0; // lean shown by the model
    this.wheelie = 0;
    this.fallen = false;
    this.fallTimer = 0;
    this.autoRecover = true;
    this.driverPresent = true;

    this.telemetry = {
      preset: this.presetName,
      kind: spec.kind || 'car',
      speedKmh: 0,
      forwardSpeed: 0,
      rpm: spec.engine.idle,
      maxRpm: spec.engine.redline,
      idleRpm: spec.engine.idle,
      gear: 1,
      throttle: 0,
      brake: 0,
      engineLoad: 0,
      shifting: false,
      shiftId: 0,
      wheels: this.wheels.map(() => ({ contact: false, slipRatio: 0, slipAngle: 0, load: 0, surface: 'asphalt', skid: 0, compression: 0 })),
      drifting: false,
      airborne: false,
      boost: 1,
      boosting: false,
      slipAngle: 0,
      latAccel: 0,
      longAccel: 0,
      yawRate: 0,
      maxSkid: 0,
      handbrake: false,
      braking: false,
      reversing: false,
      inWater: false,
      submerged: 0,
      upsideDown: false,
      impactId: 0,
      impactStrength: 0,
      limiter: false,
      lean: 0,
      wheelie: 0,
      fallen: false,
    };

    // runtime state
    this.steerAngle = 0;
    this.boostLevel = 1;
    this.boostCooldown = 0;
    this.boosting = false;
    this.airTime = 0;
    this.driftTimer = 0;
    this.reverseTimer = 0;
    this.upsideTimer = 0;
    this.hold = false;
    this.axleLat = [0, 0];
    this.totalLong = 0;
    this.lastVel = v3();
    this.predVel = null;
    this.prevPos = v3();
    this.prevRot = { x: 0, y: 0, z: 0, w: 1 };
    this.accel = v3();
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };

    // scratch
    this._s = {
      pos: v3(), rot: { x: 0, y: 0, z: 0, w: 1 }, lin: v3(), ang: v3(), com: v3(),
      right: v3(), up: v3(), fwd: v3(), tmp: v3(), tmp2: v3(), tmp3: v3(), mount: v3(), origin: v3(),
      linImp: v3(), angImp: v3(), vp: v3(), F: v3(), rel: v3(), wfLocal: v3(), wf: v3(), ws: v3(),
    };

    this.reset(o.position || v3(), o.yaw || 0);
  }

  get speedKmh() {
    return this.telemetry.speedKmh;
  }

  /** Teleport upright. position = ground point under the car center. */
  reset(position, yaw = 0) {
    const b = this.body;
    const y = (position.y || 0) + this.spec.restHeight + 0.03;
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    b.setTranslation({ x: position.x || 0, y, z: position.z || 0 }, true);
    b.setRotation(q, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.resetForces(true);
    b.resetTorques(true);
    set(this.prevPos, position.x || 0, y, position.z || 0);
    this.prevRot.x = q.x;
    this.prevRot.y = q.y;
    this.prevRot.z = q.z;
    this.prevRot.w = q.w;
    for (const w of this.wheels) {
      w.omega = 0;
      w.contact = false;
      w.comp = w.prevComp = 0;
      w.dist = this.spec.suspension.travel - this.spec.axles[w.axle].staticComp;
      w.skid = 0;
      w.load = 0;
      w.prevDist = w.dist;
      w.prevSpin = w.spin;
      w.prevSteer = w.steer = 0;
      w.anchorSet = false;
    }
    this.drivetrain.reset();
    this.steerAngle = 0;
    this.driverSteer = 0;
    this.assistSteer = 0;
    this.drowned = false;
    this.airTime = 0;
    this.driftTimer = 0;
    this.upsideTimer = 0;
    this.predVel = null;
    set(this.lastVel, 0, 0, 0);
    this.boostLevel = 1;
    this.axleLat[0] = this.axleLat[1] = 0;
    this.totalLong = 0;
    this.lean = this.leanVel = this.leanVisual = this.wheelie = 0;
    this.sinceReset = 0;
    this.fallen = false;
    this.fallTimer = 0;
    this.telemetry.fallen = false;
  }

  _surface(x, z) {
    const env = this.env;
    if (env && typeof env.getSurface === 'function') return env.getSurface(x, z) || DEFAULT_SURFACE;
    return DEFAULT_SURFACE;
  }

  /** One fixed physics step. Call before world.step(). */
  fixedUpdate(dt, input = {}) {
    if (this.disposed) return;
    const spec = this.spec;
    const body = this.body;
    const S = this._s;
    const tel = this.telemetry;

    const inp = this.input;
    inp.throttle = clamp(+input.throttle || 0, 0, 1);
    inp.brake = clamp(+input.brake || 0, 0, 1);
    inp.steer = clamp(+input.steer || 0, -1, 1);
    // keyboard (DriveInput.state.digital): cars steer by yaw-rate target with the untrimmed key ramp (steerKb)
    inp.digital = !!input.digital;
    inp.steerKb = inp.digital && input.steerKb !== undefined ? clamp(+input.steerKb || 0, -1, 1) : inp.steer;
    inp.handbrake = !!input.handbrake;
    inp.boost = !!input.boost;
    this.driverPresent = input.driver !== false;
    this.sinceReset = (this.sinceReset || 0) + dt;
    if (this.fallen) {
      // rider is down: no drive, no steering
      inp.throttle = 0;
      inp.steer = 0;
      inp.boost = false;
      inp.brake = Math.max(inp.brake, 0.3);
    }

    // snapshot for interpolation
    body.resetForces(false);
    body.resetTorques(false);
    const pos = copy(S.pos, body.translation());
    const rot = body.rotation();
    S.rot.x = rot.x; S.rot.y = rot.y; S.rot.z = rot.z; S.rot.w = rot.w;
    copy(this.prevPos, pos);
    Object.assign(this.prevRot, S.rot);
    for (const w of this.wheels) {
      w.prevDist = w.dist;
      w.prevSpin = w.spin;
      w.prevSteer = w.steer;
    }

    const lin = copy(S.lin, body.linvel());
    const ang = copy(S.ang, body.angvel());
    const com = copy(S.com, body.worldCom());
    const q = S.rot;
    const right = rotate(S.right, q, set(S.tmp, 1, 0, 0));
    const up = rotate(S.up, q, set(S.tmp, 0, 1, 0));
    const fwd = rotate(S.fwd, q, set(S.tmp, 0, 0, -1));

    // impact detection (velocity change not explained by our impulses + gravity)
    if (this.predVel) {
      const dvx = lin.x - this.predVel.x, dvy = lin.y - this.predVel.y, dvz = lin.z - this.predVel.z;
      const dv = Math.hypot(dvx, dvy, dvz);
      if (dv > 2.2) {
        tel.impactId++;
        this._ydMute = 0.5;
        tel.impactStrength = clamp((dv - 2.2) / 14, 0.05, 1);
        if (spec.twoWheel && !this.fallen && dv > spec.bike.fallDv && this.sinceReset > 0.5) this._fall(dvx * right.x + dvy * right.y + dvz * right.z);
      }
    }
    // acceleration estimate (for visuals/camera)
    const ax = (lin.x - this.lastVel.x) / dt, ay = (lin.y - this.lastVel.y) / dt, az = (lin.z - this.lastVel.z) / dt;
    this.accel.x = lerp(this.accel.x, ax, 0.2);
    this.accel.y = lerp(this.accel.y, ay, 0.2);
    this.accel.z = lerp(this.accel.z, az, 0.2);
    copy(this.lastVel, lin);

    const vF = dot(lin, fwd);
    const vR = dot(lin, right);
    const speed = Math.hypot(lin.x, lin.y, lin.z);
    const idleInput = inp.throttle < 0.02 && inp.brake < 0.02 && Math.abs(inp.steer) < 0.02 && !inp.handbrake && !inp.boost;

    if (body.isSleeping()) {
      if (idleInput) {
        this.predVel = null;
        this._telemetryIdle();
        return;
      }
      body.wakeUp();
    }

    const dtr = this.drivetrain;
    const env = this.env;
    const waterLevel = env && typeof env.waterLevel === 'number' ? env.waterLevel : -Infinity;

    // ---- water / drowning ----
    const submerged = clamp((waterLevel - (com.y - 0.45)) / 1.1, 0, 1);
    if (com.y < waterLevel - 0.6) this.drowned = true;

    // ---- pedals, reverse logic (GTA style) ----
    const grounded = this.wheels.some((w) => w.contact);
    let throttle = inp.throttle;
    let brake = inp.brake;
    const burnout = inp.throttle > 0.5 && inp.brake > 0.5 && vF < 4 && dtr.gear >= 0;
    if (dtr.gear >= 0) {
      if (!burnout && inp.brake > 0.1 && inp.throttle < 0.1 && vF < 0.8) {
        this.reverseTimer += dt;
        if (this.reverseTimer > 0.2 && vF < 0.35) dtr.select(-1);
      } else this.reverseTimer = 0;
    } else if (inp.throttle > 0.1 && inp.brake < 0.1 && vF > -0.8) {
      dtr.select(1);
    }
    if (dtr.gear < 0 || (dtr.shifting && dtr.shiftTo < 0)) {
      throttle = inp.brake * 0.85;
      brake = inp.throttle;
    }
    if (burnout) brake = 0;
    const handbrake = inp.handbrake;
    this.hold = grounded && throttle < 0.05 && Math.abs(vF) < 0.35 && !burnout && !inp.boost;
    // drift mode: relaxes TCS/ESC. Started by the handbrake (or a power slide in RWD/AWD),
    // kept alive while the car keeps sliding on throttle.
    const betaNow = vF > 0.5 ? Math.atan2(vR, vF) : 0;
    const sliding = grounded && vF > 7 && Math.abs(betaNow) > 0.13;
    if (handbrake && Math.abs(vF) > 5) this.driftTimer = 1.4;
    else if (sliding && throttle > 0.55 && (this.driftTimer > 0 || (spec.drive === 'RWD' && throttle > 0.92 && Math.abs(inp.steer) > 0.5))) this.driftTimer = Math.max(this.driftTimer, 0.7);
    else this.driftTimer = Math.max(0, this.driftTimer - dt);
    const driftMode = this.driftTimer > 0;

    // ---- steering ----
    const st = spec.steering;
    const maxLock = (st.maxLockDeg * Math.PI) / 180;
    const lock = maxLock / (1 + Math.abs(vF) / st.speedRef);
    const beta = vF > 0.5 ? Math.atan2(vR, vF) : 0;
    let assist = 0;
    if (this.assists.steerAssist && vF > 4 && grounded) {
      const b = Math.sign(beta) * Math.max(0, Math.abs(beta) - 0.04);
      assist = b * 1.0 * smoothstep(4, 10, vF);
    }
    const L = spec.wheelbase;
    if (spec.twoWheel) {
      // arcade lean steering: the input sets the lean (quicker at speed, no visible counter-steer); the lean maps
      // directly to a cornering g within the bike's grip, and a yaw controller makes the bike follow it at any speed
      const bk = spec.bike;
      const v = Math.max(0, vF);
      const leanMax = bk.maxLean * smoothstep(1.0, 6.0, v);
      // full lean from 80 % input: keyboard (DriveInput trims key steer at speed) and sticks reach the full corner
      const target = clamp(inp.steer / 0.8, -1, 1) * leanMax;
      const rate = bk.leanRate * (1 + 0.6 * smoothstep(8, 30, v));
      const k = rate * rate * 4;
      this.leanVel += (k * (target - this.lean) - 2 * Math.sqrt(k) * this.leanVel) * dt;
      this.lean = clamp(this.lean + this.leanVel * dt, -bk.maxLean, bk.maxLean);
      const nLean = this.lean / bk.maxLean;
      const vv = Math.max(v, 3);
      // desired yaw rate (about +Y; a right lean turns clockwise = negative)
      this.bikeYawDes = (-nLean * bk.gripG * G) / vv;
      const dLean = Math.atan((L * bk.gripG * G * Math.abs(nLean)) / (vv * vv)) * Math.sign(nLean);
      const dLow = inp.steer * lock;
      const w = smoothstep(2.0, 6.5, v);
      // full lean asks for most of the tyre: soften the throttle at deep lean so a corner exit doesn't run wide
      throttle *= 1 - 0.6 * nLean * nLean * smoothstep(5, 12, v);
      // wheelie control: keep the front tyre loaded under hard acceleration so the bike can still steer
      const fw0 = this.wheels[0];
      const fRatio = fw0.contact ? fw0.load / (spec.axles[0].cornerMass * G) : 0;
      // (only while steering: straight-line launches keep their full power and the visual wheelie)
      if (v > 3 && !bk.pedal) throttle *= lerp(1, clamp((fRatio - 0.08) / 0.3, 0.25, 1), smoothstep(0.02, 0.3, Math.abs(inp.steer)));
      // bar-angle trim (a rider's small corrections): the front tyre gets the slip angle the target g needs.
      // Kinematic units (L / v) and integration only once the lean has settled, so it never winds up.
      const ey = this.bikeYawDes - dot(ang, up);
      const kin = L / Math.max(v, 5);
      if (w > 0 && grounded && !this.fallen && Math.abs(target - this.lean) < 0.08) this.bikeSteerI = clamp((this.bikeSteerI || 0) - ey * kin * dt * 6, -0.04, 0.04);
      else if (w === 0 || this.fallen) this.bikeSteerI = 0;
      this.bikeSteerI = (this.bikeSteerI || 0) * (1 - dt * 0.5);
      const dTrim = (clamp(-ey * kin * 1.2, -0.03, 0.03) + this.bikeSteerI) * w;
      this.driverSteer = approach(this.driverSteer || 0, lerp(dLow, dLean, w) + dTrim, Math.max(lock * st.rate, 0.6) * dt);
      this.assistSteer = approach(this.assistSteer || 0, assist * 0.5, 2.0 * dt);
      this.steerAngle = clamp(this.driverSteer + this.assistSteer, -maxLock, maxLock);
      this.wheels[0].steer = this.steerAngle;
      this.wheels[1].steer = 0;
    } else {
    // driver steering is slewed relative to the current lock (calm at speed); the counter-steer assist is added on top
    let rate = Math.max(lock * st.rate, 0.45);
    let target = inp.steer * lock;
    // keyboard steering assist: at speed a key asks for a yaw rate (full key = KB_STEER.g of the grip, downforce included)
    // instead of a wheel angle; a PI loop on the yaw rate turns it into a steer angle, so a held key sits at the limit
    // without washing out, a released key straightens the car (and counter-steers a slide) at once. Off in drift mode.
    const wd = inp.digital && grounded && !driftMode && !handbrake ? smoothstep(KB_STEER.v0, KB_STEER.v1, vF) : 0;
    if (wd > 0) {
      let grip = 0, n = 0;
      for (const w of this.wheels) if (w.contact) { grip += w.surface?.grip ?? 1; n++; }
      grip = n ? grip / n : 1;
      const aMax = spec.tire.mu * grip * (1 + (0.5 * RHO * spec.aero.cla * vF * vF) / (spec.mass * G)) * G * KB_STEER.g;
      const yawRate = dot(ang, up);
      // the yaw target is low-passed (tap rhythm averages out instead of rocking the car); quicker back to centre
      const rRaw = (-inp.steerKb * aMax) / vF; // + = left (positive steer turns right)
      const rPrev = this.kbYawT ?? yawRate;
      const tau = Math.abs(rRaw) < Math.abs(rPrev) || Math.sign(rRaw) !== Math.sign(rPrev) ? KB_STEER.tauOut : KB_STEER.tauIn;
      const rT = (this.kbYawT = rPrev + (rRaw - rPrev) * Math.min(1, dt / tau));
      const e = rT - yawRate;
      this.kbYawI = clamp((this.kbYawI || 0) + e * dt * KB_STEER.ki, -0.25 * Math.abs(aMax / vF) - 0.05, 0.25 * Math.abs(aMax / vF) + 0.05);
      const rCmd = rT + KB_STEER.kp * e + this.kbYawI;
      // kinematic angle + the front slip angle that lateral g needs
      const dKb = Math.atan((-rCmd * L) / vF) + (((-rT * vF) / aMax) * spec.tire.peakAngleDeg * Math.PI) / 180 * 0.55;
      target = lerp(target, clamp(dKb, -lock * 1.3, lock * 1.3), wd);
      rate = lerp(rate, Math.max(rate, 1.6), wd);
      assist *= 1 - wd;
    } else { this.kbYawI = 0; this.kbYawT = undefined; }
    this.driverSteer = approach(this.driverSteer || 0, target, rate * dt);
    this.assistSteer = approach(this.assistSteer || 0, assist, 2.5 * dt);
    this.steerAngle = clamp(this.driverSteer + this.assistSteer, -maxLock, maxLock);
    const delta = this.steerAngle;
    // Ackermann
    {
      const ad = Math.abs(delta);
      let din = ad, dout = ad;
      if (ad > 1e-4) {
        const R = L / Math.tan(ad);
        const t2 = spec.axles[0].track / 2;
        din = lerp(ad, Math.atan(L / Math.max(R - t2, 0.5)), st.ackermann);
        dout = lerp(ad, Math.atan(L / (R + t2)), st.ackermann);
      }
      const sgn = Math.sign(delta);
      // positive delta = right: right wheel is inner
      this.wheels[0].steer = sgn * (delta > 0 ? dout : din);
      this.wheels[1].steer = sgn * (delta > 0 ? din : dout);
      this.wheels[2].steer = 0;
      this.wheels[3].steer = 0;
    }
    }

    const linImp = set(S.linImp, 0, 0, 0);
    const angImp = set(S.angImp, 0, 0, 0);
    const addImpulse = (F, p) => {
      // F is force (N), p is world point
      linImp.x += F.x * dt; linImp.y += F.y * dt; linImp.z += F.z * dt;
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      angImp.x += (ry * F.z - rz * F.y) * dt;
      angImp.y += (rz * F.x - rx * F.z) * dt;
      angImp.z += (rx * F.y - ry * F.x) * dt;
    };
    const pointVel = (o, p) => {
      const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
      o.x = lin.x + (ang.y * rz - ang.z * ry);
      o.y = lin.y + (ang.z * rx - ang.x * rz);
      o.z = lin.z + (ang.x * ry - ang.y * rx);
      return o;
    };

    // ---- suspension raycasts ----
    const susp = spec.suspension;
    const travel = susp.travel;
    const world = this.world;
    const ray = this.ray;
    set(ray.dir, -up.x, -up.y, -up.z);
    const offs = this.quality === 'low' ? [0] : [0, -0.55, 0.55];
    let contacts = 0;
    for (const w of this.wheels) {
      const mount = rotate(S.mount, q, set(S.tmp, w.x, w.mountY, w.z));
      mount.x += pos.x; mount.y += pos.y; mount.z += pos.z;
      let best = Infinity, bestHit = null, bestOff = 0, bestToi = 0;
      for (let k = 0; k < offs.length; k++) {
        const a = offs[k] * w.radius;
        const drop = Math.sqrt(w.radius * w.radius - a * a);
        set(ray.origin, mount.x + fwd.x * a, mount.y + fwd.y * a, mount.z + fwd.z * a);
        const hit = world.castRayAndGetNormal(ray, travel + drop + DROOP_PROBE, true, this.rayFlags, this.rayGroups, undefined, body);
        if (hit) {
          const d = hit.timeOfImpact - drop;
          if (d < best) {
            best = d;
            bestHit = hit;
            bestOff = a;
            bestToi = hit.timeOfImpact;
          }
        }
      }
      w.prevComp = w.comp;
      const wasContact = w.contact;
      w.contact = false;
      w.groundBody = null;
      if (bestHit) {
        const n = bestHit.normal;
        if (bestToi > 1e-4) set(w.normal, n.x, n.y, n.z);
        else copy(w.normal, up);
        // rays reach a bit past full droop so small step-downs unload the corner progressively
        let comp = travel - best;
        if (dot(w.normal, up) > 0.3 && (comp > 0 || wasContact)) {
          set(w.point, mount.x + fwd.x * bestOff - up.x * bestToi, mount.y + fwd.y * bestOff - up.y * bestToi, mount.z + fwd.z * bestOff - up.z * bestToi);
          // tire compliance: terrain steps (curbs) raise the wheel at a finite rate
          if (wasContact) {
            const vpw = pointVel(S.vp, w.point);
            const approachV = Math.max(0, -dot(vpw, w.normal));
            const maxComp = w.comp + (approachV + TIRE_RISE) * dt;
            if (comp > maxComp) comp = maxComp;
            // and drops away at a finite rate (unsprung mass), so small step-downs don't unload the corner at once
            const recedeV = Math.max(0, dot(vpw, w.normal));
            const minComp = w.comp - (recedeV + TIRE_DROP) * dt;
            if (comp < minComp) comp = minComp;
          }
          if (comp > 0) {
            w.contact = true;
            contacts++;
            w.comp = comp;
            w.dist = Math.max(0, travel - comp);
            const parent = bestHit.collider.parent();
            w.groundBody = parent && parent.isDynamic() ? parent : null;
          }
        }
      }
      if (!w.contact) {
        w.comp = 0;
        w.dist = approach(w.dist, travel, 3.5 * dt);
      }
      w.wasContact = wasContact;
    }
    const allAir = contacts === 0;
    this.airTime = allAir ? this.airTime + dt : 0;

    // ---- suspension forces ----
    for (const w of this.wheels) {
      w.susForce = 0;
      if (!w.contact) continue;
      const ax = spec.axles[w.axle];
      const vp = pointVel(S.vp, w.point);
      if (w.groundBody) {
        const gv = w.groundBody.velocityAtPoint(w.point);
        vp.x -= gv.x; vp.y -= gv.y; vp.z -= gv.z;
      }
      // damper velocity = body approach speed along the contact normal (terrain steps/seams don't spike it)
      let compVel = -dot(vp, w.normal);
      compVel = clamp(compVel, -5, 5);
      const xc = Math.min(w.comp, travel);
      let F = ax.k * xc;
      // digressive damper: full rate at low shaft speeds (body control), softer blow-off on sharp hits
      if (compVel > 0) F += ax.cBump * (compVel < 0.3 ? compVel : 0.3 + (compVel - 0.3) * 0.35);
      else F += ax.cRebound * (compVel > -0.4 ? compVel : -0.4 + (compVel + 0.4) * 0.45);
      const bsStart = travel - susp.bumpStop;
      if (w.comp > bsStart) {
        F += ax.k * 6 * (Math.min(w.comp, travel + 0.3) - bsStart);
        // damped bump stop (motorcycles): soaks up the hit instead of springing the chassis back up
        if (susp.bumpStopDamping && compVel > 0) F += ax.cBump * susp.bumpStopDamping * compVel;
      }
      if (w.comp > travel) {
        const vn = dot(vp, w.normal);
        if (vn < 0) F += Math.min((ax.cornerMass * -vn) / dt * 0.6, spec.mass * G * 3);
      }
      w.susForce = Math.max(0, F);
    }
    // anti-roll bars
    for (let ai = 0; ai < 2 && !spec.twoWheel; ai++) {
      const wl = this.wheels[ai * 2], wr = this.wheels[ai * 2 + 1];
      if (wl.contact && wr.contact) {
        const f = spec.axles[ai].arbK * (Math.min(wl.comp, travel) - Math.min(wr.comp, travel));
        wl.susForce = Math.max(0, wl.susForce + f);
        wr.susForce = Math.max(0, wr.susForce - f);
      }
    }
    // apply suspension + compute tire loads (with geometric load transfer)
    let loadSum = 0;
    for (const w of this.wheels) {
      if (!w.contact) {
        w.load = 0;
        continue;
      }
      const maxF = spec.mass * G * 4;
      w.susForce = Math.min(w.susForce, maxF);
      const ax = spec.axles[w.axle];
      // wheel center (on suspension axis)
      const wc = rotate(S.tmp2, q, set(S.tmp, w.x, w.mountY - w.dist, w.z));
      wc.x += pos.x; wc.y += pos.y; wc.z += pos.z;
      S.F.x = up.x * w.susForce; S.F.y = up.y * w.susForce; S.F.z = up.z * w.susForce;
      addImpulse(S.F, wc);
      const nUp = Math.max(0, dot(up, w.normal));
      let load = w.susForce * nUp;
      // geometric transfer through suspension links (tire only, no body moment)
      if (ax.track > 0.05) load += (w.left ? 1 : -1) * (this.axleLat[w.axle] * ax.rollCenter) / ax.track;
      const hAp = susp.antiPitch * spec.cgHeight;
      load += ((w.front ? -1 : 1) * (this.totalLong * hAp)) / L / this.axleWheels[w.axle].length;
      w.load = clamp(load, 0, maxF);
      loadSum += w.load;
    }

    // ---- drivetrain ----
    let drivenOmega = 0, nDriven = 0;
    for (const w of this.wheels) if (w.driven) { drivenOmega += w.omega; nDriven++; }
    drivenOmega /= Math.max(1, nDriven);
    const boosting = inp.boost && this.boostLevel > 0.01 && dtr.gear >= 1 && !this.drowned;
    // no upshifts while doing a burnout / heavy wheelspin at low speed (bounce off the limiter instead)
    let maxDrivenSlip = 0;
    for (const w of this.wheels) if (w.driven && w.contact) maxDrivenSlip = Math.max(maxDrivenSlip, w.slipRatio);
    const allowShift = !burnout && !(maxDrivenSlip > 0.6 && Math.abs(vF) < 8);
    const driveTorque = dtr.update(dt, throttle, drivenOmega, { boosting, allowShift, submerged: submerged > 0.6 });
    const reflected = dtr.reflectedInertia() / Math.max(1, nDriven);
    // torque split + limited slip
    const split = spec.drive === 'AWD' ? [spec.diff.frontSplit, 1 - spec.diff.frontSplit] : spec.drive === 'FWD' ? [1, 0] : [0, 1];
    if (spec.drive === 'AWD') {
      // center coupling: move torque toward the slower axle
      const aw = this.axleWheels;
      const wf = aw[0].reduce((a, w) => a + w.omega, 0) / aw[0].length;
      const wr = aw[1].reduce((a, w) => a + w.omega, 0) / aw[1].length;
      const Ic = this.wheels[0].inertia + reflected;
      const lim = 0.25 * Math.abs(driveTorque) + 60;
      const dT = clamp((Ic / dt) * (wf - wr) * 0.5, -lim, lim);
      this._axleTorque0 = driveTorque * split[0] - dT;
      this._axleTorque1 = driveTorque * split[1] + dT;
    } else {
      this._axleTorque0 = driveTorque * split[0];
      this._axleTorque1 = driveTorque * split[1];
    }
    for (let ai = 0; ai < 2; ai++) {
      const Ta = ai === 0 ? this._axleTorque0 : this._axleTorque1;
      if (this.axleWheels[ai].length === 1) {
        const w1 = this.axleWheels[ai][0];
        w1.driveTorque = w1.driven ? Ta : 0;
        continue;
      }
      const wl = this.wheels[ai * 2], wr = this.wheels[ai * 2 + 1];
      if (!wl.driven) {
        wl.driveTorque = wr.driveTorque = 0;
        continue;
      }
      const I = wl.inertia + reflected;
      const lockMax = spec.diff.preload + spec.diff.lockRatio * Math.abs(Ta);
      const dT = clamp((I / dt) * (wl.omega - wr.omega) * 0.25, -lockMax, lockMax);
      wl.driveTorque = Ta / 2 - dT;
      wr.driveTorque = Ta / 2 + dT;
    }

    // ---- tires ----
    const tire = spec.tire;
    const kPeak = tire.peakSlip;
    const aPeak0 = (tire.peakAngleDeg * Math.PI) / 180;
    const tcsSlip = driftMode ? 0.45 : kPeak * 1.4;
    // gentle auto-brake when rolling slowly off the pedals (cars settle to a stop instead of drifting along)
    // standstill auto-hold (GTA style): with no pedal input the brakes come on progressively below walking pace
    // and hold the vehicle on slopes; without a driver the parking brake does (a hard push or a hit still moves it)
    let autoBrake = 0;
    if (throttle < 0.05 && brake < 0.05 && !burnout) {
      const va = Math.abs(vF);
      if (!this.driverPresent) autoBrake = va < 2 ? 1 : va < 6 ? lerp(1, 0.06, (va - 2) / 4) : 0;
      else {
        // enough to stop at ≈ 2.5 m/s² on top of the slope's pull (no lurch on flat ground), full hold when crawling
        const hold = clamp(0.14 + Math.abs(fwd.y) * 1.3, 0.14, AUTO_HOLD);
        autoBrake = va < 1.5 ? lerp(1, hold, smoothstep(0.6, 1.5, va)) : va < 2.5 ? lerp(hold, 0.06, va - 1.5) : va < 4 ? 0.06 : 0;
      }
    }
    const brakeEff = Math.max(brake, autoBrake);
    // hill-start assist: while pulling away (forward gear + throttle, or reverse) the wheels refuse to roll back
    const antiRoll = grounded && !burnout && throttle > 0.05 && Math.abs(vF) < 1.2 ? (dtr.gear < 0 ? -1 : 1) : 0;
    const engineBrake = throttle < 0.05 && !boosting ? dtr.engineBrakeTorque() / Math.max(1, nDriven) : 0;
    const absSlip = kPeak * 1.1;
    const holdCap = spec.mass * G * spec.wheelRadius;
    let latF0 = 0, latF1 = 0, longSum = 0, maxSkid = 0;
    for (const w of this.wheels) {
      const ax = spec.axles[w.axle];
      const r = w.radius;
      const hb = handbrake && !w.front;
      const Ieff = w.inertia + (w.driven ? reflected : 0);
      let Tb = brakeEff * spec.brakeTorque[w.axle] * (burnout && !w.front ? 0 : 1);
      if (burnout && w.front) Tb = spec.brakeTorque[0] * 1.5;
      if (hb) Tb += spec.brakes.handbrake;
      if (w.dragTorque) Tb += w.dragTorque; // damage: burst tyre / missing wheel drags (src/damage)
      if (w.driven && engineBrake > 0 && !burnout) Tb += engineBrake;
      const held = this.hold || hb || brakeEff > 0.02 || (burnout && w.front);
      const holdTorque = this.hold ? holdCap : Tb;
      w.brakeTorque = Tb;
      const Td = w.driveTorque;

      if (!w.contact) {
        // free wheel
        let om = w.omega + (Td * dt) / Ieff;
        const fr = (Tb + 8) * dt / Ieff;
        if (Math.abs(om) <= fr) om = 0;
        else om -= Math.sign(om) * fr;
        w.omega = clamp(om, -260, 260);
        w.spin += w.omega * dt;
        w.slipRatio = 0;
        w.slipAngle = 0;
        w.skid = 0;
        w.fx = w.fy = 0;
        w.inWater = false;
        continue;
      }

      w.surface = this._surface(w.point.x, w.point.z);
      const surf = w.surface;
      w.inWater = w.point.y < waterLevel;

      // contact frame
      const n = w.normal;
      const wfLocal = set(S.wfLocal, Math.sin(w.steer), 0, -Math.cos(w.steer));
      const wf = rotate(S.wf, q, wfLocal);
      const dn = dot(wf, n);
      wf.x -= n.x * dn; wf.y -= n.y * dn; wf.z -= n.z * dn;
      normalize(wf);
      const ws = normalize(cross(S.ws, wf, n));
      copy(w.fwd, wf);
      copy(w.side, ws);

      const vp = pointVel(S.vp, w.point);
      if (w.groundBody) {
        const gv = w.groundBody.velocityAtPoint(w.point);
        vp.x -= gv.x; vp.y -= gv.y; vp.z -= gv.z;
      }
      const vl = dot(vp, wf);
      const vt = dot(vp, ws);
      const vPlanar = Math.hypot(vl, vt);

      const Fz = w.load;
      const loadNom = ax.cornerMass * G;
      const sens = clamp(1 - tire.loadSens * (Fz / loadNom - 1), 0.75, 1.15);
      const loose = LOOSE[surf.name] === true;
      let mu = tire.mu * surf.grip * sens * ax.grip * GRIP;
      if (w.gripK !== undefined) mu *= w.gripK; // damage: burst tyre / bare hub
      if (hb) mu *= 0.82;
      if (burnout && w.driven && !w.front) mu *= 0.6; // hot spinning tires
      const Fmax = mu * Fz;
      const Clat = loose ? 1.12 : 1 + (ax.falloffLat - 1) * SLIDE_KEEP;
      const aPeak = (aPeak0 / ax.stiffness) * (loose ? 1.4 : 1);
      const Clong = loose ? 1.2 : tire.falloffLong;

      const alpha = Math.atan2(vt, Math.max(Math.abs(vl), 0.5));
      const den = Math.max(Math.abs(vl), V_MIN_SLIP);
      const longAt = (vs) => Fmax * tireCombined(vs / den, alpha, kPeak, aPeak, Clong, Clat).fx;

      // implicit wheel spin solve with linearized longitudinal force
      const vs0 = w.omega * r - vl;
      const eps = 0.02;
      const Fx0 = longAt(vs0);
      // tangent slope, but never below the secant through zero slip (prevents overshoot past the peak)
      const Ktan = (longAt(vs0 + eps) - longAt(vs0 - eps)) / (2 * eps);
      const Ksec = Math.abs(vs0) > 1e-4 ? Fx0 / vs0 : 0;
      const K = Math.max(0, Ktan, Ksec);
      const A = Ieff / dt + K * r * r;
      const solve = (T) => (Ieff * w.omega / dt + T - r * Fx0 + r * K * (vs0 + vl)) / A;
      const omNoBrake = solve(Td);
      let om = omNoBrake;
      if (Tb > 0) {
        if (Math.abs(omNoBrake) < 1e-3) om = 0;
        else {
          const sg = Math.sign(omNoBrake);
          const ob = solve(Td - sg * Tb);
          om = ob * sg <= 0 ? 0 : ob;
        }
        // ABS: keep slip near peak
        if (this.assists.abs && !hb && brake > 0 && Math.abs(vl) > 2) {
          if (vl > 0) om = Math.max(om, Math.min((vl - absSlip * den) / r, omNoBrake));
          else om = Math.min(om, Math.max((vl + absSlip * den) / r, omNoBrake));
        }
      }
      // TCS: clamp wheelspin
      if (this.assists.tcs && !burnout && w.driven && Math.abs(Td) > 1) {
        if (Td > 0) om = Math.min(om, Math.max((vl + tcsSlip * den) / r, 0));
        else om = Math.max(om, Math.min((vl - tcsSlip * den) / r, 0));
      }
      om = clamp(om, -260, 260);

      // low speed: held wheels lock, free wheels roll with the ground
      const wDyn = smoothstep(STATIC_LO, STATIC_HI, vPlanar);
      if (wDyn < 1) {
        if (held) om = lerp(0, om, wDyn);
        else if (!w.driven || Math.abs(Td) < 5) om = lerp(vl / r, om, wDyn);
      }
      w.omega = om;
      w.spin += om * dt;

      const kappa = (om * r - vl) / den;
      const tf = tireCombined(kappa, alpha, kPeak, aPeak, Clong, Clat);
      let Fx = Fmax * tf.fx;
      let Fy = Fmax * tf.fy * tire.latGrip;
      const mShare = (loadSum > 1 ? (spec.mass * Fz) / loadSum : spec.mass / this.wheels.length) * spec.staticScale;
      // no overshoot of lateral velocity within a step
      const latCap = (STATIC_GAIN * mShare * Math.abs(vt)) / dt;
      if (Fy > latCap) Fy = latCap;
      else if (Fy < -latCap) Fy = -latCap;

      if (wDyn < 1) {
        const gS = -G * ws.y;
        const gF = -G * wf.y;
        let Fys = -mShare * ((STATIC_GAIN * vt) / dt + gS);
        let Fxs = held ? -mShare * ((STATIC_GAIN * vl) / dt + gF) : Fx;
        // held wheels: spring back to an anchor so steady pushes (burnout, other cars) cannot make it creep
        if (held && vPlanar < 0.6) {
          if (!w.anchorSet) {
            copy(w.anchor, w.point);
            w.anchorSet = true;
          }
          const ex = w.point.x - w.anchor.x, ey = w.point.y - w.anchor.y, ez = w.point.z - w.anchor.z;
          const dl = ex * wf.x + ey * wf.y + ez * wf.z;
          const ds = ex * ws.x + ey * ws.y + ez * ws.z;
          if (dl * dl + ds * ds > 0.0625) copy(w.anchor, w.point);
          else {
            Fxs -= mShare * 120 * dl;
            Fys -= mShare * 120 * ds;
          }
        } else w.anchorSet = false;
        if (held) {
          const cap = Math.min(Fmax, holdTorque / r);
          Fxs = clamp(Fxs, -cap, cap);
        } else if (antiRoll) {
          // one-way hold: at least the force that stops rolling back, never less drive than the tyre gives
          const stop = -mShare * ((STATIC_GAIN * vl) / dt + gF);
          Fxs = antiRoll > 0 ? Math.max(Fx, Math.min(stop, Fmax)) : Math.min(Fx, Math.max(stop, -Fmax));
        }
        const mag = Math.hypot(Fxs, Fys);
        if (mag > Fmax && mag > 1e-6) {
          Fxs *= Fmax / mag;
          Fys *= Fmax / mag;
        }
        Fx = lerp(Fxs, Fx, wDyn);
        Fy = lerp(Fys, Fy, wDyn);
      }
      // rolling resistance
      if (!(held && wDyn < 1)) Fx -= (tire.rolling + (surf.rolling || 0)) * Fz * Math.tanh(vl / 0.4);

      w.fx = Fx;
      w.fy = Fy;
      w.slipRatio = kappa;
      w.slipAngle = alpha;
      w.longSlipSpeed = om * r - vl;
      w.latSlipSpeed = vt;
      w.slipSpeed = Math.hypot(w.longSlipSpeed, vt);
      // skid intensity for effects/audio
      const slide = Math.max(0, tf.s - 1.15) * smoothstep(1.5, 5, Math.max(vPlanar, Math.abs(w.longSlipSpeed)));
      w.skid = clamp(slide * 0.6, 0, 1) * (Fz > 200 ? 1 : 0);
      if (w.skid > maxSkid) maxSkid = w.skid;

      // apply tire forces: lateral at roll-center height, longitudinal at anti-pitch height
      const pl = S.tmp3;
      const hRc = ax.rollCenter;
      set(pl, w.point.x + up.x * hRc, w.point.y + up.y * hRc, w.point.z + up.z * hRc);
      S.F.x = ws.x * Fy; S.F.y = ws.y * Fy; S.F.z = ws.z * Fy;
      addImpulse(S.F, pl);
      const hAp = susp.antiPitch * spec.cgHeight;
      set(pl, w.point.x + up.x * hAp, w.point.y + up.y * hAp, w.point.z + up.z * hAp);
      S.F.x = wf.x * Fx; S.F.y = wf.y * Fx; S.F.z = wf.z * Fx;
      addImpulse(S.F, pl);

      // water drag at the wheel
      if (w.inWater) {
        const depth = clamp((waterLevel - w.point.y) / 0.5 + 0.3, 0, 1.5);
        const c = mShare * 1.6 * depth;
        S.F.x = -vp.x * c; S.F.y = 0; S.F.z = -vp.z * c;
        addImpulse(S.F, w.point);
      }

      // reaction on dynamic ground (props, other cars)
      if (w.groundBody) {
        const fx = -(ws.x * Fy + wf.x * Fx + up.x * w.susForce) * dt;
        const fy = -(ws.y * Fy + wf.y * Fx + up.y * w.susForce) * dt;
        const fz = -(ws.z * Fy + wf.z * Fx + up.z * w.susForce) * dt;
        w.groundBody.applyImpulseAtPoint({ x: fx, y: fy, z: fz }, w.point, true);
      }

      if (w.axle === 0) latF0 += Fy * dot(ws, right);
      else latF1 += Fy * dot(ws, right);
      longSum += Fx * dot(wf, fwd);
    }
    this.axleLat[0] = latF0;
    this.axleLat[1] = latF1;
    this.totalLong = longSum;

    // ---- aero ----
    const aero = spec.aero;
    const v2 = speed * speed;
    let aeroDown = 0;
    if (speed > 0.5) {
      const dragK = 0.5 * RHO * aero.cda * speed;
      S.F.x = -lin.x * dragK; S.F.y = -lin.y * dragK; S.F.z = -lin.z * dragK;
      addImpulse(S.F, com);
      if (aero.cla > 0 && contacts > 0) {
        const down = 0.5 * RHO * aero.cla * vF * vF;
        aeroDown = down;
        const pf = S.tmp3;
        const df = down * aero.balance;
        const dr = down - df;
        S.F.x = -up.x * df; S.F.y = -up.y * df; S.F.z = -up.z * df;
        rotate(pf, q, set(S.tmp, 0, spec.com.y, spec.zFront));
        pf.x += pos.x; pf.y += pos.y; pf.z += pos.z;
        addImpulse(S.F, pf);
        S.F.x = -up.x * dr; S.F.y = -up.y * dr; S.F.z = -up.z * dr;
        rotate(pf, q, set(S.tmp, 0, spec.com.y, spec.zRear));
        pf.x += pos.x; pf.y += pos.y; pf.z += pos.z;
        addImpulse(S.F, pf);
      }
    }

    // ---- boost ----
    const bs = spec.boost;
    this.boosting = boosting;
    if (boosting) {
      this.boostLevel = Math.max(0, this.boostLevel - dt / bs.duration);
      this.boostCooldown = bs.rechargeDelay;
      const fade = clamp((1 - vF / (spec.vTop * 1.15)) * 6, 0, 1);
      const f = bs.accelG * spec.mass * G * fade * (contacts > 0 ? 1 : 0.4);
      S.F.x = fwd.x * f; S.F.y = fwd.y * f; S.F.z = fwd.z * f;
      addImpulse(S.F, com);
    } else if (this.boostCooldown > 0) this.boostCooldown -= dt;
    else this.boostLevel = Math.min(1, this.boostLevel + dt / bs.recharge);

    // ---- yaw stability (ESC) ----
    const I = spec.inertia;
    const yawRate = dot(ang, up);
    if (this.assists.esc && contacts >= (spec.twoWheel ? 2 : 3) && vF > 6) {
      const d = (this.wheels[0].steer + this.wheels[1].steer) / 2;
      const vch = 28;
      let rDes = spec.twoWheel ? this.bikeYawDes || 0 : (-vF * Math.tan(d)) / (L * (1 + (vF * vF) / (vch * vch)));
      // grip budget includes the downforce (the ESC must not cap a planted supercar at its static grip)
      const rMax = ((spec.twoWheel ? Math.max(tire.mu, spec.bike.gripG) : tire.mu * (1 + aeroDown / (spec.mass * G))) * G / vF) * 1.05;
      rDes = clamp(rDes, -rMax, rMax);
      const margin = driftMode ? 0.45 : 0.05;
      let excess = 0;
      if (Math.sign(yawRate) !== Math.sign(rDes) && Math.abs(rDes) > 0.02) excess = Math.abs(yawRate) - margin * 0.5;
      else excess = Math.abs(yawRate) - Math.abs(rDes) - margin;
      if (Math.abs(beta) > (driftMode ? 0.75 : 0.15)) excess = Math.max(excess, Math.abs(yawRate) * 0.6);
      if (excess > 0) {
        const k = driftMode ? 1.5 : 7.5;
        const tq = Math.min(excess * k * I.y, spec.mass * G * L * 0.35);
        const s = -Math.sign(yawRate) * tq * dt;
        angImp.x += up.x * s; angImp.y += up.y * s; angImp.z += up.z * s;
      }
    }

    // ---- high-speed yaw damping: damps the sideslip rate (body yaw vs path yaw), so steady cornering is untouched
    // but turn-in overshoot and lift-off / brake snaps settle; off in a handbrake drift ----
    {
      const hv = Math.atan2(-lin.x, -lin.z);
      if (this._ydMute > 0) this._ydMute -= dt; // not while a crash is still sorting itself out
      else if (!spec.twoWheel && this.assists.esc && contacts >= 3 && vF > 12 && this._velHead !== undefined) {
        let dh = hv - this._velHead;
        if (dh > Math.PI) dh -= 2 * Math.PI; else if (dh < -Math.PI) dh += 2 * Math.PI;
        const w = smoothstep(12, 40, vF) * (driftMode ? 0.15 : 1) * (handbrake ? 0 : 1);
        // path turn rate the tyres can explain (a wall or a car shoving the body is not a reason to yaw)
        const pMax = (tire.mu * (1 + aeroDown / (spec.mass * G)) * G * 1.3) / vF;
        const err = yawRate - clamp(dh / dt, -pMax, pMax);
        const tq = clamp(-err * YAW_DAMP * I.y * w, -spec.mass * G * L * 0.25, spec.mass * G * L * 0.25) * dt;
        angImp.x += up.x * tq; angImp.y += up.y * tq; angImp.z += up.z * tq;
      }
      this._velHead = hv;
    }

    // ---- two-wheelers: keep the frame upright, lean is visual; falls on big hits ----
    if (spec.twoWheel) {
      const bk = spec.bike;
      const roll = Math.atan2(-right.y, up.y); // + = leaning right
      const wRoll = dot(ang, fwd);
      if (!this.fallen) {
        const wn = this.airTime > 0.1 ? 6 : 11;
        const tq = -I.z * (wn * wn * roll + 2 * wn * wRoll);
        angImp.x += fwd.x * tq * dt; angImp.y += fwd.y * tq * dt; angImp.z += fwd.z * tq * dt;
        if (Math.abs(roll) > 0.95 && !allAir) this._fall(roll);
        // the bike follows its lean: yaw-rate tracking (and sideslip damping) at speed, invisible to the rider
        // pitch damping: shift shocks and throttle steps don't rock the short chassis onto its rear wheel
        if (contacts > 0 && !spec.bike.pedal) {
          const wp = dot(ang, right);
          const tp = -I.x * 6 * wp;
          angImp.x += right.x * tp * dt; angImp.y += right.y * tp * dt; angImp.z += right.z * tp * dt;
        }
        // fades out as the front tyre unloads (no pivoting on the rear wheel, no snap when the front lands)
        const fw = this.wheels[0];
        const fr = fw.contact ? clamp(fw.load / (spec.axles[0].cornerMass * G) / 0.35, 0, 1) : 0;
        const wv = smoothstep(3, 7, vF) * (this.wheels[1].contact ? fr : 0);
        if (wv > 0) {
          const ey = (this.bikeYawDes || 0) - yawRate;
          const ty = clamp(I.y * 7 * ey, -spec.mass * G * L * 0.45, spec.mass * G * L * 0.45) * wv;
          angImp.x += up.x * ty * dt; angImp.y += up.y * ty * dt; angImp.z += up.z * ty * dt;
          const fy = clamp(-vR * spec.mass * 2.5, -spec.mass * G * 0.3, spec.mass * G * 0.3) * wv;
          linImp.x += right.x * fy * dt; linImp.y += right.y * fy * dt; linImp.z += right.z * fy * dt;
        }
      } else if (Math.abs(roll) < 1.45) {
        // topple about the tyre contact line
        const tq = spec.mass * G * spec.cgHeight * Math.sin(roll) * 0.8;
        angImp.x += fwd.x * tq * dt; angImp.y += fwd.y * tq * dt; angImp.z += fwd.z * tq * dt;
      }
      // visual lean from the actual cornering (plus kickstand / foot-down when stopped)
      let target = 0;
      if (!this.fallen) {
        const dyn = clamp(Math.atan((vF * -yawRate) / G), -bk.maxLean * 1.08, bk.maxLean * 1.08);
        const stand = this.driverPresent ? -0.06 : -bk.kickstand;
        const s = grounded ? smoothstep(0.5, 2.5, Math.abs(vF)) : 1;
        target = lerp(stand, this.airTime > 0.1 ? this.leanVisual : dyn, s);
      }
      this.leanVisual += (target - this.leanVisual) * (1 - Math.exp(-dt * 9));
      // visual wheelie on hard launches
      let wTarget = 0;
      if (bk.wheelie && !this.fallen && grounded && inp.throttle > 0.85 && vF > 0.3 && vF < 26 && dtr.gear >= 1 && dtr.gear <= 2) {
        wTarget = clamp((dot(this.accel, fwd) - 3.0) * 0.06, 0, 0.32) * (1 - smoothstep(18, 26, vF));
      }
      this.wheelie += (wTarget - this.wheelie) * (1 - Math.exp(-dt * (wTarget > this.wheelie ? 3 : 6)));
      if (this.fallen) {
        this.fallTimer += dt;
        if (this.autoRecover && this.driverPresent && this.fallTimer > 2.5 && speed < 1.5) {
          const p = body.translation();
          this.reset({ x: p.x, y: p.y - spec.restHeight * 0.5, z: p.z }, Math.atan2(-fwd.x, -fwd.z));
          return;
        }
      }
    } else if (spec.rollAssist > 0 && contacts >= 2) {
      // anti-rollover: restoring torque once the body rolls well past normal cornering roll
      let nx = 0, ny = 0, nz = 0;
      for (const w of this.wheels) if (w.contact) { nx += w.normal.x; ny += w.normal.y; nz += w.normal.z; }
      const nl = Math.hypot(nx, ny, nz) || 1;
      const rRel = Math.asin(clamp(-(right.x * nx + right.y * ny + right.z * nz) / nl, -1, 1));
      const ex = Math.sign(rRel) * Math.max(0, Math.abs(rRel) - 0.085);
      if (ex !== 0) {
        const wRoll = dot(ang, fwd);
        const k = spec.rollAssist * spec.mass * G * spec.cgHeight;
        const tq = -(k * ex * 9 + (Math.sign(wRoll) === Math.sign(ex) ? I.z * 6 * wRoll : 0));
        angImp.x += fwd.x * tq * dt; angImp.y += fwd.y * tq * dt; angImp.z += fwd.z * tq * dt;
      }
    }

    // ---- air control ----
    if (this.airTime > 0.12 && submerged < 0.3) {
      const wx = dot(ang, right), wz = dot(ang, fwd);
      const kd = 1.6;
      angImp.x -= (right.x * wx * I.x + fwd.x * wz * I.z) * kd * dt;
      angImp.y -= (right.y * wx * I.x + fwd.y * wz * I.z) * kd * dt;
      angImp.z -= (right.z * wx * I.x + fwd.z * wz * I.z) * kd * dt;
      if (up.y > 0.25) {
        const lev = cross(S.tmp, up, set(S.tmp2, 0, 1, 0));
        const kp = 2.2;
        const ii = (I.x + I.z) * 0.5;
        angImp.x += lev.x * kp * ii * dt;
        angImp.y += lev.y * kp * ii * dt;
        angImp.z += lev.z * kp * ii * dt;
      }
      const yawCtl = -inp.steer * 1.2 * I.y * dt;
      angImp.x += up.x * yawCtl; angImp.y += up.y * yawCtl; angImp.z += up.z * yawCtl;
    }

    // ---- water body drag / buoyancy ----
    if (submerged > 0) {
      const c = spec.mass * 1.4 * submerged;
      S.F.x = -lin.x * c;
      S.F.y = -lin.y * c + spec.mass * G * 0.7 * submerged;
      S.F.z = -lin.z * c;
      addImpulse(S.F, com);
      const ca = 2.5 * submerged * dt;
      angImp.x -= ang.x * I.x * ca; angImp.y -= ang.y * I.y * ca; angImp.z -= ang.z * I.z * ca;
    }

    // ---- rebound clamp (motorcycles): the suspension may not fling the body off the road surface faster than
    // susp.reboundClamp m/s along the contact normal (bumps, kerbs, landings). Velocity along a ramp is untouched.
    if (susp.reboundClamp && contacts > 0 && submerged < 0.3) {
      let nx = 0, ny = 0, nz = 0;
      for (const w of this.wheels) if (w.contact) { nx += w.normal.x; ny += w.normal.y; nz += w.normal.z; }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const im = 1 / spec.mass;
      const vn = (lin.x + linImp.x * im) * nx + (lin.y + linImp.y * im - G * dt) * ny + (lin.z + linImp.z * im) * nz;
      const ex = vn - susp.reboundClamp;
      if (ex > 0) {
        const j = ex * spec.mass;
        linImp.x -= nx * j; linImp.y -= ny * j; linImp.z -= nz * j;
      }
    }

    // ---- apply ----
    const settled = this.hold && idleInput && speed < 0.05 && Math.hypot(ang.x, ang.y, ang.z) < 0.05;
    const wake = !settled;
    // forces (not impulses) so they integrate per solver substep like gravity
    const inv = 1 / dt;
    set(S.tmp, linImp.x * inv, linImp.y * inv, linImp.z * inv);
    body.addForce(S.tmp, wake);
    set(S.tmp, angImp.x * inv, angImp.y * inv, angImp.z * inv);
    body.addTorque(S.tmp, wake);

    // safety clamps
    if (speed > MAX_LINVEL) {
      const s = MAX_LINVEL / speed;
      body.setLinvel({ x: lin.x * s, y: lin.y * s, z: lin.z * s }, true);
    }
    const angMag = Math.hypot(ang.x, ang.y, ang.z);
    if (angMag > MAX_ANGVEL) {
      const s = MAX_ANGVEL / angMag;
      body.setAngvel({ x: ang.x * s, y: ang.y * s, z: ang.z * s }, true);
    }

    // predicted velocity for impact detection
    const im = 1 / spec.mass;
    this.predVel = this.predVel || v3();
    set(this.predVel, lin.x + linImp.x * im, lin.y + linImp.y * im - G * dt, lin.z + linImp.z * im);

    // ---- telemetry ----
    const upsideDown = up.y < 0.1;
    this.upsideTimer = upsideDown && speed < 3 ? this.upsideTimer + dt : 0;
    tel.speedKmh = Math.abs(vF) * 3.6;
    tel.forwardSpeed = vF;
    tel.rpm = Math.min(dtr.rpm, spec.engine.limiter * 1.01);
    tel.gear = dtr.shifting && dtr.shiftTo !== dtr.gear ? dtr.gear : dtr.gear;
    tel.shifting = dtr.shifting;
    tel.shiftId = dtr.shiftId;
    tel.throttle = throttle;
    tel.brake = brake;
    tel.engineLoad = clamp(dtr.engineTorque / dtr.maxTorque, -1, 1);
    tel.limiter = dtr.limiterTimer > 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i], t = tel.wheels[i];
      t.contact = w.contact;
      t.slipRatio = w.slipRatio;
      t.slipAngle = w.slipAngle;
      t.load = w.load;
      t.surface = w.contact ? w.surface.name : 'air';
      t.skid = w.skid;
      t.compression = w.contact ? clamp(w.comp / travel, 0, 1.2) : 0;
      t.inWater = w.inWater;
    }
    tel.slipAngle = beta;
    tel.drifting = contacts >= 2 && vF > 8 && Math.abs(beta) > 0.2;
    tel.airborne = this.airTime > 0.1;
    tel.boost = this.boostLevel;
    tel.boosting = boosting;
    tel.latAccel = dot(this.accel, right);
    tel.longAccel = dot(this.accel, fwd);
    tel.yawRate = yawRate;
    tel.maxSkid = maxSkid;
    tel.handbrake = handbrake;
    tel.braking = brake > 0.05 && dtr.gear !== 0;
    tel.reversing = dtr.gear < 0;
    tel.inWater = this.wheels.some((w) => w.inWater) || submerged > 0;
    tel.submerged = submerged;
    tel.upsideDown = this.upsideTimer > 1.5;
    tel.lean = this.leanVisual;
    tel.wheelie = this.wheelie;
    tel.fallen = this.fallen;
  }

  /** Two-wheelers: rider loses it. side: signed hint (+ = fall to the right). */
  _fall(side = 0) {
    if (this.fallen || !this.spec.twoWheel) return;
    this.fallen = true;
    this.fallTimer = 0;
    const b = this.body;
    // turn the visual lean into a real roll of the frame, then let it topple
    const lean = this.leanVisual;
    const dir = Math.sign(lean || side || (Math.random() < 0.5 ? -1 : 1));
    const q = b.rotation();
    const half = (lean * 0.9) / 2;
    // roll about local -Z (forward) by +lean
    const rq = { x: 0, y: 0, z: -Math.sin(half), w: Math.cos(half) };
    b.setRotation({
      w: q.w * rq.w - q.x * rq.x - q.y * rq.y - q.z * rq.z,
      x: q.w * rq.x + q.x * rq.w + q.y * rq.z - q.z * rq.y,
      y: q.w * rq.y - q.x * rq.z + q.y * rq.w + q.z * rq.x,
      z: q.w * rq.z + q.x * rq.y - q.y * rq.x + q.z * rq.w,
    }, true);
    const f = rotate(this._s.tmp, b.rotation(), set(this._s.tmp2, 0, 0, -1));
    const a = b.angvel();
    b.setAngvel({ x: a.x + f.x * dir * 2.2, y: a.y + f.y * dir * 2.2, z: a.z + f.z * dir * 2.2 }, true);
    this.leanVisual = 0;
    this.wheelie = 0;
    this.telemetry.fallen = true;
  }

  _telemetryIdle() {
    const tel = this.telemetry;
    tel.speedKmh = 0;
    tel.forwardSpeed = 0;
    tel.throttle = 0;
    tel.brake = 0;
    tel.maxSkid = 0;
    tel.boosting = false;
    tel.drifting = false;
    this.drivetrain.rpm = lerp(this.drivetrain.rpm, this.spec.engine.idle, 0.1);
    tel.rpm = this.drivetrain.rpm;
    for (const w of this.wheels) w.skid = 0;
    for (const t of tel.wheels) t.skid = 0;
    if (this.boostLevel < 1) this.boostLevel = Math.min(1, this.boostLevel + 1 / 60 / this.spec.boost.recharge);
    tel.boost = this.boostLevel;
  }

  /** Set the body velocity from outside (spawn with speed, carjack) without it reading as an impact. */
  setVelocity(v) {
    this.body.setLinvel({ x: v.x || 0, y: v.y || 0, z: v.z || 0 }, true);
    this.predVel = null;
    const f = rotate(this._s.tmp, this.body.rotation(), set(this._s.tmp2, 0, 0, -1));
    const fwdSpeed = (v.x || 0) * f.x + (v.y || 0) * f.y + (v.z || 0) * f.z;
    for (const w of this.wheels) w.omega = fwdSpeed / w.radius;
  }

  /** Forces persist between world steps; call this if you stop calling fixedUpdate for this vehicle. */
  clearForces() {
    this.body.resetForces(false);
    this.body.resetTorques(false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.world.removeRigidBody(this.body);
    } catch (e) {
      /* world already freed */
    }
  }
}
