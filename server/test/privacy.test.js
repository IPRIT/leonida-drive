// Privacy: client IPs are never logged or stored in full (IPv4 → /24, IPv6 → /48, plus a keyed tag that rotates
// daily), tokens never reach the logs, and retention removes old security-log rows and never-progressed profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/server.js';
import { Store } from '../src/db.js';
import { maskIp, ipTag, ipForLog, setIpSecret } from '../src/privacy.js';
import { TestClient } from '../tools/client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('IP masking: IPv4 → /24, IPv6 → /48, mapped IPv4 as IPv4, junk → ?', () => {
  assert.equal(maskIp('203.0.113.77'), '203.0.113.0/24');
  assert.equal(maskIp(' 198.51.100.9 '), '198.51.100.0/24');
  assert.equal(maskIp('::ffff:198.51.100.9'), '198.51.100.0/24');
  assert.equal(maskIp('0000:0000:0000:0000:0000:ffff:c633:6409'), '198.51.100.0/24', 'uWS prints IPv6 in full');
  assert.equal(maskIp('2001:db8:abcd:12::1'), '2001:db8:abcd::/48');
  assert.equal(maskIp('2001:0db8:abcd:0012:0000:0000:0000:0001'), '2001:db8:abcd::/48');
  assert.equal(maskIp('[2001:db8:abcd:ff::7]'), '2001:db8:abcd::/48');
  assert.equal(maskIp('fe80::1%eth0'), 'fe80:0:0::/48');
  for (const bad of ['', 'garbage', '1.2.3.256', '1.2.3', ':::', '2001:db8::1::2', null, undefined, 42]) assert.equal(maskIp(bad), '?', String(bad));
  for (const ip of ['203.0.113.77', '2001:db8:abcd:12::1']) assert.ok(!ipForLog(ip).includes(ip), 'the log form never contains the address');
});

test('IP tags: keyed, stable within a UTC day, unlinkable across days', () => {
  setIpSecret('test-secret-1');
  const d1 = Date.UTC(2026, 10, 3, 0, 5), d1b = Date.UTC(2026, 10, 3, 23, 55), d2 = Date.UTC(2026, 10, 4, 0, 5);
  const a = ipTag('203.0.113.77', d1);
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(ipTag('203.0.113.77', d1b), a, 'same day, same tag (abuse correlation)');
  assert.notEqual(ipTag('203.0.113.77', d2), a, 'next day, new tag');
  assert.notEqual(ipTag('203.0.113.78', d1), a, 'a neighbour in the same /24 has another tag');
  setIpSecret('test-secret-2');
  assert.notEqual(ipTag('203.0.113.77', d1), a, 'the tag depends on the server secret');
  // without the secret a tag cannot be recomputed: brute-forcing all IPv4 addresses needs the key
  const unkeyed = crypto.createHash('sha256').update('203.0.113.77').digest('hex').slice(0, 10);
  assert.notEqual(a, unkeyed);
});

test('logs and the security log never contain a full IP or a token; retention runs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-privacy-'));
  const dbPath = path.join(tmp, 'p.db');
  const lines = [];
  const cap = { info: (s) => lines.push(String(s)), warn: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)), debug: (s) => lines.push(String(s)) };
  const port = 20000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({ port, host: '127.0.0.1', workers: 0, dbPath, log: cap, logLevel: 'debug', maxConnPerIp: 64, connRatePerIp: 1000, ipHashSecret: 'k' });
  const url = `ws://127.0.0.1:${port}/ws`;
  const tokens = [];
  try {
    // a cheater: teleports until frozen and kicked (security log: freeze + kick)
    const a = new TestClient(url);
    await a.connect();
    tokens.push(Buffer.from(a.token).toString('hex'));
    a.sendState({ x: 1728, y: 2, z: -733, model: a.modelIndex('pip') });
    await sleep(150);
    let z = -733;
    for (let i = 0; i < 60 && !a.closed; i++) { z -= 400; a.sendState({ x: 1728, y: 2, z, vz: -60, model: a.modelIndex('pip') }); await sleep(25); }
    await sleep(300);
    // garbage: text frames get the connection kicked (gateway kick log line)
    const b = new TestClient(url);
    await b.connect();
    tokens.push(Buffer.from(b.token).toString('hex'));
    for (let i = 0; i < 6; i++) b.ws.send('{"hack":true}');
    await sleep(300);
  } finally {
    await srv.close();
  }
  const sec = lines.filter((l) => /\[security\]| kick /.test(l));
  assert.ok(sec.length >= 2, `security / kick lines were logged (${sec.length})`);
  for (const l of sec) assert.match(l, /net=127\.0\.0\.0\/24 ipk=[0-9a-f]{10}/, l);
  const hashes = tokens.map((t) => crypto.createHash('sha256').update(Buffer.from(t, 'hex')).digest('hex'));
  for (const l of lines) {
    if (/^listening on /.test(l) || /listening on 127\.0\.0\.1:/.test(l)) continue; // the server's own bind address
    assert.ok(!l.includes('127.0.0.1'), `no full client IP in the log: ${l}`);
    for (const t of [...tokens, ...hashes]) assert.ok(!l.includes(t) && !l.includes(t.slice(0, 16)), `no token / token hash in the log: ${l}`);
  }
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT kind, detail FROM security_log').all();
  assert.ok(rows.length >= 1, 'the security log has rows');
  for (const r of rows) {
    assert.ok(!String(r.detail).includes('127.0.0.1'), `no full IP stored: ${r.detail}`);
    assert.match(String(r.detail), /net=127\.0\.0\.0\/24 ipk=[0-9a-f]{10}/);
  }
  // nothing else that identifies a person is stored: the players table has no address-like column
  const cols = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
  for (const c of cols) assert.ok(!/ip|addr|email|phone/i.test(c), `column ${c}`);
  db.close();
});

test('retention: security log after 30 days, never-progressed profiles after 180 days', () => {
  const s = new Store(':memory:');
  const now = Date.UTC(2026, 10, 3), day = 864e5;
  s.log(null, 'kick', 'old'); s.log(null, 'kick', 'new');
  s.db.prepare("UPDATE security_log SET ts = ? WHERE detail = 'old'").run(now - 31 * day);
  s.db.prepare("UPDATE security_log SET ts = ? WHERE detail = 'new'").run(now - 29 * day);
  const rec = (hash, o) => ({
    hash, nick: 'n', nickCode: 1, color: 1, money: 5000, x: 0, y: 0, z: 0, yaw: 0, mode: 1, vehicleId: '', paint: 0, health: 1,
    createdAt: now - 400 * day, lastSeen: now - 181 * day, stats: { claims: 0, earned: 0 }, flags: 0, owned: [], progress: {}, worth: 5000, garage: {}, wardrobe: {}, ...o,
  });
  const h = (n) => new Uint8Array(32).fill(n);
  s.saveMany([
    rec(h(1)), // stale, never progressed → removed
    rec(h(2), { stats: { claims: 3, earned: 1200 }, money: 6200 }), // progressed → kept
    rec(h(3), { lastSeen: now - 10 * day }), // recent → kept
    rec(h(4), { flags: 1 }), // flagged (frozen) → kept with its flag
  ]);
  assert.equal(s.pruneLog(30 * day, now), 1);
  assert.deepEqual(s.db.prepare('SELECT detail FROM security_log').all().map((r) => r.detail), ['new']);
  assert.equal(s.pruneStale(180 * day, 5000, now), 1);
  assert.equal(s.load(h(1)), null);
  assert.ok(s.load(h(2)) && s.load(h(3)) && s.load(h(4)));
});
