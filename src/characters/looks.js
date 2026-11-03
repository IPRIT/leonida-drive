// Appearance generator: body types, skin, hair, clothing, accessories, tattoos (district-aware),
// and conversion of a look into per-instance shader data for HumanBatch.
import * as THREE from 'three';
import { PARTS, PART, MESH_MULT } from './rig.js';
import { PAT, OPEN, HEM, HX, HY, CX, PX, AX, HAIR_STYLES, SKIN } from './lookcodes.js';

export { PAT, OPEN, HEM, HX, HY, CX, PX, AX, HAIR_STYLES, SKIN };

// ---- per-instance layout (see HumanBatch): colA(3) colB(3) colC(3) cloth(4: y0, y1, pattern, tattoo) shape(2: taper, mask)
export const STRIDE = 15;
const HAIR_NATURAL = [0x14100e, 0x14100e, 0x2a1b12, 0x2a1b12, 0x4e3220, 0x7a5232, 0xc9a35f, 0xe2cf9a, 0x9a3e1c];
const HAIR_GREY = [0x8e8e8e, 0xb5b5b5, 0xd8d8d8, 0xeeeeee];
const HAIR_DYED = [0xff4fa0, 0x2fd6d0, 0x8b4fd8, 0x3a6bff, 0x4fd86b, 0xf2eccf, 0xff7a3d, 0xd63a5a];
const VIVID = [0xff4f9a, 0x2fd6d0, 0xf5c84c, 0x6b8cff, 0xff8a3d, 0x8fe38a, 0xb38cff, 0x67c3ff, 0xffd6e8, 0xff6f61, 0x41e2b4, 0xffb3c7];
const PASTEL = [0xffd1dc, 0xb5ead7, 0xc7ceea, 0xfff1b5, 0xffdac1, 0xe2f0cb, 0xd4a5ff, 0xa8e6ff, 0xffffff, 0xf7f3e8];
const NEUTRAL = [0x1d1f24, 0x2b3445, 0x3a3a3a, 0x7a7a80, 0xe6dcc6, 0xffffff, 0x5a5f4a, 0x6b4f3a, 0x8a7a5a, 0x2f4f3f];
const DARK = [0x1d1f24, 0x26292f, 0x2b3445, 0x3a2f2a, 0x40403a, 0x1e2a22, 0x3d2b3d];
const DENIM = [0x3d5a80, 0x2b4466, 0x5878a0, 0x1f2c44, 0x7a90b0];
const KHAKI = [0xd8c7a0, 0xc2ad85, 0xe6dcc6, 0x8a7a5a, 0x6b6450];
const SUIT = [0x1d1f24, 0x2b3445, 0x3a3d44, 0xe8e2d4, 0x6a6f78, 0x8a6f52, 0xf2c6d6, 0x8fd6e8];
const SHOES = [0xf2f2f2, 0x1d1f24, 0xf2f2f2, 0x6b4f3a, 0xd94f4f, 0x3a6bff, 0xe6dcc6];

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
}
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];
const chance = (r, p) => r() < p;

/**
 * Random look. ctx: { wealth 0..1, beach bool, night 0..1, build?, fem? }
 * @returns {object} look (plain data)
 */
