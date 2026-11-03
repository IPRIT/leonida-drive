import { PROFILES, resolveProfile } from './profiles.js';
import { ENGINE_PROCESSOR } from './engineWorklet.js';
import { Voice3D } from '../core/Voice3D.js';
import { clamp, approach, ramp, snap, disconnectAll } from '../core/util.js';

const PARAMS = ['rpm', 'throttle', 'load', 'gain', 'pitch', 'turbo', 'limiter', 'speed', 'ignition', 'starter', 'aux', 'far', 'water'];

// One engine sound source. Created by AudioSystem.createEngine(); update(telemetry, dt) every frame.
// States: off → cranking (starter) → running → stopping → off.
export class EngineVoice {
  constructor(sys, profile, opts = {}) {
    this.isEngineVoice = true;
    this.sys = sys;
    this.ctx = sys.ctx;
    this.name = resolveProfile(profile, opts.kind);
    const base = PROFILES[this.name];
    this.cfg = { ...base, ...(opts.overrides || {}) };
    if (this.cfg.mufflerMul) { this.cfg.muffler *= this.cfg.mufflerMul; this.cfg.mufflerOpen *= this.cfg.mufflerMul; }
    this.mode = this.cfg.mode;
    this.volume = opts.volume ?? 1;
    this.player = !!opts.player;
    const ctx = this.ctx;
    this.out = ctx.createGain();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = this.ctx.sampleRate / 2;
    this.muffle.Q.value = -3; // dB: Butterworth-ish, no resonance
    this.out.connect(this.muffle);
    if (opts.spatial === false) {
      this.voice = null;
      this.muffle.connect(opts.destination || sys.mixer.bus.engine);
      this.input = this.out;
    } else {
      // distance behaviour by class: the player's car stays full and clear; other cars fall off steeply and
      // are culled (they join the city bed); aircraft carry far
      const air = this.mode === 'rotor' || this.mode === 'turbine';
      const plane = this.name === 'prop', boat = this.name === 'boat';
      const dflt = this.player ? { ref: 5, rolloff: 1, air: 0.6 }
        : air ? { ref: 8, rolloff: 0.8, air: 0.4 }
        : plane ? { ref: 7, rolloff: 1.1, air: 0.5 }
        : boat ? { ref: 6, rolloff: 1.4, air: 0.8, cull: 160 }
        : { ref: 5, rolloff: 1.8, air: 1, cull: 90 };
      this.voice = new Voice3D(sys, {
        bus: opts.destination || sys.mixer.bus.engine, ref: opts.ref ?? dflt.ref, rolloff: opts.rolloff ?? dflt.rolloff,
        air: opts.air ?? dflt.air, cull: opts.cull ?? dflt.cull,
        hrtf: opts.hrtf, direct: this.player ? 0.4 : 1e-4, reverb: opts.reverb ?? 0.22, object3d: opts.object3d, position: opts.position,
        maxDelay: air ? 4 : 1.3,
      });
      this.muffle.connect(this.voice.input);
      this.input = this.voice.input;
    }
    this.state = opts.running === false ? 'off' : 'running';
    this.stateT = 0;
    this.occupied = opts.occupied ?? true;
    this.offTimer = 0;
    this.spool = 0;
    this.n1 = this.state === 'running' ? 1 : 0; // turbine / rotor spool (0..1)
    this.prevThr = 0;
    this.prevGear = 1;
    this.shiftId = undefined;
    this.flare = 0;
    this.interior = 0;
    this.submerged = 0;
    this.sim = { rpm: this.cfg.idle || 800 };
    this.lastTel = null;
    this.p = null;
    if (sys.workletReady) this._createNode();
    else if (sys.workletFailed) this._createFallback();
    else sys.onWorklet((ok) => (ok ? this._createNode() : this._createFallback()));
  }

  _createNode() {
    if (this.disposed) return;
    const cfg = { ...this.cfg };
    delete cfg.mufflerMul;
    this.node = new AudioWorkletNode(this.ctx, ENGINE_PROCESSOR, {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { cfg },
    });
    this.p = {};
    for (const k of PARAMS) this.p[k] = this.node.parameters.get(k);
    snap(this.p.gain, 0, this.ctx.currentTime);
    snap(this.p.rpm, this.state === 'running' ? this.cfg.idle : 0, this.ctx.currentTime);
    this.node.connect(this.out);
    if (this.lastTel) this.update(this.lastTel, 0);
  }

