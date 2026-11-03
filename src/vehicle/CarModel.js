// Procedural low-poly vehicle meshes. Model space: y = 0 is the ground at rest, -Z is forward,
// z = 0 is the middle of the wheelbase. Original stylized designs (no real brands).
//
// buildCarModel(spec, { color, color2, lod: 'high'|'low', parts: true }) returns the visual model with
// damage-ready sub-groups (model.parts: body, hood, trunk, frontBumper, rearBumper, doorFL/FR/RL/RR, glass, lights).
import * as THREE from 'three';
import { classify, concat, slice, toGeometry, bounds, Parts } from './design/geom.js';
import { LEGACY_DESIGNS, LEGACY_ZONES } from './design/legacy.js';
import { designCar, wheelWells } from './design/car.js';
import { designTruck, designBus } from './design/heavy.js';
import { designBike, designBicycle } from './design/bikes.js';
import { designGolfCart, designTukTuk } from './design/small.js';
import { wheelGeometry } from './design/wheel.js';

const LAMP_KINDS = new Set(['head', 'tail', 'reverse', 'amber']);

// ---------- materials ----------

/** Paint clearcoat floor: keeps the clearcoat shader variant compiled so finishes never trigger a recompile. */
export const CLEARCOAT_MIN = 0.0001;

export function createMaterials(color, color2, o = {}) {
  const std = (p) => new THREE.MeshStandardMaterial({ flatShading: true, ...p });
  const paintRough = o.matte ? 0.62 : 0.3;
  return {
    // physical paint with a (near-zero) clearcoat from the start: finishes can raise it later without a recompile
    paint: new THREE.MeshPhysicalMaterial({ flatShading: true, color, roughness: paintRough, metalness: o.matte ? 0.1 : 0.4, clearcoat: CLEARCOAT_MIN, clearcoatRoughness: 0.2 }),
    paint2: std({ color: color2 ?? 0x15161a, roughness: 0.34, metalness: 0.3 }),
    trim: std({ color: 0x1c1e23, roughness: 0.75, metalness: 0.1 }),
    dark: std({ color: 0x0b0c0e, roughness: 0.85, metalness: 0.0 }),
    chrome: std({ color: 0xd9dee6, roughness: 0.2, metalness: 0.92 }),
    glass: std({ color: o.glass ?? 0x16303c, roughness: 0.06, metalness: 0.7 }),
    tire: std({ color: 0x151515, roughness: 0.92, metalness: 0.0 }),
    rim: std({ color: 0xc9ced6, roughness: 0.26, metalness: 0.86 }),
    rimDark: std({ color: 0x24272d, roughness: 0.42, metalness: 0.6 }),
    rimGold: std({ color: 0xc9a24a, roughness: 0.3, metalness: 0.85 }),
    rimWhite: std({ color: 0xe8e8e6, roughness: 0.4, metalness: 0.2 }),
    plate: std({ color: 0xe9e6dc, roughness: 0.55, metalness: 0.05 }),
    interior: std({ color: o.interior ?? 0x2a211c, roughness: 0.8, metalness: 0.0 }),
    canvas: std({ color: o.canvas ?? 0x2e3a2c, roughness: 0.9, metalness: 0.0 }),
    head: std({ color: 0xf5f2e8, emissive: 0xfff2d6, emissiveIntensity: 0.12, roughness: 0.15, metalness: 0.2 }),
    tail: std({ color: 0x4a0306, emissive: 0xff0a14, emissiveIntensity: 0.25, roughness: 0.25, metalness: 0.1 }),
    reverse: std({ color: 0xd8d8d8, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.2, metalness: 0.1 }),
    amber: std({ color: 0x8a4a00, emissive: 0xff9a1a, emissiveIntensity: 0.25, roughness: 0.3, metalness: 0.1 }),
    sirenRed: std({ color: 0x400006, emissive: 0xff1030, emissiveIntensity: 0.05, roughness: 0.25 }),
    sirenBlue: std({ color: 0x000a40, emissive: 0x1a50ff, emissiveIntensity: 0.05, roughness: 0.25 }),
  };
}

const RIM_MAT = { chrome: 'rim', silver: 'rim', dark: 'rimDark', black: 'rimDark', paint: 'paint', gold: 'rimGold', white: 'rimWhite' };

