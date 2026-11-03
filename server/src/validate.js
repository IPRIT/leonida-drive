// Server-side movement validation. The client simulates its own physics (responsive driving), so every state it
// sends is a claim: positions must be reachable from the last accepted one at the vehicle class's speed, vertical
// motion must be plausible for the class, and there are no unexplained jumps. Teleports do not exist online; the
// only discontinuities are server-granted (join, respawn and approved vehicle placement).
import { WORLD, VCLASS, ANIM, F_ANIM, F_ANIM_SHIFT, F_AIRBORNE } from '../../src/net/shared/constants.js';
import { CLASS_LIMITS } from './vehicles.js';

export const V_OK = 0, V_JUMP = 1, V_BOUNDS = 2, V_SPEED = 3, V_TELEPORT = 4, V_FLY = 5, V_ALTITUDE = 6;
export const V_NAMES = ['ok', 'jump', 'bounds', 'speed', 'teleport', 'fly', 'altitude'];

const HIST = 192; // trajectory samples (>= 100 ms apart): ~19 s of history for claim plausibility
const HIST_DT = 100;
const H = 7; // packed fields: x y z speed slip airborne alt
const CRUMBS = 96; // one breadcrumb per 2 s: 3 minutes of path for respawn checks
const RAGDOLL_MAX_MS = 5000;
const TRANSITION_MS = 6000; // speed limit of the previous class decays over this time (bail out of a fast car)
const ALT_TRANSITION_MS = 120000; // after leaving an aircraft its altitude stays plausible this long

export class Movement {
  constructor(world) {
    this.world = world;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
    this.t = 0; // server time of the last accepted state
    this.placed = false;
    this.budget = 0;
    this.vclass = VCLASS.FOOT;
    this.vmax = CLASS_LIMITS[VCLASS.FOOT].h;
    this.prevVmax = 0; this.prevAlt = 0; this.changeT = 0; this.airExitT = -1e12;
    this.ragdollSince = 0;
    this.grace = null; // { kind, until, test(x, z) }
    this.jumpT = -1e12; // time of the last server-granted jump (join / respawn)
    // history (packed: ~6.9 KB per player with the breadcrumbs)
    this.ht = new Float64Array(HIST);
    this.h = new Float32Array(HIST * H);
    this.hn = 0;
    this.c = new Float32Array(CRUMBS * 2); this.ct = new Float64Array(CRUMBS); this.cn = 0;
    this.lastCrumb = -1e12;
  }

  /** Authoritative placement (join restore, correction, respawn). */
  place(x, y, z, yaw, now) {
    this.x = x; this.y = y; this.z = z; this.yaw = yaw; this.t = now; this.placed = true;
    this.budget = 0;
    this._crumb(now, true);
  }

  /** Grant a one-off jump: test(x, z) decides whether the destination is acceptable. */
  allowJump(kind, until, test) { this.grace = { kind, until, test }; }

  setClass(vclass, vmax, now) {
    if (vclass === this.vclass && vmax === this.vmax) return;
    this.prevVmax = Math.max(this.vmax, this._decayedPrev(now));
    // leaving an aircraft: its altitude stays plausible for a while (falling from the sky after bailing out)
    const wasAir = this.vclass === VCLASS.HELI || this.vclass === VCLASS.PLANE;
    if (wasAir) { this.prevAlt = CLASS_LIMITS[this.vclass].alt; this.airExitT = now; }
    this.changeT = now;
    this.vclass = vclass;
    this.vmax = vmax;
  }

  _decayedPrev(now) {
    const k = 1 - (now - this.changeT) / TRANSITION_MS;
    return k > 0 ? this.prevVmax * k : 0;
  }

  /**
   * Validate a decoded STATE `s` received at server time `now`. Returns V_OK / V_JUMP (accepted) or a violation
   * code (rejected: the caller sends a correction to the last accepted position).
   */
  check(s, now) {
    if (!(s.x > WORLD.x0 + 5 && s.x < WORLD.x1 - 5 && s.z > WORLD.z0 + 5 && s.z < WORLD.z1 - 5 && s.y > WORLD.yMin && s.y < WORLD.yMax)) return V_BOUNDS;
    const lim = CLASS_LIMITS[this.vclass] || CLASS_LIMITS[VCLASS.FOOT];
    const anim = (s.flags & F_ANIM) >> F_ANIM_SHIFT;
    let vmax = Math.max(this.vmax, this._decayedPrev(now));
    if (this.vclass === VCLASS.FOOT && anim === ANIM.RAGDOLL) {
      if (!this.ragdollSince) this.ragdollSince = now;
      if (now - this.ragdollSince < RAGDOLL_MAX_MS) vmax = Math.max(vmax, 50);
    } else this.ragdollSince = 0;
    // the reported velocity itself must be plausible
    const hs = Math.hypot(s.vx, s.vz);
    if (hs > vmax * 1.3 + 5) return V_SPEED;
    if (!this.placed) { this.place(s.x, s.y, s.z, s.yaw, now); return V_JUMP; }
    const dt = Math.max(0, (now - this.t) / 1000);
    // The newest upload may replace seconds of unsent states under backpressure.
    // Credit the actual elapsed sample time for this move; cap only the unused
    // carry after acceptance. Rejected samples never refill the budget twice.
    const available = this.budget + vmax * 1.15 * dt;
    const dh = Math.hypot(s.x - this.x, s.z - this.z);
    if (dh > available + 2) {
      const g = this.grace;
      if (g && now <= g.until && g.test(s.x, s.z, s, now)) {
        this.grace = null;
        this.jumpT = now;
        this._accept(s, now, true);
        return V_JUMP;
      }
      return V_TELEPORT;
    }
    const air = this.vclass === VCLASS.HELI || this.vclass === VCLASS.PLANE;
    if (!air) {
      // no climbing faster than the class allows (ramps and bumps get slack)
      const dy = s.y - this.y;
      if (dy > lim.up * dt + 4) return V_FLY;
      const ground = Math.max(0, this.world.heightAt(s.x, s.z));
      const afterAir = now - this.airExitT < ALT_TRANSITION_MS;
      const altLimit = afterAir ? Math.max(lim.alt, this.prevAlt) : lim.alt;
      if (s.y - ground > altLimit + 60) return V_ALTITUDE;
      // sustained climb (fly hack): height gained over the last 6 s
      if (!afterAir && dt < 6 && this.hn > 8 && s.y - this._minY(now - 6000) > lim.climb) return V_FLY;
    }
    this.budget = Math.min(Math.max(0, available - dh), vmax * 1.5 + 30);
    this._accept(s, now, false);
    return V_OK;
  }

