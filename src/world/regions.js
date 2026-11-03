// Large region labels (positions read off the YANIS v17 community map) and teleport destinations.
export const REGIONS = [
  { name: 'Vice City', sub: 'Miami', x: 330, z: -800, r: 3200, big: true },
  { name: 'Mt. Kalaga National Park', sub: 'National Park', x: -3880, z: -6150, r: 2600, big: true },
  { name: 'Grassrivers', sub: 'Everglades', x: -3850, z: 4090, r: 2400, big: true },
  { name: 'Leonida Keys', sub: 'Florida Keys', x: -4280, z: 6500, r: 3000, big: true },
  { name: 'Port Gellhorn', sub: 'Panhandle', x: -7000, z: -3900, r: 1500, big: true },
  { name: 'Ambrosia', sub: 'Clewiston', x: -2900, z: -4000, r: 1100, big: true },
  { name: 'Lake Leonida', sub: 'Lake Okeechobee', x: -1950, z: -4800, r: 1000, big: true, water: true },
  { name: 'Watson Bay', sub: 'Leonida', x: -5540, z: 3540, r: 900, big: true },
  { name: 'Key Lento', sub: 'Key Largo', x: -2150, z: 6040, r: 900, big: true },
  { name: 'Capri', sub: 'Naples', x: -6670, z: -20, r: 1200, big: true },
];

export const DESTINATIONS = [
  { name: 'Downtown', area: 'Vice City', x: -660, z: 100 },
  { name: 'Ocean Beach', area: 'Vice Beach', x: 1740, z: -700 },
  { name: 'Washington Beach', area: 'Vice Beach', x: 1700, z: -2180 },
  { name: 'Tequesta', area: 'Vice City', x: -890, z: 1110 },
  { name: 'Little Cuba', area: 'Vice City', x: -1190, z: -60 },
  { name: 'Starfish Island', area: 'Vice City', x: 795, z: -465 },
  { name: 'Vice City International Airport', area: 'Vice City', x: -2146, z: 724 },
  { name: 'Port Gellhorn', area: 'Panhandle', x: -6560, z: -3670 },
  { name: 'Ambrosia', area: 'Kelly County', x: -2800, z: -3970 },
  { name: 'Mt. Kalaga', area: 'National Park', x: -3600, z: -6400 },
  { name: 'Capri', area: 'Gulf Coast', x: -6670, z: -20 },
  { name: 'Hamlet', area: 'Grassrivers', x: -2690, z: 3190 },
  { name: 'Watson Bay', area: 'Grassrivers', x: -4950, z: 3310 },
  { name: 'Key Lento', area: 'Leonida Keys', x: -2510, z: 5890 },
  { name: 'Gellhorn International Raceway', area: 'Port Gellhorn', x: -6566, z: -2043 },
  { name: 'Emerald Springs', area: 'Kelly County', x: -4290, z: -2300 },
  { name: 'Dalton Island', area: 'Vice City', x: 1724, z: 1392 },
  { name: 'Port Vice City', area: 'Vice City', x: 837, z: 468 },
  { name: 'Millport', area: 'Lummox County', x: -1011, z: -6489 },
];

// Region / destination subtitles are English data. Real-world names (Miami, Everglades…) are shown as is; generic words
// go through i18n. i18n: the shared instance (game.i18n / getI18n()); without it the English text is returned.
const SUB_KEYS = { 'National Park': 'area.nationalPark' };
export function areaSubLabel(sub, i18n) {
  const key = SUB_KEYS[sub];
  return key && i18n?.t ? i18n.t(key, { default: sub }) : (sub || '');
}
