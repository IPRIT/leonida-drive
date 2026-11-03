# Workstream F — weather, sky & rendering: integration

Files: `src/core/Renderer.js`, `src/core/quality.js`, `src/world/Sky.js`, `src/world/Water.js`,
`src/weather/**` (Weather, Rain, Lightning, presets, atmosphere, sky shaders, wet materials, post passes),
`lab-weather.html` + `src/weather/lab-weather.js`. `WEATHER_GLSL` in `src/core/globals.js` was extended
(names kept, see below).

## 1. Bootstrap changes (integrator)

```js
import { Weather } from '../weather/Weather.js';
import { patchWeatherMaterial } from '../weather/wetMaterial.js';

const render = new Renderer(container);          // auto-detects the device tier synchronously
game.quality = render.profile;                    // ← NEW: right away, before the world is built
...
game.sky = new Sky(scene, render.renderer, game); // 3rd arg optional (events: time:skip)
game.water = new Water(scene, game.terrain, game.sky);
... world, lamps, physics, player ...
game.weather = new Weather(game);                 // after lamps/camera exist; wires render/sky/water
game.register(game.weather, 40);
... all other modules ...
render.prewarm();                                 // ← compile every program once (no in-game hitches)

game.onSetting('quality', (v) => render.setQuality(v));   // pass 'auto' through (do not map it to 'high')
render.setQuality(game.settings.quality);                  // also fine for 'auto'
```

* `vite.config.js`: add `lab: resolve(..., 'lab-weather.html')` to `rollupOptions.input` if the lab should be built.
* Budgets for other modules: read `game.quality.{vegRadius, drawDistance, trafficMax, pedsMax, debrisMax,
  particlesMax}` (e.g. `Traffic max: game.quality.trafficMax` instead of the hard-coded 56).
* Optional: `material.envMapIntensity = 0.6` on terrain / roads / buildings (less sky glare on big surfaces;
  the sky probe is `scene.environment`, `scene.environmentIntensity = 0.75`).

## 2. Wet look, cloud shadows, SSR mask, lamp streaks (materials)

Preferred: one call per material (works with materials that already have `onBeforeCompile`):

```js
patchWeatherMaterial(terrain.material,   { porosity: '0.85', puddles: 0.6 });
patchWeatherMaterial(roads.material,     { porosity: '0.7',  puddles: 1 });
patchWeatherMaterial(buildings.material, { porosity: '0.4 * (1.0 - gGlass)', puddles: 0.8, lampStreaks: false });
// or patchWorldMaterials(game) which does exactly this
```

It adds: darker porous albedo when wet, roughness ≥ 0.6 when dry (no sun glare) → glossy film when wet,
mirror puddles with rain ring ripples (faded beyond ~40 m), moving cloud shadows on direct light, anisotropic
street-lamp streaks on wet ground at night (12 nearest lamps, uploaded by Weather), and the **SSR mirror mask in
the colour alpha** (`gl_FragColor.a = 1 - 0.5 * mirror`). If the material already got `WEATHER_GLSL` from
`src/world/weatherPatch.js`, the patch detects it (`WEATHER_GLSL_FUNCS`) and only adds lamp streaks + SSR mask.

If you keep your own `weatherPatch.js`:
* bind uniforms with `for (const k of Object.keys(WEATHER_GLSL_UNIFORMS)) sh.uniforms[k] ??= GLOBAL_UNIFORMS[k]`
  — WEATHER_GLSL now uses **`uWxTime`** (same object as `uTime`) so it never collides with a material's own `uTime`;
  with the current hard-coded list `uWxTime` stays 0 and puddle ripples freeze;
* for screen-space reflections on wet ground add after `#include <dithering_fragment>`:
  `gl_FragColor.a = 1.0 - 0.5 * weatherMirror(ww) * smoothstep(0.5, 0.9, wnW.y);` (opaque materials only).

`WEATHER_GLSL` API (names/signatures kept, math improved): `cloudCoverage(xz)`, `cloudShadow(xz)` (projected
along `uSunDir` onto the 1.6 km cloud layer, identical to the visible clouds, drifts with the integrated
`uCloudOffset`), `puddleMask(xz)`, `rainRipples(xz)`, `weatherWet(wp, ny)`, `weatherWetAlbedo`,
`weatherWetRoughness`, `weatherWetNormal`, `weatherMirror`. `weatherGlslFor(source)` omits uniforms the
shader already declares. New global uniform: `uCloudOffset` (vec2), alias `uWxTime`.

**Colour-alpha contract (SSR):** opaque materials output alpha 1 (three does this) = no reflection; the patch
writes 0.5…1 for wet ground; water writes 0. Transparent effects should keep destination alpha
(`blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor`) or use normal blending.

## 3. APIs

