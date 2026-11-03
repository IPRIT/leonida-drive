// Server-authoritative economy (docs/ECONOMY.md). Every formula, cap and cooldown comes from the shared
// src/economy/rules.js (the same file the client predicts with). Clients only send claims {reason, amount, pos, meta};
// the server recomputes or clamps each one from what it observed itself (speed, trajectory, airborne arcs, where the
// player was), applies per-reason cooldowns, the combo bound and a global income token bucket, and keeps ownership,
// one-off progress (collectibles, districts, medals, stunt spots, speed-trap bests, daily streak), the service
// inventory, per-vehicle cosmetics and the wardrobe, so nothing can be replayed or granted client-side. Purchases are
// atomic: one session per player, single-threaded, persisted immediately.
import * as R from '../../src/economy/rules.js';
import { CLAIM, WALLET, VCLASS, ECON_RESULT, SERVICE, SERVICE_NAMES } from '../../src/net/shared/constants.js';

export const START_MONEY = R.START_MONEY;
export const BUCKET_CAP = R.BUCKET.burst; // $ burst
export const BUCKET_RATE = R.BUCKET.perSecond; // $ per second sustained ($12,000 / minute)
const COMBO_WINDOW = R.COMBO.window * 1000 + 500; // ms between skill events to keep a chain (+ network slack)
const NAME_OF = Object.fromEntries(Object.entries(CLAIM).map(([k, v]) => [v, k.toLowerCase()]));
const SKILL = new Set([CLAIM.DRIFT, CLAIM.NEARMISS, CLAIM.STUNT, CLAIM.SPEEDTRAP]);
const COLLECTIBLES = R.COLLECTIBLES.total;
const RULES = {};
for (const [id, name] of Object.entries(NAME_OF)) {
  const r = R.REASONS[name];
  // online payouts are the base formulas × rules.ONLINE.mult (scale), and so are the per-claim ceilings
  if (r) RULES[id] = { max: R.reasonMax(name, true), scale: R.incomeScale(name, true), cooldown: r.cooldown * 1000, bucket: r.bucket };
}
// the server computes these amounts itself; the client's amount is ignored
const SERVER_COMPUTED = new Set([CLAIM.DAILY, CLAIM.COLLECTIBLE, CLAIM.FIRSTVISIT, CLAIM.RACE, CLAIM.EXPORT]);
const TIER_NAMES = ['', 'gold', 'silver', 'bronze'];
const RESULT = {
  unknown: ECON_RESULT.UNKNOWN, notOwned: ECON_RESULT.NOT_OWNED, undamaged: ECON_RESULT.UNDAMAGED, max: ECON_RESULT.MAX,
  excluded: ECON_RESULT.EXCLUDED, installed: ECON_RESULT.INSTALLED, variant: ECON_RESULT.VARIANT, finish: ECON_RESULT.FINISH,
  color: ECON_RESULT.COLOR, funds: ECON_RESULT.FUNDS, noVehicle: ECON_RESULT.NO_VEHICLE, empty: ECON_RESULT.EMPTY,
};

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Per-player economy. ctx = { prices: Map(id → {price, cls, starter, traffic}), pricesObj, exportPool, vehicles,
 * world: {districts, hospitals}, trials?: Map, wardrobe?: { items: [{id, price, slot, starter}], byId: Map } }.
 */
