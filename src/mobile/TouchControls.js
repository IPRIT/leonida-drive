// Context-sensitive touch controls overlay (GTA-mobile style).
// Contexts: drive (cars, bikes, trucks…), boat, heli, plane, foot, free (free camera), none.
// Analog controls feed the VirtualPad (standard gamepad mapping, read by every gamepad-aware module); toggles without
// a pad binding use synthetic KeyboardEvents (same path as a real keyboard); the camera is dragged directly.
// DOM: built once; context switches are one attribute change; per frame only transforms of the active analog
// controls are written, and only when they moved. Pointer Events + setPointerCapture (multitouch).
import { icon } from './icons.js';
import { GP } from './VirtualPad.js';
import { clamp, driveAxis, linAxis, steerCurve, stickVector } from './math.js';
import { applyLook, holdLook, lookStick } from './camera.js';

// Buttons: id → { ic, x: contexts, a: action, cond?: flag, grp?: slide group, acc: accent, small?: utility row,
// top?: top bar next to the HUD's ☰ (not in the row) }
// actions: ['pad', index, value?, rise?] hold | ['tap', index] | ['key', code] tap | ['hold', code] | ['horn'] | ['look'] | ['fire']
const BTN = {
  gas: { ic: 'gas', x: 'drive boat tank', a: ['pad', GP.RT, 1, 7], grp: 'pedal', acc: '#3dff8e' },
  brake: { ic: 'brake', x: 'drive boat tank', a: ['pad', GP.LT, 1, 14], grp: 'pedal', acc: '#ff4d63' },
  hbrake: { ic: 'handbrake', x: 'drive', a: ['pad', GP.A], acc: '#ffb02e' },
  nitro: { ic: 'nitro', x: 'drive', a: ['pad', GP.B], acc: '#2ad8ff' },
  // tank: main gun (Tank.fireHeld, held = keeps firing as it reloads) and the gunner's sight (TankCamera: C)
  fire: { ic: 'fire', x: 'tank', a: ['fire'], acc: '#ff5a3c' },
  sight: { ic: 'sight', x: 'tank', a: ['key', 'KeyC'], acc: '#ffb02e' },
  exit: { ic: 'exit', x: 'drive boat heli plane tank', a: ['tap', GP.Y], acc: '#ff3fa4' },
  horn: { ic: 'horn', x: 'drive boat tank', a: ['horn'], acc: '#ffe066', small: 1 },
  lights: { ic: 'lights', x: 'drive tank', a: ['key', 'KeyH'], acc: '#fff1a8', small: 1 },
  cam: { ic: 'camera', x: 'drive boat heli plane foot', a: ['key', 'KeyC'], acc: '#b79bff', small: 1 },
  look: { ic: 'lookback', x: 'drive', a: ['look'], acc: '#b79bff', small: 1 },
  radio: { ic: 'radio', x: 'drive boat tank', a: ['tap', GP.RIGHT], acc: '#ff8a3d', small: 1 },
  // photo mode (P): top bar, next to the HUD's menu button
  photo: { ic: 'photo', x: 'drive boat heli plane foot free tank', a: ['key', 'KeyP'], cond: 'photo', acc: '#ffffff', small: 1, top: 1 },
  // free camera (V) on: under the photo button (same family); in free mode its own exit button (fexit) takes over
  freecam: { ic: 'freefly', x: 'drive boat heli plane foot tank', a: ['key', 'KeyV'], cond: 'freecam', acc: '#ff3fa4', small: 1, top: 1 },
  flip: { ic: 'flip', x: 'drive', a: ['key', 'KeyR'], cond: 'flip', acc: '#ffb02e' },
  jump: { ic: 'jump', x: 'foot', a: ['tap', GP.X], acc: '#29f0e0' },
  enter: { ic: 'enter', x: 'foot', a: ['tap', GP.Y], cond: 'near', acc: '#ff3fa4' },
  dive: { ic: 'dive', x: 'foot', a: ['pad', GP.B], cond: 'swim', acc: '#3fa6ff' },
  assist: { ic: 'assist', x: 'heli plane', a: ['key', 'KeyN'], acc: '#29f0e0', small: 1 },
  gear: { ic: 'gear', x: 'plane', a: ['key', 'KeyB'], acc: '#ffe066', small: 1 },
  flaps: { ic: 'flaps', x: 'plane', a: ['key', 'KeyG'], acc: '#ffe066', small: 1 },
  smoke: { ic: 'smoke', x: 'plane', a: ['key', 'KeyX'], acc: '#ffffff', small: 1 },
  rudl: { ic: 'left', x: 'plane', a: ['pad', GP.LB], grp: 'rudder', acc: '#29f0e0' },
  rudr: { ic: 'right', x: 'plane', a: ['pad', GP.RB], grp: 'rudder', acc: '#29f0e0' },
  pbrake: { ic: 'brake', x: 'plane', a: ['pad', GP.A], acc: '#ff4d63' },
  up: { ic: 'up', x: 'free', a: ['hold', 'KeyE'], acc: '#29f0e0' },
  down: { ic: 'down', x: 'free', a: ['hold', 'KeyQ'], acc: '#29f0e0' },
  fboost: { ic: 'boost', x: 'free', a: ['hold', 'ShiftLeft'], acc: '#2ad8ff' },
  fexit: { ic: 'freecam', x: 'free', a: ['key', 'KeyV'], acc: '#ff3fa4' },
  menu: { ic: 'menu', x: 'drive boat heli plane foot free tank', a: ['menu'], acc: '#ff3fa4', small: 1, fallback: 1 },
  map: { ic: 'map', x: 'drive boat heli plane foot free tank', a: ['map'], acc: '#ff3fa4', small: 1, fallback: 1 },
};
const SMALL_ORDER = ['horn', 'lights', 'look', 'radio', 'cam', 'assist', 'gear', 'flaps', 'smoke'];

