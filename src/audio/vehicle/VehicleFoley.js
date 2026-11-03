// Player-vehicle foley: tyre squeal / roll / surfaces, wet hiss, wind, suspension, scrape, nitro, siren, beeper,
// rain on the roof, boat hull water. Positional parts share the engine's Voice3D (one panner per car).
import { clamp, approach, ramp, disconnectAll } from '../core/util.js';
import { Siren, Beeper } from '../sfx/Synths.js';

const WATER_KINDS = new Set(['boat']);
const AIR_KINDS = new Set(['heli', 'plane', 'jet']);

export class VehicleFoley {
  constructor(sys, vehicle, engine) {
    this.sys = sys;
    this.v = vehicle;
    this.engine = engine;
    const ctx = (this.ctx = sys.ctx);
    this.kind = vehicle.kind || 'car';
    this.dest = engine.voice ? engine.voice.input : sys.mixer.bus.sfx;
    const g = (v = 0) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const f = (type, freq, q = 0.7) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = freq; n.Q.value = q; return n; };
    this.nodes = [];
    const keep = (...n) => { this.nodes.push(...n); return n[0]; };

    // exterior-mounted sources → body low-pass (closes when the camera is inside the cabin)
    this.body = keep(g(1));
    this.bodyLp = keep(f('lowpass', 20000, 0.5));
    this.body.connect(this.bodyLp).connect(this.dest);

    const bank = sys.bank;
    this.noise = keep(ctx.createBufferSource());
    this.noise.buffer = bank.noise.white;
    this.noise.loop = true;
    this.pink = keep(ctx.createBufferSource());
    this.pink.buffer = bank.noise.pink;
    this.pink.loop = true;

    this.wheeled = !WATER_KINDS.has(this.kind) && !AIR_KINDS.has(this.kind) && this.kind !== 'bicycle';
    // tyre squeal: two resonant noise bands + a pitched component with stick-slip jitter
    this.sqBp1 = keep(f('bandpass', 900, 16));
    this.sqBp2 = keep(f('bandpass', 1400, 9));
    this.sqOsc = keep(ctx.createOscillator());
    this.sqOsc.type = 'triangle';
    this.sqOscG = keep(g(0.04));
    this.squeal = keep(g(0));
    this.noise.connect(this.sqBp1).connect(this.squeal);
    this.noise.connect(this.sqBp2).connect(this.squeal);
    this.sqOsc.connect(this.sqOscG).connect(this.squeal);
    this.squeal.connect(this.body);
    // rolling road noise
    // rolling road noise: pink noise limited to ~150..900 Hz (a rumble, never a hiss)
    this.roadHp = keep(f('highpass', 150, -3));
    this.roadLp = keep(f('lowpass', 400, -3));
    this.road = keep(g(0));
    this.pink.connect(this.roadHp).connect(this.roadLp).connect(this.road).connect(this.body);
    // wet road hiss / water rush
    this.wetHp = keep(f('highpass', 1100, -3));
    this.wetLp = keep(f('lowpass', 5500, -3));
    this.wet = keep(g(0));
    this.noise.connect(this.wetHp).connect(this.wetLp).connect(this.wet).connect(this.body);
    this.waterBp = keep(f('bandpass', 500, 0.7));
    this.water = keep(g(0));
    this.pink.connect(this.waterBp).connect(this.water).connect(this.body);
    // nitro hiss
    this.nitroBp = keep(f('bandpass', 2600, 0.8));
    this.nitro = keep(g(0));
    this.noise.connect(this.nitroBp).connect(this.nitro).connect(this.body);
    // wind (non-positional, around the listener)
    this.windBp = keep(f('bandpass', 500, 0.5));
    this.windLp = keep(f('lowpass', 3500, -3));
    this.wind = keep(g(0));
    this.pink.connect(this.windBp).connect(this.windLp).connect(this.wind).connect(sys.mixer.bus.sfx);
    this.sqOsc.start();
    this.noise.start(0, Math.random() * 1.5);
    this.pink.start(0, Math.random() * 2.5);

