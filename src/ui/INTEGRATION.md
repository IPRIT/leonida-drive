# UI & i18n (workstream G) — integration notes

## Entry points

```js
const uiMod = await import('../ui/index.js');      // also imports styles.css + fonts
const loading = uiMod.showLoading(container);      // language detected before data loads
game.ui = uiMod.createUI(game, { container, mapImage });  // creates game.i18n too
```

`createUI` must run after `game.worldData`, `game.player`, `game.vehicles`, `game.sky`, `game.terrain`, `game.world3d`
exist (current bootstrap order is fine). `game.audio`/`game.weather` may appear later (modules): the UI resolves them
lazily and re-applies saved volumes on the `start` event.

Lab: `lab-ui.html` (dev server only — add it to `vite.config.js` `rollupOptions.input` if it should be built).
`lab-ui.html?mock` runs the UI on a mock game without the 3D world.

## `game.ui`

| method | what |
|---|---|
| `toast(big, small?, seconds?)` | big centred message (welcome, arrival) |
| `notify(textOrCard, seconds?)` | notification feed card, top-left. Card: `{ title, text, icon, color }` |
| `feed({ kind, text, icon?, seconds? })` | card with a preset look: `garage, gps, weather, player, world, settings, bank, info` |
| `showHelp(html, seconds?)` | help box, top-left |
| `showRadio(name, genre?)` | radio station popup, top centre (for C); `genre` may be `synthwave`/`lofi`/`latin` (→ `radio.genre.*`) or text; empty name → `radio.off` |
| `wasted(bool)` | wasted banner (localised) |
| `setMode(text \| { key })` | top-centre mode tag; `{ key: 'mode.free' }` re-translates on language change |
| `showVehicleName(name, sub?, id?)` | vehicle name popup with a small preview (also shown automatically on `vehicle:enter` with the category) |
| `open(tab?)`, `close()`, `isOpen` | pause menu; tabs: `map, vehicles, service, wardrobe, world, player, settings, controls, stats, about` |
| `setWaypoint(w)`, `teleport(x, z, name?)` | used by the menu, usable by others (adds a feed card) |
| `update(dt)` | per frame (also while paused) |
| `renderBackdrop()`, `invalidateBackdrop(frames?)` | the paused loop (`src/core/bootstrap.js`) re-renders the 3D scene behind the open pause menu only when this returns true: the world is frozen, so the canvas keeps its last frame and the frame budget goes to the menu. Anything that changes the picture while paused calls `invalidateBackdrop()` (settings, resize, weather/time, `vehicle:service`, `wardrobe:outfit`, `world:clearWrecks`, `ui:purchase`, `gravity` events already do) |
| `stats` | `Stats` (persisted in `localStorage['leonida.stats']`): `stats.bump(key, n)` |
| `simulate` | lab only: `{ kind, telemetry }` overrides the HUD source |
| `setPlayerBlips(list)` | other players on the radar and the big map: `[{ x, z, color, heading (compass rad, 0 = north), label }]` |
| `mount(slot, el)` / `hud.mount(slot, el)` | HUD extension slots → `unmount()`: `'top-center'` (online counter), `'top-right-under-money'` (mini leaderboard), `'world-overlay'` (full-screen, `pointer-events: none`, for nametags) |
| `menu.addTab({ id, icon, labelKey, create, before?, after?, available? })` | extra pause-menu tab (default: before Settings). `create(container, ui, game)` → `{ show(), hide(), update(dt), destroy(), hints?() }`. Focusable elements need the `data-nav` attribute (arrows/Enter/gamepad work then). `menu.removeTab(id)` |
| `menu.status(text \| { text, icon, color })` | short confirmation line in the menu footer (feed cards are hidden while paused; `ui.notify` routes there automatically) |
| `menu.confirm({ title, text, ok, cancel })` | GTA-style confirm dialog → `Promise<boolean>` |
| menu performance model | built-in tabs are built in idle time after `start` and kept; the closed menu and inactive tabs use `content-visibility: hidden` (layout kept, nothing rendered). A tab's `hide()` runs on a tab switch, `onMenuClose()` when the menu closes (dispose live previews there). Live previews (vehicle turntable, character preview) must stop by themselves when their element is not visible (IntersectionObserver) — they are kept across tab switches. Bench: `src/ui/menu-bench.js` |

