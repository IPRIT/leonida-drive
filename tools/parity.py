"""Parity diff: our roads / buildings against the source map (YANIS v17 raster, 2 m/px).

The source "truth" masks are read straight off the mosaic colours (legend classes), independently of
tools/classify.py:
  roads      road grey (83), highway grey (114), alley / service grey (~155, thin lines not touching a building
             fill), dirt road brown, speculative (red) roads
  buildings  building fill (176 grey, confirmed-interior blue) plus the outline pixels attached to it, speculative
             red-outlined footprints; vehicles drawn on pads / at sea (blimp, ships, parked aircraft) are dropped
  dontcare   label glyphs, route shields, rail and metro lines, the map grid (nothing can be said under them)

Ours: roads.json centrelines with widths (public format: flat 'p'; raw/cls format: list of pairs) and
buildings.json footprints, rasterised at the source resolution.

Metrics
  missing road   source road skeleton farther than w/2 + 4 m from any of our ribbons (km)
  extra road     our centreline farther than 6 m from any source road paint (km)
  breaks         missing skeleton pieces with both ends on our roads (fragmented roads), with the share that
                 lies under labels / shields / rails
  buildings      missing / extra footprint area, global IoU; per source blob: pieces, IoU, strip fragmentation
                 (>= 3 thin strips cutting one large footprint), merges (one footprint over separate blobs);
                 procedural infill standing on source roads / alleys / pads (phantom lots)

Run:  .venv/bin/python tools/parity.py --data public/data --out <dir> [--spots <report.json of a previous run>]
"""
import argparse
import json
import math
import os
import time

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage.morphology import skeletonize

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')
MPP, X0, Z0 = 2.0, -11368.0, -11000.0
CACHE = os.environ.get('PARITY_CACHE', '/tmp/ld-parity/truth_cache.npz')
# named checks (game x, z): user reports
NAMED = {
    'fleeca-field (L196)': (-1605, -1038),
    'blimp-base (L274)': (-4432, 6827),
    'vcia-terminal': (-2290, 760),
}


def w2p(x, z):
    return (x - X0) / MPP, (z - Z0) / MPP


def p2w(px, py):
    return px * MPP + X0, py * MPP + Z0


