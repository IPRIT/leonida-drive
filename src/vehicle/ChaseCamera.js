// GTA-style chase camera with orbit override, speed FOV, shake and several modes.
import * as THREE from 'three';

const MODES = ['chase', 'far', 'hood', 'cinematic'];
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// critically damped spring (Unity-style SmoothDamp) per component
function damp(cur, target, vel, smooth, dt) {
  const omega = 2 / Math.max(1e-4, smooth);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}
const dampAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
// camera distance scale: long/tall vehicles (trucks, buses) further, bikes closer
const sizeScale = (v) => {
  const sz = v.spec?.size;
  if (!sz) return 1;
  const k = Math.max(sz.length / 4.6, sz.height / 1.45);
  return v.spec.twoWheel ? THREE.MathUtils.clamp(k, 0.75, 1) : THREE.MathUtils.clamp(k, 1, 3);
};

// cheap smooth noise
function noise1(t) {
  return Math.sin(t * 1.7) * 0.5 + Math.sin(t * 3.1 + 1.3) * 0.3 + Math.sin(t * 5.3 + 2.1) * 0.2;
}

export class ChaseCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} [domElement] for mouse-drag orbit
   * @param {{getGroundHeight?:(x:number,z:number)=>number, raycast?:(origin:THREE.Vector3, dir:THREE.Vector3, maxDist:number)=>number|null, input?:object}} [opts]
   */
  constructor(camera, domElement, opts = {}) {
    this.camera = camera;
    this.dom = domElement || null;
    this.getGroundHeight = opts.getGroundHeight || null;
    this.raycast = opts.raycast || null;
    this.input = opts.input || null; // DriveInput for right-stick orbit
    this.enabled = true;
    this.mode = 'chase';
    this.baseFov = 60;
    this.maxFov = 78;
    this.shakeAmount = 1;
    this.lookBack = false;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._vx = { v: 0 }; this._vy = { v: 0 }; this._vz = { v: 0 };
    this._lx = { v: 0 }; this._ly = { v: 0 }; this._lz = { v: 0 };
    this._heading = 0;
    this._orbitYaw = 0;
    this._orbitPitch = 0;
    this._orbitIdle = 10;
    this._dragging = false;
    this._shake = 0;
    this._t = 0;
    this._lastImpact = 0;
    this._fov = this.baseFov;
    this._dist = 6;
    this._cine = { pos: new THREE.Vector3(), timer: 0, kind: 0, angle: 0 };
    this._snapped = false;

    if (this.dom) {
      this._onDown = (e) => {
        if (e.button === 0 || e.button === 2) {
          this._dragging = true;
          this._lastX = e.clientX;
          this._lastY = e.clientY;
        }
      };
      this._onMove = (e) => {
        if (!this._dragging) return;
        const dx = e.clientX - this._lastX, dy = e.clientY - this._lastY;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        if (Math.abs(dx) + Math.abs(dy) > 0) {
          this._orbitYaw -= dx * 0.006;
          this._orbitPitch = THREE.MathUtils.clamp(this._orbitPitch + dy * 0.004, -0.35, 0.9);
          this._orbitIdle = 0;
        }
      };
      this._onUp = () => (this._dragging = false);
      this._onCtx = (e) => e.preventDefault();
      this.dom.addEventListener('pointerdown', this._onDown);
      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
      this.dom.addEventListener('contextmenu', this._onCtx);
    }
  }

  nextMode() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this._cine.timer = 0;
    this._snapped = false;
    return this.mode;
  }

  setMode(m) {
    if (MODES.includes(m)) {
      this.mode = m;
      this._cine.timer = 0;
      this._snapped = false;
    }
  }

  /** Add an external shake impulse (0..1). */
  shake(amount) {
    this._shake = Math.min(1.5, this._shake + amount);
  }

  _carFrame(vehicle) {
    const o = vehicle.object3d;
    _fwd.set(0, 0, -1).applyQuaternion(o.quaternion);
    const lv = vehicle.body.linvel();
    _vel.set(lv.x, lv.y, lv.z);
    return o.position;
  }

  /** Teleport camera behind the vehicle (after reset/teleport). */
  snap(vehicle) {
    const p = this._carFrame(vehicle);
    this._heading = Math.atan2(-_fwd.x, -_fwd.z);
    this._orbitYaw = 0;
    this._orbitPitch = 0;
    this._snapped = false;
    this._computeTarget(vehicle, p, 1 / 60, true);
    this._pos.copy(this._targetPos);
    this._look.copy(this._targetLook);
    this._vx.v = this._vy.v = this._vz.v = this._lx.v = this._ly.v = this._lz.v = 0;
    this._apply(0);
    this._snapped = true;
  }

  _computeTarget(vehicle, p, dt, snap) {
    const tel = vehicle.telemetry;
    const speed = Math.hypot(_vel.x, _vel.z);
    const carHeading = Math.atan2(-_fwd.x, -_fwd.z);
    // follow heading: blend of car facing and velocity direction (looks into slides)
    let target = carHeading;
    if (speed > 4 && !tel.reversing) {
      const velHeading = Math.atan2(-_vel.x, -_vel.z);
      const diff = Math.atan2(Math.sin(velHeading - carHeading), Math.cos(velHeading - carHeading));
      if (Math.abs(diff) < 1.7) target = carHeading + diff * 0.55;
    }
    if (snap) this._heading = target;
    else this._heading = dampAngle(this._heading, target, 1 - Math.exp(-dt * (tel.airborne ? 1.2 : 3.2)));
    const sp = THREE.MathUtils.clamp(speed / 70, 0, 1);
    const far = this.mode === 'far';
    const dist = (far ? 8.6 : 5.6) + sp * (far ? 2.6 : 1.8);
    const height = (far ? 2.8 : 1.75) + sp * 0.25;
    this._dist = dist;
    // orbit: drag/stick override, auto-return only after 10 s without camera input
    if (this.input && this.input.rightStick) {
      const rs = this.input.rightStick();
      if (Math.abs(rs.x) + Math.abs(rs.y) > 0) {
        this._orbitYaw -= rs.x * dt * 2.6;
        this._orbitPitch = THREE.MathUtils.clamp(this._orbitPitch + rs.y * dt * 1.4, -0.35, 0.9);
        this._orbitIdle = 0;
      }
    }
    this._orbitIdle += dt;
    if (!this._dragging && this._orbitIdle > 10) {
      const k = 1 - Math.exp(-dt * 2.5);
      this._orbitYaw = dampAngle(this._orbitYaw, 0, k);
      this._orbitPitch += (0 - this._orbitPitch) * k;
    }
    const yaw = this._heading + this._orbitYaw + (this.lookBack ? Math.PI : 0);
    const pitchOff = this._orbitPitch * dist;
    const scale = sizeScale(vehicle);
    this._targetPos = (this._targetPos || new THREE.Vector3()).set(
      p.x + Math.sin(yaw) * dist * scale,
      p.y + (height + pitchOff * 0.6) * scale,
      p.z + Math.cos(yaw) * dist * scale,
    );
    // look slightly ahead in the velocity direction
    const ahead = THREE.MathUtils.clamp(speed * 0.05, 0, 3.5);
    const vn = speed > 0.5 ? _v2.set(_vel.x / speed, 0, _vel.z / speed) : _v2.set(-Math.sin(this._heading), 0, -Math.cos(this._heading));
    this._targetLook = (this._targetLook || new THREE.Vector3()).set(p.x + vn.x * ahead, p.y + 0.9 * scale, p.z + vn.z * ahead);
  }

  _apply(dt) {
    const cam = this.camera;
    cam.position.copy(this._pos);
    cam.lookAt(this._look);
  }

  /**
   * @param {number} dt frame delta
   * @param {Vehicle} vehicle
   */
  update(dt, vehicle) {
    if (!this.enabled || !vehicle) return;
    dt = Math.min(dt, 0.1);
    this._t += dt;
    const p = this._carFrame(vehicle);
    const tel = vehicle.telemetry;
    const speed = Math.hypot(_vel.x, _vel.z);
    if (!this._snapped) this.snap(vehicle);

    if (tel.impactId !== this._lastImpact) {
      this._lastImpact = tel.impactId;
      this.shake(0.25 + tel.impactStrength * 1.2);
    }
    this._shake = Math.max(0, this._shake - dt * 1.8);

    let fovTarget = this.baseFov + (this.maxFov - this.baseFov) * THREE.MathUtils.smoothstep(speed, 8, 75);
    if (tel.boosting) fovTarget += 5;

    if (this.mode === 'hood') {
      const o = vehicle.object3d;
      const s = vehicle.spec;
      // bonnet cam: just above the hood, ahead of the windshield base
      const local = _v.set(0, (s.collider?.belt ?? 0.9) - s.wheelRadius + 0.3, (s.collider?.cabin?.z0 ?? -0.6) - 0.05);
      local.applyQuaternion(o.quaternion).add(o.position);
      this._pos.copy(local);
      _fwd.set(0, -0.04, -1).applyQuaternion(o.quaternion);
      this._look.copy(local).addScaledVector(_fwd, 20);
      fovTarget += 4;
    } else if (this.mode === 'cinematic') {
      this._updateCinematic(dt, vehicle, p, speed);
    } else {
      this._computeTarget(vehicle, p, dt, false);
      const sm = 0.16;
      this._pos.x = damp(this._pos.x, this._targetPos.x, this._vx, sm, dt);
      this._pos.y = damp(this._pos.y, this._targetPos.y, this._vy, sm * 1.6, dt);
      this._pos.z = damp(this._pos.z, this._targetPos.z, this._vz, sm, dt);
      // keep max distance tight at high speed (no lagging far behind)
      const dx = this._pos.x - p.x, dz = this._pos.z - p.z;
      const dmax = this._dist * 1.35 * sizeScale(vehicle);
      const d = Math.hypot(dx, dz);
      if (d > dmax) {
        this._pos.x = p.x + (dx / d) * dmax;
        this._pos.z = p.z + (dz / d) * dmax;
      }
      this._look.x = damp(this._look.x, this._targetLook.x, this._lx, 0.06, dt);
      this._look.y = damp(this._look.y, this._targetLook.y, this._ly, 0.12, dt);
      this._look.z = damp(this._look.z, this._targetLook.z, this._lz, 0.06, dt);
      // obstacle avoidance
      if (this.raycast) {
        _v.set(p.x, p.y + 1.0, p.z);
        _v2.copy(this._pos).sub(_v);
        const len = _v2.length();
        if (len > 0.01) {
          _v2.divideScalar(len);
          const hit = this.raycast(_v, _v2, len);
          if (hit !== null && hit !== undefined && hit < len) this._pos.copy(_v).addScaledVector(_v2, Math.max(0.6, hit - 0.3));
        }
      }
    }

    // ground clamp
    if (this.getGroundHeight && this.mode !== 'hood') {
      const gh = this.getGroundHeight(this._pos.x, this._pos.z);
      if (Number.isFinite(gh) && this._pos.y < gh + 0.5) this._pos.y = gh + 0.5;
    }

    // FOV
    this._fov += (fovTarget - this._fov) * (1 - Math.exp(-dt * 3));
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }

    this._apply(dt);

    // shake: high-speed rumble + impacts
    const hs = THREE.MathUtils.clamp((speed - 35) / 50, 0, 1) * 0.35 + this._shake;
    const amt = hs * this.shakeAmount * (this.mode === 'hood' ? 0.6 : 1);
    if (amt > 0.001) {
      const t = this._t * 9;
      this.camera.rotateX(noise1(t) * 0.006 * amt);
      this.camera.rotateY(noise1(t + 17.3) * 0.005 * amt);
      this.camera.rotateZ(noise1(t + 41.1) * 0.004 * amt);
    }
  }

  _updateCinematic(dt, vehicle, p, speed) {
    const c = this._cine;
    c.timer -= dt;
    const dx = c.pos.x - p.x, dz = c.pos.z - p.z;
    const far = Math.hypot(dx, dz);
    if (c.timer <= 0 || far > 70) {
      c.kind = (c.kind + 1) % 3;
      c.timer = 5 + Math.random() * 3;
      const dir = speed > 2 ? _v2.set(_vel.x / speed, 0, _vel.z / speed) : _v2.set(_fwd.x, 0, _fwd.z).normalize();
      const side = Math.random() < 0.5 ? -1 : 1;
      const lead = THREE.MathUtils.clamp(speed * 2.2, 6, 45);
      c.pos.set(p.x + dir.x * lead - dir.z * side * (7 + Math.random() * 6), p.y + 1.2 + Math.random() * 3, p.z + dir.z * lead + dir.x * side * (7 + Math.random() * 6));
      c.angle = Math.atan2(c.pos.x - p.x, c.pos.z - p.z);
    }
    if (c.kind === 2) {
      // slow orbit around the car
      c.angle += dt * 0.25;
      const R = 9;
      this._pos.set(p.x + Math.sin(c.angle) * R, p.y + 2.2, p.z + Math.cos(c.angle) * R);
    } else {
      this._pos.copy(c.pos);
    }
    this._look.set(p.x, p.y + 0.6, p.z);
  }

  dispose() {
    if (!this.dom) return;
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('contextmenu', this._onCtx);
  }
}
