#!/usr/bin/env node
// Economy balance simulation (docs/ECONOMY.md → Balance). Models a casual and a skilled player over 10 hours of play
// with the real formulas and caps of src/economy/rules.js and the real price table, and prints the progression:
// time to the first sports car (~$80k), first supercar (~$500k), first helicopter and the business jet.
//
// Event frequencies are ASSUMPTIONS (listed in PROFILES); payouts are not — they come from rules.js. Monte Carlo over
// many seeded runs; the table shows the median and the 10th–90th percentile.
//
// Usage: node tools/economy/simulate.mjs [--runs 300] [--hours 10] [--profile skilled] [--no-activities] [--md]
//                    [--no-spend] [--ladder sports,tank] [--price-<id> N] [--online] [--mult N] [--bucket perS,burst] [--save]
//   --online         multiplayer: the online income multiplier (rules.ONLINE) and the server's income bucket (rules.BUCKET)
//   --mult N         override the online multiplier (with --online); --bucket 100,20000 overrides the bucket
//   --save           never buy: report when cash first reaches each goal's price (saving from scratch)
//   --no-activities  drop workstream I content (time trials, collectibles, speed traps, stunt spots)
//   --no-spend       no cosmetics / services (wardrobe wishlist, car looks, nickname, nitro, extinguishers, …)
//   --ladder         custom purchase order (goal keys or catalog ids), --price-<id> overrides a price
//   --md             print the markdown tables for docs/ECONOMY.md (with spending: where the money goes + delays)
import * as R from '../../src/economy/rules.js';
import { PRICES, EXPORT_POOL } from '../../src/economy/prices.js';
import { WARDROBE_SAMPLE } from './wardrobe-sample.mjs';
// the wishlist is priced from the reference catalogue with the real rules (independent of D's final item ids)
const WARDROBE_PRICES = Object.fromEntries(WARDROBE_SAMPLE.map((it) => [it.id, { price: R.wardrobePrice(it) }]));

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = +arg('runs', 300);
const HOURS = +arg('hours', 10);
const ONLY = arg('profile', null);
const NO_I = process.argv.includes('--no-activities');
const SPEND = !process.argv.includes('--no-spend'); // cosmetic / service spending (wishlist + consumables)
const MD = process.argv.includes('--md');
const ONLINE = process.argv.includes('--online');
const MULT = ONLINE ? +arg('mult', R.ONLINE.mult) : 1;
const [BUCKET_PS, BUCKET_BURST] = (arg('bucket', null)?.split(',').map(Number)) ?? [R.BUCKET.perSecond, R.BUCKET.burst];
const SAVE = process.argv.includes('--save');

// ---------------------------------------------------------------- goals (real catalog prices)
const cheapest = (cls, min = 0) => Object.entries(PRICES).filter(([, p]) => p.cls === cls && p.price >= min).sort((a, b) => a[1].price - b[1].price)[0];
const DEFAULT_GOALS = [
  { key: 'upgrade', label: 'First upgrade', id: 'hachi', noBuy: true }, // Hachi $30,000 — affordable, not bought here
  { key: 'sports', label: 'First sports car', id: 'kurve_r', speed: 1.0 }, // Kurve R $89,000 (the "~$80k" sports tier)
  { key: 'super', label: 'First supercar', id: 'tempesta', speed: 1.12 }, // Tempesta $498,000
  { key: 'heli', label: 'First helicopter', id: cheapest('heli')[0] }, // Vella N2 $650,000
  { key: 'jet', label: 'Business jet', id: 'plane_jet' }, // Solstice 7 $8,500,000
];
// --ladder sports,tank  → a custom purchase order (ids or the keys above); --price-<id> N overrides a price
const LADDER = arg('ladder', null);
const GOALS = LADDER
  ? LADDER.split(',').map((k) => DEFAULT_GOALS.find((g) => g.key === k) || { key: k, label: PRICES[k] ? `${k}` : k, id: k })
  : DEFAULT_GOALS;
