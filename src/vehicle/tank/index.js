// Tank: catalog entry factory + public API (see src/vehicle/INTEGRATION.md → Tank).
export { Tank, TANK_WEAPON, TANK_ARMOR } from './Tank.js';
export { TankPhysics, TANK_SPEC } from './TankPhysics.js';
export { TankCamera } from './TankCamera.js';
export { TankHud } from './TankHud.js';
export { Shells, SHELL_BLAST, SHELL_POWER, destroyVehicle, destroyAgent, findVehicle } from './Shells.js';
export { buildTankModel, buildTankPreview, bakeTank, TANK } from './TankModel.js';
export { WreckFx, playTankWreck, seededRandom, wreckPlan } from './Wreck.js';
