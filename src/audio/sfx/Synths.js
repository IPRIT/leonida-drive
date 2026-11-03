// Live (oscillator-based) sound sources: horns, sirens, reverse beeper, tinnitus.
import { disconnectAll } from '../core/util.js';

function shaper(ctx, k) {
  const ws = ctx.createWaveShaper();
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  ws.curve = c;
  ws.oversample = '2x';
  return ws;
}

export const HORNS = {
  car: { f: [415, 523], type: 'sawtooth', bp: [1900, 1.1], lp: 4500, drive: 1.6, gain: 0.32 },
  sport: { f: [480, 605], type: 'sawtooth', bp: [2200, 1.2], lp: 5200, drive: 1.8, gain: 0.3 },
  luxury: { f: [349, 440, 523], type: 'sawtooth', bp: [1500, 0.9], lp: 4000, drive: 1.3, gain: 0.3 },
  truck: { f: [147, 185, 220], type: 'sawtooth', bp: [720, 0.8], lp: 2600, drive: 2.4, gain: 0.5, bend: 0.06, release: 0.18 },
  bus: { f: [262, 330], type: 'sawtooth', bp: [1100, 0.9], lp: 3200, drive: 1.8, gain: 0.4 },
  moped: { f: [540], type: 'square', bp: [1500, 2], lp: 3500, drive: 1.2, gain: 0.22 },
  motorcycle: { f: [470, 560], type: 'square', bp: [1700, 1.6], lp: 4000, drive: 1.4, gain: 0.25 },
  boat: { f: [104, 156], type: 'sawtooth', bp: [480, 0.7], lp: 1400, drive: 2, gain: 0.6, bend: 0.03, release: 0.4 },
  police: { f: [360, 452], type: 'sawtooth', bp: [1300, 1], lp: 3800, drive: 2.2, gain: 0.35 },
};

export function hornTypeFor(v) {
  const kind = v?.kind || v?.type?.name || 'car';
  if (v?.hornType && HORNS[v.hornType]) return v.hornType;
  if (kind === 'truck' || kind === 'pickup_truck') return 'truck';
  if (kind === 'bus') return 'bus';
  if (kind === 'moped' || kind === 'scooter') return 'moped';
  if (kind === 'motorcycle' || kind === 'bike') return 'motorcycle';
  if (kind === 'boat') return 'boat';
  if (kind === 'bicycle') return 'bicycle';
  const p = v?.preset || v?.catalogId || kind;
  if (p === 'cruiser') return 'police';
  if (p === 'super' || p === 'comet') return 'sport';
  if (p === 'pickup' || p === 'suv') return 'luxury';
  return 'car';
}

export class Horn {
  constructor(sys, type, dest) {
    const ctx = (this.ctx = sys.ctx);
    const h = (this.h = HORNS[type] || HORNS.car);
    const t = ctx.currentTime;
    this.oscs = h.f.map((f, i) => {
      const o = ctx.createOscillator();
      o.type = h.type;
      o.frequency.value = f * (1 + (i % 2 ? 0.004 : -0.003));
      if (h.bend) { o.frequency.setValueAtTime(f * (1 - h.bend), t); o.frequency.setTargetAtTime(f, t, 0.05); }
      o.start(t);
      return o;
    });
    this.mix = ctx.createGain();
    this.mix.gain.value = 1 / h.f.length;
    for (const o of this.oscs) o.connect(this.mix);
    this.ws = shaper(ctx, h.drive);
    this.bp = ctx.createBiquadFilter(); this.bp.type = 'peaking'; this.bp.frequency.value = h.bp[0]; this.bp.Q.value = h.bp[1]; this.bp.gain.value = 9;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = h.lp;
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.env.gain.setTargetAtTime(h.gain, t, 0.012);
    this.mix.connect(this.ws).connect(this.bp).connect(this.lp).connect(this.env).connect(dest);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime, rel = this.h.release || 0.06;
    this.env.gain.cancelScheduledValues(t);
    this.env.gain.setTargetAtTime(0, t, rel / 3);
    if (this.h.bend) for (const o of this.oscs) o.frequency.setTargetAtTime(o.frequency.value * (1 - this.h.bend * 0.5), t, rel);
    for (const o of this.oscs) o.stop(t + rel * 2 + 0.05);
    this.oscs[0].onended = () => disconnectAll(...this.oscs, this.mix, this.ws, this.bp, this.lp, this.env);
  }
}

// Emergency siren: square oscillator swept by an LFO (all on the audio thread), horn-speaker distortion.
export const SIREN_MODES = {
  wail: { center: 1050, depth: 420, rate: 0.23, lfo: 'triangle' },
  yelp: { center: 1050, depth: 380, rate: 3.2, lfo: 'sawtooth' },
  hilo: { center: 760, depth: 140, rate: 0.95, lfo: 'square' },
  phaser: { center: 1200, depth: 450, rate: 11, lfo: 'sawtooth' },
};

