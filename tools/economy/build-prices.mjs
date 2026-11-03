#!/usr/bin/env node
// Builds the shared vehicle price table src/economy/prices.json from the catalogs (cars, bikes, trucks, aircraft, boats).
// Format (plain, shared with the multiplayer server): { "<catalogId>": { "price", "cls", "starter", "traffic" } }.
//   price   — catalog `price` when present, else the class formula of docs/ECONOMY.md (rules.classPrice)
//   cls     — price class (rules.CLASS_RANGES): bicycle bike compact standard sports super truck boat heli plane
//   starter — free at start and impossible to sell: the cheapest compact and the cheapest bicycle
//   traffic — catalog trafficWeight (0 for aircraft/boats); used by the export yards' wanted lists
// Usage: node tools/economy/build-prices.mjs [--check]   (--check exits 1 if prices.json is out of date)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VEHICLE_CATALOG } from '../../src/vehicle/catalog.js';
import { AIR_CATALOG } from '../../src/air/catalog.js';
import { BOAT_CATALOG } from '../../src/boat/catalog.js';
import { priceClass, classPrice, CLASS_RANGES } from '../../src/economy/rules.js';
import { PRICE_OVERRIDES } from '../../src/economy/price-overrides.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../src/economy/prices.json');

const entries = [...VEHICLE_CATALOG, ...AIR_CATALOG, ...BOAT_CATALOG];
for (const [id, o] of Object.entries(PRICE_OVERRIDES)) {
  if (o.pending && !entries.some((e) => e.id === id)) entries.push({ id, category: o.category, kind: o.kind, price: o.price, tier: 1, trafficWeight: 0, pending: true });
}
const table = {};
const derived = [];
const overridden = [];
for (const e of entries) {
  const cls = priceClass(e.category, e.kind);
  const has = Number.isFinite(e.price) && e.price > 0;
  let price = has ? Math.round(e.price) : classPrice(cls, e.tier ?? 0.3);
  if (!has) derived.push(e.id);
  const o = PRICE_OVERRIDES[e.id];
  if (o && o.price !== price) { overridden.push(`${e.id} ${price} → ${o.price}`); price = o.price; }
  table[e.id] = { price, cls, starter: false, traffic: Math.round((e.trafficWeight ?? 0) * 100) / 100 };
}
const cheapest = (pred) => entries.filter(pred).sort((a, b) => table[a.id].price - table[b.id].price || a.id.localeCompare(b.id))[0];
const starterCar = cheapest((e) => e.category === 'compact');
const starterBike = cheapest((e) => e.category === 'bicycle');
for (const s of [starterCar, starterBike]) if (s) table[s.id].starter = true;

// one entry per line: readable diffs, still plain JSON
const body = `{\n${Object.entries(table).map(([id, p]) => `  ${JSON.stringify(id)}: ${JSON.stringify(p)}`).join(',\n')}\n}\n`;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== body) { console.error('prices.json is out of date: run node tools/economy/build-prices.mjs'); process.exit(1); }
  console.log('prices.json is up to date');
  process.exit(0);
}
fs.writeFileSync(OUT, body);

// summary for docs/ECONOMY.md
const byCls = {};
for (const [id, p] of Object.entries(table)) (byCls[p.cls] ??= []).push([id, p.price]);
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${entries.length} vehicles, starters: ${starterCar?.id}, ${starterBike?.id}`);
if (derived.length) console.log(`class-formula prices (no catalog price): ${derived.join(', ')}`);
if (overridden.length) console.log(`economy overrides (tell the catalog owner): ${overridden.join(', ')}`);
const pend = entries.filter((e) => e.pending).map((e) => e.id);
if (pend.length) console.log(`pending (priced, not in a catalog yet): ${pend.join(', ')}`);
console.log('class      n   cheapest              dearest               doc range');
for (const cls of Object.keys(CLASS_RANGES)) {
  const l = (byCls[cls] || []).sort((a, b) => a[1] - b[1]);
  if (!l.length) continue;
  const f = ([id, p]) => `${id} $${p.toLocaleString('en-US')}`.padEnd(22);
  console.log(`${cls.padEnd(10)} ${String(l.length).padStart(3)}   ${f(l[0])}${f(l[l.length - 1])}$${CLASS_RANGES[cls][0].toLocaleString('en-US')}–$${CLASS_RANGES[cls][1].toLocaleString('en-US')}`);
}
