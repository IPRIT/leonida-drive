// Helicopter Controllable: HeliPhysics + procedural model, rotor animation & blur, searchlight, downwash FX.
import * as THREE from 'three';
import { CraftVehicle } from './CraftVehicle.js';
import { HeliPhysics } from './physics/HeliPhysics.js';
import { HELI_SPECS } from './specs.js';
import { buildHeliModel, HELI_LOOKS } from './models/helis.js';
import { lightCone, shadeDisc } from './models/kit.js';
import { makeEnv } from './env.js';
import { readHeli, pressed } from './controls.js';
import { surfaceY, obstacleTop, clearSpot } from './runways.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const FWD = new THREE.Vector3(0, 0, -1);

const CAM = {
  heli_news: { kind: 'heli', dist: 12, height: 2.4, lookY: 0.9, fov: 60, speedRef: 60, pitch: -0.2 },
  heli_police: { kind: 'heli', dist: 14.5, height: 2.8, lookY: 1.0, fov: 60, speedRef: 70, pitch: -0.2 },
  heli_cargo: { kind: 'heli', dist: 27, height: 5, lookY: 2.0, fov: 60, speedRef: 75, pitch: -0.18 },
};

const SEATS = {
  heli_news: [[0.33, -0.15, -0.7, 1.7], [-0.33, -0.15, -0.7, -1.7]],
  heli_police: [[0.45, -0.1, -1.45, 1.9], [-0.45, -0.1, -1.45, -1.9], [0.45, -0.1, 0.1, 1.9], [-0.45, -0.1, 0.1, -1.9]],
  heli_cargo: [[0.6, 0.1, -6.0, 2.4], [-0.6, 0.1, -6.0, -2.4], [0.8, -0.4, -2.0, 2.4], [-0.8, -0.4, 0.0, -2.4]],
};

function mkSeats(id, skidY) {
  return SEATS[id].map(([x, y, z, ex]) => ({ pos: new THREE.Vector3(x, y, z), exit: new THREE.Vector3(ex, skidY + 0.1, z), pose: 'heli' }));
}

