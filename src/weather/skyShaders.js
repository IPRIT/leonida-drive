import * as THREE from 'three';
import { WEATHER_GLSL, WEATHER_GLSL_FUNCTIONS } from '../core/globals.js';
import { SKY_LUT_LOOKUP } from './atmosphere.js';

// Shared haze colour: clear-sky LUT near the horizon, greyed by overcast.
export const HAZE_GLSL = /* glsl */`
  uniform sampler2D uSkyLut;
  uniform float uLutHorizon;
  uniform vec3 uOvercastCol;
  uniform float uOvercastAmt;
  ${SKY_LUT_LOOKUP}
  vec3 hazeColor(vec3 d, vec3 sunDir) {
    vec3 h = normalize(vec3(d.x, max(d.y, 0.012), d.z));
    vec3 l = skyLut(uSkyLut, h, sunDir, uLutHorizon);
    // under a cloud deck the bright clear-sky glow (sunset!) must not dominate the haze colour
    l *= 1.0 / (1.0 + dot(l, vec3(0.3, 0.5, 0.2)) * uOvercastAmt * 4.0);
    return mix(l, uOvercastCol, uOvercastAmt);
  }
`;

// Sky dome: atmosphere LUT + sun/moon/stars/milky way + cirrus + 2.5D lit cumulus layer.
// Defines: ENV (low-cost variant for the reflection probe), CLOUD_Q 1..3, REVERSED_DEPTH.
export const DOME_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    #if defined(ENV) || defined(REVERSED_DEPTH)
      gl_Position = vec4(p.xy, 0.0, p.w);
    #else
      gl_Position = p.xyww;
    #endif
  }
