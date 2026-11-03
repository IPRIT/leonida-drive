// Headless wardrobe checks: node src/characters/test/wardrobe.test.mjs
import * as THREE from 'three';
import { WARDROBE, DEFAULT_OUTFIT, SLOTS, outfitToLook, normalizeOutfit, encodeOutfit, decodeOutfit, outfitKey } from '../wardrobe.js';
import { playerLook, lookData, makeLook, rng } from '../looks.js';
import { makeDims } from '../rig.js';
import { HumanBatch } from '../HumanBatch.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

const ids = new Set(WARDROBE.map((it) => it.id)), codes = new Set(WARDROBE.map((it) => it.code));
ok(WARDROBE.length >= 150, `${WARDROBE.length} items`);
ok(ids.size === WARDROBE.length && codes.size === WARDROBE.length, 'ids and wire codes are unique');
ok(WARDROBE.every((it) => SLOTS.includes(it.slot) && ['basic', 'street', 'premium', 'luxury'].includes(it.tier)), 'every item has a known slot and tier');
ok(WARDROBE.every((it) => it.colors.length <= 8 && it.colors.every((c) => Number.isInteger(c) && c >= 0 && c <= 0xffffff)), 'palettes: at most 8 hex colours');
ok(SLOTS.every((s) => WARDROBE.some((it) => it.slot === s && it.starter)), 'every slot has a free starter item');
ok(Object.values(DEFAULT_OUTFIT).every((sel) => WARDROBE.find((it) => it.id === sel.id)?.starter), 'the default outfit is all starter items');
// an economy outfit carries colours only for bought / dyed items: the defaults must be each item's first swatch
ok(Object.values(DEFAULT_OUTFIT).every((sel) => (WARDROBE.find((it) => it.id === sel.id).colors[0] ?? null) === (sel.color ?? null)), 'default outfit colours = first palette colours');
{
  const eco = { body: 'body_athletic', top: 'top_hawaii', glasses: 'glasses_aviator', jacket: 'jacket_leather', colors: { glasses_aviator: 0x2a6bd8 } };
  const n2 = normalizeOutfit(eco);
  ok(n2.body.color === DEFAULT_OUTFIT.body.color && n2.glasses.color === 0x2a6bd8 && n2.jacket.id === 'jacket_leather', 'economy outfit { slot: id, colors } → canonical, default colours kept');
}
const look = outfitToLook(DEFAULT_OUTFIT), pl = playerLook();
const same = ['build', 'fem', 'h', 'skin', 'hairStyle', 'hairColor', 'facial', 'facialColor', 'top', 'topColor', 'topPattern', 'topPatColor', 'bottom', 'bottomColor', 'shoes', 'shoeColor', 'hat']
  .every((k) => JSON.stringify(look[k]) === JSON.stringify(pl[k])) && JSON.stringify(look.tattoos) === JSON.stringify(pl.tattoos) && !!look.chain && !!look.watch && !look.glasses;
ok(same, 'default outfit = the protagonist look');
const ui = { tops: { id: 'jacket_leather', color: 0x3a2418 }, hats: { id: 'hat_fedora', color: '#2b3445' }, top: 'top_flamingo', colors: { top_flamingo: 0xa8e6ff }, glasses: null };
const n = normalizeOutfit(ui);
ok(n.jacket.id === 'jacket_leather' && n.hat.color === 0x2b3445 && n.top.color === 0xa8e6ff && n.glasses.id === 'glasses_none', 'normalize: UI keys, economy colours, take-off');
ok(JSON.stringify(decodeOutfit(encodeOutfit(n))) === JSON.stringify(n) && encodeOutfit(n).length <= 12 && encodeOutfit(n).every((c) => c < 65536), 'wire form round trip (u16, ≤ 12 values)');
ok(outfitKey(n) !== outfitKey(DEFAULT_OUTFIT), 'outfit key changes with the outfit');
const suit = outfitToLook({ top: { id: 'top_suit', color: 0x2b3445 } });
ok(suit.bottom === 'suit' && suit.bottomColor === 0x2b3445, 'a suit comes with matching trousers');
let bad = 0;
for (const it of WARDROBE) {
  for (const c of it.colors.length ? it.colors : [null]) {
    const lk = outfitToLook({ [it.slot]: { id: it.id, color: c } });
    const d = lookData(lk, makeDims(lk));
    for (const a of Object.values(d.mesh)) for (const v of a) if (!Number.isFinite(v)) bad++;
  }
}
ok(bad === 0, 'instance data is finite for every item and colour');
for (let i = 0; i < 300; i++) { const l = makeLook(rng(i + 1), { wealth: (i % 10) / 10, beach: i % 3 === 0 }); lookData(l, makeDims(l)); }
ok(true, 'random pedestrian looks still build');
const hb = new HumanBatch(new THREE.Scene(), 2, {});
ok(Object.values(hb.sets).every((s) => s.meshes.length > 0), `batch builds (${hb.sets.near.meshes.length} near meshes)`);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
