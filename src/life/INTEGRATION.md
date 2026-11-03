# World life & fun (workstream I): integration notes

Files: `src/life/**` and `lab-life.html`. Everything is original and fictional: no real brands, logos or characters.

| Feature | Files |
|---|---|
| Beach & coast props: umbrellas, loungers, art-deco lifeguard towers, volleyball nets, palm-frond huts, beach bars, drivable wooden piers, bobbing yachts, sailboats and buoys | `coast.js` (analysis + placement), `Beach.js` |
| Billboards (highway monopoles + rooftops) with 24 original meme billboards (expectation/reality, "nobody:", fake error dialogs, joke charts, local-news headlines, fake ads with small print, loading bars, warning signs; all procedural Canvas2D doodles, no meme images, characters, brands or people), neon blade signs, neon tower bands | `Signage.js`, `ads.js` |
| Seagulls, pelicans and crows (CPU boids, flapping in the vertex shader), GPU fireflies over wetlands at night | `Birds.js` |
| 60 "Leonida postcards" (spinning, glowing collectibles) | `Collectibles.js` |
| 8 point-to-point time trials on the road graph | `routes.js`, `Races.js` |
| 14 speed traps on highways | `SpeedTraps.js` |
| Photo mode (P) | `PhotoMode.js` |
| Street furniture along the raised sidewalks: trash bins, benches, fire hydrants, bus shelters with stop signs, newspaper boxes, mailboxes, parking meters, palm / shrub planters, bike racks, café sets (knock-over physics) | `streetPlan.js` (placement), `streetGeo.js`, `StreetProps.js` |
| Shared code: streamed instancing, materials, geometry kit, colliders, DOM HUD, strings | `Instancer.js`, `materials.js`, `geometry.js`, `colliders.js`, `hud.js`, `strings.js`, `util.js` |

## 1. Register (src/main.js)

```js
import { createLife } from './life/index.js';

createGame(document.getElementById('app'), {
  modules: [
    economyModule,             // workstream L, if used: register it BEFORE life
    (game) => createLife(game), // registers itself (order 55) and sets game.life
  ],
});
```

- Needs `game.scene`, `camera`, `renderer`, `render`, `terrain`, `roads`, `buildings`, `world3d`, `player`, `input`,
  `events`, `uniforms` (all created by bootstrap before modules). `game.ui`, `game.i18n` and `game.economy` are optional
  and used if present.
- Options: `createLife(game, { beach, signage, birds, collectibles, races, speedtraps, photo })`. Pass `false` to switch a
  feature off. `{ log: false }` silences the init timing log.
- `createLife` compiles its own materials into `render.sceneRT` (prewarm). If `render.prewarm()` runs after all
  modules, the life materials are included too.
- Lab: `lab-life.html` (URL params `?mode=single`, `?eco` with the economy, `?hour=21`, `?photo`, `?x=&z=`).
  To build it, add `life: resolve(import.meta.dirname, 'lab-life.html')` to `vite.config.js` `rollupOptions.input`.

## 2. Controls (G: please add to `src/ui/controls-data.js`)

| Mode | Action | Keyboard | Gamepad | Touch |
|---|---|---|---|---|
| car / bike (land vehicles) | `act.raceStart`: start a time trial (stopped or below 20 km/h inside a pink start marker) | **E** | **D-pad up** | big **START** button, shown by life itself |
| car (during a trial) | cancel the trial | E | D-pad up | none |
| general | `act.photo`: photo mode | **P** | none | K: please add a button that calls `game.life.photo.enter()` |
| photo mode | orbit / move / up-down / zoom / capture / hide panel / exit | LMB drag · RMB drag or WASD · Q/E · wheel · Enter · H · P (Esc in noUI labs) | left stick move, right stick orbit, LT/RT zoom, A capture, B exit | none |

Why these keys: F exits the vehicle; D-pad left/right change radio stations (C, `Radio.js`); E and D-pad up are free in
land vehicles. The prompt is device-aware: a keycap (`E`) on desktop, a D-pad glyph when `input.gamepad` is set, and a
tappable START button when `input.touch` is set. The prompt appears only below 20 km/h at a marker and fades in and out.

## 3. Economy (L) — all rewards go through `game.economy`

| Feature | Call (when available) | Fallback chain |
|---|---|---|
| Postcard | `economy.collect(id, pos)`. It pays $1,000, the set bonuses (+$10k every 10, +$100k for all 60) and stores the id in `economy.found`. If it refuses the claim (cooldown), the card stays in the world and is retried 0.6 s later | `economy.earn('collectible', collectiblePay(n), pos, {id, count})` → `player.addMoney` |
| Time trial | `economy.medal(id, tier, racePurse(lengthM), pos, timeS)`: the first medal of a tier pays in full, repeats pay 20 % | `economy.earn('race', racePay(purse, tier, first), pos, {id, medal, time})` → `player.addMoney` |
| Speed trap (≥ 120 km/h) | `economy.speedTrap(id, kmh, pos)` (combo, ×2 personal best, 10 s per trap) | `economy.earn('speedtrap', speedTrapPay(kmh, pb), pos, {id, kmh})` → `player.addMoney` |

