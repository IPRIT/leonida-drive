// Generative in-car radio: three "live" stations of original procedurally composed music.
// Each station runs on its own broadcast clock (songs are generated deterministically from seeds), so switching
// away and back lands mid-song like real radio. Only the tuned station is synthesised.
import { Inst, mtof } from './instruments.js';
import { rng } from '../core/dsp.js';
import { makeIR, irBuffer } from '../core/Mixer.js';
import { ramp, t_, clamp } from '../core/util.js';
import { airCutoff } from '../core/Voice3D.js';

const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], harm: [0, 2, 3, 5, 7, 8, 11] };
const mod = (a, n) => ((a % n) + n) % n;
const deg2midi = (root, scale, k) => root + 12 * Math.floor(k / 7) + scale[mod(k, 7)];
function chordOf(root, scale, d, size = 3) {
  const out = [];
  for (let i = 0; i < size; i++) out.push(deg2midi(root, scale, d + i * 2));
  return out;
}
function voiceIn(notes, lo) {
  return notes.map((m) => { while (m < lo) m += 12; while (m >= lo + 12) m -= 12; return m; }).sort((a, b) => a - b);
}
function snapToChord(k, chordDeg) {
  const set = [mod(chordDeg, 7), mod(chordDeg + 2, 7), mod(chordDeg + 4, 7)];
  for (let d = 0; d < 4; d++) for (const s of [k - d, k + d]) if (set.includes(mod(s, 7))) return s;
  return k;
}

// motif-based melody: rhythm + contour reused across phrases, re-fitted to each bar's chord
function makeMelody(r, bars, root, scale, rhythms, center = 9) {
  const motif = () => {
    const rh = r.pick(rhythms);
    const contour = rh.map((_, i) => (i === 0 ? 0 : r.pick([-1, -1, 1, 1, 1, -2, 2, 0, -3, 3, 4, -1])));
    return { rh, contour };
  };
  const A = motif(), B = motif();
  const plan = [A, A, B, A];
  const out = [];
  let last = center;
  for (let p = 0; p < Math.ceil(bars.length / 2); p++) {
    const m = plan[p % 4];
    let k = last;
    m.rh.forEach(([step, dur], i) => {
      const barI = p * 2 + Math.floor(step / 16);
      const bar = bars[barI];
      if (!bar) return;
      k += m.contour[i];
      // keep the line singable: reflect off a ~1.5 octave window around the centre
      if (k > center + 5) k = 2 * (center + 5) - k;
      if (k < center - 4) k = 2 * (center - 4) - k;
      if (step % 8 === 0 || i === 0) k = snapToChord(k, bar.deg);
      const final = p % 4 === 3 && i === m.rh.length - 1;
      if (final) k = snapToChord(Math.round(k / 7) * 7, 0);
      out.push({ bar: barI, step: step % 16, dur, midi: deg2midi(root, scale, k) });
    });
    last = k;
  }
  return out;
}

