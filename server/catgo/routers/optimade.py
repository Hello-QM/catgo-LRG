"""OPTIMADE API proxy endpoints.

Provides server-side access to OPTIMADE databases, bypassing CORS restrictions
and enabling caching for better performance.
"""

import httpx
from typing import Optional
from urllib.parse import urlparse, urlencode
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/optimade", tags=["optimade"])

# OPTIMADE API base URLs
PROVIDERS_URL = "https://providers.optimade.org/v1/links"

# HTTP client with timeout settings
HTTP_TIMEOUT = 30.0

# Provider IDs known to have issues
BROKEN_PROVIDER_IDS = {
    "aflow", "cod", "cmr", "exmpl", "matcloud", "mpds",
    "mpod", "nmd", "odbx", "oqmd", "jarvis", "tcod",
}

# Fallback providers when main provider list is unavailable
FALLBACK_PROVIDERS = [
    {
        "id": "mp",
        "type": "links",
        "attributes": {
            "name": "Materials Project",
            "description": "Materials Project database",
            "base_url": "https://optimade.materialsproject.org",
            "homepage": "https://materialsproject.org",
        },
    },
    {
        "id": "mc3d",
        "type": "links",
        "attributes": {
            "name": "MC3D",
            "description": "Materials Cloud 3D crystals database",
            "base_url": "https://aiida.materialscloud.org/mc3d/optimade",
            "homepage": "https://materialscloud.org",
        },
    },
    {
        "id": "alexandria",
        "type": "links",
        "attributes": {
            "name": "Alexandria",
            "description": "Alexandria database",
            "base_url": "https://alexandria.icams.rub.de/optimade",
            "homepage": "https://alexandria.icams.rub.de",
        },
    },
    {
        "id": "mcloud",
        "type": "links",
        "attributes": {
            "name": "Materials Cloud",
            "description": "Materials Cloud main database",
            "base_url": "https://www.materialscloud.org/optimade/main",
            "homepage": "https://www.materialscloud.org",
        },
    },
    {
        "id": "omdb",
        "type": "links",
        "attributes": {
            "name": "Open Materials Database",
            "description": "Open Materials Database",
            "base_url": "https://optimade.openmaterialsdb.se",
            "homepage": "https://openmaterialsdb.se",
        },
    },
    {
        "id": "twodmatpedia",
        "type": "links",
        "attributes": {
            "name": "2DMatpedia",
            "description": "2D Materials database",
            "base_url": "https://optimade.2dmatpedia.org",
            "homepage": "https://www.2dmatpedia.org",
        },
    },
]

# In-memory cache for providers
_providers_cache: Optional[list] = None
_resolved_urls_cache: dict = {}


class SearchRequest(BaseModel):
    """Request model for structure search."""
    provider_id: str
    filter: Optional[str] = None
    page_limit: int = 20
    page_offset: int = 0
    sort: Optional[str] = None
    response_fields: Optional[str] = None  # Comma-separated list of fields to include


async def fetch_json(url: str) -> dict:
    """Fetch JSON from URL with error handling."""
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.get(
            url,
            headers={"Accept": "application/vnd.api+json"},
            follow_redirects=True,
        )
        response.raise_for_status()
        return response.json()


def normalize_structure_ids(data: dict) -> dict:
    """Coerce structure IDs to strings. Some providers (e.g. OMDB) return numeric IDs."""
    if "data" in data:
        entries = data["data"]
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict) and "id" in entry:
                    entry["id"] = str(entry["id"])
        elif isinstance(entries, dict) and "id" in entries:
            entries["id"] = str(entries["id"])
    return data


async def resolve_provider_url(base_url: str) -> str:
    """Resolve the actual structures endpoint URL for a provider."""
    if base_url in _resolved_urls_cache:
        return _resolved_urls_cache[base_url]

    # Try different endpoint patterns
    for endpoint in ["/links", "/v1/links"]:
        try:
            data = await fetch_json(f"{base_url}{endpoint}")
            # Find child link with structures endpoint
            for link in data.get("data", []):
                if (
                    link.get("type") == "links"
                    and link.get("attributes", {}).get("link_type") == "child"
                    and link.get("attributes", {}).get("base_url")
                ):
                    resolved = link["attributes"]["base_url"]
                    _resolved_urls_cache[base_url] = resolved
                    return resolved
        except Exception:
            continue

    # Fallback to original URL
    _resolved_urls_cache[base_url] = base_url
    return base_url


@router.get("/providers")
async def get_providers():
    """Get list of available OPTIMADE providers."""
    global _providers_cache

    if _providers_cache is not None:
        return {"data": _providers_cache}

    try:
        data = await fetch_json(PROVIDERS_URL)
        providers = [
            {
                "id": p["id"],
                "type": "links",
                "attributes": {
                    "name": p.get("attributes", {}).get("name"),
                    "description": p.get("attributes", {}).get("description"),
                    "base_url": p.get("attributes", {}).get("base_url"),
                    "homepage": p.get("attributes", {}).get("homepage"),
                    "version": p.get("attributes", {}).get("version"),
                },
            }
            for p in data.get("data", [])
            if p.get("attributes", {}).get("base_url")
            and p.get("id") not in BROKEN_PROVIDER_IDS
        ]
        _providers_cache = providers
        return {"data": providers}
    except Exception as e:
        # Return fallback providers on error
        _providers_cache = FALLBACK_PROVIDERS
        return {"data": FALLBACK_PROVIDERS, "warning": str(e)}


