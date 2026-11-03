// Audio lab: soundboard (fake game context) and ?world mode (boots the real game with the audio module).
import * as THREE from 'three';
import { AudioSystem, AUDIO_DEFAULTS, SOUNDS, RADIO_STATIONS, SIREN_MODES, HORNS } from './AudioSystem.js';
import { PROFILES, PROFILE_NAMES } from './engine/profiles.js';
import { ENVIRONMENTS } from './core/Mixer.js';
import { Events } from '../core/events.js';
import { engineReport, spatialReport, perfReport, radioReport, benchEngines } from './tests.js';

const qs = new URLSearchParams(location.search);
const root = document.getElementById('root');
// test hook: keep frames running in a background (hidden) tab — rAF is paused there
if (qs.has('bgloop')) {
  const ch = new MessageChannel(), q = [];
  let last = performance.now(), spinning = false;
  ch.port1.onmessage = () => {
    const now = performance.now();
    if (now - last >= 16) { last = now; for (const cb of q.splice(0)) cb(now); }
    if (q.length) ch.port2.postMessage(0); else spinning = false;
  };
  window.requestAnimationFrame = (cb) => { q.push(cb); if (!spinning) { spinning = true; ch.port2.postMessage(0); } return q.length; };
  window.cancelAnimationFrame = () => {};
}
if (qs.has('world')) world(); else soundboard();

// ------------------------------------------------------------------ world mode
async function world() {
  document.body.classList.add('world');
  root.innerHTML = '<div id="app"></div><div id="wstats">audio: click to start</div>';
  const { createGame } = await import('../core/bootstrap.js');
  // the integrated bootstrap creates game.audio itself; older bootstraps get it as a module
  const sp = qs.get('spawn')?.split(',').map(Number);
  const game = await createGame(document.getElementById('app'), {
    autostart: true,
    ...(sp && sp.length === 2 ? { spawn: { x: sp[0], z: sp[1] } } : {}),
    ...(qs.get('hour') ? { hour: +qs.get('hour') } : {}),
    ...(qs.has('noaudio') ? { noAudio: true } : {}),
    modules: qs.has('noaudio') ? [] : [(g) => (g.audio ? null : (g.audio = new AudioSystem(g)))],
  });
  if (qs.has('bgloop') && game.audio) document.removeEventListener('visibilitychange', game.audio._onVis);
  window.__leonida = game;
  if (!game.audio) return;
  window.__audio = game.audio;
  // mix probe: RMS and spectral balance of the master and each bus over a window
  window.__probe = {
    nodes() {
      const m = game.audio.mixer;
      return { master: m.trim, engine: m.engineEq ? m.engineEq[2] : m.bus.engine, sfx: m.bus.sfx, ambient: m.bus.ambient, music: m.bus.music };
    },
    async measure(sec = 4) {
      const a = game.audio, ctx = a.ctx;
      const an = {};
      for (const [k, n] of Object.entries(this.nodes())) {
        const x = ctx.createAnalyser(); x.fftSize = 8192; x.smoothingTimeConstant = 0; n.connect(x);
        an[k] = { x, pow: new Float64Array(4096), sq: 0, cnt: 0, frames: 0 };
      }
      const td = new Float32Array(8192), fd = new Float32Array(4096);
      const t0 = performance.now();
      while (performance.now() - t0 < sec * 1000) {
        for (const o of Object.values(an)) {
          o.x.getFloatTimeDomainData(td);
          for (let i = 0; i < td.length; i++) o.sq += td[i] * td[i];
          o.cnt += td.length;
          o.x.getFloatFrequencyData(fd);
          for (let i = 0; i < fd.length; i++) o.pow[i] += Math.pow(10, fd[i] / 10);
          o.frames++;
        }
        await new Promise((r) => { const st = performance.now(); const c = new MessageChannel(); c.port1.onmessage = () => (performance.now() - st >= 90 ? r() : c.port2.postMessage(0)); c.port2.postMessage(0); });
      }
      const binHz = ctx.sampleRate / 8192;
      const out = {};
      for (const [k, o] of Object.entries(an)) {
        let tot = 0, hi = 0, mid = 0, cen = 0;
        for (let i = 1; i < o.pow.length; i++) { const f = i * binHz; if (f < 20) continue; tot += o.pow[i]; cen += o.pow[i] * f; if (f >= 4000) hi += o.pow[i]; if (f >= 1000) mid += o.pow[i]; }
        out[k] = { rmsDb: +(10 * Math.log10(o.sq / o.cnt + 1e-12)).toFixed(1), above4k: +(100 * hi / (tot + 1e-30)).toFixed(1), above1k: +(100 * mid / (tot + 1e-30)).toFixed(1), centroidHz: Math.round(cen / (tot + 1e-30)) };
        try { this.nodes()[k].disconnect(o.x); } catch { /* */ }
      }
      return out;
    },
  };
  const el = document.getElementById('wstats');
  setInterval(() => {
    const a = game.audio, s = a.stats;
    el.textContent = `ctx ${s.state}  cpu ${s.cpuMs.toFixed(2)} ms\nvoices ${s.voices}  shots ${s.shots}  env ${s.env}\nbank ${(s.bank * 100).toFixed(0)}%  interior ${a.interior.toFixed(2)}\nradio ${a.radio?.stationName ?? '-'}  (, . to tune)\nengine ${a.player?.engine.name ?? '-'} ${a.player?.engine.state ?? ''}`;
  }, 250);
}

