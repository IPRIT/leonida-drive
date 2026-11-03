// Wardrobe: the item catalogue (all original designs: no brands, logos or real-designer patterns) and outfit
// helpers. Plain data and pure functions, Node-safe (the economy builds its price table from WARDROBE, the server
// validates outfits). The live preview lives in preview.js (createCharacterPreview), re-exported below lazily.
//
// Item: { id, slot, name, tier: 'basic'|'street'|'premium'|'luxury', value 0..1 (price inside the tier), size 0..1
//         (tattoos), colors: [hex] (first = default), starter? (free, owned from the start), code (stable wire id),
//         look: partial look fields, paint: look field(s) the chosen colour goes to }
// Outfit (serialisable): { [slot]: { id, color } } with slot = item.slot; missing slots use DEFAULT_OUTFIT.
import { PAT, OPEN, HX, TAT } from './lookcodes.js';

export const SLOTS = ['body', 'hair', 'facial', 'top', 'jacket', 'legs', 'shoes', 'hat', 'glasses', 'accessory', 'tattoo'];
// aliases used by the UI (G) and older drafts
export const SLOT_ALIAS = {
  tops: 'top', shirt: 'top', jackets: 'jacket', coat: 'jacket', pants: 'legs', bottoms: 'legs', trousers: 'legs', leg: 'legs',
  shoe: 'shoes', footwear: 'shoes', hats: 'hat', headwear: 'hat', cap: 'hat', glass: 'glasses', eyewear: 'glasses',
  accessories: 'accessory', acc: 'accessory', tattoos: 'tattoo', skin: 'body', shape: 'body', beard: 'facial', facialhair: 'facial',
  hairstyle: 'hair',
};

// ---------------- palettes (≤ 8 swatches each) ----------------
const HAIR = [0x1a120c, 0x2a1b12, 0x4e3220, 0x7a5232, 0x9a3e1c, 0xe2cf9a, 0xbdbdbd, 0xff4fa0];
const DYED = [0xff4fa0, 0x2fd6d0, 0x8b4fd8, 0x3a6bff, 0x4fd86b, 0xf2eccf, 0xff7a3d, 0xd63a5a];
const SKIN8 = [0xc68c5c, 0xf1c9a5, 0xe8b893, 0xdca47c, 0xa86f45, 0x8d5a3b, 0x6e4329, 0x432819]; // first = the protagonist
const TEE = [0xf4f4f4, 0x1d1f24, 0xff4f9a, 0x2fd6d0, 0xf5c84c, 0x6b8cff, 0x8fe38a, 0xff8a3d];
const PASTEL = [0xffd1dc, 0xb5ead7, 0xc7ceea, 0xfff1b5, 0xffdac1, 0xe2f0cb, 0xd4a5ff, 0xa8e6ff];
const NEUTRAL = [0x1d1f24, 0x2b3445, 0x3a3a3a, 0x7a7a80, 0xe6dcc6, 0xffffff, 0x5a5f4a, 0x6b4f3a];
const TROPIC = [0x14a89c, 0xff5fa2, 0x2b3445, 0xf5c84c, 0x3a6bff, 0xffffff, 0xff8a3d, 0x2f6b4f];
const DENIM = [0x3d5a80, 0x2b4466, 0x5878a0, 0x1f2c44, 0x7a90b0, 0x1d1f24];
const KHAKI = [0xd8c7a0, 0xc2ad85, 0xe6dcc6, 0x8a7a5a, 0x6b6450, 0x2b3445, 0x1d1f24, 0xf4f0e6];
const SUIT = [0x1d1f24, 0x2b3445, 0x3a3d44, 0xe8e2d4, 0x6a6f78, 0x8a6f52, 0xf2c6d6, 0x8fd6e8];
const LEATHER = [0x1a1714, 0x3a2418, 0x6b3e22, 0x8c1c2c, 0x1d2b55, 0xe8e2d4];
const CAMO = [0x5a6b3a, 0x8a7a5a, 0x6b7280, 0xc9b38a, 0x2f4f3f, 0xd06aa0];
const VIVID = [0xff4f9a, 0x2fd6d0, 0xf5c84c, 0x6b8cff, 0xff8a3d, 0x8fe38a, 0xb38cff, 0x1d1f24];
const SHOE = [0xf4f4f4, 0x1d1f24, 0xd94f4f, 0x3a6bff, 0xf5c84c, 0x2fd6d0, 0xff4f9a, 0xe6dcc6];
const BROWN = [0x3a2418, 0x6b4f3a, 0x1a1410, 0x8a6f52, 0xc2a07a, 0x2b3445];
const LENS = [0x15181e, 0x4a3214, 0x2a6bd8, 0xd8508a, 0x2fa86b, 0xf5b84c, 0x8b4fd8, 0xc0c4c8];
const CLEAR = [0xdfe6ea, 0xe8d8c0, 0xd8e8f0, 0xf0e0e8];
const GOLD = 0xd8a740, STEEL = 0x9aa0a8;

// ---------------- catalogue ----------------
let CODE = 0;
const items = [];
// I(id, slot, tier, value, name, colors, look, opts)
function I(id, slot, tier, value, name, colors, look = {}, o = {}) {
  items.push({ id, slot, name, tier, value, colors: colors || [], look, code: ++CODE, ...o });
}
const S = { starter: true };

