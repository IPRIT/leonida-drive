// Validates locale files against en.js and the module dictionaries registered with i18n.register (eco, score, net,
// life, carto, mobile: English and Russian live in the modules, the other locales carry `<ns>.<key>` in their file):
// missing/extra keys, placeholders, HTML tags, plural categories, stray Russian.
// Usage: node src/i18n/check-locales.mjs [code ...]   (no args = all locales)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');
const src = path.join(dir, '..', '..');
const imp = async (rel) => import(pathToFileURL(path.join(src, rel)).href);
const en = (await import(pathToFileURL(path.join(dir, 'en.js')).href)).default;
const PLURAL = /_(zero|one|two|few|many|other)$/;
const baseKeys = new Map(); // base → { plural: bool, sample, en?, mod? }
for (const [k, v] of Object.entries(en)) {
  const b = k.replace(PLURAL, '');
  baseKeys.set(b, { plural: PLURAL.test(k), sample: en[`${b}_other`] ?? v });
}
// module dictionaries: a key is plural only when the English dict has `<base>_other` (net.online_one is a literal key)
const { ECO_STRINGS, SCORE_STRINGS } = await imp('economy/i18n.js');
const MODULES = {
  eco: ECO_STRINGS, score: SCORE_STRINGS, net: (await imp('net/i18n.js')).NET_STRINGS, life: (await imp('life/strings.js')).LIFE_STRINGS,
  carto: (await imp('map/strings.js')).STRINGS, mobile: (await imp('mobile/strings.js')).MOBILE_STRINGS,
  render: (await imp('ui/render-strings.js')).RENDER_STRINGS,
};
let bad = 0;
for (const [ns, dicts] of Object.entries(MODULES)) {
  const men = dicts.en;
  for (const [k, v] of Object.entries(men)) {
    const m = k.match(PLURAL);
    const isPl = m && men[`${k.replace(PLURAL, '')}_other`] !== undefined;
    const b = `${ns}.${isPl ? k.replace(PLURAL, '') : k}`;
    if (baseKeys.has(b) && !baseKeys.get(b).mod) { console.log(`en: ${b} is defined in en.js and in the ${ns} module`); bad++; }
    const base = k.replace(PLURAL, '');
    // a plural module key may also keep a literal `<base>` for calls without a count (makeT fallbacks)
    if (isPl) baseKeys.set(b, { plural: true, sample: men[`${base}_other`], mod: dicts, key: base, fallback: men[base] !== undefined });
    else if (!(m && men[`${base}_other`] !== undefined) && men[`${k}_other`] === undefined) baseKeys.set(b, { plural: false, sample: v, en: v, mod: dicts, key: k });
  }
  for (const [k, v] of Object.entries(men)) if (/[Ѐ-ӿ]/.test(v)) { console.log(`${ns} module en: Cyrillic text in ${k}: "${v}"`); bad++; }
}
for (const [k, v] of Object.entries(en)) if (/[Ѐ-ӿ]/.test(v)) { console.log(`en: Cyrillic text in ${k}: "${v}"`); bad++; }
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...String(s).matchAll(/<\/?(\w+)/g)].map((m) => m[0]).sort().join(',');
const codes = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'en.js').map((f) => f.slice(0, -3));
for (const code of codes) {
  const file = path.join(dir, `${code}.js`);
  if (!fs.existsSync(file)) { console.log(`${code}: MISSING FILE`); bad++; continue; }
  const loc = (await import(pathToFileURL(file).href + `?t=${Date.now()}`)).default;
  const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  const errs = [];
  // a module key may come from the locale file or from the module's own dictionary for this language (ru)
  const get = (info, b, suffix = '') => loc[`${b}${suffix}`] ?? info.mod?.[code]?.[`${info.key}${suffix}`];
  let modKeys = 0;
  for (const [b, info] of baseKeys) {
    if (info.mod) modKeys++;
    if (info.plural) {
      for (const c of cats) {
        const k = `${b}_${c}`, v = get(info, b, `_${c}`);
        if (typeof v !== 'string' || !v.trim()) errs.push(`missing plural ${k}`);
        else if (ph(v).replace('count', '') !== ph(info.sample).replace('count', '')) errs.push(`placeholders differ in ${k}`);
      }
      continue;
    }
    const v = get(info, b), ref = info.mod ? info.en : en[b];
    if (typeof v !== 'string' || !v.trim()) errs.push(`missing ${b}`);
    else {
      if (ph(v) !== ph(ref)) errs.push(`placeholders differ in ${b}: "${v}"`);
      if (tags(v) !== tags(ref)) errs.push(`tags differ in ${b}`);
    }
  }
  // stray Russian: Cyrillic belongs to ru/uk only, and Ukrainian has no ы/э/ъ/ё
  const stray = code === 'ru' ? null : code === 'uk' ? /[ЫыЭэЪъЁё]/ : /[Ѐ-ӿ]/;
  if (stray) for (const [k, v] of Object.entries(loc)) if (typeof v === 'string' && stray.test(v)) errs.push(`Cyrillic (Russian?) text in ${k}: "${v}"`);
  for (const k of Object.keys(loc)) {
    const b = k.replace(PLURAL, '');
    const info = baseKeys.get(k) && !baseKeys.get(k).plural ? baseKeys.get(k) : baseKeys.get(b);
    if (!info) errs.push(`extra key ${k}`);
    else if (info.plural && k === b && !info.fallback) errs.push(`extra key ${k} (plural key: use ${k}_<category>)`);
    else if (info.plural && PLURAL.test(k) && !cats.includes(k.match(PLURAL)[1])) errs.push(`plural category not used by ${code}: ${k}`);
  }
  const same = Object.keys(en).filter((k) => loc[k] === en[k] && /[a-z]{3,}/i.test(en[k]) && !/^(hud\.|dir\.|feed\.info|about\.c\.(tech|fonts)|veh\.(kg|s)|map\.|unit\.|set\.metric|set\.imperial)/.test(k));
  console.log(`${code}: ${errs.length ? `${errs.length} problem(s)` : 'OK'} · ${Object.keys(loc).length} keys + ${modKeys} module keys · plural ${cats.join('/')}${same.length ? ` · ${same.length} identical to English: ${same.slice(0, 12).join(', ')}` : ''}`);
  for (const e of errs.slice(0, 40)) console.log(`   - ${e}`);
  if (errs.length) bad++;
}
process.exit(bad ? 1 : 0);
