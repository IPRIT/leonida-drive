// Vehicle lab: self-contained test scene for tuning the vehicle module.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Vehicle, VEHICLE_PRESETS, PRESET_ORDER, EngineAudio, ChaseCamera, SkidMarks, TireSmoke, DriveInput, GROUPS, groups,
} from './vehicle/index.js';

const H = 1 / 60;
const SIZE = 400; // terrain extent (m)
const CELL = 2;
const N = SIZE / CELL;
const WATER = -0.35;
const SPAWN = { pos: new THREE.Vector3(0, 0, 0), yaw: -Math.PI / 2 };

await RAPIER.init();

// ---------------- renderer / scene ----------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const DAY = { top: 0x2a74c9, horizon: 0xffc9a3, fog: 0xe9bfa6, sun: 0xffe6c4, sunI: 2.1, hemi: 0.55, exp: 0.95 };
const NIGHT = { top: 0x07081a, horizon: 0x3a1a4a, fog: 0x1a1030, sun: 0x8090ff, sunI: 0.25, hemi: 0.18, exp: 1.15 };
let night = false;

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: { top: { value: new THREE.Color(DAY.top) }, horizon: { value: new THREE.Color(DAY.horizon) } },
  vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vP;
    void main(){ float h = clamp(vP.y, -0.2, 1.0); float t = pow(max(h, 0.0), 0.55);
      vec3 c = mix(horizon, top, t); c = mix(c, horizon * 0.8, clamp(-h * 5.0, 0.0, 1.0));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), skyMat);
sky.renderOrder = -1;
scene.add(sky);
scene.fog = new THREE.Fog(DAY.fog, 160, 1100);

const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x8a6f5a, DAY.hemi);
scene.add(hemi);
const sun = new THREE.DirectionalLight(DAY.sun, DAY.sunI);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 300;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.45).normalize();

function applyTime() {
  const P = night ? NIGHT : DAY;
  skyMat.uniforms.top.value.set(P.top);
  skyMat.uniforms.horizon.value.set(P.horizon);
  scene.fog.color.set(P.fog);
  sun.color.set(P.sun);
  sun.intensity = P.sunI;
  hemi.intensity = P.hemi;
  scene.environmentIntensity = night ? 0.12 : 0.55;
  renderer.toneMappingExposure = P.exp;
}

// ---------------- physics world ----------------
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = H;
const fixedBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const G_GROUND = groups(GROUPS.GROUND);
const G_STATIC = groups(GROUPS.STATIC);
const G_PROP = groups(GROUPS.PROP);

// ---------------- terrain (heightfield) ----------------
const HILL = { x: 130, z: -70, top: 22, h: 8, slope: Math.tan((15 * Math.PI) / 180) };
const POOL = { x: -140, z: 95, hx: 18, hz: 12, depth: 2.4, ramp: 14 };
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function terrainHeight(x, z) {
  let h = 0;
  // hill: plateau with ~15 deg flanks (smoothed edges)
  const d = Math.hypot(x - HILL.x, z - HILL.z);
  const raw = HILL.h - Math.max(0, d - HILL.top) * HILL.slope;
  if (raw > -2) {
    const k = 2.2;
    const soft = raw > k ? raw : raw < -k ? 0 : (raw + k) ** 2 / (4 * k);
    h = Math.max(h, Math.min(HILL.h, soft));
  }
  // pool depression with a drive-in ramp on the east side
  const px = x - POOL.x, pz = z - POOL.z;
  if (Math.abs(pz) < POOL.hz + 2 && px > -POOL.hx - 2 && px < POOL.hx + POOL.ramp + 2) {
    const inZ = 1 - smooth(POOL.hz - 1, POOL.hz + 1, Math.abs(pz));
    let inX;
    if (px < POOL.hx) inX = 1 - smooth(POOL.hx - 1, POOL.hx + 1, -px);
    else inX = 1 - (px - POOL.hx) / POOL.ramp;
    inX = Math.max(0, Math.min(1, inX));
    h -= POOL.depth * inZ * inX;
  }
  // rough dirt area bumps
  if (x > -190 && x < -140 && z > -130 && z < -60) {
    const e = smooth(-190, -182, x) * smooth(-140, -148, x) * smooth(-130, -122, z) * smooth(-60, -68, z);
    h += e * (Math.sin(x * 0.55) * Math.cos(z * 0.47) * 0.35 + Math.sin(x * 0.21 + z * 0.17) * 0.4);
  }
  return h;
}

