import * as THREE from 'three';
import { createGame } from '/src/core/bootstrap.js';
import { FX } from './FX.js';
import { DamageSystem } from '../damage/DamageSystem.js';
import { BUILDING, TREE_IMPULSE } from '../damage/Destruction.js';
import { GROUPS, groups } from '../vehicle/groups.js';

// FX / damage / destruction test bench.
const qs = new URLSearchParams(location.search);
const spawn = qs.has('x') ? { x: +qs.get('x'), z: +qs.get('z') } : undefined;
// ?timer: drive the loop with timers (headless/hidden tabs where requestAnimationFrame is paused)
const frameMs = [];
if (qs.has('timer')) {
  window.requestAnimationFrame = (cb) => setTimeout(() => {
    const t0 = performance.now();
    cb(t0);
    frameMs.push(performance.now() - t0);
    if (frameMs.length > 600) frameMs.shift();
  }, 16);
}
const panel = document.getElementById('fxlab');
const statsEl = panel.querySelector('.stats');

const game = await createGame(document.getElementById('app'), {
  autostart: true,
  spawn,
  noPeds: qs.has('lite'),
  modules: [(g) => {
    g.fx = new FX(g);
    g.damage = new DamageSystem(g);
    g.register(g.fx, g.fx.order);
    return g.damage;
  }],
});
const t = (key, en) => { const r = game.i18n?.t?.(key); return r && r !== key ? r : en; };
const fx = game.fx, damage = game.damage;
// cameras read fx.shake / 'camera:shake'; bridge to the basic chase camera here
game.events.on('camera:shake', ({ amount }) => game.player?.chase?.shake?.(amount));

const _v = new THREE.Vector3();
const ray = new game.RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
const car = () => game.player.controllable;
const carPos = () => { const p = car().body.translation(); return new THREE.Vector3(p.x, p.y, p.z); };
const carFwd = () => _v.set(0, 0, -1).applyQuaternion(car().object3d.quaternion).setY(0).normalize().clone();

// point under the screen centre (ground/buildings), else 20 m ahead of the car
function cameraTarget(max = 400) {
  const cam = game.camera;
  const d = cam.getWorldDirection(new THREE.Vector3());
  ray.origin = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
  ray.dir = { x: d.x, y: d.y, z: d.z };
  const hit = game.world.castRay(ray, max, true, game.RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, groups(0xffff, GROUPS.GROUND | GROUPS.STATIC));
  if (hit) return cam.position.clone().addScaledVector(d, hit.timeOfImpact).add(new THREE.Vector3(0, 0.6, 0));
  const p = carPos().addScaledVector(carFwd(), 20);
  p.y = groundY(p.x, p.z) + 0.6;
  return p;
}
const groundY = (x, z) => fx.decals.groundY(x, z);

let power = 1, speed = 100;
const actions = {
  explode() { fx.explode(cameraTarget(), power); },
  fire() { car().damage?.ignite(); },
  smoke() { const d = car().damage; if (d) { d.engine = Math.min(d.engine, 0.3); } },
  repair() { car().damage?.repair(); },
  crash() { crashTest(speed); },
  building() { destroyNearestBuilding(false); },
  collapse() { destroyNearestBuilding(true); },
  tree() { breakNearestTree(); },
  chain() { chainReaction(); },
  traffic() { igniteNearestAgent(); },
  suburb() { goSuburb(); },
  clear() { fx.clear(); },
  mode() {
    damage.trafficMode = damage.trafficMode === 'instanced' ? 'takeover' : 'instanced';
    buttons.mode.textContent = `${t('fxlab.trafficMode', 'Traffic wrecks')}: ${damage.trafficMode}`;
  },
};

// ---------- tests ----------

let wall = null;
function crashTest(kmh) {
  const v = car();
  v.damage?.repair();
  const p = carPos(), f = carFwd();
  const wc = p.clone().addScaledVector(f, 14 + kmh * 0.12);
  const gy = groundY(wc.x, wc.z);
  const yaw = Math.atan2(f.x, f.z);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (wall) { game.world.removeRigidBody(wall.body); wall.mesh.removeFromParent(); }
  const body = game.world.createRigidBody(game.RAPIER.RigidBodyDesc.fixed().setTranslation(wc.x, gy + 2, wc.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
  game.world.createCollider(game.RAPIER.ColliderDesc.cuboid(7, 2.5, 0.6).setFriction(0.6).setCollisionGroups(groups(GROUPS.STATIC, 0xffff)), body);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 1.2), new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.9, flatShading: true }));
  mesh.position.set(wc.x, gy + 2, wc.z);
  mesh.quaternion.copy(q);
  mesh.castShadow = mesh.receiveShadow = true;
  game.scene.add(mesh);
  wall = { body, mesh };
  const sp = kmh / 3.6;
  const b = v.body;
  b.setLinvel({ x: f.x * sp, y: 0, z: f.z * sp }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  game.ui?.toast?.(t('fxlab.crash', 'CRASH TEST'), `${kmh} km/h`, 2);
}

