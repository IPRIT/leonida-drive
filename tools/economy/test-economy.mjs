#!/usr/bin/env node
// Headless checks for the economy (rules, price table, Economy wallet/combo/save/online flow, spawn slots, places).
// Usage: node tools/economy/test-economy.mjs
import assert from 'node:assert/strict';
import * as R from '../../src/economy/rules.js';
import { PRICES, STARTERS, EXPORT_POOL } from '../../src/economy/prices.js';
import { Economy } from '../../src/economy/Economy.js';
import { edgesFromJSON, buildSpawnSets, START_AREA, HOSPITALS } from '../../src/world/Spawns.js';
import { buildPlaces, buildDropPoints, polylineLength } from '../../src/economy/places.js';
import { loadWorld } from './world-node.mjs';
import { VEHICLE_CATALOG } from '../../src/vehicle/catalog.js';
import { AIR_CATALOG } from '../../src/air/catalog.js';
import { BOAT_CATALOG } from '../../src/boat/catalog.js';

let n = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); n++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

// ---------- stubs ----------
class Bus {
  constructor() { this.h = new Map(); this.log = []; }
  on(n, f) { let l = this.h.get(n); if (!l) this.h.set(n, (l = new Set())); l.add(f); return () => l.delete(f); }
  emit(n, p) { this.log.push([n, p]); for (const f of this.h.get(n) || []) f(p); }
}
class Store { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
function stubGame(mode = 'single') {
  const events = new Bus();
  const game = {
    mode, events, time: 0, paused: false,
    can(cap) { return mode !== 'online' || ['vehicleSpawn', 'freeCam', 'waypoint', 'photo'].includes(cap); },
    player: { money: 0, focus: { x: 1728, y: 2, z: -733 }, mode: 'vehicle', controllable: null, wastedT: 0 },
    worldData: { districts: [{ name: 'Ocean Beach', x: 1728, z: -733, r: 856, type: 'd' }, { name: 'Little Cuba', x: -1194, z: -60, r: 318, type: 'd' }] },
    world3d: { areaAt: (x, z) => (Math.hypot(x - 1728, z + 733) < 856 ? { name: 'Ocean Beach', key: 'Ocean Beach' } : { name: 'Little Cuba', key: 'Little Cuba' }) },
    spawns: { pickSpawn: () => ({ x: 1, y: 2, z: 3, yaw: 0, name: 'Ocean Beach' }), snapToRoad: (x, z) => ({ x, y: 1, z, yaw: 0 }) },
  };
  return game;
}
function clockAt(t0) { const c = { t: t0 }; const f = () => c.t; f.c = c; return f; }

console.log('rules');
await test('nice prices end in 900/500', () => {
  assert.equal(R.nicePrice(23456), 23500);
  assert.equal(R.nicePrice(23100), 22900);
  assert.equal(R.nicePrice(651000), 649000);
  assert.equal(R.classPrice('heli', 0), 449000);
});
await test('combo chain ×1 → ×5', () => {
  let c = 1; const seq = [];
  for (let i = 0; i < 10; i++) { c = R.nextCombo(c, i > 0); seq.push(c); }
  assert.deepEqual(seq, [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5]);
  assert.ok(Math.abs(R.COMBO.crashStrength - 0.2339) < 1e-3);
});
await test('skill payouts and caps', () => {
  assert.equal(R.driftPay(900, 1), 250);
  assert.equal(R.driftPay(1e6, 5), 1500);
  assert.equal(R.nearMissPay(80), 0);
  assert.equal(R.nearMissPay(140, 2), 288);
  assert.equal(R.nearMissPay(140, 2, 3), 864);
  assert.equal(R.nearMissPay(300, 5, 3), 1200);
  assert.equal(R.stuntPay(2, 5, 1), 520);
  assert.equal(R.stuntPay(1.5, 2, 1, true), 1600);
  assert.equal(R.stuntPay(5, 30, 5, true), 3000);
  assert.equal(R.speedTrapPay(200), 400);
  assert.equal(R.speedTrapPay(200, true), 800);
  assert.equal(R.speedTrapPay(500, true, 5), 2500);
});
await test('race / collectibles / daily', () => {
  assert.equal(R.racePay(10000, 'gold', true), 10000);
  assert.equal(R.racePay(10000, 'silver', true), 6000);
  assert.equal(R.racePay(10000, 'bronze', false), 700);
  assert.equal(R.collectiblePay(1), 1000);
  assert.equal(R.collectiblePay(10), 11000);
  assert.equal(R.collectiblePay(60), 111000);
  assert.equal(R.dailyPay(1), 4000);
  assert.equal(R.dailyPay(3), 6000);
  assert.equal(R.dailyPay(12), 10000);
  assert.equal(R.nextStreak('2026-11-02', '2026-11-03', 3), 4);
  assert.equal(R.nextStreak('2026-10-30', '2026-11-03', 3), 1);
  assert.equal(R.nextStreak('2026-02-28', '2026-03-01', 7), 7);
  assert.equal(R.dayBefore('2026-03-01'), '2026-02-28');
});
await test('delivery and export', () => {
  assert.equal(R.deliveryFactor('truck'), 1.6);
  assert.equal(R.deliveryFactor('van'), 1.3);
  assert.equal(R.deliveryFactor('car'), 1);
  assert.equal(R.deliveryPay(3000, 1, 1, 1), 3200);
  assert.equal(R.deliveryPay(3000, 1.6, 1.5, 1), 7230);
  assert.equal(R.deliveryPay(3000, 1, 1, 0.1), 1280); // condition floor 40%
  assert.equal(R.deliveryPay(6000, 1.6, 1.5, 1), 13710);
  assert.equal(R.deliveryTimeBonus(3000, 3000 / 18), 1.5);
  assert.equal(R.deliveryTimeBonus(3000, 3000 / 12), 1);
  assert.equal(R.deliveryTimeLimit(3000), 303);
  assert.equal(R.exportPay(27500, 1), 1100);
  assert.equal(R.exportPay(9000, 1), 600);
  assert.equal(R.exportPay(3000000, 1), 25000);
  assert.equal(R.exportPay(27500, 1, true), 2200);
});
await test('export wanted lists are deterministic and rotate', () => {
  const t = Date.UTC(2026, 10, 3, 12, 0, 0);
  const a = R.exportWanted(t, 0, EXPORT_POOL), b = R.exportWanted(t + 1000, 0, EXPORT_POOL);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3);
  assert.notDeepEqual(R.exportWanted(t, 1, EXPORT_POOL), a);
  assert.notDeepEqual(R.exportWanted(t + 1200e3, 0, EXPORT_POOL), a);
  for (const id of a) assert.ok(PRICES[id] && !PRICES[id].starter);
});
await test('sinks', () => {
  assert.equal(R.hospitalFee(0), 0);
  assert.equal(R.hospitalFee(30), 30);
  assert.equal(R.hospitalFee(500), 50);
  assert.equal(R.hospitalFee(20000), 600);
  assert.equal(R.hospitalFee(1e7), 2500);
  assert.equal(R.repairCost(46000, 0.5), 276);
  assert.equal(R.repairCost(13900, 0.1), 100);
  assert.equal(R.repairCost(13900, 0.5, true), 0);
  assert.equal(R.sellPrice(100000), 55000);
  assert.equal(R.sellPrice(100000, 0.5), 27500);
});