export class Economy {
  constructor(rec, ctx, now) {
    this.ctx = ctx;
    this.money = Math.max(0, Math.round(rec.money ?? START_MONEY));
    this.owned = new Set((rec.owned || []).filter((id) => ctx.prices.has(id)));
    for (const [id, p] of ctx.prices) if (p.starter) this.owned.add(id); // starters are always owned
    const pg = rec.progress || {};
    this.progress = {
      c: new Set((pg.c || []).filter((n) => Number.isInteger(n))), // collectibles found
      d: new Set((pg.d || []).filter((n) => Number.isInteger(n))), // districts visited
      s: new Set((pg.s || []).filter((n) => Number.isInteger(n))), // stunt spots done
      m: new Map(Object.entries(pg.m || {}).map(([k, v]) => [+k, v | 0])), // trial → medal tier bitmask (1 gold, 2 silver, 4 bronze)
      t: new Map(Object.entries(pg.t || {}).map(([k, v]) => [+k, +v || 0])), // speed trap → best km/h
      dd: typeof pg.dd === 'string' ? pg.dd : '', ds: Math.max(0, Math.min(R.DAILY.maxStreak, pg.ds | 0)), // daily date + streak
    };
    // services: carried items, insurance pass, per-vehicle cosmetics/armour (only for owned models)
    const g = rec.garage || {};
    const inv = g.inventory || {};
    this.inventory = {
      extinguisher: clamp(inv.extinguisher | 0, 0, R.SERVICES.extinguisher.max),
      insuranceUntil: Number.isFinite(+inv.insuranceUntil) ? +inv.insuranceUntil : 0,
    };
    this.customs = {};
    for (const [id, c] of Object.entries(g.custom || {})) if (this.owned.has(id) && c && typeof c === 'object') this.customs[id] = sanitizeCustom(c);
    // wardrobe: owned items (id → dye colour | null; starter items are always owned) and the outfit (slot → id)
    const wr = rec.wardrobe || {}, wt = ctx.wardrobe;
    this.clothes = new Map();
    if (Array.isArray(wr.own)) { for (const id of wr.own) if (wt?.byId.has(id)) this.clothes.set(id, null); }
    else if (wr.own && typeof wr.own === 'object') for (const [id, c] of Object.entries(wr.own)) if (wt?.byId.has(id)) this.clothes.set(id, validColour(c));
    this.outfit = {};
    if (wr.fit && typeof wr.fit === 'object' && !Array.isArray(wr.fit)) {
      for (const [slot, id] of Object.entries(wr.fit)) { const it = wt?.byId.get(id); if (it && it.slot === slot && this.ownsClothing(id)) this.outfit[slot] = id; }
    }
    this.tokens = BUCKET_CAP;
    this.t = now;
    this.last = new Float64Array(16);
    this.trialLast = new Map();
    this.trapLast = new Map();
    this.exportLast = new Map();
    this.pickup$ = 0; this.pickupT = now;
    this.combo = 1; this.comboT = -1e12;
    this.rejected = 0; this.rejT = now;
  }

  // ---------------- state ----------------
  priceOf(id) { return this.ctx.prices.get(id)?.price ?? 0; }

  /** Cash + the sale value of sellable vehicles; starters and wardrobe do not inflate the leaderboard. */
  worth() {
    return R.netWorth(this.money, this.owned, this.ctx.prices);
  }

  progressJSON() {
    const p = this.progress;
    return {
      c: [...p.c], d: [...p.d], s: [...p.s], m: Object.fromEntries(p.m), t: Object.fromEntries(p.t), dd: p.dd, ds: p.ds,
    };
  }

  garageJSON() { return { inventory: { ...this.inventory }, custom: structuredClone(this.customs) }; }
  wardrobeJSON() { return { own: Object.fromEntries(this.clothes), fit: { ...this.outfit } }; }

  _refill(now) {
    this.tokens = Math.min(BUCKET_CAP, this.tokens + (Math.max(0, now - this.t) / 1000) * BUCKET_RATE);
    this.t = now;
    if (now - this.rejT > 60000) { this.rejected = Math.max(0, this.rejected - 5); this.rejT = now; }
  }

