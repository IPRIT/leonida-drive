// Dev-only performance harness (runtime perf owner). Never imported by the game.
//
// Dev server console (any tab, also hidden / background panes):
//   const P = await import('/src/core/perfHarness.js');
//   const h = P.createPerfHarness(__leonida);
//   await h.run('idle', { frames: 240 });          // one scenario → summary row
//   await h.suite();                               // every scenario in SCENARIOS (≈ 2 min)
//   h.table();                                     // markdown table of all rows
//   h.stop();                                      // give the loop back to requestAnimationFrame
//
// The harness pauses the rAF loop and drives `render.loopCallback` itself with MessageChannel ticks (rAF and timers
// are throttled or stopped in hidden tabs), back to back (or paced to `interval` ms). Per frame it records:
//   cpu   main-thread time of the loop callback + the scenario action of that frame (spawn, explosion, …)
//   gpu   GPU time of the frame (EXT_disjoint_timer_query_webgl2 via render.gpu, arrives 1-3 frames late)
//   calls / tris  scene pass draw calls (incl. shadow passes) and triangles
//   prog  shader programs created during the frame (runtime compiles; names in `compiled`)
//   heap  JS heap delta (allocation rate; negative = GC)
//   prof  optional per-system CPU split (`profile: true`): modules, world systems, physics step, three.js passes
// Long tasks (PerformanceObserver) outside the measured frames are reported separately (async streaming work).
import * as THREE from 'three';

// one shared channel: yielding between frames must not allocate much itself (the harness measures GC pressure)
const _ch = new MessageChannel();
let _wake = null;
_ch.port1.onmessage = () => { const w = _wake; _wake = null; w?.(); };
const tick = () => new Promise((r) => { _wake = r; _ch.port2.postMessage(0); });
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

