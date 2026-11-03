// Local player ↔ server: 20 Hz state upload (server-clock timestamps), session restore, server corrections, death
// events and garage spawn requests. Works with core/BasicPlayer and characters/PlayerController (same public API).
import * as THREE from 'three';
import {
  F_LIGHTS, F_SIREN, F_HORN, F_BRAKE, F_BURNING, F_BOOST, F_AIRBORNE, F_ANIM_SHIFT, ANIM, MODEL_FOOT, MODEL_UNKNOWN,
  EV_DIED, EV_RESPAWNED, SPAWN,
} from './shared/constants.js';
import { encodeEvent, encodeSpawn } from './shared/protocol.js';
import { uplinkDue, rememberUplink } from './shared/uplink.js';

const SEND_MS = 50;
import { PAINT_FINISHES } from '../economy/rules.js';
const EV_PAINT = 3;
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

export class LocalPlayer {
  constructor(game, client) {
    this.game = game;
    this.client = client;
    this.state = { seq: 0, t: 0, serverClock: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, yawRate: 0, steer: 0, model: 0, tpc: 0, flags: 0, health: 1, ext: false, turret: 0, barrel: 0 };
    this.acc = 0;
    this.corr = 0;
    this.lastUp = null; // last uploaded state (send-on-deviation)
    this.lastUpT = 0;
    this.upSent = 0; this.upSkipped = 0;
    this.horn = false;
    this.evSeq = 0;
    this.reqId = 0;
    this.spawnWait = new Map();
    this.lastSpawnOk = -1e9;
    this.cooldownS = 8;
    this.dead = false;
    this.lastPaint = null;
    this.restored = false;
    const ev = game.events;
    this._off = [
      ev.on('horn', (e) => { if (e?.vehicle && e.vehicle === game.player?.controllable) this.horn = !!e.on; }),
      ev.on('wasted', () => { if (!this.dead) { this.dead = true; this._event(EV_DIED, 0); } }),
      ev.on('respawn', () => { this.dead = false; this._event(EV_RESPAWNED, 0); }),
      ev.on('vehicle:enter', (e) => { if (e?.vehicle === game.player?.controllable) this._sendPaint(e.vehicle); }),
    ];
    this._offNet = [
      client.on('correction', (c) => this._correct(c)),
      client.on('spawnAck', (a) => this._spawnAck(a)),
      client.on('welcome', (w) => { this.cooldownS = w.spawnCooldownS || 8; this.corr = 0; this.lastPaint = null; this.lastUp = null; }),
    ];
  }

