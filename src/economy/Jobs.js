// Jobs and places (docs/ECONOMY.md): delivery contracts from six depots, three export yards for cars taken from
// traffic, four body shops. Markers are instanced (src/economy/Markers.js); the contract card is DOM (JobHud.js).
// Payouts go through game.economy (rules.js formulas; the server re-validates them online).
//
// Events: job:start / job:complete / job:fail { type: 'delivery', id, … }, export:complete { id, paid, yard, wanted },
//         economy:repair (from Economy).
import * as R from './rules.js';
import { EXPORT_POOL } from './prices.js';
import { buildPlaces, buildDropPoints, polylineLength, PLACE_RADIUS } from './places.js';
import { Markers } from './Markers.js';
import { JobHud } from './JobHud.js';
import { tr, fmt, damageOf } from './Economy.js';
import { registerStrings } from './i18n.js';

const COLORS = { depot: 0xf5c84c, yard: 0xff3fa4, shop: 0x29f0e0, dest: 0x6ac259 };
const CSS_COLORS = { depot: '#f5c84c', yard: '#ff3fa4', shop: '#29f0e0', dest: '#6ac259' };
const LAND = new Set(['car', 'truck', 'bus', 'van', 'small', 'motorcycle', 'bicycle']);
const SLOW_KMH = 18; // stop (or roll slowly) inside a ring to use it (below D's 20 km/h bail-out speed)
const ARRIVE_M = 9;
const SEARCH_TRIES = 8; // one A* route per frame while looking for a destination

export class Jobs {
  constructor(game) {
    this.game = game;
    const roads = game.roads;
    const heightAt = game.terrain ? (x, z) => game.terrain.heightAt(x, z) : null;
    const P = buildPlaces(roads.edges, heightAt, roads.nearest ? (x, z, r, f) => roads.nearest(x, z, r, f) : null);
    this.depots = P.depots.map((p, i) => ({ ...p, type: 'depot', index: i }));
    this.yards = P.yards.map((p, i) => ({ ...p, type: 'yard', index: i }));
    this.shops = P.shops.map((p, i) => ({ ...p, type: 'shop', index: i }));
    this.places = [...this.depots, ...this.yards, ...this.shops];
    this.drops = null; // Float32Array [x, z, y, …], built on the first contract

    this.markers = game.scene ? new Markers(game.scene, this.places.length + 2) : null;
    for (const p of this.places) {
      p.marker = this.markers?.add({ x: p.x, y: p.y, z: p.z, r: PLACE_RADIUS, color: COLORS[p.type], beam: p.type !== 'shop', height: p.type === 'shop' ? 0.9 : 1.3 }) ?? -1;
    }
    this.destMarker = this.markers?.add({ x: 0, y: 0, z: 0, r: 7, color: COLORS.dest, beam: true, visible: false }) ?? -1;
    this.hud = new JobHud(game);

    this.job = null;
    this.search = null;
    this.inside = null;
    this.used = false;
    this.seq = 0;
    this._despawn = null;
    this._hinted = new WeakSet();
    this._blips = null;
    this._visT = 0;
    this._cardT = 0;
    this._lostT = 0;
    this._wanted = { slot: -1, lists: [] };
    this._taken = null;

    const ev = game.events;
    this._off = [
      ev.on('vehicle:spawn', (e) => this._onSpawn(e?.vehicle)),
      ev.on('vehicle:enter', (e) => this._onEnter(e?.vehicle)),
      ev.on('wasted', () => { if (this.job) this._fail('wasted'); }),
      ev.on('vehicle:destroyed', (e) => { if (this.job && e?.vehicle === this.job.vehicle) this._fail('destroyed'); }),
    ];
    this._wrapTakeOver();
  }

