// Cartography facade (workstream H): vector map for the HUD radar and the pause-menu map.
//
//   game.cartography = await createCartography(game, { data });   // data = loadWorldData() result (optional)
//   cartography.drawRadar(ctx, w, h, s, dt)                       // from Hud.drawRadar
//   const fm = cartography.createFullMap(el, { onTeleport, onWaypoint, onClear }) // from MapTab
//   fm.show({ x, z }); fm.update(dt, game.input); fm.hide(); fm.destroy();
//   cartography.setPlayers([{ id, x, z, heading, color, name }])  // multiplayer (J)
//
// See src/map/INTEGRATION.md.
import { REGIONS } from '../world/regions.js';
import { fetchMapBuffer, parseMapBuffer, gunzipIfNeeded } from './mapData.js';
import { TilePool } from './tiles.js';
import { Radar } from './Radar.js';
import { FullMap } from './FullMap.js';
import { CATEGORIES } from './poi.js';
import { makeT } from './strings.js';

const BASE = `${import.meta.env?.BASE_URL ?? '/'}data/`;
// same per-build cache-buster as src/core/data.js (map.bin is rebuilt with the road data)
const MAP_V = typeof __APP_BUILD__ !== 'undefined' && __APP_BUILD__ !== 'dev' ? `?v=${__APP_BUILD__}` : ''; // eslint-disable-line no-undef

async function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  const fonts = ['400 12px Oswald', '500 12px Oswald', '400 20px "Russo One"'];
  await Promise.race([
    Promise.all(fonts.map((f) => document.fonts.load(f).catch(() => null))),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
}

async function loadWorld(data) {
  if (data?.world) return data.world;
  const r = await fetch(`${BASE}world.json`);
  return await r.json();
}

async function loadHeights(data) {
  if (data?.heights) return data.heights;
  try {
    const r = await fetch(`${BASE}height.bin`);
    return new Int16Array(await gunzipIfNeeded(await r.arrayBuffer()));
  } catch { return null; }
}

export async function createCartography(game, { data = null, url = `${BASE}map.bin${MAP_V}`, workers, useWorkers = true } = {}) {
  const t0 = performance.now();
  const [buffer, world, heights] = await Promise.all([fetchMapBuffer(url), loadWorld(data ?? (game?.worldData ? { world: game.worldData } : null)), loadHeights(data), loadFonts()]);
  const map = parseMapBuffer(buffer, { sets: ['st', 'rt'] }); // the main thread only needs label / shield paths
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  // weak devices (few cores / little memory / phones): smaller tile caches (each tile ≈ 1 MB of image memory)
  const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory || 8 : 8;
  const lowEnd = !!game?.mobile?.device?.lowEnd || mem <= 4 || hc <= 4;
  const pool = new TilePool({
    buffer, bounds: world.bounds, dpr: { map: dpr, radar: dpr },
    maxTiles: lowEnd ? { map: 30, radar: 16 } : { map: 48, radar: 24 },
    relief: heights ? { heights, gw: world.gw, gh: world.gh, hs: world.hs } : null,
    workers: workers ?? Math.max(1, Math.min(3, Math.floor(hc / 2) - 1)), useWorkers,
  });
  await pool.ready;
  // coarse overview of the whole state (16 m/px, 6 tiles) kept cached: instant placeholder for any view while the
  // sharp tiles render, so the main thread never has to draw vector content during fast pans / flings far out
  pool.pin('map', 16);
  const t = makeT(game);

  const carto = {
    game, map, pool, t, world,
    bounds: world.bounds,
    regions: REGIONS,
    players: [],
    playersVersion: 0,
    fullMaps: new Set(),
    loadMs: 0,

    drawRadar(ctx, w, h, s, dt) {
      if (langHooked !== game?.i18n) hookLang();
      radar.draw(ctx, w, h, s, dt);
    },

    createFullMap(containerEl, opts = {}) {
      if (langHooked !== game?.i18n) hookLang();
      const fm = new FullMap(carto, containerEl, opts);
      carto.fullMaps.add(fm);
      fm.hide();
      return fm;
    },

    // remote players: [{ id, x, z, heading (compass radians, 0 = north), color, name }]
    setPlayers(list) {
      carto.players = Array.isArray(list) ? list : [];
      carto.playersVersion++;
    },

    playersOn() { return game?.settings?.mapPlayers !== false; },
    savePlayers(on) {
      if (game?.applySetting) game.applySetting('mapPlayers', !!on);
      else if (game?.settings) game.settings.mapPlayers = !!on;
      for (const fm of carto.fullMaps) { fm.dirty = true; fm.renderCats(); }
    },

    poiSettings() {
      const v = game?.settings?.mapPoi;
      const cats = Array.isArray(v?.cats) ? v.cats.filter((c) => CATEGORIES[c]) : Object.keys(CATEGORIES).filter((k) => CATEGORIES[k].on);
      return { on: v?.on !== false, cats };
    },
    savePoiSettings(on, cats) {
      const v = { on: !!on, cats: [...cats] };
      if (game?.applySetting) game.applySetting('mapPoi', v);
      else if (game?.settings) game.settings.mapPoi = v;
    },

    // { name, sub } of the area at a world point
    areaAt(x, z) {
      const a = game?.world3d?.areaAt?.(x, z);
      if (a) return a;
      let best = null, bd = Infinity;
      for (const pass of ['d', 'a']) {
        for (const d of world.districts) {
          if (d.type !== pass) continue;
          const k = Math.hypot(x - d.x, z - d.z) / d.r;
          if (k < 1 && k < bd) { bd = k; best = { name: d.name, sub: pass === 'd' ? d.area : 'Leonida' }; }
        }
        if (best) return best;
      }
      for (const r of REGIONS) {
        const k = Math.hypot(x - r.x, z - r.z) / r.r;
        if (k < 1 && k < bd) { bd = k; best = { name: r.name, sub: r.sub }; }
      }
      return best || { name: 'Leonida', sub: 'State of Leonida' };
    },

    stats() {
      return {
        radar: { ...radar.stats, avgMs: radar.stats.ms / Math.max(1, radar.stats.frames) },
        tiles: { ...pool.stats, avgMs: pool.stats.ms / Math.max(1, pool.stats.rendered), cachedMB: pool.memoryMB(), workers: pool.workers.length },
      };
    },

    dispose() {
      for (const fm of [...carto.fullMaps]) fm.destroy();
      pool.dispose();
    },
  };
  const radar = new Radar(carto);
  carto.radar = radar;
  pool.onTile = (style) => { if (style === 'map') for (const fm of carto.fullMaps) fm.tileArrived = true; };
  // i18n may appear after the cartography (created by the UI): hook it on first use
  let langHooked = null;
  const refreshLang = () => {
    const n = game?.i18n?.t?.('dir.N', { default: 'N' });
    radar.northLabel = !n || n === 'dir.N' ? 'N' : n;
    for (const fm of carto.fullMaps) fm.renderTexts();
  };
  const hookLang = () => {
    langHooked = game?.i18n || null;
    t('teleport'); // registers the 'carto' namespace
    langHooked?.onChange?.(refreshLang);
    refreshLang();
  };
  hookLang();
  carto.loadMs = performance.now() - t0;
  return carto;
}
