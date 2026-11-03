import * as THREE from 'three';
import { GROUPS, groups } from '../vehicle/groups.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

// Physical debris: Rapier dynamic boxes drawn with one InstancedMesh, plus "mesh debris" (detached car parts
// or any Object3D) driven by their own bodies. Lifetime + shrink fade, capped by quality.debrisMax.
export class Debris {
  constructor(game) {
    this.game = game;
    this.hard = 200; // instanced capacity (soft cap comes from quality)
    const g = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.88, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(g, this.material, this.hard);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.hard * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'fx:debris';
    game.scene.add(this.mesh);
    this.items = []; // dense, index = instance slot
    this.meshItems = [];
    this.groups = groups(GROUPS.PROP, 0xffff);
    this.seq = 0;
    this._tick = 0;
  }

  get cap() { return this.game.quality?.debrisMax ?? 60; }

  /**
   * Spawn box debris. o: { count=6, size=0.4, sizeVar=0.5, color (hex or [hex]), impulse=4 (m/s), dir {x,y,z},
   * spread=1, up=0.5, density=900, life=8, spin=4, keep (protected from recycling, e.g. collapse chunks),
   * boxes: [{x,y,z,hx,hy,hz,q?,color}] explicit boxes instead of random ones, vel {x,y,z} base velocity }
   * Returns the created items.
   */
  spawn(pos, o = {}) {
    const { RAPIER, world } = this.game;
    if (!RAPIER || !world) return [];
    const out = [];
    const boxes = o.boxes;
    const n = boxes ? boxes.length : (o.count ?? 6);
    const colors = Array.isArray(o.color) ? o.color : [o.color ?? 0x8a8580];
    const size = o.size ?? 0.4, sv = o.sizeVar ?? 0.5;
    const imp = o.impulse ?? 4, spread = o.spread ?? 1, up = o.up ?? 0.5;
    const dir = o.dir;
    for (let i = 0; i < n; i++) {
      if (!o.keep) this._makeRoom();
      if (this.items.length >= this.hard) break;
      let hx, hy, hz, x, y, z, rot = null, col;
      if (boxes) {
        const b = boxes[i];
        ({ hx, hy, hz, x, y, z } = b);
        rot = b.q || null;
        col = b.color ?? colors[i % colors.length];
      } else {
        const s = size * (1 - sv / 2 + Math.random() * sv);
        hx = s * (0.5 + Math.random() * 0.5) / 2; hy = s * (0.35 + Math.random() * 0.5) / 2; hz = s * (0.5 + Math.random() * 0.5) / 2;
        x = pos.x + (Math.random() - 0.5) * size; y = pos.y + Math.random() * size * 0.5; z = pos.z + (Math.random() - 0.5) * size;
        col = colors[(Math.random() * colors.length) | 0];
      }
      const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinearDamping(0.08).setAngularDamping(0.35);
      if (rot) desc.setRotation(rot);
      else desc.setRotation(_q.setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3)));
      const body = world.createRigidBody(desc);
      const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setDensity(o.density ?? 900).setFriction(0.85).setRestitution(0.08)
        .setCollisionGroups(o.groups ?? this.groups);
      world.createCollider(cd, body);
      // velocity: base + radial/directional
      let vx = o.vel?.x || 0, vy = o.vel?.y || 0, vz = o.vel?.z || 0;
      if (imp > 0) {
        let dx, dy, dz;
        if (dir) {
          dx = dir.x + (Math.random() - 0.5) * spread; dy = (dir.y || 0) + up * Math.random(); dz = dir.z + (Math.random() - 0.5) * spread;
        } else {
          dx = x - pos.x + (Math.random() - 0.5) * 0.4; dy = up + Math.random() * 0.5; dz = z - pos.z + (Math.random() - 0.5) * 0.4;
        }
        const l = Math.hypot(dx, dy, dz) || 1;
        const k = imp * (0.6 + Math.random() * 0.7) / l;
        vx += dx * k; vy += dy * k; vz += dz * k;
      }
      body.setLinvel({ x: vx, y: vy, z: vz }, true);
      const sp = o.spin ?? 4;
      body.setAngvel({ x: (Math.random() - 0.5) * sp, y: (Math.random() - 0.5) * sp, z: (Math.random() - 0.5) * sp }, true);
      _c.set(col);
      if (o.linearColor) _c.setHex(col, THREE.LinearSRGBColorSpace);
      const shade = 0.85 + Math.random() * 0.25;
      const it = {
        body, hx, hy, hz, age: 0, life: (o.life ?? 8) * (0.85 + Math.random() * 0.3), keep: !!o.keep, seq: this.seq++,
        r: _c.r * shade, g: _c.g * shade, b: _c.b * shade, owner: o.owner || null,
      };
      this.items.push(it);
      out.push(it);
    }
    return out;
  }

  // over the soft cap: recycle the box that matters least (old, far from the camera, or already resting)
  _makeRoom() {
    let n = 0;
    for (const it of this.items) if (!it.keep) n++;
    if (n < this.cap) return;
    const cam = this.game.camera.position;
    let worst = null, ws = -Infinity;
    for (const it of this.items) {
      if (it.keep) continue;
      let t;
      try { t = it.body.translation(); } catch { t = cam; }
      const s = it.age / Math.max(1, it.life) + Math.hypot(t.x - cam.x, t.z - cam.z) / 120 + (it.still > 0.5 ? 0.3 : 0);
      if (s > ws) { ws = s; worst = it; }
    }
    if (worst) this.remove(worst);
  }

  remove(it) {
    const i = this.items.indexOf(it);
    if (i < 0) return;
    try { this.game.world.removeRigidBody(it.body); } catch { /* already gone */ }
    const last = this.items.pop();
    if (last !== it) this.items[i] = last;
    it.removed = true;
  }

  /**
   * Attach a physics body to an Object3D already placed in world space (e.g. a detached bumper).
   * o: { half {x,y,z} (collider half extents, local to the object), center {x,y,z} local collider offset,
   *      mass=25, vel, angvel, life=40, onExpire(item) }
   */
  spawnMesh(obj, o = {}) {
    const { RAPIER, world, scene } = this.game;
    while (this.meshItems.length >= 16) this.removeMesh(this.meshItems[0], true);
    obj.updateMatrixWorld(true);
    obj.matrixWorld.decompose(_p, _q, _s);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(_p.x, _p.y, _p.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setLinearDamping(0.1).setAngularDamping(0.4));
    const h = o.half || { x: 0.4, y: 0.2, z: 0.4 };
    const c = o.center || { x: 0, y: 0, z: 0 };
    const vol = 8 * Math.max(0.001, h.x * h.y * h.z);
    const cd = RAPIER.ColliderDesc.cuboid(Math.max(0.03, h.x), Math.max(0.03, h.y), Math.max(0.03, h.z))
      .setTranslation(c.x, c.y, c.z).setDensity((o.mass ?? 25) / vol).setFriction(0.7).setRestitution(0.15)
      .setCollisionGroups(this.groups);
    world.createCollider(cd, body);
    if (o.vel) body.setLinvel(o.vel, true);
    if (o.angvel) body.setAngvel(o.angvel, true);
    scene.add(obj);
    obj.matrixAutoUpdate = true;
    const it = { body, obj, age: 0, life: o.life ?? 40, onExpire: o.onExpire, scale0: obj.scale.clone() };
    this.meshItems.push(it);
    return it;
  }

  removeMesh(it, expire = false) {
    const i = this.meshItems.indexOf(it);
    if (i < 0) return;
    this.meshItems.splice(i, 1);
    try { this.game.world.removeRigidBody(it.body); } catch { /* gone */ }
    if (expire && it.onExpire) it.onExpire(it);
    else if (expire) it.obj.removeFromParent();
    it.removed = true;
  }

  update(dt) {
    const cam = this.game.camera.position;
    const im = this.mesh.instanceMatrix.array;
    const ic = this.mesh.instanceColor.array;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      if (it.age >= it.life && !it.keep) { this.remove(it); continue; }
    }
    // settle quickly: slow pieces go to sleep after a moment, runaway ones are reined in (every 4th frame)
    if ((this._tick = (this._tick + 1) & 3) === 0) {
      for (const it of this.items) {
        const b = it.body;
        if (it.age < 0.8 || b.isSleeping()) continue;
        const v = b.linvel(), w = b.angvel();
        const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
        if (v2 > 2500) { const k = 50 / Math.sqrt(v2); b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true); }
        if (v2 < 0.06 && w.x * w.x + w.y * w.y + w.z * w.z < 0.12) {
          it.still = (it.still || 0) + dt * 4;
          if (it.still > 0.5) b.sleep();
        } else it.still = 0;
      }
    }
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      const t = it.body.translation(), r = it.body.rotation();
      if (!it.keep) {
        const d2 = (t.x - cam.x) ** 2 + (t.z - cam.z) ** 2;
        if (d2 > 200 * 200 && it.life - it.age > 1) it.life = it.age + 1; // far away: fade out soon
        if (t.y < -60) it.life = 0;
      }
      const left = it.life - it.age;
      const k = it.keep ? 1 : left < 1.2 ? Math.max(0.001, left / 1.2) : 1;
      _p.set(t.x, t.y, t.z);
      _q.set(r.x, r.y, r.z, r.w);
      _s.set(it.hx * 2 * k, it.hy * 2 * k, it.hz * 2 * k);
      _m.compose(_p, _q, _s);
      _m.toArray(im, i * 16);
      ic[i * 3] = it.r; ic[i * 3 + 1] = it.g; ic[i * 3 + 2] = it.b;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.clearUpdateRanges();
    if (n) this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
    this.mesh.instanceMatrix.needsUpdate = n > 0;
    this.mesh.instanceColor.clearUpdateRanges();
    if (n) this.mesh.instanceColor.addUpdateRange(0, n * 3);
    this.mesh.instanceColor.needsUpdate = n > 0;

    for (let i = this.meshItems.length - 1; i >= 0; i--) {
      const it = this.meshItems[i];
      it.age += dt;
      const t = it.body.translation(), r = it.body.rotation();
      it.obj.position.set(t.x, t.y, t.z);
      it.obj.quaternion.set(r.x, r.y, r.z, r.w);
      const left = it.life - it.age;
      if (left < 1) it.obj.scale.copy(it.scale0).multiplyScalar(Math.max(0.001, left));
      if (left <= 0 || t.y < -60) this.removeMesh(it, true);
    }
  }

  get active() { return this.items.length; }

  clear() {
    for (const it of [...this.items]) this.remove(it);
    for (const it of [...this.meshItems]) this.removeMesh(it, true);
  }

  dispose() {
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
