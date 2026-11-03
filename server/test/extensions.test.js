import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { TestClient } from '../tools/client.js';
import { AdminAuth, passwordHash } from '../src/admin.js';
import { C_ADMIN, S_ADMIN, S_MAP, MAP_ORDER, MAP_HEADER, MAP_ENTRY, jsonMessage, readMapEntry } from '../../src/net/shared/extensions.js';
import { encodeList } from '../../src/net/shared/protocol.js';
import { S_OWNED } from '../../src/net/shared/constants.js';

test('admin verifier is disabled by default; wrong passwords are bounded across connections', async () => {
  assert.equal(await new AdminAuth('').verify('ip','test',0),'disabled');
  const auth = new AdminAuth(passwordHash('test-only-fixture'));
  assert.equal(await auth.verify('good','test-only-fixture',0),'ok');
  for(let i=0;i<5;i++)assert.equal(await auth.verify('bad','wrong',i*2000),'password');
  assert.equal(await auth.verify('bad','test-only-fixture',12000),'rate');
  assert.equal(await auth.verify('bad','test-only-fixture',16*60000),'ok');
});

test('self-admin requires login, rejects replay, persists credits and unlocks, and expires on reconnect', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'leonida-admin-'));
  const srv=await startServer({port:21317,host:'127.0.0.1',workers:0,dbPath:path.join(tmp,'test.db'),maxPlayers:128,
    adminPasswordHash:passwordHash('test-only-fixture'),log:{info(){},warn(){},error:console.error},flushMs:250});
  const a=new TestClient('ws://127.0.0.1:21317/ws'),b=new TestClient('ws://127.0.0.1:21317/ws');
  const request=async(c,id,op,values={})=>{const result=c.next(S_ADMIN,r=>r.id===id);c.ws.send(jsonMessage(C_ADMIN,{id,op,...values}));return result;};
  let again;
  try{
    await a.connect();await b.connect();const initial=a.welcome.money,other=b.welcome.money;
    assert.equal((await request(a,1,'credit',{amount:10000})).reason,'auth');
    assert.equal((await request(a,2,'login',{password:'wrong'})).reason,'password');
    assert.equal((await request(a,3,'login',{password:'test-only-fixture'})).ok,true);
    assert.equal((await request(a,4,'credit',{amount:1000000})).balance,initial+1000000);
    assert.equal((await request(a,4,'credit',{amount:1000000})).reason,'replay');
    assert.equal(b.money??b.welcome.money,other,'another player is unaffected');
    assert.equal((await request(b,1,'credit',{amount:1000000})).reason,'auth','no authority leaks to another socket');
    await new Promise(r=>setTimeout(r,520));
    const owned=a.next(S_OWNED);assert.equal((await request(a,5,'unlock')).ok,true);assert.ok((await owned).owned.length>50);
    const token=a.token;a.close();await new Promise(r=>setTimeout(r,350));
    again=new TestClient('ws://127.0.0.1:21317/ws',{token});await again.connect();
    assert.equal(again.welcome.money,initial+1000000);
    assert.equal((await request(again,1,'credit',{amount:1})).reason,'auth','reconnect needs fresh login');
  }finally{a.close();b.close();again?.close();await srv.close();fs.rmSync(tmp,{recursive:true,force:true});}
});

test('world-map stream includes distant players, paginates all entries, and never creates 3D interest', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'leonida-map-'));
  const srv=await startServer({port:21318,host:'127.0.0.1',workers:0,dbPath:path.join(tmp,'test.db'),maxPlayers:2048,capacity:1100,
    joinAnywhere:true,log:{info(){},warn(){},error:console.error}});
  const a=new TestClient('ws://127.0.0.1:21318/ws');
  try{
    await a.connect();a.sendState({x:1728,y:2,z:-733,model:a.modelIndex('pip')});
    // Synthetic authoritative remote slots, spread well outside the local AOI.
    for(let i=10;i<1110;i++){
      srv.v.alive[i]=1;srv.v.gen[i]=1;srv.v.pos[i*3]=-8000+(i%100)*4;srv.v.pos[i*3+1]=2;srv.v.pos[i*3+2]=-8000+Math.floor(i/100)*4;
      srv.v.sampleT[i]=performance.timeOrigin+performance.now();srv.v.receivedT[i]=srv.v.sampleT[i];
    }
    await new Promise(r=>setTimeout(r,2200));
    const first=a.next(S_MAP);a.ws.send(encodeList(MAP_ORDER,0,0));const page=await first;
    assert.equal(page.getUint16(2,true),1024);assert.equal(page.getUint8(1),0);
    assert.equal(page.getUint32(4,true),1101);
    const id=readMapEntry(page,MAP_HEADER,{});assert.ok(Number.isFinite(id.x));
    await new Promise(r=>setTimeout(r,100));
    const next=a.next(S_MAP);a.ws.send(encodeList(MAP_ORDER,0,1024));const tail=await next;
    assert.equal(tail.getUint8(1),1);assert.equal(tail.getUint16(2,true),77);
    assert.equal(tail.byteLength,MAP_HEADER+77*MAP_ENTRY);
    assert.equal([...a.records.keys()].filter(id=>id!==a.welcome.netId).length,0,'map-only recipients do not subscribe to distant geometry');
  }finally{a.close();await srv.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
