// Client side of server-authoritative combat (tanks).
//
//  - The local tank (workstream A, src/vehicle/tank) fires as usual; this module listens to `tank:fire` and tells the
//    server (muzzle, world yaw/pitch, server-clock time, and the free path to static geometry along the ballistic
//    arc, from a few raycasts). The server validates weapon, 3 s reload, muzzle position and aim vs the replicated
//    turret, broadcasts the shot to everyone around the muzzle, and resolves the flight itself against terrain, the
//    reported free path and oriented boxes around every player.
//  - Remote shots: A's Shells.spawnRemote flies the same visual shell (tracer, impact fx, no damage); a fallback
//    instanced tracer is used when the tank module is absent.
//  - BOOM (server impact) adds the explosion for shells we did not fly locally and for crushes; DAMAGE (to us) is
//    applied to our vehicle (tank armour via tank.takeShellHit, cars via E's VehicleDamage) or character; HIT (to the
//    shooter) feeds hit markers / toasts. Hooks: game.weapons.{remoteShell, remoteBoom, applyNetDamage} override.
//  - Tank destruction: our tank's wreck seed goes to the server once (C_VIS WRECK, 5 bytes); everybody around replays
//    the same seeded cook-off and turret toss with A's playTankWreck from the remote's pose (INFO carries the seed and
//    its age, so nothing is streamed and late arrivals don't replay an old blast).
import * as THREE from 'three';
import { encodeFire, encodeVis, wreckPayload } from './shared/protocol.js';
import { DMG, VIS, F_BURNING } from './shared/constants.js';
import { WEAPONS, WEAPON, aimDir, shellPos } from './shared/combat.js';

const MAX_SHELLS = 32;
const CLEAR_STEP = 0.05; // s per raycast segment for the free-path estimate
const CLEAR_MAX_S = 3; // s of flight checked (≈ 960 m); beyond that the server only checks terrain and players
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3(), _dir = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _pos = { x: 0, y: 0, z: 0 }, _d = { x: 0, y: 0, z: 0 }, _a = { x: 0, y: 0, z: 0 };

export class NetCombat {
  constructor(game, client) {
    this.game = game;
    this.client = client;
    this.seq = 0;
    this.lastFire = -1e9;
    this.shells = []; // remote shells in flight (fallback renderer)
    this.seen = new Map(); // `${kind}${netId}:${seq}` → time (SHOT/BOOM arrive on the near AND the far topic)
    this.flown = new Set(); // remote shots flown by A's Shells (they explode locally: skip the server BOOM fx)
    this.shellsMod = null;
    this.ray = null;
    // fallback tracer shells: one instanced mesh, material made once
    const geo = new THREE.CylinderGeometry(0.09, 0.09, 1.8, 6, 1).rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd28a, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_SHELLS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'net-shells';
    game.scene?.add(this.mesh);
    this._off = [
      client.on('shot', (f) => this._shot(f)),
      client.on('boom', (f) => this._boom(f)),
      client.on('damage', (d) => this._damage(d)),
      client.on('hit', (h) => this._hit(h)),
    ];
    // our own tank's shots → server
    const off = game.events?.on?.('tank:fire', (ev) => this._localFire(ev));
    if (typeof off === 'function') this._off.push(off);
    else this._offEvent = () => game.events?.off?.('tank:fire');
    // our own tank's destruction seed → server (once per destruction)
    for (const name of ['tank:cookoff', 'tank:destroyed']) {
      const o = game.events?.on?.(name, (ev) => this._localWreck(ev, name));
      if (typeof o === 'function') this._off.push(o);
    }
    this.wrecks = new Map(); // remote netId → { h, seed, model, t0 }
    this.played = new Map(); // remote netId → last replayed seed
    this.sentSeed = -1;
    // A's shell module + Rapier (lazy: no cost until the first shot)
    this._mods = Promise.all([
      import('../vehicle/tank/Shells.js').catch(() => null),
      import('@dimforge/rapier3d-compat').then((m) => m.default || m).catch(() => null),
      import('../vehicle/groups.js').catch(() => null),
    ]).then(([sh, rapier, grp]) => {
      if (this.disposed) return;
      this.ShellsCls = sh?.Shells || null;
      if (rapier?.Ray && grp?.groups) {
        this.ray = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        this.staticMask = grp.groups(grp.GROUPS.ALL ?? 0xffff, grp.GROUPS.GROUND | grp.GROUPS.STATIC);
        this.rayFlags = rapier.QueryFilterFlags?.EXCLUDE_SENSORS;
      }
    });
  }

