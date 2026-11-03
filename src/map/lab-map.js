// Map lab (lab-map.html): the cartography module without the 3D game. Full map + HUD-sized radar driven by a
// simulated car that drives the road graph (Dijkstra routes to the waypoint), fake remote players, live timings.
import '@fontsource/oswald/latin-400.css';
import '@fontsource/oswald/latin-500.css';
import '@fontsource/russo-one/latin-400.css';
import { Game } from '../core/Game.js';
import { InputManager } from '../core/input.js';
import { createI18n } from '../i18n/index.js';
import { createCartography } from './Cartography.js';
import { gunzipIfNeeded } from './mapData.js';

const params = new URLSearchParams(location.search);
const BASE = `${import.meta.env.BASE_URL}data/`;

// ---- tiny road graph for the simulation ----------------------------------------------------------------------
class Graph {
  constructor(R) {
    this.nodes = R.nodes;
    this.edges = R.edges.map((e) => ({ a: e.a, b: e.b, p: e.p, k: e.k, len: polyLen(e.p) }));
    this.adj = this.nodes.map(() => []);
    this.edges.forEach((e, i) => { this.adj[e.a].push(i); if (e.b !== e.a) this.adj[e.b].push(i); });
  }
  nearestNode(x, z) {
    let best = 0, bd = Infinity;
    this.nodes.forEach(([nx, nz], i) => { const d = (nx - x) ** 2 + (nz - z) ** 2; if (d < bd && this.adj[i].length) { bd = d; best = i; } });
    return best;
  }
  route(x0, z0, x1, z1) {
    const A = this.nearestNode(x0, z0), B = this.nearestNode(x1, z1);
    const dist = new Float64Array(this.nodes.length).fill(Infinity), prev = new Int32Array(this.nodes.length).fill(-1);
    dist[A] = 0;
    const heap = [[0, A]];
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [d, n] = heap[bi];
      heap[bi] = heap[heap.length - 1]; heap.pop();
      if (d > dist[n]) continue;
      if (n === B) break;
      for (const ei of this.adj[n]) {
        const e = this.edges[ei];
        const o = e.a === n ? e.b : e.a;
        const nd = d + e.len * (e.k === 'highway' ? 0.75 : e.k === 'dirt' ? 1.6 : 1);
        if (nd < dist[o]) { dist[o] = nd; prev[o] = ei; heap.push([nd, o]); }
      }
    }
    if (prev[B] < 0 && A !== B) return null;
    const chain = [];
    for (let n = B; n !== A;) { const ei = prev[n]; const e = this.edges[ei]; chain.push([ei, e.a === n ? 'rev' : 'fwd']); n = e.a === n ? e.b : e.a; }
    chain.reverse();
    const out = [];
    for (const [ei, dir] of chain) {
      const p = this.edges[ei].p, n = p.length / 2;
      for (let k = 0; k < n; k++) { const j = dir === 'fwd' ? k : n - 1 - k; if (out.length && k === 0) continue; out.push(p[j * 2], p[j * 2 + 1]); }
    }
    return out;
  }
  randomWalk(node, steps) {
    const out = [];
    let n = node, last = -1;
    for (let s = 0; s < steps; s++) {
      const opts = this.adj[n].filter((ei) => ei !== last && this.edges[ei].k !== 'dirt');
      const ei = (opts.length ? opts : this.adj[n])[Math.floor(Math.random() * (opts.length || this.adj[n].length))];
      if (ei === undefined) break;
      const e = this.edges[ei], fwd = e.a === n, p = e.p, m = p.length / 2;
      for (let k = 0; k < m; k++) { const j = fwd ? k : m - 1 - k; if (out.length && k === 0) continue; out.push(p[j * 2], p[j * 2 + 1]); }
      n = fwd ? e.b : e.a; last = ei;
    }
    return { pts: out, node: n };
  }
}
const polyLen = (p) => { let L = 0; for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; };

// a point that follows a polyline at a given speed
class Follower {
  constructor(pts) { this.set(pts); }
  set(pts) { this.pts = pts; this.i = 0; this.t = 0; }
  advance(d) {
    const p = this.pts;
    while (d > 0 && this.i < p.length / 2 - 1) {
      const ax = p[this.i * 2], az = p[this.i * 2 + 1], bx = p[this.i * 2 + 2], bz = p[this.i * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az) || 1e-6;
      const rem = (1 - this.t) * L;
      if (d < rem) { this.t += d / L; d = 0; } else { d -= rem; this.i++; this.t = 0; }
    }
    return this.i >= p.length / 2 - 1;
  }
  get pos() {
    const p = this.pts, i = Math.min(this.i, p.length / 2 - 2);
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
    return { x: ax + (bx - ax) * this.t, z: az + (bz - az) * this.t, heading: Math.atan2(bx - ax, -(bz - az)) };
  }
}

