import * as THREE from 'three';
import { Game } from '../core/Game.js';
import { InputManager } from '../core/input.js';
import { Areas } from '../world/areas.js';
import { getI18n } from '../i18n/index.js';

// UI lab: the full game (createGame) plus a dev toolbar. Falls back to a lightweight mock game (no 3D world)
// when ?mock is set or the game fails to boot, so the HUD/menu can be tested in isolation.
const container = document.getElementById('app');
const params = new URLSearchParams(location.search);

async function boot() {
  if (!params.has('mock')) {
    try {
      const { createGame } = await import('../core/bootstrap.js');
      return await createGame(container, { autostart: true });
    } catch (e) {
      console.warn('[lab-ui] createGame failed, using the mock game', e);
      container.innerHTML = '';
      document.querySelectorAll('#loading').forEach((x) => x.remove());
    }
  }
  return createMockGame();
}

async function createMockGame() {
  const game = new Game();
  game.mock = true;
  try { game.settings = { units: 'kmh', showFps: true, lang: 'auto', ...JSON.parse(localStorage.getItem('leonida.settings') || '{}') }; } catch { game.settings = {}; }
  const base = `${import.meta.env.BASE_URL}data/`;
  const [world, mapImage] = await Promise.all([
    fetch(`${base}world.json`).then((r) => r.json()),
    new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = `${base}map.webp`; }),
  ]);
  game.worldData = world;
  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas';
  canvas.style.cssText = 'width:100%;height:100%;background:linear-gradient(#2b4a6b, #e8a46b 60%, #33402c 61%)';
  container.appendChild(canvas);
  game.input = new InputManager(canvas);
  game.camera = new THREE.PerspectiveCamera();
  game.terrain = { heightAt: () => 2 };
  game.world3d = new Areas(world);
  game.render = { scale: 1 };
  game.sky = {
    time: 17.5, timeScale: 1 / 120, paused: false,
    setTime(h) { this.time = ((h % 24) + 24) % 24; },
    get clock() { const h = Math.floor(this.time), m = Math.floor((this.time - h) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; },
  };
  game.world = { gravity: { x: 0, y: -9.81, z: 0 } };
  let catalog = [];
  try { catalog = (await import('../vehicle/catalog.js')).VEHICLE_CATALOG.map((e) => ({ ...e, preset: undefined })); } catch { /* not there yet */ }
  if (!catalog.length) catalog = ['comet', 'muscle', 'super', 'suv', 'pickup', 'cruiser'].map((id) => ({ id, name: id, category: 'car', kind: 'car' }));
  catalog.push({ id: 'heli_test', name: 'Skylark', brand: 'Leonida Aero', category: 'heli', kind: 'heli', topSpeedKmh: 250, seats: 4, price: 950000 },
    { id: 'plane_test', name: 'Pelican', brand: 'Leonida Aero', category: 'plane', kind: 'plane', topSpeedKmh: 420, seats: 6, price: 1800000 },
    { id: 'boat_test', name: 'Squalo', brand: 'Keys Marine', category: 'boat', kind: 'boat', topSpeedKmh: 110, seats: 4, price: 180000 },
    { id: 'tank', name: 'Bulwark', brand: 'Leonida Defense', category: 'military', kind: 'tank', topSpeedKmh: 70, seats: 2, price: 1800000, desc: 'Main battle tank. Parking is never a problem.' });
  game.vehicles = { catalog, byId: new Map(catalog.map((e) => [e.id, e])), active: [] };
  const mkVehicle = (id) => {
    const e = game.vehicles.byId.get(id) || { id, name: id, kind: 'car' };
    return { catalogId: id, name: e.name, kind: e.kind || 'car', telemetry: { speedKmh: 0, rpm: 900, maxRpm: 7000, gear: 1, boost: 1 } };
  };
  const focus = new THREE.Vector3(1745, 0, -640);
  game.player = {
    mode: 'vehicle', focus, heading: 0, health: 1, armor: 0.4, money: 1250, waypoint: null, route: null, invincible: false,
    controllable: mkVehicle(catalog[0].id),
    setWaypoint(w) { this.waypoint = w; this.route = w ? [focus.x, focus.z, (focus.x + w.x) / 2, focus.z, w.x, w.z] : null; },
    teleport(x, z) { focus.set(x, 0, z); },
    addMoney(n) { this.money += n; game.events.emit('money:pickup', { amount: n }); },
    enter(v) { this.controllable = v; game.events.emit('vehicle:enter', { vehicle: v }); },
  };
  game.spawnForPlayer = (id) => { const v = mkVehicle(id); game.player.enter(v); game.ui?.showVehicleName?.(v.name, ''); return v; };
  const { createUI } = await import('./index.js');
  game.ui = createUI(game, { container, mapImage });
  game.events.emit('start', {});
  let last = performance.now(), t = 0;
  const loop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    game.input.update();
    if (!game.paused) {
      t += dt;
      game.sky.time = (game.sky.time + dt * game.sky.timeScale * (game.sky.paused ? 0 : 1)) % 24;
      const v = game.player.controllable;
      const sp = 22 + 14 * Math.sin(t * 0.4);
      game.player.heading = (t * 0.12) % (Math.PI * 2);
      focus.x += Math.sin(game.player.heading) * sp * dt;
      focus.z -= Math.cos(game.player.heading) * sp * dt;
      if (v) Object.assign(v.telemetry, { speedKmh: sp * 3.6, rpm: 2500 + 3500 * (0.5 + 0.5 * Math.sin(t * 1.7)), gear: 1 + Math.floor((sp * 3.6) / 40), drifting: Math.sin(t * 0.7) > 0.93, boost: 0.5 + 0.5 * Math.sin(t * 0.3) });
    }
    game.fps = 60;
    game.ui.update(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__leonida = game;
  return game;
}

function toolbar(game) {
  const ui = game.ui, i18n = getI18n();
  const bar = document.createElement('div');
  bar.id = 'lab';
  const langs = ['auto', ...i18n.languages.map((l) => l.code)];
  bar.innerHTML = `
    <button class="toggle" data-a="min">☰</button>
    <select id="lab-lang">${langs.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
    <button data-a="lang-1">◀</button><button data-a="lang+1">▶</button>
    <span class="sep"></span>
    ${['map', 'vehicles', 'service', 'wardrobe', 'world', 'player', 'settings', 'controls', 'stats', 'about'].map((t) => `<button data-a="tab:${t}">${t}</button>`).join('')}
    <button data-a="close">close</button>
    <span class="sep"></span>
    <button data-a="money:250">+$250</button><button data-a="money:25000">+$25k</button><button data-a="money:-500">−$500</button>
    <button data-a="notify">notify</button><button data-a="big">big msg</button><button data-a="help">help</button><button data-a="wasted">wasted</button>
    <span class="sep"></span>
    <button data-a="sim:off">sim off</button><button data-a="sim:plane">plane</button><button data-a="sim:heli">heli</button><button data-a="sim:boat">boat</button><button data-a="sim:tank">tank</button><button data-a="fire">fire!</button><button data-a="dmg">dmg</button>
    <button data-a="hurt">hurt</button>
    <span class="sep"></span>
    <button data-a="mode">${game.online ? 'online→single' : 'single→online'}</button><button data-a="mp">mp hooks</button><button data-a="eco">economy</button><button data-a="wardrobe">wardrobe</button><button data-a="combo">combo+</button>
    <span class="perf"></span>`;
  document.body.appendChild(bar);
  const sel = bar.querySelector('#lab-lang');
  sel.value = i18n.pref;
  i18n.onChange(() => { sel.value = i18n.pref; });
  sel.addEventListener('change', () => game.applySetting('lang', sel.value));
  const step = (d) => {
    const i = Math.max(0, langs.indexOf(i18n.pref === 'auto' ? i18n.lang : i18n.pref));
    game.applySetting('lang', langs[1 + ((i - 1 + d + langs.length - 1) % (langs.length - 1))]);
  };
  let wasted = false, simT = 0;
  bar.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'min') bar.classList.toggle('min');
    else if (a === 'lang-1') step(-1);
    else if (a === 'lang+1') step(1);
    else if (a.startsWith('tab:')) ui.open(a.slice(4));
    else if (a === 'close') ui.close();
    else if (a.startsWith('money:')) game.player.addMoney(+a.slice(6), game.player.focus);
    else if (a === 'notify') {
      const n = (ui._n = (ui._n || 0) + 1) % 3;
      ui.feed([{ kind: 'garage', text: i18n.t('notify.spawned', { name: 'Comet' }) }, { kind: 'weather', icon: 'storm', text: i18n.t('notify.weather', { name: i18n.t('weather.storm') }) }, { kind: 'bank', text: i18n.t('notify.money', { amount: i18n.money(25000) }) }][n]);
    } else if (a === 'big') ui.toast(i18n.t('gps.arrived'), 'OCEAN BEACH', 4);
    else if (a === 'help') ui.showHelp(i18n.t('msg.help'), 8);
    else if (a === 'wasted') { wasted = !wasted; ui.wasted(wasted); }
    else if (a === 'mode') { const u = new URL(location.href); u.searchParams.set('mode', game.online ? 'single' : 'online'); location.href = u; }
    else if (a === 'mp') mpDemo(game);
    else if (a === 'eco') ecoDemo(game);
    else if (a === 'wardrobe') { ecoDemo(game); wardrobeDemo(game); ui.open('wardrobe'); }
    else if (a === 'combo') { ui._combo = ((ui._combo || 1) >= 5 ? 1 : (ui._combo || 1) + 0.5); game.events.emit('economy:combo', { combo: ui._combo }); }
    else if (a === 'fire') game.events.emit('tank:reload', { t: 3.5 });
    else if (a === 'dmg') {
      const sim = ui.simulate || (ui.simulate = { kind: game.player.controllable?.kind || 'car', telemetry: game.player.controllable?.telemetry || {} });
      const d = (sim.damage ||= { engine: 1, body: 1, state: 'ok' });
      d.engine = Math.max(0, d.engine - 0.25); d.body = Math.max(0, d.body - 0.3);
      d.burning = d.engine < 0.2;
      if (game.player.controllable) game.player.controllable.damage = d;
    }
    else if (a === 'hurt') { const p = game.player; p.health = Math.max(0.05, (p.health ?? 1) - 0.3); p.armor = Math.max(0, (p.armor ?? 0) - 0.2); }
    else if (a.startsWith('sim:')) {
      const k = a.slice(4);
      ui.simulate = k === 'off' ? null : { kind: k, telemetry: {} };
      if (k !== 'off') ui.showVehicleName({ plane: 'Pelican', heli: 'Skylark', boat: 'Squalo', tank: 'Bulwark' }[k], i18n.t(`cat.${{ plane: 'planes', heli: 'helicopters', boat: 'boats', tank: 'military' }[k]}`));
    }
  });
  // animate simulated instruments + measure HUD cost
  const update = ui.update;
  let acc = 0, n = 0, worst = 0;
  ui.update = (dt) => {
    const sim = ui.simulate;
    if (sim) {
      simT += dt;
      const tel = sim.telemetry;
      tel.heading = (simT * 9) % 360;
      tel.throttle = sim.kind === 'boat' ? 0.6 + 0.4 * Math.sin(simT * 0.5) : 0.5 + 0.5 * Math.sin(simT * 0.3);
      tel.speedKmh = sim.kind === 'boat' ? 40 + 30 * Math.sin(simT * 0.4) : sim.kind === 'tank' ? 30 + 20 * Math.sin(simT * 0.3) : 180 + 120 * Math.sin(simT * 0.2);
      if (sim.kind === 'tank') { tel.rpm = 1500; tel.maxRpm = 2600; tel.gear = 2; }
      tel.altitude = sim.kind === 'boat' ? 0 : 300 + 280 * Math.sin(simT * 0.15);
      tel.verticalSpeed = 280 * 0.15 * Math.cos(simT * 0.15);
      if (sim.kind === 'plane') { tel.gearDown = tel.altitude < 150; tel.flaps = tel.altitude < 200 ? 0.5 : 0; tel.stall = tel.speedKmh < 75; }
      tel.anchor = sim.kind === 'boat' && Math.sin(simT * 0.2) > 0.9;
      tel.boost = 1;
    }
    const t0 = performance.now();
    update(dt);
    const ms = performance.now() - t0;
    if (!ui.isOpen) { acc += ms; n++; worst = Math.max(worst, ms); }
    if (n >= 60) {
      bar.querySelector('.perf').textContent = `HUD ${(acc / n).toFixed(3)} ms avg · ${worst.toFixed(2)} max`;
      acc = 0; n = 0; worst = 0;
    }
  };
}

