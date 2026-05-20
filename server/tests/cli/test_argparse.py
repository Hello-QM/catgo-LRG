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


def test_analyze_subcommands_in_help():
    out = _run_catgo("--help")
    assert out.returncode == 0
    for c in ("dos", "band", "cohp", "freq"):
        assert c in out.stdout


import textwrap


def test_cli_freq_subcommand_end_to_end(tmp_path):
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
    r = _run_catgo("freq", str(outcar), "--mode", "adsorbed", "--no_anim")
    assert r.returncode == 0, r.stderr
    assert "G_corr" in r.stdout and "imaginary=0" in r.stdout


def test_cli_freq_invalid_mode_choice_rejected(tmp_path):
    outcar = tmp_path / "OUTCAR"; outcar.write_text("dummy")
    r = _run_catgo("freq", str(outcar), "--mode", "nonsense", "--no_anim")
    # argparse 'choices' should reject 'nonsense' before reaching the handler
    assert r.returncode != 0
    assert "nonsense" in r.stderr.lower() or "invalid choice" in r.stderr.lower()


def test_no_autostart_global_flag_listed():
    r = _run_catgo("--help")
    assert r.returncode == 0
    assert "--no-autostart" in r.stdout


def test_push_without_server_with_no_autostart_clean_exit(tmp_path):
    # No CatGO server running in CI; --no-autostart must NOT spawn one.
    r = _run_catgo("--no-autostart", "push", "--panel", "default")
    assert r.returncode == 2
    assert "--no-autostart" in r.stderr
    assert "unreachable" in r.stderr.lower() or "server" in r.stderr.lower()
    assert "Traceback" not in r.stderr


def test_viewer_subcommands_in_help():
    """Task 7 review follow-up: --help lists push/pull and their flags."""
    out = _run_catgo("--help")
    assert out.returncode == 0
    for c in ("push", "pull"):
        assert c in out.stdout
    push_help = _run_catgo("push", "--help")
    assert push_help.returncode == 0
    assert "--panel" in push_help.stdout
    pull_help = _run_catgo("pull", "--help")
    assert pull_help.returncode == 0
    assert "--panel" in pull_help.stdout
    assert "{poscar,cif,xyz,extxyz}" in pull_help.stdout or "--format" in pull_help.stdout


def test_no_autostart_after_subcommand_also_works(tmp_path):
    # Users will type the flag in either position; both must work.
    r = _run_catgo("push", "--no-autostart", "--panel", "default")
    assert r.returncode == 2, r.stderr
    assert "unrecognized" not in r.stderr  # not an argparse rejection
    assert "--no-autostart" in r.stderr or "server" in r.stderr.lower()


def _synthetic_outcar(tmp_path):
    """Minimal OUTCAR the freq op accepts (mirrors the end_to_end test)."""
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
    return outcar


def test_dash_flag_alias_accepted(tmp_path):
    """C1 — modern GNU dash-form flags must work for registry params
    whose `name` contains an underscore (e.g. freq_cutoff -> --freq-cutoff,
    no_anim -> --no-anim)."""
    outcar = _synthetic_outcar(tmp_path)
    r = _run_catgo("freq", str(outcar),
                   "--no-anim", "--freq-cutoff", "50.0",
                   "--mode", "adsorbed")
    assert r.returncode == 0, r.stderr
    assert "G_corr" in r.stdout


def test_underscore_form_still_works(tmp_path):
    """C1 — backward compatibility: existing scripts using --no_anim style
    must keep working alongside the new dash aliases."""
    outcar = _synthetic_outcar(tmp_path)
    r = _run_catgo("freq", str(outcar), "--no_anim", "--mode", "adsorbed")
    assert r.returncode == 0, r.stderr
    assert "G_corr" in r.stdout


def test_help_shows_dash_form_first():
    """C1 — --help for a subcommand whose params have underscores must
    surface the dash form (modern GNU style is the primary advertised flag)."""
    r = _run_catgo("freq", "--help")
    assert r.returncode == 0
    assert "--no-anim" in r.stdout
    assert "--freq-cutoff" in r.stdout
    assert "--mode-index" in r.stdout


# ============================================================================
# D10 — submit op registered + dash-form aliases
# ============================================================================


