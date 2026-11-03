// SharedArrayBuffer layout shared by the hub (simulation/broadcast thread), the gateway threads (connections) and the
// DB thread. Each gateway owns a contiguous slot range and is the only writer of those slots' player state; the hub
// is the only writer of the broadcast arena. Readers use a per-slot seqlock, so a torn read is retried next tick.
import { GRID_CELLS, RADAR_CELLS } from '../../src/net/shared/constants.js';
import { createQueueShared, queueViews } from './queue.js';
import { MAP_HEADER, MAP_ENTRY } from '../../src/net/shared/extensions.js';

export const ARENA_BUFFERS = 3; // the hub writes tick T into buffer T % 3, gateways get two ticks of slack
export const ARENA_MAX_ENTRIES = GRID_CELLS * 2 + RADAR_CELLS + 64;
export const ARENA_HDR = 8; // [tick, entries, bytes, busy, ...]
export const KIND_NEAR = 0, KIND_FAR = 1, KIND_RADAR = 2, KIND_GLOBAL = 3, KIND_PLAYER = 4; // PLAYER: id = slot (direct message)
export const JOIN_RING = 1 << 17; // recently joined netIds (scoreboard "online" pages)
export const NAME_STRIDE = 17; // u8 len + 16 ASCII bytes
export const DAMAGE_STRIDE = 42; // u8 len | u8 version | payload (VIS_MAX = 40)
export const OUTFIT_STRIDE = 12; // u16 count + 11 outfit codes (D's appearance codes: item.code * 16 + colour index)
export const IP_TABLE = 1 << 20;
export const MONEY_CAP = 1 << 20; // rank snapshot capacity per half
export const STATS = 16; // per-gateway counters (see STAT_*)
export const STAT_CONN = 0, STAT_MSGS_IN = 1, STAT_BYTES_IN = 2, STAT_PUB_BYTES = 3, STAT_DIRECT_BYTES = 4, STAT_KICKS = 5,
  STAT_VIOLATIONS = 6, STAT_CLAIMS_OK = 7, STAT_CLAIMS_BAD = 8, STAT_SESSIONS = 9, STAT_REJECTED_UPGRADES = 10,
  STAT_PUBLISHES = 11, STAT_CORRECTIONS = 12, STAT_LAG_TICKS = 13;
// hub counters
export const H_TICK = 0, H_TICK_MS = 1, H_TICK_MS_MAX = 2, H_ONLINE = 3, H_VISIBLE = 4, H_ARENA_BYTES = 5, H_TOTAL_PLAYERS = 6,
  H_START_MS = 7, H_TICK_P99 = 8, H_ENC_RECORDS = 9, H_DROPPED_TICKS = 10, H_T0 = 11, H_TICK_DT = 12, H_EGRESS = 13, H_BUDGET = 14,
  H_BOARD_VER = 15;

export function createShared(maxSlots, workers, arenaBytes = 8 << 20) {
  const N = maxSlots;
  const sab = (bytes) => new SharedArrayBuffer(bytes);
  return {
    N,
    workers,
    // ---- player state (gateway → hub) ----
    seq: sab(N * 4),
    alive: sab(N), // 0 free, 1 visible, 2 connected but hidden (no state yet / away)
    gen: sab(N),
    pos: sab(N * 3 * 4), // x, y, z (Float32)
    vel: sab(N * 3 * 4),
    rot: sab(N * 5 * 4), // yaw, pitch, roll, yawRate, steer
    ext: sab(N * 2 * 4), // turret yaw (relative to the hull), barrel pitch (turret vehicles, flags & F_EXT)
    sampleT: sab(N * 8), // Float64 server ms of the sample
    receivedT: sab(N * 8), // last upload receipt: connection liveness is independent of uplink latency
    model: sab(N),
    flags: sab(N * 2),
    // ---- info table (gateway → everyone) ----
    nick: sab(N * 4),
    color: sab(N),
    paint: sab(N * 4),
    infoVer: sab(N),
    vclass: sab(N),
    infoSeq: sab(N * 4), // seqlock over the info fields below (writers: the owning gateway)
    name: sab(N * NAME_STRIDE), // custom nickname (empty = generated from nick)
    cosm: sab(N * 8), // neon (255 none), tint, horn (255 default), finish, armour, _, _, _
    outfit: sab(N * OUTFIT_STRIDE * 2),
    worth: sab(N * 8), // net worth (scoreboard, info)
    // visual state from C_VIS (served in INFO): wreck = [seed | short << 31, Date.now() low 32 bits];
    // damage = [len, version, payload × VIS_MAX]
    wreck: sab(N * 8),
    damage: sab(N * DAMAGE_STRIDE),
    away: sab(N), // 1 = tab in the background (no input): stays in the world, frozen, with an AFK badge
    joinT: sab(N * 8), // epoch ms the session joined
    joinRing: sab(JOIN_RING * 4),
    joinHdr: sab(8), // [head (total joins), _]
    // ---- interest (gateways → hub) ----
    subNear: sab(GRID_CELLS * 4),
    subFar: sab(GRID_CELLS * 4),
    subDirty: sab(GRID_CELLS * 4), // a cell got a new subscriber: the hub refreshes it quickly
    subRadar: sab(RADAR_CELLS * 4),
    // ---- broadcast arena (hub → gateways) ----
    arenaHdr: sab(ARENA_BUFFERS * ARENA_HDR * 4),
    arenaIdx: sab(ARENA_BUFFERS * ARENA_MAX_ENTRIES * 3 * 4),
    arenaData: sab(ARENA_BUFFERS * arenaBytes),
    arenaBytes,
    globalMsg: sab(4096), // latest S_GLOBAL (top-10 board) payload, served on request
    globalLen: sab(8), // [len, version]
    pulseMsg: sab(16), // latest S_PULSE (sent right after WELCOME)
    densityMsg: sab(1024), // latest S_DENSITY (heatmap), served on request
    densityLen: sab(8),
    mapMsg: sab(MAP_HEADER + N * MAP_ENTRY),
    mapMeta: sab(12), // seqlock, length, latest demand tick
    // ---- misc ----
    ipTable: sab(IP_TABLE * 4), // per-IP connection counts (hashed)
    money: sab(MONEY_CAP * 2 * 8), // rank snapshot, two halves
    moneyHdr: sab(16), // [active half, count, version, total players]
    stats: sab(Math.max(1, workers) * STATS * 8),
    hub: sab(16 * 8),
    queue: createQueueShared(), // admission control + waiting queue (src/queue.js)
  };
}

