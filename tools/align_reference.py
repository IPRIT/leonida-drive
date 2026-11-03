"""Align a secondary road-map image to the existing YANIS mosaic for visual QA.

This never replaces the source or edits world data. Output contains an affine
transform and paired crops; sparse / local matches are rejected.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parents[1]


def load(path, width=2400):
    im = Image.open(path).convert('RGB')
    size = im.size
    scale = min(1, width / size[0])
    im = im.resize((round(size[0] * scale), round(size[1] * scale)))
    rgb = np.asarray(im)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    return rgb, gray, scale, size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('--source', default=str(ROOT / 'raw/mosaic_nc_z5.png'))
    ap.add_argument('--out', default=str(ROOT / 'raw/reference-alignment'))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ref, rg, rs, rsize = load(args.reference)
    src, sg, ss, ssize = load(args.source)
    orb = cv2.ORB_create(nfeatures=18000, scaleFactor=1.15, nlevels=12, fastThreshold=10)
    kr, dr = orb.detectAndCompute(rg, None)
    ks, ds = orb.detectAndCompute(sg, None)
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(dr, ds, k=2)
    good = [a for a, b in pairs if a.distance < 0.73 * b.distance]
    if len(good) < 15:
        raise RuntimeError(f'Only {len(good)} reliable matches: use manual control points')
    a = np.float32([kr[m.queryIdx].pt for m in good]) / rs
    b = np.float32([ks[m.trainIdx].pt for m in good]) / ss
    matrix, mask = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=12, maxIters=10000, confidence=0.999)
    if matrix is None:
        raise RuntimeError('No reliable map transform')
    keep = mask.ravel().astype(bool)
    error = np.linalg.norm(a @ matrix[:, :2].T + matrix[:, 2] - b, axis=1)
    extent = np.ptp(b[keep], axis=0) / np.array(ssize)
    accepted = int(keep.sum()) >= 30 and float(error[keep].mean()) < 8 and min(extent) > 0.35
    report = dict(accepted=accepted, reference=Path(args.reference).name, reference_size=rsize, source_size=ssize,
                  transform_to_source_pixels=matrix.tolist(), matches=len(good), inliers=int(keep.sum()),
                  mean_error_pixels=float(error[keep].mean()), p90_error_pixels=float(np.percentile(error[keep], 90)),
                  source_extent_fraction=extent.tolist(), source_mpp=2, source_origin=[-11368, -11000])
    (out / 'alignment.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    # Paired overview makes false correspondences visible before trusting the fit.
    match = cv2.drawMatches(ref, kr, src, ks, [m for i, m in enumerate(good) if keep[i]][:80], None,
                            flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS)
    Image.fromarray(match).save(out / 'matches.jpg', quality=88)
    if not accepted:
        raise RuntimeError('Fit is not reliable across the whole map; keep this as a visual reference only')


if __name__ == '__main__':
    main()
