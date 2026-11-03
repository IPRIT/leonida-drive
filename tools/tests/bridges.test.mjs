// Bridge / overpass geometry audit: grade, grade change (kinks), height mismatches at joints, deck vs. terrain.
import fs from 'node:fs';
import * as THREE from 'three';
import { Roads } from '../../src/world/Roads.js';

const roads = JSON.parse(fs.readFileSync('./public/data/roads.json'));
const terrain = { G: { urban: 7, paved: 8, building: 9, sport: 11, road: 10 }, heightAt: () => 0, groundAt: () => 7 };
const R = new Roads({ roads }, terrain, new THREE.Scene());
const issues = [];
let nBridgeEdges = 0, nBridgeKm = 0;
for (const e of R.edges) {
  if (!e.br) continue;
  nBridgeEdges++;
  let maxGrade = 0, maxKink = 0, worstK = -1;
  let prevG = null;
  for (let k = 0; k < e.n - 1; k++) {
    const ds = e.cum[k + 1] - e.cum[k];
    if (ds < 0.5) continue;
    const g = (e.y[k + 1] - e.y[k]) / ds;
    if (e.br[k] || e.br[k + 1]) nBridgeKm += ds / 1000;
    if (Math.abs(g) > maxGrade) maxGrade = Math.abs(g);
    if (prevG !== null) {
      const kink = Math.abs(g - prevG);
      if (kink > maxKink) { maxKink = kink; worstK = k; }
    }
    prevG = g;
  }
  if (maxGrade > 0.09 || maxKink > 0.035) {
    const p = R.pointAt(e, e.cum[Math.max(0, worstK)]);
    issues.push({ e: e.i, kind: e.kind, len: +e.len.toFixed(0), lifted: !!e.lifted, maxGrade: +maxGrade.toFixed(3), maxKink: +maxKink.toFixed(3), at: [Math.round(p.x), Math.round(p.z)] });
  }
}
// joints: all edge ends meeting at a node should share the same height
let joints = 0;
const jointIssues = [];
for (let ni = 0; ni < R.nodes.length; ni++) {
  const ys = R.adj[ni].map((ei) => { const e = R.edges[ei]; return e.a === ni ? e.y[0] : e.y[e.n - 1]; });
  if (ys.length < 2) continue;
  const spread = Math.max(...ys) - Math.min(...ys);
  if (spread > 0.25) { joints++; jointIssues.push({ ni, spread: +spread.toFixed(2), at: R.nodes[ni].map(Math.round), bridge: R.adj[ni].some((ei) => R.edges[ei].br) }); }
}
issues.sort((a, b) => b.maxKink - a.maxKink);
jointIssues.sort((a, b) => b.spread - a.spread);
console.log(JSON.stringify({ bridgeEdges: nBridgeEdges, bridgeKm: +nBridgeKm.toFixed(1), overpasses: R.overpasses.length, profileIssues: issues.length, jointIssues: joints }));
console.log('worst profiles', JSON.stringify(issues.slice(0, 12)));
console.log('worst joints', JSON.stringify(jointIssues.slice(0, 12)));
