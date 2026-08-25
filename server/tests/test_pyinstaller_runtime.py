from pathlib import Path

import pytest

from pyinstaller_runtime import replace_linux_conda_cxx_runtime


def _write(path: Path, payload: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def test_replaces_mixed_linux_cxx_runtime_with_conda_pair(tmp_path: Path):
    prefix = tmp_path / "conda"
    stdcxx = _write(
        prefix / "lib" / "libstdc++.so.6",
        b"CXXABI_1.3.13\0CXXABI_1.3.15\0GLIBCXX_3.4.30",
    )
    libgcc = _write(prefix / "lib" / "libgcc_s.so.1", b"libgcc")
    consumer = _write(
        tmp_path / "libicui18n.so.78",
        b"CXXABI_1.3.15\0GLIBCXX_3.4.30",
    )

    result = replace_linux_conda_cxx_runtime(
        [
            ("libstdc++.so.6", "/usr/lib/libstdc++.so.6", "BINARY"),
            ("libgcc_s.so.1", "/usr/lib/libgcc_s.so.1", "BINARY"),
            ("libicui18n.so.78", str(consumer), "BINARY"),
        ],
        prefix,
    )

    by_name = {entry[0]: entry for entry in result}
    assert by_name["libstdc++.so.6"] == (
        "libstdc++.so.6",
        str(stdcxx.resolve()),
        "BINARY",
    )
    assert by_name["libgcc_s.so.1"] == (
        "libgcc_s.so.1",
        str(libgcc.resolve()),
        "BINARY",
    )
    assert by_name["libicui18n.so.78"][1] == str(consumer)


def test_rejects_conda_runtime_that_cannot_satisfy_collected_library(tmp_path: Path):
    prefix = tmp_path / "conda"
    _write(prefix / "lib" / "libstdc++.so.6", b"CXXABI_1.3.13")
    _write(prefix / "lib" / "libgcc_s.so.1", b"libgcc")
    consumer = _write(tmp_path / "libicui18n.so.78", b"CXXABI_1.3.15")

    with pytest.raises(RuntimeError, match="CXXABI_1.3.15"):
        replace_linux_conda_cxx_runtime(
            [("libicui18n.so.78", str(consumer), "BINARY")],
            prefix,
        )


def test_rejects_incomplete_conda_runtime_pair(tmp_path: Path):
    prefix = tmp_path / "conda"
    _write(prefix / "lib" / "libstdc++.so.6", b"CXXABI_1.3.15")

    with pytest.raises(RuntimeError, match="libgcc_s.so.1"):
        replace_linux_conda_cxx_runtime([], prefix)
