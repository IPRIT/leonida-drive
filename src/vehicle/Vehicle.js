// THREE.js-facing vehicle: physics core + procedural model + lights + effects emission.
import * as THREE from 'three';
import { VehiclePhysics } from './physics/VehiclePhysics.js';
import { buildCarModel, CLEARCOAT_MIN } from './CarModel.js';
import { getCatalogEntry } from './catalog.js';
import { initHeadlightPool, headlightPool, claimHeadlights, releaseHeadlights } from './headlights.js';
import { patchDurability } from './durability.js';

let UID = 0;
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _f = new THREE.Vector3();

// ---------- headlight pool (src/vehicle/headlights.js) ----------
const POOLS = { get: (scene) => headlightPool(scene) };
const HEAD_INTENSITY = 38;
export { initHeadlightPool };
const _TINT = new THREE.Color(0x040506);
// clearcoat values stay above CLEARCOAT_MIN (the clearcoat shader variant is compiled once at spawn)
const PAINT_FINISH = {
  gloss: { roughness: 0.26, metalness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.1 },
  metallic: { roughness: 0.3, metalness: 0.75, clearcoat: 0.45, clearcoatRoughness: 0.14 },
  pearl: { roughness: 0.2, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.04 },
  matte: { roughness: 0.62, metalness: 0.1, clearcoat: CLEARCOAT_MIN, clearcoatRoughness: 0.2 },
};

