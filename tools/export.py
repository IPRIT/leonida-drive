"""Build game-ready data from the classified layers.

Outputs (public/data):
  height.bin   gzip(Int16 decimetres) GW+1 x GH+1 samples, 8 m spacing, row-major (z rows, x cols)
  ground.bin   gzip(Uint8 ground class) TW x TH texels, 4 m spacing
  roads.json   graph with resampled points + heights + bridge flags
  buildings.json footprints with base height
  veg.bin      gzip(Float32 x, z, Uint8 type, scale, rot packed) vegetation instances
  map.webp     GTA-radar-style map image (4 m/px) + map_small.webp (16 m/px)
  world.json   metadata, districts, labels, spawns
"""
import collections
import gzip
import json
import math
import os
import time
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage as ndi

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')
CLS = os.path.join(RAW, 'cls')
OUT = os.path.join(ROOT, 'public', 'data')
os.makedirs(OUT, exist_ok=True)

MPP, X0, Z0 = 2.0, -11368.0, -11000.0      # mosaic mapping
WX0, WZ0, WX1, WZ1 = -9216.0, -9216.0, 4096.0, 9728.0  # world bounds
HS = 8.0   # height spacing
TS = 4.0   # ground texture spacing
GW, GH = int((WX1 - WX0) / HS), int((WZ1 - WZ0) / HS)   # cells
TW, TH = int((WX1 - WX0) / TS), int((WZ1 - WZ0) / TS)

# mosaic classes
C = dict(unknown=0, water=1, land=2, park=3, wetland=4, beach=5, industrial=6, dirtfield=7, urban=8, paved=9,
         building=10, building_blue=11, road=12, highway=13, dirtroad=14, farm=15, sport=16, white=17, dark=18, apron=19)
# ground classes for the game shader
G = dict(water=0, sand=1, grass=2, park=3, wetland=4, farm=5, dirt=6, urban=7, paved=8, building=9, road=10, sport=11)
CLS2G = np.zeros(32, np.uint8)
for k, v in {'unknown': 'grass', 'water': 'water', 'land': 'grass', 'park': 'park', 'wetland': 'wetland', 'beach': 'sand',
             'industrial': 'dirt', 'dirtfield': 'dirt', 'urban': 'urban', 'paved': 'paved', 'building': 'building',
             'building_blue': 'building', 'road': 'road', 'highway': 'road', 'dirtroad': 'dirt', 'farm': 'farm',
             'sport': 'sport', 'white': 'urban', 'dark': 'urban', 'apron': 'paved'}.items():
    CLS2G[C[k]] = G[v]

BAND_LO = [0.6, 20, 40, 60, 80, 100, 150, 200, 250, 300, 350, 400]
BAND_HI = [17, 40, 60, 80, 100, 150, 200, 250, 300, 350, 400, 460]


def wgz(path, arr):
    with open(path, 'wb') as f:
        f.write(gzip.compress(arr.tobytes(), 6))
    print('  wrote', os.path.basename(path), '%.2f MB' % (os.path.getsize(path) / 1e6))


def mosaic_window(arr, fill, step):
    """Resample a 2 m mosaic-aligned array onto the world grid with `step` metres spacing (nearest)."""
    n_x = int((WX1 - WX0) / step)
    n_z = int((WZ1 - WZ0) / step)
    xs = ((WX0 + (np.arange(n_x) + 0.5) * step - X0) / MPP).astype(np.int64)
    zs = ((WZ0 + (np.arange(n_z) + 0.5) * step - Z0) / MPP).astype(np.int64)
    H, W = arr.shape
    out = np.full((n_z, n_x), fill, arr.dtype)
    vx = (xs >= 0) & (xs < W)
    vz = (zs >= 0) & (zs < H)
    out[np.ix_(vz, vx)] = arr[np.ix_(zs[vz], xs[vx])]
    return out


def block_mean(arr, step):
    """Average a 2 m mosaic array over world cells of `step` metres (step multiple of 2)."""
    k = int(step / MPP)
    n_x = int((WX1 - WX0) / step)
    n_z = int((WZ1 - WZ0) / step)
    ox = int((WX0 - X0) / MPP)
    oz = int((WZ0 - Z0) / MPP)
    H, W = arr.shape
    big = np.zeros((n_z * k, n_x * k), np.float32)
    # copy overlapping window
    sx0, sz0 = max(0, ox), max(0, oz)
    sx1, sz1 = min(W, ox + n_x * k), min(H, oz + n_z * k)
    big[sz0 - oz:sz1 - oz, sx0 - ox:sx1 - ox] = arr[sz0:sz1, sx0:sx1]
    return big.reshape(n_z, k, n_x, k).mean(axis=(1, 3)), (sz0 - oz, sz1 - oz, sx0 - ox, sx1 - ox)


def _arclen(p):
    return np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]


def _hermite(pa, ua, pb, ub_out, step=4.0, tension=0.5):
    """Curve from pa leaving along ua to pb arriving against ub_out (the outward direction at pb)."""
    L = float(np.hypot(*(pb - pa)))
    n = max(2, int(math.ceil(L / step)))
    t = np.linspace(0, 1, n + 1)[:, None]
    t2, t3 = t * t, t * t * t
    m0, m1 = ua * L * tension, -ub_out * L * tension
    return (2 * t3 - 3 * t2 + 1) * pa + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * pb + (t3 - t2) * m1


def source_evidence():
    """Pixels of the source map that are road paint or something printed over a road (label glyphs, their dark
    outlines, route shields, rail lines): a gap in the road graph across such pixels is an artefact."""
    a = np.asarray(Image.open(os.path.join(RAW, 'mosaic_nc_z5.png')).convert('RGB'))
    r, g, b = (a[..., i].astype(np.int16) for i in range(3))
    spread = np.maximum(np.maximum(np.abs(r - g), np.abs(g - b)), np.abs(r - b))
    lum = (r + g + b) // 3
    del a
    grey = spread <= 8
    ev = grey & ((lum <= 132) | (lum >= 230))            # asphalt greys, glyph fill / outlines, rail lines
    ev |= (b > 120) & (r < 90) & (b - r > 60) & (g < 140)  # interstate shields (blue)
    ev |= (r > 150) & (g < 90) & (b < 90)                 # shield tops / red labels
    ev |= (r > 235) & (g > 225) & (b > 150) & (b < 200) & (r - b > 45)  # railway lines (pale yellow) over a road
    del r, g, b, spread, lum, grey
    return ndi.binary_dilation(ev, iterations=2)