for (const g of GOALS) g.price = +arg(`price-${g.id}`, PRICES[g.id]?.price ?? NaN);
if (SAVE) for (const g of GOALS) g.noBuy = true;
for (const g of GOALS) if (!Number.isFinite(g.price)) { console.error(`no price for ${g.id}: pass --price-${g.id} N`); process.exit(1); }
const STARTER_SPEED = 0.8; // Pip: top 158 km/h vs ~250 for a sports car

// ---------------------------------------------------------------- world content (assumptions for workstream I)
const TRIALS = Array.from({ length: 8 }, (_, i) => ({ id: i, purse: R.racePurse(2000 + i * 1400) })); // 2–11.8 km
const POSTCARDS = R.COLLECTIBLES.total;
const STUNT_SPOTS = 12;
const DISTRICTS = 52; // unique district names in public/data/world.json

// traffic cars the export yards take (trafficWeight-weighted)
const TRAFFIC = EXPORT_POOL.map((id) => [id, PRICES[id].traffic, PRICES[id].price]);
const TRAFFIC_W = TRAFFIC.reduce((s, t) => s + t[1], 0);

// ---------------------------------------------------------------- spending (rules.wardrobePrice + rules.SERVICES)
// The wishlist, in the order players typically want things (reference catalogue tools/economy/wardrobe-sample.mjs).
// `mark` records a milestone.
const NICE_OUTFIT = ['hair_sidepart', 'top_hawaii', 'legs_chinos', 'shoes_hightops', 'glasses_aviators'];
const WISH_IDS = [
  ...NICE_OUTFIT,
  'acc_chain_silver', 'tat_rose', 'facial_beard', 'top_bomber', 'hat_bucket', 'shoes_boots',
  'top_shirt', 'acc_watch_steel', 'shoes_loafers', 'legs_tailored', 'tat_sleeve', 'glasses_designer', 'hat_fedora',
  'acc_watch_gold', 'NICK', 'top_suit', 'acc_chain_gold', 'glasses_gold', 'shoes_designer', 'top_whitesuit', 'acc_watch_diamond',
];
const WISH = WISH_IDS.map((id) => (id === 'NICK'
  ? { id, kind: 'nick', price: R.NICK.custom }
  : { id, kind: 'wardrobe', price: WARDROBE_PRICES[id]?.price ?? 0, mark: id === NICE_OUTFIT.at(-1) ? 'outfit' : id === 'acc_watch_gold' ? 'watch' : null }));
for (const w of WISH) if (w.kind === 'wardrobe' && !w.price) throw new Error(`wishlist item ${w.id} has no price`);
const NICE_OUTFIT_PRICE = NICE_OUTFIT.reduce((s, id) => s + WARDROBE_PRICES[id].price, 0);
const WATCH_PRICE = WARDROBE_PRICES.acc_watch_gold.price;

