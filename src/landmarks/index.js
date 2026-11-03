import { Landmarks } from './Landmarks.js';
import { SITES } from './sites/index.js';
import { Roads } from '../world/Roads.js';
import { refineAirside, hiddenEdges, setStripSites } from './airside.js';

// Runways are drawn by landmarks as exact rectangles (sites/runways.js). Importing this module installs two Roads
// hooks (see airside.js): taxiways inside airports become airside, and runway edges plus stray airfield pieces
// get no ribbon / collider / lamps / junction cap; the edges stay in the graph. Must run before `new Roads`,
// which it does whenever this module is imported by bootstrap / a lab (static import).
setStripSites(SITES.filter((s) => s.strip).map((s) => [s.x, s.z]));
Roads.afterAirside = refineAirside;
Roads.skipRibbon = (e, roads) => (roads ? hiddenEdges(roads).has(e.i) : !!e.runway);

// Landmarks & airports (workstream M). One entry point:
//   createLandmarks(game) — after game.buildings, game.roads, game.terrain and the physics world exist.
// Registers itself (order 45) and exposes game.landmarks. See src/landmarks/INTEGRATION.md.
export function createLandmarks(game, opts = {}) {
  // bootstrap builds the landmarks once; a lab sets globalThis.LANDMARKS_OPTIONS (e.g. { only }) before createGame
  if (game.landmarks) return game.landmarks;
  const lm = make(game, opts, false);
  game.landmarks = lm;
  if (!game.modules?.includes(lm)) game.register(lm, opts.order ?? 45);
  return lm;
}

// Same build, sliced: the sites and finalize phases run a few at a time with a frame in between (`budget` ms of
// work per frame, one piece at least), so a loading screen keeps animating. Resolves to game.landmarks once
// everything is built and registered. The parked-model geometry follows from a worker either way.
export async function createLandmarksAsync(game, opts = {}) {
  if (game.landmarks) return game.landmarks;
  const lm = make(game, opts, true);
  const budget = opts.budget ?? 24;
  let t = performance.now();
  for (const _ of lm.steps) { // eslint-disable-line no-unused-vars
    if (performance.now() - t < budget) continue;
    await frame();
    t = performance.now();
  }
  game.landmarks = lm;
  if (!game.modules?.includes(lm)) game.register(lm, opts.order ?? 45);
  return lm;
}

function make(game, opts, defer) {
  opts = { ...(globalThis.LANDMARKS_OPTIONS || {}), ...opts };
  const only = opts.only ? new Set(opts.only) : null;
  const sites = (opts.sites || SITES).filter((s) => !only || only.has(s.id) || only.has(s.kind));
  return new Landmarks(game, { sites, log: opts.log, prewarm: opts.prewarm, defer });
}

// next frame; a timer when rAF is paused (hidden tab)
function frame() {
  return new Promise((r) => {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(r, 0); return; }
    const t = setTimeout(r, 50);
    requestAnimationFrame(() => { clearTimeout(t); r(); });
  });
}

export { SITES };
