"""Vendored PORMAKE scaler must be jax-free and still converge."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np


def test_scaler_module_has_no_jax():
    import catgo.vendor.pormake.scaler as scaler_mod
    src = open(scaler_mod.__file__).read()
    assert "import jax" not in src
    assert "jnp" not in src


def test_known_framework_builds_with_valid_cell():
    """tbo + N10 + N409 = HKUST-1 (verified upstream-working combo).

    Exercises the full scaler path; asserts convergence to a valid cell.
    """
    import catgo.vendor.pormake as pm

    db = pm.Database()
    tbo = db.get_topo("tbo")
    n10 = db.get_bb("N10")    # BTC (3-c node)
    n409 = db.get_bb("N409")  # Cu paddlewheel (4-c node)
    builder = pm.Builder()
    framework = builder.build_by_type(topology=tbo, node_bbs={0: n10, 1: n409})
    a, b, c, alpha, beta, gamma = framework.atoms.get_cell_lengths_and_angles()
    assert len(framework.atoms) > 0
    assert a > 0 and b > 0 and c > 0
    assert framework.atoms.get_volume() > 0
