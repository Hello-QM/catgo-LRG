from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.cli import ops_convert


def _nacl():
    return Structure(Lattice.cubic(5.64), ["Na", "Cl"],
                     [[0, 0, 0], [0.5, 0.5, 0.5]])


def test_convert_writes_target_format(tmp_path):
    s = Session(); s.structure = _nacl()
    out = tmp_path / "x.cif"
    r = ops_convert.convert(s, {"out": str(out)})
    assert r.ok
    assert out.exists()
    assert Structure.from_file(str(out)).num_sites == 2
    assert r.artifact == out


def test_inspect_reports_composition_and_symmetry():
    s = Session(); s.structure = _nacl()
    r = ops_convert.inspect(s, {})
    assert r.ok
    assert "Na1 Cl1" in r.message or "NaCl" in r.message
    assert "spacegroup" in r.message.lower()
    # inspect is read-only → no structure mutation returned
    assert r.structure is None