// ---------- station definitions ----------
const STATIONS = [
  {
    id: 'flamingo', name: 'Flamingo FM', genreKey: 'radio.genre.synthwave', genre: 'Retro Synthwave',
    compose(r) {
      const root = 40 + r.pick([5, 6, 9, 11, 2, 4]); // A, Bb, C#, D#, F#, G#...(minor)
      const scale = SCALES.minor;
      const progs = [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0], [0, 3, 5, 4], [0, 5, 3, 6]];
      const pv = r.pick(progs), pc = r.pick(progs);
      const sections = [['intro', 4, pv], ['verse', 8, pv], ['chorus', 8, pc], ['verse', 8, pv], ['chorus', 8, pc], ['break', 4, pv], ['chorus', 8, pc], ['outro', 4, pv]];
      return { bpm: 100 + Math.floor(r() * 12), swing: 0, root, scale, sections, rhythms: [
        [[0, 6], [6, 2], [8, 4], [12, 4], [16, 6], [22, 2], [24, 8]],
        [[0, 3], [3, 3], [6, 2], [8, 8], [16, 3], [19, 3], [22, 2], [24, 8]],
        [[2, 2], [4, 4], [8, 2], [10, 2], [12, 4], [16, 8], [24, 4], [28, 4]],
      ], center: 9 };
    },
    fx: { verb: { rt: 2.4, pre: 0.02, f0: 7000, f1: 2500, wet: 1, early: [] }, verbAmt: 0.35, delay: 0.75, fb: 0.38, delayAmt: 0.25, lp: 16000 },
    play(R, S, bar, s, t, sd) {
      const I = R.inst, d = R.dry, sec = bar.sec;
      const full = sec === 'verse' || sec === 'chorus';
      const drums = full || (sec === 'intro' && bar.i >= 2);
      if (drums && s % 4 === 0) { I.kick(d, t, { vel: 0.95 }); R.pump(t); }
      if (full && (s === 4 || s === 12)) I.snare(d, t, { vel: 0.8, gated: 0.32, send: R.verb, sendAmt: 0.9, bp: 1600 });
      if (drums && s % 4 === 2) I.hat(d, t, { vel: 0.6, open: sec === 'chorus' && s % 8 === 6 });
      if (sec === 'chorus' && s % 2 === 1) I.hat(d, t, { vel: 0.22 });
      if (bar.fill && s >= 12 && full) I.tom(d, t, [220, 180, 150, 120][s - 12], { vel: 0.7 });
      if (s === 0) {
        R.lastPad = I.pad(R.padBus, t, bar.chord, sd * 16 * 0.98, { cutoff: sec === 'intro' ? 900 + bar.i * 300 : 1900, attack: 0.25, detune: 10 });
        if (sec === 'break' && bar.i === bar.secLen - 1) I.sweep(d, t, sd * 16, { up: true, vel: 0.8 });
      }
      if (sec !== 'intro' || bar.i >= 1) {
        const ar = bar.arp[s % bar.arp.length];
        I.pluck(d, t, ar, sd * 0.9, { vel: sec === 'break' ? 0.5 : 0.7, cutoff: 1800 + (sec === 'chorus' ? 1600 : 0), send: R.delay, sendAmt: 0.35 });
      }
      if (full && s % 2 === 0) I.bass(d, t, bar.bass + (s % 4 === 2 ? 12 : 0), sd * 1.8, { vel: 0.85, cutoff: 420, envAmt: 900, q: 6 });
      if (sec === 'chorus' || sec === 'break') for (const n of bar.melody) if (n.step === s) I.lead(d, t, n.midi + 12, n.dur * sd, { vel: 0.9, send: R.delay, sendAmt: 0.4, cutoff: 3600, vib: 14 });
    },
    jingle(R, t) {
      const I = R.inst, d = R.dry, root = 57;
      I.pad(R.padBus, t, [root, root + 4, root + 7, root + 11], 2.2, { cutoff: 2600, attack: 0.05 });
      [0, 4, 7, 11, 16, 19].forEach((k, i) => I.pluck(d, t + i * 0.09, root + 12 + k, 0.3, { vel: 0.9, send: R.delay, sendAmt: 0.5, cutoff: 4000 }));
      I.sweep(d, t, 0.6, { up: true, vel: 0.6 });
      I.snare(d, t + 0.62, { vel: 0.9, gated: 0.4, send: R.verb, sendAmt: 1 });
      I.kick(d, t + 0.62, { vel: 1 });
      I.lead(d, t + 0.62, root + 24 + 7, 1.2, { vel: 0.9, send: R.delay, sendAmt: 0.5 });
      return 2.3;
    },
  },
  {
    id: 'lagoon', name: 'Lagoon Lo-Fi', genreKey: 'radio.genre.lofi', genre: 'Lo-Fi Chill',
    compose(r) {
      const root = 48 + r.pick([0, 2, 3, 5, 7, 8, 10]);
      const scale = SCALES.major;
      const progs = [[1, 4, 0, 5], [3, 2, 1, 0], [0, 5, 1, 4], [3, 4, 2, 5], [5, 1, 4, 0]];
      const pv = r.pick(progs), pc = r.pick(progs);
      const sections = [['intro', 4, pv], ['verse', 8, pv], ['chorus', 8, pc], ['verse', 8, pv], ['chorus', 8, pc], ['break', 4, pc], ['chorus', 8, pc], ['outro', 4, pv]];
      return { bpm: 76 + Math.floor(r() * 10), swing: 0.2, root, scale, sections, rhythms: [
        [[0, 4], [6, 2], [8, 6], [20, 2], [22, 2], [24, 8]],
        [[3, 3], [6, 6], [16, 2], [18, 2], [20, 8]],
        [[0, 2], [2, 2], [4, 6], [12, 2], [14, 10], [28, 4]],
      ], center: 7, sevenths: true };
    },
    fx: { verb: { rt: 1.5, pre: 0.01, f0: 4500, f1: 1500, wet: 1, early: [] }, verbAmt: 0.25, delay: 0.5, fb: 0.3, delayAmt: 0.12, lp: 6500, wobble: 7, crackle: true },
    play(R, S, bar, s, t, sd) {
      const I = R.inst, d = R.dry, sec = bar.sec;
      const drums = sec !== 'intro' && sec !== 'outro' || (sec === 'intro' && bar.i >= 2);
      const jitter = () => (Math.random() - 0.5) * 0.008;
      if (drums) {
        if (s === 0 || (s === 10 && bar.i % 2 === 0) || s === 7) I.kick(d, t + jitter(), { vel: s === 0 ? 0.85 : 0.6, f0: 110, f1: 46, decay: 0.28, click: 0.08 });
        if (s === 4 || s === 12) I.snare(d, t + jitter() + 0.01, { vel: 0.55, tone: 180, decay: 0.12, bp: 1500, send: R.verb, sendAmt: 0.25 });
        if (s % 2 === 0) I.hat(d, t + jitter(), { vel: (s % 4 === 0 ? 0.32 : 0.22) * (0.8 + Math.random() * 0.3), hp: 6000 });
        if (sec === 'chorus' && s === 14) I.hat(d, t, { vel: 0.25, open: true, hp: 6000 });
      }
      if (s === 0 || (s === 10 && sec !== 'intro')) I.rhodes(d, t + 0.005, bar.chord, sd * (s === 0 ? 9 : 6), { vel: s === 0 ? 0.8 : 0.6 });
      if (sec !== 'intro' && sec !== 'break') {
        if (s === 0) I.bass(d, t, bar.bass, sd * 6, { type: 'triangle', cutoff: 600, envAmt: 200, q: 1, sub: 0.8, vel: 0.9 });
        if (s === 8) I.bass(d, t, bar.bass + 7, sd * 3, { type: 'triangle', cutoff: 600, envAmt: 200, q: 1, sub: 0.8, vel: 0.7 });
        if (s === 14) I.bass(d, t, bar.nextBass - 1, sd * 2, { type: 'triangle', cutoff: 600, envAmt: 200, q: 1, sub: 0.8, vel: 0.6 });
      }
      if (sec === 'chorus' || sec === 'break') for (const n of bar.melody) if (n.step === s) I.lead(d, t, n.midi, n.dur * sd, { type: 'triangle', vel: 1.1, cutoff: 2200, vib: 10, attack: 0.04, send: R.verb, sendAmt: 0.3 });
      if (sec === 'verse' && bar.i % 4 === 3 && s === 12) I.bell(d, t, bar.chord[bar.chord.length - 1] + 12, 0.6, { vel: 0.6 });
    },
    jingle(R, t) {
      const I = R.inst, d = R.dry, root = 60;
      I.rhodes(d, t, [root - 12, root + 4, root + 7, root + 11, root + 14], 2, { vel: 0.9 });
      I.bell(d, t + 0.25, root + 19, 0.8, { vel: 0.8 });
      I.bell(d, t + 0.5, root + 23, 1.2, { vel: 0.7 });
      I.sweep(d, t, 0.4, { up: false, vel: 0.4 });
      return 2.2;
    },
  },
  {
    id: 'caliente', name: 'Radio Caliente', genreKey: 'radio.genre.latin', genre: 'Latin Dance',
    compose(r) {
      const root = 45 + r.pick([0, 2, 3, 5, 7, -2]);
      const scale = SCALES.harm;
      const progs = [[0, 3, 4, 0], [0, 5, 3, 4], [0, 5, 2, 6], [3, 4, 0, 0], [0, 6, 5, 4]];
      const pv = r.pick(progs), pc = r.pick(progs);
      const sections = [['intro', 4, pv], ['verse', 8, pv], ['chorus', 8, pc], ['verse', 8, pv], ['chorus', 8, pc], ['break', 4, pv], ['chorus', 8, pc], ['outro', 4, pc]];
      return { bpm: 92 + Math.floor(r() * 8), swing: 0.04, root, scale: r() < 0.5 ? SCALES.harm : SCALES.minor, sections, rhythms: [
        [[0, 2], [3, 2], [6, 2], [8, 4], [14, 2], [16, 2], [19, 2], [22, 4], [28, 4]],
        [[2, 2], [4, 2], [6, 4], [12, 2], [14, 2], [16, 6], [24, 2], [26, 2], [28, 4]],
        [[0, 3], [3, 3], [6, 2], [10, 2], [12, 4], [16, 3], [19, 3], [22, 2], [24, 8]],
      ], center: 9 };
    },
    fx: { verb: { rt: 1.3, pre: 0.012, f0: 8000, f1: 3000, wet: 1, early: [] }, verbAmt: 0.2, delay: 0.375, fb: 0.25, delayAmt: 0.1, lp: 15000 },
    play(R, S, bar, s, t, sd) {
      const I = R.inst, d = R.dry, sec = bar.sec;
      const full = sec === 'verse' || sec === 'chorus';
      if ((full || (sec === 'intro' && bar.i >= 2)) && s % 4 === 0) I.kick(d, t, { vel: 0.95, f0: 130, f1: 48, decay: 0.3 });
      if (full && (s === 3 || s === 6 || s === 11 || s === 14)) I.snare(d, t, { vel: 0.5, tone: 320, decay: 0.07, bp: 2800 });
      if (sec !== 'outro' && s % 2 === 0) I.shaker(d, t, { vel: s % 4 === 2 ? 1 : 0.6 });
      if (full && s % 4 === 2) I.hat(d, t, { vel: 0.4 });
      // son clave 3-2 over two bars
      const clave = bar.i % 2 === 0 ? [0, 6, 12] : [4, 8];
      if (sec !== 'outro' && clave.includes(s)) I.clave(d, t, { vel: 0.7 });
      if (s === 6 || s === 7) I.conga(d, t, 330, { vel: 0.5, slap: s === 6 });
      if (s === 14 || s === 15) I.conga(d, t, 250, { vel: 0.6 });
      if (sec === 'chorus' && s % 4 === 0) I.cowbell(d, t, { vel: s === 0 ? 0.9 : 0.6 });
      // piano montuno
      if ([0, 3, 6, 8, 11, 14].includes(s) && sec !== 'outro') {
        const top = bar.chord[bar.chord.length - 1];
        I.piano(d, t, s % 2 ? [...bar.chord, top + 12] : [bar.chord[0], top, top + 12], sd * 1.6, { vel: 0.8 });
      }
      // tumbao bass with anticipation
      if (full || sec === 'break') {
        const B = bar.bass;
        const pat = { 0: [B, 3], 3: [B, 2], 6: [B + 7, 2], 8: [B, 3], 11: [B + 12, 2], 14: [bar.nextBass, 2] };
        if (pat[s]) I.bass(d, t, pat[s][0], sd * pat[s][1], { type: 'triangle', cutoff: 900, envAmt: 700, q: 2, sub: 0.7, vel: 0.9 });
      }
      if (sec === 'chorus' && (s === 6 || s === 14) && bar.i % 2 === 1) I.brass(d, t, bar.chord.map((m) => m + 12), sd * 1.5, { vel: 0.9 });
      if (sec === 'chorus' || sec === 'break') for (const n of bar.melody) if (n.step === s) I.marimba(d, t, n.midi, { vel: 1 });
    },
    jingle(R, t) {
      const I = R.inst, d = R.dry, root = 57;
      [0, 0.06, 0.12, 0.18, 0.24, 0.3].forEach((x, i) => I.tom(d, t + x, 300 - i * 25, { vel: 0.6 }));
      [[0.42, 0.12], [0.6, 0.12], [0.78, 1.0]].forEach(([x, dur]) => I.brass(d, t + x, [root, root + 4, root + 7, root + 12], dur, { vel: 1 }));
      I.cowbell(d, t + 0.42, { vel: 0.8 });
      I.kick(d, t + 0.78, { vel: 1 });
      return 2.2;
    },
  },
];

