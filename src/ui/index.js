import './styles.css';
import { Hud } from './Hud.js';
import { Menu } from './Menu.js';
import { Stats } from './Stats.js';
import { createI18n, getI18n } from '../i18n/index.js';
import { GP } from '../core/input.js';
import { categoryOf } from './vehicles-data.js';
import { hasHandler } from './util.js';
import { Thumbs } from './thumbs.js';
export { showLoading } from './Loading.js';
export { getI18n };

const FEED = {
  garage: { icon: 'car', color: '#ff3fa4' }, gps: { icon: 'pin', color: '#a24dff' }, weather: { icon: 'cloud', color: '#3fa6ff' },
  player: { icon: 'user', color: '#6ac259' }, world: { icon: 'globe', color: '#29b8a8' }, settings: { icon: 'cog', color: '#8a8f98' },
  bank: { icon: 'money', color: '#4caf50' }, info: { icon: 'info', color: '#ff8a3d' },
};

// UI facade (contract in docs/ARCHITECTURE.md, details in src/ui/INTEGRATION.md). Owned by workstream G.
export function createUI(game, { container, mapImage }) {
  const i18n = createI18n(game);
  migrateSettings(game);
  const t = (k, p) => i18n.t(k, p);
  const hud = new Hud(container, game, mapImage);
  const stats = new Stats(game);
  const thumbs = new Thumbs(game);
  let pendingThumb = null;
  let lastTab = 'map';
  let lastVName = { n: '', s: '', at: 0 };
  let blipT = 0, blips = [];
  let modeKey = null;
  let backdropFrames = 0;

  const ui = {
    hud, stats, i18n, thumbs,
    menu: null,
    simulate: null, // lab: { kind: 'plane'|'heli'|'boat'|..., telemetry: {...} } overrides the HUD source
    get isOpen() { return ui.menu.open; },

    toast: (big, small, s) => hud.toast(big, small, s),
    // notify('text', seconds) or notify({ title, text, icon, color }, seconds) — feed card (top-left)
    notify(msg, s = 4, silent = false) {
      if (ui.menu?.open) { ui.menu.status(msg); if (!silent) game.events.emit('ui:notify', {}); return null; }
      const card = hud.notify(msg, s);
      if (!silent) game.events.emit('ui:notify', {}); // the chime
      return card;
    },
    // feed card with a preset look: feed({ kind: 'garage'|'gps'|'weather'|'player'|'world'|'settings'|'bank'|'info', text })
    feed(o) {
      const k = FEED[o.kind] || {};
      return ui.notify({ icon: k.icon, color: k.color, ...o, title: o.title ?? (o.kind ? t(`feed.${o.kind}`) : undefined) }, o.seconds ?? 4.5, !!o.silent);
    },
    showHelp: (html, s) => hud.showHelp(html, s),
    // radio station popup; genre may be a key ('synthwave' → radio.genre.synthwave) or plain text
    showRadio(name, genre = '') {
      const g = genre && i18n.has(`radio.genre.${genre}`) ? t(`radio.genre.${genre}`) : genre;
      hud.showRadio(name || t('radio.off'), g);
    },
    wasted: (on) => hud.wasted(on),
    // setMode(text) or setMode({ key: 'mode.free' }) — keyed texts are re-translated on language change
    setMode(m) {
      modeKey = typeof m === 'object' && m ? m.key : m && m === t('mode.free') ? 'mode.free' : null;
      hud.setMode(modeKey ? t(modeKey) : m);
    },
    // vehicle name popup with a small preview image (id defaults to the player's current vehicle)
    showVehicleName(n, sub = '', id) {
      const now = performance.now();
      if (!sub && n === lastVName.n && now - lastVName.at < 1500) sub = lastVName.s;
      lastVName = { n, s: sub, at: now };
      hud.showVehicleName(n, sub);
      id ??= game.player?.controllable?.catalogId;
      const src = id ? thumbs.get(id) : null;
      hud.setVehicleThumb(src);
      pendingThumb = !src && id && thumbs.available() ? id : null;
      if (pendingThumb) thumbs.request(id, 1);
    },

    open(tab) {
      if (!ui.menu.open) {
        game.paused = !game.online; // online the world (and other players) keep running behind the menu
        game.input.unlockPointer();
        ui.menu.show(tab || lastTab);
        hud.el.hud.classList.add('paused');
        game.events.emit('ui:open', { tab: ui.menu.tab.id });
      } else if (tab) ui.menu.select(tab);
    },
    close() {
      if (!ui.menu.open) return;
      lastTab = ui.menu.tab.id === 'map' ? lastTab : ui.menu.tab.id;
      ui.menu.hide();
      hud.el.hud.classList.remove('paused');
      game.paused = false;
      game.events.emit('ui:close', {});
    },

    // Paused-loop hook (src/core/bootstrap.js): may the 3D scene be re-rendered this frame? While the pause menu
    // covers the screen the world is frozen, so the canvas keeps showing the last frame and the whole frame budget
    // goes to the menu. A frame is still rendered after anything that can change the picture or clear the canvas
    // (settings, resize, weather / time, services on the current vehicle, outfit) — see invalidateBackdrop().
    // Online the world keeps running (not paused): the loop renders as usual.
    renderBackdrop() {
      if (!ui.menu.open) return true;
      if (backdropFrames > 0) { backdropFrames--; return true; }
      return false;
    },
    invalidateBackdrop(frames = 2) { backdropFrames = Math.max(backdropFrames, frames); },

    // other players on the radar and the big map: [{ x, z, color, heading (compass rad), label }]
    setPlayerBlips(list) { hud.setPlayerBlips(list); },
    // HUD extension slots: 'top-center' | 'top-right-under-money' | 'world-overlay' → unmount()
    mount: (slot, el) => hud.mount(slot, el),
    setWaypoint(w) {
      game.player.setWaypoint(w);
      hud.waypoint = w;
      if (w) ui.feed({ kind: 'gps', text: t('notify.waypointSet', { name: game.world3d?.areaAt?.(w.x, w.z)?.name ?? hud.areaAt(w.x, w.z).name }), seconds: 2.5 });
      else ui.feed({ kind: 'gps', text: t('notify.waypointCleared'), seconds: 2 });
    },
    teleport(x, z, name) {
      if (game.can && !game.can('teleport')) return; // singleplayer only
      game.player.teleport(x, z);
      ui.close();
      ui.feed({ kind: 'gps', text: t('notify.teleported', { name: name || hud.areaAt(x, z).name }) });
    },

    update(dt) {
      const inp = game.input;
      const menu = ui.menu;
      if (inp.pressed('Escape') || inp.gpPressedBtn(GP.START)) { if (menu.modal) menu.closeModal(false); else if (menu.open) ui.close(); else ui.open(); }
      else if (inp.pressed('KeyM') || (!menu.open && inp.gpPressedBtn(GP.BACK))) { if (menu.open && menu.tab.id === 'map') ui.close(); else ui.open('map'); }
      if (menu.open) { menu.update(dt); return; }
      if (inp.pressed('KeyU')) hud.setVisible(!hud.visible);
      if (inp.pressed('F3')) game.applySetting('showFps', !game.settings.showFps);
      stats.update(dt);
      const p = game.player;
      hud.route = p.route;
      hud.waypoint = p.waypoint;
      const sim = ui.simulate;
      const v = p.mode === 'vehicle' ? p.controllable : null;
      const kind = sim?.kind ?? v?.kind ?? null;
      const tel = sim?.telemetry ?? v?.telemetry;
      const f = p.focus;
      const s = {
        x: f.x, z: f.z, heading: -p.heading, compass: (p.heading * 180) / Math.PI, clock: game.sky?.clock ?? '',
        fps: `${game.fps} FPS · ${Math.round((game.render?.scale ?? 1) * 100)}%`,
        health: norm(p.health, p.maxHealth), armor: norm(p.armor, p.maxArmor), boost: tel?.boost ?? 1, money: game.economy?.money ?? p.money ?? 0,
        units: game.settings.units, speedKmh: tel?.speedKmh ?? 0, view: null, radarAlt: 0, blips,
        veh: null, tank: kind === 'tank' || v?.catalogId === 'tank' || !!v?.turret,
        // Physics debounces upsideDown for 1.5 s at low speed; airborne tricks do not trigger the hint.
        recoveryHelp: !!(tel?.upsideDown && kind && kind !== 'plane' && kind !== 'heli' && kind !== 'boat'
          && p.mode === 'vehicle' && !(p.wastedT > 0) && p.health > 0 && !v?.drowned && !v?.damage?.destroyed),
      };
      const dmg = sim?.damage ?? v?.damage;
      if (dmg) s.veh = { engine: dmg.engine ?? 1, body: dmg.body ?? 1, burning: dmg.burning ?? dmg.state === 'burning' };
      if (kind === 'heli' || kind === 'plane') {
        s.view = 'air';
        s.air = airState(game, v, tel || {}, kind);
        s.radarAlt = Math.max(0, s.air.alt);
        if (tel?.heading !== undefined) s.compass = tel.heading;
      } else if (kind === 'boat') {
        s.view = 'boat';
        s.boat = { spd: tel?.speedKmh ?? 0, thr: (tel?.throttle ?? 0) * (tel?.gear < 0 ? -1 : 1), anchor: !!tel?.anchor };
      } else if (tel) {
        s.view = 'land';
        s.land = { speedKmh: tel.speedKmh ?? 0, gear: tel.gear ?? 0, rpmFrac: (tel.rpm ?? 0) / (tel.maxRpm || 7000), drift: tel.drifting };
      }
      if (p.mode === 'free') s.radarAlt = Math.max(0, game.camera.position.y - Math.max(0, game.terrain.heightAt(f.x, f.z)));
      if ((blipT -= dt) <= 0) { blipT = 0.25; blips = collectBlips(game); }
      hud.update(dt, s);
    },
  };
  game.ui = ui;
  ui.menu = new Menu(container, ui, game, mapImage);

  thumbs.onReady((id) => { if (id === pendingThumb && hud.vnameTimer > 0) { hud.setVehicleThumb(thumbs.get(id)); pendingThumb = null; } });
  hud.onRadarClick(() => ui.open('map'));
  hud.onMenuButton(() => ui.open());
  hud.setFps(!!game.settings.showFps);
  game.onSetting('showFps', (v) => hud.setFps(v));
  const applyHudScale = (v) => document.documentElement.style.setProperty('--hud-scale', String(v || 1));
  applyHudScale(game.settings.hudScale);
  game.onSetting('hudScale', applyHudScale);

  i18n.onChange(() => {
    hud.render();
    if (modeKey) hud.setMode(t(modeKey));
    if (ui._langNotice) ui.feed({ kind: 'settings', icon: 'globe', text: t('notify.lang', { name: i18n.language.name }) });
    ui._langNotice = false;
  });
  game.events.on('money:pickup', (e) => hud.moneyPop(e?.amount ?? 0));
  game.events.on('economy:combo', (e) => hud.setCombo(e?.combo ?? 1));
  game.events.on('tank:reload', (e) => hud.tankReload(e || {}));
  game.events.on('vehicle:enter', (e) => {
    const v = e?.vehicle;
    if (!v || v !== game.player.controllable) return;
    const entry = game.vehicles?.byId?.get?.(v.catalogId) || { id: v.catalogId, kind: v.kind };
    ui.showVehicleName(v.name || entry.name || v.catalogId || '', t(`cat.${categoryOf(entry)}`));
  });
  game.events.on('start', () => {
    // touch screens: no Esc / M keys — the ☰ button and a tap on the radar (mobile strings, src/mobile/strings.js)
    const touch = document.body.classList.contains('is-mobile');
    ui.toast(t('msg.welcome'), touch ? t('mobile.welcomeSub', { default: t('msg.welcomeSub') }) : t('msg.welcomeSub'), 5);
    ui.showHelp(t('msg.help'), 12);
    applyFallbacks(game);
    // every module is attached now: build the menu tabs in idle time (first open / first tab visit = show only)
    ui.menu.started = true;
    ui.menu.scheduleIdle();
  });
  // re-render the frozen backdrop after anything that changes the picture (or clears the canvas) while paused
  for (const ev of ['setting', 'quality', 'vehicle:service', 'wardrobe:outfit', 'world:clearWrecks', 'ui:purchase', 'gravity']) {
    game.events.on(ev, () => { if (ui.menu.open) ui.invalidateBackdrop(); });
  }
  window.addEventListener('resize', () => { if (ui.menu.open) ui.invalidateBackdrop(3); });
  // low-end devices: no backdrop blur behind the menu (full-screen blur over the WebGL canvas is the costliest
  // compositor effect of the menu); mobile / low quality / ≤ 4 cores / ≤ 4 GB
  const lite = () => !!(game.mobile?.active || document.body.classList.contains('is-mobile') || game.render?.profile?.name === 'low'
    || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 4));
  const applyLite = () => ui.menu.el.classList.toggle('lite', lite());
  applyLite();
  game.events.on('start', applyLite);
  game.events.on('quality', applyLite);
  game.onSetting('quality', () => setTimeout(applyLite, 0));
  return ui;
}

