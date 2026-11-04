// game.economy — the wallet, the garage (owned vehicles), progress (collectibles, medals, districts, daily streak) and
// the GTA-style skill combo. docs/ECONOMY.md is the design; ./rules.js holds every formula and cap.
//
// Authority:
//  - singleplayer (and online without a server connection): local, persisted in localStorage;
//  - online with game.net: the server is authoritative. Income is shown optimistically (pending claims) and
//    reconciled with the server balance; purchases/sales wait for the server. See src/economy/INTEGRATION.md.
//
// No three.js and no DOM at import time: node tests construct it with a stub game.
import { PRICES } from './prices.js';
import WARDROBE_TABLE from './wardrobe-prices.json' with { type: 'json' };
import * as R from './rules.js';
import { onlineVehiclePrice, cashWorth } from './online.js';
import { randomNickCode, nickName, nameFormatError, looksGenerated } from '../net/shared/nicknames.js';

const SAVE_VERSION = 1;
const PENDING_TTL = 6; // s: an optimistic claim the server never answered is dropped after this
const NON_LAND = new Set(['boat', 'heli', 'plane']);
const VISIT_DELAY = 3; // s after start before district discovery kicks in (spawn, welcome message)

export class Economy {
  /**
   * @param game the game context (events, player, mode, can(), net?, ui?, world3d?, spawns?)
   * @param opts { prices?, storage?, saveKey?, clock?: () => epoch ms }
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.prices = opts.prices || PRICES;
    if (game.mode === 'online') this.prices = Object.fromEntries(Object.entries(this.prices).map(([id,p]) => [id,onlineVehiclePrice(id,p)]));
    this.clock = opts.clock || (() => Date.now());
    this.storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    this.saveKey = opts.saveKey || (game.mode === 'single' ? 'leonida.save.single' : 'leonida.save.offline');
    this.starters = new Set(Object.keys(this.prices).filter((id) => this.prices[id].starter));
    this.starterCar = [...this.starters].find((id) => this.prices[id].cls !== 'bicycle') || 'pip';
    this.starterBike = [...this.starters].find((id) => this.prices[id].cls === 'bicycle') || null;
    if (game.mode === 'online') { this.starterCar = 'pip'; this.starterBike = 'kickflip'; }
    this.districtNames = (game.worldData?.districts || []).map((d) => d.name);

    this._listeners = new Set();
    this._cool = new Map(); // cooldown key → wall-clock s of the last paid claim
    this._minute = []; // [t, amount, reason] for per-minute caps (pickups)
    this._pending = []; // online: optimistic claims/charges awaiting the server
    this.server = null; // online: last authoritative state { money, worth }
    this.combo = 1;
    this.comboT = 0; // s left in the combo window
    this._hold = false;
    this._mirrored = null;
    this._saveTimer = null;
    this._posT = 0;
    this._visitT = 0;
    this._visitArmed = false;
    this.newPlayer = false;

    this._reset();
    this.load();
    this._recalc();

    const ev = game.events;
    this._off = [];
    if (ev) {
      this._off.push(ev.on('impact', (e) => this._onImpact(e)));
      this._off.push(ev.on('vehicle:enter', (e) => this._onEnter(e?.vehicle)));
      this._off.push(ev.on('vehicle:destroyed', (e) => this._onDestroyed(e?.vehicle)));
      this._off.push(ev.on('start', () => { this._visitArmed = true; this._visitT = VISIT_DELAY; this._daily(); }));
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      this._flush = () => this.save();
      this._vis = () => { if (document.visibilityState === 'hidden') this.save(); };
      window.addEventListener('beforeunload', this._flush);
      document.addEventListener?.('visibilitychange', this._vis);
    }
  }

  // ---------------------------------------------------------------- state
  _reset() {
    this._money = R.START_MONEY;
    this.owned = new Set(this.starters);
    this.found = new Set(); // collectible ids
    this.medals = {}; // trial id → tier bitmask (1 gold, 2 silver, 4 bronze)
    this.districts = new Set(); // district / region names visited
    this.stunts = new Set(); // named stunt spots completed
    this.traps = {}; // speed trap id → best km/h
    this.daily = { last: null, streak: 0 };
    this.exportCd = {}; // model id → epoch ms when it can be exported again
    this.inventory = { extinguisher: 0, insuranceUntil: 0 }; // carried items, insurance expiry (epoch ms)
    this.customs = {}; // model id → { neonKit, neon, tint, horn, paint, finish, armor } (persisted per owned vehicle)
    this.wrecked = {}; // model id → epoch ms destroyed without insurance (the next garage call is a $1,000 claim)
    this.wardrobe = {}; // wardrobe item id → colour (hex | null) of owned items (starter items are implicit)
    this.outfitSlots = {}; // slot → item id (what the player wears)
    this.nick = { code: null, name: null, custom: null, rerolls: 0 }; // nickname (online: from the server)
    this.last = null; // { x, z, vehicle, land }
    this.unlockAll = false;
    this.stats = { earned: 0, spent: 0, by: {}, created: this.clock(), playS: 0 };
  }

  /**
   * Online with a network layer: the server owns the wallet — while connecting and after the first connection. If the
   * server was unreachable from the start (J: net.offlineRestored, never online), the local offline wallet is used.
   */
  get remote() {
    const n = this.game.net;
    if (this.game.mode !== 'online' || !n) return false;
    return !!(n.client?.everOnline || n.online) || !n.offlineRestored;
  }
  /** Online and the server has sent its state at least once. */
  get synced() { return this.remote && !!this.server; }
  /** Sandbox cash / unlock controls are available (singleplayer only). */
  get sandbox() { return !this.remote && (this.game.can ? this.game.can('money') : this.game.mode === 'single'); }

  /** Current cash (integer). Online: last server balance + optimistic pending income; else the local wallet. */
  get money() {
    if (!this.remote) return this._money;
    let m = this.server ? this.server.money : 0;
    for (const p of this._pending) m += p.amount;
    return Math.max(0, Math.round(m));
  }
  /** Seconds left in the combo window (0 = no chain). */
  get comboTimeLeft() { return this.comboT; }

  owns(id) { return (this.unlockAll && this.sandbox && !!this._p(id)) || this.owned.has(id); }
  isStarter(id) { return this.starters.has(id); }
  price(id) { return this._p(id)?.price ?? null; }
  priceClass(id) { return this._p(id)?.cls ?? null; }