class Song {
  constructor(def, seed) {
    const r = rng(seed);
    const c = def.compose(r);
    Object.assign(this, c);
    this.stepDur = 60 / this.bpm / 4;
    this.bars = [];
    for (const [sec, n, prog] of c.sections) {
      const bars = [];
      for (let i = 0; i < n; i++) {
        const deg = prog[i % prog.length];
        let chord;
        if (c.sevenths) {
          // rootless jazz voicing: 3rd + 7th low, 5th + 9th high (bass plays the root)
          const d = (k) => deg2midi(this.root, this.scale, deg + k);
          chord = [...voiceIn([d(2), d(6)], 52), ...voiceIn([d(4), d(r() < 0.6 ? 8 : 0)], 60)].sort((p, q) => p - q);
        } else chord = voiceIn(chordOf(this.root, this.scale, deg, 3), 57);
        const bass = voiceIn([deg2midi(this.root, this.scale, deg)], 33)[0];
        const arpBase = voiceIn(chordOf(this.root, this.scale, deg, 3), 64);
        const arp = [...arpBase, arpBase[0] + 12, ...arpBase.slice(1).map((m) => m + 12)];
        bars.push({ sec, i, deg, chord, bass, arp: r() < 0.5 ? arp : [...arp, ...arp.slice().reverse()], fill: i === n - 1, melody: [] });
      }
      if (sec === 'chorus' || sec === 'break') {
        for (const n of makeMelody(r, bars, this.root + 12, this.scale, c.rhythms, c.center)) bars[n.bar].melody.push(n);
      }
      bars.forEach((b) => (b.secLen = n));
      this.bars.push(...bars);
    }
    this.bars.forEach((b, i) => (b.nextBass = (this.bars[i + 1] || this.bars[0]).bass));
    this.steps = this.bars.length * 16;
    this.duration = this.steps * this.stepDur;
  }
}

