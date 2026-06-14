"""`catgo freq-inputs` launcher (dispatched directly in main, bypassing argparse REMAINDER)."""
import pytest
from catgo.cli.freq_inputs_cmd import run_freq_inputs, _script_dir

_H2_POSCAR = """H2
1.0
13.0 0 0
0 13.2 0
0 0 13.4
H
2
Cartesian
6.0 6.6 6.7
6.74 6.6 6.7
"""


def test_script_dir_points_at_shipped_script():
    assert (_script_dir() / "build_freq_inputs.py").is_file()


def test_freq_inputs_gas(tmp_path):
    (tmp_path / "POSCAR").write_text(_H2_POSCAR)
    out = tmp_path / "H2_freq"
    rc = run_freq_inputs(["--structure", str(tmp_path / "POSCAR"), "--out", str(out), "--gas"])
    assert rc == 0
    for f in ("POSCAR", "INCAR", "KPOINTS"):
        assert (out / f).is_file()
    incar = (out / "INCAR").read_text()
    assert "IBRION = 5" in incar and "NCORE" not in incar      # freq, no NCORE
    assert "1 1 1" in (out / "KPOINTS").read_text()             # Gamma-only


def test_main_dispatches_freq_inputs_leading_option(tmp_path):
    # main() must handle a tail that LEADS with an option (argparse REMAINDER can't)
    from catgo.cli import main
    (tmp_path / "POSCAR").write_text(_H2_POSCAR)
    out = tmp_path / "H2_freq2"
    with pytest.raises(SystemExit) as ei:
        main(["freq-inputs", "--structure", str(tmp_path / "POSCAR"),
              "--out", str(out), "--gas"])
    assert ei.value.code == 0
    assert (out / "INCAR").is_file()
