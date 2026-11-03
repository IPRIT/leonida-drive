#!/usr/bin/env node
// Load test / lab traffic: spawns bot processes that drive real roads and talk the real protocol.
//
//   node tools/loadtest/bots.js --count 30 --cx 1745 --cz -640 --radius 300            # a few bots near the spawn (lab)
//   node tools/loadtest/bots.js --count 10000 --procs 8 --radius 6000 --duration 90    # load test
//
// Options: --url ws://127.0.0.1:8787/ws  --count N  --procs P  --cx --cz --radius  --ramp (connections/s)
//          --duration S (0 = run until Ctrl-C)  --ports 8787,8788 (spread sockets over several listen ports: one
//          loopback port only has ~16k ephemeral source ports on macOS)  --metrics URL  --out file.json
//          --park (bots stay parked in their car: idle traffic)
import { fork } from 'node:child_process';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, l) => (s.startsWith('--') ? [...a, [s.slice(2), l[i + 1]?.startsWith('--') || l[i + 1] === undefined ? '1' : l[i + 1]]] : a), []));
const count = +(args.count ?? 20);
const procs = Math.max(1, +(args.procs ?? Math.min(8, Math.ceil(count / 1500))));
const url = args.url ?? 'ws://127.0.0.1:8787/ws';
const ports = (args.ports || '').split(',').filter(Boolean).map(Number);
const metricsUrl = args.metrics ?? url.replace(/^ws/, 'http').replace(/\/ws$/, '/metrics');
const duration = +(args.duration ?? 0);
const per = Math.ceil(count / procs);
const children = [];
const last = new Map();

for (let p = 0; p < procs; p++) {
  const n = Math.min(per, count - p * per);
  if (n <= 0) break;
  const cfg = {
    url, count: n, base: p * per, cx: +(args.cx ?? 1745), cz: +(args.cz ?? -640), radius: +(args.radius ?? 400),
    rampPerSec: Math.max(1, Math.round(+(args.ramp ?? 400) / procs)), light: args.full ? false : true, ports, park: !!args.park,
  };
  const c = fork(new URL('./bot-worker.js', import.meta.url), [JSON.stringify(cfg)], { stdio: 'inherit' });
  c.on('message', (m) => { if (m.t === 'stats') last.set(p, m); });
  children.push(c);
}

let prevCpu = null, prevT = 0;
const samples = [];
async function serverMetrics() {
  try {
    const txt = await (await fetch(metricsUrl)).text();
    const get = (k) => { const m = txt.match(new RegExp(`^${k} ([0-9.e+-]+)$`, 'm')); return m ? +m[1] : NaN; };
    const cpu = get('process_cpu_seconds_total'), t = performance.now();
    const cpuPct = prevCpu !== null ? ((cpu - prevCpu) / ((t - prevT) / 1000)) * 100 : NaN;
    prevCpu = cpu; prevT = t;
    return { online: get('leonida_online'), tickMs: get('leonida_tick_ms'), tickP99: get('leonida_tick_p99_ms'), tickMax: get('leonida_tick_max_ms'), rss: get('process_resident_memory_bytes') / 1048576, cpuPct, pubBytes: get('leonida_pubsub_bytes_out_total'), dropped: get('leonida_dropped_ticks_total'), lag: get('leonida_gateway_lag_ticks_total'), arena: get('leonida_arena_bytes') };
  } catch { return null; }
}

let prevPub = null;
const t0 = performance.now();
const timer = setInterval(async () => {
  let bots = 0, connected = 0, failed = 0, kicked = 0, bytes = 0, msgs = 0, records = 0, corr = 0, rtt50 = 0, rtt99 = 0;
  for (const m of last.values()) {
    bots += m.bots; connected += m.connected; failed += m.failed; kicked += m.kicked; bytes += m.bytes; msgs += m.msgs; records += m.records; corr += m.corrections;
    rtt50 = Math.max(rtt50, m.rtt50); rtt99 = Math.max(rtt99, m.rtt99);
  }
  const s = await serverMetrics();
  const pubRate = s && prevPub !== null ? (s.pubBytes - prevPub) / 5 : NaN;
  if (s) prevPub = s.pubBytes;
  const el = ((performance.now() - t0) / 1000).toFixed(0);
  const row = {
    t: +el, bots, failed, kicked, corrections: corr,
    perBotKBs: bots ? +(bytes / bots / 1024).toFixed(2) : 0, perBotMsgs: bots ? +(msgs / bots).toFixed(1) : 0, perBotRecs: bots ? +(records / bots).toFixed(1) : 0,
    rtt50: +rtt50.toFixed(1), rtt99: +rtt99.toFixed(1),
    server: s ? { online: s.online, cpuPct: +s.cpuPct.toFixed(0), rssMB: +s.rss.toFixed(0), tickMs: +s.tickMs.toFixed(2), tickP99: +s.tickP99.toFixed(2), tickMax: +s.tickMax.toFixed(1), egressMBs: +(pubRate / 1048576).toFixed(2), arenaKB: +(s.arena / 1024).toFixed(1), droppedTicks: s.dropped, gatewayLag: s.lag } : null,
  };
  samples.push(row);
  console.log(JSON.stringify(row));
  if (duration && +el >= duration) stop();
}, 5000);

function stop() {
  clearInterval(timer);
  for (const c of children) { try { c.send({ t: 'stop' }); } catch { /* gone */ } }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ args, samples }, null, 1));
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
