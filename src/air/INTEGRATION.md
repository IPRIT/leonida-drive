# Aircraft & boats (workstream B) — integration

Owner: B. Files: `src/air/**`, `src/boat/**`, `lab-air.html`. No new npm dependencies.

## Register

```js
// src/main.js
import { createGame } from './core/bootstrap.js';
import { airModule } from './air/index.js';

createGame(document.getElementById('app'), {
  modules: [airModule], // adds AIR_CATALOG + BOAT_CATALOG to game.vehicles
});
```

`airModule(game)` only calls `game.vehicles.addCatalog([...AIR_CATALOG, ...BOAT_CATALOG])`. After that,
`game.vehicles.spawn(id, pos, yaw, opts)` and `game.spawnForPlayer(id)` work for every id below.
Each vehicle implements the Controllable interface from `docs/ARCHITECTURE.md` and owns its camera (`v.camera`).

`opts` for `spawn`: `{ air: true }` spawns planes at 300 m with cruise speed and helicopters hovering 25 m above
the tallest obstacle; `{ altitude }` overrides that height; `{ color }` sets the paint; `{ water: false }` puts the
seaplane on a runway; `{ forceThreshold: true }` always moves a plane to the runway threshold.

Placement rules:
- Planes: on a runway → lined up on it; otherwise → threshold of the nearest runway (found in `game.roads`, see
  `findRunways`). Detected: two runways at VCIA (1481 m, 1464 m) and two at Goose Key (1067 m, 819 m).
- Seaplane: nearest open water (terrain < −2 m), bow towards the longest open stretch.
- Helicopters: on the ground at `pos`, moved to the nearest spot with no building within rotor radius + 1.5 m. Over
  water they spawn hovering.
- Boats: nearest open water (terrain < −1.5 m; airboat −0.5 m), facing open water.

## Lab & tests

- `http://127.0.0.1:5317/lab-air.html` (`?v=<id>` first vehicle, `?traffic=1` with AI traffic): spawn/enter buttons,
  airborne-spawn toggle, teleports (VCIA, Goose Key, bay, Grassrivers swamp, Downtown, ocean), day/dusk/night, pointer
  lock, live telemetry and physics ms/step, controls overlay.
- `node src/air/sim-test.mjs [filter]`: headless Rapier tests (hover, climb, auto-brake, yaw, turn, landing, crash,
  rotor strike, ditching; take-off distance/speed, cruise stability, top speed, roll rate, stall + recovery, landing,
  tunnelling; boat buoyancy, top speed, stability, turning circle, reverse, beaching, airboat on grass) + perf bench.

## Catalog

| id | name | brand | category | tier | price | top km/h | seats | engineSound |
|---|---|---|---|---|---|---|---|---|
| heli_news | Vella N2 | Vireo Rotorworks | heli | 2 | 650 000 | 225 | 2 | heli |
| heli_police | Sentry U4 | Corvane | heli | 3 | 1 450 000 | 260 | 4 | heli |
| heli_cargo | Mule T2 (tandem rotor) | Brannock Heavy Lift | heli | 4 | 3 900 000 | 275 | 4 | heli |
| plane_trainer | Pipit 150 (high wing) | Halcyon Aircraft | plane | 1 | 240 000 | 230 | 2 | prop |
| plane_stunt | Vortica S1 (taildragger) | Brio Aero | plane | 3 | 780 000 | 340 | 1 | prop |
| plane_seaplane | Tarpon F4 (floats) | Gulfline | plane | 2 | 520 000 | 250 | 4 | prop |
| plane_jet | Solstice 7 (business jet) | Lumen Aviation | plane | 5 | 8 500 000 | 780 | 6 | jet |
| boat_speed | Riptide 33 | Coral Marine | boat | 3 | 285 000 | 110 | 2 | boat |
| boat_jetski | Zipfin JX | Wavelynx | boat | 1 | 16 500 | 94 | 2 | boat |
| boat_cruiser | Sunward 38 (cabin cruiser) | Marisol Yachts | boat | 4 | 640 000 | 64 | 2 | boat |
| boat_airboat | Glade Runner | Sawgrass Works | boat | 2 | 48 000 | 70 | 3 | prop |

