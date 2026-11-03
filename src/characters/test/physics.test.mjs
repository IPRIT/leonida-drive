// Headless checks for the character motor (KCC) and ragdolls: node src/characters/test/physics.test.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { CharacterMotor } from '../CharacterMotor.js';
import { Ragdolls } from '../Ragdoll.js';
import { makeDims, fk, pelvisMatrix, NJ, J } from '../rig.js';
import { newPose, poseIdle, poseGait } from '../poses.js';
import { GROUPS, groups } from '../../vehicle/groups.js';

await RAPIER.init();
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

function makeWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  const G = groups(GROUPS.GROUND, 0xffff), S = groups(GROUPS.STATIC, 0xffff);
  const fixed = (hx, hy, hz, x, y, z, g = G, rot) => {
    const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setCollisionGroups(g);
    if (rot) d.setRotation(rot);
    return world.createCollider(d);
  };
  fixed(200, 0.5, 200, 0, -0.5, 0); // ground top at y=0
  fixed(3.5, 0.075, 3, 6.5, 0.075, 0); // curb 0.15 m (x 3..10)
  fixed(1, 0.125, 3, 13, 0.125, 0); // step 0.25 m (x 12..14)
  fixed(0.5, 1, 3, 20.5, 1, 0, S); // wall at x=20
  const ramp = (deg, z) => {
    const a = (deg * Math.PI) / 180;
    const q = { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) };
    fixed(4, 0.1, 1.5, 4 * Math.cos(a), 4 * Math.sin(a) - 0.1, z, G, q);
  };
  ramp(30, 10);
  ramp(62, 20);
  return world;
}

// ---------- motor ----------
{
  const world = makeWorld();
  const m = new CharacterMotor(RAPIER, world, { pos: { x: 0, y: 0.05, z: 0 } });
  const run = (sec, vx, vz, o) => { for (let i = 0; i < sec * 60; i++) { m.step(1 / 60, vx, vz, o); world.step(); } };
  run(0.5, 0, 0);
  ok(m.grounded && Math.abs(m.cur.y) < 0.06, `stands on ground (y=${m.cur.y.toFixed(3)})`);
  let maxOnCurb = 0;
  for (let i = 0; i < 120; i++) { m.step(1 / 60, 4, 0); world.step(); if (m.cur.x > 4 && m.cur.x < 9) maxOnCurb = Math.max(maxOnCurb, m.cur.y); }
  ok(maxOnCurb > 0.12, `autosteps onto 0.15 m curb (y=${maxOnCurb.toFixed(3)})`);
  let maxOnStep = 0;
  for (let i = 0; i < 180; i++) { m.step(1 / 60, 4, 0); world.step(); if (m.cur.x > 12.3 && m.cur.x < 13.7) maxOnStep = Math.max(maxOnStep, m.cur.y); }
  ok(maxOnStep > 0.22, `autosteps onto 0.25 m step (y=${maxOnStep.toFixed(3)})`);
  run(1.5, 4, 0);
  ok(m.cur.x > 18.5 && m.cur.x < 19.75, `blocked by wall (x=${m.cur.x.toFixed(2)})`);
  ok(m.blocked > 0.8, `reports blocked motion (${m.blocked.toFixed(2)})`);
  // jump
  m.teleport(0, 0, -5);
  run(0.3, 0, 0);
  let top = 0;
  m.step(1 / 60, 0, 0, { jump: 4.8 }); world.step();
  for (let i = 0; i < 90; i++) { m.step(1 / 60, 0, 0); world.step(); top = Math.max(top, m.cur.y); }
  ok(top > 0.9 && top < 1.4 && m.grounded, `jump apex ${top.toFixed(2)} m, landed`);
  // fall
  m.teleport(0, 10, -8);
  let land = 0;
  for (let i = 0; i < 180; i++) { m.step(1 / 60, 0, 0); world.step(); if (m.landSpeed) land = m.landSpeed; }
  ok(land > 12 && land < 15.5, `falling 10 m lands at ${land.toFixed(1)} m/s`);
  // slopes
  m.teleport(-1, 0, 10);
  run(3, 3, 0);
  ok(m.cur.y > 1.2, `climbs 30 deg ramp (y=${m.cur.y.toFixed(2)})`);
  m.teleport(-1, 0, 20);
  run(3, 3, 0);
  ok(m.cur.y < 0.6, `cannot climb 62 deg ramp (y=${m.cur.y.toFixed(2)})`);
  // swim target
  m.teleport(0, 0, -20);
  for (let i = 0; i < 120; i++) { m.step(1 / 60, 1, 0, { swimY: 1.0 }); world.step(); }
  ok(Math.abs(m.cur.y - 1.0) < 0.1, `swim keeps target height (y=${m.cur.y.toFixed(2)})`);
}

