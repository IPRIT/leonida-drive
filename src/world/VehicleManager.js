import * as THREE from 'three';
import { Vehicle, VEHICLE_PRESETS, PRESET_ORDER, SkidMarks, TireSmoke, GROUPS } from '../vehicle/index.js';
import { patchFakeLightsDeep } from './fakeLights.js';
import { ShadowProxy, enableShadowLayer } from '../vehicle/shadowProxy.js';
import { prewarmCarModel } from '../vehicle/CarModel.js';
import { deriveSpec } from '../vehicle/physics/VehiclePhysics.js';

// input for vehicles without a driver
export const NEUTRAL = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false, driver: false });

// Surfaces for tyre grip (env.getSurface)
export const SURF = {
  asphalt: { name: 'asphalt', grip: 1.0, rolling: 0, dust: false },
  wetAsphalt: { name: 'wet', grip: 0.82, rolling: 0, dust: false },
  grass: { name: 'grass', grip: 0.72, rolling: 0.02, dust: true },
  dirt: { name: 'dirt', grip: 0.78, rolling: 0.015, dust: true },
  sand: { name: 'sand', grip: 0.62, rolling: 0.05, dust: true },
  mud: { name: 'dirt', grip: 0.55, rolling: 0.04, dust: true },
};

// Full-physics controllables (player-driven, abandoned, spawned from the menu).
// Catalog entries: { id, name, category, kind, desc, create?(game,pos,yaw,opts) } — entries without `create`
// are ground vehicles built with the shared Vehicle class.
export class VehicleManager {
  constructor(game, { max = 8 } = {}) {
    this.game = game;
    this.max = max;
    this.active = [];
    this.skid = new SkidMarks(game.scene);
    this.smoke = new TireSmoke(game.scene);
    const t = game.terrain;
    this.env = {
      waterLevel: 0,
      getSurface(x, z) {
        const g = t.groundAt(x, z);
        const G = t.G;
        const wet = game.uniforms.uWetness.value > 0.35;
        if (g === G.road || g === G.urban || g === G.paved || g === G.building) return wet ? SURF.wetAsphalt : SURF.asphalt;
        if (g === G.water) return t.heightAt(x, z) < -0.2 ? (wet ? SURF.wetAsphalt : SURF.asphalt) : SURF.sand;
        if (g === G.sand) return SURF.sand;
        if (g === G.dirt) return SURF.dirt;
        if (g === G.wetland) return SURF.mud;
        return SURF.grass;
      },
    };
    // shadow proxies (src/vehicle/shadowProxy.js): the sun's shadow cameras see their layer, they are validated
    // right before every draw
    enableShadowLayer([game.sky?.sun, game.sky?.sunCSM]);
    game.render?.beforeRender?.push(() => { for (const v of this.active) v.shadowProxy?.update(); });
    this.catalog = PRESET_ORDER.map((id) => ({
      id, name: VEHICLE_PRESETS[id].displayName || id, category: 'car', kind: 'car', desc: '',
    }));
    this.byId = new Map(this.catalog.map((e) => [e.id, e]));
    game.events?.on?.('start', () => { this._playing = true; });
  }

  /**
   * Car designs (and their assembled meshes) generated ahead of a spawn: a detailed model costs ~16 ms to design and
   * ~5 ms to assemble, which the spawn frame used to pay (kanzler: 26 ms). Queued from the player's owned vehicles
   * and the garage selection (front: true). Runs in idle time only: in play a frame's idle slice is far too short
   * (nothing is generated between frames), in the pause menu / garage and before PLAY it is long enough.
   */
  prewarmDesigns(ids, front = false) {
    const q = (this._designQ ||= []);
    for (const id of ids) {
      const entry = this.byId.get(id);
      if (!entry || entry.create) continue; // aircraft, boats, tank: their own builders
      const i = q.indexOf(id);
      if (i >= 0) q.splice(i, 1);
      if (front) q.unshift(id); else q.push(id);
    }
    // garage selection (menu open, world paused): once the selection settles, build it right away; the menu draws a
    // static frame and the live turntable is about to build the same design anyway
    if (front && this.game.paused) {
      clearTimeout(this._designT);
      this._designT = setTimeout(() => {
        if (!this.game.paused || !q.length) return;
        const id = q.shift();
        try { prewarmCarModel(deriveSpec(id)); } catch (e) { console.warn('[vehicles] design prewarm', id, e); }
      }, 300);
    }
    this._designIdle();
  }

