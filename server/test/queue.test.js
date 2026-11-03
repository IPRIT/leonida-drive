// Waiting queue: FIFO order, positions after departures, admission, the grace period of an admitted client, the queue
// cap ("server full"), the public /status counters, and that queued connections cost no per-tick work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { S_QUEUE, S_ADMIT, S_WELCOME, KICK } from '../../src/net/shared/constants.js';
import * as Q from '../src/queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };

test('queue: FIFO order, O(log n) positions after departures, admission in order, capacity accounting', () => {
  const q = Q.queueViews(Q.createQueueShared());
  const cap = 2;
  assert.deepEqual(Q.enter(q, 0, cap, 100), { admitted: true });
  assert.deepEqual(Q.enter(q, 0, cap, 100), { admitted: true });
  const t = [];
  for (let i = 0; i < 6; i++) t.push(Q.enter(q, i % 3, cap, 100).ticket);
  assert.deepEqual(t.map((x) => Q.position(q, x)), [1, 2, 3, 4, 5, 6]);
  Q.leave(q, t[1]); Q.leave(q, t[3]); // two leave from the middle
  assert.deepEqual(t.map((x) => Q.position(q, x)), [1, 0, 2, 0, 3, 4]);
  assert.equal(Q.leave(q, t[1]), false, 'leaving twice is a no-op');
  const got = [];
  assert.equal(Q.admit(q, cap, (g, tk) => got.push(tk)), 0, 'full: nobody admitted');
  Q.release(q); // one player left the world
  assert.equal(Q.admit(q, cap, (g, tk) => got.push([g, tk])), 1);
  assert.deepEqual(got, [[0, t[0]]], 'the head (and its gateway) first');
  assert.deepEqual(t.map((x) => Q.position(q, x)), [0, 0, 1, 0, 2, 3]);
  // a newcomer queues behind everyone even when a slot is free right now (no jumping the line)
  Q.release(q);
  const late = Q.enter(q, 1, cap, 100);
  assert.ok(late.ticket !== undefined, 'queued, not admitted');
  Q.admit(q, cap, (g, tk) => got.push([g, tk]));
  assert.deepEqual(got.at(-1), [2, t[2]]);
  assert.equal(Q.position(q, late.ticket), 3);
  // a departure racing with the admission is resolved once
  Q.release(q);
  assert.equal(Q.leave(q, t[4]), true);
  Q.admit(q, cap, (g, tk) => got.push([g, tk]));
  assert.deepEqual(got.at(-1), [2, t[5]], 'the departed ticket is skipped');
  assert.equal(Q.leave(q, t[5]), false, 'an admitted ticket cannot leave the queue (its session releases capacity instead)');
  const st = Q.stats(q);
  assert.equal(st.waiting, 1); assert.equal(st.active, 2); assert.equal(st.admitted, 3);
});

test('queue: the cap refuses newcomers ("server full"), the ring never wraps onto a waiting ticket', () => {
  const q = Q.queueViews(Q.createQueueShared());
  for (let i = 0; i < 3; i++) Q.enter(q, 0, 0, 3);
  assert.deepEqual(Q.enter(q, 0, 0, 3), { full: true });
  assert.equal(Q.stats(q).rejected, 1);
  // a long-waiting head while tens of thousands come and go: refused near the ring size instead of corrupting it
  const q2 = Q.queueViews(Q.createQueueShared());
  const head = Q.enter(q2, 0, 0, 1e9).ticket;
  let refused = 0;
  for (let i = 0; i < Q.QRING + 10; i++) {
    const r = Q.enter(q2, 0, 0, 1e9);
    if (r.full) refused++; else Q.leave(q2, r.ticket);
  }
  assert.ok(refused > 0, 'refused near the ring size');
  assert.equal(Q.position(q2, head), 1, 'the waiting head is intact');
  // positions stay O(log n): 20k waiting, a position query is a few dozen array reads
  const q3 = Q.queueViews(Q.createQueueShared());
  const ts = [];
  for (let i = 0; i < 20000; i++) ts.push(Q.enter(q3, 0, 0, 20000).ticket);
  for (let i = 0; i < 20000; i += 2) Q.leave(q3, ts[i]);
  const t0 = performance.now();
  let s = 0;
  for (let i = 1; i < 20000; i += 2) s += Q.position(q3, ts[i]);
  const us = ((performance.now() - t0) * 1000) / 10000;
  assert.equal(s, (10000 * 10001) / 2, 'positions 1..10000 after every other one left');
  assert.ok(us < 20, `position query ${us.toFixed(2)} µs`);
});

test('server: queue when full, QUEUE updates, admission with WELCOME, grace period, queue cap, /status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-q-'));
  const port = 24000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({
    port, host: '127.0.0.1', workers: 0, dbPath: path.join(tmp, 'q.db'), log: quiet, logLevel: 'error', maxConnPerIp: 64, connRatePerIp: 1000,
    capacity: 2, queueMax: 3, admitGraceMs: 3000,
  });
  const url = `ws://127.0.0.1:${port}/ws`;
  const status = async () => (await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: 'http://localhost:5320' } }));
  try {
    const A = new TestClient(url), B = new TestClient(url);
    assert.ok((await A.join()).welcome); assert.ok((await B.join()).welcome);
    const C = new TestClient(url), D = new TestClient(url), E = new TestClient(url);
    const qc = await C.join(), qd = await D.join(), qe = await E.join();
    assert.deepEqual([qc.queue.position, qd.queue.position, qe.queue.position], [1, 2, 3]);
    assert.equal(qe.queue.waiting, 3); assert.equal(qe.queue.capacity, 2);
    // the queue cap: a clear "full" kick, not a hang
    const F = new TestClient(url);
    await assert.rejects(F.join(), (e) => e.code === KICK.FULL);
    // /status: counters, cacheable, CORS for the game's origin
    const r = await status();
    assert.equal(r.headers.get('cache-control'), 'public, max-age=5');
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5320');
    assert.deepEqual(await r.json(), { ok: true, online: 2, queue: 3, capacity: 2 });
    const evil = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    // D leaves (page refresh): E moves up, and only E is told (within a 4 s slice)
    const eMoved = E.next(S_QUEUE, (q) => q.position === 2, 6000);
    D.close();
    assert.equal((await eMoved).position, 2);
    // A leaves the world: C (head) is admitted on the same socket: ADMIT, then WELCOME
    const cAdmit = C.next(S_ADMIT, () => true, 3000), cWelcome = C.next(S_WELCOME, () => true, 5000);
    A.close();
    await cAdmit;
    assert.ok((await cWelcome).netId > 0);
    assert.equal(E.queue.position <= 2, true);
    // C never answers its WELCOME (no message at all): after the 3 s grace its slot goes to E
    const eWelcome = E.next(S_WELCOME, () => true, 9000);
    const cKick = new Promise((res) => C.on('close', res));
    assert.ok((await eWelcome).netId > 0, 'E admitted after C timed out');
    await cKick;
    assert.equal(C.kick, KICK.TIMEOUT);
    // E answers (any message): it keeps its place in the world
    E.ping(1);
    await sleep(3500);
    assert.equal(E.closed, false, 'an admitted client that answered stays');
    const s2 = await (await status()).json();
    assert.equal(s2.online, 2); assert.equal(s2.queue, 0);
    // capacity is released on close: a newcomer gets straight in again
    B.close();
    await sleep(200);
    const G = new TestClient(url);
    assert.ok((await G.join()).welcome);
    E.close(); G.close();
  } finally {
    await srv.close();
  }
});