const GAP = 2.6; // station ID / jingle between songs

class Station {
  constructor(def, idx, epoch) {
    this.def = def;
    this.idx = idx;
    this.epoch = epoch - 40 - Math.random() * 200; // "on air" for a while already
    this.seed = (Math.random() * 1e6) | 0;
    this.songs = [];
  }
  ensure(pos) {
    while (!this.songs.length || this.songs[this.songs.length - 1].end < pos + 20) {
      const prev = this.songs[this.songs.length - 1];
      const song = new Song(this.def, this.seed + this.songs.length * 7919 + this.idx * 104729);
      const start = prev ? prev.end + GAP : Math.max(0, pos - 30);
      this.songs.push({ song, start, end: start + song.duration });
    }
    while (this.songs.length > 3 && this.songs[0].end < pos - 30) this.songs.shift();
  }
  at(pos) {
    this.ensure(pos);
    for (const s of this.songs) if (pos < s.end) return s;
    return this.songs[this.songs.length - 1];
  }
}

export class Radio {
  constructor(sys) {
    this.sys = sys;
    const ctx = (this.ctx = sys.ctx);
    this.inst = new Inst(ctx, sys.bank.noise.white);
    this.stations = STATIONS.map((d, i) => new Station(d, i, ctx.currentTime));
    const saved = sys.game?.settings?.radioStation;
    this.index = Number.isInteger(saved) && saved >= -1 && saved < STATIONS.length ? saved : 0;
    // car speaker chain: broadcast compression → band-limit → presence → out
    this.input = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20; this.comp.ratio.value = 3.5; this.comp.attack.value = 0.005; this.comp.release.value = 0.2; this.comp.knee.value = 8;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 65; this.hp.Q.value = 0.7;
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 120; this.low.gain.value = 3;
    this.pres = ctx.createBiquadFilter(); this.pres.type = 'peaking'; this.pres.frequency.value = 2600; this.pres.Q.value = 0.9; this.pres.gain.value = 2;
    this.top = ctx.createBiquadFilter(); this.top.type = 'lowpass'; this.top.frequency.value = 12500; this.top.Q.value = 0.5;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    // pan: centred while the camera rides the car; a free camera hears the speakers from where the car is
    this.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.input.connect(this.comp).connect(this.hp).connect(this.low).connect(this.pres).connect(this.top).connect(this.out);
    if (this.pan) this.out.connect(this.pan).connect(sys.mixer.bus.music);
    else this.out.connect(sys.mixer.bus.music);
    this.prox = 1;
    this.audible = false;
    this.active = false;
    this.silentFor = 0;
    this.enterDelay = 0;
    this.chain = null;
    this.timer = null;
    this.pending = null;
    this.irs = {};
    this.verbs = {}; // station id -> idle convolvers (impulse response already set)
    this._prepareIRs();
  }

