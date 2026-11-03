// Join/leave events are interest-scoped: only the players near the cell where someone appears or leaves get them.
// At 1000+ online a global join/leave feed would cost every client traffic for people it never sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { S_EVENT, SE_JOIN, SE_LEAVE } from '../../src/net/shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };

test('join/leave events reach only nearby players, never the whole server', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-events-'));
  const port = 30000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({ port, host: '127.0.0.1', workers: 0, dbPath: path.join(tmp, 'e.db'), log: quiet, logLevel: 'error', maxConnPerIp: 64, connRatePerIp: 1000, joinAnywhere: true });
  const url = `ws://127.0.0.1:${port}/ws`;
  const clients = [];
  const timers = [];
  try {
    const NEAR = { x: 1730, y: 2, z: -735 }, FAR = { x: 1730, y: 2, z: -735 + 2600 };
    const B = new TestClient(url), F = new TestClient(url);
    clients.push(B, F);
    await B.connect(); await F.connect();
    const evB = [], evF = [];
    B.on(S_EVENT, (e) => evB.push(e));
    F.on(S_EVENT, (e) => evF.push(e));
    timers.push(setInterval(() => { B.sendState(NEAR); F.sendState(FAR); }, 100));
    await sleep(800);
    const J = new TestClient(url);
    clients.push(J);
    await J.connect();
    const jid = J.welcome.netId;
    for (let i = 0; i < 10; i++) { J.sendState({ x: 1728, y: 2, z: -733 }); await sleep(100); }
    J.close();
    await sleep(800);
    const kinds = (l) => l.filter((e) => e.netId === jid).map((e) => e.kind);
    assert.deepEqual(kinds(evB), [SE_JOIN, SE_LEAVE], 'the nearby player sees the join and the leave');
    assert.deepEqual(kinds(evF), [], 'a player 2.6 km away gets nothing');
  } finally {
    for (const t of timers) clearInterval(t);
    for (const c of clients) c.close();
    await srv.close();
  }
});
