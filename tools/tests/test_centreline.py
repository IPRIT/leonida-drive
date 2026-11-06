import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from centreline import constrained_taubin, drift_report, _project_to_polyline


class CentrelineTest(unittest.TestCase):
    def test_straight_line_and_endpoints_are_unchanged(self):
        p = np.array([[0, 0], [3, 0], [11, 0], [20, 0]], dtype=float)
        q = constrained_taubin(p)
        np.testing.assert_allclose(q, p, atol=1e-10)

    def test_drift_is_measured_to_source_polyline(self):
        x = np.linspace(0, 100, 41)
        p = np.column_stack([x, 18 * np.sin(x / 18) + (np.arange(len(x)) % 2) * 0.8])
        q = constrained_taubin(p, widths=np.full(len(p), 44.0), max_drift=0.75)
        report = drift_report(p, q)
        self.assertLessEqual(report['max_m'], 1.0001)
        self.assertGreater(report['mean_m'], 0.001)
        np.testing.assert_allclose(q[[0, -1]], p[[0, -1]])

    def test_structural_anchors_do_not_move(self):
        p = np.array([[0, 0], [5, 1], [10, -1], [15, 2], [20, 0]], dtype=float)
        anchors = np.array([False, False, True, False, False])
        q = constrained_taubin(p, anchors=anchors)
        np.testing.assert_allclose(q[2], p[2], atol=1e-12)

    def test_short_segments_and_duplicate_samples_are_safe(self):
        p = np.array([[0, 0], [0, 0], [0.01, 0.01], [0.02, 0], [1, 0]], dtype=float)
        q = constrained_taubin(p, iterations=48)
        self.assertTrue(np.isfinite(q).all())
        _, distance = _project_to_polyline(q, p)
        self.assertLessEqual(distance.max(), 0.750001)

    def test_two_points_return_a_copy(self):
        p = np.array([[1, 2], [3, 4]], dtype=float)
        q = constrained_taubin(p)
        np.testing.assert_array_equal(q, p)
        self.assertIsNot(q, p)


if __name__ == '__main__':
    unittest.main()
