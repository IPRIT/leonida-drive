// Characters lab: player on foot in Ocean Beach + pedestrians v2, with a debug panel.
import * as THREE from 'three';
import { createGame } from '/src/core/bootstrap.js';
import { PlayerController, BUILDS, createRemoteAvatars, WARDROBE, WARDROBE_SLOTS, DEFAULT_OUTFIT, createCharacterPreview } from './index.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
// the lab is a sandbox: default to single-player mode so debug/cheat controls work (game.can)
if (!params.has('mode')) { const u = new URL(location.href); u.searchParams.set('mode', 'single'); history.replaceState(null, '', u); }
const game = await createGame(app, {
  autostart: true,
  spawn: { x: Number(params.get('x') ?? 1745), z: Number(params.get('z') ?? -640) },
  // pedestrians come from bootstrap (same as the game), so the player shares their batch
  createPlayer: (g, sp) => new PlayerController(g, sp, { startOnFoot: true }),
  modules: [],
});
if (params.get('peds')) game.peds.max = Number(params.get('peds'));
if (params.get('hour')) game.sky.setTime(Number(params.get('hour')));
window.__lab = game;
// ---- wardrobe: random outfits, a preview panel (menu turntable), dressed remote players ----
function randomOutfit(rich = false) {
  const o = {};
  for (const slot of WARDROBE_SLOTS) {
    let l = WARDROBE.filter((it) => it.slot === slot);
    if (rich) l = l.filter((it) => it.tier === 'premium' || it.tier === 'luxury' || it.starter);
    const it = l[Math.floor(Math.random() * l.length)];
    o[slot] = { id: it.id, color: it.colors.length ? it.colors[Math.floor(Math.random() * it.colors.length)] : null };
  }
  return o;
}
let preview = null, previewYaw = 0.4;
function togglePreview() {
  if (preview) { preview.dispose(); preview = null; document.getElementById('pv')?.remove(); return; }
  const box = document.createElement('div');
  box.id = 'pv';
  box.style.cssText = 'position:fixed;left:10px;top:10px;width:300px;height:420px;z-index:60;border-radius:12px;background:radial-gradient(circle at 50% 35%, #3a2350, #120d1c 75%);box-shadow:0 8px 30px rgba(0,0,0,.5)';
  document.body.appendChild(box);
  preview = createCharacterPreview(game, box);
  preview.setOutfit(player.outfit);
  box.addEventListener('pointermove', (e) => { if (e.buttons) { previewYaw += e.movementX * 0.012; preview.rotate(previewYaw); } });
  box.addEventListener('dblclick', () => { box.dataset.v = box.dataset.v === 'face' ? 'body' : 'face'; preview.setView(box.dataset.v); });
}
game.events.on('player:outfit', ({ outfit }) => preview?.setOutfit(outfit));
window.__labTools = {
  randomOutfit: (rich) => player.setOutfit(randomOutfit(rich)), defaultOutfit: () => player.setOutfit(DEFAULT_OUTFIT), togglePreview: () => togglePreview(),
  previewYaw: (y) => preview?.rotate(y), previewView: (v) => preview?.setView(v), dressRemotes: () => dressRemotes(), carsOnSidewalks: (n) => carsOnSidewalks(n), creepCar: () => creepCar(), cruise: (o) => cruise(o), crowdStats: () => crowd.report() };

