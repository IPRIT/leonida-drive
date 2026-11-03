// Boat Controllable: BoatPhysics + model, wake foam, bow spray, rooster tail, airboat fan & rudders.
import * as THREE from 'three';
import { CraftVehicle } from '../air/CraftVehicle.js';
import { BoatPhysics } from './BoatPhysics.js';
import { BOAT_SPEC } from './specs.js';
import { buildBoatModel, BOAT_LOOKS } from './models.js';
import { makeEnv } from '../air/env.js';
import { readBoat } from '../air/controls.js';
import { nearestWater } from '../air/runways.js';
import { shadeDisc } from '../air/models/kit.js';

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

const CAM = {
  boat_speed: { kind: 'boat', dist: 12, height: 2.6, lookY: 1.2, fov: 60, speedRef: 30, pitch: -0.16 },
  boat_jetski: { kind: 'boat', dist: 6.5, height: 1.6, lookY: 0.9, fov: 62, speedRef: 26, pitch: -0.14 },
  boat_cruiser: { kind: 'boat', dist: 18, height: 4.5, lookY: 2.2, fov: 60, speedRef: 18, pitch: -0.18 },
  boat_airboat: { kind: 'boat', dist: 9.5, height: 2.6, lookY: 1.4, fov: 60, speedRef: 20, pitch: -0.18 },
};

const SEATS = {
  boat_speed: [[-0.5, 0.75, 0.35, -1.6], [0.5, 0.75, 0.35, 1.6]],
  boat_jetski: [[0, 0.65, 0.35, -1.0], [0, 0.65, 0.95, 1.0]],
  boat_cruiser: [[0.4, 2.6, -0.6, -2.3], [-0.4, 2.6, -0.6, 2.3]],
  boat_airboat: [[0, 1.45, 0.7, -1.4], [-0.5, 0.65, -0.9, -1.4], [0.5, 0.65, -0.9, 1.4]],
};

export const BOAT_IDS = Object.keys(BOAT_SPEC);

