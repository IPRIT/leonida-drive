import * as THREE from 'three';
import { tr, clamp } from './util.js';
import { GP } from '../core/input.js';

// Photo mode (P): pauses the simulation, free orbit camera, FOV / time of day / roll / exposure, colour filters,
// tilt-shift focus blur (the renderer has no DOF pass), vignette, letterbox and a PNG capture with download.
// While paused the game loop only renders, so this module drives its own rAF loop and refreshes the streamed world
// visuals (terrain LODs, vegetation, lamps, water, sky) for the orbit camera with dt = 0.

const FILTERS = [
  { id: 'none', ops: [] },
  { id: 'vivid', ops: [['saturate', 1.45], ['contrast', 1.08]] },
  { id: 'vice', ops: [['saturate', 1.3], ['hue-rotate', -14], ['contrast', 1.06], ['sepia', 0.12]] },
  { id: 'noir', ops: [['grayscale', 1], ['contrast', 1.4], ['brightness', 0.95]] },
  { id: 'vintage', ops: [['sepia', 0.55], ['contrast', 0.92], ['saturate', 1.2], ['brightness', 1.04]] },
  { id: 'cool', ops: [['saturate', 1.1], ['hue-rotate', 14], ['brightness', 1.02]] },
  { id: 'heat', ops: [['saturate', 1.6], ['contrast', 1.15], ['sepia', 0.25], ['hue-rotate', -18]] },
];
const FILTER_NAMES = { none: 'None', vivid: 'Vivid', vice: 'Sunset', noir: 'Noir', vintage: 'Vintage', cool: 'Cool', heat: 'Heatwave' };

const CSS = `
#life-photo { position: fixed; inset: 0; z-index: 60; pointer-events: none; color: #fff; display: none;
  font-family: var(--f-ui, Oswald, 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif); }
#life-photo.on { display: block; }
#life-photo .ph-tilt { position: absolute; inset: 0; pointer-events: none; backdrop-filter: blur(var(--ph-blur, 0px)); -webkit-backdrop-filter: blur(var(--ph-blur, 0px));
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, transparent var(--ph-a, 38%), transparent var(--ph-b, 62%), #000 100%);
  mask-image: linear-gradient(to bottom, #000 0%, transparent var(--ph-a, 38%), transparent var(--ph-b, 62%), #000 100%); }
#life-photo .ph-vig { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,var(--ph-vig, 0)) 100%); }
#life-photo .ph-bar { position: absolute; left: 0; right: 0; height: 0; background: #000; transition: height .3s; pointer-events: none; }
#life-photo .ph-bar.t { top: 0; } #life-photo .ph-bar.b { bottom: 0; }
#life-photo.lb .ph-bar { height: max(0px, min(calc((100vh - 100vw / 2.39) / 2), 14vh)); }
#life-photo .ph-panel { position: absolute; left: 22px; top: 22px; width: 268px; pointer-events: auto; background: rgba(8, 8, 12, 0.66);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); border-radius: 4px; padding: 14px 16px 12px; transition: opacity .25s, transform .25s;
  box-shadow: 0 8px 30px rgba(0,0,0,.35); border-top: 3px solid var(--pink, #ff3fa4); }
#life-photo.hide .ph-panel, #life-photo.hide .ph-hint { opacity: 0; transform: translateX(-12px); pointer-events: none; }
#life-photo h2 { margin: 0; font-family: var(--f-disp, 'Russo One', 'Arial Black', sans-serif); font-weight: var(--fw-disp, 400); font-size: 22px; letter-spacing: .12em; }
#life-photo h2 small { display: block; font-family: var(--f-script, Yellowtail, cursive); font-size: 22px; letter-spacing: 0; color: var(--pink, #ff3fa4); margin-top: -2px; }
#life-photo .ph-row { margin: 9px 0 0; }
#life-photo .ph-row label { display: flex; justify-content: space-between; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #cfd3da; }
#life-photo .ph-row label span { font-family: var(--f-num, 'Russo One', sans-serif); color: #fff; letter-spacing: 0; text-transform: none; }
#life-photo input[type=range] { width: 100%; margin: 4px 0 0; accent-color: var(--pink, #ff3fa4); height: 16px; }
#life-photo .ph-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
#life-photo button { font: inherit; font-size: 13px; letter-spacing: .05em; color: #fff; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14);
  border-radius: 3px; padding: 3px 8px; cursor: pointer; }
#life-photo button:hover { background: rgba(255, 63, 164, .35); }
#life-photo button.on { background: #f2f2f2; color: #111; border-color: #f2f2f2; }
#life-photo .ph-toggles { display: flex; gap: 6px; margin-top: 10px; }
#life-photo .ph-actions { display: flex; gap: 6px; margin-top: 12px; }
#life-photo .ph-actions button { flex: 1; padding: 6px 4px; font-size: 14px; }
#life-photo .ph-actions .ph-shot { background: var(--pink, #ff3fa4); border-color: var(--pink, #ff3fa4); font-family: var(--f-disp, 'Russo One', sans-serif); letter-spacing: .08em; }
#life-photo .ph-hint { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); background: rgba(8,8,12,.6); padding: 6px 14px; border-radius: 3px;
  font-size: 13px; letter-spacing: .04em; color: #dde; white-space: nowrap; transition: opacity .25s; }
#life-photo .ph-hint kbd { background: #f2f2f2; color: #111; border-radius: 3px; padding: 0 5px; margin: 0 2px; font-family: var(--f-num, 'Russo One', sans-serif); font-size: 12px; }
#life-photo .ph-flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
#life-photo .ph-toast { position: absolute; right: 24px; bottom: 24px; background: rgba(8,8,12,.75); padding: 8px 14px; border-left: 3px solid var(--teal, #29f0e0);
  font-size: 15px; opacity: 0; transition: opacity .3s; }
#life-photo .ph-toast.on { opacity: 1; }
`;