def repair_graph(roads, cls, bridge_mask, height_at):
    """Close the gaps the source map leaves in roads, snap near-miss T junctions and clean road classes.

    Route shields, place names, street-name labels, railway lines and narrow bridge outlines are drawn over the
    roads on the community map. Classification turns them into non-road pixels, so the skeleton stops on both
    sides and the game shows road pieces with flat cut ends floating in the grass, or streets ending a few metres
    short of the crossing street. Repairs, in order:
      1. facing dead ends (each points at the other, <= 160 m, no hill in between - those are tunnels, found at
         runtime) are joined by a smooth Hermite connector; weakly aligned / long pairs need source evidence;
      2. a dead end pointing at another road (or node) <= 25 m ahead is snapped into a T junction (the target edge
         is split), if the source map shows road paint or print between them;
      3. road class noise: short runs of 'highway' inside a street chain (and vice versa) take the chain's class;
      4. connected pieces shorter than 60 m in total (icons, glyph strokes) are removed.
    Returns the repaired graph and a stats dict.
    """
    nodes = [list(map(float, n)) for n in roads['nodes']]
    edges = []
    for e in roads['edges']:
        q = dict(e)
        q['p'] = np.array(e['p'], np.float64).reshape(-1, 2)
        q['br'] = np.array(e.get('br', [0] * len(q['p'])), np.int8)
        edges.append(q)
    H, W = cls.shape
    ev = source_evidence()
    pix = lambda P: (np.clip(((P[:, 1] - Z0) / MPP).astype(int), 0, H - 1), np.clip(((P[:, 0] - X0) / MPP).astype(int), 0, W - 1))

    def water_at(P):
        iy, ix = pix(P)
        return ((cls[iy, ix] == C['water']) | bridge_mask[iy, ix]).astype(np.int8)

    def evidence(Q, skip=2.0):
        S = _arclen(Q)
        if S[-1] <= 2 * skip:
            return 1.0
        ss = np.arange(skip, S[-1] - skip, 1.0)
        P = np.stack([np.interp(ss, S, Q[:, 0]), np.interp(ss, S, Q[:, 1])], 1)
        iy, ix = pix(P)
        return float(ev[iy, ix].mean())

    def adjacency():
        adj = [[] for _ in nodes]
        for i, e in enumerate(edges):
            adj[e['a']].append(i)
            if e['b'] != e['a']:
                adj[e['b']].append(i)
        return adj

    def end_dirs(i, at_a):
        p = edges[i]['p'] if at_a else edges[i]['p'][::-1]
        s = _arclen(p)
        out = []
        for back in (8.0, 20.0):
            b = min(back, s[-1])
            q = np.array([np.interp(b, s, p[:, 0]), np.interp(b, s, p[:, 1])])
            d = p[0] - q
            out.append(d / (np.hypot(*d) + 1e-9))
        return p[0].copy(), out

    def crosses_other(Q, skip):
        # does the polyline Q cross any other edge (would create an at-grade crossing without a node)?
        lo, hi = Q.min(0) - 1, Q.max(0) + 1
        for k, e in enumerate(edges):
            if k in skip:
                continue
            p = e['p']
            if (p[:, 0].max() < lo[0]) or (p[:, 0].min() > hi[0]) or (p[:, 1].max() < lo[1]) or (p[:, 1].min() > hi[1]):
                continue
            for a0, a1 in zip(Q[:-1], Q[1:]):
                d = a1 - a0
                for b0, b1 in zip(p[:-1], p[1:]):
                    f = b1 - b0
                    den = d[0] * f[1] - d[1] * f[0]
                    if abs(den) < 1e-9:
                        continue
                    w = b0 - a0
                    t = (w[0] * f[1] - w[1] * f[0]) / den
                    u = (w[0] * d[1] - w[1] * d[0]) / den
                    if 0.02 < t < 0.98 and 0 <= u <= 1:
                        return True
        return False

    stats = {}
    adj = adjacency()
    ends = []
    for n in range(len(nodes)):
        if len(adj[n]) != 1:
            continue
        i = adj[n][0]
        e = edges[i]
        if e['a'] == e['b']:
            continue
        p, us = end_dirs(i, e['a'] == n)
        ends.append({'n': n, 'e': i, 'p': p, 'us': us, 'u': us[1], 'k': e['k'], 'w': e['w'], 'br': bool(e['br'][0 if e['a'] == n else -1])})
    stats['dead_ends_before'] = len(ends)
    # 1. facing dead-end pairs
    cands = []
    for i in range(len(ends)):
        A = ends[i]
        for j in range(i + 1, len(ends)):
            B = ends[j]
            if A['e'] == B['e']:
                continue
            v = B['p'] - A['p']
            L = float(np.hypot(*v))
            if L < 0.5 or L > 160:
                continue
            v = v / L
            ca = max(float(u @ v) for u in A['us'])
            cb = max(float(-(u @ v)) for u in B['us'])
            lim = 0.6 if L < 25 else 0.7 if L < 80 else 0.82
            if ca < lim or cb < lim:
                continue
            if max(A['w'], B['w']) > 2.2 * min(A['w'], B['w']) and L > 25:
                continue
            cands.append((L * (3 - ca - cb), L, ca, cb, i, j))
    cands.sort()
    used = set()
    n_pair, n_pair_km = 0, 0.0
    for _, L, ca, cb, i, j in cands:
        if i in used or j in used:
            continue
        A, B = ends[i], ends[j]
        ua = max(A['us'], key=lambda u: float(u @ (B['p'] - A['p'])))
        ub = max(B['us'], key=lambda u: float(u @ (A['p'] - B['p'])))
        Q = _hermite(A['p'], ua, B['p'], ub)
        g = height_at(Q[:, 0], Q[:, 1])
        if g.max() > max(g[0], g[-1]) + 6.0:
            continue  # high ground in between: a tunnel candidate (Roads.findTunnels), not a surface road
        wq = water_at(Q)
        if (L > 80 or min(ca, cb) < 0.82) and wq.mean() < 0.5 and evidence(Q) < 0.5:
            continue  # weak geometry and nothing on the source map between them: real dead ends
        if L > 30 and crosses_other(Q, {A['e'], B['e']}):
            continue
        used.update((i, j))
        ea, eb = edges[A['e']], edges[B['e']]
        la, lb = float(_arclen(ea['p'])[-1]), float(_arclen(eb['p'])[-1])
        kind = A['k'] if A['k'] == B['k'] else (A['k'] if la >= lb else B['k'])
        edges.append({'a': A['n'], 'b': B['n'], 'k': kind, 'w': round((A['w'] + B['w']) / 2, 1), 'p': Q, 'br': wq, 'gap': 1})
        n_pair += 1
        n_pair_km += L
    stats['gaps_joined'] = n_pair
    stats['gaps_joined_km'] = round(n_pair_km / 1000, 2)
    # 1b. sideways-offset pairs: the two pieces face each other but are shifted sideways (a label, rail line or
    #     power line drawn across the road bent the skeleton). Trim both ends back so the join has room, then
    #     connect them with a smooth S-curve.
    def trim_end(ei, at_a, T):
        e = edges[ei]
        p = e['p'] if at_a else e['p'][::-1]
        br = e['br'] if at_a else e['br'][::-1]
        S = _arclen(p)
        if S[-1] - T < 12:
            return None
        if T < 0.5:
            return e['p'], e['br'], p[0].copy()
        k = min(len(p) - 1, max(1, int(np.searchsorted(S, T, side='right'))))
        q = p[k - 1] + (p[k] - p[k - 1]) * ((T - S[k - 1]) / max(1e-9, S[k] - S[k - 1]))
        np_ = np.vstack([q, p[k:]])
        nb = np.r_[br[k - 1], br[k:]]
        if not at_a:
            np_, nb = np_[::-1], nb[::-1]
        return np_, nb.astype(np.int8), q
    n_off = 0
    offc = []
    for i in range(len(ends)):
        if i in used:
            continue
        A = ends[i]
        for j in range(i + 1, len(ends)):
            if j in used:
                continue
            B = ends[j]
            if A['e'] == B['e'] or float(A['u'] @ B['u']) > -0.8:
                continue
            v = B['p'] - A['p']
            lon = float(v @ A['u'])
            lat = abs(float(v[0] * A['u'][1] - v[1] * A['u'][0]))
            if 4 <= lat <= 25 and -5 <= lon <= 60:
                offc.append((lat + 0.2 * abs(lon), lat, lon, i, j))
    offc.sort()
    for _, lat, lon, i, j in offc:
        if i in used or j in used:
            continue
        A, B = ends[i], ends[j]
        T = min(30.0, max(0.0, (3.2 * lat - lon) / 2))
        ea, eb = edges[A['e']], edges[B['e']]
        ta = trim_end(A['e'], ea['a'] == A['n'], T)
        tb = trim_end(B['e'], eb['a'] == B['n'], T)
        if ta is None or tb is None:
            continue
        pa_, pb_ = ta[2], tb[2]
        # directions at the new ends (unchanged headings)
        Q = _hermite(pa_, A['u'], pb_, B['u'])
        if evidence(np.vstack([A['p'], B['p']]), skip=1.0) < 0.5:
            continue
        if crosses_other(Q, {A['e'], B['e']}):
            continue
        g = height_at(Q[:, 0], Q[:, 1])
        if g.max() > max(g[0], g[-1]) + 6.0:
            continue
        for (E_, (np_, nb, q), nd) in ((ea, ta, A['n']), (eb, tb, B['n'])):
            E_['p'], E_['br'] = np_, nb
            nodes[nd] = [float(q[0]), float(q[1])]
        kind = A['k'] if A['k'] == B['k'] else (A['k'] if _arclen(ea['p'])[-1] >= _arclen(eb['p'])[-1] else B['k'])
        edges.append({'a': A['n'], 'b': B['n'], 'k': kind, 'w': round((A['w'] + B['w']) / 2, 1), 'p': Q, 'br': water_at(Q), 'gap': 3})
        used.update((i, j))
        n_off += 1
    stats['offset_gaps_joined'] = n_off
    # 2. near-miss T junctions: a dead end pointing at another road just ahead
    n_t = n_tn = 0
    for idx, A in enumerate(ends):
        if idx in used:
            continue
        best = None
        for k, e in enumerate(edges):
            if k == A['e'] or e.get('gap'):
                continue
            p = e['p']
            dd = np.hypot(p[:, 0] - A['p'][0], p[:, 1] - A['p'][1])
            if dd.min() > 25 + e['w'] / 2 + 40:
                continue
            for s in range(len(p) - 1):
                d = p[s + 1] - p[s]
                sl = float(np.hypot(*d))
                if sl < 1e-6:
                    continue
                # closest point of the segment to the dead end, and the ray hit (if any)
                t = float(np.clip(((A['p'] - p[s]) @ d) / (sl * sl), 0, 1))
                c = p[s] + d * t
                v = c - A['p']
                dist = float(np.hypot(*v))
                if dist < 0.5 or dist > 25 + e['w'] / 2:
                    continue
                cosd = max(float(u @ v) / dist for u in A['us'])
                if cosd < 0.77:
                    continue  # not where this road points
                if abs(float(A['u'] @ d) / sl) > 0.92:
                    continue  # running alongside, not into it
                if bool(e['br'][s]) and bool(e['br'][s + 1]) and not A['br']:
                    continue  # a bridge deck passing by, not a junction
                score = dist * (2 - cosd)
                if best is None or score < best[0]:
                    best = (score, k, s, t, dist)
        if not best:
            continue
        _, k, s, t, dist = best
        e = edges[k]
        hit = e['p'][s] + (e['p'][s + 1] - e['p'][s]) * t
        Q0 = np.vstack([A['p'], hit])
        if evidence(Q0, skip=min(2.0, dist / 4)) < 0.6:
            continue  # the source map shows no road between them: a genuine dead end / cul-de-sac
        # snap to the target's end node when the hit is close to it, otherwise split the target edge
        nh = None
        for end_n, end_p in ((e['a'], e['p'][0]), (e['b'], e['p'][-1])):
            if np.hypot(*(hit - end_p)) < max(6.0, e['w'] * 0.4):
                nh, hit = end_n, end_p.copy()
        cdir = (hit - A['p']) / (np.hypot(*(hit - A['p'])) + 1e-9)
        if nh is not None:
            # the connector must not run alongside an arm already at that node (acute arms make a junction
            # whose fill smears over both roads)
            adj_n = [k2 for k2, e2 in enumerate(edges) if e2['a'] == nh or e2['b'] == nh]
            bad = False
            for k2 in adj_n:
                q = edges[k2]['p'] if edges[k2]['a'] == nh else edges[k2]['p'][::-1]
                sq = _arclen(q)
                b2 = min(10.0, sq[-1])
                v = np.array([np.interp(b2, sq, q[:, 0]), np.interp(b2, sq, q[:, 1])]) - q[0]
                v = v / (np.hypot(*v) + 1e-9)
                if float(v @ -cdir) > 0.85:
                    bad = True
            if bad:
                continue
        elif abs(float(cdir @ (e['p'][s + 1] - e['p'][s])) / (float(np.hypot(*(e['p'][s + 1] - e['p'][s]))) + 1e-9)) > 0.9:
            continue  # would meet the road at a grazing angle
        if nh is None:
            p, br = e['p'], e['br']
            if np.hypot(*(hit - p[s])) < 2 and s > 0:
                cut = s
                hit = p[s].copy()
                p1, p2, b1, b2 = p[:cut + 1], p[cut:], br[:cut + 1], br[cut:]
            elif np.hypot(*(hit - p[s + 1])) < 2 and s + 1 < len(p) - 1:
                cut = s + 1
                hit = p[s + 1].copy()
                p1, p2, b1, b2 = p[:cut + 1], p[cut:], br[:cut + 1], br[cut:]
            else:
                bh = int(br[s] and br[s + 1])
                p1, p2 = np.vstack([p[:s + 1], hit]), np.vstack([hit, p[s + 1:]])
                b1, b2 = np.r_[br[:s + 1], bh], np.r_[bh, br[s + 1:]]
            if len(p1) < 2 or len(p2) < 2 or _arclen(p1)[-1] < 1 or _arclen(p2)[-1] < 1:
                continue
            nodes.append([float(hit[0]), float(hit[1])])
            nh = len(nodes) - 1
            e2 = dict(e)
            e2['p'], e2['br'], e2['a'] = p2, b2.astype(np.int8), nh
            e['p'], e['br'], e['b'] = p1, b1.astype(np.int8), nh
            edges.append(e2)
        else:
            n_tn += 1
        L = float(np.hypot(*(hit - A['p'])))
        n = max(1, int(math.ceil(L / 4.0)))
        Q = A['p'] + (hit - A['p']) * np.linspace(0, 1, n + 1)[:, None]
        edges.append({'a': A['n'], 'b': nh, 'k': A['k'], 'w': A['w'], 'p': Q, 'br': water_at(Q), 'gap': 2})
        used.add(idx)
        n_t += 1
    stats['t_junctions'] = n_t
    stats['t_junctions_to_nodes'] = n_tn
    # skeleton stubs: a short dead-end spur whose tip lies on another road's asphalt (outlines of shields and
    # labels sitting on a carriageway skeletonise into little loops / tails next to it) is not a road
    n_stub = 0
    for _ in range(2):
        adj = adjacency()
        drop = set()
        for k, e in enumerate(edges):
            if e['a'] == e['b'] or e.get('gap'):
                continue
            for tip, other in ((e['a'], e['b']), (e['b'], e['a'])):
                if len(adj[tip]) != 1 or len(adj[other]) < 3:
                    continue
                if _arclen(e['p'])[-1] > 100:
                    continue
                tp = np.array(nodes[tip])
                # a short spur ending out over the water next to a junction: the outline of a route shield
                if water_at(tp[None, :])[0] or bool(e['br'][0 if tip == e['a'] else -1]) or float(height_at(tp[:1], tp[1:])[0]) < 0.1:
                    drop.add(k)
                    break
                if _arclen(e['p'])[-1] > 80:
                    continue
                for k2, e2 in enumerate(edges):
                    if k2 == k or k2 in drop:
                        continue
                    p2 = e2['p']
                    if np.min(np.hypot(p2[:, 0] - tp[0], p2[:, 1] - tp[1])) > e2['w'] / 2 + 40:
                        continue
                    d = min(float(np.hypot(*(tp - (a0 + (a1 - a0) * np.clip(((tp - a0) @ (a1 - a0)) / max(1e-9, (a1 - a0) @ (a1 - a0)), 0, 1)))))
                            for a0, a1 in zip(p2[:-1], p2[1:]))
                    if d < e2['w'] / 2 + 3:
                        drop.add(k)
                        break
                if k in drop:
                    break
        if not drop:
            break
        edges = [e for k, e in enumerate(edges) if k not in drop]
        n_stub += len(drop)
    stats['stubs_dropped'] = n_stub
    # 3. road class noise: along chains of plain (degree-2) joints, short class runs take their neighbours' class
    adj = adjacency()
    elen = [float(_arclen(e['p'])[-1]) for e in edges]
    seen = set()
    n_cls = 0
    MINRUN = {'highway': 150.0, 'road': 80.0, 'dirt': 60.0}
    for e0 in range(len(edges)):
        if e0 in seen or edges[e0]['a'] == edges[e0]['b']:
            continue
        seq = [e0]
        seen.add(e0)
        for forward in (True, False):
            cur = e0
            node = edges[cur]['b'] if forward else edges[cur]['a']
            while len(adj[node]) == 2:
                nxt = [k for k in adj[node] if k != cur]
                if not nxt or nxt[0] in seen or edges[nxt[0]]['a'] == edges[nxt[0]]['b']:
                    break
                k = nxt[0]
                seen.add(k)
                if forward:
                    seq.append(k)
                else:
                    seq.insert(0, k)
                node = edges[k]['b'] if edges[k]['a'] == node else edges[k]['a']
                cur = k
        if len(seq) < 2:
            continue
        runs = []
        for k in seq:
            if runs and runs[-1][0] == edges[k]['k']:
                runs[-1][1].append(k)
            else:
                runs.append([edges[k]['k'], [k]])
        for ri, (kind, ks) in enumerate(runs):
            L = sum(elen[k] for k in ks)
            prev = runs[ri - 1][0] if ri > 0 else None
            nxt = runs[ri + 1][0] if ri + 1 < len(runs) else None
            new = prev if prev is not None and prev == nxt else (prev or nxt if (prev is None) != (nxt is None) else None)
            if new is None or new == kind:
                continue
            nbr_len = sum(elen[k] for k in (runs[ri - 1][1] if ri > 0 else []) + (runs[ri + 1][1] if ri + 1 < len(runs) else []))
            if L < MINRUN[kind] and nbr_len > 2 * L:
                for k in ks:
                    edges[k]['k'] = new
                n_cls += len(ks)
    # isolated short 'highway' links between two street junctions
    for k, e in enumerate(edges):
        if e['k'] != 'highway' or elen[k] > 100 or e['a'] == e['b']:
            continue
        others = [edges[j]['k'] for n_ in (e['a'], e['b']) for j in adj[n_] if j != k]
        if len(others) >= 2 and all(o == 'road' for o in others):
            e['k'] = 'road'
            n_cls += 1
    stats['class_fixes'] = n_cls
    # 4. drop tiny fragments
    adj = adjacency()
    comp = [-1] * len(nodes)
    ncomp = 0
    for s0 in range(len(nodes)):
        if comp[s0] >= 0 or not adj[s0]:
            continue
        st = [s0]
        comp[s0] = ncomp
        while st:
            x = st.pop()
            for ei in adj[x]:
                for o in (edges[ei]['a'], edges[ei]['b']):
                    if comp[o] < 0:
                        comp[o] = ncomp
                        st.append(o)
        ncomp += 1
    clen = np.zeros(ncomp)
    for e in edges:
        clen[comp[e['a']]] += _arclen(e['p'])[-1]
    keep = [e for e in edges if clen[comp[e['a']]] >= 60]
    stats['fragment_edges_dropped'] = len(edges) - len(keep)
    stats['components'] = len({comp[e['a']] for e in keep})
    # compact nodes
    used_n = sorted({e['a'] for e in keep} | {e['b'] for e in keep})
    remap = {o: i for i, o in enumerate(used_n)}
    out_nodes = [[round(nodes[o][0], 1), round(nodes[o][1], 1)] for o in used_n]
    out_edges = []
    for e in keep:
        q = {'a': remap[e['a']], 'b': remap[e['b']], 'k': e['k'], 'w': e['w'], 'p': [[round(float(x), 1), round(float(z), 1)] for x, z in e['p']]}
        if e['br'].any():
            q['br'] = [int(v) for v in e['br']]
        out_edges.append(q)
    # endpoints must sit exactly on their nodes (connectors / splits used float positions)
    for q in out_edges:
        q['p'][0] = list(out_nodes[q['a']])
        q['p'][-1] = list(out_nodes[q['b']])
    deg = collections.Counter()
    for q in out_edges:
        deg[q['a']] += 1
        deg[q['b']] += 1
    # 5. hooked dead-end tips: the skeleton of a road that just stops often curls in its last few metres (up to
    # 110 deg within 6 m - no carriageway turns like that; the ribbon folds and its sidewalk crosses the lane).
    # Lay the last 6 m straight along the approach (6 - 20 m from the tip), unless the new tip lands on water or
    # on another road.
    allp = [(i, np.array(q['p'], float)) for i, q in enumerate(out_edges)]
    n_hook = 0
    for qi, q in enumerate(out_edges):
        if 'br' in q or q['a'] == q['b']:
            continue
        for at_a in (True, False):
            ni = q['a'] if at_a else q['b']
            if deg[ni] != 1:
                continue
            P = np.array(q['p'], float)
            if not at_a:
                P = P[::-1]
            S = _arclen(P)
            if S[-1] < 30:
                continue
            pt = lambda s: np.array([np.interp(s, S, P[:, 0]), np.interp(s, S, P[:, 1])])
            p6, p20 = pt(6.0), pt(20.0)
            d1, d2 = P[0] - p6, p6 - p20
            l1, l2 = np.hypot(*d1), np.hypot(*d2)
            if l1 < 1 or l2 < 1 or float(d1 @ d2) / (l1 * l2) > math.cos(math.radians(30)):
                continue
            tip = p6 + d2 / l2 * 6.0
            if height_at(np.array([tip[0]]), np.array([tip[1]]))[0] < 0.1:
                continue
            busy = False
            for oi, O in allp:
                if oi == qi or np.hypot(*(O[0] - tip)) > 400:
                    continue
                dd = np.hypot(O[:, 0] - tip[0], O[:, 1] - tip[1]).min()
                if dd < out_edges[oi]['w'] / 2 + 3:
                    busy = True
                    break
            if busy:
                continue
            keep_i = np.nonzero(S >= 6.0)[0]
            newP = np.vstack([tip, p6[None, :], P[keep_i[S[keep_i] > 6.5]] if len(keep_i) else P[-1:]])
            if not at_a:
                newP = newP[::-1]
            q['p'] = [[round(float(x), 1), round(float(z), 1)] for x, z in newP]
            out_nodes[ni] = [round(float(tip[0]), 1), round(float(tip[1]), 1)]
            if at_a:
                q['p'][0] = list(out_nodes[ni])
            else:
                q['p'][-1] = list(out_nodes[ni])
            allp[qi] = (qi, np.array(q['p'], float))
            n_hook += 1
    stats['tip_hooks_straightened'] = n_hook
    stats['dead_ends_mid'] = sum(1 for n_ in range(len(out_nodes)) if deg[n_] == 1)
    # 6. every remaining dead end: continue it (connector) or classify it (dead_end_policy)
    out_nodes, out_edges, ends = dead_end_policy(out_nodes, out_edges, cls, ev, bridge_mask, height_at, stats)
    # compact nodes again (dropped stubs leave orphans)
    used_n = sorted({e['a'] for e in out_edges} | {e['b'] for e in out_edges})
    remap = {o: i for i, o in enumerate(used_n)}
    out_nodes = [out_nodes[o] for o in used_n]
    for e in out_edges:
        e['a'], e['b'] = remap[e['a']], remap[e['b']]
    ends = [dict(t, n=remap[t['n']]) for t in ends if t['n'] in remap]
    deg = collections.Counter()
    for q in out_edges:
        deg[q['a']] += 1
        deg[q['b']] += 1
    stats['dead_ends_after'] = sum(1 for n_ in range(len(out_nodes)) if deg[n_] == 1)
    stats['ends_unclassified'] = stats['dead_ends_after'] - len(ends)
    print('graph repair:', json.dumps(stats))
    return {'nodes': out_nodes, 'edges': out_edges, 'ends': ends}, stats


END_REACH = 150.0  # m: how far a dead end looks for a road to continue into


