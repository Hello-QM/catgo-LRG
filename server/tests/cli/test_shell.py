import io
from pymatgen.core import Lattice, Structure
from catgo.cli.shell import InteractiveShell
from catgo.cli.session import Session


def _cu_poscar(tmp_path):
    p = tmp_path / "POSCAR"
    Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]]).to(
        filename=str(p), fmt="poscar")
    return p


def test_load_then_supercell_then_undo(tmp_path):
    src = _cu_poscar(tmp_path)
    # script: load file, run supercell 2,2,2, undo, quit
    script = iter([
        "0", str(src),          # load
        "supercell", "2,2,2",   # op by name + its one param
        "u",                    # undo
        "q",                    # quit
    ])
    sh = InteractiveShell(session=Session(),
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *_a, **_k: None)
    sh.run()
    # after undo, structure back to 1 site (the loaded cell)
    assert sh.session.structure.num_sites == 1


def test_quit_immediately():
    script = iter(["q"])
    sh = InteractiveShell(session=Session(),
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *_a, **_k: None)
    sh.run()  # must return without error