const _v = new THREE.Vector3();

export class PhotoMode {
  constructor(game, life) {
    this.game = game;
    this.life = life;
    this.active = false;
    this.p = { fov: 55, time: 12, roll: 0, exposure: 1, blur: 0, vignette: 0.25, letterbox: false, stamp: true, filter: 'none', focus: 0.5 };
    this.target = new THREE.Vector3();
    this.origin = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0.2; this.dist = 8;
    this._loop = (t) => this.frame(t);
    this._ctx = (e) => { if (this.active) e.preventDefault(); };
    this._last = 0;
    this.saved = null;
    game.events.on('ui:open', () => { if (this.active) this.exit(true); });
  }

  t(k, f, p) { return tr(this.game, `life.photo.${k}`, f, p); }

  // registered module (runs only while the game is not paused)
  update(dt, game) {
    if (this.active) return;
    const inp = game.input;
    if (!inp.pressed('KeyP')) return;
    if (game.ui?.isOpen || game.paused) return;
    if (typeof game.can === 'function' && !game.can('photo')) return;
    this.enter();
  }

  enter() {
    const g = this.game, cam = g.camera;
    if (this.active) return;
    this.active = true;
    this.saved = {
      pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov, up: cam.up.clone(),
      hud: g.ui?.hud?.visible ?? true, time: g.sky?.time, filter: g.renderer.domElement.style.filter, paused: g.paused,
    };
    g.paused = true;
    g.input.unlockPointer?.();
    g.ui?.hud?.setVisible?.(false);
    this.life.hud?.setVisible(false);
    // orbit around the player (or in front of the free camera)
    const f = g.player?.focus;
    if (g.player?.mode === 'free' || !f) this.target.copy(cam.position).add(cam.getWorldDirection(_v).multiplyScalar(12));
    else this.target.set(f.x, f.y + 1.1, f.z);
    this.origin.copy(this.target);
    _v.copy(cam.position).sub(this.target);
    this.dist = clamp(_v.length(), 2.5, 60);
    this.yaw = Math.atan2(_v.x, _v.z);
    this.pitch = Math.asin(clamp(_v.y / (this.dist || 1), -0.95, 0.95));
    this.p.fov = Math.round(cam.fov);
    this.p.time = g.sky?.time ?? 12;
    this.p.roll = 0;
    this.p.exposure = 1;
    this.buildUI();
    this.syncUI();
    this.applyLook();
    this.root.classList.add('on');
    this.root.classList.remove('hide');
    g.renderer.domElement.addEventListener('contextmenu', this._ctx);
    this.enterFrame = g.frame;
    this.lastFrame = g.frame;
    this._last = performance.now();
    requestAnimationFrame(this._loop);
    g.events.emit('photo:enter', {});
  }