  // ---------------- claims ----------------
  /**
   * c = decoded claim; mv = Movement; vclass/modelIndex = what the player drives (server-approved).
   * Returns { result, granted, why, combo, bonus }.
   */
  claim(c, now, mv, { vclass, model, frozen = false, dead = false }) {
    this._refill(now);
    const out = { result: WALLET.REJECTED, granted: 0, why: '', combo: this.combo, bonus: 0 };
    const rule = RULES[c.reason];
    if (frozen) { out.result = WALLET.FROZEN; out.why = 'frozen'; return out; }
    if (!rule) return this._no(out, 'reason');
    if (dead) return this._no(out, 'dead');
    if (now - this.last[c.reason] < rule.cooldown) return this._no(out, 'cooldown');
    // combo bound: a skill event within the window of the previous one may raise the chain by +0.5 (max x5)
    let combo = 1;
    if (SKILL.has(c.reason)) {
      const chain = now - this.comboT <= COMBO_WINDOW && !crashedSince(mv, this.comboT, now);
      const bound = chain ? Math.min(R.COMBO.max, this.combo + R.COMBO.step) : 1;
      combo = Math.min(Number.isFinite(c.combo) ? Math.max(1, c.combo) : 1, bound + R.COMBO.step); // an event the server rejected may still count client-side
    }
    let allowed;
    try { allowed = this._plausible(c, now, mv, vclass, model, combo, out); } catch (e) { allowed = 0; out.why = `error: ${e.message}`; }
    if (!(allowed > 0)) return this._no(out, out.why || 'implausible');
    allowed *= rule.scale; // the base formula × the online multiplier (the client claims the scaled amount)
    const computed = SERVER_COMPUTED.has(c.reason);
    if (!computed && !(c.amount > 0)) return this._no(out, 'amount');
    const amount = computed ? allowed : Math.min(c.amount, allowed);
    let g = Math.min(amount, rule.max) + out.bonus;
    if (rule.bucket && !out.exempt) {
      g = Math.min(g, Math.floor(this.tokens));
      if (g <= 0) return this._no(out, 'bucket');
      this.tokens -= g;
    }
    g = Math.round(g);
    if (g <= 0) return this._no(out, 'zero');
    this.money += g;
    this.last[c.reason] = now;
    if (out.commit) out.commit();
    if (SKILL.has(c.reason)) {
      this.combo = combo > 1 || now - this.comboT <= COMBO_WINDOW ? Math.max(1, Math.min(R.COMBO.max, combo)) : 1;
      this.comboT = now;
    }
    out.granted = g;
    out.combo = this.combo;
    out.result = !computed && g < c.amount ? WALLET.CLAMPED : WALLET.GRANTED;
    return out;
  }

  _no(out, why) { out.why = why; this.rejected++; return out; }

