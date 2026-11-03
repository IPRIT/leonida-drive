// Anti-cheat units: movement validation (speed hack, teleport, fly hack, bounds, grace jumps) and the economy
// (money hacks, implausible claims, replays, purchases).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Movement, V_OK, V_JUMP, V_SPEED, V_TELEPORT, V_FLY, V_BOUNDS } from '../src/validate.js';
import { Economy, BUCKET_CAP, BUCKET_RATE } from '../src/economy.js';
import { loadVehicles, CLASS_LIMITS } from '../src/vehicles.js';
import { CLAIM, WALLET, VCLASS, ECON_RESULT, F_AIRBORNE, SERVICE } from '../../src/net/shared/constants.js';
import * as R from '../../src/economy/rules.js';

const flat = { heightAt: () => 0, hospitals: [{ x: 0, z: 0 }], districts: [{ name: 'Ocean Beach', type: 'd', x: 1728, z: -733, r: 856 }] };
const vehicles = loadVehicles();
const car = vehicles.byId.get('pip');
const st = (x, z, o = {}) => ({ x, y: 2, z, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, yawRate: 0, steer: 0, flags: 0, model: car.index, ...o });

function drive(mv, t0, from, speed, seconds, step = 50, o = {}) {
  let t = t0, x = from.x, z = from.z, code = V_OK;
  for (let k = 0; k < seconds * 1000 / step; k++) {
    t += step; z -= speed * step / 1000;
    code = mv.check(st(x, z, { vz: -speed, ...o }), t);
    if (code !== V_OK) return { code, t, x, z };
  }
  return { code, t, x, z };
}

test('honest driving at top speed with lag bursts is accepted', () => {
  const mv = new Movement(flat);
  mv.setClass(VCLASS.CAR, car.vmax, 0);
  mv.place(1000, 2, 0, 0, 0);
  const v = car.vmax * 0.95;
  let r = drive(mv, 0, { x: 1000, z: 0 }, v, 5);
  assert.equal(r.code, V_OK);
  // a 700 ms network stall, then the buffered states arrive in a burst
  const t = r.t + 700;
  r = drive(mv, t - 50, { x: r.x, z: r.z - v * 0.7 }, v, 1, 1); // 1 ms apart
  assert.equal(r.code, V_OK);
});

test('speed hack: moving faster than the vehicle can is rejected', () => {
  const mv = new Movement(flat);
  mv.setClass(VCLASS.CAR, car.vmax, 0);
  mv.place(1000, 2, 0, 0, 0);
  const r = drive(mv, 0, { x: 1000, z: 0 }, car.vmax * 2.2, 3);
  assert.ok(r.code === V_SPEED || r.code === V_TELEPORT, `detected (${r.code})`);
  // lying about the velocity doesn't help: the displacement itself is checked
  const mv3 = new Movement(flat);
  mv3.setClass(VCLASS.CAR, car.vmax, 0);
  mv3.place(1000, 2, 0, 0, 0);
  const r3 = drive(mv3, 0, { x: 1000, z: 0 }, car.vmax * 2.2, 3, 50, { vz: -10 });
  assert.equal(r3.code, V_TELEPORT);
  const mv2 = new Movement(flat);
  mv2.setClass(VCLASS.CAR, car.vmax, 0);
  mv2.place(1000, 2, 0, 0, 0);
  assert.equal(mv2.check(st(1000, -1, { vz: -500 }), 50), V_SPEED, 'reported velocity beyond the class limit');
});

test('teleport is rejected; a server-granted jump (join/respawn) is accepted once', () => {
  const mv = new Movement(flat);
  mv.setClass(VCLASS.CAR, car.vmax, 0);
  mv.place(1000, 2, 0, 0, 0);
  assert.equal(mv.check(st(3000, 0), 100), V_TELEPORT);
  mv.allowJump('respawn', 10000, (x, z) => Math.hypot(x, z) < 500);
  assert.equal(mv.check(st(4000, 0), 200), V_TELEPORT, 'grace only to allowed places');
  assert.equal(mv.check(st(100, 100), 300), V_JUMP);
  assert.equal(mv.check(st(2100, 100), 400), V_TELEPORT, 'grace is one-shot');
});

