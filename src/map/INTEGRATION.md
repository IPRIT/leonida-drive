# Cartography (workstream H): integration notes

Vector map for the HUD radar and the pause-menu map. Data: `public/data/map.bin` (built by `tools/map_build.py`
from the State of Leonida community map, YANIS v17, map.stateofleonida.net).

## What the integrator must add (bootstrap)

The UI hooks already exist (G): `Hud.drawRadar` delegates to `game.cartography.drawRadar` and `MapTab` mounts
`game.cartography.createFullMap` into `.mapwrap` when the MAP tab is first shown. Only the bootstrap call is missing.
Patch for `src/core/bootstrap.js` (integrator-owned, not edited by H):

```js
import { createCartography } from '../map/Cartography.js';
// ...
const [data, mapImage] = await Promise.all([loadWorldData(...), loadImage(MAP_IMAGE_URL), RAPIER.init()]);
game.worldData = data.world;
// start right away (fetches ~0.85 MB map.bin, spins up tile workers); await it before the 'start' event
const cartoReady = createCartography(game, { data }).catch((e) => { console.warn('[map] cartography disabled', e); return null; });
// ... world, physics, player, createUI(...) as today ...
game.cartography = await cartoReady;   // e.g. right after createUI, before the extra modules / 'start'
```

`data` is the `loadWorldData()` result: the module uses `data.world` and `data.heights` (Int16 dm grid, for the
hillshade). Without `data` it falls back to `game.worldData` and fetches `height.bin` itself.
`createCartography` may run before `createUI`: i18n is resolved lazily (namespace `carto`, en + ru registered).
Until `game.cartography` is set, the HUD and MapTab keep their raster fallbacks.

Alternative without touching bootstrap: `createGame(container, { modules: [async (g) => { g.cartography =
await createCartography(g, {}); return null; }] })` (this is what `lab-map.html?game` does).

## API

```js
const carto = await createCartography(game, { data, workers?, useWorkers? = true });
carto.drawRadar(ctx, w, h, s, dt);   // HUD: ctx already scaled by devicePixelRatio, draw in CSS px
const fm = carto.createFullMap(el, { onWaypoint, onTeleport, canTeleport, onClear?, keyActions?, info? });
fm.show({ x, z }); fm.update(dt, game.input); fm.hide(); fm.destroy();
carto.setPlayers([{ id, x, z, heading, color, name }]); // multiplayer (J); heading = compass radians (0 = north)
carto.stats(); carto.dispose();
```

- `drawRadar` state `s` (from the HUD): `x, z, heading` (= −compass, radar rotation), `speedKmh`, `radarAlt`,
  `blips [{x,z,color}]`, optional `route` (flat `[x,z,…]`), `waypoint {x,z}`, `playerBlips [{x,z,heading,color}]`.
  Missing `route`/`waypoint` are read from `game.player`. It restores the context state it changes.
- `createFullMap` options (as MapTab calls it): `onWaypoint(w | null)` (click / Enter / A, `w = {x, z, name?}`),
  `onTeleport(x, z, name)` or `null`, `canTeleport` (false → no Teleport buttons, double-click zooms instead),
  `onClear()` (defaults to `onWaypoint(null)`), `keyActions` (default: Enter/A = waypoint at the crosshair only,
  because MapTab already handles Space/Y teleport and Delete/X clear; pass `true` to handle all three),
  `info` (area/coordinates chip, bottom-left; default on).
  `show({x,z})` while already open glides there (used by the destinations list preview).
- Remote players: radar draws them as coloured arrows (no names); the full map draws arrows and name labels that
  take part in label collision.

## Settings

`game.settings.mapPoi = { on: bool, cats: [ids] }` (written with `game.applySetting('mapPoi', …)` by the POI
toggle / category panel). Category ids: `landmark gas food hotel shop leisure transport services nature industry
office residential other`.

## i18n

Keys `carto.*` (registered with en + ru: `teleport setWaypoint clearWaypoint poi all none unnamed inspired enterable
demolished unconfirmed closed safehouse zoomIn zoomOut locate data places zoomCluster you km m waypoint street`,
`cat.<id>`). G can add the other 28 languages to the locale files under the same keys. Place names are never
translated. The radar "N" uses G's `dir.N`.

## Files

