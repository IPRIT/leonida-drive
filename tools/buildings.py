"""Extract building footprints (polygons in world metres) with heuristic heights + procedural infill.

Input : raw/mosaic_nc_z5.png, raw/cls/cls.npy, raw/cls/road_mask.npy, raw/cls/alley.npy (optional),
        raw/data/landmarks.json   (LEONIDA_CLS=<dir> reads / writes the cls directory elsewhere)
Output: raw/cls/buildings.json  [{p:[[x,z],...], h, k(kind), s(style), f(floors), g(procedural)}]
Styles: 0 generic stucco, 1 art-deco pastel, 2 glass tower, 3 house (pitched roof), 4 industrial, 5 concrete tower
"""
import json
import math
import os
import time
import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')
CLS = os.environ.get('LEONIDA_CLS') or os.path.join(RAW, 'cls')
MPP, X0, Z0 = 2.0, -11368.0, -11000.0

# (x, z, radius m, max height m, style) - high-rise cores derived from landmark district centroids
ZONES = [
    (-886, 1112, 650, 230, 2),    # Tequesta (Brickell analogue)
    (-660, 102, 700, 200, 2),     # Downtown
    (-356, -1052, 520, 170, 5),   # Bayside (Edgewater analogue)
    (-640, -1154, 420, 90, 5),    # Crosstown
    (1702, -2183, 700, 150, 5),   # Washington Beach (beach condos)
    (1742, -699, 900, 30, 1),     # Ocean Beach (art deco, few hotel towers)
    (494, -1252, 350, 45, 1),     # Rialto Islands
    (-6564, -3671, 600, 55, 5),   # Port Gellhorn centre
]
ARTDECO = (1742, -699, 1500)


def hash01(*v):
    h = 2166136261
    for x in v:
        h = ((h ^ (int(x) & 0xffffffff)) * 16777619) & 0xffffffff
    h ^= h >> 13
    h = (h * 1274126177) & 0xffffffff
    return (h & 0xffffff) / float(0xffffff)


def zone_at(x, z):
    best = (0.0, 0.0, 0)
    for zx, zz, rad, hmax, st in ZONES:
        d = math.hypot(x - zx, z - zz)
        f = max(0.0, 1.0 - d / rad)
        f = f * f * (3 - 2 * f)
        if f * hmax > best[0] * max(best[1], 1):
            best = (f, hmax, st)
    return best


def is_artdeco(x, z):
    return math.hypot(x - ARTDECO[0], z - ARTDECO[1]) < ARTDECO[2] and x > 1100


def to_world(poly):
    return [[round(p[0] * MPP + X0, 1), round(p[1] * MPP + Z0, 1)] for p in poly]


def assign(o, x, z, area_m, d, db, hr, hp, names, tags):
    zf, zmax, zst = zone_at(x, z)
    joined = ' '.join(names).lower()
    if area_m < 170 and d < 0.25 and zf < 0.2:
        storeys, kind, style = 1 + (hp > 0.65), 'house', 3
    elif area_m < 420:
        storeys, kind, style = 1 + int(hr * 2) + int(d * 7), 'small', 0
    else:
        base = 2 + d * 12 + db * 8
        if area_m > 6000:
            base *= 0.5
        storeys, kind, style = int(base * (0.6 + hr * 0.9)), 'block', 0
    if zf > 0.05 and area_m > 250 and kind != 'house':
        tall = zmax * zf * (0.25 + 0.75 * hr ** 0.8)
        storeys = max(storeys, int(tall / 3.6))
        if storeys > 10:
            kind, style = 'tower', zst
    if any(k in joined for k in ('condo', 'tower', 'residences', 'apartments', 'hotel', 'resort', 'plaza', 'bank', 'office')):
        storeys = max(storeys, int(6 + hr * 22 * (0.5 + zf)))
        if storeys > 12:
            kind = 'tower'
            style = style if style in (2, 5) else 5
    if 'industrial' in tags or 'utilities' in tags or 'transportation' in tags:
        storeys, kind, style = min(max(storeys, 2), 4), 'industrial', 4
    if area_m > 12000 and kind != 'tower':
        storeys, kind, style = min(storeys, 4), 'hall', 4
    if is_artdeco(x, z) and kind in ('small', 'block') and storeys <= 8:
        style = 1
        storeys = max(2, min(storeys, 5))
    storeys = max(1, min(int(storeys * (0.85 + 0.3 * hp)), 72))
    floor_h = 3.1 if kind in ('house', 'small') else 3.6
    h = storeys * floor_h + (0.4 if kind == 'house' else 0.8)
    if kind in ('industrial', 'hall'):
        h = 7 + hr * 9
    o.update({'h': round(h, 1), 'k': kind, 's': style, 'f': storeys})
    return o