  // Mark vehicles spawned from a traffic takeover (carjacking) as `fromTraffic` — export yards only take those.
  // Traffic.takeOver is wrapped once (no file edits); if the integrator applies the patch from INTEGRATION.md
  // (VehicleManager.spawn copies opts.fromTraffic), this stays harmless.
  _wrapTakeOver() {
    const tr = this.game.traffic;
    if (!tr?.takeOver || tr.__ecoWrapped) return;
    const orig = tr.takeOver.bind(tr);
    tr.takeOver = (a) => {
      const spec = orig(a);
      if (spec) {
        spec.fromTraffic = true;
        this._taken = { id: spec.id, x: spec.pos.x, z: spec.pos.z, t: this.game.time };
      }
      return spec;
    };
    tr.__ecoWrapped = true;
  }

  _onSpawn(v) {
    const t = this._taken;
    if (!v || !t) return;
    if (v.catalogId === t.id && this.game.time - t.t < 2) {
      const p = v.body?.translation?.();
      if (!p || Math.hypot(p.x - t.x, p.z - t.z) < 8) { v.fromTraffic = true; this._taken = null; }
    }
  }

  // ---------------------------------------------------------------- public API
  /** Radar/map points of interest: [{ x, z, color, kind: 'depot'|'yard'|'shop'|'dest', label }] (cached). */
  blips() {
    if (this._blips) return this._blips;
    const out = [];
    if (!this.job) for (const p of this.depots) out.push({ x: p.x, z: p.z, color: CSS_COLORS.depot, kind: 'depot', label: p.name });
    for (const p of this.yards) out.push({ x: p.x, z: p.z, color: CSS_COLORS.yard, kind: 'yard', label: p.name });
    for (const p of this.shops) out.push({ x: p.x, z: p.z, color: CSS_COLORS.shop, kind: 'shop', label: p.name });
    if (this.job) out.push({ x: this.job.dest.x, z: this.job.dest.z, color: CSS_COLORS.dest, kind: 'dest', label: this.job.dest.name });
    this._blips = out;
    return out;
  }

  /** The export yards' wanted models right now: [[ids of yard 0], [yard 1], [yard 2]] (rotates every 20 min). */
  wanted() {
    const now = Date.now();
    const slot = Math.floor(now / 1000 / R.EXPORT.wantedRotateS);
    if (slot !== this._wanted.slot) this._wanted = { slot, lists: this.yards.map((y) => R.exportWanted(now, y.index, EXPORT_POOL)) };
    return this._wanted.lists;
  }

  /**
   * What an export yard would pay for vehicle v now.
   * → { pay, condition, wanted, wantedYard, blocked: null | 'notTraffic' | 'owned' | 'cooldown' | 'busy', waitS }
   */
  exportQuote(v, yard = null) {
    const eco = this.game.economy;
    const id = v?.catalogId;
    const price = eco?.price(id) ?? 0;
    const out = { pay: 0, condition: 1, wanted: false, wantedYard: null, blocked: null, waitS: 0 };
    if (!v || !price) { out.blocked = 'notTraffic'; return out; }
    out.condition = Math.round((1 - damageOf(v)) * 100) / 100;
    const lists = this.wanted();
    if (yard) out.wanted = lists[yard.index]?.includes(id) ?? false;
    else {
      const i = lists.findIndex((l) => l.includes(id));
      if (i >= 0) { out.wanted = true; out.wantedYard = this.yards[i]; }
    }
    out.pay = R.exportPay(price, out.condition, out.wanted);
    if (!v.fromTraffic) out.blocked = 'notTraffic';
    else if (eco.owns(id)) out.blocked = 'owned';
    else if (eco.exportCooldownLeft(id) > 0) { out.blocked = 'cooldown'; out.waitS = eco.exportCooldownLeft(id); }
    else if (eco.cooldownLeft('export') > 0) { out.blocked = 'busy'; out.waitS = eco.cooldownLeft('export'); }
    return out;
  }

  /** Cancel the active contract. */
  cancel() { if (this.job) this._fail('cancelled'); }

