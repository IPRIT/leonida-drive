import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnostics, FrameHistory } from '../../src/debug/metrics.js';
import { LinkEmulator } from '../../src/debug/LinkEmulator.js';
import { Economy } from '../../src/economy/Economy.js';
test('diagnostic export uses an explicit allowlist and excludes credentials',()=>{
  const h=new FrameHistory(3);[10,20,30,40].forEach(v=>h.push(v));assert.deepEqual(h.ordered(),[20,30,40]);
  const secret='private-fixture';
  const g={mode:'online',settings:{password:secret},net:{client:{token:secret,adminWait:new Map([[1,secret]]),clock:{rtt:50},store:{jitter:1,delay:100,list:[],stats:{}},tracks:{list:[]},ws:{secret,bufferedAmount:0}}},render:{stats:()=>({fps:60,token:secret})}};
  const report=JSON.stringify(diagnostics(g,h));assert.ok(!report.includes(secret));assert.ok(!report.includes('password'));assert.ok(report.includes('fps'));
});
test('turning off impairment cancels queued old poses',async()=>{
  const link=new LinkEmulator();link.configure('severe');let sent=0;
  link.outgoing(new ArrayBuffer(1),()=>sent++);link.stop();
  await new Promise(r=>setTimeout(r,20));assert.equal(sent,0);assert.equal(link.timers.size,0);assert.equal(link.active,false);
});
test('flying a debug/photo camera cannot discover districts or submit money claims',()=>{
  const probe={game:{player:{mode:'free',focus:{x:0,y:2,z:0}},world3d:{areaAt(){throw new Error('camera must not discover a district');}}},remote:false};
  assert.doesNotThrow(()=>Economy.prototype._discover.call(probe));
});