// ---------------------------------------------------------------- player profiles (assumed behaviour)
const PROFILES = {
  casual: {
    label: 'Casual',
    sessionMin: 45, keepStreak: 0.75, // plays most days for ~45 min
    // share of play time per activity
    mix: { roam: 0.42, delivery: 0.22, export: 0.06, explore: 0.16, race: 0.06, idle: 0.08 },
    skill: { // skill events per minute of free roam, by type; burst = mean events per combo chain; crash = P(a crash ends it)
      perMin: { drift: 0.8, nearmiss: 1.0, stunt: 0.12, speedtrap: 0.05 }, burst: 1.6, crash: 0.16,
      driftS: 2.4, driftKmh: 65, nmKmh: 110, trapKmh: 170, airS: 1.8, heightM: 4,
    },
    deliverySpeed: 12.5, deliveryOverheadS: 140, deliveryFail: 0.12, condition: [0.65, 1],
    exportS: 420, wantedHunt: 0.08,
    exploreDistrictsPerMin: 0.55, postcardsPerHour: 2.2, stuntSpotsPerHour: 0.8, trapPb: 0.5,
    medal: { gold: 0.12, silver: 0.33, bronze: 0.35 }, raceS: 300,
    wastedPerHour: 1.5, repairsPerHour: 0.8, damageAtRepair: 0.35, pickupsPerMin: 0.4,
    // spending: `share` of every dollar earned goes to a "treats" budget for the wishlist (the first nice outfit is
    // bought early, as soon as an item costs ≤ 1/3 of cash); consumables per hour / per session
    shop: { share: 0.1, nitroPerHour: 0.1, extPerHour: 0.05, armorPerHour: 0, insurancePerSession: 0, neon: 0.4, customNick: false },
  },
  regular: { // the "average" player: between casual and skilled, 1.5–2 h a day
    label: 'Regular',
    sessionMin: 105, keepStreak: 0.8,
    mix: { roam: 0.4, delivery: 0.25, export: 0.07, explore: 0.13, race: 0.09, idle: 0.06 },
    skill: {
      perMin: { drift: 1.3, nearmiss: 1.9, stunt: 0.22, speedtrap: 0.1 }, burst: 2.5, crash: 0.11,
      driftS: 3.4, driftKmh: 78, nmKmh: 130, trapKmh: 195, airS: 2.1, heightM: 5,
    },
    deliverySpeed: 16.5, deliveryOverheadS: 100, deliveryFail: 0.08, condition: [0.72, 1],
    exportS: 330, wantedHunt: 0.2,
    exploreDistrictsPerMin: 0.7, postcardsPerHour: 3.2, stuntSpotsPerHour: 1.3, trapPb: 0.55,
    medal: { gold: 0.3, silver: 0.33, bronze: 0.25 }, raceS: 270,
    wastedPerHour: 1.2, repairsPerHour: 1, damageAtRepair: 0.32, pickupsPerMin: 0.25,
    shop: { share: 0.08, nitroPerHour: 0.4, extPerHour: 0.15, armorPerHour: 0.05, insurancePerSession: 0.05, neon: 0.7, customNick: false },
  },
  skilled: {
    label: 'Skilled',
    sessionMin: 120, keepStreak: 0.85,
    mix: { roam: 0.38, delivery: 0.27, export: 0.08, explore: 0.1, race: 0.12, idle: 0.05 },
    skill: {
      perMin: { drift: 2.0, nearmiss: 3.0, stunt: 0.35, speedtrap: 0.15 }, burst: 3.5, crash: 0.07,
      driftS: 4.5, driftKmh: 90, nmKmh: 150, trapKmh: 215, airS: 2.4, heightM: 6,
    },
    deliverySpeed: 21, deliveryOverheadS: 70, deliveryFail: 0.04, condition: [0.82, 1],
    exportS: 260, wantedHunt: 0.35,
    exploreDistrictsPerMin: 0.9, postcardsPerHour: 4.5, stuntSpotsPerHour: 2, trapPb: 0.6,
    medal: { gold: 0.55, silver: 0.3, bronze: 0.12 }, raceS: 240,
    wastedPerHour: 0.9, repairsPerHour: 1.2, damageAtRepair: 0.3, pickupsPerMin: 0.15,
    shop: { share: 0.06, nitroPerHour: 1, extPerHour: 0.3, armorPerHour: 0.1, insurancePerSession: 0.15, neon: 0.9, customNick: true },
  },
};

// ---------------------------------------------------------------- rng
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(rng, l) {
  if (l <= 0) return 0;
  if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * gauss(rng)));
  const L = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
function gauss(rng) { return Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()); }
const U = (rng, a, b) => a + (b - a) * rng();
function pick(rng, weights) {
  let s = 0;
  for (const k in weights) s += weights[k];
  let r = rng() * s;
  for (const k in weights) if ((r -= weights[k]) <= 0) return k;
  return Object.keys(weights)[0];
}

