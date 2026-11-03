# Audio (workstream C) — integration

Everything is synthesised procedurally with the Web Audio API: no audio files, no new dependencies.

## Register

```js
// src/main.js
import { createGame } from './core/bootstrap.js';
import { AudioSystem } from './audio/AudioSystem.js';

createGame(document.getElementById('app'), {
  modules: [(game) => (game.audio = new AudioSystem(game))],
});
```

- `AudioSystem` sets `order = 90`, so its `lateUpdate` runs after the camera has moved.
- `bootstrap.js` already calls `game.audio.start()` from the Play click. With `autostart` and no user
  gesture, the context resumes on the first pointer or key event.
- The tab-hidden state suspends the context; `game.paused` mutes the world and the radio but keeps UI
  sounds. Pause is polled every 100 ms, so it also works while the game loop is frozen.
- `BasicPlayer.enter()` and D's `PlayerController` already call `attachVehicle(v)` and
  `detachVehicle(v)`. The system also follows `game.player.controllable` and `player.mode` itself.
- When a vehicle already owns an engine voice (`v.engine` from `createEngine`, as B's aircraft and
  boats do), `attachVehicle` reuses it instead of creating a second one. Only the cabin mix and foley
  are added.

## Lab

- `http://127.0.0.1:5317/lab-audio.html` is the soundboard. It has engine sliders, gear shifts,
  limiter, lift-off pops, fly-by, every one-shot and loop, every game event, an ambience override,
  radio, mixer, a scope, and offline render tests.
- `lab-audio.html?world` boots the real game with the audio module and shows an audio stats overlay.
- `?bgloop` is a test hook that keeps frames running in a hidden tab and ignores visibility.
- World mode also loads B's `airModule`, so the helicopters, planes and boats can be spawned with
  `game.spawnForPlayer('heli_news')`.
- To build the lab, add `audio: resolve(import.meta.dirname, 'lab-audio.html')` to
  `vite.config.js` `rollupOptions.input`. This is the integrator's file. Dev mode works without it.

## API (`game.audio`)

| call | notes |
|---|---|
| `start()` | Creates and resumes the `AudioContext`. Call it from a gesture; it is idempotent. |
| `setVolume(bus, v)` | Buses: `master`, `sfx`, `engine`, `ambient`, `music`, `ui`. The value is 0..1 with a linear taper. The internal `boom` bus follows `sfx`. |
| `play(name, {position?, object3d?, volume?, pitch?, bus?, delay?, ref?, rolloff?, reverb?, variant?, pan?, delayByDistance?, priority?})` | One-shot. Returns `{stop(fade)}` or `null` when not ready or culled as inaudible. |
| `loop(name, {position?\|object3d?, volume?, pitch?, bus?, ref?})` | Returns `{set({volume, pitch, position, object3d, mode}), stop(fadeSec)}`. Names: any bank loop (below), or the live synths `siren[:wail\|yelp\|hilo\|phaser]` and `horn[:car\|sport\|luxury\|truck\|bus\|moped\|motorcycle\|boat\|police]`. |
| `createEngine(profile, {object3d\|position, overrides?, volume?, running?, kind?})` | Returns `{update(telemetry, dt), setOccupied(b), start(), stop(), setInterior(x), dispose(fade)}`. The engine is **off** until `setOccupied(true)` (or `{running: true}` for AI-driven craft); after `setOccupied(false)` it idles for 7 s (cars) or 4 s (turbines/rotors), then shuts down. Call `update` every frame. |
| `attachVehicle(v)` / `detachVehicle(v)` | Player vehicle: engine (from `v.engineSound`, the catalog `engineSound`, `v.spec.audio` or `v.kind`) plus foley. Cars get a starter crank unless they were already running. |
| `setRadioStation(i)` / `radioStation` | `-1` is off, `0..2` are the stations. Keys `Comma`/`Period` and gamepad D-pad left/right also tune while in a vehicle. |
| `stats` | `{cpuMs, voices, shots, env, state, bank}`. |

### Engine profiles

`i4, v6, v8, v12, diesel, bus, moped, motorcycle, vtwin, prop, boat, electric, jet, heli, bicycle`.

Car presets map automatically through `spec.audio.cylinders`: 6 → v6, 8 → v8 (lope), and 10 is
handled as a V10 override. Catalog entries can set `engineSound: 'heli'` (or any profile or kind
alias) and optionally `engineAudio: {…overrides}`.

How a car engine is built (so it reads as a car, not a scooter):

- **Low body:** a phase-locked sine at the firing frequency (rpm/60 × cylinders/2), plus a half-order
  sub-harmonic for V8/diesel burble.
- **Mid growl:** the per-cylinder exhaust pulse train, with firing order and lope, through low exhaust
  formants (about 70–550 Hz) and gentle grit. Grit is applied *before* a 4th-order muffler whose cutoff
  follows load: about 250–550 Hz at idle, 0.9–1.8 kHz at full load.
