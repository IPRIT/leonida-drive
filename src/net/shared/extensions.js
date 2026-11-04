// Optional protocol-5 extensions. Clients only send these after S_FEATURES,
// so rolling back to an older server never produces unknown client messages.
export const C_ADMIN = 0x10, S_FEATURES = 0x9b, S_ADMIN = 0x9c, S_MAP = 0x9d;
export const FEATURE = Object.freeze({ MAP: 1, ADMIN: 2, ADMIN_TRAVEL: 4 });
export const HF_EXACT_PLACE = 0x04;
export const ADMIN_CORRECTION = 254;
export const MAP_ORDER = 3, MAP_HEADER = 20, MAP_ENTRY = 20, MAP_PAGE = 1024;
const enc = new TextEncoder(), dec = new TextDecoder();

export function jsonMessage(type, value) {
  const bytes = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(bytes.length + 1);
  out[0] = type; out.set(bytes, 1);
  return out;
}
export function readJson(dv) {
  if (dv.byteLength > 512 || dv.byteLength < 3) return null;
  try {
    const r = JSON.parse(dec.decode(new Uint8Array(dv.buffer, dv.byteOffset + 1, dv.byteLength - 1)));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  } catch { return null; }
}
export function writeMapEntry(dv, o, p) {
  dv.setUint32(o, p.id, true);
  dv.setFloat32(o + 4, p.x, true); dv.setFloat32(o + 8, p.z, true);
  dv.setInt16(o + 12, Math.round(Math.max(-3276, Math.min(3276, p.vx)) * 10), true);
  dv.setInt16(o + 14, Math.round(Math.max(-3276, Math.min(3276, p.vz)) * 10), true);
  dv.setUint16(o + 16, Math.round(((p.yaw % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) * 65536 / (2 * Math.PI)) & 65535, true);
  dv.setUint8(o + 18, p.color); dv.setUint8(o + 19, p.vclass);
  return o + MAP_ENTRY;
}
export function readMapEntry(dv, o, p = {}) {
  p.id = dv.getUint32(o, true);
  p.x = dv.getFloat32(o + 4, true); p.z = dv.getFloat32(o + 8, true);
  p.vx = dv.getInt16(o + 12, true) / 10; p.vz = dv.getInt16(o + 14, true) / 10;
  p.yaw = dv.getUint16(o + 16, true) * (2 * Math.PI) / 65536;
  p.color = dv.getUint8(o + 18); p.vclass = dv.getUint8(o + 19);
  return p;
}
