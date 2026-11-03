import { lighthouse } from './lighthouse.js';
import { vcia } from './vcia.js';
import { gooseKey, airstrip } from './airfields.js';
import { blimpBase } from './blimp.js';
import { marina } from './marina.js';
import { grandstands, soccerField, footballStadium, baseballField, tennisCourts, golfCourse, spaceshipHouse } from './sports.js';
import { arena, ballpark, bowlStadium, marineStadium } from './stadiums.js';
import { steppedTower, archTower, crownTower, decoTower, balconyTower } from './towers.js';
import { wheel } from './wheel.js';
import { watsonWaterfront } from './waterfront.js';
import { oceanDrive, policeStation, hospital } from './beach.js';
import { cargoPort, cruisePort } from './port.js';
import { prison, powerStation, summit, goldenDome, flyEye, mallSign, casino, waterTowers, obelisk } from './misc.js';

const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

// Site definitions: id, display name (fan-map name where one exists), kind, world position, generator.
// Positions come from the community map POIs (tools/cache/data/landmarks.json, x = x, z = -y) and the
// building footprints in public/data/buildings.json (matched by position, never by index).
export const SITES = [
  { id: 'vcia', name: 'VCI — Vice City International', kind: 'airport', x: -2350, z: 760, build: vcia, near: 1400 },
  { id: 'goose-key', name: 'Goose Key Airfield', kind: 'airport', x: -6900, z: 6550, build: gooseKey, near: 1100 },
  { id: 'strip-ltf', strip: true, name: 'LTF Airfield', kind: 'airport', x: -2776, z: 4421, build: airstrip, sign: 'LTF AIRFIELD', near: 600 },
  { id: 'strip-watson', strip: true, name: 'Watson Bay Airport', kind: 'airport', x: -5911, z: 2472, build: airstrip, sign: 'WATSON BAY AIRPORT', near: 600 },
  // airfields drawn on the source map (#airport markers); skipped where the road data has no strip
  { id: 'strip-ambrosia', strip: true, name: 'Ambrosia Airfield', kind: 'airport', x: -4238, z: -4071, build: airstrip, sign: 'AMBROSIA AIRFIELD', near: 600 },
  { id: 'strip-kelly', strip: true, name: 'Kelly County Airfield', kind: 'airport', x: -4256, z: -5553, build: airstrip, sign: 'KELLY COUNTY AIRFIELD', near: 600 },
  { id: 'strip-lummox', strip: true, name: 'Lummox County Airfield', kind: 'airport', x: -3607, z: -7823, build: airstrip, sign: 'LUMMOX AIRFIELD', near: 600 },
  { id: 'strip-leonard', strip: true, name: 'Leonard County Airfield', kind: 'airport', x: -1573, z: -3339, build: airstrip, sign: 'LEONARD COUNTY AIRFIELD', near: 600 },
  { id: 'strip-sundown', strip: true, name: 'Sundown Private Airfield', kind: 'airport', x: -817, z: -4360, build: airstrip, sign: 'SUNDOWN AIRFIELD', near: 600 },
  { id: 'strip-mariana', strip: true, name: 'Mariana County Airfield', kind: 'airport', x: -4106, z: 2917, build: airstrip, sign: 'MARIANA AIRFIELD', near: 600 },
  // marinas (#marina markers): piers with real boats
  { id: 'marina-vice-beach', name: 'Vice Beach Marina', kind: 'marina', x: 1357, z: 112, build: marina, near: 700 },
  { id: 'marina-brians', name: "Brian's Boat Works & Marina", kind: 'marina', x: -2555, z: 5859, build: marina, piers: 3, near: 700 },
  { id: 'marina-key-lento', name: 'Key Lento marina', kind: 'marina', x: -3322, z: 6649, build: marina, near: 700 },
  { id: 'marina-shoreline', name: 'Shoreline marina', kind: 'marina', x: -132, z: -154, build: marina, piers: 4, near: 1400 },
  { id: 'marina-bayside', name: 'Bayside marina', kind: 'marina', x: -196, z: -936, build: marina, near: 700 },
  { id: 'marina-buckskin', name: 'Buckskin marina', kind: 'marina', x: -4194, z: -920, build: marina, near: 700 },
  { id: 'marina-peacock', name: 'Marina, Peacock Bay', kind: 'marina', x: -923, z: 2357, build: marina, piers: 3, near: 700 },
  { id: 'marina-goose', name: 'Goose Key marina', kind: 'marina', x: -6260, z: 6559, build: marina, near: 700 },
  { id: 'marina-mariana', name: 'Marina, Mariana County', kind: 'marina', x: -2568, z: 4666, build: marina, near: 700 },
  { id: 'marina-vice-beach-s', name: 'Vice Beach south marina', kind: 'marina', x: 960, z: -1734, build: marina, near: 700 },
  { id: 'blimp-base', name: 'Blimp Base, Mariana County', kind: 'airport', x: -4433, z: 6827, build: blimpBase, near: 1600, sign: 'SKYCAST' },
  { id: 'strip-gellhorn', strip: true, name: 'Port Gellhorn Airfield', kind: 'airport', x: -7335, z: -3252, build: airstrip, sign: 'PORT GELLHORN AIRFIELD', near: 600 },
  // ---- sports & leisure ----
  { id: 'arena', name: 'Sahara Arena', kind: 'stadium', x: -305, z: -433, build: arena, footprints: [[-312, -464], [-298, -404]], a: 77, b: 58, sign: 'BAYSIDE ARENA' },
  { id: 'ballpark', name: 'Fleeca Field', kind: 'stadium', x: -1600, z: -1048, build: ballpark, clear: rect(-1695, -1137, -1505, -958), a: 88, b: 80, yaw: 0, sign: 'VICE CITY BALLPARK' },
  { id: 'tennis', name: 'Tennis Stadium', kind: 'stadium', x: -309, z: 1866, build: bowlStadium, a: 40, b: 40, e: 4, h: 15, spot: true, court: 0x2f6aa8, seats: 0x3a5f8f, sign: 'CATALAN KEY TENNIS CENTER' },
  { id: 'capri-stadium', name: 'Capri City Jackals Stadium', kind: 'stadium', x: -6409, z: 211, build: bowlStadium, a: 66, b: 46, e: 2.4, h: 11, spot: true, court: 0x4f9a3a, seats: 0xc0303a, masts: true, sign: 'CAPRI CITY STADIUM' },
  { id: 'marine-stadium', name: 'Marine Stadium', kind: 'stadium', x: 599, z: 1836, build: marineStadium, yaw: -0.985 },
  // ---- open-air sports grounds (sports.js: surfaces fitted to the sport / park ground of the map) ----
  { id: 'gellhorn-grandstands', name: 'Gellhorn International Raceway grandstands', kind: 'stadium', x: -6830, z: -1990, build: grandstands, near: 900,
    stands: [{ x: -6973, z: -1961, len: 42, rows: 10, name: 'GELLHORN' }, { x: -6772, z: -1883, len: 96, rows: 12, name: 'GELLHORN INTERNATIONAL RACEWAY' },
      { x: -6769, z: -2105, len: 72, rows: 16, covered: true, name: 'PIT STRAIGHT' }, { x: -6721, z: -2062, len: 16, rows: 6 }] },
  { id: 'soccer-gellhorn', name: 'Soccer Field, Port Gellhorn', kind: 'sport', x: -6851, z: -3651, build: soccerField },
  { id: 'football-ambrosia', name: 'Football Stadium, Ambrosia', kind: 'sport', x: -3188, z: -4386, build: footballStadium, sign: 'AMBROSIA HIGH', seats: 0x7a2424, endzone: 0x7a2424 },
  { id: 'baseball-ambrosia', name: 'Baseball Field, Ambrosia', kind: 'sport', x: -3308, z: -4172, build: baseballField },
  { id: 'tennis-bayside', name: 'Tennis courts, Bayside', kind: 'sport', x: -320, z: -1169, build: tennisCourts, near: 500 },
  { id: 'tennis-ocean-beach', name: 'Tennis Court, Ocean Beach', kind: 'sport', x: 1503, z: 81, build: tennisCourts, near: 500, court: 0x3f8a4a, surround: 0x2f6a3a },
  { id: 'tennis-y', name: 'Tennis Court, Y Vice Beach', kind: 'sport', x: 1934, z: -1604, build: tennisCourts, near: 500 },
  { id: 'golf-leaf-links', name: 'Leaf Links Golf Club', kind: 'sport', x: 578, z: -2487, build: golfCourse, near: 1400, start: [712, -2295], reach: 560 },
  { id: 'spaceship-house', name: 'Spaceship House', kind: 'art', x: -5633, z: -6843, build: spaceshipHouse, near: 700 },
  { id: 'wheel', name: 'Bayside Skywheel', kind: 'leisure', x: 33, z: -137, build: wheel },
  { id: 'watson-waterfront', name: 'Watson Island beach', kind: 'leisure', x: 240, z: -570, build: watsonWaterfront, near: 1100 },
  // ---- skyline ----
  { id: 'heath-tower', name: 'Heath Tower', kind: 'tower', x: -785, z: 415, build: steppedTower, take: [[-774, 427], [-796, 402]], h: 152, near: 1200 },
  { id: 'tequesta-arc', name: 'Tequesta Arc', kind: 'tower', x: -793, z: 1129, build: archTower, take: [[-793, 1129]], h: 205, rise: 34, cluster: 'tequesta', near: 1200 },
  { id: 'tequesta-spire', name: 'Tequesta Spire', kind: 'tower', x: -783, z: 1101, build: crownTower, take: [[-781, 1102]], style: 'spire', h: 200, spire: 48, cluster: 'tequesta', near: 1200 },
  { id: 'megamundo', name: 'Megamundo', kind: 'tower', x: -469, z: 293, build: crownTower, take: [[-469, 292]], style: 'colonnade', h: 174, facade: 0xc9c4b9, cluster: 'downtown', near: 1400 },
  { id: 'shoreline-residences', name: 'Shoreline Residences', kind: 'tower', x: -494, z: -406, build: balconyTower, h: 174, cluster: 'shoreline-skyline', near: 1400 },
  { id: 'bayfront-residences', name: 'Bayfront Residences', kind: 'tower', x: -464, z: 257, build: balconyTower, h: 118, cluster: 'downtown', near: 1400 },
  { id: 'flagler-crown', name: 'Flagler Crown', kind: 'tower', x: -684, z: 91, build: crownTower, take: [[-684, 91]], style: 'lattice', crown: 20, cluster: 'downtown', near: 1200 },
  { id: 'palaestra', name: 'Palaestra Tower', kind: 'tower', x: -452, z: -678, build: decoTower, yaw: 0.1 },
  // ---- beach & civic ----
  { id: 'ocean-drive', name: 'Ocean Drive hotels', kind: 'hotels', x: 1935, z: -500, build: oceanDrive, near: 900,
    row: [[2030, -1000], [1990, -620], [1955, -330], [1942, -200], [2030, -130], [2030, 40], [1940, 40], [1930, -120], [1880, -200], [1895, -400], [1905, -620], [1915, -1000]] },
  { id: 'vbpd', name: 'Vice Beach Police Department', kind: 'civic', x: 1480, z: -393, build: policeStation, style: 'deco', cars: 5 },
  { id: 'vcpd', name: 'Vice City Police HQ', kind: 'civic', x: -775, z: -784, build: policeStation, style: 'modern', cars: 6 },
  { id: 'hospital', name: 'Vice Beach Medical Center', kind: 'civic', x: 1049, z: -2112, build: hospital, near: 1000 },
  { id: 'prison', name: 'Leonida State Prison', kind: 'civic', x: -2820, z: 2840, build: prison, near: 1000,
    towers: [[-2912, 2733], [-2749, 2758], [-2612, 2837], [-2659, 2912], [-2922, 2932], [-3014, 2827]], gate: [-2690, 2952],
    blocks: [[-2961, 2791], [-2843, 2746], [-2887, 2825], [-2888, 2881], [-2780, 2911], [-2834, 2794], [-2733, 2866], [-2690, 2827], [-2776, 2855], [-2972, 2843], [-2933, 2809], [-2737, 2821]] },
  { id: 'power', name: 'Fuzzard Power Station', kind: 'industry', x: -1560, z: 3600, build: powerStation, near: 1200,
    clear: [[-1618, 3502], [-1666, 3546], [-1570, 3535], [-1572, 3468], [-1532, 3771], [-1532, 3729], [-1583, 3588], [-1495, 3771], [-1493, 3729]],
    domes: [[-1572, 3469], [-1570, 3534]], halls: [[-1618, 3502, -Math.PI / 2, 100, 22], [-1532, 3771, 0, 46, 18], [-1532, 3729, 0, 42, 18]],
    stacks: [[-1489, 3696], [-1491, 3778]], signAt: [-1606.4, 3502], signYaw: Math.PI / 2 },
  // ---- port ----
  { id: 'port-cargo', name: 'Port Vice City container terminal', kind: 'port', x: 1200, z: 560, build: cargoPort, cluster: 'port-vice', near: 1300,
    cranes: [[1049, 240], [1143, 319], [1242, 406], [1350, 494], [1486, 602], [1364, 743], [1260, 767], [1109, 798], [948, 828]],
    yard: [1180, 560, 240, 170], yardAxis: [0.77, 0.64], rtg: 6 },
  { id: 'port-cruise', name: 'Port Vice City cruise terminals', kind: 'port', x: 370, z: 360, build: cruisePort, cluster: 'port-vice', near: 1300,
    quayA: [150, 289], quayB: [597, 425], ships: [{ t: 0.22, name: 'SEA CELESTE', funnel: 0x1f5fa8 }, { t: 0.8, name: 'CORAL MAJESTY', funnel: 0xd6283b, reverse: true }] },
  { id: 'port-gellhorn', name: 'Port Gellhorn container cranes', kind: 'port', x: -7820, z: -4660, build: cargoPort, near: 900,
    cranes: [[-7942, -4721], [-7869, -4668], [-7659, -4593]], col: 0x2f6db5, alt: 0xe8e8e8, yard: 'auto', rtg: 2, seed: 9 },
  // ---- misc ----
  { id: 'kalaga', name: 'Mt. Kalaga summit', kind: 'nature', x: -3430, z: -6371, build: summit, near: 900 },
  { id: 'oceanarium', name: 'Vice City Oceanarium dome', kind: 'leisure', x: 81, z: 1748, build: goldenDome, r: 25, sign: 'OCEANARIUM' },
  { id: 'fly-eye', name: "Fly's Eye Dome", kind: 'art', x: -245, z: -2180, build: flyEye, cluster: 'misc-small', near: 600 },
  { id: 'obelisk', name: 'Memorial obelisk', kind: 'art', x: 812, z: -935, build: obelisk, cluster: 'misc-small', near: 600 },
  { id: 'mall', name: 'Evergreen Mall', kind: 'retail', x: -556, z: -4069, build: mallSign, mallX: -290, mallZ: -4030 },
  { id: 'casino', name: 'Vice City Casino', kind: 'leisure', x: -112, z: -3116, build: casino },
  { id: 'water-towers', name: 'Town water towers', kind: 'utility', x: -2963, z: 3099, build: waterTowers, near: 500,
    towers: [{ x: -2963, z: 3099, name: 'HAMLET' }, { x: 398, z: -4164, name: 'WANING SANDS', color: 0xf2f2ee }, { x: -948, z: -3205 }, { x: -5101, z: -1610, name: 'KELLY COUNTY', color: 0xe8e0c8 },
      { x: -6378, z: -4548, name: 'PORT GELLHORN', color: 0xdfe8ee }, { x: -4960, z: 3279, name: 'WATSON BAY', color: 0xe6f0f2 }, { x: -2944, z: -4242, name: 'AMBROSIA', color: 0xf0e8d0 },
      { x: -6355, z: 44, name: 'CAPRI', color: 0xf6e6ee }, { x: 799, z: -494, color: 0xffffff, h: 30, r: 5.5 }, { x: -2254, z: -876, name: 'BALSERO' }, { x: -6655, z: -3650, name: 'PORT GELLHORN', color: 0xdfe8ee }] },
  { id: 'lighthouse-catalan', name: 'Catalan Key Lighthouse', kind: 'lighthouse', x: -398, z: 2851, build: lighthouse, style: 'tower' },
  { id: 'lighthouse-belpoint', name: 'Belpoint Lighthouse', kind: 'lighthouse', x: -7940, z: 363, build: lighthouse, style: 'skeletal' },
  { id: 'lighthouse-reef', name: 'Sombrero Reef Light', kind: 'lighthouse', x: -3004, z: 7257, build: lighthouse, style: 'reef', water: true, beam: 420 },
];
