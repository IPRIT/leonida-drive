// Shared world clock + weather schedule, a pure function of server time (ms since the Unix epoch).
// Server and clients compute the same values, so the shared sky survives server restarts without any state,
// several shards agree with each other, and an offline client still gets a plausible "same world" sky.
import { DAY_SECONDS } from './constants.js';

export const WEATHER_IDS = Object.freeze(['clear', 'partly', 'overcast', 'lightRain', 'heavyRain', 'storm', 'fog']);

// Markov weights. Online the shared sky is mostly clear (players asked for it): ~75 % clear/partly, rain is short
// and rare, storms very rare. Singleplayer keeps the stormier Florida chain in src/weather/presets.js WEATHER_NEXT.
const NEXT = {
  clear: { clear: 8, partly: 2, overcast: 0.2, fog: 0.1 },
  partly: { clear: 5, partly: 1.5, overcast: 0.6, lightRain: 0.2 },
  overcast: { clear: 1, partly: 3, overcast: 0.4, lightRain: 0.6 },
  lightRain: { partly: 2, overcast: 1.5, lightRain: 0.3, heavyRain: 0.2 },
  heavyRain: { lightRain: 2, overcast: 1, storm: 0.2 },
  storm: { heavyRain: 1, lightRain: 2, overcast: 1 },
  fog: { clear: 3, partly: 1 },
};

const EPOCH = Date.UTC(2026, 0, 1); // chain origin
const SEGMENT_MS = 6 * 60 * 1000; // a weather segment lasts 6 real minutes
const CHAIN_SEGMENTS = 240 * 30; // the chain restarts every 30 days (bounded work per call)
const HOUR_OFFSET = 8; // in-game 08:00 at the epoch
export const TIME_SCALE = 24 / DAY_SECONDS; // in-game hours per real second (1/120)

function hash32(n) {
  let t = (n + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function step(state, seg) {
  const w = NEXT[state];
  let total = 0;
  for (const k in w) total += w[k];
  let r = hash32(seg * 2654435761) * total;
  for (const k in w) { if ((r -= w[k]) <= 0) return k; }
  return state;
}

// tiny cache: consecutive calls usually hit the same or the next segment
let cSeg = -1, cState = 'partly', cPrev = 'partly';

function weatherAt(seg) {
  if (seg === cSeg) return [cState, cPrev];
  const start = Math.floor(seg / CHAIN_SEGMENTS) * CHAIN_SEGMENTS;
  let s, p, from;
  if (cSeg >= start && cSeg < seg) { s = cState; p = cPrev; from = cSeg + 1; } else { s = 'partly'; p = 'partly'; from = start + 1; }
  for (let k = from; k <= seg; k++) { p = s; s = step(s, k); }
  cSeg = seg; cState = s; cPrev = p;
  return [s, p];
}

const out = { hour: 0, timeScale: TIME_SCALE, weather: 'clear', prev: 'clear', weatherIndex: 0, prevIndex: 0, transition: 1, transitionS: 60, remainingS: 0 };

/**
 * World state at `ms` (server time). Returns a reused object:
 * { hour 0..24, timeScale h/s, weather id, prev id, weatherIndex, prevIndex, transition 0..1, transitionS, remainingS }.
 */
export function worldClock(ms) {
  const t = ms - EPOCH;
  out.hour = (((t / 1000 / DAY_SECONDS) * 24 + HOUR_OFFSET) % 24 + 24) % 24;
  const seg = Math.floor(t / SEGMENT_MS);
  const [cur, prev] = weatherAt(seg);
  const into = (t - seg * SEGMENT_MS) / 1000;
  const dur = cur === 'storm' || prev === 'storm' ? 90 : 60;
  out.weather = cur;
  out.prev = prev;
  out.weatherIndex = WEATHER_IDS.indexOf(cur);
  out.prevIndex = WEATHER_IDS.indexOf(prev);
  out.transitionS = dur;
  out.transition = cur === prev ? 1 : Math.min(1, into / dur);
  out.remainingS = cur === prev ? 0 : Math.max(0, dur - into);
  return out;
}
