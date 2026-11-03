import fs from 'node:fs';

const PLACES = JSON.parse(fs.readFileSync(new URL('../data/spawn-places.json', import.meta.url), 'utf8'));

// Only a recently approved, owned vehicle (or the saved vehicle on reconnect)
// may use this one-off relocation. Ordinary movement remains fully validated.
export function vehicleSpawnDestination(model, origin, world, runways = PLACES.runways) {
  if (!model || (model.kind !== 'plane' && model.kind !== 'boat')) return null;
  const water = model.kind === 'boat' || model.id === 'plane_seaplane';
  return (x, z, state) => {
    if (!state || state.model !== model.index) return false;
    const terrain = world.heightAt(x, z);
    if (water && world.hasTerrain && Math.hypot(x - origin.x, z - origin.z) <= 4250
      && terrain < -0.5 && state.y >= -4 && state.y <= 15) return true;
    if (model.kind !== 'plane') return false;
    for (const r of runways) {
      const dx = r.x1 - r.x0, dz = r.z1 - r.z0, len2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - r.x0) * dx + (z - r.z0) * dz) / (len2 || 1)));
      if (Math.hypot(x - r.x0 - dx * t, z - r.z0 - dz * t) > Math.max(120, r.w / 2 + 40)) continue;
      const surface = Math.max(terrain, r.y || 0);
      if (state.y >= surface - 15 && state.y <= surface + 35) return true;
    }
    return false;
  };
}
