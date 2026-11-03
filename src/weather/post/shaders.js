import { HAZE_GLSL } from '../skyShaders.js';

// Post-processing shaders for src/core/Renderer.js. All passes read the scene depth texture directly
// (no extra geometry passes): reversed float depth when EXT_clip_control is available.

export const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const DEPTH_GLSL = /* glsl */`
  uniform highp sampler2D tDepth;
  uniform mat4 uProj, uInvProj;
  uniform vec2 uNearFar;
  float rawDepth(vec2 uv) { return texture2D(tDepth, uv).r; }
  #ifdef REVERSED_DEPTH
    bool isSky(float d) { return d <= 0.0; }
    float ndcZ(float d) { return d; }
    float viewZ(float d) { float n = uNearFar.x, f = uNearFar.y; return -(f * n) / (d * (f - n) + n); }
  #else
    bool isSky(float d) { return d >= 1.0; }
    float ndcZ(float d) { return d * 2.0 - 1.0; }
    float viewZ(float d) { float n = uNearFar.x, f = uNearFar.y; return (n * f) / ((f - n) * d - f); }
  #endif
  vec3 viewPos(vec2 uv, float d) {
    float z = viewZ(d);
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc.x * -z / uProj[0][0], ndc.y * -z / uProj[1][1], z);
  }
  vec2 projUV(vec3 p) { vec4 c = uProj * vec4(p, 1.0); return c.xy / c.w * 0.5 + 0.5; }
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// ---------------------------------------------------------------- ambient occlusion (half res, depth only)
export const AO_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform vec2 uTexel;
  uniform float uRadius, uIntensity;
  varying vec2 vUv;
  #ifndef AO_SAMPLES
  #define AO_SAMPLES 10
  #endif
  // uTexel = one full-res depth texel. Every lookup is snapped to a texel centre, so a reconstructed position is
  // exactly where that depth was rasterised: half-res pixel centres sit on texel corners, and a position built
  // from the corner uv with the nearest texel's depth is off by up to half a texel along the depth gradient,
  // which on long grazing slopes (hills, distant lawns) read as horizontal AO stripes.
  vec2 snapUV(vec2 uv) { return (floor(uv / uTexel) + 0.5) * uTexel; }
  vec3 posAt(vec2 uv) { vec2 c = snapUV(uv); return viewPos(c, rawDepth(c)); }
  void main() {
    vec2 uv0 = snapUV(vUv);
    float d = rawDepth(uv0);
    if (isSky(d)) { gl_FragColor = vec4(1.0); return; }
    vec3 p = viewPos(uv0, d);
    if (-p.z > 220.0) { gl_FragColor = vec4(1.0); return; }
    vec3 pr = posAt(uv0 + vec2(uTexel.x, 0.0));
    vec3 pl = posAt(uv0 - vec2(uTexel.x, 0.0));
    vec3 pu = posAt(uv0 + vec2(0.0, uTexel.y));
    vec3 pd = posAt(uv0 - vec2(0.0, uTexel.y));
    vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
    vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
    vec3 n = normalize(cross(dx, dy));
    float rad = uRadius * (1.0 + -p.z * 0.012);
    vec2 uvRad = 0.5 * vec2(uProj[0][0], uProj[1][1]) * rad / -p.z;
    float noise = ign(gl_FragCoord.xy);
    float occ = 0.0;
    for (int i = 0; i < AO_SAMPLES; i++) {
      float fi = (float(i) + 0.5) / float(AO_SAMPLES);
      float ang = float(i) * 2.39996 + noise * 6.2831;
      vec2 suv = snapUV(uv0 + vec2(cos(ang), sin(ang)) * uvRad * mix(0.15, 1.0, fract(fi + noise * 0.618)));
      float sd = rawDepth(suv);
      if (isSky(sd)) continue;
      vec3 v = viewPos(suv, sd) - p;
      float vv = dot(v, v);
      float fall = max(0.0, 1.0 - vv / (rad * rad));
      occ += fall * max(0.0, dot(n, v) * inversesqrt(vv + 1e-4) - 0.12);
    }
    float ao = 1.0 - uIntensity * occ / float(AO_SAMPLES);
    ao = mix(ao, 1.0, smoothstep(120.0, 220.0, -p.z));
    gl_FragColor = vec4(clamp(ao, 0.0, 1.0), 1.0, 1.0, 1.0);
  }
`;

