import { ramp, clamp } from './util.js';
import { rng } from './dsp.js';

// Reverb environments (procedural convolution IRs). wet = return level, rt = RT60 seconds.
export const ENVIRONMENTS = {
  open: { rt: 0.9, pre: 0.01, f0: 6500, f1: 1400, wet: 0.32, early: [[0.006, 0.45, 0], [0.085, 0.1, -0.6], [0.16, 0.07, 0.5], [0.26, 0.05, -0.2]] },
  urban: {
    rt: 1.7, pre: 0.006, f0: 7500, f1: 1900, wet: 0.75,
    early: [[0.012, 0.5, -0.8], [0.021, 0.42, 0.8], [0.034, 0.35, -0.7], [0.047, 0.3, 0.7], [0.063, 0.25, -0.6], [0.081, 0.2, 0.6], [0.102, 0.15, -0.4], [0.21, 0.16, 0.3], [0.34, 0.1, -0.3], [0.52, 0.06, 0.2]],
  },
  tunnel: { rt: 2.8, pre: 0.003, f0: 4200, f1: 700, wet: 1.1, early: Array.from({ length: 18 }, (_, i) => [0.004 + i * 0.0045, 0.55 * Math.exp(-i * 0.12), i % 2 ? 0.7 : -0.7]) },
  cabin: { rt: 0.16, pre: 0.002, f0: 5000, f1: 1600, wet: 0.35, early: [[0.0021, 0.5, -0.8], [0.0034, 0.45, 0.8], [0.0049, 0.35, -0.5], [0.0063, 0.3, 0.5], [0.0081, 0.2, 0]] },
  valley: { rt: 2.3, pre: 0.02, f0: 3800, f1: 800, wet: 0.5, early: [[0.01, 0.3, 0], [0.36, 0.22, -0.5], [0.63, 0.14, 0.5], [0.97, 0.08, -0.2], [1.4, 0.05, 0.3]] },
};

// IR seed per environment name (unchanged from the inline call sites)
export const irSeed = (name) => name.length * 13 + 5;

// IR samples as two Float32Arrays (pure, runs in ir.worker.js: 7-15 ms per environment, too slow for a frame)
export function makeIRData(sr, env, seed = 7) {
  const len = Math.round((env.rt * 1.15 + env.pre) * sr);
  const chans = [new Float32Array(len), new Float32Array(len)];
  const r = rng(seed);
  for (let c = 0; c < 2; c++) {
    const d = chans[c];
    let lp = 0;
    const pre = Math.round(env.pre * sr);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const fc = env.f0 * Math.pow(env.f1 / env.f0, Math.min(1, t / env.rt));
      const k = 1 - Math.exp(-2 * Math.PI * fc / sr);
      lp += k * ((r() * 2 - 1) - lp);
      const att = Math.min(1, t / 0.012);
      d[i] = lp * Math.exp(-6.9 * t / env.rt) * att * 0.5;
    }
    for (const [t, g, pan] of env.early) {
      const i = Math.round((t + env.pre) * sr);
      if (i >= len - 4) continue;
      const pg = c === 0 ? 1 - Math.max(0, pan) : 1 + Math.min(0, pan);
      d[i] += g * pg * 0.9;
      d[i + 1] -= g * pg * 0.3;
    }
  }
  // energy-normalise so environments differ by `wet`, not by IR loudness
  let e = 0;
  for (let c = 0; c < 2; c++) { const d = chans[c]; for (let i = 0; i < len; i++) e += d[i] * d[i]; }
  const g = 1 / Math.sqrt(e / 2 + 1e-9) * 0.6;
  for (let c = 0; c < 2; c++) { const d = chans[c]; for (let i = 0; i < len; i++) d[i] *= g; }
  return chans;
}

export function irBuffer(ctx, chans) {
  const buf = ctx.createBuffer(2, chans[0].length, ctx.sampleRate);
  buf.copyToChannel(chans[0], 0);
  buf.copyToChannel(chans[1], 1);
  return buf;
}

export function makeIR(ctx, env, seed = 7) {
  return irBuffer(ctx, makeIRData(ctx.sampleRate, env, seed));
}

