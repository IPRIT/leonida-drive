"""Parks: inventory against the source map, footpath networks, dressing and tree layout -> public/data/parks.json.

Run after tools/export.py (it reads the exported roads / buildings / ground / heights) and before tools/map_build.py
(the map draws the park paths and labels from parks.json):

    .venv/bin/python tools/parks.py            # writes public/data/parks.json (+ tools/cache/parks_report.json)
    .venv/bin/python tools/parks.py --sheets   # also writes source-vs-game contact sheets to /tmp/parks-sheets

Nothing else is written: the game applies everything at runtime (src/world/Parks.js), so a later export.py run never
undoes the parks, and parks.py can be re-run at any time (it is deterministic).

Sources
  raw/mosaic_nc_z5.png   YANIS v17 raster (2 m/px): park green, sport fields and the footpaths (tan for confirmed,
                         pink for speculative paths) that classify.py does not keep as a class
  raw/cls/cls.npy        classified layers (park 3, land 2, sport 16, water 1, buildings 10/11, paved 9, urban 8)
  tools/cache/data/landmarks.json   map.stateofleonida.net POIs (park names: game names, real-world names)
  public/data/*          the exported game world (ground classes, roads, buildings, heights)

Which areas are parks
  1. every park-coloured area (park + sport classes) of at least MIN_AREA, footpaths included;
  2. parks the fan map names (POIs below) although it paints them in the plain light green of natural land.
Private sport courts (condo tennis courts, < 2500 m2 of sport class only) are not parks.

parks.json (all coordinates world metres, rounded to 0.1)
  parks[]   {id, name, label, type, x, z, area, bbox, src, mask: [i0, j0, w, h, rle...] (4 m texels, park interior)}
  paths[]   {p: [x, z, ...], w, k (0 paved, 1 promenade, 2 gravel trail), a, b (node ids), park}
  nodes[]   [x, z, flags] (flags 1: entrance on a street sidewalk)
  plazas[]  [x, z, r, kind (0 paved plaza, 1 fountain plaza, 2 planted roundel)]
  surfaces[] {k: 'court' | 'playground', x, z, yaw, w, l}
  props     {bench: [x, z, yaw...], bin, picnic, planter, fountain, playground, hoop, railing, sign, lamp}
  trees     [x, z, type, scale...] (type as veg.bin: 0 palm, 1 tree, 2 pine, 3 bush)
  ground    [j, i0, n, cls, ...] runs of 4 m texels that become park (3) / sport (11)
"""
import gzip
import json
import math
import os
import re
import sys
import time

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'raw')
CLSD = os.path.join(RAW, 'cls')
DATA = os.path.join(ROOT, 'public', 'data')
CACHE = os.path.join(ROOT, 'tools', 'cache')
MPP, X0, Z0 = 2.0, -11368.0, -11000.0  # mosaic mapping (classify.py)

C = dict(unknown=0, water=1, land=2, park=3, wetland=4, beach=5, industrial=6, dirtfield=7, urban=8, paved=9,
         building=10, building_blue=11, road=12, highway=13, dirtroad=14, farm=15, sport=16, white=17, dark=18, apron=19)
G = dict(water=0, sand=1, grass=2, park=3, wetland=4, farm=5, dirt=6, urban=7, paved=8, building=9, road=10, sport=11)

MIN_AREA = 1000.0  # m2
# footpath colours of the fan map (confirmed: tan, speculative: pink) and the grounds they are drawn over
PATH_COLS = [(210, 182, 130), (200, 136, 141), (177, 140, 80)]
PATH_BG = [(151, 192, 116), (144, 184, 108), (136, 176, 104), (193, 217, 131), (131, 190, 80), (217, 217, 217),
           (200, 200, 200), (243, 228, 131), (176, 176, 176)]

# Parks the fan map names but paints as natural land (light green) or that need a name / type the POIs do not give.
# (x, z) is a point inside the park; poi = landmarks.json key of the naming marker.
SEEDS = [
    dict(poi='L391', x=1995, z=-560, type='waterfront'),        # Lummus Park (Ocean Beach)
    dict(poi='L390', x=-275, z=-1110, type='waterfront'),       # Margaret Pace Park (Bayside)
    dict(poi='L174', x=-480, z=-1395),                          # "Park", Crosstown
    dict(poi='L841', x=178, z=-1116),                           # Venetian Causeway Park (Rialto Islands)
    dict(poi='L955', x=-6360, z=-3143),                         # "Park", Port Gellhorn (Parker)
    dict(poi='L350', x=-6606, z=-3467, type='waterfront'),      # Leslie Porter Wayside Park (Port Gellhorn)
    dict(poi='L1742', x=-1591, z=1992),                         # Perrine Wayside dog park ("Park", Southside)
    dict(poi='L2565', x=-1031, z=45),                           # "Park", Little Cuba
    dict(poi='L3018', x=-860, z=-400),                          # "Park", Downtown
    dict(poi='L3019', x=-806, z=59),                            # "Park", Downtown
    dict(poi='L2501', x=-495, z=12),                            # "Park", Downtown
]
# park name overrides by POI key (the fan map's game name is "?" or generic): None = use the POI as it is
LABELS = {}
WORLD = None


def log(*a):
    print('[parks]', *a, flush=True)


# ---------------------------------------------------------------------------------------------------------------- io
def load_world():
    w = json.load(open(os.path.join(DATA, 'world.json')))
    TW, TH = w['tw'], w['th']
    ground = np.frombuffer(gzip.decompress(open(os.path.join(DATA, 'ground.bin'), 'rb').read()), np.uint8).reshape(TH, TW)
    hgt = np.frombuffer(gzip.decompress(open(os.path.join(DATA, 'height.bin'), 'rb').read()), np.int16).reshape(w['gh'] + 1, w['gw'] + 1) / 10.0
    roads = json.load(open(os.path.join(DATA, 'roads.json')))
    blds = json.load(open(os.path.join(DATA, 'buildings.json')))
    lm = json.load(open(os.path.join(CACHE, 'data', 'landmarks.json')))
    return w, ground, hgt, roads, blds, lm


def px_of(x, z):
    return (x - X0) / MPP, (z - Z0) / MPP


def world_of(px, py):
    return X0 + (px + 0.5) * MPP, Z0 + (py + 0.5) * MPP


def path_pixels(a):
    """Footpath pixels: the pixel lies on the blend between a path colour and one of the grounds it is drawn on,
    at least 42 % path (anti-aliased edges of the 2-3 px wide line included)."""
    out = np.zeros(a.shape[:2], bool)
    ai = a.astype(np.int16)
    r, g, b = ai[..., 0], ai[..., 1], ai[..., 2]
    pre = ((r - b > 22) & (r - g > -14)) | ((r - g > 18) & (b - g > -20))  # warm tints only (cheap prefilter)
    ys, xs = np.nonzero(pre)
    if not len(ys):
        return out
    af = a[ys, xs].astype(np.float32)
    hit = np.zeros(len(ys), bool)
    for P in PATH_COLS:
        P = np.array(P, np.float32)
        for B in PATH_BG:
            B = np.array(B, np.float32)
            d = P - B
            L2 = float((d * d).sum())
            c = af - B
            al = (c * d).sum(-1) / L2
            res = np.sqrt(((c - al[:, None] * d) ** 2).sum(-1))
            hit |= (res < 7.5) & (al > 0.42) & (al < 1.15)
    out[ys[hit], xs[hit]] = True
    return out


def path_mask_full(img):
    H = img.shape[0]
    pm = np.zeros(img.shape[:2], bool)
    for y in range(0, H, 1024):
        pm[y:y + 1024] = path_pixels(img[y:y + 1024])
    return pm


# --------------------------------------------------------------------------------------------------------- inventory
PARKISH = ('Park', 'Garden', 'Plaza', 'Square', 'Green', 'Commons', 'Preserve', 'Golf')


def clean_name(s):
    s = (s or '').replace('"', '').strip()
    return s[:-1].strip() if s.endswith('?') else s


def park_names(lm, keys):
    """label for a park from its POIs: the game name when the fan map gives one, else the real-world name in
    parentheses (the fan map's own convention for real-world names)."""
    best = None
    for k in keys:
        v = lm[k]
        game = clean_name(v[0].split(',')[0])
        real = clean_name((v[3] or '').split(',')[0])
        tags = v[6] or []
        if 'residential' in tags or 'hotel' in tags:
            continue
        gp = game and game != '?' and any(w in game for w in PARKISH) and game.lower() not in ('park', 'parking lot')
        rp = real and re.search(r'\b(%s)\b' % '|'.join(PARKISH), real) and not re.search(r'Parking|Court|Stadium|Garage', real)
        if gp:
            cand = (3, game, real if rp else '', k)
        elif rp:
            cand = (2, '(%s)' % real, real, k)
        else:
            continue
        if best is None or cand[0] > best[0]:
            best = cand
    return best


