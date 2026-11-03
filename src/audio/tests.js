// Offline render tests (OfflineAudioContext) + signal metrics. Used by lab-audio.html.
import { EngineVoice } from './engine/EngineVoice.js';
import { engineProcessorUrl, processorMain } from './engine/engineWorklet.js';
import { PROFILES } from './engine/profiles.js';
import { Mixer } from './core/Mixer.js';
import { Voice3D } from './core/Voice3D.js';

// ---------- metrics ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

export function centroidTrack(x, sr, N = 2048, hop = 1024) {
  const out = [];
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im);
    // c = energy (power-weighted) centroid; cm = magnitude-weighted (more sensitive to faint noise floors)
    let num = 0, den = 0, numM = 0, denM = 0;
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k], m = Math.sqrt(p), f = k * sr / N;
      num += p * f; den += p; numM += m * f; denM += m;
    }
    out.push({ t: (s + N / 2) / sr, c: den > 1e-12 ? num / den : 0, cm: denM > 1e-9 ? numM / denM : 0, e: den });
  }
  return out;
}

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

export function metrics(x, sr, { from = 0, to = x.length / sr, events = [] } = {}) {
  const a = Math.floor(from * sr), b = Math.min(x.length, Math.floor(to * sr));
  let sum = 0, sq = 0, pk = 0, clip = 0, nan = 0;
  for (let i = a; i < b; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) { nan++; continue; }
    sum += v; sq += v * v;
    const av = Math.abs(v);
    if (av > pk) pk = av;
    if (av >= 0.999) clip++;
  }
  const n = Math.max(1, b - a);
  const rms = Math.sqrt(sq / n);
  // first-difference statistics → discontinuities ("clicks")
  const d = new Float32Array(b - a - 1);
  for (let i = a + 1; i < b; i++) d[i - a - 1] = Math.abs(x[i] - x[i - 1]);
  const sorted = Float32Array.from(d).sort();
  const p999 = sorted[Math.floor(sorted.length * 0.999)] || 0;
  const maxD = sorted[sorted.length - 1] || 0;
  let evMax = 0;
  for (const t of events) {
    const i0 = Math.max(a + 1, Math.floor((t - 0.05) * sr)), i1 = Math.min(b, Math.floor((t + 0.08) * sr));
    for (let i = i0; i < i1; i++) evMax = Math.max(evMax, Math.abs(x[i] - x[i - 1]));
  }
  // baseline: median of per-window max |Δ| over all 130 ms windows (a click shows as eventMax ≫ baseline)
  const WW = Math.floor(0.13 * sr), wm = [];
  for (let i = a + 1; i + WW <= b; i += WW) { let m = 0; for (let k = 0; k < WW; k++) m = Math.max(m, Math.abs(x[i + k] - x[i + k - 1])); wm.push(m); }
  wm.sort((p, q) => p - q);
  const winMed = wm[Math.floor(wm.length / 2)] || 1e-6;
  // silence gaps (50 ms windows below -60 dBFS)
  let silent = 0;
  const W = Math.floor(0.05 * sr);
  for (let i = a; i + W <= b; i += W) {
    let s2 = 0;
    for (let k = 0; k < W; k++) s2 += x[i + k] * x[i + k];
    if (Math.sqrt(s2 / W) < 0.001) silent++;
  }
  return {
    rmsDb: +db(rms).toFixed(1), peakDb: +db(pk).toFixed(1), peak: +pk.toFixed(3), crestDb: +(db(pk) - db(rms)).toFixed(1),
    dc: +(sum / n).toExponential(1), clipped: clip, nan, silentWindows: silent,
    p999Delta: +p999.toFixed(4), maxDelta: +maxD.toFixed(4), eventMaxDelta: +evMax.toFixed(4),
    clickRatio: events.length ? +(evMax / Math.max(winMed, 1e-6)).toFixed(2) : null,
  };
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; dbb += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * dbb + 1e-12);
}

// ---------- offline engine render ----------
const quant = (t, sr) => Math.round(t * sr / 128) * 128 / sr;

// script(t) → telemetry. Frames are applied with ctx.suspend() so the real update() path runs.
export async function renderEngine(profile, { seconds = 6, sr = 48000, fps = 30, script, overrides } = {}) {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * sr), sr);
  await ctx.audioWorklet.addModule(engineProcessorUrl());
  const sys = { ctx, voices: new Set(), workletReady: true, slowmo: 1, bank: null, mixer: { bus: { engine: ctx.destination } }, onWorklet() {} };
  const ev = new EngineVoice(sys, profile, { spatial: false, destination: ctx.destination, overrides });
  const used = new Set();
  const dt = 1 / fps;
  const telLog = [];
  for (let i = 0; i < seconds * fps; i++) {
    const t = quant(i * dt, sr);
    if (used.has(t) || t >= seconds) continue;
    used.add(t);
    ctx.suspend(t).then(() => { const tel = script(t); telLog.push({ t, rpm: tel.rpm ?? 0 }); ev.update(tel, dt); ctx.resume(); });
  }
  const buf = await ctx.startRendering();
  return { x: buf.getChannelData(0), sr, telLog };
}

