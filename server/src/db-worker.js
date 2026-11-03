// DB thread entry: owns the SQLite connection. Gateways talk to it through MessagePorts, the hub through parentPort.
import { parentPort, workerData, receiveMessageOnPort } from 'node:worker_threads';
import { Store } from './db.js';
import { DbService } from './db-service.js';
import { views } from './shared-mem.js';

const { dbPath, shared, ports, retention } = workerData;
const v = views(shared);
const store = new Store(dbPath);
if (workerData.worthPrices) store.revalueWorth(workerData.worthPrices);
const svc = new DbService(store, v, {
  toWorker: (w, msg) => ports[w].postMessage(msg),
  toHub: (msg) => parentPort.postMessage(msg),
  log: console,
  retention,
});
ports.forEach((p) => p.on('message', (m) => svc.onMessage(m)));
parentPort.on('message', (m) => {
  if (m.t === 'close') {
    // gateways have flushed: drain anything still queued on the ports, then close the database
    for (const p of ports) for (let r = receiveMessageOnPort(p); r; r = receiveMessageOnPort(p)) svc.onMessage(r.message);
    svc.close();
    parentPort.postMessage({ t: 'closed', saved: svc.saved });
  }
});
parentPort.postMessage({ t: 'ready' });