  exit(byMenu = false) {
    const g = this.game, cam = g.camera, s = this.saved;
    if (!this.active) return;
    this.active = false;
    this.root.classList.remove('on');
    g.renderer.domElement.removeEventListener('contextmenu', this._ctx);
    g.renderer.domElement.style.filter = s.filter || '';
    cam.position.copy(s.pos); cam.quaternion.copy(s.quat); cam.up.copy(s.up);
    cam.fov = s.fov; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    if (g.sky && s.time !== undefined) g.sky.setTime(s.time);
    if (g.ui?.hud && s.hud) g.ui.hud.setVisible(true);
    this.life.hud?.setVisible(true);
    if (!byMenu && !g.ui?.isOpen) g.paused = false;
    this.refreshWorld();
    g.events.emit('photo:exit', {});
  }

  // own loop while paused (the game loop keeps calling input.update() and render())
  frame(now) {
    if (!this.active) return;
    requestAnimationFrame(this._loop);
    const g = this.game;
    const dt = Math.min(0.1, (now - this._last) / 1000 || 0);
    this._last = now;
    const fresh = g.frame !== this.lastFrame && g.frame > this.enterFrame;
    this.lastFrame = g.frame;
    const inp = g.input;
    if (fresh) {
      if (inp.pressed('KeyP') || inp.gpPressedBtn?.(GP.B) || (!g.ui?.menu && inp.pressed('Escape'))) { this.exit(); return; }
      if (inp.pressed('Enter') || inp.pressed('NumpadEnter') || inp.gpPressedBtn?.(GP.A)) this.capture();
      if (inp.pressed('KeyH')) this.root.classList.toggle('hide');
      this.orbit(dt, inp);
    }
    if (g.ui?.hud?.visible) g.ui.hud.setVisible(false);
    this.applyCamera();
    this.refreshWorld();
  }

  orbit(dt, inp) {
    const m = inp.mouse;
    const fast = inp.held('ShiftLeft') || inp.held('ShiftRight') ? 4 : 1;
    if (inp.held('Mouse0')) { this.yaw -= m.dx * 0.0045; this.pitch = clamp(this.pitch + m.dy * 0.0045, -1.35, 1.45); }
    const right = _v.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let mx = 0, mz = 0, my = 0;
    if (inp.held('Mouse2')) { mx -= m.dx * 0.02 * Math.max(1, this.dist / 10); mz += m.dy * 0.02 * Math.max(1, this.dist / 10); }
    const sp = 9 * fast * dt;
    if (inp.held('KeyW') || inp.held('ArrowUp')) mz += sp;
    if (inp.held('KeyS') || inp.held('ArrowDown')) mz -= sp;
    if (inp.held('KeyD') || inp.held('ArrowRight')) mx += sp;
    if (inp.held('KeyA') || inp.held('ArrowLeft')) mx -= sp;
    if (inp.held('KeyE')) my += sp;
    if (inp.held('KeyQ')) my -= sp;
    // gamepad: left stick move, right stick orbit, triggers zoom
    if (inp.gamepad) {
      mx += inp.axis(0) * sp * 1.5; mz -= inp.axis(1) * sp * 1.5;
      this.yaw -= inp.axis(2) * dt * 2.2; this.pitch = clamp(this.pitch + inp.axis(3) * dt * 1.8, -1.35, 1.45);
      this.dist *= 1 + (inp.gpValue(GP.LT) - inp.gpValue(GP.RT)) * dt * 1.5;
    }
    this.target.x += right.x * mx + fx * mz;
    this.target.z += right.z * mx + fz * mz;
    this.target.y += my;
    if (m.wheel) this.dist *= m.wheel > 0 ? 1.12 : 1 / 1.12;
    this.dist = clamp(this.dist, 1.2, 120);
    // stay near the paused scene (streamed world + colliders are around it)
    _v.copy(this.target).sub(this.origin);
    const L = Math.hypot(_v.x, _v.z);
    if (L > 260) { this.target.x = this.origin.x + (_v.x / L) * 260; this.target.z = this.origin.z + (_v.z / L) * 260; }
    const g = this.game;
    const gy = Math.max(g.terrain.heightAt(this.target.x, this.target.z), 0);
    this.target.y = clamp(this.target.y, gy + 0.2, gy + 220);
  }

