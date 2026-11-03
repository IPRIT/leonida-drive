// Mobile layer (workstream K): touch controls, orientation/viewport handling, mobile performance profile.
// Usage (bootstrap / labs):  createGame(app, { modules: [(g) => createMobile(g)] })
// See src/mobile/INTEGRATION.md.
import './mobile.css';
import { detectDevice, urlFlag } from './detect.js';
import { VirtualPad } from './VirtualPad.js';
import { TouchControls } from './TouchControls.js';
import { Viewport } from './viewport.js';
import { TiltSteer } from './tilt.js';
import { Haptics } from './haptics.js';
import { applyMobileProfile, applyBudgets, installFrameCap } from './perf.js';
import { MOBILE_STRINGS as STRINGS } from './strings.js';
import { PhotoTouch } from './photo.js';

export { VirtualPad, GP } from './VirtualPad.js';
export { detectDevice } from './detect.js';

const isTyping = (e) => {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

export class MobileModule {
  /**
   * @param {object} game
   * @param {{ touch?: boolean, mobile?: boolean }} [opts] force the touch controls / the mobile profile (also ?touch=1, ?mobile=1)
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.order = 1; // after the player (0): cameras are adjusted in update(), before every lateUpdate
    this.device = detectDevice();
    const forceTouch = opts.touch ?? urlFlag('touch');
    const forceMobile = opts.mobile ?? urlFlag('mobile');
    if (forceMobile !== null && forceMobile !== undefined) {
      this.device.mobile = !!forceMobile;
      this.device.reasons.push(`forced mobile=${!!forceMobile}`);
    }
    this.forceTouch = forceTouch;
    this.active = false;
    this.orientation = 'landscape';
    this.controls = null;
    this.viewport = null;
    this.pad = new VirtualPad();
    this.tilt = new TiltSteer();
    this.haptics = new Haptics(game);
    this._pause = new Set();
    this._iPaused = false;
    this._userVisible = game.settings?.touchControls !== false;
    this._kbHidden = false;
    this._padHidden = false;
    this._menuOpen = false;
    this._photoOn = false;
    this.photo = new PhotoTouch(game, this);
    this._di = null;
    this._condT = 0;
    this._budget = {};
    this._off = [];
    this.tr = (key, fallback) => {
      const s = game.i18n?.t?.(key, { default: fallback });
      return s && s !== key ? s : fallback;
    };
    game.i18n?.register?.('mobile', STRINGS);

    // ---- performance profile (phones / tablets only; never overrides a user quality choice)
    this.profile = this.device.mobile ? applyMobileProfile(game, this.device) : { applied: false, profile: game.quality?.name ?? game.render?.profile?.name ?? '?', reason: 'desktop' };
    this._setupBudgets();
    installFrameCap(game, () => this.fpsCap());

    // ---- settings
    const on = (k, fn) => game.onSetting?.(k, fn);
    on('touchScale', (v) => this.controls?.setScale(v));
    on('touchOpacity', (v) => this.controls?.setOpacity(v));
    on('touchLeftHanded', (v) => this.controls?.setLeftHanded(v));
    on('touchSteerSens', () => this.controls?.relayout());
    on('tiltSteer', (v) => this.setTilt(!!v, true));
    on('touchHaptics', (v) => { this.haptics.enabled = this.haptics.supported && v !== false; });
    on('touchControls', (v) => this.setControlsVisible(v !== false));

    // ---- events
    const ev = game.events;
    this._off.push(
      ev.on('ui:open', () => { this._menuOpen = true; if (this._iPaused) this._iPaused = false; this.viewport?.syncRotate(); this._sync(); }),
      ev.on('ui:close', () => { this._menuOpen = false; this.viewport?.syncRotate(); this._syncPause(); this._sync(); }),
      ev.on('lang', () => { this.viewport?.texts(); this.photo.texts(); }),
      // photo mode pauses the game and owns the screen: no controls, its own touch gestures + buttons
      ev.on('photo:enter', () => { this._photoOn = true; this.photo.setActive(this.active); this._sync(); }),
      ev.on('photo:exit', () => { this._photoOn = false; this.photo.setActive(false); this._sync(); }),
    );
    // keyboard / physical gamepad hide the touch controls; the next touch brings them back
    this._onKey = (e) => { if (e.isTrusted && !isTyping(e) && this.active && !this._kbHidden) { this._kbHidden = true; this._sync(); } };
    this._onTouch = (e) => {
      if (e.pointerType !== 'touch') return;
      if (!this.active && this.forceTouch !== false) this.activate();
      else if (this._kbHidden || this._padHidden) { this._kbHidden = false; this._padHidden = false; this._sync(); }
    };
    this._onPad = () => { this._padHidden = hasPhysicalPad(); this._sync(); };
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('pointerdown', this._onTouch, true);
    window.addEventListener('gamepadconnected', this._onPad);
    window.addEventListener('gamepaddisconnected', this._onPad);

    game.mobile = this;
    if (forceTouch === true || (forceTouch !== false && (this.device.touch || game.input?.touch))) this.activate();
  }

  // ---------------------------------------------------------------- public API (game.mobile)
  get controlsVisible() { return !!this.controls?.visible; }

  /** Show/hide the touch controls (e.g. a full-screen map or cut-scene). Persistent until called again. */
  setControlsVisible(on) { this._userVisible = !!on; this._sync(); }

  /** Vibrate (ms or pattern) if supported and enabled. */
  haptic(p) { this.haptics.pulse(p, true); }

  /** Turn the touch layer on (also happens automatically on the first touch on a hybrid device). */
  activate() {
    if (this.active) return;
    const g = this.game;
    const canvas = g.renderer?.domElement;
    const container = canvas?.parentElement;
    if (!container) return;
    this.active = true;
    document.body.classList.add('is-mobile');
    if (g.input) { g.input.touch = true; g.input.virtualPad = this.pad; }
    const hud = document.getElementById('hud');
    this.controls = new TouchControls(g, this.pad, {
      parent: container, before: hud && hud.parentElement === container ? hud : canvas.nextSibling,
      haptics: this.haptics, tilt: this.tilt, hudMenu: !!document.getElementById('menu-btn'), tr: this.tr,
    });
    const s = g.settings || {};
    this.controls.setOpacity(s.touchOpacity ?? 0.7);
    this.controls.setLeftHanded(!!s.touchLeftHanded);
    this.controls.setScale(s.touchScale ?? 1);
    if (this.device.mobile) {
      this.viewport = new Viewport(g, this);
      this.viewport.install(container);
    } else {
      // touch on a desktop/hybrid device: no orientation handling, just keep the hit areas in sync with the window
      let t = 0;
      this._onWinResize = () => { clearTimeout(t); t = setTimeout(() => this.controls?.relayout(), 150); };
      window.addEventListener('resize', this._onWinResize);
    }
    if (s.tiltSteer) this.setTilt(true, false);
    this._padHidden = hasPhysicalPad();
    this._sync();
    g.events.emit('mobile:active', { active: true });
  }

  // ---------------------------------------------------------------- pause (portrait / hidden / blur)
  setPauseReason(name, on) {
    if (on) this._pause.add(name); else this._pause.delete(name);
    this._syncPause();
  }

  _syncPause() {
    const g = this.game;
    if (this._pause.size) {
      if (!g.paused) { g.paused = true; this._iPaused = true; this.controls?.releaseAll(); }
    } else if (this._iPaused) {
      this._iPaused = false;
      if (!g.ui?.isOpen) g.paused = false;
    }
    this._sync(); // update() does not run while paused
  }

  onOrientation(o) {
    this.orientation = o;
    this.controls?.releaseAll();
    this.game.events.emit('mobile:orientation', { orientation: o });
  }

  // 15 fps behind the rotate screen, 60 on phones/tablets (opt-in 120 via settings.mobileFps), uncapped on desktop
  fpsCap() {
    if (this._pause.has('portrait')) return 15;
    if (!this.device.mobile) return 0;
    const f = +(this.game.settings?.mobileFps ?? 60);
    return f >= 120 ? 0 : f >= 30 ? f : 60;
  }

  // ---------------------------------------------------------------- tilt steering
  setTilt(on, fromSetting) {
    if (!on) { this.tilt.disable(); this.controls?.setFlag('tilt', false); return; }
    const notify = (k, fb) => this.game.ui?.notify?.(this.tr(k, fb), 3.5);
    const revert = (k, fb) => {
      this.tilt.disable();
      notify(k, fb);
      if (this.game.settings?.tiltSteer) {
        this.game.applySetting('tiltSteer', false);
        // the settings row already shows "on": switch it back (G's markup: [data-key] .sw.on)
        document.querySelector('[data-key="tiltSteer"] .sw')?.classList.remove('on');
      }
    };
    this.tilt.enable().then((r) => {
      if (r === 'granted') {
        if (fromSetting) notify('mobile.tiltOn', STRINGS.en.tiltOn);
        clearTimeout(this._tiltCheck);
        this._tiltCheck = setTimeout(() => { if (this.tilt.enabled && !this.tilt.live) revert('mobile.tiltNone', STRINGS.en.tiltNone); }, 2000);
      } else if (r === 'needs-gesture') {
        // persisted setting on iOS: permission can only be asked from a tap
        notify('mobile.tiltTap', STRINGS.en.tiltTap);
        if (this._tiltOnce) return;
        this._tiltOnce = () => {
          for (const t of ['touchend', 'click']) window.removeEventListener(t, this._tiltOnce, true);
          this._tiltOnce = null;
          if (this.game.settings?.tiltSteer) this.setTilt(true, true);
        };
        for (const t of ['touchend', 'click']) window.addEventListener(t, this._tiltOnce, true);
      } else revert(r === 'unavailable' ? 'mobile.tiltNone' : 'mobile.tiltDenied', r === 'unavailable' ? STRINGS.en.tiltNone : STRINGS.en.tiltDenied);
    });
  }

  // ---------------------------------------------------------------- budgets (traffic / peds / vegetation)
  _setupBudgets() {
    const g = this.game;
    const q = g.quality || g.render?.profile;
    if (!q || !this.device.mobile) return;
    const apply = () => applyBudgets(g, this._budget); // mobile/low caps, or restores the bases on other presets
    apply();
    // registered after the bootstrap/UI handlers, so the mobile caps stay applied
    for (const k of ['traffic', 'peds', 'drawDist']) g.onSetting?.(k, apply);
    // bootstrap maps quality 'auto' to 'high': on a phone, 'auto' means F's mobile preset
    g.onSetting?.('quality', (v) => { if (v === 'auto') this.profile = applyMobileProfile(g, this.device); apply(); });
    q.onChange?.(() => apply());
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    this.haptics.update();
    if (!this.active) return;
    this._patchDrive();
    const c = this.controls;
    const ctx = this._context();
    c.setContext(ctx);
    this._condT -= dt;
    if (this._condT <= 0) { this._condT = 0.2; this._conditions(ctx); this._raceLayout(); }
    this._sync();
    if (c.visible) c.update(dt);
  }

  _context() {
    const p = this.game.player;
    if (!p) return 'none';
    if (p.mode === 'free') return 'free';
    const v = p.mode === 'vehicle' ? p.controllable : null;
    if (v) { const k = v.kind; return k === 'heli' ? 'heli' : k === 'plane' ? 'plane' : k === 'boat' ? 'boat' : k === 'tank' ? 'tank' : 'drive'; }
    return 'foot';
  }

  _conditions(ctx) {
    const g = this.game, p = g.player, c = this.controls;
    let near = false, swim = false, flip = false, reload = false;
    const noExit = typeof p?.requestEnter !== 'function'; // BasicPlayer: no on-foot mode, exit is a no-op
    if (ctx === 'foot' && p) {
      swim = !!p.swim;
      if (p.state === 'enter') near = true; // the same button cancels the walk to the door
      else if (p.state === 'foot' && g.vehicles?.nearestEnterable && p.focus) {
        _pos.x = p.focus.x; _pos.y = p.focus.y + 0.8; _pos.z = p.focus.z;
        near = !!g.vehicles.nearestEnterable(_pos, 5);
      }
    } else if (ctx === 'drive') {
      const tel = p?.controllable?.telemetry;
      flip = !!tel?.upsideDown && Math.abs(tel.speedKmh ?? 0) < 15;
    } else if (ctx === 'tank') {
      reload = (p?.controllable?.reloadLeft ?? 0) > 0; // FIRE dims while the gun reloads
    }
    c.setFlag('near', near);
    c.setFlag('swim', swim);
    c.setFlag('flip', flip);
    c.setFlag('noexit', noExit);
    c.setFlag('reload', reload);
    c.setFlag('photo', !!g.life?.photo && (typeof g.can !== 'function' || g.can('photo')));
    c.setFlag('freecam', typeof p?.setFree === 'function' && (typeof g.can !== 'function' || g.can('freeCam')));
    c.setFlag('tilt', !!(g.settings?.tiltSteer && this.tilt.live));
  }

  // Time-trial START button + prompt (src/life/hud.js, top centre on touch, see mobile.css): stacked under whatever
  // the top-centre HUD column shows (mode tag, radio name, online pill, delivery job card), and narrowed so the prompt
  // clears the buttons / radar / speedometer beside it. The big banners (welcome, new area) queue them (CSS :has).
  _raceLayout() {
    const lh = document.getElementById('life-hud');
    const tap = lh?.querySelector('.lf-tap'), pr = lh?.querySelector('.lf-prompt');
    if (!tap || !pr || !(tap.classList.contains('on') || pr.classList.contains('on'))) {
      if (this._raceTop !== undefined) { lh?.style.removeProperty('--tc-race-top'); lh?.style.removeProperty('--tc-race-w'); this._raceTop = undefined; }
      return;
    }
    const W = window.innerWidth, cx = W / 2;
    const vis = (el) => {
      if (!el || !el.isConnected) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? r : null;
    };
    let top = 62 + (this.controls?.safe.t || 0);
    for (const el of document.querySelectorAll('#hud-tc > :not(.slot), #hud-tc .slot > *, #hud-tc .slot > * > *')) {
      const r = vis(el);
      if (r && r.left < cx + 120 && r.right > cx - 120) top = Math.max(top, r.bottom + 6);
    }
    // widest prompt that clears side obstacles in its band (est. two lines)
    const y0 = top + 56, y1 = y0 + 64;
    let half = 215;
    const obst = [...document.querySelectorAll('#touch-ui .tc-btn, #radar-wrap, #hud-br, #menu-btn')];
    for (const el of obst) {
      const r = vis(el);
      if (!r || r.bottom < y0 || r.top > y1) continue;
      half = Math.min(half, r.left > cx ? r.left - cx - 8 : r.right < cx ? cx - r.right - 8 : 215);
    }
    half = Math.max(110, half);
    if (top !== this._raceTop || half !== this._raceHalf) {
      this._raceTop = top; this._raceHalf = half;
      lh.style.setProperty('--tc-race-top', `${Math.round(top)}px`);
      lh.style.setProperty('--tc-race-w', `${Math.round(half * 2)}px`);
    }
  }

  _sync() {
    const c = this.controls;
    if (!c) return;
    const p = this.game.player;
    const wasted = (p?.wastedT ?? 0) > 0;
    const was = c.visible;
    c.setVisible(this._userVisible && !this._menuOpen && !this._photoOn && !this._kbHidden && !this._padHidden && !wasted && !this._pause.size);
    this.pad.enabled = c.visible;
    if (was !== c.visible) this.game.events.emit('mobile:controls', { visible: c.visible });
  }

  // DriveInput (src/vehicle/Input.js) polls navigator.getGamepads() itself; let it fall back to the virtual pad
  // when no physical pad is connected (instance patch, no edit of A's file — see INTEGRATION.md).
  _patchDrive() {
    const di = this.game.player?.driveInput;
    if (!di || di === this._di) return;
    this._di = di;
    if (di.__mobilePad || typeof di._pad !== 'function') return;
    const orig = di._pad;
    const pad = this.pad;
    di._pad = function mobilePad() { return orig.call(this) || pad.current; };
    di.__mobilePad = true;
  }

  dispose() {
    for (const f of this._off) f?.();
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('pointerdown', this._onTouch, true);
    window.removeEventListener('gamepadconnected', this._onPad);
    window.removeEventListener('gamepaddisconnected', this._onPad);
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    if (this._tiltOnce) for (const t of ['touchend', 'click']) window.removeEventListener(t, this._tiltOnce, true);
    clearTimeout(this._tiltCheck);
    this.tilt.disable();
    this.haptics.dispose();
    this.photo.dispose();
    this.controls?.dispose();
    this.viewport?.dispose();
    if (this.game.input?.virtualPad === this.pad) this.game.input.virtualPad = null;
    document.body.classList.remove('is-mobile');
    if (this.game.mobile === this) this.game.mobile = null;
  }
}

const _pos = { x: 0, y: 0, z: 0 };

function hasPhysicalPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  if (pads) for (const p of pads) if (p && p.connected) return true;
  return false;
}

/** Module factory for createGame({ modules: [createMobile] }). Returns the existing instance if already created. */
export function createMobile(game, opts) {
  return game.mobile instanceof MobileModule ? game.mobile : new MobileModule(game, opts);
}

export default createMobile;
