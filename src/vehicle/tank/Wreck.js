// Tank destruction effects, shared by the local Tank and the multiplayer replay (playTankWreck):
// ammo cook-off (flame jets from the hatches, small pops), then the main blast, the turret thrown as a physics body
// with spin (impact dust + crater where it lands), the gun bent or torn off, track links, secondary explosions and
// thick black smoke. Every random choice comes from a seeded generator, so clients replaying the same seed agree.
import * as THREE from 'three';
import { TANK, buildTankModel } from './TankModel.js';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const systems = new WeakMap();
const MAX_JOBS = 24;

/** Deterministic PRNG (mulberry32) → () => [0, 1). */
export function seededRandom(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// hatch points (model space: y up from the ground, -Z forward)
const DRIVER_HATCH = [TANK.hatch[0], TANK.deckY + 0.1, TANK.hatch[2] - 0.3];
const CUPOLA = [0.72, 0.8 + 0.3, 0.55]; // turret space
const LOADER = [-0.78, 0.8 + 0.1, 0.75]; // turret space

function shakeNear(game, pos, amount, range) {
  const cam = game.camera?.position;
  if (!cam || !game.fx?.addShake) return;
  const d = cam.distanceTo(_v.set(pos.x, pos.y, pos.z));
  const k = Math.max(0, 1 - d / range);
  if (k > 0) game.fx.addShake(amount * k * k);
}

function safeBody(game, item) {
  if (!item || item.removed || !item.body) return null;
  try { return game.world.getRigidBody(item.body.handle) === item.body ? item.body : null; } catch { return null; }
}

/** Per-game runner for timed wreck jobs (registered once, order 61). */
export class WreckFx {
  static get(game) {
    let s = systems.get(game);
    if (!s) { s = new WreckFx(game); systems.set(game, s); }
    return s;
  }

  constructor(game) {
    this.game = game;
    this.jobs = [];
    game.register?.(this, 61);
  }

  add(job) {
    job.t = 0;
    this.jobs.push(job);
    while (this.jobs.length > MAX_JOBS) { const j = this.jobs.shift(); j.end?.(); }
    return job;
  }

  /** Stop every job of an owner (tank disposed or repaired). */
  cancel(owner) {
    for (const j of this.jobs) if (j.owner === owner) { j.done = true; j.end?.(); j.kill?.(); }
    this.jobs = this.jobs.filter((j) => !j.done);
  }

  update(dt, game) {
    if (!this.jobs.length) return;
    const sdt = dt * (game?.timeScale ?? 1);
    for (const j of this.jobs) {
      if (j.done) continue;
      j.t += sdt;
      try { if (j.step(sdt) === false) j.done = true; } catch (e) { console.warn('[tank] wreck fx', e); j.done = true; }
    }
    if (this.jobs.some((j) => j.done)) this.jobs = this.jobs.filter((j) => !j.done);
  }

  /**
   * Ammo cook-off before the blast. o: { owner, hull (Object3D, model space = tank root), turret (Object3D or null),
   * duration, rnd, onBlast() }. Returns the job (job.done after the blast).
   */
  cookOff(o) {
    const game = this.game, fx = game.fx;
    const rnd = o.rnd;
    const fires = [];
    const points = () => {
      const out = [];
      if (o.hull?.parent) out.push(o.hull.localToWorld(new THREE.Vector3(...DRIVER_HATCH)));
      if (o.turret?.parent) {
        out.push(o.turret.localToWorld(new THREE.Vector3(...CUPOLA)));
        out.push(o.turret.localToWorld(new THREE.Vector3(...LOADER)));
      }
      return out;
    };
    if (fx) {
      if (o.hull) fires.push(fx.fire(points()[0] || o.hull.getWorldPosition(new THREE.Vector3()), { size: 0.55, duration: o.duration + 0.8, attachTo: o.hull, offset: new THREE.Vector3(...DRIVER_HATCH), smoke: 'black', intensity: 1.4, spread: 0.2, light: false }));
      if (o.turret) fires.push(fx.fire(o.turret.getWorldPosition(new THREE.Vector3()), { size: 0.75, duration: o.duration + 0.8, attachTo: o.turret, offset: new THREE.Vector3(...CUPOLA), smoke: 'black', intensity: 1.8, spread: 0.2 }));
    }
    let jetAcc = 0;
    let nextPop = 0.25 + rnd() * 0.3;
    const job = {
      owner: o.owner,
      kind: 'cook',
      step: (dt) => {
        const pts = points();
        if (fx && pts.length) {
          // flame jets: hot sparks blasting straight up out of the hatches, growing towards the blast
          jetAcc += dt * (14 + 30 * Math.min(1, job.t / o.duration));
          while (jetAcc >= 1) {
            jetAcc -= 1;
            const p = pts[(rnd() * pts.length) | 0];
            fx.sparks(p, { x: (rnd() - 0.5) * 0.15, y: 1, z: (rnd() - 0.5) * 0.15 }, 7, { speed: 15 + rnd() * 8, spread: 0.14, life: 0.55, size: 0.09, color: [6, 2.6, 0.7] });
          }
          if (job.t >= nextPop) {
            nextPop += 0.3 + rnd() * 0.45;
            const p = pts[(rnd() * pts.length) | 0];
            fx.explode(p, 0.22 + rnd() * 0.15, { noWorld: true, noPhysics: true, scorch: false, debris: false });
          }
        }
        if (job.t >= o.duration) {
          for (const f of fires) f.stop?.(1.5);
          o.onBlast?.();
          return false;
        }
        return true;
      },
      end: () => { for (const f of fires) f.kill?.(); },
    };
    return this.add(job);
  }

  /**
   * Throw the turret (Object3D, still attached) as a physics body. o: { owner, rnd, vel (hull velocity), up (world
   * quaternion of the hull), barrel ('bend'|'detach'|'keep'), onLand? }. Returns { turret, barrel } debris items.
   */
  throwTurret(turret, o) {
    const game = this.game, fx = game.fx;
    if (!fx?.debrisSys?.spawnMesh || !turret.parent) return null;
    const rnd = o.rnd;
    const out = { turret: null, barrel: null, barrelObj: null };
    // hull-local launch direction, rotated into the world (same throw on every client for the same seed)
    const hq = o.hullQuat || _q.identity();
    const lv = o.vel || { x: 0, y: 0, z: 0 };
    const dir = _v.set((rnd() - 0.5) * 1.2, 0, (rnd() - 0.35) * 1.2).applyQuaternion(hq);
    const up = 9.5 + rnd() * 3.5; // → 4.5–7.5 m high
    const barrel = turret.getObjectByName('barrel');
    if (barrel && o.barrel === 'bend') {
      barrel.rotation.x = -0.32 - rnd() * 0.25;
      barrel.rotation.y = (rnd() - 0.5) * 0.35;
    }
    turret.updateMatrixWorld(true);
    if (barrel && o.barrel === 'detach') {
      barrel.matrixWorld.decompose(barrel.position, barrel.quaternion, barrel.scale);
      barrel.removeFromParent();
      out.barrelObj = barrel;
      out.barrel = fx.debrisSys.spawnMesh(barrel, {
        half: { x: 0.18, y: 0.3, z: 2.9 }, center: { x: 0, y: 0, z: -2.7 }, mass: 1400, life: 70,
        vel: { x: lv.x + dir.x * 6, y: up * 0.8, z: lv.z + dir.z * 6 },
        angvel: { x: (rnd() - 0.5) * 9, y: (rnd() - 0.5) * 6, z: (rnd() - 0.5) * 9 },
        onExpire: (it) => it.obj.removeFromParent(),
      });
    }
    turret.matrixWorld.decompose(turret.position, turret.quaternion, turret.scale);
    turret.removeFromParent();
    out.turret = fx.debrisSys.spawnMesh(turret, {
      half: { x: 1.65, y: 0.42, z: 2.2 }, center: { x: 0, y: 0.4, z: 0.25 }, mass: 9000, life: 75,
      vel: { x: lv.x + dir.x * 4, y: up, z: lv.z + dir.z * 4 },
      angvel: { x: (rnd() - 0.5) * 5, y: (rnd() < 0.5 ? -1 : 1) * (3 + rnd() * 4), z: (rnd() - 0.5) * 5 },
      onExpire: (it) => { it.obj.removeFromParent(); o.onExpire?.(it); },
    });
    // landing: dust, crater, sparks, shake (once per body)
    for (const item of [out.turret, out.barrel]) {
      if (!item) continue;
      let maxDown = 0, air = 0;
      const big = item === out.turret;
      this.add({
        owner: o.owner,
        step: (dt) => {
          const b = safeBody(game, item);
          if (!b) return false;
          const v = b.linvel();
          air += dt;
          if (v.y < -maxDown) maxDown = -v.y;
          if (air > 0.35 && maxDown > 4 && v.y > -1.2) {
            const t = b.translation();
            const gy = game.terrain?.heightAt?.(t.x, t.z) ?? t.y - 0.5;
            const at = { x: t.x, y: Math.max(gy, t.y - 0.6), z: t.z };
            fx.dust?.(at, big ? 3.2 : 1.6, { count: big ? 22 : 10, speed: big ? 5 : 3, rise: 0.8 });
            fx.sparks?.(at, { x: 0, y: 1, z: 0 }, big ? 22 : 10, { speed: 9, spread: 0.9, life: 0.5 });
            if (big) fx.scorch?.(at, 3.6);
            fx.bits?.(at, { material: 'concrete', count: big ? 14 : 6 });
            shakeNear(game, at, big ? 0.9 : 0.35, big ? 60 : 30);
            game.events?.emit('impact', { position: at, strength: big ? 1 : 0.6, kind: 'prop', material: 'metal', source: o.owner });
            game.events?.emit('tank:turretLanded', { position: at, owner: o.owner, part: big ? 'turret' : 'barrel' });
            return false;
          }
          return air < 10;
        },
      });
    }
    return out;
  }

  /** After the blast: secondary pops, thick black smoke and a big fire on the hull. o: { owner, hull, rnd, duration } */
  aftermath(o) {
    const game = this.game, fx = game.fx;
    if (!fx || !o.hull) return null;
    const rnd = o.rnd;
    const ring = new THREE.Vector3(TANK.turret[0], TANK.deckY + 0.2, TANK.turret[2]);
    const handles = [
      fx.fire(o.hull.localToWorld(ring.clone()), { size: 1.5, duration: o.duration ?? 26, attachTo: o.hull, offset: ring.clone(), smoke: 'black', intensity: 1.3, smokeDensity: 1.4 }),
      fx.smoke(o.hull.localToWorld(ring.clone()), { color: 'black', attachTo: o.hull, offset: new THREE.Vector3(0, TANK.deckY + 0.8, 1.6), size: 2.4, rate: 9, duration: 80, density: 1.3 }),
    ];
    const pops = [];
    let t = 0.5;
    for (let i = 0; i < 5; i++) { t += 0.5 + rnd() * 1.6; pops.push({ t, x: (rnd() - 0.5) * 2.6, y: 0.9 + rnd() * 0.8, z: (rnd() - 0.5) * 6, p: 0.25 + rnd() * 0.35 }); }
    const job = {
      owner: o.owner,
      handles,
      step: () => {
        while (pops.length && pops[0].t <= job.t) {
          const p = pops.shift();
          if (!o.hull.parent) continue;
          const w = o.hull.localToWorld(_s.set(p.x, p.y, p.z));
          fx.explode({ x: w.x, y: w.y, z: w.z }, p.p, { noWorld: true, noPhysics: true, scorch: false, debris: false });
          fx.sparks(w, { x: 0, y: 1, z: 0 }, 16, { speed: 11, spread: 0.6, life: 0.7 });
        }
        return pops.length > 0;
      },
      // fire/smoke handles fade on their own (durations); kill them early only when the owner goes away
      kill: () => { for (const h of handles) h?.kill?.(); },
    };
    return this.add(job);
  }

  /** Track links flung from one side (Debris boxes, pooled/capped by FX). */
  trackLinks(hull, side, rnd) {
    const fx = this.game.fx;
    if (!fx?.debris || !hull.parent) return;
    const p = hull.localToWorld(new THREE.Vector3(side * TANK.trackX, 0.5, (rnd() - 0.5) * 4));
    const d = new THREE.Vector3(side, 0.2, 0).applyQuaternion(hull.getWorldQuaternion(_q));
    fx.debris(p, { count: 5, size: 0.5, sizeVar: 0.4, color: [0x2c2b27, 0x3a3833], impulse: 6, dir: { x: d.x, y: d.y, z: d.z }, spread: 0.8, up: 0.9, life: 30, density: 2500 });
  }
}

/**
 * Multiplayer replay of a tank destruction seen from another client (J): the remote tank is rendered instanced, so
 * this builds a throw-away low-LOD turret at the given pose and runs the same seeded sequence (visual only).
 * opts: { position (rigid-body origin, like Vehicle.object3d), quaternion, turretYaw, barrelPitch, color, seed,
 *         velocity, cookOff = true }
 * Returns a handle: { turretDetached (true once the turret flies: hide the instanced turret/barrel), blasted, dispose() }.
 */
export function playTankWreck(game, opts = {}) {
  const sys = WreckFx.get(game);
  const seed = opts.seed >>> 0;
  const rnd = seededRandom(seed);
  const model = buildTankModel({ lod: 'low', color: opts.color ?? 0xc2a878 });
  const anchor = new THREE.Group(); // stands in for the hull (model space)
  const q = opts.quaternion ? new THREE.Quaternion(opts.quaternion.x, opts.quaternion.y, opts.quaternion.z, opts.quaternion.w) : new THREE.Quaternion();
  const pos = opts.position || { x: 0, y: 0, z: 0 };
  anchor.quaternion.copy(q);
  anchor.position.set(pos.x, pos.y, pos.z).add(_v.set(0, -TANK.originY, 0).applyQuaternion(q));
  game.scene.add(anchor);
  const turret = model.turret;
  turret.removeFromParent();
  turret.position.set(TANK.turret[0], TANK.turret[1], TANK.turret[2]);
  turret.rotation.set(0, opts.turretYaw || 0, 0);
  model.barrel.rotation.x = opts.barrelPitch || 0;
  turret.visible = false; // the instanced turret is still shown until the blast
  anchor.add(turret);
  // dispose the rest of the throw-away model now; the turret's own geometry when its debris expires
  const keep = new Set();
  turret.traverse((o) => { if (o.isMesh) keep.add(o.geometry); });
  model.root.traverse((o) => { if (o.isMesh && !keep.has(o.geometry)) o.geometry.dispose(); });
  const handle = { turretDetached: false, blasted: false, seed, anchor };
  const disposeAll = () => {
    turret.removeFromParent();
    turret.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const m of Object.values(model.materials)) { if (m.map && (m === model.materials.trackL || m === model.materials.trackR)) m.map.dispose(); m.dispose(); }
    anchor.removeFromParent();
  };
  const plan = wreckPlan(rnd);
  const blast = () => {
    if (handle.blasted) return;
    handle.blasted = true;
    anchor.updateMatrixWorld(true);
    const c = anchor.localToWorld(new THREE.Vector3(0, 1.2, 1.8));
    game.fx?.explode?.(c, 2.4, { noWorld: true, noPhysics: true });
    turret.visible = true;
    handle.turretDetached = true;
    const items = sys.throwTurret(turret, { owner: handle, rnd, vel: opts.velocity, hullQuat: q, barrel: plan.barrel, onExpire: () => disposeAll() });
    handle.items = items;
    if (!items) disposeAll();
    sys.aftermath({ owner: handle, hull: anchor, rnd, duration: 24 });
    for (const s of plan.links) sys.trackLinks(anchor, s, rnd);
    game.events?.emit('tank:wreckReplay', { handle, seed });
  };
  if (opts.cookOff === false) blast();
  else sys.cookOff({ owner: handle, hull: anchor, turret: null, duration: plan.cook, rnd, onBlast: blast });
  handle.dispose = () => {
    sys.cancel(handle);
    const fx = game.fx;
    for (const it of [handle.items?.turret, handle.items?.barrel]) if (it && !it.removed) fx?.debrisSys?.removeMesh?.(it, false);
    disposeAll();
  };
  return handle;
}

/** Seeded choices for one destruction (same on every client): cook-off time, gun fate, track links. */
export function wreckPlan(rnd) {
  const cook = 1.1 + rnd() * 0.9;
  const b = rnd();
  const barrel = b < 0.45 ? 'bend' : b < 0.8 ? 'detach' : 'keep';
  const l = rnd();
  const links = l < 0.35 ? [-1] : l < 0.7 ? [1] : l < 0.85 ? [-1, 1] : [];
  const sag = [0.06 + rnd() * 0.1, 0.06 + rnd() * 0.1];
  return { cook, barrel, links, sag };
}