// ---------------------------------------------------------------- one run
function run(P, seed, spend = SPEND) {
  const rng = mulberry32(seed);
  const T = HOURS * 3600;
  const st = {
    t: 0, money: R.START_MONEY, speed: STARTER_SPEED, goal: 0, districts: 0, postcards: 0, spots: 0,
    medals: new Map(), traps: 0, streak: 0, sessionLeft: 0, car: 'pip', carPrice: 0, treat: 0, treatTotal: 0, earned: 0,
  };
  const income = {};
  const spent = {};
  const actStat = {};
  const ms = {};
  const hourly = new Array(HOURS).fill(0);
  // online: the server's global income bucket (rules.BUCKET) over bucket reasons; `at` = when the claim lands (s)
  let tok = BUCKET_BURST, tokT = 0, bucketLost = 0;
  const earn = (reason, amount, at = st.t, exempt = false) => {
    let a = Math.max(0, Math.round(amount * (ONLINE ? R.incomeScale(reason, true, MULT) : 1)));
    if (ONLINE && R.REASONS[reason]?.bucket && !exempt && a > 0) {
      tok = Math.min(BUCKET_BURST, tok + Math.max(0, at - tokT) * BUCKET_PS);
      tokT = Math.max(tokT, at);
      const g = Math.min(a, Math.floor(tok));
      bucketLost += a - g;
      tok -= g;
      a = g;
    }
    if (!a) return;
    st.money += a;
    st.earned += a;
    if (spend) {
      st.treat += a * P.shop.share;
      st.treatTotal += a * P.shop.share;
      // a watch as the first treat after the outfit / as a direct savings goal
      if (ms.watchTreat === undefined && st.treatTotal >= NICE_OUTFIT_PRICE + WATCH_PRICE) ms.watchTreat = st.t;
    }
    if (ms.watchDirect === undefined && st.earned + R.START_MONEY >= WATCH_PRICE) ms.watchDirect = st.t;
    income[reason] = (income[reason] || 0) + a;
    const h = Math.min(HOURS - 1, Math.floor(st.t / 3600));
    hourly[h] += a;
  };
  const pay = (reason, amount) => {
    const a = Math.min(st.money, Math.max(0, Math.round(amount)));
    st.money -= a;
    spent[reason] = (spent[reason] || 0) + a;
  };

  // skill events during `dur` seconds at `k` × the profile rate
  const S = P.skill;
  const mix = NO_I ? { ...S.perMin, speedtrap: 0 } : S.perMin;
  const rate = Object.values(mix).reduce((a, b) => a + b, 0);
  const skill = (dur, k) => {
    const chains = poisson(rng, ((rate * k) / S.burst) * (dur / 60));
    for (let c = 0; c < chains; c++) {
      let combo = 1;
      const at0 = st.t + ((c + 0.5) / chains) * dur;
      const len = 1 + poisson(rng, S.burst - 1);
      for (let e = 0; e < len; e++) {
        if (e > 0) combo = R.nextCombo(combo, true);
        const type = pick(rng, mix);
        const at = at0 + e * 4;
        if (type === 'drift') {
          const d = U(rng, R.DRIFT.minChainS, 2 * S.driftS - R.DRIFT.minChainS);
          const kmh = S.driftKmh * (0.75 + 0.25 * st.speed) * U(rng, 0.85, 1.15);
          earn('drift', R.driftPay(d * kmh * (0.6 + U(rng, 0.45, 1.0)), combo), at);
        } else if (type === 'nearmiss') {
          earn('nearmiss', R.nearMissPay(S.nmKmh * st.speed * U(rng, 0.9, 1.12), combo), at);
        } else if (type === 'stunt') {
          let first = false;
          if (!NO_I && st.spots < STUNT_SPOTS && rng() < P.stuntSpotsPerHour / 60 / S.perMin.stunt) { first = true; st.spots++; }
          earn('stunt', R.stuntPay(U(rng, 1.3, 2 * S.airS - 1.3), U(rng, 1, 2 * S.heightM - 1), combo, first), at);
        } else {
          const kmh = S.trapKmh * st.speed * U(rng, 0.9, 1.1);
          const pb = rng() < P.trapPb * Math.exp(-st.traps / 25);
          st.traps++;
          earn('speedtrap', R.speedTrapPay(kmh, pb, combo), at);
        }
        if (rng() < S.crash) break;
      }
    }
  };
  const findStuff = (dur, k) => {
    // collectibles and new districts turn up while driving around
    if (!NO_I && st.postcards < POSTCARDS) {
      const n = Math.min(POSTCARDS - st.postcards, poisson(rng, (P.postcardsPerHour * k * dur) / 3600 * (1 - st.postcards / (POSTCARDS * 1.3))));
      for (let i = 0; i < n; i++) { st.postcards++; earn('collectible', R.collectiblePay(st.postcards)); }
    }
    if (st.districts < DISTRICTS) {
      const n = Math.min(DISTRICTS - st.districts, poisson(rng, (P.exploreDistrictsPerMin * k * dur) / 60 * (1 - st.districts / DISTRICTS)));
      st.districts += n;
      earn('firstvisit', n * R.FIRST_VISIT);
    }
  };

  // cosmetics: car items right after buying a car, then the wardrobe wishlist, paid from the treats budget (a share of
  // income) — players save for the next car first; the first nice outfit is an early exception
  const carWish = [];
  let wish = 0;
  const shop = () => {
    if (!spend) return;
    const S = P.shop;
    for (;;) {
      const item = carWish.length ? carWish[0] : wish < WISH.length ? WISH[wish] : null;
      if (!item) break;
      if (item.kind === 'nick' && !S.customNick) { wish++; continue; }
      const early = !carWish.length && wish < NICE_OUTFIT.length && item.price * 3 <= st.money;
      if (!(early || st.treat >= item.price) || item.price > st.money) break;
      pay(item.kind === 'wardrobe' ? 'wardrobe' : item.kind === 'nick' ? 'nick' : 'carCosmetic', item.price);
      st.treat -= item.price;
      if (item.mark) ms[item.mark] = st.t;
      if (carWish.length) carWish.shift(); else wish++;
    }
  };
  const consumables = (d) => {
    if (!spend) return;
    const S = P.shop, h = d / 3600;
    for (let i = poisson(rng, S.nitroPerHour * h); i > 0; i--) pay('service', R.SERVICES.nitro.price);
    for (let i = poisson(rng, S.extPerHour * h); i > 0; i--) pay('service', R.SERVICES.extinguisher.price);
    for (let i = poisson(rng, S.armorPerHour * h); i > 0; i--) pay('service', R.SERVICES.armor.price);
  };

  const blocks = {
    roam() { const d = U(rng, 120, 360); skill(d, 1); findStuff(d, 0.35); earn('pickup', Math.min(300, poisson(rng, P.pickupsPerMin * d / 60) * 40), st.t + d); return d; },
    explore() { const d = U(rng, 180, 420); skill(d, 0.35); findStuff(d, 1); return d; },
    idle() { return U(rng, 60, 180); },
    delivery() {
      const L = U(rng, R.DELIVERY.minRouteM, R.DELIVERY.maxRouteM);
      const v = P.deliverySpeed * (0.7 + 0.3 * st.speed / STARTER_SPEED) * U(rng, 0.85, 1.15) * (st.speed > 1 ? 1 : 0.95);
      const time = L / v + 15;
      const d = P.deliveryOverheadS + time;
      skill(d, 0.45);
      findStuff(d, 0.15);
      if (rng() < P.deliveryFail || time > R.deliveryTimeLimit(L)) return d;
      earn('delivery', R.deliveryPay(L, 1, R.deliveryTimeBonus(L, time), U(rng, P.condition[0], P.condition[1])), st.t + d);
      return d;
    },
    export() {
      const d = P.exportS * U(rng, 0.7, 1.3);
      skill(d, 0.4);
      let r = rng() * TRAFFIC_W, price = TRAFFIC[0][2];
      for (const t of TRAFFIC) if ((r -= t[1]) <= 0) { price = t[2]; break; }
      const wanted = rng() < P.wantedHunt + 0.09;
      earn('export', R.exportPay(price, U(rng, 0.75, 1), wanted), st.t + d);
      return d;
    },
    race() {
      if (NO_I) return blocks.roam();
      const d = P.raceS * U(rng, 0.8, 1.2);
      skill(d, 0.25);
      // prefer trials without a gold yet
      const open = TRIALS.filter((tr) => !((st.medals.get(tr.id) ?? 0) & 1));
      const tr = open.length ? open[Math.floor(rng() * open.length)] : TRIALS[Math.floor(rng() * TRIALS.length)];
      const tier = pick(rng, { ...P.medal, none: Math.max(0, 1 - P.medal.gold - P.medal.silver - P.medal.bronze) });
      if (tier !== 'none') {
        const bit = 1 << (R.RACE.tierIndex[tier] - 1);
        const m = st.medals.get(tr.id) ?? 0;
        earn('race', R.racePay(tr.purse, tier, !(m & bit)), st.t + d, !(m & bit)); // a first medal is bucket-exempt
        st.medals.set(tr.id, m | bit);
      }
      return d;
    },
  };

  while (st.t < T) {
    if (st.sessionLeft <= 0) {
      st.streak = st.streak && rng() < P.keepStreak ? Math.min(7, st.streak + 1) : 1;
      earn('daily', R.dailyPay(st.streak));
      st.sessionLeft = P.sessionMin * 60;
      if (spend && rng() < P.shop.insurancePerSession && st.money > R.SERVICES.insurance.price * 4) pay('service', R.SERVICES.insurance.price);
    }
    const act = pick(rng, P.mix);
    const m0 = st.money;
    const d = blocks[act]();
    const tier = st.speed > 1.05 ? 'super' : st.speed >= 1 ? 'sports' : 'starter';
    const ak = `${act}@${tier}`;
    actStat[ak] ||= [0, 0];
    actStat[ak][0] += st.money - m0; actStat[ak][1] += d;
    st.t += d;
    st.sessionLeft -= d;
    // wasted / repairs over that block
    for (let i = poisson(rng, (P.wastedPerHour * d) / 3600); i > 0; i--) pay('hospital', R.hospitalFee(st.money));
    for (let i = poisson(rng, (P.repairsPerHour * d) / 3600); i > 0; i--) pay('repair', R.repairCost(st.carPrice, P.damageAtRepair, !st.carPrice));
    consumables(d);
    // buy the next goal as soon as it is affordable
    while (st.goal < GOALS.length && st.money >= GOALS[st.goal].price) {
      const g = GOALS[st.goal];
      if (g.noBuy) { ms[g.key] = st.t; st.goal++; continue; }
      pay('purchase', g.price);
      ms[g.key] = st.t;
      if (g.speed) { st.speed = g.speed; st.car = g.id; st.carPrice = g.price; }
      if (spend && (g.speed || g.key === 'tank')) {
        carWish.push({ kind: 'car', price: g.key === 'super' ? R.SERVICES.respray.premium : R.SERVICES.respray.price }, { kind: 'car', price: R.SERVICES.tint.price });
        if (rng() < P.shop.neon) carWish.push({ kind: 'car', price: R.SERVICES.neon.price });
      }
      st.goal++;
    }
    shop();
  }
  // projection for unreached goals: remaining cost at the last hour's pace
  const pace = hourly[HOURS - 1] / 3600;
  let left = 0;
  for (let i = st.goal; i < GOALS.length; i++) {
    if (GOALS[i].noBuy) { ms[GOALS[i].key] = -(T + Math.max(0, GOALS[i].price - st.money) / Math.max(pace, 1)); continue; }
    left += GOALS[i].price - (i === st.goal ? st.money : 0);
    ms[GOALS[i].key] = -(T + left / Math.max(pace, 1)); // negative = projected
  }
  const total = Object.values(income).reduce((s, v) => s + v, 0);
  return { ms, income, spent, total, hourly, districts: st.districts, postcards: st.postcards, actStat, money: st.money, bucketLost };
}