console.log('price table');
await test('covers every catalog entry (+ economy overrides)', async () => {
  const all = [...VEHICLE_CATALOG, ...AIR_CATALOG, ...BOAT_CATALOG];
  for (const e of all) {
    const p = PRICES[e.id];
    assert.ok(p, `missing ${e.id}`);
    assert.ok(Number.isInteger(p.price) && p.price > 0, `price ${e.id}`);
    assert.ok(R.CLASS_RANGES[p.cls], `cls ${e.id}`);
    assert.equal(typeof p.starter, 'boolean');
  }
  const { PRICE_OVERRIDES } = await import('../../src/economy/price-overrides.js');
  for (const id of Object.keys(PRICES)) assert.ok(all.some((e) => e.id === id) || PRICE_OVERRIDES[id]?.pending, `stale entry ${id}`);
  for (const [id, o] of Object.entries(PRICE_OVERRIDES)) assert.equal(PRICES[id]?.price, o.price, `override ${id}`);
});
await test('starters: cheapest compact + cheapest bicycle', () => {
  assert.deepEqual([...STARTERS].sort(), ['kickflip', 'pip']);
});

console.log('Economy (singleplayer)');
await test('starting state', () => {
  const g = stubGame();
  const e = new Economy(g, { storage: new Store(), clock: clockAt(1e12) });
  assert.equal(e.money, 5000);
  assert.equal(g.player.money, 5000);
  assert.ok(e.owns('pip') && e.owns('kickflip') && !e.owns('comet'));
  assert.equal(e.netWorth(), 5000);
});
await test('earn: caps, cooldowns, per-minute', () => {
  const clk = clockAt(1e12);
  const g = stubGame();
  const e = new Economy(g, { storage: new Store(), clock: clk });
  assert.equal(e.earn('drift', 5000), 1500);
  assert.equal(e.earn('drift', 100), 0); // 2 s cooldown
  clk.c.t += 2100;
  assert.equal(e.earn('drift', 100), 100);
  let sum = 0;
  for (let i = 0; i < 10; i++) { clk.c.t += 200; sum += e.earn('pickup', 80); }
  assert.equal(sum, 300); // $300 / minute
  clk.c.t += 61000;
  assert.equal(e.earn('pickup', 80), 80);
  assert.equal(e.earn('bogus', 1000), 100); // unknown → other (max $100)
  assert.equal(e.money, 5000 + 1500 + 100 + 300 + 80 + 100);
});
await test('combo: skill events chain, timeout and crash reset', () => {
  const clk = clockAt(1e12);
  const g = stubGame();
  const e = new Economy(g, { storage: new Store(), clock: clk });
  g.player.controllable = { catalogId: 'pip' };
  const paid = [];
  for (let i = 0; i < 4; i++) { clk.c.t += 3000; paid.push(e.skill('nearmiss', 100)); e.update(1, g); }
  assert.deepEqual(paid, [100, 150, 200, 250]);
  assert.equal(e.combo, 2.5);
  const combos = g.events.log.filter(([n]) => n === 'economy:combo').map(([, p]) => p.combo);
  assert.deepEqual(combos, [1.5, 2, 2.5]);
  e.update(4.9, g); assert.equal(e.combo, 2.5); // window: 6 s after the last event (1 s already elapsed)
  e.update(0.2, g); assert.equal(e.combo, 1);
  e.skill('nearmiss', 1); e.bump(); assert.equal(e.combo, 1.5);
  g.events.emit('impact', { source: { other: true }, strength: 1 }); assert.equal(e.combo, 1.5);
  g.events.emit('impact', { source: g.player.controllable, strength: 0.1 }); assert.equal(e.combo, 1.5);
  g.events.emit('impact', { source: g.player.controllable, strength: 0.3 }); assert.equal(e.combo, 1);
  // holding keeps the window open (drift in progress)
  e.bump(); e.bump(); for (let i = 0; i < 20; i++) { e.holdCombo(); e.update(1, g); } assert.equal(e.combo, 1.5);
});
await test('buy / sell / starters / funds', async () => {
  const g = stubGame();
  const store = new Store();
  const e = new Economy(g, { storage: store, clock: clockAt(1e12) });
  assert.deepEqual(await e.buy('comet'), { ok: false, reason: 'funds' });
  e.grant(100000);
  const r = await e.buy('comet');
  assert.equal(r.ok, true);
  assert.equal(e.money, 105000 - PRICES.comet.price);
  assert.ok(e.owns('comet'));
  assert.deepEqual(await e.buy('comet'), { ok: false, reason: 'owned' });
  assert.deepEqual(await e.sell('pip'), { ok: false, reason: 'starter' });
  assert.equal(e.sellPrice('comet'), Math.round(PRICES.comet.price * 0.55));
  const s = await e.sell('comet');
  assert.equal(s.ok, true);
  assert.equal(e.money, 105000 - PRICES.comet.price + Math.round(PRICES.comet.price * 0.55));
  assert.ok(!e.owns('comet'));
  assert.ok(g.events.log.some(([n]) => n === 'economy:purchase'));
});
await test('hospital fee and partial charge', () => {
  const g = stubGame();
  const e = new Economy(g, { storage: new Store(), clock: clockAt(1e12) });
  assert.equal(e.charge('hospital'), 150); // 3% of 5000
  assert.equal(e.money, 4850);
  assert.equal(e.charge('repair', 99999), 0); // not affordable → nothing
  e.grant(-4830);
  assert.equal(e.charge('hospital'), 20); // less than the $50 minimum: takes what is there
  assert.equal(e.money, 0);
});
await test('sandbox only in singleplayer; unlock all', async () => {
  const g = stubGame();
  const e = new Economy(g, { storage: new Store(), clock: clockAt(1e12) });
  e.setUnlockAll(true);
  assert.ok(e.owns('plane_jet'));
  assert.deepEqual(await e.sell('plane_jet'), { ok: false, reason: 'unlocked' });
  const go = stubGame('online');
  const eo = new Economy(go, { storage: new Store(), clock: clockAt(1e12) });
  assert.equal(eo.grant(1000), 0);
  assert.equal(eo.setUnlockAll(true), false);
  assert.ok(!eo.owns('plane_jet'));
});
await test('save / restore round trip, debounced save, external money writes', async () => {
  const store = new Store();
  const clk = clockAt(1e12);
  const g = stubGame();
  const e = new Economy(g, { storage: store, clock: clk });
  e.grant(400000); assert.equal((await e.buy('super')).ok, true);
  e.collect(7); clk.c.t += 1000; e.collect(8);
  e.medal(3, 'gold', 8000); e.daily = { last: '2026-11-03', streak: 2 };
  e.last = { x: 10, z: 20, vehicle: 'super', land: 'super' };
  e.save();
  const g2 = stubGame();
  const e2 = new Economy(g2, { storage: store, clock: clk });
  assert.equal(e2.money, e.money);
  assert.ok(e2.owns('super') && e2.owns('pip'));
  assert.deepEqual([...e2.found], [7, 8]);
  assert.equal(e2.medals[3], 1);
  assert.equal(e2.daily.streak, 2);
  const plan = e2.startPlan();
  assert.equal(plan.vehicle, 'super');
  assert.equal(plan.restored, true);
  assert.deepEqual([plan.pos.x, plan.pos.z], [10, 20]);
  // an old code path writes player.money directly → adopted
  g2.player.money += 123; e2.update(0.016, g2);
  assert.equal(e2.money, e.money + 123);
  e2.dispose();
});
await test('daily bonus and first visits', () => {
  const store = new Store();
  const clk = clockAt(new Date(2026, 10, 3, 10).getTime());
  const g = stubGame();
  const e = new Economy(g, { storage: store, clock: clk });
  g.events.emit('start', {});
  assert.equal(e.money, 9000); // $5,000 start + day 1 $4,000
  e.update(3.1, g); // discovery armed after 3 s
  assert.equal(e.money, 9500);
  assert.ok(e.districts.has('Ocean Beach'));
  e.update(0.6, g); assert.equal(e.money, 9500); // once
  g.player.focus = { x: -1194, y: 1, z: -60 }; e.update(0.6, g); assert.equal(e.money, 10000);
  // next day: streak 2
  e.save(); clk.c.t += 864e5;
  const g2 = stubGame(); const e2 = new Economy(g2, { storage: store, clock: clk });
  g2.events.emit('start', {});
  assert.equal(e2.money, 10000 + 5000);
  assert.equal(e2.daily.streak, 2);
});

