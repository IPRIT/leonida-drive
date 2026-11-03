// Writes public/licenses.txt: licence texts of every third-party package shipped in the browser bundle, plus data
// attributions. Run by tools/deploy.sh before the build (node tools/licenses.mjs).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const out = [
  'Leonida Drive — third-party software and data notices',
  '=====================================================',
  '',
  'Leonida Drive is an unofficial, non-commercial fan project. It is not affiliated with or endorsed by',
  'Rockstar Games or Take-Two Interactive. Grand Theft Auto, Vice City, Leonida and related names are',
  'trademarks or names of their respective owners and are used only to refer to the fan-mapped world.',
  '',
  'Rights holders, takedown requests and questions: help@leonida-drive.io',
  '',
  'DATA',
  '----',
  '* World layout, names and points of interest: State of Leonida community map (YANIS and contributors),',
  '  https://map.stateofleonida.net/ — used with credit; every point links back to its source marker.',
  '* Landmark and district names: GTADB (https://map.gtadb.org/).',
  '* Real-world building shapes near prototype locations: (c) OpenStreetMap contributors, available under the',
  '  Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright',
  '',
  'SOFTWARE AND FONTS',
  '------------------',
];
for (const name of Object.keys(pkg.dependencies || {}).sort()) {
  const dir = new URL(`node_modules/${name}/`, root);
  const meta = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].map((f) => new URL(f, dir)).find((u) => existsSync(u));
  out.push('', `${name} ${meta.version} — ${meta.license || 'see below'}${meta.homepage ? ` — ${meta.homepage}` : ''}`, '-'.repeat(60));
  out.push(file ? readFileSync(file, 'utf8').trim() : '(licence text not found in the package)');
}
writeFileSync(new URL('public/licenses.txt', root), out.join('\n') + '\n');
console.log('licenses.txt:', Object.keys(pkg.dependencies || {}).length, 'packages');