Icons for cards (`src/ui/icons.js`): `car sport suv pickup van service truck bus small motorcycle bicycle heli plane boat
pin money sun partly cloud lightRain heavyRain storm fog auto cog user info star starFill globe wrench heart shield trash
clock gamepad keyboard chart map search bolt check plus skull gravity`.

## `game.i18n`

```js
i18n.t('veh.spawn')                        // "Spawn & drive"
i18n.t('notify.spawned', { name: 'Comet' }) // placeholders {name}; numbers get locale grouping
i18n.t('veh.count', { count: 5 })          // plurals: keys veh.count_one / _few / _many / _other (Intl.PluralRules)
i18n.money(1234567)                        // "$1,234,567" / "$1 234 567" / "$1.234.567" (always "$", Latin digits)
i18n.number(1234.5)                        // locale grouping, Latin digits
i18n.lang, i18n.dir ('ltr'|'rtl'), i18n.pref ('auto'|code), i18n.languages [{ code, name (native), en, dir }]
i18n.setLang(code | 'auto')                // prefer game.applySetting('lang', code) — persists and re-renders
i18n.onChange(fn) → off                    // after the locale file loaded; also emits game event 'lang' { lang, dir }
i18n.register(ns, { en: {...}, ru: {...} }) // your own strings: t(`${ns}.${key}`)
i18n.font('ui' | 'display')                // CSS font stack of the active script, for canvas text
```

Languages (30): en, ru, es, pt-BR, fr, de, it, zh-CN, zh-TW, ja, ko, ar, hi, bn, tr, pl, uk, nl, id, vi, th, fa, sv, cs,
ro, el, hu, he, ms, ur. Auto-detected from `navigator.languages` (`pt-*`→pt-BR, `zh-TW/HK/Hant`→zh-TW, other `zh`→zh-CN,
`iw`→he, `in`→id), fallback `en`; `game.settings.lang` = `'auto'` by default. RTL: ar, fa, ur, he (`<html dir="rtl">`;
menu side panels, lists and text mirror; HUD geometry and numbers stay LTR like in GTA).

**Other workstreams:** register a namespace with at least `en` (and `ru` if you like), e.g.

```js
game.i18n?.register('air', { en: { gear: 'Gear', stall: 'Stall!' }, ru: { gear: 'Шасси', stall: 'Сваливание!' } });
const label = game.i18n?.t('air.gear') ?? 'Gear';
```

Send the key list to G to get the other 28 languages; curated translations go into `src/i18n/locales/<code>.js` under
the same `ns.key` names (locale files win over registered dictionaries). Validate with
`node src/i18n/check-locales.mjs [codes]`. Keys already used by others: `mode.free`, `gps.arrived` (BasicPlayer).
Vehicle descriptions can be localised with keys `vehdesc.<catalogId>` (falls back to the catalog `desc`).

Fonts: Oswald / Russo One / Yellowtail (Latin, Latin-ext, Cyrillic, Vietnamese subsets via unicode-range). Greek, CJK,
Arabic/Persian/Urdu, Hebrew, Devanagari, Bengali and Thai use system font stacks selected by `html[data-script]`
(see the top of `styles.css`). Letter-spacing and synthetic italics are disabled for those scripts.

## Game modes (online vs singleplayer)

The UI reads `game.can(cap)` / `game.online` (docs/ARCHITECTURE.md → Game modes) and **hides** sandbox controls online:
World tab (weather, time of day, time speed, population, fun) disappears; Player tab keeps status + flip/reset only
(no refill, add money, invincibility, repair, quick teleport); Map has no Teleport button, no double-click/Space
teleport, the fast-travel list becomes “Destinations” that set a GPS waypoint; `ui.teleport()` is a no-op online.
Vehicles tab stays; online it shows a rate-limit note and calls `game.net?.canSpawnVehicle(id)` → `{ ok, waitS }`
before spawning (refusal → footer status “Wait N s”). Settings → GAME MODE has the Online / Singleplayer cards
(confirm dialog → `game.switchMode(mode)`). A mode badge (green dot ONLINE / SINGLEPLAYER) is shown in the menu
header and on the loading screen (which reads `?mode=` / `localStorage['leonida.mode']` itself). Loading tips about
teleport/weather are skipped online.

## Cartography hook (workstream H)

- Radar: if `game.cartography.drawRadar` exists, `Hud.drawRadar` calls
  `drawRadar(ctx, 300, 190, state, dt)` and draws nothing itself. `ctx` is already scaled by devicePixelRatio (draw in
  CSS pixels; the canvas is 300×190 CSS px, rounded-rect frame via CSS). `state`: `{ x, z, heading (radar rotation,
  rad = −compass), compass (deg), speedKmh, radarAlt (m, zoom out when flying/free cam), route (flat [x,z,…]),
  waypoint {x,z}, blips [{x,z,color}], playerBlips [...] }`.