// Settings migrations (stored in localStorage by Game.applySetting).
// v2: quiet music (10 %). v3: music 5 %, ambience 45 % (values still at an old default were never chosen by the player).
function migrateSettings(game) {
  const s = game.settings;
  const v = s.v ?? 0;
  if (v >= 3) return;
  if (s.volMusic == null || s.volMusic === 0.1 || v < 2) game.applySetting('volMusic', 0.05);
  if (s.volAmbient == null || s.volAmbient === 0.8 || s.volAmbient === 1) game.applySetting('volAmbient', 0.45);
  game.applySetting('v', 3);
}

const norm = (v, max) => {
  if (v === undefined || v === null) return 0;
  const m = max ?? (v > 1.5 ? 100 : 1);
  return Math.max(0, Math.min(1, v / m));
};

function airState(game, v, tel, kind) {
  const body = v?.body;
  const pos = body?.translation?.();
  const vel = body?.linvel?.();
  const ground = pos ? Math.max(0, game.terrain.heightAt(pos.x, pos.z)) : 0;
  const alt = tel.altitude ?? (pos ? pos.y - ground : 0);
  const vs = tel.verticalSpeed ?? vel?.y ?? 0;
  let gear = tel.gearDown;
  if (gear === undefined && (tel.gear === 'down' || tel.gear === 'up')) gear = tel.gear === 'down';
  if (gear === undefined && typeof tel.gear === 'boolean') gear = tel.gear;
  return {
    spd: tel.airspeedKmh ?? tel.airspeed ?? tel.speedKmh ?? (vel ? Math.hypot(vel.x, vel.y, vel.z) * 3.6 : 0),
    alt, vs, thr: tel.throttle ?? tel.collective ?? 0, gear, flaps: tel.flaps, stall: !!tel.stall,
    pullUp: kind === 'plane' && alt < 80 && vs < -12 && !tel.landed,
  };
}

