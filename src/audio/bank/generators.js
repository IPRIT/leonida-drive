// Procedural one-shot / loop generators. Each returns an array of Float32Array channels at `sr`.
// Pure functions of (sr, seeded rng, variant) — runs in a worker (see bank.worker.js).
import {
  TAU, clamp, rng, Biquad, OnePole, ModeBank, alloc, normalize, fade, removeDC, makeLoop, addAt, softclip,
  pinkGen, brownGen,
} from '../core/dsp.js';

// ---------- building blocks ----------

// excite a modal bank with an excitation function, write into out from `at`
function ring(out, at, modes, sr, exLen, ex, maxSec = 2, gain = 1) {
  const mb = new ModeBank(modes, sr);
  const dmax = Math.min(maxSec, Math.max(...modes.map((m) => m[1])) * 1.1);
  const n = Math.min(out.length - at, exLen + Math.round(dmax * sr));
  for (let i = 0; i < n; i++) out[at + i] += mb.p(i < exLen ? ex(i) : 0) * gain;
}

// short noise burst through a bandpass
function burst(out, at, sr, r, { dur = 0.01, f = 2000, q = 0.8, amp = 1, type = 'bandpass', attack = 0.0005, tau = null }) {
  const bq = new Biquad(type, f, q, sr);
  const n = Math.min(out.length - at, Math.round(dur * 4 * sr));
  const ta = attack * sr, td = (tau ?? dur / 3) * sr;
  for (let i = 0; i < n; i++) {
    const e = i < ta ? i / ta : Math.exp(-(i - ta) / td);
    out[at + i] += bq.p((r() * 2 - 1) * e) * amp;
  }
}

// low thud: falling sine + lowpassed noise
function thud(out, at, sr, r, { f0 = 110, f1 = 45, tau = 0.12, amp = 1, noise = 0.6, lp = 250 }) {
  const lpf = new Biquad('lowpass', lp, 0.7, sr);
  const n = Math.min(out.length - at, Math.round(tau * 6 * sr));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / (tau * 0.5));
    ph += TAU * f / sr;
    const e = (t < 0.002 ? t / 0.002 : 1) * Math.exp(-t / tau);
    out[at + i] += (Math.sin(ph) + lpf.p(r() * 2 - 1) * noise * 2) * e * amp;
  }
}

// pitched sine/partial with envelope
function tone(out, at, sr, { f, f1 = f, dur = 0.2, attack = 0.002, tau = 0.08, amp = 1, harm = null, vib = 0, vibHz = 6 }) {
  const n = Math.min(out.length - at, Math.round(dur * sr));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ff = (f + (f1 - f) * (t / dur)) * (1 + vib * Math.sin(TAU * vibHz * t));
    ph += TAU * ff / sr;
    const e = (t < attack ? t / attack : Math.exp(-(t - attack) / tau)) * (i > n - 64 ? (n - i) / 64 : 1);
    let s = Math.sin(ph);
    if (harm) for (let k = 0; k < harm.length; k++) s += Math.sin(ph * (k + 2)) * harm[k];
    out[at + i] += s * e * amp;
  }
}

// filtered-noise layer with an arbitrary envelope function and optional time-varying filter
function noiseLayer(out, at, sr, r, { dur, env, type = 'bandpass', f = 1000, fEnd = null, q = 0.7, amp = 1, gen = null, fFn = null }) {
  const bq = new Biquad(type, f, q, sr);
  const n = Math.min(out.length - at, Math.round(dur * sr));
  const g = gen || (() => r() * 2 - 1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 63) === 0 && (fEnd !== null || fFn)) {
      const ff = fFn ? fFn(t) : f * Math.pow(fEnd / f, t / dur);
      bq.set(type, ff, q);
    }
    out[at + i] += bq.p(g()) * env(t) * amp;
  }
}

function metalModes(r, n, lo, hi, dLo, dHi, s = 1) {
  const m = [];
  for (let k = 0; k < n; k++) m.push([r.range(lo, hi), r.range(dLo, dHi) * s, r.range(0.25, 1) / (1 + k * 0.12)]);
  return m;
}

function excitationBursts(sr, r, count, spanSec, burstSec) {
  const len = Math.round((spanSec + burstSec * 2) * sr);
  const ex = new Float32Array(len);
  for (let k = 0; k < count; k++) {
    const at = Math.round(Math.pow(r(), 1.6) * spanSec * sr);
    const a = (k === 0 ? 1 : r.range(0.2, 0.9));
    const bl = Math.round(r.range(0.4, 1) * burstSec * sr);
    for (let i = 0; i < bl && at + i < len; i++) ex[at + i] += (r() * 2 - 1) * a * (1 - i / bl);
  }
  return ex;
}

function metalHit(out, at, sr, r, s) {
  const modes = metalModes(r, 8 + Math.round(s * 8), 160, 4200, 0.05, 0.3, 0.7 + s * 0.8);
  const ex = excitationBursts(sr, r, 2 + Math.round(s * 8), 0.02 + s * 0.12, 0.004);
  ring(out, at, modes, sr, ex.length, (i) => ex[i], 1.6, 0.35);
  // crumple grit
  const grit = new Float32Array(Math.round((0.1 + s * 0.35) * sr));
  let acc = 0;
  noiseLayer(grit, 0, sr, r, {
    dur: grit.length / sr, type: 'bandpass', f: 2600, q: 0.6, amp: 0.7,
    env: (t) => { acc = acc * 0.995 + (r() < 0.004 ? r() : 0); return Math.exp(-t / (0.05 + s * 0.12)) * (0.4 + acc * 3); },
  });
  addAt(out, grit, at, 0.6 + s * 0.4);
  thud(out, at, sr, r, { f0: 120, f1: 45, tau: 0.08 + s * 0.12, amp: 0.5 + s * 0.6, noise: 0.5 });
}

function glassShatter(out, at, sr, r, s = 1, outR = null) {
  burst(out, at, sr, r, { dur: 0.012, f: 4500, q: 0.5, amp: 0.9 * s, type: 'highpass' });
  const n = Math.round(18 + s * 50);
  for (let k = 0; k < n; k++) {
    const t = Math.pow(r(), 2.2) * (0.25 + s * 0.6);
    const a = Math.exp(-t * 2.5) * r.range(0.15, 1) * s;
    const modes = [];
    const nm = 2 + Math.floor(r() * 3);
    for (let m = 0; m < nm; m++) modes.push([r.range(2500, 10500), r.range(0.015, 0.12), r.range(0.4, 1)]);
    const dst = outR && r() < 0.5 ? outR : out;
    const ex0 = Math.round(sr * 0.0006);
    ring(dst, at + Math.round(t * sr), modes, sr, ex0, () => r() * 2 - 1, 0.15, a * 0.6);
  }
  noiseLayer(out, at, sr, r, { dur: 0.5 * s + 0.1, type: 'highpass', f: 4500, q: 0.6, amp: 0.12 * s, env: (t) => Math.exp(-t / 0.12) });
}

function woodCrack(out, at, sr, r, s = 1) {
  burst(out, at, sr, r, { dur: 0.004, f: 2500, q: 0.5, amp: 1.2 * s, type: 'highpass' });
  const modes = [[r.range(140, 260), 0.09, 1], [r.range(380, 650), 0.06, 0.7], [r.range(850, 1400), 0.035, 0.45], [r.range(1800, 2600), 0.02, 0.3]];
  ring(out, at, modes, sr, Math.round(0.003 * sr), () => r() * 2 - 1, 0.4, 0.5 * s);
  const clicks = 4 + Math.round(r() * 8 * s);
  for (let k = 0; k < clicks; k++) {
    const t = Math.pow(r(), 1.5) * (0.08 + 0.25 * s);
    burst(out, at + Math.round(t * sr), sr, r, { dur: r.range(0.001, 0.004), f: r.range(1200, 4000), q: 1.2, amp: r.range(0.2, 0.7) * s });
  }
}

function grains(out, at, sr, r, { dur, rate, fLo, fHi, gLo = 0.001, gHi = 0.006, amp = 0.5, env = () => 1, pan = null }) {
  const n = Math.round(dur * rate);
  for (let k = 0; k < n; k++) {
    const t = r() * dur;
    const e = env(t);
    if (e <= 0.001) continue;
    const dst = pan && r() < 0.5 ? pan : out;
    burst(dst, at + Math.round(t * sr), sr, r, { dur: r.range(gLo, gHi), f: r.range(fLo, fHi), q: r.range(0.8, 2.5), amp: amp * e * Math.pow(r(), 1.5) });
  }
}

function bubbles(out, at, sr, r, { count, dur, fLo, fHi, amp }) {
  for (let k = 0; k < count; k++) {
    const t = Math.pow(r(), 1.4) * dur;
    const f0 = r.range(fLo, fHi);
    const tau = r.range(0.012, 0.05) * (600 / f0) ** 0.5;
    const n = Math.round(tau * 5 * sr);
    const o = at + Math.round(t * sr);
    let ph = 0;
    for (let i = 0; i < n && o + i < out.length; i++) {
      const tt = i / sr;
      ph += TAU * f0 * (1 + 1.8 * tt / tau) / sr;
      out[o + i] += Math.sin(ph) * Math.exp(-tt / tau) * amp * r.range(0.6, 1);
    }
  }
}

