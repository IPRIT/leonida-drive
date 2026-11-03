import { REGIONS } from './regions.js';

// District wealth: 0 poor .. 1 rich (drives traffic vehicle mix, pedestrian looks).
const WEALTH = {
  'Ocean Beach': 0.85, 'Washington Beach': 0.95, 'Starfish Island': 1, 'Tequesta': 0.9, 'Tequesta Retreat': 1,
  'Downtown': 0.8, 'Leaf Links': 0.95, 'Rialto Islands': 0.9, 'Gloriana Key': 0.85, 'Dalton Island': 0.85,
  'Vice Decor District': 0.7, 'Bayside': 0.65, 'Crosstown': 0.45, 'Salton': 0.4, 'Shoreline': 0.7, 'Peacock Bay': 0.75,
  'La Perle': 0.6, 'Little Cuba': 0.3, 'Southside': 0.2, 'Stockyard': 0.15, 'Balsero': 0.25, 'Rockridge': 0.35,
  'Hamlet': 0.15, 'Ambrosia': 0.2, 'Allied Crystal': 0.2, 'Port Gellhorn': 0.3, 'Capri': 0.75, 'Key Lento': 0.55,
  'Watson Bay': 0.25, 'Waning Sands': 0.35, 'Catalan Key': 0.6, 'Port Vice City': 0.3, 'Vice City International Airport': 0.5,
  'Vice City': 0.5, 'Vice Beach': 0.85, 'Leonida Keys': 0.55, 'Grassrivers': 0.15, 'Mt. Kalaga National Park': 0.3,
};

export class Areas {
  constructor(world) {
    this.districts = world.districts;
  }

  areaAt(x, z) {
    let best = null, bd = Infinity;
    for (const pass of ['d', 'a']) {
      for (const d of this.districts) {
        if (d.type !== pass) continue;
        const k = Math.hypot(x - d.x, z - d.z) / d.r;
        if (k < 1 && k < bd) { bd = k; best = { name: d.name, sub: pass === 'd' ? d.area : 'Leonida', key: d.name }; }
      }
      if (best) break;
    }
    if (!best) {
      for (const r of REGIONS) {
        const k = Math.hypot(x - r.x, z - r.z) / r.r;
        if (k < 1 && k < bd) { bd = k; best = { name: r.name, sub: r.sub, key: r.name }; }
      }
    }
    best ||= { name: 'Leonida', sub: 'State of Leonida', key: 'Leonida' };
    best.wealth = WEALTH[best.name] ?? WEALTH[best.sub] ?? 0.4;
    return best;
  }

  wealthAt(x, z) { return this.areaAt(x, z).wealth; }
}