const CTX_LEFT = { drive: 'steer', boat: 'steer', tank: 'steer', foot: 'lstick', free: 'lstick', heli: 'lstick', plane: null };
const STEER_CTX = { drive: 1, boat: 1, tank: 1 }; // steering slider / tilt steering
const CTX_RIGHT = { heli: 'rstick', plane: 'rstick' };

// pointer roles
const R_NONE = 0, R_BTN = 1, R_STEER = 2, R_LSTICK = 3, R_RSTICK = 4, R_CAM = 5, R_THR = 6;

export class TouchControls {
  /**
   * @param {object} game
   * @param {import('./VirtualPad.js').VirtualPad} pad
   * @param {{ parent: HTMLElement, before?: Element|null, haptics?: object, tilt?: object, hudMenu?: boolean, tr: Function }} opts
   */
  constructor(game, pad, opts) {
    this.game = game;
    this.pad = pad;
    this.haptics = opts.haptics || null;
    this.tilt = opts.tilt || null;
    this.tr = opts.tr;
    this.ctx = 'none';
    this.visible = true;
    this.lh = false;
    this.ts = 1;
    this.flags = { near: false, swim: false, flip: false, tilt: false, noexit: false, photo: false, freecam: false, reload: false };
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.safe = { l: 0, r: 0, t: 0, b: 0 };
    this.recs = new Map(); // pointerId → record
    this._pool = [];
    this.heldKeys = new Set();
    this.look = { dx: 0, dy: 0, down: 0 };
    this.steer = { rec: null, x0: 0, y0: 0, dx: 0, out: 0, w: 0, h: 0, dirty: true, el: null, knob: null };
    this.lstick = { rec: null, x0: 0, y0: 0, dx: 0, dy: 0, v: { x: 0, y: 0, mag: 0, over: 0 }, sprint: false, dirty: true, el: null, knob: null };
    this.rstick = { rec: null, x0: 0, y0: 0, dx: 0, dy: 0, v: { x: 0, y: 0, mag: 0, over: 0 }, sprint: false, dirty: true, el: null, knob: null };
    this.thr = { rec: null, value: 0, dirty: true, rect: null, synced: false };
    this.freeKeys = { w: false, a: false, s: false, d: false };
    this.hornVehicle = null;
    this.fireVehicle = null;
    this._grpRects = new Map();
    this._build(opts.parent, opts.before ?? null, !!opts.hudMenu);
    this._bind();
  }

