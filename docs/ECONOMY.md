# Leonida Drive — game economy

Design goals, in priority order:

1. **Every minute of driving pays a little.** Skill pays a lot. Exploring the map pays the most, once.
2. **There is always a next car to want.** A clear ladder runs from a bubbly city hatch to a business jet, with the
   first upgrade reachable in the first session.
3. **The economy is server-authoritative online.** The client only *claims* income; the server validates, caps and
   grants it. Prices and formulas live in one shared place.
4. **No grind walls, no pay-to-win, no dark patterns.** No real money and no ads. Login rewards stay a small share of
   income, and dying costs a little, never a session.

Single-player uses the same rules. The sandbox control panel (`game.can('money')`) can additionally grant cash and
unlock every vehicle.

**Code:** formulas and caps are in `src/economy/rules.js` (pure, imported by the client *and* the server). Prices are
in `src/economy/prices.json`, generated from the catalogs. The client wallet is `game.economy`
(`src/economy/Economy.js`), the jobs and places are in `src/economy/Jobs.js`, and the skill payouts are in
`src/world/Score.js`. Spawn slots are in `src/world/Spawns.js`. API and integration: `src/economy/INTEGRATION.md`.

## Currency and starting state

- One currency, dollars (`$`), stored as an integer.
- A new player starts with **$5,000** and owns two free vehicles that can't be sold:
  - the **starter compact**, the cheapest compact in the catalog: Palmetto **Pip**, $13,900;
  - a **bicycle**, the cheapest bicycle: Gecko **Kickflip** BMX, $420.
- The first session also pays the day-1 bonus (+$4,000) and the first district (+$500).
- Ownership is per catalog id: one purchase means unlimited spawns of that model.
- The garage's "call vehicle" is free. Online it is rate-limited by the server (8 s cooldown).
- The garage lists only owned vehicles for spawning. Everything else shows its price and a BUY button.

## Prices (sink #1: the vehicle ladder)

The base price is the catalog `price` field. Every current entry has one. If an entry has no price, the class formula
applies: `price = classMin + (classMax − classMin) × tier^1.6`, rounded to a "nice" value (two significant digits,
ending in …900 or …500, e.g. $13,900 / $17,500 / $649,000).

`node tools/economy/build-prices.mjs` writes the shared table `src/economy/prices.json` as
`{ id: { price, cls, starter, traffic } }`, one line per vehicle. Rerun it whenever a catalog changes; add `--check`
in CI. Ids missing from the table still get a catalog price on the client, with a console warning, but the server
rejects them.

The live table (139 vehicles: 138 in the catalogs plus the announced tank) against the class ranges used by the fallback formula:

| Class (`cls`) | n | Cheapest | Dearest | Fallback range |
|---|---:|---|---|---|
| `bicycle` | 4 | Kickflip $420 (starter) | Aero $3,800 | $150 – $1,200 |
| `bike` (motorcycles, scooters) | 6 | Piccola 125 $3,200 | Rattler $31,000 | $800 – $4,000 |
| `compact` (+ microcars) | 16 | Saam $4,500 | Tanuki R $47,000 | $9,000 – $18,000 |
| `standard` (sedan, SUV, pickup, van, coupe, classic, service) | 55 | Jackrabbit $9,000 | Dolce Vita $1,800,000 (collector classic) | $18,000 – $45,000 |
| `sports` (sports, muscle) | 20 | Hachi $30,000 | Orkan TS $231,000 | $45,000 – $150,000 |
| `super` (super, hyper, luxury) | 13 | Presidential $120,000 | Aurora $3,000,000 | $150,000 – $1,500,000 |
| `truck` (trucks, buses) | 13 | Route Van $85,000 | Blaze 7 $650,000 | $40,000 – $160,000 |
| `boat` | 4 | Zipfin JX $16,500 | Sunward 38 $640,000 | $25,000 – $650,000 |
| `heli` | 3 | Vella N2 $650,000 | Mule T2 $3,900,000 | $450,000 – $2,800,000 |
| `plane` | 4 | Pipit 150 $240,000 | Solstice 7 jet $8,500,000 | $280,000 – $6,500,000 |
| `military` | 1 | Tank $1,500,000 (economy override, see Balance) | — | $1,000,000 – $3,000,000 |

