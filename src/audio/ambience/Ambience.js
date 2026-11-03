// World ambience driven by the listener's surroundings: city hum, ocean, birds/gulls (day), insects, crickets/frogs
// (night, wetlands), wind (altitude/weather/speed), rain, thunder, underwater, distant sirens/horns/helicopters.
import { clamp, approach, ramp, smoothstep, disconnectAll } from '../core/util.js';
import { Siren, Horn } from '../sfx/Synths.js';
import { Voice3D } from '../core/Voice3D.js';
import { EngineVoice } from '../engine/EngineVoice.js';

const RINGS = [22, 60, 140];
const DIRS = 12;

export class Ambience {
  constructor(sys) {
    this.sys = sys;
    const ctx = (this.ctx = sys.ctx);
    this.in = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; this.lp.Q.value = 0.5;
    this.in.connect(this.lp).connect(sys.mixer.bus.ambient);
    this.beds = {};
    this.env = { urban: 0, water: 0, waterDist: 999, waterDir: { x: 0, z: 0 }, nature: 0, wetland: 0, sand: 0, building: 0, alt: 0, underwater: 0, traffic: 0 };
    this.lv = {};
    this.analysisT = 0;
    this.override = null; // lab: { urban, water, nature, wetland, sand, alt, underwater, night, rain, wind, hour }
    this.timers = { bird: 2, gull: 3, frog: 2, horn: 8, siren: 30, heli: 90, passby: 3, pigeon: 4 };
    this.events = [];
    this.gust = 0;
    this.gustBoost = 0;
    this.snapNext = true;
    this.prevUnder = 0;
    this.camPrev = null;
    this.camSpeed = 0;
    // wind: stereo pink noise → band-pass, gusty
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = sys.bank.noise.pink;
    this.windSrc.loop = true;
    this.windBp = ctx.createBiquadFilter();
    this.windBp.type = 'bandpass'; this.windBp.Q.value = 0.9; this.windBp.frequency.value = 400;
    this.windLp = ctx.createBiquadFilter();
    this.windLp.type = 'lowpass'; this.windLp.Q.value = -3; this.windLp.frequency.value = 1400;
    this.windG = ctx.createGain();
    this.windG.gain.value = 0;
    this.windSrc.connect(this.windBp).connect(this.windLp).connect(this.windG).connect(this.in);
    this.windSrc.start();
    // rain beds are softened (no sizzle above ~5 kHz)
    this.rainLp = ctx.createBiquadFilter();
    this.rainLp.type = 'lowpass'; this.rainLp.Q.value = -3; this.rainLp.frequency.value = 5000;
    this.rainLp.connect(this.in);
  }

  bed(name, pan = false) {
    let b = this.beds[name];
    if (b) return b;
    const buf = this.sys.bank.get(name);
    if (!buf) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    let node = src.connect(gain);
    let panner = null;
    if (pan) { panner = ctx.createStereoPanner(); node = node.connect(panner); }
    node.connect(name === 'underwater' ? this.sys.mixer.bus.ambient : name.startsWith('rain_') ? this.rainLp : this.in);
    src.start(0, Math.random() * buf.duration);
    b = this.beds[name] = { src, gain, panner, level: 0 };
    return b;
  }

  setBed(name, level, tau = 1.2, pan = null, rate = 1) {
    if (level < 0.001 && !this.beds[name]) return;
    const b = this.bed(name, pan !== null);
    if (!b) return;
    const t = this.ctx.currentTime;
    ramp(b.gain.gain, level, t, this.snapNow ? 0.05 : tau, 2e-3);
    if (b.panner && pan !== null) ramp(b.panner.pan, pan, t, 0.5, 0.01);
    if (rate !== 1 || b.src.playbackRate.value !== 1) ramp(b.src.playbackRate, rate, t, 0.5, 1e-3);
  }

