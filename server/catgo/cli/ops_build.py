"""build-group handlers. Each: (session, params) -> OpResult.

Reuses catgo.routers.structure_ops route functions via the in-process
adapter; no server required.
"""
from __future__ import annotations

from pymatgen.core import Structure

from catgo.cli.adapter import OpError, call_route, require_structure
from catgo.cli.registry import OpResult
from catgo.models.reticular import ReticularBuildRequest
from catgo.routers.reticular import build_reticular_structure
from catgo.routers.structure_ops import (
    GenerateSlabRequest, SupercellRequest,
    create_supercell, generate_slab,
)


def supercell(session, params: dict) -> OpResult:
    struct = require_structure(session)
    res = call_route(
        create_supercell, SupercellRequest,
        structure=struct.as_dict(), scaling=list(params["scaling"]),
    )
    new = Structure.from_dict(res.structure)
    return OpResult(ok=True, message=f"supercell -> {new.num_sites} sites",
                    structure=new)


def slab(session, params: dict) -> OpResult:
    struct = require_structure(session)
    # in_unit_planes=True -> min_slab_size is a true atomic-layer count,
    # so `layers` means exactly that (no Angstrom/layer heuristic).
    res = call_route(
        generate_slab, GenerateSlabRequest,
        structure=struct.as_dict(),
        miller_index=list(params["miller"]),
        min_slab_size=float(params.get("layers", 4)),
        in_unit_planes=True,
        min_vacuum_size=float(params.get("vacuum", 15.0)),
    )
    # P1: first termination only; multi-termination selection is deferred.
    first = Structure.from_dict(res.slabs[0])
    return OpResult(
        ok=True,
        message=f"slab {params['miller']} -> {first.num_sites} sites "
                f"({res.num_slabs} termination(s))",
        structure=first,
    )


def _parse_assignment(spec: str | None) -> dict:
    """'0=N10,1=N409' -> {'0': 'N10', '1': 'N409'}."""
    if not spec:
        return {}
    out = {}
    for part in spec.split(","):
        if "=" not in part:
            raise OpError(f"bad assignment '{part}', expected key=bb_id")
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def reticular(session, params: dict) -> OpResult:
    # Builds FROM SCRATCH — no active structure required.
    mode = params.get("mode", "preset")
    if mode == "preset":
        req = ReticularBuildRequest(mode="preset", preset=(params.get("preset") or None))
    else:
        node_raw = _parse_assignment(params.get("node"))
        req = ReticularBuildRequest(
            mode="advanced",
            topology=(params.get("topology") or None),
            node_bbs={int(k): v for k, v in node_raw.items()},
            edge_bbs=_parse_assignment(params.get("edge")),
        )
    res = call_route(build_reticular_structure, ReticularBuildRequest, **req.model_dump())
    new = Structure.from_dict(res.structure.model_dump())
    return OpResult(ok=True, message=f"reticular {res.topology} -> {new.num_sites} sites",
                    structure=new)
