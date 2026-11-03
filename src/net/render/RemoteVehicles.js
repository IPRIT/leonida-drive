// Remote players' vehicles: one InstancedMesh per vehicle model (body + wheels), created lazily on first sight,
// capacity doubling only when a model gets popular. Shares the traffic body material program (same shader, same
// cache key), so a new model never compiles a shader; per-instance paint and brake lights via instanced attributes.
import * as THREE from 'three';
import { remoteBodyMaterial, glassAttribute } from './cosmetics.js';
import { proxyModel } from './bake.js';
import { ModelBaker } from './ModelBaker.js';
import { F_BRAKE, F_EXT, VCLASS } from '../shared/constants.js';
import { NEON_COLORS } from '../../economy/rules.js';

const KIND_OF = { [VCLASS.HELI]: 'heli', [VCLASS.PLANE]: 'plane', [VCLASS.BOAT]: 'boat', [VCLASS.BIKE]: 'car', [VCLASS.CAR]: 'car' };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _sq = new THREE.Quaternion();
const _p = new THREE.Vector3(), _wp = new THREE.Vector3(), _s = new THREE.Vector3(), _o = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _c = new THREE.Color();
const _tm = new THREE.Matrix4(), _bm = new THREE.Matrix4(), _rm = new THREE.Matrix4(), _nm = new THREE.Matrix4();
const NEON = NEON_COLORS.map((h) => new THREE.Color(h));