  // Station reverbs: impulse responses synthesised in a worker (7-15 ms each on the main thread, paid by the first
  // station start of a session ~1 s after entering a vehicle), the tuned station's convolver built in idle time.
  _prepareIRs() {
    if (typeof Worker === 'undefined') return;
    try {
      const w = new Worker(new URL('../core/ir.worker.js', import.meta.url), { type: 'module' });
      const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback : (f) => setTimeout(f, 50);
      w.onmessage = (e) => {
        const d = e.data;
        if (d.done) { w.terminate(); return; }
        if (!d.chans || this.irs[d.name]) return;
        this.irs[d.name] = irBuffer(this.ctx, d.chans);
        if (STATIONS[this.index]?.id !== d.name) return;
        idle(() => {
          const def = STATIONS[this.index], pool = def && (this.verbs[def.id] ||= []);
          if (pool && !pool.length && !this.chain) pool.push(this._newVerb(def));
        }, { timeout: 2000 });
      };
      w.onerror = () => w.terminate();
      const tuned = STATIONS[this.index]?.id;
      const items = STATIONS.map((d) => ({ name: d.id, env: d.fx.verb, seed: 11 })).sort((a, b) => (b.name === tuned) - (a.name === tuned));
      w.postMessage({ sr: this.ctx.sampleRate, items });
    } catch { /* built on first use */ }
  }

