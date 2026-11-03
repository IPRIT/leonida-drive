# Economy (workstream L): integration

The design is in `docs/ECONOMY.md`. This file covers what to import, how to register it, the APIs, and the patches
other workstreams need.

## Files

| File | What |
|---|---|
| `src/economy/rules.js` | Every formula, cap, cooldown and constant. Pure, Node-safe: the server imports it too |
| `src/economy/prices.json` | Generated price table `{ id: { price, cls, starter, traffic } }` (139 vehicles, incl. the announced tank) |
| `src/economy/prices.js` | `PRICES`, `STARTERS`, `STARTER_CAR` (`pip`), `STARTER_BIKE` (`kickflip`), `EXPORT_POOL`, `priceOf(id)` |
| `src/economy/Economy.js` | `game.economy`: wallet, garage, combo, progress, save/restore, online reconciliation |
| `src/economy/Jobs.js` | `game.jobs`: delivery contracts, export yards (wanted lists), body shops, markers, contract card |
| `src/economy/places.js` | Depot / yard / body-shop anchors, kerb snapping, delivery drop points. Pure |
| `src/economy/Markers.js` | Instanced ring + beacon markers (2 draw calls, 2 materials made once, no lights) |
| `src/economy/Services.js` | `game.services`: what Service items do to vehicles (underglow, tint, horn, respray, armour, extinguisher, nitro, insurance delivery, wrecked-model garage gate) |
| `src/economy/price-overrides.js` | Economy balance overrides over catalog prices (the tank: $1,500,000) |
| `src/economy/wardrobe-prices.json` | Generated wardrobe table `{ id: { price, slot, tier, dye, starter } }` (provisional: 77 sample items until D ships `wardrobe.js`) |
| `src/economy/JobHud.js` | Contract card (HUD slot `top-center`) and combo timer bar (`top-right-under-money`) |
| `src/economy/i18n.js` | `eco.*` and `score.*` strings (en, ru), registered with `game.i18n.register` |
| `src/economy/index.js` | `createEconomy(game)`, `economyModule(game)` |
| `src/world/Spawns.js` | `game.spawns`: 120 Ocean Beach kerb slots and 6 hospitals. `buildKerbSlots` is pure |
| `src/world/Score.js` | Drift / near-miss / stunt payouts through the economy, with the combo |
| `lab-economy.html` + `src/economy/lab-economy.js` | Lab: real game plus a debug panel (`?basic`, `?fresh`, `?noTraffic`, `?peds`) |
| `tools/economy/build-prices.mjs` | Regenerates `prices.json` from the catalogs (`--check` for CI) |
| `tools/economy/build-wardrobe-prices.mjs` | Regenerates `wardrobe-prices.json` from D's `src/characters/wardrobe.js` (fallback: `wardrobe-sample.mjs`) |
| `tools/economy/simulate.mjs` | Balance simulation (`--md`, `--no-activities`, `--runs`, `--hours`, `--profile`) |
| `tools/economy/test-economy.mjs` | 29 headless checks: rules, table coverage, wallet, combo, save, online and offline flows, services, wardrobe, nickname, slots, places |

Commands:

```sh
node tools/economy/test-economy.mjs        # all green
node tools/economy/build-prices.mjs        # after any catalog change (A/B add vehicles!)
node tools/economy/build-prices.mjs --check
node tools/economy/build-wardrobe-prices.mjs   # after D changes src/characters/wardrobe.js
node tools/economy/simulate.mjs --md
```

## Integrator: wiring

### 1. `src/core/bootstrap.js`

Create the economy before the player, so the start slot and the start vehicle come from it. This replaces
`randomSpawnNear` and the hard-coded `'comet'`. Then create the jobs after Score.

