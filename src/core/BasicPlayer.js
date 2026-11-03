import * as THREE from 'three';
import { ChaseCamera, DriveInput, GROUPS, groups } from '../vehicle/index.js';
import { FreeCamera } from '../cam/FreeCamera.js';
import { groundY } from '../characters/util.js';

const _v = new THREE.Vector3();

export function roadSpawn(game, x, z) {
  const { roads, terrain } = game;
  let n = roads.nearest(x, z, 800, (e) => e.kind !== 2 && !e.br);
  if (!n) n = roads.nearest(x, z, 6000);
  if (!n) return { x, z, y: Math.max(terrain.heightAt(x, z), 0) + 0.5, yaw: 0 };
  const [dx, dz] = n.dir;
  const off = Math.min(n.edge.w * 0.25, 3);
  const sx = n.x - dz * off, sz = n.z + dx * off;
  const y = Math.max(terrain.heightAt(sx, sz), n.y, 0) + 0.08;
  return { x: sx, z: sz, y, yaw: Math.atan2(-dx, -dz) };
}

export function headingYaw(obj) {
  const f = _v.set(0, 0, -1).applyQuaternion(obj.quaternion);
  return Math.atan2(-f.x, -f.z);
}

export function recoverVehicle(game, vehicle) {
  if (!vehicle?.body) return;
  const p = vehicle.body.translation();
  let y = groundY(game, p.x, p.z, p.y);
  // A recovery stays on the actual deck/road below the car, including stacked
  // interchanges. Using terrain height alone dropped bridge users into the bay.
  if (game.roads?.tunnelFloorAt?.(p.x, p.z) == null) y = Math.max(0, y);
  vehicle.reset(new THREE.Vector3(p.x, y + 0.5, p.z), headingYaw(vehicle.object3d));
  game.events?.emit?.('vehicle:reset', { vehicle });
}

// Minimal player controller: drive a vehicle or fly the free camera. The characters workstream (D) replaces this
// with a full PlayerController (on foot, enter/exit, carjacking) implementing the same public API.
export class BasicPlayer {
  constructor(game, spawnPoint) {
    this.game = game;
    this.mode = 'vehicle';
    this.health = 1;
    this.armor = 0;
    this.money = 0;
    this.waypoint = null;
    this.route = null;
    this.routeTimer = 0;
    this.wastedT = 0;
    this.lastSafe = null;
    this.focus = new THREE.Vector3(spawnPoint.x, spawnPoint.y, spawnPoint.z);
    this.spawnPoint = spawnPoint;
    this.driveInput = new DriveInput();
    const dom = game.renderer.domElement;
    const camRay = new game.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this.chase = new ChaseCamera(game.camera, dom, {
      getGroundHeight: (x, z) => game.roads?.tunnelFloorAt?.(x, z) ?? Math.max(game.terrain.heightAt(x, z), 0),
      input: this.driveInput,
      raycast: (o, d, max) => {
        camRay.origin = { x: o.x, y: o.y, z: o.z };
        camRay.dir = { x: d.x, y: d.y, z: d.z };
        const hit = game.world.castRay(camRay, max, true, undefined, groups(0xffff, GROUPS.STATIC));
        return hit ? hit.timeOfImpact : null;
      },
    });
    this.free = new FreeCamera(game.camera, dom, { getGroundHeight: (x, z) => game.terrain.heightAt(x, z) });
    this.controllable = null;
  }

  get heading() {
    // compass bearing: 0 = north (-z), +pi/2 = east
    if (this.mode === 'free' || !this.controllable) {
      const d = this.game.camera.getWorldDirection(_v);
      return Math.atan2(d.x, -d.z);
    }
    const f = _v.set(0, 0, -1).applyQuaternion(this.controllable.object3d.quaternion);
    return Math.atan2(f.x, -f.z);
  }

  enter(v) {
    if (this.controllable) this.controllable.occupied = false;
    this.controllable = v;
    v.occupied = true;
    this.mode = 'vehicle';
    this.chase.enabled = true;
    (v.camera || this.chase).snap(v);
    this.game.audio?.attachVehicle?.(v);
    this.game.events.emit('vehicle:enter', { vehicle: v });
  }

  exit() { /* on-foot mode arrives with the characters workstream */ }

  setFree(on) {
    const g = this.game;
    if (on) {
      this.mode = 'free';
      this.free.enable(g.camera);
      this.chase.enabled = false;
      g.ui?.setMode?.(g.i18n?.t('mode.free') ?? 'FREE CAMERA');
    } else {
      this.free.disable();
      this.mode = this.controllable ? 'vehicle' : 'foot';
      this.chase.enabled = true;
      if (this.controllable) (this.controllable.camera || this.chase).snap(this.controllable);
      g.ui?.setMode?.('');
    }
  }

  teleport(x, z) {
    const g = this.game;
    if (this.mode === 'free') {
      const h = Math.max(g.terrain.heightAt(x, z), 0);
      g.camera.position.set(x, h + 160, z + 200);
      g.camera.lookAt(x, h, z);
      this.free.enable(g.camera);
      this.focus.set(x, h, z);
      return;
    }
    const sp = roadSpawn(g, x, z);
    this.focus.set(sp.x, sp.y, sp.z);
    this.controllable?.reset(new THREE.Vector3(sp.x, sp.y, sp.z), sp.yaw);
    g.streaming?.run(true);
    if (this.controllable) (this.controllable.camera || this.chase).snap(this.controllable);
    this.routeTimer = 0;
  }

