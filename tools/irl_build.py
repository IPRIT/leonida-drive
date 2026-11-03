"""Fit real-world (OpenStreetMap) building massing into the in-game footprints -> public/data/irl.json

Input : tools/cache/osm/s1_*.json, s2_*.json (tools/irl_fetch.py), tools/cache/data/landmarks.json,
        public/data/buildings.json, optional tools/cache/osm/landmark_takes.json (footprints owned by landmark sites)
Output: public/data/irl.json (+ tools/cache/osm/irl_report.json with per-marker diagnostics)

Data (c) OpenStreetMap contributors, ODbL 1.0 (credited in the About tab).

Fit. The game footprint is the authority for position and size. The OSM outline (local metres, x = east,
z = -north) is mapped onto it with a similarity transform: centroids aligned, uniform scale so the areas match,
rotation = principal-axis alignment (4 candidates + "keep real north") chosen by raster IoU against the game
footprint, ties going to the smallest rotation. Fits with IoU < MIN_IOU keep the game outline and only take the
real heights / roof / colours ("outline" mode); parts are only used when the outline itself fits.

Complexes. When the game footprint is much bigger than the OSM building at the prototype point (towers and podium
mapped separately), adjacent OSM buildings are added greedily while they improve the IoU (stage 1b data).

Heights. Leonida is a compressed Miami (~0.25 linear overall) but single buildings are drawn near real size
(median footprint scale ~0.7). Real metres are kept for low-rise; the part above 20 m shrinks with the footprint scale s (game / real, linear)
so a small lot doesn't carry a full-size pencil tower:
    k = clamp(sqrt(s), 0.6, 1.0);  h = real            (real <= 20 m: storeys stay human-scale)
                                   h = 20 + (real - 20) * k  (above)
then soft-capped above 175 m (h = 175 + (h - 175) * 0.45, max 212 m) so no IRL tower out-tops the hand-made
skyline (Heath Tower 152 m for the 191 m Miami Tower = 0.8, Tequesta Arc 205 m). Missing OSM heights fall back to
levels * 3.3 m, then one storey + hipped roof for houses, then the game's own heuristic height.

Run: .venv/bin/python tools/irl_build.py
"""
import collections
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from irl_geo import (ROOT, CACHE, load_markers, match_markers, game_buildings, load_stage1, osm_candidates,  # noqa: E402
                     load_elements, element_rings, proj, area, centroid, inside)

OUT = os.path.join(ROOT, 'public', 'data', 'irl.json')
MIN_IOU = 0.62
LEVEL_H = 3.3
MAX_PARTS = 28
MAX_VERTS = 56

ROOF = {'flat': 0, 'gabled': 1, 'saltbox': 1, 'gambrel': 1, 'hipped': 2, 'half-hipped': 2, 'side_hipped': 2,
        'pyramidal': 3, 'dome': 4, 'skillion': 5, 'lean_to': 5, 'mansard': 6, 'round': 7, 'onion': 8, 'cone': 9,
        'crosspitched': 2, 'side_half-hipped': 2}
PITCHED = {1, 2, 3, 5, 6, 7}