def regions(cls, pm, lm):
    """Park regions on the 2 m mosaic grid: list of dict(mask (bool, bbox-local), sl (bbox slices), src, seed)."""
    t0 = time.time()
    base = np.isin(cls, (C['park'], C['sport']))
    near = ndi.binary_dilation(base, iterations=4)
    P = base | (pm & near)
    P = ndi.binary_closing(P, structure=np.ones((3, 3), bool), iterations=1) | base
    lab, n = ndi.label(P, structure=np.ones((3, 3), bool))
    idx = np.arange(1, n + 1)
    area = ndi.sum(P, lab, idx) * MPP * MPP
    sport = ndi.sum(cls == C['sport'], lab, idx) * MPP * MPP
    out = []
    used = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab)):
        if sl is None or area[i] < MIN_AREA:
            continue
        if sport[i] / area[i] > 0.85 and area[i] < 2500:
            continue  # private courts (condo tennis courts)
        m = lab[sl] == i + 1
        out.append(dict(mask=m, sl=sl, src='park'))
        used[i + 1] = True
    log(f'park-coloured regions: {len(out)} ({time.time() - t0:.1f}s)')
    # named parks painted as natural land
    land = cls == C['land']
    for s in SEEDS:
        px, py = px_of(s['x'], s['z'])
        px, py = int(px), int(py)
        if lab[py, px] and used[lab[py, px]]:
            # already a park-coloured region: only the name / type hint is used
            for r in out:
                sl = r['sl']
                if sl[0].start <= py < sl[0].stop and sl[1].start <= px < sl[1].stop and r['mask'][py - sl[0].start, px - sl[1].start]:
                    r['seed'] = s
            continue
        win = land[py - 40:py + 41, px - 40:px + 41]
        if not win.any():
            log('seed without land', s)
            continue
        dy, dx = np.unravel_index(np.argmin(np.where(win, np.hypot(*np.mgrid[-40:41, -40:41]), 1e9)), win.shape)
        sy, sx = py - 40 + dy, px - 40 + dx
        r0, c0 = max(0, sy - 400), max(0, sx - 400)
        sub = land[r0:sy + 400, c0:sx + 400] | (pm[r0:sy + 400, c0:sx + 400] & ndi.binary_dilation(land[r0:sy + 400, c0:sx + 400], iterations=3))
        sub = sub | (base[r0:sy + 400, c0:sx + 400])
        l2, _ = ndi.label(sub, structure=np.ones((3, 3), bool))
        m = l2 == l2[sy - r0, sx - c0]
        a = m.sum() * MPP * MPP
        if a > 160000:
            log('seed region too large', s, a)
            continue
        ys, xs = np.nonzero(m)
        sl = (slice(r0 + ys.min(), r0 + ys.max() + 1), slice(c0 + xs.min(), c0 + xs.max() + 1))
        out.append(dict(mask=m[ys.min():ys.max() + 1, xs.min():xs.max() + 1], sl=sl, src='poi', seed=s))
    log(f'regions with named land parks: {len(out)} ({time.time() - t0:.1f}s)')
    return out


def poi_index(lm):
    pts = []
    for k, v in lm.items():
        if not v[1] or len(v[1]) < 2:
            continue
        px, py = px_of(v[1][0], -v[1][1])
        pts.append((k, px, py))
    return pts


def classify_type(r, cls_sub, name):
    m = r['mask']
    area = r['area']
    ring = ndi.binary_dilation(m, iterations=3) & ~m
    rn = max(1, ring.sum())
    water = (np.isin(cls_sub, (C['water'], C['beach'])) & ring).sum() / rn
    sport = (cls_sub == C['sport'])[m].mean()
    hint = (r.get('seed') or {}).get('type')
    if hint:
        return hint
    if name and 'Golf' in name:
        return 'golf'
    if area > 250000:
        return 'nature'
    if sport > 0.6:
        return 'sports'
    if water > 0.18:
        return 'waterfront'
    if area < 5200:
        return 'plaza'
    return 'neighbourhood'


def inventory(cls, pm, lm):
    regs = regions(cls, pm, lm)
    pois = poi_index(lm)
    parks = []
    for r in regs:
        sl, m = r['sl'], r['mask']
        # holes inside the park (buildings, ponds, plazas) belong to it
        filled = ndi.binary_fill_holes(m)
        holes = filled & ~m
        hl, hn = ndi.label(holes)
        if hn:
            ha = ndi.sum(holes, hl, np.arange(1, hn + 1)) * MPP * MPP
            big = np.isin(hl, np.nonzero(ha > 0.35 * max(1, m.sum() * MPP * MPP))[0] + 1)
            filled &= ~big  # a ring-shaped park around a whole block keeps its block out
        r['mask'] = filled
        r['area'] = float(filled.sum() * MPP * MPP)
        y0, x0 = sl[0].start, sl[1].start
        keys = []
        reach = ndi.binary_dilation(filled, iterations=15)
        for k, px, py in pois:
            iy, ix = int(py) - y0, int(px) - x0
            if 0 <= iy < filled.shape[0] and 0 <= ix < filled.shape[1] and reach[iy, ix]:
                keys.append(k)
        if r.get('seed'):
            keys = [r['seed']['poi']] + keys
        nm = park_names(lm, keys)
        r['poi'] = nm[3] if nm else None
        r['label'] = nm[1] if nm else ''
        r['real'] = nm[2] if nm else ''
        r['name'] = clean_name(lm[nm[3]][0].split(',')[0]) if nm and nm[0] == 3 else ''
        cs = cls[sl]
        r['type'] = classify_type(r, cs, r['label'])
        cy, cx = ndi.center_of_mass(filled)
        r['x'], r['z'] = world_of(x0 + cx, y0 + cy)
        r['id'] = 'p%d_%d' % (round(r['x'] / 10), round(r['z'] / 10))
        parks.append(r)
    parks.sort(key=lambda r: -r['area'])
    return parks


def parity(parks, cls, ground, world, roads, blds):
    """Game vs source for each park: ground class coverage, buildings and roads standing on open park."""
    WX0, WZ0, TS = world['bounds'][0], world['bounds'][1], world['ts']
    TH, TW = ground.shape
    # building footprints rasterised on the 2 m grid, by index
    for r in parks:
        sl, m = r['sl'], r['mask']
        y0, x0 = sl[0].start, sl[1].start
        cs = cls[sl]
        openp = m & np.isin(cs, (C['park'], C['sport'], C['land']))
        # ground texels (4 m) under the park
        ys, xs = np.nonzero(openp[::2, ::2])
        wx, wz = world_of(x0 + xs * 2 + 0.5, y0 + ys * 2 + 0.5)
        ti = np.clip(((wx - WX0) / TS).astype(int), 0, TW - 1)
        tj = np.clip(((wz - WZ0) / TS).astype(int), 0, TH - 1)
        g = ground[tj, ti]
        r['g_park'] = float(np.isin(g, (G['park'], G['sport'])).mean()) if len(g) else 0.0
        r['g_grass'] = float((g == G['grass']).mean()) if len(g) else 0.0
        r['g_built'] = float(np.isin(g, (G['urban'], G['paved'], G['building'], G['road'])).mean()) if len(g) else 0.0
        # buildings on open park
        bad = []
        bx0, bz0 = world_of(x0, y0)
        bx1, bz1 = world_of(sl[1].stop, sl[0].stop)
        for bi, b in enumerate(blds):
            p = np.array(b['p']).reshape(-1, 2)
            cxw, czw = p.mean(0)
            if not (bx0 <= cxw <= bx1 and bz0 <= czw <= bz1):
                continue
            # the whole footprint must stand on open park on the source (a curved stage or a ring keeps its centroid
            # outside its own walls)
            fp = Image.new('L', (m.shape[1], m.shape[0]), 0)
            ImageDraw.Draw(fp).polygon([((x - X0) / MPP - x0, (z - Z0) / MPP - y0) for x, z in p], fill=255)
            fp = np.array(fp) > 0
            if fp.sum() >= 3 and openp[fp].mean() > 0.85:
                bad.append(bi)
        r['bad_blds'] = bad
        # roads crossing open park (source shows grass there)
        L = 0.0
        er = ndi.binary_erosion(openp, iterations=2)
        for e in roads['edges']:
            p = np.array(e['p']).reshape(-1, 2)
            if p[:, 0].max() < bx0 or p[:, 0].min() > bx1 or p[:, 1].max() < bz0 or p[:, 1].min() > bz1:
                continue
            for k in range(len(p) - 1):
                q = (p[k] + p[k + 1]) / 2
                ix, iy = int((q[0] - X0) / MPP) - x0, int((q[1] - Z0) / MPP) - y0
                if 0 <= iy < m.shape[0] and 0 <= ix < m.shape[1] and er[iy, ix]:
                    L += float(np.hypot(*(p[k + 1] - p[k])))
        r['bad_road_m'] = L


