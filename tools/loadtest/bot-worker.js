// One bot process: N WebSocket bots driving on real roads, 20 Hz state uploads (server-clock stamps: same machine),
// light decoding of everything received. Reports stats to the parent (process.send) every second.
import { TestClient } from '../../server/tools/client.js';
import { RawClient } from './rawws.js';
import { RoadNet, Driver, rng } from './botlib.js';
import { S_CELL, S_PONG, S_KICK, S_WALLET, S_CORRECTION } from '../../src/net/shared/constants.js';
import { encodeEvent } from '../../src/net/shared/protocol.js';
import { uplinkDue, rememberUplink } from '../../src/net/shared/uplink.js';

const arg = JSON.parse(process.argv[2] || '{}');
const { url = 'ws://127.0.0.1:8787/ws', count = 10, base = 0, cx = 1745, cz = -640, radius = 400, rampPerSec = 200, light = true, origin = 'http://localhost:5317', ports = [], park = false, uplink = true } = arg;
const net = new RoadNet();
const r = rng(base * 7919 + 13);
const bots = [];
const stats = { connected: 0, failed: 0, kicked: 0, bytes: 0, msgs: 0, cells: 0, records: 0, rtts: [], corrections: 0, claimsOk: 0 };

function urlFor(i) {
  if (!ports.length) return url;
  const u = new URL(url);
  u.port = String(ports[i % ports.length]);
  return u.toString();
}

async function start(i) {
  const d = new Driver(net, { cx, cz, radius, seed: base + i + 1 });
  let c;
  if (light) {
    // raw framing client: scans headers only (bots must stay much cheaper than the server they load)
    c = new RawClient(urlFor(i), {
      origin,
      onMsg: (type, b, p, len) => {
        stats.bytes += len; stats.msgs++;
        if (type === S_CELL) { stats.cells++; stats.records += b[p + 6]; }
        else if (type === S_PONG) stats.rtts.push(c.lastRtt);
        else if (type === S_KICK) stats.kicked++;
        else if (type === S_WALLET) { if (b.readInt32LE(p + 12) > 0) stats.claimsOk++; }
        else if (type === S_CORRECTION) stats.corrections++;
      },
    });
  } else c = new TestClient(urlFor(i), { origin, keepRecords: true });
  const bot = { c, d, model: 0, phase: 'foot', t0: performance.now(), sent: 0, ph: Math.random() * 6.28, pv: 0 };
  try {
    const w = await c.connect(15000);
    stats.connected++;
    // pick a traffic car to "enter" after a second on foot (the server allows carjacking from standstill)
    bot.carModel = 1 + Math.floor(r() * 90);
    bots.push(bot);
    c.send(encodeEvent(3, 1, Math.floor(r() * 0xffffff))); // paint
  } catch (e) {
    stats.failed++;
    if (stats.failed < 5) console.error(`[bots] connect failed: ${e.message}`);
  }
}

// ramp up
let started = 0;
const ramp = setInterval(() => {
  const n = Math.min(count - started, Math.max(1, Math.round(rampPerSec / 10)));
  for (let k = 0; k < n; k++) start(started++);
  if (started >= count) clearInterval(ramp);
}, 100);

// 20 Hz: simulate + send (spread across the 50 ms window)
let last = performance.now();
setInterval(() => {
  const now = performance.now(), dt = Math.min(0.2, (now - last) / 1000);
  last = now;
  for (const b of bots) {
    if (b.c.closed) continue;
    const age = (now - b.t0) / 1000;
    if (b.phase === 'foot' && age > 1.2) b.phase = 'car';
    if (b.phase === 'car' && !park) b.d.step(dt);
    const d = b.d;
    // suspension like a real car: body roll in turns, pitch under acceleration/braking, small road bumps
    const car = b.phase === 'car', acc = (d.v - b.pv) / Math.max(dt, 1e-3);
    b.pv = d.v;
    const moving = car && d.v > 0.5, tt = age + b.ph;
    const roll = moving ? Math.max(-0.08, Math.min(0.08, -d.v * d.yawRate * 0.008)) + 0.006 * Math.sin(tt * 9) : 0;
    const pitch = moving ? Math.max(-0.05, Math.min(0.05, -acc * 0.006)) + 0.005 * Math.sin(tt * 7.3) : 0;
    const st = b.st || (b.st = {});
    st.x = d.x; st.y = b.phase === 'foot' ? d.y - 0.35 : d.y; st.z = d.z; st.yaw = d.yaw; st.vx = car ? d.vx : 0; st.vy = 0; st.vz = car ? d.vz : 0;
    st.yawRate = car ? d.yawRate : 0; st.steer = d.steer; st.model = car ? b.carModel : 0; st.pitch = pitch; st.roll = roll; st.health = 1;
    st.flags = car && acc < -2 ? 0x100 : 0; st.ext = false;
    // the same send-on-deviation uplink as the browser (20 Hz sampling, ≥ 4 Hz heartbeat)
    if (!uplink || uplinkDue(b.up, st, now - (b.upT || 0))) {
      st.t = Math.round(b.c.offset !== undefined ? now + b.c.offset : now) >>> 0; st.serverClock = b.c.offset !== undefined;
      b.c.sendState(st);
      b.up = rememberUplink(st, b.up || {}); b.upT = now;
      stats.up = (stats.up || 0) + 1;
    }
    if (++b.sent % 40 === 0 || b.sent < 6) b.c.ping(b.sent);
  }
}, 50);

setInterval(() => {
  const rtts = stats.rtts.sort((a, b) => a - b);
  const q = (p) => (rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(p * rtts.length))] : 0);
  process.send?.({ t: 'stats', bots: bots.filter((b) => !b.c.closed).length, connected: stats.connected, failed: stats.failed, kicked: stats.kicked, bytes: stats.bytes, msgs: stats.msgs, cells: stats.cells, records: stats.records, corrections: stats.corrections, rtt50: q(0.5), rtt99: q(0.99) });
  stats.bytes = stats.msgs = stats.cells = stats.records = 0;
  stats.rtts.length = 0;
}, 1000);

process.on('message', (m) => { if (m?.t === 'stop') { for (const b of bots) b.c.terminate(); process.exit(0); } });
process.on('disconnect', () => process.exit(0));