# ------------------------------------------------------------------------------------------------ source truth
def source_truth():
    src = os.path.join(RAW, 'mosaic_nc_z5.png')
    key = os.path.getmtime(src)
    if os.path.exists(CACHE):
        z = np.load(CACHE)
        if float(z['key']) == key:
            shape = tuple(z['shape'])
            unp = lambda n: np.unpackbits(z[n])[:shape[0] * shape[1]].reshape(shape).astype(bool)
            return {n: unp(n) for n in ('road', 'skel', 'bld', 'dontcare', 'pad', 'water')}
    t0 = time.time()
    a = np.asarray(Image.open(src).convert('RGB')).copy()
    H, W, _ = a.shape
    dc = np.zeros((H, W), bool)
    dc[:, :192] = True
    dc[9300:9700, 5650:7400] = True
    for x in range(183, W, 500):
        if x + 2 < W:
            a[:, x] = a[:, x - 1]
            a[:, x + 1] = a[:, x + 2]
    for y in range(499, H, 500):
        if y + 2 < H:
            a[y] = a[y - 1]
            a[y + 1] = a[y + 2]
    r, g, b = (a[..., i].astype(np.int32) for i in range(3))
    del a
    spread = np.maximum(np.maximum(np.abs(r - g), np.abs(g - b)), np.abs(r - b))
    lum = (r + g + b) // 3
    gray = spread <= 6

    def near(c, tol):
        return (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2 <= tol * tol

    white = (lum >= 236) & (spread <= 14)
    shield = (b - r > 60) & (r < 70) & (g < 115) & (b < 160)
    shield |= near((100, 46, 20), 25)
    darktxt = gray & (lum < 60)
    metro = (r > 235) & (g > 215) & (b > 140) & (b < 205) & (r - b > 40)
    metro |= (r > 235) & (g > 150) & (g < 195) & (b > 115) & (b < 165)
    dc |= ndi.binary_dilation(white | shield | metro, iterations=3) | ndi.binary_dilation(darktxt, iterations=2)
    t = np.clip((g - 100) / 76.0, -0.4, 1.4)
    water = (np.abs(r - (44 + 12 * t)) <= 9) & (np.abs(b - (164 + 60 * t)) <= 12) & (g >= 70) & (g < 210)

    fill = (gray & (lum >= 170) & (lum <= 179)) | near((160, 179, 205), 14)
    line = gray & (lum >= 129) & (lum <= 167)
    nf = ndi.binary_dilation(fill, iterations=2)
    pad = gray & (lum >= 180) & (lum <= 212) & ~fill  # apron / paved pad greys

    # alleys: thin service-grey lines away from building fills, not on aprons (taxiway paint) or at sea (ships)
    al = line & ~nf
    lab, n = ndi.label(al, structure=np.ones((3, 3)))
    if n:
        idx = np.arange(1, n + 1)
        size = ndi.sum(al, lab, idx)
        edt = ndi.distance_transform_edt(al)
        thick = ndi.maximum(edt, lab, idx)
        ring = ndi.binary_dilation(al, iterations=3) & ~al
        # map ring pixels to the alley component they surround via the nearest alley pixel
        _, (iy, ix) = ndi.distance_transform_edt(~al, return_indices=True)
        owner = lab[iy, ix]
        rn = ndi.sum(ring, owner, idx)
        rpad = ndi.sum(ring & (pad | water), owner, idx)
        ok = (size >= 16) & (thick <= 3.5) & (rpad < 0.6 * np.maximum(rn, 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = ok
        al = keep[lab]
        del edt, owner, iy, ix, ring
    dark_road = gray & (lum >= 62) & (lum <= 100)
    hwy = gray & (lum > 100) & (lum <= 128)
    dirt = near((177, 140, 80), 24)
    spec = near((159, 84, 74), 18) | near((178, 87, 89), 18) | near((200, 101, 100), 18)
    road = dark_road | hwy | al | dirt | spec
    road = ndi.binary_closing(road, structure=np.ones((3, 3)))
    lab, n = ndi.label(road, structure=np.ones((3, 3)))
    size = ndi.sum(road, lab, np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = size >= 40
    road = keep[lab]
    skel = skeletonize(road)

    redline = (r > 180) & (g > 60) & (g < 150) & (b > 60) & (b < 150) & (np.abs(g - b) < 18)
    red_int = ndi.binary_fill_holes(redline) & ~redline
    # outline pixels of any colour (grey, blue-roof rims, red speculative outlines) hugging a fill; icons printed
    # on a building (enterable / POI badges) are holes the building owns
    bgish = (gray & ((lum >= 205) | (lum < 129))) | water | ((g - r > 15) & (g - b > 30))
    bld = fill | (line & nf) | red_int | (ndi.binary_dilation(fill, iterations=1) & ~bgish)
    holes = ndi.binary_fill_holes(bld) & ~bld
    hl, hn = ndi.label(holes)
    if hn:
        hs = ndi.sum(holes, hl, np.arange(1, hn + 1))
        k = np.zeros(hn + 1, bool)
        k[1:] = hs <= 60
        bld |= k[hl]
    lab, n = ndi.label(bld, structure=np.ones((3, 3)))
    if n:
        idx = np.arange(1, n + 1)
        size = ndi.sum(bld, lab, idx)
        ringm = ndi.binary_dilation(bld, iterations=4) & ~ndi.binary_dilation(bld, iterations=1)
        _, (iy, ix) = ndi.distance_transform_edt(~bld, return_indices=True)
        owner = np.where(ringm, lab[iy, ix], 0)
        del iy, ix
        rn = ndi.sum(ringm, owner, idx)
        rv = ndi.sum(ringm & (pad | water), owner, idx)
        vehicle = (rv > 0.85 * np.maximum(rn, 1)) & (size < 4000)
        keep = np.zeros(n + 1, bool)
        keep[1:] = (size >= 8) & ~vehicle
        bld = keep[lab]
        print('truth: %d building blobs, %d vehicle-like dropped' % (int(keep.sum()), int(vehicle.sum())))
    out = {'road': road, 'skel': skel, 'bld': bld, 'dontcare': dc, 'pad': pad, 'water': water}
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    np.savez(CACHE, key=key, shape=np.array([H, W]), **{k: np.packbits(v.ravel()) for k, v in out.items()})
    print('source truth %.0fs' % (time.time() - t0))
    return out


# ------------------------------------------------------------------------------------------------ ours
def load_ours(data):
    rd = json.load(open(os.path.join(data, 'roads.json')))
    bl = json.load(open(os.path.join(data, 'buildings.json')))
    edges = []
    for e in rd['edges']:
        p = np.array(e['p'], np.float64).reshape(-1, 2)
        edges.append((p, float(e.get('w', 8.0)), e.get('k', 'road')))
    blds = []
    for b in bl:
        p = np.array(b['p'], np.float64).reshape(-1, 2)
        blds.append((p, bool(b.get('g')), b))
    return edges, blds


def raster_ours(edges, blds, H, W):
    cov = np.zeros((H, W), np.uint8)
    cl = np.zeros((H, W), np.uint8)
    for p, w, k in edges:
        q = np.round(np.stack(w2p(p[:, 0], p[:, 1]), 1) * 4 - 2).astype(np.int32)
        cv2.polylines(cov, [q], False, 1, max(1, int(round((w / 2 + 4.0) * 2 / MPP))), shift=2)
        cv2.polylines(cl, [q], False, 1, 1, shift=2)
    ids = np.zeros((H, W), np.int32)
    proc = np.zeros((H, W), np.uint8)
    for i, (p, g, _) in enumerate(blds):
        q = np.round(np.stack(w2p(p[:, 0], p[:, 1]), 1) * 4 - 2).astype(np.int32)
        if g:
            cv2.fillPoly(proc, [q], 1, shift=2)
        else:
            cv2.fillPoly(ids, [q], i + 1, shift=2)
    return cov.astype(bool), cl.astype(bool), ids, proc.astype(bool)


def piece_shape(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) < 3:
        return 0.0, 0.0
    (_, _), (w, h), _ = cv2.minAreaRect(np.stack([xs, ys], 1).astype(np.float32))
    return min(w, h) * MPP + MPP, max(w, h) * MPP + MPP


# ------------------------------------------------------------------------------------------------ diff
def diff(truth, data):
    t0 = time.time()
    road, skel, bld, dc = truth['road'], truth['skel'], truth['bld'], truth['dontcare']
    H, W = road.shape
    edges, blds = load_ours(data)
    cov, cl, ids, proc = raster_ours(edges, blds, H, W)
    ours_b = ids > 0
    skel_ok = skel & ~dc
    missing = skel_ok & ~cov
    near_road = ndi.binary_dilation(road | dc, iterations=3)
    extra = cl & ~near_road

    # breaks: missing pieces whose both ends touch our coverage
    lab, n = ndi.label(missing, structure=np.ones((3, 3)))
    idx = np.arange(1, n + 1)
    sizes = ndi.sum(missing, lab, idx)
    touch = ndi.binary_dilation(cov, iterations=2) & skel
    # count distinct contact clusters per piece
    contact = ndi.binary_dilation(missing, structure=np.ones((3, 3))) & touch & ~missing
    cl_lab, _ = ndi.label(contact, structure=np.ones((3, 3)))
    ncontact = np.zeros(n + 1, np.int32)
    if n:
        own = ndi.maximum_filter(lab, size=3)
        pairs = np.unique(np.stack([own[contact], cl_lab[contact]], 1), axis=0)
        np.add.at(ncontact, pairs[:, 0], 1)
    # share of each missing piece next to labels / shields / rails (cause attribution)
    dcn = ndi.binary_dilation(dc, iterations=4)
    under = ndi.sum(missing & dcn, lab, idx) if n else np.zeros(0)
    breaks = []
    for i in range(n):
        if sizes[i] >= 4 and ncontact[i + 1] >= 2:
            breaks.append(i + 1)
    br_mask = np.isin(lab, breaks) if breaks else np.zeros_like(missing)
    br_len = float(br_mask.sum()) * MPP
    br_under = float((br_mask & dcn).sum()) * MPP

    # buildings
    blab, bn = ndi.label(bld, structure=np.ones((3, 3)))
    bidx = np.arange(1, bn + 1)
    barea = ndi.sum(bld, blab, bidx) * MPP * MPP
    inter = bld & ours_b
    miss_b = bld & ~ours_b & ~proc
    extra_b = ours_b & ~ndi.binary_dilation(bld, iterations=1)
    # pieces per blob: our footprint ids whose majority lies in the blob
    nb = len(blds)
    id_area = np.bincount(ids.ravel(), minlength=nb + 1)
    pair = np.stack([blab[inter], ids[inter]], 1)
    pu, pc = np.unique(pair, axis=0, return_counts=True) if len(pair) else (np.zeros((0, 2), int), np.zeros(0, int))
    blob_pieces = {}
    id_blobs = {}
    for (bb, ii), c in zip(pu, pc):
        if c >= 0.5 * id_area[ii]:
            blob_pieces.setdefault(int(bb), []).append(int(ii))
        if c >= max(20, 0.15 * id_area[ii]):
            id_blobs.setdefault(int(ii), []).append((int(bb), int(c)))
    union_ours = ndi.sum(ours_b, blab, bidx) if bn else np.zeros(0)
    inter_b = ndi.sum(inter, blab, bidx) if bn else np.zeros(0)
    bsl = ndi.find_objects(blab)
    split_list, shape_list, merge_list = [], [], []
    for bb in range(1, bn + 1):
        A = barea[bb - 1]
        pcs = blob_pieces.get(bb, [])
        sl = bsl[bb - 1]
        cy, cx = (sl[0].start + sl[0].stop) / 2, (sl[1].start + sl[1].stop) / 2
        if A >= 400:
            # IoU of the blob with the union of the pieces that belong to it
            pa = sum(id_area[i] for i in pcs) * MPP * MPP
            ia = inter_b[bb - 1] * MPP * MPP
            iou = ia / max(A + pa - ia, 1)
            if iou < 0.6:
                shape_list.append((bb, cx, cy, A, iou))
        if A >= 2500 and len(pcs) >= 3:
            sub_ids = ids[sl]
            strips = 0
            for i in pcs:
                w, l = piece_shape(sub_ids == i)
                if w < 14 and l > 2.5 * w:
                    strips += 1
            if strips >= 2 and strips >= 0.4 * len(pcs):
                split_list.append((bb, cx, cy, A, len(pcs), strips))
    for ii, lst in id_blobs.items():
        big = [(bb, c) for bb, c in lst if c * MPP * MPP >= 60]
        if len(big) >= 2:
            p = blds[ii - 1][0]
            px_, py_ = w2p(p[:, 0].mean(), p[:, 1].mean())
            merge_list.append((ii, px_, py_, id_area[ii] * MPP * MPP, len(big)))
    # procedural lots on source roads / alleys / pads / buildings
    plab, pn = ndi.label(proc)
    phantom = ndi.sum(road | truth['pad'] | bld, plab, np.arange(1, pn + 1)) if pn else np.zeros(0)
    psize = ndi.sum(proc, plab, np.arange(1, pn + 1)) if pn else np.zeros(0)
    ph_ids = np.nonzero(phantom > 0.25 * np.maximum(psize, 1))[0] + 1
    ph_mask = np.isin(plab, ph_ids) if len(ph_ids) else np.zeros_like(proc)

    tot = {
        'source_road_km': round(float(skel_ok.sum()) * MPP / 1000, 1),
        'missing_road_km': round(float(missing.sum()) * MPP / 1000, 2),
        'extra_road_km': round(float(extra.sum()) * MPP / 1000, 2),
        'breaks': len(breaks), 'break_km': round(br_len / 1000, 2), 'break_km_under_labels': round(br_under / 1000, 2),
        'source_building_km2': round(float(bld.sum()) * MPP * MPP / 1e6, 3),
        'missing_building_km2': round(float(miss_b.sum()) * MPP * MPP / 1e6, 3),
        'extra_building_km2': round(float(extra_b.sum()) * MPP * MPP / 1e6, 3),
        'building_iou': round(float(inter.sum()) / max(float((bld | ours_b).sum()), 1), 3),
        'mapped_buildings': int(sum(1 for b in blds if not b[1])), 'procedural_buildings': int(sum(1 for b in blds if b[1])),
        'strip_fragmented_blobs': len(split_list), 'strip_fragmented_km2': round(sum(s[3] for s in split_list) / 1e6, 3),
        'merged_footprints': len(merge_list),
        'shape_errors': len(shape_list), 'shape_error_km2': round(sum(s[3] for s in shape_list) / 1e6, 3),
        'phantom_procedural': int(len(ph_ids)),
    }
    print('diff %.0fs' % (time.time() - t0), json.dumps(tot))
    layers = {'missing': missing, 'extra': extra, 'breaks': br_mask, 'miss_b': miss_b, 'extra_b': extra_b,
              'ids': ids, 'proc': proc, 'cov': cov, 'phantom': ph_mask}
    return tot, layers, split_list, merge_list, shape_list, edges, blds


# ------------------------------------------------------------------------------------------------ ranking
CELL = 64


def rank_spots(layers, split_list, merge_list, shape_list, top, H, W):
    gh, gw = H // CELL + 1, W // CELL + 1

    def cells(m):
        ys, xs = np.nonzero(m)
        out = np.zeros((gh, gw))
        np.add.at(out, (ys // CELL, xs // CELL), 1)
        return out
    mr = cells(layers['missing']) * MPP
    er = cells(layers['extra']) * MPP
    br = cells(layers['breaks']) * MPP
    mb = cells(layers['miss_b']) * MPP * MPP
    eb = cells(layers['extra_b']) * MPP * MPP
    ph = cells(layers['phantom']) * MPP * MPP
    sp = np.zeros((gh, gw))
    me = np.zeros((gh, gw))
    sh = np.zeros((gh, gw))
    for bb, cx, cy, A, npcs, ns in split_list:
        sp[int(cy) // CELL, int(cx) // CELL] += A / 15
    for ii, cx, cy, A, nbl in merge_list:
        me[int(cy) // CELL, int(cx) // CELL] += A / 30
    for bb, cx, cy, A, iou in shape_list:
        sh[int(cy) // CELL, int(cx) // CELL] += A * (1 - iou) / 40
    comp = {'missing_road_m': mr, 'extra_road_m': er, 'break_m': br, 'missing_bld_m2': mb, 'extra_bld_m2': eb,
            'phantom_proc_m2': ph, 'strip_split': sp, 'merged': me, 'shape': sh}
    score = mr + er + 2 * br + (mb + eb) / 40 + ph / 60 + sp + me + sh
    # aggregate over 3x3 cells (192 px = 384 m windows) and pick with suppression
    agg = ndi.uniform_filter(score, size=3, mode='constant') * 9
    spots = []
    taken = np.zeros_like(agg, bool)
    order = np.argsort(agg.ravel())[::-1]
    for o in order:
        y, x = divmod(int(o), gw)
        if taken[y, x] or agg[y, x] <= 0:
            continue
        spots.append((y, x))
        taken[max(0, y - 3):y + 4, max(0, x - 3):x + 4] = True
        if len(spots) >= top:
            break
    out = []
    for y, x in spots:
        sl = (slice(max(0, y - 1), y + 2), slice(max(0, x - 1), x + 2))
        parts = {k: round(float(v[sl].sum()), 1) for k, v in comp.items()}
        kind = max(parts, key=lambda k: parts[k] * {'missing_bld_m2': 1 / 40, 'extra_bld_m2': 1 / 40, 'phantom_proc_m2': 1 / 60,
                                                     'break_m': 2}.get(k, 1))
        px, py = x * CELL + CELL / 2, y * CELL + CELL / 2
        wx, wz = p2w(px, py)
        out.append({'x': round(wx), 'z': round(wz), 'px': int(px), 'py': int(py), 'score': round(float(agg[y, x]), 1),
                    'kind': kind, 'parts': parts})
    return out


# ------------------------------------------------------------------------------------------------ crops
def crop(mosaic, truth, layers, edges, blds, px, py, R=110, S=2):
    H, W = truth['road'].shape
    x0, y0 = int(px - R), int(py - R)
    x0 = min(max(0, x0), W - 2 * R)
    y0 = min(max(0, y0), H - 2 * R)
    sl = (slice(y0, y0 + 2 * R), slice(x0, x0 + 2 * R))
    src = np.asarray(mosaic.crop((x0, y0, x0 + 2 * R, y0 + 2 * R)).convert('RGB'))
    up = lambda im: cv2.resize(im, (2 * R * S, 2 * R * S), interpolation=cv2.INTER_NEAREST)
    Wd = 2 * R * S

    def tp(p):
        return np.round((np.stack(w2p(p[:, 0], p[:, 1]), 1) - [x0, y0]) * S * 8).astype(np.int32)
    ours = np.full((Wd, Wd, 3), 236, np.uint8)
    for p, g, b in blds:
        q = tp(p)
        if q[:, 0].max() < 0 or q[:, 1].max() < 0 or q[:, 0].min() > Wd * 8 or q[:, 1].min() > Wd * 8:
            continue
        cv2.fillPoly(ours, [q], (250, 205, 160) if g else (245, 140, 70), shift=3)
        cv2.polylines(ours, [q], True, (130, 70, 30), 1, shift=3)
    kc = {'highway': (90, 40, 150), 'dirt': (150, 105, 50)}
    for p, w, k in edges:
        q = tp(p)
        if q[:, 0].max() < 0 or q[:, 1].max() < 0 or q[:, 0].min() > Wd * 8 or q[:, 1].min() > Wd * 8:
            continue
        cv2.polylines(ours, [q], False, kc.get(k, (60, 60, 60)), max(1, int(w / MPP * S)), lineType=cv2.LINE_AA, shift=3)
    for p, w, k in edges:
        q = tp(p)
        cv2.polylines(ours, [q], False, (255, 255, 255), 1, shift=3)
    d = (src.astype(np.float32) * 0.35 + 165).astype(np.uint8)
    col = [('miss_b', (255, 150, 0)), ('extra_b', (200, 0, 200)), ('phantom', (150, 90, 255)),
           ('missing', (230, 0, 0)), ('breaks', (255, 230, 0)), ('extra', (0, 90, 255))]
    for k, c in col:
        m = layers[k][sl]
        if k in ('missing', 'breaks', 'extra'):
            m = ndi.binary_dilation(m, iterations=1)
        d[m] = c
    out = np.concatenate([up(src), ours, up(d)], 1)
    return out


def write_report(out, tot, spots, mosaic, truth, layers, edges, blds, tag):
    os.makedirs(os.path.join(out, 'crops'), exist_ok=True)
    lines = ['# Parity report: %s' % tag, '', 'Totals:', '']
    for k, v in tot.items():
        lines.append('- %s: %s' % (k, v))
    lines += ['', 'Crops: source | ours (roads dark, mapped buildings orange, procedural light) | diff '
              '(red missing road, yellow break, blue extra road, orange missing bld, magenta extra bld, violet phantom lot)', '',
              '| # | name | x | z | kind | score | crop |', '|---|---|---|---|---|---|---|']
    for i, s in enumerate(spots):
        fn = 'crops/%02d_%s_%d_%d.png' % (i + 1, s.get('name', s['kind']).split(' ')[0], s['x'], s['z'])
        im = crop(mosaic, truth, layers, edges, blds, s['px'], s['py'])
        Image.fromarray(im).save(os.path.join(out, fn), optimize=True)
        s['crop'] = fn
        lines.append('| %d | %s | %d | %d | %s | %.0f | %s |' % (i + 1, s.get('name', ''), s['x'], s['z'], s['kind'], s['score'], fn))
    json.dump({'tag': tag, 'totals': tot, 'spots': spots}, open(os.path.join(out, 'report.json'), 'w'), indent=1)
    open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=os.path.join(ROOT, 'public', 'data'))
    ap.add_argument('--out', required=True)
    ap.add_argument('--top', type=int, default=50)
    ap.add_argument('--spots', help='report.json of a previous run: re-evaluate the same spots')
    ap.add_argument('--tag', default='')
    a = ap.parse_args()
    truth = source_truth()
    H, W = truth['road'].shape
    tot, layers, split_list, merge_list, shape_list, edges, blds = diff(truth, a.data)
    spots = rank_spots(layers, split_list, merge_list, shape_list, a.top, H, W)
    named = []
    for nm, (x, z) in NAMED.items():
        px, py = w2p(x, z)
        named.append({'name': nm, 'x': x, 'z': z, 'px': int(px), 'py': int(py), 'score': 0.0, 'kind': 'named', 'parts': {}})
    if a.spots:
        prev = json.load(open(a.spots))['spots']
        spots = [dict(s, score=0.0) for s in prev if s.get('kind') != 'named']
    mosaic = Image.open(os.path.join(RAW, 'mosaic_nc_z5.png'))
    write_report(a.out, tot, named + spots, mosaic, truth, layers, edges, blds, a.tag or a.data)
    print('report ->', a.out)


if __name__ == '__main__':
    main()
