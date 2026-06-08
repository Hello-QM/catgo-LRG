"""Streaming loader for large multi-frame XYZ trajectories.

A 300+ MB / 10k-frame AIMD ``*-pos-1.xyz`` must never be slurped whole into
the webview — JSON-encoding the file, ``JSON.parse`` on the main thread, an
eager all-frames parse, and a base64 copy together exhaust the WebKitGTK heap
and freeze the page.

This router keeps the file on disk and serves it frame-by-frame:

1. ``/trajectory/index``  — scan the file once, cache a byte-offset table
   (one ``int`` per frame), return ``total_frames`` + ``n_atoms``.
2. ``/trajectory/frames`` — ``seek`` to a frame's offset and read ONLY that
   frame's bytes; return a small batch (initial load + scrub prefetch).
3. ``/trajectory/metadata`` — sampled per-frame comment-line properties
   (energy / temperature / ...) for the plot panel.

The index is cached in-process keyed by ``(abspath, mtime_ns, size)`` so a
re-open is instant and edits invalidate automatically. Memory held per file is
just the offset list (~8 bytes/frame), never the file content.
"""

from __future__ import annotations

import logging
import hashlib
import os
import re
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/trajectory", tags=["trajectory-stream"])


# -----------------------------------------------------------------------------
# Index cache
# -----------------------------------------------------------------------------


class _TrajIndex:
    """Per-frame index for a trajectory file, plus basic shape.

    ``fmt`` selects the reader. For text formats (``xyz``/``lammpstrj``)
    ``offsets`` holds the byte offset of each frame start and ``total_frames``
    is ``len(offsets)``. For ``traj`` (ASE binary) ``offsets`` is empty and the
    frame count is stored in ``_total`` (ASE handles random access itself).
    """

    __slots__ = ("fmt", "offsets", "file_size", "n_atoms", "_total", "elements", "lattices")

    def __init__(
        self,
        fmt: str,
        offsets: list[int],
        file_size: int,
        n_atoms: int,
        total: int | None = None,
        elements: list[str] | None = None,
        lattices: list[list[list[float]]] | None = None,
    ) -> None:
        self.fmt = fmt
        self.offsets = offsets
        self.file_size = file_size
        self.n_atoms = n_atoms
        self._total = total if total is not None else len(offsets)
        # XDATCAR-only: element list (constant — VASP can't vary composition)
        # and per-frame 3x3 lattice (constant cell repeats the same matrix;
        # NPT carries the cell that was in effect for each frame).
        self.elements = elements or []
        self.lattices = lattices or []

    @property
    def total_frames(self) -> int:
        return self._total

    def frame_span(self, n: int) -> tuple[int, int]:
        """Return ``(start, end)`` byte range of frame ``n`` (text formats)."""
        start = self.offsets[n]
        end = self.offsets[n + 1] if n + 1 < len(self.offsets) else self.file_size
        return start, end


# Keyed by (abspath, mtime_ns, size) so any on-disk change rebuilds the index.
_INDEX_CACHE: dict[tuple[str, int, int], _TrajIndex] = {}
_CACHE_LOCK = threading.Lock()


def _detect_format(p: Path) -> str:
    """Map a file extension / name to a reader format."""
    suffix = p.suffix.lower()
    if suffix == ".lammpstrj":
        return "lammpstrj"
    if suffix == ".traj":
        return "traj"
    # VASP XDATCAR usually has no extension; match by name (XDATCAR,
    # XDATCAR.bz2 already decompressed, my_run.XDATCAR, ...).
    if "xdatcar" in p.name.lower():
        return "xdatcar"
    return "xyz"  # .xyz / .extxyz / default

# Property patterns for the plot panel. Word boundaries + a MANDATORY `=`/`:`
# keep single-letter keys (E/V/P/T) from matching the trailing letter of an
# unrelated word — e.g. the `e` in "tim<e> = 5500" must NOT read as energy.
# CP2K AIMD comments look like: ` i = 0, time = 0.000, E = -3572.1`.
_NUM = r"([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)"
_META_PATTERNS: dict[str, re.Pattern[str]] = {
    "energy": re.compile(rf"\b(?:energy|etot|E)\b\s*[=:]\s*{_NUM}", re.I),
    "volume": re.compile(rf"\b(?:volume|vol|V)\b\s*[=:]\s*{_NUM}", re.I),
    "pressure": re.compile(rf"\b(?:pressure|press|P)\b\s*[=:]\s*{_NUM}", re.I),
    "temperature": re.compile(rf"\b(?:temperature|temp|T)\b\s*[=:]\s*{_NUM}", re.I),
    "force_max": re.compile(rf"\b(?:max_force|fmax)\b\s*[=:]\s*{_NUM}", re.I),
}
_STEP_PATTERN = re.compile(r"\b(?:step|frame|i)\b\s*[=:]\s*(\d+)", re.I)