// ---- barber: hair (colour = hair colour) ----
const hair = (id, tier, v, name, style, colors = HAIR, o = {}) => I(id, 'hair', tier, v, name, colors, { hairStyle: style }, { paint: 'hairColor', ...o });
hair('hair_curly', 'basic', 0, 'Curls', 'curly', HAIR, S);
hair('hair_bald', 'basic', 0.1, 'Clean shave', 'bald', []);
hair('hair_buzz', 'basic', 0.2, 'Buzz cut', 'buzz');
hair('hair_short', 'basic', 0.4, 'Short back and sides', 'short');
hair('hair_sidepart', 'street', 0.2, 'Side part', 'sidepart');
hair('hair_slick', 'street', 0.5, 'Slicked back', 'slick');
hair('hair_spiky', 'street', 0.4, 'Spiky', 'spiky');
hair('hair_ponytail', 'street', 0.6, 'Ponytail', 'ponytail');
hair('hair_bun', 'street', 0.7, 'Bun', 'bun');
hair('hair_bob', 'street', 0.9, 'Bob', 'bob');
hair('hair_mohawk', 'street', 0.8, 'Mohawk', 'mohawk', DYED);
hair('hair_pompadour', 'premium', 0.3, 'Pompadour', 'pompadour');
hair('hair_afro', 'premium', 0.2, 'Afro', 'afro');
hair('hair_locs', 'premium', 0.5, 'Locs', 'locs');
hair('hair_cornrows', 'premium', 0.4, 'Cornrows', 'cornrows');
hair('hair_long', 'premium', 0.6, 'Long and loose', 'long');
hair('hair_topknot', 'premium', 0.7, 'Top knot', 'topknot');
hair('hair_mullet', 'premium', 0.9, 'Mullet', 'mullet');
hair('hair_neon_spikes', 'luxury', 0.4, 'Neon spikes (salon)', 'spiky', DYED);
hair('hair_platinum_pomp', 'luxury', 0.8, 'Platinum pompadour (salon)', 'pompadour', [0xf2eccf, 0xe2cf9a, 0xbdbdbd, 0xffd1dc, 0xa8e6ff]);

// ---- barber: facial hair (colour = facial hair colour) ----
const fac = (id, tier, v, name, bits, o = {}) => I(id, 'facial', tier, v, name, bits ? HAIR.slice(0, 7) : [], { facial: bits }, { paint: 'facialColor', ...o });
const B = (...n) => n.reduce((m, k) => m | (1 << HX[k]), 0);
fac('facial_beard', 'basic', 0, 'Full beard', B('beard'), S);
fac('facial_none', 'basic', 0, 'Clean shaven', 0, S);
fac('facial_stubble', 'basic', 0.3, 'Stubble', B('stubble'));
fac('facial_mustache', 'basic', 0.5, 'Moustache', B('mustache'));
fac('facial_goatee', 'street', 0.3, 'Goatee', B('goatee'));
fac('facial_circle', 'street', 0.6, 'Circle beard', B('goatee', 'mustache'));
fac('facial_handlebar', 'street', 0.7, 'Handlebar moustache', B('handlebar'));
fac('facial_chops', 'street', 0.8, 'Sideburns', B('chops', 'stubble'));
fac('facial_chinstrap', 'premium', 0.3, 'Chin strap', B('chops', 'goatee'));
fac('facial_sculpted', 'premium', 0.6, 'Sculpted beard', B('beard', 'chops'));

