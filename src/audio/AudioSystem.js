// Leonida Drive audio: procedural Web Audio engine. See src/audio/INTEGRATION.md.
import { Mixer } from './core/Mixer.js';
import { Voice3D } from './core/Voice3D.js';
import { SoundBank } from './bank/SoundBank.js';
import { BANK_NAMES } from './bank/generators.js';
import { EngineVoice } from './engine/EngineVoice.js';
import { engineProcessorUrl } from './engine/engineWorklet.js';
import { PROFILE_NAMES, resolveProfile, profileFromCarAudio } from './engine/profiles.js';
import { VehicleFoley } from './vehicle/VehicleFoley.js';
import { TrafficAudio } from './traffic/TrafficAudio.js';
import { Ambience } from './ambience/Ambience.js';
import { Radio, RADIO_STATIONS } from './radio/Radio.js';
import { EventSounds } from './sfx/EventSounds.js';
import { Horn, Siren, SIREN_MODES, HORNS } from './sfx/Synths.js';
import { clamp, lerp, approach, ramp, snap, disconnectAll } from './core/util.js';

export const AUDIO_DEFAULTS = { volume: 0.8, volMusic: 0.05, volSfx: 1, volAmbient: 0.45, volEngine: 0.9, volUi: 0.8, audioHrtf: true, radioStation: 0 };
const VOL_KEYS = { volume: 'master', volMusic: 'music', volSfx: 'sfx', volAmbient: 'ambient', volEngine: 'engine', volUi: 'ui' };
const MAX_SHOTS = 40;

