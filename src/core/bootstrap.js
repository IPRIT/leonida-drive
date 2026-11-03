import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from './Game.js';
import { InputManager } from './input.js';
import { loadWorldData, MAP_IMAGE_URL } from './data.js';
import { Renderer } from './Renderer.js';
import { Terrain } from '../world/Terrain.js';
import { Sky } from '../world/Sky.js';
import { Water } from '../world/Water.js';
import { Roads } from '../world/Roads.js';
import { Buildings } from '../world/Buildings.js';
import { prepareWorld } from '../world/prepareWorld.js';
import { Vegetation, Lamps } from '../world/Vegetation.js';
import { createParks } from '../world/Parks.js';
import { Traffic } from '../world/Traffic.js';
import { Pedestrians } from '../characters/Pedestrians.js';
import { PlayerController } from '../characters/index.js';
import { VEHICLE_CATALOG, initHeadlightPool, bakeVehicle, createThumbnails } from '../vehicle/index.js';
import { airModule } from '../air/index.js';
import { FX } from '../fx/FX.js';
import { DamageSystem } from '../damage/DamageSystem.js';
import { Weather } from '../weather/Weather.js';
import { patchWorldMaterials } from '../weather/wetMaterial.js';
import { AudioSystem } from '../audio/AudioSystem.js';
import { createCartography } from '../map/Cartography.js';
import { createMobile } from '../mobile/index.js';
import { createLife } from '../life/index.js';
import { createEconomy, economyModule } from '../economy/index.js';
import { createLandmarksAsync } from '../landmarks/index.js'; // evaluated before Roads: installs the airside / runway hooks
import { patchFakeLights, patchFakeLightsDeep } from '../world/fakeLights.js';
import { LampLightMap } from '../world/LampLightMap.js';
import { humanMaterials } from '../characters/index.js';
import { Areas } from '../world/areas.js';
import { Streaming } from '../world/Streaming.js';
import { VehicleManager } from '../world/VehicleManager.js';
import { Score } from '../world/Score.js';
import { BasicPlayer, roadSpawn } from './BasicPlayer.js';
import { GROUPS, groups } from '../vehicle/groups.js';
import { hornKeyModule } from './hornKey.js';
import { installRapierGuards } from './rapierGuards.js';

const DEFAULT_SETTINGS = {
  quality: 'auto', autoRes: true, drawDist: 1, timeMode: 'cycle', timeScale: 1, assists: true, units: 'kmh',
  showFps: false, volume: 0.8, lang: 'auto', traffic: 1, peds: 1, weather: 'auto',
};

