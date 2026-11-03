// Headless physics tests for aircraft & boats: `node src/air/sim-test.mjs [filter]`
// Flat land for x < 1000 (y = 0, with a STATIC wall at x = -1500), open sea (depth 12 m) for x >= 1000.
import RAPIER from '@dimforge/rapier3d-compat';
import { HeliPhysics } from './physics/HeliPhysics.js';
import { PlanePhysics } from './physics/PlanePhysics.js';
import { BoatPhysics } from '../boat/BoatPhysics.js';
import { HELI_SPECS, PLANE_SPECS } from './specs.js';
import { BOAT_SPEC } from '../boat/specs.js';
import { waterHeight, calmFromDepth } from '../boat/waves.js';
import { GROUPS, groups } from '../vehicle/groups.js';

await RAPIER.init();
const DT = 1 / 60;
const filter = process.argv[2] || '';
const results = [];
const perf = {};

function makeWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  const land = RAPIER.ColliderDesc.cuboid(2500, 5, 4000).setTranslation(-1500, -5, 0).setFriction(1).setCollisionGroups(groups(GROUPS.GROUND, 0xffff));
  world.createCollider(land);
  // sloped beach x 1000..1100 (y 0 .. -3), then seabed
  world.createCollider(RAPIER.ColliderDesc.cuboid(50.3, 1, 4000).setTranslation(1050, -2.5, 0).setRotation({ x: 0, y: 0, z: Math.sin(-0.015), w: Math.cos(-0.015) }).setCollisionGroups(groups(GROUPS.GROUND, 0xffff)));
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 5, 4000).setTranslation(5000, -17, 0).setCollisionGroups(groups(GROUPS.GROUND, 0xffff)));
  // tall wall for tunnelling tests
  world.createCollider(RAPIER.ColliderDesc.cuboid(5, 200, 400).setTranslation(-3000, 200, 0).setCollisionGroups(groups(GROUPS.STATIC, 0xffff)));
  let t = 0;
  const env = {
    heightAt: (x) => (x < 1000 ? 0 : x < 1100 ? -(x - 1000) * 0.03 : -12),
    waterHeight: (x, z, tt, th) => waterHeight(x, z, tt, calmFromDepth(th ?? env.heightAt(x, z))),
    time: () => t,
    surface: () => ({ grip: 1, rolling: 0 }),
    landFriction: (x, z, skims) => (skims ? 0.12 : 0.6),
    landDrag: (x, z, skims) => (skims ? 300 : 1500),
  };
  return { world, env, tick: () => { t += DT; }, get t() { return t; } };
}

