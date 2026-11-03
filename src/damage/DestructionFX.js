import * as THREE from 'three';
import { GROUPS, groups } from '../vehicle/groups.js';

// Destruction-specific effects on top of the shared FX pools (no new materials, no new draw calls):
// shattering windows, rolling dust clouds that follow the streets, hydrant water jets, pole sparks.

const rnd = Math.random;
const P = {};
function resetP() { for (const k in P) delete P[k]; return P; }
const _c = new THREE.Color();
const GLASS = [0xd6eef7, 0xb4dcec, 0xf4fbff, 0x9fc7d8];

/** Window pane shattering at p (pane centre), outward normal n {x,z}, pane w x h metres. */
export function glassBurst(fx, p, n, w, h, { k = 1, inward = 0.35, budget = 18 } = {}) {
  if (!fx?.chunks) return 0;
  const lod = fx._lodAt(p);
  if (lod <= 0) return 0;
  const cnt = Math.round(THREE.MathUtils.clamp(w * h * 0.9, 4, budget) * Math.min(1.4, k) * lod);
  const tx = -n.z, tz = n.x;
  const floor = fx._floorFast({ x: p.x + n.x * 1.5, y: p.y, z: p.z + n.z * 1.5 });
  for (let i = 0; i < cnt; i++) {
    _c.setHex(GLASS[(rnd() * GLASS.length) | 0]);
    const u = (rnd() - 0.5) * w * 0.85, v = (rnd() - 0.5) * h * 0.7;
    const inw = rnd() < inward;
    const s = (inw ? -1 : 1) * (0.4 + rnd() * 2.6 * Math.min(1.6, k));
    fx.chunks.emit({
      x: p.x + tx * u + n.x * 0.06, y: p.y + v, z: p.z + tz * u + n.z * 0.06,
      vx: n.x * s + tx * (rnd() - 0.5) * 1.6, vy: rnd() * 1.4 - 0.2, vz: n.z * s + tz * (rnd() - 0.5) * 1.6,
      size: 0.07 + rnd() * 0.17 * Math.min(1.4, k), sx: 1, sy: 0.06, sz: 0.6 + rnd() * 0.7,
      r: _c.r * 1.35, g: _c.g * 1.35, b: _c.b * 1.35, life: 5 + rnd() * 6, drag: 0.22, floor, spin: 6 + rnd() * 16,
    });
  }
  // glints
  const ng = Math.max(1, Math.round(cnt / 4));
  for (let i = 0; i < ng; i++) {
    const q = resetP();
    q.x = p.x + tx * (rnd() - 0.5) * w * 0.6; q.y = p.y + (rnd() - 0.5) * h * 0.5; q.z = p.z + tz * (rnd() - 0.5) * w * 0.6;
    q.vx = n.x * (1 + rnd() * 2); q.vy = rnd() * 1.5; q.vz = n.z * (1 + rnd() * 2);
    q.life = 0.2 + rnd() * 0.3; q.size0 = 0.1; q.size1 = 0.02; q.r = q.g = q.b = 2.6; q.alpha = 1; q.grav = 9.81; q.fadeIn = 0;
    fx.sparkSys.emit(q);
  }
  return cnt;
}

/**
 * Collapse dust: a column over the footprint plus a ground-hugging cloud that rolls out along the open directions
 * (rays against buildings decide how far it travels each way, so it pours down streets instead of through walls).
 * Emission is spread over `dur` seconds.
 */
export class DustCloud {
  constructor(game, pos, { size = 10, power = 1, exclude = -1, dur = 1.6, ground = null, column = 1 } = {}) {
    this.game = game;
    this.fx = game.fx;
    this.pos = { x: pos.x, y: pos.y, z: pos.z };
    this.size = size;
    this.power = power;
    this.dur = dur;
    this.t = 0;
    this.acc = 0;
    this.column = column;
    this.ground = ground ?? game.fx?.decals?.groundY?.(pos.x, pos.z, pos.y + 2) ?? pos.y;
    const lod = this.fx?._lodAt({ x: pos.x, y: this.ground + 2, z: pos.z }) ?? 0;
    this.total = Math.round((28 + size * 3.2) * Math.sqrt(power) * lod);
    this.alive = this.total > 0;
    this.exclude = exclude;
    this.dirs = null; // probed on the first update (keeps the collapse frame light)
  }

