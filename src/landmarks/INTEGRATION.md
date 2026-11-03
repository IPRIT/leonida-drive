# Landmarks and airports: integration

Workstream M. Everything lives in `src/landmarks/` plus `lab-landmarks.html`. One entry point,
`createLandmarks(game, opts)`, and three one-line hooks in `src/world/Roads.js`.

## Bootstrap

Import the module statically at the top of `src/core/bootstrap.js`. Evaluating `src/landmarks/index.js`
installs the Roads hooks, and it must run before `new Roads(...)`:

```js
import { createLandmarksAsync } from '../landmarks/index.js';
```

Call it right after the physics world and collision groups exist:

```js
game.groups = { GROUPS, groups };
await createLandmarksAsync(game); // builds every site, registers itself (order 45), sets game.landmarks
```

`createLandmarksAsync` runs the same build sliced: sites and finalize phases run in pieces with a frame in
between (about 24 ms of work per frame, `opts.budget`), so the loading screen keeps animating. The longest
uninterrupted piece is `timing.maxStep`, the main-thread total is `timing.total`, and the wall time with the
frames in between is `timing.wall`. A site's `build` may be a generator (`function*`); each `yield` is a slice
point (VCIA, the golf course and the grass infields use this). The synchronous `createLandmarks(game)` is still
there for node tools and labs.

At call time it needs `game.scene`, `game.renderer`, `game.quality` (after `render.attach`),
`game.terrain`, `game.roads`, `game.buildings`, `game.veg`, `game.world`, `game.RAPIER` and `game.groups`.
`game.player` is not needed yet: colliders start streaming once `game.player.focus` exists.

It must run before:

- `createEconomy` / spawn slots and `economyModule`, which read building records;
- `createLife`, which decorates building records (neon bands on towers that landmarks replace) and reads terrain
  ground classes (`life/coast.js`, `Signage.js`, `Birds.js`);
- `render.prewarm()`, so landmark shaders compile with the rest. Alternatively pass `{ prewarm: true }`. The
  parked-model mesh compiles there too, through a one-triangle stand-in that is swapped for the real mesh when
  the worker's geometry lands.

Options:

| Option | Default | Meaning |
|---|---|---|
| `only` | all | site ids or kinds to build, e.g. `['vcia', 'stadium']`; for labs |
| `order` | 45 | module order passed to `game.register` |
| `prewarm` | false | compile landmark programs right after building |
| `log` | true | one `console.info` line with timings and counts |

With `only`, runways and airstrips of unbuilt airport sites still get a plain pavement (the Roads hooks hide their
ribbons regardless).

## Roads hooks

All three hooks are in `src/world/Roads.js`. They are undefined, and Roads behaves as before, unless
`src/landmarks/index.js` was imported.

1. End of `markAirside()`: `Roads.afterAirside?.(this)`. `airside.js` marks every taxiway inside an airport as
   airside, which gives it yellow taxiway markings, no street lamps, no sidewalks and no AI traffic.
2. Ribbon loop in `buildMeshes()`: `if (Roads.skipRibbon?.(e, this)) continue;`. Hidden edges get no ribbon, collider
   or lamps.
3. Junction loop: a node whose arms are all hidden gets no junction cap.

Hidden edges, listed in `airside.js`:

- every runway edge and the road edge of each small airstrip, which landmarks draw as exact rectangles with
  markings and flat colliders;
- runway-wide forks, turn pads and stopways on a runway or its extended centreline;
- dead-end stubs inside a runway strip;
- short isolated pieces on airfield pavement.

Hidden edges stay in the graph, so routing, `e.airside`, `e.runway` and plane spawns (`src/air`) are unchanged.

Runway slabs cover their whole hidden runway edge, including in labs where the airport site is not built. The
slab has no vertical edges. Its ends ramp down to the ground over 10–30 m, at about 4 %. Its long sides get a
bevel down to the ground, which ends where the terrain meets a 10 % slope from the slab edge (3–30 m). Ramp
corners are filled. Strips on hillsides are banked by up to 8 %, runways by up to 1.5 %, so they don't stand
metres above the downhill side; `deckAt()` includes the bank.