- **Faint exhaust and intake noise:** band-limited by that same muffler.
- **Pitch cap:** the top firing frequency is soft-capped per class (I4 300, V6 330, V8 360,
  V10/V12 520–560 Hz).
- **Two-wheelers:** only the moped and motorcycle profiles keep a bright, buzzy top end.
- **AI traffic engines:** "lite" variants with even less noise, cruising at 1.8–3k rpm.

Telemetry read by the engines (all fields optional, missing ones are simulated):

- `rpm`, `maxRpm`, `throttle`, `engineLoad`, `gear`, `shiftId`, `shifting`, `limiter`, `speedKmh`, `brake`
- `airborne`, `inWater`, `submerged`, `boosting`
- helicopters: `rotor` (0..1) or `rpm`/`maxRpm`, `collective`, `verticalSpeed`, `yawRate`
- jets: `afterburner`, or N1 through `rpm`/`maxRpm`
- EVs: `motorRpm`

Without `rpm`, ICE profiles simulate it from throttle. Turbines and rotors spool up and down by
themselves when `setOccupied` changes.

Foley uses `wheels[].{contact, skid, slipRatio, surface, compression}`, `impactId`/`impactStrength`,
`braking`, `reversing`, and `vehicle.siren`.

**B (aircraft and boats):** verified with the real crafts. `CraftVehicle` creates its engine through
`createEngine(engineSound)`.

- Helicopters: `rpm`/`maxRpm` set the rotor fraction, and the blade-pass rate adopts the craft's own
  `maxRpm` (400 or 230 rpm). `collective` sets blade loading; `verticalSpeed` drives blade-vortex slap.
- Jets: N1 comes from `rpm`/`maxRpm` (22..100).
- Props and boats: real `rpm`, plus `inWater` and `airborne`.

No further changes are needed. Optional: `afterburner` (0..1) on jets.

## Events consumed

| event | sound |
|---|---|
| `impact` | By `material`, falling back to `kind`: metal (light or heavy crunch), heavy vehicle crash with glass, glass shatter, wood, concrete, plastic, body. Gain and pitch follow strength. Distance-delayed. Deduped against `lamp:broken`/`tree:broken` and physics impacts. |
| `explosion` | 7.5 s layered boom, delayed by distance/343: N-wave crack, 110→60 Hz chest punch, 75→24 Hz sub drop, low-swept boom with a 2.2 s tail, rolling rumble, fireball roar, fuel-tank whoomp, 5 s debris rain. A centred LFE layer (`explosion_sub`) is scaled by distance. Both play on the `boom` bus, which bypasses the world duck, while everything else (engines, traffic, ambience, music) is side-chain ducked by up to −10 dB and recovers over about 1.8 s. Far explosions use a rolling-echo variant. Very close blasts add ear-ringing and a hearing-loss low-pass. |
| `fire:start` / `fire:stop` | Ignition whoosh plus a positional crackle loop. At most 4 fires play; the farthest is dropped. |
| `money:pickup` | Cash register "ka-ching" with coins. Amounts of 500 or more get a second ching. |
| `ped:knocked` | Body thud. |
| `building:destroyed` / `building:damaged` | Collapse rumble with debris, glass and rebar groan / concrete hit. |
| `tree:broken` / `lamp:broken` | Splintering crack, leaves and fall thump / pole clang, bulb pop, electric zap and fall. |
| `splash` | Three sizes, with bubbles. |
| `footstep` | `surface` is one of asphalt, road, concrete, grass, park, sand, dirt, gravel, wood, metal, water, mud or wetland. `run` makes it louder; `land` plays a landing thud. |
| `ped:carjacked` | Door yank and scuffle. The car keeps its engine running, with no starter. |
| `vehicle:enter` / `vehicle:exit` | Door open and close plus seatbelt. Bikes and boats have no doors. The radio fades in after entering. |
| `horn` `{vehicle, on}` | Horn by vehicle class: car, sport, luxury, truck air horn, bus, moped, motorcycle, boat, police, or a bicycle bell. With the siren on, the horn switches it to yelp (GTA style). |
| `ui:hover/click/open/close/notify` | UI blips. `ui:open` also muffles the world until `ui:close`. |
| `wasted` / `respawn` | Cinematic hit, drone and heartbeat. The world is low-passed and ducked and the radio muted; `respawn` plays a riser and restores the world. `game.timeScale` slows engine and SFX pitch. |
| `lightning` `{position?, distance?}` | Thunder delayed by distance/343, near crack or far rumble, panned. |
| `weather` `{state}` | Wind gust swell for storm, rain or wind states. |
| `time:skip` | Transition whoosh; the ambience snaps to new targets. |
| `vehicle:despawn` / `vehicle:destroyed` | Frees voices / engine dies. |

The system emits `radio:station` `{index, name, genre}` and calls `game.ui.showRadio(name, genre)`
if it exists, falling back to `game.ui.toast(name, genre, 2)`.

**Please (G):**

