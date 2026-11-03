import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../core/globals.js';
import { WEATHER_STATES, WEATHER_NAMES, WEATHER_LABELS, WEATHER_NEXT, resolveWeatherName, weatherFromNumeric } from './presets.js';
import { WET_UNIFORMS, MAX_WET_LAMPS } from './wetMaterial.js';
import { Rain } from './Rain.js';
import { Lightning, flashPulses, pulseValue } from './Lightning.js';

const PARAMS = ['cloud', 'dark', 'rain', 'fog', 'mist', 'haze', 'cirrus', 'wind', 'lightning'];
const CLOUDY = new Set(['cloud', 'dark', 'haze', 'fog', 'mist', 'cirrus', 'wind']);
const smooth = THREE.MathUtils.smoothstep;
const clamp = THREE.MathUtils.clamp;
const _v = new THREE.Vector3();

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * game.weather — weather state machine, rain/lightning effects and the global weather uniforms.
 * Register it as a module (`game.register(new Weather(game), 40)` or via createGame `modules`).
 * Fields: name (preset id), state (blended snapshot), rain, wetness, cloud, fog, wind {x, z, strength}, auto.
 * Methods: set(presetOrNumeric, {transitionS} | seconds), setAuto(on), label(name).
 * In online mode (game.can('weather') === false) the local scheduler and the settings handler are off:
 * the server is the only source (it calls set()).
 */
export class Weather {
  constructor(game, opts = {}) {
    this.game = game;
    this.order = 40;
    this.random = rng(opts.seed ?? (Date.now() & 0xffffffff));
    const start = resolveWeatherName(opts.state) || 'clear';
    this.name = start; // preset id we are at / transitioning to (closest preset for numeric targets)
    this.target = start;
    this.prev = start;
    this.cur = { ...WEATHER_STATES[start] };
    this.from = { ...this.cur };
    this.to = { ...this.cur };
    this.tt = 1; this.tDur = 1;
    this.auto = true;
    this.hold = 120 + this.random() * 120;
    this.wetness = 0;
    this.rain = 0;
    this.cloud = this.cur.cloud;
    this.fog = 0;
    this.windAngle = this.random() * Math.PI * 2;
    this.wind = { x: 0, z: 0, strength: this.cur.wind };
    this.cover = 0; // camera under a roof/bridge 0..1
    this.lens = 0; // raindrops on the lens 0..1 (read by the renderer)
    this.flash = 0;
    this.flashDir = new THREE.Vector3(0, 1, 0);
    this.camVel = new THREE.Vector3();
    this._lastCam = null;
    this._strikeT = 6;
    this._pulses = [];
    this._pulseT = 0;
    this._flashScale = 0;
    this._coverT = 0;
    this._lampT = 0;
    this._lampIds = [];
    this.sky = { cloud: this.cur.cloud, dark: 0, haze: 1, cirrus: 0.5, fogDensity: 1e-4, mist: 0, rain: 0 };
    this.post = { mist: 0, mistHeight: 35, lens: 0 };
    this.enabled = { rain: true, splashes: true, lightning: true, lens: true };

    this.rainFx = new Rain(game.scene, game.terrain, WET_UNIFORMS);
    this.lightning = new Lightning(game.scene);
    game.quality?.onChange?.((q) => this.applyQuality(q)); // geometry budgets only, same materials
    if (game.quality) this.applyQuality(game.quality);

    // wire the other F modules to the game context
    game.render?.attach?.(game);
    game.sky?.attach?.(game);
    game.water?.attach?.(game);

    this.local = game.can ? game.can('weather') : true;
    if (this.local) {
      game.onSetting?.('weather', (v) => this.applySetting(v));
      this.applySetting(opts.state || game.settings?.weather || 'auto', true);
    } else {
      this.auto = false; // online: the server drives the weather through set()
      if (opts.state) this.set(opts.state, 0);
    }
  }

  // Current blended weather (what is on screen now)
  get state() {
    const c = this.cur;
    return {
      name: this.name, rain: c.rain, cloud: c.cloud, fog: c.fog, mist: c.mist, wind: Math.min(1, c.wind / 16), windMs: c.wind,
      storm: c.lightning > 0.5, dark: c.dark, wetness: this.wetness, transition: this.tDur > 0 ? Math.min(1, this.tt / this.tDur) : 1,
    };
  }

  applyQuality(q) { this.rainFx.setBudget(q.rainParticles ?? 12000, q.splashes ?? 900); }