def footprints(parts, bld, cls):
    """Footprints from the source outlines (label image, one id per footprint).

    The map draws a building as a 176-grey (or blue) fill inside a ~155-grey outline; roof detail (stadium roof
    sections, mall skylights, terminal piers) uses the same grey lines inside one building, and buildings that
    touch share an outline. `parts` are the fills between lines. Per connected building blob (fill + lines):
      - vehicles drawn in building grey (blimp, ships, parked aircraft: a blob standing on pad / apron / water
        greys all round) are dropped;
      - slivers between double roof lines (thin or tiny parts) are not footprints;
      - one footprint when the lines are roof detail: the parts are mostly slices (elongated parts cutting the
        blob), or the blob is a large round / convex shape (stadium, arena, dome) cut into pieces;
      - otherwise each part grows over the outline pixels nearest to it, so footprints keep the drawn size
        (fills alone are one outline pixel = 2 m short on every side).
    """
    H, W = bld.shape
    blob, nb = ndi.label(bld, structure=np.ones((3, 3)))
    out = np.zeros((H, W), np.int32)
    nid = 0
    padlike = np.isin(cls, [1, 9, 19])  # water, paved, apron
    stats = {'vehicle': 0, 'merged': 0, 'parts': 0}
    for bi, sl in enumerate(ndi.find_objects(blob)):
        if sl is None:
            continue
        y0, y1 = max(0, sl[0].start - 4), min(H, sl[0].stop + 4)
        x0, x1 = max(0, sl[1].start - 4), min(W, sl[1].stop + 4)
        bm = blob[y0:y1, x0:x1] == bi + 1
        area = int(bm.sum())
        if area < 6:
            continue
        ring = ndi.binary_dilation(bm, iterations=4) & ~ndi.binary_dilation(bm, iterations=1)
        rn = int(ring.sum())
        if area < 1000 and rn:
            rw = (cls[y0:y1, x0:x1][ring] == 1).sum() / rn
            rp = padlike[y0:y1, x0:x1][ring].sum() / rn
            vehicle = rw > 0.7  # piers, ships
            if not vehicle and rp > 0.7:
                # on a pad / apron: aircraft and blimps are not boxes (a kiosk on a lot is)
                cs, _ = cv2.findContours(bm.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
                (_, _), (rw_, rh_), _ = cv2.minAreaRect(max(cs, key=cv2.contourArea))
                vehicle = area < 0.8 * (rw_ + 1) * (rh_ + 1)
            if vehicle:
                stats['vehicle'] += 1
                if os.environ.get('BUILDINGS_DEBUG'):
                    stats.setdefault('vlist', []).append(((y0 + y1) // 2, (x0 + x1) // 2))
                continue
        pl = np.where(bm, parts[y0:y1, x0:x1], 0)
        ids = [int(i) for i in np.unique(pl) if i]
        seeds = []
        edt = None
        for i in ids:
            m = pl == i
            a = int(m.sum())
            if a < 8:
                continue
            if edt is None:
                edt = ndi.distance_transform_edt(pl > 0)
            if edt[m].max() < 1.5:  # 1-2 px strip between two roof lines
                continue
            seeds.append((i, m, a))
        if not seeds and area >= 40 and ndi.distance_transform_edt(bm).max() >= 3:
            # all roof lines, no fill (stepped tower tops, domes drawn as rings): the blob is the footprint
            seeds = [(0, bm, area)]
        if not seeds:
            # a small building (fill only 1-2 px wide inside its outline): its largest fill is the seed;
            # lines only (unfilled frames, rail edges) make no footprint
            big = max(((i, pl == i) for i in ids), key=lambda t: int(t[1].sum()), default=None)
            if big is None or int(big[1].sum()) < 3:
                continue
            seeds = [(big[0], big[1], int(big[1].sum()))]
        merge = len(seeds) == 1
        if not merge and area >= 300:
            cs, _ = cv2.findContours(bm.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            c = max(cs, key=cv2.contourArea)
            hull = cv2.contourArea(cv2.convexHull(c))
            solidity = area / max(hull, 1.0)
            (_, _), (bw, bh), _ = cv2.minAreaRect(c)
            blong = max(bw, bh)
            slice_a = 0
            rect = []
            for i, m, a in seeds:
                ys, xs = np.nonzero(m)
                (_, _), (w, h), _ = cv2.minAreaRect(np.stack([xs, ys], 1).astype(np.float32))
                lo, hi = min(w, h) + 1, max(w, h) + 1
                rect.append(a / (lo * hi))
                if hi >= 2.2 * lo and hi >= 0.55 * blong:
                    slice_a += a
            seed_a = sum(a for _, _, a in seeds)
            approx = cv2.approxPolyDP(c, 1.5, True)
            curved = len(approx) >= 14 and solidity >= 0.8 and area >= 600
            # many pieces, each small, in one compact big blob: roof sections (stadium stands, terminal piers,
            # mall skylights). A block of a few touching buildings has fewer, bigger pieces.
            many = (area >= 1500 and len(seeds) >= 10 and np.median([a for _, _, a in seeds]) < 0.08 * area
                    and (solidity >= 0.6 or len(seeds) >= 30))
            why = ('slices' if slice_a >= 0.5 * seed_a and solidity >= 0.8 and len(seeds) >= 2 else
                   'curved' if curved and solidity >= 0.9 else 'many' if many else '')
            if why:
                merge = True
                if os.environ.get('BUILDINGS_DEBUG'):
                    stats.setdefault('mlist', []).append([(x0 + x1) * MPP / 2 + X0, (y0 + y1) * MPP / 2 + Z0, area * 4, len(seeds), why,
                                                          round(solidity, 2), round(float(np.mean(rect)), 2)])
        if merge:
            nid += 1
            out[y0:y1, x0:x1][bm] = nid
            stats['merged' if len(seeds) > 1 else 'parts'] += 1
            continue
        lab_s = np.zeros(bm.shape, np.int32)
        for i, m, a in seeds:
            nid += 1
            lab_s[m] = nid
        idx = ndi.distance_transform_edt(lab_s == 0, return_distances=False, return_indices=True)
        grown = lab_s[idx[0], idx[1]]
        out[y0:y1, x0:x1][bm] = grown[bm]
        stats['parts'] += len(seeds)
    if os.environ.get('BUILDINGS_DEBUG'):
        json.dump(stats.get('vlist', []), open(os.path.join(CLS, 'dbg_vehicles.json'), 'w'))
        json.dump(stats.get('mlist', []), open(os.path.join(CLS, 'dbg_merged.json'), 'w'))
    print('footprints: %d blobs, %d merged (roof lines), %d vehicles dropped' % (nb, stats['merged'], stats['vehicle']))
    return out


def main():
    t0 = time.time()
    a = np.asarray(Image.open(os.path.join(RAW, 'mosaic_nc_z5.png')).convert('RGB')).astype(np.int16)
    cls = np.load(os.path.join(CLS, 'cls.npy'))
    road = np.load(os.path.join(CLS, 'road_mask.npy'))
    H, W = cls.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    spread = np.maximum(np.maximum(np.abs(r - g), np.abs(g - b)), np.abs(r - b))
    lum = (r + g + b) // 3
    bld_any = (cls == 10) | (cls == 11)
    L = np.where(bld_any, lum, 0).astype(np.int16)
    M = ndi.maximum_filter(L, size=5)
    blue = (np.abs(r - 160) <= 8) & (np.abs(g - 179) <= 8) & (np.abs(b - 205) <= 8)
    fill = (bld_any & (L >= M - 7) & (spread <= 4)) | (bld_any & blue)
    # speculative buildings: closed light-red outlines
    redline = (r > 180) & (g > 60) & (g < 150) & (b > 60) & (b < 150) & (np.abs(g - b) < 18)
    red_int = ndi.binary_fill_holes(redline) & ~redline
    red_int = ndi.binary_opening(red_int, iterations=1) & ~road
    fill |= red_int
    del a, r, g, b, lum, spread, L, M
    fill = ndi.binary_opening(fill, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], bool))
    lab, n = ndi.label(fill)
    print('parts', n, time.time() - t0)
    lab = footprints(lab, bld_any | red_int, cls)
    print('footprints', int(lab.max()), time.time() - t0)
    clab, cn = ndi.label(ndi.binary_closing(bld_any | red_int, iterations=1))

    bmask_small = (bld_any | red_int).astype(np.float32)[::4, ::4]
    dens = ndi.uniform_filter(bmask_small, size=45)
    dens_big = ndi.uniform_filter(bmask_small, size=90)

    lm = json.load(open(os.path.join(RAW, 'data', 'landmarks.json')))
    lm_grid = {}
    for v in lm.values():
        if not v[1] or len(v[1]) < 2:
            continue
        x, z = v[1][0], -v[1][1]
        px, py = int((x - X0) / MPP), int((z - Z0) / MPP)
        if 0 <= px < W and 0 <= py < H:
            lm_grid.setdefault((py // 16, px // 16), []).append((px, py, v[6] or [], v[3] or ''))

    out = []
    occ = np.zeros((H, W), np.uint8)
    for i, sl in enumerate(ndi.find_objects(lab)):
        if sl is None:
            continue
        sub = lab[sl] == (i + 1)
        area_px = int(sub.sum())
        if area_px < 6:
            continue
        # footprints cover their outline pixels now: trace at 2x so the ring sits on the pixel edges (+-0.25 px)
        pad = np.pad(sub, 1).astype(np.uint8).repeat(2, 0).repeat(2, 1)
        cs, _ = cv2.findContours(pad, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs:
            continue
        c = max(cs, key=cv2.contourArea)
        poly = cv2.approxPolyDP(c, 1.8 if area_px < 400 else 2.6, True)[:, 0, :].astype(np.float64)
        if len(poly) > 40:
            poly = cv2.approxPolyDP(c, 4.0, True)[:, 0, :].astype(np.float64)
        if len(poly) < 3:
            continue
        poly = (poly + 0.5) / 2.0 - 1.0
        poly[:, 0] += sl[1].start
        poly[:, 1] += sl[0].start
        area_m = cv2.contourArea(poly.astype(np.float32)) * MPP * MPP
        if area_m < 20:
            continue
        cv2.fillPoly(occ, [poly.astype(np.int32)], 1)
        cy, cx = (sl[0].start + sl[0].stop) // 2, (sl[1].start + sl[1].stop) // 2
        comp = int(clab[cy, cx])
        d = float(dens[min(cy // 4, dens.shape[0] - 1), min(cx // 4, dens.shape[1] - 1)])
        db = float(dens_big[min(cy // 4, dens_big.shape[0] - 1), min(cx // 4, dens_big.shape[1] - 1)])
        tags, names = [], []
        for gy in range(sl[0].start // 16, sl[0].stop // 16 + 1):
            for gx in range(sl[1].start // 16, sl[1].stop // 16 + 1):
                for (px, py, tg, nm) in lm_grid.get((gy, gx), []):
                    if sl[0].start <= py < sl[0].stop and sl[1].start <= px < sl[1].stop and sub[py - sl[0].start, px - sl[1].start]:
                        tags += tg
                        names.append(nm)
        wx, wz = cx * MPP + X0, cy * MPP + Z0
        o = {'p': to_world(poly)}
        if blue[cy, cx]:
            o['i'] = 1
        if names:
            o['n'] = names[0].split(',')[0][:48]
        out.append(assign(o, wx, wz, area_m, d, db, hash01(comp, 7), hash01(i, 13), names, tags))
    n_real = len(out)
    print('mapped buildings', n_real, time.time() - t0)

    # ---------- procedural infill in empty urban blocks ----------
    urban = (cls == 8)
    ap = os.path.join(CLS, 'alley.npy')
    if os.path.exists(ap):
        road = road | ndi.binary_dilation(np.load(ap), iterations=1)
    road_d = ndi.distance_transform_edt(~road, return_indices=True)
    rdist, (riy, rix) = road_d[0], road_d[1]
    cand = urban & (rdist > 4) & ~ndi.binary_dilation(occ.astype(bool) | (cls == 10) | (cls == 11), iterations=3)
    cand = ndi.binary_erosion(cand, iterations=1)
    # the grounds of big single structures (stadiums, malls, terminals, halls) are plazas and parking on the
    # source map: no invented lots within 70 m of a footprint over 8000 m2
    bigl, bn = ndi.label(lab > 0)
    if bn:
        bs = ndi.sum(lab > 0, bigl, np.arange(1, bn + 1))
        keepb = np.zeros(bn + 1, bool)
        keepb[1:] = bs * MPP * MPP >= 8000
        big = keepb[bigl]
        if big.any():
            cand &= ndi.distance_transform_edt(~big) > 35
    print('infill candidate km2 %.2f' % (cand.sum() * MPP * MPP / 1e6), time.time() - t0)
    rng = np.random.default_rng(42)
    gen = 0
    # sampling grid (in px); spacing depends on zone/density
    step = 9  # 18 m
    passes = []
    for scale, stp in ((1.0, 9), (0.8, 7), (0.62, 6), (0.5, 5)):
        ys, xs = np.nonzero(cand[::stp, ::stp])
        for k in rng.permutation(len(ys)):
            passes.append((scale, ys[k] * stp + int(rng.integers(0, stp)), xs[k] * stp + int(rng.integers(0, stp))))
    for scale, py, px in passes:
        if py >= H or px >= W or not cand[py, px] or occ[py, px]:
            continue
        wx, wz = px * MPP + X0, py * MPP + Z0
        zf, zmax, zst = zone_at(wx, wz)
        d = float(dens[min(py // 4, dens.shape[0] - 1), min(px // 4, dens.shape[1] - 1)])
        # orientation from nearest road
        vy, vx = py - riy[py, px], px - rix[py, px]
        ang = math.atan2(vy, vx) if (vx or vy) else 0.0
        dist_road = rdist[py, px]
        if zf > 0.25 or d > 0.3:
            w, dpt = rng.uniform(16, 34), rng.uniform(18, 36)
        elif d > 0.12:
            w, dpt = rng.uniform(11, 22), rng.uniform(12, 24)
        else:
            w, dpt = rng.uniform(8.5, 13), rng.uniform(10, 15)
        w, dpt = max(7.0, w * scale), max(8.0, dpt * scale)
        # keep the front facing the road at a setback
        w_px, d_px = w / MPP, dpt / MPP
        ca, sa = math.cos(ang), math.sin(ang)
        # local axes: u = towards road normal (depth), v = along road (width)
        corners = []
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            u, v = su * d_px / 2, sv * w_px / 2
            corners.append((px + u * ca - v * sa, py + u * sa + v * ca))
        cp = np.array(corners)
        if cp[:, 0].min() < 0 or cp[:, 1].min() < 0 or cp[:, 0].max() >= W - 1 or cp[:, 1].max() >= H - 1:
            continue
        # validate: corners + edge midpoints + centre inside candidate and free
        ok = True
        test = list(corners) + [((corners[i][0] + corners[(i + 1) % 4][0]) / 2, (corners[i][1] + corners[(i + 1) % 4][1]) / 2) for i in range(4)]
        for (qx, qy) in test:
            ix, iy = int(qx), int(qy)
            if not cand[iy, ix] or occ[iy, ix]:
                ok = False
                break
        if not ok:
            continue
        poly = cp
        cv2.fillPoly(occ, [np.round(poly).astype(np.int32)], 1)
        # reserve a small gap around it
        cv2.polylines(occ, [np.round(poly).astype(np.int32)], True, 1, 3)
        area_m = w * dpt
        hr, hp = hash01(px, py), hash01(py, px, 3)
        o = {'p': to_world(poly), 'g': 1}
        out.append(assign(o, wx, wz, area_m, d, d, hr, hp, [], []))
        gen += 1
    print('procedural', gen, 'total', len(out), time.time() - t0)
    hs = np.array([o['h'] for o in out])
    print('height pct', np.percentile(hs, [10, 50, 90, 99, 99.9]).round(1), 'max', hs.max())
    styles = np.bincount([o['s'] for o in out])
    print('styles', styles)
    json.dump(out, open(os.path.join(CLS, 'buildings.json'), 'w'), separators=(',', ':'))
    np.save(os.path.join(CLS, 'bld_occ.npy'), occ.astype(bool))


if __name__ == '__main__':
    main()
