// Local persistence of where you were and what you drove, per mode:
//   'leonida.save.single.pos' — singleplayer (the only source of truth there)
//   'leonida.save.online.pos' — online: offline fallback and an instant hint before the server answers
// Money / ownership / progress belong to game.economy (singleplayer, localStorage) or the server (online).
const KEY = (mode) => `leonida.save.${mode === 'single' ? 'single' : 'online'}.pos`;

export class LocalSave {
  constructor(game, mode) {
    this.game = game;
    this.mode = mode;
    this.key = KEY(mode);
    this.t = 5;
    this._flush = () => this.save();
    this._vis = () => { if (document.visibilityState === 'hidden') this.save(); };
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this._flush);
      window.addEventListener('beforeunload', this._flush);
      document.addEventListener('visibilitychange', this._vis);
    }
  }

  load() {
    try {
      const s = JSON.parse(localStorage.getItem(this.key) || 'null');
      if (s && Number.isFinite(s.x) && Number.isFinite(s.z)) return s;
    } catch { /* corrupted or private mode */ }
    return null;
  }

  /** Current state: { x, y, z, yaw, vehicle (catalog id or ''), paint, health, t }. */
  snapshot() {
    const g = this.game, p = g.player;
    if (!p || p.wastedT > 0) return null;
    const v = p.state === undefined || p.state === 'vehicle' ? p.controllable : null;
    let x, y, z, yaw = 0;
    if (v?.object3d) {
      const o = v.object3d;
      x = o.position.x; y = o.position.y; z = o.position.z;
      const q = o.quaternion;
      yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    } else {
      const f = p.character?.position || p.pos || p.focus;
      if (!f) return null;
      x = f.x; y = f.y; z = f.z; yaw = p.yaw ?? 0;
    }
    if (![x, y, z].every(Number.isFinite)) return null;
    // only owned vehicles come back (a carjacked traffic car does not)
    const owned = !v || !g.economy?.owns || g.economy.owns(v.catalogId);
    return {
      x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100, yaw: Math.round(yaw * 1000) / 1000,
      vehicle: v && owned && !v.fromTraffic ? v.catalogId || '' : '', paint: typeof v?.color === 'number' ? v.color : 0,
      health: p.health ?? 1, t: Date.now(),
    };
  }

  save() {
    const s = this.snapshot();
    if (!s) return;
    try { localStorage.setItem(this.key, JSON.stringify(s)); } catch { /* quota / private mode */ }
  }

  update(dt) {
    this.t -= dt;
    if (this.t <= 0) { this.t = 5; this.save(); }
  }

  dispose() {
    this.save();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._flush);
      window.removeEventListener('beforeunload', this._flush);
      document.removeEventListener('visibilitychange', this._vis);
    }
  }
}
