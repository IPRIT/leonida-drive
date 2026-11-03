import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../core/globals.js';
import { patchWeather } from '../world/weatherPatch.js';
import { patchFakeLights } from '../world/fakeLights.js';

const U = GLOBAL_UNIFORMS;

// All landmark materials are created once at init. Day/night, blinking, animated LED bands and rotating beams
// are pure shader math on the global uniforms (uTime, uNight): no runtime material changes, no light objects.

// ---------- solid: every building / structure / aircraft surface ----------
// Vertex colours + aFx = (u, v, style, kind): facade coordinates in metres, pattern style and surface kind
// (see K in kit.js). Weather (wet look, cloud shadows) and fake lamp light are patched in.
const SOLID_FRAG = /* glsl */`
  float lmHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  #define LM_AASTEP(e, x, w) clamp(((x) - (e)) / (w) + 0.5, 0.0, 1.0)
  // band-limited window coverage in a (bay x floorH) grid; r = window rect inside the cell (x0, x1, y0, y1)
  float lmWindows(vec2 uv, vec2 cellSize, vec4 r, out vec2 cell, out float farX) {
    cell = floor(uv / cellSize);
    vec2 f = fract(uv / cellSize);
    vec2 pw = vec2(fwidth(uv.x) / cellSize.x, fwidth(uv.y) / cellSize.y) + 1e-4;
    farX = smoothstep(0.16, 0.5, pw.x);
    float farY = smoothstep(0.16, 0.5, pw.y);
    float wx = mix(LM_AASTEP(r.x, f.x, pw.x) * LM_AASTEP(f.x, r.y, pw.x), r.y - r.x, farX);
    float wy = mix(LM_AASTEP(r.z, f.y, pw.y) * LM_AASTEP(f.y, r.w, pw.y), r.w - r.z, farY);
    float w = wx * wy;
    return mix(w, (r.y - r.x) * (r.w - r.z), smoothstep(0.6, 1.6, max(pw.x, pw.y)));
  }
  vec3 lmHue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
`;

// Rotating parts (radar antennas, observation wheel): vertices with aFx.w >= 16 spin about pivot uSpin[i].xyz,
// axis uSpinAxis[i].xyz at uSpin[i].w rad/s (phase uSpinAxis[i].w), i = aFx.z; base kind = aFx.w - 16.
export const MAX_SPIN = 8;
export const SPIN_UNIFORMS = {
  uSpin: { value: Array.from({ length: MAX_SPIN }, () => new THREE.Vector4()) },
  uSpinAxis: { value: Array.from({ length: MAX_SPIN }, () => new THREE.Vector4(0, 1, 0, 0)) },
};

// Far silhouettes of every cluster live in one merged mesh; aClu (1-based cluster index, 0 = none) lets the
// vertex shader drop the far copy of clusters currently drawn in detail (uNearC[i] = 1).
export const MAX_CLUSTERS = 64;
export const LOD_UNIFORMS = { uNearC: { value: new Float32Array(MAX_CLUSTERS) } };