// stand-in wardrobe (D) + preview: a flat figure coloured by the outfit, squashed by the yaw to fake a turntable
function wardrobeDemo(game) {
  const C = { hair: [0x2a1b12, 0xc9a35f, 0xff4fa0], tops: [0xffffff, 0xff3fa4, 0x29f0e0, 0x1d1f24], jackets: [0x3d5a80, 0x1d1f24, 0x8a6f52],
    legs: [0x3d5a80, 0xd8c7a0, 0x1d1f24], shoes: [0xf2f2f2, 0x1d1f24, 0xd94f4f], hats: [0x1d1f24, 0xf5c84c], glasses: [0x111111, 0xd9a441] };
  const items = [];
  const add = (slot, id, name, tier, price) => items.push({ id, slot, name, tier, price, colors: C[slot] || [0xffffff] });
  add('hair', 'buzz', 'Buzz cut', 'basic', 0); add('hair', 'mohawk', 'Mohawk', 'street', 1200); add('hair', 'bob', 'Bob', 'premium', 2500);
  add('tops', 'tee', 'Plain tee', 'basic', 0); add('tops', 'hawaii', 'Hawaiian shirt', 'street', 900); add('tops', 'polo', 'Club polo', 'premium', 2400); add('tops', 'silk', 'Silk shirt', 'luxury', 18000);
  add('jackets', 'denim', 'Denim jacket', 'street', 3500); add('jackets', 'suitj', 'Suit jacket', 'luxury', 42000);
  add('legs', 'jeans', 'Jeans', 'basic', 0); add('legs', 'chinos', 'Chinos', 'premium', 1800); add('legs', 'shorts', 'Board shorts', 'street', 650);
  add('shoes', 'sneakers', 'Sneakers', 'basic', 0); add('shoes', 'loafers', 'Loafers', 'luxury', 9500);
  add('hats', 'cap', 'Baseball cap', 'street', 400); add('glasses', 'aviators', 'Aviators', 'premium', 3200);
  game.wardrobe = { items };
  const owned = new Set(items.filter((i) => !i.price).map((i) => i.id));
  if (game.economy) {
    Object.assign(game.economy, {
      outfit: { hair: { id: 'buzz', color: 0x2a1b12 }, tops: { id: 'tee', color: 0xffffff }, legs: { id: 'jeans', color: 0x3d5a80 }, shoes: { id: 'sneakers', color: 0xf2f2f2 } },
      ownsWardrobe: (id) => owned.has(id),
      async buyWardrobe(ids) { await new Promise((r) => setTimeout(r, 600)); const t = ids.reduce((a, id) => a + (items.find((i) => i.id === id)?.price || 0), 0); if (t > this.money) return { ok: false, reason: 'funds' }; this.money -= t; ids.forEach((id) => owned.add(id)); this.emit(); return { ok: true }; },
      setOutfit(o) { this.outfit = { ...o }; },
      async changeNick({ mode, value }) {
        await new Promise((r) => setTimeout(r, 500));
        if (mode === 'suggest') return { ok: true, suggestions: ['NeonGator42', 'SalsaPelican7', 'TurboManatee'] };
        if (mode === 'check') return { ok: true, available: !/admin|taken/i.test(value), reason: /admin|taken/i.test(value) ? 'taken' : undefined };
        const price = mode === 'custom' ? 50000 : 2500;
        if (price > this.money) return { ok: false, reason: 'funds' };
        this.money -= price; this.nick = value; this.emit(); return { ok: true, nick: value };
      },
    });
  }
  game.characters = {
    createPreview(el) {
      const cv = document.createElement('canvas');
      el.appendChild(cv);
      let outfit = {}, yaw = 0, view = 'body', raf = 0;
      const col = (s, d) => `#${((outfit[s]?.color ?? d) >>> 0).toString(16).padStart(6, '0')}`;
      const draw = () => {
        raf = requestAnimationFrame(draw);
        const r = cv.getBoundingClientRect(); const dpr = 2;
        cv.width = r.width * dpr; cv.height = r.height * dpr;
        const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const k = view === 'face' ? 2.6 : 1, w = Math.abs(Math.cos(yaw)) * 0.75 + 0.25;
        g.translate(r.width / 2, view === 'face' ? r.height * 0.95 : r.height * 0.52); g.scale(w * k, k);
        const box = (x, y, bw, bh, c) => { g.fillStyle = c; g.fillRect(x - bw / 2, y, bw, bh); };
        box(0, 70, 34, 70, col('legs', 0x3d5a80)); box(0, 136, 40, 10, col('shoes', 0xf2f2f2));
        box(0, -10, 56, 82, col('tops', 0xffffff)); if (outfit.jackets) { box(-22, -10, 14, 82, col('jackets', 0)); box(22, -10, 14, 82, col('jackets', 0)); }
        g.fillStyle = '#e8b893'; g.beginPath(); g.arc(0, -36, 22, 0, Math.PI * 2); g.fill();
        g.fillStyle = col('hair', 0x2a1b12); g.fillRect(-22, -60, 44, outfit.hair?.id === 'mohawk' ? 10 : 16);
        if (outfit.hats) { g.fillStyle = col('hats', 0); g.fillRect(-24, -64, 48, 14); }
        if (outfit.glasses) { g.fillStyle = col('glasses', 0); g.fillRect(-16, -42, 32, 7); }
      };
      draw();
      return { setOutfit(o) { outfit = o || {}; }, rotate(a) { yaw = a; }, setView(v) { view = v; }, dispose() { cancelAnimationFrame(raf); cv.remove(); } };
    },
  };
  const tab = game.ui.menu.byId.get('wardrobe');
  tab.dirty = true;
}

