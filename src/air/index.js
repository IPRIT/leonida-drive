// Aircraft & boats workstream (B). See src/air/INTEGRATION.md.
export { AIR_CATALOG } from './catalog.js';
export { BOAT_CATALOG } from '../boat/catalog.js';
export { Heli } from './Heli.js';
export { Plane } from './Plane.js';
export { Boat } from '../boat/Boat.js';
export { AirCamera } from './AirCamera.js';
export { findRunways, nearestRunway, runwayStart, nearestWater } from './runways.js';
export { SprayFX } from '../boat/Spray.js';
export { waterHeight } from '../boat/waves.js';

import { AIR_CATALOG } from './catalog.js';
import { BOAT_CATALOG } from '../boat/catalog.js';

/** Module for createGame({ modules: [airModule] }): registers all aircraft and boats in the vehicle catalog. */
export function airModule(game) {
  game.vehicles.addCatalog([...AIR_CATALOG, ...BOAT_CATALOG]);
  return null;
}