function run(craft, W, seconds, ctlFn, onStep) {
  const n = Math.round(seconds / DT);
  let tPhys = 0, tWorld = 0;
  for (let i = 0; i < n; i++) {
    const ctl = ctlFn(i * DT, craft);
    const a = performance.now();
    craft.fixedUpdate(DT, ctl);
    const b = performance.now();
    W.world.step();
    const c = performance.now();
    tPhys += b - a; tWorld += c - b;
    W.tick();
    const p = craft.body.translation();
    if (!Number.isFinite(p.x + p.y + p.z)) throw new Error('NaN position');
    const stop = onStep && onStep(i * DT, craft) === false;
    craft.events.length = 0;
    if (stop) break;
  }
  return { msPerStep: tPhys / n, worldMs: tWorld / n };
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const pos = (c) => c.body.translation();
const vel = (c) => c.body.linvel();
const hspeed = (c) => Math.hypot(vel(c).x, vel(c).z);
const f1 = (x) => x.toFixed(1);

// ---------------- helicopters ----------------
function heliTests(id) {
  const spec = HELI_SPECS[id];
  {
    const W = makeWorld();
    const h = new HeliPhysics({ RAPIER, world: W.world, spec, position: { x: 0, y: -spec.skidY + 0.02, z: 0 }, yaw: 0, env: W.env });
    // spool on the ground, climb 4 s, then hands off
    const r = run(h, W, 6, () => ({ active: true, collective: 0, pitch: 0, roll: 0, yaw: 0 }));
    const sitY = pos(h).y;
    run(h, W, 4, () => ({ active: true, collective: 1, pitch: 0, roll: 0, yaw: 0 }));
    const y0 = pos(h).y, p0 = { ...pos(h) };
    let maxVy = 0;
    run(h, W, 12, () => ({ active: true, collective: 0, pitch: 0, roll: 0, yaw: 0 }), (t, c) => { if (t > 4) maxVy = Math.max(maxVy, Math.abs(vel(c).y)); });
    const p1 = pos(h);
    const drift = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    check(`${id} stays planted while spooling`, Math.abs(sitY - (-spec.skidY)) < 0.25, `y=${f1(sitY)}`);
    check(`${id} hover hold`, maxVy < 0.4 && drift < 6 && p1.y > 15, `climb to ${f1(y0)}m, end ${f1(p1.y)}m, |vy|max ${maxVy.toFixed(2)}, drift ${f1(drift)}m`);
    perf[id] = r.msPerStep;
    // forward flight
    let t60 = 0;
    run(h, W, 25, () => ({ active: true, collective: 0, pitch: 1, roll: 0, yaw: 0 }), (t, c) => { if (!t60 && hspeed(c) * 3.6 > 100) t60 = t; });
    const top = hspeed(h) * 3.6;
    check(`${id} forward flight`, top > spec.topSpeedKmh * 0.85 && top < spec.topSpeedKmh * 1.15 && Math.abs(vel(h).y) < 2.5, `0-100 ${f1(t60)}s, top ${f1(top)} km/h (spec ${spec.topSpeedKmh}), vy ${vel(h).y.toFixed(2)}`);
    // release: decelerate to hover
    run(h, W, 25, () => ({ active: true, collective: 0, pitch: 0, roll: 0, yaw: 0 }));
    check(`${id} auto-brake to hover`, hspeed(h) < 3, `speed after 25 s ${f1(hspeed(h) * 3.6)} km/h`);
    // yaw response
    let yawRate = 0;
    run(h, W, 3, () => ({ active: true, collective: 0, pitch: 0, roll: 0, yaw: 1 }), (t, c) => { yawRate = -c.body.angvel().y; });
    check(`${id} yaw response`, yawRate > spec.yawRate * 0.7, `yaw rate ${yawRate.toFixed(2)} rad/s`);
    // banked turn at speed
    run(h, W, 1, () => ({ active: true, collective: 0, pitch: 0, roll: 0, yaw: 0 }));
    run(h, W, 8, () => ({ active: true, collective: 0, pitch: 0.8, roll: 0, yaw: 0 }));
    const yA = pos(h).y;
    const hd0 = Math.atan2(vel(h).x, -vel(h).z);
    run(h, W, 6, () => ({ active: true, collective: 0, pitch: 0.8, roll: 1, yaw: 0 }));
    const hd1 = Math.atan2(vel(h).x, -vel(h).z);
    check(`${id} banked turn`, Math.abs(pos(h).y - yA) < 25, `heading change ${f1(((hd1 - hd0) * 180) / Math.PI)} deg, alt change ${f1(pos(h).y - yA)} m`);
    // descend & land
    run(h, W, 20, () => ({ active: true, collective: 0, pitch: 0, roll: 0, yaw: 0 }));
    let touchVy = 0, landed = false;
    const hp0 = h.health;
    run(h, W, 60, () => ({ active: true, collective: -1, pitch: 0, roll: 0, yaw: 0 }), (t, c) => {
      if (!landed && c.grounded) { landed = true; touchVy = c.telemetry.verticalSpeed; }
      return !(landed && t > 1);
    });
    check(`${id} auto-flare landing`, landed && Math.abs(touchVy) < 2.0 && h.health >= hp0 - 0.01, `touchdown vy ${touchVy.toFixed(2)} m/s, health ${h.health.toFixed(2)}`);
  }
  {
    // dead-stick drop from 80 m → crash
    const W = makeWorld();
    const h = new HeliPhysics({ RAPIER, world: W.world, spec, position: { x: 0, y: 80, z: 0 }, yaw: 0, env: W.env, state: { air: true } });
    run(h, W, 12, () => ({ active: false }));
    check(`${id} unpowered fall is destroyed`, h.destroyed, `destroyed=${h.destroyed} health=${h.health.toFixed(2)}`);
  }
  {
    // rotor strike: hover next to the wall and drift into it
    const W = makeWorld();
    const h = new HeliPhysics({ RAPIER, world: W.world, spec, position: { x: -2990 + spec.rotor.radius + 4, y: 30, z: 0 }, yaw: Math.PI / 2, env: W.env, state: { air: true } });
    let strike = false;
    run(h, W, 8, () => ({ active: true, collective: 0, pitch: 0.6, roll: 0, yaw: 0 }), (t, c) => { if (c.events.some((e) => e.type === 'rotorStrike')) strike = true; });
    const px = pos(h).x;
    check(`${id} rotor strike on wall`, (strike || h.rotorBroken) && px > -2996, `rotorBroken=${h.rotorBroken} x=${f1(px)}`);
  }
  {
    // ditch in the sea → sinks → drowned
    const W = makeWorld();
    const h = new HeliPhysics({ RAPIER, world: W.world, spec, position: { x: 1500, y: 6, z: 0 }, yaw: 0, env: W.env, state: { air: true } });
    let splash = false;
    run(h, W, 25, () => ({ active: false }), (t, c) => { if (c.events.some((e) => e.type === 'splash')) splash = true; });
    check(`${id} sinks in water`, splash && h.drowned, `splash=${splash} drowned=${h.drowned} y=${f1(pos(h).y)}`);
  }
}

// ---------------- planes ----------------
function spawnPlane(W, spec, x, z, yaw, air) {
  const y = air ? air.y : spec.restHeight + 0.05;
  return new PlanePhysics({ RAPIER, world: W.world, spec, position: { x, y, z }, yaw, env: W.env, state: air ? { air: true, speed: air.speed, throttle: air.throttle } : { pitch: spec.restPitch } });
}

function planeTests(id) {
  const spec = PLANE_SPECS[id];
  const sea = !!spec.float?.seaplane;
  const vr = spec.vStallFlaps * 1.12;
  {
    // takeoff: flaps 1 notch, full throttle, rotate at vr
    const W = makeWorld();
    const p = sea ? spawnPlane(W, spec, 2000, 0, -Math.PI / 2, { y: 1.6, speed: 0, throttle: 0 }) : spawnPlane(W, spec, 0, 0, Math.PI / 2, null);
    p.throttle = 0;
    if (!spec.noFlaps) p.setFlaps(0.5);
    run(p, W, 3, () => ({ active: true, throttleRate: 0, pitch: 0, roll: 0, yaw: 0, brake: 0 }));
    const x0 = pos(p).x, z0 = pos(p).z;
    let lift = null;
    const r = run(p, W, 70, (t, c) => {
      const v = Math.hypot(vel(c).x, vel(c).z);
      return { active: true, throttleRate: 1, pitch: v > vr ? 0.7 : 0, roll: 0, yaw: 0, brake: 0 };
    }, (t, c) => {
      const air = c.telemetry.airborne && (c.agl > 0.5);
      if (!lift && air) lift = { t, d: Math.hypot(pos(c).x - x0, pos(c).z - z0), v: hspeed(c) * 3.6 };
      return !(lift && t > lift.t + 6);
    });
    perf[id] = r.msPerStep;
    const ok = lift && lift.d < (sea ? 1400 : spec.engine.type === 'jet' ? 1300 : 700) && lift.v > 85 && lift.v < 200;
    check(`${id} takeoff${sea ? ' (water)' : ''}`, !!ok, lift ? `liftoff after ${f1(lift.d)} m / ${f1(lift.t)} s at ${f1(lift.v)} km/h (vstall flaps ${f1(spec.vStallFlaps * 3.6)})` : `no liftoff, v=${f1(hspeed(p) * 3.6)} km/h aoa=${f1(p.telemetry.aoa)}`);
    check(`${id} climbs after takeoff`, vel(p).y > 1 && p.health > 0.95, `vy ${vel(p).y.toFixed(1)} m/s, alt ${f1(pos(p).y)} m, health ${p.health.toFixed(2)}`);
  }
  {
    // cruise stability (assist, hands off) + full-throttle top speed
    const W = makeWorld();
    const vc = spec.vTop * 0.72;
    const p = spawnPlane(W, spec, -500, 0, 0, { y: 600, speed: vc, throttle: 0.7 });
    let minY = 1e9, maxY = -1e9, maxRoll = 0;
    run(p, W, 40, () => ({ active: true, throttleRate: 0, pitch: 0, roll: 0, yaw: 0, brake: 0 }), (t, c) => {
      if (t > 8) { const y = pos(c).y; minY = Math.min(minY, y); maxY = Math.max(maxY, y); maxRoll = Math.max(maxRoll, Math.abs(c.telemetry.roll)); }
    });
    check(`${id} hands-off cruise`, maxY - minY < 60 && maxRoll < 5, `alt band ${f1(maxY - minY)} m, max roll ${f1(maxRoll)} deg, v ${f1(hspeed(p) * 3.6)} km/h`);
    run(p, W, 120, () => ({ active: true, throttleRate: 1, pitch: 0, roll: 0, yaw: 0, brake: 0 }));
    const top = Math.hypot(vel(p).x, vel(p).y, vel(p).z) * 3.6;
    check(`${id} top speed`, top > spec.topSpeedKmh * 0.85 && top < spec.topSpeedKmh * 1.12, `${f1(top)} km/h (spec ${spec.topSpeedKmh}), vy ${vel(p).y.toFixed(1)}`);
    // roll rate & sustained turn
    run(p, W, 2, () => ({ active: true, throttleRate: -1, pitch: 0, roll: 0, yaw: 0, brake: 0 }));
    let pr = 0;
    run(p, W, 1.5, () => ({ active: true, throttleRate: 0, pitch: 0, roll: 1, yaw: 0, brake: 0 }), (t, c) => { pr = Math.max(pr, Math.abs(c.body.angvel().x * c.S.fwd.x + c.body.angvel().y * c.S.fwd.y + c.body.angvel().z * c.S.fwd.z)); });
    check(`${id} roll rate`, pr > spec.ctl.rollRate * 0.6, `${f1((pr * 180) / Math.PI)} deg/s`);
  }
  {
    // stall: idle, hold full back stick
    const W = makeWorld();
    const p = spawnPlane(W, spec, -500, 0, 0, { y: 800, speed: spec.vStall * 1.5, throttle: 0 });
    let stallV = 0, stallT = 0, minY = 1e9;
    run(p, W, 25, (t) => ({ active: true, throttleRate: -1, pitch: 1, roll: 0, yaw: 0, brake: 0, assist: false }), (t, c) => {
      if (!stallT && c.stalled) { stallT = t; stallV = Math.hypot(vel(c).x, vel(c).y, vel(c).z) * 3.6; }
      minY = Math.min(minY, pos(c).y);
    });
    const y0 = pos(p).y;
    // recovery: nose down + power, level the wings, then pull out of the dive
    run(p, W, 6, () => ({ active: true, throttleRate: 1, pitch: -0.3, roll: 0, yaw: 0, brake: 0 }));
    run(p, W, 20, () => ({ active: true, throttleRate: 1, pitch: 0.5, roll: 0, yaw: 0, brake: 0 }), (t, c) => vel(c).y < 0);
    run(p, W, 3, () => ({ active: true, throttleRate: 1, pitch: 0, roll: 0, yaw: 0, brake: 0 }));
    check(`${id} stall`, stallT > 0 && stallV < spec.vStall * 3.6 * 1.25, `stall at ${f1(stallV)} km/h after ${f1(stallT)} s (vstall ${f1(spec.vStall * 3.6)})`);
    check(`${id} stall recovery`, !p.stalled && vel(p).y > -3, `after recovery vy ${vel(p).y.toFixed(1)} m/s, lost ${f1(800 - Math.min(y0, pos(p).y))} m`);
  }
  if (!sea) {
    // landing: scripted approach (flaps, -3 m/s), flare, brake to stop
    const W = makeWorld();
    const vApp = spec.vStallFlaps * 1.3;
    const p = spawnPlane(W, spec, 600, 0, Math.PI / 2, { y: 50, speed: vApp, throttle: 0.3 });
    p.setFlaps(1);
    if (spec.retract && !p.gearDown) p.toggleGear();
    let touch = null, stopX = null, iErr = 0;
    run(p, W, 120, (t, c) => {
      const agl = c.agl;
      const v = Math.hypot(vel(c).x, vel(c).y, vel(c).z);
      const vyT = touch ? 0 : agl > 8 ? -3 : -0.6 - agl * 0.25;
      const e = vyT - vel(c).y;
      iErr = Math.max(-3, Math.min(3, iErr + e * DT));
      const pitch = touch ? 0 : Math.max(-1, Math.min(1, e * 0.35 + iErr * 0.15));
      const thr = touch ? -1 : Math.max(-1, Math.min(1, (vApp - v) * 0.4 - c.throttle * 0.2));
      return { active: true, throttleRate: thr, pitch, roll: 0, yaw: 0, brake: touch ? 1 : 0 };
    }, (t, c) => {
      if (!touch && c.onGround) touch = { vy: vel(c).y, v: hspeed(c) * 3.6, x: pos(c).x };
      if (touch && hspeed(c) < 0.5) { stopX = pos(c).x; return false; }
    });
    const ok = touch && Math.abs(touch.vy) < 3 && p.health > 0.9 && stopX !== null;
    check(`${id} landing`, !!ok, touch ? `touchdown ${f1(touch.v)} km/h vy ${touch.vy.toFixed(2)} m/s, rollout ${stopX !== null ? f1(Math.abs(stopX - touch.x)) : '?'} m, health ${p.health.toFixed(2)}` : 'no touchdown');
  } else {
    // seaplane water landing
    const W = makeWorld();
    const vApp = spec.vStallFlaps * 1.3;
    const p = spawnPlane(W, spec, 2500, 0, -Math.PI / 2, { y: 40, speed: vApp, throttle: 0.3 });
    p.setFlaps(1);
    let touch = null, iErr = 0;
    run(p, W, 120, (t, c) => {
      const agl = c.agl;
      const v = Math.hypot(vel(c).x, vel(c).y, vel(c).z);
      const vyT = touch ? 0 : agl > 8 ? -3 : -0.6 - agl * 0.25;
      const e = vyT - vel(c).y;
      iErr = Math.max(-3, Math.min(3, iErr + e * DT));
      const pitch = touch ? 0 : Math.max(-1, Math.min(1, e * 0.35 + iErr * 0.15));
      return { active: true, throttleRate: touch ? -1 : Math.max(-1, Math.min(1, (vApp - v) * 0.4)), pitch, roll: 0, yaw: 0, brake: 0 };
    }, (t, c) => {
      if (!touch && c.telemetry.onWater) touch = { vy: vel(c).y, v: hspeed(c) * 3.6 };
      if (touch && hspeed(c) < 2) return false;
    });
    check(`${id} water landing`, !!touch && Math.abs(touch.vy) < 3 && p.health > 0.9 && !p.drowned, touch ? `touchdown ${f1(touch.v)} km/h vy ${touch.vy.toFixed(2)}, health ${p.health.toFixed(2)}, floating y=${f1(pos(p).y)}` : 'no touchdown');
  }
  {
    // tunnelling: full speed into the wall
    const W = makeWorld();
    const p = spawnPlane(W, spec, -2700, 0, Math.PI / 2, { y: 100, speed: spec.vTop, throttle: 1 });
    run(p, W, 9, () => ({ active: true, throttleRate: 1, pitch: 0, roll: 0, yaw: 0, brake: 0 }));
    check(`${id} no tunnelling (wall at ${f1(spec.vTop * 3.6)} km/h)`, pos(p).x > -2996 && p.destroyed, `x=${f1(pos(p).x)} destroyed=${p.destroyed}`);
  }
}

// ---------------- boats ----------------
function boatTests(id) {
  const spec = BOAT_SPEC[id];
  const W = makeWorld();
  const b = new BoatPhysics({ RAPIER, world: W.world, spec, position: { x: 2500, y: 0.1, z: 0 }, yaw: Math.PI / 2, env: W.env });
  run(b, W, 5, () => ({ active: true, throttle: 0, steer: 0 }));
  const restY = pos(b).y;
  const restPitch = b.telemetry.pitch;
  check(`${id} floats level`, Math.abs(restY) < 0.2 && Math.abs(restPitch) < 3 && Math.abs(b.telemetry.roll) < 3, `y=${restY.toFixed(2)} pitch=${f1(restPitch)} roll=${f1(b.telemetry.roll)}`);
  let maxRoll = 0, maxPitch = 0, t100 = 0;
  const r = run(b, W, 50, () => ({ active: true, throttle: 1, steer: 0 }), (t, c) => {
    if (t > 6) { maxRoll = Math.max(maxRoll, Math.abs(c.telemetry.roll)); maxPitch = Math.max(maxPitch, Math.abs(c.telemetry.pitch)); }
    if (!t100 && hspeed(c) * 3.6 > spec.topSpeedKmh * 0.6) t100 = t;
  });
  perf[id] = r.msPerStep;
  const top = hspeed(b) * 3.6;
  check(`${id} top speed`, top > spec.topSpeedKmh * 0.85 && top < spec.topSpeedKmh * 1.15, `${f1(top)} km/h (spec ${spec.topSpeedKmh}), 0-60% in ${f1(t100)} s, planing ${b.planing.toFixed(2)}`);
  check(`${id} straight-line stability`, maxRoll < 8 && maxPitch < 12, `max roll ${f1(maxRoll)} max pitch ${f1(maxPitch)}`);
  // turning circle
  const c0 = [];
  let maxRollT = 0;
  run(b, W, 20, () => ({ active: true, throttle: 1, steer: 1 }), (t, c) => {
    if (t > 8) { c0.push([pos(c).x, pos(c).z]); maxRollT = Math.max(maxRollT, c.telemetry.roll); }
  });
  let cx = 0, cz = 0;
  for (const [x, z] of c0) { cx += x; cz += z; }
  cx /= c0.length; cz /= c0.length;
  const R = c0.reduce((s, [x, z]) => s + Math.hypot(x - cx, z - cz), 0) / c0.length;
  check(`${id} turning circle`, R > 4 && R < 120 && !b.telemetry.upsideDown, `radius ${f1(R)} m at ${f1(hspeed(b) * 3.6)} km/h, bank ${f1(maxRollT)} deg (+ = into turn)`);
  // reverse
  run(b, W, 12, () => ({ active: true, throttle: 0, steer: 0 }));
  if (spec.reverse > 0) {
    run(b, W, 12, () => ({ active: true, throttle: -1, steer: 0 }));
    check(`${id} reverse`, b.telemetry.forwardSpeed < -1, `vF ${b.telemetry.forwardSpeed.toFixed(2)} m/s`);
  }
  // beaching: drive at land
  {
    const W2 = makeWorld();
    const b2 = new BoatPhysics({ RAPIER, world: W2.world, spec, position: { x: 1200, y: 0.1, z: 0 }, yaw: Math.PI / 2, env: W2.env });
    run(b2, W2, 30, () => ({ active: true, throttle: spec.skims ? 1 : 1, steer: 0 }));
    const x = pos(b2).x;
    if (spec.skims) check(`${id} skims over land`, x < 950 && hspeed(b2) * 3.6 > 8, `x=${f1(x)} speed on grass ${f1(hspeed(b2) * 3.6)} km/h`);
    else check(`${id} beaches and stops`, hspeed(b2) < 1.5 && x > 940, `x=${f1(x)} speed ${f1(hspeed(b2) * 3.6)} km/h`);
  }
}

// steady-state cost of one fixedUpdate (physics core incl. raycasts), after JIT warm-up
function bench() {
  const out = {};
  const measure = (id, craft, W, ctl) => {
    run(craft, W, 5, () => ctl);
    const r = run(craft, W, 20, () => ctl);
    out[id] = r;
  };
  for (const id of Object.keys(HELI_SPECS)) {
    if (!id.includes(filter)) continue;
    const W = makeWorld();
    const h = new HeliPhysics({ RAPIER, world: W.world, spec: HELI_SPECS[id], position: { x: 0, y: 40, z: 0 }, yaw: 0, env: W.env, state: { air: true } });
    measure(id, h, W, { active: true, collective: 0, pitch: 0.3, roll: 0.2, yaw: 0 });
  }
  for (const id of Object.keys(PLANE_SPECS)) {
    if (!id.includes(filter)) continue;
    const W = makeWorld();
    const p = spawnPlane(W, PLANE_SPECS[id], 0, 0, Math.PI / 2, null);
    measure(id + ' (ground)', p, W, { active: true, throttleRate: 0, pitch: 0, roll: 0, yaw: 0.3, brake: 0 });
    const W2 = makeWorld();
    const p2 = spawnPlane(W2, PLANE_SPECS[id], 0, 0, 0, { y: 500, speed: PLANE_SPECS[id].vTop * 0.7, throttle: 0.7 });
    measure(id + ' (air)', p2, W2, { active: true, throttleRate: 0, pitch: 0.1, roll: 0.1, yaw: 0, brake: 0 });
  }
  for (const id of Object.keys(BOAT_SPEC)) {
    if (!id.includes(filter)) continue;
    const W = makeWorld();
    const b = new BoatPhysics({ RAPIER, world: W.world, spec: BOAT_SPEC[id], position: { x: 2500, y: 0.1, z: 0 }, yaw: 0, env: W.env });
    measure(id, b, W, { active: true, throttle: 1, steer: 0.4 });
  }
  return out;
}

const t0 = performance.now();
for (const id of Object.keys(HELI_SPECS)) if (id.includes(filter)) heliTests(id);
for (const id of Object.keys(PLANE_SPECS)) if (id.includes(filter)) planeTests(id);
for (const id of Object.keys(BOAT_SPEC)) if (id.includes(filter)) boatTests(id);
const b = bench();
console.log('\nperf, steady state (ms per step): craft.fixedUpdate | world.step (whole test world)');
for (const [k, v] of Object.entries(b)) console.log(`  ${k.padEnd(22)} ${v.msPerStep.toFixed(4)} | ${v.worldMs.toFixed(4)}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exitCode = failed.length ? 1 : 0;
