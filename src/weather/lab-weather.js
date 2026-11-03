import { createGame } from '../core/bootstrap.js';
import { Weather } from './Weather.js';
import { WEATHER_NAMES, WEATHER_LABELS } from './presets.js';
import { patchWorldMaterials } from './wetMaterial.js';

// Weather / sky / rendering test bench. URL params: ?t=18.2&w=heavyRain&q=high&view=beach&fx=0
const params = new URLSearchParams(location.search);
// Other workstreams edit files all the time: keep this lab alive instead of full-reloading (?hmr=1 restores it).
if (import.meta.hot && params.get('hmr') !== '1') import.meta.hot.on('vite:beforeFullReload', () => { throw new Error('[lab] full reload skipped'); });
const panel = document.getElementById('wx');

const VIEWS = {
  chase: null,
  street: { pos: [1712, 9, -560], look: [1745, 6, -700] },
  west: { pos: [1730, 14, -600], look: [1200, 40, -560] },
  east: { pos: [1700, 14, -600], look: [2400, 30, -640] },
  beach: { pos: [2050, 5, -760], look: [2600, 8, -820] },
  downtown: { pos: [-60, 70, 620], look: [-634, 90, 152] },
  bay: { pos: [600, 25, -380], look: [-500, 60, -120] },
  aerial: { pos: [1200, 420, 400], look: [-200, 0, -600] },
};

// Hidden preview panes never fire requestAnimationFrame: drive the game loop (render.loopCallback) from a
// worker clock while the page is hidden (lab only). Ping-pong so slow frames never pile up.
const dts = [];
let lastFrame = performance.now();
const loopCb = (t) => {
  const cb = window.game?.render?.loopCallback;
  if (!cb) return;
  const now = performance.now();
  dts.push(now - lastFrame); lastFrame = now;
  if (dts.length > 120) dts.shift();
  cb(t);
};
const clockWorker = new Worker(URL.createObjectURL(new Blob(['onmessage = () => setTimeout(() => postMessage(0), 16); postMessage(0);'], { type: 'text/javascript' })));
clockWorker.onmessage = () => {
  if (document.visibilityState === 'hidden' && params.get('drive') !== '0') { try { loopCb(performance.now()); } catch (e) { console.error(e); } }
  clockWorker.postMessage(0);
};

const game = await createGame(document.getElementById('app'), {
  autostart: true,
  noTraffic: params.get('traffic') !== '1',
  noPeds: params.get('traffic') !== '1',
  hour: Number(params.get('t') ?? 18.2),
  modules: [(g) => {
    patchWorldMaterials(g);
    g.weather = new Weather(g, { state: params.get('w') || undefined, seed: 7 });
    return g.weather;
  }],
});
window.game = game;
console.info(`[lab] prewarm ${game.render.prewarm().toFixed(0)} ms`);
const { sky, weather, render } = game;
if (params.has('t')) sky.setTime(Number(params.get('t')));
if (params.has('q')) render.setQuality(params.get('q'));
sky.paused = params.get('pause') !== '0';

function setView(name) {
  const v = VIEWS[name];
  const p = game.player;
  if (!v) { if (p.mode === 'free') p.setFree(false); return; }
  if (p.mode !== 'free') p.setFree(true);
  game.camera.position.set(...v.pos);
  game.camera.lookAt(...v.look);
  p.free.enable(game.camera);
  game.streaming?.run(true);
}
if (params.get('view')) setView(params.get('view'));
window.setView = setView;
// settle(n): run n frames (streaming, probe, transitions) — for scripted screenshots
window.settle = async (n = 30) => { for (let i = 0; i < n; i++) { try { loopCb(performance.now()); } catch (e) { console.error(e); } await new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = r; ch.port2.postMessage(0); }); } };
if (params.get('fx') === '0') panel.classList.add('min');
if (params.get('hud') === '0') document.body.classList.add('nohud');

// ------------------------------------------------------------------ panel
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d; };
panel.innerHTML = '';
panel.append(el('<div class="head"><span>WEATHER LAB</span><button id="wxmin">_</button></div>'));
panel.querySelector('#wxmin').onclick = () => panel.classList.toggle('min');

panel.append(el(`<h3>Time <span id="clk"></span></h3>
  <input id="time" type="range" min="0" max="24" step="0.05" value="${sky.time}">
  <div><button data-t="5.6">sunrise</button><button data-t="8">morning</button><button data-t="12.5">noon</button><button data-t="17.9">golden</button><button data-t="18.45">sunset</button><button data-t="19.1">dusk</button><button data-t="23">night</button>
  <button id="pause">${sky.paused ? '▶ play' : '❚❚ pause'}</button><button id="fast">×30</button></div>`));