```diff
+import { createEconomy, economyModule } from '../economy/index.js';
 …
     // ---------- player ----------
-    // spawn: Ocean Beach, a random kerb-side point (never everyone on one spot)
-    const s = options.spawn || randomSpawnNear(1728, -733, 420);
-    const sp = roadSpawn(game, s.x, s.z);
+    // economy + spawn slots: everyone starts in Ocean Beach at a random free kerb slot (singleplayer: the saved
+    // position), in the starter car or the last owned land vehicle (docs/ECONOMY.md → Spawning)
+    const { plan } = createEconomy(game);
+    const sp = options.spawn ? roadSpawn(game, options.spawn.x, options.spawn.z) : plan.pos || roadSpawn(game, 1728, -733);
     const makePlayer = options.createPlayer || (options.basicPlayer ? (g, p) => new BasicPlayer(g, p) : (g, p) => new PlayerController(g, p));
     game.player = makePlayer(game, sp);
     game.register(game.player, 0);
-    const first = game.vehicles.spawn(options.vehicle || 'comet', sp, sp.yaw, { color: 0xff3a8c });
+    const first = game.vehicles.spawn(options.vehicle || plan.vehicle, sp, sp.yaw, {});
     game.player.enter(first);
 …
     game.score = game.register(new Score(game), 60);
+    economyModule(game); // game.jobs (depots, yards, body shops) + game.services (after game.damage exists)
```

`randomSpawnNear` can then be deleted. `createEconomy` needs `roads`, `terrain`, `worldData`, `vehicles` and `events`;
all of them exist at that point. The economy registers itself (order 58, before Score at 60), and Jobs uses order 62.

Without this patch, `createGame(…, { modules: [economyModule] })` also works, which is what the lab does. In that case
the module moves the already spawned player to the planned slot and vehicle right after boot.

### 2. `src/core/BasicPlayer.js` (the fallback player)

Route income through the economy, emit the granted amount, and respawn at a hospital for the fee:

```diff
   addMoney(n, pos, reason = 'other') {
-    const net = this.game.net;
-    if (net?.claim) net.claim(reason, n, pos); // online: server-authoritative wallet sets this.money
-    else this.money += n;
-    this.game.events.emit('money:pickup', { amount: n, position: pos, reason });
+    n = Math.round(n);
+    if (!(n > 0)) return 0;
+    const g = this.game;
+    const p = pos ? { x: pos.x, y: pos.y, z: pos.z } : { x: this.focus.x, y: this.focus.y, z: this.focus.z };
+    let got = n;
+    if (g.economy?.earn) got = g.economy.earn(reason, n, p); // caps/cooldowns; online it claims from the server
+    else if (g.net?.claim) g.net.claim(reason, n, p);
+    else this.money += n;
+    if (got > 0) g.events.emit('money:pickup', { amount: got, position: p, reason });
+    return got;
   }
```

```diff
       if (this.wastedT <= 0) {
-        const s = this.lastSafe || this.spawnPoint;
-        const sp = roadSpawn(game, s.x, s.z);
+        // nearest hospital (random free kerb slot around it) and the hospital bill
+        const s = this.lastSafe || this.spawnPoint;
+        const sp = game.spawns?.pickSpawn?.('hospital', this.focus) || roadSpawn(game, s.x, s.z);
+        game.economy?.charge?.('hospital');
         v.reset(new THREE.Vector3(sp.x, sp.y, sp.z), sp.yaw);
```

### 3. Optional `src/world/VehicleManager.js` (cleaner traffic flag)

`Jobs` wraps `traffic.takeOver` once, at runtime, without editing it, and marks the vehicle spawned from that spec as
`v.fromTraffic = true`. If you prefer it explicit:

1. Make `Traffic.takeOver` return `fromTraffic: true` in its spec.
2. Make `VehicleManager.spawn` set `v.fromTraffic = !!opts.fromTraffic`.
3. Have D pass `{ color: spec.color, fromTraffic: true }`.

The wrapper stays harmless after that.

### 4. Build and CI

- `vite.config.js` `rollupOptions.input`: add `economy: resolve(import.meta.dirname, 'lab-economy.html')` if the lab
  should be built. Checked: a production build of the lab bundles `prices.json`; the `with { type: 'json' }` import
  works in Vite 8.
- CI: run `node tools/economy/build-prices.mjs --check
node tools/economy/build-wardrobe-prices.mjs   # after D changes src/characters/wardrobe.js` and `node tools/economy/test-economy.mjs`. The vehicle catalog
  grew from 126 to 127 entries while this was being written (`ambulance`). The test catches a stale table.

## `game.economy` API (for G, J, I, D)

Reading:

