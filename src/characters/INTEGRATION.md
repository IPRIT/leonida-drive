# Characters (workstream D): integration

On-foot player, enter/exit and carjacking, visible drivers, health/armor/money, ragdolls, pedestrians v2 with
beach life, cash pickups, and remote avatars for multiplayer. Plain JS, no new dependencies.
Lab: `lab-characters.html` (it defaults to `?mode=single`, so the debug buttons work).

## Files

| file | what |
|---|---|
| `PlayerController.js` | Replaces `core/BasicPlayer.js` with the same public API and more (see below). |
| `Pedestrians.js` | Replaces `world/Pedestrians.js`. Same constructor and `update` signature, plus `game`. Includes beach life (sunbathers, towels, parasols). |
| `Cash.js` | Cash pickups and hidden stashes. `PlayerController` creates `game.cash` automatically. |
| `RemoteAvatars.js` | `createRemoteAvatars(game, opts)` for multiplayer players on foot (workstream J). |
| `Ragdoll.js` | Pool of Rapier ragdolls (`game.ragdolls`, created on demand, registered as a module). |
| `CharacterMotor.js` | Kinematic capsule on Rapier's `KinematicCharacterController`. |
| `OrbitCamera.js` | Third-person camera used on foot. |
| `HumanBatch.js`, `geometry.js`, `looks.js`, `rig.js`, `poses.js` | Instanced humanoid renderer, part meshes, appearance generator, skeleton with forward kinematics, procedural animation. |
| `util.js` | Seats, vehicle boxes, traffic takeover fallback, ground rays, hospitals, `tr()` for i18n. |
| `lab-characters.js`, `/lab-characters.html` | Test bench with a debug panel. |
| `wardrobe.js` | Wardrobe catalogue (185 original items), outfit helpers, lazy `createCharacterPreview`. Plain data, Node-safe. |
| `preview.js` | Menu turntable preview: renders with the game's renderer into render targets of a private studio scene. |
| `lookcodes.js` | Appearance codes (patterns, hair/hat/glasses/jewellery bits, tattoo styles) shared by looks, geometry, the shader and the wardrobe. No three.js. |
| `obstacles.js` | Vehicle obstacles for characters: oriented boxes of all nearby vehicles plus a spatial hash (`game.vehicleObstacles`). |
| `impact.js` | Shared knock-down model: `vehicleKnock`, `blastKnock`, `pushVehicle`, `tumbleStep`, `hoodRamp`. |
| `test/physics.test.mjs` | Headless motor and ragdoll checks: `node src/characters/test/physics.test.mjs`. |
| `test/wardrobe.test.mjs` | Headless wardrobe checks (catalogue, default outfit = protagonist, wire form, instance data for every item): `node src/characters/test/wardrobe.test.mjs`. |
| `test/knock.test.mjs` | Headless knock-down arcs, old model vs new: `node src/characters/test/knock.test.mjs`. |
| `test/vite.build-check.config.mjs` | Build check that also bundles the lab: `npx vite build --config src/characters/test/vite.build-check.config.mjs`. Output goes to `/tmp`. |

## What the integrator adds

`src/main.js`:
```js
import { createGame } from './core/bootstrap.js';
import { PlayerController } from './characters/index.js';

createGame(document.getElementById('app'), {
  createPlayer: (game, sp) => new PlayerController(game, sp),
  modules: [],
});
```

`src/core/bootstrap.js` (pedestrians v2; pass `game` so peds get ragdolls, cash, events and beach life):
```js
import { Pedestrians } from '../characters/Pedestrians.js'; // instead of ../world/Pedestrians.js
// …
if (!options.noPeds) game.peds = new Pedestrians({ scene, roads: game.roads, terrain: game.terrain, max: 170, game });
```
If `game` is omitted, `PlayerController` calls `game.peds.attach(game)` itself. The loop call stays the same:
`game.peds?.update(dt, focus, camera, playerInfo, night)`, and `game.peds.positions` still feeds traffic avoidance.

`vite.config.js`: add `characters: resolve(import.meta.dirname, 'lab-characters.html')` to `rollupOptions.input`.

Optional: start on foot with `new PlayerController(game, sp, { startOnFoot: true })`. Bootstrap's first `enter(car)` then
parks the car and puts the player beside its door. Option `lookSeed: n` gives a seeded look (multiplayer); otherwise
the original protagonist look is used.

Shader warm-up: every human mesh is added to the scene at init and shares 3 materials (`humanMaterials()`), plus
towel/parasol/cash materials. Nothing creates materials or lights after init. A `renderer.compile(scene, camera)`
prewarm covers them all.

## Player API (`game.player`)

