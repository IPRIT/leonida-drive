// Leonida Drive multiplayer wire protocol (binary, little-endian). Shared by the browser client and the Node server.
// Every message starts with a u8 type (constants.js). Client messages have fixed sizes and are validated exactly.
// Hot path: S_CELL entity records (24 bytes) are encoded once per cell per tick and fanned out by pub/sub.
import {
  WORLD, CELL, GRID_NX, GRID_NZ, Q_POS, POS_MARGIN, Q_Y, Y_OFF, Q_VEL, Q_YAWRATE, Q_STEER, REC_SIZE, AGE_UNIT, RADAR_CELL, RADAR_NX, RADAR_NZ, RADAR_WINDOW,
  PROTO_VERSION, C_HELLO, C_STATE, C_PING, C_CLAIM, C_SPAWN, C_INFO_REQ, C_REROLL, C_EVENT,
  S_WELCOME, S_CELL, S_GLOBAL, S_RADAR, S_INFO, S_WALLET, S_RANK, S_PONG, S_SPAWN_ACK, S_CORRECTION, S_NICK, S_EVENT,
  S_KICK, S_NOTICE, S_TICK, S_DENSITY, HELLO_SIZE, STATE_SIZE, PING_SIZE, CLAIM_SIZE, SPAWN_SIZE, REROLL_SIZE, EVENT_SIZE,
  INFO_REQ_MAX, F_CLIENT_MASK, C_ECON, S_ECON, S_OWNED, S_PROGRESS, ECON_SIZE,
  F_EXT, REC_EXT, Q_BARREL, REC_FULL, REC_ROT, REC_STEER, REC_TURRET, Q_VY, S_PULSE, STATE_EXT_SIZE, C_FIRE, C_SERVICE, C_LIST, C_OUTFIT, C_NICK, S_FX, S_DAMAGE, S_GARAGE, S_LIST,
  FIRE_SIZE, SERVICE_SIZE, LIST_SIZE, OUTFIT_MAX, NICK_REQ_MAX, F_INFO_MASK, C_VIS, VIS_MAX, S_QUEUE, S_ADMIT,
} from './constants.js';

const TAU = Math.PI * 2;
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// finite-or-zero, then round and clamp to an integer range
const qi = (v, lo, hi) => clampI(Math.round(Number.isFinite(v) ? v : 0), lo, hi);

export function wrapAngle(a) {
  // angles are almost always within one turn of the range: avoid the slow float modulo
  if (a >= Math.PI) { a -= TAU; if (a >= Math.PI) a = wrapSlow(a); } else if (a < -Math.PI) { a += TAU; if (a < -Math.PI) a = wrapSlow(a); }
  return a;
}
function wrapSlow(a) {
  a %= TAU;
  if (a >= Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU;
  return a;
}
export const yawToU16 = (yaw) => Math.round((wrapAngle(Number.isFinite(yaw) ? yaw : 0) / TAU) * 65536) & 0xffff;
export const u16ToYaw = (u) => wrapAngle((u / 65536) * TAU);

// ---------------- grid helpers ----------------
export function cellOf(x, z) {
  const cx = clampI(Math.floor((x - WORLD.x0) / CELL), 0, GRID_NX - 1);
  const cz = clampI(Math.floor((z - WORLD.z0) / CELL), 0, GRID_NZ - 1);
  return cz * GRID_NX + cx;
}
export const cellX0 = (cell) => WORLD.x0 + (cell % GRID_NX) * CELL;
export const cellZ0 = (cell) => WORLD.z0 + Math.floor(cell / GRID_NX) * CELL;
export function radarOf(x, z) {
  const cx = clampI(Math.floor((x - WORLD.x0) / RADAR_CELL), 0, RADAR_NX - 1);
  const cz = clampI(Math.floor((z - WORLD.z0) / RADAR_CELL), 0, RADAR_NZ - 1);
  return cz * RADAR_NX + cx;
}
export const radarWinX0 = (rc) => WORLD.x0 + ((rc % RADAR_NX) - 1) * RADAR_CELL;
export const radarWinZ0 = (rc) => WORLD.z0 + (Math.floor(rc / RADAR_NX) - 1) * RADAR_CELL;

// ---------------- entity record (19–28 bytes) ----------------
// u24 id | u8 parts | u16 x | u16 z | u16 y | u16 yaw | i16 vx | i16 vz | i8 vy | i8 yawRate | u8 age
// [REC_FULL: u8 model | u16 flags] [REC_ROT: i8 pitch | i8 roll] [REC_STEER: i8 steer] [REC_TURRET: u16 turret | i8 barrel]
// x/z are relative to the cell origin minus an 8 m margin (1/448 m), y in 5 cm with a -100 m offset, vx/vz in cm/s,
// vy in 1/4 m/s, age = sample time before the tick (2 ms units: position and velocity come from the same instant).
// Optional parts are sent when they changed (or when the cell has a new viewer); the receiver keeps the last ones.

/**
 * Encode one record from `r` = { x, y, z, yaw, pitch, roll, vx, vy, vz, yawRate, steer, model, flags, age, turret, barrel }
 * with the given part mask. Writes the dequantised motion the receiver will decode into `deq` (Float64Array(8):
 * x, y, z, yaw, vx, vy, vz, yawRate) so the sender can mirror the receiver's dead reckoning exactly.
 */
export function writeRecord(dv, o, id, cx0, cz0, r, parts, deq) {
  const qx = qi((r.x - cx0 + POS_MARGIN) * Q_POS, 0, 65535);
  const qz = qi((r.z - cz0 + POS_MARGIN) * Q_POS, 0, 65535);
  const qy = qi((r.y + Y_OFF) * Q_Y, 0, 65535);
  const qyaw = yawToU16(r.yaw);
  const qvx = qi(r.vx * Q_VEL, -32767, 32767), qvz = qi(r.vz * Q_VEL, -32767, 32767), qvy = qi(r.vy * Q_VY, -127, 127);
  const qyr = qi(r.yawRate * Q_YAWRATE, -127, 127);
  if (r.flags & F_EXT) parts |= REC_TURRET; else parts &= ~REC_TURRET;
  dv.setUint16(o, id & 0xffff, true);
  dv.setUint8(o + 2, (id >>> 16) & 0xff);
  dv.setUint8(o + 3, parts);
  dv.setUint16(o + 4, qx, true);
  dv.setUint16(o + 6, qz, true);
  dv.setUint16(o + 8, qy, true);
  dv.setUint16(o + 10, qyaw, true);
  dv.setInt16(o + 12, qvx, true);
  dv.setInt16(o + 14, qvz, true);
  dv.setInt8(o + 16, qvy);
  dv.setInt8(o + 17, qyr);
  dv.setUint8(o + 18, qi(r.age, 0, 255));
  o += REC_SIZE;
  if (parts & REC_FULL) { dv.setUint8(o, r.model & 0xff); dv.setUint16(o + 1, r.flags & 0xffff, true); o += 3; }
  if (parts & REC_ROT) { dv.setInt8(o, qi((r.pitch / (Math.PI / 2)) * 127, -127, 127)); dv.setInt8(o + 1, qi((r.roll / Math.PI) * 127, -127, 127)); o += 2; }
  if (parts & REC_STEER) { dv.setInt8(o, qi(r.steer * Q_STEER, -127, 127)); o += 1; }
  if (parts & REC_TURRET) { dv.setUint16(o, yawToU16(r.turret), true); dv.setInt8(o + 2, qi(r.barrel * Q_BARREL, -127, 127)); o += 3; }
  if (deq) {
    deq[0] = cx0 - POS_MARGIN + qx / Q_POS; deq[1] = qy / Q_Y - Y_OFF; deq[2] = cz0 - POS_MARGIN + qz / Q_POS;
    deq[3] = u16ToYaw(qyaw);
    deq[4] = qvx / Q_VEL; deq[5] = qvy / Q_VY; deq[6] = qvz / Q_VEL;
    deq[7] = qyr / Q_YAWRATE;
  }
  return o;
}
/** Encoded size of a record with these parts (and flags, for the turret part). */
export function recSize(parts, flags) {
  if (flags & F_EXT) parts |= REC_TURRET;
  return REC_SIZE + (parts & REC_FULL ? 3 : 0) + (parts & REC_ROT ? 2 : 0) + (parts & REC_STEER ? 1 : 0) + (parts & REC_TURRET ? 3 : 0);
}

/**
 * Decode one record into `out` (reused). Fields of parts that are absent are left unset (out.parts tells which are
 * present); out.size = bytes used.
 */
export function readRecord(dv, o, cx0, cz0, out) {
  const o0 = o;
  out.id = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16);
  const parts = dv.getUint8(o + 3);
  out.parts = parts;
  out.x = cx0 - POS_MARGIN + dv.getUint16(o + 4, true) / Q_POS;
  out.z = cz0 - POS_MARGIN + dv.getUint16(o + 6, true) / Q_POS;
  out.y = dv.getUint16(o + 8, true) / Q_Y - Y_OFF;
  out.yaw = u16ToYaw(dv.getUint16(o + 10, true));
  out.vx = dv.getInt16(o + 12, true) / Q_VEL;
  out.vz = dv.getInt16(o + 14, true) / Q_VEL;
  out.vy = dv.getInt8(o + 16) / Q_VY;
  out.yawRate = dv.getInt8(o + 17) / Q_YAWRATE;
  out.age = dv.getUint8(o + 18) * AGE_UNIT;
  o += REC_SIZE;
  if (parts & REC_FULL) { out.model = dv.getUint8(o); out.flags = dv.getUint16(o + 1, true); o += 3; }
  if (parts & REC_ROT) { out.pitch = (dv.getInt8(o) / 127) * (Math.PI / 2); out.roll = (dv.getInt8(o + 1) / 127) * Math.PI; o += 2; }
  if (parts & REC_STEER) { out.steer = dv.getInt8(o) / Q_STEER; o += 1; }
  if (parts & REC_TURRET) { out.turret = u16ToYaw(dv.getUint16(o, true)); out.barrel = dv.getInt8(o + 2) / Q_BARREL; o += 3; }
  out.size = o - o0;
  return out;
}

