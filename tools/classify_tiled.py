"""Memory-bounded YANIS classifier with overlapped chunks.

The historical classifier performs global morphology and nearest-class inpainting. On the
full 103 Mpx mosaic that exceeds small CI/sandbox memory limits. This driver keeps the same
classification code, overlaps every chunk by 96 px, and retains only each chunk's interior.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default=str(ROOT / 'raw/mosaic_nc_z5.png'))
    ap.add_argument('--crop', nargs=4, type=int, required=True, metavar=('X0', 'Y0', 'X1', 'Y1'))
    ap.add_argument('--chunk', type=int, default=2048)
    ap.add_argument('--overlap', type=int, default=96)
    ap.add_argument('--work', default='/tmp/leonida-classify')
    ap.add_argument('--origin', nargs=2, type=float, default=[-11368.0, -11000.0], metavar=('X0', 'Z0'))
    ap.add_argument('--write-mosaic', action='store_true', help='Also replace the canonical mosaic with the cropped input')
    args = ap.parse_args()
    x0, y0, x1, y1 = args.crop
    source = Image.open(args.source).convert('RGB')
    x1, y1 = min(x1, source.width), min(y1, source.height)
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    width, height = x1 - x0, y1 - y0
    cls = np.zeros((height, width), np.uint8)
    alley = np.zeros((height, width), bool)
    origin_x = args.origin[0] + 2 * x0
    origin_z = args.origin[1] + 2 * y0
    raw = ROOT / 'raw'
    chunk_image = work / 'mosaic.png'
    for cy, y in enumerate(range(y0, y1, args.chunk)):
        for cx, x in enumerate(range(x0, x1, args.chunk)):
            xa, xb = max(0, x - args.overlap), min(source.width, min(x1, x + args.chunk) + args.overlap)
            ya, yb = max(0, y - args.overlap), min(source.height, min(y1, y + args.chunk) + args.overlap)
            source.crop((xa, ya, xb, yb)).save(chunk_image, compress_level=1)
            (work / 'mosaic.json').write_text(json.dumps({'tx0': 24, 'ty0': 21}))
            # classify.py takes its paths from raw/; use a per-chunk raw directory without
            # modifying the canonical mosaic until the final cropped mosaic is written.
            chunk_raw = work / 'raw'
            chunk_raw.mkdir(exist_ok=True)
            chunk_image.replace(chunk_raw / 'mosaic_nc_z5.png')
            (chunk_raw / 'mosaic_z5.json').write_text(json.dumps({'tx0': 24, 'ty0': 21}))
            env = dict(os.environ,
                       LEONIDA_RAW=str(chunk_raw),
                       LEONIDA_CLS=str(work / 'cls-chunk'),
                       LEONIDA_X0=str(origin_x + 2 * (xa - x0)),
                       LEONIDA_Z0=str(origin_z + 2 * (ya - y0)),
                       LEONIDA_PIXEL_X0=str(xa), LEONIDA_PIXEL_Y0=str(ya),
                       LEONIDA_CLASSIFY_NO_LEGEND='1')
            print(f'chunk {cy},{cx}: {(xa, ya, xb, yb)}', flush=True)
            subprocess.run([sys.executable, str(ROOT / 'tools/classify.py')], cwd=ROOT, env=env,
                           check=True, stdout=(work / 'last.log').open('w'))
            cc = np.load(work / 'cls-chunk/cls.npy')
            aa = np.load(work / 'cls-chunk/alley.npy')
            keep_x0, keep_y0 = x - xa, y - ya
            keep_x1 = keep_x0 + min(args.chunk, x1 - x)
            keep_y1 = keep_y0 + min(args.chunk, y1 - y)
            cls[y - y0:y - y0 + keep_y1 - keep_y0, x - x0:x - x0 + keep_x1 - keep_x0] = cc[keep_y0:keep_y1, keep_x0:keep_x1]
            alley[y - y0:y - y0 + keep_y1 - keep_y0, x - x0:x - x0 + keep_x1 - keep_x0] = aa[keep_y0:keep_y1, keep_x0:keep_x1]
            del cc, aa
    out = raw / 'cls'
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / 'cls.npy', cls)
    np.save(out / 'alley.npy', alley)
    meta = {'W': width, 'H': height, 'mpp': 2, 'x0': origin_x, 'z0': origin_z,
            'crop': args.crop, 'chunk': args.chunk, 'overlap': args.overlap, 'tx0': 24, 'ty0': 21}
    (out / 'meta.json').write_text(json.dumps(meta, indent=2))
    if args.write_mosaic:
        source.crop(args.crop).save(raw / 'mosaic_nc_z5.png', compress_level=2)
        (raw / 'mosaic_z5.json').write_text(json.dumps(meta, indent=2))
    print('wrote', cls.shape, 'to', out, flush=True)


if __name__ == '__main__':
    main()