// standard drive cycle: idle → full-throttle pulls through 3 gears (auto shifts) → limiter → lift-off (overrun) → idle
export function driveCycle(cfg) {
  const idle = cfg.idle || 800, max = cfg.max || 7000;
  const shifts = [];
  let gear = 1, shiftId = 0, lastShift = -1;
  const fn = (t) => {
    let rpm, thr, load, limiter = false, shifting = false;
    if (t < 0.8) { rpm = idle; thr = 0; load = 0.05; }
    else if (t < 4.2) {
      // pulls: rpm rises from 0.35*max to max within each gear; ratios drop rpm by 30% on shifts
      const u = t - 0.8, per = 1.1;
      const g = Math.min(3, Math.floor(u / per) + 1);
      const k = (u % per) / per;
      if (g !== gear) { gear = g; shiftId++; lastShift = t; shifts.push(t); }
      shifting = t - lastShift < 0.12 && lastShift > 0;
      rpm = (g === 1 ? idle + (max * 0.95 - idle) * k : max * (0.66 + 0.29 * k));
      thr = 1; load = shifting ? 0 : 0.95;
      if (g === 3 && k > 0.7) { rpm = max * 1.0; limiter = true; }
    } else if (t < 5.2) { rpm = max * 0.9 - (t - 4.2) * max * 0.35; thr = 0; load = 0; }
    else { rpm = Math.max(idle, max * 0.55 - (t - 5.2) * max * 0.5); thr = 0; load = 0.05; }
    return { rpm, maxRpm: max, throttle: thr, engineLoad: load, gear, shiftId, shifting, limiter, speedKmh: rpm / max * 120 };
  };
  fn.shifts = shifts;
  return fn;
}

export async function engineReport(profile, opts = {}) {
  const cfg = PROFILES[profile];
  let script;
  if (cfg.mode === 'turbine' || cfg.mode === 'rotor') {
    script = (t) => ({ throttle: t < 1.5 ? 0.2 : t < 4 ? 1 : 0.3, speedKmh: 100, collective: t < 4 ? 0.8 : 0.3 });
  } else if (cfg.mode === 'bike') {
    script = (t) => ({ throttle: t > 1 && t < 3.5 ? 1 : 0, speedKmh: Math.min(30, t * 10) });
  } else if (cfg.mode === 'ev') {
    script = (t) => { const s = t < 1 ? 0 : t < 4 ? (t - 1) * 45 : Math.max(0, 135 - (t - 4) * 60); return { throttle: t > 1 && t < 4 ? 1 : 0, speedKmh: s, engineLoad: t > 1 && t < 4 ? 0.9 : 0, brake: t > 4 ? 0.5 : 0 }; };
  } else script = driveCycle(cfg);
  const seconds = opts.seconds ?? 6;
  const r = await renderEngine(profile, { seconds, script, overrides: opts.overrides });
  const m = metrics(r.x, r.sr, { from: 0.3, events: script.shifts || [] });
  // spectral centroid vs rpm (ICE only, throttle-on region)
  let corr = null, maxJump = 0;
  const tr = centroidTrack(r.x, r.sr);
  for (let i = 1; i < tr.length; i++) {
    if (cfg.mode === 'ice' && (tr[i].t < 1 || tr[i].t > 3.6)) continue;
    if (tr[i].e > 1 && tr[i - 1].e > 1) maxJump = Math.max(maxJump, Math.abs(Math.log2(tr[i].c / tr[i - 1].c)));
  }
  if (cfg.mode === 'ice') {
    const pts = tr.filter((p) => p.t > 1 && p.t < 4.2);
    const rpmAt = (t) => { let best = r.telLog[0]; for (const e of r.telLog) if (e.t <= t) best = e; return best.rpm; };
    const rpms = pts.map((p) => rpmAt(p.t));
    corr = pearson(pts.map((p) => p.c), rpms);
  }
  return { profile, ...m, centroidHz: Math.round(tr.reduce((s, p) => s + p.c, 0) / tr.length), centroidRpmCorr: corr === null ? null : +corr.toFixed(2), maxCentroidJumpOct: +maxJump.toFixed(2), x: r.x, sr: r.sr };
}