// minimal stand-in for game.economy (workstream L) to exercise the garage
function ecoDemo(game) {
  if (game.economy) return;
  const listeners = new Set();
  const cat = game.vehicles.catalog;
  const starter = cat.find((e) => e.category === 'compact')?.id || cat[0]?.id;
  const eco = {
    money: 25000, owned: new Set([starter]), starters: new Set([starter]), unlockAll: false,
    owns(id) { return this.unlockAll || this.owned.has(id); },
    price(id) { const e = cat.find((x) => x.id === id); return e?.price ?? 30000; },
    isStarter(id) { return this.starters.has(id); },
    async buy(id) { const p = this.price(id); if (p > this.money) return { ok: false, reason: 'funds' }; this.money -= p; this.owned.add(id); this.emit(); return { ok: true }; },
    async sell(id) { if (this.starters.has(id)) return { ok: false, reason: 'starter' }; this.money += Math.round(this.price(id) * 0.55); this.owned.delete(id); this.emit(); return { ok: true }; },
    grant(n) { this.money += n; this.emit(); },
    inventory: { extinguisher: 1, vehicles: {} },
    servicePrice(id, vid, o = {}) { if (id === 'respray') return o.finish === 'pearl' ? 2500 : 500; return { repair: 1200, extinguisher: 750, armor: 25000, insurance: 5000, nitro: 400, neon: 3500, tint: 1500, horn: 1000 }[id]; },
    vehicleMods(id) { return this.inventory.vehicles[id] || {}; },
    async buyService(id, vid, opts = {}) {
      await new Promise((r) => setTimeout(r, 700)); // pretend server round-trip
      const p = (id === 'respray' && opts.finish === 'pearl') ? 2500 : this.servicePrice(id);
      if (p > this.money) return { ok: false, reason: 'funds' };
      this.money -= p;
      const m = (this.inventory.vehicles[vid] ||= {});
      if (id === 'extinguisher') this.inventory.extinguisher++;
      if (id === 'armor') m.plated = true;
      if (id === 'insurance') m.insuredUntil = Date.now() + 7 * 864e5;
      if (id === 'neon') m.neon = opts.color;
      if (id === 'tint') m.tint = opts.level;
      if (id === 'horn') m.horn = opts.horn;
      if (id === 'respray') { m.color = opts.color; m.finish = opts.finish; }
      this.emit();
      return { ok: true, cost: p };
    },
    setUnlockAll(on) { this.unlockAll = on; this.emit(); },
    netWorth() { return this.money; },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    emit() { for (const f of listeners) f(this); },
  };
  game.economy = eco;
  game.ui.menu.byId.get('vehicles').dirty = true;
}

