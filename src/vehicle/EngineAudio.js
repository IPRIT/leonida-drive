// Backwards-compatible standalone wrapper (used by vehicle-lab): drives the procedural audio system
// (src/audio) for a single car without a game context. In the game use game.audio (AudioSystem) instead.
import { AudioSystem } from '../audio/AudioSystem.js';
import { VEHICLE_PRESETS } from './presets.js';
import { Events } from '../core/events.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class EngineAudio {
  /** @param {{preset?: string, volume?: number}} [opts] */
  constructor(opts = {}) {
    this.started = false;
    this.volume = opts.volume ?? 0.6;
    this.muted = false;
    this.presetName = opts.preset || 'comet';
    this._siren = false;
    this.game = { events: new Events(), settings: { volume: this.volume, volMusic: 0, volAmbient: 0 }, onSetting() {} };
    this.sys = new AudioSystem(this.game);
    this.sys.overrides.wind = 0;
    this.sys.overrides.interior = 0;
    this.vehicle = this._makeVehicle(this.presetName);
  }

  _makeVehicle(name) {
    const p = VEHICLE_PRESETS[name] || VEHICLE_PRESETS.comet;
    return { kind: 'car', preset: name, spec: { audio: p.audio, engine: p.engine }, telemetry: { rpm: p.engine?.idle ?? 800 }, siren: this._siren, engineRunning: this.started };
  }

  /** Must be called from a user gesture (click/keydown). Safe to call repeatedly. */
  async start() {
    if (typeof window === 'undefined') return;
    this.sys.start();
    if (!this.started) this.sys.attachVehicle(this.vehicle);
    this.started = true;
    this.setMasterVolume(this.volume);
  }

  setPreset(name) {
    if (name === this.presetName) return;
    this.presetName = name;
    this.vehicle = this._makeVehicle(name);
    this.vehicle.engineRunning = true;
    if (this.started) this.sys.attachVehicle(this.vehicle);
  }

  setMasterVolume(v) {
    this.volume = clamp(v, 0, 1);
    this.sys.setVolume('master', this.muted ? 0 : this.volume);
  }

  setMuted(m) {
    this.muted = !!m;
    this.setMasterVolume(this.volume);
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setSiren(on) {
    this._siren = !!on;
    this.vehicle.siren = this._siren;
  }

  /** One-shot collision thump. strength 0..1 */
  impact(strength = 0.5) {
    const s = clamp(strength, 0.05, 1);
    this.sys.play(s > 0.6 ? 'crash' : 'metal', { volume: 0.3 + 0.7 * s, variant: s > 0.35 ? 2 : 0 });
  }

  /** @param {object} tel vehicle.telemetry  @param {number} dt frame delta */
  update(tel, dt) {
    if (!this.started || !tel) return;
    if (tel.preset && tel.preset !== this.presetName) this.setPreset(tel.preset);
    this.vehicle.telemetry = tel;
    this.sys.update(dt, this.game);
    this.sys.lateUpdate(dt, this.game);
  }

  dispose() {
    this.sys.dispose();
    this.started = false;
  }
}