CSS = {
    'white': 0xffffff, 'black': 0x222222, 'gray': 0x808080, 'grey': 0x808080, 'lightgray': 0xd3d3d3, 'lightgrey': 0xd3d3d3,
    'darkgray': 0x8a8a8a, 'darkgrey': 0x8a8a8a, 'dimgray': 0x696969, 'silver': 0xc0c0c0, 'gainsboro': 0xdcdcdc,
    'whitesmoke': 0xf5f5f5, 'beige': 0xf5f5dc, 'ivory': 0xfffff0, 'cream': 0xfff7dc, 'linen': 0xfaf0e6, 'wheat': 0xf5deb3,
    'tan': 0xd2b48c, 'sand': 0xe2ca9a, 'brown': 0x8b5a3c, 'maroon': 0x800000, 'red': 0xc0392b, 'darkred': 0x8b0000,
    'orange': 0xe8862a, 'yellow': 0xf2d64b, 'lightyellow': 0xffffe0, 'gold': 0xd4af37, 'khaki': 0xf0e68c,
    'olive': 0x808000, 'green': 0x3c8d40, 'darkgreen': 0x1f5f2a, 'lightgreen': 0x90ee90, 'teal': 0x2a8c8c,
    'cyan': 0x5fd3e0, 'aqua': 0x5fd3e0, 'lightblue': 0xadd8e6, 'skyblue': 0x87ceeb, 'blue': 0x3b6db5, 'navy': 0x1f2f5f,
    'darkblue': 0x1f2f6f, 'steelblue': 0x4682b4, 'slategray': 0x708090, 'slategrey': 0x708090, 'purple': 0x7d3c98,
    'pink': 0xf4b6c8, 'salmon': 0xfa8072, 'coral': 0xff7f50, 'peach': 0xffcba4, 'terracotta': 0xc2603f,
    'lavender': 0xe6e6fa, 'azure': 0xf0ffff, 'aliceblue': 0xf0f8ff, 'seashell': 0xfff5ee, 'snow': 0xfffafa,
    'oldlace': 0xfdf5e6, 'cornsilk': 0xfff8dc, 'bisque': 0xffe4c4, 'moccasin': 0xffe4b5, 'navajowhite': 0xffdead,
    'peachpuff': 0xffdab9, 'burlywood': 0xdeb887, 'chocolate': 0xd2691e, 'sienna': 0xa0522d, 'peru': 0xcd853f,
    'rosybrown': 0xbc8f8f, 'indianred': 0xcd5c5c, 'firebrick': 0xb22222, 'crimson': 0xdc143c, 'tomato': 0xff6347,
    'darkorange': 0xff8c00, 'sandybrown': 0xf4a460, 'goldenrod': 0xdaa520, 'darkkhaki': 0xbdb76b,
    'palegoldenrod': 0xeee8aa, 'lightcyan': 0xe0ffff, 'paleturquoise': 0xafeeee, 'turquoise': 0x40e0d0,
    'darkcyan': 0x008b8b, 'cadetblue': 0x5f9ea0, 'powderblue': 0xb0e0e6, 'lightsteelblue': 0xb0c4de,
    'cornflowerblue': 0x6495ed, 'royalblue': 0x4169e1, 'dodgerblue': 0x1e90ff, 'deepskyblue': 0x00bfff,
    'midnightblue': 0x191970, 'lightslategray': 0x778899, 'darkslategray': 0x2f4f4f, 'darkolivegreen': 0x556b2f,
    'olivedrab': 0x6b8e23, 'forestgreen': 0x228b22, 'seagreen': 0x2e8b57, 'mediumseagreen': 0x3cb371,
    'darkseagreen': 0x8fbc8f, 'palegreen': 0x98fb98, 'limegreen': 0x32cd32, 'aquamarine': 0x7fffd4,
    'mediumaquamarine': 0x66cdaa, 'plum': 0xdda0dd, 'violet': 0xee82ee, 'orchid': 0xda70d6, 'thistle': 0xd8bfd8,
    'mistyrose': 0xffe4e1, 'lavenderblush': 0xfff0f5, 'hotpink': 0xff69b4, 'lightpink': 0xffb6c1,
    'lightsalmon': 0xffa07a, 'darksalmon': 0xe9967a, 'lightcoral': 0xf08080, 'mintcream': 0xf5fffa,
    'honeydew': 0xf0fff0, 'lemonchiffon': 0xfffacd, 'floralwhite': 0xfffaf0, 'ghostwhite': 0xf8f8ff,
}
HOUSES = {'house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'cabin', 'farm', 'static_caravan', 'villa'}
INDUSTRIAL = {'industrial', 'warehouse', 'hangar', 'manufacture', 'storage_tank', 'service', 'transportation', 'train_station', 'barn', 'factory'}
GLASSY = {'office', 'commercial'}


# ---------------------------------------------------------------- tag parsing
def num(v):
    if v is None:
        return None
    s = str(v).strip().lower().replace(',', '.')
    best = None
    for tok in s.split(';'):
        tok = tok.strip()
        feet = tok.endswith("'") or tok.endswith('ft') or 'feet' in tok
        t = ''.join(ch for ch in tok if ch.isdigit() or ch in '.-')
        try:
            x = float(t)
        except ValueError:
            continue
        if feet:
            x *= 0.3048
        best = x if best is None else max(best, x)
    return best


def colour(v):
    if not v:
        return None
    s = str(v).strip().lower().split(';')[0].strip().replace(' ', '').replace('_', '')
    if s.startswith('#'):
        h = s[1:]
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        try:
            return int(h[:6], 16)
        except ValueError:
            return None
    return CSS.get(s)


def heights(tags):
    """(total height, min height, roof height, roof shape code, has explicit height) in real metres"""
    shape = ROOF.get(str(tags.get('roof:shape', '')).lower())
    lv = num(tags.get('building:levels'))
    rlv = num(tags.get('roof:levels'))
    rh = num(tags.get('roof:height'))
    if rh is None and rlv:
        rh = rlv * 2.8
    h = num(tags.get('height'))
    explicit = h is not None
    if h is None and lv is not None:
        h = lv * LEVEL_H + (rh or 0) + (0.8 if shape in (None, 0) and lv > 2 else 0)
    mh = num(tags.get('min_height'))
    if mh is None and num(tags.get('building:min_level')) is not None:
        mh = num(tags.get('building:min_level')) * LEVEL_H
    if h is not None and (h <= 0 or h > 600):
        h = None
    return h, (mh or 0.0), rh, shape, explicit or lv is not None


# ---------------------------------------------------------------- geometry
def raw_moments(poly):
    P = np.asarray(poly, float)
    x, y = P[:, 0], P[:, 1]
    x1, y1 = np.roll(x, -1), np.roll(y, -1)
    c = x * y1 - x1 * y
    m = np.array([c.sum() / 2, ((x + x1) * c).sum() / 6, ((y + y1) * c).sum() / 6,
                  ((x * x + x * x1 + x1 * x1) * c).sum() / 12, ((y * y + y * y1 + y1 * y1) * c).sum() / 12,
                  ((x * y1 + 2 * x * y + 2 * x1 * y1 + x1 * y) * c).sum() / 24])
    return -m if m[0] < 0 else m


def moments(rings):
    """area, centroid, principal-axis angle (None when the shape is nearly isotropic) of a set of rings"""
    A, Sx, Sy, Sxx, Syy, Sxy = sum(raw_moments(r) for r in rings)
    if A < 1e-9:
        return 0.0, np.zeros(2), None
    cx, cy = Sx / A, Sy / A
    xx, yy, xy = Sxx - A * cx * cx, Syy - A * cy * cy, Sxy - A * cx * cy
    ev = np.linalg.eigvalsh(np.array([[xx, xy], [xy, yy]]))
    elong = 1 - abs(ev[0]) / max(abs(ev[1]), 1e-9)
    return A, np.array([cx, cy]), (0.5 * math.atan2(2 * xy, xx - yy) if elong > 0.04 else None)


def xform(poly, c0, ang, s, c1):
    ca, sa = math.cos(ang), math.sin(ang)
    return [(c1[0] + s * (ca * (x - c0[0]) - sa * (y - c0[1])), c1[1] + s * (sa * (x - c0[0]) + ca * (y - c0[1]))) for x, y in poly]


def iou(rings_a, rings_b, res=None):
    pts = np.array([p for r in rings_a + rings_b for p in r], float)
    lo, hi = pts.min(0), pts.max(0)
    res = res or max(0.2, max(hi - lo) / 200)
    W, H = int((hi[0] - lo[0]) / res) + 3, int((hi[1] - lo[1]) / res) + 3
    ma = np.zeros((H, W), np.uint8)
    mb = np.zeros((H, W), np.uint8)
    for r in rings_a:
        cv2.fillPoly(ma, [np.round((np.asarray(r) - lo) / res + 1).astype(np.int32)], 1)
    for r in rings_b:
        cv2.fillPoly(mb, [np.round((np.asarray(r) - lo) / res + 1).astype(np.int32)], 1)
    return np.logical_and(ma, mb).sum() / max(np.logical_or(ma, mb).sum(), 1), ma, mb


def fit(rings, gpoly):
    """similarity transform of OSM rings (local metres) onto the game footprint: best IoU over rotations"""
    A_o, c_o, ang_o = moments(rings)
    A_g, c_g, ang_g = moments([gpoly])
    s = math.sqrt(A_g / max(A_o, 1e-6))
    cand = [0.0]
    if ang_g is not None and ang_o is not None:
        cand += [ang_g - ang_o + q * math.pi / 2 for q in range(4)]
    best = None
    for ang in cand:
        tr = [xform(r, c_o, ang, s, c_g) for r in rings]
        v = iou(tr, [gpoly])[0]
        score = v - 0.02 * abs((ang + math.pi) % (2 * math.pi) - math.pi)  # ties -> keep real orientation
        if best is None or score > best['score']:
            best = {'score': score, 'iou': v, 'ang': ang, 's': s, 'c_o': c_o, 'c_g': c_g}
    return best


def dp(poly, tol):
    """Douglas-Peucker on a closed ring"""
    if len(poly) <= 4:
        return poly
    r = cv2.approxPolyDP(np.asarray(poly, np.float32).reshape(-1, 1, 2), tol, True)[:, 0, :]
    return [tuple(map(float, p)) for p in r] if len(r) >= 3 else poly


def clean_ring(poly, tol):
    q, t = dp(poly, tol), tol
    while len(q) > MAX_VERTS:
        t *= 1.6
        q = dp(poly, t)
    out = []
    for p in q:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 0.15:
            out.append(p)
    if len(out) > 3 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < 0.15:
        out.pop()
    return out if len(out) >= 3 and abs(area(out)) > 1.0 else None


def flat(poly):
    return [round(v, 1) for p in poly for v in p]


def clip_to_footprint(ring, gpoly, margin=1.5, tol=0.3):
    """parts of a fitted ring inside the game footprint (+margin): raster AND, re-vectorised. The ring itself when it
    already fits (< 3 % outside), [] when nothing is left. The footprint is the authority: no IRL wall in the street."""
    pts = np.array(list(ring) + list(gpoly), float)
    lo, hi = pts.min(0) - margin - 1, pts.max(0) + margin + 1
    res = max(0.12, max(hi - lo) / 500)
    W, H = int((hi[0] - lo[0]) / res) + 2, int((hi[1] - lo[1]) / res) + 2
    mr = np.zeros((H, W), np.uint8)
    mg = np.zeros((H, W), np.uint8)
    cv2.fillPoly(mr, [np.round((np.asarray(ring) - lo) / res).astype(np.int32)], 1)
    cv2.fillPoly(mg, [np.round((np.asarray(gpoly) - lo) / res).astype(np.int32)], 1)
    k = int(round(margin / res))
    if k > 0:
        mg = cv2.dilate(mg, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
    a = mr.sum()
    inter = mr & mg
    if a == 0 or inter.sum() < 0.03 * a or inter.sum() * res * res < 4:
        return []
    if inter.sum() > 0.97 * a:
        return [list(ring)]
    cs, _ = cv2.findContours(inter, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cs:
        if cv2.contourArea(c) * res * res < 4:
            continue
        c = cv2.approxPolyDP(c, max(0.6, tol / res), True)[:, 0, :].astype(float)
        if len(c) >= 3:
            out.append([(float(x * res + lo[0]), float(y * res + lo[1])) for x, y in c])
    return out


def local_rings(ob, P):
    rings = [[(e, -n) for e, n in (P(la, lo) for la, lo in r)] for r in ob['rings']]
    return [r for r in rings if abs(area(r)) > 4]


# ---------------------------------------------------------------- selection
def landmark_takes():
    """footprints owned by landmark sites (hand-made models): never overridden"""
    B, _ = game_buildings()
    tp = os.path.join(CACHE, 'landmark_takes.json')
    if not os.path.exists(tp):
        return set()
    tk = np.array(json.load(open(tp)).get('centroids', [])).reshape(-1, 2)
    if not len(tk):
        return set()
    return {i for i, b in enumerate(B) if np.min(np.hypot(tk[:, 0] - b['c'][0], tk[:, 1] - b['c'][1])) < 1.0}


def choose(markers, matches, stats=None, report=None):
    """footprint index -> {k: marker, members: [OSM buildings], P: projection, fit} (one primary marker each).
    A footprint much bigger than the OSM building at the prototype point grows a cluster of adjacent OSM buildings
    (towers + podium mapped separately) while that improves the fit."""
    stats = stats if stats is not None else collections.Counter()
    report = report if report is not None else {}
    B, _ = game_buildings()
    osm = load_stage1()
    takes = landmark_takes()
    by_b = collections.defaultdict(list)
    for k, m in matches.items():
        by_b[m['b']].append(k)

    def rank(k):
        t = set(markers[k]['tags'])
        return (matches[k]['d'] > 0, 'unconfirmed' in t,
                not (t & {'hotel', 'residential', 'landmark', 'government', 'office', 'retail', 'public', 'leisure', 'events'}),
                markers[k]['name'].startswith('?'), k)

    sel = {}
    for bi, ks in sorted(by_b.items()):
        ks.sort(key=rank)
        k = ks[0]
        m = markers[k]
        g = B[bi]
        if bi in takes:
            stats['skip_landmark_site'] += 1
            report[k] = 'landmark site'
            continue
        cands = [t for t in osm_candidates(m['ll'], osm, 160) if t[1] >= 25]
        near = [t for t in cands if t[0] <= 30]
        if not near:
            stats['no_osm_building'] += 1
            report[k] = 'no OSM building near the prototype'
            continue
        d0, a0, ob0, _ = near[0]
        if 'unconfirmed' in m['tags'] and d0 > 0:
            stats['unconfirmed_outside'] += 1
            report[k] = 'unconfirmed prototype, point not inside an OSM building'
            continue
        P = proj(*m['ll'])
        members = [ob0]
        rings = local_rings(ob0, P)
        if not rings:
            continue
        a_g = abs(area(g['poly']))
        best = fit(rings, g['poly'])
        if a_g / a0 > 2.0:
            pool = [(t[2], local_rings(t[2], P)) for t in cands[1:41]]
            for _ in range(10):
                cur = [r for ob in members for r in local_rings(ob, P)]
                add = None
                for ob, rr in pool:
                    if ob in members or not rr:
                        continue
                    # adjacent to the cluster (within 25 m of one of its rings)
                    if min(math.hypot(p[0] - q[0], p[1] - q[1]) for p in rr[0][::max(1, len(rr[0]) // 12)] for r in cur for q in r[::max(1, len(r) // 12)]) > 25:
                        continue
                    f = fit(cur + rr, g['poly'])
                    if f['iou'] > (add[1]['iou'] if add else best['iou']) + 0.015:
                        add = (ob, f)
                if not add:
                    break
                members.append(add[0])
                best = add[1]
            if len(members) > 1:
                stats['cluster'] += 1
        if best['s'] < 0.3 or best['s'] > 3.0:
            stats['scale_mismatch'] += 1
            report[k] = f'scale mismatch {best["s"]:.2f}'
            continue
        sel[bi] = {'k': k, 'members': members, 'P': P, 'fit': best, 'others': ks[1:]}
    return sel


# ---------------------------------------------------------------- main
def load_parts():
    out = []
    for (t, i), el in load_elements('s2').items():
        tags = el.get('tags', {})
        bp = str(tags.get('building:part', 'no')).lower()
        if bp == 'no' or (bp == 'roof' and num(tags.get('height')) is None):
            continue  # roof canopies only when they carry a height
        for r in element_rings(el):
            lats = [p[0] for p in r]
            lngs = [p[1] for p in r]
            out.append({'id': f'{t[0]}{i}', 'tags': tags, 'ring': r, 'bbox': (min(lats), min(lngs), max(lats), max(lngs))})
    return out


def scale_heights(s):
    """real metres -> game metres. Low-rise stays at human scale (cars and people are 1:1); only the part above
    20 m is compressed with the footprint scale, then soft-capped under the hand-made skyline."""
    k = min(1.0, max(0.6, math.sqrt(s)))

    def f(h):
        h = h if h <= 20 else 20 + (h - 20) * k
        return min(212.0, 175 + (h - 175) * 0.45) if h > 175 else h
    return k, f


def facade_style(tags, H, g, a_g):
    btype = str(tags.get('building', 'yes')).lower()
    mat = (str(tags.get('building:material', '')) + str(tags.get('facade:material', ''))).lower()
    if (btype in HOUSES or (g['s'] == 3 and btype in ('yes', 'residential', 'garage', 'shed'))) and H < 12:
        return 3
    if btype in INDUSTRIAL or (btype in ('retail', 'supermarket') and H < 12 and a_g > 3000):
        return 4
    if 'parking' in btype:
        return 5
    if 'glass' in mat or (btype in GLASSY and H > 30):
        return 2
    if H > 70:
        return 2  # Miami's high-rises are overwhelmingly glass curtain wall / glass-balcony condos
    if H > 36:
        return g['s'] if g['s'] in (2, 5) else 5
    if g['s'] == 1:
        return 1
    return 0 if g['s'] in (2, 3, 5) else g['s']


def main():
    markers = load_markers()
    matches = match_markers(markers)
    B, _ = game_buildings()
    parts = load_parts()
    stats = collections.Counter()
    report = {}
    sel = choose(markers, matches, stats, report)
    print(f'{len(markers)} prototype markers, {len(matches)} on a game footprint, {len(load_stage1()[0])} OSM buildings, '
          f'{len(parts)} OSM parts, {len(sel)} footprints selected')
    out = []
    for bi, S in sorted(sel.items()):
        k, P, F, g = S['k'], S['P'], S['fit'], B[bi]
        a_g = abs(area(g['poly']))
        # small lots (houses, shops): the real outline only when it really matches, else chamfered clips look random
        mode = 'shape' if F['iou'] >= (MIN_IOU if a_g >= 400 else 0.75) else 'outline'
        stats['fit_' + mode] += 1
        k_h, scale_h = scale_heights(F['s'])
        a_g = abs(area(g['poly']))
        # massing in real metres: [ring (local), min_h, top_h, roof_h, shape, wall colour, roof colour]
        massing = []
        prim_tags = S['members'][0]['tags']
        any_h = False
        for ob in S['members']:
            rings = local_rings(ob, P)
            h_real, _, rh_real, shape, has_h = heights(ob['tags'])
            any_h |= h_real is not None
            mine = []
            s_, w_, n_, e_ = ob['bbox']
            for pt in parts:
                ps, pw, pn, pe = pt['bbox']
                if pn < s_ or ps > n_ or pe < w_ or pw > e_:
                    continue
                ring = [(e, -n) for e, n in (P(la, lo) for la, lo in pt['ring'])]
                if abs(area(ring)) < 2:
                    continue
                cx, cz = centroid(ring)
                if any(inside(cx, cz, r) for r in rings):
                    ph, pmh, prh, pshape, _ = heights(pt['tags'])
                    ph = ph if ph is not None else h_real
                    if ph is None or ph <= pmh:
                        continue
                    any_h = True
                    mine.append([ring, pmh, ph, prh, pshape, colour(pt['tags'].get('building:colour')), colour(pt['tags'].get('roof:colour'))])
            if mine:
                # parts that leave much of the outline uncovered: keep the outline as a podium under them
                _, mp, mo = iou([mm[0] for mm in mine if mm[1] < 0.5] or [mine[0][0]], rings)
                cov = np.logical_and(mp, mo).sum() / max(1, mo.sum())
                if len(mine) > MAX_PARTS:
                    mine.sort(key=lambda mm: -abs(area(mm[0])) * (mm[2] - mm[1]))
                    mine = mine[:MAX_PARTS]
                if cov < 0.55:
                    top = h_real if h_real is not None else min(mm[2] for mm in mine)
                    mine += [[r, 0.0, top, rh_real if h_real is not None else None, shape if h_real is not None else None, None, None] for r in rings]
                massing += mine
                stats['with_parts'] += 1
            else:
                massing += [[r, 0.0, h_real, rh_real, shape, colour(ob['tags'].get('building:colour')) if len(S['members']) > 1 else None,
                             colour(ob['tags'].get('roof:colour')) if len(S['members']) > 1 else None] for r in rings]
        btype = str(prim_tags.get('building', 'yes')).lower()
        housey = btype in HOUSES or (g['s'] == 3 and btype in ('yes', 'residential', 'garage', 'shed'))
        if not any_h and mode == 'outline' and not housey and all(mm[4] is None for mm in massing):
            # nothing real to add (no height, no roof, outline doesn't fit): keep the generated building
            stats['skip_no_real_data'] += 1
            report[k] = 'no real height / roof and the outline does not fit'
            continue
        if not any_h:
            # no real height anywhere: Florida houses get one storey + hipped roof, the rest keeps the game height
            if housey:
                for mm in massing:
                    mm[2] = 4.4 + (1.8 if mm[4] in PITCHED or mm[4] is None else 0)
                    if mm[4] is None:
                        mm[4], mm[3] = 2, 1.8
                stats['height_house_default'] += 1
            else:
                for mm in massing:  # inverse of scale_h: comes out as the game's own height
                    mm[2] = g['h'] if g['h'] <= 20 else 20 + (g['h'] - 20) / k_h
                stats['height_from_game'] += 1
        else:
            stats['height_from_osm'] += 1
            hmax = max(mm[2] for mm in massing if mm[2] is not None)
            for mm in massing:
                if mm[2] is None:
                    mm[2] = hmax
        for mm in massing:
            if mm[4] is None:
                # Florida houses: hipped roofs (OSM rarely says so); everything else flat
                if housey and mm[2] < 10:
                    mm[4], mm[3] = 2, min(2.2, max(1.2, mm[2] * 0.3))
                else:
                    mm[4] = 0
        tol = 0.3 if a_g < 2000 else 0.6
        # into game coordinates, clipped to the footprint
        placed = []
        for mm in massing:
            for r in clip_to_footprint(xform(mm[0], F['c_o'], F['ang'], F['s'], F['c_g']), g['poly'], min(1.5, 0.06 * math.sqrt(a_g)) if mode == 'shape' else 0.0, tol):
                placed.append([r] + mm[1:])
        if mode == 'outline' or not placed:
            # the real outline doesn't fit the lot: the game outline carries the main real massing (largest ground
            # part's height / roof), taller real parts (towers on a podium) rise from it, clipped to the lot
            ground = [mm for mm in massing if mm[1] < 0.5] or massing
            podium = max(ground, key=lambda mm: abs(area(mm[0])) * (1 + 0.02 * mm[2]))
            higher = [mm for mm in placed if mm[2] > podium[2] + 3 and abs(area(mm[0])) < 0.8 * a_g]
            placed = [[g['poly']] + podium[1:]] + higher[:MAX_PARTS]
            if higher:
                stats['outline_with_towers'] += 1
        parts_out, H = [], 0.0
        for ring, mh, th, rh, shp, wc, rc in placed:
            gp = clean_ring(ring, tol)
            if gp is None:
                continue
            bot, top = scale_h(mh), scale_h(th)
            if top - bot < 0.6:
                continue
            if bot < 0.3:
                top = max(top, 3.6)  # at least one storey (OSM 'height' of sheds / kiosks / bad tags)
            q = {'p': flat(gp), 'h': round(top, 1)}
            if bot > 0.3:
                q['b'] = round(bot, 1)
            if shp:
                q['r'] = shp
                if rh:
                    q['rh'] = round(min(rh * (top - bot) / max(th - mh, 0.1), (top - bot) * 0.9), 1)
            if wc is not None:
                q['w'] = wc
            if rc is not None:
                q['c'] = rc
            parts_out.append(q)
            H = max(H, top)
        if not parts_out:
            stats['empty'] += 1
            continue
        # footprint identity for the runtime: index (hint) + vertex-mean centroid + area (robust to re-exports)
        rec = {'i': bi, 'c': [round(g['c'][0], 2), round(g['c'][1], 2)], 'a': round(a_g, 1), 'm': k, 'h': round(H, 1),
               's': facade_style(prim_tags, H, g, a_g), 'parts': parts_out}
        wc, rc = colour(prim_tags.get('building:colour')), colour(prim_tags.get('roof:colour'))
        if wc is not None:
            rec['w'] = wc
        if rc is not None:
            rec['rc'] = rc
        out.append(rec)
        report[k] = {'b': bi, 'osm': [ob['id'] for ob in S['members']], 'iou': round(F['iou'], 2), 'scale': round(F['s'], 2),
                     'rot': round(math.degrees(F['ang']), 1), 'mode': mode, 'h_game_before': g['h'], 'h_irl': round(H, 1),
                     'parts': len(parts_out), 'name': prim_tags.get('name'), 'addr': markers[k]['addr'], 'also': S['others']}
    with open(OUT, 'w') as f:
        json.dump({'v': 1, 'attr': '© OpenStreetMap contributors (ODbL)', 'b': out}, f, separators=(',', ':'), ensure_ascii=False)
        f.write('\n')
    with open(os.path.join(CACHE, 'irl_report.json'), 'w') as f:
        json.dump({'stats': stats, 'markers': report}, f, indent=1, ensure_ascii=False)
        f.write('\n')
    import gzip
    raw = open(OUT, 'rb').read()
    print(dict(stats))
    print(f'{len(out)} buildings -> {OUT} {len(raw) / 1e3:.0f} kB ({len(gzip.compress(raw)) / 1e3:.0f} kB gz), '
          f'{sum(len(r["parts"]) for r in out)} parts')


if __name__ == '__main__':
    main()
