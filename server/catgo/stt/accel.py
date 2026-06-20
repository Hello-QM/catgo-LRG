"""Optional STT accelerator manager — download/install whisper.cpp (Vulkan/Metal).

The default sidecar ships only faster-whisper. Users on AMD/Intel iGPU (Vulkan)
or Apple Silicon (Metal) can download a prebuilt whisper.cpp `whisper-cli` from
the project's GitHub Releases on demand, plus GGML models. Everything lands in a
per-user dir (never the app bundle) and is sha256-verified + written atomically.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import shutil
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Callable

import httpx

from .engine_state import data_dir

logger = logging.getLogger(__name__)

# Default manifest: a Release asset listing per-platform binary archives. Pinned
# to a tag decoupled from the app version so the accelerator can ship/update
# independently. Overridable for testing / self-hosting.
DEFAULT_MANIFEST_URL = os.environ.get(
    "CATGO_STT_MANIFEST_URL",
    "https://github.com/Hello-QM/catgo-LRG/releases/download/stt-accel-v1/"
    "stt-accel-manifest.json",
)
# GGML model hosts (whisper.cpp format). hf-mirror used as a fallback for blocked
# HuggingFace (e.g. mainland China).
_GGML_HOSTS = [
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main",
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main",
]

ProgressCb = Callable[[int, int], None]

# Shared, single-flight download progress (one download at a time is plenty for
# this UI). Read by GET /accel/status.
_download: dict = {"active": False, "kind": None, "pct": 0, "error": None}


def get_download() -> dict:
    return dict(_download)


def _set_progress(kind: str, pct: int, active: bool = True, error: str | None = None) -> None:
    _download.update(active=active, kind=kind, pct=pct, error=error)


# ─── Platform / GPU ──────────────────────────────────────────────────────
def _os_arch() -> tuple[str, str]:
    sysname = platform.system().lower()
    machine = platform.machine().lower()
    os_ = {"linux": "linux", "darwin": "macos", "windows": "windows"}.get(sysname, sysname)
    if machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("x86_64", "amd64"):
        arch = "x64"
    else:
        arch = machine
    return os_, arch


def gpu_api() -> str | None:
    """The GPU compute API whisper.cpp would use on this platform. macOS→metal,
    Linux/Windows→vulkan. None when unsupported (offer hidden)."""
    os_, _ = _os_arch()
    if os_ == "macos":
        return "metal"
    if os_ in ("linux", "windows"):
        return "vulkan"
    return None


def detect_gpu() -> dict:
    """Best-effort GPU name + api for the UI status line."""
    api = gpu_api()
    name = None
    try:
        if api == "vulkan" and shutil.which("vulkaninfo"):
            import subprocess

            out = subprocess.run(
                ["vulkaninfo", "--summary"], capture_output=True, text=True, timeout=5
            ).stdout
            for line in out.splitlines():
                if "deviceName" in line and "llvmpipe" not in line:
                    name = line.split("=", 1)[1].strip()
                    break
        elif api == "metal":
            name = "Apple GPU (Metal)"
    except Exception as exc:  # pragma: no cover - probe best-effort
        logger.debug("GPU probe failed: %s", exc)
    return {"gpu_api": api, "gpu_name": name}


def platform_key() -> str | None:
    api = gpu_api()
    if not api:
        return None
    os_, arch = _os_arch()
    return f"{os_}-{arch}-{api}"


# ─── Paths ───────────────────────────────────────────────────────────────
def install_dir() -> Path:
    return data_dir() / "bin"


def models_dir() -> Path:
    return data_dir() / "models"


def binary_path() -> Path:
    name = "whisper-cli.exe" if _os_arch()[0] == "windows" else "whisper-cli"
    return install_dir() / name


def model_path(size: str) -> Path:
    return models_dir() / f"ggml-{size}.bin"


def binary_installed() -> bool:
    return binary_path().exists()


def installed_models() -> list[str]:
    d = models_dir()
    if not d.is_dir():
        return []
    out = []
    for p in d.glob("ggml-*.bin"):
        out.append(p.name[len("ggml-"):-len(".bin")])
    return sorted(out)


# ─── Download primitives ─────────────────────────────────────────────────
def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify_and_place(tmp: Path, dest: Path, expected_sha: str | None) -> None:
    """Verify sha256 (if given) then atomically move tmp → dest."""
    if expected_sha:
        actual = _sha256_file(tmp)
        if actual.lower() != expected_sha.lower():
            tmp.unlink(missing_ok=True)
            raise ValueError(f"sha256 mismatch: expected {expected_sha}, got {actual}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(tmp, dest)


def download_file(
    url: str, dest: Path, sha256: str | None = None, progress: ProgressCb | None = None
) -> Path:
    """Stream url → dest with sha256 verification and atomic rename."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), suffix=".part")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out, httpx.stream(
            "GET", url, follow_redirects=True, timeout=60
        ) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length", 0))
            done = 0
            for chunk in resp.iter_bytes(1 << 20):
                out.write(chunk)
                done += len(chunk)
                if progress:
                    progress(done, total)
        _verify_and_place(tmp, dest, sha256)
        return dest
    finally:
        tmp.unlink(missing_ok=True)


