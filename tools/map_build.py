"""Build the vector cartography dataset for the HUD radar and the pause-menu map (workstream H).

Output: public/data/map.bin = gzip( 'LDMAP1\\0\\0' | u32 headerLen | header JSON (utf-8, padded to 4) | binary blob )

Geometry sets (header.sets[name]) are delta-encoded polylines/rings:
  parts  Int32 stride 4: [cell, cls, n, extra]      cell = index in the LOD cell grid (row-major, from bounds min)
  coords Int16 2*n per part: first point absolute (q-units from header.origin), then deltas
Sets:
  w0..w2   bathymetry: regions shallower than DEPTH_LEVELS[cls] per LOD (nested), drawn deep -> shallow
  a0..a3   land-use rings per LOD (cls = AREA_CLASSES index), drawn with the even-odd rule
  r0..r3   road polylines per LOD (extra = drawn width in dm). cls bits: 0-3 ROAD_CLASSES index, 16 bridge deck,
           32/64 drawing level + 1 (0 tunnel, 1 ground, 2 overpass), 128 highway ramp / connector, 256 tunnel.
           Polylines are merged along continuous strokes (same class / level / width), so caps only occur at real
           ends and attribute changes.
  b0       building footprints (extra = height in dm)
  st       street-name label paths (cell = index into header.streets)
  rt       route-shield paths (cell = index into header.routes)
Header also carries POIs (fan-map landmarks), districts, landmarks, street names, routes (interstate / US / state
road numbers read off the fan map's shields), exits (numbered per interstate) and categories.

Sources: public/data/{world.json, ground.bin, height.bin, roads.json, buildings.json} (built by tools/export.py from the
State of Leonida community map, YANIS v17) and tools/cache/data/landmarks.json (map.stateofleonida.net POIs).
Street names are taken only from the fan-map POI labels ("Name, Street, District, Area"); nothing is invented.

Landmarks (tools/cache/landmark_geom.json, written by `node tools/landmark_geom.mjs`; optional): runways are drawn as
exact rectangles (threshold to threshold) and taxiways as the landmark centrelines instead of the road-graph airside
edges; aprons and the blimp pad join the paved land use; site structure outlines (stadium bowls, terminals, hangars,
towers), parked aircraft and the blimp are drawn as footprints; generic footprints replaced by a landmark site
(tools/cache/osm/landmark_takes.json centroids, or centroid inside a structure outline) are not drawn.
Without the file the map keeps the road-graph runways and the original footprints.

Run: .venv/bin/python tools/map_build.py      (LEONIDA_OUT=<dir> reads the game data from / writes map.bin to <dir>)
"""
import gzip
import json
import math
import os
import re
import struct
import time
from collections import Counter, defaultdict

import cv2
import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage import measure

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('LEONIDA_OUT') or os.path.join(ROOT, 'public', 'data')
CACHE = os.path.join(ROOT, 'tools', 'cache', 'data')
OUT = os.path.join(DATA, 'map.bin')
LANDMARK_GEOM = os.environ.get('LANDMARK_GEOM') or os.path.join(ROOT, 'tools', 'cache', 'landmark_geom.json')
LANDMARK_TAKES = os.path.join(ROOT, 'tools', 'cache', 'osm', 'landmark_takes.json')

Q = 0.5  # metres per quantization unit
AREA_CLASSES = ['land', 'farm', 'wetland', 'dirt', 'urban', 'paved', 'park', 'sand']
ROAD_CLASSES = ['highway', 'primary', 'street', 'path', 'runway', 'taxiway']
C_HW, C_PRI, C_ST, C_PATH, C_RWY, C_TAXI = range(6)
BRIDGE = 16
LEVEL_SHIFT = 5   # 2 bits: drawing level + 1
RAMP = 128
TUNNEL = 256

# land-use LODs: f = downsample factor of the 4 m ground grid, sigma = smoothing (px at that LOD),
# tol = Douglas-Peucker tolerance (m), min_area (m²), cell = spatial bucket size (m)
AREA_LODS = [
    dict(f=1, sigma=0.85, tol=1.0, min_area=90, cell=1024),
    dict(f=2, sigma=0.8, tol=2.6, min_area=1500, cell=2048),
    dict(f=4, sigma=0.8, tol=7.0, min_area=14000, cell=4096),
    dict(f=8, sigma=0.75, tol=18.0, min_area=90000, cell=8192),
]
ROAD_LODS = [
    dict(tol=0.45, cell=512, classes=(0, 1, 2, 3, 4, 5), ramps=True),
    dict(tol=1.6, cell=2048, classes=(0, 1, 2, 3, 4, 5), ramps=True),
    dict(tol=5.0, cell=4096, classes=(0, 1, 2, 4), ramps=True),
    dict(tol=14.0, cell=8192, classes=(0, 1, 4), ramps=False),
]
BUILDING_CELL = 512
# bathymetry: depth isolines (m, negative = below sea level) vectorised from the 8 m height grid; ring cls = level index
DEPTH_LEVELS = [-19, -13, -8, -4.5, -1.8]  # the open sea is a flat -24 m plateau (with -30 m artefacts): stay above it
DEPTH_LODS = [
    dict(f=1, sigma=1.3, tol=2.5, min_area=4000, cell=2048),
    dict(f=2, sigma=1.0, tol=7.0, min_area=30000, cell=4096),
    dict(f=4, sigma=0.9, tol=18.0, min_area=200000, cell=8192),
]

CATEGORIES = [
    # id, tags (first match wins, checked in this order)
    ('landmark', {'landmark'}),
    ('gas', {'#gas'}),
    ('food', {'restaurant', '#food', '#fastfood', 'fastfood', '#drinks', '#bar', '#vendor'}),
    ('hotel', {'hotel'}),
    ('shop', {'retail', '#supermarket', 'supermarket', '#clothes', '#electronics', '#shoes', '#liquor', '#guns', '#hair',
              '#tattoos', '#bikeshop', '#modshop', "#pay'n'spray", '#carwash'}),
    ('leisure', {'leisure', '#nightclub', '#stripclub', '#cinema', '#golf', '#tennis', '#racetrack', '#ferriswheel', '#gym', 'events'}),
    ('transport', {'transportation', '#bus', '#train', '#metro', '#metromover', '#airport', '#marina', '#airbase', '#blimp'}),
    ('services', {'government', 'public', '#police', '#hospital', '#jail', 'service'}),
    ('industry', {'industrial', 'construction', 'agriculture', 'utilities'}),
    ('nature', {'natural'}),
    ('office', {'office'}),
    ('residential', {'residential'}),
    ('other', set()),
]
FLAG_TAGS = {'enterable': 1, 'demolished': 2, 'unconfirmed': 4, 'closed': 8, '#safehouse': 16, 'landmark': 32}
STREET_RE = re.compile(r"^(?:[NSEW]{1,2} )?[\w'çÇ .-]+? (?:St|Ave|Dr|Blvd|Cswy|Cir|Ct|Hwy|Rd|Way|Ln|Pkwy|Ter|Pl)$|^(?:Historic )?(?:Route|Interstate) \d+$")


def log(*a):
    print('[map_build]', *a, flush=True)


# ----------------------------------------------------------------------------------------------------------------
class Packer:
    def __init__(self, x0, z0, x1, z1):
        self.blob = bytearray()
        self.arrays = {}
        self.origin = ((x0 + x1) / 2, (z0 + z1) / 2)
        self.bounds = (x0, z0, x1, z1)

    def add(self, name, arr):
        arr = np.ascontiguousarray(arr)
        while len(self.blob) % 4:
            self.blob.append(0)
        off = len(self.blob)
        self.blob += arr.tobytes()
        self.arrays[name] = [arr.dtype.name, off, int(arr.size)]

    def quant(self, pts):
        q = np.empty_like(pts, dtype=np.int64)
        q[:, 0] = np.round((pts[:, 0] - self.origin[0]) / Q)
        q[:, 1] = np.round((pts[:, 1] - self.origin[1]) / Q)
        assert np.abs(q).max() < 32767, 'coordinate out of Int16 range'
        return q

    def geometry(self, name, parts, meta):
        """parts: list of (cell, cls, extra, pts[N,2] float world coords)"""
        P = np.zeros((len(parts), 4), np.int32)
        chunks = []
        for i, (cell, cls, extra, pts) in enumerate(parts):
            q = self.quant(pts)
            # drop repeated quantized points
            keep = np.ones(len(q), bool)
            keep[1:] = np.any(np.diff(q, axis=0) != 0, axis=1)
            q = q[keep]
            d = q.copy()
            d[1:] -= q[:-1]
            P[i] = (cell, cls, len(q), extra)
            chunks.append(d.astype(np.int16))
        C = np.concatenate(chunks) if chunks else np.zeros((0, 2), np.int16)
        self.add(name + '.parts', P.ravel())
        self.add(name + '.coords', C.ravel())
        meta['parts'] = len(parts)
        meta['points'] = int(len(C))
        return meta


