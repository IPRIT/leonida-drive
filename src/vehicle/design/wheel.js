// Wheel geometry: tyre + rim + spokes in local space (axle along X, outer face at +X).
import { lathe, cyl, box, ring, rotate, translate, concat, xform } from './geom.js';
import * as THREE from 'three';

const _m = new THREE.Matrix4();

function tyre(r, w, seg, profile = 'car', x = 0) {
  const rimR = r * (profile === 'truck' ? 0.62 : profile === 'offroad' ? 0.6 : 0.66);
  let prof;
  if (profile === 'moto' || profile === 'bicycle') {
    // round section
    const rr = w / 2;
    prof = [];
    for (let i = 0; i <= 6; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 6;
      prof.push([r - rr + Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    prof.unshift([r - rr * 1.6, -rr * 0.7]);
    prof.push([r - rr * 1.6, rr * 0.7]);
  } else {
    const sh = profile === 'offroad' ? 0.06 : 0.035;
    prof = [
      [rimR * 0.98, -w / 2 + 0.01],
      [r * 0.9, -w / 2],
      [r, -w / 2 + sh],
      [r, w / 2 - sh],
      [r * 0.9, w / 2],
      [rimR * 0.98, w / 2 - 0.01],
    ];
  }
  const a = lathe(prof, seg);
  rotate(a, 0, 0, -Math.PI / 2);
  return translate(a, x, 0, 0);
}

/**
 * @param {number} r tyre radius
 * @param {number} w tyre width
 * @param {object} o { style, spokes, lod, whitewall, dual, profile }
 * @returns {{tire: Float32Array, rim: Float32Array, spokes: Float32Array, white?: Float32Array, rimR: number}}
 */
export function wheelGeometry(r, w, o = {}) {
  const hi = o.lod !== 'low';
  const style = o.style || 'star';
  const seg = hi ? (r > 0.45 ? 20 : 16) : 10;
  const profile = o.profile || (style === 'truck' ? 'truck' : style === 'offroad' ? 'offroad' : 'car');
  if (style === 'bicycle' || style === 'wire' || style === 'moto' || style === 'mag3') return bikeWheel(r, w, o, hi);
  const tires = [];
  const rimR = r * (profile === 'truck' ? 0.62 : profile === 'offroad' ? 0.6 : 0.66);
  const dual = !!o.dual;
  const tw = w;
  if (dual) {
    tires.push(tyre(r, tw * 0.48, seg, profile, tw * 0.26), tyre(r, tw * 0.48, seg, profile, -tw * 0.26));
  } else tires.push(tyre(r, tw, seg, profile));
  const xo = tw / 2 - 0.025; // outer face
  const rimParts = [cyl(rimR, rimR, 0.05, seg, xo - 0.04, 0, 0, 'x'), cyl(rimR * 0.97, rimR * 0.97, tw * 0.85, seg, -0.02, 0, 0, 'x')];
  const n = o.spokes || 5;
  const sp = [];
  const hub = cyl(rimR * 0.2, rimR * 0.25, 0.06, hi ? 10 : 6, xo + 0.01, 0, 0, 'x');
  sp.push(hub);
  const spokeAt = (thick, len, r0, tilt = 0, depth = 0.03, xoff = 0) => {
    const g = box(depth, len, thick, xo + 0.005 + xoff, r0 + len / 2, 0, tilt, 0, 0);
    return g;
  };
  const radial = (count, mk) => {
    for (let i = 0; i < count; i++) {
      const g = mk(i);
      xform(g, _m.makeRotationX((i / count) * Math.PI * 2));
      sp.push(g);
    }
  };
  switch (style) {
    case 'steel':
    case 'truck':
      sp.push(cyl(rimR * 0.62, rimR * 0.7, 0.035, seg, xo + 0.0, 0, 0, 'x'));
      if (hi) radial(style === 'truck' ? 10 : 5, () => cyl(0.018, 0.018, 0.03, 6, xo + 0.02, rimR * 0.34, 0, 'x'));
      if (style === 'truck') sp.push(cyl(rimR * 0.3, rimR * 0.36, 0.1, hi ? 10 : 6, xo + 0.04, 0, 0, 'x'));
      break;
    case 'dish':
    case 'disc':
      sp.push(cyl(rimR * 0.92, rimR * 0.96, 0.03, seg, xo + 0.005, 0, 0, 'x'));
      if (style === 'dish') sp.push(cyl(rimR * 0.35, rimR * 0.5, 0.05, seg, xo + 0.03, 0, 0, 'x'));
      else if (hi) radial(6, () => box(0.012, rimR * 0.5, 0.03, xo + 0.022, rimR * 0.55, 0, 0, 0, 0.0));
      break;
    case 'mesh':
      radial(Math.max(10, n), () => spokeAt(0.03, rimR * 0.82, rimR * 0.12, 0.6));
      radial(Math.max(10, n), () => spokeAt(0.03, rimR * 0.82, rimR * 0.12, -0.6));
      break;
    case 'turbine':
      radial(n || 8, () => spokeAt(0.09, rimR * 0.78, rimR * 0.16, 0.55, 0.025));
      break;
    case 'multi':
      radial(Math.max(8, n), () => spokeAt(0.035, rimR * 0.82, rimR * 0.14));
      break;
    case 'split':
      radial(n || 5, () => concat([spokeAt(0.03, rimR * 0.82, rimR * 0.14, 0.12), spokeAt(0.03, rimR * 0.82, rimR * 0.14, -0.12)]));
      break;
    case 'offroad':
      sp.push(cyl(rimR * 0.98, rimR * 0.98, 0.045, seg, xo + 0.012, 0, 0, 'x'));
      radial(n || 6, () => spokeAt(0.11, rimR * 0.72, rimR * 0.18, 0, 0.04));
      if (hi) radial(12, () => cyl(0.014, 0.014, 0.03, 5, xo + 0.035, rimR * 0.93, 0, 'x'));
      break;
    case 'wirespoke':
      radial(18, () => spokeAt(0.012, rimR * 0.86, rimR * 0.08, 0.5, 0.012));
      sp.push(cyl(rimR * 0.18, rimR * 0.24, 0.12, 8, xo + 0.04, 0, 0, 'x'));
      break;
    default: // 'star' n-spoke
      radial(n || 5, () => spokeAt(0.065, rimR * 0.8, rimR * 0.14));
  }
  const out = { tire: concat(tires), rim: concat(rimParts), spokes: concat(sp), rimR };
  if (o.whitewall) {
    const ww = lathe([[r * 0.72, 0], [r * 0.86, 0]], seg);
    rotate(ww, 0, 0, -Math.PI / 2);
    out.white = translate(ww, tw / 2 + 0.002, 0, 0);
  }
  return out;
}

function bikeWheel(r, w, o, hi) {
  const seg = hi ? 24 : 12;
  const style = o.style;
  const tire = tyre(r, w, seg, style === 'bicycle' || style === 'wire' ? 'bicycle' : 'moto');
  const rimR = r - w * 0.85;
  const rim = ring(rimR, Math.max(0.008, w * 0.18), hi ? 4 : 3, seg);
  const sp = [];
  if (style === 'bicycle' || style === 'wire') {
    const n = hi ? (style === 'wire' ? 28 : 20) : 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const side = i % 2 ? 1 : -1;
      const g = box(0.004, rimR, 0.004, 0, rimR / 2, 0, 0, 0, side * 0.03);
      translate(g, side * 0.012, 0, 0);
      xform(g, _m.makeRotationX(a));
      sp.push(g);
    }
    sp.push(cyl(0.025, 0.025, 0.08, 8, 0, 0, 0, 'x'));
    if (style === 'wire') sp.push(cyl(rimR * 0.18, rimR * 0.18, 0.1, 8, 0, 0, 0, 'x'));
  } else {
    // cast moto wheel: 3 or 5 split spokes + disc rotor
    const n = o.spokes || 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const g = box(0.03, rimR * 0.9, 0.035, 0, rimR * 0.5, 0);
      xform(g, _m.makeRotationX(a));
      sp.push(g);
    }
    sp.push(cyl(0.05, 0.05, w * 0.9, 10, 0, 0, 0, 'x'));
    if (o.rotor !== false) sp.push(cyl(rimR * 0.62, rimR * 0.62, 0.008, hi ? 16 : 8, w * 0.36, 0, 0, 'x'));
  }
  return { tire, rim, spokes: concat(sp), rimR };
}