def dead_end_policy(nodes, edges, cls, ev, bridge_mask, height_at, stats):
    """Every dead end of the graph is either continued or explained. A road that just stops near another road is
    almost always an offroad link the source map does not draw (or draws faintly); a genuine dead end is kept and
    tagged so the renderer can finish it properly. In order:
      tunnel  facing ends with high ground between them (Roads.findTunnels bores them at runtime): kept;
      water   pointing into water within 15 m (piers, boat ramps, quays): kept, `end: 'water'`;
      paved   inside a parking / apron / paved area: kept, blends into it, `end: 'paved'`;
      edge    at the world boundary: kept;
      connect another road within 150 m (any direction, the pointing one preferred, another dead end facing it
              preferred): a smooth Hermite connector to that dead end, or into a T junction (the target edge is
              split). Not across water, buildings or another road, not along a hillside steeper than 15 %, not
              over a hill / through a valley, and not where the graph already links the two within ~2.5x the
              distance. Paved (the stub's class and width, `cn: 1`) where the source shows road paint along the
              way, a narrow dirt track otherwise (`k: 'dirt'`, 4.5 m, unlit, no sidewalks, `off: 1`);
      drop    stubs < 25 m from a junction (or isolated) that are none of the above;
      cds     a genuine street dead end: a turning circle, `end: 'cds', r: radius`;
      track   a dirt track / trail that ends in the open.
    nodes / edges: the repaired graph (edges: a, b, k, w, p [[x, z], ...], br?). Returns (nodes, edges, ends) with
    ends = [{'n': node, 'end': class, 'r': radius?}] for every degree-1 node left."""
    import heapq
    H, W = cls.shape
    lut = lambda names: np.isin(np.arange(256), [C[n] for n in names])
    L_ROAD, L_DIRT = lut(['road', 'highway']), lut(['dirtroad'])
    L_WATER, L_BLD, L_PAVED = lut(['water']), lut(['building', 'building_blue']), lut(['paved', 'apron'])
    L_URBAN = lut(['urban', 'paved', 'apron', 'white', 'dark', 'road', 'highway'])

    def pix(P):
        P = np.asarray(P, float).reshape(-1, 2)
        return np.clip(((P[:, 1] - Z0) / MPP).astype(int), 0, H - 1), np.clip(((P[:, 0] - X0) / MPP).astype(int), 0, W - 1)

    def cls_at(P):
        iy, ix = pix(P)
        return cls[iy, ix], bridge_mask[iy, ix], ev[iy, ix]

    E = [dict(e, p=np.array(e['p'], float).reshape(-1, 2), orig=k) for k, e in enumerate(edges)]
    for e in E:
        e['S'] = _arclen(e['p'])

    def degs():
        d = collections.Counter()
        for e in E:
            d[e['a']] += 1
            d[e['b']] += 1
        return d

    def seg_index():
        rows = []
        for k, e in enumerate(E):
            p = e['p']
            for s in range(len(p) - 1):
                rows.append((p[s, 0], p[s, 1], p[s + 1, 0], p[s + 1, 1], k, s))
        return np.array(rows, float)

    def end_info(k, at_a):
        e = E[k]
        p = e['p'] if at_a else e['p'][::-1]
        S = e['S'] if at_a else e['S'][-1] - e['S'][::-1]
        b = min(20.0, S[-1])
        q = np.array([np.interp(b, S, p[:, 0]), np.interp(b, S, p[:, 1])])
        u = p[0] - q
        return p[0].copy(), u / (np.hypot(*u) + 1e-9)

    def trimmed(k, at_a, T):
        # the edge with its end at the dead end cut back by T metres: (new polyline, new tip) or None
        e = E[k]
        p = e['p'] if at_a else e['p'][::-1]
        S = e['S'] if at_a else e['S'][-1] - e['S'][::-1]
        if S[-1] - T < 12:
            return None
        if T < 0.5:
            return e['p'], p[0].copy()
        i = min(len(p) - 1, max(1, int(np.searchsorted(S, T, side='right'))))
        q = p[i - 1] + (p[i] - p[i - 1]) * ((T - S[i - 1]) / max(1e-9, S[i] - S[i - 1]))
        np_ = np.vstack([q, p[i:]])
        return (np_ if at_a else np_[::-1]), q

    def offset_trim(A, B):
        # two dead ends facing each other but shifted sideways (a label / shield / power line drawn across the
        # road bent both skeleton tips): cut both back so the S-curve between them has room
        if float(A['u'] @ B['u']) > -0.8 or 'br' in E[A['k']] or 'br' in E[B['k']]:
            return 0.0
        v = B['p'] - A['p']
        lon = float(v @ A['u'])
        lat = abs(float(v[0] * A['u'][1] - v[1] * A['u'][0]))
        if lat < 3 or lat > 30 or lon < -5:
            return 0.0
        return min(30.0, max(0.0, (3.2 * lat - lon) / 2))

    deg = degs()
    ends = {}
    for k, e in enumerate(E):
        if e['a'] == e['b']:
            continue
        for at_a in (True, False):
            n = e['a'] if at_a else e['b']
            if deg[n] == 1:
                p, u = end_info(k, at_a)
                ends[n] = {'n': n, 'k': k, 'at_a': at_a, 'p': p, 'u': u, 'kind': e['k'], 'w': float(e['w'])}
    cls_out = {}
    bulb = {}
    hat = lambda P: height_at(P[:, 0], P[:, 1])
    # tunnels (same test as the height solve's portal coupling / Roads.findTunnels)
    el = list(ends.values())
    for i in range(len(el)):
        for j in range(i + 1, len(el)):
            A, B = el[i], el[j]
            if A['k'] == B['k'] or (A['kind'] == 'dirt') != (B['kind'] == 'dirt'):
                continue
            v = B['p'] - A['p']
            L = float(np.hypot(*v))
            if L < 60 or L > 1300:
                continue
            v = v / L
            if float(A['u'] @ v) < 0.88 or float(-(B['u'] @ v)) < 0.88:
                continue
            ks = np.linspace(0, 1, 26)[1:-1, None]
            g = hat(A['p'] + (B['p'] - A['p']) * ks)
            ga, gb = hat(np.vstack([A['p'], B['p']]))
            if g.min() < 0.2 or g.max() - max(ga, gb) < 14:
                continue
            cls_out[A['n']] = cls_out[B['n']] = {'end': 'tunnel'}
    # water / paved / world edge
    for n, D in ends.items():
        if n in cls_out:
            continue
        ahead = D['p'][None, :] + D['u'][None, :] * np.arange(0.0, 21.0, 2.5)[:, None]
        c, bm, e_ = cls_at(ahead)
        if (L_WATER[c] & ~e_).any() or bm[1:].any() or float(hat(D['p'][None, :])[0]) < 0.15:
            cls_out[n] = {'end': 'water'}
            continue
        ang = np.linspace(0, 2 * np.pi, 16, endpoint=False)
        ring = np.concatenate([D['p'][None, :] + r * np.stack([np.cos(ang), np.sin(ang)], 1) for r in (6, 14, 24)])
        c, _, _ = cls_at(ring)
        if L_PAVED[c].mean() >= 0.3 or L_PAVED[cls_at(D['p'][None, :])[0]].any():
            cls_out[n] = {'end': 'paved'}
            continue
        x, z = D['p']
        if min(x - WX0, WX1 - x, z - WZ0, WZ1 - z) < 40:
            cls_out[n] = {'end': 'edge'}
            continue
        # the source draws a turning circle (a dark disc wider than the road) at the tip: a real cul-de-sac
        if D['kind'] == 'road':
            # a ring wider than the carriageway around the tip (or just beyond it) lies on road paint all round,
            # and a ring further out does not (not a wide junction, a dual carriageway or a shield on a highway)
            best_f, best_r = 0.0, 0.0
            for rr in (0.7 * D['w'], 0.9 * D['w']):
                rr = max(4.5, rr)
                for back in (0.0, 0.3 * D['w']):
                    ctr = D['p'] + D['u'] * back
                    c, _, _ = cls_at(ctr[None, :] + rr * np.stack([np.cos(ang), np.sin(ang)], 1))
                    f_ = float(L_ROAD[c].mean())
                    if f_ > best_f:
                        best_f, best_r = f_, rr
            c, _, _ = cls_at(D['p'][None, :] + max(9.0, 1.8 * D['w']) * np.stack([np.cos(ang), np.sin(ang)], 1))
            if best_f >= 0.75 and float(L_ROAD[c].mean()) <= 0.4:
                # (a route shield printed over a road looks the same: a bulb end only takes a painted link to a
                # dead end facing it - the other half of the road behind the shield)
                bulb[n] = round(float(min(14.0, max(9.0, best_r + 2.0))), 1)
    # connect: candidates per dead end on the current graph
    SEG = seg_index()
    adj = collections.defaultdict(list)
    for k, e in enumerate(E):
        adj[e['a']].append((e['b'], e['S'][-1]))
        adj[e['b']].append((e['a'], e['S'][-1]))

    def graph_dist(src, lim):
        dist = {src: 0.0}
        pq = [(0.0, src)]
        while pq:
            d, x = heapq.heappop(pq)
            if d > dist.get(x, 1e18) or d > lim:
                continue
            for y, w in adj[x]:
                nd = d + w
                if nd < dist.get(y, 1e18) and nd <= lim:
                    dist[y] = nd
                    heapq.heappush(pq, (nd, y))
        return dist

    def path_ok(Q, wpath, skip, D):
        """water / buildings / crossings / running alongside / grades along the connector Q"""
        S = _arclen(Q)
        L = S[-1]
        ss = np.arange(1.0, L - 1.0, 1.0) if L > 3 else np.array([L / 2])
        P = np.stack([np.interp(ss, S, Q[:, 0]), np.interp(ss, S, Q[:, 1])], 1)
        T_ = np.stack([np.interp(ss + 0.5, S, Q[:, 0]) - np.interp(ss - 0.5, S, Q[:, 0]), np.interp(ss + 0.5, S, Q[:, 1]) - np.interp(ss - 0.5, S, Q[:, 1])], 1)
        N_ = np.stack([-T_[:, 1], T_[:, 0]], 1) / (np.hypot(T_[:, 0], T_[:, 1])[:, None] + 1e-9)
        for off in (-wpath / 2 - 1.0, 0.0, wpath / 2 + 1.0):
            c, bm, e_ = cls_at(P + N_ * off)
            # (blue interstate shields classify as water: print over a road is not water)
            wet = (L_WATER[c] & ~e_) | bm
            if wet.any() or L_BLD[c].any():
                return 'water' if wet.any() else 'building'
        # turning radius >= 12 m
        if L > 8:
            ss2 = np.arange(0, L, 2.0)
            P2 = np.stack([np.interp(ss2, S, Q[:, 0]), np.interp(ss2, S, Q[:, 1])], 1)
            d2 = np.diff(P2, axis=0)
            a2 = np.arctan2(d2[:, 1], d2[:, 0])
            da = np.abs((np.diff(a2) + np.pi) % (2 * np.pi) - np.pi)
            if len(da) and (2.0 / np.maximum(da, 1e-6)).min() < 10.0:
                return 'radius'
        # grade: end to end <= 15 %, no hill / valley in between, local <= 20 %
        h = hat(P) if len(P) > 1 else hat(Q)
        h0, h1 = hat(Q[[0, -1]])
        if abs(h1 - h0) / max(L, 1.0) > 0.15 or h.max() > max(h0, h1) + 5.0 or h.min() < min(h0, h1) - 5.0:
            return 'grade'
        if len(h) > 16 and (np.abs(h[16:] - h[:-16]) / 16.0).max() > 0.2:
            return 'grade'
        # crossings and roads alongside (the middle of the connector stays clear of every other carriageway)
        lo, hi = Q.min(0) - 20, Q.max(0) + 20
        m = (np.maximum(SEG[:, 0], SEG[:, 2]) >= lo[0]) & (np.minimum(SEG[:, 0], SEG[:, 2]) <= hi[0]) & (np.maximum(SEG[:, 1], SEG[:, 3]) >= lo[1]) & (np.minimum(SEG[:, 1], SEG[:, 3]) <= hi[1])
        sg = SEG[m]
        sg = sg[~np.isin(sg[:, 4], list(skip))]
        if len(sg):
            for a0, a1 in zip(Q[:-1], Q[1:]):
                d = a1 - a0
                f = sg[:, 2:4] - sg[:, 0:2]
                den = d[0] * f[:, 1] - d[1] * f[:, 0]
                w_ = sg[:, 0:2] - a0
                with np.errstate(divide='ignore', invalid='ignore'):
                    t = (w_[:, 0] * f[:, 1] - w_[:, 1] * f[:, 0]) / den
                    uu = (w_[:, 0] * d[1] - w_[:, 1] * d[0]) / den
                if np.any((np.abs(den) > 1e-9) & (t > -0.01) & (t < 1.01) & (uu >= 0) & (uu <= 1)):
                    return 'crossing'
            mid = P[(ss > 0.15 * L) & (ss < 0.85 * L)]
            if len(mid):
                ax, az, bx, bz = sg[:, 0], sg[:, 1], sg[:, 2], sg[:, 3]
                dx, dz = bx - ax, bz - az
                L2 = dx * dx + dz * dz + 1e-9
                ww = np.array([E[int(k)]['w'] for k in sg[:, 4]])
                for q in mid[::2]:
                    t = np.clip(((q[0] - ax) * dx + (q[1] - az) * dz) / L2, 0, 1)
                    dd = np.hypot(q[0] - ax - dx * t, q[1] - az - dz * t)
                    if np.any(dd < ww / 2 + wpath / 2 + 1.5):
                        return 'alongside'
        c, _, e_ = cls_at(P)
        return {'pav': float((L_ROAD[c] | e_).mean()) if len(c) else 1.0, 'dirt': float(L_DIRT[c].mean()) if len(c) else 0.0,
                'urban': float(L_URBAN[c].mean()) if len(c) else 0.0, 'L': float(L)}

    plans = []
    why = collections.defaultdict(list)
    for n, D in ends.items():
        if n in cls_out:
            continue
        x, z = D['p']
        m = (np.minimum(SEG[:, 0], SEG[:, 2]) < x + END_REACH) & (np.maximum(SEG[:, 0], SEG[:, 2]) > x - END_REACH) & \
            (np.minimum(SEG[:, 1], SEG[:, 3]) < z + END_REACH) & (np.maximum(SEG[:, 1], SEG[:, 3]) > z - END_REACH) & (SEG[:, 4] != D['k'])
        sg = SEG[m]
        if not len(sg):
            continue
        ax, az, bx, bz = sg[:, 0], sg[:, 1], sg[:, 2], sg[:, 3]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz + 1e-9
        t = np.clip(((x - ax) * dx + (z - az) * dz) / L2, 0, 1)
        cx, cz = ax + dx * t, az + dz * t
        dd = np.hypot(cx - x, cz - z)
        cands = {}
        for r in np.argsort(dd):
            if dd[r] > END_REACH:
                break
            k = int(sg[r, 4])
            if k in cands:
                continue
            cands[k] = (float(cx[r]), float(cz[r]), int(sg[r, 5]), float(t[r]))
        # ray hits (where the road points) as extra candidates
        den = D['u'][0] * dz - D['u'][1] * dx
        with np.errstate(divide='ignore', invalid='ignore'):
            tr = ((ax - x) * dz - (az - z) * dx) / den
            us = ((ax - x) * D['u'][1] - (az - z) * D['u'][0]) / den
        hitm = (np.abs(den) > 1e-9) & (tr > 1) & (tr < END_REACH) & (us >= 0) & (us <= 1)
        rays = {}
        for r in np.nonzero(hitm)[0]:
            k = int(sg[r, 4])
            if k not in rays or tr[r] < rays[k][4]:
                rays[k] = (float(ax[r] + dx[r] * us[r]), float(az[r] + dz[r] * us[r]), int(sg[r, 5]), float(us[r]), float(tr[r]))
        dist = graph_dist(n, 2.5 * END_REACH + 60)
        opts = []
        for k, c in list(cands.items()) + [(k, r[:4]) for k, r in rays.items()]:
            f = E[k]
            to_hw = f['k'] == 'highway' and D['kind'] != 'highway'
            pc = np.array(c[:2])
            v = pc - D['p']
            L = float(np.hypot(*v))
            if L < 1.0:
                continue
            cosd = float(D['u'] @ v) / L
            if cosd < -0.2:
                continue  # behind the end
            # target: another dead end (its node) when the point is at it, else a point on the edge
            s_pt = f['S'][c[2]] + (f['S'][c[2] + 1] - f['S'][c[2]]) * c[3]
            tgt_end = None
            for nn_, sv in ((f['a'], 0.0), (f['b'], f['S'][-1])):
                if abs(s_pt - sv) < 8.0 and nn_ in ends and nn_ != n:
                    tgt_end = nn_
            gd = min(dist.get(f['a'], 1e18) + s_pt, dist.get(f['b'], 1e18) + f['S'][-1] - s_pt)
            if gd <= 2.5 * L + 40:
                why[n].append(('linked', round(L)))
                continue  # the graph already links them closely
            cost = L * (1 + 1.2 * (1 - cosd)) * (0.6 if tgt_end is not None else 1.0)
            opts.append((cost, k, c, tgt_end, L, cosd, to_hw))
        opts.sort(key=lambda o: o[0])
        for cost, k, c, tgt_end, L, cosd, to_hw in opts[:10]:
            f = E[k]
            wpath = D['w'] if D['kind'] != 'dirt' else max(4.5, min(D['w'], 6.0))
            trim = 0.0
            if tgt_end is not None:
                T_ = ends[tgt_end]
                trim = offset_trim(D, T_)
                ta = trimmed(D['k'], D['at_a'], trim)
                tb = trimmed(T_['k'], T_['at_a'], trim)
                if ta is None or tb is None:
                    trim, ta, tb = 0.0, (None, D['p']), (None, T_['p'])
                shapes = [(T_['u'], _hermite(ta[1], D['u'], tb[1], T_['u'], step=3.0, tension=tn)) for tn in (0.5, 0.8, 1.1)]
            else:
                pc = np.array(c[:2])
                tf = f['p'][c[2] + 1] - f['p'][c[2]]
                tf = tf / (np.hypot(*tf) + 1e-9)
                nf = np.array([-tf[1], tf[0]])
                if float(nf @ (D['p'] - pc)) < 0:
                    nf = -nf
                # arrive square to the road; or straight on (the road just continues); or the direct line
                dv = (D['p'] - pc) / (np.hypot(*(D['p'] - pc)) + 1e-9)
                arr = [nf, -D['u'], dv, (nf + dv) / (np.hypot(*(nf + dv)) + 1e-9)]
                shapes = [(a_, _hermite(D['p'], D['u'], pc, a_, step=3.0, tension=tn)) for a_ in arr if abs(float(a_ @ tf)) < 0.87 for tn in (0.5, 0.8)]
            chk, Q, tn_used = 'grazing', None, 0.5
            for si, (a_, Q_) in enumerate(shapes):
                chk = path_ok(Q_, max(wpath, 4.5), {D['k'], k}, D)
                if not isinstance(chk, str):
                    Q = Q_
                    tn_used = (0.5, 0.8, 1.1)[si % 3] if tgt_end is not None else (0.5, 0.8)[si % 2]
                    break
            if isinstance(chk, str):
                why[n].append((chk, round(L)))
                continue
            paved = chk['pav'] >= 0.6
            if n in bulb and not (paved and tgt_end is not None):
                why[n].append(('bulb', round(L)))
                continue
            if to_hw and not (paved and (tgt_end is not None or L <= 40)):
                why[n].append(('to-highway', round(L)))
                continue  # streets meet a highway only where the source shows them joining (shield gaps)
            if D['kind'] == 'highway' and not paved:
                why[n].append(('highway-no-paint', round(L)))
                continue  # a highway does not continue as a track
            if not paved and L > 40 and cosd < 0.5:
                why[n].append(('offroad-not-ahead', round(L)))
                continue  # an offroad track goes where the road points
            arr_dir = (Q[-1] - Q[-2]) / (np.hypot(*(Q[-1] - Q[-2])) + 1e-9)
            plans.append({'cost': cost, 'n': n, 'k': k, 'c': c, 'tgt_end': tgt_end, 'Q': Q, 'arr': -arr_dir, 'tn': tn_used, 'paved': paved, 'dirt': chk['dirt'] >= 0.5,
                          'urban': chk['urban'] >= 0.5 and D['kind'] != 'dirt', 'L': L, 'trim': trim})
            break
    # apply, cheapest first; each dead end is used once (a connector between two dead ends uses both)
    plans.sort(key=lambda p: p['cost'])
    done = set()
    st = collections.Counter()
    added = []
    for P_ in plans:
        n = P_['n']
        if n in done or (P_['tgt_end'] is not None and P_['tgt_end'] in done):
            continue
        D = ends[n]
        Q = P_['Q']
        # connectors applied earlier may cross this one
        if any(_seg_cross_any(Q, A_) for A_ in added):
            continue
        if P_['tgt_end'] is not None:
            nb = P_['tgt_end']
            B_ = ends[nb]
            if P_['trim'] > 0:
                for X_ in (D, B_):
                    np_, q = trimmed(X_['k'], X_['at_a'], P_['trim'])
                    E[X_['k']]['p'] = np_
                    E[X_['k']]['S'] = _arclen(np_)
                    nodes[X_['n']] = [float(q[0]), float(q[1])]
                    X_['p'] = q
            Q = _hermite(D['p'], D['u'], B_['p'], B_['u'], step=3.0, tension=P_['tn'])
        else:
            # the target edge may have been split by an earlier connector: find the piece holding the point
            pc = np.array(P_['c'][:2])
            best = None
            for k2, e2 in enumerate(E):
                if e2['orig'] != E[P_['k']]['orig']:
                    continue
                p2 = e2['p']
                for s in range(len(p2) - 1):
                    d = p2[s + 1] - p2[s]
                    tt = float(np.clip(((pc - p2[s]) @ d) / max(1e-9, d @ d), 0, 1))
                    q = p2[s] + d * tt
                    dq = float(np.hypot(*(q - pc)))
                    if best is None or dq < best[0]:
                        best = (dq, k2, s, tt, q)
            _, k2, s, tt, q = best
            f = E[k2]
            # snap to the piece's end node when close, else split the piece
            nb = None
            for end_n, end_p in ((f['a'], f['p'][0]), (f['b'], f['p'][-1])):
                if np.hypot(*(q - end_p)) < max(6.0, f['w'] * 0.5):
                    nb, q = end_n, end_p.copy()
            if nb is None:
                p, br = f['p'], np.array(f.get('br', [0] * len(f['p'])), np.int8)
                p1, p2 = np.vstack([p[:s + 1], q]), np.vstack([q, p[s + 1:]])
                bh = int(br[s] and br[s + 1])
                b1, b2 = np.r_[br[:s + 1], bh], np.r_[bh, br[s + 1:]]
                if _arclen(p1)[-1] < 1 or _arclen(p2)[-1] < 1:
                    continue
                nodes.append([float(q[0]), float(q[1])])
                nb = len(nodes) - 1
                e2 = dict(f)
                e2['p'], e2['a'] = p2, nb
                f['p'], f['b'] = p1, nb
                if 'br' in f:
                    f['br'], e2['br'] = b1.tolist(), b2.tolist()
                f['S'], e2['S'] = _arclen(f['p']), _arclen(e2['p'])
                E.append(e2)
            Q = _hermite(D['p'], D['u'], q, P_['arr'], step=3.0, tension=P_['tn'])
        if P_['paved']:
            kind, w, tag = (D['kind'] if D['kind'] != 'dirt' else 'road'), D['w'], 'cn'
        elif P_['urban']:
            # through a built-up block (parking, yard, plaza): a narrow paved lane, not a dirt track
            kind, w, tag = 'road', min(D['w'], 7.0), 'cn'
        elif P_['dirt'] or D['kind'] == 'dirt':
            kind, w, tag = 'dirt', max(4.5, min(D['w'], 6.0)), 'cn'
        else:
            kind, w, tag = 'dirt', 4.5, 'off'
        Q[0] = nodes[n]
        Q[-1] = nodes[nb]
        ne = {'a': n, 'b': nb, 'k': kind, 'w': round(float(w), 1), 'p': Q, tag: 1, 'orig': -1 - len(added)}
        ne['S'] = _arclen(Q)
        E.append(ne)
        added.append(Q)
        done.add(n)
        if P_['tgt_end'] is not None:
            done.add(nb)
            st['to_dead_end'] += 1
        else:
            st['to_t_junction'] += 1
        st['paved' if tag == 'cn' and kind != 'dirt' else 'dirt_source' if tag == 'cn' else 'offroad'] += 1
        st['km'] += P_['L'] / 1000
    # what is left: drop meaningless stubs, classify the rest
    deg = degs()
    drop = set()
    for n, D in ends.items():
        if n in done or n in cls_out or deg[n] != 1:
            continue
        # the chain back to the next junction
        k, at_n, Ltot, chain, cur = D['k'], n, 0.0, [], n
        while True:
            e = E[k]
            chain.append(k)
            Ltot += e['S'][-1]
            other = e['b'] if e['a'] == cur else e['a']
            if deg[other] != 2 or Ltot > 25:
                break
            nxt = [k2 for k2, e2 in enumerate(E) if k2 != k and (e2['a'] == other or e2['b'] == other)]
            if not nxt:
                break
            k, cur = nxt[0], other
        if Ltot < 25 and deg[other] != 2:
            drop.update(chain)
            cls_out[n] = {'end': 'dropped'}
    if drop:
        E = [e for k, e in enumerate(E) if k not in drop]
    deg = degs()
    out_ends = []
    cnt = collections.Counter()
    for n in range(len(nodes)):
        if deg[n] != 1:
            continue
        if n in cls_out and cls_out[n]['end'] != 'dropped':
            info = dict(cls_out[n])
        else:
            D = ends.get(n)
            kind = D['kind'] if D else next(e['k'] for e in E if e['a'] == n or e['b'] == n)
            wd = D['w'] if D else 8.0
            if kind == 'dirt':
                info = {'end': 'track'}
            elif n in bulb:
                info = {'end': 'cds', 'r': bulb[n], 'bulb': 1}
            else:
                info = {'end': 'cds', 'r': round(float(min(12.0, max(9.0, wd / 2 + 5.0))) if kind != 'highway' else float(wd / 2 + 4.0), 1)}
        info['n'] = n
        out_ends.append(info)
        cnt[info['end']] += 1
    for k in ('to_dead_end', 'to_t_junction', 'paved', 'dirt_source', 'offroad'):
        stats['connect_' + k] = st[k]
    stats['connect_km'] = round(st['km'], 2)
    stats['ends_dropped'] = len([1 for v in cls_out.values() if v['end'] == 'dropped'])
    stats['ends'] = dict(cnt)
    if os.environ.get('DEBUG_ENDS'):  # DEBUG_ENDS=out.json: every kept dead end with why it was not connected
        json.dump([{'n': t['n'], 'end': t['end'], 'x': round(nodes[t['n']][0]), 'z': round(nodes[t['n']][1]), 'why': why.get(t['n'], [])[:6]} for t in out_ends], open(os.environ['DEBUG_ENDS'], 'w'))
    out_edges = []
    for e in E:
        q = {k: v for k, v in e.items() if k not in ('S', 'orig', 'p')}
        q['p'] = [[round(float(x), 1), round(float(z), 1)] for x, z in e['p']]
        out_edges.append(q)
    return nodes, out_edges, out_ends