  _designIdle() {
    if (this._designId || !this._designQ?.length || typeof requestIdleCallback !== 'function') return;
    this._designId = requestIdleCallback((dl) => {
      this._designId = 0;
      // before PLAY there are no game frames; in the pause menu a frame costs ~1 ms: one design may overrun a menu
      // frame, never a game frame (in play an idle slice above 25 ms does not happen while frames are drawn)
      const need = !this._playing ? 1 : this.game.paused ? 4 : 25;
      while (this._designQ.length && dl.timeRemaining() > need) {
        const id = this._designQ.shift();
        try { prewarmCarModel(deriveSpec(id)); } catch (e) { console.warn('[vehicles] design prewarm', id, e); }
        if (this.game.paused) break; // one per menu frame
      }
      this._designIdle();
    }, { timeout: 4000 });
  }

  // add more catalog entries (aircraft, boats, extended car list)
  addCatalog(entries) {
    for (const e of entries) {
      if (this.byId.has(e.id)) this.catalog[this.catalog.findIndex((c) => c.id === e.id)] = e;
      else this.catalog.push(e);
      this.byId.set(e.id, e);
    }
  }

  /**
   * Build a vehicle without registering it (no events, not in `active`). Materials get their final shader patches
   * here (fake street-lamp lighting), so the programs compiled for them are the ones every later frame uses.
   */
  create(id, pos, yaw = 0, opts = {}) {
    const game = this.game;
    const entry = this.byId.get(id) || { id, kind: 'car' };
    let v;
    if (entry.create) v = entry.create(game, pos, yaw, opts);
    else {
      v = new Vehicle({
        RAPIER: game.RAPIER, world: game.world, scene: game.scene, preset: id, color: opts.color,
        position: new THREE.Vector3(pos.x, pos.y, pos.z), yaw, env: this.env,
        skidMarks: this.skid, tireSmoke: this.smoke, spotLights: opts.spotLights !== false,
      });
      v.kind = v.kind || entry.kind || 'car';
      v.catalogId = id;
      v.name = entry.name || id;
    }
    v.catalogId ??= id;
    v.occupied = false;
    patchFakeLightsDeep(v.object3d);
    this.game.render?.keepShaders?.(v.object3d);
    return v;
  }

  spawn(id, pos, yaw = 0, opts = {}) {
    const game = this.game;
    const v = this.create(id, pos, yaw, opts);
    this.active.push(v);
    game.damage?.attach?.(v);
    v.shadowProxy = this.shadowProxyFor(v);
    game.events.emit('vehicle:spawn', { vehicle: v });
    // first of its kind: its shader programs compile in the background and the model shows up when they are
    // linked (a few frames) instead of stalling the frame that first draws it; known kinds draw right away
    game.render?.warm?.(v.object3d);
    this.trim();
    return v;
  }

