"""Streaming loader for large, file-backed atomistic trajectories.

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
re-open is instant and edits invalidate automatically. Text formats follow the
same architecture as OVITO's importers: record frame boundaries during one
binary pass, then seek to and parse only the requested frame. Memory held per
file is proportional to the number of frames, never the file size.
"""

from __future__ import annotations

import logging
import hashlib
import os
import re
import struct
import threading
import bz2
import gzip
import lzma
import json
import mmap
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
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

    __slots__ = (
        "fmt",
        "offsets",
        "file_size",
        "n_atoms",
        "_total",
        "elements",
        "lattices",
        "aux",
    )

    def __init__(
        self,
        fmt: str,
        offsets: list[int],
        file_size: int,
        n_atoms: int,
        total: int | None = None,
        elements: list[str] | None = None,
        lattices: list[list[list[float]]] | None = None,
        aux: dict[str, Any] | None = None,
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
        # Format-specific compact index data (dataset paths, lattice offsets,
        # Gaussian IRC ordering, ...). Never store complete trajectory text.
        self.aux = aux or {}

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
    """Map a filename (with a small content sniff fallback) to a reader."""
    name = p.name.lower()
    suffix = p.suffix.lower()
    if suffix in {".dump", ".lammpstrj"}:
        return "lammpstrj"
    if suffix == ".traj":
        return "traj"
    if suffix in {".h5", ".hdf5"}:
        return "hdf5"
    if suffix == ".json":
        return "json"
    # VASP XDATCAR usually has no extension; match by name (XDATCAR,
    # XDATCAR.bz2 already decompressed, my_run.XDATCAR, ...).
    if "xdatcar" in name:
        return "xdatcar"
    if "outcar" in name:
        return "outcar"
    if "vasprun" in name and suffix == ".xml":
        return "vasprun"
    # Extension-less simulation outputs are common. Inspect only a small
    # prefix; this does not compromise the bounded-memory contract.
    try:
        with p.open("rb") as fh:
            prefix = fh.read(128 * 1024)
    except OSError:
        prefix = b""
    if suffix in {".out", ".log"}:
        if b"CARTESIAN COORDINATES (ANGSTROEM)" in prefix or b"O   R   C   A" in prefix:
            return "orca"
        return "gaussian"
    if b"ITEM: TIMESTEP" in prefix:
        return "lammpstrj"
    if b"<modeling" in prefix or b"<calculation" in prefix:
        return "vasprun"
    if b"direct lattice vectors" in prefix and b"TOTAL-FORCE" in prefix:
        return "outcar"
    if b"Gaussian, Inc." in prefix or b"Entering Gaussian System" in prefix:
        return "gaussian"
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


def _cache_name_for_trajectory(key: str, original_name: str) -> str:
    """Keep format-significant basenames when materializing an upload."""
    lower = Path(original_name).name.lower()
    for compressed_suffix in (".gz", ".gzip", ".bz2", ".xz"):
        if lower.endswith(compressed_suffix):
            inner = original_name[: -len(compressed_suffix)]
            return _cache_name_for_trajectory(key, inner) + compressed_suffix
    if "xdatcar" in lower:
        return f"{key}.xdatcar"
    if "outcar" in lower:
        return f"{key}.outcar"
    if "vasprun" in lower and lower.endswith(".xml"):
        return f"{key}.vasprun.xml"
    suffix = Path(original_name).suffix or ".xyz"
    return f"{key}{suffix}"


def _materialize_compressed_trajectory(p: Path) -> Path:
    """Inflate a compressed trajectory once to a content-addressed cache file.

    gzip/bzip2/xz streams are not seekable by frame. Like OVITO, CatGo pays a
    one-time sequential decompression cost, then all indexing and playback use
    the normal random-access reader on the cached uncompressed file.
    """
    suffix = p.suffix.lower()
    openers = {
        ".gz": gzip.open,
        ".gzip": gzip.open,
        ".bz2": bz2.open,
        ".xz": lzma.open,
    }
    opener = openers.get(suffix)
    if opener is None:
        return p
    stat = p.stat()
    digest = hashlib.sha1(
        f"{p.resolve()}\0{stat.st_mtime_ns}\0{stat.st_size}".encode()
    ).hexdigest()[:16]
    inner_name = p.name[: -len(suffix)]
    cache_dir = Path.home() / ".catgoat" / "cache" / "traj" / "inflated"
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / _cache_name_for_trajectory(digest, inner_name)
    if target.is_file() and target.stat().st_size > 0:
        return target
    tmp = target.with_name(target.name + f".{os.getpid()}.part")
    try:
        with opener(p, "rb") as source, tmp.open("wb") as output:
            while chunk := source.read(4 * 1024 * 1024):
                output.write(chunk)
        tmp.replace(target)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return target


def _build_xyz_index(p: Path) -> _TrajIndex:
    """Single binary pass building per-frame byte offsets (no content kept)."""
    offsets: list[int] = []
    n_atoms = 0
    elements: list[str] = []
    frame_atom_counts: list[int] = []
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
            first_frame = not n_atoms
            if first_frame:
                n_atoms = num
            complete = fh.readline() != b""  # comment line
            for _ in range(num):
                atom_line = fh.readline()
                if not atom_line:
                    complete = False
                    break
                if first_frame:
                    parts = atom_line.split(maxsplit=1)
                    elements.append(
                        parts[0].decode("utf-8", "replace") if parts else "X"
                    )
            if not complete:
                break  # truncated final frame — drop it
            offsets.append(frame_start)
            frame_atom_counts.append(num)

    file_size = p.stat().st_size
    return _TrajIndex(
        "xyz",
        offsets,
        file_size,
        n_atoms,
        elements=elements,
        aux={
            "frame_atom_counts": frame_atom_counts,
            "variable_topology": any(count != n_atoms for count in frame_atom_counts),
        },
    )


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
        first = traj[0] if total else None
        n_atoms = len(first) if first is not None else 0
        elements = list(first.get_chemical_symbols()) if first is not None else []
    finally:
        traj.close()
    return _TrajIndex(
        "traj", [], p.stat().st_size, n_atoms, total=total, elements=elements
    )


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
    offsets: list[int] = []
    lattices: list[list[list[float]]] = []
    cur_lattice: list[list[float]] | None = None
    elements: list[str] = []
    # Seven decoded lines are enough to recognize either the initial VASP
    # header or an NPT header repeated immediately before a configuration.
    # Coordinates are never retained and the complete file is never decoded.
    header_window: list[str] = []
    with p.open("rb") as fh:
        while True:
            byte_offset = fh.tell()
            raw = fh.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if "configuration=" in line:
                if cur_lattice is None or not elements:
                    raise HTTPException(status_code=400, detail="XDATCAR: bad header")
                offsets.append(byte_offset)
                lattices.append([row[:] for row in cur_lattice])
                continue

            header_window.append(line)
            if len(header_window) > 7:
                del header_window[0]
            if len(header_window) == 7:
                parsed = _parse_xdatcar_header(header_window, 0)
                if parsed is not None:
                    cur_lattice, elements, _ = parsed

    if not offsets:
        raise HTTPException(status_code=422, detail="XDATCAR: no configurations found")

    file_size = p.stat().st_size
    return _TrajIndex(
        "xdatcar", offsets, file_size, len(elements),
        elements=elements, lattices=lattices,
    )


def _read_text_span(p: Path, start: int, end: int) -> str:
    """Decode one bounded byte range without materializing the whole file."""
    with p.open("rb") as fh:
        fh.seek(max(0, start))
        return fh.read(max(0, end - start)).decode("utf-8", "replace")


def _scan_byte_marker_offsets(p: Path, marker: bytes) -> list[int]:
    """Find a raw marker in one binary pass, including chunk boundaries."""
    offsets: list[int] = []
    chunk_size = 8 * 1024 * 1024
    overlap = b""
    file_pos = 0
    last = -1
    with p.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            combined = overlap + chunk
            base = file_pos - len(overlap)
            cursor = 0
            while True:
                found = combined.find(marker, cursor)
                if found < 0:
                    break
                absolute = base + found
                if absolute > last:
                    offsets.append(absolute)
                    last = absolute
                cursor = found + len(marker)
            overlap = combined[-(len(marker) - 1):] if len(marker) > 1 else b""
            file_pos += len(chunk)
    return offsets


def _build_outcar_index(p: Path) -> _TrajIndex:
    """Index VASP OUTCAR ionic steps and the cell active at every step."""
    offsets: list[int] = []
    lattice_offsets: list[int | None] = []
    latest_lattice: int | None = None
    species: list[str] = []
    counts: list[int] = []
    with p.open("rb") as fh:
        while True:
            byte_offset = fh.tell()
            raw = fh.readline()
            if not raw:
                break
            if b"direct lattice vectors" in raw:
                latest_lattice = byte_offset
            if b"POSITION" in raw and b"TOTAL-FORCE" in raw:
                offsets.append(byte_offset)
                lattice_offsets.append(latest_lattice)
            if b"VRHFIN" in raw:
                match = re.search(rb"VRHFIN\s*=\s*([A-Za-z]+)", raw)
                if match:
                    symbol = match.group(1).decode("ascii", "replace")
                    if symbol not in species:
                        species.append(symbol)
            if b"ions per type" in raw:
                tail = raw.split(b"=", 1)[-1]
                try:
                    counts = [int(value) for value in tail.split()]
                except ValueError:
                    counts = []
    if not offsets:
        raise HTTPException(status_code=422, detail="OUTCAR: no ionic steps found")
    if not species or len(species) != len(counts):
        # POTCAR lines are a useful fallback for compact/test OUTCAR files.
        prefix = _read_text_span(p, 0, min(offsets[0], 8 * 1024 * 1024))
        species = []
        for match in re.finditer(r"^\s*POTCAR:\s+\S+\s+([A-Za-z]+)", prefix, re.M):
            if match.group(1) not in species:
                species.append(match.group(1))
    if not species or len(species) != len(counts):
        raise HTTPException(status_code=422, detail="OUTCAR: could not determine elements")
    elements = [symbol for symbol, count in zip(species, counts) for _ in range(count)]
    return _TrajIndex(
        "outcar",
        offsets,
        p.stat().st_size,
        len(elements),
        elements=elements,
        aux={"lattice_offsets": lattice_offsets},
    )


def _parse_vasprun_elements(prefix: str) -> list[str]:
    atoms_match = re.search(
        r"<array\b[^>]*name\s*=\s*['\"]atoms['\"][^>]*>([\s\S]*?)</array>",
        prefix,
        re.I,
    )
    if not atoms_match:
        return []
    return [
        match.group(1)
        for match in re.finditer(
            r"<rc\b[^>]*>\s*<c\b[^>]*>\s*([^<\s]+)",
            atoms_match.group(1),
            re.I,
        )
    ]


def _build_vasprun_index(p: Path) -> _TrajIndex:
    offsets = _scan_byte_marker_offsets(p, b"<calculation")
    if not offsets:
        raise HTTPException(status_code=422, detail="vasprun.xml: no calculations found")
    prefix = _read_text_span(p, 0, min(offsets[0], 16 * 1024 * 1024))
    elements = _parse_vasprun_elements(prefix)
    if not elements:
        raise HTTPException(status_code=422, detail="vasprun.xml: no atom elements")
    return _TrajIndex(
        "vasprun", offsets, p.stat().st_size, len(elements), elements=elements
    )


def _build_gaussian_index(p: Path) -> _TrajIndex:
    standard: list[int] = []
    input_orientation: list[int] = []
    with p.open("rb") as fh:
        while True:
            byte_offset = fh.tell()
            raw = fh.readline()
            if not raw:
                break
            if b"Standard orientation:" in raw:
                standard.append(byte_offset)
            elif b"Input orientation:" in raw:
                input_orientation.append(byte_offset)
    offsets = standard or input_orientation
    if not offsets:
        raise HTTPException(status_code=422, detail="Gaussian output: no geometries")
    probe_end = offsets[1] if len(offsets) > 1 else p.stat().st_size
    numbers, _positions = _parse_gaussian_orientation(
        _read_text_span(p, offsets[0], min(probe_end, offsets[0] + 32 * 1024 * 1024))
    )
    if not numbers:
        raise HTTPException(status_code=422, detail="Gaussian output: invalid geometry")
    from ase.data import chemical_symbols

    elements = [chemical_symbols[number] if 0 < number < len(chemical_symbols) else "X" for number in numbers]
    return _TrajIndex(
        "gaussian", offsets, p.stat().st_size, len(elements), elements=elements
    )


def _build_orca_index(p: Path) -> _TrajIndex:
    offsets: list[int] = []
    with p.open("rb") as fh:
        while True:
            byte_offset = fh.tell()
            raw = fh.readline()
            if not raw:
                break
            if b"CARTESIAN COORDINATES (ANGSTROEM)" in raw:
                offsets.append(byte_offset)
    if not offsets:
        raise HTTPException(status_code=422, detail="ORCA output: no Cartesian geometries")
    probe_end = offsets[1] if len(offsets) > 1 else p.stat().st_size
    elements, _ = _parse_orca_output_geometry(
        _read_text_span(p, offsets[0], min(probe_end, offsets[0] + 16 * 1024 * 1024))
    )
    if not elements:
        raise HTTPException(status_code=422, detail="ORCA output: invalid geometry")
    return _TrajIndex("orca", offsets, p.stat().st_size, len(elements), elements=elements)


def _find_hdf5_datasets(handle: Any) -> dict[str, str]:
    """Return the first recursively encountered path for known dataset names."""
    wanted = {
        "positions", "position_ions", "atomic_numbers", "numbers", "Z",
        "species", "ion_types", "number_ion_types", "cell", "cells",
        "lattice", "lattice_vectors", "potential_energy", "energy",
        "energies", "forces", "force", "direct_coordinates",
    }
    found: dict[str, str] = {}

    def visit(path: str, item: Any) -> None:
        if hasattr(item, "shape"):
            base = path.rsplit("/", 1)[-1]
            if base in wanted and base not in found:
                found[base] = path

    handle.visititems(visit)
    return found


def _first_dataset_path(found: dict[str, str], names: tuple[str, ...]) -> str | None:
    return next((found[name] for name in names if name in found), None)


def _numbers_to_elements(values: Any, n_atoms: int) -> list[str]:
    import numpy as np
    from ase.data import chemical_symbols

    flat = np.asarray(values).reshape(-1)
    if flat.size != n_atoms:
        return ["X"] * n_atoms
    if flat.dtype.kind in {"S", "U", "O"}:
        return [
            value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
            for value in flat
        ]
    return [
        chemical_symbols[int(value)] if 0 < int(value) < len(chemical_symbols) else "X"
        for value in flat
    ]


def _build_hdf5_index(p: Path) -> _TrajIndex:
    import h5py

    with h5py.File(p, "r") as handle:
        found = _find_hdf5_datasets(handle)
        vasp_group = "intermediate/ion_dynamics"
        positions_path = (
            f"{vasp_group}/position_ions"
            if f"{vasp_group}/position_ions" in handle
            else _first_dataset_path(found, ("positions", "position_ions"))
        )
        if positions_path is None:
            raise HTTPException(status_code=422, detail="HDF5: positions dataset missing")
        shape = handle[positions_path].shape
        if len(shape) not in {2, 3} or shape[-1] != 3:
            raise HTTPException(status_code=422, detail=f"HDF5: invalid positions shape {shape}")
        total = int(shape[0]) if len(shape) == 3 else 1
        n_atoms = int(shape[-2])
        numbers_path = _first_dataset_path(found, ("atomic_numbers", "numbers", "Z", "species"))
        if numbers_path:
            numbers_ds = handle[numbers_path]
            values = numbers_ds[0] if numbers_ds.ndim > 1 else numbers_ds[...]
            elements = _numbers_to_elements(values, n_atoms)
        elif "input/poscar/ion_types" in handle and "input/poscar/number_ion_types" in handle:
            raw_types = handle["input/poscar/ion_types"][...]
            raw_counts = handle["input/poscar/number_ion_types"][...]
            types = [
                value.decode("utf-8", "replace").strip() if isinstance(value, bytes) else str(value).strip()
                for value in raw_types.reshape(-1)
            ]
            counts = [int(value) for value in raw_counts.reshape(-1)]
            elements = [symbol for symbol, count in zip(types, counts) for _ in range(count)]
            if len(elements) != n_atoms:
                elements = ["X"] * n_atoms
        else:
            elements = ["X"] * n_atoms
        aux = {
            "positions": positions_path,
            "numbers": numbers_path,
            "cells": (
                f"{vasp_group}/lattice_vectors"
                if f"{vasp_group}/lattice_vectors" in handle
                else _first_dataset_path(found, ("cell", "cells", "lattice", "lattice_vectors"))
            ),
            "energies": (
                f"{vasp_group}/energies"
                if f"{vasp_group}/energies" in handle
                else _first_dataset_path(found, ("potential_energy", "energy", "energies"))
            ),
            "forces": (
                f"{vasp_group}/forces"
                if f"{vasp_group}/forces" in handle
                else _first_dataset_path(found, ("forces", "force"))
            ),
            "direct_positions": positions_path.endswith("/position_ions"),
        }
    return _TrajIndex(
        "hdf5", [], p.stat().st_size, n_atoms, total=total, elements=elements, aux=aux
    )


def _json_skip_ws(data: Any, pos: int) -> int:
    while pos < len(data) and data[pos] in b" \t\r\n":
        pos += 1
    return pos


def _json_value_end(data: Any, start: int) -> int:
    """Return the exclusive end of one JSON value in an mmap-like byte view."""
    start = _json_skip_ws(data, start)
    if start >= len(data):
        raise ValueError("truncated JSON value")
    first = data[start]
    if first == ord('"'):
        escaped = False
        pos = start + 1
        while pos < len(data):
            byte = data[pos]
            if byte == ord('"') and not escaped:
                return pos + 1
            if byte == ord('\\') and not escaped:
                escaped = True
            else:
                escaped = False
            pos += 1
        raise ValueError("unterminated JSON string")
    if first in (ord("["), ord("{")):
        stack = [first]
        in_string = False
        escaped = False
        pos = start + 1
        while pos < len(data):
            byte = data[pos]
            if in_string:
                if byte == ord('"') and not escaped:
                    in_string = False
                if byte == ord('\\') and not escaped:
                    escaped = True
                else:
                    escaped = False
            elif byte == ord('"'):
                in_string = True
            elif byte in (ord("["), ord("{")):
                stack.append(byte)
            elif byte in (ord("]"), ord("}")):
                expected = ord("[") if byte == ord("]") else ord("{")
                if not stack or stack[-1] != expected:
                    raise ValueError("unbalanced JSON")
                stack.pop()
                if not stack:
                    return pos + 1
            pos += 1
        raise ValueError("unterminated JSON container")
    pos = start
    while pos < len(data) and data[pos] not in b",]} \t\r\n":
        pos += 1
    return pos


def _json_array_spans(data: Any, array_start: int) -> list[tuple[int, int]]:
    if data[array_start] != ord("["):
        raise ValueError("JSON trajectory field is not an array")
    spans: list[tuple[int, int]] = []
    pos = array_start + 1
    while True:
        pos = _json_skip_ws(data, pos)
        if pos >= len(data):
            raise ValueError("unterminated JSON array")
        if data[pos] == ord("]"):
            return spans
        start = pos
        end = _json_value_end(data, start)
        spans.append((start, end))
        pos = _json_skip_ws(data, end)
        if pos < len(data) and data[pos] == ord(","):
            pos += 1
            continue
        if pos < len(data) and data[pos] == ord("]"):
            return spans
        raise ValueError("invalid JSON array separator")


def _json_named_value_span(data: Any, name: str) -> tuple[int, int] | None:
    marker = json.dumps(name).encode()
    cursor = 0
    while True:
        found = data.find(marker, cursor)
        if found < 0:
            return None
        colon = _json_skip_ws(data, found + len(marker))
        if colon < len(data) and data[colon] == ord(":"):
            start = _json_skip_ws(data, colon + 1)
            try:
                return start, _json_value_end(data, start)
            except ValueError:
                return None
        cursor = found + len(marker)


def _json_load_span(data: Any, span: tuple[int, int]) -> Any:
    return json.loads(bytes(data[span[0]:span[1]]))


def _json_structure_frame(raw: Any, frame_number: int) -> dict[str, Any]:
    frame_obj = raw if isinstance(raw, dict) else {}
    structure = frame_obj.get("structure", frame_obj)
    if not isinstance(structure, dict):
        raise ValueError("JSON frame has no structure")
    sites = structure.get("sites")
    if not isinstance(sites, list):
        # Lightweight generic frame schema.
        positions = frame_obj.get("positions")
        elements = frame_obj.get("elements")
        if isinstance(positions, list) and isinstance(elements, list):
            return {
                "frame_number": frame_number,
                "elements": elements,
                "positions": positions,
                "lattice": frame_obj.get("lattice"),
                "properties": frame_obj.get("metadata", {}),
                "comment": "",
            }
        raise ValueError("JSON frame has no sites")
    lattice_obj = structure.get("lattice")
    lattice = lattice_obj.get("matrix") if isinstance(lattice_obj, dict) else None
    elements: list[str] = []
    positions: list[list[float]] = []
    forces: list[list[float]] = []
    for site in sites:
        if not isinstance(site, dict):
            continue
        species = site.get("species")
        element = None
        if isinstance(species, list) and species and isinstance(species[0], dict):
            element = species[0].get("element")
        element = element or site.get("label") or "X"
        xyz = site.get("xyz")
        if not isinstance(xyz, list) and isinstance(site.get("abc"), list) and lattice:
            abc = site["abc"]
            xyz = [sum(float(abc[row]) * float(lattice[row][axis]) for row in range(3)) for axis in range(3)]
        if not isinstance(xyz, list) or len(xyz) < 3:
            continue
        elements.append(str(element))
        positions.append([float(value) for value in xyz[:3]])
        force = site.get("properties", {}).get("force") if isinstance(site.get("properties"), dict) else None
        if isinstance(force, list) and len(force) >= 3:
            forces.append([float(value) for value in force[:3]])
    metadata = frame_obj.get("metadata") if isinstance(frame_obj.get("metadata"), dict) else {}
    frame: dict[str, Any] = {
        "frame_number": frame_number,
        "elements": elements,
        "positions": positions,
        "comment": "",
        "properties": metadata,
    }
    if lattice:
        frame["lattice"] = lattice
    if len(forces) == len(positions):
        frame["forces"] = forces
    return frame


def _build_json_index(p: Path) -> _TrajIndex:
    with p.open("rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as data:
        root = _json_skip_ws(data, 0)
        if root >= len(data):
            raise HTTPException(status_code=422, detail="JSON trajectory is empty")
        mode = "frames"
        if data[root] == ord("["):
            array_start = root
        else:
            frames_span = _json_named_value_span(data, "frames")
            coords_span = _json_named_value_span(data, "coords")
            if frames_span and data[frames_span[0]] == ord("["):
                array_start = frames_span[0]
            elif coords_span and data[coords_span[0]] == ord("["):
                array_start = coords_span[0]
                mode = "coords"
            else:
                raise HTTPException(status_code=422, detail="JSON: no frame array")
        spans = _json_array_spans(data, array_start)
        if not spans:
            raise HTTPException(status_code=422, detail="JSON: no frames")
        aux: dict[str, Any] = {
            "ends": [end for _, end in spans],
            "json_mode": mode,
        }
        if mode == "coords":
            species_span = _json_named_value_span(data, "species")
            lattice_span = _json_named_value_span(data, "lattice")
            if not species_span or not lattice_span:
                raise HTTPException(status_code=422, detail="pymatgen JSON: species/lattice missing")
            species = _json_load_span(data, species_span)
            lattice = _json_load_span(data, lattice_span)
            elements = [
                str(item.get("element", "X")) if isinstance(item, dict) else str(item)
                for item in species
            ]
            aux["lattice"] = lattice
        else:
            first = _json_structure_frame(_json_load_span(data, spans[0]), 0)
            elements = first["elements"]
            aux["variable_topology"] = True
    return _TrajIndex(
        "json",
        [start for start, _ in spans],
        p.stat().st_size,
        len(elements),
        elements=elements,
        aux=aux,
    )


def _get_index(path: str) -> tuple[Path, _TrajIndex]:
    """Return the cached index for ``path``, building it on first access."""
    p = _resolve_path(path)
    p = _materialize_compressed_trajectory(p)
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
        elif fmt == "outcar":
            idx = _build_outcar_index(p)
        elif fmt == "vasprun":
            idx = _build_vasprun_index(p)
        elif fmt == "gaussian":
            idx = _build_gaussian_index(p)
        elif fmt == "orca":
            idx = _build_orca_index(p)
        elif fmt == "hdf5":
            idx = _build_hdf5_index(p)
        elif fmt == "json":
            idx = _build_json_index(p)
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
    if idx.fmt == "outcar":
        return _read_outcar_frame(p, idx, n)
    if idx.fmt == "vasprun":
        return _read_vasprun_frame(p, idx, n)
    if idx.fmt == "gaussian":
        return _read_gaussian_frame(p, idx, n)
    if idx.fmt == "orca":
        return _read_orca_frame(p, idx, n)
    if idx.fmt == "hdf5":
        return _read_hdf5_frame(p, idx, n)
    if idx.fmt == "json":
        return _read_json_frame(p, idx, n)
    return _read_xyz_frame(p, idx, n)


def _atoms_to_frame(n: int, atoms: Any) -> dict[str, Any]:
    """Convert an ASE ``Atoms`` to the wire frame shape (+ energy if present)."""
    props: dict[str, float] = {}
    try:
        props["energy"] = float(atoms.get_potential_energy())
    except Exception:
        pass
    frame: dict[str, Any] = {
        "frame_number": n,
        "elements": list(atoms.get_chemical_symbols()),
        "positions": atoms.get_positions().tolist(),
        "comment": "",
        "properties": props,
    }
    # Periodic frames must carry their cell. Without it the viewer builds a
    # lattice-less structure, ferrox-wasm falls back to pbc=[F,F,F] brute-force
    # neighbor search, and a 20k-atom .traj frame takes ~4s instead of ~0.1s
    # per bond pass (and cross-cell bonds are wrong). ASE .traj and LAMMPS
    # dump frames both land here; XDATCAR has its own reader that already
    # emits `lattice`.
    try:
        if getattr(atoms, "pbc", None) is not None and atoms.pbc.any():
            cell = atoms.get_cell()
            if cell is not None and abs(float(cell.volume)) > 1e-9:
                frame["lattice"] = [list(map(float, row)) for row in cell]
    except Exception:
        pass
    return frame


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
    species_col, position_col, force_col = _extxyz_columns(comment)
    elements: list[str] = []
    positions: list[list[float]] = []
    forces: list[list[float]] = []
    for i in range(num):
        li = head + 2 + i
        if li >= len(lines):
            break
        parts = lines[li].split()
        needed = position_col + 3
        if len(parts) >= needed:
            elements.append(parts[species_col] if species_col < len(parts) else "X")
            try:
                positions.append([float(value) for value in parts[position_col:position_col + 3]])
                if force_col is not None and len(parts) >= force_col + 3:
                    forces.append([float(value) for value in parts[force_col:force_col + 3]])
            except ValueError:
                positions.append([0.0, 0.0, 0.0])

    frame: dict[str, Any] = {
        "frame_number": n,
        "elements": elements,
        "positions": positions,
        "comment": comment,
        "properties": _parse_comment(comment),
    }
    lattice_match = re.search(r'\bLattice\s*=\s*"([^"]+)"', comment, re.I)
    if lattice_match:
        try:
            values = [float(value) for value in lattice_match.group(1).split()]
            if len(values) == 9:
                frame["lattice"] = [values[0:3], values[3:6], values[6:9]]
        except ValueError:
            pass
    if len(forces) == len(positions):
        frame["forces"] = forces
    return frame


def _extxyz_columns(comment: str) -> tuple[int, int, int | None]:
    """Resolve species/position/force columns from an extXYZ Properties schema."""
    schema_match = re.search(r"\bProperties\s*=\s*([^\s]+)", comment, re.I)
    if not schema_match:
        return 0, 1, None
    fields = schema_match.group(1).split(":")
    cursor = 0
    species_col = 0
    position_col = 1
    force_col: int | None = None
    for idx_field in range(0, len(fields) - 2, 3):
        name = fields[idx_field].lower()
        try:
            width = int(fields[idx_field + 2])
        except ValueError:
            break
        if name in {"species", "element", "symbol"}:
            species_col = cursor
        elif name in {"pos", "position", "positions"}:
            position_col = cursor
        elif name in {"force", "forces"}:
            force_col = cursor
        cursor += max(0, width)
    return species_col, position_col, force_col


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


def _cell_volume(lattice: list[list[float]]) -> float:
    a, b, c = lattice
    return abs(
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )


def _read_outcar_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    start, end = idx.frame_span(n)
    max_end = min(end, start + max(16 * 1024 * 1024, idx.n_atoms * 256 + 4 * 1024 * 1024))
    text = _read_text_span(p, start, max_end)
    lattice_offsets = idx.aux.get("lattice_offsets", [])
    lattice_offset = lattice_offsets[n] if n < len(lattice_offsets) else None
    if lattice_offset is None:
        raise HTTPException(status_code=422, detail=f"OUTCAR frame {n}: lattice missing")
    lattice_text = _read_text_span(p, lattice_offset, min(idx.file_size, lattice_offset + 4096))
    lattice_lines = lattice_text.splitlines()[1:4]
    try:
        lattice = [[float(value) for value in line.split()[:3]] for line in lattice_lines]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"OUTCAR frame {n}: bad lattice") from exc
    if len(lattice) != 3 or any(len(row) != 3 for row in lattice):
        raise HTTPException(status_code=422, detail=f"OUTCAR frame {n}: bad lattice")

    positions: list[list[float]] = []
    forces: list[list[float]] = []
    for line in text.splitlines()[1:]:
        values = line.split()
        if len(values) < 6:
            continue
        try:
            numeric = [float(value) for value in values[:6]]
        except ValueError:
            continue
        positions.append(numeric[:3])
        forces.append(numeric[3:6])
        if len(positions) == idx.n_atoms:
            break
    if len(positions) != idx.n_atoms:
        raise HTTPException(
            status_code=422,
            detail=f"OUTCAR frame {n}: expected {idx.n_atoms} atoms, got {len(positions)}",
        )
    sigma = re.search(r"energy\(sigma->0\)\s*=\s*([-\d.eE+]+)", text)
    toten = re.search(r"free\s+energy\s+TOTEN\s*=\s*([-\d.eE+]+)", text)
    properties: dict[str, float] = {"volume": _cell_volume(lattice)}
    try:
        properties["energy"] = float((sigma or toten).group(1)) if (sigma or toten) else 0.0
    except ValueError:
        pass
    if properties.get("energy") == 0.0 and not (sigma or toten):
        properties.pop("energy", None)
    return {
        "frame_number": n,
        "elements": list(idx.elements),
        "positions": positions,
        "forces": forces,
        "lattice": lattice,
        "comment": "",
        "properties": properties,
    }


def _extract_vasprun_varray(content: str, name: str) -> list[list[float]]:
    body_match = re.search(
        rf"<varray\b[^>]*name\s*=\s*['\"]{re.escape(name)}['\"][^>]*>([\s\S]*?)</varray>",
        content,
        re.I,
    )
    if not body_match:
        return []
    rows: list[list[float]] = []
    for match in re.finditer(r"<v\b[^>]*>([\s\S]*?)</v>", body_match.group(1), re.I):
        try:
            values = [float(value) for value in match.group(1).split()]
        except ValueError:
            continue
        if values:
            rows.append(values)
    return rows


def _extract_vasprun_energy(content: str) -> float | None:
    energy_match = re.search(r"<energy\b[^>]*>([\s\S]*?)</energy>", content, re.I)
    if not energy_match:
        return None
    for name in ("e_fr_energy", "e_0_energy", "e_wo_entrp"):
        match = re.search(
            rf"<i\b[^>]*name\s*=\s*['\"]{name}['\"][^>]*>\s*([^<\s]+)",
            energy_match.group(1),
            re.I,
        )
        try:
            return float(match.group(1)) if match else None
        except ValueError:
            continue
    return None


def _read_vasprun_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    start, end = idx.frame_span(n)
    raw = _read_text_span(p, start, end)
    close = raw.find("</calculation>")
    calculation = raw[: close + len("</calculation>")] if close >= 0 else raw
    lattice = _extract_vasprun_varray(calculation, "basis")
    fractional = _extract_vasprun_varray(calculation, "positions")
    if len(lattice) != 3 or len(fractional) != idx.n_atoms:
        raise HTTPException(status_code=422, detail=f"vasprun.xml frame {n}: invalid structure")
    positions = [
        [
            frac[0] * lattice[0][axis]
            + frac[1] * lattice[1][axis]
            + frac[2] * lattice[2][axis]
            for axis in range(3)
        ]
        for frac in fractional
    ]
    forces = _extract_vasprun_varray(calculation, "forces")
    if len(forces) != idx.n_atoms:
        forces = []
    properties: dict[str, float] = {"volume": _cell_volume(lattice)}
    energy = _extract_vasprun_energy(calculation)
    if energy is not None:
        properties["energy"] = energy
    frame: dict[str, Any] = {
        "frame_number": n,
        "elements": list(idx.elements),
        "positions": positions,
        "lattice": lattice,
        "comment": "",
        "properties": properties,
    }
    if forces:
        frame["forces"] = forces
    return frame


_GAUSSIAN_ORIENTATION_ROW = re.compile(
    r"^\s*\d+\s+(\d+)\s+\d+\s+"
    r"([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*$",
    re.M,
)


def _parse_gaussian_orientation(content: str) -> tuple[list[int], list[list[float]]]:
    numbers: list[int] = []
    positions: list[list[float]] = []
    for match in _GAUSSIAN_ORIENTATION_ROW.finditer(content):
        try:
            numbers.append(int(match.group(1)))
            positions.append([float(match.group(i)) for i in range(2, 5)])
        except ValueError:
            continue
    return numbers, positions


def _read_gaussian_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    start, end = idx.frame_span(n)
    text = _read_text_span(p, start, min(end, start + 32 * 1024 * 1024))
    numbers, positions = _parse_gaussian_orientation(text)
    if len(positions) != idx.n_atoms:
        raise HTTPException(status_code=422, detail=f"Gaussian frame {n}: invalid geometry")
    energy_match = re.search(r"SCF Done:\s+E\([^)]*\)\s*=\s*([-+\d.eE]+)", text)
    properties: dict[str, float] = {}
    if energy_match:
        try:
            properties["energy"] = float(energy_match.group(1))
        except ValueError:
            pass
    return {
        "frame_number": n,
        "elements": list(idx.elements),
        "positions": positions,
        "comment": "",
        "properties": properties,
    }


_ORCA_COORD_ROW = re.compile(
    r"^\s*([A-Z][a-z]?)\s+([-+\d.eEdD]+)\s+([-+\d.eEdD]+)\s+([-+\d.eEdD]+)(?:\s|$)",
    re.M,
)


def _parse_orca_output_geometry(content: str) -> tuple[list[str], list[list[float]]]:
    elements: list[str] = []
    positions: list[list[float]] = []
    started = False
    for line in content.splitlines()[1:]:
        match = _ORCA_COORD_ROW.match(line)
        if not match:
            if started:
                break
            continue
        started = True
        try:
            xyz = [float(match.group(axis).replace("D", "E").replace("d", "e")) for axis in range(2, 5)]
        except ValueError:
            continue
        elements.append(match.group(1))
        positions.append(xyz)
    return elements, positions


def _read_orca_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    start, end = idx.frame_span(n)
    text = _read_text_span(p, start, min(end, start + 16 * 1024 * 1024))
    elements, positions = _parse_orca_output_geometry(text)
    if len(positions) != idx.n_atoms:
        raise HTTPException(status_code=422, detail=f"ORCA frame {n}: invalid geometry")
    energy_match = re.search(r"FINAL SINGLE POINT ENERGY\s+([-+\d.eEdD]+)", text)
    properties: dict[str, float] = {}
    if energy_match:
        try:
            properties["energy"] = float(
                energy_match.group(1).replace("D", "E").replace("d", "e")
            )
        except ValueError:
            pass
    return {
        "frame_number": n,
        "elements": elements,
        "positions": positions,
        "comment": "",
        "properties": properties,
    }


def _read_hdf5_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    import h5py
    import numpy as np

    with h5py.File(p, "r") as handle:
        positions_ds = handle[idx.aux["positions"]]
        positions = positions_ds[n] if positions_ds.ndim == 3 else positions_ds[...]
        positions_array = np.asarray(positions, dtype=float).reshape(-1, 3)
        if positions_array.shape[0] != idx.n_atoms:
            raise HTTPException(status_code=422, detail=f"HDF5 frame {n}: invalid positions")
        elements = list(idx.elements)
        numbers_path = idx.aux.get("numbers")
        if numbers_path:
            numbers_ds = handle[numbers_path]
            numbers = numbers_ds[0 if numbers_ds.shape[0] == 1 else n] \
                if numbers_ds.ndim > 1 else numbers_ds[...]
            elements = _numbers_to_elements(
                numbers, idx.n_atoms
            )
        frame: dict[str, Any] = {
            "frame_number": n,
            "elements": elements,
            "positions": positions_array.tolist(),
            "comment": "",
            "properties": {},
        }
        cells_path = idx.aux.get("cells")
        if cells_path:
            cells_ds = handle[cells_path]
            cell_value = cells_ds[0 if cells_ds.shape[0] == 1 else n] \
                if cells_ds.ndim == 3 else cells_ds[...]
            cell = np.asarray(
                cell_value, dtype=float
            ).reshape(-1)
            if cell.size == 9:
                lattice = cell.reshape(3, 3).tolist()
                frame["lattice"] = lattice
                frame["properties"]["volume"] = _cell_volume(lattice)
                if idx.aux.get("direct_positions"):
                    direct = positions_array
                    positions_array = direct @ np.asarray(lattice, dtype=float)
                    frame["positions"] = positions_array.tolist()
        forces_path = idx.aux.get("forces")
        if forces_path:
            forces_ds = handle[forces_path]
            force_value = forces_ds[0 if forces_ds.shape[0] == 1 else n] \
                if forces_ds.ndim == 3 else forces_ds[...]
            forces = np.asarray(
                force_value, dtype=float
            ).reshape(-1, 3)
            if forces.shape == positions_array.shape:
                frame["forces"] = forces.tolist()
        energies_path = idx.aux.get("energies")
        if energies_path:
            energies_ds = handle[energies_path]
            if energies_ds.ndim == 0:
                energy_value = energies_ds[()]
            elif energies_ds.shape[0] in {1, idx.total_frames}:
                energy_value = energies_ds[0 if energies_ds.shape[0] == 1 else n]
            else:
                energy_value = energies_ds[...]
            energy = np.asarray(
                energy_value, dtype=float
            ).reshape(-1)
            if energy.size:
                # VASP stores several tagged energies per ionic step; the last
                # column is the closest analogue of sigma→0 for plotting.
                frame["properties"]["energy"] = float(energy[-1])
        return frame


def _read_json_frame(p: Path, idx: _TrajIndex, n: int) -> dict[str, Any]:
    start = idx.offsets[n]
    ends = idx.aux.get("ends", [])
    if n >= len(ends):
        raise HTTPException(status_code=416, detail=f"JSON frame {n} is out of range")
    raw = json.loads(_read_text_span(p, start, ends[n]))
    if idx.aux.get("json_mode") != "coords":
        return _json_structure_frame(raw, n)
    lattice = idx.aux.get("lattice")
    if not isinstance(lattice, list) or len(lattice) != 3 or not isinstance(raw, list):
        raise HTTPException(status_code=422, detail=f"pymatgen JSON frame {n}: invalid data")
    positions = [
        [
            sum(float(abc[row]) * float(lattice[row][axis]) for row in range(3))
            for axis in range(3)
        ]
        for abc in raw
    ]
    if len(positions) != idx.n_atoms:
        raise HTTPException(status_code=422, detail=f"pymatgen JSON frame {n}: atom count changed")
    return {
        "frame_number": n,
        "elements": list(idx.elements),
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
    variable_topology: bool = False


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
        variable_topology=bool(idx.aux.get("variable_topology", False)),
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


_POSITION_PACKET_MAGIC = b"CGTP"
_POSITION_PACKET_VERSION = 2
_POSITION_PACKET_HEADER = struct.Struct("<4sIII")
# v2 carries the atom count in every frame. This keeps compact playback valid
# for variable-topology extXYZ/JSON trajectories instead of rejecting the
# first frame whose N differs from frame 0.
_POSITION_FRAME_HEADER = struct.Struct("<III9d")
_POSITION_FLAG_LATTICE = 1
_POSITION_FLAG_TOPOLOGY_CHANGED = 2


@router.get("/positions")
def trajectory_positions(
    path: str = Query(...),
    start: int = Query(0, ge=0),
    count: int = Query(1, ge=1, le=64),
) -> Response:
    """Return contiguous float32 coordinates for smooth streamed playback.

    JSON expands 20k×3 coordinates into nested objects in both Python and
    JavaScript. This packet keeps a fixed header plus raw float32 positions per
    frame. A topology-change bit tells the client to request the full JSON
    frame only for the uncommon variable-composition case.
    """
    import numpy as np

    p, idx = _get_index(path)
    total = idx.total_frames
    if start >= total:
        raise HTTPException(
            status_code=416, detail=f"start {start} >= total_frames {total}"
        )
    end = min(start + count, total)
    frames = [_read_frame(p, idx, n) for n in range(start, end)]
    payload = bytearray(
        _POSITION_PACKET_HEADER.pack(
            _POSITION_PACKET_MAGIC,
            _POSITION_PACKET_VERSION,
            len(frames),
            idx.n_atoms,
        )
    )
    topology = idx.elements or (frames[0].get("elements", []) if frames else [])
    zero_lattice = (0.0,) * 9
    for frame in frames:
        positions = np.asarray(frame.get("positions", []), dtype="<f4")
        if positions.size % 3 != 0:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"frame {frame.get('frame_number')} has "
                    f"{positions.size} position values (not divisible by 3)"
                ),
            )
        frame_n_atoms = positions.size // 3
        positions = positions.reshape(frame_n_atoms, 3)
        elements = frame.get("elements", [])
        topology_changed = (
            len(elements) != len(topology)
            or any(a != b for a, b in zip(elements, topology))
        )
        lattice = frame.get("lattice")
        has_lattice = (
            isinstance(lattice, list)
            and len(lattice) == 3
            and all(isinstance(row, list) and len(row) == 3 for row in lattice)
        )
        flags = (
            (_POSITION_FLAG_LATTICE if has_lattice else 0)
            | (_POSITION_FLAG_TOPOLOGY_CHANGED if topology_changed else 0)
        )
        lattice_flat = (
            tuple(float(value) for row in lattice for value in row)
            if has_lattice
            else zero_lattice
        )
        payload.extend(
            _POSITION_FRAME_HEADER.pack(
                int(frame.get("frame_number", 0)),
                frame_n_atoms,
                flags,
                *lattice_flat,
            )
        )
        payload.extend(positions.tobytes(order="C"))

    logger.info("Streamed position packet [%d, %d) of %s", start, end, p.name)
    return Response(
        content=bytes(payload),
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


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
    cached_name = _cache_name_for_trajectory("pending", orig_name)
    ext = cached_name.removeprefix("pending")
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
        local = cache_dir / _cache_name_for_trajectory(sha.hexdigest()[:16], orig_name)
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
