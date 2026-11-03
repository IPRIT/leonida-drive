// Character preview for the wardrobe menu: a small turntable of the player's figure in an outfit. Renders with the
// game's own WebGLRenderer (no second context) into render targets of a private studio scene (lights, environment
// and output pass created once per renderer and reused), then copies the pixels into a 2D canvas inside the given
// element. ~30 fps, only while the element is visible. The pixels come back asynchronously (pixel-pack buffer + fence:
// no GPU stall in the game's frame); the studio is compiled and drawn once ahead (prewarmCharacterPreview).
//
//   const pv = createCharacterPreview(game, el)   // el: any sized element (the canvas fills it)
//   pv.setOutfit(outfit)     // { slot: { id, color } } (see wardrobe.js; aliases and the economy format work too)
//   pv.rotate(yaw)           // absolute turntable angle (rad), 0 = facing the camera
//   pv.setView('body'|'face')
//   pv.dispose()
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HumanBatch } from './HumanBatch.js';
import { makeDims, fk, pelvisMatrix, NJ, J } from './rig.js';
import * as PZ from './poses.js';
import { lookData } from './looks.js';
import { outfitToLook, outfitKey, DEFAULT_OUTFIT, WARDROBE_BY_ID } from './wardrobe.js';
import { TAT } from './lookcodes.js';

const MAX_W = 480, MAX_H = 640, MAX_DPR = 1.5, FPS = 30;
const studios = new WeakMap();

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

function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.62)');
  grd.addColorStop(0.45, 'rgba(0,0,0,0.3)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// one studio per renderer: scene, lights, environment, figure batch (4 slots), output pass
function getStudio(renderer) {
  let s = studios.get(renderer);
  if (s) return s;
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pm.fromScene(room, 0.04).texture;
  pm.dispose();
  room.traverse((o) => o.isMesh && (o.geometry.dispose(), o.material.dispose?.()));
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xfff2ea, 0x3a3046, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(-2.5, 4.5, -4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff7ab8, 1.4); // neon-pink rim from behind (Miami nights)
  rim.position.set(3, 2.5, 4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0x6fe6ff, 0.6);
  fill.position.set(4, 1.5, -2);
  scene.add(fill);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: floorTexture(), transparent: true, depthWrite: false }));
  floor.renderOrder = -1;
  scene.add(floor);
  const batch = new HumanBatch(scene, 4, { far: false, mid: false, shadows: false });
  const camera = new THREE.PerspectiveCamera(26, 0.75, 0.1, 50);
  const outScene = new THREE.Scene();
  const outMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uExposure: { value: 1.0 } }, vertexShader: OUT_VS, fragmentShader: OUT_FS, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), outMat);
  quad.frustumCulled = false;
  outScene.add(quad);
  s = { scene, camera, rim, batch, outScene, outCam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), outMat, compiled: null };
  // compile for a linear render target (the studio renders into one), output pass included
  const prev = renderer.getRenderTarget();
  const tmp = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  renderer.setRenderTarget(tmp);
  let mats = new Set();
  try { mats = renderer.compile(scene, camera); for (const m of renderer.compile(outScene, s.outCam)) mats.add(m); } catch (e) { console.warn('[wardrobe] studio compile', e); }
  renderer.setRenderTarget(prev);
  tmp.dispose();
  // programs link in parallel (KHR_parallel_shader_compile); poll without blocking (message ticks in hidden tabs,
  // where timers are throttled to 1 s)
  const props = renderer.properties;
  const ready = () => { for (const m of mats) { const p = props.get(m).currentProgram; if (p && p.isReady && !p.isReady()) return false; } return true; };
  const wait = () => new Promise((r) => { if (document.hidden) { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); } else setTimeout(r, 8); });
  renderer.getContext().flush();
  s.compiled = (async () => { for (const t0 = performance.now(); !ready() && performance.now() - t0 < 3000;) await wait(); })();
  studios.set(renderer, s);
  return s;
}

// one studio frame of figure `slot` into rt (HDR, MSAA) → out (RGBA8, rows top-down); renderer state restored
function drawFigure(renderer, st, rt, out, cam) {
  const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
  const prevColor = renderer.getClearColor(_prevColor), prevAlpha = renderer.getClearAlpha();
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, true);
  renderer.render(st.scene, cam);
  st.outMat.uniforms.tSrc.value = rt.texture;
  renderer.setRenderTarget(out);
  renderer.clear(true, false, false);
  renderer.render(st.outScene, st.outCam);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.autoClear = prevAuto;
}

