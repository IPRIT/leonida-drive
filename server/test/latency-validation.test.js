import test from 'node:test';
import assert from 'node:assert/strict';
import { Movement, V_OK, V_TELEPORT } from '../src/validate.js';
import { VCLASS } from '../../src/net/shared/constants.js';
import { simulate, fmt } from './netsim.js';

const state = (x) => ({ x, z: 0, y: 2, yaw: -Math.PI / 2, vx: 90, vy: 0, vz: 0, flags: 0 });
test('latest-only upload after 3–30 second outages is accepted without banking the unused outage time', () => {
  for (const seconds of [3, 8, 15, 30]) {
    const m = new Movement({ heightAt: () => 0 });
    m.setClass(VCLASS.CAR, 100, 0); m.place(0, 2, 0, 0, 0);
    assert.equal(m.check(state(seconds * 90), seconds * 1000), V_OK);
    assert.equal(m.check(state(seconds * 90 + 4.5), seconds * 1000 + 50), V_OK);
    assert.equal(m.check(state(seconds * 90 + 1000), seconds * 1000 + 100), V_TELEPORT);
  }
});
test('rejected uploads cannot repeatedly credit the same elapsed time', () => {
  const m = new Movement({ heightAt: () => 0 });
  m.setClass(VCLASS.CAR, 100, 0); m.place(0, 2, 0, 0, 0);
  for (let i=0;i<100;i++) assert.equal(m.check(state(200), 50), V_TELEPORT);
  assert.equal(m.budget, 0);
});
test('1.5 second round trip with jitter and TCP retransmissions remains continuous', () => {
  const r = simulate({ upLatency: 750, downLatency: 750, jitter: 150, loss: .1, tcp: true, seconds: 45, seed: 4 });
  console.log(`  1500 ms RTT ${fmt(r)}`);
  assert.equal(r.teleports, 0); assert.equal(r.snaps, 0);
  assert.ok(r.maxStep < 2, `per-frame displacement ${r.maxStep}`);
  assert.ok(r.p99Err < 15, `prediction error ${r.p99Err}`);
});
test('latency rising during play never rewinds the interpolation timeline or teleports a car', () => {
  const r = simulate({ latencyAt: 12, latencyExtra: 700, jitter: 80, loss: .05, tcp: true, seconds: 45, seed: 7 });
  console.log(`  latency spike ${fmt(r)}`);
  // Unknown turns during the gap necessarily differ from truth; that is tracking
  // error, not a discontinuity. Check visible steps, acceleration and time direction.
  assert.equal(r.teleports,0);assert.equal(r.rewinds,0);
  assert.ok(r.maxStep<1, `visible step ${r.maxStep}`);
  assert.ok(r.p99Acc<60, `excess acceleration ${r.p99Acc}`);
});
