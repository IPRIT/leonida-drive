#!/usr/bin/env node
// Smoke-test helper: occupy N places in the world of a (local) server so the next players go into the waiting queue.
// Start a server with a small cap first, e.g. `MAX_PLAYERS=1 node server/src/main.js`, then
//   node tools/loadtest/hold-slots.mjs --url ws://127.0.0.1:8787/ws --count 1
// Ctrl-C releases them (the head of the queue is admitted within a tick).
import { TestClient } from '../../server/tools/client.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, l) => (s.startsWith('--') ? [...a, [s.slice(2), l[i + 1]]] : a), []));
const url = args.url || 'ws://127.0.0.1:8787/ws', count = +(args.count ?? 1);
const held = [];
for (let i = 0; i < count; i++) {
  const c = new TestClient(url);
  const r = await c.join(8000);
  if (r.queue) { console.log(`#${i + 1}: queued at ${r.queue.position} (the server is already full)`); c.close(); break; }
  held.push(c);
  console.log(`#${i + 1}: holding a place (netId ${r.welcome.netId})`);
}
// keep them alive like parked players (a state now and then)
const keep = setInterval(() => { for (const c of held) c.sendState({ x: 1745, y: 2, z: -640 }); }, 1000);
const stop = () => { clearInterval(keep); for (const c of held) c.close(); setTimeout(() => process.exit(0), 200); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`holding ${held.length} place(s); Ctrl-C to release`);