  _plausible(c, now, mv, vclass, model, combo, out) {
    const ground = vclass !== VCLASS.FOOT && vclass !== VCLASS.HELI && vclass !== VCLASS.PLANE && vclass !== VCLASS.BOAT;
    switch (c.reason) {
      case CLAIM.DRIFT: {
        // p1 = chain duration (1/100 s). Points = Σ driftPoints(kmh, slip, dt) over what the server saw; pay = driftPay
        if (!ground) { out.why = 'class'; return 0; }
        const dur = Math.min(c.p1 / 100, 90);
        if (dur < R.DRIFT.minChainS) { out.why = 'short'; return 0; }
        let pts = 0, driftT = 0, prevT = 0;
        mv.forEach(now - (dur + 3) * 1000, now, (t, x, y, z, hs, slip, air) => {
          const dt = prevT ? Math.min(0.3, (prevT - t) / 1000) : 0;
          prevT = t;
          if (hs > (R.DRIFT.minKmh - 5) / 3.6 && !air && slip > 0.12) { pts += R.driftPoints(hs * 3.6, slip, dt); driftT += dt; }
        });
        if (driftT < Math.min(dur, 2) * 0.35) { out.why = 'no drift observed'; return 0; }
        // the trajectory history covers ~25 s: long chains are extrapolated from the observed rate
        const scale = dur > driftT ? Math.min(dur / Math.max(driftT, 0.5), 3) : 1;
        return ((pts * scale * 1.3) / R.DRIFT.divisor) * combo + 25;
      }
      case CLAIM.NEARMISS: {
        // p2 = km/h, tier = bundled misses (1..3, inside the 1.5 s claim cooldown)
        const seen = maxSpeed(mv, now - 1500, now) * 3.6;
        if (!ground || seen < R.NEARMISS.minKmh * 0.95) { out.why = 'speed'; return 0; }
        const kmh = Math.min(c.p2 > 0 ? c.p2 : seen, seen * 1.05);
        return R.nearMissPay(Math.max(kmh, R.NEARMISS.minKmh + 0.01), combo, clamp(c.tier | 0, 1, R.NEARMISS.maxBundle)) * 1.05;
      }
      case CLAIM.STUNT: {
        // p1 = air time (1/100 s), p2 = height (dm), meta = named stunt spot (0 = none)
        if (!ground) { out.why = 'class'; return 0; }
        const air = Math.min(c.p1 / 100, 20);
        if (air < Math.min(1, R.STUNT.minAirS)) { out.why = 'short'; return 0; }
        // airborne flag over the claimed time AND a real vertical arc (works on bridges, where terrain height lies)
        let airT = 0, yMax = -1e9, yMin = 1e9, prevT = 0;
        mv.forEach(now - (air + 3) * 1000, now, (t, x, y, z, hs, slip, isAir) => {
          if (prevT && isAir) airT += Math.min(0.25, (prevT - t) / 1000);
          if (y > yMax) yMax = y;
          if (y < yMin) yMin = y;
          prevT = t;
        });
        const arc = yMax - yMin;
        if (airT < air * 0.5 || arc < 0.8) { out.why = 'no airtime observed'; return 0; }
        const spot = c.meta;
        const first = spot > 0 && spot < 256 && !this.progress.s.has(spot);
        if (first) out.commit = () => { this.progress.s.add(spot); out.progress = true; };
        return R.stuntPay(Math.min(air, airT * 1.3 + 0.3), Math.min(c.p2 / 10, arc + 4), combo, first);
      }
      case CLAIM.SPEEDTRAP: {
        // meta = trap id, p1 = speed (km/h * 10); the server must have seen that speed near the claimed position
        const kmh = c.p1 / 10, trap = c.meta;
        if (trap > 1024) { out.why = 'trap'; return 0; }
        if ((this.trapLast.get(trap) ?? -1e12) > now - 10000) { out.why = 'trap cooldown'; return 0; }
        const seen = maxSpeed(mv, now - 2500, now) * 3.6;
        if (seen < kmh * 0.9 || !mv.wasNear(c.x, c.z, 60, now - 3000)) { out.why = 'speed not observed'; return 0; }
        const v = Math.min(kmh, seen * 1.05);
        const pb = this.progress.t.get(trap) ?? 0;
        out.commit = () => { this.trapLast.set(trap, now); if (v > pb) { this.progress.t.set(trap, Math.round(v * 10) / 10); out.progress = true; } };
        return R.speedTrapPay(v, v > pb + 0.5, combo);
      }
      case CLAIM.RACE: {
        // meta = trial id, tier = 1 gold / 2 silver / 3 bronze, p1 = time (s * 10)
        const trial = c.meta, tier = c.tier;
        if (trial > 255 || tier < 1 || tier > 3) { out.why = 'trial'; return 0; }
        if ((this.trialLast.get(trial) ?? -1e12) > now - R.RACE.perTrialCooldownS * 1000) { out.why = 'trial cooldown'; return 0; }
        const def = this.ctx.trials?.get(trial);
        const purse = def ? def.purse : R.RACE.purseMax;
        const time = c.p1 / 10;
        if (time < 15) { out.why = 'too fast'; return 0; }
        const path = mv.pathLength(now - time * 1000 - 2000, now);
        if (path < Math.max(300, (def?.length ?? 0) * 0.7) || path / time < 5) { out.why = 'race not driven'; return 0; }
        const bit = 1 << (tier - 1);
        const first = !((this.progress.m.get(trial) ?? 0) & bit);
        if (first) out.exempt = true; // a first medal of a tier is bucket-exempt
        out.commit = () => { this.trialLast.set(trial, now); this.progress.m.set(trial, (this.progress.m.get(trial) ?? 0) | bit); out.progress = true; };
        return R.racePay(purse, TIER_NAMES[tier], first);
      }
      case CLAIM.COLLECTIBLE: {
        // meta = postcard id; $1,000, every 10 found +$10,000, all 60 +$100,000 (rules.collectiblePay)
        const id = c.meta;
        if (id >= COLLECTIBLES) { out.why = 'id'; return 0; }
        if (this.progress.c.has(id)) { out.why = 'already found'; return 0; }
        if (!mv.wasNear(c.x, c.z, 15, now - 5000)) { out.why = 'not there'; return 0; }
        out.commit = () => { this.progress.c.add(id); out.progress = true; };
        return R.collectiblePay(this.progress.c.size + 1, COLLECTIBLES);
      }
      case CLAIM.DELIVERY: {
        // destination = claim pos; meta = origin (x/10, z/10 as two i16); p1 = route length (m); p2 = job time (s); tier = condition %
        const ox = ((c.meta << 16) >> 16) * 10, oz = (c.meta >> 16) * 10;
        const len = c.p1, time = c.p2, straight = Math.hypot(c.x - ox, c.z - oz);
        if (straight < 200 || len < straight * 0.95 || len > straight * 2.6 + 400) { out.why = 'route'; return 0; }
        if (time < len / 75) { out.why = 'too fast'; return 0; }
        if (!mv.wasNear(c.x, c.z, 40, now - 6000)) { out.why = 'not at destination'; return 0; }
        if (!mv.nearTrail(ox, oz, 250, now, (time + 90) * 1000)) { out.why = 'not from origin'; return 0; }
        const kind = model ? this.ctx.vehicles.models[model]?.kind : null;
        const factor = vclass === VCLASS.CAR && kind ? R.deliveryFactor(kind) : 1;
        const cond = clamp(c.tier / 100, R.DELIVERY.minCondition, 1);
        return R.deliveryPay(len, factor, R.deliveryTimeBonus(len, time), cond) * 1.02;
      }
      case CLAIM.EXPORT: {
        // meta = model index of the delivered car (the server must see the player in it); tier = condition %; p1 = yard
        if (model !== c.meta || !model) { out.why = 'not in that car'; return 0; }
        const id = this.ctx.vehicles.models[model]?.id;
        if (!id) { out.why = 'model'; return 0; }
        if (this.owned.has(id)) { out.why = 'owned model'; return 0; } // a garage car can't be told from a jacked one
        if ((this.exportLast.get(model) ?? -1e12) > now - R.EXPORT.modelCooldownS * 1000) { out.why = 'model exported recently'; return 0; }
        const yard = clamp(c.p1 | 0, 0, 7), pool = this.ctx.exportPool || [];
        const wall = Date.now();
        const wanted = R.exportWanted(wall, yard, pool).includes(id) || R.exportWanted(wall - 60000, yard, pool).includes(id);
        out.commit = () => this.exportLast.set(model, now);
        return R.exportPay(this.priceOf(id), clamp(c.tier / 100, 0, 1), wanted);
      }
      case CLAIM.PICKUP: {
        const lim = R.REASONS.pickup.perMinute ?? 300;
        if (now - this.pickupT > 60000) { this.pickup$ = 0; this.pickupT = now; }
        if (!mv.wasNear(c.x, c.z, 14, now - 4000)) { out.why = 'not there'; return 0; }
        const a = Math.min(R.REASONS.pickup.max, lim - this.pickup$, c.amount);
        if (a <= 0) { out.why = 'pickup cap'; return 0; }
        out.commit = () => { this.pickup$ += Math.min(a, c.amount); };
        return a;
      }
      case CLAIM.DAILY: {
        const d = this._daily();
        if (!d) { out.why = 'already claimed today'; return 0; }
        out.commit = () => { this.progress.dd = d.today; this.progress.ds = d.streak; out.progress = true; };
        return R.dailyPay(d.streak);
      }
      case CLAIM.FIRSTVISIT: {
        // meta = index in world.json districts ('d' districts and 'a' areas); the player must be inside it
        const d = this.ctx.world.districts?.[c.meta];
        if (!d || (d.type !== 'd' && d.type !== 'a')) { out.why = 'district'; return 0; }
        if (this.progress.d.has(c.meta)) { out.why = 'already visited'; return 0; }
        if (Math.hypot(mv.x - d.x, mv.z - d.z) > d.r + 150) { out.why = 'not in district'; return 0; }
        out.commit = () => { this.progress.d.add(c.meta); out.progress = true; };
        return R.FIRST_VISIT;
      }
      case CLAIM.OTHER:
        return R.REASONS.other.max;
      default:
        return 0;
    }
  }