  // ---------------- uplink ----------------
  /** Fill `s` from the local player. Returns false when there is nothing to send. */
  read(s) {
    const g = this.game, p = g.player;
    if (!p) return false;
    const v = p.controllable;
    const inVeh = !!v && (p.state === undefined ? true : p.state === 'vehicle') && !!v.object3d;
    let flags = 0;
    if (inVeh) {
      const o = v.object3d;
      s.x = o.position.x; s.y = o.position.y; s.z = o.position.z;
      _e.setFromQuaternion(o.quaternion, 'YXZ');
      s.yaw = _e.y; s.pitch = _e.x; s.roll = _e.z;
      const lv = v.body?.linvel?.() || { x: 0, y: 0, z: 0 };
      const av = v.body?.angvel?.() || { x: 0, y: 0, z: 0 };
      s.vx = lv.x; s.vy = lv.y; s.vz = lv.z; s.yawRate = av.y;
      s.steer = v.physics?.steerAngle ?? v.telemetry?.steer ?? 0;
      s.model = this.client.modelIndex.get(v.catalogId) ?? MODEL_UNKNOWN;
      const tel = v.telemetry || {};
      if (v.headlightsOn) flags |= F_LIGHTS;
      if (v.siren) flags |= F_SIREN;
      if (this.horn) flags |= F_HORN;
      if (tel.braking) flags |= F_BRAKE;
      if (tel.boosting) flags |= F_BOOST;
      if (tel.airborne) flags |= F_AIRBORNE;
      const d = v.damage;
      if (v.destroyed || d?.destroyed || d?.burning || d?.onFire) flags |= F_BURNING;
      flags |= ANIM.SEATED << F_ANIM_SHIFT;
      // turret vehicles (tanks): replicate the turret yaw (relative to the hull) and the barrel pitch
      const tur = readTurret(v);
      s.ext = !!tur;
      if (tur) { s.turret = tur.yaw; s.barrel = tur.pitch; }
    } else {
      const c = p.character;
      const pos = c?.position || p.pos || p.focus;
      s.x = pos.x; s.y = pos.y; s.z = pos.z;
      const vel = c?.velocity || { x: 0, y: 0, z: 0 };
      s.vx = vel.x; s.vy = vel.y; s.vz = vel.z;
      s.yaw = c?.yaw ?? p.yaw ?? 0; s.pitch = 0; s.roll = 0; s.yawRate = 0; s.steer = 0;
      s.model = MODEL_FOOT;
      s.ext = false;
      let anim = ANIM.IDLE;
      const hs = Math.hypot(vel.x, vel.z);
      if (c?.ragdoll || p.state === 'ragdoll') { anim = ANIM.RAGDOLL; if (p.focus) { s.x = p.focus.x; s.y = p.focus.y - 0.9; s.z = p.focus.z; } }
      else if (c?.swimming) anim = ANIM.SWIM;
      else if (c && c.grounded === false) anim = ANIM.AIR;
      else if (p.state === 'enter' || p.state === 'exit') anim = ANIM.SEATED;
      else anim = hs < 0.3 ? ANIM.IDLE : hs < 2.6 ? ANIM.WALK : hs < 5.6 ? ANIM.RUN : ANIM.SPRINT;
      flags |= anim << F_ANIM_SHIFT;
    }
    const hp = p.health ?? 1;
    s.health = hp > 1.5 ? hp / (p.maxHealth || 100) : hp;
    s.flags = flags;
    s.tpc = this.corr;
    return Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z);
  }

  /** Per frame (after vehicles updated their visuals). alpha = physics interpolation factor of this frame. */
  update(dt, alpha = 1) {
    const c = this.client;
    if (!c.online) { this.acc = 0; return; }
    this.paintPoll = (this.paintPoll || 0) + dt;
    if (this.paintPoll > 0.5) {
      this.paintPoll = 0;
      const p = this.game.player, v = p?.controllable;
      if (v && (p.state === undefined || p.state === 'vehicle')) this._sendPaint(v);
    }
    this.acc += dt * 1000;
    if (this.acc < SEND_MS) return;
    this.acc = Math.min(this.acc - SEND_MS, SEND_MS);
    const s = this.state;
    if (!this.read(s)) return;
    // the visual pose is interpolated: it shows the physics state about (1 - alpha) steps ago
    const local = performance.now() - (1 - alpha) * (1000 / 60);
    // send on deviation: only when the server's extrapolation of the last upload would be noticeably off
    if (!uplinkDue(this.lastUp, s, local - this.lastUpT)) { this.upSkipped++; return; }
    s.serverClock = c.clock.synced;
    s.t = s.serverClock ? Math.round(c.clock.now(local)) >>> 0 : Math.round(local) >>> 0;
    s.seq = (s.seq + 1) & 0xffff;
    if (c.sendState(s)) {
      this.lastUp = rememberUplink(s, this.lastUp || {});
      this.lastUpT = local;
      this.upSent++;
    }
  }

  _event(kind, param) { this.client.send(encodeEvent(kind, ++this.evSeq, param)); }

  // the colour others see: what the car actually shows (respray, economy custom paint applied after entering, a
  // taken-over traffic car), polled twice a second and sent when it changed (≤ 1 per 1.2 s: the server's limit)
  _sendPaint(v) {
    const raw = v?.color;
    const col = typeof raw === 'number' ? raw : typeof raw?.getHex === 'function' ? raw.getHex()
      : typeof raw === 'string' && /^#?[0-9a-f]{6}$/i.test(raw) ? parseInt(raw.replace('#', ''), 16) : null;
    if (col === null) return;
    const fi = PAINT_FINISHES.indexOf(v.paintFinish || v.finish || 'color');
    const key = (((col & 0xffffff) || 0x010101) | ((fi + 1) << 24)) >>> 0; // finish in the top byte; 0 = "no paint" so black is 010101
    if (key === this.lastPaint) return;
    const now = performance.now();
    if (now - (this.paintT || -1e9) < 1200) return; // retried on the next poll
    this.paintT = now;
    this.lastPaint = key;
    this._event(EV_PAINT, key);
  }

  // ---------------- corrections & restore ----------------
  _correct(c) {
    this.corrections = (this.corrections || 0) + 1;
    this.corr = c.corr;
    this.lastUp = null; // upload the corrected pose right away
    this.place(c.x, c.y, c.z, c.yaw, false);
    console.warn('[net] position corrected by the server', c);
  }

  /** Put the player at (x, y, z, yaw) in the current vehicle or on foot (no spawn). */
  place(x, y, z, yaw, onFoot) {
    const g = this.game, p = g.player;
    if (!p) return;
    p.focus?.set?.(x, y, z);
    g.streaming?.run?.(true);
    const v = p.controllable;
    if (v && !onFoot && (p.state === undefined || p.state === 'vehicle')) {
      v.reset?.(_v.set(x, y, z), yaw);
      (v.camera || p.chase)?.snap?.(v);
    } else if (typeof p.restoreState === 'function') p.restoreState({ x, y, z, yaw, mode: 'foot' });
    else if (typeof p._placeOnFoot === 'function') p._placeOnFoot(x, z, yaw, y, true, true);
    else p.teleport?.(x, z);
  }

  /**
   * Session restore from WELCOME: same position, same vehicle (catalog id resolved via the server table).
   * r = { x, y, z, yaw, model, health, paint }.
   */
  restore(r) {
    if (!r) return false;
    const id = r.model ? this.client.models[r.model]?.id : '';
    this.restored = placeAt(this.game, { ...r, vehicle: id || '' });
    return this.restored;
  }

  // ---------------- garage ----------------
  canSpawnVehicle() {
    const left = this.cooldownS - (performance.now() - this.lastSpawnOk) / 1000;
    if (this.dead) return { ok: false, waitS: 0, reason: 'dead' };
    if (!this.client.online) return { ok: true, waitS: 0, offline: true };
    return left > 0 ? { ok: false, waitS: Math.ceil(left) } : { ok: true, waitS: 0 };
  }

  /** Ask the server to approve spawning `id` at the player's position. Resolves { ok, code, waitS }. */
  requestVehicle(id, opts = {}) {
    const c = this.client;
    if (!c.online) return Promise.resolve({ ok: true, offline: true }); // offline play: local rules
    const model = c.modelIndex.get(id);
    if (!model) return Promise.resolve({ ok: false, code: SPAWN.UNKNOWN_MODEL });
    const f = this.game.player?.focus || { x: 0, z: 0 };
    const reqId = (this.reqId = (this.reqId + 1) & 0xffff);
    const color = typeof opts.color === 'number' ? opts.color : 0;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.spawnWait.delete(reqId); resolve({ ok: false, code: SPAWN.RATE, timeout: true }); }, 4000);
      this.spawnWait.set(reqId, (a) => { clearTimeout(t); resolve(a); });
      c.send(encodeSpawn(reqId, model, color, f.x, f.z));
    });
  }

  _spawnAck(a) {
    const fn = this.spawnWait.get(a.reqId);
    if (!fn) return;
    this.spawnWait.delete(a.reqId);
    if (a.code === SPAWN.OK) this.lastSpawnOk = performance.now();
    else if (a.code === SPAWN.COOLDOWN) this.lastSpawnOk = performance.now() - (this.cooldownS - a.waitS) * 1000;
    fn({ ok: a.code === SPAWN.OK, code: a.code, waitS: a.waitS });
  }

  dispose() { for (const off of [...this._off, ...this._offNet]) off(); }
}