// ---------- vehicles push the character out (never through walls) ----------
{
  const world = makeWorld();
  const m = new CharacterMotor(RAPIER, world, { pos: { x: 0, y: 0.05, z: 30 } });
  // a traffic-like car (dynamic, TRAFFIC group, like Traffic.js) creeping at 1.5 m/s towards the character
  const car = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-5, 0.75, 30).enabledRotations(false, true, false));
  world.createCollider(RAPIER.ColliderDesc.cuboid(2.2, 0.6, 0.9).setMass(1400).setFriction(0)
    .setCollisionGroups(groups(GROUPS.TRAFFIC, GROUPS.VEHICLE | GROUPS.CHARACTER | GROUPS.TRAFFIC | GROUPS.GROUND)), car);
  const drive = (sec, wantX = 0) => {
    let worst = 0;
    for (let i = 0; i < sec * 60; i++) {
      const lv = car.linvel();
      car.setLinvel({ x: 1.5, y: lv.y, z: 0 }, true);
      m.step(1 / 60, wantX, 0); world.step();
      const nose = car.translation().x + 2.2;
      worst = Math.max(worst, nose - (m.cur.x - m.r)); // capsule overlap with the car's front
    }
    return worst;
  };
  const worst = drive(6);
  ok(worst < 0.08, `creeping car pushes the character ahead of it (max overlap ${worst.toFixed(3)} m, x=${m.cur.x.toFixed(2)})`);
  const worst2 = drive(2, -2);
  ok(worst2 < 0.08, `walking into the car does not enter it (max overlap ${worst2.toFixed(3)} m)`);
  // pinned against a wall: the wall wins
  const m2 = new CharacterMotor(RAPIER, world, { pos: { x: 18.6, y: 0.05, z: -1 } });
  for (let i = 0; i < 30; i++) { m2.step(1 / 60, 0, 0); world.step(); }
  car.setTranslation({ x: 12, y: 0.75, z: -1 }, true);
  let maxX = 0;
  for (let i = 0; i < 6 * 60; i++) {
    const lv = car.linvel();
    car.setLinvel({ x: 1.5, y: lv.y, z: 0 }, true);
    m2.step(1 / 60, 0, 0); world.step();
    maxX = Math.max(maxX, m2.cur.x);
  }
  ok(maxX < 19.75, `never pushed through a wall (max x ${maxX.toFixed(2)}, wall face at 20)`);
}