  _daily() {
    const today = utcDay(Date.now()), yesterday = utcDay(Date.now() - 864e5);
    if (this.progress.dd === today) return null;
    const streak = this.progress.dd === yesterday ? Math.min(R.DAILY.maxStreak, this.progress.ds + 1) : 1;
    return { today, streak };
  }

  /** Daily bonus at session start (first session of the UTC day): rules.dailyPay(streak) × the online multiplier. Returns {amount, streak} or null. */
  grantDaily() {
    const d = this._daily();
    if (!d) return null;
    this.progress.dd = d.today;
    this.progress.ds = d.streak;
    const amount = R.dailyPay(d.streak) * R.incomeScale('daily', true);
    this.money += amount;
    return { amount, streak: d.streak };
  }

  // ---------------- purchases & charges ----------------
  buy(id) {
    const p = this.ctx.prices.get(id);
    if (!p) return { result: ECON_RESULT.UNKNOWN, delta: 0 };
    if (this.owned.has(id)) return { result: ECON_RESULT.OWNED, delta: 0 };
    if (this.money < p.price) return { result: ECON_RESULT.FUNDS, delta: 0 };
    this.money -= p.price;
    this.owned.add(id);
    return { result: ECON_RESULT.OK, delta: -p.price };
  }

  /** Sell for 55% of the price times the condition (0..1, reported by the client: it can only lower the payout). */
  sell(id, condition) {
    const p = this.ctx.prices.get(id);
    if (!p) return { result: ECON_RESULT.UNKNOWN, delta: 0 };
    if (!this.owned.has(id)) return { result: ECON_RESULT.NOT_OWNED, delta: 0 };
    if (p.starter) return { result: ECON_RESULT.NOT_SELLABLE, delta: 0 };
    const pay = R.sellPrice(p.price, condition);
    this.owned.delete(id);
    delete this.customs[id];
    this.money += pay;
    return { result: ECON_RESULT.OK, delta: pay };
  }

