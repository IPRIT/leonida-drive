# Mobile (workstream K): integration notes

Touch controls, orientation/viewport handling and the mobile performance profile. Everything lives in `src/mobile/`;
no other workstream's file was edited. Runtime hooks into other modules are listed in "Runtime hooks" below.

## Files

| file | what |
|---|---|
| `index.js` | `createMobile(game, opts?)` module factory, `MobileModule` (= `game.mobile`), pause reasons, settings, i18n |
| `TouchControls.js` | the overlay: context layouts, pointer routing (Pointer Events + `setPointerCapture`, multitouch) |
| `VirtualPad.js` | standard-mapping virtual gamepad; `poll()` is allocation-free, returns one persistent object or `null` when idle |
| `camera.js` | touch camera drag on the active camera (chase / on-foot orbit / aircraft / free camera) |
| `tilt.js` | tilt steering from `deviceorientation` (gravity projected on the screen plane, works in any tilt-back pose) |
| `viewport.js` | portrait "rotate your phone" screen, fullscreen + orientation lock, iOS gestures, debounced resize, pause on hide/blur |
| `perf.js` | F's `mobile` quality preset, traffic/peds/vegetation budgets, 60 fps frame cap |
| `haptics.js` | `navigator.vibrate` pulses (buttons, gear changes, impacts on the player, cash pickups, vehicle enter/exit, explosions) |
| `detect.js`, `math.js` | pure helpers (device detection, inverse stick curves, tilt angle, frame gate) |
| `icons.js` | original inline SVG icons (also used by the CONTROLS tab's touch legend) |
| `photo.js` | photo mode on touch: drag orbit, pinch zoom, two-finger pan, shutter / panel / exit buttons + hint |
| `mobile.css` | overlay + rotate screen styles, `body.is-mobile` viewport rules, one HUD re-stack override |
| `lab-mobile.js`, `/lab-mobile.html` | lab page |
| `test.mjs` | `node src/mobile/test.mjs`: inverse curves, tilt maths, frame cap at 60/90/120/144 Hz, pad latching, detection |

## What the integrator must add

1. **Register the module** (`src/main.js`; any place in `options.modules` works, it registers itself with `order = 1`):

   ```js
   import { createGame } from './core/bootstrap.js';
   import { createMobile } from './mobile/index.js';

   createGame(document.getElementById('app'), {
     modules: [(g) => createMobile(g)],
   });
   ```

   Create it in `options.modules` (before `startLoop`), so the frame cap wraps `renderer.setAnimationLoop` from the
   first frame. Created later, it still works: it re-installs `render.loopCallback`.
   On desktops nothing is created except a few listeners: the touch layer appears on the first `pointerType ===
   'touch'` (hybrid laptops), and the cap is 0 (uncapped). `mobile.css` is imported by `index.js`; no CSS step.

2. **index.html meta** (K patches the viewport meta at runtime and logs `[mobile] viewport meta patched…`; put it in the
   file so the first paint is right). `viewport-fit=cover` is required for non-zero `env(safe-area-inset-*)` on iPhones.

   ```html
   <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-visual" />
   <meta name="mobile-web-app-capable" content="yes" />
   <meta name="apple-mobile-web-app-capable" content="yes" />
   <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
   <meta name="theme-color" content="#000000" />
   <link rel="manifest" href="/manifest.webmanifest" />
   ```

   Optional `public/manifest.webmanifest` (installed web app: real fullscreen on iPhone, landscape lock on Android):

   ```json
   { "name": "Leonida Drive", "short_name": "Leonida", "start_url": "/", "display": "fullscreen",
     "orientation": "landscape", "background_color": "#000000", "theme_color": "#000000",
     "icons": [{ "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" }, { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }] }
   ```

3. **Build input** (optional): add `lab-mobile.html` to `vite.config.js` `rollupOptions.input` if the lab should ship.

4. **Bootstrap fixes found on the way** (yours):
   - `game.onSetting('quality', (v) => render.setQuality(v === 'auto' ? 'high' : v))` turns "auto" into "high"; it should be
     `render.setQuality(v)` (Renderer resolves `auto` to the detected preset). K re-applies `mobile` after it on phones.
   - `render.attach(game)` is never called, so `game.quality` is `undefined` (K, FX, Pedestrians fall back to
     `render.profile`); call it right after `new Renderer(container)`.
   - `src/world/Traffic.js` / `src/world/Pedestrians.js` ignore `quality.trafficMax` / `pedsMax`; K caps them on
     mobile at runtime (see hooks). Reading the budgets there would let K drop that hook.
   - `InputManager.update()` allocates 3 arrays + 17 objects per frame whenever a pad (physical or virtual) is present
     (`gp.buttons.map`, `[...gp.axes]`, `_gpPrev = buttons.map`). Optional allocation-free copy:

     ```js
     if (gp) {
       const s = this._gpSnap || (this._gpSnap = { axes: [], buttons: [] });
       s.axes.length = gp.axes.length;
       for (let i = 0; i < gp.axes.length; i++) s.axes[i] = gp.axes[i];
       for (let i = 0; i < gp.buttons.length; i++) {
         const b = gp.buttons[i], o = s.buttons[i] || (s.buttons[i] = { pressed: false, value: 0 });
         if (b.pressed && !this._gpPrev[i]) this.gpPressed.add(i);
         this._gpPrev[i] = o.pressed = b.pressed; o.value = b.value;
       }
       s.buttons.length = gp.buttons.length;
       this.gamepad = s;
     } else { this.gamepad = null; this._gpPrev.length = 0; }
     ```

No `src/core/input.js` change was needed: the existing `virtualPad` hook is used as is.

## `game.mobile`

| member | what |
|---|---|
| `active` | touch layer on (phone/tablet, `?touch=1`, or after the first touch on a hybrid device) |
| `orientation` | `'landscape'` \| `'portrait'` |
| `controlsVisible`, `setControlsVisible(bool)` | hide the overlay (e.g. a full-screen map outside the pause menu, cut-scenes). Persistent until called again |
| `device` | detection: `{ touch, phone, tablet, mobile, ios, iPadOS, android, standalone, lowEnd, memory, cores, shortSide, fullscreenApi, orientationLock, reasons[] }` |
| `profile` | `{ applied, profile, reason }` of the quality switch |
| `haptic(msOrPattern)` | vibrate if supported and enabled |
| `fpsCap()` | current cap: 60 on phones/tablets (`settings.mobileFps = 120` → uncapped), 15 behind the rotate screen, 0 on desktop |
| `pad`, `controls`, `tilt`, `viewport` | internals (lab/debug) |
| `setPauseReason(name, on)` | K's pause reasons (`portrait`, `hidden`, `blur`); `game.paused` is restored only if K set it |

URL overrides: `?touch=1|0|auto` (force the overlay on/off), `?mobile=1|0` (force the phone profile + orientation handling).

## Events

Emitted: `mobile:active {active}`, `mobile:orientation {orientation}`, `mobile:controls {visible}`, and `horn {vehicle, on}`
from the touch horn button (nobody emits `horn` for keyboard/gamepad yet, see requests).
Listened: `ui:open` / `ui:close` (overlay hidden while the pause menu is open, so the map's own pinch/drag (G/H) never
competes with it; portrait pause re-applied after closing), `lang` (rotate-screen texts), `impact`, `money:pickup`,
`vehicle:enter`, `vehicle:exit`, `explosion`, `wasted` (haptics).

## Settings (`game.applySetting`, all read with defaults)

| key | values (default) | UI row |
|---|---|---|
| `touchScale` | 0.6–1.6 (1) | G, exists |
| `touchOpacity` | 0.2–1 (0.7) | G, exists |
| `touchLeftHanded` | bool (false): mirrors the whole layout (`dir="rtl"` on the overlay) | G, exists |
| `tiltSteer` | bool (false): iOS motion permission is requested inside the toggle's click; on denial K switches the setting back, un-ticks the row and posts a status line | G, exists |
| `touchSteerSens` | 0.5–2 (1): slider travel and tilt angle for full lock | **G please add** |
| `touchLookSens` | 0.5–2 (1): camera drag speed (multiplies `camSens`) | **G please add** |
| `touchHaptics` | bool (true) | **G please add** (hide when `!('vibrate' in navigator)`) |
| `mobileFps` | 60 \| 120 (60): 120 = uncapped, more battery | **G please add** (phones only: `game.mobile?.device.mobile`) |
| `touchControls` | bool (true) | optional |

Suggested i18n keys for G (English): `set.touchSteerSens` "Steering sensitivity", `set.touchLookSens` "Camera drag speed",
`set.touchHaptics` "Vibration", `set.mobileFps` "120 FPS (uses more battery)", `set.touchControls` "Show touch controls".

K's own strings are registered as namespace `mobile` (en + ru): `mobile.rotate` "Rotate your phone", `mobile.rotateSub`
"Leonida Drive is played in landscape", `mobile.menu` "Menu", `mobile.iosTip` "Tip: Share → Add to Home Screen for full
screen", `mobile.tiltOn` "Tilt steering on: turn the phone like a wheel", `mobile.tiltDenied` "Motion access was denied,
tilt steering is off", `mobile.tiltNone` "This device has no motion sensor, tilt steering is off", `mobile.tiltTap` "Tap
the screen to allow motion access". G: please add the other 28 languages to the locale files.

## Controls (what each context sends)

Analog values are pre-compensated for the consumer's deadzone/curve, so the game receives exactly the touch value:
`driveAxis()` inverts DriveInput's 0.12 deadzone + `|x|^1.6`; `linAxis()` inverts `InputManager.axis()`'s 0.15 deadzone.

| context (`player.mode` / `controllable.kind`) | left side | right side | small row / extra |
|---|---|---|---|
| **drive** (car, truck, bus, van, small, motorcycle, bicycle) | floating horizontal steering slider → axis 0 (curve `|x|^1.3`, travel 62 px × size ÷ sensitivity); or tilt | gas → RT (ramps in ~0.14 s), brake/reverse → LT, handbrake → A, nitro → B; gas↔brake slide without lifting | exit → Y, horn → `horn` event, lights → `KeyH`, look back → `chase.lookBack`, radio → d-pad right, camera → `KeyC`; flip → `KeyR` (only upside down & slow) |
| **boat** | steering slider → axis 0 | gas → RT, reverse → LT | exit, horn, radio, camera |
| **tank** (`kind === 'tank'`) | steering slider → axis 0 (DriveInput curve) | gas → RT, brake/reverse → LT, FIRE → `tank.fireHeld` (dimmed while `reloadLeft > 0`), sight → `KeyC` (TankCamera mode) | exit, horn, lights, radio; a drag aims (`TankCamera.look`) |
| **foot** | floating joystick → axes 0/1 (walk below 55 %, run, **sprint = push past the edge** → A held); base follows the thumb | jump/climb → X, enter / carjack → Y (only when a vehicle is within 5 m; pulsing), dive → B held (only swimming) | camera |
| **heli** | stick: up/down → collective RT/LT (spring-centred, hover assist holds), left/right → tail rotor LB/RB (digital in `readHeli`) | stick → cyclic, axes 0/1 | exit, camera, hover assist `KeyN` |
| **plane** | absolute throttle lever (servoes `throttleRate` RT/LT on `telemetry.throttle`), rudder ‹ › → LB/RB, wheel brakes → A | yoke stick → axes 0/1 (drag down = pull up) | exit, camera, assist `KeyN`, gear `KeyB`, flaps `KeyG`, smoke `KeyX` |
| **free** camera | stick → W/A/S/D (synthetic keys, FreeCamera listens to keys only) | up `KeyE`, down `KeyQ`, boost `Shift` (held), exit free cam `KeyV` | — |

Photo mode: a top button under G's ☰ (all contexts, when `game.life.photo` exists and `game.can('photo')`) sends `KeyP`. While
PhotoMode is open (`photo:enter` … `photo:exit`) the overlay is hidden and `photo.js` drives its public `yaw/pitch/dist/target`.

Camera: a drag anywhere that is not a control (right half, or the upper quarter on the left) rotates the active camera with
the same formulas as its own mouse drag; a resting finger stops auto-recentring. Menu: G's ☰ button and the radar tap
(map) are above the overlay; without G's HUD (noUI labs) K shows its own menu (START) and map (BACK) buttons.
Hidden: pause menu open, wasted, portrait, page hidden/blurred, a real keyboard key or a physical gamepad (the next touch
brings the overlay back).

## Runtime hooks into other modules (no file edits; please make them native)

- **A, `src/vehicle/Input.js`**: `DriveInput._pad()` reads `navigator.getGamepads()` directly, so the virtual pad never
  reached cars. K wraps the player's instance: `di._pad = () => orig() || game.mobile.pad.current` (physical pads still
  win). Please fall back to `game.input.virtualPad` / `game.input.gamepad` natively (e.g. `new DriveInput({ input })`).