  // ---------------------------------------------------------------- DOM
  _build(parent, before, hudMenu) {
    const root = document.createElement('div');
    root.id = 'touch-ui';
    root.className = 'tc';
    root.setAttribute('aria-hidden', 'true');
    root.dataset.ctx = 'none';
    if (hudMenu) root.classList.add('hud-menu');
    let html = '<div class="tc-surface"></div>';
    html += '<div class="tc-steer tc-an x-drive x-boat x-tank" data-an="steer"><div class="tc-track"><i></i><i></i><i></i></div><div class="tc-knob"></div></div>';
    html += '<div class="tc-stick tc-an x-foot x-free x-heli" data-an="lstick"><div class="tc-ring"></div><div class="tc-knob"></div></div>';
    html += '<div class="tc-stick tc-an r x-heli x-plane" data-an="rstick"><div class="tc-ring"></div><div class="tc-knob"></div></div>';
    html += '<div class="tc-thr x-plane" data-c="thr"><div class="tc-thr-fill"></div><div class="tc-thr-knob"></div></div>';
    html += `<div class="tc-tilt x-drive x-boat x-tank">${icon('tilt')}</div>`;
    const small = {};
    for (const [id, b] of Object.entries(BTN)) {
      const cls = `tc-btn b-${id} ${b.x.split(' ').map((c) => `x-${c}`).join(' ')}${b.cond ? ` c-${b.cond}` : ''}${b.small ? ' sm' : ''}${b.fallback ? ' fb' : ''}${b.top ? ' top' : ''}`;
      const el = `<div class="${cls}" data-c="${id}" style="--acc:${b.acc}">${icon(b.ic)}</div>`;
      if (b.small && !b.fallback && !b.top) small[id] = el; else html += el;
    }
    html += `<div class="tc-row">${SMALL_ORDER.map((id) => small[id] || '').join('')}</div>`;
    html += '<div class="tc-probe"></div>';
    root.innerHTML = html;
    parent.insertBefore(root, before);
    this.root = root;
    this.surface = root.querySelector('.tc-surface');
    this.btnEl = {};
    for (const el of root.querySelectorAll('[data-c]')) this.btnEl[el.dataset.c] = el;
    this.steer.el = root.querySelector('[data-an="steer"]');
    this.steer.knob = this.steer.el.querySelector('.tc-knob');
    this.lstick.el = root.querySelector('[data-an="lstick"]');
    this.lstick.knob = this.lstick.el.querySelector('.tc-knob');
    this.rstick.el = root.querySelector('[data-an="rstick"]');
    this.rstick.knob = this.rstick.el.querySelector('.tc-knob');
    this.thr.el = this.btnEl.thr;
    this.thr.fill = this.thr.el.querySelector('.tc-thr-fill');
    this.thr.knob = this.thr.el.querySelector('.tc-thr-knob');
    this.probe = root.querySelector('.tc-probe');
  }

  _bind() {
    const r = this.root;
    this._onDown = (e) => this.onDown(e);
    this._onMove = (e) => this.onMove(e);
    this._onUp = (e) => this.onUp(e);
    r.addEventListener('pointerdown', this._onDown, { passive: false });
    r.addEventListener('pointermove', this._onMove, { passive: true });
    r.addEventListener('pointerup', this._onUp);
    r.addEventListener('pointercancel', this._onUp);
    r.addEventListener('lostpointercapture', this._onUp);
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    r.addEventListener('dblclick', (e) => e.preventDefault());
  }