def _pick_asset(manifest: dict, key: str) -> dict | None:
    return (manifest.get("binaries") or {}).get(key)


def _is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def _extract(archive: Path, dest_dir: Path) -> None:
    """Extract an archive, rejecting path-traversal (Zip/Tar Slip) and link
    members so a malicious/compromised asset can't write outside dest_dir."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                if not _is_within(dest_dir, dest_dir / name):
                    raise ValueError(f"unsafe path in archive: {name}")
            z.extractall(dest_dir)
    else:  # .tar.gz / .tgz
        with tarfile.open(archive) as t:
            for m in t.getmembers():
                if m.issym() or m.islnk():
                    raise ValueError(f"link member not allowed: {m.name}")
                if not _is_within(dest_dir, dest_dir / m.name):
                    raise ValueError(f"unsafe path in archive: {m.name}")
            t.extractall(dest_dir)


def _mark_executable(path: Path) -> None:
    if path.exists() and os.name != "nt":
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


# ─── High-level installs ─────────────────────────────────────────────────
def install_binary(manifest_url: str | None = None) -> Path:
    """Download + extract the whisper.cpp binary for this platform/GPU."""
    key = platform_key()
    if not key:
        raise RuntimeError("no supported GPU accelerator for this platform")
    _set_progress("binary", 0)
    try:
        url = manifest_url or DEFAULT_MANIFEST_URL
        manifest = httpx.get(url, follow_redirects=True, timeout=30).raise_for_status().json()
        asset = _pick_asset(manifest, key)
        if not asset:
            raise RuntimeError(f"no accelerator binary for {key}")
        suffix = ".zip" if asset["url"].endswith(".zip") else ".tar.gz"
        with tempfile.TemporaryDirectory() as td:
            archive = Path(td) / f"accel{suffix}"
            download_file(
                asset["url"], archive, asset.get("sha256"),
                progress=lambda d, t: _set_progress("binary", int(d * 100 / t) if t else 0),
            )
            _extract(archive, install_dir())
        _mark_executable(binary_path())
        # Some builds ship libs next to the binary; mark any .so/.dylib readable.
        _set_progress("binary", 100, active=False)
        return binary_path()
    except Exception as exc:
        _set_progress("binary", 0, active=False, error=str(exc))
        raise


def download_model(size: str) -> Path:
    """Download a GGML model (ggml-<size>.bin), trying HF then the mirror."""
    dest = model_path(size)
    _set_progress("model", 0)
    last_exc: Exception | None = None
    for host in _GGML_HOSTS:
        try:
            download_file(
                f"{host}/ggml-{size}.bin", dest,
                progress=lambda d, t: _set_progress("model", int(d * 100 / t) if t else 0),
            )
            _set_progress("model", 100, active=False)
            return dest
        except Exception as exc:
            last_exc = exc
            logger.warning("model download from %s failed: %s", host, exc)
    _set_progress("model", 0, active=False, error=str(last_exc))
    raise RuntimeError(f"model download failed: {last_exc}")
