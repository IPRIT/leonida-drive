// Decoder for public/data/map.bin (built by tools/map_build.py). Works on the main thread and in workers.
//
// Layout: gzip( 'LDMAP1\0\0' | u32 headerLen | header JSON | blob ). Geometry sets are delta-encoded Int16
// polylines/rings; here they are expanded to absolute Float32 world coordinates (x, z interleaved).

export const MAP_URL = 'data/map.bin';

export async function gunzipIfNeeded(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf; // the server already decoded it
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

export async function fetchMapBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await gunzipIfNeeded(await res.arrayBuffer());
}

// Parses the container. `full` = expand all geometry sets (the worker needs them; the main thread only needs
// street paths for label placement and can skip the rest).
export function parseMapBuffer(buf, { sets: wanted = null } = {}) {
  const u8 = new Uint8Array(buf);
  const magic = String.fromCharCode(...u8.subarray(0, 6));
  if (magic !== 'LDMAP1') throw new Error('map.bin: bad magic');
  const dv = new DataView(buf);
  const hl = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)));
  const blobOff = 12 + hl;
  const arr = (name) => {
    const [dt, off, n] = header.arrays[name];
    const C = dt === 'int16' ? Int16Array : dt === 'int32' ? Int32Array : dt === 'uint8' ? Uint8Array : Float32Array;
    return new C(buf, blobOff + off, n);
  };
  const [ox, oz] = header.origin;
  const q = header.q;
  const sets = {};
  for (const [name, meta] of Object.entries(header.sets)) {
    if (wanted && !wanted.includes(name)) continue;
    const P = arr(`${name}.parts`);
    const D = arr(`${name}.coords`);
    const nParts = P.length / 4;
    const xy = new Float32Array(D.length);
    const start = new Uint32Array(nParts + 1);
    let o = 0;
    for (let i = 0; i < nParts; i++) {
      const n = P[i * 4 + 2];
      start[i] = o;
      let ax = 0, az = 0;
      for (let k = 0; k < n; k++) {
        ax += D[(o + k) * 2];
        az += D[(o + k) * 2 + 1];
        xy[(o + k) * 2] = ox + ax * q;
        xy[(o + k) * 2 + 1] = oz + az * q;
      }
      o += n;
    }
    start[nParts] = o;
    sets[name] = { name, meta, parts: P, xy, start, n: nParts };
  }
  const F = header.poiFields;
  const fi = Object.fromEntries(F.map((f, i) => [f, i]));
  const pois = header.pois.map((r, i) => ({
    i, id: r[fi.id], name: r[fi.name], cat: header.categories[r[fi.cat]], x: r[fi.x], z: r[fi.z],
    district: r[fi.district], area: r[fi.area], street: r[fi.street], real: r[fi.real], flags: r[fi.flags],
  }));
  return {
    header, sets, pois,
    streets: header.streets,
    routes: header.routes || [],   // [{ kind: 'I' | 'US' | 'SR', num, len }] (rt set: shield paths)
    exits: header.exits || [],     // [[x, z, routeIndex, number]] interstate exits
    districts: header.districts,
    landmarks: header.landmarks,
    categories: header.categories,
    bounds: header.bounds,
    flags: header.poiFlags,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Smooth path builders (world coordinates). Rings: corners are rounded with a radius limited to `rmax` so long
// straight edges (cell clip borders, straight coasts) stay straight; dense curves become smooth quadratic splines.

export function addRing(path, xy, s, n, rmax) {
  if (n < 3) return;
  const px = (i) => xy[(s + ((i + n) % n)) * 2];
  const pz = (i) => xy[(s + ((i + n) % n)) * 2 + 1];
  let first = true;
  for (let i = 0; i < n; i++) {
    const x = px(i), z = pz(i);
    const ax = px(i - 1), az = pz(i - 1), bx = px(i + 1), bz = pz(i + 1);
    const la = Math.hypot(x - ax, z - az) || 1e-6, lb = Math.hypot(bx - x, bz - z) || 1e-6;
    const ra = Math.min(la * 0.5, rmax), rb = Math.min(lb * 0.5, rmax);
    const inX = x + (ax - x) * (ra / la), inZ = z + (az - z) * (ra / la);
    const outX = x + (bx - x) * (rb / lb), outZ = z + (bz - z) * (rb / lb);
    if (first) { path.moveTo(inX, inZ); first = false; } else path.lineTo(inX, inZ);
    path.quadraticCurveTo(x, z, outX, outZ);
  }
  path.closePath();
}

// Open polyline through midpoints (endpoints kept exactly, so junctions stay connected).
export function addLine(path, xy, s, n) {
  if (n < 2) return;
  path.moveTo(xy[s * 2], xy[s * 2 + 1]);
  if (n === 2) { path.lineTo(xy[s * 2 + 2], xy[s * 2 + 3]); return; }
  for (let k = 1; k < n - 1; k++) {
    const x = xy[(s + k) * 2], z = xy[(s + k) * 2 + 1];
    const nx = xy[(s + k + 1) * 2], nz = xy[(s + k + 1) * 2 + 1];
    if (k === n - 2) path.quadraticCurveTo(x, z, nx, nz);
    else path.quadraticCurveTo(x, z, (x + nx) * 0.5, (z + nz) * 0.5);
  }
}

// Plain polygon (buildings keep their sharp corners).
export function addPolygon(path, xy, s, n) {
  if (n < 3) return;
  path.moveTo(xy[s * 2], xy[s * 2 + 1]);
  for (let k = 1; k < n; k++) path.lineTo(xy[(s + k) * 2], xy[(s + k) * 2 + 1]);
  path.closePath();
}