/**
 * Loading screen / idle: create the studio, compile its programs in the background and draw one figure into tiny
 * targets (GPU pipelines, uniform tables), so opening the wardrobe does not stall the game for ~0.4 s.
 */
export function prewarmCharacterPreview(renderer) {
  const st = getStudio(renderer);
  return st.compiled.then(() => {
    if (st.drawn) return;
    st.drawn = true;
    const slot = st.batch.alloc();
    if (slot < 0) return;
    const rt = new THREE.WebGLRenderTarget(32, 32, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
    const out = new THREE.WebGLRenderTarget(32, 32, { type: THREE.UnsignedByteType, depthBuffer: false });
    try {
      const look = outfitToLook(DEFAULT_OUTFIT), dims = makeDims(look);
      st.batch.setLook(slot, lookData(look, dims));
      const P = PZ.newPose(), W = new Float32Array(NJ * 12), M = new Float32Array(12);
      PZ.poseIdle(P, 0, 3.7, dims);
      pelvisMatrix(M, 0, 0, 0, 0, P, dims);
      fk(W, M, P, dims);
      st.batch.writeFigure(slot, W, dims, 0, false);
      st.batch.flush();
      const cam = st.camera;
      cam.aspect = 0.75;
      cam.position.set(0, dims.h * 0.6, -4);
      cam.lookAt(0, dims.h * 0.52, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      drawFigure(renderer, st, rt, out, cam);
      renderer.leonidaPinPrograms?.();
    } catch (e) { console.warn('[wardrobe] preview prewarm', e); }
    st.batch.release(slot);
    rt.dispose(); out.dispose();
  });
}

const _cam = new THREE.Vector3(), _look = new THREE.Vector3();

/** @returns {{setOutfit(o:object):void, rotate(yaw:number):void, setView(v:string):void, zoom(v:string):void, dispose():void}} */
export function createCharacterPreview(game, el, { outfit = null } = {}) {
  const renderer = game.renderer;
  const st = getStudio(renderer);
  const slot = st.batch.alloc();
  const canvas = document.createElement('canvas');
  canvas.className = 'char-preview';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.appendChild(canvas);
  const ctx2d = canvas.getContext('2d');
  let look = null, dims = null, key = '', yaw = 0.4, shownYaw = 0.4, view = 'body', viewK = 0, flash = 0;
  let rt = null, out = null, px = null, w = 0, h = 0, reading = false;
  let visible = true, alive = true, raf = 0, last = 0, ready = false, t = Math.random() * 10;
  const P = PZ.newPose(), T = PZ.newPose(), W = new Float32Array(NJ * 12), M = new Float32Array(12);
  st.compiled.then(() => { ready = true; });

  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }) : null;
  io?.observe(el);

  function apply(o) {
    const k = outfitKey(o || DEFAULT_OUTFIT);
    if (k === key && look) return;
    const first = !look;
    key = k;
    look = outfitToLook(o || DEFAULT_OUTFIT);
    dims = makeDims(look);
    if (slot >= 0) st.batch.setLook(slot, lookData(look, dims));
    if (!first) flash = 1; // a little rim-light pop on every change
    if (first) PZ.poseIdle(P, 0, 3.7, dims);
  }
  apply(outfit);

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const cw = Math.max(1, Math.round(el.clientWidth * dpr)), ch = Math.max(1, Math.round(el.clientHeight * dpr));
    const k = Math.min(1, MAX_W / cw, MAX_H / ch);
    const nw = Math.max(16, Math.round(cw * k)), nh = Math.max(16, Math.round(ch * k));
    if (nw === w && nh === h) return;
    if (reading) return; // resize once the readback of the old size is back
    w = nw; h = nh;
    rt?.dispose(); out?.dispose();
    rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
    out = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
    px = new Uint8Array(w * h * 4);
    canvas.width = w; canvas.height = h;
  }

  function frame(dt) {
    if (!look || slot < 0) return;
    t += dt;
    // turntable: ease towards the requested angle; idle breathing and weight shifts
    shownYaw += Math.atan2(Math.sin(yaw - shownYaw), Math.cos(yaw - shownYaw)) * Math.min(1, dt * 12);
    PZ.poseIdle(T, t, 3.7, dims);
    PZ.blendPose(P, T, 1 - Math.exp(-dt * 8));
    pelvisMatrix(M, 0, 0, 0, shownYaw, P, dims);
    fk(W, M, P, dims);
    st.batch.writeFigure(slot, W, dims, 0, false);
    st.batch.flush();
    // camera: full body or a head-and-shoulders close-up
    viewK += ((view === 'face' ? 1 : 0) - viewK) * Math.min(1, dt * 6);
    const cam = st.camera;
    cam.aspect = w / h;
    const hh = dims.h;
    const fitH = hh * 0.55 + 0.07, half = THREE.MathUtils.degToRad(cam.fov / 2);
    const distBody = Math.max(fitH / Math.tan(half), (hh * 0.3) / (Math.tan(half) * Math.min(1, cam.aspect)));
    const dist = THREE.MathUtils.lerp(distBody, 1.25, viewK);
    const ly = THREE.MathUtils.lerp(hh * 0.52, hh * 0.9, viewK);
    _look.set(0, ly, 0);
    _cam.set(0, ly + THREE.MathUtils.lerp(0.35, 0.06, viewK), -dist);
    cam.position.copy(_cam);
    cam.lookAt(_look);
    cam.near = 0.05; cam.far = dist + 6;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    flash = Math.max(0, flash - dt * 2.5);
    st.rim.intensity = 1.4 + flash * 4;
    // render into the studio targets with the game's renderer (state restored), read the pixels back without a stall
    drawFigure(renderer, st, rt, out, cam);
    const bw = w, bh = h, buf = px;
    const show = () => { if (alive && buf === px) ctx2d.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, 0, bw * bh * 4), bw, bh), 0, 0); };
    if (typeof renderer.readRenderTargetPixelsAsync !== 'function') { renderer.readRenderTargetPixels(out, 0, 0, w, h, px); show(); return; }
    reading = true;
    renderer.readRenderTargetPixelsAsync(out, 0, 0, w, h, px).then(show, () => {}).finally(() => { reading = false; });
  }

  function loop(now) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (!ready || !visible || document.hidden || !el.isConnected || !el.clientWidth || !el.clientHeight) { last = now; return; }
    if (now - last < 1000 / FPS - 2 || reading) return; // one readback in flight at a time
    const dt = Math.min(0.1, (now - (last || now)) / 1000) || 1 / FPS;
    last = now;
    try { size(); frame(dt); } catch (e) { console.warn('[wardrobe] preview frame failed', e); alive = false; }
  }
  raf = requestAnimationFrame(loop);

  return {
    setOutfit(o) { apply(o); },
    rotate(a) { if (Number.isFinite(a)) yaw = a; },
    setView(v) { view = v === 'face' || v === 'head' ? 'face' : 'body'; },
    zoom(v) { this.setView(v); },
    get canvas() { return canvas; },
    dispose() {
      if (!alive && !canvas.isConnected) return;
      alive = false;
      cancelAnimationFrame(raf);
      io?.disconnect();
      canvas.remove();
      rt?.dispose(); out?.dispose();
      rt = out = null;
      if (slot >= 0) st.batch.release(slot);
    },
  };
}
const _prevColor = new THREE.Color();