function nearestBuilding(smallOnly) {
  const B = game.buildings, p = carPos();
  let best = null, bd = Infinity;
  for (const id of B.query(p.x, p.z, 220)) {
    const info = B.info(id);
    if (!info || info.removed) continue;
    if (smallOnly && !BUILDING.small(info)) continue;
    const d = Math.hypot(info.center.x - p.x, info.center.z - p.z);
    if (d < bd) { bd = d; best = info; }
  }
  return best;
}

function destroyNearestBuilding(direct) {
  const info = nearestBuilding(direct);
  if (!info) return game.ui?.toast?.(t('fxlab.none', 'NOTHING NEARBY'), '', 2);
  const p = carPos();
  const dir = { x: info.center.x - p.x, z: info.center.z - p.z };
  const l = Math.hypot(dir.x, dir.z) || 1;
  dir.x /= l; dir.z /= l;
  if (direct) { damage.destruction.collapse(info.id, info, dir, 120); return; }
  // explosion right at the facade facing the player
  let best = null, bd = Infinity;
  const fp = info.footprint;
  for (let i = 0; i < fp.length; i++) {
    const [ax, az] = fp[i], [bx, bz] = fp[(i + 1) % fp.length];
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const d = Math.hypot(mx - p.x, mz - p.z);
    if (d < bd) { bd = d; best = [mx, mz]; }
  }
  const ex = best[0] - dir.x * 1.5, ez = best[1] - dir.z * 1.5;
  fx.explode({ x: ex, y: groundY(ex, ez) + 1, z: ez }, Math.max(power, 1.5));
}

function breakNearestTree() {
  const p = carPos();
  let best = null, bd = Infinity;
  for (const tr of game.veg.query(p.x, p.z, 150)) {
    if (!(tr.type in TREE_IMPULSE) || tr.type === 'bush' || tr.type === 'reed') continue;
    const raw = game.veg.scatters[tr.type].raw;
    const d = Math.hypot(raw[tr.id * 6] - p.x, raw[tr.id * 6 + 2] - p.z);
    if (d < bd) { bd = d; best = { ...tr, x: raw[tr.id * 6], y: raw[tr.id * 6 + 1], z: raw[tr.id * 6 + 2] }; }
  }
  if (!best) return game.ui?.toast?.(t('fxlab.none', 'NOTHING NEARBY'), '', 2);
  game.streaming?.run(true);
  const l = Math.hypot(best.x - p.x, best.z - p.z) || 1;
  damage.destruction.breakTree(best.type, best.id, { x: best.x, y: best.y, z: best.z }, { x: (best.x - p.x) / l, z: (best.z - p.z) / l }, 2);
}

function chainReaction() {
  const p = carPos(), f = carFwd();
  const side = new THREE.Vector3(-f.z, 0, f.x);
  const ids = game.vehicles.catalog.map((c) => c.id).filter((id) => !/heli|plane|boat|bike|bicycle|moto/i.test(id));
  const cars = [];
  for (let i = 0; i < 5; i++) {
    const c = p.clone().addScaledVector(f, 22).addScaledVector(side, (i - 2) * 5.8);
    c.y = groundY(c.x, c.z) + 0.3;
    cars.push(game.vehicles.spawn(ids[i % ids.length], c, Math.atan2(-side.x, -side.z) + (Math.random() - 0.5) * 0.4, { spotLights: false }));
  }
  setTimeout(() => cars[0]?.damage?.explode(), 1200);
}

function igniteNearestAgent() {
  const a = game.traffic?.nearestAgent?.(carPos(), 150, (x) => !x.burning);
  if (!a) return game.ui?.toast?.(t('fxlab.none', 'NOTHING NEARBY'), '', 2);
  const rec = damage.agentHit(a, 0.01) || damage.agents.get(a);
  if (rec) damage.igniteAgent(rec, 6);
}

function goSuburb() {
  const B = game.buildings;
  let best = null, bn = 0;
  for (let k = 0; k < 400; k++) {
    const id = (Math.random() * B.recs.length) | 0;
    const r = B.recs[id];
    if (!r || r.removed || r.style !== 3) continue;
    const n = B.query(r.cx, r.cz, 70).filter((j) => B.recs[j]?.style === 3).length;
    if (n > bn) { bn = n; best = r; }
  }
  if (best) game.player.teleport(best.cx + 12, best.cz + 12);
}