/** Typed views over a shared block (call once per thread). */
export function views(s) {
  const N = s.N;
  return {
    N,
    workers: s.workers,
    seq: new Int32Array(s.seq),
    alive: new Uint8Array(s.alive),
    gen: new Uint8Array(s.gen),
    pos: new Float32Array(s.pos),
    vel: new Float32Array(s.vel),
    rot: new Float32Array(s.rot),
    ext: new Float32Array(s.ext),
    sampleT: new Float64Array(s.sampleT),
    receivedT: new Float64Array(s.receivedT),
    model: new Uint8Array(s.model),
    flags: new Uint16Array(s.flags),
    nick: new Uint32Array(s.nick),
    color: new Uint8Array(s.color),
    paint: new Uint32Array(s.paint),
    infoVer: new Uint8Array(s.infoVer),
    vclass: new Uint8Array(s.vclass),
    infoSeq: new Int32Array(s.infoSeq),
    name: new Uint8Array(s.name),
    cosm: new Uint8Array(s.cosm),
    outfit: new Uint16Array(s.outfit),
    worth: new Float64Array(s.worth),
    wreck: new Uint32Array(s.wreck),
    away: new Uint8Array(s.away),
    damage: new Uint8Array(s.damage),
    joinT: new Float64Array(s.joinT),
    joinRing: new Int32Array(s.joinRing),
    joinHdr: new Int32Array(s.joinHdr),
    subNear: new Int32Array(s.subNear),
    subFar: new Int32Array(s.subFar),
    subDirty: new Int32Array(s.subDirty),
    subRadar: new Int32Array(s.subRadar),
    arenaHdr: new Int32Array(s.arenaHdr),
    arenaIdx: new Int32Array(s.arenaIdx),
    arenaData: new Uint8Array(s.arenaData),
    arenaDV: new DataView(s.arenaData),
    arenaBytes: s.arenaBytes,
    globalMsg: new Uint8Array(s.globalMsg),
    globalLen: new Int32Array(s.globalLen),
    pulseMsg: new Uint8Array(s.pulseMsg),
    densityMsg: new Uint8Array(s.densityMsg),
    densityLen: new Int32Array(s.densityLen),
    mapMsg: new Uint8Array(s.mapMsg),
    mapMeta: new Int32Array(s.mapMeta),
    ipTable: new Int32Array(s.ipTable),
    money: new Float64Array(s.money),
    moneyHdr: new Int32Array(s.moneyHdr),
    stats: new Float64Array(s.stats),
    hub: new Float64Array(s.hub),
    q: queueViews(s.queue),
  };
}

/** Slot range owned by gateway `w` of `workers`. */
export function slotRange(N, workers, w) {
  const per = Math.floor(N / Math.max(1, workers));
  return [w * per, w === Math.max(1, workers) - 1 ? N : (w + 1) * per];
}

/** FNV-1a hash of an IP string into the shared table. */
export function ipSlot(ip) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ip.length; i++) { h ^= ip.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) & (IP_TABLE - 1);
}

/** Rank of `money` (1 = richest) in the DB snapshot; total = snapshot size. */
export function rankOf(v, money) {
  const half = Atomics.load(v.moneyHdr, 0), n = Atomics.load(v.moneyHdr, 1);
  const base = half * MONEY_CAP;
  // descending array: first index with value <= money
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (v.money[base + mid] > money) lo = mid + 1; else hi = mid;
  }
  return { rank: lo + 1, total: Math.max(n, lo + 1) };
}

/** Custom name of a slot from the shared table ('' = generated). */
export function slotName(v, slot) {
  const o = slot * NAME_STRIDE, n = Math.min(16, v.name[o]);
  let str = '';
  for (let i = 0; i < n; i++) str += String.fromCharCode(v.name[o + 1 + i]);
  return str;
}
export function setSlotName(v, slot, name) {
  const o = slot * NAME_STRIDE, n = Math.min(16, name ? name.length : 0);
  v.name[o] = n;
  for (let i = 0; i < n; i++) v.name[o + 1 + i] = name.charCodeAt(i) & 0x7f;
}
