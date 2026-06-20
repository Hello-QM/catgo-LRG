"""Accelerator manager: platform keys, sha256 verify, atomic place, paths."""

import hashlib
import importlib

import pytest


@pytest.fixture
def accel(tmp_path, monkeypatch):
    monkeypatch.setenv("CATGO_STT_DATA_DIR", str(tmp_path))
    mod = importlib.import_module("catgo.stt.accel")
    importlib.reload(mod)
    return mod


@pytest.mark.parametrize(
    "system,machine,expected",
    [
        ("Linux", "x86_64", "linux-x64-vulkan"),
        ("Windows", "AMD64", "windows-x64-vulkan"),
        ("Darwin", "arm64", "macos-arm64-metal"),
        ("Darwin", "x86_64", "macos-x64-metal"),
    ],
)
def test_platform_key(accel, monkeypatch, system, machine, expected):
    monkeypatch.setattr("platform.system", lambda: system)
    monkeypatch.setattr("platform.machine", lambda: machine)
    assert accel.platform_key() == expected


def test_gpu_api(accel, monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    assert accel.gpu_api() == "metal"
    monkeypatch.setattr("platform.system", lambda: "Linux")
    assert accel.gpu_api() == "vulkan"


def test_pick_asset(accel):
    m = {"binaries": {"linux-x64-vulkan": {"url": "u", "sha256": "s"}}}
    assert accel._pick_asset(m, "linux-x64-vulkan") == {"url": "u", "sha256": "s"}
    assert accel._pick_asset(m, "macos-arm64-metal") is None
    assert accel._pick_asset({}, "x") is None


def test_verify_and_place_ok(accel, tmp_path):
    src = tmp_path / "src.part"
    src.write_bytes(b"hello")
    dest = tmp_path / "out" / "f.bin"
    accel._verify_and_place(src, dest, hashlib.sha256(b"hello").hexdigest())
    assert dest.read_bytes() == b"hello"
    assert not src.exists()  # moved, not copied


def test_verify_and_place_sha_mismatch(accel, tmp_path):
    src = tmp_path / "src.part"
    src.write_bytes(b"hello")
    dest = tmp_path / "f.bin"
    with pytest.raises(ValueError):
        accel._verify_and_place(src, dest, "deadbeef")
    assert not dest.exists()
    assert not src.exists()  # cleaned up


def test_extract_rejects_tar_slip(accel, tmp_path):
    import io
    import tarfile

    arc = tmp_path / "evil.tar.gz"
    with tarfile.open(arc, "w:gz") as t:
        data = b"pwned"
        info = tarfile.TarInfo("../escape.txt")
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    with pytest.raises(ValueError):
        accel._extract(arc, tmp_path / "dest")
    assert not (tmp_path / "escape.txt").exists()


def test_extract_rejects_zip_slip(accel, tmp_path):
    import zipfile

    arc = tmp_path / "evil.zip"
    with zipfile.ZipFile(arc, "w") as z:
        z.writestr("../escape.txt", "pwned")
    with pytest.raises(ValueError):
        accel._extract(arc, tmp_path / "dest")
    assert not (tmp_path / "escape.txt").exists()


def test_extract_ok(accel, tmp_path):
    import io
    import tarfile

    arc = tmp_path / "ok.tar.gz"
    with tarfile.open(arc, "w:gz") as t:
        data = b"hi"
        info = tarfile.TarInfo("whisper-cli")
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    dest = tmp_path / "dest"
    accel._extract(arc, dest)
    assert (dest / "whisper-cli").read_bytes() == b"hi"


def test_paths_and_installed(accel, tmp_path):
    assert str(accel.install_dir()).startswith(str(tmp_path))
    assert accel.model_path("small").name == "ggml-small.bin"
    assert accel.binary_installed() is False
    assert accel.installed_models() == []
    accel.models_dir().mkdir(parents=True, exist_ok=True)
    (accel.models_dir() / "ggml-base.bin").write_bytes(b"x")
    assert accel.installed_models() == ["base"]