export function createPerfHarness(game, opts = {}) {
  const R = game.render, renderer = game.renderer, gl = renderer.getContext();
  const loop = R.loopCallback;
  if (!loop) throw new Error('game loop not running yet (click PLAY first)');
  renderer.setAnimationLoop(null); // we drive frames ourselves
  // comparable runs: fixed quality profile and render scale (auto resolution off) unless opts.quality === null
  if (opts.quality !== null) {
    if (opts.quality && R.profile.name !== opts.quality) R.setQuality(opts.quality);
    R.autoRes = false;
    R.scale = opts.scale ?? 1;
    R.resize();
  }
  const seen = new Set(renderer.info.programs.map((p) => p.id));
  const longTasks = [];
  let lto = null;
  try {
    lto = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push({ t: e.startTime, d: e.duration }); });
    lto.observe({ type: 'longtask', buffered: false });
  } catch { /* unsupported */ }
  const mem = () => performance.memory?.usedJSHeapSize ?? 0;
  const prof = {};
  const unwrap = [];
  // shadow-pass draw calls of the frame (always on: info.render.calls delta around the shadow map render)
  let shadowCalls = 0;
  const sm = renderer.shadowMap, smRender = sm.render;
  sm.render = function (...a) { const c0 = renderer.info.render.calls; try { return smRender.apply(this, a); } finally { shadowCalls += renderer.info.render.calls - c0; } };

  function wrap(obj, name, key) {
    const f = obj?.[name];
    if (typeof f !== 'function' || f.__perf) return;
    const own = Object.prototype.hasOwnProperty.call(obj, name);
    const w = function (...a) {
      const t = performance.now();
      try { return f.apply(this, a); } finally { prof[key] = (prof[key] || 0) + performance.now() - t; }
    };
    w.__perf = true;
    obj[name] = w;
    unwrap.push(() => { if (own) obj[name] = f; else delete obj[name]; });
  }

  function instrument() {
    if (unwrap.length) return;
    const nameOf = (m, i) => m.constructor && m.constructor !== Object ? m.constructor.name : m.name || `m${i}`;
    game.modules.forEach((m, i) => { for (const f of ['fixedUpdate', 'postStep', 'update', 'lateUpdate']) wrap(m, f, `${nameOf(m, i)}.${f}`); });
    const sys = { terrain: game.terrain, water: game.water, roads: game.roads, buildings: game.buildings, veg: game.veg, lamps: game.lamps, lampMap: game.lampMap, sky: game.sky, ui: game.ui };
    for (const [k, o] of Object.entries(sys)) wrap(o, 'update', `${k}.update`);
    wrap(game.lamps, 'syncBroken', 'lamps.syncBroken');
    if (game.traffic) {
      for (const f of ['fixedUpdate', 'postStep', 'update', 'updateVisual']) wrap(game.traffic, f, `traffic.${f}`);
      wrap(game.traffic.lights, 'syncBroken', 'traffic.lights.syncBroken');
    }
    wrap(game.peds, 'update', 'peds.update');
    wrap(game.world, 'step', 'physics.step');
    wrap(game.input, 'update', 'input.update');
    wrap(R, 'render', 'render.render');
    wrap(R, 'adapt', 'render.adapt');
    // three.js: scene pass (incl. shadows), shadow maps, post passes, auxiliary renders (lamp map, thumbnails, env probe)
    const r0 = renderer.render;
    renderer.render = function (scene, cam) {
      const t = performance.now();
      try { return r0.call(this, scene, cam); } finally {
        const key = scene === R.scene ? 'three.scene' : scene === R.quadScene ? 'three.post' : 'three.aux';
        prof[key] = (prof[key] || 0) + performance.now() - t;
      }
    };
    unwrap.push(() => { renderer.render = r0; });
    wrap(renderer.shadowMap, 'render', 'three.shadowMaps');
  }

  function deinstrument() { while (unwrap.length) unwrap.pop()(); }

  const rows = [];
  const runs = [];
  let lastGpuFrame = -1;

  function frame(action, finish) {
    for (const k in prof) prof[k] = 0;
    const h0 = mem();
    const geo0 = renderer.info.memory.geometries, tex0 = renderer.info.memory.textures;
    shadowCalls = 0;
    const t0 = performance.now();
    let act = 0;
    if (action) { action(); act = performance.now() - t0; }
    const t1 = performance.now();
    loop(t1);
    const t2 = performance.now();
    if (finish) gl.finish();
    const t3 = performance.now();
    const compiled = [];
    for (const p of renderer.info.programs) if (!seen.has(p.id)) { seen.add(p.id); compiled.push(`${p.name || '?'}#${p.id}:${(p.cacheKey || '').slice(0, 24)}`); }
    const g = R.gpu;
    const gpu = g.enabled && g.frame !== lastGpuFrame ? g.lastFrameMs ?? null : null;
    lastGpuFrame = g.frame;
    return {
      t0, cpu: t2 - t0, act, total: t3 - t0, gpu,
      calls: R.frameInfo.calls, shadowCalls, tris: R.frameInfo.triangles, programs: renderer.info.programs.length, heapAbs: mem(),
      compiled, heap: mem() - h0, geo: renderer.info.memory.geometries - geo0, tex: renderer.info.memory.textures - tex0,
      scale: R.scale, quality: R.profile.name,
      prof: unwrap.length ? { ...prof } : null,
    };
  }

  /**
   * Drive n frames. o: { actions: {frameIndex: fn}, every(i) → fn|null, interval, finish, record=true }
   * interval (ms, default 0): minimum frame period. 0 runs frames back to back with one yield in between, so the
   * harness adds no allocation of its own; pacing spins the event loop until the period is over.
   */
  async function drive(n, o = {}) {
    const interval = o.interval ?? opts.interval ?? 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const act = o.actions?.[i] || o.every?.(i) || null;
      const f = frame(act, o.finish);
      if (o.record !== false) out.push(f);
      await tick();
      while (interval && performance.now() - f.t0 < interval) await tick();
    }
    return out;
  }

  function summarize(name, frames, extra = {}) {
    const cpu = frames.map((f) => f.cpu);
    const gpu = frames.map((f) => f.gpu).filter((x) => x != null);
    const compiled = frames.flatMap((f) => f.compiled);
    const heapPos = frames.reduce((s, f) => s + Math.max(0, f.heap), 0);
    const dur = frames.length ? (frames.at(-1).t0 - frames[0].t0) / 1000 : 1;
    const worst = frames.reduce((w, f, i) => (f.cpu > (w?.cpu ?? -1) ? { ...f, i } : w), null);
    const row = {
      name, n: frames.length,
      p50: r2(pct(cpu, 0.5)), p95: r2(pct(cpu, 0.95)), p99: r2(pct(cpu, 0.99)), max: r1(Math.max(0, ...cpu)),
      over8: cpu.filter((x) => x > 8.33).length, over16: cpu.filter((x) => x > 16.7).length, over20: cpu.filter((x) => x > 20).length,
      worstAt: worst?.i, worstAct: worst ? r1(worst.act) : 0,
      gpu50: gpu.length ? r2(pct(gpu, 0.5)) : null, gpu95: gpu.length ? r2(pct(gpu, 0.95)) : null,
      calls50: pct(frames.map((f) => f.calls), 0.5), callsMax: Math.max(0, ...frames.map((f) => f.calls)),
      tris50: pct(frames.map((f) => f.tris), 0.5),
      prog0: frames[0]?.programs, prog1: frames.at(-1)?.programs, compiles: compiled.length,
      compiled: [...new Set(compiled)].slice(0, 12).join(','),
      allocMBs: r1(heapPos / 1e6 / dur), gcs: frames.filter((f) => f.heap < -2e6).length,
      bigGcs: frames.filter((f) => f.heap < -8e6).length, gcPauseMax: r1(Math.max(0, ...frames.filter((f) => f.heap < -2e6).map((f) => f.cpu))),
      heapMB: r1((frames.at(-1)?.heapAbs ?? 0) / 1e6), shadow50: pct(frames.map((f) => f.shadowCalls), 0.5),
      geoUploads: frames.reduce((s, f) => s + Math.max(0, f.geo), 0), texUploads: frames.reduce((s, f) => s + Math.max(0, f.tex), 0),
      scale: frames.at(-1)?.scale, quality: frames.at(-1)?.quality,
      ...extra,
    };
    if (frames[0]?.prof) {
      const keys = new Set(frames.flatMap((f) => Object.keys(f.prof)));
      const split = {};
      for (const k of keys) {
        const v = frames.map((f) => f.prof[k] || 0);
        split[k] = { avg: r2(v.reduce((s, x) => s + x, 0) / v.length), max: r1(Math.max(...v)), atWorst: r1(worst?.prof?.[k] || 0) };
      }
      row.split = Object.fromEntries(Object.entries(split).sort((a, b) => b[1].avg - a[1].avg));
    }
    return row;
  }

  /** Run one named scenario (see SCENARIOS) or a custom spec { setup, frames, actions, every, finish }. */
  async function run(name, spec = SCENARIOS[name]) {
    if (!spec) throw new Error(`unknown scenario ${name}`);
    if (spec.profile ?? opts.profile) instrument(); else deinstrument();
    const ctx = { game, h: api, THREE, state: {} };
    if (spec.setup) await spec.setup(ctx);
    if (spec.warm) await drive(spec.warm, { record: false });
    const lt0 = performance.now();
    const ltN = longTasks.length;
    const actions = typeof spec.actions === 'function' ? spec.actions(ctx) : spec.actions;
    const frames = await drive(spec.frames ?? 240, { actions, every: spec.every && ((i) => spec.every(ctx, i)), finish: spec.finish, interval: spec.interval });
    const lts = longTasks.slice(ltN).filter((t) => t.t >= lt0);
    // long tasks that are not one of our frames (frames are tasks too)
    const inFrame = (t) => frames.some((f) => Math.abs(f.t0 - t.t) < 2);
    const bg = lts.filter((t) => !inFrame(t));
    const row = summarize(name, frames, { bgLongTasks: bg.length, bgLongMax: r1(Math.max(0, ...bg.map((t) => t.d))) });
    if (spec.after) row.after = await spec.after(ctx, frames);
    rows.push(row);
    runs.push({ name, frames });
    if (spec.teardown) await spec.teardown(ctx);
    return row;
  }

  async function suite(names = Object.keys(SCENARIOS).filter((k) => !SCENARIOS[k].manual)) {
    for (const n of names) {
      try { await run(n); } catch (e) { rows.push({ name: n, error: String(e?.message || e) }); }
    }
    return table();
  }

  function table(list = rows) {
    const head = '| scenario | frames | p50 | p95 | max | >16.7 | gpu p50 | calls p50/max | programs | compiles | alloc MB/s |';
    const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
    const body = list.map((r) => (r.error ? `| ${r.name} | error: ${r.error} |||||||||` : `| ${r.name} | ${r.n} | ${r.p50} | ${r.p95} | ${r.max} | ${r.over16} | ${r.gpu50 ?? '-'} | ${r.calls50}/${r.callsMax} | ${r.prog0}→${r.prog1} | ${r.compiles} | ${r.allocMBs} |`));
    return [head, sep, ...body].join('\n');
  }

  /** Render-only timing with gl.finish (GPU + driver), the world frozen: { p50, p95 } ms over n renders. */
  function renderOnly(n = 60) {
    const t = [];
    gl.finish();
    for (let i = 0; i < n; i++) { const t0 = performance.now(); R.render(); gl.finish(); t.push(performance.now() - t0); }
    return { p50: r2(pct(t, 0.5)), p95: r2(pct(t, 0.95)), passes: { ...R.gpu.results } };
  }

  function stop() {
    sm.render = smRender;
    deinstrument();
    lto?.disconnect();
    renderer.setAnimationLoop(loop);
  }

  /** Scene objects whose material currently uses one of the program ids (what a runtime compile was for). */
  function whoUses(ids) {
    const set = new Set(ids), out = [];
    game.scene.traverse((o) => {
      for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
        const pr = renderer.properties.get(m)?.currentProgram;
        if (!pr || !set.has(pr.id)) continue;
        const path = [];
        for (let q = o; q && q.parent; q = q.parent) path.push(q.name || q.type);
        out.push(`#${pr.id} ${m.type} ${path.reverse().join('/')}${o.visible ? '' : ' (hidden)'}`);
      }
    });
    return [...new Set(out)];
  }

  const api = { game, rows, runs, drive, frame, run, suite, table, summarize, instrument, deinstrument, renderOnly, stop, longTasks, whoUses, SCENARIOS };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// scenario helpers

