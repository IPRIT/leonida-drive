// A player whose tab goes to the background stops sending states (rAF stops) but keeps its socket. They must stay in
// the world for the others — frozen, flagged away (AFK badge) — on foot or in a parked car, and continue seamlessly
// when they come back (same netId, no "gone", no teleport). Regression: the server used to hide them after 5 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { S_CELL, S_INFO, S_CORRECTION, VIS } from '../../src/net/shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };

test('a backgrounded player stays visible (frozen, away) and comes back seamlessly — on foot and in a parked car', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-away-'));
  const port = 28000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({ port, host: '127.0.0.1', workers: 0, dbPath: path.join(tmp, 'a.db'), log: quiet, logLevel: 'error', maxConnPerIp: 64, connRatePerIp: 1000 });
  const url = `ws://127.0.0.1:${port}/ws`;
  const clients = [];
  let keepB = null;
  try {
    const A = new TestClient(url), C = new TestClient(url), B = new TestClient(url);
    clients.push(A, B, C);
    await A.connect(); await C.connect(); await B.connect();
    const pip = C.modelIndex('pip');
    const gone = new Set();
    B.on(S_CELL, (m) => { for (const g of m.gone) gone.add(g.id); });
    keepB = setInterval(() => B.sendState({ x: 1730, y: 2, z: -735 }), 100);
    // A on foot, C in a parked car, both active for a second, then their tabs go to the background
    for (let i = 0; i < 10; i++) { A.sendState({ x: 1728, y: 2, z: -733 }); C.sendState({ x: 1726, y: 2, z: -738, model: pip }); await sleep(100); }
    C.vis(VIS.AWAY, Uint8Array.of(1)); // C's page says so explicitly; A just goes silent
    const info = async (id) => {
      const p = B.next(S_INFO, (l) => l.some((i) => i.netId === id), 3000);
      B.infoReq([id]);
      return (await p).find((i) => i.netId === id);
    };
    await sleep(500);
    assert.equal((await info(C.welcome.netId)).away, true, 'explicit away is shown at once');
    await sleep(11000); // well past the old 5 s hide
    assert.ok(!gone.has(A.welcome.netId), 'the silent player is still in the world');
    assert.ok(!gone.has(C.welcome.netId), 'the parked car is still in the world');
    const ra = B.records.get(A.welcome.netId), rc = B.records.get(C.welcome.netId);
    assert.ok(ra && rc, 'both are known to the observer');
    assert.ok(Math.hypot(ra.vx, ra.vz) < 0.01 && Math.hypot(rc.vx, rc.vz) < 0.01, 'frozen (no extrapolation)');
    assert.equal(rc.model, pip, 'still in the car');
    assert.equal((await info(A.welcome.netId)).away, true, 'silence alone marks away after 5 s');
    // back: the next state clears it; same session, nothing left, no correction
    let corrected = false;
    A.on(S_CORRECTION, () => { corrected = true; });
    for (let i = 0; i < 5; i++) { A.sendState({ x: 1728, y: 2, z: -733 }); await sleep(60); }
    C.vis(VIS.AWAY, Uint8Array.of(0));
    for (let i = 0; i < 5; i++) { C.sendState({ x: 1726, y: 2, z: -738, model: pip }); await sleep(60); }
    await sleep(300);
    assert.equal((await info(A.welcome.netId)).away, false);
    assert.equal((await info(C.welcome.netId)).away, false);
    assert.ok(!gone.has(A.welcome.netId) && !gone.has(C.welcome.netId) && !A.closed && !C.closed && !corrected);
    clearInterval(keepB);
    A.close(); B.close(); C.close();
  } finally {
    clearInterval(keepB);
    for (const c of clients) c.close();
    await srv.close();
  }
});