// S_CELL: u8 type | u8 stream | u16 cell | u16 tick (low 16 bits) | u8 count | u8 goneCount ; gone (u24 id, u16 toCell)
// × goneCount ; records × count (19–28 bytes each: walk them with readRecord(...).size)
export const CELL_HDR = 8;
export const GONE_SIZE = 5;
export const GONE_LEFT = 0xffff; // toCell value: the player left the server
export function writeCellHeader(dv, o, stream, cell, tick, count, goneCount) {
  dv.setUint8(o, S_CELL);
  dv.setUint8(o + 1, stream);
  dv.setUint16(o + 2, cell, true);
  dv.setUint16(o + 4, tick & 0xffff, true);
  dv.setUint8(o + 6, count);
  dv.setUint8(o + 7, goneCount);
  return o + CELL_HDR;
}
/** Full tick from its low 16 bits, given a recent full tick (heartbeats carry the full value). */
export function unwrapTick(t16, ref) {
  let d = (t16 - (ref & 0xffff)) & 0xffff;
  if (d >= 0x8000) d -= 0x10000;
  return ref + d;
}
export function writeGone(dv, o, id, toCell) {
  dv.setUint16(o, id & 0xffff, true);
  dv.setUint8(o + 2, (id >>> 16) & 0xff);
  dv.setUint16(o + 3, toCell, true);
  return o + GONE_SIZE;
}

// ---------------- names (custom nicknames: ASCII, ≤ 16 bytes) ----------------
export const NAME_BYTES = 16;
/** u8 len + ASCII bytes (non-ASCII is dropped: custom names are validated as [A-Za-z0-9_-]). Returns the new offset. */
export function writeName(dv, o, name) {
  const n = Math.min(NAME_BYTES, name ? name.length : 0);
  dv.setUint8(o, n);
  for (let i = 0; i < n; i++) dv.setUint8(o + 1 + i, name.charCodeAt(i) & 0x7f);
  return o + 1 + n;
}
const _name = { name: '', o: 0 };
/** → reused { name, o } (o = offset after the name). Only [A-Za-z0-9_-] survives decoding. */
export function readName(dv, o) {
  const n = Math.min(NAME_BYTES, dv.getUint8(o));
  let str = '';
  for (let i = 0; i < n; i++) {
    const c = dv.getUint8(o + 1 + i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45) str += String.fromCharCode(c);
  }
  _name.name = str; _name.o = o + 1 + n;
  return _name;
}

// ---------------- client → server ----------------
/** HELLO: u8 type | u8 proto | u8 flags | u8 _ | token[32] | u16 build | u16 offlineS (s played offline before this connect) */
export function encodeHello(token, flags, build = 0, offlineS = 0) {
  const b = new ArrayBuffer(HELLO_SIZE), dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint8(0, C_HELLO);
  dv.setUint8(1, PROTO_VERSION);
  dv.setUint8(2, flags);
  if (token) u8.set(token.subarray(0, 32), 4);
  dv.setUint16(36, build, true);
  dv.setUint16(38, qi(offlineS, 0, 65535), true);
  return b;
}
export function decodeHello(dv) {
  if (dv.byteLength !== HELLO_SIZE) return null;
  return { proto: dv.getUint8(1), flags: dv.getUint8(2), token: new Uint8Array(dv.buffer, dv.byteOffset + 4, 32), build: dv.getUint16(36, true), offlineS: dv.getUint16(38, true) };
}

/** STATE (38 bytes). `s` = { seq, t, serverClock, x, y, z, yaw, pitch, roll, vx, vy, vz, yawRate, steer, model, tpc, flags, health }. */
export function writeState(dv, s) {
  dv.setUint8(0, C_STATE);
  dv.setUint8(1, s.tpc & 3);
  dv.setUint16(2, s.seq & 0xffff, true);
  dv.setUint32(4, s.t >>> 0, true);
  dv.setInt32(8, qi(s.x * 100, -2e9, 2e9), true);
  dv.setInt32(12, qi(s.y * 100, -2e9, 2e9), true);
  dv.setInt32(16, qi(s.z * 100, -2e9, 2e9), true);
  dv.setUint16(20, yawToU16(s.yaw), true);
  dv.setInt8(22, qi((s.pitch / (Math.PI / 2)) * 127, -127, 127));
  dv.setInt8(23, qi((s.roll / Math.PI) * 127, -127, 127));
  dv.setInt16(24, qi(s.vx * Q_VEL, -32767, 32767), true);
  dv.setInt16(26, qi(s.vy * Q_VEL, -32767, 32767), true);
  dv.setInt16(28, qi(s.vz * Q_VEL, -32767, 32767), true);
  dv.setInt8(30, qi(s.yawRate * Q_YAWRATE, -127, 127));
  dv.setInt8(31, qi(s.steer * Q_STEER, -127, 127));
  dv.setUint8(32, s.model & 0xff);
  dv.setUint8(33, s.serverClock ? 1 : 0); // bit0: t is server time (ms mod 2^32), else the client's own clock
  dv.setUint16(34, s.flags & F_CLIENT_MASK, true);
  dv.setUint8(36, qi(s.health * 255, 0, 255));
  dv.setUint8(37, 0);
  if (dv.byteLength >= STATE_EXT_SIZE) { // turret vehicles: 41-byte state
    dv.setUint16(38, yawToU16(s.turret), true);
    dv.setInt8(40, qi(s.barrel * Q_BARREL, -127, 127));
  }
}
/** Strict decode into `out`; returns false on a malformed message. */
export function readState(dv, out) {
  if (dv.byteLength !== STATE_SIZE && dv.byteLength !== STATE_EXT_SIZE) return false;
  out.tpc = dv.getUint8(1) & 3;
  out.seq = dv.getUint16(2, true);
  out.t = dv.getUint32(4, true);
  out.x = dv.getInt32(8, true) / 100;
  out.y = dv.getInt32(12, true) / 100;
  out.z = dv.getInt32(16, true) / 100;
  out.yaw = u16ToYaw(dv.getUint16(20, true));
  out.pitch = (dv.getInt8(22) / 127) * (Math.PI / 2);
  out.roll = (dv.getInt8(23) / 127) * Math.PI;
  out.vx = dv.getInt16(24, true) / Q_VEL;
  out.vy = dv.getInt16(26, true) / Q_VEL;
  out.vz = dv.getInt16(28, true) / Q_VEL;
  out.yawRate = dv.getInt8(30) / Q_YAWRATE;
  out.steer = dv.getInt8(31) / Q_STEER;
  out.model = dv.getUint8(32);
  out.serverClock = (dv.getUint8(33) & 1) === 1;
  out.flags = dv.getUint16(34, true) & F_CLIENT_MASK;
  out.health = dv.getUint8(36) / 255;
  if (dv.byteLength === STATE_EXT_SIZE) {
    out.ext = true;
    out.turret = u16ToYaw(dv.getUint16(38, true));
    out.barrel = dv.getInt8(40) / Q_BARREL;
  } else { out.ext = false; out.turret = 0; out.barrel = 0; }
  return true;
}