  dispose() {
    this.releaseAll();
    this.root.remove();
  }

  // ---------------------------------------------------------------- settings / layout
  setScale(s) { this.ts = clamp(+s || 1, 0.5, 2); this.root.style.setProperty('--ts', String(this.ts)); this.relayout(); }
  setOpacity(o) { this.root.style.setProperty('--to', String(clamp(+o || 0.7, 0.1, 1))); }
  setLeftHanded(on) { this.lh = !!on; this.root.dir = this.lh ? 'rtl' : 'ltr'; this.releaseAll(); this.relayout(); }

  setVisible(on) {
    on = !!on;
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('off', !on);
    if (!on) this.releaseAll();
  }

  /** Re-read viewport size, safe-area insets and cached hit rects. Call on resize/orientation/setting changes. */
  relayout() {
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    const cs = getComputedStyle(this.probe);
    this.safe.l = parseFloat(cs.paddingLeft) || 0;
    this.safe.r = parseFloat(cs.paddingRight) || 0;
    this.safe.t = parseFloat(cs.paddingTop) || 0;
    this.safe.b = parseFloat(cs.paddingBottom) || 0;
    this._grpRects.clear();
    for (const [id, b] of Object.entries(BTN)) {
      if (!b.grp || !b.x.includes(this.ctx)) continue;
      const rc = this.btnEl[id].getBoundingClientRect();
      if (rc.width) this._grpRects.set(id, { l: rc.left, t: rc.top, r: rc.right, b: rc.bottom });
    }
    const st = this.steer;
    st.w = 2 * this.steerR + 56 * this.ts;
    st.h = 56 * this.ts;
    st.el.style.width = `${st.w.toFixed(1)}px`;
    const R2 = 2 * this.stickR;
    this.lstick.el.style.width = this.lstick.el.style.height = this.rstick.el.style.width = this.rstick.el.style.height = `${R2.toFixed(1)}px`;
    const tr = this.thr.el.getBoundingClientRect();
    this.thr.rect = tr.height ? { t: tr.top + 10, h: tr.height - 20 } : null;
    this.steer.dirty = this.lstick.dirty = this.rstick.dirty = this.thr.dirty = true;
    this._flush();
  }

  // radii (px) scale with the button size setting; steering travel shrinks with sensitivity
  get steerR() { return (62 * this.ts) / clamp(this.game.settings?.touchSteerSens ?? 1, 0.4, 2.5); }
  get stickR() { return 54 * this.ts; }

  // rest positions (centre) of the analog controls, physical px
  _rest(which, out) {
    const ts = this.ts, s = this.safe;
    const startX = this.lh ? this.W - s.r : s.l;
    const dir = this.lh ? -1 : 1;
    if (which === 'steer') { out.x = startX + dir * (28 * ts + this.steerR + 22 * ts); out.y = this.H - s.b - 70 * ts; }
    else if (which === 'lstick') { out.x = startX + dir * (40 * ts + this.stickR); out.y = this.H - s.b - 40 * ts - this.stickR; }
    else { // rstick: opposite side
      const endX = this.lh ? s.l : this.W - s.r;
      out.x = endX - dir * (54 * ts + this.stickR + (this.ctx === 'plane' ? 20 * ts : 0));
      out.y = this.H - s.b - 46 * ts - this.stickR;
    }
    return out;
  }

  // ---------------------------------------------------------------- context
  setContext(ctx) {
    if (ctx === this.ctx) return;
    this.releaseAll();
    this.ctx = ctx;
    this.root.dataset.ctx = ctx;
    this.thr.synced = false;
    this.relayout();
  }

  setFlag(name, on) {
    if (this.flags[name] === on) return;
    this.flags[name] = on;
    this.root.classList.toggle(`f-${name}`, on);
    if (name === 'tilt') { this.releaseAll(); this.relayout(); }
  }

