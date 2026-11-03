# Vehicles (workstream A) — integration notes

## Exports (exact names)

```js
import {
  VEHICLE_CATALOG, getCatalogEntry, CATEGORIES,   // catalog (src/vehicle/catalog.js)
  Vehicle, initHeadlightPool,                      // controllable (src/vehicle/Vehicle.js)
  deriveSpec, buildCarModel,                       // physics spec / visual model
  bakeVehicle,                                     // traffic bake (src/vehicle/bake.js)
  renderVehicleThumbnail, createThumbnails,        // previews (thumbnail.js / Thumbnails.js)
  Tank, TANK_WEAPON, TANK_ARMOR, TankCamera, Shells, SHELL_BLAST, bakeTank, TANK, // tank (src/vehicle/tank)
} from './vehicle/index.js';
```

Direct paths also work: `./vehicle/catalog.js`, `./vehicle/bake.js`, `./vehicle/Thumbnails.js`, `./vehicle/thumbnail.js`.

## What the integrator must call

```js
// bootstrap, right after `game.vehicles = new VehicleManager(game)` (before the first frame)
import { VEHICLE_CATALOG, initHeadlightPool, bakeVehicle, createThumbnails } from './vehicle/index.js';
initHeadlightPool(scene);                        // 2 pooled SpotLights, created once (see "Headlights")
game.vehicles.addCatalog(VEHICLE_CATALOG);       // 128 ground vehicles; `tank` has `create`, the rest are `Vehicle`s
game.traffic?.setCatalog(VEHICLE_CATALOG, bakeVehicle);
game.thumbnails = createThumbnails(game);        // UI previews (G uses get/request/createTurntable)
```

`VehicleManager.spawn(id, pos, yaw, opts)` keeps working unchanged: `new Vehicle({ preset: id, ... })` with any catalog id.
The 6 original ids (`comet, muscle, super, suv, pickup, cruiser`) are catalog entries too (new fictional names).

`vite.config.js` (integrator): add `labVehicles: resolve(import.meta.dirname, 'lab-vehicles.html')` to `rollupOptions.input`
if the lab should be part of the build (dev server serves it anyway at `/lab-vehicles.html`).

## Catalog entry

`{ id, name, brand, category, kind, tier (0..1), rarity (0..1), price, topSpeedKmh, accel0100 (s|null), accel060,
accelTarget {kmh,s}, seats, engineSound, palette [hex…], palette2?, desc, trafficWeight, layout, preset, legacy? }`

- `category`: compact | sedan | coupe | sports | super | muscle | classic | suv | pickup | van | luxury | service | truck |
  bus | small | motorcycle | bicycle | military. `kind`: car | truck | bus | van | small | motorcycle | bicycle | tank.
- Entries may carry `create(game, pos, yaw, opts)` (own controllable class), `buildPreview({lod, color})` (thumbnails,
  turntables, `renderVehicleThumbnail`) and `bake(color?)` (used by `bakeVehicle(id)`); the tank has all three.
- `engineSound` (for C): i4 | v6 | v8 | v12 | electric | diesel | bus | moped | motorcycle | bicycle (bicycles: silent).
- `preset` is the full physics/design preset (`VEHICLE_PRESETS[id]` holds the same object; `null` for the 6 legacy ids
  whose hand-tuned presets live in `presets.js`). UI code can ignore it.

## Vehicle instance (controllable)

Everything from the ARCHITECTURE contract plus:

| field | meaning |
|---|---|
| `kind`, `catalogId`, `name`, `brand`, `engineSound` | from the catalog entry |
| `seats[i]` | `{ pos, exit, pose: 'car'|'bike'|'truck', driver }` — `THREE.Vector3` in `object3d` local space (origin at wheel-centre height, -Z forward). Two-wheelers: `seats[0].pose = 'bike'` |
| `doors` | `THREE.Vector3[]` door handle positions (local) |
| `enginePos`, `exhaustPos` | local points for fire/smoke (E) |
| `dims` | `{ length, width, height }` |
| `occupied` | set by the player controller |
| `model.parts` | damage groups: `body, hood, trunk, frontBumper, rearBumper, doorFL, doorFR, doorRL, doorRR, glass, lights, wheels` (only those that exist). Each part group is positioned at its pivot; `userData.hinge = {axis:'x'|'y', sign, max}` on hood/trunk/doors, `userData.pivot`. Meshes are named by material key (`paint`, `glass`, …) with `userData.part`. Player geometry is never shared (vertices can be displaced). |
| `model.lampMeshes` | `{ headL, headR, tailL, tailR, revL, indFL, … }` individual lamp meshes (`userData.kind`, `userData.attach` = part the lamp sits on) |
| `model.extra` | animated groups: `steer` (bike fork/bars), `crank` (bicycle pedals), `drum` (cement mixer) |
| `fallen` | two-wheelers: rider is down (big hit or roll > 55°). `physics.autoRecover = true` (default) picks the bike up after 2.5 s when occupied and stopped — set it to `false` if D ejects the rider itself |
| `telemetry.lean` / `.wheelie` / `.fallen` | two-wheelers: visual lean (rad, + = right), wheelie pitch, fall flag |
| `setIndicator(-1|0|1|2)` | turn signals / hazards (emissive only) |
| `siren`, `hasSiren` | light bar (police, fire chief, patrol SUV, tow amber, ambulance, fire engine) |
| `setPaint({color, finish})`, `setColor(hex)`, `setPaintFinish(f)` / `setFinish(f)`, `finish` | respray. Finishes: `color` (factory), `gloss`, `metallic`, `pearl` (full clearcoat, low clearcoat roughness), `matte`. The paint is a `MeshPhysicalMaterial` created with clearcoat 0.0001, so finishes only change uniforms (verified: program count constant). Keeps E's `damage.mats` snapshot in sync, so repair restores the new paint |
| `setWindowTint(0..1)` | glass darkening (uniforms only) |
| `refillBoost()`, `boostLevel` | nitro to full / level 0..1 (`null` without nitro) |

