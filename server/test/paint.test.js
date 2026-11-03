// Vehicle colour replication: the colour (and finish) a player's car actually shows reaches the others through INFO,
// on spawn and on every change (red, blue, gold; black stays black).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { S_INFO } from '../../src/net/shared/constants.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error: console.error, debug() {} };

test('car colours: red, blue, gold and metallic are what the others see', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leonida-paint-'));
  const port = 30000 + Math.floor(Math.random() * 2000);
  const srv = await startServer({ port, host: '127.0.0.1', workers: 0, dbPath: path.join(tmp, 'p.db'), log: quiet, logLevel: 'error', maxConnPerIp: 64, connRatePerIp: 1000 });
  const url = `ws://127.0.0.1:${port}/ws`;
  const A = new TestClient(url), B = new TestClient(url);
  try {
    await A.connect(); await B.connect();
    const pip = A.modelIndex('pip');
    A.sendState({ x: 1728, y: 2, z: -733, model: pip }); B.sendState({ x: 1730, y: 2, z: -735 });
    await sleep(150);
    const seen = async () => { const p = B.next(S_INFO, (l) => l.some((i) => i.netId === A.welcome.netId), 3000); B.infoReq([A.welcome.netId]); return (await p).find((i) => i.netId === A.welcome.netId); };
    // the client sends the car's colour in the low 24 bits and finish index + 1 in the top byte (src/net/LocalPlayer.js)
    for (const [rgb, finish] of [[0xd0202a, 0], [0x2050e0, 1], [0xd4af37, 2], [0x010101, 0]]) {
      A.event(3, (rgb | ((finish + 1) << 24)) >>> 0);
      await sleep(1100); // ≤ 1 paint change per second
      const i = await seen();
      assert.equal(i.paint, rgb, `colour ${rgb.toString(16)}`);
      assert.equal(i.finish, finish, `finish ${finish}`);
    }
  } finally {
    A.close(); B.close();
    await srv.close();
  }
});
