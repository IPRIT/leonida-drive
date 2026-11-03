// Vehicle catalog: 127 original fictional vehicles (no real brands). Plain data, Node-safe.
// Each entry carries UI/traffic data plus the physics preset + design parameters consumed by deriveSpec(id)
// and buildCarModel(). Brand and model names are invented for Leonida Drive.
import { CALIBRATION, MEASURED } from './calibration.js';
import { Tank } from './tank/Tank.js';
import { buildTankPreview, bakeTank } from './tank/TankModel.js';

const RPM_TO_RAD = (2 * Math.PI) / 60;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- engine / gearbox templates ----------
// curves are normalised torque (peak = 1); `peak` is scaled from the target power.
const ENGINES = {
  i4: { idle: 800, redline: 6800, limiter: 7000, inertia: 0.12, brakeFrac: 0.2, stallRpm: 2600, curve: [[800, 0.62], [2000, 0.82], [3500, 0.96], [4600, 1.0], [5800, 0.95], [6800, 0.82], [7200, 0.7]] },
  i4t: { idle: 800, redline: 6800, limiter: 7000, inertia: 0.12, brakeFrac: 0.2, stallRpm: 2800, curve: [[800, 0.5], [1800, 0.92], [2500, 1.0], [4500, 1.0], [5800, 0.88], [6800, 0.74], [7200, 0.62]] },
  v6: { idle: 750, redline: 7000, limiter: 7200, inertia: 0.16, brakeFrac: 0.22, stallRpm: 2800, curve: [[750, 0.6], [2000, 0.83], [3800, 0.97], [4800, 1.0], [6000, 0.93], [7000, 0.8], [7400, 0.7]] },
  flat6: { idle: 900, redline: 8000, limiter: 8200, inertia: 0.13, brakeFrac: 0.22, stallRpm: 3400, curve: [[900, 0.55], [2200, 0.8], [3800, 0.96], [5200, 1.0], [6500, 0.97], [7600, 0.88], [8400, 0.75]] },
  v8: { idle: 700, redline: 6400, limiter: 6600, inertia: 0.24, brakeFrac: 0.26, stallRpm: 2600, curve: [[700, 0.6], [1800, 0.85], [3200, 1.0], [4200, 0.99], [5400, 0.89], [6400, 0.74], [6800, 0.65]] },
  v8s: { idle: 850, redline: 7600, limiter: 7800, inertia: 0.17, brakeFrac: 0.22, stallRpm: 3200, curve: [[850, 0.55], [2200, 0.82], [3800, 0.97], [5200, 1.0], [6500, 0.95], [7400, 0.85], [8000, 0.74]] },
  v12: { idle: 950, redline: 8600, limiter: 8800, inertia: 0.16, brakeFrac: 0.2, stallRpm: 4000, curve: [[950, 0.55], [2500, 0.8], [4500, 0.95], [6000, 1.0], [7500, 0.96], [8500, 0.86], [9000, 0.76]] },
  electric: { idle: 300, redline: 14000, limiter: 14200, inertia: 0.05, brakeFrac: 0.3, stallRpm: 500, curve: [[0, 1.0], [5200, 1.0], [7000, 0.78], [9000, 0.6], [11000, 0.5], [14000, 0.38], [14500, 0.3]] },
  diesel: { idle: 650, redline: 2400, limiter: 2500, inertia: 1.6, brakeFrac: 0.3, stallRpm: 1200, curve: [[650, 0.55], [1000, 0.9], [1300, 1.0], [1600, 0.97], [2000, 0.82], [2400, 0.66], [2600, 0.55]] },
  dieselLt: { idle: 750, redline: 4300, limiter: 4500, inertia: 0.3, brakeFrac: 0.28, stallRpm: 1900, curve: [[750, 0.55], [1500, 0.95], [2000, 1.0], [2800, 0.98], [3600, 0.85], [4300, 0.68], [4600, 0.55]] },
  moped: { idle: 1700, redline: 8500, limiter: 8800, inertia: 0.02, brakeFrac: 0.12, stallRpm: 4200, curve: [[1700, 0.6], [4000, 0.9], [6000, 1.0], [7500, 0.92], [8500, 0.8], [9000, 0.7]] },
  moto: { idle: 1300, redline: 12500, limiter: 12800, inertia: 0.035, brakeFrac: 0.2, stallRpm: 3500, curve: [[1300, 0.5], [4000, 0.75], [7000, 0.92], [9500, 1.0], [11500, 0.95], [12500, 0.86], [13200, 0.75]] },
  motoTwin: { idle: 900, redline: 6000, limiter: 6200, inertia: 0.06, brakeFrac: 0.25, stallRpm: 2200, curve: [[900, 0.7], [2000, 0.92], [3200, 1.0], [4400, 0.96], [5400, 0.86], [6000, 0.78], [6400, 0.7]] },
  pedal: { idle: 400, redline: 2400, limiter: 2500, inertia: 0.01, brakeFrac: 0.05, stallRpm: 900, curve: [[0, 1.0], [800, 1.0], [1500, 0.92], [2000, 0.8], [2400, 0.66], [2600, 0.55]] },
  cart: { idle: 300, redline: 4000, limiter: 4100, inertia: 0.02, brakeFrac: 0.3, stallRpm: 500, curve: [[0, 1.0], [2500, 1.0], [3500, 0.75], [4000, 0.6], [4200, 0.5]] },
};

const GEARS = {
  4: [2.8, 1.6, 1.1, 0.85],
  5: [3.4, 2.05, 1.42, 1.08, 0.86],
  6: [3.3, 2.1, 1.5, 1.18, 0.96, 0.8],
  7: [3.3, 2.35, 1.8, 1.45, 1.2, 1.0, 0.84],
  8: [4.7, 3.1, 2.1, 1.67, 1.29, 1.0, 0.84, 0.67],
  ev: [1.0],
  truck: [7.5, 5.2, 3.7, 2.7, 2.0, 1.5, 1.15, 0.88],
  bus: [3.4, 2.0, 1.42, 1.0, 0.8, 0.66],
  moto: [2.7, 1.95, 1.56, 1.32, 1.15, 1.03],
  scooter: [1.9, 1.3, 1.0],
  bicycle: [2.2, 1.65, 1.3, 1.05, 0.88, 0.76],
};

const AUDIO = {
  i4: { cylinders: 4, base: 1.15, sub: 0.3, rasp: 0.5, cutoff: 1.05, turbo: 0.35, crackle: 0.4 },
  v6: { cylinders: 6, base: 1.0, sub: 0.4, rasp: 0.45, cutoff: 1.0, turbo: 0.3, crackle: 0.5 },
  v8: { cylinders: 8, base: 0.8, sub: 0.8, rasp: 0.62, cutoff: 0.8, turbo: 0, crackle: 0.9, lope: 0.5 },
  v12: { cylinders: 12, base: 1.3, sub: 0.25, rasp: 0.5, cutoff: 1.35, turbo: 0, crackle: 0.6 },
  electric: { cylinders: 2, base: 1.6, sub: 0.05, rasp: 0.05, cutoff: 1.6, turbo: 0, crackle: 0, electric: 1 },
  diesel: { cylinders: 6, base: 0.55, sub: 0.9, rasp: 0.35, cutoff: 0.55, turbo: 0.6, crackle: 0.1 },
  bus: { cylinders: 6, base: 0.5, sub: 1.0, rasp: 0.3, cutoff: 0.5, turbo: 0.5, crackle: 0.05 },
  moped: { cylinders: 1, base: 1.6, sub: 0.1, rasp: 0.7, cutoff: 1.2, turbo: 0, crackle: 0.2 },
  motorcycle: { cylinders: 4, base: 1.4, sub: 0.25, rasp: 0.6, cutoff: 1.3, turbo: 0, crackle: 0.7 },
  bicycle: { cylinders: 1, base: 0.1, sub: 0, rasp: 0, cutoff: 0.2, turbo: 0, crackle: 0, silent: 1 },
};

// ---------- category physics templates ----------
const CAT = {
  compact: { kind: 'car', mass: 1200, cg: 0.52, wf: 0.61, drive: 'FWD', freq: [1.65, 1.75], arb: [0.7, 0.4], mu: 1.04, lock: 36, brake: 1.6, cla: 0.1, tw: 0.205, susTravel: 0.22, engine: 'i4', gears: 5 },
  sedan: { kind: 'car', mass: 1520, cg: 0.53, wf: 0.57, drive: 'FWD', freq: [1.5, 1.6], arb: [0.65, 0.35], mu: 1.04, lock: 35, brake: 1.6, cla: 0.15, tw: 0.225, susTravel: 0.24, engine: 'i4', gears: 6 },
  coupe: { kind: 'car', mass: 1480, cg: 0.5, wf: 0.55, drive: 'RWD', freq: [1.65, 1.75], arb: [0.6, 0.32], mu: 1.08, lock: 35, brake: 1.65, cla: 0.2, tw: 0.235, susTravel: 0.22, engine: 'v6', gears: 6 },
  sports: { kind: 'car', mass: 1450, cg: 0.46, wf: 0.47, drive: 'RWD', freq: [1.9, 2.0], arb: [0.55, 0.32], mu: 1.17, lock: 34, brake: 1.75, cla: 0.5, tw: [0.245, 0.285], susTravel: 0.2, engine: 'v8s', gears: 7 },
  super: { kind: 'car', mass: 1520, cg: 0.42, wf: 0.42, drive: 'AWD', freq: [2.05, 2.15], arb: [0.5, 0.35], mu: 1.24, lock: 32, brake: 1.85, cla: 1.25, tw: [0.255, 0.325], susTravel: 0.19, engine: 'v12', gears: 7 },
  muscle: { kind: 'car', mass: 1700, cg: 0.53, wf: 0.54, drive: 'RWD', freq: [1.5, 1.55], arb: [0.6, 0.28], mu: 1.12, lock: 33, brake: 1.6, cla: 0.2, tw: [0.245, 0.285], susTravel: 0.25, engine: 'v8', gears: 5 },
  classic: { kind: 'car', mass: 1450, cg: 0.55, wf: 0.54, drive: 'RWD', freq: [1.3, 1.35], arb: [0.55, 0.25], mu: 0.98, lock: 35, brake: 1.4, cla: 0.0, tw: 0.205, susTravel: 0.27, engine: 'v8', gears: 4 },
  suv: { kind: 'car', mass: 2150, cg: 0.72, wf: 0.53, drive: 'AWD', freq: [1.25, 1.35], arb: [0.85, 0.55], mu: 0.98, lock: 35, brake: 1.6, cla: 0.0, tw: 0.265, susTravel: 0.3, engine: 'v6', gears: 8, roll: 0.6 },
  pickup: { kind: 'car', mass: 2200, cg: 0.7, wf: 0.56, drive: 'RWD', freq: [1.3, 1.45], arb: [0.85, 0.3], mu: 0.96, lock: 36, brake: 1.55, cla: 0.0, tw: 0.265, susTravel: 0.32, engine: 'v8', gears: 6, roll: 0.6 },
  van: { kind: 'van', mass: 2250, cg: 0.76, wf: 0.55, drive: 'FWD', freq: [1.35, 1.5], arb: [0.85, 0.5], mu: 0.95, lock: 37, brake: 1.5, cla: 0.0, tw: 0.235, susTravel: 0.28, engine: 'v6', gears: 6, roll: 0.75 },
  luxury: { kind: 'car', mass: 2350, cg: 0.55, wf: 0.52, drive: 'RWD', freq: [1.2, 1.25], arb: [0.7, 0.4], mu: 1.03, lock: 35, brake: 1.6, cla: 0.15, tw: 0.255, susTravel: 0.26, engine: 'v12', gears: 8 },
  service: { kind: 'car', mass: 1800, cg: 0.55, wf: 0.54, drive: 'RWD', freq: [1.55, 1.65], arb: [0.6, 0.3], mu: 1.08, lock: 36, brake: 1.65, cla: 0.3, tw: 0.245, susTravel: 0.26, engine: 'v8', gears: 6 },
  truck: { kind: 'truck', mass: 9500, cg: 1.2, wf: 0.42, drive: 'RWD', freq: [1.35, 1.5], arb: [1.2, 1.0], mu: 0.88, lock: 42, brake: 0.95, cla: 0, tw: [0.315, 0.62], susTravel: 0.26, engine: 'diesel', gears: 'truck', roll: 1.0 },
  bus: { kind: 'bus', mass: 12500, cg: 1.15, wf: 0.36, drive: 'RWD', freq: [1.15, 1.25], arb: [1.2, 1.0], mu: 0.88, lock: 45, brake: 0.95, cla: 0, tw: [0.3, 0.6], susTravel: 0.24, engine: 'diesel', gears: 'bus', roll: 1.0 },
  small: { kind: 'small', mass: 700, cg: 0.5, wf: 0.5, drive: 'RWD', freq: [1.7, 1.8], arb: [0.6, 0.4], mu: 0.98, lock: 38, brake: 1.4, cla: 0, tw: 0.155, susTravel: 0.16, engine: 'i4', gears: 4, roll: 0.6 },
  motorcycle: { kind: 'motorcycle', mass: 290, cg: 0.66, wf: 0.5, drive: 'RWD', freq: [1.9, 2.0], arb: [0, 0], mu: 1.15, lock: 32, brake: 1.15, cla: 0, tw: [0.12, 0.18], susTravel: 0.14, engine: 'moto', gears: 'moto' },
  bicycle: { kind: 'bicycle', mass: 88, cg: 0.85, wf: 0.42, drive: 'RWD', freq: [2.4, 2.4], arb: [0, 0], mu: 1.05, lock: 35, brake: 0.8, cla: 0, tw: [0.035, 0.035], susTravel: 0.06, engine: 'pedal', gears: 'bicycle' },
};

function peakTorqueFor(engine, kw) {
  let best = 0;
  for (const [rpm, t] of engine.curve) best = Math.max(best, t * rpm * RPM_TO_RAD);
  return (kw * 1000) / Math.max(1, best);
}

/** Build the physics preset for a catalog entry. */
function buildPreset(e) {
  const c = CAT[e.category === 'service' && e.base ? e.base : e.category] || CAT.sedan;
  const o = e._o;
  const L = o.L, W = o.W, H = o.H;
  const r = o.r ?? 0.33;
  const twRaw = o.tw ?? c.tw;
  const tw = Array.isArray(twRaw) ? twRaw : [twRaw, twRaw];
  const bike = e.kind === 'motorcycle' || e.kind === 'bicycle';
  const track = bike ? [0, 0] : o.track ?? [W - tw[0] - (o.trackGap ?? 0.12), W - tw[1] - (o.trackGap ?? 0.12)];
  const engT = ENGINES[o.engine || c.engine];
  const eng = JSON.parse(JSON.stringify(engT));
  const peak = peakTorqueFor(engT, o.kw ?? 120) * (CALIBRATION[e.id] ?? 1);
  eng.curve = engT.curve.map(([rpm, t]) => [rpm, t * peak]);
  if (o.redline) {
    const k = o.redline / eng.redline;
    eng.curve = eng.curve.map(([rpm, t]) => [rpm * k, t / k]);
    eng.idle = Math.round(eng.idle * Math.min(1.2, k));
    eng.redline = o.redline;
    eng.limiter = Math.round(o.redline * 1.03);
    eng.stallRpm = Math.round(eng.stallRpm * k);
  }
  const gearsKey = o.gears ?? c.gears;
  const gears = (Array.isArray(gearsKey) ? gearsKey : GEARS[gearsKey]).slice();
  const mass = o.m ?? c.mass;
  const moto = e.kind === 'motorcycle';
  // motorcycles: centre of mass a little lower (rider tucked in) for a planted ride over bumps
  const cg = (o.cg ?? c.cg) * (moto ? 0.9 : 1);
  const style = o.d?.style;
  const sill = o.d?.sill ?? (bike ? 0.25 : clamp(r * (e.kind === 'truck' || e.kind === 'bus' ? 0.9 : style === 'suv' || style === 'offroad' || style === 'pickup' ? 0.85 : 0.58), 0.12, 0.8));
  const belt = bike ? H * 0.55 : e.kind === 'truck' || e.kind === 'bus' ? H * 0.5 : H * 0.64;
  const wb = o.wb;
  const ohF = (L - wb) * (o.d?.ohFrac ?? 0.46);
  const zF = -wb / 2 - ohF;
  const cabZ0 = e.kind === 'bus' ? zF + 0.2 : e.kind === 'truck' ? zF + (o.d?.cab === 'cabover' ? 0.1 : 1.6) : -wb / 2 + (o.d?.aOff ?? wb * 0.36) + 0.1;
  const cabZ1 = e.kind === 'bus' ? L / 2 - 0.3 : e.kind === 'truck' ? cabZ0 + 2.1 : Math.min(L / 2 - 0.3, cabZ0 + (L * 0.42));
  const p = {
    name: e.id,
    label: e.name,
    displayName: `${e.brand} ${e.name}`,
    kind: e.kind,
    drive: o.drive ?? c.drive,
    color: e.palette[0],
    color2: o.color2 ?? e.palette2 ?? 0x15161a,
    mass,
    size: { length: L, width: W, height: H },
    wheelbase: wb,
    track,
    wheelRadius: r,
    tireWidth: tw,
    cgHeight: cg,
    weightFront: o.wf ?? c.wf,
    inertiaScale: { pitch: 1.1, yaw: 1.05, roll: e.kind === 'truck' || e.kind === 'bus' ? 1.6 : 1.35 },
    wheelLayout: bike ? 'bike' : 'car',
    collider: {
      clearance: Math.max(0.12, sill - 0.02),
      belt: Math.max(sill + 0.25, belt),
      cabin: { z0: cabZ0, z1: Math.max(cabZ0 + 0.6, cabZ1), top: H, width: bike ? Math.min(0.55, W) : Math.max(0.6, W - 0.28) },
    },
    suspension: {
      travel: o.travel ?? (moto ? 0.12 : c.susTravel),
      freq: o.freq ?? c.freq,
      // motorcycles: near-critical damping and a damped bump stop (no pogo after bumps or landings)
      ...(moto ? { bump: 0.6, rebound: 0.9, bumpStop: 0.03, bumpStopDamping: 2.5, reboundClamp: 0.8 } : {}),
      arb: o.arb ?? c.arb,
      rollCenter: bike ? [cg, cg] : [Math.min(0.35, cg * 0.32), Math.min(0.4, cg * 0.4)],
      antiPitch: bike ? 0.15 : 0.25,
    },
    tire: { mu: o.mu ?? c.mu, grip: [1.0, o.gripR ?? 1.03] },
    steering: { maxLockDeg: o.lock ?? c.lock, rate: o.steerRate ?? (e.kind === 'truck' || e.kind === 'bus' ? 3.2 : 4.6) },
    engine: eng,
    gearbox: {
      gears, reverse: gears[0] * 0.95, finalDrive: null, topSpeedKmh: e.topSpeedKmh,
      shiftTime: o.shift ?? (e.kind === 'truck' || e.kind === 'bus' ? 0.32 : gears.length === 1 ? 0.05 : 0.18), efficiency: 0.88,
    },
    diff: { lockRatio: o.lsd ?? 0.3, preload: 60, frontSplit: o.split ?? 0.42 },
    // supercars / sports cars: more downforce (∝ v²) with a slightly rearward balance, planted at 200+ km/h
    aero: { cda: null, cla: (o.cla ?? (moto ? 0.25 : c.cla)) * (e.category === 'super' ? 1.6 : e.category === 'sports' ? 1.3 : 1), balance: e.category === 'super' || e.category === 'sports' ? 0.42 : 0.45 },
    brakes: { decelG: o.brake ?? c.brake, bias: bike ? 0.7 : 0.64, handbrake: e.kind === 'truck' || e.kind === 'bus' ? 30000 : bike ? 600 : 2800 },
    audio: { ...AUDIO[e.engineSound] },
    rollAssist: o.roll ?? c.roll ?? 0.35,
    design: o.d ? { ...o.d } : undefined,
  };
  if (o.ph) Object.assign(p, o.ph);
  if (bike) {
    p.bike = { maxLeanDeg: o.lean ?? (e.kind === 'bicycle' ? 38 : 48), leanRate: o.leanRate ?? 3.2, wheelie: !!o.wheelie, kickstand: e.kind === 'bicycle' ? 9 : 12 };
  }
  return p;
}