export class Heli extends CraftVehicle {
  constructor(game, entry, pos, yaw = 0, opts = {}) {
    const spec = HELI_SPECS[entry.id];
    const model = buildHeliModel(entry.id, spec, opts);
    model.look = { ...HELI_LOOKS[entry.id], ...(opts.color !== undefined ? { color: opts.color } : {}) };
    const physics = new HeliPhysics({ RAPIER: game.RAPIER, world: game.world, spec, position: { x: pos.x, y: pos.y, z: pos.z }, yaw, env: makeEnv(game), state: { hold: 0 } });
    const cam = { ...CAM[entry.id], cockpit: model.cockpit };
    super(game, { entry, physics, model, camCfg: cam, seats: mkSeats(entry.id, spec.skidY), kind: 'heli', engineSound: 'heli' });
    this.spec = spec;
    this.assist = true;
    this.rotorVis = model.rotors.map(() => 0);
    this.tailVis = 0;
    // blades fade out at speed: give them their own transparent materials
    for (const r of [...model.rotors, model.tail].filter(Boolean)) {
      r.blades.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; } });
    }
    if (model.searchlight) {
      this.spotCfg = { parent: model.searchlight.pivot, pos: [0, 0, -0.25], dir: [0, 0, -1], distance: 420, angle: 0.16, intensity: 260 };
      this.cone = lightCone(70, 6.5, 0xfff0cc);
      this.cone.position.z = -0.25;
      model.searchlight.pivot.add(this.cone);
      this.slDir = new THREE.Vector3(0, -0.7, -0.7).normalize();
    } else {
      this.spotCfg = { pos: [0, spec.skidY + 0.5, -1.2], dir: [0, -0.55, -1], distance: 120, angle: 0.4, intensity: 60 };
    }
    this.place(pos, yaw, opts);
  }

  /** On the ground at pos; over water (or opts.air) hovering 25 m up with the rotor spinning. */
  place(pos, yaw, opts = {}) {
    const game = this.game;
    const R = this.spec.rotor.radius;
    const th = game.terrain.heightAt(pos.x, pos.z);
    const air = opts.air || th < -0.4;
    if (air) {
      const y = Math.max(th, 0, obstacleTop(game, pos.x, pos.z, R + 10)) + (opts.altitude ?? 25);
      this.physics.reset({ x: pos.x, y, z: pos.z }, yaw, { air: true });
      return;
    }
    // need room for the rotor: move to the nearest spot clear of buildings
    const spot = clearSpot(game, pos.x, pos.z, R + 1.5) || { x: pos.x, z: pos.z };
    const y = surfaceY(game, spot.x, spot.z) - this.spec.skidY + 0.05;
    this.physics.reset({ x: spot.x, y, z: spot.z }, yaw, { hold: 2.5 });
  }

  readControls(inp) {
    const c = readHeli(inp, this.ctl);
    c.assist = this.assist;
    return c;
  }

  handleToggles(inp) {
    if (pressed.assist(inp)) {
      this.assist = !this.assist;
      this.notify(this.assist ? 'air.hoverAssistOn' : 'air.hoverAssistOff', this.assist ? 'HOVER ASSIST ON' : 'HOVER ASSIST OFF');
    }
  }

  animate(dt) {
    const ph = this.physics, m = this.model, spec = this.spec;
    const rpm = ph.rpm;
    const night = this.game.sky?.night ?? 0;
    for (const r of m.rotors) shadeDisc(r.disc, night);
    if (m.tail) shadeDisc(m.tail.disc, night);
    const bladeA = 1 - 0.8 * THREE.MathUtils.smoothstep(rpm, 0.35, 0.85);
    const discA = THREE.MathUtils.smoothstep(rpm, 0.3, 0.9) * 0.32;
    m.rotors.forEach((r, i) => {
      // visual spin rate is capped so blades read as motion instead of strobing
      const rate = Math.min(rpm * spec.rotorRps, 0.55 + rpm * 0.9) * Math.PI * 2;
      this.rotorVis[i] += rate * dt * r.dir;
      r.spin.rotation.y = this.rotorVis[i];
      r.blades.traverse((o) => { if (o.isMesh) o.material.opacity = bladeA; });
      r.disc.material.opacity = discA;
      r.disc.visible = discA > 0.01;
      if (!spec.twin) {
        r.pivot.rotation.x = -ph.input.pitch * 0.07;
        r.pivot.rotation.z = -ph.input.roll * 0.07;
      }
    });
    if (m.tail) {
      this.tailVis += Math.min(rpm * spec.rotorRps * 5, 2 + rpm * 2) * Math.PI * 2 * dt;
      m.tail.spin.rotation.y = this.tailVis;
      m.tail.blades.traverse((o) => { if (o.isMesh) o.material.opacity = bladeA; });
      m.tail.disc.material.opacity = discA * 0.8;
      m.tail.disc.visible = discA > 0.01;
    }
    if (ph.rotorBroken) {
      for (const r of m.rotors) r.blades.visible = false;
      if (m.tail) m.tail.blades.visible = false;
    } else {
      for (const r of m.rotors) r.blades.visible = true;
      if (m.tail) m.tail.blades.visible = true;
    }
    // searchlight follows the camera heading, aimed down towards the ground ahead
    if (m.searchlight) {
      const cam = this.camera;
      const lit = this.headlightsOn && !this.destroyed;
      if (this.isPlayerDriving()) {
        const yaw = cam.yaw + cam.orbitYaw;
        const pitch = THREE.MathUtils.clamp(-0.75 + cam.orbitPitch * 0.6, -1.45, -0.15);
        _v.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      } else _v.set(0, -0.8, -0.6).applyQuaternion(this.object3d.quaternion);
      _qi.copy(this.object3d.quaternion).invert();
      _v.applyQuaternion(_qi).normalize();
      this.slDir.lerp(_v, 1 - Math.exp(-dt * 4)).normalize();
      _q.setFromUnitVectors(FWD, this.slDir);
      m.searchlight.pivot.quaternion.copy(_q);
      this.cone.visible = lit && night > 0.15;
      this.cone.material.uniforms.uStrength.value = 0.22 * night;
      if (this.spot) this.spot.intensity = lit ? this.spotCfg.intensity * (0.3 + night) : 0;
    }
  }

  effects(dt) {
    const ph = this.physics;
    if (ph.rpm < 0.4 || ph.rotorBroken) return;
    const R = this.spec.rotor.radius;
    const agl = ph.agl;
    if (agl > R * 2.6) return;
    const k = (1 - agl / (R * 2.6)) * ph.rpm * ph.collective * 2;
    const p = this.object3d.position;
    const game = this.game;
    const gy = ph.groundY;
    const water = ph.overWater;
    const G = game.terrain.G;
    const cls = water ? G.water : game.terrain.groundAt(p.x, p.z);
    const dusty = cls === G.sand || cls === G.dirt || cls === G.farm;
    if (!water && !dusty && cls !== G.grass && cls !== G.wetland) return;
    this.fxAcc += dt * k * (water ? 70 : dusty ? 45 : 14);
    while (this.fxAcc > 1) {
      this.fxAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = R * (0.5 + Math.random() * 0.7);
      const cx = p.x + Math.cos(a) * r, cz = p.z + Math.sin(a) * r;
      const out = 6 + Math.random() * 6;
      if (water) this.spray.emit(Math.random() < 0.6 ? 'mist' : 'spray', cx, gy + 0.2, cz, Math.cos(a) * out, 0.8 + Math.random() * 2, Math.sin(a) * out, 1.2 + Math.random() * 1.5, 1.4, 0.45);
      else this.spray.emit('dust', cx, gy + 0.3, cz, Math.cos(a) * out, 0.5 + Math.random(), Math.sin(a) * out, 1.4 + Math.random() * 1.8, 1.8, dusty ? 0.45 : 0.18);
    }
  }
}

export const HELI_IDS = Object.keys(HELI_SPECS);