const peds = game.peds, player = game.player;
peds.debugJumps = true; // logs any per-frame jump > 0.5 m of a visible walking ped (console + peds.jumpStats)
// multiplayer avatars demo (workstream J API): fake remote players walking around the player
const remotes = createRemoteAvatars(game, { max: 64 });
const fake = [];
function spawnRemotes(n = 40) {
  const c = playerPos();
  const states = ['walk', 'run', 'idle', 'walk', 'jump', 'ragdoll', 'swim'];
  for (let i = 0; i < n; i++) {
    const id = `bot${fake.length}`;
    const h = remotes.add(id, { seed: 1000 + fake.length * 7919 });
    if (!h) break;
    fake.push({ h, cx: c.x, cz: c.z, r: 6 + Math.random() * 18, a: Math.random() * 6.28, st: states[i % states.length], w: 0 });
  }
}
function dressRemotes() { for (const f of fake) f.h.set({ outfit: randomOutfit(Math.random() < 0.4) }); }
function tickRemotes(dt) {
  for (const f of fake) {
    const sp = f.st === 'run' ? 4.5 : f.st === 'walk' ? 1.4 : f.st === 'swim' ? 1 : 0;
    f.a += (sp / f.r) * dt;
    f.w += dt;
    const x = f.cx + Math.cos(f.a) * f.r, z = f.cz + Math.sin(f.a) * f.r;
    const y = game.terrain.heightAt(x, z) + (f.st === 'jump' ? Math.abs(Math.sin(f.w * 2.5)) * 1.1 : 0);
    const state = f.st === 'jump' ? (Math.cos(f.w * 2.5) * Math.sin(f.w * 2.5) > 0 ? 'jump' : 'fall') : f.st;
    f.h.set({ x, y, z, yaw: Math.atan2(Math.sin(f.a), -Math.cos(f.a)) + (sp ? 0 : 1), speed: sp, state });
  }
  remotes.update(dt);
}
const panel = document.getElementById('panel');
const stats = document.getElementById('stats');

