#!/usr/bin/env node
// Exact 2D geometry of the landmark sites for the map pipeline (tools/map_build.py): runway rectangles,
// taxiway centrelines, aprons / stands, parked aircraft and the outlines of every site's main structures.
// Runs the real src/landmarks build in node (no browser): the world classes are built from public/data, a
// stub canvas stands in for the sign atlas. Writes tools/cache/landmark_geom.json (format: see
// src/landmarks/INTEGRATION.md, "Map geometry export").
//
//   node tools/landmark_geom.mjs [--out path] [--pretty]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(ROOT, 'tools/cache/landmark_geom.json');
const PRETTY = args.includes('--pretty');

// ---------- browser stubs (sign atlas canvas, a few globals) ----------
const ctx2d = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return (s) => ({ width: String(s).length * 10 });
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }) };
globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem() {} };

const THREE = await import('three');
const { Terrain } = await import('../src/world/Terrain.js');
const { Roads } = await import('../src/world/Roads.js');
const { Buildings } = await import('../src/world/Buildings.js');
globalThis.LMK_SYNC_BAKE = true; // bake parked models here (their sizes go to src/landmarks/vehicle-dims.js)
const { createLandmarks, SITES } = await import('../src/landmarks/index.js'); // installs the Roads hooks first
const { taxiwayEdges } = await import('../src/landmarks/airside.js');
const { hull2d } = await import('../src/landmarks/kit.js');

// ---------- world data (same files as src/core/data.js) ----------
const D = path.join(ROOT, 'public/data');
const bin = (f) => { const b = fs.readFileSync(path.join(D, f)); return b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b; };
const json = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const opt = (f) => { try { return json(f); } catch { return null; } };
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const data = { world: json('world.json'), roads: json('roads.json'), buildings: json('buildings.json'), irl: opt('irl.json'), junctions: opt('junctions.json') };
data.heights = new Int16Array(toAB(bin('height.bin')));
data.groundTex = new Uint8Array(toAB(bin('ground.bin')));

const t0 = Date.now();
const scene = new THREE.Scene();
const game = { scene, settings: {}, quality: {}, modules: [], register(m) { this.modules.push(m); return m; }, uniforms: { uTime: { value: 0 }, uNight: { value: 0 }, uWetness: { value: 0 } }, events: { on() {} } };
game.terrain = new Terrain(data, scene);
game.roads = new Roads(data, game.terrain, scene);
game.buildings = new Buildings(data, game.terrain, scene);
const lm = createLandmarks(game, { log: false });
if (args.includes('--report')) {
  const report = lm.sites.map(({ id, name, x, z, skipped, why, removed, views }) => ({ id, name, skipped, why, removed, views,
    candidates: game.buildings.query(x, z, 35).map((i) => {
      const r = game.buildings.recs[i], p = game.buildings.list[i].p;
      return { i, x: r.cx, z: r.cz, removed: r.removed,
        minGround: Math.min(...Array.from({ length: p.length / 2 }, (_, k) => game.terrain.heightAt(p[k * 2], p[k * 2 + 1]))) };
    }) }));
  fs.writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify(report));
}

// ---------- export ----------
const r2 = (v) => Math.round(v * 100) / 100;
const pt = (x, z) => [r2(x), r2(z)];
const rect = (x, z, c, s, hx, hz) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => pt(x + c * a * hx + s * b * hz, z - s * a * hx + c * b * hz));
const circle = (x, z, r, n = 16) => Array.from({ length: n }, (_, i) => pt(x + Math.cos((i / n) * Math.PI * 2) * r, z + Math.sin((i / n) * Math.PI * 2) * r));

const runways = lm.runwayDecks.map((d) => {
  const sEnd = d.S[d.S.length - 1], len = d.len ?? sEnd + d.S[0];
  const at = (s) => pt(d.x0 + d.dx * s, d.z0 + d.dz * s);
  const hw = d.w ? d.w / 2 : d.ow - 7.5;
  return {
    airport: d.airport || '', designations: [d.numA || '', d.numB || ''],
    thresholds: [at(0), at(len)], dir: [r2(d.dx), r2(d.dz)], length: r2(len), width: r2(hw * 2), shoulder: 7.5,
    pavement: { from: at(d.S[0]), to: at(sEnd), width: r2(d.ow * 2) },
    outline: [at(d.S[0]), at(sEnd)].length && [
      pt(d.x0 + d.dx * d.S[0] - d.dz * -hw, d.z0 + d.dz * d.S[0] + d.dx * -hw), pt(d.x0 + d.dx * sEnd - d.dz * -hw, d.z0 + d.dz * sEnd + d.dx * -hw),
      pt(d.x0 + d.dx * sEnd - d.dz * hw, d.z0 + d.dz * sEnd + d.dx * hw), pt(d.x0 + d.dx * d.S[0] - d.dz * hw, d.z0 + d.dz * d.S[0] + d.dx * hw),
    ],
  };
});