export class Boat extends CraftVehicle {
  constructor(game, entry, pos, yaw = 0, opts = {}) {
    const spec = BOAT_SPEC[entry.id];
    const model = buildBoatModel(entry.id, opts);
    model.look = { ...BOAT_LOOKS[entry.id], ...(opts.color !== undefined ? { color: opts.color } : {}) };
    const physics = new BoatPhysics({ RAPIER: game.RAPIER, world: game.world, spec, position: { x: pos.x, y: 0.05, z: pos.z }, yaw, env: makeEnv(game) });
    const seats = SEATS[entry.id].map(([x, y, z, ex]) => ({ pos: new THREE.Vector3(x, y, z), exit: new THREE.Vector3(ex, 0.3, z), pose: 'boat' }));
    super(game, { entry, physics, model, camCfg: { ...CAM[entry.id], cockpit: model.seat.map((c, i) => (i === 1 ? c + 0.55 : c)) }, seats, kind: 'boat', engineSound: spec.prop.air ? 'prop' : 'boat' });
    this.spec = spec;
    this.fanVis = 0;
    this.spotCfg = { pos: [0, spec.hull.draft + 0.9, -spec.hull.length * 0.42], dir: [0, -0.08, -1], distance: 140, angle: 0.45, intensity: 70 };
    if (model.fan) model.fan.spin.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; } });
    this.place(pos, yaw, opts);
  }

  /** Nearest open water to pos, facing open water (airboats may also start in the swamp). */
  place(pos, yaw, opts = {}) {
    const game = this.game;
    const th = game.terrain.heightAt(pos.x, pos.z);
    const depth = this.spec.skims ? -0.5 : -1.5;
    let x = pos.x, z = pos.z, hdg = yaw;
    // nearest open water (the spot itself when already afloat), bow towards the longest open stretch
    const w = nearestWater(game, pos.x, pos.z, th > depth ? depth : Math.min(depth, th + 0.5));
    if (w) { x = w.x; z = w.z; if (opts.keepYaw !== true) hdg = w.yaw; }
    this.physics.reset({ x, y: 0.05, z }, hdg, { hold: 0 });
  }

  readControls(inp) {
    return readBoat(inp, this.ctl);
  }

  animate(dt) {
    const m = this.model, ph = this.physics;
    if (m.fan) {
      const thr = Math.abs(ph.thrAct);
      const spin = ph.destroyed ? 0 : this._occupied ? 0.25 + thr * 0.75 : 0;
      this.fanVis += Math.min(spin * 30, 1.5 + spin * 3) * Math.PI * 2 * dt;
      m.fan.spin.rotation.z = this.fanVis;
      const blade = 1 - 0.85 * THREE.MathUtils.smoothstep(spin, 0.15, 0.45);
      m.fan.spin.traverse((o) => { if (o.isMesh) o.material.opacity = blade; });
      m.fan.disc.material.opacity = THREE.MathUtils.smoothstep(spin, 0.1, 0.4) * 0.5;
      shadeDisc(m.fan.disc, this.game.sky?.night ?? 0);
      m.fan.disc.visible = m.fan.disc.material.opacity > 0.01;
    }
    if (m.rudders) for (const r of m.rudders) r.rotation.y = ph.steer * 0.5;
  }

  effects(dt) {
    const ph = this.physics, o = this.object3d, tel = this.telemetry, spec = this.spec;
    const lv = this.body.linvel();
    const v = Math.hypot(lv.x, lv.z);
    _f.set(0, 0, -1).applyQuaternion(o.quaternion);
    const h = spec.hull;
    const wet = tel.wet > 0.15;
    // foam wake from the stern
    if (wet && v > 1.2) {
      _v.set(0, 0, h.length * 0.45).applyQuaternion(o.quaternion).add(o.position);
      this.spray.foam.add(this.uid, _v.x, 0.03, _v.z, _f.x, _f.z, h.width * (0.3 + 0.15 * ph.planing), Math.min(0.95, 0.25 + v / 18));
    } else this.spray.foam.end(this.uid);
    if (!wet && ph.onLand && v > 2 && spec.skims) {
      // airboat over grass / mud
      this.fxAcc += dt * v * 3;
      while (this.fxAcc > 1) {
        this.fxAcc -= 1;
        _v.set((Math.random() - 0.5) * h.width, 0, h.length * 0.4).applyQuaternion(o.quaternion).add(o.position);
        this.spray.emit('dust', _v.x, _v.y + 0.1, _v.z, lv.x * 0.2, 0.8 + Math.random(), lv.z * 0.2, 0.7, 1.2, 0.35);
      }
      return;
    }
    if (!wet || v < 3) return;
    // bow spray sheets + stern prop wash / rooster tail
    const rate = (v - 3) * (spec.skims ? 1.4 : 2.6) * (0.5 + ph.planing);
    this.fxAcc += dt * rate;
    const side = THREE.MathUtils.clamp(v * 0.12, 0.6, 3.5);
    while (this.fxAcc > 1) {
      this.fxAcc -= 1;
      const s = Math.random() < 0.5 ? -1 : 1;
      const bowZ = -h.length * (0.18 + 0.12 * (1 - ph.planing));
      _v.set(s * h.width * 0.5, 0, bowZ).applyQuaternion(o.quaternion).add(o.position);
      const sx = -_f.z * s, sz = _f.x * s;
      this.spray.emit('spray', _v.x, 0.15, _v.z, lv.x * 0.55 + sx * side, 0.8 + Math.random() * 1.8, lv.z * 0.55 + sz * side, 0.35 + v * 0.012, 0.7 + Math.random() * 0.4, 0.75);
      if (Math.random() < 0.45 && !spec.prop.air) {
        _v.set((Math.random() - 0.5) * 0.4, 0, h.length * 0.5 + 0.2).applyQuaternion(o.quaternion).add(o.position);
        const up = this.catalogId === 'boat_jetski' ? 2.5 + v * 0.25 : 0.6 + ph.thrAct * 1.5;
        this.spray.emit(this.catalogId === 'boat_jetski' ? 'spray' : 'mist', _v.x, 0.2, _v.z, lv.x * 0.25 - _f.x * 2, up, lv.z * 0.25 - _f.z * 2, this.catalogId === 'boat_jetski' ? 0.45 : 1.0, 1.0, 0.55);
      }
    }
  }
}