### `game.render` (Renderer)
`renderer`, `setScene`, `resize`, `setQuality(name | 'auto')`, `adapt(dt)`, `render()`, `grade.uniforms.{uWasted,
uFade, uNight}` (unchanged), `scale`, `autoRes`, plus:
* `profile` (= `game.quality`), `detected` ({name, gpu, score, reasons}), `prewarm()` → ms,
* `targetFps` (120 on ≥110 Hz displays, else the refresh rate; mobile ≤ 60), `refreshHz` (measured from frame deltas),
* `stats()` → `{ cpuMs, gpuMs, drawCalls, triangles, programs, fps, targetFps, refreshHz, scale, quality }`,
* `effects` + `setEffect(name, on)` (bloom, ao, ssr, godrays, flare, lens, motionBlur, grain, aa, fog) — lab toggles,
* `gpu` (GpuTimer: per-pass `results`, `frameMs`), `loopCallback` (the game loop, for tools), `attach(game)`.
Emits `quality` `{name, auto}` on an automatic downgrade.

### `game.quality` (src/core/quality.js) — one shared object, mutated in place
`name, auto, pixelRatio, apply(name, auto?, info?)`, `detect()` → auto-detected preset, `onChange(fn(profile, info))`.
`info.runtime === true` marks automatic downgrades: listeners must not change lights/shadows/defines then.
Use `game.render.setQuality(name)` from menus (it also re-prewarms); `quality.apply(name)` works too
(mobile workstream K: `game.render.setQuality('mobile')` or `game.quality.apply('mobile')`).

| field | mobile | low | medium | high | ultra |
|---|---|---|---|---|---|
| pixel ratio cap × scale / pixel budget | 1.5 × 0.6 / 1.0 MP | 1 × 0.75 / 0.9 MP | 1 / 1.7 MP | 1.5 / 3.0 MP | 2 / 5.5 MP |
| maxFps | 60 | display | display | display | display |
| shadows (0 off, 1 follow map, 2–3 CSM) | 1 | 0 | 1 | 2 | 3 |
| shadowMapSize / distance m / cascades | 1024 / 70 / 1 | – | 1024 / 110 / 1 | 2048 / 260 / 2 | 3072 / 420 / 2 |
| bloom / AO / SSR / god rays | – / – / – / – | – / – / – / – | ✓ / – / – / ✓ | ✓ / ✓ / ✓ / ✓ | ✓ / ✓ / ✓ (32 steps) / ✓ |
| lens flare / lens drops / motion blur / grain | – / ✓ / – / – | – / ✓ / – / – | ✓ / ✓ / – / – | ✓ / ✓ / ✓ / ✓ | ✓ / ✓ / ✓ / ✓ (+tiny CA) |
| AA | none | none | FXAA | FXAA | SMAA |
| reflections (sky probe size / update s) | 64 / 3 | 64 / 2.5 | 64 / 1 | 128 / 0.5 | 128 / 0.25 |
| clouds (quality 1–3) | 1 | 1 | 2 | 3 | 3 |
| rainParticles / splashes | 2000 / 120 | 2500 / 160 | 6000 / 400 | 12000 / 900 | 20000 / 1500 |
| vegRadius / drawDistance / fogScale | 0.5 / 0.55 / 1.6 | 0.6 / 0.65 / 1.35 | 0.8 / 0.8 / 1.1 | 1 / 1 / 1 | 1.3 / 1.25 / 1 |
| trafficMax / pedsMax / debrisMax / particlesMax | 20/40/30/1200 | 24/60/40/1500 | 40/110/80/4000 | 56/170/150/8000 | 72/240/250/16000 |

Detection: GPU string (WEBGL_debug_renderer_info) + a ~20 ms fragment micro-benchmark (cached per GPU in
localStorage `leonida.gpuBench2:*`), CPU cores/memory caps, touch/mobile → `mobile`, software GL → `low`.
Integrated Intel UHD → low; Iris Xe, Radeon 680M/Vega, Apple M1/M2 → medium; Apple M3/M4, M1/M2 Pro, Radeon 780M,
GTX 1070+/RTX 20xx → high; Apple M3+ Pro/Max/Ultra, RTX 30/40 x60+, RX 6800+ → ultra (name and benchmark are averaged). Runtime: dynamic resolution (0.6–1) driven by the GPU timer against `1/targetFps`
(CPU-bound frames never lower resolution), then at most two automatic one-step downgrades after 9 s at minimum
scale, 25 s cooldown, never upgrades (no thrash). Automatic downgrades change only budgets, resolution and
pre-warmed post variants — never lights, shadows or material defines.

