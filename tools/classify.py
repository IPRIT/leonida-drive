"""Classify the stitched community map mosaic (z5, 2 m/px) into semantic layers.

Outputs (raw/cls/*.npy, full resolution 2 m/px; LEONIDA_CLS=<dir> writes them elsewhere):
  cls.npy    uint8 class id per pixel (see CLASSES)
  elev.npy   uint8 elevation band index for natural land (0..11), 255 elsewhere
  depth.npy  float16 water depth (m, positive down) for water pixels, 0 elsewhere
  alley.npy  bool: alley / service / parking-aisle lines (legend "Alley", light grey ~155). cls.npy keeps the
             ground class under them (urban / paved), so the ground classes stay the same 20 ids
"""
import json
import math
import os
import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.environ.get('LEONIDA_RAW') or os.path.join(ROOT, 'raw')
OUT = os.environ.get('LEONIDA_CLS') or os.path.join(RAW, 'cls')
os.makedirs(OUT, exist_ok=True)

CLASSES = {
    'unknown': 0, 'water': 1, 'land': 2, 'park': 3, 'wetland': 4, 'beach': 5,
    'industrial': 6, 'dirtfield': 7, 'urban': 8, 'paved': 9, 'building': 10,
    'building_blue': 11, 'road': 12, 'highway': 13, 'dirtroad': 14, 'farm': 15,
    'sport': 16, 'white': 17, 'dark': 18, 'apron': 19,
}
C = CLASSES

ELEV_BANDS = [  # (rgb, meters at band centre)
    ((193, 217, 131), 6), ((187, 211, 126), 30), ((181, 204, 122), 50), ((175, 198, 117), 70),
    ((169, 191, 112), 90), ((163, 184, 109), 125), ((158, 178, 103), 175), ((152, 172, 100), 225),
    ((146, 166, 95), 275), ((141, 159, 90), 325), ((135, 153, 88), 375), ((127, 141, 83), 420),
]

COLOR_PALETTE = [  # non-gray, non-water classes: (class, rgb, tolerance)
    ('park', (151, 192, 116), 9), ('park', (144, 184, 108), 6), ('park', (136, 176, 104), 6),
    ('sport', (131, 190, 80), 9), ('wetland', (134, 202, 158), 10), ('beach', (243, 228, 131), 10),
    ('industrial', (234, 214, 145), 8), ('dirtfield', (223, 205, 138), 7), ('dirtroad', (177, 140, 80), 14),
    ('farm', (130, 172, 71), 12), ('building_blue', (160, 179, 205), 10),
    # speculative (red) roads of the legend: drawn like the confirmed ones, only red
    ('highway', (178, 87, 89), 12), ('road', (159, 84, 74), 12), ('dirtroad', (200, 101, 100), 10),
]
SPECULATIVE = {(178, 87, 89), (159, 84, 74), (200, 101, 100)}


def alley_lines(r, g, b, spread, lum, water):
    """Legend 'Alley' (service roads, parking aisles, driveways): light grey (~150-160) lines 2-4 px wide over the
    urban ground. Building outlines and roof-detail lines have the same grey, but they always touch a building
    fill (176 grey / blue roof); taxiway paint lies on apron greys and ships at sea - both are rejected by their
    surroundings, wide grey areas by thickness, and the anti-aliased rims of dark roads by distance."""
    grey = spread <= 6
    line = grey & (lum >= 129) & (lum <= 167)
    fill = (grey & (lum >= 170) & (lum <= 179)) | ((np.abs(r - 160) <= 10) & (np.abs(g - 179) <= 10) & (np.abs(b - 205) <= 10))
    white = (lum >= 236) & (spread <= 14)
    roadlike = grey & (lum <= 128)
    cand = line & ~ndi.binary_dilation(fill, iterations=2) & ~ndi.binary_dilation(white, iterations=2)
    cand &= ~ndi.binary_dilation(roadlike, iterations=1)
    lab, n = ndi.label(cand, structure=np.ones((3, 3)))
    if not n:
        return cand
    idx = np.arange(1, n + 1)
    size = ndi.sum(cand, lab, idx)
    thick = ndi.maximum(ndi.distance_transform_edt(cand), lab, idx)
    ring = ndi.binary_dilation(cand, iterations=3) & ~cand
    near_idx = ndi.distance_transform_edt(~cand, return_distances=False, return_indices=True)
    owner = np.where(ring, lab[near_idx[0], near_idx[1]], 0)
    del near_idx
    pad = grey & (lum >= 180) & (lum <= 212)
    green = (g - r > 15) & (g - b > 30)  # park / sport / land: paths in parks and pitch markings are not roads
    rn = np.maximum(ndi.sum(ring, owner, idx), 1)
    bad = ndi.sum(ring & (pad | water | green), owner, idx)
    ok = (size >= 14) & (thick <= 3.0) & (bad < 0.45 * rn)
    keep = np.zeros(n + 1, bool)
    keep[1:] = ok
    return keep[lab]


