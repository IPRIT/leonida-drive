// dev: idle drift probe: node src/vehicle/dev/probe3.mjs id [driver=1]
import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from '../physics/VehiclePhysics.js';
import { GROUPS, groups } from '../groups.js';
await RAPIER.init();
const id = process.argv[2] || 'aero', driver = process.argv[3] !== '0';
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = 1 / 60;
const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 0.5, 6000).setTranslation(0, -0.5, 0).setCollisionGroups(groups(GROUPS.GROUND)), gb);
world.step();
const v = new VehiclePhysics({ RAPIER, world, preset: id, position: { x: 0, y: 0, z: 0 }, yaw: 0 });
for (let i = 0; i < 600; i++) {
  v.fixedUpdate(1 / 60, { driver });
  world.step();
  if (i % 60 === 0) {
    const l = v.body.linvel(), a = v.body.angvel(), p = v.body.translation();
    console.log((i / 60).toFixed(0), 'v', l.x.toFixed(3), l.y.toFixed(3), l.z.toFixed(3), 'w', a.x.toFixed(3), a.y.toFixed(3), a.z.toFixed(3), 'p', p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3), 'hold', v.hold, 'sleep', v.body.isSleeping(), 'loads', v.wheels.map((w) => w.load.toFixed(0)).join('/'));
  }
}
// pose + per-wheel state at the end
const q = v.body.rotation();
console.log('rot', q.x.toFixed(4), q.y.toFixed(4), q.z.toFixed(4), q.w.toFixed(4), 'com', JSON.stringify(v.spec.com), 'mountY', v.wheels.map((w) => w.mountY.toFixed(3)), 'dist', v.wheels.map((w) => w.dist.toFixed(3)), 'comp', v.wheels.map((w) => w.comp.toFixed(3)), 'omega', v.wheels.map((w) => w.omega.toFixed(3)), 'anchor', v.wheels.map((w) => w.anchorSet));
