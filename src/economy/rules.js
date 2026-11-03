// Leonida Drive economy rules (docs/ECONOMY.md): one source of truth for the browser client (singleplayer authority and
// online prediction) and the multiplayer server (workstream J imports this file). Pure data and pure functions:
// no DOM, no three.js, no Node APIs, no allocations in the per-event helpers beyond their return values.

export const ECONOMY_VERSION = 1;
export const START_MONEY = 5000;
export const SELL_FRACTION = 0.55; // selling returns 55% of the price (times condition)
export const WORTH_FRACTION = 0.55; // cash + the standard garage sale value of sellable vehicles

// ---------------- combo (GTA-style skill chains) ----------------
// Every skill event within `window` s of the previous one raises the multiplier by `step` (max `max`).
// A crash with an impact above `crashKmh` or `window` s without a skill event resets it to ×1.
export const COMBO = Object.freeze({
  step: 0.5,
  max: 5,
  window: 6,
  crashKmh: 25,
  // impact strength reported by the damage system (E): e = (Δv − 2.5 m/s) / 19 → 25 km/h ≈ 0.234
  crashStrength: (25 / 3.6 - 2.5) / 19,
});

/** Next combo value for a skill event: chained (inside the window) → +0.5 up to ×5, otherwise back to ×1. */
export function nextCombo(combo, chained) {
  return chained ? Math.min(COMBO.max, (combo || 1) + COMBO.step) : 1;
}

// ---------------- income reasons ----------------
// max: ceiling of one claim ($); cooldown: s between two paid claims of that reason (keyed per trial/trap/model where
// noted); perMinute: $ ceiling over a rolling minute; skill: takes part in the combo; bucket: counts against the
// server's global income token bucket. Online the server recomputes the amount from what it observed; these are the
// ceilings both sides agree on.
export const REASONS = Object.freeze({
  drift: { max: 1500, cooldown: 2, skill: true, bucket: true },
  nearmiss: { max: 1200, cooldown: 1.5, skill: true, bucket: true },
  stunt: { max: 3000, cooldown: 1, skill: true, bucket: true },
  speedtrap: { max: 2500, cooldown: 3, skill: true, bucket: true }, // + 10 s per trap
  race: { max: 15000, cooldown: 0, bucket: true }, // 60 s per trial; a first medal of a tier is bucket-exempt
  collectible: { max: 111000, cooldown: 0.5, bucket: false },
  delivery: { max: 15000, cooldown: 45, bucket: true },
  export: { max: 25000, cooldown: 60, bucket: true }, // + 10 min per model
  pickup: { max: 80, cooldown: 0.1, perMinute: 300, bucket: true },
  daily: { max: 10000, cooldown: 0, bucket: false },
  firstvisit: { max: 500, cooldown: 0, bucket: false },
  other: { max: 100, cooldown: 10, bucket: true },
});
export const SKILL_REASONS = Object.freeze(Object.keys(REASONS).filter((r) => REASONS[r].skill));

// ---------------- online income (multiplayer only) ----------------
// Online every gameplay payout is the base formula × `mult` (singleplayer pays the base formulas). Both sides scale:
// the client predicts and claims base × mult, the server recomputes base × mult from what it observed and caps the
// claim at REASONS[reason].max × mult. Street cash pickups and `other` are not scaled.
export const ONLINE = Object.freeze({ mult: 2, unscaled: Object.freeze(['pickup', 'other']) });
/** Income multiplier for `reason`: ONLINE.mult online (1 for unscaled reasons), 1 in singleplayer. */
export function incomeScale(reason, online = true, mult = ONLINE.mult) {
  return online && REASONS[reason] && !ONLINE.unscaled.includes(reason) ? mult : 1;
}
/** Ceiling of one claim of `reason` (REASONS.max × the online multiplier). */
export function reasonMax(reason, online = false) {
  const r = REASONS[reason];
  return r ? r.max * incomeScale(reason, online) : 0;
}

/** Server-side global income limiter over the online (scaled) payouts: ≤ $12,000/min sustained, burst $50,000 (the
 * largest single bucket claim, an export at the ×2 cap). Singleplayer does not use it. */
export const BUCKET = Object.freeze({ perSecond: 200, burst: 50000 });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r$ = (v) => Math.max(0, Math.round(v));

