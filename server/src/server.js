// Server orchestration: threads, tick loop, graceful shutdown.
//
//   main thread  : hub (20 Hz interest grid + encode-once cell streams) + uWS acceptor (load-balances sockets)
//   N gateways   : uWS child apps (decode, validate, sessions, publish arena buffers to local topics)
//   DB thread    : node:sqlite WAL store, session ownership, leaderboard, rank snapshot
//
// WORKERS=0 (or the `ws` fallback) runs everything on one thread: same code paths, for tests and tiny deployments.
import { Worker, MessageChannel } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.js';
import { createShared, views, slotRange, H_START_MS, H_T0, H_TICK_DT } from './shared-mem.js';
import { Hub } from './hub.js';
import { Gateway, serverNow } from './gateway.js';
import { loadTransport } from './transport.js';
import { loadWorldData } from './worlddata.js';
import { loadVehicles } from './vehicles.js';
import { loadPrices } from './prices.js';
import { loadWardrobe } from './wardrobe.js';
import { Store } from './db.js';
import { DbService } from './db-service.js';
import { admit } from './queue.js';
import { makeLogger } from './log.js';

const here = new URL('.', import.meta.url);

/** In-process message channel with MessagePort-like semantics (async delivery). */
function localChannel() {
  const a = new EventEmitter(), b = new EventEmitter();
  a.postMessage = (m) => queueMicrotask(() => b.emit('message', m));
  b.postMessage = (m) => queueMicrotask(() => a.emit('message', m));
  return [a, b];
}

/**
 * Start a server. overrides: config fields (see config.js). Returns { cfg, port, mode, close(), stats() }.
 */
