"""Download OpenStreetMap building data around the real-world prototypes of the fan-map POIs (Overpass API).

Data (c) OpenStreetMap contributors, ODbL 1.0. Only building outlines + building:part massing tags are fetched.

Stage 1  buildings (ways/relations with building=*) near each prototype point (batched `around:` unions)
Stage 1b wider neighbourhood where the game footprint is much bigger than that OSM building (complexes)
Stage 2  building:part ways/relations inside the bbox of the OSM building chosen for each marker

Raw responses are cached in tools/cache/osm/<stage>_<sha1>.json, so re-runs never re-download.
Etiquette: descriptive User-Agent, >= 3 s between requests, timeout, exponential backoff on 429/502/503/504,
mirror rotation when the main instance is at capacity.

Usage: .venv/bin/python tools/irl_fetch.py [--stage 1|2|all] [--dry]
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math  # noqa: E402
from irl_geo import ROOT, load_markers, match_markers, pick_osm_building, load_stage1, game_buildings, area, osm_area, reset_stage1  # noqa: E402

CACHE = os.path.join(ROOT, 'tools', 'cache', 'osm')
UA = 'LeonidaDrive-fan-game/1.0 (local build tool)'
MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
GAP = 3.2            # seconds between requests (etiquette: >= 3 s)
BATCH1 = 70          # prototype points per stage-1 query
BATCH2 = 90          # building bboxes per stage-2 query
MAX_TOTAL_MB = 25.0  # hard stop: the approved budget is ~5-20 MB

_last = [0.0]
_stats = {'requests': 0, 'bytes': 0, 'cached': 0, 'retries': 0}


def cache_size_mb():
    if not os.path.isdir(CACHE):
        return 0.0
    return sum(os.path.getsize(os.path.join(CACHE, f)) for f in os.listdir(CACHE) if f.endswith('.json')) / 1e6


def overpass(query, stage, dry=False):
    key = hashlib.sha1(query.encode()).hexdigest()[:16]
    path = os.path.join(CACHE, f'{stage}_{key}.json')
    if os.path.exists(path):
        _stats['cached'] += 1
        with open(path) as f:
            return json.load(f)
    if dry:
        print('  would fetch', path, len(query), 'chars')
        return None
    if cache_size_mb() > MAX_TOTAL_MB:
        raise SystemExit(f'download budget exceeded ({cache_size_mb():.1f} MB > {MAX_TOTAL_MB} MB) - stopping')
    delay, attempt, mi = 15.0, 0, 0
    while True:
        wait = GAP - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        url = MIRRORS[mi % len(MIRRORS)]
        req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': query}).encode(),
                                     headers={'User-Agent': UA, 'Accept': 'application/json'})
        _last[0] = time.time()
        _stats['requests'] += 1
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                body = r.read()
            data = json.loads(body)
            if data.get('remark') and 'error' in data['remark'].lower():
                raise RuntimeError(data['remark'])
            os.makedirs(CACHE, exist_ok=True)
            with open(path + '.tmp', 'wb') as f:
                f.write(body)
            os.replace(path + '.tmp', path)
            _stats['bytes'] += len(body)
            print(f'  ok {url.split("/")[2]} {len(body) / 1e3:.0f} kB, {len(data.get("elements", []))} elements')
            return data
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError, ConnectionError) as e:
            code = getattr(e, 'code', None)
            attempt += 1
            _stats['retries'] += 1
            if attempt > 9:
                raise
            mi += 1  # next mirror
            print(f'  {url.split("/")[2]} failed ({code or type(e).__name__}: {str(e)[:80]}), retry {attempt} in {delay:.0f}s')
            time.sleep(delay)
            delay = min(delay * 2, 240)


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def stage1_points(markers, matches):
    """unique prototype points (lat, lng) for markers matched to an in-game footprint, spatially sorted"""
    pts = {}
    for k, m in matches.items():
        lat, lng = markers[k]['ll']
        pts.setdefault((round(lat, 6), round(lng, 6)), []).append(k)
    keys = sorted(pts, key=lambda p: (round(p[0] / 0.02), p[1] if round(p[0] / 0.02) % 2 == 0 else -p[1]))
    return keys


def q_stage1(points):
    st = []
    for lat, lng in points:
        st.append(f'way[building](around:35,{lat},{lng});')
        st.append(f'way[building](around:90,{lat},{lng})(if:length()>300);')
        st.append(f'relation[building](around:60,{lat},{lng});')
    return '[out:json][timeout:180];(' + ''.join(st) + ');out tags geom qt;'


def q_stage2(bboxes):
    st = []
    for s, w, n, e in bboxes:
        b = f'{s:.6f},{w:.6f},{n:.6f},{e:.6f}'
        st.append(f'way["building:part"]({b});')
        st.append(f'relation["building:part"]({b});')
    return '[out:json][timeout:180];(' + ''.join(st) + ');out tags geom qt;'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='all')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    markers = load_markers()
    matches = match_markers(markers)
    pts = stage1_points(markers, matches)
    print(f'{len(matches)} markers matched to footprints, {len(pts)} unique prototype points')
    if a.stage in ('1', 'all'):
        batches = list(chunks(pts, BATCH1))
        for i, b in enumerate(batches):
            print(f'stage 1 batch {i + 1}/{len(batches)} ({len(b)} points)')
            overpass(q_stage1(b), 's1', a.dry)
    if a.stage in ('1b', 'all'):
        # game footprint much bigger than the OSM building at the prototype point: probably a complex
        # (towers + podium as separate OSM buildings) -> fetch the wider neighbourhood for the cluster fit
        osm = load_stage1()
        B, _ = game_buildings()
        wide = {}
        for k, m in matches.items():
            ob = pick_osm_building(markers[k]['ll'], osm)
            if ob is None:
                continue
            a_g = abs(area(B[m['b']]['poly']))
            a_o = osm_area(ob)
            if a_g / max(a_o, 1) > 2.0:
                r = min(150, max(40, 0.8 * math.sqrt(a_g)))
                ll = (round(markers[k]['ll'][0], 6), round(markers[k]['ll'][1], 6))
                wide[ll] = max(wide.get(ll, 0), round(r))
        pts1b = sorted(wide)
        print(f'stage 1b: {len(pts1b)} complexes')
        for i, b in enumerate(chunks(pts1b, BATCH1)):
            st = ''.join(f'way[building](around:{wide[p]},{p[0]},{p[1]});relation[building](around:{wide[p]},{p[0]},{p[1]});' for p in b)
            overpass('[out:json][timeout:180];(' + st + ');out tags geom qt;', 's1', a.dry)
    if a.stage in ('2', 'all'):
        from irl_build import choose  # noqa: E402
        reset_stage1()
        bbs = {}
        for sel in choose(markers, matches).values():
            for ob in sel['members']:
                bbs[ob['id']] = ob['bbox']
        ids = sorted(bbs)
        print(f'stage 2: {len(ids)} chosen OSM buildings')
        # spatial order so the bbox union of a batch stays compact
        ids.sort(key=lambda i: (round(bbs[i][0] / 0.02), bbs[i][1]))
        batches = list(chunks(ids, BATCH2))
        for i, b in enumerate(batches):
            print(f'stage 2 batch {i + 1}/{len(batches)} ({len(b)} buildings)')
            pad = 0.00003
            overpass(q_stage2([(bbs[j][0] - pad, bbs[j][1] - pad, bbs[j][2] + pad, bbs[j][3] + pad) for j in b]), 's2', a.dry)
    print('stats', _stats, f'cache {cache_size_mb():.2f} MB')


if __name__ == '__main__':
    main()
