import subprocess, sys


def test_legacy_subcommands_still_present():
    out = subprocess.run(
        [sys.executable, "-m", "catgo", "--help"],
        cwd="server", capture_output=True, text=True,
    )
    assert out.returncode == 0
    for cmd in ("serve", "setup", "status", "stop"):
        assert cmd in out.stdout


def test_import_main_resolves():
    from catgo.cli import main  # entry point catgo.cli:main
    assert callable(main)
