"""Vectorize the road raster into a graph: nodes + polyline edges with class, width and bridge spans.

Input : raw/cls/cls.npy (2 m/px), optional raw/cls/alley.npy (alley / service / parking-aisle lines)
Output: raw/cls/roads.json (world metres), raw/cls/road_mask.npy, raw/cls/bridge_mask.npy
LEONIDA_CLS=<dir> reads and writes the cls directory elsewhere.
Alleys join the graph as narrow streets (k 'road', 4.5-7 m); their edges carry 'al': 1.
"""
import gc
import json
import os
import sys
import time
import numpy as np
from scipy import ndimage as ndi
from skimage.morphology import skeletonize, remove_small_objects, remove_small_holes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLS = os.environ.get('LEONIDA_CLS') or os.path.join(ROOT, 'raw', 'cls')
sys.setrecursionlimit(10000)

ROAD, HIGHWAY, DIRTROAD, WATER = 12, 13, 14, 1
MPP = 2.0
X0 = float(os.environ.get('LEONIDA_X0', -11368.0))
Z0 = float(os.environ.get('LEONIDA_Z0', -11000.0))


def px2w(px, py):
    return (px + 0.5) * MPP + X0, (py + 0.5) * MPP + Z0


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    n = np.hypot(*ab)
    if n < 1e-9:
        d = np.hypot(*(pts - a).T)
    else:
        d = np.abs(ab[0] * (pts[:, 1] - a[1]) - ab[1] * (pts[:, 0] - a[0])) / n
    i = int(np.argmax(d))
    if d[i] > eps:
        left = rdp(pts[:i + 1], eps)
        right = rdp(pts[i:], eps)
        return np.vstack([left[:-1], right])
    return np.vstack([a, b])


