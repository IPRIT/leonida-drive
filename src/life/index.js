import * as THREE from 'three';
import { LifeHud } from './hud.js';
import { ColliderField } from './colliders.js';
import { Beach } from './Beach.js';
import { Signage } from './Signage.js';
import { Birds } from './Birds.js';
import { Collectibles } from './Collectibles.js';
import { Races } from './Races.js';
import { SpeedTraps } from './SpeedTraps.js';
import { PhotoMode } from './PhotoMode.js';
import { StreetProps } from './StreetProps.js';
import { LIFE_STRINGS } from './strings.js';

// World life & fun (workstream I): beach & coast props, billboards & neon, birds & fireflies, postcards,
// time trials, speed traps and photo mode. One entry point:
//   createGame(app, { modules: [(game) => createLife(game)] })
// Registers itself (order 55) and exposes game.life. See src/life/INTEGRATION.md.
export function createLife(game, opts = {}) {
  const life = new Life(game, opts);
  game.life = life;
  game.register(life, opts.order ?? 55);
  return life;
}

export class Life {
  constructor(game, opts = {}) {
    this.game = game;
    const T = {};
    const lap = (k, t0) => { T[k] = +(performance.now() - t0).toFixed(1); return performance.now(); };
    let t = performance.now();
    const t00 = t;
    game.i18n?.register?.('life', LIFE_STRINGS);
    this.root = new THREE.Group();
    this.root.name = 'life';
    game.scene.add(this.root);
    this.hud = new LifeHud(game);
    this.colliders = new ColliderField(game);
    const on = (k) => opts[k] !== false;
    this.beach = on('beach') ? new Beach(game, this.root, this.colliders) : null; t = lap('beach', t);
    this.signage = on('signage') ? new Signage(game, this.root, this.colliders) : null; t = lap('signage', t);
    this.birds = on('birds') ? new Birds(game, this.root, this.beach?.plan) : null; t = lap('birds', t);
    this.collectibles = on('collectibles') ? new Collectibles(game, this.root, this.hud, { piers: this.beach?.plan.piers, towers: this.beach?.plan.towers }) : null; t = lap('collectibles', t);
    this.races = on('races') ? new Races(game, this.root, this.hud) : null; t = lap('races', t);
    this.traps = on('speedtraps') ? new SpeedTraps(game, this.root, this.hud, this.colliders) : null; t = lap('speedtraps', t);
    this.street = on('street') ? new StreetProps(game, this.root, this.beach?.plan.beachGrid) : null; t = lap('street', t);
    this.photo = on('photo') ? new PhotoMode(game, this) : null;
    this.visual(game.camera, 0, true);
    this.colliders.update(0, true);
    this.street?.field.update(0, true);
    t = lap('stream', t);
    this.prewarm();
    lap('prewarm', t);
    T.total = +(performance.now() - t00).toFixed(1);
    this.stats = { init: T, cpuMs: 0, cpuMax: 0, counts: this.counts() };
    this._win = 0; this._max = 0;
    if (opts.log !== false) console.info('[life] init', T, this.stats.counts);
  }

  counts() {
    const c = {};
    if (this.beach) for (const [k, s] of Object.entries(this.beach.sets)) c[k] = s.count;
    if (this.signage) Object.assign(c, this.signage.stats);
    if (this.birds) c.birdsMax = this.birds.max;
    if (this.collectibles) c.postcards = this.collectibles.total;
    if (this.races) c.races = this.races.routes.length;
    if (this.traps) c.speedTraps = this.traps.traps.length;
    if (this.street) { for (const [k, v] of Object.entries(this.street.counts)) c[`street.${k}`] = v; c.streetColliders = this.street.field.items.length; }
    c.colliders = this.colliders.items.length;
    return c;
  }

  // compile every life material once, into the HDR target the game renders to (no hitches when they first appear)
  prewarm() {
    const g = this.game, r = g.renderer;
    if (!r?.compile) return;
    const prev = r.getRenderTarget();
    try {
      if (g.render?.sceneRT) r.setRenderTarget(g.render.sceneRT);
      r.compile(this.root, g.camera, g.scene);
    } catch (e) { console.warn('[life] prewarm', e); }
    r.setRenderTarget(prev);
  }

  // logic (not called while the game is paused)
  update(dt, game) {
    const t0 = performance.now();
    this.photo?.update(dt, game);
    if (!this.photo?.active) {
      this.colliders.update(dt);
      this.street?.update(dt);
      this.collectibles?.update(dt, game);
      this.races?.update(dt, game);
      this.traps?.update(dt, game);
      this.birds?.update(dt, game);
      this.hud.setVisible(!game.ui?.isOpen);
      this.hud.update(dt);
    }
    this._acc(performance.now() - t0, dt);
  }

  // camera-dependent streaming (after the camera moved)
  lateUpdate(dt, game) {
    const t0 = performance.now();
    this.visual(game.camera, dt, false);
    this._acc(performance.now() - t0, 0);
  }

  visual(cam, dt, force) {
    const p = cam.position;
    this.beach?.update(p, dt, force);
    this.signage?.update(p, dt, force);
    this.street?.visual(p, dt, force);
    this.traps?.updateVisual(p, dt);
    this.birds?.visual(this.game);
  }

  // CPU cost per frame = update + lateUpdate (EMA + 2 s max)
  _acc(ms, dt) {
    if (dt > 0) { this._cur = ms; return; }
    const f = (this._cur || 0) + ms;
    this._cur = 0;
    const st = this.stats;
    st.cpuMs = st.cpuMs * 0.95 + f * 0.05;
    this._max = Math.max(this._max, f);
    this._win += this.game.frame ? 1 / 60 : 0;
    if (this._win > 2) { st.cpuMax = this._max; this._max = 0; this._win = 0; }
  }

  // radar / map blips for the UI (G): race starts, next checkpoint, speed traps
  blips(out = []) {
    this.races?.blips(out);
    this.traps?.blips(out);
    return out;
  }

  dispose() {
    this.colliders.dispose();
    this.street?.dispose();
    this.hud.dispose();
    this.game.scene.remove(this.root);
    this.game.unregister(this);
  }
}
