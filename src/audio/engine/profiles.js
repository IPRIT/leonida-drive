// Engine sound profiles: worklet config (see engineWorklet.js) + main-thread behaviour.
// formants: [Hz, Q, gain] — fixed exhaust/muffler resonances the rpm harmonics sweep through.
// pipe: per-bank waveguide length in ms (resonance spacing = 1000/ms Hz), pipeFb < 0 = closed-pipe odd harmonics.

const even = (n) => Array.from({ length: n }, (_, i) => i / n);

export const PROFILES = {
  // ---- cars: deep body + mid growl; a 4th-order muffler keeps the top end closed (no moped buzz) ----
  // body/sub: phase-locked firing fundamental + half-order (burble); muffler → mufflerOpen follows load/rpm
  i4: {
    mode: 'ice', fireCap: 300, idleComp: 0.35, cyl: 4, offsets: even(4), banks: [0, 0, 0, 0], pipe: [4.6, 4.6], pipeFb: 0.34, pipeDamp: 2400,
    formants: [[100, 1.2, 0.75], [210, 1.5, 0.65], [360, 2, 0.45], [620, 2.5, 0.18]], direct: 0.6, directF: 220,
    muffler: 420, mufflerOpen: 1400, pulse: 0.32, fast: 0.0003, sharp: 0.3, rough: 0.3, jitter: 0.05, body: 0.18, sub: 0.1,
    intake: [650, 1, 0.3], mech: 0.1, drive: 1.25, harsh: 0.8, crackle: 0.35, turbo: 0.6, turboF: [1800, 4800],
    idle: 850, max: 7000, level: 0.5, bov: true, startDur: 0.6, starterHz: 190,
  },
  v6: {
    mode: 'ice', fireCap: 330, idleComp: 0.35, cyl: 6, offsets: even(6), banks: [0, 1, 0, 1, 0, 1], pipe: [4.0, 4.7], pipeFb: 0.3, pipeDamp: 2400, bankGain: [1, 0.85],
    formants: [[90, 1.2, 0.8], [190, 1.5, 0.65], [330, 2, 0.45], [560, 2.5, 0.2]], direct: 0.6, directF: 210,
    muffler: 380, mufflerOpen: 1300, pulse: 0.34, fast: 0.0003, sharp: 0.32, rough: 0.32, jitter: 0.05, body: 0.2, sub: 0.15,
    intake: [600, 1, 0.3], mech: 0.1, drive: 1.35, harsh: 0.9, crackle: 0.55, turbo: 0.5, turboF: [1700, 4600],
    idle: 800, max: 7200, level: 0.6, bov: true, shiftPop: 0.5, startDur: 0.65, starterHz: 175,
  },
  v8: {
    mode: 'ice', fireCap: 360, idleComp: 0.35, cyl: 8, offsets: even(8), banks: [0, 1, 1, 0, 1, 0, 0, 1], pipe: [5.8, 6.9], pipeFb: 0.38, pipeDamp: 1800, bankGain: [1, 0.72],
    formants: [[68, 1.1, 0.9], [140, 1.4, 0.75], [260, 1.8, 0.5], [450, 2.2, 0.25]], direct: 0.75, directF: 180,
    muffler: 300, mufflerOpen: 1100, pulse: 0.36, fast: 0.00034, sharp: 0.28, rough: 0.28, jitter: 0.08, lope: 0.65, body: 0.25, sub: 0.5,
    intake: [450, 1, 0.3], mech: 0.08, drive: 1.5, harsh: 1.0, crackle: 0.85, idle: 750, max: 6500, level: 0.6,
    startDur: 0.8, starterHz: 160,
  },
  v12: {
    mode: 'ice', fireCap: 560, idleComp: 0.35, cyl: 12, offsets: even(12), banks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], pipe: [2.6, 3.0], pipeFb: 0.26, pipeDamp: 3500, bankGain: [1, 0.9],
    formants: [[130, 1.3, 0.6], [280, 1.8, 0.6], [480, 2.2, 0.45], [850, 2.5, 0.25]], direct: 0.5, directF: 260,
    muffler: 480, mufflerOpen: 1600, pulse: 0.32, fast: 0.00026, sharp: 0.35, rough: 0.22, jitter: 0.03, body: 0.15, sub: 0.1,
    intake: [900, 1, 0.3], mech: 0.08, drive: 1.3, harsh: 0.8, crackle: 0.45, idle: 950, max: 8800, level: 0.85,
    shiftPop: 0.8, startDur: 0.55, starterHz: 200,
  },
  diesel: {
    mode: 'ice', idleComp: 0.35, cyl: 6, offsets: even(6), banks: [0, 0, 0, 0, 0, 0], pipe: [7, 7], pipeFb: 0.3, pipeDamp: 1500,
    formants: [[58, 1, 0.9], [130, 1.4, 0.65], [260, 1.8, 0.4], [480, 2, 0.2]], direct: 0.8, directF: 170,
    muffler: 260, mufflerOpen: 900, pulse: 0.36, fast: 0.00038, sharp: 0.35, rough: 0.45, jitter: 0.06, body: 0.25, sub: 0.25,
    knock: 0.25, knockF: 1500, intake: [400, 1, 0.25], mech: 0.12, drive: 1.5, harsh: 1.0, crackle: 0,
    turbo: 0.9, turboF: [1400, 4600], idle: 650, max: 3200, level: 0.45, startDur: 1.0, starterHz: 140, airBrake: true,
  },
  bus: {
    mode: 'ice', idleComp: 0.35, cyl: 6, offsets: even(6), banks: [0, 0, 0, 0, 0, 0], pipe: [9, 9], pipeFb: 0.4, pipeDamp: 1200,
    formants: [[50, 1, 0.9], [110, 1.4, 0.6], [220, 1.8, 0.35], [400, 2, 0.18]], direct: 0.85, directF: 160,
    muffler: 220, mufflerOpen: 700, pulse: 0.38, fast: 0.0004, sharp: 0.35, rough: 0.4, jitter: 0.05, body: 0.28, sub: 0.25,
    knock: 0.2, knockF: 1400, intake: [380, 1, 0.2], mech: 0.12, drive: 1.4, harsh: 0.8, crackle: 0,
    turbo: 0.6, turboF: [1200, 3800], idle: 600, max: 2600, level: 0.45, startDur: 1.1, starterHz: 130, airBrake: true, reverseBeep: true,
  },
  // ---- two-wheelers: allowed to be bright and buzzy ----
  moped: {
    mode: 'ice', cyl: 1, stroke: 2, offsets: [0], banks: [0], pipe: [1.4, 1.4], pipeFb: -0.5, pipeDamp: 6000,
    formants: [[420, 5, 0.8], [1500, 4, 0.9], [3100, 3, 0.5]], direct: 0.2, directF: 300,
    muffler: 2800, mufflerOpen: 8000, pulse: 0.28, fast: 0.0002, sharp: 0.8, rough: 0.5, jitter: 0.08, misfire: 0.3, idleComp: 1.8,
    intake: [2200, 1.2, 0.3], mech: 0.35, drive: 2, harsh: 1, crackle: 0.15, idle: 1700, max: 9500, level: 1.3,
    startDur: 0.3, starterHz: 260,
  },
  motorcycle: {
    mode: 'ice', cyl: 4, offsets: even(4), banks: [0, 0, 0, 0], pipe: [2.2, 2.2], pipeFb: 0.3, pipeDamp: 5000,
    formants: [[130, 1.3, 0.5], [450, 2, 0.6], [1300, 2.5, 0.6], [2900, 3, 0.5]], direct: 0.4, directF: 300,
    muffler: 1600, mufflerOpen: 6500, pulse: 0.3, fast: 0.00022, sharp: 0.6, rough: 0.35, jitter: 0.04, body: 0.08,
    intake: [1500, 0.9, 0.7], mech: 0.3, drive: 1.5, harsh: 1, crackle: 0.6, idle: 1300, max: 13500, level: 0.8,
    shiftPop: 0.6, startDur: 0.4, starterHz: 240,
  },
  vtwin: {
    mode: 'ice', idleComp: 0.35, cyl: 2, offsets: [0, 0.4375], banks: [0, 0], pipe: [4.5, 4.5], pipeFb: 0.35, pipeDamp: 2200,
    formants: [[70, 1, 0.8], [150, 1.4, 0.6], [300, 1.8, 0.4], [600, 2.2, 0.2]], direct: 0.75, directF: 200,
    muffler: 450, mufflerOpen: 1600, pulse: 0.4, fast: 0.0003, sharp: 0.4, rough: 0.35, jitter: 0.07, lope: 0.3, body: 0.2, sub: 0.35,
    intake: [600, 1, 0.35], mech: 0.25, drive: 1.6, harsh: 1.2, crackle: 0.5, idle: 950, max: 6000, level: 0.55,
    startDur: 0.5, starterHz: 170,
  },
  prop: {
    mode: 'ice', cyl: 6, offsets: even(6), banks: [0, 1, 0, 1, 0, 1], pipe: [3.5, 3.9], pipeFb: 0.25, pipeDamp: 3000,
    formants: [[85, 1.2, 0.6], [200, 1.6, 0.6], [400, 2, 0.4], [800, 2.5, 0.25]], direct: 0.5,
    muffler: 700, mufflerOpen: 2000, pulse: 0.34, sharp: 0.4, rough: 0.35, jitter: 0.05, intake: [700, 1, 0.25], body: 0.15, sub: 0.1,
    mech: 0.2, drive: 1.4, harsh: 0.8, crackle: 0.1, prop: { blades: 2, ratio: 1, amt: 0.9 }, idle: 700, max: 2700, level: 0.75,
    startDur: 1.2, starterHz: 150,
  },
  boat: {
    mode: 'ice', cyl: 6, offsets: even(6), banks: [0, 1, 0, 1, 0, 1], pipe: [3.8, 4.4], pipeFb: 0.3, pipeDamp: 2600,
    formants: [[95, 1.2, 0.6], [220, 1.6, 0.6], [420, 2, 0.45], [800, 2.5, 0.25]], direct: 0.5,
    muffler: 600, mufflerOpen: 2000, pulse: 0.33, sharp: 0.4, rough: 0.35, jitter: 0.05, intake: [800, 1, 0.3], body: 0.12, sub: 0.1,
    mech: 0.2, drive: 1.4, harsh: 1.0, whine: 0.25, whineRatio: 2.1, crackle: 0.1, idle: 800, max: 6000, level: 0.75,
    startDur: 0.7, starterHz: 180,
  },
  electric: {
    mode: 'ev', poles: 4, teeth: 23, whine: 0.5, gear: 0.25, inverter: 0.12, avas: 0.15, idle: 0, max: 16000, level: 1.8,
    startDur: 0,
  },
  jet: { mode: 'turbine', fanMax: 2400, compMax: 8200, fan: 0.5, comp: 0.4, roar: 1, buzz: 0.5, idle: 2400, max: 10000, level: 1.3, startDur: 0 },
  heli: { mode: 'rotor', blades: 4, tailRatio: 6.5, tailBlades: 3, tail: 0.6, turbineHz: 4800, idle: 0, max: 390, level: 1.0, startDur: 0 },
  bicycle: { mode: 'bike', idle: 0, max: 1, level: 1.8, startDur: 0 },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

