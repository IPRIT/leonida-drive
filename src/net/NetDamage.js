// Our car's visual damage → the server, on change only (C_VIS DAMAGE, ≤ 31 bytes, at most every 0.5 s): detached
// panels, glass, broken lamps and the strongest impacts (src/net/shared/damage-codec.js). The server keeps the latest
// and serves it in INFO, so players around us (and late arrivals) see the same dents (src/net/render/RemoteDamage.js).
import * as THREE from 'three';
import { VIS } from './shared/constants.js';
import { encodeVis } from './shared/protocol.js';
import { encodeDamage, lampBit, IMPACTS_MAX } from './shared/damage-codec.js';

const MIN_GAP_MS = 500;
const _v = new THREE.Vector3(), _c = new THREE.Vector3();

export class NetDamage {
  constructor(game, client) {
    this.game = game;
    this.client = client;
    this.vehicle = null;
    this.impacts = [];
    this.last = ''; // last sent payload (string) — '' = clean
    this.dirty = false;
    this.t = 0;
    this.sentAt = -1e9;
    const ev = game.events;
    this._off = [];
    const on = (n, fn) => { const o = ev?.on?.(n, fn); if (typeof o === 'function') this._off.push(o); };
    on('impact', (e) => this._impact(e));
    on('vehicle:part', (e) => { if (e?.vehicle === this.vehicle) this.dirty = true; });
    client.on?.('welcome', () => { this.last = ''; this.dirty = true; }); // the server forgot (new session): resend
  }

  _impact(e) {
    const v = this.vehicle;
    if (!v || e?.source !== v || !e.position || !v.object3d) return;
    const en = e.strength ?? 0;
    if (en < 0.08) return;
    const r = v.spec?.wheelRadius ?? 0.33;
    const p = v.object3d.worldToLocal(_v.set(e.position.x, e.position.y, e.position.z));
    // inward direction: towards the body centre (the event has no normal)
    const dmg = this.game.damage?.get?.(v);
    _c.copy(dmg?.center || _c.set(0, 0.4, 0)).sub(p);
    _c.y *= 0.3;
    if (_c.lengthSq() < 1e-6) _c.set(0, 0, -1);
    _c.normalize();
    const rec = { p: [p.x, p.y + r, p.z], d: [_c.x, _c.y, _c.z], e: en, s: e.kind === 'scrape' ? 1 : 0 };
    // keep the strongest few (the biggest dents)
    if (this.impacts.length < IMPACTS_MAX) this.impacts.push(rec);
    else {
      let mi = 0;
      for (let i = 1; i < this.impacts.length; i++) if (this.impacts[i].e < this.impacts[mi].e) mi = i;
      if (this.impacts[mi].e < en) this.impacts[mi] = rec;
    }
    this.dirty = true;
  }

  /** Per frame (cheap: state is read at most twice a second, and only when something happened). */
  update(dt, now = performance.now()) {
    const v = this.game.player?.controllable || null;
    if (v !== this.vehicle) { this.vehicle = v; this.impacts.length = 0; this.dirty = true; this.last = this.last ? '!' : ''; }
    this.t += dt;
    if (!this.client.online || this.t < 0.5) return;
    this.t = 0;
    const d = v ? this.game.damage?.get?.(v) : null;
    if (d) {
      const glass = d.glass | 0, lamps = this._lamps(d), panels = d.parts?.filter((p) => p.detached).map((p) => p.key) || [];
      const sig = `${glass}|${lamps}|${panels.length}`;
      if (sig !== this.sig) { this.sig = sig; this.dirty = true; }
      if (!this.dirty || now - this.sentAt < MIN_GAP_MS) return;
      this.dirty = false;
      const clean = !glass && !lamps && !panels.length && !this.impacts.length;
      const bytes = clean ? new Uint8Array(0) : encodeDamage({ panels, glass, lamps, impacts: this.impacts });
      const key = clean ? '' : bytes.join(',');
      if (key === this.last) return;
      this.last = key;
      this.sentAt = now;
      this.client.send(encodeVis(VIS.DAMAGE, bytes));
    } else if (this.dirty && this.last) { // on foot / no damage model: nothing to show
      this.dirty = false;
      this.last = '';
      this.sentAt = now;
      this.client.send(encodeVis(VIS.DAMAGE, new Uint8Array(0)));
    } else this.dirty = false;
    // repaired (damage reset): forget the dents
    if (d && d.body >= 1 && d.engine >= 1 && !d.glass && this.impacts.length && !d.parts?.some((p) => p.detached)) { this.impacts.length = 0; this.dirty = true; }
  }

  _lamps(d) {
    let m = 0;
    for (const l of d.lamps || []) if (l.broken) m |= 1 << lampBit(l.kind, l.center?.x ?? 0);
    return m;
  }

  dispose() { for (const o of this._off) o(); }
}
