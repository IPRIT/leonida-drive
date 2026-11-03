// Traffic: a small pool of engine voices re-assigned to the nearest AI cars (with fades), simulated gearbox
// for believable rpm, tyre roll noise, horns when the player blocks them, crash sounds, sirens.
import { EngineVoice } from '../engine/EngineVoice.js';
import { PROFILES } from '../engine/profiles.js';
import { Horn, Siren } from '../sfx/Synths.js';
import { Voice3D } from '../core/Voice3D.js';
import { clamp, approach, ramp, disconnectAll } from '../core/util.js';

const TYPE_PROFILE = {
  suv: ['v6', { crackle: 0, turbo: 0.3 }], pickup: ['v8', { lope: 0.35, crackle: 0.1 }], cruiser: ['v8', { lope: 0.3, crackle: 0.2 }],
  muscle: ['v8', { lope: 0.7, crackle: 0.5 }], comet: ['i4', { crackle: 0.2 }], super: ['v12', { crackle: 0.3 }],
  bus: ['bus', {}], truck: ['diesel', {}], van: ['v6', { crackle: 0 }], taxi: ['v6', { crackle: 0 }], police: ['v8', { lope: 0.3 }],
  moped: ['moped', {}], motorcycle: ['motorcycle', {}], ev: ['electric', {}],
};
const HORN_TYPE = { suv: 'luxury', pickup: 'luxury', cruiser: 'police', muscle: 'car', comet: 'sport', super: 'sport', bus: 'bus', truck: 'truck' };
const RATIOS = [3.4, 2.15, 1.5, 1.15, 0.9, 0.74];
// hard audibility limits (m): beyond these a car is part of the city bed, not a voice
const CULL = { car: 80, heavy: 150 };
const HEAVY = new Set(['bus', 'truck']);
const cullFor = (name) => (HEAVY.has(name) ? CULL.heavy : CULL.car);
// AI engines: fewer noise components than the player's (no combustion rasp / intake hiss build-up in a crowd)
const liteCfg = (prof, ov) => {
  const b = PROFILES[prof];
  return { ...b, ...ov, lite: true, mech: 0, rough: (b.rough ?? 0.3) * 0.35, intake: [(b.intake || [1000])[0], 1, 0] };
};
const FINAL = 3.6, WHEEL_R = 0.33, RPM_PER = 60 / (2 * Math.PI);

class TrafficVoice {
  constructor(sys, noise) {
    this.sys = sys;
    this.engine = new EngineVoice(sys, 'v6', { ref: 5, rolloff: 1.8, air: 1, cull: CULL.car, reverb: 0.2, volume: 0, overrides: liteCfg('v6', { crackle: 0, turbo: 0.3 }) });
    this.profileKey = 'suv';
    const ctx = sys.ctx;
    // tyre roll: brown noise band-limited to ~180..800 Hz (a low "rrrr", never hiss)
    this.rollHp = ctx.createBiquadFilter();
    this.rollHp.type = 'highpass'; this.rollHp.frequency.value = 180; this.rollHp.Q.value = -3;
    this.rollBp = ctx.createBiquadFilter();
    this.rollBp.type = 'lowpass'; this.rollBp.Q.value = -3; this.rollBp.frequency.value = 400;
    this.roll = ctx.createGain();
    this.roll.gain.value = 0;
    noise.connect(this.rollHp).connect(this.rollBp).connect(this.roll).connect(this.engine.voice.input);
    this.agent = null;
    this.next = null;
    this.fade = 0;
  }

  setType(name) {
    const key = TYPE_PROFILE[name] ? name : 'suv';
    if (key === this.profileKey) return;
    this.profileKey = key;
    const [prof, ov] = TYPE_PROFILE[key];
    const e = this.engine;
    e.name = prof;
    e.cfg = liteCfg(prof, ov);
    e.mode = e.cfg.mode;
    e.voice.cull = cullFor(key);
    e.node?.port.postMessage({ type: 'cfg', cfg: e.cfg });
  }

  dispose() {
    this.engine.dispose(0.2);
    setTimeout(() => disconnectAll(this.rollHp, this.rollBp, this.roll), 400);
  }
}

