import pytest
from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.cli import ops_build
from catgo.cli.adapter import OpError


def _fcc_cu():
    return Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]])


def test_supercell_222():
    s = Session(); s.structure = _fcc_cu()
    r = ops_build.supercell(s, {"scaling": [2, 2, 2]})
    assert r.ok
    assert r.structure.num_sites == 8


def test_slab_110_returns_first_slab():
    s = Session(); s.structure = _fcc_cu()
    r = ops_build.slab(s, {"miller": [1, 1, 0], "layers": 4, "vacuum": 12.0})
    assert r.ok
    assert r.structure.num_sites >= 1
    # vacuum gap → c not periodic
    assert list(r.structure.lattice.pbc) == [True, True, False]


def test_slab_all_zero_miller_errors():
    s = Session(); s.structure = _fcc_cu()
    with pytest.raises(OpError):
        ops_build.slab(s, {"miller": [0, 0, 0], "layers": 4, "vacuum": 12.0})


def test_no_active_structure_errors():
    with pytest.raises(OpError):
        ops_build.supercell(Session(), {"scaling": [2, 2, 2]})


def test_reticular_preset_builds_without_input_structure():
    session = Session()  # no active structure
    res = ops_build.reticular(session, {"mode": "preset", "preset": "hkust-1"})
    assert res.ok
    assert res.structure is not None
    assert res.structure.num_sites > 0


def test_reticular_advanced_build():
    session = Session()
    res = ops_build.reticular(
        session,
        {"mode": "advanced", "topology": "tbo", "node": "0=N10,1=N409"},
    )
    assert res.ok
    assert res.structure.num_sites > 0


def test_reticular_unknown_preset_errors():
    session = Session()
    with pytest.raises(OpError):
        ops_build.reticular(session, {"mode": "preset", "preset": "not-a-preset"})
