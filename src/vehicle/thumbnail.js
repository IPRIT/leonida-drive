// Studio renderer for vehicle previews. Uses the game's own WebGLRenderer (no second context) and its own tiny
// scene whose lights are created once, so shader programs compile once. Output: transparent-background 2D canvases.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { deriveSpec } from './physics/VehiclePhysics.js';
import { buildCarModel } from './CarModel.js';
import { getCatalogEntry } from './catalog.js';

const studios = new WeakMap();
const _c = new THREE.Vector3();

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.7)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.32)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// linear HDR -> ACES-ish tone map -> sRGB, flipped vertically so readPixels rows come out top-down
const OUT_VS = 'varying vec2 vUv; void main(){ vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = vec4(position.xy, 0.0, 1.0); }';
const OUT_FS = `
  uniform sampler2D tSrc; uniform float uExposure; varying vec2 vUv;
  vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
  vec3 srgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  void main(){
    vec4 s = texture2D(tSrc, vUv);
    vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
    gl_FragColor = vec4(srgb(aces(c * uExposure)), s.a);
  }`;

/** Shared studio (scene, lights, env map, output pass) for a renderer. Created once. */
export function getStudio(renderer) {
  let s = studios.get(renderer);
  if (s) return s;
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pm.fromScene(room, 0.04).texture;
  pm.dispose();
  room.traverse((o) => o.isMesh && (o.geometry.dispose(), o.material.dispose?.()));
  scene.environmentIntensity = 0.85;
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x4a4036, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-5, 9, -4);
  scene.add(key);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  shadow.renderOrder = -1;
  scene.add(shadow);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 400);
  const outScene = new THREE.Scene();
  const outMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uExposure: { value: 1.05 } }, vertexShader: OUT_VS, fragmentShader: OUT_FS, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), outMat);
  quad.frustumCulled = false;
  outScene.add(quad);
  s = { scene, camera, shadow, outScene, outCam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), outMat, targets: new Map() };
  studios.set(renderer, s);
  return s;
}

function targetsFor(st, w, h) {
  const key = `${w}x${h}`;
  let t = st.targets.get(key);
  if (!t) {
    t = {
      hdr: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true }),
      out: new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false }),
      px: new Uint8Array(w * h * 4),
    };
    st.targets.set(key, t);
  }
  return t;
}

/** Release cached render targets of a given size (or all of them). */
export function releaseStudioTargets(renderer, w, h) {
  const st = studios.get(renderer);
  if (!st) return;
  for (const [k, t] of st.targets) {
    if (w && k !== `${w}x${h}`) continue;
    t.hdr.dispose();
    t.out.dispose();
    st.targets.delete(k);
  }
}

// Frame `object` in the studio and render it into the size's output target (RGBA8, rows top-down). Returns the targets.
function drawStudio(renderer, object, w, h, view = {}) {
  const st = getStudio(renderer);
  const strip = [];
  object.traverse((o) => o.isLight && strip.push(o));
  for (const l of strip) l.removeFromParent(); // keep the studio light count constant
  st.scene.add(object);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const sz = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
  st.shadow.scale.set(sz.x * 1.3 + 0.3, 1, sz.z * 1.1 + 0.3);
  st.shadow.position.set(ctr.x, box.min.y + 0.005, ctr.z);
  const cam = st.camera;
  cam.aspect = w / h;
  const yaw = view.yaw ?? -0.72, pitch = view.pitch ?? 0.3;
  const radius = 0.5 * Math.hypot(sz.x, sz.y, sz.z);
  const vfov = THREE.MathUtils.degToRad(cam.fov / 2);
  const hfov = Math.atan(Math.tan(vfov) * cam.aspect);
  let dist = radius / Math.sin(Math.min(vfov, hfov));
  if (view.look) ctr.set(view.look[0], view.look[1], view.look[2]);
  const place = () => {
    cam.position.set(ctr.x + Math.sin(yaw) * dist * Math.cos(pitch), ctr.y + dist * Math.sin(pitch), ctr.z - Math.cos(yaw) * dist * Math.cos(pitch));
    cam.lookAt(ctr.x, ctr.y - sz.y * 0.04, ctr.z);
    cam.near = Math.max(0.05, dist - radius * 2);
    cam.far = dist + radius * 3;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  };
  place();
  if (!view.look) {
    // tighten the framing on the projected bounding box (two passes)
    for (let it = 0; it < 2; it++) {
      let m = 0;
      for (let k = 0; k < 8; k++) {
        _c.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).project(cam);
        m = Math.max(m, Math.abs(_c.x), Math.abs(_c.y));
      }
      dist *= Math.max(0.3, m / 0.86);
      place();
    }
  }
  if (view.zoom && view.zoom !== 1) {
    dist *= view.zoom;
    place();
  }
  const t = targetsFor(st, w, h);
  const prevRT = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(t.hdr);
  renderer.clear(true, true, true);
  renderer.render(st.scene, cam);
  st.outMat.uniforms.tSrc.value = t.hdr.texture;
  renderer.setRenderTarget(t.out);
  renderer.clear(true, false, false);
  renderer.render(st.outScene, st.outCam);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.autoClear = prevAuto;
  st.scene.remove(object);
  // the game keeps every shader program alive (Renderer.pinPrograms): pin the studio variants before the preview's
  // materials are disposed, or the next thumbnail compiles them again
  renderer.leonidaPinPrograms?.();
  return t;
}

function blit(canvas, px, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, 0, w * h * 4), w, h), 0, 0);
  return canvas;
}

