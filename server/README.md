# Leonida Drive — multiplayer server

Server-authoritative realtime server for online mode: positions and interest management, the wallet and economy,
garage/services/wardrobe, nicknames, tank combat, leaderboard by net worth, shared clock and weather, persistence.
Binary WebSocket protocol (`src/net/shared/protocol.js`, version byte = `PROTO_VERSION`), 20 Hz.

```
main thread   hub: 20 Hz tick, uniform interest grid (128 m cells), encode-once cell streams, shells & crush,
              radar/global/leaderboard broadcast, uWS acceptor (hands sockets to the gateways)
N gateways    uWS child apps: sessions, strict decoding, validation (movement, claims, purchases, fire),
              publish the hub's pre-encoded buffers to native pub/sub topics (C++ fan-out)
DB thread     node:sqlite (WAL): sessions, write-behind saves, leaderboard, rank snapshot, nickname uniqueness
```

## Run

Requirements: **Node.js 22.14+ or 24 LTS** (also 25) on **glibc** Linux/macOS (uWebSockets.js ships prebuilt
binaries for Node ABI 127/137/141; Alpine/musl and Node 26+ fall back to the single-threaded `ws` transport, logged as
an error in production). Tested: Node 25.9 (macOS) and Node 22.14 (full test suite).

Development (from the repo, `server/`):

```sh
npm install
npm start                      # ws://127.0.0.1:8787/ws, DB in server/data/leonida.db
npm test                       # protocol, anti-cheat, end-to-end, persistence across SIGTERM, combat, smoothness
```

The browser client connects to `VITE_MP_URL` if set at build time, else `ws://127.0.0.1:8787/ws` on localhost, else
`wss://mp.leonida-drive.io/ws`.

### Production on a VM (no npm on the VM)

```sh
node server/tools/pack.mjs                       # → server/dist/leonida-mp.tar.gz (≈ 21 MB, includes node_modules)
scp server/dist/leonida-mp.tar.gz vm:/tmp/
# on the VM (Ubuntu 22.04/24.04): Node 22/24 LTS from NodeSource or the official tarball, then
sudo tar -xzf /tmp/leonida-mp.tar.gz -C /opt
sudo useradd --system --home /var/lib/leonida --shell /usr/sbin/nologin leonida
sudo mkdir -p /var/lib/leonida && sudo chown leonida: /var/lib/leonida
sudo cp /opt/leonida-mp/server/deploy/leonida-mp.service /etc/systemd/system/
printf 'IP_HASH_SECRET=%s\n' "$(openssl rand -hex 32)" | sudo tee /etc/leonida-mp.env >/dev/null && sudo chmod 600 /etc/leonida-mp.env  # once
sudo systemctl daemon-reload && sudo systemctl enable --now leonida-mp
curl -s http://127.0.0.1:8787/health        # {"ok":true,"online":…,"tick_ms":…}
journalctl -u leonida-mp -f                 # first line: "listening on 127.0.0.1:8787 (N gateway threads + hub + db thread, uws, 20 Hz …)"
```

Manual start (same thing without systemd):

```sh
cd /opt/leonida-mp/server
NODE_ENV=production PORT=8787 HOST=127.0.0.1 DB_PATH=/var/lib/leonida/leonida.db \
ALLOWED_ORIGINS=https://leonida-drive.io,https://www.leonida-drive.io TRUST_PROXY=1 \
MAX_CONN_PER_IP=32 CONN_RATE_PER_IP=120 node src/main.js
```

Docker (build context = repository root): `docker build -f server/Dockerfile -t leonida-mp .` and see the run line at the
top of `server/Dockerfile` (volume `/data`, health check, non-root, `--stop-timeout 25`). The image is not built in CI yet.

### Reverse proxy

TLS terminates at nginx or Caddy; the server listens on `127.0.0.1:8787`.

