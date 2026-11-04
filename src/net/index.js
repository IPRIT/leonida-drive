// Multiplayer module (workstream J). Online (game.mode === 'online', the default) it connects to the server, shows
// everyone else (instanced vehicles, avatars, WebGL nametags, minimap blips), streams your state at 20 Hz, restores
// your session, runs the server-authoritative wallet and syncs the shared clock and weather. Singleplayer never
// connects: it only keeps the local position save. See src/net/INTEGRATION.md.
import { NetClient } from './NetClient.js';
import { NetEconomy } from './NetEconomy.js';
import { LocalPlayer, placeAt } from './LocalPlayer.js';
import { WorldSync } from './WorldSync.js';
import { LocalSave } from './LocalSave.js';
import { RemoteVehicles } from './render/RemoteVehicles.js';
import { Nametags } from './render/Nametags.js';
import { Avatars } from './render/Avatars.js';
import { RemoteColliders } from './RemoteColliders.js';
import { NetCombat } from './NetCombat.js';
import { NetDamage } from './NetDamage.js';
import { RemoteDamage } from './render/RemoteDamage.js';
import { encodeList, encodeVis } from './shared/protocol.js';
import { nickName } from './shared/nicknames.js';
import { PLAYER_COLORS, VCLASS, LIST, VIS, F_HORN } from './shared/constants.js';
import { Object3D } from 'three';
import { netGate } from './status.js';

let pre = null;

function modeOf() {
  try {
    const q = new URLSearchParams(location.search).get('mode');
    if (q === 'single' || q === 'online') return q;
    const s = localStorage.getItem('leonida.mode');
    if (s === 'single' || s === 'online') return s;
  } catch { /* ignore */ }
  return 'online';
}

/** Optional: open the connection before createGame() so the handshake overlaps with loading the world. */
export function preconnectNet(opts = {}) {
  if (pre || modeOf() !== 'online') return pre;
  pre = new NetClient(opts);
  netGate.set(pre);
  // no socket yet: the server is contacted only when the player presses Multiplayer (start screen → rejoin())
  return pre;
}

/** For createGame({ modules: [netModule()] }). */
export function netModule(opts = {}) { return (game) => createNet(game, opts); }

/**
 * Create the module (registered by createGame when passed through options.modules). Online it waits up to
 * opts.waitMs (1500 ms) for the server's WELCOME so the saved session is restored before the first frame.
 */
export async function createNet(game, opts = {}) {
  const mode = game.mode ?? modeOf();
  if (mode !== 'online') return new SingleSave(game);
  const client = pre || new NetClient(opts);
  pre = null;
  netGate.set(client);
  // stays idle until the start screen's Multiplayer button calls client.rejoin()
  let factory = null;
  if (opts.avatars !== false) {
    try { factory = (await import('../characters/index.js')).createRemoteAvatars || null; } catch { factory = null; }
  }
  const net = new Net(game, client, { ...opts, avatarFactory: factory });
  await net.ready(opts.waitMs ?? 1500);
  return net;
}

class SingleSave {
  constructor(game) {
    this.order = 70;
    this.game = game;
    this.save = new LocalSave(game, 'single');
    game.net = null;
    // game.economy (workstream L) restores the singleplayer position itself (startPlan); without it, we do
    if (!game.economy?.startPlan) {
      const s = this.save.load();
      if (s) placeAt(game, s);
    }
  }
  update(dt) { this.save.update(dt); }
  dispose() { this.save.dispose(); }
}