export class TrafficAudio {
  constructor(sys) {
    this.sys = sys;
    this.st = new WeakMap();
    this.voices = [];
    this.assignT = 0;
    this.honks = [];
    this.sirens = new Map();
    this.vanished = [];
    this.near = new Map();
    const ctx = sys.ctx;
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = sys.bank.noise.brown;
    this.noiseSrc.loop = true;
    // mono downmix of the stereo brown-noise bed
    this.noise = ctx.createGain();
    this.noise.channelCount = 1;
    this.noise.channelCountMode = 'explicit';
    this.noiseSrc.connect(this.noise);
    this.noiseSrc.start();
  }

  get maxVoices() {
    const q = this.sys.game?.quality?.name;
    return q === 'low' ? 3 : q === 'medium' ? 4 : q === 'ultra' ? 6 : 5;
  }

  stateOf(a) {
    let s = this.st.get(a);
    if (!s) {
      s = { v: a.v || 0, acc: 0, gear: 1, shiftId: 0, rpm: 800, thr: 0, crashed: !!a.crashed, blockedT: 0, hornCd: 2 + Math.random() * 6, nearMiss: 0 };
      this.st.set(a, s);
    }
    return s;
  }

  simulate(a, s, dt) {
    // no physics-engine calls here: a removed agent's body is freed, and touching it would panic Rapier.
    // Crashed (physics-driven) cars: speed from the interpolated position instead.
    let v = a.v || 0;
    if (a.crashed) {
      const p = a.cur;
      v = s.px === undefined ? 0 : Math.min(60, Math.hypot(p.x - s.px, p.z - s.pz) / Math.max(dt, 1e-3));
      s.px = p.x; s.pz = p.z;
    }
    const acc = (v - s.v) / Math.max(dt, 1e-3);
    s.acc = approach(s.acc, acc, dt, 0.25);
    s.v = v;
    const name = a.type?.name;
    const cfg = PROFILES[(TYPE_PROFILE[name] || TYPE_PROFILE.suv)[0]];
    const idle = cfg.idle, max = cfg.max;
    const braking = a.brake > 0.5 && v > 0.5;
    s.thr = a.crashed ? 0 : braking ? 0 : clamp(s.acc / 2.0 + (v > 1.5 ? 0.16 + v / 70 : 0.06), 0, 1);
    const wheelRpm = (g) => v / WHEEL_R * RATIOS[g - 1] * FINAL * RPM_PER * (max / 6500);
    // relaxed city driving: early upshifts, cruising around 1.8–3k rpm
    const up = max * (0.3 + 0.28 * s.thr);
    if (s.gear < RATIOS.length && wheelRpm(s.gear) > up) { s.gear++; s.shiftId++; }
    else if (s.gear > 1 && wheelRpm(s.gear) < max * 0.18) { s.gear--; s.shiftId++; }
    if (v < 0.5) s.gear = 1;
    s.rpm = a.crashed ? 0 : Math.max(idle * (1 + 0.04 * Math.sin(performance.now() * 0.003)), wheelRpm(s.gear));
    return { rpm: s.rpm, maxRpm: max, throttle: s.thr, engineLoad: s.thr, gear: s.gear, shiftId: s.shiftId, speedKmh: v * 3.6, brake: braking ? 1 : 0 };
  }

  playerPos() {
    const p = this.sys.game?.player;
    if (!p) return null;
    // where the player physically is (their vehicle, or the character) — NOT p.focus, which follows the free
    // camera. Honks at the player and carjack tracking are about the player, whatever the camera does.
    // (no physics-engine calls: object3d / interpolated feet position only)
    const c = p.controllable;
    const f = (p.state === 'vehicle' && c?.object3d?.position) || p.pos || p.focus;
    if (!f) return null;
    const dt = 1 / 60, last = this._pp;
    const k = 1 / Math.max(this._ppDt || dt, 1e-3);
    let vx = last ? (f.x - last.x) * k : 0, vz = last ? (f.z - last.z) * k : 0;
    if (vx * vx + vz * vz > 80 * 80) vx = vz = 0; // teleport / seat change, not motion
    this._pp = { x: f.x, z: f.z };
    return { x: f.x, z: f.z, vx, vz };
  }

