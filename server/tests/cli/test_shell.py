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


def test_bad_input_keeps_shell_alive(tmp_path):
    src = _cu_poscar(tmp_path)
    out = []
    script = iter(["0", str(src), "supercell", "abc", "q"])
    sh = InteractiveShell(session=Session(),
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *a, **k: out.append(" ".join(map(str, a))))
    sh.run()
    assert any("expects" in line for line in out)
    assert sh.session.structure.num_sites == 1


def test_unknown_choice(tmp_path):
    out = []
    script = iter(["zzz", "q"])
    sh = InteractiveShell(session=Session(),
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *a, **k: out.append(" ".join(map(str, a))))
    sh.run()
    assert any("unknown choice" in line for line in out)


def test_eof_exits_gracefully():
    def _raise_eof(_=""):
        raise EOFError
    sh = InteractiveShell(session=Session(),
                          input_fn=_raise_eof,
                          output_fn=lambda *_a, **_k: None)
    sh.run()


def test_save_roundtrip(tmp_path):
    src = _cu_poscar(tmp_path)
    dst = tmp_path / "out.cif"
    script = iter(["0", str(src), "s", str(dst), "q"])
    sh = InteractiveShell(session=Session(),
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *_a, **_k: None)
    sh.run()
    assert dst.exists()
    assert Structure.from_file(str(dst)).num_sites == 1


def test_shell_banner_lists_analyze_group():
    out = []
    script = iter(["q"])
    sh = InteractiveShell(session=Session(),
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *a, **k: out.append(" ".join(map(str, a))))
    sh.run()
    text = "\n".join(out)
    # Each registered group must show up in the banner (dynamic enumeration).
    assert "-- build --" in text
    assert "-- convert --" in text
    assert "-- analyze --" in text
    # Spot-check at least one analyze op listed under its group
    assert "freq:" in text


import textwrap


def test_shell_freq_analyze_via_menu(tmp_path):
    """Analyze ops must be reachable from the menu (shell prompts for input)."""
    outcar = tmp_path / "OUTCAR"
    outcar.write_text(textwrap.dedent("""\
       ions per type =               1
      POMASS =   1.00
     position of ions in cartesian coordinates  (Angst):
       0.0000000  0.0000000  0.0000000

     Eigenvectors and eigenvalues of the dynamical matrix
     ----------------------------------------------------

       1 f  =    5.000000 THz    31.4159 2PiTHz  166.7800 cm-1    20.6789 meV
                 X         Y         Z           dx          dy          dz
          0.000000  0.000000  0.000000     0.000000  0.000000  1.000000
    """))
    outs = []
    # Script: choose freq, give input path, mode=adsorbed (default ok? non-empty),
    # accept defaults for other params (Enter), no_anim=True, quit.
    # Param order in registry: mode T P freq_cutoff unpaired frames amplitude
    #   mode_index symbols no_anim dump
    script = iter([
        "freq",                # op
        str(outcar),           # input path
        "adsorbed",            # mode (no default required)
        "",                    # T
        "",                    # P
        "",                    # freq_cutoff
        "",                    # unpaired
        "",                    # frames
        "",                    # amplitude
        "",                    # mode_index
        "",                    # symbols
        "1",                   # no_anim (truthy bool via prm.type(raw) = bool("1") = True)
        "",                    # dump
        "q",
    ])
    sh = InteractiveShell(session=Session(),
                          input_fn=lambda _="": next(script),
                          output_fn=lambda *a, **k: outs.append(" ".join(map(str, a))))
    sh.run()
    text = "\n".join(outs)
    assert "G_corr" in text
    assert "imaginary=0" in text
