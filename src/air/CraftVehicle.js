// THREE-facing base for aircraft and boats implementing the Controllable interface (docs/ARCHITECTURE.md):
// interpolated transform, input routing, nav/strobe/beacon lights, headlight spot, engine audio,
// gameplay events (impact, splash, destroyed), parking far from the player.
import * as THREE from 'three';
import { AirCamera } from './AirCamera.js';
import { SprayFX } from '../boat/Spray.js';
import { NO_CTL, HOLD_CTL } from './controls.js';
import { initHeadlightPool, claimHeadlights, releaseHeadlights } from '../vehicle/headlights.js';

const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _sp = new THREE.Vector3();
let UID = 0;

export function tr(game, key, fallback, params) {
  const s = game.i18n?.t?.(key, params);
  if (!s || s === key) return fallback.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? params[k] : m));
  return s;
}

export class CraftVehicle {
  /**
   * @param {object} game
   * @param {object} o { entry, physics, model, camCfg, seats, kind, engineSound }
   */
  constructor(game, o) {
    this.uid = ++UID;
    this.game = game;
    this.entry = o.entry;
    this.kind = o.kind;
    this.catalogId = o.entry.id;
    this.name = o.entry.name;
    this.physics = o.physics;
    this.model = o.model;
    this.camCfg = o.camCfg;
    this.seats = o.seats;
    this.camera = AirCamera.get(game);
    this.object3d = new THREE.Group();
    this.object3d.name = `${o.kind}:${o.entry.id}`;
    this.object3d.userData.vehicle = this;
    this.object3d.add(o.model.root);
    game.scene.add(this.object3d);
    this.spray = SprayFX.get(game.scene);
    if (!this.spray.registered) {
      // shared particles keep simulating even when no craft is near (or all were despawned)
      const spray = this.spray;
      spray.registered = true;
      game.register({ lateUpdate: (dt) => spray.update(dt, game.camera, game.renderer?.domElement?.height || 900, game.sky?.night ?? 0) }, 70);
    }
    this._occupied = false;
    this.headlightsOn = false;
    this._siren = false;
    this.destroyed = false;
    this.lightT = Math.random() * 3;
    this.spot = null;
    this.ctl = {};
    this.fxAcc = 0;
    this.engine = null;
    try { this.engine = game.audio?.createEngine?.(o.engineSound, { object3d: this.object3d }) ?? null; } catch (e) { console.warn('[air] engine audio', e); }
    this.updateVisual(1, 0);
  }

  get body() { return this.physics.body; }
  get telemetry() { return this.physics.telemetry; }
  get drowned() { return this.physics.drowned; }
  set drowned(v) { this.physics.drowned = v; }
  get health() { return this.physics.health; }
  get occupied() { return this._occupied; }
  set occupied(v) {
    v = !!v;
    if (v === this._occupied) return;
    this._occupied = v;
    if (v) this.physics.park(false);
    this.engine?.setOccupied?.(v);
  }
  get siren() { return this._siren; }
  set siren(v) { this._siren = !!v; }

  isPlayerDriving() {
    const p = this.game.player;
    return !!p && p.controllable === this && p.mode === 'vehicle';
  }

  /** Subclasses: fill this.ctl from the input devices. */
  readControls(inp, dt) { return NO_CTL; }

  fixedUpdate(dt, input) {
    const drive = this._occupied && input?.driver !== false;
    const ctl = !(drive && this.game.input) ? NO_CTL : this.game.ui?.isOpen ? HOLD_CTL : this.readControls(this.game.input, dt);
    this.updateParking();
    this.physics.fixedUpdate(dt, ctl);
    this.drainEvents();
  }

  updateParking() {
    if (this._occupied) { if (this.physics.parked) this.physics.park(false); return; }
    const f = this.game.player?.focus;
    if (!f) return;
    const p = this.physics.parked ? this.physics.prevPos : this.body.translation();
    const d = Math.hypot(p.x - f.x, p.z - f.z);
    if (!this.physics.parked && d > 480) {
      const lv = this.body.linvel();
      if (Math.hypot(lv.x, lv.y, lv.z) < 1 || this.kind === 'boat') this.physics.park(true);
    } else if (this.physics.parked && d < 420) this.physics.park(false);
  }

