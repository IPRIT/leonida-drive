// Weather states. cloud = uCloudCover, dark = storm darkness, rain 0..1, fog 0..1 (distance fog),
// mist 0..1 (ground-hugging height fog), haze = Mie aerosol multiplier for the sky, cirrus 0..1,
// wind m/s, lightning = strikes frequency multiplier.
export const WEATHER_STATES = {
  clear: { cloud: 0.1, dark: 0, rain: 0, fog: 0, mist: 0, haze: 1, cirrus: 0.75, wind: 2.5, lightning: 0 },
  partly: { cloud: 0.44, dark: 0, rain: 0, fog: 0.04, mist: 0, haze: 1.6, cirrus: 0.55, wind: 4, lightning: 0 },
  overcast: { cloud: 0.88, dark: 0.22, rain: 0, fog: 0.2, mist: 0.08, haze: 3.5, cirrus: 0.1, wind: 6, lightning: 0 },
  lightRain: { cloud: 0.86, dark: 0.35, rain: 0.35, fog: 0.35, mist: 0.15, haze: 4.5, cirrus: 0, wind: 5, lightning: 0 },
  heavyRain: { cloud: 0.96, dark: 0.6, rain: 0.85, fog: 0.6, mist: 0.28, haze: 6, cirrus: 0, wind: 9, lightning: 0.08 },
  storm: { cloud: 1, dark: 0.85, rain: 1, fog: 0.55, mist: 0.25, haze: 6, cirrus: 0, wind: 13, lightning: 1 },
  fog: { cloud: 0.4, dark: 0.04, rain: 0, fog: 1, mist: 1, haze: 10, cirrus: 0.2, wind: 0.8, lightning: 0 },
};

export const WEATHER_NAMES = Object.keys(WEATHER_STATES);

// English fallbacks; i18n keys are `weather.<state>` (same ids as the UI: auto clear partly overcast lightRain heavyRain storm fog).
export const WEATHER_LABELS = {
  auto: 'Dynamic', clear: 'Clear', partly: 'Partly cloudy', overcast: 'Overcast', lightRain: 'Light rain',
  heavyRain: 'Heavy rain', storm: 'Thunderstorm', fog: 'Fog',
};

export const WEATHER_ALIASES = {
  sunny: 'clear', partlycloudy: 'partly', 'partly cloudy': 'partly', 'partly-cloudy': 'partly', cloudy: 'overcast',
  rain: 'lightRain', 'light rain': 'lightRain', 'light-rain': 'lightRain', lightrain: 'lightRain',
  'heavy rain': 'heavyRain', 'heavy-rain': 'heavyRain', heavyrain: 'heavyRain', thunderstorm: 'storm', thunder: 'storm',
  mist: 'fog', foggy: 'fog',
};

// Markov weights for the automatic schedule (Florida: mostly fair, afternoon storms, morning fog)
export const WEATHER_NEXT = {
  clear: { clear: 2, partly: 4, overcast: 1, fog: 0.4 },
  partly: { clear: 3, partly: 1.5, overcast: 2.5, lightRain: 1 },
  overcast: { partly: 2, overcast: 0.8, lightRain: 3, heavyRain: 1, fog: 0.4 },
  lightRain: { overcast: 2, lightRain: 0.8, heavyRain: 2, partly: 1 },
  heavyRain: { lightRain: 2, storm: 2, overcast: 1 },
  storm: { heavyRain: 2, lightRain: 1.5, overcast: 1 },
  fog: { clear: 1.5, partly: 2, overcast: 1 },
};

export function resolveWeatherName(name) {
  if (!name) return null;
  if (WEATHER_STATES[name]) return name;
  const k = String(name).toLowerCase();
  return WEATHER_ALIASES[k] || WEATHER_NAMES.find((n) => n.toLowerCase() === k) || null;
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

// Numeric weather (e.g. from the multiplayer server): {rain 0..1, cloud 0..1, wind 0..1, fog 0..1, storm bool}
// → full parameter set + the closest preset name (for labels).
export function weatherFromNumeric(o) {
  const rain = clamp01(o.rain);
  const storm = !!o.storm;
  const cloud = Math.max(o.cloud == null ? (rain > 0 ? 0.85 : 0.3) : clamp01(o.cloud), rain * 0.85, storm ? 0.95 : 0);
  const fog = clamp01(o.fog);
  const wind = o.wind == null ? 0.25 : clamp01(o.wind);
  const p = {
    cloud,
    dark: Math.min(0.9, rain * 0.55 + (storm ? 0.3 : 0) + Math.max(0, cloud - 0.75) * 0.6),
    rain,
    fog: Math.max(fog, rain * 0.6),
    mist: Math.max(0, fog - rain * 0.3),
    haze: 1 + cloud * 2.5 + fog * 8 + rain * 2,
    cirrus: (1 - cloud) * 0.75,
    wind: wind * 16,
    lightning: storm ? 1 : 0,
  };
  const name = storm ? 'storm' : rain > 0.6 ? 'heavyRain' : rain > 0.05 ? 'lightRain' : fog > 0.6 ? 'fog' : cloud > 0.75 ? 'overcast' : cloud > 0.3 ? 'partly' : 'clear';
  return { params: p, name };
}