// ---------- entries ----------

const RAW = [];
/**
 * id, brand, name, category, o: { L,W,H,wb,r,tw, m, kw, top, acc, seats, snd, pal, tier, rar, price, traffic, desc, d (design), ... }
 */
function V(id, brand, name, category, o) {
  RAW.push({ id, brand, name, category, o });
}

// ---- compact / hatch ----
V('pip', 'Palmetto', 'Pip', 'compact', {
  L: 3.62, W: 1.66, H: 1.5, wb: 2.36, r: 0.29, m: 980, kw: 55, top: 158, acc: 13.5, seats: 4, snd: 'i4', tier: 0.12, rar: 0.1, price: 13900, traffic: 1.3,
  pal: [0x9fe2c8, 0xff7a6b, 0x8cc8f0, 0xf1e6c8, 0xf4f4f2, 0xd2293a], desc: 'Bubbly three-door city hatch. Parks anywhere, scared of nothing.',
  d: { style: 'hatch', doors: 2, head: 'round', headR: 0.085, grille: 'slot', rim: 'steel', rimColor: 'dark', mirrors: 'dark', taperF: 0.11, taperR: 0.07, noseY: 0.72, beltF: 0.9, beltR: 0.92, tailY: 0.92, roofRound: 0.16, fbumper: 'body', twoTone: 'roof', twoToneColor: 0xf4f4f2 },
});
V('sprig', 'Palmetto', 'Sprig', 'compact', {
  L: 4.05, W: 1.72, H: 1.48, wb: 2.56, r: 0.3, m: 1120, kw: 74, top: 178, acc: 11.4, seats: 5, snd: 'i4', tier: 0.2, rar: 0.05, price: 17500, traffic: 1.6,
  pal: [0xc7cbd1, 0x2a5aa8, 0xf4f4f2, 0x7a1f2b, 0x3b3f45, 0x6aa3b8], desc: 'The five-door everybody owns. Honest, frugal, forgettable in the best way.',
  d: { style: 'hatch', head: 'wrap', headW: 0.36, grille: 'bars', grilleMat: 'trim', tail: 'wrap', rim: 'multi', rimColor: 'silver', spokes: 10 },
});
V('zephir_rs', 'Belcour', 'Zéphir RS', 'compact', {
  L: 4.02, W: 1.8, H: 1.42, wb: 2.54, r: 0.315, tw: 0.225, m: 1250, kw: 165, top: 238, acc: 6.4, seats: 4, snd: 'i4', engine: 'i4t', tier: 0.45, rar: 0.4, price: 33900, traffic: 0.45,
  pal: [0x1f4fd8, 0xf2c014, 0xd8202c, 0xf4f4f2, 0x18191c], desc: 'Hot hatch with a cheeky roof wing and a front axle that refuses to understeer.',
  mu: 1.1, freq: [1.85, 2.0],
  d: { style: 'hatch', doors: 2, head: 'blade', grille: 'mesh', fbumper: 'sport', wing: 'roof', exhaust: 'center', rim: 'split', rimColor: 'dark', stripe: 'side', diffuser: true, skirt: true },
});
V('citadine', 'Belcour', 'Citadine', 'compact', {
  L: 3.98, W: 1.74, H: 1.5, wb: 2.54, r: 0.3, m: 1150, kw: 81, top: 182, acc: 11.0, seats: 5, snd: 'i4', tier: 0.25, rar: 0.15, price: 19900, traffic: 1.0,
  pal: [0xd94f3a, 0xf4f4f2, 0x7fb6c9, 0xe6c34a, 0x3a3f46], palette2: 0xf4f4f2, desc: 'Curvy French five-door with a contrast roof and a ride like a sofa.',
  freq: [1.45, 1.55],
  d: { style: 'hatch', head: 'wrap', headH: 0.15, headW: 0.34, grille: 'wide', grilleMat: 'trim', tail: 'vertical', taperF: 0.13, taperR: 0.09, noseRound: 0.12, roofRound: 0.18, bevel: 0.09, twoTone: 'roof', rim: 'multi', rimColor: 'dark', crown: 0.03 },
});
V('hikari', 'Kazemoto', 'Hikari', 'compact', {
  L: 4.32, W: 1.8, H: 1.44, wb: 2.7, r: 0.31, m: 1280, kw: 130, top: 205, acc: 8.4, seats: 5, snd: 'i4', engine: 'i4t', tier: 0.3, rar: 0.05, price: 24800, traffic: 1.5,
  pal: [0xf4f4f2, 0xb81c25, 0x1c2b4a, 0x9da3ab, 0x2b2d31], desc: 'Sharp-suited Japanese hatch, quick enough to embarrass bigger cars at the lights.',
  d: { style: 'hatch', head: 'blade', tail: 'slim', grille: 'wide', grilleMat: 'trim', rim: 'multi', rimColor: 'dark', backRun: 0.45, tailRake: 0.25 },
});
V('mochi', 'Hoshiro', 'Mochi', 'compact', {
  L: 3.92, W: 1.7, H: 1.66, wb: 2.53, r: 0.3, m: 1150, kw: 80, top: 170, acc: 12.0, seats: 5, snd: 'i4', tier: 0.25, rar: 0.25, price: 19900, traffic: 0.9,
  pal: [0xd9cdb4, 0x6c8a6e, 0x86a7c9, 0xf4f4f2, 0x7b5c45], desc: 'A friendly box on wheels with more headroom than a cathedral.',
  d: { style: 'wagon', roofRound: 0.08, taperF: 0.03, taperR: 0.01, tailRake: 0.0, backRun: 0.04, noseY: 0.76, beltF: 0.95, beltR: 0.95, tailY: 0.95, head: 'rect', headH: 0.14, grille: 'slot', tail: 'vertical', rim: 'disc', rimColor: 'silver', crown: 0, wsRun: 0.5, aOff: 0.15, ohFrac: 0.55, pillars: 'dark' },
});
V('nuri', 'Hanbit', 'Nuri', 'compact', {
  L: 4.12, W: 1.77, H: 1.47, wb: 2.62, r: 0.31, m: 1210, kw: 90, top: 188, acc: 10.4, seats: 5, snd: 'i4', tier: 0.22, rar: 0.08, price: 18900, traffic: 1.4,
  pal: [0x2f6fb5, 0xf4f4f2, 0xc7cbd1, 0x8a1b25, 0x1b1d22, 0xe28a2b], desc: 'Value-packed Korean hatch with a warranty longer than most marriages.',
  d: { style: 'hatch', head: 'rect', headW: 0.38, headH: 0.1, grille: 'mesh', tail: 'block', rim: 'star', spokes: 5, rimColor: 'silver', backRun: 0.3 },
});
V('kade', 'Rennwerk', 'Kade', 'compact', {
  L: 4.32, W: 1.8, H: 1.43, wb: 2.69, r: 0.32, tw: 0.225, m: 1380, kw: 165, top: 245, acc: 6.5, seats: 5, snd: 'i4', engine: 'i4t', drive: 'RWD', wf: 0.52, tier: 0.6, rar: 0.25, price: 38500, traffic: 0.6,
  pal: [0x1f2f4f, 0xf4f4f2, 0x1b1d22, 0x8a919c, 0xb3202e], desc: 'Premium rear-drive hatch: long bonnet, small boot, big attitude.',
  d: { style: 'hatch', aOff: 0.42, head: 'blade', grille: 'twin', tail: 'slim', rim: 'star', spokes: 5, rimColor: 'silver', exhaust: 'twin', backRun: 0.32 },
});
V('pebble', 'Lumo', 'Pebble', 'compact', {
  L: 4.1, W: 1.8, H: 1.56, wb: 2.75, r: 0.32, m: 1620, kw: 150, top: 160, acc: 7.4, seats: 5, snd: 'electric', engine: 'electric', gears: 'ev', tier: 0.4, rar: 0.2, price: 34000, traffic: 0.9,
  pal: [0xe8eef2, 0x5fb8a8, 0x2a3442, 0xf0b24a, 0x9aa7b4], desc: 'Electric hatch shaped like a river stone. Hums, glides, never stops at the pump.',
  d: { style: 'hatch', head: 'slit', drl: 'bar', grille: 'none', tail: 'bar', pillars: 'dark', roof: 'glass', rim: 'disc', rimColor: 'white', noseRound: 0.14, roofRound: 0.18, taperF: 0.12, exhaust: 'none', ohFrac: 0.52 },
});
V('tanuki_r', 'Kazemoto', 'Tanuki R', 'compact', {
  L: 4.36, W: 1.84, H: 1.46, wb: 2.67, r: 0.33, tw: 0.245, m: 1450, kw: 225, top: 250, acc: 4.9, seats: 5, snd: 'i4', engine: 'i4t', drive: 'AWD', split: 0.45, tier: 0.55, rar: 0.5, price: 47000, traffic: 0.25,
  pal: [0x1f3fa8, 0xf4f4f2, 0xd8202c, 0x18191c, 0x9aa1aa], desc: 'Rally-bred AWD hatch. Gravel, tarmac, supermarket car park — all special stages.',
  mu: 1.14, freq: [1.8, 1.9],
  d: { style: 'hatch', head: 'blade', grille: 'mesh', fbumper: 'sport', hood: 'scoop', wing: 'roof', rim: 'multi', rimColor: 'gold', exhaust: 'center', fogs: true, skirt: true, hips: 0.025 },
});

// ---- sedans ----
V('meridian', 'Palmetto', 'Meridian', 'sedan', {
  L: 4.62, W: 1.78, H: 1.45, wb: 2.7, r: 0.31, m: 1300, kw: 102, top: 195, acc: 10.2, seats: 5, snd: 'i4', tier: 0.22, rar: 0.03, price: 21500, traffic: 2.0,
  pal: [0xc7cbd1, 0xf4f4f2, 0x1b1d22, 0x5b6470, 0x7a1f2b, 0x2d4d7a, 0xd8cfc0], desc: 'The default sedan of Leonida. Rental lots are 40% Meridian by weight.',
  d: { style: 'sedan', head: 'wrap', grille: 'bars', tail: 'wrap', rim: 'multi', rimColor: 'silver', spokes: 10 },
});
V('crestline', 'Palmetto', 'Crestline', 'sedan', {
  L: 5.38, W: 1.98, H: 1.46, wb: 2.91, r: 0.34, m: 1820, kw: 180, top: 205, acc: 8.8, seats: 6, snd: 'v8', engine: 'v8', drive: 'RWD', gears: 4, tier: 0.3, rar: 0.1, price: 29000, traffic: 1.0,
  pal: [0x1b1d22, 0xf4f4f2, 0x8a8f96, 0x2b3a55, 0x5a1a22, 0x3e4a3d], desc: 'Body-on-frame V8 barge. Cabbies and cops swear by it; mechanics swear at it.',
  freq: [1.35, 1.4],
  d: { style: 'sedan', head: 'rect', headW: 0.42, headH: 0.13, grille: 'big', tail: 'block', tailW: 0.42, rim: 'steel', rimColor: 'silver', noseRake: 0.04, tailRake: 0.02, taperF: 0.03, taperR: 0.02, bevel: 0.05, roofRound: 0.1, rearLen: 1.25, markers: true },
});
V('sora', 'Hanbit', 'Sora', 'sedan', {
  L: 4.9, W: 1.86, H: 1.45, wb: 2.84, r: 0.33, m: 1480, kw: 140, top: 210, acc: 8.6, seats: 5, snd: 'i4', engine: 'i4t', tier: 0.35, rar: 0.08, price: 27500, traffic: 1.4,
  pal: [0xf4f4f2, 0x3b4452, 0x8a1b25, 0x2a5aa8, 0xc7cbd1, 0x1b1d22], desc: 'Swoopy mid-size sedan pretending, rather convincingly, to be a coupe.',
  d: { style: 'sedan', head: 'blade', drl: 'bar', grille: 'wide', grilleMat: 'trim', tail: 'bar', backRun: 0.95, rearLen: 0.75, rim: 'multi', rimColor: 'dark', pillars: 'dark' },
});
V('aster', 'Hoshiro', 'Aster', 'sedan', {
  L: 4.88, W: 1.84, H: 1.45, wb: 2.82, r: 0.33, m: 1500, kw: 150, top: 210, acc: 8.3, seats: 5, snd: 'i4', tier: 0.33, rar: 0.03, price: 26900, traffic: 1.8,
  pal: [0xc7cbd1, 0xf4f4f2, 0x1b1d22, 0x6a1820, 0x3f5468, 0xa89a82], desc: 'Bulletproof family sedan. Will outlive its owner and probably its owner’s kids.',
  d: { style: 'sedan', head: 'blade', grille: 'wide', grilleMat: 'dark', tail: 'slim', rim: 'multi', rimColor: 'silver', spokes: 10 },
});
V('seiran', 'Kazemoto', 'Seiran', 'sedan', {
  L: 4.6, W: 1.8, H: 1.47, wb: 2.65, r: 0.32, tw: 0.245, m: 1500, kw: 228, top: 255, acc: 4.9, seats: 5, snd: 'i4', engine: 'i4t', drive: 'AWD', split: 0.45, tier: 0.45, rar: 0.4, price: 39000, traffic: 0.35,
  pal: [0x1f3fa8, 0xf4f4f2, 0x18191c, 0x9aa1aa, 0xb81c25], desc: 'Four-door rally weapon with a bonnet scoop and a wing you can see from space.',
  mu: 1.14, freq: [1.8, 1.9],
  d: { style: 'sedan', head: 'rect', headW: 0.4, headH: 0.1, grille: 'mesh', fbumper: 'sport', hood: 'scoop', wing: 'wing', exhaust: 'quad', rim: 'multi', rimColor: 'gold', fogs: true, skirt: true },
});
V('kanzler', 'Rennwerk', 'Kanzler', 'sedan', {
  L: 5.05, W: 1.9, H: 1.47, wb: 3.0, r: 0.34, tw: 0.245, m: 1780, kw: 250, top: 250, acc: 5.4, seats: 5, snd: 'v6', engine: 'i4t', drive: 'RWD', gears: 8, tier: 0.75, rar: 0.25, price: 62000, traffic: 0.7,
  pal: [0x1b1d22, 0xf4f4f2, 0x3b4452, 0x8a919c, 0x1f2f4f, 0x5d6b78], desc: 'Executive sedan for people who pretend they enjoy driving to meetings.',
  d: { style: 'sedan', head: 'blade', grille: 'twin', tail: 'slim', rim: 'multi', rimColor: 'silver', aOff: 0.55, exhaust: 'dual' },
});
V('kanzler_s', 'Rennwerk', 'Kanzler S', 'sedan', {
  L: 5.1, W: 1.94, H: 1.46, wb: 3.0, r: 0.35, tw: [0.275, 0.315], m: 1900, kw: 460, top: 305, acc: 3.4, seats: 5, snd: 'v8', engine: 'v8s', drive: 'AWD', split: 0.35, gears: 8, tier: 0.88, rar: 0.6, price: 118000, traffic: 0.15,
  pal: [0x2b3a55, 0x1b1d22, 0x8a919c, 0x2f4a3a, 0xf4f4f2], desc: 'The executive express. Briefcase in the boot, 460 kW under the bonnet.',
  mu: 1.18, cla: 0.35, freq: [1.7, 1.8],
  d: { style: 'sedan', head: 'blade', grille: 'twin', fbumper: 'sport', tail: 'slim', wing: 'lip', exhaust: 'quad', diffuser: true, rim: 'split', rimColor: 'dark', sideVent: true, hood: 'bulge', aOff: 0.55, roof: 'vinyl' },
});
V('tarpon', 'Marlin', 'Tarpon', 'sedan', {
  L: 5.1, W: 1.9, H: 1.48, wb: 3.05, r: 0.35, tw: [0.245, 0.275], m: 1850, kw: 280, top: 250, acc: 5.5, seats: 5, snd: 'v8', engine: 'v8', drive: 'RWD', gears: 8, tier: 0.4, rar: 0.2, price: 41000, traffic: 0.9,
  pal: [0x1b1d22, 0xb3202e, 0xf4f4f2, 0x3a3f46, 0x2a4f9a, 0x5b2a8c], desc: 'Four doors, one V8, zero apologies. The family car of choice for getaway drivers.',
  d: { style: 'sedan', head: 'slit', grille: 'mesh', tail: 'bar', hood: 'bulge', rim: 'split', rimColor: 'dark', exhaust: 'dual', bevel: 0.06, quarter: 0.2, taperF: 0.04 },
});
V('fjell', 'Nordvik', 'Fjell', 'sedan', {
  L: 4.95, W: 1.88, H: 1.48, wb: 2.94, r: 0.34, m: 1820, kw: 220, top: 240, acc: 6.1, seats: 5, snd: 'i4', engine: 'i4t', drive: 'AWD', gears: 8, tier: 0.65, rar: 0.25, price: 56000, traffic: 0.6,
  pal: [0x8a919c, 0x2b3a55, 0xf4f4f2, 0x3e4a3d, 0x1b1d22, 0x7a5a45], desc: 'Scandinavian estate. Fits a wardrobe, a dog and a sense of moral superiority.',
  d: { style: 'wagon', head: 'blade', drl: 'bar', grille: 'vbars', tail: 'vertical', roof: 'rails', rim: 'multi', rimColor: 'silver', tailRake: 0.1, backRun: 0.2 },
});
V('halo', 'Lumo', 'Halo', 'sedan', {
  L: 4.75, W: 1.86, H: 1.44, wb: 2.88, r: 0.33, tw: 0.235, m: 1850, kw: 340, top: 225, acc: 3.9, seats: 5, snd: 'electric', engine: 'electric', gears: 'ev', drive: 'AWD', tier: 0.6, rar: 0.2, price: 52000, traffic: 0.8,
  pal: [0xf4f4f2, 0x1b1d22, 0x9aa1aa, 0xb3202e, 0x2d4d8a], desc: 'Silent electric fastback. The roof is glass, the grille is a rumour.',
  d: { style: 'sedan', head: 'slit', drl: 'bar', grille: 'none', tail: 'bar', roof: 'glass', pillars: 'dark', rim: 'disc', rimColor: 'dark', exhaust: 'none', noseRound: 0.12, backRun: 0.95, rearLen: 0.75 },
});
V('serena', 'Tessaro', 'Serena', 'sedan', {
  L: 4.65, W: 1.87, H: 1.43, wb: 2.82, r: 0.34, tw: [0.245, 0.285], m: 1650, kw: 375, top: 307, acc: 3.9, seats: 5, snd: 'v6', engine: 'v6', drive: 'RWD', gears: 8, tier: 0.8, rar: 0.55, price: 82000, traffic: 0.15,
  pal: [0xb3202e, 0xf4f4f2, 0x2f4a3a, 0x1b1d22, 0x2a4f9a], desc: 'Italian sports sedan with a shield grille and a temper to match.',
  mu: 1.16, freq: [1.75, 1.85],
  d: { style: 'sedan', head: 'blade', grille: 'shield', fbumper: 'sport', tail: 'block', exhaust: 'quad', rim: 'mesh', rimColor: 'dark', diffuser: true, aOff: 0.48, backRun: 0.8, rearLen: 0.72 },
});
V('ambassade', 'Belcour', 'Ambassade', 'sedan', {
  L: 4.92, W: 1.86, H: 1.46, wb: 2.9, r: 0.33, m: 1700, kw: 180, top: 230, acc: 7.6, seats: 5, snd: 'v6', engine: 'v6', tier: 0.6, rar: 0.4, price: 48000, traffic: 0.4,
  pal: [0x3b4452, 0xd8cfc0, 0x1b1d22, 0x6d1f2a, 0xc7cbd1], desc: 'French executive cruiser with a concave rear window and a ride like warm butter.',
  freq: [1.25, 1.3],
  d: { style: 'sedan', head: 'wrap', headW: 0.42, headH: 0.1, grille: 'wide', tail: 'bar', taperF: 0.1, taperR: 0.08, noseRake: 0.18, backRun: 1.0, rearLen: 0.85, rim: 'disc', rimColor: 'silver', beltTrim: 'chrome' },
});

