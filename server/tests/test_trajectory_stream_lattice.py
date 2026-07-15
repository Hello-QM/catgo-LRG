"""Streamed trajectory frames must carry the cell for periodic structures.

Regression test for the 20k-atom playback slowdown: `_atoms_to_frame`
dropped `atoms.cell`, so the viewer built lattice-less structures and
ferrox-wasm fell back to pbc=[F,F,F] brute-force neighbor search
(~4s/frame at 20k atoms instead of ~0.1s with the cell list).
"""

import numpy as np
import pytest

ase = pytest.importorskip("ase")
from ase import Atoms  # noqa: E402

from catgo.routers.trajectory_stream import _atoms_to_frame  # noqa: E402


def test_periodic_atoms_frame_carries_lattice():
    cell = [[80.36, 0.0, 0.0], [0.0, 78.952, 0.0], [0.0, 0.0, 52.568]]
    atoms = Atoms("SiO2", positions=[[0, 0, 0], [1, 1, 1], [2, 2, 2]],
                  cell=cell, pbc=True)
    frame = _atoms_to_frame(3, atoms)
    assert frame["frame_number"] == 3
    assert frame["elements"] == ["Si", "O", "O"]
    assert "lattice" in frame
    assert np.allclose(frame["lattice"], cell)
    # JSON-serializable plain floats, not numpy scalars
    assert isinstance(frame["lattice"][0][0], float)


def test_molecule_frame_has_no_lattice():
    atoms = Atoms("H2O", positions=[[0, 0, 0], [0.96, 0, 0], [-0.24, 0.93, 0]])
    frame = _atoms_to_frame(0, atoms)
    assert "lattice" not in frame


def test_zero_volume_cell_is_skipped():
    # pbc flags set but degenerate (zero) cell — must not emit a bogus lattice.
    atoms = Atoms("H2", positions=[[0, 0, 0], [0.74, 0, 0]], pbc=True)
    frame = _atoms_to_frame(0, atoms)
    assert "lattice" not in frame
