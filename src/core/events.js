// Tiny synchronous event bus.
export class Events {
  constructor() { this.map = new Map(); }

  on(name, fn) {
    let l = this.map.get(name);
    if (!l) this.map.set(name, (l = new Set()));
    l.add(fn);
    return () => l.delete(fn);
  }

  once(name, fn) {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }

  emit(name, payload) {
    const l = this.map.get(name);
    if (!l) return;
    for (const fn of [...l]) {
      try { fn(payload); } catch (e) { console.error(`[events] ${name}`, e); }
    }
  }
}