  /**
   * Price entry { price, cls, starter, traffic } of a catalog id: the shared table (src/economy/prices.json), or —
   * for catalog entries added after the table was generated — the catalog price / class formula (warns once; rerun
   * tools/economy/build-prices.mjs; the server rejects ids it does not know).
   */
  _p(id) {
    const t = this.prices[id];
    if (t) return t;
    if (!id) return null;
    this._extra ||= new Map();
    if (this._extra.has(id)) return this._extra.get(id);
    const e = this.game.vehicles?.byId?.get?.(id);
    let out = null;
    if (e) {
      const cls = R.priceClass(e.category, e.kind);
      out = { price: e.price > 0 ? Math.round(e.price) : R.classPrice(cls, e.tier ?? 0.3), cls, starter: false, traffic: e.trafficWeight ?? 0 };
      console.warn(`[economy] ${id} is not in src/economy/prices.json — run node tools/economy/build-prices.mjs`);
    }
    this._extra.set(id, out);
    return out;
  }
  /** Owned vehicle ids (starters included). */
  ownedList() { return [...this.owned]; }
  /** What selling `id` returns now (55% of the price × condition of the car you are driving, if it is that model). */
  sellPrice(id) {
    const p = this.price(id);
    if (p == null || this.isStarter(id)) return 0;
    return R.sellPrice(p, this._conditionOf(id));
  }
  /** Leaderboard value: cash + the garage sale value of sellable vehicles. */
  netWorth() {
    if (this.remote) return cashWorth(this.money);
    if (this.server && Number.isFinite(this.server.worth) && !this._pending.length) return this.server.worth;
    return R.netWorth(this.money, this.owned, (id) => this._p(id));
  }

  onChange(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }

  /** Seconds until `reason` (rules.REASONS) can pay again (0 = now). */
  cooldownLeft(reason) {
    const rule = R.REASONS[reason];
    if (!rule?.cooldown) return 0;
    return Math.max(0, rule.cooldown - (this.clock() / 1000 - (this._cool.get(reason) ?? -1e9)));
  }

  /** Export cooldown of a model (10 min after exporting it): seconds left, 0 = free. */
  exportCooldownLeft(id) {
    return Math.max(0, ((this.exportCd[id] ?? 0) - this.clock()) / 1000);
  }

  markExported(id) {
    this.exportCd[id] = this.clock() + R.EXPORT.modelCooldownS * 1000;
    this.saveSoon(true);
  }

  // ---------------------------------------------------------------- income
  /** Income multiplier for `reason`: rules.ONLINE.mult while the server is authoritative (multiplayer), else 1. UIs that
   * show a payout before it is earned (job offers, export values, race purses) multiply by this. */
  incomeScale(reason = 'delivery') { return R.incomeScale(reason, !!this.remote); }

  /**
   * Gameplay income. Applies the per-reason cap, cooldown and per-minute limit of rules.REASONS (the same ceilings
   * the server uses), then credits locally or claims from the server (optimistic). Returns the amount granted now.
   * Does not emit `money:pickup` (callers that want the +$ pop emit it with the returned amount).
   */
  earn(reason, amount, pos = null, meta = null) {
    const key = R.REASONS[reason] ? reason : 'other';
    const rule = R.REASONS[key];
    // online every payout is the base formula × rules.ONLINE.mult (the server recomputes and caps the same way)
    const k = this.incomeScale(key);
    amount = Math.round(amount * k);
    if (!(amount > 0)) return 0;
    const now = this.clock() / 1000;
    if (rule.cooldown && now - (this._cool.get(key) ?? -1e9) < rule.cooldown) return 0;
    let g = Math.min(amount, rule.max * k);
    if (rule.perMinute) {
      let used = 0;
      for (let i = this._minute.length - 1; i >= 0; i--) {
        const m = this._minute[i];
        if (now - m[0] > 60) { this._minute.splice(0, i + 1); break; }
        if (m[2] === key) used += m[1];
      }
      g = Math.min(g, rule.perMinute - used);
      if (g <= 0) return 0;
      this._minute.push([now, g, key]);
    }
    this._cool.set(key, now);
    if (this.remote) this._claim(key, g, pos, meta, now);
    else this._money += g;
    this.stats.earned += g;
    this.stats.by[key] = (this.stats.by[key] || 0) + g;
    this._changed(key, g);
    this.game.events?.emit('economy:earn', { reason: key, amount: g, requested: amount, position: pos, combo: meta?.combo ?? 1 });
    if (!this.remote) this.saveSoon();
    return g;
  }

  /**
   * A skill event (drift, near miss, stunt, speed trap): raises the combo (+0.5 if within 6 s of the previous one, max ×5)
   * and pays base × combo through earn(). Returns the amount granted.
   */
  skill(reason, base, pos = null, meta = null) {
    this.bump();
    return this.earnSkill(reason, base, pos, meta);
  }

  /** Pay base × current combo for a skill reason without raising the combo (bundled events). */
  earnSkill(reason, base, pos = null, meta = null) {
    const m = meta || {};
    m.combo = this.combo;
    return this.earn(reason, base * this.combo, pos, m);
  }

  /** Raise the combo for a skill event (chained within the window → +0.5, else ×1) and restart the window. */
  bump() {
    const prev = this.combo;
    this.combo = R.nextCombo(this.combo, this.comboT > 0);
    this.comboT = R.COMBO.window;
    if (this.combo !== prev) this._emitCombo();
    return this.combo;
  }

  /** Keep the combo window from draining this frame (a drift or a jump is in progress). */
  holdCombo() { this._hold = true; }

  resetCombo(why = 'timeout') {
    this.comboT = 0;
    if (this.combo === 1) return;
    this.combo = 1;
    this._emitCombo(why);
  }

  _emitCombo(why) {
    this.game.events?.emit('economy:combo', { combo: this.combo, t: this.comboT, window: R.COMBO.window, reason: why });
  }

  // ---------------------------------------------------------------- sinks
  /**
   * Charge a fee. reason 'hospital' computes the fee itself (5% of cash, $50..$5,000) and may take less than asked
   * when cash is short; other reasons charge `amount` only if it can be paid in full. Returns the amount charged.
   */
  charge(reason, amount = null) {
    const hospital = reason === 'hospital';
    const cash = this.money;
    let a = hospital && amount == null ? R.hospitalFee(cash) : Math.round(amount ?? 0);
    if (!(a > 0)) return 0;
    if (a > cash) {
      if (!hospital) return 0;
      a = Math.floor(cash);
      if (a <= 0) return 0;
    }
    if (this.remote) {
      const now = this.clock() / 1000;
      const entry = { amount: -a, t: now };
      this._pending.push(entry);
      const p = this.game.net.charge?.(reason, a);
      if (p && typeof p.then === 'function') p.then((res) => this._settle(entry, res), () => this._settle(entry, null));
      this._recalc();
    } else {
      this._money -= a;
      this.saveSoon();
    }
    this.stats.spent += a;
    this._changed(reason, -a);
    this.game.events?.emit('economy:charge', { reason, amount: a });
    return a;
  }