export function solidMaterial({ polygonOffset = false, side = THREE.FrontSide } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02, flatShading: true, side });
  if (polygonOffset) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -4; }
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uNight = U.uNight;
    Object.assign(sh.uniforms, SPIN_UNIFORMS, LOD_UNIFORMS);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aFx; attribute float aClu; uniform float uNearC[${MAX_CLUSTERS}];
        uniform float uTime; uniform vec4 uSpin[${MAX_SPIN}]; uniform vec4 uSpinAxis[${MAX_SPIN}];
        varying vec4 vFx; varying vec3 vLmW;`)
      .replace('#include <color_vertex>', `
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR )
          vColor = vec4( 1.0 );
        #endif
        #ifdef USE_COLOR
          vColor.rgb *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          // only livery parts (kind TINT) take the instance colour
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, step(8.5, aFx.w) * step(aFx.w, 9.5));
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFx = aFx;
        if (aClu > 0.5 && uNearC[int(aClu + 0.5)] > 0.5) transformed = vec3(0.0);
        if (aFx.w > 15.5) {
          int si = int(aFx.z + 0.5);
          vec4 P = uSpin[si]; vec4 A = uSpinAxis[si];
          float ang = uTime * P.w + A.w, c = cos(ang), s = sin(ang);
          vec3 v = transformed - P.xyz;
          transformed = P.xyz + v * c + cross(A.xyz, v) * s + A.xyz * dot(A.xyz, v) * (1.0 - c);
          vFx = vec4(aFx.xy, 0.0, aFx.w - 16.0);
        }
        #ifdef USE_INSTANCING
          vLmW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vLmW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; uniform float uTime;
        varying vec4 vFx; varying vec3 vLmW;
        ${SOLID_FRAG}
        vec3 gLmEm = vec3(0.0); float gLmRough = -1.0; float gLmMetal = -1.0; float gLmGlass = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float kind = floor(vFx.w + 0.5), style = floor(vFx.z + 0.5);
          vec2 uv = vFx.xy;
          float dist = length(vLmW - cameraPosition);
          if (kind == 1.0 || kind == 2.0) {
            // windows: (bay, floor) cell size and window rectangle per style
            vec2 cs = vec2(3.0, 3.6); vec4 r = vec4(0.2, 0.8, 0.28, 0.82);
            float litShare = 0.32; vec3 warm = vec3(1.0, 0.7, 0.4); float gl = 0.0;
            if (kind == 2.0) { cs = vec2(1.8, style == 1.0 ? 5.5 : 4.2); r = vec4(0.04, 0.96, 0.03, 0.97); litShare = style == 1.0 ? 1.0 : (style == 2.0 ? 0.0 : 0.35); gl = 1.0; }
            else if (style == 1.0) { cs = vec2(3.0, 3.2); r = vec4(0.24, 0.76, 0.3, 0.8); litShare = 0.45; }
            else if (style == 2.0) { cs = vec2(1.6, 3.8); r = vec4(0.05, 0.95, 0.12, 0.92); litShare = 0.3; warm = vec3(0.8, 0.86, 0.95); gl = 1.0; }
            else if (style == 3.0) { cs = vec2(3.6, 3.2); r = vec4(0.16, 0.84, 0.25, 0.85); litShare = 0.5; }
            else if (style == 4.0) { cs = vec2(6.0, 6.0); r = vec4(0.1, 0.9, 0.62, 0.86); litShare = 0.18; }
            else if (style == 5.0) { cs = vec2(2.4, 3.6); r = vec4(0.25, 0.75, 0.3, 0.75); litShare = 0.3; }
            else if (style == 6.0) { cs = vec2(8.0, 2.6); r = vec4(0.02, 0.98, 0.36, 1.02); litShare = 0.95; warm = vec3(0.75, 0.85, 0.9); }
            else if (style == 7.0) { cs = vec2(1.5, 4.0); r = vec4(0.04, 0.96, 0.06, 0.95); litShare = 0.38; warm = vec3(0.85, 0.88, 0.95); gl = 1.0; }
            vec2 cell; float farX;
            float w = lmWindows(uv, cs, r, cell, farX);
            if (style == 4.0 && kind == 1.0) w *= step(4.0, uv.y);
            vec2 seed = vec2(floor(vLmW.x * 0.03) * 17.0, floor(vLmW.z * 0.03) * 31.0);
            float h = lmHash(cell + seed);
            vec3 glassDay = kind == 2.0 ? diffuseColor.rgb : mix(vec3(0.14, 0.2, 0.27), vec3(0.42, 0.56, 0.68), mix(h, 0.5, farX) * 0.5 + gl * 0.35);
            vec3 gcol = mix(glassDay, vec3(0.03, 0.035, 0.05), uNight * (kind == 2.0 ? 0.85 : 1.0));
            if (kind == 2.0) {
              // mullions keep the frame colour (darker metal), panes take the glass tint
              diffuseColor.rgb = mix(vec3(0.16, 0.17, 0.18), gcol, w);
              gLmGlass = w;
            } else {
              diffuseColor.rgb = mix(diffuseColor.rgb, gcol, w);
              gLmGlass = w * (0.4 + 0.6 * gl);
            }
            float hB = lmHash(vec2(floor(cell.x / 4.0), cell.y) + seed + 3.7);
            float lit = mix(step(h, litShare), step(hB, litShare), farX);
            float glow = (kind == 2.0 && style == 1.0) ? 0.55 : (0.42 + 0.34 * mix(h, hB, farX));
            if (style == 6.0) glow = 0.22;
            gLmEm = warm * w * lit * glow * uNight * (1.0 - 0.25 * smoothstep(800.0, 4000.0, dist));
          } else if (kind == 3.0) {
            float pw = fwidth(uv.x) / 0.7;
            float rib = mix(step(0.5, fract(uv.x / 0.7)), 0.5, smoothstep(0.2, 0.6, pw));
            diffuseColor.rgb *= 0.9 + 0.12 * rib;
            gLmRough = 0.42; gLmMetal = 0.55;
          } else if (kind == 4.0) {
            float k = style == 2.0 ? 1.6 : (style == 1.0 ? 0.02 + 2.2 * uNight : 0.3 + 2.6 * uNight);
            gLmEm = diffuseColor.rgb * k;
          } else if (kind == 5.0) {
            vec2 cell = floor(uv / vec2(1.1, 1.0));
            float h = lmHash(cell + floor(vLmW.xz * 0.01) * 7.0);
            gLmEm = vec3(1.0, 0.78, 0.5) * step(h, 0.8) * (0.5 + 0.5 * h) * 1.4 * uNight;
            gLmGlass = 0.5;
          } else if (kind == 7.0) {
            // chain-link: diagonal wires; far away a sparse dither keeps a faint veil without shimmering
            vec2 q = uv / 0.32;
            float a = abs(fract(q.x + q.y) - 0.5), b = abs(fract(q.x - q.y) - 0.5);
            float pw = fwidth(q.x) + fwidth(q.y);
            float wire = 1.0 - smoothstep(0.0, 0.08 + pw * 0.5, min(a, b));
            if (pw > 0.35) wire = step(lmHash(gl_FragCoord.xy), 0.22);
            if (wire < 0.5) discard;
            gLmMetal = 0.4; gLmRough = 0.5;
          } else if (kind == 8.0) {
            vec3 c = diffuseColor.rgb;
            if (style == 0.0) c = mix(lmHue(fract(uTime * 0.035 + uv.x * 0.0035 + uv.y * 0.004)), vec3(1.0), 0.15);
            else if (style == 3.0) c = mix(c, lmHue(fract(uTime * 0.03 + uv.y * 0.006)), smoothstep(0.1, 0.6, uNight));
            else if (style == 1.0) c = mix(c, lmHue(fract(uTime * 0.02)), step(0.5, fract(uv.x * 0.025 - uTime * 0.35)));
            else c *= 0.65 + 0.35 * sin(uTime * 0.8 + uv.y * 0.05);
            diffuseColor.rgb = c * 0.6;
            gLmEm = c * (0.35 + 2.2 * uNight);
          } else if (kind == 10.0) {
            diffuseColor.rgb *= 0.9 + 0.1 * lmHash(floor(vLmW.xz * 0.5));
          } else if (kind == 11.0) {
            float pw = fwidth(uv.x) / 7.0;
            diffuseColor.rgb *= 0.93 + 0.09 * mix(step(0.5, fract(uv.x / 7.0)), 0.5, smoothstep(0.2, 0.6, pw));
            gLmRough = 0.95;
          }
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (gLmRough >= 0.0) roughnessFactor = gLmRough;
        roughnessFactor = mix(roughnessFactor, 0.1, gLmGlass);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (gLmMetal >= 0.0) metalnessFactor = gLmMetal;
        metalnessFactor = mix(metalnessFactor, 0.6, gLmGlass * (1.0 - uNight));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += gLmEm;`);
    patchWeather(sh, { worldPos: 'vLmW', porosity: 0.3 });
  };
  mat.customProgramCacheKey = () => `lmk-solid-3-${side}`;
  patchFakeLights(mat, { strength: 0.6 });
  return mat;
}

// ---------- signs: canvas atlas (see atlas.js) ----------
// aFx.w = 0 painted, 1 back-lit panel (whole face glows at night), 2 neon letters (atlas alpha > 0.6 glows),
// 3 cut-out letters (transparent atlas background is discarded, letters glow like 2).
export function signMaterial(texture, { polygonOffset = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ map: texture, vertexColors: true, roughness: 0.55, metalness: 0.0, alphaTest: 0.3, side: THREE.DoubleSide });
  if (polygonOffset) { mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -4; }
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.uniforms.uTime = U.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aFx; varying vec4 vFx; varying vec3 vSgW;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFx = aFx; vSgW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; uniform float uTime; varying vec4 vFx; varying vec3 vSgW; vec3 gSgEm = vec3(0.0);`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float kind = floor(vFx.w + 0.5);
          #ifdef USE_MAP
            float a = sampledDiffuseColor.a;
          #else
            float a = 1.0;
          #endif
          diffuseColor.a = kind > 2.5 ? a : 1.0;
          if (kind == 1.0) gSgEm = diffuseColor.rgb * (0.04 + 1.35 * uNight);
          else if (kind >= 2.0) {
            float fl = vFx.z > 0.5 ? (fract(sin(floor(uTime * 9.0) * 12.9898 + vFx.z * 78.233) * 43758.5453) < 0.12 ? 0.15 : 1.0) : 1.0;
            gSgEm = diffuseColor.rgb * smoothstep(0.62, 0.97, a) * (0.25 + 2.8 * uNight) * fl;
          }
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += gSgEm;`);
    patchWeather(sh, { worldPos: 'vSgW', porosity: 0.1, puddles: false });
  };
  mat.customProgramCacheKey = () => 'lmk-sign-1';
  return mat;
}

// ---------- light points: runway/taxiway/approach lights, aviation obstacle lights, beacons ----------
// aL = (size m, kind, phase, maxDist). kinds: 0 steady night light, 1 red obstacle blink (1 Hz), 2 sequenced
// strobe ("rabbit"), 3 rotating beacon (white/green alternate), 4 steady always-on, 5 slow blink (0.5 Hz)
export function lightsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uNight: U.uNight, uScale: { value: 800 }, uFog: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 color; attribute vec4 aL;
      uniform float uTime; uniform float uNight; uniform float uScale; uniform float uFog;
      varying vec3 vCol;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mv.z, 0.1);
        float kind = aL.y, ph = aL.z;
        float k = 0.0;
        if (kind < 0.5) k = smoothstep(0.15, 0.6, uNight) * 2.2 + 0.0;
        else if (kind < 1.5) k = step(0.5, fract(uTime * 1.0 + ph)) * (0.7 + 2.6 * uNight);
        else if (kind < 2.5) { float t = fract(uTime * 2.0 - ph); k = smoothstep(0.08, 0.0, t) * (1.2 + 5.0 * uNight); }
        else if (kind < 3.5) { float t = fract(uTime * 0.35 + ph); k = (smoothstep(0.06, 0.0, abs(t - 0.25)) + smoothstep(0.06, 0.0, abs(t - 0.75))) * (0.6 + 4.0 * uNight); }
        else if (kind < 4.5) k = 0.5 + 2.0 * uNight;
        else k = step(0.5, fract(uTime * 0.5 + ph)) * (0.5 + 2.4 * uNight);
        vec3 col = color;
        if (kind > 2.5 && kind < 3.5) col = fract(uTime * 0.35 + ph) < 0.5 ? vec3(1.0, 0.95, 0.85) : vec3(0.2, 1.0, 0.45);
        float px = aL.x * uScale / d;
        float size = max(px, 2.2);
        k *= clamp((px * px) / (size * size), 0.18, 1.0);
        k *= 1.0 - smoothstep(aL.w * 0.75, aL.w, d);
        k *= exp(-pow(uFog * d * 0.55, 2.0));
        vCol = col * k;
        gl_PointSize = min(size * 2.4, 44.0);
        gl_Position = projectionMatrix * mv;
        if (k < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c) * 4.0;
        float a = (exp(-r2 * 10.0) + 0.28 * exp(-r2 * 3.5)) * max(0.0, 1.0 - r2);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vCol * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// ---------- rotating light beams (lighthouses, airport beacon, prison searchlights) ----------
// aPivot = (x, y, z, speed rad/s); aBeam = (phase, mode, length, 0): mode 0 = continuous rotation, 1 = sweep ±0.9 rad
export function beamMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uNight: U.uNight, uFog: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec4 aPivot; attribute vec4 aBeam;
      uniform float uTime; uniform float uFog;
      varying float vAlong; varying float vEdge; varying float vFog;
      void main() {
        vec3 p = position - aPivot.xyz;
        float ang = aBeam.y < 0.5 ? uTime * aPivot.w + aBeam.x : aBeam.x + sin(uTime * aPivot.w) * 0.9;
        float c = cos(ang), s = sin(ang);
        p.xz = vec2(c * p.x - s * p.z, s * p.x + c * p.z);
        vec3 wp = aPivot.xyz + p;
        vec3 axis = normalize(vec3(c, 0.0, s) * (dot(p.xz, vec2(c, s)) < 0.0 ? -1.0 : 1.0));
        float along = dot(p, axis);
        vAlong = clamp(along / max(aBeam.z, 1.0), 0.0, 1.0);
        // radial direction of this vertex around the beam axis: bright where the surface faces the viewer
        vec3 rad = normalize(p - axis * along + vec3(0.0, 1e-4, 0.0));
        vec4 mv = viewMatrix * modelMatrix * vec4(wp, 1.0);
        vec3 radV = normalize(mat3(viewMatrix) * rad);
        vEdge = abs(dot(radV, normalize(-mv.xyz)));
        vFog = exp(-pow(uFog * -mv.z * 0.5, 2.0));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uNight;
      varying float vAlong; varying float vEdge; varying float vFog;
      void main() {
        float k = pow(1.0 - vAlong, 1.6) * vEdge * vEdge * smoothstep(0.0, 0.04, vAlong) * uNight * vFog;
        gl_FragColor = vec4(vec3(1.0, 0.95, 0.82) * k * 0.22, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// ---------- runways: exact rectangles with procedural ICAO-style markings ----------
// aRw = (s along the runway from threshold A in m, t across in m (+ = right of A->B), length, half width);
// aNumA / aNumB = atlas rects (u0, v0, u1, v1) of the designators read from each end. Shoulders |t| > hw,
// blast pads s < 0 or s > length (yellow chevrons).
export function runwayMaterial(atlas) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0, map: atlas, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aRw; attribute vec4 aNumA; attribute vec4 aNumB;
        varying vec4 vRw; varying vec4 vNumA; varying vec4 vNumB; varying vec3 vRwW;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRw = aRw; vNumA = aNumA; vNumB = aNumB; vRwW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying vec4 vRw; varying vec4 vNumA; varying vec4 vNumB; varying vec3 vRwW;
        float rwH(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float rwN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(rwH(i), rwH(i + vec2(1, 0)), f.x), mix(rwH(i + vec2(0, 1)), rwH(i + vec2(1, 1)), f.x), f.y); }
        // anti-aliased box [a, b] on coordinate x with pixel footprint w
        float rwBox(float x, float a, float b, float w) { return clamp((x - a) / w + 0.5, 0.0, 1.0) * clamp((b - x) / w + 0.5, 0.0, 1.0); }`)
      .replace('#include <map_fragment>', `
        {
          float s = vRw.x, t = vRw.y, L = vRw.z, hw = vRw.w;
          float ws = max(fwidth(s), 1e-3), wt = max(fwidth(t), 1e-3);
          bool endA = s < L * 0.5;
          float d = endA ? s : L - s;           // distance from the nearer threshold
          float tt = endA ? t : -t;             // lateral, + = pilot's right
          float at = abs(t);
          float white = 0.0, yellow = 0.0;
          // asphalt: subtle grain, darker rubber in the touchdown zones, lighter concrete shoulders / pads
          vec3 base = vec3(0.105, 0.108, 0.115) * (0.95 + 0.05 * rwN(vRwW.xz * 0.06) + 0.03 * rwN(vRwW.xz * 0.35));
          float rubber = smoothstep(120.0, 300.0, d) * (1.0 - smoothstep(700.0, 1000.0, d)) * (1.0 - smoothstep(4.0, 10.0, at));
          base *= 1.0 - 0.35 * rubber;
          if (at > hw) base = vec3(0.16, 0.16, 0.165);
          if (s < 0.0 || s > L) base = vec3(0.15, 0.15, 0.152);
          if (s >= 0.0 && s <= L) {
            // runway side stripes (0.9 m inside each edge)
            white = max(white, rwBox(at, hw - 1.4, hw - 0.5, wt));
            // threshold bar + piano keys (16 x 1.8 m, centre gap)
            white = max(white, rwBox(d, 1.0, 2.8, ws) * step(at, hw - 0.5));
            float key = rwBox(mod(at - 1.8, 3.6), 0.0, 1.8, wt) * step(1.8, at) * step(at, hw - 2.5);
            white = max(white, rwBox(d, 6.0, 36.0, ws) * key);
            // designator number from the atlas
            vec4 cell = endA ? vNumA : vNumB;
            if (d > 42.0 && d < 60.0 && abs(tt) < 5.0) {
              vec2 cuv = vec2(mix(cell.x, cell.z, (tt + 5.0) / 10.0), mix(cell.y, cell.w, (d - 42.0) / 18.0));
              float a = texture2D(map, cuv).a;
              white = max(white, smoothstep(0.62, 0.9, a));
            }
            // centreline: 30 m dashes / 20 m gaps between the designators
            if (d > 72.0) white = max(white, rwBox(at, -0.45, 0.45, wt) * rwBox(mod(s - 72.0, 50.0), 0.0, 30.0, ws) * step(72.0, L - s));
            // aiming point: two 45 m x 9 m blocks at 300 m
            white = max(white, rwBox(d, 300.0, 345.0, ws) * rwBox(at, hw * 0.26, hw * 0.26 + 9.0, wt));
            // touchdown zone bars at 150 / 450 / 600 / 750 / 900 m (3, 2, 2, 1, 1 bars each side)
            for (int k = 0; k < 5; k++) {
              float z0 = k == 0 ? 150.0 : 450.0 + float(k - 1) * 150.0;
              float nb = k == 0 ? 3.0 : (k < 3 ? 2.0 : 1.0);
              float zone = rwBox(d, z0, z0 + 22.5, ws);
              float bars = rwBox(at, hw * 0.26, hw * 0.26 + nb * 3.4 - 1.6, wt) * step(mod(at - hw * 0.26, 3.4), 1.8);
              white = max(white, zone * bars * step(z0 + 30.0, L * 0.5));
            }
          } else {
            // blast pad: yellow chevrons pointing at the runway
            float dd = s < 0.0 ? -s : s - L;
            float ch = mod(dd - at * 0.6, 30.0);
            yellow = rwBox(ch, 0.0, 1.0, ws * 1.5) * step(at, hw - 1.0) * step(4.0, dd);
          }
          // far away the stripes blend towards their coverage (no shimmering)
          float far = smoothstep(0.6, 3.0, max(ws, wt));
          white *= 1.0 - 0.6 * far;
          vec3 col = mix(base, vec3(0.86, 0.87, 0.86), white);
          col = mix(col, vec3(0.9, 0.7, 0.08), yellow);
          diffuseColor.rgb = col;
        }`);
    patchWeather(sh, { worldPos: 'vRwW', porosity: 0.15 });
  };
  mat.customProgramCacheKey = () => 'lmk-runway-2';
  return mat;
}