// ---------- design dispatch ----------

// Designs are deterministic per spec: generating one costs 1-35 ms (limousines, detailed coupés), the dominant part
// of a spawn. buildCarModel copies every triangle array it turns into geometry, so a design can be reused by later
// builds of the same model (respawn, garage, traffic takeover). LRU bounded by triangle-array size.
const DESIGN_CACHE = new Map();
const DESIGN_CACHE_FLOATS = 8e6; // ≈ 32 MB of Float32
let designCacheFloats = 0;

function designKey(spec, lod) {
  return `${lod}|${JSON.stringify([spec.name, spec.design, spec.size, spec.wheelbase, spec.wheelRadius, spec.track, spec.tireWidth, spec.wheelLayout, spec.kind, spec.color2])}`;
}

function designFloats(des) {
  let n = 0;
  const P = des.parts;
  for (const k of Object.keys(P.mats)) for (const a of P.mats[k]) n += a.length;
  for (const f of P.fixed) n += f.geo.length;
  for (const l of P.lamps) n += l.geo.length;
  return n;
}

/** Raw design for a derived spec (cached, treat as read-only): { parts: Parts, zones, lamps, ... } */
export function generateDesign(spec, lod = 'high') {
  const key = designKey(spec, lod);
  const hit = DESIGN_CACHE.get(key);
  if (hit) {
    DESIGN_CACHE.delete(key); // LRU: move to the back
    DESIGN_CACHE.set(key, hit);
    return hit.des;
  }
  const des = generateDesignUncached(spec, lod);
  const floats = designFloats(des);
  DESIGN_CACHE.set(key, { des, floats, asm: {} });
  designCacheFloats += floats;
  trimDesignCache();
  return des;
}

function trimDesignCache() {
  for (const [k, e] of DESIGN_CACHE) {
    if (designCacheFloats <= DESIGN_CACHE_FLOATS || DESIGN_CACHE.size <= 1) break;
    DESIGN_CACHE.delete(k);
    designCacheFloats -= e.floats;
  }
}

let MAT_KEYS = null; // material keys of createMaterials (a design's material lists outside it are skipped)
function matKeys() {
  if (!MAT_KEYS) {
    const m = createMaterials(0, 0);
    MAT_KEYS = new Set(Object.keys(m));
    for (const x of Object.values(m)) x.dispose();
  }
  return MAT_KEYS;
}

// The meshes of a design as buildCarModel turns them into geometry: triangles classified into damage parts, part
// pivots, pivot-relative positions and vertex normals. Deterministic per design, so computed once (the classification
// and normals were most of a detailed car's build: ~5-8 ms for a 14k-triangle coupé) and cached with the design;
// every build copies the arrays (instances are dented independently).
function assembly(spec, lod, withParts) {
  const des = generateDesign(spec, lod);
  const entry = DESIGN_CACHE.get(designKey(spec, lod));
  const slot = withParts ? 'parts' : 'whole';
  if (entry?.asm[slot]) return entry.asm[slot];
  const P = des.parts;
  const keys = matKeys();
  // merge per material, forced parts kept apart
  const groups = {}; // part -> mat -> [arrays]
  const put = (part, mat, a) => ((groups[part] ||= {})[mat] ||= []).push(a);
  const Z = des.zones;
  const cls = withParts && Z ? partClassifier(Z) : null;
  for (const mat of Object.keys(P.mats)) {
    if (!keys.has(mat)) continue;
    const a = concat(P.mats[mat]);
    if (!cls) put('body', mat, a);
    else {
      const b = classify(a, cls(mat));
      for (const part of Object.keys(b)) put(part, mat, b[part]);
    }
  }
  for (const f of P.fixed) put(withParts ? f.part : 'body', f.mat, f.geo);
  const out = [];
  let floats = 0;
  for (const name of Object.keys(groups)) {
    const byMat = groups[name];
    let bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const mat of Object.keys(byMat)) for (const a of byMat[mat]) bounds(a, bb);
    const pv = withParts ? pivotFor(name, bb, Z) : [0, 0, 0];
    const meshes = [];
    for (const mat of Object.keys(byMat)) {
      const geo = toGeometry(concat(byMat[mat]));
      if (pv[0] || pv[1] || pv[2]) geo.translate(-pv[0], -pv[1], -pv[2]);
      const pos = geo.attributes.position.array, nrm = geo.attributes.normal.array;
      meshes.push({ mat, pos, nrm });
      floats += pos.length + nrm.length;
    }
    out.push({ name, pv, meshes });
  }
  const asm = { parts: out };
  if (entry) { entry.asm[slot] = asm; entry.floats += floats; designCacheFloats += floats; trimDesignCache(); }
  return asm;
}