  _accept(s, now, jump) {
    this.x = s.x; this.y = s.y; this.z = s.z; this.yaw = s.yaw; this.t = now;
    if (jump) this.budget = 0;
    const last = this.hn ? this.ht[(this.hn - 1) % HIST] : -1e12;
    if (now - last >= HIST_DT || jump) {
      const i = this.hn++ % HIST, k = i * H, h = this.h;
      const hs = Math.hypot(s.vx, s.vz);
      // slip: angle between the heading and the direction of travel (drift)
      let slip = 0;
      if (hs > 2) {
        const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
        slip = Math.acos(Math.max(-1, Math.min(1, (fx * s.vx + fz * s.vz) / hs)));
      }
      const ground = Math.max(0, this.world.heightAt(s.x, s.z));
      this.ht[i] = now;
      h[k] = s.x; h[k + 1] = s.y; h[k + 2] = s.z; h[k + 3] = hs; h[k + 4] = slip;
      h[k + 5] = s.flags & F_AIRBORNE ? 1 : 0; // the terrain says nothing on bridges and roofs: the client flag, checked by y motion
      h[k + 6] = s.y - ground;
    }
    this._crumb(now, jump);
  }

  _crumb(now, force) {
    if (!force && now - this.lastCrumb < 2000) return;
    this.lastCrumb = now;
    const i = this.cn++ % CRUMBS;
    this.c[i * 2] = this.x; this.c[i * 2 + 1] = this.z; this.ct[i] = now;
  }

  _minY(fromT) {
    let m = this.y;
    for (let k = 0; k < Math.min(this.hn, HIST); k++) {
      const i = (this.hn - 1 - k) % HIST;
      if (this.ht[i] < fromT) break;
      if (this.h[i * H + 1] < m) m = this.h[i * H + 1];
    }
    return m;
  }

  /** Visit history samples with t in [t0, t1] (newest first): fn(t, x, y, z, speed, slip, airborne, alt). */
  forEach(t0, t1, fn) {
    const h = this.h;
    for (let n = 0; n < Math.min(this.hn, HIST); n++) {
      const i = (this.hn - 1 - n) % HIST;
      const t = this.ht[i];
      if (t < t0) break;
      const k = i * H;
      if (t <= t1) fn(t, h[k], h[k + 1], h[k + 2], h[k + 3], h[k + 4], h[k + 5], h[k + 6]);
    }
  }

  /** Was the player within `r` metres of (x, z) at some point in [t0, now]? */
  wasNear(x, z, r, t0) {
    let hit = Math.hypot(this.x - x, this.z - z) <= r;
    if (!hit) this.forEach(t0, Infinity, (t, hx, hy, hz) => { if (!hit && Math.hypot(hx - x, hz - z) <= r) hit = true; });
    return hit;
  }

  /** Distance travelled (horizontal) between t0 and now, from the breadcrumb trail (2 s resolution). */
  pathLength(t0, now) {
    let d = 0, px = this.x, pz = this.z;
    for (let k = 0; k < Math.min(this.cn, CRUMBS); k++) {
      const i = (this.cn - 1 - k) % CRUMBS;
      if (this.ct[i] < t0) break;
      d += Math.hypot(this.c[i * 2] - px, this.c[i * 2 + 1] - pz);
      px = this.c[i * 2]; pz = this.c[i * 2 + 1];
    }
    return d;
  }

  /** Within `r` of the breadcrumb trail of the last `ms` milliseconds? */
  nearTrail(x, z, r, now, ms) {
    for (let k = 0; k < Math.min(this.cn, CRUMBS); k++) {
      const i = (this.cn - 1 - k) % CRUMBS;
      if (now - this.ct[i] > ms) break;
      if (Math.hypot(this.c[i * 2] - x, this.c[i * 2 + 1] - z) <= r) return true;
    }
    return false;
  }
}
