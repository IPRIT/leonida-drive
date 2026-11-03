import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { GLOBAL_UNIFORMS } from '../core/globals.js';
import { SKY_LUT_FRAG, transmittance, skyRadiance, horizonAngle } from '../weather/atmosphere.js';
import { DOME_VERT, DOME_FRAG, PROBE_VERT, PROBE_FRAG, makeNoiseTexture } from '../weather/skyShaders.js';

// Day/night cycle + atmosphere (workstream F).
// Physically-inspired single-scattering sky (Rayleigh/Mie/ozone LUT), moon with phase, stars, milky way,
// cirrus + lit 2.5D cumulus layer, sun/moon light (cascaded SunLight on high/ultra, a focus-following
// DirectionalLight on medium), hemisphere fill, fog, exposure and a sky reflection probe (scene.environment).

const DEG = Math.PI / 180;
const LAT = 25.8 * DEG; // Leonida ≈ Miami
const DECL = 12 * DEG; // late-spring sun
const SUN_E = 3.4; // directional light intensity of the clear noon sun
const SKY_SCALE = 16; // atmosphere LUT → scene radiance
const LUNAR_DAYS = 8; // game days per moon cycle
const LUT_W = 192, LUT_H = 108;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _c = new THREE.Color(), _m4 = new THREE.Matrix4(), _lc = new THREE.Color();
const _pole = new THREE.Vector3(0, Math.sin(LAT), -Math.cos(LAT));
const _mer = new THREE.Vector3(0, Math.cos(LAT), Math.sin(LAT));

function celestial(hourAngle, decl, out) {
  // local frame: x east, y up, z south. Hour angle 0 = due south (noon), positive = west.
  out.copy(_pole).multiplyScalar(Math.sin(decl));
  out.addScaledVector(_mer, Math.cos(decl) * Math.cos(hourAngle));
  out.x += -Math.cos(decl) * Math.sin(hourAngle);
  return out.normalize();
}
const smooth = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;

export class Sky {
  constructor(scene, renderer, game = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.game = game;
    this.time = 17.55; // hours (golden hour)
    this.timeScale = 1 / 120; // game hours per real second (1 game minute = 0.5 s)
    this.paused = false;
    this.day = 3;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.zenith = new THREE.Color();
    this.horizon = new THREE.Color();
    this.sunColor = new THREE.Color();
    this.fogColor = new THREE.Color();
    this.night = 0;
    this.sunElevation = 0; // degrees
    this.moonPhase = 0.5; // 0 new .. 0.5 full .. 1 new
    this.moonIllum = 1;
    this.exposure = 1;
    this.quality = null;
    this._skip = null;
    this._lutKey = -1;
    this._envTimer = 1e9;
    this._envKey = -1;
    this.envEnabled = true;

    // ---------------- lights
    this.sun = new THREE.DirectionalLight(0xffffff, 3); // medium quality: one map following the focus
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.5;
    this.sun.shadow.radius = 2;
    scene.add(this.sun, this.sun.target);
    this.sunCSM = new SunLight(0xffffff, 3); // high/ultra: 2 cascades, built into three (no material patching)
    this.sunCSM.shadow.bias = -0.00015;
    this.sunCSM.shadow.normalBias = 0.45;
    this.sunCSM.shadow.radius = 2.5;
    this.sunCSM.visible = false;
    scene.add(this.sunCSM);
    this.hemi = new THREE.HemisphereLight(0xaaccff, 0x665544, 0.5);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xa9d2f2, 0.0001);

