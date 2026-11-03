// game.events → sounds.
import { clamp } from '../core/util.js';
import { Horn, hornTypeFor, tinnitus } from './Synths.js';
import { Voice3D } from '../core/Voice3D.js';

const MAT = {
  metal: 'metal', steel: 'metal', car: 'metal', vehicle: 'metal', iron: 'metal', glass: 'glass', window: 'glass',
  wood: 'wood', tree: 'wood', palm: 'wood', concrete: 'concrete', stone: 'concrete', rock: 'concrete', building: 'concrete',
  brick: 'concrete', asphalt: 'concrete', plastic: 'plastic', prop: 'plastic', bin: 'plastic', flesh: 'body', ped: 'body',
  body: 'body', character: 'body', water: 'splash',
};
const STEP = {
  asphalt: 'step_hard', road: 'step_hard', concrete: 'step_hard', paved: 'step_hard', urban: 'step_hard', building: 'step_hard', hard: 'step_hard', tile: 'step_hard', sport: 'step_hard',
  grass: 'step_grass', park: 'step_grass', farm: 'step_grass', wetland: 'step_water', mud: 'step_water',
  sand: 'step_sand', beach: 'step_sand', dirt: 'step_gravel', gravel: 'step_gravel', wood: 'step_wood', metal: 'step_metal', water: 'step_water',
};
const DOORLESS = new Set(['motorcycle', 'moped', 'bicycle', 'bike', 'boat', 'scooter']);

export class EventSounds {
  constructor(sys) {
    this.sys = sys;
    this.recent = [];
    this.fires = new Map();
    this.horns = new Map();
    this.lastHover = 0;
    this.lastStep = 0;
    this.impactsThisSec = 0;
    this.secT = 0;
    const ev = sys.game?.events;
    this.offs = [];
    if (!ev) return;
    const on = (n, fn) => this.offs.push(ev.on(n, (p) => { if (sys.ctx) fn.call(this, p || {}); }));
    on('impact', this.impact);
    on('explosion', this.explosion);
    on('fire:start', this.fireStart);
    on('fire:stop', this.fireStop);
    on('money:pickup', this.money);
    on('ped:knocked', (e) => this.at('body', e.position, 0.45 + 0.55 * clamp(e.strength ?? 0.5, 0, 1), { ref: 4 }));
    on('building:destroyed', (e) => {
      const size = clamp((e.size ?? 20) / 30, 0.4, 1.6);
      this.at('collapse', e.position, size, { ref: 18 * size, reverb: 0.9, delayByDistance: true, bus: 'boom', priority: 10 });
      if (e.position && sys.distTo(e.position) < 150) sys.mixer.duckForBoom(0.35, sys.ctx.currentTime + sys.distTo(e.position) / 343, 0.8, 2.5);
      this.mark(e.position, 'building');
    });
    on('building:damaged', (e) => { if (!this.isRecent(e.position, 0.1, 6)) this.at('concrete', e.position, 0.8, { ref: 8 }); });
    on('tree:broken', (e) => { this.mark(e.position, 'tree'); this.at('tree_crack', e.position, 0.9, { ref: 8 }); });
    on('lamp:broken', (e) => { this.mark(e.position, 'lamp'); this.at('lamp_break', e.position, 0.85, { ref: 7 }); });
    on('splash', (e) => this.splash(e.position, clamp(e.strength ?? 0.5, 0, 1)));
    on('footstep', this.footstep);
    on('ped:carjacked', (e) => {
      if (e.vehicle) e.vehicle.__audioRunning = true;
      const p = e.vehicle?.object3d || e.position;
      this.at('door_open', p, 0.8, { ref: 3, pitch: 0.88 });
      this.at('body', p, 0.6, { ref: 3, delay: 0.35 });
      this.at('body', p, 0.45, { ref: 3, delay: 0.7, pitch: 0.9 });
    });
    on('vehicle:enter', (e) => this.doors(e.vehicle, true));
    on('vehicle:exit', (e) => this.doors(e.vehicle, false));
    on('horn', this.horn);
    on('ui:hover', () => { const t = performance.now(); if (t - this.lastHover > 45) { this.lastHover = t; sys.play('ui_hover', { bus: 'ui', volume: 0.35, pitch: 0.97 + Math.random() * 0.06 }); } });
    on('ui:click', () => { sys.play('ui_click', { bus: 'ui', volume: 0.6 }); sys.mixer.duckMusic(0.25, 0.1, 0.3); });
    on('ui:open', () => { sys.play('ui_open', { bus: 'ui', volume: 0.55 }); sys.mixer.setState('menu', 1); });
    on('ui:close', () => { sys.play('ui_close', { bus: 'ui', volume: 0.5 }); sys.mixer.setState('menu', 0); });
    on('ui:notify', () => { sys.play('ui_notify', { bus: 'ui', volume: 0.55 }); sys.mixer.duckMusic(0.5, 0.6, 0.8); });
    on('wasted', () => { sys.play('wasted', { bus: 'ui', volume: 0.95 }); sys.mixer.setState('wasted', 1); });
    on('respawn', () => { sys.play('respawn', { bus: 'ui', volume: 0.6 }); sys.mixer.setState('wasted', 0); });
    on('time:skip', () => { sys.play('timeskip', { bus: 'ui', volume: 0.5 }); sys.ambience?.snap(); });
    on('weather', (e) => sys.ambience?.onWeather(e));
    on('lightning', (e) => sys.ambience?.thunder(e));
    on('vehicle:despawn', (e) => sys.forgetVehicle(e.vehicle));
    on('vehicle:destroyed', (e) => sys.vehicleDestroyed(e.vehicle));
  }