- Full map: if `game.cartography.createFullMap` exists when the MAP tab is first shown, the UI mounts it into
  `.mapwrap` (hiding its own canvas): `createFullMap(el, { onTeleport | null, onWaypoint, canTeleport })` →
  `{ show({x,z}), hide(), update(dt, input), destroy() }`. The fast-travel/destinations list stays and calls
  `show({x,z})` to preview. Keep the “Data: map.stateofleonida.net” attribution visible (it's in `.mattr`, bottom-left).

## Style tokens for other UIs (multiplayer etc.)

CSS variables (`:root`): `--pink --orange --purple --teal --gold --gta-green --gta-blue --money --ui-bg --sel-bg
--sel-fg --text-shadow`, fonts `--f-ui` (body), `--f-disp` + `--fw-disp` (headers), `--f-num` (numbers), `--f-script`
(vehicle names) — font vars switch automatically per script/language. Reusable classes: `.mbtn` (+ `.primary`),
`.row` (settings-style row), `h3.sec` (section header), `.chip`, `.key` (key cap), `.modebadge`, `.cols/.col`
(two-column panel layout); focused element gets `.focus` (white GTA highlight on rows/chips).

## Events

Emitted: `ui:open {tab}`, `ui:close`, `ui:click`, `ui:hover`, `ui:notify` (feed card shown — for the audio module),
`ui:purchase {id, price}` (vehicle / service / wardrobe / nickname bought — purchase sound), `vehicle:service {id, vehicleId, …}`, `wardrobe:outfit {outfit}`,
`lang {lang, dir}`, `world:clearWrecks`, `gravity {scale}`.
Listened: `start` (welcome message, re-apply settings), `money:pickup` (+$ pop), `economy:combo {combo}` (combo badge),
`tank:reload {t}` (tank reload ring),
`vehicle:enter` (name popup),
`explosion`, `vehicle:destroyed`, `wasted`, `impact` (stats).

## Settings written by the UI (`game.applySetting`) and fallbacks

| key | values | handled by | UI fallback when nobody subscribed with `game.onSetting` |
|---|---|---|---|
| `lang` | `'auto'` \| code | i18n | — |
| `quality` | `auto low medium high ultra` | bootstrap/F (`render.setQuality`) | — |
| `autoRes`, `drawDist` | bool, 0.5–1.6 | bootstrap | — |
| `resScale` | 0.5–1 (when `autoRes` off) | **F please** | sets `render.scale` + `resize()` |
| `fx.bloom` `fx.ao` `fx.ssr` `fx.reflections` | bool | **F please** (rows appear for keys present in `game.quality`) | bloom pass on/off; also calls `game.render.setEffect?.(name, v)` |
| `fx.shadows` | 0–3 | **F please** | `game.render.setEffect?.('shadows', v)` |
| `weather` | `auto clear partly overcast lightRain heavyRain storm fog` | **F please** | `weather.set(name, 8)`; auto → `weather.setAuto?.(true)` or `weather.auto = true` |
| `timeMode`, `timeScale` | `cycle/freeze`, 1/4/10 | bootstrap (`timeMode`); **timeScale: F/integrator please** | `sky.timeScale = base × k` |
| `traffic`, `peds` | 0–1.5 | **integrator please** | `traffic.max` / `peds.max` = base × min(1, k) (can only reduce) |
| `volume`, `volMusic`, `volSfx`, `volAmbient`, `volEngine`, `volUi` | 0–1 | C (`onSetting`) | UI calls `game.audio.setVolume(bus, v)` directly too |
| `audioHrtf` | bool | C | — |
| `units` | `kmh` \| `mph` | everyone reading speeds | — |
| `camSens`, `invertY` | 0.3–2, bool | **cameras (A/B/D) please read `game.settings`** | — |
| `assists` | bool | bootstrap | — |
| `showFps`, `hudScale` | bool, 0.8–1.3 | UI | — |
| `hour` | — | the World tab calls `game.sky.setTime(h, { smooth: true })` directly | — |

Not persisted (session toggles): low gravity (`game.world.gravity` ×0.35, `game.lowGravity`), invincibility
(`game.player.invincible = true` — **D: please respect it when applying damage**).

## Credits

About tab: map-source card (“State of Leonida” → https://map.stateofleonida.net/, `credits.mapSource`), credits list,
disclaimers (`credits.disclaimer`, `about.disclaimer`). The loading screen has a one-line footer with
`credits.mapSourceShort` + link + disclaimer; the map shows “Data: map.stateofleonida.net”. Links open in a new tab.
The author badge was removed on request (`credits.madeBy` stays in the locales, unused). Long lines wrap
(`overflow-wrap: anywhere`), the About panel scrolls; checked in Russian at 812×375.

## Vehicle previews (A: `game.thumbnails`)

`ui.thumbs` (src/ui/thumbs.js) uses `game.thumbnails` when present: `get(id)` → canvas/ImageBitmap/null,
`request(id, priority)` (1 = visible card, 0 = prefetch of the first screenful), `onReady(cb(id))`,
`createTurntable(el, id)` → `{ setId, dispose }` (mounted into the Garage detail panel while the tab is open, disposed
on tab hide; its element should fill the container). Without the service it falls back to
`renderVehicleThumbnailCanvas` / `renderVehicleThumbnail` from `src/vehicle/thumbnail.js` (one render per frame,
skipping frames after slow renders), else the category icon. Cards show a shimmer skeleton until ready. The
vehicle-name popup shows the preview of the entered vehicle (`showVehicleName(name, sub, id?)`).

## Economy (L: `game.economy`, docs/ECONOMY.md)

Used when present (otherwise everything is free/spawnable as before): `money`, `owns(id)`, `price(id)`, `buy(id)` →
`{ok, reason}`, `sell(id)`, `onChange(cb)`; optional `isStarter(id)` (or `starters` Set), `sellPrice(id)` (default 55%),
`grant(amount, reason)` (sandbox “Add money”; falls back to `player.addMoney`), `setUnlockAll(bool)` (or
`unlockAll` property; owns() should then return true). Garage: price / OWNED / STARTER badges, Owned/All/Affordable
filter, BUY (disabled “Need $Y more”) → confirm → `ui:purchase {id, price}` event + PURCHASED stamp; owned: SPAWN
(online rate-limit via `game.net?.canSpawnVehicle`) and SELL (not starters) with confirm. HUD money reads
`economy.money ?? player.money`; the combo badge (×1.5…×5) listens to `economy:combo {combo}`. The Player tab (single +
`can('money')`) keeps “Add money” and adds “Unlock all vehicles”. Leaderboard rows (J) should show net worth.

## Service tab (L: service items) and tank (A)

Pause menu → SERVICE (both modes). Top: current vehicle preview, Engine/Body bars (`damage.engine/body`), status
chips (OK / ON FIRE / WRECKED / ARMOURED / INSURED, extinguishers ×N). Services: repair, extinguisher, armour
plating, insurance, nitro refill. Cosmetics for any owned vehicle (picker): neon underglow colour, window tint
0–3, horn (`car|sport|luxury|truck`, preview plays `audio.loop('horn:<type>')`), respray (palette/custom, gloss/pearl).
Buttons show `Processing…` while the promise is pending, then a footer status (done / failed + reason) and a flash.

**L, please implement (names the UI already calls; all optional):**
- `economy.buyService(id, vehicleId, opts)` → `Promise<{ ok, reason?, cost? }>`; ids `repair | extinguisher | armor |
  insurance | nitro | neon | tint | horn | respray`; opts: neon `{color}` (0 = off), tint `{level}`, horn `{horn}`,
  respray `{color, finish: 'color'|'pearl'}`. Reasons with UI texts: `funds, syncing, offline, rejected, notOwned,
  undamaged` (others are shown raw).
- `economy.servicePrice(id, vehicleId, opts)` → number (fallbacks: `services[id].price`, repair → `repairCost(v)`).
- `economy.services` (optional array/object of offered ids — limits the rows), `economy.inventory`
  `{ extinguisher: n, insuranceUntil?: ms, vehicles: { [id]: { plated, insuredUntil, neon, tint, horn, color } } }`
  or `economy.vehicleMods(id)` returning that per-vehicle object; `economy.onChange` re-renders the tab.
- Without `buyService` only repair (`economy.repair(v)`, or free `damage.repair()` without an economy) and respray
  (`economy.paint(finish)`) are offered.

After a successful purchase the UI emits `vehicle:service {id, vehicleId, vehicle, ...opts}` and, for the current
vehicle, calls `v.setColor(hex, finish)`, `v.setNeon(hex|null)`, `v.setTint(level)`, `v.hornType`/`v.setHorn(type)`,
`v.refillBoost()` if they exist — **A: please add setNeon/setTint/setHorn/refillBoost; E: armour plating = less damage
when `vehicleMods(id).plated`; L or E: using an extinguisher (`economy.useExtinguisher?.(v)`).** Also emits
`ui:purchase {id, service: true}`.

**Garage:** category `military` (aliases tank/army/armored), icon tank. Vehicles you can't afford show a LOCKED
overlay; military vehicles and ≥ $1M get a gold "premium" frame; the detail panel shows a savings bar
"You have $X of $Y" above the disabled BUY button.

**HUD:** a vehicle health bar (engine = main bar, body = thin line; red when < 30 %, blinking red when burning) next to
the speedometer/instruments for every vehicle with `damage`. In a tank (`kind === 'tank'`, `catalogId === 'tank'` or
`v.turret`) a centre crosshair and a reload ring: event `tank:reload` `{ t }` = seconds until the cannon is ready
(sent when firing; streaming the remaining time also works), optional `{ total }` or `{ progress: 0..1 }`.
The ring runs on wall-clock time.

**Respray finish:** Gloss ($500) / Pearl ($2,500) is a segmented control (accent = selected, hover = subtle, keyboard
focus = outline; sticky). The price passes `{ color, finish }` to `servicePrice`/`buyService` (fallback `economy.paint`).
On success the UI calls `v.setFinish(finish)` or `v.setPaint({color, finish})` when present; otherwise it tunes the shared
`MeshStandardMaterial` (`materials.paint`): pearl = metalness 0.78 / roughness 0.13. **A: please add
`setPaint({ color, finish: 'color'|'pearl'|'metallic' })` with a proper clearcoat (MeshPhysicalMaterial) and persist the
finish per vehicle (L: `vehicleMods(id).finish`).**

## Wardrobe tab ("Внешность") — D: items + preview, L: prices / ownership / nickname

- **Preview:** `createCharacterPreview(game, el)` exported from `src/characters/wardrobe.js` (or `preview.js`), or
  `game.characters.createPreview(el)` → `{ setOutfit(outfit), rotate(yawRad /* absolute */), setView?('body'|'face') |
  zoom?(...), dispose() }`. Mounted when the tab opens, disposed when it closes (renders only while visible). The UI
  provides drag-to-rotate (mouse/touch), right stick or `[` `]`, and Full body / Face presets.
- **Items:** `WARDROBE` | `WARDROBE_ITEMS` | `ITEMS` exported from `src/characters/wardrobe.js`, or `game.wardrobe.items`:
  `{ id, slot: hair|beard|tops|jackets|legs|shoes|hats|glasses|accessories|tattoos|body (aliases ok), name | nameKey,
  tier: basic|street|premium|luxury, price, colors: [hex], thumb?: url }`. Item names: `nameKey` or i18n `wd.item.<id>`.
- **Outfit format:** `{ [slot]: { id, color } }`. Current: `economy.outfit ?? player.outfit`. Try-on only changes the
  preview; WEAR / BUY ALL call `economy.setOutfit(outfit)` and `player.setOutfit(outfit)` and emit `wardrobe:outfit`.
- **L:** `ownsWardrobe(id)` (or `ownedWardrobe` Set/array/function; price 0 = free), `wardrobePrice(id)` (else
  `item.price`), `buyWardrobe(ids, outfit)` → `Promise<{ok, reason}>`, `outfits` (3 saved) + `saveOutfit(i, outfit)`
  (fallback: localStorage `leonida.outfits`), `changeNick({ mode, value })`: `suggest` → `{ ok, suggestions: [3] }`,
  `check` → `{ ok, available, reason? }`, `random`/`custom` → `{ ok, nick?, reason? }` (charges);
  `nickPrice(mode)` (fallback $2,500 / $50,000). Current nickname: `game.net.me.nick`. Custom nickname hints on the
  client: 3–16 chars, `[A-Za-z0-9_-]`; the BUY button unlocks only after a successful `check` of the same value.
  Purchases show pending states and footer confirmations; `ui:purchase` is emitted.
- Without D's data the tab shows a placeholder silhouette and “clothes are still being sewn”; Profile still works when
  `changeNick` exists.

## Mobile (K)

Under `body.is-mobile`: radar top-left, money + combo + health/armor/nitro top-right (the bars are moved there once
when the class changes), feed under the radar, speedo/area/vehicle name scaled down on the upper right; bottom
corners are left free; `env(safe-area-inset-*)` respected (index.html needs `viewport-fit=cover` for non-zero insets).
A round ☰ menu button (also shown on any `pointer: coarse` device) opens the pause menu; tapping the radar opens the
map. Pause menu: ≥ 44 px targets, horizontally scrollable tabs, keyboard hints replaced by a single Back button,
compact header below 520 px height; Garage categories become a scrolling strip; portrait layout stacks panels.
The map supports touch drag, pinch zoom, tap (waypoint) and double tap (teleport, singleplayer).
Settings → “Touch controls” (only when `game.input.touch`): `touchScale` 0.6–1.6, `touchOpacity` 0.2–1,
`touchLeftHanded`, `tiltSteer` via `game.applySetting` (K subscribes with `onSetting`). No per-frame DOM work added.

## Settings migration

`createUI` migrates stored settings to `v: 2`: music volume `volMusic = 0.1` once (new players too). C's own default
for `volMusic` should also be 0.1.

## What the HUD reads

- Player (D): `health`, `armor` (0..1, or 0..100 when `maxHealth`/`maxArmor` are set or values > 1.5), `money`,
  `mode`, `controllable`, `focus`, `heading`, `waypoint`, `route`, `addMoney(n, pos)`, `teleport(x, z)`,
  `setWaypoint(w)`, optional `heal()`, `invincible`.
- Land vehicles: `telemetry.speedKmh, rpm, maxRpm, gear, boost (0..1 nitro bar), drifting`.
- Aircraft (B), `kind: 'heli' | 'plane'` — all optional, with fallbacks from the rigid body:
  `telemetry.airspeedKmh` / `airspeed` (km/h; else `speedKmh`), `altitude` (m above ground; else body y − terrain),
  `verticalSpeed` (m/s; else `linvel().y`), `heading` (deg, 0 = north; else player heading), `throttle` (0..1, or
  `collective`), `gearDown` (bool; or `gear: 'down'|'up'`), `flaps` (0..1 → shown as %), `stall` (bool), `landed`
  (bool, suppresses PULL UP).
- Boats (B), `kind: 'boat'`: `telemetry.speedKmh`, `throttle` (0..1, reverse when `gear < 0`), `anchor` (bool).
- Vehicles menu (A): spawnable list = `game.vehicles.catalog` (enriched by id with `VEHICLE_CATALOG` from
  `src/vehicle/catalog.js`, optional). Categories accepted: `compact sedan coupe sports super muscle classic suv pickup van
  luxury service truck(s) bus(es) small motorcycle(s) bicycle(s) heli(copter) plane boat` (plurals/aliases fine).
  Thumbnails: export `renderVehicleThumbnail(id, renderer, size) → dataURL` from `src/vehicle/catalog.js` (or
  `src/vehicle/thumbnails.js`); the UI renders them lazily, one per frame, only for visible cards. Spawning calls
  `game.spawnForPlayer(id, { color })` (color = number).
- Clear wrecks: despawns unoccupied `game.vehicles.active` with `destroyed`/`wrecked` (or `damage.destroyed`), and calls
  `game.damage.clearWrecks?.()` / `game.traffic.clearWrecks?.()` (return a count) — **E / integrator: implement if you
  keep wrecks**.

## Controls tab

Bindings live in `src/ui/controls-data.js` (keyboard + gamepad per mode). Helicopter, plane and boat follow
`src/air/controls.js` (B). On-foot bindings are GTA-convention placeholders — **D: tell G your final bindings**.

## Notes for the integrator

- `src/world/regions.js` has a Russian region subtitle `'Национальный парк'`; the UI translates it (and
  `'National Park'`) through `area.nationalPark`, but `'National Park'` in the data would be cleaner.
- Gamepad: Start toggles the menu, Back opens the map; in the menu LB/RB tabs, D-pad/left stick navigate, A select,
  B back; map: A waypoint, X clear, Y teleport, LT/RT zoom, R3 list.
- Keyboard in the menu: Q/E tabs, arrows, Enter, Backspace (back) / Esc (close), map: arrows/WASD pan, +/− zoom,
  Enter waypoint, Space teleport, Delete clear, Tab list; vehicles: F favourite, / search.
- HUD cost measured in the lab: ~0.17 ms/frame average (radar canvas included), DOM text is only touched when it changes.
