# FX, damage & destruction (workstream E)

Files: `src/fx/**` (particles, explosions, debris, decals, lights), `src/damage/**` (vehicle damage, trees,
buildings), `lab-fx.html` + `src/fx/lab-fx.js` (test bench).

## Register (src/main.js)

```js
import { FX } from './fx/FX.js';
import { DamageSystem } from './damage/DamageSystem.js';

createGame(document.getElementById('app'), {
  modules: [
    (game) => {
      game.fx = new FX(game);            // order 60
      game.damage = new DamageSystem(game); // order 55, attaches vehicles that already exist (the first car)
      game.register(game.fx, game.fx.order);
      game.events.on('camera:shake', ({ amount }) => game.player?.chase?.shake?.(amount)); // or read game.fx.shake
      return game.damage;
    },
  ],
});
```

Call `game.fx.prewarm(renderer, camera)` after the scene is built (it is also called automatically on the
second frame). `DamageSystem` needs `game.fx` for visuals but works without it (damage only). `FX.explode` works without
`DamageSystem` (minimal fallback: crashes traffic, breaks trees, damages buildings).

Add `lab: resolve(import.meta.dirname, 'lab-fx.html')` to `vite.config.js` `build.rollupOptions.input` if the
lab should be part of the build. Lab URL params: `?timer` drives the loop with timers (hidden/background tabs),
`?x=..&z=..` spawn point, `?lite` no pedestrians.

## No-freeze rules (no recompiles, no light-count changes)

- `FxLights`: 4 PointLights (2 on `low`) created in the constructor, always in the scene, always visible,
  `castShadow = false`; idle = intensity 0. Never added/removed/toggled at runtime.
- All FX geometry/materials are created once at init: flames, smoke, sparks (instanced quads), chunks, box debris
  (InstancedMesh, capacity 200), decals (one merged mesh, 64 slots), shockwave rings (6, always visible, idle =
  alpha 0 / tiny scale). Rubble meshes and broken-lamp swaps reuse two materials owned by `DamageSystem`.
- No `material.needsUpdate` anywhere; damage darkening/charring/glass/lamp-off only change uniforms
  (`color`, `emissive`, `roughness`, `metalness`) or swap to the prewarmed broken-lamp material.
- `fx.prewarm(renderer, camera)` compiles every FX material plus `damage.prewarmObjects()` (rubble + broken lamp)
  via `renderer.compile(obj, camera, scene)`.
- Load caps: simultaneous fires above `fx.maxFires` (10) share one emission budget; explosions in the same frame
  share the particle budget; burning vehicles/agents detonate through a queue at least `damage.explodeGap`
  (0.18 s) apart; building collapses are queued one per 0.12 s; at most `damage.maxBurningAgents` (8) AI cars burn
  at once; box debris capped by `quality.debrisMax`, collapse chunks ≤ 130 alive and baked to static rubble.

## game.fx API

| call | notes |
|---|---|
| `explode(pos, power = 1, o)` → `{position, power, radius}` | power ≈ 1 car, 1.6 truck, 2+ triggers slow-mo near the camera. Radius `7 + 5·√power`. `o`: `radius`, `exclude: [RigidBody]`, `source`, `noWorld`, `noPhysics`, `scorch`, `debris`, `fire` (ground fire seconds) |
| `fire(pos, o)` → handle | `o`: `size`, `duration`, `attachTo` (Object3D \| Rapier body \| `() => pos\|null`), `offset` (local), `intensity`, `smoke: 'black'\|'dark'\|false`, `light`, `embers`, `target`. Handle: `position`, `size`, `intensity`, `alive`, `stop(fadeSeconds)`, `kill()` |
| `smoke(pos, o)` → handle \| null | `color: 'light'\|'dark'\|'black'\|'steam'\|'dust'\|'concrete'\|hex`, `size`, `rate`, `duration`, `attachTo`, `offset`, `density`, `velocity`; with `count` it is a one-off burst |
| `steam(pos, o)` | radiator steam (smoke preset) |
| `sparks(pos, dir, n, o)` | stretched additive streaks, gravity, ground bounce |
| `dust(pos, size, o)` | `color: 'dust'\|'concrete'` |
| `glass(pos, dir, n)` | glinting shards (lit instanced fragments) + glints |
| `leaves(pos, o)`, `bits(pos, o)` | falling leaves / wood, metal, concrete chips |
| `splash(pos, strength)` | water spray + ripple ring |
| `debris(pos, o)` → items | Rapier dynamic boxes, instanced, lifetime + shrink fade, recycled above `quality.debrisMax` |
| `scorch(pos, size)`, `wallScorch(pos, normal, size)` | ground decal conformed by raycasts to terrain/roads; facade scorch/hole |
| `hit(pos, {normal, strength, material})` | impact preset: `metal`, `glass`, `concrete`, `wood`, `dirt`, `water` |
| `flash(pos, o)` | pooled point light flash |
| `addShake(amount)`, `shake` | camera shake 0..1.5, decays ~1.6/s; also emits `camera:shake {amount}` |
| `slowmo(scale, seconds)` | eases `game.timeScale` back to 1 (skipped while wasted) |
| `clear()`, `dispose()`, `particleCount` | |

