// Quality profiles, device tier auto-detection and runtime adaptation (workstream F).
// `game.quality` is ONE shared object: its fields are rewritten in place when the profile changes,
// so modules may keep a reference. Subscribe with `quality.onChange(fn)` to react to switches.

export const QUALITY_NAMES = ['low', 'medium', 'high', 'ultra']; // desktop ladder (auto downgrade walks it)
export const ALL_QUALITY_NAMES = ['mobile', ...QUALITY_NAMES];

// Budgets read by other modules. `pixelRatio` is resolved per device (see resolvePixelRatio).
// drawDistance: multiplier for view/stream distances (veg, traffic, terrain LOD); fogScale: fog density
// multiplier that hides the shorter view distance; maxFps: frame-rate target cap (display refresh caps it too).
export const QUALITY_PROFILES = {
  mobile: {
    maxPixelRatio: 1.5, prScale: 0.6, pixelBudget: 1.0e6, maxFps: 60,
    shadows: 1, shadowMapSize: 1024, shadowDistance: 70, cascades: 1,
    bloom: false, ao: false, ssr: false, godrays: false, lensFlare: false, lensDrops: true, motionBlur: false, grain: false,
    aa: 'none', reflections: 1, envSize: 64, envInterval: 3, clouds: 1,
    rainParticles: 2000, splashes: 120,
    vegRadius: 0.5, drawDistance: 0.55, fogScale: 1.6, trafficMax: 20, pedsMax: 40, debrisMax: 30, particlesMax: 1200,
  },
  low: {
    maxPixelRatio: 1, prScale: 0.75, pixelBudget: 0.9e6, maxFps: 240,
    shadows: 0, shadowMapSize: 1024, shadowDistance: 0, cascades: 0,
    bloom: false, ao: false, ssr: false, godrays: false, lensFlare: false, lensDrops: true, motionBlur: false, grain: false,
    aa: 'none', reflections: 1, envSize: 64, envInterval: 2.5, clouds: 1,
    rainParticles: 2500, splashes: 160,
    vegRadius: 0.6, drawDistance: 0.65, fogScale: 1.35, trafficMax: 24, pedsMax: 60, debrisMax: 40, particlesMax: 1500,
  },
  medium: {
    maxPixelRatio: 1, prScale: 1, pixelBudget: 1.7e6, maxFps: 240,
    shadows: 1, shadowMapSize: 1024, shadowDistance: 110, cascades: 1,
    bloom: true, ao: false, ssr: false, godrays: true, lensFlare: true, lensDrops: true, motionBlur: false, grain: false,
    aa: 'fxaa', reflections: 1, envSize: 64, envInterval: 1, clouds: 2,
    rainParticles: 6000, splashes: 400,
    vegRadius: 0.8, drawDistance: 0.8, fogScale: 1.1, trafficMax: 40, pedsMax: 110, debrisMax: 80, particlesMax: 4000,
  },
  high: {
    maxPixelRatio: 1.5, prScale: 1, pixelBudget: 3.0e6, maxFps: 240,
    shadows: 2, shadowMapSize: 2048, shadowDistance: 260, cascades: 2,
    bloom: true, ao: true, ssr: true, godrays: true, lensFlare: true, lensDrops: true, motionBlur: false, grain: true,
    aa: 'fxaa', reflections: 2, envSize: 128, envInterval: 0.5, clouds: 3,
    rainParticles: 12000, splashes: 900,
    vegRadius: 1, drawDistance: 1, fogScale: 1, trafficMax: 56, pedsMax: 170, debrisMax: 150, particlesMax: 8000,
  },
  ultra: {
    maxPixelRatio: 2, prScale: 1, pixelBudget: 5.5e6, maxFps: 240,
    shadows: 3, shadowMapSize: 3072, shadowDistance: 420, cascades: 2,
    bloom: true, ao: true, ssr: true, godrays: true, lensFlare: true, lensDrops: true, motionBlur: false, grain: true,
    aa: 'smaa', reflections: 2, envSize: 128, envInterval: 0.25, clouds: 3,
    rainParticles: 20000, splashes: 1500,
    vegRadius: 1.3, drawDistance: 1.25, fogScale: 1, trafficMax: 72, pedsMax: 240, debrisMax: 250, particlesMax: 16000,
  },
};

const TIER = { mobile: 0.5, low: 0, medium: 1, high: 2, ultra: 3 };

export function resolvePixelRatio(p, w = window.innerWidth, h = window.innerHeight) {
  const dpr = window.devicePixelRatio || 1;
  let pr = Math.min(dpr, p.maxPixelRatio) * p.prScale;
  const budget = Math.sqrt(p.pixelBudget / Math.max(1, w * h));
  return Math.max(0.5, Math.min(pr, budget));
}

