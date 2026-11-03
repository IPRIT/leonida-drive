#!/usr/bin/env node
// Downlink meter: one observer client parked (or slowly driving) at a spot, recording every server message for N s.
// Reports bytes/s by message type, WebSocket framing, and an estimate of what actually goes on the wire through TLS:
// messages that arrive together (one server tick, corked into one TCP write) are grouped into bursts; each burst costs
// ceil(bytes / 1400) segments × 74 B (IPv4 + TCP with timestamps 52 B, TLS 1.3 record 22 B).
//
//   node tools/loadtest/wire-meter.mjs --url ws://127.0.0.1:8790/ws --x 1745 --z -640 --seconds 30 [--drive] [--json]
//     [--dump file]   also save every message (u32 ms | u32 length | bytes) for deflate-measure.mjs
import fs from 'node:fs';
import { TestClient } from '../../server/tools/client.js';
import { loadHeights } from './botlib.js';
import * as C from '../../src/net/shared/constants.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, l) => (s.startsWith('--') ? [...a, [s.slice(2), l[i + 1]?.startsWith('--') || l[i + 1] === undefined ? '1' : l[i + 1]]] : a), []));
const url = args.url || 'ws://127.0.0.1:8790/ws', X = +(args.x ?? 1745), Z = +(args.z ?? -640), SECONDS = +(args.seconds ?? 30);
const PKT = 74, MSS = 1400, BURST_GAP = 4; // ms between messages of the same burst
const NAMES = Object.fromEntries(Object.entries(C).filter(([k, v]) => /^S_/.test(k) && typeof v === 'number').map(([k, v]) => [v, k]));
const heights = loadHeights();

const c = new TestClient(url, { keepRecords: false });
// count raw frames before decoding
const byType = new Map();
let bursts = 0, segments = 0, burstBytes = 0, lastAt = 0, msgs = 0, payload = 0, framing = 0, records = 0;
const flush = () => { if (burstBytes) { bursts++; segments += Math.ceil(burstBytes / MSS); } burstBytes = 0; };
const onRaw = (ab) => {
  const now = performance.now();
  if (now - lastAt > BURST_GAP) flush();
  lastAt = now;
  const len = ab.byteLength, hdr = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const type = new Uint8Array(ab)[0];
  const t = byType.get(type) || { n: 0, bytes: 0 };
  t.n++; t.bytes += len; byType.set(type, t);
  msgs++; payload += len; framing += hdr; burstBytes += len + hdr;
  if (type === C.S_CELL) records += new Uint8Array(ab)[6];
  if (dump) { const h = Buffer.alloc(8); h.writeUInt32LE(Math.round(now) >>> 0, 0); h.writeUInt32LE(len, 4); dump.push(h, Buffer.from(ab)); }
};
const dump = args.dump ? [] : null;
const w = await c.connect(8000);
const origOn = c._onMessage.bind(c);
let measuring = false;
c._onMessage = (ab) => { if (measuring) onRaw(ab); origOn(ab); };
for (let i = 0; i < 6; i++) { c.ping(i); await new Promise((r) => setTimeout(r, 30)); }
// stand still (or circle slowly) at the spot, 20 Hz like the browser
const y = Math.max(0, heights?.(X, Z) ?? 0) + 0.35;
let t = 0, pingAt = performance.now();
const iv = setInterval(() => {
  t += 0.05;
  if (performance.now() - pingAt > 6000) { pingAt = performance.now(); c.ping(99); } // like the browser (6 s)
  if (args.drive) {
    const a = t * 0.1, r = 60;
    c.sendState({ x: X + r * Math.cos(a), y, z: Z + r * Math.sin(a), yaw: -a, vx: -r * 0.1 * Math.sin(a), vz: r * 0.1 * Math.cos(a), yawRate: 0.1, model: c.modelIndex('pip') });
  } else c.sendState({ x: X, y, z: Z, yaw: 0, model: c.modelIndex('pip') });
}, 50);
await new Promise((r) => setTimeout(r, 3000)); // settle: interest subscriptions, info, first keyframes
measuring = true;
const t0 = performance.now();
await new Promise((r) => setTimeout(r, SECONDS * 1000));
flush();
const dur = (performance.now() - t0) / 1000;
if (dump) fs.writeFileSync(args.dump, Buffer.concat(dump));
clearInterval(iv);
c.close();
const rows = [...byType].sort((a, b) => b[1].bytes - a[1].bytes).map(([type, v]) => ({ type: NAMES[type] || type, msgsPerS: +(v.n / dur).toFixed(1), bytesPerS: +(v.bytes / dur).toFixed(0) }));
const wire = (payload + framing + segments * PKT) / dur;
const out = {
  seconds: +dur.toFixed(1), netId: w.netId,
  payloadBps: +(payload / dur).toFixed(0), wsFramingBps: +(framing / dur).toFixed(0), tlsTcpBps: +((segments * PKT) / dur).toFixed(0), wireBps: +wire.toFixed(0),
  msgsPerS: +(msgs / dur).toFixed(1), burstsPerS: +(bursts / dur).toFixed(1), recordsPerS: +(records / dur).toFixed(1), byType: rows,
};
console.log(args.json ? JSON.stringify(out) : out);
process.exit(0);