/** Idle-time warm-up of a model's design and assembled meshes (garage selection, owned vehicles). */
export function prewarmCarModel(spec, lod = 'high', withParts = lod !== 'low') {
  assembly(spec, lod, withParts);
  const des = generateDesign(spec, lod);
  for (const wd of des.wheels || defaultWheels(spec)) wheelArrays(wd, des, lod);
}

// wheel geometry (positions + normals) per wheel shape, shared by every build (copied per build)
const WHEEL_CACHE = new Map();
function wheelArrays(wd, des, lod) {
  const style = wd.style || des.rimStyle, spokes = wd.spokes || des.spokes;
  const key = `${lod}|${wd.r}|${wd.w}|${style}|${spokes}|${des.whitewall ? 1 : 0}|${wd.dual ? 1 : 0}|${wd.rotor === false ? 0 : 1}`;
  let e = WHEEL_CACHE.get(key);
  if (e) { WHEEL_CACHE.delete(key); WHEEL_CACHE.set(key, e); return e; }
  const wg = wheelGeometry(wd.r, wd.w, { style, spokes, lod, whitewall: des.whitewall, dual: wd.dual, rotor: wd.rotor });
  const arr = (a) => { if (!a) return null; const g = toGeometry(a); return { pos: g.attributes.position.array, nrm: g.attributes.normal.array }; };
  e = { tire: arr(wg.tire), rim: arr(wg.rim), spokes: arr(wg.spokes), white: arr(wg.white) };
  WHEEL_CACHE.set(key, e);
  if (WHEEL_CACHE.size > 48) WHEEL_CACHE.delete(WHEEL_CACHE.keys().next().value);
  return e;
}

// geometry from cached arrays: own copies (the same attributes toGeometry + translate produce)
function geometryOf(a) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.pos.slice(), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nrm, 3));
  return g;
}

function generateDesignUncached(spec, lod) {
  const D = spec.design;
  if (!D && LEGACY_DESIGNS[spec.name]) return legacyDesign(spec);
  const type = D?.type || 'car';
  if (type === 'truck') return designTruck(spec, D, lod);
  if (type === 'bus') return designBus(spec, D, lod);
  if (type === 'bike') return designBike(spec, D, lod);
  if (type === 'bicycle') return designBicycle(spec, D, lod);
  if (type === 'golfcart') return designGolfCart(spec, D, lod);
  if (type === 'tuktuk') return designTukTuk(spec, D, lod);
  return designCar(spec, D || {}, lod);
}

function legacyDesign(spec) {
  const des = LEGACY_DESIGNS[spec.name](spec);
  const P = new Parts();
  for (const k of Object.keys(des.parts)) {
    for (const a of des.parts[k]) {
      if (!LAMP_KINDS.has(k)) {
        P.add(k, a);
        continue;
      }
      // split lamps per side so each one is its own breakable mesh
      const s = classify(slice(a, 0, 0), (nx, ny, nz, cx) => (cx < 0 ? 'L' : 'R'));
      for (const side of ['L', 'R']) if (s[side]) P.lamp(k, `${k}${side}${P.lamps.length}`, s[side], k === 'head' || k === 'amber' ? 'body' : 'body');
    }
  }
  const Z = LEGACY_ZONES[spec.name];
  const r = spec.wheelRadius;
  wheelWells({ P, spec, r, zf: -spec.wheelbase / 2, zr: spec.wheelbase / 2, sill: Z.sill, d: { archGap: 0.075 } });
  const seatY = Math.max(Z.sill + 0.32, r + 0.12);
  const seatZ = Z.zA + 0.9;
  const seats = [{ x: -0.38, y: seatY, z: seatZ }, { x: 0.38, y: seatY, z: seatZ }];
  if (Z.doors.length > 1) seats.push({ x: -0.38, y: seatY, z: seatZ + 0.85 }, { x: 0.38, y: seatY, z: seatZ + 0.85 });
  const ep = Z.layout === 'mid' ? [0, Z.beltR - 0.25, spec.wheelbase / 2 - 0.75] : [0, Z.hoodY - 0.2, -spec.wheelbase / 2 + 0.05];
  return {
    parts: P,
    zones: { ...Z, halfW: spec.size.width / 2 },
    lamps: des.lamps,
    popups: des.popups || null,
    lightbar: des.lightbar || null,
    seats,
    doors: Z.doors.map((d) => ({ z: (d.z0 + d.z1) / 2, y: (Z.sill + Z.beltF) / 2 })),
    enginePos: ep,
    exhaustPos: [0.5, 0.25, Z.zR],
    rim: des.rim === 'dark' ? 'dark' : 'chrome',
    rimStyle: des.rimStyle,
    spokes: des.spokes,
    dims: { length: spec.size.length, width: spec.size.width, height: spec.size.height },
  };
}

