#!/usr/bin/env node
// Builds src/economy/wardrobe-prices.json from D's wardrobe catalogue (src/characters/wardrobe.js, export WARDROBE or
// WARDROBE_ITEMS, plain data). Until that file exists the provisional catalogue tools/economy/wardrobe-sample.mjs is
// used and the table is marked provisional in the console output.
// Format (plain, shared with the server): { "<itemId>": { "price", "slot", "tier", "dye", "starter" } }
// Usage: node tools/economy/build-wardrobe-prices.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wardrobePrice, dyePrice, WARDROBE, WARDROBE_SLOTS } from '../../src/economy/rules.js';
import { WARDROBE_SAMPLE } from './wardrobe-sample.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../src/economy/wardrobe-prices.json');
const D_FILE = path.resolve(here, '../../src/characters/wardrobe.js');

let items = null, source = 'D (src/characters/wardrobe.js)';
if (fs.existsSync(D_FILE)) {
  try {
    const m = await import(pathToFileURL(D_FILE).href);
    items = m.WARDROBE || m.WARDROBE_ITEMS || m.default || null;
    if (items && !Array.isArray(items)) items = Object.values(items);
  } catch (e) { console.error(`could not import ${D_FILE}: ${e.message}`); }
}
if (!items) { items = WARDROBE_SAMPLE; source = 'PROVISIONAL sample (tools/economy/wardrobe-sample.mjs) — D has not shipped wardrobe.js yet'; }

const table = {};
const bad = [];
for (const it of items) {
  if (!it?.id) continue;
  if (!WARDROBE_SLOTS.includes(it.slot)) bad.push(`${it.id}: slot ${it.slot}`);
  if (it.slot !== 'body' && it.slot !== 'tattoo' && !WARDROBE.tierOrder.includes(it.tier)) bad.push(`${it.id}: tier ${it.tier}`);
  const price = wardrobePrice(it);
  table[it.id] = { price, slot: it.slot, tier: it.tier || 'basic', dye: dyePrice(price), starter: !!it.starter };
}
const body = `{\n${Object.entries(table).map(([id, p]) => `  ${JSON.stringify(id)}: ${JSON.stringify(p)}`).join(',\n')}\n}\n`;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== body) { console.error('wardrobe-prices.json is out of date: run node tools/economy/build-wardrobe-prices.mjs'); process.exit(1); }
  console.log('wardrobe-prices.json is up to date');
  process.exit(0);
}
fs.writeFileSync(OUT, body);
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(table).length} items from ${source}`);
if (bad.length) console.log(`warnings: ${bad.join('; ')}`);
const by = {};
for (const [id, p] of Object.entries(table)) if (!p.starter) (by[`${p.slot}/${p.tier}`] ??= []).push([id, p.price]);
for (const k of Object.keys(by).sort()) {
  const l = by[k].sort((a, b) => a[1] - b[1]);
  console.log(`${k.padEnd(20)} ${String(l.length).padStart(2)}  $${l[0][1].toLocaleString('en-US')} – $${l[l.length - 1][1].toLocaleString('en-US')}`);
}
