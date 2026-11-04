// One connected player: handshake, validation of everything the client sends, wallet, interest subscriptions.
import crypto from 'node:crypto';
import {
  PROTO_VERSION, C_HELLO, C_STATE, C_PING, C_CLAIM, C_SPAWN, C_INFO_REQ, C_REROLL, C_EVENT, C_ECON, HF_TOKEN, HF_RESUME,
  PING_SIZE, REROLL_SIZE, EVENT_SIZE, KICK, WALLET, NOTICE, SPAWN, EV_DIED, EV_RESPAWNED, VCLASS, SLOT_BITS, SLOT_MASK, NEAR_R, FAR_R,
  FAR_R_AIR, AIR_ALT, GRID_NX, GRID_NZ, F_INFO_SHIFT, F_INFO, F_INFO_MASK, F_TPC, F_EXT, F_BURNING, MODEL_FOOT, PLAYER_COLORS, WORLD, ECON, ECON_RESULT, CLAIM,
  C_FIRE, C_SERVICE, C_LIST, C_OUTFIT, C_NICK, S_DAMAGE, S_FX, SERVICE, WARDROBE_OP, NICK_OP, NICK_RESULT, NICK_COOLDOWN_S,
  LIST, DMG, C_VIS, VIS, VIS_MAX,
} from '../../src/net/shared/constants.js';
import {
  decodeHello, readState, decodeClaim, decodeSpawn, decodeInfoReq, decodeEcon, encodeWelcome, encodePong, encodeWallet, encodeSpawnAck,
  encodeCorrection, encodeNick, encodeKick, encodeNotice, encodeRank, writeInfoHeader, writeInfo, INFO_MAX, cellOf, radarOf, encodeAdmit,
  encodeEconReply, encodeOwned, encodeProgress, decodeFire, decodeService, decodeOutfit, decodeNickReq, decodeList, encodeGarage,
  writeListHeader, writeListEntry, LIST_HDR, LIST_ENTRY, wrapAngle, readDamage, decodeVis,
} from '../../src/net/shared/protocol.js';
import { randomNickCode, nickName, validNickCode } from '../../src/net/shared/nicknames.js';
import { WEAPONS, weaponOfModel } from '../../src/net/shared/combat.js';
import { HORN_VARIANTS, PAINT_FINISHES, nickPrice } from '../../src/economy/rules.js';
import { Movement, V_OK, V_JUMP, V_NAMES } from './validate.js';
import { Economy } from './economy.js';
import { CLASS_LIMITS } from './vehicles.js';
import { FLAG_FROZEN, FLAG_BANNED } from './db.js';
import { vehicleSpawnDestination } from './spawn-places.js';
import { rankOf, slotName, setSlotName, OUTFIT_STRIDE, JOIN_RING, DAMAGE_STRIDE } from './shared-mem.js';
import { checkName } from './names.js';
import { ipForLog } from './privacy.js';
import { outfitCodes, itemOfCode } from '../../src/net/shared/outfit-codes.js';
import { C_ADMIN, S_ADMIN, S_FEATURES, FEATURE, MAP_ORDER, HF_EXACT_PLACE, ADMIN_CORRECTION, jsonMessage, readJson } from '../../src/net/shared/extensions.js';
import { ADMIN_TTL } from './admin.js';
import { validTravelGrant, nearTravelDestination } from './admin-travel.js';

export const EV_PAINT = 3; // client event: param = vehicle paint RGB

const DEFAULT_SPAWN = { x: 1728, y: 2, z: -733 }; // Ocean Beach (new sessions spawn at a random kerb slot there)
const RATE_CAP = 70, RATE_REFILL = 50; // messages: burst / per second
const FLOOD_DROPS = 600; // rate-limited messages within 10 s before a kick
const SUSPICION_FREEZE = 30, SUSPICION_KICK = 120;
const DEATH_MIN_INTERVAL = 8000;
const LIST_PAGE = 30; // players per scoreboard page
const CLAIM_SETTLE_MS = 10000; // no earn claims for 10 s after a server-granted jump (join, respawn)
const NICK_REASON = { short: NICK_RESULT.FORMAT, long: NICK_RESULT.FORMAT, chars: NICK_RESULT.FORMAT, blocked: NICK_RESULT.BLOCKED, reserved: NICK_RESULT.RESERVED };

const _state = {};
const _ids = new Uint32Array(32);

export class Session {
  constructor(gw, ws, ip, now) {
    this.gw = gw;
    this.ws = ws;
    this.ip = ip;
    this.sid = gw.nextSid++;
    this.state = 'hello';
    this.openedAt = now;
    this.slot = -1;
    this.netId = 0;
    this.hash = null;
    this.rec = null;
    this.mv = null; // created at join (≈ 7 KB of movement history): a queued connection does not need it
    this.ticket = -1; // waiting-queue ticket while queued
    this.counted = false; // holds one unit of capacity (released on close)
    this.fromQueue = false; this.acked = true; this.welcomeT = 0; // admitted from the queue: must answer the WELCOME
    this.econ = null;
    this.econT = 0; this.econTokens = 10;
    this.model = MODEL_FOOT;
    this.approved = new Map(); // model index → time approved (spawned / restored)
    this.paint = 0;
    this.health = 1;
    this.tpc = 0; // visual teleport counter (in the broadcast flags)
    this.corr = 0; // correction counter the client must echo
    this.corrPending = 0;
    this.infoVer = 0;
    this.tokens = RATE_CAP; this.tokT = now;
    this.dropN = 0; this.dropT = now;
    this.mvT = 0;
    this.strikes = 0;
    this.suspicion = 0; this.suspT = now;
    this.frozen = false;
    this.lastStateT = 0; this.lastSeq = -1;
    this.offMin = NaN; this.offT = now;
    this.deadUntil = 0; this.lastDeath = -1e12;
    this.lastSpawn = -1e12; this.lastPaint = -1e12; this.lastList = -1e12; this.lastOutfit = -1e12;
    this.customName = '';
    this.nickBusy = false;
    this.turret = 0; this.barrel = 0; this.hasTurret = false; // last reported turret pose (fire validation)
    this.lastShotT = -1e12; this.lastShotRecv = -1e12; this.shotSeq = -1;
    this.wreckDue = 0; this.wreckModel = -1; // destroyed by server-resolved damage: the client must show it (god-mode check)
    this.lastRank = 0;
    this.cell = -1; this.near = []; this.far = []; this.radar = -1; this.farR = FAR_R; this.congested = 0;
    this.dirtyFast = false; this.dirtyPos = false; this.lastPosSave = now;
    this.stats = { claims: 0, earned: 0, deaths: 0, playMs: 0 };
    this.closed = false;
    this.away = false; this.awayExplicit = false;
  }

  get v() { return this.gw.v; }

  send(buf) {
    if (this.closed) return;
    const r = this.ws.send(buf, true, false);
    this.gw.statAdd(4, buf.byteLength ?? buf.length);
    return r;
  }

  kick(code, why = '') {
    if (this.closed) return;
    this.gw.statAdd(5, 1);
    if (why) this.gw.log.info?.(`[gw${this.gw.id}] kick ${ipForLog(this.ip)} code=${code} ${why}`);
    try { this.ws.send(encodeKick(code), true, false); } catch { /* closing */ }
    try { this.ws.end(4000 + code, 'kick'); } catch { /* already closed */ }
  }

  _strike(n, why) {
    this.strikes += n;
    if (this.strikes > 20) this.kick(KICK.INVALID, why);
  }

