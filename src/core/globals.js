import * as THREE from 'three';

// Global shader uniforms shared by every material (same objects are referenced, never replaced).
// Writers: Sky (uSunDir, uNight), weather (uWetness, uRain, uCloudCover, uWind, uLightning, uCloudOffset), loop (uTime).
const uTime = { value: 0 };
export const GLOBAL_UNIFORMS = {
  uTime,
  uWxTime: uTime, // same object: collision-free name used inside WEATHER_GLSL (materials often declare their own uTime)
  uNight: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uWetness: { value: 0 }, // 0 dry .. 1 soaked (roads shine, puddles)
  uRain: { value: 0 }, // current rain intensity 0..1
  uCloudCover: { value: 0.35 }, // 0 clear .. 1 overcast
  uWind: { value: new THREE.Vector3(1, 0, 0.3) }, // xz direction * strength (m/s)
  uLightning: { value: 0 }, // flash 0..1
  uCloudOffset: { value: new THREE.Vector2() }, // integrated wind drift of the cloud layer (m)
};

// Uniform declarations of WEATHER_GLSL (kept separate so a shader that already declares e.g. uTime can skip it).
export const WEATHER_GLSL_UNIFORMS = {
  uWetness: 'float', uRain: 'float', uCloudCover: 'float', uWind: 'vec3', uWxTime: 'float', uLightning: 'float',
  uSunDir: 'vec3', uCloudOffset: 'vec2',
};

// Functions only (no uniform declarations). Shared by the sky dome so cloud shadows match the visible clouds.
export const WEATHER_GLSL_FUNCTIONS = /* glsl */`
  #ifndef WEATHER_GLSL_FUNCS
  #define WEATHER_GLSL_FUNCS
  #define W_CLOUD_HEIGHT 1600.0
  float wHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float wNoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(wHash(i),wHash(i+vec2(1,0)),f.x),mix(wHash(i+vec2(0,1)),wHash(i+vec2(1,1)),f.x),f.y); }
  // large-scale density of the cumulus layer (0..1) at world xz; the sky adds small-scale detail on top
  float cloudCoverage(vec2 xz) {
    vec2 p = (xz + uCloudOffset) * 0.00042;
    float n = wNoise(p) * 0.5 + wNoise(p * 2.07 + vec2(7.1, 3.7)) * 0.3 + wNoise(p * 4.31 + vec2(3.3, 9.2)) * 0.2;
    float c = uCloudCover * 1.08;
    return smoothstep(1.0 - c, 1.3 - c, n);
  }
  // moving cloud shadow factor (1 = sunlit), projected along the sun direction onto the cloud layer
  float cloudShadow(vec2 xz) {
    float up = uSunDir.y;
    if (up < -0.04 || uCloudCover < 0.03) return 1.0;
    vec2 q = xz + uSunDir.xz / max(up, 0.14) * W_CLOUD_HEIGHT;
    float c = cloudCoverage(q);
    return 1.0 - c * (0.6 + 0.3 * uCloudCover) * smoothstep(-0.04, 0.1, up);
  }
  // puddle mask on flat ground (0..1); grows with wetness, needs a while of rain to appear
  float puddleMask(vec2 xz) {
    float n = wNoise(xz * 0.065) * 0.62 + wNoise(xz * 0.21 + 5.1) * 0.3 + wNoise(xz * 0.9 + 2.7) * 0.08;
    float th = 0.7 - uWetness * 0.12;
    return smoothstep(th, th + 0.05, n) * smoothstep(0.3, 0.7, uWetness);
  }
  // raindrop ring ripples on standing water: returns the xz slope of the surface
  vec2 rainRipples(vec2 xz) {
    if (uRain < 0.01) return vec2(0.0);
    vec2 g = vec2(0.0);
    for (int l = 0; l < 2; l++) {
      vec2 p = xz * (l == 0 ? 2.3 : 3.7) + float(l) * 17.3;
      vec2 cell = floor(p);
      vec2 f = fract(p) - 0.5;
      float h = wHash(cell + float(l) * 31.0);
      if (h > uRain * 0.85 + 0.1) continue;
      vec2 c = (vec2(wHash(cell + 3.1), wHash(cell + 7.7)) - 0.5) * 0.4;
      float t = fract(uWxTime * (0.9 + h * 0.7) + h * 7.0);
      vec2 d = f - c;
      float r = length(d);
      float rad = t * 0.45;
      float ring = sin((r - rad) * 45.0) * smoothstep(0.1, 0.0, abs(r - rad)) * (1.0 - t);
      g += d / max(r, 1e-3) * ring;
    }
    return g * 0.4;
  }
  // wet surface state. ny = world-space normal y (1 = flat ground)
  struct WeatherWet { float wet; float puddle; vec2 ripple; };
  WeatherWet weatherWet(vec3 wp, float ny) {
    WeatherWet w;
    float up = smoothstep(0.3, 0.9, ny);
    w.wet = clamp(uWetness * mix(0.35 + 0.65 * uRain, 1.0, up), 0.0, 1.0);
    w.puddle = ny > 0.965 ? puddleMask(wp.xz) : 0.0;
    // ripples alias into sparkles far away: fade them out with distance
    float rd = 1.0 - smoothstep(12.0, 40.0, length(cameraPosition - wp));
    w.ripple = w.puddle * rd > 0.01 ? rainRipples(wp.xz) * w.puddle * rd : vec2(0.0);
    return w;
  }
  // porous materials darken when wet (porosity 0 = glass/metal .. 1 = soil)
  vec3 weatherWetAlbedo(vec3 albedo, WeatherWet w, float porosity) {
    return albedo * (1.0 - 0.5 * w.wet * porosity - 0.15 * w.puddle);
  }
  // dry large surfaces stay matte (no sun glare: roughness >= 0.6); a water film makes them glossy,
  // puddles mirror-like
  float weatherWetRoughness(float r, WeatherWet w) {
    r = max(r, 0.6);
    r = mix(r, min(r, 0.28), w.wet);
    return mix(r, 0.035, w.puddle);
  }
  // view-space normal: flatten in puddles and add rain ripples
  vec3 weatherWetNormal(vec3 n, WeatherWet w, mat4 viewM) {
    if (w.puddle < 0.01) return n;
    vec3 upV = normalize((viewM * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    n = normalize(mix(n, upV, w.puddle * 0.9));
    return normalize(n - (viewM * vec4(w.ripple.x, 0.0, w.ripple.y, 0.0)).xyz);
  }
  // how mirror-like the surface is (drives screen-space reflections), 0..1
  float weatherMirror(WeatherWet w) { return clamp(w.wet * 0.5 + w.puddle * 0.7, 0.0, 1.0); }
  #endif
`;

function decl(skip = '') {
  return Object.entries(WEATHER_GLSL_UNIFORMS)
    .filter(([n]) => !new RegExp(`uniform\\s+\\w+\\s+${n}\\b`).test(skip))
    .map(([n, t]) => `  uniform ${t} ${n};`).join('\n');
}

// GLSL helper injected into world materials (terrain, roads, buildings) for wet look + cloud shadows.
// Prefer `patchWeatherMaterial()` from src/weather/wetMaterial.js, which also avoids duplicate uniform declarations.
export const WEATHER_GLSL = `${decl()}\n${WEATHER_GLSL_FUNCTIONS}`;

// WEATHER_GLSL without the uniforms already declared in `source` (avoids redeclaration errors).
export function weatherGlslFor(source) { return `${decl(source)}\n${WEATHER_GLSL_FUNCTIONS}`; }