// ---------- damage partition ----------

function partClassifier(Z) {
  const beltAt = (z) => {
    const t = Math.min(1, Math.max(0, (z - Z.zA) / Math.max(0.1, (Z.zC ?? Z.zR) - Z.zA)));
    return Z.beltF + ((Z.beltR ?? Z.beltF) - Z.beltF) * t;
  };
  const doors = Z.doors || [];
  return (mat) => (nx, ny, nz, cx, cy, cz) => {
    if (mat === 'glass') return 'glass';
    if (Z.bumperF !== undefined && cz < Z.bumperF && cy < Z.bumperTopF) return 'frontBumper';
    if (Z.bumperR !== undefined && cz > Z.bumperR && cy < Z.bumperTopR) return 'rearBumper';
    const belt = beltAt(cz);
    if (Math.abs(nx) > 0.55 && cy > Z.sill - 0.02 && cy < belt + 0.012 && mat !== 'tire' && mat !== 'interior') {
      for (const d of doors) if (cz > d.z0 && cz < d.z1) return `door${d.rear ? 'R' : 'F'}${cx < 0 ? 'L' : 'R'}`;
    }
    if (Z.zA !== undefined && cz < Z.zA - 0.02 && cz > (Z.hoodZ ?? -99) && cy > Z.hoodY && ny > 0.3) return 'hood';
    if (Z.deck && cz > Z.zC + 0.02 && ny > 0.3 && cy > (Z.deckY ?? Z.beltR) - 0.14) return 'trunk';
    if (Z.hatch && cz > Z.zC - 0.25 && nz > 0.5 && cy > Z.bumperTopR + 0.02) return 'trunk';
    return 'body';
  };
}

const HINGES = {
  hood: { axis: 'x', sign: 1, max: 1.15 },
  trunk: { axis: 'x', sign: -1, max: 1.2 },
  doorFL: { axis: 'y', sign: -1, max: 1.15 },
  doorRL: { axis: 'y', sign: -1, max: 1.15 },
  doorFR: { axis: 'y', sign: 1, max: 1.15 },
  doorRR: { axis: 'y', sign: 1, max: 1.15 },
};

function pivotFor(name, bb, Z) {
  // bb = [minx,miny,minz,maxx,maxy,maxz]
  if (name === 'hood') return [0, bb[4], bb[5]];
  if (name === 'trunk') return [0, bb[4], bb[2]];
  if (name.startsWith('door')) return [name.endsWith('L') ? bb[0] : bb[3], (bb[1] + bb[4]) / 2, bb[2]];
  if (name === 'frontBumper' || name === 'rearBumper') return [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2];
  return [0, 0, 0];
}

// ---------- assembly ----------

/**
 * Build the visual vehicle for a derived spec.
 * @param {object} spec derived spec (deriveSpec)
 * @param {{color?:number, color2?:number, lod?:'high'|'low', parts?:boolean}} [opts]
 */
