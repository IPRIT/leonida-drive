// Optional world data for plausibility checks: terrain heights (public/data/height.bin) and hospitals (world.json).
// Without the files the server still runs; altitude checks then use sea level and respawns fall back to a radius rule.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HOSPITAL_DISTRICTS = ['Ocean Beach', 'Washington Beach', 'Downtown', 'Little Cuba', 'Tequesta', 'Crosstown', 'Southside',
  'Salton', 'Bayside', 'Port Gellhorn', 'Hamlet', 'Key Lento', 'Ambrosia', 'Capri', 'Belville', 'Peregrine Bay'];

export function loadWorldData(dir, log = console) {
  const out = { heightAt: (x, z) => 0, hospitals: [{ x: 1745, z: -640 }], districts: [], hasTerrain: false, bounds: [-9216, -9216, 4096, 9728] };
  try {
    const w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
    out.bounds = w.bounds;
    out.districts = (w.districts || []).map((d) => ({ name: d.name, type: d.type, x: d.x, z: d.z, r: d.r }));
    const hs = [];
    for (const name of HOSPITAL_DISTRICTS) {
      const d = (w.districts || []).find((x) => x.name === name);
      if (d) hs.push({ x: d.x, z: d.z });
    }
    if (hs.length) out.hospitals = hs;
    let buf = fs.readFileSync(path.join(dir, 'height.bin'));
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const h = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    const { gw, gh, hs: step } = w;
    const [x0, z0] = w.bounds;
    const W = gw + 1;
    if (h.length >= W * (gh + 1)) {
      out.hasTerrain = true;
      out.heightAt = (x, z) => {
        let fx = (x - x0) / step, fz = (z - z0) / step;
        if (fx < 0) fx = 0; else if (fx > gw - 1e-4) fx = gw - 1e-4;
        if (fz < 0) fz = 0; else if (fz > gh - 1e-4) fz = gh - 1e-4;
        const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
        const h00 = h[iz * W + ix], h10 = h[iz * W + ix + 1], h01 = h[(iz + 1) * W + ix], h11 = h[(iz + 1) * W + ix + 1];
        const v = tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
        return v * 0.1;
      };
    }
  } catch (e) {
    log.warn?.(`[world] world data not loaded from ${dir}: ${e.message} (plausibility checks use defaults)`);
  }
  return out;
}