const heights = new Float32Array((N + 1) * (N + 1));
const hgrid = new Float32Array((N + 1) * (N + 1));
for (let i = 0; i <= N; i++) {
  for (let j = 0; j <= N; j++) {
    const x = -SIZE / 2 + j * CELL, z = -SIZE / 2 + i * CELL;
    const y = terrainHeight(x, z);
    heights[i + j * (N + 1)] = y; // column-major: row i along z, column j along x
    hgrid[i * (N + 1) + j] = y;
  }
}
world.createCollider(
  RAPIER.ColliderDesc.heightfield(N, N, heights, { x: SIZE, y: 1, z: SIZE }).setFriction(0.9).setCollisionGroups(G_GROUND),
  fixedBody,
);
function groundHeight(x, z) {
  const fx = (x + SIZE / 2) / CELL, fz = (z + SIZE / 2) / CELL;
  const j = Math.max(0, Math.min(N - 1, Math.floor(fx))), i = Math.max(0, Math.min(N - 1, Math.floor(fz)));
  const tx = fx - j, tz = fz - i;
  const a = hgrid[i * (N + 1) + j], b = hgrid[i * (N + 1) + j + 1], c = hgrid[(i + 1) * (N + 1) + j], d = hgrid[(i + 1) * (N + 1) + j + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

// surfaces
const SURF = {
  asphalt: { name: 'asphalt', grip: 1.0, rolling: 0, dust: false },
  grass: { name: 'grass', grip: 0.68, rolling: 0.035, dust: true },
  dirt: { name: 'dirt', grip: 0.74, rolling: 0.02, dust: true },
  sand: { name: 'sand', grip: 0.6, rolling: 0.09, dust: true },
  wet: { name: 'wet', grip: 0.72, rolling: 0.004, dust: false },
};
const REGIONS = [
  { s: SURF.grass, x0: 55, x1: 105, z0: 20, z1: 75 },
  { s: SURF.dirt, x0: -190, x1: -140, z0: -130, z1: -60 },
  { s: SURF.sand, x0: -190, x1: -140, z0: -30, z1: 40 },
  { s: SURF.wet, x0: 60, x1: 110, z0: 140, z1: 185 },
];
const env = {
  waterLevel: WATER,
  getSurface(x, z) {
    for (const r of REGIONS) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return r.s;
    // outskirts are grass
    if (Math.abs(x) > 185 || Math.abs(z) > 185) return SURF.grass;
    return SURF.asphalt;
  },
};

// terrain mesh with vertex colors
{
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  const col = new Float32Array((N + 1) * (N + 1) * 3);
  const cA = new THREE.Color(0x5d6066), cG = new THREE.Color(0x5f8f3e), cD = new THREE.Color(0x8c6a45), cS = new THREE.Color(0xd8c08a), cW = new THREE.Color(0x4a4f57), cP = new THREE.Color(0x6aa7b8);
  const tmp = new THREE.Color();
  let k = 0;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = -SIZE / 2 + j * CELL, z = -SIZE / 2 + i * CELL;
      const y = hgrid[i * (N + 1) + j];
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      const s = env.getSurface(x, z).name;
      tmp.copy(s === 'grass' ? cG : s === 'dirt' ? cD : s === 'sand' ? cS : s === 'wet' ? cW : cA);
      if (y < WATER - 0.2) tmp.lerp(cP, 0.6);
      const n = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      tmp.multiplyScalar(0.92 + Math.abs(n) * 0.12);
      if (s === 'asphalt' && Math.abs(x) < 190 && Math.abs(z) < 190) tmp.offsetHSL(0, 0, 0.0);
      col[k] = tmp.r; col[k + 1] = tmp.g; col[k + 2] = tmp.b;
      k += 3;
    }
  }
  const idx = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true }));
  m.receiveShadow = true;
  scene.add(m);
  // outer ground ring (visual only)
  const ring = new THREE.Mesh(new THREE.RingGeometry(SIZE * 0.7, 1400, 48, 1), new THREE.MeshStandardMaterial({ color: 0x5a8540, roughness: 1 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.05;
  scene.add(ring);
  // wet patch sheen
  const wet = new THREE.Mesh(new THREE.PlaneGeometry(50, 45), new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.08, metalness: 0.4, transparent: true, opacity: 0.55 }));
  wet.rotation.x = -Math.PI / 2;
  wet.position.set(85, 0.02, 162.5);
  wet.receiveShadow = true;
  scene.add(wet);
}