| Member | |
|---|---|
| `money` | Integer cash. Online: the last server balance + pending optimistic income. Also mirrored into `player.money` |
| `owns(id)`, `isStarter(id)`, `starters` (Set), `owned` (Set), `ownedList()` | Ownership. With sandbox "unlock all", `owns()` is true for every id |
| `price(id)` → number \| null, `priceClass(id)` | From the shared table (catalog fallback for ids added after it was generated) |
| `sellPrice(id)` | What SELL pays now: 55% × the condition of the car you drive if it is that model, else 55%. 0 for starters |
| `netWorth()` | Cash + 55% of owned vehicle prices (server value online) |
| `combo`, `comboTimeLeft` | Current multiplier (1..5) and seconds left in the 6 s window |
| `remote`, `synced`, `sandbox` | Online authority? Server state received? Sandbox controls allowed (`can('money')`, not remote)? |
| `found`, `medals`, `districts`, `stunts`, `traps`, `daily`, `stats` | Progress: collectibles, trial medals (bitmask 1 gold / 2 silver / 4 bronze), visited district names, stunt spots, speed-trap bests, `{ last, streak }`, `{ earned, spent, by, playS }` |
| `onChange(cb)` → off | `cb(economy, { money, delta, reason })` on every wallet / ownership change |
| `cooldownLeft(reason)`, `exportCooldownLeft(id)`, `repairCost(vehicle)` | |

Writing (all promises resolve, they never reject):