const loop = (sr, len, xf, fill) => makeLoop(len, xf, fill, sr);
const stereo = (sec, sr) => [alloc(sec, sr), alloc(sec, sr)];
const mono = (sec, sr) => [alloc(sec, sr)];
function finish(chs, sr, target = 0.9, fadeOut = 0.02) {
  for (const c of chs) { removeDC(c, sr, 12); fade(c, sr, 0.0005, fadeOut); }
  return normalize(chs, target);
}

// ---------- generators ----------
export const GENERATORS = {
  // ----- impacts -----
  metal: {
    variants: 4,
    fn(sr, r, v) {
      const s = v < 2 ? 0.35 : 0.85;
      const [c] = mono(0.4 + s * 1.2, sr);
      metalHit(c, 0, sr, r, s);
      if (v >= 2) {
        metalHit(c, Math.round(r.range(0.03, 0.09) * sr), sr, r, 0.5);
        grains(c, Math.round(0.2 * sr), sr, r, { dur: 0.9, rate: 30, fLo: 1500, fHi: 6000, amp: 0.25, env: (t) => Math.exp(-t * 3) });
      }
      return finish([c], sr);
    },
  },
  glass: {
    variants: 3,
    fn(sr, r) {
      const ch = stereo(1.1, sr);
      glassShatter(ch[0], 0, sr, r, 1, ch[1]);
      glassShatter(ch[1], Math.round(0.004 * sr), sr, r, 0.6, ch[0]);
      return finish(ch, sr, 0.85);
    },
  },
  wood: {
    variants: 3,
    fn(sr, r) {
      const [c] = mono(0.6, sr);
      woodCrack(c, 0, sr, r, 0.8);
      thud(c, 0, sr, r, { f0: 140, f1: 60, tau: 0.06, amp: 0.4 });
      return finish([c], sr);
    },
  },
  concrete: {
    variants: 3,
    fn(sr, r) {
      const [c] = mono(0.9, sr);
      thud(c, 0, sr, r, { f0: 90, f1: 38, tau: 0.14, amp: 1, noise: 0.9, lp: 320 });
      burst(c, 0, sr, r, { dur: 0.02, f: 900, q: 0.5, amp: 0.6 });
      grains(c, 0, sr, r, { dur: 0.6, rate: 120, fLo: 700, fHi: 5000, amp: 0.45, env: (t) => Math.exp(-t * 6) });
      return finish([c], sr);
    },
  },
  plastic: {
    variants: 3,
    fn(sr, r) {
      const [c] = mono(0.35, sr);
      const modes = [];
      for (let k = 0; k < 4; k++) modes.push([r.range(300, 1800), r.range(0.025, 0.07), r.range(0.4, 1)]);
      ring(c, 0, modes, sr, Math.round(0.002 * sr), () => r() * 2 - 1, 0.3, 0.6);
      for (let k = 0; k < 4; k++) {
        ring(c, Math.round(r.range(0.02, 0.15) * sr), modes, sr, Math.round(0.001 * sr), () => r() * 2 - 1, 0.1, r.range(0.1, 0.35));
      }
      burst(c, 0, sr, r, { dur: 0.004, f: 3000, q: 0.7, amp: 0.4 });
      return finish([c], sr, 0.8);
    },
  },
  body: {
    variants: 3,
    fn(sr, r) {
      const [c] = mono(0.4, sr);
      thud(c, 0, sr, r, { f0: 95, f1: 50, tau: 0.07, amp: 0.9, noise: 1.2, lp: 420 });
      noiseLayer(c, 0, sr, r, { dur: 0.15, f: 1800, q: 0.6, amp: 0.25, env: (t) => (t < 0.02 ? t / 0.02 : Math.exp(-(t - 0.02) / 0.04)) });
      thud(c, Math.round(r.range(0.12, 0.2) * sr), sr, r, { f0: 80, f1: 45, tau: 0.05, amp: 0.35, noise: 1 });
      return finish([c], sr, 0.8);
    },
  },
  crash: {
    variants: 2,
    fn(sr, r) {
      const ch = stereo(2.4, sr);
      metalHit(ch[0], 0, sr, r, 1);
      metalHit(ch[1], Math.round(0.006 * sr), sr, r, 0.9);
      metalHit(ch[0], Math.round(r.range(0.05, 0.11) * sr), sr, r, 0.6);
      glassShatter(ch[1], Math.round(0.02 * sr), sr, r, 0.9, ch[0]);
      // scrape tail
      const modes = metalModes(r, 6, 700, 4000, 0.02, 0.06);
      const mb = new ModeBank(modes, sr);
      const n = Math.round(0.9 * sr), o = Math.round(0.12 * sr);
      for (let i = 0; i < n && o + i < ch[0].length; i++) {
        const t = i / sr;
        const x = (r() < 0.25 ? r() * 2 - 1 : 0) * Math.exp(-t * 3.5);
        const y = mb.p(x) * 0.25;
        ch[0][o + i] += y; ch[1][o + i] += y * 0.8;
      }
      grains(ch[0], Math.round(0.3 * sr), sr, r, { dur: 1.8, rate: 25, fLo: 1500, fHi: 7000, amp: 0.3, env: (t) => Math.exp(-t * 2), pan: ch[1] });
      thud(ch[0], 0, sr, r, { f0: 80, f1: 32, tau: 0.25, amp: 0.9, noise: 0.8 });
      thud(ch[1], 0, sr, r, { f0: 80, f1: 32, tau: 0.25, amp: 0.9, noise: 0.8 });
      return finish(ch, sr);
    },
  },

  // ----- explosions -----
  // big, deep car explosion: crack → punch + sub drop → boom with a long tail → rolling rumble, fireball roar,
  // fuel-tank whoomp and a long debris rain
  explosion: {
    variants: 2,
    fn(sr, r, v) {
      const dur = 7.5;
      const ch = stereo(dur, sr);
      for (let c = 0; c < 2; c++) {
        const out = ch[c];
        const rr = rng(Math.floor(r() * 1e9));
        // N-wave + crack
        const nw = Math.round(0.018 * sr);
        const lpN = new OnePole(2600, sr);
        for (let i = 0; i < nw; i++) {
          const t = i / nw;
          const x = t < 0.12 ? t / 0.12 : 1 - 1.8 * (t - 0.12) / 0.88;
          out[i] += lpN.lp(x) * 1.8;
        }
        burst(out, 0, sr, rr, { dur: 0.016, f: 700, q: 0.4, amp: 1.3, type: 'highpass' });
        // boom: brown noise, low-pass sweeping down fast, long tail
        noiseLayer(out, 0, sr, rr, {
          dur: dur - 0.2, type: 'lowpass', f: 1800, q: 0.8, amp: 2.2, gen: brownGen(rr),
          fFn: (t) => 75 + 1700 * Math.exp(-t / 0.13),
          env: (t) => (t < 0.003 ? t / 0.003 : 0.6 * Math.exp(-(t - 0.003) / 0.45) + 0.4 * Math.exp(-(t - 0.003) / 2.2)),
        });
        // rolling rumble: slow low swells, like thunder rolling off the buildings
        const swells = [[0.15, 1, 1.0], [rr.range(0.7, 1.3), 0.7, 1.2], [rr.range(1.6, 2.6), 0.55, 1.4], [rr.range(2.8, 4), 0.4, 1.6]];
        noiseLayer(out, 0, sr, rr, {
          dur: dur - 0.2, type: 'lowpass', f: 140, q: 0.7, amp: 1.5, gen: brownGen(rr),
          env: (t) => { let e = 0; for (const [s0, a, d] of swells) if (t > s0) e += a * (t - s0 < 0.3 ? (t - s0) / 0.3 : Math.exp(-(t - s0 - 0.3) / d)); return e; },
        });
        // fireball roar (mid body) and fire tail
        let lfo = 0;
        noiseLayer(out, 0, sr, rr, {
          dur: 4.5, type: 'bandpass', f: 320, q: 0.6, amp: 0.75,
          env: (t) => { lfo += (rr() - 0.5) * 0.02; lfo *= 0.999; return (t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 1.1)) * (0.75 + lfo * 3); },
        });
        noiseLayer(out, 0, sr, rr, { dur: 6, type: 'lowpass', f: 600, q: 0.6, amp: 0.4, env: (t) => (t < 0.45 ? t / 0.45 : Math.exp(-(t - 0.45) / 2)) });
        // fuel tank: a second, rounder whoomp a moment later
        const tw = (v ? 0.32 : 0.22) + rr() * 0.12;
        thud(out, Math.round(tw * sr), sr, rr, { f0: 95, f1: 38, tau: 0.35, amp: 0.8, noise: 1.4, lp: 260 });
        noiseLayer(out, Math.round(tw * sr), sr, rr, { dur: 1.4, f: 180, q: 0.9, amp: 0.6, fFn: (t) => 180 + 900 * Math.min(1, t / 0.25), env: (t) => (t < 0.08 ? t / 0.08 : Math.exp(-(t - 0.08) / 0.4)) });
      }
      // chest punch (audible on small speakers) + sub drop (shared, centred)
      const low = alloc(4.5, sr);
      tone(low, 0, sr, { f: 115, f1: 55, dur: 0.6, attack: 0.002, tau: 0.16, amp: 1 });
      tone(low, 0, sr, { f: 75, f1: 24, dur: 4.4, attack: 0.006, tau: 1.4, amp: 1.2 });
      addAt(ch[0], low, 0, 1); addAt(ch[1], low, 0, 1);
      // debris rain: metal panels, glass, chunks hitting the ground
      for (let k = 0; k < 110; k++) {
        const t = 0.2 + Math.pow(r(), 1.8) * 5;
        const a = Math.exp(-(t - 0.2) * 0.55) * r.range(0.1, 0.6);
        const dst = ch[r() < 0.5 ? 0 : 1];
        const at = Math.round(t * sr);
        const kind = r();
        if (kind < 0.4) ring(dst, at, metalModes(r, 3, 900, 6000, 0.03, 0.18), sr, Math.round(0.0008 * sr), () => r() * 2 - 1, 0.25, a * 0.55);
        else if (kind < 0.55) ring(dst, at, [[r.range(2500, 9000), 0.06, 1], [r.range(3000, 10000), 0.04, 0.6]], sr, Math.round(0.0005 * sr), () => r() * 2 - 1, 0.12, a * 0.35);
        else burst(dst, at, sr, r, { dur: r.range(0.006, 0.025), f: r.range(300, 1800), q: 0.9, amp: a * 1.0 });
      }
      // glue: gentle saturation makes it denser / louder at the same peak
      for (const c of ch) for (let i = 0; i < c.length; i++) c[i] = softclip(c[i] * 0.9);
      return finish(ch, sr, 0.97, 0.6);
    },
  },
  // non-positional low-frequency layer (LFE): played centred alongside the positional boom
  explosion_sub: {
    variants: 1,
    fn(sr, r) {
      const [c] = mono(4, sr);
      tone(c, 0, sr, { f: 62, f1: 22, dur: 3.9, attack: 0.008, tau: 1.3, amp: 1 });
      tone(c, 0, sr, { f: 120, f1: 60, dur: 0.5, attack: 0.002, tau: 0.12, amp: 0.6 });
      noiseLayer(c, 0, sr, r, { dur: 3.8, type: 'lowpass', f: 90, q: 0.7, amp: 1.6, gen: brownGen(r), env: (t) => (t < 0.01 ? t / 0.01 : Math.exp(-t / 1.1)) });
      return finish([c], sr, 0.95, 0.4);
    },
  },
  explosion_far: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(6, sr);
      const base = alloc(4, sr);
      const br = brownGen(r);
      noiseLayer(base, 0, sr, r, {
        dur: 4, type: 'lowpass', f: 300, q: 0.7, amp: 1.5, gen: br,
        env: (t) => (t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 0.9)),
      });
      tone(base, 0, sr, { f: 55, f1: 28, dur: 2.5, attack: 0.02, tau: 0.7, amp: 0.8 });
      const echoes = [[0, 1, 1], [0.27, 0.5, 0.35], [0.61, 0.32, 0.45], [1.02, 0.22, 0.2], [1.55, 0.14, 0.3]];
      for (const [t, g, pan] of echoes) {
        const lp = new OnePole(260 - t * 80, sr);
        const at = Math.round(t * sr);
        for (let i = 0; i < base.length && at + i < ch[0].length; i++) {
          const y = lp.lp(base[i]) * g;
          ch[0][at + i] += y * (1 - pan * 0.5);
          ch[1][at + i] += y * (0.5 + pan * 0.5);
        }
      }
      return finish(ch, sr, 0.9, 0.5);
    },
  },
  thunder_near: {
    variants: 2,
    fn(sr, r) {
      const ch = stereo(7, sr);
      for (let c = 0; c < 2; c++) {
        const out = ch[c];
        const rr = rng(Math.floor(r() * 1e9));
        burst(out, 0, sr, rr, { dur: 0.02, f: 800, q: 0.4, amp: 1.2, type: 'highpass' });
        // tearing crackle
        const n = 40;
        for (let k = 0; k < n; k++) {
          const t = Math.pow(rr(), 1.3) * 0.55;
          burst(out, Math.round(t * sr), sr, rr, { dur: rr.range(0.004, 0.03), f: rr.range(900, 5000), q: 0.6, amp: Math.exp(-t * 3) * rr.range(0.2, 0.9) });
        }
        // rumble swells
        const swells = [[0.05, 1, 0.9]];
        for (let k = 0; k < 4; k++) swells.push([rr.range(0.5, 4), rr.range(0.3, 0.8), rr.range(0.8, 1.6)]);
        const br = brownGen(rr);
        noiseLayer(out, 0, sr, rr, {
          dur: 7, type: 'lowpass', f: 260, q: 0.6, amp: 1.6, gen: br, fFn: (t) => 120 + 260 * Math.exp(-t / 1.2),
          env: (t) => { let e = 0; for (const [s0, a, d] of swells) if (t > s0) e += a * (t - s0 < 0.25 ? (t - s0) / 0.25 : Math.exp(-(t - s0 - 0.25) / d)); return e; },
        });
      }
      return finish(ch, sr, 0.95, 0.8);
    },
  },
  thunder_far: {
    variants: 2,
    fn(sr, r) {
      const ch = stereo(8, sr);
      for (let c = 0; c < 2; c++) {
        const rr = rng(Math.floor(r() * 1e9));
        const swells = [];
        for (let k = 0; k < 5; k++) swells.push([k === 0 ? 0 : rr.range(0.4, 5), rr.range(0.4, 1), rr.range(0.9, 1.8)]);
        const br = brownGen(rr);
        noiseLayer(ch[c], 0, sr, rr, {
          dur: 8, type: 'lowpass', f: 150, q: 0.6, amp: 1.6, gen: br,
          env: (t) => { let e = 0; for (const [s0, a, d] of swells) if (t > s0) e += a * (t - s0 < 0.6 ? (t - s0) / 0.6 : Math.exp(-(t - s0 - 0.6) / d)); return e; },
        });
      }
      return finish(ch, sr, 0.9, 1);
    },
  },

  // ----- pickups / UI -----
  money: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(1.4, sr);
      for (let c = 0; c < 2; c++) {
        const out = ch[c];
        burst(out, 0, sr, r, { dur: 0.003, f: 2500, q: 0.6, amp: 0.6, type: 'highpass' });
        thud(out, Math.round(0.02 * sr), sr, r, { f0: 160, f1: 90, tau: 0.04, amp: 0.25, noise: 0.5 });
        const bell = (f0, at, amp) => ring(out, Math.round(at * sr), [[f0, 0.9, 1], [f0 * 2.01, 0.6, 0.45], [f0 * 2.76, 0.45, 0.4], [f0 * 4.2, 0.28, 0.2], [f0 * 5.4, 0.2, 0.15]], sr, Math.round(0.0015 * sr), () => r() * 2 - 1, 1.2, amp);
        bell(2093 * (c ? 1.003 : 1), 0.055, 0.22);
        bell(2637 * (c ? 1.002 : 1), 0.17, 0.25);
      }
      for (let k = 0; k < 11; k++) {
        const f = r.range(3500, 7500);
        ring(ch[k % 2], Math.round(r.range(0.09, 0.5) * sr), [[f, r.range(0.04, 0.15), 1], [f * 1.48, 0.06, 0.5], [f * 2.3, 0.04, 0.3]], sr, Math.round(0.0005 * sr), () => r() * 2 - 1, 0.2, r.range(0.05, 0.14));
      }
      return finish(ch, sr, 0.8, 0.2);
    },
  },
  ui_hover: {
    variants: 1,
    fn(sr) {
      const [c] = mono(0.07, sr);
      tone(c, 0, sr, { f: 2400, dur: 0.07, attack: 0.001, tau: 0.012, amp: 0.8, harm: [0, 0.15] });
      return finish([c], sr, 0.5, 0.01);
    },
  },
  ui_click: {
    variants: 1,
    fn(sr, r) {
      const [c] = mono(0.14, sr);
      tone(c, 0, sr, { f: 950, f1: 1500, dur: 0.12, attack: 0.001, tau: 0.03, amp: 0.8, harm: [0.25, 0.1] });
      burst(c, 0, sr, r, { dur: 0.002, f: 4000, q: 0.6, amp: 0.4, type: 'highpass' });
      return finish([c], sr, 0.7, 0.02);
    },
  },
  ui_open: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(0.7, sr);
      for (let c = 0; c < 2; c++) {
        noiseLayer(ch[c], 0, sr, r, { dur: 0.3, f: 400, fEnd: 3200, q: 1.2, amp: 0.5, env: (t) => Math.sin(Math.PI * Math.min(1, t / 0.3)) });
        tone(ch[c], Math.round(0.05 * sr), sr, { f: 1318.5, dur: 0.6, attack: 0.002, tau: 0.18, amp: 0.4, harm: [0.2, 0.08] });
        tone(ch[c], Math.round((0.12 + c * 0.008) * sr), sr, { f: 1975.5, dur: 0.55, attack: 0.002, tau: 0.2, amp: 0.35, harm: [0.15] });
      }
      return finish(ch, sr, 0.7, 0.05);
    },
  },
  ui_close: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(0.5, sr);
      for (let c = 0; c < 2; c++) {
        noiseLayer(ch[c], 0, sr, r, { dur: 0.25, f: 3000, fEnd: 350, q: 1.2, amp: 0.5, env: (t) => Math.sin(Math.PI * Math.min(1, t / 0.25)) });
        tone(ch[c], Math.round(0.03 * sr), sr, { f: 987.8, f1: 940, dur: 0.4, attack: 0.002, tau: 0.12, amp: 0.4, harm: [0.2] });
      }
      return finish(ch, sr, 0.65, 0.05);
    },
  },
  ui_notify: {
    variants: 1,
    fn(sr) {
      const ch = stereo(0.95, sr);
      const fmBell = (out, at, f, amp) => {
        const n = Math.round(0.75 * sr);
        let pc = 0, pm = 0;
        for (let i = 0; i < n && at + i < out.length; i++) {
          const t = i / sr;
          pm += TAU * f * 3.5 / sr;
          pc += TAU * f / sr;
          const idx = 2.2 * Math.exp(-t / 0.08);
          const e = (t < 0.002 ? t / 0.002 : Math.exp(-t / 0.22));
          out[at + i] += Math.sin(pc + idx * Math.sin(pm)) * e * amp;
        }
      };
      fmBell(ch[0], 0, 1046.5, 0.5); fmBell(ch[1], Math.round(0.006 * sr), 1046.5, 0.45);
      fmBell(ch[0], Math.round(0.13 * sr), 1568, 0.45); fmBell(ch[1], Math.round(0.136 * sr), 1568, 0.5);
      return finish(ch, sr, 0.7, 0.1);
    },
  },
  wasted: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(6.5, sr);
      for (let c = 0; c < 2; c++) {
        const out = ch[c];
        thud(out, 0, sr, r, { f0: 70, f1: 34, tau: 0.9, amp: 1, noise: 1.2, lp: 380 });
        burst(out, 0, sr, r, { dur: 0.08, f: 700, q: 0.5, amp: 0.6 });
        noiseLayer(out, 0, sr, r, { dur: 2.2, f: 3200, fEnd: 140, q: 1.5, amp: 0.7, env: (t) => (t < 0.05 ? t / 0.05 : Math.exp(-(t - 0.05) / 0.9)) });
        // drone (fifths), slowly swelling
        const fs = [55, 82.4, 27.5, 110.2];
        const lp = new Biquad('lowpass', 380, 0.7, sr);
        const n = Math.round(6.2 * sr);
        const ph = fs.map(() => r() * TAU);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          let s = 0;
          for (let k = 0; k < fs.length; k++) {
            ph[k] += TAU * fs[k] * (1 + (c ? 0.003 : -0.003) * (k + 1)) / sr;
            const p = (ph[k] / TAU) % 1;
            s += (2 * p - 1) * (k === 2 ? 0.8 : 0.5);
          }
          const e = Math.min(1, t / 1.2) * (t > 4.6 ? Math.max(0, 1 - (t - 4.6) / 1.6) : 1);
          out[i] += lp.p(s) * e * 0.28;
        }
        for (const t of [1.7, 2.0, 3.2, 3.5]) thud(out, Math.round(t * sr), sr, r, { f0: 65, f1: 42, tau: 0.09, amp: t < 3 ? 0.55 : 0.35, noise: 0.6, lp: 200 });
      }
      return finish(ch, sr, 0.9, 0.3);
    },
  },
  respawn: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(2, sr);
      for (let c = 0; c < 2; c++) {
        noiseLayer(ch[c], 0, sr, r, { dur: 1.25, f: 180, fEnd: 4200, q: 1.3, amp: 0.6, env: (t) => Math.pow(t / 1.25, 2.2) * (t > 1.2 ? (1.25 - t) / 0.05 : 1) });
        [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => tone(ch[c], Math.round((0.95 + k * 0.03) * sr), sr, { f: f * (c ? 1.002 : 0.998), dur: 1, attack: 0.15, tau: 0.35, amp: 0.18 }));
      }
      return finish(ch, sr, 0.7, 0.2);
    },
  },
  timeskip: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(1.6, sr);
      for (let c = 0; c < 2; c++) {
        noiseLayer(ch[c], 0, sr, r, { dur: 1.5, f: 300, q: 0.9, amp: 0.6, fFn: (t) => 300 + 3000 * Math.sin(Math.PI * t / 1.5), env: (t) => Math.sin(Math.PI * t / 1.5) ** 2 });
        [0.15, 0.45, 0.68, 0.85, 0.97].forEach((t) => burst(ch[c], Math.round(t * sr), sr, r, { dur: 0.004, f: 3000, q: 3, amp: 0.4 }));
      }
      return finish(ch, sr, 0.65, 0.1);
    },
  },
  radio_static: {
    variants: 2,
    fn(sr, r) {
      const [c] = mono(0.5, sr);
      noiseLayer(c, 0, sr, r, { dur: 0.5, f: 2600, q: 0.5, amp: 0.6, env: (t) => Math.min(1, t / 0.01) * Math.min(1, (0.5 - t) / 0.08) * (0.7 + 0.3 * Math.sin(t * 90)) });
      tone(c, 0, sr, { f: 3200, f1: 1100, dur: 0.45, attack: 0.02, tau: 0.3, amp: 0.12 });
      for (let k = 0; k < 25; k++) burst(c, Math.round(r() * 0.45 * sr), sr, r, { dur: 0.001, f: 4000, q: 0.5, amp: r.range(0.2, 0.8), type: 'highpass' });
      return finish([c], sr, 0.6, 0.05);
    },
  },

  // ----- foley -----
  door_open: {
    variants: 2,
    fn(sr, r) {
      const [c] = mono(0.7, sr);
      ring(c, 0, [[r.range(1200, 1800), 0.03, 1], [r.range(2800, 3600), 0.02, 0.6]], sr, Math.round(0.001 * sr), () => r() * 2 - 1, 0.1, 0.5);
      ring(c, Math.round(0.016 * sr), [[r.range(1500, 2200), 0.025, 1], [4100, 0.015, 0.4]], sr, Math.round(0.001 * sr), () => r() * 2 - 1, 0.1, 0.4);
      thud(c, Math.round(0.06 * sr), sr, r, { f0: 180, f1: 110, tau: 0.03, amp: 0.4, noise: 0.8, lp: 600 });
      ring(c, Math.round(0.06 * sr), [[r.range(500, 800), 0.06, 1], [r.range(1100, 1500), 0.04, 0.6]], sr, Math.round(0.002 * sr), () => r() * 2 - 1, 0.2, 0.3);
      // short hinge creak
      const at = Math.round(0.13 * sr), n = Math.round(0.16 * sr);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += TAU * (650 + 180 * Math.sin(t * 28) + 120 * t / 0.16) / sr;
        const e = Math.sin(Math.PI * t / 0.16) * (0.6 + 0.4 * (r() < 0.3 ? 1 : 0));
        c[at + i] += (Math.sin(ph) + 0.4 * Math.sin(ph * 2.02)) * e * 0.06;
      }
      noiseLayer(c, Math.round(0.07 * sr), sr, r, { dur: 0.15, type: 'lowpass', f: 900, amp: 0.15, env: (t) => Math.exp(-t / 0.05) });
      return finish([c], sr, 0.7);
    },
  },
  door_close: {
    variants: 2,
    fn(sr, r) {
      const [c] = mono(0.55, sr);
      thud(c, 0, sr, r, { f0: 95, f1: 55, tau: 0.07, amp: 1, noise: 1.3, lp: 300 });
      ring(c, 0, metalModes(r, 5, 250, 1200, 0.04, 0.12), sr, Math.round(0.003 * sr), () => r() * 2 - 1, 0.3, 0.25);
      ring(c, Math.round(0.012 * sr), [[r.range(1800, 2600), 0.025, 1], [4800, 0.015, 0.5]], sr, Math.round(0.0008 * sr), () => r() * 2 - 1, 0.1, 0.45);
      ring(c, Math.round(0.02 * sr), [[r.range(3500, 5000), 0.05, 1], [6200, 0.03, 0.5]], sr, Math.round(0.0005 * sr), () => r() * 2 - 1, 0.1, 0.05);
      return finish([c], sr, 0.85);
    },
  },
  seatbelt: {
    variants: 1,
    fn(sr, r) {
      const [c] = mono(0.55, sr);
      noiseLayer(c, 0, sr, r, { dur: 0.25, f: 3000, q: 0.6, amp: 0.2, env: (t) => Math.sin(Math.PI * t / 0.25) * (0.6 + 0.4 * Math.sin(t * 160)) });
      for (const t of [0.27, 0.278]) ring(c, Math.round(t * sr), [[2600, 0.02, 1], [4150, 0.015, 0.7], [6100, 0.01, 0.5]], sr, Math.round(0.0005 * sr), () => r() * 2 - 1, 0.08, 0.6);
      return finish([c], sr, 0.6);
    },
  },
  bicycle_bell: {
    variants: 1,
    fn(sr, r) {
      const [c] = mono(1.5, sr);
      for (const t of [0, 0.13]) ring(c, Math.round(t * sr), [[3150, 1.1, 1], [4120, 0.7, 0.6], [6650, 0.4, 0.3], [8300, 0.25, 0.2]], sr, Math.round(0.001 * sr), () => r() * 2 - 1, 1.3, 0.4);
      return finish([c], sr, 0.7, 0.1);
    },
  },
  air_brake: {
    variants: 1,
    fn(sr, r) {
      const [c] = mono(1, sr);
      noiseLayer(c, 0, sr, r, { dur: 1, type: 'highpass', f: 2200, q: 0.5, amp: 0.8, env: (t) => (t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / 0.3)) });
      noiseLayer(c, 0, sr, r, { dur: 0.6, f: 5200, q: 2, amp: 0.4, env: (t) => Math.exp(-t / 0.15) });
      return finish([c], sr, 0.7, 0.05);
    },
  },
  bov: {
    variants: 2,
    fn(sr, r, v) {
      const [c] = mono(0.5, sr);
      noiseLayer(c, 0, sr, r, {
        dur: 0.5, f: 3600, fEnd: 850, q: 1.6, amp: 0.8,
        env: (t) => (t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / 0.13)) * (v ? 0.55 + 0.45 * Math.sign(Math.sin(TAU * 24 * t)) : 1),
      });
      return finish([c], sr, 0.7, 0.03);
    },
  },
  susp_thump: {
    variants: 3,
    fn(sr, r) {
      const [c] = mono(0.4, sr);
      thud(c, 0, sr, r, { f0: 70, f1: 45, tau: 0.07, amp: 1, noise: 1.1, lp: 260 });
      for (let k = 0; k < 4; k++) ring(c, Math.round(r.range(0, 0.08) * sr), metalModes(r, 3, 400, 2500, 0.02, 0.06), sr, Math.round(0.001 * sr), () => r() * 2 - 1, 0.1, 0.12);
      return finish([c], sr, 0.85);
    },
  },
  gear_clunk: {
    variants: 1,
    fn(sr, r) {
      const [c] = mono(0.15, sr);
      thud(c, 0, sr, r, { f0: 140, f1: 90, tau: 0.02, amp: 0.6, noise: 0.6, lp: 500 });
      ring(c, 0, [[820, 0.03, 1], [1630, 0.02, 0.5]], sr, Math.round(0.001 * sr), () => r() * 2 - 1, 0.1, 0.2);
      return finish([c], sr, 0.6, 0.02);
    },
  },
  brake_squeak: {
    variants: 1,
    fn(sr) {
      const [c] = mono(0.7, sr);
      tone(c, 0, sr, { f: 3150, f1: 3050, dur: 0.7, attack: 0.08, tau: 0.25, amp: 0.5, harm: [0.1], vib: 0.004, vibHz: 9 });
      return finish([c], sr, 0.4, 0.05);
    },
  },
  splash: {
    variants: 3,
    fn(sr, r, v) {
      const big = v / 2; // 0, 0.5, 1
      const ch = stereo(0.8 + big * 1.6, sr);
      for (let c = 0; c < 2; c++) {
        const out = ch[c];
        burst(out, 0, sr, r, { dur: 0.02 + big * 0.04, f: 600, q: 0.7, amp: 0.9 });
        noiseLayer(out, 0, sr, r, { dur: 0.4 + big * 1.1, type: 'lowpass', f: 1600, amp: 0.6, env: (t) => (t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / (0.1 + big * 0.35))) });
        noiseLayer(out, 0, sr, r, { dur: 0.6 + big * 1.4, type: 'highpass', f: 2600, amp: 0.3, env: (t) => (t < 0.02 ? t / 0.02 : Math.exp(-(t - 0.02) / (0.15 + big * 0.5))) });
        bubbles(out, Math.round(0.03 * sr), sr, r, { count: 15 + big * 50, dur: 0.4 + big * 1.0, fLo: 350 - big * 150, fHi: 1500 - big * 600, amp: 0.15 });
        if (big > 0.6) {
          thud(out, 0, sr, r, { f0: 80, f1: 45, tau: 0.15, amp: 0.7, noise: 1 });
          grains(out, Math.round(0.4 * sr), sr, r, { dur: 1.2, rate: 60, fLo: 1500, fHi: 6000, amp: 0.25, env: (t) => Math.exp(-t * 2) });
        }
      }
      return finish(ch, sr, 0.85, 0.1);
    },
  },
  lamp_break: {
    variants: 2,
    fn(sr, r) {
      const ch = stereo(1.8, sr);
      const pole = [[r.range(170, 200), 1.2, 1], [r.range(460, 500), 0.9, 0.7], [r.range(860, 930), 0.6, 0.5], [r.range(1400, 1500), 0.45, 0.4], [r.range(2150, 2300), 0.3, 0.25]];
      ring(ch[0], 0, pole, sr, Math.round(0.002 * sr), () => r() * 2 - 1, 1.5, 0.35);
      ring(ch[1], 0, pole, sr, Math.round(0.002 * sr), () => r() * 2 - 1, 1.5, 0.3);
      glassShatter(ch[0], Math.round(0.02 * sr), sr, r, 0.5, ch[1]);
      // electric zap
      for (let c = 0; c < 2; c++) {
        const at = Math.round(0.03 * sr), n = Math.round(0.3 * sr);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          ph += TAU * 120 / sr;
          const gate = r() < 0.5 + 0.4 * Math.sin(t * 70) ? 1 : 0.2;
          ch[c][at + i] += (Math.sign(Math.sin(ph)) * 0.3 + (r() * 2 - 1) * 0.5) * gate * Math.exp(-t / 0.08) * 0.25;
        }
      }
      thud(ch[0], Math.round(0.9 * sr), sr, r, { f0: 110, f1: 50, tau: 0.1, amp: 0.6 });
      thud(ch[1], Math.round(0.9 * sr), sr, r, { f0: 110, f1: 50, tau: 0.1, amp: 0.6 });
      ring(ch[1], Math.round(0.9 * sr), pole, sr, Math.round(0.002 * sr), () => r() * 2 - 1, 1, 0.12);
      return finish(ch, sr, 0.85, 0.1);
    },
  },
  tree_crack: {
    variants: 2,
    fn(sr, r) {
      const ch = stereo(2.4, sr);
      for (let c = 0; c < 2; c++) {
        woodCrack(ch[c], Math.round(c * 0.003 * sr), sr, r, 1);
        // splinter sequence
        for (let k = 0; k < 14; k++) {
          const t = 0.05 + Math.pow(r(), 0.7) * 0.6;
          woodCrack(ch[c], Math.round(t * sr), sr, r, 0.25);
        }
        // leaves rustle
        let a = 0;
        noiseLayer(ch[c], Math.round(0.15 * sr), sr, r, {
          dur: 1.6, f: 3200, q: 0.5, amp: 0.4,
          env: (t) => { a += (r() - 0.5) * 0.08; a *= 0.995; return Math.sin(Math.PI * Math.min(1, t / 1.6)) * (0.6 + Math.abs(a) * 4); },
        });
        thud(ch[c], Math.round(1.05 * sr), sr, r, { f0: 90, f1: 40, tau: 0.16, amp: 0.8, noise: 1.2 });
        noiseLayer(ch[c], Math.round(1.05 * sr), sr, r, { dur: 0.6, f: 2500, q: 0.5, amp: 0.4, env: (t) => Math.exp(-t / 0.15) });
      }
      return finish(ch, sr, 0.85, 0.1);
    },
  },
  collapse: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(6.5, sr);
      for (let c = 0; c < 2; c++) {
        const rr = rng(Math.floor(r() * 1e9));
        const out = ch[c];
        const br = brownGen(rr);
        const env = (t) => (t < 0.4 ? t / 0.4 : t < 3 ? 1 : Math.max(0, 1 - (t - 3) / 3.3));
        noiseLayer(out, 0, sr, rr, { dur: 6.4, type: 'lowpass', f: 140, amp: 1.6, gen: br, env });
        grains(out, 0, sr, rr, { dur: 5, rate: 180, fLo: 500, fHi: 4500, gHi: 0.012, amp: 0.4, env: (t) => env(t) * (0.5 + 0.5 * Math.sin(t * 3)) });
        for (let k = 0; k < 7; k++) thud(out, Math.round(rr.range(0.05, 3.6) * sr), sr, rr, { f0: 75, f1: 32, tau: 0.25, amp: rr.range(0.4, 0.9), noise: 1.2, lp: 300 });
        for (let k = 0; k < 2; k++) glassShatter(out, Math.round(rr.range(0.2, 2.5) * sr), sr, rr, 0.7);
        // rebar groan
        const at = Math.round(rr.range(0.5, 2) * sr), n = Math.round(1.5 * sr);
        let ph = 0;
        for (let i = 0; i < n && at + i < out.length; i++) {
          const t = i / sr;
          ph += TAU * (95 + 40 * Math.sin(t * 2.3) + 15 * Math.sin(t * 17)) / sr;
          out[at + i] += (Math.sin(ph) + 0.5 * Math.sin(ph * 2.7)) * Math.sin(Math.PI * t / 1.5) * 0.08;
        }
        noiseLayer(out, Math.round(1 * sr), sr, rr, { dur: 5, type: 'highpass', f: 2200, amp: 0.12, env: (t) => Math.min(1, t) * Math.exp(-t / 2) });
      }
      return finish(ch, sr, 0.95, 0.5);
    },
  },
  fire_whoosh: {
    variants: 1,
    fn(sr, r) {
      const ch = stereo(1.2, sr);
      for (let c = 0; c < 2; c++) {
        noiseLayer(ch[c], 0, sr, r, { dur: 1.1, f: 150, q: 0.9, amp: 0.9, fFn: (t) => 150 + 1700 * Math.min(1, t / 0.35), env: (t) => (t < 0.06 ? t / 0.06 : Math.exp(-(t - 0.06) / 0.35)) });
        noiseLayer(ch[c], 0, sr, r, { dur: 1.1, type: 'lowpass', f: 140, amp: 1.2, gen: brownGen(r), env: (t) => (t < 0.1 ? t / 0.1 : Math.exp(-(t - 0.1) / 0.4)) });
      }
      return finish(ch, sr, 0.85, 0.1);
    },
  },

  // ----- footsteps (mono, short) -----
  step_hard: { variants: 4, fn: (sr, r) => step(sr, r, 'hard') },
  step_grass: { variants: 4, fn: (sr, r) => step(sr, r, 'grass') },
  step_sand: { variants: 4, fn: (sr, r) => step(sr, r, 'sand') },
  step_gravel: { variants: 4, fn: (sr, r) => step(sr, r, 'gravel') },
  step_wood: { variants: 4, fn: (sr, r) => step(sr, r, 'wood') },
  step_metal: { variants: 4, fn: (sr, r) => step(sr, r, 'metal') },
  step_water: { variants: 4, fn: (sr, r) => step(sr, r, 'water') },

  // ----- animals -----
  bird: {
    variants: 6,
    fn(sr, r, v) {
      const [c] = mono(1.6, sr);
      if (v === 0 || v === 5) {
        const n = 3 + Math.floor(r() * 4);
        let t = 0;
        const hi = v === 5;
        for (let k = 0; k < n; k++) {
          const f0 = r.range(hi ? 5500 : 3200, hi ? 7000 : 4400), f1 = f0 * r.range(0.75, 1.35);
          const d = r.range(0.03, 0.08);
          tone(c, Math.round(t * sr), sr, { f: f0, f1, dur: d, attack: 0.005, tau: d * 0.6, amp: 0.5, harm: [0.05] });
          t += d + r.range(0.05, 0.12);
        }
      } else if (v === 1) {
        const n = Math.round(0.65 * sr), f0 = r.range(3800, 5200), rate = r.range(24, 38);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          ph += TAU * f0 * (1 - 0.12 * t) / sr;
          c[i] += Math.sin(ph) * Math.max(0, Math.sin(TAU * rate * t)) ** 2 * Math.sin(Math.PI * t / 0.65) * 0.6;
        }
      } else if (v === 2) {
        tone(c, 0, sr, { f: r.range(2700, 3100), dur: 0.22, attack: 0.02, tau: 0.15, amp: 0.5, vib: 0.01, vibHz: 30 });
        tone(c, Math.round(0.3 * sr), sr, { f: r.range(2100, 2400), dur: 0.3, attack: 0.02, tau: 0.2, amp: 0.45, vib: 0.008, vibHz: 28 });
      } else if (v === 3) {
        const n = Math.round(0.9 * sr);
        let ph = 0, f = r.range(3000, 4500), tgt = f;
        for (let i = 0; i < n; i++) {
          if (i % 900 === 0) tgt = r.range(2800, 5200);
          f += (tgt - f) * 0.004;
          ph += TAU * f / sr;
          const t = i / sr;
          c[i] += Math.sin(ph) * (0.5 + 0.5 * Math.sin(t * 60)) * Math.sin(Math.PI * t / 0.9) * 0.5;
        }
      } else {
        // dove coo: hoo-HOOO-hoo-hoo
        const f0 = r.range(480, 560);
        const notes = [[0, 0.22, 1], [0.32, 0.45, 1.12], [0.85, 0.22, 0.96], [1.15, 0.25, 0.94]];
        for (const [t, d, k] of notes) {
          const at = Math.round(t * sr), n = Math.round(d * sr);
          let ph = 0;
          for (let i = 0; i < n && at + i < c.length; i++) {
            const tt = i / sr;
            ph += TAU * f0 * k * (1 + 0.05 * Math.sin(Math.PI * tt / d)) / sr;
            const e = Math.sin(Math.PI * tt / d) ** 1.5;
            c[at + i] += (Math.sin(ph) + 0.15 * Math.sin(2 * ph)) * e * 0.5;
          }
        }
      }
      return finish([c], sr, 0.7, 0.05);
    },
  },
  seagull: {
    variants: 3,
    fn(sr, r, v) {
      const [c] = mono(1.8, sr);
      const calls = v === 2 ? 5 : 2 + Math.floor(r() * 2);
      let t = 0;
      for (let k = 0; k < calls; k++) {
        const d = v === 2 ? r.range(0.1, 0.14) : r.range(0.25, 0.4);
        const f0 = r.range(1000, 1300), f1 = f0 * (v === 2 ? 0.9 : r.range(0.6, 0.75));
        const at = Math.round(t * sr), n = Math.round(d * sr);
        const f1b = new Biquad('bandpass', 1900, 2, sr), f2b = new Biquad('bandpass', 3100, 3, sr);
        let ph = 0;
        for (let i = 0; i < n && at + i < c.length; i++) {
          const tt = i / sr;
          const f = f0 + (f1 - f0) * Math.pow(tt / d, 0.7);
          ph += TAU * f * (1 + 0.02 * Math.sin(tt * 190)) / sr;
          const p = (ph / TAU) % 1;
          const src = (2 * p - 1) * 0.6 + (r() * 2 - 1) * 0.25;
          const e = Math.min(1, tt / 0.015) * Math.pow(1 - tt / d, 0.6);
          c[at + i] += (f1b.p(src) * 1.4 + f2b.p(src)) * e;
        }
        t += d + (v === 2 ? r.range(0.03, 0.06) : r.range(0.1, 0.2));
      }
      return finish([c], sr, 0.7, 0.05);
    },
  },
  frog: {
    variants: 3,
    fn(sr, r, v) {
      const [c] = mono(1, sr);
      if (v === 0) {
        // bullfrog
        const n = Math.round(0.65 * sr), f0 = r.range(110, 150);
        const fa = new Biquad('bandpass', 280, 3, sr), fb = new Biquad('bandpass', 850, 4, sr);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          ph += TAU * f0 / sr;
          const p = (ph / TAU) % 1;
          const pulse = Math.exp(-p * 7);
          const e = Math.sin(Math.PI * t / 0.65) ** 0.6 * (0.6 + 0.4 * Math.sin(TAU * 11 * t));
          c[i] += (fa.p(pulse) * 2 + fb.p(pulse)) * e;
        }
      } else if (v === 1) {
        for (const t0 of [0, 0.28]) {
          const at = Math.round(t0 * sr), n = Math.round(0.14 * sr), f0 = r.range(620, 820);
          const fa = new Biquad('bandpass', f0 * 2, 4, sr);
          let ph = 0;
          for (let i = 0; i < n; i++) {
            const t = i / sr;
            ph += TAU * f0 / sr;
            const p = (ph / TAU) % 1;
            c[at + i] += (fa.p(2 * p - 1) * 1.5 + (2 * p - 1) * 0.2) * Math.sin(Math.PI * t / 0.14);
          }
        }
      } else {
        const n = Math.round(0.6 * sr), fc = r.range(2200, 2900);
        let pp = 0;
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          pp += (18 + 30 * t / 0.6) / sr;
          const pulse = Math.exp(-((pp % 1) * 12));
          c[i] += Math.sin(TAU * fc * t) * pulse * Math.sin(Math.PI * t / 0.6) * 0.6;
        }
      }
      return finish([c], sr, 0.7, 0.05);
    },
  },

  // ----- loops -----
  fire_loop: {
    variants: 1, loop: true,
    fn(sr, r) {
      return [0, 1].map((c) => {
        const rr = rng(Math.floor(r() * 1e9) + c);
        return loop(sr, Math.round(6 * sr), Math.round(0.4 * sr), (buf) => {
          const br = brownGen(rr);
          let fl = 0;
          noiseLayer(buf, 0, sr, rr, { dur: buf.length / sr, type: 'lowpass', f: 320, amp: 1.3, gen: br, env: () => { fl += (rr() - 0.5) * 0.004; fl *= 0.9995; return 0.75 + fl * 6; } });
          grains(buf, 0, sr, rr, { dur: buf.length / sr, rate: 22, fLo: 900, fHi: 5000, gLo: 0.001, gHi: 0.004, amp: 0.9 });
          grains(buf, 0, sr, rr, { dur: buf.length / sr, rate: 3, fLo: 300, fHi: 900, gLo: 0.005, gHi: 0.015, amp: 0.8 });
          noiseLayer(buf, 0, sr, rr, { dur: buf.length / sr, type: 'highpass', f: 4000, amp: 0.05, env: () => 1 });
        });
      }).map((b) => normalize([b], 0.6)[0]);
    },
  },
  scrape_loop: {
    variants: 1, loop: true,
    fn(sr, r) {
      const b = loop(sr, Math.round(2 * sr), Math.round(0.15 * sr), (buf) => {
        const mb = new ModeBank(metalModes(r, 7, 900, 4800, 0.015, 0.05), sr);
        const hp = new Biquad('highpass', 2500, 0.7, sr);
        for (let i = 0; i < buf.length; i++) {
          const x = r() < 0.18 ? (r() * 2 - 1) * r() : 0;
          buf[i] = mb.p(x) * 0.4 + hp.p(r() * 2 - 1) * 0.08;
        }
      });
      return normalize([b], 0.6);
    },
  },
  gravel_loop: {
    variants: 1, loop: true,
    fn(sr, r) {
      const b = loop(sr, Math.round(2 * sr), Math.round(0.1 * sr), (buf) => {
        grains(buf, 0, sr, r, { dur: buf.length / sr, rate: 700, fLo: 900, fHi: 6500, gLo: 0.0006, gHi: 0.003, amp: 0.9 });
        noiseLayer(buf, 0, sr, r, { dur: buf.length / sr, type: 'lowpass', f: 160, amp: 0.5, env: () => 1 });
      });
      return normalize([b], 0.6);
    },
  },
  grass_loop: {
    variants: 1, loop: true,
    fn(sr, r) {
      const b = loop(sr, Math.round(2 * sr), Math.round(0.15 * sr), (buf) => {
        let a = 0;
        noiseLayer(buf, 0, sr, r, { dur: buf.length / sr, f: 2600, q: 0.5, amp: 0.8, env: () => { a += (r() - 0.5) * 0.01; a *= 0.999; return 0.5 + Math.abs(a) * 8; } });
        grains(buf, 0, sr, r, { dur: buf.length / sr, rate: 250, fLo: 3500, fHi: 8000, gLo: 0.0005, gHi: 0.002, amp: 0.3 });
      });
      return normalize([b], 0.5);
    },
  },
  sand_loop: {
    variants: 1, loop: true,
    fn(sr, r) {
      const b = loop(sr, Math.round(2 * sr), Math.round(0.15 * sr), (buf) => {
        grains(buf, 0, sr, r, { dur: buf.length / sr, rate: 900, fLo: 500, fHi: 2200, gLo: 0.001, gHi: 0.004, amp: 0.6 });
        noiseLayer(buf, 0, sr, r, { dur: buf.length / sr, f: 1200, q: 0.5, amp: 0.25, env: () => 1 });
      });
      return normalize([b], 0.5);
    },
  },
  wet_loop: {
    variants: 1, loop: true,
    fn(sr, r) {
      const b = loop(sr, Math.round(2 * sr), Math.round(0.15 * sr), (buf) => {
        let a = 0;
        noiseLayer(buf, 0, sr, r, { dur: buf.length / sr, type: 'highpass', f: 1400, amp: 0.7, env: () => { a += (r() - 0.5) * 0.02; a *= 0.998; return 0.6 + Math.abs(a) * 5; } });
        grains(buf, 0, sr, r, { dur: buf.length / sr, rate: 400, fLo: 2500, fHi: 9000, gLo: 0.0005, gHi: 0.002, amp: 0.25 });
      });
      return normalize([b], 0.5);
    },
  },
  rain_light: {
    variants: 1, loop: true,
    fn(sr, r) {
      return normalize([0, 1].map(() => loop(sr, Math.round(4 * sr), Math.round(0.2 * sr), (buf) => {
        grains(buf, 0, sr, r, { dur: buf.length / sr, rate: 380, fLo: 1800, fHi: 7500, gLo: 0.0004, gHi: 0.0018, amp: 0.8 });
        noiseLayer(buf, 0, sr, r, { dur: buf.length / sr, f: 5200, q: 0.4, amp: 0.18, env: () => 1 });
      })), 0.55);
    },
  },
  rain_heavy: {
    variants: 1, loop: true,
    fn(sr, r) {
      return normalize([0, 1].map(() => loop(sr, Math.round(4 * sr), Math.round(0.2 * sr), (buf) => {
        const pk = pinkGen(r);
        noiseLayer(buf, 0, sr, r, { dur: buf.length / sr, f: 900, q: 0.35, amp: 0.9, gen: pk, env: () => 1 });
        grains(buf, 0, sr, r, { dur: buf.length / sr, rate: 1600, fLo: 1200, fHi: 8000, gLo: 0.0004, gHi: 0.0015, amp: 0.5 });
      })), 0.6);
    },
  },
  rain_roof: {
    variants: 1, loop: true,
    fn(sr, r) {
      return normalize([0, 1].map(() => loop(sr, Math.round(3 * sr), Math.round(0.15 * sr), (buf) => {
        const roof = new ModeBank([[210, 0.09, 1], [335, 0.07, 0.8], [520, 0.05, 0.7], [870, 0.04, 0.5], [1350, 0.03, 0.4], [2600, 0.02, 0.3]], sr);
        const hp = new Biquad('highpass', 3500, 0.7, sr);
        for (let i = 0; i < buf.length; i++) {
          const hit = r() < 220 / sr ? r() ** 2 * (r() < 0.5 ? -1 : 1) : 0;
          buf[i] = roof.p(hit) * 0.5 + hp.p(hit) * 0.8;
        }
      })), 0.55);
    },
  },
  waves: {
    variants: 1, loop: true,
    fn(sr, r) {
      const L = Math.round(16 * sr);
      return normalize([0, 1].map((c) => makeLoop(L, Math.round(1.2 * sr), (buf) => {
        const pk = pinkGen(r);
        const lp = new Biquad('lowpass', 400, 0.6, sr), hp = new Biquad('highpass', 1500, 0.6, sr);
        const waves = c ? [[0.6, 1], [8.7, 0.85]] : [[0.2, 0.9], [8.1, 1]];
        waves.push([16.2 + (c ? 0.6 : 0.2), c ? 1 : 0.9]);
        for (let i = 0; i < buf.length; i++) {
          const t = i / sr;
          if ((i & 63) === 0) {
            let surge = 0;
            for (const [w0, a] of waves) { const tt = t - w0; if (tt > -2 && tt < 6) surge = Math.max(surge, a * (tt < 0 ? (tt + 2) / 2 : Math.exp(-tt / 1.6))); }
            lp.set('lowpass', 250 + surge * 2200, 0.6);
          }
          let crash = 0, wash = 0, pre = 0;
          for (const [w0, a] of waves) {
            const tt = t - w0;
            if (tt > -2 && tt < 0) pre += a * ((tt + 2) / 2) ** 2;
            if (tt >= 0 && tt < 6) { crash += a * Math.exp(-tt / 0.7); wash += a * Math.min(1, tt / 0.4) * Math.exp(-tt / 2.4); }
          }
          const n = pk();
          buf[i] = lp.p(n) * (0.25 + pre * 0.5 + crash * 1.1) + hp.p(n) * (wash * 0.8 + 0.05);
        }
      })), 0.6);
    },
  },
  // distant city: a warm low rumble with slow traffic swells — no broadband hiss (detail comes from events)
  city_hum: {
    variants: 1, loop: true,
    fn(sr, r) {
      return normalize([0, 1].map(() => loop(sr, Math.round(12 * sr), Math.round(1.2 * sr), (buf) => {
        const br = brownGen(r), pk = pinkGen(r);
        const dur = buf.length / sr;
        // slow swells: distant traffic waves (several overlapping 3..7 s humps)
        const swells = [];
        for (let k = 0; k < 6; k++) swells.push([r() * dur, r.range(3, 7), r.range(0.3, 1)]);
        const sw = (t) => { let e = 0.55; for (const [c, w, a] of swells) { const x = (t - c) / w; if (Math.abs(x) < 1) e += a * 0.5 * (1 + Math.cos(Math.PI * x)); } return e; };
        noiseLayer(buf, 0, sr, r, { dur, type: 'lowpass', f: 170, q: 0.6, amp: 1.4, gen: br, env: sw });
        // tyre / engine murmur band, heavily low-passed
        const mur = new Float32Array(buf.length);
        noiseLayer(mur, 0, sr, r, { dur, f: 320, q: 0.7, amp: 0.35, gen: pk, env: sw });
        const lp = new Biquad('lowpass', 600, 0.7, sr);
        for (let i = 0; i < buf.length; i++) buf[i] += lp.p(mur[i]);
      })), 0.55);
    },
  },
  // a single car passing by a block away: engine hum + tyre rumble swell with a Doppler pitch drop
  far_passby: {
    variants: 3,
    fn(sr, r) {
      const dur = r.range(3.2, 4.5);
      const ch = stereo(dur, sr);
      const f0 = r.range(32, 48);
      const panDir = r() < 0.5 ? 1 : -1;
      const br = brownGen(r);
      const lpT = new Biquad('lowpass', 300, 0.7, sr), lpN = new Biquad('lowpass', 500, 0.7, sr), hpN = new Biquad('highpass', 120, 0.7, sr);
      let ph = 0;
      for (let i = 0; i < ch[0].length; i++) {
        const t = i / sr, u = t / dur;
        const env = Math.pow(Math.sin(Math.PI * u), 2.2);
        const dop = 1.06 - 0.12 * (0.5 + 0.5 * Math.tanh((u - 0.5) * 8));
        ph += 2 * Math.PI * f0 * dop / sr;
        const tone = Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.35 * Math.sin(3 * ph) + 0.2 * Math.sin(4.02 * ph);
        const x = lpT.p(tone) * 0.5 + lpN.p(hpN.p(br())) * 1.6;
        const p = Math.max(-1, Math.min(1, panDir * (u * 2 - 1)));
        ch[0][i] = x * env * (0.5 - 0.4 * p);
        ch[1][i] = x * env * (0.5 + 0.4 * p);
      }
      return finish(ch, sr, 0.8, 0.2);
    },
  },
  crickets: {
    variants: 1, loop: true,
    fn(sr, r) {
      const L = Math.round(6 * sr);
      return normalize([0, 1].map(() => {
        const buf = new Float32Array(L);
        for (let k = 0; k < 4; k++) {
          const fc = r.range(3900, 5200), period = 6 / Math.floor(r.range(5, 14)), syl = 2 + Math.floor(r() * 4), sylRate = r.range(25, 45);
          const amp = r.range(0.3, 1), off = r() * period;
          for (let i = 0; i < L; i++) {
            const t = i / sr;
            const pt = (t + off) % period;
            const chirpLen = syl / sylRate;
            if (pt > chirpLen) continue;
            const s = Math.sin(Math.PI * ((pt * sylRate) % 1));
            buf[i] += Math.sin(TAU * fc * t) * s * s * amp;
          }
        }
        return buf;
      }), 0.5);
    },
  },
  insects: {
    variants: 1, loop: true,
    fn(sr, r) {
      const L = Math.round(6 * sr);
      return normalize([0, 1].map(() => {
        const buf = new Float32Array(L);
        for (let k = 0; k < 3; k++) {
          const bp = new Biquad('bandpass', r.range(4200, 6500), 5, sr);
          const am = r.range(140, 230), swell = 6 / Math.floor(r.range(1, 4)), off = r() * swell;
          for (let i = 0; i < L; i++) {
            const t = i / sr;
            const sw = 0.5 - 0.5 * Math.cos(TAU * ((t + off) % swell) / swell);
            buf[i] += bp.p(r() * 2 - 1) * Math.max(0, Math.sin(TAU * am * t)) * sw * 3;
          }
        }
        return buf;
      }), 0.45);
    },
  },
  underwater: {
    variants: 1, loop: true,
    fn(sr, r) {
      return normalize([0, 1].map(() => loop(sr, Math.round(4 * sr), Math.round(0.3 * sr), (buf) => {
        noiseLayer(buf, 0, sr, r, { dur: buf.length / sr, type: 'lowpass', f: 140, amp: 1.5, gen: brownGen(r), env: () => 1 });
        bubbles(buf, 0, sr, r, { count: 14, dur: buf.length / sr, fLo: 180, fHi: 600, amp: 0.15 });
      })), 0.5);
    },
  },
};

