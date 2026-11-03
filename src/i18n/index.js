import en from './locales/en.js';

// i18n engine (workstream G). One shared instance per page: the loading screen needs it before `game` exists.
// Locales live in ./locales/<code>.js (flat key → string). English is bundled; the rest load on demand.
// Plurals: keys `<key>_<category>` (Intl.PluralRules categories: zero/one/two/few/many/other), `t(key, {count})`.
// Placeholders: `{name}`; numeric params are formatted with locale digit grouping.

// Order shown in the pickers: English (the bundled fallback) first, then the rest by English name; the pickers show
// the native names. The 'auto' option is added on top by the UI.
export const LANGUAGES = [
  { code: 'en', name: 'English', en: 'English' },
  ...[
    { code: 'ar', name: 'العربية', en: 'Arabic', dir: 'rtl' },
    { code: 'bn', name: 'বাংলা', en: 'Bengali' },
    { code: 'zh-CN', name: '简体中文', en: 'Chinese (Simplified)' },
    { code: 'zh-TW', name: '繁體中文', en: 'Chinese (Traditional)' },
    { code: 'cs', name: 'Čeština', en: 'Czech' },
    { code: 'nl', name: 'Nederlands', en: 'Dutch' },
    { code: 'fr', name: 'Français', en: 'French' },
    { code: 'de', name: 'Deutsch', en: 'German' },
    { code: 'el', name: 'Ελληνικά', en: 'Greek' },
    { code: 'he', name: 'עברית', en: 'Hebrew', dir: 'rtl' },
    { code: 'hi', name: 'हिन्दी', en: 'Hindi' },
    { code: 'hu', name: 'Magyar', en: 'Hungarian' },
    { code: 'id', name: 'Bahasa Indonesia', en: 'Indonesian' },
    { code: 'it', name: 'Italiano', en: 'Italian' },
    { code: 'ja', name: '日本語', en: 'Japanese' },
    { code: 'ko', name: '한국어', en: 'Korean' },
    { code: 'ms', name: 'Bahasa Melayu', en: 'Malay' },
    { code: 'fa', name: 'فارسی', en: 'Persian', dir: 'rtl' },
    { code: 'pl', name: 'Polski', en: 'Polish' },
    { code: 'pt-BR', name: 'Português (Brasil)', en: 'Portuguese (Brazil)' },
    { code: 'ro', name: 'Română', en: 'Romanian' },
    { code: 'ru', name: 'Русский', en: 'Russian' },
    { code: 'es', name: 'Español', en: 'Spanish' },
    { code: 'sv', name: 'Svenska', en: 'Swedish' },
    { code: 'th', name: 'ไทย', en: 'Thai' },
    { code: 'tr', name: 'Türkçe', en: 'Turkish' },
    { code: 'uk', name: 'Українська', en: 'Ukrainian' },
    { code: 'ur', name: 'اردو', en: 'Urdu', dir: 'rtl' },
    { code: 'vi', name: 'Tiếng Việt', en: 'Vietnamese' },
  ].sort((a, b) => a.en.localeCompare(b.en, 'en')),
].map((l) => ({ dir: 'ltr', ...l }));

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

// writing system → font stack / letter-spacing rules in styles.css (html[data-script])
const SCRIPT = {
  ru: 'cyrillic', uk: 'cyrillic', el: 'greek', vi: 'vietnamese', 'zh-CN': 'sc', 'zh-TW': 'tc', ja: 'ja', ko: 'ko',
  ar: 'arabic', fa: 'arabic', ur: 'arabic', he: 'hebrew', hi: 'deva', bn: 'beng', th: 'thai',
};

const LOADERS = import.meta.glob(['./locales/*.js', '!./locales/en.js']);
const SETTINGS_KEY = 'leonida.settings';

