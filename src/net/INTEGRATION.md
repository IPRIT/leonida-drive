# Multiplayer (workstream J) — integration

Online (`game.mode === 'online'`, the default) the net module connects to the server, shows everyone else (instanced
vehicles incl. articulated tanks and neon underglow, D's avatars with outfits, WebGL nametags, minimap blips), streams
your state at 20 Hz, restores your session (position, vehicle, wallet), runs the server-authoritative wallet,
services, wardrobe and nicknames, replicates tank turrets/shots/hits/crushes, syncs the shared clock and weather, and
draws the online counter, the hold-Tab scoreboard and the pause-menu "Online" tab. Singleplayer never connects: it
only keeps a local position save (`leonida.save.single.pos`). Server: `server/README.md`.

## 1. Bootstrap (the only required change)

`src/main.js`:

```js
import { createGame } from './core/bootstrap.js';
import { netModule, preconnectNet } from './net/index.js';

preconnectNet(); // online mode only: the WebSocket handshake overlaps with loading the world
createGame(document.getElementById('app'), {
  modules: [netModule()],
});
```

`netModule()` runs in bootstrap's "extra modules" loop (after the world, player, economy and UI exist), waits up to
1.5 s for the server's WELCOME so a saved session is restored before the first frame, then registers itself
(order 70: after vehicles and the player). If the server is unreachable it plays offline from the last online
position and keeps retrying (backoff + jitter). Server URL: `VITE_MP_URL` at build time, else
`ws://127.0.0.1:8787/ws` on localhost (dev override `?mp=ws://127.0.0.1:PORT/ws`, localhost only), else
`wss://mp.leonida-drive.io/ws`. For production builds set `VITE_MP_URL=wss://<your host>/ws`.

## 2. Small changes in other workstreams' files (please apply)

| File (owner) | Change | Why |
|---|---|---|
| `src/ui/tabs/VehiclesTab.js` (G) | **applied by J:** `async spawn(id)` awaits `g.net.requestVehicle(id, { color })` | server-enforced 8 s spawn cooldown and ownership |
| `src/ui/controls-data.js` (G) | **applied by J:** `['act.players', ['Tab']]` (keyboard) and `['act.players', ['R3']]` (pad; Back opens the map) + `act.players` in all 30 locales | scoreboard binding (hold; touch: tap the online counter) |
| `src/economy/Economy.js` (L) | **applied by J:** `changeNick` forwards `suggest` / `check` to the server when remote (local fallback) | G's nickname UI calls these modes |
| `src/main.js` (integrator) | **applied by J:** `preconnectNet()` + `modules: [netModule()]` (`?mode=single` = no network) | bootstrap |
| `src/ui/Loading.js` + `src/ui/styles.css` (G) | **applied by J:** the start screen offers Singleplayer / Multiplayer · N online (`src/net/status.js` polls `GET /status` every 10 s while the screen is up; the loaded mode is preselected, the other one reloads into it via `leonida.mode` and starts at once); Multiplayer on a full server shows the queue card (`src/net/ui/QueueCard.js`) and starts on admission | start choice + queue |
| `src/mobile` (K) | optional dedicated button: `game.net?.ui?.board.toggle()` | the online pill already toggles it on tap |

APIs of other workstreams J relies on (please keep them stable or tell J): A — `playTankWreck(game, opts)` →
`{ turretDetached, dispose() }`, `tank:cookoff` / `tank:destroyed` with `seed`, `game.damage.explode(v)`; D —
`encodeOutfit` / `decodeOutfit` / `WARDROBE` codes and palettes (`src/characters/wardrobe.js`, also loaded by the
server), `createRemoteAvatars(...).add(id, { outfit })` / `h.set({ outfit })`; E — `game.damage.templates`
(`get` / `want`), `TrafficWreckDamage.create(sys, { material, scene }, agent, tpl)`, `.restore(snap, lift)`,
`.detach(part)`, `.sync(pos, quat, paint, brake)`, `.dispose()`, the `impact` event (`source` = the vehicle).

Everything else is already wired through existing hooks: `game.ui.hud.mount('top-center')`, `game.ui.menu.addTab`,
`game.ui.feed`, `game.ui.setWaypoint`, `game.ui.setPlayerBlips`, `game.cartography.setPlayers`, `game.economy.applyServer`,
`game.events` (`horn`, `wasted`, `respawn`, `vehicle:enter`, `tank:fire`), A's `Shells.spawnRemote` / `tank.takeShellHit`
/ `bakeVehicle('tank')` parts, D's `createRemoteAvatars`, E's `VehicleDamage`.

## 3. `game.net` API

| Member | |
|---|---|
| `queue` → `{ position, waiting, etaSec, capacity }` while waiting in line (else null), `leaveQueue()`, `rejoin()` | waiting queue (server full): leaving gives the place up; rejoin starts again at the back |
| `online`, `status` (`connecting \| queued \| online \| reconnecting \| offline \| kicked`), `ping`, `playersOnline`, `offlineRestored` | connection. `offline`: unreachable server (retry 1–15 s) or another protocol version (`client.protoMismatch`: retry after 1, 2, 4, 5 min; the status pill reloads the page). `kicked`: duplicate tab (one profile per browser origin: a second tab on the same origin takes the session over) or banned |
| `me` → `{ netId, nickCode, nick, custom, color, colorIndex }` | your identity (custom name wins) |
| `serverNow()` | server clock (ms) |
| `players()` → `[{ id, nick, color, x, y, z, heading, vclass, model, near, worth, neon, tint, horn, outfit, turret, barrel }]` | remote players in view; `outfit` is D's canonical `{ slot: { id, color } }` (`decodeOutfit` of the wire codes) |
| `remotePositions()` → `[{ x, z }]` (reused) | spawn-slot picking (L) |
| `remoteVehicles()` → `[{ x, y, z, yaw, hw, hl, vx, vz, speed }]` (reused objects; `y` = body centre, on-foot players left out) | obstacle boxes (D's ped avoidance) |
| `nameOf(e)`, `listOnline(cursor)` → `Promise<{ players, next, online }>` | names; paged online list (30 per page, ≤ 1/s) |
| `canSpawnVehicle(id)` → `{ ok, waitS }`, `requestVehicle(id, { color })` → `Promise<boolean>` | garage (owned ids, 8 s cooldown) |
| `claim(reason, amount, pos, meta)`, `buy(id)`, `sell(id, condition)`, `repair(id, damage)`, `paint(variant)`, `charge(reason)` | economy (L), all resolve with the server's answer |
| `service(id, vehicleId, opts)`, `setCosmetic(vehicleId, { neon \| armor: false })`, `useItem('extinguisher')`, `inventory` | services (L): `repair \| extinguisher \| armor \| insurance \| claim \| nitro \| neon \| tint \| horn \| respray` |
| `wardrobe(itemId, colour, 'buy' \| 'dye')`, `setOutfit({ slot: itemId \| null } \| { slot: { id, color } })`, `wardrobeState` | wardrobe (prices `src/economy/wardrobe-prices.json`; colours must be from the item's palette in D's catalogue; all 11 slots incl. `jacket`) |
| `changeNick('reroll' \| 'custom' \| 'check' \| 'suggest', value)` → `{ ok, reason?, nick, code, money, cost, available?, suggestions? }`, `nickPrices` | nicknames: first reroll free then $2,500, custom $50,000; reasons `format \| blocked \| taken \| generated \| funds \| cooldown \| busy` |
| `canFire()`, `fire({ x, y, z, yaw, pitch, clear? })` | tank cannon (called automatically from `tank:fire` of your own tank) |
| `onWallet(cb)`, `wallet`, `progress` | wallet snapshots |
| `retry()`, `reroll()` | reconnect after a duplicate-tab kick; legacy reroll |

Events emitted on `game.events`: `net:queue` `{ position, waiting, etaSec, capacity }` (only when it changes), `net:admit`, `net:shot`, `net:boom`, `net:hit` `{ victim, victimName, damage, destroyed }`,
`net:damage` `{ kind, attacker, attackerName, amount, destroyed, crush }`, `net:nick`, `net:wardrobe`.
Events consumed: `tank:cookoff` / `tank:destroyed` of your own tank (the wreck seed goes to the server once), `impact`
and `vehicle:part` of your own car (damage state, below).
Hooks A may provide to replace the defaults: `game.weapons.remoteShell(shot)`, `remoteBoom(boom)`, `applyNetDamage(dmg)`.

Settings: `mpShowPlayers` (others + blips + colliders), `mpNametags`. i18n: namespace `net` (en + ru registered from
`src/net/i18n.js`, keys in `NET_KEYS`; other languages fall back to English).

## 4. What replicates and how

- Vehicles/characters: error-driven per-cell streams with the server mirroring each client's dead reckoning (yaw-rate
  arc), judged one send interval ahead. Streams go out on even ticks only (10 Hz: one TCP write per client per send
  tick, nothing on quiet ticks); a crash-sized error (≥ 4× threshold) goes out on the next tick. Records carry the
  motion part always (19 B) and model/flags, pitch/roll, steer only when they changed (keyframes every 2 s moving,
  20 s parked; everything for new viewers). The far ring updates at 5 Hz. Clients upload on deviation too
  (`src/net/shared/uplink.js`: ≥ 4 Hz heartbeat, else only when the server's extrapolation would be off by 5 cm /
  0.7° / 0.25 m/s or something discrete changed). Client: adaptive jitter buffer, Hermite interpolation, third-order
  offset filter (no snaps), dissolve on teleports.
- Minimap: radar summaries every 2 s per 1 km cell (moving players every time, standing ones every 8 s), dead-reckoned
  per frame on the client (`RadarTracks`); players in view follow their 3D pose.
- Low-rate data is served on request instead of broadcast: top-10 board + your rank (`LIST.WORTH`, when the
  scoreboard / pause menu opens), density heatmap (`LIST.DENSITY`, while the full map is open). A 10 s pulse carries
  the online count, board version and tick; the world clock and weather are computed locally from the synced clock.
- Tank: turret yaw and barrel pitch ride in a 3-byte record part; a destroyed tank's wreck seed is sent once
  (`C_VIS WRECK`) and replayed by everybody with A's `playTankWreck` (same turret toss; the drawn turret is hidden once
  it is thrown; a late arrival does not replay an old blast).
