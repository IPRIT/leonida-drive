import * as THREE from 'three';

// Single-scattering atmosphere (Rayleigh + Mie + ozone absorption, spherical planet, Earth shadow) in km units.
// GPU: a small sky-view LUT re-rendered when the sun / haze changes. CPU: the same model for light colours.
export const ATMO = {
  Rg: 6360, Rt: 6460,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3], hR: 8,
  mieScat: 3.996e-3, mieExt: 4.44e-3, hM: 1.2, g: 0.8,
  ozone: [0.65e-3, 1.881e-3, 0.085e-3],
};

export const ATMO_GLSL = /* glsl */`
  #define A_PI 3.14159265
  const float Rg = ${ATMO.Rg.toFixed(1)};
  const float Rt = ${ATMO.Rt.toFixed(1)};
  const vec3 bR = vec3(${ATMO.rayleigh.map((v) => v.toExponential(4)).join(', ')});
  const vec3 bO = vec3(${ATMO.ozone.map((v) => v.toExponential(4)).join(', ')});
  const float bMs = ${ATMO.mieScat.toExponential(4)};
  const float bMe = ${ATMO.mieExt.toExponential(4)};
  uniform float uHaze;
  float raySphere(vec3 ro, vec3 rd, float r) { // far hit, -1 if none
    float b = dot(ro, rd); float c = dot(ro, ro) - r * r; float d = b * b - c;
    if (d < 0.0) return -1.0; return -b + sqrt(d);
  }
  float raySphereNear(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd); float c = dot(ro, ro) - r * r; float d = b * b - c;
    if (d < 0.0) return -1.0; float t = -b - sqrt(d); return t;
  }
  vec3 densities(float h) { // rayleigh, mie, ozone
    return vec3(exp(-h / ${ATMO.hR.toFixed(1)}), exp(-h / ${ATMO.hM.toFixed(1)}) * uHaze, max(0.0, 1.0 - abs(h - 25.0) / 15.0));
  }
  vec3 extinction(vec3 d) { return bR * d.x + vec3(bMe) * d.y + bO * d.z; }
  vec3 sunTransmittance(vec3 p, vec3 sun) {
    if (raySphereNear(p, sun, Rg) > 0.0) return vec3(0.0);
    float tMax = raySphere(p, sun, Rt);
    vec3 od = vec3(0.0);
    const int N = 8;
    float dt = tMax / float(N);
    for (int i = 0; i < N; i++) {
      vec3 q = p + sun * (float(i) + 0.5) * dt;
      od += extinction(densities(length(q) - Rg)) * dt;
    }
    return exp(-od);
  }
`;

// Sky-view LUT: x = azimuth relative to the sun (0..pi), y = view elevation (non-linear around the horizon).
export const SKY_LUT_FRAG = /* glsl */`
  precision highp float;
  ${ATMO_GLSL}
  uniform float uSunEl, uCamAlt, uHorizon, uMs, uExposure;
  varying vec2 vUv;
  void main() {
    float az = vUv.x * A_PI;
    float el;
    if (vUv.y >= 0.5) { float c = (vUv.y - 0.5) * 2.0; el = uHorizon + c * c * (A_PI * 0.5 - uHorizon); }
    else { float c = (0.5 - vUv.y) * 2.0; el = uHorizon - c * c * (A_PI * 0.5 + uHorizon); }
    vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
    vec3 sun = vec3(cos(uSunEl), sin(uSunEl), 0.0);
    vec3 ro = vec3(0.0, Rg + uCamAlt, 0.0);
    float tG = raySphereNear(ro, dir, Rg);
    float tMax = tG > 0.0 ? tG : raySphere(ro, dir, Rt);
    tMax = min(tMax, 900.0);
    float mu = dot(dir, sun);
    float pR = 3.0 / (16.0 * A_PI) * (1.0 + mu * mu);
    float g = ${ATMO.g.toFixed(2)};
    float pM = 3.0 / (8.0 * A_PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    vec3 L = vec3(0.0), T = vec3(1.0);
    const int N = 28;
    float tPrev = 0.0;
    for (int i = 0; i < N; i++) {
      float s = (float(i) + 0.5) / float(N);
      float t = tMax * s * s;
      float dt = t - tPrev; tPrev = t;
      vec3 p = ro + dir * t;
      vec3 d = densities(length(p) - Rg);
      vec3 ext = extinction(d);
      vec3 Ts = sunTransmittance(p, sun);
      vec3 sR = bR * d.x, sM = vec3(bMs * d.y);
      vec3 S = (sR * pR + sM * pM) * Ts + (sR + sM) * uMs * (0.25 + 0.75 * Ts);
      vec3 Tstep = exp(-ext * dt);
      L += T * (S - S * Tstep) / max(ext, vec3(1e-7));
      T *= Tstep;
    }
    gl_FragColor = vec4(L * uExposure, 1.0);
  }
`;

// LUT lookup used by the sky dome, water and post fog (needs uSkyLut, uSunDir, uLutHorizon).
export const SKY_LUT_LOOKUP = /* glsl */`
  vec3 skyLut(sampler2D lut, vec3 d, vec3 sunDir, float horizon) {
    vec2 a = normalize(d.xz + vec2(1e-5, 0.0)), b = normalize(sunDir.xz + vec2(1e-5, 0.0));
    float u = acos(clamp(dot(a, b), -1.0, 1.0)) / 3.14159265;
    float el = asin(clamp(d.y, -1.0, 1.0));
    float v = el >= horizon ? 0.5 + 0.5 * sqrt((el - horizon) / (1.5707963 - horizon))
                            : 0.5 - 0.5 * sqrt((horizon - el) / (1.5707963 + horizon));
    return texture2D(lut, vec2(u, v)).rgb;
  }
`;

