import * as THREE from 'three';
import { BillboardSystem, ChunkSystem } from './Particles.js';
import { Debris } from './Debris.js';
import { Decals } from './Decals.js';
import { FxLights } from './FxLights.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const P = {}; // scratch particle descriptor (re-used for every emit)
const rnd = Math.random;

function resetP() {
  for (const k in P) delete P[k];
  return P;
}

// smoke looks (linear albedo, start -> end), alpha, size multiplier, lifetime
const SMOKE = {
  light: { c0: [0.62, 0.62, 0.62], c1: [0.78, 0.78, 0.78], alpha: 0.32, life: 3.2, size: 1, rise: 1.4 },
  dark: { c0: [0.16, 0.155, 0.15], c1: [0.32, 0.31, 0.3], alpha: 0.45, life: 4.2, size: 1.2, rise: 1.6 },
  black: { c0: [0.03, 0.028, 0.026], c1: [0.13, 0.125, 0.12], alpha: 0.6, life: 5.5, size: 1.4, rise: 2.0 },
  steam: { c0: [0.9, 0.92, 0.95], c1: [0.95, 0.96, 0.98], alpha: 0.3, life: 1.3, size: 0.7, rise: 1.8 },
  dust: { c0: [0.55, 0.47, 0.36], c1: [0.66, 0.6, 0.5], alpha: 0.42, life: 3.0, size: 1.2, rise: 0.5 },
  concrete: { c0: [0.62, 0.6, 0.56], c1: [0.72, 0.7, 0.67], alpha: 0.5, life: 6.0, size: 1.6, rise: 0.6 },
};

const MATERIAL_COLORS = {
  metal: [0x2a2c30, 0x45484e, 0x6b6f76],
  concrete: [0x9a968e, 0xb5b0a6, 0x7d7a74],
  wood: [0x6b4a2b, 0x8a6238, 0x4f3420],
  glass: [0xcfeaf5, 0xa9d8ea, 0xffffff],
  leaf: [0x3f6b2a, 0x5a8a34, 0x2f5420, 0x7a9a3a],
  dirt: [0x6b5537, 0x8a7350, 0x51412b],
};

// ---------- continuous emitters ----------

class Emitter {
  constructor(fx, pos, o) {
    this.fx = fx;
    this.position = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.size = o.size ?? 1;
    this.intensity = o.intensity ?? 1;
    this.duration = o.duration ?? Infinity;
    this.attachTo = o.attachTo || null;
    this.offset = new THREE.Vector3(o.offset?.x || 0, o.offset?.y || 0, o.offset?.z || 0);
    this.age = 0;
    this.alive = true;
    this.fade = 1;
    this._stopping = false;
    this._stopT = 0;
    this._stopDur = 1;
    this.acc = [0, 0, 0, 0];
  }

  stop(fadeSeconds = 1.5) {
    if (this._stopping || !this.alive) return;
    this._stopping = true;
    this._stopT = 0;
    this._stopDur = Math.max(0.01, fadeSeconds);
  }

  kill() { this.alive = false; }

  _follow() {
    const a = this.attachTo;
    if (!a) return true;
    try {
      if (typeof a === 'function') {
        const p = a(this);
        if (!p) return false;
        this.position.set(p.x, p.y, p.z);
      } else if (a.isObject3D) {
        if (!a.parent) return false;
        if (a.parent.isScene) this.position.copy(this.offset).applyQuaternion(a.quaternion).add(a.position);
        else this.position.copy(a.localToWorld(_w.copy(this.offset)));
      } else if (a.translation) {
        const t = a.translation(), r = a.rotation();
        this.position.copy(this.offset).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_w.set(t.x, t.y, t.z));
      }
    } catch {
      return false; // body removed from the world
    }
    return true;
  }

  // shared lifecycle; returns false when dead
  _tick(dt) {
    if (!this.alive) return false;
    if (!this._follow()) { this.alive = false; return false; }
    this.age += dt;
    if (this.age >= this.duration) this.stop(this._autoFade ?? 1.5);
    if (this._stopping) {
      this._stopT += dt;
      this.fade = Math.max(0, 1 - this._stopT / this._stopDur);
      if (this.fade <= 0) { this.alive = false; return false; }
    }
    return true;
  }

  _lod() {
    const d = this.position.distanceTo(this.fx.game.camera.position);
    return d < 50 ? 1 : d < 150 ? 0.6 : d < 400 ? 0.3 : d < 900 ? 0.12 : 0;
  }

  _count(i, rate, dt) {
    this.acc[i] += rate * dt;
    const n = Math.floor(this.acc[i]);
    this.acc[i] -= n;
    return Math.min(n, 12);
  }
}

class FireHandle extends Emitter {
  constructor(fx, pos, o) {
    super(fx, pos, o);
    this.kind = 'fire';
    this.smokeKind = o.smoke === false ? null : (o.smoke || 'black');
    this.smokeDensity = o.smokeDensity ?? 1;
    this.embers = o.embers !== false;
    this.spread = o.spread ?? 0.45; // emission radius relative to size
    if (o.light !== false) this.lightSrc = fx.lights.addFire(this);
  }

