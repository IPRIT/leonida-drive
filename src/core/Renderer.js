import * as THREE from 'three';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { createQuality, detectQuality, resolvePixelRatio, QualityGovernor, lowerQuality, QUALITY_PROFILES, QUALITY_NAMES } from './quality.js';
import { GpuTimer } from '../weather/post/GpuTimer.js';
import { antialiasingModes, clampRenderScale, renderSize } from './renderSettings.js';
import { Bloom } from '../weather/post/Bloom.js';
import { FS_VERT, AO_FRAG, AO_BLUR_FRAG, SSR_FRAG, RAYS_FRAG, SUNVIS_FRAG, COMPOSITE_FRAG, FINAL_FRAG } from '../weather/post/shaders.js';

// Rendering + post pipeline (workstream F):
//   scene (HDR, depth texture, colour alpha = SSR mirror mask)
//   → [AO ½] [SSR ½] [god rays ¼] [sun visibility 1×1]
//   → composite (AO, SSR, rays, direction-aware fog, ground mist, underwater)
//   → bloom → final (lens drops, flare, motion blur, ACES, grade, vignette, grain, wasted/fade)
//   → SMAA / FXAA → screen
// Every stage is toggled by the quality profile (src/core/quality.js) or `render.effects`.

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1);
const smooth = THREE.MathUtils.smoothstep;

// Shadow pass: every caster is drawn with one shared depth material, and three re-picks its shader program only now
// and then (after an instanced caster or an alpha-tested one), from the caster drawn next: with or without a colour
// map, with or without normals. Which caster that is depends on the draw order (a shadow proxy or a newly spawned
// vehicle changes it), so a map / no-normals variant could compile mid-game (tank tracks: 40-55 ms). One instanced
// box before each of the four variants makes prewarmDraw compile all of them at load.
function shadowDepthProbes() {
  const g = new THREE.Group();
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  const boxN = new THREE.BoxGeometry(1, 1, 1);
  const box0 = boxN.clone();
  box0.deleteAttribute('normal');
  const plain = new THREE.MeshBasicMaterial(), mapped = new THREE.MeshBasicMaterial({ map: tex });
  for (const [geo, mat] of [[boxN, mapped], [box0, mapped], [box0, plain], [boxN, plain]]) {
    const inst = new THREE.InstancedMesh(boxN, plain, 1);
    inst.setMatrixAt(0, _m.identity());
    g.add(inst, new THREE.Mesh(geo, mat));
  }
  g.traverse((o) => { o.castShadow = true; o.frustumCulled = false; });
  g.userData.dispose = () => {
    for (const c of g.children) if (c.isInstancedMesh) c.dispose();
    boxN.dispose(); box0.dispose(); plain.dispose(); mapped.dispose(); tex.dispose();
  };
  return g;
}

function fsMaterial(frag, uniforms, defines = {}) {
  return new THREE.ShaderMaterial({ uniforms, defines, vertexShader: FS_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
}

function rt(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...opts });
}