The catalog's own prices exceed the old class ranges at the top end (hypercars, heavy lift, the jet). Catalog prices
win; the ranges only matter for entries without a price. The exceptions are the economy's balance overrides in
`src/economy/price-overrides.js`. `build-prices` applies them over the catalog and reports them so the catalog owner can
mirror them. Today there is one: the tank.

**Selling** returns 55% of the price × the condition of the car (1 for a garage car; the damage of the car you are
driving if you sell that model). Starters can't be sold.

## Income sources (all claims carry a `reason`)

Simulated pace (see Balance): a **skilled** player earns about **$1,700/min**, a **casual** player about **$530/min**.

| Reason | Formula (`rules.js`) | Cap / cooldown (client and server) |
|---|---|---|
| `drift` | `points / 3.6 × combo`, points = ∫ speed_kmh × (0.6 + slip) dt; paid when the chain ends (> 1.2 s, 0.9 s grace on straights) | ≤ $1,500 per chain, ≤ 1 chain / 2 s |
| `nearmiss` | `($60 + $0.60 × kmh) × combo`, speed > 90 km/h, 1.6–3.2 m from a traffic car, 6 s per car; misses inside the claim cooldown are bundled (≤ 3 per claim) | ≤ $1,200 per claim, ≤ 1 / 1.5 s |
| `stunt` | `($160 × air_s + $40 × height_m) × combo`, air > 1.3 s, landed upright. The first landing at a named stunt spot pays ×5 | ≤ $3,000, ≤ 1 / s |
| `speedtrap` | `($100 + $6 × max(0, kmh − 150)) × combo`. A new personal best at that trap pays ×2 | ≤ $2,500, ≤ 1 / 3 s, 10 s per trap |
| `race` | Time trials: gold / silver / bronze = 100 / 60 / 35% of the purse (`racePurse(length)`: $4k–$15k). The first medal of each tier pays in full, repeats 20% | ≤ $15,000, ≤ 1 / 60 s per trial |
| `collectible` | Postcard $1,000. Every 10th found +$10,000; all 60 found +$100,000 plus an exclusive livery | The server keeps the found-id set |
| `delivery` | `($500 + $0.90/m × route × class factor) × time bonus × condition`. Factor: truck/bus 1.6, van 1.3, other 1.0. Time bonus 1–1.5 (×1.5 at an average of 18 m/s or better). Condition = 1 − 1.5 × body damage taken on the job (min 40%) | ≤ $15,000, ≤ 1 / 45 s, route checked |
| `export` | Car taken from traffic, delivered to an export yard: `4% × model price × condition`, min $600, **×2 if the yard has it on its wanted list** | ≤ $25,000, ≤ 1 / 60 s, the same model 10 min, never a model you own |
| `pickup` | Cash dropped by knocked pedestrians: $5–$80, despawns in 30 s | ≤ $300 / min |
| `daily` | First session of the day: `$3,000 + $1,000 × streak` (streak 1..7 → $4,000 … $10,000) | 1 / day (single: local date; online: UTC, server) |
| `firstvisit` | First time entering each named district of `world.json`: $500 (52 names, $26,000 total) | Per district, once |

**Combo multiplier** (GTA-style chains): every skill event (drift, near miss, stunt, speed trap) within 6 s of the
previous one raises `combo` by +0.5, up to ×5. A drift or a jump in progress holds the window open. A crash with an
impact above 25 km/h (damage-system `impact` strength ≥ 0.234 from your own vehicle) resets it, and also loses the
drift chain in progress. 6 s without a skill event also resets it. The HUD shows `×2.5` next to the money (G), with a
draining timer bar under it (L).

## Sinks (beyond vehicles)

| Reason | Cost |
|---|---|
| `hospital` (wasted) | 3% of cash, min $50 (or what you have), max $2,500 |
| `repair` (body shop marker or menu) | `ceil(damage × price × 1.2%)`, min $100. Free for the starter car. Owned models only |
| `paint` (garage) | $500 for a colour, $2,500 for pearl/metallic |
| `tow` (call a vehicle that is far away) | Free, with cooldown |