panel.append(el(`<h3>Weather <span id="wstate"></span></h3><div id="wbtns"></div>
  <div class="row"><span class="muted">transition s</span><input id="wsec" type="number" value="20" style="width:50px"><button id="strike">⚡ strike</button></div>`));
panel.append(el('<h3>Quality <span id="qname"></span></h3><div id="qbtns"></div><div class="muted" id="qwhy"></div>'));
panel.append(el('<h3>Effects</h3><div id="fx"></div>'));
panel.append(el('<h3>View</h3><div id="views"></div>'));
panel.append(el('<h3>Perf</h3><div class="stat" id="stat"></div>'));

// sandbox controls only where the game mode allows them (online: server-driven weather and clock)
const canTime = game.can ? game.can('time') : true, canWeather = game.can ? game.can('weather') : true;
if (!canTime || !canWeather) panel.append(el(`<div class="muted">online mode: ${!canWeather ? 'weather ' : ''}${!canTime ? 'time ' : ''}controls are server-driven — open with ?mode=single</div>`));
if (!canTime) for (const n of panel.querySelectorAll('#time, [data-t], #pause, #fast')) n.disabled = true;
panel.querySelector('#time').oninput = (e) => sky.setTime(Number(e.target.value));
for (const b of panel.querySelectorAll('[data-t]')) b.onclick = () => sky.setTime(Number(b.dataset.t), { smooth: true });
panel.querySelector('#pause').onclick = (e) => { sky.paused = !sky.paused; e.target.textContent = sky.paused ? '▶ play' : '❚❚ pause'; };
panel.querySelector('#fast').onclick = (e) => { sky.timeScale = sky.timeScale > 0.05 ? 1 / 120 : 30 / 120; e.target.classList.toggle('on', sky.timeScale > 0.05); };

const wb = panel.querySelector('#wbtns');
for (const n of ['auto', ...WEATHER_NAMES]) {
  const b = document.createElement('button');
  b.textContent = WEATHER_LABELS[n];
  b.dataset.w = n;
  b.disabled = !canWeather;
  b.onclick = () => {
    if (!game.can?.('weather') && game.can) return;
    if (n === 'auto') weather.setAuto(true);
    else { weather.auto = false; weather.set(n, Number(panel.querySelector('#wsec').value) || 0); }
  };
  wb.append(b);
}
panel.querySelector('#strike').onclick = () => { if (canWeather) weather.strike(); };

const qb = panel.querySelector('#qbtns');
for (const n of ['auto', 'mobile', 'low', 'medium', 'high', 'ultra']) {
  const b = document.createElement('button');
  b.textContent = n;
  b.dataset.q = n;
  b.onclick = () => { render.setQuality(n); render.gpu.reset(); };
  qb.append(b);
}
panel.querySelector('#qwhy').textContent = (render.detected.reasons || []).join(' · ');

const fx = panel.querySelector('#fx');
const toggles = [
  ['bloom', 'bloom'], ['ao', 'AO'], ['ssr', 'SSR'], ['godrays', 'god rays'], ['flare', 'flare'], ['lens', 'lens drops'],
  ['motionBlur', 'motion blur'], ['grain', 'grain'], ['aa', 'AA'], ['fog', 'post fog'],
];
for (const [k, label] of toggles) {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" ${render.effects[k] ? 'checked' : ''}> ${label}`;
  l.querySelector('input').onchange = (e) => { render.setEffect(k, e.target.checked); render.gpu.reset(); };
  fx.append(l);
}
const extra = [
  ['rain', 'rain', (v) => { weather.enabled.rain = v; }],
  ['splashes', 'splashes', (v) => { weather.enabled.splashes = v; }],
  ['lightning', 'lightning', (v) => { weather.enabled.lightning = v; }],
  ['clouds', 'clouds', (v) => { sky.domeMat.defines.CLOUD_Q = v ? (game.quality.clouds || 3) : 0; sky.domeMat.needsUpdate = true; }],
  ['env', 'sky reflections', (v) => { sky.envEnabled = v; game.scene.environment = v ? sky.envTexture : null; game.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; }); }],
  ['shadows', 'shadows', (v) => { render.renderer.shadowMap.enabled = v; game.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; }); }],
  ['autoRes', 'dynamic res', (v) => { render.autoRes = v; if (!v) { render.scale = 1; render.resize(); } }],
];
for (const [, label, fn] of extra) {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" checked> ${label}`;
  l.querySelector('input').onchange = (e) => { fn(e.target.checked); render.gpu.reset(); };
  fx.append(l);
}
const vb = panel.querySelector('#views');
for (const n of Object.keys(VIEWS)) {
  const b = document.createElement('button');
  b.textContent = n;
  b.onclick = () => setView(n);
  vb.append(b);
}