test('fly hack: a car climbing like an aircraft is rejected, a jump off a ramp is fine', () => {
  const mv = new Movement(flat);
  mv.setClass(VCLASS.CAR, car.vmax, 0);
  mv.place(0, 2, 0, 0, 0);
  // ramp: +5 m in one state at speed is OK
  assert.equal(mv.check(st(0, -2, { y: 5, vz: -30, flags: F_AIRBORNE }), 60), V_OK);
  let t = 100, y = 5, code = V_OK;
  for (let k = 0; k < 120 && code === V_OK; k++) { t += 50; y += 2; code = mv.check(st(0, -2 - k * 0.5, { y, vz: -10 }), t); }
  assert.equal(code, V_FLY);
});

test('bounds and class transitions (bail out of a fast car keeps momentum for a while)', () => {
  const mv = new Movement(flat);
  mv.place(0, 2, 0, 0, 0);
  assert.equal(mv.check(st(1e6, 0), 50), V_BOUNDS);
  mv.setClass(VCLASS.CAR, car.vmax, 0);
  let r = drive(mv, 0, { x: 0, z: 0 }, 50, 2);
  assert.equal(r.code, V_OK);
  mv.setClass(VCLASS.FOOT, CLASS_LIMITS[VCLASS.FOOT].h, r.t);
  const r2 = drive(mv, r.t, { x: r.x, z: r.z }, 40, 0.5, 50, { model: 0 });
  assert.equal(r2.code, V_OK, 'momentum after exiting');
  const r3 = drive(mv, r2.t + 8000, { x: r2.x, z: r2.z }, 40, 2, 50, { model: 0 });
  assert.notEqual(r3.code, V_OK, 'running at 40 m/s on foot is not plausible');
});

// ---------------- economy ----------------
const prices = new Map([['pip', { price: 13900, starter: true }], ['comet', { price: 46000, starter: false }], ['jet', { price: 8500000, starter: false }]]);
const ctx = { prices, vehicles, world: flat };

function trail(mv, t0, seconds, o) {
  let t = t0;
  for (let k = 0; k < seconds * 10; k++) { t += 100; mv.check(st(o.x ?? 0, (o.z0 ?? 0) - k * (o.v ?? 25) * 0.1, { vz: -(o.v ?? 25), yaw: o.yaw ?? 0, flags: o.flags ?? 0, y: o.y?.(k) ?? 2 }), t); }
  return t;
}

test('money hack: absurd amounts are clamped to what was observed, and the income bucket caps everything', () => {
  const eco = new Economy({ money: 0 }, ctx, 0);
  const mv = new Movement(flat);
  mv.setClass(VCLASS.CAR, car.vmax, 0);
  mv.place(0, 2, 0, 0, 0);
  // driving straight: a "drift" never happened
  let t = trail(mv, 0, 5, { v: 25 });
  let r = eco.claim({ reason: CLAIM.DRIFT, amount: 1e9, p1: 300, combo: 5, x: 0, z: 0 }, t, mv, { vclass: VCLASS.CAR, model: car.index });
  assert.equal(r.result, WALLET.REJECTED);
  // drifting (yaw 0.6 rad off the velocity) for 3 s: paid, but clamped far below the claimed billion
  t = trail(mv, t + 2100, 3, { v: 25, yaw: 0.6, z0: mv.z });
  r = eco.claim({ reason: CLAIM.DRIFT, amount: 1e9, p1: 300, combo: 1, x: 0, z: 0 }, t, mv, { vclass: VCLASS.CAR, model: car.index });
  assert.equal(r.result, WALLET.CLAMPED);
  assert.ok(r.granted > 50 && r.granted <= R.reasonMax('drift', true), `granted ${r.granted}`);
  // spamming plausible near misses for a minute cannot exceed the bucket
  let total = 0;
  for (let k = 0; k < 600; k++) {
    t = trail(mv, t, 0.2, { v: 40, z0: mv.z });
    total += eco.claim({ reason: CLAIM.NEARMISS, amount: 500, combo: 5, x: mv.x, z: mv.z }, t, mv, { vclass: VCLASS.CAR, model: car.index }).granted;
  }
  assert.ok(total <= BUCKET_CAP + BUCKET_RATE * 120 + 100, `near-miss income ${total} within the bucket`);
});