- WebSocket path: **`/ws`** (HTTP/1.1 Upgrade). Pass `Origin` through unchanged (the server enforces
  `ALLOWED_ORIGINS`), set `X-Real-IP` (used for per-IP limits when `TRUST_PROXY=1`), read timeout ≥ 60 s (the server
  pings idle sockets every ~30 s), no buffering, no compression (messages are tiny binary frames).
- `/health` (JSON) may be public; `/metrics` (Prometheus) should stay internal or use `METRICS_TOKEN`.
- Examples: `deploy/nginx.conf`, `deploy/Caddyfile`. Raise `worker_connections`/`LimitNOFILE` for ≥ 10k sockets.

### Restart safety and data

- SQLite in WAL mode at `DB_PATH` (one file + `-wal`/`-shm`). Write-behind: dirty sessions are saved every 2 s
  (`FLUSH_MS`), positions every 10 s; purchases, sales, services and nickname changes are saved immediately.
- `SIGTERM`/`SIGINT`: every session is saved, clients get a "server restarting" kick and reconnect with backoff
  (jitter), the DB is checkpointed, then the process exits (hard timeout 15 s; give systemd/Docker ≥ 20 s).
  A crash loses at most the last 2 s of non-purchase progress.
- Players are keyed by SHA-256 of a 256-bit token kept in the browser's localStorage (the raw token is never stored).
- Online backup without stopping: `sqlite3 /var/lib/leonida/leonida.db ".backup '/var/backups/leonida-$(date +%F).db'"`.
  Size ≈ 2–3 KB per player.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | listen address (use `127.0.0.1` behind a proxy) |
| `DB_PATH` | `server/data/leonida.db` | SQLite file (directory is created) |
| `ALLOWED_ORIGINS` | localhost, leonida-drive.io | comma list; `scheme://host:*` = any port; others get 403 |
| `TRUST_PROXY` | `0` | take the client IP from `X-Real-IP` / `X-Forwarded-For` |
| `WORKERS` | `auto` (cores − 2, 1..16) | gateway threads; `0` = single thread |
| `TICK_HZ` | `20` | simulation/broadcast rate |
| `MAX_PLAYERS` | `1000` | players in the world at once; more connections wait in a FIFO queue (see Waiting queue) |
| `QUEUE_MAX` / `ADMIT_GRACE_MS` | `20000` / `15000` | longest queue (then "server full, try later"); time an admitted client has to answer its WELCOME |
| `MAX_SLOTS` | `131072` | slot table size (raised automatically to ≥ (MAX_PLAYERS + 64) × gateway threads) |
| `MAX_CONN_PER_IP` / `CONN_RATE_PER_IP` | `8` / `20` per min | per-IP limits (raise for carrier NAT: 32 / 120) |
| `EGRESS_MBPS` | `0` (off) | pub/sub egress target; above it crowded cells send fewer records (motion stays smooth by dead reckoning). Set to ~70 % of the VM's bandwidth |
| `NEAR_BUDGET` / `FAR_BUDGET` | `16` / `8` | max records per cell (per 20 Hz tick equivalent; streams go out at 10 Hz, far ring 5 Hz) |
| `METRICS_TOKEN` | — | bearer token for `/metrics` |
| `IP_HASH_SECRET` | random per start | key of the daily-rotating IP tags in logs (see Privacy); keep it in a root-only env file |
| `LOG_RETENTION_DAYS` / `STALE_PROFILE_DAYS` | `30` / `180` | security-log rows / profiles that never progressed are deleted after this |
| `WORLD_DATA` | `../public/data` | `world.json` + `height.bin` for terrain/district checks |
| `SPAWN_COOLDOWN_S`, `START_MONEY` | `8`, `5000` | |
| `FLUSH_MS`, `POS_FLUSH_MS` | `2000`, `10000` | write-behind intervals |
| `PRICES_PATH`, `VEHICLES_PATH`, `WARDROBE_PRICES`, `NAME_BLOCKLIST` | repo files | override data files |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `JOIN_ANYWHERE`, `EXTRA_PORTS` | — | **load tests only** |