  /**
   * Loading screen: build one vehicle of every kind (car designs, bikes, trucks, buses, aircraft, boats, tank) and
   * compile their programs in parallel. Returns { objects, dispose() }: draw `objects` once (Renderer.prewarmDraw:
   * the GPU pipeline is built at the first real draw), then dispose. Programs stay alive (Renderer.pinPrograms), so
   * the first spawn of any kind in play draws without compiling.
   */
  prewarmKinds(ids = this.sampleIds()) {
    const render = this.game.render;
    const t0 = performance.now();
    const made = [];
    const at = { x: 0, y: -400, z: 0 }; // far below the map: no contacts (physics is not stepping yet anyway)
    for (const id of ids) {
      try {
        const v = this.create(id, { x: at.x + made.length * 30, y: at.y, z: at.z }, 0, { spotLights: false });
        v.body?.setEnabled?.(false);
        made.push(v);
        render?.warm?.(v.object3d, { hide: false, maxMs: 6000 });
      } catch (e) { console.warn('[vehicles] prewarm', id, e); }
    }
    this.prewarmInfo = { samples: made.length, buildMs: Math.round(performance.now() - t0) };
    return {
      objects: made.map((v) => v.object3d),
      dispose: () => { for (const v of made) { try { v.dispose(); } catch (e) { console.warn('[vehicles] prewarm dispose', e); } } },
    };
  }

  // one merged shadow caster for the rigid parts (cars: the body without wheels, lamps, pop-ups, animated extras;
  // aircraft / boats / tank: whatever does not move, found by observation)
  shadowProxyFor(v) {
    try {
      const m = v.model;
      const ready = () => !v.damage?._refine; // the damage system swaps in refined car meshes first
      if (v instanceof Vehicle && m?.body) {
        const exclude = [m.parts?.lights, m.steer, ...(m.popups || []), ...Object.values(m.extra || {})].filter(Boolean);
        return new ShadowProxy(m.body, { exclude, ready });
      }
      return v.object3d ? new ShadowProxy(v.object3d, { ready }) : null;
    } catch (e) { console.warn('[vehicles] shadow proxy', e); return null; }
  }

