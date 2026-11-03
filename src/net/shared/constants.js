// Shared multiplayer constants (client + server). Pure data, no DOM, no Node APIs.
// Changing anything here that affects the wire format requires bumping PROTO_VERSION.

export const PROTO_VERSION = 5;

// ---- world & interest grid ----
// Data bounds are x -9216..4096, z -9216..9728 (public/data/world.json); the grid adds a 512 m margin.
export const WORLD = Object.freeze({ x0: -9728, z0: -9728, x1: 4608, z1: 10240, yMin: -120, yMax: 3000 });
export const CELL = 128; // metres per interest cell (one pub/sub topic per cell and stream)
export const GRID_NX = Math.ceil((WORLD.x1 - WORLD.x0) / CELL); // 112
export const GRID_NZ = Math.ceil((WORLD.z1 - WORLD.z0) / CELL); // 156
export const GRID_CELLS = GRID_NX * GRID_NZ; // 17472 (fits u16)
export const RADAR_CELL = 1024; // metres per radar cell (minimap summaries)
export const RADAR_NX = Math.ceil((WORLD.x1 - WORLD.x0) / RADAR_CELL); // 14
export const RADAR_NZ = Math.ceil((WORLD.z1 - WORLD.z0) / RADAR_CELL); // 20
export const RADAR_CELLS = RADAR_NX * RADAR_NZ;
export const RADAR_WINDOW = RADAR_CELL * 3; // a radar message covers its cell and the 8 neighbours
export const RADAR_MAX = 96; // max entries per radar message (sampled evenly when more players are in the window)

// AOI rings (in cells): near = (2*NEAR_R+1)^2 cells at full rate, far = ring up to FAR_R at low rate.
export const NEAR_R = 1;
export const FAR_R = 2;
export const FAR_R_AIR = 3; // aircraft above AIR_ALT get a wider far ring
export const AIR_ALT = 150;

// ---- ids ----
// netId (u24) = slot (17 bits) | generation (7 bits) << 17. The slot indexes the server's shared tables.
export const SLOT_BITS = 17;
export const MAX_SLOTS = 1 << SLOT_BITS; // 131072 players per server process
export const SLOT_MASK = MAX_SLOTS - 1;

// ---- streams ----
export const STREAM_NEAR = 0;
export const STREAM_FAR = 1;

// ---- quantisation ----
export const Q_POS = 448; // units per metre inside a cell; u16 covers [-POS_MARGIN, 138 m) for cell hysteresis
export const POS_MARGIN = 8; // m: an entity may sit slightly outside its cell (hysteresis at cell borders)
export const Q_Y = 20; // units per metre, y offset Y_OFF (u16 → -100..3176 m)
export const Y_OFF = 100;
export const Q_VEL = 100; // cm/s in i16 (±327 m/s)
export const Q_YAWRATE = 16; // i8, 1/16 rad/s (±7.9 rad/s)
export const Q_STEER = 128; // i8, 1/128 rad
export const REC_SIZE = 19; // bytes of an entity record's motion part (optional parts follow, see REC_* masks)
export const REC_EXT = 3; // + u16 turret yaw (relative to the hull) + i8 barrel pitch when the record has F_EXT
// record part mask (u8 after the id): motion is always present; the rest only when it changed (or for new viewers)
export const REC_FULL = 0x01; // + u8 model + u16 flags
export const REC_ROT = 0x02; // + i8 pitch + i8 roll
export const REC_STEER = 0x04; // + i8 steer
export const REC_TURRET = 0x08; // + u16 turret + i8 barrel
export const REC_ALL = REC_FULL | REC_ROT | REC_STEER;
export const Q_VY = 4; // i8, 1/4 m/s (±31.75 m/s)
export const Q_BARREL = 100; // i8, 1/100 rad (±1.27 rad)
export const AGE_UNIT = 2; // ms per unit of the record's sample age byte (0..510 ms before the tick)

// ---- entity flags (u16) ----
export const F_TPC = 0x0003; // teleport counter (2 bits): changes on a server-approved discontinuity
export const F_ANIM_SHIFT = 2; // 3 bits: on-foot animation state
export const F_ANIM = 0x001c;
export const F_LIGHTS = 0x0020;
export const F_SIREN = 0x0040;
export const F_HORN = 0x0080;
export const F_BRAKE = 0x0100;
export const F_BURNING = 0x0200;
export const F_BOOST = 0x0400;
export const F_AIRBORNE = 0x0800;
export const F_INFO_SHIFT = 12; // 3 bits: info version (nick/colour/paint/cosmetics changed → re-request INFO)
export const F_INFO = 0x7000;
export const F_INFO_MASK = 7;
export const F_EXT = 0x8000; // the record carries REC_EXT extra bytes (turret vehicles); set by the server
// flags a client may set; the server owns TPC and INFO
export const F_CLIENT_MASK = F_ANIM | F_LIGHTS | F_SIREN | F_HORN | F_BRAKE | F_BURNING | F_BOOST | F_AIRBORNE;