// water
{
  const w = new THREE.Mesh(
    new THREE.PlaneGeometry(POOL.hx * 2 + POOL.ramp + 4, POOL.hz * 2 + 4),
    new THREE.MeshStandardMaterial({ color: 0x1aa6c8, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.62, emissive: 0x05303a }),
  );
  w.rotation.x = -Math.PI / 2;
  w.position.set(POOL.x + POOL.ramp / 2, WATER, POOL.z);
  scene.add(w);
}

// ---------------- figure-8 track ----------------
const TRACK_R = 40, TRACK_W = 12;
function trackTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#2b2d31';
  g.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.06})`;
    g.fillRect(Math.random() * 128, Math.random() * 256, 2, 2);
  }
  g.fillStyle = '#e8e8e8';
  g.fillRect(4, 0, 5, 256);
  g.fillRect(119, 0, 5, 256);
  g.fillStyle = '#f2c230';
  g.fillRect(62, 0, 4, 120);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
{
  const tex = trackTexture();
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  for (const [cz, lift] of [[-TRACK_R, 0.03], [TRACK_R, 0.035]]) {
    const seg = 128;
    const pos = [], uv = [], idx = [];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      for (const side of [0, 1]) {
        const R = TRACK_R + (side ? TRACK_W / 2 : -TRACK_W / 2);
        const x = dx * R, z = cz + dz * R;
        pos.push(x, groundHeight(x, z) + lift, z);
        uv.push(side, (s / seg) * ((2 * Math.PI * TRACK_R) / 12));
      }
      if (s < seg) {
        const b = s * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    scene.add(m);
  }
}

// ---------------- static props ----------------
const statics = [];
const matConcrete = new THREE.MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.9, flatShading: true });
const matRamp = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.7, flatShading: true });
const matRampDark = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.8, flatShading: true });
const matCurbR = new THREE.MeshStandardMaterial({ color: 0xd8262f, roughness: 0.6, flatShading: true });
const matCurbW = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, flatShading: true });

function addBox(hx, hy, hz, x, y, z, mat, rot = null, group = G_STATIC, friction = 0.8) {
  const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(friction).setCollisionGroups(group);
  if (rot) d.setRotation(rot);
  world.createCollider(d, fixedBody);
  const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  m.position.set(x, y, z);
  if (rot) m.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  return m;
}

function addHull(points, mat) {
  const arr = new Float32Array(points.flatMap((p) => [p.x, p.y, p.z]));
  const d = RAPIER.ColliderDesc.convexHull(arr);
  if (!d) return;
  world.createCollider(d.setFriction(0.9).setCollisionGroups(G_STATIC), fixedBody);
  const m = new THREE.Mesh(new ConvexGeometry(points), mat);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}

/** Wedge ramp rising toward `dir` (unit XZ), base center (x,z). */
function addRamp(x, z, dirX, dirZ, len, width, height, mat = matRamp, flatTop = 0) {
  const g = groundHeight(x, z);
  const px = -dirZ, pz = dirX;
  const P = (along, side, y) => new THREE.Vector3(x + dirX * along + px * side, g + y, z + dirZ * along + pz * side);
  const hw = width / 2, hl = len / 2;
  const pts = [
    P(-hl, -hw, -0.3), P(-hl, hw, -0.3), P(hl + flatTop, -hw, -0.3), P(hl + flatTop, hw, -0.3),
    P(-hl, -hw, 0.0), P(-hl, hw, 0.0), P(hl, -hw, height), P(hl, hw, height),
  ];
  if (flatTop) pts.push(P(hl + flatTop, -hw, height), P(hl + flatTop, hw, height));
  addHull(pts, mat);
}

// ramps west of the figure-8 (driving north = -Z)
addRamp(-95, 10, 0, -1, 9, 7, 1.3);
addRamp(-95, -55, 0, -1, 15, 9, 3.2, matRamp, 4);
// landing ramp (descends toward -Z)
addRamp(-95, -102, 0, 1, 16, 10, 2.6, matRampDark, 0);
// side kicker for barrel rolls
addRamp(-122, -20, 0, -1, 8, 3.2, 1.6);

// banked curve (trimesh), 180 deg, opens toward -X
{
  const cx = 135, cz = 75, R = 34, W = 13, seg = 48, maxBank = (21 * Math.PI) / 180;
  const verts = [], idx = [];
  for (let s = 0; s <= seg; s++) {
    const t = s / seg;
    const a = -Math.PI / 2 + t * Math.PI; // from north side around east to south side
    const bank = maxBank * smooth(0, 0.22, t) * smooth(1, 0.78, t);
    const dx = Math.cos(a), dz = Math.sin(a);
    const ri = R - W / 2, ro = R + W / 2;
    const yo = W * Math.tan(bank);
    verts.push(cx + dx * ri, 0.02, cz + dz * ri); // inner top
    verts.push(cx + dx * ro, yo + 0.02, cz + dz * ro); // outer top
    verts.push(cx + dx * (ro + 0.5), 0, cz + dz * (ro + 0.5)); // outer base
    if (s < seg) {
      const b = s * 3, n = b + 3;
      idx.push(b, n, b + 1, b + 1, n, n + 1); // top
      idx.push(b + 1, n + 1, b + 2, b + 2, n + 1, n + 2); // outer wall
    }
  }
  const v = new Float32Array(verts), ix = new Uint32Array(idx);
  world.createCollider(RAPIER.ColliderDesc.trimesh(v, ix).setFriction(0.9).setCollisionGroups(G_GROUND), fixedBody);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.setIndex(new THREE.BufferAttribute(ix, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3b3e45, roughness: 0.85, flatShading: true, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  scene.add(m);
}

// curbs along the inner apexes of the figure-8
for (const cz of [-TRACK_R, TRACK_R]) {
  const r = TRACK_R - TRACK_W / 2 - 0.35;
  const base = cz < 0 ? -Math.PI / 2 : Math.PI / 2;
  for (let i = -9; i <= 9; i++) {
    const a = base + i * 0.045;
    const x = Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
    addBox(0.35, 0.06, 0.9, x, 0.06, z, i % 2 ? matCurbR : matCurbW, { x: q.x, y: q.y, z: q.z, w: q.w }, G_STATIC, 0.9);
  }
}
// curb strip on the straight test lane
for (let i = 0; i < 12; i++) addBox(0.25, 0.07, 0.6, 22 + i * 0.0, 0.07, 110 + i * 1.2, i % 2 ? matCurbR : matCurbW);

// static concrete blocks (jersey-barrier like)
for (let i = 0; i < 8; i++) addBox(1.6, 0.45, 0.35, -60 + i * 4.2, 0.45, 135, matConcrete);
addBox(2, 1, 2, 30, 1, -120, matConcrete);
addBox(1, 1.5, 1, 40, 1.5, -125, matConcrete);
addBox(6, 2.5, 0.5, 0, 2.5, -175, matConcrete);
addBox(0.5, 2.5, 20, 175, 2.5, -10, matConcrete);

// ---------------- dynamic box wall ----------------
const props = [];
{
  const crateMats = [0xd9733a, 0xc95f2c, 0xe08a4f].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, flatShading: true }));
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 7; col++) {
      const x = 40 + col * 1.02 + (row % 2) * 0.5, y = 0.5 + row * 1.0, z = 150;
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setCanSleep(true));
      world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(45).setFriction(0.6).setRestitution(0.1).setCollisionGroups(G_PROP), b);
      const m = new THREE.Mesh(geo, crateMats[(row + col) % 3]);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
      props.push({ b, m, x, y, z });
    }
  }
}
function resetProps() {
  for (const p of props) {
    p.b.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    p.b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    p.b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    p.b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}

// some decoration: palm-ish poles and start gantry
{
  const trunk = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9, flatShading: true });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x2f8a4a, roughness: 0.8, flatShading: true });
  const tg = [], lg = [];
  const rng = (s) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const r = rng(7);
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2, d = 205 + r() * 60;
    const x = Math.cos(a) * d, z = Math.sin(a) * d, h = 7 + r() * 5;
    const t = new THREE.CylinderGeometry(0.18, 0.28, h, 6);
    t.translate(x, h / 2, z);
    tg.push(t);
    for (let k = 0; k < 6; k++) {
      const l = new THREE.ConeGeometry(0.5, 3.2, 4);
      l.rotateZ(Math.PI / 2 + 0.35);
      l.translate(1.5, 0, 0);
      l.rotateY((k / 6) * Math.PI * 2 + r());
      l.translate(x, h, z);
      lg.push(l);
    }
  }
  const tm = new THREE.Mesh(mergeGeometries(tg), trunk);
  const lm = new THREE.Mesh(mergeGeometries(lg), leaf);
  tm.castShadow = lm.castShadow = true;
  scene.add(tm, lm);
  // start gantry
  const gm = new THREE.MeshStandardMaterial({ color: 0xff4fa3, roughness: 0.4, metalness: 0.3, emissive: 0x401028 });
  for (const sz of [-7.5, 7.5]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6, 0.5), gm);
    p.position.set(6, 3, sz);
    p.castShadow = true;
    scene.add(p);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 15.5), gm);
  bar.position.set(6, 6, 0);
  bar.castShadow = true;
  scene.add(bar);
}

world.step(); // build broad phase before the first wheel raycasts

// ---------------- effects / vehicle ----------------
const skidMarks = new SkidMarks(scene, { maxQuads: 4000 });
const tireSmoke = new TireSmoke(scene, { max: 900 });
const audio = new EngineAudio({ preset: 'comet' });
const input = new DriveInput();

let vehicle = null;
let presetName = 'comet';
let headlights = false;
let siren = false;
let assistsOn = true;

function spawnVehicle(name, pos = SPAWN.pos, yaw = SPAWN.yaw) {
  if (vehicle) vehicle.dispose();
  presetName = name;
  vehicle = new Vehicle({ RAPIER, world, scene, preset: name, position: pos, yaw, env, skidMarks, tireSmoke });
  vehicle.setHeadlights(headlights);
  vehicle.siren = siren && name === 'cruiser';
  audio.setSiren(vehicle.siren);
  Object.assign(vehicle.assists, { abs: assistsOn, tcs: assistsOn, esc: assistsOn, steerAssist: assistsOn });
  audio.setPreset(name);
  cam.snap(vehicle);
}

const cam = new ChaseCamera(camera, renderer.domElement, {
  getGroundHeight: groundHeight,
  input,
  raycast: (o, d, max) => {
    const hit = world.castRay(new RAPIER.Ray(o, d), max, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, groups(0xffff, GROUPS.STATIC));
    return hit ? hit.timeOfImpact : null;
  },
});
spawnVehicle('comet');

// ---------------- UI ----------------
const hud = document.getElementById('hud');
const banner = document.getElementById('banner');
const start = document.getElementById('start');
start.addEventListener('click', async () => {
  start.style.display = 'none';
  await audio.start();
  audio.setMasterVolume(0.55);
});
window.addEventListener('keydown', async (e) => {
  if (!audio.started && start.style.display !== 'none') {
    start.style.display = 'none';
    await audio.start();
  }
  const k = e.code;
  if (k.startsWith('Digit')) {
    const i = +k.slice(5) - 1;
    if (i >= 0 && i < PRESET_ORDER.length) {
      const t = vehicle.body.translation();
      const yaw = vehicle.object3d.rotation.y;
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(vehicle.object3d.quaternion);
      spawnVehicle(PRESET_ORDER[i], new THREE.Vector3(t.x, groundHeight(t.x, t.z), t.z), Math.atan2(-f.x, -f.z) || yaw);
    }
  } else if (k === 'KeyC') cam.nextMode();
  else if (k === 'KeyR') {
    vehicle.reset(SPAWN.pos, SPAWN.yaw);
    resetProps();
    skidMarks.clear();
    cam.snap(vehicle);
  } else if (k === 'KeyT') {
    const t = vehicle.body.translation();
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(vehicle.object3d.quaternion);
    vehicle.reset(new THREE.Vector3(t.x, groundHeight(t.x, t.z) + 0.5, t.z), Math.atan2(-f.x, -f.z));
  } else if (k === 'KeyH') {
    headlights = !headlights;
    vehicle.setHeadlights(headlights);
  } else if (k === 'KeyL') {
    siren = !siren;
    vehicle.siren = siren;
    audio.setSiren(siren && !!vehicle.model.lightbar);
  } else if (k === 'KeyM') audio.toggleMute();
  else if (k === 'KeyP') {
    assistsOn = !assistsOn;
    Object.assign(vehicle.assists, { abs: assistsOn, tcs: assistsOn, esc: assistsOn, steerAssist: assistsOn });
  } else if (k === 'KeyN') {
    night = !night;
    applyTime();
    if (night && !headlights) {
      headlights = true;
      vehicle.setHeadlights(true);
    }
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

hud.innerHTML = `
  <div><span class="big" id="spd">0</span><span class="unit">km/h</span><span class="gear" id="gear">1</span></div>
  <div id="name" style="color:#ffb347;margin:2px 0 4px"></div>
  <div class="row"><span class="lbl">rpm</span><span class="bar"><i id="rpm"></i></span><span id="rpmT" style="width:42px;text-align:right"></span></div>
  <div class="row"><span class="lbl">thr</span><span class="bar"><i id="thr"></i></span></div>
  <div class="row"><span class="lbl">brake</span><span class="bar"><i id="brk"></i></span></div>
  <div class="row"><span class="lbl">boost</span><span class="bar"><i id="bst"></i></span></div>
  <div class="row"><span class="lbl">slip β</span><span id="beta"></span><span class="lbl" style="margin-left:8px">lat g</span><span id="latg"></span></div>
  <div class="wheels" id="wheels"></div>
  <div class="flags" id="flags"></div>
  <div style="color:#789;margin-top:4px" id="perf"></div>`;
const $ = (id) => document.getElementById(id);
const wheelsEl = $('wheels');
const wheelNames = ['FL', 'FR', 'RL', 'RR'];
wheelsEl.innerHTML = wheelNames
  .map((n, i) => `<div class="wheel"><div>${n} <span id="ws${i}" style="color:#9ab"></span></div><div class="bar slip"><i id="wsl${i}"></i></div><div class="bar load"><i id="wld${i}"></i></div></div>`)
  .join('');
let hudTimer = 0;
let fpsAcc = 0, fpsN = 0, fps = 0;
function updateHud(dt) {
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.08;
  const t = vehicle.telemetry;
  $('spd').textContent = Math.round(t.speedKmh);
  $('gear').textContent = t.gear < 0 ? 'R' : t.gear === 0 ? 'N' : String(t.gear);
  $('name').textContent = `${VEHICLE_PRESETS[presetName].label} (${presetName}, ${vehicle.spec.drive}) · cam: ${cam.mode}`;
  $('rpm').style.width = `${Math.min(100, (t.rpm / t.maxRpm) * 100)}%`;
  $('rpmT').textContent = Math.round(t.rpm);
  $('thr').style.width = `${t.throttle * 100}%`;
  $('brk').style.width = `${t.brake * 100}%`;
  $('bst').style.width = `${t.boost * 100}%`;
  $('beta').textContent = `${((t.slipAngle * 180) / Math.PI).toFixed(1)}°`;
  $('latg').textContent = (t.latAccel / 9.81).toFixed(2);
  t.wheels.forEach((w, i) => {
    const slip = Math.min(1, Math.max(Math.abs(w.slipRatio) / 0.3, Math.abs(w.slipAngle) / 0.35));
    $(`wsl${i}`).style.width = `${slip * 100}%`;
    $(`wld${i}`).style.width = `${Math.min(100, (w.load / (vehicle.spec.mass * 9.81 * 0.5)) * 100)}%`;
    $(`ws${i}`).textContent = w.contact ? `${w.surface} κ${w.slipRatio.toFixed(2)} α${((w.slipAngle * 180) / Math.PI).toFixed(0)}°` : 'air';
  });
  const flag = (n, on) => `<span class="${on ? 'on' : ''}">${n}</span>`;
  $('flags').innerHTML = [
    flag('ABS', vehicle.assists.abs), flag('TCS', vehicle.assists.tcs), flag('ESC', vehicle.assists.esc), flag('STEER', vehicle.assists.steerAssist),
    flag('DRIFT', t.drifting), flag('AIR', t.airborne), flag('BOOST', t.boosting), flag('WATER', t.inWater), flag(audio.muted ? 'MUTED' : 'SND', audio.started && !audio.muted),
  ].join('');
  $('perf').textContent = `${fps.toFixed(0)} fps · ${renderer.info.render.calls} draws · ${input.lastDevice}`;
}

// ---------------- loop ----------------
let acc = 0;
let last = performance.now();
let wastedTimer = 0;
const _sunPos = new THREE.Vector3();

function tick(dt, inp) {
  acc += dt;
  let steps = 0;
  while (acc >= H && steps < 6) {
    vehicle.fixedUpdate(H, wastedTimer > 0 ? {} : inp);
    world.step();
    acc -= H;
    steps++;
  }
  if (steps >= 6) acc = 0;
  const alpha = acc / H;
  vehicle.updateVisual(alpha, dt);

  for (const p of props) {
    const t = p.b.translation(), r = p.b.rotation();
    p.m.position.set(t.x, t.y, t.z);
    p.m.quaternion.set(r.x, r.y, r.z, r.w);
  }

  if (vehicle.drowned && wastedTimer <= 0) {
    wastedTimer = 2.5;
    banner.style.display = 'block';
  }
  if (wastedTimer > 0) {
    wastedTimer -= dt;
    if (wastedTimer <= 0) {
      banner.style.display = 'none';
      vehicle.reset(SPAWN.pos, SPAWN.yaw);
      cam.snap(vehicle);
    }
  }

  skidMarks.update(dt);
  tireSmoke.update(dt, camera, renderer.domElement.height);
  cam.update(dt, vehicle);
  audio.update(vehicle.telemetry, dt);

  // sun / shadow camera follows the car
  const cp = vehicle.object3d.position;
  _sunPos.copy(SUN_DIR).multiplyScalar(120).add(cp);
  sun.position.copy(_sunPos);
  sun.target.position.copy(cp);
  sky.position.copy(camera.position);
}

let paused = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (paused) return;
  tick(dt, input.update(dt, vehicle.telemetry.speedKmh));
  renderer.render(scene, camera);
  updateHud(dt);
}

/** Deterministic scripted run for debugging: inputFn(t) -> input. */
function simulate(seconds, inputFn = () => ({})) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) tick(H, inputFn(i * H));
  renderer.render(scene, camera);
  updateHud(1);
  return vehicle.telemetry;
}
applyTime();
requestAnimationFrame(frame);

// expose for debugging in the console
window.lab = {
  THREE, RAPIER, world, scene, camera, renderer, cam, audio, input, spawnVehicle, skidMarks, tireSmoke, simulate,
  get vehicle() { return vehicle; },
  set paused(v) { paused = v; },
  render: () => renderer.render(scene, camera),
};
