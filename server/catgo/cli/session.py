"""Stateful CLI session: one active structure + undo history + file IO."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from pymatgen.core import Structure


class SessionError(Exception):
    """Recoverable session-level error (bad path, empty history, …)."""


_ASE_ONLY_EXT = {".extxyz", ".mol2", ".pdb"}


def _read_structure(path: Path) -> Structure:
    ext = path.suffix.lower()
    if ext in _ASE_ONLY_EXT:
        from ase.io import read
        from catgo.utils.converter import ase_to_pymatgen
        return ase_to_pymatgen(read(str(path)))
    try:
        return Structure.from_file(str(path))
    except Exception as exc:  # noqa: BLE001
        raise SessionError(f"cannot parse {path}: {exc}") from exc


def _write_structure(struct: Structure, path: Path) -> None:
    ext = path.suffix.lower()
    if ext in _ASE_ONLY_EXT:
        from ase.io import write
        from catgo.utils.converter import pymatgen_to_ase
        write(str(path), pymatgen_to_ase(struct))
        return
    struct.to(filename=str(path))


@dataclass
class Session:
    structure: Optional[Structure] = None
    source_path: Optional[Path] = None
    history: list[Structure] = field(default_factory=list)
    link: object | None = None  # ServerLink placeholder (P3)

    def load(self, path) -> None:
        p = Path(path)
        if not p.exists():
            raise SessionError(f"file not found: {p}")
        self.structure = _read_structure(p)
        self.source_path = p

    def push_history(self) -> None:
        if self.structure is not None:
            self.history.append(self.structure.copy())

    def undo(self) -> None:
        if not self.history:
            raise SessionError("nothing to undo")
        self.structure = self.history.pop()

    def save(self, path, fmt: str | None = None) -> None:
        if self.structure is None:
            raise SessionError("no active structure to save")
        p = Path(path)
        _write_structure(self.structure, p)