  // ---------------------------------------------------------------- per frame
  update(dt, game) {
    if (!this._i18n && game.i18n?.register) this._i18n = registerStrings(game.i18n) || true;
    this.markers?.update(game.time);
    const eco = game.economy;
    if (eco) this.hud.updateCombo(eco.combo, eco.comboT, R.COMBO.window);
    const p = game.player;
    const f = p?.focus;
    if (!f) return;
    const v = p.mode === 'vehicle' ? p.controllable : null;
    const kmh = v?.telemetry?.speedKmh ?? 0;

    // rings: trigger once per entry, when slow enough
    let here = null;
    const r2 = PLACE_RADIUS * PLACE_RADIUS;
    for (const pl of this.places) {
      const dx = pl.x - f.x, dz = pl.z - f.z;
      if (dx * dx + dz * dz < r2 && Math.abs(pl.y - f.y) < 6) { here = pl; break; }
    }
    if (here !== this.inside) {
      this.inside = here;
      this.used = false;
      if (here && kmh >= SLOW_KMH && here.type === 'depot' && !this.job) this._toast('eco.depot', 'DELIVERY DEPOT', tr(game, 'eco.depotStop', 'Stop in the marker for a contract'), 2);
    }
    if (here && !this.used && kmh < SLOW_KMH && p.wastedT <= 0 && !game.paused) {
      this.used = true;
      this._use(here, v);
    }

    if (this.search) this._searchStep();
    if (this.job) this._updateJob(dt, v, kmh, f);
    if (this._despawn) {
      const d = this._despawn;
      d.t -= dt;
      if (d.t <= 0) {
        this._despawn = null;
        if (!d.v.occupied && game.vehicles?.active?.includes(d.v)) game.vehicles.despawn(d.v);
      }
    }
    // marker emphasis (2 Hz): yards glow when you drive an exportable car, shops when it is damaged
    this._visT -= dt;
    if (this._visT <= 0 && this.markers) {
      this._visT = 0.5;
      const exportable = !!(v?.fromTraffic && eco && !eco.owns(v.catalogId));
      for (const y of this.yards) this.markers.set(y.marker, { intensity: exportable ? 1.25 : 0.55, beam: exportable || !this.job });
      const damaged = !!v && damageOf(v) > 0.15;
      for (const s of this.shops) this.markers.set(s.marker, { intensity: damaged ? 1.2 : 0.6, beam: damaged });
    }
  }

  _use(place, v) {
    if (place.type === 'depot') this._depot(place, v);
    else if (place.type === 'yard') this._export(place, v);
    else this._repair(place, v);
  }

  // ---------------------------------------------------------------- delivery
  _depot(depot, v) {
    const g = this.game;
    const title = ['eco.depot', 'DELIVERY DEPOT'];
    if (this.job) { this._toast(...title, tr(g, 'eco.depotBusy', 'Finish your current delivery first')); return; }
    if (this.search) return;
    if (!v) { this._toast(...title, tr(g, 'eco.depotNeedVehicle', 'Bring a vehicle to take a contract')); return; }
    if (!LAND.has(v.kind)) { this._toast(...title, tr(g, 'eco.depotLandOnly', 'Land vehicles only')); return; }
    this.drops ||= buildDropPoints(g.roads.edges, g.terrain ? (x, z) => g.terrain.heightAt(x, z) : null);
    const cand = [];
    const D = this.drops, lo = R.DELIVERY.searchMinM, hi = R.DELIVERY.searchMaxM;
    for (let i = 0; i < D.length; i += 3) {
      const d = Math.hypot(D[i] - depot.x, D[i + 1] - depot.z);
      if (d >= lo && d <= hi) cand.push(i);
    }
    this.search = { depot, v, cand, tries: 0 };
  }