export class Vehicle {
  /**
   * @param {object} o
   * @param {object} o.RAPIER initialized Rapier module
   * @param {object} o.world RAPIER.World
   * @param {THREE.Object3D} o.scene
   * @param {string|object} [o.preset='comet'] catalog / preset id (or preset object)
   * @param {number} [o.color] paint color (hex)
   * @param {number} [o.color2] secondary paint
   * @param {THREE.Vector3|{x,y,z}} [o.position] ground point under the car
   * @param {number} [o.yaw=0] heading (radians, three.js rotation.y; 0 = facing -Z)
   * @param {object} [o.env] { getSurface(x,z), waterLevel }
   * @param {SkidMarks} [o.skidMarks]
   * @param {TireSmoke} [o.tireSmoke]
   * @param {boolean} [o.spotLights=true] may use the pooled headlight SpotLights (player car)
   * @param {'high'|'low'} [o.quality='high'] wheel raycast quality (low = 1 ray/wheel)
   */
  constructor(o) {
    this.uid = ++UID;
    this.scene = o.scene;
    this.physics = new VehiclePhysics({
      RAPIER: o.RAPIER,
      world: o.world,
      preset: o.preset || 'comet',
      position: o.position || { x: 0, y: 0, z: 0 },
      yaw: o.yaw || 0,
      env: o.env,
      quality: o.quality,
    });
    this.spec = this.physics.spec;
    this.preset = this.spec.name;
    const entry = typeof o.preset === 'string' ? getCatalogEntry(o.preset) : null;
    this.catalogId = entry?.id ?? this.preset;
    this.entry = entry || null;
    this.kind = entry?.kind || this.spec.kind || 'car';
    this.name = entry?.name || this.spec.label || this.preset;
    this.brand = entry?.brand || '';
    this.engineSound = entry?.engineSound || null;
    this.occupied = false;
    this.skidMarks = o.skidMarks || null;
    this.tireSmoke = o.tireSmoke || null;
    this.spotLightsEnabled = o.spotLights !== false;
    this.castShadow = o.castShadow !== false;

    this.color = o.color ?? this.spec.color;
    const model = buildCarModel(this.spec, { color: this.color, color2: o.color2 ?? entry?.palette2, lod: 'high', castShadow: this.castShadow });
    this.model = model;
    this.materials = model.materials;
    this.parts = model.parts;

    const r = this.spec.wheelRadius;
    this.object3d = new THREE.Group();
    this.object3d.name = `vehicle:${this.preset}`;
    this.object3d.userData.vehicle = this;
    // two-wheelers lean around the tyre contact line; the wheelie pivots on the rear contact
    this.leanGroup = new THREE.Group();
    this.leanGroup.position.set(0, -r, 0);
    this.wheelieGroup = new THREE.Group();
    this.wheelieGroup.position.set(0, 0, this.spec.wheelbase / 2);
    const inner = new THREE.Group();
    inner.position.set(0, r, -this.spec.wheelbase / 2);
    this.leanGroup.add(this.wheelieGroup);
    this.wheelieGroup.add(inner);
    this.object3d.add(this.leanGroup);
    // body pivot at the CoM height so visual roll/pitch rotates around a natural point
    this.leanPivot = new THREE.Group();
    this.leanPivot.position.set(0, this.spec.com.y, this.spec.com.z);
    model.body.position.set(0, -r - this.spec.com.y, -this.spec.com.z);
    this.leanPivot.add(model.body);
    inner.add(this.leanPivot);
    this.wheelVisuals = model.wheels;
    for (const w of model.wheels) inner.add(w.pivot);
    this.scene.add(this.object3d);

    // semantic points (object3d local space: origin at wheel-centre height, -Z forward)
    const toLocal = (p) => new THREE.Vector3(p[0] ?? p.x, (p[1] ?? p.y) - r, p[2] ?? p.z);
    const pose = model.seatPose || (this.kind === 'motorcycle' || this.kind === 'bicycle' ? 'bike' : this.kind === 'truck' || this.kind === 'bus' ? 'truck' : 'car');
    const halfW = model.dims.width / 2;
    this.seats = model.seats.map((s, i) => ({
      pos: toLocal(s),
      exit: toLocal({ x: pose === 'bike' ? -0.75 : Math.sign(s.x || -1) * (halfW + 0.6), y: Math.max(r, 0.4), z: s.z }),
      pose,
      driver: i === 0,
    }));
    this.doors = model.doors.flatMap((d) => (d.side ? [toLocal({ x: d.side * halfW, y: d.y, z: d.z })] : [toLocal({ x: -halfW, y: d.y, z: d.z }), toLocal({ x: halfW, y: d.y, z: d.z })]));
    this.enginePos = toLocal(model.enginePos);
    this.exhaustPos = toLocal(model.exhaustPos);
    this.dims = { ...model.dims };

    // per-side indicator materials (cloned once here, never on toggle)
    this._amberL = this.materials.amber.clone();
    this._amberR = this.materials.amber.clone();
    this._indicatorMeshes = [];
    for (const m of model.parts.lights.children) {
      const n = m.userData.lamp || '';
      if (m.userData.kind !== 'amber' || !/^(ind|mark)/.test(n)) continue;
      m.material = n.includes('L') ? this._amberL : this._amberR;
      this._indicatorMeshes.push(m);
    }
    this.indicator = 0; // -1 left, 1 right, 2 hazard
    // anchors for the pooled headlight beams (follow lean / wheelie)
    const heads = (model.lamps.head || []).slice().sort((a, b) => a[0] - b[0]);
    const pick = heads.length > 1 ? [heads[0], heads[heads.length - 1]] : heads;
    this._lampAnchors = pick.map((p) => {
      const a = new THREE.Object3D();
      a.position.set(p[0], p[1], p[2]);
      model.body.add(a);
      return a;
    });
    if (this.spotLightsEnabled) initHeadlightPool(this.scene);

    this.headlightsOn = false;
    this._siren = false;
    this._sirenTime = 0;
    this._popup = 0;
    this._lean = { roll: 0, pitch: 0 };
    this._time = 0;
    this._blink = 0;
    this._crank = 0;
    this._drum = 0;
    this._emitAcc = new Float32Array(this.physics.wheels.length);
    this._skidOn = this.physics.wheels.map(() => false);
    this._brakeGlow = 0;
    this._lastImpactSeen = 0;
    this.onImpact = null;
    this.updateVisual(1, 0);
  }

