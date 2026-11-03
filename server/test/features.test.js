// End-to-end: tank combat (server-resolved shells, reload, crush), services and cosmetics replication, paid
// nickname changes (validation, blocklist, uniqueness, never charged on rejection) and the paged online list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  S_FX, S_DAMAGE, S_GARAGE, S_INFO, S_NICK, S_LIST, S_ECON, S_SPAWN_ACK, S_GLOBAL, FX, DMG, SERVICE, NICK_OP, NICK_RESULT, NICK_PRICE, ECON_RESULT, ECON,
} from '../../src/net/shared/constants.js';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { WARDROBE_OP, VIS } from '../../src/net/shared/constants.js';
import { wreckPayload } from '../../src/net/shared/protocol.js';
import { WARDROBE } from '../../src/characters/wardrobe.js';
import { outfitCodes, lookOfCodes } from '../../src/net/shared/outfit-codes.js';

// a vehicle table with a tank (until the catalog ships one) and its price
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-feat-'));
const here = import.meta.dirname;
const vt = JSON.parse(fs.readFileSync(path.join(here, '../data/vehicles.json'), 'utf8'));
if (!vt.vehicles.some((v) => v.id === 'tank')) vt.vehicles.push({ id: 'tank', kind: 'tank', category: 'military', vclass: 1, topSpeedKmh: 65, traffic: false, price: 1500000, tier: 1 });
fs.writeFileSync(path.join(tmp, 'vehicles.json'), JSON.stringify(vt));
const pr = JSON.parse(fs.readFileSync(path.join(here, '../../src/economy/prices.json'), 'utf8'));
const table = pr.prices || pr;
table.tank ||= { price: 1800000, cls: 'military', starter: false };
fs.writeFileSync(path.join(tmp, 'prices.json'), JSON.stringify(table));
process.env.VEHICLES_PATH = path.join(tmp, 'vehicles.json');
process.env.PRICES_PATH = path.join(tmp, 'prices.json');