def _resolve_path(path: str) -> Path:
    """Resolve a user-supplied local path; reject anything not a real file."""
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    p = Path(path).expanduser()
    try:
        p = p.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"bad path: {exc}") from exc
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"not a file: {path}")
    return p


def _build_xyz_index(p: Path) -> _XYZIndex:
    """Single binary pass building per-frame byte offsets (no content kept)."""
    offsets: list[int] = []
    n_atoms = 0
    with p.open("rb") as fh:
        while True:
            frame_start = fh.tell()
            header = fh.readline()
            if not header:
                break
            stripped = header.strip()
            if not stripped:
                continue
            try:
                num = int(stripped)
            except ValueError:
                continue
            if num <= 0:
                continue

            # Valid frame header — record its start, then skip comment + atoms.
            if not n_atoms:
                n_atoms = num
            complete = fh.readline() != b""  # comment line
            for _ in range(num):
                if not fh.readline():
                    complete = False
                    break
            if not complete:
                break  # truncated final frame — drop it
            offsets.append(frame_start)

    file_size = p.stat().st_size
    return _TrajIndex("xyz", offsets, file_size, n_atoms)


# Frame-boundary marker for a LAMMPS dump (`*.lammpstrj`). Each frame begins
# with an "ITEM: TIMESTEP" line, followed by the count, box, and atom blocks.
_LAMMPS_FRAME_MARKER = b"ITEM: TIMESTEP"


def _build_lammps_index(p: Path) -> _TrajIndex:
    """Byte-offset index of a LAMMPS dump: one offset per ``ITEM: TIMESTEP``."""
    offsets: list[int] = []
    n_atoms = 0
    with p.open("rb") as fh:
        while True:
            pos = fh.tell()
            line = fh.readline()
            if not line:
                break
            if line.startswith(_LAMMPS_FRAME_MARKER):
                offsets.append(pos)
            elif not n_atoms and line.startswith(b"ITEM: NUMBER OF ATOMS"):
                try:
                    n_atoms = int(fh.readline().strip())
                except ValueError:
                    n_atoms = 0
    file_size = p.stat().st_size
    return _TrajIndex("lammpstrj", offsets, file_size, n_atoms)


def _build_traj_index(p: Path) -> _TrajIndex:
    """Index an ASE ``.traj`` — ASE owns random access, so just count frames."""
    from ase.io.trajectory import Trajectory

    traj = Trajectory(str(p), mode="r")
    try:
        total = len(traj)
        n_atoms = len(traj[0]) if total else 0
    finally:
        traj.close()
    return _TrajIndex("traj", [], p.stat().st_size, n_atoms, total=total)


def _parse_xdatcar_header(lines: list[str], start: int) -> tuple[list[list[float]], list[str], int] | None:
    """Parse a header block at ``lines[start]`` (title line). Returns
    ``(lattice 3x3, expanded element list, next_line_index)`` or ``None`` if
    the block is not a valid header. Mirrors the frontend parser layout:
    start=title, +1=scale, +2..4=lattice, +5=element names, +6=counts.
    """
    if start + 6 >= len(lines):
        return None
    try:
        scale = float(lines[start + 1].split()[0])
    except (ValueError, IndexError):
        return None
    lattice: list[list[float]] = []
    for r in range(2, 5):
        parts = lines[start + r].split()
        if len(parts) < 3:
            return None
        try:
            lattice.append([float(parts[0]) * scale, float(parts[1]) * scale, float(parts[2]) * scale])
        except ValueError:
            return None
    names = lines[start + 5].split()
    try:
        counts = [int(x) for x in lines[start + 6].split()]
    except ValueError:
        return None
    if not names or len(counts) != len(names) or any(c <= 0 for c in counts):
        return None
    elements: list[str] = []
    for name, c in zip(names, counts):
        elements.extend([name] * c)
    return lattice, elements, start + 7


