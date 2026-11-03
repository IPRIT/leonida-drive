// Conforming triangle splitting for dentable bodies (AI traffic wreck templates, coarse full vehicle meshes).

export const LMAX = 0.34; // m, longest edge after splitting (× size factor^0.75, size factor = length / 4.5 m)

/**
 * Split every edge longer than sqrt(L2) at its midpoint, recursively. The decision depends only on the edge itself,
 * so two triangles sharing an edge split it identically: no T-junction cracks when vertices are displaced later.
 * Non-indexed input P / N (9 floats per triangle); skip(t) keeps triangle t whole. Generator: yields every few hundred
 * output triangles; returns { pos, nrm, src (source triangle per output triangle), n }.
 */
export function* splitTriangles(P, N, ntri, L2, skip = null) {
  let cap = Math.max(64, ntri * 6);
  let pos = new Float32Array(cap * 9), nrm = new Float32Array(cap * 9), src = new Int32Array(cap);
  let n = 0;
  const grow = () => {
    cap *= 2;
    const p2 = new Float32Array(cap * 9); p2.set(pos); pos = p2;
    const n2 = new Float32Array(cap * 9); n2.set(nrm); nrm = n2;
    const s2 = new Int32Array(cap); s2.set(src); src = s2;
  };
  const S = new Float64Array(256 * 18); // stack of triangles: 9 position + 9 normal values
  const out = (b, t) => {
    if (n >= cap) grow();
    const o = n * 9;
    for (let k = 0; k < 9; k++) { pos[o + k] = S[b + k]; nrm[o + k] = S[b + 9 + k]; }
    src[n++] = t;
  };
  // push triangle (i, j, k) = indices 0..5 into the 6 "points" array pt (3 corners + 3 midpoints), with normals
  const pt = new Float64Array(6 * 6); // x y z nx ny nz for a, b, c, m0 (ab), m1 (bc), m2 (ca)
  let sp = 0;
  const push = (i, j, k) => {
    const b = sp * 18;
    const I = i * 6, J = j * 6, K = k * 6;
    S[b] = pt[I]; S[b + 1] = pt[I + 1]; S[b + 2] = pt[I + 2];
    S[b + 3] = pt[J]; S[b + 4] = pt[J + 1]; S[b + 5] = pt[J + 2];
    S[b + 6] = pt[K]; S[b + 7] = pt[K + 1]; S[b + 8] = pt[K + 2];
    S[b + 9] = pt[I + 3]; S[b + 10] = pt[I + 4]; S[b + 11] = pt[I + 5];
    S[b + 12] = pt[J + 3]; S[b + 13] = pt[J + 4]; S[b + 14] = pt[J + 5];
    S[b + 15] = pt[K + 3]; S[b + 16] = pt[K + 4]; S[b + 17] = pt[K + 5];
    sp++;
  };
  const mid = (m, i, j) => {
    const M = m * 6, I = i * 6, J = j * 6;
    for (let q = 0; q < 6; q++) pt[M + q] = (pt[I + q] + pt[J + q]) * 0.5;
  };
  let ny = 0;
  for (let t = 0; t < ntri; t++) {
    const b = 0, v = t * 9;
    for (let k = 0; k < 9; k++) { S[k] = P[v + k]; S[9 + k] = N ? N[v + k] : 0; }
    sp = 1;
    if (skip && skip(t)) { out(b, t); continue; }
    while (sp > 0) {
      sp--;
      const o = sp * 18;
      const d0 = (S[o] - S[o + 3]) ** 2 + (S[o + 1] - S[o + 4]) ** 2 + (S[o + 2] - S[o + 5]) ** 2;
      const d1 = (S[o + 3] - S[o + 6]) ** 2 + (S[o + 4] - S[o + 7]) ** 2 + (S[o + 5] - S[o + 8]) ** 2;
      const d2 = (S[o + 6] - S[o]) ** 2 + (S[o + 7] - S[o + 1]) ** 2 + (S[o + 8] - S[o + 2]) ** 2;
      const s0 = d0 > L2, s1 = d1 > L2, s2 = d2 > L2;
      if (!s0 && !s1 && !s2) { out(o, t); continue; }
      if (sp > 250) { out(o, t); continue; } // safety (never reached with sane geometry)
      for (let c = 0; c < 3; c++) {
        const C6 = c * 6;
        pt[C6] = S[o + c * 3]; pt[C6 + 1] = S[o + c * 3 + 1]; pt[C6 + 2] = S[o + c * 3 + 2];
        pt[C6 + 3] = S[o + 9 + c * 3]; pt[C6 + 4] = S[o + 10 + c * 3]; pt[C6 + 5] = S[o + 11 + c * 3];
      }
      // a=0 b=1 c=2, m0=3 (ab), m1=4 (bc), m2=5 (ca); children keep the winding of the parent
      if (s0 && s1 && s2) {
        mid(3, 0, 1); mid(4, 1, 2); mid(5, 2, 0);
        push(0, 3, 5); push(3, 1, 4); push(5, 4, 2); push(3, 4, 5);
      } else if (s0 && s1) {
        mid(3, 0, 1); mid(4, 1, 2);
        push(3, 1, 4); push(0, 3, 4); push(0, 4, 2);
      } else if (s1 && s2) {
        mid(4, 1, 2); mid(5, 2, 0);
        push(4, 2, 5); push(1, 4, 5); push(1, 5, 0);
      } else if (s2 && s0) {
        mid(5, 2, 0); mid(3, 0, 1);
        push(5, 0, 3); push(2, 5, 3); push(2, 3, 1);
      } else if (s0) { mid(3, 0, 1); push(0, 3, 2); push(3, 1, 2); }
      else if (s1) { mid(4, 1, 2); push(1, 4, 0); push(4, 2, 0); }
      else { mid(5, 2, 0); push(2, 5, 1); push(5, 0, 1); }
    }
    if (n - ny > 700 || (t & 31) === 31) { ny = n; yield 1; }
  }
  yield 2;
  return { pos: pos.slice(0, n * 9), nrm: nrm.slice(0, n * 9), src: src.slice(0, n), n };

}
