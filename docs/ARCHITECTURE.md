# Leonida Drive — architecture & module contracts

Vite 8 + three@0.187 + @dimforge/rapier3d-compat@0.21, plain ES modules (no TypeScript, **no new npm deps**).
World: Y-up, metres, seconds. North = -Z, east = +X. Data coords: x = map "lng", z = -map "lat".
Fixed physics step 1/60 s. Right-hand traffic.

## Boot & the `game` context

`src/core/bootstrap.js` exports `createGame(container, options)` → `Promise<game>`. It loads data, builds the world,
physics, player, UI and starts the loop. Every feature module is registered on the context.

```js
import { createGame } from './core/bootstrap.js';
const game = await createGame(document.getElementById('app'), {
  autostart: true,            // skip the "Play" button (labs)
  spawn: { x: 1745, z: -640 }, // optional spawn point (snapped to the nearest road)
  hour: 17.5,                 // optional start time
  modules: [ (game) => new MyModule(game) ], // extra modules, created after the world is ready
  noTraffic, noPeds,          // optional, for lightweight labs
});
```

`game` fields (owner in brackets):

| field | what |
|---|---|
| `THREE`, `RAPIER` | libraries |
| `scene`, `camera`, `renderer` (three WebGLRenderer), `render` (post/quality, **F**) | rendering |
| `world` (Rapier), `eventQueue` | physics |
| `events` | event bus: `on(name, fn) → off`, `once`, `emit(name, payload)` |
| `input` | `InputManager` (keyboard/mouse/gamepad, `held(code)`, `pressed(code)` = this frame, `gamepad`) |
| `uniforms` | global shader uniforms (`src/core/globals.js`) — `uTime, uWetness, uRain, uCloudCover, uWind, uNight, uSunDir, uLightning` |
| `settings` | user settings object; `game.applySetting(key, value)` |
| `quality` | active quality profile (see below) |
| `terrain` | `heightAt(x,z)`, `groundAt(x,z)` (ground class), `G` (class ids), `inBounds` |
| `roads` | graph: `edges`, `nodes`, `adj`, `nearest(x,z,r,filter)`, `route(...)`, `lamps` |
| `buildings` | `query(x,z,r) → ids`, `info(id)`, `remove(id)`, `damage(id, amount)` |
| `veg` | trees: `query(x,z,r)`, `breakTree(type,id,dir,strength)` |
| `lamps` | street lamps (breakable) |
| `sky` | `time` (hours), `setTime(h, {smooth})`, `night` 0..1, `sunDir`, `clock` (**F** owns Sky.js) |
| `weather` | **F**: `state`, `rain`, `wetness`, `cloud`, `fog`, `wind`, `set(name, seconds)` |
| `water` | **F** |
| `traffic` | AI cars: `agents`, `takeOver(agent)`, `nearestAgent(pos,r)` |
| `vehicles` | vehicle manager: `catalog` (array of entries), `spawn(id, pos, yaw, opts)`, `active` (full-physics controllables), `nearestEnterable(pos, r)`, `despawn(v)` |
| `player` | **D** `PlayerController`: `mode` ('foot'\|'vehicle'\|'free'), `controllable`, `character`, `health`, `armor`, `money`, `addMoney(n,pos)`, `enter(v)`, `exit()`, `teleport(x,z)`, `setWaypoint(w)` |
| `fx` | **E** particles/explosions: `explode(pos, power)`, `fire(pos, …)`, `smoke`, `sparks`, `dust`, `debris` |
| `damage` | **E** vehicle damage: `attach(controllable)`, health, deformation, fire, explosions |
| `audio` | **C** `AudioSystem` (see below) |
| `i18n` | **G** `t(key, params)`, `lang`, `setLang(code)`, `languages` |
| `ui` | **G** HUD + menus: `toast`, `notify`, `showHelp`, `wasted(bool)`, `setMode(text)`, `open(tab)`, `close()` |
| `world3d` | area helpers: `areaAt(x,z) → {name, sub, wealth}` (districts/regions) |

### Module lifecycle
A module is any object; `game.register(module, order = 0)`. The loop calls (if defined):
- `fixedUpdate(dt, game)` — every 1/60 s step, **before** `world.step` (apply forces/velocities)
- `postStep(dt, game)` — after each `world.step`
- `update(dt, game, alpha)` — once per frame (alpha = physics interpolation 0..1)
- `lateUpdate(dt, game)` — after the camera moved (billboards, audio listener, UI)
- `dispose()`
Lower `order` runs first.

### Controllable interface (everything the player can drive/fly/ride)
```
kind: 'car'|'truck'|'bus'|'van'|'small'|'motorcycle'|'bicycle'|'heli'|'plane'|'boat'
catalogId, name, object3d, body (RAPIER.RigidBody)
fixedUpdate(dt, input)          // input.driver === false → nobody inside: hold brake / idle
updateVisual(alpha, dt)
telemetry: { speedKmh, rpm, maxRpm, gear, throttle, boost, airborne, upsideDown, impactStrength, ... }
seats: [{ pos: THREE.Vector3 (local), exit: THREE.Vector3 (local, beside the door) }]
camera?: object with update(dt, controllable) and snap(controllable) — optional custom camera (aircraft)
occupied: boolean, setHeadlights(on), reset(pos, yaw), dispose()
damage: set by game.damage.attach() (E)
```
`input` for cars is the `DriveInput` state `{throttle, brake, steer, handbrake, boost, driver}`; unoccupied vehicles get
`NEUTRAL` from `src/world/VehicleManager.js`. Aircraft/boats read `game.input` themselves when `occupied`.

