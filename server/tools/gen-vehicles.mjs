// Regenerates server/data/vehicles.json from the client catalogs (src/vehicle, src/air, src/boat).
// Run after a catalog change: `node server/tools/gen-vehicles.mjs`. Indices are stable: existing ids keep their
// position and new ids are appended (model index on the wire = position + 1; 0 = on foot).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.resolve(here, '../data/vehicles.json');
const VCLASS = { car: 1, van: 1, truck: 1, bus: 1, small: 1, tank: 1, motorcycle: 2, bicycle: 2, heli: 3, plane: 4, boat: 5 };

const entries = [];
const { VEHICLE_CATALOG } = await import(path.join(root, 'src/vehicle/catalog.js'));
for (const e of VEHICLE_CATALOG) entries.push({ id: e.id, kind: e.kind, category: e.category, top: e.topSpeedKmh, traffic: (e.trafficWeight ?? 0) > 0, price: e.price, tier: e.tier });
for (const mod of ['src/air/catalog.js', 'src/boat/catalog.js']) {
  try {
    const m = await import(path.join(root, mod));
    for (const e of [...(m.AIR_CATALOG || []), ...(m.BOAT_CATALOG || [])]) entries.push({ id: e.id, kind: e.kind, category: e.category, top: e.topSpeedKmh, traffic: false, price: e.price, tier: e.tier });
  } catch (err) { console.warn(`skip ${mod}: ${err.message}`); }
}

let prev = [];
try { prev = JSON.parse(fs.readFileSync(out, 'utf8')).vehicles || []; } catch { /* first run */ }
const byId = new Map(entries.map((e) => [e.id, e]));
const order = prev.map((p) => p.id).filter((id) => byId.has(id));
for (const e of entries) if (!order.includes(e.id)) order.push(e.id);
if (order.length > 254) throw new Error(`vehicle table too large (${order.length} > 254): bump the protocol model field`);
const vehicles = order.map((id) => {
  const e = byId.get(id);
  return { id, kind: e.kind, category: e.category, vclass: VCLASS[e.kind] ?? 1, topSpeedKmh: e.top ?? 250, traffic: !!e.traffic, price: e.price ?? null, tier: e.tier ?? null };
});
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), vehicles }, null, 1) + '\n');
console.log(`wrote ${vehicles.length} vehicles to ${path.relative(root, out)}`);