export function encodePing(id, clientTime) {
  const b = new ArrayBuffer(PING_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_PING);
  dv.setUint16(2, id & 0xffff, true);
  dv.setFloat64(4, clientTime, true);
  return b;
}

/**
 * CLAIM (28 bytes): u8 type | u8 reason | u16 seq | u32 amount | i32 x_cm | i32 z_cm | u32 meta | u16 p1 | u16 p2 | u8 combo*2 | u8 tier | u16 p3
 * Field meaning per reason: see server/src/economy.js (e.g. drift p1 = duration 1/100 s, p2 = avg km/h).
 */
export function encodeClaim(c) {
  const b = new ArrayBuffer(CLAIM_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_CLAIM);
  dv.setUint8(1, c.reason);
  dv.setUint16(2, c.seq & 0xffff, true);
  dv.setUint32(4, qi(c.amount, 0, 0xffffffff), true);
  dv.setInt32(8, qi((c.x ?? 0) * 100, -2e9, 2e9), true);
  dv.setInt32(12, qi((c.z ?? 0) * 100, -2e9, 2e9), true);
  dv.setUint32(16, (c.meta ?? 0) >>> 0, true);
  dv.setUint16(20, qi(c.p1 ?? 0, 0, 65535), true);
  dv.setUint16(22, qi(c.p2 ?? 0, 0, 65535), true);
  dv.setUint8(24, qi((c.combo ?? 1) * 2, 2, 10));
  dv.setUint8(25, qi(c.tier ?? 0, 0, 255));
  dv.setUint16(26, qi(c.p3 ?? 0, 0, 65535), true);
  return b;
}
export function decodeClaim(dv) {
  if (dv.byteLength !== CLAIM_SIZE) return null;
  return {
    reason: dv.getUint8(1), seq: dv.getUint16(2, true), amount: dv.getUint32(4, true), x: dv.getInt32(8, true) / 100, z: dv.getInt32(12, true) / 100,
    meta: dv.getUint32(16, true), p1: dv.getUint16(20, true), p2: dv.getUint16(22, true), combo: Math.min(5, Math.max(1, dv.getUint8(24) / 2)),
    tier: dv.getUint8(25), p3: dv.getUint16(26, true),
  };
}

/** ECON request (8 bytes): u8 type | u8 op | u16 reqId | u8 model | u8 param | u16 _ */
export function encodeEcon(op, reqId, model, param = 0) {
  const b = new ArrayBuffer(ECON_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_ECON);
  dv.setUint8(1, op);
  dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint8(4, model & 0xff);
  dv.setUint8(5, qi(param, 0, 255));
  return b;
}
export function decodeEcon(dv) {
  if (dv.byteLength !== ECON_SIZE) return null;
  return { op: dv.getUint8(1), reqId: dv.getUint16(2, true), model: dv.getUint8(4), param: dv.getUint8(5) };
}
/** ECON reply (24 bytes): u8 type | u8 op | u16 reqId | u8 result | u8 model | u16 _ | f64 money | i32 delta | u32 _ */
export function encodeEconReply(op, reqId, result, model, money, delta) {
  const b = new ArrayBuffer(24), dv = new DataView(b);
  dv.setUint8(0, S_ECON);
  dv.setUint8(1, op);
  dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint8(4, result);
  dv.setUint8(5, model & 0xff);
  dv.setFloat64(8, money, true);
  dv.setInt32(16, qi(delta, -2e9, 2e9), true);
  return b;
}
export function decodeEconReply(dv) {
  return { op: dv.getUint8(1), reqId: dv.getUint16(2, true), result: dv.getUint8(4), model: dv.getUint8(5), money: dv.getFloat64(8, true), delta: dv.getInt32(16, true) };
}
/** OWNED: u8 type | u8 _ | u16 count | f64 worth | u8 bitset[32] (model indices 0..255) */
export function encodeOwned(indices, worth) {
  const b = new ArrayBuffer(44), dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint8(0, S_OWNED);
  let n = 0;
  for (const i of indices) { if (i > 0 && i < 256) { u8[12 + (i >> 3)] |= 1 << (i & 7); n++; } }
  dv.setUint16(2, n, true);
  dv.setFloat64(4, worth, true);
  return b;
}
export function decodeOwned(dv) {
  const out = [];
  for (let i = 1; i < 256; i++) if (dv.getUint8(12 + (i >> 3)) & (1 << (i & 7))) out.push(i);
  return { owned: out, worth: dv.getFloat64(4, true) };
}
/** PROGRESS: u8 type | u8 _ | u16 len | UTF-8 JSON built by the server from its own data (never client strings). */
export function encodeProgress(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const b = new ArrayBuffer(4 + json.length), dv = new DataView(b);
  dv.setUint8(0, S_PROGRESS);
  dv.setUint16(2, json.length, true);
  new Uint8Array(b, 4).set(json);
  return b;
}
export function decodeProgress(dv) {
  const len = dv.getUint16(2, true);
  try { return JSON.parse(new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + 4, Math.min(len, dv.byteLength - 4)))); } catch { return null; }
}

export function encodeSpawn(reqId, model, rgb, x, z) {
  const b = new ArrayBuffer(SPAWN_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_SPAWN);
  dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint8(4, model & 0xff);
  dv.setUint8(5, (rgb >>> 16) & 0xff);
  dv.setUint8(6, (rgb >>> 8) & 0xff);
  dv.setUint8(7, rgb & 0xff);
  dv.setInt32(8, qi(x * 100, -2e9, 2e9), true);
  dv.setInt32(12, qi(z * 100, -2e9, 2e9), true);
  return b;
}
export function decodeSpawn(dv) {
  if (dv.byteLength !== SPAWN_SIZE) return null;
  return { reqId: dv.getUint16(2, true), model: dv.getUint8(4), rgb: (dv.getUint8(5) << 16) | (dv.getUint8(6) << 8) | dv.getUint8(7), x: dv.getInt32(8, true) / 100, z: dv.getInt32(12, true) / 100 };
}

export function encodeInfoReq(ids, n = ids.length) {
  n = Math.min(n, INFO_REQ_MAX);
  const b = new ArrayBuffer(2 + n * 3), dv = new DataView(b);
  dv.setUint8(0, C_INFO_REQ);
  dv.setUint8(1, n);
  for (let i = 0; i < n; i++) {
    dv.setUint16(2 + i * 3, ids[i] & 0xffff, true);
    dv.setUint8(4 + i * 3, (ids[i] >>> 16) & 0xff);
  }
  return b;
}
/** Returns the number of ids written into `out` (Uint32Array) or -1 when malformed. */
export function decodeInfoReq(dv, out) {
  if (dv.byteLength < 2) return -1;
  const n = dv.getUint8(1);
  if (n < 1 || n > INFO_REQ_MAX || dv.byteLength !== 2 + n * 3) return -1;
  for (let i = 0; i < n; i++) out[i] = dv.getUint16(2 + i * 3, true) | (dv.getUint8(4 + i * 3) << 16);
  return n;
}

