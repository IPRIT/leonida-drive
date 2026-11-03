// DB service (runs on its own thread in production): session ownership (one live session per player), write-behind
// saves, the leaderboard and the rank snapshot. SQLite calls are synchronous, so they never block a gateway or the hub.
import { KICK } from '../../src/net/shared/constants.js';
import { MONEY_CAP } from './shared-mem.js';

const hex = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('hex');

export class DbService {
  /**
   * @param {Store} store
   * @param {object} v shared views (rank snapshot)
   * @param {{toWorker(w, msg), toHub(msg), log}} io
   */
  constructor(store, v, io) {
    this.store = store;
    this.v = v;
    this.io = io;
    this.log = io.log || console;
    this.active = new Map(); // token hash hex → { w, sid, netId }
    this.pending = new Map(); // hash hex → [load requests] waiting for the previous session to release
    this.total = store.count();
    this.saved = 0;
    this.saveMs = 0;
    this.timers = [
      setInterval(() => this.board(), 3000),
      setInterval(() => this.ranks(), 10000),
      setInterval(() => { this.total = this.store.count(); }, 15000),
      setInterval(() => { this.store.checkpoint(); this.retention(); }, 3600000),
    ];
    for (const t of this.timers) t.unref?.();
    this.retention();
    this.ranks();
    this.board();
  }

  // data retention (server/README.md "Privacy"): security log 30 days, never-progressed profiles 180 days
  retention(now = Date.now()) {
    const r = this.io.retention || {};
    try {
      const logs = this.store.pruneLog((r.logDays ?? 30) * 864e5, now);
      const stale = this.store.pruneStale((r.staleDays ?? 180) * 864e5, r.startMoney ?? 5000, now);
      if (stale) this.total = this.store.count();
      if (logs || stale) this.log.info?.(`[db] retention: ${logs} security-log rows, ${stale} stale profiles removed`);
      return { logs, stale };
    } catch (e) {
      this.log.error?.(`[db] retention failed: ${e.message}`);
      return { logs: 0, stale: 0 };
    }
  }

  onMessage(m) {
    try {
      switch (m.t) {
        case 'load': this._load(m); break;
        case 'release': this._release(m); break;
        case 'save': this._save(m.recs); break;
        case 'log': this.store.log(m.hash, m.kind, m.detail); break;
        case 'nick': {
          const result = m.check ? (this.store.nickOwner(m.hash, m.name) ? 'taken' : 'ok') : this.store.claimNick(m.hash, m.name);
          this.io.toWorker(m.w, { t: 'nick', sid: m.sid, reqId: m.reqId, name: m.name, op: m.op, check: !!m.check, retried: !!m.retried, result });
          break;
        }
        default: break;
      }
    } catch (e) {
      this.log.error?.(`[db] ${m.t} failed: ${e.stack || e}`);
    }
  }

  _load(m) {
    const key = hex(m.hash);
    const cur = this.active.get(key);
    if (cur && !(cur.w === m.w && cur.sid === m.sid)) {
      // the same profile is still connected (another tab / a stale socket): kick it and wait for its final save
      let q = this.pending.get(key);
      if (!q) this.pending.set(key, (q = []));
      q.push(m);
      this.io.toWorker(cur.w, { t: 'kick', sid: cur.sid, hash: m.hash, code: KICK.DUPLICATE });
      setTimeout(() => {
        const c = this.active.get(key);
        if (c && c.sid === cur.sid && c.w === cur.w) this._release({ w: cur.w, sid: cur.sid, hash: m.hash, rec: null });
      }, 4000).unref?.();
      return;
    }
    this.active.set(key, { w: m.w, sid: m.sid, netId: m.netId });
    const rec = this.store.load(m.hash);
    this.io.toWorker(m.w, { t: 'loaded', sid: m.sid, hash: m.hash, rec });
  }

  _release(m) {
    const key = hex(m.hash);
    if (m.rec) this._save([m.rec]);
    const cur = this.active.get(key);
    if (cur && cur.w === m.w && cur.sid === m.sid) this.active.delete(key);
    const q = this.pending.get(key);
    if (q && !this.active.has(key)) {
      const next = q.shift();
      if (!q.length) this.pending.delete(key);
      if (next) this._load(next);
    }
  }

  _save(recs) {
    if (!recs?.length) return;
    const t0 = performance.now();
    const n = this.store.saveMany(recs);
    this.saved += n;
    this.saveMs = performance.now() - t0;
  }

  board() {
    const top = this.store.top(10).map((r) => ({ netId: this.active.get(hex(r.hash))?.netId ?? 0, nickCode: r.nickCode, name: r.name, color: r.color, money: r.money }));
    this.io.toHub({ t: 'board', top, total: this.total });
  }

  ranks() {
    const v = this.v;
    const half = 1 - Atomics.load(v.moneyHdr, 0);
    const view = v.money.subarray(half * MONEY_CAP, (half + 1) * MONEY_CAP);
    const n = this.store.worthInto(view);
    Atomics.store(v.moneyHdr, 1, n);
    Atomics.store(v.moneyHdr, 0, half);
    Atomics.add(v.moneyHdr, 2, 1);
  }

  /** Final flush on shutdown. */
  close() {
    for (const t of this.timers) clearInterval(t);
    this.store.close();
  }
}