Draw calls: flames, smoke, sparks (instanced quads), chunks, debris, decals = 6 + up to 6 shockwave rings.
Budgets: `quality.particlesMax` (split 28% flames / 45% smoke / 20% sparks, chunks ≤ 700),
`quality.debrisMax` (box debris; collapse chunks are protected until baked), PointLights: 4 (2 on `low`), always
in the scene at intensity 0 so the light count never changes.

## game.damage API

- `attach(controllable)` → `VehicleDamage` (also stored as `controllable.damage`). Works for anything with
  `body` + `object3d` (cars, trucks, bikes, aircraft, boats). Optional hints on the controllable:
  `enginePos` (Vector3, local), `explosionPower` (0 = never burns), `damageMeshes` (Mesh[] to deform).
  Uses `model.parts` (detachable hood/trunk/bumpers/doors), `model.lampMeshes` (per-lamp breakage),
  `model.enginePos`, `materials.glass/head/tail/paint` when present.
- `controllable.damage`: `engine` 0..1, `body` 0..1, `health` (= engine), `state` `'ok'|'burning'|'destroyed'`,
  `burning`, `destroyed`, `repair()`, `ignite(fuse?)`, `explode()`, `applyImpact(pointW, inwardW, energy)`,
  `dispose()` (VehicleManager.despawn already calls it).
- `damage.repair(v)`, `damage.ignite(v)`, `damage.explode(v)`, `damage.onExplosion(pos, power, radius, o)`
  (called by `fx.explode`), `damage.agentHit(agent, amount)`, `damage.igniteAgent(rec)`.
- Flags: `trafficMode = 'instanced' | 'takeover'`, `emitImpacts = true`, `hurtOnFoot = false`.

Behaviour:
- Impacts are detected after every physics step from the body's Δv (> 3 m/s in one step), localized with the
  Rapier contact manifolds of the vehicle colliders (point, normal, other collider). Underside landings count 20%.
- Deformation: vertices of all non-wheel meshes near the local impact point are pushed inward with smooth
  falloff, per-vertex jitter, cumulative limit (`0.08 × length`, 0.18..0.7 m). Vertex bins are pre-built over
  the first frames after spawn (≤ 0.4 ms/frame); a warm impact costs ~0.05 ms (max ~0.4 ms).
- Engine smoke: light < 60%, dark < 35%, fire ≤ 15% (or energy > 1.05, or upside down > 5 s for car-like
  kinds). Burning → explodes after 6–12 s (3.5–7 s when ignited by a nearby explosion). Explosion: big FX, wreck
  lifted with impulse + torque, materials charred, glass gone, lamps out, parts fly off, fire on the shell for
  16–28 s, smoke for 75 s, player inside is killed, vehicles within ~R ignite (chain reactions).
- Wrecked/limping vehicles: `fixedUpdate` is wrapped per instance (throttle × (0.35 + 1.5·engine) below 35%,
  no throttle when destroyed). `controllable.destroyed = true` after the explosion.
- AI traffic (instanced, default): damage from `contact` events (Δv > 3.5 m/s), smoke < 45%, fire ≤ 12% or
  explosions nearby → `traffic.crash(agent)`, `agent.burning = true`, fire/smoke attached to the agent body,
  explodes after the fuse, paint becomes charred. `trafficMode = 'takeover'` converts burning agents to full
  vehicles via `traffic.takeOver(agent)` + `vehicles.spawn` (costlier, full deformation).

