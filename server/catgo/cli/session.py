"""Stateful CLI session: one active structure + undo history + file IO."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, TYPE_CHECKING

from pymatgen.core import Structure

if TYPE_CHECKING:
    from catgo.cli.server_link import ServerLink


class SessionError(Exception):
    """Recoverable session-level error (bad path, empty history, …)."""


_ASE_ONLY_EXT = {".extxyz", ".mol2", ".pdb"}


# Public (no underscore): consumed by ops_convert as well as Session.
def read_structure(path: Path) -> Structure:
    # ASE-only formats go through pymatgen.io.ase.AseAtomsAdaptor so the
    # return type is ALWAYS a genuine pymatgen.core.Structure (consistent
    # with the Structure.from_file branch). Do NOT use
    # catgo.utils.converter.ase_to_pymatgen — it returns a different
    # pydantic model type and breaks every downstream consumer.
    ext = path.suffix.lower()
    try:
        if ext in _ASE_ONLY_EXT:
            from ase.io import read
            from pymatgen.io.ase import AseAtomsAdaptor
            return AseAtomsAdaptor.get_structure(read(str(path)))
        return Structure.from_file(str(path))
    except Exception as exc:  # noqa: BLE001 — unify all parse failures
        raise SessionError(f"cannot parse {path}: {exc}") from exc


# Public (no underscore): consumed by ops_convert as well as Session.
def write_structure(struct: Structure, path: Path) -> None:
    # AseAtomsAdaptor (not catgo.utils.converter.pymatgen_to_ase, which has
    # a pre-existing crash on plain-element structures).
    ext = path.suffix.lower()
    if ext in _ASE_ONLY_EXT:
        from ase.io import write
        from pymatgen.io.ase import AseAtomsAdaptor
        write(str(path), AseAtomsAdaptor.get_atoms(struct))
        return
    # pymatgen's filename-based format inference matches "*POSCAR*" but NOT
    # the conventional ".vasp" VASP structure extension — pin it explicitly.
    if ext == ".vasp":
        struct.to(filename=str(path), fmt="poscar")
        return
    struct.to(filename=str(path))


@dataclass
class Session:
    structure: Optional[Structure] = None
    source_path: Optional[Path] = None
    history: list[Structure] = field(default_factory=list)
    link: "Optional[ServerLink]" = None  # populated at CLI entry (P3a)

    def load(self, path) -> None:
        p = Path(path)
        if not p.exists():
            raise SessionError(f"file not found: {p}")
        self.structure = read_structure(p)
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
        write_structure(self.structure, p)