// Creates the whole game. See docs/ARCHITECTURE.md for the `game` context.
export async function createGame(container, options = {}) {
  const game = new Game();
  game.options = options;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('leonida.settings') || '{}'); } catch { /* ignore */ }
  game.settings = { ...DEFAULT_SETTINGS, ...saved, ...(options.settings || {}) };
  // UI is loaded dynamically so labs (noUI) don't depend on it
  const uiMod = options.noUI ? null : await import('../ui/index.js');
  const loading = options.autostart || !uiMod ? null : uiMod.showLoading(container);
  let worldReady;
  try {
    const [data, mapImage] = await Promise.all([
      loadWorldData((p) => loading?.progress(p * 0.8)),
      loadImage(MAP_IMAGE_URL),
      RAPIER.init(),
    ]);
    installRapierGuards(RAPIER, { dev: import.meta.env.DEV }); // stale body/collider access must not poison the wasm world
    game.worldData = data.world;
    game.mapImage = mapImage;
    worldReady = prepareWorld(data, { enabled: !new URLSearchParams(location.search).has('noworldworkers') });
    loading?.progress(0.85);
    await nextFrame();

    // ---------- rendering ----------
    const render = new Renderer(container);
    render.attach(game); // game.quality = render.profile (budgets for world modules)
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 40000);
    render.setScene(scene, camera);
    Object.assign(game, { RAPIER, scene, camera, render, renderer: render.renderer });
    game.input = new InputManager(render.renderer.domElement);
    game.input.shouldLock = () => !game.paused && !game.ui?.isOpen && !game.mobile?.active;

    // ---------- world ----------
    game.terrain = new Terrain(data, scene);
    game.sky = new Sky(scene, render.renderer, game);
    game.water = new Water(scene, game.terrain, game.sky);
    game.roads = new Roads(data, game.terrain, scene, await worldReady.roads);
    loading?.progress(0.9);
    await nextFrame();
    game.buildings = new Buildings(data, game.terrain, scene, await worldReady.buildings);
    loading?.progress(0.95);
    await nextFrame();
    game.veg = new Vegetation(data, game.terrain, scene, game.settings.drawDist);
    if (game.buildings.lampsOutside) game.roads.lamps = game.buildings.lampsOutside(game.roads.lamps); // no poles inside buildings
    game.parks = await createParks(game, data); // parks: paths, props, trees, lamps (before Lamps: park lamps join them)
    game.lamps = new Lamps(game.roads, scene);
    // no trees growing out of tunnel galleries
    for (const t of game.roads.tunnels || []) {
      for (let k = 0; k < t.n; k += 2) {
        for (const sc of Object.values(game.veg.scatters)) for (const id of sc.near(t.pts[2 * k], t.pts[2 * k + 1], t.w / 2 + 5)) sc.hidden.add(id);
      }
    }
    game.world3d = new Areas(data.world);
    patchWorldMaterials(game);
    const cartoReady = options.noUI ? Promise.resolve(null) : createCartography(game, { data }).catch((e) => { console.warn('[map] cartography disabled', e); return null; });

    // ---------- physics ----------
    game.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    game.world.timestep = 1 / 60;
    // a few more solver iterations: heavy crashes don't push bodies through thin road / terrain surfaces
    if (game.world.integrationParameters) game.world.integrationParameters.numSolverIterations = 6;
    game.eventQueue = new RAPIER.EventQueue(true);
    game.groups = { GROUPS, groups };
    await createLandmarksAsync(game); // sliced over frames; airports, stadiums, towers, lighthouses… (before economy / life / prewarm)
    // map footprints standing on a drawn carriageway go (after the landmarks claimed theirs, before life / economy
    // place props against the buildings)
    try {
      game.buildings.removeOnRoads?.(game.roads, game.landmarks?.hidden);
      game.buildings.removeUnderLandmarks?.(game.landmarks?.colliders?.items); // footprints poking into landmark models
    } catch (e) { console.warn('[buildings] road / landmark filter', e); }

    // ---------- actors ----------
    game.vehicles = new VehicleManager(game);
    game.register(game.vehicles, 10);
    initHeadlightPool(scene);
    game.vehicles.addCatalog(VEHICLE_CATALOG);
    airModule(game);
    const q = game.quality || {};
    if (!options.noTraffic) {
      game.traffic = new Traffic({ scene, roads: game.roads, terrain: game.terrain, RAPIER, world: game.world, collisionGroups: groups(GROUPS.TRAFFIC, GROUPS.VEHICLE | GROUPS.CHARACTER | GROUPS.TRAFFIC), max: q.trafficMax ?? 56, game });
      game.traffic.setCatalog(VEHICLE_CATALOG, bakeVehicle);
    }
    if (!options.noPeds) game.peds = new Pedestrians({ scene, roads: game.roads, terrain: game.terrain, max: q.pedsMax ?? 170, game });

    // ---------- player ----------
    // economy + spawn slots: everyone starts in Ocean Beach at a random free kerb slot (singleplayer: the saved
    // position), in the starter car or the last owned land vehicle (docs/ECONOMY.md -> Spawning)
    const { plan } = createEconomy(game);
    const sp = options.spawn ? roadSpawn(game, options.spawn.x, options.spawn.z) : plan.pos || roadSpawn(game, 1728, -733);
    const makePlayer = options.createPlayer || (options.basicPlayer ? (g, p) => new BasicPlayer(g, p) : (g, p) => new PlayerController(g, p));
    game.player = makePlayer(game, sp);
    game.register(game.player, 0);
    const first = game.vehicles.spawn(options.vehicle || plan.vehicle || 'comet', sp, sp.yaw, {});
    game.player.enter(first);
    game.spawnForPlayer = (id, opts = {}) => {
      const cur = game.player.controllable;
      const base = cur ? cur.body.translation() : game.player.focus;
      const yaw = cur ? Math.atan2(-new THREE.Vector3(0, 0, -1).applyQuaternion(cur.object3d.quaternion).x, -new THREE.Vector3(0, 0, -1).applyQuaternion(cur.object3d.quaternion).z) : 0;
      const p = { x: base.x, y: Math.max(game.terrain.heightAt(base.x, base.z), 0) + 0.3, z: base.z };
      if (cur && game.player.mode === 'vehicle') game.vehicles.despawn(cur);
      const v = game.vehicles.spawn(id, p, yaw, opts);
      game.player.enter(v);
      game.ui?.showVehicleName?.(v.name || id, '');
      return v;
    };
    // damage, fire, destruction + effects (attach to the vehicles that already exist)
    game.fx = new FX(game);
    game.register(game.fx, game.fx.order ?? 60);
    game.damage = new DamageSystem(game);
    if (!game.modules.includes(game.damage)) game.register(game.damage, game.damage.order ?? 55);
    game.events.on('camera:shake', ({ amount }) => (game.player?.chase ?? game.player?.camera)?.shake?.(amount));
    // weather drives sky / water / wet materials; online it follows the server clock
    game.weather = new Weather(game);
    game.register(game.weather, 40);
    game.thumbnails = createThumbnails(game);
    // street lamps / signals light people, cars and facades (fake local lights, no real light objects)
    const hm = humanMaterials();
    patchFakeLights(hm.human);
    patchFakeLights(game.buildings.material, { strength: 0.6 });
    for (const v of game.vehicles.active || []) patchFakeLightsDeep(v.object3d);
    game.events.on('vehicle:spawn', (e) => patchFakeLightsDeep(e?.vehicle?.object3d));
    // knocked-down lamps go dark (pole, glow sprite and the pool on the road)
    game.lamps.deadMat = game.damage?.brokenLampMat;
    game.lampMap = new LampLightMap(render.renderer, game.lamps, game.traffic ? () => game.traffic.lights.signalHeads() : null);
    game.lamps.onBreak = () => game.lampMap.invalidate();
    game.streaming = new Streaming(game);
    game.register(game.streaming, 5);
    game.streaming.run(true);

    // ---------- UI ----------
    game.ui = uiMod ? uiMod.createUI(game, { container, mapImage }) : stubUI(game);
    game.cartography = await cartoReady;
    if (!options.noAudio) {
      game.audio = new AudioSystem(game);
      game.register(game.audio, game.audio.order ?? 90);
    }
    if (!options.noLife) {
      const life = await createLife(game);
      if (life && !game.modules.includes(life)) game.register(life, life.order ?? 70);
    }
    if (!options.noMobile) {
      const mob = await createMobile(game);
      if (mob && !game.modules.includes(mob)) game.register(mob, mob.order ?? 95);
    }

    game.score = game.register(new Score(game), 60);
    economyModule(game); // game.jobs: depots, export yards, body shops
    game.register(hornKeyModule(game), 1);

    // settings handlers
    game.onSetting('quality', (v) => render.setQuality(v));
    game.onSetting('drawDist', (v) => { for (const sc of Object.values(game.veg.scatters)) sc.radius = sc.baseRadius * v; });
    game.onSetting('timeMode', (v) => { game.sky.paused = v === 'freeze'; });
    game.onSetting('hour', (v) => game.sky.setTime(v, { smooth: true }));
    // weather / time controls from the sandbox panel (online the server drives both, see src/net)
    const applyWeather = (v) => {
      if (!game.weather || !game.can('weather')) return;
      if (!v || v === 'auto') game.weather.setAuto(true);
      else { game.weather.setAuto(false); game.weather.set(v, 8); }
    };
    game.onSetting('weather', applyWeather);
    if (game.settings.weather && game.settings.weather !== 'auto') applyWeather(game.settings.weather);
    const baseTimeScale = game.sky.timeScale;
    game.onSetting('timeScale', (v) => { if (game.can('timeScale')) game.sky.timeScale = baseTimeScale * (v || 1); });
    if (game.can('timeScale') && game.settings.timeScale) game.sky.timeScale = baseTimeScale * game.settings.timeScale;
    game.onSetting('assists', (v) => { const c = game.player.controllable; if (c?.assists) c.assists = { abs: v, tcs: v, esc: v, steerAssist: v }; });
    for (const sc of Object.values(game.veg.scatters)) sc.baseRadius = sc.radius;
    if (!game.mobile?.active || game.settings.quality !== 'auto') render.setQuality(game.settings.quality);

    // ---------- extra modules ----------
    for (const make of options.modules || []) {
      const m = await make(game);
      if (m && !game.modules.includes(m)) game.register(m, m.order ?? 50);
    }

    // compile and first-draw every shader program while loading, so nothing compiles during play (no hitches): one
    // vehicle of every kind, the whole scene + post variants, FX, the night lamp map; programs are then kept alive by
    // the renderer for the session (Renderer.pinPrograms), so despawning never throws them away
    loading?.progress(0.97);
    const tPre = performance.now();
    // one traffic model exists, so the shared traffic material (and its instanced shadow variant) is compiled too
    try { if (game.traffic && !game.traffic.types.length && game.traffic.typeDefs?.length) game.traffic.getType(game.traffic.typeDefs[0].name); } catch (e) { console.warn('[traffic] prewarm', e); }
    const steps = (game.prewarmSteps = {});
    const mark = (k, t) => { steps[k] = Math.round(performance.now() - t); return performance.now(); };
    let t = performance.now();
    let samples = null;
    try { samples = game.vehicles.prewarmKinds?.(); } catch (e) { console.warn('[vehicles] prewarm', e); }
    t = mark('vehicles', t);
    render.prewarm?.();
    t = mark('compile', t);
    await render.settle?.(6000); // programs link in parallel in the GPU process (a draw now would wait for each in turn)
    t = mark('link', t);
    game.fx?.prewarm?.(render.renderer, camera);
    t = mark('fx', t);
    render.prewarmDraw?.(samples?.objects); // first draw of everything: GPU pipelines, uniform tables, shadow variants
    samples?.dispose();
    game.lampMap?.prewarm?.(); // night-only pass (street-lamp pools): compiled now, not at dusk
    game.peds?.prewarm?.(game.player?.focus); // crowd spawn candidates around the start point
    render.render(); // one full frame: post passes, sky probe, first uniform uploads
    mark('draw', t);
    game.prewarmTotalMs = performance.now() - tPre;
    game.loadMs = performance.now(); // ms since navigation start until the world is ready (perf harness)
    loading?.progress(1);
    // traffic models: built while the PLAY button waits and then in idle time (never in a busy frame), not in the frame
    // that first picks one (bake + instanced buffers, 3-6 ms each)
    const ric = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 40));
    const idleBake = (dl) => { if (game.traffic?.prebake?.(Math.min(40, dl.timeRemaining() - 1))) ric(idleBake); };
    ric(idleBake);
    // the player's garage: car designs generated while PLAY waits, not in the first spawn of each
    game.vehicles?.prewarmDesigns?.(game.economy?.ownedList?.() || []);
    // side studios (vehicle thumbnails, wardrobe figure): compiled and drawn once while the PLAY button waits, not on the
    // first garage / wardrobe visit (a quick click waits for them, at most 1.5 s)
    let studiosDone = false;
    Promise.all([
      game.thumbnails?.prewarm?.(first.catalogId),
      options.noUI ? null : import('../characters/preview.js').then((m) => m.prewarmCharacterPreview?.(render.renderer)),
    ]).catch((e) => console.warn('[render] studio prewarm', e)).finally(() => { studiosDone = true; });
    if (loading) await loading.waitStart(() => { game.audio?.start?.(); if (game.input.shouldLock()) game.input.lockPointer(); });
    else game.audio?.start?.();
    await render.until?.(1500, () => studiosDone);
    // let the GPU process drain everything queued while loading: the first frames' sync queries would wait for it
    try { render.renderer.getContext().finish(); } catch { /* lost context */ }
    game.events.emit('start', {});
    startLoop(game);
    window.__leonida = game;
    return game;
  } catch (e) {
    worldReady?.dispose();
    console.error(e);
    loading?.error(String(e?.stack || e));
    throw e;
  }
}