def sheets(parks, img, ground, world, roads, blds, out_dir='/tmp/parks-sheets'):
    os.makedirs(out_dir, exist_ok=True)
    pal = np.array([(40, 90, 160), (240, 225, 140), (170, 200, 120), (90, 170, 80), (110, 190, 150), (60, 140, 40),
                    (180, 150, 100), (215, 215, 215), (160, 160, 170), (255, 120, 60), (30, 30, 30), (40, 220, 40)], np.uint8)
    WX0, WZ0, TS = world['bounds'][0], world['bounds'][1], world['ts']
    S = 300
    per = 6
    for si in range(0, len(parks), per):
        sheet = Image.new('RGB', (2 * S * 3, S * 2), (0, 0, 0))
        dr = ImageDraw.Draw(sheet)
        for j, r in enumerate(parks[si:si + per]):
            sl = r['sl']
            cy, cx = (sl[0].start + sl[0].stop) / 2, (sl[1].start + sl[1].stop) / 2
            h = max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) / 2 + 20
            src = Image.fromarray(img[max(0, int(cy - h)):int(cy + h), max(0, int(cx - h)):int(cx + h)]).resize((S, S))
            wx0, wz0 = world_of(cx - h, cy - h)
            wx1, wz1 = world_of(cx + h, cy + h)
            i0, j0, i1, j1 = int((wx0 - WX0) / TS), int((wz0 - WZ0) / TS), int((wx1 - WX0) / TS), int((wz1 - WZ0) / TS)
            gi = Image.fromarray(pal[ground[max(0, j0):j1, max(0, i0):i1]]).resize((S, S), Image.NEAREST)
            gd = ImageDraw.Draw(gi)
            k = S / (wx1 - wx0)
            for b in blds:
                p = np.array(b['p']).reshape(-1, 2)
                if p[0, 0] < wx0 - 50 or p[0, 0] > wx1 + 50 or p[0, 1] < wz0 - 50 or p[0, 1] > wz1 + 50:
                    continue
                gd.polygon([((x - wx0) * k, (z - wz0) * k) for x, z in p], outline=(120, 0, 0))
            for e in roads['edges']:
                p = np.array(e['p']).reshape(-1, 2)
                if p[:, 0].max() < wx0 or p[:, 0].min() > wx1 or p[:, 1].max() < wz0 or p[:, 1].min() > wz1:
                    continue
                gd.line([((x - wx0) * k, (z - wz0) * k) for x, z in p], fill=(0, 0, 255), width=max(1, int(e['w'] * k)))
            col, row = j % 3, j // 3
            sheet.paste(src, (col * 2 * S, row * S))
            sheet.paste(gi, (col * 2 * S + S, row * S))
            dr.text((col * 2 * S + 3, row * S + 3), f"{r['id']} {r['label'][:30]} {r['type']} {int(r['area'])}m2", fill=(255, 0, 0))
        sheet.save(os.path.join(out_dir, 'sheet_%02d.png' % (si // per)))


# ------------------------------------------------------------------------------------------------------ path network
N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
W_PATH, W_MAIN, W_PROM, W_TRAIL = 3.0, 3.6, 5.0, 2.4  # widths (m)
K_PAVED, K_PROM, K_TRAIL = 0, 1, 2


def smooth_noise(shape, sigma, seed):
    rng = np.random.default_rng(seed)
    n = ndi.gaussian_filter(rng.standard_normal(shape).astype(np.float32), sigma)
    return (n - n.min()) / max(1e-6, n.max() - n.min())


def trace_graph(sk):
    """Skeleton -> graph: nodes (pixel clusters with != 2 neighbours) and edges (pixel chains between them).
    Returns nodes [(y, x)], edges [(a, b, [(y, x)...])]. Loops without nodes get one node."""
    sk = sk.copy()
    H, W = sk.shape
    pad = np.pad(sk, 1)
    nb = sum(np.roll(np.roll(pad, dy, 0), dx, 1) for dy, dx in N8)[1:-1, 1:-1] * sk
    nodepx = sk & (nb != 2)
    lab, nn = ndi.label(nodepx, structure=np.ones((3, 3), bool))
    nodes = [tuple(map(float, c)) for c in ndi.center_of_mass(nodepx, lab, np.arange(1, nn + 1))] if nn else []
    node_of = {}
    for y, x in zip(*np.nonzero(lab)):
        node_of[(y, x)] = lab[y, x] - 1
    seen = set()
    edges = []

    def nbrs(y, x):
        for dy, dx in N8:
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W and sk[yy, xx]:
                yield yy, xx

    for (y, x), ni in list(node_of.items()):
        for q in nbrs(y, x):
            if q in node_of:
                if node_of[q] != ni and (min(ni, node_of[q]), max(ni, node_of[q]), 'd') not in seen:
                    seen.add((min(ni, node_of[q]), max(ni, node_of[q]), 'd'))
                    edges.append((ni, node_of[q], [(y, x), q]))
                continue
            if q in seen:
                continue
            chain = [(y, x), q]
            seen.add(q)
            prev, cur = (y, x), q
            end = None
            while True:
                nxt = None
                for r2 in nbrs(*cur):
                    if r2 == prev or r2 in seen and r2 not in node_of:
                        continue
                    if r2 in node_of:
                        if node_of[r2] != ni or len(chain) > 2:
                            end = node_of[r2]
                            chain.append(r2)
                            break
                        continue
                    nxt = r2
                    break
                if end is not None or nxt is None:
                    break
                seen.add(nxt)
                chain.append(nxt)
                prev, cur = cur, nxt
            if end is None:
                # dead chain end without a node (should not happen) or a loop back: make the last pixel a node
                nodes.append(tuple(map(float, chain[-1])))
                end = len(nodes) - 1
            edges.append((ni, end, chain))
    # pure loops (no node pixel)
    rest = sk.copy()
    for (y, x) in node_of:
        rest[y, x] = False
    for s in seen:
        if isinstance(s, tuple) and len(s) == 2:
            rest[s] = False
    if rest.any():
        ll, nl = ndi.label(rest, structure=np.ones((3, 3), bool))
        for k in range(1, nl + 1):
            ys, xs = np.nonzero(ll == k)
            if len(ys) < 6:
                continue
            start = (ys[0], xs[0])
            nodes.append((float(start[0]), float(start[1])))
            ni = len(nodes) - 1
            chain = [start]
            seen2 = {start}
            cur = start
            while True:
                nxt = None
                for r2 in nbrs(*cur):
                    if ll[r2] == k and r2 not in seen2:
                        nxt = r2
                        break
                if nxt is None:
                    break
                seen2.add(nxt)
                chain.append(nxt)
                cur = nxt
            chain.append(start)
            edges.append((ni, ni, chain))
    return nodes, edges


def chaikin(P, it=2, closed=False):
    P = np.asarray(P, np.float64)
    for _ in range(it):
        if len(P) < 3:
            return P
        Q = [P[0]]
        for i in range(len(P) - 1):
            a, b = P[i], P[i + 1]
            Q.append(0.75 * a + 0.25 * b)
            Q.append(0.25 * a + 0.75 * b)
        Q.append(P[-1])
        P = np.array(Q)
    return P


def rdp(P, eps):
    P = np.asarray(P)
    if len(P) < 3:
        return P
    a, b = P[0], P[-1]
    d = b - a
    L = np.hypot(*d)
    if L < 1e-9:
        dist = np.hypot(*(P - a).T)
    else:
        dist = np.abs(d[0] * (P[:, 1] - a[1]) - d[1] * (P[:, 0] - a[0])) / L
    i = int(np.argmax(dist))
    if dist[i] > eps:
        return np.vstack([rdp(P[:i + 1], eps)[:-1], rdp(P[i:], eps)])
    return np.array([a, b])


def poly_len(P):
    P = np.asarray(P)
    return float(np.hypot(*np.diff(P, axis=0).T).sum()) if len(P) > 1 else 0.0


def raster_line(img, a, b, val=True):
    """stamp a 1 px line a -> b ((y, x) floats) into img"""
    n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1]))) + 1
    ys = np.round(np.linspace(a[0], b[0], n + 1)).astype(int)
    xs = np.round(np.linspace(a[1], b[1], n + 1)).astype(int)
    ok = (ys >= 0) & (ys < img.shape[0]) & (xs >= 0) & (xs < img.shape[1])
    img[ys[ok], xs[ok]] = val


class Local:
    """A park's working grid: the 2 m mosaic grid cropped to its bbox + PAD."""
    PAD = 14

    def __init__(self, r, cls, pm, roads, blds, nodes_deg):
        sl = r['sl']
        P = self.PAD
        self.y0, self.x0 = sl[0].start - P, sl[1].start - P
        H, W = sl[0].stop - sl[0].start + 2 * P, sl[1].stop - sl[1].start + 2 * P
        self.H, self.W = H, W
        self.M = np.zeros((H, W), bool)
        self.M[P:P + r['mask'].shape[0], P:P + r['mask'].shape[1]] = r['mask']
        ys0, xs0 = max(0, self.y0), max(0, self.x0)
        self.cs = np.zeros((H, W), np.uint8)
        self.pm = np.zeros((H, W), bool)
        cy1, cx1 = min(cls.shape[0], self.y0 + H), min(cls.shape[1], self.x0 + W)
        self.cs[ys0 - self.y0:cy1 - self.y0, xs0 - self.x0:cx1 - self.x0] = cls[ys0:cy1, xs0:cx1]
        self.pm[ys0 - self.y0:cy1 - self.y0, xs0 - self.x0:cx1 - self.x0] = pm[ys0:cy1, xs0:cx1]
        wx0, wz0 = self.world(-1, -1)
        wx1, wz1 = self.world(H + 1, W + 1)
        self.bounds = (wx0, wz0, wx1, wz1)
        # game buildings on this grid (footprints rasterised) + the ones standing on open park
        img = Image.new('L', (W, H), 0)
        dr = ImageDraw.Draw(img)
        for bi, b in enumerate(blds):
            p = np.array(b['p']).reshape(-1, 2)
            if p[:, 0].max() < wx0 or p[:, 0].min() > wx1 or p[:, 1].max() < wz0 or p[:, 1].min() > wz1:
                continue
            if bi in r.get('bad_blds', ()):
                continue  # hidden at runtime (stands on open park on the source map)
            dr.polygon([((x - X0) / MPP - self.x0, (z - Z0) / MPP - self.y0) for x, z in p], fill=255)
        self.bld = np.array(img) > 0
        # roads: centre lines (half width per pixel) for the frontage / entrances, junction nodes
        rimg = Image.new('L', (W, H), 0)
        dr = ImageDraw.Draw(rimg)
        self.roadpx = []
        for e in roads['edges']:
            p = np.array(e['p']).reshape(-1, 2)
            if p[:, 0].max() < wx0 - 30 or p[:, 0].min() > wx1 + 30 or p[:, 1].max() < wz0 - 30 or p[:, 1].min() > wz1 + 30:
                continue
            if e['k'] == 'highway':
                continue  # no park entrances onto a highway
            pts = [((x - X0) / MPP - self.x0, (z - Z0) / MPP - self.y0) for x, z in p]
            dr.line(pts, fill=max(1, min(255, int(round(e['w'] * 5)))), width=1)
        self.road_hw = np.array(rimg).astype(np.float32) / 10.0  # half width (m) on centre-line pixels
        self.junctions = []
        for ni, (x, z) in enumerate(roads['nodes']):
            if not (wx0 - 30 <= x <= wx1 + 30 and wz0 - 30 <= z <= wz1 + 30):
                continue
            d, hw = nodes_deg.get(ni, (0, 0))
            if d >= 3 and hw > 0:
                self.junctions.append(((z - Z0) / MPP - self.y0, (x - X0) / MPP - self.x0, hw))

    def world(self, y, x):
        return X0 + (self.x0 + x + 0.5) * MPP, Z0 + (self.y0 + y + 0.5) * MPP

    def local(self, x, z):
        return (z - Z0) / MPP - 0.5 - self.y0, (x - X0) / MPP - 0.5 - self.x0