export const AO_BLUR_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform sampler2D tAO;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    float z0 = viewZ(rawDepth(vUv));
    float s = 0.0, w = 0.0;
    for (int y = -2; y < 2; y++) for (int x = -2; x < 2; x++) {
      vec2 o = (vec2(x, y) + 0.5) * uTexel;
      float z = viewZ(rawDepth(vUv + o));
      float k = 1.0 / (1e-3 + abs(z - z0) / max(-z0 * 0.03, 0.05));
      k = min(k, 1.0);
      s += texture2D(tAO, vUv + o).r * k;
      w += k;
    }
    gl_FragColor = vec4(s / max(w, 1e-4), 1.0, 1.0, 1.0);
  }
`;

// ---------------------------------------------------------------- screen-space reflections (half res)
// Mirror mask comes from the scene colour alpha: 1 = none, (0.5..1) = wet ground (strength 2*(1-a)), ~0 = water.
export const SSR_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform sampler2D tColor;
  uniform mat4 uView, uCamWorld;
  uniform float uMaxDist, uTime, uRain;
  varying vec2 vUv;
  #ifndef SSR_STEPS
  #define SSR_STEPS 20
  #endif
  float h2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    vec4 c0 = texture2D(tColor, vUv);
    bool water = c0.a < 0.25;
    float mirror = water ? 1.0 : clamp((1.0 - c0.a) * 2.0, 0.0, 1.0);
    if (mirror < 0.03) { gl_FragColor = vec4(0.0); return; }
    float d = rawDepth(vUv);
    if (isSky(d)) { gl_FragColor = vec4(0.0); return; }
    vec3 p = viewPos(vUv, d);
    vec3 wp = (uCamWorld * vec4(p, 1.0)).xyz;
    // flat surface normal + small perturbation (waves on water, ripples/roughness on wet asphalt)
    vec2 q = wp.xz * (water ? 0.35 : 1.7) + uTime * (water ? vec2(0.4, 0.3) : vec2(0.0));
    vec2 pert = (vec2(n2(q), n2(q + 17.3)) - 0.5) * (water ? 0.09 : 0.035 + 0.03 * uRain);
    vec3 n = normalize((uView * vec4(pert.x, 1.0, pert.y, 0.0)).xyz);
    vec3 vdir = normalize(p);
    vec3 r = reflect(vdir, n);
    float jit = ign(gl_FragCoord.xy);
    float tPrev = 0.0, tHit = -1.0;
    vec2 hitUV = vec2(0.0);
    for (int i = 0; i < SSR_STEPS; i++) {
      float s = (float(i) + jit) / float(SSR_STEPS);
      float t = 0.4 + uMaxDist * s * s;
      vec3 q3 = p + r * t;
      if (q3.z > -0.4) break;
      vec2 uv = projUV(q3);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      float sd = rawDepth(uv);
      if (!isSky(sd)) {
        float sz = viewZ(sd);
        float diff = sz - q3.z;
        float thick = 0.6 + t * 0.06;
        if (diff > 0.0 && diff < thick) {
          // binary refinement
          float a = tPrev, b = t;
          for (int k = 0; k < 4; k++) {
            float m = (a + b) * 0.5;
            vec3 qm = p + r * m;
            vec2 um = projUV(qm);
            if (viewZ(rawDepth(um)) - qm.z > 0.0) b = m; else a = m;
          }
          tHit = b;
          hitUV = projUV(p + r * b);
          break;
        }
      }
      tPrev = t;
    }
    if (tHit < 0.0) { gl_FragColor = vec4(0.0); return; }
    vec3 col = texture2D(tColor, hitUV).rgb;
    vec2 e = min(hitUV, 1.0 - hitUV);
    float w = smoothstep(0.0, 0.08, e.x) * smoothstep(0.0, 0.08, e.y);
    w *= 1.0 - smoothstep(uMaxDist * 0.6, uMaxDist, tHit);
    w *= smoothstep(-0.05, 0.15, -r.z + 0.2); // rays toward the camera are unreliable
    gl_FragColor = vec4(col * w, w);
  }
`;