  update(dt) {
    if (!this._tick(dt)) return false;
    const fx = this.fx;
    const lod = this._lod();
    if (lod <= 0) return true;
    const S = this.size * (0.35 + 0.65 * this.fade);
    const share = fx.fireShare; // many simultaneous fires share one particle budget
    const big = 1 / Math.sqrt(lod * share); // fewer but bigger far away
    const pos = this.position;
    const floorY = pos.y - 0.2;
    // flame tongues
    const nf = this._count(0, 42 * Math.max(0.3, S) * lod * share * this.intensity * this.fade, dt);
    for (let i = 0; i < nf; i++) {
      const r = this.spread * S * Math.sqrt(rnd()), a = rnd() * 6.283;
      const p = resetP();
      p.x = pos.x + Math.cos(a) * r; p.y = pos.y + rnd() * 0.15 * S; p.z = pos.z + Math.sin(a) * r;
      p.vx = (rnd() - 0.5) * 0.5; p.vy = (1.1 + 1.3 * S) * (0.7 + rnd() * 0.6); p.vz = (rnd() - 0.5) * 0.5;
      p.life = (0.5 + rnd() * 0.4) * Math.sqrt(Math.max(0.5, S));
      p.size0 = 1.05 * S * (0.75 + rnd() * 0.5) * big; p.size1 = 0.45 * S * big;
      p.heat = 0.72 + rnd() * 0.28; p.alpha = 0.95; p.drag = 0.9; p.grav = -0.6; p.wind = 0.3;
      p.rot = (rnd() - 0.5) * 0.25; p.spin = 0; p.seed = rnd(); p.fadeIn = 0.06;
      fx.flames.emit(p);
    }
    // smoke column
    if (this.smokeKind) {
      const sk = SMOKE[this.smokeKind] || SMOKE.black;
      const ns = this._count(1, 10 * S * lod * share * this.smokeDensity * (0.4 + 0.6 * this.fade), dt);
      for (let i = 0; i < ns; i++) fx._puff(sk, pos.x + (rnd() - 0.5) * 0.5 * S, pos.y + 0.8 * S, pos.z + (rnd() - 0.5) * 0.5 * S, S * big, 0.65, floorY);
    }
    // embers
    if (this.embers) {
      const ne = this._count(2, 4 * S * lod * share * this.fade, dt);
      for (let i = 0; i < ne; i++) {
        const p = resetP();
        p.x = pos.x + (rnd() - 0.5) * S; p.y = pos.y + 0.4 * S; p.z = pos.z + (rnd() - 0.5) * S;
        p.vx = (rnd() - 0.5) * 1.5; p.vy = 2 + rnd() * 3 * S; p.vz = (rnd() - 0.5) * 1.5;
        p.life = 1 + rnd() * 1.6; p.size0 = 0.06; p.size1 = 0.03;
        p.r = 3.5; p.g = 1.1; p.b = 0.25; p.alpha = 1; p.drag = 0.9; p.grav = -0.25; p.wind = 0.4; p.fadeIn = 0.05;
        fx.sparkSys.emit(p);
      }
    }
    return true;
  }

  stop(fadeSeconds = 2) {
    super.stop(fadeSeconds);
  }
}

class SmokeHandle extends Emitter {
  constructor(fx, pos, o) {
    super(fx, pos, o);
    this.kind = 'smoke';
    this.look = typeof o.color === 'string' ? (SMOKE[o.color] || SMOKE.light) : SMOKE[o.kind] || SMOKE.light;
    if (typeof o.color === 'number' || Array.isArray(o.color)) {
      const c = new THREE.Color().set(Array.isArray(o.color) ? o.color[0] : o.color);
      this.look = { ...this.look, c0: [c.r, c.g, c.b], c1: [c.r * 1.2, c.g * 1.2, c.b * 1.2] };
    }
    this.rate = o.rate ?? 8;
    this.density = o.density ?? 1;
    this.velocity = o.velocity || null;
  }

  setLook(kind) { this.look = SMOKE[kind] || this.look; }

  update(dt) {
    if (!this._tick(dt)) return false;
    const lod = this._lod();
    if (lod <= 0) return true;
    const n = this._count(0, this.rate * lod * this.fade, dt);
    const pos = this.position;
    const big = 1 / Math.sqrt(lod);
    for (let i = 0; i < n; i++) {
      this.fx._puff(this.look, pos.x + (rnd() - 0.5) * 0.25 * this.size, pos.y, pos.z + (rnd() - 0.5) * 0.25 * this.size,
        this.size * big, 0, pos.y - 0.3, this.density * this.intensity, this.velocity);
    }
    return true;
  }
}

// ---------- shockwave rings ----------

class Rings {
  constructor(scene, n = 6) {
    const g = new THREE.CircleGeometry(1, 48);
    g.rotateX(-Math.PI / 2);
    this.items = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(1, 0.8, 0.55) }, uAlpha: { value: 0 }, uInner: { value: 0.85 } },
        vertexShader: /* glsl */`varying vec2 vL; void main(){ vL = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`uniform vec3 uColor; uniform float uAlpha; uniform float uInner; varying vec2 vL;
          void main(){ float r = length(vL); float b = smoothstep(uInner, mix(uInner, 1.0, 0.6), r) * (1.0 - smoothstep(mix(uInner, 1.0, 0.6), 1.0, r));
            float a = b * uAlpha; if (a < 0.003) discard; gl_FragColor = vec4(uColor * a, a * 0.25); }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      const m = new THREE.Mesh(g, mat);
      m.scale.setScalar(1e-4);
      m.frustumCulled = false;
      m.renderOrder = 6;
      m.name = 'fx:ring';
      scene.add(m);
      this.items.push({ mesh: m, t: 0, dur: 0, r0: 0, r1: 0, a0: 0, on: false });
    }
  }

  spawn(pos, r1, dur = 0.45, { color, alpha = 1.6, inner = 0.82, tilt = null } = {}) {
    const it = this.items.find((x) => !x.on) || this.items.reduce((a, b) => (a.t / a.dur > b.t / b.dur ? a : b));
    Object.assign(it, { t: 0, dur, r0: r1 * 0.08, r1, a0: alpha, on: true });
    it.mesh.position.set(pos.x, pos.y, pos.z);
    it.mesh.rotation.set(0, 0, 0);
    if (tilt) it.mesh.lookAt(pos.x + tilt.x, pos.y + tilt.y, pos.z + tilt.z), it.mesh.rotateX(Math.PI / 2);
    it.mesh.material.uniforms.uInner.value = inner;
    if (color) it.mesh.material.uniforms.uColor.value.set(color);
    return it;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.on) continue;
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) {
        it.on = false;
        it.mesh.scale.setScalar(1e-4);
        it.mesh.material.uniforms.uAlpha.value = 0;
        continue;
      }
      const e = 1 - (1 - k) * (1 - k) * (1 - k);
      const r = it.r0 + (it.r1 - it.r0) * e;
      it.mesh.scale.set(r, r, r);
      it.mesh.material.uniforms.uAlpha.value = it.a0 * (1 - k) * (1 - k);
    }
  }

  dispose() { for (const it of this.items) { it.mesh.removeFromParent(); it.mesh.material.dispose(); } }
}