// Best supported language for a BCP-47 tag list (navigator.languages).
export function detectLanguage(tags = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []) {
  for (const raw of tags) {
    if (!raw) continue;
    const tag = String(raw).replace('_', '-');
    const lower = tag.toLowerCase();
    const [base] = lower.split('-');
    if (base === 'zh') {
      if (/-(tw|hk|mo|hant)\b/.test(lower)) return 'zh-TW';
      return 'zh-CN';
    }
    if (base === 'pt') return 'pt-BR';
    const alias = { iw: 'he', in: 'id', ji: 'yi', nb: null, no: null, zsm: 'ms', fil: null, pes: 'fa', prs: 'fa' }[base];
    const code = alias !== undefined ? alias : base;
    if (code && BY_CODE.has(code)) return code;
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;
  }
  return 'en';
}

function readSavedPref() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}').lang || 'auto'; } catch { return 'auto'; }
}

class I18n {
  constructor() {
    this.languages = LANGUAGES;
    this.locales = { en };
    this.registered = {}; // lang → { 'ns.key': string }
    this.namespaces = new Set();
    this.listeners = new Set();
    this.pref = readSavedPref(); // 'auto' | code
    this.lang = 'en';
    this.dir = 'ltr';
    this.script = 'latin';
    this.game = null;
    this._missing = new Set();
    this._nf = new Map();
    this._memo = new Map(); // resolved strings: key (+ plural category) → string | undefined (UI hot paths call t() a lot)
    this._chainC = null;
    this._fonts = {};
    this._resolve(this.pref, true);
  }

  get autoLang() { return detectLanguage(); }
  get language() { return BY_CODE.get(this.lang); }

  // Attach to the game: sync with game.settings.lang and the settings bus.
  attach(game) {
    this.game = game;
    game.i18n = this;
    if (this._userPicked && game.settings.lang !== this.pref) game.applySetting('lang', this.pref);
    else if ((game.settings.lang || 'auto') !== this.pref) this.setLang(game.settings.lang || 'auto');
    game.onSetting?.('lang', (v) => this.setLang(v));
    return this;
  }

  // code: language code or 'auto'. Persist through game.applySetting('lang', code) when a game exists.
  setLang(code) {
    if (!code || (code !== 'auto' && !BY_CODE.has(code))) code = 'auto';
    if (!this.game) this._userPicked = true;
    this.pref = code;
    return this._resolve(code, false);
  }

  _resolve(pref, initial) {
    const lang = pref === 'auto' ? detectLanguage() : pref;
    this._want = lang;
    const done = () => {
      if (this._want !== lang) return;
      const changed = lang !== this.lang || initial;
      this.lang = lang;
      const info = BY_CODE.get(lang);
      this.dir = info.dir;
      this.script = SCRIPT[lang] || 'latin';
      this._plural = new Intl.PluralRules(lang);
      this._nf.clear();
      this._money = null;
      this._invalidate();
      this._applyDocument();
      if (changed || !initial) this._emit();
    };
    if (this.locales[lang]) { done(); return Promise.resolve(lang); }
    const load = LOADERS[`./locales/${lang}.js`];
    if (!load) { console.warn(`[i18n] no locale file for ${lang}`); this.locales[lang] = {}; done(); return Promise.resolve(lang); }
    this.ready = load().then((m) => { this.locales[lang] = m.default || {}; done(); return lang; })
      .catch((e) => { console.error('[i18n] locale load failed', lang, e); this.locales[lang] = {}; done(); return lang; });
    return this.ready;
  }

  _applyDocument() {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    html.lang = this.lang;
    html.dir = this.dir;
    html.dataset.script = this.script;
    this._fonts = {};
  }

  _invalidate() { this._memo.clear(); this._chainC = null; }

  _emit() {
    for (const fn of [...this.listeners]) {
      try { fn(this.lang, this); } catch (e) { console.error('[i18n] listener', e); }
    }
    this.game?.events?.emit('lang', { lang: this.lang, dir: this.dir });
  }

  // fn(lang) is called after the active language changed (locale already loaded)
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Register translations for another workstream: register('air', { en: { gear: 'Gear' }, de: { gear: 'Fahrwerk' } })
  // → t('air.gear'). Locale files (src/i18n/locales) take precedence for the same key. Modules keep only `en` (and `ru`)
  // in the bundle; the other languages carry `<ns>.<key>` in their lazily loaded locale file (see check-locales.mjs).
  register(namespace, dicts) {
    this.namespaces.add(namespace);
    for (const [lang, dict] of Object.entries(dicts || {})) {
      const into = (this.registered[lang] ||= {});
      for (const [k, v] of Object.entries(dict)) into[`${namespace}.${k}`] = v;
    }
    this._invalidate();
    if (dicts?.[this.lang]) this._emit();
  }