  // ---- physics pass-through ----
  // E's VehicleDamage (DamageSystem.attach sets it): the player's car is tougher (src/vehicle/durability.js)
  get damage() {
    return this._damage || null;
  }
  set damage(st) {
    this._damage = st || null;
    if (st) patchDurability(this, st);
  }

  get body() {
    return this.physics.body;
  }
  get telemetry() {
    return this.physics.telemetry;
  }
  get drowned() {
    return this.physics.drowned;
  }
  set drowned(v) {
    this.physics.drowned = v;
  }
  get assists() {
    return this.physics.assists;
  }
  set assists(v) {
    Object.assign(this.physics.assists, v);
  }
  get env() {
    return this.physics.env;
  }
  set env(v) {
    this.physics.env = v;
  }
  /** Two-wheelers: rider is down (see physics.autoRecover). */
  get fallen() {
    return this.physics.fallen;
  }
  /** Damage hook: the headlamp on the side of local x (null = all) is broken -> its pooled beam goes out. */
  breakHeadlight(x = null) {
    this._lampOut ??= [];
    this._lampAnchors.forEach((a, i) => {
      if (x === null || Math.abs(x) < 0.1 || Math.sign(a.position.x) === Math.sign(x)) this._lampOut[i] = true;
    });
  }

  /** Repair hook: headlamp beams work again. */
  repairHeadlights() { this._lampOut = []; }

  get spots() {
    const pool = POOLS.get(this.scene);
    return pool && pool.owner === this ? pool.lights : null;
  }
  get siren() {
    return this._siren;
  }
  set siren(v) {
    // only emergency vehicles (police, ambulance, fire) carry a lightbar and a siren
    this._siren = !!v && !!this.model.lightbar;
    if (!this._siren && this.model.lightbar) {
      this.materials.sirenRed.emissiveIntensity = 0.05;
      this.materials.sirenBlue.emissiveIntensity = 0.05;
    }
  }
  get hasSiren() {
    return !!this.model.lightbar;
  }

  fixedUpdate(dt, input) {
    this.physics.fixedUpdate(dt, input);
  }

  /** Remove persistent physics forces (use if you pause calling fixedUpdate for this vehicle). */
  clearForces() {
    this.physics.clearForces();
  }

  reset(position, yaw = 0) {
    this.physics.reset(position, yaw);
    if (this.skidMarks) for (let i = 0; i < this.physics.wheels.length; i++) this.skidMarks.end(this._track(i));
    this.updateVisual(1, 0);
  }

  setColor(hex) {
    this.color = hex;
    this.materials.paint.color.set(hex);
    this._rebase(this.materials.paint);
  }

  /** Window tint 0..1 (glass uniforms only, no new materials). */
  setWindowTint(k) {
    const m = this.materials.glass;
    if (!m) return;
    const b = (this._glassBase ||= { color: m.color.getHex(), roughness: m.roughness, metalness: m.metalness });
    k = Math.max(0, Math.min(1, +k || 0));
    this.windowTint = k;
    m.color.setHex(b.color).lerp(_TINT, k);
    m.roughness = b.roughness + (0.04 - b.roughness) * k;
    m.metalness = b.metalness + (0.85 - b.metalness) * k;
    this._rebase(m);
  }

  /**
   * Paint finish: 'color' (factory), 'gloss', 'metallic', 'pearl' (full clearcoat), 'matte'. Adjusts the existing
   * paint material's uniforms only (no new material, no recompile).
   */
  setPaintFinish(finish = 'color') {
    const m = this.materials.paint;
    const b = (this._paintBase ||= { roughness: m.roughness, metalness: m.metalness, clearcoat: m.clearcoat ?? 0, clearcoatRoughness: m.clearcoatRoughness ?? 0 });
    const f = PAINT_FINISH[finish] || b;
    this.paintFinish = this.finish = PAINT_FINISH[finish] ? finish : 'color';
    m.roughness = f.roughness;
    m.metalness = f.metalness;
    if (m.isMeshPhysicalMaterial) {
      m.clearcoat = Math.max(CLEARCOAT_MIN, f.clearcoat ?? b.clearcoat);
      m.clearcoatRoughness = f.clearcoatRoughness ?? b.clearcoatRoughness;
    }
    this._rebase(m);
  }