// spatial check: source passes the listener left→right at 30 m/s, 5 m lateral offset (Doppler + panning)
export async function spatialReport({ seconds = 4, sr = 48000 } = {}) {
  const ctx = new OfflineAudioContext(2, seconds * sr, sr);
  const sys = { ctx, voices: new Set(), hrtf: true, mixer: null };
  sys.mixer = new Mixer(ctx);
  sys.mixer.setVolume('master', 1);
  const v = new Voice3D(sys, { bus: sys.mixer.bus.sfx, ref: 5, reverb: 0 });
  const o = ctx.createOscillator();
  o.frequency.value = 440;
  o.connect(v.input);
  o.start();
  const L = { x: 0, y: 0, z: 0 };
  const fps = 60, dt = 1 / fps;
  const used = new Set();
  for (let i = 0; i < seconds * fps; i++) {
    const t = quant(i * dt, sr);
    if (used.has(t) || t >= seconds) continue;
    used.add(t);
    ctx.suspend(t).then(() => { v.setPosition(-60 + 30 * t, 0, -5); v.update(dt, L, 0); ctx.resume(); });
  }
  const buf = await ctx.startRendering();
  const Lc = buf.getChannelData(0), Rc = buf.getChannelData(1);
  const seg = (ch, t0, t1) => { let s = 0; const a = Math.floor(t0 * sr), b = Math.floor(t1 * sr); for (let i = a; i < b; i++) s += ch[i] * ch[i]; return Math.sqrt(s / (b - a)); };
  // zero-crossing pitch estimate
  const pitch = (ch, t0, t1) => { let zc = 0; const a = Math.floor(t0 * sr), b = Math.floor(t1 * sr); for (let i = a + 1; i < b; i++) if (ch[i - 1] < 0 && ch[i] >= 0) zc++; return zc / (t1 - t0); };
  const mono = new Float32Array(Lc.length);
  for (let i = 0; i < mono.length; i++) mono[i] = Lc[i] + Rc[i];
  return {
    leftBias_approach: +(db(seg(Lc, 0.6, 1.2)) - db(seg(Rc, 0.6, 1.2))).toFixed(1),
    leftBias_depart: +(db(seg(Lc, 2.8, 3.4)) - db(seg(Rc, 2.8, 3.4))).toFixed(1),
    pitchApproachHz: Math.round(pitch(mono, 0.6, 1.4)), pitchDepartHz: Math.round(pitch(mono, 2.6, 3.4)),
    expectedApproachHz: Math.round(440 / (1 - 30 / 343 * 0.99)), expectedDepartHz: Math.round(440 / (1 + 30 / 343 * 0.99)),
    levelNearDb: +db(seg(mono, 1.9, 2.1)).toFixed(1), levelFarDb: +db(seg(mono, 0.1, 0.3)).toFixed(1),
  };
}

// audio-thread cost estimate: render 10 s offline and compare wall time to real time
export async function perfReport({ seconds = 10, sr = 48000 } = {}) {
  const out = {};
  const time = async (label, build, ch = 2) => {
    const ctx = new OfflineAudioContext(ch, seconds * sr, sr);
    await ctx.audioWorklet.addModule(engineProcessorUrl());
    await build(ctx);
    const t0 = performance.now();
    await ctx.startRendering();
    const ms = performance.now() - t0;
    out[label] = { renderMs: Math.round(ms), pctOfRealtime: +(ms / (seconds * 10)).toFixed(2) };
  };
  const engine = (ctx, profile, dest, lite = false) => {
    const n = new AudioWorkletNode(ctx, 'ld-engine', { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { cfg: { ...PROFILES[profile], lite, ...(lite ? { mech: 0 } : {}) } } });
    const p = (k) => n.parameters.get(k);
    p('rpm').value = (PROFILES[profile].idle + PROFILES[profile].max) / 2; p('throttle').value = 0.7; p('load').value = 0.7; p('gain').value = 0.3; p('turbo').value = 0.5;
    n.connect(dest);
    return n;
  };
  await time('baseline (empty graph)', (ctx) => { const o = ctx.createConstantSource(); o.connect(ctx.destination); o.start(); });
  await time('1 engine (v8 worklet)', (ctx) => { engine(ctx, 'v8', ctx.destination); });
  await time('8 engines full', (ctx) => { for (let i = 0; i < 8; i++) engine(ctx, ['v8', 'v6', 'i4', 'v12'][i % 4], ctx.destination); });
  await time('1 player + 7 lite traffic engines', (ctx) => { for (let i = 0; i < 8; i++) engine(ctx, ['v8', 'v6', 'i4', 'v12'][i % 4], ctx.destination, i > 0); });
  await time('urban reverb convolver', (ctx) => { const m = new Mixer(ctx); m.setVolume('master', 1); m.setEnvironment('urban', 0.01); const o = ctx.createOscillator(); o.connect(m.reverbIn); o.start(); });
  await time('16 HRTF panners (noise)', (ctx) => {
    const b = ctx.createBuffer(1, sr, sr); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    for (let i = 0; i < 16; i++) { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.positionX.value = Math.cos(i) * 10; p.positionZ.value = Math.sin(i) * 10; s.connect(p).connect(ctx.destination); s.start(); }
  });
  await time('full mix (1+7 lite engines, 16 HRTF voices w/ doppler, reverb, comp+limiter)', (ctx) => {
    const sys = { ctx, voices: new Set(), hrtf: true, mixer: new Mixer(ctx) };
    sys.mixer.setVolume('master', 1);
    sys.mixer.setEnvironment('urban', 0.01);
    for (let i = 0; i < 16; i++) {
      const v = new Voice3D(sys, { bus: sys.mixer.bus.engine, ref: 6, reverb: 0.3 });
      v.setPosition(Math.cos(i) * 20, 0, Math.sin(i) * 20);
      v.update(0, { x: 0, y: 0, z: 0 }, ctx.currentTime || 1e-6);
      if (i < 8) engine(ctx, ['v8', 'v6', 'i4', 'v12'][i % 4], v.input, i > 0);
      else { const o = ctx.createOscillator(); o.connect(v.input); o.start(); }
    }
  });
  return out;
}

