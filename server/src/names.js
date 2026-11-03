// Custom nickname validation (server side): format (shared rules), a blocklist with leetspeak normalisation, and
// impersonation of server-generated names. Uniqueness is checked by the DB thread (case-insensitive unique index).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameFormatError, looksGenerated } from '../../src/net/shared/nicknames.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BLOCKLIST_PATH = path.resolve(here, '../data/name-blocklist.txt');

export function loadBlocklist(file = process.env.NAME_BLOCKLIST || BLOCKLIST_PATH) {
  const out = { substring: [], token: new Set() };
  let section = 'substring';
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (!line) continue;
    if (line === '[substring]' || line === '[token]') { section = line.slice(1, -1); continue; }
    if (!/^[a-z]+$/.test(line)) continue;
    if (section === 'token') out.token.add(line); else out.substring.push(line);
  }
  return out;
}

const LEET_I = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', 2: 'z', 6: 'b' };
const LEET_L = { ...LEET_I, 1: 'l' };
const collapse = (s) => s.replace(/(.)\1+/g, '$1');

/** Normalised variants of a name for substring checks. */
export function normalise(name) {
  const lower = name.toLowerCase().replace(/[_-]/g, '');
  const a = lower.replace(/[0-9]/g, (d) => LEET_I[d] ?? '');
  const b = lower.replace(/[0-9]/g, (d) => LEET_L[d] ?? '');
  const c = lower.replace(/[0-9]/g, '');
  return [...new Set([a, b, c, collapse(a), collapse(b), collapse(c)])];
}

/** Words of a name: split at _ - digits and camelCase boundaries (leet digits inside words are mapped first). */
export function tokens(name) {
  const parts = name.split(/[_-]+/).flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/));
  const out = new Set();
  for (const p of parts) {
    const lower = p.toLowerCase();
    for (const t of lower.split(/[0-9]+/)) if (t) { out.add(t); out.add(collapse(t)); }
    // a word written with leet digits ("d1ck")
    const leet = lower.replace(/[0-9]/g, (d) => LEET_I[d] ?? '');
    out.add(leet); out.add(collapse(leet));
    out.add(lower.replace(/[0-9]/g, (d) => LEET_L[d] ?? ''));
  }
  return out;
}

/**
 * Validate a requested custom name. → '' when acceptable, else a reason: short | long | chars | blocked | reserved.
 * `ownGenerated`: the player's own generated name (may be re-chosen as a custom spelling).
 */
export function checkName(name, blocklist, ownGenerated = '') {
  const f = nameFormatError(name);
  if (f) return f === 'short' || f === 'long' ? f : 'chars';
  for (const n of normalise(name)) for (const bad of blocklist.substring) if (n.includes(bad)) return 'blocked';
  for (const t of tokens(name)) if (blocklist.token.has(t)) return 'blocked';
  for (const n of normalise(name)) if (blocklist.token.has(n)) return 'blocked';
  if (looksGenerated(name) && name.toLowerCase() !== ownGenerated.toLowerCase()) return 'reserved';
  return '';
}