// ---------------- per-item thumbnails (wardrobe cards) ----------------
// Each item is rendered on a neutral mannequin (white tee, navy chinos, white sneakers, short hair) in the item's
// colour, framed on its body region (head, face, ears, neck, torso, wrist, hips, legs, feet, the tattooed skin, or the
// whole figure for body types). Same studio and renderer as the turntable; one bake at a time, at most one every
// BAKE_GAP ms, asynchronous readback (no GPU stall), each bake a couple of ms of main thread. Results are cached as
// ImageBitmaps per item + colour (LRU).
//
//   const thumbs = getWardrobeThumbs(game)
//   thumbs.get(id, color)            -> ImageBitmap | null (cached)
//   thumbs.request(id, color, prio)  -> bake soon (prio 1 = on screen now, 0 = prefetch); repeated requests debounce
//   thumbs.onReady((key) => …)       -> unsubscribe; key = thumbs.key(id, color)
const THUMB_W = 288, THUMB_H = 216, BAKE_GAP = 140, DEBOUNCE = 110, CACHE_MAX = 160;
const MANNEQUIN = {
  body: { id: 'body_athletic', color: 0xc68c5c }, hair: { id: 'hair_short', color: 0x2a1b12 }, facial: { id: 'facial_none' },
  top: { id: 'top_tee', color: 0xeef0f2 }, jacket: { id: 'jacket_none' }, legs: { id: 'legs_chinos', color: 0x2b3445 },
  shoes: { id: 'shoes_sneakers', color: 0xf4f4f4 }, hat: { id: 'hat_none' }, glasses: { id: 'glasses_none' },
  accessory: { id: 'acc_none' }, tattoo: { id: 'tat_none' },
};
const _jp = new THREE.Vector3(), _jq = new THREE.Vector3();
const jointPos = (W, j, out) => out.set(W[j * 12 + 9], W[j * 12 + 10], W[j * 12 + 11]);

