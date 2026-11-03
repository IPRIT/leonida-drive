import { BANK_NAMES, renderItem } from './generators.js';
import { rng, pinkGen, brownGen, makeLoop } from '../core/dsp.js';

// generation order: things needed immediately first
const PRIORITY = [
  'ui_click', 'ui_hover', 'ui_open', 'ui_close', 'ui_notify', 'door_open', 'door_close', 'seatbelt', 'metal', 'concrete',
  'plastic', 'wood', 'body', 'glass', 'bov', 'gear_clunk', 'susp_thump', 'gravel_loop', 'grass_loop', 'sand_loop', 'wet_loop',
  'scrape_loop', 'brake_squeak', 'step_hard', 'step_grass', 'step_sand', 'step_gravel', 'step_wood', 'step_metal', 'step_water',
  'money', 'splash', 'crash', 'lamp_break', 'radio_static', 'city_hum', 'rain_light', 'rain_roof', 'bird', 'seagull',
  'explosion', 'fire_whoosh', 'fire_loop', 'waves', 'crickets', 'insects', 'frog', 'rain_heavy', 'tree_crack', 'thunder_near',
  'thunder_far', 'explosion_far', 'collapse', 'wasted', 'respawn', 'timeskip', 'air_brake', 'bicycle_bell', 'underwater',
];

// Procedural sample bank. Items are synthesised in Web Workers (main thread stays free) and converted into
// AudioBuffers. get(name) returns a random variant (never the same one twice in a row) or null if not ready yet.
export class SoundBank {
  constructor(ctx, { seed = 1 } = {}) {
    this.ctx = ctx;
    this.seed = seed;
    this.items = new Map();
    this.waiters = new Map();
    this.last = new Map();
    this.errors = [];
    this.t0 = performance.now();
    this.makeNoise();
    this.order = [...PRIORITY.filter((n) => BANK_NAMES.includes(n)), ...BANK_NAMES.filter((n) => !PRIORITY.includes(n))];
    this.start();
  }

  // shared looping noise beds (generated synchronously, small)
  makeNoise() {
    const sr = this.ctx.sampleRate, r = rng(this.seed * 31 + 7);
    const mk = (chs, sec, gen) => {
      const len = Math.round(sec * sr);
      const b = this.ctx.createBuffer(chs, len, sr);
      for (let c = 0; c < chs; c++) {
        const g = gen();
        const d = makeLoop(len, Math.round(0.05 * sr), (buf) => { for (let i = 0; i < buf.length; i++) buf[i] = g(); }, sr);
        b.copyToChannel(d, c);
      }
      return b;
    };
    this.noise = {
      white: mk(1, 2, () => () => (r() * 2 - 1) * 0.7),
      pink: mk(2, 3, () => { const p = pinkGen(r); return () => p() * 1.6; }),
      brown: mk(2, 3, () => { const b = brownGen(r); return () => b(); }),
    };
  }

  start() {
    const sr = this.ctx.sampleRate;
    const nWorkers = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    const lists = Array.from({ length: nWorkers }, () => []);
    this.order.forEach((n, i) => lists[i % nWorkers].push(n));
    this.workers = [];
    try {
      for (const names of lists) {
        const w = new Worker(new URL('./bank.worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this.onMessage(e.data, w);
        w.onerror = (e) => { this.errors.push(String(e.message || e)); this.fallback(names); };
        w.postMessage({ sr, names, seed: this.seed });
        this.workers.push(w);
      }
    } catch (e) {
      this.errors.push(String(e));
      this.fallback(this.order);
    }
  }

  // main-thread fallback: one item per macrotask
  fallback(names) {
    const sr = this.ctx.sampleRate;
    const todo = names.filter((n) => !this.items.has(n));
    const step = () => {
      const n = todo.shift();
      if (!n) return;
      try { this.onMessage({ name: n, vars: renderItem(n, sr, this.seed) }); } catch (e) { this.errors.push(String(e)); }
      setTimeout(step, 4);
    };
    setTimeout(step, 0);
  }

  onMessage(d, worker) {
    if (d.done) { worker?.terminate(); return; }
    if (d.error) { this.errors.push(`${d.name}: ${d.error}`); return; }
    if (this.items.has(d.name)) return;
    const sr = this.ctx.sampleRate;
    const bufs = d.vars.map((chs) => {
      const b = this.ctx.createBuffer(chs.length, chs[0].length, sr);
      chs.forEach((c, i) => b.copyToChannel(c, i));
      return b;
    });
    this.items.set(d.name, bufs);
    if (this.items.size === this.order.length) this.readyMs = performance.now() - this.t0;
    const w = this.waiters.get(d.name);
    if (w) { this.waiters.delete(d.name); for (const fn of w) fn(bufs); }
  }

  has(name) { return this.items.has(name); }
  get progress() { return this.items.size / this.order.length; }

  get(name, variant = -1) {
    const list = this.items.get(name);
    if (!list) return null;
    if (variant >= 0) return list[variant % list.length];
    if (list.length === 1) return list[0];
    let i = Math.floor(Math.random() * list.length);
    if (i === this.last.get(name)) i = (i + 1) % list.length;
    this.last.set(name, i);
    return list[i];
  }

  whenReady(name) {
    if (this.items.has(name)) return Promise.resolve(this.items.get(name));
    return new Promise((res) => {
      let w = this.waiters.get(name);
      if (!w) this.waiters.set(name, (w = []));
      w.push(res);
    });
  }

  dispose() { for (const w of this.workers || []) w.terminate(); }
}