// ---- coupes ----
V('kaida', 'Kazemoto', 'Kaida', 'coupe', {
  L: 4.52, W: 1.81, H: 1.27, wb: 2.55, r: 0.33, tw: [0.235, 0.265], m: 1500, kw: 206, top: 250, acc: 5.4, seats: 4, snd: 'v6', engine: 'i4t', redline: 7000, tier: 0.45, rar: 0.5, price: 39000, traffic: 0.3,
  pal: [0xd8202c, 0xf4f4f2, 0x18191c, 0x2a4f9a, 0xe8c547], desc: 'Nineties turbo coupe. Tuner magazines still have its poster on the wall.',
  mu: 1.12,
  d: { style: 'fastback', head: 'wrap', headW: 0.4, headH: 0.09, grille: 'slot', tail: 'round', tailRound4: true, wing: 'wing', rim: 'star', spokes: 5, rimColor: 'silver', exhaust: 'single', noseRake: 0.18, rearLen: 0.7, backRun: 0.95 },
});
V('byeol', 'Hanbit', 'Byeol', 'coupe', {
  L: 4.65, W: 1.86, H: 1.38, wb: 2.82, r: 0.33, tw: [0.225, 0.245], m: 1520, kw: 180, top: 240, acc: 6.6, seats: 4, snd: 'v6', tier: 0.4, rar: 0.25, price: 32000, traffic: 0.5,
  pal: [0xe24a1e, 0xf4f4f2, 0x1b1d22, 0x2a5aa8, 0x8a919c], desc: 'Affordable rear-drive coupe for people who like their weekdays sideways.',
  d: { style: 'coupe', head: 'blade', grille: 'wide', grilleMat: 'trim', tail: 'slim', rim: 'multi', rimColor: 'dark', exhaust: 'dual', wing: 'lip' },
});
V('kurve', 'Rennwerk', 'Kurve', 'coupe', {
  L: 4.78, W: 1.85, H: 1.38, wb: 2.85, r: 0.33, m: 1640, kw: 240, top: 250, acc: 5.2, seats: 4, snd: 'v6', engine: 'i4t', gears: 8, tier: 0.7, rar: 0.3, price: 58000, traffic: 0.45,
  pal: [0xf4f4f2, 0x2a4f9a, 0x1b1d22, 0x8a919c, 0x7a1f2b], desc: 'Premium coupe with frameless windows and a kidney grille you could post letters through.',
  d: { style: 'coupe', head: 'blade', grille: 'twin', tail: 'block', rim: 'star', spokes: 5, rimColor: 'silver', aOff: 0.55, beltTrim: 'chrome', exhaust: 'dual' },
});
V('breeze', 'Palmetto', 'Breeze', 'coupe', {
  L: 4.42, W: 1.72, H: 1.37, wb: 2.62, r: 0.3, m: 1180, kw: 95, top: 195, acc: 9.4, seats: 4, snd: 'i4', drive: 'FWD', tier: 0.18, rar: 0.15, price: 16500, traffic: 0.9,
  pal: [0x7fb6c9, 0xf4f4f2, 0xd8202c, 0x1b1d22, 0xe8c547, 0x5b6470], desc: 'Cheap two-door with a sporty profile and absolutely no sporting intentions.',
  d: { style: 'coupe', head: 'wrap', grille: 'bars', grilleMat: 'trim', tail: 'block', rim: 'steel', rimColor: 'silver', spokes: 5 },
});
V('lucciola', 'Tessaro', 'Lucciola', 'coupe', {
  L: 4.92, W: 1.92, H: 1.36, wb: 2.94, r: 0.34, tw: [0.245, 0.285], m: 1800, kw: 340, top: 300, acc: 4.6, seats: 4, snd: 'v8', engine: 'v8s', tier: 0.85, rar: 0.55, price: 135000, traffic: 0.12,
  pal: [0x1f2f4f, 0xb3202e, 0xf4f4f2, 0x3a3f46, 0xd8cfc0], desc: 'Italian GT coupe. Sings at 7000 rpm, sulks in traffic, forgiven instantly.',
  mu: 1.12, cla: 0.3,
  d: { style: 'coupe', head: 'blade', grille: 'egg', tail: 'block', rim: 'multi', rimColor: 'chrome', aOff: 0.72, backRun: 0.95, rearLen: 0.7, exhaust: 'quad', hips: 0.03, taperF: 0.1 },
});
V('fugue', 'Belcour', 'Fugue', 'coupe', {
  L: 4.3, W: 1.84, H: 1.36, wb: 2.61, r: 0.33, tw: 0.235, m: 1360, kw: 147, top: 235, acc: 7.4, seats: 2, snd: 'i4', engine: 'i4t', drive: 'FWD', tier: 0.45, rar: 0.5, price: 34000, traffic: 0.25,
  pal: [0xf4f4f2, 0xb3202e, 0x18191c, 0x3a5aa0, 0xd8a24a], desc: 'Double-bubble French coupe with a silver roof arch and a lot of style per kilo.',
  d: { style: 'fastback', head: 'wrap', headH: 0.11, grille: 'wide', tail: 'slim', roof: 'vinyl', pillars: 'dark', rim: 'split', rimColor: 'silver', taperR: 0.1, hips: 0.03 },
});
V('kumo', 'Hoshiro', 'Kumo', 'coupe', {
  L: 4.82, W: 1.82, H: 1.42, wb: 2.75, r: 0.33, m: 1500, kw: 200, top: 235, acc: 6.4, seats: 4, snd: 'v6', drive: 'FWD', tier: 0.35, rar: 0.2, price: 29900, traffic: 0.6,
  pal: [0xc7cbd1, 0x1b1d22, 0xf4f4f2, 0x6a1820, 0x3f5468], desc: 'Grown-up two-door with a V6 and a boot big enough for actual luggage.',
  d: { style: 'coupe', head: 'rect', headW: 0.4, headH: 0.1, grille: 'bars', tail: 'block', rim: 'multi', rimColor: 'silver' },
});
V('chantry', 'Kestrel', 'Chantry', 'coupe', {
  L: 4.55, W: 1.94, H: 1.27, wb: 2.7, r: 0.34, tw: [0.255, 0.295], m: 1580, kw: 375, top: 314, acc: 3.7, seats: 2, snd: 'v8', engine: 'v8s', tier: 0.88, rar: 0.6, price: 146000, traffic: 0.1,
  pal: [0x2f4a3a, 0xc8ccd2, 0x1b1d22, 0x8a1b25, 0xe6e3da], desc: 'British grand tourer. Long bonnet, short temper, impeccable manners.',
  mu: 1.15, cla: 0.45,
  d: { style: 'fastback', head: 'blade', grille: 'wide', tail: 'slim', wing: 'duck', hips: 0.035, rim: 'multi', rimColor: 'dark', aOff: 0.75, wsRun: 0.82, exhaust: 'quad', sideVent: true },
});

// ---- sports ----
V('shiden_legacy', '', '', 'sports', { legacy: 'comet' });
V('orkan', 'Falkner', 'Orkan', 'sports', {
  L: 4.52, W: 1.85, H: 1.3, wb: 2.45, r: 0.34, tw: [0.245, 0.305], m: 1505, kw: 283, top: 293, acc: 4.2, seats: 4, snd: 'v6', engine: 'flat6', wf: 0.39, tier: 0.8, rar: 0.4, price: 112000, traffic: 0.25,
  pal: [0xc8ccd2, 0x1b1d22, 0xf4f4f2, 0x2d5fa8, 0xe8c547, 0x9b1b22], desc: 'Rear-engined icon. Sixty years of polishing the same brilliant idea.',
  layout: 'rear',
  d: { style: 'rear', tail: 'bar', wing: 'lip', rim: 'multi', rimColor: 'silver', exhaust: 'twin' },
});
V('orkan_ts', 'Falkner', 'Orkan TS', 'sports', {
  L: 4.55, W: 1.9, H: 1.3, wb: 2.45, r: 0.345, tw: [0.255, 0.315], m: 1640, kw: 478, top: 330, acc: 2.7, seats: 4, snd: 'v6', engine: 'flat6', drive: 'AWD', split: 0.3, wf: 0.39, tier: 0.95, rar: 0.8, price: 231000, traffic: 0.05,
  pal: [0xb3202e, 0x1b1d22, 0x9aa1aa, 0xe8e4d6, 0xf2c014], desc: 'The flagship Orkan: twin turbos, all-wheel drive and a launch that rearranges organs.',
  mu: 1.24, cla: 0.9, layout: 'rear',
  d: { style: 'rear', tail: 'bar', wing: 'wing', hips: 0.05, sideVent: true, rim: 'split', rimColor: 'dark', exhaust: 'quad', fbumper: 'sport' },
});
V('vane', 'Kestrel', 'Vane', 'sports', {
  L: 3.98, W: 1.74, H: 1.2, wb: 2.32, r: 0.31, tw: 0.215, m: 1020, kw: 135, top: 220, acc: 5.9, seats: 2, snd: 'i4', tier: 0.5, rar: 0.35, price: 36000, traffic: 0.35,
  pal: [0xd8202c, 0x2a5aa8, 0xf4f4f2, 0x2f4a3a, 0xe8c547], desc: 'Featherweight roadster. Roof down, revs up, grin fixed in place.',
  mu: 1.12, wf: 0.5,
  d: { style: 'roadster', head: 'wrap', headH: 0.1, grille: 'slot', tail: 'round', rim: 'star', spokes: 5, rimColor: 'silver', noseRake: 0.16, taperF: 0.12, rollHoops: true, noseY: 0.6, beltF: 0.82, beltR: 0.84, deckY: 0.84, tailY: 0.82 },
});
V('raiko', 'Kazemoto', 'Raikō', 'sports', {
  L: 4.71, W: 1.9, H: 1.37, wb: 2.78, r: 0.35, tw: [0.255, 0.285], m: 1750, kw: 420, top: 315, acc: 2.9, seats: 4, snd: 'v6', engine: 'v6', drive: 'AWD', split: 0.35, tier: 0.8, rar: 0.6, price: 115000, traffic: 0.12,
  pal: [0x9aa1aa, 0x18191c, 0xf4f4f2, 0xb3202e, 0x2a4f9a], desc: 'Japanese AWD missile. Computer-controlled grip with a heart of pure rage.',
  mu: 1.24, cla: 0.6, freq: [2.0, 2.1],
  d: { style: 'fastback', doors: 2, head: 'blade', grille: 'wide', grilleMat: 'dark', fbumper: 'sport', tail: 'round', tailRound4: true, wing: 'wing', wingMat: 'paint', rim: 'multi', rimColor: 'dark', exhaust: 'quad', sideVent: true, diffuser: true },
});
V('hachi', 'Kazemoto', 'Hachi', 'sports', {
  L: 4.26, W: 1.78, H: 1.29, wb: 2.57, r: 0.32, tw: 0.215, m: 1260, kw: 170, top: 226, acc: 6.3, seats: 4, snd: 'i4', tier: 0.4, rar: 0.25, price: 30000, traffic: 0.45,
  pal: [0xf4f4f2, 0xe24a1e, 0x2a4f9a, 0x18191c, 0x9aa1aa], desc: 'Light, low, rear-drive. Proof you do not need power to have the time of your life.',
  mu: 1.08, wf: 0.53,
  d: { style: 'sports', head: 'wrap', headH: 0.1, grille: 'mesh', tail: 'slim', wing: 'lip', rim: 'multi', rimColor: 'dark', exhaust: 'dual', aOff: 0.5 },
});
V('thresher', 'Marlin', 'Thresher', 'sports', {
  L: 4.5, W: 1.93, H: 1.23, wb: 2.71, r: 0.34, tw: [0.255, 0.305], m: 1530, kw: 365, top: 312, acc: 3.5, seats: 2, snd: 'v8', engine: 'v8', wf: 0.48, tier: 0.7, rar: 0.4, price: 72000, traffic: 0.2,
  pal: [0xd8202c, 0xe8c547, 0xf4f4f2, 0x18191c, 0x2a4f9a, 0xff6a10], desc: 'America’s sports car: low, wide, loud, and surprisingly good at going round corners.',
  mu: 1.2, cla: 0.6,
  d: { style: 'sports', head: 'slit', grille: 'mesh', fbumper: 'sport', tail: 'louver', wing: 'lip', exhaust: 'center', sideVent: true, rim: 'split', rimColor: 'dark', aOff: 0.62, taperF: 0.11 },
});
V('strada', 'Tessaro', 'Corsia', 'sports', {
  L: 4.66, W: 1.97, H: 1.3, wb: 2.67, r: 0.35, tw: [0.245, 0.285], m: 1570, kw: 456, top: 320, acc: 3.4, seats: 4, snd: 'v8', engine: 'v8s', wf: 0.49, tier: 0.88, rar: 0.65, price: 222000, traffic: 0.06,
  pal: [0xb3202e, 0xe8c547, 0xf4f4f2, 0x1b1d22, 0x2a4f9a, 0x9aa1aa], desc: 'Front-engined Italian berlinetta: elegant on the Riviera, savage on the autostrada.',
  mu: 1.2, cla: 0.7,
  d: { style: 'fastback', head: 'slit', grille: 'egg', tail: 'round', tailRound4: true, wing: 'duck', rim: 'star', spokes: 5, rimColor: 'silver', aOff: 0.68, hips: 0.035, exhaust: 'quad', taperF: 0.12, diffuser: true },
});
V('kurve_r', 'Rennwerk', 'Kurve R', 'sports', {
  L: 4.8, W: 1.89, H: 1.39, wb: 2.86, r: 0.35, tw: [0.275, 0.285], m: 1720, kw: 375, top: 290, acc: 3.9, seats: 4, snd: 'v6', engine: 'i4t', redline: 7200, gears: 8, wf: 0.52, tier: 0.8, rar: 0.5, price: 89000, traffic: 0.2,
  pal: [0x2a6fd8, 0xe8c547, 0x1b1d22, 0xf4f4f2, 0x7a1f2b, 0x3b8a3a], desc: 'The coupe with the gym membership: carbon roof, quad pipes, zero chill.',
  mu: 1.18, cla: 0.4,
  d: { style: 'coupe', head: 'blade', grille: 'twin', fbumper: 'sport', tail: 'block', wing: 'lip', exhaust: 'quad', diffuser: true, roof: 'vinyl', hood: 'bulge', rim: 'split', rimColor: 'gold', sideVent: true, aOff: 0.55, hips: 0.03 },
});
V('hwarang', 'Hanbit', 'Hwarang', 'sports', {
  L: 4.83, W: 1.87, H: 1.4, wb: 2.9, r: 0.34, tw: [0.225, 0.255], m: 1780, kw: 270, top: 270, acc: 4.9, seats: 5, snd: 'v6', drive: 'RWD', gears: 8, tier: 0.55, rar: 0.4, price: 52000, traffic: 0.25,
  pal: [0x8a1b25, 0x3b4452, 0xf4f4f2, 0x1b1d22, 0x2a6fd8], desc: 'Four-door fastback that hunts grand tourers for sport. Big hatchback, bigger heart.',
  mu: 1.12,
  d: { style: 'fastback', doors: 4, head: 'blade', grille: 'mesh', tail: 'bar', rim: 'multi', rimColor: 'dark', exhaust: 'quad', aOff: 0.55, backRun: 1.25, rearLen: 0.5, quarter: 0.18, sideVent: true },
});
V('arc', 'Lumo', 'Arc', 'sports', {
  L: 4.62, W: 1.96, H: 1.25, wb: 2.75, r: 0.35, tw: [0.255, 0.295], m: 1900, kw: 500, top: 260, acc: 2.6, seats: 2, snd: 'electric', engine: 'electric', gears: 'ev', drive: 'AWD', split: 0.45, tier: 0.8, rar: 0.6, price: 125000, traffic: 0.1,
  pal: [0xf4f4f2, 0x1b1d22, 0x2fd6d0, 0xb3202e, 0x9aa1aa], desc: 'Electric sports coupe: silent until the scenery starts blurring.',
  mu: 1.2, cla: 0.6,
  d: { style: 'sports', head: 'slit', drl: 'bar', grille: 'none', tail: 'bar', roof: 'glass', pillars: 'dark', rim: 'turbine', rimColor: 'dark', exhaust: 'none', diffuser: true, noseRound: 0.12 },
});
V('kite', 'Kestrel', 'Kite', 'sports', {
  L: 4.08, W: 1.8, H: 1.14, wb: 2.37, r: 0.32, tw: [0.215, 0.265], m: 1150, kw: 300, top: 290, acc: 3.4, seats: 2, snd: 'v6', engine: 'v6', redline: 7500, wf: 0.38, tier: 0.75, rar: 0.6, price: 98000, traffic: 0.05,
  pal: [0xe8c547, 0x3b8a3a, 0xf4f4f2, 0xd8202c, 0x1b1d22], desc: 'Mid-engined track toy with number-plate road manners and race-car reflexes.',
  mu: 1.24, cla: 1.0, layout: 'mid',
  d: { style: 'mid', head: 'wrap', headH: 0.1, tail: 'round', wing: 'wing', rim: 'star', spokes: 6, rimColor: 'dark', sideVent: true, exhaust: 'center', diffuser: true },
});