// ---------- parked vehicles, aircraft and boats (one BatchedMesh, see vehicles.js) ----------
// Traffic vertex layout: color, aPaint (1 = body paint, replaced by the per-instance batching colour), aEmit.x
// (lamp / lightbar: glows in its own colour, softly by day, more at night). Fake lamp light like traffic cars.
export function vehicleMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.42, metalness: 0.25 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.uniforms.uTime = U.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPaint; attribute vec2 aEmit;
        varying float vVhEmit; varying vec3 vVhLamp;`)
      .replace('#include <color_vertex>', `
        vColor = vec4(1.0);
        #ifdef USE_COLOR
          vColor.rgb *= color;
        #endif
        vVhLamp = vColor.rgb;
        #ifdef USE_BATCHING_COLOR
          vColor.rgb = mix(vColor.rgb, getBatchingColor(getIndirectIndex(gl_DrawID)).rgb, aPaint);
        #endif
        vVhEmit = aEmit.x;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight; uniform float uTime; varying float vVhEmit; varying vec3 vVhLamp;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vVhLamp * vVhEmit * (0.35 + 1.6 * uNight) * (0.85 + 0.15 * sin(uTime * 2.4));`);
  };
  mat.customProgramCacheKey = () => 'lmk-vehicle-1';
  patchFakeLights(mat);
  // fake lamp light needs the world position: under batching the instance matrix is batchingMatrix
  const fl = mat.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    fl.call(this, sh, r);
    sh.vertexShader = sh.vertexShader.replace('vFLWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;', `
      #ifdef USE_BATCHING
        vFLWorld = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vFLWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`);
  };
  return mat;
}