function playerPos() {
  const c = player.character.position;
  return { x: c.x, y: c.y, z: c.z };
}
function nearestPed(maxD = 60) {
  const p0 = playerPos();
  let best = null, bd = maxD;
  for (const p of peds.list) {
    if (p.state === 'ragdoll' || p.state === 'tumble') continue;
    const d = Math.hypot(p.x - p0.x, p.z - p0.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function knock(p, s = 9) {
  const p0 = playerPos();
  const dx = p.x - p0.x, dz = p.z - p0.z, n = Math.hypot(dx, dz) || 1;
  peds.knock(p, { x: (dx / n) * s, y: 3.5, z: (dz / n) * s }, 0.6, null);
}
// vehicles parked on the sidewalks around the player, right on the pedestrians' paths (avoidance test)
const labCars = [];
function carsOnSidewalks(n = 6) {
  const c = playerPos();
  const walkers = peds.list.filter((p) => p.mode === 'path' && p.e && Math.hypot(p.x - c.x, p.z - c.z) < 45);
  for (let i = 0, tries = 0; i < n && walkers.length && tries < 200; i++, tries++) {
    const p = walkers.splice(Math.floor(Math.random() * walkers.length), 1)[0];
    const q = peds.sidewalkPoint(p.e, Math.min(Math.max(p.s + p.dir * 7, 0), p.e.len), p.side, {});
    // not on top of anyone (a car dropped onto a ped is pushed out smoothly, but that is not what we test here)
    if (peds.list.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < 4.5) || Math.hypot(c.x - q.x, c.z - q.z) < 5) { i--; continue; }
    const across = i % 3 === 2;
    const yaw = Math.atan2(-q.tx, -q.tz) + (across ? Math.PI / 2 : 0);
    const v = game.vehicles.spawn(['comet', 'comet', 'comet'][i % 3], { x: q.x, y: q.y, z: q.z }, yaw);
    if (v) labCars.push(v);
  }
}
// a car creeping (~1.5 m/s) along the sidewalk through standing people: they step aside
let creeper = null;
function creepCar() {
  const p = peds.list.find((o) => o.mode === 'path' && o.e && Math.hypot(o.x - playerPos().x, o.z - playerPos().z) < 35);
  if (!p) return;
  const q = peds.sidewalkPoint(p.e, Math.min(Math.max(p.s - p.dir * 10, 0), p.e.len), p.side, {});
  const yaw = Math.atan2(-q.tx * p.dir, -q.tz * p.dir);
  const v = game.vehicles.spawn('comet', { x: q.x, y: q.y, z: q.z }, yaw);
  if (!v) return;
  for (const o of peds.list) if (Math.hypot(o.x - q.x, o.z - q.z) < 25 && o.state === 'walk') peds._setState(o, 'idle', 12);
  creeper = { v, t: 0, fx: -Math.sin(yaw), fz: -Math.cos(yaw) };
  labCars.push(v);
}
function tickCreeper(dt) {
  if (!creeper) return;
  const b = creeper.v.body;
  creeper.t += dt;
  if (creeper.t > 14 || !b?.isValid?.()) { creeper = null; return; }
  const lv = b.linvel();
  b.setLinvel({ x: creeper.fx * 1.5, y: lv.y, z: creeper.fz * 1.5 }, true);
}
// ---- street-crowd soak: "drive" the focus + camera along roads and measure where pedestrians are ----
// peds on the carriageway (outside crosswalks), max peds per 20 m cell, spawns per second
const FLYS = new Set(['ragdoll', 'tumble', 'dive', 'down', 'getup']);
const crowd = {
  t: 0, samples: 0, onRoad: 0, onRoadVis: 0, onRoadFly: 0, ids: new Set(), maxCell: 0, cellHist: {}, lastSpawned: null, rateMax: 0, rates: [],
  sample() {
    const R = game.roads, cells = new Map();
    this.samples++;
    for (const p of peds.list) {
      if (p.beach) continue;
      const k = Math.floor(p.x / 20) * 100003 + Math.floor(p.z / 20);
      cells.set(k, (cells.get(k) || 0) + 1);
      if (p.mode === 'cross' && p.cross?.go) continue; // on a crosswalk, crossing
      const n = R.nearest(p.x, p.z, 14);
      const hw = n ? (n.edge.wp ? n.edge.wp[n.seg] + (n.edge.wp[n.seg + 1] - n.edge.wp[n.seg]) * n.t : n.edge.w) / 2 : 0;
      const onRoad = (n && n.dist < hw - 0.35 && Math.abs(n.y - p.y) < 1.5) || R.inJunction(p.x, p.z, p.y - 0.1);
      if (!onRoad) continue;
      if (FLYS.has(p.state)) { this.onRoadFly++; continue; }
      this.onRoad++;
      if (p.vis) this.onRoadVis++;
      if (this.ids.size < 400) this.ids.add(`${p.id}:${p.state}/${p.mode}`);
    }
    for (const c of cells.values()) { this.maxCell = Math.max(this.maxCell, c); this.cellHist[c] = (this.cellHist[c] || 0) + 1; }
  },
  tick(dt) {
    this.t += dt;
    if (this.t < 0.25) return;
    this.t = 0;
    this.sample();
  },
  rate() { // spawns in the last second (Pedestrians.spawnStats when present, else list growth)
    const st = peds.spawnStats;
    const n = st ? st.total : peds.list.length;
    if (this.lastSpawned !== null) { const r = n - this.lastSpawned; this.rates.push(r); this.rateMax = Math.max(this.rateMax, r); }
    this.lastSpawned = n;
  },
  report() {
    const r = this.rates;
    return { samples: this.samples, onRoadPedSamples: this.onRoad, onRoadVisible: this.onRoadVis, onRoadKnockedDown: this.onRoadFly, examples: [...this.ids].slice(0, 12),
      maxPerCell20m: this.maxCell, cellHist: this.cellHist, spawnPerSecMax: this.rateMax, spawnPerSecAvg: r.length ? +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(2) : 0,
      spawnHist: r.reduce((h, x) => { h[x] = (h[x] || 0) + 1; return h; }, {}), peds: peds.list.length, ms: +peds.stats.ms.toFixed(2) };
  },
};
setInterval(() => crowd.rate(), 1000);
let cruiser = null;
// random drive along lit roads at `speed` m/s (focus + chase camera); the player stays where it is
function cruise({ speed = 14, seconds = 120 } = {}) {
  const R = game.roads;
  const ok = (e) => e.lit && e.kind !== 1 && !e.internal && e.len > 8;
  const n = R.nearest(playerPos().x, playerPos().z, 200, ok);
  if (!n) return 'no road';
  const e = n.edge;
  cruiser = { e, s: e.cum[n.seg] + n.t * (e.cum[n.seg + 1] - e.cum[n.seg]), dir: 1, speed, left: seconds, cam: new THREE.Vector3() };
  return `cruising ${seconds}s at ${speed} m/s`;
}
function tickCruise(dt) {
  const c = cruiser;
  if (!c) return;
  c.left -= dt;
  if (c.left <= 0) { cruiser = null; return; }
  const R = game.roads;
  c.s += c.speed * dt * c.dir;
  if (c.s < 0 || c.s > c.e.len) {
    const ni = c.s > c.e.len ? c.e.b : c.e.a;
    const opts = R.adj[ni].map((i) => R.edges[i]).filter((e) => e !== c.e && e.lit && e.kind !== 1 && !e.internal && e.len > 8);
    if (!opts.length) { c.dir = -c.dir; c.s = Math.min(Math.max(c.s, 0), c.e.len); } else {
      const e = opts[Math.floor(Math.random() * opts.length)];
      c.e = e; c.dir = e.a === ni ? 1 : -1; c.s = c.dir > 0 ? 0 : e.len;
    }
  }
  const p = R.pointAt(c.e, c.s);
  const fx = p.tx * c.dir, fz = p.tz * c.dir;
  player.focus.set(p.x, p.y, p.z);
  const cam = game.camera;
  c.cam.set(p.x - fx * 9, p.y + 4.2, p.z - fz * 9);
  cam.position.lerp(c.cam, Math.min(1, dt * 6));
  cam.lookAt(p.x + fx * 12, p.y + 1.2, p.z + fz * 12);
  cam.updateMatrixWorld();
}
function ahead(dist) {
  const p0 = playerPos();
  const yaw = player.yaw;
  return { x: p0.x - Math.sin(yaw) * dist, y: p0.y, z: p0.z - Math.cos(yaw) * dist };
}

const actions = [
  ['Peds', null],
  ...BUILDS.map((b) => [`+50 ${b}`, () => peds.spawnCrowd({ build: b, count: 50, ...playerPos(), radius: 70 })]),
  ['+50 beach looks', () => peds.spawnCrowd({ count: 50, ...playerPos(), radius: 70, beach: true })],
  ['Clear peds', () => peds.clear()],
  ['Knock nearest', () => { const p = nearestPed(); if (p) knock(p); }],
  ['Knock 6 nearest', () => { const l = peds.list.filter((p) => p.state !== 'ragdoll').map((p) => [p, Math.hypot(p.x - playerPos().x, p.z - playerPos().z)]).sort((a, b) => a[1] - b[1]).slice(0, 6); for (const [p] of l) knock(p, 7 + Math.random() * 6); }],
  ['Ragdolls: on', (b) => { peds.ragdollEnabled = !peds.ragdollEnabled; game.ragdolls.enabled = peds.ragdollEnabled; b.textContent = `Ragdolls: ${peds.ragdollEnabled ? 'on' : 'off'}`; }],
  ['LOD: auto', (b) => { peds.forceLOD = peds.forceLOD === null ? 'near' : peds.forceLOD === 'near' ? 'far' : null; b.textContent = `LOD: ${peds.forceLOD ?? 'auto'}`; }],
  ['Panic here', () => peds.panic(playerPos(), 40, 1)],
  ['+40 remote players', () => spawnRemotes(40)],
  ['Explosion ahead', () => { const p = ahead(14); game.events.emit('explosion', { position: { x: p.x, y: p.y + 0.5, z: p.z }, power: 1, radius: 8 }); game.fx?.explode?.(p, 1); }],
  ['Player', null],
  ['Cash drop $50', () => { const p = ahead(4); game.cash.drop(p.x, p.y + 1, p.z, 50); }],
  ['Health -25%', () => player.damage(0.25, 'generic')],
  ['Refill', () => player.refill()],
  ['Ragdoll me', () => { if (player.state === 'foot') player.startRagdoll({ x: -Math.sin(player.yaw) * 6, y: 4, z: -Math.cos(player.yaw) * 6 }, { x: 3, y: 0, z: 1 }); }],
  ['Wasted', () => player.damage(5, 'generic')],
  ['God: off', (b) => { player.setGod(!player.god); b.textContent = `God: ${player.god ? 'on' : 'off'}`; }],
  ['Cars on sidewalks', () => carsOnSidewalks(6)],
  ['Creeping car', () => creepCar()],
  ['Remove lab cars', () => { for (const v of labCars.splice(0)) game.vehicles.despawn?.(v); }],
  ['Spawn car', () => { const p = ahead(6); const v = game.vehicles.spawn('comet', { x: p.x, y: game.terrain.heightAt(p.x, p.z), z: p.z }, player.yaw + Math.PI / 2); return v; }],
  ['Wardrobe', null],
  ['Random outfit', () => player.setOutfit(randomOutfit())],
  ['Rich outfit', () => player.setOutfit(randomOutfit(true))],
  ['Default outfit', () => player.setOutfit(DEFAULT_OUTFIT)],
  ['Preview', () => togglePreview()],
  ['Dress remotes', () => dressRemotes()],
  ['World', null],
  ['Beach (sand)', () => { player.teleport(2120, -900); player._placeOnFoot(2175, -900, -Math.PI / 2, null, false, true); }],
  ['Downtown', () => player.teleport(-634, 152)],
  ['Little Cuba', () => player.teleport(-1194, -60)],
  ['+3 h', () => game.sky.setTime(game.sky.time + 3, { smooth: false })],
];
for (const [label, fn] of actions) {
  if (!fn) { const h = document.createElement('div'); h.className = 'h'; h.textContent = label; panel.appendChild(h); continue; }
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); b.blur(); });
  panel.appendChild(b);
}