  /** Alias of setPaintFinish (UI). */
  setFinish(finish) {
    this.setPaintFinish(finish);
  }

  /** Respray: { color?: hex, finish?: 'color'|'gloss'|'metallic'|'pearl'|'matte' }. */
  setPaint({ color, finish } = {}) {
    if (color !== undefined && color !== null) this.setColor(color);
    if (finish) this.setPaintFinish(finish);
  }

  /** Nitro to full. */
  refillBoost() {
    this.physics.boostLevel = 1;
    this.physics.boostCooldown = 0;
  }

  /** Nitro level 0..1 (null without nitro). */
  get boostLevel() {
    return this.spec.boost ? this.physics.boostLevel : null;
  }

  // keep E's damage snapshot (used by repair / charring) in sync with deliberate material changes
  _rebase(m) {
    const s = this.damage?.mats?.get?.(m);
    if (!s) return;
    s.color = m.color.getHex();
    if (m.roughness !== undefined) s.roughness = m.roughness;
    if (m.metalness !== undefined) s.metalness = m.metalness;
  }

  setHeadlights(on) {
    this.headlightsOn = !!on;
    const pool = this.spotLightsEnabled ? POOLS.get(this.scene) : null;
    if (!pool) return;
    if (this.headlightsOn && (!pool.owner || pool.owner === this || this.occupied || !pool.owner.occupied || !pool.owner.headlightsOn)) claimHeadlights(pool, this);
    if (pool.owner === this && !this.headlightsOn) for (const s of pool.lights) s.intensity = 0;
  }

  /** -1 left, 1 right, 0 off, 2 hazard lights. */
  setIndicator(dir) {
    this.indicator = dir | 0;
    if (!this.indicator) this._amberL.emissiveIntensity = this._amberR.emissiveIntensity = this.headlightsOn ? 0.9 : 0.25;
  }

  _track(i) {
    return `v${this.uid}w${i}`;
  }