export function makeLook(r, ctx = {}) {
  const wealth = ctx.wealth ?? 0.5;
  const beach = !!ctx.beach;
  const night = ctx.night ?? 0;
  const fem = ctx.fem ?? (chance(r, 0.5) ? 1 : 0);
  let build = ctx.build;
  if (!build) {
    const x = r();
    build = x < 0.17 ? 'thin' : x < 0.55 ? 'average' : x < 0.72 ? 'athletic' : x < 0.88 ? 'heavy' : 'elderly';
  }
  const elderly = build === 'elderly';
  const h = (fem ? 1.6 + r() * 0.17 : 1.68 + r() * 0.2) - (elderly ? 0.04 : 0) + (build === 'athletic' ? 0.02 : 0);
  const look = { build, fem, h, seed: Math.floor(r() * 1e6), wealth, beach };
  look.skin = pick(r, SKIN);
  // ---- hair ----
  let style;
  const hs = r();
  if (elderly) style = hs < 0.3 ? 'bald' : hs < 0.6 ? 'short' : hs < 0.8 ? (fem ? 'bun' : 'sidepart') : fem ? 'bob' : 'buzz';
  else if (fem) style = hs < 0.3 ? 'long' : hs < 0.46 ? 'ponytail' : hs < 0.58 ? 'bun' : hs < 0.7 ? 'bob' : hs < 0.8 ? 'afro' : hs < 0.88 ? 'curly' : hs < 0.94 ? 'short' : hs < 0.97 ? 'buzz' : 'mohawk';
  else style = hs < 0.14 ? 'bald' : hs < 0.36 ? 'buzz' : hs < 0.58 ? 'short' : hs < 0.68 ? 'sidepart' : hs < 0.8 ? 'curly' : hs < 0.87 ? 'afro' : hs < 0.92 ? 'long' : hs < 0.96 ? 'ponytail' : 'mohawk';
  if (wealth > 0.8 && style === 'mohawk') style = 'sidepart';
  look.hairStyle = style;
  const dark = SKIN.indexOf(look.skin) >= 5;
  look.hairColor = elderly ? pick(r, HAIR_GREY)
    : chance(r, wealth < 0.4 ? 0.14 : 0.08) || style === 'mohawk' ? pick(r, HAIR_DYED)
      : dark ? pick(r, HAIR_NATURAL.slice(0, 4)) : pick(r, HAIR_NATURAL);
  look.facial = 0;
  if (!fem) {
    const f = r();
    if (f < 0.16) look.facial = 1 << HX.beard;
    else if (f < 0.24) look.facial = 1 << HX.mustache;
    else if (f < 0.32) look.facial = 1 << HX.goatee;
  }
  look.facialColor = chance(r, 0.85) ? look.hairColor : pick(r, HAIR_NATURAL);
  if (elderly && look.facial) look.facialColor = pick(r, HAIR_GREY);

  // ---- clothing ----
  const rich = wealth > 0.75, poor = wealth < 0.35;
  let top, bottom;
  const tk = r();
  if (beach && !night && tk < 0.55) {
    top = fem ? (chance(r, 0.55) ? 'bikini' : 'swimsuit') : 'none';
    bottom = fem ? (top === 'swimsuit' ? 'swimsuit' : 'bikini') : 'trunks';
  } else if (rich && tk < 0.32 && !beach) {
    top = 'suit'; bottom = fem && chance(r, 0.4) ? 'skirt' : 'suit';
  } else if (fem && tk < (beach ? 0.75 : 0.5) && chance(r, 0.35)) {
    top = 'dress'; bottom = 'dress';
  } else {
    const opts = beach ? ['tank', 'tshirt', 'hawaii', 'tshirt', 'crop', 'polo', 'tank']
      : poor ? ['tshirt', 'tshirt', 'hoodie', 'tank', 'tshirt', 'hawaii', 'polo']
        : rich ? ['polo', 'shirt', 'tshirt', 'hawaii', 'polo', 'shirt', 'crop']
          : ['tshirt', 'tshirt', 'polo', 'hawaii', 'hoodie', 'tank', 'shirt', 'crop'];
    top = pick(r, opts);
    if (top === 'crop' && !fem && chance(r, 0.8)) top = 'tank';
    if (night > 0.5 && chance(r, 0.3)) top = 'hoodie';
    const bo = beach ? ['shorts', 'shorts', 'shorts', 'skirt', 'jeans']
      : rich ? ['chinos', 'jeans', 'shorts', 'skirt', 'chinos']
        : poor ? ['jeans', 'jeans', 'shorts', 'track', 'chinos']
          : ['jeans', 'shorts', 'chinos', 'skirt', 'jeans', 'track'];
    bottom = pick(r, bo);
    if (bottom === 'skirt' && !fem && chance(r, 0.9)) bottom = 'shorts';
  }
  if (elderly && (top === 'crop' || top === 'tank')) top = 'polo';
  look.top = top;
  look.bottom = bottom;
  const palette = beach ? (chance(r, 0.5) ? VIVID : PASTEL) : rich ? (chance(r, 0.5) ? PASTEL : NEUTRAL) : poor ? (chance(r, 0.6) ? DARK : NEUTRAL) : chance(r, 0.4) ? VIVID : NEUTRAL;
  look.topColor = top === 'suit' ? pick(r, SUIT) : pick(r, palette);
  look.topPattern = PAT.plain;
  look.topPatColor = pick(r, chance(r, 0.5) ? VIVID : PASTEL);
  if (top === 'hawaii') { look.topPattern = PAT.hawaii; look.topColor = pick(r, [0x1fb5a8, 0xff5fa2, 0x2b3445, 0xf5c84c, 0x3a6bff, 0xffffff, 0xff8a3d, 0x2f6b4f]); }
  else if (top === 'suit') { look.topPattern = PAT.suit; look.topPatColor = chance(r, 0.7) ? 0xf4f4f4 : pick(r, PASTEL); look.tieColor = pick(r, [0x8c1c2c, 0x1d2b55, 0x1d1f24, 0xd94f4f, 0x2fd6d0]); }
  else if (top === 'polo') look.topPattern = PAT.collar;
  else if (top === 'hoodie') look.topPattern = PAT.hoodie;
  else if (top === 'tshirt' || top === 'tank' || top === 'crop') {
    const p = r();
    look.topPattern = p < 0.2 ? PAT.stripes : p < 0.36 ? PAT.graphic : p < 0.42 ? PAT.tiedye : poor && p < 0.7 ? PAT.worn : PAT.plain;
  } else if (top === 'shirt') look.topPattern = chance(r, 0.3) ? PAT.plaid : chance(r, 0.3) ? PAT.stripes : PAT.collar;
  else if (top === 'dress') look.topPattern = chance(r, 0.4) ? PAT.dots : chance(r, 0.3) ? PAT.hawaii : PAT.plain;
  else if (top === 'bikini' || top === 'swimsuit' || top === 'none') look.topPattern = chance(r, 0.3) ? PAT.stripes : PAT.plain;
  if (poor && look.topPattern === PAT.plain && chance(r, 0.4)) look.topPattern = PAT.worn;
  // bottoms
  look.bottomPattern = PAT.plain;
  if (bottom === 'jeans') { look.bottomColor = pick(r, DENIM); look.bottomPattern = poor ? PAT.worn : PAT.denim; }
  else if (bottom === 'chinos') look.bottomColor = pick(r, KHAKI);
  else if (bottom === 'shorts') { look.bottomColor = pick(r, chance(r, 0.5) ? KHAKI.concat(DENIM) : beach ? VIVID : NEUTRAL); if (beach && chance(r, 0.3)) look.bottomPattern = PAT.hawaii; }
  else if (bottom === 'track') { look.bottomColor = pick(r, DARK); look.bottomPattern = PAT.sport; }
  else if (bottom === 'suit') look.bottomColor = look.topColor;
  else if (bottom === 'skirt') { look.bottomColor = pick(r, chance(r, 0.5) ? PASTEL : NEUTRAL.concat(VIVID)); look.bottomPattern = chance(r, 0.25) ? PAT.plaid : PAT.plain; }
  else if (bottom === 'dress' || bottom === 'swimsuit') { look.bottomColor = look.topColor; look.bottomPattern = look.topPattern; }
  else if (bottom === 'bikini') { look.bottomColor = chance(r, 0.7) ? look.topColor : pick(r, VIVID); look.bottomPattern = look.topPattern; }
  else if (bottom === 'trunks') { look.bottomColor = pick(r, VIVID.concat([0x2b3445, 0xff4f9a])); look.bottomPattern = chance(r, 0.35) ? PAT.hawaii : chance(r, 0.3) ? PAT.stripes : PAT.plain; }
  look.bottomPatColor = pick(r, chance(r, 0.5) ? PASTEL : VIVID);
  look.longSkirt = (bottom === 'dress' && chance(r, 0.5)) || (bottom === 'skirt' && elderly);
  // shoes
  const barefoot = beach && (top === 'none' || top === 'bikini' || top === 'swimsuit' || bottom === 'trunks');
  look.shoes = barefoot ? (chance(r, 0.6) ? 'sandals' : 'bare') : top === 'suit' ? 'formal' : beach && chance(r, 0.5) ? 'sandals' : 'sneakers';
  look.shoeColor = look.shoes === 'formal' ? pick(r, [0x1d1f24, 0x3a2418, 0x6b4f3a]) : look.shoes === 'sandals' ? pick(r, VIVID.concat([0x1d1f24, 0x6b4f3a])) : pick(r, SHOES);
  look.socks = look.shoes === 'sneakers' && (bottom === 'shorts' || bottom === 'track') && chance(r, 0.5);

  // ---- accessories ----
  look.glasses = chance(r, beach ? 0.45 : rich ? 0.3 : 0.15);
  const hatP = r();
  look.hat = beach && hatP < 0.18 ? 'sunhat' : hatP < (poor ? 0.18 : 0.1) ? 'cap' : elderly && hatP < 0.3 ? 'sunhat' : null;
  if (look.hat && (style === 'afro' || style === 'mohawk' || style === 'bun')) look.hat = null;
  look.hatColor = pick(r, chance(r, 0.5) ? VIVID : NEUTRAL);
  look.earrings = fem && chance(r, 0.3);
  look.backpack = !beach && chance(r, poor ? 0.12 : 0.08) && top !== 'suit';
  look.chain = chance(r, rich ? 0.12 : 0.08) && !fem;
  look.beltbag = chance(r, 0.04);
  look.watch = chance(r, rich ? 0.5 : 0.2);
  const hand = r();
  look.handR = top === 'suit' && hand < 0.35 ? 'briefcase' : hand < 0.14 ? 'phone' : hand < (rich ? 0.36 : 0.2) ? 'bag' : hand < 0.24 ? 'cup' : null;
  look.handL = !look.handR && chance(r, rich ? 0.12 : 0.05) ? 'bag' : null;
  look.bagColor = look.handR === 'briefcase' ? pick(r, [0x1d1f24, 0x3a2418, 0x6b4f3a]) : pick(r, VIVID.concat(PASTEL, [0x1d1f24, 0xffffff]));
  look.backpackColor = pick(r, VIVID.concat(DARK));

  // ---- tattoos: {partName: code} code = style + seed fraction ----
  look.tattoos = {};
  const tp = 0.14 + (1 - wealth) * 0.22 + (beach ? 0.1 : 0) - (elderly ? 0.08 : 0);
  if (chance(r, tp)) {
    const n = 1 + Math.floor(r() * 4);
    const spots = ['uArmL', 'uArmR', 'lArmL', 'lArmR', 'lLegL', 'lLegR', 'uLegR', 'neck', 'chest', 'abdomen'];
    const sleeve = chance(r, 0.25);
    for (let i = 0; i < n; i++) {
      const s = pick(r, spots);
      const st = sleeve && s.includes('Arm') ? 2 : 1 + Math.floor(r() * 5);
      look.tattoos[s] = st + Math.min(0.95, r());
      if (sleeve && s.includes('Arm')) look.tattoos[s.startsWith('u') ? s.replace('u', 'l') : s.replace('l', 'u')] = 2 + r() * 0.95;
    }
  }
  return look;
}

