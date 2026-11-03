import * as THREE from 'three';

// Fly camera: pointer-lock mouse look (or right-drag), WASD/QE, Shift boost, wheel = speed.
export class FreeCamera {
  constructor(camera, dom, { getGroundHeight } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.getGroundHeight = getGroundHeight;
    this.enabled = false;
    this.yaw = 0;
    this.pitch = -0.3;
    this.speed = 60; // m/s
    this.vel = new THREE.Vector3();
    this.keys = new Set();
    this.dragging = false;
    this._onKey = (e) => {
      if (!this.enabled) return;
      if (e.type === 'keydown') this.keys.add(e.code); else this.keys.delete(e.code);
    };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    dom.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0 && document.pointerLockElement !== dom) {
        // embedded/iframe contexts may refuse pointer lock: right-drag still works there
        try { const p = dom.requestPointerLock?.(); p?.catch?.(() => {}); } catch { /* ignore */ }
      }
      if (e.button === 0 || e.button === 2) this.dragging = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0 || e.button === 2) this.dragging = false; });
    dom.addEventListener('contextmenu', (e) => this.enabled && e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement === dom || this.dragging) {
        this.yaw -= e.movementX * 0.0022;
        this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.55, 1.55);
      }
    });
    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY > 0 ? 0.85 : 1.18), 4, 2500);
    }, { passive: true });
  }

  enable(fromCamera) {
    this.enabled = true;
    const e = new THREE.Euler().setFromQuaternion(fromCamera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
    this.vel.set(0, 0, 0);
    this.keys.clear();
  }

  disable() {
    this.enabled = false;
    this.keys.clear();
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const u = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('ControlLeft') ? 1 : 0);
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const target = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, s).addScaledVector(new THREE.Vector3(0, 1, 0), u);
    if (target.lengthSq() > 1) target.normalize();
    // speed also scales with altitude so far views feel responsive
    const p = this.camera.position;
    const ground = this.getGroundHeight ? Math.max(0, this.getGroundHeight(p.x, p.z)) : 0;
    const alt = Math.max(1, p.y - ground);
    const sp = this.speed * boost * (1 + alt / 600);
    target.multiplyScalar(sp);
    this.vel.lerp(target, 1 - Math.exp(-dt * 6));
    p.addScaledVector(this.vel, dt);
    const minY = ground + 1.5;
    if (p.y < minY) p.y = minY;
    p.y = Math.min(p.y, 12000);
    this.camera.quaternion.copy(q);
  }
}