| member | |
|---|---|
| `mode` | `'foot' \| 'vehicle' \| 'free'`. `state` is finer: `foot \| enter \| vehicle \| exit \| ragdoll \| getup`. |
| `controllable`, `lastVehicle` | Current vehicle (null on foot) and the last one used. |
| `character` | `{ position (feet), velocity, yaw, state, swimming, grounded, ragdoll, dims, look }` |
| `focus`, `heading` | As in BasicPlayer. On foot, `heading` follows the camera, like a GTA radar. |
| `health`, `armor` | 0..1. Health regenerates to 50% after 5 s without damage. `breath` 0..1 underwater. |
| `money` | Integer. Online it is set by the economy/server. |
| `addMoney(n, pos, reason)` | Reasons: `pickup \| drift \| stunt \| nearmiss \| collectible \| race \| other`. Calls `game.economy.earn` if present, else `game.net.claim`, else adds locally. Always emits `money:pickup {amount, position, reason}`. |
| `damage(amount, kind)` | Kinds: `vehicle \| fall \| explosion \| fire \| drown \| generic`. Armor absorbs everything except `fall` and `drown`. |
| `enter(v)`, `exit({instant})`, `requestEnter()` | `enter(v)` is instant (garage). `requestEnter()` walks to the nearest vehicle or traffic car, then opens the door or carjacks, then sits. |
| `teleport(x, z)`, `setWaypoint(w)`, `waypoint`, `route` | As before. On foot, teleport puts you on the sidewalk next to the nearest road. |
| `setFree(on)`, `startRagdoll(vel, spin)`, `die(kind)`, `setLook(lookOrSeed)` | |
| `outfit`, `setOutfit(outfit)` | Wardrobe outfit (see "Wardrobe"). `setOutfit` merges with the current outfit, rebuilds the look, emits `player:outfit {outfit}` and returns the canonical outfit. |
| `swimStamina` | 0..1, drained by sprint swimming (see Controls). |
| `refill()`, `setGod(on)`, `god` | Cheats: no-ops unless `game.can('godMode')`. |
| `fixedUpdate/update/lateUpdate`, `dispose()` | Module lifecycle, registered by bootstrap. |

## Controls

| action | keyboard / mouse | gamepad |
|---|---|---|
| Move | WASD / arrows, relative to the camera | left stick (light tilt = walk) |
| Sprint / walk | hold Shift / hold Alt (CapsLock toggles walking) | hold A |
| Jump, climb a 0.45–1.75 m ledge | Space | X |
| Enter / exit vehicle, carjack | F (F again cancels the walk-up) | Y |
| Look | mouse: click locks the pointer, or drag with a button held; wheel zooms | right stick |
| Camera distance on foot / camera mode in a vehicle | C | |
| Swim / sprint swim | WASD + Shift: 1.8 m/s crawl, 3.3 m/s sprint with faster strokes; 2.5 m/s once `swimStamina` runs out (14 s of sprinting, refills in 6 s) | stick (+ A); touch: stick pushed to the edge |
| Climb out of the water onto a pier, quay or boat (up to 2.8 m above the feet) | Space, or keep swimming into the edge for 0.35 s | X |
| Dive while swimming | Ctrl | B |
| Free camera | V (gated by `game.can('freeCam')`) | |
| Headlights, siren, flip vehicle | H, L, R | |
| Time +1 h | T (only if `game.can('time')`) | |

## Behaviour notes

- Bail-out: leaving above 20 km/h keeps about 85% of the momentum, rolls, and costs 3–30% health. Above 75 km/h you ragdoll instead.
- Hit by vehicles (player or traffic, relative speed > 3 m/s): ragdoll with the shared knock model (see "Knock-downs"), damage `(rel − 3) / 24`.
- Falls: damage above 10.5 m/s impact speed, lethal at about 22 m/s. A hard landing while running turns into a roll.
- Explosions: damage `power × (1 − d/1.5R)²`, ragdoll when close. Fire (`fire:start`/`fire:stop`): 25%/s within 1.8 m.
- Online the menu does not pause the game. While `game.ui.isOpen`, player input reads as zero, the camera does not look around, and a driven vehicle coasts with neutral input (no throttle, brake, steering or handbrake). Pedestrians, traffic, cash pickups and the wardrobe preview keep running.
- A sinking car means you climb out and swim. Sea level is y = 0. You swim when the water reaches your chest and the bottom is deeper than 1.25 m.
- Wasted: slow motion, the `uWasted`/`uFade` grade, then a respawn.
  - Died in a working vehicle: respawn in that vehicle at the last safe road point, repaired (BasicPlayer behaviour).
  - Otherwise: on foot at `game.spawns.pickSpawn('hospital', {x, z})`, or at the nearest of 16 district hospitals as a fallback.
  - The fee goes through `game.economy.charge('hospital')`, else `game.net.charge('hospital', 100)` online, else 5% of cash locally (min $50, max $5k).
- Carjack: uses `game.traffic.takeOver(agent)` (spec `{id, pos, yaw, color}`) if present. The fallback removes the agent and spawns a matching preset. The AI driver is drawn seated, pulled out, and handed to `game.peds.adopt()`: they stumble, then flee.
- Driver doors (CarModel `parts.doorFL/FR` with `userData.hinge`) swing open and closed during enter and exit. They stay open after a bail-out.

## Pedestrians (`game.peds`)

`new Pedestrians({ scene, roads, terrain, max = 170, game })`, `update(dt, focus, camera, playerInfo, night)`.

