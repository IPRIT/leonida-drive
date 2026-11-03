// Vehicle presets: plain data only (safe to import in Node).
// The six original hand-tuned presets live here; the ~120 catalog vehicles are merged in from catalog.js.
import { CATALOG_PRESETS } from './catalog.js';
// Units: meters, kilograms, seconds, Newton-meters, rpm. Car forward = local -Z.
// gearbox.finalDrive / aero.cda may be null: they are derived from gearbox.topSpeedKmh.

const base = {
  steering: { maxLockDeg: 35, speedRef: 15, rate: 5.0, ackermann: 0.65 },
  suspension: { bump: 0.32, rebound: 0.55, bumpStop: 0.035 },
  tire: { peakSlip: 0.1, peakAngleDeg: 7.5, stiffness: [1.0, 1.3], latGrip: 1.12, falloffLong: 1.45, falloffLat: [1.2, 1.22], loadSens: 0.08, rolling: 0.013 },
  brakes: { decelG: 1.7, bias: 0.64, handbrake: 2800 },
  boost: { accelG: 0.42, duration: 4.0, recharge: 9.0, rechargeDelay: 1.0 },
  assists: { abs: true, tcs: true, esc: true, steerAssist: true },
};

export const VEHICLE_PRESETS = {
  comet: {
    name: 'comet',
    label: 'Shiden',
    drive: 'RWD',
    color: 0xff2e88,
    mass: 1340,
    size: { length: 4.35, width: 1.84, height: 1.18 },
    wheelbase: 2.5,
    track: [1.54, 1.56],
    wheelRadius: 0.32,
    tireWidth: [0.225, 0.255],
    cgHeight: 0.46,
    weightFront: 0.46,
    inertiaScale: { pitch: 1.15, yaw: 1.0, roll: 1.35 },
    collider: { clearance: 0.15, belt: 0.86, cabin: { z0: -0.6, z1: 1.55, top: 1.16, width: 1.42 } },
    suspension: { travel: 0.24, freq: [1.75, 1.85], arb: [0.55, 0.32], rollCenter: [0.16, 0.22], antiPitch: 0.25 },
    tire: { mu: 1.18, grip: [1.0, 1.04] },
    steering: { maxLockDeg: 34 },
    engine: {
      idle: 900, redline: 7200, limiter: 7400, inertia: 0.14, brakeFrac: 0.22, stallRpm: 3200,
      curve: [[800, 250], [2000, 360], [3500, 440], [4800, 468], [6000, 452], [7000, 410], [7600, 340]],
    },
    gearbox: { gears: [3.2, 1.9, 1.45, 1.17, 0.97, 0.8], reverse: 3.3, finalDrive: null, topSpeedKmh: 245, shiftTime: 0.16, efficiency: 0.88 },
    diff: { lockRatio: 0.35, preload: 60 },
    aero: { cda: null, cla: 0.45, balance: 0.45 },
    audio: { cylinders: 6, base: 1.0, sub: 0.35, rasp: 0.45, cutoff: 1.0, turbo: 0.6, crackle: 0.7 },
  },

  muscle: {
    name: 'muscle',
    label: 'Bullhorn GT',
    drive: 'RWD',
    color: 0xff7a1a,
    mass: 1640,
    size: { length: 4.85, width: 1.94, height: 1.3 },
    wheelbase: 2.8,
    track: [1.58, 1.6],
    wheelRadius: 0.34,
    tireWidth: [0.245, 0.285],
    cgHeight: 0.52,
    weightFront: 0.52,
    inertiaScale: { pitch: 1.15, yaw: 1.05, roll: 1.35 },
    collider: { clearance: 0.16, belt: 0.95, cabin: { z0: -0.25, z1: 1.45, top: 1.3, width: 1.5 } },
    suspension: { travel: 0.26, freq: [1.5, 1.55], arb: [0.6, 0.28], rollCenter: [0.14, 0.2], antiPitch: 0.15 },
    tire: { mu: 1.14, grip: [1.0, 1.02], falloffLat: [1.22, 1.26] },
    steering: { maxLockDeg: 33, rate: 4.2 },
    engine: {
      idle: 750, redline: 6200, limiter: 6400, inertia: 0.26, brakeFrac: 0.26, stallRpm: 2600,
      curve: [[700, 370], [1800, 525], [3200, 620], [4200, 615], [5400, 550], [6400, 455]],
    },
    gearbox: { gears: [2.9, 1.84, 1.38, 1.1, 0.86], reverse: 2.9, finalDrive: null, topSpeedKmh: 220, shiftTime: 0.2, efficiency: 0.87 },
    diff: { lockRatio: 0.5, preload: 120 },
    aero: { cda: null, cla: 0.2, balance: 0.42 },
    audio: { cylinders: 8, base: 0.8, sub: 0.8, rasp: 0.65, cutoff: 0.75, turbo: 0, crackle: 1.0, lope: 0.8 },
  },

  super: {
    name: 'super',
    label: 'Vapore',
    drive: 'AWD',
    color: 0x14d2c8,
    mass: 1520,
    size: { length: 4.62, width: 2.04, height: 1.13 },
    wheelbase: 2.7,
    track: [1.7, 1.66],
    wheelRadius: 0.35,
    tireWidth: [0.255, 0.325],
    cgHeight: 0.42,
    weightFront: 0.42,
    inertiaScale: { pitch: 1.1, yaw: 1.0, roll: 1.3 },
    collider: { clearance: 0.12, belt: 0.78, cabin: { z0: -1.0, z1: 1.1, top: 1.12, width: 1.45 } },
    suspension: { travel: 0.2, freq: [2.0, 2.1], arb: [0.5, 0.35], rollCenter: [0.14, 0.18], antiPitch: 0.35 },
    tire: { mu: 1.24, grip: [1.0, 1.03], peakAngleDeg: 7, latGrip: 1.08 },
    steering: { maxLockDeg: 32, rate: 5.5 },
    engine: {
      idle: 1000, redline: 8600, limiter: 8800, inertia: 0.16, brakeFrac: 0.2, stallRpm: 4200,
      curve: [[1000, 340], [2500, 500], [4000, 610], [5500, 640], [7000, 620], [8000, 575], [8800, 500]],
    },
    gearbox: { gears: [3.3, 2.35, 1.8, 1.45, 1.2, 1.0, 0.84], reverse: 3.0, finalDrive: null, topSpeedKmh: 300, shiftTime: 0.08, efficiency: 0.9 },
    diff: { lockRatio: 0.4, preload: 80, frontSplit: 0.4 },
    aero: { cda: null, cla: 1.35, balance: 0.42 },
    audio: { cylinders: 10, base: 1.25, sub: 0.2, rasp: 0.55, cutoff: 1.35, turbo: 0, crackle: 0.6 },
  },

  suv: {
    name: 'suv',
    label: 'Backcountry',
    drive: 'AWD',
    color: 0x6b3fa0,
    mass: 2150,
    size: { length: 4.8, width: 1.98, height: 1.86 },
    wheelbase: 2.85,
    track: [1.66, 1.66],
    wheelRadius: 0.4,
    tireWidth: [0.265, 0.265],
    cgHeight: 0.72,
    weightFront: 0.53,
    inertiaScale: { pitch: 1.1, yaw: 1.05, roll: 1.4 },
    collider: { clearance: 0.27, belt: 1.18, cabin: { z0: -0.55, z1: 2.3, top: 1.84, width: 1.72 } },
    suspension: { travel: 0.34, freq: [1.2, 1.3], arb: [0.85, 0.55], rollCenter: [0.3, 0.36], antiPitch: 0.3, bump: 0.3, rebound: 0.5 },
    tire: { mu: 0.97, grip: [1.0, 1.03], peakAngleDeg: 8.5, falloffLat: [1.18, 1.2], latGrip: 1.18 },
    steering: { maxLockDeg: 35, rate: 4.0 },
    engine: {
      idle: 700, redline: 6000, limiter: 6200, inertia: 0.24, brakeFrac: 0.24, stallRpm: 2400,
      curve: [[700, 310], [1800, 440], [3000, 480], [4200, 470], [5200, 430], [6200, 360]],
    },
    gearbox: { gears: [3.5, 2.2, 1.5, 1.15, 0.92, 0.75], reverse: 3.3, finalDrive: null, topSpeedKmh: 185, shiftTime: 0.22, efficiency: 0.85 },
    diff: { lockRatio: 0.3, preload: 60, frontSplit: 0.45 },
    aero: { cda: null, cla: 0.0, balance: 0.5 },
    brakes: { decelG: 1.6, bias: 0.66, handbrake: 3200 },
    audio: { cylinders: 6, base: 0.75, sub: 0.55, rasp: 0.3, cutoff: 0.65, turbo: 0.35, crackle: 0.2 },
  },

  pickup: {
    name: 'pickup',
    label: 'Fieldhand',
    drive: 'RWD',
    color: 0xe8e2d4,
    mass: 1980,
    size: { length: 5.3, width: 2.0, height: 1.86 },
    wheelbase: 3.25,
    track: [1.7, 1.7],
    wheelRadius: 0.39,
    tireWidth: [0.265, 0.265],
    cgHeight: 0.68,
    weightFront: 0.56,
    inertiaScale: { pitch: 1.1, yaw: 1.05, roll: 1.4 },
    collider: { clearance: 0.26, belt: 1.2, cabin: { z0: -0.85, z1: 0.55, top: 1.85, width: 1.74 } },
    suspension: { travel: 0.32, freq: [1.3, 1.4], arb: [0.85, 0.3], rollCenter: [0.32, 0.28], antiPitch: 0.2, bump: 0.3, rebound: 0.5 },
    tire: { mu: 0.95, grip: [1.0, 1.05], peakAngleDeg: 8.5, falloffLat: [1.2, 1.22], latGrip: 1.2 },
    steering: { maxLockDeg: 36, rate: 3.8 },
    engine: {
      idle: 700, redline: 5800, limiter: 6000, inertia: 0.28, brakeFrac: 0.26, stallRpm: 2300,
      curve: [[700, 330], [1800, 460], [3000, 510], [4000, 500], [5000, 450], [6000, 380]],
    },
    gearbox: { gears: [3.2, 2.1, 1.45, 1.1, 0.88, 0.72], reverse: 3.2, finalDrive: null, topSpeedKmh: 175, shiftTime: 0.22, efficiency: 0.86 },
    diff: { lockRatio: 0.2, preload: 40 },
    aero: { cda: null, cla: 0.0, balance: 0.5 },
    brakes: { decelG: 1.6, bias: 0.68, handbrake: 3000 },
    audio: { cylinders: 8, base: 0.72, sub: 0.7, rasp: 0.45, cutoff: 0.7, turbo: 0, crackle: 0.5, lope: 0.5 },
  },

  cruiser: {
    name: 'cruiser',
    label: 'Sentry',
    drive: 'RWD',
    color: 0xf4f4f4,
    color2: 0x111216,
    mass: 1780,
    size: { length: 5.05, width: 1.92, height: 1.46 },
    wheelbase: 2.92,
    track: [1.62, 1.62],
    wheelRadius: 0.34,
    tireWidth: [0.245, 0.255],
    cgHeight: 0.52,
    weightFront: 0.53,
    inertiaScale: { pitch: 1.1, yaw: 1.05, roll: 1.35 },
    collider: { clearance: 0.17, belt: 0.98, cabin: { z0: -0.75, z1: 1.25, top: 1.44, width: 1.56 } },
    suspension: { travel: 0.26, freq: [1.55, 1.65], arb: [0.6, 0.3], rollCenter: [0.16, 0.22], antiPitch: 0.25 },
    tire: { mu: 1.08, grip: [1.0, 1.03] },
    steering: { maxLockDeg: 36, rate: 4.6 },
    engine: {
      idle: 700, redline: 6400, limiter: 6600, inertia: 0.22, brakeFrac: 0.24, stallRpm: 2600,
      curve: [[700, 330], [2000, 460], [3500, 530], [4500, 525], [5600, 480], [6600, 405]],
    },
    gearbox: { gears: [3.0, 2.0, 1.45, 1.12, 0.88, 0.72], reverse: 3.0, finalDrive: null, topSpeedKmh: 232, shiftTime: 0.18, efficiency: 0.87 },
    diff: { lockRatio: 0.35, preload: 80 },
    aero: { cda: null, cla: 0.3, balance: 0.45 },
    audio: { cylinders: 8, base: 0.85, sub: 0.55, rasp: 0.4, cutoff: 0.85, turbo: 0, crackle: 0.4, lope: 0.25 },
  },
};

export const PRESET_ORDER = ['comet', 'muscle', 'super', 'suv', 'pickup', 'cruiser'];

// catalog presets (legacy ids keep their hand-tuned physics above)
for (const id of Object.keys(CATALOG_PRESETS)) if (!VEHICLE_PRESETS[id]) VEHICLE_PRESETS[id] = CATALOG_PRESETS[id];

function mergeDeep(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b || {})) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k])) out[k] = mergeDeep(a[k], v);
    else out[k] = v;
  }
  return out;
}

/** Returns a full preset (defaults merged). Accepts a preset name or object. */
export function resolvePreset(preset) {
  const p = typeof preset === 'string' ? VEHICLE_PRESETS[preset] : preset;
  if (!p) throw new Error(`Unknown vehicle preset: ${preset}`);
  return mergeDeep(base, p);
}