// soft elliptical glow under a car (one texture for every neon kit)
function glowTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RemoteVehicles {
  constructor(game) {
    this.game = game;
    this.uniforms = { uNight: { value: 0 } };
    this.bodyMat = remoteBodyMaterial(this.uniforms); // prewarmed once, cosmetics never recompile it
    this.wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.3 });
    this.types = new Map(); // model index → type
    this.bakeQ = [];
    this.baker = new ModelBaker();
    this.baking = false;
    this.group = new THREE.Group();
    this.group.name = 'net:vehicles';
    game.scene.add(this.group);
    this.visible = true;
    // neon underglow of remote cars (replicated cosmetics): one additive instanced quad, material made once
    this.glowTex = glowTexture();
    this.neonMat = new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.neonCap = 0;
    this.neon = null;
    this._neonBuild(16);
  }

  _neonBuild(cap) {
    if (this.neon) { this.group.remove(this.neon); this.neon.dispose(); }
    const geo = this.neonGeo || (this.neonGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const m = new THREE.InstancedMesh(geo, this.neonMat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, _c.setRGB(0, 0, 0));
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = 2;
    m.name = 'net:neon';
    this.group.add(m);
    this.neon = m;
    this.neonCap = cap;
  }

  // ---------------- types ----------------
  _type(model, client) {
    let T = this.types.get(model);
    if (T) return T;
    const m = client.models[model];
    const kind = KIND_OF[m?.vclass] || 'car';
    T = { model, kind, ready: false, baked: null, mesh: null, wheels: null, turret: null, barrel: null, tint: null, brake: null, cap: 0, n: 0, palette: [0xffffff] };
    this.types.set(model, T);
    // until the real model is baked, draw a proxy so nobody pops in late; bakes are queued (one per frame) so a
    // crowd of new models never stalls a frame
    this._build(T, proxyModel(kind), 8);
    T.id = m?.id;
    this.bakeQ.push(T);
    return T;
  }

  _build(T, baked, cap) {
    if (T.mesh) { this.group.remove(T.mesh); T.mesh.dispose(); T.mesh.geometry.dispose(); }
    if (T.wheels) { this.group.remove(T.wheels); T.wheels.dispose(); }
    for (const k of ['turret', 'barrel']) if (T[k]) { this.group.remove(T[k]); T[k].dispose(); T[k].geometry.dispose(); T[k] = null; }
    // own geometry wrapper: shares the baked attributes (same GPU buffers) but has its own instanced attributes
    const geo = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(baked.geo.attributes)) if (k !== 'aTint' && k !== 'aBrake') geo.setAttribute(k, a);
    geo.boundingSphere = baked.geo.boundingSphere;
    T.tint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    T.brake = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTint', T.tint);
    geo.setAttribute('aBrake', T.brake);
    T.cosmetic = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCosmetic', T.cosmetic);
    geo.setAttribute('aGlass', glassAttribute(baked, geo));
    const mesh = new THREE.InstancedMesh(geo, this.bodyMat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    T.mesh = mesh;
    T.wheels = null;
    if (baked.wheelGeo && baked.wheels?.length) {
      const w = new THREE.InstancedMesh(baked.wheelGeo, this.wheelMat, cap * 6);
      w.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      w.count = 0;
      w.frustumCulled = false;
      w.castShadow = true;
      this.group.add(w);
      T.wheels = w;
    }
    // articulated parts (tanks): separate instanced meshes sharing the per-instance paint/brake attributes
    for (const k of ['turret', 'barrel']) {
      const part = baked[k];
      if (!part?.geo) continue;
      const pg = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(part.geo.attributes)) if (name !== 'aTint' && name !== 'aBrake') pg.setAttribute(name, a);
      pg.setAttribute('aTint', T.tint);
      pg.setAttribute('aBrake', T.brake);
      pg.setAttribute('aCosmetic', T.cosmetic);
      pg.setAttribute('aGlass', glassAttribute({}, pg));
      const pm = new THREE.InstancedMesh(pg, this.bodyMat, cap);
      pm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      pm.count = 0;
      pm.frustumCulled = false;
      pm.castShadow = true;
      this.group.add(pm);
      T[k] = pm;
    }
    T.baked = baked;
    T.cap = cap;
    T.palette = baked.palette?.length ? baked.palette : [0xffffff];
    T.ready = true;
  }

  _grow(T) { this._build(T, T.baked, T.cap * 2); }

  // ---------------- per frame ----------------
  /** entities: RemoteStore.list (already interpolated). */
  update(entities, client, dt) {
    this.uniforms.uNight.value = this.game.sky?.night ?? 0;
    if (!this.baking && this.bakeQ.length) {
      const T = this.bakeQ.shift();
      this.baking = true;
      this.baker.bake(T.id, T.kind).then((b) => { if (b && !this.disposed) this._build(T, b, T.cap); }).catch(() => {}).finally(() => { this.baking = false; });
    }
    for (const T of this.types.values()) T.n = 0;
    this.neonN = 0;
    const night = this.game.sky?.night ?? 0;
    this.neonK = 0.55 + 0.75 * night;
    if (this.visible) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.model || e.model === 255 || e.alpha <= 0.001 || !e.hasCurve) continue;
        const T = this._type(e.model, client);
        if (T.n >= T.cap) this._grow(T);
        this._write(T, e, dt);
      }
    }
    for (const T of this.types.values()) {
      T.mesh.count = T.n;
      T.mesh.instanceMatrix.needsUpdate = true;
      T.tint.needsUpdate = true;
      T.brake.needsUpdate = true;
      T.cosmetic.needsUpdate = true;
      if (T.wheels) { T.wheels.count = T.n * 6; T.wheels.instanceMatrix.needsUpdate = true; }
      if (T.turret) { T.turret.count = T.n; T.turret.instanceMatrix.needsUpdate = true; }
      if (T.barrel) { T.barrel.count = T.n; T.barrel.instanceMatrix.needsUpdate = true; }
    }
    this.neon.count = this.neonN;
    if (this.neonN) { this.neon.instanceMatrix.needsUpdate = true; this.neon.instanceColor.needsUpdate = true; }
  }

  // underglow quad at road level under the car, in the car's frame (follows pitch/roll), scaled to its footprint
  _writeNeon(e, b, sc) {
    if (this.neonN >= this.neonCap) this._neonBuild(this.neonCap * 2);
    const i = this.neonN++;
    _o.set(0, (b.originY || 0) + 0.05, 0).applyQuaternion(_q);
    _wp.set(e.x + _o.x, e.y + _o.y, e.z + _o.z);
    const L = (b.length || 4.4) * 1.18 * sc, W = (b.width || 1.8) * 1.5 * sc;
    _nm.compose(_wp, _q, _s.set(W, 1, L));
    this.neon.setMatrixAt(i, _nm);
    _c.copy(NEON[e.neon % NEON.length]).multiplyScalar(this.neonK * Math.min(1, e.alpha));
    this.neon.setColorAt(i, _c);
  }

  _write(T, e, dt) {
    const i = T.n++;
    const b = T.baked;
    _q.setFromEuler(_e.set(e.pitch, e.yaw, e.roll, 'YXZ'));
    const sc = e.alpha < 1 ? 0.05 + 0.95 * e.alpha * e.alpha * (3 - 2 * e.alpha) : 1;
    _o.set(0, b.originY || 0, 0).applyQuaternion(_q);
    _p.set(e.x + _o.x, e.y + _o.y, e.z + _o.z);
    _m.compose(_p, _q, _s.set(sc, sc, sc));
    T.mesh.setMatrixAt(i, e.dmgView ? ZERO : _m); // a dented copy draws the body (RemoteDamage); wheels stay here
    const paint = e.hasInfo && Number.isInteger(e.paint) ? e.paint : T.palette[e.id % T.palette.length];
    _c.setHex(paint);
    T.tint.setXYZ(i, _c.r, _c.g, _c.b);
    T.brake.setX(i, e.flags & F_BRAKE ? 1 : 0);
    T.cosmetic.setXY(i, e.tint ? 1 : 0, e.finish || 0);
    if (e.neon != null && (e.vclass === VCLASS.CAR || e.vclass === VCLASS.BIKE)) this._writeNeon(e, b, sc);
    // tank turret and barrel: replicated yaw (relative to the hull) and pitch; gone once a wreck replay threw them
    if (T.turret && e.wreckH?.turretDetached) {
      T.turret.setMatrixAt(i, ZERO);
      if (T.barrel) T.barrel.setMatrixAt(i, ZERO);
    } else if (T.turret) {
      const tp = b.turret.pivot;
      _tm.multiplyMatrices(_m, _rm.makeTranslation(tp.x, tp.y, tp.z));
      _tm.multiply(_rm.makeRotationY(e.flags & F_EXT ? e.turret : 0));
      T.turret.setMatrixAt(i, _tm);
      if (T.barrel) {
        const bp = b.barrel.pivot;
        _bm.multiplyMatrices(_tm, _rm.makeTranslation(bp.x, bp.y, bp.z));
        _bm.multiply(_rm.makeRotationX(e.flags & F_EXT ? e.barrel : 0));
        T.barrel.setMatrixAt(i, _bm);
      }
    }
    if (!T.wheels) return;
    // wheels: spin from the forward speed, front wheels steer
    const fwd = -Math.sin(e.yaw) * e.vx - Math.cos(e.yaw) * e.vz;
    const r = b.radius || 0.33;
    e.wheelSpin = (e.wheelSpin + (fwd * dt) / r) % (Math.PI * 2);
    const W = b.wheels;
    for (let w = 0; w < 6; w++) {
      if (w >= W.length) { T.wheels.setMatrixAt(i * 6 + w, ZERO); continue; }
      const wh = W[w];
      _wp.set(wh.x * sc, (wh.y ?? r) * sc, wh.z * sc).applyQuaternion(_q).add(_p);
      _wq.setFromAxisAngle(AY, (wh.left ? Math.PI : 0) + (wh.front ? -e.steer : 0));
      _sq.setFromAxisAngle(AX, wh.left ? e.wheelSpin : -e.wheelSpin);
      _wq.premultiply(_q).multiply(_sq);
      _m.compose(_wp, _wq, _s.set(sc, sc, sc));
      T.wheels.setMatrixAt(i * 6 + w, _m);
    }
  }

  /** Bounding box size of a model (for colliders): { length, width, height, originY, center }. */
  dims(model) { const T = this.types.get(model); return T?.baked || null; }

  setVisible(v) { this.visible = v; this.group.visible = v; }

  dispose() {
    this.disposed = true; this.baker.stop(true);
    for (const T of this.types.values()) { T.mesh.dispose(); T.mesh.geometry.dispose(); T.wheels?.dispose(); T.turret?.dispose(); T.barrel?.dispose(); }
    this.neon?.dispose(); this.neonGeo?.dispose(); this.neonMat.dispose(); this.glowTex?.dispose();
    this.group.removeFromParent();
    this.bodyMat.dispose();
    this.wheelMat.dispose();
  }
}