// ---------------- skill payouts ----------------
/** Drift points for one step: ∫ speed_kmh × (0.6 + slip) dt (slip in rad, capped at 1.2). */
export function driftPoints(speedKmh, slip, dt) {
  return speedKmh * (0.6 + Math.min(Math.abs(slip), 1.2)) * dt;
}
export const DRIFT = Object.freeze({ minChainS: 1.2, divisor: 3.6, minKmh: 35, slip: 0.35, graceS: 0.9 });
/** Drift chain payout (paid when the chain ends, > 1.2 s). */
export function driftPay(points, combo = 1) {
  return Math.min(REASONS.drift.max, r$((points / DRIFT.divisor) * combo));
}

export const NEARMISS = Object.freeze({ minKmh: 90, dMin: 1.6, dMax: 3.2, perCarCooldownS: 6, maxBundle: 3, base: 60, perKmh: 0.6 });
/** Near miss with a traffic car at > 90 km/h, 1.6–3.2 m: ($60 + $0.60 per km/h) × combo. `count` bundles misses that
 * fell inside the 1.5 s claim cooldown (max 3). */
export function nearMissPay(kmh, combo = 1, count = 1) {
  if (!(kmh > NEARMISS.minKmh)) return 0;
  return Math.min(REASONS.nearmiss.max, r$((NEARMISS.base + NEARMISS.perKmh * kmh) * combo * clamp(count, 1, NEARMISS.maxBundle)));
}

export const STUNT = Object.freeze({ minAirS: 1.3, firstSpotMult: 5, perAirS: 160, perHeightM: 40 });
/** Jump payout ($160 per s of air + $40 per m of height) × combo; the first landing at a named stunt spot pays ×5
 * (still capped at $3,000). */
export function stuntPay(airS, heightM, combo = 1, firstAtSpot = false) {
  const base = (airS * STUNT.perAirS + Math.max(0, heightM) * STUNT.perHeightM) * combo * (firstAtSpot ? STUNT.firstSpotMult : 1);
  return Math.min(REASONS.stunt.max, r$(base));
}

/** Speed trap: $100 + $6 per km/h above 150; a new personal best at that trap pays ×2. */
export function speedTrapPay(kmh, personalBest = false, combo = 1) {
  const base = (100 + 6 * Math.max(0, kmh - 150)) * combo * (personalBest ? 2 : 1);
  return Math.min(REASONS.speedtrap.max, r$(base));
}

// ---------------- races & collectibles ----------------
export const RACE = Object.freeze({ tiers: { gold: 1, silver: 0.6, bronze: 0.35 }, tierIndex: { gold: 1, silver: 2, bronze: 3 }, repeat: 0.2, purseMin: 4000, purseMax: 15000, perTrialCooldownS: 60 });
/** Time-trial payout: share of the purse for the tier; the first medal of each tier pays in full, repeats pay 20%. */
export function racePay(purse, tier, firstOfTier) {
  const k = RACE.tiers[tier] ?? 0;
  return Math.min(REASONS.race.max, r$(clamp(purse, 0, RACE.purseMax) * k * (firstOfTier ? 1 : RACE.repeat)));
}
/** Purse for a trial of `lengthM` metres: $4k for short sprints up to $15k for ~12 km. */
export function racePurse(lengthM) {
  return Math.round(clamp(RACE.purseMin + (lengthM - 1500) * 1.05, RACE.purseMin, RACE.purseMax) / 500) * 500;
}

export const COLLECTIBLES = Object.freeze({ total: 60, each: 1000, every: 10, everyBonus: 10000, allBonus: 100000 });
/** Payout for finding a collectible when `foundAfter` postcards are now found in total. */
export function collectiblePay(foundAfter, total = COLLECTIBLES.total) {
  return COLLECTIBLES.each
    + (foundAfter > 0 && foundAfter % COLLECTIBLES.every === 0 ? COLLECTIBLES.everyBonus : 0)
    + (foundAfter === total ? COLLECTIBLES.allBonus : 0);
}