  // remember special events so the generic `impact` that follows doesn't double up
  mark(p, kind) { if (p) this.recent.push({ t: performance.now(), x: p.x, z: p.z, kind }); }
  isRecent(p, sec = 0.08, r = 2) {
    if (!p) return false;
    const now = performance.now();
    this.recent = this.recent.filter((e) => now - e.t < 400);
    return this.recent.some((e) => now - e.t < sec * 1000 && Math.hypot(e.x - p.x, e.z - p.z) < r);
  }

  at(name, position, volume, o = {}) {
    if (!position) return this.sys.play(name, { volume, ...o });
    return this.sys.play(name, { position, volume, ...o });
  }

  impact(e) {
    const s = clamp(e.strength ?? 0.5, 0, 1);
    if (s < 0.03 || !e.position) return;
    const now = performance.now() / 1000;
    if (now - this.secT > 1) { this.secT = now; this.impactsThisSec = 0; }
    if (++this.impactsThisSec > 14) return;
    if (this.isRecent(e.position, 0.09, 2.5)) return;
    this.mark(e.position, 'impact');
    const mat = MAT[e.material] || MAT[e.kind] || 'metal';
    if (mat === 'splash') return this.splash(e.position, s);
    const vol = 0.18 + 0.82 * Math.pow(s, 0.7);
    const pitch = 1.08 - s * 0.22 + (Math.random() - 0.5) * 0.08;
    if (mat === 'metal' && s > 0.62 && (e.kind === 'vehicle' || !e.kind)) {
      this.at('crash', e.position, vol, { ref: 6 + s * 8, pitch, delayByDistance: true });
    } else {
      const variant = mat === 'metal' ? (s > 0.5 ? 2 : 0) + (Math.random() < 0.5 ? 1 : 0) : -1;
      this.at(mat, e.position, vol, { ref: 3 + s * 8, pitch, variant, delayByDistance: true });
      if (mat === 'metal' && s > 0.45 && Math.random() < 0.35) this.at('glass', e.position, vol * 0.55, { ref: 4, delayByDistance: true });
    }
    if (s > 0.55 && mat !== 'body') this.at('concrete', e.position, s * 0.5, { ref: 6, pitch: 0.8 });
  }

  explosion(e) {
    const sys = this.sys, p = e.position;
    if (!p) return;
    const power = clamp(Number.isFinite(e.power) ? e.power : 1, 0.2, 5);
    const d = sys.distTo(p);
    const far = d > 380;
    const delay = Math.min(d / 343, 3.5);
    const sp = Math.sqrt(power);
    const now = sys.ctx.currentTime;
    // positional body: big reference distance so a car blowing up 20–30 m away still hits at full weight
    sys.play(far ? 'explosion_far' : 'explosion', {
      position: p, volume: clamp(0.8 + 0.3 * power, 0.5, 1.5), ref: 22 * sp, rolloff: 0.85, air: 0.3, reverb: 1.1, delay, bus: 'boom',
      pitch: (far ? 1 : 1.02 - 0.08 * Math.min(1, power - 0.5)) * (0.95 + Math.random() * 0.08), priority: 10,
    });
    if (!far && d > 60) sys.play('explosion_far', { position: p, volume: 0.65, ref: 30, rolloff: 0.85, air: 0.3, delay: delay + 0.15, reverb: 1, bus: 'boom', priority: 10 });
    // non-positional low end (LFE-style): felt rather than located, fades with distance
    const lfe = clamp(1.25 * sp / (1 + d / (45 * sp)), 0, 1.4);
    if (lfe > 0.04) sys.play('explosion_sub', { bus: 'boom', volume: lfe, delay, pitch: 0.95 + Math.random() * 0.08, priority: 10 });
    // short side-chain duck of everything else (engines, traffic, ambience, music)
    const reach = 110 * sp;
    if (d < reach) sys.mixer.duckForBoom(clamp(0.65 * (1 - d / reach) + 0.15, 0.15, 0.75), now + delay, 0.35 + 0.25 * Math.min(1, power), 1.8);
    if (d < 14 * sp) tinnitus(sys, clamp(1 - d / (14 * sp), 0.35, 1));
  }

