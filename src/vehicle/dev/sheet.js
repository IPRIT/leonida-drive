// Dev-only contact sheet: renders catalog vehicles in a grid. ?cat=sports&cols=4&yaw=0.7&lod=low&ids=a,b
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { VEHICLE_CATALOG } from '../catalog.js';
import { deriveSpec } from '../physics/VehiclePhysics.js';
import { buildCarModel } from '../CarModel.js';

const q = new URLSearchParams(location.search);
const cols = +(q.get('cols') || 4);
const rows = +(q.get('rows') || 0);
document.body.style.setProperty('--cols', cols);
if (rows) document.head.insertAdjacentHTML('beforeend', `<style>.cell{aspect-ratio:auto;height:${100 / rows}vh}</style>`);
let list = VEHICLE_CATALOG.map((e) => e.id);
if (q.get('cat')) list = VEHICLE_CATALOG.filter((e) => q.get('cat').split(',').includes(e.category)).map((e) => e.id);
if (q.get('ids')) list = q.get('ids').split(',');
const yaw = +(q.get('yaw') ?? 0.75);
const pitch = +(q.get('pitch') ?? 0.32);
const lod = q.get('lod') || 'high';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.domElement.id = 'gl';
document.body.appendChild(renderer.domElement);
const pm = new THREE.PMREMGenerator(renderer);
const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;

const grid = document.getElementById('grid');
const cells = [];
const info = [];
for (const id of list) {
  const div = document.createElement('div');
  div.className = 'cell';
  const sp = document.createElement('span');
  div.appendChild(sp);
  grid.appendChild(div);
  const e = VEHICLE_CATALOG.find((x) => x.id === id);
  const scene = new THREE.Scene();
  scene.environment = env;
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x403a30, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-4, 8, -3);
  scene.add(sun);
  const t0 = performance.now();
  let tris = 0;
  try {
    const spec = deriveSpec(id);
    const m = buildCarModel(spec, { color: e?.palette?.[q.get('pi') | 0] ?? spec.color, color2: e?.palette2, lod });
    const g = new THREE.Group();
    g.add(m.body);
    for (const w of m.wheels) g.add(w.pivot);
    scene.add(g);
    const hide = (q.get('hide') || '').split(',');
    g.traverse((o) => { if (o.isMesh) { tris += o.geometry.attributes.position.count / 3; if (hide.includes(o.name) || hide.includes(o.userData.part)) o.visible = false; } });
    if (q.get('noground') === null) scene.add(new THREE.Mesh(new THREE.CircleGeometry(Math.max(4, spec.size.length * 0.8), 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x55595f, roughness: 0.9 })));
    const L = Math.max(spec.size.length, spec.size.height * 2.2);
    const cam = new THREE.PerspectiveCamera(30, 4 / 3, 0.1, 200);
    const dist = (L * 1.75 + 1.2) * +(q.get('zoom') || 1);
    cam.position.set(Math.sin(yaw) * -dist * Math.cos(pitch), spec.size.height * 0.5 + dist * Math.sin(pitch), -Math.cos(yaw) * dist * Math.cos(pitch));
    cam.lookAt(+(q.get('lx') || 0), spec.size.height * 0.42, +(q.get('lz') || 0));
    cells.push({ div, scene, cam });
    sp.textContent = `${e ? e.brand + ' ' + e.name : id} [${id}] ${Math.round(tris)}t ${(performance.now() - t0).toFixed(0)}ms`;
  } catch (err) {
    sp.textContent = `${id}: ${err.message}`;
    console.error(id, err);
  }
}

function frame() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  renderer.setScissorTest(true);
  renderer.setClearColor(0x2b2f36);
  renderer.clear();
  for (const c of cells) {
    const r = c.div.getBoundingClientRect();
    if (r.bottom < 0 || r.top > h) continue;
    renderer.setViewport(r.left, h - r.bottom, r.width, r.height);
    renderer.setScissor(r.left, h - r.bottom, r.width, r.height);
    c.cam.aspect = r.width / r.height;
    c.cam.updateProjectionMatrix();
    renderer.setClearColor(0x3a3f48);
    renderer.clear();
    renderer.render(c.scene, c.cam);
  }
  requestAnimationFrame(frame);
}
frame();
window.__sheetReady = true;