## Waiting queue (protocol 5)

When `MAX_PLAYERS` are in the world, a new connection gets a place in line after its HELLO instead of joining:

- It keeps only its WebSocket: no slot, no movement history, no world subscription, no INFO, no streams, and it is not
  in the per-tick session sweep. The client sends nothing while waiting (the transport's automatic pings keep proxies
  alive). Measured (`node tools/loadtest/queue-load.mjs --n 10000`, this laptop): 10,000 queued sockets add no
  measurable CPU at rest (the server idles at 2–3 % with or without them; the hub tick dominates) and ≈ 3.3 MB of RSS per 1,000
  (≈ 1.8 MB of it JS heap); 1,000 of them leaving from random places cost 3 % CPU for a few seconds and ≈ 16 bytes of
  position updates per remaining client.
- Positions: monotonic tickets in a shared ring with a Fenwick tree over "still waiting" (`src/queue.js`): a position is
  O(log n), leaving from the middle is O(log n). Gateways refresh positions in slices (each client at most every 4 s)
  and only after someone ahead left or got in: `QUEUE {position, waiting, etaSec, capacity}` (16 bytes) is sent only
  when the position changed.
- Admission (main thread, every tick, O(1) while nothing changes): when a place frees up, the head of the line gets
  `ADMIT` and the normal join on the same socket; it must answer the WELCOME within `ADMIT_GRACE_MS` (the browser
  does so at once, even in a background tab), otherwise the place goes to the next in line. Nobody jumps the line.
- Leaving is final: a closed socket (page refresh, tab closed, "Cancel") loses the place; no reservation, no resume.
  A player whose connection drops mid-game rejoins at the back if the server is full, and keeps playing offline while
  waiting (the join then allows for the distance driven meanwhile).