  /** Instant repair (rules.repairCost): free for starters. Ends armour plating. */
  repair(id, damage) {
    const p = this.ctx.prices.get(id);
    if (!p) return { result: ECON_RESULT.UNKNOWN, delta: 0 };
    if (!this.owned.has(id)) return { result: ECON_RESULT.NOT_OWNED, delta: 0 };
    const cost = R.repairCost(p.price, clamp(damage, 0, 1), !!p.starter);
    if (this.money < cost) return { result: ECON_RESULT.FUNDS, delta: 0 };
    this.money -= cost;
    if (this.customs[id]?.armor) this.customs[id].armor = false;
    return { result: ECON_RESULT.OK, delta: cost ? -cost : 0 };
  }

  /** Legacy paint op: colour $500, metallic / pearl $2,500. */
  paint(variant) {
    const cost = variant ? R.PAINT.metallic : R.PAINT.color;
    if (this.money < cost) return { result: ECON_RESULT.FUNDS, delta: 0 };
    this.money -= cost;
    return { result: ECON_RESULT.OK, delta: -cost };
  }

  /** Hospital fee when wasted (rules.hospitalFee). Returns the amount charged. */
  hospital() {
    const fee = R.hospitalFee(this.money);
    this.money -= fee;
    return fee;
  }