// radio: render each station offline through the real scheduler (suspend-stepped at 20 Hz)
export async function radioReport({ seconds = 20, sr = 48000 } = {}) {
  const { Radio } = await import('./radio/Radio.js');
  const out = {};
  for (let i = 0; i < 3; i++) {
    const ctx = new OfflineAudioContext(2, seconds * sr, sr);
    const noise = ctx.createBuffer(1, sr * 2, sr);
    const d = noise.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * 0.7;
    const sys = { ctx, interior: 1, game: { settings: { radioStation: i } }, bank: { noise: { white: noise }, get: () => null, has: () => false }, mixer: { bus: { music: ctx.destination } } };
    const radio = new Radio(sys);
    radio.forceOn = true;
    const used = new Set();
    for (let k = 0; k < seconds * 20; k++) {
      const t = Math.round(k * 0.05 * sr / 128) * 128 / sr;
      if (used.has(t) || t >= seconds) continue;
      used.add(t);
      ctx.suspend(t).then(() => { radio.update(0.05); radio.tick(); ctx.resume(); });
    }
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0);
    const m = metrics(L, sr, { from: 2 });
    const c = radio.cursor;
    out[radio.stationName] = { rmsDb: m.rmsDb, peakDb: m.peakDb, clipped: m.clipped, silentWindows: m.silentWindows, bpm: c?.seg.song.bpm, section: c?.seg.song.bars[Math.floor(c.idx / 16)]?.sec };
  }
  return out;
}

// deterministic CPU cost of the engine processor: run process() on the main thread (same V8 JIT as the
// audio thread), min of several runs → robust against machine load. 100 % = one core fully busy in real time.
export function benchEngines(profiles = ['v8', 'i4', 'v12', 'diesel', 'electric', 'jet', 'heli', 'bicycle'], { blocks = 4000, runs = 5 } = {}) {
  let Cls = null;
  class Base { constructor() { this.port = { onmessage: null, postMessage() {} }; } }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', `(${processorMain.toString()})();`)(Base, (n, c) => { Cls = c; }, 48000);
  const blockMs = 128 / 48000 * 1000;
  const res = {};
  const run = (label, cfg) => {
    const proc = new Cls({ processorOptions: { cfg } });
    const params = {};
    for (const d of Cls.parameterDescriptors) params[d.name] = new Float32Array([d.defaultValue]);
    params.rpm[0] = cfg.mode === 'turbine' ? 7000 : cfg.mode === 'rotor' ? 380 : ((cfg.idle || 800) + (cfg.max || 7000)) / 2;
    params.throttle[0] = 0.7; params.load[0] = 0.7; params.gain[0] = 0.3; params.turbo[0] = 0.5; params.speed[0] = 15;
    const out = [[new Float32Array(128)]];
    for (let i = 0; i < 800; i++) proc.process([], out, params);
    let best = Infinity;
    for (let k = 0; k < runs; k++) {
      const t0 = performance.now();
      for (let i = 0; i < blocks; i++) proc.process([], out, params);
      best = Math.min(best, performance.now() - t0);
    }
    res[label] = { usPerBlock: +(best * 1000 / blocks).toFixed(1), pctOfCore: +((best / blocks) / blockMs * 100).toFixed(2) };
  };
  for (const p of profiles) run(p, PROFILES[p]);
  run('v8 lite (traffic)', { ...PROFILES.v8, lite: true, mech: 0, crackle: 0 });
  return res;
}