// --- GPU string classification ------------------------------------------------------------
function tierFromGpuString(s) {
  if (!s) return null;
  const g = s.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|microsoft basic|software/.test(g)) return { tier: 0, software: true };
  // Apple silicon
  let m = g.match(/apple m(\d)\s*(pro|max|ultra)?/);
  if (m) {
    const gen = +m[1], v = m[2];
    if (v === 'max' || v === 'ultra') return { tier: 3 };
    if (v === 'pro') return { tier: gen >= 3 ? 3 : 2 };
    return { tier: gen >= 3 ? 2 : 1 };
  }
  if (/apple a1[5-9]|apple a[2-9]\d/.test(g)) return { tier: 1 };
  if (/apple/.test(g)) return { tier: 1 };
  // NVIDIA
  m = g.match(/rtx\s*(\d{4})/);
  if (m) {
    const n = +m[1], series = Math.floor(n / 1000), cls = n % 100;
    if (series >= 3 && cls >= 60) return { tier: 3 };
    if (series >= 4) return { tier: 3 };
    return { tier: 2 };
  }
  m = g.match(/gtx\s*(\d{3,4})/);
  if (m) {
    const n = +m[1];
    if (n >= 1660 || (n >= 1070 && n < 1100)) return { tier: 2 };
    if (n >= 1050 || (n >= 960 && n < 1000)) return { tier: 1 };
    return { tier: 0 };
  }
  if (/quadro|tesla|a\d{3,4}0?\b.*nvidia/.test(g)) return { tier: 2 };
  if (/mx\s*\d{3}/.test(g)) return { tier: 0 };
  // AMD
  m = g.match(/rx\s*(\d{3,4})/);
  if (m) {
    const n = +m[1];
    if (n >= 6800 || (n >= 7700 && n < 8000) || n >= 9000) return { tier: 3 };
    if (n >= 5600) return { tier: 2 };
    if (n >= 570) return { tier: 1 };
    return { tier: 0 };
  }
  if (/radeon.*(780m|880m|890m|8060s)/.test(g)) return { tier: 2 };
  if (/radeon.*(680m|760m|740m|vega)/.test(g)) return { tier: 1 };
  if (/radeon/.test(g)) return { tier: 1 };
  // Intel
  if (/arc\s*a?\d|arc\(tm\)|intel.*arc/.test(g)) return { tier: 2 };
  if (/iris\s*xe|iris\(r\)\s*xe/.test(g)) return { tier: 1 };
  if (/intel/.test(g)) return { tier: 0 };
  // Mobile
  m = g.match(/adreno.*?(\d{3})/);
  if (m) return { tier: +m[1] >= 730 ? 1 : 0 };
  if (/mali|powervr|videocore|tegra/.test(g)) return { tier: 0 };
  return null;
}

export function gpuInfo(gl) {
  let renderer = '', vendor = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) { renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''; vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || ''; }
    if (!renderer) renderer = gl.getParameter(gl.RENDERER) || '';
  } catch { /* ignore */ }
  return { renderer, vendor };
}

