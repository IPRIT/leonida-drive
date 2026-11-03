// Dev-only scripted crash test for AI traffic damage (never imported by the game).
// Dev server console:
//   const T = await import('/src/damage/dev/traffic-crash-test.js');
//   await T.trafficCrash(__leonida, { kmh: 60 });                 // head-on into a standing red pickup
//   await T.trafficCrash(__leonida, { kmh: 60, mode: 'side' });   // T-bone into the driver's side
//   await T.trafficCrash(__leonida, { kmh: 60, mode: 'rear' });   // rear-end
//   await T.sinkReport(__leonida);                                // body bottom vs surface for every crashed car
// Returns numbers for both cars (impact energy, displaced vertices, lamps / glass / parts) and frame times.
import * as THREE from 'three';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });

// a long straight urban road edge near p (lanePoint tangents agree over the test stretch)
function pickRoad(tr, p, need = 150) {
  let best = null, bd = Infinity;
  const P = {}, Q = {};
  for (const e of tr.roads.edges) {
    if (e.kind !== 0 || e.noTraffic || e.len < need + 40 || e.br || e.tunnel || e.oneway) continue;
    const mid = tr.lanePoint(e, 1, 0, e.len / 2, P);
    const d = Math.hypot(mid.x - p.x, mid.z - p.z);
    if (d > bd) continue;
    let ok = true;
    for (let s = 20; s < 20 + need && ok; s += 15) {
      tr.lanePoint(e, 1, 0, s, P); tr.lanePoint(e, 1, 0, s + 15, Q);
      if (P.tx * Q.tx + P.tz * Q.tz < 0.9995 || Math.abs(Q.y - P.y) > 0.6) ok = false;
    }
    if (ok) { best = e; bd = d; }
  }
  return best;
}

function displaced(deformer) {
  let n = 0, max = 0;
  for (const e of deformer.entries) {
    const p = e.attr.array, o = e.orig;
    for (let i = 0; i < p.length; i += 3) {
      const d = Math.hypot(p[i] - o[i], p[i + 1] - o[i + 1], p[i + 2] - o[i + 2]);
      if (d > 0.01) { n++; if (d > max) max = d; }
    }
  }
  return { verts: n, maxCm: Math.round(max * 100) };
}

function damageInfo(st) {
  if (!st) return null;
  return {
    engine: +st.engine.toFixed(2), body: +st.body.toFixed(2), glass: st.glass,
    lamps: `${st.lamps.filter((l) => l.broken).length}/${st.lamps.length}`,
    parts: st.parts.filter((p) => p.detached).map((p) => p.key),
    ...displaced(st.deformer),
  };
}

/** Clear traffic near the test spot and stop spawning there for the test. */
function clearAround(tr, x, z, r) {
  for (const a of [...tr.agents]) if (Math.hypot(a.cur.x - x, a.cur.z - z) < r) tr.remove(a);
}

/**
 * Drive the player's car into a standing AI car. o: { kmh = 60, mode: 'front'|'side'|'rear', type = 'pickup',
 * color = red, gap = 16 m run-up, view = true (park the camera for a look at the AI car afterwards) }
 */