  _searchStep() {
    const g = this.game, s = this.search;
    if (s.tries >= SEARCH_TRIES || !s.cand.length || s.v !== g.player.controllable) {
      this.search = null;
      if (s.v === g.player.controllable) this._toast('eco.depot', 'DELIVERY DEPOT', tr(g, 'eco.depotNone', 'No contracts right now, try again'));
      return;
    }
    s.tries++;
    const k = Math.floor(Math.random() * s.cand.length);
    const i = s.cand[k];
    s.cand[k] = s.cand[s.cand.length - 1];
    s.cand.pop();
    const D = this.drops;
    const x = D[i], z = D[i + 1], y = D[i + 2];
    const route = g.roads.route(s.depot.x, s.depot.z, x, z);
    if (!route) return;
    const L = polylineLength(route);
    if (L < R.DELIVERY.minRouteM || L > R.DELIVERY.maxRouteM) return;
    this.search = null;
    this._begin(s.depot, s.v, { x, y, z }, L);
  }

  _begin(depot, v, dest, L) {
    const g = this.game;
    const factor = R.deliveryFactor(v.kind);
    const limit = R.deliveryTimeLimit(L);
    const name = g.world3d?.areaAt?.(dest.x, dest.z)?.name ?? '';
    const routeM = Math.round(L);
    // shown before it is earned: × the online multiplier (economy.earn applies it to the actual payout)
    const maxPay = Math.round(R.deliveryPay(routeM, factor, R.DELIVERY.maxTimeBonus, 1) * (g.economy?.incomeScale?.('delivery') ?? 1));
    const job = {
      type: 'delivery', id: ++this.seq, depot, dest: { ...dest, name }, routeM, limit, left: limit,
      vehicle: v, model: v.catalogId, body0: v.damage?.body ?? 1, factor, maxPay, off: 0, wp: { x: dest.x, z: dest.z },
    };
    this.job = job;
    this._blips = null;
    g.player.setWaypoint?.(job.wp);
    if (this.markers) {
      this.markers.set(this.destMarker, { x: dest.x, y: dest.y, z: dest.z, visible: true });
      for (const d of this.depots) this.markers.show(d.marker, false);
    }
    const upTo = tr(g, 'eco.upTo', 'up to {amount}', { amount: fmt(g, maxPay) });
    this.hud.showCard({
      kind: 'delivery', title: `${tr(g, 'eco.delivery', 'Delivery')} · ${depot.name}`, dest: tr(g, 'eco.to', 'to {place}', { place: name }),
      dist: L, time: limit, pay: upTo,
    });
    this._cardT = 0;
    g.ui?.toast?.(tr(g, 'eco.contract', 'DELIVERY CONTRACT'), `${name} · ${(L / 1000).toFixed(1)} ${tr(g, 'eco.km', 'km')} · ${upTo}`, 3.5);
    g.events.emit('job:start', {
      type: 'delivery', id: job.id, depot: depot.id, from: { x: depot.x, z: depot.z }, to: { x: dest.x, z: dest.z, name },
      routeM: job.routeM, timeLimit: limit, maxPay, vehicle: v.catalogId, factor,
    });
  }

  _updateJob(dt, v, kmh, f) {
    const g = this.game, j = this.job;
    j.left -= dt;
    const jv = j.vehicle;
    if (jv.destroyed || jv.damage?.destroyed) { this._fail('destroyed'); return; }
    if (v !== jv) {
      j.off += dt;
      if (j.off > R.DELIVERY.abandonS) { this._fail('abandoned'); return; }
    } else j.off = 0;
    this._lostT -= dt;
    if (this._lostT <= 0) {
      this._lostT = 1;
      if (g.vehicles?.active && !g.vehicles.active.includes(jv)) { this._fail('lost'); return; }
    }
    if (j.left <= 0) { this._fail('late'); return; }
    const d = Math.hypot(j.dest.x - f.x, j.dest.z - f.z);
    this._cardT -= dt;
    if (this._cardT <= 0) { this._cardT = 0.25; this.hud.updateCard(d, j.left); }
    if (v === jv && d < ARRIVE_M && kmh < 35) this._complete();
  }