// Fragment-heavy micro benchmark (sync, ~20-80 ms once; result cached per GPU string).
// Returns a score ~ "heavy fullscreen passes per second at 1 MP".
export function gpuBenchmark(gl) {
  const vs = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const fs = `#version 300 es
    precision highp float; uniform float uT; out vec4 o;
    void main(){
      vec2 uv = gl_FragCoord.xy / 512.0; vec3 c = vec3(0.0);
      for (int i = 0; i < 24; i++) { float f = float(i); c += sin(vec3(uv.x * 9.1 + f, uv.y * 7.3 - f * 0.7, uT + f * 0.37)) * cos(uv.yxy * (f + 1.3)); uv = fract(uv * 1.71 + c.xy * 0.13); }
      o = vec4(c * 0.02 + 0.5, 1.0);
    }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const buf = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 512, 512);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, 512, 512);
  gl.useProgram(prog);
  const uT = gl.getUniformLocation(prog, 'uT');
  const px = new Uint8Array(4);
  const draw = (n) => { for (let i = 0; i < n; i++) { gl.uniform1f(uT, i * 0.1); gl.drawArrays(gl.TRIANGLES, 0, 3); } gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  const time = (k) => { const t0 = performance.now(); draw(k); return performance.now() - t0; };
  draw(2); time(4); // warm-up (compile, upload, driver latency)
  // slope between two batch sizes cancels the fixed readPixels round-trip latency
  let best = Infinity;
  for (let round = 0; round < 2; round++) {
    let n = 8, t1 = time(n), t2 = time(n * 2);
    while (t2 < 10 && n < 1024) { n *= 2; t1 = time(n); t2 = time(n * 2); }
    best = Math.min(best, Math.max((t2 - t1) / n, t2 / (n * 2) * 0.25, 1e-4));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
  gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteVertexArray(vao);
  gl.deleteProgram(prog); gl.deleteShader(v); gl.deleteShader(f);
  return (1000 / best) * (512 * 512 / 1e6); // heavy 0.26 MP passes per second, scaled to 1 MP
}

function tierFromScore(score) {
  // ≈ 2900 per FP32 TFLOP (Apple M3 Pro ≈ 20000). Ultra ≳ 6 TF, high ≳ 2.5 TF, medium ≳ 0.8 TF
  if (score > 17000) return 3;
  if (score > 7000) return 2;
  if (score > 2300) return 1;
  return 0;
}

// Full detection. `gl` is the game's WebGL2 context. Never throws.
export function detectQuality(gl, opts = {}) {
  const info = gl ? gpuInfo(gl) : { renderer: '', vendor: '' };
  const reasons = [];
  const byName = tierFromGpuString(info.renderer);
  let tier = byName ? byName.tier : 2;
  reasons.push(`gpu "${info.renderer || 'unknown'}" → ${byName ? QUALITY_NAMES[byName.tier] : 'unknown'}`);
  let score = null;
  if (gl && opts.benchmark !== false) {
    const key = `leonida.gpuBench2:${info.renderer}`;
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (cached && Date.now() - cached.t < 14 * 864e5) score = cached.score;
    } catch { /* ignore */ }
    // a page loading in a background tab gets a throttled, time-sliced GPU: the score would be several times too low
    // (an M3 Pro scored 552 = "low" instead of ~6600) and stay cached for two weeks. Measure only when visible.
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (score == null && !hidden) {
      try { score = gpuBenchmark(gl); } catch { score = null; }
      if (score != null) try { localStorage.setItem(key, JSON.stringify({ score, t: Date.now() })); } catch { /* ignore */ }
    } else if (score == null) reasons.push('page hidden: no benchmark');
    if (score != null) {
      const bt = tierFromScore(score);
      reasons.push(`bench ${Math.round(score)} → ${QUALITY_NAMES[bt]}`);
      // trust the benchmark more when the GPU string is unknown
      tier = byName ? Math.floor((byName.tier + bt) / 2 + 0.25) : bt;
    }
  }
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const mobile = /android|iphone|ipad|ipod|mobile/i.test(nav.userAgent || '') || (nav.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
  if (mobile) reasons.push('mobile/touch → mobile preset');
  if (nav.hardwareConcurrency && nav.hardwareConcurrency <= 4) { tier = Math.min(tier, 1); reasons.push(`${nav.hardwareConcurrency} cores → ≤medium`); }
  if (nav.deviceMemory && nav.deviceMemory <= 4) { tier = Math.min(tier, 1); reasons.push(`${nav.deviceMemory} GB → ≤medium`); }
  if (byName?.software) tier = 0;
  tier = Math.max(0, Math.min(3, tier));
  const name = mobile ? (tier === 0 && score != null && score < 1000 ? 'low' : 'mobile') : QUALITY_NAMES[tier];
  return { name, tier, gpu: info.renderer, score, mobile, reasons };
}

// The shared, mutable quality object (game.quality).
export function createQuality() {
  const listeners = new Set();
  const q = {
    name: 'high', auto: true, detected: null, pixelRatio: 1,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // name of the auto-detected preset for this device ('mobile'|'low'|'medium'|'high'|'ultra')
    detect() { return this.detected?.name || 'high'; },
    // info.runtime = true for automatic downgrades: listeners must then avoid anything that recompiles
    // shaders (lights, shadows, defines) and only adjust budgets.
    apply(name, auto = this.auto, info = {}) {
      const p = QUALITY_PROFILES[name] || QUALITY_PROFILES.high;
      Object.assign(this, p, { name, auto });
      this.pixelRatio = resolvePixelRatio(p);
      for (const fn of listeners) { try { fn(this, info); } catch (e) { console.error('[quality]', e); } }
      return this;
    },
  };
  Object.assign(q, QUALITY_PROFILES.high);
  return q;
}

// Runtime adaptation: dynamic resolution + one-way auto downgrade with hysteresis.
// The frame budget is 1/targetFps (display refresh, see Renderer). Resolution only goes down when that can help:
//  - CPU-bound frames (main-thread time of the loop near the budget) never lower it, and creep it back up;
//  - every step down is checked: if the frame time did not improve, the step is undone and the resolution is held
//    for a while (vertex / draw-call / driver bound, or a GPU timer inflated by other tabs: fewer pixels won't help).
// With the GPU timer (EXT_disjoint_timer_query_webgl2) it decides GPU-bound; without it the wall time does.
export class QualityGovernor {
  constructor() {
    this.samples = [];
    this.gpuSamples = [];
    this.cpuSamples = [];
    this._sorted = [];
    this.timer = 0;
    this.badTime = 0;
    this.cooldown = 12;
    this.downgrades = 0;
    this.maxDowngrades = 2;
    this.minScale = 0.6;
    this.hold = 0; // s: resolution changes did not help, keep the current scale
    this.trial = null; // { from, frame }: last step down, checked on the next window
    this.res = { scale: 1, downgrade: false, cpuBound: false, reason: '' };
  }

  _p80(a) {
    const s = this._sorted;
    s.length = 0;
    for (let i = 0; i < a.length; i++) s.push(a[i]);
    s.sort((x, y) => x - y);
    return s[Math.floor(s.length * 0.8)];
  }

  // dt: wall frame time (s); gpuMs: GPU time of a recent frame or null; cpuMs: main-thread time of the last loop
  // callback (ms) or null. Returns a reused result object.
  step(dt, gpuMs, scale, canDowngrade, targetFps = 60, cpuMs = null) {
    const res = this.res;
    res.scale = scale; res.downgrade = false;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    // throttled/hitched frames (hidden pane, tab switch, GC) are not a performance signal
    if (hidden || dt >= 0.099) return res;
    this.samples.push(dt);
    if (this.samples.length > 90) this.samples.shift();
    // GPU time longer than the frame itself means the GPU is time-sliced with other apps/tabs: ignore it
    if (gpuMs != null && gpuMs / 1000 < dt * 1.5) { this.gpuSamples.push(gpuMs / 1000); if (this.gpuSamples.length > 60) this.gpuSamples.shift(); }
    if (cpuMs != null && cpuMs > 0) { this.cpuSamples.push(cpuMs / 1000); if (this.cpuSamples.length > 90) this.cpuSamples.shift(); }
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.hold = Math.max(0, this.hold - dt);
    this.timer += dt;
    if (this.timer < 1.5 || this.samples.length < 30) return res;
    this.timer = 0;
    const budget = 1 / targetFps;
    const wall = this._p80(this.samples);
    const gpu = this.gpuSamples.length > 20 ? this._p80(this.gpuSamples) : null;
    const cpu = this.cpuSamples.length > 20 ? this._p80(this.cpuSamples) : null;
    const frame = gpu != null ? gpu : wall;
    // the main thread alone (update + draw submission) eats the budget: resolution is not the bottleneck
    // (and it is the limit: the GPU timer, or the wall time without one, is not much longer than the CPU time)
    const cpuBound = cpu != null && cpu > budget * 0.85 && (gpu != null ? gpu < cpu * 1.1 : wall < cpu * 1.3);
    res.cpuBound = cpuBound || (gpu != null && wall > budget * 1.12 && gpu < budget * 0.8);
    let ns = scale;
    // verdict on the previous step down: ~19 % fewer pixels must show in the frame time, else undo it and hold
    if (this.trial) {
      const t = this.trial;
      this.trial = null;
      if (frame > t.frame * 0.95) { ns = t.from; this.hold = 20; res.reason = 'resolution-insensitive'; }
    }
    if (ns === scale) {
      const over = gpu != null ? gpu > budget * 0.95 : wall > budget * 1.18;
      const under = gpu != null ? gpu < budget * 0.65 : wall < budget * 1.04;
      if (res.cpuBound) {
        if (ns < 1) ns += 0.05; // pixels are free while the CPU is the limit
        res.reason = 'cpu-bound';
      } else if (over && ns > this.minScale && this.hold <= 0) {
        this.trial = { from: ns, frame };
        ns -= 0.1;
        res.reason = 'gpu-bound';
      } else if (under && ns < 1) {
        ns += 0.05;
        res.reason = 'headroom';
      }
    }
    res.scale = Math.max(this.minScale, Math.min(1, ns));
    if (Math.abs(res.scale - scale) > 0.001) { this.samples.length = 0; this.gpuSamples.length = 0; this.cpuSamples.length = 0; }
    if (canDowngrade && !res.cpuBound && this.hold <= 0 && scale <= this.minScale + 0.01 && frame > budget * 1.35) this.badTime += 1.5;
    else this.badTime = Math.max(0, this.badTime - 1.5);
    if (this.badTime >= 9 && this.cooldown <= 0 && this.downgrades < this.maxDowngrades) {
      res.downgrade = true;
      this.downgrades++;
      this.badTime = 0;
      this.cooldown = 25;
      this.trial = null;
      this.samples.length = 0;
      this.gpuSamples.length = 0;
      this.cpuSamples.length = 0;
    }
    return res;
  }
}

export function lowerQuality(name) {
  if (name === 'mobile') return 'low';
  const i = QUALITY_NAMES.indexOf(name);
  return QUALITY_NAMES[Math.max(0, i - 1)];
}

export { TIER as QUALITY_TIER };
