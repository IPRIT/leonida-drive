import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Economy } from '../src/economy.js';
import { netWorth } from '../../src/economy/rules.js';

const prices = new Map([
  ['pip', { price: 13900, starter: true }], ['kickflip', { price: 420, starter: true }],
  ['comet', { price: 46000, starter: false }],
]);
const record = (i, owned) => ({ hash: new Uint8Array(32).fill(i), nick: `fixture${i}`, nickCode: i, color: 0,
  money: 14000, x: 0, y: 1, z: 0, yaw: 0, mode: 1, vehicleId: 'pip', paint: 0, health: 1,
  createdAt: Date.now(), lastSeen: Date.now(), stats: { earned: 9000 }, flags: 0, owned, progress: { c: [3] },
  worth: 21876, garage: { inventory: { extinguisher: 1 } }, wardrobe: { own: { shirt: null } } });

test('new players have cash-only worth; paid sellable vehicles add their garage sale value', () => {
  const clothes = new Map([['shirt', { id: 'shirt', slot: 'top', price: 10000 }]]);
  const e = new Economy(record(1, ['pip', 'kickflip']), { prices, wardrobe: { byId: clothes } }, 0);
  assert.equal(e.worth(), 14000);
  e.owned.add('comet'); assert.equal(e.worth(), 39300);
  assert.equal(netWorth(14000, ['comet', 'comet', 'pip'], prices), 39300, 'duplicate inventory entries never double-count');
});

test('offline leaderboard revaluation is idempotent and preserves money, ownership, wardrobe and progress', () => {
  const s = new Store(':memory:');
  try {
    const a = record(1, ['pip', 'kickflip']), b = record(2, ['pip', 'kickflip', 'comet']);
    s.saveMany([a, b]);
    const before = s.load(a.hash);
    assert.equal(s.revalueWorth(prices), 2);
    assert.deepEqual(s.load(a.hash), { ...before, worth: 14000 });
    assert.equal(s.load(b.hash).worth, 39300);
    assert.equal(s.revalueWorth(prices), 0);
    const revised = new Map(prices); revised.set('comet', { price: 50000, starter: false });
    assert.equal(s.revalueWorth(revised), 1);
    assert.equal(s.load(b.hash).worth, 41500);
    assert.equal(s.load(a.hash).money, 14000);
  } finally { s.close(); }
});
