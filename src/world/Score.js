// Driving skill rewards (docs/ECONOMY.md): drift chains, near misses and stunt jumps, paid through game.economy with the
// GTA-style combo multiplier (+0.5 per chained skill event, max ×5; a crash or 6 s without a skill event resets it).
// Speed traps belong to the world-activities workstream (I): they call game.economy.speedTrap(trap, kmh, pos).
// Without game.economy (labs) the old behaviour stays: player.addMoney, no combo.
import { driftPoints, DRIFT, NEARMISS, nearMissPay, STUNT, stuntPay, COMBO } from '../economy/rules.js';

// controllable kinds that earn driving skill money (no aircraft, no boats)
const GROUND = new Set(['car', 'truck', 'bus', 'van', 'small', 'motorcycle', 'bicycle']);

export class Score {
  constructor(game) {
    this.game = game;
    // drift chain
    this.drift = 0; // points: ∫ kmh × (0.6 + slip) dt
    this.driftT = 0;
    this.driftGrace = 0;
    this.driftKmh = 0; // peak speed of the chain
    // jump
    this.air = 0;
    this.airMaxH = 0;
    // near misses: per-car cooldown + a bundle for misses inside the 1.5 s claim cooldown
    this.nearCool = new WeakMap();
    this.nearCount = 0;
    this.nearKmh = 0;
    this.nearLast = -1e9; // wall-clock s of the last near-miss payout
    this.total = 0;
    this._pos = { x: 0, y: 0, z: 0 };
    this._off = game.events?.on?.('impact', (e) => this._onImpact(e));
    this._offReset = game.events?.on?.('vehicle:reset', ({ vehicle }) => {
      if (vehicle !== game.player?.controllable) return;
      this.air = 0; this.airMaxH = 0;
      this.drift = 0; this.driftT = 0; this.driftKmh = 0; this.driftGrace = 0;
    });
  }