| file | what |
|---|---|
| `src/map/Cartography.js` | `createCartography` facade |
| `src/map/Radar.js` | HUD radar |
| `src/map/FullMap.js` | pause-menu map component (DOM + canvas, injects its own `ldm-*` CSS) |
| `src/map/Labels.js` | label engine: candidates, collision placement, fades, sprites, curved street names |
| `src/map/tiles.js`, `src/map/tileWorker.js` | tile pool (workers, LRU, no-magnification drawing, fallbacks) |
| `src/map/TileRenderer.js` | vector tile rendering (land use, bathymetry, hillshade, buildings, roads) |
| `src/map/route.js` | GPS route rendering (glow, casing, animated flow) |
| `src/map/style.js`, `src/map/poi.js`, `src/map/relief.js`, `src/map/mapData.js`, `src/map/strings.js` | styles, POI categories + icons, hillshade from heights, map.bin decoder, strings |
| `tools/map_build.py` | dataset builder (`.venv/bin/python tools/map_build.py`, ~20 s) |
| `lab-map.html`, `src/map/lab-map.js` | lab: full map + HUD-size radar + simulated car (`?rs=2` big radar, `?noworkers`, `?game` real game) |
| `src/map/test/labels-bench.mjs` | `node src/map/test/labels-bench.mjs`: placement timings + flicker check |

## How it works / limits

- Tiles (512 px, half-octave levels 6 cm/px … 64 m/px) are rendered in 1–3 module workers (OffscreenCanvas →
  ImageBitmap) and are never magnified: the level is the coarsest one at least as sharp as the screen (shown at
  0.71–1×). While a tile is pending, finer cached tiles are drawn (minified) or the vector content is drawn
  directly on the main thread for the missing area. Without module workers everything runs on the main thread.
- Memory: tile caches ≈ 1 MB per tile; radar ≈ 20–30 tiles, full map ≈ 30–48 (shrunk to 12 when the map closes;
  30 / 16 on weak devices). A 6-tile overview of the whole state (16 m/px) stays cached as the placeholder of last
  resort, so fast flings never stall on main-thread vector drawing. The full-map canvas DPR is capped by a pixel
  budget (4.6 MP, 2.4 MP on low-end devices); phones get a compact layout (bottom-sheet card, double-tap zoom).
- Lab (`lab-map.html`): `labView(x, z, mpp)`, `labPerf()` (radar / pan / fling / zoom / open-latency timings);
  with `?shotport=N` also `labShot(name, x, z, mpp)` / `labShotRadar(name)` POST PNGs to a local file sink.
- Bathymetry is vector (5 depth bands from the height grid). The only raster is the hillshade (8 m height grid, a
  smooth field drawn with bilinear filtering); it fades out between 3.5 and 2 device m/px (at most 4x, at full
  strength under 2.3x) and is absent at street level. Everything with edges (coast, land use, roads, buildings, labels) is vector.
- Street names: only names present in the fan-map POI labels ("Name, Street, District, Area") are used, matched to
  the road polylines next to those POIs (31 names: e.g. Shore Dr, Catalan Blvd, Route 1). Most roads have no known
  name and stay unlabelled.
- Roads (`tools/map_build.py`): the raster-derived graph is cleaned for drawing only (roads.json is not changed):
  airside runways / taxiways, tunnels + short gaps between facing dead ends joined, kind smoothed along strokes,
  highway mainline vs ramp roles, generalised carriageway widths (mainline 13–18 m, ramps 7–9.5 m, limited by the
  gap to a parallel carriageway), overpass levels (port of `Roads.gradeSeparate`) and bridge decks, dead ends that
  stop a few metres short of a road extended to meet it, polylines merged along strokes. The tile renderer draws per
  level (tunnels, ground, decks): all casings, then all fills, so junctions have no seams; decks / bridges use butt
  caps and a dark casing so they read as passing over.
- Route shields: interstate / US / state road numbers as printed on the fan map's own shields (raster only; the
  seed table in `map_build.py`), propagated along the roads (`header.routes`, set `rt`), drawn as our own vector
  shields (`shields.js`, sprite-cached) on the full map (interstates up to the whole-state view) and on the radar.
  Interstate exits are numbered per route from the south / west (`header.exits`, green discs, close zoom only).
- POI cards link to the exact fan-map marker (`?marker=<id>`, plus `&irl` when it has a real-world prototype).
  Prototypes are shipped as "Name, City, ST" at most; homes only as "City, ST" (no street addresses).
- Building footprints, land use and roads come from the game data (`buildings.json`, `ground.bin`, `roads.json`), so
  the map matches the 3D world exactly.
- Events emitted: `ui:click` (buttons, POI actions) for the UI sounds. No events listened.
- `vite.config.js` (integrator): add `lab-map.html` to `build.rollupOptions.input` if the lab should be built.