| Method | |
|---|---|
| `buy(id)` → `{ ok, reason?, price? }` | Reasons: `unknown`, `owned`, `funds`, `syncing`, `offline`, `rate`, `frozen`, `timeout` |
| `sell(id)` → `{ ok, reason?, price? }` | Reasons: `starter`, `notOwned`, `unlocked`, … |
| `repair(vehicle)` → `{ ok, cost?, reason? }` | Owned models only; calls `vehicle.damage.repair()`. Reasons: `undamaged`, `funds`, `notOwned` |
| `paint(kind = 'color' \| 'pearl' \| 'metallic')` → `{ ok, cost? }` | $500 / $2,500; the caller applies the colour |
| `earn(reason, amount, pos?, meta?)` → granted amount | Applies the `rules.REASONS` cap, cooldown and per-minute limit. Does **not** emit `money:pickup`: callers that want the +$ pop emit it with the returned amount |
| `skill(reason, base, pos?, meta?)` | Skill event: raises the combo, then pays `base × combo` |
| `bump()`, `earnSkill(reason, base, …)`, `holdCombo()`, `resetCombo(why)` | Combo pieces (Score uses them) |
| `charge(reason, amount?)` → charged | `'hospital'` computes the fee itself (3%, $50..$2,500) |
| `collect(id, pos)` | Postcard: $1,000, +$10k every 10th, +$100k for all 60 |
| `medal(trial, 'gold' \| 'silver' \| 'bronze', purse, pos, timeS)` | First medal of a tier pays in full, repeats 20% |
| `speedTrap(trap, kmh, pos)` | Skill event, ×2 on a personal best |
| `firstAtStunt(spot)`, `markStunt(spot)` | Named stunt spots (×5 the first time) |
| `grant(amount, reason = 'sandbox')`, `setUnlockAll(bool)`, `unlockAll` | Singleplayer control panel only (no-ops online). `grant` does not emit `money:pickup` (G's Player tab does) |
| `startPlan()` → `{ pos: {x,y,z,yaw}, vehicle, restored }` | Start slot / saved position and the vehicle to start in |
| `applyServer(state)` | For J: see below |
| `save()`, `saveSoon(now?)`, `wipe()`, `toJSON()`, `restore(obj)` | Persistence (`localStorage['leonida.save.single']`) |

`game.jobs`:
- `blips()` → `[{ x, z, color, kind: 'depot' | 'yard' | 'shop' | 'dest', label }]`, cached;
- `wanted()` → per-yard wanted model ids;
- `exportQuote(vehicle, yard?)` → `{ pay, condition, wanted, wantedYard, blocked, waitS }`;
- `cancel()`, `job` (the active contract or null), `depots`, `yards`, `shops`.

`game.spawns`:
- `pickSpawn('start' | 'hospital', near?)` → `{ x, y, z, yaw, name, kind, hospital? }`;
- `nearestHospital(x, z)`, `snapToRoad(x, z)`;
- `start` (120 slots), `hospitals` (each with `slots`).

## Services (shop "Service" tab): G (UI), J (server), A/E (vehicle hooks)

Prices and rules are in `rules.SERVICES` and `rules.servicePrice(id, ctx)` (pure; the server uses the same function).
Final prices:

| id | Price | Kind |
|---|---|---|
| `repair` | `ceil(damage × price × 1.2%)`, min $100, starters free | the vehicle you drive (owned) |
| `extinguisher` | $1,500, max 2 carried | item |
| `armor` | $6,000 | per owned vehicle, until the next repair; not tanks |
| `insurance` | $9,000 per 24 real hours | pass (extends) |
| `claim` | $1,000 (free when insured or a starter) | replacement of a destroyed owned model |
| `nitro` | $400 | the vehicle you drive |
| `neon` | $5,000 | cosmetic per owned vehicle; 8 colours, recolour free |
| `tint` | $1,200 | cosmetic per owned vehicle |
| `horn` | $2,500 | cosmetic per owned vehicle (`variant`) |
| `respray` | $500, metallic/pearl $2,500 | cosmetic per owned vehicle (`color` hex, `finish`) |

### `game.economy` service API (for G)

| Member | |
|---|---|
| `services` | `[{ id, kind, price, max?, durationS?, premium? }]` (catalogue for the tab) |
| `serviceQuote(id, vehicleId?, opts?)` → `{ ok, price, reason? }` | Use it to render price / disabled state. `vehicleId` defaults to the vehicle you drive |
| `buyService(id, vehicleId?, opts?)` → `Promise<{ ok, cost?, reason? }>` | Never rejects |
| `inventory` | `{ extinguisher, insuranceUntil }` (epoch ms) |
| `insured`, `insuranceLeftS()` | Insurance state |
| `custom(vehicleId)` | `{ neonKit, neon (0..7 \| null), tint, horn, paint, finish, armor }` or null |
| `setNeon(vehicleId, colorIndex \| null)` | Free recolour / off after buying the kit |
| `useExtinguisher()` → bool | For a key (please bind one; D or G). Auto-use runs unless `game.settings.autoExtinguish === false` |
| `isWrecked(id)`, `spawnCheck(id)` → `{ ok, fee, reason? }` | The garage should show "Replace ($1,000)" when `fee > 0` |

`opts` per id:
- `neon`: `{ color: 0..7 }`;
- `horn`: `{ variant: rules.HORN_VARIANTS[i] }`;
- `respray`: `{ color: 0xRRGGBB, finish: 'color' | 'metallic' | 'pearl' }`.

Reasons: `funds`, `notOwned`, `noVehicle`, `undamaged`, `max`, `excluded`, `installed`, `noNitro`, `full`, `variant`,
`color`, `finish`, `syncing`, `offline`, `rejected`.

Strings: `eco.svc.<id>`, `eco.svcDesc.<id>`, `eco.reason.<reason>`, `eco.neon.<name>` (`rules.NEON_NAMES`),
`eco.finish.<finish>`, `eco.wrecked`, `eco.insured`, `eco.garage`, `eco.claimTitle`, `eco.claimFunds`,
`eco.extinguished`, `eco.extLeft`. en and ru are done.

Events: `economy:service { id, vehicleId, cost, opts }`, `economy:extinguish { vehicle, left }`,
`vehicle:extinguished { vehicle }`.

The economy wraps `game.spawnForPlayer`:
- a wrecked model's garage call charges the claim, or returns **null** with a toast if you can't pay. G: handle a null
  return (don't show "spawned");
- `opts.color` defaults to the model's respray colour.

`v.armored` is true on plated cars (a HUD shield icon would be nice). The HUD could also show the extinguisher count and
the insurance time left.

### J: server validation and persistence

Add one op, e.g. `C_ECON op SERVICE` with a service code (`rules.SERVICE_IDS` index), model index and a param:
- neon colour 0..7;
- horn variant index into `rules.HORN_VARIANTS`;
- respray: colour in 3 bytes + finish index — this needs a wider message, or a separate `PAINT2` op.

The client calls these on `game.net`:

```js
game.net.service(id, vehicleId, opts)  // → Promise<{ ok, reason?, money, cost?, inventory?, custom? }>
game.net.useItem('extinguisher')       // the server decrements inventory.extinguisher
game.net.setCosmetic(vehicleId, patch) // free changes only: { neon: 0..7 | null } (needs neonKit), { armor: false }
// push: game.economy.applyServer({ inventory: { extinguisher, insuranceUntil }, custom: { [id]: {…} } })
```

Server rules (all in `rules.servicePrice` with `ctx = { price, cls, kind, starter, owned, insured, extinguishers,
damage, custom, opts }`):
- `repair` keeps the existing `ECON.REPAIR` op;
- cosmetics, armour and claims require ownership;
- `extinguisher`: at most 2;
- `armor`: refused for `cls === 'military'`, and when already installed;
- `insurance`: `insuranceUntil = max(now, insuranceUntil) + 24 h` (server clock);
- `claim`: free while insured or for starters.

Persist `inventory` and `custom` per player. Clear `custom[id].armor` on `ECON.REPAIR` of that model and on
`setCosmetic({ armor: false })`. The client sends that for repairs the server doesn't see: respawn repair, destruction.
The client tracks "wrecked" itself; skipping the $1,000 claim only skips a sink.

### A and E: vehicle hooks (implemented now with fallbacks; native versions are welcome)

**A (`Vehicle`):** used now:
- `v.setColor(hex)`;
- `v.hornType` (read by C's `hornTypeFor`);
- `v.physics.boostLevel` / `boostCooldown`;
- `v.materials.glass` / `.paint`;
- `v.dims`, `v.spec.wheelRadius`.

Wanted:
- `v.setWindowTint(0..1)`;
- `v.setPaintFinish('color' | 'metallic' | 'pearl')`;
- `v.refillBoost()`;
- a `boostLevel` getter.

Until then the economy changes the glass and paint uniforms itself (no material creation).

**E (`VehicleDamage` / `DamageSystem`):**
- `game.damage.extinguish(v)` → bool. The fallback sets `state = 'ok'`, `engine = max(engine, 0.3)` and kills the fire
  handles via `_killFx`.
- `damage.damageScale` (0..1) applied in `applyImpact` and explosions, with `supportsDamageScale = true`. The fallback
  wraps `applyImpact` per instance (×0.7) and `repair` (to end the plating).
- `game.damage.rebase(v, material)`, so `repair()` restores the customised look. The fallback updates `damage.mats`.

**Underglow is done by L:** one InstancedMesh of soft additive ellipses under the cars, one material, max 16, matrices
follow `object3d.matrixWorld`, brighter at night, hidden when destroyed or submerged. No lights.

**C:** horn variants are `rules.HORN_VARIANTS` (= your `HORNS` keys). Tell me if you add or rename any.

## Wardrobe and nickname: D (catalogue, looks), G (UI), J (server)

Rules are in `rules.WARDROBE`, `wardrobePrice(item)`, `dyePrice(price)`, `NICK` and `nickPrice(mode, rerolls)`. Prices are
in docs/ECONOMY.md → Wardrobe and nickname.

### D: the catalogue

Please export plain data (Node-safe, no three.js) from `src/characters/wardrobe.js`:

```js
export const WARDROBE = [
  { id: 'top_hawaii', slot: 'top', tier: 'street', name: 'Hawaiian shirt', value: 0.4 },  // value 0..1 inside the tier
  { id: 'tat_sleeve', slot: 'tattoo', tier: 'premium', name: 'Full sleeve', size: 0.85 }, // tattoos: size 0..1
  { id: 'top_tshirt', slot: 'top', tier: 'basic', name: 'Plain tee', starter: true },      // free, owned from the start
  // optional: price (explicit override), colors / dyeable for the UI
];
```

- **Slots:** `hair`, `facial`, `top`, `legs`, `shoes`, `hat`, `glasses`, `accessory`, `tattoo`, `body` (body = surgeon,
  $15k).
- **Tiers:** `basic`, `street`, `premium`, `luxury`.
- After any change, run `node tools/economy/build-wardrobe-prices.mjs`.
- At runtime, set `game.wardrobe = { items, byId }`. Ids missing from the table are then priced live.
- Dress the player from `game.economy.outfit` (`{ slot: itemId, colors: { itemId: hex } }`) at start, and on the event
  `economy:outfit { outfit }`.
- Remote players get their outfit from J (avatar look).
- The provisional ids in `tools/economy/wardrobe-sample.mjs` follow `looks.js` (hair styles, tops, bottoms,
  accessories, tattoos). Reuse them where they fit.

### G: the shop and wardrobe UI

| Member | |
|---|---|
| `wardrobePrice(id)`, `wardrobeDyePrice(id)`, `wardrobeEntry(id)` → `{ price, slot, tier, dye, starter }` | |
| `ownedWardrobe` (Set), `ownsWardrobe(id)`, `wardrobeColor(id)` | |
| `buyWardrobe(itemId, colour)` → `Promise<{ ok, cost?, dyed?, reason? }>` | A different colour for an owned item is a re-dye (15%) |
| `dyeWardrobe(itemId, colour)` | Same as above |
| `setOutfit({ slot: itemId \| null })` → `{ ok, reason? }` | Free, persisted; emits `economy:outfit` |
| `outfit` | `{ slot: itemId, colors }` |
| `nickname`, `nickPrice('reroll' \| 'custom')` | The first reroll of a profile is free, then $2,500; custom $50,000 |
| `changeNick({ mode: 'reroll' \| 'custom', value })` → `Promise<{ ok, nick?, cost?, reason? }>` | |

Reasons:
- purchases: `unknown`, `owned`, `funds`, `notOwned`, `slot`, `syncing`, `offline`;
- nickname: `format`, `short`, `long`, `chars`, `generated` (client checks with J's `nameFormatError` and
  `looksGenerated`), plus server reasons `taken` and `blocked`.

Events:
- `economy:wardrobe { id, cost, color, dyed }`;
- `economy:outfit { outfit }`;
- `economy:nick { nick, mode, cost }`.

### J: server

```js
game.net.wardrobe(itemId, colour, 'buy' | 'dye') // → Promise<{ ok, reason?, money }>
game.net.setOutfit({ slot: itemId })             // ownership check, broadcast to others (avatar look)
game.net.changeNick('reroll' | 'custom', value)  // → Promise<{ ok, reason?, money, nick, code? }>
// push: game.economy.applyServer({ wardrobe: { id: colour }, outfit: { slot: id }, nick: { code, name, custom, rerolls } })
```

- Prices come from `src/economy/wardrobe-prices.json` (`price`, `dye`; starter items are free and always owned).
- Persist wardrobe (`id → colour`), outfit and `nick.rerolls`.
- Your `C_REROLL` is free today. Charge `rules.nickPrice('reroll', rerolls)`: the first reroll is free, then $2,500.
  Keep the cooldown.
- Custom name: $50,000 after `nameFormatError`, `looksGenerated`, the blocklist and uniqueness. You already have those.
- **Net worth: + 25% of owned wardrobe prices** (`rules.WARDROBE.worth`). It is already in the client's
  `economy.netWorth()`.

## Tank

A's `tank`: **$1,500,000** instead of $1,800,000 (see docs/ECONOMY.md → Balance → The tank). It is applied by
`src/economy/price-overrides.js` and already in `prices.json`, priced as pending until A adds the catalog entry. Expected
entry: category `military`, kind `tank` (G's UI already maps `military`). Armour plating is refused for it.

## Events

Emitted:

| Event | Payload |
|---|---|
| `economy:combo` | `{ combo, t, window, reason? }`: on every change (G's badge listens) |
| `economy:change` | `{ money, delta, reason }` |
| `economy:earn` | `{ reason, amount, requested, position, combo }` |
| `economy:charge` | `{ reason, amount }` |
| `economy:purchase` / `economy:sell` | `{ id, price }` |
| `economy:repair` | `{ id, cost }` |
| `economy:collectible` | `{ id, count, total, paid }` |
| `economy:discovered` | `{ name, paid, count }` |
| `economy:daily` | `{ amount, streak }` |
| `job:start` | `{ type: 'delivery', id, depot, from, to: { x, z, name }, routeM, timeLimit, maxPay, vehicle, factor }` |
| `job:complete` | `{ type, id, paid, pay, timeS, timeBonus, condition, routeM, depot }` |
| `job:fail` | `{ type, id, reason: late \| destroyed \| abandoned \| lost \| wasted \| cancelled, depot }` |
| `export:complete` | `{ id, paid, yard, wanted, condition }` |

Score, Jobs, district discovery and daily payouts also emit `money:pickup { amount, position, reason }` with the
granted amount.

Listened: `impact` (combo reset when your own vehicle hits at ≥ 25 km/h), `vehicle:enter`, `vehicle:spawn`,
`vehicle:destroyed`, `wasted`, `start`.

## J: multiplayer

`src/net/NetEconomy.js` already implements the interface the economy needs, and the meta field names now match it:
- drift: `duration`, `kmh`;
- stunt: `air`, `height`, `spot` (undefined when there is none);
- delivery: `from: { x, z }`, `length`, `time`, `condition`;
- export: `model`, `condition`;
- firstvisit: `district` (index in `world.json`);
- `combo` on skill claims.

The economy counts as `remote` when `mode === 'online'`, `game.net` exists, and the client was online at least once
(or is still connecting). If the server was unreachable from the start (`net.offlineRestored`), it plays on the local
offline wallet.

Server changes to match `rules.js`. The best fix is to import `src/economy/rules.js` in `server/src/economy.js` instead
of hard-coding numbers; the import path works like `../../src/net/shared/constants.js`.

1. **Payout formulas changed after the simulation** (docs/ECONOMY.md → Refinements):

   | Reason | Old | New (`rules.js`) |
   |---|---|---|
   | Drift | `/ 9` | `/ 3.6` (`DRIFT.divisor`) |
   | Near miss | `25 + 0.25·kmh` | `60 + 0.6·kmh` (`NEARMISS.base/perKmh`) |
   | Stunt | `70·air + 18·h` | `160·air + 40·h` |
   | Delivery | `(250 + 0.45·len·f)` | `(500 + 0.9·len·f)` (`DELIVERY.base/perM`); the time-bonus formula is unchanged |
   | Export | 2.5%, min $400 | 4%, min $600, max $25,000 |
   | Daily | `5000·streak` | `3000 + 1000·streak` (`dailyPay`) |
   | Hospital | 5% / max $5,000 | 3% / max $2,500 (`hospitalFee`) |

   Caps: near miss $1,200 per claim, delivery $15,000 (`REASONS`).
2. **Near-miss bundles**: Score sends one claim for up to 3 near misses that fell inside the 1.5 s cooldown. Encode
   `meta.count` (e.g. into `tier`) and accept `(60 + 0.6·kmh) × combo × min(count, 3)` (`rules.nearMissPay`).
3. **Export**:
   - reject models the player owns (`this.owned.has(id)`): the server can't tell a carjacked car from a garage car;
   - apply the ×2 wanted bonus when `rules.exportWanted(Date.now(), yard, exportPool(prices))` lists the model
     (`meta.yard` = yard index 0..2, `meta.wanted`);
   - apply the $25,000 cap.
4. **First visit**: accept every `world.json` district entry, types `'d'` and `'a'` (52 unique names, $26k total).
   Today only `'d'` is paid. The client sends the index of the first entry with that name.
5. Optional: validate delivery origins against `src/economy/places.js` `DEPOTS` (snapped with `snapToKerb` on
   `edgesFromJSON(roads.json)` from `src/world/Spawns.js`), and spawn slots with `buildSpawnSets`. Both are pure and
   Node-safe.
6. `applyServer({ combo })` is ignored by the client (no flicker from in-flight claims). Keep bounding the combo on the
   server.

## D: characters

`PlayerController` already routes `addMoney` to `economy.earn`, respawns at `spawns.pickSpawn('hospital')`, and charges
`economy.charge('hospital')`. Two small requests:

1. In `addMoney`, emit `money:pickup` with the **granted** amount: `const got = g.economy.earn(…)`, and emit only if
   `got > 0`. Pickups over $300/min are capped, and the +$ pop shouldn't show money you didn't get.
2. Dying in a working vehicle currently respawns at the last safe road point with no fee. docs/ECONOMY.md says every
   wasted goes to the nearest hospital and costs the fee. Please either use the hospital branch for both cases, or at
   least call `g.economy?.charge?.('hospital')` in the vehicle branch too.

Export yards call `player.exit({ instant: true })` (below 18 km/h, so no bail-out roll) and despawn the car 1.2 s later.

## I: world activities (speed traps, races, collectibles, stunt spots)

Use the economy; it handles caps, combo, persistence and the server:

```js
game.economy.speedTrap(trapId, kmh, pos);                         // skill event, ×2 on a personal best
game.economy.medal(trialId, 'gold', rules.racePurse(lengthM), pos, timeS);
game.economy.collect(postcardId, pos);                            // ids 0..59
// stunt spots: expose game.stunts = { spotAt(x, z) → { id, name } | null }; Score pays ×5 on the first landing
```

All of them return the amount paid. Emit `money:pickup` yourself if you want the pop (Score already does for stunts).

**Online income multiplier (`rules.ONLINE.mult` = 2):** online, `economy.earn` pays the base formula × the multiplier,
so the returned amounts are already scaled. Labels that show a payout *before* it is earned must multiply by
`game.economy.incomeScale(reason)`, which is 1 in singleplayer. Still unscaled:
- the race "Prize" in the list (`src/life/Races.js:171`) and the `purse` in `race:start` / `race:finish`: use
  `money(g, this.purse(r) * (g.economy?.incomeScale?.('race') ?? 1))`;
- the collectible set-bonus toast (`src/life/Collectibles.js:166`, `collectiblePay(n) - each`): multiply by
  `incomeScale('collectible')`, or take the bonus as the returned `paid` minus the scaled `each`;
- the loading tip amount (`src/ui/Loading.js:94`, `COLLECTIBLES.each`): it shows the singleplayer $1,000.

The delivery offer ("up to …") and the export hints in `Jobs.js` already apply the multiplier.

## G: UI

- **Garage**: already matches (`money`, `owns`, `price`, `isStarter`, `sellPrice`, `buy`, `sell`, `onChange`,
  `grant`, `setUnlockAll` / `unlockAll`). Checked in the lab: prices on cards, BUY / SELL $25,300 for the Shiden.
- **Combo**: your `#combo` badge is used; L only adds a thin draining timer bar under the money (slot
  `top-right-under-money`). Without `hud.setCombo`, the bar also shows `×N`.
- **Contract card**: mounted in the `top-center` slot. It hides with the HUD.
- **Radar / map icons** (with H): merge `game.jobs?.blips?.()` (cached array, changes on job start/end) into the radar
  blips and the big map. Colours: depot gold, yard pink, shop teal, destination green.
- **Nice to have**:
  - "Cancel contract" (`game.jobs.cancel()`) when `game.jobs.job` is set;
  - online Player tab: "Repair ($X)" via `economy.repairCost(v)` / `economy.repair(v)`;
  - custom paint via `economy.paint('color' | 'metallic')`;
  - a Stats row for `economy.stats.by`.
- **i18n**: namespaces `eco` and `score` are registered (en + ru) from `src/economy/i18n.js`. Please add the other 28
  languages under the same keys:
  - `score.*`: `drift stunt stuntSpot near nearN chainLost`;
  - `eco.*`:
    - general: `newArea daily km m comboLost`;
    - delivery: `delivery contract upTo to delivered deliveredSub failed`;
    - failure reasons: `fail.late fail.destroyed fail.abandoned fail.lost fail.wasted fail.cancelled`;
    - depot: `depot depotNeedVehicle depotLandOnly depotBusy depotNone depotStop searching`;
    - export: `exportYard exported exportNeedCar exportOwned exportCooldown exportBusy exportWanted exportValue exportValueWanted wantedTag`;
    - body shop: `bodyShop repaired repairFree repairNone repairNotOwned repairFunds repairNeedVehicle`.

## Performance and limits

- Per frame in the lab: economy 0.006 ms, jobs + markers + HUD 0.017 ms, Score 0.003 ms (budget 0.3 ms). No per-frame
  allocations in the update paths: Score reads `player.focus` instead of Rapier `translation()`; the HUD writes DOM only
  on change.
- Start-up: 120 + 6×16 kerb slots ≈ 8 ms; place snapping uses the roads grid index. Delivery drop points (~1,600) are
  built on the first contract (≈ 6 ms). A contract search runs at most one A* route per frame, for up to 8 frames.
- Wanted lists use the client's wall clock. If clocks differ by minutes, the server's list wins at the 20-minute rotation
  boundary.
- Body shops repair owned models only (the server rule). Jacked cars can be exported instead.
- Online, the delivery claim is rejected if it was faster than `length / 75 m/s` (the server's teleport check), so
  testing with teleports pays only in singleplayer.
