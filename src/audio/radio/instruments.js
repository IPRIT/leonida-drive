// Node-based instruments for the generative radio. Every function schedules at audio time `t`
// and cleans its nodes up when finished.
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function done(src, ...nodes) {
  src.onended = () => { for (const n of [src, ...nodes]) { try { n.disconnect(); } catch { /* */ } } };
}

function env(g, t, peak, a, d, sustain, rel, end) {
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setTargetAtTime(peak * sustain, t + a, d);
  g.gain.setTargetAtTime(0, end, rel);
}

export class Inst {
  constructor(ctx, noise) { this.ctx = ctx; this.noise = noise; this.wobble = null; }

  osc(type, f, t, stop, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.detune.value = detune;
    if (this.wobble) {
      const w = this.wobble;
      w.connect(o.detune);
      o.addEventListener('ended', () => { try { w.disconnect(o.detune); } catch { /* */ } });
    }
    o.start(t);
    o.stop(stop);
    return o;
  }

  noiseSrc(t, stop, offset = Math.random()) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(t, offset);
    s.stop(stop);
    return s;
  }

  // ---- drums ----
  kick(dest, t, { vel = 1, f0 = 150, f1 = 44, decay = 0.32, click = 0.25 } = {}) {
    const ctx = this.ctx, end = t + decay * 4;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.01, decay / 2.5);
    o.connect(g).connect(dest);
    o.start(t); o.stop(end);
    done(o, g);
    if (click > 0) {
      const n = this.noiseSrc(t, t + 0.02);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(click * vel, t); ng.gain.setTargetAtTime(0, t, 0.004);
      n.connect(hp).connect(ng).connect(dest);
      done(n, hp, ng);
    }
  }

  snare(dest, t, { vel = 1, tone = 190, decay = 0.16, bp = 1900, gated = 0, send = null, sendAmt = 0 } = {}) {
    const ctx = this.ctx;
    const len = gated || decay * 5;
    const n = this.noiseSrc(t, t + len + 0.05);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.8, t + 0.002);
    if (gated) { g.gain.setTargetAtTime(vel * 0.35, t + 0.01, 0.05); g.gain.setTargetAtTime(0, t + gated, 0.01); }
    else g.gain.setTargetAtTime(0, t + 0.005, decay / 3);
    n.connect(f).connect(g).connect(dest);
    if (send) { const s = ctx.createGain(); s.gain.value = sendAmt; g.connect(s).connect(send); done(n, f, g, s); } else done(n, f, g);
    const o = this.osc('triangle', tone, t, t + 0.2);
    o.frequency.exponentialRampToValueAtTime(tone * 0.7, t + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vel * 0.5, t); og.gain.setTargetAtTime(0, t, 0.035);
    o.connect(og).connect(dest);
    done(o, og);
  }

  clap(dest, t, { vel = 1 } = {}) {
    const ctx = this.ctx;
    const n = this.noiseSrc(t, t + 0.4);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 3; k++) { g.gain.setValueAtTime(vel * 0.8, t + k * 0.011); g.gain.setTargetAtTime(0.05, t + k * 0.011 + 0.002, 0.004); }
    g.gain.setValueAtTime(vel * 0.7, t + 0.035);
    g.gain.setTargetAtTime(0, t + 0.036, 0.06);
    n.connect(f).connect(g).connect(dest);
    done(n, f, g);
  }

  hat(dest, t, { vel = 1, open = false, hp = 7500 } = {}) {
    const ctx = this.ctx;
    const dec = open ? 0.09 : 0.018;
    const n = this.noiseSrc(t, t + dec * 6);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.35, t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.002, dec);
    n.connect(f).connect(g).connect(dest);
    done(n, f, g);
  }

  shaker(dest, t, { vel = 1 } = {}) {
    const ctx = this.ctx;
    const n = this.noiseSrc(t, t + 0.12);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 6000; f.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 0.22, t + 0.015);
    g.gain.setTargetAtTime(0, t + 0.02, 0.02);
    n.connect(f).connect(g).connect(dest);
    done(n, f, g);
  }

  tom(dest, t, f0, { vel = 1 } = {}) {
    const ctx = this.ctx;
    const o = this.osc('sine', f0, t, t + 0.6);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.7, t + 0.003); g.gain.setTargetAtTime(0, t + 0.01, 0.12);
    o.connect(g).connect(dest);
    done(o, g);
  }

  conga(dest, t, f0, { vel = 1, slap = false } = {}) {
    const ctx = this.ctx;
    const o = this.osc('sine', f0 * 1.15, t, t + 0.4);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.55, t + 0.002); g.gain.setTargetAtTime(0, t + 0.01, slap ? 0.04 : 0.09);
    o.connect(g).connect(dest);
    done(o, g);
    if (slap) {
      const n = this.noiseSrc(t, t + 0.05);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 1;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(vel * 0.4, t); ng.gain.setTargetAtTime(0, t, 0.008);
      n.connect(f).connect(ng).connect(dest);
      done(n, f, ng);
    }
  }

  clave(dest, t, { vel = 1 } = {}) {
    const ctx = this.ctx;
    const o = this.osc('sine', 2500, t, t + 0.1);
    const g = ctx.createGain(); g.gain.setValueAtTime(vel * 0.3, t); g.gain.setTargetAtTime(0, t, 0.018);
    o.connect(g).connect(dest);
    done(o, g);
  }

  cowbell(dest, t, { vel = 1 } = {}) {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 2;
    const g = ctx.createGain(); g.gain.setValueAtTime(vel * 0.25, t); g.gain.setTargetAtTime(0, t + 0.01, 0.06);
    f.connect(g).connect(dest);
    const a = this.osc('square', 562, t, t + 0.35), b = this.osc('square', 845, t, t + 0.35);
    a.connect(f); b.connect(f);
    done(a, f, g); done(b);
  }

  // ---- tonal ----
  bass(dest, t, m, dur, { vel = 1, type = 'sawtooth', cutoff = 700, envAmt = 1400, q = 4, decay = 0.12, sub = 0.5, glideFrom = null } = {}) {
    const ctx = this.ctx, end = t + dur;
    const f = mtof(m);
    const o = this.osc(type, glideFrom ? mtof(glideFrom) : f, t, end + 0.3);
    if (glideFrom) o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = q;
    lp.frequency.setValueAtTime(cutoff + envAmt, t);
    lp.frequency.setTargetAtTime(cutoff, t, decay);
    const g = ctx.createGain();
    env(g, t, vel * 0.5, 0.004, 0.2, 0.75, 0.03, end);
    o.connect(lp).connect(g).connect(dest);
    done(o, lp, g);
    if (sub > 0) {
      const s = this.osc('sine', f / 2, t, end + 0.3);
      const sg = ctx.createGain();
      env(sg, t, vel * 0.5 * sub, 0.004, 0.3, 0.9, 0.03, end);
      s.connect(sg).connect(dest);
      done(s, sg);
    }
  }

  pad(dest, t, notes, dur, { vel = 1, cutoff = 1800, attack = 0.35, release = 0.5, detune = 9, type = 'sawtooth', voices = 3 } = {}) {
    const ctx = this.ctx, end = t + dur;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0.8;
    const g = ctx.createGain();
    env(g, t, vel * 0.16 / Math.sqrt(notes.length), attack, 0.6, 0.85, release / 3, end);
    lp.connect(g).connect(dest);
    let first = null;
    for (const m of notes) {
      for (let v = 0; v < voices; v++) {
        const o = this.osc(type, mtof(m), t, end + release * 2, (v - (voices - 1) / 2) * detune * 2);
        o.connect(lp);
        if (!first) { first = o; done(o, lp, g); } else done(o);
      }
    }
  }

  pluck(dest, t, m, dur, { vel = 1, type = 'square', cutoff = 2400, decay = 0.12, send = null, sendAmt = 0 } = {}) {
    const ctx = this.ctx, end = t + dur;
    const o = this.osc(type, mtof(m), t, end + 0.3, (Math.random() - 0.5) * 6);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(cutoff * 2, t); lp.frequency.setTargetAtTime(cutoff * 0.4, t, decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.16, t + 0.003); g.gain.setTargetAtTime(0, t + 0.005, decay); g.gain.setTargetAtTime(0, end, 0.02);
    o.connect(lp).connect(g).connect(dest);
    if (send) { const s = ctx.createGain(); s.gain.value = sendAmt; g.connect(s).connect(send); done(o, lp, g, s); } else done(o, lp, g);
  }

  lead(dest, t, m, dur, { vel = 1, type = 'sawtooth', cutoff = 3200, vib = 18, glideFrom = null, send = null, sendAmt = 0, attack = 0.02 } = {}) {
    const ctx = this.ctx, end = t + dur;
    const f = mtof(m);
    const mk = (det) => {
      const o = this.osc(type, glideFrom ? mtof(glideFrom) : f, t, end + 0.5, det);
      if (glideFrom) o.frequency.setTargetAtTime(f, t, 0.03);
      return o;
    };
    const o1 = mk(-6), o2 = mk(6);
    const lfo = this.osc('sine', 5.5, t, end + 0.5);
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(vib, t + Math.min(0.35, dur));
    lfo.connect(lg); lg.connect(o1.detune); lg.connect(o2.detune);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 1;
    const g = ctx.createGain();
    env(g, t, vel * 0.13, attack, 0.3, 0.8, 0.06, end);
    o1.connect(lp); o2.connect(lp);
    lp.connect(g).connect(dest);
    if (send) { const s = ctx.createGain(); s.gain.value = sendAmt; g.connect(s).connect(send); done(o1, lp, g, s, lfo, lg); } else done(o1, lp, g, lfo, lg);
    done(o2);
  }

  // electric piano (2-op FM)
  rhodes(dest, t, notes, dur, { vel = 1, bright = 1 } = {}) {
    const ctx = this.ctx, end = t + dur;
    const g = ctx.createGain();
    env(g, t, vel * 0.22 / Math.sqrt(notes.length), 0.003, 0.5, 0.45, 0.15, end);
    g.connect(dest);
    let first = true;
    for (const m of notes) {
      const f = mtof(m);
      const c = this.osc('sine', f, t, end + 0.8, (Math.random() - 0.5) * 8);
      const mo = this.osc('sine', f, t, end + 0.8);
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 1.6 * bright, t);
      mg.gain.setTargetAtTime(f * 0.25 * bright, t, 0.12);
      mo.connect(mg).connect(c.frequency);
      c.connect(g);
      if (first) { done(c, mg, g); first = false; } else done(c, mg);
      done(mo);
    }
  }

  piano(dest, t, notes, dur, { vel = 1 } = {}) {
    const ctx = this.ctx, end = t + dur;
    const g = ctx.createGain();
    env(g, t, vel * 0.2 / Math.sqrt(notes.length), 0.002, 0.25, 0.25, 0.08, end);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(5000, t); lp.frequency.setTargetAtTime(1600, t, 0.2);
    lp.connect(g).connect(dest);
    let first = true;
    for (const m of notes) {
      const f = mtof(m);
      for (const [type, k, gain] of [['triangle', 1, 1], ['sine', 2, 0.4], ['sine', 3.01, 0.15]]) {
        const o = this.osc(type, f * k, t, end + 0.4, (Math.random() - 0.5) * 4);
        const og = ctx.createGain(); og.gain.value = gain;
        o.connect(og).connect(lp);
        if (first) { done(o, og, lp, g); first = false; } else done(o, og);
      }
    }
  }

  brass(dest, t, notes, dur, { vel = 1 } = {}) {
    const ctx = this.ctx, end = t + dur;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
    lp.frequency.setValueAtTime(700, t); lp.frequency.linearRampToValueAtTime(3200, t + 0.04); lp.frequency.setTargetAtTime(1400, t + 0.05, 0.1);
    const g = ctx.createGain();
    env(g, t, vel * 0.14 / Math.sqrt(notes.length), 0.02, 0.15, 0.7, 0.05, end);
    lp.connect(g).connect(dest);
    let first = true;
    for (const m of notes) for (const d of [-7, 0, 7]) {
      const o = this.osc('sawtooth', mtof(m), t, end + 0.3, d);
      o.connect(lp);
      if (first) { done(o, lp, g); first = false; } else done(o);
    }
  }

  bell(dest, t, m, dur, { vel = 1 } = {}) {
    const ctx = this.ctx;
    const f = mtof(m);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.12, t + 0.002); g.gain.setTargetAtTime(0, t + 0.005, Math.max(0.15, dur / 2));
    g.connect(dest);
    const c = this.osc('sine', f, t, t + dur * 3 + 0.5);
    const mo = this.osc('sine', f * 3.5, t, t + dur * 3 + 0.5);
    const mg = ctx.createGain(); mg.gain.setValueAtTime(f * 2, t); mg.gain.setTargetAtTime(0, t, 0.2);
    mo.connect(mg).connect(c.frequency);
    c.connect(g);
    done(c, mg, g); done(mo);
  }

  marimba(dest, t, m, { vel = 1 } = {}) {
    const ctx = this.ctx;
    const f = mtof(m);
    const g = ctx.createGain();
    g.connect(dest);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.2, t + 0.002); g.gain.setTargetAtTime(0, t + 0.004, 0.12);
    const a = this.osc('sine', f, t, t + 0.8), b = this.osc('sine', f * 4, t, t + 0.2);
    const bg = ctx.createGain(); bg.gain.setValueAtTime(0.3, t); bg.gain.setTargetAtTime(0, t, 0.02);
    a.connect(g); b.connect(bg).connect(g);
    done(a, g); done(b, bg);
  }

  sweep(dest, t, dur, { up = true, vel = 1 } = {}) {
    const ctx = this.ctx;
    const n = this.noiseSrc(t, t + dur + 0.1);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(up ? 300 : 6000, t);
    f.frequency.exponentialRampToValueAtTime(up ? 7000 : 250, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.25, t + (up ? dur * 0.95 : 0.02)); g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    n.connect(f).connect(g).connect(dest);
    done(n, f, g);
  }
}
