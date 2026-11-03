// Economy lab (lab-economy.html): the real game with the economy module, the full vehicle catalog and a debug panel.
// URL: ?mode=single (default here) | online · ?basic (BasicPlayer instead of D's PlayerController) · ?fresh (wipe the
// singleplayer save first) · ?noTraffic · ?peds
import { createGame } from '/src/core/bootstrap.js';
import { BasicPlayer } from '/src/core/BasicPlayer.js';
import { economyModule } from './index.js';
import * as R from './rules.js';

const params = new URLSearchParams(location.search);
if (!params.has('mode')) { const u = new URL(location.href); u.searchParams.set('mode', 'single'); history.replaceState(null, '', u); }
if (params.has('fresh')) { try { localStorage.removeItem('leonida.save.single'); localStorage.removeItem('leonida.save.offline'); } catch { /* ignore */ } }

// D's PlayerController when it works, else BasicPlayer (both route addMoney → economy.earn)
let createPlayer = (g, sp) => new BasicPlayer(g, sp);
if (!params.has('basic')) {
  try {
    const { PlayerController } = await import('../characters/index.js');
    createPlayer = (g, sp) => {
      try { return new PlayerController(g, sp); } catch (e) { console.warn('[eco-lab] PlayerController failed, using BasicPlayer', e); return new BasicPlayer(g, sp); }
    };
  } catch (e) { console.warn('[eco-lab] PlayerController unavailable, using BasicPlayer', e); }
}

const t0 = performance.now();
const game = await createGame(document.getElementById('app'), {
  autostart: true,
  noTraffic: params.has('noTraffic'),
  noPeds: !params.has('peds'), // pedestrians are not needed here (?peds to enable)
  createPlayer,
  modules: [
    async (g) => {
      // full catalog so the garage (G) lists everything with prices
      try { const { VEHICLE_CATALOG } = await import('../vehicle/catalog.js'); g.vehicles.addCatalog(VEHICLE_CATALOG); } catch (e) { console.warn(e); }
      try { const { AIR_CATALOG, BOAT_CATALOG } = await import('../air/index.js'); g.vehicles.addCatalog([...AIR_CATALOG, ...BOAT_CATALOG]); } catch (e) { console.warn(e); }
      return null;
    },
    economyModule,
  ],
});
const bootMs = performance.now() - t0;
window.__lab = game;
window.__eco = game.economy;
const eco = game.economy, jobs = game.jobs, spawns = game.spawns;

// ---------- timing of the economy modules (ms per frame) ----------
const timing = { eco: 0, jobs: 0, score: 0, n: 0 };
for (const [key, mod] of [['eco', eco], ['jobs', jobs], ['score', game.score]]) {
  const orig = mod.update.bind(mod);
  mod.update = (...a) => { const s = performance.now(); orig(...a); timing[key] += performance.now() - s; };
}

// ---------- panel ----------
const panel = document.getElementById('panel');
const stats = document.getElementById('stats');
const sec = (t) => { const h = document.createElement('div'); h.className = 'h'; h.textContent = t; panel.appendChild(h); };
const btn = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { fn(); b.blur(); }; panel.appendChild(b); };
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const pos = () => { const f = game.player.focus; return { x: f.x, y: f.y, z: f.z }; };

function goTo(p) {
  const pl = game.player;
  pl.teleport(p.x - 30 * Math.sin(p.yaw || 0), p.z - 30 * Math.cos(p.yaw || 0));
}