  /** Buy a vehicle model. Resolves { ok, reason? } — reasons: unknown, owned, funds, syncing, offline, … */
  async buy(id) {
    const p = this._p(id);
    if (!p) return { ok: false, reason: 'unknown' };
    if (this.owned.has(id)) return { ok: false, reason: 'owned' };
    if (this.money < p.price) return { ok: false, reason: 'funds' };
    if (this.remote) {
      if (!this.server) return { ok: false, reason: 'syncing' };
      const res = await this._net('buy', id);
      if (!res.ok) return { ok: false, reason: res.reason || 'rejected' };
      this.owned.add(id);
      if (Array.isArray(res.owned)) this._setOwned(res.owned);
      this._serverMoney(Number.isFinite(res.money) ? res.money : this.server.money - p.price);
    } else {
      this._money -= p.price;
      this.owned.add(id);
      this.save();
    }
    this.stats.spent += p.price;
    this._changed('purchase', -p.price);
    this.game.events?.emit('economy:purchase', { id, price: p.price });
    return { ok: true, price: p.price };
  }

  /** Sell an owned, non-starter model for sellPrice(id). Resolves { ok, reason?, price? }. */
  async sell(id) {
    const p = this._p(id);
    if (!p) return { ok: false, reason: 'unknown' };
    if (this.starters.has(id)) return { ok: false, reason: 'starter' };
    if (!this.owned.has(id)) return { ok: false, reason: this.unlockAll ? 'unlocked' : 'notOwned' };
    const cond = this._conditionOf(id);
    const gets = R.sellPrice(p.price, cond);
    if (this.remote) {
      if (!this.server) return { ok: false, reason: 'syncing' };
      const res = await this._net('sell', id, cond);
      if (!res.ok) return { ok: false, reason: res.reason || 'rejected' };
      this.owned.delete(id);
      if (Array.isArray(res.owned)) this._setOwned(res.owned);
      this._serverMoney(Number.isFinite(res.money) ? res.money : this.server.money + gets);
    } else {
      this._money += gets;
      this.owned.delete(id);
      this.save();
    }
    this._changed('sale', gets);
    this.game.events?.emit('economy:sell', { id, price: gets });
    return { ok: true, price: gets };
  }

  /** Repair cost of a vehicle: ceil(damage × price × 1.2%), min $100, free for starters; 0 when undamaged. */
  repairCost(v) {
    const id = v?.catalogId;
    const p = this.price(id);
    if (p == null) return 0;
    return R.repairCost(p, damageOf(v), this.isStarter(id));
  }

  /** Instant repair of an owned vehicle (body shop / menu). Resolves { ok, cost?, reason? }. */
  async repair(v) {
    const id = v?.catalogId;
    if (!v || !this._p(id)) return { ok: false, reason: 'unknown' };
    if (!this.owns(id)) return { ok: false, reason: 'notOwned' };
    const dmg = damageOf(v);
    if (dmg <= 0.005) return { ok: false, reason: 'undamaged' };
    const cost = this.repairCost(v);
    if (cost > this.money) return { ok: false, reason: 'funds' };
    if (this.remote) {
      if (!this.server) return { ok: false, reason: 'syncing' };
      const res = await this._net('repair', id, dmg);
      if (!res.ok) return { ok: false, reason: res.reason || 'rejected' };
      this._serverMoney(Number.isFinite(res.money) ? res.money : this.server.money - cost);
    } else if (cost > 0) {
      this._money -= cost;
      this.saveSoon();
    }
    if (cost > 0) { this.stats.spent += cost; this._changed('repair', -cost); }
    if (this.game.damage?.repair) this.game.damage.repair(v); else v.damage?.repair?.(); // health, dents, glass, lamps
    this._armorGone(id); // plating lasts until the next repair
    this.game.events?.emit('economy:repair', { id, cost });
    return { ok: true, cost };
  }

  /** Paint job: 'color' $500, 'pearl'/'metallic' $2,500. Resolves { ok, cost?, reason? }; the caller applies the paint. */
  async paint(kind = 'color') {
    const cost = R.PAINT[kind] ?? R.PAINT.color;
    if (cost > this.money) return { ok: false, reason: 'funds' };
    if (this.remote) {
      if (!this.server) return { ok: false, reason: 'syncing' };
      const res = await this._net('paint', kind === 'color' ? 0 : 1);
      if (!res.ok) return { ok: false, reason: res.reason || 'rejected' };
      this._serverMoney(Number.isFinite(res.money) ? res.money : this.server.money - cost);
    } else {
      this._money -= cost;
      this.saveSoon();
    }
    this.stats.spent += cost;
    this._changed('paint', -cost);
    return { ok: true, cost };
  }

  // ---------------------------------------------------------------- progress (collectibles, races, traps, stunts)
  /** A collectible postcard was found: $1,000, +$10,000 every 10th, +$100,000 for all 60. Returns the amount paid. */
  collect(id, pos = null) {
    if (this.found.has(id)) return 0;
    const n = this.found.size + 1;
    const pay = this.earn('collectible', R.collectiblePay(n), pos, { id, count: n });
    if (pay > 0 || this.remote) { this.found.add(id); this.saveSoon(true); }
    this.game.events?.emit('economy:collectible', { id, count: this.found.size, total: R.COLLECTIBLES.total, paid: pay });
    return pay;
  }

  /**
   * A time-trial medal. tier: 'gold' | 'silver' | 'bronze'; purse $4k–$15k (rules.racePurse(length)). The first medal of
   * each tier pays in full, repeats 20%; ≤ 1 payout per trial per 60 s. Returns the amount paid.
   */
  medal(trial, tier, purse, pos = null, timeS = 0) {
    const bit = 1 << ((R.RACE.tierIndex[tier] ?? 3) - 1);
    const now = this.clock() / 1000;
    const ck = `race:${trial}`;
    if (now - (this._cool.get(ck) ?? -1e9) < R.RACE.perTrialCooldownS) return 0;
    const first = !((this.medals[trial] ?? 0) & bit);
    const pay = this.earn('race', R.racePay(purse, tier, first), pos, { trial, tier: R.RACE.tierIndex[tier], time: timeS, first });
    if (pay > 0) {
      this._cool.set(ck, now);
      this.medals[trial] = (this.medals[trial] ?? 0) | bit;
      this.saveSoon(true);
    }
    return pay;
  }

  /** Speed trap crossing (workstream I): skill event, ×2 on a new personal best at that trap. Returns the amount paid. */
  speedTrap(trap, kmh, pos = null) {
    const now = this.clock() / 1000;
    const ck = `trap:${trap}`;
    if (now - (this._cool.get(ck) ?? -1e9) < 10) return 0;
    const best = this.traps[trap] ?? 0;
    const pb = kmh > best + 0.5;
    const pay = this.skill('speedtrap', R.speedTrapPay(kmh, pb, 1), pos, { trap, kmh, pb });
    if (pay > 0) {
      this._cool.set(ck, now);
      if (pb) this.traps[trap] = Math.round(kmh * 10) / 10;
      this.saveSoon();
    }
    return pay;
  }