// ---------------------------------------------------------------- CPU side
function dens(h, haze) {
  return [Math.exp(-h / ATMO.hR), Math.exp(-h / ATMO.hM) * haze, Math.max(0, 1 - Math.abs(h - 25) / 15)];
}
function ext(d, out) {
  for (let c = 0; c < 3; c++) out[c] = ATMO.rayleigh[c] * d[0] + ATMO.mieExt * d[1] + ATMO.ozone[c] * d[2];
  return out;
}
const _e = [0, 0, 0];

// Transmittance from altitude altKm towards a direction with elevation `el` (radians). Includes the
// Earth's shadow with a soft edge (sun disc ~0.5°).
export function transmittance(altKm, el, haze = 1, out = new THREE.Vector3()) {
  const r = ATMO.Rg + altKm;
  const horizon = -Math.acos(ATMO.Rg / r);
  const vis = THREE.MathUtils.smoothstep(el, horizon - 0.006, horizon + 0.006);
  if (vis <= 0) return out.set(0, 0, 0);
  const elc = Math.max(el, horizon + 0.0005);
  const dy = Math.sin(elc), dx = Math.cos(elc);
  // distance to the top of the atmosphere
  const b = r * dy, c = r * r - ATMO.Rt * ATMO.Rt;
  const tMax = -b + Math.sqrt(b * b - c);
  const N = 24;
  const od = [0, 0, 0];
  let tPrev = 0;
  for (let i = 0; i < N; i++) {
    const s = (i + 0.5) / N, t = tMax * s * s, dt = t - tPrev; tPrev = t;
    const px = dx * t, py = r + dy * t;
    const h = Math.hypot(px, py) - ATMO.Rg;
    ext(dens(h, haze), _e);
    od[0] += _e[0] * dt; od[1] += _e[1] * dt; od[2] += _e[2] * dt;
  }
  return out.set(Math.exp(-od[0]) * vis, Math.exp(-od[1]) * vis, Math.exp(-od[2]) * vis);
}

const _ts = new THREE.Vector3();
const _e2 = [0, 0, 0];
// Sky radiance for a view direction (elevation, azimuth relative to the sun) — CPU twin of SKY_LUT_FRAG.
export function skyRadiance(viewEl, relAz, sunEl, haze, ms, camAlt = 0.3, out = new THREE.Vector3()) {
  const dir = [Math.cos(viewEl) * Math.cos(relAz), Math.sin(viewEl), Math.cos(viewEl) * Math.sin(relAz)];
  const sun = [Math.cos(sunEl), Math.sin(sunEl), 0];
  const ro = [0, ATMO.Rg + camAlt, 0];
  const b = ro[1] * dir[1];
  const c = ro[1] * ro[1] - ATMO.Rt * ATMO.Rt;
  let tMax = -b + Math.sqrt(b * b - c);
  const cg = ro[1] * ro[1] - ATMO.Rg * ATMO.Rg, dg = b * b - cg;
  if (dg > 0 && -b - Math.sqrt(dg) > 0) tMax = -b - Math.sqrt(dg);
  tMax = Math.min(tMax, 900);
  const mu = dir[0] * sun[0] + dir[1] * sun[1];
  const pR = 3 / (16 * Math.PI) * (1 + mu * mu);
  const g = ATMO.g;
  const pM = 3 / (8 * Math.PI) * ((1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
  const L = [0, 0, 0], T = [1, 1, 1];
  const N = 16;
  let tPrev = 0;
  for (let i = 0; i < N; i++) {
    const s = (i + 0.5) / N, t = tMax * s * s, dt = t - tPrev; tPrev = t;
    const px = dir[0] * t, py = ro[1] + dir[1] * t, pz = dir[2] * t;
    const rr = Math.hypot(px, py, pz);
    const h = rr - ATMO.Rg;
    const d = dens(h, haze);
    ext(d, _e2);
    // sun elevation seen from this point (local vertical differs slightly)
    const up = [px / rr, py / rr, pz / rr];
    const sunLocalEl = Math.asin(Math.max(-1, Math.min(1, up[0] * sun[0] + up[1] * sun[1] + up[2] * sun[2])));
    transmittance(h, sunLocalEl, haze, _ts);
    for (let k = 0; k < 3; k++) {
      const sR = ATMO.rayleigh[k] * d[0], sM = ATMO.mieScat * d[1];
      const tsk = k === 0 ? _ts.x : k === 1 ? _ts.y : _ts.z;
      const S = (sR * pR + sM * pM) * tsk + (sR + sM) * ms * (0.25 + 0.75 * tsk);
      const e = Math.max(_e2[k], 1e-7);
      const Tst = Math.exp(-e * dt);
      L[k] += T[k] * (S - S * Tst) / e;
      T[k] *= Tst;
    }
  }
  return out.set(L[0], L[1], L[2]);
}

export function horizonAngle(camAltKm) {
  return -Math.acos(ATMO.Rg / (ATMO.Rg + camAltKm));
}
