import test from 'node:test';import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import {safeAdminPose,placeVehicleExactly} from '../../src/net/placement.js';
import {VehiclePhysics} from '../../src/vehicle/physics/VehiclePhysics.js';
import {GROUPS,groups} from '../../src/vehicle/groups.js';
await R.init();
test('newly streamed walls are respected before the next physics step',()=>{
 const w=new R.World({x:0,y:-9.81,z:0});const body=w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0,3,0));
 w.createCollider(R.ColliderDesc.cuboid(.8,.5,2),body);w.step();
 w.createCollider(R.ColliderDesc.cuboid(40,.5,40).setTranslation(100,-.5,100).setCollisionGroups(groups(GROUPS.GROUND,0xffff)));
 w.createCollider(R.ColliderDesc.cuboid(2,4,2).setTranslation(100,4,100).setCollisionGroups(groups(GROUPS.STATIC,0xffff)));
 const g={RAPIER:R,world:w,terrain:{heightAt:()=>0},player:{state:'vehicle',controllable:{body,kind:'car',physics:{spec:{restHeight:1}}}}};
 const p=safeAdminPose(g,{x:100,y:1.3,z:100,yaw:0});assert.ok(p);assert.ok(Math.hypot(p.x-100,p.z-100)>=3);assert.ok(p.y<2,'do not put the car on top of the wall');
 w.free();
});
test('exact car placement preserves the network body height',()=>{
 const w=new R.World({x:0,y:-9.81,z:0}),ph=new VehiclePhysics({RAPIER:R,world:w,preset:'pip',position:{x:0,y:0,z:0},env:{}});
 placeVehicleExactly({kind:'car',physics:ph},{x:20,y:9,z:30},.5,{heightAt:()=>0});
 assert.ok(Math.abs(ph.body.translation().y-9)<.00001);w.free();
});
test('aircraft travel uses the exact body pose instead of garage runway placement',()=>{
 let received;const v={kind:'plane',spec:{vTop:100},reset(){throw new Error('garage reset must not run');},physics:{reset(p,yaw,s){received={p,yaw,s};}}};
 const p={x:1200,y:400,z:-600};placeVehicleExactly(v,p,1,{heightAt:()=>0});assert.deepEqual(received.p,p);assert.equal(received.s.air,true);assert.ok(received.s.speed>0);
});
