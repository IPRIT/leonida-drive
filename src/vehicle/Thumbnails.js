// Vehicle preview service for the UI: cached thumbnails for every catalog entry (cars, trucks, bikes, plus aircraft
// and boats registered by other workstreams) and live turntables. Renders with the game's renderer into small
// render targets of a private studio scene (lights created once), never touching the main scene.
//
//   game.thumbnails = createThumbnails(game)
//   thumbs.get(id) -> HTMLCanvasElement | ImageBitmap | null      (cached; a miss queues a render)
//   thumbs.request(id, priority)                                     (higher priority renders first)
//   thumbs.onReady((id) => ...) -> unsubscribe
//   thumbs.createTurntable(el, id) -> { setId(id), dispose() }
import * as THREE from 'three';
import { getStudio, renderStudioAsync, warmStudio, buildPreviewObject } from './thumbnail.js';
import { getCatalogEntry } from './catalog.js';

const VERSION = 3; // bump when models change in a way that should invalidate stored thumbnails
const DB_NAME = 'leonida-thumbs';
const STORE = 'thumbs';

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

// ---------- model factories (aircraft / boats come from workstream B, loaded lazily) ----------
async function buildObjectFor(entry, id, lod) {
  if (entry && typeof entry.buildPreview === 'function') return wrap(await entry.buildPreview({ lod }));
  const kind = entry?.kind;
  if (kind === 'heli') {
    const [{ buildHeliModel }, { HELI_SPECS }] = await Promise.all([import('../air/models/helis.js'), import('../air/specs.js')]);
    return wrapModel(buildHeliModel(id, HELI_SPECS[id]));
  }
  if (kind === 'plane') {
    const [{ buildPlaneModel }, { PLANE_SPECS }, { PLANE_SPEC_ID }] = await Promise.all([import('../air/models/planes.js'), import('../air/specs.js'), import('../air/Plane.js')]);
    return wrapModel(buildPlaneModel(id, PLANE_SPECS[PLANE_SPEC_ID?.[id]] ?? PLANE_SPECS[id]));
  }
  if (kind === 'boat') {
    const { buildBoatModel } = await import('../boat/models.js');
    return wrapModel(buildBoatModel(id));
  }
  if (getCatalogEntry(id) || !entry) return buildPreviewObject(id, { lod });
  return null;
}

function wrapModel(m) {
  const root = m.root || m.object3d || m.body || m;
  const g = wrap(root);
  const mats = m.materials;
  g.userData.dispose = () => {
    g.traverse((o) => o.isMesh && o.geometry?.dispose());
    if (mats) for (const x of Object.values(mats)) x?.dispose?.();
  };
  return g;
}

function wrap(obj) {
  if (!obj) return null;
  if (obj.userData?.dispose) return obj;
  const g = new THREE.Group();
  g.add(obj);
  g.userData.dispose = () => g.traverse((o) => o.isMesh && o.geometry?.dispose());
  return g;
}