/**
 * Render an Object3D (ground at its bounding-box bottom) in the studio into a 2D `canvas` of w x h.
 * Renderer state is restored. view: { yaw (rad, 0 = straight at the front), pitch, zoom, look:[x,y,z] }
 * Synchronous GPU readback (stalls 10-80 ms with the game running): tools only, the game uses renderStudioAsync.
 */
export function renderStudio(renderer, object, canvas, w, h, view = {}) {
  const t = drawStudio(renderer, object, w, h, view);
  renderer.readRenderTargetPixels(t.out, 0, 0, w, h, t.px);
  return blit(canvas, t.px, w, h);
}

/**
 * Same image as renderStudio, without stalling: the pixels are copied into a pixel-pack buffer and read once the GPU
 * has finished (fence), a frame or two later. Returns a promise of `canvas`, or null (nothing drawn) while a readback
 * of this size is still in flight: the caller retries / skips the frame. The object may be disposed right after.
 */
export function renderStudioAsync(renderer, object, canvas, w, h, view = {}) {
  const st = getStudio(renderer);
  const busy = st.busy || (st.busy = new Set());
  const key = `${w}x${h}`;
  if (busy.has(key)) return null;
  const t = drawStudio(renderer, object, w, h, view);
  if (typeof renderer.readRenderTargetPixelsAsync !== 'function') {
    renderer.readRenderTargetPixels(t.out, 0, 0, w, h, t.px);
    return Promise.resolve(blit(canvas, t.px, w, h));
  }
  busy.add(key);
  return renderer.readRenderTargetPixelsAsync(t.out, 0, 0, w, h, t.px)
    .then(() => blit(canvas, t.px, w, h))
    .finally(() => busy.delete(key));
}

/**
 * Compile the studio programs of `object` in the background (KHR_parallel_shader_compile) and fetch their uniform
 * tables outside of any frame, so its first studio render does not stall on shader compilation.
 */
export async function warmStudio(renderer, object) {
  const st = getStudio(renderer);
  const t = targetsFor(st, 64, 64);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(t.hdr); // linear output, like the real studio render
  let mats;
  try {
    mats = renderer.compile(object, st.camera, st.scene);
    if (!st.warmed) { // studio shadow disc + output pass, once
      st.warmed = true;
      for (const m of renderer.compile(st.scene, st.camera)) mats.add(m);
      renderer.setRenderTarget(t.out);
      for (const m of renderer.compile(st.outScene, st.outCam)) mats.add(m);
    }
  } finally { renderer.setRenderTarget(prev); }
  renderer.leonidaPinPrograms?.();
  const props = renderer.properties;
  const ready = () => { for (const m of mats) { const p = props.get(m).currentProgram; if (p && p.isReady && !p.isReady()) return false; } return true; };
  renderer.getContext().flush();
  // timers are throttled to 1 s in hidden tabs (loading in the background): poll with message ticks there
  const wait = () => new Promise((r) => { if (document.hidden) { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); } else setTimeout(r, 8); });
  for (const t0 = performance.now(); !ready() && performance.now() - t0 < 2000;) await wait();
  for (const m of mats) { try { props.get(m).currentProgram?.getUniforms(); } catch { /* reported on use */ } }
}

/** Preview Object3D of a catalog vehicle (cars, trucks, buses, small, bikes). userData.dispose() frees it. */
export function buildPreviewObject(id, { lod = 'high', color } = {}) {
  const entry = getCatalogEntry(id);
  if (typeof entry?.buildPreview === 'function') return entry.buildPreview({ lod, color });
  const spec = deriveSpec(id);
  const model = buildCarModel(spec, { color: color ?? entry?.palette?.[0] ?? spec.color, color2: entry?.palette2, lod, parts: false });
  const g = new THREE.Group();
  g.add(model.body);
  for (const w of model.wheels) g.add(w.pivot);
  if (model.lightbar) {
    model.materials.sirenRed.emissiveIntensity = 1.5;
    model.materials.sirenBlue.emissiveIntensity = 1.5;
  }
  model.materials.head.emissiveIntensity = 0.6;
  g.userData.dispose = () => {
    g.traverse((o) => o.isMesh && o.geometry.dispose());
    for (const m of Object.values(model.materials)) m.dispose();
  };
  return g;
}

const cache = new Map();

/** Synchronous 2D-canvas thumbnail of a catalog vehicle (uncached). opts: color, yaw, pitch, zoom, width, height, lod, hide */
export function renderVehicleThumbnailCanvas(id, renderer, size = 256, opts = {}) {
  const obj = buildPreviewObject(id, { color: opts.color, lod: opts.lod || 'high' });
  if (opts.hide) obj.traverse((o) => { if (o.isMesh && (opts.hide.includes(o.name) || opts.hide.includes(o.userData.part))) o.visible = false; });
  const canvas = document.createElement('canvas');
  renderStudio(renderer, obj, canvas, opts.width ?? size, opts.height ?? size, opts);
  obj.userData.dispose();
  return canvas;
}

/**
 * Render a catalog vehicle thumbnail (cached per id/size/colour).
 * @param {string} id catalog id
 * @param {THREE.WebGLRenderer} renderer the game renderer (state is restored)
 * @param {number} [size=256]
 * @param {{color?: number, yaw?: number}} [opts]
 * @returns {string} PNG data URL with transparent background
 */
export function renderVehicleThumbnail(id, renderer, size = 256, opts = {}) {
  const key = `${id}|${size}|${opts.color ?? ''}|${opts.yaw ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = renderVehicleThumbnailCanvas(id, renderer, size, opts).toDataURL('image/png');
  cache.set(key, url);
  return url;
}

export function clearThumbnailCache() {
  cache.clear();
}