  /** True the first time a named stunt spot is completed (×5 stunt payout). Call markStunt after paying. */
  firstAtStunt(spot) { return spot != null && !this.stunts.has(spot); }
  markStunt(spot) { if (spot != null) { this.stunts.add(spot); this.saveSoon(); } }

  // ---------------------------------------------------------------- services (shop "Service" tab)
  /** Service catalogue: [{ id, kind, price, max?, … }] (rules.SERVICES). */
  get services() { return R.SERVICE_IDS.map((id) => ({ id, ...R.SERVICES[id] })); }
  /** True while the 24 h insurance pass runs. */
  get insured() { return this.inventory.insuranceUntil > this.clock(); }
  insuranceLeftS() { return Math.max(0, (this.inventory.insuranceUntil - this.clock()) / 1000); }
  /** Cosmetics / armour record of an owned model (or null). */
  custom(id) { return this.customs[id] || null; }
  /** A destroyed owned model waiting for a replacement claim ($1,000, free while insured). */
  isWrecked(id) { return !!this.wrecked[id] && !this.starters.has(id); }
  /** Can the garage spawn `id` now? → { ok, fee, reason? } (fee > 0: the spawn will charge a replacement claim). */
  spawnCheck(id) {
    if (!this.owns(id)) return { ok: false, fee: 0, reason: 'notOwned' };
    if (!this.isWrecked(id)) return { ok: true, fee: 0 };
    const q = this.serviceQuote('claim', id);
    return q.price > this.money ? { ok: false, fee: q.price, reason: 'funds' } : { ok: true, fee: q.price };
  }

  _vehicleFor(id) {
    const v = this.game.player?.controllable;
    return v && v.catalogId === id && !v.fromTraffic ? v : null;
  }

  /** Price check for a service on a model (default: the vehicle you are driving). → { ok, price, reason? } */
  serviceQuote(id, vehicleId = null, opts = {}) {
    const vid = vehicleId ?? this.game.player?.controllable?.catalogId ?? null;
    const p = vid ? this._p(vid) : null;
    const v = vid ? this._vehicleFor(vid) : null;
    const ctx = {
      price: p?.price ?? 0, cls: p?.cls, kind: v?.kind ?? this.game.vehicles?.byId?.get?.(vid)?.kind, starter: this.starters.has(vid),
      owned: !!vid && this.owned.has(vid), insured: this.insured, extinguishers: this.inventory.extinguisher,
      damage: v ? damageOf(v) : 0, custom: this.customs[vid], opts,
    };
    const R0 = R.SERVICES[id];
    // services that need a vehicle you are in
    if ((id === 'repair' || id === 'nitro') && !v) {
      const cur = this.game.player?.controllable;
      return { ok: false, price: R0?.price ?? 0, reason: cur?.fromTraffic ? 'notOwned' : 'noVehicle' };
    }
    if (id === 'nitro') {
      const lvl = this.game.services?.nitroLevel?.(v);
      if (lvl == null) return { ok: false, price: R0.price, reason: 'noNitro' };
      if (lvl > 0.98) return { ok: false, price: R0.price, reason: 'full' };
    }
    if (id === 'repair' && ctx.starter && ctx.damage > 0.005) return { ok: true, price: 0 };
    return R.servicePrice(id, ctx);
  }

  /**
   * Buy a service. id: repair | extinguisher | armor | insurance | claim | nitro | neon | tint | horn | respray.
   * vehicleId: catalog id of an owned model (default: the one you drive). opts: { color (neon index 0..7 / paint hex),
   * variant (horn), finish ('color' | 'metallic' | 'pearl') }. Resolves { ok, cost?, reason? } (never rejects).
   */
  async buyService(id, vehicleId = null, opts = {}) {
    const vid = vehicleId ?? this.game.player?.controllable?.catalogId ?? null;
    if (id === 'repair') {
      const v = vid ? this._vehicleFor(vid) : null;
      if (!v) return { ok: false, reason: 'noVehicle' };
      const r = await this.repair(v);
      if (r.ok) this.game.events?.emit('economy:service', { id, vehicleId: vid, cost: r.cost });
      return r;
    }
    const q = this.serviceQuote(id, vid, opts);
    if (!q.ok) return { ok: false, reason: q.reason, cost: q.price };
    const cost = q.price;
    if (cost > this.money) return { ok: false, reason: 'funds', cost };
    if (this.remote) {
      if (!this.server) return { ok: false, reason: 'syncing', cost };
      const res = await this._net('service', id, vid, opts);
      if (!res.ok) return { ok: false, reason: res.reason || 'rejected', cost };
      if (res.inventory) this.inventory = { extinguisher: res.inventory.extinguisher | 0, insuranceUntil: +res.inventory.insuranceUntil || 0 };
      this._serverMoney(Number.isFinite(res.money) ? res.money : this.server.money - cost);
    } else if (cost > 0) {
      this._money -= cost;
    }
    this._grantService(id, vid, opts, !!this.remote);
    if (cost > 0) { this.stats.spent += cost; this.stats.by[`service:${id}`] = (this.stats.by[`service:${id}`] || 0) - cost; }
    this._changed(`service:${id}`, -cost);
    this.game.events?.emit('economy:service', { id, vehicleId: vid, cost, opts });
    this.saveSoon(true);
    return { ok: true, cost };
  }

  // apply what was bought (locally; online the server already stored inventory/customs and echoes them)
  _grantService(id, vid, opts, fromServer) {
    const svc = this.game.services;
    const c = () => (this.customs[vid] ||= {});
    const v = vid ? this._vehicleFor(vid) : null;
    switch (id) {
      case 'extinguisher':
        if (!fromServer) this.inventory.extinguisher = Math.min(R.SERVICES.extinguisher.max, this.inventory.extinguisher + 1);
        break;
      case 'insurance':
        if (!fromServer) this.inventory.insuranceUntil = Math.max(this.clock(), this.inventory.insuranceUntil) + R.SERVICES.insurance.durationS * 1000;
        break;
      case 'claim': delete this.wrecked[vid]; break;
      case 'nitro': svc?.refillNitro?.(v); break;
      case 'armor': c().armor = true; if (v) svc?.setArmor?.(v, true); break;
      case 'neon': c().neonKit = true; c().neon = opts.color ?? 0; if (v) svc?.apply?.(v); break;
      case 'tint': c().tint = true; if (v) svc?.apply?.(v); break;
      case 'horn': c().horn = opts.variant; if (v) svc?.apply?.(v); break;
      case 'respray': c().paint = opts.color; c().finish = opts.finish || 'color'; if (v) svc?.apply?.(v); break;
      default: break;
    }
  }

