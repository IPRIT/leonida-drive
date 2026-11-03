// Chase / far / cockpit camera for aircraft and boats. One instance per game, configured by the vehicle's camCfg:
// { kind: 'heli'|'plane'|'boat', dist, height, lookY, fov, speedRef, cockpit: [x,y,z] }.
// Angles are smoothed (not world positions), so fast jets never lag behind; orbit with mouse drag,
// pointer-lock mouse or the right stick; C cycles modes. Keeps clear of terrain, water and buildings.
import * as THREE from 'three';
import { GROUPS, groups } from '../vehicle/groups.js';

const MODES = ['chase', 'far', 'cockpit'];
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const dampAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function noise1(t) { return Math.sin(t * 1.7) * 0.5 + Math.sin(t * 3.1 + 1.3) * 0.3 + Math.sin(t * 5.3 + 2.1) * 0.2; }

const _cams = new WeakMap();

export class AirCamera {
  static get(game) {
    let c = _cams.get(game);
    if (!c) { c = new AirCamera(game); _cams.set(game, c); }
    return c;
  }

  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.dom = game.renderer?.domElement || null;
    this.mode = 'chase';
    this.yaw = 0;
    this.pitch = -0.15;
    this.dist = 10;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.idle = 10;
    this.shakeT = 0;
    this.shakeAmt = 0;
    this.lastImpact = 0;
    this.fov = 60;
    this.vehicle = null;
    this.ray = game.RAPIER ? new game.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) : null;
    this.rayGroups = groups(0xffff, GROUPS.STATIC);
    if (this.dom) {
      this._down = (e) => { if (e.button === 0 || e.button === 2) { this.drag = true; this.lx = e.clientX; this.ly = e.clientY; } };
      this._move = (e) => {
        if (!this.drag) return;
        const dx = e.clientX - this.lx, dy = e.clientY - this.ly;
        this.lx = e.clientX; this.ly = e.clientY;
        this.orbit(dx, dy);
      };
      this._up = () => { this.drag = false; };
      this.dom.addEventListener('pointerdown', this._down);
      window.addEventListener('pointermove', this._move);
      window.addEventListener('pointerup', this._up);
    }
  }

  orbit(dx, dy) {
    if (!dx && !dy) return;
    this.orbitYaw -= dx * 0.005;
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch - dy * 0.004, -1.1, 1.0);
    this.idle = 0;
  }

  nextMode() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    return this.mode;
  }

  /** Heading/pitch the chase camera wants for this vehicle. */
  _target(v, out) {
    const cfg = v.camCfg;
    const o = v.object3d;
    _f.set(0, 0, -1).applyQuaternion(o.quaternion);
    const lv = v.body.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    const hs = Math.hypot(lv.x, lv.z);
    let yaw = Math.atan2(-_f.x, -_f.z);
    let pitch = cfg.pitch ?? -0.16;
    if (cfg.kind === 'plane') {
      if (sp > 12) {
        _d.set(lv.x / sp, lv.y / sp, lv.z / sp).lerp(_f, 0.45).normalize();
        yaw = Math.atan2(-_d.x, -_d.z);
        pitch += Math.asin(THREE.MathUtils.clamp(_d.y, -1, 1)) * 0.75;
      } else if (Math.abs(_f.y) > 0.98) yaw = this.yaw;
    } else if (hs > 6) {
      const vy = Math.atan2(-lv.x, -lv.z);
      const diff = Math.atan2(Math.sin(vy - yaw), Math.cos(vy - yaw));
      if (Math.abs(diff) < 2.2) yaw += diff * (cfg.kind === 'heli' ? 0.35 : 0.5) * smooth(6, 25, hs);
    }
    out.yaw = yaw;
    out.pitch = pitch;
    out.speed = sp;
    return out;
  }

  snap(v) {
    this.vehicle = v;
    v.updateVisual?.(1, 0);
    const t = this._target(v, {});
    this.yaw = t.yaw;
    this.pitch = t.pitch;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.dist = v.camCfg.dist;
    this.lastImpact = v.telemetry.impactId;
    this.update(0, v, true);
  }

  update(dt, v, snapping = false) {
    if (!v) return;
    dt = Math.min(dt, 0.1);
    const game = this.game;
    const cam = this.camera;
    const cfg = v.camCfg;
    if (v !== this.vehicle) { this.vehicle = v; if (!snapping) this.snap(v); return; }
    const inp = game.input;
    if (!snapping && !game.paused && inp) {
      if (inp.pressed('KeyC')) this.nextMode();
      const locked = inp.mouse?.locked;
      if (locked && !v.mouseYoke) this.orbit(inp.mouse.dx, inp.mouse.dy);
      const rx = inp.axis ? inp.axis(2) : 0, ry = inp.axis ? inp.axis(3) : 0;
      if (rx || ry) this.orbit(rx * dt * 600, ry * dt * 400);
    }
    this.idle += dt;
    if (this.idle > 10 && !this.drag) { // recenter only after 10 s without camera input
      const k = 1 - Math.exp(-dt * 1.8);
      this.orbitYaw = dampAngle(this.orbitYaw, 0, k);
      this.orbitPitch += (0 - this.orbitPitch) * k;
    }
    const o = v.object3d;
    const tel = v.telemetry;
    if (tel.impactId !== this.lastImpact) {
      this.lastImpact = tel.impactId;
      this.shakeAmt = Math.min(1.5, this.shakeAmt + 0.3 + (tel.impactStrength || 0) * 1.2);
    }
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.6);
    this.shakeT += dt;

    const tgt = this._target(v, {});
    const sp = tgt.speed;
    let fovT = cfg.fov + 12 * smooth(cfg.speedRef * 0.2, cfg.speedRef, sp);
    if (this.mode === 'cockpit') {
      const c = cfg.cockpit;
      _v.set(c[0], c[1], c[2]);
      o.localToWorld(_v);
      cam.position.copy(_v);
      _e.set(this.orbitPitch * 0.9, this.orbitYaw, 0);
      _q.setFromEuler(_e);
      cam.quaternion.copy(o.quaternion).multiply(_q);
      fovT += 8;
    } else {
      const k = snapping ? 1 : 1 - Math.exp(-dt * (cfg.kind === 'plane' ? 3.2 : cfg.kind === 'heli' ? 2.4 : 2.8));
      this.yaw = dampAngle(this.yaw, tgt.yaw, k);
      this.pitch += (tgt.pitch - this.pitch) * k;
      const far = this.mode === 'far' ? 1.75 : 1;
      const distT = cfg.dist * far * (1 + 0.45 * smooth(0, cfg.speedRef, sp));
      this.dist += (distT - this.dist) * (snapping ? 1 : 1 - Math.exp(-dt * 2));
      const yaw = this.yaw + this.orbitYaw;
      const pitch = THREE.MathUtils.clamp(this.pitch + this.orbitPitch, -1.35, 1.2);
      _d.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const P = o.position;
      _t.set(P.x, P.y + cfg.lookY, P.z);
      const lv = v.body.linvel();
      const ahead = Math.min(cfg.dist * 0.6, sp * 0.08);
      if (sp > 1) _t.addScaledVector(_v.set(lv.x / sp, lv.y / sp, lv.z / sp), ahead);
      let dist = this.dist;
      // building occlusion
      if (this.ray && game.world) {
        _v.copy(_d).negate();
        this.ray.origin = { x: _t.x, y: _t.y, z: _t.z };
        this.ray.dir = { x: _v.x, y: _v.y, z: _v.z };
        const hit = game.world.castRay(this.ray, dist + 1, true, undefined, this.rayGroups);
        if (hit && hit.timeOfImpact < dist + 0.5) dist = Math.max(2.5, hit.timeOfImpact - 0.6);
      }
      cam.position.set(_t.x - _d.x * dist, _t.y - _d.y * dist + cfg.height * (this.mode === 'far' ? 1.4 : 1), _t.z - _d.z * dist);
      // terrain / water clearance
      const th = game.roads?.tunnelFloorAt?.(cam.position.x, cam.position.z) ?? (game.terrain ? game.terrain.heightAt(cam.position.x, cam.position.z) : -1e9);
      const floor = Math.max(th + 1.2, 0.5);
      if (cam.position.y < floor) cam.position.y = floor;
      cam.lookAt(_t);
    }
    this.fov += (fovT - this.fov) * (snapping ? 1 : 1 - Math.exp(-dt * 2.5));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    // shake: impacts, rotor/engine rumble, stall buffet
    const rumble = (tel.rotorRpm ? tel.rotorRpm * 0.12 : 0) + (tel.stall ? 0.5 : 0) + (tel.planing ? 0.1 * Math.min(1, sp / 25) : 0);
    const amt = this.shakeAmt + rumble * (this.mode === 'cockpit' ? 1 : 0.4);
    if (amt > 0.001) {
      const t = this.shakeT * 11;
      cam.rotateX(noise1(t) * 0.006 * amt);
      cam.rotateY(noise1(t + 17.3) * 0.005 * amt);
      cam.rotateZ(noise1(t + 41.1) * 0.004 * amt);
    }
  }

  dispose() {
    if (!this.dom) return;
    this.dom.removeEventListener('pointerdown', this._down);
    window.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    _cams.delete(this.game);
  }
}