- Members: `positions`, `list`, `stats {count, near, mid, far, ragdolls, ms, msMax}`, `ragdollEnabled`, `forceLOD` (`'near'|'far'|null`), `lod0`/`lod1`/`shadowDist` (m), `beach {count, target, enabled}`, `debugJumps` + `jumpStats` (lab assertion).
- Methods: `panic(pos, radius, prob)`, `knock(ped, {x,y,z, sx?,sy?,sz?}, strength, source)`, `adopt({look, x, y, z, yaw, state, fleeFrom})`, `spawnCrowd({build, count, x, z, radius, beach})`, `clear()`, `attach(game)`.

Looks:
- Body types: thin, average, athletic, heavy, elderly (stoop).
- Heights 1.55–1.95 m, both gender presentations, 10 skin tones.
- 11 hair styles: bald, buzz, short, side part, curly, long, ponytail, bun, bob, afro, mohawk. Natural, grey and dyed colours. Beards, moustaches, goatees.
- Tops: t-shirt, tank, hawaiian, polo, shirt, hoodie, suit, dress, crop top, swimwear. Bottoms: jeans, chinos, shorts, track pants, skirts. Shoes and sandals.
- Accessories: sunglasses, caps, sun hats, earrings, backpacks, belt bags, chains, watches, phones, shopping bags, briefcases, coffee cups.
- Shader patterns: floral, stripes, plaid, denim, worn, tie-dye, dots, graphic tees, suit and tie.
- Procedural tattoos: tribal bands, sleeves, stars, script, roses.
- District-aware via `world3d.areaAt().wealth` and sand: suits and designer clothes in rich areas, worn clothes in poor ones, swimwear at the beach.

Behaviours:
- Sidewalk walking, idling, phone calls (ear or texting), chatting pairs.
- Fleeing (along the sidewalk, away from the threat), cowering, diving out of a fast car's path.
- Knock-downs: a Rapier ragdoll for close peds (pool of 6), a cheap tumble otherwise. Then they lie down, get up, and limp or flee.
- Cash drop of $5–$80 by wealth, despawning after 30 s, reason `pickup`.
- Explosions knock nearby peds and scare the rest. Fires and strong `impact` events cause panic. A `horn` startles people.
- The on-foot player bumps peds; sprinting into them makes them stumble.

Beach life:
- On dry sand (`terrain.groundAt == G.sand`), mostly the Ocean Beach strip (x ≈ 2100–2260):
  - sunbathers on instanced striped towels: on the back or front, three variants;
  - sitters on the sand: three variants;
  - standing groups of 2–4 chatting;
  - walkers and joggers along the waterline;
  - parasols.
- Crowd size follows the daylight curve, peaks around 13:00 and drops to zero at night or in rain. Up to 120 people (60 on the low quality profile).
- Approaching cars and panic make people scramble up and flee.