def _build_xdatcar_index(p: Path) -> _TrajIndex:
    """Index an XDATCAR: byte offset of each ``configuration=`` line plus the
    lattice in effect for that frame (constant cell, or per-frame for NPT).

    The element list and per-frame lattice are stored so a single frame can be
    read and converted from fractional to Cartesian coordinates without
    re-reading the whole file.
    """
    text = p.read_text(errors="replace")
    lines = text.split("\n")

    top = _parse_xdatcar_header(lines, 0)
    if top is None:
        raise HTTPException(status_code=400, detail="XDATCAR: bad header")
    cur_lattice, elements, _ = top

    # Byte offset of each line (so we can return the configuration line's
    # offset). Building the prefix once is O(lines); seek uses these offsets.
    line_byte_offsets: list[int] = [0] * len(lines)
    acc = 0
    enc = text.encode("utf-8", "replace")
    # Recompute per-line byte offsets from the encoded text to stay exact for
    # multibyte content (rare in XDATCAR, but correct).
    b = 0
    for i, ln in enumerate(lines):
        line_byte_offsets[i] = b
        b += len(ln.encode("utf-8", "replace")) + 1  # +1 for the '\n'
    del enc, acc

    offsets: list[int] = []
    lattices: list[list[list[float]]] = []
    i = top[2]
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            i += 1
            continue
        if "configuration=" not in line:
            rep = _parse_xdatcar_header(lines, i)
            if rep is not None:  # NPT: cell changed for the next frame
                cur_lattice, elements, nxt = rep
                i = nxt
                continue
            i += 1
            continue
        offsets.append(line_byte_offsets[i])
        lattices.append(cur_lattice)
        # skip the configuration line + its n_atoms coordinate lines
        i += 1 + len(elements)

    file_size = p.stat().st_size
    return _TrajIndex(
        "xdatcar", offsets, file_size, len(elements),
        elements=elements, lattices=lattices,
    )


def _get_index(path: str) -> tuple[Path, _TrajIndex]:
    """Return the cached index for ``path``, building it on first access."""
    p = _resolve_path(path)
    st = p.stat()
    key = (str(p), st.st_mtime_ns, st.st_size)
    with _CACHE_LOCK:
        idx = _INDEX_CACHE.get(key)
    if idx is None:
        fmt = _detect_format(p)
        logger.info("Indexing %s trajectory: %s (%.0f MB)", fmt, p, st.st_size / 1e6)
        if fmt == "lammpstrj":
            idx = _build_lammps_index(p)
        elif fmt == "traj":
            idx = _build_traj_index(p)
        elif fmt == "xdatcar":
            idx = _build_xdatcar_index(p)
        else:
            idx = _build_xyz_index(p)
        with _CACHE_LOCK:
            _INDEX_CACHE[key] = idx
        logger.info("Indexed %d frames (%d atoms) in %s", idx.total_frames, idx.n_atoms, p.name)
    return p, idx


def _read_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    """Read and parse frame ``n``, dispatching on the indexed format."""
    if idx.fmt == "lammpstrj":
        return _read_lammps_frame(p, idx, n)
    if idx.fmt == "traj":
        return _read_traj_frame(p, idx, n)
    if idx.fmt == "xdatcar":
        return _read_xdatcar_frame(p, idx, n)
    return _read_xyz_frame(p, idx, n)


def _atoms_to_frame(n: int, atoms: Any) -> dict[str, Any]:
    """Convert an ASE ``Atoms`` to the wire frame shape (+ energy if present)."""
    props: dict[str, float] = {}
    try:
        props["energy"] = float(atoms.get_potential_energy())
    except Exception:
        pass
    return {
        "frame_number": n,
        "elements": list(atoms.get_chemical_symbols()),
        "positions": atoms.get_positions().tolist(),
        "comment": "",
        "properties": props,
    }


def _read_lammps_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    """Slice frame ``n``'s bytes and parse the single dump frame via ASE."""
    from io import StringIO

    from ase.io import read as ase_read

    start, end = idx.frame_span(n)
    with p.open("rb") as fh:
        fh.seek(start)
        raw = fh.read(end - start)
    try:
        atoms = ase_read(StringIO(raw.decode("utf-8", "replace")), format="lammps-dump-text")
    except Exception as exc:
        logger.warning("lammps frame %d parse failed: %s", n, exc)
        return {"frame_number": n, "elements": [], "positions": [], "comment": ""}
    return _atoms_to_frame(n, atoms)


