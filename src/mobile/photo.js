// Photo mode (src/life/PhotoMode.js, P on a keyboard) on touch screens: the game is paused and the touch controls are
// hidden while it is open, so this adds what a mouse/keyboard would give:
//   one finger drag  → orbit (same signs as PhotoMode's left-button drag)
//   two fingers      → pinch to zoom (orbit distance) + drag the midpoint to move the target (like its right button)
//   buttons          → shutter, show/hide the settings panel, exit
// The panel itself (sliders, filters, Capture / Reset / Exit) stays PhotoMode's; mobile.css only compacts it.
// PhotoMode clamps yaw/pitch/dist/target every frame, so this only nudges its public fields.
import { icon } from './icons.js';
import { clamp } from './math.js';

const K_ORBIT = 0.0055; // rad per CSS px (same feel as the touch camera)

export class PhotoTouch {
  /** @param {object} game @param {object} mobile MobileModule (tr, haptic) */
  constructor(game, mobile) {
    this.game = game;
    this.m = mobile;
    this.on = false;
    this.el = null;
    this.pts = new Map(); // pointerId → { x, y }
    this.span = 0;
    this.mx = 0;
    this.my = 0;
    this._down = (e) => this.onDown(e);
    this._move = (e) => this.onMove(e);
    this._up = (e) => this.onUp(e);
  }

  get photo() { return this.game.life?.photo || null; }

  _build() {
    const el = document.createElement('div');
    el.className = 'tc-photo';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="tc-btn b-pexit" data-p="exit" style="--acc:#ff3fa4">${icon('close')}</div>
      <div class="tc-btn b-ppanel" data-p="panel" style="--acc:#29f0e0">${icon('sliders')}</div>
      <div class="tc-btn b-pshot" data-p="shot" style="--acc:#ffffff">${icon('photo')}</div>
      <div class="tc-photo-hint"></div>`;
    el.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      b.classList.add('on');
      this.m.haptic(12);
      const ph = this.photo;
      if (!ph?.active) return;
      const a = b.dataset.p;
      if (a === 'shot') ph.capture();
      else if (a === 'exit') ph.exit();
      else if (a === 'panel') ph.root?.classList.toggle('hide');
    });
    const off = (e) => e.target.closest?.('[data-p]')?.classList.remove('on');
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off, true);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(el);
    this.el = el;
    this.texts();
  }

  texts() {
    if (!this.el) return;
    this.el.querySelector('.tc-photo-hint').textContent = this.m.tr('mobile.photoHint', 'Drag to orbit · pinch to zoom · two fingers to move');
  }

  setActive(on) {
    on = !!on;
    if (on === this.on) return;
    this.on = on;
    if (on && !this.el) this._build();
    this.el?.classList.toggle('on', on);
    this.pts.clear();
    if (on) {
      window.addEventListener('pointerdown', this._down, { capture: true, passive: false });
      window.addEventListener('pointermove', this._move, { capture: true, passive: true });
      window.addEventListener('pointerup', this._up, true);
      window.addEventListener('pointercancel', this._up, true);
    } else {
      window.removeEventListener('pointerdown', this._down, { capture: true });
      window.removeEventListener('pointermove', this._move, { capture: true });
      window.removeEventListener('pointerup', this._up, true);
      window.removeEventListener('pointercancel', this._up, true);
    }
  }

  // gestures only on the picture: not on PhotoMode's panel (sliders scroll / drag) or on our buttons
  _free(e) {
    if (e.pointerType !== 'touch') return false; // mouse/pen: PhotoMode's own mouse handling
    const t = e.target;
    return !(t?.closest?.('.ph-panel, .tc-photo [data-p], button, input, select, a'));
  }

  _centroid() {
    let x = 0, y = 0, n = 0;
    for (const p of this.pts.values()) { x += p.x; y += p.y; n++; }
    this.mx = n ? x / n : 0;
    this.my = n ? y / n : 0;
    if (n >= 2) {
      const it = this.pts.values();
      const a = it.next().value, b = it.next().value;
      this.span = Math.hypot(a.x - b.x, a.y - b.y);
    } else this.span = 0;
  }

  onDown(e) {
    if (!this.photo?.active || !this._free(e)) return;
    e.preventDefault(); // no compatibility mouse events (PhotoMode would orbit a second time on Mouse0)
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._centroid();
  }

  onMove(e) {
    const p = this.pts.get(e.pointerId);
    const ph = this.photo;
    if (!p || !ph?.active) return;
    p.x = e.clientX; p.y = e.clientY;
    const px = this.mx, py = this.my, ps = this.span;
    this._centroid();
    const dx = this.mx - px, dy = this.my - py;
    const k = K_ORBIT * (this.game.settings?.touchLookSens ?? 1);
    if (this.pts.size === 1) {
      ph.yaw -= dx * k;
      ph.pitch = clamp(ph.pitch + dy * k, -1.35, 1.45);
      return;
    }
    if (ps > 20 && this.span > 20) ph.dist = clamp(ph.dist * (ps / this.span), 1.2, 120);
    // two-finger drag moves the orbit target on the ground plane (PhotoMode's right-button path)
    const s = 0.02 * Math.max(1, ph.dist / 10);
    const mx = -dx * s, mz = dy * s;
    const cy = Math.cos(ph.yaw), sy = Math.sin(ph.yaw);
    ph.target.x += cy * mx - sy * mz;
    ph.target.z += -sy * mx - cy * mz;
  }

  onUp(e) {
    if (!this.pts.delete(e.pointerId)) return;
    this._centroid();
  }

  dispose() {
    this.setActive(false);
    this.el?.remove();
    this.el = null;
  }
}