// ---------- the FX module ----------

export class FX {
  constructor(game) {
    this.game = game;
    this.order = 60;
    const scene = game.scene;
    const q = game.quality || {};
    const pmax = Math.max(800, q.particlesMax ?? 4000);
    this.shares = { flames: 0.28, puffs: 0.45, sparks: 0.2 };
    this.flames = new BillboardSystem(scene, { capacity: Math.round(pmax * 0.28), kind: 'flame', renderOrder: 4, name: 'fx:flames' });
    this.puffs = new BillboardSystem(scene, { capacity: Math.round(pmax * 0.45), kind: 'puff', renderOrder: 3, name: 'fx:smoke' });
    this.sparkSys = new BillboardSystem(scene, { capacity: Math.round(pmax * 0.2), kind: 'spark', stretch: 0.05, renderOrder: 5, name: 'fx:sparks' });
    this.chunks = new ChunkSystem(scene, Math.min(700, Math.round(pmax * 0.12)));
    this.debrisSys = new Debris(game);
    this.decals = new Decals(game);
    this.lights = new FxLights(scene, q.name === 'low' ? 2 : 4);
    this.rings = new Rings(scene);
    this.emitters = [];
    this.shake = 0;
    this._slow = null;
    this._sunView = new THREE.Vector3();
    this.flashLevel = 0;
    this.stats = { explosions: 0, lastExplodeMs: 0, maxExplodeMs: 0 };
    this.fireShare = 1;
    this.maxFires = 10; // above this, fires split the same emission budget
    this._frameBlasts = 0;
    this._prewarmed = false;
  }

  /**
   * Compile every FX material once (call after the scene is built; the integrator also compiles the scene).
   * Never adds/removes lights or toggles visibility, so nothing recompiles later.
   */
  prewarm(renderer = this.game.renderer, camera = this.game.camera) {
    const scene = this.game.scene;
    const objs = [this.flames.mesh, this.puffs.mesh, this.sparkSys.mesh, this.chunks.mesh, this.debrisSys.mesh, this.decals.mesh,
      ...this.rings.items.map((r) => r.mesh), ...(this.game.damage?.prewarmObjects?.() || [])];
    // compile for the target the scene is really drawn into (linear HDR scene target) and for the canvas, else every
    // material recompiles (output colour space differs) the first time it shows up: a 100-300 ms hitch
    const prev = renderer.getRenderTarget?.();
    for (const rt of [this.game.render?.sceneRT, null]) {
      if (rt === undefined) continue;
      try { renderer.setRenderTarget?.(rt); } catch { continue; }
      for (const o of objs) {
        try { renderer.compile(o, camera, scene); } catch (e) { console.warn('[fx] prewarm', e); }
      }
    }
    // some drivers (ANGLE / Metal) only build the pipeline at the first real draw (~100 ms for the big facade shader):
    // draw the free-standing prewarm meshes once, microscopic, in front of the camera, while the game is still loading
    const holder = new THREE.Group();
    try {
      const fwd = _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
      holder.position.copy(camera.position).addScaledVector(fwd, 2);
      holder.scale.setScalar(0.001);
      for (const o of objs) if (!o.parent) holder.add(o);
      if (holder.children.length) {
        scene.add(holder);
        holder.updateMatrixWorld(true);
        renderer.setRenderTarget?.(this.game.render?.sceneRT ?? null);
        renderer.render(scene, camera);
      }
    } catch (e) { console.warn('[fx] prewarm draw', e); }
    for (const o of [...holder.children]) holder.remove(o);
    holder.removeFromParent();
    try { renderer.setRenderTarget?.(prev ?? null); } catch { /* keep */ }
    this._prewarmed = true;
  }

  // ---------- public API ----------

  /** Fire at pos. o: { size=1, duration=Infinity, attachTo (Object3D | Rapier body | () => pos), offset, intensity,
   *  smoke: 'black'|'dark'|false, light=true, embers=true }. Returns a handle with stop(fade), alive, size, position. */
  fire(pos, o = {}) {
    const h = new FireHandle(this, pos, o);
    this.emitters.push(h);
    this.game.events?.emit('fire:start', { position: h.position, target: o.target ?? o.attachTo ?? null });
    h._autoFade = o.fadeOut ?? 2;
    return h;
  }

  /** Smoke: continuous emitter (returns handle) or, with `count`, a one-off burst (returns null).
   *  o: { color: 'light'|'dark'|'black'|'steam'|'dust'|'concrete'|hex, size=1, rate=8, duration, attachTo, offset,
   *       density=1, velocity {x,y,z}, count }. */
  smoke(pos, o = {}) {
    if (o.count) {
      const look = typeof o.color === 'string' ? SMOKE[o.color] || SMOKE.light : SMOKE.light;
      for (let i = 0; i < o.count; i++) {
        this._puff(look, pos.x + (rnd() - 0.5) * (o.size ?? 1), pos.y, pos.z + (rnd() - 0.5) * (o.size ?? 1), o.size ?? 1, 0, pos.y - 0.5, o.density ?? 1, o.velocity);
      }
      return null;
    }
    const h = new SmokeHandle(this, pos, o);
    this.emitters.push(h);
    return h;
  }

  steam(pos, o = {}) { return this.smoke(pos, { color: 'steam', rate: 14, size: 0.6, ...o }); }

