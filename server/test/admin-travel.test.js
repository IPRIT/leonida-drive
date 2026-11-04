import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { passwordHash } from '../src/admin.js';
import { C_ADMIN,S_ADMIN,ADMIN_CORRECTION,jsonMessage } from '../../src/net/shared/extensions.js';
import { S_CORRECTION,S_NOTICE,S_SPAWN_ACK,S_OWNED,NOTICE,SLOT_MASK } from '../../src/net/shared/constants.js';
import { travelDestination } from '../src/admin-travel.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const quiet={info(){},warn(){},error:console.error};
const ask=async(c,id,op,values={})=>{const p=c.next(S_ADMIN,r=>r.id===id,5000);c.send(jsonMessage(C_ADMIN,{id,op,...values}));return p;};
for(const workers of [0,2])test(`admin travel is authorized, acknowledged, and exact across ${workers} workers`,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leonida-travel-'));
 const port=21640+workers;
 const srv=await startServer({port,host:'127.0.0.1',workers,dbPath:path.join(dir,'test.db'),maxPlayers:128,
  joinAnywhere:true,adminPasswordHash:passwordHash('travel-test-fixture'),log:quiet,flushMs:100,maxConnPerIp:32});
 const url=`ws://127.0.0.1:${port}/ws`,a=new TestClient(url),b=new TestClient(url),old=new TestClient(url,{exactPlacement:false});let again;
 const notices=[];b.on(S_NOTICE,n=>notices.push(n));
 try{
  await a.connect();await b.connect();await old.connect();
  const poseA={x:1728,y:2,z:-733,model:a.modelIndex('pip')},poseB={x:2000,y:2,z:-750,model:b.modelIndex('pip')};
  a.sendState(poseA);b.sendState(poseB);old.sendState({...poseB,x:2050});await sleep(180);
  assert.equal((await ask(a,1,'bring',{target:b.welcome.netId})).reason,'auth');
  assert.equal((await ask(a,2,'login',{password:'travel-test-fixture'})).ok,true);
  assert.equal((await ask(a,3,'bring',{target:old.welcome.netId})).reason,'update');await sleep(520);
  const correction=b.next(S_CORRECTION,c=>c.reason===ADMIN_CORRECTION);
  const done=ask(a,4,'bring',{target:b.welcome.netId});let settled=false;done.then(()=>settled=true);
  const c=await correction;assert.ok(Math.hypot(c.x-poseA.x,c.z-poseA.z)<40);await sleep(100);assert.equal(settled,false,'no success before target applies the move');
  b.sendState({...poseB,...c});assert.equal((await done).ok,true);
  assert.equal((await ask(a,4,'bring',{target:b.welcome.netId})).reason,'replay');
  for(let i=0;i<8;i++){b.sendState({...poseB,...c,x:c.x+i*.1});await sleep(55);}
  assert.equal(b.kick,null);assert.ok(!notices.some(n=>n.code===NOTICE.CLAIMS_FROZEN));
  // Travel in the opposite direction (the actor moves).
  await sleep(520);const move=a.next(S_CORRECTION,c=>c.reason===ADMIN_CORRECTION),travel=ask(a,5,'travel_to',{target:b.welcome.netId});
  const d=await move;a.sendState({...poseA,...d});assert.equal((await travel).ok,true);
  // A client can reject an unsafe destination without being frozen.
  await sleep(520);const reposition=a.next(S_CORRECTION,c=>c.reason===ADMIN_CORRECTION),repositioned=ask(a,6,'travel_to',{target:old.welcome.netId});
  const far=await reposition;a.sendState({...poseA,...far});assert.equal((await repositioned).ok,true);await sleep(520);
  const denied=b.next(S_CORRECTION,c=>c.reason===ADMIN_CORRECTION),blocked=ask(a,7,'bring',{target:b.welcome.netId});
  await denied;b.sendState({...poseB,...c});assert.equal((await blocked).reason,'space');assert.equal(b.kick,null);
  // A packet can arrive just before disconnect. The one-use allowance must
  // survive a resume, while admin login itself must not survive reconnect.
  await sleep(520);const pending=b.next(S_CORRECTION,c=>c.reason===ADMIN_CORRECTION),lost=ask(a,8,'bring',{target:b.welcome.netId});
  const e=await pending;const token=b.token;b.close();await lost;await sleep(200);
  again=new TestClient(url,{token,resume:true});await again.connect();again.sendState({...poseB,...e});await sleep(200);
  assert.equal(again.kick,null,'resume after receiving the destination is accepted');
  const slot=again.welcome.netId&SLOT_MASK;assert.ok(Math.hypot(srv.v.pos[slot*3]-e.x,srv.v.pos[slot*3+2]-e.z)<1);
  assert.equal((await ask(again,1,'credit',{amount:1})).reason,'auth');
  // Aircraft travel uses an airborne exact pose and remains usable afterwards.
  const plane=again.modelIndex('plane_trainer'),spawned=again.next(S_SPAWN_ACK);
  again.spawn(plane,0xffffff,e.x,e.z);assert.equal((await spawned).code,0);
  again.sendState({...poseB,...e,model:plane});await sleep(180);
  const flight=again.next(S_CORRECTION,q=>q.reason===ADMIN_CORRECTION),flightDone=ask(a,9,'bring',{target:again.welcome.netId});
  const f=await flight;assert.ok(f.y>=220,'aircraft arrives above ground');
  again.sendState({...f,model:plane});assert.equal((await flightDone).ok,true);
  for(let i=0;i<8;i++){again.sendState({...f,model:plane,z:f.z-i*.1});await sleep(55);}
  assert.equal(again.kick,null,'flight after admin travel is accepted');

 }finally{a.close();b.close();old.close();again?.close();await srv.close();fs.rmSync(dir,{recursive:true,force:true});}
});