export const ANIM = Object.freeze({ IDLE: 0, WALK: 1, RUN: 2, SPRINT: 3, AIR: 4, SWIM: 5, RAGDOLL: 6, SEATED: 7 });

// ---- vehicle classes (server limits, client icons) ----
export const VCLASS = Object.freeze({ FOOT: 0, CAR: 1, BIKE: 2, HELI: 3, PLANE: 4, BOAT: 5 });
export const MODEL_FOOT = 0; // model index 0 = on foot; 1..254 = server vehicle table; 255 = unknown
export const MODEL_UNKNOWN = 255;

// ---- message types ----
// client → server
export const C_HELLO = 0x01;
export const C_STATE = 0x02;
export const C_PING = 0x03;
export const C_CLAIM = 0x04;
export const C_SPAWN = 0x05;
export const C_INFO_REQ = 0x06;
export const C_REROLL = 0x07;
export const C_EVENT = 0x08;
export const C_ECON = 0x09;
export const C_FIRE = 0x0a;
export const C_SERVICE = 0x0b;
export const C_LIST = 0x0c;
export const C_OUTFIT = 0x0d;
export const C_NICK = 0x0e;
export const C_VIS = 0x0f; // visual state of your vehicle, on change only (tank wreck seed, car damage)
// server → client
export const S_WELCOME = 0x81;
export const S_CELL = 0x82;
export const S_GLOBAL = 0x83;
export const S_RADAR = 0x84;
export const S_INFO = 0x85;
export const S_WALLET = 0x86;
export const S_RANK = 0x87;
export const S_PONG = 0x88;
export const S_SPAWN_ACK = 0x89;
export const S_CORRECTION = 0x8a;
export const S_NICK = 0x8b;
export const S_EVENT = 0x8c;
export const S_KICK = 0x8d;
export const S_NOTICE = 0x8e;
export const S_TICK = 0x8f;
export const S_DENSITY = 0x90;
export const S_ECON = 0x91;
export const S_OWNED = 0x92;
export const S_PROGRESS = 0x93;
export const S_FX = 0x94; // shot / explosion / hit confirmation (AOI broadcast or direct)
export const S_DAMAGE = 0x95; // server-resolved damage to your vehicle / character
export const S_GARAGE = 0x96; // inventory + per-vehicle cosmetics (JSON built by the server)
export const S_LIST = 0x97; // a page of online players (scoreboard)
export const S_PULSE = 0x98; // every 10 s: online count, registered players, board version, tick
export const S_QUEUE = 0x99; // server full, you are waiting: position, total, ETA (on change, ≤ 1 per 4 s)
export const S_ADMIT = 0x9a; // your turn: the join (WELCOME) follows on the same socket

// ---- message sizes (fixed-size client messages are validated exactly) ----
export const HELLO_SIZE = 40; // type, proto, flags, reserved, token[32], build u16, reserved u16
export const STATE_SIZE = 38;
export const STATE_EXT_SIZE = 41; // + u16 turret yaw + i8 barrel pitch (turret vehicles)
export const PING_SIZE = 12;
export const CLAIM_SIZE = 28;
export const ECON_SIZE = 8;
export const SPAWN_SIZE = 16;
export const REROLL_SIZE = 4;
export const EVENT_SIZE = 8;
export const FIRE_SIZE = 28;
export const SERVICE_SIZE = 12;
export const LIST_SIZE = 8;
export const OUTFIT_MAX = 11; // items per outfit (one per wardrobe slot; D's appearance codes, src/net/shared/outfit-codes.js)
export const NICK_REQ_MAX = 21; // type, op, reqId u16, len u8, name[16]
// C_VIS kinds; the server keeps the latest of each per player and serves it in INFO (late joiners get it too)
export const VIS = Object.freeze({ WRECK: 1, DAMAGE: 2, AWAY: 3 }); // AWAY: [1] tab hidden / [0] back
export const VIS_MAX = 40; // payload bytes
export const INFO_REQ_MAX = 32;
export const MAX_CLIENT_MSG = 512;

// HELLO flags
export const HF_TOKEN = 0x01; // token present
export const HF_RESUME = 0x02; // reconnect within the same page session: keep the client's position