// ---- tops (colour = top colour) ----
const top = (id, tier, v, name, colors, look, o = {}) => I(id, 'top', tier, v, name, colors, look, { paint: 'topColor', ...o });
top('top_hawaii', 'street', 0.4, 'Hawaiian shirt', TROPIC, { top: 'hawaii', topPattern: PAT.hawaii, topPatColor: 0xff5fa2 }, S);
top('top_tee', 'basic', 0, 'Plain tee', TEE, { top: 'tshirt', topPattern: PAT.plain }, S);
top('top_tee_stripes', 'basic', 0.3, 'Striped tee', NEUTRAL, { top: 'tshirt', topPattern: PAT.stripes, topPatColor: 0xf4f4f4 });
top('top_tee_graphic', 'basic', 0.5, 'Sunset graphic tee', TEE, { top: 'tshirt', topPattern: PAT.graphic, topPatColor: 0xff6f61 });
top('top_tee_tiedye', 'basic', 0.7, 'Tie-dye tee', VIVID, { top: 'tshirt', topPattern: PAT.tiedye, topPatColor: 0x2fd6d0 });
top('top_tee_washed', 'basic', 0.2, 'Washed tee', NEUTRAL, { top: 'tshirt', topPattern: PAT.worn });
top('top_tank', 'basic', 0.1, 'Tank top', TEE, { top: 'tank', topPattern: PAT.plain });
top('top_tank_stripes', 'basic', 0.4, 'Striped tank', VIVID, { top: 'tank', topPattern: PAT.stripes, topPatColor: 0xf4f4f4 });
top('top_jersey', 'street', 0.3, 'Mesh jersey', VIVID, { top: 'tank', topPattern: PAT.sport, topPatColor: 0xf4f4f4 });
top('top_longtee', 'basic', 0.6, 'Long-sleeve tee', TEE, { top: 'longtee', topPattern: PAT.plain });
top('top_hoodie', 'basic', 0.9, 'Hoodie', NEUTRAL.slice(0, 6).concat(VIVID.slice(0, 2)), { top: 'hoodie', topPattern: PAT.hoodie });
top('top_plaid', 'basic', 0.8, 'Plaid shirt', [0x8c1c2c, 0x2b3445, 0x2f4f3f, 0x6b4f3a, 0x1d1f24], { top: 'shirt', topPattern: PAT.plaid, topPatColor: 0x1d1f24 });
top('top_crop', 'street', 0.1, 'Crop top', PASTEL, { top: 'crop', topPattern: PAT.plain });
top('top_polo', 'street', 0.2, 'Polo', PASTEL.slice(0, 6).concat(NEUTRAL.slice(0, 2)), { top: 'polo', topPattern: PAT.collar, topPatColor: 0xf4f4f4 });
top('top_polo_stripes', 'street', 0.4, 'Striped polo', NEUTRAL, { top: 'polo', topPattern: PAT.stripes, topPatColor: 0xf4f4f4 });
top('top_flamingo', 'street', 0.6, 'Flamingo shirt', [0xa8e6ff, 0xf4f4f4, 0x14a89c, 0xfff1b5, 0x2b3445, 0xb5ead7], { top: 'hawaii', topPattern: PAT.flamingo, topPatColor: 0xff7aa8 });
top('top_palm', 'street', 0.7, 'Palm-leaf shirt', [0xf4f0e6, 0xfff1b5, 0x1d1f24, 0xffd1dc, 0x2b3445, 0xa8e6ff], { top: 'hawaii', topPattern: PAT.palm, topPatColor: 0x2f8a4f });
top('top_gingham', 'street', 0.5, 'Gingham shirt', [0x3a6bff, 0xd94f4f, 0x2f6b4f, 0x1d1f24, 0xff4f9a], { top: 'hawaii', topPattern: PAT.gingham, topPatColor: 0xf4f4f4 });
top('top_camo_tee', 'street', 0.8, 'Camo tee', CAMO, { top: 'tshirt', topPattern: PAT.camo, topPatColor: 0x2f3a24 });
top('top_camo_hoodie', 'street', 0.9, 'Camo hoodie', CAMO, { top: 'hoodie', topPattern: PAT.camo, topPatColor: 0x2f3a24 });
top('top_sunset', 'premium', 0.5, 'Retro sunset tee', [0xff6f61, 0xff4f9a, 0x8b4fd8, 0x2fd6d0, 0xf5c84c], { top: 'tshirt', topPattern: PAT.sunset, topPatColor: 0xf5c84c });
top('top_leopard', 'premium', 0.2, 'Leopard-print shirt', [0xd8a75a, 0xe8d8c0, 0x1d1f24, 0xff4f9a], { top: 'hawaii', topPattern: PAT.leopard, topPatColor: 0x2a1a10 });
top('top_linen', 'premium', 0.1, 'Linen shirt', PASTEL.slice(0, 4).concat([0xf4f0e6, 0x2b3445]), { top: 'shirt', topPattern: PAT.collar, topPatColor: 0xf4f4f4 });
top('top_shirt_stripes', 'premium', 0.3, 'Striped dress shirt', [0xa8e6ff, 0xffd1dc, 0xf4f4f4, 0xc7ceea], { top: 'shirt', topPattern: PAT.stripes, topPatColor: 0x2b3445 });
top('top_turtleneck', 'premium', 0.4, 'Turtleneck', NEUTRAL, { top: 'turtleneck', topPattern: PAT.plain });
top('top_suit', 'premium', 0.7, 'Two-piece suit', SUIT, { top: 'suit', topPattern: PAT.suit, tieColor: 0x8c1c2c, bottom: 'suit' });
top('top_suit_pin', 'luxury', 0.2, 'Pinstripe suit', [0x1d1f24, 0x2b3445, 0x3a3d44, 0x4a3a2a], { top: 'suit', topPattern: PAT.pinstripe, tieColor: 0x1d1f24, bottom: 'suit' });
top('top_suit_white', 'luxury', 0.5, 'White summer suit', [0xf4f0e6, 0xffd1dc, 0xa8e6ff, 0xb5ead7], { top: 'suit', topPattern: PAT.suit, tieColor: 0xededed, bottom: 'suit' });
top('top_tux', 'luxury', 0.7, 'Tuxedo', [0x101012, 0x1d2b55, 0x6a1020, 0xf4f0e6], { top: 'suit', topPattern: PAT.suit, tieColor: 0xededed, bowtie: true, bottom: 'suit' });
top('top_sequin', 'luxury', 0.9, 'Sequin shirt', [0xd8a740, 0xc0c4c8, 0xff4f9a, 0x2fd6d0, 0x1d1f24, 0x8b4fd8], { top: 'shirt', topPattern: PAT.sequin });
top('top_shirtless', 'basic', 0, 'No shirt', [], { top: 'none', topPattern: PAT.plain }, { starter: true });

