"""Bounded road-profile fit: smooth terrain targets subject to grades and levels.

ADMM solves one sparse positive-definite system per iteration; its factorization
is reused. Constraints are physical bounds, not penalties that can be ignored on
a steep hill. The optional extra rows represent overpass clearances.
"""
import time

import numpy as np
from scipy import sparse
from scipy.sparse.linalg import factorized


class BoundedProfiles:
    def __init__(self, count, seg_a, seg_b, seg_h, seg_l, extra=()):
        self.count = count
        self.nseg = len(seg_a)
        self.seg_h = seg_h
        rows = np.repeat(np.arange(self.nseg), 2)
        cols = np.column_stack((seg_a, seg_b)).ravel()
        vals = np.tile([-1.0, 1.0], self.nseg)
        D = sparse.coo_matrix((vals, (rows, cols)), shape=(self.nseg, count)).tocsr()
        er, ec, ev, elo, ehi = [], [], [], [], []
        for i, (indices, coefficients, lower, upper) in enumerate(extra):
            er.extend([i] * len(indices)); ec.extend(indices); ev.extend(coefficients)
            elo.append(lower); ehi.append(upper)
        C = sparse.coo_matrix((ev, (er, ec)), shape=(len(extra), count)).tocsr()
        self.floor_scale = 0.03
        self.A = sparse.vstack((D, C, sparse.eye(count, format='csr') * self.floor_scale), format='csr')
        self.AT = self.A.T.tocsc()
        self.ATA = (self.AT @ self.A).tocsc()
        limits = seg_h * seg_l
        self.base_lower = np.r_[-limits, elo]
        self.base_upper = np.r_[limits, ehi]
        self.last = None
        self.stats = []

    def solve(self, Q, rhs, initial=None, floor=None, max_iter=2400):
        t0 = time.time()
        floor = np.full(self.count, 0.45) if floor is None else floor
        lower = np.r_[self.base_lower, floor * self.floor_scale]
        upper = np.r_[self.base_upper, np.full(self.count, np.inf)]
        x = (self.last if self.last is not None else initial).copy() if (self.last is not None or initial is not None) else floor.copy()
        rho = 10000.0
        solve = factorized((Q + rho * self.ATA).tocsc())
        z = np.clip(self.A @ x, lower, upper)
        u = np.zeros_like(z)
        max_grade_error = max_level_error = max_floor_error = np.inf
        for it in range(max_iter):
            old_x = x
            x = solve(rhs + rho * (self.AT @ (z - u)))
            ax = self.A @ x
            relaxed = 1.6 * ax - 0.6 * z
            z = np.clip(relaxed + u, lower, upper)
            u += relaxed - z
            violation = np.maximum(lower - ax, np.maximum(ax - upper, 0))
            max_grade_error = float(np.max(violation[:self.nseg] / self.seg_h, initial=0))
            stop = len(self.base_lower)
            max_level_error = float(np.max(violation[self.nseg:stop], initial=0))
            max_floor_error = float(np.max(violation[stop:], initial=0)) / self.floor_scale
            change = float(np.max(np.abs(x - old_x)))
            constraints_met = max_grade_error < 0.00015 and max_level_error < 0.003 and max_floor_error < 0.003
            # ADMM can keep a sub-millimetre oscillation after all physical constraints
            # are already satisfied. Do not confuse that numerical tail with an invalid
            # road profile, but require much tighter residuals for this exit path.
            settled = change < 0.001 or (change < 0.002 and max_grade_error < 0.00001 and
                                         max_level_error < 0.0001 and max_floor_error < 0.0001)
            if it > 20 and constraints_met and settled:
                break
            if (it + 1) % 200 == 0:
                print('[profiles] iteration %d grade excess %.6f, level %.4f m, floor %.4f m, change %.5f m' %
                      (it + 1, max_grade_error, max_level_error, max_floor_error, change), flush=True)
        else:
            raise RuntimeError('Road profile constraints did not converge: grade excess %.6f, clearance %.4f m, floor %.4f m' %
                               (max_grade_error, max_level_error, max_floor_error))
        self.last = x.copy()
        stats = dict(iterations=it + 1, seconds=round(time.time() - t0, 2), grade_excess=max_grade_error,
                     clearance_error_m=max_level_error, floor_error_m=max_floor_error)
        self.stats.append(stats)
        print('[profiles]', stats, flush=True)
        return x