  /** Free after buying the kit: change the underglow colour (0..7) or switch it off (null). */
  setNeon(vehicleId, color) {
    const c = this.customs[vehicleId];
    if (!c?.neonKit) return false;
    c.neon = color == null ? null : Math.max(0, Math.min(R.NEON_COLORS.length - 1, color | 0));
    const v = this._vehicleFor(vehicleId);
    if (v) this.game.services?.apply?.(v);
    if (this.remote) this.game.net?.setCosmetic?.(vehicleId, { neon: c.neon });
    this._changed('neon', 0);
    this.saveSoon();
    return true;
  }

  /** Put out the fire on your vehicle with a carried extinguisher. → true when used. */
  useExtinguisher(v = this.game.player?.controllable) {
    if (!(this.inventory.extinguisher > 0) || !v?.damage?.burning) return false;
    if (!this.game.services?.extinguish?.(v)) return false;
    this.inventory.extinguisher--;
    if (this.remote) this.game.net?.useItem?.('extinguisher');
    this._changed('extinguisher', 0);
    this.game.events?.emit('economy:extinguish', { vehicle: v, left: this.inventory.extinguisher });
    this.saveSoon(true);
    return true;
  }

  // armour plating ends with the next repair (any source) or when the car is destroyed
  _armorGone(id) {
    const c = this.customs[id];
    if (!c?.armor) return;
    c.armor = false;
    if (this.remote) this.game.net?.setCosmetic?.(id, { armor: false });
    this._changed('armor', 0);
    this.saveSoon();
  }

  _onDestroyed(v) {
    const id = v?.catalogId;
    if (!id || v.fromTraffic || !this.owned.has(id) || this.starters.has(id)) return;
    this._armorGone(id);
    const g = this.game;
    const name = v.name || id;
    if (this.insured) {
      g.services?.deliverReplacement?.(id);
    } else {
      this.wrecked[id] = this.clock();
      const text = tr(g, 'eco.wrecked', '{name} destroyed · replacement {amount} (free with insurance)', { name, amount: fmt(g, R.SERVICES.claim.price) });
      if (g.ui?.feed) g.ui.feed({ kind: 'garage', icon: 'wrench', text, seconds: 6 }); else g.ui?.notify?.(text, 6);
      this._changed('wrecked', 0);
    }
    this.saveSoon(true);
  }

  // ---------------------------------------------------------------- wardrobe (D's catalogue) and nickname
  /** Wardrobe entry { price, slot, tier, dye, starter } from wardrobe-prices.json, or computed from D's live catalogue. */
  wardrobeEntry(id) {
    const t = WARDROBE_TABLE[id];
    if (t) return t;
    const it = this.game.wardrobe?.byId?.get?.(id) ?? this.game.wardrobe?.items?.find?.((x) => x.id === id);
    if (!it) return null;
    const price = R.wardrobePrice(it);
    return { price, slot: it.slot, tier: it.tier, dye: R.dyePrice(price), starter: !!it.starter };
  }
  wardrobePrice(id) { return this.wardrobeEntry(id)?.price ?? 0; }
  wardrobeDyePrice(id) { return this.wardrobeEntry(id)?.dye ?? 0; }
  ownsWardrobe(id) { return id in this.wardrobe || !!this.wardrobeEntry(id)?.starter; }
  /** Owned wardrobe item ids (starter items included). */
  get ownedWardrobe() {
    const out = new Set(Object.keys(this.wardrobe));
    for (const [id, e] of Object.entries(WARDROBE_TABLE)) if (e.starter) out.add(id);
    return out;
  }
  wardrobeColor(id) { return this.wardrobe[id] ?? null; }
  /** What the player wears: { slot: itemId } plus colours { itemId: hex } (copy). */
  get outfit() {
    const colors = {};
    for (const id of Object.values(this.outfitSlots)) if (id && this.wardrobe[id] != null) colors[id] = this.wardrobe[id];
    return { ...this.outfitSlots, colors };
  }

  /**
   * Buy a wardrobe item in a colour; for an owned item a different colour is a re-dye (15%, min $50).
   * Resolves { ok, cost?, dyed?, reason? } — reasons: unknown, owned, funds, syncing, offline, rejected.
   */
  async buyWardrobe(itemId, colour = null) {
    if (typeof itemId !== 'string') return { ok: false, reason: 'unknown' }; // one item per call
    const e = this.wardrobeEntry(itemId);
    if (!e) return { ok: false, reason: 'unknown' };
    colour = wardrobeColour(colour);
    const owned = this.ownsWardrobe(itemId);
    // owned in this colour (never dyed = the palette's default colour): nothing to pay
    if (owned && (colour == null || colour === (this.wardrobe[itemId] ?? this._wardrobeDefault(itemId)))) return { ok: false, reason: 'owned' };
    const dyed = owned;
    const cost = dyed ? e.dye : e.price;
    if (cost > this.money) return { ok: false, reason: 'funds', cost };
    if (this.remote) {
      if (!this.server) return { ok: false, reason: 'syncing', cost };
      const res = await this._net('wardrobe', itemId, colour, dyed ? 'dye' : 'buy');
      if (!res.ok) return { ok: false, reason: res.reason || 'rejected', cost };
      this._serverMoney(Number.isFinite(res.money) ? res.money : this.server.money - cost);
    } else if (cost > 0) this._money -= cost;
    this.wardrobe[itemId] = colour ?? this.wardrobe[itemId] ?? null;
    if (cost > 0) { this.stats.spent += cost; this.stats.by[dyed ? 'wardrobe:dye' : 'wardrobe'] = (this.stats.by[dyed ? 'wardrobe:dye' : 'wardrobe'] || 0) - cost; }
    this._changed(dyed ? 'dye' : 'wardrobe', -cost);
    this.game.events?.emit('economy:wardrobe', { id: itemId, cost, color: colour, dyed });
    if (Object.values(this.outfitSlots).includes(itemId)) this.game.events?.emit('economy:outfit', { outfit: this.outfit });
    this.saveSoon(true);
    return { ok: true, cost, dyed };
  }
  _wardrobeDefault(id) { return this.game.wardrobe?.byId?.get?.(id)?.colors?.[0] ?? null; }
  /** Re-dye an owned item (same as buyWardrobe on an owned item). */
  dyeWardrobe(itemId, colour) { return this.buyWardrobe(itemId, colour); }