// deterministic look from a seed (multiplayer: every client derives the same appearance)
export function lookFromSeed(seed, ctx = {}) {
  const r = rng(seed >>> 0 || 1);
  return makeLook(r, { wealth: 0.6, night: 0, ...ctx, build: ctx.build ?? (r() < 0.08 ? 'elderly' : undefined) });
}

// the player's (original) protagonist look
export function playerLook() {
  return {
    build: 'athletic', fem: 0, h: 1.8, seed: 7, wealth: 0.6, beach: false,
    skin: 0xc68c5c, hairStyle: 'curly', hairColor: 0x1a120c, facial: 1 << HX.beard, facialColor: 0x1a120c,
    top: 'hawaii', topColor: 0x14a89c, topPattern: PAT.hawaii, topPatColor: 0xff5fa2,
    bottom: 'chinos', bottomColor: 0xd8c7a0, bottomPattern: PAT.plain, bottomPatColor: 0xffffff,
    shoes: 'sneakers', shoeColor: 0xf4f4f4, socks: false,
    glasses: false, hat: null, earrings: false, backpack: false, chain: true, beltbag: false, watch: true,
    handR: null, handL: null, bagColor: 0, backpackColor: 0, hatColor: 0,
    tattoos: { lArmR: 1.37, uArmL: 5.62 },
  };
}