- **F, `src/core/Renderer.js`**: no frame limiter exists (the `mobile` profile has `maxFps: 60`, but a 120 Hz phone still
  runs 120 fps). K wraps `renderer.setAnimationLoop` with an accumulator gate (`math.js frameGate`, exact 60 fps on
  60/90/120/144 Hz, 15 fps behind the rotate screen) and guards `render._cpuMs` so skipped ticks don't zero `stats().cpuMs`.
  Please add a native limiter (`profile.maxFps` / `render.maxFps`) before the CPU timing; K will then drop its wrapper.
  Also: the Renderer's `resize` listener runs synchronously on every `resize` event (all render targets reallocated);
  please coalesce it (rAF/150 ms) and prefer `visualViewport`. K adds a trailing resize only when the canvas size
  really differs from the window (iOS reports the final size ~300 ms after a rotation).
- **Integrator, Traffic/Pedestrians/Vegetation**: on phones (quality `mobile`/`low`) K sets `traffic.max`, `peds.max`
  (and their `_baseMax`, which G's settings fallback multiplies) to `quality.trafficMax` / `pedsMax` (20 / 40), and veg
  scatter radii to `baseRadius × drawDist × quality.vegRadius`, re-applied on `traffic`, `peds`, `drawDist`, `quality`
  and profile changes. Desktop presets are never touched.
- **Cameras (A, B, D)**: touch look writes `ChaseCamera._orbitYaw/_orbitPitch/_orbitIdle` (as `PlayerController` does for
  pointer-lock look) and `lookBack`, `OrbitCamera.yaw/pitch/idle`, calls `AirCamera.orbit(dx, dy)` / `.idle`, and
  `FreeCamera.yaw/pitch`. Unknown cameras get a frame of right stick (axes 2/3). A public `camera.look(dx, dy)` on each
  camera would be cleaner.
- **G**: K sets `body.is-mobile` (G's touch HUD) and `game.input.touch = true` (G's touch settings section). On a refused
  tilt permission K removes `.on` from `[data-key="tiltSteer"] .sw`. `mobile.css` re-stacks `#hud-br` (speedo / flight
  instruments right under the money, the fading area and vehicle names below them, `#area` max 400 px wide): at G's
  `top: clamp(84px, 24vh, 120px)` the speedometer overlapped the nitro button on 360–390 px tall phones.

## Requests to other workstreams

- **A**: native virtual-pad fallback in `DriveInput` (above).
- **B**: tail rotor / rudder are digital (`LB`/`RB` only); an analog yaw source (e.g. `inp.axis(2)` when a flag is set,
  or reading `pad.buttons[4/5].value`) would make the heli's left stick proportional. `Radio` tunes on d-pad left/right
  "in a vehicle", which also fires in planes where d-pad left = gear and right = flight assist (gamepad conflict; touch
  uses `KeyB`/`KeyN` and is unaffected).
- **C**: nothing required. Pause ducking (`game.paused`) and the hidden-tab suspend already cover K's pauses; iOS needs
  the existing first-gesture resume.
- **D**: emit `horn {vehicle, on}` for the keyboard/gamepad horn too (K emits it for touch); a look-back key would make the
  touch button consistent; `help.onFoot` and the enter/carjack prompts mention keys: show touch wording when
  `document.body.classList.contains('is-mobile')`.
- **F**: native frame limiter and a debounced resize (above).
- **G**: the four extra settings rows; re-sync toggle rows on the `setting` event (so K's tilt revert shows); the welcome
  help ("Esc — menu and vehicles · M — map") and other key hints should switch to touch wording under `body.is-mobile`;
  consider adopting the `#hud-br` re-stack natively and dropping K's override.
- **H (cartography)**: the overlay is hidden while the pause menu is open; if a full-screen map is ever shown outside the
  menu, call `game.mobile?.setControlsVisible(false)` while it is open.

## Testing

- Lab: `http://127.0.0.1:5320/lab-mobile.html` (dev server). The overlay is forced on, so it works with a mouse (every
  control is a pointer target). Params: `?touch=auto` real detection, `?mobile=1` phone profile + rotate screen on desktop,
  `?ui=0` no HUD/menu, `?player=basic` BasicPlayer, `?foot=1`, `?air=0`, `?veh=<id>`, `?x=&z=`, `?hour=`.
  LAB button (top centre): spawn car / moto / heli / plane / boat, on foot, free cam, flip, tilt, left-handed, size ±,
  120 fps, menu; live readout of context, pad axes/buttons, fps, cap, quality, DPR, detection reasons.
- Chrome DevTools device mode or the desktop app's browser pane at a phone size (e.g. 740×360 emulates Android touch):
  `?touch=auto` detects a phone → `mobile` preset, 60 fps cap on a 120 Hz display, rotate screen in portrait.
- Node: `node src/mobile/test.mjs`.
- Verified in the browser pane (812×375 and 740×360): every context's mapping reaches the consumers (`DriveInput.state`,
  heli/plane/boat `ctl`, PlayerController walk/sprint/jump/enter/exit, free camera keys, camera yaw/pitch, horn events),
  gas↔brake slide, two-finger handbrake + nitro, left-handed mirroring, portrait pause + menu + resume, tilt steering
  with synthetic `deviceorientation`, 60 fps cap on a 120 Hz display (`render.stats()`: refresh 120, fps 60),
  traffic 56 → 20 and peds 170 → 40 on the `mobile` preset. Overlay cost: ~0.03 ms/frame with a finger moving,
  ~0.0003 ms idle; no per-frame allocations in `poll()`; only transforms of the moving knobs are written per frame.
- Needs a real device: iOS motion permission prompt, `navigator.vibrate` feel (Android only), fullscreen +
  `screen.orientation.lock` (Android Chrome), safe-area insets with the notch, thermal behaviour at 60 fps.

## Known limits

- iPhone Safari has no element fullscreen: use "Add to Home Screen" (the rotate screen shows a tip on iOS Safari).
- `screen.orientation.lock('landscape')` works only in fullscreen on Android Chrome; elsewhere the rotate screen does it.
- iOS ignores `user-scalable=no`; pinch/double-tap zoom are blocked by `touch-action` + `gesturestart` instead.
- Tilt steering needs motion permission on iOS 13+ (asked from the settings toggle; a persisted "on" asks on the next tap).

## Mobile QA pass (touch equivalents and layout, outside src/mobile)

- G: `Hud.watchMobile` moves `#vehicle-name` / `#area` into a bottom-centre strip `#hud-bc` on touch; landscape-phone menu puts
  Back in the header row (CSS grid); tabs open at their top on touch (`Menu.setFocus({ reveal })`); vehicle-card badge and
  wardrobe chip overlaps; loading screen layout on phones, keyboard-only tips hidden on touch; welcome toast uses
  `mobile.welcomeSub`; CONTROLS shows a touch legend (`controls-data.js` `touch` rows) instead of the keyboard column.
- J: online-pill hint renders keyboard and touch wording (`mobile.tapPlayers`), CSS picks one.
- `mobile.css` restyles other modules' overlays on touch: time-trial panel (left under the radar), START + prompt (top
  centre), scoreboard (one-line rows, 44 px close, no blur), photo-mode panel (compact, scrolling, no blur).
- New strings `mobile.welcomeSub`, `mobile.tapPlayers`, `mobile.photoHint` in all 30 locales.
- Follow-up: free camera on touch (button under the photo button, `KeyV`; `game.can('freeCam')`); tablets (iPad-like or
  short screen side ≥ 600 CSS px) play in portrait (no rotate screen, no orientation lock); the time-trial START + prompt stack
  under the top-centre HUD column (mode tag, radio, online pill, job card; `MobileModule._raceLayout` sets
  `--tc-race-top` / `--tc-race-w` on #life-hud) and wait while a big banner (welcome, new area) is up.