  analyze() {
    const sys = this.sys, g = sys.game, T = g?.terrain, L = sys.listener;
    const e = this.env;
    if (this.override) { Object.assign(e, this.override); sys.updateEnvironment(e); return; }
    if (!T) return;
    const G = T.G;
    let n = 0, water = 0, urban = 0, nature = 0, wet = 0, sand = 0, bld = 0, wx = 0, wz = 0, wd = 999;
    for (const r of RINGS) {
      for (let k = 0; k < DIRS; k++) {
        const a = (k + (r === 60 ? 0.5 : 0)) / DIRS * Math.PI * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        const x = L.x + dx * r, z = L.z + dz * r;
        const c = T.groundAt(x, z), h = T.heightAt(x, z);
        n++;
        if (h < -0.4 || (c === G.water && h < 0.6)) { water++; wx += dx / r; wz += dz / r; if (r < wd) wd = r; continue; }
        if (c === G.urban || c === G.paved || c === G.road || c === G.sport) urban++;
        else if (c === G.building) { urban++; bld++; }
        else if (c === G.grass || c === G.park || c === G.farm || c === G.dirt) nature++;
        else if (c === G.wetland) { wet++; nature += 0.5; }
        else if (c === G.sand) sand++;
      }
    }
    const wl = Math.hypot(wx, wz) || 1;
    e.water = water / n;
    e.waterDist = wd;
    e.waterDir = { x: wx / wl, z: wz / wl };
    e.urban = urban / n;
    e.building = bld / n;
    e.nature = nature / n;
    e.wetland = wet / n;
    e.sand = sand / n;
    const hc = T.heightAt(L.x, L.z);
    e.alt = Math.max(0, L.y - Math.max(0, hc));
    e.underwater = L.y < -0.3 && hc < L.y ? 1 : 0;
    let tc = 0;
    for (const a of g.traffic?.agents || []) if (Math.abs(a.cur.x - L.x) < 150 && Math.abs(a.cur.z - L.z) < 150) tc++;
    e.traffic = clamp(tc / 25, 0, 1);
    // reverb environment from surroundings
    sys.updateEnvironment(e);
  }

  update(dt) {
    const sys = this.sys, g = sys.game, L = sys.listener;
    this.analysisT -= dt;
    if (this.analysisT <= 0) { this.analysisT = 0.5; this.analyze(); }
    const e = this.env, o = this.override || {};
    const night = o.night ?? g?.sky?.night ?? g?.uniforms?.uNight?.value ?? 0;
    const day = 1 - night;
    const hour = o.hour ?? g?.sky?.time ?? 12;
    const rain = o.rain ?? sys.weatherRain();
    const weatherWind = o.wind ?? sys.weatherWind();
    const under = e.underwater;
    // camera speed (free-cam flying / aircraft) for wind rush
    if (this.camPrev) {
      const v = Math.hypot(L.x - this.camPrev.x, L.y - this.camPrev.y, L.z - this.camPrev.z) / Math.max(dt, 1e-3);
      this.camSpeed = approach(this.camSpeed, v < 200 ? v : this.camSpeed, dt, 0.4);
    }
    this.camPrev = { x: L.x, y: L.y, z: L.z };
    this.snapNow = this.snapNext;
    this.snapNext = false;
    const dry = 1 - under;
    const nat = clamp(e.nature * 1.4, 0, 1);
    const urb = clamp(e.urban * 1.25, 0, 1);
    const coast = e.water > 0 ? clamp(1 - (e.waterDist - 15) / 150, 0, 1) * clamp(e.water * 4, 0.3, 1) : 0;
    const R = sys.listenerRight;
    const wavePan = clamp((e.waterDir.x * R.x + e.waterDir.z * R.z) * 0.7, -0.8, 0.8);
    const altK = clamp(1 - e.alt / 300, 0.15, 1);

    // far traffic = a soft, warm bed (the near cars are individual voices)
    this.setBed('city_hum', dry * (urb * 0.2 + e.traffic * 0.12) * (0.6 + 0.4 * day) * altK * (1 - rain * 0.3), 1.5);
    this.setBed('waves', dry * coast * (0.55 + 0.25 * clamp(weatherWind / 10, 0, 1)) * clamp(1 - e.alt / 200, 0.2, 1), 1.5, wavePan);
    const hot = smoothstep(9, 11, hour) * (1 - smoothstep(17, 19.5, hour));
    this.setBed('insects', dry * day * hot * nat * (1 - rain) * 0.32 * altK, 2);
    this.setBed('crickets', dry * smoothstep(0.35, 0.8, night) * clamp(nat + urb * 0.25 + e.wetland, 0, 1) * (1 - rain * 0.7) * 0.4 * altK, 2.5);
    this.setBed('rain_light', dry * clamp(rain * 2.2, 0, 1) * 0.32, 1.2);
    this.setBed('rain_heavy', dry * smoothstep(0.35, 1, rain) * 0.38, 1.2);
    this.setBed('underwater', under * 0.6, 0.3);
    // foliage rustle in wind
    // streets shield the weather wind.
    // a camera riding the player's vehicle gets its speed wind from VehicleFoley; anything else (on foot, free
    // camera — even while the character sits in a car) hears wind from the camera's own speed
    const riding = sys.playerVehicle && (sys.camAttached ?? true);
    const ownSpeed = riding ? 0 : clamp(this.camSpeed / 90, 0, 1) * 0.6;
    const shield = 1 - 0.55 * urb * clamp(1 - e.alt / 60, 0, 1);
    const windAmt = clamp(0.04 + clamp(e.alt / 250, 0, 1) * 0.45 + (weatherWind / 22) * shield + ownSpeed + this.gustBoost * 0.4, 0, 1.3);
    this.setBed('grass_loop', dry * nat * clamp(weatherWind / 12 + this.gustBoost * 0.5, 0, 1) * 0.12 * altK, 1, null, 1.3);

    // wind: gusty band-pass noise
    this.gust = approach(this.gust, Math.random() * 2 - 1, dt, 0.7 + Math.random());
    this.gustBoost = Math.max(0, this.gustBoost - dt / 5);
    const t = this.ctx.currentTime;
    ramp(this.windG.gain, dry * windAmt * windAmt * 0.14 * (1 + 0.35 * this.gust), t, 0.3, 1e-3);
    ramp(this.windBp.frequency, (260 + windAmt * 600) * (1 + 0.25 * this.gust), t, 0.4, 5e-3);

    // in-cabin / underwater muffling of ambience
    const cab = sys.interior;
    ramp(this.lp.frequency, under ? 300 : cab > 0.01 ? 20000 * Math.pow(0.05, cab) : 20000, t, 0.15, 0.01);
    // ambience sits under the player's car when driving
    ramp(this.in.gain, (1 - 0.45 * cab) * (riding ? 0.8 : 1), t, 0.4, 1e-3);
    sys.mixer.setState('underwater', under);
    if (under !== this.prevUnder) { sys.play('splash', { variant: 1, volume: 0.5, bus: 'ambient' }); this.prevUnder = under; }

    // random emitters
    if (dry) {
      const tm = this.timers;
      const dawn = smoothstep(5, 6, hour) * (1 - smoothstep(7.5, 9, hour));
      const birdRate = day * nat * (1 - rain * 0.85) * (1 - urb * 0.5) * (0.35 + dawn * 0.8) * altK;
      const gullRate = day * clamp(coast + e.sand * 2, 0, 1) * (1 - rain * 0.8) * 0.22;
      const frogRate = smoothstep(0.4, 0.8, night) * (e.wetland * 2.5 + nat * 0.12) * (0.6 + rain * 0.8) * 0.5;
      this.emit('bird', dt, birdRate, () => this.critter('bird', 12, 45, 3, 14, 0.25 + Math.random() * 0.3, 0.85 + Math.random() * 0.3));
      this.emit('gull', dt, gullRate, () => this.critter('seagull', 15, 70, 8, 30, 0.3 + Math.random() * 0.3, 0.9 + Math.random() * 0.2));
      this.emit('frog', dt, frogRate, () => this.critter('frog', 8, 40, -1, 0, 0.25 + Math.random() * 0.25, 0.85 + Math.random() * 0.3));
      this.emit('horn', dt, urb * e.traffic * 0.05 + urb * 0.02, () => this.farHorn());
      // distinct city details instead of constant hiss: distant pass-bys a block away, sparrows/pigeons by day
      this.emit('passby', dt, urb * (0.06 + e.traffic * 0.1) * (0.5 + 0.5 * day), () => this.passby());
      this.emit('pigeon', dt, day * urb * (1 - rain) * 0.06 * altK, () => this.critter('bird', 10, 35, 4, 12, 0.12 + Math.random() * 0.12, 1.05 + Math.random() * 0.2));
      this.emit('siren', dt, urb * (0.006 + night * 0.006), () => this.farSiren());
      this.emit('heli', dt, (urb * 0.004 + 0.001), () => this.farHeli());
    }
    this.updateEvents(dt);
  }