  applyCamera() {
    const g = this.game, cam = g.camera;
    const cp = Math.cos(this.pitch);
    cam.up.set(0, 1, 0);
    cam.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
    const gy = Math.max(g.terrain.heightAt(cam.position.x, cam.position.z), 0) + 0.35;
    if (cam.position.y < gy) cam.position.y = gy;
    cam.lookAt(this.target);
    if (this.p.roll) cam.rotateZ((this.p.roll * Math.PI) / 180);
    if (cam.fov !== this.p.fov) { cam.fov = this.p.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  // the paused loop only renders: refresh camera-dependent world systems here (dt = 0, nothing simulates)
  refreshWorld() {
    const g = this.game, cam = g.camera;
    try {
      g.sky?.update(0, this.active ? this.target : g.player?.focus || cam.position);
      if (g.scene.fog) {
        const alt = Math.max(0, cam.position.y - Math.max(0, g.terrain.heightAt(cam.position.x, cam.position.z)));
        g.scene.fog.density /= 1 + alt / 250;
      }
      if (this.active) g.renderer.toneMappingExposure *= this.p.exposure;
      const night = g.sky?.night ?? g.uniforms.uNight.value;
      g.terrain?.update(cam, 0);
      g.water?.update(0, cam, night);
      g.roads?.update(night);
      g.buildings?.update(0, night);
      g.veg?.update(cam, 0);
      g.lamps?.update(cam, 0, night);
      this.life.visual(cam, 0, false);
    } catch (e) { console.warn('[life/photo] refresh', e); }
  }

  applyLook() {
    const g = this.game;
    g.renderer.domElement.style.filter = cssFilter(this.p.filter);
    const r = this.root.style;
    r.setProperty('--ph-blur', `${(this.p.blur * 7).toFixed(1)}px`);
    const c = 50 + (this.p.focus - 0.5) * 60;
    r.setProperty('--ph-a', `${c - 13}%`); r.setProperty('--ph-b', `${c + 13}%`);
    r.setProperty('--ph-vig', this.p.vignette.toFixed(2));
    this.root.classList.toggle('lb', this.p.letterbox);
  }

  // ---------------------------------------------------------------- UI
  buildUI() {
    if (this.root) { this.relabel(); return; }
    if (!document.getElementById('life-photo-css')) {
      const st = document.createElement('style'); st.id = 'life-photo-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.id = 'life-photo';
    el.innerHTML = `
      <div class="ph-tilt"></div><div class="ph-vig"></div><div class="ph-bar t"></div><div class="ph-bar b"></div>
      <div class="ph-panel">
        <h2 data-l="title"></h2>
        <div class="ph-row"><label><b data-l="filter"></b></label><div class="ph-chips"></div></div>
        <div class="ph-row"><label><b data-l="fov"></b><span data-o="fov"></span></label><input type="range" data-k="fov" min="12" max="110" step="1"></div>
        <div class="ph-row"><label><b data-l="time"></b><span data-o="time"></span></label><input type="range" data-k="time" min="0" max="23.99" step="0.05"></div>
        <div class="ph-row"><label><b data-l="roll"></b><span data-o="roll"></span></label><input type="range" data-k="roll" min="-35" max="35" step="0.5"></div>
        <div class="ph-row"><label><b data-l="exposure"></b><span data-o="exposure"></span></label><input type="range" data-k="exposure" min="0.4" max="2.2" step="0.02"></div>
        <div class="ph-row"><label><b data-l="blur"></b><span data-o="blur"></span></label><input type="range" data-k="blur" min="0" max="1" step="0.01"></div>
        <div class="ph-row"><label><b data-l="focus"></b><span data-o="focus"></span></label><input type="range" data-k="focus" min="0" max="1" step="0.01"></div>
        <div class="ph-row"><label><b data-l="vignette"></b><span data-o="vignette"></span></label><input type="range" data-k="vignette" min="0" max="1" step="0.01"></div>
        <div class="ph-toggles"><button data-t="letterbox"></button><button data-t="stamp"></button></div>
        <div class="ph-actions"><button class="ph-shot" data-a="shot"></button><button data-a="reset"></button><button data-a="exit"></button></div>
      </div>
      <div class="ph-hint"></div>
      <div class="ph-flash"></div>
      <div class="ph-toast"></div>`;
    document.body.appendChild(el);
    this.root = el;
    const chips = el.querySelector('.ph-chips');
    for (const f of FILTERS) {
      const b = document.createElement('button');
      b.dataset.f = f.id;
      chips.appendChild(b);
    }
    el.addEventListener('input', (e) => {
      const k = e.target.dataset?.k;
      if (!k) return;
      this.p[k] = parseFloat(e.target.value);
      if (k === 'time' && this.game.sky) this.game.sky.setTime(this.p.time);
      this.applyLook();
      this.syncUI(false);
    });
    el.addEventListener('change', (e) => e.target.blur?.());
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.f) { this.p.filter = b.dataset.f; this.applyLook(); this.syncUI(); }
      else if (b.dataset.t) { this.p[b.dataset.t] = !this.p[b.dataset.t]; this.applyLook(); this.syncUI(); }
      else if (b.dataset.a === 'shot') this.capture();
      else if (b.dataset.a === 'exit') this.exit();
      else if (b.dataset.a === 'reset') this.reset();
      b.blur();
    });
    this.relabel();
  }

