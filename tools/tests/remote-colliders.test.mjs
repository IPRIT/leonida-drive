import test from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { RemoteColliders, collisionPoseSafe } from '../../src/net/RemoteColliders.js';

await RAPIER.init();
const dims = { width: 2, height: 2, length: 4, originY: 0 };
function fixture() {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, .7, 2).setMass(1500), body);
  const game = { RAPIER, world, player: { focus: { x: 0, y: 2, z: 0 }, controllable: { body } },
    net: { client: { online: true, clock: { rtt: 80 } }, store: { delay: 180, target: 180 } } };
  const models = { current: dims, dims() { return this.current; } };
  const proxy = new RemoteColliders(game, models);
  const e = { id: 42, model: 1, state: 'live', alpha: 1, tp: 0, hasCurve: true, vclass: 1,
    x: 20, y: 1, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, recvAt: performance.now(), sampleDelay: 100, off: new Float64Array(12) };
  return { game, world, body, models, proxy, e, close() { proxy.dispose(); world.free(); } };
}
const active = (p) => p.slots.filter(s => s.body.isEnabled());

test('disconnect and high latency immediately disable remote physics bodies', () => {
  const f = fixture();
  try {
    f.proxy.assign([f.e]);assert.equal(active(f.proxy).length,1);
    active(f.proxy)[0].body.setLinvel({x:-30,y:0,z:0},true);
    f.game.net.client.online=false;
    f.proxy.fixedUpdate(1/60,0);
    assert.equal(active(f.proxy).length,0,'a disconnect cannot leave a moving collision body');
    f.game.net.client.online=true;f.game.net.store.target=1000;
    f.proxy.assign([f.e]);assert.equal(active(f.proxy).length,0);
    f.game.net.store.target=180;f.e.sampleDelay=900;
    f.proxy.assign([f.e]);assert.equal(active(f.proxy).length,0,'a delayed sender is visual-only too');
  } finally { f.close(); }
});
test('returning players cannot materialise inside the local car or launch it', () => {
  const f=fixture();
  try {
    f.e.x=0;
    for(let i=0;i<120;i++){f.proxy.assign([f.e]);f.proxy.fixedUpdate(1/60,0);f.world.step();}
    assert.equal(active(f.proxy).length,0);
    assert.ok(Math.hypot(f.body.linvel().x,f.body.linvel().y,f.body.linvel().z)<.001);
    assert.ok(Math.abs(f.body.translation().x)<.001);
    f.e.x=8;f.proxy.assign([f.e]);assert.equal(active(f.proxy).length,1,'solid again once separated');
    f.e.x=0;f.e.y=30;f.proxy.fixedUpdate(1/60,0);
    assert.equal(active(f.proxy).length,0,'a large vertical correction is never a physical sweep');
  } finally {f.close();}
});
test('worker model dimensions replace the generic shape and are rechecked on changes',()=>{
  const f=fixture();
  try{
    f.models.current=null;f.proxy.assign([f.e]);assert.equal(active(f.proxy).length,0);
    f.models.current=dims;f.proxy.assign([f.e]);assert.equal(active(f.proxy).length,1);
    f.models.current={...dims,width:6};f.proxy.assign([f.e]);
    assert.ok(Math.abs(active(f.proxy)[0].col.halfExtents().x-2.82)<.001);
    f.e.off[0]=12;assert.equal(collisionPoseSafe(f.e,f.game.net,performance.now()),false);
    f.proxy.assign([f.e]);assert.equal(active(f.proxy).length,0);
  }finally{f.close();}
});
test('healthy nearby players still exchange collision momentum',()=>{
  const f=fixture();
  try{
    f.e.x=7;f.e.vx=-5;
    for(let i=0;i<100;i++){
      f.e.x-=5/60;f.proxy.assign([f.e]);f.proxy.fixedUpdate(1/60,0);f.world.step();
    }
    assert.ok(f.body.translation().x<-.1,'a real collision still moves the local car');
    assert.ok(Math.abs(f.body.linvel().x)<12,'no unbounded correction impulse');
  }finally{f.close();}
});