    // ---------------- atmosphere LUT
    this.lutRT = new THREE.WebGLRenderTarget(LUT_W, LUT_H, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
    this.lutUniforms = { uSunEl: { value: 0 }, uCamAlt: { value: 0.3 }, uHorizon: { value: horizonAngle(0.3) }, uMs: { value: 0.03 }, uExposure: { value: SKY_SCALE }, uHaze: { value: 1 } };
    this.lutQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.lutUniforms, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: SKY_LUT_FRAG,
    }));
    this.lutQuad.frustumCulled = false;
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.noiseRT = makeNoiseTexture(renderer);

    // ---------------- dome
    this.uniforms = {
      ...GLOBAL_UNIFORMS,
      uSkyLut: { value: this.lutRT.texture },
      uLutHorizon: { value: horizonAngle(0.3) },
      uOvercastCol: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uOvercastAmt: { value: 0 },
      uNoise: { value: this.noiseRT.texture },
      uCamPos: { value: new THREE.Vector3() },
      uMoonDir: { value: this.moonDir },
      uMoonLight: { value: new THREE.Vector3(0, 1, 0) },
      uSunDisc: { value: new THREE.Vector3() },
      uSunCloud: { value: new THREE.Vector3() },
      uSunCirrus: { value: new THREE.Vector3() },
      uAmbTop: { value: new THREE.Vector3() },
      uAmbBottom: { value: new THREE.Vector3() },
      uCityGlow: { value: new THREE.Vector3() },
      uNightSky: { value: new THREE.Vector3() },
      uGround: { value: new THREE.Vector3() },
      uNight: { value: 0 },
      uStars: { value: 0 },
      uCirrus: { value: 0.5 },
      uCloudDark: { value: 0 },
      uMoonBright: { value: 0.3 },
      uSkyTime: { value: 0 },
      uStarRot: { value: new THREE.Matrix3() },
      uFlashDir: { value: new THREE.Vector3(0, 1, 0) },
      // legacy names (Water and older code read these)
      uZenith: { value: this.zenith },
      uHorizon: { value: this.horizon },
      uSunColor: { value: this.sunColor },
    };
    const reversed = !!renderer.capabilities?.reversedDepthBuffer && renderer.state?.buffers?.depth?.getReversed?.();
    this.domeMat = this._domeMaterial({ CLOUD_Q: 3, ...(reversed ? { REVERSED_DEPTH: 1 } : {}) }, true);
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1e6; // last opaque: the sky only shades pixels no geometry covered (depth at far plane)
    this.dome.name = 'sky-dome';
    scene.add(this.dome);

    // ---------------- reflection probe (own lightweight prefilter: ~0.2 ms per update)
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(this.dome.geometry, this._domeMaterial({ ENV: 1, CLOUD_Q: 2 }, false));
    this.envDome.frustumCulled = false;
    this.envScene.add(this.envDome);
    this.filterUniforms = { uSrc: { value: null }, uSpread: { value: 0 }, uSrcLod: { value: 0 }, uCosine: { value: 0 }, uCount: { value: 16 } };
    this._probeStep = -1; // amortized update: 0 = sky → cube, 1 = mips 0-2, 2 = mips 3-5
    this.filterMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.ShaderMaterial({
      uniforms: this.filterUniforms, vertexShader: PROBE_VERT, fragmentShader: PROBE_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    }));
    this.filterMesh.frustumCulled = false;
    this._setupProbe(64);

    renderer.leonidaSky = this; // post passes (fog, rays, flare) read the sky from the three renderer
    const q = renderer.leonidaQuality || null;
    this.setQuality(q);
    q?.onChange?.((p, info) => this.setQuality(p, info));
    this.update(0, new THREE.Vector3());
    this.updateProbe();
  }

  _domeMaterial(defines, depth) {
    return new THREE.ShaderMaterial({
      uniforms: this.uniforms, defines, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: depth, fog: false,
    });
  }

  _setupProbe(size) {
    if (this.probeSize === size) return;
    this.probeSize = size;
    this.srcRT?.dispose();
    this.envRT?.dispose();
    this.srcRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, depthBuffer: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.srcRT);
    this.envRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearMipmapLinearFilter, depthBuffer: false });
    // 6 prefiltered levels whatever the size, so ENVMAP_MAX_LOD (a shader define) never changes
    for (let lod = 0; lod < 6; lod++) this.envRT.texture.mipmaps.push({ width: Math.max(1, size >> lod), height: Math.max(1, size >> lod) });
    this.envRT.texture.isPMREMTexture = true;
    this.envRT.texture.name = 'SkyProbe';
    this.filterCam = new THREE.CubeCamera(0.1, 10, this.envRT);
    this.envTexture = this.envRT.texture;
    this._envTimer = 1e9;
    if (this.envEnabled) this.scene.environment = this.envTexture;
  }

  attach(game) { this.game = game; }

  // quality profile object (src/core/quality.js) or null for defaults
  // Settings-menu changes may change lights/shadows/defines (one hitch). Automatic runtime downgrades
  // (info.runtime) only touch the probe update rate, so no shader is ever recompiled while playing.
  setQuality(q, info = {}) {
    this.quality = q;
    if (info.runtime) { this.envInterval = q ? q.envInterval : 0.5; return; }
    const r = this.renderer;
    const shadows = q ? q.shadows : 2;
    r.shadowMap.enabled = shadows > 0;
    r.shadowMap.type = THREE.PCFShadowMap;
    const csm = shadows >= 2;
    this.sun.visible = !csm;
    this.sunCSM.visible = csm;
    this.sun.castShadow = shadows === 1;
    this.sunCSM.castShadow = csm;
    const size = q ? q.shadowMapSize : 2048;
    const dist = q ? q.shadowDistance : 280;
    if (csm) {
      if (this.sunCSM.shadow.mapSize.x !== size) { this.sunCSM.shadow.mapSize.set(size, size); this.sunCSM.shadow.map?.dispose(); this.sunCSM.shadow.map = null; }
      this.sunCSM.shadow.camera.far = dist;
      this.sunCSM.shadow.radius = shadows >= 3 ? 2.5 : 2;
    } else {
      if (this.sun.shadow.mapSize.x !== size) { this.sun.shadow.mapSize.set(size, size); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
      const half = Math.max(40, dist * 0.6);
      const sc = this.sun.shadow.camera;
      sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 1; sc.far = 1600;
      sc.updateProjectionMatrix();
      this._shadowHalf = half;
    }
    const cq = q ? q.clouds : 3;
    if (this.domeMat.defines.CLOUD_Q !== cq) { this.domeMat.defines.CLOUD_Q = cq; this.domeMat.needsUpdate = true; }
    const envQ = Math.min(cq, 2);
    if (this.envDome.material.defines.CLOUD_Q !== envQ) { this.envDome.material.defines.CLOUD_Q = envQ; this.envDome.material.needsUpdate = true; }
    this.envEnabled = !q || q.reflections > 0;
    this.scene.environment = this.envEnabled ? this.envTexture : null;
    this._setupProbe(q ? q.envSize : 128);
    this.envInterval = q ? q.envInterval : 0.5;
    this._envTimer = 1e9;
    this._lutKey = -1;
  }

  setTime(h, opts = {}) {
    const to = ((h % 24) + 24) % 24;
    if (opts.smooth) {
      let delta = (to - this.time + 24) % 24;
      if (delta < 0.02) return;
      const dur = clamp(1.6 + delta * 0.18, 2, 4);
      this._skip = { from: this.time, delta, dur, t: 0 };
      this._emit('time:skip', { from: this.time, to, duration: dur });
    } else {
      this._skip = null;
      if (to < this.time - 12) this.day++;
      this.time = to;
      this._envTimer = 1e9;
    }
  }

  get skipping() { return !!this._skip; }

  // Online clock sync: call with the server's hour (and time scale). Small drift is corrected smoothly,
  // large differences (joining, server skip) snap.
  sync(hours, timeScale = this.timeScale) {
    this.timeScale = timeScale;
    const d = ((((hours - this.time) % 24) + 36) % 24) - 12;
    if (Math.abs(d) > 0.5) { this._drift = 0; this.setTime(hours); } else this._drift = d;
  }

  _emit(name, payload) {
    const ev = this.game?.events || globalThis.__leonida?.events;
    ev?.emit(name, payload);
  }

  _weather() {
    const w = this.game?.weather;
    if (w && w.sky) return w.sky;
    const c = GLOBAL_UNIFORMS.uCloudCover.value;
    return { cloud: c, dark: 0, haze: 1 + c * 2, cirrus: 0.5, fogDensity: 0.0001, mist: 0, rain: GLOBAL_UNIFORMS.uRain.value };
  }

  update(dt, focus) {
    // ---- time
    if (this._skip) {
      const s = this._skip;
      s.t += dt;
      const k = clamp(s.t / s.dur, 0, 1);
      const e = k * k * (3 - 2 * k);
      const abs = s.from + s.delta * e;
      if (Math.floor(abs / 24) > Math.floor((s.abs ?? s.from) / 24)) this.day++;
      s.abs = abs;
      this.time = abs % 24;
      if (k >= 1) this._skip = null;
    } else if (!this.paused) {
      let nt = this.time + dt * this.timeScale;
      if (this._drift) { const k = Math.min(1, dt * 0.5); nt += this._drift * k; this._drift *= 1 - k; if (Math.abs(this._drift) < 1e-4) this._drift = 0; }
      if (nt < 0) nt += 24;
      if (nt >= 24) this.day++;
      this.time = nt % 24;
    }
    this.uniforms.uSkyTime.value += dt;
    const t = this.time;
    const W = this._weather();
    const cover = W.cloud;

    // ---- sun & moon
    const H = ((t - 12) / 24) * Math.PI * 2;
    celestial(H, DECL, this.sunDir);
    GLOBAL_UNIFORMS.uSunDir.value.copy(this.sunDir);
    const sunEl = Math.asin(this.sunDir.y);
    this.sunElevation = sunEl / DEG;
    const dayF = this.day + t / 24;
    this.moonPhase = 0.5 + 0.27 * Math.sin((dayF / LUNAR_DAYS) * Math.PI * 2);
    celestial(H + Math.PI - (this.moonPhase - 0.5) * Math.PI * 2, DECL * 0.6, this.moonDir);
    const alpha = Math.abs(this.moonPhase - 0.5) * Math.PI * 2; // 0 full .. pi new
    this.moonIllum = (1 + Math.cos(alpha)) / 2;
    _v.copy(this.sunDir).addScaledVector(this.moonDir, -this.sunDir.dot(this.moonDir));
    if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0);
    _v.normalize();
    this.uniforms.uMoonLight.value.copy(this.moonDir).multiplyScalar(-Math.cos(alpha)).addScaledVector(_v, Math.sin(alpha)).normalize();
    const moonEl = Math.asin(this.moonDir.y);

    this.night = clamp((-this.sunElevation + 1) / 9, 0, 1);
    this.uniforms.uNight.value = this.night;
    GLOBAL_UNIFORMS.uNight.value = this.night;

    // ---- atmosphere (LUT + CPU colours) when the sun or haze changed noticeably
    const haze = W.haze;
    const ms = 0.032 * smooth(sunEl, -10 * DEG, 6 * DEG) + 0.0015;
    const key = Math.round(sunEl / DEG * 20) * 4096 + Math.round(haze * 50);
    if (key !== this._lutKey) {
      this._lutKey = key;
      const lu = this.lutUniforms;
      lu.uSunEl.value = sunEl; lu.uHaze.value = haze; lu.uMs.value = ms;
      const r = this.renderer, prev = r.getRenderTarget();
      r.setRenderTarget(this.lutRT);
      r.render(this.lutQuad, this._quadCam);
      r.setRenderTarget(prev);
      this._atmo = this._computeColors(sunEl, haze, ms);
    }
    const A = this._atmo;

    // ---- weather shaping
    const thick = smooth(cover, 0.45, 1.0);
    const sunDim = (1 - 0.86 * thick) * (1 - 0.3 * W.dark);
    const overAmt = clamp(smooth(cover, 0.5, 0.95) * 0.9 + W.mist * 0.6 + W.rain * 0.2, 0, 1);
    // overcast grey keyed to how much light the deck lets through
    const dayLight = smooth(sunEl, -6 * DEG, 20 * DEG);
    const greyL = (0.06 + 0.5 * dayLight) * (1 - 0.6 * W.dark) * (1 - 0.92 * this.night) + 0.004;
    const u = this.uniforms;
    u.uOvercastCol.value.set(greyL * 0.97, greyL, greyL * 1.04).lerp(A.horizonAvg, 0.25 * (1 - thick));
    u.uOvercastAmt.value = overAmt;
    u.uCloudDark.value = W.dark;
    u.uCirrus.value = W.cirrus * (1 - thick);
    u.uStars.value = smooth(-sunEl, 4 * DEG, 14 * DEG) * (1 - 0.95 * thick) * (1 - W.mist);
    u.uMoonBright.value = 0.28 * (1 - 0.95 * thick);
    u.uFlashDir.value.copy(this.game?.weather?.flashDir || _v.set(0, 1, 0));
    u.uSunDisc.value.copy(A.tGround).multiplyScalar(140 * (1 - thick));
    u.uSunCloud.value.copy(A.tCloud).multiplyScalar(1.15 * (SUN_E / Math.PI) * (1 - 0.45 * thick));
    u.uSunCirrus.value.copy(A.tCirrus).multiplyScalar(0.9);
    // city light pollution (orange/pink), stronger under clouds and in rain
    const glow = this.night * (0.01 + 0.016 * cover + 0.008 * W.rain);
    u.uCityGlow.value.set(0.7, 0.45, 0.68).multiplyScalar(glow);
    u.uNightSky.value.set(0.012, 0.02, 0.048).multiplyScalar(this.night * (0.55 + 0.45 * this.moonIllum) * (1 - 0.5 * thick));
    // cloud ambient: sky above (+ moonlit blue at night), ground/city bounce below
    const moonSky = this.night * (0.5 + 0.5 * this.moonIllum) * (1 - 0.6 * thick);
    u.uAmbTop.value.copy(A.ambTop).multiplyScalar(1 - 0.5 * W.dark);
    u.uAmbTop.value.x += 0.016 * moonSky; u.uAmbTop.value.y += 0.024 * moonSky; u.uAmbTop.value.z += 0.05 * moonSky;
    u.uAmbBottom.value.copy(A.ambBottom).multiplyScalar(1 - 0.5 * W.dark).addScaledVector(u.uCityGlow.value, 3);
    u.uGround.value.copy(A.ground).multiplyScalar(sunDim * 0.7 + 0.3).lerp(u.uOvercastCol.value, overAmt * 0.5);
    u.uStarRot.value.setFromMatrix4(_m4.makeRotationAxis(_pole, -(dayF * 1.0027) * Math.PI * 2));
    const cam = this.game?.camera;
    u.uCamPos.value.copy(cam ? cam.position : focus);

    // public colours (legacy API: Water, UI)
    this.zenith.setRGB(A.zenith.x, A.zenith.y, A.zenith.z).lerp(_c.setRGB(greyL, greyL, greyL * 1.04), overAmt);
    this.horizon.setRGB(A.horizonAvg.x, A.horizonAvg.y, A.horizonAvg.z).lerp(_c.setRGB(u.uOvercastCol.value.x, u.uOvercastCol.value.y, u.uOvercastCol.value.z), overAmt);
    this.fogColor.copy(this.horizon);

    // ---- lights
    const sunI = SUN_E * sunDim * smooth(sunEl, -1.5 * DEG, 1 * DEG);
    // night key: cool "moonlight" that never goes black (GTA-style readable blue night)
    const moonUp = smooth(moonEl, 2 * DEG, 15 * DEG);
    const moonI = (0.5 + 0.25 * this.moonIllum * moonUp) * this.night * (1 - 0.55 * thick);
    const wDay = smooth(sunEl, -4 * DEG, 1.5 * DEG);
    // moon direction when it is up, otherwise a fixed high key from the south-east
    _v.set(0.35, 0.85, 0.4).normalize().lerp(_v2.copy(this.moonDir), moonUp);
    if (_v.y < 0.35) _v.y = 0.35;
    _v2.copy(this.sunDir);
    if (_v2.y < 0.07) _v2.y = 0.07;
    this.lightDir.copy(_v.normalize()).lerp(_v2.normalize(), wDay).normalize();
    this.sunColor.setRGB(A.tGround.x, A.tGround.y, A.tGround.z).multiplyScalar(1 / Math.max(A.tGround.y, 0.25));
    this.sunColor.r = Math.min(this.sunColor.r, 1.6);
    const moonCol = _c.setRGB(0.55, 0.68, 1.0);
    const lightCol = _lc.copy(moonCol).lerp(this.sunColor, wDay);
    const intensity = lerp(moonI, sunI * A.tGround.y / Math.max(A.tGround.y, 0.25), wDay);
    const flash = GLOBAL_UNIFORMS.uLightning.value;
    for (const L of [this.sun, this.sunCSM]) { L.color.copy(lightCol); L.intensity = intensity; }
    const shadowK = 1 - 0.85 * thick;
    this.sun.shadow.intensity = this.sunCSM.shadow.intensity = clamp(shadowK * smooth(intensity, 0.02, 0.4), 0, 1);
    // hemisphere fill: sky above / warm ground bounce; lower when the sky probe provides ambient
    const envK = this.envEnabled ? 0.45 : 1;
    this.hemi.color.setRGB(A.ambTop.x, A.ambTop.y, A.ambTop.z).multiplyScalar(2.2).lerp(_c.setRGB(greyL, greyL, greyL * 1.05).multiplyScalar(2.0), thick);
    this.hemi.groundColor.setRGB(A.ambBottom.x, A.ambBottom.y, A.ambBottom.z).multiplyScalar(2.5);
    // night fill: blue sky light from above, dim warm city bounce from below (keeps silhouettes readable)
    const nf = this.night;
    this.hemi.color.r += 0.11 * nf; this.hemi.color.g += 0.15 * nf; this.hemi.color.b += 0.3 * nf;
    this.hemi.groundColor.r += 0.07 * nf; this.hemi.groundColor.g += 0.06 * nf; this.hemi.groundColor.b += 0.07 * nf;
    this.hemi.color.r += u.uCityGlow.value.x * 4; this.hemi.color.g += u.uCityGlow.value.y * 4; this.hemi.color.b += u.uCityGlow.value.z * 4 + 0.012 * this.night;
    this.hemi.groundColor.r += u.uCityGlow.value.x * 8; this.hemi.groundColor.g += u.uCityGlow.value.y * 8; this.hemi.groundColor.b += u.uCityGlow.value.z * 8;
    this.hemi.intensity = lerp(envK, 1, nf) * (1 + flash * 6);
    if (flash > 0) this.hemi.color.lerp(_c.setRGB(0.7, 0.8, 1.0), Math.min(1, flash));
    this.scene.environmentIntensity = 0.75;

    // ---- fog (bootstrap divides density by camera altitude afterwards)
    this.scene.fog.color.copy(this.fogColor);
    this.scene.fog.density = W.fogDensity * (this.quality?.fogScale ?? 1);

    // ---- shadow cameras
    if (this.sun.visible) {
      const half = this._shadowHalf || 140;
      const dist = 900;
      const snap = (half * 2) / this.sun.shadow.mapSize.x;
      let fx = focus.x, fz = focus.z;
      if (cam) { // push the map forward along the view so more of the visible ground is covered
        cam.getWorldDirection(_v2);
        const l = Math.hypot(_v2.x, _v2.z) || 1;
        fx += (_v2.x / l) * half * 0.45; fz += (_v2.z / l) * half * 0.45;
      }
      fx = Math.round(fx / snap) * snap; fz = Math.round(fz / snap) * snap;
      this.sun.target.position.set(fx, focus.y, fz);
      this.sun.position.set(fx + this.lightDir.x * dist, focus.y + this.lightDir.y * dist, fz + this.lightDir.z * dist);
      this.sun.target.updateMatrixWorld();
    }
    this.sunCSM.position.copy(this.lightDir);
    this.dome.position.set(0, 0, 0);

    // ---- exposure keyed to light level + weather
    const expo = lerp(0.9, 1.3, this.night) + 0.16 * thick * (1 - this.night) + 0.1 * W.rain + 0.15 * smooth(-sunEl, -2 * DEG, 5 * DEG) * (1 - this.night);
    this.exposure = expo;
    this.renderer.toneMappingExposure = expo;

    // ---- reflection probe
    this._envTimer += dt;
    if (this.envEnabled) {
      const ek = Math.round(sunEl / DEG * 5) + 1e3 * Math.round(cover * 50) + 1e5 * Math.round(W.dark * 20) + 1e7 * Math.round(overAmt * 20);
      const interval = this._skip ? 0.1 : (this.envInterval ?? 0.5);
      if (this._probeStep >= 0) this._stepProbe();
      else if (this._envTimer >= interval && (ek !== this._envKey || this._envTimer > interval * 8)) {
        this._envKey = ek;
        this._envTimer = 0;
        this._probeStep = 0;
        this._stepProbe();
      }
    }
  }

  // CPU twin of the LUT for light colours (cheap: called only when the sun moved)
  _computeColors(sunEl, haze, ms) {
    const S = SKY_SCALE;
    const z = skyRadiance(85 * DEG, 0, sunEl, haze, ms).multiplyScalar(S);
    const h0 = skyRadiance(1.5 * DEG, 0, sunEl, haze, ms).multiplyScalar(S);
    const h90 = skyRadiance(1.5 * DEG, Math.PI / 2, sunEl, haze, ms).multiplyScalar(S);
    const h180 = skyRadiance(1.5 * DEG, Math.PI, sunEl, haze, ms).multiplyScalar(S);
    const m30 = skyRadiance(30 * DEG, Math.PI / 2, sunEl, haze, ms).multiplyScalar(S);
    const horizonAvg = h0.clone().add(h90.clone().multiplyScalar(2)).add(h180).multiplyScalar(0.25);
    const tGround = transmittance(0.05, sunEl, haze);
    const tCloud = transmittance(1.6, sunEl, haze);
    const tCirrus = transmittance(8, sunEl, haze);
    // average sky radiance over the upper hemisphere ≈ irradiance / pi
    const ambTop = z.clone().add(m30.clone().multiplyScalar(2)).add(horizonAvg).multiplyScalar(0.25);
    const sunGround = Math.max(0, Math.sin(sunEl)) * SUN_E / Math.PI;
    const ground = new THREE.Vector3(0.21, 0.19, 0.16).multiplyScalar(sunGround).multiply(tGround).addScaledVector(ambTop, 0.25);
    const ambBottom = ground.clone().multiplyScalar(0.8);
    return { zenith: z, horizonAvg, h0, h180, tGround, tCloud, tCirrus, ambTop, ambBottom, ground };
  }

  // Full probe update in one go (startup, labs). The game loop uses the amortized _stepProbe().
  updateProbe() {
    this._probeStep = 0;
    while (this._probeStep >= 0) this._stepProbe();
  }

  // one slice of the probe update per frame (~0.1–0.4 ms each instead of a ~1 ms spike)
  _stepProbe() {
    const r = this.renderer;
    const gpu = this.game?.render?.gpu;
    gpu?.begin('skyProbe');
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = true;
    const step = this._probeStep;
    if (step === 0) {
      this.cubeCam.update(r, this.envScene); // sky → source cube (mips generated automatically)
    } else {
      const levels = this.envRT.texture.mipmaps.length;
      const maxLod = levels - 1;
      const size = this.probeSize;
      const fu = this.filterUniforms;
      fu.uSrc.value = this.srcRT.texture;
      const l0 = step === 1 ? 0 : 3, l1 = step === 1 ? 2 : maxLod;
      for (let lod = l0; lod <= l1; lod++) {
        const rough = 1 - Math.sqrt(1 - lod / maxLod);
        const last = lod === maxLod;
        const spread = lod === 0 ? 0 : last ? 1.45 : Math.min(1.2, 2.2 * rough * rough + 0.02);
        fu.uSpread.value = spread;
        fu.uCosine.value = last ? 1 : 0;
        fu.uCount.value = [1, 8, 12, 16, 24, 32][lod] || 32;
        const texel = (Math.PI / 2) / size;
        fu.uSrcLod.value = spread === 0 ? 0 : clamp(Math.log2((spread * 0.45) / texel), 0, Math.log2(size));
        this.filterCam.activeMipmapLevel = lod;
        const s = Math.max(1, size >> lod);
        this.envRT.viewport.set(0, 0, s, s);
        this.filterCam.update(r, this.filterMesh);
        this.envRT.viewport.set(0, 0, size, size);
      }
    }
    r.autoClear = prevAuto;
    r.setRenderTarget(prevTarget);
    gpu?.end();
    this._probeStep = step >= 2 ? -1 : step + 1;
  }

  get clock() {
    const h = Math.floor(this.time), m = Math.floor((this.time - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // diagnostics for labs
  get lum() { return lum(this._atmo?.zenith || _v.set(0, 0, 0)); }
}
