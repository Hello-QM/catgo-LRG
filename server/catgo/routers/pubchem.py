"""PubChem API proxy endpoints.

Provides server-side access to PubChem REST API, bypassing CORS restrictions
and enabling caching for better performance.
"""

import re
import httpx
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/pubchem", tags=["pubchem"])

# PubChem REST API base URL
PUBCHEM_BASE_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"

# HTTP client with timeout settings
HTTP_TIMEOUT = 30.0

# Maximum number of CIDs to fetch when searching by element
MAX_ELEMENT_CIDS = 2000


class CompoundSearchRequest(BaseModel):
    """Request model for compound search."""
    search_term: str
    search_type: str = "name"  # name, smiles, inchi, formula
    max_results: int = 20


class CompoundSearchResult(BaseModel):
    """Single compound search result."""
    cid: int
    formula: Optional[str] = None
    weight: Optional[float] = None
    name: Optional[str] = None


class CompoundSearchResponse(BaseModel):
    """Response model for compound search."""
    compounds: List[CompoundSearchResult]


async def fetch_json(url: str) -> dict:
    """Fetch JSON from URL with error handling."""
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.get(url, follow_redirects=True)
        response.raise_for_status()
        return response.json()


async def fetch_text(url: str) -> str:
    """Fetch text from URL with error handling."""
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.get(url, follow_redirects=True)
        response.raise_for_status()
        return response.text


async def _fetch_properties(cids: list[int]) -> list[dict]:
    """Batch-fetch compound properties for a list of CIDs.

    Args:
        cids: List of PubChem compound IDs

    Returns:
        List of property dicts from PubChem PropertyTable
    """
    if not cids:
        return []
    cids_str = ",".join(str(cid) for cid in cids)
    props_url = (
        f"{PUBCHEM_BASE_URL}/compound/cid/{cids_str}/property/"
        "MolecularFormula,MolecularWeight,Title,IUPACName,"
        "XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,"
        "RotatableBondCount,HeavyAtomCount/JSON"
    )
    props_data = await fetch_json(props_url)
    return props_data.get("PropertyTable", {}).get("Properties", [])


def _props_to_compounds(props: list[dict]) -> list[dict]:
    """Convert PubChem property dicts to our compound format.

    Args:
        props: List of PubChem property dicts

    Returns:
        List of compound dicts with cid, formula, weight, name, and extra props
    """
    compounds = []
    for prop in props:
        compound = {
            "cid": prop.get("CID"),
            "formula": prop.get("MolecularFormula"),
            "weight": prop.get("MolecularWeight"),
            "name": prop.get("Title") or prop.get("IUPACName"),
        }
        for key in ("XLogP", "TPSA", "HBondDonorCount",
                    "HBondAcceptorCount", "RotatableBondCount",
                    "HeavyAtomCount"):
            if prop.get(key) is not None:
                compound[key] = prop[key]
        compounds.append(compound)
    return compounds


def _formula_has_elements(formula: str, elements: list[str]) -> bool:
    """Check if a molecular formula contains all given element symbols.

    Args:
        formula: Molecular formula string (e.g. "C6H12O6")
        elements: List of element symbols to check for (e.g. ["C", "O"])

    Returns:
        True if all elements are present in the formula
    """
    # Extract all element symbols from the formula using regex
    found = set(re.findall(r"[A-Z][a-z]?", formula))
    return all(el in found for el in elements)


