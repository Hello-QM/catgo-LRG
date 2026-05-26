"""MOF-database (MOFX-DB) search API endpoints."""

import logging
import traceback

from fastapi import APIRouter, HTTPException

from catgo.models.mofdb import (
    MofHit,
    MofSearchRequest,
    MofSearchResult,
    MofStructureResult,
)
from catgo.models.structure import Lattice, PymatgenStructure, Site, Species
from catgo.utils.mofdb_search import get_mof_structure, search_mofs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mofdb", tags=["mofdb"])


def _native_to_model(structure) -> PymatgenStructure:
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
                properties={"mofdb": True},
            )
        )
    return PymatgenStructure(lattice=latt, sites=sites)


@router.post("/search", response_model=MofSearchResult)
def search_mofs_route(request: MofSearchRequest) -> MofSearchResult:
    try:
        res = search_mofs(name=request.name, database=request.database, limit=request.limit)
        return MofSearchResult(hits=[MofHit(**h) for h in res["hits"]], count=res["count"])
    except TimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e))
    except RuntimeError as e:  # mofdb_client not installed
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("MOFX-DB search failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"MOFX-DB search failed: {e}")


@router.get("/structure", response_model=MofStructureResult)
def get_mof_structure_route(name: str, database: str | None = None) -> MofStructureResult:
    try:
        structure, resolved_name = get_mof_structure(name, database)
        return MofStructureResult(
            structure=_native_to_model(structure),
            name=resolved_name,
            database=database or "",
        )
    except TimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("MOFX-DB structure fetch failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"MOFX-DB structure fetch failed: {e}")


@router.get("/health")
def mofdb_health():
    return {"status": "healthy", "service": "mofdb"}