def _seg_cross_any(Q, R_):
    """does polyline Q cross polyline R_ (interior crossings)?"""
    for a0, a1 in zip(Q[:-1], Q[1:]):
        d = a1 - a0
        f = R_[1:] - R_[:-1]
        den = d[0] * f[:, 1] - d[1] * f[:, 0]
        w_ = R_[:-1] - a0
        with np.errstate(divide='ignore', invalid='ignore'):
            t = (w_[:, 0] * f[:, 1] - w_[:, 1] * f[:, 0]) / den
            u = (w_[:, 0] * d[1] - w_[:, 1] * d[0]) / den
        if np.any((np.abs(den) > 1e-9) & (t > 0.01) & (t < 0.99) & (u > 0.01) & (u < 0.99)):
            return True
    return False


def road_attributes(roads, height_at):
    """Generalised carriageway widths, kinds and roles - exactly the map's (tools/map_build.py): airside, kind
    smoothing along strokes, mainline / ramp roles, class widths (mainline 13-18 m, ramps 7-9.5 m, arterials
    11-15 m, streets 6-11 m, tracks 4-9 m), clearance-limited twins and route-promoted mainlines.

    The raster distance transform saturates wherever carriageways and ramps touch (w up to the 44 m cap), which
    made interchanges one grey slab. roads.json keeps the raw raster width as `w0`; `w` becomes the generalised
    width the game draws, `rp` = 1 marks highway ramps / connectors, `cl` the map's road class index."""
    import map_build as MB
    hat = lambda x, z: float(height_at(np.array([x]), np.array([z]))[0])
    for e in roads['edges']:
        e['k0'] = e['k']
    ROAD_PATH = MB.ROAD_CLASSES.index('path')
    net = MB.RoadNet(roads, hat)
    assert len(net.E) == len(roads['edges']), 'map_build.RoadNet dropped edges'
    MB.detect_airside(net)
    MB.smooth_kinds(net)
    MB.classify(net)
    MB.assign_routes(net)
    changed = 0
    for e, ne in zip(roads['edges'], net.E):
        e['w0'] = e['w']
        w = round(float(ne['mw']), 1)
        changed += abs(w - e['w']) > 0.5
        e['w'] = w
        e['k'] = ne['k']
        e['rp'] = int(bool(ne['ramp']))
        e['cl'] = int(ne['cls'])
        if ne.get('air'):
            e['_air'] = ne['air']
        if e.get('off') or (e.get('cn') and e.get('k0') == 'dirt'):
            if ROAD_PATH == int(ne['cls']):
                # generated tracks stay narrow unlit dirt tracks (map 'path' class)
                e['k'], e['w'], e['rp'] = 'dirt', e['w0'], 0
            else:
                # the map's stroke smoothing reads it as a short gap in a street: paved, as the map draws it
                e.pop('off', None)
                e['cn'] = 1
    # airside dead ends (runway / taxiway tips) blend into their apron
    air_n = set()
    for e in roads['edges']:
        if e.pop('_air', None):
            air_n.update((e['a'], e['b']))
        e.pop('k0', None)
    for t in roads.get('ends', []):
        if t['n'] in air_n and t['end'] in ('cds', 'track'):
            t.pop('r', None)
            t['end'] = 'paved'
    print('road attributes (map_build): %d of %d edge widths generalised' % (changed, len(roads['edges'])))
    return roads


