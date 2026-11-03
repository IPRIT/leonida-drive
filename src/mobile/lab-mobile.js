// Mobile lab: the game with the touch layer forced on (works with a mouse too: every control is a pointer target).
// Query: ?ui=0 (no HUD/menu) · ?player=basic (BasicPlayer instead of the on-foot PlayerController) · ?foot=1 (start on
// foot) · ?air=0 (no aircraft/boats) · ?touch=0 (disable the touch layer) · ?mobile=1 (force the mobile perf profile)
// · ?touch=auto (real device detection) · ?veh=<catalogId> · ?x=&z= spawn · ?hour= time of day.
import { createGame } from '/src/core/bootstrap.js';
import { createMobile } from './index.js';

const params = new URLSearchParams(location.search);
if (!params.has('mode')) { const u = new URL(location.href); u.searchParams.set('mode', 'single'); history.replaceState(null, '', u); }
const app = document.getElementById('app');
const mods = [];
if (params.get('air') !== '0') {
  mods.push(async (g) => { try { const air = await import('/src/air/index.js'); air.airModule(g); } catch (e) { console.warn('[lab] air module unavailable', e); } return null; });
}
// ?touch=auto → real detection; default: forced on (so the lab works with a mouse on desktop)
const touch = params.get('touch') === 'auto' ? undefined : params.get('touch') !== '0';
mods.push((g) => createMobile(g, { touch }));

let createPlayer;
if (params.get('player') !== 'basic') {
  try {
    const { PlayerController } = await import('/src/characters/index.js');
    createPlayer = (g, sp) => new PlayerController(g, sp, { startOnFoot: params.get('foot') === '1' });
  } catch (e) { console.warn('[lab] PlayerController unavailable, using BasicPlayer', e); }
}

const game = await createGame(app, {
  autostart: true,
  noUI: params.get('ui') === '0',
  spawn: { x: Number(params.get('x') ?? 1745), z: Number(params.get('z') ?? -640) },
  vehicle: params.get('veh') || undefined,
  createPlayer,
  modules: mods,
});
if (params.get('hour')) game.sky.setTime(Number(params.get('hour')));
window.__lab = game;

// ---- panel
const lab = document.getElementById('mlab');
document.getElementById('mlab-toggle').addEventListener('click', () => lab.classList.toggle('open'));
const btns = document.getElementById('mlab-btns');
const add = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); btns.appendChild(b); };
const spawn = (id) => { try { game.spawnForPlayer(id); } catch (e) { console.error(e); } };
add('car', () => spawn('comet'));
add('moto', () => spawn('fulmine'));
add('heli', () => spawn('heli_news'));
add('plane', () => spawn('plane_trainer'));
add('boat', () => spawn('boat_speed'));
add('on foot', () => game.player.exit?.({ instant: true }));
add('free cam', () => game.player.setFree?.(game.player.mode !== 'free'));
add('flip car', () => { const v = game.player.controllable; if (v?.body) { v.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true); v.body.setTranslation({ ...v.body.translation(), y: v.body.translation().y + 2 }, true); } });
add('tilt on/off', () => game.applySetting('tiltSteer', !game.settings.tiltSteer));
add('left-handed', () => game.applySetting('touchLeftHanded', !game.settings.touchLeftHanded));
add('size −', () => game.applySetting('touchScale', Math.max(0.6, +((game.settings.touchScale ?? 1) - 0.1).toFixed(2))));
add('size +', () => game.applySetting('touchScale', Math.min(1.6, +((game.settings.touchScale ?? 1) + 0.1).toFixed(2))));
add('120 fps', () => game.applySetting('mobileFps', (game.settings.mobileFps ?? 60) >= 120 ? 60 : 120));
add('menu', () => game.ui?.open?.());

const stats = document.getElementById('mlab-stats');
let t = 0;
game.register({
  update(dt) {
    t -= dt;
    if (t > 0 || !lab.classList.contains('open')) return;
    t = 0.25;
    const m = game.mobile, pad = m?.pad, c = m?.controls;
    const ax = pad ? pad.axes.map((v) => v.toFixed(2)).join(' ') : '-';
    const on = pad ? pad.buttons.map((b, i) => (b.pressed ? `${i}:${b.value.toFixed(2)}` : null)).filter(Boolean).join(' ') : '';
    const r = game.render?.stats?.() ?? {};
    stats.textContent = `${game.fps} fps · cap ${m?.fpsCap() || '∞'} · ${r.quality ?? game.render?.profile?.name} · DPR ${game.renderer.getPixelRatio().toFixed(2)} · ${innerWidth}×${innerHeight}
ctx ${c?.ctx} · ${m?.orientation} · visible ${c?.visible} · tilt ${m?.tilt.live ? m.tilt.value.toFixed(2) : 'off'}
axes ${ax}
btn ${on || '-'}
profile: ${m?.profile?.reason}
device: ${m?.device?.reasons.join('; ') || '-'}`;
  },
}, 90);