  fireStart(e) {
    const sys = this.sys;
    const key = e.target ?? `${Math.round(e.position?.x)}:${Math.round(e.position?.z)}`;
    if (this.fires.has(key)) return;
    const obj = e.target?.object3d || (e.target?.isObject3D ? e.target : null);
    const pos = obj || e.position;
    this.at('fire_whoosh', e.position || obj?.position, 0.8, { ref: 6 });
    if (this.fires.size >= 4) {
      let worst = null, wd = -1;
      for (const [k, f] of this.fires) { const d = f.voice ? f.voice.dist : 0; if (d > wd) { wd = d; worst = k; } }
      this.fires.get(worst)?.stop(1);
      this.fires.delete(worst);
    }
    const loop = sys.loop('fire_loop', { position: pos, volume: 0.75, ref: 4 });
    if (loop) this.fires.set(key, loop);
  }

  fireStop(e) {
    let key = e.target;
    if (!this.fires.has(key) && e.position) {
      let bd = 8;
      for (const [k, f] of this.fires) {
        const p = f.voice?.pos;
        if (!p) continue;
        const d = Math.hypot(p.x - e.position.x, p.z - e.position.z);
        if (d < bd) { bd = d; key = k; }
      }
    }
    const f = this.fires.get(key);
    if (f) { f.stop(2); this.fires.delete(key); }
  }

  money(e) {
    const amt = e.amount ?? 100;
    this.sys.play('money', { volume: 0.65, bus: 'sfx', pitch: 1 + Math.random() * 0.04 });
    this.sys.mixer.duckMusic(0.4, 0.5, 0.6);
    if (amt >= 500) this.sys.play('money', { volume: 0.4, bus: 'sfx', pitch: 1.12, delay: 0.11 });
  }

  splash(p, s) {
    const variant = s < 0.33 ? 0 : s < 0.7 ? 1 : 2;
    this.at('splash', p, 0.35 + 0.65 * s, { variant, ref: 3 + s * 6 });
  }

  footstep(e) {
    const now = performance.now();
    if (now - this.lastStep < 70) return;
    this.lastStep = now;
    const name = STEP[e.surface] || 'step_hard';
    const mud = e.surface === 'mud' || e.surface === 'wetland';
    const vol = (e.land ? 0.8 : e.run ? 0.55 : 0.32) * (mud ? 0.7 : 1) * (e.volume ?? 1);
    this.at(name, e.position, vol, { ref: 2, reverb: 0.2, pitch: (e.land ? 0.85 : e.run ? 1.04 : 0.98) * (mud ? 0.72 : 1) * (0.93 + Math.random() * 0.12) });
    if (e.land) this.at('body', e.position, 0.25, { ref: 2, pitch: 1.2 });
  }

  doors(v, entering) {
    if (!v) return;
    const kind = v.kind || 'car';
    const obj = v.object3d;
    const pos = obj || null;
    if (DOORLESS.has(kind)) {
      if (kind !== 'boat') this.at('gear_clunk', pos, 0.4, { ref: 3, delay: entering ? 0.15 : 0 });
      return;
    }
    this.at('door_open', pos, 0.6, { ref: 3, pitch: 0.95 + Math.random() * 0.1 });
    this.at('door_close', pos, 0.75, { ref: 3, delay: entering ? 0.55 : 0.6, pitch: 0.95 + Math.random() * 0.1 });
    if (entering && (kind === 'car' || kind === 'small' || kind === 'van' || kind === 'truck')) this.at('seatbelt', pos, 0.35, { ref: 2, delay: 1.15 });
    if (entering) this.sys.radio?.vehicleEntered?.();
  }

  horn(e) {
    const v = e.vehicle;
    if (!v) return;
    const type = hornTypeFor(v);
    if (e.on) {
      if (type === 'bicycle') { this.at('bicycle_bell', v.object3d, 0.6, { ref: 3 }); return; }
      if (v.siren && this.sys.sirenFor(v)) { this.sys.sirenFor(v).setMode('yelp'); this.horns.set(v, { siren: true }); return; }
      if (this.horns.has(v)) return;
      const dest = this.sys.voiceInputFor(v) || this.tempVoice(v);
      this.horns.set(v, { horn: new Horn(this.sys, type, dest.input || dest), temp: dest.temp ? dest : null });
    } else {
      const h = this.horns.get(v);
      if (!h) return;
      this.horns.delete(v);
      if (h.siren) { this.sys.sirenFor(v)?.setMode('wail'); return; }
      h.horn.stop();
      if (h.temp) setTimeout(() => h.temp.dispose(), 600);
    }
  }

  tempVoice(v) {
    const vc = new Voice3D(this.sys, { object3d: v.object3d, ref: 6, rolloff: 1.6, air: 1, cull: 140, bus: this.sys.mixer.bus.sfx, reverb: 0.3 });
    vc.temp = true;
    return vc;
  }

  dispose() {
    for (const off of this.offs) off();
    for (const f of this.fires.values()) f.stop(0.2);
    for (const h of this.horns.values()) h.horn?.stop();
  }
}