/** Place the player's vehicle (or the player on foot) at the road nearest to (x, z). */
export function teleport(game, x, z) {
  if (game.ui?.teleport) game.ui.teleport(x, z); else game.player.teleport(x, z);
}

/** A drivable route of `len` metres along connected road edges starting near (x, z): { pts: [x,y,z,…], len } */
export function roadRoute(game, x, z, len = 3000) {
  const R = game.roads;
  const n0 = R.nearest(x, z, 400);
  if (!n0) throw new Error('no road near');
  let e = n0.edge, fwd = true;
  const pts = [];
  let total = 0, guard = 0;
  const used = new Set();
  while (total < len && guard++ < 200) {
    used.add(e.i);
    const n = e.n;
    for (let k = 0; k < n; k++) {
      const i = fwd ? k : n - 1 - k;
      const px = e.pts[2 * i], pz = e.pts[2 * i + 1], py = e.y[i];
      if (pts.length) total += Math.hypot(px - pts[pts.length - 3], pz - pts[pts.length - 1]);
      pts.push(px, py, pz);
    }
    const node = fwd ? e.b : e.a;
    // straightest continuation at the end node
    const dx = pts[pts.length - 3] - pts[pts.length - 6], dz = pts[pts.length - 1] - pts[pts.length - 4];
    const dl = Math.hypot(dx, dz) || 1;
    let best = null, bd = -2;
    for (const ei of R.adj[node] || []) {
      const c = R.edges[ei];
      if (used.has(ei) || c.runway || c.airside || c.kind === 2) continue;
      const f = c.a === node;
      const j = f ? 1 : c.n - 2;
      const j0 = f ? 0 : c.n - 1;
      const cx = c.pts[2 * j] - c.pts[2 * j0], cz = c.pts[2 * j + 1] - c.pts[2 * j0 + 1];
      const d = (cx * dx + cz * dz) / ((Math.hypot(cx, cz) || 1) * dl);
      if (d > bd) { bd = d; best = { c, f }; }
    }
    if (!best) break;
    e = best.c; fwd = best.f;
  }
  return { pts, len: total };
}