console.log('Economy (online, fake server)');
await test('optimistic claims reconcile with the server', async () => {
  const clk = clockAt(1e12);
  const g = stubGame('online');
  let server = 5000;
  const calls = [];
  let resolveLast;
  g.net = {
    claim(reason, amount, pos, meta) { calls.push([reason, amount, meta]); return new Promise((res) => { resolveLast = () => { const gr = Math.min(amount, 300); server += gr; res({ granted: gr, money: server }); }; }); },
    async buy(id) { const p = PRICES[id].price; if (server < p) return { ok: false, reason: 'funds' }; server -= p; return { ok: true, money: server, owned: ['pip', 'kickflip', id] }; },
    async sell() { return { ok: false, reason: 'rejected' }; },
    charge() { return null; },
  };
  const e = new Economy(g, { storage: new Store(), clock: clk });
  assert.equal(e.remote, true);
  assert.equal((await e.buy('kickflip')).reason, 'owned');
  e.applyServer({ money: 5000, owned: ['pip', 'kickflip'], progress: { c: [1], d: [1], m: {}, t: {}, s: [], dd: '2026-11-03', ds: 1 } });
  assert.equal(e.money, 5000);
  assert.ok(e.districts.has('Little Cuba'));
  const M = R.ONLINE.mult; // online payouts are the base formulas × ONLINE.mult
  const got = e.earn('drift', 1200, { x: 0, y: 0, z: 0 }, { dur: 3 });
  assert.equal(got, Math.min(1200 * M, R.reasonMax('drift', true)));
  assert.equal(e.money, 5000 + got); // optimistic
  assert.equal(calls[0][0], 'drift');
  assert.equal(calls[0][1], got, 'the claim carries the scaled amount');
  resolveLast(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.money, 5300); // server clamped to 300
  // unanswered claim expires
  clk.c.t += 3000; e.earn('stunt', 500);
  assert.equal(e.money, 5300 + 500 * M);
  clk.c.t += 7000; e.update(0.016, g);
  assert.equal(e.money, 5300);
  // purchase waits for the server
  const r = await e.buy('comet');
  assert.equal(r.ok, false); assert.equal(r.reason, 'funds');
  server = 60000;
  e.applyServer({ money: 60000 });
  assert.equal((await e.buy('comet')).ok, true);
  assert.equal(e.money, 60000 - PRICES.comet.price);
  assert.ok(e.owns('comet'));
  // hospital: predicted locally, the server charges on respawn
  const fee = e.charge('hospital');
  assert.equal(fee, R.hospitalFee(60000 - PRICES.comet.price));
  e.applyServer({ money: 60000 - PRICES.comet.price - fee });
  clk.c.t += 7000; e.update(0.016, g);
  assert.equal(e.money, 60000 - PRICES.comet.price - fee);
});