// Bus graph:
//   sfx, engine, ambient ─┐
//   reverb return ────────┴─ world ─ worldFilter ─ worldDuck ─┐
//   music ─ musicDuck ────────────────────────────────────────┼─ master ─ glue comp ─ limiter ─ out
//   ui ───────────────────────────────────────────────────────┘
export class Mixer {
  constructor(ctx) {
    this.ctx = ctx;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.master = g(0);
    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -18; this.glue.knee.value = 10; this.glue.ratio.value = 2.5;
    this.glue.attack.value = 0.008; this.glue.release.value = 0.25;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.trim = g(0.95);
    this.master.connect(this.glue).connect(this.limiter).connect(this.trim).connect(ctx.destination);

    this.world = g(1);
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = 'lowpass'; this.worldFilter.frequency.value = 20000; this.worldFilter.Q.value = 0.6;
    this.worldDuck = g(1);
    this.world.connect(this.worldFilter).connect(this.worldDuck).connect(this.master);
    this.musicDuck = g(1);
    // side-chain stage: music sits under the engine and UI (see duckMusic / setMusicSide)
    this.musicSide = g(1);
    this.musicDuck.connect(this.musicSide).connect(this.master);

    this.bus = {
      sfx: g(1), engine: g(1), ambient: g(1), music: g(1), ui: g(1),
      // big events (explosions, collapses): same state chain as the world (pause / underwater / wasted),
      // but they bypass the transient world duck so they can push everything else down
      boom: g(1),
    };
    this.bus.sfx.connect(this.world);
    this.bus.boom.connect(this.worldFilter);
    // engine bus EQ: clean up inaudible sub (it only pumps the compressor), slight body around 180 Hz
    this.engineEq = [
      Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }),
      Object.assign(ctx.createBiquadFilter(), { type: 'lowshelf' }),
      Object.assign(ctx.createBiquadFilter(), { type: 'peaking' }),
    ];
    this.engineEq[0].frequency.value = 28; this.engineEq[0].Q.value = -3;
    this.engineEq[1].frequency.value = 60; this.engineEq[1].gain.value = 0;
    this.engineEq[2].frequency.value = 180; this.engineEq[2].Q.value = 0.9; this.engineEq[2].gain.value = 1.5;
    this.bus.engine.connect(this.engineEq[0]).connect(this.engineEq[1]).connect(this.engineEq[2]).connect(this.world);
    this.bus.ambient.connect(this.world);
    this.bus.music.connect(this.musicDuck);
    this.bus.ui.connect(this.master);
    // defaults; music is deliberately quiet ("barely audible") — the player turns it up
    this.volumes = { master: 0.8, sfx: 1, engine: 1, ambient: 0.45, music: 0.05, ui: 0.8 };
    this.bus.music.gain.value = this.volumes.music;

    // reverb send/return, crossfading between environments. One convolver per environment with its impulse response
    // set once: assigning a ConvolverNode's buffer builds its FFT partitions on the main thread (2-8 ms), which every
    // environment change used to pay (city <-> open road, tunnels, cabin). Only the audible convolvers are fed.
    this.reverbIn = g(1);
    this.reverbHp = ctx.createBiquadFilter();
    this.reverbHp.type = 'highpass'; this.reverbHp.frequency.value = 160;
    this.reverbIn.connect(this.reverbHp);
    this.reverbOut = g(1);
    this.reverbOut.connect(this.world);
    this.envConv = new Map(); // environment -> { conv, gain, on, timer }
    this.irCache = new Map();
    this._prepareIRs();
    this.env = null;
    this.duckState = { world: 1, music: 1 };
    this.state = { paused: 0, wasted: 0, underwater: 0, hidden: 0, menu: 0 };
    this.lpTarget = 20000;
  }

  // linear taper: a slider at 10 % is -20 dB. The master fades in gently the first time (no start-up burst).
  setVolume(bus, v) {
    v = clamp(+v || 0, 0, 1.5);
    this.volumes[bus] = v;
    const t = this.ctx.currentTime;
    if (bus === 'master') {
      ramp(this.master.gain, v, t, this.masterStarted ? 0.05 : 0.35);
      this.masterStarted = true;
    } else if (this.bus[bus]) {
      ramp(this.bus[bus].gain, v, t, bus === 'music' ? 0.3 : 0.05);
      if (bus === 'sfx') ramp(this.bus.boom.gain, v, t, 0.05);
    }
  }

  // music under the engine: level 0..1 (1 = no duck)
  setMusicSide(level) { ramp(this.musicSide.gain, clamp(level, 0.2, 1), this.ctx.currentTime, 0.35, 0.01); }

  // brief music dip under UI / notifications
  duckMusic(amount = 0.45, hold = 0.35, release = 0.5) {
    const t = this.ctx.currentTime, p = this.musicDuck.gain;
    const base = p._lv ?? 1;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(base * (1 - amount), t, 0.02);
    p.setTargetAtTime(base, t + hold, release / 3);
  }

  // every environment's impulse response is synthesised in a worker right away (the first tunnel / city / valley used
  // to cost 7-15 ms, 20+ cold, in the frame the player entered it) and gets its convolver in idle time;
  // setEnvironment falls back to a synchronous build only if it comes first
  _prepareIRs() {
    if (typeof Worker === 'undefined') return;
    try {
      const w = new Worker(new URL('./ir.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const d = e.data;
        if (d.done) { this._irPending = false; w.terminate(); return; }
        if (d.chans && !this.irCache.has(d.name)) {
          this.irCache.set(d.name, irBuffer(this.ctx, d.chans));
          this._buildSoon(d.name);
        }
      };
      w.onerror = () => { this._irPending = false; w.terminate(); };
      w.postMessage({ sr: this.ctx.sampleRate, names: Object.keys(ENVIRONMENTS) });
      this._irPending = true;
    } catch { this._irPending = false; /* main-thread fallback in setEnvironment */ }
  }

  // convolver of a delivered impulse response, built in idle time (not in a frame)
  _buildSoon(name) {
    const soon = (this._soon ||= new Set());
    if (soon.has(name) || this.envConv.has(name)) return;
    soon.add(name);
    const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback : (f) => setTimeout(f, 50);
    idle(() => { soon.delete(name); this._envConv(name); }, { timeout: 1000 });
  }

  // the environment's convolver (built once; its impulse response never changes)
  _envConv(name) {
    let e = this.envConv.get(name);
    if (e || !ENVIRONMENTS[name]) return e;
    let ir = this.irCache.get(name);
    if (!ir) { ir = makeIR(this.ctx, ENVIRONMENTS[name], irSeed(name)); this.irCache.set(name, ir); }
    const conv = this.ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = ir;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    conv.connect(gain).connect(this.reverbOut);
    e = { conv, gain, on: false, timer: 0 };
    this.envConv.set(name, e);
    return e;
  }

  // lazy (the per-frame environment analysis, which asks again every 0.5 s): an environment that is not ready yet
  // (impulse response still in the worker, convolver not built) keeps the current one for now instead of building
  // it inside the frame (7-20 ms at the start of a session)
  setEnvironment(name, xfade = 1.5, lazy = false) {
    if (name === this.env || !ENVIRONMENTS[name]) return;
    if (lazy && this.env !== null && !this.envConv.has(name) && (this._irPending || this.irCache.has(name))) {
      if (this.irCache.has(name)) this._buildSoon(name);
      return;
    }
    const env = ENVIRONMENTS[name];
    const t = this.ctx.currentTime;
    const next = this._envConv(name);
    clearTimeout(next.timer);
    this.feedConv(next, true);
    next.gain.gain.cancelScheduledValues(t);
    next.gain.gain.setTargetAtTime(env.wet, t, xfade / 3);
    const old = this.env !== null ? this.envConv.get(this.env) : null;
    if (old) {
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(0, t, xfade / 3);
      // stop feeding the faded-out convolver so it goes idle (saves audio-thread CPU)
      clearTimeout(old.timer);
      old.timer = setTimeout(() => { if (this.envConv.get(this.env) !== old) this.feedConv(old, false); }, (xfade + 0.2) * 1000);
    }
    this.env = name;
  }

  feedConv(e, on) {
    if (e.on === on) return;
    e.on = on;
    if (on) this.reverbHp.connect(e.conv);
    else { try { this.reverbHp.disconnect(e.conv); } catch { /* */ } }
  }

  // world-bus state: pause / wasted / underwater / menu combine into gain + low-pass targets
  setState(key, v) {
    if (this.state[key] === v) return;
    this.state[key] = v;
    this._applyState();
  }

  _applyState() {
    const s = this.state, t = this.ctx.currentTime;
    const off = Math.max(s.paused, s.hidden);
    const worldGain = (1 - off) * (1 - 0.6 * s.wasted) * (1 - 0.35 * s.underwater) * (1 - 0.55 * s.menu);
    const lp = Math.min(20000 * Math.pow(0.03, s.wasted), 20000 * Math.pow(0.019, s.underwater), 20000 * Math.pow(0.12, s.menu));
    const musicGain = (1 - off) * (1 - s.wasted) * (1 - 0.6 * s.underwater);
    const tau = off ? 0.08 : 0.25;
    ramp(this.worldDuck.gain, worldGain, t, tau);
    this.lpTarget = Math.max(120, lp);
    ramp(this.worldFilter.frequency, this.lpTarget, t, s.wasted ? 0.5 : 0.15);
    ramp(this.musicDuck.gain, musicGain, t, tau);
  }

  // momentary duck of the world bus (explosions, stingers)
  duck(amount = 0.5, attack = 0.02, hold = 0.3, release = 0.8, at = 0) {
    const t = Math.max(this.ctx.currentTime, at);
    const p = this.world.gain;
    // never lift an ongoing deeper duck
    const cur = p.value;
    const target = Math.min(1 - amount, cur < 0.999 ? cur : 1);
    p.cancelScheduledValues(t);
    p.setValueAtTime(cur, t);
    p.setTargetAtTime(target, t, attack);
    p.setTargetAtTime(1, t + attack * 3 + hold, release / 3);
  }

  // explosion side-chain: world (engines, traffic, ambience, sfx) and music dip under a big event
  duckForBoom(depth, at, hold = 0.35, release = 1.8) {
    this.duck(depth, 0.012, hold, release, at);
    const p = this.musicDuck.gain, t = Math.max(this.ctx.currentTime, at);
    const base = p._lv ?? 1;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.setTargetAtTime(base * (1 - depth), t, 0.02);
    p.setTargetAtTime(base, t + hold + 0.1, release / 3);
  }

  dispose() {
    try { this.master.disconnect(); } catch { /* noop */ }
  }
}
