import * as THREE from 'three';
import { Terrain } from './Terrain.js';
import { Roads } from './Roads.js';
import { Buildings } from './Buildings.js';
import '../landmarks/index.js'; // install exactly the same runway / taxiway hooks as bootstrap
import { packRoads, packBuildings } from './worldBuild.js';
import { transferBuffers } from './geometryTransfer.js';

self.onmessage = ({ data }) => {
  try {
    const scene = new THREE.Scene(), terrain = new Terrain(data, scene);
    const roads = new Roads(data, terrain, scene);
    const rp = packRoads(roads, terrain);
    self.postMessage({ phase: 'roads', result: rp }, transferBuffers(rp));
    // Buildings use the road-conformed terrain, including tunnel cuts.
    const buildings = new Buildings(data, terrain, new THREE.Scene());
    const bp = packBuildings(buildings);
    self.postMessage({ phase: 'buildings', result: bp }, transferBuffers(bp));
  } catch (e) { self.postMessage({ error: String(e?.stack || e) }); }
};
