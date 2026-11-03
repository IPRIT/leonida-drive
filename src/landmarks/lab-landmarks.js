import * as THREE from 'three';
import { createGame } from '../core/bootstrap.js';
import { createLandmarks } from './index.js';

// Landmarks lab: world + landmarks (no UI). URL params:
//   ?only=id,kind  build only these sites   ?site=<id> start at a site   ?hour=21
//   ?traffic=0 ?peds=0                         lighter world
//   ?life=1        also create src/life (off by default for a lighter lab)
//   ?shots=<port>  window.lab.snap() POSTs JPEGs to http://127.0.0.1:<port>/<name>
// window.lab: view(id, i), tour(), snap(name), step(n), perf(seconds)
const qs = new URLSearchParams(location.search);
const panel = document.getElementById('lmklab');
const stats = panel.querySelector('.stats');
panel.querySelector('h3').onclick = () => panel.classList.toggle('min');
const off = (k) => qs.get(k) === '0';

const only = qs.get('only') ? qs.get('only').split(',') : null;
// bootstrap creates the landmarks (before economy / life); the lab only narrows the site list
globalThis.LANDMARKS_OPTIONS = { only };
const game = await createGame(document.getElementById('app'), {
  autostart: true, noUI: true, noTraffic: off('traffic'), noPeds: off('peds'), noLife: qs.get('life') !== '1', noAudio: true,
  spawn: { x: -2000, z: 760 },
  modules: [(g) => createLandmarks(g, { only })], // no-op when bootstrap already built them
});
const lm = game.landmarks;
window.__lmk = lm;
if (qs.has('hour')) game.sky.setTime(+qs.get('hour'));

// ---------- camera views ----------
const cam = game.camera;
function freeCam() {
  const p = game.player;
  if (p.mode !== 'free') p.setFree?.(true);
}
function look(pos, at, fov = 55) {
  freeCam();
  cam.fov = fov; cam.updateProjectionMatrix();
  cam.position.set(pos[0], pos[1], pos[2]);
  cam.lookAt(at[0], at[1], at[2]);
  cam.updateMatrixWorld();
  game.player.free?.enable(cam);
  game.player.focus?.copy(cam.position);
  game.streaming?.run(true);
  lm.colliders.update(0, true);
  lm.refresh(0, true);
}
function siteById(id) { return lm.sites.find((s) => s.id === id) || lm.sites[+id]; }
function view(id, i = 0) {
  const s = siteById(id);
  if (!s) return `no site ${id}`;
  const v = s.views[i % Math.max(1, s.views.length)] || { pos: [s.x + 120, 80, s.z + 120], look: [s.x, 10, s.z] };
  look(v.pos, v.look, v.fov || 55);
  return `${s.id} view ${i} ${v.label || ''}`;
}

// ---------- panel ----------
const groups = new Map();
for (const s of lm.sites) {
  const k = s.kind || 'other';
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(s);
}
for (const [k, list] of groups) {
  const h = document.createElement('h4'); h.textContent = k; panel.appendChild(h);
  for (const s of list) {
    const b = document.createElement('button');
    b.textContent = s.name || s.id;
    let i = 0;
    b.onclick = (e) => { view(s.id, i++); e.target.blur(); };
    panel.appendChild(b);
  }
}
const h = document.createElement('h4'); h.textContent = 'time'; panel.appendChild(h);
for (const [label, t] of [['07:00', 7], ['12:00', 12], ['18:30', 18.5], ['20:00', 20], ['23:30', 23.5]]) {
  const b = document.createElement('button'); b.textContent = label; b.onclick = (e) => { game.sky.setTime(t); e.target.blur(); }; panel.appendChild(b);
}
const hint = document.createElement('div');
hint.className = 'hint';
hint.textContent = 'Click a site (again for the next view). Free camera: WASD/QE, drag to look, wheel = speed, V toggles.';
panel.appendChild(hint);
if (qs.get('site')) setTimeout(() => view(qs.get('site')), 300);

// ---------- stats ----------
const info = game.renderer.info;
info.autoReset = false;
let fpsT = 0, frames = 0, fps = 0, calls = 0, tris = 0;
game.events.on('start', () => {});
const prevRender = game.render.render.bind(game.render);
game.render.render = (...a) => {
  info.reset();
  const r = prevRender(...a);
  calls = info.render.calls; tris = info.render.triangles;
  return r;
};
setInterval(() => {
  const st = lm.stats;
  const f = game.player.focus;
  const near = [...lm.clusters.values()].filter((c) => c.isNear).map((c) => c.key).join(' ');
  stats.textContent = [
    `fps ${game.fps}  draws ${calls}  tris ${(tris / 1000).toFixed(0)}k`,
    `landmarks: ${st.sites} sites, build ${st.timing.total} ms`,
    `  visible draws ${lm.visibleDraws()} / ${st.meshes}`,
    `  tris near ${(st.tris.near / 1000).toFixed(1)}k far ${(st.tris.far / 1000).toFixed(1)}k sign ${(st.tris.sign / 1000).toFixed(1)}k inst ${(st.tris.instanced / 1000).toFixed(1)}k`,
    `  lights ${st.lights} beams ${st.beams / 12 | 0} colliders ${lm.colliders.live.size}/${st.colliders}`,
    `  removed bld ${st.removedBuildings} trees ${st.hiddenTrees}`,
    `  near: ${near}`,
    `pos ${f.x.toFixed(0)}, ${f.y.toFixed(0)}, ${f.z.toFixed(0)}  ${game.sky.clock || game.sky.time?.toFixed?.(2)}`,
  ].join('\n');
}, 300);

