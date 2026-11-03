// Physics specs for helicopters and planes. Body frame: x right, y up, -z forward; origin = centre of mass.
import { G, RHO } from './physics/math.js';

const box = (hx, hy, hz, x, y, z, o = {}) => ({ shape: 'box', hx, hy, hz, x, y, z, ...o });
const capZ = (hh, r, x, y, z, o = {}) => ({ shape: 'capsule', hh, r, x, y, z, axis: 'z', ...o });

// ---------------- helicopters ----------------
export const HELI_SPECS = {
  heli_news: {
    kind: 'heli', mass: 950, com: { x: 0, y: 0, z: 0 }, inertia: { x: 1600, y: 1900, z: 650 },
    skidY: -1.22, crashDv: 11, floodTime: 6, maxRpm: 400, rotorRps: 6.6,
    rotor: { radius: 4.4, hubY: 1.45, hubs: [[0, 1.45, -0.15]], tail: { x: 0.28, y: 0.62, z: 5.05, r: 0.72 } },
    thrustRatio: 1.9, climbRate: 8.5, descendRate: 6.5, maxPitch: 0.38, maxRoll: 0.52, yawRate: 1.6,
    kAtt: 7.5, dAtt: 5.2, kRate: 6, rateMax: 1.4, kYaw: 4.2, vane: 2.2,
    cdFront: 1.3, cdSide: 6, cdTop: 14, spool: 4, spinDown: 9, topSpeedKmh: 225,
    colliders: [
      box(0.68, 0.72, 1.25, 0, 0.12, -0.35, { friction: 0.4 }),
      box(0.14, 0.16, 2.2, 0, 0.42, 3.0, { friction: 0.4 }),
      capZ(1.05, 0.07, -0.92, -1.15, -0.25, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
      capZ(1.05, 0.07, 0.92, -1.15, -0.25, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
    ],
    float: { depth: 0.5, points: [[-0.92, -1.15, -1.2], [0.92, -1.15, -1.2], [-0.92, -1.15, 0.8], [0.92, -1.15, 0.8], [0, -0.6, -1.4], [0, -0.6, 0.8]] },
  },
  heli_police: {
    kind: 'heli', mass: 2300, com: { x: 0, y: 0, z: 0 }, inertia: { x: 6000, y: 7200, z: 2100 },
    skidY: -1.42, crashDv: 12, floodTime: 7, maxRpm: 380, rotorRps: 6.0,
    rotor: { radius: 5.6, hubY: 1.85, hubs: [[0, 1.85, -0.2]], tail: { x: 0.36, y: 0.95, z: 6.7, r: 0.95 } },
    thrustRatio: 1.75, climbRate: 9, descendRate: 7, maxPitch: 0.4, maxRoll: 0.55, yawRate: 1.35,
    kAtt: 6.5, dAtt: 4.8, kRate: 5.5, rateMax: 1.25, kYaw: 3.8, vane: 2.0,
    cdFront: 2.4, cdSide: 12, cdTop: 26, spool: 4.5, spinDown: 10, topSpeedKmh: 260,
    searchlight: { x: 0.0, y: -0.85, z: -2.0 },
    colliders: [
      box(0.92, 0.88, 1.9, 0, 0.15, -0.4, { friction: 0.4 }),
      box(0.2, 0.22, 2.7, 0, 0.55, 3.9, { friction: 0.4 }),
      capZ(1.45, 0.08, -1.1, -1.34, -0.3, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
      capZ(1.45, 0.08, 1.1, -1.34, -0.3, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
    ],
    float: { depth: 0.6, points: [[-1.1, -1.34, -1.6], [1.1, -1.34, -1.6], [-1.1, -1.34, 1.0], [1.1, -1.34, 1.0], [0, -0.7, -2.1], [0, -0.7, 1.2]] },
  },
  heli_cargo: {
    kind: 'heli', mass: 9500, com: { x: 0, y: 0, z: 0 }, inertia: { x: 95000, y: 100000, z: 22000 },
    skidY: -1.95, crashDv: 13, floodTime: 9, maxRpm: 230, rotorRps: 3.8, twin: true,
    rotor: { radius: 7.0, hubY: 2.55, hubs: [[0, 2.35, -5.3], [0, 3.25, 5.2]] },
    thrustRatio: 1.6, climbRate: 7, descendRate: 6, maxPitch: 0.3, maxRoll: 0.42, yawRate: 0.85,
    kAtt: 4.6, dAtt: 4.0, kRate: 4, rateMax: 0.9, kYaw: 3, vane: 1.4,
    cdFront: 2.9, cdSide: 30, cdTop: 60, spool: 6, spinDown: 12, topSpeedKmh: 275,
    colliders: [
      box(1.35, 1.3, 7.0, 0, 0.1, 0, { friction: 0.5 }),
      box(0.5, 0.6, 1.2, 0, 1.75, 5.2, { friction: 0.5 }),
      capZ(0.15, 0.42, -1.55, -1.53, -3.6, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
      capZ(0.15, 0.42, 1.55, -1.53, -3.6, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
      capZ(1.0, 0.42, -1.75, -1.53, 2.9, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
      capZ(1.0, 0.42, 1.75, -1.53, 2.9, { friction: 0.9, restitution: 0.05, tag: 'skid' }),
    ],
    float: { depth: 1.0, points: [[-1.3, -1.2, -6], [1.3, -1.2, -6], [-1.3, -1.2, 0], [1.3, -1.2, 0], [-1.3, -1.2, 6], [1.3, -1.2, 6]] },
  },
};

// ---------------- planes ----------------
// wheel: x, y (mount), z, travel, radius, share (static load fraction), steer (1 nose / -1 tail), brake, retract
function wheel(x, y, z, travel, radius, share, o = {}) { return { x, y, z, travel, radius, share, steer: 0, brake: false, retract: false, ...o }; }

const PLANE_BASE = {
  pipit: {
    kind: 'plane', mass: 1000, com: { x: 0, y: 0, z: 0 }, inertia: { x: 1400, y: 2500, z: 1300 },
    topSpeedKmh: 230, twr: 0.32, engine: { type: 'prop' }, maxRpm: 2700, crashDv: 13, floodTime: 5,
    wing: { area: 16, span: 10.2, e: 0.8, clA: 4.6, cl0: 0.25, aStall: 0.27, dClFlap: 0.55, cdFlap: 0.045, alphaTrim: 0.04 },
    cdGear: 0.008, sideArea: 6, vRef: 50, nMax: 3.8,
    ctl: { pitchStab: 10, dAlphaMax: 0.22, pitchDamp: 4, rollRate: 1.4, rollDamp: 3.5, yawAuth: 1.6, yawStab: 4, yawDamp: 2.5, propWash: 0.45, level: 0.35, wingDrop: 2.5 },
    steerMax: 0.55, tireMu: 0.85, rolling: 0.015, brakeMu: 0.55, retract: false,
    wheels: [
      wheel(0, -0.9, -1.55, 0.25, 0.22, 0.17, { steer: 1 }),
      wheel(-1.25, -0.85, 0.3, 0.25, 0.27, 0.415, { brake: true }),
      wheel(1.25, -0.85, 0.3, 0.25, 0.27, 0.415, { brake: true }),
    ],
    colliders: [
      box(0.58, 0.62, 1.7, 0, 0.0, -0.4, { friction: 0.45 }),
      box(0.32, 0.36, 1.9, 0, 0.12, 2.9, { friction: 0.45 }),
      box(5.1, 0.07, 0.78, 0, 0.98, -0.25, { friction: 0.4 }),
      box(1.7, 0.05, 0.45, 0, 0.22, 4.75, { friction: 0.4 }),
      box(0.05, 0.7, 0.5, 0, 0.9, 4.8, { friction: 0.4 }),
    ],
    float: { depth: 0.6, points: [[-0.5, -0.55, -1.6], [0.5, -0.55, -1.6], [-0.5, -0.55, 1.0], [0.5, -0.55, 1.0], [-4, 0.95, 0], [4, 0.95, 0]] },
  },
  vortica: {
    kind: 'plane', mass: 760, com: { x: 0, y: 0, z: 0 }, inertia: { x: 900, y: 1500, z: 520 },
    topSpeedKmh: 340, twr: 0.58, engine: { type: 'prop' }, maxRpm: 2900, crashDv: 13, floodTime: 4,
    wing: { area: 10.8, span: 7.6, e: 0.82, clA: 4.4, cl0: 0.06, aStall: 0.3, dClFlap: 0.0, cdFlap: 0.0, alphaTrim: 0.06 },
    cdGear: 0.006, sideArea: 4.2, vRef: 62, nMax: 8,
    ctl: { pitchStab: 13, dAlphaMax: 0.3, pitchDamp: 3, rollRate: 3.2, rollDamp: 2.2, yawAuth: 3.2, yawStab: 3, yawDamp: 2, propWash: 0.6, level: 0.12, wingDrop: 4.5 },
    steerMax: 0.5, tireMu: 0.85, rolling: 0.016, brakeMu: 0.5, retract: false, noFlaps: true,
    wheels: [
      wheel(-0.95, -0.55, -0.62, 0.22, 0.25, 0.445, { brake: true }),
      wheel(0.95, -0.55, -0.62, 0.22, 0.25, 0.445, { brake: true }),
      wheel(0, -0.15, 4.25, 0.12, 0.1, 0.11, { steer: -1 }),
    ],
    colliders: [
      box(0.5, 0.52, 1.6, 0, 0.0, -0.6, { friction: 0.45 }),
      box(0.26, 0.3, 1.5, 0, 0.1, 2.6, { friction: 0.45 }),
      box(3.8, 0.07, 0.72, 0, -0.18, -0.35, { friction: 0.4 }),
      box(1.35, 0.05, 0.4, 0, 0.12, 4.15, { friction: 0.4 }),
      box(0.05, 0.6, 0.45, 0, 0.7, 4.2, { friction: 0.4 }),
    ],
    float: { depth: 0.5, points: [[-0.45, -0.5, -1.5], [0.45, -0.5, -1.5], [-0.45, -0.5, 1.0], [0.45, -0.5, 1.0], [-3, -0.15, 0], [3, -0.15, 0]] },
  },
  tarpon: {
    kind: 'plane', mass: 1500, com: { x: 0, y: 0, z: 0 }, inertia: { x: 2600, y: 4600, z: 2900 },
    topSpeedKmh: 250, twr: 0.34, engine: { type: 'prop' }, maxRpm: 2600, crashDv: 13, floodTime: 5,
    wing: { area: 20, span: 12.6, e: 0.8, clA: 4.7, cl0: 0.3, aStall: 0.26, dClFlap: 0.6, cdFlap: 0.045, alphaTrim: 0.04 },
    cdGear: 0.012, sideArea: 9, vRef: 52, nMax: 3.8,
    ctl: { pitchStab: 10, dAlphaMax: 0.22, pitchDamp: 4.2, rollRate: 1.25, rollDamp: 3.6, yawAuth: 1.5, yawStab: 4, yawDamp: 2.6, propWash: 0.45, level: 0.35, wingDrop: 2.2 },
    steerMax: 0, tireMu: 0.6, rolling: 0.05, brakeMu: 0, retract: false, restHeight: 1.92,
    wheels: [],
    colliders: [
      box(0.6, 0.66, 1.8, 0, 0.15, -0.4, { friction: 0.45 }),
      box(0.33, 0.36, 2.0, 0, 0.3, 3.1, { friction: 0.45 }),
      box(6.3, 0.07, 0.8, 0, 1.15, -0.3, { friction: 0.4 }),
      box(1.8, 0.05, 0.45, 0, 0.4, 5.05, { friction: 0.4 }),
      box(0.05, 0.75, 0.5, 0, 1.05, 5.1, { friction: 0.4 }),
      box(0.3, 0.24, 3.3, -1.45, -1.66, -0.1, { friction: 0.35, tag: 'float' }),
      box(0.3, 0.24, 3.3, 1.45, -1.66, -0.1, { friction: 0.35, tag: 'float' }),
    ],
    float: {
      seaplane: true, depth: 0.36, planeV0: 7, planeV1: 21, dragF: 1.8, dragS: 55, linS: 120, dragV: 30, rudder: 0.9,
      points: [-2.8, -1.4, 0, 1.4, 2.8].flatMap((z) => [[-1.45, -1.9, z], [1.45, -1.9, z]]),
    },
  },
  solstice: {
    kind: 'plane', mass: 8500, com: { x: 0, y: 0, z: 0 }, inertia: { x: 32000, y: 62000, z: 36000 },
    topSpeedKmh: 780, twr: 0.42, engine: { type: 'jet' }, maxRpm: 100, crashDv: 14, floodTime: 6,
    wing: { area: 46, span: 16.4, e: 0.8, clA: 5.0, cl0: 0.2, aStall: 0.24, dClFlap: 0.9, cdFlap: 0.055, alphaTrim: 0.03 },
    cdGear: 0.022, sideArea: 26, vRef: 100, nMax: 4,
    ctl: { pitchStab: 14, dAlphaMax: 0.2, pitchDamp: 4, rollRate: 1.7, rollDamp: 3, yawAuth: 1.2, yawStab: 4, yawDamp: 3, propWash: 0, level: 0.35, wingDrop: 1.5 },
    steerMax: 0.5, tireMu: 0.8, rolling: 0.012, brakeMu: 0.6, retract: true, gearTime: 4,
    wheels: [
      wheel(0, -1.08, -5.0, 0.3, 0.3, 0.07, { steer: 1, retract: true }),
      wheel(-2.0, -1.0, 0.38, 0.3, 0.38, 0.465, { brake: true, retract: true }),
      wheel(2.0, -1.0, 0.38, 0.3, 0.38, 0.465, { brake: true, retract: true }),
    ],
    colliders: [
      box(0.95, 1.0, 5.8, 0, 0.1, -0.6, { friction: 0.4 }),
      box(0.6, 0.65, 1.6, 0, 0.35, 6.2, { friction: 0.4 }),
      box(8.0, 0.11, 1.4, 0, -0.45, 0.6, { friction: 0.35 }),
      box(0.06, 1.25, 1.0, 0, 2.0, 7.0, { friction: 0.4 }),
      box(2.6, 0.06, 0.65, 0, 3.15, 7.4, { friction: 0.4 }),
    ],
    float: { depth: 1.0, points: [[-0.9, -0.85, -4], [0.9, -0.85, -4], [-0.9, -0.85, 3], [0.9, -0.85, 3], [-6, -0.45, 1], [6, -0.45, 1]] },
  },
};

/** Derive coefficients (cd0 from top speed, thrust from thrust/weight, suspension rates, rest height). */
export function derivePlaneSpec(base) {
  const s = structuredClone(base);
  const m = s.mass, W = s.wing;
  W.k = 1 / (Math.PI * W.e * (W.span * W.span / W.area));
  s.vTop = s.topSpeedKmh / 3.6;
  s.engine.thrust = s.twr * m * G;
  const vr = 1;
  const Ttop = s.engine.thrust * (s.engine.type === 'jet' ? 1 - 0.12 * vr : 1 - 0.62 * vr);
  const qS = 0.5 * RHO * s.vTop * s.vTop * W.area;
  const Cl = (m * G) / qS;
  const gearDrag = s.retract ? 0 : s.cdGear;
  s.cd0 = Math.max(0.015, Ttop / qS - W.k * Cl * Cl - gearDrag);
  s.qRef = 0.5 * RHO * s.vRef * s.vRef;
  s.ctl.rollAuth = s.ctl.rollRate * s.ctl.rollDamp;
  for (const w of s.wheels) {
    const ms = w.share * m;
    w.k = (ms * G) / (0.4 * w.travel);
    w.c = 2 * 0.55 * Math.sqrt(w.k * ms);
  }
  if (s.restHeight === undefined) {
    // origin height above flat ground at rest (statically compressed main gear)
    const mains = s.wheels.filter((w) => w.brake);
    const w = mains[0] || s.wheels[0];
    s.restHeight = -(w.y - (w.travel * 0.6) - w.radius);
  }
  // taildraggers rest nose-up
  const tail = s.wheels.find((w) => w.steer === -1);
  if (tail) {
    const main = s.wheels.find((w) => w.brake);
    const yM = main.y - main.travel * 0.6 - main.radius;
    const yT = tail.y - tail.travel * 0.6 - tail.radius;
    s.restPitch = Math.atan2(yT - yM, tail.z - main.z);
  } else s.restPitch = 0;
  s.vStall = Math.sqrt((2 * m * G) / (RHO * W.area * (W.cl0 + W.clA * W.aStall)));
  s.vStallFlaps = Math.sqrt((2 * m * G) / (RHO * W.area * (W.cl0 + W.dClFlap + W.clA * (W.aStall - 0.035))));
  return s;
}

export const PLANE_SPECS = Object.fromEntries(Object.entries(PLANE_BASE).map(([k, v]) => [k, derivePlaneSpec(v)]));
