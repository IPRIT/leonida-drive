// Boat catalog entries for VehicleManager.addCatalog (all names and brands are original/fictional).
import { Boat } from './Boat.js';

const E = (o) => {
  const entry = { ...o };
  entry.create = (game, pos, yaw, opts = {}) => new Boat(game, entry, pos, yaw, opts);
  return entry;
};

export const BOAT_CATALOG = [
  E({
    id: 'boat_speed', name: 'Riptide 33', brand: 'Coral Marine', category: 'boat', kind: 'boat', tier: 3, price: 285000,
    topSpeedKmh: 110, seats: 2, engineSound: 'boat',
    desc: 'Offshore speedboat that planes fast and leans hard into turns.',
  }),
  E({
    id: 'boat_jetski', name: 'Zipfin JX', brand: 'Wavelynx', category: 'boat', kind: 'boat', tier: 1, price: 16500,
    topSpeedKmh: 94, seats: 2, engineSound: 'boat',
    desc: 'Jet ski: steers only under throttle, carves tight and throws a rooster tail.',
  }),
  E({
    id: 'boat_cruiser', name: 'Sunward 38', brand: 'Marisol Yachts', category: 'boat', kind: 'boat', tier: 4, price: 640000,
    topSpeedKmh: 64, seats: 2, engineSound: 'boat',
    desc: 'Cabin cruiser with a flybridge. Heavy, steady and in no hurry.',
  }),
  E({
    id: 'boat_airboat', name: 'Glade Runner', brand: 'Sawgrass Works', category: 'boat', kind: 'boat', tier: 2, price: 48000,
    topSpeedKmh: 70, seats: 3, engineSound: 'prop',
    desc: 'Fan-driven swamp boat. Skims over shallow water, mud and grass; slides in turns.',
  }),
];