// ---- super / hyper ----
V('vapore_legacy', '', '', 'super', { legacy: 'super' });
V('tempesta', 'Corsa Nera', 'Burrasca', 'super', {
  L: 4.95, W: 2.1, H: 1.14, wb: 2.7, r: 0.36, tw: [0.265, 0.345], m: 1620, kw: 566, top: 350, acc: 2.8, seats: 2, snd: 'v12', tier: 1.0, rar: 0.92, price: 498000, traffic: 0.02,
  pal: [0x8fd127, 0xff7a10, 0xf2c014, 0x1b1d22, 0xf4f4f2, 0x5b2a8c], desc: 'V12 wedge with scissor doors and the subtlety of a thunderclap.',
  layout: 'mid',
  d: { style: 'mid', head: 'blade', tail: 'slim', wing: 'wing', sideVent: true, rim: 'turbine', rimColor: 'dark', exhaust: 'center', diffuser: true, noseRake: 0.32, taperF: 0.14 },
});
V('saetta', 'Corsa Nera', 'Saetta', 'super', {
  L: 4.55, W: 1.93, H: 1.17, wb: 2.62, r: 0.35, tw: [0.245, 0.305], m: 1450, kw: 470, top: 325, acc: 2.9, seats: 2, snd: 'v12', engine: 'v8s', redline: 8500, tier: 0.95, rar: 0.85, price: 262000, traffic: 0.03,
  pal: [0xf2c014, 0x1b1d22, 0x8fd127, 0xf4f4f2, 0x2a6fd8], desc: 'The "baby" Corsa Nera. Still screams like the end of the world.',
  layout: 'mid',
  d: { style: 'mid', head: 'slit', tail: 'slim', wing: 'lip', sideVent: true, rim: 'split', rimColor: 'dark', exhaust: 'quad', diffuser: true, noseRake: 0.26 },
});
V('fenice', 'Tessaro', 'Fenice', 'super', {
  L: 4.61, W: 1.98, H: 1.2, wb: 2.65, r: 0.35, tw: [0.255, 0.315], m: 1570, kw: 530, top: 340, acc: 2.8, seats: 2, snd: 'v8', engine: 'v8s', redline: 8000, drive: 'RWD', tier: 0.98, rar: 0.85, price: 320000, traffic: 0.03,
  pal: [0xb3202e, 0xe8c547, 0xf4f4f2, 0x1b1d22, 0x2a4f9a], desc: 'Rosso, mid-engined, twin-turbo. The prancing kind of fast.',
  layout: 'mid', cla: 1.3,
  d: { style: 'mid', head: 'blade', tail: 'round', tailRound4: true, wing: 'duck', sideVent: true, rim: 'star', spokes: 5, rimColor: 'silver', exhaust: 'twin', diffuser: true },
});
V('peregrine', 'Kestrel', 'Peregrine', 'super', {
  L: 4.57, W: 2.0, H: 1.18, wb: 2.67, r: 0.35, tw: [0.245, 0.305], m: 1420, kw: 570, top: 340, acc: 2.7, seats: 2, snd: 'v8', engine: 'v8s', redline: 8200, drive: 'RWD', tier: 0.98, rar: 0.85, price: 310000, traffic: 0.03,
  pal: [0xff7a10, 0x9aa1aa, 0x1b1d22, 0xf4f4f2, 0x3a8acd], desc: 'British carbon-tub hypercar. Dihedral doors, telepathic steering.',
  layout: 'mid', cla: 1.35,
  d: { style: 'mid', head: 'blade', headW: 0.3, tail: 'slim', wing: 'wing', wingMat: 'paint', sideVent: true, rim: 'split', rimColor: 'dark', exhaust: 'center', diffuser: true, noseRake: 0.28, taperF: 0.16 },
});
V('zenith', 'Lumo', 'Zenith', 'super', {
  L: 4.75, W: 2.0, H: 1.2, wb: 2.75, r: 0.36, tw: [0.275, 0.315], m: 2150, kw: 1400, top: 380, acc: 2.0, seats: 2, snd: 'electric', engine: 'electric', gears: 'ev', drive: 'AWD', split: 0.45, tier: 1.0, rar: 0.95, price: 2100000, traffic: 0.01,
  pal: [0x2fd6d0, 0xf4f4f2, 0x1b1d22, 0x9aa1aa, 0x5b2a8c], desc: 'Four motors, 1400 kW, one very surprised physics engine.',
  layout: 'mid', cla: 1.4, mu: 1.28,
  d: { style: 'mid', head: 'slit', drl: 'bar', tail: 'bar', wing: 'lip', grille: 'none', roof: 'glass', pillars: 'dark', rim: 'turbine', rimColor: 'dark', exhaust: 'none', diffuser: true, sideVent: true },
});
V('mitternacht', 'Falkner', 'Mitternacht', 'super', {
  L: 4.64, W: 1.94, H: 1.16, wb: 2.73, r: 0.35, tw: [0.265, 0.325], m: 1680, kw: 652, top: 345, acc: 2.6, seats: 2, snd: 'v8', engine: 'v8s', redline: 9000, drive: 'AWD', split: 0.35, tier: 1.0, rar: 0.95, price: 845000, traffic: 0.01,
  pal: [0x9aa1aa, 0x1b1d22, 0xf4f4f2, 0x2f4a3a, 0xff6a10], desc: 'Hybrid hypercar that whispers in the city and howls past midnight.',
  layout: 'mid', cla: 1.3, mu: 1.26,
  d: { style: 'mid', head: 'frog', podF: { h: 0.07 }, tail: 'bar', wing: 'wing', rim: 'turbine', rimColor: 'silver', exhaust: 'none', diffuser: true, sideVent: true },
});
V('aurora', 'Nordvik', 'Aurora', 'super', {
  L: 4.5, W: 2.05, H: 1.14, wb: 2.66, r: 0.355, tw: [0.265, 0.345], m: 1450, kw: 1000, top: 400, acc: 2.5, seats: 2, snd: 'v8', engine: 'v8s', redline: 8500, drive: 'RWD', tier: 1.0, rar: 0.97, price: 3000000, traffic: 0.01,
  pal: [0xf4f4f2, 0xff6a10, 0x2a4f9a, 0x1b1d22, 0xc8ccd2], desc: 'Swedish hypercar built to break records and the will of whoever follows it.',
  layout: 'mid', cla: 1.5, mu: 1.28,
  d: { style: 'mid', head: 'rect', headW: 0.3, headH: 0.08, tail: 'round', wing: 'gt', rim: 'turbine', rimColor: 'dark', exhaust: 'center', diffuser: true, sideVent: true },
});

// ---- muscle ----
V('bullhorn_legacy', '', '', 'muscle', { legacy: 'muscle' });
V('hammerhead', 'Marlin', 'Hammerhead', 'muscle', {
  L: 5.2, W: 1.95, H: 1.33, wb: 2.95, r: 0.35, tw: [0.235, 0.275], m: 1720, kw: 320, top: 220, acc: 5.6, seats: 5, snd: 'v8', gears: 4, tier: 0.5, rar: 0.6, price: 68000, traffic: 0.2,
  pal: [0x18191c, 0x5b2a8c, 0xff6a10, 0x8fd127, 0xb3202e, 0xe6e3da], desc: 'Seventies big-block legend. Loud paint, louder everything else.',
  freq: [1.4, 1.45],
  d: { style: 'coupe', head: 'round4', grille: 'mesh', fbumper: 'chrome', rbumper: 'chrome', hood: 'power', stripe: 'rally', tail: 'bar', rim: 'star', rimColor: 'chrome', exhaust: 'dual', bevel: 0.05, quarter: 0.4, noseRake: 0.03, taperF: 0.02, roofRound: 0.1, beltTrim: 'chrome' },
});
V('swordfish', 'Marlin', 'Swordfish', 'muscle', {
  L: 4.8, W: 1.92, H: 1.38, wb: 2.72, r: 0.35, tw: [0.255, 0.275], m: 1750, kw: 335, top: 250, acc: 4.3, seats: 4, snd: 'v8', engine: 'v8', redline: 7200, gears: 6, tier: 0.45, rar: 0.25, price: 47000, traffic: 0.5,
  pal: [0x2a4f9a, 0xd8202c, 0xf2c014, 0x18191c, 0xf4f4f2, 0x9aa1aa], desc: 'Modern pony car with a shark nose and a fastback full of nostalgia.',
  d: { style: 'fastback', head: 'blade', grille: 'mesh', tail: 'louver', hood: 'vents', stripe: 'rally', rim: 'split', rimColor: 'dark', exhaust: 'quad', aOff: 0.62, noseRake: 0.02, taperF: 0.05, quarter: 0.32 },
});
V('wahoo', 'Marlin', 'Wahoo', 'muscle', {
  L: 4.75, W: 1.88, H: 1.28, wb: 2.75, r: 0.34, tw: [0.225, 0.255], m: 1560, kw: 280, top: 210, acc: 5.8, seats: 4, snd: 'v8', gears: 4, tier: 0.45, rar: 0.6, price: 61000, traffic: 0.15,
  pal: [0x2f6b4a, 0xff6a10, 0xf2c014, 0x7fb6c9, 0x18191c, 0xb3202e], desc: 'Seventies fastback with a shaker scoop that wobbles when it idles.',
  d: { style: 'fastback', head: 'round', grille: 'mesh', fbumper: 'chrome', rbumper: 'chrome', hood: 'shaker', tail: 'louver', stripe: 'side', rim: 'multi', rimColor: 'silver', spokes: 5, bevel: 0.05, quarter: 0.4, noseRake: 0.02, taperF: 0.03, aOff: 0.62, beltTrim: 'chrome', exhaust: 'dual' },
});
V('gar', 'Marlin', 'Gar', 'muscle', {
  L: 4.75, W: 1.85, H: 1.35, wb: 2.8, r: 0.34, tw: [0.215, 0.245], m: 1540, kw: 260, top: 205, acc: 6.0, seats: 5, snd: 'v8', gears: 4, tier: 0.3, rar: 0.4, price: 34000, traffic: 0.3,
  pal: [0x8a1b25, 0x2a4f9a, 0xe8c547, 0xf4f4f2, 0x3e4a3d], desc: 'Compact seventies coupe with a small body, big block and bigger rear tyres.',
  d: { style: 'coupe', head: 'round', grille: 'bars', fbumper: 'chrome', rbumper: 'chrome', hood: 'scoop', tail: 'block', rim: 'steel', rimColor: 'dark', bevel: 0.04, quarter: 0.35, noseRake: 0.0, taperF: 0.02, roofRound: 0.08, beltTrim: 'chrome', exhaust: 'dual' },
});
V('ironclad', 'Halberd', 'Ironclad', 'muscle', {
  L: 5.4, W: 2.0, H: 1.4, wb: 3.02, r: 0.35, tw: [0.225, 0.245], m: 1800, kw: 290, top: 210, acc: 6.4, seats: 6, snd: 'v8', gears: 4, tier: 0.4, rar: 0.6, price: 52000, traffic: 0.15,
  pal: [0x18191c, 0x6d1f2a, 0x9fc4e0, 0xf4f4f2, 0x2f6b4a], desc: 'Sixties full-size four-door with a big block and triple tail lamps. Low and slow, or just low.',
  freq: [1.25, 1.3],
  d: { style: 'sedan', head: 'round4', grille: 'big', fbumper: 'chrome', rbumper: 'chrome', tail: 'round', tailRound4: true, whitewall: true, rim: 'dish', rimColor: 'chrome', bevel: 0.035, noseRake: 0.0, taperF: 0.02, taperR: 0.01, roofRound: 0.07, beltTrim: 'chrome', rearLen: 1.2, stripe: 'side', stripeMat: 'chrome' },
});
V('thunderclap', 'Halberd', 'Thunderclap', 'muscle', {
  L: 5.03, W: 1.92, H: 1.45, wb: 2.95, r: 0.35, tw: [0.275, 0.305], m: 1980, kw: 600, top: 320, acc: 3.6, seats: 5, snd: 'v8', tier: 0.6, rar: 0.45, price: 79000, traffic: 0.25,
  pal: [0x2b2d31, 0xd8202c, 0x5b2a8c, 0xf2c014, 0x1f6b3a, 0xf4f4f2], desc: 'Supercharged retro brute. Tyres are a consumable, like fuel and patience.',
  d: { style: 'coupe', head: 'round4', headY: 0.82, grille: 'mesh', tail: 'bar', hood: 'scoop', wing: 'lip', rim: 'split', rimColor: 'dark', bevel: 0.05, roofRound: 0.1, taperF: 0.03, noseRake: 0.02, exhaust: 'dual', quarter: 0.35 },
});
V('warpath', 'Halberd', 'Warpath', 'muscle', {
  L: 5.05, W: 1.83, H: 1.37, wb: 2.75, r: 0.34, tw: [0.225, 0.245], m: 1650, kw: 205, top: 210, acc: 5.5, seats: 5, snd: 'v6', engine: 'v6', gears: 4, tier: 0.35, rar: 0.6, price: 38000, traffic: 0.15,
  pal: [0x111214, 0x18191c, 0x3a3f46, 0x6d1f2a, 0xf4f4f2], desc: 'Eighties turbo-six coupe in menacing black. Embarrassed V8s for a living.',
  d: { style: 'coupe', head: 'square4', grille: 'big', grilleMat: 'chrome', tail: 'block', tailW: 0.45, hood: 'bulge', rim: 'mesh', rimColor: 'dark', bevel: 0.03, roofRound: 0.06, noseRake: 0.0, taperF: 0.015, taperR: 0.01, quarter: 0.45, exhaust: 'dual' },
});