// ---------------- jobs ----------------
export const DELIVERY = Object.freeze({
  base: 500, perM: 0.9, minRouteM: 1500, maxRouteM: 6000, searchMinM: 1100, searchMaxM: 4600,
  maxTimeBonus: 1.5, bonusSpeed: 18, // average m/s that earns the full ×1.5 (≈ 65 km/h door to door)
  limitSlackS: 30, limitSpeed: 11, // time limit = 30 s + route / 11 m/s (≈ 40 km/h average)
  minCondition: 0.4, conditionLoss: 1.5, // condition = 1 − 1.5 × body damage taken during the job (≥ 40%)
  abandonS: 30, // on foot (or in another vehicle) for longer than this fails the job
});
/** Delivery class factor by vehicle kind (catalog `kind`): truck/bus ×1.6, van ×1.3, everything else ×1. */
export function deliveryFactor(kind) {
  return kind === 'truck' || kind === 'bus' ? 1.6 : kind === 'van' ? 1.3 : 1;
}
export function deliveryTimeLimit(routeM) {
  return Math.round(DELIVERY.limitSlackS + routeM / DELIVERY.limitSpeed);
}
/** ×1..×1.5: ×1.5 at an average of 18 m/s or better, ×1 at 12 m/s or slower (same formula as the server). */
export function deliveryTimeBonus(routeM, timeS) {
  return clamp(((routeM / DELIVERY.bonusSpeed) * DELIVERY.maxTimeBonus) / Math.max(timeS, 1), 1, DELIVERY.maxTimeBonus);
}
/** Delivery condition 0.4..1 from the body integrity lost during the job (damage system `body`, 0..1). */
export function deliveryCondition(bodyLost) {
  return clamp(1 - DELIVERY.conditionLoss * Math.max(0, bodyLost), DELIVERY.minCondition, 1);
}
/** Delivery payout: ($500 + $0.90/m × route × class factor) × time bonus × condition. */
export function deliveryPay(routeM, factor = 1, timeBonus = 1, condition = 1) {
  const pay = (DELIVERY.base + DELIVERY.perM * routeM * factor) * clamp(timeBonus, 1, DELIVERY.maxTimeBonus) * clamp(condition, DELIVERY.minCondition, 1);
  return Math.min(REASONS.delivery.max, r$(pay));
}

export const EXPORT = Object.freeze({ fraction: 0.04, min: 600, modelCooldownS: 600, wantedMult: 2, wantedRotateS: 1200, wantedCount: 3, minTraffic: 0.2 });
/** Export payout for a car taken from traffic: 4% × model price × condition, min $600 (×2 if on the yard's wanted list). */
export function exportPay(price, condition = 1, wanted = false) {
  const v = Math.max(EXPORT.min, EXPORT.fraction * price * clamp(condition, 0, 1) * (wanted ? EXPORT.wantedMult : 1));
  return Math.min(REASONS.export.max, r$(v));
}
/** Models the export yards may ask for: common traffic cars (no bikes, aircraft, boats, supercars or starters). */
export function exportPool(prices) {
  const out = [];
  for (const id of Object.keys(prices)) {
    const p = prices[id];
    if (p.starter || (p.traffic ?? 0) < EXPORT.minTraffic) continue;
    if (p.cls === 'compact' || p.cls === 'standard' || p.cls === 'sports') out.push(id);
  }
  return out.sort();
}
/**
 * The yard's wanted list: `EXPORT.wantedCount` models from `pool`, rotating every 20 minutes (UTC wall clock), different
 * per yard. Deterministic, so the server computes the same list.
 */
export function exportWanted(epochMs, yard, pool) {
  if (!pool.length) return [];
  const slot = Math.floor(epochMs / 1000 / EXPORT.wantedRotateS);
  const out = [];
  let h = hash32(slot * 7919 + yard * 104729 + 17);
  for (let i = 0; out.length < Math.min(EXPORT.wantedCount, pool.length) && i < 64; i++) {
    h = hash32(h + i);
    const id = pool[h % pool.length];
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
/** Seconds until the wanted lists rotate. */
export function exportWantedRefreshS(epochMs) {
  const s = epochMs / 1000;
  return Math.ceil(EXPORT.wantedRotateS - (s % EXPORT.wantedRotateS));
}

// ---------------- one-off bonuses ----------------
export const FIRST_VISIT = 500;
export const DAILY = Object.freeze({ base: 3000, perDay: 1000, maxStreak: 7 });
/** Daily bonus: $3,000 + $1,000 × streak day (1..7) → $4,000 on day 1, $10,000 from day 7. */
export function dailyPay(streak) { return DAILY.base + DAILY.perDay * clamp(streak | 0, 1, DAILY.maxStreak); }
/** Streak after claiming on `today` (YYYY-MM-DD) when the last claim was on `lastDay`. */
export function nextStreak(lastDay, today, streak) {
  if (lastDay === today) return clamp(streak | 0, 1, DAILY.maxStreak);
  return lastDay && lastDay === dayBefore(today) ? Math.min(DAILY.maxStreak, (streak | 0) + 1) : 1;
}
/** Local calendar day (singleplayer) as YYYY-MM-DD. The server uses the UTC day. */
export function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
export function dayBefore(day) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d - 1, 12));
}