await test('online income multiplier: base pay in single, × ONLINE.mult online, caps and bucket agree', () => {
  const M = R.ONLINE.mult;
  assert.ok(M >= 1.5 && M <= 3, `online multiplier ${M} stays modest`);
  // singleplayer pays the base formulas
  const single = new Economy(stubGame('single'), { storage: new Store(), clock: clockAt(1e12) });
  assert.equal(single.incomeScale('delivery'), 1);
  assert.equal(single.earn('delivery', 4000), 4000);
  assert.equal(single.earn('nearmiss', 9999), R.REASONS.nearmiss.max, 'single caps unchanged');
  // online: scaled payout, scaled cap, unscaled street cash and `other`
  const g = stubGame('online');
  const claims = [];
  g.net = { claim(reason, amount) { claims.push([reason, amount]); return null; }, charge() { return null; } };
  const on = new Economy(g, { storage: new Store(), clock: clockAt(1e12) });
  on.applyServer({ money: 5000 });
  assert.equal(on.incomeScale('delivery'), M);
  assert.equal(on.earn('delivery', 4000), 4000 * M);
  assert.equal(on.earn('nearmiss', 9999), R.REASONS.nearmiss.max * M, 'online cap = REASONS.max × mult');
  assert.equal(on.earn('pickup', 80), 80, 'street cash is not scaled');
  assert.equal(on.earn('bogus', 1000), R.REASONS.other.max, '`other` is not scaled');
  assert.deepEqual(claims.map((c) => c[1]), [4000 * M, R.REASONS.nearmiss.max * M, 80, R.REASONS.other.max], 'claims carry the scaled amounts');
  // shared ceilings: reasonMax/incomeScale are what the server uses; every scaled bucket claim fits in one burst
  for (const [k, r] of Object.entries(R.REASONS)) {
    assert.equal(R.reasonMax(k, false), r.max);
    assert.equal(R.reasonMax(k, true), r.max * R.incomeScale(k, true));
    if (r.bucket) assert.ok(R.reasonMax(k, true) <= R.BUCKET.burst, `${k}: one max claim (${R.reasonMax(k, true)}) fits in the bucket burst`);
  }
  assert.equal(R.incomeScale('delivery', false), 1);
  // sustained online ceiling stays a ceiling: ≥ 3× the simulated skilled pace at ×mult (~$3k/min), ≤ $15k/min
  assert.ok(R.BUCKET.perSecond * 60 >= 9000 && R.BUCKET.perSecond * 60 <= 15000, `bucket ${R.BUCKET.perSecond * 60}/min`);
});

