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


def _parse_surfaces(raw: str) -> list:
    """'111;100;1,1,-1' -> [(1,1,1),(1,0,0),(1,1,-1)]."""
    out = []
    for tok in (raw or "").split(";"):
        tok = tok.strip()
        if not tok:
            continue
        if "," in tok:
            idx = tuple(int(x) for x in tok.split(","))
        else:  # compact '111' / '1-10' style: each char a digit (no negatives)
            idx = tuple(int(c) for c in tok)
        if len(idx) != 3:
            raise OpError(f"surface '{tok}' must have 3 Miller indices")
        out.append(idx)
    return out


def nanoparticle(session, params: dict) -> OpResult:
    # Builds FROM SCRATCH — no active structure required.
    from catgo.models.nanoparticle import NanoparticleParams, build_nanoparticle

    element = (params.get("element") or "").strip()
    if not element:
        raise OpError("nanoparticle requires --element")

    kw: dict = {"element": element, "shape": params.get("shape", "wulff")}
    if params.get("structure"):
        kw["structure"] = params["structure"]
    for key in ("size", "length", "cutoff", "shells", "p", "q", "r"):
        if params.get(key) is not None:
            kw[key] = int(params[key])
    if params.get("lattice") is not None:
        kw["lattice_constant"] = float(params["lattice"])
    if params.get("vacuum") is not None:
        kw["vacuum"] = float(params["vacuum"])
    if params.get("rounding"):
        kw["rounding"] = params["rounding"]
    if params.get("surfaces"):
        kw["surfaces"] = _parse_surfaces(params["surfaces"])
    if params.get("energies"):
        kw["energies"] = [float(x) for x in str(params["energies"]).split(",") if x]

    try:
        new = build_nanoparticle(NanoparticleParams(**kw))
    except (ValueError, ImportError) as exc:
        raise OpError(f"nanoparticle build failed: {exc}") from exc

    return OpResult(
        ok=True,
        message=f"nanoparticle {element} {kw['shape']} -> {new.num_sites} atoms",
        structure=new,
    )


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
