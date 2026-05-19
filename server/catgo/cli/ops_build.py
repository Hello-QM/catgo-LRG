"""build-group handlers. Each: (session, params) -> OpResult.

Reuses catgo.routers.structure_ops route functions via the in-process
adapter; no server required.
"""
from __future__ import annotations

from pymatgen.core import Structure

from catgo.cli.adapter import call_route, require_structure
from catgo.cli.registry import OpResult
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
