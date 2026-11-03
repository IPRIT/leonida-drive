// Client side of the server-authoritative economy. game.economy (workstream L) calls these; every call resolves with
// the server's answer. Server state is pushed into game.economy.applyServer({ money, owned, worth, combo, progress,
// daily }). Without game.economy the wallet is mirrored into player.money and player.addMoney becomes a claim.
import { CLAIM, CLAIM_NAMES, WALLET, ECON, ECON_RESULT, SERVICE, WARDROBE_OP, NICK_OP, NICK_RESULT, NICK_PRICE, NOTICE } from './shared/constants.js';
import { encodeClaim, encodeEcon, encodeService, encodeOutfit, encodeNickReq } from './shared/protocol.js';
import { HORN_VARIANTS, PAINT_FINISHES, nickPrice } from '../economy/rules.js';
import { ADJECTIVES, NOUNS } from './shared/nicknames.js';
import { outfitCodes, itemById } from './shared/outfit-codes.js';

const RESULT_REASON = {
  [ECON_RESULT.FUNDS]: 'funds', [ECON_RESULT.NOT_OWNED]: 'notOwned', [ECON_RESULT.OWNED]: 'owned', [ECON_RESULT.NOT_SELLABLE]: 'starter',
  [ECON_RESULT.UNKNOWN]: 'unknown', [ECON_RESULT.RATE]: 'rate', [ECON_RESULT.FROZEN]: 'frozen', [ECON_RESULT.OFFLINE]: 'offline',
  [ECON_RESULT.UNDAMAGED]: 'undamaged', [ECON_RESULT.MAX]: 'max', [ECON_RESULT.EXCLUDED]: 'excluded', [ECON_RESULT.INSTALLED]: 'installed',
  [ECON_RESULT.VARIANT]: 'variant', [ECON_RESULT.FINISH]: 'finish', [ECON_RESULT.COLOR]: 'color', [ECON_RESULT.NO_VEHICLE]: 'noVehicle',
  [ECON_RESULT.EMPTY]: 'empty',
};
const NICK_REASON = {
  [NICK_RESULT.COOLDOWN]: 'cooldown', [NICK_RESULT.FUNDS]: 'funds', [NICK_RESULT.FORMAT]: 'format', [NICK_RESULT.BLOCKED]: 'blocked',
  [NICK_RESULT.TAKEN]: 'taken', [NICK_RESULT.RESERVED]: 'generated', [NICK_RESULT.BUSY]: 'busy',
};
const TIERS = { gold: 1, silver: 2, bronze: 3 };

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const idOf = (v, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v | 0) % max : typeof v === 'string' ? fnv(v) % max : 0);
const num = (...xs) => { for (const x of xs) if (Number.isFinite(x)) return x; return 0; };

export class NetEconomy {
  constructor(game, client) {
    this.game = game;
    this.client = client;
    this.money = 0;
    this.worth = 0;
    this.owned = new Set();
    this.combo = 1;
    this.progress = null;
    this.rank = null;
    this.synced = false;
    this.frozen = false;
    this.seq = 0;
    this.claims = new Map(); // seq → resolve
    this.econ = new Map(); // reqId → { op, resolve, reply }
    this.hospital = []; // resolvers waiting for the server's hospital charge
    this.listeners = new Set();
    this.inventory = { extinguisher: 0, insuranceUntil: 0 };
    this.custom = {};
    this.wd = { items: [], slots: [], owned: new Map(), outfit: {} }; // owned: id → dye colour | null; outfit: slot → id
    this.rerolls = 0;
    this.outfitWait = [];
    this.nickWait = new Map();
    // onState: replay what already arrived (the connection may be opened before the game, see preconnectNet)
    this._off = [
      client.onState('welcome', (w) => { this.money = w.money; this.frozen = w.claimsFrozen; this.synced = true; this._push({ money: w.money }); }),
      client.onState('wallet', (w) => this._wallet(w)),
      client.on('econ', (r) => this._econReply(r)),
      client.onState('owned', (o) => this._owned(o)),
      client.onState('progress', (p) => { this.progress = p; this._push({ progress: p }); }),
      client.onState('rank', (r) => { this.rank = r; this._emit(); }),
      client.onState('garage', (g) => this._garage(g)),
      client.on('nick', (n) => this._nick(n)),
      client.on('notice', (n) => {
        if (n.code !== NOTICE.CLAIMS_FROZEN && n.code !== NOTICE.CLAIMS_RESTORED) return;
        this.frozen = n.code === NOTICE.CLAIMS_FROZEN;
        this._push({ frozen: this.frozen });
      }),
      client.on('disconnect', () => this._failAll()),
    ];
    this._installAddMoney();
  }