// ---- classics ----
V('dolce_vita', 'Tessaro', 'Dolce Vita', 'classic', {
  L: 4.38, W: 1.72, H: 1.25, wb: 2.45, r: 0.33, tw: 0.205, m: 1250, kw: 210, top: 240, acc: 6.8, seats: 2, snd: 'v12', engine: 'v12', redline: 7500, gears: 5, tier: 0.95, rar: 0.95, price: 1800000, traffic: 0.02,
  pal: [0xb3202e, 0xe9dfc8, 0x9fc4e0, 0xc8ccd2, 0x2f4a3a], desc: 'Sixties Riviera spider. Wire wheels, chrome eyebrows, priceless soundtrack.',
  d: { style: 'roadster', head: 'round', headR: 0.08, grille: 'egg', fbumper: 'chrome', rbumper: 'chrome', tail: 'round', rim: 'wirespoke', rimColor: 'chrome', noseRake: 0.14, taperF: 0.15, taperR: 0.1, aOff: 0.8, bevel: 0.08, noseY: 0.62, beltF: 0.8, beltR: 0.82, deckY: 0.82, tailY: 0.8, exhaust: 'twin', interior: 0x7a3a22, wsFrame: 'chrome' },
});
V('hummel', 'Rennwerk', 'Hummel', 'classic', {
  L: 4.08, W: 1.55, H: 1.5, wb: 2.4, r: 0.32, tw: 0.165, m: 820, kw: 37, top: 130, acc60: 9.0, seats: 4, snd: 'i4', drive: 'RWD', wf: 0.42, gears: 4, tier: 0.2, rar: 0.4, price: 15000, traffic: 0.35,
  pal: [0x7fb6c9, 0xe6c34a, 0xd94f3a, 0xe9dfc8, 0x6c8a6e, 0x18191c], desc: 'Air-cooled bug. Slow, loud and loved by absolutely everyone.',
  layout: 'rear', freq: [1.3, 1.35], mu: 0.95,
  d: { style: 'micro', cab: 'fastback', head: 'frog', headR: 0.08, frogRing: 'chrome', podF: { h: 0.12 }, podR: { h: 0.12 }, fenderBlend: 0.3, grille: 'none', fbumper: 'chrome', rbumper: 'chrome', tail: 'round', rim: 'steel', rimColor: 'paint', whitewall: true, noseY: 0.62, noseRake: 0.25, beltF: 0.92, beltR: 0.9, deckY: 0.86, tailY: 0.8, aOff: 0.42, wsRun: 0.35, backRun: 0.9, rearLen: 0.45, roofRound: 0.3, crown: 0.06, taperF: 0.1, taperR: 0.12, bevel: 0.09, cabBevel: 0.14, doors: 2, ohFrac: 0.47, plate: true, indicators: false },
});
V('grandview', 'Palmetto', 'Grandview', 'classic', {
  L: 5.75, W: 2.03, H: 1.42, wb: 3.2, r: 0.36, m: 2150, kw: 160, top: 190, acc: 9.5, seats: 6, snd: 'v8', gears: 4, tier: 0.35, rar: 0.6, price: 24000, traffic: 0.25,
  pal: [0x5b4636, 0xd9c9a6, 0x6d1f2a, 0xf4f4f2, 0x9fc4e0, 0x2f3e2d], desc: 'A living room that does 190. Vinyl roof, whitewalls and a bonnet you could land a plane on.',
  freq: [1.15, 1.2], mu: 0.95,
  d: { style: 'sedan', roof: 'vinyl', fbumper: 'chrome', rbumper: 'chrome', head: 'square4', grille: 'tall', tail: 'block', whitewall: true, rim: 'dish', rimColor: 'chrome', quarter: 0.45, bevel: 0.04, noseRake: 0.0, taperF: 0.02, taperR: 0.01, roofRound: 0.08, rearLen: 1.3, aOff: 0.75, markers: true, ornament: true, beltTrim: 'chrome' },
});
V('hirondelle', 'Belcour', 'Hirondelle', 'classic', {
  L: 4.82, W: 1.79, H: 1.47, wb: 3.12, r: 0.33, tw: 0.185, m: 1270, kw: 80, top: 175, acc: 12.5, seats: 5, snd: 'i4', drive: 'FWD', gears: 4, tier: 0.4, rar: 0.75, price: 42000, traffic: 0.05,
  pal: [0x2b3a55, 0xe9dfc8, 0x8a1b25, 0x5d6b78, 0x18191c], desc: 'Sixties French spaceship on hydraulic suspension. Glides over potholes like they owe it money.',
  freq: [1.0, 1.05], mu: 0.95,
  d: { style: 'sedan', head: 'round', headR: 0.09, grille: 'none', fbumper: 'body', tail: 'slim', skirts: true, noseRake: 0.55, noseY: 0.62, noseRound: 0.12, taperF: 0.14, taperR: 0.2, rearLen: 0.95, backRun: 0.9, rim: 'steel', rimColor: 'paint', roofRound: 0.18, crown: 0.04, bevel: 0.08, ohFrac: 0.6, pillars: 'paint', beltTrim: 'chrome' },
});
V('ryusei', 'Kazemoto', 'Ryūsei', 'classic', {
  L: 4.18, W: 1.64, H: 1.28, wb: 2.33, r: 0.31, tw: 0.185, m: 1100, kw: 110, top: 210, acc: 8.0, seats: 2, snd: 'v6', engine: 'v6', redline: 7000, gears: 5, tier: 0.6, rar: 0.85, price: 95000, traffic: 0.03,
  pal: [0xf4f4f2, 0xd94f3a, 0xe6c34a, 0x2a4f9a, 0x7a5a45], desc: 'Seventies Japanese GT: long nose, fastback tail, straight-six song.',
  d: { style: 'fastback', head: 'round', headR: 0.085, grille: 'slot', fbumper: 'chrome', rbumper: 'chrome', tail: 'block', rim: 'steel', rimColor: 'silver', aOff: 0.62, noseRake: 0.12, taperF: 0.1, bevel: 0.06, rearLen: 0.45, backRun: 0.95, exhaust: 'twin', beltTrim: 'chrome' },
});
V('linnet', 'Kestrel', 'Linnet', 'classic', {
  L: 4.46, W: 1.66, H: 1.22, wb: 2.44, r: 0.32, tw: 0.185, m: 1230, kw: 200, top: 240, acc: 6.9, seats: 2, snd: 'v6', engine: 'v6', redline: 6500, gears: 4, tier: 0.9, rar: 0.92, price: 320000, traffic: 0.02,
  pal: [0x2f4a3a, 0xe9dfc8, 0xb3202e, 0xc8ccd2, 0x2a4f9a], desc: 'Sixties British roadster with a bonnet as long as a sermon and twice as inspiring.',
  d: { style: 'roadster', head: 'round', headR: 0.08, grille: 'egg', fbumper: 'chrome', rbumper: 'chrome', tail: 'round', rim: 'wirespoke', rimColor: 'chrome', aOff: 1.05, noseRake: 0.2, taperF: 0.2, taperR: 0.1, noseY: 0.55, beltF: 0.8, beltR: 0.8, deckY: 0.8, tailY: 0.76, bevel: 0.08, ohFrac: 0.5, exhaust: 'twin', hood: 'bulge', interior: 0x5a3a28 },
});
V('driftwood', 'Marlin', 'Driftwood', 'classic', {
  L: 5.6, W: 2.0, H: 1.45, wb: 3.08, r: 0.35, m: 2050, kw: 150, top: 175, acc: 11.0, seats: 8, snd: 'v8', gears: 4, tier: 0.3, rar: 0.6, price: 26000, traffic: 0.15,
  pal: [0xd9c9a6, 0x7fb6c9, 0x6c8a6e, 0xc75b2a, 0xf4f4f2], palette2: 0x7a4a2a, desc: 'Seventies woody wagon. Surfboard on the roof, eight seats, zero urgency.',
  freq: [1.15, 1.2], mu: 0.95,
  d: { style: 'wagon', fbumper: 'chrome', rbumper: 'chrome', head: 'square4', grille: 'big', tail: 'block', sidePanel: { y0: 0.42, y1: 0.86, mat: 'paint2' }, whitewall: true, rim: 'dish', rimColor: 'chrome', roof: 'rack', surfboard: true, bevel: 0.04, roofRound: 0.07, noseRake: 0.0, taperF: 0.02, taperR: 0.01, tailRake: 0.02, beltTrim: 'chrome' },
});

// ---- SUV / crossover ----
V('backcountry_legacy', '', '', 'suv', { legacy: 'suv' });
V('monarch', 'Everglade', 'Monarch', 'suv', {
  L: 5.38, W: 2.06, H: 1.95, wb: 3.07, r: 0.42, tw: 0.285, m: 2650, kw: 313, top: 210, acc: 6.0, seats: 7, snd: 'v8', engine: 'v8', tier: 0.85, rar: 0.3, price: 98000, traffic: 0.5,
  pal: [0x1b1d22, 0xf4f4f2, 0x8a919c, 0x2b3a55, 0x4a1f26], desc: 'A chrome-plated ballroom on 22s. Valets fight over who gets to park it.',
  d: { style: 'suv', head: 'rect', headH: 0.16, headW: 0.38, grille: 'big', tail: 'vertical', rim: 'multi', rimColor: 'chrome', spokes: 6, beltTrim: 'chrome', bevel: 0.05, roofRound: 0.09, taperF: 0.03 },
});
V('cayman', 'Everglade', 'Sawgrass', 'suv', {
  L: 5.05, W: 2.0, H: 1.78, wb: 3.02, r: 0.4, tw: 0.255, m: 2150, kw: 220, top: 200, acc: 7.2, seats: 7, snd: 'v6', tier: 0.5, rar: 0.08, price: 42000, traffic: 1.0,
  pal: [0x1b1d22, 0xf4f4f2, 0x8a919c, 0x2b3a55, 0x6d1f2a, 0x3e4a3d], desc: 'Three-row family SUV. Soccer practice, Costco, repeat.',
  d: { style: 'suv', head: 'blade', grille: 'wide', tail: 'slim', roof: 'rails', rim: 'multi', rimColor: 'silver', spokes: 6 },
});
V('alpin_x', 'Rennwerk', 'Hochland X', 'suv', {
  L: 4.93, W: 2.0, H: 1.75, wb: 2.98, r: 0.4, tw: 0.275, m: 2250, kw: 250, top: 243, acc: 5.5, seats: 5, snd: 'v6', engine: 'i4t', gears: 8, tier: 0.8, rar: 0.25, price: 72000, traffic: 0.6,
  pal: [0x1b1d22, 0xf4f4f2, 0x3b4452, 0x8a919c, 0x2a4f9a], desc: 'Luxury crossover with kidneys big enough to need their own postcode.',
  mu: 1.04,
  d: { style: 'suv', head: 'blade', grille: 'twin', tail: 'slim', rim: 'split', rimColor: 'dark', beltTrim: 'chrome', roof: 'rails', backRun: 0.22, tailRake: 0.1, exhaust: 'dual' },
});
V('kitsune', 'Hoshiro', 'Kitsune', 'suv', {
  L: 4.6, W: 1.86, H: 1.68, wb: 2.69, r: 0.37, tw: 0.235, m: 1650, kw: 150, top: 195, acc: 8.4, seats: 5, snd: 'i4', tier: 0.35, rar: 0.05, price: 31000, traffic: 1.6,
  pal: [0xc7cbd1, 0x3e4a3d, 0xf4f4f2, 0x2a4f7a, 0x8a1b25, 0x1b1d22], desc: 'Compact crossover with chunky cladding and a sensible soul.',
  d: { style: 'suv', head: 'blade', grille: 'wide', grilleMat: 'dark', tail: 'vertical', clad: 0.42, rim: 'multi', rimColor: 'dark', roof: 'rails' },
});
V('doran', 'Hanbit', 'Doran', 'suv', {
  L: 4.52, W: 1.86, H: 1.65, wb: 2.68, r: 0.36, m: 1580, kw: 135, top: 190, acc: 9.0, seats: 5, snd: 'i4', engine: 'i4t', drive: 'FWD', tier: 0.3, rar: 0.08, price: 28000, traffic: 1.4,
  pal: [0x6aa3b8, 0xf4f4f2, 0x3a3f46, 0xc7cbd1, 0xb3202e], desc: 'Angular crossover with a light-bar face. Looks futuristic, drives like a sofa.',
  d: { style: 'suv', head: 'slit', drl: 'bar', grille: 'mesh', tail: 'bar', pillars: 'dark', rim: 'multi', rimColor: 'silver', clad: 0.38, tailRake: 0.12 },
});
V('vidde', 'Nordvik', 'Vidde', 'suv', {
  L: 4.95, W: 1.96, H: 1.77, wb: 2.98, r: 0.39, tw: 0.255, m: 2100, kw: 235, top: 230, acc: 6.4, seats: 7, snd: 'i4', engine: 'i4t', gears: 8, tier: 0.7, rar: 0.25, price: 64000, traffic: 0.6,
  pal: [0x3e4a3d, 0xf4f4f2, 0x8a919c, 0x2b3a55, 0x1b1d22], desc: 'Seven-seat Nordic SUV. Calm, clean, safe enough to wrap an egg in.',
  d: { style: 'suv', head: 'blade', drl: 'bar', grille: 'vbars', tail: 'vertical', tailTopY: 1.55, roof: 'rails', rim: 'multi', rimColor: 'silver', tailRake: 0.06 },
});
V('orbit', 'Lumo', 'Orbit', 'suv', {
  L: 4.75, W: 1.92, H: 1.62, wb: 2.89, r: 0.37, tw: 0.255, m: 2000, kw: 300, top: 217, acc: 4.8, seats: 5, snd: 'electric', engine: 'electric', gears: 'ev', drive: 'AWD', tier: 0.55, rar: 0.15, price: 49000, traffic: 1.0,
  pal: [0xf4f4f2, 0x1b1d22, 0x9aa1aa, 0x2a5aa8, 0xb3202e], desc: 'Electric crossover. The school run, but make it ludicrously quick.',
  d: { style: 'suv', head: 'slit', drl: 'bar', grille: 'none', tail: 'bar', roof: 'glass', pillars: 'dark', rim: 'disc', rimColor: 'dark', exhaust: 'none', noseRound: 0.12, tailRake: 0.22, backRun: 0.4, cladArch: false, sill: 0.28 },
});
V('prospector', 'Ironwood', 'Prospector', 'suv', {
  L: 4.8, W: 1.98, H: 1.95, wb: 2.85, r: 0.42, tw: 0.29, m: 2450, kw: 300, top: 200, acc: 6.2, seats: 5, snd: 'v8', tier: 0.7, rar: 0.35, price: 72000, traffic: 0.4,
  pal: [0x3e4a3d, 0xd9cdb4, 0x1b1d22, 0xb84a1e, 0xf4f4f2, 0x2a4f7a], desc: 'Square-jawed off-roader. Climbs anything, parallel parks nothing.',
  d: { style: 'offroad', bullbar: true, fogs: true, roofLamps: true, rim: 'offroad', rimColor: 'dark' },
});
V('yama', 'Kazemoto', 'Yama', 'suv', {
  L: 4.97, W: 1.95, H: 1.9, wb: 2.85, r: 0.41, tw: 0.275, m: 2400, kw: 165, top: 180, acc: 9.6, seats: 7, snd: 'diesel', engine: 'dieselLt', tier: 0.45, rar: 0.4, price: 54000, traffic: 0.35,
  pal: [0xd9cdb4, 0xf4f4f2, 0x3e4a3d, 0x2a4f7a, 0x6d1f2a], desc: 'Go-anywhere expedition wagon. Desert tested, swamp approved, unkillable.',
  d: { style: 'offroad', head: 'rect', headW: 0.3, headH: 0.14, grille: 'bars', grilleMat: 'chrome', snorkel: true, roof: 'rack', fbumper: 'chrome', rbumper: 'chrome', spare: false, rim: 'steel', rimColor: 'silver', noseRake: 0.05, roofRound: 0.08, bevel: 0.05 },
});
V('tifone', 'Corsa Nera', 'Tifone', 'suv', {
  L: 5.11, W: 2.02, H: 1.64, wb: 3.0, r: 0.4, tw: [0.285, 0.325], m: 2200, kw: 478, top: 305, acc: 3.6, seats: 5, snd: 'v8', engine: 'v8s', gears: 8, split: 0.4, tier: 0.95, rar: 0.7, price: 230000, traffic: 0.05,
  pal: [0xf2c014, 0x8fd127, 0x1b1d22, 0xff7a10, 0xf4f4f2], desc: 'A supercar on stilts. Takes the kids to school at 305 km/h.',
  mu: 1.12, cla: 0.3, freq: [1.55, 1.65],
  d: { style: 'suv', head: 'blade', grille: 'mesh', fbumper: 'sport', tail: 'slim', wing: 'roof', sideVent: true, rim: 'turbine', rimColor: 'dark', exhaust: 'quad', tailRake: 0.3, backRun: 0.6, noseRake: 0.2, taperF: 0.1, hips: 0.03, clad: 0.4, sill: 0.3, diffuser: true },
});