// ---------------- sinks ----------------
export const HOSPITAL = Object.freeze({ fraction: 0.03, min: 50, max: 2500 });
/** Hospital bill when wasted: 3% of cash, at least $50 (if you have it), at most $2,500. */
export function hospitalFee(money) {
  if (!(money > 0)) return 0;
  return Math.min(Math.floor(money), clamp(Math.round(money * HOSPITAL.fraction), HOSPITAL.min, HOSPITAL.max));
}
/** Instant repair: ceil(damage × price × 1.2%), min $100, free for starters. damage 0..1. */
export function repairCost(price, damage, starter = false) {
  if (starter || !(damage > 0.005)) return 0;
  return Math.max(100, Math.ceil(clamp(damage, 0, 1) * price * 0.012));
}
export const PAINT = Object.freeze({ color: 500, pearl: 2500, metallic: 2500 });
/** Sale price: 55% of the price times the condition (garage cars are in condition 1). */
export function sellPrice(price, condition = 1) {
  return r$(price * SELL_FRACTION * clamp(condition, 0, 1));
}
/** Net worth: cash + sellable garage vehicles. Free starters and clothing are not cash-equivalent assets. */
export function netWorth(money, owned, prices) {
  let w = Number.isFinite(money) ? Math.max(0, money) : 0;
  for (const id of owned instanceof Set ? owned : new Set(owned)) {
    const p = typeof prices === 'function' ? prices(id) : prices instanceof Map ? prices.get(id) : prices[id];
    if (p && !p.starter) w += (p.price || 0) * WORTH_FRACTION;
  }
  return Math.round(w);
}

// ---------------- services (shop "Service" tab): convenience, consumables, cosmetics — never stats ----------------
// kind: 'repair' (priced by damage) | 'item' (carried, max N) | 'vehicle' (per owned vehicle, until the next repair) |
//       'pass' (time-limited) | 'consumable' (applied now) | 'cosmetic' (persisted per owned vehicle)
export const SERVICES = Object.freeze({
  repair: { kind: 'repair', price: null, min: 100 }, // ceil(damage × price × 1.2%), min $100, free for starters
  extinguisher: { kind: 'item', price: 1500, max: 2 }, // auto-used when your car catches fire (or a key)
  armor: { kind: 'vehicle', price: 6000 }, // −30% vehicle damage until the next repair; not for tanks
  insurance: { kind: 'pass', price: 9000, durationS: 86400 }, // 24 real hours; replacement free while insured
  claim: { kind: 'consumable', price: 1000 }, // replacing a destroyed owned vehicle without insurance
  nitro: { kind: 'consumable', price: 400 }, // instant full nitro (it also recharges by itself)
  neon: { kind: 'cosmetic', price: 5000 }, // underglow kit, 8 colours, recolour free
  tint: { kind: 'cosmetic', price: 1200 }, // dark window tint
  horn: { kind: 'cosmetic', price: 2500 }, // one of C's horn variants
  respray: { kind: 'cosmetic', price: 500, premium: 2500 }, // colour $500, metallic / pearl $2,500
});
export const SERVICE_IDS = Object.freeze(Object.keys(SERVICES));
export const ARMOR = Object.freeze({ damageScale: 0.7 });
export const NEON_COLORS = Object.freeze([0xff2a9a, 0x29f0e0, 0x3fa6ff, 0x7cff4f, 0xa24dff, 0xff5a1f, 0xffe14d, 0xf4f4f2]);
export const NEON_NAMES = Object.freeze(['pink', 'cyan', 'blue', 'green', 'purple', 'orange', 'yellow', 'white']);
// horn sound variants of the audio module (src/audio/sfx/Synths.js HORNS keys)
export const HORN_VARIANTS = Object.freeze(['car', 'sport', 'luxury', 'truck', 'bus', 'moped', 'motorcycle', 'boat', 'police']);
export const PAINT_FINISHES = Object.freeze(['color', 'metallic', 'pearl']);

/** Vehicles that can't take armour plating (already armoured). */
export function isArmoured(cls, kind) { return cls === 'military' || kind === 'tank'; }