// ---------- automation ----------
window.lab = {
  view, look,
  sites: () => lm.sites.map((s) => `${s.id} (${s.views.length})`),
  stats: () => lm.stats,
  // load-time frames: the longest gaps between rAF ticks since page start (ms; t = when the gap ended)
  loadFrames(top = 8) {
    const f = window.__lmkFrames || [], gaps = [];
    for (let i = 1; i < f.length; i++) gaps.push({ t: Math.round(f[i]), ms: +(f[i] - f[i - 1]).toFixed(1) });
    return { frames: f.length, longTasks: (window.__lmkLong || []).slice().sort((a, b) => b[1] - a[1]).slice(0, top), longest: gaps.sort((a, b) => b.ms - a.ms).slice(0, top), timing: { total: lm.timing.total, wall: lm.timing.wall, maxStep: lm.timing.maxStep, bakeWall: lm.timing['vehicle-bake-wall'], mesh: lm.timing['vehicle-mesh'] } };
  },
  // render now and upload a JPEG (works while the page is hidden)
  async snap(name, w = 1280) {
    cam.updateMatrixWorld();
    lm.refresh(0, true);
    game.render.render(); game.render.render();
    const src = game.renderer.domElement, hh = Math.round((w * src.height) / src.width);
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    c.getContext('2d').drawImage(src, 0, 0, w, hh);
    const url = c.toDataURL('image/jpeg', 0.85);
    const port = qs.get('shots');
    if (port) await fetch(`http://127.0.0.1:${port}/${name}.jpg`, { method: 'POST', body: url });
    return `${name} ${url.length}`;
  },
  // advance the simulation n frames manually (hidden tabs get no rAF)
  step(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      game.input.update();
      game.frame++;
      game.time += dt; game.uniforms.uTime.value = game.time;
      game.fixedUpdate(dt); game.world.step(game.eventQueue); game.postStep(dt);
      game.update(dt, 1); game.lateUpdate(dt); cam.updateMatrixWorld();
      game.sky.update(dt, game.player.focus);
      game.uniforms.uNight.value = game.sky.night;
      game.terrain.update(cam, dt); game.water.update(dt, cam, game.sky.night); game.roads.update(game.sky.night);
      game.buildings.update(dt, game.sky.night); game.veg.update(cam, dt); game.lamps.update(cam, dt, game.sky.night);
    }
    return game.time;
  },
  async time(h) { game.sky.setTime(h); this.step(3); return h; },
  // take every view of every site (or a prefix) into the sink
  async tour(prefix = '', hour = null) {
    if (hour !== null) await this.time(hour);
    const out = [];
    for (const s of lm.sites) {
      if (prefix && !s.id.startsWith(prefix) && s.kind !== prefix) continue;
      for (let i = 0; i < Math.max(1, s.views.length); i++) {
        view(s.id, i);
        this.step(2);
        out.push(await this.snap(`${s.id}-${i}${hour !== null ? '-h' + hour : ''}`));
      }
    }
    return out;
  },
  // combine snapshots already in the sink into one labelled grid image (review many views at once)
  async montage(names, out = 'montage', cols = 3, w = 520) {
    const port = qs.get('shots');
    const imgs = await Promise.all(names.map((n) => new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = `http://127.0.0.1:${port}/${n}.jpg`; })));
    const ok = imgs.filter(Boolean);
    if (!ok.length) return 'no images';
    const h = Math.round(w * ok[0].height / ok[0].width);
    const rows = Math.ceil(names.length / cols);
    const c = document.createElement('canvas'); c.width = cols * w; c.height = rows * h;
    const g = c.getContext('2d');
    g.font = '14px monospace';
    imgs.forEach((im, i) => {
      if (!im) return;
      const x = (i % cols) * w, y = Math.floor(i / cols) * h;
      g.drawImage(im, x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, g.measureText(names[i]).width + 8, 20);
      g.fillStyle = '#fff'; g.fillText(names[i], x + 4, y + 15);
    });
    await fetch(`http://127.0.0.1:${port}/${out}.jpg`, { method: 'POST', body: c.toDataURL('image/jpeg', 0.85) });
    return `${out} ${cols}x${rows}`;
  },
  // render cost with / without landmarks at the current camera: n manual frames, GPU-synced by a 1-px readback.
  // Works while the tab is hidden. Returns ms per frame (CPU submit + GPU), draw calls and triangles.
  bench(n = 20) {
    const gl = game.renderer.getContext();
    const px = new Uint8Array(4);
    const run = () => {
      game.render.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { lm.refresh(1 / 60); game.render.render(); }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { ms: +((performance.now() - t0) / n).toFixed(2), calls, tris };
    };
    const on = run();
    lm.root.visible = false;
    const off = run();
    lm.root.visible = true;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) { lm.refresh(1 / 60); lm.update(1 / 60); }
    return { on, off, landmarkDraws: on.calls - off.calls, landmarkTris: on.tris - off.tris, cpuMsPerFrame: +((performance.now() - t0) / 200).toFixed(3), visibleMeshes: lm.visibleDraws() };
  },
  // frame-time sampling with the real loop (page visible): returns avg/p99 ms and draw calls
  perf(sec = 4) {
    return new Promise((res) => {
      const t = []; let last = performance.now();
      const tick = () => {
        const now = performance.now(); t.push(now - last); last = now;
        if (t.length < sec * 60) requestAnimationFrame(tick);
        else { t.sort((a, b) => a - b); res({ avg: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(2), p99: +t[Math.floor(t.length * 0.99)].toFixed(2), calls, tris }); }
      };
      requestAnimationFrame(tick);
    });
  },
  THREE,
};