- Implement `ui.showRadio(name, genre)`.
- Add the i18n keys `radio.off`, `radio.genre.synthwave`, `radio.genre.lofi` and `radio.genre.latin`.
- Add sliders for `volMusic`, `volSfx`, `volAmbient`, `volEngine` and `volUi`, plus an
  `audioHrtf` toggle.

**Please (E):** emit `impact` with `material`, plus `explosion` and `fire:start`/`fire:stop` with
`target` when a fire is attached to an object.

**Please (D):** emit `horn` `{vehicle, on}`. `footstep`, `ped:carjacked` and
`attachVehicle`/`detachVehicle` are already in place. Taking over a traffic car is detected
automatically: a car spawned where a nearby traffic agent just vanished keeps running.
`vehicle.fromTraffic = true` also works.

**Please (F):** emit `lightning` with `distance`. `weather.rain` (0..1) and `weather.wind` (m/s) are
read if present; otherwise `uRain`/`uWind`.

## Settings (defaults)

`volume 0.8` (master), `volMusic 0.1`, `volSfx 1`, `volAmbient 0.8`, `volEngine 0.9`, `volUi 0.8`,
`audioHrtf true`, `radioStation 0`. Missing keys are filled into `game.settings`. Changes go through
`game.applySetting(key, v)`. HRTF is forced off on the `low` quality profile.

- Volumes use a linear taper: a slider at 10 % is −20 dB.
- Music defaults to 10 %, which is barely audible under the engine; the player turns it up.
- The master fades in over about 1 s when the context starts.
- The radio output and every newly tuned station fade in from silence over about 2 s, so there is
  never a loud burst.
- Music ducks under the engine (up to −4.4 dB at full throttle and high rpm) and briefly under UI
  clicks, notifications and money pickups.

## Traffic

The 3–6 nearest moving AI cars (by quality: low 3, medium 4, high 5, ultra 6) get pooled engine
voices. Each voice has a gearbox simulated from `agent.v` and tyre roll. Voices are reassigned with
fades and Doppler comes from a propagation delay line.

- **Distance model:** inverse, ref 5 m, rolloff 1.8. That is about −16 dB at 20 m and −23 dB at 40 m.
- **Hard cull:** cars fade out between 64 and 80 m; trucks and buses at 150 m. Beyond that they belong
  to the city bed.
- **Distance low-pass:** about 12 kHz at 5 m, 1.9 kHz at 60 m and 1 kHz at 150 m, so far cars rumble
  rather than whine.
- **Tyre roll:** brown noise band-limited to about 180–800 Hz, silent below 15 km/h, roughly 15 dB below
  the old level.

AI cars honk when the player blocks them for more than about 2.5 s, and sometimes on near misses. The
whole street honks at most once every 4–6 s.
A crash sound plays when an agent becomes `crashed`. If gameplay sets `agent.siren = true`, that
car gets a siren; at most 2 play at once. Far traffic is represented by the city hum bed.

## Listener and free camera

Everything is heard from `game.camera`: the Web Audio listener, Doppler, traffic culling, ambience
analysis, the reverb environment and occlusion rays. The character's position is only used for
gameplay reactions (AI cars honking at a blocking player, carjack bookkeeping).

"Own vehicle" effects follow the camera, not the character. The camera counts as riding the vehicle
in the chase, bonnet and cabin cameras. A free camera (`V`) never rides it, even while the character
sits inside.

- **Engine:** the cabin filter applies only when the camera is really in the cabin (under 2.3 m), or
  in the bonnet camera. The unpanned "width" share fades out between 8 and 20 m from the listener.
  With a free camera the car is a plain point source (inverse, ref 5 m) that fades out at 210–260 m
  and is occluded by buildings.
- **Radio:** stays tuned while the character sits in the car. With a free camera it fades as the
  camera moves away: about −2 dB at 10 m, −11 dB at 25 m, silent from 40 m. It gets duller with
  distance and is panned toward the car. After about 1 s of silence the station stops scheduling.
- **Speed wind and roof rain** come from `VehicleFoley` only while the camera rides the vehicle.
  Otherwise ambience wind follows the camera's own speed.

**Please (D):** keep `player.mode === 'free'` for the free camera and keep `controllable.occupied`
true while the character sits in the car. Audio uses these to keep the parked car's engine and radio
running.

## Notes / limits

- The engine synth is an `AudioWorklet` loaded from a Blob URL. In non-secure contexts (plain HTTP
  on a LAN IP) it falls back to a simple oscillator engine.
- Sound-bank one-shots and loops render in 1–3 Web Workers at start (about 1.5 s,
  `navigator.hardwareConcurrency` permitting). Sounds requested before then are skipped.
- Occlusion casts one or two `world.castRay` calls per frame against STATIC colliders for voices
  within 160 m. The reverb environment uses one upward ray (bridge or tunnel), terrain height and
  ground classes, and is one of open, urban, tunnel, valley or cabin.
- The radio is original generative music: three stations with their own broadcast clocks, motif-based
  melodies, station IDs between songs, tuning static, and a car-speaker EQ. It plays only in
  vehicles other than bicycles, and a free camera hears it only near the car.
