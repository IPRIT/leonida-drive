// Economy workstream (L) entry points. See src/economy/INTEGRATION.md and docs/ECONOMY.md.
//
//   bootstrap (preferred): createEconomy(game) before the player exists → { plan } with the start slot and vehicle;
//                          then economyModule(game) (or game.register(new Jobs(game))) after the world is ready.
//   main.js only:          createGame(…, { modules: [economyModule] }) also works: the player is moved to a start slot
//                          (or the saved position) and into the starter / last vehicle right after boot.
import { Economy } from './Economy.js';
import { Jobs } from './Jobs.js';
import { VehicleServices } from './Services.js';
import { Spawns } from '../world/Spawns.js';
import { registerStrings } from './i18n.js';

export { Economy, damageOf, tr, fmt } from './Economy.js';
export { Jobs } from './Jobs.js';
export { VehicleServices } from './Services.js';
export { PRICES, STARTERS, STARTER_CAR, STARTER_BIKE, EXPORT_POOL, priceOf } from './prices.js';
export * as rules from './rules.js';

const ECONOMY_ORDER = 58; // before Score (60): it consumes Score's combo hold of the previous frame
const JOBS_ORDER = 62;
const SERVICES_ORDER = 63;

/** Create game.spawns and game.economy (idempotent). Call before the player is created. → { economy, spawns, plan } */
export function createEconomy(game, opts = {}) {
  game.spawns ||= new Spawns(game);
  if (!game.economy) {
    game.economy = new Economy(game, opts);
    game.register?.(game.economy, ECONOMY_ORDER);
  }
  if (game.i18n) registerStrings(game.i18n);
  return { economy: game.economy, spawns: game.spawns, plan: game.economy.startPlan() };
}

/**
 * Module factory for createGame({ modules: [economyModule] }): creates whatever is missing (spawns, economy, jobs,
 * vehicle services — call it after game.damage exists).
 * If the economy did not exist yet, the player was placed by the old bootstrap → move them to the start plan.
 */
export function economyModule(game) {
  const late = !game.economy;
  const { plan } = createEconomy(game);
  if (late && !game.options?.spawn) relocate(game, plan);
  if (!game.jobs) game.jobs = game.register(new Jobs(game), JOBS_ORDER);
  if (!game.services) game.services = game.register(new VehicleServices(game), SERVICES_ORDER);
  return null;
}

// move the (already spawned) player into the planned vehicle at the planned slot
function relocate(game, plan) {
  const p = game.player, pos = plan?.pos;
  if (!p || !pos) return;
  let v = p.controllable;
  if (plan.vehicle && (!v || v.catalogId !== plan.vehicle) && game.spawnForPlayer) v = game.spawnForPlayer(plan.vehicle) || v;
  if (!v) return;
  const V = game.THREE?.Vector3;
  v.reset?.(V ? new V(pos.x, pos.y, pos.z) : { x: pos.x, y: pos.y, z: pos.z }, pos.yaw);
  p.focus?.set?.(pos.x, pos.y, pos.z);
  game.streaming?.run?.(true);
  (v.camera || p.chase)?.snap?.(v);
}