  /**
   * Wear owned items: { slot: itemId | null } (merged into the current outfit). Free; persisted; online the server
   * checks ownership. → { ok, reason? } and emits economy:outfit { outfit } for D.
   */
  setOutfit(outfit = {}) {
    const next = { ...this.outfitSlots };
    for (const [slot, v] of Object.entries(outfit || {})) {
      if (slot === 'colors') continue;
      if (!R.WARDROBE_SLOTS.includes(slot)) return { ok: false, reason: 'slot' }; // item slots only (map UI keys at the UI)
      const id = v && typeof v === 'object' ? v.id : v; // { slot: itemId } or D's { slot: { id, color } }
      if (id == null) { delete next[slot]; continue; }
      const e = this.wardrobeEntry(id);
      if (!e || e.slot !== slot) return { ok: false, reason: 'unknown' };
      if (!this.ownsWardrobe(id)) return { ok: false, reason: 'notOwned' };
      next[slot] = id;
    }
    this.outfitSlots = next;
    if (this.remote) {
      // the server checks ownership; when it refuses, show what it really has (never a silent revert later)
      Promise.resolve(this.game.net?.setOutfit?.(next)).then((r) => {
        if (!r || r.ok !== false) return;
        console.warn('[economy] outfit refused by the server:', r.reason, next);
        const srv = this.game.net?.wardrobeState?.outfit;
        if (srv && typeof srv === 'object') { this.outfitSlots = { ...srv }; this.game.events?.emit('economy:outfit', { outfit: this.outfit }); }
        this.game.events?.emit('economy:outfitRefused', { reason: r.reason, outfit: next });
      }, () => {});
    }
    this.game.events?.emit('economy:outfit', { outfit: this.outfit });
    this.saveSoon(true);
    return { ok: true };
  }

  /** Current display nickname (custom name wins). */
  get nickname() { return this.nick.custom || this.nick.name || null; }
  /** Price of the next nickname change: reroll $2,500 (the first one ever is free), custom $50,000. */
  nickPrice(mode = 'reroll') { return R.nickPrice(mode, this.nick.rerolls); }

  /**
   * Change the nickname. { mode: 'reroll' } → a new name from the generator; { mode: 'custom', value } → your own name
   * (3–16 of A–Z a–z 0–9 _ -, not looking like a generated one; the server also checks a blocklist and uniqueness).
   * Resolves { ok, nick?, cost?, reason? } — reasons: format, short, long, chars, generated, taken, blocked, funds, …
   */
  async changeNick({ mode = 'reroll', value = '' } = {}) {
    if (mode === 'random') mode = 'reroll';
    // free helpers for the nickname UI: online the server checks availability (blocklist, uniqueness) and suggests
    if (mode === 'suggest' || mode === 'check') {
      if (mode === 'check') {
        const err = nameFormatError(value);
        if (err) return { ok: false, available: false, reason: err };
        if (looksGenerated(value)) return { ok: false, available: false, reason: 'generated' };
      }
      if (this.remote) {
        if (!this.server) return { ok: false, reason: 'syncing' };
        return this._net('changeNick', mode, value);
      }
      if (mode === 'check') return { ok: true, available: true };
      const out = new Set();
      while (out.size < 3) { const n = nickName(randomNickCode()).replace(/^([A-Z][a-z]+)/, '$1_'); if (!looksGenerated(n) && !nameFormatError(n)) out.add(n); }
      return { ok: true, suggestions: [...out] };
    }
    if (mode !== 'reroll' && mode !== 'custom') return { ok: false, reason: 'mode' };
    if (mode === 'custom') {
      const err = nameFormatError(value);
      if (err) return { ok: false, reason: err };
      if (looksGenerated(value)) return { ok: false, reason: 'generated' };
    }
    const cost = this.nickPrice(mode);
    if (cost > this.money) return { ok: false, reason: 'funds', cost };
    let nick;
    if (this.remote) {
      if (!this.server) return { ok: false, reason: 'syncing', cost };
      const res = await this._net('changeNick', mode, value);
      if (!res.ok) return { ok: false, reason: res.reason || 'rejected', cost };
      this._serverMoney(Number.isFinite(res.money) ? res.money : this.server.money - cost);
      if (mode === 'custom') this.nick.custom = res.nick ?? value;
      else { this.nick.code = res.code ?? this.nick.code; this.nick.name = res.nick ?? this.nick.name; this.nick.custom = null; }
      nick = res.nick ?? this.nickname;
    } else {
      if (cost > 0) this._money -= cost;
      if (mode === 'custom') this.nick.custom = value;
      else {
        let code;
        do code = randomNickCode(); while (code === this.nick.code);
        this.nick.code = code;
        this.nick.name = nickName(code);
        this.nick.custom = null;
      }
      nick = this.nickname;
    }
    if (mode === 'reroll') this.nick.rerolls++;
    if (cost > 0) { this.stats.spent += cost; this.stats.by.nick = (this.stats.by.nick || 0) - cost; }
    this._changed('nick', -cost);
    this.game.events?.emit('economy:nick', { nick, mode, cost });
    this.saveSoon(true);
    return { ok: true, nick, cost };
  }

  // ---------------------------------------------------------------- sandbox (singleplayer control panel)
  /** Give (or take, negative) cash. Singleplayer only; returns the change applied. Does not emit money:pickup. */
  grant(amount, reason = 'sandbox') {
    if (!this.sandbox) return 0;
    const before = this._money;
    this._money = Math.max(0, Math.round(this._money + (amount || 0)));
    const d = this._money - before;
    if (d) { this._changed(reason, d); this.saveSoon(); }
    return d;
  }
  give(amount) { return this.grant(amount); }

  /** Sandbox toggle: every vehicle counts as owned (garage). Singleplayer only. */
  setUnlockAll(on) {
    if (!this.sandbox) return false;
    this.unlockAll = !!on;
    this._changed('unlockAll', 0);
    this.saveSoon(true);
    return this.unlockAll;
  }

  // ---------------------------------------------------------------- spawning
  /**
   * Where and in what a session starts: the saved position (singleplayer, snapped to a road) or a random Ocean Beach
   * kerb slot; the last-used owned land vehicle or the starter car. → { pos: {x,y,z,yaw}|null, vehicle, restored }
   */
  startPlan() {
    const g = this.game;
    const land = this.last?.land;
    const vehicle = land && this.owns(land) && !NON_LAND.has(this._p(land)?.cls) ? land : this.starterCar;
    let pos = null, restored = false;
    // singleplayer restores its saved position; online the server / net layer restores it
    if (g.mode === 'single' && this.last && Number.isFinite(this.last.x) && Number.isFinite(this.last.z)) {
      pos = g.spawns?.snapToRoad?.(this.last.x, this.last.z) ?? null;
      restored = !!pos;
    }
    if (!pos) pos = g.spawns?.pickSpawn?.('start') ?? null;
    return { pos, vehicle, restored };
  }