export class Net {
  constructor(game, client, opts = {}) {
    this.order = 70; // after vehicles (10) and the player (0): poses of this frame are final
    this.game = game;
    this.opts = opts;
    this.client = client;
    this.store = client.store;
    this.economy = new NetEconomy(game, client);
    this.local = new LocalPlayer(game, client);
    this.world = new WorldSync(game, client);
    this.save = new LocalSave(game, 'online');
    this.vehicles = new RemoteVehicles(game);
    this.damage = new NetDamage(game, client); // our dents → server, on change
    this.remoteDamage = new RemoteDamage(game, this.vehicles); // their dents, near the camera
    this.avatars = new Avatars(game, { max: opts.maxAvatars ?? 200, factory: opts.avatarFactory, client });
    this.avatars.vehicles = this.vehicles; // seat positions of remote vehicle models (riders)
    this.combat = new NetCombat(game, client);
    this.listReq = 0;
    this.listWait = new Map();
    this.tags = new Nametags(game);
    this.colliders = opts.colliders === false ? null : new RemoteColliders(game, this.vehicles);
    this.ui = null;
    this.step = 0;
    this.blipT = 0;
    this.blips = [];
    this.positions = [];
    this.restoredOnce = false;
    this.offlineRestored = false;
    game.net = this;
    // settings
    const s = game.settings || {};
    this._applyShow(s.mpShowPlayers ?? true);
    this.tags.setVisible((s.mpNametags ?? true) && (s.mpShowPlayers ?? true));
    game.onSetting?.('mpShowPlayers', (v) => this._applyShow(v));
    game.onSetting?.('mpNametags', (v) => this.tags.setVisible(v && (game.settings.mpShowPlayers ?? true)));
    if (client.welcome) this._welcome({ ...client.welcome, first: true }); // arrived during loading (preconnect)
    this._off = [
      client.on('welcome', (w) => this._welcome(w)),
      client.onState('owned', () => this._ensureOwnedVehicle()),
      client.on('list', (p) => { const fn = this.listWait.get(p.reqId); if (fn) { this.listWait.delete(p.reqId); fn(p); } }),
      client.on('queue', (q) => game.events?.emit('net:queue', { position: q.position, waiting: q.waiting, etaSec: q.etaSec, capacity: q.capacity })),
      client.on('admit', () => game.events?.emit('net:admit', {})),
      client.on('welcome', () => this._sendAway()),
    ];
    // tab to the background: rAF stops, so no more states. Tell the server right away (others see the player frozen,
    // with an AFK badge, instead of a car drifting on); coming back resumes seamlessly (same session, no rejoin)
    if (typeof document !== 'undefined') {
      const vis = () => this._sendAway();
      document.addEventListener('visibilitychange', vis);
      this._off.push(() => document.removeEventListener('visibilitychange', vis));
    }
    if (game.ui && !opts.noUI) {
      import('./ui/NetUI.js').then(({ NetUI }) => { this.ui = new NetUI(game, this); }).catch((e) => console.warn('[net] ui', e));
    }
    this._precompile();
  }

  /** Resolves when the server answered (true) or is unreachable / slow (false): never blocks loading for long. */
  ready(ms) {
    if (this.client.welcome) return Promise.resolve(true);
    if (this.client.status === 'idle') return Promise.resolve(false); // not connected yet: Multiplayer connects later
    if (this.client.status === 'offline') { this._offlineStart(); return Promise.resolve(false); }
    // waiting in line (server full): the start screen holds the game until the admission's WELCOME (normal restore)
    if (this.client.status === 'queued') return Promise.resolve(false);
    return new Promise((res) => {
      const done = (ok, offline = !ok) => { clearTimeout(t); offW(); offS(); if (offline) this._offlineStart(); res(ok); };
      const t = setTimeout(() => done(false, this.client.status !== 'queued'), ms);
      const offW = this.client.on('welcome', () => done(true));
      const offS = this.client.on('status', (st) => { if (st === 'offline') done(false); else if (st === 'queued') done(false, false); });
    });
  }

  _precompile() {
    // compile the new materials now (count 0 meshes are skipped by the renderer, so the first remote player would
    // otherwise stall a frame on shader compilation)
    try { this.game.renderer?.compileAsync?.(this.game.scene, this.game.camera)?.catch?.(() => {}); } catch { /* optional */ }
  }

  _applyShow(v) {
    this.vehicles.setVisible(v);
    this.avatars.setVisible(v);
    this.tags.setVisible(v && (this.game.settings?.mpNametags ?? true));
    this.colliders?.setEnabled(v);
  }