  get ready() { return this.client.online && this.synced; }

  // ---------------- public API (game.net.*) ----------------
  /**
   * Earn claim. reason: drift | nearmiss | stunt | speedtrap | race | collectible | delivery | export | pickup | daily |
   * firstvisit | other. meta (all optional): duration/kmh (drift), air/height/spot (stunt), trap/kmh (speedtrap),
   * trial/tier/time (race), id (collectible), from{x,z}/length/time/condition (delivery), model/condition (export),
   * district (firstvisit). Resolves { ok, granted, money, result, combo, reason? }.
   */
  claim(reason, amount, pos = null, meta = {}) {
    const r = typeof reason === 'number' ? reason : CLAIM_NAMES[reason] ?? CLAIM.OTHER;
    if (!this.ready) return Promise.resolve({ ok: false, granted: 0, money: this.money, reason: 'offline' });
    const m = meta || {};
    const p = pos || this.game.player?.focus || { x: 0, z: 0 };
    const c = { reason: r, seq: (this.seq = (this.seq + 1) & 0xffff) || (this.seq = 1), amount: Math.max(0, Math.round(amount || 0)), x: p.x, z: p.z, combo: num(m.combo, 1) };
    switch (r) {
      case CLAIM.DRIFT: c.p1 = num(m.duration, m.time, m.t, m.seconds) * 100; c.p2 = num(m.kmh, m.speed); break;
      case CLAIM.STUNT: c.p1 = num(m.air, m.airTime, m.time) * 100; c.p2 = num(m.height, m.h) * 10; c.meta = m.spot == null ? 0 : 1 + idOf(m.spot, 255); break;
      case CLAIM.NEARMISS: c.p2 = num(m.kmh, m.speed); break;
      case CLAIM.SPEEDTRAP: c.meta = idOf(m.trap, 1024); c.p1 = num(m.kmh, m.speed) * 10; break;
      case CLAIM.RACE: c.meta = idOf(m.trial, 256); c.tier = TIERS[m.tier] ?? num(m.tier, 3); c.p1 = num(m.time, m.timeS) * 10; break;
      case CLAIM.COLLECTIBLE: c.meta = idOf(m.id, 64); break;
      case CLAIM.DELIVERY: {
        const f = m.from || {};
        c.meta = ((Math.round(num(f.x) / 10) & 0xffff) | ((Math.round(num(f.z) / 10) & 0xffff) << 16)) >>> 0;
        c.p1 = num(m.length, m.distance); c.p2 = num(m.time, m.timeS); c.tier = Math.round(num(m.condition, 1) * 100);
        break;
      }
      case CLAIM.EXPORT: {
        const id = m.model ?? this.game.player?.controllable?.catalogId;
        c.meta = this.client.modelIndex.get(id) ?? 0; c.tier = Math.round(num(m.condition, 1) * 100);
        break;
      }
      case CLAIM.FIRSTVISIT: c.meta = Math.max(0, num(m.district, m.index) | 0); break;
      default: break;
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.claims.delete(c.seq); resolve({ ok: false, granted: 0, money: this.money, reason: 'timeout' }); }, 6000);
      this.claims.set(c.seq, (res) => { clearTimeout(t); resolve(res); });
      this.client.send(encodeClaim(c));
    });
  }

  buy(id) { return this._econ(ECON.BUY, id, 0); }
  /** condition 0..1 of the car being sold (it can only lower the payout). */
  sell(id, condition = 1) { return this._econ(ECON.SELL, id, Math.round(Math.max(0, Math.min(1, condition)) * 100)); }
  repair(id, damage = 0) { return this._econ(ECON.REPAIR, id, Math.round(Math.max(0, Math.min(1, damage)) * 100)); }
  paint(variant = 0) { return this._econ(ECON.PAINT, null, variant === 'pearl' || variant === 'metallic' || variant === 1 ? 1 : 0); }

  /**
   * Fees. 'hospital' is charged by the server itself when the death event arrives: this resolves with that charge.
   * 'repair' / 'paint' map to repair() / paint(). Resolves { ok, charged, money }.
   */
  charge(reason, amount = 0) {
    if (reason === 'repair') return this.repair(this.game.player?.controllable?.catalogId, amount);
    if (reason === 'paint') return this.paint(amount >= 2500 ? 1 : 0);
    if (reason !== 'hospital' || !this.ready) return Promise.resolve({ ok: false, charged: 0, money: this.money, reason: 'unsupported' });
    return new Promise((resolve) => {
      const entry = { resolve, t: setTimeout(() => { this.hospital.splice(this.hospital.indexOf(entry), 1); resolve({ ok: true, charged: 0, money: this.money }); }, 4000) };
      this.hospital.push(entry);
    });
  }

  // ---------------- services (shop "Service" tab), cosmetics, items ----------------
  /**
   * Buy a service: repair | extinguisher | armor | insurance | claim | nitro | neon | tint | horn | respray.
   * vehicleId: catalog id of an owned model (cosmetics, armour, claim). opts: { color (neon index 0..7 / respray hex),
   * variant (horn), finish ('color' | 'metallic' | 'pearl'), damage (repair 0..1) }.
   * Resolves { ok, reason?, money, cost, inventory, custom } (reasons as rules.servicePrice + funds/rate/offline).
   */
  service(id, vehicleId = null, opts = {}) {
    const op = SERVICE[id];
    if (!op) return Promise.resolve({ ok: false, reason: 'unknown', money: this.money });
    if (id === 'repair') return this.repair(vehicleId ?? this.game.player?.controllable?.catalogId, opts.damage ?? 0);
    const o = opts || {};
    let opt = 255, rgb = 0;
    if (id === 'neon') opt = o.color == null ? 0 : o.color | 0;
    else if (id === 'horn') { const i = HORN_VARIANTS.indexOf(o.variant); opt = i < 0 ? 255 : i; }
    else if (id === 'respray') { opt = Math.max(0, PAINT_FINISHES.indexOf(o.finish || 'color')); rgb = (o.color ?? 0) & 0xffffff; }
    return this._svc(op, vehicleId, opt, rgb, 0);
  }

  /** Free cosmetic changes: { neon: 0..7 | null } (kit installed) or { armor: false } (plating ended). */
  setCosmetic(vehicleId, patch = {}) {
    if ('neon' in patch) return this._svc(SERVICE.NEON_COLOR, vehicleId, patch.neon == null ? 255 : patch.neon | 0, 0, 0);
    if (patch.armor === false) return this._svc(SERVICE.ARMOR_GONE, vehicleId, 255, 0, 0);
    return Promise.resolve({ ok: false, reason: 'unknown', money: this.money });
  }

  /** A carried item was used ('extinguisher'). */
  useItem(item) {
    if (item !== 'extinguisher') return Promise.resolve({ ok: false, reason: 'unknown', money: this.money });
    return this._svc(SERVICE.USE_EXTINGUISHER, null, 255, 0, 0);
  }

  // ---------------- wardrobe ----------------
  /**
   * Buy a wardrobe item (optionally in a colour) or re-dye an owned one: kind 'buy' | 'dye'.
   * Resolves { ok, reason?, money, cost } — reasons: unknown, owned, funds, rate, frozen, offline.
   */
  wardrobe(itemId, colour = null, kind = 'buy') {
    const idx = this.wd.items.indexOf(itemId) + 1;
    if (!idx) return Promise.resolve({ ok: false, reason: 'unknown', money: this.money });
    const c = Number.isInteger(colour) && colour >= 0 && colour <= 0xffffff ? (colour | 0x1000000) >>> 0 : 0;
    return this._svc(WARDROBE_OP.BUY, null, kind === 'dye' ? 1 : 0, c, idx);
  }
  buyClothing(itemId, colour = null) { return this.wardrobe(itemId, colour, 'buy'); }

  /** Wear items: { slot: itemId | null } (economy.outfitSlots) or [itemId]. Owned or free, one per slot. → { ok, reason? } */
  setOutfit(outfit) {
    if (!this.ready) return Promise.resolve({ ok: false, reason: 'offline' });
    // accepts { slot: itemId }, { slot: { id, color } } (D's canonical outfit) or [itemId]
    const vals = Array.isArray(outfit) ? outfit : Object.entries(outfit || {}).filter(([k]) => k !== 'colors').map(([, v]) => v);
    const ids = vals.map((v) => (typeof v === 'string' ? v : v?.id)).filter((id) => typeof id === 'string');
    // on the wire: D's appearance codes (the colour part is the server's business: you wear the colour you own)
    const idx = outfitCodes(ids);
    if (idx.length !== ids.length) return Promise.resolve({ ok: false, reason: 'unknown' });
    const want = {};
    for (const id of ids) { const slot = itemById(id)?.slot || this.wd.slots[this.wd.items.indexOf(id)]; if (slot) want[slot] = id; }
    // the server takes one outfit change per second (and answers RATE to the rest): coalesce quick changes and send
    // the latest one when the window opens, so a "wear" right after a purchase is never dropped
    return new Promise((resolve) => {
      const q = this._fitQ || (this._fitQ = { idx: null, want: null, waiters: [], timer: 0, last: -1e9 });
      q.idx = idx; q.want = want; q.waiters.push(resolve);
      if (q.timer) return;
      const send = () => {
        q.timer = 0;
        q.last = performance.now();
        const waiters = q.waiters.splice(0);
        const done = (r) => { for (const w of waiters) w(r); };
        const entry = { resolve: done, want: q.want, t: setTimeout(() => { this.outfitWait.splice(this.outfitWait.indexOf(entry), 1); done({ ok: false, reason: 'timeout' }); }, 5000) };
        this.outfitWait.push(entry);
        this.client.send(encodeOutfit(q.idx));
      };
      const wait = q.last + 1100 - performance.now();
      if (wait > 0) q.timer = setTimeout(send, wait); else send();
    });
  }

  // ---------------- nickname ----------------
  /**
   * Nickname changes (economy.changeNick → net.changeNick): mode 'reroll' | 'random' (generator; the first reroll of a
   * profile is free, then $2,500), 'custom' ($50,000: format, blocklist, not generated-looking, unique), 'check'
   * (free availability check of `value`), 'suggest' (three free-to-check ideas, computed locally).
   * Resolves { ok, reason?, money, nick, code, cost?, available?, suggestions?, cooldownS }.
   */
  changeNick(mode = 'reroll', value = '') {
    if (mode && typeof mode === 'object') { value = mode.value ?? ''; mode = mode.mode ?? 'reroll'; }
    if (mode === 'suggest') return Promise.resolve({ ok: true, suggestions: suggestNames(3) });
    if (mode === 'check') return this._nickReq(NICK_OP.CHECK, String(value || '')).then((r) => ({ ...r, ok: r.ok, available: r.ok }));
    if (mode === 'custom') return this._nickReq(NICK_OP.CUSTOM, String(value || ''));
    if (mode === 'reroll' || mode === 'random') return this._nickReq(NICK_OP.REROLL, '');
    return Promise.resolve({ ok: false, reason: 'mode' });
  }
  rerollNick() { return this.changeNick('reroll'); }
  setNickname(name) { return this.changeNick('custom', name); }
  checkNickname(name) { return this.changeNick('check', name); }
  get nickPrices() { return { reroll: nickPrice('reroll', this.rerolls), custom: nickPrice('custom') }; }

  _nickReq(op, name) {
    if (!this.ready) return Promise.resolve({ ok: false, reason: 'offline' });
    const reqId = (this.seq = (this.seq + 1) & 0xffff) || (this.seq = 1);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.nickWait.delete(reqId); resolve({ ok: false, reason: 'timeout' }); }, 8000);
      this.nickWait.set(reqId, (r) => { clearTimeout(t); resolve(r); });
      this.client.send(encodeNickReq(op, reqId, name));
    });
  }

  _nick(n) {
    const check = n.op === NICK_OP.CHECK;
    const before = this.money;
    if (n.money >= 0) this.money = n.money;
    this.rerolls = n.rerolls | 0;
    const nick = n.name || this.client.displayName({ nickCode: n.nickCode });
    const res = {
      ok: n.result === NICK_RESULT.OK, reason: NICK_REASON[n.result], nick, name: n.name, code: n.nickCode, nickCode: n.nickCode,
      money: n.money, cooldownS: n.cooldownS, cost: Math.max(0, before - this.money),
    };
    if (res.ok && !check) {
      this.client.setMyName?.(n.nickCode, n.name);
      this._push({ money: this.money, nick: { code: n.nickCode, name: this.client.displayName({ nickCode: n.nickCode }), custom: n.name || null, rerolls: this.rerolls } });
    }
    const fn = this.nickWait.get(n.reqId);
    if (fn) { this.nickWait.delete(n.reqId); fn(res); }
    if (!check) this.game.events?.emit('net:nick', res);
  }

  _svc(op, vehicleId, opt, rgb, item) {
    if (!this.ready) return Promise.resolve({ ok: false, reason: 'offline', money: this.money });
    let model = 0;
    if (vehicleId != null) {
      model = this.client.modelIndex.get(vehicleId) ?? 0;
      if (!model) return Promise.resolve({ ok: false, reason: 'unknown', money: this.money });
    }
    const reqId = (this.seq = (this.seq + 1) & 0xffff) || (this.seq = 1);
    return new Promise((resolve) => {
      const entry = { op, resolve, reply: null, t: 0, svc: true };
      entry.t = setTimeout(() => { this.econ.delete(reqId); resolve(entry.reply ? this._econResult(entry.reply) : { ok: false, reason: 'timeout', money: this.money }); }, 5000);
      this.econ.set(reqId, entry);
      this.client.send(encodeService(op, reqId, model, opt, rgb, item));
    });
  }

  _garage(g) {
    if (g.inventory) this.inventory = { extinguisher: g.inventory.extinguisher | 0, insuranceUntil: +g.inventory.insuranceUntil || 0 };
    if (g.custom && typeof g.custom === 'object') this.custom = g.custom;
    if (Array.isArray(g.wardrobe)) { this.wd.items = g.wardrobe; this.wd.slots = g.wardrobeSlots || []; }
    if (g.clothes && typeof g.clothes === 'object') this.wd.owned = new Map(Object.entries(g.clothes));
    if (g.outfit && typeof g.outfit === 'object' && !Array.isArray(g.outfit)) this.wd.outfit = g.outfit;
    if (Number.isFinite(g.rerolls)) this.rerolls = g.rerolls;
    // settle a service / wardrobe purchase waiting for the new inventory
    for (const [reqId, e] of this.econ) if (e.svc && e.reply) this._settleEcon(reqId, e);
    const w = this.client.welcome || this.client.lastWelcome;
    this._push({
      inventory: this.inventory, custom: this.custom, wardrobe: Object.fromEntries(this.wd.owned), outfit: { ...this.wd.outfit },
      nick: w ? { code: w.nickCode, name: this.client.displayName({ nickCode: w.nickCode }), custom: w.name || null, rerolls: this.rerolls } : undefined,
    });
    this.game.events?.emit('net:wardrobe', { owned: Object.fromEntries(this.wd.owned), outfit: { ...this.wd.outfit } });
  }

  onWallet(cb) { this.listeners.add(cb); cb(this.snapshot()); return () => this.listeners.delete(cb); }

  snapshot() {
    return {
      money: this.money, owned: [...this.owned], worth: this.worth, combo: this.combo, rank: this.rank, progress: this.progress, frozen: this.frozen,
      inventory: this.inventory, custom: this.custom,
    };
  }

  // ---------------- internals ----------------
  _econ(op, id, param) {
    if (!this.ready) return Promise.resolve({ ok: false, reason: 'offline', money: this.money });
    let model = 0;
    if (id != null) {
      model = this.client.modelIndex.get(id) ?? 0;
      if (!model) return Promise.resolve({ ok: false, reason: 'unknown', money: this.money });
    }
    const reqId = (this.seq = (this.seq + 1) & 0xffff) || (this.seq = 1);
    return new Promise((resolve) => {
      const entry = { op, resolve, reply: null, t: 0 };
      entry.t = setTimeout(() => { this.econ.delete(reqId); resolve(entry.reply ? this._econResult(entry.reply) : { ok: false, reason: 'timeout', money: this.money }); }, 5000);
      this.econ.set(reqId, entry);
      this.client.send(encodeEcon(op, reqId, model, param));
    });
  }

  _econResult(r) {
    return {
      ok: r.result === ECON_RESULT.OK, reason: RESULT_REASON[r.result], money: r.money, delta: r.delta, cost: -Math.min(0, r.delta), price: Math.abs(r.delta),
      owned: [...this.owned], inventory: this.inventory, custom: this.custom,
    };
  }

  _econReply(r) {
    this.money = r.money;
    if (r.op === WARDROBE_OP.BUY + 1 && !r.reqId) { // outfit
      const w = this.outfitWait.shift();
      if (w) {
        clearTimeout(w.t);
        if (r.result === ECON_RESULT.OK) this.wd.outfit = w.want; // S_GARAGE confirms right after
        w.resolve({ ok: r.result === ECON_RESULT.OK, reason: RESULT_REASON[r.result] });
      }
      return;
    }
    const e = this.econ.get(r.reqId);
    if (!e) { this._push({ money: r.money }); return; }
    e.reply = r;
    // purchases/sales: the ownership list follows in the same tick; settle when it arrives
    if (r.result === ECON_RESULT.OK && (r.op === ECON.BUY || r.op === ECON.SELL) && !e.svc) return;
    if (r.result === ECON_RESULT.OK && e.svc && r.op !== SERVICE.NEON_COLOR && r.op !== SERVICE.ARMOR_GONE) return; // S_GARAGE follows
    this._settleEcon(r.reqId, e);
  }

  _settleEcon(reqId, e) {
    clearTimeout(e.t);
    this.econ.delete(reqId);
    this._push({ money: e.reply.money });
    e.resolve(this._econResult(e.reply));
  }

  _owned(o) {
    const ids = [];
    for (const i of o.owned) { const m = this.client.models[i]; if (m) ids.push(m.id); }
    this.owned = new Set(ids);
    this.worth = o.worth;
    for (const [reqId, e] of this.econ) if (e.reply && (e.op === ECON.BUY || e.op === ECON.SELL)) this._settleEcon(reqId, e);
    this._push({ owned: ids, worth: o.worth });
  }

  _wallet(w) {
    this.money = w.balance;
    if (Number.isFinite(w.worth)) this.worth = w.worth;
    if (w.combo >= 1) this.combo = w.combo;
    if (w.result === WALLET.FROZEN) this.frozen = true;
    const fn = w.seq ? this.claims.get(w.seq) : null;
    if (fn) {
      this.claims.delete(w.seq);
      fn({ ok: w.delta > 0, granted: Math.max(0, w.delta), money: w.balance, result: w.result, combo: w.combo, worth: w.worth });
    }
    const state = { money: w.balance, worth: w.worth, combo: w.combo };
    if (w.result === WALLET.GRANTED && !w.seq && w.reason === CLAIM.DAILY) state.daily = { amount: w.delta, streak: this.progress?.ds ?? 1 };
    if (w.result === WALLET.CHARGE && w.delta < 0 && this.hospital.length) {
      for (const h of this.hospital.splice(0)) { clearTimeout(h.t); h.resolve({ ok: true, charged: -w.delta, money: w.balance }); }
    }
    this._push(state);
  }

  _push(state) {
    const eco = this.game.economy;
    if (eco?.applyServer) {
      const s = { ...state };
      if (s.owned === undefined && this.owned.size) s.owned = [...this.owned];
      try { eco.applyServer(s); } catch (e) { console.error('[net] economy.applyServer', e); }
    } else if (this.game.player && Number.isFinite(this.money)) {
      this.game.player.money = this.money; // no economy module: the HUD reads player.money
    }
    this._emit();
  }

  _emit() { const s = this.snapshot(); for (const cb of this.listeners) { try { cb(s); } catch (e) { console.error(e); } } }

  _failAll() {
    for (const fn of this.claims.values()) fn({ ok: false, granted: 0, money: this.money, reason: 'offline' });
    this.claims.clear();
    for (const [, e] of this.econ) { clearTimeout(e.t); e.resolve({ ok: false, reason: 'offline', money: this.money }); }
    this.econ.clear();
  }

  // Legacy income path (Score / Cash call player.addMoney(n, pos, reason)): online it becomes a claim, never a local
  // balance change. With game.economy it goes through economy.earn (same caps as the server).
  _installAddMoney() {
    const p = this.game.player;
    if (!p || p.addMoney?.__net || p.addMoney?.__economy) return;
    const orig = p.addMoney?.bind(p);
    const g = this.game;
    const wrapped = (n, pos, reason = 'pickup') => {
      n = Math.round(n);
      if (!(n > 0)) return;
      const r = typeof reason === 'string' ? reason : 'pickup';
      if (g.mode !== 'online' || !this.client.everOnline) { orig?.(n, pos, reason); return; }
      if (g.economy?.earn) {
        const got = g.economy.earn(r === 'near' ? 'nearmiss' : r, n, pos);
        if (got > 0) g.events.emit('money:pickup', { amount: got, position: pos, reason: r });
        return;
      }
      this.claim(r, n, pos).then((res) => { if (res.granted > 0) g.events.emit('money:pickup', { amount: res.granted, position: pos, reason: r }); });
    };
    wrapped.__net = true;
    p.addMoney = wrapped;
  }

  dispose() { for (const off of this._off) off(); }
}

// ideas for a custom name (they never look generated: the server would refuse those)
function suggestNames(n) {
  const out = new Set();
  const r = (a) => a[Math.floor(Math.random() * a.length)];
  while (out.size < n) {
    const a = r(ADJECTIVES), b = r(NOUNS), k = Math.floor(Math.random() * 3);
    const name = k === 0 ? `${a}_${b}` : k === 1 ? `${b}-${100 + Math.floor(Math.random() * 900)}` : `${a}${b}_${Math.floor(Math.random() * 90) + 10}`;
    if (name.length >= 3 && name.length <= 16) out.add(name);
  }
  return [...out];
}