  _complete() {
    const g = this.game, j = this.job, v = j.vehicle, eco = g.economy;
    const timeS = j.limit - j.left;
    const bonus = R.deliveryTimeBonus(j.routeM, timeS);
    const cond = R.deliveryCondition(j.body0 - (v.damage?.body ?? 1));
    const pay = R.deliveryPay(j.routeM, j.factor, bonus, cond);
    const pos = { x: j.dest.x, y: j.dest.y, z: j.dest.z };
    // field names as read by the net layer (src/net/NetEconomy.js → C_CLAIM p1/p2/meta/tier)
    const meta = { from: { x: j.depot.x, z: j.depot.z }, length: j.routeM, time: Math.round(timeS), condition: Math.round(cond * 100) / 100, depot: j.depot.id, factor: j.factor, kind: v.kind, job: j.id };
    let paid = pay;
    if (eco) {
      paid = eco.earn('delivery', pay, pos, meta);
      if (paid > 0) g.events.emit('money:pickup', { amount: paid, position: pos, reason: 'delivery' });
    } else g.player.addMoney?.(pay, pos, 'delivery');
    g.ui?.toast?.(tr(g, 'eco.delivered', 'DELIVERED'), tr(g, 'eco.deliveredSub', '+{amount} · speed ×{bonus} · condition {cond}%', {
      amount: fmt(g, paid), bonus: bonus.toFixed(2), cond: String(Math.round(cond * 100)),
    }), 3.5);
    g.events.emit('job:complete', { type: 'delivery', id: j.id, paid, pay, timeS: Math.round(timeS), timeBonus: bonus, condition: cond, routeM: j.routeM, depot: j.depot.id });
    this._end();
  }

  _fail(reason) {
    const g = this.game, j = this.job;
    if (!j) return;
    g.ui?.toast?.(tr(g, 'eco.failed', 'CONTRACT FAILED'), tr(g, `eco.fail.${reason}`, FAIL_TEXT[reason] || reason), 3);
    g.events.emit('job:fail', { type: 'delivery', id: j.id, reason, depot: j.depot.id });
    this._end();
  }

  _end() {
    const g = this.game, j = this.job;
    if (j && g.player.waypoint === j.wp) g.player.setWaypoint?.(null);
    if (this.markers) {
      this.markers.show(this.destMarker, false);
      for (const d of this.depots) this.markers.show(d.marker, true);
    }
    this.hud.hideCard();
    this.job = null;
    this._blips = null;
  }

  // ---------------------------------------------------------------- export yards
  _export(yard, v) {
    const g = this.game, eco = g.economy;
    const title = ['eco.exportYard', 'EXPORT YARD'];
    if (!eco) return;
    if (!v || !LAND.has(v.kind)) { this._wantedToast(yard); return; }
    const q = this.exportQuote(v, yard);
    if (q.blocked) {
      const msg = {
        notTraffic: () => tr(g, 'eco.exportNeedCar', 'Bring a car taken from the street'),
        owned: () => tr(g, 'eco.exportOwned', 'You own this model: it can’t be exported'),
        cooldown: () => tr(g, 'eco.exportCooldown', 'This model was exported recently · {min} min', { min: String(Math.ceil(q.waitS / 60)) }),
        busy: () => tr(g, 'eco.exportBusy', 'The yard is busy · {s} s', { s: String(Math.ceil(q.waitS)) }),
      }[q.blocked];
      this._toast(...title, msg());
      return;
    }
    const pos = { x: yard.x, y: yard.y, z: yard.z };
    const paid = eco.earn('export', q.pay, pos, { model: v.catalogId, condition: q.condition, yard: yard.index, wanted: q.wanted });
    if (!(paid > 0)) { this._toast(...title, tr(g, 'eco.exportBusy', 'The yard is busy · {s} s', { s: String(Math.ceil(eco.cooldownLeft('export'))) })); return; }
    eco.markExported(v.catalogId);
    g.events.emit('money:pickup', { amount: paid, position: pos, reason: 'export' });
    g.events.emit('export:complete', { id: v.catalogId, paid, yard: yard.id, wanted: q.wanted, condition: q.condition });
    g.ui?.toast?.(tr(g, 'eco.exported', 'EXPORTED'), `${v.name || v.catalogId} · +${fmt(g, paid)}${q.wanted ? ` · ${tr(g, 'eco.wantedTag', 'WANTED ×2')}` : ''}`, 3.5);
    if (this.job?.vehicle === v) this._fail('lost');
    // hand the car over: on foot with D's controller; BasicPlayer can't walk, so the yard brings your own car
    const p = g.player;
    const out = p.exit?.({ instant: true });
    if (out === true) this._despawn = { v, t: 1.2 };
    else if (g.spawnForPlayer) g.spawnForPlayer(eco.startPlan().vehicle);
  }