  setWaypoint(w) {
    this.waypoint = w;
    // route right away: the map shows it while the menu is open (paused offline, so updateRoute doesn't run)
    const f = this.focus, roads = this.game?.roads;
    this.route = w && f && roads?.route ? roads.route(f.x, f.z, w.x, w.z, f.y, w.y) : null;
    this.routeTimer = 1.5;
  }

  addMoney(n, pos, reason = 'other') {
    const net = this.game.net;
    if (net?.claim) net.claim(reason, n, pos); // online: server-authoritative wallet sets this.money
    else this.money += n;
    this.game.events.emit('money:pickup', { amount: n, position: pos, reason });
  }

  fixedUpdate(dt, game) {
    const v = this.controllable;
    if (!v) return;
    const tel = v.telemetry;
    const drive = this.mode === 'vehicle' && this.wastedT <= 0;
    const inp = drive ? this.driveInput.update(dt, tel.speedKmh) : { throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false };
    inp.driver = drive;
    v.fixedUpdate(dt, inp);
  }

  update(dt, game) {
    const inp = game.input;
    if (!game.paused) {
      if (inp.pressed('KeyV')) this.setFree(this.mode !== 'free');
      if (inp.pressed('KeyC') && this.mode === 'vehicle') this.chase.nextMode();
      if (inp.pressed('KeyH') && this.controllable) this.controllable.setHeadlights?.(!this.controllable.headlightsOn);
      if (inp.pressed('KeyL') && this.controllable) this.controllable.siren = !this.controllable.siren;
      if (inp.pressed('KeyR') && this.controllable) {
        recoverVehicle(game, this.controllable);
      }
      if (inp.pressed('KeyT') && game.can('time')) game.sky.setTime(game.sky.time + 1, { smooth: true });
    }
    const v = this.controllable;
    if (this.mode === 'free') this.focus.copy(game.camera.position);
    else if (v) { const t = v.body.translation(); this.focus.set(t.x, t.y, t.z); }
    // auto headlights
    if (v && !this.manualLights) {
      if (game.sky.night > 0.35 && !v.headlightsOn) v.setHeadlights?.(true);
      if (game.sky.night < 0.2 && v.headlightsOn) v.setHeadlights?.(false);
    }
    this.updateWasted(dt, game);
    this.updateRoute(dt, game);
  }

  lateUpdate(dt, game) {
    if (this.mode === 'free') this.free.update(dt);
    else if (this.controllable) (this.controllable.camera || this.chase).update(dt, this.controllable);
  }

  updateWasted(dt, game) {
    const v = this.controllable;
    if (!v) return;
    const p = v.body.translation();
    const tel = v.telemetry;
    if (this.wastedT <= 0 && p.y > 0.3 && game.terrain.heightAt(p.x, p.z) > 0.2 && tel.speedKmh < 200) this.lastSafe = { x: p.x, z: p.z };
    if (this.wastedT <= 0 && (v.drowned || this.health <= 0 || p.y < -30)) {
      this.wastedT = 4.5;
      game.ui?.wasted?.(true);
      game.events.emit('wasted', {});
    }
    game.timeScale = this.wastedT > 0 ? 0.3 : 1;
    if (this.wastedT > 0) {
      this.wastedT -= dt;
      const gr = game.render?.grade?.uniforms;
      if (gr) {
        gr.uWasted.value = Math.min(1, gr.uWasted.value + dt * 1.5);
        gr.uFade.value = this.wastedT < 0.8 ? 1 - this.wastedT / 0.8 : 0;
      }
      if (this.wastedT <= 0) {
        const s = this.lastSafe || this.spawnPoint;
        const sp = roadSpawn(game, s.x, s.z);
        v.reset(new THREE.Vector3(sp.x, sp.y, sp.z), sp.yaw);
        v.drowned = false;
        this.health = 1;
        v.damage?.repair?.();
        this.focus.set(sp.x, sp.y, sp.z);
        game.streaming?.run(true);
        (v.camera || this.chase).snap(v);
        game.ui?.wasted?.(false);
        if (gr) { gr.uWasted.value = 0; gr.uFade.value = 0; }
        game.events.emit('respawn', {});
      }
    }
  }

  updateRoute(dt, game) {
    if (!this.waypoint) return;
    this.routeTimer -= dt;
    const wp = this.waypoint, f = this.focus;
    if (Math.hypot(f.x - wp.x, f.z - wp.z) < 40) {
      game.ui?.toast?.(game.i18n?.t('gps.arrived') ?? 'ARRIVED', game.world3d.areaAt(wp.x, wp.z).name.toUpperCase(), 3);
      this.setWaypoint(null);
      game.events.emit('waypoint:reached', {});
    } else if (this.routeTimer <= 0) {
      this.route = game.roads.route(f.x, f.z, wp.x, wp.z, f.y, wp.y);
      this.routeTimer = 1.5;
    }
  }
}