export function encodeReroll(reqId) {
  const b = new ArrayBuffer(REROLL_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_REROLL);
  dv.setUint16(2, reqId & 0xffff, true);
  return b;
}

export function encodeEvent(kind, seq, param = 0) {
  const b = new ArrayBuffer(EVENT_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_EVENT);
  dv.setUint8(1, kind);
  dv.setUint16(2, seq & 0xffff, true);
  dv.setUint32(4, param >>> 0, true);
  return b;
}

// ---------------- server → client ----------------
/**
 * WELCOME. w = { tickHz, netId, nickCode, color, nearR, farR, spawnCooldownS, money, serverTime, tick, restore?: {x,y,z,yaw,model,health,paint},
 *   claimsFrozen, token?: Uint8Array(32), models: [{id, vclass}] }
 */
export function encodeWelcome(w) {
  const names = w.models.map((m) => m.id);
  let size = 60 + (w.token ? 32 : 0) + 1 + NAME_BYTES;
  for (const n of names) size += 2 + Math.min(n.length, 40);
  const b = new ArrayBuffer(size), dv = new DataView(b), u8 = new Uint8Array(b);
  dv.setUint8(0, S_WELCOME);
  dv.setUint8(1, PROTO_VERSION);
  dv.setUint8(2, w.tickHz);
  dv.setUint8(3, (w.token ? 1 : 0) | (w.restore ? 2 : 0) | (w.claimsFrozen ? 4 : 0));
  dv.setUint32(4, w.netId >>> 0, true);
  dv.setUint32(8, w.nickCode >>> 0, true);
  dv.setUint8(12, w.color);
  dv.setUint8(13, w.nearR);
  dv.setUint8(14, w.farR);
  dv.setUint8(15, w.spawnCooldownS);
  dv.setFloat64(16, w.money, true);
  dv.setFloat64(24, w.serverTime, true);
  dv.setUint32(32, w.tick >>> 0, true);
  const r = w.restore || { x: 0, y: 0, z: 0, yaw: 0, model: 0, health: 1, paint: 0 };
  dv.setInt32(36, qi(r.x * 100, -2e9, 2e9), true);
  dv.setInt32(40, qi(r.y * 100, -2e9, 2e9), true);
  dv.setInt32(44, qi(r.z * 100, -2e9, 2e9), true);
  dv.setUint16(48, yawToU16(r.yaw), true);
  dv.setUint8(50, r.model & 0xff);
  dv.setUint8(51, qi((r.health ?? 1) * 255, 0, 255));
  dv.setUint32(52, (r.paint ?? 0) >>> 0, true);
  dv.setUint16(56, CELL, true);
  dv.setUint16(58, names.length, true);
  let o = 60;
  if (w.token) { u8.set(w.token, o); o += 32; }
  for (let i = 0; i < names.length; i++) {
    const n = names[i].slice(0, 40);
    dv.setUint8(o++, n.length);
    for (let k = 0; k < n.length; k++) u8[o++] = n.charCodeAt(k) & 0x7f;
    dv.setUint8(o++, w.models[i].vclass ?? 1);
  }
  writeName(dv, o, w.name || '');
  return b;
}
export function decodeWelcome(dv) {
  const flags = dv.getUint8(3);
  const w = {
    proto: dv.getUint8(1), tickHz: dv.getUint8(2), netId: dv.getUint32(4, true), nickCode: dv.getUint32(8, true), color: dv.getUint8(12),
    nearR: dv.getUint8(13), farR: dv.getUint8(14), spawnCooldownS: dv.getUint8(15), money: dv.getFloat64(16, true),
    serverTime: dv.getFloat64(24, true), tick: dv.getUint32(32, true), claimsFrozen: !!(flags & 4),
    restore: flags & 2 ? {
      x: dv.getInt32(36, true) / 100, y: dv.getInt32(40, true) / 100, z: dv.getInt32(44, true) / 100,
      yaw: u16ToYaw(dv.getUint16(48, true)), model: dv.getUint8(50), health: dv.getUint8(51) / 255, paint: dv.getUint32(52, true),
    } : null,
    cellSize: dv.getUint16(56, true), token: null, models: [],
  };
  const n = dv.getUint16(58, true);
  let o = 60;
  if (flags & 1) { w.token = new Uint8Array(dv.buffer.slice(dv.byteOffset + o, dv.byteOffset + o + 32)); o += 32; }
  for (let i = 0; i < n; i++) {
    const len = dv.getUint8(o++);
    let s = '';
    for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint8(o++));
    w.models.push({ id: s, vclass: dv.getUint8(o++) });
  }
  w.name = o < dv.byteLength ? readName(dv, o).name : '';
  return w;
}

/** GLOBAL. g = { online, total, serverTime, tick, hour, timeScale, weatherIndex, prevIndex, transition, transitionS, top: [{netId, nickCode, color, money, name}] } */
export const GLOBAL_HDR = 40, TOP_SIZE = 40; // top entry: u32 netId | u32 nickCode | f64 worth | u8 color | name (17) | pad
export function encodeGlobal(g, dv = null) {
  const n = Math.min(g.top.length, 10);
  const size = GLOBAL_HDR + n * TOP_SIZE;
  if (!dv) dv = new DataView(new ArrayBuffer(size));
  dv.setUint8(0, S_GLOBAL);
  dv.setUint8(1, g.weatherIndex);
  dv.setUint8(2, g.prevIndex);
  dv.setUint8(3, n);
  dv.setUint32(4, g.online >>> 0, true);
  dv.setUint32(8, g.total >>> 0, true);
  dv.setFloat64(12, g.serverTime, true);
  dv.setFloat32(20, g.hour, true);
  dv.setFloat32(24, g.timeScale, true);
  dv.setFloat32(28, g.transition, true);
  dv.setFloat32(32, g.transitionS, true);
  dv.setUint32(36, g.tick >>> 0, true);
  for (let i = 0; i < n; i++) {
    const t = g.top[i], o = GLOBAL_HDR + i * TOP_SIZE;
    dv.setUint32(o, t.netId >>> 0, true);
    dv.setUint32(o + 4, t.nickCode >>> 0, true);
    dv.setFloat64(o + 8, t.money, true);
    dv.setUint8(o + 16, t.color);
    writeName(dv, o + 17, t.name || '');
  }
  return size;
}
export function decodeGlobal(dv, out = {}) {
  out.weatherIndex = dv.getUint8(1);
  out.prevIndex = dv.getUint8(2);
  const n = dv.getUint8(3);
  out.online = dv.getUint32(4, true);
  out.total = dv.getUint32(8, true);
  out.serverTime = dv.getFloat64(12, true);
  out.hour = dv.getFloat32(20, true);
  out.timeScale = dv.getFloat32(24, true);
  out.transition = dv.getFloat32(28, true);
  out.transitionS = dv.getFloat32(32, true);
  out.tick = dv.getUint32(36, true);
  out.top = [];
  for (let i = 0; i < n && GLOBAL_HDR + (i + 1) * TOP_SIZE <= dv.byteLength; i++) {
    const o = GLOBAL_HDR + i * TOP_SIZE;
    out.top.push({ netId: dv.getUint32(o, true), nickCode: dv.getUint32(o + 4, true), money: dv.getFloat64(o + 8, true), color: dv.getUint8(o + 16), name: readName(dv, o + 17).name });
  }
  return out;
}