// claims (docs/ECONOMY.md reason table)
export const CLAIM = Object.freeze({
  DRIFT: 1, STUNT: 2, NEARMISS: 3, PICKUP: 4, COLLECTIBLE: 5, RACE: 6, OTHER: 7, SPEEDTRAP: 8, DELIVERY: 9, EXPORT: 10, DAILY: 11, FIRSTVISIT: 12,
});
export const CLAIM_NAMES = Object.freeze({
  drift: 1, stunt: 2, nearmiss: 3, near: 3, pickup: 4, collectible: 5, race: 6, other: 7, speedtrap: 8, delivery: 9, export: 10,
  daily: 11, firstvisit: 12,
});
export const WALLET = Object.freeze({ GRANTED: 0, CLAMPED: 1, REJECTED: 2, FROZEN: 3, CHARGE: 4, SYNC: 5, PURCHASE: 6, SALE: 7 });
// economy requests (C_ECON op) and results (S_ECON)
export const ECON = Object.freeze({ BUY: 1, SELL: 2, REPAIR: 3, PAINT: 4 });
export const ECON_RESULT = Object.freeze({
  OK: 0, FUNDS: 1, NOT_OWNED: 2, OWNED: 3, NOT_SELLABLE: 4, UNKNOWN: 5, RATE: 6, FROZEN: 7, OFFLINE: 8,
  // services (C_SERVICE): the reason codes of rules.servicePrice
  UNDAMAGED: 9, MAX: 10, EXCLUDED: 11, INSTALLED: 12, VARIANT: 13, FINISH: 14, COLOR: 15, NO_VEHICLE: 16, EMPTY: 17,
});
// C_SERVICE ops: stable wire ids of rules.SERVICES (purchases) + free actions
export const SERVICE = Object.freeze({
  repair: 1, extinguisher: 2, armor: 3, insurance: 4, claim: 5, nitro: 6, neon: 7, tint: 8, horn: 9, respray: 10,
  NEON_COLOR: 32, // free recolour / switch off (kit installed)
  USE_EXTINGUISHER: 33, // a carried extinguisher was used
  ARMOR_GONE: 34, // armour plating ended (repair / wreck)
});
export const SERVICE_NAMES = Object.freeze(Object.fromEntries(Object.entries(SERVICE).map(([k, v]) => [v, k])));
// nickname changes (C_NICK op) and their prices (charged only when the server accepts the name)
export const NICK_OP = Object.freeze({ REROLL: 1, CUSTOM: 2, CHECK: 3 }); // CHECK: availability of a custom name, free
export const NICK_PRICE = Object.freeze({ reroll: 2500, custom: 50000 }); // the first reroll of a profile is free (rules.nickPrice)
export const NICK_RESULT = Object.freeze({ OK: 0, COOLDOWN: 1, FUNDS: 2, FORMAT: 3, BLOCKED: 4, TAKEN: 5, RESERVED: 6, BUSY: 7 });
export const NICK_COOLDOWN_S = 600; // one change per 10 minutes
// wardrobe (C_SERVICE ops with an item index)
export const WARDROBE_OP = Object.freeze({ BUY: 48 });
// list orders (C_LIST)
export const LIST = Object.freeze({ RECENT: 0, WORTH: 1, DENSITY: 2 }); // WORTH → top-10 board + your rank; DENSITY → heatmap
// combat
export const FX = Object.freeze({ SHOT: 1, BOOM: 2, HIT: 3 });
export const DMG = Object.freeze({ SHELL: 1, SPLASH: 2, CRUSH: 3 });

// client events
export const EV_DIED = 1;
export const EV_RESPAWNED = 2;
// server events (S_EVENT)
export const SE_JOIN = 1;
export const SE_LEAVE = 2;

// kick codes
export const KICK = Object.freeze({
  PROTOCOL: 1, // protocol version mismatch: reload the page
  DUPLICATE: 2, // the same profile connected from another tab
  RATE: 3, // flooding
  INVALID: 4, // malformed messages
  FULL: 5, // server full
  TIMEOUT: 6, // no hello / no state
  BANNED: 7,
  SHUTDOWN: 8, // server restarting
});

// notices
export const NOTICE = Object.freeze({ CLAIMS_FROZEN: 1, CLAIMS_RESTORED: 2, HOSPITAL_FEE: 3, MOVEMENT: 4, OFFLINE_EARNINGS: 5 });

// spawn ack codes
export const SPAWN = Object.freeze({ OK: 0, COOLDOWN: 1, UNKNOWN_MODEL: 2, TOO_FAR: 3, DEAD: 4, RATE: 5, NOT_OWNED: 6 });

// player colour palette (stable per-player colour index, u8)
export const PLAYER_COLORS = Object.freeze([
  '#ff3fa4', '#29f0e0', '#ffb020', '#7cff4f', '#a24dff', '#ff5a3c', '#3fa6ff', '#ffe14d',
  '#ff7ad9', '#00e08a', '#ff9a5c', '#5ce1ff', '#c3ff3d', '#b98cff', '#ff4f6d', '#4fffc6',
  '#f5c84c', '#6c8cff', '#ff6bb5', '#36d6a0', '#ffa3f2', '#9be564', '#ffcf8c', '#8ff0ff',
]);

// time of day: 48 real minutes per in-game day (= Sky default timeScale 1/120 h/s)
export const DAY_SECONDS = 2880;
