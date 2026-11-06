"""Register raw GTADB classifier roads into Leonida world coordinates.

The source mosaic is transposed relative to the game map.  This applies the measured
source-to-source affine followed by the independently accepted map-to-GTADB ECC affine.
It also stores the inverse mapping so export repair samples classifier pixels correctly.
"""
import argparse
import copy
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', default=str(ROOT / 'raw/cls/roads.json'))
    ap.add_argument('--output')
    ap.add_argument('--x0', type=float, default=-9368.0)
    ap.add_argument('--z0', type=float, default=-9400.0)
    ap.add_argument('--full-canvas', action='store_true')
    ap.add_argument('--direct-mpp', type=float, help='Identity vectorizer coordinates with explicit metres/source-pixel')
    args = ap.parse_args()
    roads = json.loads(Path(args.input).read_text())
    if args.direct_mpp:
        if roads.get('registration'):
            raise SystemExit('Input is already registered; use the unregistered vectorizer output')
        m = args.direct_mpp
        F = [[m, 0, args.x0], [0, m, args.z0]]
        inv = [[1 / m, 0, -args.x0 / m], [0, 1 / m, -args.z0 / m]]
        result = copy.deepcopy(roads)
        result['registration'] = {'source': 'GTADB YANIS v17, direct 256px tile assembly',
                                  'world_to_classifier_pixel': inv, 'classifier_pixel_to_world': F,
                                  'width_scale': 1.0}
        output = Path(args.output or args.input)
        output.write_text(json.dumps(result, separators=(',', ':')))
        print(json.dumps({'nodes': len(result['nodes']), 'edges': len(result['edges']),
                          'width_scale': 1.0, 'output': str(output)}, indent=2))
        return
    registration = json.loads((ROOT / 'tools/fixes/gtadb-yanis-v17-registration.json').read_text())
    if roads.get('registration'):
        raise SystemExit('Input is already registered; use the unregistered vectorizer output')
    T = np.asarray(registration['game_map_to_gtadb_transpose'], dtype=np.float64)
    inv_t = np.linalg.inv(np.vstack((T, [0, 0, 1])))
    if args.full_canvas:
        canvas = registration['full_canvas']
        args.x0, args.z0 = canvas['proxy_origin']
        matrix = canvas['classifier_pixel_to_gtadb_transpose']
    else:
        matrix = registration['classifier_pixel_to_gtadb_transpose']
    M = np.vstack((np.asarray(matrix), [0, 0, 1]))
    U = np.array([[0.5, 0, -args.x0 / 2], [0, 0.5, -args.z0 / 2], [0, 0, 1]])
    pixel_to_game = inv_t @ M @ U
    world_linear = 16 * pixel_to_game[:2, :2]
    world_offset = 16 * pixel_to_game[:2, 2] + registration['game_map_world_offset']
    F = np.column_stack((world_linear, world_offset))
    world_to_proxy = np.linalg.inv(np.vstack((F, [0, 0, 1])))
    world_to_pixel = (U @ world_to_proxy)[:2]
    classifier_pixel_to_world = (np.vstack((F, [0, 0, 1])) @ np.linalg.inv(U))[:2]

    def transform(points):
        a = np.asarray(points, dtype=np.float64).reshape(-1, 2)
        out = a @ world_linear.T + world_offset
        return np.round(out, 2).tolist()

    result = copy.deepcopy(roads)
    result['nodes'] = transform(roads['nodes'])
    singular = np.linalg.svd(world_linear, compute_uv=False)
    # Input and output coordinates are both metres. Preserve source widths under the
    # tiny anisotropy measured by the affine registration.
    width_scale = float(np.sqrt(np.prod(singular)))
    for edge in result['edges']:
        edge['p'] = transform(edge['p'])
        if 'w' in edge:
            edge['w'] = round(float(edge['w']) * width_scale, 2)
    result['registration'] = {
        'source': registration['source'],
        'world_to_classifier_pixel': world_to_pixel.tolist(),
        'classifier_pixel_to_world': F.tolist(),
        'width_scale': width_scale,
        'ecc': registration['ecc_game_map_to_gtadb_transpose'],
    }
    output = Path(args.output or args.input)
    output.write_text(json.dumps(result, separators=(',', ':')))
    print(json.dumps({'nodes': len(result['nodes']), 'edges': len(result['edges']),
                      'width_scale': width_scale, 'output': str(output)}, indent=2))


if __name__ == '__main__':
    main()