// ------------------------------------------------------------------ readouts
let cpuMs = 0;

setInterval(() => {
  panel.querySelector('#clk').textContent = `${sky.clock}  day ${sky.day}  sun ${sky.sunElevation.toFixed(1)}°  moon ${(sky.moonIllum * 100).toFixed(0)}%`;
  if (document.activeElement?.id !== 'time') panel.querySelector('#time').value = sky.time;
  panel.querySelector('#wstate').textContent = `${weather.label()}${weather.auto ? ' (auto)' : ''}`;
  for (const b of wb.children) b.classList.toggle('on', b.dataset.w === 'auto' ? weather.auto : (!weather.auto && b.dataset.w === weather.name));
  panel.querySelector('#qname').textContent = `${game.quality.name}${game.quality.auto ? ' (auto)' : ''} · detected ${render.detected.name}`;
  for (const b of qb.children) b.classList.toggle('on', b.dataset.q === 'auto' ? game.quality.auto : (!game.quality.auto && b.dataset.q === game.quality.name));
  const s = [...dts].sort((a, b) => a - b);
  cpuMs = s[Math.floor(s.length * 0.8)] || 0;
  const g = render.gpu;
  const lines = [];
  lines.push(`${game.fps} fps · p80 ${cpuMs.toFixed(1)} ms · ${document.visibilityState}`);
  lines.push(`res ${render.width}×${render.height} · scale ${(render.scale * 100).toFixed(0)}% · pr ${render.basePR.toFixed(2)}`);
  if (g.available) {
    lines.push(`GPU frame ${g.frameMs != null ? g.frameMs.toFixed(2) : '–'} ms`);
    for (const [k, v] of Object.entries(g.results)) lines.push(`  ${k.padEnd(10)} ${v.toFixed(2)} ms`);
  } else lines.push('GPU timer: n/a');
  lines.push(`passes: ${render.frameInfo.passes.join(' → ')}`);
  lines.push(`rain ${weather.rain.toFixed(2)} wet ${weather.wetness.toFixed(2)} cloud ${weather.cloud.toFixed(2)} fog ${weather.fog.toFixed(2)}`);
  lines.push(`wind ${weather.wind.strength.toFixed(1)} m/s · cover ${weather.cover.toFixed(2)} · lens ${weather.lens.toFixed(2)}`);
  lines.push(`exposure ${sky.exposure.toFixed(2)} · draw calls ${render.frameInfo.calls} · tris ${(render.frameInfo.triangles / 1e6).toFixed(2)}M · target ${render.targetFps} fps (${render.refreshHz} Hz) · cpu ${render.stats().cpuMs.toFixed(1)} ms`);
  panel.querySelector('#stat').textContent = lines.join('\n');
}, 250);

// Hidden panes do not composite the WebGL canvas: snap() renders one frame and shows it as an <img>
// (screenshots of background tabs then show the real frame). snap(false) removes it.
window.snap = (on = true) => {
  let img = document.getElementById('snapimg');
  if (!on) { img?.remove(); return; }
  if (!img) {
    img = document.createElement('img');
    img.id = 'snapimg';
    img.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:40;pointer-events:none';
    document.body.append(img);
  }
  try { loopCb(performance.now()); } catch (e) { console.error(e); }
  img.src = render.renderer.domElement.toDataURL('image/jpeg', 0.92);
  return img.src.length;
};

// shot(name): render a frame and POST a JPEG to a local receiver (lab tooling for hidden panes).
window.shot = async (name = 'shot', width = 960, url = 'http://127.0.0.1:5399/') => {
  try { loopCb(performance.now()); } catch (e) { console.error(e); }
  const src = render.renderer.domElement;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(width * src.height / src.width);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const data = c.toDataURL('image/jpeg', 0.9);
  const r = await fetch(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
  return r.text();
};

game.events.on('lightning', (e) => console.info('[lab] lightning', Math.round(e.distance), 'm', e.cloud ? '(cloud)' : ''));