async function main() {
  const t0 = performance.now();
  const [world, heights, roads] = await Promise.all([
    fetch(`${BASE}world.json`).then((r) => r.json()),
    fetch(`${BASE}height.bin`).then((r) => r.arrayBuffer()).then(gunzipIfNeeded).then((b) => new Int16Array(b)),
    fetch(`${BASE}roads.json`).then((r) => r.json()),
  ]);
  const game = new Game();
  try { game.settings = JSON.parse(localStorage.getItem('leonida.settings') || '{}'); } catch { game.settings = {}; }
  game.worldData = world;
  createI18n(game);
  const graph = new Graph(roads);
  const start = params.get('at')?.split(',').map(Number) || [1745, -640];
  const car = new Follower(graph.randomWalk(graph.nearestNode(start[0], start[1]), 40).pts);
  game.player = {
    focus: { x: start[0], z: start[1] }, heading: 0, route: null, waypoint: null,
    setWaypoint(w) { this.waypoint = w; this.route = w ? graph.route(this.focus.x, this.focus.z, w.x, w.z) : null; if (this.route) car.set(this.route.slice()); },
    teleport(x, z) { const n = graph.nearestNode(x, z); car.set(graph.randomWalk(n, 40).pts); const p = car.pos; this.focus.x = p.x; this.focus.z = p.z; if (this.waypoint) this.setWaypoint(this.waypoint); },
  };
  game.input = new InputManager(document.getElementById('map'));

  const carto = await createCartography(game, { data: { world, heights }, useWorkers: !params.has('noworkers') });
  window.carto = carto;
  const fm = carto.createFullMap(document.getElementById('map'), {
    onWaypoint: (w) => game.player.setWaypoint(w ? { x: w.x, z: w.z } : null),
    onClear: () => game.player.setWaypoint(null),
    onTeleport: (x, z) => game.player.teleport(x, z),
    keyActions: true,
  });
  window.fm = fm;
  fm.show(game.player.focus);
  installShots(carto, fm);

  // fake remote players
  const others = ['#4fd1ff', '#7dff6b', '#ffb84f'].map((color, i) => {
    const n = graph.nearestNode(start[0] + (i - 1) * 300, start[1] + 200);
    return { id: `p${i}`, name: `Player ${i + 2}`, color, f: new Follower(graph.randomWalk(n, 60).pts), speed: 14 + i * 4 };
  });

  // radar canvas like the HUD's
  const rc = document.getElementById('radar');
  const rs = +(params.get('rs') || 1); // ?rs=2 shows the radar twice as large (inspection)
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * rs;
  rc.width = 300 * dpr; rc.height = 190 * dpr;
  rc.style.width = `${300 * rs}px`; rc.style.height = `${190 * rs}px`;
  const rctx = rc.getContext('2d');
  rctx.scale(dpr, dpr);

  // toolbar
  const bar = document.getElementById('bar');
  let driving = true, speedKmh = 70, follow = false;
  const places = { 'Ocean Beach': [1740, -700], Downtown: [-660, 100], 'Little Cuba': [-1190, -60], Keys: [-2510, 5890], 'Mt. Kalaga': [-3600, -6400], 'Port Gellhorn': [-6560, -3670], Overview: [-2560, 0] };
  bar.innerHTML = `<button data-a="drive" class="on">Drive</button><label>speed <input type="range" min="0" max="250" value="70" data-a="speed"> <span id="spd">70</span> km/h</label>
    <button data-a="follow">Follow</button>
    <select data-a="fly">${Object.keys(places).map((k) => `<option>${k}</option>`).join('')}</select>
    <select data-a="lang"><option value="en">EN</option><option value="ru">RU</option></select>
    <button data-a="bench">Bench labels</button><button data-a="wp">Random waypoint</button>`;
  bar.addEventListener('click', (e) => {
    const a = e.target.dataset?.a;
    if (a === 'drive') { driving = !driving; e.target.classList.toggle('on', driving); }
    if (a === 'follow') { follow = !follow; e.target.classList.toggle('on', follow); }
    if (a === 'bench') bench();
    if (a === 'wp') {
      const n = graph.nodes[Math.floor(Math.random() * graph.nodes.length)];
      game.player.setWaypoint({ x: n[0], z: n[1] });
    }
  });
  bar.addEventListener('input', (e) => {
    if (e.target.dataset.a === 'speed') { speedKmh = +e.target.value; document.getElementById('spd').textContent = speedKmh; }
  });
  bar.addEventListener('change', (e) => {
    const a = e.target.dataset.a;
    if (a === 'fly') { const p = places[e.target.value]; fm.flyTo({ x: p[0], z: p[1] }, e.target.value === 'Overview' ? 22 : 3); }
    if (a === 'lang') game.applySetting('lang', e.target.value);
  });

  function bench() {
    const L = fm.labels, v = { ...fm.view };
    const out = [];
    for (const mpp of [0.4, 1, 2, 4, 8, 16]) {
      const view = { ...v, mpp };
      const t = performance.now();
      for (let i = 0; i < 20; i++) { view.cx = v.cx + i * 7 * mpp; L.place(view); }
      out.push(`mpp ${mpp}: ${((performance.now() - t) / 20).toFixed(3)} ms, ${L.stats.candidates} cand, ${L.placed.length} placed`);
    }
    console.log(out.join('\n'));
    alert(out.join('\n'));
  }

  const st = document.getElementById('stats');
  let last = performance.now(), statT = 0, frames = 0, ftime = 0;
  const s = { x: 0, z: 0, heading: 0, speedKmh: 0, radarAlt: 0, blips: [] };
  console.log(`[lab-map] ready in ${(performance.now() - t0).toFixed(0)} ms (cartography ${carto.loadMs.toFixed(0)} ms)`);
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    game.input.update();
    // simulation
    if (driving) {
      if (car.advance(speedKmh / 3.6 * dt)) {
        const p = car.pos;
        car.set(graph.randomWalk(graph.nearestNode(p.x, p.z), 40).pts);
      }
    }
    const p = car.pos;
    game.player.focus.x = p.x; game.player.focus.z = p.z; game.player.heading = p.heading;
    if (game.player.waypoint && Math.hypot(p.x - game.player.waypoint.x, p.z - game.player.waypoint.z) < 40) game.player.setWaypoint(null);
    for (const o of others) { if (o.f.advance(o.speed * dt)) { const q = o.f.pos; o.f.set(graph.randomWalk(graph.nearestNode(q.x, q.z), 60).pts); } }
    carto.setPlayers(others.map((o) => { const q = o.f.pos; return { id: o.id, x: q.x, z: q.z, heading: q.heading, color: o.color, name: o.name }; }));
    // radar (what Hud.drawRadar will call)
    s.x = p.x; s.z = p.z; s.heading = -p.heading; s.speedKmh = driving ? speedKmh : 0;
    carto.drawRadar(rctx, 300, 190, s, dt);
    if (follow && !fm.pointers.size) { fm.view.cx = p.x; fm.view.cz = p.z; fm.dirty = true; }
    const tf = performance.now();
    fm.update(dt, game.input);
    ftime += performance.now() - tf; frames++;
    if ((statT -= dt) <= 0) {
      statT = 0.5;
      const S = carto.stats();
      st.textContent = `radar  avg ${S.radar.avgMs.toFixed(3)} ms  max ${S.radar.max.toFixed(2)} ms\n`
        + `map    avg ${(ftime / Math.max(1, frames)).toFixed(2)} ms/frame  labels ${fm.labels.stats.placeMs.toFixed(2)} ms (${fm.labels.stats.candidates} cand)\n`
        + `tiles  ${S.tiles.rendered} rendered, avg ${S.tiles.avgMs.toFixed(1)} ms, ${S.tiles.workers} workers\n`
        + `direct ${S.tiles.direct} frames, last ${S.tiles.directMs.toFixed(1)} ms   cache ${S.tiles.cachedMB.toFixed(0)} MB\n`
        + `view   ${fm.view.cx.toFixed(0)}, ${fm.view.cz.toFixed(0)}  ${fm.view.mpp.toFixed(2)} m/px`;
      frames = 0; ftime = 0;
      carto.radar.stats.max *= 0.5;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Inspection helpers (console): labView(cx, cz, mpp) jumps the full map there and resolves once every tile has
// arrived; with ?shotport=N, labShot(name, cx, cz, mpp) / labShotRadar(name) also POST the canvas as a PNG data URL
// to http://127.0.0.1:N/ (a local file sink used for before/after screenshots).
function installShots(carto, fm) {
  const port = params.get('shotport');
  const settle = async (ms = 15000) => {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 300));
    // drive fm.update ourselves: a background tab gets almost no animation frames, and tile requests expire
    while (performance.now() - t0 < ms) {
      fm.update(0.05, null);
      await new Promise((r) => setTimeout(r, 50));
      if (!carto.pool.wants.size && !carto.pool.inflight.size) break;
    }
    for (let i = 0; i < 14; i++) { fm.dirty = true; fm.update(0.05, null); await new Promise((r) => setTimeout(r, 50)); } // label fades
  };
  const post = async (name, canvas) => {
    if (!port) return 'no ?shotport';
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data: canvas.toDataURL('image/png') }) });
    return res.text();
  };
  window.labView = async (cx, cz, mpp) => {
    fm.target = null; fm.fly = null; fm.vel.x = fm.vel.z = 0;
    fm.view.cx = cx; fm.view.cz = cz; fm.view.mpp = mpp; fm.dirty = true;
    await settle();
  };
  window.labShot = async (name, cx, cz, mpp) => { await window.labView(cx, cz, mpp); return post(name, fm.el.canvas); };
  window.labShotRadar = (name) => post(name, document.getElementById('radar'));

  // labPerf(): main-thread cost per frame (CPU side, the number that limits fps) for the radar and the full map,
  // measured with a synthetic loop so it also works in a background tab. Returns ms figures.
  window.labPerf = async () => {
    const out = {};
    const stat = (a) => { a.sort((x, y) => x - y); const s = a.reduce((p, v) => p + v, 0); return { avg: +(s / a.length).toFixed(3), p95: +a[Math.floor(a.length * 0.95)].toFixed(3), max: +a[a.length - 1].toFixed(3) }; };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    // radar: drive 2 km along x at 140 km/h, heading changing; first pass warms the tiles, second is measured
    const rc = document.createElement('canvas'); rc.width = 600; rc.height = 380;
    const rctx = rc.getContext('2d'); rctx.scale(2, 2);
    const s = { x: -2900, z: -250, heading: 0, speedKmh: 140, radarAlt: 0, blips: [{ x: -2800, z: -250, color: '#5cc0ff' }], route: null, waypoint: null };
    for (let pass = 0; pass < 2; pass++) {
      const t = [];
      for (let i = 0; i < 400; i++) {
        s.x = -2900 + i * 5; s.heading = Math.sin(i / 60) * 0.6;
        const t0 = performance.now();
        carto.radar.draw(rctx, 300, 190, s, 1 / 60);
        t.push(performance.now() - t0);
        if (i % 20 === 0) await tick();
      }
      if (pass) out.radar = stat(t);
      else await settle();
    }
    // full map: open latency, pan, fling, zoom (each frame = fm.update with dirty view)
    fm.hide();
    let t0 = performance.now();
    fm.show({ x: -900, z: 300 });
    fm.update(1 / 60, null);
    out.openFirstFrameMs = +(performance.now() - t0).toFixed(1);
    const tStart = performance.now();
    while ((carto.pool.wants.size || carto.pool.inflight.size || fm.fly) && performance.now() - tStart < 10000) { fm.update(1 / 60, null); await new Promise((r) => setTimeout(r, 16)); }
    out.openAllTilesMs = Math.round(performance.now() - t0);
    const run = async (name, n, step) => {
      const t = [];
      for (let i = 0; i < n; i++) {
        step(i);
        fm.dirty = true;
        const a = performance.now();
        fm.update(1 / 120, null);
        t.push(performance.now() - a);
        await tick();
      }
      out[name] = stat(t);
    };
    await run('panMid', 240, () => { fm.view.cx += 6 * fm.view.mpp; });            // 6 CSS px per frame at 120 Hz
    await run('flingFar', 240, () => { fm.view.mpp = 12; fm.view.cx -= 40 * fm.view.mpp; fm.clampView(); }); // fast fling across the state
    await run('zoomInOut', 240, (i) => { fm.view.mpp = Math.exp(Math.log(0.4) + (Math.log(20) - Math.log(0.4)) * (0.5 - 0.5 * Math.cos(i / 240 * Math.PI * 2))); });
    out.tiles = carto.stats().tiles;
    return out;
  };
}

// ?game: the real game (HUD + pause menu by workstream G) with the cartography injected as a module — the same
// wiring the integrator adds to bootstrap (see src/map/INTEGRATION.md).
async function mainGame() {
  for (const id of ['map', 'radar', 'bar', 'stats']) document.getElementById(id).remove();
  const app = document.createElement('div');
  app.id = 'app';
  app.style.cssText = 'position:fixed;inset:0';
  document.body.appendChild(app);
  const { createGame } = await import('../core/bootstrap.js');
  const game = await createGame(app, {
    autostart: true, noPeds: true,
    modules: [async (g) => { g.cartography = await createCartography(g, {}); return null; }],
  });
  window.game = game;
  window.carto = game.cartography;
}

(params.has('game') ? mainGame() : main()).catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f66;position:fixed;top:60px;left:10px">${e.stack || e}</pre>`); });