  _rate(now) {
    this.tokens = Math.min(RATE_CAP, this.tokens + ((now - this.tokT) / 1000) * RATE_REFILL);
    this.tokT = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  // ---------------- messages ----------------
  onMessage(ab, isBinary, now) {
    if (this.closed) return;
    if (!isBinary || ab.byteLength < 1) { this._strike(5, 'text frame'); return; }
    if (!this._rate(now)) {
      // over the limit: dropped before decoding (cheap). A TCP stall can deliver tens of seconds of 20 Hz states at
      // once, so only a sustained excess (> 60 msgs/s above the limit for 10 s) counts as a flood.
      this.gw.statAdd(6, 1);
      if (now - this.dropT > 10000) { this.dropT = now; this.dropN = 0; }
      if (++this.dropN > FLOOD_DROPS) this.kick(KICK.RATE, 'flood');
      return;
    }
    const dv = new DataView(ab);
    const type = dv.getUint8(0);
    if (this.state === 'hello') {
      if (type !== C_HELLO) { this.kick(KICK.INVALID, 'expected hello'); return; }
      this._hello(dv, now);
      return;
    }
    if (this.state !== 'active') return; // queued / loading: ignore until WELCOME
    if (!this.acked) this.acked = true; // an admitted client answered the WELCOME: it keeps its place
    switch (type) {
      case C_STATE: this._stateMsg(dv, now); break;
      case C_PING: if (dv.byteLength === PING_SIZE) this.send(encodePong(dv.getUint16(2, true), dv.getFloat64(4, true), now)); else this._strike(2, 'ping'); break;
      case C_CLAIM: this._claim(dv, now); break;
      case C_SPAWN: this._spawn(dv, now); break;
      case C_INFO_REQ: this._infoReq(dv); break;
      case C_REROLL: this._nickReq({ op: NICK_OP.REROLL, reqId: dv.byteLength === REROLL_SIZE ? dv.getUint16(2, true) : 0, name: '' }, now); break;
      case C_EVENT: this._event(dv, now); break;
      case C_ECON: this._econ(dv, now); break;
      case C_FIRE: this._fire(dv, now); break;
      case C_SERVICE: this._service(dv, now); break;
      case C_LIST: this._list(dv, now); break;
      case C_OUTFIT: this._outfit(dv, now); break;
      case C_NICK: { const r = decodeNickReq(dv); if (r) this._nickReq(r, now); else this._strike(3, 'nick'); break; }
      case C_VIS: this._vis(dv, now); break;
      case C_ADMIN: void this._admin(readJson(dv), now).catch(() => { if (!this.closed) this.send(jsonMessage(S_ADMIN, { ok: false, reason: 'failed' })); }); break;
      default: this._strike(3, `type ${type}`);
    }
  }

  _hello(dv, now) {
    // the version byte first: a client of another protocol version gets "please reload", whatever its HELLO looks like
    if (dv.byteLength >= 2 && dv.getUint8(1) !== PROTO_VERSION) { this.kick(KICK.PROTOCOL, `proto ${dv.getUint8(1)}`); return; }
    const h = decodeHello(dv);
    if (!h) { this.kick(KICK.INVALID, 'hello size'); return; }
    let token = null;
    if (h.flags & HF_TOKEN) {
      let any = 0;
      for (let i = 0; i < 32; i++) any |= h.token[i];
      if (any) token = Buffer.from(h.token); // copy: the message buffer is only valid during the callback
    }
    this.newToken = token ? null : crypto.randomBytes(32);
    this.hash = crypto.createHash('sha256').update(token || this.newToken).digest();
    this.resume = !!(h.flags & HF_RESUME);
    this.exactPlacement = !!(h.flags & HF_EXACT_PLACE);
    this.offlineS = this.resume ? Math.min(h.offlineS || 0, 3600) : 0; // played offline (server unreachable) before this
    // admission: in now, or a ticket in the waiting queue (FIFO), or "full, try later" when the queue is full too
    const r = this.gw.enterOrQueue(this, now);
    if (r === 'full') { this.kick(KICK.FULL, 'queue full'); return; }
    if (r === 'queued') return;
    this._join(now);
  }

  /** Our turn (from the queue): tell the client, then the normal join on the same socket. */
  admit(now) {
    if (this.closed) return;
    this.ticket = -1;
    this.fromQueue = true;
    // waiting after a reconnect: the client kept playing offline meanwhile, so the join allows that much driving
    if (this.resume) this.offlineS = Math.min(3600, this.offlineS + Math.max(0, now - this.queuedAt) / 1000);
    this.acked = false;
    this.openedAt = now; // the join's own timeouts start now
    this.state = 'hello';
    this.send(encodeAdmit());
    this._join(now);
  }

  _join(now) {
    this.mv = new Movement(this.gw.world);
    const slot = this.gw.allocSlot();
    if (slot < 0) { this.kick(KICK.FULL, 'no slot'); return; }
    this.slot = slot;
    const v = this.v;
    this._clearVis(); // the slot's previous owner's wreck / damage
    v.gen[slot] = (v.gen[slot] + 1) & 127;
    this.netId = (slot | (v.gen[slot] << SLOT_BITS)) >>> 0;
    this.state = 'loading';
    this.gw.dbLoad(this);
  }

  /** DB answered: start the session. rec = stored record or null (new player). */
  onLoaded(rec, now) {
    if (this.closed) return;
    const gw = this.gw, v = this.v, slot = this.slot;
    if (rec && rec.flags & FLAG_BANNED) { this.kick(KICK.BANNED, 'banned'); return; }
    const isNew = !rec;
    if (!rec) {
      rec = {
        nick: '', nickCode: randomNickCode(), color: crypto.randomInt(PLAYER_COLORS.length), money: gw.cfg.startMoney,
        x: null, y: null, z: null, yaw: 0, mode: 1, vehicleId: '', paint: 0, health: 1, createdAt: Date.now(), lastSeen: Date.now(),
        stats: {}, flags: 0, owned: [], progress: {},
      };
    }
    if (!validNickCode(rec.nickCode)) rec.nickCode = randomNickCode();
    rec.nick = nickName(rec.nickCode);
    this.customName = typeof rec.customNick === 'string' ? rec.customNick : '';
    this.lastNickT = Number(rec.stats?.nickT) || -1e12;
    if (!(rec.color >= 0 && rec.color < PLAYER_COLORS.length)) rec.color = 0;
    this.rec = rec;
    // a freeze expires (30 min, doubling for repeat offenders, at most 7 days): false positives heal themselves
    if (rec.flags & FLAG_FROZEN && Number(rec.stats?.frozenUntil) > 0 && Date.now() > rec.stats.frozenUntil) {
      rec.flags &= ~FLAG_FROZEN;
      this.unfrozen = true;
    }
    this.frozen = !!(rec.flags & FLAG_FROZEN);
    this.econ = new Economy(rec, gw.econCtx, now);
    if (!rec.vehicleId || !this.econ.owned.has(rec.vehicleId)) rec.vehicleId = gw.starterCar || '';
    this.stats = { claims: 0, earned: 0, deaths: 0, playMs: 0, ...(rec.stats || {}) };
    this.paint = rec.paint >>> 0;
    this.health = Number.isFinite(rec.health) ? Math.max(0.05, Math.min(1, rec.health)) : 1;
    const m = rec.vehicleId ? gw.vehicles.byId.get(rec.vehicleId) : null;
    this.model = m ? m.index : MODEL_FOOT;
    if (m) this.approved.set(m.index, now);
    this.lastModel = this.model;
    this._applyClass(now);
    // placement: returning players continue where they left off; the client may need some slack to settle
    const hasPos = Number.isFinite(rec.x) && Number.isFinite(rec.z) && rec.x > WORLD.x0 && rec.x < WORLD.x1 && rec.z > WORLD.z0 && rec.z < WORLD.z1;
    const base = hasPos ? { x: rec.x, y: Number.isFinite(rec.y) ? rec.y : 2, z: rec.z } : DEFAULT_SPAWN;
    this.mv.place(base.x, base.y, base.z, rec.yaw || 0, now);
    let radius = hasPos ? 1500 : 1200;
    // reconnect (same page) or coming back after playing offline: the player may have driven on meanwhile (≤ 100 m/s)
    if (this.resume && hasPos) radius = Math.min(25000, 800 + Math.max(0, Math.min((Date.now() - (rec.lastSeen || 0)) / 1000, Math.max(this.offlineS, 60))) * 100);
    else if (this.resume && this.offlineS) radius = Math.min(25000, 1200 + this.offlineS * 100);
    const hospitals = gw.world.hospitals;
    this.mv.allowJump('join', now + 30000, (x, z) => gw.cfg.joinAnywhere || Math.hypot(x - base.x, z - base.z) < radius
      || Math.hypot(x - DEFAULT_SPAWN.x, z - DEFAULT_SPAWN.z) < 2000 || hospitals.some((hh) => Math.hypot(x - hh.x, z - hh.z) < 500));
    this._allowVehicleRelocation(this.model, now);
    this._restoreAdminTravel(now);
    // shared info table
    v.nick[slot] = rec.nickCode;
    v.color[slot] = rec.color;
    v.infoVer[slot] = this.infoVer;
    v.vclass[slot] = this._vclass();
    v.model[slot] = this.model;
    v.joinT[slot] = Date.now();
    this._writeInfo();
    gw.bySlot.set(slot, this);
    v.joinRing[(Atomics.add(v.joinHdr, 0, 1)) & (JOIN_RING - 1)] = this.netId;
    Atomics.store(v.alive, slot, 2);
    this.state = 'active';
    this.lastStateT = now;
    this.joinedAt = now;
    this.welcomeT = now;
    // daily bonus (first session of the UTC day): included in the WELCOME balance, announced right after it
    const daily = this.frozen ? null : this.econ.grantDaily();
    if (daily) this.dirtyFast = true;
    this.send(encodeWelcome({
      tickHz: gw.cfg.tickHz, netId: this.netId, nickCode: rec.nickCode, color: rec.color, nearR: NEAR_R, farR: FAR_R,
      spawnCooldownS: gw.cfg.spawnCooldownS, money: this.econ.money, serverTime: gw.tickTime(gw.lastTick), tick: gw.lastTick,
      // a restored session returns to its saved position and vehicle; new sessions get the starter (model) only
      restore: hasPos ? { x: rec.x, y: rec.y ?? 2, z: rec.z, yaw: rec.yaw || 0, model: this.model, health: this.health, paint: this.paint } : null,
      claimsFrozen: this.frozen, token: this.newToken, models: gw.vehicles.list, name: this.customName,
    }));
    this.newToken = null;
    this.send(jsonMessage(S_FEATURES, { bits: FEATURE.MAP | (gw.adminAuth.enabled ? FEATURE.ADMIN | (this.exactPlacement ? FEATURE.ADMIN_TRAVEL : 0) : 0) }));
    if (daily) this.send(encodeWallet(WALLET.GRANTED, 0, this.econ.money, daily.amount, CLAIM.DAILY, 1, this.econ.worth()));
    this._sendOwned();
    this._sendProgress();
    this._sendGarage(true);
    if (this.unfrozen) this.send(encodeNotice(NOTICE.CLAIMS_RESTORED, 0));
    gw.sendGlobal(this);
    this.ws.subscribe('g');
    this._updateInterest(base.x, base.y, base.z, true);
    this._sendRank(now, true);
    if (isNew) this.dirtyFast = true;
  }

  _vclass() {
    return this.model ? (this.gw.vehicles.models[this.model]?.vclass ?? VCLASS.CAR) : VCLASS.FOOT;
  }

  _applyClass(now) {
    const cls = this._vclass();
    const vmax = this.model ? (this.gw.vehicles.models[this.model]?.vmax ?? 95) : CLASS_LIMITS[VCLASS.FOOT].h;
    this.mv.setClass(cls, vmax, now);
  }

  // ---------------- state ----------------
  _stateMsg(dv, now) {
    const s = _state;
    if (!readState(dv, s)) { this._strike(3, 'state size'); return; }
    if (this.corrPending) {
      if (s.tpc !== this.corr) { // still on the old timeline: ignore until the correction is applied
        if (now - this.corrPending > 10000 && !validTravelGrant(this.stats.adminTravel, now)) this.kick(KICK.INVALID, 'correction not applied');
        return;
      }
      this.corrPending = 0;
    }
    // sequence (u16 wrap): drop duplicates and stale reorders
    if (this.lastSeq >= 0) {
      const d = (s.seq - this.lastSeq) & 0xffff;
      if (d === 0 || d > 0x8000) return;
    }
    this.lastSeq = s.seq;
    // model changes
    if (s.model !== this.model) { this._modelChange(s.model, now); if (this.closed) return; }
    s.model = this.model;
    // validate on the client's sample timeline (server-clock stamps, monotonic, never ahead of now): a TCP stall
    // delivers seconds of legit driving in one burst, which receive times would read as a teleport. The total time
    // credited can never exceed real time, so this buys a lag-switcher nothing beyond the class speed limit.
    let vt = now;
    if (s.serverClock) { const a = ((now >>> 0) - s.t) >>> 0; if (a <= 30000) vt = now - a; }
    if (vt < this.mvT) vt = this.mvT;
    this.mvT = vt;
    const code = this.mv.check(s, vt);
    if (code !== V_OK && code !== V_JUMP) { this._violation(code, now); return; }
    if (this.stats.adminTravel && (nearTravelDestination(this.stats.adminTravel, s) || !this.travelPending)) {
      delete this.stats.adminTravel; this.dirtyFast = true;
      if (this.mv.grace?.kind === 'admin-travel') this.mv.grace = null;
      this._finishAdminTravel({ ok: true });
    } else if (this.travelPending) {
      delete this.stats.adminTravel; this.mv.grace = null; this.dirtyFast = true;
      this._finishAdminTravel({ ok: false, reason: 'space' });
    }
    if (code === V_JUMP && this.lastStateT > this.openedAt && this.v.alive[this.slot] === 1) this.tpc = (this.tpc + 1) & 3;
    // sample time: clients synced by ping send server time (exact even with uplink jitter); otherwise map the
    // client clock with a min filter (absorbs queueing jitter, leaves the minimum uplink latency as a constant lag)
    let sampleT;
    const age = ((now >>> 0) - s.t) >>> 0;
    if (s.serverClock && age <= 1500) sampleT = now - age;
    else {
      const off = now - s.t;
      if (!(off >= this.offMin) || this.lastStateT === 0) this.offMin = off;
      else this.offMin += (now - this.offT) * 0.002;
      this.offT = now;
      sampleT = s.t + this.offMin;
    }
    if (sampleT > now) sampleT = now; else if (sampleT < now - 1000) sampleT = now - 1000;
    this.health = s.health;
    this.hasTurret = s.ext; this.turret = s.turret; this.barrel = s.barrel; this.hullYaw = s.yaw; this.hullPitch = s.pitch;
    this.vel = Math.hypot(s.vx, s.vz);
    // god mode: a vehicle the server destroyed must burn/explode (F_BURNING), be left, or its driver die within 3 s
    if (this.wreckDue) {
      if ((s.flags & F_BURNING) || s.model !== this.wreckModel || now < this.deadUntil) this.wreckDue = 0;
      else if (now > this.wreckDue) { this.wreckDue = 0; this._suspect(10, now, 'ignored destruction'); }
    }
    const v = this.v, slot = this.slot, p = slot * 3, r = slot * 5;
    Atomics.add(v.seq, slot, 1);
    v.pos[p] = s.x; v.pos[p + 1] = s.y; v.pos[p + 2] = s.z;
    v.vel[p] = s.vx; v.vel[p + 1] = s.vy; v.vel[p + 2] = s.vz;
    v.rot[r] = s.yaw; v.rot[r + 1] = s.pitch; v.rot[r + 2] = s.roll; v.rot[r + 3] = s.yawRate; v.rot[r + 4] = s.steer;
    v.sampleT[slot] = sampleT;
    v.receivedT[slot] = now;
    v.model[slot] = this.model;
    v.flags[slot] = (s.flags | (this.tpc & F_TPC) | ((this.infoVer & F_INFO_MASK) << F_INFO_SHIFT) | (s.ext ? F_EXT : 0)) & 0xffff;
    if (s.ext) { v.ext[slot * 2] = s.turret; v.ext[slot * 2 + 1] = s.barrel; }
    Atomics.add(v.seq, slot, 1);
    if (v.alive[slot] !== 1) Atomics.store(v.alive, slot, 1);
    if (this.away && !this.awayExplicit) this._setAway(false); // input again: back (no rejoin, no teleport)
    if (this.lastStateT) this.stats.playMs += Math.min(1000, now - this.lastStateT);
    this.lastStateT = now;
    this.dirtyPos = true;
    if (!this.closed) this._updateInterest(s.x, s.y, s.z, false);
  }

  _modelChange(m, now) {
    const vt = this.gw.vehicles;
    let ok = false;
    if (m === MODEL_FOOT) ok = true;
    else if (m >= 1 && m <= vt.count) {
      const t = this.approved.get(m);
      if (this.econ.owned.has(vt.models[m].id)) ok = true; // own vehicle (garage call, restore)
      else if (t !== undefined && now - t < 30 * 60000) ok = true; // approved recently
      else if (vt.models[m].traffic) {
        // entering a parked/traffic car (AI traffic is client-side): only ground vehicles, only from (near) standstill
        let maxSpeed = 0;
        this.mv.forEach(now - 1500, now, (t2, x, y, z, hs) => { if (hs > maxSpeed) maxSpeed = hs; });
        ok = this.model === MODEL_FOOT && maxSpeed < 9;
      }
    }
    if (!ok) {
      // keep the approved model (and its speed limits). Right after joining the client may still sit in its boot
      // vehicle, and a catalog newer than the server's table can't be checked: count each model once a minute.
      if (now - this.joinedAt > 15000 && (this.badModel !== m || now - this.badModelT > 60000)) {
        this.badModel = m; this.badModelT = now;
        this._suspect(4, now, `model ${m}`);
      }
      return;
    }
    if (m !== this.model) this._clearVis(); // another vehicle: no inherited dents / wreck
    this.model = m;
    if (m) { this.approved.set(m, now); this.lastModel = m; }
    if (this.approved.size > 8) this.approved.delete(this.approved.keys().next().value);
    this._applyClass(now);
    this.v.vclass[this.slot] = this._vclass();
    this._writeInfo(true);
    this.dirtyFast = true;
  }

  _violation(code, now) {
    this.gw.statAdd(6, 1);
    this.gw.statAdd(12, 1);
    this._suspect(code === 4 ? 6 : 3, now, V_NAMES[code]);
    this.corr = (this.corr + 1) & 3;
    this.corrPending = now;
    this.tpc = (this.tpc + 1) & 3;
    const m = this.mv;
    this.send(encodeCorrection(code, this.corr, m.x, m.y, m.z, m.yaw));
  }

  _suspect(points, now, why) {
    // suspicion decays by 1 point per 10 s
    this.suspicion = Math.max(0, this.suspicion - (now - this.suspT) / 10000) + points;
    this.suspT = now;
    if (this.suspicion > SUSPICION_KICK) { this.gw.securityLog(this, 'kick', why); this.kick(KICK.INVALID, `suspicion ${why}`); return; }
    if (this.suspicion > SUSPICION_FREEZE && !this.frozen) {
      this.frozen = true;
      this.rec.flags |= FLAG_FROZEN;
      this.stats.freezes = (this.stats.freezes || 0) + 1;
      this.stats.frozenUntil = Date.now() + Math.min(7 * 864e5, 30 * 60000 * 2 ** (this.stats.freezes - 1));
      this.dirtyFast = true;
      this.gw.securityLog(this, 'freeze', `${why} suspicion=${this.suspicion.toFixed(0)}`);
      this.send(encodeNotice(NOTICE.CLAIMS_FROZEN, 0));
    }
  }

  // ---------------- interest ----------------
  _updateInterest(x, y, z, force) {
    const cell = cellOf(x, z);
    const alt = y - Math.max(0, this.gw.world.heightAt(x, z));
    const farR = this.congested >= 1 ? 0 : alt > AIR_ALT ? FAR_R_AIR : FAR_R;
    if (!force && cell === this.cell && farR === this.farR) return;
    this.cell = cell;
    this.farR = farR;
    const cx = cell % GRID_NX, cz = (cell / GRID_NX) | 0;
    const near = [], far = [];
    for (let dz = -farR; dz <= farR; dz++) {
      for (let dx = -farR; dx <= farR; dx++) {
        const gx = cx + dx, gz = cz + dz;
        if (gx < 0 || gz < 0 || gx >= GRID_NX || gz >= GRID_NZ) continue;
        const c = gz * GRID_NX + gx;
        if (Math.abs(dx) <= NEAR_R && Math.abs(dz) <= NEAR_R) near.push(c); else far.push(c);
      }
    }
    if (farR === 0) {
      for (let dz = -NEAR_R; dz <= NEAR_R; dz++) for (let dx = -NEAR_R; dx <= NEAR_R; dx++) {
        const gx = cx + dx, gz = cz + dz;
        if (gx >= 0 && gz >= 0 && gx < GRID_NX && gz < GRID_NZ && !near.includes(gz * GRID_NX + gx)) near.push(gz * GRID_NX + gx);
      }
    }
    const gw = this.gw;
    // subscribe new first, then drop old: no gap in coverage
    for (const c of near) if (!this.near.includes(c)) gw.sub(this, 0, c);
    for (const c of far) if (!this.far.includes(c)) gw.sub(this, 1, c);
    for (const c of this.near) if (!near.includes(c)) gw.unsub(this, 0, c);
    for (const c of this.far) if (!far.includes(c)) gw.unsub(this, 1, c);
    this.near = near;
    this.far = far;
    const rc = this.congested >= 2 ? -1 : radarOf(x, z);
    if (rc !== this.radar) {
      if (rc >= 0) gw.sub(this, 2, rc);
      if (this.radar >= 0) gw.unsub(this, 2, this.radar);
      this.radar = rc;
    }
  }

  dropInterest() {
    const gw = this.gw;
    for (const c of this.near) gw.unsub(this, 0, c);
    for (const c of this.far) gw.unsub(this, 1, c);
    if (this.radar >= 0) gw.unsub(this, 2, this.radar);
    this.near = []; this.far = []; this.radar = -1; this.cell = -1;
  }

  // ---------------- economy ----------------
  _claim(dv, now) {
    const c = decodeClaim(dv);
    if (!c) { this._strike(3, 'claim size'); return; }
    // right after a join / respawn jump, location-bound claims wait: a reconnect can't be used to hop to a postcard
    if (now - this.mv.jumpT < CLAIM_SETTLE_MS) {
      this.send(encodeWallet(WALLET.REJECTED, c.seq, this.econ.money, 0, c.reason, this.econ.combo, this.econ.worth()));
      return;
    }
    const res = this.econ.claim(c, now, this.mv, { vclass: this._vclass(), model: this.model, frozen: this.frozen, dead: now < this.deadUntil });
    if (res.granted > 0) {
      this.dirtyFast = true;
      this.stats.claims++;
      this.stats.earned += res.granted;
      this.gw.statAdd(7, 1);
    } else {
      this.gw.statAdd(8, 1);
      if (res.why === 'implausible' || /observed|not there|not in/.test(res.why)) this._suspect(2, now, `claim ${c.reason} ${res.why}`);
      if (this.econ.rejected > 30) this._suspect(5, now, 'claim spam');
    }
    this.send(encodeWallet(res.result, c.seq, this.econ.money, res.granted, c.reason, res.combo, this.econ.worth()));
    if (res.progress) this._sendProgress();
  }

  _econ(dv, now) {
    const r = decodeEcon(dv);
    if (!r) { this._strike(3, 'econ size'); return; }
    // economy requests: 10 burst, 2 per second
    this.econTokens = Math.min(10, this.econTokens + ((now - this.econT) / 1000) * 2);
    this.econT = now;
    const vt = this.gw.vehicles;
    const id = r.model >= 1 && r.model <= vt.count ? vt.models[r.model].id : null;
    let res;
    if (this.econTokens < 1) res = { result: ECON_RESULT.RATE, delta: 0 };
    else if (this.frozen && r.op !== ECON.REPAIR && r.op !== ECON.PAINT) res = { result: ECON_RESULT.FROZEN, delta: 0 };
    else {
      this.econTokens--;
      switch (r.op) {
        case ECON.BUY: res = id ? this.econ.buy(id) : { result: ECON_RESULT.UNKNOWN, delta: 0 }; break;
        case ECON.SELL: res = id ? this.econ.sell(id, r.param / 100) : { result: ECON_RESULT.UNKNOWN, delta: 0 }; break;
        case ECON.REPAIR: res = id ? this.econ.repair(id, r.param / 100) : { result: ECON_RESULT.UNKNOWN, delta: 0 }; break;
        case ECON.PAINT: res = this.econ.paint(r.param ? 1 : 0); break;
        default: this._strike(3, 'econ op'); return;
      }
    }
    if (res.result === ECON_RESULT.OK) {
      this.dirtyFast = true;
      if (r.op === ECON.BUY || r.op === ECON.SELL) {
        this.gw.flushNow(this); // purchases are persisted immediately
        if (r.op === ECON.SELL && this.model === r.model) this.approved.set(r.model, now); // keep driving the sold car until exit
      }
    }
    this.send(encodeEconReply(r.op, r.reqId, res.result, r.model, this.econ.money, res.delta));
    if (res.result === ECON_RESULT.OK && (r.op === ECON.BUY || r.op === ECON.SELL)) this._sendOwned();
    else if (res.result === ECON_RESULT.OK) this.send(encodeWallet(WALLET.CHARGE, 0, this.econ.money, res.delta, 0, this.econ.combo, this.econ.worth()));
  }

  _sendOwned() {
    const vt = this.gw.vehicles, idx = [];
    for (const id of this.econ.owned) { const m = vt.byId.get(id); if (m) idx.push(m.index); }
    this.send(encodeOwned(idx, this.econ.worth()));
  }

  _sendProgress() { this.send(encodeProgress(this.econ.progressJSON())); }

  _spawn(dv, now) {
    const r = decodeSpawn(dv);
    if (!r) { this._strike(3, 'spawn size'); return; }
    const vt = this.gw.vehicles, cd = this.gw.cfg.spawnCooldownS * 1000;
    let code = SPAWN.OK;
    if (r.model < 1 || r.model > vt.count) code = SPAWN.UNKNOWN_MODEL;
    else if (!this.econ.owned.has(vt.models[r.model].id)) code = SPAWN.NOT_OWNED;
    else if (now - this.lastSpawn < cd) code = SPAWN.COOLDOWN;
    else if (now < this.deadUntil) code = SPAWN.DEAD;
    else if (Math.hypot(r.x - this.mv.x, r.z - this.mv.z) > 40) code = SPAWN.TOO_FAR;
    if (code === SPAWN.OK) {
      this.lastSpawn = now;
      this.approved.set(r.model, now);
      if (this.approved.size > 6) this.approved.delete(this.approved.keys().next().value);
      this._setPaint(r.rgb);
      this._allowVehicleRelocation(r.model, now);
    }
    this.send(encodeSpawnAck(code, r.reqId, r.model, code === SPAWN.COOLDOWN ? (cd - (now - this.lastSpawn)) / 1000 : 0));
  }

  _allowVehicleRelocation(index, now) {
    const model = this.gw.vehicles.models[index];
    if (!model || !this.econ.owned.has(model.id)) return;
    const destination = vehicleSpawnDestination(model, { x: this.mv.x, z: this.mv.z }, this.gw.world);
    if (!destination) return;
    // Keep the original join/respawn allowance, but never chain old spawn grants.
    const previous = this.mv.grace?.kind !== 'vehicle-spawn' ? this.mv.grace : null;
    this.mv.allowJump('vehicle-spawn', now + 30000, (x, z, state, at) =>
      destination(x, z, state) || !!(previous && at <= previous.until && previous.test(x, z, state, at)));
  }

  /** The colour the player's car shows (rgb) and its finish (index + 1 into PAINT_FINISHES, 0 = keep). */
  _setPaint(rgb, finish = 0) {
    const f = finish >= 1 && finish <= PAINT_FINISHES.length ? finish - 1 : this.paintFinish || 0;
    if ((rgb >>> 0) === this.paint && f === (this.paintFinish || 0)) return;
    this.paint = rgb >>> 0;
    this.paintFinish = f;
    this._writeInfo(true);
  }

  /** Publish this player's info (nick, colour, paint, cosmetics of the current vehicle, outfit, worth) to the shared table. */
  _writeInfo(bump = false) {
    const v = this.v, slot = this.slot;
    if (slot < 0) return;
    const id = this.model ? this.gw.vehicles.models[this.model]?.id : null;
    const c = id ? this.econ.cosmeticsOf(id) : null;
    Atomics.add(v.infoSeq, slot, 1);
    v.nick[slot] = this.rec.nickCode;
    setSlotName(v, slot, this.customName);
    v.paint[slot] = (c?.paint ?? this.paint) >>> 0;
    const k = slot * 8;
    v.cosm[k] = c?.neon ?? 255; v.cosm[k + 1] = c?.tint ? 1 : 0; v.cosm[k + 2] = c?.horn ?? 255; v.cosm[k + 3] = c?.paint != null ? c.finish : this.paintFinish || 0;
    v.cosm[k + 4] = c?.armor ? 1 : 0;
    // outfit as D's appearance codes (item + colour index in one u16): what remote avatars are dressed from
    const o = slot * OUTFIT_STRIDE, wt = this.gw.wardrobe;
    const codes = outfitCodes(Object.values(this.econ.outfit).filter((id) => wt?.byId.has(id)), (id) => this.econ.clothes.get(id) ?? null);
    const n = Math.min(OUTFIT_STRIDE - 1, codes.length);
    for (let k = 0; k < n; k++) v.outfit[o + 1 + k] = codes[k];
    v.outfit[o] = n;
    v.worth[slot] = this.econ.worth();
    Atomics.add(v.infoSeq, slot, 1);
    if (bump) this._bumpInfo();
  }

  _bumpInfo() {
    this.infoVer = (this.infoVer + 1) & F_INFO_MASK;
    this.v.infoVer[this.slot] = this.infoVer;
    const v = this.v, slot = this.slot;
    Atomics.add(v.seq, slot, 1);
    v.flags[slot] = (v.flags[slot] & ~F_INFO) | (this.infoVer << F_INFO_SHIFT);
    Atomics.add(v.seq, slot, 1);
    this.dirtyFast = true;
  }

  _infoReq(dv) {
    const n = decodeInfoReq(dv, _ids);
    if (n < 0) { this._strike(3, 'info size'); return; }
    const v = this.v, N = v.N;
    const buf = new ArrayBuffer(2 + n * INFO_MAX), out = new DataView(buf);
    let o = 2, k = 0;
    for (let i = 0; i < n; i++) {
      const id = _ids[i], slot = id & ((1 << SLOT_BITS) - 1), gen = id >>> SLOT_BITS;
      if (slot >= N || v.alive[slot] === 0 || v.gen[slot] !== gen) continue;
      o = writeInfo(out, o, readSlotInfo(v, slot, id, _info));
      k++;
    }
    writeInfoHeader(out, k);
    this.send(buf.slice(0, o));
  }

  // ---------------- nicknames ----------------
  // reroll from the generator ($2,500) or a custom name ($50,000): validated (format, blocklist, impersonation),
  // unique among all players (DB thread, case-insensitive), at most one change per 10 minutes, charged only on success
  _nickReply(code, r, cd = 0) {
    this.send(encodeNick(code, r.reqId, this.rec.nickCode, cd, this.customName, this.econ.money, this.stats.rerolls | 0, r.op));
  }

  _nickReq(r, now) {
    if (r.op === NICK_OP.CHECK) { // availability of a custom name: free, ≤ 1 per second
      if (now - (this.lastNickCheck || 0) < 900) return this._nickReply(NICK_RESULT.BUSY, r);
      this.lastNickCheck = now;
      const why = checkName(r.name, this.gw.blocklist, nickName(this.rec.nickCode));
      if (why) return this._nickReply(NICK_REASON[why] ?? NICK_RESULT.FORMAT, r);
      this.gw.db.postMessage({ t: 'nick', check: true, w: this.gw.id, sid: this.sid, hash: new Uint8Array(this.hash), reqId: r.reqId, op: r.op, name: r.name });
      return;
    }
    const wait = NICK_COOLDOWN_S * 1000 - (Date.now() - this.lastNickT);
    if (this.nickBusy) return this._nickReply(NICK_RESULT.BUSY, r);
    if (wait > 0) return this._nickReply(NICK_RESULT.COOLDOWN, r, wait / 1000);
    if (this.frozen) return this._nickReply(NICK_RESULT.BUSY, r);
    if (r.op === NICK_OP.REROLL) {
      if (this.econ.money < nickPrice('reroll', this.stats.rerolls | 0)) return this._nickReply(NICK_RESULT.FUNDS, r);
      if (!this.customName) return this._applyNick(r, NICK_OP.REROLL, '');
      // drop the custom name first (frees it for others), then reroll
      this.nickBusy = true;
      this.gw.db.postMessage({ t: 'nick', w: this.gw.id, sid: this.sid, hash: new Uint8Array(this.hash), reqId: r.reqId, op: NICK_OP.REROLL, name: '' });
      return;
    }
    if (r.op !== NICK_OP.CUSTOM) { this._strike(3, 'nick op'); return; }
    if (this.econ.money < nickPrice('custom')) return this._nickReply(NICK_RESULT.FUNDS, r);
    const why = checkName(r.name, this.gw.blocklist, nickName(this.rec.nickCode));
    if (why) return this._nickReply(NICK_REASON[why] ?? NICK_RESULT.FORMAT, r);
    if (r.name === this.customName) return this._nickReply(NICK_RESULT.TAKEN, r);
    this.nickBusy = true;
    this.gw.db.postMessage({ t: 'nick', w: this.gw.id, sid: this.sid, hash: new Uint8Array(this.hash), reqId: r.reqId, op: NICK_OP.CUSTOM, name: r.name });
  }

  /** DB answered a nick claim/check: { reqId, op, name, check, result: 'ok' | 'taken' | 'missing' }. */
  onNickResult(m) {
    if (this.closed || !this.econ) return;
    if (m.check) return this._nickReply(m.result === 'taken' ? NICK_RESULT.TAKEN : NICK_RESULT.OK, m);
    this.nickBusy = false;
    if (m.result === 'taken') return this._nickReply(NICK_RESULT.TAKEN, m);
    if (m.result === 'missing' && !m.retried) { // a brand-new profile not saved yet: save it, then claim again (in order)
      this.nickBusy = true;
      this.gw.flushNow(this);
      this.gw.db.postMessage({ t: 'nick', w: this.gw.id, sid: this.sid, hash: new Uint8Array(this.hash), reqId: m.reqId, op: m.op, name: m.name, retried: true });
      return;
    }
    if (m.result !== 'ok') return this._nickReply(NICK_RESULT.BUSY, m);
    this._applyNick(m, m.op, m.name);
  }

  _applyNick(r, op, name) {
    const price = op === NICK_OP.CUSTOM ? nickPrice('custom') : nickPrice('reroll', this.stats.rerolls | 0);
    if (this.econ.money < price) return this._nickReply(NICK_RESULT.FUNDS, r);
    this.econ.money -= price;
    if (op === NICK_OP.REROLL) {
      let code;
      do code = randomNickCode(); while (code === this.rec.nickCode);
      this.rec.nickCode = code;
      this.rec.nick = nickName(code);
      this.customName = '';
      this.stats.rerolls = (this.stats.rerolls | 0) + 1;
    } else this.customName = name;
    this.lastNickT = Date.now();
    this.stats.nickT = this.lastNickT;
    this._writeInfo(true);
    this.gw.flushNow(this);
    this._nickReply(NICK_RESULT.OK, { reqId: r.reqId, op }, NICK_COOLDOWN_S);
    if (price) this.send(encodeWallet(WALLET.CHARGE, 0, this.econ.money, -price, 0, this.econ.combo, this.econ.worth()));
  }

  // ---------------- visual state (C_VIS): stored per player, served in INFO, so late joiners see it too ----------------
  _vis(dv, now) {
    const r = decodeVis(dv);
    if (!r) { this._strike(3, 'vis'); return; }
    if (this.slot < 0 || this.state !== 'active') return;
    const v = this.v, slot = this.slot;
    if (r.kind === VIS.WRECK) {
      // the seed of a tank's destruction (everyone replays the same turret toss); a tank only, once per 5 s
      const m = this.model ? this.gw.vehicles.models[this.model] : null;
      if (!weaponOfModel(m) || r.data.length !== 4) { this._strike(2, 'vis wreck'); return; }
      if (now - (this.lastWreckVis || 0) < 5000) return;
      this.lastWreckVis = now;
      v.wreck[slot * 2] = (r.data[0] | (r.data[1] << 8) | (r.data[2] << 16) | (r.data[3] << 24)) >>> 0;
      v.wreck[slot * 2 + 1] = Date.now() >>> 0;
      this._writeInfo(true);
    } else if (r.kind === VIS.DAMAGE) {
      // compact car damage (panels, glass, lamps, last impacts; opaque here, ≤ VIS_MAX bytes): ≤ 3 updates per second
      if (!this.model || r.data.length > VIS_MAX) { this._strike(2, 'vis damage'); return; }
      if (now - (this.lastDamageVis || 0) < 300) return;
      this.lastDamageVis = now;
      const o = slot * DAMAGE_STRIDE;
      Atomics.add(v.infoSeq, slot, 1);
      v.damage[o] = r.data.length;
      v.damage[o + 1] = (v.damage[o + 1] + 1) & 0xff;
      v.damage.set(r.data, o + 2);
      Atomics.add(v.infoSeq, slot, 1);
      this._writeInfo(true);
    } else if (r.kind === VIS.AWAY) {
      // the page says it went to the background / came back (sent from visibilitychange)
      if (r.data.length !== 1) { this._strike(2, 'vis away'); return; }
      this.awayExplicit = r.data[0] === 1;
      this._setAway(this.awayExplicit);
    } else this._strike(2, `vis ${r.kind}`);
  }

  _setAway(b) {
    if (this.slot < 0 || this.away === b) return;
    this.away = b;
    if (!b) this.awayExplicit = false;
    this.v.away[this.slot] = b ? 1 : 0;
    this._writeInfo(true);
  }

  _clearVis() {
    if (this.slot < 0) return;
    const v = this.v, slot = this.slot;
    v.wreck[slot * 2] = 0;
    v.away[slot] = 0;
    if (v.damage[slot * DAMAGE_STRIDE]) { v.damage[slot * DAMAGE_STRIDE] = 0; v.damage[slot * DAMAGE_STRIDE + 1]++; }
  }

  // ---------------- combat ----------------
  _fire(dv, now) {
    const f = decodeFire(dv);
    if (!f) { this._strike(3, 'fire size'); return; }
    const m = this.model ? this.gw.vehicles.models[this.model] : null;
    const weapon = weaponOfModel(m), w = WEAPONS[f.weapon];
    const bad = (why, pts = 2) => { this.gw.statAdd(6, 1); this._suspect(pts, now, `fire: ${why}`); };
    if (!w || weapon !== f.weapon) return bad('no weapon', 3);
    if (now < this.deadUntil || this.wreckDue) return;
    if (!finite3(f.x, f.y, f.z) || !Number.isFinite(f.yaw) || !Number.isFinite(f.pitch)) return bad('nan', 4);
    // shot time on the server clock (the client is synced by pings); monotonic, never in the future
    const a = ((now >>> 0) - f.t) >>> 0;
    let t = a <= 1000 ? now - a : now;
    if (t < this.lastShotT) t = this.lastShotT;
    // reload: on the shot timeline AND on receive times (stamps can't be used to squeeze shots together)
    if (t - this.lastShotT < w.reloadMs - 60 || now - this.lastShotRecv < w.reloadMs - 700) return bad('reload', 1);
    // muzzle near the server-known vehicle; barrel aimed where the replicated turret points
    const mv = this.mv, slack = w.muzzleSlack + (this.vel || 0) * 0.3;
    if (Math.hypot(f.x - mv.x, f.z - mv.z) > slack || Math.abs(f.y - mv.y) > slack) return bad('muzzle', 2);
    if (this.hasTurret) {
      const dyaw = Math.abs(wrapAngle(f.yaw - (this.hullYaw + this.turret)));
      if (dyaw > w.aimSlack || Math.abs(f.pitch - (this.barrel + (this.hullPitch || 0))) > w.aimSlack + 0.1) return bad('aim', 1);
    }
    this.lastShotT = t;
    this.lastShotRecv = now;
    this.gw.toHub({ t: 'shot', netId: this.netId, seq: f.seq, weapon: f.weapon, time: t, x: f.x, y: f.y, z: f.z, yaw: f.yaw, pitch: f.pitch, clear: f.clear });
  }

  /** Direct message from the hub (damage to us, hit confirmation of our shot): track and forward. */
  onHub(bytes) {
    if (this.closed || this.state !== 'active') return;
    if (bytes[0] === S_DAMAGE) {
      const d = readDamage(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (d.destroyed && !this.wreckDue) { this.wreckDue = serverNowMs() + 3000; this.wreckModel = this.model; }
    }
    this.send(bytes.slice());
  }

  // ---------------- services, wardrobe ----------------
  _service(dv, now) {
    const r = decodeService(dv);
    if (!r) { this._strike(3, 'service size'); return; }
    this.econTokens = Math.min(10, this.econTokens + ((now - this.econT) / 1000) * 2);
    this.econT = now;
    const vt = this.gw.vehicles;
    const id = r.model >= 1 && r.model <= vt.count ? vt.models[r.model].id : null;
    let res;
    if (this.econTokens < 1) res = { result: ECON_RESULT.RATE, delta: 0 };
    else if (this.frozen && r.op !== SERVICE.USE_EXTINGUISHER && r.op !== SERVICE.ARMOR_GONE && r.op !== SERVICE.NEON_COLOR) res = { result: ECON_RESULT.FROZEN, delta: 0 };
    else {
      this.econTokens--;
      if (r.op === WARDROBE_OP.BUY) {
        // opt: 0 buy, 1 re-dye; rgb bit 24 = a colour is given
        const it = this.gw.wardrobe?.byIndex[r.item];
        res = it ? this.econ.buyClothing(it.id, (r.rgb >>> 24) & 1 ? r.rgb & 0xffffff : null, r.opt === 1) : { result: ECON_RESULT.UNKNOWN, delta: 0 };
        if (res.result === ECON_RESULT.OK) { res.changed = true; res.cosmetic = !!res.worn; }
      } else {
        const opts = {
          color: r.op === SERVICE.respray ? r.rgb & 0xffffff : r.opt === 255 ? null : r.opt,
          variant: r.op === SERVICE.horn ? HORN_VARIANTS[r.opt] : undefined,
          finish: r.op === SERVICE.respray ? PAINT_FINISHES[r.opt] ?? 'color' : undefined,
          damage: r.op === SERVICE.repair ? (r.rgb >>> 24) / 100 : 0,
        };
        res = this.econ.service(r.op, id, opts);
      }
    }
    if (res.result === ECON_RESULT.OK) {
      this.dirtyFast = true;
      if (res.delta) this.gw.flushNow(this);
      if (res.cosmetic || r.op === WARDROBE_OP.BUY) this._writeInfo(!!res.cosmetic); // worth changes too
    }
    this.send(encodeEconReply(r.op, r.reqId, res.result, r.model, this.econ.money, res.delta));
    if (res.changed) this._sendGarage(false);
    if (res.result === ECON_RESULT.OK && res.delta) this.send(encodeWallet(WALLET.CHARGE, 0, this.econ.money, res.delta, 0, this.econ.combo, this.econ.worth()));
  }

  _outfit(dv, now) {
    const items = decodeOutfit(dv);
    if (!items) { this._strike(3, 'outfit'); return; }
    if (now - this.lastOutfit < 1000) { this.send(encodeEconReply(WARDROBE_OP.BUY + 1, 0, ECON_RESULT.RATE, 0, this.econ.money, 0)); return; }
    this.lastOutfit = now;
    // D's appearance codes → catalogue ids (the colour part is ignored: you wear the colour you own)
    const wt = this.gw.wardrobe, ids = [];
    for (const code of items) { const id = itemOfCode(code)?.id; if (!id || !wt?.byId.has(id)) { ids.length = 0; ids.push(null); break; } ids.push(id); }
    const result = ids[0] === null ? ECON_RESULT.UNKNOWN : this.econ.setOutfit(ids);
    if (result === ECON_RESULT.OK) { this._writeInfo(true); this.dirtyFast = true; }
    this.send(encodeEconReply(WARDROBE_OP.BUY + 1, 0, result, 0, this.econ.money, 0));
    if (result === ECON_RESULT.OK) this._sendGarage(false);
  }

  _sendGarage(withCatalog) {
    const g = this.econ.garageJSON();
    const w = this.econ.wardrobeJSON();
    const msg = { inventory: g.inventory, custom: g.custom, clothes: w.own, outfit: w.fit, rerolls: this.stats.rerolls | 0 };
    // the wire numbering of wardrobe items (INFO outfits, C_OUTFIT, purchases): once per connection
    if (withCatalog && this.gw.wardrobe) { msg.wardrobe = this.gw.wardrobe.ids; msg.wardrobeSlots = this.gw.wardrobe.slots; }
    this.send(encodeGarage(msg));
  }

  // ---------------- scoreboard pages ----------------
  _restoreAdminTravel(now) {
    const grant = this.stats.adminTravel;
    if (!validTravelGrant(grant, now)) { delete this.stats.adminTravel; return; }
    const previous = this.mv.grace;
    this.mv.allowJump('admin-travel', grant.until, (x, z, s, at) => nearTravelDestination(grant, s)
      || !!(previous && at <= previous.until && previous.test(x, z, s, at)));
  }

  beginAdminTravel(pose, now, reply) {
    const grant = { ...pose, model: this.model, until: now + 300000 };
    this.stats.adminTravel = grant; this._restoreAdminTravel(now);
    this.corr = (this.corr + 1) & 3; this.corrPending = now;
    const timer = setTimeout(() => this._finishAdminTravel({ ok: false, reason: 'timeout' }), 30000);
    this.travelPending = { reply, timer };
    this.dirtyFast = true; this.gw.flushNow(this); // grant survives a reconnect before the acknowledgement
    this.send(encodeCorrection(ADMIN_CORRECTION, this.corr, pose.x, pose.y, pose.z, pose.yaw));
  }

  _finishAdminTravel(result) {
    const pending = this.travelPending;
    if (!pending) return;
    this.travelPending = null; clearTimeout(pending.timer); pending.reply(result);
  }

  async _admin(r, now) {
    if (!r || !Number.isInteger(r.id) || r.id < 1 || r.id > 0xffffffff || typeof r.op !== 'string') return;
    const reply = (value) => { if (!this.closed) this.send(jsonMessage(S_ADMIN, { id: r.id, ...value })); };
    if (this.adminPending) return reply({ ok: false, reason: 'busy' });
    if (r.id <= (this.adminLastId || 0)) return reply({ ok: false, reason: 'replay' });
    this.adminLastId = r.id;
    if (r.op === 'login') {
      this.adminPending = true;
      let result;
      try { result = await this.gw.adminAuth.verify(this.ip, r.password, now); }
      finally { r.password = ''; this.adminPending = false; }
      if (this.closed) return;
      if (result !== 'ok') return reply({ ok: false, reason: result });
      this.adminUntil = performance.timeOrigin + performance.now() + ADMIN_TTL;
      this.gw.securityLog(this, 'admin', 'login');
      return reply({ ok: true, ttl: ADMIN_TTL / 1000 });
    }
    if (r.op === 'logout') { this.adminUntil = 0; return reply({ ok: true, ttl: 0 }); }
    if (!(now < this.adminUntil)) return reply({ ok: false, reason: 'auth' });
    if (now - (this.adminActionAt || 0) < 500) return reply({ ok: false, reason: 'rate' });
    if (r.op === 'travel_to' || r.op === 'bring') {
      if (!this.exactPlacement) return reply({ ok: false, reason: 'update' });
      if (!Number.isInteger(r.target) || r.target < 1 || r.target > 0xffffff || r.target === this.netId) return reply({ ok: false, reason: 'player' });
      if (this.corrPending) return reply({ ok: false, reason: 'busy' });
      this.adminActionAt = now; this.adminPending = true;
      try {
        const result = await this.gw.requestAdminTravel(this, r.target, r.op === 'bring', r.id, now);
        if (result.ok) this.gw.securityLog(this, 'admin', `${r.op} ${r.target}`);
        return reply(result);
      } finally { this.adminPending = false; }
    }
    const e = this.econ;
    if (r.op === 'credit') {
      if (!Number.isSafeInteger(r.amount) || r.amount < 1 || r.amount > 100000000 || e.money + r.amount > 1000000000) return reply({ ok: false, reason: 'amount' });
      e.money += r.amount;
    } else if (r.op === 'unlock') {
      for (const [id] of this.gw.econCtx.prices) e.owned.add(id);
      for (const [id] of this.gw.wardrobe?.byId || []) if (!e.clothes.has(id)) e.clothes.set(id, null);
      this._sendOwned(); this._sendGarage(false);
    } else if (r.op === 'thaw') {
      this.frozen = false; this.rec.flags &= ~FLAG_FROZEN; delete this.stats.frozenUntil;
      this.suspicion = 0; this.suspT = now;
      this.send(encodeNotice(NOTICE.CLAIMS_RESTORED, 0));
    } else return reply({ ok: false, reason: 'invalid' });
    this.adminActionAt = now; this.dirtyFast = true;
    this._writeInfo(true);
    this.gw.flushNow(this);
    this.send(encodeWallet(WALLET.SYNC, 0, e.money, 0, 0, e.combo, e.worth()));
    this._sendRank(now, true);
    this.gw.securityLog(this, 'admin', r.op === 'credit' ? `credit ${r.amount}` : r.op);
    reply({ ok: true, balance: e.money, ttl: Math.max(0, Math.floor((this.adminUntil - now) / 1000)) });
  }

  // "online" pages walk the shared ring of recent joins backwards from a cursor: O(page), never a full list
  _list(dv, now) {
    const r = decodeList(dv);
    if (!r) { this._strike(3, 'list'); return; }
    if (r.order === MAP_ORDER) {
      if (now - (this.lastMapPage ?? -1e12) < 80) return;
      this.lastMapPage = now;
      this.gw.sendMap(this, r.cursor, now); return;
    }
    if (r.order === LIST.WORTH || r.order === LIST.DENSITY) {
      // small snapshots served on request instead of broadcast to everyone (≤ 1 per second each)
      const k = r.order === LIST.WORTH ? 'lastBoard' : 'lastDensity';
      if (now - (this[k] || -1e12) < 900) return;
      this[k] = now;
      if (r.order === LIST.WORTH) { this.gw.sendBoard(this); this._sendRank(now, true); } else this.gw.sendDensity(this);
      return;
    }
    if (now - this.lastList < 900) return; // ≤ 1 page per second
    this.lastList = now;
    const v = this.v, head = Atomics.load(v.joinHdr, 0);
    let cur = r.cursor > 0 && r.cursor <= head ? r.cursor : head; // cursor = ring position + 1 to read next (exclusive)
    const floor = Math.max(0, head - JOIN_RING);
    const buf = new ArrayBuffer(LIST_HDR + LIST_PAGE * LIST_ENTRY), out = new DataView(buf);
    let n = 0, o = LIST_HDR;
    const seen = new Set();
    const nowMs = Date.now();
    while (cur > floor && n < LIST_PAGE) {
      cur--;
      const id = v.joinRing[cur & (JOIN_RING - 1)], slot = id & SLOT_MASK;
      if (!id || seen.has(id) || v.alive[slot] === 0 || ((slot | (v.gen[slot] << SLOT_BITS)) >>> 0) !== (id >>> 0)) continue;
      seen.add(id);
      const k = slot * 3;
      o = writeListEntry(out, o, {
        netId: id, nickCode: v.nick[slot], color: v.color[slot], vclass: v.vclass[slot], model: v.model[slot], visible: v.alive[slot] === 1,
        worth: v.worth[slot], x: v.pos[k], z: v.pos[k + 2], onlineS: (nowMs - v.joinT[slot]) / 1000, name: slotName(v, slot),
      });
      n++;
    }
    writeListHeader(out, n, r.reqId, cur > floor ? cur : 0, this.gw.v.hub[3]);
    this.send(buf.slice(0, o));
  }

  _event(dv, now) {
    if (dv.byteLength !== EVENT_SIZE) { this._strike(3, 'event size'); return; }
    const kind = dv.getUint8(1), param = dv.getUint32(4, true);
    if (kind === EV_DIED) {
      if (now - this.lastDeath < DEATH_MIN_INTERVAL) return;
      this.lastDeath = now;
      this.deadUntil = now + 4000;
      this.stats.deaths++;
      const fee = this.econ.hospital();
      if (fee > 0) {
        this.send(encodeWallet(WALLET.CHARGE, 0, this.econ.money, -fee, 0, 1, this.econ.worth()));
        this.send(encodeNotice(NOTICE.HOSPITAL_FEE, fee));
      }
      this.econ.combo = 1;
      this.dirtyFast = true;
      // one jump to a hospital or back to a point of the recent path (respawn at the last safe spot)
      const hospitals = this.gw.world.hospitals, mv = this.mv;
      mv.allowJump('respawn', now + 30000, (x, z) => hospitals.some((h) => Math.hypot(x - h.x, z - h.z) < 450) || mv.nearTrail(x, z, 600, now, 180000));
    } else if (kind === EV_RESPAWNED) {
      this.health = 1;
    } else if (kind === EV_PAINT) {
      if (now - this.lastPaint < 1000) return;
      this.lastPaint = now;
      this._setPaint(param & 0xffffff, param >>> 24);
    } else this._strike(2, `event ${kind}`);
  }

  // ---------------- periodic ----------------
  /** Called every ~0.5 s by the gateway sweep. */
  sweep(now) {
    if (this.state === 'hello' && now - this.openedAt > 8000) { this.kick(KICK.TIMEOUT, 'no hello'); return; }
    if (this.state === 'loading' && now - this.openedAt > 20000) { this.kick(KICK.TIMEOUT, 'load timeout'); return; }
    if (this.state !== 'active') return;
    // admitted from the queue but the client never answered (tab closed, frozen): the slot goes to the next in line
    if (!this.acked && now - this.welcomeT > this.gw.cfg.admitGraceMs) { this.kick(KICK.TIMEOUT, 'admit grace'); return; }
    const v = this.v;
    const idle = now - this.lastStateT;
    // no input (tab in the background, rAF stopped) while the socket is alive: stay in the world, frozen (the hub holds
    // a stale sample with zero velocity) with an AFK badge; a normal leave only after 5 minutes of that
    if (idle > 5000 && !this.away) this._setAway(true);
    if (idle > 300000) { this.kick(KICK.TIMEOUT, 'idle'); return; }
    // congestion: shed the far ring, then the radar, while the socket's send buffer is backed up
    const buffered = this.ws.getBufferedAmount();
    const level = buffered > 1 << 20 ? 2 : buffered > 256 << 10 ? 1 : buffered < 32 << 10 ? 0 : this.congested;
    if (level !== this.congested) {
      this.congested = level;
      this._updateInterest(this.mv.x, this.mv.y, this.mv.z, true);
    }
    // (rank: sent with the board on request and once after welcome — not pushed periodically)
    v.worth[this.slot] = this.econ.worth();
  }

  _sendRank(now, force) {
    if (!force && this.ws.getBufferedAmount() > 64 << 10) return; // low priority
    this.lastRank = now;
    const r = rankOf(this.v, this.econ.worth());
    this.send(encodeRank(r.rank, r.total));
  }

  /** Persistent record (for the DB). */
  record() {
    const rec = this.rec, mv = this.mv;
    return {
      hash: this.hash, nick: rec.nick, nickCode: rec.nickCode, color: rec.color, money: this.econ.money,
      x: mv.placed ? mv.x : rec.x, y: mv.placed ? mv.y : rec.y, z: mv.placed ? mv.z : rec.z, yaw: mv.yaw,
      mode: this.model ? 1 : 0, vehicleId: this._savedVehicle(), paint: this.paint,
      health: this.health, createdAt: rec.createdAt, lastSeen: Date.now(), stats: this.stats, flags: rec.flags,
      owned: [...this.econ.owned], progress: this.econ.progressJSON(), worth: this.econ.worth(),
      garage: this.econ.garageJSON(), wardrobe: this.econ.wardrobeJSON(),
    };
  }

  // last-used OWNED vehicle (a carjacked traffic car is not restored as yours)
  _savedVehicle() {
    const vt = this.gw.vehicles;
    for (const m of [this.model, this.lastModel]) {
      const id = m ? vt.models[m]?.id : null;
      if (id && this.econ.owned.has(id)) return id;
    }
    return this.gw.starterCar || '';
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    this._finishAdminTravel({ ok: false, reason: 'player' });
    this.gw.leaveQueue(this); // a queued connection gives its place up (no reservation)
    if (this.counted) { this.counted = false; this.gw.releaseCapacity(); }
    this.dropInterest();
    if (this.slot >= 0) {
      Atomics.store(this.v.alive, this.slot, 0);
      if (this.gw.bySlot.get(this.slot) === this) this.gw.bySlot.delete(this.slot);
      this.gw.freeSlot(this.slot);
    }
    if (this.hash) this.gw.dbRelease(this, this.state === 'active' ? this.record() : null);
  }
}

const _info = {};
/** Snapshot of a slot's info fields (retries a torn read once). */
function readSlotInfo(v, slot, netId, out) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const q = Atomics.load(v.infoSeq, slot);
    const k = slot * 8, o = slot * OUTFIT_STRIDE;
    out.netId = netId; out.nickCode = v.nick[slot]; out.color = v.color[slot]; out.infoVer = v.infoVer[slot]; out.vclass = v.vclass[slot];
    out.neon = v.cosm[k] === 255 ? null : v.cosm[k]; out.tint = v.cosm[k + 1] === 1; out.horn = v.cosm[k + 2] === 255 ? null : v.cosm[k + 2];
    out.finish = v.cosm[k + 3]; out.armor = v.cosm[k + 4] === 1; out.paint = v.paint[slot]; out.model = v.model[slot]; out.worth = v.worth[slot];
    out.name = slotName(v, slot);
    const n = Math.min(OUTFIT_STRIDE - 1, v.outfit[o]);
    out.outfit = Array.from(v.outfit.subarray(o + 1, o + 1 + n));
    const ws = v.wreck[slot * 2], age = ((Date.now() >>> 0) - v.wreck[slot * 2 + 1]) >>> 0;
    out.wreck = ws ? { seed: ws & 0x7fffffff, short: ws >>> 31 === 1, ageMs: Math.min(age, 25500) } : null;
    const d = slot * DAMAGE_STRIDE, dl = Math.min(VIS_MAX, v.damage[d]);
    out.damage = dl ? { ver: v.damage[d + 1], data: v.damage.slice(d + 2, d + 2 + dl) } : null;
    out.away = v.away[slot] === 1;
    if (!(q & 1) && Atomics.load(v.infoSeq, slot) === q) break;
  }
  return out;
}
const finite3 = (a, b, c) => Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c);
const serverNowMs = () => performance.timeOrigin + performance.now();