export class Renderer {
  constructor(container) {
    const probe = document.createElement('canvas').getContext('webgl2');
    const clip = !!probe?.getExtension('EXT_clip_control');
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: clip, stencil: false });
    this.reversed = clip;
    const r = this.renderer;
    r.toneMapping = THREE.NoToneMapping; // ACES is applied in the final pass (one program variant per target)
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(r.domElement);
    r.domElement.id = 'game-canvas';
    const gl = r.getContext();
    this.maxRenderDimension = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    try {
      const color = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
      const depth = gl.getInternalformatParameter(gl.RENDERBUFFER, clip ? gl.DEPTH_COMPONENT32F : gl.DEPTH_COMPONENT24, gl.SAMPLES);
      this.msaaSamples = [...color].filter((n) => [...depth].includes(n));
    } catch { this.msaaSamples = []; }
    this.antialiasing = 'auto';
    this.manualScale = 1;
    this.gpu = new GpuTimer(gl);
    // remember the game loop callback (labs/tools drive it manually when the page is hidden)
    // and time its CPU cost (update + render submission) for stats()
    const setLoop = r.setAnimationLoop.bind(r);
    r.setAnimationLoop = (cb) => {
      this.loopCallback = cb;
      return setLoop(cb && ((t, f) => { const t0 = performance.now(); cb(t, f); this._cpuMs = performance.now() - t0; }));
    };

    // ---- quality: auto-detect now (budgets must be known before the world is built)
    this.profile = createQuality();
    let det;
    try { det = detectQuality(gl); } catch (e) { det = { name: 'high', reasons: [String(e)] }; }
    this.detected = det;
    this.profile.detected = det;
    this.profile.apply(det.name, true);
    r.leonidaQuality = this.profile; // Sky / Water pick it up from the three renderer
    r.leonidaPinPrograms = () => this.pinPrograms(); // side renders (vehicle studio) keep their programs too
    this.quality = det.name; // legacy: name string
    this.governor = new QualityGovernor();
    this.basePR = this.profile.pixelRatio;
    this.scale = 1;
    this.autoRes = true;
    r.setPixelRatio(this.basePR);
    r.setSize(window.innerWidth, window.innerHeight);

    // effect switches (lab toggles); combined with the profile in _config()
    this.effects = { bloom: true, ao: true, ssr: true, godrays: true, flare: true, lens: true, motionBlur: true, grain: true, aa: true, fog: true };

    // ---- targets
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.sceneRT.depthTexture = new THREE.DepthTexture(size.x, size.y, clip ? THREE.FloatType : THREE.UnsignedIntType);
    this.hdrRT = rt(size.x, size.y, { type: THREE.HalfFloatType });
    this.ldrRT = rt(size.x, size.y, { type: THREE.UnsignedByteType });
    this.aoRT = rt(size.x / 2, size.y / 2, { type: THREE.UnsignedByteType });
    this.aoRT2 = rt(size.x / 2, size.y / 2, { type: THREE.UnsignedByteType });
    this.ssrRT = rt(size.x / 2, size.y / 2, { type: THREE.HalfFloatType });
    this.raysRT = rt(size.x / 4, size.y / 4, { type: THREE.HalfFloatType });
    this.sunVisRT = rt(1, 1, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.depth = this.sceneRT.depthTexture;

    // ---- passes
    const depthU = () => ({ tDepth: { value: this.depth }, uProj: this._uProj, uInvProj: this._uInvProj, uNearFar: this._uNearFar });
    this._uProj = { value: new THREE.Matrix4() };
    this._uInvProj = { value: new THREE.Matrix4() };
    this._uNearFar = { value: new THREE.Vector2(0.3, 40000) };
    this._uView = { value: new THREE.Matrix4() };
    this._uCamWorld = { value: new THREE.Matrix4() };
    const D = clip ? { REVERSED_DEPTH: 1 } : {};
    this.D = D;
    this._variants = new Map();
    this.aoMat = fsMaterial(AO_FRAG, { ...depthU(), uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.6 }, uIntensity: { value: 1.6 } }, { ...D, AO_SAMPLES: 10 });
    this.aoBlurMat = fsMaterial(AO_BLUR_FRAG, { ...depthU(), tAO: { value: this.aoRT.texture }, uTexel: { value: new THREE.Vector2() } }, D);
    this.ssrMat = fsMaterial(SSR_FRAG, { ...depthU(), tColor: { value: this.sceneRT.texture }, uView: this._uView, uCamWorld: this._uCamWorld, uMaxDist: { value: 160 }, uTime: { value: 0 }, uRain: { value: 0 } }, { ...D, SSR_STEPS: 20 });
    this._sunUV = { value: new THREE.Vector2(0.5, 0.5) };
    this._aspect = { value: 1 };
    this.raysMat = fsMaterial(RAYS_FRAG, { ...depthU(), tColor: { value: this.sceneRT.texture }, uSunUV: this._sunUV, uAspect: this._aspect, uThreshold: { value: 1 } }, D);
    this.sunVisMat = fsMaterial(SUNVIS_FRAG, { ...depthU(), tColor: { value: this.sceneRT.texture }, uSunUV: this._sunUV, uAspect: this._aspect, uRef: { value: 10 } }, D);
    this.fogU = {
      uSkyLut: { value: null }, uLutHorizon: { value: 0 }, uOvercastCol: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uOvercastAmt: { value: 0 },
      uFogColor: { value: new THREE.Color() }, uSunDirW: { value: new THREE.Vector3(0, 1, 0) }, uCamPos: { value: new THREE.Vector3() },
      uMistGlow: { value: new THREE.Vector3() }, uHazeNight: { value: new THREE.Vector3() }, uFogDensity: { value: 0 }, uMist: { value: 0 }, uMistH: { value: 35 }, uUnder: { value: 0 }, uDayLight: { value: 1 },
      uCamWorldF: this._uCamWorld,
    };
    this.compositeMat = fsMaterial(COMPOSITE_FRAG, {
      ...depthU(), ...this.fogU, tColor: { value: this.sceneRT.texture }, tAO: { value: this.aoRT2.texture }, tSSR: { value: this.ssrRT.texture }, tRays: { value: this.raysRT.texture },
      uView: this._uView, uAOStrength: { value: 0.75 }, uSSRStrength: { value: 1 }, uRayColor: { value: new THREE.Vector3() },
    }, D);
    this.finalMat = fsMaterial(FINAL_FRAG, {
      ...depthU(), ...this.fogU, tColor: { value: this.hdrRT.texture }, tSunVis: { value: this.sunVisRT.texture },
      uResolution: { value: new THREE.Vector2() }, uExposure: { value: 1 }, uAspect: this._aspect, uTime: { value: 0 },
      uLift: { value: new THREE.Vector3(0, 0, 0) }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uSat: { value: 1 }, uContrast: { value: 0.18 }, uVibrance: { value: 0.28 }, uVignette: { value: 0.32 }, uGrain: { value: 0.025 },
      uNight: { value: 0 }, uFade: { value: 0 }, uWasted: { value: 0 }, uSplit: { value: 1 },
      uLens: { value: 0 }, uSunUV: this._sunUV, uFlare: { value: 0 }, uFlareCol: { value: new THREE.Vector3(1, 1, 1) },
      uPrevVP: { value: new THREE.Matrix4() }, uCamWorld: this._uCamWorld, uMB: { value: 0 },
      tBloom: { value: null }, uBloom: { value: 0.1 },
    }, D);
    // legacy API: render.grade.uniforms.uWasted / uFade / uNight
    this.grade = { uniforms: this.finalMat.uniforms, material: this.finalMat, enabled: true };
    this.fxaaMat = new THREE.ShaderMaterial({ ...FXAAShader, uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false });
    this.fxaa = { material: this.fxaaMat, enabled: true }; // legacy field
    this.smaa = new SMAAPass();
    this.smaa.renderToScreen = true;
    this.bloom = new Bloom(5);
    this.finalMat.uniforms.tBloom.value = this.bloom.texture;
    this.base = { ao: this.aoMat, ssr: this.ssrMat, composite: this.compositeMat, final: this.finalMat };
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.finalMat);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._prevCamPos = null;
    this._time = 0;
    this._dt = 1 / 60;
    this.frameInfo = { passes: [], calls: 0, triangles: 0 };
    this._stats = { cpuMs: 0, gpuMs: null, drawCalls: 0, triangles: 0, programs: 0, compiles: 0, fps: 0, targetFps: 60, refreshHz: 60, scale: 1, quality: '' };
    // shader programs: kept alive for the session (see pinPrograms), objects waiting for their programs (see warm)
    this._pinned = 0;
    this._pinSeen = -1;
    this._frameNo = 0;
    this._warming = [];
    this._untouched = [];
    this.beforeRender = []; // hooks run at the start of render(), after every update (shadow proxies)
    this.compiles = 0; // programs created since start (runtime compiles show up here)
    // display refresh → frame-rate target (measured from frame deltas once the game runs)
    this.refreshHz = 60;
    this.targetFps = Math.min(60, this.profile.maxFps ?? 60);
    this._rafDts = [];
    this._config();
    this.profile.onChange((p, info) => {
      this._config();
      this._retarget();
      // settings-menu switch (not an automatic runtime downgrade): compile the new programs right away
      // (deferred to the next render so every other listener — Sky lights/shadows — has run first)
      if (!info?.runtime && this.scene && this._prewarmed) this._needPrewarm = true;
    });
    window.addEventListener('resize', () => this.resize());
  }

  attach(game) {
    this.game = game;
    if (!game.quality) game.quality = this.profile;
    this.manualScale = clampRenderScale(game.settings.resScale ?? 1);
    this.autoRes = game.settings.autoRes !== false;
    this.scale = this.autoRes ? 1 : this.manualScale;
    this.setAntialiasing(game.settings.antialiasing ?? 'auto');
    game.onSetting('autoRes', (v) => this.setDynamicResolution(v));
    game.onSetting('resScale', (v) => this.setResolutionScale(v));
    game.onSetting('antialiasing', (v) => { game.settings.antialiasing = this.setAntialiasing(v); });
  }

  antialiasingModes() { return antialiasingModes(this.msaaSamples); }

  setAntialiasing(mode) {
    this.antialiasing = this.antialiasingModes().includes(mode) ? mode : 'auto';
    this._config();
    return this.antialiasing;
  }

  setDynamicResolution(on) {
    this.autoRes = !!on;
    this.governor = new QualityGovernor();
    this.scale = this.autoRes ? 1 : this.manualScale;
    this.resize();
  }

  setResolutionScale(value) {
    this.manualScale = clampRenderScale(value);
    if (!this.autoRes) { this.scale = this.manualScale; this.resize(); }
  }

  setScene(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.resize();
  }

  // name: 'low'|'medium'|'high'|'ultra'|'auto'
  setQuality(q) {
    const auto = q === 'auto' || !QUALITY_PROFILES[q];
    const name = auto ? this.detected.name : q;
    this.governor.downgrades = 0;
    this.quality = name;
    this.profile.apply(name, auto); // listeners reconfigure lights/post and pre-warm (one hitch, settings only)
    this.resize();
  }

  // { cpuMs, gpuMs, drawCalls, triangles, programs, fps, targetFps, refreshHz, scale, quality }
  stats() {
    const s = this._stats, g = this.gpu;
    s.cpuMs = this._cpuMs ?? 0;
    s.gpuMs = g.enabled ? g.frameMs : null;
    s.drawCalls = this.frameInfo.calls;
    s.triangles = this.frameInfo.triangles;
    s.programs = this.renderer.info.programs?.length ?? 0;
    s.compiles = this.compiles;
    s.fps = this.game?.fps ?? 0;
    s.targetFps = this.targetFps;
    s.refreshHz = this.refreshHz;
    s.scale = this.scale;
    s.quality = this.profile.name;
    s.width = this.width; s.height = this.height;
    s.antialiasing = this.antialiasing; s.samples = this.sceneRT.samples;
    s.appliedScale = this.displaySize?.appliedScale ?? this.scale;
    return s;
  }

  _retarget() {
    const cap = this.profile.maxFps ?? 240;
    const hz = this.refreshHz;
    this.targetFps = Math.min(cap, hz >= 110 ? 120 : Math.max(55, hz));
  }

  // refresh rate from the fastest frame deltas (frames cannot beat vsync), measured once after start-up
  _measureRefresh(dt) {
    if (this._refreshDone || document.visibilityState === 'hidden' || dt <= 0 || dt > 0.05) return;
    const a = this._rafDts;
    a.push(dt);
    if (a.length < 90) return;
    a.sort((x, y) => x - y);
    const fast = a[Math.floor(a.length * 0.1)];
    const hz = 1 / fast;
    const rates = [30, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240];
    let best = 60;
    for (const r of rates) if (Math.abs(r - hz) < Math.abs(best - hz)) best = r;
    this.refreshHz = best;
    this._refreshDone = true;
    a.length = 0;
    this._retarget();
  }

  // Effect flags for a profile (+ lab toggles)
  _useFor(p) {
    const e = this.effects;
    const mode = e.aa ? (this.antialiasing === 'auto' ? p.aa : this.antialiasing) : 'none';
    const samples = mode?.startsWith('msaa') ? +mode.slice(4) : 0;
    const u = {
      bloom: p.bloom && e.bloom,
      ao: p.ao && e.ao,
      ssr: p.ssr && e.ssr,
      godrays: p.godrays && e.godrays,
      flare: p.lensFlare && e.flare,
      lens: p.lensDrops && e.lens,
      motionBlur: p.motionBlur && e.motionBlur,
      grain: p.grain && e.grain,
      aa: samples ? 'smaa' : mode,
      samples,
      fog: e.fog,
      ca: p.name === 'ultra',
    };
    u.composite = u.ao || u.ssr || u.godrays;
    return u;
  }

  // Shader variants share one uniforms object; switching variants never recompiles once pre-warmed.
  _variant(kind, flags) {
    const nd = { ...this.D };
    for (const [k, v] of Object.entries(flags)) if (v !== false && v != null) nd[k] = v;
    const key = kind + JSON.stringify(nd);
    let m = this._variants.get(key);
    if (!m) {
      const b = this.base[kind];
      m = b.clone();
      m.uniforms = b.uniforms;
      m.defines = nd;
      this._variants.set(key, m);
    }
    return m;
  }

  _materialsFor(p) {
    const u = this._useFor(p);
    return {
      u,
      composite: this._variant('composite', { USE_AO: u.ao ? 1 : null, USE_SSR: u.ssr ? 1 : null, USE_RAYS: u.godrays ? 1 : null }),
      final: this._variant('final', { USE_BLOOM: u.bloom ? 1 : null, USE_FOG: !u.composite && u.fog ? 1 : null, USE_LENS: u.lens ? 1 : null, USE_FLARE: u.flare ? 1 : null, USE_MBLUR: u.motionBlur ? 1 : null, USE_GRAIN: u.grain ? 1 : null, USE_CA: u.ca ? 1 : null }),
      ssr: this._variant('ssr', { SSR_STEPS: p.name === 'ultra' ? 32 : 20 }),
      ao: this._variant('ao', { AO_SAMPLES: p.name === 'ultra' ? 14 : 10 }),
    };
  }

  // Compile every program the game can need without a settings change: all scene materials (into the
  // HDR target) and the post variants of the current and all lower profiles (auto-downgrade path).
  // Call once after all modules are added; Weather calls it on registration as well.
  prewarm() {
    const r = this.renderer, prev = r.getRenderTarget();
    const t0 = performance.now();
    if (this.scene && this.camera) {
      r.setRenderTarget(this.sceneRT);
      try { this._track(r.compile(this.scene, this.camera)); } catch (e) { console.warn('[render] prewarm scene', e); }
    }
    // current profile + every profile an automatic downgrade can reach
    const names = this.profile.name === 'mobile' ? ['mobile', 'low'] : QUALITY_NAMES.slice(0, Math.max(0, QUALITY_NAMES.indexOf(this.profile.name)) + 1);
    const compile = (mat, target) => { this.quad.material = mat; r.setRenderTarget(target); this._track(r.compile(this.quadScene, this.quadCam)); };
    for (let i = 0; i < names.length; i++) {
      const p = { ...QUALITY_PROFILES[names[i]], name: names[i] };
      const m = this._materialsFor(p);
      compile(m.ao, this.aoRT); compile(this.aoBlurMat, this.aoRT2); compile(m.ssr, this.ssrRT);
      compile(this.raysMat, this.raysRT); compile(this.sunVisMat, this.sunVisRT);
      compile(m.composite, this.hdrRT); compile(m.final, this.ldrRT); compile(m.final, null);
    }
    compile(this.fxaaMat, null);
    const [pre, down, up] = this.bloom.materials();
    compile(pre, this.bloom.rts[0]); compile(down, this.bloom.rts[1]); compile(up, this.bloom.rts[0]);
    // SMAA owns its materials: run it once
    this.smaa.render(r, null, this.ldrRT);
    r.setRenderTarget(prev);
    this.quad.material = this.finalMat;
    this.pinPrograms();
    this.prewarmMs = performance.now() - t0;
    this._prewarmed = true;
    return this.prewarmMs;
  }

  // Shader programs live for the whole session. three.js deletes a program when the last material using it is
  // disposed, so a despawned vehicle (fx sprite, wreck, thumbnail…) took its programs along and the next one of the
  // same kind recompiled them: 100-500 ms per program on ANGLE/Metal, inside the frame. One extra reference per
  // program keeps it; the set of variants is small and bounded (material kinds × quality profiles).
  pinPrograms() {
    const list = this.renderer.info.programs;
    if (!list) return;
    if (list.length === this._pinSeen && !this._pinDirty) return; // new programs are appended: the length moves
    this._pinDirty = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.__pinned || typeof p.usedTimes !== 'number') continue;
      p.__pinned = true;
      this.compiles++;
      // custom ShaderMaterial programs are keyed by shader-source numbers that three recycles once no material uses
      // the source: a rebuilt material gets new numbers and can never reuse a pinned program (keepShaders instead)
      if (/^\d/.test(p.cacheKey || '')) continue;
      if (this._pinned >= 640) continue; // safety valve: something creates unique programs endlessly
      p.usedTimes++;
      this._pinned++;
    }
    this._pinSeen = list.length;
  }

  // The first draw with a program runs three's onFirstUse: info logs + uniform / attribute tables, i.e. synchronous
  // round trips to the GPU process. On ANGLE/Metal that is also where the real compile + link happens (20-70 ms per
  // program; COMPLETION_STATUS_KHR turns true long before), and mid-frame the round trip also waits for every command
  // queued so far. Programs of warm() objects are touched here instead, at the start of a frame. The loading screen
  // touches everything by drawing it once (prewarmDraw), so this only matters for first-of-a-kind runtime spawns.
  _touchPrograms(all = false) {
    const list = this._untouched;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (p.destroyed || !p.program) { list.splice(i, 1); continue; }
      if (!all && p.isReady && !p.isReady()) continue;
      try { p.getUniforms(); p.getAttributes(); } catch (e) { /* reported by three on real use */ }
      list.splice(i, 1);
    }
  }

  /**
   * Custom ShaderMaterials under `object` (aircraft light cones, …) get a twin that is never disposed. three numbers
   * shader sources only while some material uses them, so a disposed and rebuilt material got new numbers, a new
   * program key and a fresh compile on every spawn; the twin keeps the numbers and the program alive.
   */
  keepShaders(object) {
    const kept = (this._keptShaders ||= new Map());
    const holder = (this._keptHolder ||= new THREE.Group());
    const add = [];
    object?.traverse?.((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m.isShaderMaterial || m.isRawShaderMaterial) continue;
        const key = `${m.vertexShader}\u0000${m.fragmentShader}\u0000${JSON.stringify(m.defines || {})}|${m.side}|${m.transparent}`;
        if (kept.has(key)) continue;
        const geo = new THREE.BufferGeometry();
        for (const [name, a] of Object.entries(o.geometry.attributes)) geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(a.itemSize * 3), a.itemSize));
        const twin = new THREE.Mesh(geo, m.clone());
        twin.frustumCulled = false;
        kept.set(key, twin);
        holder.add(twin);
        add.push(twin);
      }
    });
    if (!add.length || !this.scene || !this.camera) return;
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.sceneRT);
    try { for (const t of add) r.compile(t, this.camera, this.scene); } catch (e) { console.warn('[render] keepShaders', e); } finally { r.setRenderTarget(prev); }
  }

  /**
   * Compile `object`'s materials now (KHR_parallel_shader_compile: the GPU process works on them in the background
   * where the driver allows it) and keep the object hidden until all of them report ready; their first use then
   * happens at the start of a frame (_touchPrograms), not in the middle of the scene pass. Known kinds are free:
   * the programs exist (pinned). Returns true when nothing had to wait.
   */
  warm(object, { hide = true, maxMs = 2000 } = {}) {
    if (!object || !this.scene || !this.camera) return true;
    let mats;
    // compile for the HDR scene target: the output colour space (part of the program key) depends on it
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.sceneRT);
    try { mats = r.compile(object, this.camera, this.scene); } catch (e) { console.warn('[render] warm', e); return true; } finally { r.setRenderTarget(prev); }
    this.pinPrograms();
    const props = this.renderer.properties;
    const waiting = [];
    for (const m of mats) {
      const pr = props.get(m).currentProgram;
      if (pr && !pr.__touched) { pr.__touched = true; this._untouched.push(pr); }
      if (pr && pr.isReady && !pr.isReady()) waiting.push(m);
    }
    if (!waiting.length) return true;
    if (hide && object.visible) {
      object.visible = false;
      object.userData.__warmHidden = true;
    }
    this._warming.push({ object, mats: waiting, until: performance.now() + maxMs });
    return false;
  }

  // materials from renderer.compile() whose programs are still linking (settle() waits for them)
  _track(mats, maxMs = 6000) {
    if (!mats) return;
    const props = this.renderer.properties, waiting = [];
    for (const m of mats) { const pr = props.get(m).currentProgram; if (pr && pr.isReady && !pr.isReady()) waiting.push(m); }
    if (waiting.length) this._warming.push({ object: null, mats: waiting, until: performance.now() + maxMs });
  }

  /**
   * Loading screen: draw the scene once with `objects` (prewarm samples not in the scene) shrunk to nothing in front
   * of the camera, every empty InstancedMesh (traffic models, crowds, debris…) given one microscopic instance there
   * too, every hidden subtree shown where it is, and nothing frustum-culled (all world geometry gets uploaded).
   * ANGLE / Metal links a program and builds its GPU pipeline (per blend state, target format, vertex layout), and
   * three.js fetches its uniform tables, at the FIRST DRAW, not at compile time: 20-120 ms each when it happens in
   * play. The shadow pass sees the casters as well (instanced depth variants). Returns ms.
   */
  prewarmDraw(objects = []) {
    const r = this.renderer, scene = this.scene, cam = this.camera;
    if (!scene || !cam) return 0;
    const t0 = performance.now();
    const holder = new THREE.Group();
    const parents = new Map();
    const zero = [], shown = [], unculled = [];
    let probes = null;
    try {
      cam.updateMatrixWorld();
      holder.position.copy(cam.position).addScaledVector(cam.getWorldDirection(_v), 3);
      holder.scale.setScalar(0.002);
      for (const o of objects) {
        parents.set(o, { parent: o.parent, pos: o.position.clone(), quat: o.quaternion.clone() });
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        holder.add(o);
      }
      if (this.renderer.shadowMap.enabled) holder.add((probes = shadowDepthProbes()));
      scene.add(holder);
      holder.updateMatrixWorld(true);
      // hidden subtrees (landmark near LODs, wardrobe-only hair / hats, night / weather props): shown for this one
      // draw where they are, culling off; small (≈60 roots, ≈80k vertices) and their first sight is hitch-free
      const walk = (o, parentVisible) => {
        if (!o.visible && parentVisible && !o.isLight && o !== holder) {
          shown.push(o);
          o.visible = true;
          o.traverse((c) => { if ((c.isMesh || c.isPoints || c.isLine || c.isSprite) && c.frustumCulled) { unculled.push(c); c.frustumCulled = false; } });
          return;
        }
        for (const c of o.children) walk(c, parentVisible && o.visible);
      };
      walk(scene, true);
      // no frustum culling for this draw: every geometry (and texture) of the world is uploaded now, not in the frame
      // that first sees it (a boat spawning across the bay or a teleport uploaded ~150 buffers in one frame, 80 ms)
      scene.traverseVisible((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.frustumCulled) { unculled.push(o); o.frustumCulled = false; } });
      _m.compose(holder.position, _q.identity(), _s.setScalar(0.002));
      scene.traverse((o) => {
        if (!o.isInstancedMesh || o.count > 0 || !o.visible) return;
        const keep = new THREE.Matrix4();
        o.getMatrixAt(0, keep); // some systems fill matrices once and only move `count`: put instance 0 back after
        zero.push([o, keep]);
        o.count = 1;
        o.updateMatrixWorld(true);
        _m2.copy(o.matrixWorld).invert().multiply(_m);
        o.setMatrixAt(0, _m2);
        o.instanceMatrix.needsUpdate = true;
      });
      _s.set(1, 1, 1);
      const prev = r.getRenderTarget();
      r.setRenderTarget(this.sceneRT);
      r.render(scene, cam);
      r.setRenderTarget(prev);
    } catch (e) { console.warn('[render] prewarm draw', e); }
    _s.set(1, 1, 1);
    for (const [o, keep] of zero) { o.count = 0; o.setMatrixAt(0, keep); o.instanceMatrix.needsUpdate = true; }
    for (const o of shown) o.visible = false;
    for (const o of unculled) o.frustumCulled = true;
    holder.removeFromParent();
    if (probes) { probes.removeFromParent(); probes.userData.dispose(); }
    for (const [o, p] of parents) {
      holder.remove(o);
      o.position.copy(p.pos);
      o.quaternion.copy(p.quat);
      p.parent?.add(o);
    }
    this.pinPrograms();
    this.prewarmDrawMs = performance.now() - t0;
    return this.prewarmDrawMs;
  }

  /** Programs of every warm() object still compiling? */
  get warming() { return this._warming.length > 0; }

  _updateWarming() {
    const list = this._warming;
    if (!list.length) return;
    const props = this.renderer.properties, now = performance.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i];
      let ready = now > w.until;
      if (!ready) {
        ready = true;
        for (const m of w.mats) {
          const pr = props.get(m).currentProgram; // undefined once disposed
          if (pr && pr.isReady && !pr.isReady()) { ready = false; break; }
        }
      }
      if (!ready) continue;
      if (w.object?.userData.__warmHidden) { w.object.visible = true; delete w.object.userData.__warmHidden; }
      list.splice(i, 1);
    }
  }

  /** Resolves once done() is true or after `ms` (MessageChannel ticks: on time in hidden tabs too, where timers are
   *  throttled to 1 s). Loading screen only: it polls continuously. */
  async until(ms, done = () => false) {
    const t0 = performance.now();
    const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
    while (!done() && performance.now() - t0 < ms) await tick();
  }

  /** Resolves when no warm() object is waiting any more (loading screen: compile everything in parallel). */
  async settle(maxMs = 8000) {
    const t0 = performance.now();
    // MessageChannel ticks: not throttled in hidden tabs (rAF / timers are), the loading screen has nothing else to do
    const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
    const gl = this.renderer.getContext();
    gl.flush(); // queued compile / link commands must reach the GPU process before their status can change
    while (this._warming.length && performance.now() - t0 < maxMs) { await tick(); this._updateWarming(); }
    this.pinPrograms();
    return performance.now() - t0;
  }

  _config() {
    const p = this.profile;
    this.basePR = resolvePixelRatio(p);
    const m = this._materialsFor(p);
    this.use = m.u;
    this.cur = m;
    if (this.sceneRT.samples !== m.u.samples) {
      this.sceneRT.samples = m.u.samples;
      this.sceneRT.dispose();
    }
    this.bloom.enabled = m.u.bloom;
    this._bloomBase = p.name === 'medium' ? 0.085 : 0.1;
    if (this.scene) this.resize();
  }

  setEffect(name, on) { this.effects[name] = on; this._config(); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.basePR = resolvePixelRatio(this.profile, w, h);
    const memory = navigator.deviceMemory || 8;
    const budget = (memory <= 4 ? 384 : 1536) * 1024 * 1024;
    const size = this.displaySize = renderSize({ width: w, height: h, dpr: window.devicePixelRatio || 1, basePR: this.basePR,
      scale: this.scale, auto: this.autoRes, maxDimension: this.maxRenderDimension, maxPixels: budget / (48 + 12 * (this.use?.samples || 0)) });
    const pr = size.pr;
    const r = this.renderer;
    r.setPixelRatio(pr);
    r.setSize(w, h);
    const s = r.getDrawingBufferSize(new THREE.Vector2());
    const W = s.x, H = s.y;
    this.sceneRT.setSize(W, H);
    this.hdrRT.setSize(W, H);
    this.ldrRT.setSize(W, H);
    const hw = Math.max(1, Math.round(W / 2)), hh = Math.max(1, Math.round(H / 2));
    this.aoRT.setSize(hw, hh);
    this.aoRT2.setSize(hw, hh);
    this.ssrRT.setSize(hw, hh);
    this.raysRT.setSize(Math.max(1, Math.round(W / 4)), Math.max(1, Math.round(H / 4)));
    this.aoMat.uniforms.uTexel.value.set(1 / W, 1 / H);
    this.aoBlurMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.bloom.setSize(W, H); // mip chain ½ … 1/32
    this.smaa.setSize(W, H);
    this.fxaaMat.uniforms.resolution.value.set(1 / W, 1 / H);
    this.finalMat.uniforms.uResolution.value.set(W, H);
    this._aspect.value = W / H;
    this.width = W; this.height = H;
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  // dynamic resolution + auto downgrade (only when quality = auto)
  adapt(dt) {
    this._dt = dt;
    const gpuMs = this.gpu.enabled ? this.gpu.lastFrameMs : null;
    this._measureRefresh(dt);
    const res = this.governor.step(dt, gpuMs ?? null, this.scale, this.profile.auto && this.autoRes, this.targetFps, this._cpuMs ?? null);
    if (this.autoRes && Math.abs(res.scale - this.scale) > 0.01) { this.scale = res.scale; this.resize(); }
    if (res.downgrade && this.profile.name !== 'low') {
      const next = lowerQuality(this.profile.name);
      console.info(`[quality] auto downgrade ${this.profile.name} → ${next}`);
      // runtime downgrade: budgets, resolution and post variants only (pre-warmed) — no light/shadow/material changes
      this.profile.apply(next, true, { runtime: true });
      this.quality = next;
      this.scale = 1;
      this.resize();
      this.game?.events?.emit('quality', { name: next, auto: true });
    }
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  _updateUniforms() {
    const cam = this.camera, u = this.use;
    const sky = this.renderer.leonidaSky || this.game?.sky;
    const weather = this.game?.weather;
    const dt = this._dt;
    this._time += dt;
    this._uProj.value.copy(cam.projectionMatrix);
    this._uInvProj.value.copy(cam.projectionMatrixInverse);
    this._uNearFar.value.set(cam.near, cam.far);
    this._uView.value.copy(cam.matrixWorldInverse);
    this._uCamWorld.value.copy(cam.matrixWorld);
    const f = this.fogU;
    const fog = this.scene.fog;
    f.uFogDensity.value = u.fog && fog ? fog.density : 0;
    if (fog) f.uFogColor.value.copy(fog.color);
    f.uCamPos.value.copy(cam.position);
    const night = sky?.night ?? 0;
    if (sky) {
      const su = sky.uniforms;
      f.uSkyLut.value = su.uSkyLut.value;
      f.uLutHorizon.value = su.uLutHorizon.value;
      f.uOvercastCol.value.copy(su.uOvercastCol.value);
      f.uOvercastAmt.value = su.uOvercastAmt.value;
      f.uSunDirW.value.copy(sky.sunDir);
      f.uMistGlow.value.copy(su.uCityGlow.value).multiplyScalar(3);
      f.uHazeNight.value.copy(su.uCityGlow.value).add(su.uNightSky.value); // as the dome just above the horizon
      f.uDayLight.value = 1 - night;
    } else if (!f.uSkyLut.value) {
      f.uSkyLut.value = new THREE.DataTexture(new Uint8Array([128, 160, 200, 255]), 1, 1);
      f.uSkyLut.value.needsUpdate = true;
    }
    const wp = weather?.post;
    f.uMist.value = u.fog && wp ? wp.mist : 0;
    f.uMistH.value = wp ? wp.mistHeight : 35;
    const under = cam.position.y < -0.05 && (this.game?.terrain?.heightAt?.(cam.position.x, cam.position.z) ?? -1) < cam.position.y;
    f.uUnder.value = under ? 1 : 0;

    // sun on screen
    const sunDir = sky?.sunDir || _v.set(0, 1, 0);
    _v.copy(cam.position).addScaledVector(sunDir, 1000).project(cam);
    const camDir = cam.getWorldDirection(_v2);
    const facing = camDir.dot(sunDir);
    this._sunUV.value.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    const onScreen = facing > 0 && Math.abs(_v.x) < 1.6 && Math.abs(_v.y) < 1.6;
    const sunUp = smooth(sunDir.y, -0.02, 0.06) * (1 - night);
    const cloudK = 1 - smooth(weather?.cloud ?? 0.3, 0.55, 0.95);
    this._raysOn = u.godrays && onScreen && sunUp > 0.01 && cloudK > 0.02 && !under;
    const lowSun = 0.35 + 0.65 * (1 - smooth(sunDir.y, 0.15, 0.6));
    const sc = sky?.sunColor || new THREE.Color(1, 1, 1);
    this.compositeMat.uniforms.uRayColor.value.set(sc.r, sc.g, sc.b).multiplyScalar(0.55 * lowSun * sunUp * cloudK * smooth(facing, 0.1, 0.6));
    this.raysMat.uniforms.uThreshold.value = 1.2 * (sky ? Math.max(0.3, sky.horizon.r + sky.horizon.g) : 1);
    this.sunVisMat.uniforms.uRef.value = 30 * Math.max(0.05, sc.g * sunUp);
    this._flareOn = u.flare && onScreen && sunUp > 0.01 && cloudK > 0.02 && !under;
    const fm = this.finalMat.uniforms;
    fm.uFlare.value = this._flareOn ? 0.45 * sunUp * cloudK * smooth(facing, 0.2, 0.7) : 0;
    fm.uFlareCol.value.set(sc.r, sc.g, sc.b);
    fm.uTime.value = this._time;
    fm.uExposure.value = this.renderer.toneMappingExposure;
    fm.uLens.value = wp ? wp.lens : 0;

    // motion blur: translation-only reprojection (camera rotation does not blur)
    if (u.motionBlur) {
      const prev = this._prevCamPos || cam.position.clone();
      const moved = prev.distanceTo(cam.position);
      cam.getWorldQuaternion(_q);
      _m.compose(prev, _q, _s).invert();
      fm.uPrevVP.value.multiplyMatrices(cam.projectionMatrix, _m);
      const speed = moved / Math.max(dt, 1e-3);
      fm.uMB.value = moved > 40 ? 0 : 0.5 * (1 / 60) / Math.max(dt, 1 / 240) * smooth(speed, 12, 35);
      this._prevCamPos = (this._prevCamPos || new THREE.Vector3()).copy(cam.position);
    } else fm.uMB.value = 0;

    // bloom only for real emissives and the sun disc (threshold in scene-linear units, before exposure)
    this.bloom.threshold = THREE.MathUtils.lerp(2.6, 1.15, night);
    this.finalMat.uniforms.uBloom.value = (this._bloomBase ?? 0.1) * (1 + 0.25 * night);
    this.ssrMat.uniforms.uTime.value = this._time;
    this.ssrMat.uniforms.uRain.value = weather?.rain ?? 0;
    this._gradeKey(sky, weather, night);
  }

  // colour grade keyed to time of day + weather ("LUT-like" curves)
  _gradeKey(sky, weather, night) {
    const fm = this.finalMat.uniforms;
    const el = sky ? sky.sunElevation : 40;
    const golden = sky ? smooth(el, -4, 2) * (1 - smooth(el, 8, 22)) : 0;
    const wet = weather ? smooth(weather.cloud, 0.5, 1) : 0;
    const storm = weather ? weather.cur?.dark ?? 0 : 0;
    // gain: warm golden hour, cool night with a magenta lift (Vice City neon), grey-cool overcast
    fm.uGain.value.set(1 + 0.06 * golden - 0.03 * night - 0.02 * wet, 1 + 0.01 * golden - 0.01 * night, 1 - 0.05 * golden + 0.05 * night + 0.03 * wet);
    fm.uLift.value.set(0.006 * night + 0.004 * golden, 0.0, 0.016 * night + 0.006 * wet).multiplyScalar(1);
    fm.uGamma.value.set(1, 1, 1).multiplyScalar(1 + 0.04 * night);
    fm.uSat.value = 1.04 + 0.1 * golden - 0.16 * wet - 0.1 * storm + 0.05 * night;
    fm.uVibrance.value = 0.28 + 0.1 * golden - 0.12 * wet;
    fm.uContrast.value = 0.18 + 0.05 * golden - 0.06 * wet;
    fm.uSplit.value = 1 - 0.5 * night;
    fm.uGrain.value = 0.018 + 0.02 * night;
    fm.uNight.value = night;
  }

  render() {
    const r = this.renderer, cam = this.camera, scene = this.scene, u = this.use, gpu = this.gpu;
    if (!scene || !cam) return;
    if (this._needPrewarm) { this._needPrewarm = false; this.prewarm(); }
    if (this._warming.length) this._updateWarming();
    if (this._untouched.length) this._touchPrograms();
    for (let i = 0; i < this.beforeRender.length; i++) this.beforeRender[i]();
    this._updateUniforms();
    const passes = this.frameInfo.passes;
    passes.length = 0;
    // high above the ground nothing visible lies within the sun's shadow range (shadowDistance from the camera): the
    // cascades would render empty air every frame (20-60 depth draws); skip their update (receivers outside the
    // cascades are unshadowed anyway) until the camera comes back down
    const alt = this.camAlt ?? 0;
    const shDist = this.profile?.shadowDistance ?? 260;
    // 1) scene
    gpu.begin('scene');
    r.setRenderTarget(this.sceneRT);
    if (alt > shDist + 120) r.shadowMap.autoUpdate = false;
    r.render(scene, cam);
    r.shadowMap.autoUpdate = true; // studios / previews render with their own shadows
    this.frameInfo.calls = r.info.render.calls;
    this.frameInfo.triangles = r.info.render.triangles;
    passes.push('scene');
    let hdr = this.sceneRT;
    // 2) screen-space effects
    if (u.composite) {
      // ambient occlusion works at metre scale: from a few hundred metres up it has nothing left to darken
      const aoK = 1 - smooth(alt, 220, 360);
      this.compositeMat.uniforms.uAOStrength.value = 0.75 * aoK;
      if (u.ao && aoK > 0) {
        gpu.begin('ao');
        this._pass(this.cur.ao, this.aoRT);
        this._pass(this.aoBlurMat, this.aoRT2);
        passes.push('ao');
      }
      if (u.ssr && this._ssrWanted() && this.fogU.uUnder.value < 0.5) {
        gpu.begin('ssr');
        this._pass(this.cur.ssr, this.ssrRT);
        passes.push('ssr');
        this.compositeMat.uniforms.uSSRStrength.value = 1;
      } else this.compositeMat.uniforms.uSSRStrength.value = 0;
      if (this._raysOn) {
        gpu.begin('godrays');
        this._pass(this.raysMat, this.raysRT);
        passes.push('godrays');
      } else if (u.godrays) this.compositeMat.uniforms.uRayColor.value.set(0, 0, 0);
    }
    if (this._flareOn) {
      gpu.begin('sunvis');
      this._pass(this.sunVisMat, this.sunVisRT);
    }
    if (u.composite) {
      gpu.begin('composite');
      this._pass(this.cur.composite, this.hdrRT);
      hdr = this.hdrRT;
      passes.push('composite');
    }
    // 3) bloom (in place on the HDR buffer)
    if (u.bloom) {
      gpu.begin('bloom');
      this.bloom.render(r, hdr.texture);
      passes.push('bloom');
    }
    // 4) final grade → LDR (or screen)
    gpu.begin('final');
    this.finalMat.uniforms.tColor.value = hdr.texture;
    const aa = u.aa;
    this._pass(this.cur.final, aa === 'none' ? null : this.ldrRT);
    passes.push('final');
    if (aa === 'smaa') {
      gpu.begin('aa');
      this.smaa.render(r, null, this.ldrRT);
      passes.push('smaa');
    } else if (aa === 'fxaa') {
      gpu.begin('aa');
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture;
      this._pass(this.fxaaMat, null);
      passes.push('fxaa');
    }
    gpu.end();
    gpu.tick();
    r.setRenderTarget(null);
    if ((++this._frameNo & 127) === 0) this._pinDirty = true; // full rescan now and then (a swap keeps the length)
    this.pinPrograms();
  }

  // pixels without a mirror mask exit early, so SSR is cheap when dry; skip it only high above the city
  _ssrWanted() { return this.camera.position.y < 900; }
}