async def _search_by_elements(
    elements: list[str],
    max_results: int,
    offset: int,
) -> dict:
    """Search compounds by element content using PubChem's element namespace.

    Takes the first element as the primary search target, fetches up to
    MAX_ELEMENT_CIDS CIDs, then filters by remaining elements if needed.

    Args:
        elements: List of element symbols (e.g. ["Fe", "O"])
        max_results: Number of results per page
        offset: Pagination offset

    Returns:
        Dict with keys: compounds, total_count, has_more
    """
    if not elements:
        return {"compounds": [], "total_count": 0, "has_more": False}

    primary = elements[0]
    remaining = elements[1:]

    # PubChem has no "element" namespace — use fastsubstructure with an explicit
    # atom SMILES like "[Au]" to find all compounds containing that element.
    smiles = f"[{primary}]"
    from urllib.parse import quote
    cids_url = (
        f"{PUBCHEM_BASE_URL}/compound/fastsubstructure/smiles/{quote(smiles, safe='')}"
        f"/cids/JSON?MaxRecords={MAX_ELEMENT_CIDS}"
    )
    try:
        cids_data = await fetch_json(cids_url)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return {"compounds": [], "total_count": 0, "has_more": False}
        try:
            detail = e.response.json().get("Fault", {}).get("Message", e.response.text)
        except Exception:
            detail = e.response.text or f"PubChem returned {e.response.status_code}"
        raise HTTPException(
            status_code=e.response.status_code,
            detail=(
                f"PubChem element search for '{primary}' failed: {detail}. "
                f"Try combining with another element or use a formula/name search."
            ),
        )

    all_cids = cids_data.get("IdentifierList", {}).get("CID", [])
    # Cap at MAX_ELEMENT_CIDS
    all_cids = all_cids[:MAX_ELEMENT_CIDS]

    if not remaining:
        # Single element: paginate directly from CID list
        total_count = len(all_cids)
        page_cids = all_cids[offset:offset + max_results]
        if not page_cids:
            return {"compounds": [], "total_count": total_count, "has_more": False}
        props = await _fetch_properties(page_cids)
        compounds = _props_to_compounds(props)
        return {
            "compounds": compounds,
            "total_count": total_count,
            "has_more": (offset + max_results) < total_count,
        }
    else:
        # Multi-element: fetch properties for all capped CIDs, filter by formula
        if not all_cids:
            return {"compounds": [], "total_count": 0, "has_more": False}
        props = await _fetch_properties(all_cids)
        # Filter to only compounds containing all remaining elements
        filtered_props = [
            p for p in props
            if p.get("MolecularFormula")
            and _formula_has_elements(p["MolecularFormula"], remaining)
        ]
        total_count = len(filtered_props)
        page_props = filtered_props[offset:offset + max_results]
        compounds = _props_to_compounds(page_props)
        return {
            "compounds": compounds,
            "total_count": total_count,
            "has_more": (offset + max_results) < total_count,
        }


@router.get("/search")
async def search_compounds(
    term: str = Query(..., description="Search term"),
    search_type: str = Query(
        "name",
        description="Search type: name, formula, element, smiles, cid",
    ),
    max_results: int = Query(20, description="Maximum number of results"),
    offset: int = Query(0, description="Offset for pagination"),
):
    """Search for compounds in PubChem.

    Args:
        term: Search term (compound name, SMILES, formula, element symbol(s),
              or CID)
        search_type: Type of search to perform. Use "element" with comma-
                     separated element symbols (e.g. "Fe,O") to search by
                     element content. Use "cid" to look up a single compound
                     by its numeric ID.
        max_results: Maximum number of results to return
        offset: Offset for pagination
    """
    # Element search: delegate to dedicated helper
    if search_type == "element":
        elements = [el.strip() for el in term.split(",") if el.strip()]
        try:
            return await _search_by_elements(elements, max_results, offset)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return {"compounds": [], "total_count": 0, "has_more": False}
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # CID lookup: directly fetch properties for a single known CID
    if search_type == "cid":
        try:
            cid = int(term.strip())
        except (ValueError, AttributeError):
            return {"compounds": [], "total_count": 0, "has_more": False}
        try:
            props = await _fetch_properties([cid])
            compounds = _props_to_compounds(props)
            return {
                "compounds": compounds,
                "total_count": len(compounds),
                "has_more": False,
            }
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return {"compounds": [], "total_count": 0, "has_more": False}
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Name / formula / smiles: use PubChem namespace-based search
    namespace_map = {
        "name": "name",
        "smiles": "smiles",
        "inchi": "inchi",
        "formula": "fastformula",
    }
    namespace = namespace_map.get(search_type, "name")
    search_url = f"{PUBCHEM_BASE_URL}/compound/{namespace}/{term}/cids/JSON"

    try:
        data = await fetch_json(search_url)
        all_cids = data.get("IdentifierList", {}).get("CID", [])
        total_count = len(all_cids)
        cids = all_cids[offset:offset + max_results]

        if not cids:
            return {"compounds": [], "total_count": total_count, "has_more": False}

        props = await _fetch_properties(cids)
        compounds = _props_to_compounds(props)

        return {
            "compounds": compounds,
            "total_count": total_count,
            "has_more": (offset + max_results) < total_count,
        }

    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return {"compounds": []}
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/autocomplete")
async def autocomplete_compound(
    term: str = Query(..., min_length=1),
    limit: int = Query(8, le=20),
):
    """Autocomplete compound names from PubChem."""
    url = (
        f"https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound"
        f"/{term}/json?limit={limit}"
    )
    try:
        data = await fetch_json(url)
        suggestions = data.get("dictionary_terms", {}).get("compound", [])
        return {"suggestions": suggestions}
    except Exception:
        return {"suggestions": []}