def main():
    t0 = time.time()
    cls = np.load(os.path.join(CLS, 'cls.npy'))
    elev = np.load(os.path.join(CLS, 'elev.npy'))
    depth = np.load(os.path.join(CLS, 'depth.npy')).astype(np.float32)
    road_mask = np.load(os.path.join(CLS, 'road_mask.npy'))
    bridge_mask = np.load(os.path.join(CLS, 'bridge_mask.npy'))
    roads = json.load(open(os.path.join(CLS, 'roads.json')))
    blds = json.load(open(os.path.join(CLS, 'buildings.json')))
    print('loaded', time.time() - t0)

    # ---------------- heightmap (8 m) ----------------
    water2 = (cls == C['water']) | (bridge_mask & ~(cls == C['land']) & ~(cls == C['beach']) & ~(cls == C['urban']))
    wfrac, win = block_mean(water2.astype(np.float32), HS)
    inside = np.zeros_like(wfrac, bool)
    k = int(HS / MPP)
    inside[win[0] // k:(win[1] + k - 1) // k, win[2] // k:(win[3] + k - 1) // k] = True
    wfrac[~inside] = 1.0
    dsum, _ = block_mean(np.where(cls == C['water'], depth, 0), HS)
    water = wfrac >= 0.42
    dep = np.where(water, dsum / np.maximum(wfrac, 1e-3), 0)
    dep[~inside] = 30
    # band (nearest land pixel band); non-land classes inherit nearest band
    # robust band per 8 m cell: median of land pixels in a 12x12 px (24 m) window, then 3x3 median
    ef = np.where(elev == 255, np.nan, elev.astype(np.float32))
    k6 = int(HS / MPP)
    pad_e, _ = None, None
    n_x, n_z = GW, GH
    ox, oz = int((WX0 - X0) / MPP), int((WZ0 - Z0) / MPP)
    big = np.full((n_z * k6 + 8, n_x * k6 + 8), np.nan, np.float32)
    Hh, Ww = ef.shape
    sx0, sz0 = max(0, ox - 4), max(0, oz - 4)
    sx1, sz1 = min(Ww, ox + n_x * k6 + 4), min(Hh, oz + n_z * k6 + 4)
    big[sz0 - (oz - 4):sz1 - (oz - 4), sx0 - (ox - 4):sx1 - (ox - 4)] = ef[sz0:sz1, sx0:sx1]
    import warnings
    warnings.simplefilter('ignore')
    acc = []
    for dz in (0, 4, 8):
        for dx in (0, 4, 8):
            blk = big[dz:dz + n_z * k6, dx:dx + n_x * k6].reshape(n_z, k6, n_x, k6)
            acc.append(blk.transpose(0, 2, 1, 3).reshape(n_z, n_x, k6 * k6))
    med = np.nanmedian(np.concatenate(acc, axis=2), axis=2)
    el = np.where(np.isnan(med), 255, np.round(med)).astype(np.int16)
    el = np.where(el == 255, 255, ndi.median_filter(np.where(el == 255, 0, el), size=3)).astype(np.int16)
    del big, acc, ef
    # clean land-only bands: drop small regions, then require nesting (band k touches band k-1)
    el = el.astype(np.int16)
    el[water] = 255
    for k2 in range(11, 0, -1):
        m = el == k2
        lab2, nl = ndi.label(m)
        if nl:
            sizes = ndi.sum(m, lab2, np.arange(1, nl + 1))
            el[np.isin(lab2, np.nonzero(sizes < 150)[0] + 1)] = 255
    known = (el != 255) & ~water
    dist_k, idx = ndi.distance_transform_edt(~known, return_distances=True, return_indices=True)
    band = el[idx[0], idx[1]]
    band[(dist_k > 5) | (band == 255)] = 0
    band[water] = -1
    for k2 in range(1, 12):
        m = band == k2
        lab2, nl = ndi.label(m)
        if not nl:
            continue
        lower = ndi.binary_dilation(band == k2 - 1, iterations=1)
        touch = np.asarray(ndi.maximum(lower.astype(np.float32), lab2, np.arange(1, nl + 1))) > 0
        bad = np.isin(lab2, np.nonzero(~touch)[0] + 1)
        band[bad] = max(0, k2 - 2) if k2 >= 2 else 0
    band = np.maximum(band, 0).astype(np.int16)
    lo = np.array(BAND_LO, np.float32)[band]
    hi = np.array(BAND_HI, np.float32)[band]
    # coastal plains stay low far from the first contour (Florida is flat)
    d_up = ndi.distance_transform_edt(band < 1) * HS
    hi = np.where(band == 0, 3.5 + np.clip((900.0 - d_up) / 900.0, 0, 1) * 13.5, hi)
    # inland lakes up in the hills would become pits down to sea level: turn them into wet meadows
    wl, nwl = ndi.label(water)
    border = set(np.unique(np.concatenate([wl[0], wl[-1], wl[:, 0], wl[:, -1]]))) - {0}
    ring_lab = np.where(water, 0, ndi.grey_dilation(wl, size=5))
    ring_band = ndi.maximum((band + 1).astype(np.float32), ring_lab, np.arange(1, nwl + 1))
    sizes = ndi.sum(water, wl, np.arange(1, nwl + 1))
    filled = np.zeros_like(water)
    for li in range(1, nwl + 1):
        if li in border:
            continue
        if sizes[li - 1] > 2500:
            continue  # real lakes (Lake Leonida) stay
        if ring_band[li - 1] >= 2:
            filled |= wl == li
    water = water & ~filled
    print('inland lakes filled', int(filled.sum()), 'cells')
    # shoreline: water depth near coast shallower for smooth beaches
    dist_land = ndi.distance_transform_edt(water) * HS
    dep = np.minimum(dep, 0.4 + dist_land * 0.06 + 0.002 * dist_land ** 2)
    seabed = -np.maximum(dep, 0.4)
    bandw = np.where(water, -1, np.where(filled, -2, band))  # -2: filled basin, interpolated freely
    lo = np.where(filled, 0.6, lo)
    hi = np.where(filled, 460.0, hi)
    # contour cells: land cells with a different-band land neighbour -> fixed at boundary elevation
    fixed = water.copy()
    fval = np.where(water, seabed, 0).astype(np.float32)
    lo_arr = np.array(BAND_LO, np.float32)
    for dz, dx in ((0, 1), (1, 0), (0, -1), (-1, 0)):
        nb = np.roll(np.roll(bandw, dz, 0), dx, 1)
        m = (bandw >= 0) & (nb >= 0) & (nb != bandw)
        v = lo_arr[np.maximum(bandw, nb).clip(0)]
        upd = m & ~fixed
        fval[upd] = v[upd]
        fixed |= m
        coast = (bandw >= 0) & (nb == -1) & ~fixed
        fval[coast] = 0.6
        fixed |= coast
    # domes: analytic bulge per band region (0 at contours, amp at the region core) added after the Laplace solve
    dome = np.zeros_like(lo)
    distb = ndi.distance_transform_edt(~fixed)
    for k2 in range(len(BAND_LO)):
        m = (bandw == k2) & ~fixed
        if not m.any():
            continue
        lab2, nl = ndi.label(m)
        if nl == 0:
            continue
        R = np.asarray(ndi.maximum(distb, lab2, np.arange(1, nl + 1)), np.float32)
        higher = ndi.binary_dilation(bandw > k2, iterations=2)
        has_up = np.asarray(ndi.maximum(higher.astype(np.float32), lab2, np.arange(1, nl + 1)), np.float32) > 0
        amp_top = 1.6 if k2 == 0 else (BAND_HI[k2] - BAND_LO[k2]) * 0.55
        amp = np.where(has_up, (1.2 if k2 == 0 else (BAND_HI[k2] - BAND_LO[k2]) * 0.12), amp_top)
        # small regions get proportionally smaller bumps (~1 m per 6 cells of radius)
        amp = np.minimum(amp, R / 6.0)
        t = np.clip(distb[m] / np.maximum(R[lab2[m] - 1], 1.0), 0, 1)
        dome[m] = amp[lab2[m] - 1] * (t * t * (3 - 2 * t))
    src = np.zeros_like(lo)
    print('dome setup', time.time() - t0)

    def jacobi(h, fixed_, fval_, src_, lo_, hi_, iters, scale2):
        for it in range(iters):
            p_ = np.pad(h, 1, mode='edge')
            hn = (p_[:-2, 1:-1] + p_[2:, 1:-1] + p_[1:-1, :-2] + p_[1:-1, 2:] + src_ * scale2) * 0.25
            h = np.where(fixed_, fval_, np.clip(hn, lo_, hi_))
        return h

    def down(arr, f, how):
        n0, n1 = arr.shape[0] // f * f, arr.shape[1] // f * f
        v = arr[:n0, :n1].reshape(n0 // f, f, n1 // f, f)
        return getattr(v, how)(axis=(1, 3))

    hlvl = None
    for f, iters in ((16, 900), (8, 500), (4, 300), (2, 200), (1, 160)):
        if f > 1:
            fx = down(fixed.astype(np.float32), f, 'mean') > 0.5
            fv = down(np.where(fixed, fval, 0), f, 'sum') / np.maximum(down(fixed.astype(np.float32), f, 'sum'), 1)
            lo_f = down(lo, f, 'min')
            hi_f = down(hi, f, 'max')
            src_f = down(src, f, 'mean')
        else:
            fx, fv, lo_f, hi_f, src_f = fixed, fval, lo, hi, src
        lo_f = np.where(down(water.astype(np.float32), f, 'mean') > 0.5, -60, lo_f) if f > 1 else np.where(water, -60, lo_f)
        if hlvl is None:
            hlvl = np.where(fx, fv, (lo_f + hi_f) / 2)
        else:
            hz = ndi.zoom(hlvl, 2, order=1)
            hlvl = np.zeros(fx.shape, np.float32)
            hlvl[:min(hz.shape[0], fx.shape[0]), :min(hz.shape[1], fx.shape[1])] = hz[:fx.shape[0], :fx.shape[1]]
            if hz.shape[0] < fx.shape[0]:
                hlvl[hz.shape[0]:] = hlvl[hz.shape[0] - 1]
            if hz.shape[1] < fx.shape[1]:
                hlvl[:, hz.shape[1]:] = hlvl[:, hz.shape[1] - 1:hz.shape[1]]
        hlvl = jacobi(hlvl, fx, fv, src_f, lo_f, hi_f, iters, float(f * f))
        print('  level', f, hlvl.shape, time.time() - t0)
    h = np.where(water, hlvl, np.clip(hlvl + dome, lo, hi))
    # soften contour creases on land
    hs_ = ndi.gaussian_filter(h, 2.2)
    h = np.where(water, h, np.maximum(hs_, 0.4))
    # slope limiting: gentle coasts (<= 20 %) and no cliffs anywhere (<= 55 %)
    dw = ndi.distance_transform_edt(~water) * HS
    h = np.where(water | (dw > 150), h, np.minimum(h, 0.6 + 0.25 * dw))
    rise = 0.55 * HS
    for _ in range(40):
        lim = ndi.minimum_filter(h, footprint=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], bool)) + rise
        h = np.where(water, h, np.minimum(h, lim))
    h = np.where(water, h, ndi.gaussian_filter(h, 1.0) * 0.5 + h * 0.5)
    print('height solve', time.time() - t0, 'range', h.min(), h.max())

    # No flattening under the road raster any more: it pulled the ground towards a 32 m blur of itself, which
    # raised road-mask strips in valleys / cut them into ridges by metres - grey embankment slabs wherever the
    # raster had no road ribbon on top. Road profiles are smoothed along the graph instead (pass 2 below) and the
    # ground is conformed only around real ribbons (terrain conform).
    # smooth urban
    urban8 = mosaic_window(np.isin(cls, [C['urban'], C['building'], C['building_blue'], C['paved'], C['apron']]).astype(np.uint8), 0, HS).astype(bool)
    h = np.where(urban8 & ~water, ndi.gaussian_filter(h, 1.0) * 0.5 + h * 0.5, h)
    h = np.where(water, np.minimum(h, -0.35), np.maximum(h, 0.35))
    # vertex grid (GH+1, GW+1): average neighbouring cells
    hv = np.pad(h, 1, mode='edge')
    hv = (hv[:-1, :-1] + hv[1:, :-1] + hv[:-1, 1:] + hv[1:, 1:]) / 4
    # keep land vertices that touch land above water
    hv_road = hv.copy()  # natural ground (float metres): source of the road profiles
    hv_land = hv.copy()  # float metres; conformed to the final road profiles after the road pass

    def height_at(x, z):
        fx = (x - WX0) / HS
        fz = (z - WZ0) / HS
        ix = np.clip(np.floor(fx).astype(int), 0, GW - 1)
        iz = np.clip(np.floor(fz).astype(int), 0, GH - 1)
        tx = np.clip(fx - ix, 0, 1)
        tz = np.clip(fz - iz, 0, 1)
        a = hv_road[iz, ix]
        b = hv_road[iz, ix + 1]
        c = hv_road[iz + 1, ix]
        d = hv_road[iz + 1, ix + 1]
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz

    # ---------------- road graph repair (gaps behind shields / labels / rail lines, tiny fragments) -------------
    roads, repair_stats = repair_graph(roads, cls, bridge_mask, height_at)
    if os.environ.get('STOP_AFTER_REPAIR'):  # graph-repair experiments: skip the rest of the export
        return
    roads = road_attributes(roads, height_at)

    # ---------------- ground class texture (4 m) ----------------
    gcls = CLS2G[mosaic_window(cls, C['water'], TS)]
    if filled.any():
        f4 = np.repeat(np.repeat(filled, 2, axis=0), 2, axis=1)[:TH, :TW]
        gcls[f4 & (gcls == G['water'])] = G['wetland']
    # ---- remove map-label imprints: grey glyph strokes (region / place names printed on the source map) that
    #      became urban / paved / road texels in the middle of natural land. Anything not backed by a real road
    #      or building footprint, small and surrounded by nature, is filled with the nearest natural class.
    sup = Image.new('L', (TW, TH), 0)
    dr = ImageDraw.Draw(sup)
    to4 = lambda x, z: ((x - WX0) / TS, (z - WZ0) / TS)
    for e in roads['edges']:
        pts = [to4(x, z) for x, z in np.array(e['p']).reshape(-1, 2)]
        if len(pts) > 1:
            dr.line(pts, fill=255, width=max(2, int(e['w'] / TS + 4)))
    for o in blds:
        pts = [to4(x, z) for x, z in np.array(o['p']).reshape(-1, 2)]
        if len(pts) > 2:
            dr.polygon(pts, fill=255)
    sup = ndi.binary_dilation(np.array(sup) > 0, iterations=2)
    natural = np.isin(gcls, [G['grass'], G['park'], G['wetland'], G['farm'], G['sand'], G['dirt']])
    # glyph strokes touching a real road are cut off from it, so they're judged on their own
    art = np.isin(gcls, [G['urban'], G['paved'], G['building'], G['road']]) & ~sup
    lab, nlab = ndi.label(art, structure=np.ones((3, 3), bool))
    if nlab:
        idx = np.arange(1, nlab + 1)
        area = ndi.sum(np.ones_like(lab), lab, idx)
        backed = ndi.sum(sup, lab, idx)
        ring = ndi.binary_dilation(art, iterations=2) & ~art
        # natural share of each component's surroundings (ring texels take the nearest component's label)
        _, (ri, rj) = ndi.distance_transform_edt(lab == 0, return_indices=True)
        ring_lab = np.where(ring, lab[ri, rj], 0)
        ring_n = ndi.sum(ring, ring_lab, idx)
        ring_nat = ndi.sum(ring & natural, ring_lab, idx)
        nat_share = ring_nat / np.maximum(ring_n, 1)
        # backed share is measured on the dilated support around the component (art excludes sup itself)
        near_sup = ndi.binary_dilation(sup, iterations=3) & ~sup
        backed = ndi.sum(near_sup, lab, idx)
        kill = (area < 15000) & (backed / np.maximum(area, 1) < 0.12) & (nat_share > 0.55)
        kill_mask = kill[np.maximum(lab - 1, 0)] & (lab > 0)
        _, (ni_, nj_) = ndi.distance_transform_edt(~natural, return_indices=True)
        if os.environ.get('LABEL_DEBUG'):
            dx, dz = [float(v) for v in os.environ['LABEL_DEBUG'].split(',')]
            ii, jj = int((dz - WZ0) / TS), int((dx - WX0) / TS)
            win = lab[ii - 30:ii + 30, jj - 30:jj + 30]
            for c in sorted(set(win[win > 0].ravel().tolist()))[:12]:
                k = c - 1
                print('comp', c, 'area', int(area[k]), 'backed', round(float(backed[k] / max(area[k], 1)), 3), 'nat', round(float(nat_share[k]), 3), 'kill', bool(kill[k]))
        gcls = np.where(kill_mask, gcls[ni_, nj_], gcls)
        print('label imprints removed: %d components, %d texels' % (int(kill.sum()), int(kill_mask.sum())))
    # ---- road-bed texels without a road ribbon on top (pruned skeleton spurs, label gaps, merged lanes) read as
    #      dark asphalt slabs with no markings. Small ones take the surrounding class; large ones (airfield
    #      tarmac, plazas) become paved lots.
    rib = Image.new('L', (TW, TH), 0)
    dr = ImageDraw.Draw(rib)
    for e in roads['edges']:
        pts = [to4(x, z) for x, z in np.array(e['p']).reshape(-1, 2)]
        if len(pts) > 1:
            dr.line(pts, fill=255, width=max(2, int(math.ceil(e['w'] / TS)) + 2), joint='curve')
    rib = np.array(rib) > 0
    rib_occ = Image.new('L', (TW, TH), 0)  # just the asphalt, for vegetation (no trees on repaired gaps)
    dr = ImageDraw.Draw(rib_occ)
    for e in roads['edges']:
        pts = [to4(x, z) for x, z in np.array(e['p']).reshape(-1, 2)]
        if len(pts) > 1:
            dr.line(pts, fill=255, width=max(1, int(round(e['w'] / TS))), joint='curve')
    rib_occ = np.array(rib_occ) > 0
    bare = (gcls == G['road']) & ~rib
    lab, nlab = ndi.label(bare, structure=np.ones((3, 3), bool))
    if nlab:
        area = ndi.sum(bare, lab, np.arange(1, nlab + 1)) * TS * TS
        # only compact areas (aprons, plazas: >= 24 m across somewhere) become paved lots; long thin strips (a lost
        # second carriageway, a pruned ramp) would read as grey slabs without markings - they take the surroundings
        half = ndi.distance_transform_edt(bare) * TS
        thick = np.asarray(ndi.maximum(half, lab, np.arange(1, nlab + 1))) >= 12
        big = ((area >= 3000) & thick)[np.maximum(lab - 1, 0)] & (lab > 0)
        _, (ni_, nj_) = ndi.distance_transform_edt(gcls == G['road'], return_indices=True)
        gcls = np.where(bare & big, G['paved'], np.where(bare, gcls[ni_, nj_], gcls))
        print('bare road-bed texels: %d -> paved %d, surroundings %d' % (int(bare.sum()), int((bare & big).sum()), int((bare & ~big).sum())))
    # thin grey strips in open country (the light second carriageway / separator of a merged highway, map
    # outlines) without a ribbon on them: grey slabs without markings - they take the surrounding natural class
    natural = np.isin(gcls, [G['grass'], G['park'], G['wetland'], G['farm'], G['sand'], G['dirt']])
    strip = np.isin(gcls, [G['paved'], G['urban']]) & ~rib
    lab, nlab = ndi.label(strip, structure=np.ones((3, 3), bool))
    if nlab:
        idx = np.arange(1, nlab + 1)
        half = ndi.distance_transform_edt(strip) * TS
        thin = np.asarray(ndi.maximum(half, lab, idx)) < 8
        ring = ndi.binary_dilation(strip, iterations=2) & ~strip
        _, (ri, rj) = ndi.distance_transform_edt(lab == 0, return_indices=True)
        ring_lab = np.where(ring, lab[ri, rj], 0)
        nat = ndi.sum(ring & natural, ring_lab, idx) / np.maximum(ndi.sum(ring, ring_lab, idx), 1)
        kill = (thin & (nat > 0.6))[np.maximum(lab - 1, 0)] & (lab > 0)
        _, (ni_, nj_) = ndi.distance_transform_edt(~natural, return_indices=True)
        gcls = np.where(kill, gcls[ni_, nj_], gcls)
        print('thin grey strips in open country removed: %d texels' % int(kill.sum()))
    # under water but very shallow -> keep water class (shader decides colour by height)
    wgz(os.path.join(OUT, 'ground.bin'), gcls)
    print('ground', time.time() - t0)

    # ---------------- roads ----------------
    # pass 1: resample, ground profile, bridge flags
    import heapq
    E = []
    for e in roads['edges']:
        p = np.array(e['p'], np.float64)
        br = np.array(e.get('br', [0] * len(p)), bool)
        np_, nb = [p[0]], [br[0]]
        for i in range(len(p) - 1):
            seg = p[i + 1] - p[i]
            L = math.hypot(*seg)
            step = 6.0 if (br[i] or br[i + 1]) else 8.0
            n = max(1, int(math.ceil(L / step)))
            for k in range(1, n + 1):
                np_.append(p[i] + seg * (k / n))
                nb.append(bool(br[i + 1]) if k == n else bool(br[i] and br[i + 1]))
        E.append({'src': e, 'P': np.array(np_), 'B': np.array(nb, bool)})
    # pass 1b: smooth centrelines along chains of edges joined at plain (degree-2) nodes. Taubin low-pass
    # (shrink-free) removes skeleton zigzags and junction-approach kinks; lateral drift is capped by width.
    # Widths taper over +-30 m where neighbouring edges of a chain differ.
    deg = {}
    for ed in E:
        a, b = ed['src']['a'], ed['src']['b']
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    by_node = {}
    for ei, ed in enumerate(E):
        by_node.setdefault(ed['src']['a'], []).append(ei)
        by_node.setdefault(ed['src']['b'], []).append(ei)
    seen = set()
    chains = []
    for ei in range(len(E)):
        if ei in seen:
            continue
        seen.add(ei)
        # walk backwards to the chain start, then forwards
        seq = [(ei, True)]
        for forward in (False, True):
            cur, fwd = ei, True
            node = E[cur]['src']['b'] if forward else E[cur]['src']['a']
            while deg.get(node, 0) == 2:
                nxt = [k for k in by_node[node] if k != cur]
                if not nxt or nxt[0] in seen or E[nxt[0]]['src']['a'] == E[nxt[0]]['src']['b']:
                    break
                k = nxt[0]
                seen.add(k)
                kf = E[k]['src']['a'] == node  # traversed a->b when moving away from node
                if forward:
                    seq.append((k, kf))
                else:
                    seq.insert(0, (k, not kf))
                node = E[k]['src']['b'] if kf else E[k]['src']['a']
                cur = k
        chains.append(seq)
    for seq in chains:
        parts, widths, owners = [], [], []
        for k, fwd in seq:
            P = E[k]['P'] if fwd else E[k]['P'][::-1]
            parts.append(P if not parts else P[1:])
            owners.append(len(P) if not owners else len(P) - 1)
            widths.append(E[k]['src']['w'])
        Q0 = np.concatenate(parts)
        n = len(Q0)
        if n >= 5:
            Q = Q0.copy()
            wpt = np.concatenate([np.full(c, w) for c, w in zip(owners, widths)])
            lim = np.maximum(1.2, wpt * 0.3)
            for _ in range(24):
                for lam in (0.5, -0.53):
                    lap = (Q[:-2] + Q[2:]) / 2 - Q[1:-1]
                    Q[1:-1] += lam * lap
                d = Q - Q0
                dn = np.hypot(d[:, 0], d[:, 1])
                over = dn > lim
                Q[over] = Q0[over] + d[over] / dn[over, None] * lim[over, None]
        else:
            Q = Q0
        # tapered widths along the chain
        S = np.r_[0, np.cumsum(np.hypot(*np.diff(Q, axis=0).T))]
        wq = np.concatenate([np.full(c, w) for c, w in zip(owners, widths)]).astype(np.float64)
        bounds = np.cumsum(owners)[:-1] - 1  # joint point indices
        for j, bi in enumerate(bounds):
            w1, w2 = widths[j], widths[j + 1]
            if abs(w1 - w2) < 0.5:
                continue
            sj = S[bi]
            m = np.abs(S - sj) < 30
            t = np.clip((S[m] - (sj - 30)) / 60, 0, 1)
            t = t * t * (3 - 2 * t)
            wq[m] = w1 + (w2 - w1) * t
        # split back
        o = 0
        for (k, fwd), c in zip(seq, owners):
            if o == 0:
                seg, wseg = Q[0:c], wq[0:c]
                o = c
            else:
                seg, wseg = Q[o - 1:o - 1 + c + 1], wq[o - 1:o - 1 + c + 1]
                o += c
            if not fwd:
                seg, wseg = seg[::-1], wseg[::-1]
            E[k]['P'] = np.array(seg)
            E[k]['W'] = np.array(wseg)
    # chain smoothing moves plain (degree-2) joints sideways: keep the node table on the smoothed centreline
    for ed in E:
        roads['nodes'][ed['src']['a']] = [round(float(ed['P'][0, 0]), 2), round(float(ed['P'][0, 1]), 2)]
        roads['nodes'][ed['src']['b']] = [round(float(ed['P'][-1, 0]), 2), round(float(ed['P'][-1, 1]), 2)]
    for ed in E:
        P = ed['P']
        g = height_at(P[:, 0], P[:, 1])
        # any stretch over water is a bridge (the source bridge mask has gaps); short land gaps inside a
        # bridge (< 40 m) are bridged too, so decks never dip into the sea mid-span
        B = ed['B'] | (g < 0.1)
        if B.any() and not B.all():
            S0 = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
            i = 0
            while i < len(B):
                if not B[i]:
                    j = i
                    while j < len(B) and not B[j]:
                        j += 1
                    if i > 0 and j < len(B) and S0[j] - S0[i - 1] < 40:
                        B[i:j] = True
                    i = j
                else:
                    i += 1
        ed['B'] = B
        ed['g'] = g
        ed['S'] = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    nodes = roads['nodes']
    from interchanges import plan_interchanges, crossing_pairs, grade_limit, CLEARANCE
    crossings, crossing_rejects = plan_interchanges(nodes, E)
    NN = len(nodes)
    INF = 1e18

    # pass 2: road height profiles as one smooth field over the whole graph (sparse least squares).
    # Every resampled point is a variable; edge end points share their node's variable, so there are no steps
    # at joints and junctions by construction. Cost = sum of (y - target)^2 per metre + alpha * curvature^2
    # per metre along every edge and across every node (each pair of arms is a path through the junction).
    # alpha ~ cut-off wavelength: ~150 m on highways, ~100 m on streets, ~70 m on dirt tracks, so crests that
    # would launch a car and sags that would slam it are rounded off; terrain conform then cuts / fills the
    # ground to the profile.
    from scipy import sparse
    from scipy.sparse.linalg import spsolve
    ALPHA = {'highway': 220.0, 'road': 25.0, 'dirt': 8.0}
    base = NN
    for ed in E:
        n = len(ed['P'])
        ed['vi'] = np.r_[ed['src']['a'], base + np.arange(n - 2), ed['src']['b']].astype(np.int64)
        base += n - 2
    # Tunnels are built at runtime (Roads.findTunnels) between facing dead ends with high ground between them and
    # a straight grade <= 7 %. Couple such portal pairs here with a virtual tube profile (smoothness + grade limit,
    # no ground data), so both portals end up at heights a tunnel can actually connect.
    deg_n = np.zeros(NN, int)
    for ed in E:
        deg_n[ed['src']['a']] += 1
        deg_n[ed['src']['b']] += 1
    tends = []
    for ed in E:
        a, b = ed['src']['a'], ed['src']['b']
        if a == b or ed['B'].any() or ed['S'][-1] < 30:
            continue
        for at_a in (True, False):
            ni = a if at_a else b
            if deg_n[ni] != 1:
                continue
            P_ = ed['P'] if at_a else ed['P'][::-1]
            S_ = np.r_[0, np.cumsum(np.hypot(*np.diff(P_, axis=0).T))]
            q = np.array([np.interp(min(25, S_[-1]), S_, P_[:, 0]), np.interp(min(25, S_[-1]), S_, P_[:, 1])])
            d = P_[0] - q
            tends.append((ni, P_[0], d / (np.hypot(*d) + 1e-9), ed['src']['k'] == 'dirt', ed['vi'][1] if at_a else ed['vi'][-2]))
    tc = []
    for i in range(len(tends)):
        for j in range(i + 1, len(tends)):
            A_, B_ = tends[i], tends[j]
            if A_[0] == B_[0] or A_[3] != B_[3]:
                continue
            v = B_[1] - A_[1]
            L = float(np.hypot(*v))
            if L < 60 or L > 1300:
                continue
            u = v / L
            ca, cb = float(A_[2] @ u), float(-(B_[2] @ u))
            if ca < 0.88 or cb < 0.88:
                continue
            ks = np.arange(1, 24) / 24
            g = height_at(A_[1][0] + v[0] * ks, A_[1][1] + v[1] * ks)
            ga, gb = height_at(np.array([A_[1][0], B_[1][0]]), np.array([A_[1][1], B_[1][1]]))
            if g.min() < 0.2 or g.max() - max(ga, gb) < 14:
                continue
            tc.append((L * (3 - ca - cb), L, i, j))
    tc.sort()
    tused = set()
    tlinks = []
    for _, L, i, j in tc:
        if i in tused or j in tused:
            continue
        tused.update((i, j))
        n = max(2, int(L / 20))
        tlinks.append((tends[i], tends[j], L, n, base))
        base += n - 1
    NV = base
    # curvature rows (fixed): list of (var indices, coefficients, weight)
    cr, cc, cv = [], [], []

    def add_curv(vs, cs, w):
        for p_, cp in zip(vs, cs):
            for q_, cq in zip(vs, cs):
                cr.append(p_); cc.append(q_); cv.append(w * cp * cq)
    for ed in E:
        S, vi, n = ed['S'], ed['vi'], len(ed['P'])
        al = ALPHA[ed['src']['k']]
        for i in range(1, n - 1):
            h1, h2 = max(S[i] - S[i - 1], 0.5), max(S[i + 1] - S[i], 0.5)
            add_curv((vi[i - 1], vi[i], vi[i + 1]), (1 / h1, -(1 / h1 + 1 / h2), 1 / h2), 512 * al / ((h1 + h2) / 2))
    for A_, B_, L, n, b0 in tlinks:
        chain = [A_[4], A_[0]] + list(b0 + np.arange(n - 1)) + [B_[0], B_[4]]
        hh = L / n
        for i in range(1, len(chain) - 1):
            add_curv((chain[i - 1], chain[i], chain[i + 1]), (1 / hh, -2 / hh, 1 / hh), 512 * 90.0 / hh)
    print('tunnel portal pairs coupled in the profile solve:', len(tlinks), [(round(float(A_[1][0])), round(float(A_[1][1])), round(L)) for A_, B_, L, n, b0 in tlinks])
    arms = [[] for _ in range(NN)]
    for ed in E:
        P, S, vi = ed['P'], ed['S'], ed['vi']
        if len(P) < 2:
            continue
        for at_a in (True, False):
            k0, k1 = (0, 1) if at_a else (len(P) - 1, len(P) - 2)
            d = P[k1] - P[k0]
            h = max(abs(S[k1] - S[k0]), 0.5)
            arms[vi[k0]].append((vi[k1], h, d / (np.hypot(*d) + 1e-9), ALPHA[ed['src']['k']]))
    for ni in range(NN):
        A = arms[ni]
        for i in range(len(A)):
            for j in range(i + 1, len(A)):
                (va, ha, ua, aa), (vb, hb, ub, ab) = A[i], A[j]
                straight = float(ua @ ub) < -0.7
                w = (1.0 if straight or len(A) == 2 else 0.35) * 512 * min(aa, ab) / ((ha + hb) / 2)
                add_curv((va, ni, vb), (1 / ha, -(1 / ha + 1 / hb), 1 / hb), w)
    # junction plateaus: arms of real intersections are nearly level for the first ~15 m
    for ni in range(NN):
        if len(arms[ni]) < 3:
            continue
        for (va, ha, ua, aa) in arms[ni]:
            add_curv((ni, va), (-1 / ha, 1 / ha), 80.0 * ha)
    # carriageways whose asphalt touches or overlaps (ramps merging at a shallow angle, short links inside
    # interchanges, roads crossing a junction's mouth) must share one height there, or one ribbon stands proud of
    # the other and the wheel hits a step at the seam
    from scipy.spatial import cKDTree
    allP = np.concatenate([ed['P'] for ed in E])
    allV = np.concatenate([ed['vi'] for ed in E])
    allW = np.concatenate([np.full(len(ed['P']), ed['src']['w'] / 2) for ed in E])
    allE = np.concatenate([np.full(len(ed['P']), k) for k, ed in enumerate(E)])
    allB = np.concatenate([ed['B'] for ed in E])
    pairs = cKDTree(allP).query_pairs(r=float(allW.max() * 2 + 1.0), output_type='ndarray')
    clearance_rows = []
    if len(pairs):
        i_, j_ = pairs[:, 0], pairs[:, 1]
        dd = np.hypot(*(allP[i_] - allP[j_]).T)
        levels = crossing_pairs(crossings, pairs, allP, allE)
        overlap = (dd < allW[i_] + allW[j_] + 2.0) & (allV[i_] != allV[j_])
        level_vars = set()
        for ai, bi, sign in zip(i_[overlap & (levels != 0)], j_[overlap & (levels != 0)], levels[overlap & (levels != 0)]):
            u, l = (allV[ai], allV[bi]) if sign > 0 else (allV[bi], allV[ai])
            level_vars.add((int(u), int(l)))
        level_vars.update((c['nj'], c['ni']) for c in crossings)
        clearance_rows = [([u, l], [1.0, -1.0], CLEARANCE, np.inf) for u, l in sorted(level_vars)]
        keep = (allE[i_] != allE[j_]) & (allV[i_] != allV[j_]) & (dd < allW[i_] + allW[j_] + 1.0) & (allB[i_] == allB[j_]) & (levels == 0)
        i_, j_ = i_[keep], j_[keep]
        wv = 30.0 * np.clip(1.2 - dd[keep] / (allW[i_] + allW[j_] + 1.0), 0.2, 1.0)
        for a_, b_, w_ in zip(allV[i_], allV[j_], wv):
            add_curv((a_, b_), (1.0, -1.0), w_)
        print('overlapping carriageway point pairs tied:', len(i_))
    Mc = sparse.coo_matrix((cv, (cr, cc)), shape=(NV, NV)).tocsr()
    del cr, cc, cv
    # soft grade limits (active set, re-evaluated per solve): long steep climbs that follow the terrain stay
    # steep, but short steps where the reconstructed ground crosses a contour band get spread out
    GL = {'highway': 0.06, 'road': 0.095, 'dirt': 0.12}
    WG = 100000.0
    tseg = [(np.r_[A_[0], b0 + np.arange(n - 1)], np.r_[b0 + np.arange(n - 1), B_[0]], L / n) for A_, B_, L, n, b0 in tlinks]
    seg_a = np.concatenate([ed['vi'][:-1] for ed in E] + [t[0] for t in tseg])
    seg_b = np.concatenate([ed['vi'][1:] for ed in E] + [t[1] for t in tseg])
    seg_h = np.concatenate([np.maximum(np.diff(ed['S']), 0.5) for ed in E] + [np.full(len(t[0]), t[2]) for t in tseg])
    seg_l = np.concatenate([np.full(len(ed['P']) - 1, 0.025 if ed['src'].get('cl') in (4, 5) else 0.075 if ed['src'].get('rp') else GL[ed['src']['k']]) for ed in E] + [np.full(len(t[0]), 0.062) for t in tseg])
    seg_w = np.concatenate([np.full(len(ed['P']) - 1, WG) for ed in E] + [np.full(len(t[0]), WG * 60) for t in tseg])  # tubes: hard-ish
    active = np.zeros(len(seg_a), np.int8)  # -1 / +1: grade pulled down to -limit / up to +limit... sign of grade
    from road_profiles import BoundedProfiles
    bounded = BoundedProfiles(NV, seg_a, seg_b, seg_h, seg_l, clearance_rows)
    from road_structures import structure_floor, watson_distance
    floors = structure_floor(E, NV)

    def solve(targets, Y0=None):
        # targets: list of (var array, target array, weight array)
        dw = np.zeros(NV)
        rhs = np.zeros(NV)
        for v, t, w in targets:
            np.add.at(dw, v, w)
            np.add.at(rhs, v, w * t)
        if os.environ.get('ROAD_PROFILE_SOLVER', 'bounded') != 'legacy':
            initial = np.maximum(0.45, rhs / np.maximum(dw, 1e-6))
            return bounded.solve(Mc + sparse.diags(dw + 1e-6), rhs + 1e-6 * 0.45, initial=initial, floor=floors)
        Y = None
        for it in range(16):
            M = Mc + sparse.diags(dw + 1e-6)
            r = rhs + 1e-6 * 0.45
            act = np.nonzero(active)[0]
            if len(act):
                wa = seg_w[act] / seg_h[act]
                ia, ib = seg_a[act], seg_b[act]
                M = M + sparse.coo_matrix((np.r_[wa, wa, -wa, -wa], (np.r_[ia, ib, ia, ib], np.r_[ia, ib, ib, ia])), shape=(NV, NV))
                tgt = active[act] * seg_l[act] * seg_h[act]  # desired y_b - y_a
                r = r.copy()
                np.add.at(r, ib, wa * tgt)
                np.add.at(r, ia, -wa * tgt)
            Y = spsolve(M.tocsc(), r)
            g = (Y[seg_b] - Y[seg_a]) / seg_h
            over = np.abs(g) > seg_l + 0.002
            newly = over & (active == 0)
            # release segments whose grade fell well under the limit (or flipped sign)
            rel = (active != 0) & (np.abs(g) < seg_l - 0.01)
            if not newly.any() and not rel.any():
                break
            active[newly] = np.sign(g[newly]).astype(np.int8)
            active[rel] = 0
        return Y

    def point_w(ed):
        S = ed['S']
        h = np.diff(S)
        return np.maximum(np.r_[h[:1], (h[:-1] + h[1:]) / 2, h[-1:]] if len(h) else np.ones(1), 0.5) / 8.0
    # 2a: land points follow the natural ground; deck points float (they only get a weak pull to sea level)
    tg = []
    for ed in E:
        w = point_w(ed)
        tg.append((ed['vi'], np.where(ed['B'], 0.45, ed['g']), np.where(ed['B'], 1e-4, w)))
    Y = solve(tg)
    # roads never dip below the waterline (approaches drawn across shallows become low embankments)
    for it in range(3):
        low = [(ed['vi'], np.full(len(ed['P']), 0.45), np.where(~ed['B'] & (Y[ed['vi']] < 0.45), 40.0, 0.0)) for ed in E]
        if not any(l[2].any() for l in low):
            break
        Y = solve(tg + low)
    for ed in E:
        ed['y'] = Y[ed['vi']]
    # 2b: bridge decks - graph distance-to-shore for "water" nodes so decks meet at the same height at forks
    dist = [INF] * NN
    yref = [1.0] * NN
    adj = [[] for _ in range(NN)]
    for ei, ed in enumerate(E):
        a, b = ed['src']['a'], ed['src']['b']
        adj[a].append(ei)
        adj[b].append(ei)
        land = np.nonzero(~ed['B'])[0]
        if len(land):
            ia, ib = land[0], land[-1]
            da, db = ed['S'][ia], ed['S'][-1] - ed['S'][ib]
            if da < dist[a]: dist[a], yref[a] = da, float(ed['y'][ia])
            if db < dist[b]: dist[b], yref[b] = db, float(ed['y'][ib])
    pq = [(dist[n], n) for n in range(NN) if dist[n] < INF]
    heapq.heapify(pq)
    while pq:
        d, n = heapq.heappop(pq)
        if d > dist[n]:
            continue
        for ei in adj[n]:
            ed = E[ei]
            if (~ed['B']).any():
                continue  # edges with land points already seeded their ends
            a, b = ed['src']['a'], ed['src']['b']
            o = b if a == n else a
            nd = d + ed['S'][-1]
            if nd < dist[o]:
                dist[o], yref[o] = nd, yref[n]
                heapq.heappush(pq, (nd, o))
    SLOPE, MAXC = 0.065, 8.5
    clear = lambda d: min(MAXC, SLOPE * d)
    # deck targets from distance to the nearest shore point (within the edge or through its end nodes)
    for ed in E:
        P, B, y, S = ed['P'], ed['B'], ed['y'].copy(), ed['S']
        a, b = ed['src']['a'], ed['src']['b']
        n = len(P)
        ed['yt'] = y
        if not B.any():
            continue
        dF = np.full(n, INF); yF = np.ones(n)  # nearest land point behind
        dB = np.full(n, INF); yB = np.ones(n)  # nearest land point ahead
        last = -1
        for i in range(n):
            if not B[i]: last = i
            if last >= 0: dF[i], yF[i] = S[i] - S[last], y[last]
        last = -1
        for i in range(n - 1, -1, -1):
            if not B[i]: last = i
            if last >= 0: dB[i], yB[i] = S[last] - S[i], y[last]
        dl = np.minimum(dF, dB)
        # shore reference blends linearly between the two banks (no step where the nearest bank switches)
        both = (dF < INF) & (dB < INF)
        yl = np.where(both, (yF * dB + yB * dF) / np.maximum(dF + dB, 1e-6), np.where(dF <= dB, yF, yB))
        for i in range(n):
            if not B[i]:
                continue
            d, yr = dl[i], yl[i]
            if dist[a] + S[i] < d: d, yr = dist[a] + S[i], yref[a]
            if dist[b] + (S[-1] - S[i]) < d: d, yr = dist[b] + (S[-1] - S[i]), yref[b]
            if d >= INF: d, yr = 60.0, 1.0
            y[i] = max(yr, 0.45) + clear(d)
        ed['yt'] = y
    # 2c: final solve - land follows the ground, decks follow their clearance targets (stronger), all smooth
    tg = [(ed['vi'], np.where(ed['B'], ed['yt'], ed['g']), point_w(ed) * np.where(ed['B'], 6.0, 1.0)) for ed in E]
    Y = solve(tg)
    for it in range(4):
        low = []
        for ed in E:
            yv = Y[ed['vi']]
            floor_ = np.where(ed['B'], ed['yt'] - 0.8, 0.45)  # decks keep their clearance within 0.8 m
            low.append((ed['vi'], np.where(ed['B'], ed['yt'] - 0.8, 0.45), np.where(yv < floor_ - 0.005, 40.0, 0.0)))
        if not any(l[2].any() for l in low):
            break
        tg = tg + low
        Y = solve(tg)
    out_edges = []
    total_pts = 0
    max_grade = []
    for ei, ed in enumerate(E):
        P, B, S = ed['P'], ed['B'], ed['S']
        y = Y[ed['vi']]
        # Preserve the lower road beneath the viaduct; terrain conform only fills
        # approaches once they return close to ground level.
        for c in crossings:
            if ei in c['upper']:
                near = np.linalg.norm(P - [c['x'], c['z']], axis=1)
                B |= (near < c['radius']) | ((near < 300) & (y - ed['g'] > 0.9))
        B |= (watson_distance(P) < 320) & (y - ed['g'] > 1.2)
        total_pts += len(P)
        e = ed['src']
        oe = {'a': e['a'], 'b': e['b'], 'k': e['k'], 'w': e['w'], 'p': np.round(P, 1).ravel().tolist(), 'y': np.round(y, 3).tolist(),
              'w0': e.get('w0', e['w']), 'rp': e.get('rp', 0), 'cl': e.get('cl', 0)}
        for tag in ('off', 'cn'):
            if e.get(tag):
                oe[tag] = 1
        if 'W' in ed and np.ptp(ed['W']) > 0.3:
            oe['wp'] = np.round(ed['W'], 1).tolist()
        if B.any():
            oe['br'] = B.astype(int).tolist()
        out_edges.append(oe)
        if len(P) > 1:
            max_grade.append(float(np.max(np.abs(np.diff(y)) / np.maximum(np.diff(S), 0.5))))
    node_y = [round(float(Y[ni]), 3) for ni in range(NN)]
    json.dump({'nodes': nodes, 'ny': node_y, 'edges': out_edges, 'ends': roads.get('ends', []), 'overpasses': crossings,
               'profileFit': {'solver': 'bounded', 'clearance': CLEARANCE, 'passes': bounded.stats, 'review': crossing_rejects}},
              open(os.path.join(OUT, 'roads.json'), 'w'), separators=(',', ':'))
    mg = np.array(max_grade)
    print('roads pts', total_pts, '%.2f MB' % (os.path.getsize(os.path.join(OUT, 'roads.json')) / 1e6), 'water nodes', sum(1 for d in dist if 0 < d < INF),
          'edges with grade > 10%%: %d, > 15%%: %d' % (int((mg > 0.10).sum()), int((mg > 0.15).sum())), time.time() - t0)

    # ---------------- terrain conform: ground follows the final road profiles ----------------
    # Under the asphalt the ground sits 0.12 m below the centreline profile, at the edge 6 cm below, then blends
    # back to the natural terrain over a smooth shoulder. Removes floating road edges and buried kerbs.
    best_d = np.full(hv_land.shape, 1e9)
    best_y = np.zeros(hv_land.shape)
    SH = 16.0
    # junction planes, as Roads.junctionPlane fits them (node weight 2, arm points at 3/6/9/12 m, ridge 5). The
    # fill and the arms' last metres tilt onto the plane, so near a junction the ground follows the plane at its
    # own position, easing into each arm's centre profile further out: the corners between the arms of a junction
    # on a slope are no longer conformed to one arm's centreline (up to ~1 m under the fill edge: a raised slab and
    # a drop for a car cutting the corner).
    inc = [[] for _ in range(NN)]
    for oe in out_edges:
        if oe['a'] != oe['b']:
            inc[oe['a']].append(oe)
            inc[oe['b']].append(oe)
    jplanes = {}
    for ni in range(NN):
        if len(inc[ni]) < 3:
            continue
        nx_, nz_ = nodes[ni]
        A_ = [[2.0, 0, 0], [0, 0, 0], [0, 0, 0]]
        rr = [2.0 * node_y[ni], 0.0, 0.0]
        geo, fit = [], [(0.0, 0.0, node_y[ni])]
        for oe in inc[ni]:
            P = np.array(oe['p']).reshape(-1, 2)
            Yp = np.array(oe['y'])
            S = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
            if oe['a'] != ni:
                P, Yp, S = P[::-1], Yp[::-1], S[-1] - S[::-1]
            geo.append((P, Yp, S, oe['w'] / 2, (id(oe), oe['a'] == ni)))
            for d in (3, 6, 9, 12):
                sd = min(d, S[-1] * 0.45)
                x, z, y = np.interp(sd, S, P[:, 0]) - nx_, np.interp(sd, S, P[:, 1]) - nz_, np.interp(sd, S, Yp)
                fit.append((x, z, y))
                v = (1.0, x, z)
                for i in range(3):
                    rr[i] += v[i] * y
                    for j in range(3):
                        A_[i][j] += v[i] * v[j]
        A_[1][1] += 5
        A_[2][2] += 5
        try:
            pa, pb, pc = np.linalg.solve(np.array(A_), np.array(rr))
        except np.linalg.LinAlgError:
            continue
        res_ = max(abs(pa + pb * x + pc * z - y) for x, z, y in fit)
        jplanes[ni] = (pa, pb, pc, max(g[3] for g in geo), geo, res_)
    # planes the runtime applies (Roads.computeJunctions: fit residual <= 0.6 m, no deck arm at the node)
    jdeck = set()
    for oe in out_edges:
        Bf = oe.get('br')
        for ni, k in ((oe['a'], 0), (oe['b'], -1)):
            if ni in jplanes and Bf and Bf[k]:
                jdeck.add(ni)
    jtilt = {ni for ni, v in jplanes.items() if v[5] <= 0.6 and ni not in jdeck}

    def arm_models(ni, urb):
        # each arm's end row and tilt, as Roads.computeJunctions makes them: trim where neighbouring arm
        # boundaries meet (+1 m, >= 0.6 hw + 1.5, + 4.6 on urban junctions), end-row corners lifted / lowered to the
        # plane, blended back to the design profile over tiltD. Returns {(edge id, at a): (tr, x, z, y, nx, nz, hw,
        # tiltD, off0, gn)}: at s > tr the drawn surface is design + (off0 + gn * lateral) * (1 - smoothstep).
        pa, pb, pc, mhw, geo, res_ = jplanes[ni]
        nx_, nz_ = nodes[ni]
        arms = []
        for P, Yp, S, hw, key in geo:
            sd = min(10, S[-1] * 0.45)
            qx, qz = np.interp(sd, S, P[:, 0]) - nx_, np.interp(sd, S, P[:, 1]) - nz_
            l = math.hypot(qx, qz) or 1.0
            arms.append([math.atan2(qz, qx), qx / l, qz / l, hw, 0.0, P, Yp, S, key])
        arms.sort(key=lambda a: a[0])
        n, cap = len(arms), mhw * 2.5 + 6
        for i in range(n):
            A, B = arms[i], arms[(i + 1) % n]
            den = A[1] * B[2] - A[2] * B[1]
            if abs(den) < 0.12:
                ta, tb = A[3], B[3]
            else:
                wx, wz = B[2] * B[3] + A[2] * A[3], -B[1] * B[3] - A[1] * A[3]
                ta, tb = (wx * B[2] - wz * B[1]) / den, (wx * A[2] - wz * A[1]) / den
            A[4] = max(A[4], min(cap, max(ta, 0.0)))
            B[4] = max(B[4], min(cap, max(tb, 0.0)))
        out = {}
        for ang, ux, uz, hw, t, P, Yp, S, key in arms:
            tr = min(max(t + 1.0, hw * 0.6 + 1.5) + urb, S[-1] * 0.45)
            x, z, y = np.interp(tr, S, P[:, 0]), np.interp(tr, S, P[:, 1]), np.interp(tr, S, Yp)
            x2, z2 = np.interp(min(S[-1], tr + 1.0), S, P[:, 0]), np.interp(min(S[-1], tr + 1.0), S, P[:, 1])
            tl = math.hypot(x2 - x, z2 - z) or 1.0
            nx, nz = -(z2 - z) / tl, (x2 - x) / tl
            off0 = pa + pb * (x - nx_) + pc * (z - nz_) - y
            gn = pb * nx + pc * nz
            dmax = abs(off0) + abs(gn) * hw
            tiltD = min(max(12.0, 4 * hw, 1.5 * dmax / 0.02), max(12.0, S[-1] - tr))
            out[key] = (tr, x, z, y, nx, nz, hw, tiltD, off0, gn)
        return out
    jarm = {ni: arm_models(ni, 0.0) for ni in jtilt}
    for oe in out_edges:
        P = np.array(oe['p']).reshape(-1, 2)
        Yp = np.array(oe['y'])
        Bf = np.array(oe.get('br', [0] * len(P)), bool)
        hw = oe['w'] / 2
        R = hw + 1.5 + SH
        Se = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
        jl = []  # (plane, node, end at a?, arm model)
        for ni, at_a in ((oe['a'], True), (oe['b'], False)):
            if ni in jarm and oe['a'] != oe['b'] and (id(oe), at_a) in jarm[ni]:
                jl.append((jplanes[ni], nodes[ni], at_a, jarm[ni][(id(oe), at_a)]))
        for i in range(len(P) - 1):
            if Bf[i] or Bf[i + 1]:
                continue
            (x0, z0), (x1, z1) = P[i], P[i + 1]
            ix0 = max(0, int(math.floor((min(x0, x1) - R - WX0) / HS)))
            ix1 = min(GW, int(math.ceil((max(x0, x1) + R - WX0) / HS)))
            iz0 = max(0, int(math.floor((min(z0, z1) - R - WZ0) / HS)))
            iz1 = min(GH, int(math.ceil((max(z0, z1) + R - WZ0) / HS)))
            if ix1 < ix0 or iz1 < iz0:
                continue
            gx = WX0 + np.arange(ix0, ix1 + 1) * HS
            gz = WZ0 + np.arange(iz0, iz1 + 1) * HS
            X, Z = np.meshgrid(gx, gz)
            dx, dz = x1 - x0, z1 - z0
            L2 = dx * dx + dz * dz or 1e-9
            t = np.clip(((X - x0) * dx + (Z - z0) * dz) / L2, 0, 1)
            d = np.hypot(X - (x0 + dx * t), Z - (z0 + dz * t)) - hw  # signed distance from the road edge
            ty = Yp[i] + (Yp[i + 1] - Yp[i]) * t
            for pl, (nx_, nz_), at_a, (tr, ax, az, ay, anx, anz, ahw, tiltD, off0, gn) in jl:
                sj = Se[i] + (Se[i + 1] - Se[i]) * t
                sj = sj if at_a else Se[-1] - sj
                if sj.min() >= tr + tiltD:
                    continue
                u = np.clip((sj - tr) / tiltD, 0, 1)
                u = 1 - u * u * (3 - 2 * u)
                lat = np.clip((X - ax) * anx + (Z - az) * anz, -ahw, ahw)
                ty = np.where(sj <= tr, pl[0] + pl[1] * (X - nx_) + pl[2] * (Z - nz_), ty + (off0 + gn * lat) * u)
            sub_d = best_d[iz0:iz1 + 1, ix0:ix1 + 1]
            m = (d < sub_d) & (d < 1.5 + SH)
            sub_d[m] = d[m]
            best_y[iz0:iz1 + 1, ix0:ix1 + 1][m] = ty[m]
    near = best_d < 1.5 + SH
    target = np.where(best_d < -0.5, best_y - 0.12, best_y - 0.06)
    wgt = np.clip(1.0 - (best_d - 1.5) / SH, 0, 1)
    wgt = wgt * wgt * (3 - 2 * wgt)
    land = hv_land > 0.2
    hv_c = np.where(near & land, hv_land * (1 - wgt) + target * wgt, hv_land)
    # never push the ground through the deck, never dig below sea level on land
    under = near & land & (best_d < -0.5)
    hv_c = np.where(under, np.minimum(hv_c, best_y - 0.12), hv_c)
    hv_c = np.where(land, np.maximum(hv_c, 0.25), hv_c)
    # exact guarantee on the game's triangulation (Terrain.heightAt / Rapier heightfield: cells split along
    # (x+1,z)-(x,z+1)): sample every ribbon densely (lanes, edges, junction discs); wherever the interpolated
    # ground comes within 5 cm of the asphalt, lower that triangle's three vertices by the excess (decks: 30 cm).
    xs_, zs_, ys_, mg_ = [], [], [], []
    for oe in out_edges:
        P = np.array(oe['p']).reshape(-1, 2)
        Yp = np.array(oe['y'])
        Bf = np.array(oe.get('br', [0] * len(P)), bool)
        Wp = np.array(oe['wp']) if 'wp' in oe else np.full(len(P), oe['w'])
        S = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
        if S[-1] < 0.1:
            continue
        ss = np.linspace(0, S[-1], max(2, int(S[-1] / 2.0) + 1))
        px, pz = np.interp(ss, S, P[:, 0]), np.interp(ss, S, P[:, 1])
        py, pw = np.interp(ss, S, Yp), np.interp(ss, S, Wp)
        pb = np.interp(ss, S, Bf.astype(float)) > 0.01
        k = np.clip(np.searchsorted(S, ss, side='right') - 1, 0, len(P) - 2)
        tx, tz = P[k + 1, 0] - P[k, 0], P[k + 1, 1] - P[k, 1]
        tl = np.hypot(tx, tz) + 1e-9
        nx, nz = -tz / tl, tx / tl
        for f in (-1.08, -0.75, -0.4, 0.0, 0.4, 0.75, 1.08):
            off = f * pw / 2
            xs_.append(px + nx * off); zs_.append(pz + nz * off); ys_.append(py); mg_.append(np.where(pb, 0.3, 0.05))
    # junction corners: the fill polygon between neighbouring arms is not under any edge ribbon. Sample the wedge
    # between each pair of adjacent arms, blending the two arms' heights by angle (the fill fans between them).
    arm_l = [[] for _ in range(NN)]
    for oe in out_edges:
        P = np.array(oe['p']).reshape(-1, 2)
        Yp = np.array(oe['y'])
        S = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
        if S[-1] < 1 or oe['a'] == oe['b']:
            continue
        for at_a in (True, False):
            ni = oe['a'] if at_a else oe['b']
            Sx = S if at_a else S[-1] - S[::-1]
            Px = P if at_a else P[::-1]
            Yx = Yp if at_a else Yp[::-1]
            q = np.array([np.interp(min(10, Sx[-1]), Sx, Px[:, 0]), np.interp(min(10, Sx[-1]), Sx, Px[:, 1])]) - Px[0]
            arm_l[ni].append((math.atan2(q[1], q[0]), Sx, Yx, oe['w'] / 2))
    for ni in range(NN):
        A = sorted(arm_l[ni], key=lambda t: t[0])
        if len(A) < 3:
            continue
        R = max(t[3] for t in A) + 3.0
        for i in range(len(A)):
            a1, a2 = A[i], A[(i + 1) % len(A)]
            th1, th2 = a1[0], a2[0] + (2 * np.pi if i == len(A) - 1 else 0)
            for r in (0.3 * R, 0.65 * R, R):
                y1, y2 = np.interp(r, a1[1], a1[2]), np.interp(r, a2[1], a2[2])
                u = np.linspace(0, 1, 6)[1:-1]
                ph = th1 + (th2 - th1) * u
                xs_.append(nodes[ni][0] + r * np.cos(ph)); zs_.append(nodes[ni][1] + r * np.sin(ph))
                ys_.append(y1 + (y2 - y1) * u); mg_.append(np.full(len(ph), 0.1))
    # junction planes (Roads.junctionPlane): the fill (and the arm strips under it) lie on the plane; each arm's end
    # row tilts to it and blends back to the design profile over tiltD (arm_models). Keep the ground under
    # min(design, drawn surface) there - for both trims the runtime may pick (rural / urban). Junctions the runtime
    # leaves untilted (decks, saddles) have a flat-ish fill around the node height.
    n_jp = 0
    for ni, (pa, pb, pc, mhw, geo, res_) in jplanes.items():
        nx_, nz_ = nodes[ni]
        n_jp += 1
        if ni in jtilt:
            for urb in (0.0, 4.6):
                mods = arm_models(ni, urb)
                for P, Yp, S, hw, key in geo:
                    tr, ax, az, ay, anx, anz, ahw, tiltD, off0, gn = mods[key]
                    L = min(S[-1], tr + tiltD)
                    ss = np.linspace(0, L, max(2, int(L / 2) + 1))
                    px, pz, py = np.interp(ss, S, P[:, 0]), np.interp(ss, S, P[:, 1]), np.interp(ss, S, Yp)
                    k = np.clip(np.searchsorted(S, ss, side='right') - 1, 0, len(P) - 2)
                    tx, tz = P[k + 1, 0] - P[k, 0], P[k + 1, 1] - P[k, 1]
                    tl = np.hypot(tx, tz) + 1e-9
                    u = np.clip((ss - tr) / tiltD, 0, 1)
                    u = 1 - u * u * (3 - 2 * u)
                    for f in (-1.1, -0.7, -0.35, 0.0, 0.35, 0.7, 1.1):
                        X, Z = px - tz / tl * f * hw, pz + tx / tl * f * hw
                        lat = np.clip((X - ax) * anx + (Z - az) * anz, -ahw, ahw)
                        surf = np.where(ss <= tr, pa + pb * (X - nx_) + pc * (Z - nz_), py + (off0 + gn * lat) * u)
                        xs_.append(X); zs_.append(Z); ys_.append(np.minimum(py, surf)); mg_.append(np.full(len(X), 0.06))
        R = mhw + 4.0
        rr_, aa_ = np.meshgrid(np.linspace(0, R, 6), np.linspace(0, 2 * np.pi, 24, endpoint=False))
        X, Z = nx_ + (rr_ * np.cos(aa_)).ravel(), nz_ + (rr_ * np.sin(aa_)).ravel()
        dy = pa + pb * (X - nx_) + pc * (Z - nz_)
        xs_.append(X); zs_.append(Z); ys_.append(dy if ni in jtilt else np.minimum(dy, node_y[ni])); mg_.append(np.full(len(X), 0.06))
    SX, SZ, SY, SM = (np.concatenate(v) for v in (xs_, zs_, ys_, mg_))
    fx, fz = (SX - WX0) / HS, (SZ - WZ0) / HS
    ok = (fx >= 0) & (fz >= 0) & (fx < GW) & (fz < GH)
    SX, SZ, SY, SM, fx, fz = SX[ok], SZ[ok], SY[ok], SM[ok], fx[ok], fz[ok]
    ix, iz = np.floor(fx).astype(np.int64), np.floor(fz).astype(np.int64)
    tx, tz = fx - ix, fz - iz
    lower = tx + tz <= 1
    # triangle vertices + barycentric weights (same split as Terrain.heightAt)
    v0 = np.where(lower[:, None], np.stack([iz * (GW + 1) + ix, iz * (GW + 1) + ix + 1, (iz + 1) * (GW + 1) + ix], 1),
                  np.stack([(iz + 1) * (GW + 1) + ix + 1, (iz + 1) * (GW + 1) + ix, iz * (GW + 1) + ix + 1], 1))
    bw = np.where(lower[:, None], np.stack([1 - tx - tz, tx, tz], 1), np.stack([tx + tz - 1, 1 - tx, 1 - tz], 1))
    flat = hv_c.ravel()
    land_f = land.ravel()
    n_low = 0
    # least-change lowering: a sample mostly over one vertex lowers that vertex, not the far corners of the 8 m
    # triangle (lowering all three equally dug the ground ~1 m below kerbs and fill edges between the arms of
    # junctions on a slope). Each vertex takes the largest drop any sample asks of it; a few passes converge,
    # then the plain all-three drop closes whatever is left, so the guarantee is exact either way.
    for it in range(40):
        hgt = (flat[v0] * bw).sum(1)
        exc = hgt - (SY - SM)
        bad = exc > 0.002
        if not bad.any():
            break
        n_low += int(bad.sum())
        if it < 32:
            wb = bw[bad]
            d = (exc[bad] + 0.01)[:, None] * wb / (wb * wb).sum(1, keepdims=True)
        else:
            d = np.repeat((exc[bad] + 0.01)[:, None], 3, 1)
        np.minimum.at(flat, v0[bad].ravel(), (flat[v0[bad]] - d).ravel())
    hv_c = flat.reshape(hv_c.shape)
    # height.bin is stored in decimetres: round the conformed ground down so the guarantee survives quantisation
    touched = near | (np.abs(hv_c - hv_land) > 1e-6)
    hv = np.where(touched, np.floor(hv_c * 10), np.round(hv_c * 10)).astype(np.int16)
    wgz(os.path.join(OUT, 'height.bin'), hv)
    np.save(os.path.join(CLS, 'height_v.npy'), hv)
    print('terrain conform: %d vertices adjusted, max change %.2f m, %d ribbon samples lowered the ground' % (
        int(near.sum()), float(np.abs(hv_c - hv_land).max()), n_low), time.time() - t0)

    # ---------------- buildings ----------------
    ob = []
    for o in blds:
        p = np.array(o['p'])
        ys = height_at(p[:, 0], p[:, 1])
        base = float(ys.min())
        if base < 0.2:
            base = max(base, 0.3)
        q = {'p': np.round(p, 1).ravel().tolist(), 'y': round(base, 2), 'h': o['h'], 's': o['s'], 'f': o['f']}
        if o.get('g'):
            q['g'] = 1
        if o.get('n'):
            q['n'] = o['n']
        ob.append(q)
    json.dump(ob, open(os.path.join(OUT, 'buildings.json'), 'w'), separators=(',', ':'))
    print('buildings %.2f MB' % (os.path.getsize(os.path.join(OUT, 'buildings.json')) / 1e6))

    # ---------------- vegetation ----------------
    veg_types = {'palm': 0, 'tree': 1, 'pine': 2, 'bush': 3, 'cypress': 4, 'reed': 5}
    rng = np.random.default_rng(7)
    bld_occ = np.load(os.path.join(CLS, 'bld_occ.npy'))
    # 4 m sample grid
    g4 = gcls
    occ4 = mosaic_window((bld_occ | road_mask | (cls == C['building']) | (cls == C['building_blue'])).astype(np.uint8), 1, TS).astype(bool)
    occ4 = ndi.binary_dilation(occ4 | rib_occ, iterations=1)  # rib_occ: every road ribbon incl. repaired gaps
    road4 = mosaic_window(road_mask.astype(np.uint8), 0, TS).astype(bool)
    rd4, (rdi, rdj) = ndi.distance_transform_edt(~road4, return_indices=True)
    rd4 *= TS
    hv_f = hv.astype(np.float32) * 0.1
    # noise field for clustering
    noise = ndi.gaussian_filter(rng.standard_normal((TH // 8 + 1, TW // 8 + 1)).astype(np.float32), 2.0)
    noise = ndi.zoom(noise, 8, order=1)[:TH, :TW]
    noise = (noise - noise.mean()) / (noise.std() + 1e-6)
    hgt4 = ndi.zoom(hv_f, HS / TS, order=1)[:TH, :TW]
    U = rng.random((TH, TW))
    vx, vz, vt = [], [], []

    def add(mask, prob, kind):
        m = mask & (U < prob)
        iy, ix = np.nonzero(m)
        vx.append(WX0 + (ix + rng.random(len(ix))) * TS)
        vz.append(WZ0 + (iy + rng.random(len(iy))) * TS)
        vt.append(np.full(len(ix), veg_types[kind], np.uint8))
        return len(ix)

    free = ~occ4 & (g4 != G['water']) & (g4 != G['road'])
    grass = free & (g4 == G['grass'])
    n1 = add(grass & (noise > 0.35) & (hgt4 < 45), 0.10, 'tree')
    n2 = add(grass & (noise > 0.1) & (hgt4 >= 30), 0.13, 'pine')
    n3 = add(grass & (noise > -0.2) & (np.roll(U, 7, 1) < 0.02), 1.0, 'bush')
    n4 = add(free & (g4 == G['park']) & (noise > -0.4), 0.05, 'tree')
    n5 = add(free & (g4 == G['park']), 0.015, 'palm')
    n6 = add(free & (g4 == G['wetland']) & (noise > 0.0), 0.06, 'cypress')
    n7 = add(free & (g4 == G['wetland']), 0.05, 'reed')
    n8 = add(free & (g4 == G['sand']) & (noise > 0.4), 0.02, 'palm')
    # yards in suburbs
    n9 = add(free & (g4 == G['urban']) & (rd4 > 10) & (noise > 0.2), 0.035, 'tree')
    n10 = add(free & (g4 == G['urban']) & (rd4 > 8), 0.012, 'palm')
    # palms lining urban roads: points near road edges
    edge_band = free & (rd4 > 5) & (rd4 < 10) & np.isin(g4, [G['urban'], G['park'], G['sand'], G['grass']])
    n11 = add(edge_band & ((np.arange(TW)[None, :] + np.arange(TH)[:, None]) % 4 == 0), 0.5, 'palm')
    VX = np.concatenate(vx).astype(np.float32)
    VZ = np.concatenate(vz).astype(np.float32)
    VT = np.concatenate(vt)
    print('veg', len(VX), dict(tree=n1 + n4 + n9, pine=n2, bush=n3, palm=n5 + n8 + n10 + n11, cypress=n6, reed=n7))
    order = np.argsort(VT, kind='stable')
    VX, VZ, VT = VX[order], VZ[order], VT[order]
    SC = (rng.random(len(VX)) * 255).astype(np.uint8)
    RT = (rng.random(len(VX)) * 255).astype(np.uint8)
    buf = np.zeros(len(VX), dtype=[('x', '<f4'), ('z', '<f4'), ('t', 'u1'), ('s', 'u1'), ('r', 'u1'), ('_', 'u1')])
    buf['x'], buf['z'], buf['t'], buf['s'], buf['r'] = VX, VZ, VT, SC, RT
    wgz(os.path.join(OUT, 'veg.bin'), buf)

    # ---------------- map images (GTA radar style) ----------------
    pal = np.zeros((16, 3), np.uint8)
    for k, v in {'water': (55, 83, 112), 'sand': (122, 116, 92), 'grass': (74, 88, 70), 'park': (66, 96, 64), 'wetland': (68, 96, 88),
                 'farm': (80, 94, 66), 'dirt': (104, 96, 80), 'urban': (88, 90, 94), 'paved': (82, 84, 88), 'building': (104, 106, 112),
                 'road': (88, 90, 94), 'sport': (70, 104, 66)}.items():
        pal[G[k]] = v
    img = pal[gcls]
    # depth shading for water
    dep4 = ndi.zoom(np.where(water, -h, 0), HS / TS, order=1)[:TH, :TW]
    wm = gcls == G['water']
    shade = np.clip(dep4 / 25, 0, 1)
    img = img.astype(np.float32)
    for ci, (a_, b_) in enumerate(((70, 40), (104, 64), (132, 92))):
        img[..., ci] = np.where(wm, a_ * (1 - shade) + b_ * shade, img[..., ci])
    # hillshade for land
    gy, gx = np.gradient(hgt4)
    hs = np.clip(1.0 + (gx * -0.6 + gy * -0.6) * 0.25, 0.7, 1.3)
    img = np.where(wm[..., None], img, img * hs[..., None])
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).convert('RGB')
    dr = ImageDraw.Draw(im)
    for e in sorted(out_edges, key=lambda e: {'dirt': 0, 'road': 1, 'highway': 2}[e['k']]):
        p = np.array(e['p']).reshape(-1, 2)
        pts = [((x - WX0) / TS, (z - WZ0) / TS) for x, z in p]
        w = max(1, int(round(e['w'] / TS * 0.9)))
        col = {'dirt': (128, 116, 96), 'road': (176, 178, 182), 'highway': (210, 210, 214)}[e['k']]
        dr.line(pts, fill=col, width=w + (1 if e['k'] == 'highway' else 0), joint='curve')
    im.save(os.path.join(OUT, 'map.webp'), quality=88, method=6)
    im.resize((TW // 4, TH // 4), Image.LANCZOS).save(os.path.join(OUT, 'map_small.webp'), quality=90)
    print('map', im.size, '%.2f MB' % (os.path.getsize(os.path.join(OUT, 'map.webp')) / 1e6), time.time() - t0)

    # ---------------- world metadata ----------------
    lm = json.load(open(os.path.join(RAW, 'data', 'landmarks.json')))
    groups = {}
    for v in lm.values():
        if not v[1] or len(v[1]) < 2:
            continue
        parts = [s.strip() for s in v[0].split(',')]
        x, z = v[1][0], -v[1][1]
        if len(parts) >= 3:
            groups.setdefault(('d', parts[-2], parts[-1]), []).append((x, z))
        if len(parts) >= 2:
            groups.setdefault(('a', parts[-1], ''), []).append((x, z))
    districts = []
    for (t, name, area), pts in groups.items():
        if len(pts) < 4 or any(ch.isdigit() for ch in name) or name.startswith('Route') or 'Hwy' in name or 'Blvd' in name or 'St' == name[-2:]:
            continue
        pts = np.array(pts)
        cx, cz = np.median(pts, 0)
        rad = float(np.clip(np.percentile(np.hypot(pts[:, 0] - cx, pts[:, 1] - cz), 85) * 1.15, 200, 2500))
        districts.append({'name': name, 'area': area, 'type': t, 'x': round(float(cx)), 'z': round(float(cz)), 'r': round(rad), 'n': len(pts)})
    landmarks = []
    for key, v in lm.items():
        if not v[1] or len(v[1]) < 2:
            continue
        nm = v[0].split(',')[0].strip()
        if nm and nm != '?' and 'landmark' in (v[6] or []):
            landmarks.append({'name': nm, 'x': round(v[1][0], 1), 'z': round(-v[1][1], 1), 'real': (v[3] or '').split(',')[0]})
    world = {
        'bounds': [WX0, WZ0, WX1, WZ1], 'hs': HS, 'gw': GW, 'gh': GH, 'ts': TS, 'tw': TW, 'th': TH,
        'ground': G, 'districts': districts, 'landmarks': landmarks,
        'source': 'State of Leonida community map (YANIS v17.0, map.stateofleonida.net) + GTADB landmarks',
    }
    json.dump(world, open(os.path.join(OUT, 'world.json'), 'w'), ensure_ascii=False, indent=0)
    print('districts', len(districts), 'landmarks', len(landmarks), 'done', time.time() - t0)


if __name__ == '__main__':
    main()