// ---------- ragdoll ----------
{
  const world = makeWorld();
  const game = { RAPIER, world, register() {} };
  const pool = new Ragdolls(game, { max: 6 });
  const W = new Float32Array(NJ * 12), M = new Float32Array(12);
  const P = newPose();
  const results = [];
  const builds = ['thin', 'average', 'athletic', 'heavy', 'elderly'];
  for (let k = 0; k < 6; k++) {
    const d = makeDims({ h: 1.6 + k * 0.06, fem: k % 2, build: builds[k % 5] });
    if (k % 2) poseGait(P, k, 1.4, d); else poseIdle(P, k, k, d);
    pelvisMatrix(M, k * 3, 0.02, -40, k * 0.7, P, d);
    fk(W, M, P, d);
    const rd = pool.spawn(W, d, { x: 6 + k * 2, y: 3 + k, z: 1 }, { spin: { x: 2, y: 1, z: -3 } });
    results.push(rd);
  }
  ok(pool.count === 6, `6 ragdolls spawned`);
  ok(!pool.spawn(W, makeDims({ h: 1.7 }), { x: 0, y: 0, z: 0 }), `7th low-priority ragdoll refused while others are moving`);
  const t0 = performance.now();
  let maxV = 0;
  for (let i = 0; i < 600; i++) {
    pool.fixedUpdate(1 / 60);
    world.step();
    pool.update(1 / 60);
    for (const rd of pool.list) maxV = Math.max(maxV, pool.speed(rd));
  }
  const ms = (performance.now() - t0) / 600;
  ok(maxV < 40, `velocities stay bounded (max ${maxV.toFixed(1)} m/s)`);
  let allGood = true, minY = 1e9, maxSep = 0;
  const W2 = new Float32Array(NJ * 12);
  for (const rd of pool.list) {
    pool.writeJoints(rd, W2);
    for (let i = 0; i < W2.length; i++) if (!Number.isFinite(W2[i])) allGood = false;
    minY = Math.min(minY, W2[J.PELVIS * 12 + 10]);
    // joint separation: shoulder anchor vs upper arm body
    const tor = rd.bodies[1], ua = rd.bodies[3];
    const tp = tor.translation(), tq = tor.rotation(), up = ua.translation();
    const d = rd.d;
    const a = { x: d.off[J.UARM_L * 3], y: d.abdomenH + d.off[J.UARM_L * 3 + 1], z: d.off[J.UARM_L * 3 + 2] };
    // rotate a by tq
    const { x, y, z, w } = tq;
    const ix = w * a.x + y * a.z - z * a.y, iy = w * a.y + z * a.x - x * a.z, iz = w * a.z + x * a.y - y * a.x, iw = -x * a.x - y * a.y - z * a.z;
    const rx = ix * w + iw * -x + iy * -z - iz * -y, ry = iy * w + iw * -y + iz * -x - ix * -z, rz = iz * w + iw * -z + ix * -y - iy * -x;
    maxSep = Math.max(maxSep, Math.hypot(tp.x + rx - up.x, tp.y + ry - up.y, tp.z + rz - up.z));
  }
  ok(allGood, 'no NaN in ragdoll transforms');
  ok(minY > -0.05 && minY < 0.5, `ragdolls rest on the ground (min pelvis y ${minY.toFixed(2)})`);
  ok(maxSep < 0.05, `joints stay connected (max shoulder gap ${(maxSep * 100).toFixed(1)} cm)`);
  ok(pool.list.every((r) => r.settled), 'all settled after 10 s');
  console.log(`     ${ms.toFixed(3)} ms per step for 6 ragdolls (world incl.)`);
  // pose round trip
  const rd = pool.list[0];
  const P2 = newPose(), W3 = new Float32Array(NJ * 12);
  const info = pool.toPose(rd, P2, W3, 0);
  const W4 = new Float32Array(NJ * 12);
  pelvisMatrix(M, info.x, 0, info.z, info.yaw, P2, rd.d);
  fk(W4, M, P2, rd.d);
  let err = 0;
  for (let j = 0; j < NJ; j++) err = Math.max(err, Math.hypot(W4[j * 12 + 9] - W3[j * 12 + 9], W4[j * 12 + 10] - W3[j * 12 + 10], W4[j * 12 + 11] - W3[j * 12 + 11]));
  ok(err < 0.06, `ragdoll -> pose -> FK round trip (max joint error ${(err * 100).toFixed(1)} cm)`);
  pool.clear();
  ok(pool.count === 0, 'pool cleared');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