// ---------------------------------------------------------------- report
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
const fmtT = (s) => {
  const proj = s < 0, v = Math.abs(s);
  const mins = Math.round(v / 60), h = Math.floor(mins / 60), m = mins % 60;
  const txt = h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  return proj ? `> ${HOURS} h (≈ ${(v / 3600).toFixed(0)} h)` : txt;
};
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const results = {};
for (const [key, P] of Object.entries(PROFILES)) {
  if (ONLY && key !== ONLY) continue;
  const runs = [];
  const base = [];
  for (let i = 0; i < RUNS; i++) {
    const seed = 1000 + i * 7919 + (key === 'skilled' ? 17 : 0);
    runs.push(run(P, seed));
    if (SPEND) base.push(run(P, seed, false));
  }
  results[key] = { P, runs, base };
}

// spending report: where the money goes, cosmetic milestones, and how much cosmetics/services delay the car ladder
function spendReport() {
  if (!SPEND) return;
  const keys = Object.keys(results);
  const med = (a) => pct(a, 0.5);
  const timeCell = (runs, key) => {
    const ts = runs.map((r) => r.ms[key] ?? -1e9);
    const reached = ts.filter((t) => t >= 0).length / ts.length;
    return reached >= 0.5 ? fmtT(med(ts.map((t) => (t < 0 ? 1e9 : t)))) : `> ${HOURS} h`;
  };
  console.log(`\n**Where the money goes** (share of everything earned in ${HOURS} h, incl. the $5,000 start; mean of ${RUNS} runs)\n`);
  console.log(`| | ${keys.map((k) => results[k].P.label).join(' | ')} |`);
  console.log(`|---|${keys.map(() => '---:|').join('')}`);
  const rows = [
    ['Vehicles', (r) => r.spent.purchase || 0],
    ['Cosmetics (wardrobe, car looks, nickname)', (r) => (r.spent.wardrobe || 0) + (r.spent.carCosmetic || 0) + (r.spent.nick || 0)],
    ['Services (nitro, extinguishers, armour, insurance)', (r) => r.spent.service || 0],
    ['Upkeep (repairs, hospital)', (r) => (r.spent.repair || 0) + (r.spent.hospital || 0)],
    ['Still in the wallet', (r) => r.money],
  ];
  for (const [label, f] of rows) {
    console.log(`| ${label} | ${keys.map((k) => {
      const runs = results[k].runs;
      const share = runs.reduce((s, r) => s + f(r) / (r.total + R.START_MONEY), 0) / runs.length;
      return `${Math.round(share * 100)}%`;
    }).join(' | ')} |`);
  }
  console.log(`| Cosmetics bought (mean) | ${keys.map((k) => money(results[k].runs.reduce((s, r) => s + (r.spent.wardrobe || 0) + (r.spent.carCosmetic || 0) + (r.spent.nick || 0), 0) / RUNS)).join(' | ')} |`);
  console.log(`| First nice outfit (${money(NICE_OUTFIT_PRICE)}, median) | ${keys.map((k) => timeCell(results[k].runs, 'outfit')).join(' | ')} |`);
  console.log(`| Gold watch (${money(WATCH_PRICE)}) as the next treat after the outfit | ${keys.map((k) => timeCell(results[k].runs, 'watchTreat')).join(' | ')} |`);
  console.log(`| Gold watch saved for directly (all income) | ${keys.map((k) => timeCell(results[k].runs, 'watchDirect')).join(' | ')} |`);
  console.log(`| Gold watch at the end of the default wishlist (after ~$68k of street/premium items) | ${keys.map((k) => timeCell(results[k].runs, 'watch')).join(' | ')} |`);
  for (const g of GOALS) {
    if (g.noBuy) continue;
    const cells = keys.map((k) => {
      const a = med(results[k].runs.map((r) => Math.abs(r.ms[g.key])));
      const b = med(results[k].base.map((r) => Math.abs(r.ms[g.key])));
      const proj = med(results[k].runs.map((r) => r.ms[g.key])) < 0;
      return `${proj ? '≈ ' : ''}${fmtT(b).replace(/^> .*\(≈ /, '').replace(/\)$/, '')} → ${fmtT(a).replace(/^> .*\(≈ /, '').replace(/\)$/, '')} (${(() => { const d = Math.round((a / b - 1) * 100); return d > 0 ? `+${d}%` : d < 0 ? `−${-d}%` : '±0%'; })()})`;
    });
    console.log(`| Delay: ${g.label} | ${cells.join(' | ')} |`);
  }
}

