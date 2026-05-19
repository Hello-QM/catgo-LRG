from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.cli.ops import build_registry


def _cu():
    return Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]])


def test_handler_invoked_same_via_registry_lookup():
    reg = build_registry()
    op = reg.get("supercell")
    s = Session(); s.structure = _cu()
    r = op.handler(s, {"scaling": [2, 2, 2]})
    assert r.ok and r.structure.num_sites == 8
