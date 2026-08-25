"""Build-time helpers for native libraries collected by PyInstaller."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Sequence


_LINUX_CXX_RUNTIME_NAMES = frozenset({"libgcc_s.so.1", "libstdc++.so.6"})
_CXX_VERSION_PATTERN = re.compile(rb"(?:CXXABI|GLIBCXX)_[0-9]+(?:\.[0-9]+)+")


def _version_tokens(path: Path) -> set[bytes]:
    """Return C++ ABI symbol-version strings embedded in an ELF binary."""

    try:
        return set(_CXX_VERSION_PATTERN.findall(path.read_bytes()))
    except (OSError, ValueError):
        return set()


def replace_linux_conda_cxx_runtime(
    binaries: Iterable[Sequence[str]],
    conda_prefix: Path,
) -> list[tuple[str, str, str]]:
    """Use one coherent conda C++ runtime for a Linux PyInstaller bundle.

    PyInstaller may otherwise combine Ubuntu's system ``libstdc++.so.6`` with
    conda libraries such as ICU.  A newer conda ICU can require CXXABI symbols
    that Ubuntu 22.04's runtime does not export, causing the frozen executable
    to fail before the FastAPI application starts.
    """

    entries = [tuple(entry) for entry in binaries]
    runtime_dir = Path(conda_prefix) / "lib"
    replacements: dict[str, Path] = {}
    for name in sorted(_LINUX_CXX_RUNTIME_NAMES):
        candidate = runtime_dir / name
        if not candidate.is_file():
            raise RuntimeError(
                f"activated conda environment is missing required Linux runtime: {candidate}"
            )
        replacements[name] = candidate.resolve()

    provided = _version_tokens(replacements["libstdc++.so.6"])
    required: set[bytes] = set()
    for entry in entries:
        if len(entry) < 2 or Path(entry[0]).name in _LINUX_CXX_RUNTIME_NAMES:
            continue
        source = Path(entry[1])
        if source.is_file():
            required.update(_version_tokens(source))

    missing = sorted(required - provided)
    if missing:
        formatted = ", ".join(token.decode("ascii") for token in missing)
        raise RuntimeError(
            "conda libstdc++.so.6 does not satisfy collected native libraries: "
            f"{formatted}"
        )

    coherent = [
        entry
        for entry in entries
        if len(entry) >= 1 and Path(entry[0]).name not in _LINUX_CXX_RUNTIME_NAMES
    ]
    coherent.extend(
        (name, str(source), "BINARY")
        for name, source in sorted(replacements.items())
    )
    return coherent
