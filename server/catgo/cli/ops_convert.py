"""convert + inspect handlers (read-only ops set mutates=False at registration)."""
from __future__ import annotations

from pathlib import Path

from pymatgen.symmetry.analyzer import SpacegroupAnalyzer

from catgo.cli.adapter import OpError
from catgo.cli.registry import OpResult
from catgo.cli.session import _write_structure


def _require(session):
    if session.structure is None:
        raise OpError("no active structure -- load one first")
    return session.structure


def convert(session, params: dict) -> OpResult:
    struct = _require(session)
    out = Path(params["out"])
    if out.exists() and not params.get("force"):
        raise OpError(f"{out} exists (use --force / confirm to overwrite)")
    _write_structure(struct, out)
    return OpResult(ok=True, message=f"wrote {out}", artifact=out)


def inspect(session, params: dict) -> OpResult:
    struct = _require(session)
    comp = struct.composition.formula
    try:
        sga = SpacegroupAnalyzer(struct)
        sg = f"{sga.get_space_group_symbol()} (#{sga.get_space_group_number()})"
    except Exception:  # noqa: BLE001
        sg = "n/a (non-periodic or analysis failed)"
    dm = struct.distance_matrix
    nn = min(
        (dm[i][j] for i in range(len(struct)) for j in range(i + 1, len(struct))),
        default=float("nan"),
    )
    msg = (f"composition: {comp}  |  sites: {struct.num_sites}  |  "
           f"spacegroup: {sg}  |  nearest-neighbor: {nn:.3f} A")
    return OpResult(ok=True, message=msg, structure=None)