Street network (sidewalks only, crossings at zebras):
- Peds walk only on built sidewalks. Each edge side has a cached walkable run `_walk(e, side)` → `{a, b, endA, endB}`. The run is cut at junction trims (`roads.trims`) and wherever Roads built no sidewalk (another road, a junction, or the edge's own asphalt at sharp bends).
- At an urban junction (`roads.junctions[ni].arms`), a ped walking to the mouth chooses one of four moves:
  - round the corner into the neighbouring arm on the same side, walking straight across the corner piece (reflex or far corners are rejected and cached);
  - round the corner, then cross that arm (straight on through the junction);
  - cross its own arm;
  - turn back.
- Crossings use the zebra (2.1 m past the trim) and run perpendicular kerb to kerb. Peds wait at the kerb while the arm's cars have green or yellow (`traffic.lights.state(ni, ei)`, uncontrolled = gap only), or while a vehicle stands on the zebra or will reach it within 3.5 s. They give up after 35 s. At most 3 wait per zebra.
- Plain nodes continue on the next edge's sidewalk on the same side of the street. Dead ends and sidewalk gaps turn peds around.
- A ped more than 9 m from its path (pushed, knocked down, fleeing), a free street ped (a carjacked driver), and anyone getting up walks back to the nearest sidewalk run (`_resnap`). Peds never stop to idle or phone while crossing or rounding a corner.

Spawning (no bursts, no clumps):
- The spawn budget is 1.5–10 peds/s, scaled with the deficit. A fast fill of 50/s runs only for 1.5–2 s after startup or a teleport (> 60 m focus jump), and only beyond 45 m from the camera.
- Spawn points are uniform along every walkable sidewalk run within 235 m (length-weighted). They must be at least 32 m from the focus and either out of the frustum or more than 150 m from the camera. They are never under a parked car.
- At most 4 street peds may spawn into one 20 m cell. Chatting pairs make up 3.5% of spawns and groups of three 1%.
- `peds.spawnStats {total, lastSec, maxPerSec}`.

Pose safety:
- Watchdogs end every transient state: a dive ≤ 2.5 s, a tumble ≤ 10 s, a ragdoll ≤ 25 s, a cower ≤ 3 s, lying down ≤ 8 s and getting up ≤ 3 s.
- Lying, getting up and cowering follow the ground height.
- A ped can be scared by a fast car (dive or cower) at most once per 5 s.

Walking and visibility rules (no teleports):
- Sidewalk path = continuous offset curve of the road centreline (mitred vertex normals interpolated along each
  segment), at the sidewalk centre `e.w/2 + sidewalkWidth(e)/2`, height = slab top (`road + lift + 0.14` kerb,
  sloping to the outer edge like `Roads.sidewalks()`). Roads without sidewalks keep `e.w/2 + 2.3` and terrain/road height.
- Carrot following: the path parameter only advances while the ped is near it, and the ped walks towards it at its own
  speed, turning smoothly. Edge changes, dead ends and fleeing the other way move the carrot; the ped walks there.
- Height uses a critically damped follow (0.14 s); free-moving peds use a throttled physics ray, so kerbs, bridges
  and decks are respected.
- Recycling happens only out of view (beyond 320 m). Spawning follows the rules above: out of view, or in view but more than 150 m away; the startup and teleport fill uses anything beyond 45 m.
- Pushes (player bumps, slow traffic nudges) are speed-limited (≤ 2.5 m/s).
- Lab assertion: `peds.debugJumps = true` logs any per-frame move > 0.5 m of a visible, non-flying ped
  (`peds.jumpStats`). Soak: `lab-characters.html?soak=1` (camera pans slowly).

Rendering: one `HumanBatch` (shared with the player when `game.peds` exists before the player), compacted every frame
so only what is visible this frame is drawn:
- full detail within 25 m (16 m on low): faceted heads with faces, hands, all accessories; casts shadows;
- mid LOD 25–55 m (40 m on low): 4-sided limbs, 8-sided head, simple hair/hats/skirts/bags, no hands; casts shadows
  only within 30 m (18 m on low);
- far impostor up to 280 m: one 108-triangle mesh with a vertex-shader walk cycle, no shadows;
- resting beach crowds switch sooner (full < 14 m, mid < 40 m) and only cast within 14 m.
Up to 23 instanced meshes exist (near 10, mid-with-shadow 6, mid 6, far 1); empty ones are invisible, so a typical
frame submits 10–20. Towels and parasols are dense lists (only existing ones are drawn).

## Vehicles are solid for pedestrians (`obstacles.js`)

`getObstacles(game)` creates `game.vehicleObstacles` once and registers it (order 12, before the peds). Pedestrians
use it automatically.

- Sources, collected within 140 m of `player.focus`:
  - `game.vehicles.active`: the player's and spawned vehicles, aircraft and boats (body pose, `spec.size` or the model's bounding box);
  - `game.traffic.agents`: moving and parked AI traffic (`a.cur`, `a.cq`, `type.baked.width/length`; crashed cars use the body velocity);
  - remote players' vehicles from `game.net.remoteVehicles()` (below), with a fallback to `game.net.store.list` plus `game.net.vehicles.dims(model)`.
- The boxes are pooled and refreshed every frame from their sources. The spatial hash (8 m cells) is rebuilt every 0.2 s. Each box goes into every cell its footprint covers: half diagonal + 0.5 m inflation + 4.5 m look-ahead + 0.25 s of motion. One `at(x, z)` lookup returns every box a ped may need. No per-frame allocations.
- The box frame follows three.js `rotation.y = yaw`, where 0 faces −Z: `toLocal(b, x, z, out)`, `toWorld(b, lx, lz, out)`, `segHitsBox(...)`.

Pedestrian behaviour. Only peds within 60 m of the focus check vehicles; farther ones are hidden or simulated at half rate.

- **Avoid.** If the 4 m segment towards the ped's target crosses a vehicle box inflated by 0.5 m, the ped walks to the best reachable corner of that box (+0.25 m) and then back to its path. A corner is rejected if it is hidden behind the car, inside another vehicle, in a building or in water. If the path point itself is inside a car, for example one parked across the sidewalk, it moves up to 12 m past the car.
- **Blocked.** If no corner works, the ped stops in an idle pose. After 2.5–4.5 s it turns around: path walkers reverse direction, free walkers turn 180°.
- **Make way.** A standing ped (idle, phone or chat) steps aside for about a second (`shuffle`) when a car approaches at 0.3–2.8 m/s (under 10 km/h). Faster cars use the existing reactions: stumble when nudged by traffic, dive, or knock-down.
- **Hard guarantee.** After movement, a ped whose centre is inside an inflated box is pushed out along the shortest axis. The push is limited to `max(2.5, carSpeed + 1.5) × dt` per frame, so it is smooth and never a teleport.
- **Lab counter.** With `peds.debugJumps = true`, `peds.insideStats {checks, inside, max}` counts ped-frames with a centre inside a real (not inflated) vehicle body. It ignores ragdolls, tumbles and dives. The lab shows it as "inside vehicle".

Player on foot (`CharacterMotor`):
- The KCC already treats VEHICLE and TRAFFIC colliders as obstacles.
- A vehicle that drives into the capsule pushes the player out. Before each step, `world.intersectionsWithShape` and `contactCollider` find the penetration (hood-ramp colliders are skipped). Wanted motion into the car is dropped, and the push is capped at `carSpeed + 2` m/s.
- During that step the KCC queries only GROUND, STATIC and PROP, so the player slides along walls and is never squeezed through them.
- Remote players' cars use J's `RemoteColliders` (TRAFFIC group), so they block the player and push them the same way.
- `motor.pushOut = false` disables this, `motor.push {x, z, d}` exposes the last push, and `test/physics.test.mjs` covers it.