### `game.sky` (Sky)
Kept: `time, timeScale, paused, night, sunDir, zenith, horizon, sunColor, uniforms, update(dt, focus), clock,
setTime(h, {smooth})` (smooth = 2–4 s eased fast-forward, emits `time:skip {from, to, duration}`).
New: `sync(hours, timeScale)` for the online clock (small drift corrected smoothly, > 30 min snaps), `moonDir,
moonPhase, moonIllum, day, lightDir, sunElevation, exposure, fogColor, envTexture (sky probe), sun (DirectionalLight,
medium/mobile), sunCSM (three SunLight with 2 built-in cascades, high/ultra), hemi, setQuality(profile, info)`.
Lights are created once; quality changes only toggle them from the settings menu. Night: cool moonlight key that
never drops below a readable level + blue hemisphere fill and a moonlit blue sky.

### `game.weather` (Weather)
* `set(target, opts)` — `target` = preset id `clear | partly | overcast | lightRain | heavyRain | storm | fog`
  (aliases: thunderstorm, rain, mist, …) **or numeric** `{ rain 0..1, cloud 0..1, wind 0..1, fog 0..1, storm bool }`;
  `opts` = seconds or `{ transitionS }` (0 = instant). Clouds lead when it gets wetter, rain stops first when it clears.
* `setAuto(bool)` — local random scheduler (Florida-like Markov chain: afternoon storms, morning fog; holds
  1–6 min, 30–90 s transitions). In online mode (`!game.can('weather')`) the scheduler and the `weather`
  setting handler are off: the server is the only source (call `set()`).
* `state` → blended snapshot `{ name, rain, cloud, fog, mist, wind (0..1), windMs, storm, dark, wetness, transition }`;
  `name` = preset id (closest preset for numeric targets); fields `rain, wetness, cloud, fog, wind {x, z, strength}, auto`.
* Wetness is local physics: soaks while raining (~40 s heavy rain), dries faster in sun, puddles appear > 0.3.
* `strike(position?, bolt?)` forces lightning. `label(name)` → `game.i18n.t('weather.<id>')` or English.
* Effects owned by Weather: GPU rain streaks + ground splashes (lit by sky, sun, nearby lamps, lightning),
  lightning bolts + sky/cloud flash, lens raindrops (off under roofs/bridges via a Rapier ray up, off underwater),
  `enabled = { rain, splashes, lightning, lens }`.
* Writes `GLOBAL_UNIFORMS`: `uWetness, uRain, uCloudCover, uWind, uLightning, uCloudOffset`.

Events emitted: `weather {state, name, seconds, label}`, `lightning {position, distance, cloud}` (audio: delay
thunder by `distance / 343` s; `cloud: true` = in-cloud flash, no bolt), `time:skip`, `quality`.
Read: `game.can('weather' | 'time')` — the lab disables its weather/time controls when not allowed.

i18n keys: `weather.auto, weather.clear, weather.partly, weather.overcast, weather.lightRain, weather.heavyRain,
weather.storm, weather.fog` (same ids as the UI tiles).

## 4. Rendering pipeline

scene (HDR half-float + float reversed depth texture) → [AO ½ res, depth-only SAO + bilateral 4×4] [SSR ½ res,
mask from alpha, 20/32 steps + 4 refine] [god rays ¼ res, 36 radial samples from the sun, sky-masked]
[sun visibility 1×1] → **composite** (AO, SSR with Fresnel, rays, direction-aware fog recolouring from the
atmosphere LUT, ground mist, underwater) → bloom (½…1/32 dual filter, threshold 2.6 day / 1.15 night) →
**final** (lens drops, flare ghosts, motion blur (translation-only), bloom add, ACES, time/weather grade,
vignette, grain, wasted/fade) → SMAA/FXAA. Low/mobile skip the composite (fog moves into the final pass).
All variants share uniforms and are compiled by `prewarm()`; switching never recompiles.

Sky: single-scattering Rayleigh/Mie/ozone sky-view LUT (192×108, re-rendered only when the sun/haze changes),
sun disc + limb darkening, moon with phase (8-day cycle), stars + milky way (rotating), 8 km cirrus, 1.6 km
2.5D lit cumulus (silver lining, multiple-scattering octave), city light pollution. The dome is drawn last at
the far plane (only uncovered pixels shade it). Sky reflection probe: own 64/128 px prefiltered cube
(`isPMREMTexture`, 6 fixed mips → `ENVMAP_MAX_LOD` never changes), updated in three amortized slices.

## 5. Known limits
* No hardware ray tracing in WebGL: reflections are SSR (on-screen only, fade at edges) + sky probe; AO is
  screen-space; god rays are screen-space (sun must be near the screen).
* Rain is not occluded by geometry overhead except near the camera when a roof/bridge is detected above it.
* Lamp streaks use the 12 nearest lamps (`game.lamps.scatter`), car headlights are real lights only.
* Cloud shadows/wet look apply only to patched materials (vehicles: A can call `patchWeatherMaterial(mat,
  { puddles: 0, porosity: '0.0', dryRoughness: 0, lampStreaks: false })` for cloud shadows + a wet sheen).
* GPU timings in the shared preview pane are noisy (other tabs use the same GPU); see the lab for live numbers.
