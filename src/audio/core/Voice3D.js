import { ramp, snap, clamp, posOf, disconnectAll } from './util.js';

const C = 343; // speed of sound m/s

// distance low-pass ("air absorption" + street clutter). k scales the strength per sound class:
//   k = 1    vehicles / traffic / foley: ~12 kHz @ 5 m → ~1.9 kHz @ 60 m → ~1 kHz @ 150 m
//   k = 0.6  generic events (impacts, critters): ~7 kHz @ 30 m → ~4.4 kHz @ 60 m
//   k = 0.35 big far events (explosions, thunder, sirens)
export const airCutoff = (d, k = 0.6) => (d <= 4 ? 24000 : clamp(14000 * Math.pow(d / 4, -0.75 * k), 250, 24000));

// Positional voice: input → [doppler/propagation delay] → air+occlusion low-pass → level → PannerNode → bus
//                                                                         ├→ reverb send (distance-scaled)
//                                                                         └→ direct (unpanned, stereo width for the player car;
//                                                                            only while the listener is within a few metres)
// 1 within r metres of the listener (default 8), smooth fade to 0 over the next 12 m
export const directNear = (d, r = 8) => {
  if (d <= r) return 1;
  if (d >= r + 12) return 0;
  const t = (d - r) / 12;
  return 1 - t * t * (3 - 2 * t);
};

export class Voice3D {
  constructor(sys, o = {}) {
    const ctx = sys.ctx;
    this.sys = sys;
    this.ctx = ctx;
    this.input = ctx.createGain();
    let node = this.input;
    this.doppler = o.doppler !== false && sys.dopplerEnabled !== false;
    if (this.doppler) {
      this.delay = ctx.createDelay(o.maxDelay ?? 1.3);
      this.delay.delayTime.value = 0;
      node.connect(this.delay);
      node = this.delay;
    }
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = -3; // dB → no resonant bump
    this.filter.frequency.value = ctx.sampleRate / 2;
    node.connect(this.filter);
    this.level = ctx.createGain();
    this.filter.connect(this.level);
    const p = (this.panner = ctx.createPanner());
    p.panningModel = (o.hrtf ?? sys.hrtf) ? 'HRTF' : 'equalpower';
    p.distanceModel = o.distanceModel || 'inverse';
    p.refDistance = o.ref ?? 6;
    p.rolloffFactor = o.rolloff ?? 1;
    p.maxDistance = o.maxDistance ?? 10000;
    this.air = o.air ?? 0.6;
    // hard cull: the voice fades to silence over the last 20 % before `cull` metres
    this.cull = o.cull ?? Infinity;
    this.bus = o.bus || sys.mixer.bus.sfx;
    this.level.connect(p).connect(this.bus);
    this.reverbAmt = o.reverb ?? 0.3;
    if (this.reverbAmt > 0) {
      this.send = ctx.createGain();
      this.send.gain.value = 0;
      this.level.connect(this.send).connect(sys.mixer.reverbIn);
    }
    if (o.direct) {
      this.directGain = ctx.createGain();
      this.directGain.gain.value = 0;
      this.directAmt = o.direct;
      this.directRange = 8; // the owner may widen this while its own camera rides along (chase cam on a bus)
      this.level.connect(this.directGain).connect(this.bus);
    }
    this.pos = { x: 0, y: 0, z: 0 };
    this.target = o.object3d || o.position || null;
    this.dist = 0;
    this.occl = 0;
    this.occlTarget = 0;
    this.gain = 1;
    this.fresh = true;
    this.ref = p.refDistance;
    this.minFilter = 20000;
    this.extraCut = 20000;
    sys.voices.add(this);
  }

  follow(target) { this.target = target; return this; }
  setPosition(x, y, z) {
    if (typeof x === 'object') this.target = { x: x.x, y: x.y, z: x.z };
    else this.target = { x, y, z };
    return this;
  }

  // estimated loudness at the listener (inverse model) — used for pooling/culling
  audibility() {
    const r = this.panner.rolloffFactor;
    return this.ref / (this.ref + r * Math.max(0, this.dist - this.ref)) * this.cullGain(this.dist);
  }

  cullGain(d) {
    if (!(this.cull < Infinity)) return 1;
    const a = this.cull * 0.8;
    if (d <= a) return 1;
    if (d >= this.cull) return 0;
    const t = (d - a) / (this.cull - a);
    return 1 - t * t * (3 - 2 * t);
  }

  // snapAt: audio time at which to jump (teleports are bracketed by a mixer dip), 0 = smooth
  update(dt, L, snapAt = 0) {
    if (this.target && !posOf(this.target, this.pos)) return;
    const now = this.ctx.currentTime;
    const forceSnap = snapAt > 0;
    const t = forceSnap ? Math.max(now, snapAt) : now;
    const p = this.pos;
    const dx = p.x - L.x, dy = p.y - L.y, dz = p.z - L.z;
    const d = Math.hypot(dx, dy, dz);
    const jump = Math.abs(d - this.dist) > 60;
    this.dist = d;
    const pn = this.panner;
    if (this.fresh || forceSnap) {
      snap(pn.positionX, p.x, t); snap(pn.positionY, p.y, t); snap(pn.positionZ, p.z, t);
    } else {
      ramp(pn.positionX, p.x, t, 0.02, 1e-5); ramp(pn.positionY, p.y, t, 0.02, 1e-5); ramp(pn.positionZ, p.z, t, 0.02, 1e-5);
    }
    // doppler: delay = d / c, slew-limited (max ±25 % pitch)
    if (this.doppler) {
      const target = Math.min(d / C, 1.25);
      if (this.fresh || forceSnap || jump) {
        snap(this.delay.delayTime, target, t);
        this._dl = target;
      } else {
        const maxStep = 0.25 * dt;
        this._dl += clamp(target - this._dl, -maxStep, maxStep);
        ramp(this.delay.delayTime, this._dl, t, 0.05, 1e-6);
      }
    }
    this.occl += (this.occlTarget - this.occl) * Math.min(1, dt * 4);
    let cut = Math.min(airCutoff(d, this.air) * (1 - 0.82 * this.occl), this.extraCut);
    if (cut > 17500) cut = this.ctx.sampleRate / 2;
    if (this.fresh) snap(this.filter.frequency, cut, t); else ramp(this.filter.frequency, cut, t, 0.08, 0.02);
    const lvl = this.gain * (1 - 0.45 * this.occl) * this.cullGain(d);
    if (this.fresh) snap(this.level.gain, lvl, t); else ramp(this.level.gain, lvl, t, 0.05, 1e-3);
    if (this.directGain) {
      // the unpanned share has no distance model of its own: it is a "you are right next to it" width cue, so it
      // fades out between 8 and 20 m and the voice becomes a plain point source (e.g. a free camera flying away)
      const dg = this.directAmt * directNear(d, this.directRange);
      if (this.fresh) snap(this.directGain.gain, dg, t); else ramp(this.directGain.gain, dg, t, 0.08, 0.01);
    }
    if (this.send) {
      const s = this.reverbAmt * (0.3 + 0.7 * clamp(d / 70, 0, 1)) * (1 + 0.6 * this.occl);
      ramp(this.send.gain, s, t, 0.1, 0.01);
    }
    this.fresh = false;
  }

  // unpanned share at close range; update() scales it by distance
  setDirect(v) {
    this.directAmt = v;
  }

  dispose() {
    this.sys.voices.delete(this);
    disconnectAll(this.input, this.delay, this.filter, this.level, this.panner, this.send, this.directGain);
  }
}
