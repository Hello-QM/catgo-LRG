import subprocess, sys
from pathlib import Path

# server/ dir, derived from this file so the test is run-dir independent
# (tests/cli/test_argparse.py -> parents[2] == server/)
SERVER_DIR = Path(__file__).resolve().parents[2]


def test_legacy_subcommands_still_present():
    out = subprocess.run(
        [sys.executable, "-m", "catgo", "--help"],
        cwd=str(SERVER_DIR), capture_output=True, text=True,
    )
    assert out.returncode == 0
    for cmd in ("serve", "setup", "status", "stop"):
        assert cmd in out.stdout


def test_import_main_resolves():
    from catgo.cli import main  # entry point catgo.cli:main
    assert callable(main)


def test_build_registry_has_p1_ops():
    from catgo.cli.ops import build_registry
    reg = build_registry()
    assert set(["slab", "supercell", "convert", "inspect"]).issubset(reg.names())


def test_cli_slab_subcommand_end_to_end(tmp_path):
    import subprocess, sys
    from pymatgen.core import Lattice, Structure
    src = tmp_path / "POSCAR"
    Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]]).to(
        filename=str(src), fmt="poscar")
    out = tmp_path / "slab.vasp"
    r = subprocess.run(
        [sys.executable, "-m", "catgo", "slab", str(src),
         "--miller", "1,1,0", "--layers", "4", "-o", str(out)],
        cwd=str(SERVER_DIR), capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    assert out.exists()


def _cu_poscar(tmp_path):
    from pymatgen.core import Lattice, Structure
    src = tmp_path / "POSCAR"
    Structure(Lattice.cubic(3.61), ["Cu"], [[0, 0, 0]]).to(
        filename=str(src), fmt="poscar")
    return src


def _run_catgo(*cli_args):
    import subprocess, sys
    return subprocess.run(
        [sys.executable, "-m", "catgo", *cli_args],
        cwd=str(SERVER_DIR), capture_output=True, text=True,
    )


def test_convert_without_out_clean_error(tmp_path):
    r = _run_catgo("convert", str(_cu_poscar(tmp_path)))
    assert r.returncode == 1
    assert "out" in r.stderr.lower() and "required" in r.stderr.lower()
    assert "Traceback" not in r.stderr


def test_bad_miller_clean_error(tmp_path):
    r = _run_catgo("slab", str(_cu_poscar(tmp_path)),
                   "--miller", "abc", "-o", str(tmp_path / "s.vasp"))
    assert r.returncode == 1
    assert "miller" in r.stderr.lower()
    assert "Traceback" not in r.stderr


def test_slab_without_out_signals_not_saved(tmp_path):
    r = _run_catgo("slab", str(_cu_poscar(tmp_path)), "--miller", "1,1,0")
    assert r.returncode == 0, r.stderr
    assert "not saved" in r.stdout


def test_legacy_dispatch_still_works_after_wiring():
    r = _run_catgo("status")
    assert r.returncode == 0
    assert "Traceback" not in r.stderr