  relabel() {
    const q = (s) => this.root.querySelectorAll(s);
    const L = {
      title: this.t('title', 'PHOTO MODE'), filter: this.t('filter', 'Filter'), fov: this.t('fov', 'Field of view'), time: this.t('time', 'Time of day'),
      roll: this.t('roll', 'Tilt'), exposure: this.t('exposure', 'Exposure'), blur: this.t('blur', 'Focus blur'), focus: this.t('focus', 'Focus height'),
      vignette: this.t('vignette', 'Vignette'),
    };
    for (const n of q('[data-l]')) n.textContent = L[n.dataset.l] ?? '';
    this.root.querySelector('h2').innerHTML = `${L.title}<small>Leonida</small>`;
    for (const n of q('[data-f]')) n.textContent = this.t(`f.${n.dataset.f}`, FILTER_NAMES[n.dataset.f]);
    this.root.querySelector('[data-t=letterbox]').textContent = this.t('letterbox', 'Cinema bars');
    this.root.querySelector('[data-t=stamp]').textContent = this.t('stamp', 'Stamp');
    this.root.querySelector('[data-a=shot]').textContent = this.t('capture', 'CAPTURE');
    this.root.querySelector('[data-a=reset]').textContent = this.t('reset', 'Reset');
    this.root.querySelector('[data-a=exit]').textContent = this.t('exit', 'Exit');
    this.root.querySelector('.ph-hint').innerHTML = this.t('hint', '<kbd>LMB</kbd> orbit · <kbd>RMB</kbd>/<kbd>WASD</kbd> move · <kbd>Q</kbd><kbd>E</kbd> down/up · wheel zoom · <kbd>Enter</kbd> capture · <kbd>H</kbd> hide panel · <kbd>P</kbd> exit');
  }