  _welcome(w) {
    if (!w.first || this.restoredOnce) return;
    this.restoredOnce = true;
    if (w.afterOffline || this.offlineRestored) {
      // the server came back while we were playing offline: stay where we are (the server accepts the move within
      // what could have been driven meanwhile); the online wallet and garage replace the offline ones
      this.game.events?.emit('net:online', { afterOffline: true, offlineS: w.offlineS });
      return;
    }
    if (w.restore) this.local.restore(w.restore);
    else this.newPlayer = true; // spawn plan / starter car once ownership arrives
  }

  _sendAway() {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!this.client.online || (!hidden && !this._awaySent)) return;
    this._awaySent = hidden;
    this.client.send(encodeVis(VIS.AWAY, Uint8Array.of(hidden ? 1 : 0)));
  }

  // server unreachable at start: continue where this browser last played online (offline fallback)
  _offlineStart() {
    if (this.offlineRestored || this.client.welcome) return;
    this.offlineRestored = true;
    const s = this.save.load();
    if (s) placeAt(this.game, s);
  }

  // new players (and boot vehicles that aren't yours): put the player in an owned car at a free kerb slot
  _ensureOwnedVehicle() {
    const g = this.game, p = g.player, owned = this.economy.owned;
    const v = p?.controllable;
    if (!v || !owned.size || owned.has(v.catalogId) || v.fromTraffic) { this.newPlayer = false; return; }
    if (p.state !== undefined && p.state !== 'vehicle') return;
    const plan = this.newPlayer ? g.economy?.startPlan?.() : null;
    const starter = plan?.vehicle && owned.has(plan.vehicle) ? plan.vehicle
      : [...owned].find((id) => g.vehicles?.byId?.get(id)?.kind === 'car') || [...owned][0];
    let pos = plan?.pos;
    if (!pos) {
      const o = v.object3d.position, q = v.object3d.quaternion;
      pos = { x: o.x, y: o.y, z: o.z, yaw: Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)) };
    }
    placeAt(g, { x: pos.x, y: pos.y, z: pos.z, yaw: pos.yaw ?? 0, vehicle: starter });
    this.newPlayer = false;
  }

  // ---------------- API used by other workstreams ----------------
  get online() { return this.client.online; }
  get status() { return this.client.status; }
  /** While the server is full: { position (1 = next), waiting, etaSec | null, capacity }; null otherwise. */
  get queue() { return this.client.queue; }
  /** Give up the place in line (also stops retrying); rejoin() queues again at the back. */
  leaveQueue() { this.client.leaveQueue(); }
  rejoin() { this.client.rejoin(); }

  // other players' horns: F_HORN edges → the same 'horn' event the local car uses, on a small proxy that follows the
  // remote vehicle (EventSounds plays it positionally; bikes/bicycles get their own horn/bell by kind)
  _horns() {
    const H = this.hornsOn || (this.hornsOn = new Map()), ev = this.game.events;
    for (const e of this.store.list) {
      const on = e.model !== 0 && e.state !== 'out' && (e.flags & F_HORN) !== 0;
      let h = H.get(e.id);
      if (on && !h) {
        const b = this.vehicles?.dims?.(e.model);
        h = { obj: new Object3D(), seen: true };
        h.v = { object3d: h.obj, kind: b?.kind || (e.vclass === VCLASS.BIKE ? 'motorcycle' : e.vclass === VCLASS.BOAT ? 'boat' : 'car'), catalogId: b?.id, remote: true };
        h.obj.position.set(e.x, e.y, e.z);
        H.set(e.id, h);
        ev.emit('horn', { vehicle: h.v, on: true });
      }
      if (h) { h.seen = true; h.obj.position.set(e.x, e.y, e.z); h.obj.updateMatrixWorld(); if (!on) { ev.emit('horn', { vehicle: h.v, on: false }); H.delete(e.id); } }
    }
    for (const [id, h] of H) { if (!h.seen) { ev.emit('horn', { vehicle: h.v, on: false }); H.delete(id); } else h.seen = false; }
  }
  get ping() { return this.client.clock.rtt; }
  get playersOnline() { return this.client.global?.online ?? (this.client.online ? 1 : 0); }
  get me() {
    const w = this.client.welcome || this.client.lastWelcome;
    return w ? { netId: w.netId, nickCode: w.nickCode, nick: w.name || nickName(w.nickCode), custom: !!w.name, color: PLAYER_COLORS[w.color % PLAYER_COLORS.length], colorIndex: w.color } : null;
  }
  /** Display name of a remote entity / top entry / event ({ nickCode, name }). */
  nameOf(e) { return this.client.displayName(e); }
  /** Server time (ms since epoch) estimated from ping/pong. */
  serverNow() { return this.client.clock.now(); }

  /** Positions of other players (interpolated), for spawn-slot picking: [{ x, z }] (reused array). */
  remotePositions() {
    const out = this.positions, list = this.store.list;
    out.length = 0;
    for (let i = 0; i < list.length; i++) { const e = list[i]; if (e.hasCurve && e.state !== 'out') out.push({ x: e.x, z: e.z }); }
    const tl = this.client.tracks.list; // far players (radar tracks, dead-reckoned)
    for (let i = 0; i < tl.length; i++) { const t = tl[i]; if (!t.anchored && !t.wasAnchored && !t.gone) out.push({ x: t.x, z: t.z }); }
    return out;
  }

  /**
   * Remote players currently known (for UI): [{ id, nick, color, x, y, z, heading, vclass, model, near, worth, neon, tint,
   * horn, outfit (wardrobe ids), turret, barrel }].
   */
  players() {
    const c = this.client;
    return this.store.list.filter((e) => e.hasInfo && e.state !== 'out').map((e) => ({
      id: e.id, nick: c.displayName(e), color: PLAYER_COLORS[e.color % PLAYER_COLORS.length], x: e.x, y: e.y, z: e.z, heading: -e.yaw,
      vclass: e.vclass, model: c.models[e.model]?.id ?? null, near: e.stream === 0, worth: e.worth, neon: e.neon, tint: e.tint, horn: e.horn,
      outfit: c.outfitOf(e), turret: e.turret, barrel: e.barrel,
    }));
  }

  // ---------------- combat (tanks) ----------------
  /** Local weapon reload: { ok, waitS }. */
  canFire(weapon = 1) { return this.combat.canFire(weapon); }
  /** The local tank fired: { x, y, z (muzzle), yaw, pitch (world), clear (m free path), weapon }. → { ok, seq, waitS } */
  fire(shot) { return this.combat.fire(shot); }

  // ---------------- services, wardrobe, nickname ----------------
  service(id, vehicleId, opts) { return this.economy.service(id, vehicleId, opts); }
  setCosmetic(vehicleId, patch) { return this.economy.setCosmetic(vehicleId, patch); }
  useItem(item) { return this.economy.useItem(item); }
  get inventory() { return this.economy.inventory; }
  /** Wardrobe purchase / re-dye (economy.buyWardrobe): kind 'buy' | 'dye'. → Promise<{ ok, reason?, money, cost }> */
  wardrobe(itemId, colour = null, kind = 'buy') { return this.economy.wardrobe(itemId, colour, kind); }
  /** Server copy: { items (wire order), owned: { id: colour }, outfit: { slot: id } }. */
  get wardrobeState() { const w = this.economy.wd; return { items: w.items, owned: Object.fromEntries(w.owned), outfit: { ...w.outfit } }; }
  buyClothing(id, colour) { return this.economy.wardrobe(id, colour, 'buy'); }
  /** Wear items: { slot: itemId | null } or [itemId]; the server checks ownership and shows it to everyone. */
  setOutfit(outfit) { return this.economy.setOutfit(outfit); }
  /** 'reroll' | 'random' | 'custom' (value) | 'check' (value) | 'suggest'. → Promise<{ ok, reason?, money, nick, code }> */
  changeNick(mode, value) { return this.economy.changeNick(mode, value); }
  rerollNick() { return this.economy.rerollNick(); }
  setNickname(name) { return this.economy.setNickname(name); }
  get nickPrices() { return this.economy.nickPrices; }

  /**
   * Remote players' vehicles for obstacle avoidance (D's characters/obstacles.js): reused array of reused objects
   * { x, y, z, yaw, hw, hl, vx, vz, speed } (yaw = three.js rotation.y, hw/hl = half width / length in metres).
   */
  remoteVehicles() {
    const out = this.rv || (this.rv = []), pool = this.rvPool || (this.rvPool = []);
    out.length = 0;
    if (!this.client.online || !(this.game.settings?.mpShowPlayers ?? true)) return out;
    const list = this.store.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.model || e.model === 255 || !e.hasCurve || e.alpha < 0.3 || e.state === 'out') continue;
      const d = this.vehicles.dims(e.model);
      const o = pool[out.length] || (pool[out.length] = { x: 0, y: 0, z: 0, yaw: 0, hw: 0, hl: 0, vx: 0, vz: 0, speed: 0 });
      o.x = e.x; o.y = e.y + (d?.center?.y ?? 0); o.z = e.z; o.yaw = e.yaw; // y: the body's centre
      o.hw = (d?.width ?? 1.9) / 2; o.hl = (d?.length ?? 4.6) / 2;
      o.vx = e.vx; o.vz = e.vz; o.speed = e.speed;
      out.push(o);
    }
    return out;
  }

  /** One page of online players, most recent joins first (≤ 1 request/s). → Promise<{ players, next, online }>. */
  listOnline(cursor = 0) {
    if (!this.client.online) return Promise.resolve({ players: [], next: 0, online: 0 });
    const reqId = (this.listReq = (this.listReq + 1) & 0xffff) || (this.listReq = 1);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.listWait.delete(reqId); resolve({ players: [], next: cursor, online: this.playersOnline, timeout: true }); }, 3000);
      this.listWait.set(reqId, (p) => { clearTimeout(t); resolve(p); });
      this.client.send(encodeList(LIST.RECENT, reqId, cursor));
    });
  }

  canSpawnVehicle() { return this.local.canSpawnVehicle(); }
  /** Garage: resolves true when the server approved the vehicle (then call game.spawnForPlayer(id, opts)). */
  async requestVehicle(id, opts = {}) {
    if (this.client.online && this.economy.owned.size && !this.economy.owned.has(id)) return false;
    const r = await this.local.requestVehicle(id, opts);
    this.lastSpawnResult = r;
    return !!r.ok;
  }

  claim(reason, amount, pos, meta) { return this.economy.claim(reason, amount, pos, meta); }
  buy(id) { return this.economy.buy(id); }
  sell(id, condition) { return this.economy.sell(id, condition); }
  repair(id, damage) { return this.economy.repair(id, damage); }
  paint(variant) { return this.economy.paint(variant); }
  charge(reason, amount) { return this.economy.charge(reason, amount); }
  onWallet(cb) { return this.economy.onWallet(cb); }
  get wallet() { return this.economy.snapshot(); }
  get progress() { return this.economy.progress; }

  reroll() { return this.rerollNick(); }
  retry() { this.client.retry(); }

  // ---------------- loop ----------------
  fixedUpdate(dt) {
    if (this.colliders && this.client.online) this.colliders.fixedUpdate(dt, this.step++);
  }

  update(dt, game, alpha = 1) {
    const now = performance.now();
    this.client.update(dt, now);
    this.store.update(now, this.client.clock.offset, dt);
    this.local.update(dt, alpha);
    this.world.update(dt);
    this.save.update(dt);
    this.step = 0;
    this.colliders?.assign(this.store.list);
    this.combat.updateWrecks(this.store.list, now);
    this.remoteDamage.update(this.store.list, this.client);
    this.vehicles.update(this.store.list, this.client, dt);
    this._horns();
    this.combat.update(dt);
    this.damage.update(dt, now);
    this._blips(dt, now);
    this.ui?.update(dt);
  }

  lateUpdate(dt) {
    const list = this.store.list;
    this.avatars.update(list, dt);
    this.tags.update(list, dt);
  }

  // minimap + full map, every frame: players in view follow their interpolated 3D pose; farther ones (radar
  // summaries, 1 Hz) are dead-reckoned tracks with smoothed corrections and headings (RadarTracks) — blips never step.
  // The blip array and its objects are reused (consumers keep the reference and read it when they draw).
  _blips(dt, now) {
    const g = this.game, c = this.client, tracks = c.tracks, out = this.blips;
    let mapView = null;
    for (const fm of g.cartography?.fullMaps || []) if (fm.visible) { mapView = fm.view; break; }
    c.wantMap(!!mapView && (g.settings?.mpShowPlayers ?? true) && !document.hidden);
    out.length = 0;
    const show = (g.settings?.mpShowPlayers ?? true) && c.online;
    if (show) {
      const ts = c.clock.synced ? c.clock.now(now) : 0;
      const list = this.store.list;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        // anchor only fully-live 3D entities: while fading in, the render clock is still before their first sample (the
        // pose is held), while fading out or dissolving (teleport) the pose is not moving either — the track carries on
        if (!e.hasCurve || e.state === 'out' || e.alpha < 0.95 || e.tp) continue;
        tracks.anchor(e.id, e.x, e.z, e.yaw, e.vx, e.vz, ts, e.hasInfo ? e.color : e.id, e.vclass, now);
      }
      tracks.update(ts, now, dt);
      const tl = tracks.list;
      for (let i = 0; i < tl.length; i++) {
        const t = tl[i];
        if (t.alpha < 0.05) continue;
        const b = t.blip || (t.blip = { id: 0, x: 0, z: 0, heading: 0, color: '', name: '', nameAt: -1 });
        if (b.id !== t.id) { b.nameAt = -1; t.nameAskedAt = 0; }
        b.id = t.id; b.x = t.x; b.z = t.z; b.heading = -t.yaw;
        b.color = PLAYER_COLORS[t.color % PLAYER_COLORS.length];
        const e = this.store.byId.get(t.id);
        if (e?.hasInfo) { if (b.nameAt !== e.infoAt) { b.nameAt = e.infoAt; b.name = this.client.displayName(e); } }
        else {
          const identity = c.radarNames.get(t.id);
          b.name = identity?.name || ''; b.nameAt = identity?.at ?? -1;
          const visible = mapView ? Math.abs(t.x - mapView.cx) < mapView.w * mapView.mpp / 2 && Math.abs(t.z - mapView.cz) < mapView.h * mapView.mpp / 2
            : Math.hypot(t.x - g.player.focus.x, t.z - g.player.focus.z) < 1000;
          if (visible && (!identity || now - identity.at > 30000) && (!t.nameAskedAt || now - t.nameAskedAt > 10000)) {
            if (c.radarInfoQueue.size < 1024) { t.nameAskedAt = now; c.radarInfoQueue.add(t.id); }
          }
        }
        out.push(b);
      }
    } else if (tracks.list.length) tracks.clear();
    // the radar redraws every frame from this (same) array; the full map redraws when the version changes, so
    // bump it every frame only while a full map is open (and ≤ 4 Hz otherwise, e.g. list length changes)
    this.blipT -= dt;
    let mapOpen = false;
    for (const fm of g.cartography?.fullMaps || []) if (fm.visible) { mapOpen = true; break; }
    if (this.blipT <= 0 || out.length !== this.blipN) {
      this.blipT = mapOpen ? 0.05 : 0.25;
      this.blipN = out.length;
      g.cartography?.setPlayers?.(out);
      g.ui?.setPlayerBlips?.(out);
    }
  }

  dispose() {
    for (const off of this._off) off();
    this.client.close();
    this.economy.dispose();
    this.local.dispose();
    this.world.dispose();
    this.save.dispose();
    this.vehicles.dispose();
    this.avatars.dispose();
    this.tags.dispose();
    this.colliders?.dispose();
    this.combat.dispose();
    this.damage.dispose();
    this.remoteDamage.dispose();
    this.ui?.dispose();
    if (this.game.net === this) this.game.net = null;
  }
}

export { VCLASS };