Seats: `{ pos, exit, pose: 'heli' | 'plane' | 'boat' }` in local space (x right, y up, −z forward, origin = centre of
mass for aircraft, static waterline for boats).

## Controls (vehicles read `game.input` themselves when `occupied` and `input.driver !== false`)

Ctrl is not used anywhere: Ctrl+W would close the browser tab mid-flight.

| | Keyboard | Gamepad |
|---|---|---|
| **Helicopter** | Space climb · Shift descend · W/S nose down/up (cyclic) · A/D bank · Q/E yaw · N hover assist on/off · H landing light / searchlight · L police strobes | LS cyclic · RT/LT up/down · LB/RB yaw · d-pad → assist |
| **Plane** | Shift/Z throttle up/down (lever) · S pull, W push · A/D roll · Q/E rudder · Space wheel brakes · G flaps (0 → 1 → 2 → 0) · B gear (jet) · N flight assist · X smoke (stunt plane) · H landing light. With pointer lock the mouse is a yoke | LS stick · RT/LT throttle · LB/RB rudder · A brakes · d-pad ↓/↑ flaps · ← gear · → assist · X smoke |
| **Boat** | W throttle · S reverse · A/D steer · Space idle · H lights | RT/LT throttle/reverse · LS steer |
| **All** | C camera chase → far → cockpit · drag mouse / right stick to look around (returns after 2 s) · R reset (in the air: level at the current altitude; wrecked/drowned: repaired) | |

Assists (on by default): helicopters hold altitude when the collective is centred, level out and brake to a hover
when the stick is centred, auto-flare near the ground, and stay planted after landing until you climb. Planes
auto-trim for level flight (bank-compensated), limit g and angle of attack (no stall unless assist is off), coordinate
turns and slowly level the wings.

## Telemetry (`v.telemetry`)

Common: `kind, speedKmh, forwardSpeed, airspeed (km/h), verticalSpeed (m/s), altitude (m above ground/water),
altitudeAsl, heading (deg, 0 = north), pitch, roll (deg), throttle 0..1, rpm, maxRpm, gear, airborne, upsideDown,
impactId, impactStrength, inWater, submerged, onWater, health 0..1, destroyed, gForce`.
- Helicopter: `rotorRpm` (= `rotor`) 0..1, `collective, yawRate (rad/s), grounded, landed, assist, engineOn, groundEffect,
  rotorBroken`.
- Plane: `airspeedKmh, aoa (deg), stall, flaps 0..1, flapsTarget, gearDown, gearPos 0..1, brake, braking, onGround, landed,
  assist, engineOn`.
  `rpm/maxRpm`: prop rpm (2600–2900) or jet N1 % (max 100).
- Boat: `planing 0..1, onLand, reversing, propOut, wet, steer`; `gear` is 1 / −1 (reverse).

## Events emitted

- `impact` `{ position, strength, kind: 'vehicle'|'building'|'water'|'tree', material, source }` on crashes, rotor strikes,
  touchdowns.
- `splash` `{ position, strength }` when a hull/fuselage hits the water.
- `vehicle:destroyed` `{ vehicle }` on heavy crashes, rotor strikes or explosions; then `game.fx.explode(pos, 1.2)` (1.0 for
  boats) if FX exists, otherwise an `explosion` event `{ position, power, radius }`.
- `tree:broken` when a rotor cuts a tree (uses `game.veg.breakTree`).
- `vehicle.drowned = true` after an aircraft has been under water for a few seconds (BasicPlayer → WASTED).

## Audio

`game.audio?.createEngine?.(profile, { object3d })` with `heli`, `prop`, `jet` or `boat`; `update(telemetry, dt)` every frame,
`setOccupied(b)` on enter/exit, `dispose()` on despawn. Useful telemetry: `rpm/maxRpm, throttle, speedKmh, rotorRpm (heli),
planing (boat), destroyed`.

## i18n keys (fallback English)

| key | text |
|---|---|
| `air.hoverAssistOn` / `air.hoverAssistOff` | HOVER ASSIST ON / HOVER ASSIST OFF |
| `air.flightAssistOn` / `air.flightAssistOff` | FLIGHT ASSIST ON / FLIGHT ASSIST OFF |
| `air.flaps` | FLAPS {n} |
| `air.gearUp` / `air.gearDown` | GEAR UP / GEAR DOWN |
| `air.smokeOn` / `air.smokeOff` | SMOKE ON / SMOKE OFF |

