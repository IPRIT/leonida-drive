// Walking-only path graphs, built lazily per park. Never enter traffic routing.
export class ParkRoutes {
  constructor(data) { this.data = data; this.cache = new Map(); }

  graph(park) {
    if (this.cache.has(park)) return this.cache.get(park);
    const nodes = [], endpoints = new Map();
    const add = (x, z, key = null) => {
      if (key !== null && endpoints.has(key)) return endpoints.get(key);
      const id = nodes.length; nodes.push({ x, z, links: [], gate: key !== null && !!this.data.nodes[key]?.[2] });
      if (key !== null) endpoints.set(key, id);
      return id;
    };
    const join = (a, b) => {
      const cost = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
      nodes[a].links.push([b, cost]); nodes[b].links.push([a, cost]);
    };
    for (const path of this.data.paths) {
      if (path.park !== park || path.p.length < 4) continue;
      const p = path.p; let prev = add(p[0], p[1], path.a);
      for (let i = 2; i < p.length; i += 2) {
        const x = p[i - 2], z = p[i - 1], dx = p[i] - x, dz = p[i + 1] - z;
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 4));
        for (let k = 1; k <= n; k++) {
          const id = add(x + dx * k / n, z + dz * k / n, i === p.length - 2 && k === n ? path.b : null);
          join(prev, id); prev = id;
        }
      }
    }
    this.cache.set(park, nodes);
    return nodes;
  }

  nearest(park, x, z, gates = false) {
    const nodes = this.graph(park); let id = -1, best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]; if (gates && !n.gate) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < best) { best = d; id = i; }
    }
    return id;
  }

  path(park, x0, z0, x1, z1) {
    const nodes = this.graph(park), start = this.nearest(park, x0, z0), end = this.nearest(park, x1, z1);
    if (start < 0 || end < 0) return null;
    const dist = new Float64Array(nodes.length).fill(Infinity), prev = new Int32Array(nodes.length).fill(-1), heap = [];
    const push = (id, cost) => {
      let i = heap.length; heap.push([id, cost]);
      while (i) { const p = (i - 1) >> 1; if (heap[p][1] <= cost) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last; let i = 0;
        for (;;) { const a = i * 2 + 1, b = a + 1; let m = i;
          if (a < heap.length && heap[a][1] < heap[m][1]) m = a;
          if (b < heap.length && heap[b][1] < heap[m][1]) m = b;
          if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
        }
      }
      return top;
    };
    dist[start] = 0; push(start, 0);
    while (heap.length) {
      const [id, cost] = pop(); if (cost !== dist[id]) continue;
      if (id === end) break;
      for (const [to, weight] of nodes[id].links) if (cost + weight < dist[to]) {
        dist[to] = cost + weight; prev[to] = id; push(to, dist[to]);
      }
    }
    if (!Number.isFinite(dist[end])) return null;
    const chain = []; for (let i = end; i >= 0; i = prev[i]) chain.push(i);
    const out = [x0, z0];
    for (const i of chain.reverse()) out.push(nodes[i].x, nodes[i].z);
    out.push(x1, z1);
    return out;
  }

  route(a, b, parkAt, roadRoute) {
    const pa = parkAt(a.x, a.z), pb = parkAt(b.x, b.z);
    if (pa >= 0 && pa === pb) return this.path(pa, a.x, a.z, b.x, b.z) || roadRoute(a, b);
    const gate = (park, toward) => {
      if (park < 0) return null;
      const id = this.nearest(park, toward.x, toward.z, true);
      return id >= 0 ? this.graph(park)[id] : null;
    };
    const ga = gate(pa, b), gb = gate(pb, a);
    const first = ga ? this.path(pa, a.x, a.z, ga.x, ga.z) : null;
    const last = gb ? this.path(pb, gb.x, gb.z, b.x, b.z) : null;
    const middle = roadRoute(first ? ga : a, last ? gb : b);
    if (!middle) return null;
    return [...(first || []), ...middle, ...(last || [])];
  }
}