  // ---------------------------------------------------------------- online (workstream J calls these)
  /**
   * Apply authoritative server state (any subset): { money, owned: string[], worth, progress: { c, d, s, m, t, dd, ds },
   * daily: { amount, streak } }. `combo` is ignored: the client combo is presentation + claim meta, the server bounds it.
   */
  applyServer(state = {}) {
    if (!state) return;
    this.server ||= { money: 0, worth: null };
    if (Array.isArray(state.owned)) this._setOwned(state.owned);
    if (Number.isFinite(state.worth)) this.server.worth = state.worth;
    const pg = state.progress;
    if (pg) {
      if (Array.isArray(pg.c)) this.found = new Set(pg.c);
      if (Array.isArray(pg.d)) this.districts = new Set(pg.d.map((i) => this.districtNames[i] ?? String(i)));
      if (Array.isArray(pg.s)) this.stunts = new Set(pg.s);
      if (pg.m) this.medals = { ...pg.m };
      if (pg.t) this.traps = { ...pg.t };
      if (pg.dd !== undefined) this.daily = { last: pg.dd || null, streak: pg.ds | 0 };
    }
    if (state.inventory) this.inventory = { extinguisher: state.inventory.extinguisher | 0, insuranceUntil: +state.inventory.insuranceUntil || 0 };
    if (state.wardrobe && typeof state.wardrobe === 'object') this.wardrobe = { ...state.wardrobe };
    if (state.outfit && typeof state.outfit === 'object') { this.outfitSlots = { ...state.outfit }; this.game.events?.emit('economy:outfit', { outfit: this.outfit }); }
    if (state.nick && typeof state.nick === 'object') this.nick = { ...this.nick, ...state.nick };
    if (state.custom && typeof state.custom === 'object') {
      this.customs = {};
      for (const [id, c] of Object.entries(state.custom)) if (c && typeof c === 'object') this.customs[id] = { ...c };
      this.game.services?.refreshAll?.();
    }
    if (state.daily?.amount > 0) this._notify('daily', state.daily.amount, { streak: state.daily.streak });
    if (Number.isFinite(state.money)) this._serverMoney(state.money);
    else this._recalc();
    this._changed('sync', 0);
  }

  // optimistic claim; J's net.claim may return a Promise<{ granted, money, result, combo }>
  _claim(reason, amount, pos, meta, now) {
    const entry = { amount, t: now };
    this._pending.push(entry);
    let p = null;
    try { p = this.game.net.claim(reason, amount, pos, meta || {}); } catch { p = null; }
    if (p && typeof p.then === 'function') p.then((res) => this._settle(entry, res), () => this._settle(entry, null));
    this._recalc();
  }

  _settle(entry, res) {
    const i = this._pending.indexOf(entry);
    if (i >= 0) this._pending.splice(i, 1);
    if (res && Number.isFinite(res.money)) { this._serverMoney(res.money); return; }
    this._recalc();
    this._changed('settle', 0);
  }

  _serverMoney(m) {
    this.server ||= { money: 0, worth: null };
    this.server.money = Math.max(0, Math.round(m));
    this._recalc();
  }

  _setOwned(ids) {
    this.owned = new Set(ids.filter((id) => typeof id === 'string' && id));
    for (const s of this.starters) this.owned.add(s);
  }

  async _net(op, ...args) {
    const net = this.game.net;
    if (!net?.[op]) return { ok: false, reason: 'offline' };
    try {
      const r = await net[op](...args);
      return r && typeof r === 'object' ? r : { ok: !!r };
    } catch (e) {
      return { ok: false, reason: String(e?.message || 'offline') };
    }
  }

  _recalc() { this._mirror(); }