function collectBlips(game) {
  const out = [];
  const own = game.player.controllable;
  for (const v of game.vehicles?.active || []) {
    if (v === own || v.occupied || v.destroyed || !v.body) continue;
    const t = v.body.translation();
    out.push({ x: t.x, z: t.z, color: '#5cc0ff' });
    if (out.length >= 10) break;
  }
  return out;
}

// Settings that have no owner yet: applied directly when no module registered a handler (see INTEGRATION.md).

function applyFallbacks(game) {
  const s = game.settings;
  const vols = { master: s.volume, music: s.volMusic, sfx: s.volSfx, ambient: s.volAmbient, engine: s.volEngine, ui: s.volUi };
  for (const [bus, v] of Object.entries(vols)) if (v !== undefined) game.audio?.setVolume?.(bus, v);
  if (!hasHandler(game, 'timeScale') && s.timeScale && game.sky) {
    game.sky._baseTimeScale ??= game.sky.timeScale;
    game.sky.timeScale = game.sky._baseTimeScale * s.timeScale;
  }
  if (!hasHandler(game, 'resScale') && s.resScale && !s.autoRes && game.render) { game.render.scale = s.resScale; game.render.resize?.(); }
  for (const [key, obj] of [['traffic', game.traffic], ['peds', game.peds]]) {
    if (hasHandler(game, key) || !obj || s[key] === undefined) continue;
    obj._baseMax ??= obj.max;
    obj.max = Math.round(obj._baseMax * Math.min(1, s[key]));
  }
}
