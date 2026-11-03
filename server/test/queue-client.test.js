// The browser's own NetClient (src/net/NetClient.js, Node's global WebSocket) against a real full server: it waits in
// line with status 'queued' and sends nothing, gets ADMIT then WELCOME and answers at once (keeps the place), can leave
// the line and rejoin at the back, and a reconnect to a full server mid-game queues while the game goes on offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { S_WELCOME } from '../../src/net/shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); } };

test('browser NetClient: queued → admitted → online, leave / rejoin, re-queue after a reconnect', { skip: typeof WebSocket === 'undefined' }, async () => {
  const { NetClient } = await import('../../src/net/NetClient.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-qc-'));
  const port = 26000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({
    port, host: '127.0.0.1', workers: 0, dbPath: path.join(tmp, 'q.db'), log: quiet, logLevel: 'error', maxConnPerIp: 64, connRatePerIp: 1000,
    capacity: 1, queueMax: 10, admitGraceMs: 3000, allowNoOrigin: true,
  });
  const url = `ws://127.0.0.1:${port}/ws`;
  let c = null;
  try {
    const holder = new TestClient(url);
    await holder.connect();
    const keep = setInterval(() => holder.sendState({ x: 1728, y: 2, z: -733 }), 500);
    // a browser client arrives: it waits in line, sending nothing
    c = new NetClient({ url });
    const statuses = [];
    c.on('status', (s) => statuses.push(s));
    c.connect();
    await until(() => c.status === 'queued');
    assert.equal(c.queue.position, 1); assert.equal(c.queue.capacity, 1);
    const out0 = c.bytesOut;
    await sleep(1200);
    assert.equal(c.bytesOut, out0, 'nothing is sent while waiting');
    // leave the line, then rejoin: a new place at the back (behind B, who came meanwhile)
    c.leaveQueue();
    assert.equal(c.status, 'idle');
    const B = new TestClient(url);
    assert.equal((await B.join()).queue.position, 1);
    c.rejoin();
    await until(() => c.status === 'queued');
    assert.equal(c.queue.position, 2, 'back of the line');
    // B gives up, then the holder leaves: the client is admitted and answers the WELCOME (keeps its place)
    B.close();
    await until(() => c.queue?.position === 1, 7000);
    clearInterval(keep);
    holder.close();
    await until(() => c.status === 'online', 6000);
    assert.ok(statuses.includes('queued') && statuses.indexOf('online') > statuses.lastIndexOf('queued'));
    await sleep(3600); // longer than the grace period
    assert.equal(c.status, 'online', 'answered the WELCOME: not timed out');
    // mid-game: the connection drops and the server is full again → queued, the game counts the wait as offline play
    const D = new TestClient(url);
    assert.equal((await D.join()).queue.position, 1);
    const dIn = D.next(S_WELCOME, () => true, 5000).catch(() => null);
    c.ws.close(); // connection lost: D gets the slot, c reconnects and finds the server full
    await dIn;
    await until(() => c.status === 'queued', 8000);
    assert.ok(c.offlineSince > 0, 'waiting after a reconnect counts as offline play');
    assert.equal(c.queue.position, 1);
    D.close();
    await until(() => c.status === 'online', 8000);
    c.close();
  } finally {
    c?.close(); // no reconnect timers left behind, whatever happened
    await srv.close();
  }
});