export async function trafficCrash(game, o = {}) { // o.before(agent, vehicle): async hook before the run-up
  const { kmh = 60, mode = 'front', type = 'pickup', color = 0xb3202e, gap = 16, settleMs = 2500 } = o;
  const tr = game.traffic, dmg = game.damage;
  let v = game.player.mode === 'vehicle' ? game.player.controllable : null;
  if (!v?.physics || v.destroyed || o.car && v.catalogId !== o.car) { v = game.spawnForPlayer(o.car || 'comet'); await frames(5); }
  if (!v?.physics) throw new Error('player must be in a car');
  v.damage?.repair?.();
  const p0 = v.body.translation();
  const e = (game.__testEdge ||= pickRoad(tr, p0));
  if (!e) throw new Error('no straight road nearby');
  const s = e.len / 2;
  const T = tr.getType(type);
  const P = tr.lanePoint(e, 1, 0, s, {});
  const fwd = new THREE.Vector3(P.tx, 0, P.tz);
  const right = new THREE.Vector3(-P.tz, 0, P.tx);
  // player first (traffic despawns agents far from the player), colliders streamed in, then the AI car
  const park = new THREE.Vector3(P.x, P.y, P.z).addScaledVector(fwd, 60);
  v.reset(park, Math.atan2(fwd.x, fwd.z));
  game.streaming?.run(true);
  await frames(10);
  clearAround(tr, P.x, P.z, 90);
  while (tr.agents.length >= tr.max) {
    let far = null, fd = -1;
    for (const x of tr.agents) { const d = Math.hypot(x.cur.x - P.x, x.cur.z - P.z); if (d > fd) { fd = d; far = x; } }
    tr.remove(far);
  }
  const a = tr.spawnAt(e, 1, s, T);
  if (!a) throw new Error('spawn failed');
  a.paint.setHex(color);
  a.v = 0;
  if (o.kerb) { a.lane = tr.laneInfo(e).n - 1; for (let i = 0; i < 40 && Math.abs(a.err ?? 0) > 0.05 || i < 20; i++) await frames(1); }
  const hold = setInterval(() => { if (!a.crashed) { a.v = 0; a.vmax = 0; } }, 4);
  const ground = P.y;
  let at, dir;
  await frames(3);
  const c = a.cur;
  if (mode === 'side') { at = new THREE.Vector3(c.x, ground, c.z).addScaledVector(right, -gap); dir = right.clone(); }
  else if (mode === 'rear') { at = new THREE.Vector3(c.x, ground, c.z).addScaledVector(fwd, -gap); dir = fwd.clone(); }
  else { at = new THREE.Vector3(c.x, ground, c.z).addScaledVector(fwd, gap); dir = fwd.clone().negate(); }
  const yaw = Math.atan2(-dir.x, -dir.z);
  v.reset(at, yaw);
  v.damage?.repair?.();
  await frames(2);
  if (o.before) { await o.before(a, v); game.paused = false; v.reset(at, yaw); await frames(2); }
  const before = { agent: damageInfo(a.wreck), player: damageInfo(v.damage) };
  const stats0 = { ...dmg.stats };
  const ms = kmh / 3.6;
  // frame-time log around the impact
  const ft = [];
  let last = performance.now(), on = true;
  const tick = () => { const t = performance.now(); ft.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  v.physics.setVelocity({ x: dir.x * ms, y: 0, z: dir.z * ms });
  const t0 = performance.now();
  const hitWithin = (gap / ms) * 1000 + 600;
  await wait(Math.min(hitWithin, 4000));
  await wait(settleMs);
  on = false;
  clearInterval(hold);
  const sorted = [...ft].sort((x, y) => x - y);
  const res = {
    kmh, mode, type: T.name, ms: Math.round(performance.now() - t0),
    agent: { promoted: !!a.wreck, crashed: !!a.crashed, impacts: a.wreck?.log.map((r) => +r.e.toFixed(2)) ?? [], ...damageInfo(a.wreck) },
    player: damageInfo(v.damage),
    hp: dmg.agents.get(a)?.hp !== undefined ? +dmg.agents.get(a).hp.toFixed(2) : 1,
    frames: { n: ft.length, median: +sorted[sorted.length >> 1]?.toFixed(1), max: +sorted.at(-1)?.toFixed(1), over20: ft.filter((x) => x > 20).length },
    promote: { count: dmg.stats.promotions - stats0.promotions, lastMs: +dmg.stats.lastPromoteMs.toFixed(2), maxMs: +dmg.stats.maxPromoteMs.toFixed(2) },
    lastDeformMs: +dmg.stats.lastDeformMs.toFixed(3),
    template: dmg.templates.get(T) ? { tris: dmg.templates.get(T).tris, src: dmg.templates.get(T).srcTris, buildMs: +dmg.templates.get(T).buildMs.toFixed(1) } : null,
    before,
  };
  game.__crashTest = { a, v, res };
  return res;
}

/** Park the camera for a screenshot: looks at `target` (agent or vehicle) from (yawDeg, dist, height). */
export async function look(game, target, { yawDeg = 30, dist = 7, height = 2.2, pause = true } = {}) {
  const p = target.cur ? target.cur : target.body.translation();
  const q = target.cq ? target.cq : target.body.rotation();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  fwd.y = 0; fwd.normalize();
  const dir = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg));
  const cam = game.camera;
  if (pause) game.paused = true;
  cam.position.set(p.x + dir.x * dist, p.y + height, p.z + dir.z * dist);
  cam.lookAt(p.x, p.y + 0.2, p.z);
  cam.updateMatrixWorld();
  await frames(3);
}

