// End-to-end against a real server: origin allowlist, oversize/flood/garbage handling, protocol version, speed hack
// correction, money hacks, duplicate sessions, and persistence across a real process restart (SIGTERM → new process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import {
  S_CORRECTION, S_WALLET, S_KICK, S_ECON, S_OWNED, KICK, WALLET, CLAIM, ECON, ECON_RESULT, PROTO_VERSION, C_HELLO, HELLO_SIZE,
} from '../../src/net/shared/constants.js';
import { ONLINE } from '../../src/economy/rules.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-test-'));
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };
let srv, url, port;

test.before(async () => {
  port = 18000 + Math.floor(Math.random() * 2000);
  srv = await startServer({ port, host: '127.0.0.1', workers: 0, dbPath: path.join(tmp, 'a.db'), log: quiet, logLevel: 'error', maxConnPerIp: 64, connRatePerIp: 1000 });
  url = `ws://127.0.0.1:${port}/ws`;
});
test.after(async () => { await srv.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closed = (ws) => new Promise((r) => { if (ws.readyState === 3) r(); else ws.once('close', (code) => r(code)); });

test('origin allowlist: foreign origins are refused at the upgrade', async () => {
  await assert.rejects(new TestClient(url, { origin: 'https://evil.example' }).connect(), /HTTP 403/);
  await assert.rejects(new TestClient(url, { origin: null }).connect(), /HTTP 403/, 'no Origin header: refused unless ALLOW_NO_ORIGIN');
  const ok = new TestClient(url, { origin: 'http://localhost:5320' });
  await ok.connect();
  ok.close();
});

test('wrong protocol version is kicked with PROTOCOL', async () => {
  const ws = new WebSocket(url, { headers: { Origin: 'http://localhost:5317' } });
  await new Promise((r) => ws.once('open', r));
  const b = new ArrayBuffer(HELLO_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_HELLO); dv.setUint8(1, PROTO_VERSION + 1);
  const kick = new Promise((r) => ws.on('message', (d) => { const v = new Uint8Array(d); if (v[0] === S_KICK) r(v[1]); }));
  ws.send(b);
  assert.equal(await kick, KICK.PROTOCOL);
  await closed(ws);
});

test('oversized messages close the socket; garbage and floods get kicked; the server survives', async () => {
  const a = new TestClient(url); await a.connect();
  a.ws.send(new Uint8Array(4096));
  const code = await closed(a.ws);
  assert.ok(code === 1009 || code === 1006 || a.closed, `oversize closed (${code})`);
  const b = new TestClient(url); await b.connect();
  for (let i = 0; i < 6; i++) b.ws.send('{"hack":true}'); // text frames are never valid
  await closed(b.ws);
  assert.ok(b.closed);
  const c = new TestClient(url); await c.connect();
  for (let i = 0; i < 1500; i++) c.sendState({ x: 1728, y: 2, z: -733 });
  await closed(c.ws);
  assert.ok(c.closed, 'flood kicked');
  const d = new TestClient(url); await d.connect(); // still serving
  for (const bad of [new Uint8Array([0x02, 1, 2]), new Uint8Array([0x77]), new Uint8Array([0x06, 40])]) d.ws.send(bad);
  await sleep(100);
  assert.equal(d.closed, false, 'a few malformed messages only cost strikes');
  d.close();
});

test('speed hack gets corrected back to the last valid position', async () => {
  const a = new TestClient(url); await a.connect();
  a.sendState({ x: 1728, y: 2, z: -733, model: a.modelIndex('pip') });
  await sleep(120);
  const corr = a.next(S_CORRECTION, () => true, 3000);
  let z = -733;
  for (let i = 0; i < 20; i++) { z -= 30; a.sendState({ x: 1728, y: 2, z, vz: -60, model: a.modelIndex('pip') }); await sleep(20); } // 1500 m/s
  const c = await corr;
  assert.ok(Math.abs(c.z - -733) < 60, `corrected to ${c.z}`);
  a.close();
});

test('money hacks: implausible claims are rejected, collectibles cannot be replayed', async () => {
  const a = new TestClient(url); await a.connect();
  const start = a.welcome.money;
  a.sendState({ x: 1728, y: 2, z: -733, model: a.modelIndex('pip') });
  await sleep(150);
  a.claim({ reason: CLAIM.DRIFT, amount: 1_000_000, p1: 500, combo: 5, x: 1728, z: -733 });
  assert.equal((await a.next(S_WALLET)).result, WALLET.REJECTED, 'no drift happened');
  a.claim({ reason: CLAIM.PICKUP, amount: 80, x: 0, z: 0 });
  assert.equal((await a.next(S_WALLET)).result, WALLET.REJECTED, 'pickup far away');
  a.claim({ reason: CLAIM.COLLECTIBLE, amount: 1, meta: 3, x: 1728, z: -733 });
  const w1 = await a.next(S_WALLET);
  assert.equal(w1.delta, 1000 * ONLINE.mult, 'online payouts are × ONLINE.mult');
  a.claim({ reason: CLAIM.COLLECTIBLE, amount: 1, meta: 3, x: 1728, z: -733 });
  assert.equal((await a.next(S_WALLET)).result, WALLET.REJECTED, 'replay');
  assert.equal(a.money, start + 1000 * ONLINE.mult);
  a.close();
});

test('purchases: the server checks funds and ownership; spawning needs ownership', async () => {
  const a = new TestClient(url); await a.connect();
  const jet = a.modelIndex('tank');
  a.econ(ECON.BUY, jet);
  assert.equal((await a.next(S_ECON)).result, ECON_RESULT.FUNDS);
  a.spawn(jet, 0xffffff, 1728, -733, 9);
  const ack = await a.next(0x89);
  assert.equal(ack.code, 6, 'not owned');
  a.close();
});

test('duplicate session: the older tab is kicked', async () => {
  const a = new TestClient(url); await a.connect();
  const kicked = a.next(S_KICK, () => true, 5000);
  const b = new TestClient(url, { token: a.token }); await b.connect();
  assert.equal(await kicked, KICK.DUPLICATE);
  assert.equal(b.welcome.nickCode, a.welcome.nickCode, 'same profile');
  b.close();
});

// ---------------- persistence across a real restart ----------------
function runServer(env) {
  const p = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/main.js')], { env: { ...process.env, ...env, LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', (d) => { if (/Error/.test(d)) process.stderr.write(d); });
  return p;
}
async function waitUp(p, port) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

test('persistence: money, ownership, position and vehicle survive a server restart', async () => {
  const p2 = 20000 + Math.floor(Math.random() * 2000);
  const env = { PORT: String(p2), HOST: '127.0.0.1', DB_PATH: path.join(tmp, 'persist.db'), WORKERS: '1', MAX_CONN_PER_IP: '64', START_MONEY: '60000' };
  let proc = runServer(env);
  try {
  await waitUp(proc, p2);
  const u = `ws://127.0.0.1:${p2}/ws`;
  const a = new TestClient(u);
  const w = await a.connect();
  // The tank is the only paid vehicle in the multiplayer garage.
  const sprig = a.modelIndex('tank');
  // earn a postcard, buy a car (persisted immediately), drive somewhere
  a.sendState({ x: 1728, y: 2, z: -733, model: a.modelIndex('pip') });
  await sleep(150);
  const wal = a.next(S_WALLET);
  a.claim({ reason: CLAIM.COLLECTIBLE, amount: 1, meta: 9, x: 1728, z: -733 });
  await wal;
  const ownedMsg = a.next(S_OWNED), econMsg = a.next(S_ECON); // both arrive in the same tick
  a.econ(ECON.BUY, sprig);
  assert.equal((await econMsg).result, ECON_RESULT.OK);
  await ownedMsg;
  let z = -733;
  for (let i = 0; i < 40; i++) { z -= 1; a.sendState({ x: 1728, y: 2, z, vz: -20, model: a.modelIndex('pip') }); await sleep(50); }
  const money = a.money;
  a.close();
  await sleep(300);
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('exit', r));
  proc = runServer(env);
  await waitUp(proc, p2);
  const b = new TestClient(u, { token: a.token });
  const w2 = await b.connect();
  await sleep(100);
  assert.equal(w2.nickCode, w.nickCode, 'same nickname');
  assert.equal(w2.money, money, 'same balance');
  assert.ok(w2.restore, 'restore data present');
  assert.ok(Math.abs(w2.restore.z - z) < 2 && Math.abs(w2.restore.x - 1728) < 1, `position restored (${w2.restore.x}, ${w2.restore.z})`);
  assert.equal(b.welcome.models[w2.restore.model - 1].id, 'pip', 'vehicle restored');
  assert.ok(b.owned.owned.includes(sprig), 'purchase persisted');
  b.claim({ reason: CLAIM.COLLECTIBLE, amount: 1, meta: 9, x: w2.restore.x, z: w2.restore.z });
  assert.equal((await b.next(S_WALLET)).result, WALLET.REJECTED, 'found collectibles persisted');
  b.close();
  } finally {
    if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r)); }
  }
});
