import * as THREE from 'three';

// Fixed pool of PointLights shared by explosions (flashes) and fires. Lights stay in the scene at intensity 0
// when unused so the light count never changes (no shader recompiles).
export class FxLights {
  constructor(scene, count = 4) {
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xff8a3a, 0, 30, 2);
      l.castShadow = false;
      l.name = `fx:light${i}`;
      scene.add(l);
      this.lights.push(l);
    }
    this.sources = new Set();
    this._time = 0;
    this._list = [];
  }

  /** Short bright flash (explosions). */
  flash(pos, { color = 0xffa040, intensity = 2500, range = 45, duration = 0.8 } = {}) {
    const s = { kind: 'flash', pos: new THREE.Vector3(pos.x, pos.y, pos.z), color: new THREE.Color(color), i0: intensity, range, dur: duration, t: 0, cur: intensity };
    this.sources.add(s);
    return s;
  }

  /** Persistent source following a fire handle ({position, size, intensity, alive}). */
  addFire(handle) {
    const s = { kind: 'fire', handle, pos: handle.position, color: new THREE.Color(0xff7a2a), range: 14 + 10 * handle.size, cur: 0, seed: Math.random() * 100 };
    this.sources.add(s);
    return s;
  }

  remove(s) { this.sources.delete(s); }

  update(dt, cam) {
    this._time += dt;
    const list = this._list;
    list.length = 0;
    for (const s of this.sources) {
      if (s.kind === 'flash') {
        s.t += dt;
        if (s.t >= s.dur) { this.sources.delete(s); continue; }
        const k = 1 - s.t / s.dur;
        s.cur = s.i0 * k * k;
      } else {
        const h = s.handle;
        if (!h.alive) { this.sources.delete(s); continue; }
        const t = this._time * 9 + s.seed;
        const flick = 0.78 + 0.12 * Math.sin(t) + 0.1 * Math.sin(t * 2.37 + 1.3);
        s.cur = 45 * h.size * h.size * (h.intensity ?? 1) * (h.fade ?? 1) * flick;
        s.range = 12 + 10 * h.size;
      }
      const d2 = s.pos.distanceToSquared(cam);
      s.score = s.cur / (1 + d2 / (s.range * s.range * 4));
      if (s.cur > 0.5 && d2 < 260 * 260) list.push(s);
    }
    list.sort((a, b) => b.score - a.score);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const s = list[i];
      if (!s) { l.intensity = 0; continue; }
      l.position.copy(s.pos);
      if (s.kind === 'fire') l.position.y += 0.6 + 0.8 * s.handle.size;
      l.color.copy(s.color);
      l.intensity = s.cur;
      l.distance = s.range;
    }
  }

  clear() {
    this.sources.clear();
    for (const l of this.lights) l.intensity = 0;
  }

  dispose() {
    for (const l of this.lights) l.removeFromParent();
  }
}
