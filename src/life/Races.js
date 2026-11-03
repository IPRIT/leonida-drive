import * as THREE from 'three';
import { glowMaterial } from './materials.js';
import { ringGeo, coronaGeo } from './geometry.js';
import { buildAllRoutes } from './routes.js';
import { tr, earn, granted, money, restore, persist, ecoProgress, MEDAL_BIT, fmtTime, LAND_KINDS } from './util.js';
import { racePurse, racePay } from '../economy/rules.js';
import { esc, keycap, padGlyph } from './hud.js';
import { GP } from '../core/input.js';

const STORE = 'leonida.races';
const KEY = 'KeyE'; // interact key while driving (E is unbound for land vehicles; F exits the car)
const PAD = GP.UP; // D-pad up (left/right = radio, Y = exit vehicle)
const MAX_KMH = 20; // the prompt shows only when stopped or slow at the marker
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const C_CUR = new THREE.Color(0xffd23a), C_NEXT = new THREE.Color(0x29d0e0), C_FIN = new THREE.Color(0xff3fa4);

function setInst(mesh, i, x, y, z, yaw, pitch, sx, sy, sz) {
  _e.set(pitch, yaw, 0, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  mesh.setMatrixAt(i, _m);
}

// Point-to-point time trials on the road network: start marker → E (D-pad up, or the START button on touch) → 3-2-1 → checkpoint rings →
// finish. Best times + splits persist in localStorage 'leonida.races'. Events: race:countdown, race:start,
// race:checkpoint, race:finish, race:cancel.
export class Races {
  constructor(game, root, hud) {
    this.game = game;
    this.hud = hud;
    const t0 = performance.now();
    this.routes = buildAllRoutes(game.roads);
    this.buildMs = performance.now() - t0;
    this.best = restore(game, STORE, {}) || {};
    this.mergeEconomy();
    game.events.on('economy:change', () => this.mergeEconomy());
    const n = Math.max(1, this.routes.length);

    const ringMat = glowMaterial({ day: 1.5, night: 3.0, pulse: 0.15, pulseSpeed: 5, key: 'ring' });
    const beamMat = glowMaterial({ additive: true, day: 0.45, night: 1.1, heightFade: true, fadeFar: 2200, fadeNear: 24, side: THREE.DoubleSide, key: 'beam' });
    const markerMat = glowMaterial({ additive: true, day: 0.7, night: 1.6, heightFade: true, fadeFar: 1800, fadeNear: 16, pulse: 0.25, pulseSpeed: 3, side: THREE.DoubleSide, key: 'marker' });
    const markerRingMat = glowMaterial({ additive: true, day: 1.4, night: 2.6, fadeFar: 1800, fadeNear: 14, key: 'marker-ring' });
    this.materials = [ringMat, beamMat, markerMat, markerRingMat];
    const mk = (geo, mat, cap, name, order = 0) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.name = name; m.frustumCulled = false; m.count = 0; m.renderOrder = order;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      root.add(m);
      return m;
    };
    this.rings = mk(ringGeo(), ringMat, 3, 'life-race-rings');
    this.beam = mk(coronaGeo(), beamMat, 1, 'life-race-beam', 5);
    this.markers = mk(coronaGeo(), markerMat, n, 'life-race-markers', 5);
    this.markerRings = mk(ringGeo(), markerRingMat, n, 'life-race-marker-rings', 5);
    this.routes.forEach((r, i) => { this.placeMarker(i, true); this.markers.setColorAt(i, C_FIN); this.markerRings.setColorAt(i, C_CUR); });
    this.dimmed = -1;
    this.showMarkers(true);

    this.state = 'idle';
    this.route = null;
    this.cp = 0;
    this.time = 0;
    this.countdown = 0;
    this.prev = new THREE.Vector3();
    this.near = null;
    this.cool = 0;
    this.splits = [];
    this._scan = 0;
    this._labels = { time: '', cp: '', best: '', delta: '' };
    this._panel = { title: '', labels: this._labels, time: '', cp: '', best: '', delta: '', deltaGood: undefined };
    this.deltaT = 0;
    game.events.on('lang', () => this.relabel());
  }

  // medals from the economy (bitmask per trial: 1 gold, 2 silver, 4 bronze)
  mergeEconomy() {
    const m = ecoProgress(this.game)?.medals;
    if (!m) return;
    for (const r of this.routes) {
      const id = r.def.id, bits = m[id] | 0;
      if (!bits) continue;
      const b = (this.best[id] ||= { t: null, splits: [], medals: [] });
      b.medals ||= [];
      for (const [tier, bit] of Object.entries(MEDAL_BIT)) if (bits & bit && !b.medals.includes(tier)) b.medals.push(tier);
    }
  }

  // purse by trial length, shared with the economy/server (src/economy/rules.js)
  purse(r) { return racePurse(r.length); }

  // marker i at full size, or collapsed while the camera sits inside it (no full-screen pink wash)
  placeMarker(i, on) {
    const s = this.routes[i].start, k = on ? 1 : 0.0001;
    setInst(this.markers, i, s.x, s.y - 0.3, s.z, 0, 0, 5 * k, 3.6 * k, 5 * k);
    setInst(this.markerRings, i, s.x, s.y + 3.2, s.z, s.yaw, Math.PI / 2, 3.2 * k, 3.2 * k, 3.2 * k);
    this.markers.instanceMatrix.needsUpdate = true;
    this.markerRings.instanceMatrix.needsUpdate = true;
  }

  dimMarker(i) {
    if (i === this.dimmed) return;
    if (this.dimmed >= 0) this.placeMarker(this.dimmed, true);
    if (i >= 0) this.placeMarker(i, false);
    this.dimmed = i;
  }

  showMarkers(on) {
    const n = on ? this.routes.length : 0;
    this.markers.count = n; this.markerRings.count = n;
    this.markers.instanceMatrix.needsUpdate = true; this.markerRings.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    if (this.markerRings.instanceColor) this.markerRings.instanceColor.needsUpdate = true;
  }

  t(k, f, p) { return tr(this.game, `life.race.${k}`, f, p); }

  vehicle() {
    const p = this.game.player;
    const v = p?.mode === 'vehicle' ? p.controllable : null;
    return v && LAND_KINDS.has(v.kind) && !v.destroyed ? v : null;
  }

  pressed() {
    const inp = this.game.input;
    return inp.pressed(KEY) || inp.gpPressedBtn?.(PAD);
  }

  update(dt, game) {
    if (this.cool > 0) this.cool -= dt;
    const f = game.player?.focus;
    if (!f) return;
    if (this.state === 'idle') this.idle(dt, f);
    else if (this.state === 'countdown') this.tickCountdown(dt, f);
    else if (this.state === 'running') this.run(dt, f);
    this.prev.copy(f);
  }

  idle(dt, f) {
    this._scan -= dt;
    if (this._scan <= 0) {
      this._scan = 0.15;
      const v = this.vehicle();
      const slow = v && Math.abs(v.telemetry?.speedKmh ?? 0) < MAX_KMH;
      let near = null;
      if (this.cool <= 0 && slow && !this.game.ui?.isOpen) {
        for (const r of this.routes) {
          const s = r.start;
          if (Math.hypot(s.x - f.x, s.z - f.z) < 9 && Math.abs(s.y - f.y) < 4) { near = r; break; }
        }
      }
      // collapse the marker the camera is inside
      const cp = this.game.camera.position;
      let inside = -1;
      for (let i = 0; i < this.routes.length; i++) { const s = this.routes[i].start; if (Math.hypot(s.x - cp.x, s.z - cp.z) < 13 && Math.abs(s.y - cp.y) < 12) { inside = i; break; } }
      this.dimMarker(inside);
      const inp = this.game.input;
      const device = inp.touch ? 'touch' : inp.gamepad ? 'pad' : 'kb';
      if (near !== this.near || device !== this._device) {
        this.near = near;
        this._device = device;
        this.showPrompt(near, device);
      }
    }
    if (this.near && this.pressed()) this.begin(this.near);
  }

  showPrompt(r, device) {
    if (!r) { this.hud.prompt(null); this.hud.tapButton(null); return; }
    const b = this.best[r.def.id];
    const glyph = device === 'pad' ? padGlyph('up') : device === 'kb' ? keycap('E') : '';
    const info = `${(r.length / 1000).toFixed(1)} km${b?.t ? ` · ${this.t('best', 'Best')} ${fmtTime(b.t)}` : ''} · ${this.t('prize', 'Prize')} ${money(this.game, this.purse(r) * (this.game.economy?.incomeScale?.('race') ?? 1))}`;
    this.hud.prompt(`${glyph}<b>${esc(this.t('prompt', 'Start time trial'))}</b><em>${esc(this.raceName(r))}</em><i>${esc(info)}</i>`);
    if (device === 'touch') this.hud.tapButton(this.t('startBtn', 'START'), () => { if (this.state === 'idle' && this.near) this.begin(this.near); });
    else this.hud.tapButton(null);
  }

  raceName(r) { return tr(this.game, `life.race.name.${r.def.id}`, r.def.name); }

  begin(r) {
    this.route = r;
    this.state = 'countdown';
    this.countdown = 3.999;
    this.lastShown = 0;
    this.startPos = { x: this.game.player.focus.x, z: this.game.player.focus.z };
    this.hud.prompt(null);
    this.hud.tapButton(null);
    this.near = null;
    this.showMarkers(false);
    this.prevWaypoint = this.game.player.waypoint || null;
    const fin = r.checkpoints[r.checkpoints.length - 1];
    try { this.game.player.setWaypoint?.({ x: fin.x, z: fin.z }); } catch { /* optional */ }
    this.cp = 0;
    this.relabel();
    this.layoutRings();
    this.hud.big(this.raceName(r).toUpperCase(), `${tr(this.game, 'unit.km', '{n} km', { n: Math.round(r.length / 100) / 10 })} · ${r.checkpoints.length} ${this.t('cps', 'checkpoints', { count: r.checkpoints.length })}`, this.t('getReady', 'Get ready'), 1.2, 'gold');
  }

  tickCountdown(dt, f) {
    if (!this.vehicle() || Math.hypot(f.x - this.startPos.x, f.z - this.startPos.z) > 18) { this.cancel('falseStart'); return; }
    this.countdown -= dt;
    const n = Math.ceil(this.countdown);
    if (n !== this.lastShown && n >= 1 && n <= 3) {
      this.lastShown = n;
      this.hud.big(String(n), '', '', 0.9, n === 1 ? 'pink' : '');
      this.game.events.emit('race:countdown', { id: this.route.def.id, n });
    }
    if (this.countdown <= 0) {
      this.state = 'running';
      this.time = 0;
      this.splits = [];
      this.hud.big(this.t('go', 'GO!'), '', '', 0.8, 'teal');
      this.game.events.emit('race:countdown', { id: this.route.def.id, n: 0 });
      this.game.events.emit('race:start', { id: this.route.def.id, name: this.route.def.name, checkpoints: this.route.checkpoints.length, length: this.route.length, best: this.best[this.route.def.id]?.t ?? null, par: this.route.par, purse: this.purse(this.route) * (this.game.economy?.incomeScale?.('race') ?? 1) });
    }
  }

  run(dt, f) {
    const g = this.game;
    this.time += dt * 1000 * (g.timeScale ?? 1);
    const r = this.route, c = r.checkpoints[this.cp];
    if (!this.vehicle()) { this.cancel('vehicle'); return; }
    if (this.pressed()) { this.cancel('quit'); return; }
    // passed? closest approach of this frame's movement segment to the checkpoint centre
    const ax = this.prev.x, az = this.prev.z, bx = f.x, bz = f.z;
    const sx = bx - ax, sz = bz - az, L2 = sx * sx + sz * sz;
    const t = L2 > 1e-6 ? Math.max(0, Math.min(1, ((c.x - ax) * sx + (c.z - az) * sz) / L2)) : 1;
    const px = ax + sx * t, pz = az + sz * t;
    const d = Math.hypot(c.x - px, c.z - pz);
    if (d < c.R + 1.5 && Math.abs(f.y - c.y) < c.R + 4) this.hit();
    else if (Math.hypot(c.x - f.x, c.z - f.z) > 700 || this.time > r.par * 4 + 60000) this.cancel('lost');
    if (this.deltaT > 0) this.deltaT -= dt;
    if (this.state === 'running') this.panel();
  }

  hit() {
    const r = this.route, id = r.def.id;
    const b = this.best[id];
    this.splits.push(this.time);
    const i = this.cp;
    const c = r.checkpoints[i];
    if (c.finish) { this.finish(); return; }
    if (b?.splits?.[i] !== undefined) { this.delta = this.time - b.splits[i]; this.deltaT = 3; } else this.delta = null;
    this.cp++;
    this.layoutRings();
    this.game.events.emit('race:checkpoint', { id, index: i + 1, total: r.checkpoints.length, time: this.time, delta: this.delta, position: { x: c.x, y: c.y, z: c.z } });
  }

  finish() {
    const g = this.game, r = this.route, id = r.def.id;
    const time = this.time;
    const b = (this.best[id] ||= { t: null, splits: [], medals: [] });
    b.medals ||= [];
    const record = !b.t || time < b.t;
    if (record) { b.t = Math.round(time); b.splits = this.splits.map(Math.round); }
    const medal = time <= r.par ? 'gold' : time <= r.par * 1.15 ? 'silver' : time <= r.par * 1.35 ? 'bronze' : null;
    // gold / silver / bronze = 100 / 60 / 35 % of the purse; the first medal of each tier pays in full, repeats 20 %
    let paid = 0;
    if (medal) {
      const first = !b.medals.includes(medal);
      const eco = g.economy, purse = this.purse(r), pos = { x: g.player.focus.x, y: g.player.focus.y, z: g.player.focus.z };
      if (eco?.medal) paid = granted(g, eco.medal(id, medal, purse, pos, time / 1000), pos, 'race');
      else paid = earn(g, 'race', racePay(purse, medal, first), pos, { id, medal, time: Math.round(time) });
      if (first) b.medals.push(medal);
    }
    persist(g, STORE, this.best);
    const medalTxt = medal ? this.t(`medal.${medal}`, { gold: 'GOLD', silver: 'SILVER', bronze: 'BRONZE' }[medal]) : '';
    this.hud.big(fmtTime(time), [record ? this.t('record', 'NEW RECORD') : `${this.t('best', 'Best')} ${fmtTime(b.t)}`, medalTxt, paid ? `+${money(g, paid)}` : ''].filter(Boolean).join('  ·  '), this.t('finished', 'Finished!'), 5, medal === 'gold' ? 'gold' : record ? 'teal' : '');
    g.events.emit('race:finish', { id, name: r.def.name, time: Math.round(time), best: b.t, record, medal, reward: paid, par: Math.round(r.par), purse: this.purse(r) * (g.economy?.incomeScale?.('race') ?? 1) });
    this.end();
  }

  cancel(reason) {
    if (this.state === 'idle') return;
    const id = this.route?.def.id;
    const msg = { falseStart: this.t('falseStart', 'False start'), vehicle: this.t('noVehicle', 'Race abandoned'), quit: this.t('quit', 'Race cancelled'), lost: this.t('lost', 'Off course') }[reason] || this.t('quit', 'Race cancelled');
    this.hud.big(msg.toUpperCase(), '', '', 2, 'pink');
    this.game.events.emit('race:cancel', { id, reason, time: this.time });
    this.end();
  }

  end() {
    this.state = 'idle';
    this.cool = 3;
    this.route = null;
    this.rings.count = 0;
    this.beam.count = 0;
    this.hud.race(null);
    this.showMarkers(true);
    try { this.game.player.setWaypoint?.(this.prevWaypoint || null); } catch { /* optional */ }
  }

  layoutRings() {
    const r = this.route, cps = r.checkpoints;
    let k = 0;
    for (let j = 0; j < 2 && this.cp + j < cps.length; j++) {
      const c = cps[this.cp + j];
      setInst(this.rings, k, c.x, c.y + c.R - 0.7, c.z, c.yaw, 0, c.R, c.R, c.R * (c.finish ? 1.6 : 1));
      this.rings.setColorAt(k, c.finish ? C_FIN : j === 0 ? C_CUR : C_NEXT);
      k++;
    }
    this.rings.count = k;
    this.rings.instanceMatrix.needsUpdate = true;
    this.rings.instanceColor.needsUpdate = true;
    const c = cps[this.cp];
    setInst(this.beam, 0, c.x, c.y, c.z, 0, 0, 0.9, 90, 0.9);
    this.beam.setColorAt(0, c.finish ? C_FIN : C_CUR);
    this.beam.count = 1;
    this.beam.instanceMatrix.needsUpdate = true;
    this.beam.instanceColor.needsUpdate = true;
  }

  // translated labels are cached (i18n lookups allocate); refreshed on race start and language change
  relabel() {
    const L = this._labels;
    L.time = this.t('time', 'Time'); L.cp = this.t('checkpoint', 'Checkpoint'); L.best = this.t('best', 'Best'); L.delta = this.t('delta', 'Split');
    if (this.route) this._panel.title = this.raceName(this.route).toUpperCase();
    this._device = null; // re-render the start prompt in the new language
  }

  panel() {
    const r = this.route, P = this._panel;
    P.time = fmtTime(this.time);
    P.cp = `${Math.min(this.cp + 1, r.checkpoints.length)} / ${r.checkpoints.length}`;
    const b = this.best[r.def.id];
    P.best = b?.t ? fmtTime(b.t) : '--:--.--';
    if (this.deltaT > 0 && this.delta !== null && this.delta !== undefined) {
      P.delta = `${this.delta <= 0 ? '-' : '+'}${fmtTime(Math.abs(this.delta))}`;
      P.deltaGood = this.delta <= 0;
    } else { P.delta = ''; P.deltaGood = undefined; }
    this.hud.race(P);
  }

  // radar/map blips (start markers while idle; next checkpoint while racing)
  blips(out = []) {
    if (this.state === 'idle') for (const r of this.routes) out.push({ x: r.start.x, z: r.start.z, color: '#ff3fa4', kind: 'race', name: r.def.name });
    else if (this.route) { const c = this.route.checkpoints[this.cp]; if (c) out.push({ x: c.x, z: c.z, color: '#ffd23a', kind: 'checkpoint' }); }
    return out;
  }

  // lab helper: teleport next to a race start
  startPoint(i = 0) { return this.routes[i]?.start ?? null; }
}
