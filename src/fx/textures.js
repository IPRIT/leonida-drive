import * as THREE from 'three';

// Procedural textures shared by all FX systems (generated once, tiny).

let _noise = null;

// Tileable fBm value noise, 4 decorrelated channels (RGBA), 128x128.
export function noiseTexture() {
  if (_noise) return _noise;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  for (let ch = 0; ch < 4; ch++) {
    const oct = [];
    for (let o = 0; o < 5; o++) {
      const g = 4 << o;
      const grid = new Float32Array(g * g);
      let s = (ch + 1) * 9301 + o * 49297;
      for (let i = 0; i < grid.length; i++) { s = (s * 1103515245 + 12345) >>> 0; grid[i] = (s >>> 8) / 16777216; }
      oct.push({ g, grid });
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let v = 0, amp = 0.5, tot = 0;
        for (const { g, grid } of oct) {
          const fx = (x / N) * g, fy = (y / N) * g;
          const ix = Math.floor(fx), iy = Math.floor(fy);
          const tx = fx - ix, ty = fy - iy;
          const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
          const a = grid[(iy % g) * g + (ix % g)], b = grid[(iy % g) * g + ((ix + 1) % g)];
          const c = grid[((iy + 1) % g) * g + (ix % g)], d = grid[((iy + 1) % g) * g + ((ix + 1) % g)];
          v += (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * amp;
          tot += amp;
          amp *= 0.5;
        }
        data[(y * N + x) * 4 + ch] = Math.max(0, Math.min(255, Math.round((v / tot) * 255)));
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _noise = tex;
  return tex;
}

// GLSL: fire colour ramp from heat 0..1 (dark red -> orange -> yellow -> white), HDR.
export const FIRE_RAMP_GLSL = /* glsl */`
  vec3 fireRamp(float h) {
    h = clamp(h, 0.0, 1.0);
    vec3 c = mix(vec3(0.35, 0.03, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(0.0, 0.35, h));
    c = mix(c, vec3(1.0, 0.62, 0.12), smoothstep(0.3, 0.65, h));
    c = mix(c, vec3(1.0, 0.92, 0.6), smoothstep(0.65, 0.92, h));
    c = mix(c, vec3(1.0, 1.0, 0.95), smoothstep(0.92, 1.0, h));
    return c;
  }
`;