@router.get("/structure/{provider_id}/{structure_id:path}")
async def get_structure(
    provider_id: str,
    structure_id: str,
    response_fields: Optional[str] = Query(None),
):
    """Fetch a single structure from an OPTIMADE provider.

    Args:
        provider_id: Provider identifier (e.g., 'mp', 'mc3d')
        structure_id: Structure identifier within the provider
        response_fields: Optional comma-separated OPTIMADE response_fields.
            MP's OPTIMADE adapter only returns `_mp_*` extras when these are
            listed explicitly; without it the response carries only standard
            fields. Forwarded verbatim to the provider.
    """
    # Get provider base URL
    providers_response = await get_providers()
    providers = providers_response.get("data", [])

    provider = next((p for p in providers if p["id"] == provider_id), None)
    if not provider:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")

    base_url = await resolve_provider_url(provider["attributes"]["base_url"])

    params = {}
    if response_fields:
        params["response_fields"] = response_fields

    query_string = urlencode(params) if params else ""

    # Query strings to attempt, in order. If response_fields was requested, add
    # a bare-query retry: some providers 400 on unknown response_fields, and the
    # extra electronic metadata is a nice-to-have — the STRUCTURE is not. So we
    # degrade to fetching it without the extras rather than failing the import.
    query_attempts = [query_string]
    if query_string:
        query_attempts.append("")

    last_error: Optional[HTTPException] = None
    for query_attempt in query_attempts:
        for endpoint_base in [
            f"{base_url}/v1/structures/{structure_id}",
            f"{base_url}/structures/{structure_id}",
        ]:
            try:
                endpoint = (
                    f"{endpoint_base}?{query_attempt}" if query_attempt else endpoint_base
                )
                print(f"[OPTIMADE DEBUG] Fetching structure: {endpoint}")
                data = await fetch_json(endpoint)
                if "data" in data:
                    return normalize_structure_ids(data)
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    continue
                # Non-404 (e.g. 400 on response_fields): remember it, but keep
                # trying — the bare-query retry below may still succeed.
                last_error = HTTPException(
                    status_code=e.response.status_code, detail=str(e)
                )
                continue
            except Exception as e:
                print(f"[OPTIMADE DEBUG] Error fetching structure: {e}")
                continue

    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=404, detail=f"Structure not found: {structure_id}")


@router.post("/search")
async def search_structures(request: SearchRequest):
    """Search structures in an OPTIMADE provider.

    Args:
        request: Search parameters including provider, filter, pagination
    """
    # Get provider base URL
    providers_response = await get_providers()
    providers = providers_response.get("data", [])

    provider = next((p for p in providers if p["id"] == request.provider_id), None)
    if not provider:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {request.provider_id}")

    base_url = await resolve_provider_url(provider["attributes"]["base_url"])

    # Build query parameters
    params = {
        "page_limit": request.page_limit,
        "page_offset": request.page_offset,
    }
    if request.filter:
        params["filter"] = request.filter
    if request.sort:
        params["sort"] = request.sort

    # Don't set response_fields by default — per the OPTIMADE spec, omitting it
    # makes providers return ALL required properties (including lattice_vectors,
    # cartesian_site_positions, species_at_sites, species). Setting it explicitly
    # can break providers that don't support the parameter or that interpret it
    # as a restrictive filter. Only pass it through if the caller explicitly set it.
    if request.response_fields:
        params["response_fields"] = request.response_fields

    # Try different URL patterns
    for endpoint_base in [f"{base_url}/v1/structures", f"{base_url}/structures"]:
        try:
            query_string = urlencode(params)
            url = f"{endpoint_base}?{query_string}"
            print(f"[OPTIMADE DEBUG] Fetching URL: {url}")
            data = await fetch_json(url)
            if "data" in data:
                return normalize_structure_ids(data)
        except Exception as e:
            print(f"[OPTIMADE DEBUG] Error fetching {endpoint_base}: {e}")
            continue

    raise HTTPException(status_code=500, detail="Failed to search structures")


@router.get("/proxy")
async def proxy_request(url: str = Query(..., description="URL to fetch")):
    """Generic proxy endpoint for OPTIMADE URLs.

    This allows the frontend to fetch any OPTIMADE URL through the backend,
    bypassing CORS restrictions.
    """
    # Validate URL is an OPTIMADE endpoint
    allowed_domains = [
        "optimade.materialsproject.org",
        "aiida.materialscloud.org",
        "alexandria.icams.rub.de",
        "www.materialscloud.org",
        "optimade.openmaterialsdb.se",
        "optimade.2dmatpedia.org",
        "providers.optimade.org",
    ]

    parsed = urlparse(url)
    if parsed.hostname not in allowed_domains:
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