  _newVerb(def) {
    const v = this.ctx.createConvolver();
    v.normalize = false;
    v.buffer = this.irs[def.id] ||= makeIR(this.ctx, def.fx.verb, 11);
    return v;
  }

  // a station chain's reverb: a pooled convolver of that station (setting a convolver's buffer builds its FFT
  // partitions on the main thread, 2-8 ms per station start) or a new one
  _verb(def) {
    const pool = this.verbs[def.id];
    return pool?.length ? pool.pop() : this._newVerb(def);
  }

  get stationName() { return this.index < 0 ? t_(this.sys.game, 'radio.off', 'Radio Off') : STATIONS[this.index].name; }

  // per-station FX chain; rebuilt on each tune so old tails fade independently
  buildChain(def) {
    const ctx = this.ctx;
    const c = {};
    c.gain = ctx.createGain();
    c.gain.gain.value = 0;
    c.lp = ctx.createBiquadFilter(); c.lp.type = 'lowpass'; c.lp.frequency.value = def.fx.lp; c.lp.Q.value = 0.6;
    c.gain.connect(c.lp).connect(this.input);
    // music → (ducked by station IDs) → station gain; jingles bypass the duck
    c.music = ctx.createGain();
    c.music.connect(c.gain);
    c.dry = ctx.createGain(); c.dry.gain.value = 0.8;
    c.dry.connect(c.music);
    c.padBus = ctx.createGain(); c.padBus.connect(c.dry);
    c.jingle = ctx.createGain(); c.jingle.gain.value = 0.8;
    c.jingle.connect(c.gain);
    c.id = def.id;
    c.verb = this._verb(def);
    const vr = ctx.createGain(); vr.gain.value = def.fx.verbAmt;
    c.verb.connect(vr).connect(c.gain);
    const vs = ctx.createGain(); vs.gain.value = 0.35;
    c.dry.connect(vs).connect(c.verb);
    c.jingle.connect(vs);
    c.delay = ctx.createDelay(2);
    c.delay.delayTime.value = def.fx.delay * 60 / 100;
    const fb = ctx.createGain(); fb.gain.value = def.fx.fb;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 3500;
    c.delay.connect(dlp).connect(fb).connect(c.delay);
    const dr = ctx.createGain(); dr.gain.value = def.fx.delayAmt * 3;
    dlp.connect(dr).connect(c.gain);
    c.nodes = [c.gain, c.lp, c.music, c.dry, c.padBus, c.jingle, c.verb, vr, vs, c.delay, fb, dlp, dr];
    if (def.fx.wobble) {
      c.wob = ctx.createOscillator(); c.wob.frequency.value = 0.55;
      c.wobG = ctx.createGain(); c.wobG.gain.value = def.fx.wobble;
      c.wob.connect(c.wobG); c.wob.start();
      c.nodes.push(c.wob, c.wobG);
    }
    const crackle = def.fx.crackle && this.sys.bank.get('rain_light');
    if (crackle) {
      // vinyl surface noise: sparse droplet clicks band-passed, very quiet
      const src = ctx.createBufferSource(); src.buffer = crackle; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 3000; hp.Q.value = 0.7;
      const g = ctx.createGain(); g.gain.value = 0.05;
      src.connect(hp).connect(g).connect(c.gain); src.start();
      c.nodes.push(src, hp, g);
      c.src = src;
    }
    return c;
  }

  dropChain(c, fade = 0.2) {
    if (!c) return;
    const t = this.ctx.currentTime;
    c.gain.gain.cancelScheduledValues(t);
    c.gain.gain.setTargetAtTime(0, t, fade / 3);
    setTimeout(() => {
      try { c.wob?.stop(); c.src?.stop(); } catch { /* */ }
      for (const n of c.nodes) { try { n.disconnect(); } catch { /* */ } }
      // the convolver back to its station's pool once its tail has died out (impulse responses are < 3 s)
      setTimeout(() => { const pool = (this.verbs[c.id] ||= []); if (pool.length < 2) pool.push(c.verb); }, 3000);
    }, (fade + 4) * 1000);
  }

  // side-chain pump (synthwave)
  pump(t) {
    const p = this.chain?.padBus.gain;
    if (!p) return;
    p.setValueAtTime(0.35, t);
    p.setTargetAtTime(1, t + 0.02, 0.09);
  }