export function buildCarModel(spec, opts = {}) {
  const lod = opts.lod || 'high';
  const hi = lod !== 'low';
  const withParts = opts.parts ?? hi;
  const des = generateDesign(spec, lod);
  const D = spec.design || {};
  const materials = createMaterials(opts.color ?? spec.color, opts.color2 ?? spec.color2, { matte: D.matte, glass: D.glass, interior: D.interior, canvas: D.canvas });
  const P = des.parts;
  const body = new THREE.Group();
  body.name = 'carBody';
  const Z = des.zones;

  // damage parts per material (classification, pivots and normals cached with the design, see assembly())
  const parts = {};
  const shadow = opts.castShadow !== false;
  for (const { name, pv: pv0, meshes } of assembly(spec, lod, withParts).parts) {
    const g = new THREE.Group();
    g.name = name;
    const pv = pv0.slice();
    g.position.set(pv[0], pv[1], pv[2]);
    for (const { mat, pos, nrm } of meshes) {
      const geo = geometryOf({ pos, nrm });
      const mesh = new THREE.Mesh(geo, materials[mat]);
      mesh.name = mat;
      mesh.userData.part = name;
      mesh.castShadow = shadow && mat !== 'glass';
      g.add(mesh);
    }
    g.userData.pivot = pv;
    if (HINGES[name]) g.userData.hinge = { ...HINGES[name] };
    if (name === 'trunk' && Z?.hatch) g.userData.hinge = { axis: 'x', sign: -1, max: 1.3 };
    body.add(g);
    parts[name] = g;
  }

  // lamps: one mesh each
  const lights = new THREE.Group();
  lights.name = 'lights';
  const lampMeshes = {};
  for (const l of P.lamps) {
    const mat = materials[l.mat] ? l.mat : l.kind;
    const mesh = new THREE.Mesh(toGeometry(l.geo.slice()), materials[mat]); // own copy: the design is cached, lamps get dented
    mesh.name = mat;
    mesh.userData.lamp = l.name;
    mesh.userData.kind = l.kind;
    mesh.userData.attach = l.attach;
    mesh.userData.part = 'lights';
    lights.add(mesh);
    lampMeshes[l.name] = mesh;
  }
  body.add(lights);
  parts.lights = lights;

  // extra animated groups (mixer drum, ladder, fork...)
  const extra = {};
  for (const name of Object.keys(P.extra)) {
    const e = P.extra[name];
    const g = new THREE.Group();
    g.name = name;
    g.position.set(...e.pivot);
    for (const mat of Object.keys(e.mats)) {
      if (!materials[mat]) continue;
      const geo = toGeometry(concat(e.mats[mat]));
      geo.translate(-e.pivot[0], -e.pivot[1], -e.pivot[2]);
      const mesh = new THREE.Mesh(geo, materials[mat]);
      mesh.name = mat;
      mesh.castShadow = shadow;
      mesh.userData.part = name;
      g.add(mesh);
    }
    body.add(g);
    extra[name] = g;
  }

  // under-body shadow caster is the body itself; pop-up lamps
  const popups = [];
  if (des.popups) {
    for (const p of des.popups) {
      const pivot = new THREE.Group();
      pivot.position.set(p.x, p.y, p.z + p.d / 2);
      const mk = (geo, m) => new THREE.Mesh(geo, materials[m]);
      const B = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
      const lid = mk(B(p.w, 0.05, p.d, 0, 0.0, -p.d / 2), 'paint');
      const face = mk(B(p.w * 0.9, 0.012, p.d * 0.8, 0, -0.028, -p.d / 2), 'dark');
      const lamp = mk(B(p.w * 0.8, 0.13, 0.02, 0, -0.07, -p.d + 0.012), 'head');
      const housing = mk(B(p.w * 0.95, 0.16, p.d * 0.9, 0, -0.08, -p.d / 2), 'dark');
      lid.castShadow = shadow;
      lamp.userData.lamp = p.x < 0 ? 'popupL' : 'popupR';
      pivot.add(lid, face, housing, lamp);
      pivot.userData.lamp = lamp;
      body.add(pivot);
      popups.push(pivot);
    }
  }
  // siren light bar
  let lightbar = null;
  if (des.lightbar) {
    const red = new THREE.Mesh(toGeometry(concat(des.lightbar.red)), materials.sirenRed);
    const blue = new THREE.Mesh(toGeometry(concat(des.lightbar.blue)), materials.sirenBlue);
    red.name = 'sirenRed';
    blue.name = 'sirenBlue';
    if (des.lightbar.amber) {
      materials.sirenRed.color.set(0x5a3000); materials.sirenRed.emissive.set(0xff9a10);
      materials.sirenBlue.color.set(0x5a3000); materials.sirenBlue.emissive.set(0xffb020);
    } else if (des.lightbar.allRed) {
      materials.sirenBlue.color.set(0x400006); materials.sirenBlue.emissive.set(0xff1a1a);
    }
    lights.add(red, blue);
    lightbar = { red, blue, amber: !!des.lightbar.amber };
  }

  // ---------- wheels ----------
  const wheelDefs = des.wheels || defaultWheels(spec);
  const cache = new Map();
  const wheels = [];
  for (const wd of wheelDefs) {
    const key = `${wd.r}|${wd.w}|${wd.style || des.rimStyle}|${wd.dual ? 1 : 0}|${wd.spokes || des.spokes}|${wd.rotor === false ? 0 : 1}`;
    let g = cache.get(key);
    if (!g) {
      const wa = wheelArrays(wd, des, lod);
      g = { tire: geometryOf(wa.tire), rim: geometryOf(wa.rim), spokes: geometryOf(wa.spokes), white: wa.white ? geometryOf(wa.white) : null };
      cache.set(key, g);
    }
    const rimKey = wd.rim || des.rim || 'chrome';
    const rimMat = materials[RIM_MAT[rimKey] || rimKey] || materials.rim;
    const spokeMat = (wd.style || des.rimStyle) === 'steel' && rimKey === 'dark' ? materials.chrome : rimMat;
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    const holder = new THREE.Group();
    if (wd.left) holder.rotation.y = Math.PI;
    const tire = new THREE.Mesh(g.tire, materials.tire);
    const rim = new THREE.Mesh(g.rim, wd.bike ? materials[wd.rimMat || 'rimDark'] : rimMat);
    const spokes = new THREE.Mesh(g.spokes, wd.bike ? materials[wd.spokeMat || wd.rimMat || 'rimDark'] : spokeMat);
    tire.name = 'tire'; rim.name = 'rim'; spokes.name = 'spokes';
    tire.castShadow = rim.castShadow = shadow;
    holder.add(tire, rim, spokes);
    if (g.white) holder.add(new THREE.Mesh(g.white, materials.plate));
    spin.add(holder);
    pivot.add(spin);
    pivot.position.set(wd.x, wd.r, wd.z);
    pivot.userData.wheel = wd;
    wheels.push({ pivot, spin, phys: wd.phys, x: wd.x, z: wd.z, r: wd.r, steer: wd.steer ?? wd.phys < 2, left: !!wd.left });
  }

  const model = {
    body, wheels, materials, popups, lightbar, parts, lampMeshes, extra,
    lamps: des.lamps || { head: [], tail: [] },
    zones: Z,
    seats: des.seats || [],
    doors: des.doors || [],
    enginePos: des.enginePos || [0, 0.6, -1.5],
    exhaustPos: des.exhaustPos || [0.4, 0.25, 2],
    dims: des.dims || { length: spec.size.length, width: spec.size.width, height: spec.size.height },
    steer: extra.steer || null,
    anim: des.anim || null,
    seatPose: des.seatPose || 'car',
  };
  parts.wheels = wheels.map((w) => w.pivot);
  return model;
}

function defaultWheels(spec) {
  const out = [];
  const n = spec.wheelLayout === 'bike' ? 2 : 4;
  if (n === 2) {
    out.push({ phys: 0, x: 0, z: -spec.wheelbase / 2, r: spec.wheelRadius, w: spec.tireWidth[0], steer: true });
    out.push({ phys: 1, x: 0, z: spec.wheelbase / 2, r: spec.wheelRadius, w: spec.tireWidth[1], steer: false });
    return out;
  }
  for (let i = 0; i < 4; i++) {
    const ai = i < 2 ? 0 : 1;
    const left = i % 2 === 0;
    out.push({ phys: i, x: (left ? -1 : 1) * (spec.track[ai] / 2), z: ai === 0 ? -spec.wheelbase / 2 : spec.wheelbase / 2, r: spec.wheelRadius, w: spec.tireWidth[ai], left, steer: ai === 0 });
  }
  return out;
}
