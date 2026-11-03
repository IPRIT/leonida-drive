// Aiming camera for tanks (one per game): free orbit around the tank that is also the gun sight. The screen centre
// is the aim point; the turret follows it at its own slew rate. Modes: 'third' (orbit) and 'sight' (gunner's sight,
// zoomed). Input: pointer-lock mouse or mouse drag, right stick (also the touch fallback), wheel = distance,
// C = mode, look(dx, dy) for touch / external controls.
import * as THREE from 'three';
import { GROUPS, groups } from '../groups.js';

const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dampAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const noise1 = (t) => Math.sin(t * 1.7) * 0.5 + Math.sin(t * 3.1 + 1.3) * 0.3 + Math.sin(t * 5.3 + 2.1) * 0.2;
const cams = new WeakMap();

export class TankCamera {
  static get(game) {
    let c = cams.get(game);
    if (!c) { c = new TankCamera(game); cams.set(game, c); }
    return c;
  }

  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.dom = game.renderer?.domElement || null;
    this.mode = 'third';
    this.yaw = 0;
    this.pitch = -0.04;
    this.dist = 13;
    this.distT = 13;
    this.fov = 60;
    this.shakeAmt = 0;
    this.shakeT = 0;
    this.lastImpact = 0;
    this.vehicle = null;
    this.aim = new THREE.Vector3();
    this.aimDist = 600;
    this.aimHit = false;
    this.dir = new THREE.Vector3(0, 0, -1);
    this.pivot = new THREE.Vector3();
    this.idle = 10; // seconds since the last aim input (auto-follow behind the hull after a while)
    const R = game.RAPIER;
    this.ray = R ? new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) : null;
    this.wallGroups = groups(0xffff, GROUPS.STATIC);
    this.aimGroups = groups(0xffff, GROUPS.GROUND | GROUPS.STATIC | GROUPS.VEHICLE | GROUPS.TRAFFIC | GROUPS.PROP);
    this._offs = [];
    if (game.events) this._offs.push(game.events.on('camera:shake', (p) => { if (this.active) this.shakeAmt = Math.min(1.6, this.shakeAmt + (p?.amount ?? 0.3)); }));
    if (this.dom && typeof window !== 'undefined') {
      this._down = (e) => {
        if (e.pointerType === 'touch') return; // touch drag goes through the mobile layer (look / right stick)
        if (e.button === 0 || e.button === 2) { this.drag = true; this.lx = e.clientX; this.ly = e.clientY; }
      };
      this._move = (e) => {
        if (!this.drag || !this.active || document.pointerLockElement === this.dom) return;
        const dx = e.clientX - this.lx, dy = e.clientY - this.ly;
        this.lx = e.clientX; this.ly = e.clientY;
        this.look(dx, dy);
      };
      this._up = () => { this.drag = false; };
      this.dom.addEventListener('pointerdown', this._down);
      window.addEventListener('pointermove', this._move);
      window.addEventListener('pointerup', this._up);
    }
  }

  /** The player is driving a tank with this camera. */
  get active() {
    const p = this.game.player;
    return !!p && p.mode === 'vehicle' && p.controllable?.camera === this;
  }

  /** Rotate the aim by screen pixels (mouse / touch drag). */
  look(dx, dy) {
    const s = (this.game.settings?.camSens ?? 1) * (this.mode === 'sight' ? 0.35 : 1);
    const inv = this.game.settings?.invertY ? -1 : 1;
    this.yaw -= dx * 0.0032 * s;
    this.pitch = clamp(this.pitch - dy * 0.0028 * s * inv, -0.62, 0.7);
    if (dx || dy) this.idle = 0;
  }

  nextMode() {
    this.mode = this.mode === 'third' ? 'sight' : 'third';
    return this.mode;
  }

  snap(v) {
    this.vehicle = v;
    v.updateVisual?.(1, 0);
    _d.set(0, 0, -1).applyQuaternion(v.object3d.quaternion);
    this.yaw = Math.atan2(-_d.x, -_d.z) + (v.turretYaw || 0);
    this.pitch = -0.09;
    this.dist = this.distT;
    this.idle = 10;
    this.pivot.copy(v.object3d.position);
    this.lastImpact = v.telemetry?.impactId ?? 0;
    this.update(0, v, true);
  }

  update(dt, v, snapping = false) {
    if (!v) return;
    dt = Math.min(dt, 0.1);
    if (v !== this.vehicle) { this.vehicle = v; if (!snapping) { this.snap(v); return; } }
    const game = this.game, cam = this.camera, inp = game.input;
    if (!snapping && inp && !game.paused && !game.ui?.isOpen) {
      if (inp.pressed('KeyC')) this.nextMode();
      if (inp.mouse?.locked && (inp.mouse.dx || inp.mouse.dy)) this.look(inp.mouse.dx, inp.mouse.dy);
      const rx = inp.axis ? inp.axis(2) : 0, ry = inp.axis ? inp.axis(3) : 0;
      if (rx || ry) this.look(rx * dt * 620, ry * dt * 430);
      if (inp.mouse?.wheel) this.distT = clamp(this.distT * (1 + inp.mouse.wheel * 0.12), 7, 26);
    }
    const tel = v.telemetry || {};
    if (tel.impactId !== this.lastImpact) {
      this.lastImpact = tel.impactId;
      this.shakeAmt = Math.min(1.6, this.shakeAmt + 0.15 + (tel.impactStrength || 0) * 0.8);
    }
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.8);
    this.shakeT += dt;
    this.idle += dt;
    // keyboard-only driving: after 1.6 s without aim input the view eases in behind the hull while it moves
    // (rate-limited, no lead, so hull corrections never swing the camera abruptly)
    const vF = tel.forwardSpeed || 0;
    if (!snapping && this.mode === 'third' && this.idle > 1.6 && Math.abs(vF) > 2.5) {
      _d.set(0, 0, -1).applyQuaternion(v.object3d.quaternion);
      const k = (1 - Math.exp(-dt * 1.1)) * smooth(2.5, 7, Math.abs(vF)) * smooth(1.6, 3, this.idle);
      this.yaw = dampAngle(this.yaw, Math.atan2(-_d.x, -_d.z), k);
      this.pitch += (-0.09 - this.pitch) * k * 0.5;
    }
    // pivot: rigid in the ground plane, softened vertically so suspension bounce doesn't shake the view
    const P0 = v.object3d.position;
    if (snapping) this.pivot.copy(P0);
    else {
      const kv = 1 - Math.exp(-dt * 7);
      this.pivot.x = P0.x;
      this.pivot.z = P0.z;
      this.pivot.y += (P0.y - this.pivot.y) * kv;
      if (Math.abs(P0.y - this.pivot.y) > 3) this.pivot.y = P0.y;
    }

    const cp = Math.cos(this.pitch);
    const dir = this.dir.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    const P = this.pivot;
    const baseFov = game.settings?.fov ?? 60;
    let fovT = baseFov;
    if (this.mode === 'sight' && v.sightWorld) {
      v.sightWorld(_v);
      cam.position.copy(_v);
      fovT = 24;
    } else {
      this.dist += (this.distT - this.dist) * (snapping ? 1 : 1 - Math.exp(-dt * 6));
      _t.set(P.x, P.y + 2.4, P.z); // body origin is ~0.9 m above the ground
      let dist = this.dist;
      if (this.ray && game.world) {
        this.ray.origin = { x: _t.x, y: _t.y, z: _t.z };
        this.ray.dir = { x: -dir.x, y: -dir.y, z: -dir.z };
        const hit = game.world.castRay(this.ray, dist + 1, true, undefined, this.wallGroups);
        if (hit && hit.timeOfImpact < dist + 0.5) dist = Math.max(2.5, hit.timeOfImpact - 0.6);
      }
      const lift = 0.9 + dist * 0.06;
      cam.position.set(_t.x - dir.x * dist, _t.y - dir.y * dist + lift, _t.z - dir.z * dist);
      const th = game.terrain ? game.terrain.heightAt(cam.position.x, cam.position.z) : -1e9;
      const floor = Math.max(th + 0.8, (game.vehicles?.env?.waterLevel ?? 0) + 0.4);
      if (cam.position.y < floor) cam.position.y = floor;
    }
    cam.lookAt(_v.copy(cam.position).add(dir));
    this.fov += (fovT - this.fov) * (snapping ? 1 : 1 - Math.exp(-dt * 8));
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }

    // aim point: what the screen centre looks at (the turret follows it)
    this.aimHit = false;
    this.aimDist = 700;
    if (this.ray && game.world) {
      this.ray.origin = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
      const hit = game.world.castRay(this.ray, 1500, true, undefined, this.aimGroups, undefined, v.body);
      if (hit && hit.timeOfImpact > 2) { this.aimDist = hit.timeOfImpact; this.aimHit = true; }
    }
    if (!this.aimHit && game.terrain && dir.y < -0.01) {
      // march the terrain height field where there are no colliders
      for (let s = 20; s < 1500; s *= 1.25) {
        _v.copy(cam.position).addScaledVector(dir, s);
        if (_v.y < game.terrain.heightAt(_v.x, _v.z)) { this.aimDist = s; this.aimHit = true; break; }
      }
    }
    this.aim.copy(cam.position).addScaledVector(dir, this.aimDist);
    (v.aimPoint ||= new THREE.Vector3()).copy(this.aim);

    // shake: impacts, firing, explosions only (no speed rumble: it read as twitchy steering)
    const amt = this.shakeAmt;
    if (amt > 0.001 && !snapping) {
      const t = this.shakeT * 13;
      cam.rotateX(noise1(t) * 0.007 * amt);
      cam.rotateY(noise1(t + 17.3) * 0.006 * amt);
      cam.rotateZ(noise1(t + 41.1) * 0.004 * amt);
    }
  }

  shake(amount = 0.3) {
    this.shakeAmt = Math.min(1.6, this.shakeAmt + amount);
  }

  dispose() {
    for (const off of this._offs) off();
    if (this.dom) {
      this.dom.removeEventListener('pointerdown', this._down);
      window.removeEventListener('pointermove', this._move);
      window.removeEventListener('pointerup', this._up);
    }
    cams.delete(this.game);
  }
}