// what to show for an item: { yaw (figure turn), vh (visible height, m), target(W, d, out) }
function thumbFrame(it) {
  const head = (dy = 0.5) => (W, d, o) => jointPos(W, J.HEAD, o).add(_jq.set(0, d.headH * dy, 0));
  const mid = (a, b, k = 0.5) => (W, d, o) => jointPos(W, a, o).lerp(jointPos(W, b, _jq), k);
  const L = it.look || {};
  switch (it.slot) {
    case 'hair': return { yaw: 0.55, vh: 0.5, target: head(0.62) };
    case 'facial': return { yaw: 0.35, vh: 0.36, target: head(0.32) };
    case 'hat': return { yaw: 0.4, vh: 0.56, target: head(0.85) };
    case 'glasses': return { yaw: 0.22, vh: 0.3, target: head(0.58) };
    case 'top': case 'jacket': return { yaw: 0.3, vh: 0.84, target: (W, d, o) => jointPos(W, J.CHEST, o).add(_jq.set(0, d.chestH * 0.15, 0)) };
    case 'legs': return { yaw: 0.3, vh: L.bottom === 'skirt' && L.longSkirt ? 1.05 : 1.0, target: mid(J.PELVIS, J.LLEG_L, 0.75) };
    case 'shoes': return { yaw: 0.75, vh: 0.42, target: (W, d, o) => jointPos(W, J.FOOT_L, o).lerp(jointPos(W, J.FOOT_R, _jq), 0.5).setY(d.ankleH * 1.6) };
    case 'body': return { yaw: 0.35, vh: 0, full: true, target: (W, d, o) => o.set(0, d.h * 0.52, 0) };
    case 'accessory': {
      if (L.backpack) return { yaw: Math.PI - 0.45, vh: 0.95, target: (W, d, o) => jointPos(W, J.CHEST, o) };
      if (L.beltbag) return { yaw: 0.35, vh: 0.6, target: (W, d, o) => jointPos(W, J.PELVIS, o) };
      const n = !!L.chain + !!L.watch + !!L.bracelet + !!L.rings + !!L.earrings;
      if (n > 1) return { yaw: 0.25, vh: 1.0, target: (W, d, o) => jointPos(W, J.CHEST, o).add(_jq.set(0, -d.chestH * 0.2, 0)) };
      if (L.chain) return { yaw: 0.2, vh: 0.42, target: (W, d, o) => jointPos(W, J.NECK, o).add(_jq.set(0, -d.chestH * 0.35, 0)) };
      if (L.watch) return { yaw: -1.35, vh: 0.32, target: (W, d, o) => jointPos(W, J.HAND_L, o) };
      if (L.bracelet || L.rings) return { yaw: 1.35, vh: 0.32, target: (W, d, o) => jointPos(W, J.HAND_R, o).add(_jq.set(0, -d.handL * 0.35, 0)) };
      if (L.earrings) return { yaw: 1.3, vh: 0.34, target: head(0.3) };
      return { yaw: 0.3, vh: 1.0, target: (W, d, o) => jointPos(W, J.CHEST, o) };
    }
    case 'tattoo': {
      const parts = Object.keys(L.tattoos || {});
      const back = Object.values(L.tattoos || {}).some((c) => Math.floor(c) === TAT.wings || Math.floor(c) === TAT.burst);
      if (!parts.length) return { yaw: 0.3, vh: 1.0, target: (W, d, o) => jointPos(W, J.CHEST, o) };
      if (back) return { yaw: Math.PI, vh: 0.9, target: (W, d, o) => jointPos(W, J.CHEST, o).add(_jq.set(0, d.chestH * 0.1, 0)) };
      const arm = (s) => parts.some((p) => p === `uArm${s}` || p === `lArm${s}`);
      const only = (re) => parts.every((p) => re.test(p));
      // turn the design towards the camera: a design centred at angle a around the limb (shader: atan(z, x) of the
      // part) faces the camera (at −Z) when the figure turns by a + π/2; bands that wrap around show their outer side
      const code = L.tattoos[parts[0]], st = Math.floor(code), seed = (code - st) * 10;
      const centred = [TAT.star, TAT.rose, TAT.palm, TAT.sun, TAT.heart].includes(st);
      const side = (left) => (st === TAT.script ? seed - 5 : centred ? seed : left ? Math.PI : 0) + Math.PI / 2;
      if (only(/^neck$/)) return { yaw: side(false), vh: 0.34, target: (W, d, o) => jointPos(W, J.NECK, o).add(_jq.set(0, d.neckH, 0)) };
      if (only(/^chest$/)) return { yaw: side(false), vh: 0.75, target: (W, d, o) => jointPos(W, J.CHEST, o).add(_jq.set(0, d.chestH * 0.4, 0)) };
      if (only(/Leg/)) return { yaw: -Math.PI / 2 + 0.4, vh: 0.65, target: mid(J.LLEG_R, J.FOOT_R, 0.35) };
      if (arm('L') && !arm('R')) return { yaw: side(true), vh: parts.length > 1 ? 0.72 : 0.44, target: only(/^lArmL$/) ? mid(J.LARM_L, J.HAND_L, 0.45) : only(/^uArmL$/) ? mid(J.UARM_L, J.LARM_L, 0.55) : mid(J.UARM_L, J.LARM_L, 0.9) };
      if (arm('R') && !arm('L')) return { yaw: side(false), vh: parts.length > 1 ? 0.72 : 0.44, target: only(/^lArmR$/) ? mid(J.LARM_R, J.HAND_R, 0.45) : only(/^uArmR$/) ? mid(J.UARM_R, J.LARM_R, 0.55) : mid(J.UARM_R, J.LARM_R, 0.9) };
      return { yaw: 0.0, vh: 1.0, target: (W, d, o) => jointPos(W, J.CHEST, o).add(_jq.set(0, -d.chestH * 0.3, 0)) };
    }
    default: return { yaw: 0.3, vh: 1.0, target: (W, d, o) => jointPos(W, J.CHEST, o) };
  }
}

