// Tiny offline DSP toolkit (pure JS, no Web Audio) used to synthesise one-shot and loop buffers.
// Safe to run inside a Web Worker.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// deterministic PRNG
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => a + (b - a) * r();
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  r.bi = () => r() * 2 - 1;
  r.gauss = () => (r() + r() + r() + r() - 2) * 0.866;
  return r;
}

// RBJ biquad, transposed direct form II
export class Biquad {
  constructor(type = 'lowpass', f = 1000, q = 0.707, sr = 48000, gainDb = 0) {
    this.sr = sr;
    this.z1 = 0; this.z2 = 0;
    this.set(type, f, q, gainDb);
  }

  set(type, f, q = 0.707, gainDb = 0) {
    const w = TAU * clamp(f, 5, this.sr * 0.49) / this.sr;
    const cs = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / (2 * Math.max(q, 0.05));
    let b0, b1, b2, a0, a1, a2;
    const A = Math.pow(10, gainDb / 40);
    switch (type) {
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'notch': b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
      default: b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  p(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  run(buf, from = 0, to = buf.length) { for (let i = from; i < to; i++) buf[i] = this.p(buf[i]); return buf; }
}

export class OnePole {
  constructor(f = 1000, sr = 48000) { this.sr = sr; this.y = 0; this.set(f); }
  set(f) { this.k = 1 - Math.exp(-TAU * clamp(f, 1, this.sr * 0.49) / this.sr); return this; }
  lp(x) { return (this.y += this.k * (x - this.y)); }
  hp(x) { return x - this.lp(x); }
}

// pink noise (Paul Kellet, economy)
export function pinkGen(r) {
  let b0 = 0, b1 = 0, b2 = 0;
  return () => {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return (b0 + b1 + b2 + w * 0.1848) * 0.25;
  };
}

export function brownGen(r) {
  let b = 0;
  return () => {
    b = (b + 0.02 * (r() * 2 - 1)) / 1.02;
    return b * 3.5;
  };
}

// 2-pole resonator (modal synthesis). decay = T60-ish seconds.
export class Mode {
  constructor(f, decay, sr, amp = 1) {
    const r = Math.exp(-6.9 / (decay * sr));
    const w = TAU * clamp(f, 10, sr * 0.48) / sr;
    this.c1 = 2 * r * Math.cos(w);
    this.c2 = -r * r;
    this.g = amp * Math.sin(w);
    this.y1 = 0; this.y2 = 0;
  }
  p(x) {
    const y = this.c1 * this.y1 + this.c2 * this.y2 + x * this.g;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export class ModeBank {
  constructor(list, sr) { this.m = list.map(([f, d, a]) => new Mode(f, d, sr, a)); }
  p(x) { let s = 0; for (let i = 0; i < this.m.length; i++) s += this.m[i].p(x); return s; }
}

export const alloc = (sec, sr) => new Float32Array(Math.max(1, Math.round(sec * sr)));

export function softclip(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  return (x * (27 + x * x)) / (27 + 9 * x * x);
}

export function peak(buf) { let m = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; } return m; }

export function normalize(chs, target = 0.9) {
  let m = 0;
  for (const c of chs) m = Math.max(m, peak(c));
  if (m < 1e-9) return chs;
  const g = target / m;
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g;
  return chs;
}

export function fade(buf, sr, inSec = 0.002, outSec = 0.01) {
  const ni = Math.min(buf.length, Math.round(inSec * sr)), no = Math.min(buf.length, Math.round(outSec * sr));
  for (let i = 0; i < ni; i++) buf[i] *= i / ni;
  for (let i = 0; i < no; i++) buf[buf.length - 1 - i] *= i / no;
  return buf;
}

export function removeDC(buf, sr, f = 15) {
  const hp = new OnePole(f, sr);
  for (let i = 0; i < buf.length; i++) buf[i] = hp.hp(buf[i]);
  return buf;
}

// Make a buffer loop seamlessly: render `len + xf` samples with fn, then crossfade the tail into the head.
export function makeLoop(len, xf, fill, sr = 48000) {
  const tmp = new Float32Array(len + xf);
  fill(tmp);
  removeDC(tmp, sr, 12);
  const out = tmp.subarray(0, len);
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    const a = Math.sqrt(t), b = Math.sqrt(1 - t);
    out[i] = tmp[i] * a + tmp[len + i] * b;
  }
  return new Float32Array(out);
}

export function addAt(dst, src, at, gain = 1) {
  const n = Math.min(src.length, dst.length - at);
  for (let i = Math.max(0, -at); i < n; i++) dst[at + i] += src[i] * gain;
}

// exponential decay envelope value
export const expEnv = (t, tau) => (t < 0 ? 0 : Math.exp(-t / tau));
// attack-decay envelope: linear attack, exponential decay
export const adEnv = (t, a, tau) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / tau));
