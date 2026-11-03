"""Run with .venv/bin/python -m unittest discover -s tools/tests -p 'test_*.py'."""
import sys
import unittest
from pathlib import Path

import numpy as np
from scipy import sparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from interchanges import LevelBounds
from road_profiles import BoundedProfiles


class RoadProfilesTest(unittest.TestCase):
    def test_strong_terrain_target_cannot_override_highway_grade(self):
        profile = BoundedProfiles(3, np.array([0, 1]), np.array([1, 2]), np.array([100., 100.]), np.array([.06, .06]))
        y = profile.solve(sparse.eye(3) * 20, np.array([0., 1200., 0.]))
        self.assertLessEqual(np.max(np.abs(np.diff(y))) / 100, .06015)
        self.assertGreaterEqual(y.min(), .447)

    def test_overpass_and_approaches_are_solved_together(self):
        profile = BoundedProfiles(4, np.array([0, 2]), np.array([1, 3]), np.array([200., 200.]), np.array([.06, .06]),
                                  [([0, 2], [1., -1.], 7.4, np.inf)])
        y = profile.solve(sparse.eye(4), np.zeros(4), floor=np.array([13.6, .45, .45, .45]))
        self.assertGreaterEqual(y[0], 13.597)
        self.assertGreaterEqual(y[0] - y[2], 7.397)
        self.assertLessEqual(abs(y[0] - y[1]) / 200, .06015)

    def test_impossible_clearance_is_rejected_without_poisoning_later_candidates(self):
        bounds = LevelBounds(4)
        bounds.slope(0, 1, 5)
        bounds.slope(1, 2, 5)
        bounds.slope(2, 3, 5)
        self.assertTrue(bounds.clearance([(0, 2)]))
        before = bounds.potential.copy()
        self.assertFalse(bounds.clearance([(2, 0)]))
        np.testing.assert_equal(bounds.potential, before)
        self.assertTrue(bounds.clearance([(0, 3)]))


if __name__ == '__main__':
    unittest.main()