## Terrain ground classes

The source map paints each airport as one paved area. At build time landmarks rewrite `terrain.ground` inside the
airfields: a flood fill from the runways turns paved texels into grass. These stay paved:

- the runway pavement;
- every visible road ribbon;
- aprons around buildings, landmark structures and parked aircraft;
- straight taxilanes from isolated aprons.

The ground texture is uploaded once (`groundTex.needsUpdate`). Vehicles read the classes for tyre grip, so the
infield drives as grass and runways, taxiways and aprons as asphalt. `dispose()` does not restore the classes.

## Runtime

- `update(dt)` streams the static landmark colliders around the player: Rapier cuboids, cylinders and convex
  hulls, with `userData.landmark = siteId`.
- `lateUpdate(dt)` switches near and far LOD per cluster and updates instanced, light and beam visibility.
- No materials, lights or geometry are created after build. Night uses `GLOBAL_UNIFORMS.uNight`. There are no
  real lights.

## API (`game.landmarks`)

- `sites`: `[{ id, name, kind, x, z, views, removed }]`.
- `stats`: sites, meshes, triangles (near, far, sign, paint, instanced), lights, colliders and `timing` in ms.
- `wetReport()`: landmark geometry standing in water. It is empty except for the allowed sites, the cruise
  terminal and the reef lighthouse.
- `deckAt(x, z)`: height of the drawn runway pavement, or `null`.
- `roadHit(x, z, r)`: index of a visible road ribbon within `r`, or `-1`.
- `runwayDecks` and `infieldStats` are for debugging.
- `visibleDraws()` and `dispose()`.

Airport helpers for other modules are in `src/landmarks/airside.js`: `hiddenEdges(roads)`,
`taxiwayEdges(roads)` and `stripRunways(roads)`.

## Lab

Open `lab-landmarks.html` on the no-HMR dev server, for example
`http://127.0.0.1:5320/lab-landmarks.html?only=airport&hour=22`.

URL parameters:

- `?only=` limits the sites; `?site=` starts at a site; `?hour=` sets the time of day.
- `?traffic=0` and `?peds=0` give a lighter world.
- `?life=1` enables life. The lab adds landmarks after `createLife`, so life stays off by default.
- `?shots=<port>` makes `lab.snap(name)` POST JPEGs to a local receiver.

`window.lab` provides `view(id, i)`, `look(pos, at, fov)`, `tour()`, `snap()`, `montage()`, `step(n)`,
`time(h)`, `bench(n)` and `perf(s)`.

## Notes for other workstreams

- Small airstrips (LTF, Watson Bay, Port Gellhorn) are not in `AIRPORTS` in `src/air/runways.js`, so planes
  do not spawn there. Landmarks finds them from the site positions (`findStripEdge`).
- At Goose Key, landmarks draw one runway longer than `findRunways` fits it. The source map's runway continues
  past the crossing. Plane spawns still use the fitted rectangle.
- The yellow vertical beam at the VCIA tower comes from the economy module's beacon, not from landmarks.
- The minimap (cartography) still draws the original footprints of buildings that landmarks replaced.

## Map geometry export

`node tools/landmark_geom.mjs [--out path] [--pretty]` runs the real landmark build in node (no browser) and
writes `tools/cache/landmark_geom.json` (about 130 KB, about 10 s). Rerun it after the world data or a site
changes. All coordinates are world metres `[x, z]`; on the map image `x = x`, `y = -z`.