  update(dt) {
    const sys = this.sys, tr = sys.game?.traffic;
    const L = sys.listener;
    if (!tr) return;
    const agents = tr.agents;
    this._ppDt = dt;
    const pp = this.playerPos();
    // track nearby agents so a vehicle spawned where one just vanished (carjack / take-over) keeps running
    const now = performance.now();
    const present = new Set(agents);
    for (const [a, p] of this.near) if (!present.has(a)) { this.vanished.push({ x: p.x, z: p.z, t: now, running: !a.crashed }); this.near.delete(a); }
    if (this.vanished.length && now - this.vanished[0].t > 3000) this.vanished = this.vanished.filter((v) => now - v.t < 3000);
    const cand = [];
    for (const a of agents) {
      const dx = a.cur.x - L.x, dz = a.cur.z - L.z;
      const d = Math.hypot(dx, dz, a.cur.y - L.y);
      a.__ad = d;
      // carjack tracking is about agents near the player (the camera may be a free camera far away)
      const dpl = pp ? Math.hypot(a.cur.x - pp.x, a.cur.z - pp.z) : d;
      if (dpl < 60) this.near.set(a, a.cur); else this.near.delete(a);
      if (d > 160) continue;
      const s = this.stateOf(a);
      if (!a.crashed) cand.push(a);
      // crash onset
      if (a.crashed && !s.crashed) {
        s.crashed = true;
        if (!sys.events?.isRecent(a.cur, 0.25, 6)) {
          sys.events?.mark(a.cur, 'impact');
          sys.play('crash', { position: { x: a.cur.x, y: a.cur.y, z: a.cur.z }, volume: 0.9, ref: 7, rolloff: 1.5, air: 0.8, delayByDistance: true });
        }
        for (const b of agents) if (b !== a && !b.crashed && Math.hypot(b.cur.x - a.cur.x, b.cur.z - a.cur.z) < 25 && Math.random() < 0.3) this.stateOf(b).hornCd = Math.min(this.stateOf(b).hornCd, 0.3 + Math.random());
      }
      if (a.crashed || !pp) continue;
      // horn logic: blocked by the player (car or on foot) or near miss
      s.hornCd -= dt;
      const fx = a.fx ?? 0, fz = a.fz ?? -1;
      const px = pp.x - a.cur.x, pz = pp.z - a.cur.z;
      const f = px * fx + pz * fz, lat = Math.abs(px * -fz + pz * fx);
      const blocked = (a.v || 0) < 0.6 && f > 1 && f < 13 && lat < 2.6 && Math.hypot(pp.vx, pp.vz) < 2.5;
      s.blockedT = blocked ? s.blockedT + dt : 0;
      const rel = Math.hypot(pp.vx - fx * (a.v || 0), pp.vz - fz * (a.v || 0));
      if (Math.hypot(px, pz) < 3.2 && rel > 14 && s.nearMiss <= 0) { s.nearMiss = 3; if (Math.random() < 0.3) s.hornCd = Math.min(s.hornCd, 0.15); }
      s.nearMiss -= dt;
      if ((s.blockedT > 2.5 || (s.hornCd <= 0 && s.hornCd > -0.5 && (s.blockedT > 0.2 || s.nearMiss > 2))) && s.hornCd <= 0 && d < 70) {
        this.honk(a, s);
      }
      if (s.hornCd < -0.5 && !blocked) s.hornCd = 1 + Math.random() * 3;
    }

    // (re)assign pooled voices to the nearest moving cars
    const max = this.maxVoices;
    while (this.voices.length < max) this.voices.push(new TrafficVoice(sys, this.noise));
    while (this.voices.length > max) this.voices.pop().dispose();
    this.assignT -= dt;
    if (this.assignT <= 0) {
      this.assignT = 0.25;
      cand.sort((p, q) => p.__ad - q.__ad);
      const want = cand.filter((a) => a.__ad < cullFor(a.type?.name) * 0.95).slice(0, max);
      const wantSet = new Set(want);
      const held = new Set();
      for (const vc of this.voices) {
        if (vc.agent && (wantSet.has(vc.agent) || (vc.agent.__ad < cullFor(vc.agent.type?.name) && !vc.agent.crashed && agents.includes(vc.agent) && cand.indexOf(vc.agent) < max + 1))) held.add(vc.agent);
        else if (vc.agent) { vc.next = null; vc.release = true; }
      }
      for (const a of want) {
        if (held.has(a)) continue;
        const free = this.voices.find((vc) => !vc.agent || vc.release);
        if (!free) break;
        free.next = a;
        free.release = true;
        held.add(a);
      }
    }
    for (const vc of this.voices) {
      // fade out → retarget → fade in
      if (vc.release) {
        vc.fade = approach(vc.fade, 0, dt, 0.06);
        if (vc.fade < 0.02) {
          vc.release = false;
          vc.agent = vc.next;
          vc.next = null;
          if (vc.agent) {
            vc.setType(vc.agent.type?.name);
            vc.engine.voice.follow(vc.agent.cur);
            vc.engine.voice.fresh = true;
          }
        }
      } else if (vc.agent) vc.fade = approach(vc.fade, 1, dt, 0.4);
      const a = vc.agent;
      if (!a) { vc.engine.volume = 0; vc.engine.update(null, dt); ramp(vc.roll.gain, 0, sys.ctx.currentTime, 0.05); continue; }
      if (!agents.includes(a) || a.crashed) { vc.release = true; vc.next = null; }
      if (!agents.includes(a)) { vc.engine.volume = 0; vc.engine.update(null, dt); continue; }
      const s = this.stateOf(a);
      const tel = this.simulate(a, s, dt);
      vc.engine.volume = 0.6 * vc.fade;
      vc.engine.update(tel, dt);
      const t = sys.ctx.currentTime;
      // silent below ~15 km/h, then grows with speed; far quieter than the player's tyres
      const gate = clamp((s.v - 4.2) / 4.5, 0, 1);
      ramp(vc.roll.gain, gate * gate * clamp(Math.pow(s.v / 25, 1.2), 0, 1.3) * 0.09 * vc.fade, t, 0.12, 1e-3);
      ramp(vc.rollBp.frequency, Math.min(800, 320 + s.v * 14), t, 0.15, 1e-2);
    }

    // horns in progress: h.seq = [on, off, on, off, ...] durations
    for (let i = this.honks.length - 1; i >= 0; i--) {
      const h = this.honks[i];
      h.t -= dt;
      if (h.t > 0) continue;
      h.k++;
      if (h.k >= h.seq.length) {
        h.horn?.stop();
        this.honks.splice(i, 1);
        setTimeout(() => h.voice.dispose(), 600);
        continue;
      }
      h.t = h.seq[h.k];
      if (h.k % 2 === 0) h.horn = new Horn(sys, h.type, h.voice.input);
      else { h.horn?.stop(); h.horn = null; }
    }

    // sirens on emergency vehicles (agent.siren set by gameplay)
    for (const [a, sv] of this.sirens) {
      if (!agents.includes(a) || !a.siren || a.__ad > 400) { sv.siren.stop(0.4); setTimeout(() => sv.voice.dispose(), 900); this.sirens.delete(a); }
    }
    if (this.sirens.size < 2) {
      for (const a of agents) {
        if (!a.siren || this.sirens.has(a) || a.__ad > 300 || this.sirens.size >= 2) continue;
        const voice = new Voice3D(sys, { position: a.cur, ref: 12, rolloff: 1.2, air: 0.4, cull: 450, reverb: 0.5, bus: sys.mixer.bus.sfx });
        this.sirens.set(a, { voice, siren: new Siren(sys, voice.input, Math.random() < 0.5 ? 'wail' : 'yelp') });
      }
    }
  }