There is no fuel, no upkeep and no loss of owned cars: ownership is permanent.

## Services (shop "Service" tab)

Convenience, consumables and cosmetics only: nothing raises speed, grip or income (no pay-to-win). Prices and checks are
in `rules.SERVICES` / `rules.servicePrice`, shared with the server. Cosmetics and armour belong to an owned model and
persist with the save (online: on the server).

| Service | Price | What it does |
|---|---|---|
| Repair | `ceil(damage × price × 1.2%)`, min $100, free for starters | Engine, body, dents, glass and lamps restored via `game.damage.repair(v)`. Same price at body shops. Owned vehicles you are in |
| Fire extinguisher | $1,500, carry max 2 | Used automatically 0.8 s after your car catches fire (setting `autoExtinguish`), or with a key (`economy.useExtinguisher()`). The car keeps a smoking engine (30%) |
| Armour plating | $6,000 per vehicle | −30% vehicle damage (dents, engine, body) until the next repair (any repair) or until the car is destroyed. Not for tanks |
| Insurance | $9,000 per 24 real hours (single and online; extends when bought again) | A destroyed owned vehicle is replaced for free: a new copy waits at the nearest service point (body shop), with a GPS waypoint |
| Replacement claim | $1,000 without insurance (free for starters) | A destroyed owned model is "wrecked": the next garage call charges the claim |
| Nitro refill | $400 | Full nitro now (it also recharges by itself) |
| Neon underglow | $5,000 kit per vehicle | 8 colours (pink, cyan, blue, green, purple, orange, yellow, white); recolour or switch off for free |
| Window tint | $1,200 per vehicle | Dark glass |
| Custom horn | $2,500 per vehicle and variant | C's horn variants: car, sport, luxury, truck, bus, moped, motorcycle, boat, police |
| Respray | $500 colour, $2,500 metallic or pearl | New paint, kept as the vehicle's default colour in the garage |

Ownership stays permanent. Insurance only saves the $1,000 claim and brings the car to you, so it is worth it for
players who wreck cars a lot.

## Wardrobe and nickname (long-term cosmetic sinks)

D's catalogue `src/characters/wardrobe.js` lists items with a slot and a tier:
- slots: hair, facial hair, top, legs, shoes, hat, glasses, accessory, tattoo, body;
- tiers: basic, street, premium, luxury.

`node tools/economy/build-wardrobe-prices.mjs` prices every item with `rules.wardrobePrice` and writes the shared table
`src/economy/wardrobe-prices.json` (`{ id: { price, slot, tier, dye, starter } }`). Until D ships the catalogue, a
provisional catalogue (`tools/economy/wardrobe-sample.mjs`, 77 items) stands in. Its ids will be replaced.

| What | Price | Rule |
|---|---|---|
| Basic tier | $80 – $600 | Geometric inside the tier: slot base + span × the item's `value` (0..1). Hats and glasses sit low, tops mid, accessories span the whole tier |
| Street tier | $600 – $4,000 | |
| Premium tier | $4,000 – $25,000 | |
| Luxury tier | $25,000 – $250,000 | Gold watch $35,500 … diamond watch $249,000; designer-style suit $78,900, white Vice suit $159,000 |
| Barber: haircut | $150 – $1,200 | By tier (+ value): buzz $169, side part $289, salon $519–579, celebrity stylist $1,090 |
| Barber: facial hair | $150 – $700 | |
| Tattoo | $500 – $9,000 | By `size` 0..1: small $499, medium ~$1,400, sleeve $5,850, full back $8,990 |
| Plastic surgeon (slot `body`) | $15,000 | New face or body type |
| Re-dye an owned item | 15% of its price, min $50 | |
| Starter items | free | The default look |

Small prices end in …9 ($149, $449); larger ones are rounded like vehicle prices. There is no resale: clothes are a
sink. Changing outfits among owned items is free.