// aliases from catalog `engineSound` strings / vehicle kinds
const KIND_DEFAULT = {
  car: 'v6', small: 'i4', van: 'v6', truck: 'diesel', bus: 'bus', motorcycle: 'motorcycle', bike: 'motorcycle',
  moped: 'moped', scooter: 'moped', bicycle: 'bicycle', heli: 'heli', helicopter: 'heli', plane: 'prop', jet: 'jet',
  boat: 'boat', ev: 'electric', electric: 'electric', chopper: 'vtwin',
};

export function resolveProfile(name, kind) {
  if (name && PROFILES[name]) return name;
  if (name && KIND_DEFAULT[name]) return KIND_DEFAULT[name];
  return KIND_DEFAULT[kind] || 'v6';
}

// player-car presets (src/vehicle/presets.js `audio` block) → profile + overrides
export function profileFromCarAudio(a) {
  if (!a) return { profile: 'v6', overrides: {} };
  const cyl = a.cylinders || 6;
  let profile = cyl <= 4 ? 'i4' : cyl <= 6 ? 'v6' : cyl <= 8 ? 'v8' : 'v12';
  const ov = {};
  if (a.turbo !== undefined) ov.turbo = a.turbo;
  if (a.crackle !== undefined) ov.crackle = a.crackle;
  if (a.lope !== undefined && profile === 'v8') ov.lope = a.lope * 0.85;
  if (cyl === 10) {
    // V10: 72° even fire — the highest-pitched car, but still with body
    Object.assign(ov, { cyl: 10, offsets: even(10), banks: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], pipe: [3.0, 3.4], formants: [[120, 1.3, 0.65], [260, 1.8, 0.6], [460, 2.2, 0.45], [820, 2.5, 0.25]], muffler: 520, mufflerOpen: 1700, body: 0.16, fireCap: 520 });
  }
  if (a.cutoff) { ov.mufflerMul = a.cutoff; }
  return { profile, overrides: ov };
}
