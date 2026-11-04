import * as THREE from 'three';
import { GROUPS } from '../vehicle/groups.js';

/** Network poses are body positions, not garage spawn locations. In particular,
 * CraftVehicle.reset() selects a runway/water spot and must never handle a TP. */
export function placeVehicleExactly(vehicle, position, yaw, terrain) {
  const ph = vehicle.physics;
  if (!ph?.reset) { vehicle.reset?.(position, yaw); return; }
  const craft = ['plane', 'heli', 'boat'].includes(vehicle.kind);
  if (craft) {
    const air = vehicle.kind !== 'boat' && position.y - Math.max(0, terrain?.heightAt(position.x, position.z) || 0) > 12;
    const speed = air && vehicle.kind === 'plane' ? (vehicle.spec?.vTop || 50) * .62 : 0;
    ph.reset(position, yaw, { air, speed, throttle: air ? .7 : 0, hold: air ? 0 : 1 });
  } else {
    ph.reset({ x: position.x, y: position.y - (ph.spec?.restHeight || 0) - .03, z: position.z }, yaw);
  }
  vehicle.updateVisual?.(1, 0);
}

/** Find a nearby unoccupied position at the intended road/roof level. All
 * candidates stay inside the server's 32 m settling envelope. */
export function safeAdminPose(game, pose) {
  const p = game.player, vehicle = p?.state === 'vehicle' || p?.state === undefined ? p?.controllable : null;
  const body = vehicle?.body || p?.motor?.body, R = game.RAPIER, world = game.world;
  if (!R || !world || !body) return pose;
  const craft = ['plane', 'heli', 'boat'].includes(vehicle?.kind);
  const water = vehicle?.kind === 'boat';
  if (craft && !water && pose.y - Math.max(0, game.terrain.heightAt(pose.x, pose.z)) > 12) return pose;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw);
  const shapes = [];
  for (let i = 0; i < body.numColliders(); i++) {
    const c = body.collider(i), local = c.translationWrtParent(), rotation = c.rotationWrtParent();
    shapes.push({ shape: c.shape, offset: new THREE.Vector3(local.x, local.y, local.z).applyQuaternion(q),
      rotation: q.clone().multiply(new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)) });
  }
  // Newly streamed colliders are not in Rapier's world query index until the
  // next physics step. Test their shapes directly so paused/hidden tabs are
  // safe too, without advancing the entire simulation just to rebuild it.
  world.propagateModifiedBodyPositionsToColliders();
  const obstacles=[], floors=[];
  world.forEachCollider(c=>{
    if(!c.isEnabled()||c.isSensor()||c.parent()?.handle===body.handle)return;
    const membership=c.collisionGroups()>>>16;
    if(membership&(GROUPS.GROUND|GROUPS.STATIC|GROUPS.PROP|GROUPS.VEHICLE|GROUPS.TRAFFIC))obstacles.push(c);
    if(membership&(GROUPS.GROUND|GROUPS.STATIC|GROUPS.PROP))floors.push(c);
  });
  const ray = new R.Ray({ x: 0, y: pose.y + .6, z: 0 }, { x: 0, y: -1, z: 0 });
  const footLift = p?.motor?.lift || .89;
  for (const r of [0, 3, 6, 10, 16, 24]) for (let i = 0; i < (r ? 8 : 1); i++) {
    const a = i * Math.PI / 4, x = pose.x + Math.cos(a) * r, z = pose.z + Math.sin(a) * r;
    const ground = game.terrain.heightAt(x, z);
    if (water && ground > -.5) continue;
    let y = pose.y;
    if (!water) {
      ray.origin.x = x; ray.origin.z = z;
      let toi=Infinity;for(const c of floors){const t=c.castRay(ray,32.6,true);if(t>=0&&t<toi)toi=t;}
      let floor = Number.isFinite(toi) ? ray.origin.y-toi : ground;
      if (!Number.isFinite(toi)) {
        const n = game.roads?.nearest(x, z, 12, undefined, pose.y + .6, pose.y - 32);
        if (n && n.dist <= n.edge.w / 2) floor = Math.max(floor, n.y + .07);
      }
      if (floor < -.3 || floor < pose.y - 31) continue;
      y = floor + (vehicle ? vehicle.physics?.spec?.restHeight || 1 : 0) + .05;
    }
    if (Math.abs(y - pose.y) > 32) continue;
    const cy = vehicle ? y : y + footLift + .02;
    let blocked = false;
    for (const s of shapes) {
      const at={x:x+s.offset.x,y:cy+s.offset.y,z:z+s.offset.z};
      blocked=obstacles.some(c=>c.intersectsShape(s.shape,at,s.rotation));
      if (blocked) break;
    }
    if (!blocked) return { x, y, z, yaw: pose.yaw };
  }
  return null;
}