def node_degrees(roads):
    deg = {}
    for e in roads['edges']:
        if e['k'] == 'highway':
            continue
        for ni in (e['a'], e['b']):
            d, hw = deg.get(ni, (0, 0.0))
            deg[ni] = (d + 1, max(hw, e['w'] / 2))
    return deg


def entrances(L, r, src_ends, mode):
    """Entrance pixels on the park edge facing a street sidewalk: corners at junctions (where the crosswalks land),
    the ends of the fan map's own footpaths, and mid-block gates on long frontages (city parks).
    mode: 'city' | 'source' (keep to the fan map's paths) | 'sparse' (nature / golf: few gates)."""
    M = L.M
    edge = M & ~ndi.binary_erosion(M)
    cl = L.road_hw > 0
    if not cl.any():
        return []
    d_road, (ry, rx) = ndi.distance_transform_edt(~cl, return_indices=True)
    hw_near = L.road_hw[ry, rx]
    front = edge & (d_road * MPP <= hw_near + 9.0)
    if not front.any():
        return []
    dM, (my, mx) = ndi.distance_transform_edt(~M, return_indices=True)
    cands = []
    for (y, x) in src_ends:
        if front[max(0, y - 4):y + 5, max(0, x - 4):x + 5].any():
            cands.append((4, y, x))
    for (jy, jx, hw) in L.junctions:
        iy, ix = int(round(jy)), int(round(jx))
        if not (0 <= iy < L.H and 0 <= ix < L.W):
            continue
        if dM[iy, ix] * MPP > hw + 11.0:
            continue
        by, bx = my[iy, ix], mx[iy, ix]
        if front[max(0, by - 2):by + 3, max(0, bx - 2):bx + 3].any():
            cands.append((3, by, bx))
    cands.sort(key=lambda c: -c[0])
    spacing = 200 if mode == 'sparse' else 22
    out = []
    for p, y, x in cands:
        if all(math.hypot(y - q[0], x - q[1]) * MPP > spacing for q in out):
            out.append((y, x, p))
    if mode == 'sparse':
        return out[:4]
    if mode == 'city':
        fy, fx = np.nonzero(front)
        for _ in range(12):
            if not len(fy):
                break
            dmin = np.min([np.hypot(fy - q[0], fx - q[1]) for q in out], axis=0) * MPP if out else np.full(len(fy), 1e9)
            k = int(np.argmax(dmin))
            if dmin[k] < 85:
                break
            out.append((int(fy[k]), int(fx[k]), 1))
    return out


def route(cost, starts, end):
    from skimage.graph import MCP_Geometric
    m = MCP_Geometric(cost)
    m.find_costs(starts, [end])
    try:
        return m.traceback(end)
    except Exception:
        return None


def skel_ends(mask):
    from skimage.morphology import skeletonize
    sk = skeletonize(mask)
    pad = np.pad(sk, 1)
    nb = sum(np.roll(np.roll(pad, dy, 0), dx, 1) for dy, dx in N8)[1:-1, 1:-1] * sk
    return sk, list(zip(*np.nonzero(sk & (nb == 1))))


def bridge_gaps(src, max_m=36.0):
    """Reconnect the fan map's footpaths where map labels / grid lines broke them: each loose end continues
    straight on to the nearest other path piece within max_m inside a +-28 deg cone."""
    sk, ends = skel_ends(src)
    if not ends:
        return src, []
    lab, n = ndi.label(sk, structure=np.ones((3, 3), bool))
    pts = np.argwhere(sk)
    plab = lab[pts[:, 0], pts[:, 1]]
    out = src.copy()
    lines = []
    for (y, x) in ends:
        # direction: from the pixel 6 steps back along the chain to the end
        comp = lab[y, x]
        cy = pts[plab == comp]
        d = np.hypot(cy[:, 0] - y, cy[:, 1] - x)
        back = cy[(d > 4) & (d < 8)]
        if not len(back):
            continue
        by, bx = back.mean(0)
        dy, dx = y - by, x - bx
        L = math.hypot(dy, dx) or 1
        dy, dx = dy / L, dx / L
        other = pts[plab != comp]
        if not len(other):
            continue
        vy, vx = other[:, 0] - y, other[:, 1] - x
        dist = np.hypot(vy, vx)
        along = (vy * dy + vx * dx) / np.maximum(dist, 1e-6)
        ok = (dist * MPP <= max_m) & (along > math.cos(math.radians(28)))
        if not ok.any():
            continue
        score = np.where(ok, dist * (2 - along), 1e9)
        k = int(np.argmin(score))
        raster_line(out, (y, x), tuple(other[k]))
        lines.append(((y, x), tuple(other[k])))
    return out, lines