## Wardrobe (`wardrobe.js`, `preview.js`)

```js
import { WARDROBE, WARDROBE_BY_ID, DEFAULT_OUTFIT, normalizeOutfit, outfitToLook, encodeOutfit, decodeOutfit,
  outfitKey, createCharacterPreview } from './characters/index.js'; // or './characters/wardrobe.js' (Node-safe)
player.setOutfit({ top: { id: 'top_flamingo', color: 0xa8e6ff }, hat: { id: 'hat_panama' } });
const pv = createCharacterPreview(game, el); // { setOutfit, rotate(yaw), setView('body'|'face'), zoom, dispose }
```

Catalogue: 185 items (`WARDROBE`; also `game.wardrobe = { items, byId }`, set by the player controller). All designs are original: no brands, logos or real designer patterns. Patterns are procedural shader code (instanced pipeline, no textures, no runtime material creation).

| slot | items | highlights |
|---|---|---|
| `hair` (barber) | 20 | 17 styles incl. slicked back, pompadour, locs, cornrows, spiky, mullet, top knot; natural and dyed colours |
| `facial` (barber) | 10 | stubble, moustache, handlebar, goatee, circle beard, sideburns, chin strap, full and sculpted beards |
| `top` | 31 | tees (stripes, sunset graphic, tie-dye, washed, camo, retro sunset), tanks, mesh jersey, polos, Hawaiian, flamingo, palm-leaf, gingham and leopard shirts, hoodies, turtleneck, suits (plain, pinstripe, white summer, tuxedo with bow tie), sequin shirt, no shirt |
| `jacket` (layer over the top) | 15 | denim, bomber, track, windbreaker, varsity, suede, leather biker, camo bomber, blazer, open Hawaiian / flamingo / palm overshirts, sequin blazer, gold leather |
| `legs` | 22 | jeans (plain, ripped), chinos, shorts, board shorts (Hawaiian, palm), cargo pants and shorts, track pants, joggers, camo, suit, pinstripe, linen, leather, swim trunks, skirts (plain, plaid, maxi), sequin, gold-stripe |
| `shoes` | 13 | sneakers, canvas, runners, high-tops, flip-flops, slides, work and Chelsea boots, loafers, dress shoes, white loafers, gold sneakers, barefoot |
| `hat` | 13 | cap (also backwards), trucker, beanie, visor, bucket, sun hat, beret, fedora, Panama, wide-brim, gold-band fedora |
| `glasses` | 11 | classic, round, clear, aviator, cat-eye, sport shield, browline, mirror shield, gold aviators and round frames; the colour is the lens tint |
| `accessory` | 22 | watches (digital, steel, smart, gold, diamond), chains (silver, gold, rope, Cuban link), medallion, pearls, bracelet, rings, stud / hoop / diamond earrings, backpack, belt bag, two sets |
| `tattoo` | 17 | procedural designs: tribal, sleeve, star, script, rose, waves, palm tree, sun, geometric band, heart and banner, snake, back pieces (wings, sunburst); arm, neck, chest, back and leg placements |
| `body` (surgeon) | 11 | builds (athletic, average, lean, heavy, tall, short and stocky, senior, four feminine), 8 skin tones |

- Item: `{ id, slot, name, tier: 'basic'|'street'|'premium'|'luxury', value 0..1 (price inside the tier), size 0..1 (tattoos), colors: [hex] (at most 8; the first is the default), starter? (free, owned from the start), code (stable wire number), look, paint }`. Names are English (`name`). Use i18n keys `wd.item.<id>`, or G's own lookup.
- Every slot has a free starter item, and taking something off = the slot's "none" item (`jacket_none`, `hat_none`, `glasses_none`, `acc_none`, `tat_none`, `facial_none`, `shoes_bare`, `top_shirtless`, `hair_bald`). `DEFAULT_OUTFIT` = the protagonist (`outfitToLook(DEFAULT_OUTFIT)` equals `playerLook()`).
- **Outfit** (serialisable): `{ [slot]: { id, color } }` with `slot` = the item's slot (`body, hair, facial, top, jacket, legs, shoes, hat, glasses, accessory, tattoo`). `normalizeOutfit` also accepts:
  - UI keys and aliases (`tops`, `hats`, `beard`, ...);
  - the economy's `{ slot: itemId, colors: { itemId: hex } }`;
  - arrays of ids;
  - `null` for a slot, meaning take it off.

  The slot always comes from the item. Unknown ids are dropped, and colours outside the item's palette survive locally but not in the wire form.
