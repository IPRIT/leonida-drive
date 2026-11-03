import { VEHICLE_PRESETS } from '../vehicle/presets.js';

// Category order of the VEHICLES tab (ids are i18n keys `cat.<id>`).
export const CATEGORIES = ['compact', 'sedan', 'coupe', 'sports', 'super', 'muscle', 'classic', 'suv', 'pickup', 'van', 'luxury',
  'service', 'trucks', 'buses', 'small', 'motorcycles', 'bicycles', 'helicopters', 'planes', 'boats', 'military', 'other'];

const ALIAS = {
  compacts: 'compact', hatchback: 'compact', sedans: 'sedan', saloon: 'sedan', coupes: 'coupe', sport: 'sports', sportscar: 'sports',
  supercar: 'super', supers: 'super', hypercar: 'super', classics: 'classic', sportsclassic: 'classic', vintage: 'classic',
  suvs: 'suv', offroad: 'suv', '4x4': 'suv', pickups: 'pickup', truck: 'trucks', commercial: 'trucks', industrial: 'trucks',
  bus: 'buses', coach: 'buses', vans: 'van', emergency: 'service', police: 'service', utility: 'service', services: 'service',
  motorcycle: 'motorcycles', moto: 'motorcycles', bike: 'motorcycles', motorbike: 'motorcycles', scooter: 'motorcycles', moped: 'motorcycles',
  bicycle: 'bicycles', cycle: 'bicycles', cycles: 'bicycles', heli: 'helicopters', helicopter: 'helicopters', plane: 'planes',
  aircraft: 'planes', airplane: 'planes', jet: 'planes', boat: 'boats', ship: 'boats', watercraft: 'boats', smalls: 'small', offroadsmall: 'small',
  quad: 'small', kart: 'small', tank: 'military', tanks: 'military', army: 'military', armored: 'military', armoured: 'military',
};
const PRESET_CATEGORY = { comet: 'sports', muscle: 'muscle', super: 'super', suv: 'suv', pickup: 'pickup', cruiser: 'service', tank: 'military' };

const DOMAIN = { helicopters: 'heli', planes: 'plane', boats: 'boat', bicycles: 'bicycle', motorcycles: 'moto', military: 'armor' };
const SPEED_MAX = { land: 360, moto: 330, bicycle: 70, heli: 380, plane: 950, boat: 160, armor: 110 };
const BASE = { // [handling 0..1, mass kg, 0-100 s] when the entry has no figures
  compact: [0.62, 1150, 11], sedan: [0.55, 1500, 9], coupe: [0.66, 1450, 6.5], sports: [0.8, 1400, 4.6], super: [0.86, 1450, 3.0],
  muscle: [0.52, 1650, 5.2], classic: [0.55, 1350, 8], suv: [0.45, 2200, 8.5], pickup: [0.42, 2100, 9], van: [0.36, 2400, 13],
  luxury: [0.6, 1950, 5.8], service: [0.58, 1900, 7], trucks: [0.24, 9000, 25], buses: [0.2, 12000, 30], small: [0.7, 450, 9],
  motorcycles: [0.88, 220, 3.4], bicycles: [0.75, 14, 12], helicopters: [0.6, 2400, 0], planes: [0.5, 6000, 0], boats: [0.5, 1600, 0],
  military: [0.3, 45000, 14],
  other: [0.55, 1500, 9],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

function aliasOf(v) {
  const k = norm(v);
  if (!k || k === 'car' || k === 'cars') return null;
  if (CATEGORIES.includes(k)) return k;
  return ALIAS[k] || null;
}

export function categoryOf(e) {
  return aliasOf(e.category) || aliasOf(e.kind) || PRESET_CATEGORY[e.id] || 'other';
}

export function colorNum(c) {
  if (typeof c === 'number') return c;
  const s = String(c || '').replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((x) => x + x).join('') : s, 16);
  return Number.isFinite(n) ? n : 0xffffff;
}
export const colorCss = (c) => `#${colorNum(c).toString(16).padStart(6, '0')}`;

export const DEFAULT_PALETTE = [0xff3a8c, 0x29f0e0, 0xf4f4f4, 0xff8a3d, 0xa24dff, 0x15151a, 0xf5c84c, 0x2c7fd0, 0x7a0f1c, 0x6f7a80];

// View model for the VEHICLES tab: spawnable entries (game.vehicles.catalog) enriched with the big catalog / presets.
export function buildModels(spawnable, bigCatalog = []) {
  const extra = new Map(bigCatalog.map((e) => [e.id, e]));
  return spawnable.map((raw, order) => {
    const e = { ...(extra.get(raw.id) || {}), ...stripEmpty(raw) };
    const p = VEHICLE_PRESETS[e.id];
    const cat = categoryOf(e);
    const base = BASE[cat] || BASE.other;
    const domain = DOMAIN[cat] || 'land';
    const name = (e.name && e.name !== e.id) ? e.name : p?.label || e.name || e.id;
    const top = e.topSpeedKmh ?? e.topSpeed ?? p?.gearbox?.topSpeedKmh;
    const mass = e.massKg ?? e.mass ?? e.weightKg ?? e.preset?.mass ?? p?.mass ?? base[1];
    const ground = domain === 'land' || domain === 'moto' || domain === 'bicycle' || domain === 'armor';
    const accel = e.accel0100 ?? (ground ? estimateAccel(p || e.preset, base[2]) : null);
    const tier = typeof e.tier === 'number' ? e.tier : null;
    const handling = e.handling ?? clamp01(base[0] + (tier === null ? 0 : tier <= 1 ? (tier - 0.3) * 0.3 : (tier - 2) * 0.04));
    const sMax = SPEED_MAX[domain];
    return {
      id: e.id, order, name, brand: e.brand || '', cat, kind: e.kind || 'car', desc: e.desc || '', tier,
      price: e.price ?? null, seats: e.seats ?? null, topSpeedKmh: top ?? null, accel0100: accel, massKg: mass,
      palette: (Array.isArray(e.palette) && e.palette.length ? e.palette : p?.color !== undefined ? [p.color, ...DEFAULT_PALETTE] : DEFAULT_PALETTE).slice(0, 10).map(colorNum),
      stats: {
        speed: top ? clamp01(top / sMax) : null,
        accel: accel ? clamp01((18 - accel) / 15.5) : !ground && top ? clamp01((top / sMax) * 0.9) : null,
        handling,
        weight: clamp01((Math.log(Math.max(10, mass)) - Math.log(10)) / (Math.log(60000) - Math.log(10))),
      },
      search: fold(`${name} ${e.brand || ''} ${e.id}`),
      raw: e,
    };
  });
}

function estimateAccel(p, fallback) {
  if (!p) return fallback;
  const peak = Math.max(...(p.engine?.curve || [[0, 300]]).map((c) => c[1]));
  const ratio = p.mass / Math.max(80, peak); // kg per Nm
  return Math.round(Math.max(2.6, Math.min(16, ratio * 1.25 + (p.drive === 'AWD' ? -0.5 : 0))) * 10) / 10;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
function stripEmpty(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== '' && v !== undefined && v !== null) r[k] = v; return r; }

// case/diacritics-insensitive search key
export function fold(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
