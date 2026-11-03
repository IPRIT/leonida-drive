import fs from 'node:fs';
import * as THREE from 'three';
import { Roads } from '../../src/world/Roads.js';
const roads = JSON.parse(fs.readFileSync('./public/data/roads.json'));
const terrain = { G: { urban: 7, paved: 8, building: 9, sport: 11, road: 10 }, heightAt: () => 0, groundAt: () => 7 };
const t0 = performance.now();
const R = new Roads({ roads }, terrain, new THREE.Scene());
console.log('build ms', (performance.now() - t0).toFixed(0));
console.log('overpasses', R.overpasses.length);
const hw = R.edges.filter(e => e.kind === 1);
console.log('highway', hw.length, 'oneway', hw.filter(e => e.oneway).length, 'km oneway', (hw.filter(e=>e.oneway).reduce((s,e)=>s+e.len,0)/1000).toFixed(1), 'km total', (hw.reduce((s,e)=>s+e.len,0)/1000).toFixed(1));
// dead ends for one-way flow: nodes where a one-way edge flows in but nothing can leave
let dead = 0;
for (const e of hw.filter(e => e.oneway)) {
  const end = e.oneway > 0 ? e.b : e.a;
  const outs = R.adj[end].filter(ei => ei !== e.i && R.allowedFrom(R.edges[ei], end));
  if (!outs.length) dead++;
}
console.log('one-way dead ends', dead);
let src = 0;
for (const e of hw.filter(e => e.oneway)) {
  const st = e.oneway > 0 ? e.a : e.b;
  const ins = R.adj[st].filter(ei => { const f = R.edges[ei]; return f !== e && R.allowedFrom(f, f.a === st ? f.b : f.a); });
  if (!ins.length) src++;
}
console.log('one-way sources (no way in)', src);
const r = R.route(1745, -640, -3000, -6000);
console.log('route pts', r ? r.length / 2 : null);
console.log(R.overpasses.slice(0, 5).map(o => [o.x.toFixed(0), o.z.toFixed(0)]));
// diagnostics: why candidates were skipped
const R2 = new Roads({ roads: JSON.parse(fs.readFileSync('./public/data/roads.json')) }, terrain, new THREE.Scene());