  _probe() {
    const { exclude, size } = this, pos = this.pos, game = this.game;
    // free run per direction
    const N = 16;
    this.dirs = [];
    const { world, RAPIER } = game;
    const ray = world && RAPIER ? new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }) : null;
    const mask = groups(0xffff, GROUPS.STATIC);
    const r0 = size * 0.5;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + rnd() * 0.2;
      const dx = Math.cos(a), dz = Math.sin(a);
      let free = 70;
      if (ray) {
        ray.origin = { x: pos.x + dx * r0, y: this.ground + 1.6, z: pos.z + dz * r0 };
        ray.dir = { x: dx, y: 0, z: dz };
        try {
          const hit = world.castRay(ray, 70, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, mask, undefined, undefined,
            (c) => c.userData?.building !== exclude);
          if (hit) free = Math.max(2, hit.timeOfImpact);
        } catch { /* keep default */ }
      }
      this.dirs.push({ dx, dz, free, w: 0.25 + Math.min(1, free / 30) });
    }
    this.wsum = this.dirs.reduce((s, d) => s + d.w, 0);
  }

  _dir() {
    let x = rnd() * this.wsum;
    for (const d of this.dirs) { x -= d.w; if (x <= 0) return d; }
    return this.dirs[0];
  }

  update(dt) {
    if (!this.alive) return false;
    if (!this.dirs) { this._probe(); return true; }
    this.t += dt;
    const fx = this.fx;
    const k = Math.min(1, this.t / this.dur);
    const want = Math.round(this.total * (1 - (1 - k) * (1 - k)));
    let n = Math.min(24, want - this.acc);
    this.acc += Math.max(0, n);
    const sp = Math.sqrt(this.power);
    const g = this.ground;
    for (; n > 0; n--) {
      const p = resetP();
      const shade = 0.88 + rnd() * 0.2;
      p.r = 0.6 * shade; p.g = 0.58 * shade; p.b = 0.54 * shade; p.r1 = 0.71; p.g1 = 0.69; p.b1 = 0.65;
      p.fadeIn = 0.3; p.spin = (rnd() - 0.5) * 0.5; p.floor = g + 0.4; p.wind = 0.22; p.heat = 0;
      if (rnd() < 0.24 * this.column) {
        // rising column over the footprint
        const a = rnd() * 6.283, r = rnd() * this.size * 0.45;
        p.x = this.pos.x + Math.cos(a) * r; p.y = g + 1 + rnd() * this.size * 0.3; p.z = this.pos.z + Math.sin(a) * r;
        p.vx = (rnd() - 0.5) * 2; p.vy = (2.5 + rnd() * 6) * sp; p.vz = (rnd() - 0.5) * 2;
        p.life = 7 + rnd() * 6; p.size0 = 2.2 * sp; p.size1 = (6.5 + rnd() * 6) * sp; p.alpha = 0.42;
        p.drag = 1.1; p.grav = -0.12;
      } else {
        // ground-hugging cloud rolling out along open directions
        const d = this._dir();
        const jit = (rnd() - 0.5) * 0.5;
        const dx = d.dx * Math.cos(jit) - d.dz * Math.sin(jit), dz = d.dx * Math.sin(jit) + d.dz * Math.cos(jit);
        const r = this.size * (0.3 + rnd() * 0.4);
        const v = Math.min(26, (0.9 * Math.min(d.free, 55) + 3) * (0.45 + rnd() * 0.65)) * Math.min(1.3, sp);
        p.x = this.pos.x + dx * r; p.y = g + 0.6 + rnd() * 2.2; p.z = this.pos.z + dz * r;
        p.vx = dx * v; p.vy = 0.2 + rnd() * 0.9; p.vz = dz * v;
        p.life = 7 + rnd() * 6; p.size0 = (1.6 + rnd() * 1.2) * sp; p.size1 = (5.5 + rnd() * 5.5) * sp; p.alpha = 0.42;
        p.drag = 0.9; p.grav = -0.06;
      }
      fx.puffs.emit(p);
    }
    if (k >= 1) this.alive = false;
    return this.alive;
  }
}

/** Broken hydrant: a fluctuating water column with spray falling back + mist; fades out at the end. */
export class WaterJet {
  constructor(game, pos, { life = 24, height = 11 } = {}) {
    this.game = game;
    this.fx = game.fx;
    this.pos = { x: pos.x, y: pos.y, z: pos.z };
    this.life = life;
    this.height = height;
    this.t = 0;
    this.acc = 0;
    this.macc = 0;
    this.alive = true;
    this.ground = game.fx?._floorFast?.({ x: pos.x, y: pos.y + 1, z: pos.z }) ?? pos.y;
  }