// ------------------------------------------------------------------ soundboard
function soundboard() {
  const settingFns = new Map();
  const keys = new Set();
  const game = {
    events: new Events(),
    settings: { ...AUDIO_DEFAULTS },
    onSetting(k, fn) { if (!settingFns.has(k)) settingFns.set(k, []); settingFns.get(k).push(fn); },
    applySetting(k, v) { this.settings[k] = v; for (const fn of settingFns.get(k) || []) fn(v); },
    camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
    sky: { night: 0, time: 13 },
    uniforms: { uWetness: { value: 0 }, uRain: { value: 0 }, uWind: { value: { x: 2, z: 1 } }, uNight: { value: 0 } },
    input: { pressed: (c) => keys.has(c), gpPressedBtn: () => false },
    timeScale: 1,
    paused: false,
  };
  game.camera.position.set(0, 1.6, 6.5);
  game.camera.lookAt(0, 0.8, 0);
  const audio = new AudioSystem(game);
  window.__audio = audio;
  if (qs.has('bgloop')) document.removeEventListener('visibilitychange', audio._onVis); // tests run in a hidden tab
  window.__game = game;

  let veh = null;
  const tel = { rpm: 800, maxRpm: 7000, throttle: 0, engineLoad: 0, gear: 1, shiftId: 0, shifting: false, limiter: false, speedKmh: 0, wheels: [0, 1, 2, 3].map(() => ({ contact: true, slipRatio: 0, skid: 0, surface: 'asphalt', compression: 0.4 })), airborne: false, boosting: false, braking: false, reversing: false, inWater: false, submerged: 0, impactId: 0, impactStrength: 0 };
  const ui = { profile: 'v8', rpmN: 0, thr: 0, speed: 0, skid: 0, surface: 'asphalt', orbit: false, flyby: false, limiterHold: false, shiftT: 0, autoRev: false };

  const kindOf = (p) => ({ heli: 'heli', jet: 'plane', prop: 'plane', boat: 'boat', bicycle: 'bicycle', moped: 'moped', motorcycle: 'motorcycle', vtwin: 'motorcycle', bus: 'bus', diesel: 'truck' }[p] || 'car');
  function makeVehicle(profile, running) {
    const o = new THREE.Object3D();
    o.position.set(0, 0.6, 0);
    return { kind: kindOf(profile), engineSound: profile, object3d: o, telemetry: tel, siren: false, engineRunning: running, occupied: true };
  }
  function setProfile(p, running = false) {
    ui.profile = p;
    const cfg = PROFILES[p];
    tel.maxRpm = cfg.max;
    veh = makeVehicle(p, running);
    game.player = { mode: 'vehicle', controllable: veh, chase: { mode: 'chase' } };
  }
  setProfile('v8');

  const sec = (title, html, cls = '') => `<section class="${cls}"><h2>${title}</h2>${html}</section>`;
  const slider = (id, label, min, max, step, val) => `<div class="row"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><span id="${id}-v">${val}</span></div>`;
  const btn = (id, label, cls = '') => `<button id="${id}" class="${cls}">${label}</button>`;
  const groups = {
    Impacts: ['metal', 'crash', 'glass', 'wood', 'concrete', 'plastic', 'body'],
    Explosions: ['explosion', 'explosion_far', 'collapse', 'fire_whoosh', 'thunder_near', 'thunder_far'],
    Foley: ['door_open', 'door_close', 'seatbelt', 'bov', 'gear_clunk', 'susp_thump', 'brake_squeak', 'air_brake', 'bicycle_bell', 'splash', 'lamp_break', 'tree_crack', 'money'],
    Footsteps: SOUNDS.filter((s) => s.startsWith('step_')),
    Animals: ['bird', 'seagull', 'frog'],
    UI: ['ui_hover', 'ui_click', 'ui_open', 'ui_close', 'ui_notify', 'wasted', 'respawn', 'timeskip', 'radio_static'],
  };
  const loops = ['fire_loop', 'rain_light', 'rain_heavy', 'rain_roof', 'waves', 'city_hum', 'crickets', 'insects', 'underwater', 'gravel_loop', 'grass_loop', 'sand_loop', 'wet_loop', 'scrape_loop'];

  root.innerHTML = `<header><h1>AUDIO LAB</h1>${btn('start', 'Start audio', 'on')}<a href="?world">World mode →</a>${btn('run', 'Run offline tests')}<span id="status"></span></header><main>
  ${sec('Engine', `<div class="row"><span>profile</span><select id="profile">${PROFILE_NAMES.map((p) => `<option ${p === 'v8' ? 'selected' : ''}>${p}</option>`).join('')}</select><span></span></div>
    ${slider('rpm', 'rpm', 0, 1.05, 0.005, 0)}${slider('thr', 'throttle', 0, 1, 0.01, 0)}${slider('spd', 'speed km/h', 0, 250, 1, 0)}
    <div class="btns">${btn('startEng', 'Start (starter)')}${btn('stopEng', 'Stop')}${btn('up', 'Upshift')}${btn('down', 'Downshift')}${btn('lim', 'Limiter (hold)')}${btn('lift', 'Rev + lift (pops)')}${btn('auto', 'Auto rev')}${btn('orbit', 'Orbit')}${btn('flyby', 'Fly-by 30 m/s')}</div>
    <canvas class="scope" id="scope"></canvas>`)}
  ${sec('Tyres / vehicle', `${slider('skid', 'skid', 0, 1, 0.01, 0)}<div class="row"><span>surface</span><select id="surf">${['asphalt', 'wet', 'dirt', 'grass', 'sand'].map((s) => `<option>${s}</option>`).join('')}</select><span></span></div>
    ${slider('inter', 'interior', 0, 1, 1, 0)}
    <div class="btns">${btn('land', 'Landing')}${btn('kerb', 'Kerb hit')}${btn('bottom', 'Bottom out')}${btn('nitro', 'Nitro')}${btn('rev', 'Reverse')}${btn('water', 'Drive into water')}${btn('siren', 'Siren')}${btn('telimpact', 'Physics impact')}</div>
    <div class="btns">${Object.keys(HORNS).map((h) => btn(`horn-${h}`, `horn ${h}`)).join('')}${btn('horn-bicycle', 'bell')}</div>
    <div class="btns">${Object.keys(SIREN_MODES).map((m) => btn(`siren-${m}`, `siren ${m}`)).join('')}</div>`)}
  ${sec('Events', `${slider('str', 'strength', 0, 1, 0.01, 0.6)}${slider('dist', 'distance m', 2, 1500, 1, 20)}
    <div class="btns">${['metal', 'glass', 'wood', 'concrete', 'plastic', 'flesh'].map((m) => btn(`imp-${m}`, `impact ${m}`)).join('')}</div>
    <div class="btns">${btn('ev-explosion', 'explosion')}${btn('ev-fire', 'fire start')}${btn('ev-fireoff', 'fire stop')}${btn('ev-money', 'money')}${btn('ev-ped', 'ped knocked')}${btn('ev-bld', 'building destroyed')}${btn('ev-tree', 'tree broken')}${btn('ev-lamp', 'lamp broken')}${btn('ev-splash', 'splash')}${btn('ev-light', 'lightning')}</div>
    <div class="btns">${btn('ev-enter', 'vehicle:enter')}${btn('ev-exit', 'vehicle:exit')}${btn('ev-wasted', 'wasted')}${btn('ev-respawn', 'respawn')}${btn('ev-skip', 'time:skip')}${['hover', 'click', 'open', 'close', 'notify'].map((u) => btn(`ui-${u}`, `ui:${u}`)).join('')}</div>
    <div class="btns"><select id="stepSurf">${['asphalt', 'grass', 'sand', 'dirt', 'wood', 'metal', 'water'].map((s) => `<option>${s}</option>`).join('')}</select>${btn('walk', 'walk')}${btn('run2', 'run')}</div>`)}
  ${sec('Ambience', `${['urban', 'water', 'nature', 'wetland', 'sand'].map((k) => slider(`a-${k}`, k, 0, 1, 0.01, k === 'urban' ? 0.6 : 0)).join('')}
    ${slider('a-alt', 'altitude', 0, 400, 1, 2)}${slider('a-hour', 'hour', 0, 24, 0.1, 13)}${slider('a-rain', 'rain', 0, 1, 0.01, 0)}${slider('a-wind', 'wind m/s', 0, 25, 0.1, 3)}
    <div class="row"><span>reverb</span><select id="env"><option>auto</option>${Object.keys(ENVIRONMENTS).map((e) => `<option>${e}</option>`).join('')}</select><span></span></div>
    <div class="btns">${btn('under', 'Underwater')}${btn('ambOn', 'Ambience override', 'on')}</div>`)}
  ${sec('Radio', `<div class="btns">${btn('prev', '◀ prev (,)')}${btn('next', 'next (.) ▶')}${RADIO_STATIONS.map((s, i) => btn(`st-${i}`, s.name)).join('')}${btn('st-off', 'off')}</div><div id="radioName" style="margin-top:6px;color:#ffb347"></div>`)}
  ${sec('Loops & one-shots', `${Object.entries(groups).map(([g, l]) => `<div style="margin:4px 0;color:#8a93a6">${g}</div><div class="btns">${l.map((n) => btn(`p-${n}`, n)).join('')}</div>`).join('')}
    <div style="margin:4px 0;color:#8a93a6">Loops (toggle)</div><div class="btns">${loops.map((n) => btn(`l-${n}`, n)).join('')}</div>
    <div class="btns" style="margin-top:6px"><label><input type="checkbox" id="pos3d"> positional (random spot, distance slider)</label></div>`)}
  ${sec('Mixer', `${['master', 'engine', 'sfx', 'ambient', 'music', 'ui'].map((b) => slider(`v-${b}`, b, 0, 1, 0.01, b === 'master' ? 0.8 : b === 'music' ? 0.1 : 1)).join('')}
    <div class="btns">${btn('hrtf', 'HRTF', 'on')}${btn('pause', 'Pause game')}</div><pre id="stats" style="margin:6px 0 0;color:#8a93a6"></pre>`)}
  <section id="tests"><h2>Offline render tests</h2><div id="out">Renders every engine profile through a drive cycle in an OfflineAudioContext and checks level, DC, clipping, silence, clicks around gear shifts and spectral behaviour.</div></section>
  </main>`;

  const $ = (id) => document.getElementById(id);
  const val = (id) => +$(id).value;
  for (const el of document.querySelectorAll('input[type=range]')) el.addEventListener('input', () => { const v = $(`${el.id}-v`); if (v) v.textContent = el.value; });
  const on = (id, fn, ev = 'click') => $(id)?.addEventListener(ev, fn);
  const toggle = (id, fn) => on(id, () => { const b = $(id); b.classList.toggle('on'); fn(b.classList.contains('on')); });

  on('start', () => { audio.start(); $('start').textContent = 'Audio running'; setupScope(); });
  on('profile', () => setProfile($('profile').value, true), 'change');
  on('startEng', () => { setProfile(ui.profile, false); });
  on('stopEng', () => { game.player = { mode: 'foot', controllable: null }; });
  on('up', () => { tel.gear++; tel.shiftId++; ui.shiftT = PROFILES[ui.profile].cyl ? 0.15 : 0; $('rpm').value = Math.max(0.2, val('rpm') * 0.68); });
  on('down', () => { tel.gear = Math.max(1, tel.gear - 1); tel.shiftId++; ui.shiftT = 0.1; $('rpm').value = Math.min(1, val('rpm') * 1.35); });
  on('lim', () => { ui.limiterHold = true; }, 'pointerdown');
  on('lim', () => { ui.limiterHold = false; }, 'pointerup');
  on('lift', () => { ui.liftT = 1.6; });
  toggle('auto', (b) => { ui.autoRev = b; ui.autoT = 0; });
  toggle('orbit', (b) => { ui.orbit = b; });
  on('flyby', () => { ui.flyT = 0; });
  on('land', () => { tel.airborne = true; setTimeout(() => (tel.airborne = false), 900); });
  on('kerb', () => { tel.wheels[0].compression = 0.95; setTimeout(() => (tel.wheels[0].compression = 0.4), 120); });
  on('bottom', () => { tel.wheels[1].compression = 1.1; setTimeout(() => (tel.wheels[1].compression = 0.4), 150); });
  toggle('nitro', (b) => { tel.boosting = b; });
  toggle('rev', (b) => { tel.reversing = b; });
  toggle('water', (b) => { tel.inWater = b; tel.submerged = b ? 0.5 : 0; });
  toggle('siren', (b) => { veh.siren = b; });
  on('telimpact', () => { tel.impactId++; tel.impactStrength = val('str'); });
  for (const h of [...Object.keys(HORNS), 'bicycle']) {
    on(`horn-${h}`, () => { veh.hornType = h; if (h === 'bicycle') veh.kind = 'bicycle'; game.events.emit('horn', { vehicle: veh, on: true }); }, 'pointerdown');
    on(`horn-${h}`, () => { game.events.emit('horn', { vehicle: veh, on: false }); veh.kind = kindOf(ui.profile); }, 'pointerup');
  }
  let sirenLoop = null;
  for (const m of Object.keys(SIREN_MODES)) on(`siren-${m}`, () => { if (sirenLoop) { sirenLoop.stop(0.3); sirenLoop = null; } else sirenLoop = audio.loop(`siren:${m}`, { position: { x: -12, y: 1, z: -8 }, volume: 0.8 }); });

  const posAt = () => { const a = Math.random() * Math.PI * 2, d = val('dist'); return { x: Math.cos(a) * d, y: 1, z: Math.sin(a) * d }; };
  for (const m of ['metal', 'glass', 'wood', 'concrete', 'plastic', 'flesh']) on(`imp-${m}`, () => game.events.emit('impact', { position: posAt(), strength: val('str'), kind: m === 'flesh' ? 'ped' : 'prop', material: m }));
  on('ev-explosion', () => game.events.emit('explosion', { position: posAt(), power: 0.5 + val('str'), radius: 8 }));
  on('ev-fire', () => { ui.firePos = posAt(); game.events.emit('fire:start', { position: ui.firePos }); });
  on('ev-fireoff', () => ui.firePos && game.events.emit('fire:stop', { position: ui.firePos }));
  on('ev-money', () => game.events.emit('money:pickup', { amount: Math.round(val('str') * 1000), position: posAt() }));
  on('ev-ped', () => game.events.emit('ped:knocked', { position: posAt(), strength: val('str') }));
  on('ev-bld', () => game.events.emit('building:destroyed', { position: posAt(), size: 30 }));
  on('ev-tree', () => game.events.emit('tree:broken', { position: posAt(), type: 'palm' }));
  on('ev-lamp', () => { const p = posAt(); game.events.emit('lamp:broken', { position: p, type: 'lamp' }); game.events.emit('impact', { position: p, strength: 0.4, kind: 'prop', material: 'metal' }); });
  on('ev-splash', () => game.events.emit('splash', { position: posAt(), strength: val('str') }));
  on('ev-light', () => game.events.emit('lightning', { position: posAt(), distance: val('dist') }));
  on('ev-enter', () => game.events.emit('vehicle:enter', { vehicle: veh }));
  on('ev-exit', () => game.events.emit('vehicle:exit', { vehicle: veh }));
  on('ev-wasted', () => { game.events.emit('wasted', {}); game.timeScale = 0.3; });
  on('ev-respawn', () => { game.events.emit('respawn', {}); game.timeScale = 1; });
  on('ev-skip', () => game.events.emit('time:skip', {}));
  for (const u of ['hover', 'click', 'open', 'close', 'notify']) on(`ui-${u}`, () => game.events.emit(`ui:${u}`, {}));
  const step = (run) => game.events.emit('footstep', { position: { x: 0.3, y: 0, z: 5.6 }, surface: $('stepSurf').value, run });
  on('walk', () => { let n = 0; const iv = setInterval(() => { step(false); if (++n > 7) clearInterval(iv); }, 520); });
  on('run2', () => { let n = 0; const iv = setInterval(() => { step(true); if (++n > 11) clearInterval(iv); }, 300); });
  for (const list of Object.values(groups)) for (const n of list) on(`p-${n}`, () => audio.play(n, $('pos3d').checked ? { position: posAt(), ref: 6 } : { bus: n.startsWith('ui_') || n === 'wasted' || n === 'respawn' ? 'ui' : 'sfx' }));
  const loopH = {};
  for (const n of loops) on(`l-${n}`, () => { $(`l-${n}`).classList.toggle('on'); if (loopH[n]) { loopH[n].stop(0.5); delete loopH[n]; } else loopH[n] = audio.loop(n, $('pos3d').checked ? { position: posAt() } : { volume: 0.7 }); });

  // ambience override
  let ambOn = true, under = 0;
  const applyAmb = () => {
    if (!audio.ambience) return;
    const hour = val('a-hour');
    const night = Math.max(0, Math.min(1, (Math.abs(hour - 12) - 5.5) / 1.5));
    game.sky.night = night; game.sky.time = hour;
    audio.overrides.rain = val('a-rain');
    audio.overrides.wind = val('a-wind');
    audio.ambience.override = ambOn ? {
      urban: val('a-urban'), water: val('a-water'), waterDist: 20 + (1 - val('a-water')) * 160, waterDir: { x: 1, z: 0 }, nature: val('a-nature'),
      wetland: val('a-wetland'), sand: val('a-sand'), building: val('a-urban') * 0.3, alt: val('a-alt'), underwater: under, traffic: val('a-urban') * 0.6, night, hour,
    } : null;
  };
  toggle('ambOn', (b) => { ambOn = b; });
  toggle('under', (b) => { under = b ? 1 : 0; });
  on('env', () => { audio.overrides.env = $('env').value === 'auto' ? undefined : $('env').value; if (audio.mixer && audio.overrides.env) audio.mixer.setEnvironment(audio.overrides.env); }, 'change');

  // radio
  on('prev', () => audio.radio?.next(-1));
  on('next', () => audio.radio?.next(1));
  RADIO_STATIONS.forEach((s, i) => on(`st-${i}`, () => audio.setRadioStation(i)));
  on('st-off', () => audio.setRadioStation(-1));
  game.ui = { showRadio: (name, genre) => { $('radioName').textContent = `${name} — ${genre}`; } };
  window.addEventListener('keydown', (e) => keys.add(e.code));

  // mixer
  for (const b of ['master', 'engine', 'sfx', 'ambient', 'music', 'ui']) on(`v-${b}`, () => audio.setVolume(b, val(`v-${b}`)), 'input');
  toggle('hrtf', (b) => game.applySetting('audioHrtf', b));
  toggle('pause', (b) => { game.paused = b; });
  on('run', () => runTests());

  // scope
  let analyser = null;
  function setupScope() {
    if (analyser || !audio.mixer) return;
    analyser = audio.ctx.createAnalyser();
    analyser.fftSize = 2048;
    audio.mixer.trim.connect(analyser);
  }
  const cv = $('scope'), c2 = cv.getContext('2d');
  const buf = new Float32Array(2048), fbuf = new Float32Array(1024);
  function drawScope() {
    if (!analyser) return;
    cv.width = cv.clientWidth; cv.height = cv.clientHeight;
    analyser.getFloatTimeDomainData(buf);
    analyser.getFloatFrequencyData(fbuf);
    c2.clearRect(0, 0, cv.width, cv.height);
    c2.strokeStyle = '#ff4fa3'; c2.beginPath();
    for (let i = 0; i < buf.length; i += 2) { const x = i / buf.length * cv.width, y = (0.5 - buf[i] * 0.45) * cv.height; i ? c2.lineTo(x, y) : c2.moveTo(x, y); }
    c2.stroke();
    c2.strokeStyle = '#19d3c5'; c2.beginPath();
    for (let i = 1; i < fbuf.length; i++) { const x = Math.log(i) / Math.log(fbuf.length) * cv.width, y = (-fbuf[i] / 110) * cv.height; i > 1 ? c2.lineTo(x, y) : c2.moveTo(x, y); }
    c2.stroke();
  }

  // frame loop: sliders → telemetry
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const cfg = PROFILES[ui.profile];
    const idle = cfg.idle || 0, max = cfg.max || 1;
    if (ui.autoRev) {
      ui.autoT += dt;
      const ph = ui.autoT % 6;
      $('thr').value = ph < 3 ? 1 : 0;
      $('rpm').value = ph < 3 ? Math.min(1, ph / 2.6) : Math.max(0, 1 - (ph - 3) / 1.6);
    }
    if (ui.liftT > 0) {
      ui.liftT -= dt;
      $('thr').value = ui.liftT > 1.0 ? 1 : 0;
      $('rpm').value = ui.liftT > 1.0 ? Math.min(0.95, (1.6 - ui.liftT) * 1.6) : Math.max(0.1, ui.liftT * 0.9);
    }
    let rN = val('rpm'), thr = val('thr');
    tel.limiter = ui.limiterHold;
    if (ui.limiterHold) { rN = 1.0; thr = 1; }
    tel.rpm = idle + (max - idle) * rN;
    tel.maxRpm = max;
    ui.shiftT -= dt;
    tel.shifting = ui.shiftT > 0;
    tel.throttle = thr;
    tel.engineLoad = tel.shifting ? 0 : thr;
    tel.collective = thr;
    tel.speedKmh = val('spd');
    const sk = val('skid'), sf = $('surf').value;
    for (const w of tel.wheels) { w.skid = sk; w.surface = sf; w.slipRatio = sk * 0.3; }
    tel.maxSkid = sk;
    game.uniforms.uWetness.value = sf === 'wet' ? 0.8 : 0;
    game.player.chase = { mode: val('inter') > 0.5 ? 'hood' : 'chase' };
    if (veh) {
      const o = veh.object3d;
      if (ui.flyT !== undefined && ui.flyT < 6) {
        ui.flyT += dt;
        o.position.set(-90 + ui.flyT * 30, 0.6, -6);
      } else if (ui.orbit) {
        const a = now / 1000 * 0.8;
        o.position.set(Math.cos(a) * 9, 0.6, Math.sin(a) * 9);
      } else o.position.set(0, 0.6, 0);
      if (ui.flyT >= 6) ui.flyT = undefined;
    }
    applyAmb();
    keys.clear();
    if (audio.ready) {
      audio.update(dt, game);
      audio.lateUpdate(dt, game);
      const s = audio.stats;
      $('stats').textContent = `ctx ${s.state} cpu ${s.cpuMs.toFixed(2)} ms  voices ${s.voices}  shots ${s.shots}\nenv ${s.env}  bank ${(s.bank * 100).toFixed(0)}% (${audio.bank.readyMs ? `${Math.round(audio.bank.readyMs)} ms` : '…'})  worklet ${audio.workletReady ? 'ok' : audio.workletFailed ? 'FALLBACK' : '…'}\nengine ${audio.player?.engine.name ?? '-'} ${audio.player?.engine.state ?? ''}  radio ${audio.radio?.stationName}`;
      drawScope();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ test helpers (used by automated checks)
const sleep = (ms) => new Promise((r) => { const t0 = performance.now(); const c = new MessageChannel(); c.port1.onmessage = () => { if (performance.now() - t0 >= ms) r(); else c.port2.postMessage(0); }; c.port2.postMessage(0); });
window.__t = {
  sleep,
  async setup() {
    const a = window.__audio;
    a.start();
    while (!a.workletReady || a.bank.progress < 1) await sleep(100);
    if (this.m) return;
    const mk = (node) => { const an = a.ctx.createAnalyser(); an.fftSize = 8192; node.connect(an); return an; };
    this.m = { master: mk(a.mixer.trim), engine: mk(a.mixer.bus.engine), music: mk(a.mixer.bus.music), sfx: mk(a.mixer.bus.sfx), amb: mk(a.mixer.bus.ambient), ui: mk(a.mixer.bus.ui) };
  },
  // max RMS / peak per bus over a window (dBFS)
  async watch(ms) {
    const peaks = {};
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      for (const [k, an] of Object.entries(this.m)) {
        const b = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(b);
        let s = 0, p = 0;
        for (const x of b) { s += x * x; p = Math.max(p, Math.abs(x)); }
        const pk = (peaks[k] ||= { rms: -200, pk: 0 });
        pk.rms = Math.max(pk.rms, 10 * Math.log10(s / b.length + 1e-12));
        pk.pk = Math.max(pk.pk, p);
      }
      await sleep(40);
    }
    const o = {};
    for (const [k, v] of Object.entries(peaks)) o[k] = `${v.rms.toFixed(1)}/${(20 * Math.log10(v.pk + 1e-12)).toFixed(1)}`;
    return o;
  },
};

// ------------------------------------------------------------------ offline tests
async function runTests(list = PROFILE_NAMES) {
  const status = document.getElementById('status');
  const rows = [];
  for (const p of list) {
    if (status) status.textContent = `rendering ${p}…`;
    const t0 = performance.now();
    const r = await engineReport(p);
    // clean pass (no pops/crackle) for the gear-shift click check
    const clean = PROFILES[p].mode === 'ice' ? await engineReport(p, { overrides: { crackle: 0, shiftPop: 0 } }) : null;
    delete r.x; if (clean) delete clean.x;
    rows.push({ profile: p, rmsDb: r.rmsDb, peakDb: r.peakDb, crestDb: r.crestDb, dc: r.dc, clipped: r.clipped, nan: r.nan, silentWin: r.silentWindows, shiftClickRatio: clean ? clean.clickRatio : null, centroidHz: r.centroidHz, centroidRpmCorr: r.centroidRpmCorr, maxCentroidJumpOct: clean ? clean.maxCentroidJumpOct : r.maxCentroidJumpOct, renderMs: Math.round(performance.now() - t0) });
  }
  if (status) status.textContent = 'spatial…';
  const sp = await spatialReport();
  if (status) status.textContent = 'done';
  window.__audioTests = { engines: rows, spatial: sp };
  const out = document.getElementById('out');
  if (out) {
    const keys = Object.keys(rows[0]);
    const bad = (k, v) => (k === 'clipped' && v > 0) || (k === 'nan' && v > 0) || (k === 'peakDb' && v > -0.5) || (k === 'shiftClickRatio' && v > 3) || (k === 'silentWin' && v > 2);
    out.innerHTML = `<table><tr>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>${rows.map((r) => `<tr>${keys.map((k) => `<td class="${bad(k, r[k]) ? 'bad' : ''}">${r[k]}</td>`).join('')}</tr>`).join('')}</table><pre>${JSON.stringify(sp, null, 1)}</pre>`;
  }
  return window.__audioTests;
}
window.runTests = runTests;
window.perfReport = perfReport;
window.radioReport = radioReport;
window.benchEngines = benchEngines;
