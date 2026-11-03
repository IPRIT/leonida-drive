// Air & sea lab: boots the real game and adds spawn buttons, teleports, telemetry and a controls overlay.
import { createGame } from '/src/core/bootstrap.js';
import { AIR_CATALOG, BOAT_CATALOG } from './index.js';
import { findRunways, runwayStart } from './runways.js';

const params = new URLSearchParams(location.search);

const HELP = {
  heli: '<b>Space</b> climb · <b>Shift</b> descend · <b>W/S</b> nose down/up · <b>A/D</b> bank · <b>Q/E</b> yaw<br><b>N</b> hover assist · <b>H</b> light/searchlight · <b>L</b> strobes · <b>C</b> camera · drag mouse: look<br>Gamepad: LS cyclic · RT/LT up/down · LB/RB yaw · d-pad → assist',
  plane: '<b>Shift</b>/<b>Z</b> throttle up/down · <b>S</b> pull · <b>W</b> push · <b>A/D</b> roll · <b>Q/E</b> rudder<br><b>Space</b> brakes · <b>G</b> flaps · <b>B</b> gear · <b>N</b> flight assist · <b>X</b> smoke (stunt) · <b>C</b> camera<br>Pointer lock (button) → mouse yoke · Gamepad: LS stick · RT/LT throttle · LB/RB rudder · A brakes · d-pad ↓ flaps, ← gear',
  boat: '<b>W</b> throttle · <b>S</b> reverse · <b>A/D</b> steer · <b>Space</b> idle · <b>H</b> lights · <b>C</b> camera<br>Gamepad: RT/LT throttle/reverse · LS steer',
};

const SPOTS = [
  ['VCIA runway', -3300, 258],
  ['Goose Key airfield', -7000, 6200],
  ['Biscayne bay', 600, -600],
  ['Grassrivers swamp', -5200, 2700],
  ['Downtown', -634, 152],
  ['Ocean Beach surf', 2400, -1500],
];

