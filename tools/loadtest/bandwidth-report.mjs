#!/usr/bin/env node
// Before/after bandwidth report: starts a fresh server (port 8790, temp DB), then for each scenario starts bots,
// lets them settle, and runs wire-meter.mjs for an observer parked in the middle. Prints one JSON line per scenario.
//
//   node tools/loadtest/bandwidth-report.mjs [--seconds 30] [--only typical,crowd,idle,empty] [--out file.json] [--dump dir]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, l) => (s.startsWith('--') ? [...a, [s.slice(2), l[i + 1]?.startsWith('--') || l[i + 1] === undefined ? '1' : l[i + 1]]] : a), []));
const SECONDS = +(args.seconds ?? 30);
const PORT = +(args.port ?? 8790);
const CX = 1745, CZ = -640;
const SCENARIOS = {
  // ~200 players over a 4 km radius around the observer: a few in view, a few dozen on the radar
  typical: [{ count: 200, radius: 4000 }],
  // 60 players driving within 300 m of the observer
  crowd: [{ count: 60, radius: 300 }],
  // 60 players parked within 300 m (and the observer parked): idle
  idle: [{ count: 60, radius: 300, park: true }],
  // nobody around: what an idle player costs on its own
  empty: [],
};
const only = args.only ? args.only.split(',') : Object.keys(SCENARIOS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-bw-'));
const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'bw.db'), JOIN_ANYWHERE: '1', MAX_PLAYERS: '100000', MAX_CONN_PER_IP: '100000', CONN_RATE_PER_IP: '100000000', WORKERS: '2', LOG_LEVEL: 'warn' };
const server = spawn(process.execPath, [path.join(root, 'server/src/main.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
await sleep(2500);
const metrics = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text(); } catch { return ''; } };
const cpu = (txt) => +(/process_cpu_seconds_total ([\d.e+-]+)/.exec(txt)?.[1] ?? NaN);

const results = {};
for (const name of only) {
  const bots = SCENARIOS[name].map((s) => spawn(process.execPath, [path.join(here, 'bots.js'), '--url', `ws://127.0.0.1:${PORT}/ws`, '--count', String(s.count),
    '--procs', '1', '--cx', String(CX), '--cz', String(CZ), '--radius', String(s.radius), '--ramp', '400', ...(s.park ? ['--park'] : [])], { stdio: 'ignore' }));
  await sleep(8000);
  const m0 = await metrics(), t0 = performance.now();
  const dump = args.dump ? ['--dump', path.join(args.dump, `${name}.bin`)] : [];
  if (args.dump) fs.mkdirSync(args.dump, { recursive: true });
  const out = execFileSync(process.execPath, [path.join(here, 'wire-meter.mjs'), '--url', `ws://127.0.0.1:${PORT}/ws`, '--x', String(CX), '--z', String(CZ), '--seconds', String(SECONDS), '--json', ...dump], { encoding: 'utf8' });
  const m1 = await metrics(), dt = (performance.now() - t0) / 1000;
  const r = JSON.parse(out.trim().split('\n').pop());
  r.serverCpuPct = +(((cpu(m1) - cpu(m0)) / dt) * 100).toFixed(0);
  results[name] = r;
  console.log(JSON.stringify({ scenario: name, wireBps: r.wireBps, payloadBps: r.payloadBps, wsFramingBps: r.wsFramingBps, tlsTcpBps: r.tlsTcpBps, msgsPerS: r.msgsPerS, burstsPerS: r.burstsPerS, recordsPerS: r.recordsPerS, serverCpuPct: r.serverCpuPct, byType: r.byType.slice(0, 6) }));
  for (const b of bots) b.kill('SIGTERM');
  await sleep(2500);
}
server.kill('SIGTERM');
await sleep(1500);
if (args.out) fs.writeFileSync(args.out, JSON.stringify(results, null, 1));
process.exit(0);
