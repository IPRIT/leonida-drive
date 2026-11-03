"""Source-located bridge elevations that cannot be recovered from flat map colours.

The Watson Island bay crossing is elevated above the beach in the supplied
Bayfront reference. Its approaches are fitted by the same bounded network solve.
"""
import numpy as np

WATSON_BRIDGE = np.array([[-235, -570], [-100, -540], [20, -525], [97, -525]], dtype=float)


def watson_distance(points):
    distance = np.full(len(points), np.inf)
    for a, b in zip(WATSON_BRIDGE[:-1], WATSON_BRIDGE[1:]):
        delta = b - a
        t = np.clip(((points - a) @ delta) / (delta @ delta), 0, 1)
        distance = np.minimum(distance, np.linalg.norm(points - a - t[:, None] * delta, axis=1))
    return distance


def structure_floor(edges, count):
    floor = np.full(count, 0.45)
    for e in edges:
        if e['src']['k'] != 'highway':
            continue
        core = watson_distance(e['P']) < 36
        floor[e['vi'][core]] = 13.6
    return floor