  get insured() { return this.inventory.insuranceUntil > Date.now(); }

  /**
   * Service purchase or free service action. op = SERVICE.*, id = catalog id of an owned model (or null),
   * opts = { color, variant, finish, damage }. → { result, delta, changed } (changed: inventory/cosmetics changed)
   */
  service(op, id, opts = {}) {
    const name = SERVICE_NAMES[op];
    const out = { result: ECON_RESULT.OK, delta: 0, changed: false, cosmetic: false };
    // free actions first
    if (op === SERVICE.NEON_COLOR) {
      const c = id ? this.customs[id] : null;
      if (!c?.neonKit) return { ...out, result: ECON_RESULT.NOT_OWNED };
      const col = opts.color;
      c.neon = col == null || col === 255 ? null : clamp(col | 0, 0, R.NEON_COLORS.length - 1);
      return { ...out, changed: true, cosmetic: true };
    }
    if (op === SERVICE.USE_EXTINGUISHER) {
      if (!(this.inventory.extinguisher > 0)) return { ...out, result: ECON_RESULT.EMPTY };
      this.inventory.extinguisher--;
      return { ...out, changed: true };
    }
    if (op === SERVICE.ARMOR_GONE) {
      if (id && this.customs[id]?.armor) { this.customs[id].armor = false; return { ...out, changed: true, cosmetic: true }; }
      return out;
    }
    if (!name || !R.SERVICES[name]) return { ...out, result: ECON_RESULT.UNKNOWN };
    if (name === 'repair') {
      const r = this.repair(id, opts.damage ?? 0);
      return { ...out, result: r.result, delta: r.delta, changed: r.result === ECON_RESULT.OK, cosmetic: r.result === ECON_RESULT.OK };
    }
    const p = id ? this.ctx.prices.get(id) : null;
    const m = id ? this.ctx.vehicles.byId.get(id) : null;
    const ctxs = {
      price: p?.price ?? 0, cls: p?.cls, kind: m?.kind, starter: !!p?.starter, owned: !!id && this.owned.has(id), insured: this.insured,
      extinguishers: this.inventory.extinguisher, damage: clamp(opts.damage ?? 0, 0, 1), custom: id ? this.customs[id] : undefined,
      opts: { color: opts.color, variant: opts.variant, finish: opts.finish },
    };
    const q = R.servicePrice(name, ctxs);
    if (!q.ok) return { ...out, result: RESULT[q.reason] ?? ECON_RESULT.UNKNOWN };
    const cost = Math.max(0, Math.round(q.price));
    if (cost > this.money) return { ...out, result: ECON_RESULT.FUNDS };
    this.money -= cost;
    out.delta = -cost;
    out.changed = true;
    const c = () => (this.customs[id] ||= {});
    switch (name) {
      case 'extinguisher': this.inventory.extinguisher = Math.min(R.SERVICES.extinguisher.max, this.inventory.extinguisher + 1); break;
      case 'insurance': this.inventory.insuranceUntil = Math.max(Date.now(), this.inventory.insuranceUntil) + R.SERVICES.insurance.durationS * 1000; break;
      case 'armor': c().armor = true; out.cosmetic = true; break;
      case 'neon': c().neonKit = true; c().neon = opts.color == null ? 0 : clamp(opts.color | 0, 0, R.NEON_COLORS.length - 1); out.cosmetic = true; break;
      case 'tint': c().tint = true; out.cosmetic = true; break;
      case 'horn': c().horn = opts.variant; out.cosmetic = true; break;
      case 'respray': c().paint = opts.color >>> 0; c().finish = opts.finish || 'color'; out.cosmetic = true; break;
      default: break; // claim (replacement fee), nitro (applied client-side)
    }
    return out;
  }