// ---- jackets over the top (colour = jacket colour) ----
const jak = (id, tier, v, name, colors, look, o = {}) => I(id, 'jacket', tier, v, name, colors, { jacket: true, ...look }, { paint: 'jacketColor', ...o });
I('jacket_none', 'jacket', 'basic', 0, 'No jacket', [], { jacket: null }, S);
jak('jacket_denim', 'street', 0.4, 'Denim jacket', DENIM, { jacketPattern: PAT.djacket, jacketCollar: 'lapels' });
jak('jacket_bomber', 'street', 0.6, 'Bomber jacket', [0x2f4f3f, 0x1d1f24, 0x2b3445, 0x8c1c2c, 0xc2ad85, 0xff8a3d], { jacketPattern: PAT.bomber, jacketCollar: 'band' });
jak('jacket_track', 'street', 0.3, 'Track jacket', VIVID, { jacketPattern: PAT.track, jacketPatColor: 0xf4f4f4, jacketCollar: 'band' });
jak('jacket_windbreaker', 'street', 0.5, 'Windbreaker', [0x8b4fd8, 0x2fd6d0, 0xff4f9a, 0x3a6bff, 0xf5c84c, 0x1d1f24], { jacketPattern: PAT.windbreaker, jacketPatColor: 0xf4f4f4, jacketCollar: 'band' });
jak('jacket_overshirt', 'street', 0.7, 'Open Hawaiian overshirt', TROPIC, { jacketPattern: OPEN + PAT.hawaii, jacketPatColor: 0xff5fa2 });
jak('jacket_flamingo', 'street', 0.8, 'Flamingo overshirt', [0xa8e6ff, 0xf4f4f4, 0x14a89c, 0xfff1b5, 0x2b3445], { jacketPattern: OPEN + PAT.flamingo, jacketPatColor: 0xff7aa8 });
jak('jacket_varsity', 'premium', 0.2, 'Varsity jacket', [0x8c1c2c, 0x1d2b55, 0x2f4f3f, 0x1d1f24, 0x8b4fd8], { jacketPattern: PAT.varsity, jacketPatColor: 0xf2ead8, jacketCollar: 'band' });
jak('jacket_palm', 'premium', 0.1, 'Palm-leaf overshirt', [0xf4f0e6, 0x1d1f24, 0xfff1b5, 0x2b3445], { jacketPattern: OPEN + PAT.palm, jacketPatColor: 0x2f8a4f });
jak('jacket_suede', 'premium', 0.3, 'Suede jacket', [0x8a6f52, 0xc2a07a, 0x6b4f3a, 0x3a2418], { jacketPattern: PAT.djacket, jacketCollar: 'lapels' });
jak('jacket_leather', 'premium', 0.5, 'Leather biker jacket', LEATHER, { jacketPattern: PAT.leather, jacketCollar: 'lapels' });
jak('jacket_camo', 'premium', 0.6, 'Camo bomber', CAMO, { jacketPattern: PAT.bomber, jacketCollar: 'band' });
jak('jacket_blazer', 'premium', 0.7, 'Blazer', SUIT, { jacketPattern: PAT.blazer, jacketCollar: 'lapels' });
jak('jacket_sequin', 'luxury', 0.6, 'Sequin blazer', [0xd8a740, 0xc0c4c8, 0xff4f9a, 0x1d1f24, 0x8b4fd8], { jacketPattern: OPEN + PAT.sequin, jacketCollar: 'lapels' });
jak('jacket_gold_leather', 'luxury', 0.9, 'Gold leather jacket', [0xc9a35f, 0xd8a740, 0xe8e2d4, 0x1a1714], { jacketPattern: PAT.leather, jacketCollar: 'lapels' });

// ---- legs (colour = trousers / shorts colour) ----
const leg = (id, tier, v, name, colors, look, o = {}) => I(id, 'legs', tier, v, name, colors, look, { paint: 'bottomColor', ...o });
leg('legs_chinos', 'basic', 0, 'Chinos', KHAKI, { bottom: 'chinos', bottomPattern: PAT.plain }, S);
leg('legs_jeans', 'basic', 0.2, 'Jeans', DENIM, { bottom: 'jeans', bottomPattern: PAT.denim });
leg('legs_jeans_ripped', 'street', 0.3, 'Ripped jeans', DENIM, { bottom: 'jeans', bottomPattern: PAT.worn });
leg('legs_shorts', 'basic', 0.1, 'Shorts', KHAKI.concat(DENIM.slice(0, 2)).slice(0, 8), { bottom: 'shorts', bottomPattern: PAT.plain });
leg('legs_board', 'basic', 0.4, 'Board shorts', TROPIC, { bottom: 'board', bottomPattern: PAT.hawaii, bottomPatColor: 0xffffff });
leg('legs_board_palm', 'street', 0.2, 'Palm board shorts', [0xf4f0e6, 0x1d1f24, 0x2fd6d0, 0xff4f9a], { bottom: 'board', bottomPattern: PAT.palm, bottomPatColor: 0x2f8a4f });
leg('legs_cargo', 'street', 0.4, 'Cargo pants', [0x5a5f4a, 0x8a7a5a, 0x1d1f24, 0x6b6450, 0xc2ad85], { bottom: 'cargo', bottomPattern: PAT.cargo });
leg('legs_cargo_shorts', 'basic', 0.7, 'Cargo shorts', [0x5a5f4a, 0x8a7a5a, 0xc2ad85, 0x1d1f24], { bottom: 'shorts', bottomPattern: PAT.cargo });
leg('legs_track', 'basic', 0.6, 'Track pants', NEUTRAL.slice(0, 4).concat([0x8c1c2c, 0x1d2b55]), { bottom: 'track', bottomPattern: PAT.sport, bottomPatColor: 0xf4f4f4 });
leg('legs_joggers', 'street', 0.1, 'Joggers', NEUTRAL.slice(0, 4).concat(PASTEL.slice(0, 3)), { bottom: 'track', bottomPattern: PAT.cuff });
leg('legs_camo', 'street', 0.6, 'Camo pants', CAMO, { bottom: 'cargo', bottomPattern: PAT.camo, bottomPatColor: 0x2f3a24 });
leg('legs_suit', 'premium', 0.2, 'Suit trousers', SUIT, { bottom: 'suit', bottomPattern: PAT.plain });
leg('legs_pinstripe', 'premium', 0.6, 'Pinstripe trousers', [0x1d1f24, 0x2b3445, 0x3a3d44], { bottom: 'suit', bottomPattern: PAT.stripes, bottomPatColor: 0x5a5f6a });
leg('legs_linen', 'premium', 0.4, 'Linen trousers', [0xf4f0e6, 0xe6dcc6, 0xffd1dc, 0xa8e6ff], { bottom: 'chinos', bottomPattern: PAT.plain });
leg('legs_leather', 'premium', 0.8, 'Leather trousers', LEATHER.slice(0, 4), { bottom: 'jeans', bottomPattern: PAT.denim });
leg('legs_trunks', 'basic', 0.2, 'Swim trunks', VIVID, { bottom: 'trunks', bottomPattern: PAT.plain });
leg('legs_trunks_stripes', 'basic', 0.5, 'Striped swim trunks', VIVID, { bottom: 'trunks', bottomPattern: PAT.stripes, bottomPatColor: 0xf4f4f4 });
leg('legs_skirt', 'street', 0.3, 'Skirt', PASTEL.concat(NEUTRAL.slice(0, 2)).slice(0, 8), { bottom: 'skirt', bottomPattern: PAT.plain, longSkirt: false });
leg('legs_skirt_plaid', 'street', 0.5, 'Plaid skirt', [0x8c1c2c, 0x2b3445, 0x2f4f3f, 0x1d1f24], { bottom: 'skirt', bottomPattern: PAT.plaid, bottomPatColor: 0x1d1f24, longSkirt: false });
leg('legs_maxi', 'premium', 0.3, 'Maxi skirt', PASTEL.concat(TROPIC.slice(0, 2)).slice(0, 8), { bottom: 'skirt', bottomPattern: PAT.plain, longSkirt: true });
leg('legs_sequin', 'luxury', 0.5, 'Sequin trousers', [0xd8a740, 0xc0c4c8, 0x1d1f24, 0xff4f9a], { bottom: 'suit', bottomPattern: PAT.sequin });
leg('legs_gold_stripe', 'luxury', 0.8, 'Gold-stripe trousers', [0x1d1f24, 0x2b3445, 0xf4f0e6], { bottom: 'track', bottomPattern: PAT.sport, bottomPatColor: GOLD });

