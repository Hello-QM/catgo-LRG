"""Make the local extension packages (extensions/<name>/) importable.

catgo_dos / catgo_cohp live under extensions/ with their own pyproject and
are NOT installed in the CLI environment. The analyze handlers call this to
sys.path-insert the extension dir before a lazy import, with a clean OpError
if absent.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType

from catgo.cli.adapter import OpError


def repo_root() -> Path:
    # server/catgo/cli/_extpath.py -> parents[3] == repo root
    return Path(__file__).resolve().parents[3]


def ensure_extension(ext_dir: str, package: str) -> ModuleType:
    """sys.path-insert extensions/<ext_dir>/ and import <package>.

    Raises OpError if the directory or package is missing.
    """
    ext_path = repo_root() / "extensions" / ext_dir
    if not ext_path.is_dir():
        raise OpError(
            f"extension '{ext_dir}' not found at {ext_path} — "
            f"required for this analysis")
    p = str(ext_path)
    # prepend is safe: extension dirs contain only namespaced catgo_*
    # packages (+ README/pyproject), nothing that shadows stdlib/site
    if p not in sys.path:
        sys.path.insert(0, p)
    try:
        return importlib.import_module(package)
    except ImportError as exc:
        raise OpError(
            f"cannot import '{package}' from {ext_path}: {exc}") from exc