if (!MD) {
  console.log(`Leonida Drive economy simulation — ${RUNS} runs × ${HOURS} h per profile${NO_I ? ' (no workstream-I activities)' : ''}${ONLINE ? ` — online ×${MULT}, bucket $${BUCKET_PS}/s burst $${BUCKET_BURST}` : ''}${SAVE ? ' — saving, no purchases' : ''}\n`);
  for (const [key, { P, runs }] of Object.entries(results)) {
    console.log(`${P.label}`);
    for (const g of GOALS) {
      const ts = runs.map((r) => r.ms[g.key]);
      const med = pct(ts.map(Math.abs), 0.5) * Math.sign(pct(ts, 0.5) || 1);
      console.log(`  ${g.label.padEnd(18)} ${money(g.price).padStart(11)}   median ${fmtT(med).padEnd(20)} p10–p90 ${fmtT(pct(ts.map((t) => (t < 0 ? 1e9 : t)), 0.1) === 1e9 ? -pct(ts.map(Math.abs), 0.1) : pct(ts.map((t) => (t < 0 ? 1e9 : t)), 0.1))} – ${fmtT(pct(ts.map((t) => (t < 0 ? 1e9 : t)), 0.9) === 1e9 ? -pct(ts.map(Math.abs), 0.9) : pct(ts.map((t) => (t < 0 ? 1e9 : t)), 0.9))}`);
    }
    const avg = (f) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
    if (ONLINE) console.log(`  lost to the income bucket: ${money(avg((r) => r.bucketLost))} (${(avg((r) => r.bucketLost / (r.total + r.bucketLost)) * 100).toFixed(1)}%)`);
    console.log(`  income ${money(avg((r) => r.total))} in ${HOURS} h = ${money(avg((r) => r.total) / (HOURS * 60))}/min; hour 1 ${money(avg((r) => r.hourly[0]) / 60)}/min, hour ${HOURS} ${money(avg((r) => r.hourly[HOURS - 1]) / 60)}/min`);
    const reasons = {};
    for (const r of runs) for (const [k, v] of Object.entries(r.income)) reasons[k] = (reasons[k] || 0) + v / runs.length;
    const tot = Object.values(reasons).reduce((s, v) => s + v, 0);
    console.log(`  by source: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((v / tot) * 100)}%`).join(', ')}`);
    const sp = {};
    for (const r of runs) for (const [k, v] of Object.entries(r.spent)) if (k !== 'purchase') sp[k] = (sp[k] || 0) + v / runs.length;
    const acts = {};
    for (const r of runs) for (const [k, [m, d]] of Object.entries(r.actStat)) { acts[k] ||= [0, 0]; acts[k][0] += m; acts[k][1] += d; }
    console.log(`  $/min by activity: ${Object.entries(acts).sort().map(([k, [m, d]]) => `${k} ${money(m / (d / 60))}`).join(', ')}`);
    console.log(`  sinks: ${Object.entries(sp).map(([k, v]) => `${k} ${money(v)}`).join(', ')}; districts ${avg((r) => r.districts).toFixed(0)}/${DISTRICTS}, postcards ${avg((r) => r.postcards).toFixed(0)}/${POSTCARDS}\n`);
  }
} else {
  const keys = Object.keys(results);
  console.log(`| Milestone | Price | ${keys.map((k) => results[k].P.label).join(' | ')} |`);
  console.log(`|---|---:|${keys.map(() => '---|').join('')}`);
  for (const g of GOALS) {
    const cells = keys.map((k) => {
      const ts = results[k].runs.map((r) => r.ms[g.key]);
      const reached = ts.filter((t) => t >= 0).length / ts.length;
      if (reached < 0.5) return `> ${HOURS} h (≈ ${(pct(ts.map(Math.abs), 0.5) / 3600).toFixed(0)} h)`;
      return `${fmtT(pct(ts.map((t) => (t < 0 ? 1e9 : t)), 0.5))} (${fmtT(pct(ts.map((t) => (t < 0 ? 1e9 : t)), 0.1))}–${reached >= 0.9 ? fmtT(pct(ts.map((t) => (t < 0 ? 1e9 : t)), 0.9)) : `>${HOURS} h`})`;
    });
    console.log(`| ${g.label} (${PRICES[g.id] ? g.id : ''}) | ${money(g.price)} | ${cells.join(' | ')} |`);
  }
  for (const k of keys) {
    const runs = results[k].runs;
    const avg = (f) => runs.reduce((s, r) => s + f(r), 0) / runs.length;
    console.log(`\n${results[k].P.label}: ${money(avg((r) => r.total) / (HOURS * 60))}/min average (hour 1: ${money(avg((r) => r.hourly[0]) / 60)}/min, hour ${HOURS}: ${money(avg((r) => r.hourly[HOURS - 1]) / 60)}/min).`);
  }
}
spendReport();