  /** Reload state of the local weapon. */
  canFire(weapon = WEAPON.CANNON) {
    const w = WEAPONS[weapon];
    const left = w ? (w.reloadMs - (performance.now() - this.lastFire)) / 1000 : 0;
    return { ok: !!w && left <= 0 && this.client.online, waitS: Math.max(0, left) };
  }

  _localFire(ev) {
    const g = this.game;
    if (!ev || ev.remote || !ev.tank || ev.tank !== g.player?.controllable || !this.client.online) return;
    const o = ev.origin || ev.position, d = ev.dir;
    if (!o || !d) return;
    const h = Math.hypot(d.x, d.z);
    this.fire({ x: o.x, y: o.y, z: o.z, yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, h), body: ev.tank.body });
  }

  /**
   * Tell the server the local tank fired. shot = { x, y, z (muzzle), yaw, pitch (world, radians), clear? (m of free
   * path, computed here when omitted), weapon = 1, body? (own rigid body, excluded from the raycasts) }.
   * Returns { ok, seq, waitS }. The caller flies its own shell locally; damage to others arrives from the server.
   */
  fire(shot) {
    const weapon = shot.weapon ?? WEAPON.CANNON;
    const c = this.canFire(weapon);
    if (!c.ok) return { ok: false, seq: 0, waitS: c.waitS };
    this.lastFire = performance.now();
    this.seq = (this.seq + 1) & 0xffff || 1;
    const clock = this.client.clock;
    const t = Math.round(clock.synced ? clock.now(performance.now()) : performance.now()) >>> 0;
    const clear = shot.clear ?? this._clearPath(shot, WEAPONS[weapon]);
    const ok = this.client.send(encodeFire({ weapon, seq: this.seq, t, x: shot.x, y: shot.y, z: shot.z, yaw: shot.yaw, pitch: shot.pitch, clear }));
    return { ok, seq: this.seq, waitS: WEAPONS[weapon].reloadMs / 1000 };
  }

  // free path (m) along the ballistic arc before ground / static geometry (buildings): the server stops the shell
  // there, so nobody gets hit through a wall. 0 = unknown (the server then checks terrain and players only).
  _clearPath(shot, w) {
    const world = this.game.world, ray = this.ray;
    if (!world?.castRay || !ray) return 0;
    const d = aimDir(shot.yaw, shot.pitch, _a);
    let travelled = 0;
    try {
      for (let t = 0; t < CLEAR_MAX_S; t += CLEAR_STEP) {
        shellPos(shot.x, shot.y, shot.z, d.x, d.y, d.z, w.speed, w.gravity, t, _pos);
        shellPos(shot.x, shot.y, shot.z, d.x, d.y, d.z, w.speed, w.gravity, t + CLEAR_STEP, _d);
        const len = Math.hypot(_d.x - _pos.x, _d.y - _pos.y, _d.z - _pos.z);
        ray.origin.x = _pos.x; ray.origin.y = _pos.y; ray.origin.z = _pos.z;
        ray.dir.x = (_d.x - _pos.x) / len; ray.dir.y = (_d.y - _pos.y) / len; ray.dir.z = (_d.z - _pos.z) / len;
        const hit = world.castRay(ray, len, true, this.rayFlags, this.staticMask, undefined, shot.body || undefined);
        if (hit) return Math.max(1, Math.round(travelled + hit.timeOfImpact));
        const th = this.game.terrain?.heightAt?.(_d.x, _d.z);
        if (th !== undefined && _d.y < th) return Math.max(1, Math.round(travelled + len));
        travelled += len;
      }
    } catch { return 0; }
    return Math.min(65535, Math.round(travelled + 1));
  }

  _dedupe(kind, f) {
    const k = `${kind}${f.netId}:${f.seq}`;
    const now = performance.now();
    if (this.seen.has(k)) return true;
    this.seen.set(k, now);
    if (this.seen.size > 256) for (const [key, t] of this.seen) if (now - t > 10000) { this.seen.delete(key); this.flown.delete(key.slice(1)); }
    return false;
  }

  _serverNow() { const c = this.client.clock; return c.synced ? c.now(performance.now()) : 0; }

  _shot(f) {
    if (f.netId === this.client.welcome?.netId || this._dedupe('s', f)) return; // our own shell is flown locally
    const w = WEAPONS[f.weapon] || WEAPONS[WEAPON.CANNON];
    const d = aimDir(f.yaw, f.pitch, { x: 0, y: 0, z: 0 });
    const now = this._serverNow();
    const age = now ? Math.max(0, Math.min(1, (now - f.t) / 1000)) : 0;
    const shot = { netId: f.netId, seq: f.seq, weapon: f.weapon, x: f.x, y: f.y, z: f.z, yaw: f.yaw, pitch: f.pitch, dir: d, speed: w.speed, gravity: w.gravity, t: f.t, age };
    this.game.events?.emit('net:shot', shot);
    const g = this.game, custom = g.weapons?.remoteShell;
    if (typeof custom === 'function') { try { custom.call(g.weapons, shot); this.flown.add(`${f.netId}:${f.seq}`); return; } catch (e) { console.warn('[net] remoteShell', e); } }
    g.fx?.flash?.({ x: f.x, y: f.y, z: f.z }, { color: 0xffb060, intensity: 1500, range: 30, duration: 0.15 });
    g.fx?.smoke?.({ x: f.x + d.x * 1.2, y: f.y, z: f.z + d.z * 1.2 }, { color: 'light', count: 9, size: 1.4, velocity: { x: d.x * 5, y: 0.6, z: d.z * 5 } });
    if (this.ShellsCls) {
      // A's visual shell: same ballistics, tracer, impact effects, no damage (the server resolves hits)
      try {
        this.ShellsCls.get(g).spawnRemote({ origin: { x: f.x, y: f.y, z: f.z }, dir: d, speed: w.speed });
        this.flown.add(`${f.netId}:${f.seq}`);
        return;
      } catch (e) { console.warn('[net] remote shell', e); }
    }
    if (this.shells.length >= MAX_SHELLS) this.shells.shift();
    this.shells.push({ ...shot, life: age, max: Math.min(w.maxFlightS, w.range / w.speed) });
  }

  _boom(f) {
    if (this._dedupe('b', f)) return;
    for (let i = this.shells.length - 1; i >= 0; i--) if (this.shells[i].netId === f.netId && this.shells[i].seq === f.seq) this.shells.splice(i, 1);
    const own = f.netId === this.client.welcome?.netId;
    const boom = { netId: f.netId, seq: f.seq, x: f.x, y: f.y, z: f.z, t: f.t, own, crush: f.seq === 0 };
    this.game.events?.emit('net:boom', boom);
    if (own && f.seq) return; // our own shell already exploded locally
    if (f.seq && this.flown.has(`${f.netId}:${f.seq}`)) return; // the visual shell exploded where it hit
    const custom = this.game.weapons?.remoteBoom;
    if (typeof custom === 'function') { try { custom.call(this.game.weapons, boom); return; } catch (e) { console.warn('[net] remoteBoom', e); } }
    // visuals only: damage to players is server-resolved (DAMAGE), never applied from a remote explosion
    this.game.fx?.explode?.({ x: f.x, y: f.y, z: f.z }, f.seq ? 1.6 : 1.1, { noWorld: true, noPhysics: true, source: 'net' });
  }

  /** Server-resolved damage to us. kind: DMG.SHELL | SPLASH | CRUSH; amount 0..1; destroyed. */
  _damage(d) {
    const g = this.game;
    const dmg = { ...d, crush: d.kind === DMG.CRUSH, attackerName: this._name(d.attacker) };
    g.events?.emit('net:damage', dmg);
    const custom = g.weapons?.applyNetDamage;
    if (typeof custom === 'function') { try { custom.call(g.weapons, dmg); return; } catch (e) { console.warn('[net] applyNetDamage', e); } }
    const p = g.player, v = p?.controllable;
    const inVeh = !!v && (p.state === undefined || p.state === 'vehicle');
    if (!inVeh) { g.damage?.hurtPlayer?.(d.destroyed ? 1 : d.amount, 'net'); return; }
    const pos = new THREE.Vector3(d.x, d.y, d.z);
    const dir = { x: -Math.sin(d.dirYaw), y: 0, z: -Math.cos(d.dirYaw) };
    if (v.kind === 'tank' && typeof v.takeShellHit === 'function') {
      // tank armour is A's model: a direct hit costs 0.22 (front ×0.85, rear ×1.3), splash a little
      if (d.kind === DMG.SHELL) v.takeShellHit(pos, dir, null);
      else if (d.kind === DMG.SPLASH) g.damage?.get?.(v)?.applyExplosion?.(pos, Math.max(0.2, d.amount * 4), 9, v.object3d.position.distanceTo(pos));
      // the server says destroyed: if our armour model did not get there (cook-off already running otherwise), blow
      // it up now (A: the short cook-off + turret toss), so what we see matches what everybody else sees
      if (d.destroyed && !v.destroyed && !(v.armor <= 0)) {
        try { if (g.damage?.explode) g.damage.explode(v); else g.damage?.get?.(v)?.explode?.(); } catch (e) { console.warn('[net] tank explode', e); }
      }
      return;
    }
    const vd = g.damage?.get?.(v);
    if (d.destroyed) {
      if (vd) vd.explode();
      else { v.destroyed = true; g.fx?.explode?.({ x: d.x, y: d.y, z: d.z }, 1.2, { noWorld: true }); }
      return;
    }
    if (vd) vd.applyExplosion(pos, Math.max(0.2, d.amount * 1.4), 9, v.object3d ? v.object3d.position.distanceTo(pos) : 0);
  }

  // our tank started cooking off (seed known) or blew up without one: tell the server once per seed
  _localWreck(ev, name) {
    const tank = ev?.tank, g = this.game;
    if (!tank || tank.remote || g.player?.controllable !== tank || !this.client.online) return;
    const seed = (ev.seed ?? tank.wreckSeed ?? 0) >>> 0;
    if (seed === this.sentSeed) return;
    this.sentSeed = seed;
    const short = name === 'tank:destroyed' || (ev.duration ?? 2) < 0.8; // a direct explode(): 0.35 s cook-off
    this.client.send(encodeVis(VIS.WRECK, wreckPayload(seed, short)));
  }

  /** Per frame: replay remote tank destructions (A's playTankWreck), hide their drawn turret once it is thrown. */
  updateWrecks(entities, now = performance.now()) {
    const W = this.wrecks;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const w = e.wreck;
      let rec = W.get(e.id);
      if (rec && (rec.model !== e.model || (!(e.flags & F_BURNING) && now - rec.t0 > 3000))) { this._dropWreck(e.id); rec = null; } // respawned
      if (!w || (rec && rec.seed === w.seed) || !this._isTank(e)) { e.wreckH = rec?.h || null; continue; }
      if (rec) this._dropWreck(e.id);
      const age = now - w.at;
      // too old (a late arrival must not see an old blast), or already replayed (left and re-entered our view)
      if (age > 6000 || !this.wreckMod || this.played.get(e.id) === w.seed) { if (!this.wreckMod) this._loadWreck(); e.wreckH = null; continue; }
      this.played.set(e.id, w.seed);
      if (this.played.size > 256) this.played.delete(this.played.keys().next().value);
      const pose = this._pose(e);
      let h = null;
      try {
        h = this.wreckMod.playTankWreck(this.game, {
          position: pose.p, quaternion: pose.q, turretYaw: e.turret || 0, barrelPitch: e.barrel || 0, color: e.paint || undefined,
          seed: w.seed, velocity: { x: e.vx, y: 0, z: e.vz }, cookOff: !w.short && age < 1500,
        });
      } catch (err) { console.warn('[net] playTankWreck', err); }
      W.set(e.id, { h, seed: w.seed, model: e.model, t0: now });
      e.wreckH = h;
    }
    if (W.size) for (const id of W.keys()) if (!this.client.store.byId.has(id)) this._dropWreck(id);
  }

  _dropWreck(id) {
    const r = this.wrecks.get(id);
    this.wrecks.delete(id);
    try { r?.h?.dispose?.(); } catch { /* gone */ }
  }

  _isTank(e) {
    const m = this.client.welcome?.models?.[e.model - 1] || this.client.lastWelcome?.models?.[e.model - 1];
    return !!m && /tank/.test(m.id);
  }

  _pose(e) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(e.pitch || 0, e.yaw, e.roll || 0, 'YXZ'));
    return { p: { x: e.x, y: e.y, z: e.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  _loadWreck() {
    if (this._wreckLoading) return;
    this._wreckLoading = import('../vehicle/tank/Wreck.js').then((m) => { if (!this.disposed && m?.playTankWreck) this.wreckMod = m; }).catch(() => {});
  }

  _hit(h) {
    this.game.events?.emit('net:hit', { ...h, victimName: this._name(h.victim) });
  }

  _name(netId) {
    const e = this.client.store.byId.get(netId);
    return e ? this.client.displayName(e) : '';
  }

  /** Per frame: fly fallback tracers. */
  update(dt) {
    const list = this.shells;
    if (!list.length && !this.mesh.count) return;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.life += dt;
      if (s.life > s.max) list.splice(i, 1);
    }
    for (const s of list) {
      shellPos(s.x, s.y, s.z, s.dir.x, s.dir.y, s.dir.z, s.speed, s.gravity, s.life, _pos);
      _d.x = s.dir.x * s.speed; _d.y = s.dir.y * s.speed - s.gravity * s.life; _d.z = s.dir.z * s.speed;
      _dir.set(_d.x, _d.y, _d.z).normalize();
      _q.setFromUnitVectors(_z, _dir);
      _p.set(_pos.x, _pos.y, _pos.z);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n++, _m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.disposed = true;
    for (const id of [...this.wrecks.keys()]) this._dropWreck(id);
    for (const off of this._off) off();
    this._offEvent?.();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