## Destruction

Trees (on `contact` events with `userData.tree`, impulse = force × 1/60 accumulated over 0.25 s):

| type | impulse N·s | ≈ km/h for a 1400 kg car stopped dead |
|---|---|---|
| reed | 800 | 2 |
| bush | 1500 | 4 |
| palm | 7000 | 18 |
| tree | 10000 | 26 |
| pine | 14000 | 36 |
| cypress | 19000 | 49 |

Breaking calls `veg.breakTree(type, id, dir, strength 0.2..2.4)`, spawns leaves/chips/dust, emits `tree:broken`
and `impact`, and restores part of the vehicle's momentum so it drives through. Explosions apply
`32000 · power · (1 − d/R)^1.2` N·s to trees within 0.75 R.

Buildings (`contact` with `userData.building` impulse > 1800 N·s → damage = impulse / 1000; explosions →
`260 · power · (1 − d/R)^1.2` at the nearest facade):
- HP = `clamp(6·√(area·height), 25, 700)` (kiosk ≈ 30, house ≈ 120, shop ≈ 220).
- Small (`kind != tower`, height ≤ 13 m, area ≤ 650 m²): full collapse at HP 0 — `buildings.remove(id)`, the
  footprint prism is fractured into ≤ 28 boxes (oriented to the longest edge, bottom layer partly crumbled), dust
  cloud, then baked into one static rubble mesh + compound fixed collider when settled (≤ 7 s). ≤ 40 rubble piles.
- Large: facade chunks (2–7 physical boxes), dust and a facade scorch/hole decal; never collapse.
- Calls `buildings.damage(id, amount / HP)` so the integrator's darkening tracks the same health.

Vehicles: energy `e = (Δv − 2.5) / 19` (≈ 1 at 75 km/h into a wall); engine loss `e·(0.3..1)·0.85` (more near
the engine), body loss `0.6·e`; parts detach when their accumulated damage > 1 (≈ 70 km/h hit next to them).

## Events

Emitted: `explosion {position, power, radius, source}`, `fire:start`/`fire:stop {position, target}`,
`camera:shake {amount}`, `impact {position, strength, kind, material, source}` (vehicle crashes, tree snaps,
collapses), `vehicle:destroyed {vehicle, wasBurning}`, `vehicle:burning {vehicle}`, `vehicle:part {vehicle, part}`,
`traffic:destroyed {agent, position}`, `tree:broken {position, type, id}`, `lamp:broken {position, type}`
(explosions), `building:damaged {id, position, size, height, damage, health, cause}`,
`building:destroyed {id, position, size, height, area}` (`size` = √area, metres).
Consumed: `contact`, `vehicle:despawn`.

## Needs from other workstreams

- Cameras (D/A): apply `game.fx.shake` or listen to `camera:shake {amount}` (BasicPlayer's `ChaseCamera.shake`).
- Characters (D): on-foot explosion damage/ragdoll via the `explosion` event (or set `game.damage.hurtOnFoot`).
  If the player exposes `takeDamage(amount, {source, kind})` and `maxHealth`, the damage system uses them;
  otherwise it writes `player.health` (0..1 or 0..100 detected).
- Aircraft/boats (B): treat `controllable.damage?.destroyed` as "engine dead" (input is not routed through
  `fixedUpdate(dt, input)` for them).

## Perf (CPU, measured in the lab; default budgets 4000 particles / 60 debris)

| item | cost |
|---|---|
| `fx.explode` (car, incl. world reaction + house collapse spawn) | 1.7–3.9 ms once |
| `fx.update` with ~800 live particles, 5 fires | ≤ 2.5 ms (avg 0.06 ms idle) |
| `damage.update` / `damage.postStep` | ≤ 1.7 ms / ~0.01 ms |
| vehicle impact (warm, incl. FX + part detach) | 0.8–1.8 ms; first impact of a session ~8 ms (JIT) |
| deformation call | 0.05 ms avg, 0.4 ms max |
| building collapse spawn / rubble bake | 0.6–1.6 ms / 0.7 ms |
| physics step with ~100 debris bodies | ≤ 2.2 ms |

No new shader programs and no light-count change after crash + explosion + collapse + tree break (verified via
`renderer.info.programs`).