def test_submit_subcommand_registered():
    """D10 — `submit` shows up in `catgo --help` and accepts its full
    flag surface end-to-end via argparse (without actually running)."""
    r = _run_catgo("--help")
    assert r.returncode == 0
    assert "submit" in r.stdout

    # `submit --help` must enumerate the per-op flags
    r = _run_catgo("submit", "--help")
    assert r.returncode == 0
    for flag in ("--code", "--host", "--queue", "--walltime",
                 "--nodes", "--remote-dir", "--job-name"):
        assert flag in r.stdout, f"flag missing from help: {flag}"


def test_submit_dash_flag_aliases_parse():
    """D10 — registry params with underscores get both dash and underscore
    flag forms (P3b C1 mechanism). Verify on submit's --remote-dir / --job-name."""
    # Use the in-process parser directly — no actual submission.
    from catgo.cli import _build_legacy_parser, _add_op_subparsers
    parser, sub = _build_legacy_parser()
    _add_op_subparsers(sub)
    args = parser.parse_args([
        "submit", "in.vasp",
        "--code", "vasp", "--host", "lab",
        "--remote-dir", "/tmp/x", "--job-name", "myjob",
    ])
    assert args._op.name == "submit"
    assert args.remote_dir == "/tmp/x"
    assert args.job_name == "myjob"
    # Underscore form still works
    args = parser.parse_args([
        "submit", "in.vasp",
        "--code", "vasp", "--host", "lab",
        "--remote_dir", "/tmp/x", "--job_name", "myjob",
    ])
    assert args.remote_dir == "/tmp/x"
    assert args.job_name == "myjob"


def test_freq_ir_dash_flag_parses():
    """E8 — new freq IR flags accept the dash-form names AND emit the
    expected dest names so the handler picks them up by Param.name."""
    from catgo.cli import _build_legacy_parser, _add_op_subparsers
    parser, sub = _build_legacy_parser()
    _add_op_subparsers(sub)
    args = parser.parse_args([
        "freq", "OUTCAR",
        "--ir-spectrum", "ir.dat",
        "--ir-sigma", "5.0",
        "--ir-emin", "100",
        "--ir-emax", "2000",
        "--no-anim",
    ])
    assert args._op.name == "freq"
    assert args.ir_spectrum == "ir.dat"
    assert float(args.ir_sigma) == 5.0
    assert float(args.ir_emin) == 100.0
    assert float(args.ir_emax) == 2000.0
    # Underscore form still works
    args = parser.parse_args([
        "freq", "OUTCAR",
        "--ir_spectrum", "ir.pdf",
        "--ir_sigma", "20",
        "--no_anim",
    ])
    assert args.ir_spectrum == "ir.pdf"


def test_dos_groups_flag_parses():
    """F4 — --groups string param shows up on the dos subcommand and
    routes to args.groups."""
    from catgo.cli import _build_legacy_parser, _add_op_subparsers
    parser, sub = _build_legacy_parser()
    _add_op_subparsers(sub)
    args = parser.parse_args([
        "dos", "x.h5",
        "--groups", "0-3:d; 4,5:p:ads",
    ])
    assert args._op.name == "dos"
    assert args.groups == "0-3:d; 4,5:p:ads"


def test_dos_help_lists_groups_flag():
    """F4 — `catgo dos --help` advertises --groups."""
    r = _run_catgo("dos", "--help")
    assert r.returncode == 0
    assert "--groups" in r.stdout


def test_freq_help_lists_ir_flags():
    """E8 — `catgo freq --help` advertises the new IR flag surface."""
    r = _run_catgo("freq", "--help")
    assert r.returncode == 0
    for flag in ("--ir-spectrum", "--ir-sigma", "--ir-emin", "--ir-emax"):
        assert flag in r.stdout, f"missing from freq --help: {flag}"


def test_submit_op_registered_in_hpc_group():
    """D10 — registry self-check: submit lives in group 'hpc' and is
    needs_server=False (no auto-start)."""
    from catgo.cli.ops import build_registry
    reg = build_registry()
    assert "submit" in reg.names()
    op = reg.get("submit")
    assert op.group == "hpc"
    assert op.needs_server is False
    assert op.mutates is False