  // minimal oscillator engine if AudioWorklet is unavailable (insecure context / old browser)
  _createFallback() {
    if (this.disposed) return;
    const ctx = this.ctx;
    const mk = (type, g) => { const o = ctx.createOscillator(); o.type = type; const gn = ctx.createGain(); gn.gain.value = g; o.connect(gn); o.start(); return { o, gn }; };
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const a = mk('sawtooth', 0.4), b = mk('square', 0.15), s = mk('triangle', 0.5);
    for (const x of [a, b, s]) x.gn.connect(lp);
    lp.connect(gain).connect(this.out);
    this.fb = { a, b, s, lp, gain };
    const fake = (node) => node;
    this.p = {
      rpm: { setTargetAtTime: (v, t, tau) => { const f = v / 60 * (this.cfg.cyl || 4) / (this.cfg.stroke === 2 ? 1 : 2); a.o.frequency.setTargetAtTime(Math.max(10, f), t, tau); b.o.frequency.setTargetAtTime(Math.max(10, f * 2), t, tau); s.o.frequency.setTargetAtTime(Math.max(5, f / 2), t, tau); }, cancelScheduledValues() {}, setValueAtTime() {} },
      gain: fake(gain.gain),
      throttle: { setTargetAtTime: (v, t, tau) => lp.frequency.setTargetAtTime(300 + v * 2500, t, tau), cancelScheduledValues() {}, setValueAtTime() {} },
    };
  }

  setOccupied(b) {
    this.occupied = !!b;
    if (b) {
      this.offTimer = 0;
      if (this.state === 'off' || this.state === 'stopping') this.start(true);
    } else {
      this.offTimer = this.cfg.idleOff ?? (this.mode === 'rotor' || this.mode === 'turbine' ? 4 : 7);
    }
  }

  start(withStarter = true) {
    if (this.state === 'running' || this.state === 'cranking') return;
    const dur = this.cfg.startDur || 0;
    if (withStarter && dur > 0 && this.mode === 'ice') {
      this.state = 'cranking';
      this.stateT = dur * (0.85 + Math.random() * 0.4);
    } else {
      this.state = 'running';
      if (this.mode === 'ev') this.sys.play?.('ui_notify', { volume: 0.12, pitch: 0.5, bus: 'sfx', position: this.voice?.target });
    }
  }

  stop() {
    if (this.state === 'off' || this.state === 'stopping') return;
    this.state = 'stopping';
    this.stateT = this.mode === 'rotor' ? 9 : this.mode === 'turbine' ? 6 : 1.2;
  }

  setInterior(x) {
    if (Math.abs(x - this.interior) < 0.002) return;
    this.interior = x;
  }

  oneShot(name, gain = 1, rate = 1) {
    const buf = this.sys.bank?.get(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (this.sys.slowmo ?? 1);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.out);
    src.onended = () => disconnectAll(src, g);
    src.start();
  }

