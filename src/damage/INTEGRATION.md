# Damage & destruction (workstream E)

Full contract (registration, API, thresholds, events): `src/fx/INTEGRATION.md`. Summary for this folder:

- `DamageSystem.js` — module `game.damage` (order 55): vehicle impact detection (`postStep`), `contact` routing
  (trees, buildings, AI traffic), `onExplosion` (called by `fx.explode`), AI-traffic wrecks, explosion queue.
- `VehicleDamage.js` — per-vehicle state stored as `controllable.damage` (`engine`, `body`, `state`,
  `repair()`, `ignite()`, `explode()`, `dispose()`).
- `Deformer.js` — vertex crumpling with per-mesh spatial bins (bins pre-built over the first frames, ≤ 0.4 ms
  per frame; warm impact ≈ 0.05 ms).
- `Destruction.js` — orchestration: trees, building hits (energy model, glass, wall panels, drive-through),
  explosions (per-cell blast jobs, shock-wave delay d/340 s), tank craters (`tank:hit`), structure checks,
  street props / lamps / signals in blasts, hydrant jets, pole sparks. Thresholds: `TREE_IMPULSE`, `BUILDING`, `WALL`.
- `Fracture.js` — fractured buildings (`Fracturer` = `destruction.fracturer`, `FracturedBuilding`). Walls are
  captured from `Buildings.addBuilding` (prism → panelWall), so IRL multi-part massing fractures as drawn.
  Base part (roofs / gables / bands cut along the region grid + coarse wall shell) and lazily built cells
  (4 storeys × one structural region): panels (outer face with the city window shader, inner face, jambs),
  slabs with thickness. Shattered panes (`aNeon.x = -1`) and crack networks (`aNeon.y` = damage) are drawn by the
  fracture material (city building shader + injection, prewarmed). Damage records persist per session; far,
  lightly damaged buildings are evicted back to the merged mesh and rebuilt on return.
- Structure: every storey of every region carries what is above it (`FracturedBuilding.failStorey`): a storey with
  < `WALL.support` of its walls left, or one side (>= 3 bays) down to `WALL.sideSupport`, brings down the whole
  region stack above (and below: the falling mass crushes it); >= 50 % of the regions (60 % for towers) -> the whole
  building pancakes or topples toward the weak side, pivoting at the failed storey. No floating floors or slabs:
  the cut faces of a standing remainder get exposed concrete columns; signs mounted on the building (neon strips,
  rooftop billboards, blade signs) and rooftop postcards come down with it (`Signage.detach`, `building:collapse`).
- `Collapse.js` — partial (region) / pancake / topple collapses: real-facade blocks prepared over a few frames,
  falling bodies that shatter into pinned debris, rolling dust, vehicles under a block crushed, settled debris baked
  into a static pile (mesh + drivable mound hull + flat box colliders) with a dust decal; piles hibernate > 750 m
  and come back < 550 m (records kept for the session).
- `DestructionFX.js` — glass bursts, `DustCloud` (rays decide how far it rolls each way), `WaterJet`, pole sparks.
- `test-destruction.mjs` — headless regression test: `node src/damage/test-destruction.mjs`.

## Contracts with other modules

- `src/world/Buildings.js`: `r.frac` may be an external fracture (`r.frac.external === true`): `colliderDesc` returns
  null (colliders are streamed by the fracturer), `damage` → `r.frac.tint(k)`, `remove` → `r.frac.dispose()`.
  Every legacy `r.frac.mesh` access is guarded. The legacy `fracture/punch/supportLost` path is only used for
  buildings whose walls can't be captured (`fracturer.broken`).
- `src/life/Signage.js`: signs keep their building id; `detach(id, fallen?)` hides the ones that went down.
- Event `building:collapse {id, full, regions}` when a section / building actually comes down.
- `src/life/StreetProps.js`: `blast(pos, Pw, R)` throws props in an explosion; `knock(id, ob, force, blastVel)`.
  Hydrants answer `prop:broken` with a water jet (`destruction.jets`).
- Lamps / signals: `lamp:broken {position, type, dir?}` → base sparks + arc flash; pole bodies in `lamps.broken` /
  `traffic.lights.broken` are watched until the head lands (glass + sparks + metal impact).
- Tank shells: `tank:hit {kind: 'building', position, dir}` after `fx.explode(back, 1.6)`.
- Events emitted: `building:damaged`, `building:destroyed {partial}`, `impact {material: 'glass', kind: 'window'}`
  (delayed 50-250 ms so the glass sound is not merged with the concrete hit), `splash` (hydrant).

## No-freeze rules

- Materials created once (`rubbleMat`, `brokenLampMat`, the fracture material); `prewarmObjects()` returns meshes
  using them (and the snapped-tree variants). `fx.prewarm()` compiles them for the scene target *and* the canvas
  and draws them once while loading (some drivers build the pipeline only at the first draw: ~100 ms).
- Rubble geometry carries normals (same program as the prewarm mesh, incl. the shadow depth program).
- Per-event work is bounded: fracture of a building ≤ ~1 ms, one cell ≤ ~1 ms, blasts split into one job per cell
  (budget 1.2 ms / frame), collapse blocks prepared ≤ 1.2 ms / frame and spawned ≤ 4 per frame (≤ 1.5 ms); the
  standing part is swapped out only after its blocks exist (no missing-chunk frames), then the ground storey crumbles;
  collider rebuilds after a section collapse run one per job; vehicle crush, pile mesh/colliders and the dust
  cloud's street rays each run a frame later; rebuilt (evicted) buildings restore damaged cells one per job.
- Attribute edits: full re-uploads clear pending update ranges (three.js otherwise uploads only the ranges).
- Budgets: ≤ 24 falling blocks, ≤ 180 pinned debris boxes (oldest pile is frozen early), ≤ 40 live rubble piles,
  ≤ 40 fractured buildings (lightly damaged far ones evicted), non-pinned debris recycled far/old first and put to
  sleep when resting, runaway speeds clamped.

## Needs from the integrator / other workstreams

- `src/main.js`: see `src/fx/INTEGRATION.md` (register FX + DamageSystem, bridge `camera:shake`).
- Player: `takeDamage(amount, {source, kind})` + `maxHealth` if available, else `health` is written directly.
- Aircraft/boats: treat `controllable.damage?.destroyed` as engine dead.