export class Siren {
  constructor(sys, dest, mode = 'wail') {
    const ctx = (this.ctx = sys.ctx);
    this.osc = ctx.createOscillator();
    this.osc.type = 'square';
    this.lfo = ctx.createOscillator();
    this.depth = ctx.createGain();
    this.lfo.connect(this.depth).connect(this.osc.frequency);
    this.ws = shaper(ctx, 2.5);
    this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.frequency.value = 1300; this.bp.Q.value = 0.6;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 5000;
    this.env = ctx.createGain();
    this.env.gain.value = 0;
    this.osc.connect(this.ws).connect(this.bp).connect(this.lp).connect(this.env).connect(dest);
    this.setMode(mode);
    this.osc.start();
    this.lfo.start();
    this.env.gain.setTargetAtTime(0.32, ctx.currentTime, 0.03);
  }

  setMode(m) {
    const s = SIREN_MODES[m] || SIREN_MODES.wail;
    if (this.mode === m) return;
    this.mode = m;
    const t = this.ctx.currentTime;
    this.lfo.type = s.lfo;
    this.lfo.frequency.setTargetAtTime(s.rate, t, 0.02);
    this.osc.frequency.setTargetAtTime(s.center, t, 0.05);
    this.depth.gain.setTargetAtTime(s.depth, t, 0.05);
  }

  stop(fade = 0.15) {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.env.gain.cancelScheduledValues(t);
    this.env.gain.setTargetAtTime(0, t, fade / 3);
    // siren wind-down: pitch sags as the speaker stops
    this.osc.frequency.setTargetAtTime(300, t, fade);
    this.osc.stop(t + fade * 2 + 0.05);
    this.lfo.stop(t + fade * 2 + 0.05);
    this.osc.onended = () => disconnectAll(this.osc, this.lfo, this.depth, this.ws, this.bp, this.lp, this.env);
  }
}

// reverse warning beeper (trucks/buses)
export class Beeper {
  constructor(sys, dest) {
    const ctx = (this.ctx = sys.ctx);
    this.osc = ctx.createOscillator();
    this.osc.type = 'square';
    this.osc.frequency.value = 1040;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'bandpass'; this.lp.frequency.value = 1100; this.lp.Q.value = 3;
    this.out = ctx.createGain();
    this.out.gain.value = 0.25;
    this.osc.connect(this.lp).connect(this.gate).connect(this.out).connect(dest);
    // 0.5 s on / 0.5 s off gate with soft edges, driven by a square LFO
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    this.lfo.frequency.value = 1;
    this.lfoG = ctx.createGain();
    this.lfoG.gain.value = 0.5;
    this.smooth = ctx.createBiquadFilter(); this.smooth.type = 'lowpass'; this.smooth.frequency.value = 60;
    this.lfo.connect(this.lfoG).connect(this.smooth).connect(this.gate.gain);
    this.dc = ctx.createConstantSource();
    this.dc.offset.value = 0.5;
    this.dc.connect(this.smooth);
    this.on = false;
    this.osc.start(); this.lfo.start(); this.dc.start();
    this.out.gain.value = 0;
  }
  set(on) {
    if (on === this.on) return;
    this.on = on;
    this.out.gain.setTargetAtTime(on ? 0.22 : 0, this.ctx.currentTime, 0.02);
  }
  dispose() {
    try { this.osc.stop(); this.lfo.stop(); this.dc.stop(); } catch { /* */ }
    disconnectAll(this.osc, this.lfo, this.lfoG, this.smooth, this.dc, this.lp, this.gate, this.out);
  }
}

// ear ringing after a close explosion
export function tinnitus(sys, strength = 1) {
  const ctx = sys.ctx, t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.frequency.value = 4100 + Math.random() * 600;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.05 * strength, t + 0.15);
  g.gain.setTargetAtTime(0, t + 0.6, 1.1);
  o.connect(g).connect(sys.mixer.bus.ui);
  o.start(t);
  o.stop(t + 5);
  o.onended = () => disconnectAll(o, g);
  // muffle the world meanwhile (temporary hearing loss)
  sys.mixer.duck(0.55 * strength, 0.01, 0.8, 3);
  const f = sys.mixer.worldFilter.frequency;
  f.cancelScheduledValues(t);
  f.setTargetAtTime(900, t, 0.02);
  f.setTargetAtTime(sys.mixer.lpTarget ?? 20000, t + 0.8, 1.2);
  f._lv = undefined;
}
