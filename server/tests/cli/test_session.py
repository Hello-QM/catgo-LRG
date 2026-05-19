import pytest
from pymatgen.core import Lattice, Structure
from catgo.cli.session import Session, SessionError


def _bcc_fe():
    return Structure(Lattice.cubic(2.87), ["Fe", "Fe"],
                      [[0, 0, 0], [0.5, 0.5, 0.5]])


def test_load_and_save_poscar_roundtrip(tmp_path):
    src = tmp_path / "POSCAR"
    _bcc_fe().to(filename=str(src), fmt="poscar")
    s = Session()
    s.load(src)
    assert s.structure is not None
    assert s.structure.num_sites == 2
    assert s.source_path == src
    out = tmp_path / "out.cif"
    s.save(out)
    assert out.exists()
    assert Structure.from_file(str(out)).num_sites == 2


def test_ase_extxyz_roundtrip(tmp_path):
    # pymatgen has no extxyz writer; build the fixture via AseAtomsAdaptor.
    from ase.io import write as _ase_write
    from pymatgen.io.ase import AseAtomsAdaptor
    src = tmp_path / "s.extxyz"
    _ase_write(str(src), AseAtomsAdaptor.get_atoms(_bcc_fe()))
    s = Session()
    s.load(src)
    # ASE branch must return a genuine pymatgen Structure (has .num_sites)
    assert isinstance(s.structure, Structure)
    assert s.structure.num_sites == 2


def test_unparseable_file_raises_sessionerror(tmp_path):
    bad = tmp_path / "junk.cif"
    bad.write_text("not a real structure")
    with pytest.raises(SessionError):
        Session().load(bad)


def test_undo_restores_previous(tmp_path):
    s = Session()
    s.structure = _bcc_fe()
    s.push_history()
    s.structure = s.structure.copy()
    s.structure.make_supercell([2, 1, 1])
    assert s.structure.num_sites == 4
    s.undo()
    assert s.structure.num_sites == 2


def test_undo_with_empty_history_raises():
    s = Session()
    s.structure = _bcc_fe()
    with pytest.raises(SessionError):
        s.undo()


def test_save_without_structure_raises(tmp_path):
    with pytest.raises(SessionError):
        Session().save(tmp_path / "x.cif")
