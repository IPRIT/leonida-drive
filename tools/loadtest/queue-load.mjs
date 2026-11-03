#!/usr/bin/env node
// What queued players cost the server: a fresh server with MAX_PLAYERS=1 (one player holds it), N raw WebSocket clients
// that end up in the waiting queue, then: server CPU and memory while they idle, the cost of a churn (10 % leave from
// random places → position updates), and the bytes each queued client received.
//   node tools/loadtest/queue-load.mjs [--n 10000] [--idle 30] [--workers 2]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RawClient } from './rawws.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, l) => (s.startsWith('--') ? [...a, [s.slice(2), l[i + 1]]] : a), []));
const N = +(args.n ?? 10000), IDLE = +(args.idle ?? 30), PORT = +(args.port ?? 8796);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-ql-'));
const env = {
  ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(tmp, 'q.db'), MAX_PLAYERS: '1', QUEUE_MAX: String(N + 100),
  MAX_CONN_PER_IP: '1000000', CONN_RATE_PER_IP: '100000000', WORKERS: String(args.workers ?? 2), LOG_LEVEL: 'warn',
};
const server = spawn(process.execPath, [path.join(root, 'server/src/main.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
await sleep(2500);
const metrics = async () => {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text();
  const m = (k) => +(new RegExp(`^${k} ([\\d.e+-]+)`, 'm').exec(t)?.[1] ?? NaN);
  return { cpu: m('process_cpu_seconds_total'), rss: m('process_resident_memory_bytes'), heap: m('process_heap_used_bytes'), queue: m('leonida_queue_length'), admitted: m('leonida_admitted') };
};
const cpuOver = async (s) => { const a = await metrics(), t0 = performance.now(); await sleep(s * 1000); const b = await metrics(); return { pct: ((b.cpu - a.cpu) / ((performance.now() - t0) / 1000)) * 100, m: b }; };
const url = `ws://127.0.0.1:${PORT}/ws`;
const holder = new RawClient(url);
await holder.connect();
if (global.gc) global.gc();
const base = await cpuOver(5);
console.log(`baseline: server CPU ${base.pct.toFixed(2)} %, RSS ${(base.m.rss / 1048576).toFixed(0)} MB, admitted ${base.m.admitted}`);
// N clients join the queue (≈ 2,000 per second)
const cs = [];
let failed = 0;
const t0 = performance.now();
for (let i = 0; i < N; i += 100) {
  await Promise.all(Array.from({ length: Math.min(100, N - i) }, async () => {
    const c = new RawClient(url);
    try { const r = await c.connect(20000); if (r.queue) cs.push(c); else failed++; } catch { failed++; }
  }));
  await sleep(40);
}
console.log(`queued ${cs.length} in ${((performance.now() - t0) / 1000).toFixed(1)} s (failed ${failed})`);
await sleep(3000);
const idle = await cpuOver(IDLE);
const perK = (idle.m.rss - base.m.rss) / (cs.length / 1000), heapK = (idle.m.heap - base.m.heap) / (cs.length / 1000);
console.log(`idle with ${idle.m.queue} queued: server CPU ${idle.pct.toFixed(2)} %, RSS ${(idle.m.rss / 1048576).toFixed(0)} MB (${(perK / 1024).toFixed(0)} KB per 1k queued), JS heap of the main thread +${(heapK / 1024).toFixed(0)} KB per 1k (all of it with --workers 0)`);
const msgs0 = cs.reduce((a, c) => a + (c.queueMsgs || 0), 0);
// churn: 10 % leave from random places (page refreshes): everyone behind them moves up
const leave = new Set();
while (leave.size < Math.floor(cs.length / 10)) leave.add(Math.floor(Math.random() * cs.length));
for (const i of leave) cs[i].terminate();
const churn = await cpuOver(10);
const msgs1 = cs.reduce((a, c, i) => a + (leave.has(i) ? 0 : c.queueMsgs || 0), 0);
console.log(`churn (${leave.size} left): server CPU over 10 s ${churn.pct.toFixed(2)} %, QUEUE updates sent ${msgs1 - msgs0} (${((msgs1 - msgs0) * 18 / (cs.length - leave.size)).toFixed(0)} B per remaining client), queue ${churn.m.queue}`);
const out = { n: cs.length, baseCpuPct: +base.pct.toFixed(2), idleCpuPct: +idle.pct.toFixed(2), rssPer1kKB: Math.round(perK / 1024), heapPer1kKB: Math.round(heapK / 1024), churnCpuPct: +churn.pct.toFixed(2), updates: msgs1 - msgs0 };
console.log(JSON.stringify(out));
for (const c of cs) c.terminate();
holder.terminate();
server.kill('SIGTERM');
await sleep(1500);
process.exit(0);