  _wantedToast(yard) {
    const g = this.game;
    const list = (this.wanted()[yard.index] || []).map((id) => g.vehicles?.byId?.get(id)?.name || id);
    const min = Math.ceil(R.exportWantedRefreshS(Date.now()) / 60);
    this._toast('eco.exportYard', yard.name.toUpperCase(), tr(g, 'eco.exportWanted', 'Wanted: {list} (×2) · {min} min', { list: list.join(', '), min: String(min) }), 4);
  }

  // tell the player what a freshly taken car is worth at the docks (once per car)
  _onEnter(v) {
    const g = this.game;
    if (!v?.fromTraffic || this._hinted.has(v) || !g.economy) return;
    this._hinted.add(v);
    const q = this.exportQuote(v);
    if (q.blocked === 'owned' || q.blocked === 'notTraffic') return;
    const name = v.name || v.catalogId;
    const k = g.economy.incomeScale?.('export') ?? 1; // q.pay is the base payout (economy.earn scales it online)
    const text = q.wanted && q.wantedYard
      ? tr(g, 'eco.exportValueWanted', '{yard} wants this {name}: {amount} (×2)', { yard: q.wantedYard.name, name, amount: fmt(g, R.exportPay(g.economy.price(v.catalogId), q.condition, true) * k) })
      : tr(g, 'eco.exportValue', 'Export yards pay {amount} for this {name}', { amount: fmt(g, q.pay * k), name });
    if (g.ui?.feed) g.ui.feed({ kind: 'garage', icon: 'money', text, seconds: 5 });
    else g.ui?.notify?.(text, 5);
  }

  // ---------------------------------------------------------------- body shops
  async _repair(shop, v) {
    const g = this.game, eco = g.economy;
    const title = ['eco.bodyShop', 'BODY SHOP'];
    if (!eco) return;
    if (!v) { this._toast(...title, tr(g, 'eco.repairNeedVehicle', 'Bring a vehicle to repair')); return; }
    if (damageOf(v) < 0.01) { this._toast(...title, tr(g, 'eco.repairNone', 'Looking good: nothing to fix')); return; }
    if (!eco.owns(v.catalogId)) { this._toast(...title, tr(g, 'eco.repairNotOwned', 'We only fix cars you own')); return; }
    const cost = eco.repairCost(v);
    if (cost > eco.money) { this._toast(...title, tr(g, 'eco.repairFunds', 'Repair costs {amount}', { amount: fmt(g, cost) })); return; }
    const res = await eco.repair(v);
    if (!res.ok) { this._toast(...title, res.reason === 'funds' ? tr(g, 'eco.repairFunds', 'Repair costs {amount}', { amount: fmt(g, cost) }) : res.reason); return; }
    if (res.cost > 0) g.ui?.hud?.moneyPop?.(-res.cost);
    this._toast('eco.repaired', 'REPAIRED', res.cost > 0 ? `−${fmt(g, res.cost)}` : tr(g, 'eco.repairFree', 'Free for your starter car'));
  }

  _toast(key, fallback, sub, s = 2.5) {
    this.game.ui?.toast?.(tr(this.game, key, fallback), sub, s);
  }

  dispose() {
    for (const off of this._off) off?.();
    this.markers?.dispose();
    this.hud.dispose();
  }
}

const FAIL_TEXT = {
  late: 'Out of time', destroyed: 'The vehicle is wrecked', abandoned: 'You left the vehicle', lost: 'The vehicle is gone',
  wasted: 'Wasted', cancelled: 'Cancelled',
};