// ---- pickups ----
V('fieldhand_legacy', '', '', 'pickup', { legacy: 'pickup' });
V('sawbuck', 'Ironwood', 'Sawbuck', 'pickup', {
  L: 5.85, W: 2.03, H: 1.92, wb: 3.68, r: 0.4, m: 2300, kw: 300, top: 185, acc: 7.0, seats: 5, snd: 'v8', drive: 'AWD', tier: 0.4, rar: 0.05, price: 47000, traffic: 1.0,
  pal: [0xf4f4f2, 0x1b1d22, 0x8a1b25, 0x2a4f7a, 0x8a919c, 0x3e4a3d], desc: 'Full-size crew-cab pickup. The unofficial state vehicle of Leonida.',
  d: { style: 'pickup', cabLen: 2.25, tail: 'vertical', tailTopY: 1.3, mirrors: 'truck', rim: 'multi', rimColor: 'chrome', spokes: 6, cladArch: true },
});
V('goliath', 'Ironwood', 'Goliath 3500', 'pickup', {
  L: 6.4, W: 2.4, H: 2.02, wb: 4.2, r: 0.42, tw: [0.265, 0.53], m: 3600, kw: 330, top: 170, acc: 8.5, seats: 5, snd: 'diesel', engine: 'dieselLt', drive: 'AWD', gears: 8, tier: 0.45, rar: 0.25, price: 72000, traffic: 0.35,
  pal: [0xf4f4f2, 0x1b1d22, 0x2a4f7a, 0x8a1b25, 0xc7cbd1], desc: 'Dual-rear-wheel heavy hauler. Tows a house, then complains about the hill.',
  ph: { track: [1.9, 1.78] }, freq: [1.25, 1.4],
  d: { style: 'pickup', cabLen: 2.3, dualRear: true, podR: { h: 0.06 }, hips: 0.07, tail: 'vertical', tailTopY: 1.38, mirrors: 'truck', grille: 'big', head: 'rect', headH: 0.18, headW: 0.4, rim: 'steel', rimColor: 'chrome', markers: true, roofMarkers: true, cladArch: false },
});
V('tsuchi', 'Kazemoto', 'Tsuchi', 'pickup', {
  L: 5.33, W: 1.86, H: 1.82, wb: 3.08, r: 0.38, tw: 0.255, m: 2050, kw: 150, top: 175, acc: 10.0, seats: 5, snd: 'diesel', engine: 'dieselLt', drive: 'AWD', tier: 0.3, rar: 0.15, price: 36000, traffic: 0.7,
  pal: [0xf4f4f2, 0x9aa1aa, 0x1b1d22, 0x8a1b25, 0xd9cdb4], desc: 'Mid-size workhorse. Mounted machine guns not included, whatever the internet says.',
  d: { style: 'pickup', cabLen: 2.05, tail: 'vertical', tailTopY: 1.2, rollbar: true, cladArch: true, snorkel: true, rim: 'offroad', rimColor: 'dark', grille: 'bars', grilleMat: 'dark', head: 'blade' },
});
V('roughneck', 'Halberd', 'Roughneck', 'pickup', {
  L: 5.92, W: 2.2, H: 2.05, wb: 3.69, r: 0.45, tw: 0.32, m: 2800, kw: 520, top: 190, acc: 4.5, seats: 5, snd: 'v8', engine: 'v8', drive: 'AWD', gears: 8, tier: 0.6, rar: 0.4, price: 86000, traffic: 0.2,
  pal: [0x5d6b78, 0xff6a10, 0x2a4f9a, 0x1b1d22, 0xf4f4f2], desc: 'Desert-racing super truck. Long-travel suspension, short attention span.',
  travel: 0.4, freq: [1.15, 1.25], mu: 1.0,
  d: { style: 'pickup', cabLen: 2.25, tail: 'vertical', tailTopY: 1.38, grille: 'big', grilleMat: 'dark', fbumper: 'offroad', rbumper: 'offroad', cladArch: true, roofLamps: true, roof: 'rack', rim: 'offroad', rimColor: 'dark', markers: true, mirrors: 'dark', archGap: 0.1 },
});
V('jackrabbit', 'Palmetto', 'Jackrabbit', 'pickup', {
  L: 4.62, W: 1.66, H: 1.6, wb: 2.75, r: 0.33, tw: 0.195, m: 1250, kw: 75, top: 150, acc: 13.0, seats: 2, snd: 'i4', drive: 'RWD', gears: 5, tier: 0.15, rar: 0.3, price: 9000, traffic: 0.6,
  pal: [0xd94f3a, 0xe9dfc8, 0x2a4f7a, 0x6c8a6e, 0x7a5a45, 0xf4f4f2], desc: 'Eighties mini pickup. Rust-coloured in places that were not originally that colour.',
  d: { style: 'pickup', cabLen: 1.45, head: 'square4', grille: 'bars', fbumper: 'chrome', rbumper: 'chrome', tail: 'block', rim: 'steel', rimColor: 'silver', cladArch: false, bevel: 0.04, roofRound: 0.06 },
});
V('tread', 'Lumo', 'Tread', 'pickup', {
  L: 5.7, W: 2.1, H: 1.86, wb: 3.6, r: 0.42, tw: 0.285, m: 3000, kw: 600, top: 210, acc: 3.5, seats: 5, snd: 'electric', engine: 'electric', gears: 'ev', drive: 'AWD', tier: 0.6, rar: 0.4, price: 85000, traffic: 0.3,
  pal: [0x9aa1aa, 0xf4f4f2, 0x1b1d22, 0x2fd6d0, 0xb3202e], desc: 'Electric pickup with a light bar for a face and a covered bed full of gadgets.',
  d: { style: 'pickup', cabLen: 2.25, head: 'slit', drl: 'bar', grille: 'none', tail: 'bar', cargo: 'tonneau', rim: 'disc', rimColor: 'dark', exhaust: 'none', cladArch: true, fbumper: 'body', rbumper: 'body', noseRake: 0.1, pillars: 'dark' },
});

// ---- vans / minivans ----
V('kazoku', 'Hoshiro', 'Kazoku', 'van', {
  L: 5.16, W: 1.99, H: 1.78, wb: 3.06, r: 0.36, m: 2050, kw: 210, top: 195, acc: 7.6, seats: 8, snd: 'v6', drive: 'FWD', gears: 8, tier: 0.4, rar: 0.08, price: 39000, traffic: 1.2,
  pal: [0xc7cbd1, 0xf4f4f2, 0x1b1d22, 0x2a4f7a, 0x6d1f2a], desc: 'The ultimate soccer-parent minivan. Sliding doors, twelve cupholders, zero shame.',
  d: { style: 'minivan', head: 'blade', grille: 'wide', grilleMat: 'chrome', tail: 'vertical', rim: 'multi', rimColor: 'silver', pillars: 'dark', slideTrack: true },
});
V('homestead', 'Palmetto', 'Homestead', 'van', {
  L: 4.95, W: 1.95, H: 1.72, wb: 2.88, r: 0.33, m: 1800, kw: 120, top: 175, acc: 11.0, seats: 7, snd: 'v6', drive: 'FWD', gears: 4, tier: 0.2, rar: 0.25, price: 9000, traffic: 0.6,
  pal: [0x6d1f2a, 0xd8cfc0, 0x2a4f7a, 0x3e4a3d, 0xf4f4f2], desc: 'Nineties people-mover. Faux-wood trim optional, cassette player mandatory.',
  d: { style: 'minivan', head: 'rect', headH: 0.12, grille: 'bars', tail: 'vertical', rim: 'steel', rimColor: 'silver', bevel: 0.05, noseRake: 0.12, roofRound: 0.1 },
});
V('courier', 'Ironwood', 'Courier', 'van', {
  L: 5.95, W: 2.05, H: 2.55, wb: 3.66, r: 0.37, m: 2400, kw: 140, top: 160, acc: 13.5, seats: 3, snd: 'diesel', engine: 'dieselLt', drive: 'RWD', tier: 0.3, rar: 0.05, price: 42000, traffic: 1.2,
  pal: [0xf4f4f2, 0xc7cbd1, 0x2a5aa8, 0xd8202c, 0x1b1d22], desc: 'High-roof panel van. Moves sofas, bands and questionable business ventures.',
  d: { style: 'van', panel: true, mirrors: 'truck', tail: 'vertical', rim: 'steel', rimColor: 'silver', head: 'rect', headH: 0.16, beltF: 1.18, beltR: 1.22, tailY: 1.22, noseY: 1.0, wsRun: 0.7, roofRound: 0.12, slideTrack: true },
});
V('bummler', 'Rennwerk', 'Bummler', 'van', {
  L: 4.5, W: 1.75, H: 1.98, wb: 2.4, r: 0.33, tw: 0.185, m: 1300, kw: 55, top: 125, acc60: 9.5, seats: 7, snd: 'i4', drive: 'RWD', wf: 0.45, gears: 4, tier: 0.3, rar: 0.6, price: 32000, traffic: 0.2,
  pal: [0x2fb8a8, 0xe24a1e, 0xd8202c, 0x7fb6c9, 0xe6c34a], palette2: 0xf1ece0, desc: 'Retro split-screen bus. Peace, love and a top speed set by the wind direction.',
  layout: 'rear', freq: [1.3, 1.35], mu: 0.95,
  d: { style: 'van', twoTone: 'upper', twoToneY: 0.95, head: 'round', headR: 0.09, grille: 'none', fbumper: 'chrome', rbumper: 'chrome', rim: 'steel', rimColor: 'white', aOff: -0.5, noseY: 0.98, noseRake: 0.08, beltF: 1.08, beltR: 1.08, tailY: 1.08, wsRun: 0.16, roofRound: 0.2, bevel: 0.1, cabBevel: 0.16, taperF: 0.08, taperR: 0.06, surfboard: true, roof: 'rack', extraPillars: [0.95, 1.6, 2.25], indicators: true, tail: 'round', ohFrac: 0.48 },
});
V('hakobi', 'Kazemoto', 'Hakobi', 'van', {
  L: 4.4, W: 1.7, H: 1.86, wb: 2.73, r: 0.31, tw: 0.185, m: 1400, kw: 80, top: 160, acc: 14.0, seats: 5, snd: 'i4', drive: 'FWD', tier: 0.2, rar: 0.1, price: 23000, traffic: 1.0,
  pal: [0xf4f4f2, 0xc7cbd1, 0x2a5aa8, 0xe6c34a, 0x8a1b25], desc: 'Compact delivery van. Fits through alleys the big vans only dream of.',
  d: { style: 'van', head: 'rect', headH: 0.14, headW: 0.3, grille: 'slot', tail: 'vertical', rim: 'steel', rimColor: 'dark', panel: true, slideTrack: true, aOff: -0.1, noseY: 0.8, beltF: 0.98, beltR: 1.0, tailY: 1.0 },
});

// ---- luxury ----
V('regent', 'Ashcombe', 'Regent', 'luxury', {
  L: 5.76, W: 2.02, H: 1.64, wb: 3.55, r: 0.4, tw: 0.255, m: 2560, kw: 420, top: 250, acc: 5.3, seats: 5, snd: 'v12', tier: 1.0, rar: 0.85, price: 460000, traffic: 0.04,
  pal: [0x1b1d22, 0x2b3a55, 0xc8ccd2, 0x4a1f26, 0xf1ece0], palette2: 0x1b1d22, desc: 'The palace on wheels. The bonnet ornament has its own security detail.',
  d: { style: 'sedan', twoTone: 'upper', twoToneY: 1.02, head: 'rect', headW: 0.34, headH: 0.1, grille: 'tall', tail: 'block', tailW: 0.3, rim: 'disc', rimColor: 'chrome', ornament: true, aOff: 0.85, wsRun: 0.65, noseY: 0.98, beltF: 1.05, beltR: 1.07, deckY: 1.04, tailY: 1.0, noseRake: 0.02, taperF: 0.03, taperR: 0.03, rearLen: 1.0, backRun: 0.55, bevel: 0.05, roofRound: 0.12, beltTrim: 'chrome', quarter: 0.25, rbumper: 'body', exhaust: 'none' },
});
V('regent_stretch', 'Ashcombe', 'Regent Stretch', 'luxury', {
  L: 7.6, W: 2.02, H: 1.62, wb: 5.4, r: 0.4, tw: 0.255, m: 3300, kw: 420, top: 225, acc: 7.2, seats: 8, snd: 'v12', tier: 1.0, rar: 0.7, price: 650000, traffic: 0.05,
  pal: [0x111214, 0xf4f4f2, 0xc8ccd2, 0x2b3a55], palette2: 0x111214, desc: 'A stretch limousine with a minibar, mood lighting and a turning circle measured in postcodes.',
  lock: 40,
  d: { style: 'limo', twoTone: 'upper', twoToneY: 1.0, head: 'rect', headW: 0.34, headH: 0.1, grille: 'tall', tail: 'block', rim: 'disc', rimColor: 'chrome', ornament: true, aOff: 0.85, wsRun: 0.65, noseY: 0.96, beltF: 1.03, beltR: 1.05, deckY: 1.02, tailY: 1.0, noseRake: 0.02, taperF: 0.03, taperR: 0.03, rearLen: 1.0, backRun: 0.55, bevel: 0.05, roofRound: 0.12, beltTrim: 'chrome', extraPillars: [2.0, 3.2], doors: 4, zB: 0.4 },
});
V('tourer', 'Ashcombe', 'Tourer', 'luxury', {
  L: 4.85, W: 1.95, H: 1.4, wb: 2.85, r: 0.37, tw: [0.275, 0.275], m: 2250, kw: 485, top: 333, acc: 3.7, seats: 4, snd: 'v12', drive: 'AWD', split: 0.35, tier: 0.95, rar: 0.65, price: 235000, traffic: 0.06,
  pal: [0x2f4a3a, 0xc8ccd2, 0x1b1d22, 0x6d1f2a, 0xf1ece0], desc: 'Two-and-a-half tonnes of leather, walnut and twelve cylinders of good manners.',
  mu: 1.1, cla: 0.3,
  d: { style: 'fastback', head: 'round4', grille: 'mesh', grilleMat: 'chrome', tail: 'block', rim: 'multi', rimColor: 'chrome', aOff: 0.8, hips: 0.04, beltTrim: 'chrome', exhaust: 'quad', quarter: 0.25, rearLen: 0.62, backRun: 0.9 },
});
V('presidential', 'Everglade', 'Presidential', 'luxury', {
  L: 8.4, W: 2.0, H: 1.55, wb: 6.1, r: 0.36, tw: 0.235, m: 3400, kw: 240, top: 190, acc: 9.5, seats: 9, snd: 'v8', engine: 'v8', gears: 4, tier: 0.75, rar: 0.6, price: 120000, traffic: 0.04,
  pal: [0xf4f4f2, 0x111214, 0xd8cfc0, 0xff5fa8], desc: 'Prom-night stretch limo. Neon floor, champagne bar, unforgettable three-point turns.',
  lock: 42, freq: [1.1, 1.15],
  d: { style: 'limo', head: 'rect', headW: 0.4, headH: 0.11, grille: 'big', tail: 'block', rim: 'dish', rimColor: 'chrome', roof: 'vinyl', aOff: 0.5, rearLen: 1.15, extraPillars: [1.9, 2.9, 3.9], doors: 4, zB: 0.25, bevel: 0.04, noseRake: 0.0, taperF: 0.02, taperR: 0.01, beltTrim: 'chrome', fbumper: 'chrome', rbumper: 'chrome' },
});
V('gran_viaggio', 'Tessaro', 'Gran Viaggio', 'luxury', {
  L: 4.92, W: 1.98, H: 1.38, wb: 2.99, r: 0.36, tw: [0.245, 0.295], m: 1900, kw: 507, top: 335, acc: 3.4, seats: 4, snd: 'v12', drive: 'AWD', split: 0.3, tier: 0.97, rar: 0.8, price: 300000, traffic: 0.03,
  pal: [0xb3202e, 0x1b1d22, 0x9aa1aa, 0x2b3a55, 0xf1ece0], desc: 'V12 shooting brake: four seats, a boot, and the soul of a racing car.',
  mu: 1.16, cla: 0.5,
  d: { style: 'wagon', head: 'blade', grille: 'egg', tail: 'round', tailRound4: true, rim: 'star', spokes: 5, rimColor: 'silver', aOff: 0.8, noseRake: 0.18, taperF: 0.12, tailRake: 0.18, backRun: 0.35, hips: 0.035, doors: 2, sill: 0.17, beltF: 0.84, beltR: 0.86, tailY: 0.85, noseY: 0.6, exhaust: 'quad', diffuser: true, quarter: 0.15 },
});

