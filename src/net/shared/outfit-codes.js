// Outfits on the wire use workstream D's appearance codes (src/characters/wardrobe.js): one u16 per worn item,
// item.code * 16 + colour index (15 = the item's default colour), at most 11 (one per slot). Codes are stable (new
// items are appended), so they need no per-connection numbering. Shared by the server and the browser (plain data).
import { WARDROBE, WARDROBE_BY_ID, decodeOutfit as decodeLook, outfitKey } from '../../characters/wardrobe.js';

export const OUTFIT_CODES_MAX = 11;
const BY_CODE = new Map(WARDROBE.map((it) => [it.code, it]));

/** Item of a wire code (null if unknown). */
export const itemOfCode = (code) => BY_CODE.get(code >> 4) || null;
/** Catalogue item by id (null if unknown). */
export const itemById = (id) => WARDROBE_BY_ID.get(id) || null;

/**
 * Economy-shaped outfit ({ slot: itemId } plus optional colours) → wire codes. `colourOf(itemId)` gives the owned
 * colour (hex) or null. Unknown items are skipped; a colour outside the item's palette travels as "default".
 */
export function outfitCodes(itemIds, colourOf = () => null) {
  const out = [];
  for (const id of itemIds) {
    const it = WARDROBE_BY_ID.get(id);
    if (!it || out.length >= OUTFIT_CODES_MAX) continue;
    const c = colourOf(id);
    const ci = c == null ? -1 : it.colors.indexOf(c);
    out.push(it.code * 16 + (ci >= 0 && ci < 15 ? ci : 15));
  }
  return out;
}

/** Wire codes → D's canonical outfit { slot: { id, color } } (what createRemoteAvatars' add/set take). */
export function lookOfCodes(codes) { return codes && codes.length ? decodeLook(codes) : null; }

export { outfitKey };