Shown with `game.ui.notify(text, 1.6)`.

## Stable exports used by other workstreams

`src/vehicle/Thumbnails.js` (A) imports `buildHeliModel(id, spec)` from `src/air/models/helis.js`, `buildPlaneModel(id, spec)`
from `src/air/models/planes.js`, `buildBoatModel(id)` from `src/boat/models.js`, `HELI_SPECS` / `PLANE_SPECS` from
`src/air/specs.js` and `PLANE_SPEC_ID` from `src/air/Plane.js`; `Traffic.js` imports `findRunways`. Keep these names.

## Internals

- Physics cores are DOM-free and run in Node: `src/air/physics/{Craft,HeliPhysics,PlanePhysics}.js`, `src/boat/BoatPhysics.js`,
  specs in `src/air/specs.js`, `src/boat/specs.js`. Tests: `node src/air/sim-test.mjs [filter]`.
- Rapier dynamic bodies, collision group VEHICLE / filter ALL, CCD on, colliders with density 0 + additional mass properties.
  Forces are applied as impulses every fixed step; impacts are detected from velocity changes not explained by our own
  impulses (same approach as the car physics).
- Unoccupied craft farther than 480 m from `player.focus` are disabled (`body.setEnabled(false)`) because terrain/road
  colliders only exist near the player, and re-enabled within 420 m.
- Water surface: `src/boat/waves.js` `waterHeight(x, z, t, calm)` uses the swell directions/frequencies of `Water.js`
  with a 0.1–0.2 m amplitude (the rendered water is flat), calmer in shallow water, rougher with `game.weather.wind`.
- Shared particles (`SprayFX`: spray, mist, splash, dust, smoke, smoke trail; max 2400 points, one draw call) and foam
  wake ribbons (`FoamTrail`, one draw call) are registered as a `lateUpdate` module on first use.
- One `AirCamera` per game (`AirCamera.get(game)`), configured by each vehicle's `camCfg`.

## Needs from the integrator / other workstreams

1. Runways vs traffic: done — `Traffic.js` already uses `findRunways` to keep AI cars off the runways. Peds (D) should
   do the same if they spawn along road edges.
2. **Collider streaming at aircraft speeds** (`Streaming.js`): buildings beyond 120 m are added 2 per 0.35 s. A jet at
   200 m/s can outrun that. Please stream around `focus + velocity × 1.5 s` and raise the building budget with speed.
3. **Garage list is built before modules run** (`createUI` reads `game.vehicles.catalog` once): aircraft/boats appear in
   the pause-menu garage only if the menu reads the catalog lazily or gets a refresh call. Catalog entries carry
   `category`, `brand`, `tier`, `price`, `topSpeedKmh`, `seats`, `desc` for the UI.
4. **Wasted on vehicle destruction**: BasicPlayer only checks `drowned` / player health. When the player's aircraft emits
   `vehicle:destroyed`, the player should die (D / integrator).
5. **Key conflict**: README lists `G` as "change vehicle"; aircraft use `G` for flaps (as requested). The current code does
   not bind `G` elsewhere.
6. `vite.config.js`: add `lab-air.html` to `build.rollupOptions.input` if the lab should be part of the build.
7. F (water): if you add vertex waves, use `waterHeight` from `src/boat/waves.js` so hulls and the surface agree.
8. Observed while testing (not B's files): a world material fails to compile (`'uTime' : undeclared identifier` in a
   MeshStandardMaterial rain/puddle shader); `createGame({ hour })` is not applied.

## Known limits

- Jet lift-off is ~170 km/h with one flap notch (~155 km/h with full flaps); the light planes lift off at 100–135 km/h.
- No wind/turbulence yet (the plane model takes `env.wind` easily); no propeller torque/P-factor; no autorotation.
- Helicopter rotor strikes use 6 rays per rotor every other step; thin poles can be missed.
- Planes keep the gear raycast suspension on uneven grass, but there is no tyre slip model (lateral friction only).
- Boats do not capsize-and-sink; upside-down boats need `R`.
- Searchlight/landing lights do not light the water (custom water shader is unlit by scene lights).
- Parked craft far from the player are frozen (body disabled) and do not bob on waves.
