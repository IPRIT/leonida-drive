// Dev-only: renders catalog thumbnails into one contact-sheet PNG and POSTs it to a local sink
// (works in a background tab: no requestAnimationFrame). ?cat=…&ids=…&size=200&cols=6&name=sheet&sink=http://127.0.0.1:5487
import * as THREE from 'three';
import { VEHICLE_CATALOG } from '../catalog.js';
import { renderVehicleThumbnailCanvas } from '../thumbnail.js';

const q = new URLSearchParams(location.search);
let list = VEHICLE_CATALOG.map((e) => e.id);
if (q.get('cat')) list = VEHICLE_CATALOG.filter((e) => q.get('cat').split(',').includes(e.category)).map((e) => e.id);
if (q.get('ids')) list = q.get('ids').split(',');
const size = +(q.get('size') || 200);
const cols = +(q.get('cols') || 6);
const yaw = q.get('yaw') !== null ? +q.get('yaw') : undefined;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: false });
renderer.setSize(16, 16);
const rows = Math.ceil(list.length / cols);
const cv = document.createElement('canvas');
cv.width = cols * size;
cv.height = rows * size;
const g = cv.getContext('2d');
g.fillStyle = '#3a3f48';
g.fillRect(0, 0, cv.width, cv.height);
const times = [];
for (let i = 0; i < list.length; i++) {
  const id = list[i];
  const t0 = performance.now();
  let img;
  try { img = renderVehicleThumbnailCanvas(id, renderer, size, { yaw, pitch: q.get('pitch') !== null ? +q.get('pitch') : undefined, zoom: +(q.get('zoom') || 1), hide: q.get('hide')?.split(','), look: q.get('look')?.split(',').map(Number), color: q.get('pi') ? VEHICLE_CATALOG.find((e) => e.id === id)?.palette?.[+q.get('pi')] : undefined }); } catch (e) { console.error(id, e); continue; }
  times.push(performance.now() - t0);
  const x = (i % cols) * size, y = Math.floor(i / cols) * size;
  g.drawImage(img, x, y);
  g.fillStyle = '#fff';
  g.fillText(id, x + 4, y + 12);
}
document.getElementById('out').textContent = `done ${list.length} avg ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms`;
const sink = q.get('sink') || 'http://127.0.0.1:5487';
await fetch(`${sink}/?name=${q.get('name') || 'sheet'}`, { method: 'POST', body: cv.toDataURL('image/png') });
window.__shotDone = true;