  // ---------------------------------------------------------------- per frame
  update(dt, game) {
    // combo window
    if (this.comboT > 0 && !this._hold) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.resetCombo('timeout');
    }
    this._hold = false;
    // someone wrote player.money directly (old code paths): adopt it locally, overwrite it online
    const p = game.player;
    if (p && p !== this._mPlayer) this._mirror(); // player created/replaced after the economy
    else if (p && p.money !== this._mirrored) {
      const d = Math.round((p.money || 0) - this._mirrored);
      if (!this.remote && d) { this._money = Math.max(0, this._money + d); this._changed('other', d); this.saveSoon(); }
      else this._mirror();
    }
    // online: drop optimistic entries the server never answered
    if (this._pending.length) {
      const now = this.clock() / 1000;
      let drop = false;
      while (this._pending.length && now - this._pending[0].t > PENDING_TTL) { this._pending.shift(); drop = true; }
      if (drop) { this._recalc(); this._changed('settle', 0); }
    }
    this.stats.playS += dt;
    // district discovery (twice a second)
    if (this._visitArmed) {
      this._visitT -= dt;
      if (this._visitT <= 0) { this._visitT = 0.5; this._discover(); }
    }
    // remember where we are (singleplayer restore)
    this._posT -= dt;
    if (this._posT <= 0) { this._posT = 10; this._rememberPos(); }
  }

  _discover() {
    const g = this.game, f = g.player?.focus;
    if (!f || !g.world3d?.areaAt || (this.remote && !this.server)) return;
    if (g.player.wastedT > 0 || g.player.mode === 'free') return;
    const a = g.world3d.areaAt(f.x, f.z);
    const key = a?.key || a?.name;
    if (!key || this.districts.has(key)) return;
    // only the named districts of world.json pay (the server validates by index); big regions are just labels
    const idx = this.districtNames.indexOf(key);
    if (idx < 0 && this.districtNames.length) return;
    this.districts.add(key);
    const pos = { x: f.x, y: f.y, z: f.z };
    const paid = this.earn('firstvisit', R.FIRST_VISIT, pos, { district: idx, name: key });
    this.saveSoon(true);
    g.events?.emit('economy:discovered', { name: key, paid, count: this.districts.size });
    if (paid > 0) g.events?.emit('money:pickup', { amount: paid, position: pos, reason: 'firstvisit' });
    const t = (k, fb, params) => tr(g, k, fb, params);
    g.ui?.toast?.(t('eco.newArea', 'NEW AREA DISCOVERED'), `${a.name}${paid > 0 ? ` · +${fmt(g, paid)}` : ''}`, 3);
  }

  _daily() {
    if (this.remote) return; // the server grants it (applyServer({ daily }))
    const today = R.localDay(new Date(this.clock()));
    if (this.daily.last === today) return;
    const streak = R.nextStreak(this.daily.last, today, this.daily.streak);
    const pay = this.earn('daily', R.dailyPay(streak), null, { streak });
    this.daily = { last: today, streak };
    this.save();
    if (pay > 0) this._notify('daily', pay, { streak });
  }

  _notify(kind, amount, o = {}) {
    const g = this.game;
    if (kind === 'daily') {
      const text = tr(g, 'eco.daily', 'Daily bonus · day {streak} · +{amount}', { streak: o.streak, amount: fmt(g, amount) });
      if (g.ui?.feed) g.ui.feed({ kind: 'bank', icon: 'money', text, seconds: 6 });
      else g.ui?.notify?.(text, 6);
      g.events?.emit('money:pickup', { amount, reason: 'daily' });
      g.events?.emit('economy:daily', { amount, streak: o.streak });
    }
  }

  _rememberPos() {
    const g = this.game, p = g.player;
    if (!p?.focus || p.mode === 'free' || p.wastedT > 0) return;
    const v = p.controllable;
    if (v && (v.telemetry?.airborne || NON_LAND.has(v.kind))) return; // restore on land only
    const f = p.focus;
    if (!Number.isFinite(f.x) || (g.terrain && g.terrain.heightAt(f.x, f.z) < 0.2)) return;
    this.last = { ...(this.last || {}), x: Math.round(f.x * 10) / 10, z: Math.round(f.z * 10) / 10 };
    this.saveSoon();
  }

  _onEnter(v) {
    const id = v?.catalogId;
    if (!id || !this._p(id) || v.fromTraffic || !this.owns(id)) return;
    this.last = { ...(this.last || {}), vehicle: id };
    if (!NON_LAND.has(this._p(id).cls)) this.last.land = id;
    this.saveSoon();
  }

  _onImpact(e) {
    const v = this.game.player?.controllable;
    if (!e || !v || e.source !== v) return;
    if ((e.strength ?? 0) >= R.COMBO.crashStrength) this.resetCombo('crash');
  }

  _conditionOf(id) {
    const v = this.game.player?.controllable;
    if (!v || v.catalogId !== id || v.fromTraffic) return 1;
    return Math.max(0, 1 - damageOf(v));
  }

  _changed(reason, delta) {
    this._mirror();
    const info = { money: this.money, delta, reason };
    for (const cb of this._listeners) { try { cb(this, info); } catch (e) { console.error(e); } }
    this.game.events?.emit('economy:change', info);
  }

  _mirror() {
    const p = this.game.player;
    if (p) { const m = this.money; p.money = m; this._mirrored = m; this._mPlayer = p; }
  }

  // ---------------------------------------------------------------- persistence
  toJSON() {
    return {
      v: SAVE_VERSION,
      money: this._money,
      owned: [...this.owned].filter((id) => !this.starters.has(id)),
      found: [...this.found],
      medals: this.medals,
      districts: [...this.districts],
      stunts: [...this.stunts],
      traps: this.traps,
      daily: this.daily,
      exportCd: this.exportCd,
      inventory: this.inventory,
      customs: this.customs,
      wrecked: this.wrecked,
      wardrobe: this.wardrobe,
      outfit: this.outfitSlots,
      nick: this.nick,
      last: this.last,
      unlockAll: this.unlockAll,
      stats: this.stats,
      savedAt: this.clock(),
    };
  }

  restore(s) {
    this._reset();
    if (!s || typeof s !== 'object') return false;
    if (Number.isFinite(s.money)) this._money = Math.max(0, Math.round(s.money));
    if (Array.isArray(s.owned)) for (const id of s.owned) if (typeof id === 'string' && id) this.owned.add(id);
    if (Array.isArray(s.found)) this.found = new Set(s.found);
    if (s.medals && typeof s.medals === 'object') this.medals = { ...s.medals };
    if (Array.isArray(s.districts)) this.districts = new Set(s.districts);
    if (Array.isArray(s.stunts)) this.stunts = new Set(s.stunts);
    if (s.traps && typeof s.traps === 'object') this.traps = { ...s.traps };
    if (s.daily && typeof s.daily === 'object') this.daily = { last: s.daily.last ?? null, streak: s.daily.streak | 0 };
    if (s.exportCd && typeof s.exportCd === 'object') {
      const now = this.clock();
      for (const [id, t] of Object.entries(s.exportCd)) if (t > now) this.exportCd[id] = t;
    }
    if (s.inventory && typeof s.inventory === 'object') {
      this.inventory = { extinguisher: Math.max(0, Math.min(R.SERVICES.extinguisher.max, s.inventory.extinguisher | 0)), insuranceUntil: +s.inventory.insuranceUntil || 0 };
    }
    if (s.customs && typeof s.customs === 'object') for (const [id, c] of Object.entries(s.customs)) if (c && typeof c === 'object') this.customs[id] = { ...c };
    if (s.wrecked && typeof s.wrecked === 'object') this.wrecked = { ...s.wrecked };
    if (s.wardrobe && typeof s.wardrobe === 'object') this.wardrobe = { ...s.wardrobe };
    if (s.outfit && typeof s.outfit === 'object') this.outfitSlots = { ...s.outfit };
    if (s.nick && typeof s.nick === 'object') this.nick = { code: s.nick.code ?? null, name: s.nick.name ?? null, custom: s.nick.custom ?? null, rerolls: s.nick.rerolls | 0 };
    if (s.last && typeof s.last === 'object') this.last = { ...s.last };
    this.unlockAll = !!s.unlockAll;
    if (s.stats && typeof s.stats === 'object') this.stats = { ...this.stats, ...s.stats, by: { ...(s.stats.by || {}) } };
    return true;
  }

  load() {
    let s = null;
    try { s = JSON.parse(this.storage?.getItem(this.saveKey) || 'null'); } catch { s = null; }
    this.newPlayer = !s;
    if (s) this.restore(s);
    return !!s;
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (this.remote || !this.storage) return; // online: the server persists
    try { this.storage.setItem(this.saveKey, JSON.stringify(this.toJSON())); } catch { /* quota / private mode */ }
  }

  /** Debounced save (2 s); `now` saves immediately. */
  saveSoon(now = false) {
    if (now) { this.save(); return; }
    if (this._saveTimer || this.remote) return;
    this._saveTimer = setTimeout(() => this.save(), 2000);
  }

  /** Forget the singleplayer save and start over (sandbox). */
  wipe() {
    if (this.remote) return;
    try { this.storage?.removeItem(this.saveKey); } catch { /* ignore */ }
    this._reset();
    this._changed('wipe', 0);
  }

  dispose() {
    this.save();
    for (const off of this._off) off?.();
    if (typeof window !== 'undefined' && this._flush) {
      window.removeEventListener('beforeunload', this._flush);
      document.removeEventListener?.('visibilitychange', this._vis);
    }
  }
}

/** 0..1 damage of a controllable from the damage system (E): 1 − average of body and engine integrity. */
export function damageOf(v) {
  const d = v?.damage;
  if (!d) return 0;
  if (d.destroyed) return 1;
  const body = Number.isFinite(d.body) ? d.body : 1;
  const engine = Number.isFinite(d.engine) ? d.engine : 1;
  return Math.max(0, Math.min(1, 1 - (body + engine) / 2));
}

/** i18n helper: game.i18n.t(key, params) with an English fallback (placeholders {name}). */
export function tr(game, key, fallback, params) {
  const s = game?.i18n?.t?.(key, params);
  if (s && s !== key) return s;
  if (!params) return fallback;
  return fallback.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

/** "$1,234" through the UI locale when available. */
export function fmt(game, n) {
  return game?.i18n?.money?.(n) ?? `$${Math.round(n).toLocaleString('en-US')}`;
}

// a wardrobe colour: 0xRRGGBB (number or '#rrggbb'), anything else = no colour
function wardrobeColour(c) {
  if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c)) c = parseInt(c.replace('#', ''), 16);
  return Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : null;
}