  update(tel, dt) {
    this.lastTel = tel;
    if (!this.p || this.disposed) return;
    tel = tel || {};
    const cfg = this.cfg;
    const t = this.ctx.currentTime;
    const P = this.p;
    const idle = cfg.idle || 800, max = cfg.max || 7000;
    const slow = this.sys.slowmo ?? 1;

    // occupancy → engine off after a while
    if (!this.occupied && this.offTimer > 0) {
      this.offTimer -= dt;
      if (this.offTimer <= 0 && this.state === 'running') this.stop();
    }
    if (this.stateT > 0) this.stateT -= dt;
    if (this.state === 'cranking' && this.stateT <= 0) { this.state = 'running'; this.flare = 1; }
    if (this.state === 'stopping' && this.stateT <= 0) this.state = 'off';
    const running = this.state === 'running';

    let rpm = idle, thr = clamp(tel.throttle ?? 0, 0, 1), load = thr, aux = 0, water = 0, speed = Math.abs(tel.speedKmh ?? 0) / 3.6;
    let ign = running ? 1 : 0, starter = 0;
    const spinTarget = running ? 1 : 0;

    switch (this.mode) {
      case 'turbine': {
        const tgt = running ? (cfg.idle / cfg.max) + (1 - cfg.idle / cfg.max) * thr : 0;
        const ext = tel.maxRpm && tel.rpm !== undefined ? tel.rpm / tel.maxRpm : null;
        this.n1 = ext !== null ? ext : approach(this.n1, tgt, dt, tgt > this.n1 ? 2.2 : 3.2);
        rpm = this.n1 * cfg.max;
        aux = tel.afterburner ?? (tel.boosting ? 1 : 0);
        break;
      }
      case 'rotor': {
        // adopt the craft's real rotor speed (blade-pass rate) once, while still silent
        if (tel.maxRpm && Math.abs(tel.maxRpm - cfg.max) > 1 && this.node && !this._maxSynced) {
          this._maxSynced = true;
          cfg.max = tel.maxRpm;
          this.node.port.postMessage({ type: 'cfg', cfg: { ...cfg } });
        }
        const ext = tel.rotor ?? (tel.maxRpm && tel.rpm !== undefined ? tel.rpm / tel.maxRpm : null);
        this.n1 = ext !== null && ext !== undefined ? ext : approach(this.n1, spinTarget, dt, spinTarget > this.n1 ? 3.5 : 6);
        rpm = this.n1 * cfg.max;
        // blade loading: hover already loads the rotor; collective (-1..1 or 0..1) adds/removes pitch
        load = tel.collective !== undefined ? clamp(0.5 + 0.5 * tel.collective, 0.1, 1) : clamp(tel.throttle ?? 0.5, 0.1, 1);
        if (tel.grounded) load = Math.min(load, 0.3);
        const vy = tel.verticalSpeed ?? tel.vy ?? 0;
        aux = clamp(-vy / 6, 0, 1) * 0.7 + clamp(Math.abs(tel.yawRate ?? 0) / 2, 0, 0.3);
        break;
      }
      case 'ev': {
        rpm = tel.motorRpm ?? Math.abs(tel.speedKmh ?? 0) * 85;
        load = clamp(Math.abs(tel.engineLoad ?? thr), 0, 1);
        if ((tel.brake ?? 0) > 0.1 && speed > 2) load = Math.max(load, 0.25 * tel.brake);
        break;
      }
      case 'bike':
        thr = clamp(tel.pedal ?? tel.throttle ?? 0, 0, 1);
        break;
      default: {
        if (tel.rpm !== undefined && running) rpm = tel.rpm;
        else if (running) {
          const tgt = idle + (max - idle) * Math.pow(thr, 0.8) * (tel.airborne ? 1.12 : 1);
          this.sim.rpm = approach(this.sim.rpm, tgt, dt, tgt > this.sim.rpm ? 0.35 : 0.6);
          rpm = this.sim.rpm;
        }
        load = clamp(tel.engineLoad ?? thr, 0, 1);
        if (tel.shifting) load *= 0.15;
        if (this.mode === 'ice' && this.name === 'boat') water = tel.inWater && !tel.airborne ? (speed < 7 ? 1 : 0.35) : 0;
      }
    }

    if (this.mode === 'ice') {
      if (this.state === 'cranking') {
        rpm = 190 + 60 * Math.sin(t * 9) + Math.random() * 20;
        ign = 0; starter = 1; load = 0.1; thr = 0;
      } else if (this.state === 'stopping') {
        rpm = idle * clamp(this.stateT / 1.2, 0, 1) ** 1.5;
        ign = 0; load = 0;
      } else if (this.state === 'off') rpm = 0;
      if (this.flare > 0) {
        rpm = Math.max(rpm, idle * (1 + 0.7 * this.flare));
        load = Math.max(load, 0.5 * this.flare);
        this.flare = Math.max(0, this.flare - dt / 0.9);
      }
    } else if (this.mode === 'ev' || this.mode === 'bike') {
      if (!running) { load = 0; ign = 0; }
    }

    // turbo spool, blow-off valve on lift
    if (cfg.turbo > 0 && this.mode === 'ice') {
      const rN = clamp((rpm - idle) / (max - idle), 0, 1);
      const tgt = running ? thr * clamp((rN - 0.12) / 0.45, 0, 1) * (load > 0.2 ? 1 : 0.3) : 0;
      this.spool = approach(this.spool, tgt, dt, tgt > this.spool ? 0.55 : 0.16);
      if (cfg.bov && this.prevThr > 0.5 && thr < 0.15 && this.spool > 0.35) this.oneShot('bov', 0.35 * this.spool * cfg.turbo, 0.9 + Math.random() * 0.2);
    }
    // gear shifts: clunk (cabin), DCT-style upshift pop
    if (tel.shiftId !== undefined) {
      if (this.shiftId !== undefined && tel.shiftId !== this.shiftId) {
        const up = (tel.gear ?? 1) > this.prevGear;
        const rN = (rpm - idle) / (max - idle);
        if (up && cfg.shiftPop && rN > 0.55 && thr > 0.6 && this.node && Math.random() < cfg.shiftPop) this.node.port.postMessage({ type: 'pop', count: 1 + (Math.random() < 0.4 ? 1 : 0) });
        if (this.interior > 0.5) this.oneShot('gear_clunk', 0.25);
      }
      this.shiftId = tel.shiftId;
      this.prevGear = tel.gear ?? 1;
    }
    this.prevThr = thr;

    // levels
    this.submerged = approach(this.submerged, clamp(tel.submerged ?? 0, 0, 1), dt, 0.2);
    let gain = this.volume * (this.state === 'off' ? 0 : 1);
    if (this.mode === 'rotor') gain *= clamp(this.n1 * 3, 0, 1);
    else if (this.mode === 'turbine') gain *= clamp(this.n1 * 5, 0, 1);
    if (this.mode === 'ice' && this.name !== 'boat') gain *= 1 - 0.75 * this.submerged;
    gain *= 1 - 0.25 * this.interior;
    const far = this.voice ? clamp((this.voice.dist - 40) / 400, 0, 1) : 0;

    const tau = 0.03;
    ramp(P.rpm, Math.max(0, rpm), t, 0.02, 1e-4);
    ramp(P.throttle, thr, t, tau, 1e-3);
    ramp(P.load, load, t, tau, 1e-3);
    ramp(P.gain, gain, t, this.state === 'stopping' ? 0.3 : 0.06, 1e-3);
    if (P.pitch) ramp(P.pitch, slow, t, 0.1, 1e-3);
    if (P.turbo) ramp(P.turbo, this.spool, t, 0.05, 1e-3);
    if (P.limiter) ramp(P.limiter, tel.limiter ? 1 : 0, t, 0.005, 0.01);
    if (P.speed) ramp(P.speed, speed, t, 0.05, 1e-3);
    if (P.ignition) ramp(P.ignition, ign, t, 0.01, 0.01);
    if (P.starter) ramp(P.starter, starter, t, 0.01, 0.01);
    if (P.aux) ramp(P.aux, aux, t, 0.1, 1e-3);
    if (P.far) ramp(P.far, far, t, 0.2, 1e-2);
    if (P.water) ramp(P.water, water, t, 0.15, 1e-2);
    // cabin / underwater muffling; fully open (Nyquist) otherwise so the filter can't ring on transients
    const m = Math.max(this.interior, this.submerged);
    const cut = m < 0.01 ? this.ctx.sampleRate / 2 : Math.min(18000, (1 - this.interior) * 18000 + this.interior * 2400) * (1 - 0.9 * this.submerged) + 200;
    ramp(this.muffle.frequency, cut, t, 0.08, 0.01);
  }

  get running() { return this.state === 'running' || this.state === 'cranking'; }

  dispose(fade = 0.25) {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    if (this.p?.gain) { this.p.gain.cancelScheduledValues(t); this.p.gain.setTargetAtTime(0, t, fade / 4); }
    setTimeout(() => {
      try { this.node?.port.postMessage({ type: 'stop' }); } catch { /* closed */ }
      disconnectAll(this.node, this.out, this.muffle);
      if (this.fb) { for (const k of ['a', 'b', 's']) { try { this.fb[k].o.stop(); } catch { /* */ } } disconnectAll(this.fb.lp, this.fb.gain); }
      this.voice?.dispose();
    }, (fade + 0.1) * 1000);
  }
}