function labModule(game) {
  game.vehicles.addCatalog([...AIR_CATALOG, ...BOAT_CATALOG]);
  const el = document.getElementById('air-lab');
  const tele = document.getElementById('air-tele');
  const help = document.getElementById('air-help');
  let airStart = false;
  const perf = { ms: 0 };

  const cur = () => game.player.controllable;
  const spawnHere = (id, x, z) => {
    const p = cur()?.body?.translation() || game.player.focus;
    const px = x ?? p.x, pz = z ?? p.z;
    const old = cur();
    const v = game.vehicles.spawn(id, { x: px, y: Math.max(game.terrain.heightAt(px, pz), 0), z: pz }, old ? yawOf(old) : 0, { air: airStart });
    if (old) game.vehicles.despawn(old);
    game.player.enter(v);
    game.streaming?.run(true);
    v.camera?.snap?.(v);
    wrapPerf(v);
    game.ui?.showVehicleName?.(v.name, v.entry?.brand || '');
    help.innerHTML = HELP[v.kind] || '';
    return v;
  };
  const yawOf = (v) => {
    const q = v.object3d.quaternion;
    const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    return Math.atan2(-fx, -fz);
  };
  function wrapPerf(v) {
    if (v.__perf) return;
    v.__perf = true;
    const f = v.fixedUpdate.bind(v);
    v.fixedUpdate = (dt, inp) => {
      const t0 = performance.now();
      f(dt, inp);
      perf.ms = perf.ms * 0.97 + (performance.now() - t0) * 0.03;
    };
  }

  const add = (html) => { el.insertAdjacentHTML('beforeend', html); return el.lastElementChild; };
  add('<div><b style="color:#ff4fa3">AIR &amp; SEA LAB</b><br><small>spawn + enter at the current spot (planes: nearest runway, boats: nearest water)</small></div>');
  const opt = add('<label><input type="checkbox" id="airstart"> spawn airborne (planes 300 m, helis 25 m)</label>');
  opt.querySelector('input').onchange = (e) => { airStart = e.target.checked; };
  for (const [title, list] of [['Helicopters', AIR_CATALOG.filter((e) => e.kind === 'heli')], ['Planes', AIR_CATALOG.filter((e) => e.kind === 'plane')], ['Boats', BOAT_CATALOG]]) {
    add(`<h3>${title}</h3>`);
    for (const e of list) {
      const b = add(`<button title="${e.desc}">${e.name} <small>${e.brand} · ${e.topSpeedKmh} km/h</small></button>`);
      b.onclick = () => spawnHere(e.id);
    }
  }
  add('<h3>Teleport (keeps vehicle type)</h3>');
  for (const [name, x, z] of SPOTS) {
    const b = add(`<button>${name}</button>`);
    b.onclick = () => {
      const v = cur();
      game.player.focus.set(x, 0, z);
      spawnHere(v?.catalogId || 'heli_news', x, z);
    };
  }
  add('<h3>Time · misc</h3>');
  const row = add('<div class="row"><button>Day</button><button>Dusk</button><button>Night</button></div>');
  const [bd, bk, bn] = row.querySelectorAll('button');
  bd.onclick = () => game.sky.setTime(11, { smooth: false });
  bk.onclick = () => game.sky.setTime(19.3, { smooth: false });
  bn.onclick = () => game.sky.setTime(23, { smooth: false });
  const lock = add('<button>Pointer lock (mouse yoke / look)</button>');
  lock.onclick = () => game.input.lockPointer();
  const rs = add('<button>Reset vehicle (R)</button>');
  rs.onclick = () => { const v = cur(); if (v) { const t = v.body.translation(); v.reset({ x: t.x, y: game.terrain.heightAt(t.x, t.z), z: t.z }, yawOf(v)); v.camera?.snap?.(v); } };

  // first vehicle: trainer on the VCIA runway (or ?v=id)
  const rws = findRunways(game.roads);
  const first = params.get('v') || 'plane_trainer';
  if (rws.length) {
    const s = runwayStart(rws[0], rws[0].x0, rws[0].z0);
    game.player.focus.set(s.x, 0, s.z);
  }
  setTimeout(() => spawnHere(first), 0);
  window.__airLab = { spawnHere, setAir: (b) => { airStart = b; }, perf };

  const f1 = (x, n = 0) => (Number.isFinite(x) ? x.toFixed(n) : '-');
  return {
    order: 60,
    update(dt) {
      const v = cur();
      if (!v || !v.telemetry || !v.physics) { tele.textContent = ''; return; }
      const t = v.telemetry;
      const lines = [
        `<b>${v.name}</b> (${v.catalogId})`,
        `speed     ${f1(t.speedKmh)} km/h   air ${f1(t.airspeed)} km/h`,
        `alt AGL   ${f1(t.altitude, 1)} m    ASL ${f1(t.altitudeAsl, 1)} m`,
        `v/s       ${f1(t.verticalSpeed, 1)} m/s   hdg ${f1(t.heading)}°`,
        `pitch/roll ${f1(t.pitch)}° / ${f1(t.roll)}°   g ${f1(t.gForce, 1)}`,
        `throttle  ${f1(t.throttle * 100)}%   rpm ${f1(t.rpm)} / ${f1(t.maxRpm)}`,
      ];
      if (v.kind === 'heli') lines.push(`rotor ${f1((t.rotorRpm || 0) * 100)}%  collective ${f1((t.collective || 0) * 100)}%  ${t.assist ? 'ASSIST' : 'MANUAL'}  ${t.grounded ? 'ON GROUND' : 'AIRBORNE'}`);
      if (v.kind === 'plane') lines.push(`aoa ${f1(t.aoa, 1)}°  flaps ${f1((t.flaps || 0) * 100)}%  gear ${t.gearDown ? 'DOWN' : 'UP'}${t.stall ? '  <b style="color:#f44">STALL</b>' : ''}  ${t.assist ? 'ASSIST' : 'MANUAL'}`);
      if (v.kind === 'boat') lines.push(`planing ${f1((t.planing || 0) * 100)}%  ${t.onLand ? 'ON LAND' : t.onWater ? 'ON WATER' : ''}  ${t.reversing ? 'REVERSE' : ''}`);
      lines.push(`health ${f1(t.health * 100)}%  ${t.destroyed ? 'DESTROYED' : ''} ${t.inWater ? 'IN WATER' : ''} ${v.drowned ? 'DROWNED' : ''}`);
      lines.push(`physics ${perf.ms.toFixed(3)} ms/step · ${game.fps} fps · particles ${v.spray?.alive ?? 0}`);
      tele.innerHTML = lines.join('\n');
    },
  };
}

const game = await createGame(document.getElementById('app'), {
  autostart: true,
  noPeds: true,
  noTraffic: params.get('traffic') !== '1', // AI traffic currently drives on runway edges
  spawn: { x: -3300, z: 258 },
  hour: 10,
  modules: [(g) => labModule(g)],
});
window.__lab = game;