### Events (payloads are plain objects)
| name | payload |
|---|---|
| `contact` | `{ c1, c2, h1, h2, force, dirX, dirZ }` Rapier contact-force events (all of them, each step) |
| `impact` | `{ position, strength 0..1, kind: 'vehicle'\|'building'\|'prop'\|'tree'\|'ped'\|'water', material, source }` |
| `explosion` | `{ position, power (≈1 = car), radius }` |
| `fire:start` / `fire:stop` | `{ position, target }` |
| `vehicle:spawn` / `vehicle:enter` / `vehicle:exit` / `vehicle:destroyed` | `{ vehicle }` |
| `money:pickup` | `{ amount, position }` |
| `ped:knocked` | `{ position, ped, strength }` |
| `building:destroyed` / `building:damaged` | `{ id, position, size }` |
| `tree:broken` / `lamp:broken` | `{ position, type }` |
| `lightning` | `{ position, distance }` |
| `horn` | `{ vehicle, on }` |
| `footstep` | `{ position, surface, run }` |
| `splash` | `{ position, strength }` |
| `ui:click`, `ui:hover`, `ui:open`, `ui:close`, `ui:notify` | `{}` |
| `wasted`, `respawn`, `weather` (`{state}`), `time:skip` | — |

### Collision groups (`src/vehicle/groups.js`)
Membership bits: GROUND 0x1, STATIC 0x2 (buildings, bridges), VEHICLE 0x4 (player-driven & abandoned full-physics),
PROP 0x8 (trees, lamps, debris), TRAFFIC 0x10 (AI cars), CHARACTER 0x20, PICKUP 0x40.
`groups(membership, filterMask)` packs them.

### Audio API (C)
`game.audio`: `start()` (user gesture), `setVolume(bus, v)` buses `master|sfx|engine|ambient|music|ui`,
`play(name, {position?, volume?, pitch?, bus?})`, `loop(name, {position?|object3d?, volume?, pitch?}) → {set(params), stop()}`,
`createEngine(profile, {object3d}) → {update(telemetry, dt), setOccupied(b), dispose()}`
(profiles: `i4, v6, v8, v12, electric, diesel, bus, moped, motorcycle, bicycle, heli, prop, jet, boat`).
The audio module also listens to the events above and plays the right sounds itself (impacts, explosions, money, UI…).

### Quality profiles (F)
`game.quality` = `{ name: 'low'|'medium'|'high'|'ultra', pixelRatio, shadows: 0|1|2|3, shadowMapSize, cascades, bloom, ao, ssr,
vegRadius, trafficMax, pedsMax, debrisMax, particlesMax, reflections }` — auto-detected at start, user-selectable.
Modules must read their budgets from it.

## Game modes: online (default) vs singleplayer sandbox

`game.mode` is `'online'` (default) or `'single'`. It is chosen from `?mode=` in the URL, then
`localStorage['leonida.mode']`. Switch with `game.switchMode(mode)`, which persists the choice and reloads.

Use `game.can(cap)` to gate every sandbox control:

| cap | single | online |
|---|---|---|
| `vehicleSpawn` (garage / vehicle picker) | yes | yes (server rate-limited) |
| `freeCam`, `waypoint`, `photo` | yes | yes |
| `weather`, `time`, `timeScale` | yes | no: the server drives a shared clock and weather |
| `money` (give or take cash), `teleport` (map teleport, fast travel) | yes | no: the wallet is server-authoritative |
| `godMode`, `repair` (instant), any other cheat | yes | no |

In online mode, the UI hides these controls instead of disabling them. Gameplay income (drift, stunts,
pickups) still works, but goes through the server wallet (`src/net`).

## File ownership (do not edit files you don't own; ask the integrator)
- **Integrator**: `src/main.js`, `src/core/{bootstrap,Game,events,input,globals}.js`, `src/world/{Terrain,Roads,Buildings,Vegetation,Scatter,models,palette,regions,Traffic,TrafficModels}.js`, `tools/**`, `vite.config.js`, `package.json`, `docs/**`.
- **A — vehicles**: `src/vehicle/**` (except `EngineAudio.js`), `lab-vehicles.html`.
- **B — aircraft & boats**: `src/air/**`, `src/boat/**`, `lab-air.html`.
- **C — audio**: `src/audio/**`, `src/vehicle/EngineAudio.js`, `lab-audio.html`.
- **D — characters**: `src/characters/**`, `lab-characters.html` (replaces `src/world/Pedestrians.js` later).
- **E — damage/fx/destruction**: `src/fx/**`, `src/damage/**`, `lab-fx.html`.
- **F — weather/sky/render**: `src/weather/**`, `src/world/Sky.js`, `src/world/Water.js`, `src/core/Renderer.js`, `src/core/quality.js`, `lab-weather.html`.
- **G — UI/i18n**: `src/ui/**`, `src/i18n/**`, `lab-ui.html`.

Each workstream writes `src/<area>/INTEGRATION.md` (what to import, how to register, events used/emitted, known limits).