// ---------------------------------------------------------------- god rays (quarter res) + sun visibility
export const RAYS_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform sampler2D tColor;
  uniform vec2 uSunUV;
  uniform float uAspect, uThreshold;
  varying vec2 vUv;
  #define RAY_SAMPLES 36
  void main() {
    vec2 delta = (uSunUV - vUv) / float(RAY_SAMPLES) * 0.92;
    vec2 uv = vUv + delta * ign(gl_FragCoord.xy);
    float acc = 0.0, decay = 1.0;
    for (int i = 0; i < RAY_SAMPLES; i++) {
      uv += delta;
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        if (isSky(rawDepth(uv))) {
          vec3 c = texture2D(tColor, uv).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float near = exp(-dot((uv - uSunUV) * vec2(uAspect, 1.0), (uv - uSunUV) * vec2(uAspect, 1.0)) * 18.0);
          acc += min(max(l - uThreshold, 0.0), 6.0) * near * decay;
        }
      }
      decay *= 0.975;
    }
    gl_FragColor = vec4(vec3(acc / float(RAY_SAMPLES)), 1.0);
  }
`;

export const SUNVIS_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform sampler2D tColor;
  uniform vec2 uSunUV;
  uniform float uAspect, uRef;
  varying vec2 vUv;
  void main() {
    float vis = 0.0;
    for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
      vec2 uv = uSunUV + vec2(float(x) / uAspect, float(y)) * 0.0024;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
      if (!isSky(rawDepth(uv))) continue;
      float l = dot(texture2D(tColor, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
      vis += smoothstep(uRef * 0.15, uRef * 0.6, l);
    }
    gl_FragColor = vec4(vis / 49.0, 0.0, 0.0, 1.0);
  }
`;

// ---------------------------------------------------------------- fog / mist / underwater (shared)
export const FOG_GLSL = /* glsl */`
  ${HAZE_GLSL}
  uniform vec3 uFogColor, uSunDirW, uCamPos, uMistGlow, uHazeNight;
  uniform float uFogDensity, uMist, uMistH, uUnder, uDayLight;
  uniform mat4 uCamWorldF;
  vec3 applyFog(vec3 col, vec2 uv, float d) {
    bool sky = isSky(d);
    vec3 vp = sky ? viewPos(uv, ${'0.5'}) : viewPos(uv, d);
    float dist = sky ? 4000.0 : length(vp);
    vec3 wdir = normalize((uCamWorldF * vec4(vp, 0.0)).xyz);
    // haze = the sky dome's horizon colour: atmosphere LUT + (night) moonlit sky and city glow
    vec3 hz = hazeColor(wdir, uSunDirW) + uHazeNight;
    if (!sky) {
      float vz = -vp.z;
      float f = 1.0 - exp(-uFogDensity * uFogDensity * vz * vz);
      col += f * (hz - uFogColor);
    }
    if (uMist > 0.0) {
      float H = uMistH;
      float y0 = max(uCamPos.y, 0.0);
      float dy = wdir.y * dist;
      float g = abs(dy / H) > 0.01 ? (1.0 - exp(-dy / H)) / (dy / H) : 1.0;
      float k = uMist * exp(-y0 / H) * dist * g;
      float m = 1.0 - exp(-k);
      col = mix(col, hz * 0.92 + uMistGlow, m);
    }
    if (uUnder > 0.0) {
      vec3 tint = vec3(0.015, 0.11, 0.12) * (0.08 + 0.9 * uDayLight);
      float u = 1.0 - exp(-(sky ? 200.0 : dist) * 0.07);
      col = mix(col * vec3(0.55, 0.85, 0.9), tint, u * uUnder);
    }
    return col;
  }
`;

