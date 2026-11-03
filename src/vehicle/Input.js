// Keyboard + Gamepad driving input with smoothed keyboard ramps.
// Output pedals are raw: the vehicle itself turns "brake at standstill" into reverse (GTA style).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, t, s) => (v < t ? Math.min(v + s, t) : Math.max(v - s, t));

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
};

// key ramp for the cars' yaw-rate steering (state.steerKb), 1/s: up to `light` quickly, then slower; `back` = release
export const KB_RAMP = { up: 6, light: 0.35, upHeavy: 2.6, back: 9 };

export class DriveInput {
  /**
   * @param {{target?: EventTarget, deadzone?: number, keys?: object}} opts
   */
  constructor(opts = {}) {
    this.target = opts.target || (typeof window !== 'undefined' ? window : null);
    this.deadzone = opts.deadzone ?? 0.12;
    this.keys = { ...KEYS, ...(opts.keys || {}) };
    this.down = new Set();
    this.enabled = true;
    this.state = { throttle: 0, brake: 0, steer: 0, steerKb: 0, digital: false, handbrake: false, boost: false };
    this._kbSteer = 0;
    this._kbSteerY = 0;
    this._kbThrottle = 0;
    this._kbBrake = 0;
    this.lastDevice = 'keyboard';
    this.gamepadIndex = null;
    this._onDown = (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      if (Object.values(this.keys).some((list) => list.includes(e.code))) {
        this.lastDevice = 'keyboard';
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      }
    };
    this._onUp = (e) => this.down.delete(e.code);
    this._onBlur = () => this.down.clear();
    if (this.target) {
      this.target.addEventListener('keydown', this._onDown);
      this.target.addEventListener('keyup', this._onUp);
      this.target.addEventListener('blur', this._onBlur);
    }
  }

  _key(name) {
    for (const c of this.keys[name]) if (this.down.has(c)) return true;
    return false;
  }

  _pad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex !== null && pads[this.gamepadIndex]?.connected) return pads[this.gamepadIndex];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return (this.gamepadIndex = p.index), p;
    for (const p of pads) if (p && p.connected) return (this.gamepadIndex = p.index), p;
    return null;
  }

  /**
   * @param {number} dt frame delta (s)
   * @param {number} speedKmh current vehicle speed (for speed-sensitive keyboard steering)
   * @returns {{throttle:number, brake:number, steer:number, handbrake:boolean, boost:boolean}}
   */
  update(dt, speedKmh = 0) {
    const s = this.state;
    if (!this.enabled) {
      s.throttle = s.brake = s.steer = s.steerKb = 0;
      s.digital = false;
      s.handbrake = s.boost = false;
      return s;
    }
    const v = Math.abs(speedKmh);
    // keyboard: ramps (fast press, faster release, less lock at speed)
    const kl = this._key('left'), kr = this._key('right');
    const kTarget = (kr ? 1 : 0) - (kl ? 1 : 0);
    const maxKb = 1 - 0.32 * clamp((v - 40) / 160, 0, 1);
    const target = kTarget * maxKb;
    const rising = Math.abs(target) > Math.abs(this._kbSteer) && Math.sign(target) === Math.sign(this._kbSteer || target);
    const rate = target === 0 ? 6.5 : rising ? 3.2 - 1.5 * clamp(v / 180, 0, 1) : 8;
    this._kbSteer = approach(this._kbSteer, target, rate * dt);
    // untrimmed key ramp for cars' yaw-rate steering (VehiclePhysics): quick to a light turn, slower into full lock,
    // fast back to centre
    const ks = this._kbSteerY || 0;
    const outward = kTarget !== 0 && (Math.sign(kTarget) === Math.sign(ks) || ks === 0);
    const yRate = !outward ? KB_RAMP.back : Math.abs(ks) < KB_RAMP.light ? KB_RAMP.up : KB_RAMP.upHeavy;
    this._kbSteerY = approach(ks, kTarget, yRate * dt);
    this._kbThrottle = approach(this._kbThrottle, this._key('throttle') ? 1 : 0, (this._key('throttle') ? 4 : 8) * dt);
    this._kbBrake = approach(this._kbBrake, this._key('brake') ? 1 : 0, (this._key('brake') ? 6 : 10) * dt);

    let steer = this._kbSteer, throttle = this._kbThrottle, brake = this._kbBrake;
    let steerKb = this._kbSteerY, digital = kTarget !== 0 || this._kbSteerY !== 0 || this.lastDevice === 'keyboard';
    let handbrake = this._key('handbrake');
    let boost = this._key('boost');

    const pad = this._pad();
    if (pad) {
      const ax = pad.axes[0] || 0;
      const dz = this.deadzone;
      const mag = Math.abs(ax);
      let st = mag < dz ? 0 : (Math.sign(ax) * (mag - dz)) / (1 - dz);
      st = Math.sign(st) * Math.pow(Math.abs(st), 1.6); // response curve
      st *= 1 - 0.2 * clamp((v - 60) / 160, 0, 1);
      const b = pad.buttons;
      const rt = b[7] ? b[7].value : 0;
      const lt = b[6] ? b[6].value : 0;
      const hb = (b[0] && b[0].pressed) || (b[2] && b[2].pressed);
      const bo = (b[1] && b[1].pressed) || (b[5] && b[5].pressed);
      const padActive = Math.abs(st) > 0 || rt > 0.05 || lt > 0.05 || hb || bo;
      if (padActive) this.lastDevice = 'gamepad';
      if (Math.abs(st) > Math.abs(steer)) { steer = st; steerKb = st; digital = false; }
      throttle = Math.max(throttle, rt > 0.04 ? rt : 0);
      brake = Math.max(brake, lt > 0.04 ? lt : 0);
      handbrake = handbrake || hb;
      boost = boost || bo;
    }
    s.steer = clamp(steer, -1, 1);
    s.steerKb = clamp(steerKb, -1, 1);
    s.digital = digital;
    s.throttle = clamp(throttle, 0, 1);
    s.brake = clamp(brake, 0, 1);
    s.handbrake = handbrake;
    s.boost = boost;
    return s;
  }

  /** Right stick (for camera orbit), [-1..1] with deadzone. */
  rightStick() {
    const pad = this._pad();
    if (!pad) return { x: 0, y: 0 };
    const f = (a) => (Math.abs(a) < this.deadzone ? 0 : a);
    return { x: f(pad.axes[2] || 0), y: f(pad.axes[3] || 0) };
  }

  dispose() {
    if (!this.target) return;
    this.target.removeEventListener('keydown', this._onDown);
    this.target.removeEventListener('keyup', this._onUp);
    this.target.removeEventListener('blur', this._onBlur);
  }
}
