import { createGame } from '../core/bootstrap.js';
import { createLife } from './index.js';

// Life lab: world + life module only (no UI). URL params: ?x=..&z=.. spawn, ?hour=21, ?photo (enter photo mode),
// ?mode=single (persist progress in localStorage), ?eco (with the economy module), ?shots=<port> (snapshot sink). Exposes window.__leonida (game) and game.life.
const qs = new URLSearchParams(location.search);
const spawn = qs.has('x') ? { x: +qs.get('x'), z: +qs.get('z') } : { x: 1990, z: -1180 };
const panel = document.getElementById('lifelab');
const stats = panel.querySelector('.stats');
panel.querySelector('h3').onclick = () => panel.classList.toggle('min');

// ?eco adds the economy module (workstream L) so rewards go through game.economy
const eco = qs.has('eco') ? (await import('../economy/index.js')).economyModule : null;
const game = await createGame(document.getElementById('app'), {
  autostart: true, noUI: true, spawn, hour: qs.has('hour') ? +qs.get('hour') : undefined,
  modules: [...(eco ? [eco] : []), (g) => createLife(g)],
});
const life = game.life;
if (qs.has('hour')) game.sky.setTime(+qs.get('hour'));
window.__life = life;

const events = [];
for (const n of ['collectible:pickup', 'collectible:set', 'race:countdown', 'race:start', 'race:checkpoint', 'race:finish', 'race:cancel', 'speedtrap', 'photo:enter', 'photo:exit', 'photo:capture']) {
  game.events.on(n, (p) => { events.unshift(`${n} ${JSON.stringify(p, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)).slice(0, 90)}`); events.length = Math.min(events.length, 6); });
}

const go = (x, z) => { game.player.teleport(x, z); };
const plan = life.beach?.plan;
const sections = [
  ['Places', [
    ['Vice Beach', () => go(2000, -1150)], ['Washington Beach', () => go(1960, -2100)], ['Pier', () => { const p = plan?.piers[0]; if (p) go(p.x0 - p.dx * 30, p.z0 - p.dz * 30); }],
    ['Marina', () => { const y = plan?.yachts[0]; if (y) go(y.x, y.z); }], ['Downtown', () => go(-640, 120)], ['Capri', () => go(-6640, 0)],
    ['Wetlands', () => go(-3850, 4090)], ['Keys', () => go(-2480, 5900)],
  ]],
  ['Time', [['06:30', () => game.sky.setTime(6.5)], ['12:00', () => game.sky.setTime(12)], ['17:40', () => game.sky.setTime(17.7)], ['21:30', () => game.sky.setTime(21.5)], ['00:30', () => game.sky.setTime(0.5)]]],
  ['Races', (life.races?.routes || []).map((r, i) => [r.def.name.split(' ')[0], () => { const s = r.start; go(s.x - Math.sin(s.yaw) * 25, s.z - Math.cos(s.yaw) * 25); }])],
  ['Fun', [
    ['Nearest postcard', () => { const n = life.collectibles?.nearest(game.player.focus.x, game.player.focus.z); if (n) go(n.spot.x + 12, n.spot.z + 12); }],
    ['Speed trap', () => { const t = life.traps?.traps[0]; if (t) go(t.x - t.tx * 400, t.z - t.tz * 400); }],
    ['Photo mode (P)', () => life.photo?.enter()], ['Reset postcards', () => life.collectibles?.reset()],
  ]],
];
for (const [title, btns] of sections) {
  const h = document.createElement('h4'); h.textContent = title; panel.appendChild(h);
  for (const [label, fn] of btns) {
    const b = document.createElement('button'); b.textContent = label; b.onclick = (e) => { fn(); e.target.blur(); }; panel.appendChild(b);
  }
}
const hint = document.createElement('div');
hint.className = 'hint';
hint.innerHTML = 'Stop in a pink race marker and press <b>E</b> (D-pad up). <b>P</b> photo mode. Postcards glow gold. Speed traps on highways.';
panel.appendChild(hint);
if (qs.has('photo')) setTimeout(() => life.photo?.enter(), 600);

