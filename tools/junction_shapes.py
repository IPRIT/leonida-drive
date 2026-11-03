"""Junction shapes from the source map: kerb-return radii per corner and channelising islands per junction.

The game's junctions are built from the road graph (public/data/roads.json, generalised widths), so their corners
would all get one generic radius. The community map (raw/cls/cls.npy, 2 m/px) shows how each real corner is shaped:
square downtown corners, wide flares where a suburban road sweeps into another, slip lanes around triangular
islands, roundabout centres. For every junction node and every pair of neighbouring arms this measures, on the
raster itself (its own road edges, not the generalised widths):

  - the arms' half-widths on the side facing the corner (perpendicular scans 14-26 m out),
  - the sharp corner V where those two kerb lines meet,
  - how far the road surface reaches past V along the corner's bisector (sub-pixel, bilinear), which for a circular
    kerb return of radius R across a wedge of angle t is R (1 / sin(t/2) - 1)  ->  R.

Islands: connected non-road areas (grass, paving) inside the junction area that the road surrounds completely
(map labels and route shields drawn over the asphalt count as road), 16-3000 m2, as simplified polygons.

Output: public/data/junctions.json  {"v": 1, "j": [[x, z, [[angA, angB, R, conf], ...]], ...], "isl": [[[x, z], ...], ...]}
Angles in degrees (atan2(dz, dx) of the arm directions, as src/world/Roads.js sorts them); runtime matches junctions
by position (graph indices change whenever the road data is regenerated) and corners by angle.

Run: .venv/bin/python tools/junction_shapes.py
"""
import json
import math
import os
import time

import numpy as np
from scipy import ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLS = os.path.join(ROOT, 'raw', 'cls')
DATA = os.path.join(ROOT, 'public', 'data')
MPP, X0, Z0 = 2.0, -11368.0, -11000.0
ROAD = (12, 13, 14)  # road, highway, dirt road: kerb lines and corner flares
ROADISH = (12, 13, 14, 17, 18, 0)  # + white / dark / unknown (labels, shields drawn over the asphalt): islands