sec('wallet');
btn('+$10k', () => eco.grant(10000));
btn('+$250k', () => eco.grant(250000));
btn('unlock all', () => eco.setUnlockAll(!eco.unlockAll));
btn('buy comet', async () => console.log('buy comet', await eco.buy('comet')));
btn('sell comet', async () => console.log('sell comet', await eco.sell('comet')));
btn('hospital fee', () => console.log('charged', eco.charge('hospital')));
sec('skill (combo)');
btn('near miss 160', () => game.score.pay('nearmiss', R.nearMissPay(160, 1), { kmh: 160 }));
btn('drift 5 s', () => game.score.pay('drift', R.driftPoints(90, 0.8, 5) / R.DRIFT.divisor, { duration: 5 }));
btn('stunt 2.5 s', () => game.score.pay('stunt', R.stuntPay(2.5, 6), { air: 2.5 }));
btn('speed trap 230', () => eco.speedTrap(1, 230, pos()));
btn('crash', () => game.events.emit('impact', { source: game.player.controllable, strength: 0.5, kind: 'building', position: pos() }));
btn('collectible', () => eco.collect(eco.found.size + 1, pos()));
sec('places');
for (const d of jobs.depots) btn(`depot ${d.id}`, () => goTo(d));
for (const y of jobs.yards) btn(`yard ${y.id}`, () => goTo(y));
for (const s of jobs.shops) btn(`shop ${s.id}`, () => goTo(s));
btn('start slot', () => { const s = spawns.pickSpawn('start'); game.player.teleport(s.x, s.z); });
btn('hospital slot', () => { const s = spawns.pickSpawn('hospital', pos()); game.player.teleport(s.x, s.z); });
sec('jobs');
btn('contract here', () => { const d = jobs.depots.reduce((a, b) => (Math.hypot(a.x - pos().x, a.z - pos().z) < Math.hypot(b.x - pos().x, b.z - pos().z) ? a : b)); jobs._depot(d, game.player.controllable); });
btn('arrive (teleport)', () => { const j = jobs.job; if (j) game.player.teleport(j.dest.x, j.dest.z); });
btn('cancel job', () => jobs.cancel());
btn('mark car stolen', () => { const v = game.player.controllable; if (v) { v.fromTraffic = true; game.events.emit('vehicle:enter', { vehicle: v }); } });
btn('damage car 40%', () => { const d = game.player.controllable?.damage; if (d) { d.body = 0.6; d.engine = 0.6; } });
sec('services');
const svc = async (id, opts) => { const v = game.player.controllable; const r = await eco.buyService(id, v?.catalogId, opts); console.log('service', id, r); log.unshift(`service ${id} ${r.ok ? `-$${r.cost}` : r.reason}`); };
btn('buy current car', async () => { const id = game.player.controllable?.catalogId; if (id) console.log(await eco.buy(id)); });
btn('repair', () => svc('repair'));
btn('extinguisher', () => svc('extinguisher'));
btn('ignite car', () => { const v = game.player.controllable; if (v) game.damage?.ignite?.(v, 8); });
btn('armour', () => svc('armor'));
btn('insurance', () => svc('insurance'));
btn('nitro', () => { const v = game.player.controllable; if (v?.physics) v.physics.boostLevel = 0.1; svc('nitro'); });
btn('neon', () => { const id = game.player.controllable?.catalogId; const c = eco.custom(id); if (c?.neonKit) eco.setNeon(id, ((c.neon ?? -1) + 1) % 8); else svc('neon', { color: 0 }); });
btn('tint', () => svc('tint'));
btn('horn: truck', () => svc('horn', { variant: 'truck' }));
btn('respray pearl', () => svc('respray', { color: Math.floor(Math.random() * 0xffffff), finish: 'pearl' }));
btn('explode car', () => { const v = game.player.controllable; if (v) game.damage?.explode?.(v); });
sec('save');
btn('save now', () => eco.save());
btn('wipe save', () => { eco.wipe(); location.reload(); });
btn('hide panel', () => document.getElementById('lab').classList.add('min'));

// ---------- events log ----------
const log = [];
for (const n of ['economy:earn', 'economy:charge', 'economy:purchase', 'economy:sell', 'economy:combo', 'economy:discovered', 'job:start', 'job:complete', 'job:fail', 'export:complete']) {
  game.events.on(n, (p) => {
    const short = n.split(':')[1];
    const txt = n === 'economy:earn' ? `${p.reason} +${p.amount}${p.combo > 1 ? ` ×${p.combo}` : ''}` : n === 'economy:combo' ? `combo ×${p.combo}${p.reason ? ` (${p.reason})` : ''}` : `${short} ${JSON.stringify(p, (k, v) => (k === 'vehicle' || k === 'position' || k === 'source' ? undefined : v)).slice(0, 60)}`;
    log.unshift(txt);
    if (log.length > 7) log.pop();
  });
}

let acc = 0, frames = 0;
game.events.on('start', () => {});
(function tick() {
  requestAnimationFrame(tick);
  frames++;
  acc += 1;
  if (frames % 15) return;
  const n = Math.max(1, frames);
  const p = game.player, v = p.controllable, f = p.focus;
  const job = jobs.job;
  const q = v ? jobs.exportQuote(v) : null;
  stats.textContent = [
    `mode ${game.mode}${eco.remote ? ' (server)' : ' (local)'} · boot ${bootMs.toFixed(0)} ms · slots ${spawns.start.length} (${spawns.buildMs.toFixed(1)} ms)`,
    `money ${money(eco.money)} · worth ${money(eco.netWorth())}`,
    `combo ×${eco.combo} (${eco.comboT.toFixed(1)} s) · owned ${eco.owned.size}${eco.unlockAll ? ' +ALL' : ''}`,
    `districts ${eco.districts.size} · found ${eco.found.size} · daily d${eco.daily.streak}`,
    `ext ${eco.inventory.extinguisher} · insured ${eco.insured ? `${(eco.insuranceLeftS() / 3600).toFixed(1)} h` : 'no'} · wrecked ${Object.keys(eco.wrecked).join(',') || '—'}`,
    `custom ${v ? JSON.stringify(eco.custom(v.catalogId) || {}) : '—'}${v?.armored ? ' ARMOURED' : ''}`,
    `pos ${f.x.toFixed(0)}, ${f.z.toFixed(0)} · ${game.world3d.areaAt(f.x, f.z).name}`,
    `vehicle ${v?.catalogId ?? '—'}${v?.fromTraffic ? ' (stolen)' : ''} · ${(v?.telemetry?.speedKmh ?? 0).toFixed(0)} km/h`,
    q ? `export ${money(q.pay)}${q.wanted ? ' WANTED' : ''}${q.blocked ? ` [${q.blocked}]` : ''}` : 'export —',
    job ? `JOB → ${job.dest.name} ${(job.routeM / 1000).toFixed(1)} km · ${job.left.toFixed(0)} s · ≤ ${money(job.maxPay)}` : 'no job',
    `ms/frame eco ${(timing.eco / n).toFixed(3)} jobs ${(timing.jobs / n).toFixed(3)} score ${(timing.score / n).toFixed(3)}`,
    '— events —',
    ...log,
  ].join('\n');
})();