- Formulas are imported from `src/economy/rules.js` (`collectiblePay`, `racePurse`, `racePay`, `speedTrapPay`). These are
  the same functions the server uses, so the prompt's "Prize $X" and the pop-ups match what the server grants.
- Economy calls don't emit `money:pickup`, so life emits `money:pickup {amount, position, reason}` with the granted amount
  (the HUD shows its +$ pop).
- Stable ids:
  - postcards `pc_<x>_<z>` (rounded world position);
  - time trials `beachfront`, `causeway`, `downtown`, `runway`, `swamp`, `canefield`, `keys`, `kalaga`;
  - speed traps `trap_<x>_<z>`.
- Progress is read back from `economy.found`, `economy.medals` (bitmask: 1 gold, 2 silver, 4 bronze) and
  `economy.traps` on start and on every `economy:change`. Online state applied via `applyServer` shows up automatically.
- localStorage (single-player only, never online):
  - `leonida.races`: best times and splits (the economy doesn't store them);
  - `leonida.collectibles`, `leonida.speedtraps`: only when there is no `game.economy`.
- `collectible:set {kind, count, total, bonus, complete}` is informational: the economy already paid the set bonus. L can
  use it for the exclusive livery when `complete` is true.

## 4. Events

| Emitted | Payload |
|---|---|
| `collectible:pickup` | `{ id, kind: 'postcard', name, count, total, reward, bonus, position }` |
| `collectible:set` | `{ kind: 'postcard', count, total, bonus, complete }` (every 10th and the last) |
| `race:countdown` | `{ id, n }`: n = 3, 2, 1, then 0 = GO |
| `race:start` | `{ id, name, checkpoints, length, best, par, purse }` |
| `race:checkpoint` | `{ id, index, total, time, delta, position }`: delta (ms) vs the best run's split, or null |
| `race:finish` | `{ id, name, time, best, record, medal: 'gold'\|'silver'\|'bronze'\|null, reward, par, purse }` |
| `race:cancel` | `{ id, reason: 'falseStart'\|'vehicle'\|'quit'\|'lost', time }` |
| `speedtrap` | `{ id, speedKmh, best, record, reward, position }` (flash at the camera) |
| `photo:enter` / `photo:exit` | `{}`: audio (C) may duck the engine and ambience |
| `photo:capture` | `{ name, width, height, size }`: C could play a shutter sound |
| `money:pickup` | `{ amount, position, reason }` for amounts granted through the economy |

Listened: `ui:open` (photo mode exits; the menu keeps the pause), `economy:change`, `lang` (race labels).
Suggested sounds for C: countdown beeps (n = 3, 2, 1) and a higher GO (n = 0), a checkpoint ping, a finish fanfare, a
speed-trap camera flash, a postcard chime.

## 5. Radar / map blips (G)

`game.life.blips(out = [])` → `[{ x, z, color, kind: 'race'|'checkpoint'|'speedtrap', name? }]`. While idle it returns the
race starts; during a race, the next checkpoint. Please merge it in `collectBlips()` (`src/ui/index.js`), e.g.
`game.life?.blips(out)`. Postcards are deliberately secret (no blips).
During a race the player's waypoint is set to the finish (GPS route); the previous waypoint is restored afterwards.

## 6. i18n (G)

Namespace `life`. `en` and `ru` are registered at runtime (`game.i18n.register('life', LIFE_STRINGS)` in
`src/life/strings.js`), and every call carries an inline English fallback. Keys for the other 28 languages:

```
life.race.prompt life.race.startBtn life.race.prize life.race.best life.race.cps life.race.getReady life.race.go
life.race.record life.race.finished life.race.falseStart life.race.noVehicle life.race.quit life.race.lost life.race.time
life.race.checkpoint life.race.delta life.race.medal.gold life.race.medal.silver life.race.medal.bronze
life.race.name.beachfront life.race.name.causeway life.race.name.downtown life.race.name.runway life.race.name.swamp
life.race.name.canefield life.race.name.keys life.race.name.kalaga
life.pc.title life.pc.milestone life.pc.complete
life.trap.title life.trap.record life.trap.best
life.photo.title life.photo.filter life.photo.fov life.photo.time life.photo.roll life.photo.exposure life.photo.blur
life.photo.focus life.photo.vignette life.photo.letterbox life.photo.stamp life.photo.capture life.photo.reset
life.photo.exit life.photo.saved life.photo.hint life.photo.f.none life.photo.f.vivid life.photo.f.vice
life.photo.f.noir life.photo.f.vintage life.photo.f.cool life.photo.f.heat
```

`life.photo.hint` contains `<kbd>` markup. Existing keys used: `hud.kmh`, `hud.mph`.

## 7. Photo mode details (F, G, K)

- Enter: P when the menu isn't open, the game isn't paused, and `game.can('photo')` allows it. It sets
  `game.paused = true` and hides `game.ui.hud`. While paused the loop only renders, so photo mode runs its own rAF loop
  and refreshes the camera-dependent systems with dt = 0: `sky.update`, `terrain.update`, `water.update`, `roads.update`,
  `buildings.update`, `veg.update`, `lamps.update` and the life streams. Nothing simulates.
- The time-of-day slider is a local preview: the original time, camera, FOV, exposure, canvas filter and HUD are
  restored on exit.
- Exposure multiplies `renderer.toneMappingExposure` after `sky.update`.
- Colour filters are a CSS filter on the canvas (preview) and `ctx.filter` in the capture, with a colour-matrix fallback
  where `ctx.filter` is unsupported.
- **The renderer has no DOF pass.** Focus blur is a tilt-shift: a `backdrop-filter` band in the preview and a
  down/up-sampled blur composited in 2D for the capture. F: if you add `render.setDof({ focus, strength })`, the photo
  panel can switch to it.
- Capture: renders 3 clean frames, draws the WebGL canvas into a 2D canvas in the same task, then applies the filter,
  blur, vignette, cinema bars and an optional "Leonida · AREA · 18:06" stamp. The result is downloaded as
  `leonida-YYYYMMDD-HHMMSS.png`. API: `game.life.photo.capture({ download })` → `Promise<Blob>`.
- Pressing Esc or M (UI menu) while in photo mode exits photo mode; the menu keeps the pause.

## 8. Performance (measured in `lab-life.html`, quality "medium", M-series Mac)

- Init: about 160–290 ms in total (beach analysis 70–125, signage 20–40, collectibles 20–40, routes 10–70, prewarm
  12–20). Everything runs once at load.
- Per frame (update + lateUpdate, 900 frames driving along Vice Beach): **0.015 ms average, p95 0.1 ms, max 0.3 ms**,
  where 0.1 ms is the timer resolution. Instance repacks only happen on > 25–150 m moves, at most 2 sets per frame.
  Birds: ≤ 47 instances (quality-scaled); boids run at 10 Hz.
- Render: about 28 extra draw calls (one InstancedMesh per prop type). About 0.12 ms of extra CPU submission measured.
  Shadow casters: umbrellas, towers, huts, kiosks, piers, yachts, billboards, speed cameras.
- No lights. No `material.needsUpdate`. No light/mesh visibility toggles at runtime. All materials and geometry are created at init. Canvas textures (ads, neon words, postcard) re-upload once when the web fonts finish loading.
- Content counts:

  | Kind | Count |
  |---|---|
  | Umbrellas | ~2,200 |
  | Loungers | ~3,250 |
  | Lifeguard towers | 70 |
  | Volleyball nets | 58 |
  | Huts | 143 |
  | Beach bars | 59 |
  | Piers | 7 (≈108 m each, drivable) |
  | Yachts and sailboats | 102 |
  | Buoys | 335 |
  | Billboards | 38 highway + 30 rooftop |
  | Neon blade signs | 110 |
  | Neon bands | ≈2,100 |
  | Postcards | 60 |
  | Time trials | 8 (2.9–5.3 km, 17–32 checkpoints) |
  | Speed traps | 14 |
  | Static colliders | ≈360, streamed within 170 m |

## 9. Street furniture (`StreetProps.js`)

- **Placement** (init, about 40–55 ms): every edge with `roads.sidewalkWidth(e) > 0` (not internal, not tunnels).
  - Props stay out of the first and last `trims[e.i][k].t + 3` m of each edge, off bridges, junction surfaces
    (`roads.inJunction`) and spots where another road crosses the sidewalk (`roads.sidewalkBlocked`).
  - Clearances: ≥ 3 m from street lamps (`game.lamps.scatter.raw`) and from traffic-signal poles
    (`game.traffic.lights.nodes[].approaches`), and outside building footprints with a margin.
  - Density follows `world3d.areaAt(...).wealth` and the district type (downtown, near a beach). Rich, downtown and
    beach streets get more and nicer props; poor suburbs are sparse.
  - Positions are deterministic per edge.

  | Type | Count | Rule |
  |---|---|---|
  | Trash bins | 3,330 | every 30–95 m by density, alternating sides, at the kerb |
  | Benches | 1,036 | wide downtown / beach sidewalks, back to the buildings |
  | Hydrants | 1,105 | near corners; red, some yellow in rich areas |
  | Bus shelters with stop sign | 185 | every ~400 m on wide lit avenues; lit ad panel and roof strip at night |
  | Newspaper / vending boxes | 932 | clusters of 2–3 at downtown corners |
  | Mailboxes | 511 | |
  | Parking meters | 1,398 | one kerb, every 8 m, downtown districts |
  | Planters | 676 palm + 415 shrub | widest sidewalks, between the lamps |
  | Bike racks | 278 | |
  | Café sets | 188 | 2–3 parasol tables outside shops in Ocean Beach, Washington Beach, Downtown, Little Cuba… |

  Total about 10,050.
- **Render:** 11 InstancedMeshes (one per type, one shared material), so 11 draw calls. They are streamed by distance
  (220–650 m) and at most 2 sets repack per frame. Shadow casters: benches, shelters, planters, café sets.
- **Physics:** static colliders within 80 m of `player.focus` (≈ 15–25 live), at most 16 created and 24 removed per
  0.15 s tick. Collider `userData = { prop: id }` with contact-force events.
  - **Light props** (bins, hydrants, news boxes, mailboxes, meters, racks, café sets): event threshold 900 N, knocked
    over by any real hit.
  - **Fixed props** break only above a force threshold: benches 26 kN, planters 60 kN, shelters 110 kN.
  - **No bootstrap hook needed:** life listens to the existing `game.events.on('contact', …)` emitted by `drainEvents`.
    It runs before the damage system's `postStep`, so `damage.byHandle.get(body.handle).pl` is still the pre-impact
    velocity.
  - **On a hit:**
    1. The prop's collider is removed and its instance hidden.
    2. The car's velocity is restored to the pre-impact velocity × 0.95 (light) / 0.86 (bench, planter) / 0.78
       (shelter), with `st.suppress = 2`.
    3. A pooled dynamic body (max 20 at once; the oldest is recycled) takes over the prop and is launched with the
       car's velocity plus a hop and spin. It is drawn through the same InstancedMesh (dynamic slots), so no extra
       draw calls.
  - Tumbling pieces collide with the ground, buildings, props and characters, never with vehicles (so there is no
    second slowdown).
  - After 20 s the body is removed; the prop respawns when both the camera and the player are more than 90 m away.
  - Measured in the lab, ramming at 16–25 m/s: the car keeps 93–95 % of its speed (bin, hydrant, meter, news box,
    café set) and 86 % (bench).
- **Events emitted:** `prop:broken { type, id, position, force }` and `impact { position, strength 0.25 | 0.5,
  kind: 'prop', material: 'plastic' | 'metal' | 'wood' | 'concrete' | 'glass', source }`. A broken hydrant also calls
  `fx.splash` plus an 8 s upward `fx.smoke({ color: 'steam' })` water jet.
- **Performance** (lab, 1,500 frames per run driving through Ocean Beach and downtown at 100 km/h):
  - street furniture: **0.002 ms/frame on average, max 0.2 ms**, no frame above 0.3 ms;
  - whole life module: about 0.01 ms on average.

  No per-frame allocations in the props code, except Rapier's `translation()` / `rotation()` for up to 20 tumbling
  pieces.
- `createLife(game, { street: false })` disables the feature.
- Note for D (pedestrians): sidewalk props sit at the kerb (0.3–1.0 m from it) or against the building side
  (`hw + W - 0.45…0.85`). The middle of the sidewalk stays clear for walking.

## 10. Colliders

Streamed within 170 m of `player.focus`, up to 40 creations per 0.35 s tick (`colliders.js`). Collision groups:

- `STATIC`: lifeguard towers, beach bars, yachts, billboard poles, speed-camera poles, pier railings and the bait shack.
- `GROUND`: pier ramps and decks (drivable).

`collider.userData.life` holds the item index.

## 11. Known limits / notes for others

- `game.quality` isn't attached by the current bootstrap; life falls back to `game.render.profile`.
- The race timer uses `dt × game.timeScale`, so slow motion doesn't cost time. Pausing the game pauses the timer.
- Postcard positions are generated deterministically from `world.json` landmarks, the road graph, buildings and the
  terrain. If those data files change, some ids change and found cards may reappear.
- In-world text is the procedural meme billboards (English, short and simple wording; atlas 4 × 6 cells of 512 × 180 px in `ads.js`), neon words (`HOTEL`, `MOTEL`, `OPEN`, `DINER`, `CAFE`, `DISCO`, `SURF`, `PIZZA`)
  and the postcard art. These canvas textures aren't localised.