def route_shields(r, g, b):
    """Route markers / interstate shields (legend 'Route markers'): dark blue, brown and red-topped badges, and the
    white US / state badges, ~14x18 px with numerals, printed on top of the road they name."""
    core = (b - r > 60) & (r < 70) & (g < 115) & (b < 160)                       # county / interstate blue
    core |= (np.abs(r - 100) < 22) & (np.abs(g - 46) < 22) & (np.abs(b - 20) < 22)  # historic route brown
    lum = (r + g + b) // 3
    spread = np.maximum(np.maximum(np.abs(r - g), np.abs(g - b)), np.abs(r - b))
    wh = (lum >= 236) & (spread <= 14)
    out = np.zeros(core.shape, bool)
    for m, solid in ((core, 0.0), (ndi.binary_closing(wh, iterations=1), 0.55)):
        lab, n = ndi.label(m, structure=np.ones((3, 3)))
        if not n:
            continue
        sl = ndi.find_objects(lab)
        cnt = ndi.sum(m, lab, np.arange(1, n + 1))
        keep = np.zeros(n + 1, bool)
        for i, s_ in enumerate(sl):
            h, w = s_[0].stop - s_[0].start, s_[1].stop - s_[1].start
            # badge-sized blobs only (not the legend panel, rails or label words); white badges are solid
            keep[i + 1] = 7 <= h <= 30 and 7 <= w <= 30 and cnt[i] >= solid * h * w and max(h, w) <= 1.8 * min(h, w)
        out |= keep[lab]
    return ndi.binary_dilation(out, iterations=3)


def bridge_labels(cls, zones):
    """Roads under route shields and label glyphs: the nearest-class inpaint splits a road where a badge or a glyph
    covers it. Inside those zones only, close road paint along straight lines (8 directions): pixels that have road
    on both sides along some direction within the zone's reach become road again (the nearer road class wins).
    zones: [(mask, reach_px)] - shields ~16 px badges, glyph rims a few px."""
    roadlike = np.isin(cls, [C['road'], C['highway'], C['dirtroad']])
    rl = roadlike.astype(np.uint8)
    new = np.zeros_like(roadlike)
    for zone, L in zones:
        zone = zone & ~roadlike
        if not zone.any():
            continue
        fill = np.zeros_like(roadlike)
        c = L // 2
        for k in range(8):
            a = math.pi * k / 8
            ker = np.zeros((L, L), np.uint8)
            cv2.line(ker, (int(round(c - c * math.cos(a))), int(round(c - c * math.sin(a)))),
                     (int(round(c + c * math.cos(a))), int(round(c + c * math.sin(a)))), 1, 1)
            fill |= cv2.morphologyEx(rl, cv2.MORPH_CLOSE, ker).astype(bool)
        new |= fill & zone
    if new.any():
        idx = ndi.distance_transform_edt(~roadlike, return_distances=False, return_indices=True)
        cls = cls.copy()
        cls[new] = cls[idx[0][new], idx[1][new]]
    print('roads bridged under labels / shields: %d px' % int(new.sum()))
    if os.environ.get('CLASSIFY_DEBUG'):
        np.save(os.path.join(OUT, 'dbg_bridged.npy'), new)
    return cls