// ---------- look -> instance data ----------
const _c = new THREE.Color(), _c2 = new THREE.Color();
function lin(hex, out, o) { _c.setHex(hex); out[o] = _c.r; out[o + 1] = _c.g; out[o + 2] = _c.b; }
function mixHex(a, b, t) { _c.setHex(a); _c2.setHex(b); _c.lerp(_c2, t); return _c.getHex(); }

const NEVER = 3; // cloth range that never matches (skin everywhere)
// hats that cover the crown: voluminous hair styles are tucked under them
const CROWN_HATS = new Set(['cap', 'capback', 'trucker', 'beanie', 'bucket', 'sunhat', 'beret', 'fedora', 'cowboy']);
const BIG_HAIR = new Set(['afro', 'mohawk', 'bun', 'topknot', 'pompadour', 'spiky']);
// jackets: closed ones hide the top completely; open ones show it in a front strip (colour C)
const JACKET_OPEN = new Set([PAT.leather, PAT.bomber, PAT.blazer, PAT.djacket]);
const SHOE_SOLE = { sneakers: 0xf4f4f4, hightops: 0xf4f4f4, runners: null, formal: 0x1a1410, loafers: 0x2a1c14, boots: 0x2a2420, chelsea: 0x1a1410, sandals: null, slides: null };
const WATCH = { steel: AX.watch, gold: AX.watchGold, diamond: AX.watchDiamond, digital: AX.digital, smart: AX.smart };
const CHAIN = { gold: CX.chain, silver: CX.silver, rope: CX.rope, cuban: CX.cuban, medallion: CX.medallion, pearls: CX.pearls };