export async function startServer(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const log = overrides.log || makeLogger(cfg.logLevel, '[hub]');
  const transport = await loadTransport(cfg.transport, log);
  const threaded = cfg.workers > 0 && transport.kind === 'uws';
  const W = threaded ? cfg.workers : 1;
  // every gateway thread must be able to hold the whole capacity (connections are not spread evenly)
  cfg.maxPlayers = Math.min(131072, Math.max(cfg.maxPlayers, (cfg.capacity + 64) * W));
  const shared = createShared(cfg.maxPlayers, W);
  const v = views(shared);
  const tickDt = 1000 / cfg.tickHz;
  const t0 = Math.floor(serverNow() / tickDt) * tickDt; // tick T is scheduled at t0 + T * tickDt
  v.hub[H_START_MS] = Date.now();
  v.hub[H_T0] = t0;
  v.hub[H_TICK_DT] = tickDt;
  const hubVehicles = loadVehicles();
  const hubPrices = loadPrices(hubVehicles, undefined, log);
  const hub = new Hub(v, cfg, { log, vehicles: hubVehicles, world: loadWorldData(cfg.worldData, { info() {}, warn: log.warn }) });
  let notifyTick, notifyAdmit, closeAll;
  const listenSockets = [];
  let fatalOnce = false;
  const fatal = () => {
    if (fatalOnce) return;
    fatalOnce = true;
    Promise.race([srv.close(), new Promise((r) => setTimeout(r, 8000))]).finally(() => process.exit(1));
  };

  if (threaded) {
    const acceptor = transport.App();
    const channels = Array.from({ length: W }, () => new MessageChannel());
    const db = new Worker(new URL('./db-worker.js', here), {
      workerData: { dbPath: cfg.dbPath, shared, ports: channels.map((c) => c.port2), retention: retentionOf(cfg), worthPrices: hubPrices },
      transferList: channels.map((c) => c.port2),
    });
    const dbReady = new Promise((res, rej) => { db.once('error', rej); db.on('message', (m) => { if (m.t === 'ready') res(); else if (m.t === 'board') hub.setBoard(m); }); });
    const gws = [];
    const descs = [];
    for (let w = 0; w < W; w++) {
      const g = new Worker(new URL('./gateway-worker.js', here), {
        workerData: { id: w, shared, cfg: { ...cfg, log: undefined }, dbPort: channels[w].port1, range: slotRange(cfg.maxPlayers, W, w) },
        transferList: [channels[w].port1],
      });
      descs.push(new Promise((res, rej) => {
        g.once('error', rej);
        g.on('message', (m) => {
          if (m.t === 'desc') res(m.desc);
          else if (m.t === 'shot') hub.queueShot(m);
          else if (m.t === 'admin-travel') for (const target of gws) target.postMessage(m);
          else if (m.t === 'admin-travel-result') gws[m.owner]?.postMessage(m);
        });
      }));
      // a crashed gateway leaves a dangling child app in the acceptor: stop cleanly and let the supervisor restart us
      g.on('error', (e) => { log.error(`gateway ${w} crashed: ${e.stack || e}`); fatal(); });
      g.on('exit', (code) => { if (code !== 0 && !stopped) { log.error(`gateway ${w} exited with ${code}`); fatal(); } });
      gws.push(g);
    }
    await dbReady;
    for (const d of await Promise.all(descs)) acceptor.addChildAppDescriptor(d);
    for (const port of [cfg.port, ...cfg.extraPorts]) {
      const ls = await new Promise((res) => acceptor.listen(cfg.host, port, res));
      if (!ls) throw new Error(`cannot listen on ${cfg.host}:${port}`);
      listenSockets.push(ls);
    }
    notifyTick = (T, b) => { for (const g of gws) g.postMessage({ t: 'tick', T, b }); };
    notifyAdmit = (w, ticket) => gws[w]?.postMessage({ t: 'admit', ticket });
    const ask = (w, msg, reply, ms) => new Promise((res) => {
      const t = setTimeout(res, ms);
      const on = (m) => { if (m.t === reply) { clearTimeout(t); w.off('message', on); res(m); } };
      w.on('message', on);
      w.postMessage(msg);
    });
    closeAll = async () => {
      for (const ls of listenSockets) transport.uWS.us_listen_socket_close(ls);
      const drained = await Promise.all(gws.map((g) => ask(g, { t: 'shutdown' }, 'drained', 4000)));
      log.info(`saved ${drained.reduce((s, d) => s + (d?.saved || 0), 0)} sessions on shutdown`);
      await ask(db, { t: 'close' }, 'closed', 8000);
      await Promise.all(gws.map((g) => ask(g, { t: 'close' }, 'closed', 2000)));
      await Promise.all([db.terminate(), ...gws.map((g) => g.terminate())]);
      acceptor.close();
    };
  } else {
    const app = transport.App();
    const [gwEnd, dbEnd] = localChannel();
    const store = new Store(cfg.dbPath);
    store.revalueWorth(hubPrices);
    const svc = new DbService(store, v, { toWorker: (w, m) => dbEnd.postMessage(m), toHub: (m) => hub.setBoard(m), log, retention: retentionOf(cfg) });
    dbEnd.on('message', (m) => svc.onMessage(m));
    const vehicles = hubVehicles;
    const gw = new Gateway({
      id: 0, v, cfg, app, db: gwEnd, world: loadWorldData(cfg.worldData, log), vehicles, prices: hubPrices,
      range: [0, cfg.maxPlayers], log, wardrobe: loadWardrobe(undefined, log), toHub: (m) => {
        if (m.t === 'shot') hub.queueShot(m);
        else if (m.t === 'admin-travel') queueMicrotask(() => gw.onAdminTravel(m));
        else if (m.t === 'admin-travel-result') queueMicrotask(() => gw.onAdminTravelResult(m));
      },
    });
    for (const port of [cfg.port, ...cfg.extraPorts]) {
      const ls = await new Promise((res) => app.listen(cfg.host, port, res));
      if (!ls) throw new Error(`cannot listen on ${cfg.host}:${port}`);
      listenSockets.push(ls);
    }
    notifyTick = (T, b) => gw.onTick(T, b);
    notifyAdmit = (w, ticket) => gw.onAdmit(ticket);
    closeAll = async () => {
      gw.shutdown();
      await new Promise((r) => setTimeout(r, 50)); // let queued saves reach the store
      svc.close();
      app.close();
    };
  }

  // ---- tick loop (drift-corrected; skips ahead instead of spiralling when overloaded) ----
  let T = Math.floor((serverNow() - t0) / tickDt);
  let timer = null, stopped = false;
  const loop = () => {
    if (stopped) return;
    const target = Math.floor((serverNow() - t0) / tickDt);
    if (target - T > 10) T = target - 1;
    let n = 0;
    while (T < target && n < 2) {
      T++;
      n++;
      const b = hub.step(T, t0 + T * tickDt);
      admit(v.q, cfg.capacity, notifyAdmit); // waiting queue: O(1) unless someone can get in
      if (b >= 0) notifyTick(T, b);
    }
    timer = setTimeout(loop, Math.max(0, t0 + (T + 1) * tickDt - serverNow()));
  };
  loop();
  if (cfg.joinAnywhere) log.warn('JOIN_ANYWHERE=1: spawn-area check disabled (load tests only)');
  log.info(`listening on ${cfg.host}:${[cfg.port, ...cfg.extraPorts].join(',')} (${threaded ? `${W} gateway threads + hub + db thread` : 'single thread'}, ${transport.kind}, ${cfg.tickHz} Hz, db ${cfg.dbPath})`);

  let closing = null;
  const srv = {
    cfg, v, hub, mode: threaded ? 'threaded' : 'single', transport: transport.kind, port: cfg.port,
    close() {
      if (closing) return closing;
      stopped = true;
      clearTimeout(timer);
      closing = closeAll().then(() => log.info('stopped'));
      return closing;
    },
  };
  return srv;
}

function retentionOf(cfg) {
  return { logDays: cfg.logRetentionDays ?? 30, staleDays: cfg.staleProfileDays ?? 180, startMoney: cfg.startMoney ?? 5000 };
}
