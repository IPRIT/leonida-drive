#!/usr/bin/env node
// Smoothness report (mean of 8 seeded runs per scenario) on the real hub + client RemoteStore (test/netsim.js):
// p99 / max position error vs truth, p99 / max excess acceleration (jitter), snaps (a frame's step off the true step by
// > 25 cm), teleports, records/s, uploads/s and the interpolation delay.
//   node server/tools/smoothness-report.mjs [--up full] [--out file.json]
import fs from 'node:fs';
import { simulate } from '../test/netsim.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, l) => (s.startsWith('--') ? [...a, [s.slice(2), l[i + 1]]] : a), []));
const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
const SC = {
  clean: {}, tcp5: { loss: 0.05, jitter: 30, tcp: true }, tcp15: { loss: 0.15, jitter: 60, tcp: true },
  drop5: { loss: 0.05, jitter: 30, reorder: 0.05 }, drop15: { loss: 0.15, jitter: 60, reorder: 0.1 },
  crash: { crashAt: 9, loss: 0.02, jitter: 20 }, crashTcp: { crashAt: 9, loss: 0.02, jitter: 20, tcp: true },
};
const out = {};
for (const [k, o] of Object.entries(SC)) {
  const rs = seeds.map((seed) => simulate({ ...o, seed, uplink: args.up || 'dev' }));
  const mean = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length, mx = (f) => Math.max(...rs.map(f));
  const a = out[k] = {
    p99Err: mean((r) => r.p99Err), maxErr: mx((r) => r.maxErr), p99Acc: mean((r) => r.p99Acc), maxAcc: mx((r) => r.maxAcc), maxStep: mx((r) => r.maxStep),
    snaps: rs.reduce((s, r) => s + r.snaps, 0), teleports: rs.reduce((s, r) => s + r.teleports, 0), recS: mean((r) => r.recordsPerSec), upS: mean((r) => r.upPerSec), delay: mean((r) => r.delay),
  };
  console.log(k.padEnd(9), `p99Err ${a.p99Err.toFixed(3)} maxErr ${a.maxErr.toFixed(2)} p99Acc ${a.p99Acc.toFixed(1)} maxAcc ${a.maxAcc.toFixed(0)} snaps ${a.snaps} tp ${a.teleports} rec/s ${a.recS.toFixed(1)} up/s ${a.upS.toFixed(1)} delay ${a.delay.toFixed(0)}`);
}
if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
