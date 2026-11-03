"""Separate clear highway crossings before fitting the network's height field.

Only two opposed through-routes qualify. Connections continue through the actual
ramps in the source graph; there is no turn between the two decks at a crossing.
Short ramps whose grade budget cannot provide clearance remain at grade and are
reported for source review rather than receiving an impossible vertical kink.
"""
import heapq
import math

import numpy as np

CLEARANCE = 7.4  # asphalt to asphalt; the runtime bridge slab is 1.35 m thick


def grade_limit(edge):
    s = edge['src']
    return 0.025 if s.get('cl') in (4, 5) else 0.075 if s.get('rp') else {'highway': 0.06, 'road': 0.095, 'dirt': 0.12}[s['k']]


def _plan_interchanges(nodes, edges, skip):
    adj = [[] for _ in nodes]
    for i, e in enumerate(edges):
        adj[e['src']['a']].append(i)
        if e['src']['a'] != e['src']['b']:
            adj[e['src']['b']].append(i)

    def direction(e, ni):
        p = e['P'] if e['src']['a'] == ni else e['P'][::-1]
        s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]
        d = min(25, s[-1])
        v = np.array([np.interp(d, s, p[:, 0]), np.interp(d, s, p[:, 1])]) - p[0]
        return v / max(1e-9, np.linalg.norm(v))

    def nearby(start, budget, metric):
        seen, found, queue = {start: 0.0}, set(), [(0.0, start)]
        while queue:
            d, n = heapq.heappop(queue)
            if d > seen[n] or d > budget:
                continue
            for ei in adj[n]:
                e = edges[ei]
                found.add(ei)
                to = e['src']['b'] if e['src']['a'] == n else e['src']['a']
                nd = d + e['S'][-1] * (grade_limit(e) if metric == 'grade' else 1)
                if nd <= budget and nd < seen.get(to, math.inf):
                    seen[to] = nd
                    heapq.heappush(queue, (nd, to))
        return seen, found

    candidates = []
    for ni, inc in enumerate(adj):
        if ni in skip:
            continue
        if len(inc) != 4 or any(edges[i]['src']['a'] == edges[i]['src']['b'] or
                                edges[i]['src']['k'] == 'dirt' or edges[i]['src'].get('cl') in (4, 5) for i in inc):
            continue
        dirs = [direction(edges[i], ni) for i in inc]
        best = None
        for a in range(4):
            for b in range(a + 1, 4):
                up = [edges[inc[k]]['src'] for k in (a, b)]
                if any(e['k'] != 'highway' for e in up) or min(e['w'] for e in up) < 11:
                    continue
                lower = [k for k in range(4) if k not in (a, b)]
                straight = float(dirs[a] @ dirs[b])
                if straight > -0.94 or float(dirs[lower[0]] @ dirs[lower[1]]) > -0.88:
                    continue
                if any(abs(float(dirs[a] @ dirs[k])) > 0.72 for k in lower):
                    continue
                score = (2 - sum(bool(e.get('rp')) for e in up), min(e['w'] for e in up), -straight,
                         abs(float(dirs[a][0])))
                if best is None or score > best[0]:
                    best = (score, [inc[a], inc[b]], [inc[k] for k in lower], dirs[a])
        if best:
            candidates.append((ni, best))
    candidates.sort(key=lambda item: item[1][0], reverse=True)
    out, rejected = [], []
    for ni, (_, upper, lower, direction_) in candidates:
        nj = len(nodes)
        nodes.append(list(nodes[ni]))
        adj.append(upper.copy())
        adj[ni] = lower.copy()
        for ei in upper:
            s = edges[ei]['src']
            s['a' if s['a'] == ni else 'b'] = nj
        reachable, _ = nearby(ni, CLEARANCE + 0.3, 'grade')
        if nj in reachable:
            for ei in upper:
                s = edges[ei]['src']
                s['a' if s['a'] == nj else 'b'] = ni
            nodes.pop(); adj.pop(); adj[ni] = upper + lower
            rejected.append({'node': ni, 'reason': 'short connecting ramp', 'grade_budget_m': round(reachable[nj], 2)})
            continue
        radius = max(edges[i]['src']['w'] for i in upper + lower) + 14
        _, upper_edges = nearby(nj, radius, 'length')
        _, lower_edges = nearby(ni, radius, 'length')
        out.append({'ni': ni, 'nj': nj, 'x': nodes[ni][0], 'z': nodes[ni][1], 'dir': direction_.tolist(),
                    'clearance': CLEARANCE, 'radius': radius,
                    'upper': sorted(upper_edges - lower_edges), 'lower': sorted(lower_edges - upper_edges)})
    print('interchanges:', len(out), 'separated,', len(rejected), 'need source review', flush=True)
    return out, rejected