// ---- shoes (colour = shoe colour) ----
const shoe = (id, tier, v, name, colors, look, o = {}) => I(id, 'shoes', tier, v, name, colors, look, { paint: 'shoeColor', ...o });
shoe('shoes_sneakers', 'basic', 0, 'Sneakers', SHOE, { shoes: 'sneakers' }, S);
shoe('shoes_bare', 'basic', 0, 'Barefoot', [], { shoes: 'bare' }, S);
shoe('shoes_canvas', 'basic', 0.4, 'Canvas shoes', [0xd94f4f, 0x1d1f24, 0x3a6bff, 0xf5c84c, 0x2f4f3f, 0xffd1dc], { shoes: 'sneakers', soleColor: 0xf2ead8 });
shoe('shoes_flipflops', 'basic', 0.1, 'Flip-flops', VIVID, { shoes: 'sandals' });
shoe('shoes_slides', 'basic', 0.3, 'Slides', [0x1d1f24, 0xf4f4f4, 0xff4f9a, 0x2fd6d0], { shoes: 'slides', soleColor: 0x1d1f24 });
shoe('shoes_runners', 'street', 0.2, 'Runners', SHOE, { shoes: 'sneakers', soleColor: 0xff4f9a });
shoe('shoes_hightops', 'street', 0.4, 'High-tops', SHOE, { shoes: 'hightops' });
shoe('shoes_boots', 'street', 0.6, 'Work boots', [0x8a6f52, 0x3a2418, 0x1a1410, 0x5a5f4a], { shoes: 'boots' });
shoe('shoes_chelsea', 'premium', 0.2, 'Chelsea boots', BROWN, { shoes: 'chelsea' });
shoe('shoes_loafers', 'premium', 0.4, 'Loafers', BROWN, { shoes: 'loafers' });
shoe('shoes_dress', 'premium', 0.6, 'Dress shoes', [0x1a1410, 0x3a2418, 0x6b4f3a], { shoes: 'formal' });
shoe('shoes_white_loafers', 'luxury', 0.2, 'White loafers', [0xf4f0e6, 0xe8e2d4, 0xffd1dc], { shoes: 'loafers', soleColor: 0xc2a07a });
shoe('shoes_gold', 'luxury', 0.6, 'Gold sneakers', [GOLD, 0xc0c4c8, 0xffd1dc], { shoes: 'sneakers', soleColor: 0xf4f4f4 });

// ---- hats (colour = hat colour) ----
const hat = (id, tier, v, name, colors, look, o = {}) => I(id, 'hat', tier, v, name, colors, look, { paint: 'hatColor', ...o });
I('hat_none', 'hat', 'basic', 0, 'No hat', [], { hat: null, hatBand: null }, S);
hat('hat_cap', 'basic', 0.2, 'Cap', VIVID, { hat: 'cap' });
hat('hat_cap_back', 'basic', 0.4, 'Backwards cap', VIVID, { hat: 'capback' });
hat('hat_trucker', 'basic', 0.6, 'Trucker cap', VIVID, { hat: 'trucker' });
hat('hat_beanie', 'basic', 0.8, 'Beanie', NEUTRAL.slice(0, 4).concat(VIVID.slice(0, 4)), { hat: 'beanie' });
hat('hat_visor', 'basic', 0.5, 'Sun visor', [0xf4f4f4, 0xff4f9a, 0x2fd6d0, 0xf5c84c, 0x1d1f24], { hat: 'visor' });
hat('hat_bucket', 'street', 0.4, 'Bucket hat', [0xe6dcc6, 0x1d1f24, 0xff4f9a, 0x2fd6d0, 0x5a6b3a, 0xf5c84c], { hat: 'bucket' });
hat('hat_sunhat', 'street', 0.2, 'Sun hat', [0xf2e2b8, 0xf4f4f4, 0xffd1dc, 0x1d1f24], { hat: 'sunhat' });
hat('hat_beret', 'street', 0.7, 'Beret', [0x1d1f24, 0x8c1c2c, 0x2b3445, 0xff4f9a], { hat: 'beret' });
hat('hat_fedora', 'premium', 0.4, 'Fedora', [0x2b3445, 0x1d1f24, 0x6b4f3a, 0x7a7a80, 0xe6dcc6], { hat: 'fedora', hatBand: 'black' });
hat('hat_panama', 'premium', 0.8, 'Panama hat', [0xf2e2b8, 0xf4f0e6, 0xe8d8c0], { hat: 'fedora', hatBand: 'black' });
hat('hat_wide', 'premium', 0.6, 'Wide-brim hat', [0x8a6f52, 0x3a2418, 0xf2e2b8, 0x1d1f24, 0xf4f4f4], { hat: 'cowboy' });
hat('hat_gold_fedora', 'luxury', 0.3, 'Gold-band fedora', [0xf4f0e6, 0x1d1f24, 0x2b3445, 0x8c1c2c], { hat: 'fedora', hatBand: 'gold' });

