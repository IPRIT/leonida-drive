// Road-following bot drivers for the lab and the load test: pure-pursuit steering along the real road graph
// (public/data/roads.json), smooth speed changes, wander inside a radius around a centre.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.resolve(here, '../../public/data');

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class RoadNet {
  constructor(file = path.join(DATA, 'roads.json')) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.nodes = raw.nodes;
    this.edges = raw.edges.map((e, i) => {
      const n = e.p.length / 2, cum = new Float64Array(n);
      for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(e.p[2 * k] - e.p[2 * k - 2], e.p[2 * k + 1] - e.p[2 * k - 1]);
      return { i, a: e.a, b: e.b, kind: e.k, w: e.w, p: e.p, y: e.y, n, cum, len: cum[n - 1] };
    }).filter((e) => e.len > 1 && e.kind !== 'dirt');
    this.adj = new Map();
    for (const e of this.edges) {
      for (const node of [e.a, e.b]) { let l = this.adj.get(node); if (!l) this.adj.set(node, (l = [])); l.push(e); }
    }
  }

  /** Point at arc length s on edge e travelled in direction dir (+1 a→b, -1 b→a), offset to the right lane. */
  point(e, dir, s, out) {
    s = Math.max(0, Math.min(e.len, dir > 0 ? s : e.len - s));
    let k = 0;
    let lo = 0, hi = e.n - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (e.cum[mid] <= s) lo = mid; else hi = mid; }
    k = lo;
    const seg = e.cum[k + 1] - e.cum[k] || 1, t = (s - e.cum[k]) / seg;
    const ax = e.p[2 * k], az = e.p[2 * k + 1], bx = e.p[2 * k + 2], bz = e.p[2 * k + 3];
    let tx = (bx - ax) / seg, tz = (bz - az) / seg;
    if (dir < 0) { tx = -tx; tz = -tz; }
    const lane = Math.min(e.w * 0.22, 3); // right-hand traffic
    out.x = ax + (bx - ax) * t - tz * lane;
    out.z = az + (bz - az) * t + tx * lane;
    out.y = e.y ? e.y[k] + (e.y[k + 1] - e.y[k]) * t : 0;
    return out;
  }

  edgesNear(x, z, r) {
    return this.edges.filter((e) => {
      const mx = e.p[Math.floor(e.n / 2) * 2], mz = e.p[Math.floor(e.n / 2) * 2 + 1];
      return Math.hypot(mx - x, mz - z) < r;
    });
  }
}

/** Terrain height (public/data/height.bin) for on-foot bots and sanity. */
export function loadHeights(dir = DATA) {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
    let buf = fs.readFileSync(path.join(dir, 'height.bin'));
    if (buf[0] === 0x1f) buf = zlib.gunzipSync(buf);
    const h = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1), W = w.gw + 1;
    return (x, z) => {
      const fx = Math.max(0, Math.min(w.gw - 1e-4, (x - w.bounds[0]) / w.hs)), fz = Math.max(0, Math.min(w.gh - 1e-4, (z - w.bounds[1]) / w.hs));
      const ix = fx | 0, iz = fz | 0;
      return h[iz * W + ix] * 0.1;
    };
  } catch { return () => 0; }
}

const _p = { x: 0, y: 0, z: 0 };

export class Driver {
  /** net: RoadNet; o: { cx, cz, radius, seed, speed (m/s), wheelLift } */
  constructor(net, o = {}) {
    this.net = net;
    this.r = rng(o.seed ?? 1);
    this.cx = o.cx ?? 1745; this.cz = o.cz ?? -640; this.radius = o.radius ?? 400;
    this.vmaxBase = o.speed ?? 12 + this.r() * 12;
    this.lift = o.wheelLift ?? 0.35;
    const cand = net.edgesNear(this.cx, this.cz, this.radius);
    const pool = cand.length ? cand : net.edges;
    this.route = [];
    const e = pool[Math.floor(this.r() * pool.length)];
    this.route.push({ e, dir: this.r() < 0.5 ? 1 : -1 });
    this.s = this.r() * e.len * 0.8; // distance along route[0]
    net.point(e, this.route[0].dir, this.s, _p);
    this.x = _p.x; this.z = _p.z; this.y = _p.y + this.lift;
    net.point(e, this.route[0].dir, this.s + 5, _p);
    this.yaw = Math.atan2(-(_p.x - this.x), -(_p.z - this.z));
    this.v = 0; this.vx = 0; this.vz = 0; this.vy = 0; this.yawRate = 0; this.steer = 0;
    this._extend();
  }

  _end(seg) { return seg.dir > 0 ? seg.e.b : seg.e.a; }

  _extend() {
    while (this.route.length < 4) {
      const last = this.route[this.route.length - 1];
      const node = this._end(last);
      const opts = (this.net.adj.get(node) || []).filter((e) => e !== last.e);
      let next;
      if (!opts.length) next = { e: last.e, dir: -last.dir };
      else {
        // prefer edges whose far end stays inside the radius, mostly straight on
        const scored = opts.map((e) => {
          const dir = e.a === node ? 1 : -1, far = dir > 0 ? e.b : e.a, fp = this.net.nodes[far];
          const out = Math.hypot(fp[0] - this.cx, fp[1] - this.cz) > this.radius;
          return { e, dir, w: (out ? 0.05 : 1) * (0.3 + this.r()) };
        });
        scored.sort((a, b) => b.w - a.w);
        next = scored[0];
      }
      this.route.push(next);
    }
  }

  _at(d, out) {
    let s = this.s + d, i = 0;
    while (i < this.route.length - 1 && s > this.route[i].e.len) { s -= this.route[i].e.len; i++; }
    return this.net.point(this.route[i].e, this.route[i].dir, s, out);
  }

  /** Advance dt seconds (pure pursuit + speed control). */
  step(dt) {
    const look = 6 + this.v * 0.5;
    this._at(look, _p);
    const want = Math.atan2(-(_p.x - this.x), -(_p.z - this.z));
    let err = want - this.yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    // curvature ahead → slow down for turns
    const turn = Math.abs(err);
    const kind = this.route[0].e.kind;
    const vmax = (kind === 'highway' ? this.vmaxBase * 1.6 : this.vmaxBase) * (turn > 0.5 ? 0.45 : turn > 0.25 ? 0.7 : 1);
    const a = this.v < vmax ? Math.min(3.5, (vmax - this.v) * 1.5) : Math.max(-6, (vmax - this.v) * 2);
    this.v = Math.max(0, this.v + a * dt);
    const maxYr = 0.25 + Math.min(1.2, 9 / Math.max(this.v, 3));
    const yr = Math.max(-maxYr, Math.min(maxYr, err * 2.2));
    this.yawRate += (yr - this.yawRate) * Math.min(1, dt * 6);
    this.yaw = Math.atan2(Math.sin(this.yaw + this.yawRate * dt), Math.cos(this.yaw + this.yawRate * dt));
    this.steer = Math.max(-0.5, Math.min(0.5, this.yawRate * 2.6 / Math.max(this.v, 2)));
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    this.vx = fx * this.v; this.vz = fz * this.v;
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.s += this.v * dt * Math.cos(Math.min(1.2, Math.abs(err)) * 0.5);
    while (this.s > this.route[0].e.len) { this.s -= this.route[0].e.len; this.route.shift(); this._extend(); }
    this._at(0, _p);
    const ny = _p.y + this.lift;
    this.vy = (ny - this.y) / Math.max(dt, 1e-3);
    this.y = ny;
  }
}
