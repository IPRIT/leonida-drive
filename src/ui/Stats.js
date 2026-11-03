const KEY = 'leonida.stats';
const ZERO = { driven: 0, flown: 0, sailed: 0, topSpeed: 0, money: 0, crashes: 0, explosions: 0, destroyed: 0, wasted: 0, spawned: 0, playtime: 0 };

// Persistent player statistics fed by game events (distance from the player's focus, top speed from telemetry).
export class Stats {
  constructor(game) {
    this.game = game;
    this.data = { ...ZERO };
    try { Object.assign(this.data, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore */ }
    this.last = null;
    this.saveT = 5;
    this.crashCd = 0;
    const ev = game.events;
    ev.on('money:pickup', (p) => { if (p?.amount > 0) this.data.money += p.amount; });
    ev.on('explosion', () => { this.data.explosions++; });
    ev.on('vehicle:destroyed', () => { this.data.destroyed++; });
    ev.on('wasted', () => { this.data.wasted++; });
    ev.on('impact', (p) => this.onImpact(p));
  }

  onImpact(p) {
    if (!p || this.crashCd > 0 || (p.strength ?? 0) < 0.35) return;
    const pl = this.game.player, v = pl?.controllable;
    if (!v || pl.mode !== 'vehicle') return;
    let mine = p.source === v || p.vehicle === v;
    if (!mine && p.position && p.kind !== 'water') {
      const t = v.body?.translation?.();
      mine = !!t && Math.hypot(t.x - p.position.x, t.z - p.position.z) < 7;
    }
    if (!mine) return;
    this.data.crashes++;
    this.crashCd = 1.2;
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (!p) return;
    this.data.playtime += dt;
    if (this.crashCd > 0) this.crashCd -= dt;
    const f = p.focus;
    if (p.mode === 'vehicle' && p.controllable) {
      if (this.last) {
        const d = Math.hypot(f.x - this.last.x, f.z - this.last.z);
        if (d < 60) { // ignore teleports
          const k = p.controllable.kind;
          if (k === 'heli' || k === 'plane') this.data.flown += d;
          else if (k === 'boat') this.data.sailed += d;
          else this.data.driven += d;
        }
      }
      const s = p.controllable.telemetry?.speedKmh ?? 0;
      if (s > this.data.topSpeed && s < 1500) this.data.topSpeed = s;
      this.last = { x: f.x, z: f.z };
    } else this.last = null;
    if ((this.saveT -= dt) <= 0) { this.saveT = 5; this.save(); }
  }

  bump(key, n = 1) { this.data[key] = (this.data[key] || 0) + n; }
  reset() { this.data = { ...ZERO }; this.save(); }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ } }
}