// RADAR: u8 type | u8 _ | u16 radarCell | u32 tick | u16 count | u16 total ; entries (10 bytes):
// u24 netId | u16 x | u16 z (window-relative, 4.7 cm) | u8 heading (1/256 turn) | u8 color (5 bits) << 3 | vclass (3 bits)
// | u8 speed along the heading (bit 7 reverse, 2.5 m/s units): clients track ids and dead-reckon between updates
export const RADAR_HDR = 12, RADAR_ENTRY = 10, RADAR_VQ = 2.5;
export function writeRadarHeader(dv, o, rc, tick, count, total) {
  dv.setUint8(o, S_RADAR);
  dv.setUint8(o + 1, 0);
  dv.setUint16(o + 2, rc, true);
  dv.setUint32(o + 4, tick >>> 0, true);
  dv.setUint16(o + 8, count, true);
  dv.setUint16(o + 10, Math.min(total, 65535), true);
  return o + RADAR_HDR;
}
const RQ = 65536 / RADAR_WINDOW;
export function writeRadarEntry(dv, o, wx0, wz0, x, z, color, yaw, vclass, id = 0, vx = 0, vz = 0) {
  dv.setUint16(o, id & 0xffff, true);
  dv.setUint8(o + 2, (id >>> 16) & 0xff);
  dv.setUint16(o + 3, qi((x - wx0) * RQ, 0, 65535), true);
  dv.setUint16(o + 5, qi((z - wz0) * RQ, 0, 65535), true);
  dv.setUint8(o + 7, Math.round((wrapAngle(yaw) / TAU) * 256) & 255);
  dv.setUint8(o + 8, ((color & 31) << 3) | (vclass & 7));
  // speed along the heading: bit 7 = reversing, bits 0-6 = |speed| in 2.5 m/s units (up to 317 m/s)
  const fwd = -Math.sin(yaw) * vx - Math.cos(yaw) * vz;
  dv.setUint8(o + 9, (fwd < 0 ? 0x80 : 0) | qi(Math.abs(fwd) / RADAR_VQ, 0, 127));
  return o + RADAR_ENTRY;
}
export function readRadarEntry(dv, o, wx0, wz0, out) {
  out.id = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16);
  out.x = wx0 + dv.getUint16(o + 3, true) / RQ;
  out.z = wz0 + dv.getUint16(o + 5, true) / RQ;
  out.yaw = wrapAngle((dv.getUint8(o + 7) / 256) * TAU);
  const ck = dv.getUint8(o + 8);
  out.color = ck >>> 3;
  out.vclass = ck & 7;
  const sb = dv.getUint8(o + 9), sp = (sb & 0x7f) * RADAR_VQ * (sb & 0x80 ? -1 : 1);
  out.vx = -Math.sin(out.yaw) * sp;
  out.vz = -Math.cos(out.yaw) * sp;
  return out;
}

// DENSITY: u8 type | u8 _ | u16 nx | u16 nz | u16 counts[nx*nz]
export function encodeDensity(counts, nx, nz) {
  const b = new ArrayBuffer(6 + nx * nz * 2), dv = new DataView(b);
  dv.setUint8(0, S_DENSITY);
  dv.setUint16(2, nx, true);
  dv.setUint16(4, nz, true);
  for (let i = 0; i < nx * nz; i++) dv.setUint16(6 + i * 2, Math.min(65535, counts[i]), true);
  return b;
}

// INFO: u8 type | u8 count ; records (variable):
// u32 netId | u32 nickCode | u8 color | u8 infoVer | u8 vclass | u8 neon (255 = none) | u32 paint (rgb | finish << 24)
// | u8 tint | u8 horn (255 = default) | u8 model | u8 flags (1 armour) | u32 worth ($) | name | u8 n
// | n × u16 outfit code (D's appearance code: item.code * 16 + colour index, 15 = default; n ≤ 11)
// | u8 extLen | extLen bytes of tagged blocks (u8 tag | u8 len | payload): readers skip what they don't know
//   tag 1 wreck:  u32 seed (bit 31: short cook-off) | u8 age (100 ms units, 255 = 25.5 s or more)
//   tag 2 damage: u8 version | payload (≤ VIS_MAX, src/net/NetDamage.js)
export const INFO_FIXED = 24;
export const INFO_TAG = Object.freeze({ WRECK: 1, DAMAGE: 2, AWAY: 3 });
export const INFO_MAX = INFO_FIXED + 1 + 16 + 1 + 2 * OUTFIT_MAX + 1 + (2 + 5) + (2 + 1 + VIS_MAX) + 2;
export function writeInfoHeader(dv, n) { dv.setUint8(0, S_INFO); dv.setUint8(1, n); return 2; }
/**
 * i = { netId, nickCode, color, infoVer, vclass, neon, paint, finish, tint, horn, model, armor, worth, name,
 * outfit: u16[] (outfit codes), wreck?: { seed, short, ageMs }, damage?: { ver, data: Uint8Array } }
 */
export function writeInfo(dv, o, i) {
  dv.setUint32(o, i.netId >>> 0, true);
  dv.setUint32(o + 4, i.nickCode >>> 0, true);
  dv.setUint8(o + 8, i.color & 0xff);
  dv.setUint8(o + 9, i.infoVer & F_INFO_MASK);
  dv.setUint8(o + 10, i.vclass & 0xff);
  dv.setUint8(o + 11, i.neon == null || i.neon < 0 ? 255 : i.neon & 0xff);
  dv.setUint32(o + 12, ((i.paint ?? 0) & 0xffffff) | (((i.finish ?? 0) & 0xff) << 24), true);
  dv.setUint8(o + 16, i.tint ? 1 : 0);
  dv.setUint8(o + 17, i.horn == null || i.horn < 0 ? 255 : i.horn & 0xff);
  dv.setUint8(o + 18, (i.model ?? 0) & 0xff);
  dv.setUint8(o + 19, i.armor ? 1 : 0);
  dv.setUint32(o + 20, qi(i.worth ?? 0, 0, 0xffffffff), true);
  o = writeName(dv, o + INFO_FIXED, i.name || '');
  const fit = i.outfit || [];
  const n = Math.min(OUTFIT_MAX, fit.length);
  dv.setUint8(o++, n);
  for (let k = 0; k < n; k++, o += 2) dv.setUint16(o, fit[k] & 0xffff, true);
  const ext = o++;
  if (i.wreck) {
    dv.setUint8(o, INFO_TAG.WRECK); dv.setUint8(o + 1, 5);
    dv.setUint32(o + 2, ((i.wreck.seed & 0x7fffffff) | (i.wreck.short ? 0x80000000 : 0)) >>> 0, true);
    dv.setUint8(o + 6, qi((i.wreck.ageMs ?? 0) / 100, 0, 255));
    o += 7;
  }
  const d = i.damage?.data;
  if (d) {
    const len = Math.min(VIS_MAX, d.length);
    dv.setUint8(o, INFO_TAG.DAMAGE); dv.setUint8(o + 1, 1 + len); dv.setUint8(o + 2, i.damage.ver & 0xff);
    for (let k = 0; k < len; k++) dv.setUint8(o + 3 + k, d[k]);
    o += 3 + len;
  }
  if (i.away) { dv.setUint8(o, INFO_TAG.AWAY); dv.setUint8(o + 1, 0); o += 2; } // tab in the background: frozen, AFK badge
  dv.setUint8(ext, o - ext - 1);
  return o;
}
/** Decode one record into `out`; returns the offset after it. */
export function readInfo(dv, o, out) {
  out.netId = dv.getUint32(o, true);
  out.nickCode = dv.getUint32(o + 4, true);
  out.color = dv.getUint8(o + 8);
  out.infoVer = dv.getUint8(o + 9);
  out.vclass = dv.getUint8(o + 10);
  const neon = dv.getUint8(o + 11);
  out.neon = neon === 255 ? null : neon;
  const p = dv.getUint32(o + 12, true);
  out.paint = p & 0xffffff;
  out.finish = p >>> 24;
  out.tint = dv.getUint8(o + 16) === 1;
  const horn = dv.getUint8(o + 17);
  out.horn = horn === 255 ? null : horn;
  out.model = dv.getUint8(o + 18);
  out.armor = (dv.getUint8(o + 19) & 1) === 1;
  out.worth = dv.getUint32(o + 20, true);
  const nm = readName(dv, o + INFO_FIXED);
  out.name = nm.name;
  o = nm.o;
  const n = Math.min(OUTFIT_MAX, dv.getUint8(o++));
  out.outfit = [];
  for (let k = 0; k < n; k++, o += 2) out.outfit.push(dv.getUint16(o, true));
  out.wreck = null;
  out.damage = null;
  out.away = false;
  if (o >= dv.byteLength) return o; // (no trailer)
  const end = Math.min(dv.byteLength, o + 1 + dv.getUint8(o));
  o++;
  while (o + 2 <= end) {
    const tag = dv.getUint8(o), len = dv.getUint8(o + 1), p = o + 2;
    if (p + len > end) break;
    if (tag === INFO_TAG.WRECK && len >= 5) {
      const s = dv.getUint32(p, true);
      out.wreck = { seed: s & 0x7fffffff, short: s >>> 31 === 1, ageMs: dv.getUint8(p + 4) * 100 };
    } else if (tag === INFO_TAG.AWAY) {
      out.away = true;
    } else if (tag === INFO_TAG.DAMAGE && len >= 1) {
      out.damage = { ver: dv.getUint8(p), data: new Uint8Array(dv.buffer.slice(dv.byteOffset + p + 1, dv.byteOffset + p + len)) };
    }
    o = p + len;
  }
  return end;
}

