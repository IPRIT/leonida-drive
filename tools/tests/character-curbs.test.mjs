import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { CharacterMotor } from '../../src/characters/CharacterMotor.js';
import { worldFixture } from './world-fixture.mjs';

await R.init();
test('walking over real Ocean Beach kerbs never builds up lethal landing speed',()=>{
  const {roads,terrain}=worldFixture();const w=new R.World({x:0,y:-9.81,z:0});
  terrain.updateColliders(R,w,1958,-1002,250,0xffffffff);roads.updateColliders(R,w,1958,-1002,250,0xffffffff,1e9);
  while(terrain.colStream?.step(1e9,true));while(roads.colStream?.step(1e9,true));w.step();
  const at=roads.nearest(1958,-1002,30,e=>e.kind===0),p=roads.pointAt(at.edge,at.edge.len*.5);
  const m=new CharacterMotor(R,w,{pos:{x:p.x,y:p.y+.12,z:p.z}});
  let maxLand=0,minY=Infinity,maxY=-Infinity;
  for(let i=0;i<1200;i++){
    const dir=i%300<150?1:-1;m.step(1/60,-p.tz*2.5*dir,p.tx*2.5*dir);w.step();
    maxLand=Math.max(maxLand,m.landSpeed);minY=Math.min(minY,m.cur.y);maxY=Math.max(maxY,m.cur.y);
  }
  assert.ok(maxY-minY<1,'the fixture only crosses pavement and a kerb');
  assert.ok(maxLand<5,`small kerb reported ${maxLand.toFixed(2)} m/s landing`);
  m.dispose();w.free();
});
test('real falls still produce impact speed and ordinary jump landings remain harmless',()=>{
  for(const [height,min,max] of [[.2,0,5],[12,10.5,19],[35,21,30]]){
    const w=new R.World({x:0,y:-9.81,z:0});w.createCollider(R.ColliderDesc.cuboid(20,.5,20).setTranslation(0,-.5,0));
    const m=new CharacterMotor(R,w,{pos:{x:0,y:height,z:0}});let peak=0;
    for(let i=0;i<300;i++){m.step(1/60,0,0);w.step();peak=Math.max(peak,m.landSpeed);}
    assert.ok(peak>=min&&peak<max,`${height} m fall: ${peak} m/s`);m.dispose();w.free();
  }
});
