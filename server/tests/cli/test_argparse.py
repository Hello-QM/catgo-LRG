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