def cell_index(x, z, cell, bounds):
    x0, z0, x1, z1 = bounds
    cols = int(math.ceil((x1 - x0) / cell))
    c = int(np.clip((x - x0) // cell, 0, cols - 1))
    rows = int(math.ceil((z1 - z0) / cell))
    r = int(np.clip((z - z0) // cell, 0, rows - 1))
    return r * cols + c


def grid_dims(cell, bounds):
    x0, z0, x1, z1 = bounds
    return int(math.ceil((x1 - x0) / cell)), int(math.ceil((z1 - z0) / cell))


def ring_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * (np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def simplify(pts, tol, closed):
    if len(pts) < 3 or tol <= 0:
        return pts
    a = np.asarray(pts, np.float32).reshape(-1, 1, 2)
    out = cv2.approxPolyDP(a, float(tol), closed).reshape(-1, 2).astype(np.float64)
    if not closed:
        # approxPolyDP keeps endpoints for open curves, but be explicit
        if not np.allclose(out[0], pts[0]):
            out = np.vstack([pts[:1], out])
        if not np.allclose(out[-1], pts[-1]):
            out = np.vstack([out, pts[-1:]])
    return out


def clean_mask(m, min_px):
    """Remove specks smaller than min_px and fill holes smaller than min_px."""
    if min_px <= 1:
        return m
    m = m.astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    small = np.zeros(n, bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < min_px
    m[small[lab]] = 0
    inv = (1 - m).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    small = np.zeros(n, bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < min_px
    m[small[lab]] = 1
    return m


# ----------------------------------------------------------------------------------------------------------------
def build_masks(g):
    G = dict(water=0, sand=1, grass=2, park=3, wetland=4, farm=5, dirt=6, urban=7, paved=8, building=9, road=10, sport=11)
    water = g == G['water']
    built = np.isin(g, (G['urban'], G['paved'], G['building']))
    # urban fabric: built-up texels, closed over the street grid (roads inside towns become urban, rural roads don't)
    urban = cv2.morphologyEx(built.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))) > 0
    urban |= (g == G['road']) & (ndi.uniform_filter(built.astype(np.float32), 9) > 0.35)
    urban &= ~water
    masks = {
        'land': ~water,
        'farm': g == G['farm'],
        'wetland': g == G['wetland'],
        'dirt': g == G['dirt'],
        'urban': urban,
        'paved': g == G['paved'],
        'park': np.isin(g, (G['park'], G['sport'])),
        'sand': g == G['sand'],
    }
    return masks


def vectorize_areas(masks, world, packer):
    x0, z0 = world['bounds'][0], world['bounds'][1]
    ts = world['ts']
    meta = {}
    for li, L in enumerate(AREA_LODS):
        t0 = time.time()
        f, cell = L['f'], L['cell']
        px = ts * f
        cols, rows = grid_dims(cell, packer.bounds)
        cpx = int(round(cell / px))
        ov = 3
        parts = []
        min_px = max(1, int(L['min_area'] / (px * px)))
        for ci, name in enumerate(AREA_CLASSES):
            m = masks[name].astype(np.float32)
            if f > 1:
                m = cv2.resize(m, (m.shape[1] // f, m.shape[0] // f), interpolation=cv2.INTER_AREA)
            mb = clean_mask(m > 0.5, min_px)
            field = cv2.GaussianBlur(mb.astype(np.float32), (0, 0), L['sigma']) if L['sigma'] > 0 else mb.astype(np.float32)
            H, W = field.shape
            for r in range(rows):
                for c in range(cols):
                    r0, c0 = r * cpx - ov, c * cpx - ov
                    r1, c1 = (r + 1) * cpx + ov, (c + 1) * cpx + ov
                    rr0, cc0, rr1, cc1 = max(0, r0), max(0, c0), min(H, r1), min(W, c1)
                    if rr1 <= rr0 or cc1 <= cc0:
                        continue
                    win = field[rr0:rr1, cc0:cc1]
                    if win.max() < 0.5:
                        continue
                    if name == 'land' and win.min() >= 0.5:
                        # fully inside: a plain rectangle (clipped to the window)
                        rect = np.array([[rr0 - 0.5, cc0 - 0.5], [rr0 - 0.5, cc1 - 0.5], [rr1 - 0.5, cc1 - 0.5], [rr1 - 0.5, cc0 - 0.5]])
                        contours = [rect - [rr0 - 1, cc0 - 1]]
                    else:
                        padded = np.pad(win, 1)
                        contours = measure.find_contours(padded, 0.5)
                    cell_id = r * cols + c
                    for cnt in contours:
                        # (row, col) in padded window -> world
                        gr = cnt[:, 0] - 1 + rr0
                        gc = cnt[:, 1] - 1 + cc0
                        pts = np.stack([x0 + (gc + 0.5) * px, z0 + (gr + 0.5) * px], 1)
                        if len(pts) > 2 and np.allclose(pts[0], pts[-1]):
                            pts = pts[:-1]
                        pts = simplify(pts, L['tol'], True)
                        if len(pts) < 3 or abs(ring_area(pts)) < L['min_area'] * 0.6:
                            continue
                        parts.append((cell_id, ci, 0, pts))
        m = packer.geometry(f'a{li}', parts, dict(kind='area', cell=cell, cols=cols, rows=rows, tol=L['tol']))
        meta[f'a{li}'] = m
        log(f'areas LOD{li}: {m["parts"]} rings, {m["points"]} pts, {time.time() - t0:.1f}s')
    return meta



def vectorize_depth(heights, world, packer):
    """Nested regions 'height > level' for each depth level (shallower than the level, land included)."""
    x0, z0 = world['bounds'][0], world['bounds'][1]
    hs = world['hs']
    meta = {}
    for li, L in enumerate(DEPTH_LODS):
        t0 = time.time()
        f, cell = L['f'], L['cell']
        px = hs * f
        field = heights.astype(np.float32)
        if f > 1:
            field = cv2.resize(field, (field.shape[1] // f, field.shape[0] // f), interpolation=cv2.INTER_AREA)
        field = cv2.GaussianBlur(field, (0, 0), L['sigma'])
        H, W = field.shape
        cols, rows = grid_dims(cell, packer.bounds)
        cpx = int(round(cell / px))
        ov = 3
        parts = []
        for ci, level in enumerate(DEPTH_LEVELS):
            for r in range(rows):
                for c in range(cols):
                    rr0, cc0 = max(0, r * cpx - ov), max(0, c * cpx - ov)
                    rr1, cc1 = min(H, (r + 1) * cpx + ov), min(W, (c + 1) * cpx + ov)
                    if rr1 <= rr0 or cc1 <= cc0:
                        continue
                    win = field[rr0:rr1, cc0:cc1]
                    if win.max() <= level:
                        continue
                    contours = measure.find_contours(np.pad(win, 1, constant_values=-1000), level)
                    for cnt in contours:
                        gr = cnt[:, 0] - 1 + rr0
                        gc = cnt[:, 1] - 1 + cc0
                        # height samples sit on grid points (no half-pixel offset at f = 1)
                        pts = np.stack([x0 + (gc + (f - 1) / (2 * f)) * px, z0 + (gr + (f - 1) / (2 * f)) * px], 1)
                        if len(pts) > 2 and np.allclose(pts[0], pts[-1]):
                            pts = pts[:-1]
                        pts = simplify(pts, L['tol'], True)
                        if len(pts) < 3 or abs(ring_area(pts)) < L['min_area']:
                            continue
                        parts.append((r * cols + c, ci, 0, pts))
        m = packer.geometry(f'w{li}', parts, dict(kind='depth', cell=cell, cols=cols, rows=rows, tol=L['tol']))
        meta[f'w{li}'] = m
        log(f'depth LOD{li}: {m["parts"]} rings, {m["points"]} pts, {time.time() - t0:.1f}s')
    return meta

# ----------------------------------------------------------------------------------------------------------------
# ================================================================================================================
# Road network for the map. The graph is vectorised from the fan map's raster, so it is noisy: carriageways that
# touch in the raster get one 44 m wide centreline, bridges over water get the highway colour, causeways have
# gaps, streets stop a few metres short of the road they meet. Everything here only shapes what the map draws;
# the game's road graph (public/data/roads.json, src/world/Roads.js) is not changed.
#
#   1. airside: runways / taxiways (as src/air/runways.js + Roads.markAirside)
#   2. tunnel interiors (as Roads.findTunnels); surface gaps are owned by export.py
#   3. kind smoothing: tiny isolated "highway" networks become roads, short class runs inside a continuous
#      stroke take the class of their neighbours (majority with a minimum run length)
#   4. strokes: edges chained through straight continuations; highway strokes -> mainline / ramp roles,
#      street strokes -> one class and one width per run
#   5. drawn widths: generalised carriageway widths (ramps narrower), limited by the clearance to a parallel
#      carriageway so divided highways stay two separate lines
#   6. levels: flat highway crossings lifted onto overpasses (as Roads.gradeSeparate) + bridge decks
#   7. centreline endpoints remain exactly those in roads.json (shared 3D/map truth)
#   8. output: polylines merged along strokes, split (mid-segment, so tangents stay continuous) where the
#      class / level / bridge / width changes
# ================================================================================================================
AIRPORTS = [  # as in src/air/runways.js
    ('Vice City International Airport', -2146, 724, 1700),
    ('Goose Key Airfield', -6900, 6550, 1100),
    ('Keys Airfield', -5400, 6900, 1500),
]
GAP_MAX = 75.0          # facing dead ends closer than this are joined on the map (causeway / drawbridge gaps)
SNAP_MAX = 26.0         # a dead end this close (along its direction) to another road is extended to meet it


def _cum(p):
    return np.r_[0.0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))] if len(p) > 1 else np.zeros(1)


def _unit(v):
    n = float(np.hypot(v[0], v[1]))
    return v / n if n > 1e-9 else np.array([1.0, 0.0])


class RoadNet:
    """Mutable copy of the road graph with per-vertex flags (br = bridge deck, lift = overpass lift in m)."""

    def __init__(self, roads, height_at):
        self.height_at = height_at
        self.nodes = [np.array(n, np.float64) for n in roads['nodes']]
        self.E = []
        for e in roads['edges']:
            p = np.array(e['p'], np.float64).reshape(-1, 2)
            n = len(p)
            if n < 2:
                continue
            y = np.array(e['y'], np.float64) if e.get('y') is not None and len(e['y']) == n else np.array([height_at(*q) for q in p])
            has_br = bool(e.get('br'))
            br = np.array(e['br'], bool) if has_br and len(e['br']) == n else np.zeros(n, bool)
            # roads.json `w` is already the generalised width (export.py runs classify()); generalise from the raw `w0`
            self.add(e['a'], e['b'], e['k'], float(e.get('w0', e['w'])), p, y, br, has_br=has_br)
        self.rebuild()

    def add(self, a, b, k, w, p, y, br, **kw):
        e = dict(i=len(self.E), a=a, b=b, k=k, k0=k, w=w, p=p, y=np.array(y, np.float64), br=np.array(br, bool),
                 lift=np.zeros(len(p)), has_br=False, lifted=False, tunnel=False, gap=False, air=None,
                 cls=None, ramp=False, mw=w)
        e.update(kw)
        self.refresh(e)
        self.E.append(e)
        return e

    @staticmethod
    def refresh(e):
        e['cum'] = _cum(e['p'])
        e['len'] = float(e['cum'][-1])

    def rebuild(self):
        self.adj = [[] for _ in self.nodes]
        for e in self.E:
            self.adj[e['a']].append(e['i'])
            if e['b'] != e['a']:
                self.adj[e['b']].append(e['i'])

    def point_at(self, e, s):
        cum = e['cum']
        s = min(max(s, 0.0), e['len'])
        k = int(np.searchsorted(cum, s, side='right')) - 1
        k = min(max(k, 0), len(cum) - 2)
        seg = (cum[k + 1] - cum[k]) or 1.0
        t = (s - cum[k]) / seg
        return e['p'][k] + (e['p'][k + 1] - e['p'][k]) * t, e['y'][k] + (e['y'][k + 1] - e['y'][k]) * t

    def arm_dir(self, e, ni, dist=12.0):
        """unit direction of edge e leaving node ni, measured `dist` m out (as Roads.armDir)"""
        s = min(dist, e['len'] * 0.5)
        q, _ = self.point_at(e, s if e['a'] == ni else e['len'] - s)
        return _unit(q - self.nodes[ni])

    def end_info(self, e, at_a, back=25.0):
        p, y = self.point_at(e, 0.0 if at_a else e['len'])
        b = min(back, e['len'])
        q, _ = self.point_at(e, b if at_a else e['len'] - b)
        return p, y, _unit(p - q)


# ---- 1. airside -------------------------------------------------------------------------------------------------
def _fit_line(pts):
    c = pts.mean(0)
    d = pts - c
    a = 0.5 * math.atan2(2 * float((d[:, 0] * d[:, 1]).sum()), float((d[:, 0] ** 2).sum() - (d[:, 1] ** 2).sum()))
    return c, np.array([math.cos(a), math.sin(a)])


def detect_airside(net):
    cands = []
    for e in net.E:
        if e['w'] < 38 or e['len'] < 150:
            continue
        n = len(e['p'])
        k0, k1 = int(n * 0.08), int(math.ceil(n * 0.92))
        k1 = min(max(k1, k0 + 2), n)
        pts, ys = e['p'][k0:k1], e['y'][k0:k1]
        if len(pts) < 2:
            continue
        c, d = _fit_line(pts)
        nrm = np.array([-d[1], d[0]])
        rms = math.sqrt(float(np.mean(((pts - c) @ nrm) ** 2)))
        if rms > 9:
            continue
        off = np.abs((e['p'] - c) @ nrm)
        t = (e['p'] - c) @ d
        sel = off <= 14
        if not sel.any():
            continue
        cands.append(dict(c=c, d=d, tmin=float(t[sel].min()), tmax=float(t[sel].max()), w=e['w'], y=float(np.median(ys)),
                          yr=float(ys.max() - ys.min()), rms=rms, pts=pts))
    merged = True
    while merged:
        merged = False
        for i in range(len(cands)):
            for j in range(i + 1, len(cands)):
                A, B = cands[i], cands[j]
                if abs(float(A['d'] @ B['d'])) < math.cos(0.09):
                    continue
                nA = np.array([-A['d'][1], A['d'][0]])
                if abs(float((B['c'] - A['c']) @ nA)) > 16:
                    continue
                s = -1 if float(B['d'] @ A['d']) < 0 else 1
                tb = float((B['c'] - A['c']) @ A['d'])
                b0, b1 = tb + min(B['tmin'] * s, B['tmax'] * s), tb + max(B['tmin'] * s, B['tmax'] * s)
                if max(A['tmin'] - b1, b0 - A['tmax']) > 150:
                    continue
                pts = np.vstack([A['pts'], B['pts']])
                c, d = _fit_line(pts)
                ends = np.array([A['c'] + A['d'] * A['tmin'], A['c'] + A['d'] * A['tmax'], B['c'] + B['d'] * B['tmin'], B['c'] + B['d'] * B['tmax']])
                t = (ends - c) @ d
                cands[i] = dict(c=c, d=d, tmin=float(t.min()), tmax=float(t.max()), w=max(A['w'], B['w']), y=(A['y'] + B['y']) / 2,
                                yr=max(A['yr'], B['yr']), rms=max(A['rms'], B['rms']), pts=pts)
                cands.pop(j)
                merged = True
                break
            if merged:
                break
    rws = []
    for c in cands:
        L = c['tmax'] - c['tmin']
        mid = c['c'] + c['d'] * (c['tmin'] + c['tmax']) / 2
        ap = any(math.hypot(mid[0] - x, mid[1] - z) < r for _, x, z, r in AIRPORTS)
        if (L >= 600) if ap else (L >= 1000 and c['rms'] < 3 and c['yr'] < 4):
            rws.append(dict(c=mid, d=c['d'], n=np.array([-c['d'][1], c['d'][0]]), len=L, w=c['w']))

    def share(e, lat, ext):
        inside = np.zeros(len(e['p']), bool)
        for r in rws:
            q = e['p'] - r['c']
            inside |= (np.abs(q @ r['d']) < r['len'] / 2 + ext) & (np.abs(q @ r['n']) < lat(r))
        return float(inside.mean())

    nr = na = 0
    if rws:
        for e in net.E:
            if e['w'] >= 30 and share(e, lambda r: r['w'] / 2 + 6, 30) > 0.7:
                e['air'] = 'runway'
                nr += 1
            elif share(e, lambda r: 160, 60) > 0.6:
                e['air'] = 'taxi'
                na += 1
    log(f'airside: {len(rws)} runways, {nr} runway edges, {na} taxiway edges')
    return rws


# ---- 2. tunnels + gaps -----------------------------------------------------------------------------------------
def _hermite(A, B, L, step=7.0):
    n = max(6, int(math.ceil(L / step)))
    t = np.linspace(0, 1, n + 1)
    t2, t3 = t * t, t * t * t
    h00, h10, h01, h11 = 2 * t3 - 3 * t2 + 1, t3 - 2 * t2 + t, -2 * t3 + 3 * t2, t3 - t2
    t0, t1 = A['d'] * L * 0.5, -B['d'] * L * 0.5
    pts = h00[:, None] * A['p'] + h10[:, None] * t0 + h01[:, None] * B['p'] + h11[:, None] * t1
    y = A['y'] + (B['y'] - A['y']) * (0.5 - 0.5 * np.cos(np.pi * t))
    return pts, y


def close_gaps(net, tunnels_only=False):
    deg = [len(a) for a in net.adj]
    ends = []
    for e in net.E:
        if e['a'] == e['b'] or e['len'] < 12:
            continue
        for at_a in (True, False):
            ni = e['a'] if at_a else e['b']
            if deg[ni] != 1:
                continue
            p, y, d = net.end_info(e, at_a)
            ends.append(dict(e=e, ni=ni, p=p, y=y, d=d, used=False))
    if len(ends) < 2:
        return 0, 0
    tree = cKDTree(np.array([en['p'] for en in ends]))
    cands = []
    for i, j in tree.query_pairs(1300.0):
        A, B = ends[i], ends[j]
        if A['e'] is B['e'] or (A['e']['k'] == 'dirt') != (B['e']['k'] == 'dirt'):
            continue
        v = B['p'] - A['p']
        L = float(np.hypot(*v))
        if L < 0.5:
            continue
        u = v / L
        ca, cb = float(A['d'] @ u), float(-(B['d'] @ u))
        if 60 <= L and A['e']['len'] >= 30 and B['e']['len'] >= 30 and not A['e']['has_br'] and not B['e']['has_br'] \
                and ca >= 0.88 and cb >= 0.88 and abs(A['y'] - B['y']) / L <= 0.07:
            top, wet = -1e9, False
            for k in range(1, 24):
                g = net.height_at(*(A['p'] + v * (k / 24)))
                top = max(top, g)
                wet |= g < 0.2
            if not wet and top - max(A['y'], B['y']) >= 14:
                cands.append((L * (3 - ca - cb), 'tunnel', A, B, L))
                continue
        # Surface connectors belong to export.py, the shared authority for
        # both the driving mesh and cartography. The map only reconstructs
        # tunnel interiors, which Roads.findTunnels also adds at runtime.
        if not tunnels_only and L <= GAP_MAX and ca >= 0.8 and cb >= 0.8:
            cands.append((1e6 + L * (3 - ca - cb), 'gap', A, B, L))
    cands.sort(key=lambda c: c[0])
    nt = ng = 0
    for _, kind, A, B, L in cands:
        if A['used'] or B['used']:
            continue
        A['used'] = B['used'] = True
        pts, y = _hermite(A, B, L)
        k = 'road' if 'road' in (A['e']['k'], B['e']['k']) else A['e']['k']
        w = (A['e']['w'] + B['e']['w']) / 2
        if kind == 'tunnel':
            net.add(A['ni'], B['ni'], k, w, pts, y, np.zeros(len(pts), bool), tunnel=True)
            nt += 1
        else:
            wet = np.array([net.height_at(*q) < 0.3 for q in pts])
            br = wet | (A['e']['br'].any() and B['e']['br'].any())
            br[0] = br[-1] = bool(br[1:-1].any()) if len(br) > 2 else bool(br.any())
            net.add(A['ni'], B['ni'], k, w, pts, y, br, gap=True, has_br=bool(br.any()))
            ng += 1
    net.rebuild()
    log(f'tunnels {nt}, gaps closed {ng}')
    return nt, ng


# ---- 3./4. strokes and run smoothing ---------------------------------------------------------------------------
def build_strokes(net, ok, max_dev=32.0, key=None, same_key=False):
    """Chain edges through nodes: plain continuations at degree-2 nodes, the straightest pair of arms (deviation
    < max_dev degrees) at junctions. Returns lists of (edge index, forward)."""
    link = {}
    cos_lim = -math.cos(math.radians(max_dev))
    for ni in range(len(net.nodes)):
        inc = [ei for ei in net.adj[ni] if ok(net.E[ei]) and net.E[ei]['a'] != net.E[ei]['b']]
        if len(inc) < 2:
            continue
        arms = [(ei, 0 if net.E[ei]['a'] == ni else 1, net.arm_dir(net.E[ei], ni, 20.0)) for ei in inc]
        pairs = []
        if len(arms) == 2 and len(net.adj[ni]) == 2:
            if not same_key or key(net.E[arms[0][0]]) == key(net.E[arms[1][0]]):
                pairs = [(arms[0], arms[1])]
        else:
            cand = []
            for i in range(len(arms)):
                for j in range(i + 1, len(arms)):
                    c = float(arms[i][2] @ arms[j][2])
                    if c > cos_lim:
                        continue
                    same = key is None or key(net.E[arms[i][0]]) == key(net.E[arms[j][0]])
                    if same_key and not same:
                        continue
                    cand.append((c + (0.0 if same else 0.3), i, j))
            cand.sort()
            used = set()
            for _, i, j in cand:
                if i in used or j in used:
                    continue
                used.update((i, j))
                pairs.append((arms[i], arms[j]))
        for A, B in pairs:
            link[(A[0], A[1])] = (B[0], B[1])
            link[(B[0], B[1])] = (A[0], A[1])
    seen, strokes = set(), []
    for e in net.E:
        if e['i'] in seen or not ok(e):
            continue
        cur, cend, visited = e['i'], 0, {e['i']}
        while (cur, cend) in link:
            nx, nend = link[(cur, cend)]
            if nx in visited:
                break
            visited.add(nx)
            cur, cend = nx, 1 - nend
        seq, ei, enter = [], cur, cend
        while True:
            seen.add(ei)
            seq.append((ei, enter == 0))
            nxt = link.get((ei, 1 - enter))
            if nxt is None or nxt[0] in seen:
                break
            ei, enter = nxt
        strokes.append(seq)
    return strokes


def smooth_runs(net, strokes, get, put, min_mid, min_end):
    """Along each stroke, runs (same value) shorter than the minimum take the value of their longer neighbour."""
    changed_total = 0
    for seq in strokes:
        vals = [get(net.E[ei]) for ei, _ in seq]
        lens = [net.E[ei]['len'] for ei, _ in seq]
        while True:
            runs = []
            for idx, (v, L) in enumerate(zip(vals, lens)):
                if runs and runs[-1][0] == v:
                    runs[-1][1] += L
                    runs[-1][3] = idx
                else:
                    runs.append([v, L, idx, idx])
            if len(runs) < 2:
                break
            best = None
            for ri, r in enumerate(runs):
                lim = min_mid(r[0]) if 0 < ri < len(runs) - 1 else min_end(r[0])
                if r[1] < lim and (best is None or r[1] < best[1][1]):
                    best = (ri, r)
            if best is None:
                break
            ri, r = best
            nb = [runs[k] for k in (ri - 1, ri + 1) if 0 <= k < len(runs)]
            to = max(nb, key=lambda q: q[1])[0]
            for idx in range(r[2], r[3] + 1):
                vals[idx] = to
            changed_total += r[3] - r[2] + 1
        for (ei, _), v in zip(seq, vals):
            put(net.E[ei], v)
    return changed_total


def smooth_kinds(net):
    ground = lambda e: e['air'] is None and not e['tunnel']
    # tiny isolated highway networks (bridges / port roads drawn in the highway colour by the raster) -> road
    par = {}

    def find(a):
        while par.setdefault(a, a) != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    for e in net.E:
        if e['k'] == 'highway' and e['air'] is None:
            ra, rb = find(e['a']), find(e['b'])
            if ra != rb:
                par[ra] = rb
    comp = defaultdict(list)
    for e in net.E:
        if e['k'] == 'highway' and e['air'] is None:
            comp[find(e['a'])].append(e)
    demoted = 0
    for es in comp.values():
        if sum(e['len'] for e in es) < 450:
            for e in es:
                e['k'] = 'road'
                demoted += 1
    strokes = build_strokes(net, ground, key=lambda e: e['k'])
    mid = {'highway': 260.0, 'road': 160.0, 'dirt': 70.0}
    end = {'highway': 70.0, 'road': 45.0, 'dirt': 30.0}
    n = smooth_runs(net, strokes, lambda e: e['k'], lambda e, v: e.__setitem__('k', v), lambda v: mid[v], lambda v: end[v])
    log(f'kind smoothing: {demoted} edges of tiny highway networks -> road, {n} edges re-classed along strokes')


def classify(net):
    """cls per edge, highway roles (mainline / ramp), road classes and widths smoothed along strokes."""
    for e in net.E:
        if e['air'] == 'runway':
            e['cls'] = C_RWY
        elif e['air'] == 'taxi':
            e['cls'] = C_TAXI
        elif e['k'] == 'highway':
            e['cls'] = C_HW
        elif e['k'] == 'dirt':
            e['cls'] = C_PATH
        else:
            e['cls'] = C_PRI if e['w'] >= 16 else C_ST
    # streets: one class and width per run along each stroke
    is_road = lambda e: e['cls'] in (C_PRI, C_ST)
    strokes = build_strokes(net, is_road, key=lambda e: 0)
    smooth_runs(net, strokes, lambda e: e['cls'], lambda e, v: e.__setitem__('cls', v), lambda v: 170.0, lambda v: 60.0)
    for seq in strokes:
        runs = []
        for ei, _ in seq:
            e = net.E[ei]
            if runs and runs[-1][0] == e['cls']:
                runs[-1][1].append(e)
            else:
                runs.append((e['cls'], [e]))
        for cls, es in runs:
            ws = np.array([e['w'] for e in es])
            ls = np.array([max(e['len'], 1.0) for e in es])
            o = np.argsort(ws)
            c = np.cumsum(ls[o])
            wm = float(ws[o][np.searchsorted(c, c[-1] / 2)])
            # generalised: arterials 11-15 m, streets 6-11 m (always narrower than a highway carriageway)
            wm = min(max(0.55 * wm + 3.0, 11.0), 15.0) if cls == C_PRI else min(max(0.65 * wm + 1.5, 6.0), 11.0)
            for e in es:
                e['mw'] = wm
    for e in net.E:
        if e['cls'] == C_PATH:
            e['mw'] = min(max(e['w'], 4.0), 9.0)
        elif e['cls'] in (C_RWY, C_TAXI):
            e['mw'] = e['w'] if e['cls'] == C_RWY else min(max(e['w'] * 0.6, 8.0), 18.0)
    # highways: strokes -> mainline (long or wide) vs ramp / connector
    is_hw = lambda e: e['cls'] == C_HW
    hs = build_strokes(net, is_hw, max_dev=30.0)
    nm = nr = 0
    for seq in hs:
        es = [net.E[ei] for ei, _ in seq]
        L = sum(e['len'] for e in es)
        ws = np.array([e['w'] for e in es])
        wmed = float(np.median(ws))
        main = L >= 700 or (wmed >= 22 and L >= 250)
        if main:
            mw = min(max(0.3 * wmed + 6.0, 13.0), 18.0)
        else:
            mw = min(max(0.3 * wmed + 2.5, 7.0), 9.5)
        for e in es:
            e['ramp'] = not main
            e['mw'] = mw
            e['stroke'] = id(seq)
        nm += main
        nr += not main
    clearance_limit(net)
    log(f'classes: {Counter(ROAD_CLASSES[e["cls"]] for e in net.E)}; highway strokes {nm} mainline, {nr} ramps')
    return hs


def clearance_limit(net):
    """Divided highways: a carriageway is never drawn wider than the gap to its parallel twin allows."""
    S, D, OWN = [], [], []
    hw = [e for e in net.E if e['cls'] == C_HW]
    for e in hw:
        n = max(1, int(e['len'] // 6))
        for k in range(n):
            s = (k + 0.5) * e['len'] / n
            p, _ = net.point_at(e, s)
            q, _ = net.point_at(e, min(e['len'], s + 3))
            r, _ = net.point_at(e, max(0.0, s - 3))
            S.append(p)
            D.append(_unit(q - r))
            OWN.append((e['i'], s))
    if not S:
        return
    S, D = np.array(S), np.array(D)
    tree = cKDTree(S)
    near = tree.query_ball_point(S, 34.0)
    per = defaultdict(list)
    for idx, lst in enumerate(near):
        ei, s = OWN[idx]
        e = net.E[ei]
        if s < 22 or s > e['len'] - 22:
            continue
        best = None
        for j in lst:
            fj = OWN[j][0]
            if fj == ei:
                continue
            f = net.E[fj]
            if f['a'] in (e['a'], e['b']) or f['b'] in (e['a'], e['b']):
                continue
            if abs(float(D[idx] @ D[j])) < 0.9:
                continue
            d = float(np.hypot(*(S[j] - S[idx])))
            if best is None or d < best:
                best = d
        per[ei].append(best)
    n = 0
    for ei, lst in per.items():
        hits = [d for d in lst if d is not None]
        if len(hits) < max(2, 0.35 * len(lst)):
            continue
        lim = max(6.0, float(np.median(hits)) - 3.0)
        e = net.E[ei]
        if lim < e['mw']:
            e['mw'] = lim
            n += 1
    log(f'clearance-limited highway widths: {n} edges')


# ---- 6. grade separation (port of Roads.gradeSeparate) ---------------------------------------------------------
def _walk_chain(net, e0, ni, max_len, branching=True, d=0.0):
    steps, nodes, branches = [], [], []
    e, frm, seen = e0, ni, set()
    while e is not None and e['i'] not in seen and not e['lifted'] and (e is e0 or not e['has_br']):
        seen.add(e['i'])
        from_a = e['a'] == frm
        steps.append(dict(e=e, from_a=from_a, d0=d))
        d += e['len']
        if d >= max_len:
            break
        to = e['b'] if from_a else e['a']
        deg = len(net.adj[to])
        if deg == 2:
            nx = [ei for ei in net.adj[to] if ei != e['i']]
            if not nx:
                break
            nodes.append((to, d))
            e, frm = net.E[nx[0]], to
            continue
        if deg != 3 or not branching:
            break
        din = net.arm_dir(e, to)
        straight, bestc = None, -0.94
        for ei in net.adj[to]:
            if ei == e['i']:
                continue
            c = float(din @ net.arm_dir(net.E[ei], to))
            if c < bestc:
                bestc, straight = c, ei
        if straight is None:
            break
        side = [ei for ei in net.adj[to] if ei != e['i'] and ei != straight]
        if not side or net.E[side[0]]['a'] == net.E[side[0]]['b']:
            break
        nodes.append((to, d))
        branches.append(_walk_chain(net, net.E[side[0]], to, max_len, False, d))
        e, frm = net.E[straight], to
    return dict(steps=steps, nodes=nodes, branches=branches, len=d)


def grade_separate(net):
    H, RMP, RMP_MIN = 6.6, 140.0, 70.0
    n_over = 0
    for ni in range(len(net.nodes)):
        inc = list(net.adj[ni])
        if len(inc) != 4 or any(net.E[ei]['a'] == net.E[ei]['b'] or net.E[ei]['has_br'] or net.E[ei]['lifted'] or net.E[ei]['gap'] for ei in inc):
            continue
        dirs = [net.arm_dir(net.E[ei], ni) for ei in inc]
        best = None
        for i in range(4):
            for j in range(i + 1, 4):
                if net.E[inc[i]]['k0'] != 'highway' or net.E[inc[j]]['k0'] != 'highway':
                    continue
                c = float(dirs[i] @ dirs[j])
                if c < -0.94 and (best is None or c < best[0]):
                    best = (c, i, j)
        if not best:
            continue
        others = [k for k in range(4) if k not in (best[1], best[2])]
        hd = dirs[best[1]]
        if any(abs(float(hd @ dirs[k])) > 0.6 for k in others):
            continue
        flat = 10 + max(net.E[inc[k]]['w'] for k in others) / 2
        chains = [_walk_chain(net, net.E[inc[k]], ni, flat + RMP) for k in (best[1], best[2])]
        if any(c['len'] < flat + RMP_MIN for c in chains):
            continue
        ramp_of = lambda c: min(RMP, c['len'] - flat)
        if any(b['len'] < flat + ramp_of(c) or any(st['e']['k0'] == 'dirt' for st in b['steps']) for c in chains for b in c['branches']):
            continue

        def lifter(main):
            ramp = min(RMP, main['len'] - flat)
            return lambda d: H if d <= flat else (0.0 if d >= flat + ramp else H * 0.5 * (1 + math.cos(math.pi * (d - flat) / ramp)))
        too_steep = False
        for main in chains:
            lift = lifter(main)
            for ch in [main] + main['branches']:
                for st in ch['steps']:
                    e = st['e']
                    for k in range(len(e['p']) - 1):
                        ds = e['cum'][k + 1] - e['cum'][k]
                        if ds < 0.5:
                            continue
                        d0 = st['d0'] + (e['cum'][k] if st['from_a'] else e['len'] - e['cum'][k])
                        d1 = st['d0'] + (e['cum'][k + 1] if st['from_a'] else e['len'] - e['cum'][k + 1])
                        if abs(e['y'][k + 1] + lift(d1) - e['y'][k] - lift(d0)) / ds > 0.1:
                            too_steep = True
                            break
                    if too_steep:
                        break
                if too_steep:
                    break
            if too_steep:
                break
        if too_steep:
            continue
        nj = len(net.nodes)
        net.nodes.append(net.nodes[ni].copy())
        net.adj.append([])
        for k in (best[1], best[2]):
            e = net.E[inc[k]]
            if e['a'] == ni:
                e['a'] = nj
            else:
                e['b'] = nj
            net.adj[nj].append(e['i'])
        net.adj[ni] = [inc[k] for k in others]
        for main in chains:
            lift = lifter(main)
            for ch in [main] + main['branches']:
                for st in ch['steps']:
                    e = st['e']
                    e['lifted'] = True
                    e['has_br'] = True
                    for k in range(len(e['p'])):
                        dl = lift(st['d0'] + (e['cum'][k] if st['from_a'] else e['len'] - e['cum'][k]))
                        if dl > 0:
                            e['y'][k] += dl
                            e['lift'][k] += dl
        n_over += 1
    log(f'overpasses: {n_over}')
    return n_over


# ---- 7. dead ends that stop just short of another road ---------------------------------------------------------
def snap_dead_ends(net):
    """A dead end that stops just short of another road (raster breaks: T-junctions a few metres short, a street
    broken into two side-by-side stubs) is extended to meet it: first along its own direction (ray), else to the
    nearest point of a road beside / ahead of it. Genuine dead ends (nothing within reach) keep their round cap."""
    segs, owner = [], []
    for e in net.E:
        if e['tunnel'] or e['cls'] == C_RWY:
            continue
        p = e['p']
        for k in range(len(p) - 1):
            segs.append((p[k], p[k + 1]))
            owner.append((e['i'], k))
    if not segs:
        return 0
    A = np.array([q[0] for q in segs])
    B = np.array([q[1] for q in segs])
    tree = cKDTree((A + B) / 2)
    half = float((np.hypot(*(B - A).T) / 2).max())
    deg = [len(a) for a in net.adj]
    n_ray = n_side = 0
    for e in net.E:
        if e['tunnel'] or e['cls'] == C_RWY or e['a'] == e['b'] or e['len'] < 8:
            continue
        for at_a in (True, False):
            ni = e['a'] if at_a else e['b']
            if deg[ni] != 1:
                continue
            p, y, d = net.end_info(e, at_a, 12.0)
            reach = min(SNAP_MAX, 6.0 + 0.5 * e['mw'] + 10.0)
            ray, side = None, None
            for si in tree.query_ball_point(p, reach + 12.0 + half):
                fi, k = owner[si]
                if fi == e['i']:
                    continue
                f = net.E[fi]
                if f['tunnel'] or abs(f['y'][k] - y) > 3.5:
                    continue
                a_, b_ = A[si], B[si]
                v = b_ - a_
                # (1) ray along the end direction
                den = d[0] * v[1] - d[1] * v[0]
                if abs(den) > 1e-6:
                    w_ = a_ - p
                    t = (w_[0] * v[1] - w_[1] * v[0]) / den
                    u = (w_[0] * d[1] - w_[1] * d[0]) / den
                    if -0.02 <= u <= 1.02 and 0.3 < t <= min(reach + 0.5 * f['mw'], SNAP_MAX + 8) and (ray is None or t < ray[0]):
                        ray = (t, p + d * t)
                # (2) nearest point beside / ahead (not behind the end)
                L2 = float(v @ v) or 1e-9
                tt = min(1.0, max(0.0, float((p - a_) @ v) / L2))
                q = a_ + v * tt
                dq = float(np.hypot(*(q - p)))
                lim = max(9.0, 0.5 * (e['mw'] + f['mw']) + 6.0)
                if dq < 0.3 or dq > lim:
                    continue
                if float((q - p) @ d) / dq < -0.35:
                    continue
                if side is None or dq < side[0]:
                    side = (dq, q)
            hit = ray[1] if ray is not None else side[1] if side is not None else None
            if hit is None:
                continue
            if ray is not None:
                n_ray += 1
            else:
                n_side += 1
            if at_a:
                e['p'] = np.vstack([hit, e['p']])
                e['y'] = np.r_[e['y'][0], e['y']]
                e['br'] = np.r_[e['br'][0], e['br']]
                e['lift'] = np.r_[e['lift'][0], e['lift']]
            else:
                e['p'] = np.vstack([e['p'], hit])
                e['y'] = np.r_[e['y'], e['y'][-1]]
                e['br'] = np.r_[e['br'], e['br'][-1]]
                e['lift'] = np.r_[e['lift'], e['lift'][-1]]
            RoadNet.refresh(e)
    log(f'dead ends extended to the road they meet: {n_ray} straight on, {n_side} sideways')
    return n_ray + n_side


# ---- 8. output polylines ---------------------------------------------------------------------------------------
def apply_overpasses(net, crossings):
    """Apply the shared export.py crossing levels to map strokes.

    Previously the map skipped its legacy gradeSeparate when this array was
    present but never consumed it, so some upper decks were drawn as ground
    streets even though map_sync.mjs and the 3D scene separated them.
    """
    for o in crossings:
        r2 = (o['radius'] + 12.0) ** 2
        for ei in o.get('upper', ()):
            e = net.E[ei]
            near = np.sum((e['p'] - [o['x'], o['z']]) ** 2, axis=1) <= r2
            e['lift'][near] = np.maximum(e['lift'][near], o.get('clearance', 7.4))


def _seg_attrs(e):
    """per-segment draw attributes (cls flags, width dm)"""
    n = len(e['p'])
    lv = e['lift'] > 2.5
    out = []
    for k in range(n - 1):
        if e['tunnel']:
            level = -1
        else:
            level = 1 if (lv[k] and lv[k + 1]) else 0
        br = bool(e['br'][k] and e['br'][k + 1]) and not e['tunnel']
        if br and level == 0:
            level = 1
        flags = e['cls'] | (BRIDGE if br else 0) | ((level + 1) << LEVEL_SHIFT) | (RAMP if e['ramp'] else 0) | (TUNNEL if e['tunnel'] else 0)
        out.append((flags, int(round(e['mw'] * 10))))
    return out


def road_polylines(net):
    """Merged output polylines: list of (flags, width_dm, pts). Split mid-segment where attributes change."""
    key = lambda e: (e['cls'], e['ramp'], int(round(e['mw'])), e['tunnel'])
    strokes = build_strokes(net, lambda e: True, max_dev=28.0, key=key, same_key=True)
    out = []
    for seq in strokes:
        pts, attrs = [], []
        for ei, fwd in seq:
            e = net.E[ei]
            p = e['p'] if fwd else e['p'][::-1]
            a = _seg_attrs(e)
            if not fwd:
                a = a[::-1]
            if pts:
                if np.hypot(*(pts[-1] - p[0])) > 0.5:
                    # not connected (should not happen): flush
                    out.extend(_split_runs(np.array(pts), attrs))
                    pts, attrs = [], []
                else:
                    p = p[1:]
            pts.extend(p)
            attrs.extend(a)
        if len(pts) >= 2:
            P = np.array(pts)
            _taper_ends(net, seq, P, attrs)
            out.extend(_split_runs(P, attrs))
    return out


def _taper_ends(net, seq, P, attrs, taper=14.0):
    """A wide road ending at a junction where only narrower roads continue would show its round cap as a bulb:
    its last metres are drawn at the width of the widest road it meets instead."""
    if len(P) < 3:
        return
    mine = {ei for ei, _ in seq}
    first, last = seq[0], seq[-1]
    ends = [(net.E[first[0]]['a'] if first[1] else net.E[first[0]]['b'], False),
            (net.E[last[0]]['b'] if last[1] else net.E[last[0]]['a'], True)]
    seg = np.hypot(*np.diff(P, axis=0).T)
    for node, at_end in ends:
        others = [net.E[ei] for ei in net.adj[node] if ei not in mine]
        if not others:
            continue  # dead end: the round cap is right
        wo = max(int(round(o['mw'] * 10)) for o in others if not o['tunnel']) if any(not o['tunnel'] for o in others) else None
        if wo is None:
            continue
        idx = range(len(attrs) - 1, -1, -1) if at_end else range(len(attrs))
        acc = 0.0
        for k in idx:
            fl, wdm = attrs[k]
            if wdm <= wo + 30 or acc >= taper:
                break
            attrs[k] = (fl, max(wo, int(wdm * 0.6)))
            acc += seg[k]


def _split_runs(P, attrs):
    out = []
    if len(P) < 2 or not attrs:
        return out
    start = 0
    head = P[0:1]
    k = 1
    while k <= len(attrs):
        if k == len(attrs) or attrs[k] != attrs[start]:
            if k == len(attrs):
                body = np.vstack([head, P[start + 1:k + 1]])
                out.append((attrs[start][0], attrs[start][1], body))
                break
            # split in the middle of segment k so both runs share the tangent at the cut
            m = (P[k] + P[k + 1]) / 2
            body = np.vstack([head, P[start + 1:k + 1], m[None]])
            out.append((attrs[start][0], attrs[start][1], body))
            head = m[None]
            start = k
        k += 1
    return [o for o in out if len(o[2]) >= 2 and _cum(o[2])[-1] > 0.3]


def clean_bridges(net, min_len=30.0):
    """bridge runs shorter than min_len (culverts, raster specks) are drawn as plain road"""
    n = 0
    for e in net.E:
        br = e['br']
        if not br.any():
            continue
        k = 0
        while k < len(br):
            if not br[k]:
                k += 1
                continue
            j = k
            while j + 1 < len(br) and br[j + 1]:
                j += 1
            if e['cum'][j] - e['cum'][k] < min_len:
                br[k:j + 1] = False
                n += 1
            k = j + 1
    log(f'short bridge runs dropped: {n}')


def build_roads(roads, packer, height_at, geom=None, extra=()):
    t0 = time.time()
    net = RoadNet(roads, height_at)
    detect_airside(net)
    close_gaps(net, tunnels_only=True)
    clean_bridges(net)
    smooth_kinds(net)
    classify(net)
    keys = assign_routes(net)
    if 'overpasses' not in roads:
        grade_separate(net)
    else:
        apply_overpasses(net, roads['overpasses'])
    # Do not snap or extend dead ends here. roads.json is the single source of
    # centreline truth; independent map-only edits used to diverge from the
    # surface on which vehicles actually drive.
    lines = road_polylines(net) + list(extra)  # extra: park footpaths (tools/parks.py)
    if geom:
        lines = airside_from_landmarks(lines, geom)
    log(f'road polylines: {len(lines)} (from {len(net.E)} edges), {time.time() - t0:.1f}s')
    meta = {}
    for li, L in enumerate(ROAD_LODS):
        cols, rows = grid_dims(L['cell'], packer.bounds)
        parts = []
        for flags, wdm, pts in lines:
            cls = flags & 15
            if cls not in L['classes'] or ((flags & RAMP) and not L['ramps']):
                continue
            sp = simplify(pts, L['tol'], False)
            mid = (sp.min(0) + sp.max(0)) / 2
            parts.append((cell_index(mid[0], mid[1], L['cell'], packer.bounds), flags, wdm, sp))
        parts.sort(key=lambda p: p[0])
        m = packer.geometry(f'r{li}', parts, dict(kind='road', cell=L['cell'], cols=cols, rows=rows, tol=L['tol']))
        meta[f'r{li}'] = m
        log(f'roads LOD{li}: {m["parts"]} parts, {m["points"]} pts')
    routes, rtmeta, exits = route_geometry(net, packer, keys)
    meta.update(rtmeta)
    # per-edge geometry for street naming: (cls, width, pts, edge index, is_bridge)
    parts_all = [(e['cls'], e['mw'], e['p'], e['i'], bool(e['br'].any())) for e in net.E if not e['tunnel']]
    return meta, parts_all, routes, exits


# ---- route shields and exits ------------------------------------------------------------------------------------
# Route numbers as printed on the fan map's own shields (YANIS v17 raster tiles, zoom 5): kind, number, world x, z.
# I = interstate, US = US route, SR = state road. Shield positions were found by colour (red/blue interstate shield,
# white US shield, white state square) and the numbers read off each shield; the JSON cache has no route data.
ROUTE_SEEDS = [
    ('I', '297', -2539, -7889), ('I', '297', -1485, -7418), ('I', '297', -3723, -7266), ('I', '297', -1015, -6966),
    ('I', '297', -1359, -6315),
    ('I', '97', -4056, -5888), ('I', '97', -512, -5754), ('I', '97', -2910, -5702), ('I', '97', 128, -3074),
    ('I', '97', -977, 92), ('I', '97', -1195, 969), ('I', '97', -2136, 2732),
    ('I', '404', -6246, -4193), ('I', '404', -6301, -3425), ('I', '404', -6308, -2649), ('I', '404', -6370, -1309),
    ('I', '404', -5985, -647), ('I', '404', -4675, -315), ('I', '404', -3300, -241), ('I', '404', -2084, -250),
    ('I', '404', -1032, -550), ('I', '404', -475, -605), ('I', '404', 16, -530), ('I', '404', 1242, -110),
    ('I', '397', -756, 360), ('I', '397', -293, 442), ('I', '397', 210, 563), ('I', '397', 779, 827),
    ('I', '397', 912, 1309), ('I', '397', 847, 1903), ('I', '397', 95, 2017),
    ('US', '1', -2486, 4221), ('US', '1', -2068, 5517), ('US', '1', -4924, 7233),
    ('US', '3', 214, -3958), ('US', '3', 257, -3336), ('US', '3', 106, -2747), ('US', '3', -23, -2305),
    ('US', '3', -161, -1897), ('US', '3', -488, -855), ('US', '3', -430, -533), ('US', '3', -416, -269),
    ('US', '3', -432, 119), ('US', '3', -443, 466), ('US', '3', -567, 811), ('US', '3', -870, 1197),
    ('US', '3', -1122, 1819), ('US', '3', -1338, 2231),
    ('US', '5', 1147, -2651), ('US', '5', 1552, -2293), ('US', '5', 1827, -1943),
    ('US', '35', -2808, -5493), ('US', '35', -2743, -4917), ('US', '35', -2836, -4389), ('US', '35', -2607, -3945),
    ('US', '35', -2672, -3515), ('US', '35', -2849, -2851), ('US', '35', -2871, -1451), ('US', '35', -2966, -923),
    ('US', '35', -2064, 95), ('US', '35', -1497, 498), ('US', '35', -1531, 1307),
    ('US', '50', -4248, -5773), ('US', '50', -4791, -5415),
    ('US', '70', -5064, -4441), ('US', '70', -4562, -3777), ('US', '70', -3566, -3243), ('US', '70', -2106, -2919),
    ('US', '70', -1463, -3185), ('US', '70', -752, -3143), ('US', '70', -195, -3411), ('US', '70', 68, -3945),
    ('US', '82', -6872, 73), ('US', '82', -6696, 148), ('US', '82', -5951, 1061), ('US', '82', -5384, 1473),
    ('US', '82', -4510, 1737), ('US', '82', -4048, 2305), ('US', '82', -3235, 2883), ('US', '82', -2354, 2906),
    ('US', '183', -6161, -3950), ('US', '183', -5527, -3651), ('US', '183', -5131, -3151), ('US', '183', -5213, -1225),
    ('US', '183', -5839, -694),
    ('SR', '41', -1351, -2489), ('SR', '61', -2433, 2739), ('SR', '91', -674, -3967), ('SR', '120', -753, -2706),
]
ROUTE_KINDS = ['I', 'US', 'SR']
ROUTE_CLAIM = 2600.0   # a shield claims its road this far along the stroke in both directions


def _stroke_index(strokes):
    idx = {}
    for si, seq in enumerate(strokes):
        for pos, (ei, fwd) in enumerate(seq):
            idx[ei] = (si, pos)
    return idx


def _claim(net, starts, ok, max_dev, limit, cost=lambda f: f['len'], gap_ok=None, gap_max=400.0, promote=None):
    """Follow the road from each start edge in both directions, always taking the straightest accepted
    continuation (turn <= max_dev degrees), up to `limit` metres. -> {edge: road distance from the shield}
    gap_ok: edges that may be crossed between two ok() edges (a highway the raster broke with a short 'road'
    piece); crossed runs (<= gap_max m) are claimed and added to `promote`, trailing ones are not."""
    dist = {}
    cos_max = math.cos(math.radians(max_dev))
    for e0 in starts:
        dist[e0['i']] = 0.0
        for out0 in (e0['a'], e0['b']):
            ei, out, c, seen = e0['i'], out0, e0['len'] / 2, {e0['i']}
            pending, plen = [], 0.0
            while c < limit:
                din = net.arm_dir(net.E[ei], out, 25.0)
                best, bs = None, cos_max
                for fi in net.adj[out]:
                    if fi in seen:
                        continue
                    f = net.E[fi]
                    if f['a'] == f['b'] or not (ok(f) or (gap_ok and gap_ok(f))):
                        continue
                    st = -float(din @ net.arm_dir(f, out, 25.0))
                    if ok(f):
                        st += 0.05  # prefer staying on the route's own kind of road
                    if st >= bs:
                        best, bs = fi, st
                if best is None:
                    break
                f = net.E[best]
                seen.add(best)
                fd = net.arm_dir(f, out, 25.0)
                if not ok(f):
                    # crossing a gap: it has to keep the heading it entered with (no wandering round blocks)
                    if not pending:
                        gap_dir = -din
                    elif float(gap_dir @ fd) < 0.82:
                        break
                if ok(f):
                    for pe, pc in pending:
                        if pc < dist.get(pe, 1e18):
                            dist[pe] = pc
                        if promote is not None:
                            promote.add(pe)
                    pending, plen = [], 0.0
                    if c < dist.get(best, 1e18):
                        dist[best] = c
                else:
                    pending.append((best, c))
                    plen += f['len']
                    if plen > gap_max:
                        break
                c += cost(f)
                out = f['b'] if f['a'] == out else f['a']
                ei = best
    return dist


def _route_path(net, starts, goals, factor, max_cost):
    """cheapest road path (edge indices) from any start edge to any goal edge; factor(edge) = cost per metre or
    None (not usable)"""
    import heapq
    dist, prev, h = {}, {}, []
    goal = {}
    for e in goals:
        goal[e['a']] = e['i']
        goal[e['b']] = e['i']
    for e in starts:
        if e['i'] in {g['i'] for g in goals}:
            return [e['i']]
        f0 = factor(e) or 1.0
        for n in (e['a'], e['b']):
            c = e['len'] * 0.5 * f0
            if c < dist.get(n, 1e18):
                dist[n] = c
                prev[n] = (None, e['i'])
                heapq.heappush(h, (c, n))
    while h:
        c, n = heapq.heappop(h)
        if c > dist.get(n, 1e18):
            continue
        if c > max_cost:
            return None
        if n in goal:
            out = [goal[n]]
            while n is not None:
                pn, ei = prev[n]
                out.append(ei)
                n = pn
            return out
        for ei in net.adj[n]:
            f = net.E[ei]
            fac = factor(f)
            if fac is None or f['a'] == f['b']:
                continue
            m = f['b'] if f['a'] == n else f['a']
            nc = c + f['len'] * fac
            if nc < dist.get(m, 1e18):
                dist[m] = nc
                prev[m] = (n, ei)
                heapq.heappush(h, (nc, m))
    return None


def assign_routes(net):
    """Route number per road edge (e['route'] = index into the returned keys), from the shield seeds. Highways an
    interstate runs on are mainline by definition (the stroke analysis may have called them ramps)."""
    drivable = lambda e: not e['tunnel'] and e['cls'] in (C_HW, C_PRI, C_ST)
    strokes = build_strokes(net, drivable, max_dev=30.0, key=lambda e: e['cls'] == C_HW)
    sidx = _stroke_index(strokes)
    S, OWN = [], []
    for e in net.E:
        if not drivable(e):
            continue
        n = max(1, int(e['len'] // 8))
        for k in range(n + 1):
            p, _ = net.point_at(e, k * e['len'] / n)
            S.append(p)
            OWN.append(e['i'])
    tree = cKDTree(np.array(S))
    keys = sorted({(k, n) for k, n, _, _ in ROUTE_SEEDS}, key=lambda r: (ROUTE_KINDS.index(r[0]), int(r[1])))
    rid = {k: i for i, k in enumerate(keys)}
    claims = defaultdict(dict)  # edge -> route -> best distance
    seed_edges = []
    interstate = set()
    bridged = set()  # road pieces an interstate runs across -> drawn as highway
    seeds = sorted(ROUTE_SEEDS, key=lambda t: t[0] != 'I')  # interstates first: US / state shields avoid them
    for kind, num, x, z in seeds:
        r = rid[(kind, num)]
        near = tree.query_ball_point([x, z], 60.0)
        if not near:
            log(f'route seed {kind}-{num} at {x},{z}: no road nearby')
            continue
        # expected direction: towards the nearest other shields of the same route
        mates = sorted((math.hypot(x2 - x, z2 - z), x2, z2) for k2, n2, x2, z2 in ROUTE_SEEDS
                       if (k2, n2) == (kind, num) and (x2, z2) != (x, z))
        dirs = [_unit(np.array([x2 - x, z2 - z])) for d2, x2, z2 in mates[:2] if d2 < 2500]
        scored = {}
        for j in near:
            e = net.E[OWN[j]]
            d = math.hypot(S[j][0] - x, S[j][1] - z)
            if kind == 'I':
                # shields sit on (or between) the carriageways: prefer long mainline pieces over rungs / links
                pen = (0 if not e['ramp'] else 0.6 if e['len'] > 150 else 1.2) if e['cls'] == C_HW else 3
            else:
                pen = 0 if e['cls'] in (C_HW, C_PRI) and not e['ramp'] else 1 if e['cls'] == C_ST else 2
                if e['i'] in interstate:
                    pen += 4
            if dirs:
                q, _ = net.point_at(e, 0.0)
                p2, _ = net.point_at(e, e['len'])
                t = _unit(p2 - q)
                al = max(abs(float(t @ dv)) for dv in dirs)
                pen += 0 if al > 0.75 else 1.5
            sc = pen * 60 + d
            if e['i'] not in scored or sc < scored[e['i']][0]:
                scored[e['i']] = (sc, d)
        order = sorted(scored.items(), key=lambda kv: kv[1][0])
        first = net.E[order[0][0]]
        chosen = [first]
        if first['cls'] == C_HW and kind == 'I':
            # the other carriageway of a divided highway: nearest parallel highway within 120 m (wide medians)
            def tangent(e):
                k = int(np.argmin(np.hypot(e['p'][:, 0] - x, e['p'][:, 1] - z)))
                a_, b_ = e['p'][max(0, k - 2)], e['p'][min(len(e['p']) - 1, k + 2)]
                return _unit(b_ - a_)
            t0 = tangent(first)
            twins = {}
            for j in tree.query_ball_point([x, z], 120.0):
                f = net.E[OWN[j]]
                if f['cls'] != C_HW or (f['ramp'] and f['len'] <= 150) or sidx[f['i']][0] == sidx[first['i']][0]:
                    continue
                d = math.hypot(S[j][0] - x, S[j][1] - z)
                if d < twins.get(f['i'], (1e9,))[0]:
                    twins[f['i']] = (d, f)
            for d, f in sorted(twins.values(), key=lambda t: t[0]):
                if abs(float(tangent(f) @ t0)) > 0.85:
                    chosen.append(f)
                    break
        seed_edges.append((kind, num, x, z, chosen))
        if kind == 'I':
            # interstates may run through short pieces the stroke analysis called ramps (messy junctions) and
            # across short pieces the raster drew as ordinary road
            ok = lambda f: f['cls'] == C_HW and not f['tunnel']
            gap = lambda f: f['cls'] in (C_PRI, C_ST) and not f['tunnel'] and (f['w'] >= 15 or f['len'] < 150)
            dist = _claim(net, chosen, ok, 42.0, ROUTE_CLAIM, gap_ok=gap, gap_max=900.0, promote=bridged)
        else:
            # US / state roads turn at junctions: claim the road between neighbouring shields (paths below) and
            # only a short straight run beyond the outermost ones
            ok = lambda f: f['cls'] in (C_HW, C_PRI, C_ST) and not f['ramp'] and not f['tunnel']
            dist = _claim(net, chosen, ok, 35.0, 450.0)
        for ei, d in dist.items():
            claims[ei][r] = min(claims[ei].get(r, 1e9), d)
            if kind == 'I' and d < 1500:
                interstate.add(ei)
        if kind == 'I':
            continue
    # the road between neighbouring shields of the same route (cheapest path, preferring the route's road class)
    fac_i = lambda f: None if f['tunnel'] or f['cls'] not in (C_HW, C_PRI, C_ST) else (1.4 if f['ramp'] else 1.0) if f['cls'] == C_HW else 4.0
    fac_us = lambda f: None if f['tunnel'] or f['cls'] not in (C_HW, C_PRI, C_ST) else 3.0 if f['ramp'] else 1.25 if f['cls'] == C_ST else 1.0
    npaths = 0
    for kind_num in keys:
        mine = [t for t in seed_edges if (t[0], t[1]) == kind_num]
        r = rid[kind_num]
        fac = fac_i if kind_num[0] == 'I' else fac_us
        done = set()
        for i, (k1, n1, x1, z1, ch1) in enumerate(mine):
            near = sorted(((math.hypot(x2 - x1, z2 - z1), j) for j, (k2, n2, x2, z2, ch2) in enumerate(mine) if j != i))
            for d12, j in near[:2]:
                if d12 > (2800 if kind_num[0] == 'I' else 2200) or (min(i, j), max(i, j)) in done:
                    continue
                done.add((min(i, j), max(i, j)))
                path = _route_path(net, ch1, mine[j][4], fac, 2.0 * d12 + 250)
                if not path:
                    continue
                npaths += 1
                for ei in path:
                    claims[ei][r] = min(claims[ei].get(r, 1e9), 0.0)
                    if kind_num[0] == 'I' and net.E[ei]['cls'] != C_HW:
                        bridged.add(ei)
    log(f'route shield-to-shield paths: {npaths}')
    # interstates keep their road; otherwise the nearest shield (along the road) wins
    owner = {}
    for ei, rs in claims.items():
        inter = {r: d for r, d in rs.items() if keys[r][0] == 'I'}
        if not inter and net.E[ei]['ramp']:
            continue
        owner[ei] = min((inter or rs).items(), key=lambda kv: kv[1])[0]
    promoted = 0
    for e in net.E:
        e['route'] = owner.get(e['i'])
        if e['i'] in bridged and e['route'] is not None and keys[e['route']][0] == 'I' and e['cls'] != C_HW:
            e['cls'], e['k'], e['ramp'] = C_HW, 'highway', True  # width / role fixed just below
        if e['route'] is not None and e['cls'] == C_HW and e['ramp']:
            e['ramp'] = False
            e['mw'] = min(max(0.3 * e['w'] + 6.0, 13.0), 18.0)
            promoted += 1
    log(f'route claims: {len(owner)} edges, {promoted} pieces promoted to highway mainline ({len(bridged)} were road)')
    return keys


def route_geometry(net, packer, keys):
    """rt set (shield paths, one polyline per continuous run of a route) + interstate exits"""
    t0 = time.time()
    routes, parts = [], []
    for r, (kind, num) in enumerate(keys):
        mine = lambda e, r=r: e.get('route') == r
        total = 0.0
        for seq in build_strokes(net, mine, max_dev=40.0):
            pts = []
            for ei, fwd in seq:
                p = net.E[ei]['p'] if fwd else net.E[ei]['p'][::-1]
                pts.extend(p if not pts else p[1:])
            P = np.array(pts)
            L = float(_cum(P)[-1]) if len(P) > 1 else 0.0
            if L < 120:
                continue
            total += L
            parts.append((r, ROUTE_KINDS.index(kind), 0, simplify(P, 3.0, False)))
        routes.append(dict(kind=kind, num=num, len=round(total)))
    m = packer.geometry('rt', parts, dict(kind='route'))
    exits = build_exits(net, keys)
    route_summary = ', '.join('{}-{} {} m'.format(r['kind'], r['num'], r['len']) for r in routes)
    log(f'routes: {len(routes)} ({route_summary}), '
        f'{m["parts"]} paths, {len(exits)} exits, {time.time() - t0:.1f}s')
    return routes, {'rt': m}, exits


def build_exits(net, keys):
    """Interchanges along each interstate, numbered from the south / west end; one marker per interchange, placed on
    a ramp just off the mainline."""
    out = []
    for r, (kind, num) in enumerate(keys):
        if kind != 'I':
            continue
        main = [e for e in net.E if e.get('route') == r and e['cls'] == C_HW]
        if not main:
            continue
        mnodes = set()
        for e in main:
            mnodes.update((e['a'], e['b']))
        junctions = []  # (node, ramp edge)
        for ni in mnodes:
            for ei in net.adj[ni]:
                f = net.E[ei]
                if f['cls'] == C_HW and f['ramp'] and f.get('route') is None and f['a'] != f['b']:
                    junctions.append((ni, f))
        if not junctions:
            continue
        P = np.array([net.nodes[ni] for ni, _ in junctions])
        # cluster junctions into interchanges
        groups = cluster_points(P, 380.0)
        allp = np.vstack([e['p'] for e in main])
        c, d = _fit_line(allp)
        if abs(d[1]) >= abs(d[0]):
            d = d if d[1] < 0 else -d        # north-south route: count from the south (large z)
        else:
            d = d if d[0] > 0 else -d        # east-west route: count from the west
        ranked = []
        for g in groups:
            cen = P[g].mean(0)
            # marker: the ramp junction nearest the interchange centre, 38 m out along that ramp
            best = min(g, key=lambda i: float(np.hypot(*(P[i] - cen))))
            ni, f = junctions[best]
            s = min(38.0, f['len'] * 0.5)
            q, _ = net.point_at(f, s if f['a'] == ni else f['len'] - s)
            ranked.append((float((cen - c) @ d), q))
        ranked.sort(key=lambda t: t[0])
        for k, (_, q) in enumerate(ranked):
            out.append([round(float(q[0]), 1), round(float(q[1]), 1), r, str(k + 1)])
    return out


# ---- landmarks (tools/cache/landmark_geom.json) ------------------------------------------------------------------
def load_landmark_geom():
    if not os.path.exists(LANDMARK_GEOM):
        log('no landmark_geom.json: road-graph runways, original footprints')
        return None
    g = json.load(open(LANDMARK_GEOM))
    log('landmark geometry:', g.get('stats'))
    return g


def _runway_axes(geom):
    out = []
    for r in geom.get('runways', []):
        o = np.array(r['outline'], np.float64)
        sides = [np.hypot(*(o[(i + 1) % 4] - o[i])) for i in range(4)]
        if sides[0] >= sides[1]:   # o0-o1 long side: ends are o3-o0 and o1-o2
            a, b, w = (o[0] + o[3]) / 2, (o[1] + o[2]) / 2, sides[1]
        else:
            a, b, w = (o[0] + o[1]) / 2, (o[2] + o[3]) / 2, sides[0]
        out.append((a, b, w))
    return out


def airside_from_landmarks(lines, geom):
    """Swap the road-graph runway / taxiway strokes (raster skeleton: wobbly, wrong width) for the landmark
    geometry: one straight runway-class stroke per runway rectangle (butt caps, dashed centre line close up) and
    the taxiway centrelines. Graph airside strokes are dropped near a landmark runway (within its length and
    250 m to the side); airfields without landmark runways keep theirs."""
    axes = _runway_axes(geom)
    if not axes:
        return lines

    def near_runway(P):
        m = P.mean(0)
        for a, b, w in axes:
            d = b - a
            L = np.hypot(*d)
            u = d / L
            q = m - a
            t, n = float(q @ u), abs(float(q[0] * u[1] - q[1] * u[0]))
            if -250 <= t <= L + 250 and n <= 250:
                return True
        return False
    kept = [ln for ln in lines if (ln[0] & 15) not in (C_RWY, C_TAXI) or not near_runway(ln[2])]
    ground = 1 << LEVEL_SHIFT
    add = [(C_RWY | ground, int(round(w * 10)), np.array([a, b])) for a, b, w in axes]
    for t in geom.get('taxiways', []):
        P = np.array(t['line'], np.float64)
        if len(P) >= 2:
            add.append((C_TAXI | ground, int(round(float(t.get('width', 18)) * 10)), P))
    log(f'airside from landmarks: {len(lines) - len(kept)} graph strokes replaced by {len(axes)} runways, {len(add) - len(axes)} taxiways')
    return kept + add


AIRCRAFT = {  # type -> (length, span) m, when the record has none
    'narrow': (38, 36), 'wide': (64, 60), 'widecargo': (70, 65), 'turboprop': (25, 27),
    'plane:plane_trainer': (8.5, 11), 'plane:plane_stunt': (7, 8), 'plane:plane_jet': (15, 13),
}


def aircraft_ring(a):
    """Top-view silhouette (fuselage, swept wings, tailplane) as one ring, nose = (-sin yaw, -cos yaw)."""
    L, S = a.get('length'), a.get('span')
    dl, ds = AIRCRAFT.get(a['type'], (12, 3) if a['type'].startswith('heli') else (20, 20))
    L, S = float(L or dl), float(S or ds)
    if a['type'].startswith('heli'):
        half = [(0.5, 0.0), (0.42, 0.12), (0.1, 0.16), (-0.12, 0.1), (-0.5, 0.03)]  # body + tail boom
        hw = [(x * L, y * L) for x, y in half]
    else:
        f = 0.055 * L + 0.5
        sw = 0.18 * L  # wing sweep
        wr, wc = 0.05 * L, max(0.12 * L, 1.2)  # wing root position (from centre, + = nose), chord
        hw = [(0.5 * L, 0.0), (0.42 * L, f), (wr + wc / 2, f), (wr - sw * 0.6 + wc / 4, S / 2), (wr - sw * 0.6 - wc / 4, S / 2),
              (wr - wc / 2, f), (-0.36 * L, f * 0.8), (-0.42 * L, 0.18 * S), (-0.47 * L, 0.18 * S), (-0.5 * L, 0.0)]
    pts = hw + [(x, -y) for x, y in reversed(hw[1:-1])]
    yaw = float(a.get('yaw', 0.0))
    fwd = np.array([-math.sin(yaw), -math.cos(yaw)])
    side = np.array([-fwd[1], fwd[0]])
    c = np.array([a['x'], a['z']], np.float64)
    return np.array([c + fwd * x + side * y for x, y in pts])


def blimp_ring(b):
    L, D = float(b.get('length', 60)), float(b.get('diameter', 17))
    yaw = float(b.get('yaw', 0.0))
    fwd = np.array([-math.sin(yaw), -math.cos(yaw)])
    side = np.array([-fwd[1], fwd[0]])
    c = np.array([b['x'], b['z']], np.float64)
    pts = []
    for k in range(24):
        t = math.pi * k / 23
        x, y = math.cos(t) * L / 2, math.sin(t) * D / 2
        if x < -0.32 * L:
            y = max(y, (abs(x) - 0.32 * L) / (0.18 * L) * 0.5 * D)  # tail fins
        pts.append((x, y))
    pts = pts + [(x, -y) for x, y in reversed(pts[1:-1])]
    return np.array([c + fwd * x + side * y for x, y in pts])


def landmark_buildings(buildings, geom, height_at):
    """Footprint list for the map: generic footprints a landmark site replaced are hidden; the sites' structure
    outlines, parked aircraft and the blimp are added (b0 rings, height = roof above ground)."""
    takes = np.zeros((0, 2))
    if os.path.exists(LANDMARK_TAKES):
        takes = np.array(json.load(open(LANDMARK_TAKES)).get('centroids', []), np.float64).reshape(-1, 2)
    outlines = []
    if geom:
        for site in geom.get('sites', []):
            for o in site.get('outlines', []):
                P = np.array(o['poly'], np.float64)
                if len(P) >= 3 and abs(ring_area(P)) >= 12:
                    outlines.append((P, float(o.get('top', 10.0))))
    polys = [P.astype(np.float32) for P, _ in outlines]
    boxes = np.array([[P[:, 0].min(), P[:, 1].min(), P[:, 0].max(), P[:, 1].max()] for P, _ in outlines]) if outlines else np.zeros((0, 4))
    out, hidden = [], 0
    for b in buildings:
        p = np.array(b['p'], np.float64).reshape(-1, 2)
        c = p.mean(0)
        if len(takes) and np.min(np.hypot(takes[:, 0] - c[0], takes[:, 1] - c[1])) < 1.0:
            hidden += 1
            continue
        if len(boxes):
            cand = np.nonzero((boxes[:, 0] <= c[0]) & (boxes[:, 2] >= c[0]) & (boxes[:, 1] <= c[1]) & (boxes[:, 3] >= c[1]))[0]
            if any(cv2.pointPolygonTest(polys[i], (float(c[0]), float(c[1])), False) >= 0 for i in cand):
                hidden += 1
                continue
        out.append(b)
    extra = 0
    for P, top in outlines:
        c = P.mean(0)
        h = top - height_at(float(c[0]), float(c[1]))
        if h < 2.5:  # pads and slabs (blimp pad, helipads) are land use, not structures
            continue
        out.append({'p': P.ravel().tolist(), 'h': min(400.0, h)})
        extra += 1
    if geom:
        for a in geom.get('aircraft', []):
            out.append({'p': aircraft_ring(a).ravel().tolist(), 'h': 6.0})
            extra += 1
        for f in geom.get('features', []):
            if f.get('kind') == 'blimp' and not any(
                    cv2.pointPolygonTest(polys[i], (float(f['x']), float(f['z'])), False) >= 0 for i in range(len(polys))):
                out.append({'p': blimp_ring(f).ravel().tolist(), 'h': 17.0})
                extra += 1
    log(f'landmark footprints: {hidden} generic hidden, {extra} landmark rings added')
    return out


def landmark_paved(masks, world, geom):
    """Aprons and the blimp pad are paved land use (4 m ground grid)."""
    if not geom:
        return
    x0, z0, ts = world['bounds'][0], world['bounds'][1], world['ts']
    m = masks['paved'].astype(np.uint8)
    rings = [np.array(a, np.float64) for a in geom.get('aprons', [])]
    for f in geom.get('features', []):
        if f.get('kind') == 'blimp-pad':
            cx, cz = f['center']
            r = float(f['radius'])
            rings.append(np.array([[cx + r * math.cos(t), cz + r * math.sin(t)] for t in np.linspace(0, 2 * math.pi, 48, endpoint=False)]))
    for P in rings:
        q = np.round(((P - [x0, z0]) / ts - 0.5) * 8).astype(np.int32)
        cv2.fillPoly(m, [q], 1, shift=3)
    masks['paved'] = m.astype(bool)
    # paved wins over the classes a pad is drawn over
    for k in ('land', 'farm', 'wetland', 'dirt', 'park', 'sand'):
        if k != 'land':
            masks[k] = masks[k] & ~masks['paved']
    log(f'landmark paved: {len(rings)} aprons / pads')


def build_buildings(buildings, packer):
    cols, rows = grid_dims(BUILDING_CELL, packer.bounds)
    parts = []
    for b in buildings:
        p = np.array(b['p'], np.float64).reshape(-1, 2)
        if len(p) < 3:
            continue
        c = p.mean(0)
        parts.append((cell_index(c[0], c[1], BUILDING_CELL, packer.bounds), 0, int(round(min(b['h'], 3000) * 10)), p))
    parts.sort(key=lambda p: p[0])
    m = packer.geometry('b0', parts, dict(kind='building', cell=BUILDING_CELL, cols=cols, rows=rows))
    log(f'buildings: {m["parts"]} rings, {m["points"]} pts')
    return {'b0': m}


# ----------------------------------------------------------------------------------------------------------------
def category_of(tags):
    ts = set(tags or [])
    for cid, keys in CATEGORIES:
        if keys & ts:
            return cid
    return 'other'


# Real-world prototypes (fan-map field 3) are shipped as "Name, City, ST" at most: street addresses, house numbers,
# ZIP codes and plus codes are dropped; homes (tag 'residential', or no business / landmark name) keep only the city
# and state. The full record stays on the fan map (the card links to it).
IRL_FLAG = 64
US_STATES = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO',
    'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME',
    'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
    'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
    'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR',
    'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN',
    'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
    'Wisconsin': 'WI', 'Wyoming': 'WY', 'District of Columbia': 'DC',
}
PLUS_CODE = re.compile(r'\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b\s*')
STREETY = re.compile(r"^\d|&|#|\b(St|Ave|Blvd|Rd|Dr|Hwy|Highway|Ln|Ct|Pl|Way|Pkwy|Ter|Cir|Trl|Ste|Suite|Unit|Apt|Fwy|Expy|"
                     r"Cswy|Causeway|Street|Avenue|Road|Drive|Lane|Court|Place|Parkway|Terrace|Circle|Trail|Boulevard|"
                     r"US-\d+|SR-\d+|FL-\d+|I-\d+|BUS)\.?$", re.I)


def sanitize_real(real, private=False):
    parts = [q.strip() for q in real.split(',') if q.strip()]
    parts = [q for q in parts if q not in ('USA', 'United States', 'US')]
    if not parts:
        return ''
    state, si = None, None
    for i, q in enumerate(parts):
        m = re.match(r'^([A-Z]{2})(?: \d{5}(?:-\d{4})?)?$', q)
        if m and m.group(1) in US_STATES.values():
            state, si = m.group(1), i
            break
        m = re.match(r'^([A-Za-z .]+?)(?: \d{5}(?:-\d{4})?)?$', q)
        if m and m.group(1).strip() in US_STATES:
            state, si = US_STATES[m.group(1).strip()], i
            break
    city = None
    if si:
        c = PLUS_CODE.sub('', parts[si - 1]).strip()
        city = c if c and not STREETY.search(c) and not re.search(r'\d', c) else None
    first = PLUS_CODE.sub('', parts[0]).strip()
    name = first if first and first != city and si != 0 and not STREETY.search(first) and (si is None or si >= 2 or city is None) else None
    place = ', '.join(x for x in (city, state) if x)
    if private or not name:
        return place
    return f'{name}, {place}' if place else name


def parse_pois(lm, district_names):
    pois = []
    for key, v in lm.items():
        if not v[1] or len(v[1]) < 2:
            continue
        parts = [s.strip() for s in v[0].split(',')]
        name = parts[0] if parts and parts[0] != '?' else ''
        area = parts[-1] if len(parts) >= 2 else ''
        district = ''
        street = ''
        mids = parts[1:-1]
        for mpart in mids:
            if mpart in district_names:
                district = mpart
            elif STREET_RE.match(mpart):
                street = mpart
            elif not district:
                district = mpart
        tags = v[6] or []
        flags = 0
        for t, b in FLAG_TAGS.items():
            if t in tags:
                flags |= b
        src_real = (v[3] or '').strip()
        if src_real:
            flags |= IRL_FLAG
        real = sanitize_real(src_real, private='residential' in tags)
        if len(real) > 110:
            real = real[:107].rstrip(', ') + '…'
        pois.append(dict(id=key, name=name, cat=category_of(tags), x=round(float(v[1][0]), 1), z=round(-float(v[1][1]), 1),
                         district=district, area=area, street=street, real=real, flags=flags))
    return pois


def cluster_points(pts, link=420.0):
    n = len(pts)
    if n == 1:
        return [[0]]
    tree = cKDTree(pts)
    pairs = tree.query_pairs(link)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    groups = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    return list(groups.values())


def build_streets(pois, parts_all, packer):
    """Match fan-map street names (from POI labels) to road polylines near those POIs."""
    # dense road samples with direction
    S, D, PI = [], [], []
    for pi_, (cls, w, pts, ei, isb) in enumerate(parts_all):
        seg = np.diff(pts, axis=0)
        L = np.hypot(seg[:, 0], seg[:, 1])
        for k in range(len(seg)):
            if L[k] < 1e-6:
                continue
            nsub = max(1, int(L[k] // 4))
            for j in range(nsub):
                t = (j + 0.5) / nsub
                S.append(pts[k] + seg[k] * t)
                D.append(seg[k] / L[k])
                PI.append(pi_)
    S, D, PI = np.array(S), np.array(D), np.array(PI)
    tree = cKDTree(S)
    by_name = defaultdict(list)
    for p in pois:
        if p['street']:
            by_name[p['street']].append(p)
    claims = []  # (name, votes, part_index, keep_mask)
    for name, ps in by_name.items():
        pts = np.array([[p['x'], p['z']] for p in ps])
        route = bool(re.match(r'^(Historic )?(Route|Interstate) \d+$|Hwy$|Cswy$', name))
        for grp in cluster_points(pts):
            Q = pts[grp]
            d = None
            if len(Q) >= 2:
                c = Q.mean(0)
                u, s, vt = np.linalg.svd(Q - c)
                if s[0] > 40 and (len(s) < 2 or s[0] > 2.2 * max(s[1], 1e-6)):
                    d = vt[0]
            votes = Counter()
            for q in Q:
                idx = tree.query_ball_point(q, 75.0)
                if not idx:
                    continue
                idx = sorted(idx, key=lambda i: np.hypot(*(S[i] - q)))
                pick = None
                for i in idx:
                    cls = parts_all[PI[i]][0]
                    if cls >= 3:  # paths, runways, taxiways
                        continue
                    if route and cls == 2:
                        continue
                    if d is not None and abs(np.dot(D[i], d)) < 0.8:
                        continue
                    pick = PI[i]
                    break
                if pick is not None:
                    votes[pick] += 1
            if not votes:
                continue
            thr = 2 if len(Q) >= 5 else 1
            chosen = [k for k, v in votes.items() if v >= thr] or [votes.most_common(1)[0][0]]
            if d is not None:
                nrm = np.array([-d[1], d[0]])
                tq = (Q - Q.mean(0)) @ d
                lo, hi = tq.min() - 90, tq.max() + 90
                perp_max = max(55.0, 2.5 * float(np.std((Q - Q.mean(0)) @ nrm)) + 25.0)
            for k in chosen:
                pts_k = parts_all[k][2]
                if d is not None:
                    t = (pts_k - Q.mean(0)) @ d
                    off = np.abs((pts_k - Q.mean(0)) @ nrm)
                    kv = (t >= lo) & (t <= hi) & (off <= perp_max)
                    # the label path must run along the street, not turn into a side road
                    seg = np.diff(pts_k, axis=0)
                    sl = np.hypot(seg[:, 0], seg[:, 1]) + 1e-9
                    keep = (np.abs(seg @ d) / sl > 0.75) & kv[:-1] & kv[1:]
                else:
                    dist = np.min(np.hypot(pts_k[:, None, 0] - Q[None, :, 0], pts_k[:, None, 1] - Q[None, :, 1]), 1)
                    kv = dist < 260
                    keep = kv[:-1] & kv[1:]
                claims.append((name, votes[k] + len(Q) * 0.01, k, keep))
    # bridges named by POIs ("Rivo Bridge", "Star Island Bridge" ...): label the nearby bridge deck
    bridge_idx = [k for k, p in enumerate(parts_all) if p[4]]
    if bridge_idx:
        bmid = np.array([parts_all[k][2].mean(0) for k in bridge_idx])
        btree = cKDTree(bmid)
        for p in pois:
            nm = p['name'].strip('"')
            if not nm.endswith('Bridge') or nm in ('Bridge', 'Train Bridge'):
                continue
            dist, j = btree.query([p['x'], p['z']])
            if dist < 160:
                k = bridge_idx[j]
                claims.append((p['name'], 50, k, np.ones(len(parts_all[k][2]) - 1, bool)))
    # resolve conflicts: one name per road part (most votes wins: also merges typo variants)
    best = {}
    for name, v, k, keep in claims:
        if k not in best or v > best[k][1]:
            best[k] = (name, v, keep)
    runs = defaultdict(list)
    for k, (name, v, keep) in best.items():
        pts = parts_all[k][2]
        # contiguous runs of kept segments (segment i joins vertices i and i + 1)
        idx = np.flatnonzero(keep)
        if not len(idx):
            continue
        splits = np.flatnonzero(np.diff(idx) > 1)
        for seg in np.split(idx, splits + 1):
            runs[name].append(pts[seg[0]:seg[-1] + 2])
    # chain runs that touch, simplify, drop short bits
    streets, parts = [], []
    for name, rl in sorted(runs.items()):
        rl = [r.copy() for r in rl]
        merged = True
        while merged and len(rl) > 1:
            merged = False
            for i in range(len(rl)):
                for j in range(len(rl)):
                    if i == j:
                        continue
                    a, b = rl[i], rl[j]
                    if np.hypot(*(a[-1] - b[0])) < 4:
                        rl[i] = np.vstack([a, b[1:]])
                    elif np.hypot(*(a[-1] - b[-1])) < 4:
                        rl[i] = np.vstack([a, b[::-1][1:]])
                    else:
                        continue
                    rl.pop(j)
                    merged = True
                    break
                if merged:
                    break
        si = len(streets)
        total = 0.0
        for r in rl:
            L = float(np.sum(np.hypot(*np.diff(r, axis=0).T)))
            if L < 50:
                continue
            total += L
            parts.append((si, 0, 0, simplify(r, 0.8, False)))
        if total > 0:
            kind = 'route' if re.match(r'^(Historic )?(Route|Interstate) \d+$', name) else ('bridge' if name.strip('"').endswith('Bridge') else 'street')
            streets.append(dict(name=name, kind=kind, len=round(total)))
        else:
            continue
    m = packer.geometry('st', parts, dict(kind='street'))
    log(f'streets: {len(streets)} names, {m["parts"]} paths: ' + ', '.join(f"{s['name']} ({s['len']} m)" for s in streets))
    return streets, {'st': m}


# ----------------------------------------------------------------------------------------------------------------
def make_height_at(heights, world):
    """terrain height at a world point (same triangle interpolation as Terrain.heightAt)"""
    x0, z0, hs, gw, gh = world['bounds'][0], world['bounds'][1], world['hs'], world['gw'], world['gh']

    def height_at(x, z):
        fx = min(max((x - x0) / hs, 0.0), gw - 1e-4)
        fz = min(max((z - z0) / hs, 0.0), gh - 1e-4)
        ix, iz = int(fx), int(fz)
        tx, tz = fx - ix, fz - iz
        h00, h10 = heights[iz, ix], heights[iz, ix + 1]
        h01, h11 = heights[iz + 1, ix], heights[iz + 1, ix + 1]
        if tx + tz <= 1:
            return float(h00 + (h10 - h00) * tx + (h01 - h00) * tz)
        return float(h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz))
    return height_at


# ---- parks (tools/parks.py -> parks.json): park ground fixes, footpaths (road class 'path', close zoom), park labels --
def load_parks():
    try:
        return json.load(open(os.path.join(DATA, 'parks.json')))
    except (OSError, ValueError):
        return None


def park_ground(ground, parks):
    if not parks or not parks.get('ground'):
        return ground
    g = ground.copy()
    run = parks['ground']
    for k in range(0, len(run), 4):
        j, i, n, c = run[k:k + 4]
        g[j, i:i + n] = c
    return g


def park_paths(parks):
    if not parks:
        return []
    out = []
    for p in parks.get('paths', []):
        pts = np.array(p['p'], np.float64).reshape(-1, 2)
        if len(pts) > 1:
            out.append((C_PATH | (1 << LEVEL_SHIFT), int(round(p['w'] * 10)), pts))
    return out


def park_pois(parks):
    """named parks as natural-feature labels (the fan map's real-world names keep its parentheses)"""
    if not parks:
        return []
    out = []
    for i, p in enumerate(parks.get('parks', [])):
        if not p.get('label') or p.get('name') or p.get('part_of'):
            continue  # unnamed, or the fan map's own POI already carries the game name
        out.append(dict(id='park%d' % i, name=p['label'], cat='nature', x=p['x'], z=p['z'], district='', area='', street='',
                        real=p.get('real', ''), flags=0))
    return out


def main():
    t0 = time.time()
    world = json.load(open(os.path.join(DATA, 'world.json')))
    x0, z0, x1, z1 = world['bounds']
    packer = Packer(x0, z0, x1, z1)
    ground = np.frombuffer(gzip.decompress(open(os.path.join(DATA, 'ground.bin'), 'rb').read()), np.uint8).reshape(world['th'], world['tw'])
    roads = json.load(open(os.path.join(DATA, 'roads.json')))
    buildings = json.load(open(os.path.join(DATA, 'buildings.json')))
    lm = json.load(open(os.path.join(CACHE, 'landmarks.json')))
    log('loaded', f'{time.time() - t0:.1f}s')

    sets = {}
    heights = np.frombuffer(gzip.decompress(open(os.path.join(DATA, 'height.bin'), 'rb').read()), np.int16).reshape(world['gh'] + 1, world['gw'] + 1) / 10.0
    sets.update(vectorize_depth(heights, world, packer))
    geom = load_landmark_geom()
    parks = load_parks()
    ground = park_ground(ground, parks)
    masks = build_masks(ground)
    landmark_paved(masks, world, geom)
    sets.update(vectorize_areas(masks, world, packer))
    height_at = make_height_at(heights, world)
    rmeta, parts_all, routes, exits = build_roads(roads, packer, height_at, geom, park_paths(parks))
    sets.update(rmeta)
    sets.update(build_buildings(landmark_buildings(buildings, geom, height_at), packer))

    district_names = {d['name'] for d in world['districts']}
    pois = parse_pois(lm, district_names) + park_pois(parks)
    streets, smeta = build_streets(pois, parts_all, packer)
    sets.update(smeta)

    cats = [c for c, _ in CATEGORIES]
    poi_rows = [[p['id'], p['name'], cats.index(p['cat']), p['x'], p['z'], p['district'], p['area'], p['street'], p['real'], p['flags']]
                for p in pois]
    log('pois', len(poi_rows), Counter(p['cat'] for p in pois).most_common())

    header = {
        'v': 1,
        'bounds': [x0, z0, x1, z1],
        'origin': list(packer.origin),
        'q': Q,
        'areaClasses': AREA_CLASSES,
        'depthLevels': DEPTH_LEVELS,
        'roadClasses': ROAD_CLASSES,
        'bridgeBit': BRIDGE,
        'roadBits': {'bridge': BRIDGE, 'levelShift': LEVEL_SHIFT, 'ramp': RAMP, 'tunnel': TUNNEL},
        'routes': routes,
        'routeKinds': ROUTE_KINDS,
        'exits': exits,
        'sets': sets,
        'arrays': packer.arrays,
        'categories': cats,
        'poiFields': ['id', 'name', 'cat', 'x', 'z', 'district', 'area', 'street', 'real', 'flags'],
        'poiFlags': {**FLAG_TAGS, 'irl': IRL_FLAG},
        'pois': poi_rows,
        'streets': streets,
        'districts': world['districts'],
        'landmarks': world['landmarks'],
        'source': 'State of Leonida community map (YANIS v17, map.stateofleonida.net)',
        'built': time.strftime('%Y-%m-%d %H:%M'),
    }
    hj = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    while len(hj) % 4:
        hj += b' '
    raw = b'LDMAP1\0\0' + struct.pack('<I', len(hj)) + hj + bytes(packer.blob)
    # 4-byte align the blob: magic(8) + u32(4) + header(4k) = 12 + 4k -> blob starts at 12 + len(hj); pad
    pad = (-(12 + len(hj))) % 4
    assert pad == 0
    gz = gzip.compress(raw, 9)
    open(OUT, 'wb').write(gz)
    log(f'header {len(hj) / 1e3:.0f} kB, blob {len(packer.blob) / 1e6:.2f} MB, raw {len(raw) / 1e6:.2f} MB -> gzip {len(gz) / 1e6:.2f} MB')
    for name, (dt, off, n) in sorted(packer.arrays.items(), key=lambda kv: -kv[1][2]):
        log(f'  {name:12s} {dt:6s} {n:9d}')
    log(f'done in {time.time() - t0:.1f}s -> {OUT}')


if __name__ == '__main__':
    main()
