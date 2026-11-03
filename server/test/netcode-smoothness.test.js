// End-to-end netcode smoothness (simulation in netsim.js): tracking error and continuity of a remote car under a
// clean network, dropped messages, TCP-style retransmissions, a crash and a teleport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, fmt } from './netsim.js';

test('clean network: tracks the truth closely and smoothly', () => {
  const r = simulate({ seed: 7 });
  console.log(`  clean      ${fmt(r)}`);
  assert.ok(r.frames > 1000);
  assert.ok(r.p99Err < 0.2, `p99 error ${r.p99Err}`);
  assert.ok(r.maxErr < 0.5, `max error ${r.maxErr}`);
  // rendered acceleration minus the true path's own acceleration: a snap or a velocity step would spike here
  // (25 m/s² over one 60 fps frame = 7 mm of deviation)
  assert.ok(r.maxAcc < 25, `max excess acceleration ${r.maxAcc}`);
  assert.ok(r.maxStep < 0.8, `max per-frame step ${r.maxStep}`);
  assert.ok(r.recordsPerSec < 12, `records/s ${r.recordsPerSec} (error-driven sending should beat 20 Hz)`);
});

test('5% loss, 30 ms jitter, reordering: still continuous, no teleports', () => {
  const r = simulate({ loss: 0.05, jitter: 30, reorder: 0.05, seed: 11 });
  console.log(`  lossy      ${fmt(r)}`);
  assert.ok(r.p99Err < 0.6, `p99 error ${r.p99Err}`);
  assert.ok(r.maxErr < 1.0, `max error ${r.maxErr}`);
  assert.ok(r.maxAcc < 60, `max excess acceleration ${r.maxAcc}`);
  assert.ok(r.p99Acc < 30, `p99 excess acceleration ${r.p99Acc}`);
  assert.ok(r.maxStep < 0.9, `max per-frame step ${r.maxStep}`);
});

test('heavy conditions (15% dropped messages, 60 ms jitter) degrade gracefully (mean of 6 runs)', () => {
  const rs = [1, 2, 3, 4, 5, 6].map((seed) => simulate({ loss: 0.15, jitter: 60, reorder: 0.1, seed }));
  const mean = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  console.log(`  heavy      ${fmt(rs[4])} (one run); mean p99Err ${mean((r) => r.p99Err).toFixed(3)} m, mean p99 acc ${mean((r) => r.p99Acc).toFixed(1)} m/s²`);
  for (const r of rs) assert.ok(r.maxStep < 1.0, `max per-frame step ${r.maxStep}`);
  assert.ok(mean((r) => r.p99Err) < 0.7, `mean p99 error ${mean((r) => r.p99Err)}`);
  assert.ok(mean((r) => r.p99Acc) < 30, `mean p99 excess acceleration ${mean((r) => r.p99Acc)}`);
});

test('TCP-like loss (5% of segments retransmitted, head-of-line blocking): continuous, no snaps', () => {
  const r = simulate({ loss: 0.05, jitter: 30, tcp: true, seed: 11 });
  console.log(`  tcp 5%     ${fmt(r)}`);
  assert.ok(r.maxStep < 0.9, `max per-frame step ${r.maxStep}`);
  assert.ok(r.p99Err < 0.5, `p99 error ${r.p99Err}`);
  assert.equal(r.snaps, 0);
});

test('server-approved teleport plays a dissolve instead of sliding across the map', () => {
  const r = simulate({ seed: 3, teleportAt: 12 });
  console.log(`  teleport   ${fmt(r)} dissolve=${r.sawDissolve}`);
  assert.ok(r.sawDissolve, 'dissolve played');
  assert.ok(r.maxStep < 0.9, `no slide: max per-frame step while visible ${r.maxStep}`);
});

test('a crash (speed lost in 60 ms, spin) is followed without a snap', () => {
  const r = simulate({ seed: 9, crashAt: 9, loss: 0.02, jitter: 20 });
  console.log(`  crash      ${fmt(r)}`);
  assert.ok(r.maxStep < 0.9, `max per-frame step ${r.maxStep}`);
  assert.ok(r.p99Err < 0.6, `p99 error ${r.p99Err}`);
  assert.equal(r.teleports, 0);
});

test('uplink on deviation: same smoothness as uploading every 20 Hz sample, far fewer uploads', () => {
  const dev = simulate({ seed: 7 }), full = simulate({ seed: 7, uplink: 'full' });
  console.log(`  uplink dev ${fmt(dev)}`);
  console.log(`  uplink 20Hz${fmt(full)}`);
  assert.ok(dev.upPerSec < full.upPerSec * 0.8, `uploads ${dev.upPerSec}/s vs ${full.upPerSec}/s`);
  assert.ok(dev.p99Err < full.p99Err + 0.05, `p99 error ${dev.p99Err} vs ${full.p99Err}`);
  assert.ok(dev.p99Acc < full.p99Acc + 3, `p99 excess acceleration ${dev.p99Acc} vs ${full.p99Acc}`);
  assert.equal(dev.snaps, 0);
});
