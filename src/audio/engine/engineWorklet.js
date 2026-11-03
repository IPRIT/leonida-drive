// AudioWorklet engine synthesiser. The processor source is shipped as a Blob URL built from `processorMain`
// (self-contained: it must not reference anything outside its own body).
//
// Model (mode 'ice'): crank-angle clock → per-cylinder firing events (firing order / bank layout, per-cycle
// amplitude + timing jitter, cam lope misfires, limiter ignition cut, overrun pops) → exhaust pressure pulses
// (slow pulse ∝ valve-open time + sharp blow-down transient + combustion noise) → per-bank pipe waveguide
// (comb) → fixed exhaust formants + muffler low-pass (opens with load/rpm) → load-dependent saturation.
// Plus: intake roar (throttle), valvetrain ticks, diesel knock, supercharger whine, turbo whistle, starter motor,
// propeller blade-pass, underwater exhaust gurgle. Other modes: 'ev', 'turbine', 'rotor', 'bike'.

export const ENGINE_PROCESSOR = 'ld-engine';

export function processorMain() {
  const TAU = Math.PI * 2;

  class BQ {
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
    set(type, f, q) {
      const w = TAU * Math.min(Math.max(f, 10), sampleRate * 0.45) / sampleRate;
      const cs = Math.cos(w), al = Math.sin(w) / (2 * Math.max(q, 0.1));
      const a0 = 1 + al;
      if (type === 1) { // bandpass (0 dB peak)
        this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0;
      } else if (type === 2) { // highpass
        this.b0 = (1 + cs) / 2 / a0; this.b1 = -(1 + cs) / a0; this.b2 = this.b0;
      } else { // lowpass
        this.b0 = (1 - cs) / 2 / a0; this.b1 = (1 - cs) / a0; this.b2 = this.b0;
      }
      this.a1 = -2 * cs / a0; this.a2 = (1 - al) / a0;
      return this;
    }
    p(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
  }

  const sat = (x) => (x > 3 ? 1 : x < -3 ? -1 : (x * (27 + x * x)) / (27 + 9 * x * x));
  const kOf = (sec) => 1 - Math.exp(-1 / Math.max(1, sec * sampleRate));

  class EngineProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      const p = (name, def, min = 0, max = 1e5) => ({ name, defaultValue: def, minValue: min, maxValue: max, automationRate: 'k-rate' });
      return [
        p('rpm', 800), p('throttle', 0), p('load', 0), p('gain', 0), p('pitch', 1, 0.1, 4), p('turbo', 0),
        p('limiter', 0), p('speed', 0), p('ignition', 1), p('starter', 0), p('aux', 0), p('far', 0), p('water', 0),
      ];
    }

    constructor(options) {
      super();
      this.seed = (Math.random() * 4294967295) >>> 0 || 1;
      this.prev = null;
      this.t = 0;
      this.configure((options.processorOptions || {}).cfg || {});
      this.port.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'cfg') this.configure(d.cfg);
        else if (d.type === 'pop') this.popQueue = Math.min(12, (this.popQueue || 0) + (d.count || 1));
        else if (d.type === 'stop') this.alive = false;
      };
      this.alive = true;
    }

    rnd() { let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x >>> 0; return this.seed / 4294967296; }
    nz() { return this.rnd() * 2 - 1; }
    gauss() { return (this.rnd() + this.rnd() + this.rnd() - 1.5) * 1.15; }

    configure(c) {
      this.c = c;
      this.mode = c.mode || 'ice';
      const n = c.cyl || 4;
      this.N = n;
      this.offs = c.offsets || Array.from({ length: n }, (_, i) => i / n);
      this.banks = c.banks || new Array(n).fill(0);
      this.fireAt = this.offs.slice();
      this.cylAmp = new Float32Array(n).fill(1);
      this.cylBias = new Float32Array(n);
      for (let i = 0; i < n; i++) this.cylBias[i] = 1 + (c.imbalance ?? 0.06) * this.gauss();
      this.ph = 0; this.next = 0;
      this.impS = [0, 0]; this.impF = [0, 0];
      this.s1 = [0, 0]; this.s2 = [0, 0]; this.f1 = [0, 0]; this.f2 = [0, 0];
      this.mask = 4095;
      this.pipe = [new Float32Array(4096), new Float32Array(4096)];
      this.pipeLp = [0, 0];
      this.w = 0;
      const pms = c.pipe || [4, 4.6];
      this.D = [Math.max(2, Math.round(pms[0] * sampleRate / 1000)), Math.max(2, Math.round((pms[1] ?? pms[0]) * sampleRate / 1000))];
      this.D[0] = Math.min(this.D[0], 4000); this.D[1] = Math.min(this.D[1], 4000);
      this.fb = c.pipeFb ?? 0.35;
      this.pipeK = 1 - Math.exp(-TAU * (c.pipeDamp || 3200) / sampleRate);
      this.bankGain = c.bankGain || [1, 0.85];
      this.dc = 0; this.dcK = 1 - Math.exp(-TAU * 22 / sampleRate);
      this.dc2 = 0; this.dcK2 = 1 - Math.exp(-TAU * 12 / sampleRate);
      const forms = c.formants || [[120, 1.4, 0.6], [400, 2, 0.6], [1200, 2.5, 0.4]];
      // lite (traffic): 3 strongest formants, single bank
      this.form = (c.lite ? forms.slice(0, 3) : forms).map(([f, q, g]) => ({ bq: new BQ().set(1, f, q), g }));
      this.nBanks = c.lite ? 1 : 2;
      this.direct = new BQ().set(0, c.directF || 260, 0.7);
      this.directG = c.direct ?? 0.6;
      this.muf = new BQ().set(0, c.muffler || 1500, 0.6);
      this.muf2 = new BQ().set(0, c.muffler || 1500, 0.6);
      const ik = c.intake || [1000, 1, 0.4];
      this.intake = new BQ().set(1, ik[0], ik[1]);
      this.intakeF = ik[0]; this.intakeQ = ik[1]; this.intakeAmt = ik[2];
      this.tickHp = new BQ().set(1, 3300, 1.4);
      this.knockBp = new BQ().set(1, c.knockF || 2300, 2.5);
      this.hissHp = new BQ().set(2, 2500, 0.7);
      this.hissLp = new BQ().set(0, 5000, 0.7);
      this.crackHp = new BQ().set(2, 1800, 0.7);
      this.crackLp = new BQ().set(0, c.crackLp || 2600, 0.7);
      this.bodyK = 0;
      this.gurgle = new BQ().set(1, 380, 3);
      this.starterBp = new BQ().set(1, 900, 1.5);
      this.nEnv = 0; this.tkEnv = 0; this.knEnv = 0; this.crEnv = 0; this.guEnv = 0;
      this.overrun = 0; this.thrMax = 0; this.limPh = 0;
      this.turboPh = 0; this.whinePh = 0; this.starterPh = 0; this.huntPh = 0;
      this.propPh = 0; this.propImp = 0; this.p1 = 0; this.p2 = 0;
      this.propLp = new BQ().set(0, 900, 0.7);
      // ev
      this.evPh = [0, 0, 0, 0, 0];
      this.humBp = new BQ().set(1, 120, 4);
      this.swLp = new BQ().set(0, 1800, 0.7);
      // turbine
      this.roarBp = new BQ().set(1, 400, 0.6); this.roarLp = new BQ().set(0, 1600, 0.7);
      this.buzzBp = new BQ().set(1, 1800, 1.2);
      this.abLp = new BQ().set(0, 160, 0.7); this.abEnv = 0;
      this.tPh = new Float64Array(10);
      // rotor
      this.bladePh = 0; this.tailPh = 0; this.slap1 = 0; this.slap2 = 0; this.slapImp = 0; this.chopEnv = 0;
      this.tail1 = 0; this.tail2 = 0; this.tailImp = 0;
      this.chopBp = new BQ().set(1, 650, 0.8); this.tailBp = new BQ().set(1, 700, 1.2); this.slapLp = new BQ().set(0, 420, 0.7);
      this.exhLp = new BQ().set(0, 900, 0.7);
      // bike
      this.clickPh = 0; this.clickEnv = 0; this.chainPh = 0;
      this.tyreBp = new BQ().set(1, 500, 0.8); this.chainBp = new BQ().set(1, 3000, 1.2);
      this.blockN = 0;
    }

    newCycle(rpmN) {
      const c = this.c, n = this.N;
      const jit = c.jitter ?? 0.06, tj = (c.timing ?? 0.004) / n;
      const lope = (c.lope || 0) * Math.max(0, 1 - rpmN / 0.28);
      const mis = (c.misfire || 0) * Math.max(0, 1 - this.loadNow * 2.5);
      const cyc = 1 + lope * 0.18 * this.gauss();
      for (let i = 0; i < n; i++) {
        let a = this.cylBias[i] * cyc * (1 + jit * this.gauss());
        if (lope > 0 && this.rnd() < lope * 0.22) a *= 0.3;
        if (mis > 0 && this.rnd() < mis * 0.5) a *= 0.12;
        this.cylAmp[i] = Math.max(0, a);
        this.fireAt[i] = this.offs[i] + tj * this.gauss();
      }
      this.fireAt[0] = Math.max(0, this.fireAt[0]);
    }

    fire(i, comb, rpmN, thr) {
      const c = this.c;
      const b = this.banks[i] || 0;
      let a = this.cylAmp[i] * comb;
      const limCut = this.limOn && (this.limPh % 1) < 0.5;
      if (limCut) a *= 0.1;
      this.impS[b] += a;
      this.impF[b] += a * (0.35 + 0.65 * this.loadNow);
      this.nEnv = Math.max(this.nEnv, a);
      this.tkEnv = 1;
      if (c.knock) this.knEnv = Math.max(this.knEnv, a * (1 - 0.5 * this.loadNow) + 0.15);
      if (this.waterNow > 0.05) { this.guEnv += a * this.waterNow; this.gurgle.set(1, 250 + this.rnd() * 450, 3); }
      // overrun crackle / pops
      const popAmt = c.crackle || 0;
      let pop = 0;
      if (this.popQueue > 0 && this.rnd() < 0.5) { pop = 1; this.popQueue--; }
      else if (popAmt > 0 && this.overrun > 0 && thr < 0.08 && rpmN > (c.popMin ?? 0.3) && !limCut) {
        if (this.rnd() < popAmt * 0.16 * (0.4 + rpmN)) pop = this.rnd() < 0.05 * popAmt ? 3 : 1;
      }
      if (pop) {
        const p = (0.8 + this.rnd() * 1.4) * pop * (0.6 + popAmt * 0.4);
        this.impF[b] += p;
        this.impS[b] += p * 0.3;
        this.crEnv = Math.max(this.crEnv, (0.5 + this.rnd() * 0.5) * Math.min(2, pop));
      }
    }

    process(inputs, outputs, params) {
      const out = outputs[0][0];
      if (!out) return this.alive;
      const n = out.length;
      const P = (k) => params[k][0];
      const cur = {
        rpm: P('rpm'), thr: P('throttle'), load: P('load'), gain: P('gain'), pitch: P('pitch'), turbo: P('turbo'),
        speed: P('speed'), ign: P('ignition'), starter: P('starter'), aux: P('aux'), far: P('far'), water: P('water'),
      };
      const pv = this.prev || cur;
      this.prev = cur;
      if (cur.gain < 1e-5 && pv.gain < 1e-5) { out.fill(0); this.t += n / sampleRate; return this.alive; }
      this.limOn = P('limiter') > 0.5;
      this.loadNow = cur.load; this.waterNow = cur.water;
      this.blockN++;
      const c = this.c;
      // overrun detection (throttle lift)
      const dtB = n / sampleRate;
      this.thrMax = Math.max(cur.thr, this.thrMax - dtB * 1.5);
      if (cur.thr < 0.1 && this.thrMax > 0.5 && this.overrun <= 0) this.overrun = 0.5 + (c.crackle || 0) * 1.4;
      if (cur.thr > 0.2) this.overrun = 0;
      this.overrun -= dtB;

      switch (this.mode) {
        case 'ev': this.renderEV(out, n, pv, cur); break;
        case 'turbine': this.renderTurbine(out, n, pv, cur); break;
        case 'rotor': this.renderRotor(out, n, pv, cur); break;
        case 'bike': this.renderBike(out, n, pv, cur); break;
        default: this.renderICE(out, n, pv, cur);
      }
      // gain ramp + safety soft clip
      const lvl = c.level ?? 1;
      const ok = this.dcK2;
      for (let i = 0; i < n; i++) {
        const g = (pv.gain + (cur.gain - pv.gain) * (i / n)) * lvl;
        const y = sat(out[i] * g);
        this.dc2 += ok * (y - this.dc2);
        out[i] = y - this.dc2;
      }
      for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
      this.t += dtB;
      return this.alive;
    }

    renderICE(out, n, pv, cur) {
      const c = this.c;
      const idle = c.idle || 800, max = c.max || 7000;
      const stroke = c.stroke === 2 ? 1 : 2;
      const sr = sampleRate, inv = 1 / sr, invN = 1 / n;
      const rpmAvg = Math.max(0, (pv.rpm + cur.rpm) * 0.5);
      const rpmN = Math.min(1.2, Math.max(0, (rpmAvg - idle) / (max - idle)));
      const cycHz = Math.max(0.01, rpmAvg * cur.pitch / 60 / stroke);
      const fireHz = cycHz * this.N;
      // pulse shaping: slow ∝ valve-open time, fast = blow-down transient
      const kS = kOf(Math.min(0.012, (c.pulse ?? 0.32) / fireHz / 2.2));
      const kF = kOf(c.fast ?? 0.00028);
      const nDec = Math.exp(-1 / (sr * Math.min(0.008, 0.5 / fireHz)));
      // muffler opens with load and rpm, closes underwater
      const mf = ((c.muffler || 1400) + ((c.mufflerOpen || 4000) - (c.muffler || 1400)) * Math.min(1, 0.55 * cur.load + 0.45 * rpmN)) * (1 - 0.8 * cur.water);
      if ((this.blockN & 1) === 0) {
        this.muf.set(0, mf, 0.62); this.muf2.set(0, mf * 1.25, 0.55);
        this.intake.set(1, this.intakeF * (0.7 + 0.8 * rpmN), this.intakeQ);
      }
      const ign = cur.ign;
      const pump = c.pump ?? 0.3;
      // game-mix loudness compensation: lift idle / low rpm (real engines span ~30 dB)
      const idleComp = 1 + (c.idleComp ?? 1.1) * Math.pow(Math.max(0, 1 - rpmN * 2.2), 2) * (1 - 0.5 * cur.load);
      const drive = (c.drive ?? 1.3) * (1 + (c.harsh ?? 1) * cur.load * (0.5 + 0.5 * rpmN));
      const dNorm = 1 / Math.sqrt(drive);
      // combustion rasp grows with load: idle / cruise stay tonal, full throttle gets gritty
      const rough = (c.rough ?? 0.3) * 0.5 * (0.3 + 0.7 * Math.min(1, cur.load * 1.3));
      const sharp = c.sharp ?? 0.45, gS = (1 - sharp) * 2.2, gF = sharp * 2.2;
      const fb = this.fb, pk = this.pipeK, mask = this.mask;
      const kn = c.knock || 0, mech = (c.mech ?? 0.2) * 0.035;
      const knDec = Math.exp(-1 / (sr * 0.0012)), tkDec = Math.exp(-1 / (sr * 0.0006)), crDec = Math.exp(-1 / (sr * 0.004)), guDec = Math.exp(-1 / (sr * 0.03));
      const hissK = c.turboHiss ?? 0.25;
      const turboAmt = c.turbo || 0, tf0 = (c.turboF || [2000, 7500])[0], tf1 = (c.turboF || [2000, 7500])[1];
      const whine = c.whine || 0, whineR = c.whineRatio || 3.6;
      const prop = c.prop;
      const starterOn = cur.starter > 0.5;
      const directG = this.directG;
      const form = this.form, nf = form.length;
      const ia = this.intakeAmt * 0.35;
      // slow modulations are evaluated per block (cheap), not per sample
      const hunt = (c.lope || 0) * 0.025 * Math.max(0, 1 - rpmN * 4);
      this.huntPh = (this.huntPh + 0.9 * n * inv) % 1;
      let rMul = cur.pitch * (1 + hunt * Math.sin(TAU * this.huntPh));
      // soft pitch cap (cars): above ~70 % of fireCap the firing rate is compressed smoothly towards the cap,
      // so a screaming redline still reads as a big engine rather than a buzz
      if (c.fireCap) {
        const fRaw = Math.max(1e-3, rpmAvg * cur.pitch / 60 / stroke * this.N), knee = c.fireCap * 0.7;
        if (fRaw > knee) rMul *= (knee + (c.fireCap - knee) * Math.tanh((fRaw - knee) / (c.fireCap - knee))) / fRaw;
      }
      if (this.limOn) { this.limPh += 15 * n * inv; rMul *= 1 + 0.018 * Math.sin(TAU * this.limPh); }
      const lp0 = Math.pow(Math.max(pv.load, 0), 0.8), lp1 = Math.pow(Math.max(cur.load, 0), 0.8);
      const tp0 = Math.pow(Math.max(pv.thr, 0), 1.5), tp1 = Math.pow(Math.max(cur.thr, 0), 1.5);
      const combK = (0.55 + 0.45 * ign);
      const tickOn = rpmAvg * cur.pitch > 50 ? 1 : 0;
      const turboVib = 1 + 0.004 * Math.sin(this.t * 40);
      const propK = prop ? (prop.amt || 0.6) * Math.pow(rpmN + 0.1, 1.4) * 1.6 : 0;
      // phase-locked low body: firing fundamental + half-order sub (burble), only when it is firing
      const N = this.N, subAmt = N % 2 === 0 ? (c.sub ?? 0.2) : 0;
      const bodyT = (c.body ?? 0) * (0.35 + 0.65 * lp1) * (ign > 0.5 ? 1 : 0.25) * (rpmAvg * cur.pitch > 120 ? 1 : 0);
      const bodyK0 = this.bodyK; this.bodyK = bodyT;
      const nBanks = this.nBanks;
      // state → locals
      let s1a = this.s1[0], s2a = this.s2[0], f1a = this.f1[0], f2a = this.f2[0], pla = this.pipeLp[0];
      let s1b = this.s1[1], s2b = this.s2[1], f1b = this.f1[1], f2b = this.f2[1], plb = this.pipeLp[1];
      const bufA = this.pipe[0], bufB = this.pipe[1], DA = this.D[0], DB = this.D[1], gA = this.bankGain[0], gB = this.bankGain[1];
      const impS = this.impS, impF = this.impF;
      let w = this.w, nEnv = this.nEnv, dc = this.dc;
      const dcK = this.dcK, iKS = 1 / kS, iKF = 1 / kF;
      for (let i = 0; i < n; i++) {
        const fr = i * invN;
        const rpm = pv.rpm + (cur.rpm - pv.rpm) * fr;
        const thr = pv.thr + (cur.thr - pv.thr) * fr;
        const load = pv.load + (cur.load - pv.load) * fr;
        const r = rpm * rMul;
        this.ph += r / 60 / stroke * inv;
        if (this.ph >= 1) { this.ph -= 1; this.next = 0; this.newCycle(rpmN); }
        if (this.next < this.N && this.ph >= this.fireAt[this.next]) {
          const comb = (pump + (1 - pump) * (lp0 + (lp1 - lp0) * fr) * ign) * combK * (r > 30 ? 1 : r / 30);
          this.nEnv = nEnv;
          while (this.next < this.N && this.ph >= this.fireAt[this.next]) { this.fire(this.next, comb, rpmN, thr); this.next++; }
          nEnv = this.nEnv;
        }
        const wn = this.nz();
        const nzx = wn * nEnv * rough;
        if (nBanks === 1) { impS[0] += impS[1]; impF[0] += impF[1]; impS[1] = 0; impF[1] = 0; }
        // bank A
        s1a += kS * (impS[0] * iKS - s1a); s2a += kS * (s1a - s2a);
        f1a += kF * (impF[0] * iKF - f1a); f2a += kF * (f1a - f2a);
        impS[0] = 0; impF[0] = 0;
        let x = s2a * gS + f2a * gF + nzx;
        pla += pk * (bufA[(w - DA) & mask] - pla);
        let y = x + fb * pla;
        bufA[w] = y;
        let ex = y * gA;
        if (nBanks === 2) {
          s1b += kS * (impS[1] * iKS - s1b); s2b += kS * (s1b - s2b);
          f1b += kF * (impF[1] * iKF - f1b); f2b += kF * (f1b - f2b);
          impS[1] = 0; impF[1] = 0;
          x = s2b * gS + f2b * gF + nzx;
          plb += pk * (bufB[(w - DB) & mask] - plb);
          y = x + fb * plb;
          bufB[w] = y;
          ex += y * gB;
        }
        w = (w + 1) & mask;
        nEnv *= nDec;
        // DC block
        dc += dcK * (ex - dc);
        ex -= dc;
        // exhaust resonances + muffler
        let s = this.direct.p(ex) * directG;
        for (let k = 0; k < nf; k++) s += form[k].bq.p(ex) * form[k].g;
        const bk = bodyK0 + (bodyT - bodyK0) * fr;
        if (bk > 0) { const fph = this.ph * N; s += (Math.sin(TAU * fph) + subAmt * Math.sin(Math.PI * fph)) * bk; }
        // grit first, then a 4th-order muffler so the saturation harmonics never become buzz
        s = sat(s * drive) * dNorm;
        // intake roar (pulsed by the firing envelope) and valvetrain ticks: their noise is band-limited by the
        // same low-pass, so no broadband hiss floor rides on top of the engine
        const ienv = (tp0 + (tp1 - tp0) * fr) * (0.25 + rpmN) * ia * (0.6 + 0.4 * Math.min(1, s2a * 3));
        s += this.intake.p(wn) * ienv;
        this.tkEnv *= tkDec;
        if (mech) s += this.tickHp.p(wn * this.tkEnv) * mech * (1 - 0.6 * load) * tickOn;
        s = this.muf2.p(this.muf.p(s));
        // crackle (bright component of pops), band-limited
        if (this.crEnv > 1e-4) { s += this.crackLp.p(this.crackHp.p(wn)) * this.crEnv * 0.3; this.crEnv *= crDec; }
        // underwater gurgle
        if (this.guEnv > 1e-4) { s += this.gurgle.p(wn) * this.guEnv * 0.8; this.guEnv *= guDec; }
        // diesel clatter
        if (kn) { s += this.knockBp.p(wn * this.knEnv) * kn * 0.3; this.knEnv *= knDec; }
        // supercharger / gear whine
        if (whine) {
          this.whinePh += r / 60 * whineR * inv;
          if (this.whinePh > 1e4) this.whinePh -= 1e4;
          const wp = TAU * this.whinePh;
          s += (Math.sin(wp) + 0.3 * Math.sin(2 * wp)) * whine * 0.05 * rpmN * (0.3 + 0.7 * thr);
        }
        // turbo whistle + hiss
        if (turboAmt) {
          const sp = pv.turbo + (cur.turbo - pv.turbo) * fr;
          if (sp > 0.01) {
            this.turboPh += (tf0 + (tf1 - tf0) * sp) * turboVib * inv;
            if (this.turboPh > 1e4) this.turboPh -= 1e4;
            s += Math.sin(TAU * this.turboPh) * turboAmt * 0.013 * sp * sp * (0.3 + 0.7 * thr);
            s += this.hissLp.p(this.hissHp.p(wn)) * turboAmt * 0.012 * hissK * sp * thr;
          }
        }
        // starter motor
        if (starterOn) {
          this.starterPh += (c.starterHz || 180) * (0.85 + 0.15 * Math.sin(TAU * this.ph * 2)) * inv;
          const sp2 = TAU * this.starterPh;
          s += (Math.sin(sp2) * 0.6 + Math.sin(2 * sp2) * 0.3 + Math.sin(3.01 * sp2) * 0.2) * 0.12 + this.starterBp.p(wn) * 0.05;
        }
        // propeller blade pass
        if (prop) {
          this.propPh += r / 60 * (prop.ratio || 1) * (prop.blades || 2) * inv;
          if (this.propPh >= 1) { this.propPh -= 1; this.propImp = 1; }
          const kp = 0.03;
          this.p1 += kp * (this.propImp / kp - this.p1); this.p2 += kp * (this.p1 - this.p2); this.propImp = 0;
          s += this.propLp.p(this.p2) * propK * (0.5 + 0.5 * load);
        }
        out[i] = s * idleComp;
      }
      this.s1[0] = s1a; this.s2[0] = s2a; this.f1[0] = f1a; this.f2[0] = f2a; this.pipeLp[0] = pla;
      this.s1[1] = s1b; this.s2[1] = s2b; this.f1[1] = f1b; this.f2[1] = f2b; this.pipeLp[1] = plb;
      this.w = w; this.nEnv = nEnv; this.dc = dc;
    }

    renderEV(out, n, pv, cur) {
      const c = this.c, inv = 1 / sampleRate;
      const max = c.max || 16000;
      const poles = c.poles || 4, teeth = c.teeth || 23;
      const sp = cur.speed;
      const fc = sp < 3 ? 1350 : sp < 9 ? 2700 : 5400;
      for (let i = 0; i < n; i++) {
        const fr = i / n;
        const rpm = (pv.rpm + (cur.rpm - pv.rpm) * fr) * cur.pitch;
        const load = pv.load + (cur.load - pv.load) * fr;
        const rN = Math.min(1, rpm / max);
        const fm = rpm / 60 * poles;
        const ph = this.evPh;
        ph[0] += fm * inv; ph[1] += rpm / 60 * teeth * inv; ph[2] += (fc + 2 * fm) * inv; ph[3] += Math.max(0, fc - 2 * fm) * inv; ph[4] += (330 + sp * 14) * inv;
        for (let k = 0; k < 5; k++) if (ph[k] > 1e4) ph[k] -= 1e4;
        const a = TAU * ph[0];
        const wn = this.nz();
        let s = (Math.sin(a) + 0.35 * Math.sin(2 * a) + 0.15 * Math.sin(3 * a)) * (c.whine ?? 0.5) * 0.12 * (0.1 + 0.9 * load) * Math.sqrt(rN);
        s += Math.sin(TAU * ph[1]) * (c.gear ?? 0.25) * 0.06 * (0.3 + 0.7 * load) * rN;
        const invA = (c.inverter ?? 0.12) * 0.08 * Math.max(0, load) * Math.pow(1 - rN, 1.5) * cur.ign;
        s += (Math.sin(TAU * ph[2]) + Math.sin(TAU * ph[3])) * invA;
        s += this.humBp.p(wn) * 0.05 * cur.ign;
        s += this.swLp.p(wn) * 0.12 * load * rN;
        if (sp < 7 && cur.ign > 0.5) {
          const av = (c.avas ?? 0.15) * (1 - sp / 7) * (sp > 0.15 ? 1 : 0.4);
          const b = TAU * ph[4];
          s += (Math.sin(b) + 0.5 * Math.sin(1.5 * b) + 0.2 * Math.sin(2.01 * b)) * av * 0.12 * (0.8 + 0.2 * Math.sin(this.t * 5 + fr));
        }
        out[i] = s;
      }
    }

    renderTurbine(out, n, pv, cur) {
      const c = this.c, inv = 1 / sampleRate;
      const fanMax = c.fanMax || 2400, compMax = c.compMax || 8000;
      const N1 = Math.min(1.1, Math.max(0, (pv.rpm + cur.rpm) * 0.5 / (c.max || 10000)));
      if ((this.blockN & 3) === 0) { this.roarBp.set(1, 220 + 800 * N1, 0.55); this.buzzBp.set(1, 900 + 1500 * N1, 1.1); }
      const buzzAmt = (c.buzz ?? 0.5) * Math.max(0, Math.min(1, (N1 - 0.72) / 0.25));
      const ph = this.tPh;
      const abDec = Math.exp(-1 / (sampleRate * 0.006));
      for (let i = 0; i < n; i++) {
        const fr = i / n;
        const nn = Math.min(1.1, Math.max(0, (pv.rpm + (cur.rpm - pv.rpm) * fr) / (c.max || 10000))) * cur.pitch;
        const load = pv.load + (cur.load - pv.load) * fr;
        const aux = pv.aux + (cur.aux - pv.aux) * fr;
        const wn = this.nz();
        ph[0] += nn * fanMax * inv; ph[1] += nn * compMax * inv; ph[2] += nn * fanMax / 22 * inv;
        for (let k = 0; k < 3; k++) if (ph[k] > 1e4) ph[k] -= 1e4;
        const a = TAU * ph[0];
        // fan + compressor tones: the whine dominates at idle, roar takes over with thrust
        let s = (Math.sin(a) + 0.4 * Math.sin(2 * a)) * (c.fan ?? 0.5) * 0.09 * Math.pow(nn, 0.7);
        s += (Math.sin(TAU * ph[1]) + 0.3 * Math.sin(TAU * ph[1] * 1.5)) * (c.comp ?? 0.4) * 0.15 * Math.min(1, nn * 3) * (1.1 - nn * 0.6);
        s += this.exhLp.p(wn) * 0.15 * Math.min(1, nn * 3) * (1 - nn);
        if (buzzAmt > 0) {
          const b = TAU * ph[2];
          let saw = 0;
          for (let h = 1; h <= 10; h++) saw += Math.sin(b * h) / h;
          s += this.buzzBp.p(saw) * buzzAmt * 0.25 * (0.4 + 0.6 * load);
        }
        const roar = (c.roar ?? 1) * Math.pow(nn, 2.4) * (0.35 + 0.65 * load);
        s += this.roarLp.p(this.roarBp.p(wn)) * roar * 0.9;
        if (aux > 0.01) {
          if (this.rnd() < aux * 70 / sampleRate) this.abEnv = 0.5 + this.rnd();
          s += this.abLp.p(wn) * aux * 1.6 + this.crackHp.p(wn) * this.abEnv * aux * 0.4;
          this.abEnv *= abDec;
        }
        out[i] = s;
      }
    }

    renderRotor(out, n, pv, cur) {
      const c = this.c, inv = 1 / sampleRate;
      const max = c.max || 390;
      const blades = c.blades || 4, tailR = c.tailRatio || 6.5, tailB = c.tailBlades || 3;
      const kSl = kOf(0.0025), kSl2 = kOf(0.012), kT = kOf(0.0012);
      const chopDec = Math.exp(-1 / (sampleRate * 0.03));
      if ((this.blockN & 3) === 0) this.slapLp.set(0, 380 - cur.far * 200, 0.7);
      for (let i = 0; i < n; i++) {
        const fr = i / n;
        const rpm = (pv.rpm + (cur.rpm - pv.rpm) * fr) * cur.pitch;
        const load = pv.load + (cur.load - pv.load) * fr;
        const aux = pv.aux + (cur.aux - pv.aux) * fr;
        const r = Math.min(1.1, rpm / max);
        const wn = this.nz();
        this.bladePh += rpm / 60 * blades * inv;
        if (this.bladePh >= 1) {
          this.bladePh -= 1;
          const a = r * r * (0.35 + 0.65 * load) * (1 + aux * 1.5) * (0.85 + 0.3 * this.rnd());
          this.slapImp = a; this.chopEnv = Math.max(this.chopEnv, a);
        }
        this.tailPh += rpm / 60 * tailR * tailB * inv;
        if (this.tailPh >= 1) { this.tailPh -= 1; this.tailImp = r * (0.7 + 0.3 * this.rnd()); }
        // main rotor slap: sharp component + body thump
        this.slap1 += kSl * (this.slapImp / kSl - this.slap1);
        this.slap2 += kSl2 * (this.slapImp / kSl2 - this.slap2);
        this.slapImp = 0;
        let s = this.slapLp.p(this.slap1 * (0.6 + aux) + this.slap2 * (1.2 + cur.far)) * 1.2;
        s += this.chopBp.p(wn) * this.chopEnv * 0.55 * (1 - cur.far * 0.6);
        this.chopEnv *= chopDec;
        this.tail1 += kT * (this.tailImp / kT - this.tail1);
        this.tailImp = 0;
        this.tail2 += 0.5 * (this.tail1 - this.tail2);
        s += this.tailBp.p(this.tail1 - this.tail2) * (c.tail ?? 0.6) * 1.4;
        // turbine whine + gearbox + exhaust
        this.tPh[0] += (c.turbineHz || 4800) * r * inv; this.tPh[1] += 1150 * r * inv;
        if (this.tPh[0] > 1e4) this.tPh[0] -= 1e4;
        if (this.tPh[1] > 1e4) this.tPh[1] -= 1e4;
        s += (Math.sin(TAU * this.tPh[0]) * 0.6 + Math.sin(TAU * this.tPh[0] * 2.03) * 0.2) * 0.035 * r * (1 - cur.far * 0.7);
        s += Math.sin(TAU * this.tPh[1]) * 0.02 * r;
        s += this.exhLp.p(wn) * 0.25 * r * r;
        out[i] = s;
      }
    }

    renderBike(out, n, pv, cur) {
      const inv = 1 / sampleRate;
      const clickDec = Math.exp(-1 / (sampleRate * 0.0006));
      this.tyreBp.set(1, 350 + cur.speed * 35, 0.8);
      for (let i = 0; i < n; i++) {
        const fr = i / n;
        const sp = pv.speed + (cur.speed - pv.speed) * fr;
        const thr = pv.thr + (cur.thr - pv.thr) * fr;
        const wn = this.nz();
        const wheelRev = sp / (TAU * 0.34);
        let s = 0;
        if (thr < 0.08 && sp > 0.3) {
          this.clickPh += wheelRev * 30 * inv;
          if (this.clickPh >= 1) { this.clickPh -= 1; this.clickEnv = (0.5 + 0.5 * this.rnd()) * Math.min(1, sp / 2); }
        }
        if (this.clickEnv > 1e-4) {
          const t = this.t * TAU;
          s += (Math.sin(t * 4200) * 0.6 + Math.sin(t * 6900) * 0.3 + wn * 0.4) * this.clickEnv * 0.25;
          this.clickEnv *= clickDec;
        }
        if (thr > 0.08) {
          this.chainPh += sp * 1.3 * 44 / 60 * 60 * inv;
          s += this.chainBp.p(wn) * (0.5 + 0.5 * Math.sin(TAU * this.chainPh)) * thr * 0.08;
        }
        s += this.tyreBp.p(wn) * Math.min(1, sp / 12) * 0.12;
        out[i] = s;
        this.t += inv;
      }
      this.t -= n * inv;
    }
  }

  registerProcessor('ld-engine', EngineProcessor);
}

let _url = null;
export function engineProcessorUrl() {
  if (!_url) _url = URL.createObjectURL(new Blob([`(${processorMain.toString()})();`], { type: 'application/javascript' }));
  return _url;
}