/** WALLET (28 bytes): u8 type | u8 result | u16 seq | f64 balance | i32 delta | u8 reason | u8 combo*2 | u16 _ | f64 worth */
export function encodeWallet(result, seq, balance, delta, reason, combo = 1, worth = balance) {
  const b = new ArrayBuffer(28), dv = new DataView(b);
  dv.setUint8(0, S_WALLET);
  dv.setUint8(1, result);
  dv.setUint16(2, seq & 0xffff, true);
  dv.setFloat64(4, balance, true);
  dv.setInt32(12, qi(delta, -2e9, 2e9), true);
  dv.setUint8(16, reason);
  dv.setUint8(17, qi(combo * 2, 0, 255));
  dv.setFloat64(20, worth, true);
  return b;
}
export function decodeWallet(dv) {
  return {
    result: dv.getUint8(1), seq: dv.getUint16(2, true), balance: dv.getFloat64(4, true), delta: dv.getInt32(12, true), reason: dv.getUint8(16),
    combo: dv.getUint8(17) / 2, worth: dv.byteLength >= 28 ? dv.getFloat64(20, true) : dv.getFloat64(4, true),
  };
}

export function encodeRank(rank, total) {
  const b = new ArrayBuffer(12), dv = new DataView(b);
  dv.setUint8(0, S_RANK);
  dv.setUint32(4, rank >>> 0, true);
  dv.setUint32(8, total >>> 0, true);
  return b;
}

export function encodePong(id, clientTime, serverTime) {
  const b = new ArrayBuffer(20), dv = new DataView(b);
  dv.setUint8(0, S_PONG);
  dv.setUint16(2, id & 0xffff, true);
  dv.setFloat64(4, clientTime, true);
  dv.setFloat64(12, serverTime, true);
  return b;
}

export function encodeSpawnAck(code, reqId, model, waitS) {
  const b = new ArrayBuffer(8), dv = new DataView(b);
  dv.setUint8(0, S_SPAWN_ACK);
  dv.setUint8(1, code);
  dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint8(4, model & 0xff);
  dv.setUint16(6, qi(waitS * 10, 0, 65535), true);
  return b;
}

export function encodeCorrection(reason, tpc, x, y, z, yaw) {
  const b = new ArrayBuffer(20), dv = new DataView(b);
  dv.setUint8(0, S_CORRECTION);
  dv.setUint8(1, reason);
  dv.setUint8(2, tpc & 3);
  dv.setInt32(4, qi(x * 100, -2e9, 2e9), true);
  dv.setInt32(8, qi(y * 100, -2e9, 2e9), true);
  dv.setInt32(12, qi(z * 100, -2e9, 2e9), true);
  dv.setUint16(16, yawToU16(yaw), true);
  return b;
}

// S_NICK (40 bytes): u8 type | u8 result | u16 reqId | u32 nickCode | u16 cooldownS | u16 rerolls | f64 money | name (17)
// | u8 op (NICK_OP of the request) | pad
export const NICK_MSG_SIZE = 40;
export function encodeNick(result, reqId, nickCode, cooldownS, name = '', money = -1, rerolls = 0, op = 0) {
  const b = new ArrayBuffer(NICK_MSG_SIZE), dv = new DataView(b);
  dv.setUint8(0, S_NICK);
  dv.setUint8(1, result);
  dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint32(4, nickCode >>> 0, true);
  dv.setUint16(8, qi(cooldownS, 0, 65535), true);
  dv.setUint16(10, qi(rerolls, 0, 65535), true);
  dv.setUint8(37, op & 0xff);
  dv.setFloat64(12, money, true);
  writeName(dv, 20, name);
  return b;
}
export function decodeNick(dv) {
  return {
    result: dv.getUint8(1), reqId: dv.getUint16(2, true), nickCode: dv.getUint32(4, true), cooldownS: dv.getUint16(8, true),
    money: dv.byteLength >= NICK_MSG_SIZE ? dv.getFloat64(12, true) : -1, name: dv.byteLength >= NICK_MSG_SIZE ? readName(dv, 20).name : '',
    rerolls: dv.getUint16(10, true), op: dv.byteLength >= NICK_MSG_SIZE ? dv.getUint8(37) : 0,
  };
}
/** C_NICK: u8 type | u8 op | u16 reqId | name (17): op REROLL (paid generator) or CUSTOM. */
export function encodeNickReq(op, reqId, name = '') {
  const b = new ArrayBuffer(4 + 1 + Math.min(NAME_BYTES, name.length)), dv = new DataView(b);
  dv.setUint8(0, C_NICK);
  dv.setUint8(1, op);
  dv.setUint16(2, reqId & 0xffff, true);
  writeName(dv, 4, name);
  return b;
}
/** Strict decode: the raw bytes must be exactly what writeName produces for a [A-Za-z0-9_-] name. */
export function decodeNickReq(dv) {
  if (dv.byteLength < 5 || dv.byteLength > NICK_REQ_MAX) return null;
  const n = dv.getUint8(4);
  if (n > NAME_BYTES || dv.byteLength !== 5 + n) return null;
  const nm = readName(dv, 4);
  if (nm.name.length !== n) return null; // something outside the charset was dropped
  return { op: dv.getUint8(1), reqId: dv.getUint16(2, true), name: nm.name };
}

// S_EVENT (32 bytes): u8 type | u8 kind | u16 _ | u32 netId | u32 nickCode | u8 color | name (17) | pad
export const SEVENT_SIZE = 32;
export function writeServerEvent(dv, o, kind, netId, nickCode, color, name = '') {
  dv.setUint8(o, S_EVENT);
  dv.setUint8(o + 1, kind);
  dv.setUint16(o + 2, 0, true);
  dv.setUint32(o + 4, netId >>> 0, true);
  dv.setUint32(o + 8, nickCode >>> 0, true);
  dv.setUint8(o + 12, color);
  const e = writeName(dv, o + 13, name);
  for (let k = e; k < o + SEVENT_SIZE; k++) dv.setUint8(k, 0);
  return o + SEVENT_SIZE;
}
export function readServerEvent(dv) {
  return { kind: dv.getUint8(1), netId: dv.getUint32(4, true), nickCode: dv.getUint32(8, true), color: dv.getUint8(12), name: dv.byteLength >= SEVENT_SIZE ? readName(dv, 13).name : '' };
}

export function encodeKick(code) {
  const b = new ArrayBuffer(2), dv = new DataView(b);
  dv.setUint8(0, S_KICK);
  dv.setUint8(1, code);
  return b;
}

export function encodeNotice(code, param = 0) {
  const b = new ArrayBuffer(12), dv = new DataView(b);
  dv.setUint8(0, S_NOTICE);
  dv.setUint8(1, code);
  dv.setFloat64(4, param, true);
  return b;
}

/** PULSE (16 bytes, every 5 s on the global topic): u8 type | u8 _ | u16 boardVersion | u32 online | u32 registered | u32 tick */
export const PULSE_SIZE = 16;
export function writePulse(dv, o, boardVer, online, total, tick) {
  dv.setUint8(o, S_PULSE); dv.setUint8(o + 1, 0);
  dv.setUint16(o + 2, boardVer & 0xffff, true);
  dv.setUint32(o + 4, online >>> 0, true);
  dv.setUint32(o + 8, total >>> 0, true);
  dv.setUint32(o + 12, tick >>> 0, true);
  return o + PULSE_SIZE;
}
export function readPulse(dv) {
  return { boardVer: dv.getUint16(2, true), online: dv.getUint32(4, true), total: dv.getUint32(8, true), tick: dv.getUint32(12, true) };
}