function startLoop(game) {
  const clock = new THREE.Clock();
  const STEP = 1 / 60;
  let acc = 0;
  let backdropAcc = 1;
  let fpsAcc = 0, fpsN = 0;
  game.fps = 0;
  const { world, eventQueue } = game;
  game.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { game.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    game.input.update();
    game.frame++;
    if (game.paused) {
      game.ui.update(dt);
      // pause menu over a frozen world: the canvas keeps its last frame unless the UI asks for a refresh
      if (game.ui.renderBackdrop?.() !== false) game.render.render();
      return;
    }
    const scale = game.timeScale ?? 1; // slow motion (wasted, explosions)
    game.time += dt * scale;
    game.uniforms.uTime.value = game.time;
    acc += dt * scale;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      game.fixedUpdate(STEP);
      game.traffic?.fixedUpdate(STEP);
      world.step(eventQueue);
      game.traffic?.postStep();
      drainEvents(game);
      game.postStep(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === 5) acc = 0;
    const alpha = acc / STEP;
    game.update(dt, alpha);

    // world systems
    const { camera, sky, terrain } = game;
    const p = game.player;
    const pv = p.controllable && p.mode === 'vehicle' ? p.controllable.body : null;
    const playerInfo = pv ? { position: pv.translation(), velocity: pv.linvel() } : { position: p.focus, velocity: { x: 0, y: 0, z: 0 } };
    game.lateUpdate(dt);
    camera.updateMatrixWorld();
    sky.update(dt, p.focus);
    const camAlt = Math.max(0, camera.position.y - Math.max(0, terrain.heightAt(camera.position.x, camera.position.z)));
    // thinner haze from altitude (the whole island readable), but never below a floor that still turns the ocean
    // edge / far plane (40 km) into atmosphere: ~15 % haze at 10 km, ~95 % at 40 km. Without it the haze vanished
    // above ~1 km and the end of the world showed as a dark band under the horizon.
    const fogD = game.scene.fog.density;
    game.scene.fog.density = Math.max(fogD / (1 + camAlt / 250), Math.min(fogD, 4.2e-5));
    game.render.camAlt = camAlt;
    const night = sky.night;
    game.uniforms.uNight.value = night;
    terrain.update(camera, dt);
    game.water.update(dt, camera, night);
    game.roads.update(night, camera, game.settings.drawDist ?? 1);
    game.buildings.update(dt, night, camera);
    game.veg.update(camera, dt);
    game.lamps.update(camera, dt, night);
    game.lampMap?.update(camera, night, dt);
    game.lamps.syncBroken(dt, world, game.scene);
    game.traffic?.lights.syncBroken(dt, world, game.scene);
    game.traffic?.update(dt, p.focus, camera, playerInfo, game.peds?.positions);
    game.traffic?.updateVisual(alpha, dt, night);
    game.peds?.update(dt, p.focus, camera, playerInfo, night);
    if (game.render.grade) game.render.grade.uniforms.uNight.value = night;
    game.ui.update(dt);
    game.render.adapt(dt);
    // online the menu does not pause the world: simulation, physics and network keep their full rate, while the
    // world behind the menu is only redrawn at ~20 Hz (right away when the UI asks: settings, resize, outfit…)
    if (game.ui.isOpen) {
      backdropAcc += dt;
      const asked = game.ui.renderBackdrop?.() !== false;
      if (!asked && backdropAcc < 1 / 20) return;
      backdropAcc = 0;
    } else backdropAcc = 1;
    game.render.render();
  });
}

