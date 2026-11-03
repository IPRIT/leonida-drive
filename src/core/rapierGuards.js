// Rapier (wasm) panics when a method is called on a removed rigid body / collider ("Invalid RigidBody reference").
// A panic inside wasm never releases the Rust RefCell borrow it held, so from then on EVERY call into that set fails
// with "recursive use of an object detected" and the physics loop stops for good. One stale reference anywhere
// (a despawned traffic car, a debris chunk, a removed prop) is enough to kill the session.
// These guards make stale access harmless: removed handles are remembered in plain JS sets and every wrapper method
// short-circuits to a neutral value; removing something twice is a no-op. In dev the first stale call sites are logged.

const VEC = new Set(['translation', 'linvel', 'angvel', 'nextTranslation', 'localCom', 'worldCom', 'userForce', 'userTorque',
  'velocityAtPoint', 'effectiveAngularInertia', 'principalInertia', 'invPrincipalInertia', 'effectiveWorldInvInertiaSqrt']);
const QUAT = new Set(['rotation', 'nextRotation', 'principalInertiaLocalFrame']);
const NULLS = new Set(['collider', 'parent', 'shape', 'userData', 'contactCollider']);

let installed = null;

export function installRapierGuards(RAPIER, { dev = false } = {}) {
  if (installed) return installed;
  const deadB = new Set(), deadC = new Set();
  let logged = 0;
  const seen = new Set();
  const report = (kind, name) => {
    if (!dev || logged > 40) return;
    const stack = new Error().stack?.split('\n').slice(3, 7).join('\n') || '';
    const key = `${kind}.${name}|${stack.split('\n')[0]}`;
    if (seen.has(key)) return;
    seen.add(key);
    logged++;
    console.warn(`[physics] stale ${kind}.${name}() on a removed object\n${stack}`);
  };
  const neutral = (name) => {
    if (VEC.has(name)) return { x: 0, y: 0, z: 0 };
    if (QUAT.has(name)) return { x: 0, y: 0, z: 0, w: 1 };
    if (NULLS.has(name)) return null;
    if (/^(is|has|can)[A-Z]/.test(name)) return false;
    if (/^(num|mass|invMass|gravityScale|linearDamping|angularDamping|dominanceGroup|bodyType|friction|restitution|density|volume|radius|halfHeight|softCcdPrediction|collisionGroups|solverGroups|activeHooks|activeEvents|activeCollisionTypes|contactForceEventThreshold|contactSkin)/.test(name)) return 0;
    return undefined;
  };
  const wrap = (proto, dead, kind) => {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name === 'free' || name === 'finalizeDeserialization') continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== 'function') continue;
      const fn = d.value;
      if (name === 'isValid') {
        proto[name] = function () { return !dead.has(this.handle) && fn.call(this); };
        continue;
      }
      proto[name] = function (a, b, c, e, f, g) {
        if (dead.has(this.handle)) { report(kind, name); return neutral(name); }
        return fn.call(this, a, b, c, e, f, g);
      };
    }
  };
  wrap(RAPIER.RigidBody.prototype, deadB, 'RigidBody');
  wrap(RAPIER.Collider.prototype, deadC, 'Collider');

  const W = RAPIER.World.prototype;
  const removeBody = W.removeRigidBody, removeCollider = W.removeCollider;
  W.removeRigidBody = function (body) {
    if (!body || deadB.has(body.handle)) return;
    // RigidBodySet.remove() walks the body's colliders first: on a stale handle that is itself a panic
    if (!this.bodies.contains(body.handle)) { deadB.add(body.handle); return; }
    const n = body.numColliders();
    for (let i = 0; i < n; i++) { const c = body.collider(i); if (c) deadC.add(c.handle); }
    deadB.add(body.handle);
    removeBody.call(this, body);
  };
  W.removeCollider = function (collider, wakeUp) {
    if (!collider || deadC.has(collider.handle)) return;
    if (!this.colliders.contains(collider.handle)) { deadC.add(collider.handle); return; }
    deadC.add(collider.handle);
    removeCollider.call(this, collider, wakeUp);
  };
  installed = { deadB, deadC };
  return installed;
}