export const TICK_SIZE = 8;
export function writeTick(dv, o, tick) {
  dv.setUint8(o, S_TICK);
  dv.setUint8(o + 1, 0); dv.setUint16(o + 2, 0, true);
  dv.setUint32(o + 4, tick >>> 0, true);
  return o + TICK_SIZE;
}

// ---------------- combat ----------------
/**
 * C_FIRE (28 bytes): u8 type | u8 weapon | u16 seq | u32 t (server clock ms, low 32 bits) | i32 x,y,z (muzzle, cm)
 * | u16 yaw (world) | i16 pitch (1e-4 rad) | u16 clear (m of free path the shooter's client saw before static geometry,
 * 0 = unknown) | u16 _
 */
export function encodeFire(f) {
  const b = new ArrayBuffer(FIRE_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_FIRE);
  dv.setUint8(1, f.weapon & 0xff);
  dv.setUint16(2, f.seq & 0xffff, true);
  dv.setUint32(4, f.t >>> 0, true);
  dv.setInt32(8, qi(f.x * 100, -2e9, 2e9), true);
  dv.setInt32(12, qi(f.y * 100, -2e9, 2e9), true);
  dv.setInt32(16, qi(f.z * 100, -2e9, 2e9), true);
  dv.setUint16(20, yawToU16(f.yaw), true);
  dv.setInt16(22, qi(f.pitch * 1e4, -15707, 15707), true);
  dv.setUint16(24, qi(f.clear ?? 0, 0, 65535), true);
  return b;
}
export function decodeFire(dv) {
  if (dv.byteLength !== FIRE_SIZE) return null;
  return {
    weapon: dv.getUint8(1), seq: dv.getUint16(2, true), t: dv.getUint32(4, true),
    x: dv.getInt32(8, true) / 100, y: dv.getInt32(12, true) / 100, z: dv.getInt32(16, true) / 100,
    yaw: u16ToYaw(dv.getUint16(20, true)), pitch: dv.getInt16(22, true) / 1e4, clear: dv.getUint16(24, true),
  };
}
/**
 * S_FX SHOT/BOOM (32 bytes): u8 type | u8 kind (low 4 bits: FX.SHOT / FX.BOOM) | weapon (high 4 bits) | u16 seq
 * | u32 netId (shooter) | f64 t (server ms: muzzle time for SHOT, explosion time for BOOM) | i32 x,y,z (cm: muzzle /
 * explosion point) | u16 yaw | i16 pitch (1e-4 rad). FX.HIT (to the shooter only) has its own 16-byte layout (writeHit).
 */
export const FX_SIZE = 32;
export function writeFx(dv, o, kind, seq, netId, t, x, y, z, yaw, pitch, weapon) {
  dv.setUint8(o, S_FX);
  dv.setUint8(o + 1, (kind & 0x0f) | ((weapon & 0x0f) << 4));
  dv.setUint16(o + 2, seq & 0xffff, true);
  dv.setUint32(o + 4, netId >>> 0, true);
  dv.setFloat64(o + 8, t, true);
  dv.setInt32(o + 16, qi(x * 100, -2e9, 2e9), true);
  dv.setInt32(o + 20, qi(y * 100, -2e9, 2e9), true);
  dv.setInt32(o + 24, qi(z * 100, -2e9, 2e9), true);
  dv.setUint16(o + 28, yawToU16(yaw), true);
  dv.setInt16(o + 30, qi(pitch * 1e4, -15707, 15707), true);
  return o + FX_SIZE;
}
export function readFx(dv, o = 0, out = {}) {
  const k = dv.getUint8(o + 1);
  out.kind = k & 0x0f; out.weapon = k >> 4;
  out.seq = dv.getUint16(o + 2, true);
  out.netId = dv.getUint32(o + 4, true);
  out.t = dv.getFloat64(o + 8, true);
  out.x = dv.getInt32(o + 16, true) / 100; out.y = dv.getInt32(o + 20, true) / 100; out.z = dv.getInt32(o + 24, true) / 100;
  out.yaw = u16ToYaw(dv.getUint16(o + 28, true));
  out.pitch = dv.getInt16(o + 30, true) / 1e4;
  return out;
}
/**
 * S_DAMAGE (28 bytes): u8 type | u8 kind (DMG.*) | u16 seq | u32 attacker netId | f32 amount (0..1 of integrity)
 * | i32 x,y,z (cm, impact point) | u16 dirYaw (impulse direction) | u8 flags (1 = destroyed) | u8 _ | f32 _
 */
export const DAMAGE_SIZE = 28;
export function writeDamage(dv, o, kind, seq, attacker, amount, x, y, z, dirYaw, destroyed) {
  dv.setUint8(o, S_DAMAGE);
  dv.setUint8(o + 1, kind);
  dv.setUint16(o + 2, seq & 0xffff, true);
  dv.setUint32(o + 4, attacker >>> 0, true);
  dv.setFloat32(o + 8, amount, true);
  dv.setInt32(o + 12, qi(x * 100, -2e9, 2e9), true);
  dv.setInt32(o + 16, qi(y * 100, -2e9, 2e9), true);
  dv.setInt32(o + 20, qi(z * 100, -2e9, 2e9), true);
  dv.setUint16(o + 24, yawToU16(dirYaw), true);
  dv.setUint8(o + 26, destroyed ? 1 : 0);
  dv.setUint8(o + 27, 0);
  return o + DAMAGE_SIZE;
}
export function readDamage(dv, o = 0) {
  return {
    kind: dv.getUint8(o + 1), seq: dv.getUint16(o + 2, true), attacker: dv.getUint32(o + 4, true), amount: dv.getFloat32(o + 8, true),
    x: dv.getInt32(o + 12, true) / 100, y: dv.getInt32(o + 16, true) / 100, z: dv.getInt32(o + 20, true) / 100,
    dirYaw: u16ToYaw(dv.getUint16(o + 24, true)), destroyed: (dv.getUint8(o + 26) & 1) === 1,
  };
}
/** HIT confirmation to the shooter (S_FX kind HIT, 16 bytes): u8 type | u8 kind | u16 seq | u32 victim netId | f32 damage | u8 destroyed | pad */
export const HIT_SIZE = 16;
export function writeHit(dv, o, seq, victim, damage, destroyed) {
  dv.setUint8(o, S_FX);
  dv.setUint8(o + 1, 3); // FX.HIT
  dv.setUint16(o + 2, seq & 0xffff, true);
  dv.setUint32(o + 4, victim >>> 0, true);
  dv.setFloat32(o + 8, damage, true);
  dv.setUint8(o + 12, destroyed ? 1 : 0);
  dv.setUint8(o + 13, 0); dv.setUint16(o + 14, 0, true);
  return o + HIT_SIZE;
}
export function readHit(dv, o = 0) {
  return { kind: 3, seq: dv.getUint16(o + 2, true), victim: dv.getUint32(o + 4, true), damage: dv.getFloat32(o + 8, true), destroyed: dv.getUint8(o + 12) === 1 };
}

// ---------------- services, wardrobe, outfit ----------------
/**
 * C_SERVICE (12 bytes): u8 type | u8 op (SERVICE.* / WARDROBE_OP.*) | u16 reqId | u8 model (the vehicle it is for)
 * | u8 opt (neon colour index, horn variant index, paint finish index, 255 = none) | u16 item (wardrobe index)
 * | u32 rgb (respray colour) | (damage 0..100 for repair rides in the top byte of rgb)
 */
