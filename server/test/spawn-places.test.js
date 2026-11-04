import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { vehicleSpawnDestination } from '../src/spawn-places.js';
import { Movement, V_JUMP, V_TELEPORT } from '../src/validate.js';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { ECON, ECON_RESULT, S_ECON, S_SPAWN_ACK, S_CORRECTION, VCLASS } from '../../src/net/shared/constants.js';

const runways = [{ x0: 3000, z0: 0, x1: 4000, z1: 0, w: 50, y: 0 }];
const terrain = { hasTerrain: true, heightAt: () => 0 };
const plane = { id: 'plane_trainer', kind: 'plane', index: 7 };

test('an approved aircraft relocation is model-bound, runway-bound, time-limited and usable once', () => {
  const accept = vehicleSpawnDestination(plane, { x: 0, z: 0 }, terrain, runways);
  assert.equal(accept(3060, 0, { model: 8, y: 2 }), false);
  assert.equal(accept(3000, 1000, { model: 7, y: 2 }), false);
  assert.equal(accept(3060, 0, { model: 7, y: 300 }), false);
  const state = (x) => ({ x, y: 2, z: 0, model: 7, yaw: 0, vx: 0, vy: 0, vz: 0, flags: 0 });
  const m = new Movement(terrain); m.place(0, 2, 0, 0, 0); m.setClass(VCLASS.PLANE, 100, 0);
  m.allowJump('vehicle-spawn', 30000, accept);
  assert.equal(m.check(state(3060), 100), V_JUMP);
  assert.equal(m.check(state(3900), 200), V_TELEPORT);
  const expired = new Movement(terrain); expired.place(0, 2, 0, 0, 0); expired.setClass(VCLASS.PLANE, 100, 0);
  expired.allowJump('vehicle-spawn', 100, accept);
  assert.equal(expired.check(state(3060), 101), V_TELEPORT);
});

test('watercraft may relocate to nearby open water, but cars and remote dry land get no exemption', () => {
  const wet = { hasTerrain: true, heightAt: (x) => x > 100 ? -3 : 1 };
  const boat = vehicleSpawnDestination({ id: 'boat_speed', kind: 'boat', index: 9 }, { x: 0, z: 0 }, wet, runways);
  assert.equal(boat(200, 0, { model: 9, y: 0 }), true);
  assert.equal(boat(50, 0, { model: 9, y: 0 }), false);
  assert.equal(boat(6000, 0, { model: 9, y: 0 }), false);
  assert.equal(vehicleSpawnDestination({ kind: 'car' }, { x: 0, z: 0 }, wet, runways), null);
});

test('a freely unlocked airplane can appear on a runway and restore there after reconnect without a freeze', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-airspawn-'));
  const dbPath = path.join(tmp, 'profiles.db');
  const port = 32000 + Math.floor(Math.random() * 2000);
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const server = await startServer({ host: '127.0.0.1', port, workers: 0, dbPath, startMoney: 5_000_000, log: quiet });
  const client = new TestClient(`ws://127.0.0.1:${port}/ws`);
  let restored;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await client.connect();
    const model = client.modelIndex('plane_trainer'), pip = client.modelIndex('pip');
    const origin = { x: 2145, y: 2, z: -640 };
    // Consume the ordinary join allowance before testing the garage grant.
    client.sendState({ ...origin, model: pip });
    await sleep(100);
    const purchase = client.next(S_ECON);
    client.econ(ECON.BUY, model);
    assert.equal((await purchase).result, ECON_RESULT.OWNED);
    assert.equal(client.money ?? client.welcome.money, client.welcome.money, 'the free aircraft never charges the wallet');
    const ack = client.next(S_SPAWN_ACK);
    client.spawn(model, 0xffffff, origin.x, origin.z);
    assert.equal((await ack).code, 0);
    const places = JSON.parse(fs.readFileSync(new URL('../data/spawn-places.json', import.meta.url))).runways;
    const r = places.find((p) => p.airport.includes('Goose')) || places.at(-1);
    const length = Math.hypot(r.x1 - r.x0, r.z1 - r.z0);
    const pose = { x: r.x0 + (r.x1 - r.x0) * 60 / length, y: r.y + 2, z: r.z0 + (r.z1 - r.z0) * 60 / length, model };
    const corrected = client.next(S_CORRECTION, () => true, 400).then(() => true, () => false);
    for (let i = 0; i < 5; i++) { client.sendState(pose); await sleep(30); }
    assert.equal(await corrected, false, 'approved runway placement must not be corrected');
    const token = client.token;
    client.close(); await sleep(150);
    // Old profiles can have an aircraft saved at the pre-spawn city position.
    // Its client reconstructs the aircraft on the runway during restore.
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE players SET x=?, y=?, z=?, vehicle_id=? WHERE token_hash=?').run(origin.x, origin.y, origin.z, 'plane_trainer', createHash('sha256').update(Buffer.from(token)).digest());
    db.close();
    restored = new TestClient(`ws://127.0.0.1:${port}/ws`, { token });
    await restored.connect();
    const restoreCorrection = restored.next(S_CORRECTION, () => true, 400).then(() => true, () => false);
    restored.sendState(pose);
    assert.equal(await restoreCorrection, false, 'restoring an owned aircraft must allow its runway placement');
    const illegal = restored.next(S_CORRECTION);
    restored.sendState({ ...pose, x: origin.x, z: origin.z });
    assert.equal((await illegal).reason, V_TELEPORT, 'the grant must not allow a second arbitrary teleport');
  } finally {
    client.close(); restored?.close(); await server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
