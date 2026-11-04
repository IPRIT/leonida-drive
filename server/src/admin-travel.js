import { SLOT_BITS, SLOT_MASK, VCLASS, WORLD } from '../../src/net/shared/constants.js';

export function playerPose(v, id) {
  const slot = id & SLOT_MASK;
  if (!Number.isInteger(id) || id < 1 || id > 0xffffff || slot >= v.N) return null;
  for (let i = 0; i < 3; i++) {
    if (v.alive[slot] !== 1 || v.gen[slot] !== id >>> SLOT_BITS) return null;
    const seq = Atomics.load(v.seq, slot);
    if (seq & 1) continue;
    const p = slot * 3;
    const pose = { id, x: v.pos[p], y: v.pos[p + 1], z: v.pos[p + 2], yaw: v.rot[slot * 5], vclass: v.vclass[slot] };
    if (seq === Atomics.load(v.seq, slot) && v.alive[slot] === 1 && v.gen[slot] === id >>> SLOT_BITS) return pose;
  }
  return null;
}

export function travelDestination(world, vclass, anchor) {
  const air = vclass === VCLASS.PLANE || vclass === VCLASS.HELI;
  const water = vclass === VCLASS.BOAT;
  const anchorAir = anchor.vclass === VCLASS.PLANE || anchor.vclass === VCLASS.HELI;
  const distance = air || anchorAir ? 70 : water || anchor.vclass === VCLASS.BOAT ? 20 : 8;
  const cx = anchor.x + Math.sin(anchor.yaw) * distance, cz = anchor.z + Math.cos(anchor.yaw) * distance;
  for (const r of [0, 12, 24, 48, 96, 192, 320]) {
    for (let i = 0; i < (r ? 16 : 1); i++) {
      const a = i * Math.PI / 8, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!(x > WORLD.x0 + 10 && x < WORLD.x1 - 10 && z > WORLD.z0 + 10 && z < WORLD.z1 - 10)) continue;
      const ground = world.heightAt(x, z);
      const bridgeAnchor = !anchorAir && anchor.vclass !== VCLASS.BOAT && anchor.y > .8 && r <= 24;
      if (!air && (water ? ground > -.5 : ground < .2 && !bridgeAnchor)) continue;
      const y = air ? Math.max(ground + (vclass === VCLASS.PLANE ? 350 : 220), anchorAir ? anchor.y : 0)
        : water ? .05 : Math.max(ground + (vclass === VCLASS.FOOT ? .1 : 1.3),
          !anchorAir && anchor.vclass !== VCLASS.BOAT && r <= 24 ? anchor.y + .2 : 0);
      return { x, y: Math.min(WORLD.yMax - 20, y), z, yaw: anchor.yaw };
    }
  }
  return null;
}

export function validTravelGrant(g, now) {
  return g && Number.isFinite(g.until) && now < g.until &&
    ['x', 'y', 'z', 'yaw'].every(k => Number.isFinite(g[k])) &&
    g.x > WORLD.x0 && g.x < WORLD.x1 && g.z > WORLD.z0 && g.z < WORLD.z1 && g.y > WORLD.yMin && g.y < WORLD.yMax;
}

export function nearTravelDestination(g, s) {
  return Math.hypot(s.x - g.x, s.z - g.z) <= 32 && Math.abs(s.y - g.y) <= 32;
}