    this.loops = {};
    this.s = { squeal: 0, sqF: 900, jit: 0, gust: 0, prevComp: [0, 0, 0, 0], air: 0, wasAir: false, lastThump: 0, lastScrape: 0, impactId: vehicle.telemetry?.impactId ?? 0, inWater: false, boosting: false, maxSpeedStop: 0, squeaked: false, airBraked: true, slapT: 0 };
    this.siren = null;
    this.beeper = null;
    this.t = 0;
  }

  // lazily attach bank loops once generated
  loopNode(name, toBody = true) {
    let l = this.loops[name];
    if (l) return l;
    const buf = this.sys.bank.get(name);
    if (!buf) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(toBody ? this.body : this.sys.mixer.bus.sfx);
    src.start(0, Math.random() * buf.duration);
    l = this.loops[name] = { src, gain };
    return l;
  }

  setLoop(name, gain, rate = 1, toBody = true) {
    if (gain < 0.002 && !this.loops[name]) return;
    const l = this.loopNode(name, toBody);
    if (!l) return;
    const t = this.ctx.currentTime;
    ramp(l.gain.gain, gain, t, 0.06, 1e-3);
    ramp(l.src.playbackRate, rate * (this.sys.slowmo ?? 1), t, 0.1, 1e-3);
  }

  update(dt, interior) {
    const tel = this.v.telemetry || {};
    const sys = this.sys, s = this.s;
    const t = this.ctx.currentTime;
    this.t += dt;
    const speed = Math.abs(tel.speedKmh ?? 0) / 3.6;
    const wetness = sys.game?.uniforms?.uWetness?.value ?? 0;
    const rain = sys.weatherRain();

    // ----- tyres -----
    let skAs = 0, skWet = 0, gravel = 0, grass = 0, sand = 0, wetSurf = 0, contacts = 0;
    if (this.wheeled && tel.wheels) {
      const n = tel.wheels.length;
      for (let i = 0; i < n; i++) {
        const w = tel.wheels[i];
        if (!w.contact) { s.prevComp[i] = 0; continue; }
        contacts++;
        const spin = clamp((Math.abs(w.slipRatio || 0) - 0.12) * 1.6, 0, 1);
        const sk = Math.max(w.skid || 0, spin);
        const surf = w.surface;
        if (surf === 'wet') { skWet = Math.max(skWet, sk); wetSurf += 1 / n; }
        else if (surf === 'dirt') gravel += 1 / n;
        else if (surf === 'grass') grass += 1 / n;
        else if (surf === 'sand') sand += 1 / n;
        else skAs = Math.max(skAs, sk);
        // suspension hits (kerbs, potholes) and bottoming out
        const comp = w.compression ?? 0;
        const dc = comp - (s.prevComp[i] || comp);
        s.prevComp[i] = comp;
        if (dc > 0.3 && this.t - s.lastThump > 0.18 && speed > 3) {
          s.lastThump = this.t;
          sys.play('susp_thump', { object3d: this.v.object3d, volume: clamp((dc - 0.2) * 1.6, 0.15, 0.8) * (interior ? 1.1 : 0.8), ref: 4 });
        }
        if (comp >= 1.05 && speed > 4 && this.t - s.lastScrape > 0.5) {
          s.lastScrape = this.t;
          sys.play('metal', { object3d: this.v.object3d, volume: 0.35, variant: 0, pitch: 0.7, ref: 4 });
          this.scrapeBurst = 0.35;
        }
      }
    }
    const squealTarget = clamp(skAs * 1.15 + skWet * 0.35, 0, 1) * (contacts ? 1 : 0);
    s.squeal = approach(s.squeal, squealTarget, dt, squealTarget > s.squeal ? 0.03 : 0.11);
    s.jit = approach(s.jit, (Math.random() - 0.5) * 2, dt, 0.05);
    const sqF = (560 + 420 * s.squeal + Math.min(speed, 50) * 3.2) * (skWet > skAs ? 0.8 : 1) * (1 + 0.035 * s.jit);
    const slow = sys.slowmo ?? 1;
    ramp(this.sqBp1.frequency, sqF * slow, t, 0.03, 2e-3);
    ramp(this.sqBp2.frequency, sqF * 1.56 * slow, t, 0.03, 2e-3);
    ramp(this.sqOsc.frequency, sqF * slow, t, 0.03, 2e-3);
    ramp(this.squeal.gain, Math.pow(s.squeal, 1.4) * 0.55, t, 0.03, 1e-3);

    // silent below ~15 km/h, then grows with speed
    const gate = clamp((speed - 4.2) / 3.5, 0, 1);
    const roll = this.wheeled && contacts ? gate * gate * clamp(Math.pow(speed / 30, 1.25), 0, 1.5) : 0;
    const hard = 1 - clamp(gravel + grass + sand, 0, 1);
    ramp(this.road.gain, roll * 0.18 * (0.35 + 0.65 * hard) * (1 + 0.4 * interior), t, 0.08, 1e-3);
    ramp(this.roadLp.frequency, Math.min(900, 300 + speed * 12) * (1 - 0.35 * interior), t, 0.1, 5e-3);
    const wetAmt = this.wheeled ? clamp(Math.max(wetSurf, wetness * hard), 0, 1) * gate * clamp(Math.pow(speed / 22, 1.2), 0, 1.4) : 0;
    ramp(this.wet.gain, wetAmt * 0.12, t, 0.1, 1e-3);
    const lr = 0.65 + speed / 30;
    this.setLoop('gravel_loop', gravel * clamp(speed / 12, 0, 1.2) * 0.75 + gravel * s.squeal * 0.4, lr);
    this.setLoop('grass_loop', grass * clamp(speed / 12, 0, 1.2) * 0.5, lr);
    this.setLoop('sand_loop', sand * clamp(speed / 12, 0, 1.2) * 0.6, lr * 0.8);
    this.scrapeBurst = Math.max(0, (this.scrapeBurst || 0) - dt);
    this.setLoop('scrape_loop', this.scrapeBurst > 0 ? 0.4 : 0, 0.8 + speed / 25);

    // landing thump
    if (tel.airborne) s.air += dt;
    else {
      if (s.air > 0.3) {
        const k = clamp((s.air - 0.2) / 1.2, 0.2, 1);
        sys.play('susp_thump', { object3d: this.v.object3d, volume: 0.5 + 0.5 * k, ref: 5, pitch: 0.9 });
        if (k > 0.6) sys.play('metal', { object3d: this.v.object3d, volume: 0.3 * k, variant: 1, ref: 4, pitch: 0.8 });
      }
      s.air = 0;
    }

    // ----- water -----
    const inWater = !!tel.inWater;
    if (inWater && !s.inWater && speed > 6 && !WATER_KINDS.has(this.kind)) sys.play('splash', { object3d: this.v.object3d, variant: speed > 18 ? 2 : 1, volume: 0.8, ref: 6 });
    if (WATER_KINDS.has(this.kind)) {
      if (inWater && !s.inWater && s.wasAir) sys.play('splash', { object3d: this.v.object3d, variant: 2, volume: 0.7, ref: 6 });
      const w = inWater && !tel.airborne ? 1 : 0;
      ramp(this.water.gain, w * clamp(Math.pow(speed / 18, 1.2), 0, 1.3) * 0.28, t, 0.12, 1e-3);
      ramp(this.waterBp.frequency, 350 + speed * 22, t, 0.2, 5e-3);
      ramp(this.wet.gain, w * clamp(speed / 25, 0, 1.2) * 0.12, t, 0.1, 1e-3);
      s.slapT -= dt * (speed > 3 && w ? speed / 8 : 0);
      if (s.slapT <= 0 && speed > 3 && w) {
        s.slapT = 0.6 + Math.random() * 1.4;
        sys.play('splash', { object3d: this.v.object3d, variant: 0, volume: 0.15 + Math.random() * 0.2, pitch: 0.75 + Math.random() * 0.3, ref: 4, reverb: 0.1 });
      }
      s.wasAir = !!tel.airborne;
    }
    s.inWater = inWater;

    // ----- wind (non-positional) -----
    // speed wind and roof rain are heard by a listener riding the vehicle (its chase/bonnet/cabin camera). A free
    // camera left the car behind: it hears its own wind (Ambience, from camera speed) and the world's rain
    const ride = sys.camAttached === undefined ? 1 : sys.camAttached ? 1 : clamp(interior * 2, 0, 1);
    s.gust = approach(s.gust, Math.random() * 2 - 1, dt, 0.4);
    const air = AIR_KINDS.has(this.kind);
    const w = clamp(speed / (air ? 70 : 45), 0, 1.6);
    ramp(this.wind.gain, ride * w * w * (air ? 0.14 : 0.1) * (1 - 0.55 * interior) * (1 + 0.25 * s.gust), t, 0.12, 1e-3);
    ramp(this.windBp.frequency, (280 + speed * 11) * (1 + 0.15 * s.gust), t, 0.15, 5e-3);
    ramp(this.windLp.frequency, 3500 * Math.pow(0.2, interior), t, 0.15, 1e-2);

    // ----- nitro -----
    const boosting = !!tel.boosting;
    if (boosting && !s.boosting) sys.play('fire_whoosh', { object3d: this.v.object3d, volume: 0.35, pitch: 1.5, ref: 5 });
    s.boosting = boosting;
    ramp(this.nitro.gain, boosting ? 0.1 : 0, t, boosting ? 0.04 : 0.15, 1e-3);

    // ----- brakes -----
    if (speed > 6) { s.maxSpeedStop = Math.max(s.maxSpeedStop, speed); s.squeaked = false; s.airBraked = false; }
    if (tel.braking && speed < 2.5 && speed > 0.3 && s.maxSpeedStop > 6 && !s.squeaked) {
      s.squeaked = true;
      if (Math.random() < 0.35) sys.play('brake_squeak', { object3d: this.v.object3d, volume: 0.12, pitch: 0.9 + Math.random() * 0.2, ref: 3 });
    }
    if (this.engine.cfg.airBrake && speed < 0.3 && s.maxSpeedStop > 3 && !s.airBraked) {
      s.airBraked = true; s.maxSpeedStop = 0;
      sys.play('air_brake', { object3d: this.v.object3d, volume: 0.4, ref: 5, delay: 0.25 });
    }

    // ----- impacts reported by the physics (fallback when no `impact` event fired) -----
    if (tel.impactId !== undefined && tel.impactId !== s.impactId) {
      s.impactId = tel.impactId;
      const st = clamp(tel.impactStrength ?? 0.4, 0.05, 1);
      const p = this.v.object3d?.position;
      if (p && !sys.events?.isRecent(p, 0.15, 7)) {
        sys.events?.mark(p, 'impact');
        if (st > 0.6) sys.play('crash', { object3d: this.v.object3d, volume: 0.5 + 0.5 * st, ref: 6 });
        else sys.play('metal', { object3d: this.v.object3d, volume: 0.25 + 0.75 * st, variant: (st > 0.35 ? 2 : 0) + (Math.random() < 0.5 ? 1 : 0), ref: 4, pitch: 1.05 - st * 0.2 });
        if (st > 0.45 && Math.random() < 0.4) sys.play('glass', { object3d: this.v.object3d, volume: 0.5 * st, ref: 4 });
      }
    }

    // ----- siren / reverse beeper -----
    if (this.v.siren && !this.siren) this.siren = new Siren(sys, this.body, 'wail');
    else if (!this.v.siren && this.siren) { this.siren.stop(0.3); this.siren = null; }
    if (this.engine.cfg.reverseBeep) {
      if (!this.beeper) this.beeper = new Beeper(sys, this.body);
      this.beeper.set(!!tel.reversing && this.engine.running);
    }

    // ----- rain on the roof (cabin) / on the body (outside) -----
    this.setLoop('rain_roof', ride * rain * (interior * 0.55 + (1 - interior) * 0.08) * (AIR_KINDS.has(this.kind) || WATER_KINDS.has(this.kind) || this.kind === 'motorcycle' || this.kind === 'bicycle' ? 0.3 : 1), 1, false);

    // cabin muffling of exterior sources
    ramp(this.bodyLp.frequency, interior > 0.01 ? 20000 * Math.pow(0.08, interior) : 20000, t, 0.08, 0.01);
    ramp(this.body.gain, 1 - 0.3 * interior, t, 0.08, 1e-3);
  }

  dispose() {
    const t = this.ctx.currentTime;
    for (const n of [this.squeal, this.road, this.wet, this.water, this.nitro, this.wind]) n.gain.setTargetAtTime(0, t, 0.05);
    for (const l of Object.values(this.loops)) l.gain.gain.setTargetAtTime(0, t, 0.05);
    this.siren?.stop(0.2);
    this.beeper?.dispose();
    setTimeout(() => {
      for (const n of [this.noise, this.pink, this.sqOsc]) { try { n.stop(); } catch { /* */ } }
      for (const l of Object.values(this.loops)) { try { l.src.stop(); } catch { /* */ } disconnectAll(l.src, l.gain); }
      disconnectAll(...this.nodes);
    }, 400);
  }
}
