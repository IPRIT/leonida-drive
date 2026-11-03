# World data pipeline

The client runs from the committed `public/data` files. Regeneration additionally requires the original source mosaic in `raw/` and the existing landmark / OSM source caches in `tools/cache/`. These inputs are excluded from the repository. The pipeline does not silently download them.

```bash
python3 -m venv .venv
.venv/bin/pip install pillow numpy scipy opencv-python-headless scikit-image
```

From the repository root, run in order:

```bash
.venv/bin/python tools/classify.py
.venv/bin/python tools/roads.py
.venv/bin/python tools/buildings.py
.venv/bin/python tools/export.py
.venv/bin/python tools/irl_build.py
.venv/bin/python tools/parks.py
.venv/bin/python tools/junction_shapes.py
node tools/landmark_geom.mjs
.venv/bin/python tools/irl_build.py
.venv/bin/python tools/map_build.py
```

The second IRL pass applies the freshly generated landmark ownership list. `landmark_geom.mjs` writes `landmark_geom.json`, `landmark_takes.json` and parked-vehicle dimensions. The vector map draws the actual runway / aircraft outlines and paths from `parks.json`.

Coordinates are world metres: **x = longitude-like map axis, z = minus latitude-like map axis**. The source mosaic is sampled at 2 m per pixel; this reconstruction is not survey data.

Changes to classification, roads or heights must be followed by the dependent stages. Thin highway medians survive morphology; park footpaths are distinct from traffic roads. Small coastal ponds remain water. Elevated inland basins are treated separately by the terrain generator.

`interchanges.py` splits opposed highway crossings into separate graph nodes before the height fit. It verifies clearance across overlapping carriageways against the complete ramp network; geometrically impossible candidates are recorded under `roads.json.profileFit.review`. `road_profiles.py` fits terrain targets subject to grade bounds (6% highway mainline, 7.5% ramps) and 7.4 m between crossing surfaces. Runtime geometry still needs the physical checks below: profile bounds alone do not certify seams, bends or lane coverage.

`road_structures.py` raises the Watson Island bay bridge from a location-specific visual reference. The 13.6 m deck target is a reconstruction choice, not a measured elevation from GTA VI. The beach, arena shell and waterfront tower silhouettes use original procedural models. The source does not supply survey elevations or complete building dimensions.

```bash
.venv/bin/python tools/parity.py --data public/data --out /tmp/leonida-parity
node tools/tests/roads.test.mjs
node tools/tests/roadsteps.test.mjs --refine --json /tmp/leonida-roadsteps.json
node tools/tests/roadprobe.test.mjs
.venv/bin/python -m unittest discover -s tools/tests -p 'test_*.py'
```

Compare the same source crops before and after a change (`parity.py --spots previous/report.json`). Keep map coverage, building footprint IoU, physical discontinuities and frame times separate. A higher map overlap score does not prove that a road is safe to drive.

`npm run check:roads` checks highway seams at 1 cm refinement, collision clearance under every planned overpass, highway lane gaps and water crossings. A single missed ray on an exact triangle boundary is checked on opposite sides of a 4 mm span and reported separately as `narrowSeamSamples`. The broader probe also reports approximate turning paths and kerbs; those diagnostics are retained, not treated as proof that every possible turn has been driven.