  applySetting(v, instant = false) {
    if (!v || v === 'auto') { this.setAuto(true); return; }
    const name = resolveWeatherName(v);
    if (name) { this.auto = false; this.set(name, instant ? 0 : 25); }
  }

  label(name = this.name) {
    const t = this.game.i18n?.t?.(`weather.${name}`);
    return t && t !== `weather.${name}` ? t : WEATHER_LABELS[name] ?? name;
  }

  get names() { return WEATHER_NAMES; }

  setAuto(on = true) {
    this.auto = on && this.local !== false;
    if (on) this.hold = Math.min(this.hold, 30 + this.random() * 60);
  }

  /**
   * Smoothly blend to a preset id ('clear', 'partly', 'overcast', 'lightRain', 'heavyRain', 'storm', 'fog')
   * or to a numeric state {rain 0..1, cloud 0..1, wind 0..1, fog 0..1, storm bool}.
   * opts: transition seconds (number) or { transitionS } (0 = instant). Does not change `auto`.
   */
  set(target, opts = 45) {
    const seconds = typeof opts === 'number' ? opts : (opts?.transitionS ?? opts?.seconds ?? 45);
    let name, params;
    if (target && typeof target === 'object') ({ name, params } = weatherFromNumeric(target));
    else {
      name = resolveWeatherName(target);
      if (!name) return false;
      params = WEATHER_STATES[name];
    }
    const changed = name !== this.name;
    this.prev = this.name;
    this.from = { ...this.cur };
    this.to = { ...params };
    this.tt = 0;
    this.tDur = Math.max(0.0001, seconds);
    this.name = this.target = name;
    if (seconds <= 0) { this.cur = { ...this.to }; this.tt = this.tDur; }
    this._strikeT = Math.min(this._strikeT, 4 + this.random() * 6);
    if (changed || typeof target !== 'object') this.game.events?.emit('weather', { state: name, name, seconds, label: this.label(name) });
    return true;
  }

  _pickNext() {
    const hour = this.game.sky?.time ?? 12;
    const w = { ...(WEATHER_NEXT[this.name] || WEATHER_NEXT.clear) };
    const afternoon = hour > 13 && hour < 19.5;
    const morning = hour > 4 && hour < 9.5;
    if (afternoon) { if (w.storm) w.storm *= 2.2; if (w.heavyRain) w.heavyRain *= 1.6; }
    if (w.fog) w.fog *= morning ? 3 : 0.25;
    let sum = 0;
    for (const k in w) sum += w[k];
    let r = this.random() * sum;
    for (const k in w) { r -= w[k]; if (r <= 0) return k; }
    return 'clear';
  }