export function resume(game) { game.paused = false; }

/** Lowest point of every crashed AI car vs the drivable surface under it (negative = below). */
export function sinkReport(game) {
  const tr = game.traffic;
  const RAPIER = game.RAPIER;
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const out = [];
  for (const a of tr.agents) {
    if (!a.crashed) continue;
    const bk = a.type.baked;
    const t = a.cur, q = a.cq, b = a.box || { hx: bk.width * 0.47, hy: a.halfH, hz: bk.length * 0.47, cy: 0 };
    const ryx = 2 * (q.x * q.y + q.z * q.w), ryy = 1 - 2 * (q.x * q.x + q.z * q.z), ryz = 2 * (q.y * q.z - q.x * q.w);
    const low = t.y + ryy * b.cy - (Math.abs(ryx) * b.hx + Math.abs(ryy) * b.hy + Math.abs(ryz) * b.hz);
    ray.origin = { x: t.x, y: t.y + 2.5, z: t.z };
    const hit = game.world.castRay(ray, 10, true, undefined, ((0xffff << 16) | 1) >>> 0);
    const surf = hit ? ray.origin.y - hit.timeOfImpact : null;
    // visual model ground (wheel contact) vs surface for upright cars
    const visGround = t.y - (a.lift + a.halfH) * ryy;
    out.push({ type: a.type.name, low: +(low - (surf ?? low)).toFixed(3), wheels: ryy > 0.9 ? +(visGround - (surf ?? visGround)).toFixed(3) : null, upright: +ryy.toFixed(2), frozen: !!a.frozen });
  }
  return { n: out.length, below: out.filter((r) => r.low < -0.03).length, minLow: Math.min(0, ...out.map((r) => r.low)), cars: out, stats: tr.stats };
}

/** Render once and POST the canvas as JPEG to a local receiver (dev only; e.g. a tiny CORS server on :5398). */
export async function shot(game, name, url = 'http://127.0.0.1:5398/') {
  game.render.render();
  const data = game.renderer.domElement.toDataURL('image/jpeg', 0.88);
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, data }) });
  return name;
}

/**
 * Main-thread work per frame (input.update → end of render.render), independent of rAF throttling in a background
 * tab. Returns { stop() → { n, median, p99, max, over } }.
 */
export function frameProbe(game, overMs = 8) {
  const inp = game.input, rnd = game.render;
  const u0 = inp.update, r0 = rnd.render;
  const list = [];
  let t0 = 0;
  inp.update = function (...a) { t0 = performance.now(); return u0.apply(this, a); };
  rnd.render = function (...a) { const r = r0.apply(this, a); if (t0) list.push(performance.now() - t0); t0 = 0; return r; };
  return {
    list,
    stop() {
      inp.update = u0; rnd.render = r0;
      const s = [...list].sort((x, y) => x - y);
      const q = (f) => +(s[Math.min(s.length - 1, Math.floor(s.length * f))] ?? 0).toFixed(2);
      return { n: s.length, median: q(0.5), p99: q(0.99), max: q(1), over: list.filter((x) => x > overMs).length };
    },
  };
}

/**
 * Sinking check: AI cars standing in the kerb lane are punted sideways onto the kerb / sidewalk and head-on, then
 * every crashed car is measured after settling. o.legacy = true: switch the fix off (no grounded collider, no CCD,
 * no safety net) for a before/after comparison.
 */
export async function sinkTest(game, o = {}) {
  const tr = game.traffic;
  const saved = { groundBox: tr.groundBox, settle: tr.settle };
  if (o.legacy) { tr.groundBox = () => {}; tr.settle = () => {}; }
  const runs = o.runs || [[90, 'side'], [120, 'side'], [120, 'front'], [70, 'side']];
  const rows = [];
  try {
    for (const [kmh, mode] of runs) {
      const r = await trafficCrash(game, { kmh, mode, kerb: true, gap: mode === 'side' ? 6.5 : 16, car: o.car || 'orkan_ts', settleMs: 3500, type: o.type || 'suv' });
      const a = game.__crashTest.a;
      if (o.legacy) a.body.enableCcd(false);
      const rep = sinkReport(game).cars.find((c, i) => tr.agents.filter((x) => x.crashed)[i] === a) || null;
      rows.push({ kmh, mode, e: r.agent.impacts, ...rep });
    }
  } finally { tr.groundBox = saved.groundBox; tr.settle = saved.settle; }
  return { rows, all: sinkReport(game) };
}