/** Move the player's vehicle along a route at `speed` m/s (kinematic: position + velocity set every frame). */
export function routeDriver(game, route, speed = 60) {
  const p = route.pts;
  let seg = 0, s = 0;
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  return (dt = 1 / 120) => {
    const v = game.player.controllable;
    if (!v?.body) return;
    s += speed * dt;
    while (seg < p.length / 3 - 2) {
      const l = Math.hypot(p[3 * seg + 3] - p[3 * seg], p[3 * seg + 5] - p[3 * seg + 2]);
      if (s < l) break;
      s -= l; seg++;
    }
    const i = 3 * seg;
    const l = Math.hypot(p[i + 3] - p[i], p[i + 5] - p[i + 2]) || 1;
    const t = Math.min(1, s / l);
    const x = p[i] + (p[i + 3] - p[i]) * t, y = p[i + 1] + (p[i + 4] - p[i + 1]) * t, z = p[i + 2] + (p[i + 5] - p[i + 2]) * t;
    const dx = (p[i + 3] - p[i]) / l, dz = (p[i + 5] - p[i + 2]) / l;
    q.setFromAxisAngle(up, Math.atan2(-dx, -dz));
    v.body.setTranslation({ x, y: y + 1.0, z }, true);
    v.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    v.body.setLinvel({ x: dx * speed, y: 0, z: dz * speed }, true);
    v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    game.player.focus?.set?.(x, y, z);
  };
}