def _read_traj_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    """Random-access frame ``n`` from an ASE ``.traj``."""
    from ase.io.trajectory import Trajectory

    traj = Trajectory(str(p), mode="r")
    try:
        atoms = traj[n]
    finally:
        traj.close()
    return _atoms_to_frame(n, atoms)


def _read_xyz_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    """Read and parse a single XYZ frame ``n`` via its byte span."""
    start, end = idx.frame_span(n)
    with p.open("rb") as fh:
        fh.seek(start)
        raw = fh.read(end - start)
    lines = raw.decode("utf-8", "replace").splitlines()

    head = 0
    while head < len(lines) and not lines[head].strip():
        head += 1
    if head >= len(lines):
        return {"frame_number": n, "elements": [], "positions": [], "comment": ""}

    try:
        num = int(lines[head].strip())
    except ValueError:
        return {"frame_number": n, "elements": [], "positions": [], "comment": ""}

    comment = lines[head + 1] if head + 1 < len(lines) else ""
    elements: list[str] = []
    positions: list[list[float]] = []
    for i in range(num):
        li = head + 2 + i
        if li >= len(lines):
            break
        parts = lines[li].split()
        if len(parts) >= 4:
            elements.append(parts[0])
            try:
                positions.append([float(parts[1]), float(parts[2]), float(parts[3])])
            except ValueError:
                positions.append([0.0, 0.0, 0.0])

    return {
        "frame_number": n,
        "elements": elements,
        "positions": positions,
        "comment": comment,
        "properties": _parse_comment(comment),
    }


