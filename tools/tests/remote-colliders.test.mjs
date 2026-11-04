import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { RemoteColliders } from '../../src/net/RemoteColliders.js';

await RAPIER.init();
// The requested rollback restores the original physical follower. A remote
// car must transfer momentum on both low- and high-latency connections.
for (const rtt of [80, 1200]) test(`remote car collisions remain physical at ${rtt} ms RTT`, () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, .7, 2).setMass(1500), body);
  const game = { RAPIER, world, player: { focus: { x: 0, y: 2, z: 0 }, controllable: { body } },
    net: { client: { online: true, clock: { rtt } }, store: { delay: rtt, target: rtt } } };
  const proxy = new RemoteColliders(game, { dims: () => ({ width: 2, height: 2, length: 4, originY: 0 }) });
  const e = { id: 42, model: 1, state: 'live', alpha: 1, tp: 0, hasCurve: true, vclass: 1,
    x: 7, y: 1, z: 0, yaw: 0, pitch: 0, roll: 0, vx: -5, vy: 0, vz: 0 };
  try {
    for (let i = 0; i < 100; i++) {
      e.x -= 5 / 60; proxy.assign([e]); proxy.fixedUpdate(1 / 60, 0); world.step();
    }
    assert.ok(body.translation().x < -.1, 'collision transfers momentum to the local car');
    assert.ok(Math.abs(body.linvel().x) < 12, 'collision impulse remains bounded');
  } finally { proxy.dispose(); world.free(); }
});