  /** Bright metal sparks along dir (cone). */
  sparks(pos, dir = { x: 0, y: 1, z: 0 }, n = 20, { speed = 10, spread = 0.7, color = [4, 2.2, 0.8], life = 0.6, size = 0.05, floor } = {}) {
    n = Math.round(n * this._lodAt(pos));
    const dl = Math.hypot(dir.x, dir.y || 0, dir.z) || 1;
    const fy = floor ?? this._floorFast(pos);
    for (let i = 0; i < n; i++) {
      const p = resetP();
      const s = speed * (0.4 + rnd() * 0.9);
      p.x = pos.x; p.y = pos.y; p.z = pos.z;
      p.vx = (dir.x / dl + (rnd() - 0.5) * spread * 2) * s;
      p.vy = ((dir.y || 0) / dl + (rnd() - 0.2) * spread * 2) * s;
      p.vz = (dir.z / dl + (rnd() - 0.5) * spread * 2) * s;
      p.life = life * (0.5 + rnd() * 0.9);
      p.size0 = size * (0.7 + rnd() * 0.6); p.size1 = p.size0 * 0.6;
      const w = 0.7 + rnd() * 0.5;
      p.r = color[0] * w; p.g = color[1] * w; p.b = color[2] * w; p.r1 = color[0] * 0.6; p.g1 = color[1] * 0.25; p.b1 = color[2] * 0.1;
      p.alpha = 1; p.drag = 0.7; p.grav = 9.81; p.fadeIn = 0; p.floor = fy;
      this.sparkSys.emit(p);
    }
  }