  update(dt) {
    if (!this.alive) return false;
    this.t += dt;
    if (this.t >= this.life) { this.alive = false; return false; }
    const fx = this.fx;
    const lod = fx._lodAt(this.pos);
    if (lod <= 0) return true;
    const fade = Math.min(1, (this.life - this.t) / 5) * Math.min(1, this.t / 0.25);
    const H = this.height * (0.75 + 0.25 * Math.sin(this.t * 5.3) * Math.sin(this.t * 1.7)) * (0.35 + 0.65 * fade);
    const v0 = Math.sqrt(2 * 9.81 * Math.max(0.5, H));
    const wind = this.game.uniforms?.uWind?.value;
    this.acc += 70 * lod * dt;
    let n = Math.min(14, this.acc | 0);
    this.acc -= n;
    for (; n > 0; n--) {
      const p = resetP();
      p.x = this.pos.x + (rnd() - 0.5) * 0.12; p.y = this.pos.y + 0.55; p.z = this.pos.z + (rnd() - 0.5) * 0.12;
      const s = v0 * (0.82 + rnd() * 0.22);
      p.vx = (rnd() - 0.5) * 1.1 + (wind ? wind.x * 0.15 : 0); p.vy = s; p.vz = (rnd() - 0.5) * 1.1 + (wind ? wind.z * 0.15 : 0);
      p.life = (2 * s) / 9.81 + 0.4; p.size0 = 0.14; p.size1 = 0.5 + rnd() * 0.35;
      p.r = 0.74; p.g = 0.83; p.b = 0.92; p.r1 = 0.86; p.g1 = 0.91; p.b1 = 0.96;
      p.alpha = 0.42 * (0.5 + 0.5 * fade); p.drag = 0.18; p.grav = 9.81; p.fadeIn = 0.02; p.floor = this.ground + 0.05; p.wind = 0.1;
      fx.puffs.emit(p);
    }
    // sun glints on the droplets: stretched additive streaks along the jet and falling back (dim at night)
    const day = 1 - 0.85 * (this.game.uniforms?.uNight?.value ?? 0);
    this.dacc = (this.dacc || 0) + 70 * lod * dt;
    let nd = Math.min(16, this.dacc | 0);
    this.dacc -= nd;
    for (; nd > 0; nd--) {
      const p = resetP();
      const s = v0 * (0.75 + rnd() * 0.3);
      p.x = this.pos.x + (rnd() - 0.5) * 0.15; p.y = this.pos.y + 0.6 + rnd() * H * 0.3; p.z = this.pos.z + (rnd() - 0.5) * 0.15;
      p.vx = (rnd() - 0.5) * 2.2; p.vy = s * (1 - (p.y - this.pos.y) / (H + 1) * 0.6); p.vz = (rnd() - 0.5) * 2.2;
      p.life = (2 * p.vy) / 9.81 + 0.5; p.size0 = 0.1; p.size1 = 0.07;
      const w = (0.55 + rnd() * 0.4) * day * fade;
      p.r = 0.62 * w; p.g = 0.74 * w; p.b = 0.86 * w; p.alpha = 1; p.drag = 0.12; p.grav = 9.81; p.fadeIn = 0.02; p.floor = this.ground + 0.03;
      fx.sparkSys.emit(p);
    }
    // mist at the top and splash at the foot
    this.macc += 9 * lod * dt;
    let m = this.macc | 0;
    this.macc -= m;
    for (; m > 0; m--) {
      const top = rnd() < 0.5;
      const p = resetP();
      const a = rnd() * 6.283, r = top ? rnd() * 0.8 : 0.4 + rnd() * 1.4;
      p.x = this.pos.x + Math.cos(a) * r; p.y = top ? this.pos.y + H * 0.9 : this.ground + 0.2; p.z = this.pos.z + Math.sin(a) * r;
      p.vx = Math.cos(a) * (0.5 + rnd()); p.vy = top ? -0.5 : 0.4 + rnd() * 0.6; p.vz = Math.sin(a) * (0.5 + rnd());
      p.life = 1.2 + rnd(); p.size0 = 0.6; p.size1 = 2.2 + rnd() * 1.4;
      p.r = 0.86; p.g = 0.9; p.b = 0.95; p.alpha = 0.22 * fade; p.drag = 0.8; p.grav = top ? 1.5 : -0.2; p.fadeIn = 0.1; p.wind = 0.4;
      fx.puffs.emit(p);
    }
    return true;
  }
}

/** Snapped pole: sheared-metal sparks at the base and a short electrical arc flash. */
export function poleSnap(fx, base, dir, { arc = true } = {}) {
  if (!fx) return;
  fx.sparks({ x: base.x, y: base.y + 0.35, z: base.z }, { x: dir.x, y: 0.5, z: dir.z }, 22, { speed: 7, spread: 0.6, life: 0.7 });
  fx.bits({ x: base.x, y: base.y + 0.3, z: base.z }, { material: 'metal', count: 6, speed: 3, dir: { x: dir.x, y: 0.3, z: dir.z }, size: 0.07 });
  if (arc) {
    fx.sparks({ x: base.x, y: base.y + 0.5, z: base.z }, { x: 0, y: 1, z: 0 }, 14, { speed: 4, spread: 1, color: [2.4, 3.2, 5], life: 0.35, size: 0.04 });
    fx.flash({ x: base.x, y: base.y + 0.6, z: base.z }, { color: 0x9fc4ff, intensity: 90, range: 9, duration: 0.18 });
  }
}

/** Pole head hitting the ground: lamp glass + sparks. */
export function poleLand(fx, head, dir, glass = true) {
  if (!fx) return;
  fx.sparks({ x: head.x, y: head.y + 0.1, z: head.z }, { x: dir.x, y: 0.6, z: dir.z }, 18, { speed: 6, spread: 0.8, life: 0.6 });
  if (glass) fx.glass({ x: head.x, y: head.y + 0.2, z: head.z }, { x: dir.x * 0.4, y: 0.3, z: dir.z * 0.4 }, 14);
  fx.dust({ x: head.x, y: head.y, z: head.z }, 0.8, { color: 'dust', count: 4 });
}
