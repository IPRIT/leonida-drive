import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { Terrain } from '../../src/world/Terrain.js';
import { Roads } from '../../src/world/Roads.js';
import { Buildings } from '../../src/world/Buildings.js';

export function worldFixture({ dir = process.env.DATA || './public/data', buildings = false } = {}) {
  const json = (n) => JSON.parse(fs.readFileSync(`${dir}/${n}.json`));
  const bin = (n) => { const b = fs.readFileSync(`${dir}/${n}.bin`); return b[0] === 31 && b[1] === 139 ? zlib.gunzipSync(b) : b; };
  const h = bin('height');
  const data = { world: json('world'), roads: json('roads'), junctions: json('junctions'),
    heights: new Int16Array(h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength)), groundTex: new Uint8Array(bin('ground')) };
  if (buildings) { data.buildings = json('buildings'); data.irl = json('irl'); }
  const scene = new THREE.Scene(), terrain = new Terrain(data, scene), roads = new Roads(data, terrain, scene);
  return { data, scene, terrain, roads, buildings: buildings ? new Buildings(data, terrain, scene) : null };
}