await test('online: connecting → server; unreachable from the start → local offline wallet', () => {
  const store = new Store();
  store.setItem('leonida.save.offline', JSON.stringify({ v: 1, money: 7777, owned: [] }));
  const g = stubGame('online');
  g.net = { client: { everOnline: false }, offlineRestored: false, claim: () => null };
  const e = new Economy(g, { storage: store, clock: clockAt(1e12) });
  assert.equal(e.remote, true); // connecting
  assert.equal(e.money, 0);
  g.net.offlineRestored = true; // the server never answered
  assert.equal(e.remote, false);
  assert.equal(e.money, 7777);
  assert.equal(e.earn('drift', 100), 100);
  assert.equal(e.money, 7877);
  assert.equal(e.grant(1000), 0); // still no sandbox online
  g.net.client.everOnline = true; // connected later: the server owns the wallet again
  assert.equal(e.remote, true);
  e.applyServer({ money: 123 });
  assert.equal(e.money, 123);
});

console.log('services');
function svcStub() {
  const log = [];
  return {
    log,
    nitroLevel: (v) => v?.boost ?? null,
    refillNitro: (v) => { log.push(['nitro', v?.catalogId]); if (v) v.boost = 1; return true; },
    setArmor: (v, on) => log.push(['armor', v.catalogId, on]),
    apply: (v) => log.push(['apply', v.catalogId]),
    extinguish: (v) => { if (!v.damage.burning) return false; v.damage.burning = false; log.push(['ext', v.catalogId]); return true; },
    deliverReplacement: (id) => log.push(['deliver', id]),
  };
}
await test('service prices (rules.servicePrice)', () => {
  assert.deepEqual(R.servicePrice('nitro'), { ok: true, price: 400 });
  assert.deepEqual(R.servicePrice('insurance'), { ok: true, price: 9000 });
  assert.equal(R.servicePrice('extinguisher', { extinguishers: 2 }).reason, 'max');
  assert.equal(R.servicePrice('armor', { owned: true, cls: 'military' }).reason, 'excluded');
  assert.equal(R.servicePrice('armor', { owned: false }).reason, 'notOwned');
  assert.equal(R.servicePrice('respray', { owned: true, opts: { color: 0xff0000, finish: 'metallic' } }).price, 2500);
  assert.equal(R.servicePrice('respray', { owned: true, opts: { color: 0xff0000 } }).price, 500);
  assert.equal(R.servicePrice('horn', { owned: true, opts: { variant: 'kazoo' } }).reason, 'variant');
  assert.equal(R.servicePrice('claim', { owned: true, insured: true }).price, 0);
  assert.equal(R.servicePrice('claim', { owned: true }).price, 1000);
  assert.equal(R.servicePrice('repair', { owned: true, price: 46000, damage: 0.4 }).price, 221);
});
await test('buyService: items, armour, cosmetics, insurance, persistence', async () => {
  const store = new Store();
  const clk = clockAt(1e12);
  const g = stubGame();
  g.services = svcStub();
  const e = new Economy(g, { storage: store, clock: clk });
  e.grant(200000);
  await e.buy('comet');
  const v = { catalogId: 'comet', kind: 'car', boost: 0.2, damage: { body: 1, engine: 1, burning: false } };
  g.player.controllable = v;
  assert.deepEqual(await e.buyService('extinguisher'), { ok: true, cost: 1500 });
  assert.equal((await e.buyService('extinguisher')).ok, true);
  assert.equal((await e.buyService('extinguisher')).reason, 'max');
  assert.equal(e.inventory.extinguisher, 2);
  assert.equal((await e.buyService('nitro')).cost, 400);
  assert.equal((await e.buyService('nitro')).reason, 'full');
  assert.equal((await e.buyService('armor')).ok, true);
  assert.equal((await e.buyService('armor')).reason, 'installed');
  assert.equal(e.custom('comet').armor, true);
  assert.equal((await e.buyService('neon', 'comet', { color: 3 })).cost, 5000);
  assert.equal(e.setNeon('comet', 6), true);
  assert.equal(e.custom('comet').neon, 6);
  assert.equal((await e.buyService('tint')).cost, 1200);
  assert.equal((await e.buyService('horn', 'comet', { variant: 'truck' })).cost, 2500);
  assert.equal((await e.buyService('respray', 'comet', { color: 0x123456, finish: 'pearl' })).cost, 2500);
  assert.equal((await e.buyService('tint', 'super')).reason, 'notOwned');
  assert.equal((await e.buyService('insurance')).cost, 9000);
  assert.equal((await e.buyService('insurance')).cost, 9000);
  assert.ok(Math.abs(e.insuranceLeftS() - 2 * 86400) < 1);
  // fire: one extinguisher used
  v.damage.burning = true;
  assert.equal(e.useExtinguisher(v), true);
  assert.equal(e.inventory.extinguisher, 1);
  assert.equal(e.useExtinguisher(v), false); // not burning any more
  const spent = 1500 * 2 + 400 + 6000 + 5000 + 1200 + 2500 + 2500 + 9000 * 2;
  assert.equal(e.money, 205000 - PRICES.comet.price - spent);
  e.save();
  const e2 = new Economy(stubGame(), { storage: store, clock: clk });
  assert.deepEqual(e2.custom('comet'), { armor: true, neonKit: true, neon: 6, tint: true, horn: 'truck', paint: 0x123456, finish: 'pearl' });
  assert.equal(e2.inventory.extinguisher, 1);
  assert.equal(e2.insured, true);
});
await test('destroyed owned car: insured → delivered, else wrecked → $1,000 claim on the next garage call', async () => {
  const clk = clockAt(1e12);
  const g = stubGame();
  g.services = svcStub();
  const e = new Economy(g, { storage: new Store(), clock: clk });
  e.grant(100000);
  await e.buy('comet');
  e.customs.comet = { armor: true };
  g.events.emit('vehicle:destroyed', { vehicle: { catalogId: 'comet', name: 'Shiden' } });
  assert.equal(e.isWrecked('comet'), true);
  assert.equal(e.custom('comet').armor, false); // plating is gone with the car
  assert.deepEqual(e.spawnCheck('comet'), { ok: true, fee: 1000 });
  assert.equal((await e.buyService('claim', 'comet')).cost, 1000);
  assert.equal(e.isWrecked('comet'), false);
  // starters and traffic cars never need a claim
  g.events.emit('vehicle:destroyed', { vehicle: { catalogId: 'pip' } });
  g.events.emit('vehicle:destroyed', { vehicle: { catalogId: 'comet', fromTraffic: true } });
  assert.equal(e.isWrecked('pip') || e.isWrecked('comet'), false);
  // insured: free replacement delivered
  await e.buyService('insurance');
  g.events.emit('vehicle:destroyed', { vehicle: { catalogId: 'comet' } });
  assert.equal(e.isWrecked('comet'), false);
  assert.deepEqual(g.services.log.at(-1), ['deliver', 'comet']);
  // insurance expires after 24 h
  clk.c.t += 86401e3;
  assert.equal(e.insured, false);
});
await test('repair service through the damage system clears the armour', async () => {
  const g = stubGame();
  g.services = svcStub();
  let repaired = 0;
  g.damage = { repair: (v) => { repaired++; v.damage.body = 1; v.damage.engine = 1; } };
  const e = new Economy(g, { storage: new Store(), clock: clockAt(1e12) });
  e.grant(100000); await e.buy('comet');
  e.customs.comet = { armor: true };
  const v = { catalogId: 'comet', kind: 'car', damage: { body: 0.5, engine: 0.7 } };
  g.player.controllable = v;
  assert.equal(e.serviceQuote('repair').price, 221);
  const m0 = e.money;
  assert.deepEqual(await e.buyService('repair'), { ok: true, cost: 221 });
  assert.equal(repaired, 1);
  assert.equal(e.money, m0 - 221);
  assert.equal(e.custom('comet').armor, false);
  assert.equal((await e.buyService('repair')).reason, 'undamaged');
  g.player.controllable = { catalogId: 'pip', kind: 'car', damage: { body: 0.2, engine: 1 } };
  assert.deepEqual(await e.buyService('repair'), { ok: true, cost: 0 }); // starter: free
});
await test('online: services go through net.service', async () => {
  const g = stubGame('online');
  g.services = svcStub();
  const calls = [];
  g.net = { claim: () => null, async service(id, vid, opts) { calls.push([id, vid, opts]); return { ok: true, money: 4000, inventory: { extinguisher: 1, insuranceUntil: 0 } }; } };
  const e = new Economy(g, { storage: new Store(), clock: clockAt(1e12) });
  e.applyServer({ money: 5500, owned: ['pip', 'kickflip'] });
  assert.deepEqual(await e.buyService('extinguisher'), { ok: true, cost: 1500 });
  assert.deepEqual(calls[0], ['extinguisher', null, {}]);
  assert.equal(e.money, 4000);
  assert.equal(e.inventory.extinguisher, 1);
  e.applyServer({ custom: { pip: { neonKit: true, neon: 2 } } });
  assert.equal(e.custom('pip').neon, 2);
});

