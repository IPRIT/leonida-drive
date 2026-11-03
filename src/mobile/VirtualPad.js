// Virtual "standard mapping" gamepad driven by the touch controls.
// game.input.virtualPad = pad → InputManager polls it once per frame (only when no physical pad is connected).
// poll() is allocation-free: it updates and returns one persistent Gamepad-like object, or null when idle.

export const GP = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };
const N = 17;

export class VirtualPad {
  constructor() {
    this.axes = [0, 0, 0, 0];
    this.buttons = [];
    for (let i = 0; i < N; i++) this.buttons.push({ pressed: false, touched: false, value: 0 });
    // Gamepad-like snapshot (same object every frame)
    this.state = { id: 'Leonida touch controls', index: -1, connected: true, mapping: 'standard', timestamp: 0, axes: this.axes, buttons: this.buttons };
    this.target = new Float32Array(N); // value requested by the controls (0..1)
    this.rise = new Float32Array(N); // ramp-up speed (1/s), 0 = instant
    this.latch = new Uint8Array(N); // taps shorter than a frame still read as pressed for one poll
    this.ax = new Float32Array(4);
    this.enabled = true;
    this.current = null; // last poll() result (DriveInput reads it between polls)
    this._last = 0;
  }

  /** Hold button i at `value` (analog for LT/RT). rise: ramp-up rate per second (0 = instant). */
  press(i, value = 1, rise = 0) {
    if (this.target[i] === 0) this.latch[i] = 1;
    this.target[i] = value;
    this.rise[i] = rise;
  }

  release(i) { this.target[i] = 0; }

  /** One-frame press (enter/exit, jump, menu…). */
  tap(i) { this.latch[i] = 1; }

  setAxis(i, v) { this.ax[i] = v; }

  reset() {
    this.target.fill(0);
    this.latch.fill(0);
    this.ax.fill(0);
    for (let i = 0; i < N; i++) { const b = this.buttons[i]; b.pressed = b.touched = false; b.value = 0; }
    for (let i = 0; i < 4; i++) this.axes[i] = 0;
  }

  poll() {
    if (!this.enabled) { this.current = null; return null; }
    const now = performance.now();
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 1 / 60;
    this._last = now;
    let active = false;
    const btn = this.buttons, tgt = this.target, rise = this.rise, latch = this.latch;
    for (let i = 0; i < N; i++) {
      const b = btn[i];
      const t = tgt[i];
      let v = b.value;
      if (t <= v || rise[i] <= 0) v = t; // instant release / instant press
      else v = Math.min(t, v + rise[i] * dt);
      const l = latch[i];
      latch[i] = 0;
      if (l && v <= 0.04) { b.pressed = true; b.value = t > 0 ? 0.05 : 1; } // tap released before this poll
      else { b.pressed = v > 0.04; b.value = v; }
      b.touched = b.pressed;
      if (b.pressed || v > 0) active = true;
    }
    const ax = this.ax, axes = this.axes;
    for (let i = 0; i < 4; i++) { axes[i] = ax[i]; if (ax[i] !== 0) active = true; }
    this.state.timestamp = now;
    this.current = active ? this.state : null;
    return this.current;
  }
}