  /** Interpolate & animate. alpha in [0,1] between previous and current physics state. */
  updateVisual(alpha = 1, frameDt = 0) {
    const ph = this.physics;
    const body = ph.body;
    const tel = ph.telemetry;
    this._time += frameDt;

    const t = body.translation();
    const r = body.rotation();
    const pp = ph.prevPos;
    const pr = ph.prevRot;
    this.object3d.position.set(pp.x + (t.x - pp.x) * alpha, pp.y + (t.y - pp.y) * alpha, pp.z + (t.z - pp.z) * alpha);
    _q0.set(pr.x, pr.y, pr.z, pr.w);
    _q1.set(r.x, r.y, r.z, r.w);
    this.object3d.quaternion.slerpQuaternions(_q0, _q1, alpha);

    // wheels (visuals may outnumber physics wheels: tandem axles, duals, single front wheel)
    let steerNow = 0;
    for (const vis of this.wheelVisuals) {
      const w = ph.wheels[vis.phys] || ph.wheels[0];
      const dist = w.prevDist + (w.dist - w.prevDist) * alpha;
      const steer = w.prevSteer + (w.steer - w.prevSteer) * alpha;
      vis.pivot.position.set(vis.x, w.mountY - dist + (vis.r - w.radius), vis.z);
      vis.pivot.rotation.y = vis.steer ? -steer : 0;
      vis.spin.rotation.x = -(w.prevSpin + (w.spin - w.prevSpin) * alpha) * (w.radius / vis.r);
      if (vis.steer) steerNow = steer;
    }
    if (this.model.steer) this.model.steer.rotation.y = -steerNow;
    // animated bits
    if (frameDt > 0) {
      const rw = ph.wheels[ph.wheels.length - 1];
      if (this.model.extra.crank) {
        this._crank -= rw.omega * frameDt * 0.42 * (tel.throttle > 0.05 || Math.abs(rw.omega) > 0.5 ? 1 : 0);
        this.model.extra.crank.rotation.x = this._crank;
      }
      if (this.model.extra.drum) {
        this._drum += frameDt * 1.6;
        this.model.extra.drum.rotateOnAxis(_n.set(0, Math.sin(0.2), -Math.cos(0.2)).normalize(), frameDt * 1.6);
      }
    }

    // visual lean: two-wheelers lean into turns; cars get a subtle extra roll/pitch on top of physics
    if (this.spec.twoWheel) {
      this.leanGroup.rotation.z = -tel.lean;
      this.wheelieGroup.rotation.x = tel.wheelie;
    } else if (frameDt > 0) {
      const k = 1 - Math.exp(-frameDt * 6);
      const tr = THREE.MathUtils.clamp(-tel.latAccel * 0.0028, -0.03, 0.03) * (tel.airborne ? 0 : 1);
      const tp = THREE.MathUtils.clamp(tel.longAccel * 0.0022, -0.025, 0.025) * (tel.airborne ? 0 : 1);
      this._lean.roll += (tr - this._lean.roll) * k;
      this._lean.pitch += (tp - this._lean.pitch) * k;
      this.leanPivot.rotation.set(this._lean.pitch, 0, this._lean.roll);
    }

    this._updateLights(frameDt);
    if (frameDt > 0) this._emitEffects(frameDt);

    if (tel.impactId !== this._lastImpactSeen) {
      this._lastImpactSeen = tel.impactId;
      if (this.onImpact) this.onImpact(tel.impactStrength);
    }
  }

  _updateLights(dt) {
    const m = this.materials;
    const tel = this.telemetry;
    const on = this.headlightsOn;
    // pop-ups
    if (this.model.popups.length) {
      const target = on ? 1 : 0;
      this._popup += Math.sign(target - this._popup) * Math.min(Math.abs(target - this._popup), dt * 3.5);
      const a = -0.21 + this._popup * 1.25;
      for (const p of this.model.popups) p.rotation.x = a;
    }
    m.head.emissiveIntensity = on ? 2.4 : 0.12;
    const braking = tel.braking && Math.abs(tel.forwardSpeed) > 0.3 ? 1 : tel.braking ? 0.6 : 0;
    this._brakeGlow += (braking - this._brakeGlow) * Math.min(1, dt * 18 || 1);
    m.tail.emissiveIntensity = (on ? 0.75 : 0.2) + this._brakeGlow * (on ? 1.3 : 1.7);
    m.reverse.emissiveIntensity = tel.reversing ? 2.2 : 0;
    m.amber.emissiveIntensity = on ? 0.9 : 0.25;
    // indicators
    if (this.indicator) {
      this._blink += dt;
      const lit = this._blink % 0.75 < 0.4 ? 2.6 : 0.1;
      this._amberL.emissiveIntensity = this.indicator === -1 || this.indicator === 2 ? lit : 0.25;
      this._amberR.emissiveIntensity = this.indicator === 1 || this.indicator === 2 ? lit : 0.25;
    } else {
      this._amberL.emissiveIntensity = this._amberR.emissiveIntensity = on ? 0.9 : 0.25;
    }
    if (this._siren && this.model.lightbar) {
      this._sirenTime += dt;
      const ph = (this._sirenTime * 2.4) % 1;
      const strobe = (x) => (x % 0.25 < 0.12 ? 1 : 0);
      const red = ph < 0.5 ? strobe(ph) : 0;
      const blue = ph >= 0.5 ? strobe(ph - 0.5) : 0;
      m.sirenRed.emissiveIntensity = 0.1 + red * 6;
      m.sirenBlue.emissiveIntensity = 0.1 + blue * 7;
    }
    // pooled beams
    const pool = this.spotLightsEnabled ? POOLS.get(this.scene) : null;
    if (pool && pool.owner === this) {
      if (!on) {
        for (const s of pool.lights) s.intensity = 0;
      } else {
        this.object3d.updateMatrixWorld(true);
        _f.set(0, 0, -1).applyQuaternion(this.object3d.quaternion);
        _n.set(0, 1, 0).applyQuaternion(this.object3d.quaternion);
        for (let i = 0; i < pool.lights.length; i++) {
          const s = pool.lights[i];
          const a = this._lampAnchors[i];
          if (!a) {
            s.intensity = 0;
            continue;
          }
          a.getWorldPosition(s.position);
          s.target.position.copy(s.position).addScaledVector(_f, 20).addScaledVector(_n, -1.6);
          s.target.updateMatrixWorld();
          // a smashed headlamp casts no beam
          s.intensity = this._lampOut?.[i] ? 0 : this._lampAnchors.length === 1 ? HEAD_INTENSITY * 1.3 : HEAD_INTENSITY;
        }
      }
    }
  }