  // ---------------------------------------------------------------- pointers
  _rec() { return this._pool.pop() || { id: 0, role: R_NONE, btn: null, x: 0, y: 0, lx: 0, ly: 0 }; }

  _side(x) { return this.lh ? x > this.W * 0.5 : x < this.W * 0.5; } // true = stick side (left for right-handers)

  onDown(e) {
    e.preventDefault(); // no compatibility mouse events, no text selection / callout
    if (!this.visible || this.recs.has(e.pointerId)) return;
    const rec = this._rec();
    rec.id = e.pointerId; rec.x = rec.lx = e.clientX; rec.y = rec.ly = e.clientY; rec.btn = null; rec.role = R_NONE;
    const el = e.target.closest?.('[data-c]');
    const id = el?.dataset.c;
    if (id === 'thr') { rec.role = R_THR; this.thr.rec = rec; this._thrAt(rec.y); }
    else if (id && BTN[id]) { rec.role = R_BTN; rec.btn = id; this._press(id, true); }
    else {
      const x = rec.x, y = rec.y, lowEnough = y > this.H * 0.26;
      const left = CTX_LEFT[this.ctx], right = CTX_RIGHT[this.ctx];
      const tilt = this.flags.tilt && left === 'steer';
      if (left && !tilt && lowEnough && this._side(x) && !this[left].rec) this._startAnalog(left, rec);
      else if (right && lowEnough && !this._side(x) && !this.rstick.rec) this._startAnalog('rstick', rec);
      else if (!this.look.down) { rec.role = R_CAM; this.look.down = 1; }
    }
    if (rec.role === R_NONE) { this._pool.push(rec); return; }
    this.recs.set(e.pointerId, rec);
    try { this.root.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  onMove(e) {
    const rec = this.recs.get(e.pointerId);
    if (!rec) return;
    const x = e.clientX, y = e.clientY;
    switch (rec.role) {
      case R_CAM: this.look.dx += x - rec.lx; this.look.dy += y - rec.ly; break;
      case R_STEER: this._moveSteer(x); break;
      case R_LSTICK: this._moveStick(this.lstick, x, y); break;
      case R_RSTICK: this._moveStick(this.rstick, x, y); break;
      case R_THR: this._thrAt(y); break;
      case R_BTN: this._slide(rec, x, y); break;
      default: break;
    }
    rec.lx = x; rec.ly = y;
  }

  onUp(e) {
    const rec = this.recs.get(e.pointerId);
    if (!rec) return;
    this.recs.delete(e.pointerId);
    this._end(rec);
    this._pool.push(rec);
  }

  _end(rec) {
    switch (rec.role) {
      case R_BTN: if (rec.btn) this._press(rec.btn, false); break;
      case R_STEER: this.steer.rec = null; this.steer.dx = 0; this._applySteer(0); this.steer.dirty = true; break;
      case R_LSTICK: this._stopStick(this.lstick); break;
      case R_RSTICK: this._stopStick(this.rstick); break;
      case R_CAM: this.look.down = 0; break;
      case R_THR: this.thr.rec = null; break;
      default: break;
    }
    rec.role = R_NONE;
    rec.btn = null;
  }

  /** Release every control (context switch, blur, visibility, rotate, menu). */
  releaseAll() {
    for (const rec of this.recs.values()) { this._end(rec); this._pool.push(rec); try { this.root.releasePointerCapture(rec.id); } catch { /* gone */ } }
    this.recs.clear();
    for (const id of Object.keys(BTN)) this.btnEl[id]?.classList.remove('on');
    for (const code of this.heldKeys) key('keyup', code);
    this.heldKeys.clear();
    this.freeKeys.w = this.freeKeys.a = this.freeKeys.s = this.freeKeys.d = false;
    this._horn(false);
    this._fire(false);
    this._lookBack(false);
    this.look.dx = this.look.dy = 0;
    this.look.down = 0;
    this.pad.reset();
  }

  // ---------------------------------------------------------------- buttons
  _press(id, on) {
    const b = BTN[id];
    const el = this.btnEl[id];
    if (on) { el.classList.add('on'); this.haptics?.tap(); } else el.classList.remove('on');
    const a = b.a;
    switch (a[0]) {
      case 'pad': if (on) this.pad.press(a[1], a[2] ?? 1, a[3] ?? 0); else this.pad.release(a[1]); break;
      case 'tap': if (on) this.pad.tap(a[1]); break;
      case 'key': if (on) { key('keydown', a[1]); key('keyup', a[1]); } break;
      case 'hold': this._holdKey(a[1], on); break;
      case 'horn': this._horn(on); break;
      case 'look': this._lookBack(on); break;
      case 'fire': this._fire(on); break;
      case 'menu': if (on) this._openMenu(null); break;
      case 'map': if (on) this._openMenu('map'); break;
      default: break;
    }
  }

  // thumb sliding across a group (gas ↔ brake, rudder L ↔ R) switches the pressed button
  _slide(rec, x, y) {
    const g = BTN[rec.btn]?.grp;
    if (!g) return;
    for (const [id, r] of this._grpRects) {
      if (id === rec.btn || BTN[id].grp !== g) continue;
      if (x >= r.l && x <= r.r && y >= r.t && y <= r.b) { this._press(rec.btn, false); rec.btn = id; this._press(id, true); return; }
    }
  }

  _openMenu(tab) {
    const ui = this.game.ui;
    if (ui?.open && ui.menu) { if (tab) ui.open(tab); else ui.open(); return; }
    this.pad.tap(tab ? GP.BACK : GP.START); // stub UI / other handlers read START/BACK
  }

  _holdKey(code, on) {
    if (on) { if (this.heldKeys.has(code)) return; this.heldKeys.add(code); key('keydown', code); }
    else if (this.heldKeys.delete(code)) key('keyup', code);
  }

  _horn(on) {
    const g = this.game;
    if (on) {
      const v = g.player?.mode === 'vehicle' ? g.player.controllable : null;
      if (!v || this.hornVehicle) return;
      this.hornVehicle = v;
      g.events.emit('horn', { vehicle: v, on: true });
    } else if (this.hornVehicle) {
      g.events.emit('horn', { vehicle: this.hornVehicle, on: false });
      this.hornVehicle = null;
    }
  }

  // tank main gun: Tank reads fireHeld every frame (fires whenever loaded while held)
  _fire(on) {
    if (on) {
      const p = this.game.player;
      const v = p?.mode === 'vehicle' ? p.controllable : null;
      if (!v || !('fireHeld' in v) || this.fireVehicle) return;
      this.fireVehicle = v;
      v.fireHeld = true;
    } else if (this.fireVehicle) {
      this.fireVehicle.fireHeld = false;
      this.fireVehicle = null;
    }
  }

  _lookBack(on) {
    const p = this.game.player;
    if (p?.chase && 'lookBack' in p.chase) p.chase.lookBack = !!on && p.mode === 'vehicle';
  }

  // ---------------------------------------------------------------- analog
  _startAnalog(which, rec) {
    const st = this[which];
    st.rec = rec;
    rec.role = which === 'steer' ? R_STEER : which === 'lstick' ? R_LSTICK : R_RSTICK;
    // floating origin under the thumb, kept inside the screen
    const R = which === 'steer' ? this.steerR : this.stickR;
    st.x0 = clamp(rec.x, this.safe.l + R * 0.6, this.W - this.safe.r - R * 0.6);
    st.y0 = clamp(rec.y, this.H * 0.3, this.H - this.safe.b - (which === 'steer' ? 32 * this.ts : R * 0.7));
    st.dx = 0; st.dy = 0;
    st.dirty = true;
    st.el.classList.add('on');
    if (which !== 'steer') this._applyStick(st);
  }

  _moveSteer(x) {
    const st = this.steer;
    const R = this.steerR;
    st.dx = clamp(x - st.x0, -R, R);
    const v = Math.abs(st.dx) < 4 ? 0 : st.dx / R;
    this._applySteer(steerCurve(v, 1.3));
    st.dirty = true;
  }

  _applySteer(s) {
    this.steer.out = s;
    // cars and the tank: compensate DriveInput's deadzone + response curve; boats read input.axis(0) (linear, deadzone 0.15)
    this.pad.setAxis(0, this.ctx === 'drive' || this.ctx === 'tank' ? driveAxis(s) : linAxis(s));
  }

  _moveStick(st, x, y) {
    let dx = x - st.x0, dy = y - st.y0;
    const R = this.stickR, d = Math.hypot(dx, dy), maxD = R * 1.45;
    if (d > maxD) { // the base follows the thumb (fast direction reversals)
      const k = (d - maxD) / d;
      st.x0 += dx * k; st.y0 += dy * k;
      dx = x - st.x0; dy = y - st.y0;
    }
    st.dx = dx; st.dy = dy;
    this._applyStick(st);
    st.dirty = true;
  }

  _stopStick(st) {
    st.rec = null;
    st.dx = st.dy = 0;
    stickVector(0, 0, 1, 0, st.v);
    st.el.classList.remove('on', 'sprint');
    st.sprint = false;
    this._applyStick(st);
    st.dirty = true;
  }

  _applyStick(st) {
    const v = stickVector(st.dx, st.dy, this.stickR, 0.1, st.v);
    const pad = this.pad;
    const ctx = this.ctx;
    if (st === this.lstick) {
      if (ctx === 'foot') {
        pad.setAxis(0, linAxis(v.x));
        pad.setAxis(1, linAxis(v.y));
        // sprint: push the stick to (past) its edge — PlayerController reads A (held) as sprint
        const sp = st.sprint ? v.over > 0.92 : v.over > 1.12;
        if (sp !== st.sprint) { st.sprint = sp; st.el.classList.toggle('sprint', sp); if (sp) { pad.press(GP.A); this.haptics?.tap(); } else pad.release(GP.A); }
      } else if (ctx === 'heli') {
        // collective (up/down) on the triggers, tail rotor (left/right) on the bumpers (digital in readHeli)
        const up = -v.y;
        if (up > 0.08) { pad.press(GP.RT, up); pad.release(GP.LT); } else if (up < -0.08) { pad.press(GP.LT, -up); pad.release(GP.RT); } else { pad.release(GP.LT); pad.release(GP.RT); }
        if (v.x < -0.35) { pad.press(GP.LB); pad.release(GP.RB); } else if (v.x > 0.35) { pad.press(GP.RB); pad.release(GP.LB); } else { pad.release(GP.LB); pad.release(GP.RB); }
      } else if (ctx === 'free') {
        const fk = this.freeKeys;
        this._freeKey(fk, 'w', 'KeyW', v.y < -0.35);
        this._freeKey(fk, 's', 'KeyS', v.y > 0.35);
        this._freeKey(fk, 'a', 'KeyA', v.x < -0.35);
        this._freeKey(fk, 'd', 'KeyD', v.x > 0.35);
      }
    } else {
      // right stick: cyclic (heli) / yoke (plane) on the left-stick axes, as on a gamepad
      pad.setAxis(0, linAxis(v.x));
      pad.setAxis(1, linAxis(v.y));
    }
  }

  _freeKey(fk, k, code, on) {
    if (fk[k] === on) return;
    fk[k] = on;
    this._holdKey(code, on);
  }

  _thrAt(y) {
    const r = this.thr.rect;
    if (!r) return;
    this.thr.value = clamp(1 - (y - r.t) / r.h, 0, 1);
    this.thr.dirty = true;
  }

  // ---------------------------------------------------------------- per frame
  /** Called once per frame by the mobile module (not while paused). */
  update(dt) {
    const g = this.game;
    // camera drag
    const lk = this.look;
    if (this._stickLook) { this._stickLook = false; this.pad.setAxis(2, 0); this.pad.setAxis(3, 0); }
    if (lk.dx || lk.dy) {
      if (!applyLook(g, lk.dx, lk.dy)) { lookStick(lk.dx, lk.dy, dt, this.pad); this._stickLook = true; }
      lk.dx = lk.dy = 0;
    } else if (lk.down) holdLook(g);
    // tilt steering (drive/boat/tank, no finger on the slider)
    if (this.flags.tilt && STEER_CTX[this.ctx] && this.tilt) {
      const s = this.tilt.read(dt, g.settings?.touchSteerSens ?? 1);
      this._applySteer(s);
      const deg = s * 30;
      if (Math.abs(deg - (this._tiltDeg ?? 99)) > 0.8) { this._tiltDeg = deg; this._tiltEl ??= this.root.querySelector('.tc-tilt'); this._tiltEl.style.transform = `rotate(${deg.toFixed(1)}deg)`; }
    }
    // plane: absolute throttle lever → throttleRate (RT/LT) servo on the craft's own throttle state
    if (this.ctx === 'plane') {
      const v = g.player?.controllable;
      const cur = v?.telemetry?.throttle ?? 0;
      if (!this.thr.synced) { this.thr.value = cur; this.thr.synced = true; this.thr.dirty = true; }
      const e = this.thr.value - cur;
      const rate = Math.abs(e) < 0.01 ? 0 : clamp(e * 6, -1, 1);
      if (rate > 0) { this.pad.press(GP.RT, rate); this.pad.release(GP.LT); } else if (rate < 0) { this.pad.press(GP.LT, -rate); this.pad.release(GP.RT); } else { this.pad.release(GP.RT); this.pad.release(GP.LT); }
    }
    this._flush();
  }

  // write transforms of moved analog controls (only when dirty)
  _flush() {
    const st = this.steer;
    if (st.dirty) {
      st.dirty = false;
      let x = st.x0, y = st.y0;
      if (!st.rec) { this._rest('steer', _p); x = _p.x; y = _p.y; st.el.classList.remove('on'); }
      st.el.style.transform = `translate3d(${(x - st.w / 2).toFixed(1)}px,${(y - st.h / 2).toFixed(1)}px,0)`;
      st.knob.style.transform = `translate3d(${st.dx.toFixed(1)}px,0,0)`;
    }
    if (this.lstick.dirty) this._flushStick(this.lstick, 'lstick');
    if (this.rstick.dirty) this._flushStick(this.rstick, 'rstick');
    const th = this.thr;
    if (th.dirty) {
      th.dirty = false;
      th.fill.style.transform = `scaleY(${th.value.toFixed(3)})`;
      th.knob.style.transform = `translate3d(0,${(-th.value * (th.rect?.h ?? 0)).toFixed(1)}px,0)`;
    }
  }

  _flushStick(sk, which) {
    sk.dirty = false;
    let x = sk.x0, y = sk.y0;
    if (!sk.rec) { this._rest(which, _p); x = _p.x; y = _p.y; }
    const R = this.stickR;
    const m = Math.hypot(sk.dx, sk.dy), k = m > R ? R / m : 1;
    sk.el.style.transform = `translate3d(${(x - R).toFixed(1)}px,${(y - R).toFixed(1)}px,0)`;
    sk.knob.style.transform = `translate3d(${(sk.dx * k).toFixed(1)}px,${(sk.dy * k).toFixed(1)}px,0)`;
  }
}

const _p = { x: 0, y: 0 };

// Synthetic keyboard event: reaches game.input and every module's own key listeners (FreeCamera, DriveInput)
function key(type, code) {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: '', bubbles: true }));
}