function partsInfo(st) {
  if (!st) return null;
  return {
    loose: st.parts.filter((p) => p.loose && !p.detached).map((p) => `${p.key}:${p.ang.toFixed(2)}`),
    off: st.parts.filter((p) => p.detached).map((p) => p.key),
    wheels: st.wheels.map((w) => ['ok', 'burst', 'off'][w.state]).join(','),
    puddles: st.puddles.length, state: st.state,
  };
}

/**
 * Full vehicles (the player's car): o.mode 'front' (into a parked semi), 'side' / 'rear' (an SUV is launched into the
 * player's car), 'roll' (rollover at speed), 'blast' (explosion 4 m away). Returns damage + panels / tyres + frame work.
 */
export async function vehicleCrash(game, o = {}) {
  const { kmh = 60, mode = 'front', car = 'meridian', settleMs = 3000 } = o;
  const tr = game.traffic;
  let v = game.player.mode === 'vehicle' ? game.player.controllable : null;
  if (!v?.physics || v.destroyed || v.catalogId !== car) { v = game.spawnForPlayer(car); await frames(5); }
  const e = (game.__testEdge ||= pickRoad(tr, v.body.translation()));
  const P = tr.lanePoint(e, 1, 0, e.len / 2, {});
  const fwd = new THREE.Vector3(P.tx, 0, P.tz), right = new THREE.Vector3(-P.tz, 0, P.tx);
  const base = new THREE.Vector3(P.x, P.y, P.z);
  const yawOf = (d) => Math.atan2(-d.x, -d.z);
  v.reset(base, yawOf(fwd));
  game.streaming?.run(true);
  await frames(8);
  clearAround(tr, P.x, P.z, 90);
  v.damage?.repair?.();
  v.reset(base, yawOf(fwd));
  await frames(3);
  const others = [];
  const ms = kmh / 3.6;
  const probe = frameProbe(game);
  const t0 = performance.now();
  if (mode === 'front') {
    const semi = game.vehicles.spawn('semi', base.clone().addScaledVector(fwd, 16), yawOf(right), {});
    others.push(semi);
    await frames(20);
    v.physics.setVelocity({ x: fwd.x * ms, y: 0, z: fwd.z * ms });
  } else if (mode === 'side' || mode === 'rear') {
    const from = mode === 'side' ? base.clone().addScaledVector(right, -14).addScaledVector(fwd, o.at ?? 0) : base.clone().addScaledVector(fwd, -16);
    const dir = mode === 'side' ? right.clone() : fwd.clone();
    const b = game.vehicles.spawn('monarch', from, yawOf(dir), {});
    others.push(b);
    await frames(20);
    b.physics.setVelocity({ x: dir.x * ms, y: 0, z: dir.z * ms });
  } else if (mode === 'roll') {
    v.physics.setVelocity({ x: fwd.x * ms, y: 0, z: fwd.z * ms });
    await frames(10);
    const m = v.body.mass();
    v.body.applyImpulse({ x: right.x * m * 6, y: m * 4.5, z: right.z * m * 6 }, true);
    v.body.applyTorqueImpulse({ x: fwd.x * m * 9, y: 0, z: fwd.z * m * 9 }, true);
  } else if (mode === 'park') {
    // just place the car on the test road (leaks, screenshots)
  } else if (mode === 'blast') {
    const p = base.clone().addScaledVector(right, 4);
    game.fx.explode({ x: p.x, y: p.y + 0.6, z: p.z }, o.power ?? 1);
  }
  await wait(settleMs);
  const work = probe.stop();
  const st = v.damage;
  const res = { mode, kmh, car, ms: Math.round(performance.now() - t0), ...damageInfo(st), ...partsInfo(st), work, lastDeformMs: +game.damage.stats.lastDeformMs.toFixed(2), maxImpactMs: +game.damage.stats.maxImpactMs.toFixed(2) };
  game.__vehTest = { v, others };
  return res;
}

export function cleanup(game) {
  for (const o of game.__vehTest?.others || []) if (game.vehicles.active.includes(o)) game.vehicles.despawn(o);
}