- Suits come with matching trousers unless legs other than the default chinos are chosen. Closed jackets hide the top; open ones (leather, bomber, blazer, denim, overshirts) show it in the front opening. Voluminous hair styles are tucked under hats that cover the crown.
- **Wire form (J):** `encodeOutfit(outfit)` → at most 11 u16 values (`item.code * 16 + colour index`, 15 = default). `decodeOutfit(codes)` → outfit. `outfitKey(outfit)` is a stable string for change detection. Item codes are stable: new items are appended, never renumbered.
- **Preview (G):** `createCharacterPreview(game, el)`, exported by both `wardrobe.js` (lazy) and `preview.js`, and also available as `game.characters.createPreview(el)`.
  - It appends an absolutely positioned canvas filling `el`, renders at 30 fps only while `el` is visible (IntersectionObserver, tab visibility), and caps the canvas at 720×960.
  - `rotate(yaw)` is absolute (0 = facing the camera, eased). `setView('face')` is a head-and-shoulders close-up. Each outfit change gives a rim-light pop.
  - The background is transparent: the stage's CSS shows through, with a soft floor shadow and a neon-pink rim light.
  - The studio (lights, environment, 4-figure batch, output pass) is created once per renderer and reused. The first open compiles its shader variants with `compileAsync`, so the menu does not hitch. `dispose()` frees the per-preview render targets.
- Performance: worn pieces are masked parts of shared instanced meshes. Head wear is split into small hats, brimmed hats, glasses and earrings; salon hair styles are a separate mesh. A pedestrian only processes the geometry it wears, and the draw calls and materials are unchanged.

### Item thumbnails (`getWardrobeThumbs`, used by `WardrobeTab`)

```js
import { getWardrobeThumbs } from './characters/preview.js';
const th = getWardrobeThumbs(game); // one service per renderer
th.request(itemId, color, priority); th.get(itemId, color); // -> ImageBitmap | canvas | null
th.onReady((key) => repaint(key)); th.key(itemId, color); th.cancel(itemId, color); th.stats; // {bakes, msAvg, msMax}
```

- A thumbnail is the item on a neutral mannequin in the selected colour, or in the first palette colour by default. The camera is framed on the item's body region: head for hats, glasses and earrings, torso for tops and jackets, legs, feet, and the wrist for watches and bracelets. A tattoo is framed on its limb and turned so the design faces the camera.
- Thumbnails are baked lazily in the shared studio of `getStudio(renderer)`. The output is 288×216 in an offscreen target, read back with `readRenderTargetPixelsAsync`.
- At most one bake runs every 140 ms. The main thread spends about 1.0 ms per bake on average and 3.3 ms at most (desktop, headless, game running).
- The cache is an LRU of 160 entries keyed by item and colour. A swatch change re-bakes the card after a 110 ms debounce.
- Thumbnails bake while the game runs, both online and in single.
- `WardrobeTab` drives the service:
  - an IntersectionObserver bakes only cards within 200 px of the viewport;
  - a card shows a skeleton shimmer, then cross-fades to the thumbnail;
  - cached thumbnails paint immediately, without the shimmer;
  - the generic icon remains only as a fallback.
- The `hSkin` tattoo shader now wraps the angle difference (`hWrap`). Before, a design whose seed was above π never showed. `SKIN8` starts with the protagonist skin, so the default body colour is the first palette colour.

### Wardrobe purchase / outfit fix (canonical keys)

There is a single canonical key format: **item slots** (`top, jacket, hat, glasses, accessory, tattoo, facial, ...`) are used everywhere. UI categories (`tops, hats, beard, ...`) exist only inside `WardrobeTab`, which maps them with `canonical()`.

Root causes of "bought items don't apply, glasses can't be bought":

1. **Outfit keys and shape.** `WardrobeTab` sent UI-category keys and `{id, color}` objects to `Economy.setOutfit`. The economy rejected them (`slot` / `unknown`), so nothing was saved, and the next `economy:outfit` event (after a purchase or a reload) reverted the player.
2. **Basket purchase.** `buyAll` called `buyWardrobe(ids[], outfit)`. Online, NetEconomy could not map the id array (`unknown`). In single, a one-item basket only worked by accident and stored the outfit object as the colour. Now each item is bought with `buyWardrobe(id, colour)` in sequence; the loop stops at the first refusal, everything owned is worn, and the failed item is reported.
3. **Rate limit.** The server accepts at most one outfit change per second and dropped quick follow-ups silently. `NetEconomy.setOutfit` now coalesces changes into that window and resolves every caller.
4. **Starter dye charge.** An owned starter in its default colour was charged as a dye. The client economy and the server `buyClothing` now treat the default colour as owned.
5. **Stale server pack.** The deployed pack had a stale wardrobe table with old sample ids, so most glasses were `unknown`. The new pack fixes this.

`Economy.setOutfit` now:
- accepts `{slot: id}` or `{slot: {id}}` with item-slot keys only;
- awaits the server online;
- on refusal, restores the server state and emits `economy:outfitRefused`.

`WardrobeTab.applyOutfit` updates the player only after the economy accepts the outfit.

Regression tests:
- `tools/economy/test-economy.mjs`
- `server/test/anticheat.test.js`
- `server/test/features.test.js`
- `src/characters/test/wardrobe.test.mjs`

## Remote avatars (multiplayer, J)

```js
import { createRemoteAvatars } from './characters/index.js';
const avatars = createRemoteAvatars(game, { max: 200, colliders: false }); // create at init
const h = avatars.add(playerId, { seed });   // seed defaults to a hash of the id, so every client gets the same look
h.set({ x, y, z, yaw, speed, state });       // state: idle | walk | run | jump | fall | drive | ragdoll | swim
avatars.update(dt);                          // once per frame
avatars.remove(playerId);
```