export class AudioSystem {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.order = 90; // after the player/camera modules
    this.ctx = null;
    this.ready = false;
    this.voices = new Set();
    this.listener = { x: 0, y: 0, z: 0 };
    this.listenerRight = { x: 1, y: 0, z: 0 };
    this.listenerFwd = { x: 0, y: 0, z: -1 };
    this.interior = 0;
    this.slowmo = 1;
    this.hrtf = true;
    this.activeShots = 0;
    this._voiceFrame = 0;
    this.playerVehicle = null;
    this.pendingVehicle = undefined;
    this.parked = [];
    this.engines = new Set();
    this.workletReady = false;
    this.workletFailed = false;
    this._workletCbs = [];
    this.stats = { cpuMs: 0, voices: 0, shots: 0, env: '-', state: 'idle', bank: 0 };
    this.overrides = {};
    // settings
    const s = game?.settings || {};
    for (const [k, v] of Object.entries(AUDIO_DEFAULTS)) if (s[k] === undefined && game?.settings) s[k] = v;
    if (game?.onSetting) {
      for (const [key, bus] of Object.entries(VOL_KEYS)) game.onSetting(key, (v) => this.setVolume(bus, v));
      game.onSetting('audioHrtf', (v) => { this.hrtf = !!v; for (const vc of this.voices) vc.panner.panningModel = this.hrtf ? 'HRTF' : 'equalpower'; });
    }
    this._onVis = () => this.onVisibility();
    document.addEventListener('visibilitychange', this._onVis);
  }

  // ---------------- lifecycle ----------------
  // Call from a user gesture. Safe to call repeatedly.
  start() {
    if (this.ctx) { this.resume(); return this; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return this;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.mixer = new Mixer(this.ctx);
    const s = this.game?.settings || AUDIO_DEFAULTS;
    for (const [key, bus] of Object.entries(VOL_KEYS)) this.mixer.setVolume(bus, s[key] ?? AUDIO_DEFAULTS[key]);
    const q = this.game?.quality?.name;
    this.hrtf = (s.audioHrtf ?? true) && q !== 'low';
    this.bank = new SoundBank(this.ctx);
    this.mixer.setEnvironment('open', 0.01);
    this.events = new EventSounds(this);
    this.ambience = new Ambience(this);
    this.traffic = new TrafficAudio(this);
    this.radio = new Radio(this);
    this.ready = true;
    this.resume();
    // engine worklet
    if (this.ctx.audioWorklet) {
      this.ctx.audioWorklet.addModule(engineProcessorUrl()).then(() => {
        this.workletReady = true;
        this._workletCbs.splice(0).forEach((f) => f(true));
      }).catch((e) => { console.warn('[audio] worklet unavailable, using fallback engines', e); this.workletFailed = true; this._workletCbs.splice(0).forEach((f) => f(false)); });
    } else { this.workletFailed = true; }
    this._radioIv = setInterval(() => this.radio?.tick(), 25);
    this._pollIv = setInterval(() => this.poll(), 100);
    if (this.pendingVehicle !== undefined) { const v = this.pendingVehicle; this.pendingVehicle = undefined; this.attachVehicle(v); }
    return this;
  }

  resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    ctx.resume().catch(() => {});
    if (!this._gesture) {
      this._gesture = () => {
        ctx.resume().catch(() => {});
        if (ctx.state === 'running') this.dropGesture();
      };
      for (const e of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(e, this._gesture, { capture: true });
      ctx.onstatechange = () => { if (ctx.state === 'running') this.dropGesture(); };
    }
  }

  dropGesture() {
    if (!this._gesture) return;
    for (const e of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.removeEventListener(e, this._gesture, { capture: true });
    this._gesture = null;
  }

  onVisibility() {
    if (!this.ctx) return;
    const hidden = document.visibilityState === 'hidden';
    this.mixer.setState('hidden', hidden ? 1 : 0);
    clearTimeout(this._visT);
    if (hidden) this._visT = setTimeout(() => { if (document.visibilityState === 'hidden') this.ctx.suspend().catch(() => {}); }, 250);
    else this.resume();
  }

  poll() {
    if (!this.ctx) return;
    const g = this.game;
    this.mixer.setState('paused', g?.paused ? 1 : 0);
    this.stats.state = this.ctx.state;
  }

  onWorklet(fn) { this._workletCbs.push(fn); }

  setVolume(bus, v) {
    if (!this.mixer) return;
    this.mixer.setVolume(bus === 'master' ? 'master' : bus, v);
  }

  // ---------------- per frame ----------------
  update(dt, game) {
    if (!this.ready) return;
    // Engine/ambience controls already ramp their AudioParams. Run that control
    // layer at 30 Hz with accumulated time instead of flooding the audio thread
    // with duplicate automation on high-refresh displays.
    this._controlDt = (this._controlDt ?? (1 / 30)) + dt;
    if (this._controlDt < 1 / 30) return;
    dt = this._controlDt;
    this._controlDt = 0;
    const t0 = performance.now();
    game = game || this.game;
    const ts = game?.timeScale ?? 1;
    this.slowmo = approach(this.slowmo, lerp(1, clamp(ts, 0.1, 1), 0.6), dt, 0.25);
    if (!Number.isFinite(this.slowmo)) this.slowmo = 1; // a NaN dt/timeScale must never reach AudioParams
    // follow whatever the player controller is driving
    const p = game?.player;
    if (p) {
      const c = p.controllable;
      const want = c && (p.mode === 'vehicle' || (p.mode === 'free' && c.occupied)) ? c : null;
      if (want !== this.playerVehicle) this.attachVehicle(want || null);
    }
    // where is the camera relative to the player's vehicle? Everything "own-car" (cabin filter, speed wind,
    // radio, roof rain) follows the camera, not the character: a free camera flying away leaves the car behind
    let inner = 0;
    const pv = this.playerVehicle;
    this.freeCam = p?.mode === 'free';
    this.camDist = Infinity;
    if (pv && game?.camera) {
      const c = game.camera.position, o = pv.object3d?.position;
      const d = o ? Math.hypot(c.x - o.x, c.y - o.y, c.z - o.z) : Infinity;
      this.camDist = d;
      const hood = !this.freeCam && p?.chase?.mode === 'hood' && !pv.camera;
      const open = pv.kind === 'motorcycle' || pv.kind === 'bicycle' || pv.kind === 'moped';
      // in-cabin camera = fully inside; bonnet camera = partly (engine bay in front, glass behind)
      inner = open ? 0 : d < 2.3 ? 1 : hood ? 0.65 : 0;
    }
    // the vehicle's own cameras (chase / bonnet / cockpit) ride with it; a free camera never does
    this.camAttached = !!pv && !this.freeCam;
    if (this.overrides.interior !== undefined) inner = this.overrides.interior;
    this.interior = approach(this.interior, inner, dt, 0.07);
    if (this.player) {
      this.player.engine.setInterior(this.interior);
      // in the cabin the engine surrounds you: more unpanned (stereo-centre) share, less point source.
      // The unpanned share only exists near the listener (Voice3D fades it out past directRange), and once a free
      // camera leaves the car the own engine is a normal positional car: no width, fades out by ~260 m
      const ev = this.player.engine.voice;
      if (ev) {
        ev.setDirect(0.4 + 0.6 * this.interior);
        ev.directRange = this.camAttached ? Math.max(8, Math.min(60, this.camDist + 4)) : 8;
        // (aircraft/boats own their voice and distance model; leave theirs alone)
        if (!this.player.external) ev.cull = this.camAttached || this.interior > 0.5 ? Infinity : 260;
      }
      if (!this.player.external) this.player.engine.update(pv.telemetry, dt);
      this.player.foley.update(dt, this.interior);
    }
    for (let i = this.parked.length - 1; i >= 0; i--) {
      const pk = this.parked[i];
      pk.engine.update(pk.v.telemetry, dt);
      pk.offT = pk.engine.state === 'off' ? (pk.offT || 0) + dt : 0;
      if (pk.offT > 2 || pk.v.disposed) { pk.engine.dispose(0.1); this.parked.splice(i, 1); }
    }
    for (const e of this.engines) if (e.autoUpdate) e.autoUpdate(dt);
    // radio side-chain: the harder the player's engine works, the more the music tucks under it
    let push = 0;
    const tl = pv?.telemetry;
    if (tl && this.player) {
      const eng = this.player.engine.cfg;
      const rN = clamp(((tl.rpm ?? 0) - (eng.idle || 0)) / Math.max(1, (eng.max || 7000) - (eng.idle || 0)), 0, 1);
      push = clamp(tl.throttle ?? 0, 0, 1) * (0.35 + 0.65 * rN);
    }
    this.mixer.setMusicSide(1 - 0.4 * push);
    try { this.traffic.update(dt); } catch (e) { this.warnOnce('traffic', e); }
    try { this.ambience.update(dt); } catch (e) { this.warnOnce('ambience', e); }
    try { this.radio.update(dt); this.radio.tick(); } catch (e) { this.warnOnce('radio', e); }
    this._cpu = performance.now() - t0;
  }

  lateUpdate(dt, game) {
    if (!this.ready) return;
    const t0 = performance.now();
    game = game || this.game;
    const cam = game?.camera;
    const L = this.listener;
    let jump = false;
    if (cam) {
      const p = cam.position, q = cam.quaternion;
      jump = Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z) > 45;
      L.x = p.x; L.y = p.y; L.z = p.z;
      // forward = q * (0,0,-1), up = q * (0,1,0)
      const { x, y, z, w } = q;
      const fx = -2 * (x * z + w * y), fy = -2 * (y * z - w * x), fz = -(1 - 2 * (x * x + y * y));
      const ux = 2 * (x * y - w * z), uy = 1 - 2 * (x * x + z * z), uz = 2 * (y * z + w * x);
      this.listenerFwd = { x: fx, y: fy, z: fz };
      const rl = Math.hypot(fz, fx) || 1;
      this.listenerRight = { x: -fz / rl, y: 0, z: fx / rl };
      const Ln = this.ctx.listener, now = this.ctx.currentTime;
      let t = now;
      if (jump) {
        // camera cut / teleport: dip the world bus, jump everything while silent, fade back in
        t = now + 0.03;
        const wg = this.mixer.world.gain;
        wg.cancelScheduledValues(now);
        wg.setTargetAtTime(0, now, 0.006);
        wg.setTargetAtTime(1, t + 0.01, 0.06);
        this.snapAt = t;
        this.ambience?.snap();
      } else this.snapAt = 0;
      if (Ln.positionX) {
        const set = jump ? (prm, v) => snap(prm, v, t) : (prm, v) => ramp(prm, v, t, 0.02, 1e-5);
        set(Ln.positionX, p.x); set(Ln.positionY, p.y); set(Ln.positionZ, p.z);
        set(Ln.forwardX, fx); set(Ln.forwardY, fy); set(Ln.forwardZ, fz);
        set(Ln.upX, ux); set(Ln.upY, uy); set(Ln.upZ, uz);
      } else {
        Ln.setPosition(p.x, p.y, p.z);
        Ln.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    }
    this._voiceFrame = (this._voiceFrame + 1) & 1;
    const ownVoice = this.player?.engine?.voice;
    let vi = 0;
    for (const v of this.voices) {
      v._updateDt = (v._updateDt || 0) + dt;
      // Keep the player's own engine at full rate. Distant/pooled voices are staggered at
      // 30 Hz; their AudioParams already interpolate between targets, so this is inaudible
      // but avoids flooding the browser's audio automation queue on every display frame.
      const due = v.fresh || this.snapAt || v === ownVoice || ((this._voiceFrame + vi) & 1) === 0;
      if (due) { const step = v._updateDt; v._updateDt = 0; v.update(step, L, this.snapAt || 0); }
      vi++;
    }
    this.occlusionStep();
    this._cpu += performance.now() - t0;
    this.stats.cpuMs = this.stats.cpuMs * 0.95 + this._cpu * 0.05;
    this.stats.voices = this.voices.size;
    this.stats.shots = this.activeShots;
    this.stats.env = this.mixer.env;
    this.stats.bank = this.bank.progress;
  }

  // one raycast per frame against static geometry for a nearby voice (round-robin)
  occlusionStep() {
    const g = this.game;
    if (!g?.world || !g.RAPIER || !g.groups || this._noRays) return;
    if (!this._occList || (this._occT = (this._occT || 0) + 1) > 30) { this._occList = [...this.voices]; this._occT = 0; this._occI = 0; }
    const list = this._occList;
    for (let n = 0; n < 2 && list.length; n++) {
      const v = list[(this._occI = (this._occI + 1) % list.length)];
      // the own car is never occluded from its own cameras, but a free camera behind a building hears it muffled
      if (!v || !this.voices.has(v) || v.dist < 6 || v.dist > 160 || (this.camAttached && v === this.player?.engine.voice)) { if (v) v.occlTarget = 0; continue; }
      const L = this.listener, p = v.pos;
      const dx = p.x - L.x, dy = p.y + 0.8 - L.y, dz = p.z - L.z, d = Math.hypot(dx, dy, dz) || 1;
      if (!Number.isFinite(d) || !Number.isFinite(L.x + L.y + L.z)) { v.occlTarget = 0; continue; }
      this._ray ||= new g.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
      this._ray.origin = { x: L.x, y: L.y, z: L.z };
      this._ray.dir = { x: dx / d, y: dy / d, z: dz / d };
      try {
        const hit = g.world.castRay(this._ray, d - 1.5, true, undefined, g.groups.groups(0xffff, g.groups.GROUPS.STATIC));
        v.occlTarget = hit ? 1 : 0;
      } catch (e) { v.occlTarget = 0; this.warnOnce('occlusion ray', e); this._noRays = true; }
    }
  }

  // reverb environment from the ambience analysis
  updateEnvironment(e) {
    if (this.overrides.env) { this.mixer.setEnvironment(this.overrides.env); return; }
    const g = this.game, L = this.listener;
    let covered = false;
    if (g?.world && g.RAPIER && g.groups && !this._noRays && Number.isFinite(L.x + L.y + L.z)) {
      this._upRay ||= new g.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
      this._upRay.origin = { x: L.x, y: L.y + 0.5, z: L.z };
      this._upRay.dir = { x: 0, y: 1, z: 0 };
      try { covered = !!g.world.castRay(this._upRay, 30, true, undefined, g.groups.groups(0xffff, g.groups.GROUPS.STATIC)); } catch (e) { this.warnOnce('environment ray', e); this._noRays = true; }
    }
    const terrainH = g?.terrain?.heightAt?.(L.x, L.z) ?? 0;
    if (this.interior > 0.5) { this.mixer.setEnvironment('cabin', 0.4, true); return; }
    const env = covered ? 'tunnel' : (e.building > 0.12 || e.urban > 0.55) && e.alt < 80 ? 'urban' : terrainH > 70 || (e.alt > 120 && e.water < 0.3) ? 'valley' : 'open';
    this.mixer.setEnvironment(env, 1.5, true);
  }

  weatherRain() { return this.overrides.rain ?? this.game?.weather?.rain ?? this.game?.uniforms?.uRain?.value ?? 0; }
  weatherWind() {
    if (this.overrides.wind !== undefined) return this.overrides.wind;
    const W = this.game?.weather;
    if (typeof W?.wind === 'number') return W.wind;
    if (typeof W?.state?.windMs === 'number') return W.state.windMs;
    if (typeof W?.wind?.strength === 'number') return W.wind.strength;
    const u = this.game?.uniforms?.uWind?.value;
    return u ? Math.hypot(u.x, u.z) : 3;
  }
  distTo(p) { const L = this.listener; return Math.hypot(p.x - L.x, (p.y ?? L.y) - L.y, p.z - L.z); }

  warnOnce(key, e) {
    this._warned ||= new Set();
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`[audio] ${key}`, e);
  }

  // ---------------- public API ----------------
  // One-shot. name: see SOUNDS. Returns a handle {stop(fade)} or null (not ready / culled).
  play(name, o = {}) {
    if (!this.ready || this.ctx.state === 'closed') return null;
    const buf = this.bank.get(name, o.variant ?? -1);
    if (!buf) return null;
    if (this.activeShots >= MAX_SHOTS && !(o.priority > 5)) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = (o.pitch ?? 1) * (o.bus === 'ui' ? 1 : this.slowmo);
    src.playbackRate.value = Number.isFinite(rate) ? rate : 1; // a NaN from an event payload must not throw
    const g = ctx.createGain();
    g.gain.value = o.volume ?? 1;
    src.connect(g);
    const busNode = this.mixer.bus[o.bus || 'sfx'] || this.mixer.bus.sfx;
    let voice = null, pan = null, delay = Math.max(0, o.delay || 0);
    const target = o.object3d || o.position;
    if (target) {
      const pos = o.object3d || { x: target.x, y: target.y ?? this.listener.y, z: target.z };
      voice = new Voice3D(this, { bus: busNode, object3d: pos, ref: o.ref ?? 5, rolloff: o.rolloff ?? 1.4, air: o.air ?? 0.6, cull: o.cull, reverb: o.reverb ?? 0.35, hrtf: o.hrtf, doppler: false });
      voice.update(0, this.listener, ctx.currentTime);
      if (voice.audibility() * (o.volume ?? 1) < 0.003) { voice.dispose(); disconnectAll(src, g); return null; }
      if (o.delayByDistance) delay += Math.min(voice.dist / 343, 2);
      g.connect(voice.input);
    } else if (o.pan) {
      pan = ctx.createStereoPanner();
      pan.pan.value = clamp(o.pan, -1, 1);
      g.connect(pan).connect(busNode);
    } else g.connect(busNode);
    src.start(ctx.currentTime + delay);
    this.activeShots++;
    src.onended = () => { this.activeShots--; disconnectAll(src, g, pan); voice?.dispose(); };
    return {
      source: src, voice,
      stop: (fade = 0.05) => { const t = ctx.currentTime; g.gain.setTargetAtTime(0, t, fade / 3); try { src.stop(t + fade * 2); } catch { /* */ } },
    };
  }

  // Looping sound. Bank loops (fire_loop, rain_light, waves, …) or live synths: 'siren[:mode]', 'horn[:type]'.
  loop(name, o = {}) {
    if (!this.ready) return null;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const busNode = this.mixer.bus[o.bus || 'sfx'] || this.mixer.bus.sfx;
    const target = o.object3d || o.position;
    const voice = target ? new Voice3D(this, { bus: busNode, object3d: o.object3d || { x: target.x, y: target.y ?? 0, z: target.z }, ref: o.ref ?? 6, rolloff: o.rolloff ?? 1.3, air: o.air ?? 0.6, cull: o.cull, reverb: o.reverb ?? 0.35, hrtf: o.hrtf }) : null;
    out.connect(voice ? voice.input : busNode);
    let vol = o.volume ?? 1, src = null, synth = null, stopped = false;
    const [base, arg] = name.split(':');
    if (base === 'siren') synth = new Siren(this, out, arg || 'wail');
    else if (base === 'horn') synth = new Horn(this, arg || 'car', out);
    const startSrc = (bufs) => {
      if (stopped || src) return;
      src = ctx.createBufferSource();
      src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
      src.loop = true;
      src.playbackRate.value = (o.pitch ?? 1) * this.slowmo;
      src.connect(out);
      src.start(0, Math.random() * src.buffer.duration);
    };
    if (!synth) {
      if (!BANK_NAMES.includes(name)) { console.warn(`[audio] unknown loop ${name}`); }
      else this.bank.whenReady(name).then(startSrc);
    }
    ramp(out.gain, vol, ctx.currentTime, o.fadeIn ?? 0.15);
    const h = {
      voice,
      set: (pr = {}) => {
        const t = ctx.currentTime;
        if (pr.volume !== undefined) { vol = pr.volume; ramp(out.gain, vol, t, 0.08); }
        if (pr.pitch !== undefined && src) ramp(src.playbackRate, pr.pitch * this.slowmo, t, 0.08);
        if (pr.position && voice) voice.setPosition(pr.position.x, pr.position.y ?? 0, pr.position.z);
        if (pr.object3d && voice) voice.follow(pr.object3d);
        if (pr.mode && synth?.setMode) synth.setMode(pr.mode);
      },
      stop: (fade = 0.3) => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(0, t, Math.max(0.01, fade / 3));
        synth?.stop(fade);
        setTimeout(() => { try { src?.stop(); } catch { /* */ } disconnectAll(src, out); voice?.dispose(); }, fade * 1000 + 200);
      },
    };
    return h;
  }

  // Engine voice for any vehicle/aircraft. opts: { object3d | position, overrides, volume, running, hrtf, kind }
  // Off until setOccupied(true) (or opts.running) — parked vehicles stay silent.
  createEngine(profile, opts = {}) {
    if (!this.ready) return nullEngine();
    const e = new EngineVoice(this, profile, { running: false, occupied: false, ...opts });
    this.engines.add(e);
    const dispose = e.dispose.bind(e);
    e.dispose = (f) => { this.engines.delete(e); dispose(f); };
    return e;
  }

  profileFor(v) {
    const entry = this.game?.vehicles?.byId?.get?.(v.catalogId);
    const es = v.engineSound || entry?.engineSound;
    if (es) return { profile: resolveProfile(es, v.kind), overrides: v.engineAudio || entry?.engineAudio || {} };
    const kind = v.kind || 'car';
    if (kind === 'car' || kind === 'small' || kind === 'van') {
      const a = v.spec?.audio;
      if (a) {
        const r = profileFromCarAudio(a);
        const eng = v.spec?.engine;
        if (eng) Object.assign(r.overrides, { idle: eng.idle, max: eng.redline });
        return r;
      }
    }
    return { profile: resolveProfile(null, kind), overrides: {} };
  }

  // Player controller hook: (re)creates the engine + foley for the vehicle the player drives (null = on foot).
  attachVehicle(v) {
    if (!this.ready) { this.pendingVehicle = v; return; }
    if (v === this.playerVehicle) return;
    const prev = this.player;
    if (prev) {
      prev.foley.dispose();
      prev.engine.setInterior(0);
      prev.engine.voice?.setDirect(0);
      if (prev.engine.voice && !prev.external) prev.engine.voice.cull = Infinity;
      if (!prev.external) {
        prev.engine.setOccupied(false);
        if (!prev.v.disposed) this.parked.push({ v: prev.v, engine: prev.engine });
        else prev.engine.dispose(0.2);
      }
      this.player = null;
    }
    this.playerVehicle = v || null;
    if (!v) return;
    let engine = null, external = false;
    const pk = this.parked.findIndex((x) => x.v === v);
    if (v.engine?.isEngineVoice) {
      // the vehicle owns its engine voice (aircraft/boats create it via createEngine and update it themselves)
      engine = v.engine;
      external = true;
    } else if (pk >= 0) { engine = this.parked[pk].engine; this.parked.splice(pk, 1); }
    else {
      const { profile, overrides } = this.profileFor(v);
      const p = v.object3d?.position;
      const running = !!(v.engineRunning || v.fromTraffic || v.__audioRunning || (v.telemetry?.speedKmh ?? 0) > 4 || (p && this.traffic?.vanishedNear(p)));
      engine = new EngineVoice(this, profile, { object3d: v.object3d, player: true, overrides, running, kind: v.kind, volume: 1.2 });
    }
    engine.voice?.setDirect(0.4);
    if (!external) engine.setOccupied(true);
    this.player = { v, engine, external, foley: new VehicleFoley(this, v, engine) };
  }

  // player left the vehicle (PlayerController calls this on exit)
  detachVehicle(v) {
    if (!v || v === this.playerVehicle) this.attachVehicle(null);
  }

  forgetVehicle(v) {
    if (!v) return;
    if (v === this.playerVehicle) {
      this.player.foley.dispose();
      if (!this.player.external) this.player.engine.dispose(0.2);
      this.player = null;
      this.playerVehicle = null;
    }
    for (let i = this.parked.length - 1; i >= 0; i--) if (this.parked[i].v === v) { this.parked[i].engine.dispose(0.2); this.parked.splice(i, 1); }
  }

  vehicleDestroyed(v) {
    const e = v === this.playerVehicle ? this.player?.engine : this.parked.find((x) => x.v === v)?.engine;
    if (e) { e.stop(); if (e.node) e.node.port.postMessage({ type: 'pop', count: 3 }); }
    if (v === this.playerVehicle) { this.player.foley.siren?.stop(0.5); this.player.foley.siren = null; }
  }

  voiceInputFor(v) {
    if (v === this.playerVehicle && this.player) return this.player.foley.body;
    const pk = this.parked.find((x) => x.v === v);
    return pk?.engine.voice?.input || null;
  }

  sirenFor(v) { return v === this.playerVehicle ? this.player?.foley.siren : null; }

  get radioStation() { return this.radio?.index ?? -1; }
  setRadioStation(i) { this.radio?.tune(i); }

  dispose() {
    clearInterval(this._radioIv);
    clearInterval(this._pollIv);
    document.removeEventListener('visibilitychange', this._onVis);
    this.dropGesture();
    this.events?.dispose();
    this.traffic?.dispose();
    this.ambience?.dispose();
    this.radio?.dispose();
    this.bank?.dispose();
    this.ctx?.close();
    this.ready = false;
  }
}

function nullEngine() { return { update() {}, setOccupied() {}, dispose() {}, setInterior() {}, start() {}, stop() {} }; }

// catalogue for labs / tooling
export const SOUNDS = BANK_NAMES;
export const ENGINE_PROFILES = PROFILE_NAMES;
export { RADIO_STATIONS, SIREN_MODES, HORNS };
