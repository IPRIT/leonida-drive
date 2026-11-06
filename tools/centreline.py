"""Source-constrained centreline smoothing for roads and ramps.

Taubin λ/μ filtering removes raster stair-steps without the shrinkage of a
Gaussian filter. Unlike an unconstrained low-pass filter, this implementation:

* weights neighbours by arc length, so unevenly sampled ramps are not dragged
  towards dense samples;
* pins graph junctions and optional structural anchors exactly;
* bounds every output point by distance to the *source polyline*, not merely to
  its original sample (important on a bend between sparse samples);
* never smooths across a source vertex by more than `max_drift` metres.

The default 0.75 m budget is below half a source texel (the YANIS mosaic is
2 m/px) and deliberately much tighter than the old width-dependent 5 m drift.
It is an offline vector operation; no runtime WASM or per-frame spline work is
needed. Rendering can subsequently use adaptive chord-error tessellation.
"""
import numpy as np


def _project_to_polyline(points, reference):
    """Return nearest points and distances on a reference open polyline."""
    if len(reference) < 2:
        return reference[:1].repeat(len(points), axis=0), np.linalg.norm(points - reference[0], axis=1)
    best_d2 = np.full(len(points), np.inf)
    best = np.empty_like(points)
    for a, b in zip(reference[:-1], reference[1:]):
        delta = b - a
        den = float(delta @ delta)
        if den < 1e-12:
            continue
        t = np.clip(((points - a) @ delta) / den, 0.0, 1.0)
        q = a + t[:, None] * delta
        d2 = np.sum((points - q) ** 2, axis=1)
        take = d2 < best_d2
        best[take] = q[take]
        best_d2[take] = d2[take]
    return best, np.sqrt(best_d2)


def constrained_taubin(points, widths=None, iterations=24, max_drift=0.75, anchors=None):
    """Smooth an open centreline while keeping it faithful to the source.

    Args:
        points: (N,2) array in world metres.
        widths: optional per-point carriageway widths. Wide carriageways get a
            little more room, but the absolute cap remains 1.0 m.
        iterations: λ/μ passes; two relaxation steps per pass.
        max_drift: base distance budget to the original polyline in metres.
        anchors: optional bool mask of points that must not move (bridge
            transitions, explicitly surveyed vertices). Endpoints are always
            anchors.
    """
    source = np.asarray(points, dtype=np.float64)
    if len(source) < 3 or iterations <= 0:
        return source.copy()
    q = source.copy()
    pinned = np.zeros(len(q), dtype=bool) if anchors is None else np.asarray(anchors, dtype=bool).copy()
    pinned[0] = pinned[-1] = True
    widths = np.full(len(q), 8.0) if widths is None else np.asarray(widths, dtype=np.float64)
    # Absolute cap prevents a 44 m junction blob from licensing a 13 m shift.
    budgets = np.minimum(1.0, max_drift + np.clip(widths - 12.0, 0.0, 20.0) * 0.005)

    for _ in range(iterations):
        for factor in (0.5, -0.53):
            left = q[:-2] - q[1:-1]
            right = q[2:] - q[1:-1]
            dl = np.maximum(np.linalg.norm(left, axis=1), 0.05)
            dr = np.maximum(np.linalg.norm(right, axis=1), 0.05)
            wl, wr = 1.0 / dl, 1.0 / dr
            lap = (left * wl[:, None] + right * wr[:, None]) / (wl + wr)[:, None]
            q[1:-1] += factor * lap
            q[pinned] = source[pinned]

    nearest, distance = _project_to_polyline(q, source)
    over = distance > budgets
    if np.any(over):
        q[over] = nearest[over] + (q[over] - nearest[over]) * (budgets[over] / distance[over])[:, None]
    q[pinned] = source[pinned]
    return q


def drift_report(points, smoothed):
    """Small JSON-serialisable QA report measured against the source polyline."""
    source = np.asarray(points, dtype=np.float64)
    _, distance = _project_to_polyline(np.asarray(smoothed, dtype=np.float64), source)
    return {
        'max_m': round(float(distance.max(initial=0.0)), 4),
        'p95_m': round(float(np.percentile(distance, 95)) if len(distance) else 0.0, 4),
        'mean_m': round(float(distance.mean()) if len(distance) else 0.0, 4),
    }