- Positions are smoothed. Jumps larger than 8 m snap.
- `drive` hides the avatar.
- `ragdoll` shows a lying pose (visual only).
- `colliders: true` adds a kinematic capsule per avatar. Only the local player's controller collides with it; vehicles don't. It also adds CHARACTER to the player's controller query.
- The local player can use the same appearance with `new PlayerController(game, sp, { lookSeed })` or `player.setLook(seed)` (`lookFromSeed`).
- Outfits: `avatars.add(id, { outfit })` and `h.set({ outfit })`. The look is rebuilt only when the outfit changes (the key is compared first), so sending it with every state update is fine. Use `decodeOutfit(codes)` for the wire form (see "Wardrobe").

## Cash (`game.cash`)

- `drop(x, y, z, amount, {scatter, expire = 60, reason = 'pickup'})`: drops 1–3 spinning bill stacks with a glowing "$". They hop outwards and land.
- Pickup radius is 2.5 m on foot and 3.4 m in a vehicle. Collecting calls `player.addMoney(amount, pos, reason)`.
- Hidden stashes near landmarks and district centres are offline/sandbox only. They are off when `game.economy`, `game.net` or online mode is present.

## Events

- Emitted:
  - `vehicle:enter`, `vehicle:exit`
  - `money:pickup {amount, position, reason}`
  - `ped:knocked {position, ped, strength}`, `ped:carjacked {position, vehicle}`, `ped:panic`
  - `impact {kind: 'ped', strength, position, material: 'body'}`
  - `footstep {position, surface: concrete|grass|sand|dirt|mud|water, run, land?}`
  - `splash {position, strength}` (falling into water)
  - `player:damage {amount, kind, health, armor}`
  - `wasted {kind}`, `respawn`, `waypoint:reached`
  - `player:outfit {outfit}` (canonical outfit after `setOutfit` changed the look)
- Consumed: `explosion`, `fire:start`, `fire:stop`, `vehicle:destroyed` (kills the occupant), `impact` (panic), `horn`, `economy:outfit {outfit}` (dresses the player).

## i18n keys (G)

| key | English |
|---|---|
| `help.enter` | `Press <b>F</b> to get in` |
| `help.carjack` | `Press <b>F</b> to take this car` |
| `help.onFoot` | `<b>WASD</b> move · <b>Shift</b> sprint · <b>Space</b> jump/climb · <b>F</b> enter vehicle · click to look around` |
| `respawn.hospital` | `HOSPITAL` |

Also used, existing: `mode.free`, `gps.arrived`.

## Performance (MacBook, headless Chromium, lab at Ocean Beach)

- Downtown street crowd (lab, 240 peds, auto LOD: full < 25 m, mid < 55 m, impostor beyond, shadows < 30 m), 10 s windows, CPU per frame:

  | | peds update | `render()` | human draws | human triangles (shadow) |
  |---|---|---|---|---|
  | with peds | 0.49 ms | 3.26 ms | 14 | 8.8k (2.9k) |
  | without peds | 0.04 ms | 2.82 ms | 9 | 1.8k (1.8k) |

  The crowd costs about 0.9 ms of CPU per frame and 5 extra draw calls. GPU time is not measurable in headless software GL.
- Crowd soak, lab `__labTools.cruise({speed: 14, seconds: 180})` (drives the focus and camera along random roads) plus `__labTools.crowdStats()`:

  | | before | after |
  |---|---|---|
  | ped-samples on the asphalt (outside a crossing; knocked-down excluded) | 33,035 (about 50 of 140 peds) | 4 (all fleeing peds just pushed off; 0 visible) |
  | max street peds per 20 m cell | 13 | 9 (≥ 8 in under 0.1% of cell samples) |

  Spawning after the rework: 2.3/s on average and at most 13/s (the 50/s startup fill excluded).

- Pedestrian update (simulation + animation + instance upload):
  - 200 peds with auto LOD: 0.34 ms/frame average, 1.4 ms worst frame.
  - 200 peds forced to the near LOD: 0.39 ms average (72 in view).
  - Beach scene with 220 peds: 0.25 ms.
- Ragdolls: `world.step` takes 0.54 ms with 6 flying ragdolls, against 0.37 ms without, so about 0.03 ms per ragdoll per step. The headless test gives 0.21 ms per step for 6 ragdolls plus a minimal world.
- Human rendering at Ocean Beach (lab, 13:00, high quality; see the report for the before/after table): street view
  22k triangles (13k in shadow casters) vs 474k (464k) before; beach view 10k (4k) vs 802k (785k) before.

## Needs from other workstreams

- **Integrator:**
  - main/bootstrap/vite lines above;
  - `game.traffic.takeOver(agent)` (a fallback is in place);
  - optional `renderer.compile` prewarm.
- **A, vehicles:**
  - glass is fully opaque, so seated drivers only show through open doors or on bikes. Semi-transparent glass (about 0.6 opacity) would show them.
  - Seats are used as hip points. They are auto-lowered and reclined to fit under `spec.collider.cabin.top`.
  - `telemetry.steer` on non-`Vehicle` controllables would drive the head turn.