  t(key, fallback, params) {
    const s = this.game.i18n?.t?.(key, params);
    if (s && s !== key) return s;
    return params ? fallback.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m)) : fallback;
  }

  money(n) { return this.game.i18n?.money?.(n) ?? `$${Math.round(n).toLocaleString('en-US')}`; }

  comboTag(c) { return c > 1 ? ` ×${Math.round(c * 10) / 10}` : ''; }

  // position object for claims (fresh: the economy/server may keep it)
  pos() {
    const f = this.game.player.focus;
    return { x: f.x, y: f.y, z: f.z };
  }

  /** Pay a skill reward. base = amount before the combo. bump: raise the combo first. Returns the amount granted. */
  pay(reason, base, meta, bump = true) {
    const g = this.game;
    const eco = g.economy;
    const pos = this.pos();
    let got;
    if (eco?.skill) got = bump ? eco.skill(reason, base, pos, meta) : eco.earnSkill(reason, base, pos, meta);
    else {
      got = Math.round(base);
      if (got > 0) {
        const p = g.player;
        if (p.addMoney) { p.addMoney(got, pos, reason); return got; } // addMoney emits money:pickup itself
        p.money = (p.money || 0) + got;
      }
    }
    if (got > 0) {
      this.total += got;
      g.events.emit('money:pickup', { amount: got, position: pos, reason });
    }
    return got;
  }

  combo() { return this.game.economy?.combo ?? 1; }

  update(dt, game) {
    const p = game.player;
    const v = p.mode === 'vehicle' ? p.controllable : null;
    const tel = v?.telemetry;
    if (!tel || game.paused || !GROUND.has(v.kind) || p.wastedT > 0) {
      this.drift = 0; this.driftT = 0; this.air = 0; this.airMaxH = 0;
      this.flushNear(true);
      return;
    }
    const eco = game.economy;
    const speed = tel.speedKmh || 0;

    // ---- drift chain: kept alive through short straights (grace), paid when it ends ----
    const slip = Math.abs(tel.slipAngle ?? 0);
    if ((tel.drifting || slip > DRIFT.slip) && speed > DRIFT.minKmh && !tel.airborne) {
      this.drift += driftPoints(speed, slip, dt);
      this.driftT += dt;
      if (speed > this.driftKmh) this.driftKmh = speed;
      this.driftGrace = DRIFT.graceS;
      eco?.holdCombo?.();
    } else if (this.drift > 0) {
      this.driftGrace -= dt;
      if (this.driftGrace > 0) eco?.holdCombo?.();
      else {
        if (this.driftT > DRIFT.minChainS) this.payDrift();
        this.drift = 0; this.driftT = 0; this.driftKmh = 0;
      }
    }

    // ---- stunt jumps ----
    const f = p.focus; // the player keeps it at the vehicle's body position (no per-frame Rapier allocations here)
    if (tel.upsideDown) {
      // Wheels off the ground while resting on the roof are not a stunt jump.
      // Clear before R restores wheel contact, otherwise recovery pays the accumulated time.
      this.air = 0;
      this.airMaxH = 0;
    } else if (tel.airborne) {
      this.air += dt;
      const h = f.y - Math.max(0, game.terrain.heightAt(f.x, f.z));
      if (h > this.airMaxH) this.airMaxH = h;
      if (this.air > 0.4) eco?.holdCombo?.();
    } else if (this.air > 0) {
      if (this.air > STUNT.minAirS && !tel.upsideDown) this.payStunt();
      this.air = 0;
      this.airMaxH = 0;
    }

    // ---- near misses with traffic at speed ----
    if (speed > NEARMISS.minKmh && game.traffic) {
      const now = game.time;
      for (const a of game.traffic.agents) {
        if (a.crashed || a.parked) continue;
        const dx = a.cur.x - f.x, dz = a.cur.z - f.z;
        if (dx > NEARMISS.dMax || dx < -NEARMISS.dMax || dz > NEARMISS.dMax || dz < -NEARMISS.dMax) continue;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < NEARMISS.dMax && d > NEARMISS.dMin && !(this.nearCool.get(a) > now)) {
          this.nearCool.set(a, now + NEARMISS.perCarCooldownS);
          this.nearCount++;
          if (speed > this.nearKmh) this.nearKmh = speed;
          eco?.bump?.();
        }
      }
    }
    this.flushNear(false);
  }

  payDrift() {
    const paid = this.pay('drift', this.drift / DRIFT.divisor, { duration: Math.round(this.driftT * 100) / 100, points: Math.round(this.drift), kmh: Math.round(this.driftKmh) });
    if (paid > 0) {
      const c = this.combo();
      this.game.ui?.toast?.(`${this.t('score.drift', 'DRIFT')}${this.comboTag(c)}`, `${this.driftT.toFixed(1)} s · +${this.money(paid)}`, 2.5);
    }
    return paid;
  }

  payStunt() {
    const g = this.game;
    const f = g.player.focus;
    const spot = g.stunts?.spotAt?.(f.x, f.z) ?? null; // named stunt spots (workstream I), optional
    const first = !!spot && !!g.economy?.firstAtStunt?.(spot.id);
    const base = stuntPay(this.air, this.airMaxH, 1, first);
    const paid = this.pay('stunt', base, { air: Math.round(this.air * 100) / 100, height: Math.round(this.airMaxH * 10) / 10, spot: spot?.id, first });
    if (paid > 0) {
      if (first) g.economy.markStunt(spot.id);
      const c = this.combo();
      const title = first ? this.t('score.stuntSpot', 'NEW STUNT SPOT') : this.t('score.stunt', 'STUNT BONUS');
      const sub = `${first && spot.name ? `${spot.name} · ` : ''}${this.air.toFixed(1)} s · ${this.airMaxH.toFixed(0)} m · +${this.money(paid)}`;
      g.ui?.toast?.(`${title}${this.comboTag(c)}`, sub, 2.5);
    }
  }

  // pay bundled near misses once the claim cooldown (1.5 s) allows it
  flushNear(force) {
    if (!this.nearCount) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (!force && now - this.nearLast < 1.55) return;
    const n = Math.min(this.nearCount, NEARMISS.maxBundle);
    const kmh = this.nearKmh;
    this.nearCount = 0;
    this.nearKmh = 0;
    this.nearLast = now;
    const base = nearMissPay(kmh, 1, n);
    if (!(base > 0)) return;
    const paid = this.pay('nearmiss', base, { kmh: Math.round(kmh), count: n }, !this.game.economy);
    if (paid > 0) {
      const label = n > 1 ? this.t('score.nearN', 'Near miss ×{n}', { n }) : this.t('score.near', 'Near miss');
      this.game.ui?.notify?.(`${label}${this.comboTag(this.combo())} +${this.money(paid)}`, 1.5);
    }
  }

  // a crash (impact above 25 km/h) loses the drift chain in progress; the economy resets the combo itself
  _onImpact(e) {
    const v = this.game.player?.controllable;
    if (!e || !v || e.source !== v || (e.strength ?? 0) < COMBO.crashStrength) return;
    if (this.drift > 0 && this.driftT > DRIFT.minChainS) this.game.ui?.notify?.(this.t('score.chainLost', 'Drift chain lost'), 1.5);
    this.drift = 0; this.driftT = 0; this.driftKmh = 0; this.driftGrace = 0;
  }

  dispose() { this._off?.(); this._offReset?.(); }
}