- Car damage (E): detached panels, glass, broken lamps and the 4 strongest impacts (`src/net/shared/damage-codec.js`,
  ≤ 31 B) are sent on change (`C_VIS DAMAGE`, ≤ 2/s); up to 6 remote cars within 120 m are drawn as dentable copies
  with E's `TrafficWreckDamage` (`src/net/render/RemoteDamage.js`), the rest stay clean instanced bodies.
- Cosmetics, outfit (D's appearance codes: one u16 per worn item incl. colour, ≤ 11), custom name, net worth, wreck seed
  and damage state: per-player INFO record (with a skippable tagged trailer), re-requested when the 3-bit info version
  in the record flags changes — so it costs nothing until it changes, and late arrivals get the current state.
- Shots → everyone within ~2 cells of the muzzle; impacts/crushes resolved by the server → BOOM to the area, DAMAGE to
  the victim, HIT to the shooter.

## 5. Protocol (binary, little-endian, `PROTO_VERSION = 5`)

A client of another version is kicked with `KICK.PROTOCOL` before anything else is read; it then plays offline,
shows "Offline · update pending ↻" (tap = reload) and retries after 1, 2, 4 and 5 minutes.

| Client → server | Bytes | |
|---|---|---|
| `C_HELLO` | 40 | token (32), flags, build, seconds played offline |
| `C_STATE` | 38 (41 with turret) | on deviation (≥ 4 Hz): seq, server-clock time, pos (cm), yaw/pitch/roll, velocity, yaw rate, steer, model, flags, health |
| `C_PING` | 12 | clock sync (6 per second at start, then every 6 s) |
| `C_CLAIM` 28, `C_ECON` 8, `C_SERVICE` 12, `C_SPAWN` 16, `C_EVENT` 8, `C_LIST` 8, `C_FIRE` 28 | | economy, services, garage, events, scoreboard pages / board / heatmap, cannon |
| `C_OUTFIT` | 2 + 2·n (n ≤ 11) | wear items (D's appearance codes) |
| `C_NICK` | 5 + len (≤ 21) | reroll / custom / check |
| `C_VIS` | 3 + n (n ≤ 40) | visual state on change: `WRECK` (u32 seed, bit 31 short cook-off), `DAMAGE` (damage-codec bytes) |
| `C_INFO_REQ` | 2 + 3·n (n ≤ 32) | ask for INFO records |

| Server → client | Bytes | |
|---|---|---|
| `S_CELL` | 8 + 5·gone + records (19 motion + 3 model/flags + 2 pitch/roll + 1 steer + 3 turret, optional parts) | per cell & stream, encoded once, fanned out by pub/sub; u16 tick (unwrapped against the welcome / pulse tick) |
| `S_PULSE` | 16 | every 10 s: online, registered, board version, tick |
| `S_QUEUE` | 16 | server full, you are waiting: position (1 = next), waiting, ETA (s, 0xffff unknown), capacity; on change, ≤ 1 per 4 s |
| `S_ADMIT` | 2 | your turn: the WELCOME follows on the same socket (answer it within 15 s; the client sends a ping at once) |
| `S_RADAR` | 12 + 10·n (≤ 96) | every 2 s per 1 km cell: id, position, heading, colour/class, speed |
| `S_GLOBAL` | 40 + 40·top (≤ 10) | top 10 by net worth, on request (`C_LIST` WORTH) |
| `S_RANK` 12, `S_DENSITY` 566 | | on request |
| `S_INFO` | 2 + 27…92 per player | nick, colour, custom name, cosmetics, outfit codes, worth, wreck seed, damage state |
| `S_EVENT` | 32 | join / leave (with name) |
| `S_FX` | 32 (shot, boom) / 16 (hit) | combat effects |
| `S_DAMAGE` | 28 | server-resolved damage to you |
| `S_WELCOME` | ≈ 1.4 KB once | identity, token, restore, vehicle table, custom name |
| `S_WALLET` 28, `S_ECON` 24, `S_OWNED` 44, `S_NICK` 40, `S_PONG` 20, `S_SPAWN_ACK` 8, `S_CORRECTION` 20, `S_NOTICE` 12, `S_KICK` 2 | | |
| `S_PROGRESS`, `S_GARAGE` | 4 + JSON | server-built JSON (inventory, cosmetics, wardrobe, outfit, rerolls; progress) |
| `S_LIST` | 12 + 44·n (≤ 30) | online page |

Downlink on the wire (payload + WebSocket framing + TLS/TCP per packet), measured with
`node tools/loadtest/bandwidth-report.mjs`: typical (200 players over 4 km) ≈ 0.7 KB/s, crowd (60 driving within
300 m) ≈ 5.4 KB/s, 60 parked around you ≈ 0.2 KB/s, alone ≈ 0.04 KB/s. Uplink ≈ 12 × 38 B/s while driving, 4 × 38 B/s
parked. permessage-deflate stays off: with context takeover it saves 14–18 % of the payload for ≈ 0.5 % of a core
per crowded client (`tools/loadtest/deflate-measure.mjs`).

## 6. Labs and tests

- Queue / start screen: `cd server && MAX_PLAYERS=1 node src/main.js`, `node tools/loadtest/hold-slots.mjs --count 1`, then open `index.html?mp=ws://127.0.0.1:8787/ws&mode=online` (Multiplayer shows "In line · #1"; Ctrl-C the holder to be admitted).
- Local online testing (stopped by default, it costs CPU): `cd server && JOIN_ANYWHERE=1 MAX_CONN_PER_IP=100000 CONN_RATE_PER_IP=10000000 WORKERS=2 node src/main.js` (:8787), then optional bots `node tools/loadtest/bots.js --count 30 --cx 1745 --cz -640 --radius 250`; open `lab-net.html?mp=ws://127.0.0.1:8787/ws` (a second client needs another origin, e.g. localhost vs 127.0.0.1); stop both with Ctrl-C when done.

- `lab-net.html` (needs `npm --prefix server start`): the game with the net module; `?ui=1` for the full UI, `?x=&z=`,
  `P` spectate nearest bot. Bots: `node tools/loadtest/bots.js --count 30 --cx 1745 --cz -640 --radius 250`.
- `npm --prefix server test` — protocol round trips, anti-cheat (speed, teleport, fly, money, flood, oversize, NaN),
  persistence across a real SIGTERM restart, combat (hit, reload, aim, crush), services/cosmetics replication,
  nicknames (blocklist, uniqueness, never charged on rejection), online pages, wardrobe / outfit codes, visual state
  (damage, wreck seed), IP privacy and retention, netcode smoothness (clean, dropped messages, TCP retransmissions,
  crash, teleport; deviation uplink vs 20 Hz).
- `node server/tools/smoothness-report.mjs` (8 seeds per scenario), `node tools/loadtest/bandwidth-report.mjs`
  (typical / crowd / idle / empty, `--dump dir` + `tools/loadtest/deflate-measure.mjs`).
- Catalog changes: `node server/tools/gen-vehicles.mjs` (stable model indices; the tank is included).
