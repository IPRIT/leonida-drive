// Server-generated nicknames from curated word lists. Players never type their name, so there is no XSS and
// no profanity. A nickname travels as a u32 code: adjective (7 bits) | noun (7 bits) << 7 | number (7 bits) << 14,
// number 0..99 or 127 = none. The lists are APPEND-ONLY: existing codes must keep decoding to the same name.

export const ADJECTIVES = Object.freeze([
  'Neon', 'Sunset', 'KeyLime', 'Coral', 'Turbo', 'Retro', 'Velvet', 'Chrome', 'Pastel', 'Tropic',
  'Midnight', 'Salty', 'Breezy', 'Lucky', 'Electric', 'Golden', 'Mango', 'Papaya', 'Cosmic', 'Hyper',
  'Laser', 'Rapid', 'Silent', 'Swift', 'Wild', 'Crimson', 'Azure', 'Jade', 'Amber', 'Solar',
  'Lunar', 'Stormy', 'Sandy', 'Sunny', 'Misty', 'Sparkly', 'Groovy', 'Funky', 'Jazzy', 'Snappy',
  'Zippy', 'Dizzy', 'Fuzzy', 'Spicy', 'Minty', 'Peachy', 'Cherry', 'Citrus', 'Lemon', 'Coconut',
  'Pineapple', 'Banana', 'Guava', 'Hibiscus', 'Orchid', 'Lagoon', 'Bayou', 'Swamp', 'Glade', 'Harbor',
  'Marina', 'Ocean', 'Reef', 'Tidal', 'Surf', 'Palm', 'Cypress', 'Mangrove', 'Saltwater', 'Shoreline',
  'Vice', 'Vapor', 'Synth', 'Pixel', 'Arcade', 'Disco', 'Boogie', 'Cruise', 'Drift', 'Nitro',
  'Diesel', 'Gravel', 'Asphalt', 'Highway', 'Overdrive', 'Redline', 'Fast', 'Daring', 'Brave', 'Clever',
  'Mighty', 'Noble', 'Royal', 'Captain', 'Major', 'Super', 'Ultra', 'Mega', 'Tiny', 'Big',
  'Little', 'Sleepy', 'Happy', 'Jolly', 'Cheeky', 'Sneaky', 'Shiny', 'Glossy', 'Matte', 'Frosty',
  'Blazing', 'Sizzling', 'Humid', 'Balmy', 'Gusty', 'Thunder', 'Lightning', 'Rainbow', 'Starry', 'Galactic',
  'Atomic', 'Rocket', 'Jet', 'Supersonic', 'Hidden', 'Secret', 'Mystic', 'Magic',
]);

export const NOUNS = Object.freeze([
  'Gator', 'Drifter', 'King', 'Queen', 'Flamingo', 'Manatee', 'Pelican', 'Marlin', 'Shark', 'Cruiser',
  'Racer', 'Rider', 'Bandit', 'Ace', 'Ghost', 'Comet', 'Viper', 'Falcon', 'Hawk', 'Heron',
  'Ibis', 'Egret', 'Osprey', 'Dolphin', 'Turtle', 'Iguana', 'Gecko', 'Panther', 'Bobcat', 'Raccoon',
  'Armadillo', 'Otter', 'Crab', 'Lobster', 'Shrimp', 'Tarpon', 'Snapper', 'Grouper', 'Barracuda', 'Stingray',
  'Seagull', 'Parrot', 'Toucan', 'Lizard', 'Frog', 'Possum', 'Fox', 'Wolf', 'Tiger', 'Lion',
  'Bear', 'Moose', 'Mustang', 'Stallion', 'Bronco', 'Coyote', 'Jaguar', 'Cobra', 'Python', 'Scorpion',
  'Hornet', 'Firefly', 'Dragonfly', 'Butterfly', 'Hurricane', 'Tornado', 'Cyclone', 'Wave', 'Tide', 'Breeze',
  'Sunrise', 'Skyline', 'Boulevard', 'Avenue', 'Freeway', 'Speedster', 'Roadster', 'Hotrod', 'Lowrider', 'Muscle',
  'Coupe', 'Wagon', 'Pickup', 'Scooter', 'Chopper', 'Glider', 'Pilot', 'Skipper', 'Sailor', 'Captain',
  'Navigator', 'Ranger', 'Scout', 'Rookie', 'Legend', 'Champ', 'Hero', 'Wizard', 'Ninja', 'Samurai',
  'Knight', 'Rogue', 'Maverick', 'Rebel', 'Outlaw', 'Cowboy', 'Surfer', 'Skater', 'Dancer', 'Singer',
  'Drummer', 'Rocker', 'Dreamer', 'Wanderer', 'Voyager', 'Explorer', 'Nomad', 'Tourist', 'Local', 'Boss',
  'Chief', 'Duke', 'Baron', 'Prince', 'Mango', 'Coconut', 'Palm', 'Starfish',
]);