  drainEvents() {
    const ev = this.physics.events;
    if (!ev.length) return;
    const game = this.game;
    const t = this.body.translation();
    const pos = { x: t.x, y: t.y, z: t.z };
    for (const e of ev) {
      switch (e.type) {
        case 'impact':
          game.events.emit('impact', { position: pos, strength: e.strength, kind: 'vehicle', material: 'metal', source: this });
          break;
        case 'splash':
          game.events.emit('splash', { position: { x: t.x, y: 0, z: t.z }, strength: e.strength });
          this.spray.splash(t.x, 0, t.z, e.strength, this.body.linvel().x, this.body.linvel().z);
          break;
        case 'rotorStrike':
          game.events.emit('impact', { position: e.point, strength: 1, kind: e.kind === 'water' ? 'water' : 'building', material: 'metal', source: this });
          for (let i = 0; i < 30; i++) this.spray.emit(e.kind === 'water' ? 'splash' : 'dust', e.point.x, e.point.y, e.point.z, (Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14, 0.6, 1.2, 0.8);
          break;
        case 'rotorHit': {
          const u = e.collider?.userData;
          if (u && u.tree !== undefined && game.veg?.breakTree) {
            const lv = this.body.linvel();
            const sp = Math.hypot(lv.x, lv.z) || 1;
            if (game.veg.breakTree(u.tree, u.id, { x: lv.x / sp || 1, z: lv.z / sp }, 1.5)) game.events.emit('tree:broken', { position: e.point, type: u.tree });
          }
          game.events.emit('impact', { position: e.point, strength: 0.5, kind: e.kind === 'prop' ? 'tree' : 'vehicle', material: e.kind === 'prop' ? 'wood' : 'metal', source: this });
          break;
        }
        case 'destroyed':
          this.onDestroyed(pos);
          break;
        default:
          break;
      }
    }
    ev.length = 0;
  }

  onDestroyed(pos) {
    if (this.destroyed) return;
    this.destroyed = true;
    const game = this.game;
    const power = this.kind === 'boat' ? 1 : 1.2;
    if (game.fx?.explode) game.fx.explode(pos, power);
    else game.events.emit('explosion', { position: pos, power, radius: 12 });
    game.events.emit('vehicle:destroyed', { vehicle: this });
    // charred look
    const m = this.model.materials;
    for (const k of ['paint', 'paint2', 'white']) if (m[k]) { m[k].color.multiplyScalar(0.18); m[k].roughness = 0.95; }
    this.burnT = 25;
  }

  reset(position, yaw = 0) {
    const wrecked = this.physics.destroyed || this.physics.drowned;
    // reset in place while flying (R = recover): keep altitude, level attitude
    const t = this.body.translation();
    const inAir = !wrecked && this.kind !== 'boat' && this.physics.agl > 12 && Math.hypot(position.x - t.x, position.z - t.z) < 60;
    this.place(position, yaw, inAir ? { air: true, altitude: this.physics.agl } : {});
    if (wrecked) this.repair();
    this.spray.foam.end(this.uid);
    this.updateVisual(1, 0);
  }

  /** Subclasses: put the craft at a sensible spot near position. */
  place(position, yaw, opts) { this.physics.reset(position, yaw, opts); }

  repair() {
    this.physics.repair();
    this.destroyed = false;
    this.burnT = 0;
    const look = this.model.look;
    const m = this.model.materials;
    if (look) {
      m.paint.color.setHex(look.color); m.paint2.color.setHex(look.color2); m.white.color.setHex(0xf1f1ee);
      m.paint.roughness = 0.42; m.paint2.roughness = 0.45; m.white.roughness = 0.5;
    }
  }

  setHeadlights(on) {
    this.headlightsOn = !!on;
    if (this.headlightsOn && this.spotCfg) this.createSpot();
    else if (this.spot) { releaseHeadlights(this._pool, this); this.spot = null; }
    if (this.spot) this.spot.intensity = this.headlightsOn ? this.spotCfg.intensity : 0;
  }

  // The beam is one of the scene's pooled headlight SpotLights (src/vehicle/headlights.js), never a new light: adding
  // a light at runtime changes the light count and recompiles every lit material in the world (seconds). Anchors on
  // the model give its pose; syncSpot() copies it onto the pooled light every frame while this craft owns the pool.
  createSpot() {
    const c = this.spotCfg;
    if (!this._spotAnchor) {
      const parent = c.parent || this.model.root;
      this._spotAnchor = new THREE.Object3D();
      this._spotAnchor.position.set(c.pos[0], c.pos[1], c.pos[2]);
      this._spotAim = new THREE.Object3D();
      this._spotAim.position.set(c.pos[0] + c.dir[0] * 10, c.pos[1] + c.dir[1] * 10, c.pos[2] + c.dir[2] * 10);
      parent.add(this._spotAnchor, this._spotAim);
    }
    const pool = (this._pool ||= initHeadlightPool(this.game.scene));
    if (pool.owner !== this && pool.owner && !this._occupied && pool.owner.occupied && pool.owner.headlightsOn) return; // the driven car keeps it
    claimHeadlights(pool, this, { color: 0xfff3dc, distance: c.distance, angle: c.angle, penumbra: 0.5, decay: 1.2 });
    this.spot = pool.lights[0];
    this.syncSpot();
  }

  syncSpot() {
    if (!this.spot) {
      // driven again with the lights on after another vehicle took the beams: take them back
      if (!this.headlightsOn || !this._occupied || !this.spotCfg || this._pool?.owner?.occupied) return;
      this.createSpot();
      if (this.spot) this.spot.intensity = this.spotCfg.intensity;
      return;
    }
    if (this._pool?.owner !== this) { this.spot = null; return; } // another vehicle took the beams
    this.object3d.updateMatrixWorld(true);
    this._spotAnchor.getWorldPosition(this.spot.position);
    this.spot.target.position.copy(this._spotAim.getWorldPosition(_sp));
    this.spot.target.updateMatrixWorld();
  }

  /** Interpolate between physics steps and animate. */
  updateVisual(alpha = 1, dt = 0) {
    const ph = this.physics;
    const b = ph.body;
    const o = this.object3d;
    if (ph.parked) { alpha = 1; }
    const t = ph.parked ? ph.prevPos : b.translation();
    const r = ph.parked ? ph.prevRot : b.rotation();
    const pp = ph.prevPos, pr = ph.prevRot;
    o.position.set(pp.x + (t.x - pp.x) * alpha, pp.y + (t.y - pp.y) * alpha, pp.z + (t.z - pp.z) * alpha);
    _q0.set(pr.x, pr.y, pr.z, pr.w);
    _q1.set(r.x, r.y, r.z, r.w);
    o.quaternion.slerpQuaternions(_q0, _q1, alpha);
    if (dt <= 0) return;
    const game = this.game;
    if (this.isPlayerDriving() && !game.paused && game.input) this.handleToggles(game.input, dt);
    this.animate(dt, alpha);
    this.updateLights(dt);
    this.syncSpot();
    if (o.position.distanceToSquared(game.camera.position) < 600 * 600) this.effects(dt);
    if (this.burnT > 0) {
      this.burnT -= dt;
      this.fxAcc += dt * 18;
      while (this.fxAcc > 1) {
        this.fxAcc -= 1;
        this.spray.emit('smoke', o.position.x + (Math.random() - 0.5) * 2, o.position.y + 1, o.position.z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1.5, 2.5, (Math.random() - 0.5) * 1.5, 2.2, 3.5, 0.55);
      }
    }
    if (this.engine) {
      try { this.engine.update(this.telemetry, dt); } catch (e) { console.warn('[air] engine update', e); this.engine = null; }
    }
  }

  handleToggles() {}
  animate() {}
  effects() {}

  /** Nav lights steady, strobes double-flash, beacons pulse; police strobes when siren is on. */
  updateLights(dt) {
    const m = this.model.materials;
    const night = this.game.sky?.night ?? 0;
    this.lightT += dt;
    const powered = (this._occupied || this.physics.engineOn || (this.telemetry.rotorRpm || 0) > 0.2) && !this.destroyed;
    const navI = powered ? 1.2 + night * 2.5 : 0.05;
    m.navRed.emissiveIntensity = navI;
    m.navGreen.emissiveIntensity = navI;
    const sp = this.lightT % 1.2;
    const strobe = powered && this.kind !== 'boat' && (sp < 0.05 || (sp > 0.12 && sp < 0.17)) ? 8 + night * 10 : 0;
    m.strobe.emissiveIntensity = strobe;
    m.beacon.emissiveIntensity = powered && this.kind !== 'boat' ? Math.max(0, Math.sin(this.lightT * Math.PI * 2 * 0.9)) ** 6 * (5 + night * 6) : 0;
    m.lamp.emissiveIntensity = this.headlightsOn || (powered && night > 0.3) ? 3 + night * 3 : 0.15;
    if (this._siren && powered) {
      const ph = (this.lightT * 2.2) % 1;
      const fl = (x) => (x % 0.25 < 0.11 ? 1 : 0);
      m.sirenRed.emissiveIntensity = 0.1 + (ph < 0.5 ? fl(ph) : 0) * 9;
      m.sirenBlue.emissiveIntensity = 0.1 + (ph >= 0.5 ? fl(ph - 0.5) : 0) * 10;
    } else {
      m.sirenRed.emissiveIntensity = 0.05;
      m.sirenBlue.emissiveIntensity = 0.05;
    }
  }

  notify(key, fallback, params) {
    this.game.ui?.notify?.(tr(this.game, key, fallback, params), 1.6);
  }

  dispose() {
    this.spray.foam.remove(this.uid);
    this.engine?.dispose?.();
    this.object3d.removeFromParent();
    this.object3d.traverse((o) => {
      if (o.isMesh || o.isPoints) o.geometry.dispose();
    });
    const seen = new Set();
    this.object3d.traverse((o) => { if (o.material && !seen.has(o.material)) { seen.add(o.material); if (!o.material.map) o.material.dispose(); } });
    for (const mm of Object.values(this.model.materials)) mm.dispose();
    releaseHeadlights(this._pool, this);
    this.spot = null;
    this.physics.dispose();
  }
}