  /** One catalog id per distinct model family: kind × design type, every aircraft / boat model, the tank. */
  sampleIds() {
    const seen = new Set(), ids = [];
    for (const e of this.catalog) {
      const k = e.create ? e.id : `${e.kind}|${VEHICLE_PRESETS[e.id]?.design?.type || (VEHICLE_PRESETS[e.id]?.design ? 'car' : 'legacy')}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ids.push(e.id);
    }
    return ids;
  }

  despawn(v) {
    const i = this.active.indexOf(v);
    if (i >= 0) this.active.splice(i, 1);
    this.game.events.emit('vehicle:despawn', { vehicle: v });
    v.shadowProxy?.dispose();
    v.shadowProxy = null;
    v.damage?.dispose?.();
    v.dispose();
  }

  // keep the number of full-physics vehicles bounded (drop the farthest unoccupied ones)
  trim() {
    const p = this.game.player?.focus;
    if (!p) return;
    while (this.active.length > this.max) {
      let worst = null, wd = -1;
      for (const v of this.active) {
        if (v.occupied || v === this.game.player?.controllable) continue;
        const t = v.body.translation();
        const d = Math.hypot(t.x - p.x, t.z - p.z);
        if (d > wd) { wd = d; worst = v; }
      }
      if (!worst) break;
      this.despawn(worst);
    }
  }

  // nearest thing the player could get into: {type:'vehicle', vehicle} | {type:'traffic', agent}
  nearestEnterable(pos, r = 4.5) {
    let best = null, bd = r;
    for (const v of this.active) {
      if (v.occupied || v.destroyed) continue;
      const t = v.body.translation();
      const d = Math.hypot(t.x - pos.x, t.z - pos.z, (t.y - pos.y) * 0.5);
      if (d < bd) { bd = d; best = { type: 'vehicle', vehicle: v, dist: d }; }
    }
    const tr = this.game.traffic;
    if (tr) {
      for (const a of tr.agents) {
        if (a.crashed && a.burning) continue;
        const d = Math.hypot(a.cur.x - pos.x, a.cur.z - pos.z, (a.cur.y - pos.y) * 0.5);
        if (d < bd) { bd = d; best = { type: 'traffic', agent: a, dist: d }; }
      }
    }
    return best;
  }

  fixedUpdate(dt, game) {
    for (const v of this.active) {
      if (v === game.player?.controllable && game.player.mode === 'vehicle') { // driven by the player controller
        if (v._parkedDamp) { v._parkedDamp = false; v.body.setLinearDamping(v._baseDamp[0]); v.body.setAngularDamping(v._baseDamp[1]); }
        continue;
      }
      v.fixedUpdate(dt, NEUTRAL);
      // parked: heavy damping so a pedestrian or a slow nudge can't slide the car around (crashes still move it)
      const lv = v.body?.linvel?.();
      if (lv) {
        const slow = Math.hypot(lv.x, lv.z) < 1.5;
        if (slow !== v._parkedDamp) {
          v._parkedDamp = slow;
          v._baseDamp ??= [v.body.linearDamping(), v.body.angularDamping()];
          v.body.setLinearDamping(slow ? 3.5 : v._baseDamp[0]);
          v.body.setAngularDamping(slow ? 4 : v._baseDamp[1]);
        }
      }
    }
  }

  // safety net: a hard crash can push a chassis through the thin ground/road surface. If a body's origin ends up
  // under a ground surface (2 cm or more) it is lifted back on top and its downward velocity cleared (aircraft and
  // boats excluded). Not when it is merely low above one: a car straddling a kerb or mounting a sidewalk at speed
  // has its centre a few cm over the slab, and lifting it 0.95 m there threw it into the air. The surface is the one the physics actually has there: a short ray
  // against the ground colliders (terrain heightfield + road trimeshes) from 1.2 m above the origin. The old test
  // compared against the nearest road centreline height, which differs from the real asphalt at junctions, joints
  // and banked/overlapping carriageways and teleported cars driving normally there ~0.6 m up (a "jump").
  postStep(dt, game) {
    const T = game.terrain, R = game.roads, W = game.world, RAPIER = game.RAPIER;
    if (!this._ray && RAPIER) {
      this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
      this._rayGroups = (((0xffff) << 16) | GROUPS.GROUND) >>> 0;
    }
    for (const v of this.active) {
      const b = v.body;
      if (!b || v.kind === 'plane' || v.kind === 'heli' || v.kind === 'boat') continue;
      const t = b.translation();
      let ground = null;
      if (this._ray && W) {
        const o = this._ray.origin;
        o.x = t.x; o.y = t.y + 1.2; o.z = t.z;
        const hit = W.castRay(this._ray, 1.18, true, undefined, this._rayGroups, undefined, b);
        if (hit) ground = t.y + 1.2 - hit.timeOfImpact;
      }
      if (ground === null) {
        // deeper under the drawn terrain than the ray reaches: a fast fall through the heightfield - unless there
        // is ground right under the car (a tunnel: the drawn hill is overhead, the floor below)
        const h = T.heightAt(t.x, t.z);
        if (h < -0.5 || t.y > h - 0.3) continue; // over water: let it sink
        if (this._ray && W) {
          const o = this._ray.origin;
          o.x = t.x; o.y = t.y; o.z = t.z;
          if (W.castRay(this._ray, 3, true, undefined, this._rayGroups, undefined, b)) continue;
        }
        const n = R?.nearest(t.x, t.z, 12);
        ground = n?.edge.tunnel && n.dist < n.edge.w / 2 + 2 ? n.y + 0.07 : h;
      }
      b.setTranslation({ x: t.x, y: ground + 0.95, z: t.z }, true);
      const lv = b.linvel();
      if (lv.y < 0) b.setLinvel({ x: lv.x * 0.8, y: 0, z: lv.z * 0.8 }, true);
    }
  }

  update(dt, game, alpha) {
    for (const v of this.active) v.updateVisual(alpha, dt);
    this.skid.update(dt);
    this.smoke.update(dt, game.camera, game.renderer.domElement.height);
    this._trimT = (this._trimT || 0) - dt;
    if (this._trimT <= 0) { this._trimT = 2; this.trim(); }
  }
}

export { GROUPS };