// ---- service ----
V('taxi', 'Palmetto', 'Crestline Cab', 'service', {
  base: 'sedan', L: 5.38, W: 1.98, H: 1.46, wb: 2.91, r: 0.34, m: 1850, kw: 180, top: 200, acc: 9.0, seats: 5, snd: 'v8', engine: 'v8', drive: 'RWD', gears: 4, tier: 0.3, rar: 0.0, price: 31000, traffic: 1.0,
  pal: [0xf2c014], desc: 'Yellow cab. Knows every shortcut, uses none of them.',
  freq: [1.35, 1.4],
  d: { style: 'sedan', taxiSign: true, stripe: 'side', stripeMat: 'dark', head: 'rect', headW: 0.42, headH: 0.13, grille: 'big', tail: 'block', tailW: 0.42, rim: 'steel', rimColor: 'silver', noseRake: 0.04, tailRake: 0.02, taperF: 0.03, taperR: 0.02, bevel: 0.05, roofRound: 0.1, rearLen: 1.25, markers: true },
});
V('sentry_legacy', '', '', 'service', { legacy: 'cruiser' });
V('ambulance', 'Ironwood', 'Lifeline', 'service', {
  base: 'truck', kind: 'van', L: 6.9, W: 2.35, H: 2.9, wb: 4.0, r: 0.42, tw: [0.245, 0.49], m: 5200, kw: 250, top: 150, acc60: 9, seats: 3, snd: 'diesel', engine: 'dieselLt', tier: 0.4, rar: 0.0, price: 180000, traffic: 0.04,
  pal: [0xf4f4f2], palette2: 0xd8202c, desc: 'Box ambulance on a heavy-duty chassis. Lights, siren and a crew that has seen your driving before.',
  roll: 1.0, mu: 0.92, brake: 1.1, lock: 40,
  d: { type: 'truck', cab: 'conventional', hoodLen: 1.25, hoodY: 1.2, hoodW: 1.35, cabLen: 1.4, cabTop: 2.25, body: 'ambulance', stripe: 'paint2', lightbar: 'red', dual: true, rim: 'truck', rimColor: 'silver', ohFrac: 0.4 },
});
V('patrol_suv', 'Everglade', 'Sawgrass Patrol', 'service', {
  base: 'suv', L: 5.05, W: 2.0, H: 1.78, wb: 3.02, r: 0.4, tw: 0.265, m: 2250, kw: 300, top: 220, acc: 6.0, seats: 5, snd: 'v6', engine: 'v6', drive: 'AWD', tier: 0.5, rar: 0.0, price: 52000, traffic: 0.1,
  pal: [0xf4f4f2], palette2: 0x111214, desc: 'Police utility vehicle. Push bar, light bar, and a very short sense of humour.',
  mu: 1.04,
  d: { style: 'suv', twoTone: 'lower', twoToneY: 0.95, lightbar: 'police', bullbar: 'push', head: 'blade', grille: 'wide', grilleMat: 'dark', tail: 'slim', rim: 'steel', rimColor: 'dark', mirrors: 'dark' },
});
V('fire_chief', 'Everglade', 'Sawgrass Chief', 'service', {
  base: 'suv', L: 5.05, W: 2.0, H: 1.78, wb: 3.02, r: 0.4, tw: 0.265, m: 2250, kw: 300, top: 220, acc: 6.0, seats: 5, snd: 'v6', engine: 'v6', drive: 'AWD', tier: 0.5, rar: 0.0, price: 55000, traffic: 0.04,
  pal: [0xc81a1e], palette2: 0xf4f4f2, desc: 'Fire chief’s command SUV. Arrives first, parks wherever it likes.',
  d: { style: 'suv', lightbar: 'red', stripe: 'side', stripeMat: 'paint2', head: 'blade', grille: 'wide', tail: 'slim', rim: 'multi', rimColor: 'silver', roof: 'rails', mirrors: 'dark' },
});

// ---- trucks ----
V('box_truck', 'Bulwark', 'Carrier 26', 'truck', {
  L: 8.6, W: 2.5, H: 3.6, wb: 5.0, r: 0.5, m: 8200, kw: 220, top: 115, acc60: 14, seats: 2, snd: 'diesel', tier: 0.3, rar: 0.05, price: 95000, traffic: 0.6,
  pal: [0xf4f4f2, 0xd8202c, 0x2a5aa8, 0x1b1d22, 0x3e4a3d], palette2: 0xe9e6dc, desc: 'Medium-duty box truck. Furniture, fridges, or forty thousand rolls of toilet paper.',
  d: { type: 'truck', cab: 'conventional', hoodLen: 1.45, hoodY: 1.55, hoodW: 1.3, cabLen: 1.65, body: 'box', tanks: 0.8, rim: 'truck', rimColor: 'silver' },
});
V('semi', 'Bulwark', 'Behemoth', 'truck', {
  L: 7.2, W: 2.55, H: 4.0, wb: 4.6, r: 0.52, m: 9200, kw: 400, top: 125, acc60: 11, seats: 2, snd: 'diesel', tier: 0.35, rar: 0.15, price: 165000, traffic: 0.35,
  pal: [0xb3202e, 0xf4f4f2, 0x1b1d22, 0x2a4f9a, 0x3e4a3d, 0xe8c547], desc: 'Long-nose sleeper tractor with chrome stacks. King of the interstate, terror of roundabouts.',
  d: { type: 'truck', cab: 'conventional', hoodLen: 2.15, hoodY: 1.75, hoodW: 1.32, cabLen: 1.6, sleeper: 1.3, fairing: true, stacks: true, tanks: 1.3, tankZ: 0.2, tandem: true, body: 'semi', visor: true, roofMarkers: true, rim: 'truck', rimColor: 'chrome' },
});
V('dump', 'Bulwark', 'Quarry', 'truck', {
  L: 8.3, W: 2.55, H: 3.45, wb: 4.7, r: 0.53, m: 13500, kw: 330, top: 110, acc60: 16, seats: 2, snd: 'diesel', tier: 0.25, rar: 0.2, price: 140000, traffic: 0.25,
  pal: [0xe8a21a, 0xf4f4f2, 0xb3202e, 0x2a4f9a, 0x3e4a3d], palette2: 0x3a3d42, desc: 'Three-axle tipper. Pours gravel, ignores speed bumps, flattens most opinions.',
  d: { type: 'truck', cab: 'conventional', hoodLen: 1.85, hoodY: 1.7, hoodW: 1.3, cabLen: 1.6, tandem: true, body: 'dump', bedMat: 'paint2', tanks: 0.7, stacks: true, load: true, rim: 'truck', rimColor: 'silver', fenderMat: 'dark' },
});
V('tow', 'Ironwood', 'Hookline', 'truck', {
  L: 7.1, W: 2.45, H: 3.0, wb: 4.2, r: 0.46, m: 7000, kw: 250, top: 130, acc60: 11, seats: 2, snd: 'diesel', tier: 0.3, rar: 0.2, price: 110000, traffic: 0.2,
  pal: [0xf4f4f2, 0x1b1d22, 0xb3202e, 0x2a4f9a], palette2: 0xe8a21a, desc: 'Wrecker with a boom and a wheel-lift. Your parking ticket’s angrier older brother.',
  d: { type: 'truck', cab: 'conventional', hoodLen: 1.55, hoodY: 1.5, hoodW: 1.3, cabLen: 1.7, body: 'tow', boomMat: 'paint2', lightbar: 'amber', rim: 'truck', rimColor: 'chrome' },
});
V('mixer', 'Bulwark', 'Mason', 'truck', {
  L: 8.8, W: 2.5, H: 3.8, wb: 4.8, r: 0.53, m: 14500, kw: 330, top: 105, acc60: 18, seats: 2, snd: 'diesel', tier: 0.25, rar: 0.25, price: 155000, traffic: 0.15,
  pal: [0xf4f4f2, 0xe8a21a, 0x2a4f9a, 0xb3202e], palette2: 0xe86a1a, desc: 'Cement mixer with a forever-spinning drum. Do not tailgate. Do not ask.',
  d: { type: 'truck', cab: 'conventional', hoodLen: 1.75, hoodY: 1.7, hoodW: 1.3, cabLen: 1.6, tandem: true, body: 'mixer', drumMat: 'paint2', rim: 'truck', rimColor: 'silver', fenderMat: 'dark' },
});
V('garbage', 'Bulwark', 'Sanitor', 'truck', {
  L: 9.2, W: 2.55, H: 3.6, wb: 5.2, r: 0.53, m: 15500, kw: 280, top: 100, acc60: 18, seats: 2, snd: 'diesel', tier: 0.3, rar: 0.1, price: 210000, traffic: 0.2,
  pal: [0xf4f4f2, 0x2f6b4a, 0xe8a21a, 0x2a4f9a], palette2: 0x2f6b4a, desc: 'Rear-loader garbage truck. Wakes the whole street at six every Tuesday.',
  d: { type: 'truck', cab: 'cabover', cabLen: 2.1, roofMat: 'plate', tandem: true, body: 'garbage', boxMat: 'paint2', hopperMat: 'paint', rim: 'truck', rimColor: 'silver', ohFrac: 0.33 },
});
V('flatbed', 'Ironwood', 'Deckhand', 'truck', {
  L: 8.4, W: 2.5, H: 2.95, wb: 5.0, r: 0.48, m: 8000, kw: 240, top: 120, acc60: 13, seats: 2, snd: 'diesel', tier: 0.3, rar: 0.15, price: 98000, traffic: 0.25,
  pal: [0xf4f4f2, 0x2a4f9a, 0xb3202e, 0x1b1d22], desc: 'Rollback flatbed. Carries broken cars, boats, and the occasional shed.',
  d: { type: 'truck', cab: 'conventional', hoodLen: 1.5, hoodY: 1.55, hoodW: 1.3, cabLen: 1.7, body: 'flatbed', deckMat: 'chrome', beacons: true, cargo: 'crates', rim: 'truck', rimColor: 'silver' },
});
V('tanker', 'Bulwark', 'Tankard', 'truck', {
  L: 9.4, W: 2.5, H: 3.4, wb: 5.4, r: 0.52, m: 13500, kw: 300, top: 110, acc60: 16, seats: 2, snd: 'diesel', tier: 0.3, rar: 0.2, price: 175000, traffic: 0.15,
  pal: [0xf4f4f2, 0xb3202e, 0x1b1d22, 0x2a4f9a], palette2: 0xd8202c, desc: 'Fuel tanker. Drive gently, park far away, never ever light a match.',
  d: { type: 'truck', cab: 'conventional', hoodLen: 1.8, hoodY: 1.7, hoodW: 1.3, cabLen: 1.6, tandem: true, body: 'tanker', tankMat: 'chrome', stripe: 'paint2', stacks: true, rim: 'truck', rimColor: 'chrome' },
});
V('fire_engine', 'Bulwark', 'Blaze 7', 'truck', {
  L: 10.6, W: 2.55, H: 3.5, wb: 5.5, r: 0.52, m: 17500, kw: 380, top: 115, acc60: 14, seats: 6, snd: 'diesel', tier: 0.5, rar: 0.0, price: 650000, traffic: 0.02,
  pal: [0xc81a1e], palette2: 0xf4f4f2, desc: 'Ladder engine. Fifty feet of ladder, a thousand gallons of water, zero patience for parked cars.',
  d: { type: 'truck', cab: 'cabover', cabLen: 2.7, roofMat: 'plate', tandem: true, body: 'fire', lightbar: 'red', rim: 'truck', rimColor: 'chrome', ohFrac: 0.3, bumperMat: 'chrome' },
});
V('step_van', 'Ironwood', 'Route Van', 'truck', {
  L: 7.0, W: 2.4, H: 3.15, wb: 4.1, r: 0.46, m: 6500, kw: 180, top: 115, acc60: 15, seats: 1, snd: 'diesel', tier: 0.3, rar: 0.05, price: 85000, traffic: 0.6,
  pal: [0xf4f4f2, 0x7a4a2a, 0x2a5aa8, 0xe8c547], palette2: 0xd8202c, desc: 'Walk-in parcel van. Stops every forty metres, somehow always in your lane.',
  d: { type: 'truck', cab: 'step', stripe: 'paint2', rim: 'truck', rimColor: 'silver', dual: true },
});

// ---- buses ----
V('city_bus', 'Gatorline', 'Metro 40', 'bus', {
  L: 12.2, W: 2.55, H: 3.15, wb: 6.1, r: 0.5, m: 12500, kw: 220, top: 100, acc60: 18, seats: 1, snd: 'bus', tier: 0.25, rar: 0.0, price: 480000, traffic: 0.25,
  pal: [0xf4f4f2], palette2: 0x16a3a3, desc: 'Low-floor city bus. Kneels at stops, never at traffic.',
  d: { type: 'bus', bus: 'city', stripe: 'paint2', ohFrac: 0.38, rimColor: 'silver' },
});
V('coach', 'Gatorline', 'Cruiseliner', 'bus', {
  L: 13.6, W: 2.55, H: 3.7, wb: 6.9, r: 0.52, m: 15500, kw: 330, top: 115, acc60: 17, seats: 1, snd: 'bus', tier: 0.4, rar: 0.2, price: 560000, traffic: 0.1,
  pal: [0xf4f4f2, 0x2a4f9a, 0x1b1d22], palette2: 0x2a6fd8, desc: 'Highway coach with a toilet, a TV and a driver who has seen everything.',
  d: { type: 'bus', bus: 'coach', tag: true, stripe: 'paint2', ohFrac: 0.4, rimColor: 'chrome' },
});
V('school_bus', 'Gatorline', 'Scholar', 'bus', {
  L: 11.5, W: 2.45, H: 3.15, wb: 6.2, r: 0.5, m: 11000, kw: 200, top: 100, acc60: 20, seats: 1, snd: 'bus', tier: 0.3, rar: 0.0, price: 120000, traffic: 0.15,
  pal: [0xf2b81a], desc: 'Big yellow school bus. Everyone stops when the little red sign comes out.',
  d: { type: 'bus', bus: 'school', ohFrac: 0.3, dual: true, rimColor: 'paint' },
});

// ---- small ----
V('bolla', 'Picco', 'Bolla', 'small', {
  L: 2.35, W: 1.4, H: 1.36, wb: 1.5, r: 0.25, tw: 0.135, m: 460, kw: 9.5, top: 85, accTo: [60, 13], seats: 2, snd: 'moped', engine: 'moped', gears: 4, drive: 'RWD', tier: 0.2, rar: 0.7, price: 18000, traffic: 0.1,
  pal: [0x9fe2c8, 0xe24a3a, 0xf1e6c8, 0x8cc8f0, 0xe6c34a], desc: 'Bubble car with a fridge-door front. Seats two very good friends.',
  ph: { track: [1.18, 0.62] }, roll: 0.9,
  d: { style: 'micro', cab: 'hatch', head: 'round', headR: 0.07, grille: 'none', fbumper: 'body', rbumper: 'chrome', rim: 'steel', rimColor: 'white', noseY: 0.6, noseRake: 0.2, noseRound: 0.09, beltF: 0.78, beltR: 0.8, tailY: 0.8, aOff: -0.25, wsRun: 0.4, backRun: 0.22, roofRound: 0.28, crown: 0.05, taperF: 0.14, taperR: 0.24, bevel: 0.06, cabBevel: 0.13, ohFrac: 0.5, doors: 0, mirrors: 'chrome', indicators: false, handles: false, plate: false, exhaust: 'single', shoulder: 0.1 },
});
V('mame', 'Hoshiro', 'Mame', 'small', {
  L: 3.4, W: 1.48, H: 1.78, wb: 2.52, r: 0.28, tw: 0.155, m: 900, kw: 47, top: 135, acc: 15.5, seats: 4, snd: 'i4', engine: 'i4t', drive: 'FWD', tier: 0.15, rar: 0.4, price: 14000, traffic: 0.5,
  pal: [0xe9e6dc, 0x9fc4e0, 0xe6c34a, 0x6c8a6e, 0xd94f3a], desc: 'Kei car: a phone booth with a turbo. Ridiculously roomy, ridiculously small.',
  d: { style: 'micro', cab: 'wagon', head: 'rect', headH: 0.13, headW: 0.26, grille: 'slot', tail: 'vertical', noseY: 0.78, noseRake: 0.18, beltF: 0.92, beltR: 0.94, tailY: 0.94, aOff: -0.05, wsRun: 0.55, backRun: 0.03, roofRound: 0.1, crown: 0, taperF: 0.06, taperR: 0.02, tailRake: 0.0, bevel: 0.06, cabBevel: 0.07, doors: 4, ohFrac: 0.55, rim: 'steel', rimColor: 'silver', twoTone: 'roof', twoToneColor: 0xf4f4f2, shoulder: 0.05, tumble: 0.04 },
});
V('birdie', 'Fairway', 'Birdie', 'small', {
  L: 2.45, W: 1.22, H: 1.8, wb: 1.65, r: 0.23, tw: 0.18, m: 460, kw: 4.2, top: 30, accTo: [25, 5.5], seats: 2, snd: 'electric', engine: 'cart', gears: 'ev', drive: 'RWD', tier: 0.6, rar: 0.5, price: 9000, traffic: 0.05,
  pal: [0xf4f4f2, 0x2f6b4a, 0xe8d9b5, 0x1b1d22, 0xd8202c], desc: 'Golf cart. Technically street legal in three counties, spiritually legal everywhere.',
  roll: 0.9, lock: 40, brake: 0.9,
  d: { type: 'golfcart', canopy: 'paint2', rim: 'steel', rimColor: 'silver' }, palette2: 0xf4f4f2,
});
V('saam', 'Rikko', 'Saam', 'small', {
  L: 2.75, W: 1.3, H: 1.78, wb: 1.95, r: 0.21, tw: 0.11, m: 470, kw: 8, top: 70, accTo: [50, 9], seats: 3, snd: 'moped', engine: 'moped', gears: 4, drive: 'RWD', tier: 0.1, rar: 0.6, price: 4500, traffic: 0.15,
  pal: [0x16a3a3, 0xf2c014, 0x2f6b4a, 0xd8202c, 0x2a5aa8], palette2: 0x1b1d22, desc: 'Three-wheeled auto-rickshaw. Fits through gaps that do not exist yet.',
  ph: { track: [0.26, 1.14] }, roll: 1.0, lock: 40,
  d: { type: 'tuktuk', canopy: 'paint2' },
});
V('mote', 'Lumo', 'Mote', 'small', {
  L: 2.7, W: 1.66, H: 1.56, wb: 1.87, r: 0.28, tw: [0.165, 0.185], m: 1000, kw: 60, top: 130, acc: 11.5, seats: 2, snd: 'electric', engine: 'electric', gears: 'ev', drive: 'RWD', wf: 0.42, tier: 0.4, rar: 0.25, price: 22000, traffic: 0.4,
  pal: [0xf4f4f2, 0x2fd6d0, 0xf0b24a, 0x9aa7b4, 0xe24a7a], palette2: 0x1b1d22, desc: 'Two-seat electric city pod. Parks nose-in to the kerb, grins at parking wardens.',
  d: { style: 'micro', cab: 'hatch', head: 'slit', drl: 'bar', grille: 'none', tail: 'bar', noseY: 0.72, noseRake: 0.16, noseRound: 0.08, beltF: 0.88, beltR: 0.9, tailY: 0.9, aOff: -0.12, wsRun: 0.6, backRun: 0.1, tailRake: 0.06, roofRound: 0.16, taperF: 0.1, taperR: 0.08, bevel: 0.055, doors: 2, ohFrac: 0.55, twoTone: 'pillars', pillars: 'dark', rim: 'disc', rimColor: 'white', exhaust: 'none', shoulder: 0.07 },
});
V('hatake', 'Hoshiro', 'Hatake', 'small', {
  L: 3.4, W: 1.48, H: 1.8, wb: 1.9, r: 0.28, tw: 0.155, m: 820, kw: 39, top: 120, accTo: [60, 9], seats: 2, snd: 'i4', drive: 'RWD', gears: 5, tier: 0.15, rar: 0.4, price: 11000, traffic: 0.3,
  pal: [0xf4f4f2, 0x9fc4e0, 0x2f6b4a, 0xd94f3a, 0xc7cbd1], palette2: 0x7a5a45, desc: 'Kei truck. Carries a farm’s worth of melons and parks in a single bay.',
  d: { type: 'truck', cab: 'cabover', cabLen: 1.25, cabTop: 1.8, beltH: 0.45, bevel: 0.06, body: 'kei', cargo: true, dual: false, rim: 'steel', rimColor: 'silver', ohFrac: 0.45 },
});