  /** Cosmetics of a model for replication: { neon, tint, horn, paint, finish, armor } or null. */
  cosmeticsOf(id) {
    const c = id ? this.customs[id] : null;
    if (!c) return null;
    return {
      neon: c.neonKit && c.neon != null ? c.neon : null, tint: !!c.tint,
      horn: c.horn ? R.HORN_VARIANTS.indexOf(c.horn) : null,
      paint: Number.isInteger(c.paint) ? c.paint : null, finish: Math.max(0, R.PAINT_FINISHES.indexOf(c.finish || 'color')), armor: !!c.armor,
    };
  }

  // ---------------- wardrobe ----------------
  ownsClothing(id) { return this.clothes.has(id) || !!this.ctx.wardrobe?.byId.get(id)?.free; }

  /**
   * Buy a wardrobe item (optionally in a colour), or re-dye an owned one (`dye`: the item's dye price, starters too).
   * → { result, delta }
   */
  buyClothing(itemId, colour = null, dye = false) {
    const it = this.ctx.wardrobe?.byId.get(itemId);
    if (!it) return { result: ECON_RESULT.UNKNOWN, delta: 0 };
    const c = validColour(colour);
    if (c != null && it.colors?.length && !it.colors.includes(c)) return { result: ECON_RESULT.UNKNOWN, delta: 0 }; // off-palette
    const owned = this.ownsClothing(itemId);
    let cost;
    if (owned) {
      // owned in this colour already (never dyed = the palette's default colour)
      if (c == null || c === (this.clothes.get(itemId) ?? it.colors?.[0] ?? null)) return { result: ECON_RESULT.OWNED, delta: 0 };
      cost = it.dye;
    } else cost = it.price;
    if (this.money < cost) return { result: ECON_RESULT.FUNDS, delta: 0 };
    this.money -= cost;
    this.clothes.set(itemId, c ?? this.clothes.get(itemId) ?? null);
    return { result: ECON_RESULT.OK, delta: -cost, worn: Object.values(this.outfit).includes(itemId) };
  }

  /** Wear items (catalog ids; the slot comes from the item): owned or free, one per wardrobe slot. → ECON_RESULT */
  setOutfit(ids) {
    const wt = this.ctx.wardrobe;
    if (!wt) return ECON_RESULT.UNKNOWN;
    const fit = {};
    for (const id of ids) {
      const it = wt.byId.get(id);
      if (!it || !it.slot) return ECON_RESULT.UNKNOWN;
      if (!this.ownsClothing(id)) return ECON_RESULT.NOT_OWNED;
      if (fit[it.slot]) return ECON_RESULT.VARIANT;
      fit[it.slot] = id;
    }
    this.outfit = fit;
    return ECON_RESULT.OK;
  }
}

const validColour = (c) => (Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : null);

function sanitizeCustom(c) {
  const o = {};
  if (c.neonKit) { o.neonKit = true; o.neon = c.neon == null ? null : clamp(c.neon | 0, 0, R.NEON_COLORS.length - 1); }
  if (c.tint) o.tint = true;
  if (typeof c.horn === 'string' && R.HORN_VARIANTS.includes(c.horn)) o.horn = c.horn;
  if (Number.isInteger(c.paint) && c.paint >= 0 && c.paint <= 0xffffff) { o.paint = c.paint; o.finish = R.PAINT_FINISHES.includes(c.finish) ? c.finish : 'color'; }
  if (c.armor) o.armor = true;
  return o;
}

function maxSpeed(mv, t0, t1) {
  let m = 0;
  mv.forEach(t0, t1, (t, x, y, z, hs) => { if (hs > m) m = hs; });
  return m;
}

// a crash: the observed speed dropped by > 25 km/h within 0.4 s since `since`
function crashedSince(mv, since, now) {
  let crashed = false, newerT = 0, newerS = 0;
  mv.forEach(Math.max(since, now - 8000), now, (t, x, y, z, hs) => {
    if (newerT && newerT - t < 400 && hs - newerS > R.COMBO.crashKmh / 3.6) crashed = true;
    newerT = t; newerS = hs;
  });
  return crashed;
}