  vanishedNear(p, r = 6) {
    const now = performance.now();
    return this.vanished.some((v) => v.running && now - v.t < 3000 && Math.hypot(v.x - p.x, v.z - p.z) < r);
  }

  honk(a, s) {
    const sys = this.sys;
    s.hornCd = 6 + Math.random() * 8;
    s.blockedT = 0;
    // the street honks as a whole at most every ~4 s (one impatient driver at a time)
    const now = performance.now();
    if (this.honks.length >= 2 || now - (this.lastHonk || 0) < 4000 + Math.random() * 2000) return;
    this.lastHonk = now;
    const type = HORN_TYPE[a.type?.name] || 'car';
    const voice = new Voice3D(sys, { position: a.cur, ref: 6, rolloff: 1.6, air: 1, cull: 140, reverb: 0.35, bus: sys.mixer.bus.sfx });
    const r = Math.random();
    const seq = r < 0.35 ? [0.7 + Math.random() * 0.9] : r < 0.7 ? [0.18, 0.12, 0.22] : [0.14, 0.1, 0.14, 0.1, 0.35];
    this.honks.push({ voice, type, horn: new Horn(sys, type, voice.input), seq, k: 0, t: seq[0] });
  }

  dispose() {
    for (const vc of this.voices) vc.dispose();
    for (const h of this.honks) { h.horn?.stop(); h.voice.dispose(); }
    for (const sv of this.sirens.values()) { sv.siren.stop(0.1); sv.voice.dispose(); }
    try { this.noiseSrc.stop(); } catch { /* */ }
    disconnectAll(this.noiseSrc, this.noise);
  }
}