function thumbOutfit(it, color) {
  const o = { ...MANNEQUIN };
  if (it.slot === 'tattoo') { o.top = { id: 'top_shirtless' }; o.legs = { id: 'legs_shorts', color: 0x2b3445 }; }
  if (it.slot === 'jacket') o.top = { id: 'top_tee', color: 0xeef0f2 };
  if (it.slot === 'hat') o.hair = { id: 'hair_short', color: 0x2a1b12 };
  if (it.slot === 'facial' || it.slot === 'glasses') o.hair = { id: 'hair_buzz', color: 0x2a1b12 };
  o[it.slot] = { id: it.id, color: color ?? it.colors?.[0] ?? null };
  return o;
}

const services = new WeakMap();
export function getWardrobeThumbs(game) {
  let svc = services.get(game);
  if (svc) return svc;
  const renderer = game.renderer;
  const cache = new Map(), queue = new Map(), listeners = new Set(), stats = { bakes: 0, msAvg: 0, msMax: 0 };
  let slot = -1, rt = null, out = null, px = null, busy = false, timer = 0, lastBake = 0, ready = false;
  const P = PZ.newPose(), W = new Float32Array(NJ * 12), M = new Float32Array(12);
  const key = (id, color) => `${id}|${color ?? WARDROBE_BY_ID.get(id)?.colors?.[0] ?? '-'}`;
  const st = getStudio(renderer);
  st.compiled.then(() => { ready = true; schedule(); });

  function schedule(delay = 0) {
    if (timer || !queue.size) return;
    timer = setTimeout(() => { timer = 0; tick(); }, Math.max(delay, 16));
  }
  function emit(k) { for (const fn of [...listeners]) { try { fn(k); } catch (e) { console.warn('[wardrobe] thumb listener', e); } } }

  // next job: on-screen requests first, the most recent first; requests younger than DEBOUNCE wait (swatch clicks)
  function pick(now) {
    let best = null, wait = Infinity;
    for (const j of queue.values()) {
      const age = now - j.t;
      if (age < DEBOUNCE) { wait = Math.min(wait, DEBOUNCE - age); continue; }
      if (!best || j.prio > best.prio || (j.prio === best.prio && j.t > best.t)) best = j;
    }
    return { best, wait };
  }

  function tick() {
    if (!ready || busy) return;
    const now = performance.now();
    if (now - lastBake < BAKE_GAP) { schedule(BAKE_GAP - (now - lastBake)); return; }
    if (document.hidden) { schedule(500); return; }
    const { best, wait } = pick(now);
    if (!best) { if (queue.size) schedule(wait); return; }
    queue.delete(best.k);
    lastBake = now;
    try { bake(best); } catch (e) { console.warn('[wardrobe] thumbnail failed', best.id, e); busy = false; }
    const ms = performance.now() - now; // main-thread cost of one bake (draw + async readback request)
    stats.bakes++; stats.msMax = Math.max(stats.msMax, ms); stats.msAvg += (ms - stats.msAvg) / stats.bakes;
    schedule(BAKE_GAP);
  }

  function bake(job) {
    const it = WARDROBE_BY_ID.get(job.id);
    if (!it) return;
    if (slot < 0) slot = st.batch.alloc();
    if (slot < 0) return;
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(THUMB_W, THUMB_H, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
      out = new THREE.WebGLRenderTarget(THUMB_W, THUMB_H, { type: THREE.UnsignedByteType, depthBuffer: false });
    }
    const look = outfitToLook(thumbOutfit(it, job.color));
    const dims = makeDims(look);
    st.batch.setLook(slot, lookData(look, dims));
    const fr = thumbFrame(it);
    PZ.poseIdle(P, 0, 3.7, dims);
    P[J.HEAD * 3 + 1] = 0; P[J.NECK * 3 + 1] = 0; // face the camera
    pelvisMatrix(M, 0, 0, 0, fr.yaw, P, dims);
    fk(W, M, P, dims);
    st.batch.writeFigure(slot, W, dims, 0, false);
    st.batch.flush();
    const cam = st.camera;
    cam.aspect = THUMB_W / THUMB_H;
    const half = THREE.MathUtils.degToRad(cam.fov / 2);
    const vh = fr.full ? dims.h * 1.02 : fr.vh * (dims.h / 1.8);
    fr.target(W, dims, _jp);
    const dist = vh / 2 / Math.tan(half);
    cam.position.set(_jp.x, _jp.y + vh * 0.12, _jp.z - dist);
    cam.lookAt(_jp);
    cam.near = Math.max(0.03, dist - 1.5); cam.far = dist + 3;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    st.rim.intensity = 1.4;
    drawFigure(renderer, st, rt, out, cam);
    if (!px) px = new Uint8Array(THUMB_W * THUMB_H * 4);
    const done = (buf) => {
      const img = new ImageData(new Uint8ClampedArray(buf.buffer.slice(0)), THUMB_W, THUMB_H);
      const store = (bmp) => {
        busy = false;
        const old = cache.get(job.k);
        if (old && old !== bmp) old.close?.();
        cache.delete(job.k);
        cache.set(job.k, bmp);
        while (cache.size > CACHE_MAX) { const [k0, b0] = cache.entries().next().value; cache.delete(k0); b0?.close?.(); }
        emit(job.k);
        schedule(BAKE_GAP);
      };
      if (typeof createImageBitmap === 'function') createImageBitmap(img).then(store, () => { busy = false; });
      else { const c = document.createElement('canvas'); c.width = THUMB_W; c.height = THUMB_H; c.getContext('2d').putImageData(img, 0, 0); store(c); }
    };
    busy = true;
    if (typeof renderer.readRenderTargetPixelsAsync === 'function') {
      renderer.readRenderTargetPixelsAsync(out, 0, 0, THUMB_W, THUMB_H, px).then(() => done(px), () => { busy = false; schedule(BAKE_GAP); });
    } else { renderer.readRenderTargetPixels(out, 0, 0, THUMB_W, THUMB_H, px); done(px); }
  }

  svc = {
    key,
    stats,
    size: { w: THUMB_W, h: THUMB_H },
    get(id, color) {
      const k = key(id, color), b = cache.get(k);
      if (b) { cache.delete(k); cache.set(k, b); } // LRU touch
      return b || null;
    },
    request(id, color, prio = 1) {
      if (!WARDROBE_BY_ID.has(id)) return;
      const k = key(id, color);
      if (cache.has(k)) return;
      const j = queue.get(k);
      if (j) { j.t = performance.now(); j.prio = Math.max(j.prio, prio); } else queue.set(k, { k, id, color: color ?? null, prio, t: performance.now() });
      schedule(DEBOUNCE);
    },
    cancel(id, color) { queue.delete(key(id, color)); },
    onReady(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { clearTimeout(timer); queue.clear(); for (const b of cache.values()) b?.close?.(); cache.clear(); rt?.dispose(); out?.dispose(); if (slot >= 0) st.batch.release(slot); services.delete(game); },
  };
  services.set(game, svc);
  return svc;
}