class LevelBounds:
    """Incremental feasibility of y[b] <= y[a] + limit, with rollback.

    A valid potential makes existing arc weights nonnegative. Dijkstra then
    detects whether a new clearance would create a contradictory height cycle.
    This checks the complete ramp network, not just the crossing's centre.
    """
    def __init__(self, count):
        self.adj = [[] for _ in range(count)]
        self.potential = np.zeros(count)

    def slope(self, a, b, limit):
        self.adj[a].append((b, limit))
        self.adj[b].append((a, limit))

    def clearance(self, pairs, height=CLEARANCE):
        original, lengths = {}, {}
        p = self.potential
        for upper, lower in pairs:
            reduced = -height + p[upper] - p[lower]
            if reduced < -1e-8:
                limit, distances, queue = -reduced, {lower: 0.0}, [(0.0, lower)]
                conflict = False
                while queue:
                    d, node = heapq.heappop(queue)
                    if d > distances[node] or d >= limit - 1e-8:
                        continue
                    if node == upper:
                        conflict = True
                        break
                    for to, w in self.adj[node]:
                        rw = w + p[node] - p[to]
                        if rw < -1e-6:
                            raise RuntimeError('Invalid clearance feasibility potential')
                        nd = d + max(0.0, rw)
                        if nd < limit - 1e-8 and nd < distances.get(to, math.inf):
                            distances[to] = nd
                            heapq.heappush(queue, (nd, to))
                if conflict:
                    for v, y in original.items(): p[v] = y
                    for v, n in lengths.items(): del self.adj[v][n:]
                    return False
                for v, d in distances.items():
                    original.setdefault(v, p[v])
                    p[v] += d + reduced
            lengths.setdefault(upper, len(self.adj[upper]))
            self.adj[upper].append((lower, -height))
        return True


def plan_interchanges(nodes, edges):
    from scipy.spatial import cKDTree
    original_n = len(nodes)
    endpoints = [(e['src']['a'], e['src']['b']) for e in edges]
    points = np.concatenate([e['P'] for e in edges])
    owners = np.concatenate([np.full(len(e['P']), i) for i, e in enumerate(edges)])
    widths = np.concatenate([np.full(len(e['P']), e['src']['w'] / 2) for e in edges])
    pairs = cKDTree(points).query_pairs(r=float(widths.max() * 2 + 2), output_type='ndarray')
    a, b = pairs[:, 0], pairs[:, 1]
    pairs = pairs[np.linalg.norm(points[a] - points[b], axis=1) < widths[a] + widths[b] + 2]
    excluded, review = set(), []
    for _ in range(original_n):
        del nodes[original_n:]
        for e, (a, b) in zip(edges, endpoints): e['src']['a'], e['src']['b'] = a, b
        crossings, short = _plan_interchanges(nodes, edges, excluded)
        base, variables = len(nodes), []
        for e in edges:
            n = len(e['P'])
            variables.append(np.r_[e['src']['a'], base + np.arange(n - 2), e['src']['b']].astype(int))
            base += n - 2
        bounds = LevelBounds(base)
        for e, vs in zip(edges, variables):
            for a, b, h in zip(vs[:-1], vs[1:], np.maximum(np.diff(e['S']), 0.5)):
                bounds.slope(int(a), int(b), h * grade_limit(e))
        all_v = np.concatenate(variables)
        bad = []
        for c in crossings:
            levels = crossing_pairs([c], pairs, points, owners)
            cp = {(c['nj'], c['ni'])}
            for (a, b), sign in zip(pairs[levels != 0], levels[levels != 0]):
                u, l = (int(all_v[a]), int(all_v[b])) if sign > 0 else (int(all_v[b]), int(all_v[a]))
                if u != l: cp.add((u, l))
            if not bounds.clearance(sorted(cp)):
                bad.append(c['ni'])
        if not bad:
            print('interchanges: footprint clearance and all connecting grades are feasible', flush=True)
            return crossings, review + short
        excluded.update(bad)
        review.extend({'node': n, 'reason': 'crossing footprint exceeds connecting ramp grade budget'} for n in bad)
    raise RuntimeError('Interchange planning failed to settle')


def crossing_pairs(crossings, point_pairs, points, owners):
    """Orient overlapping centreline samples as (upper, lower) for height bounds."""
    orientation = np.zeros(len(point_pairs), dtype=np.int8)
    a, b = point_pairs[:, 0], point_pairs[:, 1]
    for crossing in crossings:
        r = crossing['radius'] + 12
        near = np.sum((points - [crossing['x'], crossing['z']]) ** 2, axis=1) < r * r
        up = np.isin(owners, crossing['upper']) & near
        low = np.isin(owners, crossing['lower']) & near
        orientation[up[a] & low[b]] = 1
        orientation[low[a] & up[b]] = -1
    return orientation