// ---- motorcycles ----
V('fulmine', 'Moto Vela', 'Fulmine 1000', 'motorcycle', {
  L: 2.06, W: 0.74, H: 1.13, wb: 1.42, r: 0.31, tw: [0.12, 0.19], m: 280, kw: 150, top: 299, acc: 2.9, seats: 2, snd: 'motorcycle', tier: 0.6, rar: 0.5, price: 24000, traffic: 0.15,
  pal: [0xd8202c, 0xf4f4f2, 0x1b1d22, 0xe8c547, 0x2a4f9a], palette2: 0x1b1d22, desc: 'Italian superbike. Wheelies in third, prays in fourth.',
  wheelie: true, lean: 52, cg: 0.62, mu: 1.2,
  d: { type: 'bike', bike: 'sport' },
});
V('strada800', 'Moto Vela', 'Corsia 800', 'motorcycle', {
  L: 2.08, W: 0.82, H: 1.12, wb: 1.42, r: 0.31, tw: [0.12, 0.18], m: 270, kw: 85, top: 230, acc: 3.4, seats: 2, snd: 'motorcycle', tier: 0.45, rar: 0.3, price: 13500, traffic: 0.2,
  pal: [0x1b1d22, 0x9aa1aa, 0xe8c547, 0x3b8a3a, 0xd8202c], palette2: 0x3a3d42, desc: 'Naked roadster: no fairing, no excuses, all torque.',
  wheelie: true, lean: 48, cg: 0.64,
  d: { type: 'bike', bike: 'naked' },
});
V('roadhouse', 'Sidewinder', 'Roadhouse', 'motorcycle', {
  L: 2.45, W: 0.96, H: 1.4, wb: 1.65, r: 0.33, tw: [0.13, 0.18], m: 420, kw: 70, top: 185, acc: 4.6, seats: 2, snd: 'motorcycle', engine: 'motoTwin', gears: 'moto', tier: 0.5, rar: 0.3, price: 26000, traffic: 0.15,
  pal: [0x1b1d22, 0x6d1f2a, 0x2b3a55, 0xe9dfc8, 0x7a1f2b], palette2: 0xd9d4c8, desc: 'Big V-twin bagger. Saddlebags, a batwing fairing and a radio louder than the engine.',
  lean: 34, cg: 0.6, leanRate: 2.6,
  d: { type: 'bike', bike: 'cruiser' },
});
V('piccola', 'Moto Vela', 'Piccola 125', 'motorcycle', {
  L: 1.86, W: 0.72, H: 1.16, wb: 1.32, r: 0.25, tw: [0.1, 0.11], m: 200, kw: 9, top: 98, accTo: [60, 7.5], seats: 2, snd: 'moped', engine: 'moped', gears: 'scooter', tier: 0.15, rar: 0.05, price: 3200, traffic: 0.35,
  pal: [0x9fe2c8, 0xe8c547, 0xd8202c, 0xf1e6c8, 0x8cc8f0, 0x1b1d22], palette2: 0xe9e6dc, desc: 'Retro scooter. The official vehicle of pizza delivery and Sunday romance.',
  lean: 40, cg: 0.6, mu: 1.05,
  d: { type: 'bike', bike: 'scooter' },
});
V('arashi', 'Kazemoto', 'Arashi 250', 'motorcycle', {
  L: 2.16, W: 0.82, H: 1.26, wb: 1.48, r: 0.355, tw: [0.08, 0.11], m: 190, kw: 30, top: 135, acc: 5.4, seats: 1, snd: 'motorcycle', redline: 11000, tier: 0.3, rar: 0.3, price: 8500, traffic: 0.1,
  pal: [0x3b8a3a, 0xe24a1e, 0x2a4f9a, 0xf2c014, 0xf4f4f2], palette2: 0xf4f4f2, desc: 'Dirt bike. Long travel, knobbly tyres, permanently muddy number plate.',
  wheelie: true, lean: 45, cg: 0.7, travel: 0.22, freq: [1.6, 1.7],
  d: { type: 'bike', bike: 'dirt' },
});
V('rattler', 'Sidewinder', 'Rattler', 'motorcycle', {
  L: 2.7, W: 0.9, H: 1.15, wb: 1.95, r: 0.34, tw: [0.09, 0.24], m: 380, kw: 75, top: 180, acc: 5.2, seats: 1, snd: 'motorcycle', engine: 'motoTwin', gears: 'moto', tier: 0.4, rar: 0.5, price: 31000, traffic: 0.08,
  pal: [0x1b1d22, 0xb3202e, 0x5b2a8c, 0xe8c547, 0x9aa1aa], palette2: 0xd9dee6, desc: 'Long-fork chopper. Turns like a freight train, looks like a rock album cover.',
  lean: 30, cg: 0.55, leanRate: 2.4, lock: 28,
  d: { type: 'bike', bike: 'chopper' },
});

// ---- bicycles ----
V('aero', 'Heron', 'Aero', 'bicycle', {
  L: 1.75, W: 0.44, H: 1.0, wb: 1.0, r: 0.34, tw: 0.028, m: 83, kw: 0.42, top: 38, accTo: [30, 7.5], seats: 1, snd: 'bicycle', tier: 0.5, rar: 0.4, price: 3800, traffic: 0.05,
  pal: [0xf4f4f2, 0xd8202c, 0x1b1d22, 0x2fd6d0, 0xe8c547], palette2: 0x1b1d22, desc: 'Carbon road bike. Lighter than your shopping, faster than your excuses.',
  lean: 40, cg: 0.9,
  d: { type: 'bicycle', bicycle: 'road' },
});
V('kickflip', 'Gecko', 'Kickflip', 'bicycle', {
  L: 1.5, W: 0.7, H: 0.95, wb: 0.95, r: 0.255, tw: 0.055, m: 86, kw: 0.38, top: 30, accTo: [20, 4.5], seats: 1, snd: 'bicycle', tier: 0.2, rar: 0.2, price: 420, traffic: 0.05,
  pal: [0x2fd6d0, 0xff4fa0, 0xe8c547, 0x1b1d22, 0xf4f4f2], palette2: 0x1b1d22, desc: 'BMX. Twenty-inch wheels, pegs, and a life spent sideways on handrails.',
  lean: 40, cg: 0.85,
  d: { type: 'bicycle', bicycle: 'bmx' },
});
V('switchback', 'Talus', 'Switchback', 'bicycle', {
  L: 1.86, W: 0.78, H: 1.1, wb: 1.15, r: 0.37, tw: 0.06, m: 88, kw: 0.4, top: 34, accTo: [25, 5.8], seats: 1, snd: 'bicycle', tier: 0.4, rar: 0.3, price: 1900, traffic: 0.04,
  pal: [0x3b8a3a, 0xe24a1e, 0x2a4f9a, 0x1b1d22, 0xf2c014], palette2: 0x1b1d22, desc: 'Full-suspension mountain bike. Treats kerbs as features, not obstacles.',
  lean: 40, cg: 0.9, mu: 1.0,
  d: { type: 'bicycle', bicycle: 'mtb' },
});
V('boardwalk', 'Heron', 'Boardwalk', 'bicycle', {
  L: 1.86, W: 0.66, H: 1.05, wb: 1.12, r: 0.33, tw: 0.055, m: 93, kw: 0.32, top: 28, accTo: [20, 5.5], seats: 1, snd: 'bicycle', tier: 0.3, rar: 0.1, price: 450, traffic: 0.08,
  pal: [0x9fe2c8, 0xff7a6b, 0xf1e6c8, 0x8cc8f0, 0xe6c34a], palette2: 0xd9dee6, desc: 'Beach cruiser with a wicker basket. Built for boardwalks and zero hurry.',
  lean: 36, cg: 0.9, leanRate: 2.6,
  d: { type: 'bicycle', bicycle: 'cruiser' },
});

// ---------- finalize ----------
const KIND = { compact: 'car', sedan: 'car', coupe: 'car', sports: 'car', super: 'car', muscle: 'car', classic: 'car', suv: 'car', pickup: 'car', van: 'van', luxury: 'car', service: 'car', truck: 'truck', bus: 'bus', small: 'small', motorcycle: 'motorcycle', bicycle: 'bicycle' };

// the six original hand-tuned vehicles (physics in presets.js, hand-made models in design/legacy.js)
const LEGACY = {
  comet: { name: 'Shiden', brand: 'Kazemoto', category: 'sports', top: 245, acc: 4.3, seats: 2, snd: 'v6', tier: 0.55, rar: 0.35, price: 46000, traffic: 0.5, pal: [0xff2e88, 0xf4f4f2, 0x18191c, 0x2fd6d0, 0xe8c547, 0xd8202c], desc: 'Eighties wedge with pop-up headlamps and a flat-six that lives at the redline.' },
  muscle: { name: 'Bullhorn GT', brand: 'Marlin', category: 'muscle', top: 220, acc: 5.1, seats: 4, snd: 'v8', tier: 0.45, rar: 0.3, price: 52000, traffic: 0.5, pal: [0xff7a1a, 0x18191c, 0xd8202c, 0x2a4f9a, 0xf4f4f2, 0xe8c547], desc: 'Quad headlamps, a bonnet scoop and stripes from nose to tail. Subtle it is not.' },
  super: { name: 'Vapore', brand: 'Corsa Nera', category: 'super', top: 300, acc: 2.9, seats: 2, snd: 'v12', tier: 0.95, rar: 0.85, price: 280000, traffic: 0.03, pal: [0x14d2c8, 0xff7a10, 0xf2c014, 0x1b1d22, 0xf4f4f2], desc: 'Mid-engined V10 dart with a fixed wing and an all-wheel-drive grip on reality.' },
  suv: { name: 'Backcountry', brand: 'Ironwood', category: 'suv', top: 185, acc: 7.3, seats: 5, snd: 'v6', tier: 0.4, rar: 0.1, price: 38000, traffic: 1.2, pal: [0x6b3fa0, 0x3e4a3d, 0xf4f4f2, 0x1b1d22, 0xd9cdb4, 0x8a1b25], desc: 'Honest two-box 4x4 with a spare wheel on the back and mud on everything else.' },
  pickup: { name: 'Fieldhand', brand: 'Ironwood', category: 'pickup', top: 175, acc: 7.8, seats: 3, snd: 'v8', tier: 0.25, rar: 0.05, price: 28000, traffic: 1.2, pal: [0xe8e2d4, 0x8a1b25, 0x2a4f7a, 0x1b1d22, 0x6c8a6e, 0xf4f4f2], desc: 'Regular-cab V8 pickup. Hauls lumber on weekdays and jet skis on weekends.' },
  cruiser: { name: 'Sentry', brand: 'Marlin', category: 'service', top: 232, acc: 5.7, seats: 5, snd: 'v8', tier: 0.4, rar: 0, price: 45000, traffic: 0.12, pal: [0xf4f4f2], desc: 'Police pursuit sedan. Push bar, light bar, and a V8 tuned for chasing you.' },
};

function finalize(r) {
  if (r.o.legacy) {
    const id = r.o.legacy, L = LEGACY[id];
    return {
      id, name: L.name, brand: L.brand, category: L.category, kind: 'car', tier: L.tier, rarity: L.rar, price: L.price,
      topSpeedKmh: L.top, accel0100: L.acc, accel060: null, seats: L.seats, engineSound: L.snd, palette: L.pal, desc: L.desc,
      trafficWeight: L.traffic, layout: id === 'super' ? 'mid' : 'front', legacy: true, preset: null,
    };
  }
  const o = r.o;
  const e = {
    id: r.id,
    name: r.name,
    brand: r.brand,
    category: r.category,
    kind: o.kind ?? KIND[r.category] ?? 'car',
    tier: o.tier ?? 0.3,
    rarity: o.rar ?? 0.2,
    price: o.price ?? 20000,
    topSpeedKmh: o.top,
    accel0100: o.acc ?? null,
    accel060: o.acc60 ?? null,
    accelTarget: o.accTo ? { kmh: o.accTo[0], s: o.accTo[1] } : o.acc60 ? { kmh: 60, s: o.acc60 } : o.acc ? { kmh: 100, s: o.acc } : null,
    accelMeasured: MEASURED[r.id] ? { kmh: MEASURED[r.id][0], s: MEASURED[r.id][1] } : null,
    seats: o.seats ?? 4,
    engineSound: o.snd ?? 'i4',
    palette: o.pal,
    desc: o.desc ?? '',
    trafficWeight: o.traffic ?? 0.5,
    layout: o.layout ?? o.d?.layout ?? 'front',
    _o: o,
  };
  if (o.d) e._o.d = { layout: e.layout, ...o.d, seats: e.seats };
  if (e.accelMeasured?.kmh === 100) e.accel0100 = Math.round(e.accelMeasured.s * 10) / 10;
  if (e.accelMeasured?.kmh === 60) e.accel060 = Math.round(e.accelMeasured.s * 10) / 10;
  if (o.palette2 ?? o.d?.twoToneColor) e.palette2 = o.palette2 ?? o.d.twoToneColor;
  e.preset = buildPreset(e);
  delete e._o;
  return e;
}

export const VEHICLE_CATALOG = RAW.map(finalize);

// tracked vehicles: own controllable class (src/vehicle/tank), spawned through entry.create
VEHICLE_CATALOG.push({
  id: 'tank', name: 'Mastodon', brand: 'Ironwood', category: 'military', kind: 'tank', tier: 1, rarity: 1, price: 1500000,
  topSpeedKmh: 65, accel0100: null, accel060: 15.4, accelTarget: { kmh: 40, s: 9 }, accelMeasured: { kmh: 40, s: 8.6 }, // test-tank.mjs
  massKg: 55000, seats: 1, engineSound: 'diesel', palette: [0xc2a878, 0x5d6b3e, 0x646d5c, 0x7c8186, 0x434f37],
  desc: 'Fifty-five tonnes of main battle tank: turns on the spot, flattens whatever it touches and reloads in three seconds.',
  trafficWeight: 0, layout: 'rear', preset: null,
  create: (game, pos, yaw = 0, opts = {}) => new Tank(game, { position: pos, yaw, color: opts.color, entry: getCatalogEntry('tank') }),
  buildPreview: ({ lod = 'high', color } = {}) => buildTankPreview({ lod, color }),
  bake: (color) => bakeTank('tank', color),
});
const BY_ID = new Map(VEHICLE_CATALOG.map((e) => [e.id, e]));

/** Catalog entry by id (or undefined). */
export function getCatalogEntry(id) {
  return BY_ID.get(id);
}

/** Physics/design presets keyed by id (merged into VEHICLE_PRESETS). */
export const CATALOG_PRESETS = Object.fromEntries(VEHICLE_CATALOG.filter((e) => e.preset).map((e) => [e.id, e.preset]));

export const CATEGORIES = ['compact', 'sedan', 'coupe', 'sports', 'super', 'muscle', 'classic', 'suv', 'pickup', 'van', 'luxury', 'service', 'truck', 'bus', 'small', 'motorcycle', 'bicycle', 'military'];