- **B, air and boats:** `seats[0] = {pos (hip, local), exit, pose: 'heli'|'plane'|'boat'|'bike'}` on controllables. Without it, a bounding-box fallback is used.
- **C, audio:** the events above, in particular `footstep` (with `surface`), `splash`, `impact` with kind `ped`, and `money:pickup`.
- **E, damage/fx:** `vehicle:destroyed` with `{vehicle}`, `explosion {position, power, radius}`, `fire:start/stop {position, target}`.
- **F, render/quality:** optional `quality.pedsMax` and `quality.ragdollsMax`. A `low` quality name shortens the LOD distance and halves the beach crowd.
- **G, UI:**
  - show `player.armor` and `player.breath`;
  - add the i18n keys above;
  - `ui.showHelp(html, seconds)` and `ui.toast` are used.
- **L, wardrobe:**
  - add `jacket` to `WARDROBE_SLOTS` (a layer over the top; price it like `top`);
  - regenerate the table with `node tools/economy/build-wardrobe-prices.mjs` (`--check` reports it is out of date: 185 items now);
  - `economy.outfit` may use any form above. Ids from the provisional sample that no longer exist are dropped.
  - Prices are yours. Check the luxury ceilings: the full-drip set and the diamond watch reach $249k, and the sequin shirt and jacket $139k.
- **G, wardrobe UI:**
  - map the item slot `facial` to your `beard` category (`SLOT_ALIAS.facial = 'beard'`);
  - the canonical outfit keys are item slots (`top`, `jacket`, `hat`, `accessory`, `tattoo`, `facial`), so read the current item with your own slot mapping instead of `outfit[cat]`;
  - `player.setOutfit` merges, so passing your merged try-on object is fine.
- **J, outfits:** send `encodeOutfit(outfit)` (≤ 11 u16, colours included) instead of server wardrobe indices, or alongside them. Apply it with `avatars.add(id, { outfit: decodeOutfit(codes) })` or `h.set({ outfit })`. Ownership checks can use `WARDROBE_BY_ID` (`starter` items are always owned).
- **J, remote vehicles for pedestrian avoidance:** please expose `game.net.remoteVehicles()`. It should return the remote players' vehicles near the local player as `[{ x, y, z, yaw, hw, hl, vx?, vz?, speed? }]`, where `y` is the body centre, `yaw` is three.js `rotation.y`, `hw`/`hl` are half width and half length in m, and on-foot players are left out. A reused array is fine. Until it exists, `obstacles.js` reads `game.net.store.list` (`x, y, z, yaw, vx, vz, model, alpha, state`) and `game.net.vehicles.dims(model)` as a fallback. There is no `src/net/INTEGRATION.md` yet to put this in.
- **J and L:** `createRemoteAvatars`, `game.economy.earn/charge`, `game.spawns.pickSpawn('hospital', {x, z})` returning `{x, z, name?}`.

## Knock-downs (impact.js)

- Car hits: launch = relative speed × (0.85 − 0.1k), capped at 16 m/s horizontal along the car's motion (plus up to 28%
  sideways on glancing hits); vertical ≤ 25% of horizontal; spin about (direction × up) ≤ 4.2 rad/s (legs swept,
  head falls onto the hood). The ped starts just outside the car body. Above ~40 km/h a temporary sloped
  "hood ramp" collider (CHARACTER-only, massless, 1.6 s) lets the body roll over hood and roof instead of being
  bulldozed by box cabin colliders. The car loses the momentum given to the ped (`pushVehicle`; AI traffic gets its
  speed reduced).
- Explosions: `blastKnock` falloff, horizontal ≤ 12.8 m/s, vertical ≤ 32% of horizontal, capped spin.
- Ragdolls: 70–92 kg spread over 11 bodies, linear damping 0.3, no restitution, friction 1.0 (average combine),
  spin clamped to 7 rad/s and lift to 6.5 m/s before and after every physics step.
- Distant peds without a ragdoll use `tumbleStep` with the same launch (plus the push a ragdoll gets from the
  hood): ballistic flight with air drag, then a sliding roll with 6.5 m/s² friction.
- Headless results (`test/knock.test.mjs`, driver brakes after 0.4 s): 30 km/h → 8.7 m, 80 km/h → 34 m (hood roll),
  blast at 3 m → 4.3 m; peak pelvis ≤ 1.5 m; spin ≤ 7 rad/s; car slowdown 1.3–7.6 km/h.

## Known limits

- Peds don't path around buildings when fleeing off the sidewalk: they flee along sidewalks, or freely on beaches.
- Ped–ped overlaps are ignored.
- Vehicle avoidance plans around one car at a time. A row of cars bumper to bumper can make a ped wait and turn back even when there is a way around the whole row.
- Spherical ragdoll joints have no cone limits in rapier3d-compat 0.21 (no motors on spherical joints). Angular damping keeps them sane; elbows and knees are limited.
- Ragdolls only exist for close, visible characters. Others use a scripted tumble.
- No interior door/handle animation for traffic models other than CarModel vehicles. Aircraft and boats have no door step.
- Remote avatars are visual only: their `ragdoll` state is a pose, not physics.
