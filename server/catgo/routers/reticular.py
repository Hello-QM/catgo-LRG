"""Reticular (MOF/COF) builder API endpoints."""

import logging
import traceback

from fastapi import APIRouter, HTTPException

from catgo.models.reticular import (
    PRESETS,
    BuildingBlockInfo,
    ReticularBuildRequest,
    ReticularBuildResult,
    TopologyDetail,
    TopologyInfo,
)
from catgo.models.structure import Lattice, PymatgenStructure, Site, Species
from catgo.utils.reticular_algorithm import (
    build_preset,
    build_reticular,
    list_building_blocks,
    list_topologies,
    topology_detail,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/reticular", tags=["reticular"])


def _native_to_model(structure) -> PymatgenStructure:
    """Convert a pymatgen Structure to the shared PymatgenStructure model."""
    latt = Lattice(
        matrix=structure.lattice.matrix.tolist(),
        pbc=[True, True, True],
        a=float(structure.lattice.a),
        b=float(structure.lattice.b),
        c=float(structure.lattice.c),
        alpha=float(structure.lattice.alpha),
        beta=float(structure.lattice.beta),
        gamma=float(structure.lattice.gamma),
        volume=float(structure.lattice.volume),
    )
    sites = []
    for site in structure:
        element = str(site.specie)
        sites.append(
            Site(
                species=[Species(element=element, occu=1.0, oxidation_state=0)],
                abc=list(site.frac_coords),
                xyz=list(site.coords),
                label=element,
                properties={"reticular": True},
            )
        )
    return PymatgenStructure(lattice=latt, sites=sites)


@router.post("/build", response_model=ReticularBuildResult)
def build_reticular_structure(request: ReticularBuildRequest) -> ReticularBuildResult:
    """Build a MOF/COF from a preset or an explicit topology + BB assignment."""
    try:
        if request.mode == "preset":
            if not request.preset:
                raise ValueError("preset mode requires 'preset'")
            structure = build_preset(request.preset)
            topology = PRESETS[request.preset]["topology"]
        else:
            if not request.topology:
                raise ValueError("advanced mode requires 'topology'")
            structure = build_reticular(
                topology=request.topology,
                node_bbs=request.node_bbs,
                edge_bbs=request.edge_bbs,
            )
            topology = request.topology

        model = _native_to_model(structure)
        return ReticularBuildResult(
            structure=model,
            n_atoms=structure.num_sites,
            topology=topology,
            formula=structure.composition.reduced_formula,
            message=f"Built {topology} ({structure.num_sites} atoms)",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error building reticular structure: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/topologies", response_model=list[TopologyInfo])
def list_topologies_route(q: str | None = None) -> list[TopologyInfo]:
    return [TopologyInfo(**t) for t in list_topologies(query=q)]


@router.get("/building-blocks", response_model=list[BuildingBlockInfo])
def list_building_blocks_route(q: str | None = None) -> list[BuildingBlockInfo]:
    return [BuildingBlockInfo(**b) for b in list_building_blocks(query=q)]


@router.get("/topology/{name}", response_model=TopologyDetail)
def topology_detail_route(name: str) -> TopologyDetail:
    try:
        return TopologyDetail(**topology_detail(name))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/presets")
def list_presets_route():
    return [
        {"id": k, "label": v["label"], "topology": v["topology"]}
        for k, v in PRESETS.items()
    ]


@router.get("/health")
def reticular_health():
    return {"status": "healthy", "service": "reticular"}