  syncUI(sliders = true) {
    const p = this.p, r = this.root;
    if (sliders) for (const n of r.querySelectorAll('input[data-k]')) n.value = String(p[n.dataset.k]);
    const h = Math.floor(p.time), mi = Math.floor((p.time - h) * 60);
    const out = { fov: `${Math.round(p.fov)}°`, time: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, roll: `${p.roll.toFixed(1)}°`, exposure: p.exposure.toFixed(2), blur: `${Math.round(p.blur * 100)}%`, focus: `${Math.round(p.focus * 100)}%`, vignette: `${Math.round(p.vignette * 100)}%` };
    for (const n of r.querySelectorAll('[data-o]')) n.textContent = out[n.dataset.o];
    for (const n of r.querySelectorAll('[data-f]')) n.classList.toggle('on', n.dataset.f === p.filter);
    for (const n of r.querySelectorAll('[data-t]')) n.classList.toggle('on', !!p[n.dataset.t]);
  }

  reset() {
    const s = this.saved;
    Object.assign(this.p, { fov: Math.round(s.fov), time: s.time ?? this.p.time, roll: 0, exposure: 1, blur: 0, vignette: 0.25, letterbox: false, filter: 'none', focus: 0.5 });
    if (this.game.sky && s.time !== undefined) this.game.sky.setTime(s.time);
    this.target.copy(this.origin);
    this.applyLook();
    this.syncUI();
  }