  get dry() { return this.chain.dry; }
  get padBus() { return this.chain.padBus; }
  get verb() { return this.chain.verb; }
  get delay() { return this.chain.delay; }

  // jingle target: same instruments, but into the un-ducked jingle bus
  jingleCtx() {
    const c = this.chain;
    return { inst: this.inst, dry: c.jingle, padBus: c.jingle, verb: c.verb, delay: c.delay, pump() {} };
  }

  setTempo(song) {
    if (!this.chain) return;
    const def = this.stations[this.index]?.def;
    if (def) this.chain.delay.delayTime.setTargetAtTime(Math.min(1.9, def.fx.delay * 60 / song.bpm), this.ctx.currentTime, 0.05);
  }

  tune(index, { announce = true, staticBurst = true } = {}) {
    this.index = index;
    this.dropChain(this.chain, 0.15);
    this.chain = null;
    this.cursor = null;
    if (staticBurst && this.audible) {
      const b = this.sys.bank.get('radio_static');
      if (b) { const s = this.ctx.createBufferSource(); s.buffer = b; const g = this.ctx.createGain(); g.gain.value = 0.2; s.connect(g).connect(this.input); s.onended = () => { s.disconnect(); g.disconnect(); }; s.start(); }
    }
    if (index >= 0 && this.active) this.startStation(staticBurst ? 0.18 : 0);
    if (announce) {
      const ui = this.sys.game?.ui;
      const genre = index >= 0 ? t_(this.sys.game, STATIONS[index].genreKey, STATIONS[index].genre) : '';
      if (ui?.showRadio) ui.showRadio(this.stationName, genre);
      else ui?.toast?.(this.stationName, genre, 2);
      this.sys.game?.events?.emit('radio:station', { index, name: this.stationName, genre });
      try { this.sys.game?.applySetting?.('radioStation', index); } catch { /* settings optional */ }
      // station ID once the player settles on a station
      clearTimeout(this.idTimer);
      if (index >= 0) this.idTimer = setTimeout(() => this.stationId(), 700);
    }
  }

  next(dir) {
    const n = STATIONS.length + 1; // + off
    let i = this.index < 0 ? STATIONS.length : this.index;
    i = mod(i + dir, n);
    this.tune(i === STATIONS.length ? -1 : i);
  }

  stationId() {
    if (!this.chain || this.index < 0) return;
    const st = this.stations[this.index];
    const t = this.ctx.currentTime + 0.05;
    const g = this.chain.music.gain;
    g.setTargetAtTime(0.35, t, 0.05);
    const dur = st.def.jingle(this.jingleCtx(), t + 0.05);
    g.setTargetAtTime(1, t + dur * 0.8, 0.3);
  }

  startStation(delay = 0) {
    const st = this.stations[this.index];
    this.chain = this.buildChain(st.def);
    this.inst.wobble = this.chain.wobG || null;
    const t = this.ctx.currentTime + delay;
    this.chain.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.chain.gain.gain.setTargetAtTime(1, t, 0.6); // ~2 s fade-in on start and on every station change
    // resume the live broadcast at the next 16th
    const pos = t + 0.05 - st.epoch;
    const seg = st.at(pos);
    const song = seg.song;
    let idx = Math.ceil((pos - seg.start) / song.stepDur);
    if (idx < 0) idx = 0;
    this.cursor = { st, seg, idx };
    this.setTempo(song);
    // re-strike the current bar's sustained chord so it doesn't start empty
    const bar = song.bars[Math.floor(idx / 16)];
    if (bar && idx % 16 !== 0 && idx < song.steps) {
      const rest = (16 - (idx % 16)) * song.stepDur;
      if (st.def.id === 'flamingo') this.inst.pad(this.padBus, t + 0.05, bar.chord, rest, { cutoff: 1800, attack: 0.15 });
      else if (st.def.id === 'lagoon') this.inst.rhodes(this.dry, t + 0.05, bar.chord, rest, { vel: 0.6 });
    }
  }

  vehicleEntered() { this.enterDelay = 1.0; }

