import { GROUPS, groups } from '../vehicle/groups.js';

const STEP_MS = 2; // per frame for the colliders queued by run() (terrain chunks, road buckets, buildings)

// Streams static colliders (terrain, road surfaces, buildings, trees, lamps) around the player's focus.
// Terrain, roads and buildings build what is close at once and queue the rest (src/world/colliderStream.js); the queue
// is worked off nearest first within STEP_MS per frame and in idle time, so a relocation (teleport, aircraft / boat
// spawn) no longer builds a whole new neighbourhood of colliders in one frame.
export class Streaming {
  constructor(game) {
    this.game = game;
    this.timer = 0;
    this.G_GROUND = groups(GROUPS.GROUND, 0xffff);
    this.G_STATIC = groups(GROUPS.STATIC, 0xffff);
    this.G_PROP = groups(GROUPS.PROP, 0xffff);
    this.queued = false;
    this._waits = 0;
    this._idleId = 0;
  }

  // force: kept for callers (teleports, mode switches): the queue makes every run as complete as a forced one used to be
  run(force = false) { // eslint-disable-line no-unused-vars
    const g = this.game;
    const f0 = g.player?.focus;
    if (!f0) return;
    // stream around where the player will be ~1.5 s from now (fast cars, planes)
    const body = g.player.mode === 'vehicle' ? g.player.controllable?.body : null;
    const v = body ? body.linvel() : null;
    const f = v ? { x: f0.x + v.x * 1.5, z: f0.z + v.z * 1.5 } : f0;
    const { RAPIER, world } = g;
    g.terrain.updateColliders(RAPIER, world, f.x, f.z, 600, this.G_GROUND);
    g.roads.updateColliders(RAPIER, world, f.x, f.z, 700, this.G_GROUND);
    g.buildings.updateColliders(RAPIER, world, f.x, f.z, 350, this.G_STATIC);
    g.veg.updateColliders(RAPIER, world, f.x, f.z, 110, this.G_PROP);
    g.lamps.updateColliders(RAPIER, world, f.x, f.z, 140, this.G_PROP);
    g.traffic?.lights?.updateColliders(RAPIER, world, f.x, f.z, 140, this.G_PROP);
    this.queued = this._streams().some((s) => s.pending.length > 0);
    // something too large for a frame's budget still waiting after ~1 s (no idle time): build it in a frame anyway
    this._waits = this.queued ? this._waits + 1 : 0;
    if (this.queued || this._streams().some((s) => s.prefetch.length > 0)) this._idleSoon();
  }

  _streams() {
    const g = this.game;
    return [g.terrain?.colStream, g.roads?.colStream, g.buildings?.colStream].filter(Boolean);
  }

  /** Build queued colliders within `ms` (nearest first per kind). force: at least one, even above the budget. */
  step(ms, force = false) {
    const t0 = performance.now();
    let more = false;
    for (const s of this._streams()) {
      const left = ms - (performance.now() - t0);
      more = s.step(Math.max(0, left), force) || more;
      if (force && performance.now() - t0 > ms) force = false;
    }
    return more;
  }

  // idle time: the queue first, then the prefetch (all road buckets built ahead, disabled)
  _idleSoon() {
    if (this._idleId || typeof requestIdleCallback !== 'function') return;
    this._idleId = requestIdleCallback((dl) => {
      this._idleId = 0;
      const t0 = performance.now(), budget = Math.max(0, dl.timeRemaining() - 1);
      this.queued = this.step(budget, dl.didTimeout);
      let more = this.queued;
      for (const s of this._streams()) {
        const left = budget - (performance.now() - t0);
        more = s.stepPrefetch(Math.max(0, left)) || more; // only in real idle time (most of it while PLAY waits)
      }
      if (more) this._idleSoon();
    }, { timeout: 1000 });
  }

  update(dt) {
    this.timer -= dt;
    let ms = STEP_MS;
    if (this.timer <= 0) {
      const t0 = performance.now();
      this.run();
      this.timer = 0.35;
      ms -= performance.now() - t0;
    }
    if (this.queued && (ms > 0.25 || this._waits >= 3)) {
      const force = this._waits >= 3;
      if (force) this._waits = 0;
      this.queued = this.step(Math.max(0, ms), force);
    }
  }
}