def _read_xdatcar_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    """Read XDATCAR frame ``n``: seek to its configuration line, read the
    fractional coords, convert to Cartesian with that frame's lattice, and
    return Cartesian positions + the lattice (so the viewer gets the cell).
    """
    n_atoms = idx.n_atoms
    lattice = idx.lattices[n] if n < len(idx.lattices) else (idx.lattices[0] if idx.lattices else None)
    elements = idx.elements

    start = idx.offsets[n]
    # The frame body is the configuration line + n_atoms coord lines; bound the
    # read generously (no coord line exceeds a few dozen bytes).
    end = idx.offsets[n + 1] if n + 1 < len(idx.offsets) else idx.file_size
    with p.open("rb") as fh:
        fh.seek(start)
        raw = fh.read(end - start)
    lines = raw.decode("utf-8", "replace").splitlines()

    # lines[0] is the configuration line; coords start at lines[1].
    # Lattice rows = a,b,c (VASP convention) ⇒ cart = fracᵀ·M summed per row:
    #   cart_k = fa*a_k + fb*b_k + fc*c_k.
    a, b, c = (lattice or [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    positions: list[list[float]] = []
    for k in range(n_atoms):
        li = 1 + k
        if li >= len(lines):
            break
        parts = lines[li].split()
        if len(parts) < 3:
            continue
        try:
            fa, fb, fc = float(parts[0]), float(parts[1]), float(parts[2])
        except ValueError:
            continue
        positions.append([
            fa * a[0] + fb * b[0] + fc * c[0],
            fa * a[1] + fb * b[1] + fc * c[1],
            fa * a[2] + fb * b[2] + fc * c[2],
        ])

    return {
        "frame_number": n,
        "elements": list(elements),
        "positions": positions,
        "lattice": lattice,
        "comment": "",
        "properties": {},
    }


def _parse_comment(comment: str) -> dict[str, float]:
    """Extract numeric plot properties from a frame comment line."""
    props: dict[str, float] = {}
    for key, pat in _META_PATTERNS.items():
        m = pat.search(comment)
        if m:
            try:
                props[key] = float(m.group(1))
            except ValueError:
                pass
    return props


# -----------------------------------------------------------------------------
# Response models
# -----------------------------------------------------------------------------


class IndexResponse(BaseModel):
    ok: bool = True
    total_frames: int
    n_atoms: int
    format: str = "xyz"
    file_size: int


class FramesResponse(BaseModel):
    ok: bool = True
    frames: list[dict[str, Any]]


class MetadataResponse(BaseModel):
    ok: bool = True
    stride: int
    metadata: list[dict[str, Any]]


# -----------------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------------


@router.get("/index", response_model=IndexResponse)
def trajectory_index(path: str = Query(...)) -> IndexResponse:
    """Build (and cache) the frame index for a trajectory; return its shape."""
    p, idx = _get_index(path)
    if idx.total_frames == 0:
        raise HTTPException(status_code=422, detail=f"no frames found in {p.name}")
    return IndexResponse(
        total_frames=idx.total_frames,
        n_atoms=idx.n_atoms,
        format=idx.fmt,
        file_size=idx.file_size,
    )


@router.get("/frames", response_model=FramesResponse)
def trajectory_frames(
    path: str = Query(...),
    start: int = Query(0, ge=0),
    count: int = Query(1, ge=1, le=64),
) -> FramesResponse:
    """Return a contiguous batch of parsed frames ``[start, start+count)``."""
    p, idx = _get_index(path)
    total = idx.total_frames
    if start >= total:
        raise HTTPException(status_code=416, detail=f"start {start} >= total_frames {total}")
    end = min(start + count, total)
    frames = [_read_frame(p, idx, n) for n in range(start, end)]
    logger.info("Streamed frames [%d, %d) of %s", start, end, p.name)
    return FramesResponse(frames=frames)


@router.get("/metadata", response_model=MetadataResponse)
def trajectory_metadata(
    path: str = Query(...),
    stride: int = Query(1, ge=1),
) -> MetadataResponse:
    """Sampled per-frame comment properties for the trajectory plot panel.

    Only the comment line of every ``stride``-th frame is read (two short
    reads per sampled frame), so this stays cheap even for 10k+ frames.
    """
    p, idx = _get_index(path)
    out: list[dict[str, Any]] = []
    if idx.fmt == "xyz":
        # Cheap: only the comment line of every strided frame is read.
        with p.open("rb") as fh:
            for n in range(0, idx.total_frames, stride):
                start, _ = idx.frame_span(n)
                fh.seek(start)
                fh.readline()  # count line
                comment = fh.readline().decode("utf-8", "replace")
                step_m = _STEP_PATTERN.search(comment)
                step = int(step_m.group(1)) if step_m else n
                out.append({"frame_number": n, "step": step, "properties": _parse_comment(comment)})
    else:
        # lammps/traj: derive plot props (energy) from the parsed frame.
        for n in range(0, idx.total_frames, stride):
            frame = _read_frame(p, idx, n)
            out.append({"frame_number": n, "step": n, "properties": frame.get("properties", {})})
    return MetadataResponse(stride=stride, metadata=out)


@router.post("/upload")
async def trajectory_upload(file: UploadFile = File(...)) -> dict:
    """Cache an uploaded trajectory to disk and index it, then stream frames.

    The web (non-Tauri) drop / file-picker yields a browser ``File`` with no
    filesystem path, so the streamer can't read it in place. We stream the
    upload to a backend-local cache file (content-hashed → dedup), index it, and
    return the local path the frame endpoints read — the webview never holds the
    whole file. The upload itself is a one-time localhost transfer.
    """
    cache_dir = Path.home() / ".catgoat" / "cache" / "traj"
    cache_dir.mkdir(parents=True, exist_ok=True)
    orig_name = file.filename or "upload.xyz"
    # The cached filename drives _detect_format. VASP XDATCAR has no extension,
    # so preserve an "xdatcar" marker in the suffix; otherwise keep the real
    # extension (defaulting to .xyz).
    if "xdatcar" in orig_name.lower():
        ext = ".xdatcar"
    else:
        ext = os.path.splitext(orig_name)[1] or ".xyz"

    tmp = cache_dir / f".upload-{os.getpid()}-{id(file)}{ext}.part"
    sha = hashlib.sha1()
    size = 0
    try:
        with tmp.open("wb") as fh:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
                sha.update(chunk)
                size += len(chunk)
        local = cache_dir / f"{sha.hexdigest()[:16]}{ext}"
        if local.is_file() and local.stat().st_size == size:
            tmp.unlink(missing_ok=True)  # identical content already cached
        else:
            tmp.replace(local)
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"upload failed: {exc}") from exc

    try:
        _, idx = _get_index(str(local))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"index failed: {exc}") from exc
    logger.info("Uploaded trajectory %s -> %s (%d frames)", file.filename, local.name, idx.total_frames)
    return {
        "ok": True,
        "local_path": str(local),
        "total_frames": idx.total_frames,
        "n_atoms": idx.n_atoms,
        "file_size": idx.file_size,
    }