  emit(key, dt, rate, fn) {
    if (rate <= 0) return;
    this.timers[key] -= dt * rate;
    if (this.timers[key] <= 0) { this.timers[key] = 0.4 + Math.random() * 1.6; fn(); }
  }

  around(rMin, rMax, yMin, yMax) {
    const L = this.sys.listener;
    const a = Math.random() * Math.PI * 2, r = rMin + Math.random() * (rMax - rMin);
    return { x: L.x + Math.cos(a) * r, y: Math.max(L.y - 1.5, (this.sys.game?.terrain?.heightAt?.(L.x, L.z) ?? 0)) + yMin + Math.random() * (yMax - yMin), z: L.z + Math.sin(a) * r };
  }

  critter(name, rMin, rMax, yMin, yMax, vol, pitch) {
    this.sys.play(name, { position: this.around(rMin, rMax, yMin, yMax), volume: vol, pitch, bus: 'ambient', ref: 8, hrtf: false, reverb: 0.35 });
  }

  passby() {
    const p = this.around(45, 110, 0.5, 1);
    this.sys.play('far_passby', { position: p, volume: 0.35 + Math.random() * 0.25, ref: 20, rolloff: 1, air: 0.8, bus: 'ambient', hrtf: false, reverb: 0.6, pitch: 0.9 + Math.random() * 0.2 });
  }

