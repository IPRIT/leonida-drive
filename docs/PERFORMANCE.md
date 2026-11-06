# Performance and repeat-launch evidence

Measurements on 2026-11-06, Chromium with SwiftShader in the Linux sandbox. These are not measurements on a physical low-end phone and must not be presented as such. GPU time and FPS are separate from the CPU update benchmark.

## Main-thread CPU update

`tools/local/cpu-clean.mjs`, ultra settings, 1,200 manually stepped frames after 120 warm-up frames, rendering stopped:

| Metric | Earlier clean run | Current run |
| --- | ---: | ---: |
| Total elapsed | 5,342 ms | 3,337.7 ms |
| p50 | 3.1 ms | **1.4 ms** |
| p95 | 12.5 ms | **8.3 ms** |
| p99 | 20.1 ms | **19.8 ms** |
| Max | 32.4 ms | **51.4 ms** |

Current totals over the measured 1,200 frames: pedestrians 537.0 ms, physics `world.step` 486.8 ms, traffic update 371.7 ms, traffic visual 228.9 ms, terrain 23.6 ms. The benchmark includes input, fixed/update/late update, physics, world systems, traffic, pedestrians and the lab UI. It excludes GPU submission/render time.

The 1–2 ms target is met at p50 in this environment, **not at p95/p99 and not yet on a physical weak device**. Different sandbox runs are noisy; this table is not a controlled proof of a universal speedup.

Implemented hot-path changes include pooled traffic lane records and visual scratch objects, removal of per-frame `subarray()` allocations in scatter updates, terrain camera-signature early-out, pedestrian path-point reuse, and 30 Hz staggering of secondary audio updates. A mover spatial grid and a structured-clone IndexedDB prepared-world cache were measured as regressions and removed.

## Production repeat navigation

The production service worker is installed only after the game becomes playable. Registration waits for `navigator.serviceWorker.ready` before sending the warm resource list; otherwise the first warm-list message can be lost while the worker is still installing. `requestIdleCallback` is not required for registration because a continuously GPU-bound game may never become idle.

`tools/local/sw-test.mjs` after the fix:

- cold launch reached the game;
- 3 same-origin navigation requests were cached;
- repeat launch: **47/47 same-origin responses came from the service worker, 0 network responses**;
- no uncaught page errors.

A separate cold/warm production probe measured menu readiness at 44.2 s cold and 48.5 s warm, with post-menu game start at 0.77 s and 0.66 s respectively. Thus network repeat loading is cached, but **near-instant world reconstruction is not achieved** in SwiftShader. Startup CPU profiling attributes a large share to blocking WebGL/prewarm work, not network traffic. The earlier full-object IndexedDB experiment made a warm launch slower (about 40.8 s versus 21.5 s cold in that probe) and is intentionally absent.

## Not yet established

- multi-hour heap stability under gameplay and streaming;
- physical low-end device CPU/GPU/FPS results;
- visual/physics equivalence on a broad gameplay scenario matrix;
- external YANIS road-network parity (internal map/graph parity is not external evidence).