  update(dt, game = this.game) {
    if (dt <= 0) return;
    const u = GLOBAL_UNIFORMS;
    // ---- schedule
    if (this.auto && this.local && this.tt >= this.tDur) {
      this.hold -= dt;
      if (this.hold <= 0) {
        const next = this._pickNext();
        const rainy = WEATHER_STATES[next].rain > 0;
        this.set(next, 30 + this.random() * 60);
        this.hold = (rainy ? 60 + this.random() * 140 : 120 + this.random() * 220);
      }
    }
    // ---- transition (clouds lead when it gets wetter, rain stops first when it clears)
    if (this.tt < this.tDur) {
      this.tt = Math.min(this.tDur, this.tt + dt);
      const k = this.tt / this.tDur;
      const wetter = this.to.rain >= this.from.rain;
      for (const p of PARAMS) {
        const lead = CLOUDY.has(p) === wetter;
        const kk = lead ? smooth(k, 0, 0.7) : smooth(k, 0.35, 1);
        this.cur[p] = this.from[p] + (this.to[p] - this.from[p]) * kk;
      }
    }
    const c = this.cur;
    this.rain = c.rain;
    this.cloud = c.cloud;
    this.fog = c.fog;

    // ---- wind: slow random walk of the direction, gusts
    const t = game.time ?? 0;
    this.windAngle += (Math.sin(t * 0.013) * 0.004 + (this.random() - 0.5) * 0.002) * dt * 60 * 0.1;
    const gust = 1 + 0.25 * Math.sin(t * 0.37) * Math.sin(t * 0.11 + 1.3) * Math.min(1, c.wind / 6);
    const ws = c.wind * gust;
    this.wind.strength = ws;
    this.wind.x = Math.cos(this.windAngle) * ws;
    this.wind.z = Math.sin(this.windAngle) * ws;
    u.uWind.value.set(this.wind.x, 0, this.wind.z);
    // clouds drift with the upper wind (stronger than at ground level)
    const cd = 1.6 + c.wind * 0.25;
    const off = u.uCloudOffset.value;
    off.x -= Math.cos(this.windAngle) * (3 + ws) * cd * dt;
    off.y -= Math.sin(this.windAngle) * (3 + ws) * cd * dt;
    if (Math.abs(off.x) > 1e6) off.x %= 1e5;
    if (Math.abs(off.y) > 1e6) off.y %= 1e5;

    // ---- wetness: soaks in rain, dries faster in sun
    const sunUp = smooth(game.sky?.sunDir?.y ?? 0.5, 0, 0.4);
    if (c.rain > 0.02) this.wetness = Math.min(1, this.wetness + dt * c.rain * 0.028);
    else this.wetness = Math.max(0, this.wetness - dt * (0.0018 + 0.0065 * sunUp * (1 - 0.6 * c.cloud)));
    u.uWetness.value = this.wetness;
    u.uRain.value = c.rain;
    u.uCloudCover.value = c.cloud;

    // ---- sky / post parameters
    const s = this.sky;
    s.cloud = c.cloud; s.dark = c.dark; s.haze = c.haze; s.cirrus = c.cirrus; s.mist = c.mist; s.rain = c.rain;
    s.fogDensity = 0.000085 + c.fog * 0.0009 + c.rain * 0.00015;
    this.post.mist = c.mist * 0.011 + c.rain * 0.0009;
    this.post.mistHeight = 30 + c.rain * 40;

    // ---- camera: velocity, cover test
    const cam = game.camera;
    if (cam) {
      if (this._lastCam) {
        _v.copy(cam.position).sub(this._lastCam).divideScalar(dt);
        if (_v.lengthSq() > 200 * 200) _v.set(0, 0, 0); // teleport
        this.camVel.lerp(_v, Math.min(1, dt * 8));
      } else this._lastCam = new THREE.Vector3();
      this._lastCam.copy(cam.position);
      this._coverT -= dt;
      if (this._coverT <= 0) { this._coverT = 0.25; this._covered = this._testCover(cam.position); }
      this.cover += ((this._covered ? 1 : 0) - this.cover) * Math.min(1, dt * 4);
      // under water: no rain on the lens
      const under = cam.position.y < 0 && (game.terrain?.heightAt?.(cam.position.x, cam.position.z) ?? 0) < 0;
      // lens drops: build up quickly in rain, evaporate slowly
      const facing = cam.getWorldDirection(_v).y;
      const exposure = c.rain * (1 - this.cover) * (under ? 0 : 1) * (0.75 + 0.25 * smooth(facing, -0.3, 0.4));
      const rate = exposure > this.lens ? 0.6 : 0.12;
      this.lens += (exposure - this.lens) * Math.min(1, dt * rate);
      if (under) this.lens = 0;
      this.post.lens = this.enabled.lens ? this.lens : 0;
    }

    // ---- lamps near the camera (wet streak reflections + drops lighting)
    this._lampT -= dt;
    if (this._lampT <= 0) { this._lampT = 0.3; this._updateLamps(); }

    // ---- lightning
    this._updateLightning(dt, c);

    // ---- rain particles
    if (cam) {
      const sky = game.sky;
      const hc = sky?.hemi.color;
      const amb = hc ? _ambient.set(hc.r, hc.g, hc.b).multiplyScalar(0.18 * sky.hemi.intensity + 0.05) : _ambient.set(0.15, 0.16, 0.18);
      const sunCol = sky ? _sunc.set(sky.sunColor.r, sky.sunColor.g, sky.sunColor.b).multiplyScalar(0.15 * (1 - sky.night) * (1 - 0.8 * smooth(c.cloud, 0.5, 1))) : _sunc.set(0, 0, 0);
      this.rainFx.update(dt, c.rain, cam, u.uWind.value, this.camVel, { ambient: amb, sunCol, sunDir: sky ? sky.sunDir : _v.set(0, 1, 0) }, this.cover, this.flash, this.enabled.rain);
      if (!this.enabled.splashes) this.rainFx.splashes.visible = false;
    }
  }