  /** Dust/dirt cloud. o: { color: 'dust'|'concrete'|'dirt', count, rise, spread } */
  dust(pos, size = 1, o = {}) {
    const look = SMOKE[o.color === 'dirt' ? 'dust' : o.color || 'dust'] || SMOKE.dust;
    const n = Math.round((o.count ?? 6 + 6 * size) * this._lodAt(pos));
    const fy = this._floorFast(pos);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, r = rnd() * size * (o.spread ?? 0.8);
      const sp = (o.speed ?? 1.5) * (0.5 + rnd());
      this._puff(look, pos.x + Math.cos(a) * r, pos.y + rnd() * 0.4 * size, pos.z + Math.sin(a) * r, size * 0.8, 0, fy, 1,
        { x: Math.cos(a) * sp, y: (o.rise ?? 0.6) * (0.5 + rnd()), z: Math.sin(a) * sp });
    }
  }

  /** Glass shards + glints. */
  glass(pos, dir = { x: 0, y: 0, z: 0 }, n = 24) {
    n = Math.round(n * this._lodAt(pos));
    const fy = this._floorFast(pos);
    for (let i = 0; i < n; i++) {
      const c = new THREE.Color(MATERIAL_COLORS.glass[i % 3]);
      const s = 2 + rnd() * 4;
      this.chunks.emit({
        x: pos.x + (rnd() - 0.5) * 0.6, y: pos.y + (rnd() - 0.5) * 0.3, z: pos.z + (rnd() - 0.5) * 0.6,
        vx: (dir.x || 0) * s + (rnd() - 0.5) * 3, vy: 1 + rnd() * 3 + (dir.y || 0) * s, vz: (dir.z || 0) * s + (rnd() - 0.5) * 3,
        size: 0.05 + rnd() * 0.07, sy: 0.12, r: c.r * 1.4, g: c.g * 1.4, b: c.b * 1.4, life: 3 + rnd() * 3, drag: 0.4, floor: fy, spin: 10 + rnd() * 15,
      });
      if (i % 3 === 0) {
        const p = resetP();
        p.x = pos.x; p.y = pos.y; p.z = pos.z;
        p.vx = (dir.x || 0) * s + (rnd() - 0.5) * 3; p.vy = 1 + rnd() * 2; p.vz = (dir.z || 0) * s + (rnd() - 0.5) * 3;
        p.life = 0.25 + rnd() * 0.3; p.size0 = 0.12; p.size1 = 0.02; p.r = p.g = p.b = 2.5; p.alpha = 1; p.grav = 9.81; p.fadeIn = 0;
        this.sparkSys.emit(p);
      }
    }
  }

  /** Falling leaves (tree hits). o: { count=30, color: 'leaf'|'palm', spread=2, height } */
  leaves(pos, o = {}) {
    const n = Math.round((o.count ?? 30) * this._lodAt(pos));
    const cols = MATERIAL_COLORS.leaf;
    const fy = this._floorFast(pos);
    const sp = o.spread ?? 2;
    for (let i = 0; i < n; i++) {
      const c = new THREE.Color(cols[(rnd() * cols.length) | 0]);
      this.chunks.emit({
        x: pos.x + (rnd() - 0.5) * sp * 2, y: pos.y + (rnd() - 0.3) * sp, z: pos.z + (rnd() - 0.5) * sp * 2,
        vx: (rnd() - 0.5) * 4, vy: rnd() * 3, vz: (rnd() - 0.5) * 4,
        size: 0.14 + rnd() * 0.16, sx: 1, sy: 0.08, sz: 0.6, r: c.r, g: c.g, b: c.b, life: 4 + rnd() * 4, drag: 1.2, floor: fy,
        spin: 3 + rnd() * 5, flutter: 4,
      });
    }
  }

  /** Wood chips / generic small solid bits. material: 'wood'|'metal'|'concrete'|'dirt' */
  bits(pos, { material = 'wood', count = 12, speed = 5, dir, size = 0.12, life = 3 } = {}) {
    const n = Math.round(count * this._lodAt(pos));
    const cols = MATERIAL_COLORS[material] || MATERIAL_COLORS.metal;
    const fy = this._floorFast(pos);
    for (let i = 0; i < n; i++) {
      const c = new THREE.Color(cols[(rnd() * cols.length) | 0]);
      const s = speed * (0.4 + rnd() * 0.8);
      this.chunks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: ((dir?.x || 0) + (rnd() - 0.5) * 1.6) * s, vy: ((dir?.y || 0) + 0.4 + rnd()) * s * 0.7, vz: ((dir?.z || 0) + (rnd() - 0.5) * 1.6) * s,
        size: size * (0.6 + rnd() * 0.9), sy: 0.45, r: c.r, g: c.g, b: c.b, life: life * (0.6 + rnd() * 0.8), drag: 0.3, floor: fy,
      });
    }
  }

  /** Water splash/spray. */
  splash(pos, strength = 1) {
    const n = Math.round((10 + 26 * strength) * this._lodAt(pos));
    for (let i = 0; i < n; i++) {
      const p = resetP();
      const a = rnd() * 6.283, r = rnd() * 0.8 * strength;
      p.x = pos.x + Math.cos(a) * r; p.y = pos.y + 0.1; p.z = pos.z + Math.sin(a) * r;
      const sp = (1 + rnd() * 2.5) * strength;
      p.vx = Math.cos(a) * sp; p.vy = (3 + rnd() * 6) * Math.sqrt(strength); p.vz = Math.sin(a) * sp;
      p.life = 0.7 + rnd() * 0.7; p.size0 = 0.35 * strength + 0.2; p.size1 = 1.1 * strength + 0.5;
      p.r = 0.82; p.g = 0.9; p.b = 0.96; p.alpha = 0.6; p.drag = 0.6; p.grav = 9.81; p.fadeIn = 0.03; p.floor = pos.y - 0.3;
      this.puffs.emit(p);
    }
    for (let i = 0; i < 5 * strength; i++) {
      this._puff({ c0: [0.85, 0.9, 0.95], c1: [0.9, 0.94, 0.97], alpha: 0.3, life: 1.6, size: 1, rise: 0.8 },
        pos.x + (rnd() - 0.5) * strength, pos.y + 0.4, pos.z + (rnd() - 0.5) * strength, strength, 0, pos.y);
    }
    this.rings.spawn({ x: pos.x, y: pos.y + 0.05, z: pos.z }, 2 + 3 * strength, 0.8, { color: 0xbfe6ff, alpha: 0.5, inner: 0.7 });
  }

  /** Rapier debris boxes; see Debris.spawn for options. */
  debris(pos, o = {}) { return this.debrisSys.spawn(pos, o); }

  scorch(pos, size = 4, o) { return this.decals.addGround(pos, size, o); }

  wallScorch(pos, normal, size = 4, o) { return this.decals.addWall(pos, normal, size, o); }

  flash(pos, o) { return this.lights.flash(pos, o); }

  /** Camera shake impulse (0..~1.5). Cameras read fx.shake or listen to 'camera:shake'. */
  addShake(amount) {
    if (!(amount > 0.01)) return;
    this.shake = Math.min(1.5, this.shake + amount);
    this.game.events?.emit('camera:shake', { amount });
  }

  /** Brief slow motion: time scale `scale` easing back to 1 over `seconds` of real time. */
  slowmo(scale = 0.3, seconds = 0.8) {
    if (this.game.player?.wastedT > 0) return;
    this._slow = { scale, t: 0, dur: seconds };
  }

  /** Generic impact effect. o: { normal, strength 0..1, material: 'metal'|'glass'|'concrete'|'wood'|'dirt'|'water' } */
  hit(pos, { normal = { x: 0, y: 1, z: 0 }, strength = 0.5, material = 'metal' } = {}) {
    const s = Math.max(0.05, Math.min(1.5, strength));
    if (material === 'water') return this.splash(pos, s);
    if (material === 'glass') return this.glass(pos, normal, 10 + 30 * s);
    if (material === 'metal') {
      this.sparks(pos, normal, 6 + 40 * s, { speed: 6 + 8 * s });
      if (s > 0.35) this.bits(pos, { material: 'metal', count: 4 + 10 * s, speed: 3 + 4 * s, dir: normal, size: 0.08 });
      if (s > 0.25) this.dust(pos, 0.5 + s, { color: 'dust', count: 3 + 5 * s });
      return;
    }
    if (material === 'concrete') {
      this.dust(pos, 0.8 + 1.5 * s, { color: 'concrete', count: 5 + 10 * s });
      this.bits(pos, { material: 'concrete', count: 6 + 14 * s, speed: 3 + 5 * s, dir: normal, size: 0.14 });
      this.sparks(pos, normal, 4 + 10 * s);
      return;
    }
    if (material === 'wood') {
      this.bits(pos, { material: 'wood', count: 8 + 16 * s, speed: 4 + 4 * s, dir: normal, size: 0.12 });
      this.dust(pos, 0.6 + s, { color: 'dust', count: 3 + 4 * s });
      return;
    }
    this.dust(pos, 0.8 + s, { color: 'dust' });
    this.bits(pos, { material: 'dirt', count: 6 + 10 * s, speed: 3 + 3 * s, dir: normal });
  }

  /**
   * Explosion. power ≈ 1 for a car. o: { radius, exclude: [RigidBody], noWorld (skip game-world effects),
   * noPhysics, source, scorch=true, fire (leave ground fire seconds) }. Returns { position, power, radius }.
   */
  explode(pos, power = 1, o = {}) {
    // Accept the options-object form used by scripted effects / older labs.
    // Never let a malformed power reach particle physics or audio playbackRate.
    if (power && typeof power === 'object') { o = { ...power, ...o }; power = power.power ?? 1; }
    if (!Number.isFinite(power)) power = 1;
    const t0 = performance.now();
    const game = this.game;
    const Pw = Math.max(0.1, power);
    const sq = Math.sqrt(Pw);
    const R = o.radius ?? 10 + 7 * sq; // car (P=1): 17 m
    const position = new THREE.Vector3(pos.x, pos.y, pos.z);
    const ground = this.decals.groundY(position.x, position.z, position.y + 2);
    const nearGround = position.y - ground < 3 + sq;
    const camPos = game.camera.position;
    const dCam = position.distanceTo(camPos);
    const busy = 1 / (1 + this._frameBlasts++); // several blasts in one frame share the particle budget
    const lod = (dCam < 80 ? 1 : dCam < 250 ? 0.6 : dCam < 700 ? 0.3 : 0.12) * busy;
    const info = { position, power: Pw, radius: R, source: o.source ?? null };

    // world reaction first (crashed traffic must be dynamic before the blast impulse)
    if (!o.noWorld) {
      if (game.damage?.onExplosion) game.damage.onExplosion(position, Pw, R, o);
      else this._fallbackWorld(position, Pw, R);
    }
    if (!o.noPhysics) this._blast(position, Pw, R, o.exclude);

    // flash + light
    this.lights.flash({ x: position.x, y: position.y + 1.5, z: position.z }, { intensity: 1500 * Pw, range: 28 + 22 * sq, duration: 0.7 + 0.2 * sq });
    this.flashLevel = Math.min(1.8, this.flashLevel + 0.85 * Pw * Math.max(0, 1 - dCam / (160 * sq)));
    let p = resetP();
    p.x = position.x; p.y = position.y + 0.8; p.z = position.z;
    p.life = 0.16; p.size0 = 6 * sq; p.size1 = 10 * sq; p.r = 3; p.g = 2.1; p.b = 1.2; p.alpha = 1; p.fadeIn = 0;
    this.sparkSys.emit(p);

    // fireball
    const nBall = Math.round(30 * Pw * lod + 4);
    for (let i = 0; i < nBall; i++) {
      p = resetP();
      _v.set(rnd() - 0.5, rnd() * 0.8 - (nearGround ? 0.05 : 0.4), rnd() - 0.5).normalize();
      const r0 = rnd() * 0.7 * sq;
      p.x = position.x + _v.x * r0; p.y = position.y + 0.5 + _v.y * r0; p.z = position.z + _v.z * r0;
      const s = (5 + rnd() * 9) * sq;
      p.vx = _v.x * s; p.vy = _v.y * s + 2.5; p.vz = _v.z * s;
      p.life = (0.8 + rnd() * 0.7) * (0.8 + 0.2 * sq);
      p.size0 = (1.8 + rnd()) * sq * (1 / Math.sqrt(lod)); p.size1 = (4.5 + rnd() * 2.5) * sq / Math.sqrt(lod);
      p.heat = 0.7 + rnd() * 0.3; p.alpha = 0.6; p.drag = 2.6; p.grav = -2.5; p.fadeIn = 0.02;
      p.seed = 10 + rnd(); p.spin = (rnd() - 0.5) * 2;
      this.flames.emit(p);
    }
    // rising fire core
    for (let i = 0; i < 10 * lod + 2; i++) {
      p = resetP();
      p.x = position.x + (rnd() - 0.5) * 1.2 * sq; p.y = position.y + 0.3; p.z = position.z + (rnd() - 0.5) * 1.2 * sq;
      p.vx = (rnd() - 0.5) * 2; p.vy = 6 + rnd() * 6 * sq; p.vz = (rnd() - 0.5) * 2;
      p.life = 0.9 + rnd() * 0.7; p.size0 = 2.2 * sq; p.size1 = 3.6 * sq; p.heat = 0.8 + rnd() * 0.2; p.alpha = 1;
      p.drag = 1.6; p.grav = -1; p.seed = 10 + rnd(); p.delay = rnd() * 0.12;
      this.flames.emit(p);
    }
    // smoke column + mushroom
    const nSmoke = Math.round(34 * Pw * lod + 4);
    for (let i = 0; i < nSmoke; i++) {
      p = resetP();
      _v.set(rnd() - 0.5, 0.3 + rnd() * 0.7, rnd() - 0.5).normalize();
      p.x = position.x + _v.x * sq; p.y = position.y + 0.5 + rnd() * 1.5 * sq; p.z = position.z + _v.z * sq;
      const s = (2 + rnd() * 5) * sq;
      p.vx = _v.x * s; p.vy = (2.5 + rnd() * 5) * sq; p.vz = _v.z * s;
      p.life = 6 + rnd() * 6; p.size0 = 2.6 * sq; p.size1 = (9 + rnd() * 6) * sq / Math.sqrt(lod);
      const g = 0.03 + rnd() * 0.05;
      p.r = g; p.g = g * 0.95; p.b = g * 0.9; p.r1 = 0.2; p.g1 = 0.19; p.b1 = 0.18;
      p.alpha = 0.66; p.drag = 1.3; p.grav = -0.3; p.wind = 0.45; p.heat = 0.9; p.fadeIn = 0.35;
      p.delay = 0.05 + rnd() * 0.35; p.spin = (rnd() - 0.5) * 0.5; p.floor = ground + 0.5;
      this.puffs.emit(p);
    }
    // sparks
    const floorY = ground;
    const nSpark = Math.round(55 * Pw * lod);
    for (let i = 0; i < nSpark; i++) {
      p = resetP();
      _v.set(rnd() - 0.5, rnd() * 0.9 + 0.05, rnd() - 0.5).normalize();
      const s = (10 + rnd() * 22) * sq;
      p.x = position.x; p.y = position.y + 0.6; p.z = position.z;
      p.vx = _v.x * s; p.vy = _v.y * s; p.vz = _v.z * s;
      p.life = 0.7 + rnd() * 1.4; p.size0 = 0.08 + rnd() * 0.06; p.size1 = 0.04;
      p.r = 5; p.g = 2.4; p.b = 0.7; p.r1 = 2.5; p.g1 = 0.5; p.b1 = 0.1; p.alpha = 1; p.drag = 0.5; p.grav = 9.81; p.fadeIn = 0; p.floor = floorY;
      this.sparkSys.emit(p);
    }
    // hot metal bits
    this.bits({ x: position.x, y: position.y + 0.6, z: position.z }, { material: 'metal', count: 22 * Pw, speed: 9 * sq, size: 0.13, life: 4 });
    // a few physical chunks
    if (o.debris !== false) {
      this.debrisSys.spawn({ x: position.x, y: position.y + 0.7, z: position.z }, {
        count: Math.round(3 + 3 * Pw * lod), size: 0.35, color: [0x2b2b2e, 0x3d3a37, 0x55504a], impulse: 11 * sq, up: 1.2, life: 9, spin: 12, density: 1400,
      });
    }
    // ground: dust ring, shockwave, scorch
    if (nearGround) {
      const gp = { x: position.x, y: ground + 0.15, z: position.z };
      const nDust = Math.round(22 * sq * lod + 4);
      for (let i = 0; i < nDust; i++) {
        const a = (i / nDust) * 6.283 + rnd() * 0.3;
        const s = (8 + rnd() * 6) * sq;
        p = resetP();
        p.x = gp.x + Math.cos(a) * 1.2; p.y = gp.y + 0.3; p.z = gp.z + Math.sin(a) * 1.2;
        p.vx = Math.cos(a) * s; p.vy = 0.6 + rnd(); p.vz = Math.sin(a) * s;
        p.life = 1.6 + rnd() * 1.4; p.size0 = 1.2 * sq; p.size1 = 4.5 * sq;
        p.r = 0.5; p.g = 0.44; p.b = 0.35; p.r1 = 0.62; p.g1 = 0.57; p.b1 = 0.49;
        p.alpha = 0.5; p.drag = 2.6; p.grav = -0.2; p.fadeIn = 0.05; p.floor = ground + 0.3; p.wind = 0.3;
        this.puffs.emit(p);
      }
      this.rings.spawn({ x: gp.x, y: gp.y + 0.25, z: gp.z }, R * 1.6, 0.55, { color: 0xffd9a8, alpha: 2.8 });
      this.rings.spawn({ x: gp.x, y: gp.y + 1.2, z: gp.z }, R * 1.1, 0.3, { color: 0xffffff, alpha: 1.4, inner: 0.82 }); // fast pressure front
      if (o.scorch !== false) this.decals.addGround(gp, 4.5 * sq, { heat: 1 });
    } else {
      this.rings.spawn(position, R * 1.1, 0.45, { color: 0xffd9a8, alpha: 1.6, tilt: _v.set(camPos.x - position.x, camPos.y - position.y, camPos.z - position.z) });
    }
    if (o.fire) this.fire({ x: position.x, y: ground + 0.05, z: position.z }, { size: 0.8 * sq, duration: o.fire, smoke: 'dark' });

    // camera
    const sh = Pw * 1.9 * Math.pow(Math.max(0, 1 - dCam / (120 * sq)), 1.6);
    this.addShake(sh);
    if (Pw >= 2 && dCam < 45) this.slowmo(0.3, 0.9);

    this.stats.explosions++;
    game.events?.emit('explosion', info);
    this.stats.lastExplodeMs = performance.now() - t0;
    this.stats.maxExplodeMs = Math.max(this.stats.maxExplodeMs, this.stats.lastExplodeMs);
    return info;
  }

  // ---------- internals ----------

  // one smoke/dust puff from a look preset
  _puff(look, x, y, z, size = 1, heat = 0, floor = -1e9, density = 1, vel = null) {
    const p = resetP();
    p.x = x; p.y = y; p.z = z;
    const rise = look.rise * (0.7 + rnd() * 0.6);
    p.vx = (vel?.x || 0) + (rnd() - 0.5) * 0.6; p.vy = (vel?.y ?? 0) + rise; p.vz = (vel?.z || 0) + (rnd() - 0.5) * 0.6;
    p.life = look.life * (0.75 + rnd() * 0.5) * (0.7 + 0.3 * Math.min(2, size));
    p.size0 = 0.7 * size * look.size; p.size1 = 3.2 * size * look.size * (0.8 + rnd() * 0.5);
    const sh = 0.9 + rnd() * 0.2;
    p.r = look.c0[0] * sh; p.g = look.c0[1] * sh; p.b = look.c0[2] * sh;
    p.r1 = look.c1[0]; p.g1 = look.c1[1]; p.b1 = look.c1[2];
    p.alpha = look.alpha * density; p.drag = 0.7; p.grav = -0.15; p.wind = 0.28; p.heat = heat;
    p.fadeIn = 0.25; p.spin = (rnd() - 0.5) * 0.6; p.floor = floor;
    this.puffs.emit(p);
  }

  _floorFast(pos) {
    const h = this.game.terrain?.heightAt?.(pos.x, pos.z);
    return h === undefined ? -1e9 : Math.min(pos.y - 0.05, Math.max(h, h < 0 ? 0 : h));
  }

  _lodAt(pos) {
    const c = this.game.camera.position;
    const d = Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z);
    return d < 60 ? 1 : d < 200 ? 0.6 : d < 500 ? 0.3 : d < 1200 ? 0.1 : 0;
  }

  // radial impulse on every dynamic body in the blast radius
  _blast(pos, Pw, R, exclude) {
    const { world, RAPIER } = this.game;
    if (!world || !RAPIER) return;
    const ex = new Set((exclude || []).map((b) => b?.handle));
    const seen = new Set();
    const shape = new RAPIER.Ball(R);
    const bodies = [];
    world.intersectionsWithShape(pos, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
      const b = c.parent();
      if (b && !seen.has(b.handle)) { seen.add(b.handle); bodies.push(b); }
      return true;
    }, RAPIER.QueryFilterFlags.EXCLUDE_FIXED);
    for (const b of bodies) {
      if (!b.isDynamic() || ex.has(b.handle)) continue;
      const c = b.worldCom ? b.worldCom() : b.translation();
      const dx = c.x - pos.x, dy = c.y - pos.y, dz = c.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      const f = Math.pow(Math.max(0, 1 - d / R), 1.05);
      if (f <= 0) continue;
      const m = b.mass();
      const dv = 21 * Pw * f * (m < 150 ? 1.6 : 1); // Δv at the centre: ~21 m/s for a car bomb
      const hd = Math.hypot(dx, dz) || 1;
      _v.set(dx, Math.max(dy, 0) + d * 0.85 + 2, dz).normalize();
      const J = Math.min(m * dv, 150000 * Pw);
      const hx = dx / hd, hz = dz / hd;
      const pt = { x: c.x - hx * 0.8, y: c.y - 0.3, z: c.z - hz * 0.8 };
      b.applyImpulseAtPoint({ x: _v.x * J, y: _v.y * J, z: _v.z * J }, pt, true);
    }
  }

  // minimal reaction when no DamageSystem is registered
  _fallbackWorld(pos, Pw, R) {
    const game = this.game;
    const tr = game.traffic;
    if (tr) for (const a of tr.agents) {
      const d = Math.hypot(a.cur.x - pos.x, a.cur.z - pos.z);
      if (d < R) tr.crash(a, { x: (a.cur.x - pos.x) / (d || 1), z: (a.cur.z - pos.z) / (d || 1) });
    }
    for (const t of game.veg?.query?.(pos.x, pos.z, R * 0.6) || []) {
      const dx = (game.veg.scatters?.[t.type]?.raw?.[t.id * 6] ?? pos.x) - pos.x;
      const dz = (game.veg.scatters?.[t.type]?.raw?.[t.id * 6 + 2] ?? pos.z) - pos.z;
      const l = Math.hypot(dx, dz) || 1;
      game.veg.breakTree?.(t.type, t.id, { x: dx / l, z: dz / l }, Pw);
    }
    for (const id of game.buildings?.query?.(pos.x, pos.z, R) || []) game.buildings.damage?.(id, 0.3 * Pw);
  }

  update(dt, game) {
    const sdt = dt * (game.timeScale ?? 1);
    if (!this._prewarmed && game.frame > 1) this.prewarm();
    this._frameBlasts = 0;
    let fires = 0;
    for (const e of this.emitters) if (e.kind === 'fire' && e.alive) fires++;
    this.fireShare = fires > this.maxFires ? this.maxFires / fires : 1;
    const q = game.quality;
    if (q?.particlesMax) {
      // runtime quality changes shrink the effective pools (capacity itself is fixed at start)
      this.flames.limit = Math.round(q.particlesMax * this.shares.flames);
      this.puffs.limit = Math.round(q.particlesMax * this.shares.puffs);
      this.sparkSys.limit = Math.round(q.particlesMax * this.shares.sparks);
    }
    const u = game.uniforms;
    const time = u?.uTime?.value ?? game.time ?? 0;
    const night = u?.uNight?.value ?? 0;
    const sun = u?.uSunDir?.value;
    const cam = game.camera;
    if (sun) this._sunView.copy(sun).transformDirection(cam.matrixWorldInverse);
    const sunUp = sun ? Math.min(1, Math.max(0.15, sun.y * 4)) : 1;
    this.flashLevel = Math.max(0, this.flashLevel - dt * 3);
    const amb = THREE.MathUtils.lerp(0.62, 0.09, night) + this.flashLevel * 0.6;
    const sunL = THREE.MathUtils.lerp(0.72, 0.05, night) * sunUp;
    const wind = u?.uWind?.value;
    for (const s of [this.flames, this.puffs, this.sparkSys]) {
      s.uniforms.uTime.value = time;
      s.uniforms.uSunView.value.copy(this._sunView);
      s.uniforms.uAmbient.value = amb;
      s.uniforms.uSunLight.value = sunL;
      s.windVec.x = wind ? wind.x : 0;
      s.windVec.z = wind ? wind.z : 0;
    }
    this.flames.uniforms.uIntensity.value = THREE.MathUtils.lerp(1, 1.5, night);

    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      if (!e.update(sdt)) {
        this.emitters.splice(i, 1);
        if (e.lightSrc) this.lights.remove(e.lightSrc);
        if (e.kind === 'fire') game.events?.emit('fire:stop', { position: e.position, target: e.attachTo ?? null });
      }
    }
    this.flames.update(sdt);
    this.puffs.update(sdt);
    this.sparkSys.update(sdt);
    this.chunks.update(sdt, time);
    this.debrisSys.update(sdt);
    this.decals.update(sdt);
    this.rings.update(sdt);
    this.lights.update(dt, cam.position);

    // camera shake decays in real time
    this.shake = Math.max(0, this.shake - dt * 1.6);
    // slow motion (never fights the wasted screen, which sets timeScale itself)
    if (this._slow) {
      const s = this._slow;
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      const scale = s.scale + (1 - s.scale) * k * k;
      if (game.player?.wastedT > 0 || k >= 1) {
        if (game.timeScale === s.last) game.timeScale = 1;
        this._slow = null;
      } else {
        game.timeScale = Math.min(game.timeScale ?? 1, scale);
        s.last = game.timeScale;
      }
    }
  }

  get particleCount() { return this.flames.count + this.puffs.count + this.sparkSys.count + this.chunks.count; }

  clear() {
    for (const e of this.emitters) e.alive = false;
    this.emitters.length = 0;
    this.flames.clear(); this.puffs.clear(); this.sparkSys.clear(); this.chunks.clear();
    this.debrisSys.clear();
    this.decals.clear();
    this.lights.clear();
  }

  dispose() {
    this.clear();
    this.flames.dispose(); this.puffs.dispose(); this.sparkSys.dispose(); this.chunks.dispose();
    this.debrisSys.dispose(); this.decals.dispose(); this.lights.dispose(); this.rings.dispose();
  }
}

export { SMOKE as SMOKE_LOOKS };
