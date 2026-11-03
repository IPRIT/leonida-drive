// Adapter from the game world to the DOM-free physics env interface (one per game).
import { waterHeight, calmFromDepth, seaState } from '../boat/waves.js';

const _envs = new WeakMap();

export function makeEnv(game) {
  let env = _envs.get(game);
  if (env) return env;
  const t = game.terrain;
  const G = t.G;
  const vm = game.vehicles?.env;
  const LAND = {
    // [hull friction, linear land drag (N per m/s)] for skimming hulls (airboat)
    [G.wetland]: [0.05, 90], [G.water]: [0.05, 120], [G.grass]: [0.1, 300], [G.park]: [0.1, 300], [G.farm]: [0.12, 340],
    [G.sand]: [0.18, 450], [G.dirt]: [0.22, 420], [G.sport]: [0.12, 320],
  };
  env = {
    heightAt: (x, z) => t.heightAt(x, z),
    waterHeight: (x, z, time, th) => waterHeight(x, z, time, calmFromDepth(th ?? t.heightAt(x, z)) * seaState(game)),
    time: () => game.time,
    groundAt: (x, z) => t.groundAt(x, z),
    surface(x, z) {
      const s = vm?.getSurface?.(x, z);
      return s ? { grip: s.grip, rolling: s.rolling } : null;
    },
    landFriction(x, z, skims) {
      if (!skims) return 0.6;
      return (LAND[t.groundAt(x, z)] || [0.45, 1100])[0];
    },
    landDrag(x, z, skims) {
      if (!skims) return 1500;
      return (LAND[t.groundAt(x, z)] || [0.45, 1100])[1];
    },
  };
  _envs.set(game, env);
  return env;
}
