// Fixed-wing Controllable: PlanePhysics + model with animated control surfaces, props, gear, lights and FX.
import * as THREE from 'three';
import { CraftVehicle } from './CraftVehicle.js';
import { PlanePhysics } from './physics/PlanePhysics.js';
import { PLANE_SPECS } from './specs.js';
import { buildPlaneModel, PLANE_LOOKS } from './models/planes.js';
import { makeEnv } from './env.js';
import { readPlane, pressed } from './controls.js';
import { shadeDisc } from './models/kit.js';
import { findRunways, nearestRunway, runwayStart, runwayDistance, surfaceY, nearestWater, obstacleTop } from './runways.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export const PLANE_SPEC_ID = { plane_trainer: 'pipit', plane_stunt: 'vortica', plane_seaplane: 'tarpon', plane_jet: 'solstice' };

const CAM = {
  plane_trainer: { kind: 'plane', dist: 15, height: 2.6, lookY: 1.0, fov: 60, speedRef: 60, pitch: -0.14 },
  plane_stunt: { kind: 'plane', dist: 12, height: 2.0, lookY: 0.8, fov: 62, speedRef: 85, pitch: -0.12 },
  plane_seaplane: { kind: 'plane', dist: 18, height: 3.0, lookY: 1.2, fov: 60, speedRef: 62, pitch: -0.14 },
  plane_jet: { kind: 'plane', dist: 30, height: 5, lookY: 2.0, fov: 60, speedRef: 200, pitch: -0.12 },
};

const SEATS = {
  plane_trainer: [[-0.3, 0.3, -0.45, -1.6, -1.25, -0.2], [0.3, 0.3, -0.45, 1.6, -1.25, -0.2]],
  plane_stunt: [[0, 0.35, 0.2, -1.6, -0.95, 0.4]],
  plane_seaplane: [[-0.32, 0.48, -0.5, -1.45, -1.25, -0.6], [0.32, 0.48, -0.5, 1.45, -1.25, -0.6], [-0.32, 0.48, 0.6, -1.45, -1.25, 0.6], [0.32, 0.48, 0.6, 1.45, -1.25, 0.6]],
  plane_jet: [[-0.45, 0.25, -6.5, -2.0, -1.4, -4.8], [0.45, 0.25, -6.5, -2.0, -1.4, -4.8], [-0.5, 0.2, -3.5, -2.0, -1.4, -4.8], [0.5, 0.2, -3.5, -2.0, -1.4, -4.8], [-0.5, 0.2, -1.5, -2.0, -1.4, -4.8], [0.5, 0.2, -1.5, -2.0, -1.4, -4.8]],
};

const FLAP_NOTCHES = [0, 0.5, 1];