@router.get("/compound/{cid}")
async def get_compound(
    cid: int,
    record_type: str = Query("3d", description="Record type: 2d or 3d"),
):
    """Fetch a compound by CID with 3D coordinates if available.

    Args:
        cid: PubChem compound ID
        record_type: Whether to get 2D or 3D structure
    """
    url = f"{PUBCHEM_BASE_URL}/compound/cid/{cid}/JSON?record_type={record_type}"

    try:
        data = await fetch_json(url)
        compounds = data.get("PC_Compounds", [])

        if not compounds:
            raise HTTPException(status_code=404, detail=f"Compound not found: {cid}")

        compound = compounds[0]

        # Extract atoms and coordinates
        atoms_data = compound.get("atoms", {})
        coords_data = compound.get("coords", [])
        bonds_data = compound.get("bonds", {})

        result = {
            "cid": cid,
            "atoms": {
                "aid": atoms_data.get("aid", []),
                "element": atoms_data.get("element", []),
            },
            "bonds": {
                "aid1": bonds_data.get("aid1", []),
                "aid2": bonds_data.get("aid2", []),
                "order": bonds_data.get("order", []),
            },
            "coords": [],
        }

        # Extract 3D coordinates if available
        if coords_data:
            for coord_set in coords_data:
                conformers = coord_set.get("conformers", [])
                if conformers:
                    conf = conformers[0]
                    result["coords"].append({
                        "x": conf.get("x", []),
                        "y": conf.get("y", []),
                        "z": conf.get("z", []),
                    })

        return result

    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            # Try 2D if 3D not available
            if record_type == "3d":
                return await get_compound(cid, record_type="2d")
            raise HTTPException(status_code=404, detail=f"Compound not found: {cid}")
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/compound/{cid}/sdf")
async def get_compound_sdf(
    cid: int,
    record_type: str = Query("3d", description="Record type: 2d or 3d"),
):
    """Fetch a compound SDF file.

    Args:
        cid: PubChem compound ID
        record_type: Whether to get 2D or 3D structure
    """
    url = f"{PUBCHEM_BASE_URL}/compound/cid/{cid}/SDF?record_type={record_type}"

    try:
        sdf_content = await fetch_text(url)
        return {"cid": cid, "sdf": sdf_content}
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404 and record_type == "3d":
            # Try 2D if 3D not available
            return await get_compound_sdf(cid, record_type="2d")
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/compound/{cid}/properties")
async def get_compound_properties(cid: int):
    """Fetch compound properties.

    Args:
        cid: PubChem compound ID
    """
    # PubChem renamed the SMILES property (2025): request the modern `SMILES`
    # name (the legacy `CanonicalSMILES` request still 200s but the response now
    # keys the value as `ConnectivitySMILES`, silently dropping it).
    props_url = (
        f"{PUBCHEM_BASE_URL}/compound/cid/{cid}/property/"
        "MolecularFormula,MolecularWeight,Title,IUPACName,"
        "SMILES,InChI,InChIKey,XLogP,TPSA,"
        "HBondDonorCount,HBondAcceptorCount,RotatableBondCount/JSON"
    )

    try:
        data = await fetch_json(props_url)
        properties = data.get("PropertyTable", {}).get("Properties", [])

        if not properties:
            raise HTTPException(status_code=404, detail=f"Compound not found: {cid}")

        return properties[0]

    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/proxy")
async def proxy_request(url: str = Query(..., description="URL to fetch")):
    """Generic proxy endpoint for PubChem URLs.

    This allows the frontend to fetch any PubChem URL through the backend,
    bypassing CORS restrictions.
    """
    # Validate URL is a PubChem endpoint
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.hostname != "pubchem.ncbi.nlm.nih.gov":
        raise HTTPException(
            status_code=403,
            detail=f"Domain not allowed: {parsed.hostname}"
        )

    try:
        data = await fetch_json(url)
        return data
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