`;

export const DOME_FRAG = /* glsl */`
  ${WEATHER_GLSL}
  ${HAZE_GLSL}
  uniform sampler2D uNoise;
  uniform vec3 uCamPos;
  uniform vec3 uMoonDir, uMoonLight;
  uniform vec3 uSunDisc, uSunCloud, uSunCirrus;
  uniform vec3 uAmbTop, uAmbBottom, uCityGlow, uGround, uNightSky;
  uniform float uNight, uStars, uCirrus, uCloudDark, uMoonBright, uSkyTime;
  uniform mat3 uStarRot;
  uniform vec3 uFlashDir;
  varying vec3 vDir;

  float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
  float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
  // distance from the camera to a spherical layer at altitude h (m), earth radius 6360 km
  float layerDist(vec3 d, float h) {
    float R = 6360000.0, r0 = R + max(uCamPos.y, 0.0), r1 = R + h;
    float b = r0 * d.y; float c = r0 * r0 - r1 * r1;
    return -b + sqrt(max(b * b - c, 0.0));
  }
  float cumulusDensity(vec2 xz, float lod) {
    float cov = cloudCoverage(xz);
    #if CLOUD_Q >= 2
      vec2 uv = (xz + uCloudOffset * 0.3) / 2400.0;
      float n1 = texture2D(uNoise, uv, lod).g;
      float n2 = texture2D(uNoise, uv * 3.1 + vec2(0.37, 0.71) + uSkyTime * 0.0021, lod).b;
      float det = smoothstep(0.15, 0.85, n1 * 0.65 + n2 * 0.35);
      return clamp(cov * 1.4 - (1.0 - det) * (0.8 - 0.5 * uCloudCover), 0.0, 1.0);
    #else
      return cov;
    #endif
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 sunDir = uSunDir;
    vec3 col = skyLut(uSkyLut, d, sunDir, uLutHorizon);
    float skyLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    // night: airglow + Vice City light pollution near the horizon
    float up = max(d.y, 0.0);
    col += uCityGlow * (exp(-up * 7.0) * 0.8 + 0.2 * exp(-up * 1.5));
    // moonlit night sky: deep blue, a bit brighter toward the horizon (readable GTA-style night)
    col += uNightSky * mix(1.0, 0.45, sqrt(up));

    float mu = dot(d, sunDir);
    // stars + milky way
    #ifndef ENV
    if (uStars > 0.003 && d.y > -0.02) {
      vec3 sd = uStarRot * d;
      float vis = uStars * clamp(1.0 - skyLum * 30.0, 0.0, 1.0) * smoothstep(-0.02, 0.2, d.y);
      vec3 q = sd * 230.0;
      vec3 c = floor(q);
      float h = hash13(c);
      if (h > 0.972) {
        vec3 sp = vec3(hash13(c + 1.7), hash13(c + 5.3), hash13(c + 9.1)) * 0.6 + 0.2;
        float dd = length(fract(q) - sp);
        float mag = pow((h - 0.972) / 0.028, 4.0);
        float tw = 0.75 + 0.25 * sin(uSkyTime * (2.0 + h * 9.0) + h * 300.0);
        vec3 tint = mix(vec3(1.0, 0.82, 0.62), vec3(0.7, 0.82, 1.0), hash13(c + 3.3));
        col += tint * smoothstep(0.16, 0.0, dd) * (0.02 + 0.6 * mag) * tw * vis;
      }
      // milky way band with dust lanes
      vec3 mwN = normalize(vec3(0.3, 0.55, 0.78));
      float b = dot(sd, mwN);
      float band = exp(-b * b / 0.018);
      vec2 mw = vec2(atan(sd.z, sd.x), b) * vec2(1.3, 6.0);
      float n = texture2D(uNoise, mw * 0.35).r * 0.6 + texture2D(uNoise, mw * 1.1).b * 0.4;
      float dust = smoothstep(0.35, 0.75, texture2D(uNoise, mw * 0.6 + 0.3).g);
      col += vec3(0.010, 0.011, 0.014) * band * (0.4 + n) * (1.0 - 0.7 * dust) * vis;
    }
    // sun disc with limb darkening + glare
    if (mu > 0.9995) {
      float r = sqrt(max(0.0, 1.0 - mu)) / sqrt(1.0 - 0.99989);
      float disc = smoothstep(1.05, 0.92, r);
      col += uSunDisc * disc * (0.55 + 0.45 * sqrt(max(0.0, 1.0 - r * r)));
    }
    col += uSunDisc * 0.0002 * pow(max(mu, 0.0), 300.0);
    // moon with phase (lit by the sun-side direction uMoonLight), maria from the noise texture, faint earthshine
    float md = dot(d, uMoonDir);
    if (md > 0.9997 && uMoonBright > 0.0) {
      vec3 rt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
      vec3 ut = cross(rt, uMoonDir);
      vec2 p = vec2(dot(d, rt), dot(d, ut)) / 0.0105;
      float rr = dot(p, p);
      if (rr < 1.0) {
        vec3 n = rt * p.x + ut * p.y - uMoonDir * sqrt(1.0 - rr);
        float lit = smoothstep(-0.03, 0.08, dot(n, uMoonLight));
        float maria = texture2D(uNoise, p * 0.23 + 0.5).r * 0.6 + texture2D(uNoise, p * 0.5 + 0.2).b * 0.4;
        vec3 alb = vec3(0.92, 0.9, 0.86) * (0.62 + 0.5 * smoothstep(0.35, 0.7, maria));
        float edge = smoothstep(1.0, 0.9, rr);
        col = mix(col, col * 0.3, edge * (1.0 - lit) * 0.6);
        col += alb * (lit * uMoonBright + 0.008) * edge;
      }
    }
    col += vec3(0.6, 0.7, 0.9) * pow(max(md, 0.0), 120.0) * 0.012 * uMoonBright * uNight;
    #endif

    vec3 haze = hazeColor(d, sunDir);
    if (d.y > 0.0) {
      // ---- cirrus (8 km)
      if (uCirrus > 0.01) {
        float tc = layerDist(d, 8000.0);
        vec2 xc = uCamPos.xz + d.xz * tc + uCloudOffset * 1.7;
        vec2 uc = vec2(xc.x * 0.8 + xc.y * 0.6, -xc.x * 0.6 + xc.y * 0.8) / vec2(26000.0, 7000.0);
        float ci = texture2D(uNoise, uc).r * 0.7 + texture2D(uNoise, uc * vec2(2.3, 5.0) + 0.21).a * 0.3;
        ci = smoothstep(0.52, 0.9, ci) * uCirrus * smoothstep(0.0, 0.08, d.y);
        float fadeC = exp(-tc / 90000.0);
        vec3 ccol = uSunCirrus * (0.06 + hg(mu, 0.55) * 1.2) + uAmbTop * 0.9;
        col = mix(col, ccol, ci * 0.55 * fadeC);
      }
      #if CLOUD_Q > 0
      // ---- cumulus layer (1.6 km), 2.5D lit
      float t = layerDist(d, W_CLOUD_HEIGHT);
      vec2 xz = uCamPos.xz + d.xz * t;
      float lod = clamp(log2(t / 2500.0), 0.0, 5.0);
      float dens = cumulusDensity(xz, lod);
      if (dens > 0.002) {
        vec2 sd2 = normalize(sunDir.xz + vec2(1e-4, 0.0));
        float od = 0.0;
        #if CLOUD_Q >= 3
          float stepL = 140.0 + 260.0 * (1.0 - abs(sunDir.y));
          od += cumulusDensity(xz + sd2 * stepL, lod + 1.0);
          od += cumulusDensity(xz + sd2 * stepL * 2.4, lod + 1.5);
          od += cumulusDensity(xz + sd2 * stepL * 4.2, lod + 2.0) * 0.7;
          od *= 0.75;
        #elif CLOUD_Q == 2
          od = cumulusDensity(xz + sd2 * 260.0, lod + 1.0) * 1.6;
        #else
          od = dens * 1.3;
        #endif
        float thick = 0.6 + 1.6 * uCloudCover;
        float odL = od * thick;
        // single scattering + a cheap multiple-scattering octave (keeps sunlit clouds white, bases grey)
        float beer = exp(-odL * 1.3) + 0.55 * exp(-odL * 0.3);
        float powder = 1.0 - exp(-dens * 3.0);
        float phase = hg(mu, 0.6) * 0.6 + hg(mu, -0.2) * 0.4;
        // silver lining: thin cloud edges light up when looking toward the sun
        float silver = exp(-dens * 3.5) * smoothstep(0.0, 0.35, dens) * hg(mu, 0.88) * 1.6;
        vec3 sunL = uSunCloud * (beer * (powder * 0.6 + 0.4) * (0.45 + phase * 5.0) + silver * 3.0);
        vec3 amb = mix(uAmbBottom, uAmbTop, 0.6 - 0.45 * dens);
        vec3 cc = sunL + amb * (1.0 - 0.3 * dens);
        cc *= 1.0 - uCloudDark * (0.35 + 0.45 * dens);
        // lightning lights the clouds from inside
        cc += vec3(0.7, 0.78, 1.0) * uLightning * (0.25 + 1.6 * pow(max(dot(d, uFlashDir), 0.0), 6.0)) * (0.4 + dens);
        float alpha = smoothstep(0.03, 0.32, dens) * smoothstep(0.0, 0.035, d.y);
        float fogT = 1.0 - exp(-t / 42000.0);
        cc = mix(cc, haze, fogT);
        col = mix(col, cc, alpha * (1.0 - fogT * 0.55));
      }
      #endif
      // weather haze over everything near the horizon (overcast / rain / fog)
      col = mix(col, haze, uOvercastAmt * exp(-d.y * 9.0) * 0.8);
    } else {
      // below the horizon (seen from altitude past the far plane / the edge of the sea): the colour the distant haze
      // converges to (night sky + city glow included, as just above the horizon), into the ground colour only well
      // below it - no dark band between the end of the world and the sky
      vec3 hzn = haze + uCityGlow + uNightSky;
      col = mix(hzn, uGround, smoothstep(-0.03, -0.3, d.y));
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Tileable noise texture (R: fbm, G: inverted worley (billows), B: high-frequency fbm, A: streaks), made on the GPU once.
const NOISE_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p, float per) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = hash(mod(i, per)), b = hash(mod(i + vec2(1, 0), per)), c = hash(mod(i + vec2(0, 1), per)), d = hash(mod(i + vec2(1, 1), per));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p, float per, int oct) {
    float s = 0.0, a = 0.5, n = 0.0;
    for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vnoise(p, per); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }
    return s / n;
  }
  float worley(vec2 p, float per) {
    vec2 i = floor(p), f = fract(p); float m = 1.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(x, y); vec2 c = mod(i + o, per);
      vec2 r = o + vec2(hash(c + 0.17), hash(c + 3.71)) - f;
      m = min(m, dot(r, r));
    }
    return sqrt(m);
  }
  void main() {
    vec2 p = vUv;
    float r = fbm(p * 8.0, 8.0, 6);
    float w = 1.0 - (worley(p * 6.0, 6.0) * 0.6 + worley(p * 13.0, 13.0) * 0.3 + worley(p * 27.0, 27.0) * 0.1);
    w = clamp(w * 1.15 + (fbm(p * 16.0, 16.0, 3) - 0.5) * 0.4, 0.0, 1.0);
    float b = fbm(p * 32.0, 32.0, 4);
    float s = fbm(vec2(p.x * 4.0, p.y * 32.0), 4.0, 5) * 0.5 + fbm(vec2(p.x * 8.0, p.y * 64.0), 8.0, 4) * 0.5;
    gl_FragColor = vec4(r, w, b, s);
  }
