// Orientation, fullscreen and viewport handling for phones/tablets.
// - Landscape is the play orientation: in portrait a "rotate your phone" screen covers the game, which is paused
//   (and rendered at 15 fps) behind it. The pause menu stays usable in portrait.
// - First tap: fullscreen (with webkit fallback) + screen.orientation.lock('landscape') where supported.
// - iOS Safari (no element fullscreen on iPhone): no rubber-band, no pinch / double-tap zoom, viewport-fit=cover.
// - Debounced renderer resize after rotation / visualViewport changes (sizes settle late on iOS).
// - Pause on visibilitychange (hidden) and window blur; resume on return.
import { PHONE_SVG, icon } from './icons.js';

export class Viewport {
  /**
   * @param {object} game
   * @param {object} mobile MobileModule (setPauseReason, tr, emit, device, controls)
   */
  constructor(game, mobile) {
    this.game = game;
    this.m = mobile;
    this.portrait = false;
    this.fullscreen = false;
    this._armed = false;
    this._resizeT = 0;
    this._lastW = 0;
    this._lastH = 0;
    this.metaPatched = [];
  }

  install(container) {
    const dev = this.m.device;
    this.container = container;
    this._checkMeta();
    // rotate overlay (inside the game container: above HUD + touch controls, below the pause menu z 30)
    const el = document.createElement('div');
    el.id = 'tc-rotate';
    el.className = 'tc-rotate';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<div class="tc-rotate-box">${PHONE_SVG}
      <div class="tc-rotate-t"></div><div class="tc-rotate-s"></div>
      <div class="tc-rotate-tip"></div>
      <button type="button" class="tc-rotate-menu">${icon('menu')}<span></span></button></div>`;
    container.appendChild(el);
    this.rotateEl = el;
    el.querySelector('.tc-rotate-menu').addEventListener('click', () => this.game.ui?.open?.());
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    this.texts();

    const onResize = () => this.schedule();
    this._onResize = onResize;
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    screen.orientation?.addEventListener?.('change', onResize);
    this._mq = matchMedia('(orientation: portrait)');
    this._mq.addEventListener?.('change', onResize);

    // visibility / focus → pause (and release every touch: iOS drops pointerup when the app is switched away)
    this._onVis = () => {
      const hidden = document.visibilityState === 'hidden';
      this.m.setPauseReason('hidden', hidden);
      if (hidden) this.m.controls?.releaseAll();
    };
    this._onBlur = () => { this.m.setPauseReason('blur', true); this.m.controls?.releaseAll(); };
    this._onFocus = () => this.m.setPauseReason('blur', false);
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('focus', this._onFocus);
    window.addEventListener('pagehide', this._onBlur);
    window.addEventListener('pageshow', this._onFocus);

    // Safari pinch-zoom gestures and double-tap zoom
    this._noGesture = (e) => e.preventDefault();
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, this._noGesture, { passive: false });
    this._onFs = () => {
      this.fullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!this.fullscreen) this.arm(); // left fullscreen (back gesture): ask again on the next tap
      this.schedule();
    };
    document.addEventListener('fullscreenchange', this._onFs);
    document.addEventListener('webkitfullscreenchange', this._onFs);
    if (dev.fullscreenApi || dev.orientationLock) this.arm();
    this.update(true);
  }

  texts() {
    const el = this.rotateEl;
    if (!el) return;
    const tr = this.m.tr;
    el.querySelector('.tc-rotate-t').textContent = tr('mobile.rotate', 'Rotate your phone');
    el.querySelector('.tc-rotate-s').textContent = tr('mobile.rotateSub', 'Leonida Drive is played in landscape');
    const d = this.m.device;
    el.querySelector('.tc-rotate-tip').textContent = d.ios && !d.standalone && !d.iPadOS ? tr('mobile.iosTip', 'Tip: Share → Add to Home Screen for full screen') : '';
    el.querySelector('.tc-rotate-menu span').textContent = tr('mobile.menu', 'Menu');
  }

  // one-shot capture listener: the first tap after start (or after leaving fullscreen) goes fullscreen + locks
  arm() {
    if (this._armed || !(this.m.device.fullscreenApi || this.m.device.orientationLock)) return;
    this._armed = true;
    const go = (e) => {
      if (e.pointerType === 'mouse') return;
      window.removeEventListener('pointerup', go, true);
      this._armed = false;
      this.enterFullscreen();
    };
    // pointerup (not down): Chrome counts it as an activation and the touch that started a drive isn't eaten
    window.addEventListener('pointerup', go, true);
  }

  enterFullscreen() {
    const doc = document.documentElement;
    const req = doc.requestFullscreen || doc.webkitRequestFullscreen;
    const lock = () => {
      if (this.isTablet()) return; // tablets play in either orientation
      try { const p = screen.orientation?.lock?.('landscape'); p?.catch?.(() => {}); } catch { /* not supported */ }
    };
    if (!req || document.fullscreenElement || document.webkitFullscreenElement) { lock(); return; }
    try {
      const p = req.call(doc, { navigationUI: 'hide' });
      if (p?.then) p.then(lock, () => {}); else lock();
    } catch { /* refused: stay windowed */ }
  }

  // Tablets (iPad-like, or a short screen side ≥ 600 CSS px) are playable in portrait: no rotate screen, no lock.
  isTablet() {
    const d = this.m.device;
    if (d.tablet || d.iPadOS) return true;
    const w = screen.width || window.innerWidth, h = screen.height || window.innerHeight;
    return Math.min(w, h) >= 600;
  }

  isPortrait() {
    const vv = window.visualViewport;
    const w = vv?.width || window.innerWidth, h = vv?.height || window.innerHeight;
    if (Math.abs(w - h) < 40) return this.portrait; // square-ish (split screen, keyboard): keep the last state
    return h > w;
  }

  // debounced: resize events arrive in bursts and iOS reports the final size ~300 ms after the rotation
  schedule() {
    clearTimeout(this._resizeT);
    this.update(false);
    this._resizeT = setTimeout(() => this.update(true), 180);
  }

  update(settle) {
    const portrait = this.m.device.mobile && this.isPortrait();
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      this.m.onOrientation(portrait ? 'portrait' : 'landscape');
    }
    this.rotate = portrait && !this.isTablet();
    this.syncRotate();
    if (!settle) return;
    // renderer: only when the CSS size really differs from the window (Renderer also listens to resize)
    const w = window.innerWidth, h = window.innerHeight;
    const canvas = this.game.renderer?.domElement;
    if (canvas && (w !== this._lastW || h !== this._lastH)) {
      this._lastW = w; this._lastH = h;
      if (canvas.clientWidth !== w || canvas.clientHeight !== h) this.game.render?.resize?.();
    }
    this.m.controls?.relayout();
  }

  syncRotate() {
    const show = !!this.rotate && !this.game.ui?.isOpen;
    this.rotateEl?.classList.toggle('show', show);
    this.m.setPauseReason('portrait', show);
  }

  // viewport meta: needs viewport-fit=cover (safe-area insets) and no user scaling. Patched at runtime and reported;
  // index.html should carry it (see INTEGRATION.md).
  _checkMeta() {
    let meta = document.querySelector('meta[name=viewport]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
    const want = { width: 'device-width', 'initial-scale': '1', 'maximum-scale': '1', 'user-scalable': 'no', 'viewport-fit': 'cover', 'interactive-widget': 'resizes-visual' };
    const cur = {};
    for (const part of (meta.content || '').split(',')) { const [k, v] = part.split('=').map((s) => s?.trim()); if (k) cur[k] = v ?? ''; }
    for (const [k, v] of Object.entries(want)) if (cur[k] !== v) { this.metaPatched.push(`${k}=${v}`); cur[k] = v; }
    if (!this.metaPatched.length) return;
    meta.content = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join(', ');
    console.info(`[mobile] viewport meta patched at runtime (${this.metaPatched.join(', ')}); add it to index.html`);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    window.visualViewport?.removeEventListener('resize', this._onResize);
    screen.orientation?.removeEventListener?.('change', this._onResize);
    this._mq?.removeEventListener?.('change', this._onResize);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('focus', this._onFocus);
    window.removeEventListener('pagehide', this._onBlur);
    window.removeEventListener('pageshow', this._onFocus);
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.removeEventListener(t, this._noGesture);
    document.removeEventListener('fullscreenchange', this._onFs);
    document.removeEventListener('webkitfullscreenchange', this._onFs);
    this.rotateEl?.remove();
  }
}