export const NICK_NONE = 127;

/** Pack word indices + number (0..99 or NICK_NONE) into a u32 code. */
export function nickCode(adj, noun, num = NICK_NONE) {
  return ((adj & 0x7f) | ((noun & 0x7f) << 7) | ((num & 0x7f) << 14)) >>> 0;
}

/** Decode a u32 code into a display name ("NeonGator42"). Unknown indices fall back to "Player". */
export function nickName(code) {
  const a = ADJECTIVES[code & 0x7f];
  const n = NOUNS[(code >>> 7) & 0x7f];
  const num = (code >>> 14) & 0x7f;
  if (!a || !n) return 'Player';
  // avoid stutter like "MangoMango" / "CaptainCaptain"
  const base = a === n ? a : a + n;
  return num <= 99 ? base + num : base;
}

/** A random valid code. rnd() → [0, 1). Two thirds of the names get a number. */
export function randomNickCode(rnd = Math.random) {
  let adj, noun;
  do {
    adj = Math.floor(rnd() * ADJECTIVES.length);
    noun = Math.floor(rnd() * NOUNS.length);
  } while (ADJECTIVES[adj] === NOUNS[noun]);
  const num = rnd() < 0.66 ? Math.floor(rnd() * 100) : NICK_NONE;
  return nickCode(adj, noun, num);
}

/** True if the code decodes with the current lists (server-side validation of stored codes). */
export function validNickCode(code) {
  return Number.isInteger(code) && code >= 0 && code < 1 << 21
    && (code & 0x7f) < ADJECTIVES.length && ((code >>> 7) & 0x7f) < NOUNS.length
    && (((code >>> 14) & 0x7f) <= 99 || ((code >>> 14) & 0x7f) === NICK_NONE);
}

// ---------------- custom names (bought online) ----------------
// 3..16 characters of [A-Za-z0-9_-], starting and ending with a letter or digit. ASCII only: names are rendered as
// text (WebGL atlas, textContent), never as HTML. The server adds a blocklist and case-insensitive uniqueness.
export const NAME_MIN = 3;
export const NAME_MAX = 16;
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{1,14})[A-Za-z0-9]$/;
/** Format check only (length, charset, no leading/trailing symbol, no doubled symbols). → '' when fine, else a reason. */
export function nameFormatError(name) {
  if (typeof name !== 'string') return 'format';
  if (name.length < NAME_MIN) return 'short';
  if (name.length > NAME_MAX) return 'long';
  if (!NAME_RE.test(name)) return 'chars';
  if (/[_-]{2}/.test(name)) return 'chars';
  return '';
}
const ADJ_LC = ADJECTIVES.map((s) => s.toLowerCase()).sort((a, b) => b.length - a.length);
const NOUN_LC = new Set(NOUNS.map((s) => s.toLowerCase()));
/** True if `name` reads like a server-generated nickname (custom names may not impersonate those). */
export function looksGenerated(name) {
  const m = /^([a-z]+?)(\d{0,2})$/.exec(String(name).toLowerCase());
  if (!m) return false;
  const letters = m[1];
  for (const a of ADJ_LC) {
    if (!letters.startsWith(a)) continue;
    const rest = letters.slice(a.length);
    if (rest === '' || NOUN_LC.has(rest)) return true;
  }
  return NOUN_LC.has(letters);
}
/** What to show for a player: the custom name if any, else the generated one. */
export function displayName(nickCodeValue, customName = '') {
  return customName || nickName(nickCodeValue);
}