/**
 * Price of a service for a vehicle — pure, shared with the server.
 * ctx: { price (vehicle price), starter, damage (0..1), cls, kind, owned, insured, extinguishers, custom (record of
 *        that vehicle: { neonKit, tint, horn, armor }), opts: { color, variant, finish } }
 * → { ok, price, reason? } — reasons: unknown, notOwned, undamaged, max, excluded, installed, variant, finish, color
 */
export function servicePrice(id, ctx = {}) {
  const s = SERVICES[id];
  if (!s) return { ok: false, price: 0, reason: 'unknown' };
  const c = ctx.custom || {};
  const o = ctx.opts || {};
  const needOwned = s.kind === 'repair' || s.kind === 'vehicle' || s.kind === 'cosmetic' || id === 'claim';
  if (needOwned && !ctx.owned) return { ok: false, price: 0, reason: 'notOwned' };
  switch (id) {
    case 'repair': {
      if (!(ctx.damage > 0.005)) return { ok: false, price: 0, reason: 'undamaged' };
      return { ok: true, price: repairCost(ctx.price ?? 0, ctx.damage, !!ctx.starter) };
    }
    case 'extinguisher':
      return (ctx.extinguishers ?? 0) >= s.max ? { ok: false, price: s.price, reason: 'max' } : { ok: true, price: s.price };
    case 'armor':
      if (isArmoured(ctx.cls, ctx.kind)) return { ok: false, price: s.price, reason: 'excluded' };
      return c.armor ? { ok: false, price: s.price, reason: 'installed' } : { ok: true, price: s.price };
    case 'claim':
      return { ok: true, price: ctx.starter || ctx.insured ? 0 : s.price };
    case 'neon':
      if (o.color != null && !(o.color >= 0 && o.color < NEON_COLORS.length)) return { ok: false, price: s.price, reason: 'color' };
      return c.neonKit ? { ok: false, price: s.price, reason: 'installed' } : { ok: true, price: s.price };
    case 'tint':
      return c.tint ? { ok: false, price: s.price, reason: 'installed' } : { ok: true, price: s.price };
    case 'horn':
      if (!HORN_VARIANTS.includes(o.variant)) return { ok: false, price: s.price, reason: 'variant' };
      return c.horn === o.variant ? { ok: false, price: s.price, reason: 'installed' } : { ok: true, price: s.price };
    case 'respray': {
      const finish = o.finish || 'color';
      if (!PAINT_FINISHES.includes(finish)) return { ok: false, price: s.price, reason: 'finish' };
      if (!(Number.isInteger(o.color) && o.color >= 0 && o.color <= 0xffffff)) return { ok: false, price: s.price, reason: 'color' };
      return { ok: true, price: finish === 'color' ? s.price : s.premium };
    }
    default:
      return { ok: true, price: s.price }; // insurance, nitro
  }
}

// ---------------- wardrobe (D's catalogue src/characters/wardrobe.js) and nicknames: long-term cosmetic sinks ---------
// Items: { id, slot, tier, value? (0..1 inside the tier, default 0.5), size? (tattoos 0..1), starter? (free, owned from
// the start), price? (explicit override) }. tools/economy/build-wardrobe-prices.mjs writes wardrobe-prices.json.
export const WARDROBE = Object.freeze({
  tiers: { basic: [80, 600], street: [600, 4000], premium: [4000, 25000], luxury: [25000, 250000] },
  tierOrder: ['basic', 'street', 'premium', 'luxury'],
  // where a slot sits inside its tier range: base + span × value (0..1), geometric between min and max
  slots: { top: [0.3, 0.5], legs: [0.2, 0.45], shoes: [0.15, 0.55], hat: [0.05, 0.4], glasses: [0.1, 0.5], accessory: [0.15, 0.85] },
  barber: { hair: [150, 1200], facial: [150, 700] }, // haircuts and beards by tier (+ value)
  tattoo: [500, 9000], // by size: small 0 … full back 1
  surgeon: 15000, // slot 'body': face / body type ("plastic surgeon")
  dye: 0.15, // re-dyeing an owned item
  dyeMin: 50,
  worth: 0.25, // net worth counts 25% of the price of owned wardrobe items
});
export const WARDROBE_SLOTS = Object.freeze(['hair', 'facial', 'top', 'jacket', 'legs', 'shoes', 'hat', 'glasses', 'accessory', 'tattoo', 'body']);