## Traffic bake

`bakeVehicle(id)` (cached) → `{ id, geo, wheelGeo, wheel (= wheelGeo), wheels: [{x, y, z, r, w, front, left}], length, width,
height, wheelbase, track, radius, palette, kind, tris }`.

- Frame = the same as `TrafficModels.bakeCar`: origin on the ground (y = 0 is the tyre contact), x = 0 centreline,
  z = 0 midway between front and rear axle (tandem centre for 3-axle trucks), forward = −Z.
- `geo` attributes: `position, normal, color` (base rgb), `aPaint` (1 = body paint → instance tint), `aEmit` (vec2: head, tail).
- `wheels[].y` = wheel-centre height (= r): wheel bottoms touch y = 0. Up to 6 wheels (trucks with tandem axles, coach tag
  axle); bikes have 2 wheels on x = 0; the tuk-tuk has 3.
- Low LOD: every vehicle ≤ 3 000 body triangles (max 2 948), wheel ≈ 260–330 triangles.
- If traffic still looks sunk: the body origin must be placed at the **ground point** (not at the collider centre); with
  the current Traffic.updateVisual this means `TMP.set(0, -(a.lift + a.halfH), 0)` must equal the ground offset of the
  physics body for that type — check `lift`/`halfH` against `baked.height`.

## Headlights (no-freeze)

- `initHeadlightPool(scene)` creates exactly 2 `SpotLight`s (+ targets) once; they stay in the scene, always visible,
  never cast shadows. `Vehicle` constructor also calls it (idempotent), so the first vehicle created at boot is enough.
- `vehicle.setHeadlights(on)` only claims the pool and changes `intensity` (0 ↔ 38); switching cars moves the same two
  lights. Lamp glow, brake, reverse, indicators and sirens are emissive intensity only. No material is created or flagged
  `needsUpdate` at runtime (per-side indicator materials are cloned once in the constructor).

## Previews (UI)

`createThumbnails(game, { width = 384, height = 216 })` → service:

- `get(id)` → `HTMLCanvasElement | ImageBitmap | null` (cached; a miss queues a render), `request(id, priority)`,
  `onReady(cb(id)) → unsubscribe`, `getDataURL(id)`, `prefetchAll()`, `size {width,height}` (×DPR, max 2).
- `createTurntable(containerEl, id)` → `{ setId(id), dispose() }`: live rotating preview (~30 fps while visible, drag to
  rotate, stops when hidden/detached).
- Renders with `game.renderer` into its own render targets and private studio scene (hemisphere + 1 directional light +
  RoomEnvironment, created once); never touches the main scene, never creates a WebGL context. Tone mapping runs on the
  GPU, read back with `readRenderTargetPixels`.
- Queue: at most one thumbnail per animation frame, split in two frames (build model / render), only while
  `game.paused` (menu open) or a turntable is alive. Card thumbnails use the low LOD (~1–4 ms build, ~1 ms render).
- Cache: memory + IndexedDB (`leonida-thumbs`, key = id + version + size + hash of the preset), so later visits are instant.
- Aircraft/boats: built via `src/air/models/{helis,planes}.js` and `src/boat/models.js` (lazy imports); any catalog entry
  may instead provide `buildPreview({lod}) → Object3D`. Real lights inside such models are stripped for the preview.
- One-off: `renderVehicleThumbnail(id, renderer, size = 256) → dataURL` (3/4 view, transparent background, cached).

## Tank (`id: 'tank'`, Ironwood Mastodon MBT)