const taxiways = [...taxiwayEdges(game.roads)].filter((i) => !lm.hidden.has(i)).map((i) => {
  const e = game.roads.edges[i];
  const line = [];
  for (let k = 0; k < e.n; k++) line.push(pt(e.pts[2 * k], e.pts[2 * k + 1]));
  return { edge: i, width: r2(e.w), line };
});

const aprons = (lm.apronPolys || []).map((p) => p.map(([x, z]) => pt(x, z)));

const aircraft = [];
for (const t of lm.instTypes.values()) {
  for (const [x, , z, yaw] of t.list) aircraft.push({ type: t.type.key, x: r2(x), z: r2(z), yaw: r2(yaw) });
}
for (const v of lm.vehicles) {
  if (v.m.kind !== 'plane' && v.m.kind !== 'heli' && v.m.kind !== 'blimp') continue;
  aircraft.push({ type: v.m.key, x: r2(v.x), z: r2(v.z), yaw: r2(v.yaw), length: r2(v.m.len), span: r2(v.m.wid) });
}

// structure outlines per site: every landmark collider with a real footprint (boxes, vertical cylinders, hulls)
const bySite = new Map(lm.sites.map((s) => [s.id, { id: s.id, name: s.name, kind: s.kind, x: r2(s.x), z: r2(s.z), outlines: [] }]));
for (const it of lm.colliders.items) {
  if (it.off || it.vehicle) continue;
  const tag = typeof it.tag === 'string' ? it.tag.replace(/:runway$/, '') : null;
  if (!tag || it.tag.endsWith(':runway')) continue;
  const site = bySite.get(tag);
  if (!site) continue;
  if (it.shape === 0) {
    if (Math.min(it.a, it.c) < 1.5 || it.b < 1.5) continue; // fences, kerbs, thin parts
    const yaw = 2 * Math.atan2(it.q.y, it.q.w);
    site.outlines.push({ shape: 'rect', top: r2(it.y + it.b), poly: rect(it.x, it.z, Math.cos(yaw), Math.sin(yaw), it.a, it.c) });
  } else if (it.shape === 1) {
    if (it.a < 2) continue; // masts, posts
    site.outlines.push({ shape: 'circle', top: r2(it.y + it.b), center: pt(it.x, it.z), radius: r2(it.a), poly: circle(it.x, it.z, it.a) });
  } else {
    const pts = [];
    for (let i = 0; i < it.pts.length; i += 3) pts.push([it.x + it.pts[i], it.z + it.pts[i + 2]]);
    if (it.reach < 2) continue;
    let top = -Infinity;
    for (let i = 1; i < it.pts.length; i += 3) top = Math.max(top, it.y + it.pts[i]);
    site.outlines.push({ shape: 'hull', top: r2(top), poly: hull2d(pts).map(([x, z]) => pt(x, z)) });
  }
}

const out = {
  version: 1, generated: new Date().toISOString(), frame: 'world x / z metres (map: x = x, y = -z)',
  sites: [...bySite.values()], runways, taxiways, aprons, aircraft,
  features: lm.mapExtras.map((f) => JSON.parse(JSON.stringify(f, (k, v) => (typeof v === 'number' ? r2(v) : v)))),
  stats: { sites: lm.sites.length, runways: runways.length, taxiways: taxiways.length, aprons: aprons.length, aircraft: aircraft.length, ms: Date.now() - t0 },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, PRETTY ? 1 : 0));
// Rebuild ownership whenever footprints change; stale centroid lists could let
// the IRL pass or vector map put buildings back inside landmark sites.
const centroids = [...lm.removed].map((id) => {
  const r = game.buildings.recs[id];
  return r ? [r2(r.cx), r2(r.cz)] : null;
}).filter(Boolean);
fs.mkdirSync(path.join(ROOT, 'tools/cache/osm'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tools/cache/osm/landmark_takes.json'), JSON.stringify({ note: 'Generated by tools/landmark_geom.mjs from current landmark ownership.', centroids }));
{ // sizes of the parked models, so the game places them without baking on the main thread
  const { vehicleDimsTable } = await import('../src/landmarks/vehicles.js');
  const dims = vehicleDimsTable();
  const body = Object.entries(dims).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/landmarks/vehicle-dims.js'),
    '// generated by tools/landmark_geom.mjs: sizes of the parked models (vehicles.js) so the landmark build can place\n' +
    '// them without baking; the geometry is baked off the main thread (vehicleWorker.js)\n' +
    `export const VEHICLE_DIMS = {\n${body}\n};\n`);
  console.log('vehicle dims:', Object.keys(dims).length, 'models');
}
console.log(`landmark_geom: ${OUT}`, out.stats);