  // ---------------------------------------------------------------- capture
  async capture({ download = true } = {}) {
    const g = this.game;
    if (!this.active) return null;
    const blob = await this.renderPhoto();
    if (!blob) return null;
    const flash = this.root.querySelector('.ph-flash');
    flash.style.transition = 'none'; flash.style.opacity = '0.9';
    void flash.offsetWidth;
    flash.style.transition = 'opacity .6s ease-out'; flash.style.opacity = '0';
    const name = `leonida-${stamp()}.png`;
    if (download) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    const toast = this.root.querySelector('.ph-toast');
    toast.textContent = this.t('saved', 'Saved {name}', { name });
    toast.classList.add('on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => toast.classList.remove('on'), 2600);
    g.events.emit('photo:capture', { name, width: this.lastSize?.w, height: this.lastSize?.h, size: blob.size });
    return blob;
  }

  // renders a clean frame and composes filters / blur / vignette / bars / stamp in 2D
  renderPhoto() {
    const g = this.game;
    // a few clean frames: sky LUT / probe catch up after a time change, motion blur settles for a still camera
    for (let i = 0; i < 3; i++) { this.applyCamera(); this.refreshWorld(); g.render.render(); }
    const src = g.renderer.domElement;
    const W = src.width, H = src.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    const css = cssFilter(this.p.filter);
    const nativeFilter = 'filter' in ctx;
    if (nativeFilter && css) ctx.filter = css;
    ctx.drawImage(src, 0, 0); // same task as the render: the drawing buffer is still valid
    ctx.filter = 'none';
    if (!nativeFilter && css) applyMatrix(ctx, W, H, FILTERS.find((f) => f.id === this.p.filter).ops);
    if (this.p.blur > 0.01) tiltShift(out, this.p.blur, this.p.focus);
    if (this.p.vignette > 0.01) {
      const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${this.p.vignette})`);
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }
    const barH = this.p.letterbox ? Math.max(0, Math.min((H - W / 2.39) / 2, H * 0.14)) : 0;
    if (barH > 0) {
      const bh = barH;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh);
    }
    if (this.p.stamp) {
      const s = Math.max(1, H / 900);
      const area = g.world3d?.areaAt?.(this.target.x, this.target.z)?.name || 'Leonida';
      const bh = barH;
      ctx.textAlign = 'right';
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 8 * s;
      ctx.font = `${Math.round(40 * s)}px Yellowtail, 'Brush Script MT', cursive`;
      ctx.fillStyle = '#ff7ab8';
      ctx.fillText('Leonida', W - 28 * s, H - bh - 46 * s);
      ctx.font = `${Math.round(16 * s)}px Oswald, 'Arial Narrow', sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${area.toUpperCase()} · ${g.sky?.clock ?? ''}`, W - 30 * s, H - bh - 24 * s);
      ctx.shadowBlur = 0;
    }
    this.lastSize = { w: W, h: H };
    return new Promise((res) => out.toBlob((b) => res(b), 'image/png'));
  }
}

// --------------------------------------------------------------------------------------------- helpers
function cssFilter(id) {
  const f = FILTERS.find((x) => x.id === id);
  if (!f || !f.ops.length) return '';
  return f.ops.map(([k, v]) => (k === 'hue-rotate' ? `${k}(${v}deg)` : `${k}(${v})`)).join(' ');
}

// tilt-shift: blurred copy (cheap down/up-sampling chain) masked to the top and bottom bands
function tiltShift(canvas, strength, focus) {
  const W = canvas.width, H = canvas.height;
  const steps = 2 + Math.round(strength * 3);
  let cur = canvas, w = W, h = H;
  const tmp = [];
  for (let i = 0; i < steps; i++) {
    w = Math.max(8, Math.round(w / 2)); h = Math.max(8, Math.round(h / 2));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(cur, 0, 0, w, h);
    tmp.push(c); cur = c;
  }
  const blur = document.createElement('canvas'); blur.width = W; blur.height = H;
  const bx = blur.getContext('2d');
  bx.imageSmoothingQuality = 'high';
  bx.drawImage(cur, 0, 0, W, H);
  bx.globalCompositeOperation = 'destination-in';
  const c = 0.5 + (focus - 0.5) * 0.6;
  const gr = bx.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(clamp(c - 0.16, 0.01, 0.98), 'rgba(0,0,0,0)');
  gr.addColorStop(clamp(c + 0.16, 0.02, 0.99), 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(0,0,0,1)');
  bx.fillStyle = gr; bx.fillRect(0, 0, W, H);
  canvas.getContext('2d').drawImage(blur, 0, 0);
}

// CSS filter functions as a 3x4 colour matrix (fallback when ctx.filter is unsupported)
function applyMatrix(ctx, W, H, ops) {
  let M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const mul = (A, B) => { // A·B for 3x4 affine
    const o = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) o.push(A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + (c === 3 ? A[r * 4 + 3] : 0));
    }
    return o;
  };
  for (const [k, v] of ops) {
    let F;
    if (k === 'saturate' || k === 'grayscale') {
      const s = k === 'saturate' ? v : 1 - v;
      F = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0];
    } else if (k === 'sepia') {
      const a = 1 - v;
      F = [0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0, 0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0, 0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0];
    } else if (k === 'hue-rotate') {
      const r = (v * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      F = [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0];
    } else if (k === 'contrast') {
      const o = 0.5 - 0.5 * v;
      F = [v, 0, 0, o, 0, v, 0, o, 0, 0, v, o];
    } else if (k === 'brightness') F = [v, 0, 0, 0, 0, v, 0, 0, 0, 0, v, 0];
    if (F) M = mul(F, M);
  }
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
    d[i] = 255 * (M[0] * r + M[1] * gg + M[2] * b + M[3]);
    d[i + 1] = 255 * (M[4] * r + M[5] * gg + M[6] * b + M[7]);
    d[i + 2] = 255 * (M[8] * r + M[9] * gg + M[10] * b + M[11]);
  }
  ctx.putImageData(img, 0, 0);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