test('stunt needs an observed airborne arc; aircraft cannot claim stunts', () => {
  const eco = new Economy({ money: 0 }, ctx, 0);
  const mv = new Movement(flat);
  mv.setClass(VCLASS.CAR, car.vmax, 0);
  mv.place(0, 2, 0, 0, 0);
  let t = trail(mv, 0, 3, { v: 25 });
  assert.equal(eco.claim({ reason: CLAIM.STUNT, amount: 900, p1: 200, p2: 100 }, t, mv, { vclass: VCLASS.CAR, model: car.index }).result, WALLET.REJECTED);
  t = trail(mv, t, 2.5, { v: 25, z0: mv.z, flags: F_AIRBORNE, y: (k) => 2 + Math.sin((k / 25) * Math.PI) * 8 });
  const ok = eco.claim({ reason: CLAIM.STUNT, amount: 900, p1: 230, p2: 80 }, t, mv, { vclass: VCLASS.CAR, model: car.index });
  assert.ok(ok.granted > 0, `stunt granted ${ok.granted}`);
  assert.equal(eco.claim({ reason: CLAIM.STUNT, amount: 900, p1: 230, p2: 80 }, t + 5000, mv, { vclass: VCLASS.PLANE, model: car.index }).result, WALLET.REJECTED);
});

test('collectibles and districts cannot be replayed; pickups must be where you were', () => {
  const eco = new Economy({ money: 0 }, ctx, 0);
  const mv = new Movement(flat);
  mv.place(1728, 2, -733, 0, 0);
  mv.check(st(1728, -733, { model: 0 }), 10);
  const c = { reason: CLAIM.COLLECTIBLE, amount: 1, meta: 7, x: 1728, z: -733 };
  assert.equal(eco.claim(c, 1000, mv, { vclass: VCLASS.FOOT }).granted, 1000 * R.ONLINE.mult, 'online payouts are × ONLINE.mult');
  assert.equal(eco.claim(c, 3000, mv, { vclass: VCLASS.FOOT }).result, WALLET.REJECTED, 'same postcard twice');
  assert.equal(eco.claim({ ...c, meta: 8, x: 5000, z: 5000 }, 5000, mv, { vclass: VCLASS.FOOT }).result, WALLET.REJECTED, 'not there');
  assert.equal(eco.claim({ reason: CLAIM.FIRSTVISIT, meta: 0, amount: 0 }, 6000, mv, { vclass: VCLASS.FOOT }).granted, 500 * R.ONLINE.mult);
  assert.equal(eco.claim({ reason: CLAIM.FIRSTVISIT, meta: 0, amount: 0 }, 9000, mv, { vclass: VCLASS.FOOT }).result, WALLET.REJECTED);
  assert.equal(eco.claim({ reason: CLAIM.PICKUP, amount: 5000, x: 1728, z: -733 }, 9500, mv, { vclass: VCLASS.FOOT }).granted, 80, 'pickups capped at $80');
  assert.equal(eco.claim({ reason: CLAIM.RACE, amount: 15000, meta: 1, tier: 1, p1: 600 }, 10000, mv, { vclass: VCLASS.CAR }).result, WALLET.REJECTED, 'a race that was not driven');
  assert.equal(eco.claim({ reason: 99, amount: 5 }, 11000, mv, { vclass: VCLASS.FOOT }).result, WALLET.REJECTED, 'unknown reason');
  assert.equal(eco.claim({ reason: CLAIM.OTHER, amount: 5 }, 12000, mv, { vclass: VCLASS.FOOT, frozen: true }).result, WALLET.FROZEN);
});

test('buy / sell / repair are atomic and checked against the shared price table', () => {
  const eco = new Economy({ money: 50000 }, ctx, 0);
  assert.ok(eco.owned.has('pip'), 'starters are always owned');
  assert.equal(eco.buy('jet').result, ECON_RESULT.FUNDS);
  assert.equal(eco.money, 50000);
  assert.equal(eco.buy('comet').result, ECON_RESULT.OK);
  assert.equal(eco.money, 4000);
  assert.equal(eco.buy('comet').result, ECON_RESULT.OWNED);
  assert.equal(eco.sell('pip', 1).result, ECON_RESULT.NOT_SELLABLE);
  assert.equal(eco.sell('comet', 2).delta, Math.round(46000 * 0.55), 'condition can only lower the payout');
  assert.equal(eco.sell('comet', 1).result, ECON_RESULT.NOT_OWNED);
  assert.equal(eco.repair('pip', 1).delta, 0, 'starter repairs are free');
  assert.equal(eco.buy('nope').result, ECON_RESULT.UNKNOWN);
  assert.equal(eco.worth(), eco.money, 'unsellable starters do not inflate net worth');
  const fee = eco.hospital();
  assert.equal(fee, R.hospitalFee(29300));
});

