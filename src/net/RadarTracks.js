// Far players for the minimap / full map (outside the interest rings): the server sends a radar summary of the 3 km
// window around us every 2 s (position, heading, speed along the heading, id). Each id becomes a track that is dead-reckoned
// along its velocity every frame. New data never moves the blip: the difference (position and velocity) at the
// current time goes into an offset that decays as a critically damped spring, and the heading eases toward its new
// value. Players that are also in our interest set are anchored to their interpolated 3D pose every frame; switching
// between the two (leaving or entering the rings) blends the same way, so nothing ever jumps.
// Pure JS (no DOM / three.js): reused objects, no allocations per frame in steady state.

const MAX_EXTRAP_S = 4.5; // dead reckoning past the last data (summaries come every 2 s)
const KEEP_MS = 5000; // a moving track without summaries for this long fades out (2 missed summaries)
const KEEP_STILL_MS = 20000; // standing players are only repeated every 8 s
const SNAP_M = 250; // corrections bigger than this (respawn, teleport) are not blended
const OMEGA = 3.2; // offset spring (critically damped, settles in ~1.5 s)
const HEADING_K = 5; // heading easing rate (1/s)
const FADE_S = 0.4;
const JUMP_M = 3; // an anchored pose moving this much more than its velocity explains is blended, not followed

const MAX_TURN = 1.2; // rad/s cap for the estimated turn rate
// base motion along a circular arc: position offset and velocity after d seconds at turn rate w (v rotates by w·d)
const _m = { dx: 0, dz: 0, vx: 0, vz: 0 };
function arc(vx, vz, w, d) {
  const p = w * d;
  if (Math.abs(p) < 1e-4) { _m.dx = vx * d; _m.dz = vz * d; _m.vx = vx; _m.vz = vz; return _m; }
  const s = Math.sin(p), c1 = 1 - Math.cos(p), c = Math.cos(p);
  _m.dx = (vx * s - vz * c1) / w; _m.dz = (vx * c1 + vz * s) / w;
  _m.vx = vx * c - vz * s; _m.vz = vx * s + vz * c;
  return _m;
}
const wrap = (a) => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; else if (a < -Math.PI) a += Math.PI * 2; return a; };

export class RadarTracks {
  constructor() {
    this.byId = new Map();
    this.list = [];
    this.pool = [];
    this.ts = NaN; // server time of the last update(): corrections are taken as of the last drawn frame
  }

  _track(id) {
    let t = this.byId.get(id);
    if (t) return t;
    t = this.pool.pop() || {
      id: 0, bx: 0, bz: 0, vx: 0, vz: 0, w: 0, tb: 0, ox: 0, oz: 0, ovx: 0, ovz: 0, yaw: 0, yawT: 0, x: 0, z: 0, color: 0, vclass: 0,
      seen: 0, alpha: 0, gone: false, anchored: false, wasAnchored: false, fresh: true, blip: null,
    };
    t.id = id; t.w = 0; t.ox = t.oz = t.ovx = t.ovz = 0; t.alpha = 0; t.gone = false; t.anchored = t.wasAnchored = false; t.fresh = true;
    this.byId.set(id, t);
    this.list.push(t);
    return t;
  }

  // move the base to (x, z, vx, vz) sampled at tSample, keeping the drawn position and velocity continuous. The
  // difference is taken at the last drawn frame (the next update() then advances everything by its dt).
  _rebase(t, x, z, vx, vz, tSample, tNow, w = 0) {
    if (Number.isFinite(this.ts)) tNow = this.ts;
    if (t.fresh) {
      t.ox = t.oz = t.ovx = t.ovz = 0;
    } else {
      const raw = Math.max(0, (tNow - t.tb) / 1000), d = Math.min(MAX_EXTRAP_S, raw), live = raw < MAX_EXTRAP_S ? 1 : 0;
      let m = arc(t.vx, t.vz, t.w, d);
      const px = t.bx + m.dx + t.ox, pz = t.bz + m.dz + t.oz, pvx = m.vx * live, pvz = m.vz * live; // drawn now
      const d2 = Math.min(MAX_EXTRAP_S, Math.max(-1, (tNow - tSample) / 1000));
      m = arc(vx, vz, w, d2);
      const ex = px - (x + m.dx), ez = pz - (z + m.dz); // the new data, extrapolated to now
      if (ex * ex + ez * ez < SNAP_M * SNAP_M) {
        t.ox = ex; t.oz = ez;
        t.ovx += pvx - m.vx; t.ovz += pvz - m.vz;
      } else { t.ox = t.oz = t.ovx = t.ovz = 0; t.alpha = 0; }
    }
    t.bx = x; t.bz = z; t.vx = vx; t.vz = vz; t.w = w; t.tb = tSample;
  }

