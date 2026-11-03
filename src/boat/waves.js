// Sea surface model shared by boats and seaplanes. The rendered water (src/world/Water.js) is a flat plane with
// procedural normals; we use the same swell directions/frequencies with a much smaller amplitude so hulls bob in
// sync with the visible pattern without visibly floating above or sinking into the flat mesh.
const W = [
  // dirX, dirZ, k (rad/m), omega (rad/s), amplitude (m)
  [0.8, 0.6, 0.21, 1.3, 0.11],
  [-0.287, 0.958, 0.37, 1.7, 0.06],
  [0.928, -0.371, 0.83, 2.6, 0.022],
  [-0.976, -0.217, 1.71, 3.4, 0.009],
];

/**
 * Water surface height at (x, z) and time t. `calm` 0..1 scales the swell (1 = open sea).
 * Base sea level is 0 (game convention).
 */
export function waterHeight(x, z, t, calm = 1) {
  let h = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    h += Math.sin((x * w[0] + z * w[1]) * w[2] + t * w[3]) * w[4];
  }
  return h * calm;
}

/** Depth-based calmness (shallow lagoons are calmer), from terrain height under the point. */
export function calmFromDepth(terrainH) {
  const d = -terrainH;
  if (d <= 0) return 0;
  return d > 3 ? 1 : d / 3;
}

/** Wind/weather multiplier hook: rougher seas in storms (weather workstream may set game.weather.wind). */
export function seaState(game) {
  const w = game?.weather;
  if (!w) return 1;
  const wind = typeof w.wind === 'number' ? w.wind : 0;
  return 1 + Math.min(2.5, wind / 8);
}