def main():
    t0 = time.time()
    cls = np.load(os.path.join(CLS, 'cls.npy'))
    H, W = cls.shape
    mask = (cls == ROAD) | (cls == HIGHWAY) | (cls == DIRTROAD)
    # Optional source-canvas clip, used to exclude GTADB's legend / thumbnail panel.
    clip = os.environ.get('LEONIDA_ROAD_CLIP')
    if clip:
        x0, y0, x1, y1 = [int(v) for v in clip.split(',')]
        clipped = np.zeros_like(mask)
        clipped[max(0, y0):min(H, y1), max(0, x0):min(W, x1)] = mask[max(0, y0):min(H, y1), max(0, x0):min(W, x1)]
        mask = clipped
    ap = os.path.join(CLS, 'alley.npy')
    alley = np.load(ap) if os.path.exists(ap) else np.zeros_like(mask)
    if clip:
        alley &= ndi.binary_dilation(mask, iterations=3)
    # alleys stop one pixel short of the street they leave (the street's anti-aliased rim): the closing joins them
    # Keep source-supported green / paved medians through morphological cleanup:
    # even a one-pixel separator distinguishes two parallel carriageways.
    median = np.isin(cls, [2, 3, 5, 8, 9, 15]) & ndi.binary_dilation(cls == HIGHWAY, iterations=2)
    mask = ndi.binary_closing(mask | alley, structure=np.ones((3, 3)), iterations=1) & ~median
    alley &= ~ndi.binary_dilation((cls == ROAD) | (cls == HIGHWAY) | (cls == DIRTROAD), iterations=1)
    mask = remove_small_objects(mask, 150)
    mask = remove_small_holes(mask, 60) & ~median
    np.save(os.path.join(CLS, 'road_mask.npy'), mask)
    print('mask', time.time() - t0)

    dt = ndi.distance_transform_edt(mask).astype(np.float32)
    skel = skeletonize(mask)
    print('skeleton px', int(skel.sum()), time.time() - t0)
    del mask, median
    gc.collect()

    water = (cls == WATER).astype(np.float32)
    wd_small = ndi.gaussian_filter(water, 7).astype(np.float16)
    wd_large = ndi.gaussian_filter(water, 18, output=np.float32).astype(np.float16)
    print('water density', time.time() - t0)
    del water
    gc.collect()

    # neighbour counts
    k = np.ones((3, 3), np.uint8)
    k[1, 1] = 0
    nb = ndi.convolve(skel.astype(np.uint8), k, mode='constant') * skel
    nodepx = skel & (nb != 2)
    lab, nlab = ndi.label(nodepx, structure=np.ones((3, 3)))
    print('node clusters', nlab)

    flat_skel = skel.ravel()
    flat_lab = lab.ravel()
    visited = np.zeros(H * W, bool)
    offs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    doffs = [dy * W + dx for dy, dx in offs]

    # node centroids
    cent = ndi.center_of_mass(nodepx, lab, range(1, nlab + 1))
    nodes = [(c[1], c[0]) for c in cent]  # (px, py)
    del nodepx, nb, cent
    gc.collect()

    node_pix = np.flatnonzero(flat_lab)
    edges = []

    def walk(start_node, p0, p1):
        path = [p0, p1]
        visited[p1] = True
        prev, cur = p0, p1
        while True:
            cy, cx = divmod(cur, W)
            end = -1
            nxt = -1
            for d, (dy, dx) in zip(doffs, offs):
                yy, xx = cy + dy, cx + dx
                if yy < 0 or yy >= H or xx < 0 or xx >= W:
                    continue
                q = cur + d
                if q == prev or not flat_skel[q]:
                    continue
                lq = flat_lab[q]
                if lq:
                    if lq - 1 != start_node or len(path) > 3:
                        end = q
                        break
                elif not visited[q] and nxt < 0:
                    nxt = q
            if end >= 0:
                path.append(end)
                return path, flat_lab[end] - 1
            if nxt < 0:
                return path, -1
            visited[nxt] = True
            path.append(nxt)
            prev, cur = cur, nxt

    for p in node_pix:
        ni = flat_lab[p] - 1
        py, px = divmod(p, W)
        for d, (dy, dx) in zip(doffs, offs):
            yy, xx = py + dy, px + dx
            if yy < 0 or yy >= H or xx < 0 or xx >= W:
                continue
            q = p + d
            if not flat_skel[q] or flat_lab[q] or visited[q]:
                continue
            path, end = walk(ni, p, q)
            if end < 0:
                continue
            edges.append([ni, end, path])
    # closed loops without nodes
    rem = np.flatnonzero(flat_skel & ~visited & (flat_lab == 0))
    loops = 0
    for p in rem:
        if visited[p]:
            continue
        py, px = divmod(p, W)
        nodes.append((px, py))
        ni = len(nodes) - 1
        visited[p] = True
        path = [p]
        cur, prev = p, -1
        while True:
            cy, cx = divmod(cur, W)
            nxt = -1
            for d in doffs:
                q = cur + d
                if 0 <= q < H * W and flat_skel[q] and not visited[q]:
                    nxt = q
                    break
            if nxt < 0:
                break
            visited[nxt] = True
            path.append(nxt)
            cur = nxt
        if len(path) > 10:
            path.append(p)
            edges.append([ni, ni, path])
            loops += 1
    print('edges', len(edges), 'loops', loops, time.time() - t0)

    # build adjacency, prune short spurs
    def degree_map(es):
        deg = {}
        for a, b, _ in es:
            deg[a] = deg.get(a, 0) + 1
            deg[b] = deg.get(b, 0) + 1
        return deg

    for it in range(3):
        deg = degree_map(edges)
        keep = []
        for e in edges:
            a, b, path = e
            ln = len(path)
            if (deg[a] == 1 or deg[b] == 1) and a != b and ln < 14 and not (deg[a] == 1 and deg[b] == 1 and ln > 6):
                continue
            keep.append(e)
        edges = keep
    # drop isolated tiny edges
    edges = [e for e in edges if len(e[2]) >= 6]

    # merge chains through degree-2 nodes
    while True:
        inc = {}
        for i, (a, b, _) in enumerate(edges):
            inc.setdefault(a, []).append(i)
            inc.setdefault(b, []).append(i)
        touched = set()
        dead = set()
        merged = 0
        for n, lst in inc.items():
            if len(lst) != 2:
                continue
            i, j = lst
            if i == j or i in touched or j in touched:
                continue
            ea, eb = edges[i], edges[j]
            if ea[0] == ea[1] or eb[0] == eb[1]:
                continue
            pa = ea[2] if ea[1] == n else ea[2][::-1]
            oa = ea[0] if ea[1] == n else ea[1]
            pb = eb[2] if eb[0] == n else eb[2][::-1]
            ob = eb[1] if eb[0] == n else eb[0]
            edges[i] = [oa, ob, pa + pb[1:]]
            dead.add(j)
            touched.update((i, j))
            merged += 1
        edges = [e for k2, e in enumerate(edges) if k2 not in dead]
        if not merged:
            break
    print('edges after prune/merge', len(edges), time.time() - t0)
    del visited, flat_skel, flat_lab, lab, node_pix, rem
    gc.collect()

    flat_cls = cls.ravel()
    flat_alley = alley.ravel()
    flat_dt = dt.ravel()
    flat_ws = wd_small.ravel()
    flat_wl = wd_large.ravel()
    used_nodes = {}
    out_nodes = []
    out_edges = []
    bridge_mask = np.zeros((H, W), bool)

    def node_id(n):
        if n not in used_nodes:
            used_nodes[n] = len(out_nodes)
            x, z = px2w(*nodes[n])
            out_nodes.append([round(x, 1), round(z, 1)])
        return used_nodes[n]

    for a, b, path in edges:
        path = np.array(path)
        ys, xs = np.divmod(path, W)
        c = flat_cls[path]
        nh = int((c == HIGHWAY).sum())
        nr = int((c == ROAD).sum())
        nd = int((c == DIRTROAD).sum())
        na = int(flat_alley[path].sum())
        is_alley = na > 0.5 * len(path)
        if is_alley:
            nr += na
        kind = 'highway' if nh >= max(nr, nd) else ('dirt' if nd > nr else 'road')
        hw = flat_dt[path]
        half = float(np.median(hw)) * MPP
        width = max(4.0, min(half * 2.0, 44.0))
        if kind == 'road':
            width = min(max(width, 6.5), 22)
        if kind == 'dirt':
            width = min(max(width, 4.5), 9)
        if is_alley and kind == 'road':
            width = min(max(width, 4.5), 7.0)
        # bridge flags per pixel along path
        wd = np.where(width > 18, flat_wl[path], flat_ws[path])
        isb = wd > (0.55 if width <= 18 else 0.5)
        # require runs >= 12 px
        runs = []
        i = 0
        L = len(isb)
        while i < L:
            if isb[i]:
                j = i
                while j < L and isb[j]:
                    j += 1
                if j - i >= 12:
                    runs.append((i, j))
                i = j
            else:
                i += 1
        isb2 = np.zeros(L, bool)
        for s, e in runs:
            isb2[max(0, s - 3):min(L, e + 3)] = True
        if isb2.any():
            rad = int(width / MPP / 2 + 2)
            for (py, px) in zip(ys[isb2], xs[isb2]):
                bridge_mask[max(0, py - rad):py + rad + 1, max(0, px - rad):px + rad + 1] = True
        pts = np.stack([xs, ys], 1).astype(np.float64)
        # smooth the pixel skeleton (removes staircase/zig-zag) with pinned endpoints
        if L >= 8:
            sig = min(6.0, max(1.5, L / 10.0))
            sm = np.stack([ndi.gaussian_filter1d(pts[:, 0], sig, mode='nearest'),
                           ndi.gaussian_filter1d(pts[:, 1], sig, mode='nearest')], 1)
            # blend back to the true endpoints over ~2 sigma so junctions stay connected
            k = np.arange(L, dtype=np.float64)
            w = np.minimum(1.0, np.minimum(k, L - 1 - k) / (2.0 * sig))
            w = w * w * (3 - 2 * w)
            pts = pts * (1 - w[:, None]) + sm * w[:, None]
        # keep bridge breakpoints by splitting simplification at run boundaries
        cuts = [0]
        for k2 in range(1, L):
            if isb2[k2] != isb2[k2 - 1]:
                cuts.append(k2)
        cuts.append(L - 1)
        simp = []
        flags = []
        for s, e in zip(cuts[:-1], cuts[1:]):
            seg = rdp(pts[s:e + 1], 0.3)
            fl = bool(isb2[min(e, s + 1)]) if e > s else bool(isb2[s])
            for q in (seg if not simp else seg[1:]):
                simp.append(q)
                flags.append(fl)
        simp = np.array(simp)
        wpts = [[round(px2w(p[0], p[1])[0], 1), round(px2w(p[0], p[1])[1], 1)] for p in simp]
        ia, ib = node_id(a), node_id(b)
        e = {'a': ia, 'b': ib, 'k': kind, 'w': round(width, 1), 'p': wpts}
        if is_alley and kind == 'road':
            e['al'] = 1
        if any(flags):
            e['br'] = [1 if f else 0 for f in flags]
        out_edges.append(e)

    total = 0
    for e in out_edges:
        p = np.array(e['p'])
        total += np.hypot(*np.diff(p, axis=0).T).sum()
    print('nodes', len(out_nodes), 'edges', len(out_edges), 'length km %.1f' % (total / 1000),
          'bridged edges', sum(1 for e in out_edges if 'br' in e), time.time() - t0)
    json.dump({'nodes': out_nodes, 'edges': out_edges}, open(os.path.join(CLS, 'roads.json'), 'w'))
    np.save(os.path.join(CLS, 'bridge_mask.npy'), bridge_mask)


if __name__ == '__main__':
    main()
