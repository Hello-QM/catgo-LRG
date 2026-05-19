import pytest
from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session
from catgo.cli import ops_convert
from catgo.cli.adapter import OpError


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
    assert r.structure is None


def test_inspect_nn_is_pbc_aware():
    st = _nacl()
    s = Session(); s.structure = st
    r = ops_convert.inspect(s, {})
    expected = st.get_distance(0, 1)
    assert f"{expected:.3f} A" in r.message


def test_convert_overwrite_guard(tmp_path):
    s = Session(); s.structure = _nacl()
    out = tmp_path / "x.cif"
    assert ops_convert.convert(s, {"out": str(out)}).ok
    with pytest.raises(OpError):
        ops_convert.convert(s, {"out": str(out)})
    r = ops_convert.convert(s, {"out": str(out), "force": True})
    assert r.ok


def test_no_active_structure_errors(tmp_path):
    with pytest.raises(OpError):
        ops_convert.convert(Session(), {"out": str(tmp_path / "x.cif")})
    with pytest.raises(OpError):
        ops_convert.inspect(Session(), {})
