// Haptic feedback via navigator.vibrate (Android Chrome/Firefox; a silent no-op on iOS Safari).
// Rate-limited so bursts of events (multi-hit crashes) never queue long vibrations.

export class Haptics {
  constructor(game) {
    this.game = game;
    this.supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    this.enabled = this.supported && game.settings?.touchHaptics !== false;
    this._last = 0;
    this._gear = null;
    this._veh = null;
    const on = game.events?.on?.bind(game.events);
    if (!on) return;
    this._off = [
      on('impact', (e) => this.onImpact(e)),
      on('money:pickup', (e) => { if ((e?.amount ?? 0) > 0) this.pulse([12, 40, 12], true); }),
      on('vehicle:enter', (e) => { if (e?.vehicle && e.vehicle === game.player?.controllable) this.pulse(25, true); }),
      on('vehicle:exit', () => this.pulse(18, true)),
      on('explosion', (e) => this.onExplosion(e)),
      on('wasted', () => this.pulse([60, 60, 120], true)),
    ];
  }

  /** ms or pattern; force skips the rate limit (rare, important events). */
  pulse(p, force = false) {
    if (!this.enabled) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // Chrome logs an error otherwise
    const now = performance.now();
    if (!force && now - this._last < 70) return;
    this._last = now;
    try { navigator.vibrate(p); } catch { /* blocked before the first user gesture */ }
  }

  tap() { this.pulse(8); }

  onImpact(e) {
    const s = e?.strength ?? 0;
    if (s < 0.18 || !e.position) return;
    const p = this.game.player;
    const f = p?.focus;
    if (!f) return;
    const dx = e.position.x - f.x, dz = e.position.z - f.z;
    if (dx * dx + dz * dz > (p.mode === 'vehicle' ? 49 : 9)) return; // only hits on/at the player
    this.pulse(Math.round(14 + 50 * Math.min(1, s)));
  }

  onExplosion(e) {
    const f = this.game.player?.focus;
    if (!f || !e?.position) return;
    const d = Math.hypot(e.position.x - f.x, e.position.z - f.z);
    if (d < 40) this.pulse(Math.round(30 + 90 * (1 - d / 40)), true);
  }

  /** Per frame (cheap): short tick on gear changes of the player's vehicle. */
  update() {
    if (!this.enabled) return;
    const p = this.game.player;
    const v = p?.mode === 'vehicle' ? p.controllable : null;
    const g = v?.telemetry?.gear;
    if (v !== this._veh) { this._veh = v; this._gear = g; return; }
    if (typeof g === 'number' && g !== this._gear) {
      if (this._gear !== null && g !== 0) this.pulse(10);
      this._gear = g;
    }
  }

  dispose() { for (const f of this._off || []) f?.(); }
}