  _emitEffects(dt) {
    const ph = this.physics;
    const skids = this.skidMarks;
    const smoke = this.tireSmoke;
    if (!skids && !smoke) return;
    const lin = ph.body.linvel();
    const speed = Math.hypot(lin.x, lin.y, lin.z);
    for (let i = 0; i < ph.wheels.length; i++) {
      const w = ph.wheels[i];
      const id = this._track(i);
      if (!w.contact) {
        if (skids) skids.end(id);
        continue;
      }
      const surf = w.surface.name;
      const loose = w.surface.dust || surf === 'dirt' || surf === 'sand' || surf === 'grass';
      const skid = w.skid;
      if (skids) {
        const on = (this._skidOn[i] = skid > (this._skidOn[i] ? 0.06 : 0.14));
        if (on && !w.inWater && (surf === 'asphalt' || surf === 'wet' || surf === 'concrete')) {
          _p.set(w.point.x, w.point.y, w.point.z);
          _s.set(w.side.x, w.side.y, w.side.z);
          _n.set(w.normal.x, w.normal.y, w.normal.z);
          skids.emit(id, _p, _s, _n, w.width * 0.9, Math.min(1, 0.25 + skid) * (surf === 'wet' ? 0.5 : 1));
        } else skids.end(id);
      }
      if (!smoke) continue;
      let kind = null;
      let rate = 0;
      if (w.inWater && speed > 2) {
        kind = 'splash';
        rate = Math.min(60, speed * 3);
      } else if (loose && (speed > 4 || skid > 0.1)) {
        kind = surf === 'grass' ? 'grass' : 'dust';
        rate = Math.min(45, speed * 0.9 + skid * 40) * (surf === 'grass' ? 0.5 : 1);
      } else if (skid > 0.25 && !loose) {
        kind = 'smoke';
        rate = (skid - 0.2) * 70;
      }
      if (!kind) continue;
      this._emitAcc[i] += rate * dt;
      while (this._emitAcc[i] >= 1) {
        this._emitAcc[i] -= 1;
        const jx = (Math.random() - 0.5) * 0.3, jz = (Math.random() - 0.5) * 0.3;
        smoke.emit(kind, w.point.x + jx, w.point.y + 0.15, w.point.z + jz, lin.x * 0.25, 0, lin.z * 0.25, kind === 'smoke' ? 0.8 + skid * 0.6 : 1);
      }
    }
  }

  dispose() {
    releaseHeadlights(POOLS.get(this.scene), this);
    this.object3d.removeFromParent();
    this.object3d.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of Object.values(this.materials)) m.dispose();
    this._amberL.dispose();
    this._amberR.dispose();
    if (this.skidMarks) for (let i = 0; i < this.physics.wheels.length; i++) this.skidMarks.tracks.delete(this._track(i));
    this.physics.dispose();
  }
}