Catalog: `category: 'military'`, `kind: 'tank'`, price $1,500,000, 65 km/h, seats 1, `engineSound: 'diesel'`,
`trafficWeight: 0`, palette desert sand / olive / grey-green / urban grey / forest. Spawned through `entry.create` →
`new Tank(game, {position, yaw, color, entry})` (works with `VehicleManager.spawn`, `game.spawnForPlayer('tank')`, the
economy garage, net `LocalPlayer`). Files: `src/vehicle/tank/{Tank,TankPhysics,TankModel,TankCamera,TankHud,Shells}.js`.

**Controllable surface** (same contract as `Vehicle`): `kind, catalogId, name, brand, engineSound, object3d, body,
telemetry, seats, doors, dims, enginePos, exhaustPos, occupied, destroyed, fixedUpdate, updateVisual, reset, setHeadlights,
setColor, setPaint, clearForces, setVelocity, dispose`, `camera` (= `TankCamera.get(game)`, the PlayerController already
uses `v.camera`), `turret` (truthy → G's HUD shows the crosshair), `model.parts.doorFL` = driver hatch (hinge, opens in the
enter animation), `model.lampMeshes`, `damageMeshes`, `explosionPower = 2.4`, `spec = TANK_SPEC` (`size`, `wheelRadius`).
Body origin is `TANK.originY` = 0.9 m above the ground at rest (like a car's wheel-centre origin); the model's ground is at
`object3d` y = −0.9 (`spec.wheelRadius` = 0.9 for code that offsets by it, e.g. J's bake origin).

**Driving** (`TankPhysics`, independent of `VehiclePhysics` and its global car grip/slide settings): 55 t rigid body,
convex hull with sloped nose/tail + cylinder turret collider, 9 raycast contact units per side (idler, 7 road wheels,
sprocket; 3 rays each for the player), springs/dampers (ζ ≈ 0.55/0.7) with progressive bump stops. Skid steering: each
track is driven toward its own surface speed through a combined-slip friction ellipse with smooth (tanh) saturation that
keeps the force direction (grip fades into scrub progressively, a spinning track loses side grip), net (regenerative)
power limit 1.1 MW. Steering:
- speed-sensitive yaw authority: 0.8 rad/s on the spot, then a lateral-acceleration budget of 2.9 m/s² (≈ 0.3 g, well
  inside the 0.78 side grip, so the hull never slides unless it pivots): 0.35 rad/s @ 30 km/h, 0.17 @ 60, 0.16 @ 65;
- the commanded yaw rate is filtered (τ 0.14 s standing → 0.36 s at speed, 0.55× when letting go) and rate-limited
  (1.4 rad/s²), so digital keys and sticks give the same smooth, progressive response (sticks also get a |x|^1.5 curve);
- a Coulomb-like scrub feed-forward plus light yaw-rate feedback (also damps heading wobble when driving straight) and a
  small leaky, clamped trim (integrates only near the target → no wind-up, no overshoot).
Turns on the spot, holds on 30° slopes without creep (anchor), climbs 0.9 m steps, can't roll over in normal driving
(upright torque beyond 37°, roll/pitch rate limit). Inputs from `DriveInput` (W/S/A/D, arrows, touch slider/gas/brake);
with a physical gamepad the tank drives with the left stick (+LT reverse) because RT is the trigger.

Handling before → after the high-speed tuning (`node src/vehicle/tank/handling.mjs`, full step steer from a steady speed):

| metric | before | after |
|---|---|---|
| step steer @30 km/h: yaw-rate overshoot / oscillations / rise (t90) | 3.2 % / 1 / 0.60 s (0.32 rad/s) | 0.1 % / 0 / 1.00 s (0.31 rad/s) |
| step steer @60 km/h: overshoot / oscillations / rise / max sideslip | 17.5 % / 3 / 0.55 s / 3.6° (0.32 rad/s) | 0.0 % / 0 / 0.90 s / 0.8° (0.17 rad/s) |
| lane change @50 / @60: settling after release, heading error | 0.43 s, −5.5° / 0.55 s, −6.0° | 0.63 s, −1.1° / 0.60 s, −0.9° |
| slalom @50 km/h (±1 every 1.2 s): max sideslip, max yaw rate, spin | 3.5°, 0.38 rad/s, no | 0.9°, 0.18 rad/s, no |
| braking 60→0 km/h: distance, nose dive, heading change | 21.7 m, 1.3°, 0° | 21.8 m, 1.1°, 0° |
| top speed over 4–12 cm ridges: roll/pitch-rate rms, yaw-rate rms | 0.051 / 0.048 / 0.0006 rad/s | 0.041 / 0.039 / 0.0004 rad/s |

Camera (`TankCamera`): no speed rumble any more (it read as twitchy steering), the pivot follows the hull rigidly in the
ground plane (no lag/lead) and with a soft vertical spring (suspension bounce no longer shakes the view); after 1.6 s
without aim input the view eases in behind the hull while it moves (keyboard-only driving no longer drives "sideways"
on screen).
Headless: `node src/vehicle/tank/test-tank.mjs` (18 checks) — 0–20 km/h 3.8 s, 0–40 8.6 s, 0–60 15.4 s, top 64.9 km/h,
reverse 25 km/h, 65→0 in 25 m, pivot ≥ 0.6 rad/s, slopes 20°/30° hold 0 cm, kerb/step 0.25/0.6/0.9 m climbed, no flip in
hard turns / slalom at top speed, ≈ 0.1–0.4 ms per fixed step. Sleeps when parked.

**Turret & cannon:** the turret yaw (0.9 rad/s) and gun pitch (0.55 rad/s, −8°…+20°, less depression over the engine deck)
follow `tank.aimPoint` with ballistic drop compensation; for the player `TankCamera` writes the point the screen centre
looks at (raycast vs the world and the terrain height field). Fire action (semi-auto, held = fire when loaded):
- mouse: left button while the pointer is locked (the first click in a tank captures the mouse; if the browser refuses the
  lock, clicks fire directly); right/left drag or pointer-lock movement aims; wheel = camera distance; **C** = gunner's sight
  (zoomed) / third person;
- keyboard: **Space** (the car handbrake key) fires;
- gamepad: **RT** fires, right stick aims, left stick drives, LT reverse/brake;
- touch (K): the handbrake button (pad A) already fires and the camera drag aims (right stick axes 2/3 or `camera.look`).
  A dedicated FIRE button can set `tank.fireHeld = true/false` (or call `tank.fire()`); with a real FIRE button the
  handbrake button can stay as is.
- scripts / AI: `tank.aimPoint = Vector3`, `tank.fire()` → bool, `tank.fireHeld`.

Reload 3 s (`tank.reloadLeft`), shell 320 m/s with gravity, one ray cast per physics step against the Rapier world (ground,
buildings, vehicles, traffic, props, characters; terrain height field / sea level fallback far from colliders), glowing
tracer, 6 s life. Impact: `game.fx.explode(pos, 1.6, { source: shooterTank, exclude: [shooterBody] })` (`source` is the
controllable, because `DamageSystem.onExplosion` skips `st.v === source`, so the shooter's own blast never hurts it),
plus a direct hit: other vehicles `damage.explode(v)`, traffic agents `agentHit` → `traffic.crash` → `igniteAgent(rec, 0)`
→ `explodeAgent` (takeover mode handled), tanks `tank.takeShellHit(pos, dir, shooter)`. Water hits splash + small blast.
Muzzle flash = additive mesh scaled from 0 (always rendered, no light), recoil slide, hull rock impulse, muzzle smoke and
blast dust, `camera:shake` 0.55 for the player.

**Crushing:** every fixed step the hull/turret colliders' contact pairs (contact distance < 6 cm) and the running-gear rays
are checked: any player/parked/abandoned vehicle (not tanks, not wrecks) → `damage.explode(v)`; any AI traffic agent →
explodes (same path as a shell). Tank vs tank is plain physics.

**Armour:** `tank.armor` 1 → 0. The tank wraps E's `VehicleDamage` when it is attached (setter on `tank.damage`):
`flammable = false` (no fuel fire), collisions dent at 15 % energy and cost `(e − 0.3)·0.06`, other explosions
`power·f·0.06` (×1.5 for power ≥ 2: another tank, a tanker; ×0.1 for a car the tank itself just crushed), shell blasts
`power·f·0.05`, direct shell hits 0.22 (front ×0.85, rear ×1.3) → **4 hits** destroy a tank (browser test: 0.72 → 0.43 →
0.15 → 0). `damage.engine = 0.16 + 0.84·armor`, so E's smoke shows from the 2nd hit (light) and 3rd (dark, limp).

**Destruction** (`src/vehicle/tank/Wreck.js`, every path verified in the game): armour reaching 0 (shell hits, nearby
blasts, crash damage, the net `takeShellHit`), fire reaching a holed tank (`damage.ignite(v)` with armour < 0.35; healthy
armour ignores fire) and any direct `damage.explode(v)` from other code all start the same sequence:
1. **cook-off** (1.1–2.0 s, 0.35 s for a direct `explode()`): the tank is dead in the water (no drive, no fire), flame jets
   and hot sparks blast out of the driver's hatch and the commander's cupola, growing in rate, small pops;
2. **blast**: E's `VehicleDamage.explode()` (power 2.4: fireball, shockwave, slow-mo near the camera, distance-scaled camera
   shake, charred wreck, the player inside is killed by D's handler); the 55 t hull only rocks;
3. the **turret is launched** as a 9 t physics body (debris `spawnMesh`, collides with the world): 9.5–13 m/s up
   (≈ 4.5–7.5 m high), random spin 3–7 rad/s; the gun is **bent** (drooping, 45 %), **torn off** as its own body (35 %) or
   stays (20 %); on landing: impact dust, concrete bits, sparks, a crater/scorch decal, camera shake for players within
   60 m, `impact` + `tank:turretLanded` events;
4. **aftermath**: a big fire in the turret ring (26 s) with a thick black smoke column (80 s) on top of E's wreck fire and
   smoke, 5 secondary explosions over ~6 s, one or both tracks thrown (hidden tread + track-link debris boxes) and the
   remaining treads hanging slack.
Debris: turret/barrel bodies live 75/70 s then shrink-fade (E's debris system: ≤ 16 mesh bodies, oldest recycled; link boxes
under `quality.debrisMax`); wreck jobs are capped (24) and cancelled on despawn/repair; bodies are only read after checking
they still exist in the world. `damage.repair()` restores armour, turret, gun, tracks and the turret collider. All random
choices come from `tank.wreckSeed` (mulberry32), so a replay with the same seed throws the same way.

**Events** (all on `game.events`):
| event | payload | when |
|---|---|---|
| `tank:fire` | `{ origin, position, dir, speed, t, tank, remote }` | every shot (audio: cannon) |
| `tank:hit` | `{ position, dir, kind: 'vehicle'\|'tank'\|'traffic'\|'building'\|'prop'\|'character'\|'ground'\|'water', target, tank, remote }` | shell impact |
| `tank:reload` | `{ t, total: 3, tank, ready? }` | player's tank: on fire (`t = 3`) and when loaded (`t = 0`) — G's HUD ring already listens |
| `tank:turret` | `{ tank, moving }` | player's turret starts/stops slewing (turret whine); `telemetry.turretSpeed` rad/s for a continuous level |
| `tank:crush` | `{ tank, vehicle\|agent, position }` | a vehicle was flattened |
| `tank:damage` | `{ tank, armor, cause: 'shell'\|'blast'\|'crash' }` | armour lost |
| `tank:struck` | `{ tank, shooter, position, armor }` | direct shell hit on a tank |
| `tank:cookoff` | `{ tank, seed, duration, cause, position }` | armour gone / fire / explode(): the cook-off starts |
| `tank:destroyed` | `{ tank, seed, position, quaternion, turretYaw, barrelPitch, color }` | the main blast (after `vehicle:destroyed`) — J: forward this to replay remotely |
| `tank:turretLanded` | `{ position, owner, part: 'turret'\|'barrel' }` | the thrown turret / gun hits the ground |
| `tank:wreckReplay` | `{ handle, seed }` | `playTankWreck` reached its blast |
| `camera:shake` | `{ amount: 0.55 }` | player fires |

Telemetry: everything the engine voice/foley needs (`rpm` 700–2600, 4 pseudo gears, `engineLoad`, `shiftId`, `wheels[4]`
summarising the track halves with surface names) plus `trackL`, `trackR` (m/s), `turretYaw`, `barrelPitch`, `turretSpeed`.

**HUD:** G's crosshair/reload ring (event-driven). `TankHud` adds a small orange ring where the gun actually points (lags
behind the crosshair while the turret slews); without G's HUD (noUI labs) it also draws a centre cross + READY/RELOADING
(`hud.ready` / `hud.reload`). Disable with `game.settings.tankReticle = false`.

**Multiplayer (J):** `tank.netState(out?)` → `{ turretYaw, barrelPitch, trackL, trackR, fireSeq, armor, reload,
destroyed, cookOff, wreckSeed }`;
`tank.applyNetState(s, dt)` on a remote puppet (sets turret/gun, scrolls the treads, marks it `remote` so it never aims or
fires locally); `tank.onFire(cb)` / `Shells.get(game).onFire(cb)` → `cb({ origin, dir, speed, t, tank, remote })`;
replay a remote shot with `tank.remoteFire({ origin, dir, speed?, damage = false })` (flash, recoil, events, visual
shell) or `Shells.get(game).spawnRemote({ origin, dir, speed })`. Instanced remote rendering: `bakeVehicle('tank')`
(= `entry.bake()`) returns the usual bake (`geo`, origin on the ground, `spec.wheelRadius = 0.9`) plus `hullGeo`,
`turretGeo` (turret space), `barrelGeo` (gun space), `turretPivot`, `barrelPivot` (model space) to articulate the turret.
Remote destruction: when a remote tank becomes destroyed (your `F_BURNING` flag, or a forwarded `tank:destroyed` with its
`seed`), call `playTankWreck(game, { position, quaternion, turretYaw, barrelPitch, color, seed, velocity?,
cookOff = true })` (exported from `src/vehicle/tank/Wreck.js` / `vehicle/index.js`). It plays the same seeded cook-off,
visual-only blast (`noWorld`), turret/gun throw, landing dust and aftermath with a throw-away low-LOD turret, and returns
`{ turretDetached, blasted, dispose() }`: zero-scale the instanced turret/barrel once `turretDetached` is true (until the
entry is gone), call `dispose()` when the remote leaves. Without the seed any number works (approximate).

**Performance:** no lights or materials are created at runtime: the 2 pooled headlight SpotLights are shared with cars,
muzzle flash and tracers are always-rendered meshes scaled to zero when idle, shells are a pool of 16 in two
`InstancedMesh`es (one module per game). Tank build ≈ 8 ms, high LOD ≈ 11.7 k triangles in 31 meshes (road wheels instanced:
2 draw calls for 14 wheels), tread scroll = texture offset, the lower track run follows the road wheels by a CPU vertex
update only when a wheel moves > 3 mm.

## Physics notes

- Two-wheelers (`spec.twoWheel`, `wheelLayout: 'bike'`): 2 raycast wheels on the centreline; the rigid body is held
  upright by a roll PD controller, the lean (up to 30–52° depending on the model) is visual (`telemetry.lean`). Arcade
  model: the input sets the lean (full lean from 80 % input), the lean maps to a cornering g within `spec.bike.gripG`
  (motorcycles 0.82–1.05 g, bicycles 0.55–0.72 g) and a yaw-rate controller makes the bike follow it at any speed
  (`physics.bikeYawDes`); counter-steer is invisible. Throttle is softened at deep lean and while steering hard
  (wheelie control keeps the front tyre loaded), so a corner exit under full throttle keeps turning. Motorcycles have
  near-critical damping, 12 cm travel, a damped bump stop, a rebound-velocity clamp (0.8 m/s), CoM ×0.9 and a little
  downforce: kerbs and seams don't launch them, ramps still do. Lateral tyre forces act at CoM height. A big hit (Δv > 7.5 m/s) or > 55° roll makes the bike fall (`fallen`, physical topple, no drive).
  Kickstand lean when parked unoccupied (`input.driver === false`), foot-down lean when occupied. Sport/naked/dirt bikes
  pop a visual wheelie on hard launches (`telemetry.wheelie`).
- Roll assist (`spec.rollAssist`, 0.35 cars … 1.0 trucks/buses/small): restoring torque only beyond ~5° of body roll
  relative to the ground while ≥ 2 wheels touch — no tip-overs in normal cornering; jumps/crashes can still flip.
- Low-speed static friction uses an effective mass that accounts for pitch inertia (fixes idle jitter on bicycles).
- `physics.setVelocity(v)` sets the body velocity without it registering as an impact (use when spawning with speed).
  (E's `DamageSystem` still sees the Δv: set `game.damage.get(v).suppress = 10` first, or the car is wrecked.)
- Standstill hold: with a driver and no pedals the car is held by a progressive auto-brake below ~1.5 m/s (full hold at
  rest, stronger on steep grades), so it doesn't creep or slide on 5–30 % slopes or cross slopes; brake at standstill
  still engages reverse, and a throttle launch has anti-rollback (no roll back on a 30 % hill start). Without a driver
  (`input.driver === false`) the parking brake is fully on. Drift over 10 s: ≤ 0.02 cm for every class.
- High speed: downforce ∝ v² (`aero.cla`, ×1.6 for `super`, ×1.3 for `sports`, balance 42 % front), the ESC grip budget
  includes the downforce, and a sideslip-rate damper (`YAW_DAMP`, cars > 12 m/s, off in a handbrake drift and for 0.5 s
  after an impact) settles turn-in overshoot and lift-off / brake snaps without changing steady cornering.
  Headless harness: `node src/vehicle/dev/highspeed.mjs [ids]` (smooth driver), `KB=1 …` (keyboard player through
  the real DriveInput), `KB=1 LEGACY=1 …` (keyboard without the yaw-rate steering).
- Keyboard steering (cars): `DriveInput.state` also carries `digital` (keyboard is the steering device) and `steerKb`
  (the untrimmed key ramp, `KB_RAMP` in `Input.js`; `steer` is unchanged for bikes, the tank, boats and aircraft). With
  `digital`, VehiclePhysics turns the key into a yaw-rate target above ~20 km/h (full key = 95 % of the grip incl.
  downforce, low-passed 0.15 s in / 0.06 s back) and a PI loop sets the wheel angle (`KB_STEER`): a held key sits at
  the limit, taps average out, a released key straightens (and counter-steers a slide) at once; off in a handbrake
  drift. Gamepad / touch (analog `steer`) keep the direct wheel angle. Any other input source (K's mobile pad, bots)
  can set `digital: true, steerKb` to get the same assist.
- Player car durability (`src/vehicle/durability.js`, wraps E's `VehicleDamage` through the `Vehicle.damage` setter):
  health lives in `damage.__hp` and is mapped onto E's `engine` scale (HUD bar = `engine`), so smoke starts below 25 %
  health and fire at ~6 %; crashes while the player drives (`occupied`) ignore impact energy < 0.1 and take 0.75× the
  stock health loss; the instant-fire rule needs e > 1.25 (stock 1.05); fires burn 1.8× longer before exploding.
  Explosions / server-resolved hits are unchanged (E's engine loss counts 1:1). Traffic agents are not Vehicles and keep
  the stock model. Vehicle damage is client-side (only the burning flag and dents go online), so nothing server-side.
- Tank steering at speed: `TANK.turnAccel` 6.0, `minTurnRate` 0.32 rad/s — full steer at 65 km/h yaws ≈ 0.32 rad/s
  (40 % of the 0.8 rad/s pivot), never zero.
- Trucks/buses: physics has 2 axles (rear = tandem centre); tandem/dual/tag wheels are visual.

### Tuning (headless, `node src/vehicle/tune.mjs`)

| id | kind | 0–100 s | 0–x s (target) | top km/h | brake m (from) | steady turn: lat g, roll°/lean° @ km/h | slalom | idle drift |
|---|---|---|---|---|---|---|---|---|
| pip | compact | 13.5 | — | 157 | 38.1 (100) | 0.99 g, 1.8° @60 | ok | 0 |
| meridian | sedan | 10.2 | — | 194 | 37.9 (100) | 0.98 g, 2.1° @60 | ok | 0 |
| kanzler_s | sedan | 3.4 | — | 305 | 33.5 (100) | 1.15 g, 1.6° @110 | ok | 0 |
| orkan_ts | sports | 2.7 | — | 320 | 31.7 (100) | 1.22 g, 1.4° @110 | ok | 0 |
| tempesta | super | 2.8 | — | 335 | 31.1 (100) | 1.27 g, 0.9° @110 | ok | 0 |
| hammerhead | muscle | 5.6 | — | 219 | 35.1 (100) | 1.08 g, 2.3° @110 | ok | 0 |
| grandview | classic | 9.5 | — | 189 | 41.3 (100) | 0.92 g, 2.8° @110 | ok | 0 |
| monarch | suv | 6.0 | — | 209 | 40.5 (100) | 0.92 g, 2.4° @110 | ok | 0 |
| sawbuck | pickup | 7.0 | — | 185 | 40.4 (100) | 0.91 g, 2.3° @110 | ok | 0 |
| kazoku | van | 8.8 | — | 194 | 41.7 (100) | 0.89 g, 2.1° @110 | ok | 0 |
| semi | truck | 33 | 11.0 (11 @60) | 123 | 17.4 (60) | 0.84 g, 1.7° @70 | ok | 0 |
| fire_engine | truck | 49 | 14.0 (14 @60) | 112 | 17.5 (60) | 0.79 g, 1.6° @70 | ok | 0 |
| city_bus | bus | — | 18.0 (18 @60) | 98 | 19.0 (60) | 0.76 g, 1.9° @70 | ok | 0 |
| saam (tuk-tuk) | small | — | 9.0 (9 @50) | 70 | 37.3 (100) | 0.61 g, 7.1° @40 | ok | 0 |
| fulmine | motorcycle | 3.1 | (2.9 @100, traction-limited) | 285 | 42.6 (100) | 1.04 g, lean 46° @60 | ok, falls on 45 km/h wall hit | 0 |
| roadhouse | motorcycle | 4.6 | — | 183 | 39.4 (100) | 0.97 g, lean 37° @60 | ok | 0 |
| piccola | motorcycle | — | 7.4 (7.5 @60) | 96 | 41.9 (100) | 1.03 g, lean 43° @60 | ok | 0 |
| aero | bicycle | — | 7.3 (7.5 @30) | 38 | 4.1 (25) | 0.70 g, lean 35° @20 | ok | 0 |

The legacy suite (crash at 300 km/h, curbs, ramps, handbrake, lift-off, 8 cm road steps, slope hold) is unchanged for the
6 original presets. Catalog `accel0100`/`accel060` show the simulated values after calibration (`accelMeasured`).

## Labs / tools

- `lab-vehicles.html` + `src/vehicle/lab-vehicles.js`: real game, side panel with every catalog vehicle (thumbnails),
  click to drive it, showroom mode (orbit around a rotating vehicle); the "Military" tab has the tank (telemetry shows
  armour, reload and turret angle).
- `node src/vehicle/tank/test-tank.mjs`: headless tank physics checks (accel, pivot, slopes, steps, no flip, drops);
  `node src/vehicle/tank/handling.mjs`: handling metrics (step steer overshoot, lane change, slalom, braking, bumps).
- `node src/vehicle/tune.mjs [ids…|--cat=sports] [--calibrate]` headless physics tests; `--calibrate` rewrites
  `calibration.js` so simulated 0–100 (or 0–60 / low-speed target) matches the catalog. `--slopes` (standstill hold on
  5–30 % / cross slopes, release while rolling, hill starts, reverse), `--bikes` (two-wheeler step steer, lateral g,
  corner exit, slalom, weave), `--bounce` (bumpy road takeoffs / airtime per km, ramp jump).
- Dev-only (not in the build): `/src/vehicle/dev/sheet.html` (live 3D grid, `?cat=`/`?ids=`), `/src/vehicle/dev/shots.html`
  (thumbnail contact sheet), `node src/vehicle/dev/probe2.mjs <id>` (launch trace), `probe3.mjs <id>` (idle drift).

## Performance

- Player model build (high LOD with damage parts, 10–31 k triangles): median 11 ms, p90 20 ms, max 35 ms (browser).
- Low LOD / traffic bake: median 1.6 ms / 2.1 ms, max 4.8 ms / 7.4 ms; baked body ≤ 2 948 triangles.
- Shader programs stay constant when spawning any vehicle type, toggling headlights, indicators or sirens.

## Known limits / requests

Tank:
- **K (mobile):** a tank context would be nicer than the car layout: left stick → drive (or keep slider + gas/brake),
  a FIRE button → `game.player.controllable.fireHeld = true/false`, camera drag → `controllable.camera.look(dx, dy)`.
  Until then the car layout works (handbrake button fires).
- **C (audio):** cannon on `tank:fire`, impacts on `tank:hit` (the explosion itself already emits `explosion`), optional
  turret whine from `tank:turret` / `telemetry.turretSpeed`, track clatter from `telemetry.trackL/trackR`; the engine is the
  `diesel` profile (`kind: 'tank'`, no `KIND_DEFAULT` entry needed because `engineSound` is set).
- **E (damage):** the tank patches its own `VehicleDamage` instance (see Armour). A native hint would be cleaner, e.g.
  `controllable.armor` handling or `damageScale` per source; `VehicleDamage.explode()` lifts every wreck by
  `m·(5.5–8)·min(1.3, power)` — the tank damps that right after the `vehicle:destroyed` event.
- **G (UI):** `cat.military` exists; the HUD may use `tank.reloadLeft`, `tank.armor` and `tank.gunAimPoint(v3)`.
- **J (net):** remote tank destruction → `playTankWreck(...)` + hide the instanced turret/barrel while
  `handle.turretDetached` (see Multiplayer); forward `tank:destroyed.seed` (or `netState().wreckSeed`) for an identical throw.
  `NetCombat._damage` returns after `takeShellHit` for tanks even when the server says `destroyed`; calling
  `game.damage.explode(v)` there would keep the local tank in sync (it runs the short cook-off + turret toss).
- **Integrator:** `VehicleManager.postStep` lifts any body whose origin is < 0.12 m above the ground — the tank origin is
  0.9 m up for that reason. `spawnForPlayer` works as is.

- Traffic: cap AI `vmax` with the entry's `topSpeedKmh` (bicycles 28–38 km/h, golf cart 30, tuk-tuk 70, buses 100).
  Bikes in traffic have 2 wheels (`baked.wheels.length === 2`), the tuk-tuk 3.
- D (characters): `seats[0].pose` is `'bike'` for motorcycles, bicycles and the tuk-tuk, `'truck'` for trucks/buses.
  Set `vehicle.physics.autoRecover = false` if the controller ejects the rider when `vehicle.fallen` becomes true.
- C (audio): use `entry.engineSound` / `vehicle.engineSound`; `VEHICLE_PRESETS[id].audio` still has the legacy
  character block for every id.
- Trailers for the semi tractor are not modelled (fifth wheel only).
- B (boats / aircraft): the standstill hold and parking brake above are ground-vehicle only (VehiclePhysics); boats and
  aircraft on a slope or ramp use B's own code.
- E (damage): player durability wraps `applyImpact` / `applyExplosion` / `ignite` per instance (like the tank and
  Services' armour, which chains on top). A native per-vehicle `damageScale` / threshold hint would be cleaner.
- Road surface: on the highway edge 2424 (≈ x −2855, z 1027, heading 0.55 rad) the ray-cast road height steps 33 cm
  at ~358 m and 10 cm at ~450 m along the centre line; a car crossing at 250 km/h takes damage (health 1 → 0.86).