`;

export function makeNoiseTexture(renderer, size = 256) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false,
  });
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: NOISE_FRAG, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(quad, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.geometry.dispose();
  rt.texture.anisotropy = 4;
  return rt;
}

// Cone/cosine filter for the sky reflection probe (one mip level per draw).
export const PROBE_VERT = /* glsl */`
  varying vec3 vWorldDirection;
  void main() {
    vWorldDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
    vec4 p = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_Position = vec4(p.xy, 0.0, p.w);
  }
`;
export const PROBE_FRAG = /* glsl */`
  uniform samplerCube uSrc;
  uniform float uSpread, uSrcLod, uCosine;
  uniform int uCount;
  varying vec3 vWorldDirection;
  void main() {
    vec3 N = normalize(vWorldDirection);
    if (uSpread <= 0.0) { gl_FragColor = vec4(textureLod(uSrc, N, uSrcLod).rgb, 1.0); return; }
    vec3 up = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(up, N)), B = cross(N, T);
    vec3 acc = vec3(0.0); float ws = 0.0;
    float n = float(uCount);
    for (int i = 0; i < 32; i++) {
      if (i >= uCount) break;
      float fi = float(i) + 0.5;
      float r = sqrt(fi / n) * uSpread;
      float ph = fi * 2.39996323;
      vec3 dir = normalize(N * cos(r) + (T * cos(ph) + B * sin(ph)) * sin(r));
      float w = mix(exp(-2.0 * r * r / max(uSpread * uSpread, 1e-4)), cos(r), uCosine);
      acc += textureLod(uSrc, dir, uSrcLod).rgb * w;
      ws += w;
    }
    gl_FragColor = vec4(acc / ws, 1.0);
  }
`;

export { WEATHER_GLSL_FUNCTIONS };
