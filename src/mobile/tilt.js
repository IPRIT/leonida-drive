// Tilt steering from DeviceOrientation (gravity projected on the screen plane, see math.js tiltAngle).
// iOS 13+ needs DeviceOrientationEvent.requestPermission() from a user gesture: call enable() synchronously
// inside a click/pointer handler (the settings toggle does that through game.applySetting).
import { tiltAngle, clamp } from './math.js';

const D2R = Math.PI / 180;

export class TiltSteer {
  constructor() {
    this.available = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
    this.needsPermission = this.available && typeof window.DeviceOrientationEvent.requestPermission === 'function';
    this.enabled = false;
    this.listening = false;
    this.raw = 0; // radians, + = clockwise
    this.value = 0; // filtered steer -1..1
    this.flat = false;
    this.lastEvent = 0;
    this._angle = 0;
    this._onOrient = (e) => {
      if (e.beta == null || e.gamma == null) return;
      const a = tiltAngle(e.beta, e.gamma, this._angle);
      this.lastEvent = performance.now();
      if (Number.isNaN(a)) { this.flat = true; return; }
      this.flat = false;
      this.raw = a;
    };
    this._onRot = () => { this._angle = screenAngle(); };
  }

  /**
   * Must run inside a user gesture where a permission is needed (iOS 13+, some Chromium builds).
   * Resolves to 'granted' | 'denied' | 'unavailable' | 'needs-gesture' (call again from a tap).
   */
  enable() {
    if (!this.available) return Promise.resolve('unavailable');
    this.enabled = true;
    if (!this.needsPermission) { this._listen(); return Promise.resolve('granted'); }
    // without a transient activation the prompt is refused (or silently "denied"): wait for a tap instead
    if (navigator.userActivation && !navigator.userActivation.isActive) { this.enabled = false; return Promise.resolve('needs-gesture'); }
    let p;
    try { p = window.DeviceOrientationEvent.requestPermission(); } catch (e) { return Promise.resolve('denied'); }
    return Promise.resolve(p).then((r) => {
      if (r === 'granted') { this._listen(); return 'granted'; }
      this.enabled = false;
      return 'denied';
    }, () => { this.enabled = false; return 'needs-gesture'; });
  }

  disable() {
    this.enabled = false;
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('orientationchange', this._onRot);
    screen.orientation?.removeEventListener?.('change', this._onRot);
    this.value = this.raw = 0;
  }

  _listen() {
    if (this.listening) return;
    this.listening = true;
    this._angle = screenAngle();
    window.addEventListener('deviceorientation', this._onOrient);
    window.addEventListener('orientationchange', this._onRot);
    screen.orientation?.addEventListener?.('change', this._onRot);
  }

  /** True once events actually arrive (desktop browsers expose the API but never fire it). */
  get live() { return this.listening && performance.now() - this.lastEvent < 1000; }

  /**
   * Filtered steering in -1..1. sens 1: full lock at 26° of rotation; 3° deadzone; ~70 ms smoothing.
   * @param {number} dt
   * @param {number} sens
   */
  read(dt, sens = 1) {
    if (!this.enabled || !this.live) { this.value = 0; return 0; }
    const full = (26 / clamp(sens, 0.4, 2.5)) * D2R, dead = 3 * D2R;
    const a = this.flat ? 0 : this.raw;
    const m = Math.abs(a);
    const t = m <= dead ? 0 : Math.sign(a) * Math.min(1, (m - dead) / (full - dead));
    const k = 1 - Math.exp(-dt / 0.07);
    this.value += (t - this.value) * k;
    return this.value;
  }
}

export function screenAngle() {
  const a = screen.orientation?.angle;
  if (typeof a === 'number') return a;
  const w = window.orientation; // legacy iOS: 0, 90, -90, 180
  return typeof w === 'number' ? (w + 360) % 360 : 0;
}