  // dictionaries in lookup order (cached; rebuilt after a language / locale / register change)
  _chain() {
    if (this._chainC) return this._chainC;
    const l = this.lang, base = l.split('-')[0];
    const out = [[this.locales[l], l], [this.registered[l], l]];
    if (base !== l) out.push([this.locales[base], base], [this.registered[base], base]);
    out.push([this.locales.en, 'en'], [this.registered.en, 'en']);
    return (this._chainC = out);
  }

  // memoised: menus call t() for every row / card on each render
  _lookup(key, count) {
    let mk = key, cl, ce;
    if (count !== undefined) {
      cl = this._plural.select(count);
      ce = (this._enPlural ||= new Intl.PluralRules('en')).select(count);
      mk = `${key}\u0001${cl}\u0001${ce}`;
    }
    const memo = this._memo;
    if (memo.has(mk)) return memo.get(mk);
    let out;
    for (const [dict, lang] of this._chain()) {
      if (!dict) continue;
      if (count !== undefined) {
        const cat = lang === this.lang ? cl : ce;
        const v = dict[`${key}_${cat}`] ?? dict[`${key}_other`];
        if (v != null) { out = v; break; }
      }
      const v = dict[key];
      if (v != null) { out = v; break; }
    }
    memo.set(mk, out);
    return out;
  }

  has(key) { return this._lookup(key) !== undefined || this._lookup(key, 1) !== undefined; }

  t(key, params) {
    const count = params && typeof params.count === 'number' ? params.count : undefined;
    let s = this._lookup(key, count);
    if (s === undefined) {
      if (!this._missing.has(key)) { this._missing.add(key); if (import.meta.env?.DEV) console.warn(`[i18n] missing key ${key}`); }
      return params?.default ?? key;
    }
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : typeof params[k] === 'number' ? this.number(params[k]) : params[k]));
    return s;
  }

  // Locale digit grouping, always Latin digits (HUD fonts are Latin).
  number(n, opts) {
    const key = opts ? JSON.stringify(opts) : '';
    let f = this._nf.get(key);
    if (!f) {
      try { f = new Intl.NumberFormat(`${this.lang}-u-nu-latn`, { maximumFractionDigits: 2, ...opts }); } catch { f = new Intl.NumberFormat('en', opts); }
      this._nf.set(key, f);
    }
    return f.format(n);
  }

  // GTA-style money: always "$" in front, locale grouping: $1,234,567 / $1 234 567 / $1.234.567
  money(n, { sign = false } = {}) {
    const v = Math.round(n);
    if (!this._money) {
      try { this._money = new Intl.NumberFormat(`${this.lang}-u-nu-latn`, { maximumFractionDigits: 0 }); } catch { this._money = new Intl.NumberFormat('en', { maximumFractionDigits: 0 }); }
    }
    const s = `$${this._money.format(Math.abs(v))}`;
    return v < 0 ? `-${s}` : sign ? `+${s}` : s;
  }

  // Font stacks resolved from CSS for canvas text (cached per script: getComputedStyle forces a style recalc).
  font(kind = 'ui') {
    if (typeof document === 'undefined') return 'sans-serif';
    const k = kind === 'display' ? '--f-disp' : '--f-ui';
    if (this._fonts[k]) return this._fonts[k];
    const v = getComputedStyle(document.documentElement).getPropertyValue(k).trim();
    if (v) this._fonts[k] = v; // not cached until the stylesheet is in
    return v || 'Oswald, sans-serif';
  }
}

let shared = null;

// Shared instance (created on first use; detects the language from settings/navigator immediately).
export function getI18n() {
  return (shared ||= new I18n());
}

// Creates/attaches `game.i18n`.
export function createI18n(game) {
  return getI18n().attach(game);
}