def build_network(r, L, seed, hgrid=None):
    """Footpaths of one park on its local grid: the fan map's footpaths (gaps bridged), a circuit walk, waterfront
    promenade, coverage-driven links (no lawn far from a path), gates to the street sidewalks."""
    from skimage.morphology import skeletonize
    M, cs = L.M, L.cs
    t = r['type']
    area = r['area']
    obst = (M & np.isin(cs, (C['building'], C['building_blue'], C['water']))) | L.bld
    sport = M & (cs == C['sport'])
    # game ground height on this grid: the exported coast slopes down a few metres inland of the fan map's shore,
    # so walks keep to ground >= 0.38 m (no path, bench or tree in the shallows)
    hl = hgrid(L) if hgrid else np.ones(M.shape, np.float32)
    low = hl < 0.38
    src = L.pm & ndi.binary_dilation(M, iterations=3) & ~ndi.binary_dilation(L.bld, iterations=1)
    src &= ~np.isin(cs, (C['water'],)) & (hl >= 0.2)
    def drop_small(m, k):
        lab, n = ndi.label(m, structure=np.ones((3, 3), bool))
        if not n:
            return m
        sz = ndi.sum(m, lab, np.arange(1, n + 1))
        return np.isin(lab, np.nonzero(sz >= k)[0] + 1)
    src = drop_small(src, 5)
    if src.any():
        src, _ = bridge_gaps(src, 46.0)
    src = drop_small(src, 14)
    has_src = src.sum() * MPP / 2.6 > 1.4 * math.sqrt(area)
    free = M & ~obst & ~sport & ~low
    dt = ndi.distance_transform_edt(free) * MPP
    net = np.zeros_like(M)
    wmap = np.zeros(M.shape, np.float32)
    kmap = np.zeros(M.shape, np.uint8)
    trail = t in ('nature', 'golf')
    w_main = W_TRAIL if trail else (W_MAIN if area > 20000 else W_PATH)
    k_main = K_TRAIL if trail else K_PAVED
    if src.any():
        sk = ndi.binary_dilation(src, iterations=1)
        net |= sk
        wmap[sk] = W_PATH
        kmap[sk] = K_PAVED
    src_ends = skel_ends(src)[1] if src.any() else []
    mode = 'sparse' if trail else 'source' if has_src else 'city'
    gates = entrances(L, r, src_ends, mode)
    noise = smooth_noise(M.shape, 9, seed)
    cost = 1.0 + 0.9 * noise + 2.6 * np.exp(-np.minimum(dt, 30) / 5.0)
    cost[~free] = 1e5
    cost[net] = 0.35

    def stamp(path, w, k):
        if not path:
            return
        a = np.array(path)
        net[a[:, 0], a[:, 1]] = True
        wmap[a[:, 0], a[:, 1]] = np.maximum(wmap[a[:, 0], a[:, 1]], w)
        kmap[a[:, 0], a[:, 1]] = k
        cost[a[:, 0], a[:, 1]] = 0.35

    plazas = []
    dmax = float(dt.max()) if free.any() else 0
    # circuit walk inside the edge
    if not has_src and area >= 12000 and dmax >= 22:
        depth = min(14.0, dmax * 0.4) if not trail else min(30.0, dmax * 0.45)
        sm = ndi.gaussian_filter((dt >= depth).astype(np.float32), 4.0) > 0.5
        sm &= free
        lab2, n2 = ndi.label(sm)
        if n2:
            big = np.argmax(ndi.sum(sm, lab2, np.arange(1, n2 + 1))) + 1
            sm = lab2 == big
            sm = ndi.binary_fill_holes(sm) & free if t != 'nature' else sm  # city loops skip the inner pond rings
            ring = skeletonize(ndi.binary_dilation(sm & ~ndi.binary_erosion(sm)))
            stamp(list(zip(*np.nonzero(ring))), w_main, k_main)
    # waterfront promenade: a wide walk 6 m in from the water (or the beach) where the fan map draws none
    if t == 'waterfront':
        wet = (np.isin(cs, (C['water'], C['beach'])) & ~M) | low
        if wet.any():
            dw = ndi.distance_transform_edt(~wet) * MPP
            band = free & (np.abs(dw - 4.5) < 1.3)
            have = ndi.binary_dilation(net, iterations=6)
            band &= ~have
            lab3, n3 = ndi.label(band, structure=np.ones((3, 3), bool))
            for k in range(1, n3 + 1):
                seg = lab3 == k
                if seg.sum() * MPP / 2 < 45:
                    continue
                ln = skeletonize(ndi.binary_dilation(seg))
                stamp(list(zip(*np.nonzero(ln))), W_PROM, K_PROM)
    # coverage: no lawn farther than R from a path (new hubs link to the network twice, so no dead ends)
    R = 110.0 if trail else 120.0 if has_src else 38.0
    edge_front = None
    hubs = []
    for it in range(16 if not trail else 10):
        if net.any():
            dnet = ndi.distance_transform_edt(~net) * MPP
        else:
            dnet = np.full(M.shape, 1e9)
        cand = free & (dt >= (6.0 if not trail else 12.0)) & (dnet > R)
        if not cand.any():
            break
        score = np.where(cand, np.minimum(dnet, 400) + 0.6 * dt, -1)
        h = np.unravel_index(np.argmax(score), score.shape)
        hubs.append(h)
        if not net.any():
            net[h] = True
            continue
        starts = list(zip(*np.nonzero(net)))
        p1 = route(cost, starts, h)
        if not p1:
            break
        stamp(p1, w_main, k_main)
        # a second link from the hub, away from the first (a loop through the hub instead of a dead end)
        c2 = cost.copy()
        a = np.array(p1)
        blk = np.zeros(M.shape, bool)
        blk[a[:, 0], a[:, 1]] = True
        blk = ndi.binary_dilation(blk, iterations=10)
        blk[max(0, h[0] - 2):h[0] + 3, max(0, h[1] - 2):h[1] + 3] = False
        c2[blk] = 1e5
        starts2 = [s for s in starts if not blk[s]]
        if starts2:
            m2 = None
            from skimage.graph import MCP_Geometric
            m2 = MCP_Geometric(c2)
            cc, _ = m2.find_costs(starts2, [h])
            p2 = m2.traceback(h) if np.isfinite(cc[h]) and cc[h] < 1e4 else None
            if p2 and len(p2) < 2.6 * len(p1) + 20:
                stamp(p2, w_main if trail else W_PATH, k_main)
                continue
        # no second link: carry the path on to the park edge nearest the hub (a cut-through, not a dead end)
        edge = M & ~ndi.binary_erosion(M) & ~blk
        if edge.any():
            ey, ex = np.nonzero(edge)
            dd = np.hypot(ey - h[0], ex - h[1])
            j = int(np.argmin(dd))
            if dd[j] * MPP < 70:
                c3 = c2.copy()
                c3[ey[j], ex[j]] = 4.0
                p3 = route(c3, [h], (int(ey[j]), int(ex[j])))
                if p3:
                    stamp(p3, W_PATH if not trail else W_TRAIL, k_main)
    # plazas: the deepest lawn point on the network of city parks (+ every coverage hub of big ones)
    if not trail:
        main = None
        if net.any():
            cand = net & free
            if cand.any():
                main = np.unravel_index(np.argmax(np.where(cand, dt, -1)), dt.shape)
        for h in ([main] if main is not None else []) + hubs[:3]:
            if h is None or not net[max(0, h[0] - 1):h[0] + 2, max(0, h[1] - 1):h[1] + 2].any():
                continue
            if t == 'plaza':
                rr = min(9.0, 0.22 * math.sqrt(area), dt[h] - 2.0)
            else:
                rr = min(8.5, 4.0 + area / 14000.0, dt[h] - 3.0)
            if rr >= (3 if h is main else 5) and all(math.hypot(h[0] - q[0][0], h[1] - q[0][1]) * MPP > 40 for q in plazas):
                plazas.append((h, rr))
    # gates -> nearest network point
    for (gy, gx, pri) in gates:
        if not (0 <= gy < L.H and 0 <= gx < L.W):
            continue
        if net[max(0, gy - 2):gy + 3, max(0, gx - 2):gx + 3].any():
            continue
        starts = list(zip(*np.nonzero(net)))
        if not starts:
            net[gy, gx] = True
            continue
        c2 = cost.copy()
        c2[max(0, gy - 1):gy + 2, max(0, gx - 1):gx + 2] = np.minimum(c2[max(0, gy - 1):gy + 2, max(0, gx - 1):gx + 2], 4.0)
        pth = route(c2, starts, (gy, gx))
        lim = 40 if mode == 'source' and pri < 4 else 240
        if pth and len(pth) * MPP < lim:
            stamp(pth, W_TRAIL if trail else W_PATH, k_main)
    if not net.any():
        return None
    # one connected network: every separate piece links to the rest (shortest route, up to 90 m)
    for _ in range(12):
        lab4, n4 = ndi.label(net, structure=np.ones((3, 3), bool))
        if n4 <= 1:
            break
        sizes = ndi.sum(net, lab4, np.arange(1, n4 + 1))
        joined = False
        for k in np.argsort(sizes) + 1:
            piece = lab4 == k
            rest = net & ~piece
            from skimage.graph import MCP_Geometric
            m4 = MCP_Geometric(np.where(piece, 0.35, cost))
            cc, _ = m4.find_costs(list(zip(*np.nonzero(piece))))
            cc = np.where(rest, cc, np.inf)
            j = np.unravel_index(np.argmin(cc), cc.shape)
            if not np.isfinite(cc[j]) or cc[j] > 90 / MPP * 2.5:
                continue
            p4 = m4.traceback(j)
            stamp(p4, W_PATH if not trail else W_TRAIL, k_main)
            joined = True
            break
        if not joined:
            break
    blob = ndi.binary_closing(ndi.binary_dilation(net, iterations=1), iterations=1)
    sk = skeletonize(blob)
    nodes, edges = trace_graph(sk)
    gate_px = [(g[0], g[1]) for g in gates if net[max(0, g[0] - 2):g[0] + 3, max(0, g[1] - 2):g[1] + 3].any()]
    for _ in range(4):
        deg = np.zeros(len(nodes), int)
        for a, b, ch in edges:
            deg[a] += 1
            deg[b] += 1
        keep = []
        for a, b, ch in edges:
            Lm = len(ch) * MPP
            loose = [q for q in (a, b) if deg[q] == 1]
            at_gate = any(min(math.hypot(nodes[q][0] - gy, nodes[q][1] - gx) for gy, gx in gate_px) * MPP < 6
                          for q in loose) if gate_px else False
            if loose and a != b and Lm < 10 and not at_gate:
                continue
            keep.append((a, b, ch))
        if len(keep) == len(edges):
            break
        edges = keep
    return dict(nodes=nodes, edges=edges, wmap=wmap, kmap=kmap, gates=gate_px, plazas=plazas, hubs=hubs, src=src,
                dt=dt, free=free, obst=obst, sport=sport)


def network_polylines(L, G_, park_type):
    """graph on the local grid -> world polylines (smoothed), widths, kinds; node flags (entrance)."""
    nodes, edges = G_['nodes'], G_['edges']
    wmap, kmap = G_['wmap'], G_['kmap']
    deg = np.zeros(len(nodes), int)
    for a, b, ch in edges:
        deg[a] += 1
        deg[b] += 1
    out_nodes = []
    for i, (y, x) in enumerate(nodes):
        wx, wz = L.world(y, x)
        gate = deg[i] == 1 and any(math.hypot(y - gy, x - gx) * MPP < 7 for gy, gx in G_['gates'])
        out_nodes.append([wx, wz, 1 if gate else 0, int(deg[i])])
    paths = []
    water = np.isin(L.cs, (C['water'], C['beach'])) & ~L.M
    dwater = ndi.distance_transform_edt(~water) * MPP
    for a, b, ch in edges:
        ch = np.array(ch, np.float64)
        if len(ch) < 2:
            continue
        ws = [wmap[int(y), int(x)] for y, x in ch]
        ks = [kmap[int(y), int(x)] for y, x in ch]
        w = float(np.median([v for v in ws if v > 0] or [W_PATH]))
        k = int(np.bincount(ks).argmax())
        # promenades: waterfront walks right along the water
        if park_type == 'waterfront' and k == K_PAVED:
            near = np.mean([dwater[int(y), int(x)] < 22 for y, x in ch])
            if near > 0.6 and len(ch) * MPP > 40:
                w, k = W_PROM, K_PROM
        Q = ch.copy()
        Q[0] = nodes[a]
        Q[-1] = nodes[b]
        Q = chaikin(rdp(Q, 0.45), 3)
        Q = rdp(Q, 0.04)
        pts = []
        for y, x in Q:
            wx, wz = L.world(y, x)
            pts += [round(wx, 1), round(wz, 1)]
        if poly_len(np.array(pts).reshape(-1, 2)) < 2:
            continue
        paths.append(dict(p=pts, w=round(w, 1), k=k, a=a, b=b))
    return out_nodes, paths


# ------------------------------------------------------------------------------------------------------------ dressing
CITY = ('neighbourhood', 'waterfront', 'plaza', 'sports')