// ---------------------------------------------------------------- HDR composite: AO + SSR + rays + fog
export const COMPOSITE_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform sampler2D tColor, tAO, tSSR, tRays;
  uniform mat4 uView;
  uniform float uAOStrength, uSSRStrength;
  uniform vec3 uRayColor;
  ${FOG_GLSL}
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tColor, vUv);
    vec3 col = c.rgb;
    // one bad shader elsewhere must not poison bloom for the whole screen
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    float d = rawDepth(vUv);
    #ifdef USE_AO
      float ao = texture2D(tAO, vUv).r;
      col *= mix(1.0, ao, uAOStrength);
    #endif
    #ifdef USE_SSR
      vec4 s = texture2D(tSSR, vUv);
      if (s.a > 0.002) {
        bool water = c.a < 0.25;
        float mirror = water ? 1.0 : clamp((1.0 - c.a) * 2.0, 0.0, 1.0);
        vec3 p = viewPos(vUv, d);
        vec3 n = normalize((uView * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        float nv = clamp(dot(n, -normalize(p)), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
        float k = clamp(F * (water ? 1.0 : 0.85) * mirror * s.a * uSSRStrength, 0.0, 1.0);
        col = mix(col, s.rgb / s.a, k);
      }
    #endif
    col = applyFog(col, vUv, d);
    #ifdef USE_RAYS
      col += texture2D(tRays, vUv).r * uRayColor;
    #endif
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---------------------------------------------------------------- final: lens, flare, motion blur, tone map, grade
export const FINAL_FRAG = /* glsl */`
  ${DEPTH_GLSL}
  uniform sampler2D tColor, tSunVis;
  uniform vec2 uResolution;
  uniform float uExposure, uAspect, uTime;
  uniform vec3 uLift, uGamma, uGain;
  uniform float uSat, uContrast, uVibrance, uVignette, uGrain, uNight, uFade, uWasted, uSplit;
  uniform float uLens;
  uniform vec2 uSunUV;
  uniform float uFlare;
  uniform vec3 uFlareCol;
  uniform mat4 uPrevVP, uCamWorld;
  uniform float uMB;
  uniform sampler2D tBloom;
  uniform float uBloom;
  #ifdef USE_FOG
  ${FOG_GLSL}
  #endif
  varying vec2 vUv;

  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

  // raindrops on the lens: xy = refraction offset, z = drop mask
  vec3 dropLayer(vec2 uv, float cells, float t, float amount, float seed) {
    vec2 p = uv * vec2(uAspect, 1.0) * cells;
    vec2 id = floor(p);
    vec2 f = fract(p) - 0.5;
    float h = hash12(id + seed);
    if (h > amount) return vec3(0.0);
    float life = fract(t * (0.05 + 0.05 * hash12(id + 3.7 + seed)) + h * 11.0);
    vec2 c = (vec2(hash12(id + 1.3 + seed), hash12(id + 2.9 + seed)) - 0.5) * 0.55;
    float slide = step(0.75, hash12(id + 5.1 + seed));
    c.y -= slide * life * 0.45;
    vec2 dv = f - c;
    float r = 0.1 + 0.17 * hash12(id + 9.9 + seed);
    float dd = length(dv * vec2(1.0, 0.85 + 0.3 * slide)) / r;
    float m = smoothstep(1.0, 0.8, dd);
    float fade = smoothstep(0.0, 0.08, life) * smoothstep(1.0, 0.55, life);
    // a drop is a tiny fisheye: it shows an inverted, wider view of what is around it
    vec2 off = -dv / r * 0.06 * (1.0 + dd * dd);
    off.x /= uAspect;
    return vec3(off * m, m) * fade;
  }

  vec3 acesFit(vec3 c) {
    // Narkowicz-Hill fit, matching three's ACESFilmicToneMapping
    c *= 1.0 / 0.6;
    const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    c = m1 * c;
    vec3 a = c * (c + 0.0245786) - 0.000090537;
    vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
    return clamp(m2 * (a / b), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

  vec3 flare(vec2 uv) {
    vec2 asp = vec2(uAspect, 1.0);
    vec2 toC = vec2(0.5) - uSunUV;
    vec3 f = vec3(0.0);
    float ks[6] = float[6](0.35, 0.62, 0.9, 1.25, 1.5, 1.85);
    float ss[6] = float[6](0.035, 0.022, 0.06, 0.03, 0.09, 0.045);
    vec3 cs[6] = vec3[6](vec3(1.0, 0.55, 0.3), vec3(0.4, 1.0, 0.6), vec3(0.5, 0.6, 1.0), vec3(1.0, 0.4, 0.8), vec3(0.4, 0.8, 1.0), vec3(1.0, 0.8, 0.4));
    for (int i = 0; i < 6; i++) {
      vec2 gp = uSunUV + toC * ks[i] * 2.0;
      float dd = length((uv - gp) * asp);
      f += cs[i] * (smoothstep(ss[i], ss[i] * 0.55, dd) * 0.5 + smoothstep(ss[i] * 1.2, 0.0, dd) * 0.3) * 0.025;
    }
    // soft glow around the sun only (no streaks across the screen)
    vec2 sd = (uv - uSunUV) * asp;
    f += vec3(1.0, 0.85, 0.7) * exp(-length(sd) * 14.0) * 0.06;
    return f * uFlareCol;
  }

  void main() {
    vec2 uv = vUv;
    float dropMask = 0.0;
    #ifdef USE_LENS
      if (uLens > 0.01) {
        vec3 a = dropLayer(uv, 7.0, uTime, uLens * 0.55, 0.0);
        vec3 b = dropLayer(uv, 17.0, uTime * 1.3, uLens * 0.7, 7.1);
        vec3 dsum = a + b;
        uv += dsum.xy;
        dropMask = clamp(dsum.z, 0.0, 1.0);
      }
    #endif
    vec3 col;
    #ifdef USE_MBLUR
      vec3 base = texture2D(tColor, uv).rgb;
      col = base;
      if (uMB > 0.0) {
        float d = rawDepth(uv);
        vec3 vp = isSky(d) ? viewPos(uv, ${'0.5'}) * 1e4 : viewPos(uv, d);
        vec4 wp = uCamWorld * vec4(vp, 1.0);
        vec4 pc = uPrevVP * wp;
        vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
        vec2 vel = (uv - puv) * uMB * smoothstep(7.0, 20.0, -vp.z);
        float L = length(vel);
        if (L > 0.035) vel *= 0.035 / L;
        if (length(vel * uResolution) > 1.5) {
          vec3 acc = base; float jt = hash12(gl_FragCoord.xy) - 0.5;
          for (int i = 1; i < 8; i++) {
            float k = (float(i) + jt) / 7.0 - 0.5;
            acc += texture2D(tColor, uv - vel * k).rgb;
          }
          col = acc / 8.0;
        }
      }
    #else
      col = texture2D(tColor, uv).rgb;
    #endif
    #ifdef USE_CA
      // tiny lens-edge chromatic aberration (ultra only)
      vec2 dc = vUv - 0.5;
      vec2 off = dc * dot(dc, dc) * 0.004;
      col.r = mix(col.r, texture2D(tColor, uv + off).r, 0.8);
      col.b = mix(col.b, texture2D(tColor, uv - off).b, 0.8);
    #endif
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    #ifdef USE_BLOOM
      col += texture2D(tBloom, uv).rgb * uBloom;
    #endif
    #ifdef USE_FOG
      col = applyFog(col, uv, rawDepth(uv));
    #endif
    #ifdef USE_FLARE
      if (uFlare > 0.001) col += flare(vUv) * uFlare * texture2D(tSunVis, vec2(0.5)).r;
    #endif
    #ifdef USE_LENS
      col *= 1.0 + dropMask * 0.06;
    #endif
    // tone map + output transfer
    col = toSRGB(acesFit(col * uExposure));
    // grade: lift/gamma/gain, saturation/vibrance, split toning, contrast
    col = pow(max(col * uGain + uLift * (1.0 - col), 0.0), 1.0 / uGamma);
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
    col = mix(vec3(l), col, uSat + uVibrance * (1.0 - sat));
    col += (vec3(1.0, 0.55, 0.35) * smoothstep(0.55, 1.0, l) * 0.035 + vec3(-0.02, 0.01, 0.045) * (1.0 - smoothstep(0.0, 0.45, l))) * uSplit;
    col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
    vec2 dv = vUv - 0.5;
    col *= 1.0 - uVignette * smoothstep(0.12, 0.65, dot(dv, dv) * 1.4);
    #ifdef USE_GRAIN
      col += (hash12(gl_FragCoord.xy + fract(uTime * 7.13) * 100.0) - 0.5) * uGrain * (1.0 - l * 0.6);
    #endif
    // wasted: desaturate + red tint, fade to black
    float g = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(g) * vec3(1.05, 0.92, 0.9), uWasted);
    col = mix(col, vec3(0.0), uFade);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;