// ---------- IndexedDB (best effort) ----------
function openDB() {
  return new Promise((res) => {
    try {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}
function idbGet(db, key) {
  return new Promise((res) => {
    if (!db) return res(null);
    try {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}
function idbPut(db, key, val) {
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
  } catch {
    /* quota / private mode */
  }
}

/**
 * @param {object} game the game context (uses game.renderer, game.vehicles.catalog, game.paused)
 * @param {{width?: number, height?: number, always?: boolean}} [opts] always: also render while not paused
 */
export function createThumbnails(game, opts = {}) {
  const renderer = game.renderer;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const W = Math.round((opts.width ?? 384) * dpr), H = Math.round((opts.height ?? 216) * dpr);
  const mem = new Map(); // id -> canvas | ImageBitmap
  const queue = new Map(); // id -> priority
  const pending = new Set(); // in IDB lookup or building
  const listeners = new Set();
  const turntables = new Set();
  let db = null;
  const dbReady = openDB().then((d) => (db = d));
  let building = null; // { id, obj } built last frame, rendered this frame
  let raf = 0;

  const entryOf = (id) => game.vehicles?.byId?.get(id) || game.vehicles?.catalog?.find((e) => e.id === id) || getCatalogEntry(id) || null;
  const keyOf = (id) => {
    const e = getCatalogEntry(id);
    const src = e?.preset ? JSON.stringify(e.preset) : JSON.stringify({ id, n: entryOf(id)?.name, k: entryOf(id)?.kind });
    return `${id}|${VERSION}|${W}x${H}|${hashStr(src)}`;
  };
  const notify = (id) => {
    for (const cb of listeners) {
      try {
        cb(id);
      } catch (e) {
        console.error(e);
      }
    }
  };
  // bake budget: every frame while a menu pauses the world (or a turntable is up); otherwise (online the menu never
  // pauses, HUD vehicle-name thumbnail) one bake per 400 ms, so baking never piles onto consecutive game frames
  let lastBake = -1e9;
  const active = (now) => opts.always || game.paused || turntables.size > 0 || now - lastBake > 400;
  const wake = () => {
    if (!raf && typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(tick);
  };

  function request(id, priority = 0) {
    if (!id || mem.has(id)) return;
    if (pending.has(id)) {
      if (queue.has(id)) queue.set(id, Math.max(queue.get(id), priority));
      return;
    }
    pending.add(id);
    // IndexedDB first, then render queue
    dbReady.then(() => idbGet(db, keyOf(id))).then(async (blob) => {
      if (blob) {
        try {
          const bmp = await createImageBitmap(blob);
          mem.set(id, bmp);
          pending.delete(id);
          notify(id);
          return;
        } catch {
          /* fall through to a render */
        }
      }
      queue.set(id, Math.max(queue.get(id) ?? -Infinity, priority));
      wake();
    });
  }

  function get(id) {
    const v = mem.get(id);
    if (v) return v;
    request(id, 0);
    return null;
  }

  function nextId() {
    let best = null, bp = -Infinity;
    for (const [id, p] of queue) if (p > bp) { bp = p; best = id; }
    return best;
  }

  async function prepare(id) {
    try {
      const obj = await buildObjectFor(entryOf(id), id, opts.lod || 'low');
      if (!obj) {
        queue.delete(id);
        pending.delete(id);
        return;
      }
      await warmStudio(renderer, obj); // new material kinds compile in the background, not inside a frame
      building = { id, obj };
      wake();
    } catch (e) {
      console.warn('thumbnail build failed', id, e);
      queue.delete(id);
      pending.delete(id);
    }
  }

  let preparing = false;
  function tick() {
    raf = 0;
    const t0 = performance.now();
    for (const tt of turntables) tt._frame(t0);
    if (active(t0)) {
      if (building) {
        // render the model built during a previous frame (keeps each frame's share small); the pixels come back
        // asynchronously (no GPU stall), the model is freed right after the draw
        const { id, obj } = building;
        const canvas = document.createElement('canvas');
        const done = () => { queue.delete(id); pending.delete(id); notify(id); };
        let p = null, failed = false;
        try {
          p = renderStudioAsync(renderer, obj, canvas, W, H); // null: previous readback still in flight, retry next tick
        } catch (e) {
          failed = true;
          console.warn('thumbnail render failed', id, e);
        }
        if (p || failed) {
          building = null;
          lastBake = t0;
          obj.userData.dispose?.();
          if (failed) done();
          else {
            p.then((c) => {
              mem.set(id, c);
              c.toBlob?.((b) => b && dbReady.then(() => idbPut(db, keyOf(id), b)), 'image/png');
            }).catch((e) => console.warn('thumbnail readback failed', id, e)).finally(done);
          }
        }
      } else if (!preparing && queue.size) {
        const id = nextId();
        queue.set(id, -Infinity); // in progress
        preparing = true;
        prepare(id).finally(() => (preparing = false));
      }
    }
    if (building || queue.size || turntables.size) raf = requestAnimationFrame(tick);
  }

  function onReady(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /** Live rotating preview in `el` (~30 fps while visible), drag to rotate. */
  function createTurntable(el, id) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab';
    el.appendChild(canvas);
    let obj = null, curId = null, yaw = -0.72, pitch = 0.22, last = 0, dragging = false, visible = true, idle = 0, token = 0;
    let lx = 0, ly = 0;
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); if (visible) wake(); }) : null;
    io?.observe(el);
    const down = (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing'; };
    const move = (e) => {
      if (!dragging) return;
      yaw -= (e.clientX - lx) * 0.01;
      pitch = Math.max(-0.05, Math.min(0.9, pitch + (e.clientY - ly) * 0.006));
      lx = e.clientX; ly = e.clientY; idle = 0;
    };
    const up = () => { dragging = false; canvas.style.cursor = 'grab'; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    const tt = {
      async setId(nid) {
        if (nid === curId) return;
        curId = nid;
        const my = ++token;
        const o = await buildObjectFor(entryOf(nid), nid, 'high');
        if (o && my === token) await warmStudio(renderer, o);
        if (my !== token) { o?.userData.dispose?.(); return; }
        obj?.userData.dispose?.();
        obj = o;
        wake();
      },
      dispose() {
        turntables.delete(tt);
        io?.disconnect();
        canvas.removeEventListener('pointerdown', down);
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        canvas.remove();
        obj?.userData.dispose?.();
        obj = null;
      },
      _frame(now) {
        if (!obj || !visible || !el.isConnected || (typeof document !== 'undefined' && document.hidden)) return;
        if (now - last < 33) return;
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;
        idle += dt;
        if (!dragging && idle > 1.2) yaw += dt * 0.45;
        const rect = el.getBoundingClientRect();
        const w = Math.max(64, Math.min(960, Math.round(rect.width * dpr))), h = Math.max(48, Math.min(640, Math.round(rect.height * dpr)));
        renderStudioAsync(renderer, obj, canvas, w & ~1, h & ~1, { yaw, pitch, zoom: 0.92 }); // skips while a readback is in flight
      },
    };
    turntables.add(tt);
    tt.setId(id);
    return tt;
  }

  /** Data URL of a ready thumbnail (or null). */
  function getDataURL(id) {
    const v = get(id);
    if (!v) return null;
    if (v.toDataURL) return v.toDataURL('image/png');
    const c = document.createElement('canvas');
    c.width = v.width;
    c.height = v.height;
    c.getContext('2d').drawImage(v, 0, 0);
    return c.toDataURL('image/png');
  }

  // compile the studio programs early (one-off)
  getStudio(renderer);

  return {
    get, request, onReady, createTurntable, getDataURL,
    size: { width: W, height: H },
    /**
     * Loading screen: compile the studio programs for one vehicle and draw it once into a tiny target (GPU pipelines,
     * uniform tables), so the first garage visit / HUD thumbnail does not stall a frame.
     */
    async prewarm(id) {
      const obj = await buildObjectFor(entryOf(id), id, opts.lod || 'low');
      if (!obj) return;
      try {
        await warmStudio(renderer, obj);
        renderStudioAsync(renderer, obj, document.createElement('canvas'), 32, 32)?.catch(() => {});
      } finally { obj.userData.dispose?.(); }
    },
    /** Queue every catalog vehicle (low priority). */
    prefetchAll(priority = -1) {
      for (const e of game.vehicles?.catalog || []) request(e.id, priority);
    },
    clear() {
      mem.clear();
    },
  };
}