// Rapier contact-force events → game 'contact' event + built-in reactions (lamps, traffic crashes)
function drainEvents(game) {
  const { world, eventQueue } = game;
  const player = game.player;
  const pBody = player.controllable?.body;
  eventQueue.drainContactForceEvents((ev) => {
    const h1 = ev.collider1(), h2 = ev.collider2();
    const c1 = world.getCollider(h1), c2 = world.getCollider(h2);
    const force = ev.totalForceMagnitude();
    const d = ev.totalForce();
    const fl = Math.hypot(d.x, d.z) || 1;
    const payload = { c1, c2, h1, h2, force, dirX: d.x / fl, dirZ: d.z / fl };
    game.events.emit('contact', payload);
    // 'contact' listeners (traffic promotion, breakables) may remove a collider of this very event: check validity
    const parentOf = (c) => (c && c.isValid() ? c.parent() : null);
    const isPlayer = (c) => { const b = pBody && parentOf(c); return !!b && b.handle === pBody.handle; };
    const tr = game.traffic;
    if (tr && (tr.colliderMap.has(h1) || tr.colliderMap.has(h2))) {
      const lv = pBody ? pBody.linvel() : { x: 0, z: 0 };
      const spd = Math.hypot(lv.x, lv.z) || 1;
      const dir = { x: lv.x / spd, z: lv.z / spd };
      if (tr.colliderMap.has(h1)) tr.onContact(h1, isPlayer(c2), force, dir);
      if (tr.colliderMap.has(h2)) tr.onContact(h2, isPlayer(c1), force, dir);
    }
    for (const c of [c1, c2]) {
      const key = c?.userData?.tlight;
      if (key === undefined || !game.traffic) continue;
      const other = c === c1 ? c2 : c1;
      const ob = parentOf(other);
      if (!ob || ob.isFixed()) continue;
      const lv = ob.linvel();
      const spd = Math.hypot(lv.x, lv.z) || 1;
      const at = game.traffic.lights.breakLight(game.RAPIER, world, game.scene, key, { x: lv.x / spd, z: lv.z / spd }, groups(GROUPS.PROP, 0xffff), game.damage?.brokenLampMat);
      if (!at) continue;
      const st = game.damage?.byHandle?.get(ob.handle);
      if (st?.hasPrev && st.pl) { ob.setLinvel({ x: st.pl.x * 0.88, y: st.pl.y * 0.88, z: st.pl.z * 0.88 }, true); st.suppress = 2; }
      game.events.emit('lamp:broken', { position: { x: at.x, y: at.y + 3, z: at.z }, type: 'signal' });
      game.events.emit('impact', { position: { x: at.x, y: at.y + 1, z: at.z }, strength: 0.45, kind: 'prop', material: 'metal' });
    }
    for (const c of [c1, c2]) {
      const id = c?.userData?.lamp;
      if (id === undefined) continue;
      const other = c === c1 ? c2 : c1;
      const otherBody = parentOf(other);
      if (!otherBody || otherBody.isFixed()) continue;
      const lv = otherBody.linvel();
      const spd = Math.hypot(lv.x, lv.z) || 1;
      const t = c.translation();
      game.lamps.breakLamp(game.RAPIER, world, game.scene, id, { x: lv.x / spd, z: lv.z / spd }, groups(GROUPS.PROP, 0xffff));
      // snapping a lamp post barely slows a car down: restore the pre-impact velocity
      const st = game.damage?.byHandle?.get(otherBody.handle);
      if (st?.hasPrev && st.pl) {
        const keep = 0.9;
        otherBody.setLinvel({ x: st.pl.x * keep, y: st.pl.y * keep, z: st.pl.z * keep }, true);
        st.suppress = 2;
      }
      game.events.emit('lamp:broken', { position: { x: t.x, y: t.y, z: t.z }, type: 'lamp' });
      game.events.emit('impact', { position: { x: t.x, y: t.y + 1, z: t.z }, strength: 0.4, kind: 'prop', material: 'metal' });
    }
  });
  eventQueue.drainCollisionEvents(() => {});
}

// minimal UI for labs / headless checks
function stubUI(game) {
  const noop = () => {};
  return {
    isOpen: false, toast: noop, notify: noop, showHelp: noop, wasted: noop, setMode: noop, showVehicleName: noop,
    open() { game.paused = true; }, close() { game.paused = false; }, update: noop,
  };
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}
// yield to the browser; falls back to a timer when rAF is paused (hidden tab)
function nextFrame() {
  return new Promise((r) => {
    const t = setTimeout(r, 60);
    requestAnimationFrame(() => { clearTimeout(t); r(); });
  });
}
