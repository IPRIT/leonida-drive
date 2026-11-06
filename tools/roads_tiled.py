"""Memory-bounded GTADB road vectorization with deterministic seam stitching."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def clip_segment(a, b, rect):
    """Liang-Barsky clip; returns the two parameter values inside rect."""
    x0, y0, x1, y1 = rect
    dx, dz = b[0] - a[0], b[1] - a[1]
    lo, hi = 0.0, 1.0
    for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dz, a[1] - y0), (dz, y1 - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            lo = max(lo, t)
        else:
            hi = min(hi, t)
        if lo > hi:
            return None
    return lo, hi


def clip_edge(edge, rect):
    p = np.asarray(edge['p'], dtype=np.float64).reshape(-1, 2)
    br = np.asarray(edge.get('br', [0] * len(p)))
    parts, current, current_br = [], [], []
    for i in range(len(p) - 1):
        clipped = clip_segment(p[i], p[i + 1], rect)
        if clipped is None:
            if len(current) >= 2:
                parts.append((current, current_br))
            current, current_br = [], []
            continue
        lo, hi = clipped
        a = p[i] + (p[i + 1] - p[i]) * lo
        b = p[i] + (p[i + 1] - p[i]) * hi
        points = [a]
        flags = [br[i]]
        for j in range(i + 1, len(p) - 1):
            t = j - i
            if lo < t < hi:
                points.append(p[j])
                flags.append(br[j])
        points.append(b)
        flags.append(br[i + 1])
        if current and np.linalg.norm(current[-1] - points[0]) < 0.01:
            current.extend(points[1:])
            current_br.extend(flags[1:])
        else:
            if len(current) >= 2:
                parts.append((current, current_br))
            current, current_br = points, flags
        if hi < 1.0 - 1e-9:
            if len(current) >= 2:
                parts.append((current, current_br))
            current, current_br = [], []
    if len(current) >= 2:
        parts.append((current, current_br))
    out = []
    for points, flags in parts:
        if len(points) < 2 or np.linalg.norm(points[-1] - points[0]) < 0.5:
            continue
        q = {k: v for k, v in edge.items() if k not in ('a', 'b', 'p', 'br')}
        q['p'] = np.round(points, 2).tolist()
        q['br'] = np.asarray(flags, dtype=np.int8).tolist()
        # Preserve the vectorizer's topological junction IDs. Its node is a cluster
        # centroid and need not equal the first skeleton pixel of each incident arm.
        if np.allclose(points[0], p[0]):
            q['_source_a'] = edge['a']
        if np.allclose(points[-1], p[-1]):
            q['_source_b'] = edge['b']
        out.append(q)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--origin', nargs=2, type=float, required=True, metavar=('X0', 'Z0'))
    ap.add_argument('--tile', type=int, default=5120)
    ap.add_argument('--overlap', type=int, default=192)
    ap.add_argument('--work', default='/tmp/leonida-road-vector')
    args = ap.parse_args()
    cls_dir = ROOT / 'raw/cls'
    cls = np.load(cls_dir / 'cls.npy', mmap_mode='r')
    alley = np.load(cls_dir / 'alley.npy', mmap_mode='r')
    H, W = cls.shape
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    clipped_edges = []
    tile_nodes = []
    road_mask = np.lib.format.open_memmap(cls_dir / 'road_mask.npy', mode='w+', dtype=bool, shape=(H, W))
    bridge_mask = np.lib.format.open_memmap(cls_dir / 'bridge_mask.npy', mode='w+', dtype=bool, shape=(H, W))
    tile_id = 0
    for cy in range(0, H, args.tile):
        for cx in range(0, W, args.tile):
            x1, y1 = min(W, cx + args.tile), min(H, cy + args.tile)
            xa, ya = max(0, cx - args.overlap), max(0, cy - args.overlap)
            xb, yb = min(W, x1 + args.overlap), min(H, y1 + args.overlap)
            tile = work / 'current'
            tile.mkdir(exist_ok=True)
            np.save(tile / 'cls.npy', cls[ya:yb, xa:xb])
            np.save(tile / 'alley.npy', alley[ya:yb, xa:xb])
            env = dict(os.environ, LEONIDA_CLS=str(tile),
                       LEONIDA_X0=str(args.origin[0] + 2 * xa), LEONIDA_Z0=str(args.origin[1] + 2 * ya),
                       LEONIDA_ROAD_CLIP=f'0,0,{max(0, 9000 - xa)},{max(0, 11800 - ya)}')
            print(f'vector tile {tile_id} core={(cx, cy, x1, y1)} source={(xa, ya, xb, yb)}', flush=True)
            subprocess.run([sys.executable, str(ROOT / 'tools/roads.py')], cwd=ROOT, env=env, check=True)
            roads = json.loads((tile / 'roads.json').read_text())
            rect = (args.origin[0] + 2 * cx, args.origin[1] + 2 * cy,
                    args.origin[0] + 2 * x1, args.origin[1] + 2 * y1)
            for edge in roads['edges']:
                for part in clip_edge(edge, rect):
                    part['_tile'] = tile_id
                    clipped_edges.append(part)
            # Keep original per-tile node objects until the final node pass.
            tile_nodes.append(roads['nodes'])
            road_mask[cy:y1, cx:x1] = np.load(tile / 'road_mask.npy')[cy - ya:y1 - ya, cx - xa:x1 - xa]
            bridge_mask[cy:y1, cx:x1] = np.load(tile / 'bridge_mask.npy')[cy - ya:y1 - ya, cx - xa:x1 - xa]
            tile_id += 1
    road_mask.flush()
    bridge_mask.flush()

    nodes, edges = [], []
    # Exact core clipping produces matching seam coordinates. A 5 cm key removes only
    # floating-point / JSON rounding differences, not distinct carriageways.
    node_ids = {}

    def node(p):
        key = (round(p[0] * 20), round(p[1] * 20))
        i = node_ids.get(key)
        if i is None:
            i = len(nodes)
            node_ids[key] = i
            nodes.append([round(float(p[0]), 2), round(float(p[1]), 2)])
        return i

    source_node_maps = {}

    def source_node(tile, index):
        key = (tile, index)
        if key not in source_node_maps:
            source_node_maps[key] = node(tile_nodes[tile][index])
        return source_node_maps[key]

    for edge in clipped_edges:
        p = edge['p']
        tile = edge.pop('_tile')
        sa, sb = edge.pop('_source_a', None), edge.pop('_source_b', None)
        a = source_node(tile, sa) if sa is not None else node(p[0])
        b = source_node(tile, sb) if sb is not None else node(p[-1])
        edge['a'], edge['b'] = a, b
        edges.append(edge)
    out = {'nodes': nodes, 'edges': edges}
    (cls_dir / 'roads.json').write_text(json.dumps(out, separators=(',', ':')))
    print(json.dumps({'tiles': tile_id, 'nodes': len(nodes), 'edges': len(edges),
                      'length_km': round(sum(np.linalg.norm(np.diff(np.asarray(e['p']), axis=0), axis=1).sum() for e in edges) / 1000, 1)}, indent=2), flush=True)


if __name__ == '__main__':
    main()
