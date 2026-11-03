// Pooled headlight SpotLights: a fixed pair per scene, created once and always visible. Switching headlights or
// vehicles only moves them and changes their intensity, so the light count never changes (no shader recompiles).
// Every controllable with a beam uses this pool (cars, bikes, the tank, aircraft and boats): adding a light to the
// scene at runtime changes numSpotLights and recompiles EVERY lit material in the world (seconds on ANGLE/Metal).
import * as THREE from 'three';

const POOLS = new WeakMap();
const BASE = { color: 0xfff1d6, distance: 70, angle: 0.48, penumbra: 0.55, decay: 1.4 };

/** Create (once) and return the headlight pool of a scene: { owner, lights: SpotLight[2] }. Safe to call early. */
export function initHeadlightPool(scene) {
  let pool = POOLS.get(scene);
  if (pool) return pool;
  pool = { owner: null, lights: [] };
  for (let i = 0; i < 2; i++) {
    const s = new THREE.SpotLight(BASE.color, 0, BASE.distance, BASE.angle, BASE.penumbra, BASE.decay);
    s.castShadow = false;
    s.name = `headlightPool${i}`;
    scene.add(s, s.target);
    pool.lights.push(s);
  }
  POOLS.set(scene, pool);
  return pool;
}

/** The pool of a scene, or undefined before initHeadlightPool. */
export function headlightPool(scene) {
  return POOLS.get(scene);
}

/**
 * Make `owner` the pool's owner (beam shape `cfg` = { color, distance, angle, penumbra, decay }, defaults: car
 * headlights). Only uniforms change: no shader program is affected. Returns the pool.
 */
export function claimHeadlights(pool, owner, cfg = null) {
  if (!pool) return pool;
  const changed = pool.owner !== owner;
  pool.owner = owner;
  if (changed || cfg) {
    const c = cfg ? { ...BASE, ...cfg } : BASE;
    for (const s of pool.lights) {
      s.color.setHex(c.color);
      s.distance = c.distance;
      s.angle = c.angle;
      s.penumbra = c.penumbra;
      s.decay = c.decay;
      s.intensity = 0;
    }
  }
  return pool;
}

/** Give the pool back (beams off, car-headlight shape) if `owner` holds it. */
export function releaseHeadlights(pool, owner) {
  if (!pool || pool.owner !== owner) return;
  claimHeadlights(pool, null);
}
