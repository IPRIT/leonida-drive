// Gateway thread entry (uWS child app: the acceptor in the main thread hands accepted sockets to it).
import { parentPort, workerData } from 'node:worker_threads';
import { views } from './shared-mem.js';
import { Gateway } from './gateway.js';
import { loadTransport } from './transport.js';
import { loadWorldData } from './worlddata.js';
import { loadVehicles } from './vehicles.js';
import { loadPrices } from './prices.js';
import { loadWardrobe } from './wardrobe.js';
import { makeLogger } from './log.js';

const { id, shared, cfg, dbPort, range } = workerData;
const log = makeLogger(cfg.logLevel, `[gw${id}]`);
const v = views(shared);
const t = await loadTransport('uws', log);
const app = t.App();
const vehicles = loadVehicles();
const quiet = { info() {}, warn: log.warn };
const gw = new Gateway({
  id, v, cfg, app, db: dbPort, world: loadWorldData(cfg.worldData, id ? quiet : log), vehicles, prices: loadPrices(vehicles, undefined, id ? quiet : log),
  range, log, toHub: (m) => parentPort.postMessage(m), wardrobe: loadWardrobe(undefined, id ? quiet : log),
});
parentPort.on('message', (m) => {
  if (m.t === 'tick') gw.onTick(m.T, m.b);
  else if (m.t === 'admit') gw.onAdmit(m.ticket);
  else if (m.t === 'admin-travel') gw.onAdminTravel(m);
  else if (m.t === 'admin-travel-result') gw.onAdminTravelResult(m);
  else if (m.t === 'shutdown') parentPort.postMessage({ t: 'drained', saved: gw.shutdown() });
  else if (m.t === 'close') { app.close(); parentPort.postMessage({ t: 'closed' }); }
});
parentPort.postMessage({ t: 'desc', desc: app.getDescriptor() });