  farHorn() {
    if (this.events.length > 4) return;
    const p = this.around(80, 260, 0, 2);
    const voice = new Voice3D(this.sys, { position: p, ref: 9, bus: this.sys.mixer.bus.ambient, reverb: 0.7, hrtf: false });
    const types = ['car', 'car', 'luxury', 'truck', 'sport'];
    const horn = new Horn(this.sys, types[Math.floor(Math.random() * types.length)], voice.input);
    this.events.push({ voice, horn, t: 0.2 + Math.random() * 0.7 });
  }

  farSiren() {
    if (this.events.some((e) => e.siren)) return;
    const L = this.sys.listener;
    const a = Math.random() * Math.PI * 2, r = 250 + Math.random() * 300;
    const dir = a + Math.PI / 2 + (Math.random() - 0.5);
    const p = { x: L.x + Math.cos(a) * r, y: L.y, z: L.z + Math.sin(a) * r };
    const vel = { x: Math.cos(dir) * 22, z: Math.sin(dir) * 22 };
    const voice = new Voice3D(this.sys, { position: p, ref: 25, air: 0.4, bus: this.sys.mixer.bus.ambient, reverb: 0.8, hrtf: false });
    const siren = new Siren(this.sys, voice.input, Math.random() < 0.6 ? 'wail' : 'yelp');
    this.events.push({ voice, siren, p, vel, t: 9 + Math.random() * 7 });
  }

  farHeli() {
    if (this.events.some((e) => e.engine)) return;
    const L = this.sys.listener;
    const a = Math.random() * Math.PI * 2, r = 600;
    const p = { x: L.x + Math.cos(a) * r, y: L.y + 90 + Math.random() * 60, z: L.z + Math.sin(a) * r };
    const b = a + Math.PI + (Math.random() - 0.5) * 0.8;
    const vel = { x: Math.cos(b) * 45, z: Math.sin(b) * 45 };
    const engine = new EngineVoice(this.sys, 'heli', { position: p, ref: 40, volume: 0.8, destination: this.sys.mixer.bus.ambient, hrtf: false, reverb: 0.5 });
    engine.n1 = 1;
    this.events.push({ engine, p, vel, t: 26 });
  }

  updateEvents(dt) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      ev.t -= dt;
      if (ev.vel) { ev.p.x += ev.vel.x * dt; ev.p.z += ev.vel.z * dt; (ev.voice || ev.engine.voice).setPosition(ev.p.x, ev.p.y, ev.p.z); }
      if (ev.engine) ev.engine.update({ throttle: 0.6, collective: 0.6, speedKmh: 160 }, dt);
      if (ev.t > 0) continue;
      this.events.splice(i, 1);
      ev.horn?.stop();
      ev.siren?.stop(0.8);
      if (ev.engine) ev.engine.dispose(1.5);
      if (ev.voice) setTimeout(() => ev.voice.dispose(), 2000);
    }
  }

  thunder(e = {}) {
    const sys = this.sys, L = sys.listener;
    const d = e.distance ?? (e.position ? Math.hypot(e.position.x - L.x, e.position.z - L.z) : 1500 + Math.random() * 3000);
    const near = d < 1200;
    const delay = Math.min(d / 343, 10);
    let pan = 0;
    if (e.position) { const R = sys.listenerRight; const dx = e.position.x - L.x, dz = e.position.z - L.z, l = Math.hypot(dx, dz) || 1; pan = clamp((dx * R.x + dz * R.z) / l * 0.6, -0.6, 0.6); }
    const vol = near ? clamp(1.1 - d / 2500, 0.6, 1) : clamp(0.9 - d / 9000, 0.25, 0.7);
    sys.play(near ? 'thunder_near' : 'thunder_far', { bus: 'ambient', delay, volume: vol * (this.env.underwater ? 0.4 : 1), pan, pitch: 0.92 + Math.random() * 0.12 });
    if (near && d < 400) setTimeout(() => sys.mixer.duck(0.25, 0.01, 0.3, 1.5), delay * 1000);
  }

  onWeather(e = {}) {
    const s = String(e.state || '').toLowerCase();
    if (/storm|thunder|rain|wind/.test(s)) this.gustBoost = 1;
  }

  snap() { this.snapNext = true; this.analysisT = 0; }

  dispose() {
    for (const b of Object.values(this.beds)) { try { b.src.stop(); } catch { /* */ } disconnectAll(b.src, b.gain, b.panner); }
    for (const ev of this.events) { ev.horn?.stop(); ev.siren?.stop(0.1); ev.engine?.dispose(0.1); ev.voice?.dispose(); }
    try { this.windSrc.stop(); } catch { /* */ }
    disconnectAll(this.windSrc, this.windBp, this.windLp, this.windG, this.rainLp, this.in, this.lp);
  }
}
