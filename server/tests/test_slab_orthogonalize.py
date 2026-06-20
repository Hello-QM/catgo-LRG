"""Slab generation must return a cell whose c-vector is perpendicular to the
ab surface plane (vacuum cleanly along c). Regression: the interactive/MCP
slab tool used to default orthogonalize_c=False, yielding an oriented cell with
a tilted c that is unusable for surface DFT.
"""
import sys
from pathlib import Path

import numpy as np

_d = str(Path(__file__).resolve().parent.parent)
if _d not in sys.path:
    sys.path.insert(0, _d)

from pymatgen.core import Lattice, Structure  # noqa: E402

from catgo.routers.structure_ops import GenerateSlabRequest, generate_slab  # noqa: E402


def _fcc_cu() -> dict:
    lat = Lattice.cubic(3.61)
    coords = [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]
    return Structure(lat, ["Cu"] * 4, coords).as_dict()


def _c_perp_ab(slab_dict: dict) -> bool:
    m = np.array(slab_dict["lattice"]["matrix"], dtype=float)
    a, b, c = m[0], m[1], m[2]
    cos_ca = abs(np.dot(c, a)) / (np.linalg.norm(c) * np.linalg.norm(a))
    cos_cb = abs(np.dot(c, b)) / (np.linalg.norm(c) * np.linalg.norm(b))
    return cos_ca < 1e-6 and cos_cb < 1e-6


def test_default_slab_has_c_perpendicular_to_ab():
    # FCC(111): the oriented (non-orthogonalized) cell has a tilted c — this
    # is exactly the case that must be orthogonalized by default.
    res = generate_slab(
        GenerateSlabRequest(structure=_fcc_cu(), miller_index=[1, 1, 1])
    )
    assert res.num_slabs >= 1
    assert _c_perp_ab(res.slabs[0]), "default slab c-vector is not perpendicular to ab"


def test_orthogonalize_c_can_be_disabled():
    # The flag still works: explicitly False keeps the oriented (tilted-c) cell.
    res = generate_slab(
        GenerateSlabRequest(
            structure=_fcc_cu(), miller_index=[1, 1, 1], orthogonalize_c=False
        )
    )
    assert not _c_perp_ab(res.slabs[0]), "FCC(111) oriented cell should have a tilted c"
