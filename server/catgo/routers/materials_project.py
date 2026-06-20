"""Materials Project API proxy endpoints.

Proxies requests to Materials Project API to bypass CORS restrictions.
Requires user to provide their own API key.
"""

import httpx
from typing import Optional
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

router = APIRouter(prefix="/mp", tags=["materials-project"])

MP_API_BASE = "https://api.materialsproject.org"
HTTP_TIMEOUT = 30.0


class MPSearchRequest(BaseModel):
    """Request model for MP structure search."""
    elements: Optional[list[str]] = None
    formula: Optional[str] = None
    material_ids: Optional[list[str]] = None  # Search by specific material IDs
    limit: int = 20


@router.get("/validate-key")
async def validate_api_key(x_api_key: str = Header(..., alias="X-API-KEY")):
    """Validate a Materials Project API key."""
    print(f"[MP DEBUG] Validating API key: {x_api_key[:8]}...")
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        try:
            # Try the dedicated API check endpoint first
            check_url = "https://www.materialsproject.org/rest/v1/api_check"
            print(f"[MP DEBUG] Trying API check endpoint: {check_url}")
            response = await client.get(
                check_url,
                headers={
                    "X-API-KEY": x_api_key,
                    "Accept": "application/json",
                },
            )
            print(f"[MP DEBUG] API check response status: {response.status_code}")

            if response.status_code == 200:
                data = response.json()
                print(f"[MP DEBUG] API check response: {data}")
                if data.get("valid_response"):
                    return {"valid": True}

            # Fallback: try the summary endpoint
            url = f"{MP_API_BASE}/materials/summary/"
            print(f"[MP DEBUG] Fallback - trying summary endpoint: {url}")
            response = await client.get(
                url,
                params={"_limit": "1"},
                headers={
                    "X-API-KEY": x_api_key,
                    "Accept": "application/json",
                },
            )
            print(f"[MP DEBUG] Summary response status: {response.status_code}")
            print(f"[MP DEBUG] Summary response: {response.text[:300] if response.text else 'empty'}")

            if response.status_code == 200:
                return {"valid": True}
            elif response.status_code in (401, 403):
                return {"valid": False, "error": "Invalid API key"}
            else:
                return {"valid": False, "error": f"API error: {response.status_code}"}
        except Exception as e:
            print(f"[MP DEBUG] Exception: {e}")
            raise HTTPException(status_code=500, detail=str(e))


@router.post("/search")
async def search_structures(
    request: MPSearchRequest,
    x_api_key: str = Header(..., alias="X-API-KEY"),
):
    """Search Materials Project for structures with computed properties."""
    params = {
        "_fields": ",".join([
            "material_id",
            "formula_pretty",
            "nsites",
            "nelements",
            "symmetry",
            "energy_above_hull",
            "formation_energy_per_atom",
            "band_gap",
            "is_stable",
            "is_metal",
            "efermi",
            "cbm",
            "vbm",
            "ordering",
            "has_props",
        ]),
        "_limit": str(request.limit),
    }

    if request.material_ids:
        # Search by specific material IDs
        params["material_ids"] = ",".join(request.material_ids)
    elif request.elements:
        params["elements"] = ",".join(request.elements)

    if request.formula:
        params["formula"] = request.formula

    print(f"[MP DEBUG] Search params: {params}")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        try:
            url = f"{MP_API_BASE}/materials/summary/"
            print(f"[MP DEBUG] Search URL: {url}")
            response = await client.get(
                url,
                params=params,
                headers={
                    "X-API-KEY": x_api_key,
                    "Accept": "application/json",
                },
            )

            print(f"[MP DEBUG] Search response status: {response.status_code}")

            if response.status_code == 401 or response.status_code == 403:
                raise HTTPException(status_code=401, detail="Invalid API key")

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            print(f"[MP DEBUG] HTTP error: {e}")
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except Exception as e:
            print(f"[MP DEBUG] Exception: {e}")
            raise HTTPException(status_code=500, detail=str(e))


@router.get("/structure/{material_id}")
async def get_structure(
    material_id: str,
    x_api_key: Optional[str] = Header(None, alias="X-API-KEY"),
):
    """Get a single structure's summary from Materials Project."""
    print(f"[MP DEBUG] get_structure called for: {material_id}")
    print(f"[MP DEBUG] API key received: {x_api_key[:8] if x_api_key else 'None'}...")

    if not x_api_key:
        print(f"[MP DEBUG] No API key provided!")
        raise HTTPException(status_code=401, detail="API key required")

    params = {
        "_fields": ",".join([
            "material_id",
            "formula_pretty",
            "nsites",
            "nelements",
            "symmetry",
            "energy_above_hull",
            "formation_energy_per_atom",
            "band_gap",
            "is_stable",
            "is_metal",
            "efermi",
            "cbm",
            "vbm",
            "ordering",
            "has_props",
        ]),
    }

    print(f"[MP DEBUG] Fetching structure: {material_id}")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        try:
            url = f"{MP_API_BASE}/materials/summary/{material_id}"
            print(f"[MP DEBUG] URL: {url}")
            response = await client.get(
                url,
                params=params,
                headers={
                    "X-API-KEY": x_api_key,
                    "Accept": "application/json",
                },
            )

            print(f"[MP DEBUG] Response status: {response.status_code}")

            if response.status_code == 401 or response.status_code == 403:
                raise HTTPException(status_code=401, detail="Invalid API key")

            if response.status_code == 404:
                print(f"[MP DEBUG] Structure not found: {material_id}")
                raise HTTPException(status_code=404, detail="Structure not found")

            response.raise_for_status()
            data = response.json()
            print(f"[MP DEBUG] Got data for {material_id}: {list(data.get('data', {}).keys()) if isinstance(data.get('data'), dict) else 'list'}")
            return data

        except httpx.HTTPStatusError as e:
            print(f"[MP DEBUG] HTTP error: {e}")
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except HTTPException:
            raise
        except Exception as e:
            print(f"[MP DEBUG] Exception: {e}")
            raise HTTPException(status_code=500, detail=str(e))
