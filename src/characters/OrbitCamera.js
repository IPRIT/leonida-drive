// Third-person on-foot camera: mouse (pointer lock or drag) / right stick orbit, over-the-shoulder offset,
// collision against buildings and terrain, soft auto-follow while running.
import * as THREE from 'three';
import { GROUPS, groups } from '../vehicle/groups.js';

const DIST = [2.4, 3.5, 5.4];
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _look = new THREE.Vector3();

export class OrbitCamera {
  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.yaw = 0;
    this.pitch = 0.22; // elevation, + = above looking down
    this.mode = 1;
    this.dist = DIST[1];
    this.shoulder = 0.42;
    this.pivot = new THREE.Vector3();
    this.pos = new THREE.Vector3();
    this.idle = 10;
    this.fov = 60;
    this.zoom = 0;
    this._ray = new game.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this._mask = groups(0xffff, GROUPS.STATIC | GROUPS.GROUND | GROUPS.VEHICLE);
    this._snapped = false;
    this.len = 3;
  }

  nextMode() { this.mode = (this.mode + 1) % DIST.length; return this.mode; }

  snap(target, yaw) {
    this.yaw = yaw;
    this.pitch = 0.22;
    this.pivot.copy(target);
    this._snapped = false;
  }

  // mouse/stick look input; returns true if the player moved the camera this frame
  look(dt) {
    const inp = this.game.input;
    const s = this.game.settings || {};
    const sens = 0.0024 * (s.camSens ?? 1);
    const inv = s.invertY ? -1 : 1;
    let used = false;
    const m = inp.mouse;
    if (m && (m.locked || inp.held('Mouse2') || inp.held('Mouse0')) && (m.dx || m.dy)) {
      this.yaw -= m.dx * sens;
      this.pitch += m.dy * sens * inv;
      used = true;
    }
    const rx = inp.axis?.(2) || 0, ry = inp.axis?.(3) || 0;
    if (rx || ry) {
      this.yaw -= rx * dt * 3.0 * (s.camSens ?? 1);
      this.pitch += ry * dt * 1.8 * inv * (s.camSens ?? 1);
      used = true;
    }
    if (m?.wheel) { this.zoom = THREE.MathUtils.clamp(this.zoom + m.wheel * 0.4, -1, 3); }
    this.pitch = THREE.MathUtils.clamp(this.pitch, -0.75, 1.25);
    if (used) this.idle = 0; else this.idle += dt;
    return used;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} target head-height pivot of the character
   * @param {{moving?:boolean, yaw?:number, sprint?:boolean, swim?:boolean, exclude?:object}} st  exclude: rigid body ignored by camera collision
   */
  update(dt, target, st = {}) {
    const k = this._snapped ? 1 - Math.exp(-dt * 16) : 1;
    this.pivot.lerp(target, k);
    this._snapped = true;
    if (st.moving && this.idle > 10 && st.yaw !== undefined) { // recenter only after 10 s without camera input
      // drift behind the character when running without touching the camera
      const d = Math.atan2(Math.sin(st.yaw - this.yaw), Math.cos(st.yaw - this.yaw));
      if (Math.abs(d) < 2.4) this.yaw += d * Math.min(1, dt * 0.9);
    }
    const dist = Math.max(1.4, DIST[this.mode] + this.zoom + (st.sprint ? 0.5 : 0) + (st.swim ? 0.8 : 0));
    this.dist += (dist - this.dist) * Math.min(1, dt * 4);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // over-the-shoulder: shift the pivot to the right of the view
    const sh = this.shoulder * (this.mode === 2 ? 0.4 : 1);
    _look.set(this.pivot.x + cy * sh, this.pivot.y, this.pivot.z - sy * sh);
    _d.set(sy * cp, sp, cy * cp);
    let len = this.dist;
    // collision: from the character's head towards the camera
    const ray = this._ray;
    ray.origin = { x: _look.x, y: _look.y, z: _look.z };
    ray.dir = { x: _d.x, y: _d.y, z: _d.z };
    const hit = this.game.world.castRay(ray, len + 0.3, true, undefined, this._mask, undefined, st.exclude);
    if (hit) len = Math.max(0.35, hit.timeOfImpact - 0.3);
    this.len = len;
    this.pos.copy(_look).addScaledVector(_d, len);
    // inside a tunnel the ground is the tube floor, not the hill on top of it
    const gh = this.game.roads?.tunnelFloorAt?.(this.pos.x, this.pos.z) ?? Math.max(this.game.terrain.heightAt(this.pos.x, this.pos.z), -0.6);
    if (this.pos.y < gh + 0.25) this.pos.y = gh + 0.25;
    const cam = this.camera;
    cam.position.copy(this.pos);
    _v.copy(_look);
    _v.y -= 0.05 + sp * 0.2;
    cam.lookAt(_v);
    const fov = 58 + (st.sprint ? 6 : 0);
    this.fov += (fov - this.fov) * Math.min(1, dt * 3);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }
}