console.log('wardrobe & nickname');
await test('wardrobe prices by tier and slot', () => {
  const W = R.WARDROBE.tiers;
  for (const tier of R.WARDROBE.tierOrder) for (const slot of ['top', 'legs', 'shoes', 'hat', 'glasses', 'accessory']) for (const value of [0, 0.5, 1]) {
    const p = R.wardrobePrice({ slot, tier, value });
    assert.ok(p >= W[tier][0] * 0.98 && p <= W[tier][1] * 1.02, `${slot}/${tier}/${value} = ${p}`);
  }
  assert.equal(R.wardrobePrice({ slot: 'hair', tier: 'basic', value: 0 }), 149);
  assert.equal(R.wardrobePrice({ slot: 'hair', tier: 'luxury', value: 1 }), 1190);
  assert.equal(R.wardrobePrice({ slot: 'tattoo', size: 0 }), 499);
  assert.equal(R.wardrobePrice({ slot: 'tattoo', size: 1 }), 8990);
  assert.equal(R.wardrobePrice({ slot: 'body' }), 15000);
  assert.equal(R.wardrobePrice({ slot: 'top', tier: 'basic', starter: true }), 0);
  assert.equal(R.dyePrice(10000), 1500);
  assert.equal(R.dyePrice(100), 50);
  assert.equal(R.nickPrice('reroll', 0), 0);
  assert.equal(R.nickPrice('reroll', 1), 2500);
  assert.equal(R.nickPrice('custom', 0), 50000);
});
await test('buyWardrobe / re-dye / setOutfit / net worth', async () => {
  const store = new Store();
  const g = stubGame();
  const e = new Economy(g, { storage: store, clock: clockAt(1e12) });
  const W = (await import('../../src/economy/wardrobe-prices.json', { with: { type: 'json' } })).default;
  const top = Object.keys(W).find((id) => W[id].slot === 'top' && W[id].tier === 'street' && !W[id].starter);
  const starterTop = Object.keys(W).find((id) => W[id].slot === 'top' && W[id].starter);
  assert.ok(e.ownsWardrobe(starterTop) && e.ownedWardrobe.has(starterTop));
  assert.equal((await e.buyWardrobe(top, 0xff0000)).cost, W[top].price);
  assert.equal((await e.buyWardrobe(top, 0xff0000)).reason, 'owned');
  const dye = await e.buyWardrobe(top, 0x00ff00);
  assert.deepEqual(dye, { ok: true, cost: W[top].dye, dyed: true });
  assert.equal(e.wardrobeColor(top), 0x00ff00);
  assert.equal(e.setOutfit({ top }).ok, true);
  assert.equal(e.setOutfit({ legs: top }).reason, 'unknown');
  const lux = Object.keys(W).find((id) => W[id].tier === 'luxury' && W[id].slot === 'accessory');
  assert.equal(e.setOutfit({ accessory: lux }).reason, 'notOwned');
  assert.equal((await e.buyWardrobe(lux)).reason, 'funds');
  assert.deepEqual(e.outfit, { top, colors: { [top]: 0x00ff00 } });
  assert.ok(g.events.log.some(([n]) => n === 'economy:outfit'));
  const worth = e.money;
  assert.equal(e.netWorth(), worth);
  e.save();
  const e2 = new Economy(stubGame(), { storage: store, clock: clockAt(1e12) });
  assert.equal(e2.ownsWardrobe(top), true);
  assert.equal(e2.outfit.top, top);
});
await test('wardrobe regression: one item per buy, palette colours, canonical outfit keys, glasses', async () => {
  // the wardrobe UI used to pass (ids[], outfit) to buyWardrobe and UI-category keys ({ tops: { id, color } }) to
  // setOutfit: purchases failed ('unknown') and worn items reverted on the next economy:outfit
  const { WARDROBE_BY_ID } = await import('../../src/characters/wardrobe.js');
  const store = new Store();
  const g = stubGame();
  g.wardrobe = { items: [...WARDROBE_BY_ID.values()], byId: WARDROBE_BY_ID };
  const e = new Economy(g, { storage: store, clock: clockAt(1e12) });
  e.grant(500000);
  assert.equal((await e.buyWardrobe(['glasses_aviator'], { top: 'x' })).reason, 'unknown', 'arrays are refused');
  const lens = WARDROBE_BY_ID.get('glasses_aviator').colors[2];
  const b = await e.buyWardrobe('glasses_aviator', lens);
  assert.equal(b.ok, true, `glasses buy ${b.reason}`);
  assert.equal(e.wardrobeColor('glasses_aviator'), lens);
  assert.equal((await e.buyWardrobe('glasses_aviator', '#' + lens.toString(16).padStart(6, '0'))).reason, 'owned', 'hex strings are colours too');
  // a starter item in its default colour is owned, not a re-dye
  const def = WARDROBE_BY_ID.get('top_hawaii').colors[0];
  assert.equal((await e.buyWardrobe('top_hawaii', def)).reason, 'owned');
  assert.equal(e.setOutfit({ tops: 'top_hawaii' }).reason, 'slot', 'UI keys are mapped by the UI, not here');
  // D's canonical shape { slot: { id, color } } is accepted (the colour is the owned one)
  assert.equal(e.setOutfit({ glasses: { id: 'glasses_aviator', color: lens }, top: { id: 'top_hawaii', color: def } }).ok, true);
  assert.deepEqual(e.outfit, { glasses: 'glasses_aviator', top: 'top_hawaii', colors: { glasses_aviator: lens } });
  // every category can be bought and worn
  for (const id of ['hat_fedora', 'jacket_leather', 'facial_goatee', 'tat_rose', 'body_lean', 'acc_cuban', 'shoes_boots', 'legs_cargo', 'hair_locs']) {
    const it = WARDROBE_BY_ID.get(id);
    const r = await e.buyWardrobe(id, it.colors[it.colors.length - 1] ?? null);
    assert.equal(r.ok, true, `${id}: ${r.reason}`);
    assert.equal(e.setOutfit({ [it.slot]: id }).ok, true, `${id} wear`);
  }
  e.save();
  const e2 = new Economy(stubGame(), { storage: store, clock: clockAt(1e12) });
  assert.equal(e2.outfit.glasses, 'glasses_aviator');
  assert.equal(e2.outfit.jacket, 'jacket_leather');
  assert.equal(e2.outfit.colors.glasses_aviator, lens);
});
await test('nickname: first reroll free, then $2,500; custom $50,000 with format checks', async () => {
  const g = stubGame();
  const e = new Economy(g, { storage: new Store(), clock: clockAt(1e12) });
  e.grant(100000);
  const m0 = e.money;
  const r1 = await e.changeNick({ mode: 'reroll' });
  assert.equal(r1.ok, true); assert.equal(r1.cost, 0); assert.ok(/^[A-Za-z]+\d*$/.test(r1.nick));
  const r2 = await e.changeNick({ mode: 'reroll' });
  assert.equal(r2.cost, 2500); assert.notEqual(r2.nick, undefined);
  assert.equal((await e.changeNick({ mode: 'custom', value: 'x' })).reason, 'short');
  assert.equal((await e.changeNick({ mode: 'custom', value: 'NeonGator42' })).reason, 'generated');
  assert.equal((await e.changeNick({ mode: 'custom', value: 'bad name!' })).reason, 'chars');
  const r3 = await e.changeNick({ mode: 'custom', value: 'Tommy_V' });
  assert.deepEqual([r3.ok, r3.nick, r3.cost], [true, 'Tommy_V', 50000]);
  assert.equal(e.money, m0 - 2500 - 50000);
  assert.equal(e.nickname, 'Tommy_V');
});

