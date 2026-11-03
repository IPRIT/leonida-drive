// dev: full-throttle launch trace for one vehicle: node src/vehicle/dev/probe2.mjs id [seconds] [torqueScale]
import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from '../physics/VehiclePhysics.js';
import { VEHICLE_PRESETS } from '../presets.js';
import { GROUPS, groups } from '../groups.js';
await RAPIER.init();
const id = process.argv[2] || 'aero', T = +(process.argv[3] || 10), k = +(process.argv[4] || 1);
const p = JSON.parse(JSON.stringify(VEHICLE_PRESETS[id]));
p.engine.curve = p.engine.curve.map(([r, t]) => [r, t * k]);
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = 1 / 60;
const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 0.5, 6000).setTranslation(0, -0.5, 0).setCollisionGroups(groups(GROUPS.GROUND)), gb);
world.step();
const v = new VehiclePhysics({ RAPIER, world, preset: p, position: { x: 0, y: 0, z: 0 }, yaw: 0 });
for (let i = 0; i < 90; i++) { v.fixedUpdate(1 / 60, {}); world.step(); }
console.log('finalDrive', v.spec.gearbox.finalDrive.toFixed(2), 'cda', v.spec.aero.cda.toFixed(3), 'gears', v.spec.gearbox.gears.join(','), 'maxT', Math.max(...v.spec.engine.curve.map((c) => c[1])).toFixed(1));
for (let i = 0; i < T * 60; i++) {
  v.fixedUpdate(1 / 60, { throttle: 1 });
  world.step();
  if (i % 30 === 0) {
    const t = v.telemetry;
    console.log((i / 60).toFixed(1), 'kmh', t.speedKmh.toFixed(1), 'gear', t.gear, 'rpm', t.rpm.toFixed(0), 'slip', v.wheels.map((w) => w.slipRatio.toFixed(2)).join('/'), 'fallen', v.fallen, 'wheelie', v.wheelie.toFixed(2), 'contacts', v.wheels.map((w) => (w.contact ? 1 : 0)).join(''));
  }
}