def resample(P, step):
    P = np.asarray(P, np.float64)
    seg = np.hypot(*np.diff(P, axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    if cum[-1] < 1e-6:
        return P[:1], np.zeros((1, 2)), cum[-1]
    s = np.arange(0, cum[-1] + 1e-6, step)
    x = np.interp(s, cum, P[:, 0])
    z = np.interp(s, cum, P[:, 1])
    tx = np.gradient(x)
    tz = np.gradient(z)
    tl = np.maximum(np.hypot(tx, tz), 1e-6)
    return np.stack([x, z], 1), np.stack([tx / tl, tz / tl], 1), cum[-1]


class Spots:
    """lookups on a park's local grid for prop / tree placement (world coordinates in)"""

    def __init__(self, L, G_, paths, plazas):
        self.L = L
        H, W = L.M.shape
        img = Image.new('L', (W * 2, H * 2), 0)  # 1 m raster of the paths (and plazas) with their widths
        dr = ImageDraw.Draw(img)
        for p in paths:
            q = np.array(p['p']).reshape(-1, 2)
            pts = [(((x - X0) / MPP - L.x0) * 2, ((z - Z0) / MPP - L.y0) * 2) for x, z in q]
            dr.line(pts, fill=255, width=max(1, int(round(p['w']))), joint='curve')
            for x, y in (pts[0], pts[-1]):
                rr = p['w'] / 2
                dr.ellipse((x - rr, y - rr, x + rr, y + rr), fill=255)
        for (x, z, r, k) in plazas:
            cx, cy = ((x - X0) / MPP - L.x0) * 2, ((z - Z0) / MPP - L.y0) * 2
            dr.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
        self.pathpx = np.array(img) > 0
        self.dpath = ndi.distance_transform_edt(~self.pathpx) * 0.5  # m from the nearest path / plaza edge
        self.free = G_['free']
        self.dedge = ndi.distance_transform_edt(L.M) * MPP
        self.dt = G_['dt']
        self.used = []  # (x, z, r) occupied discs (props, surfaces)

    def ij(self, x, z):
        y, xx = self.L.local(x, z)
        return int(round(y)), int(round(xx))

    def ok(self, x, z, clear_path=0.4, clear_obst=1.2, rad=0.8, edge=0.5):
        i, j = self.ij(x, z)
        H, W = self.free.shape
        if not (0 <= i < H and 0 <= j < W) or not self.free[i, j]:
            return False
        if self.dt[i, j] < clear_obst or self.dedge[i, j] < edge:
            return False
        i2, j2 = int(round(((z - Z0) / MPP - self.L.y0) * 2)), int(round(((x - X0) / MPP - self.L.x0) * 2))
        if not (0 <= i2 < self.dpath.shape[0] and 0 <= j2 < self.dpath.shape[1]) or self.dpath[i2, j2] < clear_path:
            return False
        for (ux, uz, ur) in self.used:
            if (ux - x) ** 2 + (uz - z) ** 2 < (ur + rad) ** 2:
                return False
        return True

    def dp(self, x, z):
        i2, j2 = int(round(((z - Z0) / MPP - self.L.y0) * 2)), int(round(((x - X0) / MPP - self.L.x0) * 2))
        if not (0 <= i2 < self.dpath.shape[0] and 0 <= j2 < self.dpath.shape[1]):
            return 0.0
        return float(self.dpath[i2, j2])

    def take(self, x, z, r):
        self.used.append((x, z, r))


def dress(r, L, G_, nodes, paths, seed, hat=None):
    """benches, bins, lamps, picnic tables, playground, court, fountains, planters, railings, signs, trees"""
    rng = np.random.default_rng(seed)
    t, area = r['type'], r['area']
    city = t in CITY
    plazas = []
    for k, (h, rr) in enumerate(G_['plazas']):
        x, z = L.world(*h)
        kind = 1 if (k == 0 and rr >= 5 and t != 'sports') else 0
        plazas.append([round(x, 1), round(z, 1), round(float(rr), 1), kind])
    S = Spots(L, G_, paths, plazas)
    props = {k: [] for k in ('bench', 'bin', 'picnic', 'planter', 'fountain', 'playground', 'hoop', 'railing', 'sign', 'lamp')}
    surfaces = []
    trees = []
    gates = [(n[0], n[1]) for n in nodes if n[2]]
    for (x, z, rr, kind) in plazas:
        S.take(x, z, rr + 0.5)
        if kind == 1:
            props['fountain'] += [x, z, 0.0]
        nb = 4 if rr < 6 else 6
        a0 = rng.random() * math.pi
        for k in range(nb):
            a = a0 + k * 2 * math.pi / nb
            bx, bz = x + math.cos(a) * (rr + 1.1), z + math.sin(a) * (rr + 1.1)
            if S.ok(bx, bz, clear_path=-1, rad=0.9):
                props['bench'] += [round(bx, 2), round(bz, 2), round(math.atan2(x - bx, z - bz), 3)]
                S.take(bx, bz, 1.0)
        if city:
            for k in range(3 if rr < 7 else 4):
                a = a0 + (k + 0.5) * 2 * math.pi / (3 if rr < 7 else 4)
                lx, lz = x + math.cos(a) * (rr + 0.7), z + math.sin(a) * (rr + 0.7)
                if S.ok(lx, lz, clear_path=-1, rad=0.6):
                    props['lamp'] += [round(lx, 2), round(lz, 2), round(math.atan2(x - lx, z - lz), 3)]
                    S.take(lx, lz, 0.8)
            if t == 'plaza' or rr >= 7:
                for k in range(6):
                    a = a0 + (k + 0.25) * 2 * math.pi / 6
                    px_, pz_ = x + math.cos(a) * (rr - 1.4), z + math.sin(a) * (rr - 1.4)
                    if rr >= 5 and (kind != 1 or rr - 1.4 > 4.2):
                        props['planter'] += [round(px_, 2), round(pz_, 2), round(a, 3)]
    # along the paths
    lamp_step = 30.0
    for pi_, p in enumerate(paths):
        P = np.array(p['p']).reshape(-1, 2)
        pts, tan, Lp = resample(P, 1.0)
        if Lp < 8:
            continue
        hw = p['w'] / 2
        trail = p['k'] == K_TRAIL
        bstep = 70.0 if trail else 24.0 if p['k'] == K_PROM else 27.0
        s0 = rng.random() * 8 + 6
        side = 1 if rng.random() < 0.5 else -1
        k = 0
        for s in np.arange(s0, Lp - 6, bstep):
            i = int(s)
            x, z = pts[i]
            tx, tz = tan[i]
            if any(math.hypot(x - gx, z - gz) < 9 for gx, gz in gates):
                continue
            nx, nz = -tz * side, tx * side
            bx, bz = x + nx * (hw + 0.95), z + nz * (hw + 0.95)
            if S.ok(bx, bz, clear_path=0.5, rad=1.0):
                props['bench'] += [round(bx, 2), round(bz, 2), round(math.atan2(-nx, -nz), 3)]
                S.take(bx, bz, 1.1)
                if k % 2 == 0 and not trail:
                    ox, oz = bx + tx * 1.6, bz + tz * 1.6
                    if S.ok(ox, oz, clear_path=0.3, rad=0.4):
                        props['bin'] += [round(ox, 2), round(oz, 2), round(math.atan2(-nx, -nz), 3)]
                        S.take(ox, oz, 0.5)
                k += 1
            side = -side
        if city and not trail:
            side = 1 if pi_ % 2 else -1
            for s in np.arange(lamp_step * 0.5 + rng.random() * 6, Lp - 3, lamp_step):
                i = int(s)
                x, z = pts[i]
                tx, tz = tan[i]
                nx, nz = -tz * side, tx * side
                lx, lz = x + nx * (hw + 0.55), z + nz * (hw + 0.55)
                if S.ok(lx, lz, clear_path=0.3, rad=0.6, clear_obst=0.8, edge=0.3):
                    props['lamp'] += [round(lx, 2), round(lz, 2), round(math.atan2(-nx, -nz), 3)]
                    S.take(lx, lz, 0.9)
                side = -side
        # promenade railing on the water side (where the ground drops to the water within 8 m)
        if p['k'] == K_PROM and hat is not None:
            for s in np.arange(1.2, Lp - 1.2, 2.4):
                i = int(s)
                x, z = pts[i]
                tx, tz = tan[i]
                for sd in (1, -1):
                    nx, nz = -tz * sd, tx * sd
                    rx, rz = x + nx * (hw + 0.45), z + nz * (hw + 0.45)
                    if hat(rx, rz) >= 0.36 and hat(x + nx * (hw + 7), z + nz * (hw + 7)) < 0.1 and S.dp(rx, rz) > 0.2:
                        props['railing'] += [round(rx, 2), round(rz, 2), round(math.atan2(-tz, tx), 3)]
                        break
        # palms along promenades (landward side)
        if p['k'] == K_PROM:
            for s in np.arange(5, Lp - 3, 11.0):
                i = int(s)
                x, z = pts[i]
                tx, tz = tan[i]
                for sd in (1, -1):
                    nx, nz = -tz * sd, tx * sd
                    qx, qz = x + nx * (hw + 2.6), z + nz * (hw + 2.6)
                    if S.ok(qx, qz, clear_path=1.8, rad=2.5, edge=1.5):
                        trees += [round(qx, 1), round(qz, 1), 0, round(0.85 + 0.3 * rng.random(), 2)]
                        S.take(qx, qz, 2.6)
    # gate signs (named parks): a board beside the first two gates
    if r['label'] or t == 'nature':
        for (gx, gz) in gates[:2 if t != 'nature' else 4]:
            for ang in np.linspace(0, 2 * math.pi, 12, endpoint=False):
                sx, sz = gx + math.cos(ang) * 3.2, gz + math.sin(ang) * 3.2
                if S.ok(sx, sz, clear_path=0.8, rad=0.8, edge=0.8):
                    props['sign'] += [round(sx, 2), round(sz, 2), round(math.atan2(gx - sx, gz - sz), 3)]
                    S.take(sx, sz, 1.0)
                    break
    # lawn features: playground, court, picnic tables
    M = L.M
    ys, xs = np.nonzero(S.free & (S.dt >= 3))
    order = rng.permutation(len(ys))

    def find(rad, dmin, dmax):
        for q in order:
            x, z = L.world(ys[q], xs[q])
            d = S.dp(x, z)
            if d < dmin or d > dmax or S.dt[ys[q], xs[q]] < rad + 1:
                continue
            if S.ok(x, z, clear_path=dmin, rad=rad, clear_obst=rad):
                return x, z
        return None

    def facing(x, z):
        i2, j2 = int(round(((z - Z0) / MPP - L.y0) * 2)), int(round(((x - X0) / MPP - L.x0) * 2))
        _, (iy, ix) = ndi.distance_transform_edt(~S.pathpx[max(0, i2 - 60):i2 + 61, max(0, j2 - 60):j2 + 61], return_indices=True)
        cy, cx = min(60, i2), min(60, j2)
        py_, px_ = iy[cy, cx] - cy, ix[cy, cx] - cx
        return math.atan2(px_, py_)

    if t in ('neighbourhood', 'waterfront', 'sports') and area >= 6000:
        q = find(9.0, 5.0, 16.0)
        if q:
            yaw = facing(*q)
            surfaces.append(dict(k='playground', x=round(q[0], 1), z=round(q[1], 1), yaw=round(yaw, 3), w=15.0, l=12.0))
            props['playground'] += [round(q[0], 2), round(q[1], 2), round(yaw, 3)]
            S.take(q[0], q[1], 9.5)
    if t in ('neighbourhood', 'waterfront') and area >= 14000 and (S.free.sum() > 0):
        q = find(16.5, 4.0, 30.0)
        if q:
            yaw = facing(*q) + math.pi / 2
            surfaces.append(dict(k='court', x=round(q[0], 1), z=round(q[1], 1), yaw=round(yaw, 3), w=15.0, l=28.0))
            for sd in (1, -1):
                hx, hz = q[0] + math.sin(yaw) * 13.2 * sd, q[1] + math.cos(yaw) * 13.2 * sd
                props['hoop'] += [round(hx, 2), round(hz, 2), round(yaw + (0 if sd < 0 else math.pi), 3)]
            S.take(q[0], q[1], 16.5)
    if t in ('neighbourhood', 'waterfront', 'sports'):
        n = int(min(7, area / 5500))
        for _ in range(n):
            q = find(2.2, 4.0, 14.0)
            if not q:
                break
            yaw = facing(*q) + rng.uniform(-0.4, 0.4)
            props['picnic'] += [round(q[0], 2), round(q[1], 2), round(yaw, 3)]
            S.take(q[0], q[1], 9.0)
    # waterfront railing along a seawall (park edge on open water, not on a beach)
    if t == 'waterfront':
        water = (L.cs == C['water']) & ~M
        edge = M & ~ndi.binary_erosion(M) & ndi.binary_dilation(water, iterations=2)
        dw = ndi.distance_transform_edt(~water)
        gy_, gx_ = np.gradient(dw)
        ey, ex = np.nonzero(edge)
        taken = []
        for q in rng.permutation(len(ey)):
            x, z = L.world(ey[q], ex[q])
            if any((x - a) ** 2 + (z - b) ** 2 < 2.3 ** 2 for a, b in taken):
                continue
            gy0, gx0 = gy_[ey[q], ex[q]], gx_[ey[q], ex[q]]
            gl = math.hypot(gy0, gx0) or 1
            # inset 0.7 m towards land, unit runs along the shore (normal = gradient)
            # inland until the ground stands clear of the water (the bank slopes down to the sea level)
            x2, z2 = x + gx0 / gl * 0.3, z + gy0 / gl * 0.3
            for _ in range(10):
                if hat is None or hat(x2, z2) >= 0.4:
                    break
                x2, z2 = x2 + gx0 / gl * 0.6, z2 + gy0 / gl * 0.6
            if (hat is not None and hat(x2, z2) < 0.37) or S.dp(x2, z2) < 0.3:
                continue
            taken.append((x, z))
            props['railing'] += [round(x2, 2), round(z2, 2), round(math.atan2(gx0, gy0), 3)]
    # trees: clusters along the edges, a few specimen trees on the lawns, bushes under the edge trees
    noise = smooth_noise(M.shape, 6, seed + 99)
    tree_ok = S.free & (S.dt >= 2.0)
    nat = t in ('nature', 'golf')
    palm_share = {'waterfront': 0.55, 'plaza': 0.35, 'neighbourhood': 0.22, 'sports': 0.2, 'golf': 0.3, 'nature': 0.03}[t]
    cand = np.argwhere(tree_ok)
    cand = cand[rng.permutation(len(cand))]
    placed = []
    grid = {}

    def near_tree(x, z, d):
        gi, gj = int(x // 8), int(z // 8)
        for a in range(gi - 1, gi + 2):
            for b in range(gj - 1, gj + 2):
                for (tx_, tz_) in grid.get((a, b), ()):
                    if (tx_ - x) ** 2 + (tz_ - z) ** 2 < d * d:
                        return True
        return False

    for (i, j) in cand:
        x, z = L.world(i, j)
        x += rng.uniform(-0.9, 0.9)
        z += rng.uniform(-0.9, 0.9)
        de = S.dedge[i, j]
        nz_ = noise[i, j]
        if nat:
            want = nz_ > 0.56 or (de < 22 and nz_ > 0.4)
            spacing = 7.5
        else:
            band = 2.5 < de < 16
            want = (band and nz_ > 0.26) or (de >= 16 and (nz_ > 0.66 or rng.random() < 0.0035))
            spacing = 7.0 if band else 9.5
        if not want:
            continue
        if S.dp(x, z) < 2.6 or near_tree(x, z, spacing):
            continue
        if any((x - a) ** 2 + (z - b) ** 2 < (c + 1.5) ** 2 for a, b, c in S.used):
            continue
        if t == 'nature':
            ty = 2 if (rng.random() < 0.35) else 1
        else:
            ty = 0 if rng.random() < palm_share else 1
        sc = 0.8 + 0.45 * rng.random()
        trees += [round(x, 1), round(z, 1), ty, round(sc, 2)]
        grid.setdefault((int(x // 8), int(z // 8)), []).append((x, z))
        placed.append((x, z))
        if de < 9 and rng.random() < 0.45:
            a = rng.random() * 6.28
            bx, bz = x + math.cos(a) * 2.6, z + math.sin(a) * 2.6
            if S.dp(bx, bz) > 1.5 and S.ok(bx, bz, clear_path=1.5, rad=0.5, edge=0.6):
                trees += [round(bx, 1), round(bz, 1), 3, round(0.7 + 0.5 * rng.random(), 2)]
    return dict(plazas=plazas, props=props, surfaces=surfaces, trees=trees)


def park_mask_rle(r, world):
    """park interior as 4 m game texels: [i0, j0, w, h, run-length (alternating off/on counts row-major)]"""
    WX0, WZ0, TS = world['bounds'][0], world['bounds'][1], world['ts']
    ox, oy = int((WX0 - X0) / MPP), int((WZ0 - Z0) / MPP)
    sl, m = r['sl'], r['mask']
    y0, x0 = sl[0].start, sl[1].start
    # texel grid range covering the bbox
    i0 = (x0 - ox) // 2
    j0 = (y0 - oy) // 2
    i1 = (sl[1].stop - ox + 1) // 2
    j1 = (sl[0].stop - oy + 1) // 2
    w, h = i1 - i0, j1 - j0
    full = np.zeros((h * 2, w * 2), bool)
    py0, px0 = oy + j0 * 2, ox + i0 * 2
    full[y0 - py0:y0 - py0 + m.shape[0], x0 - px0:x0 - px0 + m.shape[1]] = m
    tex = full.reshape(h, 2, w, 2).sum((1, 3)) >= 2
    flat = tex.ravel()
    runs = []
    cur, n = False, 0
    for v in flat:
        if v == cur:
            n += 1
        else:
            runs.append(n)
            cur, n = v, 1
    runs.append(n)
    return [int(i0), int(j0), int(w), int(h)] + [int(x) for x in runs], tex, (i0, j0)


def ground_patch(r, tex, ij0, cls, ground, world):
    """texels of the park that the game shows as plain grass / town / bogus building: become park (sport on fields)"""
    WX0, WZ0 = world['bounds'][0], world['bounds'][1]
    ox, oy = int((WX0 - X0) / MPP), int((WZ0 - Z0) / MPP)
    i0, j0 = ij0
    h, w = tex.shape
    py0, px0 = oy + j0 * 2, ox + i0 * 2
    cs = np.zeros((h * 2, w * 2), np.uint8)
    ys0, xs0 = max(0, py0), max(0, px0)
    sub = cls[ys0:py0 + h * 2, xs0:px0 + w * 2]
    cs[ys0 - py0:ys0 - py0 + sub.shape[0], xs0 - px0:xs0 - px0 + sub.shape[1]] = sub
    blk = cs.reshape(h, 2, w, 2).transpose(0, 2, 1, 3).reshape(h, w, 4)
    open_ = np.isin(blk, (C['park'], C['land'], C['sport'], C['unknown'])).sum(-1) >= 2
    sport = (blk == C['sport']).sum(-1) >= 2
    TH, TW = ground.shape
    out = []
    for j in range(h):
        gj = j0 + j
        if not (0 <= gj < TH):
            continue
        row = []
        for i in range(w):
            gi = i0 + i
            if not (0 <= gi < TW) or not tex[j, i] or not open_[j, i]:
                continue
            g = ground[gj, gi]
            want = G['sport'] if sport[j, i] else G['park']
            if g == want or g in (G['water'], G['road']):
                continue
            if g in (G['grass'], G['urban'], G['paved'], G['dirt'], G['farm'], G['sand'], G['building'], G['park'], G['sport']):
                row.append((gi, want))
        # runs of equal class
        k = 0
        while k < len(row):
            gi, c = row[k]
            n = 1
            while k + n < len(row) and row[k + n][0] == gi + n and row[k + n][1] == c:
                n += 1
            out += [gj, gi, n, int(c)]
            k += n
    return out


def debug_net(r, L, G_, nodes, paths, out_dir='/tmp/parks-net'):
    os.makedirs(out_dir, exist_ok=True)
    S = 3
    img = np.zeros((L.H, L.W, 3), np.uint8)
    img[L.M] = (70, 120, 60)
    img[G_['sport']] = (60, 170, 60)
    img[G_['obst']] = (120, 60, 40)
    img[G_['src']] = (200, 160, 110)
    im = Image.fromarray(img).resize((L.W * S, L.H * S), Image.NEAREST)
    dr = ImageDraw.Draw(im)
    for p in paths:
        q = np.array(p['p']).reshape(-1, 2)
        pts = [((x - X0) / MPP - L.x0 * 1.0, (z - Z0) / MPP - L.y0 * 1.0) for x, z in q]
        col = (255, 255, 255) if p['k'] == 0 else (80, 200, 255) if p['k'] == 1 else (230, 200, 120)
        dr.line([(a * S, b * S) for a, b in pts], fill=col, width=max(1, int(p['w'] / MPP * S)))
    for n in nodes:
        y, x = L.local(n[0], n[1])
        if n[2]:
            dr.ellipse(((x - 2) * S, (y - 2) * S, (x + 2) * S, (y + 2) * S), outline=(255, 0, 0), width=2)
    for (h, rr) in G_['plazas']:
        y, x = h
        R = rr / MPP
        dr.ellipse(((x - R) * S, (y - R) * S, (x + R) * S, (y + R) * S), outline=(255, 255, 0), width=2)
    im.save(os.path.join(out_dir, r['id'] + '.png'))


def main():
    t0 = time.time()
    world, ground, hgt, roads, blds, lm = load_world()
    cls = np.load(os.path.join(CLSD, 'cls.npy'))
    img = np.asarray(Image.open(os.path.join(RAW, 'mosaic_nc_z5.png')).convert('RGB'))
    pm = path_mask_full(img)
    log(f'loaded + footpath pixels {int(pm.sum())} ({time.time() - t0:.1f}s)')
    parks = inventory(cls, pm, lm)
    parity(parks, cls, ground, world, roads, blds)
    for r in parks:
        log(f"{r['id']:14s} {r['type']:13s} {int(r['area']):7d} m2  park {r['g_park']:.2f} grass {r['g_grass']:.2f} built {r['g_built']:.2f}"
            f"  blds {len(r['bad_blds'])} roads {int(r['bad_road_m'])} m  {r['label']}")
    if '--sheets' in sys.argv:
        sheets(parks, img, ground, world, roads, blds)
    # unnamed pieces inside the golf course belong to it
    for g in [p for p in parks if p['type'] == 'golf']:
        gs = g['sl']
        for r in parks:
            if r is g or r['label']:
                continue
            px, py = px_of(r['x'], r['z'])
            if gs[0].start <= py < gs[0].stop and gs[1].start <= px < gs[1].stop:
                r['type'], r['label'], r['part_of'] = 'golf', '', g['id']
    WX0, WZ0, HS = world['bounds'][0], world['bounds'][1], world['hs']

    def hat(x, z):  # terrain height (bilinear on the 8 m grid; the game's triangles differ by centimetres)
        fx, fz = (x - WX0) / HS, (z - WZ0) / HS
        i, j = int(fx), int(fz)
        tx, tz = fx - i, fz - j
        i = min(max(i, 0), hgt.shape[1] - 2)
        j = min(max(j, 0), hgt.shape[0] - 2)
        return float(hgt[j, i] * (1 - tx) * (1 - tz) + hgt[j, i + 1] * tx * (1 - tz) + hgt[j + 1, i] * (1 - tx) * tz + hgt[j + 1, i + 1] * tx * tz)
    def hgrid(L):  # bilinear terrain height at every cell centre of a park's local grid
        ys, xs = np.mgrid[0:L.H, 0:L.W]
        wx = X0 + (L.x0 + xs + 0.5) * MPP
        wz = Z0 + (L.y0 + ys + 0.5) * MPP
        fx = np.clip((wx - WX0) / HS, 0, hgt.shape[1] - 1.001)
        fz = np.clip((wz - WZ0) / HS, 0, hgt.shape[0] - 1.001)
        i, j = fx.astype(int), fz.astype(int)
        tx, tz = fx - i, fz - j
        return (hgt[j, i] * (1 - tx) * (1 - tz) + hgt[j, i + 1] * tx * (1 - tz) + hgt[j + 1, i] * (1 - tx) * tz + hgt[j + 1, i + 1] * tx * tz).astype(np.float32)
    deg = node_degrees(roads)
    only = [a.split('=')[1] for a in sys.argv if a.startswith('--only=')]
    out = dict(v=1, built=time.strftime('%Y-%m-%d %H:%M'), source='YANIS v17 (map.stateofleonida.net) park areas, footpaths and POIs',
               parks=[], paths=[], nodes=[], plazas=[], surfaces=[], props={}, trees=[], ground=[], hide=[])
    report = []
    for pi, r in enumerate(parks):
        if only and r['id'] not in only[0].split(','):
            continue
        t1 = time.time()
        L = Local(r, cls, pm, roads, blds, deg)
        G_ = build_network(r, L, seed=pi + 1, hgrid=hgrid)
        nodes, paths = network_polylines(L, G_, r['type']) if G_ else ([], [])
        if G_ is None:
            G_ = dict(plazas=[], free=L.M.copy(), dt=ndi.distance_transform_edt(L.M) * MPP, gates=[])
        D = dress(r, L, G_, nodes, paths, seed=pi + 7, hat=hat)
        rle, tex, ij0 = park_mask_rle(r, world)
        gp = ground_patch(r, tex, ij0, cls, ground, world)
        base = len(out['nodes'])
        for n in nodes:
            out['nodes'].append([round(n[0], 1), round(n[1], 1), n[2]])
        for p in paths:
            out['paths'].append(dict(p=p['p'], w=p['w'], k=p['k'], a=p['a'] + base, b=p['b'] + base, park=len(out['parks'])))
        out['plazas'] += D['plazas']
        out['surfaces'] += D['surfaces']
        for k, v in D['props'].items():
            out['props'].setdefault(k, []).extend(v)
        out['trees'] += D['trees']
        out['ground'] += gp
        for bi in r['bad_blds']:
            p = np.array(blds[bi]['p']).reshape(-1, 2).mean(0)
            out['hide'] += [round(float(p[0]), 1), round(float(p[1]), 1)]
        plen = sum(poly_len(np.array(p['p']).reshape(-1, 2)) for p in paths)
        ys, xs = np.nonzero(r['mask'])
        bx0, bz0 = world_of(r['sl'][1].start + xs.min(), r['sl'][0].start + ys.min())
        bx1, bz1 = world_of(r['sl'][1].start + xs.max(), r['sl'][0].start + ys.max())
        out['parks'].append(dict(id=r['id'], name=r['name'], label=r['label'], real=r['real'], type=r['type'], src=r['src'],
                                 x=round(r['x'], 1), z=round(r['z'], 1), area=round(r['area']), bbox=[round(bx0), round(bz0), round(bx1), round(bz1)],
                                 mask=rle, poi=r['poi'], part_of=r.get('part_of')))
        np_ = {k: len(v) // 3 for k, v in D['props'].items()}
        report.append(dict(id=r['id'], label=r['label'], type=r['type'], src=r['src'], area=round(r['area']),
                           game_park_before=round(r['g_park'], 2), game_grass_before=round(r['g_grass'], 2), game_built_before=round(r['g_built'], 2),
                           ground_fixed=sum(gp[k + 2] for k in range(0, len(gp), 4)), blds_hidden=len(r['bad_blds']), roads_on_open_park_m=round(r['bad_road_m']),
                           source_paths=bool(G_.get('src') is not None and G_['src'].any()), paths_m=round(plen), gates=len(G_['gates']),
                           plazas=len(D['plazas']), props=np_, trees=len(D['trees']) // 4, poi=r['poi']))
        log(f"{r['id']:14s} {r['type']:13s} paths {plen:6.0f} m gates {len(G_['gates']):2d} plazas {len(D['plazas'])} trees {len(D['trees']) // 4:4d} "
            f"props {sum(np_.values()):4d} ground {report[-1]['ground_fixed']:5d} ({time.time() - t1:.1f}s) {r['label']}")
        if '--debug' in sys.argv and nodes:
            debug_net(r, L, G_, nodes, paths)
    json.dump(out, open(os.path.join(DATA, 'parks.json'), 'w'), separators=(',', ':'), default=lambda o: o.item() if hasattr(o, 'item') else str(o))
    json.dump(report, open(os.path.join(CACHE, 'parks_report.json'), 'w'), indent=1, default=lambda o: o.item() if hasattr(o, 'item') else str(o))
    log(f"parks.json {os.path.getsize(os.path.join(DATA, 'parks.json')) / 1e3:.0f} kB: {len(out['parks'])} parks, {len(out['paths'])} paths, "
        f"{len(out['trees']) // 4} trees, props " + ', '.join(f'{k} {len(v) // 3}' for k, v in out['props'].items()))
    log(f'done {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