/**
 * Put the local player at a saved spot: in `vehicle` (catalog id; spawned unless already driving that model) or on
 * foot when vehicle is ''. r = { x, y, z, yaw, vehicle, paint?, health? }. Aircraft come back parked on the ground.
 */
export function placeAt(game, r) {
  const g = game, p = g.player;
  if (!p || !Number.isFinite(r?.x) || !Number.isFinite(r?.z)) return false;
  const ground = Math.max(0, g.terrain?.heightAt?.(r.x, r.z) ?? 0);
  const y0 = Number.isFinite(r.y) ? r.y : ground;
  p.focus?.set?.(r.x, Math.max(y0, ground), r.z);
  g.streaming?.run?.(true);
  const old = p.controllable;
  const id = r.vehicle;
  if (id && g.vehicles?.byId?.has?.(id)) {
    const entry = g.vehicles.byId.get(id);
    const air = entry.kind === 'heli' || entry.kind === 'plane';
    const y = air ? ground + 1 : Math.max(y0, ground) + 0.15;
    if (old && old.catalogId === id && !old.destroyed) {
      old.reset?.(_v.set(r.x, y, r.z), r.yaw || 0);
      (old.camera || p.chase)?.snap?.(old);
    } else {
      const v = g.vehicles.spawn(id, { x: r.x, y, z: r.z }, r.yaw || 0, r.paint ? { color: r.paint } : {});
      p.enter(v);
      if (old && old !== v) g.vehicles.despawn(old);
    }
  } else {
    if (p.state === 'vehicle' && p.exit) p.exit({ instant: true });
    const yaw = r.yaw || 0, y = Math.max(y0, ground);
    if (typeof p.restoreState === 'function') p.restoreState({ x: r.x, y, z: r.z, yaw, mode: 'foot' });
    else if (typeof p._placeOnFoot === 'function') p._placeOnFoot(r.x, r.z, yaw, y, true, true);
    else p.teleport?.(r.x, r.z);
    if (old && p.controllable !== old) g.vehicles?.despawn?.(old);
  }
  if (Number.isFinite(r.health) && r.health > 0.05) p.health = p.maxHealth ? r.health * p.maxHealth : r.health;
  return true;
}

/**
 * Turret pose of a vehicle, or null when it has none. Accepts the shapes a tank may expose (workstream A documents
 * the final one): v.turret = { yaw, pitch } | v.turretYaw + v.barrelPitch | v.weapon = { turretYaw, barrelPitch }.
 * yaw: radians relative to the hull (three.js rotation.y sense); pitch: radians, positive = barrel up.
 */
const _tur = { yaw: 0, pitch: 0 };
export function readTurret(v) {
  if (!v) return null;
  const t = v.turret;
  if (t && typeof t === 'object' && Number.isFinite(t.yaw)) { _tur.yaw = t.yaw; _tur.pitch = Number.isFinite(t.pitch) ? t.pitch : t.barrel ?? 0; return _tur; }
  if (Number.isFinite(v.turretYaw)) { _tur.yaw = v.turretYaw; _tur.pitch = v.barrelPitch ?? 0; return _tur; }
  const w = v.weapon;
  if (w && Number.isFinite(w.turretYaw)) { _tur.yaw = w.turretYaw; _tur.pitch = w.barrelPitch ?? 0; return _tur; }
  return null;
}
