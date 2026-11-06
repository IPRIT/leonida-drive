"""Independent raster recall/precision audit for the exported road graph.

No classifier mask or LOD geometry participates. The reference is the GTADB raster,
and graph distance fields are rebuilt independently in small tiles to bound memory.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from skimage.morphology import skeletonize

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--roads', default=str(ROOT / 'public/data/roads.json'))
    ap.add_argument('--source', default=str(ROOT / 'raw/mosaic_nc_z5.png'))
    ap.add_argument('--output', default=str(ROOT / 'tools/fixes/gtadb-road-audit.json'))
    ap.add_argument('--tile', type=int, default=1024)
    ap.add_argument('--registration', default=str(ROOT / 'tools/fixes/gtadb-yanis-v17-registration.json'))
    args = ap.parse_args()
    registration = json.loads(Path(args.registration).read_text())
    roads = json.loads(Path(args.roads).read_text())
    source = np.asarray(Image.open(args.source).convert('RGB'))
    H, W = source.shape[:2]
    if 'world_to_classifier_pixel' in registration:
        world_to_source = np.vstack((np.asarray(registration['world_to_classifier_pixel']), [0, 0, 1]))
    else:
        T = np.vstack((np.asarray(registration['game_map_to_gtadb_transpose']), [0, 0, 1]))
        G = np.array([[1 / 16, 0, 9216 / 16], [0, 1 / 16, 9216 / 16], [0, 0, 1]])
        world_to_source = 2 * T @ G
    transformed = []
    for ei, edge in enumerate(roads['edges']):
        p = np.asarray(edge['p'], dtype=np.float64).reshape(-1, 2)
        p3 = np.column_stack((p, np.ones(len(p))))
        q = p3 @ world_to_source[:2].T
        transformed.append((ei, q))

    precision_distances = []
    recall_distances = []
    district_names = ['Ocean Beach', 'Port Gellhorn', 'Stockyard', 'Mt. Kalaga', 'Downtown', 'Key Lento']
    district_world = [[1728, -733], [-6785, -3817], [-352, -1792], [-3160, -7090], [-560, 40], [-2182, 5572]]
    district_source = [(np.array([x, z, 1.0]) @ world_to_source[:2].T).tolist() for x, z in district_world]
    district_precision = [[] for _ in district_world]
    district_recall = [[] for _ in district_world]

    for y0 in range(0, H, args.tile):
        for x0 in range(0, W, args.tile):
            x1, y1 = min(W, x0 + args.tile), min(H, y0 + args.tile)
            rgb = source[y0:y1, x0:x1].astype(np.int16)
            r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
            spread = np.maximum(np.maximum(abs(r - g), abs(g - b)), abs(r - b))
            lum = (r + g + b) // 3
            evidence = ((spread <= 18) & (lum >= 218)) | ((spread <= 18) & (lum >= 62) & (lum <= 140))
            evidence |= (r > 235) & (g > 225) & (b >= 150) & (b < 230)
            evidence |= (r > 125) & (r - g > 25) & (r - b > 20) & (g < 160)
            n, labels, stats, _ = cv2.connectedComponentsWithStats(evidence.astype(np.uint8), 8)
            if n > 1:
                keep = stats[:, cv2.CC_STAT_AREA] >= 80
                keep[0] = False
                evidence = keep[labels]
            graph = np.zeros(evidence.shape, np.uint8)
            margin = 40
            for ei, q in transformed:
                if q[:, 0].max() < x0 - margin or q[:, 0].min() > x1 + margin or q[:, 1].max() < y0 - margin or q[:, 1].min() > y1 + margin:
                    continue
                local = np.round(q - [x0, y0]).astype(np.int32)
                cv2.polylines(graph, [local], False, 1, 1, cv2.LINE_8)
            if not evidence.any() and not graph.any():
                continue
            ds = cv2.distanceTransform((~evidence).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
            dg = cv2.distanceTransform((1 - graph).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
            gp = ds[graph > 0]
            if len(gp):
                precision_distances.append(gp)
                yy, xx = np.nonzero(graph)
                for di, (cx, cy) in enumerate(district_source):
                    nearby = (xx + x0 - cx) ** 2 + (yy + y0 - cy) ** 2 <= 300 ** 2
                    if nearby.any():
                        district_precision[di].append(gp[nearby])
            centre = skeletonize(evidence)
            rp = dg[centre]
            if len(rp):
                recall_distances.append(rp)
                yy, xx = np.nonzero(centre)
                for di, (cx, cy) in enumerate(district_source):
                    nearby = (xx + x0 - cx) ** 2 + (yy + y0 - cy) ** 2 <= 300 ** 2
                    if nearby.any():
                        district_recall[di].append(rp[nearby])

    def stats(parts):
        if not parts:
            return {'samples': 0}
        a = np.concatenate(parts)
        return {'samples': int(len(a)), 'percentiles_px': np.percentile(a, [50, 75, 90, 95, 99]).round(3).tolist(),
                'within': {str(v): round(float((a <= v).mean()), 5) for v in (2, 4, 8, 16)}}

    result = {'source': registration['source'], 'graph_edges': len(roads['edges']),
              'method': 'Independent RGB evidence, connected-component area >=80, source skeleton recall; 1024px tiles; no classifier/LOD input',
              'precision_graph_to_source': stats(precision_distances), 'recall_source_to_graph': stats(recall_distances),
              'districts': {name: {'precision': stats(district_precision[i]), 'recall': stats(district_recall[i])}
                            for i, name in enumerate(district_names)}}
    Path(args.output).write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
