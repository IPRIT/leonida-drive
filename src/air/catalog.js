// Aircraft catalog entries for VehicleManager.addCatalog (all names and brands are original/fictional).
import { Heli } from './Heli.js';
import { Plane } from './Plane.js';

const E = (o, Cls) => {
  const entry = { ...o };
  entry.create = (game, pos, yaw, opts = {}) => new Cls(game, entry, pos, yaw, opts);
  return entry;
};

export const AIR_CATALOG = [
  E({
    id: 'heli_news', name: 'Vella N2', brand: 'Vireo Rotorworks', category: 'heli', kind: 'heli', tier: 2, price: 650000,
    topSpeedKmh: 225, seats: 2, engineSound: 'heli',
    desc: 'Bubble-canopy two-seater with a nose camera. Light, quick to spool and easy to hover.',
  }, Heli),
  E({
    id: 'heli_police', name: 'Sentry U4', brand: 'Corvane', category: 'heli', kind: 'heli', tier: 3, price: 1450000,
    topSpeedKmh: 260, seats: 4, engineSound: 'heli',
    desc: 'Utility helicopter with a steerable searchlight and strobe bar (H light, L strobes).',
  }, Heli),
  E({
    id: 'heli_cargo', name: 'Mule T2', brand: 'Brannock Heavy Lift', category: 'heli', kind: 'heli', tier: 4, price: 3900000,
    topSpeedKmh: 275, seats: 4, engineSound: 'heli',
    desc: 'Tandem-rotor workhorse. Slow to turn, unstoppable in a straight line.',
  }, Heli),
  E({
    id: 'plane_trainer', name: 'Pipit 150', brand: 'Halcyon Aircraft', category: 'plane', kind: 'plane', tier: 1, price: 240000,
    topSpeedKmh: 230, seats: 2, engineSound: 'prop',
    desc: 'Forgiving high-wing trainer. Lifts off around 110 km/h and lands almost anywhere.',
  }, Plane),
  E({
    id: 'plane_stunt', name: 'Vortica S1', brand: 'Brio Aero', category: 'plane', kind: 'plane', tier: 3, price: 780000,
    topSpeedKmh: 340, seats: 1, engineSound: 'prop',
    desc: 'Aerobatic taildragger with a 180°/s roll rate and a smoke system (X).',
  }, Plane),
  E({
    id: 'plane_seaplane', name: 'Tarpon F4', brand: 'Gulfline', category: 'plane', kind: 'plane', tier: 2, price: 520000,
    topSpeedKmh: 250, seats: 4, engineSound: 'prop',
    desc: 'Float plane for the Keys: takes off from and lands on open water.',
  }, Plane),
  E({
    id: 'plane_jet', name: 'Solstice 7', brand: 'Lumen Aviation', category: 'plane', kind: 'plane', tier: 5, price: 8500000,
    topSpeedKmh: 780, seats: 6, engineSound: 'jet',
    desc: 'Twin-engine business jet with retractable gear (B) and flaps (G). Needs a real runway.',
  }, Plane),
];