export class Plane extends CraftVehicle {
  constructor(game, entry, pos, yaw = 0, opts = {}) {
    const spec = PLANE_SPECS[PLANE_SPEC_ID[entry.id]];
    const model = buildPlaneModel(entry.id, spec, opts);
    model.look = { ...PLANE_LOOKS[entry.id], ...(opts.color !== undefined ? { color: opts.color } : {}) };
    const physics = new PlanePhysics({ RAPIER: game.RAPIER, world: game.world, spec, position: { x: pos.x, y: (pos.y || 0) + spec.restHeight, z: pos.z }, yaw, env: makeEnv(game), state: { hold: 0 } });
    const seats = SEATS[entry.id].map(([x, y, z, ex, ey, ez]) => ({ pos: new THREE.Vector3(x, y, z), exit: new THREE.Vector3(ex, ey, ez), pose: 'plane' }));
    super(game, { entry, physics, model, camCfg: { ...CAM[entry.id], cockpit: model.cockpit }, seats, kind: 'plane', engineSound: spec.engine.type === 'jet' ? 'jet' : 'prop' });
    this.spec = spec;
    this.assist = true;
    this.flapIdx = 0;
    this.yoke = { x: 0, y: 0 };
    this.mouseYoke = false;
    this.smokeOn = false;
    this.seaplane = !!spec.float?.seaplane;
    this.propVis = model.props.map(() => 0);
    this.prevContact = physics.wheels.map(() => false);
    for (const p of model.props) p.spin.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; } });
    const L = model.landing;
    this.spotCfg = { pos: L, dir: [0, -0.1, -1], distance: 300, angle: 0.32, intensity: 160 };
    this.place(pos, yaw, opts);
  }

  /** Runway threshold (or the runway spot under pos), water for seaplanes, or airborne at 300 m with opts.air. */
  place(pos, yaw, opts = {}) {
    const game = this.game, spec = this.spec, ph = this.physics;
    const th = game.terrain.heightAt(pos.x, pos.z);
    if (opts.air) {
      const y = Math.max(th, 0, obstacleTop(game, pos.x, pos.z, 150)) + (opts.altitude ?? 300);
      ph.reset({ x: pos.x, y, z: pos.z }, yaw, { air: true, speed: spec.vTop * 0.62, throttle: 0.7 });
      this.flapIdx = 0;
      return;
    }
    if (this.seaplane && (opts.water !== false) && !opts.runway) {
      // open water with the longest take-off run ahead
      const w = nearestWater(game, pos.x, pos.z, -2.0, 4000, 1500);
      if (w) {
        const y = -spec.float.points[0][1] - spec.float.depth;
        ph.reset({ x: w.x, y, z: w.z }, w.yaw, { hold: 0 });
        return;
      }
    }
    let x = pos.x, z = pos.z, hdg = yaw;
    const rws = game.roads ? findRunways(game.roads) : [];
    const n = rws.length ? nearestRunway(rws, x, z) : null;
    if (n) {
      const rw = n.runway;
      const { d, t } = runwayDistance(rw, x, z);
      if (d < rw.w * 0.5 + 4 && !opts.forceThreshold) {
        // already on the runway: line up with it, facing the longer remaining stretch
        const fwd = t < rw.len / 2 ? 1 : -1;
        hdg = Math.atan2(-rw.dx * fwd, -rw.dz * fwd);
      } else {
        const s = runwayStart(rw, x, z);
        x = s.x; z = s.z; hdg = s.yaw;
      }
    }
    const y = surfaceY(game, x, z) + spec.restHeight + 0.05;
    ph.reset({ x, y, z }, hdg, { pitch: spec.restPitch, hold: 2.5 });
    this.flapIdx = 0;
  }

  readControls(inp) {
    const c = readPlane(inp, this.ctl, this.mouseYoke ? this.yoke : null);
    c.assist = this.assist;
    return c;
  }

  handleToggles(inp, dt = 1 / 60) {
    const ph = this.physics;
    if (pressed.assist(inp)) {
      this.assist = !this.assist;
      this.notify(this.assist ? 'air.flightAssistOn' : 'air.flightAssistOff', this.assist ? 'FLIGHT ASSIST ON' : 'FLIGHT ASSIST OFF');
    }
    if (!this.spec.noFlaps && (pressed.flaps(inp) || pressed.flapsUp(inp))) {
      const up = pressed.flapsUp(inp);
      this.flapIdx = up ? Math.max(0, this.flapIdx - 1) : (this.flapIdx + 1) % FLAP_NOTCHES.length;
      ph.setFlaps(FLAP_NOTCHES[this.flapIdx]);
      this.notify('air.flaps', 'FLAPS {n}', { n: [0, 1, 2][this.flapIdx] });
    }
    if (pressed.gear(inp) && this.spec.retract) {
      if (ph.toggleGear()) this.notify(ph.gearDown ? 'air.gearDown' : 'air.gearUp', ph.gearDown ? 'GEAR DOWN' : 'GEAR UP');
    }
    if (pressed.smoke(inp) && this.model.smoke) {
      this.smokeOn = !this.smokeOn;
      this.notify(this.smokeOn ? 'air.smokeOn' : 'air.smokeOff', this.smokeOn ? 'SMOKE ON' : 'SMOKE OFF');
    }
    // mouse yoke while the pointer is locked
    const m = inp.mouse;
    this.mouseYoke = !!m?.locked;
    if (this.mouseYoke) {
      this.yoke.x = THREE.MathUtils.clamp(this.yoke.x + m.dx * 0.004, -1, 1);
      this.yoke.y = THREE.MathUtils.clamp(this.yoke.y + m.dy * 0.004, -1, 1);
      const k = Math.exp(-dt * 2.2);
      this.yoke.x *= k; this.yoke.y *= k;
    }
  }

  animate(dt, alpha) {
    const ph = this.physics, m = this.model, s = m.surf, inp = ph.input;
    const ail = inp.roll * 0.35, elev = -inp.pitch * 0.35, rud = inp.yaw * 0.4, fl = ph.flaps * 0.6;
    if (s.ailL) s.ailL.inner.rotation.x = ail;
    if (s.ailR) s.ailR.inner.rotation.x = -ail;
    for (const e of s.elev) e.inner.rotation.x = elev;
    if (s.rudder) s.rudder.inner.rotation.y = rud;
    if (s.flapL) s.flapL.inner.rotation.x = fl;
    if (s.flapR) s.flapR.inner.rotation.x = fl;
    // propellers
    const thr = ph.thrAct;
    const lv = this.body.linvel();
    const v = Math.hypot(lv.x, lv.y, lv.z);
    const spinning = Math.min(1, (this.physics.destroyed ? 0 : 0.18 + thr * 0.82) + v / 120);
    const night = this.game.sky?.night ?? 0;
    m.props.forEach((p, i) => {
      shadeDisc(p.disc, night);
      this.propVis[i] += Math.min(spinning * 40, 1.6 + spinning * 3) * Math.PI * 2 * dt;
      p.spin.rotation.z = this.propVis[i];
      const blade = 1 - 0.85 * THREE.MathUtils.smoothstep(spinning, 0.15, 0.5);
      p.spin.traverse((o) => { if (o.isMesh) o.material.opacity = blade; });
      p.disc.material.opacity = THREE.MathUtils.smoothstep(spinning, 0.12, 0.45) * 0.5;
      p.disc.visible = p.disc.material.opacity > 0.01;
    });
    // landing gear: suspension, wheel spin, steering, retraction
    const gp = ph.gearPos;
    m.gear.forEach((g, i) => {
      const w = ph.wheels[i];
      if (!w) return;
      const dist = w.prevDist + (w.dist - w.prevDist) * alpha;
      g.axle.position.y = -dist;
      g.strut.scale.y = Math.max(0.05, dist);
      g.spin.rotation.x = -(w.prevSpin + (w.spin - w.prevSpin) * alpha);
      if (w.steer) g.axle.rotation.y = -ph.steerAngle * (w.steer < 0 ? -1 : 1);
      if (g.retract) {
        const a = (1 - gp) * g.retract.angle;
        g.fold.rotation.set(g.retract.axis === 'x' ? a : 0, 0, g.retract.axis === 'z' ? a : 0);
        g.mount.visible = gp > 0.03;
      }
    });
  }

  effects(dt) {
    const ph = this.physics, o = this.object3d, tel = this.telemetry;
    const lv = this.body.linvel();
    const v = Math.hypot(lv.x, lv.y, lv.z);
    // tyre smoke on touchdown
    ph.wheels.forEach((w, i) => {
      if (w.contact && !this.prevContact[i] && v > 15) {
        for (let k = 0; k < 10; k++) this.spray.emit('mist', w.point.x, w.point.y + 0.2, w.point.z, lv.x * 0.3 + (Math.random() - 0.5) * 2, 0.6 + Math.random(), lv.z * 0.3 + (Math.random() - 0.5) * 2, 0.8, 1.2, 0.5);
        this.game.events.emit('impact', { position: { x: w.point.x, y: w.point.y, z: w.point.z }, strength: Math.min(0.4, Math.abs(lv.y) * 0.08), kind: 'vehicle', material: 'rubber', source: this });
      }
      this.prevContact[i] = w.contact;
    });
    // wingtip vortices in hard manoeuvres
    if (v > 45 && Math.abs(tel.gForce) > 3.2) {
      for (const l of [this.model.lights.navL[0], this.model.lights.navR[0]]) {
        l.getWorldPosition(_v);
        this.spray.emit('mist', _v.x, _v.y, _v.z, lv.x * 0.6, lv.y * 0.6, lv.z * 0.6, 0.35, 0.5, 0.35);
      }
    }
    // stunt smoke
    if (this.smokeOn && this.model.smoke && v > 8 && !ph.destroyed) {
      this.fxAcc += dt * 40;
      const sm = this.model.smoke;
      while (this.fxAcc > 1) {
        this.fxAcc -= 1;
        _v.set(sm[0], sm[1], sm[2]).applyQuaternion(o.quaternion).add(o.position);
        this.spray.emit('trail', _v.x, _v.y, _v.z, lv.x * 0.15 + (Math.random() - 0.5), lv.y * 0.15 + (Math.random() - 0.5), lv.z * 0.15 + (Math.random() - 0.5), 1.2, 7, 0.7);
      }
    }
    // floats on water: wake + bow spray
    if (this.seaplane && tel.onWater && v > 1.5) {
      for (const sgn of [-1, 1]) {
        _v.set(sgn * 1.45, 0, 2.6).applyQuaternion(o.quaternion).add(o.position);
        _w.set(0, 0, -1).applyQuaternion(o.quaternion);
        this.spray.foam.add(this.uid * 10 + (sgn > 0 ? 1 : 2), _v.x, 0.03, _v.z, _w.x, _w.z, 0.45, Math.min(0.9, v / 15));
        if (v > 6 && Math.random() < dt * v * 2) {
          _v.set(sgn * 1.45, -1.6, -2.4).applyQuaternion(o.quaternion).add(o.position);
          this.spray.emit('spray', _v.x, Math.max(_v.y, 0.1), _v.z, lv.x * 0.4 + sgn * 2.5 * _w.z, 1.5 + Math.random() * 2, lv.z * 0.4 - sgn * 2.5 * _w.x, 0.5, 0.9, 0.7);
        }
      }
    } else if (this.seaplane) { this.spray.foam.end(this.uid * 10 + 1); this.spray.foam.end(this.uid * 10 + 2); }
  }

  dispose() {
    this.spray.foam.remove(this.uid * 10 + 1);
    this.spray.foam.remove(this.uid * 10 + 2);
    super.dispose();
  }
}

export const PLANE_IDS = Object.keys(PLANE_SPEC_ID);
