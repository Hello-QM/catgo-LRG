"""Pure-numpy unit tests for the three paper Fig.3 analyses.

These tests bypass mdtraj I/O by exercising the internal helpers of
`md_dynamics`, `md_orientation`, and `md_cavitation` directly on hand-crafted
coordinate arrays. They catch regressions in the numerical kernels without
requiring an HTTP client or a full trajectory file round-trip.
"""

import importlib.util
import math
import os
import sys
import unittest
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_DIR = REPO_ROOT / "server"
sys.path.insert(0, str(SERVER_DIR))


def _load_module_without_imports(name: str, path: Path):
    """Load a router module, stubbing heavy third-party deps if missing."""
    if "mdtraj" not in sys.modules:
        mdtraj_stub = type(sys)("mdtraj")
        mdtraj_stub.Trajectory = object  # type: ignore[attr-defined]
        mdtraj_stub.compute_distances = lambda *a, **k: np.zeros((1, 1))  # type: ignore[attr-defined]
        sys.modules["mdtraj"] = mdtraj_stub
    if "fastapi" not in sys.modules:
        fa = type(sys)("fastapi")

        class _APIRouter:
            def __init__(self, *a, **k): ...
            def post(self, *a, **k):
                return lambda fn: fn
            def get(self, *a, **k):
                return lambda fn: fn

        class _HTTPException(Exception):
            def __init__(self, status_code=400, detail=""):
                super().__init__(detail)
                self.status_code = status_code
                self.detail = detail

        fa.APIRouter = _APIRouter  # type: ignore[attr-defined]
        fa.HTTPException = _HTTPException  # type: ignore[attr-defined]
        sys.modules["fastapi"] = fa
    if "pydantic" not in sys.modules:
        pd = type(sys)("pydantic")

        class _BaseModel:
            def __init__(self, **kw):
                for k, v in kw.items():
                    setattr(self, k, v)

        def _Field(default=None, **_kw):
            return default

        pd.BaseModel = _BaseModel  # type: ignore[attr-defined]
        pd.Field = _Field  # type: ignore[attr-defined]
        sys.modules["pydantic"] = pd
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Prevent `from .md_utils import load_trajectory` from pulling mdtraj
    pkg_name = "catgo.routers"
    if pkg_name not in sys.modules:
        pkg = type(sys)(pkg_name)
        pkg.__path__ = [str(path.parent)]  # type: ignore[attr-defined]
        sys.modules[pkg_name] = pkg
    if f"{pkg_name}.md_utils" not in sys.modules:
        md_utils_stub = type(sys)(f"{pkg_name}.md_utils")
        md_utils_stub.load_trajectory = lambda *a, **k: None  # type: ignore[attr-defined]
        md_utils_stub.resolve_periodic = lambda t, p: p  # type: ignore[attr-defined]
        sys.modules[f"{pkg_name}.md_utils"] = md_utils_stub
    module.__package__ = pkg_name
    spec.loader.exec_module(module)
    return module


MD_DYN = _load_module_without_imports(
    "md_dynamics_test",
    SERVER_DIR / "catgo" / "routers" / "md_dynamics.py",
)
MD_CAV = _load_module_without_imports(
    "md_cavitation_test",
    SERVER_DIR / "catgo" / "routers" / "md_cavitation.py",
)


class MSDKernelTests(unittest.TestCase):
    def test_msd_ballistic_motion(self):
        """A particle moving at constant velocity v has MSD(tau) = (v*tau)^2."""
        n_frames = 50
        v = 0.3
        coords = np.zeros((n_frames, 1, 3))
        coords[:, 0, 0] = np.arange(n_frames) * v
        msd = MD_DYN._compute_msd_multiple_origins(coords, axes=(0, 1, 2), max_tau=10)
        expected = (v * np.arange(11)) ** 2
        np.testing.assert_allclose(msd, expected, rtol=1e-10, atol=1e-12)

    def test_msd_isotropic_vs_single_axis(self):
        """For isotropic Brownian motion, MSD_xyz ≈ 3 * MSD_z."""
        rng = np.random.default_rng(42)
        n_frames = 200
        coords = rng.normal(0.0, 1.0, (n_frames, 50, 3)).cumsum(axis=0)
        msd_xyz = MD_DYN._compute_msd_multiple_origins(coords, (0, 1, 2), max_tau=20)
        msd_z = MD_DYN._compute_msd_multiple_origins(coords, (2,), max_tau=20)
        np.testing.assert_allclose(msd_xyz, 3.0 * msd_z, rtol=0.15)

    def test_unwrap_removes_single_pbc_jump(self):
        box = np.array([[10.0, 10.0, 10.0]] * 3)
        xyz = np.array(
            [
                [[0.1, 0.0, 0.0]],
                [[9.9, 0.0, 0.0]],
                [[9.7, 0.0, 0.0]],
            ]
        )
        unwrapped = MD_DYN._unwrap_coordinates(xyz, box)
        self.assertAlmostEqual(float(unwrapped[0, 0, 0]), 0.1)
        self.assertAlmostEqual(float(unwrapped[1, 0, 0]), -0.1)
        self.assertAlmostEqual(float(unwrapped[2, 0, 0]), -0.3)

    def test_msd_linear_fit_recovers_slope(self):
        tau = np.linspace(0.1, 5.0, 50)
        slope_true = 0.42
        intercept_true = 0.05
        y = slope_true * tau + intercept_true + 1e-6 * np.arange(50)
        slope, intercept, r2 = MD_DYN._linear_fit(tau, y)
        self.assertAlmostEqual(slope, slope_true, places=4)
        self.assertAlmostEqual(intercept, intercept_true, places=3)
        self.assertGreater(r2, 0.9999)


class CavitationKernelTests(unittest.TestCase):
    def test_lcw_volume_linear_fit(self):
        """LCW: ΔG_cav = k*V + c should be exactly recovered by the fit."""
        R = np.array([1.25, 1.5, 1.75, 2.0, 2.25, 2.5])
        V = (4.0 / 3.0) * math.pi * R ** 3
        k = 0.15
        g = k * V + 0.02
        slope, intercept, r2 = MD_CAV._linear_fit(V, g)
        self.assertAlmostEqual(slope, k, places=6)
        self.assertAlmostEqual(intercept, 0.02, places=4)
        self.assertGreater(r2, 0.9999)

    def test_window_mean(self):
        z = np.linspace(0.0, 10.0, 11)
        g = np.arange(11, dtype=float)
        m = MD_CAV._mean_in_window(z, g, [3.0, 6.0])
        self.assertAlmostEqual(m, 4.5)

    def test_window_mean_ignores_nan(self):
        z = np.linspace(0.0, 5.0, 6)
        g = np.array([0, np.nan, 2, np.nan, 4, 5], dtype=float)
        m = MD_CAV._mean_in_window(z, g, [0.0, 5.0])
        self.assertAlmostEqual(m, 2.75)

    def test_boltzmann_relation(self):
        kBT = MD_CAV._KB_EV_PER_K * 300.0
        dg = -kBT * math.log(0.5)
        self.assertAlmostEqual(dg, kBT * math.log(2), places=12)
        self.assertTrue(0.017 < dg < 0.019)


if __name__ == "__main__":
    unittest.main(verbosity=2)