const quiet = { info() {}, warn() {}, error: console.error, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv, url;

test.before(async () => {
  const port = 22000 + Math.floor(Math.random() * 2000);
  srv = await startServer({ port, host: '127.0.0.1', workers: 0, dbPath: path.join(tmp, 'f.db'), log: quiet, logLevel: 'error', maxConnPerIp: 64, connRatePerIp: 1000, startMoney: 3_000_000, flushMs: 200 });
  url = `ws://127.0.0.1:${port}/ws`;
});
test.after(async () => { await srv.close(); });

async function synced(c) { for (let i = 0; i < 4; i++) { c.ping(i); await sleep(15); } }

test('tank: shells are resolved on the server (hit, reload, no weapon), and tanks crush cars', async () => {
  const A = new TestClient(url), B = new TestClient(url);
  await A.connect(); await B.connect();
  await synced(A); await synced(B);
  const tank = A.modelIndex('tank'), pip = B.modelIndex('pip');
  assert.ok(tank > 0, 'tank in the vehicle table');
  // buy + spawn the tank, drive it into position (A faces -z: yaw 0)
  A.sendState({ x: 1728, y: 2, z: -733, model: pip });
  B.sendState({ x: 1728, y: 2, z: -773, model: pip });
  await sleep(100);
  const bought = A.next(S_ECON);
  A.econ(ECON.BUY, tank);
  assert.equal((await bought).result, ECON_RESULT.OK);
  const ack = A.next(S_SPAWN_ACK);
  A.spawn(tank, 0x556b2f, 1728, -733);
  assert.equal((await ack).code, 0);
  const tankState = (o = {}) => ({ x: 1728, y: 2, z: -733, model: tank, turret: 0, barrel: -0.026, ...o });
  for (let i = 0; i < 6; i++) { A.sendState(tankState()); B.sendState({ x: 1728, y: 2, z: -773, model: pip }); await sleep(50); }
  // a car can't fire
  const noFx = A.next(S_FX, (f) => f.kind === FX.SHOT && f.netId === B.welcome.netId, 400).then(() => true, () => false);
  B.fire({ x: 1728, y: 3, z: -777, yaw: Math.PI, pitch: 0 });
  assert.equal(await noFx, false, 'no shot from a car');
  // the tank fires at B, 40 m ahead
  const shotSeen = B.next(S_FX, (f) => f.kind === FX.SHOT && f.netId === A.welcome.netId, 2000);
  const boom = B.next(S_FX, (f) => f.kind === FX.BOOM, 2000);
  const dmg = B.next(S_DAMAGE, () => true, 2000);
  const hit = A.next(S_FX, (f) => f.kind === FX.HIT, 2000);
  A.fire({ x: 1728, y: 4, z: -737, yaw: 0, pitch: -0.026 });
  const s = await shotSeen;
  assert.ok(Math.abs(s.z - -737) < 0.1, 'shot broadcast with the muzzle');
  const d = await dmg;
  assert.equal(d.kind, DMG.SHELL); assert.equal(d.destroyed, true); assert.equal(d.attacker, A.welcome.netId);
  assert.ok(Math.abs(d.z - -773) < 3, `impact near the victim (${d.z})`);
  assert.equal((await hit).victim, B.welcome.netId);
  await boom;
  // reload: an immediate second shot is ignored
  const second = B.next(S_FX, (f) => f.kind === FX.SHOT, 500).then(() => true, () => false);
  A.fire({ x: 1728, y: 4, z: -737, yaw: 0, pitch: -0.026 });
  assert.equal(await second, false, '3 s reload');
  // a shot into the ground near B still splashes it; aim outside the turret pose is refused
  const noAim = B.next(S_FX, (f) => f.kind === FX.SHOT, 500).then(() => true, () => false);
  await sleep(3000);
  A.fire({ x: 1728, y: 4, z: -737, yaw: 1.5, pitch: -0.026 });
  assert.equal(await noAim, false, 'barrel must point where the replicated turret points');
  // crush: B stops right in the tank's path, the tank rolls over it
  const crushed = B.next(S_DAMAGE, (x) => x.kind === DMG.CRUSH, 3000);
  let z = -733;
  for (let i = 0; i < 30; i++) {
    z -= 0.25;
    A.sendState(tankState({ z, vz: -5 }));
    B.sendState({ x: 1728.3, y: 2, z: -740, model: pip });
    await sleep(50);
  }
  const c = await crushed;
  assert.equal(c.destroyed, true); assert.equal(c.attacker, A.welcome.netId);
  A.close(); B.close();
});

test('services and cosmetics: priced by the server, replicated to other players through INFO', async () => {
  const A = new TestClient(url), B = new TestClient(url);
  await A.connect(); await B.connect();
  const garage0 = await A.next(S_GARAGE, () => true, 1000).catch(() => A.garage);
  assert.ok(garage0 && garage0.inventory, 'garage state after welcome');
  const pip = A.modelIndex('pip');
  A.sendState({ x: 1728, y: 2, z: -733, model: pip });
  B.sendState({ x: 1730, y: 2, z: -735, model: pip });
  await sleep(150);
  const money0 = A.money ?? A.welcome.money;
  const reply = A.next(S_ECON), garage = A.next(S_GARAGE);
  A.service(SERVICE.neon, pip, 3);
  assert.equal((await reply).result, ECON_RESULT.OK);
  assert.ok((await garage).custom.pip.neonKit);
  await sleep(100);
  assert.ok(A.money < money0, 'charged');
  const info = B.next(S_INFO, (l) => l.some((i) => i.netId === A.welcome.netId), 2000);
  B.infoReq([A.welcome.netId]);
  const mine = (await info).find((i) => i.netId === A.welcome.netId);
  assert.equal(mine.neon, 3, 'underglow replicated');
  const bad = A.next(S_ECON);
  A.service(SERVICE.horn, pip, 200);
  assert.equal((await bad).result, ECON_RESULT.VARIANT);
  A.close(); B.close();
});

test('wardrobe: buy a jacket in a palette colour, wear it, others get D\'s outfit codes (≤ 11 u16)', async () => {
  const A = new TestClient(url), B = new TestClient(url);
  await A.connect(); await B.connect();
  const garage = A.garage?.wardrobe ? A.garage : await A.next(S_GARAGE, (g) => !!g.wardrobe, 2000);
  const ids = garage.wardrobe;
  const jacket = WARDROBE.find((it) => it.slot === 'jacket' && !it.starter && it.colors.length > 1 && ids.includes(it.id));
  assert.ok(jacket, 'the wardrobe table has jackets');
  const index = ids.indexOf(jacket.id) + 1, colour = jacket.colors[1];
  A.sendState({ x: 1728, y: 2, z: -733 });
  await sleep(100);
  // off-palette colours are refused (they could not be replicated)
  const off = A.next(S_ECON);
  A.service(WARDROBE_OP.BUY, 0, 0, (0x123457 | 0x1000000) >>> 0, index);
  assert.equal((await off).result, ECON_RESULT.UNKNOWN);
  const buy = A.next(S_ECON);
  A.service(WARDROBE_OP.BUY, 0, 0, (colour | 0x1000000) >>> 0, index);
  assert.equal((await buy).result, ECON_RESULT.OK);
  await sleep(1100); // outfit changes: ≤ 1 per second
  const worn = A.next(S_ECON, (r) => r.op === WARDROBE_OP.BUY + 1);
  A.outfit(outfitCodes([jacket.id]));
  assert.equal((await worn).result, ECON_RESULT.OK);
  await sleep(100);
  const info = B.next(S_INFO, (l) => l.some((i) => i.netId === A.welcome.netId), 2000);
  B.infoReq([A.welcome.netId]);
  const mine = (await info).find((i) => i.netId === A.welcome.netId);
  assert.ok(mine.outfit.length >= 1 && mine.outfit.length <= 11, `codes ${mine.outfit}`);
  const look = lookOfCodes(mine.outfit);
  assert.deepEqual(look.jacket, { id: jacket.id, color: colour }, 'slot, item and colour survive the wire');
  // regression: glasses are buyable and a full outfit (jacket + glasses + starter items) is worn in one change
  const glasses = WARDROBE.find((it) => it.slot === 'glasses' && !it.starter && it.colors.length > 2 && ids.includes(it.id));
  assert.ok(glasses, 'the wardrobe table has glasses');
  const gbuy = A.next(S_ECON);
  A.service(WARDROBE_OP.BUY, 0, 0, (glasses.colors[2] | 0x1000000) >>> 0, ids.indexOf(glasses.id) + 1);
  assert.equal((await gbuy).result, ECON_RESULT.OK, 'glasses purchase');
  await sleep(1100);
  const full = A.next(S_ECON, (r) => r.op === WARDROBE_OP.BUY + 1);
  const starters = WARDROBE.filter((it) => it.starter && ids.includes(it.id) && !['jacket', 'glasses'].includes(it.slot));
  const bySlot = new Map(starters.map((it) => [it.slot, it.id]));
  A.outfit(outfitCodes([jacket.id, glasses.id, ...bySlot.values()]));
  assert.equal((await full).result, ECON_RESULT.OK, 'jacket + glasses + starters');
  await sleep(150);
  const g2 = A.garage?.outfit?.glasses === glasses.id ? A.garage : await A.next(S_GARAGE, (g) => g.outfit?.glasses === glasses.id, 2000);
  assert.equal(g2.outfit.jacket, jacket.id);
  // not owned → refused
  const other = WARDROBE.find((it) => it.slot === 'hat' && !it.starter && ids.includes(it.id));
  await sleep(1100);
  const no = A.next(S_ECON, (r) => r.op === WARDROBE_OP.BUY + 1);
  A.outfit(outfitCodes([other.id]));
  assert.equal((await no).result, ECON_RESULT.NOT_OWNED);
  A.close(); B.close();
});

test('visual state: car damage and a tank wreck seed reach others through INFO, on change only', async () => {
  const A = new TestClient(url), B = new TestClient(url);
  await A.connect(); await B.connect();
  const pip = A.modelIndex('pip'), tank = A.modelIndex('tank');
  A.sendState({ x: 1728, y: 2, z: -733, model: pip });
  B.sendState({ x: 1730, y: 2, z: -735, model: pip });
  await sleep(150);
  const infoOf = async () => {
    const p = B.next(S_INFO, (l) => l.some((i) => i.netId === A.welcome.netId), 2000);
    B.infoReq([A.welcome.netId]);
    return (await p).find((i) => i.netId === A.welcome.netId);
  };
  assert.equal((await infoOf()).damage, null);
  A.vis(VIS.DAMAGE, Uint8Array.of(0x05, 0x26, 1, 2, 3, 4, 5, 6, 7));
  await sleep(100);
  const d1 = await infoOf();
  assert.deepEqual([...d1.damage.data], [0x05, 0x26, 1, 2, 3, 4, 5, 6, 7]);
  // a car has no wreck seed to give (refused, nothing stored)
  A.vis(VIS.WRECK, wreckPayload(1234, false));
  await sleep(100);
  assert.equal((await infoOf()).wreck, null);
  // another vehicle: the dents stay with the old one
  const bought = A.next(S_ECON); A.econ(ECON.BUY, tank); assert.equal((await bought).result, ECON_RESULT.OK);
  const ack = A.next(S_SPAWN_ACK); A.spawn(tank, 0x556b2f, 1728, -733); assert.equal((await ack).code, 0);
  for (let i = 0; i < 4; i++) { A.sendState({ x: 1728, y: 2, z: -733, model: tank, turret: 0, barrel: 0 }); await sleep(50); }
  const d2 = await infoOf();
  assert.equal(d2.damage, null, 'cleared with the vehicle change');
  A.vis(VIS.WRECK, wreckPayload(0x1234567, true));
  await sleep(100);
  const w = (await infoOf()).wreck;
  assert.equal(w.seed, 0x1234567); assert.equal(w.short, true); assert.ok(w.ageMs < 1000, `age ${w.ageMs}`);
  A.close(); B.close();
});

test('nicknames: custom names are validated, unique (case-insensitive), charged only on success', async () => {
  const A = new TestClient(url), B = new TestClient(url);
  await A.connect(); await B.connect();
  const m0 = A.welcome.money;
  const blocked = A.next(S_NICK); A.nick(NICK_OP.CUSTOM, 'Big_D1ck');
  assert.equal((await blocked).result, NICK_RESULT.BLOCKED);
  const fmt = A.next(S_NICK); A.nick(NICK_OP.CUSTOM, '_x');
  assert.equal((await fmt).result, NICK_RESULT.FORMAT);
  const ok = A.next(S_NICK); A.nick(NICK_OP.CUSTOM, 'Night_Rider');
  const r = await ok;
  assert.equal(r.result, NICK_RESULT.OK); assert.equal(r.name, 'Night_Rider');
  assert.equal(r.money, m0 - NICK_PRICE.custom, 'charged once, only for the accepted name');
  const cd = A.next(S_NICK); A.nick(NICK_OP.CUSTOM, 'Other_Name');
  assert.equal((await cd).result, NICK_RESULT.COOLDOWN);
  const taken = B.next(S_NICK); B.nick(NICK_OP.CUSTOM, 'night_RIDER');
  const t = await taken;
  assert.equal(t.result, NICK_RESULT.TAKEN); assert.equal(t.money, B.welcome.money, 'not charged');
  // others see the name; the leaderboard carries it once the board refreshes
  A.sendState({ x: 1728, y: 2, z: -733 });
  await sleep(100);
  const info = B.next(S_INFO, () => true, 2000);
  B.infoReq([A.welcome.netId]);
  assert.equal((await info)[0].name, 'Night_Rider');
  A.close(); B.close();
});

test('online list: paged from the most recent joins, ≤ 1 page per second', async () => {
  const cs = [];
  for (let i = 0; i < 4; i++) { const c = new TestClient(url); await c.connect(); cs.push(c); }
  const viewer = cs[0];
  const page = viewer.next(S_LIST);
  viewer.list(0, 0);
  const p = await page;
  assert.ok(p.players.length >= 4, `page has the recent players (${p.players.length})`);
  assert.equal(p.players[0].netId, cs[3].welcome.netId, 'most recent first');
  const spam = viewer.next(S_LIST, () => true, 400).then(() => true, () => false);
  viewer.list(0, 0);
  assert.equal(await spam, false, 'rate limited');
  for (const c of cs) c.close();
});