// ---- glasses (colour = lens tint; frame colour per item) ----
const gl = (id, tier, v, name, style, frame, colors = LENS, o = {}) => I(id, 'glasses', tier, v, name, colors, { glasses: style, frameColor: frame }, { paint: 'lensColor', ...o });
I('glasses_none', 'glasses', 'basic', 0, 'No glasses', [], { glasses: false }, S);
gl('glasses_shades', 'basic', 0.3, 'Classic shades', 'shades', 0x15151a);
gl('glasses_round', 'basic', 0.6, 'Round shades', 'round', 0x3a2418);
gl('glasses_clear', 'basic', 0.8, 'Clear frames', 'clear', 0x1d1f24, CLEAR);
gl('glasses_aviator', 'street', 0.4, 'Aviators', 'aviator', STEEL);
gl('glasses_cateye', 'street', 0.6, 'Cat-eye shades', 'cateye', 0xff4f9a);
gl('glasses_shield', 'street', 0.8, 'Sport shield', 'shield', 0xf4f4f4);
gl('glasses_browline', 'premium', 0.4, 'Browline frames', 'browline', 0x2a1a10, CLEAR.concat(LENS.slice(0, 2)));
gl('glasses_mirror', 'premium', 0.7, 'Mirror shield', 'shield', 0x15151a, [0x2a6bd8, 0xf5b84c, 0xd8508a, 0x2fa86b, 0x8b4fd8]);
gl('glasses_gold', 'luxury', 0.3, 'Gold aviators', 'aviator', GOLD);
gl('glasses_gold_round', 'luxury', 0.8, 'Gold round frames', 'round', GOLD);

// ---- accessories (jewellery and bags; metals are fixed, bags take the colour) ----
const acc = (id, tier, v, name, look, colors = [], o = {}) => I(id, 'accessory', tier, v, name, colors, {
  chain: false, watch: false, bracelet: false, rings: false, earrings: false, backpack: false, beltbag: false, ...look,
}, o);
acc('acc_chain_watch', 'premium', 0.3, 'Gold chain and steel watch', { chain: 'gold', watch: 'steel' }, [], S);
acc('acc_none', 'basic', 0, 'No accessories', {}, [], S);
acc('acc_watch_digital', 'basic', 0.3, 'Digital watch', { watch: 'digital' });
acc('acc_studs', 'basic', 0.5, 'Stud earrings', { earrings: 'studs' });
acc('acc_backpack', 'basic', 0.4, 'Backpack', { backpack: true }, VIVID.concat(NEUTRAL.slice(0, 2)).slice(0, 8), { paint: 'backpackColor' });
acc('acc_beltbag', 'basic', 0.6, 'Belt bag', { beltbag: true }, VIVID, { paint: 'backpackColor' });
acc('acc_watch_steel', 'street', 0.2, 'Steel watch', { watch: 'steel' });
acc('acc_hoops', 'street', 0.3, 'Hoop earrings', { earrings: 'hoops' });
acc('acc_chain_silver', 'street', 0.4, 'Silver chain', { chain: 'silver' });
acc('acc_smartwatch', 'street', 0.6, 'Smartwatch', { watch: 'smart' });
acc('acc_bracelet', 'street', 0.8, 'Gold bracelet', { bracelet: true });
acc('acc_chain_gold', 'premium', 0.2, 'Gold chain', { chain: 'gold' });
acc('acc_rings', 'premium', 0.3, 'Gold rings', { rings: true });
acc('acc_rope', 'premium', 0.5, 'Rope chain', { chain: 'rope' });
acc('acc_pearls', 'premium', 0.6, 'Pearl necklace', { chain: 'pearls' });
acc('acc_medallion', 'premium', 0.7, 'Medallion', { chain: 'medallion' });
acc('acc_set_street', 'premium', 0.9, 'Street set: chain, watch and studs', { chain: 'silver', watch: 'smart', earrings: 'studs' });
acc('acc_watch_gold', 'luxury', 0.1, 'Gold watch', { watch: 'gold' });
acc('acc_cuban', 'luxury', 0.2, 'Cuban link chain', { chain: 'cuban' });
acc('acc_diamond_studs', 'luxury', 0.4, 'Diamond studs', { earrings: 'diamonds' });
acc('acc_watch_diamond', 'luxury', 0.9, 'Diamond watch', { watch: 'diamond' });
acc('acc_set_drip', 'luxury', 1, 'Full drip: cuban, diamond watch, bracelet and rings', { chain: 'cuban', watch: 'diamond', bracelet: true, rings: true, earrings: 'diamonds' });