function aheadOfPlayer(game, d = 15) {
  const v = game.player.controllable;
  const o = v ? v.object3d : null;
  const p = v ? v.body.translation() : game.player.focus;
  const f = new THREE.Vector3(0, 0, -1);
  if (o) f.applyQuaternion(o.quaternion);
  f.y = 0; f.normalize();
  const x = p.x + f.x * d, z = p.z + f.z * d;
  return { x, y: Math.max(game.terrain.heightAt(x, z), 0) + 1, z, fx: f.x, fz: f.z };
}

// a point just outside the facade of the n-th nearest building over 6 m (towards the player): blasts that break walls
export function blastAtBuilding(game, n = 0) {
  const p = game.player.focus;
  const list = [];
  for (const id of game.buildings.query(p.x, p.z, 150) || []) {
    const b = game.buildings.info(id);
    const c = b?.center;
    if (b && !b.removed && b.height > 6 && c) list.push({ b, d: Math.hypot((c.x ?? c[0]) - p.x, (c.z ?? c[1]) - p.z) });
  }
  list.sort((a, b) => a.d - b.d);
  const b = list[Math.min(n, list.length - 1)]?.b;
  if (!b) throw new Error('no building near');
  const cx = b.center.x ?? b.center[0], cz = b.center.z ?? b.center[1];
  const dx = p.x - cx, dz = p.z - cz, l = Math.hypot(dx, dz) || 1;
  const r = Math.sqrt(b.area) * 0.5 + 1.5;
  return { x: cx + (dx / l) * r, y: b.base + 2, z: cz + (dz / l) * r };
}