console.log('world data (spawn slots, places)');
const w = loadWorld();
const edges = edgesFromJSON(w.roads);
await test('120 Ocean Beach kerb slots, deterministic, dry, spaced', () => {
  const a = buildSpawnSets(edges, w.heightAt), b = buildSpawnSets(edges, w.heightAt);
  assert.equal(a.start.length, START_AREA.slots);
  assert.deepEqual(a.start, b.start);
  for (const s of a.start) {
    assert.ok(Math.hypot(s.x - START_AREA.x, s.z - START_AREA.z) <= START_AREA.r + 1);
    assert.ok(w.heightAt(s.x, s.z) > 0.2);
  }
  let minD = Infinity;
  for (let i = 0; i < a.start.length; i++) for (let j = i + 1; j < a.start.length; j++) minD = Math.min(minD, Math.hypot(a.start[i].x - a.start[j].x, a.start[i].z - a.start[j].z));
  assert.ok(minD >= 12.9, `min spacing ${minD}`);
  assert.equal(a.hospitals.length, HOSPITALS.length);
  for (const h of a.hospitals) assert.ok(h.slots.length >= 10, `${h.id}: ${h.slots.length} slots`);
});
await test('places snap to roads near their anchors; drop points', () => {
  const P = buildPlaces(edges, w.heightAt);
  for (const p of [...P.depots, ...P.yards, ...P.shops]) {
    assert.ok(Math.hypot(p.x - p.ax, p.z - p.az) < 80, `${p.id} moved ${Math.hypot(p.x - p.ax, p.z - p.az)}`);
    assert.ok(w.heightAt(p.x, p.z) > 0.2, `${p.id} in water`);
  }
  const D = buildDropPoints(edges, w.heightAt);
  assert.ok(D.length / 3 > 1000);
  for (const d of P.depots) {
    let c = 0;
    for (let i = 0; i < D.length; i += 3) { const k = Math.hypot(D[i] - d.x, D[i + 1] - d.z); if (k >= R.DELIVERY.searchMinM && k <= R.DELIVERY.searchMaxM) c++; }
    assert.ok(c >= 40, `${d.id}: ${c} destinations`);
  }
  assert.equal(polylineLength([0, 0, 3, 4, 3, 10]), 11);
});

console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