// ---- tattoos (procedural original designs; placements on body parts; code = style + seed) ----
const tat = (id, tier, size, name, tattoos, o = {}) => I(id, 'tattoo', tier, size, name, [], { tattoos }, { size, ...o });
tat('tat_tribal_rose', 'street', 0.4, 'Tribal band and rose', { lArmR: TAT.tribal + 0.37, uArmL: TAT.rose + 0.62 }, S);
tat('tat_none', 'basic', 0, 'No tattoos', {}, S);
tat('tat_star', 'street', 0.05, 'Forearm star', { lArmL: TAT.star + 0.31 });
tat('tat_script', 'street', 0.1, 'Forearm script', { lArmR: TAT.script + 0.52 });
tat('tat_heart', 'street', 0.2, 'Heart and banner', { uArmR: TAT.heart + 0.45 });
tat('tat_palm', 'street', 0.25, 'Palm tree', { lArmL: TAT.palm + 0.4 });
tat('tat_rose', 'street', 0.3, 'Rose', { uArmL: TAT.rose + 0.4 });
tat('tat_neck', 'premium', 0.35, 'Neck script', { neck: TAT.script + 0.12 });
tat('tat_sun', 'premium', 0.45, 'Sun on the chest', { chest: TAT.sun + 0.471 });
tat('tat_geo', 'premium', 0.5, 'Geometric band (leg)', { lLegR: TAT.geo + 0.4 });
tat('tat_snake', 'premium', 0.55, 'Snake arm', { lArmR: TAT.snake + 0.3, uArmR: TAT.snake + 0.8 });
tat('tat_waves', 'premium', 0.6, 'Wave sleeve', { uArmL: TAT.waves + 0.2, lArmL: TAT.waves + 0.6 });
tat('tat_sleeve_l', 'premium', 0.75, 'Left sleeve', { uArmL: TAT.sleeve + 0.3, lArmL: TAT.sleeve + 0.7 });
tat('tat_sleeve_r', 'premium', 0.75, 'Right sleeve', { uArmR: TAT.sleeve + 0.4, lArmR: TAT.sleeve + 0.8 });
tat('tat_sleeves', 'luxury', 0.9, 'Both sleeves', { uArmL: TAT.sleeve + 0.3, lArmL: TAT.sleeve + 0.7, uArmR: TAT.sleeve + 0.4, lArmR: TAT.sleeve + 0.8 });
tat('tat_back_wings', 'luxury', 1, 'Back piece: wings', { chest: TAT.wings + 0.5 });
tat('tat_back_sun', 'luxury', 0.95, 'Back piece: sunburst', { chest: TAT.burst + 0.5, neck: TAT.star + 0.9 });

// ---- body ("plastic surgeon"; colour = skin tone) ----
const body = (id, name, look, o = {}) => I(id, 'body', 'premium', 0.5, name, SKIN8, look, { paint: 'skin', ...o });
body('body_athletic', 'Athletic', { build: 'athletic', fem: 0, h: 1.8 }, S);
body('body_average', 'Average', { build: 'average', fem: 0, h: 1.77 });
body('body_lean', 'Lean', { build: 'thin', fem: 0, h: 1.79 });
body('body_heavy', 'Heavy', { build: 'heavy', fem: 0, h: 1.78 });
body('body_tall', 'Tall and athletic', { build: 'athletic', fem: 0, h: 1.93 });
body('body_short', 'Short and stocky', { build: 'heavy', fem: 0, h: 1.66 });
body('body_senior', 'Silver fox', { build: 'elderly', fem: 0, h: 1.76 });
body('body_fem_athletic', 'Athletic (feminine)', { build: 'athletic', fem: 1, h: 1.72 });
body('body_fem_average', 'Average (feminine)', { build: 'average', fem: 1, h: 1.67 });
body('body_fem_curvy', 'Curvy (feminine)', { build: 'heavy', fem: 1, h: 1.66 });
body('body_fem_tall', 'Tall (feminine)', { build: 'thin', fem: 1, h: 1.82 });

export const WARDROBE = items;
export const WARDROBE_BY_ID = new Map(items.map((it) => [it.id, it]));
const BY_CODE = new Map(items.map((it) => [it.code, it]));
export const wardrobeItem = (id) => WARDROBE_BY_ID.get(id) || null;

// the protagonist (looks.js playerLook()): every item here is a starter
export const DEFAULT_OUTFIT = Object.freeze({
  body: { id: 'body_athletic', color: 0xc68c5c },
  hair: { id: 'hair_curly', color: 0x1a120c },
  facial: { id: 'facial_beard', color: 0x1a120c },
  top: { id: 'top_hawaii', color: 0x14a89c },
  jacket: { id: 'jacket_none', color: null },
  legs: { id: 'legs_chinos', color: 0xd8c7a0 },
  shoes: { id: 'shoes_sneakers', color: 0xf4f4f4 },
  hat: { id: 'hat_none', color: null },
  glasses: { id: 'glasses_none', color: null },
  accessory: { id: 'acc_chain_watch', color: null },
  tattoo: { id: 'tat_tribal_rose', color: null },
});

const toNum = (c) => (typeof c === 'number' ? c : typeof c === 'string' && c ? parseInt(c.replace('#', ''), 16) : null);

/**
 * Canonical outfit { slot: { id, color } } from any accepted shape:
 *   { tops: { id, color } } (UI keys, aliases ok), { top: 'itemId', colors: { itemId: hex } } (economy),
 *   ['itemId', ...] / codes from decodeOutfit, values 'itemId' or { id, color }. Unknown ids are dropped; the slot
 *   comes from the item, so keys may be anything. null for a slot = take it off (the slot's "none" item).
 */