const spawnScenario = (id, frames = 60) => ({ frames, actions: (c) => ({ 5: () => { c.game.spawnForPlayer(id); } }) });

const DOWNTOWN = { x: -634, z: 152 };

// Scenarios run in this order by suite(). Each is self-contained (sets its own place / time where it matters).
export const SCENARIOS = {
  idle_day: { setup: ({ game }) => { game.sky.setTime(13); }, warm: 60, frames: 300 },
  spawn_car_first: spawnScenario('muscle'),
  spawn_car_repeat: spawnScenario('muscle'),
  spawn_car_other: spawnScenario('kanzler'),
  spawn_bike: spawnScenario('fulmine'),
  spawn_bicycle: spawnScenario('aero'),
  spawn_truck: spawnScenario('semi'),
  spawn_plane: spawnScenario('plane_trainer'),
  spawn_heli: spawnScenario('heli_news'),
  spawn_boat: spawnScenario('boat_speed'),
  spawn_tank: spawnScenario('tank'),
  spawn_back_to_car: spawnScenario('comet'),
  spawn_plane_repeat: spawnScenario('plane_trainer'),
  spawn_tank_repeat: spawnScenario('tank'),
  spawn_comet_again: spawnScenario('comet'),
  explosion_first: { frames: 150, actions: ({ game }) => ({ 5: () => { const a = aheadOfPlayer(game, 18); game.fx.explode(a, 1.2); } }) },
  explosion_repeat: { frames: 150, actions: ({ game }) => ({ 5: () => { const a = aheadOfPlayer(game, 18); game.fx.explode(a, 1.2); } }) },
  explosion_building: { frames: 200, setup: (c) => { c.state.at = blastAtBuilding(c.game, 0); }, actions: ({ game, state }) => ({ 5: () => game.fx.explode(state.at, 1.6) }) },
  explosion_building_2: { frames: 200, setup: (c) => { c.state.at = blastAtBuilding(c.game, 1); }, actions: ({ game, state }) => ({ 5: () => game.fx.explode(state.at, 1.6) }) },
  vehicle_explode: {
    frames: 180,
    setup: ({ game, state }) => {
      const a = aheadOfPlayer(game, 12);
      state.v = game.vehicles.spawn('pickup', a, 0, {});
    },
    warm: 20,
    actions: ({ game, state }) => ({ 5: () => game.damage.explode(state.v) }),
  },
  vehicle_explode_repeat: {
    frames: 180,
    setup: ({ game, state }) => { const a = aheadOfPlayer(game, 12); state.v = game.vehicles.spawn('pickup', a, 0, {}); },
    warm: 20,
    actions: ({ game, state }) => ({ 5: () => game.damage.explode(state.v) }),
  },
  traffic_crash: {
    frames: 180,
    setup: ({ game, state }) => {
      if (game.player.mode !== 'vehicle') game.spawnForPlayer('comet');
      const v = game.player.controllable;
      v.damage?.repair?.();
      const p = v.body.translation();
      let best = null, bd = 1e9;
      for (const a of game.traffic.agents) {
        if (a.crashed) continue;
        const d = Math.hypot(a.cur.x - p.x, a.cur.z - p.z);
        if (d > 25 && d < bd) { bd = d; best = a; }
      }
      if (!best) throw new Error('no traffic');
      state.a = best;
    },
    every: ({ game, state }, i) => () => {
      const a = state.a;
      if (!a.crashed) { a.v = 0; a.vmax = 0; } // hold the AI car still until it is hit (like damage/dev/traffic-crash-test)
      if (i !== 3) return;
      const v = game.player.controllable;
      const p = v.body.translation();
      const d = new THREE.Vector3(a.cur.x - p.x, 0, a.cur.z - p.z).normalize();
      const at = new THREE.Vector3(a.cur.x - d.x * 14, a.cur.y, a.cur.z - d.z * 14);
      v.reset(at, Math.atan2(-d.x, -d.z));
      v.physics.setVelocity({ x: d.x * 22, y: 0, z: d.z * 22 });
    },
    after: ({ game, state }) => ({ promoted: !!state.a.wreck, crashed: !!state.a.crashed, promoteMs: game.damage?.stats?.lastPromoteMs }),
  },
  building_collapse: {
    frames: 300,
    setup: ({ game, state }) => {
      const p = game.player.focus;
      const ids = game.buildings.query(p.x, p.z, 120) || [];
      let pick = null;
      for (const id of ids) { const info = game.buildings.info(id); if (info && !info.removed && info.height > 8) { pick = { id, info }; break; } }
      if (!pick) throw new Error('no building near');
      state.b = pick;
    },
    actions: ({ game, state }) => ({ 5: () => game.damage.destruction.collapse(state.b.id, state.b.info, { x: 1, z: 0 }, 60) }),
    after: ({ game }) => ({ collapses: game.damage?.destruction?.stats?.collapses, lastCollapseMs: game.damage?.destruction?.stats?.lastCollapseMs }),
  },
  enter_exit: {
    frames: 240,
    setup: ({ game }) => { if (game.player.mode !== 'vehicle') game.spawnForPlayer('comet'); game.player.controllable.physics.setVelocity({ x: 0, y: 0, z: 0 }); },
    warm: 30,
    actions: ({ game, state }) => ({
      5: () => { state.v = game.player.controllable; game.player.exit({ instant: true }); },
      120: () => { game.player.enter(state.v); },
    }),
  },
  day_to_night: { frames: 360, actions: ({ game }) => ({ 5: () => game.sky.setTime(22.5, { smooth: true }) }) },
  weather_storm: { frames: 360, actions: ({ game }) => ({ 5: () => { game.weather.setAuto(false); game.weather.set('storm', 2); } }) },
  weather_clear: { frames: 240, actions: ({ game }) => ({ 5: () => { game.weather.set('clear', 1); } }) },
  night_to_day: { frames: 300, actions: ({ game }) => ({ 5: () => game.sky.setTime(12, { smooth: true }) }) },
  teleport_downtown: { frames: 240, actions: ({ game }) => ({ 5: () => teleport(game, DOWNTOWN.x, DOWNTOWN.z) }) },
  downtown_night: {
    setup: ({ game }) => { game.sky.setTime(23); game.weather.set('clear', 0.1); },
    warm: 360, frames: 600, profile: true,
  },
  drive_fast: {
    setup: ({ game, state }) => {
      if (game.player.mode !== 'vehicle') game.spawnForPlayer('comet');
      const p = game.player.controllable.body.translation();
      state.drive = routeDriver(game, roadRoute(game, p.x, p.z, 4000), 70);
    },
    frames: 600, profile: true,
    every: ({ state }) => () => state.drive(1 / 120),
  },
  map_open: {
    frames: 120,
    actions: ({ game }) => ({ 5: () => game.ui.open?.('map'), 60: () => game.ui.close?.() }),
  },
  menu_tabs: {
    frames: 200,
    actions: ({ game }) => {
      const tabs = ['vehicles', 'service', 'wardrobe', 'world', 'player', 'settings', 'controls', 'stats'];
      const a = { 5: () => game.ui.open?.('vehicles') };
      tabs.forEach((t, i) => { a[20 + i * 20] = () => game.ui.open?.(t); });
      a[190] = () => game.ui.close?.();
      return a;
    },
  },
};