// ---------- panel ----------

const buttons = {};
const ui = [
  ['explode', 'fxlab.explode', 'Explode at camera target [X]'],
  ['fire', 'fxlab.fire', 'Set my car on fire [Y]'],
  ['smoke', 'fxlab.smoke', 'Damage engine (smoke)'],
  ['repair', 'fxlab.repair', 'Repair my car [J]'],
  ['crash', 'fxlab.crashBtn', 'Crash test into a wall [K]'],
  ['building', 'fxlab.building', 'Blow up nearest building [B]'],
  ['collapse', 'fxlab.collapse', 'Collapse nearest small building'],
  ['tree', 'fxlab.tree', 'Break nearest tree'],
  ['chain', 'fxlab.chain', 'Chain reaction (5 cars) [N]'],
  ['traffic', 'fxlab.traffic', 'Ignite nearest AI car'],
  ['suburb', 'fxlab.suburb', 'Teleport to a suburb'],
  ['mode', 'fxlab.trafficMode', 'Traffic wrecks: instanced'],
  ['clear', 'fxlab.clear', 'Clear FX'],
];
const slider = (label, min, max, step, val, fn) => {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${val}"><span>${val}</span>`;
  const inp = row.querySelector('input'), out = row.querySelector('span');
  inp.oninput = () => { out.textContent = inp.value; fn(+inp.value); };
  inp.addEventListener('keydown', (e) => e.stopPropagation());
  panel.appendChild(row);
};
slider(t('fxlab.power', 'Power'), 0.3, 4, 0.1, power, (v) => (power = v));
slider(t('fxlab.speed', 'Crash km/h'), 20, 200, 5, speed, (v) => (speed = v));
panel.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
for (const [k, key, en] of ui) {
  const b = document.createElement('button');
  b.textContent = t(key, en);
  b.onclick = (e) => { e.currentTarget.blur(); actions[k](); };
  panel.appendChild(b);
  buttons[k] = b;
}
panel.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: t('fxlab.hint', 'Drive with WASD. Free camera: V. Stats: particles / debris / last costs.') }));

const keys = { KeyX: 'explode', KeyY: 'fire', KeyJ: 'repair', KeyK: 'crash', KeyB: 'building', KeyN: 'chain' };
addEventListener('keydown', (e) => { if (keys[e.code] && !e.repeat) actions[keys[e.code]](); });

let acc = 0;
game.register({
  update(dt) {
    acc += dt;
    if (acc < 0.25) return;
    acc = 0;
    const d = car()?.damage;
    statsEl.textContent = [
      `FPS ${game.fps}   ${game.quality?.name ?? game.render?.quality ?? ''}`,
      `particles ${fx.particleCount}  (fl ${fx.flames.count} sm ${fx.puffs.count} sp ${fx.sparkSys.count} ch ${fx.chunks.count})`,
      `debris ${fx.debrisSys.items.length}/${fx.debrisSys.cap}  parts ${fx.debrisSys.meshItems.length}  emitters ${fx.emitters.length}`,
      `rubble ${damage.destruction.rubble.length}  collapses ${damage.destruction.stats.collapses}  trees ${damage.destruction.stats.trees}`,
      `explode ${fx.stats.lastExplodeMs.toFixed(2)} ms  collapse ${damage.destruction.stats.lastCollapseMs.toFixed(2)} ms`,
      `impact ${damage.stats.lastImpactMs.toFixed(2)} ms  deform ${damage.stats.lastDeformMs.toFixed(2)} ms`,
      d ? `car: engine ${(d.engine * 100) | 0}%  body ${(d.body * 100) | 0}%  ${d.state}${d.state === 'burning' ? ` ${(d.fuse - d.burnT).toFixed(1)}s` : ''}` : '',
      `player hp ${(game.player.health ?? 0).toFixed(2)}  shake ${fx.shake.toFixed(2)}`,
    ].join('\n');
  },
}, 100);

// free camera looking at a point (for screenshots)
function view(from, to) {
  game.player.setFree?.(true);
  game.camera.position.set(from.x, from.y, from.z);
  game.camera.lookAt(to.x, to.y, to.z);
  game.player.free?.enable(game.camera);
}

window.__fxlab = { game, fx, damage, actions, cameraTarget, view, frameMs, crashTest, chainReaction, destroyNearestBuilding, breakNearestTree, nearestBuilding };