test('daily bonus: once per UTC day, streak grows on consecutive days', () => {
  const today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const eco = new Economy({ money: 0, progress: { dd: yesterday, ds: 3 } }, ctx, 0);
  assert.deepEqual(eco.grantDaily(), { amount: R.dailyPay(4) * R.ONLINE.mult, streak: 4 });
  assert.equal(eco.grantDaily(), null);
  assert.equal(eco.progress.dd, today);
});

test('services: priced by the shared rules, persisted per owned vehicle; wardrobe purchases and outfits', () => {
  const wardrobe = { byId: new Map([['hat_cap', { id: 'hat_cap', index: 1, price: 300, slot: 'head', free: false }], ['hat_top', { id: 'hat_top', index: 2, price: 900, slot: 'head', free: false }], ['tee', { id: 'tee', index: 3, price: 0, slot: 'top', free: true }]]) };
  const eco = new Economy({ money: 50000, owned: ['comet'] }, { ...ctx, wardrobe }, 0);
  // extinguishers: max 2 carried
  assert.equal(eco.service(SERVICE.extinguisher, null).result, ECON_RESULT.OK);
  assert.equal(eco.service(SERVICE.extinguisher, null).result, ECON_RESULT.OK);
  assert.equal(eco.service(SERVICE.extinguisher, null).result, ECON_RESULT.MAX);
  assert.equal(eco.money, 50000 - 2 * R.SERVICES.extinguisher.price);
  assert.equal(eco.service(SERVICE.USE_EXTINGUISHER, null).result, ECON_RESULT.OK);
  assert.equal(eco.inventory.extinguisher, 1);
  // cosmetics need an owned vehicle and are stored per model
  assert.equal(eco.service(SERVICE.neon, 'jet', { color: 1 }).result, ECON_RESULT.NOT_OWNED);
  assert.equal(eco.service(SERVICE.neon, 'comet', { color: 2 }).result, ECON_RESULT.OK);
  assert.equal(eco.service(SERVICE.neon, 'comet', { color: 3 }).result, ECON_RESULT.INSTALLED);
  assert.equal(eco.service(SERVICE.NEON_COLOR, 'comet', { color: 5 }).result, ECON_RESULT.OK, 'recolour is free');
  assert.equal(eco.cosmeticsOf('comet').neon, 5);
  assert.equal(eco.service(SERVICE.horn, 'comet', { variant: 'nope' }).result, ECON_RESULT.VARIANT);
  assert.equal(eco.service(SERVICE.horn, 'comet', { variant: 'police' }).result, ECON_RESULT.OK);
  assert.equal(eco.cosmeticsOf('comet').horn, R.HORN_VARIANTS.indexOf('police'));
  const before = eco.money;
  assert.equal(eco.service(SERVICE.respray, 'comet', { color: 0x123456, finish: 'pearl' }).result, ECON_RESULT.OK);
  assert.equal(before - eco.money, R.SERVICES.respray.premium);
  assert.equal(eco.service(SERVICE.insurance, null).result, ECON_RESULT.OK);
  assert.ok(eco.insured);
  // persisted shape survives a reload; customs of models you no longer own are dropped
  const g = eco.garageJSON();
  const again = new Economy({ money: 1, owned: ['comet'], garage: g }, { ...ctx, wardrobe }, 0);
  assert.equal(again.cosmeticsOf('comet').neon, 5);
  assert.equal(again.inventory.extinguisher, 1);
  assert.equal(new Economy({ money: 1, owned: [], garage: g }, { ...ctx, wardrobe }, 0).cosmeticsOf('comet'), null);
  assert.equal(again.service(SERVICE.tint, 'comet').result, ECON_RESULT.FUNDS, 'no money, no tint');
  // wardrobe
  assert.equal(eco.buyClothing('hat_cap').result, ECON_RESULT.OK);
  assert.equal(eco.buyClothing('hat_cap').result, ECON_RESULT.OWNED);
  assert.equal(eco.setOutfit(['hat_top']), ECON_RESULT.NOT_OWNED);
  assert.equal(eco.setOutfit(['hat_cap', 'tee']), ECON_RESULT.OK, 'free items need no purchase');
  assert.equal(eco.buyClothing('hat_top').result, ECON_RESULT.OK);
  assert.equal(eco.setOutfit(['hat_cap', 'hat_top']), ECON_RESULT.VARIANT, 'one item per slot');
  // regression: a free item in its palette's default colour is owned, not a paid re-dye
  const pal = { byId: new Map([['top_hawaii', { id: 'top_hawaii', index: 1, price: 0, dye: 50, slot: 'top', free: true, colors: [0x14a89c, 0xff5fa2] }], ['glasses_aviator', { id: 'glasses_aviator', index: 2, price: 9000, dye: 1350, slot: 'glasses', free: false, colors: [0x15181e, 0x2a6bd8] }]]) };
  const ew = new Economy({ money: 20000, owned: [] }, { ...ctx, wardrobe: pal }, 0);
  assert.equal(ew.buyClothing('top_hawaii', 0x14a89c).result, ECON_RESULT.OWNED, 'default colour = owned colour');
  assert.equal(ew.buyClothing('top_hawaii', 0xff5fa2, true).delta, -50, 'another palette colour is a re-dye');
  assert.equal(ew.buyClothing('glasses_aviator', 0x2a6bd8).result, ECON_RESULT.OK, 'glasses buy in a lens colour');
  assert.equal(ew.buyClothing('glasses_aviator', 0x2a6bd8).result, ECON_RESULT.OWNED);
  assert.equal(ew.setOutfit(['top_hawaii', 'glasses_aviator']), ECON_RESULT.OK);
  assert.deepEqual(ew.wardrobeJSON().fit, { top: 'top_hawaii', glasses: 'glasses_aviator' });
});

