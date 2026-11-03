#!/usr/bin/env node
// What permessage-deflate would save on a recorded downlink (wire-meter.mjs --dump): compresses every message as a
// WebSocket server would — raw deflate, sync flush per message, with and without context takeover — and reports the
// payload saved and the CPU it costs per client.
//
//   node tools/loadtest/deflate-measure.mjs /tmp/bw-dump/crowd.bin [--level 1]
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const level = +(process.argv[process.argv.indexOf('--level') + 1] || 1);
const buf = fs.readFileSync(file);
const msgs = [];
for (let o = 0; o + 8 <= buf.length;) { const t = buf.readUInt32LE(o), len = buf.readUInt32LE(o + 4); msgs.push({ t, b: buf.subarray(o + 8, o + 8 + len) }); o += 8 + len; }
const span = msgs.length > 1 ? (msgs[msgs.length - 1].t - msgs[0].t) / 1000 : 1;
const raw = msgs.reduce((a, m) => a + m.b.length, 0);

async function run(takeover) {
  let out = 0, pending = 0;
  const z = takeover ? zlib.createDeflateRaw({ level }) : null;
  if (z) z.on('data', (c) => { pending += c.length; });
  const t0 = process.cpuUsage();
  for (const m of msgs) {
    // a sync flush per message; the trailing 00 00 ff ff is stripped on the wire (RFC 7692). A message that would
    // grow is sent uncompressed.
    let n;
    if (z) { pending = 0; z.write(m.b); await new Promise((r) => z.flush(zlib.constants.Z_SYNC_FLUSH, r)); n = pending - 4; }
    else n = zlib.deflateRawSync(m.b, { level, finishFlush: zlib.constants.Z_SYNC_FLUSH }).length - 4;
    out += Math.min(m.b.length, n);
  }
  const cpu = process.cpuUsage(t0);
  return { bytes: out, cpuMs: (cpu.user + cpu.system) / 1000 };
}
const a = await run(false), b = await run(true);
const r = (x) => ({ payloadBps: +(x.bytes / span).toFixed(0), saved: `${(100 * (1 - x.bytes / raw)).toFixed(0)}%`, cpuUsPerS: +((x.cpuMs * 1000) / span).toFixed(0) });
console.log(JSON.stringify({ file, seconds: +span.toFixed(1), messages: msgs.length, rawPayloadBps: +(raw / span).toFixed(0), noContextTakeover: r(a), contextTakeover: r(b) }));
