"""convert + inspect handlers (read-only ops set mutates=False at registration)."""
from __future__ import annotations

from pathlib import Path

from pymatgen.symmetry.analyzer import SpacegroupAnalyzer

from catgo.cli.adapter import OpError, require_structure
from catgo.cli.registry import OpResult
from catgo.cli.session import write_structure


def convert(session, params: dict) -> OpResult:
    struct = require_structure(session)
    out = Path(params["out"])
    if out.exists() and not params.get("force"):
        raise OpError(f"{out} exists (use --force / confirm to overwrite)")
    write_structure(struct, out)
    return OpResult(ok=True, message=f"wrote {out}", artifact=out)


def inspect(session, params: dict) -> OpResult:
    struct = require_structure(session)
    comp = struct.composition.formula
    try:
        sga = SpacegroupAnalyzer(struct)
        sg = f"{sga.get_space_group_symbol()} (#{sga.get_space_group_number()})"
    except Exception:  # noqa: BLE001
        sg = "n/a (symmetry analysis failed)"
    # PBC-aware: Structure.get_distance uses the minimum-image convention,
    # so this is the true nearest-neighbor distance (distance_matrix would
    # ignore periodic images and over-report for periodic cells).
    nn = min(
        (struct.get_distance(i, j)
         for i in range(len(struct)) for j in range(i + 1, len(struct))),
        default=float("nan"),
    )
    msg = (f"composition: {comp}  |  sites: {struct.num_sites}  |  "
           f"spacegroup: {sg}  |  nearest-neighbor: {nn:.3f} A")
    return OpResult(ok=True, message=msg, structure=None)