test('export: owned models are rejected; near-miss bundles pay per rules', () => {
  const eco = new Economy({ money: 0, owned: ['comet'] }, ctx, 0);
  const mv = new Movement(flat);
  mv.setClass(VCLASS.CAR, 80, 0);
  mv.place(0, 2, 0, 0, 0);
  const comet = vehicles.byId.get('comet');
  assert.equal(eco.claim({ reason: CLAIM.EXPORT, amount: 1, meta: comet.index, tier: 100 }, 1000, mv, { vclass: VCLASS.CAR, model: comet.index }).result, WALLET.REJECTED);
  let t = 0;
  for (let i = 1; i <= 30; i++) { t = i * 50; mv.check(st(0, -i * 1.6, { vz: -32 }), t); } // ~115 km/h
  const r = eco.claim({ reason: CLAIM.NEARMISS, amount: 5000, p2: 115, tier: 3, combo: 1, x: 0, z: -40 }, t + 10, mv, { vclass: VCLASS.CAR, model: car.index });
  assert.equal(r.result, WALLET.CLAMPED);
  assert.ok(r.granted <= R.reasonMax('nearmiss', true) && r.granted >= R.nearMissPay(110, 1, 3) * R.ONLINE.mult * 0.9, `bundle pay ${r.granted}`);
});

test('online multiplier: the server pays base × ONLINE.mult, clamps anything above it, and the bucket holds one max claim', () => {
  const M = R.ONLINE.mult;
  const mk = () => {
    const eco = new Economy({ money: 0 }, ctx, 0);
    const mv = new Movement(flat);
    mv.setClass(VCLASS.CAR, 80, 0);
    mv.place(0, 2, 0, 0, 0);
    let t = 0;
    for (let i = 1; i <= 30; i++) { t = i * 50; mv.check(st(0, -i * 1.6, { vz: -32 }), t); } // ~115 km/h
    return { eco, mv, t };
  };
  // an honest scaled claim is granted in full
  let { eco, mv, t } = mk();
  const honest = R.nearMissPay(110, 1, 1) * M;
  let r = eco.claim({ reason: CLAIM.NEARMISS, amount: honest, p2: 110, tier: 1, combo: 1, x: 0, z: -40 }, t + 10, mv, { vclass: VCLASS.CAR, model: car.index });
  assert.equal(r.result, WALLET.GRANTED);
  assert.equal(r.granted, honest);
  // an inflated claim (×3 instead of ×mult) is clamped to the scaled formula the server computed itself
  ({ eco, mv, t } = mk());
  r = eco.claim({ reason: CLAIM.NEARMISS, amount: R.nearMissPay(110, 1, 1) * 3 * M, p2: 110, tier: 1, combo: 1, x: 0, z: -40 }, t + 10, mv, { vclass: VCLASS.CAR, model: car.index });
  assert.equal(r.result, WALLET.CLAMPED);
  assert.ok(r.granted <= Math.ceil(R.nearMissPay(115 * 1.05, 1, 1) * 1.05 * M), `clamped to ${r.granted}`);
  // ceilings and the bucket
  assert.ok(BUCKET_CAP >= R.reasonMax('export', true) && BUCKET_CAP >= R.reasonMax('delivery', true), 'a max export/delivery fits in one burst');
  assert.equal(R.reasonMax('pickup', true), R.REASONS.pickup.max, 'street cash is not scaled');
});