def main():
    meta = json.load(open(os.path.join(RAW, 'mosaic_z5.json')))
    a = np.asarray(Image.open(os.path.join(RAW, 'mosaic_nc_z5.png')).convert('RGB'))
    H, W, _ = a.shape
    print('mosaic', W, H)
    a = a.copy()
    pixel_x0 = int(os.environ.get('LEONIDA_PIXEL_X0', 0))
    pixel_y0 = int(os.environ.get('LEONIDA_PIXEL_Y0', 0))
    if not os.environ.get('LEONIDA_CLASSIFY_NO_LEGEND'):
        a[:, :192] = (44, 103, 164)  # legend panel strip -> ocean
    full_gtadb = bool(os.environ.get('LEONIDA_CLASSIFY_FULL'))
    if not full_gtadb:
        sy0, sy1 = max(0, 9300 - pixel_y0), min(H, 9700 - pixel_y0)
        sx0, sx1 = max(0, 5650 - pixel_x0), min(W, 7400 - pixel_x0)
        if sy1 > sy0 and sx1 > sx0:
            a[sy0:sy1, sx0:sx1] = (44, 103, 164)  # scale bar in the legacy cropped canvas
        # Remove the 1 km map grid in legacy global mosaic coordinates. The complete
        # GTADB canvas has a different origin and is clipped explicitly in roads.py.
        for gx in range(183, pixel_x0 + W, 500):
            x = gx - pixel_x0
            if 1 <= x and x + 2 < W:
                a[:, x] = a[:, x - 1]
                a[:, x + 1] = a[:, x + 2]
        for gy in range(499, pixel_y0 + H, 500):
            y = gy - pixel_y0
            if 1 <= y and y + 2 < H:
                a[y] = a[y - 1]
                a[y + 1] = a[y + 2]
    r = a[..., 0].astype(np.int16)
    g = a[..., 1].astype(np.int16)
    b = a[..., 2].astype(np.int16)
    cls = np.zeros((H, W), np.uint8)

    # water shades lie on the deep->shallow ramp; label shadows/blends do not
    t = np.clip((g - 100) / 76.0, -0.4, 1.4)
    water = (np.abs(r - (44 + 12 * t)) <= 7) & (np.abs(b - (164 + 60 * t)) <= 9) & (g >= 70) & (g < 200)
    waterish = (b - r > 50) & (r < 100) & (b > 85) & ~water
    cls[water] = C['water']

    spread = np.maximum(np.maximum(np.abs(r - g), np.abs(g - b)), np.abs(r - b))
    gray = (spread <= 4) & ~water
    lum = (r + g + b) // 3
    alley = alley_lines(r, g, b, spread, lum, water)
    shield = route_shields(r, g, b)
    def gset(lo, hi, name):
        cls[gray & (lum >= lo) & (lum <= hi)] = C[name]
    gset(0, 64, 'dark')
    gset(70, 95, 'road')
    gset(101, 128, 'highway')
    gset(140, 179, 'building')
    gset(180, 189, 'apron')
    gset(190, 210, 'paved')
    gset(211, 226, 'urban')
    gset(240, 255, 'white')

    # coloured palette (nearest within tolerance)
    rest = (cls == 0)
    best = np.full((H, W), 1 << 30, np.int32)
    bestc = np.zeros((H, W), np.uint8)
    rr, gg, bb = r.astype(np.int32), g.astype(np.int32), b.astype(np.int32)
    # speculative names are printed in red (255,116,116) with a darker rim that matches the speculative road reds
    redtext = ndi.binary_dilation((r > 235) & (g > 95) & (g < 140) & (np.abs(g - b) < 10), iterations=3)
    for name, (pr, pg, pb), tol in COLOR_PALETTE:
        d = (rr - pr) ** 2 + (gg - pg) ** 2 + (bb - pb) ** 2
        m = rest & (d < best) & (d <= tol * tol)
        if (pr, pg, pb) in SPECULATIVE:
            m &= ~redtext
        best[m] = d[m]
        bestc[m] = C[name]
    # elevation bands for natural land
    elev = np.full((H, W), 255, np.uint8)
    beste = np.full((H, W), 1 << 30, np.int32)
    for i, ((pr, pg, pb), _) in enumerate(ELEV_BANDS):
        d = (rr - pr) ** 2 + (gg - pg) ** 2 + (bb - pb) ** 2
        m = rest & (d < beste)
        beste[m] = d[m]
        elev[m] = i
    land_ok = rest & (beste <= 7 * 7) & (beste < best)
    pal_ok = rest & (bestc > 0) & ~land_ok
    cls[pal_ok] = bestc[pal_ok]
    cls[land_ok] = C['land']
    elev[~land_ok] = 255
    # Current YANIS motorways are pale yellow, distinct from the darker beach sand.
    pale_highway = (r > 235) & (g > 225) & (b >= 150) & (b < 225) & (r - b > 30)
    cls[pale_highway] = C['highway']
    del best, bestc, beste, rr, gg, bb

    # Brown paths enclosed by park green are pedestrian paths (e.g. CACTI),
    # not vehicular dirt roads. parks.py traces their original pixels separately.
    paths, _ = ndi.label(cls == C['dirtroad'])
    for k, sl in enumerate(ndi.find_objects(paths), 1):
        if sl is None:
            continue
        sy, sx = sl
        if (sy.stop - sy.start) * (sx.stop - sx.start) > 100000:
            continue
        sy = slice(max(0, sy.start - 3), min(H, sy.stop + 3))
        sx = slice(max(0, sx.start - 3), min(W, sx.stop + 3))
        part = paths[sy, sx] == k
        rim = ndi.binary_dilation(part, iterations=3) & ~part
        cc = cls[sy, sx]
        if rim.any() and np.isin(cc[rim], [C['park'], C['sport']]).mean() > 0.55:
            cc[part] = C['park']
    del paths

    # water depth from blue shade (lighter = shallower)
    depth = np.zeros((H, W), np.float32)
    gw = g[water].astype(np.float32)
    xs = np.array([76, 100, 105, 115, 125, 135, 145, 155, 165, 176, 200], np.float32)
    ys = np.array([40, 30, 20, 13, 9, 6, 4, 2.5, 1.5, 0.8, 0.5], np.float32)
    depth[water] = np.interp(gw, xs, ys)

    # Current YANIS city streets are white too. Connected road carriageways are much larger
    # than individual label glyphs / route badges, so preserve them before label inpainting.
    white0 = cls == C['white']
    wl, wn = ndi.label(white0, structure=np.ones((3, 3)))
    white_road = np.zeros_like(white0)
    if wn:
        wi = np.arange(1, wn + 1)
        ws = ndi.sum(white0, wl, wi)
        keep = ws >= 1000
        for i, sl in enumerate(ndi.find_objects(wl)):
            if sl is None or keep[i]:
                continue
            h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
            keep[i] = max(h, w) >= 100 and ws[i] >= 250
        white_road = keep[np.maximum(wl - 1, 0)] & (wl > 0)
    cls[white_road] = C['road']
    road_restore = np.zeros(cls.shape, np.uint8)
    road_restore[white_road] = C['road']
    road_restore[pale_highway] = C['highway']

    # labels: white glyphs + their dark outlines -> unknown, then inpaint
    white = (cls == C['white']) & ~white_road
    whiteBig = ndi.binary_opening(white, iterations=1)  # keep only solid white (text fill, shields)
    labelzone = ndi.binary_dilation(white, iterations=3)
    cls[labelzone & ((cls == C['white']) | (cls == C['dark']) | (cls == 0))] = 0
    # labels printed over nature (region / park names): the anti-aliased glyph fringe reads as urban / paved /
    # road greys and would seed the inpaint with fake town texels. Reset every grey class in those label zones.
    nature_zone = np.zeros_like(labelzone)
    natural_cls = np.isin(cls, [C['land'], C['park'], C['wetland'], C['farm'], C['beach'], C['dirtfield'], C['water']])
    dil8 = ndi.binary_dilation(labelzone, iterations=8)
    zl, nz = ndi.label(dil8)
    if nz:
        ring = dil8 & ~ndi.binary_dilation(labelzone, iterations=4)
        zi = np.arange(1, nz + 1)
        ring_n = ndi.sum(ring, zl, zi)
        ring_nat = ndi.sum(ring & natural_cls, zl, zi)
        nat_zone = (ring_nat / np.maximum(ring_n, 1)) > 0.6
        zone_mask = nat_zone[np.maximum(zl - 1, 0)] & (zl > 0) & ndi.binary_dilation(labelzone, iterations=2)
        greys = np.isin(cls, [C['urban'], C['paved'], C['apron'], C['building'], C['road'], C['highway'], C['white'], C['dark']])
        cls[zone_mask & greys] = 0
        nature_zone = zone_mask
        print('nature label zones: %d of %d, %d px reset' % (int(nat_zone.sum()), nz, int((zone_mask & greys).sum())))
    cls[waterish] = 0
    # route shields / road icons printed on the roads (blue county + interstate shields, brown historic, red tops):
    # their colours read as water / blue roofs and cut the road. Everything under them but road paint is unknown.
    cls[shield & ~np.isin(cls, [C['road'], C['highway']])] = 0
    # alleys: the ground under them is inpainted from the surroundings (urban / paved), the line itself goes to
    # alley.npy for the road graph
    cls[alley] = 0
    print('alley px %d, shield zone px %d' % (int(alley.sum()), int(shield.sum())))
    # thin white lines inside highways (lane markings) -> highway handled by inpaint too
    print('unknown before inpaint %.2f%%' % (100 * (cls == 0).mean()))

    # 3x3 majority cleanup of 1px grid lines / AA fringes: treat isolated pixels as unknown
    known = cls > 0
    idx = ndi.distance_transform_edt(~known, return_distances=False, return_indices=True)
    cls = cls[idx[0], idx[1]]
    elev = elev[idx[0], idx[1]]
    dmask = cls == C['water']
    depth = np.where(dmask, depth[idx[0], idx[1]], 0)
    del idx

    # remove 1-px slivers of thin classes caused by grid lines: open each small class
    for name in ['paved', 'apron', 'building']:
        m = cls == C[name]
        thin = m & ~ndi.binary_opening(m, structure=np.ones((3, 3)))
        cls[thin] = 0
    known = cls > 0
    idx = ndi.distance_transform_edt(~known, return_distances=False, return_indices=True)
    cls = cls[idx[0], idx[1]]
    elev = elev[idx[0], idx[1]]
    del idx
    cls = bridge_labels(cls, [(shield, 31)])
    restore = road_restore > 0
    cls[restore] = road_restore[restore]

    np.save(os.path.join(OUT, 'cls.npy'), cls)
    np.save(os.path.join(OUT, 'elev.npy'), elev)
    np.save(os.path.join(OUT, 'depth.npy'), depth.astype(np.float16))
    np.save(os.path.join(OUT, 'alley.npy'), alley)
    json.dump({'W': W, 'H': H, 'mpp': 2.0,
               'x0': float(os.environ.get('LEONIDA_X0', -11368.0)),
               'z0': float(os.environ.get('LEONIDA_Z0', -11000.0)), 'classes': CLASSES,
               'elevBands': [m for _, m in ELEV_BANDS], 'tx0': meta.get('tx0', 24), 'ty0': meta.get('ty0', 21)},
              open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)
    counts = np.bincount(cls.ravel(), minlength=20)
    inv = {v: k for k, v in CLASSES.items()}
    for i, c in enumerate(counts):
        if c:
            print('%-14s %6.2f%%' % (inv[i], 100 * c / cls.size))

    # preview
    pal = np.zeros((32, 3), np.uint8)
    cols = {'water': (30, 90, 160), 'land': (180, 210, 120), 'park': (90, 170, 80), 'wetland': (110, 190, 150),
            'beach': (245, 230, 140), 'industrial': (230, 200, 120), 'dirtfield': (210, 180, 120), 'urban': (210, 210, 210),
            'paved': (160, 160, 170), 'apron': (140, 140, 150), 'building': (255, 120, 60), 'building_blue': (255, 60, 160),
            'road': (20, 20, 20), 'highway': (80, 0, 160), 'dirtroad': (140, 90, 40), 'farm': (60, 140, 40),
            'sport': (40, 200, 40), 'white': (255, 255, 0), 'dark': (255, 0, 0), 'unknown': (255, 0, 255)}
    for k, v in cols.items():
        pal[CLASSES[k]] = v
    prev = pal[cls[::4, ::4]]
    Image.fromarray(prev).save(os.path.join(OUT, 'preview_cls.png'))


if __name__ == '__main__':
    main()