  schedule() {
    const c = this.cursor;
    if (!c || !this.chain) return;
    const horizon = this.ctx.currentTime + 0.3;
    for (let guard = 0; guard < 64; guard++) {
      const { st, seg } = c;
      const song = seg.song;
      if (c.idx >= song.steps) {
        // jingle in the gap, then the next song
        if (!c.jingled) {
          const tj = st.epoch + seg.end + 0.25;
          if (tj > horizon) return;
          if (tj > this.ctx.currentTime - 0.05) st.def.jingle(this.jingleCtx(), Math.max(tj, this.ctx.currentTime + 0.01));
          c.jingled = true;
        }
        const nxt = st.at(seg.end + GAP * 0.5);
        if (nxt === seg) return;
        c.seg = nxt; c.idx = 0; c.jingled = false;
        this.setTempo(nxt.song);
        continue;
      }
      const swing = c.idx % 2 === 1 ? song.swing * song.stepDur : 0;
      const t = st.epoch + seg.start + c.idx * song.stepDur + swing;
      if (t > horizon) return;
      if (t >= this.ctx.currentTime - 0.01) {
        const bar = song.bars[Math.floor(c.idx / 16)];
        try { st.def.play(this, song, bar, c.idx % 16, Math.max(t, this.ctx.currentTime), song.stepDur); } catch (e) { console.warn('[radio]', e); }
      }
      c.idx++;
    }
  }

  update(dt) {
    const sys = this.sys, g = sys.game;
    const p = g?.player;
    // the player's vehicle stays "on air" while a free camera looks around (the character is still inside);
    // what changes is how much of it reaches the camera
    const v = sys.playerVehicle || (p?.mode === 'vehicle' ? p.controllable : null);
    const kind = v?.kind || 'car';
    const inVehicle = !!v && kind !== 'bicycle' && !v.destroyed;
    // GTA-style: full in the cabin / chase cam; a free camera hears the car speakers fade out by ~40 m
    const attached = sys.camAttached ?? true;
    const camDist = Number.isFinite(sys.camDist) ? sys.camDist : 0;
    const near = attached || sys.interior > 0.5 ? 1 : Math.pow(clamp(1 - (camDist - 4) / 36, 0, 1), 1.5);
    this.prox = this.forceOn !== undefined ? 1 : near;
    if (this.forceOn !== undefined ? this.forceOn : inVehicle) {
      if (this.enterDelay > 0) this.enterDelay -= dt;
    } else this.enterDelay = 0;
    const want = (this.forceOn !== undefined ? this.forceOn : inVehicle) && this.enterDelay <= 0 && this.index >= 0 && this.prox > 0.001;
    // station keys: , . and gamepad d-pad left/right
    const inp = g?.input;
    if (inp && ((inVehicle && p?.mode !== 'free') || this.forceOn) && !g.paused) {
      if (inp.pressed?.('Comma') || inp.gpPressedBtn?.(14)) this.next(-1);
      if (inp.pressed?.('Period') || inp.gpPressedBtn?.(15)) this.next(1);
    }
    const now = sys.ctx.currentTime;
    if (want && !this.active) { this.active = true; this.onAt = now; if (!this.chain) this.startStation(0.05); }
    if (want !== this.audible) { this.audible = want; }
    // ~2 s fade-in when the radio comes on, never a burst; afterwards follow the camera distance quickly
    const fading = now - (this.onAt ?? -10) < 2.5;
    ramp(this.out.gain, want ? 0.6 * this.prox : 0, now, want ? (fading ? 0.6 : 0.15) : 0.12, 1e-3);
    if (!want) {
      this.silentFor += dt;
      if (this.active && this.silentFor > 1.2) { this.active = false; this.dropChain(this.chain, 0.05); this.chain = null; this.cursor = null; }
    } else this.silentFor = 0;
    // exterior camera: the car speakers are heard through the bodywork, and through more air the farther it is
    const cab = sys.interior;
    let top = 4200 + 8300 * Math.max(cab, 0.55);
    if (!attached && cab < 0.5) top = Math.min(top, airCutoff(camDist, 1));
    ramp(this.top.frequency, top, now, 0.2, 0.01);
    if (this.pan) {
      let pan = 0;
      const o = v?.object3d?.position, L = sys.listener, R = sys.listenerRight;
      if (!attached && o && L && R && camDist > 1.5) pan = clamp(((o.x - L.x) * R.x + (o.z - L.z) * R.z) / camDist, -1, 1) * 0.7 * (1 - cab);
      ramp(this.pan.pan, pan, now, 0.1, 1e-3);
    }
  }

  // runs on a timer so music keeps time when frames hitch
  tick() { if (this.active && !this.sys.game?.paused) this.schedule(); }

  dispose() { clearTimeout(this.idTimer); this.dropChain(this.chain, 0.05); try { this.out.disconnect(); this.pan?.disconnect(); } catch { /* */ } }
}

export const RADIO_STATIONS = STATIONS.map((s) => ({ id: s.id, name: s.name, genre: s.genre }));
export { mtof };