```text
{
  version: 1, generated, frame,
  runways: [{
    airport, designations: ["12", "30"],
    thresholds: [[x, z], [x, z]],
    dir: [dx, dz],                   // unit vector from the first to the second threshold
    length, width, shoulder,         // metres; width without the 7.5 m shoulders
    pavement: { from, to, width },   // drawn pavement incl. blast pads and shoulders
    outline: [[x, z] x4],            // exact runway rectangle (threshold to threshold, runway width)
  }],
  taxiways: [{ edge, width, line: [[x, z], ...] }],   // centrelines of the airside taxiways (drawn ribbons)
  aprons:   [[[x, z], ...]],                          // paved stand / apron / taxilane polygons
  aircraft: [{ type, x, z, yaw, length?, span? }],    // parked aircraft (yaw: nose = (-sin yaw, -cos yaw))
  sites: [{ id, name, kind, x, z,
    outlines: [{ shape: "rect" | "circle" | "hull", top, poly: [[x, z], ...], center?, radius? }] }],
  stats: { sites, runways, taxiways, aprons, aircraft, ms }
}
```

`sites[].outlines` are the footprints of each site's main structures: terminals, concourses, hangars,
stadium bowls, towers, sheds, tanks, cranes and the cruise ships. `top` is the roof height in metres.
Fences, posts and masts are left out.

## Parked vehicles, aircraft and boats

Sites place the game's real models with `ctx.vehicle(key, x, z, yaw, opts)` or, with a clearance check,
`ctx.park(...)`. Keys: `car:<catalog id>`, `police:<catalog id>` (glowing lightbar), `plane:<air id>`,
`heli:<air id>`, `boat:<boat id>`. Models come from `src/landmarks/vehicles.js`: car models from
`bakeVehicle` (the same low-LOD bake traffic uses, shared cache) with the wheels merged in; planes and
helicopters from `src/air/models`; boats from `src/boat/models`.

All placements share one `BatchedMesh` with one material, so they cost one draw call plus its shadow pass.
Each placement is hidden past its own distance. Static box colliders are streamed with the other landmark
colliders. `finalize()` runs a placement audit (`audit.js`) before the meshes are built, and records the
counts before and after in `game.landmarks.auditReport`. The VCIA and Goose Key airsides are cleared of
generic buildings (`clearAirside`).

Geometry baking does not run on the main thread. `vehicle-dims.js` (generated by `tools/landmark_geom.mjs`,
rerun it after a catalog model changes) holds each model's sizes, so placement needs no geometry. After the
build, `vehicleWorker.js` bakes the models in a module worker and transfers the typed arrays back. The
`BatchedMesh` is built once all of them arrive: about 3 ms, `timing['vehicle-mesh']`. If the worker is
unavailable, the models bake on the main thread one per frame. A model missing from the table is baked
synchronously, and a size mismatch logs a warning.

`ctx.frameView(points | null, label, { only, from })` adds a tour view framing the given points, by default
the site's own parked models (`only`: a key regexp).

`features` in `landmark_geom.json` lists special map items. Currently these are `blimp-pad` (center, radius)
and `blimp` (x, z, yaw, length, diameter, mast).

## Sports grounds

`sites/sports.js` builds open-air grounds on the map's sport and park ground classes. It floods the texels from
the POI, then fits a rectangle (or a fan, for the diamond). Turf and markings are draped decals in the paint
builder. Goals, nets, posts, fences, light masts and stands are solid geometry. Stands and masts are skipped on
roads.

- `soccerField`: pitch markings, goals, corner flags, covered stand, team shelters, four masts.
- `footballStadium`: six-lane track, gridiron with end zones and yard lines, goalposts, home stand with press
  box, away stand, scoreboard.
- `baseballField`: home plate at the sharpest corner of the fan, skin, diamond, mound, bases, foul lines,
  outfield wall, backstop, dugouts.
- `tennisCourts`: one court per 18.3 m of width, net, chain-link fence with a gate, masts for two or more courts.
- `golfCourse`: seeded hole layouts on the park ground (best of six), with tees, fairways (a fairway may carry
  over water), greens with fringe and flag, and bunkers.
- `grandstands`: tiered stands facing the nearest track edge, optionally covered.
- `spaceshipHouse`: original saucer house on legs, set back from the road.

Sites: `gellhorn-grandstands`, `soccer-gellhorn`, `football-ambrosia`, `baseball-ambrosia`, `tennis-bayside`,
`tennis-ocean-beach`, `tennis-y`, `golf-leaf-links` and `spaceship-house`.