def main():
    t0 = time.time()
    cls = np.load(os.path.join(CLS, 'cls.npy'), mmap_mode='r')
    H, W = cls.shape
    roads = json.load(open(os.path.join(DATA, 'roads.json')))
    R = roads.get('roads', roads)
    nodes, edges = R['nodes'], R['edges']
    adj = [[] for _ in nodes]
    for i, e in enumerate(edges):
        adj[e['a']].append((i, True))
        adj[e['b']].append((i, False))  # a loop appears twice, like Roads.computeJunctions
    print('graph', len(nodes), 'nodes', len(edges), 'edges', '%.1fs' % (time.time() - t0))

    def poly(e):
        p = np.asarray(e['p'], np.float64).reshape(-1, 2)
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
        return p, cum

    cache = {}

    def at(ei, fromA, s):
        if ei not in cache:
            cache[ei] = poly(edges[ei])
        p, cum = cache[ei]
        L = cum[-1]
        s = min(max(s, 0.0), L)
        if not fromA:
            s = L - s
        k = int(np.clip(np.searchsorted(cum, s) - 1, 0, len(p) - 2))
        t = (s - cum[k]) / max(1e-9, cum[k + 1] - cum[k])
        q = p[k] + (p[k + 1] - p[k]) * t
        d = (p[k + 1] - p[k]) / max(1e-9, cum[k + 1] - cum[k])
        return q, (d if fromA else -d), L

    # road indicator, bilinear (sub-pixel edges)
    win = {}

    def road(x, z):
        fx, fz = (x - X0) / MPP - 0.5, (z - Z0) / MPP - 0.5
        i, j = int(math.floor(fx)), int(math.floor(fz))
        if i < 0 or j < 0 or i + 1 >= W or j + 1 >= H:
            return 0.0
        key = (i >> 6, j >> 6)
        blk = win.get(key)
        if blk is None:
            bi, bj = key[0] << 6, key[1] << 6
            blk = np.isin(np.asarray(cls[bj:bj + 66, bi:bi + 66]), ROAD).astype(np.float32)
            win[key] = blk
            if len(win) > 4000:
                win.clear()
        bi, bj = (i >> 6) << 6, (j >> 6) << 6
        u, v = fx - i, fz - j
        a = blk[j - bj, i - bi]
        b = blk[j - bj, i - bi + 1]
        c = blk[j - bj + 1, i - bi]
        d = blk[j - bj + 1, i - bi + 1]
        return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v

    def extent(x, z, ux, uz, start=0.0, maxd=40.0, step=0.25):
        """distance along (ux, uz) from (x, z) to the road's edge (first 1 m off the road), None if none"""
        d, off = start, 0.0
        while d < maxd:
            if road(x + ux * d, z + uz * d) < 0.5:
                if off == 0.0:
                    first = d
                off += step
                if off >= 1.0:
                    return first
            else:
                off = 0.0
            d += step
        return None

    out, n_corner, n_conf = [], 0, 0
    for ni, (nx, nz) in enumerate(nodes):
        inc = adj[ni]
        if len(inc) < 3:
            continue
        arms = []
        for ei, fromA in inc:
            e = edges[ei]
            if e['k'] == 'dirt' and 0:
                continue
            _, _, L = at(ei, fromA, 0)
            q, _, _ = at(ei, fromA, min(10.0, L * 0.45))
            dx, dz = q[0] - nx, q[1] - nz
            l = math.hypot(dx, dz) or 1.0
            arms.append({'ei': ei, 'fromA': fromA, 'dx': dx / l, 'dz': dz / l, 'ang': math.atan2(dz / l, dx / l), 'L': L, 'w': e['w']})
        arms.sort(key=lambda a: a['ang'])
        # raster half-widths on each side of each arm, 14-26 m out (median)
        for a in arms:
            hl, hr = [], []
            for s in (14.0, 18.0, 22.0, 26.0):
                if s > a['L'] * 0.8:
                    break
                q, d, _ = at(a['ei'], a['fromA'], s)
                lx, lz = -d[1], d[0]  # left of the outward direction
                for sg, acc in ((1, hl), (-1, hr)):
                    ex = extent(q[0], q[1], lx * sg, lz * sg, 0.0, 30.0)
                    if ex is not None:
                        acc.append(ex)
            a['hl'] = float(np.median(hl)) if hl else None
            a['hr'] = float(np.median(hr)) if hr else None
        corners = []
        n = len(arms)
        for i in range(n):
            A, B = arms[i], arms[(i + 1) % n]
            th = B['ang'] - A['ang']
            if th <= 0:
                th += 2 * math.pi
            if not (math.radians(25) < th < math.radians(165)) or A['hl'] is None or B['hr'] is None:
                continue
            n_corner += 1
            # kerb lines: left of A, right of B (raster widths), straight from the node
            la = (-A['dz'], A['dx'])
            rb = (B['dz'], -B['dx'])
            px_, pz_ = la[0] * A['hl'], la[1] * A['hl']
            qx_, qz_ = rb[0] * B['hr'], rb[1] * B['hr']
            den = A['dx'] * B['dz'] - A['dz'] * B['dx']
            if abs(den) < 0.1:
                continue
            wx, wz = qx_ - px_, qz_ - pz_
            ta = (wx * B['dz'] - wz * B['dx']) / den
            vx, vz = nx + px_ + A['dx'] * ta, nz + pz_ + A['dz'] * ta
            bx, bz = A['dx'] + B['dx'], A['dz'] + B['dz']
            bl = math.hypot(bx, bz) or 1.0
            bx, bz = bx / bl, bz / bl
            ds = []
            for off in (-1.0, 0.0, 1.0):
                ox, oz = vx - bz * off, vz + bx * off
                # from 4 m inside the road (towards the node) out along the bisector
                ex = extent(ox - bx * 4.0, oz - bz * 4.0, bx, bz, 0.0, 40.0)
                if ex is not None:
                    ds.append(ex - 4.0)
            if len(ds) < 2:
                continue
            delta = max(0.0, float(np.median(ds)))
            k = 1.0 / math.sin(th / 2) - 1.0
            r = delta / k if k > 1e-3 else 0.0
            # confidence: raster widths close to the drawn ones, consistent rays, finite radius
            wa, wb = A['w'] / 2, B['w'] / 2
            dw = max(abs(A['hl'] - wa) / max(wa, 1), abs(B['hr'] - wb) / max(wb, 1))
            conf = 1.0
            if dw > 0.6:
                conf *= 0.4
            if max(ds) - min(ds) > 3.0:
                conf *= 0.5
            if r > 45:
                conf *= 0.3
            n_conf += conf >= 0.5
            corners.append([round(math.degrees(A['ang']), 1), round(math.degrees(B['ang']), 1), round(min(r, 60.0), 1), round(conf, 2)])
        if corners:
            out.append([round(nx, 1), round(nz, 1), corners])
    print('corners', n_corner, 'measured', sum(len(o[2]) for o in out), 'confident', n_conf, '%.1fs' % (time.time() - t0))

    # ---- islands: enclosed non-road areas around junctions ----
    isl, seen = [], set()
    for ni, (nx, nz) in enumerate(nodes):
        if len(adj[ni]) < 3:
            continue
        rad = min(60.0, 18.0 + max(edges[ei]['w'] for ei, _ in adj[ni]) * 2.0)
        i0, i1 = int((nx - rad - X0) / MPP), int((nx + rad - X0) / MPP) + 1
        j0, j1 = int((nz - rad - Z0) / MPP), int((nz + rad - Z0) / MPP) + 1
        if i0 < 1 or j0 < 1 or i1 >= W - 1 or j1 >= H - 1:
            continue
        sub = np.asarray(cls[j0:j1, i0:i1])
        rd = np.isin(sub, ROADISH)
        lab, nl = ndi.label(~rd)
        if nl == 0:
            continue
        border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
        for k in range(1, nl + 1):
            if k in border:
                continue
            m = lab == k
            area = int(m.sum()) * MPP * MPP
            if area < 16 or area > 3000:
                continue
            vals, cnt = np.unique(sub[m], return_counts=True)
            if vals[np.argmax(cnt)] in (17, 18, 0):
                continue
            jj, ii = np.nonzero(m)
            cx, cz = X0 + (i0 + ii.mean() + 0.5) * MPP, Z0 + (j0 + jj.mean() + 0.5) * MPP
            key = (round(cx / 4), round(cz / 4))
            if key in seen:
                continue
            seen.add(key)
            # outline: boundary pixel corners -> convex-ish polygon via marching around the mask (hull fallback)
            pts = boundary_polygon(m)
            if pts is None or len(pts) < 3:
                continue
            poly_w = [[round(X0 + (i0 + px) * MPP, 1), round(Z0 + (j0 + pz) * MPP, 1)] for px, pz in pts]
            isl.append(poly_w)
    print('islands', len(isl), '%.1fs' % (time.time() - t0))
    with open(os.path.join(DATA, 'junctions.json'), 'w') as f:
        json.dump({'v': 1, 'j': out, 'isl': isl}, f, separators=(',', ':'))
    print('wrote', os.path.join(DATA, 'junctions.json'), os.path.getsize(os.path.join(DATA, 'junctions.json')), 'bytes')


def boundary_polygon(m):
    """outline of a binary blob in pixel-corner coordinates, simplified (Douglas-Peucker 0.45 px)"""
    from skimage import measure
    pad = np.pad(m.astype(np.float32), 1)
    cs = measure.find_contours(pad, 0.5)
    if not cs:
        return None
    c = max(cs, key=len)  # (row, col) in padded pixel-centre coordinates
    pts = np.stack([c[:, 1] - 1 + 0.5, c[:, 0] - 1 + 0.5], axis=1)
    pts = rdp(pts, 0.45)
    if len(pts) > 3 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    return pts.tolist()


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    n = np.hypot(*ab)
    d = np.hypot(*(pts - a).T) if n < 1e-9 else np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / n
    i = int(np.argmax(d))
    if d[i] > eps:
        return np.vstack([rdp(pts[:i + 1], eps)[:-1], rdp(pts[i:], eps)])
    return np.vstack([a, b])


if __name__ == '__main__':
    main()