  /**
   * One radar entry ({ id, x, z, yaw, vx, vz, color, vclass }) sampled at server time `tSample`; tNow = current
   * server time, now = local ms (liveness).
   */
  ingest(e, tSample, tNow, now) {
    const t = this._track(e.id);
    t.color = e.color; t.vclass = e.vclass; t.seen = now; t.gone = false;
    if (t.wasAnchored) return; // the 3D interpolation owns it
    if (t.fresh) t.yaw = e.yaw;
    // turn rate from the change of the velocity direction since the last summary (cars follow curves)
    let w = 0;
    const dts = (tSample - t.tb) / 1000;
    if (!t.fresh && dts > 0.2 && dts < 5 && Math.hypot(e.vx, e.vz) > 3 && Math.hypot(t.vx, t.vz) > 3) {
      const wm = wrap(Math.atan2(e.vz, e.vx) - Math.atan2(t.vz, t.vx)) / dts;
      w = Math.max(-MAX_TURN, Math.min(MAX_TURN, t.w ? 0.5 * t.w + 0.5 * wm : wm));
    }
    this._rebase(t, e.x, e.z, e.vx, e.vz, tSample, tNow, w);
    t.fresh = false;
    t.yawT = e.yaw;
  }

  /** A player we also see in 3D (call every frame before update): follow its interpolated pose. */
  anchor(id, x, z, yaw, vx, vz, ts, color, vclass, now) {
    const t = this._track(id);
    if (t.wasAnchored) {
      // continuing: offsets keep decaying. If the 3D pose itself jumps (it snaps after a long stall), blend instead.
      const d = Math.max(0, (ts - t.tb) / 1000), jx = x - (t.bx + t.vx * d), jz = z - (t.bz + t.vz * d);
      if (jx * jx + jz * jz > JUMP_M * JUMP_M) this._rebase(t, x, z, vx, vz, ts, ts);
      else { t.bx = x; t.bz = z; t.vx = vx; t.vz = vz; t.tb = ts; }
    }
    else { if (t.fresh) t.yaw = yaw; this._rebase(t, x, z, vx, vz, ts, ts); } // entering the rings: blend
    t.anchored = true; t.fresh = false; t.gone = false; t.seen = now; t.yawT = yaw;
    if (color !== undefined) t.color = color;
    if (vclass !== undefined) t.vclass = vclass;
  }

  /** Per frame: ts = current server time (ms), now = local ms, dt = s. */
  update(ts, now, dt) {
    this.ts = ts;
    const list = this.list;
    const k = Math.exp(-OMEGA * dt), hk = 1 - Math.exp(-HEADING_K * dt);
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      t.wasAnchored = t.anchored;
      t.anchored = false;
      if (!t.wasAnchored && !t.gone && now - t.seen > (t.vx * t.vx + t.vz * t.vz < 0.25 ? KEEP_STILL_MS : KEEP_MS)) t.gone = true;
      t.alpha = t.gone ? t.alpha - dt / FADE_S : Math.min(1, t.alpha + dt / FADE_S);
      if (t.alpha <= 0 && t.gone) { this._remove(i); continue; }
      // exact step of the critically damped spring x'' = -2ωx' - ω²x for the correction offset: no jump, no overshoot
      let tmp = (t.ovx + OMEGA * t.ox) * dt;
      t.ovx = (t.ovx - OMEGA * tmp) * k; t.ox = (t.ox + tmp) * k;
      tmp = (t.ovz + OMEGA * t.oz) * dt;
      t.ovz = (t.ovz - OMEGA * tmp) * k; t.oz = (t.oz + tmp) * k;
      const d = Math.min(MAX_EXTRAP_S, Math.max(-1, (ts - t.tb) / 1000));
      const m = arc(t.vx, t.vz, t.w, d);
      t.x = t.bx + m.dx + t.ox;
      t.z = t.bz + m.dz + t.oz;
      // the heading target turns with the track (velocity angle +w·d ⇒ yaw −w·d), so a turning car's arrow keeps
      // turning between summaries instead of jumping at each one
      const yT = t.wasAnchored ? t.yawT : t.yawT - t.w * Math.max(0, d);
      t.yaw = wrap(t.yaw + wrap(yT - t.yaw) * (t.wasAnchored ? Math.max(hk, 0.5) : hk));
    }
  }

  _remove(i) {
    const t = this.list[i], last = this.list.pop();
    if (last !== t) this.list[i] = last;
    this.byId.delete(t.id);
    this.pool.push(t);
  }

  clear() { while (this.list.length) this._remove(this.list.length - 1); this.ts = NaN; }
}