**Nickname** (generator and checks: J's `src/net/shared/nicknames.js`):
- **reroll** from the generator: $2,500; **the first reroll of a profile is free** (once, not per session: a per-session
  freebie could be farmed by reloading);
- **custom name**: $50,000. It must be 3–16 of `A–Z a–z 0–9 _ -` and must not look like a generated name. The server
  adds a blocklist and case-insensitive uniqueness.

**Net worth** excludes wardrobe items because they cannot be sold. Clothing purchases reduce cash; the purchased appearance remains permanently owned.

## Jobs and places

Markers are glowing ground rings with a tall beacon beam: two instanced meshes, no real lights, about 0.02 ms per
frame. Stop inside a ring (below 18 km/h) to use it. Anchors are near district centres and snap to the kerb lane of
the nearest urban road (`src/economy/places.js`).

**Delivery depots** (gold): drive in with any land vehicle and stop. You get a contract to a random kerb point 1.5–6 km
away by road, routed with `roads.route`. The GPS waypoint is set, a green destination ring appears and a contract
card shows the destination, the distance, a countdown and the maximum pay. The time limit is 30 s + route / 11 m/s.

| Depot | Area | Anchor (x, z) |
|---|---|---|
| Port of Vice City Freight | Port Vice City | 600, 560 |
| Stockyard Freight | Stockyard | −352, −1792 |
| VCIA Air Cargo | Vice City International Airport | −2396, 674 |
| Allied Crystal Plant | Ambrosia | −2911, −3652 |
| Hamlet Freight Yard | Hamlet | −2683, 3391 |
| Port Gellhorn Freight | Port Gellhorn | −6600, −3700 |

A contract fails when:
- the time runs out;
- the vehicle is wrecked or despawned;
- you are out of it for more than 30 s;
- you get wasted;
- you cancel it (`jobs.cancel()`).

Events: `job:start`, `job:complete`, `job:fail`.

**Export yards** (pink): bring a car you took from traffic (carjacked: `vehicle.fromTraffic`). Owned models,
garage-spawned cars and models exported in the last 10 minutes are refused. The car is handed over: on foot with D's
controller; with `BasicPlayer` the yard brings your own last car.

Each yard has a **wanted list** of 3 common traffic models that pays ×2. The lists rotate every 20 minutes, are
deterministic (`rules.exportWanted`) and differ per yard. Driving in on foot shows the list. Entering a freshly taken
car shows its export value.

| Yard | Area | Anchor (x, z) |
|---|---|---|
| Vice City Docks Export | Port Vice City | 950, 380 |
| Capri Marine Export | Capri | −6742, −96 |
| Key Lento Export | Leonida Keys | −2482, 5872 |

**Body shops** (teal; they glow and get a beam when your car is damaged): instant repair at the `repair` price.

| Body shop | Anchor (x, z) |
|---|---|
| Ocean Beach Body Shop | 1778, −483 |
| Little Cuba Auto Body | −1194, −60 |
| Southside Paint & Body | −1777, 2059 |
| Ambrosia Garage | −2769, −3882 |

**First visit** pays $500 per named district of `world.json`: a toast "NEW AREA DISCOVERED". **Daily bonus**: on the
first session of the day, a bank feed card.

## Leaderboard

Top 10 by **net worth** = cash + 55% of the catalogue price of owned vehicles that can be sold. Free starter vehicles and wardrobe items are excluded. New players therefore start with net worth equal to their cash balance. The Online tab shows the cash/vehicle breakdown. Offline leaderboard rows are recalculated when the formula or price table changes; balances, ownership and progress are preserved.

## Online authority (implemented by the server, `src/net` + `server/`)

- `claim(reason, amount, pos, meta)`: the server recomputes or clamps the amount with `rules.js` and the caps above.
  It checks:
  - server-observed speed and trajectory;
  - the per-reason cooldown;
  - the global token bucket (≤ $12,000/min sustained, burst $50,000). `daily`, `collectible`, `firstvisit` and first
    medals are exempt.

  It then grants or rejects. The client shows the income optimistically and reconciles with the server balance.
- `buy(id)`, `sell(id)`, `repair`, `paint` and the hospital fee: the server checks the shared price table and
  ownership. It is atomic: `UPDATE … WHERE money >= price`.
- Ownership, found collectibles, medals, districts visited, stunt spots, speed-trap bests and the daily streak are stored
  per player on the server (SQLite). Single-player stores the same structure in `localStorage['leonida.save.single']`
  (debounced saves, plus a save on page hide/unload). Online without a server connection, the client plays on a
  separate local wallet (`leonida.save.offline`).

### Online income multiplier (`rules.ONLINE`)

Online, every gameplay payout is the singleplayer formula × **`ONLINE.mult` = 2**. This covers skill events,
deliveries, exports, races, collectibles, first visits and the daily bonus. Street cash pickups and `other` are not
scaled. Singleplayer is unchanged.

How the two sides apply it:
- **Client:** `economy.earn` predicts and claims base × mult. UIs that show a payout before it is earned multiply by
  `economy.incomeScale(reason)`.
- **Server:** it recomputes the base formula from what it observed, multiplies by mult, and clamps the claim to
  `rules.reasonMax(reason, true)` (= `REASONS.max` × mult).
- **Bucket:** it was doubled with the payouts, so one maximum export ($50,000 online) still fits in a single burst.

Why 2×: before the change, saving from scratch (`simulate.mjs --online --mult 1 --no-spend --save`) took:
- a focused ("skilled") player about 5 h 15 min for a $500k car and about 16.5 h for a $1.45M one;
- a regular player about 10.5 h for $500k.

The token bucket never limited anyone (0.0% of income lost): average pace was $1.5–1.7k/min against a $6k/min cap.
The binding constraint was the payouts themselves. At 2×:

| Saving from scratch | Before (focused / regular) | 2× online (focused / regular) |
|---|---|---|
| $146k (chantry) | 1 h 28 min / 2 h 46 min | 44 min / 1 h 22 min |
| $498k (tempesta) | 5 h 14 min / 10 h 23 min | 2 h 31 min / 4 h 56 min |
| $845k (mitternacht) | 9 h 09 min / 18 h 00 min | 4 h 22 min / 8 h 31 min |
| $1.45M (heli_police) | ≈ 16.5 h / ≈ 31 h | 7 h 43 min / 14 h 53 min |
| $1.8M (dolce_vita) | ≈ 21 h / ≈ 38 h | 9 h 43 min / 18 h 48 min |

With the 2× bucket, a focused player loses 0.0% of income to it.

## Spawning

- A new player or session spawns in **Ocean Beach (Vice Beach)**, at a **random kerb slot**, not in a single point.
  - There are 120 parking positions in the kerb lane of kind-0 roads within 600 m of the district centre (1728, −733).
  - The positions are generated deterministically from the road graph: the same list on every client and the server.
  - The slot is chosen at random and skipped if another player or car is within 25 m (AI traffic within 7 m).
- The player spawns in their last-used owned land vehicle, or the starter Pip.
- After *wasted*, the respawn is at a random slot around the nearest of six hospitals, and the hospital fee is charged:

| Hospital | Area | Anchor (x, z) |
|---|---|---|
| Vice Beach Medical Center | Vice Beach | 1735, −1430 |
| Vice City General | Downtown | −560, 40 |
| Port Gellhorn Regional | Port Gellhorn | −6785, −3817 |
| Ambrosia Community Hospital | Ambrosia | −3150, −4000 |
| Kalaga Ranger Clinic | Mt. Kalaga National Park | −3160, −7090 |
| Key Lento Medical | Leonida Keys | −2182, 5572 |

- On page reload, the saved position (snapped to the nearest road) and vehicle are restored: online from the server,
  single-player from localStorage.

## Balance

`node tools/economy/simulate.mjs` plays a casual and a skilled player for 10 h, 500 seeded runs each. It uses the real
formulas, caps and prices and buys the next goal as soon as it is affordable. The result is the median, with
p10–p90 in brackets:

| Milestone | Price | Casual | Regular | Skilled |
|---|---:|---|---|---|
| First upgrade (Hachi, not bought) | $30,000 | 54 min (46 min–1 h 05 min) | 27 min (20 min–37 min) | 16 min (10 min–22 min) |
| First sports car (Kurve R) | $89,000 | 3 h 13 min (2 h 41 min–3 h 40 min) | 1 h 40 min (1 h 25 min–1 h 55 min) | **51 min** (43 min–1 h 02 min) |
| First supercar (Tempesta) | $498,000 | > 10 h (≈ 20 h) | > 10 h (≈ 11 h) | **5 h 53 min** (5 h 19 min–6 h 14 min) |
| First helicopter (Vella N2) | $650,000 | > 10 h (≈ 42 h) | > 10 h (≈ 24 h) | > 10 h (≈ 13 h) |
| Business jet (Solstice 7) | $8,500,000 | > 10 h (≈ 328 h) | > 10 h (≈ 189 h) | > 10 h (≈ 102 h) |

The table above is the pure car ladder: no cosmetics or services. The next section adds typical spending. Average pace
over the first 10 h: skilled $1,710/min (hour 1: $1,771, hour 10: $1,580), regular (between casual and
skilled, 1.5–2 h a day) $915/min, casual $528/min. Income mix:
- skilled: near miss 25%, delivery 20%, drift 16%, stunt 14%, races 10%, speed traps 5%, daily 3%;
- casual: daily 25%, delivery 23%, near miss 13%, stunt 9%, races 9%, first visits 7%.

Sinks over 10 h: hospital ≈ $20k (skilled) / $28k (casual), repairs ≈ $11k / $2k.

Assumptions (in `PROFILES`):

| Assumption | Skilled | Casual |
|---|---|---|
| Time split | roam 38%, deliveries 27%, races 12%, exploring 10%, exports 8%, idle 5% | roam 42%, deliveries 22%, exploring 16%, races 6%, exports 6%, idle 8% |
| Skill events per minute of free roam | 2 drift chains of ~4.5 s, 3 near misses at ~150 km/h, 0.35 jumps, 0.15 speed traps; ~3.5 events per combo chain, 7% crash chance per event | 0.8 drifts, 1 near miss, 0.12 jumps, 0.05 traps; ~1.6 per chain, 16% crash |
| Delivery average speed | 21 m/s | 12.5 m/s |
| Daily sessions | 2 h | 45 min |
| Wasted per hour | 0.9 | 1.5 |

Workstream I content is assumed: 8 time trials, 60 postcards, 12 stunt spots and speed traps. Without it
(`--no-activities`), the skilled player reaches the sports car in 59 min and the supercar in 6 h 41 min.

### Spending: cosmetics, services and the tank

The simulation also spends money like players do (assumptions in `PROFILES.*.shop`):
- **cosmetics**: a share of every dollar earned goes to "treats" (casual 10%, regular 8%, skilled 6%), bought from a
  wishlist in this order:
  - the first nice outfit (street cut, top, legs, shoes, aviators: $5,329), bought as soon as each piece costs ≤ ⅓ of
    cash;
  - after each car purchase: respray, tint and often neon;
  - street and premium clothes and tattoos;
  - the gold watch;
  - (skilled) a custom nickname;
  - luxury clothes.
- **services**: nitro refills (0.1 / 0.4 / 1 per hour), extinguishers (0.05 / 0.15 / 0.3 per hour), armour (0 / 0.05 / 0.1
  per hour) and insurance (0 / 5% / 15% of sessions).

Every run is repeated with the same seed without spending to measure the delay. 500 runs × 10 h:

| | Casual | Regular | Skilled |
|---|---:|---:|---:|
| Vehicles | 28% | 16% | 57% |
| Cosmetics (wardrobe, car looks, nickname) | 8% | 7% | 6% |
| Services (nitro, extinguishers, armour, insurance) | 0% | 2% | 2% |
| Upkeep (repairs, hospital) | 9% | 5% | 3% |
| Still in the wallet (saving for the next car) | 54% | 70% | 32% |
| Cosmetics bought in 10 h (mean) | $26,728 | $39,716 | $57,060 |
| First nice outfit ($5,329) | 5 min | 5 min | 4 min |
| Gold watch ($35,500) as the next treat after the outfit | 13 h 01 min | 9 h 16 min | 6 h 38 min |
| Gold watch saved for directly (all income) | 54 min | 29 min | 14 min |
| Delay of the first sports car | 3 h 14 min → 3 h 27 min (+7%) | 1 h 40 min → 1 h 49 min (+9%) | 52 min → 56 min (+8%) |
| Delay of the first supercar | ≈ 20 h 02 min → 20 h 41 min (+3%) | ≈ 11 h 15 min → 12 h 08 min (+8%) | 5 h 52 min → 6 h 17 min (+7%) |

Shares are of everything earned in 10 h, including the $5,000 start.

So typical cosmetic and service spending delays the car milestones by **3–9%**, within the ~10% budget. The first nice
outfit is affordable from the start ($9,000 with the day-1 bonus). A luxury watch is a long-term treat: about 6.5–13 h
of typical play, or under an hour for a player who saves for it directly. Luxury suits ($79k–$159k) and the diamond
watch ($249k) are tens-of-hours sinks for the rich.

### The tank (`tank`, A's `military` category)

Request: "very expensive, but realistically buyable in about 10 days of play" (10 × 1.5–2 h = 15–20 h). The
simulation (`--ladder sports,tank --hours 40`) buys a sports car first, which is the faster route, then saves for the
tank:

| Tank price | Casual | Regular | Skilled |
|---:|---|---|---|
| $1,800,000 (A's proposal) | ≈ 68 h | ≈ 40 h | 20 h 22 min (≈ 10 days × 2.0 h, upper edge) |
| **$1,500,000 (chosen)** | ≈ 57 h | 32 h 53 min | **16 h 50 min** (16 h 03 min–17 h 38 min) ≈ 10 days × 1.7 h |
| **$1,500,000 with typical spending** (cosmetics + services) | ≈ 62 h | 36 h 05 min | **18 h 13 min** (17 h 24 min–19 h 05 min) ≈ 10 days × 1.8 h |
| $1,000,000 | ≈ 39 h | 21 h 44 min | 11 h 12 min |

At $1.5M the tank is the sixth most expensive vehicle: only the jet, the Mule T2 cargo helicopter, the Aurora, the
Zenith and the Dolce Vita cost more. A dedicated player gets it in about 10 days of 1.5–2 h; a regular player in about three weeks. Over
long horizons the pace drops slightly (skilled $1,540/min over 40 h) as one-off rewards run out. The price is set in
`src/economy/price-overrides.js`; A should use the same price in the catalog.

### Refinements made after simulating the first draft

1. **The repeatable payouts are roughly doubled.** The first draft gave a skilled player about $1,000/min and a
   casual player about $320/min from play. That is far below the $1,800 / $500 targets: the sports car took 1 h 29 min
   and the supercar about 10 h. The changes:
   - drift `/9` → `/3.6`;
   - near miss `$25 + 0.25/kmh` → `$60 + 0.60/kmh`;
   - stunt `70/s + 18/m` → `160/s + 40/m`;
   - delivery `$250 + $0.45/m` → `$500 + $0.90/m`;
   - export 2.5% → 4% (min $400 → $600).

   Deliveries and free-roam skill now pay about the same for a given skill level (skilled: $1,850–2,050/min vs
   $1,700–1,850/min), so players choose by fun, not by spreadsheet.
2. **Daily bonus `$5,000 × streak` → `$3,000 + $1,000 × streak`.** At ×7 the old bonus was 50% of a casual player's
   income: a login reward, which is a dark pattern under goal 4. Now it is about 25%, and day 1 still pays $4,000.
3. **Hospital fee 5% / max $5,000 → 3% / max $2,500.** The old fee took 14% of a casual hoarder's income (one death =
   10 minutes of play). Now it is about 9%.
4. **Export cap $25,000; owned models can't be exported.** The server can't tell a carjacked car from a
   garage-spawned one, so "owned models never" is the server-checkable rule. The cap bounds the rare hypercar jackpot.
5. **Wanted lists (×2) at the export yards**: a hunting loop for the export activity.
6. **Net worth counts cash and sellable vehicles.** Starter vehicles and wardrobe items are excluded.

Open recommendation for the catalog owners (B): the $8.5M jet is a ~100 h goal for a skilled player. If that is too
far, a price around $4.5–5M (~55 h), or late-game air-cargo contracts, would shorten it.