export function encodeService(op, reqId, model = 0, opt = 255, rgb = 0, item = 0) {
  const b = new ArrayBuffer(SERVICE_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_SERVICE);
  dv.setUint8(1, op & 0xff);
  dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint8(4, model & 0xff);
  dv.setUint8(5, opt & 0xff);
  dv.setUint16(6, item & 0xffff, true);
  dv.setUint32(8, rgb >>> 0, true);
  return b;
}
export function decodeService(dv) {
  if (dv.byteLength !== SERVICE_SIZE) return null;
  return { op: dv.getUint8(1), reqId: dv.getUint16(2, true), model: dv.getUint8(4), opt: dv.getUint8(5), item: dv.getUint16(6, true), rgb: dv.getUint32(8, true) };
}
/** C_OUTFIT: u8 type | u8 n | u16 code[n] (D's appearance codes, src/net/shared/outfit-codes.js; n ≤ OUTFIT_MAX) */
export function encodeOutfit(items) {
  const n = Math.min(OUTFIT_MAX, items.length);
  const b = new ArrayBuffer(2 + n * 2), dv = new DataView(b);
  dv.setUint8(0, C_OUTFIT);
  dv.setUint8(1, n);
  for (let i = 0; i < n; i++) dv.setUint16(2 + i * 2, items[i] & 0xffff, true);
  return b;
}
export function decodeOutfit(dv) {
  if (dv.byteLength < 2) return null;
  const n = dv.getUint8(1);
  if (n > OUTFIT_MAX || dv.byteLength !== 2 + n * 2) return null;
  const out = [];
  for (let i = 0; i < n; i++) out.push(dv.getUint16(2 + i * 2, true));
  return out;
}
/** S_GARAGE: u8 type | u8 _ | u16 len | UTF-8 JSON { inventory, custom, wardrobe?, clothes, outfit } built by the server. */
export function encodeGarage(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const b = new ArrayBuffer(4 + json.length), dv = new DataView(b);
  dv.setUint8(0, S_GARAGE);
  dv.setUint16(2, json.length, true);
  new Uint8Array(b, 4).set(json);
  return b;
}
export const decodeGarage = (dv) => decodeProgress(dv);

// ---------------- scoreboard list ----------------
/** C_LIST (8 bytes): u8 type | u8 order (LIST.*) | u16 reqId | u32 cursor (0 = from the start) */
export function encodeList(order, reqId, cursor) {
  const b = new ArrayBuffer(LIST_SIZE), dv = new DataView(b);
  dv.setUint8(0, C_LIST);
  dv.setUint8(1, order & 0xff);
  dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint32(4, cursor >>> 0, true);
  return b;
}
export function decodeList(dv) {
  if (dv.byteLength !== LIST_SIZE) return null;
  return { order: dv.getUint8(1), reqId: dv.getUint16(2, true), cursor: dv.getUint32(4, true) };
}
/**
 * S_LIST: u8 type | u8 count | u16 reqId | u32 next cursor (0 = end) | u32 online ; entries (44 bytes):
 * u32 netId | u32 nickCode | u8 color | u8 vclass | u8 model | u8 flags (1 visible) | u32 worth | i16 x/10 | i16 z/10
 * | u32 online seconds | name (17) | pad
 */
export const LIST_HDR = 12, LIST_ENTRY = 44;
export function writeListHeader(dv, n, reqId, next, online) {
  dv.setUint8(0, S_LIST); dv.setUint8(1, n); dv.setUint16(2, reqId & 0xffff, true);
  dv.setUint32(4, next >>> 0, true); dv.setUint32(8, online >>> 0, true);
  return LIST_HDR;
}
export function writeListEntry(dv, o, e) {
  dv.setUint32(o, e.netId >>> 0, true);
  dv.setUint32(o + 4, e.nickCode >>> 0, true);
  dv.setUint8(o + 8, e.color & 0xff);
  dv.setUint8(o + 9, e.vclass & 0xff);
  dv.setUint8(o + 10, e.model & 0xff);
  dv.setUint8(o + 11, e.visible ? 1 : 0);
  dv.setUint32(o + 12, qi(e.worth, 0, 0xffffffff), true);
  dv.setInt16(o + 16, qi(e.x / 10, -32767, 32767), true);
  dv.setInt16(o + 18, qi(e.z / 10, -32767, 32767), true);
  dv.setUint32(o + 20, qi(e.onlineS, 0, 0xffffffff), true);
  const end = writeName(dv, o + 24, e.name || '');
  for (let k = end; k < o + LIST_ENTRY; k++) dv.setUint8(k, 0);
  return o + LIST_ENTRY;
}
export function decodeListPage(dv) {
  const n = dv.getUint8(1);
  const out = { reqId: dv.getUint16(2, true), next: dv.getUint32(4, true), online: dv.getUint32(8, true), players: [] };
  for (let i = 0; i < n && LIST_HDR + (i + 1) * LIST_ENTRY <= dv.byteLength; i++) {
    const o = LIST_HDR + i * LIST_ENTRY;
    out.players.push({
      netId: dv.getUint32(o, true), nickCode: dv.getUint32(o + 4, true), color: dv.getUint8(o + 8), vclass: dv.getUint8(o + 9), model: dv.getUint8(o + 10),
      visible: (dv.getUint8(o + 11) & 1) === 1, worth: dv.getUint32(o + 12, true), x: dv.getInt16(o + 16, true) * 10, z: dv.getInt16(o + 18, true) * 10,
      onlineS: dv.getUint32(o + 20, true), name: readName(dv, o + 24).name,
    });
  }
  return out;
}

export {
  C_HELLO, C_STATE, C_PING, C_CLAIM, C_SPAWN, C_INFO_REQ, C_REROLL, C_EVENT, C_ECON,
  S_WELCOME, S_CELL, S_GLOBAL, S_RADAR, S_INFO, S_WALLET, S_RANK, S_PONG, S_SPAWN_ACK, S_CORRECTION, S_NICK, S_EVENT,
  S_KICK, S_NOTICE, S_TICK, S_DENSITY, S_ECON, S_OWNED, S_PROGRESS,
};

// ---------------- visual state (on change) ----------------
/** C_VIS: u8 type | u8 kind (VIS) | u8 len | payload[len ≤ VIS_MAX] */
export function encodeVis(kind, data) {
  const n = Math.min(VIS_MAX, data?.length || 0);
  const b = new ArrayBuffer(3 + n), u8 = new Uint8Array(b);
  u8[0] = C_VIS; u8[1] = kind; u8[2] = n;
  for (let i = 0; i < n; i++) u8[3 + i] = data[i];
  return b;
}
export function decodeVis(dv) {
  if (dv.byteLength < 3) return null;
  const n = dv.getUint8(2);
  if (n > VIS_MAX || dv.byteLength !== 3 + n) return null;
  return { kind: dv.getUint8(1), data: new Uint8Array(dv.buffer.slice(dv.byteOffset + 3, dv.byteOffset + 3 + n)) };
}
/** WRECK payload: u32 seed (31 bits) | short cook-off in bit 31. */
export function wreckPayload(seed, short) {
  const v = ((seed & 0x7fffffff) | (short ? 0x80000000 : 0)) >>> 0;
  return Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24);
}

// ---------------- waiting queue (server full) ----------------
/** QUEUE (16 bytes): u8 type | u8 _ | u16 eta (s, 0xffff unknown) | u32 position (1 = next) | u32 waiting | u32 capacity */
export const QUEUE_SIZE = 16;
export function encodeQueue(position, waiting, etaSec, capacity) {
  const b = new ArrayBuffer(QUEUE_SIZE), dv = new DataView(b);
  dv.setUint8(0, S_QUEUE);
  dv.setUint16(2, etaSec == null ? 0xffff : qi(etaSec, 0, 0xfffe), true);
  dv.setUint32(4, position >>> 0, true);
  dv.setUint32(8, waiting >>> 0, true);
  dv.setUint32(12, capacity >>> 0, true);
  return b;
}
export function decodeQueue(dv) {
  if (dv.byteLength < QUEUE_SIZE) return null;
  const e = dv.getUint16(2, true);
  return { position: dv.getUint32(4, true), waiting: dv.getUint32(8, true), etaSec: e === 0xffff ? null : e, capacity: dv.getUint32(12, true) };
}
/** ADMIT (2 bytes): your turn; the WELCOME follows. */
export function encodeAdmit() { return Uint8Array.of(S_ADMIT, 0).buffer; }
