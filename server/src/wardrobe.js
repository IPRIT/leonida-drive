// Wardrobe table (clothing / appearance items) for server-side purchase validation and outfit replication.
// Source: src/economy/wardrobe-prices.json (workstream L; ids from D's src/characters/wardrobe.js). Accepted shapes:
//   { "<itemId>": { price, slot?, starter? } }  or  { items: { ... } }  or  { prices: { ... } }
// Items are numbered 1..N in sorted id order for the wire (outfits travel as u16 indices); the client gets the id
// list once per connection (S_GARAGE), so the numbering only has to be stable within one server process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dyePrice } from '../../src/economy/rules.js';
import { itemById } from '../../src/net/shared/outfit-codes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WARDROBE_PATH = path.resolve(here, '../../src/economy/wardrobe-prices.json');

export function loadWardrobe(file = process.env.WARDROBE_PRICES || WARDROBE_PATH, log = console) {
  const out = { items: [], byId: new Map(), byIndex: [null], ids: [], slots: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') log.warn?.(`[wardrobe] ${file}: ${e.message}`);
    return out;
  }
  const table = raw.items || raw.prices || raw;
  const ids = Object.keys(table).filter((id) => typeof id === 'string' && /^[\w.:-]{1,64}$/.test(id) && table[id] && typeof table[id] === 'object').sort();
  for (const id of ids) {
    const e = table[id];
    const price = Number.isFinite(+e.price) ? Math.max(0, Math.round(+e.price)) : 0;
    const dye = Number.isFinite(+e.dye) ? Math.max(0, Math.round(+e.dye)) : dyePrice(price);
    // colours: the item's palette in D's catalogue (the wardrobe UI offers exactly these; outfits replicate them)
    const it = { id, index: out.items.length + 1, price, dye, slot: typeof e.slot === 'string' ? e.slot : '', free: !!e.starter || price === 0, colors: itemById(id)?.colors || null };
    out.items.push(it);
    out.byId.set(id, it);
    out.byIndex.push(it);
  }
  out.ids = out.items.map((i) => i.id);
  out.slots = out.items.map((i) => i.slot);
  if (out.items.length > 65000) throw new Error('wardrobe table too large for u16 indices');
  log.info?.(`[wardrobe] ${out.items.length} items`);
  return out;
}