// exercises the multiplayer extension points: HUD slots, player blips, an extra menu tab
function mpDemo(game) {
  const ui = game.ui;
  if (!ui._mp) {
    const counter = document.createElement('div');
    counter.className = 'modebadge online';
    counter.innerHTML = '<i></i>12 / 64';
    const board = document.createElement('div');
    board.style.cssText = 'font: 500 13px var(--f-ui); background: var(--ui-bg); padding: 6px 10px; min-width: 160px;';
    board.innerHTML = '1. vicefox <b style="float:right;color:var(--money)">$48,200</b><br>2. palmrunner <b style="float:right;color:var(--money)">$31,050</b>';
    const tag = document.createElement('div');
    tag.style.cssText = 'position:absolute;left:52%;top:48%;font:500 14px var(--f-ui);text-shadow:var(--text-shadow)';
    tag.textContent = 'vicefox';
    ui.mount('top-center', counter);
    ui.mount('top-right-under-money', board);
    ui.mount('world-overlay', tag);
    ui.menu.addTab({
      id: 'online', icon: 'globe', labelKey: 'mp.tab', label: 'Online',
      create: (el) => {
        el.innerHTML = `<div class="cols"><div class="col"><h3 class="sec"><span>TOP 10</span></h3>${['vicefox', 'palmrunner', 'neonowl'].map((n, i) => `<div class="row" data-nav data-key="p${i}"><span>${i + 1}. ${n}</span><b>$${(48200 - i * 9000).toLocaleString()}</b></div>`).join('')}</div></div>`;
        return { show() {}, hide() {}, update() {}, destroy() {} };
      },
    });
    ui._mp = true;
  }
  const f = game.player.focus;
  ui.setPlayerBlips([
    { x: f.x + 120, z: f.z - 60, color: '#ffd23f', heading: 1.2, label: 'vicefox' },
    { x: f.x - 90, z: f.z + 40, color: '#5cff8a', heading: -2, label: 'palmrunner' },
    { x: f.x + 900, z: f.z + 900, color: '#ff6b6b', label: 'neonowl' },
  ]);
}

boot().then((game) => toolbar(game)).catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f66;padding:20px">${e?.stack || e}</pre>`); });