// small prices end in …9 ($119, $449), the rest like vehicle prices
function niceSmall(p) { return p < 1000 ? Math.max(9, Math.round(p / 10) * 10 - 1) : nicePrice(p); }
const geo = (a, b, t) => a * Math.pow(b / a, clamp(t, 0, 1));

/** Price of a wardrobe item (0 for starter items). */
export function wardrobePrice(item) {
  if (!item || item.starter || item.free) return 0;
  if (item.price > 0) return Math.round(item.price);
  const W = WARDROBE;
  const v = clamp(item.value ?? 0.5, 0, 1);
  const ti = Math.max(0, W.tierOrder.indexOf(item.tier));
  if (item.slot === 'body') return W.surgeon;
  if (item.slot === 'tattoo') return niceSmall(geo(W.tattoo[0], W.tattoo[1], item.size ?? v));
  if (item.slot === 'hair' || item.slot === 'facial') {
    const [a, b] = W.barber[item.slot];
    return niceSmall(geo(a, b, (ti + v) / 4));
  }
  const [a, b] = W.tiers[item.tier] || W.tiers.basic;
  const [base, span] = W.slots[item.slot] || [0.3, 0.5];
  return niceSmall(geo(a, b, base + span * v));
}
/** Re-dyeing an owned item: 15% of its price, min $50 (starter items too). */
export function dyePrice(price) {
  return Math.max(WARDROBE.dyeMin, Math.round((Math.max(0, price) * WARDROBE.dye) / 10) * 10);
}

// Nicknames (J's generator src/net/shared/nicknames.js; custom names are validated and made unique by the server)
export const NICK = Object.freeze({ reroll: 2500, custom: 50000, firstRerollFree: true });
/** Price of a nickname change. rerolls = paid or free rerolls done so far by this profile. */
export function nickPrice(mode, rerolls = 0) {
  if (mode === 'custom') return NICK.custom;
  return NICK.firstRerollFree && !(rerolls > 0) ? 0 : NICK.reroll;
}

// ---------------- price classes ----------------
// Fallback when a catalog entry has no `price`: classMin + (classMax − classMin) × tier^1.6, rounded "nicely".
export const CLASS_RANGES = Object.freeze({
  bicycle: [150, 1200],
  bike: [800, 4000], // scooters / small bikes (big motorcycles carry catalog prices)
  compact: [9000, 18000],
  standard: [18000, 45000], // sedan / SUV / pickup / van / coupe / classic / service
  sports: [45000, 150000], // sports / muscle
  super: [150000, 1500000], // super / hyper / luxury
  truck: [40000, 160000], // trucks / buses / utility
  boat: [25000, 650000],
  heli: [450000, 2800000],
  plane: [280000, 6500000],
  military: [1000000, 3000000], // tank
});
/** Catalog category/kind → price class. */
export function priceClass(category, kind) {
  if (kind === 'tank' || category === 'military' || category === 'tank') return 'military';
  if (kind === 'heli' || category === 'heli') return 'heli';
  if (kind === 'plane' || category === 'plane') return 'plane';
  if (kind === 'boat' || category === 'boat') return 'boat';
  switch (category) {
    case 'bicycle': return 'bicycle';
    case 'motorcycle': return 'bike';
    case 'compact': case 'small': return 'compact';
    case 'sports': case 'muscle': return 'sports';
    case 'super': case 'luxury': return 'super';
    case 'truck': case 'bus': return 'truck';
    default: return 'standard';
  }
}
/** "Nice" price: two significant digits, ending in …900 or …500 (e.g. 13,900 / 17,500 / 649,000). */
export function nicePrice(v) {
  if (!(v > 0)) return 0;
  const unit = 10 ** (Math.floor(Math.log10(v)) - 1); // two significant digits
  const half = Math.round((v / unit) * 2) / 2; // step of half a unit
  if (Number.isInteger(half)) return Math.round(half * unit - Math.max(1, unit / 10)); // …900
  return Math.round(half * unit); // …500
}
export function classPrice(cls, tier = 0.3) {
  const [a, b] = CLASS_RANGES[cls] || CLASS_RANGES.standard;
  return nicePrice(a + (b - a) * Math.pow(clamp(tier, 0, 1), 1.6));
}

// ---------------- misc ----------------
/** 32-bit integer hash (deterministic across JS engines). */
export function hash32(x) {
  let h = (x | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
