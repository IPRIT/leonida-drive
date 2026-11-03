import { packMeshes } from './geometryTransfer.js';

export const roadMaterials = (r) => ({ road: r.material, bridge: r.bridgeMat, sidewalk: r.sidewalkMat, embankment: r.embankMat, fascia: r.fasciaMat, tunnel: r.tunnelMat });
export const buildingMaterials = (b) => ({ building: b.material, far: b.farMaterial });

export function packRoads(r, terrain) {
  // Plane methods are the only functions in the topology. Reattach them on the
  // receiving side; shared edge / ring references survive structured cloning.
  for (const j of r.junctions) if (j?.plane) delete j.plane.at;
  const exclude = new Set(['terrain', 'shapes', 'group', 'uniforms', 'material', 'bridgeMat', 'sidewalkMat', 'embankMat', 'fasciaMat', 'tunnelMat', 'tunnelGeo', 'detailMeshes']);
  const state = Object.fromEntries(Object.entries(r).filter(([k]) => !exclude.has(k)));
  const holes = {};
  for (const k of ['uHoleA', 'uHoleB', 'uHoleC']) holes[k] = terrain.uniforms[k].value.map((v) => v.toArray());
  holes.n = terrain.uniforms.uHoleN.value;
  return { state, meshes: packMeshes(r.group, roadMaterials(r)), terrain: { heights: terrain.h.slice(), physOverride: terrain.physOverride, holes } };
}

export function restoreRoadTerrain(t, p) {
  t.h.set(p.heights); t.heightTex.needsUpdate = true;
  t.physOverride = p.physOverride;
  for (const k of ['uHoleA', 'uHoleB', 'uHoleC']) p.holes[k].forEach((v, i) => t.uniforms[k].value[i].fromArray(v));
  t.uniforms.uHoleN.value = p.holes.n;
}

export function packBuildings(b) {
  const meshIds = new Map(b.group.children.map((m, i) => [m, i]));
  return { state: { list: b.list, recs: b.recs, irl: b.irl, irlTris: b.irlTris, cell: b.cell, grid: b.grid, farTris: b.farTris, stats: b.stats },
    buckets: [...b.buckets].map(([key, v]) => [key, { key, physVerts: v.physVerts, physIndex: v.physIndex, mesh: meshIds.get(v.mesh) }]),
    far: b.far.map((v) => ({ key: v.key, mesh: meshIds.get(v.mesh) })), meshes: packMeshes(b.group, buildingMaterials(b)) };
}
