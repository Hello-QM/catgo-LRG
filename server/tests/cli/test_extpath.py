import pytest
from catgo.cli._extpath import ensure_extension, repo_root
from catgo.cli.adapter import OpError


def test_repo_root_has_extensions():
    assert (repo_root() / "extensions").is_dir()


def test_ensure_extension_imports_catgo_dos():
    mod = ensure_extension("dos-analysis", "catgo_dos")
    assert hasattr(mod, "io")  # catgo_dos.io exists


def test_ensure_extension_missing_raises():
    with pytest.raises(OpError):
        ensure_extension("does-not-exist", "nope_pkg")