// ?soak=1: stand still and slowly pan the camera so many pedestrians pass through the view
if (params.get('soak')) {
  player.orbit.mode = 2;
  game.register({ lateUpdate(dt) { player.orbit.yaw += dt * 0.12; player.orbit.idle = 0; } }, -1);
}

let acc = 0;
game.register({
  lateUpdate(dt) {
    tickRemotes(dt);
    tickCreeper(dt);
    tickCruise(dt);
    crowd.tick(dt);
    acc += dt;
    if (acc < 0.25) return;
    acc = 0;
    const s = peds.stats;
    const info = game.renderer.info.render;
    stats.textContent = [
      `${game.fps} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris`,
      `peds ${s.count} (full ${s.near}, mid ${s.mid}, far ${s.far}) · beach ${peds.beach.count}/${peds.beach.target} · ragdolls ${s.ragdolls}`,
      (() => { const h = peds.batch.stats(); return `humans ${h.draws} draws · ${(h.tris / 1000).toFixed(1)}k tris · shadow ${h.shadowDraws}/${(h.shadowTris / 1000).toFixed(1)}k`; })(),
      `peds update ${s.ms.toFixed(2)} ms avg · ${s.msMax.toFixed(2)} max`,
      `jumps >0.5 m: ${peds.jumpStats?.over ?? 0} · max step ${(peds.jumpStats?.max ?? 0).toFixed(2)} m`,
      `inside vehicle: ${peds.insideStats.inside} ped-frames · max ${peds.insideStats.max.toFixed(2)} m · obstacles ${game.vehicleObstacles?.n ?? 0}`,
      `player ${player.state}/${player.mode}${player.swim ? ' swim' : ''}${player.act ? ` ${player.act}` : ''} · hp ${(player.health * 100) | 0} · armor ${(player.armor * 100) | 0} · $${player.money}`,
      `speed ${player.speed.toFixed(1)} m/s · ${game.world3d.areaAt(player.focus.x, player.focus.z).name}`,
    ].join('\n');
  },
}, 100);
