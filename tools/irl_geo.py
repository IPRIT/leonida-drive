"""Shared helpers for the IRL building pipeline (irl_fetch.py / irl_build.py).

Fan-map markers (tools/cache/data/landmarks.json) carry a real-world prototype address + lat/lng; in-game
footprints are public/data/buildings.json. Game world: x = map x, z = -map y (north-up, metres).
OSM data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import glob
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', 'cache', 'osm')
FL = (24.0, 31.5, -88.0, -79.5)  # Florida bbox (lat0, lat1, lng0, lng1): Leonida prototypes only
SKIP_ONLY = {'natural'}           # markers that are parks / beaches / reefs, not buildings
MATCH_R = 25.0                    # marker -> game footprint search radius (m)
OSM_R = 30.0                      # prototype point -> OSM building edge (m) when not inside one
NOT_BUILDINGS = {'roof', 'no', 'carport', 'shed', 'hut', 'kiosk', 'ruins', 'collapsed', 'container', 'tent'}


# ---------------------------------------------------------------- polygons
def area(poly):
    a = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return a / 2.0


def centroid(poly):
    a = area(poly)
    if abs(a) < 1e-9:
        n = len(poly)
        return (sum(p[0] for p in poly) / n, sum(p[1] for p in poly) / n)
    cx = cy = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        c = x0 * y1 - x1 * y0
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    return (cx / (6 * a), cy / (6 * a))


def inside(x, y, poly):
    c = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            c = not c
        j = i
    return c


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def poly_dist(x, y, poly):
    """0 inside, else distance to the outline"""
    if inside(x, y, poly):
        return 0.0
    n = len(poly)
    return min(seg_dist(x, y, *poly[i], *poly[(i + 1) % n]) for i in range(n))


# ---------------------------------------------------------------- game data
def load_markers():
    lm = json.load(open(os.path.join(ROOT, 'tools', 'cache', 'data', 'landmarks.json')))
    out = {}
    for k, v in lm.items():
        if len(v) < 7 or not v[3] or not v[4] or not v[1] or len(v[1]) < 2:
            continue
        lat, lng = v[4]
        if not (FL[0] < lat < FL[1] and FL[2] < lng < FL[3]):
            continue
        tags = set(v[6] or [])
        if 'demolished' in tags:
            continue
        if tags and tags <= SKIP_ONLY:
            continue
        out[k] = {'id': k, 'name': v[0], 'x': float(v[1][0]), 'z': -float(v[1][1]), 'addr': v[3], 'll': (float(lat), float(lng)), 'tags': sorted(tags)}
    return out


_B = None


def game_buildings():
    global _B
    if _B is None:
        B = json.load(open(os.path.join(ROOT, 'public', 'data', 'buildings.json')))
        for b in B:
            p = b['p']
            b['poly'] = [(p[i], p[i + 1]) for i in range(0, len(p), 2)]
            b['c'] = (sum(p[0::2]) / (len(p) / 2), sum(p[1::2]) / (len(p) / 2))
        grid = {}
        for i, b in enumerate(B):
            grid.setdefault((int(b['c'][0] // 64), int(b['c'][1] // 64)), []).append(i)
        _B = (B, grid)
    return _B


def near_buildings(x, z, r):
    B, grid = game_buildings()
    out = []
    for gx in range(int((x - r - 200) // 64), int((x + r + 200) // 64) + 1):
        for gz in range(int((z - r - 200) // 64), int((z + r + 200) // 64) + 1):
            out += grid.get((gx, gz), [])
    return out


def match_markers(markers):
    """marker id -> {b: building index, d: distance} (inside = 0, else nearest edge <= MATCH_R)"""
    B, _ = game_buildings()
    out = {}
    for k, m in markers.items():
        best = None
        for i in near_buildings(m['x'], m['z'], MATCH_R):
            d = poly_dist(m['x'], m['z'], B[i]['poly'])
            if d <= MATCH_R and (best is None or d < best[1] or (d == best[1] and abs(area(B[i]['poly'])) < abs(area(B[best[0]]['poly'])))):
                best = (i, d)
        if best is None:
            continue
        i, d = best
        if B[i].get('g') and d > 8:  # procedural infill: only when the marker sits on it
            continue
        out[k] = {'b': i, 'd': round(d, 2)}
    return out


# ---------------------------------------------------------------- OSM
def proj(lat0, lng0):
    kx = math.cos(math.radians(lat0)) * 111320.0
    ky = 110574.0
    return lambda lat, lng: ((lng - lng0) * kx, (lat - lat0) * ky)  # (east, north) metres


def join_rings(ways):
    """assemble closed rings from member way geometries [[(lat,lng),...], ...]"""
    rings, open_ = [], [list(w) for w in ways if len(w) >= 2]
    while open_:
        cur = open_.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, w in enumerate(open_):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[::-1][1:]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[::-1][:-1] + cur
                else:
                    continue
                open_.pop(i)
                changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur[:-1])
    return rings


def element_rings(el):
    """outer rings (lists of (lat,lng)) of an OSM way/relation with geometry"""
    if el['type'] == 'way':
        g = [(p['lat'], p['lon']) for p in el.get('geometry', []) if p]
        if len(g) >= 4 and g[0] == g[-1]:
            return [g[:-1]]
        return []
    outer = [[(p['lat'], p['lon']) for p in m.get('geometry', []) if p] for m in el.get('members', [])
             if m.get('type') == 'way' and m.get('role', 'outer') in ('outer', '')]
    return join_rings(outer)


def load_elements(stage):
    els = {}
    for f in sorted(glob.glob(os.path.join(CACHE, f'{stage}_*.json'))):
        for el in json.load(open(f)).get('elements', []):
            els[(el['type'], el['id'])] = el
    return els


_S1 = None


def load_stage1():
    """OSM buildings: list of {id, tags, rings[(lat,lng)], bbox(s,w,n,e), ll centre}"""
    global _S1
    if _S1 is not None:
        return _S1
    out = []
    for (t, i), el in load_elements('s1').items():
        tags = el.get('tags', {})
        if tags.get('building', 'no') in NOT_BUILDINGS:
            continue
        rings = element_rings(el)
        if not rings:
            continue
        lats = [p[0] for r in rings for p in r]
        lngs = [p[1] for r in rings for p in r]
        out.append({'id': f'{t[0]}{i}', 'tags': tags, 'rings': rings, 'bbox': (min(lats), min(lngs), max(lats), max(lngs)),
                    'll': ((min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2)})
    grid = {}
    for o in out:
        s, w, n, e = o['bbox']
        for gy in range(int(s // 0.005), int(n // 0.005) + 1):
            for gx in range(int(w // 0.005), int(e // 0.005) + 1):
                grid.setdefault((gy, gx), []).append(o)
    _S1 = (out, grid)
    return _S1


def reset_stage1():
    global _S1
    _S1 = None


def osm_area(ob):
    P = proj(*ob['ll'])
    return sum(abs(area([P(a, b) for a, b in r])) for r in ob['rings'])


def osm_candidates(ll, osm, r=OSM_R):
    """[(dist m, area m2, building, local rings)] around a lat/lng, nearest first"""
    lat, lng = ll
    P = proj(lat, lng)
    _, grid = osm
    seen, out = set(), []
    for gy in range(int((lat - 0.002) // 0.005), int((lat + 0.002) // 0.005) + 1):
        for gx in range(int((lng - 0.002) // 0.005), int((lng + 0.002) // 0.005) + 1):
            for o in grid.get((gy, gx), []):
                if o['id'] in seen:
                    continue
                seen.add(o['id'])
                rings = [[P(a, b) for a, b in ring] for ring in o['rings']]
                d = min(poly_dist(0.0, 0.0, r_) for r_ in rings)
                if d <= r:
                    out.append((d, sum(abs(area(r_)) for r_ in rings), o, rings))
    out.sort(key=lambda t: (t[0], t[1]))
    return out


def pick_osm_building(ll, osm, r=OSM_R):
    """building containing the point (smallest if nested), else nearest within r m; ignores sheds < 25 m2"""
    c = [t for t in osm_candidates(ll, osm, r) if t[1] >= 25]
    return c[0][2] if c else None
