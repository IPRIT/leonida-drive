#!/usr/bin/env node
// Self-contained server bundle for a VM: everything the server imports at runtime, including node_modules (uWS ships
// prebuilt binaries for linux x64/arm64, Node 22/24/25), so the VM only needs Node — no npm, no git, no build tools.
//
//   node server/tools/pack.mjs            → server/dist/leonida-mp/ + server/dist/leonida-mp.tar.gz
//
// Layout (the same relative paths the code uses):
//   leonida-mp/server/{src,data/vehicles.json,data/name-blocklist.txt,package.json,node_modules}
//   leonida-mp/src/net/shared/*.js
//   leonida-mp/src/economy/{rules.js,prices.json,wardrobe-prices.json}
//   leonida-mp/src/characters/{wardrobe.js,lookcodes.js}
//   leonida-mp/public/data/{world.json,height.bin}           (terrain + districts for plausibility checks)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.resolve(here, '../dist/leonida-mp');

fs.rmSync(out, { recursive: true, force: true });
const copy = (rel, filter) => {
  const src = path.join(root, rel), dst = path.join(out, rel);
  if (!fs.existsSync(src)) throw new Error(`missing ${rel}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // never macOS metadata (AppleDouble `._*`, .DS_Store) in the bundle
  const junk = (s) => /^\._|^\.DS_Store$/.test(path.basename(s));
  fs.cpSync(src, dst, { recursive: true, dereference: true, filter: (s) => !junk(s) && (!filter || filter(path.relative(root, s))) });
};

copy('server/src');
copy('server/package.json');
copy('server/package-lock.json');
copy('server/data/vehicles.json');
copy('server/data/name-blocklist.txt');
copy('server/data/spawn-places.json');
copy('server/deploy');
// production dependencies only (uWebSockets.js, ws); drop binaries for other OSes to keep the bundle small
copy('server/node_modules', (rel) => !/uWebSockets\.js\/uws_(darwin|win32)_/.test(rel) && !/\.bin$/.test(rel));
copy('src/net/shared');
for (const f of ['rules.js', 'online.js', 'prices.json', 'wardrobe-prices.json']) copy(`src/economy/${f}`);
for (const f of ['wardrobe.js', 'lookcodes.js']) copy(`src/characters/${f}`); // D's catalogue: outfit codes, palettes
copy('public/data/world.json');
copy('public/data/height.bin');
fs.mkdirSync(path.join(out, 'server/data'), { recursive: true });

const tgz = path.resolve(out, '../leonida-mp.tar.gz');
// a clean archive for Linux: no AppleDouble files (COPYFILE_DISABLE), no extended attributes / ACLs / macOS metadata
// (bsdtar would otherwise add LIBARCHIVE.xattr.com.apple.provenance pax headers), numeric root ownership
const bsd = /bsdtar/.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }));
const clean = bsd
  ? ['--no-xattrs', '--no-acls', '--no-fflags', '--no-mac-metadata', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
  : ['--no-xattrs', '--no-acls', '--no-selinux', '--owner=0', '--group=0', '--numeric-owner'];
fs.rmSync(tgz, { force: true });
execFileSync('tar', ['-czf', tgz, ...clean, '--exclude=._*', '--exclude=.DS_Store', '-C', path.dirname(out), path.basename(out)], {
  env: { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' },
});
// verify: no AppleDouble entries, no xattr pax headers
const raw = zlib.gunzipSync(fs.readFileSync(tgz));
const bad = ['LIBARCHIVE.xattr', 'SCHILY.xattr', 'com.apple.'].filter((k) => raw.includes(k));
const names = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
const apple = names.filter((n) => /(^|\/)\._|(^|\/)\.DS_Store$/.test(n));
if (bad.length || apple.length) throw new Error(`archive not clean: ${[...bad, ...apple.slice(0, 5)].join(', ')}`);
const size = (p) => { let n = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) n += e.isDirectory() ? size(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size; return n; };
console.log(`bundle: ${path.relative(root, out)} (${(size(out) / 1048576).toFixed(1)} MB), archive: ${path.relative(root, tgz)} (${(fs.statSync(tgz).size / 1048576).toFixed(1)} MB)`);
console.log('run on the VM: cd leonida-mp/server && NODE_ENV=production DB_PATH=/var/lib/leonida/leonida.db node src/main.js');