// footsteps: heel + toe transients, surface coloured
function step(sr, r, kind) {
  const [c] = mono(0.32, sr);
  const toe = Math.round(r.range(0.025, 0.06) * sr);
  for (const [at, g] of [[0, 1], [toe, 0.55]]) {
    switch (kind) {
      case 'grass':
        noiseLayer(c, at, sr, r, { dur: 0.12, f: 2800, q: 0.5, amp: 0.6 * g, env: (t) => (t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) / 0.035)) });
        grains(c, at, sr, r, { dur: 0.08, rate: 400, fLo: 3000, fHi: 8000, amp: 0.25 * g });
        thud(c, at, sr, r, { f0: 80, f1: 60, tau: 0.02, amp: 0.15 * g });
        break;
      case 'sand':
        grains(c, at, sr, r, { dur: 0.09, rate: 900, fLo: 400, fHi: 1800, gHi: 0.004, amp: 0.6 * g, env: (t) => Math.exp(-t / 0.04) });
        thud(c, at, sr, r, { f0: 70, f1: 50, tau: 0.03, amp: 0.25 * g, noise: 1 });
        break;
      case 'gravel':
        grains(c, at, sr, r, { dur: 0.11, rate: 800, fLo: 1000, fHi: 6000, amp: 0.8 * g, env: (t) => Math.exp(-t / 0.04) });
        thud(c, at, sr, r, { f0: 90, f1: 60, tau: 0.025, amp: 0.3 * g });
        break;
      case 'wood':
        ring(c, at, [[r.range(160, 220), 0.08, 1], [r.range(420, 560), 0.05, 0.6], [r.range(1000, 1300), 0.03, 0.3]], sr, Math.round(0.002 * sr), () => r() * 2 - 1, 0.2, 0.6 * g);
        burst(c, at, sr, r, { dur: 0.004, f: 2500, q: 0.6, amp: 0.3 * g });
        break;
      case 'metal':
        ring(c, at, metalModes(r, 5, 350, 3200, 0.05, 0.18), sr, Math.round(0.0015 * sr), () => r() * 2 - 1, 0.25, 0.5 * g);
        thud(c, at, sr, r, { f0: 110, f1: 70, tau: 0.02, amp: 0.25 * g });
        break;
      case 'water':
        burst(c, at, sr, r, { dur: 0.02, f: 700, q: 0.6, amp: 0.6 * g });
        noiseLayer(c, at, sr, r, { dur: 0.15, type: 'highpass', f: 2500, amp: 0.3 * g, env: (t) => Math.exp(-t / 0.05) });
        bubbles(c, at, sr, r, { count: 6, dur: 0.12, fLo: 500, fHi: 1400, amp: 0.15 * g });
        break;
      default:
        burst(c, at, sr, r, { dur: 0.008, f: r.range(1300, 2400), q: 0.8, amp: 0.8 * g });
        thud(c, at, sr, r, { f0: 100, f1: 65, tau: 0.018, amp: 0.45 * g, noise: 0.5 });
        noiseLayer(c, at + Math.round(0.004 * sr), sr, r, { dur: 0.05, type: 'lowpass', f: 2500, amp: 0.12 * g, env: (t) => Math.exp(-t / 0.015) });
    }
  }
  return finish([c], sr, 0.85, 0.02);
}

export const BANK_NAMES = Object.keys(GENERATORS);

// render one bank item: returns array of variants, each an array of channel Float32Arrays
export function renderItem(name, sr, seed = 1) {
  const g = GENERATORS[name];
  if (!g) throw new Error(`unknown sound ${name}`);
  const out = [];
  for (let v = 0; v < g.variants; v++) {
    const r = rng(seed * 7919 + v * 104729 + name.length * 31 + name.charCodeAt(0));
    out.push(g.fn(sr, r, v).map((c) => softclipBuf(c)));
  }
  return out;
}

function softclipBuf(c) {
  for (let i = 0; i < c.length; i++) { const x = c[i]; if (x > 0.95 || x < -0.95) c[i] = softclip(x); }
  return c;
}

export { clamp };