- Flooding: the per-IP connection limits still apply, and beyond `QUEUE_MAX` a connection gets `KICK.FULL` ("the
  server and its queue are full, try again in a few minutes"; the client retries after 45–75 s).
- `GET /status` → `{"ok":true,"online":…,"queue":…,"capacity":…}` from shared counters (O(1)), `Cache-Control:
  public, max-age=5`, `Access-Control-Allow-Origin` for `ALLOWED_ORIGINS` (the start screen polls it every 10 s).
- Metrics: `leonida_capacity`, `leonida_admitted`, `leonida_queue_length`, `leonida_queue_admitted_total`,
  `leonida_queue_admitted_per_minute`, `leonida_queue_rejected_total`; `/health` has `admitted`, `capacity`, `queue`,
  `admitted_per_min`.
- Smoke test: `MAX_PLAYERS=1 node src/main.js`, then `node ../tools/loadtest/hold-slots.mjs --count 1` takes the only
  place; the next player queues (Ctrl-C the holder to admit them).

## Bandwidth (protocol 4)

Per-player downlink on the wire (payload + WebSocket framing + TLS 1.3/TCP/IP per packet, 74 B), one observer client,
`node tools/loadtest/bandwidth-report.mjs` (bots drive real roads and upload on deviation like the browser):

| Scenario | Protocol 3 | Protocol 4 | Target |
|---|---|---|---|
| typical: 200 players over 4 km | 2,188 B/s (14.3 packets/s) | **686 B/s** (4.7 packets/s) | ≤ 1 KB/s |
| crowd: 60 driving within 300 m | 7,887 B/s (19.8 packets/s) | **5,424 B/s** (10.2 packets/s) | ≤ 8 KB/s |
| idle: 60 parked within 300 m | 3,414 B/s | **199 B/s** | ~0 |
| alone | — | **43 B/s** | ~0 |

How: streams only on even ticks (10 Hz, one TCP write per client per send tick, nothing on quiet ticks), records
judged one send interval ahead with a next-tick path for crash-sized errors, 19-byte motion records with the other
parts only when they change, keyframes every 2 s moving / 20 s parked, no heartbeat (10 s pulse), radar every 2 s with
10-byte entries (standing players every 8 s), board / rank / heatmap on request, world clock computed locally, pings
every 6 s. Uplink on deviation (≈ 12 STATE/s driving, 4/s parked; was 20/s). permessage-deflate stays off: with
context takeover it would save 14–18 % of the payload at ≈ 5 ms CPU per second per crowded client
(`tools/loadtest/deflate-measure.mjs`). Smoothness (mean of 8 seeded runs, `node tools/smoothness-report.mjs`): p99
position error 0.105 m clean (0.115 before), no snaps or teleports on a clean or TCP-lossy network; remote cars are
rendered ≈ 30 ms further behind (173 vs 145 ms) because samples arrive less often.

## Capacity (measured on an Apple M-series laptop shared with other work; Linux numbers will differ)

Real sockets, `tools/loadtest/bots.js` (bots drive real roads, upload on deviation, decode headers), 2 gateway threads,
protocol 4 (protocol 3 in brackets):

| Load | Server CPU (all threads) | RSS | Hub tick (mean / p99) | Downlink payload per client | Total egress |
|---|---|---|---|---|---|
| 1,000 spread over the map | 0.25 core (0.4) | 188 MB | 1.0 / 5 ms | 1.8 KB/s, 34 msgs/s (2.5 KB/s, 50) | ≈ 15 Mbit/s |
| 1,000 in one 1.2 km circle (worst case) | 0.25 core (0.5) | 197 MB | 1.0 / 3 ms | 28 KB/s, 120 msgs/s in ≤ 10 packets/s (36 KB/s, 210) | ≈ 230 Mbit/s |
| 3,000 spread (protocol 3) | 1.2 cores | 260 MB | 2 / 6 ms | 5 KB/s, 90 msgs/s | ≈ 120 Mbit/s |

In an extreme blob (≈ 130 players within 200 m, 230 more within 320 m) the traffic is real demand — every visible
car moving unpredictably — so it scales with the crowd; `EGRESS_MBPS` caps the total by lowering per-cell budgets.

Beyond ~4–5k sockets the bot processes and the macOS loopback stack on this shared laptop saturate first (server
threads stayed at ~30 % each), so higher real-socket numbers need a separate load generator machine. In-process hub
benchmark (`npm run bench`, single hub thread): 10k players 3.7 ms/tick, 100k players 28–35 ms/tick mean (of 50 ms);
decode + validate + shared-memory write per STATE ≈ 0.6 µs; ≈ 12 KB per session.

**Sizing guide** (dedicated vCPUs; extrapolated from the table: ≈ 0.4 vCPU and ≈ 35 MB per 1,000 players on top of
≈ 150 MB base; most CPU is kernel send time):

| CCU | VM | Server env | Egress (spread → crowded) |
|---|---|---|---|
| ~1,000 | 2 vCPU, 2 GB RAM, 15 GB SSD | `WORKERS=1` | 20–60 Mbit/s typical, up to ~300 Mbit/s if everyone crowds one spot |
| ~10,000 | 8 vCPU, 8 GB RAM, 20 GB SSD | `WORKERS=6` | 0.2–0.6 Gbit/s typical; cap with `EGRESS_MBPS` |

Bandwidth, not CPU, is the limit: per-client downlink grows with how many players are in view (crowds), and egress is
usually billed per GB (1,000 CCU at 0.7 KB/s ≈ 2.5 GB per hour; at 5 KB/s ≈ 18 GB). `EGRESS_MBPS` bounds it. Beyond one VM: shard by region
(separate processes per map area + shared DB/leaderboard).

## Security model

- Server-authoritative economy: clients send claims; the server recomputes or clamps every amount from what it observed
  (trajectory history, speeds, airborne arcs, positions) with per-reason cooldowns, a combo bound and a global token
  bucket ($6,000/min, burst $20,000). Purchases/services/wardrobe/nicknames are priced from the shared tables
  (`src/economy/rules.js`, `prices.json`, `wardrobe-prices.json`); rejected requests are never charged.
- Movement validation per class (speed budget, climb, altitude, teleports only with a server reason), corrections,
  suspicion score → earnings frozen (expiring) → kick. Ownership checks on every model change.
- Combat: weapon must match the server-approved vehicle, 3 s reload on both client stamps and receive times, muzzle
  within 10 m of the server-known position, barrel within 0.45 rad of the replicated turret; hits are resolved on the
  server against oriented boxes; destroyed vehicles must burn / be left within 3 s (else suspicion). The free path to
  static geometry is client-reported (a cheater could claim a longer path through buildings; terrain is always checked).
- Nicknames: generated (codes) or custom (`[A-Za-z0-9_-]`, 3–16, blocklist with leetspeak normalisation in
  `data/name-blocklist.txt`, no impersonation of generated names, case-insensitive unique index, 1 change / 10 min);
  names travel as ASCII bytes and are rendered as text only.
- Visual state (`C_VIS`): a wreck seed only from a tank (once per 5 s), damage bytes ≤ 40 and ≤ 3 updates per second
  from a vehicle, both cleared on a vehicle change or a reused slot; clients only ever use them for visuals.
- Transport: Origin allowlist, per-IP connection count and rate, 512-byte max client message, exact-size decoding,
  message rate limit (50/s, burst 70) with flood kick, backpressure-aware interest shedding, idle timeout.

## Privacy

- Client IPs exist only in memory (per-IP connection limits). Logs and the security log get the network instead
  (IPv4 /24, IPv6 /48) plus a 10-hex tag `HMAC-SHA256(daily key, ip)`, daily key `= HMAC(IP_HASH_SECRET, UTC date)`:
  the same address correlates within a day, never across days, and cannot be recomputed without the secret
  (`src/privacy.js`). Example: `[security] freeze net=203.0.113.0/24 ipk=1a2b3c4d5e id=… speed …`.
- Stored per player: token hash (SHA-256; the raw token never touches the disk or the logs), nickname, progress
  (money, vehicles, wardrobe, position). No addresses, e-mails or other identifiers.
- Retention (hourly and at start): security-log rows after 30 days; profiles unused for 180 days that never earned
  anything, have no custom name and no flag. The reverse-proxy configs keep no access log (`deploy/nginx.conf`:
  `access_log off`; `deploy/Caddyfile`: no `log` directive, a masked example is in the comment).
- Tests: `test/privacy.test.js` (masking, tags, no full IP or token in stdout / the security log, retention).

## Tools

- `node tools/gen-vehicles.mjs` — regenerate `data/vehicles.json` after a catalog change (stable model indices).
- `npm run bench -- 100000 300 --dist=roads --egress=10000` — in-process hub benchmark.
- `node ../tools/loadtest/bots.js --url ws://127.0.0.1:8787/ws --count 1000 --procs 2 --radius 7000 --duration 60` —
  real-socket load test (start the server with `JOIN_ANYWHERE=1 MAX_PLAYERS=100000 MAX_CONN_PER_IP=100000 CONN_RATE_PER_IP=100000000`,
  and `EXTRA_PORTS=8788,8789` + `--ports` above ~16k sockets from one host).
- `node tools/pack.mjs` — VM bundle (see above).
- `node tools/smoothness-report.mjs` — remote-car smoothness on the real hub + client store (8 seeds per scenario).
- `node ../tools/loadtest/queue-load.mjs --n 10000 [--workers 0]` — what queued players cost (CPU, memory, churn);
  `node ../tools/loadtest/hold-slots.mjs --count N` — occupy N places to force a queue in a smoke test.
- `node ../tools/loadtest/bandwidth-report.mjs [--dump dir]` — per-player downlink on the wire (typical / crowd /
  idle / empty); `node ../tools/loadtest/deflate-measure.mjs dir/crowd.bin` — what permessage-deflate would save.