export function normalizeOutfit(input, base = DEFAULT_OUTFIT) {
  const out = {};
  for (const s of SLOTS) out[s] = base?.[s] ? { id: base[s].id, color: base[s].color ?? null } : null;
  if (!input) return out;
  const colors = input.colors && typeof input.colors === 'object' ? input.colors : null;
  const put = (key, v) => {
    if (v === null) { // take it off
      const s = SLOT_ALIAS[key] || key;
      const none = NONE[s];
      if (none) out[s] = { id: none, color: null };
      return;
    }
    const id = typeof v === 'string' ? v : v?.id;
    const it = id && WARDROBE_BY_ID.get(id);
    if (!it) return;
    let c = toNum(typeof v === 'object' ? v.color : null) ?? toNum(colors?.[id]);
    if (c === null || c === undefined || Number.isNaN(c)) c = it.colors[0] ?? null;
    out[it.slot] = { id, color: c };
  };
  if (Array.isArray(input)) for (const v of input) put('', v);
  else for (const [k, v] of Object.entries(input)) if (k !== 'colors') put(k, v);
  return out;
}
const NONE = { jacket: 'jacket_none', hat: 'hat_none', glasses: 'glasses_none', accessory: 'acc_none', tattoo: 'tat_none', facial: 'facial_none', shoes: 'shoes_bare', top: 'top_shirtless', hair: 'hair_bald' };

// look fields every outfit starts from (looks.js lookData reads these)
const BASE_LOOK = {
  build: 'athletic', fem: 0, h: 1.8, seed: 7, wealth: 0.6, beach: false, skin: 0xc68c5c,
  hairStyle: 'curly', hairColor: 0x1a120c, facial: 0, facialColor: 0x1a120c,
  top: 'tshirt', topColor: 0xf4f4f4, topPattern: PAT.plain, topPatColor: 0xffffff, tieColor: null, bowtie: false,
  jacket: null, jacketPattern: null, jacketColor: 0x1d1f24, jacketPatColor: 0xf4f4f4, jacketCollar: null,
  bottom: 'chinos', bottomColor: 0xd8c7a0, bottomPattern: PAT.plain, bottomPatColor: 0xffffff, longSkirt: false,
  shoes: 'sneakers', shoeColor: 0xf4f4f4, soleColor: null, socks: false,
  hat: null, hatColor: 0xffffff, hatBand: null, glasses: false, frameColor: 0x15151a, lensColor: 0x15181e,
  earrings: false, chain: false, watch: false, bracelet: false, rings: false, backpack: false, beltbag: false,
  handR: null, handL: null, bagColor: 0, backpackColor: 0x2b3445, tattoos: {},
};

/** Look (looks.js format) of an outfit. Pure; cheap enough to call on every change (not per frame). */
export function outfitToLook(outfit, opts = {}) {
  const o = normalizeOutfit(outfit);
  const look = { ...BASE_LOOK, tattoos: {} };
  for (const s of SLOTS) {
    const sel = o[s];
    const it = sel && WARDROBE_BY_ID.get(sel.id);
    if (!it) continue;
    for (const [k, v] of Object.entries(it.look)) look[k] = k === 'tattoos' ? { ...v } : v;
    if (it.paint && sel.color !== null && sel.color !== undefined) for (const f of [].concat(it.paint)) look[f] = sel.color;
  }
  // a suit comes with matching trousers, unless legs other than the default chinos were chosen
  const topIt = WARDROBE_BY_ID.get(o.top?.id);
  if (topIt?.look.bottom === 'suit' && o.legs?.id === DEFAULT_OUTFIT.legs.id) {
    look.bottom = 'suit'; look.bottomPattern = topIt.look.topPattern === PAT.pinstripe ? PAT.stripes : PAT.plain;
    look.bottomPatColor = 0x5a5f6a; look.bottomColor = o.top.color ?? topIt.colors[0];
  }
  if (opts.seed !== undefined) look.seed = opts.seed;
  return look;
}
/** Compact wire form: one u16 per slot = item.code * 16 + colour index in item.colors (15 = default). */
export function encodeOutfit(outfit) {
  const o = normalizeOutfit(outfit);
  const out = [];
  for (const s of SLOTS) {
    const it = o[s] && WARDROBE_BY_ID.get(o[s].id);
    if (!it) continue;
    const ci = it.colors.indexOf(o[s].color);
    out.push(it.code * 16 + (ci >= 0 && ci < 15 ? ci : 15));
  }
  return out;
}
/** Inverse of encodeOutfit (unknown codes are skipped). */
export function decodeOutfit(codes) {
  const out = {};
  for (const c of codes || []) {
    const it = BY_CODE.get(c >> 4);
    if (!it) continue;
    const ci = c & 15;
    out[it.slot] = { id: it.id, color: ci < 15 ? it.colors[ci] ?? null : null };
  }
  return normalizeOutfit(out);
}

/** Stable string key of an outfit (cache keys, change detection). */
export const outfitKey = (outfit) => encodeOutfit(outfit).join('.');

// live preview for the menu (G): lazily loaded, so this module stays Node-safe
export function createCharacterPreview(game, el, opts) {
  let impl = null, disposed = false;
  const pending = { outfit: null, yaw: null, view: null };
  import('./preview.js').then((m) => {
    if (disposed) return;
    impl = m.createCharacterPreview(game, el, opts);
    if (pending.outfit) impl.setOutfit(pending.outfit);
    if (pending.yaw !== null) impl.rotate(pending.yaw);
    if (pending.view) impl.setView(pending.view);
  }).catch((e) => console.warn('[wardrobe] preview failed to load', e));
  return {
    setOutfit(o) { if (impl) impl.setOutfit(o); else pending.outfit = o; },
    rotate(y) { if (impl) impl.rotate(y); else pending.yaw = y; },
    setView(v) { if (impl) impl.setView(v); else pending.view = v; },
    zoom(v) { this.setView(v); },
    dispose() { disposed = true; impl?.dispose(); impl = null; },
  };
}