const c = life.stats.counts;
setInterval(() => {
  const s = life.stats, f = game.player.focus;
  const area = game.world3d.areaAt(f.x, f.z).name;
  stats.textContent = [
    `fps ${game.fps}  life cpu ${s.cpuMs.toFixed(3)} ms (max ${s.cpuMax.toFixed(2)})`,
    `init ${s.init.total} ms  beach ${s.init.beach} sign ${s.init.signage}`,
    `     races ${s.init.races} pc ${s.init.collectibles} warm ${s.init.prewarm}`,
    `pos ${f.x.toFixed(0)}, ${f.z.toFixed(0)}  ${area}  ${game.sky.clock}`,
    `umbrellas ${c.umbrellas} towers ${c.towers} piers ${c.pierEnd}`,
    `yachts ${c.yachts + c.sails} buoys ${c.buoys} kiosks ${c.kiosks}`,
    `boards ${c.highway}+${c.rooftop} blades ${c.blades} neon ${c.strips}`,
    `birds ${life.birds?.activeCount ?? 0}/${c.birdsMax}  colliders ${life.colliders.live.size}/${c.colliders}`,
    `postcards ${life.collectibles?.count}/${c.postcards}  races ${c.races}  traps ${c.speedTraps}`,
    `money $${game.economy?.money ?? game.player.money}  mode ${game.mode ?? '?'}${game.economy ? ' eco' : ''}`,
    ...events,
  ].join('\n');
}, 250);

// ---- lab automation helpers (window.lab): orbit view + offscreen snapshot (works while the page is hidden).
// ?shots=<port> uploads JPEG snapshots to http://127.0.0.1:<port>/<name> (any tiny POST sink).
window.lab = {
  async view(x, y, z, yaw, pitch, dist, fov = 55) {
    const P = life.photo;
    if (!P.active) { P.enter(); P.root.classList.add('hide'); }
    P.origin.set(x, y, z); P.target.set(x, y, z); P.yaw = yaw; P.pitch = pitch; P.dist = dist; P.p.fov = fov;
    return 'ok';
  },
  leave() { if (life.photo.active) life.photo.exit(); },
  async snap(name, w = 800) {
    const P = life.photo;
    if (P.active) { P.applyCamera(); P.refreshWorld(); } else game.camera.updateMatrixWorld();
    life.visual(game.camera, 0, true);
    game.render.render(); game.render.render();
    const src = game.renderer.domElement, h = Math.round((w * src.height) / src.width);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    if (P.active) x.filter = src.style.filter || 'none';
    x.drawImage(src, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    const port = qs.get('shots');
    if (port) await fetch(`http://127.0.0.1:${port}/${name}`, { method: 'POST', body: blob, mode: 'no-cors' });
    return `${name} ${blob.size}`;
  },
  // advance the simulation n frames manually (hidden tabs get no rAF)
  step(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      game.input.update();
      game.frame++;
      game.time += dt; game.uniforms.uTime.value = game.time;
      game.fixedUpdate(dt); game.traffic?.fixedUpdate(dt); game.world.step(game.eventQueue); game.traffic?.postStep();
      // same 'contact' events as bootstrap drainEvents (props, lamps react to them)
      game.eventQueue.drainContactForceEvents((ev) => {
        const h1 = ev.collider1(), h2 = ev.collider2(), d = ev.totalForce(), fl = Math.hypot(d.x, d.z) || 1;
        game.events.emit('contact', { c1: game.world.getCollider(h1), c2: game.world.getCollider(h2), h1, h2, force: ev.totalForceMagnitude(), dirX: d.x / fl, dirZ: d.z / fl });
      });
      game.eventQueue.drainCollisionEvents(() => {});
      game.postStep(dt);
      game.update(dt, 1); game.lateUpdate(dt); game.camera.updateMatrixWorld();
      game.sky.update(dt, game.player.focus);
    }
  },
};
