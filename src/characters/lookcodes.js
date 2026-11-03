// Appearance codes shared by looks.js (instance data), geometry.js (masked pieces), the HumanBatch shader and the
// wardrobe catalogue. Plain constants, no three.js (Node-safe: the economy and the server import the catalogue).

// cloth patterns (shader ids, iCloth.z). OPEN + id: the same print worn open over the top (front strip shows colour C).
// HEM + id: ribbed hem band at the bottom of the part (jackets: abdomen).
export const PAT = {
  plain: 0, hawaii: 1, stripes: 2, worn: 3, plaid: 4, suit: 5, denim: 6, collar: 7, hoodie: 8, sport: 9, dots: 10, graphic: 11,
  tiedye: 12, sole: 13, flamingo: 14, palm: 15, camo: 16, gingham: 17, leather: 18, bomber: 19, blazer: 20, djacket: 21,
  track: 22, varsity: 23, windbreaker: 24, cargo: 25, boots: 26, sequin: 27, sunset: 28, leopard: 29, pinstripe: 30, cuff: 31,
};
export const OPEN = 40;
export const HEM = 100;

// head extras (headX: hair and facial hair; colours A hair, B facial hair, C stubble)
export const HX = {
  buzz: 0, short: 1, long: 2, ponytail: 3, afro: 4, bun: 5, mohawk: 6, curly: 7, bob: 8,
  beard: 9, mustache: 10, goatee: 11, slick: 12, pompadour: 13, locs: 14, cornrows: 15, sidepart: 16,
  spiky: 17, mullet: 18, topknot: 19, stubble: 20, chops: 21, handlebar: 22,
};
export const HAIR_STYLES = ['bald', 'buzz', 'short', 'sidepart', 'curly', 'long', 'ponytail', 'bun', 'bob', 'afro', 'mohawk',
  'slick', 'pompadour', 'locs', 'cornrows', 'spiky', 'mullet', 'topknot'];

// head wear (headY: hats, glasses, earrings; colours A hat, B glasses frame, C lenses)
export const HY = {
  cap: 0, capback: 1, trucker: 2, beanie: 3, visor: 4, bucket: 5, sunhat: 6, beret: 7, fedora: 8, cowboy: 9,
  bandBlack: 10, bandGold: 11,
  shades: 12, round: 13, clear: 14, aviator: 15, cateye: 16, shield: 17, browline: 18,
  studs: 19, hoops: 20, diamonds: 21,
};
export const HATS = ['cap', 'capback', 'trucker', 'beanie', 'visor', 'bucket', 'sunhat', 'beret', 'fedora', 'cowboy'];
export const GLASSES = ['shades', 'round', 'clear', 'aviator', 'cateye', 'shield', 'browline'];

// chest extras (chestX: A top / jacket colour, B backpack, C pattern colour)
export const CX = {
  backpack: 0, bust: 1, hood: 2, collar: 3, chain: 4, rope: 5, cuban: 6, medallion: 7, pearls: 8, silver: 9,
  lapels: 10, band: 11, bowtie: 12,
};
// hip extras
export const PX = { skirt: 0, longskirt: 1, beltbag: 2, belt: 3 };
// hand extras (per hand)
export const AX = { phone: 0, bag: 1, briefcase: 2, cup: 3, watch: 4, watchGold: 5, watchDiamond: 6, digital: 7, smart: 8, bracelet: 9, rings: 10 };

// tattoo styles (integer part of the per-part code; the fraction is a seed)
export const TAT = { tribal: 1, sleeve: 2, star: 3, script: 4, rose: 5, waves: 6, palm: 7, sun: 8, geo: 9, heart: 10, snake: 11, wings: 12, burst: 13 };

export const SKIN = [0xf6dcc8, 0xf1c9a5, 0xe8b893, 0xdca47c, 0xc68c5c, 0xa86f45, 0x8d5a3b, 0x6e4329, 0x5a3622, 0x432819];