/**
 * Build per-instance data for every mesh of one figure plus the LOD colors.
 * Look fields (all optional beyond the basics): see wardrobe.js for the full list (jackets, hats, glasses, jewellery...).
 * @returns {{mesh: Object<string, Float32Array>, far: Float32Array, hold: object}}
 */
export function lookData(look, dims) {
  const mesh = {};
  for (const [k, n] of Object.entries(MESH_MULT)) mesh[k] = new Float32Array(n * STRIDE);
  const put = (part, colA, colB, colC, y0, y1, pat, tat, taper = 1, mask = 0) => {
    const p = PARTS[PART[part]];
    const a = mesh[p.mesh], o = p.k * STRIDE;
    lin(colA, a, o); lin(colB, a, o + 3); lin(colC, a, o + 6);
    a[o + 9] = y0; a[o + 10] = y1; a[o + 11] = pat; a[o + 12] = tat; a[o + 13] = taper; a[o + 14] = mask;
  };
  const tp = dims.parts;
  const taper = (name) => tp[PART[name] * 7 + 6];
  const skin = look.skin;
  const tat = (name) => look.tattoos?.[name] || 0;
  const top = look.top, bot = look.bottom;
  const tc = look.topColor, tpc = look.topPatColor, tpat = look.topPattern;
  const bc = look.bottomColor, bpc = look.bottomPatColor, bpat = look.bottomPattern;
  // torso
  const shirtless = top === 'none';
  const swimTop = top === 'bikini';
  // jacket over the top (chest, abdomen, arms)
  const jk = look.jacket ? look.jacketPattern ?? PAT.leather : null;
  const jc = look.jacketColor ?? 0x1d1f24, jpc = look.jacketPatColor ?? 0xf4f4f4;
  const jOpen = jk !== null && (JACKET_OPEN.has(jk) || jk >= OPEN);
  const inner = shirtless || swimTop ? skin : tc; // seen through an open jacket
  const jC = jOpen ? inner : jpc;
  if (jk !== null) {
    // fully covered: colour B carries the print colour of open print jackets (overshirts) instead of skin
    put('chest', jc, jpc, jC, -0.01, 1.01, jk, tat('chest'), taper('chest'));
    put('abdomen', jc, jpc, jC, -0.01, 1.01, HEM + jk, tat('abdomen'), taper('abdomen'));
  } else {
    // chest
    if (shirtless) put('chest', tc, skin, tpc, NEVER, NEVER, 0, tat('chest'), taper('chest'));
    else if (swimTop) put('chest', tc, skin, tpc, 0.3, 0.68, tpat, tat('chest'), taper('chest'));
    else if (top === 'tank' || top === 'swimsuit' || top === 'dress') put('chest', tc, skin, tpc, 0.12, 1.01, tpat, tat('chest'), taper('chest'));
    else put('chest', tc, skin, top === 'suit' ? look.tieColor ?? tpc : tpc, -0.01, 1.01, tpat, tat('chest'), taper('chest'));
    // abdomen
    if (shirtless || swimTop) put('abdomen', bc, skin, bpc, bot === 'trunks' || bot === 'bikini' ? 0.82 : 0.6, 1.01, bpat, tat('abdomen'), taper('abdomen'));
    else if (top === 'crop') put('abdomen', tc, skin, tpc, -0.01, 0.38, tpat, tat('abdomen'), taper('abdomen'));
    else put('abdomen', tc, skin, top === 'suit' ? look.tieColor ?? tpc : tpc, -0.01, 1.01, tpat === PAT.collar ? 0 : tpat, tat('abdomen'), taper('abdomen'));
  }
  // pelvis
  const pelvisPat = bpat === PAT.sport || bpat === PAT.cargo || bpat === PAT.cuff ? 0 : bpat;
  put('pelvis', bc, skin, bpc, bot === 'bikini' ? 0.35 : -0.01, 1.01, pelvisPat, 0, taper('pelvis'));
  // neck
  const neckUp = top === 'turtleneck' ? 0.05 : top === 'suit' ? 0.62 : top === 'hoodie' ? 0.7 : NEVER;
  put('neck', tc, skin, tpc, neckUp, 1.01, 0, tat('neck'), taper('neck'));
  // arms
  const sleeve = { tshirt: 0.48, polo: 0.42, hawaii: 0.55, shirt: 1.01, suit: 1.01, hoodie: 1.01, crop: 0.4, longtee: 1.01, turtleneck: 1.01 }[top];
  const longSleeve = top === 'shirt' || top === 'suit' || top === 'hoodie' || top === 'longtee' || top === 'turtleneck';
  // jacket sleeves: varsity sleeves in the accent colour, track jackets with side stripes, ribbed cuffs on bombers
  const jSleeveCol = jk === PAT.varsity ? jpc : jc;
  const jSleevePat = jk === null ? 0 : jk === PAT.track ? PAT.sport : jk === PAT.djacket ? PAT.denim : jk === PAT.sequin ? PAT.sequin
    : jk >= OPEN ? jk - OPEN : 0;
  const jCuffPat = jk === PAT.bomber || jk === PAT.varsity || jk === PAT.windbreaker ? PAT.cuff : jSleevePat;
  for (const s of ['L', 'R']) {
    if (jk !== null) {
      const sc = jk === PAT.track || jk >= OPEN ? jpc : jSleeveCol === jc ? 0x1a1a1a : jc;
      put(`uArm${s}`, jSleeveCol, skin, sc, -0.01, 1.01, jSleevePat, tat(`uArm${s}`), taper(`uArm${s}`));
      put(`lArm${s}`, jSleeveCol, skin, sc, -0.01, 0.94, jCuffPat, tat(`lArm${s}`), taper(`lArm${s}`));
    } else {
      const armPat = tpat === PAT.suit || tpat === PAT.pinstripe || tpat === PAT.collar || tpat === PAT.graphic || tpat === PAT.hoodie || tpat === PAT.sunset ? 0 : tpat;
      if (sleeve) put(`uArm${s}`, tc, skin, tpc, -0.01, sleeve, armPat, tat(`uArm${s}`), taper(`uArm${s}`));
      else put(`uArm${s}`, tc, skin, tpc, NEVER, NEVER, 0, tat(`uArm${s}`), taper(`uArm${s}`));
      put(`lArm${s}`, tc, skin, tpc, longSleeve ? -0.01 : NEVER, longSleeve ? (top === 'shirt' ? 0.7 : 0.94) : NEVER, armPat, tat(`lArm${s}`), taper(`lArm${s}`));
    }
    // legs
    const legPat = bpat === PAT.cuff ? 0 : bpat;
    let u0 = -0.01, u1 = 1.01, l0 = -0.01, l1 = 1.01;
    if (bot === 'shorts') { u1 = 0.62; l0 = l1 = NEVER; }
    else if (bot === 'board') { u1 = 0.86; l0 = l1 = NEVER; }
    else if (bot === 'trunks') { u1 = 0.35; l0 = l1 = NEVER; }
    else if (bot === 'bikini' || bot === 'swimsuit') { u0 = u1 = NEVER; l0 = l1 = NEVER; }
    else if (bot === 'skirt' || bot === 'dress') { u0 = u1 = NEVER; l0 = l1 = NEVER; }
    const sh = look.shoes;
    const boots = sh === 'boots' || sh === 'chelsea' || sh === 'hightops';
    let lA = bc, lC = bpc, lPat = bpat === PAT.cargo ? 0 : bpat;
    if (bpat === PAT.cuff) lPat = PAT.cuff; // joggers: ribbed ankle cuffs
    if (look.socks && !boots) { l0 = 0.78; l1 = 1.01; lA = 0xf4f4f4; lPat = 0; }
    if (boots) {
      const bootTop = sh === 'chelsea' ? 0.72 : 0.62;
      if (l0 >= NEVER) { l0 = bootTop; l1 = 1.01; lA = look.shoeColor; lPat = 0; } // bare shins: just the boot shaft
      else { lC = look.shoeColor; lPat = PAT.boots; } // trousers tucked into the boots
    }
    put(`uLeg${s}`, bc, skin, bpc, u0, u1, legPat, tat(`uLeg${s}`), taper(`uLeg${s}`));
    put(`lLeg${s}`, lA, skin, lC, l0, l1, lPat, tat(`lLeg${s}`), taper(`lLeg${s}`));
    put(`hand${s}`, skin, skin, skin, NEVER, NEVER, 0, 0);
    const sole = look.soleColor ?? SHOE_SOLE[sh] ?? look.shoeColor;
    const open = sh === 'bare' ? NEVER : sh === 'sandals' ? 0.78 : sh === 'slides' ? 0.6 : -0.01;
    put(`foot${s}`, look.shoeColor, skin, sole, open, 1.01, sh === 'bare' ? 0 : look.shoePattern ?? PAT.sole, 0);
    // hand extras
    const item = s === 'R' ? look.handR : look.handL;
    let m = 0;
    if (item) m |= 1 << AX[item];
    if (s === 'L' && look.watch) m |= 1 << (WATCH[look.watch] ?? AX.watch);
    if (s === 'R' && look.bracelet) m |= 1 << AX.bracelet;
    if (s === 'R' && look.rings) m |= 1 << AX.rings;
    put(`handX${s}`, look.bagColor || 0xffffff, look.bagColor || 0xffffff, 0xffffff, -0.01, 1.01, 0, 0, 1, m);
  }
  put('head', skin, skin, skin, NEVER, NEVER, 0, 0);
  // head extras: hair and facial hair (headX), hats / glasses / earrings (headY)
  let st = look.hairStyle;
  const hat = look.hat || null;
  if (hat && CROWN_HATS.has(hat) && BIG_HAIR.has(st)) st = 'short';
  let hm = 0;
  if (st !== 'bald' && HX[st] !== undefined) hm |= 1 << HX[st];
  if (st === 'mohawk') hm |= 1 << HX.buzz;
  hm |= look.facial || 0;
  const fc = look.facialColor ?? look.hairColor;
  put('headX', look.hairColor, fc, mixHex(skin, fc, 0.42), -0.01, 1.01, 0, 0, 1, hm);
  let wm = 0;
  if (hat && HY[hat] !== undefined) wm |= 1 << HY[hat];
  if (hat && look.hatBand) wm |= 1 << (look.hatBand === 'gold' ? HY.bandGold : HY.bandBlack);
  const gl = look.glasses === true ? 'shades' : look.glasses;
  if (gl && HY[gl] !== undefined) wm |= 1 << HY[gl];
  const ear = look.earrings === true ? 'studs' : look.earrings;
  if (ear && HY[ear] !== undefined) wm |= 1 << HY[ear];
  put('headY', look.hatColor || 0xffffff, look.frameColor ?? 0x15151a, look.lensColor ?? 0x15181e, -0.01, 1.01, 0, 0, 1, wm);
  // chest extras
  let cm = 0;
  if (look.backpack) cm |= 1 << CX.backpack;
  if (look.fem && !shirtless) cm |= 1 << CX.bust;
  if (top === 'hoodie') cm |= 1 << CX.hood;
  const closedJacket = jk !== null && !jOpen;
  if (!closedJacket && (top === 'polo' || top === 'shirt' || top === 'suit' || top === 'hawaii')) cm |= 1 << CX.collar;
  if (look.chain) cm |= 1 << (CHAIN[look.chain] ?? CX.chain);
  if (look.chain === 'medallion') cm |= 1 << CX.chain;
  if (look.bowtie && !closedJacket) cm |= 1 << CX.bowtie;
  if (jk !== null && look.jacketCollar === 'lapels') cm |= 1 << CX.lapels;
  if (jk !== null && look.jacketCollar === 'band') cm |= 1 << CX.band;
  const bustPat = jk !== null ? jk : tpat === PAT.suit || tpat === PAT.pinstripe || tpat === PAT.graphic || tpat === PAT.hoodie ? 0 : tpat;
  if (jk !== null) put('chestX', jc, look.backpack ? look.backpackColor || 0x333333 : jpc, jC, -0.01, 1.01, bustPat, 0, 1, cm);
  else put('chestX', tc, look.backpackColor || 0x333333, tpc, swimTop ? 0.3 : -0.01, swimTop ? 0.68 : 1.01, bustPat, 0, 1, cm);
  // hip extras
  let pm = 0;
  if (bot === 'skirt' || bot === 'dress') pm |= 1 << (look.longSkirt ? PX.longskirt : PX.skirt);
  if (look.beltbag) pm |= 1 << PX.beltbag;
  if (bot === 'jeans' || bot === 'chinos' || bot === 'suit' || bot === 'cargo') pm |= 1 << PX.belt;
  put('hipX', bc, look.backpackColor || 0x333333, bpc, -0.01, 1.01, bpat === PAT.sport || bpat === PAT.cargo || bpat === PAT.cuff ? 0 : bpat, 0, 1, pm);

  // far LOD colors: top, bottom, skin, hair
  const far = new Float32Array(12);
  lin(jk !== null ? jc : shirtless ? skin : tc, far, 0);
  lin(bot === 'bikini' || bot === 'trunks' ? skin : bc, far, 3);
  lin(skin, far, 6);
  lin(hat && CROWN_HATS.has(hat) ? look.hatColor || 0xffffff : st === 'bald' ? skin : look.hairColor, far, 9);
  const hold = { bagL: look.handL === 'bag', bagR: look.handR === 'bag' || look.handR === 'briefcase', phone: look.handR === 'phone' };
  return { mesh, far, hold };
}