  _testCover(p) {
    const g = this.game;
    if (!g.world || !g.RAPIER) return false;
    try {
      if (!this._ray) this._ray = new g.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
      this._ray.origin = { x: p.x, y: p.y + 0.2, z: p.z };
      const G = g.groups?.GROUPS;
      const filter = G ? g.groups.groups(0xffff, G.STATIC) : undefined;
      const hit = g.world.castRay(this._ray, 120, true, undefined, filter);
      return !!hit;
    } catch { return false; }
  }

  _updateLamps() {
    const g = this.game;
    const lamps = WET_UNIFORMS.uWxLamps.value;
    const sc = g.lamps?.scatter;
    const night = g.sky?.night ?? 0;
    const cam = g.camera;
    if (!sc?.raw || !cam || night < 0.05) { WET_UNIFORMS.uWxLampCount.value = 0; return; }
    this._lampIds.length = 0;
    const ids = sc.near(cam.position.x, cam.position.z, 160, this._lampIds);
    const r = sc.raw;
    // keep the MAX_WET_LAMPS nearest (insertion into a small sorted buffer, no allocations)
    const best = this._lampBest || (this._lampBest = new Float32Array(MAX_WET_LAMPS * 4));
    let n = 0;
    for (const id of ids) {
      if (g.lamps.broken?.has?.(id) || sc.hidden?.has?.(id)) continue;
      const yaw = r[id * 6 + 3];
      const x = r[id * 6] + Math.sin(yaw) * 2.0, y = r[id * 6 + 1] + 8.2, z = r[id * 6 + 2] + Math.cos(yaw) * 2.0;
      const dx = x - cam.position.x, dz = z - cam.position.z, d = dx * dx + dz * dz;
      let i;
      if (n < MAX_WET_LAMPS) i = n++;
      else if (d < best[(MAX_WET_LAMPS - 1) * 4 + 3]) i = MAX_WET_LAMPS - 1;
      else continue;
      while (i > 0 && best[(i - 1) * 4 + 3] > d) { best.copyWithin(i * 4, (i - 1) * 4, i * 4); i--; }
      best[i * 4] = x; best[i * 4 + 1] = y; best[i * 4 + 2] = z; best[i * 4 + 3] = d;
    }
    for (let i = 0; i < n; i++) lamps[i].set(best[i * 4], best[i * 4 + 1], best[i * 4 + 2], night);
    WET_UNIFORMS.uWxLampCount.value = n;
  }

  _updateLightning(dt, c) {
    const g = this.game;
    const u = GLOBAL_UNIFORMS;
    if (c.lightning > 0.01 && this.enabled.lightning) {
      this._strikeT -= dt * c.lightning;
      if (this._strikeT <= 0) {
        this._strikeT = 3 + this.random() * 11;
        this.strike();
      }
    }
    this._pulseT += dt;
    this.flash = pulseValue(this._pulses, this._pulseT) * this._flashScale;
    u.uLightning.value = this.flash || 0;
    this.lightning.update(dt);
  }

  // Forces a strike (optionally at a position). Emits `lightning` {position, distance}.
  strike(position = null, withBolt = null) {
    const g = this.game;
    const cam = g.camera?.position || new THREE.Vector3();
    const R = this.random;
    let p = position;
    if (!p) {
      const a = R() * Math.PI * 2;
      const d = R() < 0.15 ? 180 + R() * 400 : 600 + R() * 3200;
      p = new THREE.Vector3(cam.x + Math.cos(a) * d, 0, cam.z + Math.sin(a) * d);
      p.y = Math.max(g.terrain?.heightAt?.(p.x, p.z) ?? 0, 0);
    }
    const bolt = withBolt ?? R() < 0.7;
    const top = new THREE.Vector3(p.x + (R() - 0.5) * 300, 1500 + R() * 300, p.z + (R() - 0.5) * 300);
    const pos = bolt ? p : top;
    const distance = Math.hypot(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z);
    this._pulses = bolt && this.enabled.lightning ? this.lightning.strike(top, p, R) : flashPulses(R);
    this._pulseT = 0;
    this._flashScale = clamp(1.3 - distance / 4000, 0.3, 1) * (bolt ? 1 : 0.6);
    this.flashDir.set(top.x - cam.x, top.y - cam.y, top.z - cam.z).normalize();
    g.events?.emit('lightning', { position: { x: pos.x, y: pos.y, z: pos.z }, distance, cloud: !bolt });
  }

  dispose() {
    this.rainFx.dispose();
    this.lightning.dispose();
  }
}

const _ambient = new THREE.Vector3(), _sunc = new THREE.Vector3();
