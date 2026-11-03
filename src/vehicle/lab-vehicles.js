// Vehicles lab: the real game with a side panel listing every catalog vehicle (live thumbnails), click to drive,
// a details card with a turntable preview, and a showroom mode (orbit around a slowly rotating vehicle).
import * as THREE from 'three';
import { createGame } from '../core/bootstrap.js';
import { VEHICLE_CATALOG, CATEGORIES } from './catalog.js';
import { createThumbnails } from './Thumbnails.js';
import { initHeadlightPool } from './Vehicle.js';
import { bakeVehicle } from './bake.js';

const CAT_KEY = { truck: 'cat.trucks', bus: 'cat.buses', motorcycle: 'cat.motorcycles', bicycle: 'cat.bicycles' };
const CAT_EN = { compact: 'Compacts', sedan: 'Sedans', coupe: 'Coupes', sports: 'Sports', super: 'Super', muscle: 'Muscle', classic: 'Classics', suv: 'SUVs', pickup: 'Pickups', van: 'Vans', luxury: 'Luxury', service: 'Service', truck: 'Trucks', bus: 'Buses', small: 'Small', motorcycle: 'Motorcycles', bicycle: 'Bicycles', military: 'Military' };

function labModule(game) {
  const T = (key, en) => game.i18n?.t(key, { default: en }) ?? en;
  initHeadlightPool(game.scene);
  game.vehicles.addCatalog(VEHICLE_CATALOG);
  game.traffic?.setCatalog?.(VEHICLE_CATALOG, bakeVehicle);
  const thumbs = game.thumbnails || createThumbnails(game, { always: true });
  const root = document.createElement('div');
  root.id = 'vlab';
  root.innerHTML = `
    <header><b>${T('lab.vehicles', 'VEHICLES')}</b>
      <button data-a="showroom">${T('lab.showroom', 'Showroom')}</button>
      <button data-a="lights">${T('lab.lights', 'Lights')}</button>
      <button data-a="siren">${T('lab.siren', 'Siren')}</button></header>
    <input type="search" placeholder="${T('veh.search', 'Search vehicles…')}">
    <div class="vl-cats"></div><div class="vl-list"></div>
    <div class="vl-info"></div>`;
  document.body.appendChild(root);
  const list = root.querySelector('.vl-list'), cats = root.querySelector('.vl-cats'), info = root.querySelector('.vl-info');
  const search = root.querySelector('input');
  let cat = 'all', sel = null, showroom = false, srYaw = 0, srOrbit = -0.7, srPitch = 0.22, srDist = 0, turntable = null;
  const cards = new Map();

  const catBtn = (c, label) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { cat = c; render(); };
    b.dataset.c = c;
    cats.appendChild(b);
  };
  catBtn('all', T('veh.all', 'All'));
  for (const c of CATEGORIES) catBtn(c, T(CAT_KEY[c] || `cat.${c}`, CAT_EN[c] || c));

  function card(e) {
    let el = cards.get(e.id);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'vl-card';
    el.innerHTML = `<div class="vl-ph"></div><div class="vl-nm">${e.name} <small>${e.brand}</small></div>`;
    el.onclick = () => select(e.id, true);
    cards.set(e.id, el);
    return el;
  }
  function fill(id) {
    const el = cards.get(id), img = thumbs.get(id);
    if (!el || !img || el.querySelector('canvas')) return;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    el.querySelector('.vl-ph').replaceWith(c);
  }
  thumbs.onReady(fill);
  const io = new IntersectionObserver((es) => { for (const x of es) if (x.isIntersecting) { const id = x.target.dataset.id; thumbs.request(id, 10); fill(id); } }, { root: list });

  function render() {
    for (const b of cats.children) b.classList.toggle('on', b.dataset.c === cat);
    const q = search.value.trim().toLowerCase();
    list.textContent = '';
    for (const e of VEHICLE_CATALOG) {
      if (cat !== 'all' && e.category !== cat) continue;
      if (q && !`${e.brand} ${e.name} ${e.id}`.toLowerCase().includes(q)) continue;
      const el = card(e);
      el.dataset.id = e.id;
      el.classList.toggle('vl-sel', e.id === sel);
      list.appendChild(el);
      io.observe(el);
      fill(e.id);
    }
  }
  search.oninput = render;

  function select(id, drive) {
    sel = id;
    const e = VEHICLE_CATALOG.find((x) => x.id === id);
    for (const [k, el] of cards) el.classList.toggle('vl-sel', k === id);
    const acc = e.accel0100 ? `${e.accel0100} s` : e.accelMeasured ? `0–${e.accelMeasured.kmh}: ${e.accelMeasured.s} s` : '—';
    info.innerHTML = `<h3>${e.brand} ${e.name}</h3><div style="color:#8e98a8">${T(CAT_KEY[e.category] || `cat.${e.category}`, CAT_EN[e.category])} · ${e.kind}</div>
      <div class="vl-tt"></div>
      <div class="vl-stats"><span>${T('lab.top', 'Top speed')}</span><b>${e.topSpeedKmh} km/h</b><span>0–100</span><b>${acc}</b>
      <span>${T('lab.seats', 'Seats')}</span><b>${e.seats}</b><span>${T('lab.price', 'Price')}</span><b>$${e.price.toLocaleString('en-US')}</b></div>
      <div style="margin-top:6px;color:#c9d2de">${e.desc}</div><div class="vl-tele"></div>`;
    turntable?.dispose();
    turntable = thumbs.createTurntable(info.querySelector('.vl-tt'), id);
    if (drive) {
      const v = game.spawnForPlayer(id);
      if (game.sky.night > 0.35) v.setHeadlights?.(true);
    }
  }

  root.querySelector('[data-a=showroom]').onclick = (ev) => {
    showroom = !showroom;
    ev.target.classList.toggle('on', showroom);
    const v = game.player?.controllable;
    if (showroom && v) {
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(v.object3d.quaternion);
      srYaw = Math.atan2(-f.x, -f.z);
      srDist = Math.max(4.5, (v.dims?.length ?? 4.5) * 1.25 + 2);
    }
  };
  root.querySelector('[data-a=lights]').onclick = () => { const v = game.player?.controllable; v?.setHeadlights?.(!v.headlightsOn); };
  root.querySelector('[data-a=siren]').onclick = () => { const v = game.player?.controllable; if (v) v.siren = !v.siren; };
  let drag = null;
  const dom = game.renderer.domElement;
  dom.addEventListener('pointerdown', (e) => { if (showroom) drag = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    srOrbit -= (e.clientX - drag.x) * 0.006;
    srPitch = Math.max(0.02, Math.min(1.2, srPitch + (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => (drag = null));
  dom.addEventListener('wheel', (e) => { if (showroom) srDist = Math.max(2.5, Math.min(40, srDist * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: true });

  const tele = () => info.querySelector('.vl-tele');
  const _c = new THREE.Vector3();
  render();
  select(game.player?.controllable?.catalogId || 'comet', false);

  return {
    order: 95,
    fixedUpdate(dt) {
      if (!showroom) return;
      const v = game.player?.controllable;
      if (!v?.body) return;
      // park the vehicle and spin it slowly in place
      srYaw += dt * 0.35;
      const t = v.body.translation();
      v.body.setRotation({ x: 0, y: Math.sin(srYaw / 2), z: 0, w: Math.cos(srYaw / 2) }, true);
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      const l = v.body.linvel();
      v.body.setLinvel({ x: 0, y: Math.min(0, l.y), z: 0 }, true);
      v.body.setTranslation({ x: t.x, y: t.y, z: t.z }, true);
    },
    lateUpdate(dt) {
      const v = game.player?.controllable;
      const tl = tele();
      if (v?.telemetry && tl) {
        const m = v.telemetry;
        tl.textContent = `${m.speedKmh.toFixed(0).padStart(3)} km/h  gear ${m.gear}  ${Math.round(m.rpm)} rpm${m.lean !== undefined && v.spec?.twoWheel ? `\nlean ${(m.lean * 57.3).toFixed(0)}°  wheelie ${(m.wheelie * 57.3).toFixed(0)}°${m.fallen ? '  FALLEN' : ''}` : ''}`
          + (v.kind === 'tank' ? `\narmour ${Math.round(v.armor * 100)}%  reload ${v.reloadLeft.toFixed(1)} s  turret ${(v.turretYaw * 57.3).toFixed(0)}°` : '');
      }
      if (!showroom || !v?.object3d) return;
      const p = v.object3d.position;
      const h = (v.dims?.height ?? 1.4) * 0.45;
      const cam = game.camera;
      cam.position.set(p.x + Math.sin(srOrbit) * srDist * Math.cos(srPitch), p.y + h + srDist * Math.sin(srPitch), p.z + Math.cos(srOrbit) * srDist * Math.cos(srPitch));
      cam.lookAt(_c.set(p.x, p.y + h * 0.6, p.z));
    },
    dispose() {
      turntable?.dispose();
      root.remove();
    },
  };
}

const app = document.getElementById('app');
createGame(app, { autostart: true, noPeds: true, modules: [(game) => labModule(game)] });
