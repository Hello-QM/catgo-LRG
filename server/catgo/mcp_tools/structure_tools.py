"""Structure/viewer tool handlers for the CatGO MCP server.

Contains OPTIMADE crystal search/fetch, PubChem molecule fetch,
set-lattice, and related conversion helpers.
"""

import logging

import httpx
from mcp.types import TextContent

from .helpers import API_BASE, _mat3_inverse, _push_structure_to_viewer

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# OPTIMADE / PubChem conversion helpers
# ---------------------------------------------------------------------------

def _optimade_to_pymatgen(entry: dict) -> dict:
    """Convert an OPTIMADE entry to a pymatgen-compatible Structure dict.

    Builds the dict manually to avoid importing pymatgen (~30s on Windows
    first import). The result matches pymatgen Structure.as_dict() format.
    """
    import math

    attrs = entry.get("attributes", {})
    lattice_vectors = attrs.get("lattice_vectors")
    positions = attrs.get("cartesian_site_positions")
    species_at_sites = attrs.get("species_at_sites")
    species_list = attrs.get("species", [])

    if not lattice_vectors or not positions or not species_at_sites:
        raise ValueError("OPTIMADE entry missing lattice_vectors, positions, or species_at_sites")

    # Build species name -> element mapping
    species_map = {}
    for sp in species_list:
        symbols = sp.get("chemical_symbols", [])
        concentrations = sp.get("concentration", [])
        if symbols and concentrations:
            idx = concentrations.index(max(concentrations))
            species_map[sp["name"]] = symbols[idx]
        elif symbols:
            species_map[sp["name"]] = symbols[0]

    elements = [species_map.get(s, s) for s in species_at_sites]

    # Compute lattice parameters from vectors
    a_vec, b_vec, c_vec = lattice_vectors
    def _norm(v):
        return math.sqrt(sum(x * x for x in v))
    def _dot(u, v):
        return sum(a * b for a, b in zip(u, v))
    def _angle(u, v):
        cos_a = max(-1.0, min(1.0, _dot(u, v) / (_norm(u) * _norm(v))))
        return math.degrees(math.acos(cos_a))

    a, b, c = _norm(a_vec), _norm(b_vec), _norm(c_vec)
    alpha, beta, gamma = _angle(b_vec, c_vec), _angle(a_vec, c_vec), _angle(a_vec, b_vec)
    cross = [
        a_vec[1] * b_vec[2] - a_vec[2] * b_vec[1],
        a_vec[2] * b_vec[0] - a_vec[0] * b_vec[2],
        a_vec[0] * b_vec[1] - a_vec[1] * b_vec[0],
    ]
    volume = abs(_dot(cross, c_vec))

    # Precompute inverse lattice matrix for Cartesian -> fractional conversion
    lat_matrix = [list(v) for v in lattice_vectors]
    inv_lat = _mat3_inverse(lat_matrix)

    sites = []
    for elem, xyz in zip(elements, positions):
        # Compute correct fractional coordinates from Cartesian
        frac = [
            sum(xyz[j] * inv_lat[j][k] for j in range(3))
            for k in range(3)
        ]
        sites.append({
            "species": [{"element": elem, "occu": 1}],
            "abc": frac,
            "xyz": list(xyz),
            "label": elem,
            "properties": {},
        })

    return {
        "@module": "pymatgen.core.structure",
        "@class": "Structure",
        "charge": 0,
        "lattice": {
            "@module": "pymatgen.core.lattice",
            "@class": "Lattice",
            "matrix": [list(v) for v in lattice_vectors],
            "pbc": [True, True, True],
            "a": a, "b": b, "c": c,
            "alpha": alpha, "beta": beta, "gamma": gamma,
            "volume": volume,
        },
        "properties": {},
        "sites": sites,
    }


def _pubchem_to_pymatgen(compound_data: dict) -> dict:
    """Convert PubChem compound JSON to a pymatgen-compatible Molecule dict.

    Builds the dict manually to avoid slow pymatgen import.
    """
    ELEMENT_TABLE = {
        1: "H", 2: "He", 3: "Li", 4: "Be", 5: "B", 6: "C", 7: "N", 8: "O",
        9: "F", 10: "Ne", 11: "Na", 12: "Mg", 13: "Al", 14: "Si", 15: "P",
        16: "S", 17: "Cl", 18: "Ar", 19: "K", 20: "Ca", 26: "Fe", 29: "Cu",
        30: "Zn", 35: "Br", 53: "I", 34: "Se", 33: "As",
    }

    atoms = compound_data.get("atoms", {})
    element_nums = atoms.get("element", [])
    coords_sets = compound_data.get("coords", [])

    if not element_nums or not coords_sets:
        raise ValueError("PubChem compound missing atoms or coordinates")

    elements = [ELEMENT_TABLE.get(n, f"X{n}") for n in element_nums]

    # PubChem's raw PUG-REST response nests coords under "conformers" —
    # coords[N].conformers[0].{x,y,z}. The CatGO backend proxy at
    # /api/pubchem/compound/{cid} flattens that to coords[N].{x,y,z}
    # directly. Accept either shape so this helper works regardless of
    # whether the caller hit the raw PubChem API or our proxy.
    coord_set = coords_sets[0]
    conformer = coord_set.get("conformers", [coord_set])[0] if "conformers" in coord_set else coord_set
    xs = conformer.get("x", [])
    ys = conformer.get("y", [])
    zs = conformer.get("z", [0.0] * len(xs))

    if not xs:
        raise ValueError(
            f"PubChem compound has no coordinates (coords keys: {list(coord_set.keys())})"
        )

    sites = []
    for elem, x, y, z in zip(elements, xs, ys, zs):
        sites.append({
            "species": [{"element": elem, "occu": 1}],
            "xyz": [x, y, z],
            "label": elem,
            "properties": {},
        })

    return {
        "@module": "pymatgen.core.structure",
        "@class": "Molecule",
        "charge": 0,
        "spin_multiplicity": 1,
        "sites": sites,
    }


_UNICODE_SUB_MAP = str.maketrans("\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089", "0123456789")


def _normalize_formula_alphabetical(formula: str) -> str:
    """Convert a chemical formula to OPTIMADE alphabetical reduced form.

    OPTIMADE requires chemical_formula_reduced to have elements in
    alphabetical order, e.g. "TiO2" -> "O2Ti", "Fe2O3" -> "Fe2O3" (already ok).
    """
    import re
    # Parse formula into (element, count) pairs
    tokens = re.findall(r'([A-Z][a-z]?)(\d*)', formula)
    pairs = [(el, int(cnt) if cnt else 1) for el, cnt in tokens if el]
    if not pairs:
        return formula
    # Sort alphabetically by element symbol
    pairs.sort(key=lambda x: x[0])
    # Rebuild formula, omit count if 1
    return "".join(f"{el}{cnt if cnt > 1 else ''}" for el, cnt in pairs)


def _build_optimade_filter(formula: str | None, elements: list[str] | None) -> str:
    """Build an OPTIMADE filter string from formula or elements."""
    parts = []
    if formula:
        # Normalize Unicode subscripts (e.g. TiO2 -> TiO2)
        formula = formula.translate(_UNICODE_SUB_MAP)
        # OPTIMADE requires alphabetical element order in reduced formula
        formula = _normalize_formula_alphabetical(formula)
        parts.append(f'chemical_formula_reduced="{formula}"')
    if elements:
        quoted = ",".join(f'"{e}"' for e in elements)
        parts.append(f"elements HAS ALL {quoted}")
    return " AND ".join(parts) if parts else ""


# Well-known OPTIMADE provider base URLs (avoids resolve_provider_url overhead)
_OPTIMADE_PROVIDERS = {
    "mp": "https://optimade.materialsproject.org",
    "mc3d": "https://aiida.materialscloud.org/mc3d/optimade",
    "alexandria": "https://alexandria.icams.rub.de/optimade",
    "mcloud": "https://www.materialscloud.org/optimade/main",
    "omdb": "https://optimade.openmaterialsdb.se",
    "twodmatpedia": "https://optimade.2dmatpedia.org",
}


async def _optimade_fetch_json(client: httpx.AsyncClient, url: str) -> dict:
    """Fetch JSON from an OPTIMADE API endpoint."""
    resp = await client.get(
        url,
        headers={"Accept": "application/vnd.api+json"},
        follow_redirects=True,
    )
    resp.raise_for_status()
    return resp.json()


async def _optimade_search_direct(
    client: httpx.AsyncClient,
    provider: str,
    filter_str: str,
    page_limit: int = 5,
) -> list[dict]:
    """Search OPTIMADE provider directly (bypasses FastAPI backend proxy).

    This avoids nested HTTP timeouts: MCP -> FastAPI -> OPTIMADE.
    Instead: MCP -> OPTIMADE directly.
    """
    base_url = _OPTIMADE_PROVIDERS.get(provider)
    if not base_url:
        raise ValueError(f"Unknown provider '{provider}'. Available: {', '.join(_OPTIMADE_PROVIDERS)}")

    from urllib.parse import urlencode
    params: dict = {"page_limit": page_limit}
    if filter_str:
        params["filter"] = filter_str
    qs = urlencode(params)

    # Try /v1/structures then /structures
    for path in [f"{base_url}/v1/structures", f"{base_url}/structures"]:
        try:
            url = f"{path}?{qs}"
            logger.info("OPTIMADE direct search: %s", url)
            data = await _optimade_fetch_json(client, url)
            entries = data.get("data", [])
            if isinstance(entries, list):
                # Coerce IDs to strings (some providers return numeric IDs)
                for entry in entries:
                    if isinstance(entry, dict) and "id" in entry:
                        entry["id"] = str(entry["id"])
                return entries
        except Exception as exc:
            logger.warning("OPTIMADE search failed for %s: %s", path, exc)
            continue
    return []


async def _optimade_fetch_by_id_direct(
    client: httpx.AsyncClient,
    provider: str,
    structure_id: str,
) -> dict | None:
    """Fetch a single structure by ID directly from OPTIMADE provider."""
    base_url = _OPTIMADE_PROVIDERS.get(provider)
    if not base_url:
        raise ValueError(f"Unknown provider '{provider}'.")

    for path in [
        f"{base_url}/v1/structures/{structure_id}",
        f"{base_url}/structures/{structure_id}",
    ]:
        try:
            logger.info("OPTIMADE direct fetch: %s", path)
            data = await _optimade_fetch_json(client, path)
            entry = data.get("data")
            if entry:
                if isinstance(entry, dict) and "id" in entry:
                    entry["id"] = str(entry["id"])
                return entry
        except Exception as exc:
            logger.warning("OPTIMADE fetch failed for %s: %s", path, exc)
            continue
    return None


# ---------------------------------------------------------------------------
# Special tool handlers for structure/viewer operations
# ---------------------------------------------------------------------------

async def _handle_set_lattice(client: httpx.AsyncClient, arguments: dict) -> list[TextContent]:
    """Handle __special__/set-lattice tool."""
    resp = await client.get(f"{API_BASE}/view/structure/current")
    if resp.status_code != 200:
        return [TextContent(type="text", text="No structure loaded in viewer. Load a structure first.")]
    current_structure = resp.json()
    payload = {**arguments, "structure": current_structure}
    resp = await client.post(f"{API_BASE}/structure-ops/set-lattice", json=payload)
    if resp.status_code == 200:
        data = resp.json()
        new_struct = data.get("structure", {})
        push_err = await _push_structure_to_viewer(client, new_struct)
        lat = new_struct.get("lattice", {})
        msg = (
            f"Lattice set successfully. "
            f"a={lat.get('a', 0):.2f} b={lat.get('b', 0):.2f} c={lat.get('c', 0):.2f} \u00c5, "
            f"alpha={lat.get('alpha', 90):.1f} beta={lat.get('beta', 90):.1f} gamma={lat.get('gamma', 90):.1f}\u00b0. "
            f"Structure now has {data.get('num_sites', '?')} sites with periodic boundaries."
        )
        if push_err:
            msg += f"\n\u26a0\ufe0f Viewer push failed: {push_err}"
        return [TextContent(type="text", text=msg)]
    else:
        return [TextContent(type="text", text=f"set-lattice failed ({resp.status_code}): {resp.text[:300]}")]


def _pick_most_stable(entries: list[dict]) -> dict:
    """Pick the most thermodynamically stable entry from OPTIMADE results.

    Prefers structures with energy_above_hull = 0 (ground state).
    Falls back to the entry with the lowest energy_above_hull.
    If no stability data is available, returns the first entry.
    """
    best = entries[0]
    best_ehull = float("inf")

    for entry in entries:
        stability = entry.get("attributes", {}).get("_mp_stability", {})
        # Check all functional tiers for energy_above_hull
        ehull = float("inf")
        for tier_data in stability.values():
            if isinstance(tier_data, dict):
                val = tier_data.get("energy_above_hull")
                if val is not None and val < ehull:
                    ehull = val

        if ehull < best_ehull:
            best_ehull = ehull
            best = entry

    if best_ehull < float("inf"):
        logger.info("[fetch-crystal] picked %s (E_hull=%.4f eV) from %d candidates",
                    best.get("id"), best_ehull, len(entries))
    return best


async def _handle_fetch_crystal(client: httpx.AsyncClient, arguments: dict) -> list[TextContent]:
    """Handle __special__/fetch-crystal tool."""
    formula = arguments.get("formula")
    elements = arguments.get("elements")
    provider = arguments.get("provider", "mp")
    structure_id = arguments.get("structure_id")
    logger.info("[fetch-crystal] formula=%s elements=%s provider=%s id=%s", formula, elements, provider, structure_id)

    if not formula and not elements and not structure_id:
        return [TextContent(type="text", text="Provide at least one of: formula, elements, or structure_id.")]

    if structure_id:
        entry = await _optimade_fetch_by_id_direct(client, provider, structure_id)
    else:
        filt = _build_optimade_filter(formula, elements)
        logger.info("[fetch-crystal] filter=%s", filt)
        # Fetch multiple candidates and prefer the ground-state structure
        # (lowest energy_above_hull). OPTIMADE default ordering doesn't
        # guarantee the most stable phase comes first.
        entries = await _optimade_search_direct(client, provider, filt, page_limit=10)
        entry = _pick_most_stable(entries) if entries else None

    if not entry:
        hint = f"formula '{formula}'" if formula else f"elements {elements}"
        logger.info("[fetch-crystal] no entries found")
        return [TextContent(type="text", text=(
            f"No structures matching {hint} found in '{provider}'. "
            f"Try a different formula or provider (mp, mc3d, alexandria, omdb, twodmatpedia)."
        ))]

    logger.info("[fetch-crystal] got entry id=%s", entry.get("id"))
    try:
        struct_dict = _optimade_to_pymatgen(entry)
        logger.info("[fetch-crystal] pymatgen conversion ok, %d sites", len(struct_dict.get("sites", [])))
    except Exception as exc:
        logger.error("[fetch-crystal] pymatgen conversion failed: %s", exc)
        return [TextContent(type="text", text=f"Failed to convert OPTIMADE structure: {exc}")]

    # Standardize to conventional cell via backend (pymatgen SpacegroupAnalyzer).
    # OPTIMADE APIs often return non-standard lattice orientations (e.g. mp-825
    # RuO2 has a/c axes swapped). Without this, Miller indices point wrong.
    try:
        conv_resp = await client.post(
            f"{API_BASE}/structure-ops/conventional-cell",
            json={"structure": struct_dict},
            timeout=15.0,
        )
        if conv_resp.status_code == 200:
            conv_data = conv_resp.json()
            if conv_data.get("structure"):
                struct_dict = conv_data["structure"]
                logger.info("[fetch-crystal] standardized to conventional cell, %d sites",
                            len(struct_dict.get("sites", [])))
        else:
            logger.warning("[fetch-crystal] conventional cell endpoint returned %d, using raw", conv_resp.status_code)
    except Exception as exc:
        logger.warning("[fetch-crystal] conventional cell standardization failed: %s, using raw", exc)

    push_err = await _push_structure_to_viewer(client, struct_dict, intent="load")
    logger.info("[fetch-crystal] push result: %s", push_err or "ok")

    # Build summary
    attrs = entry.get("attributes", {})
    eid = entry.get("id", "?")
    formula_pretty = attrs.get("chemical_formula_descriptive") or attrs.get("chemical_formula_reduced", "?")
    nsites = len(struct_dict.get("sites", []))
    sg = attrs.get("_mp_spacegroup_symbol") or attrs.get("space_group_symbol", "")
    sg_text = f", space group {sg}" if sg else ""

    # Add stability info if available
    stability = attrs.get("_mp_stability", {})
    ehull_text = ""
    for tier_data in stability.values():
        if isinstance(tier_data, dict) and "energy_above_hull" in tier_data:
            ehull = tier_data["energy_above_hull"]
            if ehull == 0 or ehull == 0.0:
                ehull_text = " (ground state)"
            else:
                ehull_text = f" ({ehull:.3f} eV above hull — metastable)"
            break

    msg = (
        f"Loaded {formula_pretty} ({eid}) from {provider}: "
        f"{nsites} atoms{sg_text}{ehull_text}."
    )
    if push_err:
        msg += f" Warning: {push_err}"
    else:
        msg += " Structure is now displayed in the viewer."
    logger.info("[fetch-crystal] returning: %s", msg)
    return [TextContent(type="text", text=msg)]


async def _handle_search_crystals(client: httpx.AsyncClient, arguments: dict) -> list[TextContent]:
    """Handle __special__/search-crystals tool."""
    formula = arguments.get("formula")
    elements = arguments.get("elements")
    provider = arguments.get("provider", "mp")
    limit = arguments.get("limit", 5)

    if not formula and not elements:
        return [TextContent(type="text", text="Provide formula or elements to search.")]

    filt = _build_optimade_filter(formula, elements)
    entries = await _optimade_search_direct(client, provider, filt, page_limit=limit)

    if not entries:
        return [TextContent(type="text", text=f"No structures found. Try a different formula or provider.")]

    lines = [f"Found {len(entries)} structure(s) in '{provider}':"]
    for e in entries:
        eid = e.get("id", "?")
        a = e.get("attributes", {})
        f_str = a.get("chemical_formula_descriptive") or a.get("chemical_formula_reduced", "?")
        nsites = a.get("nsites", "?")
        sg = a.get("_mp_spacegroup_symbol") or a.get("space_group_symbol", "")
        lines.append(f"  - {eid}: {f_str}, {nsites} atoms{f', {sg}' if sg else ''}")
    lines.append("\nUse catgo_fetch_crystal with structure_id to load one.")
    return [TextContent(type="text", text="\n".join(lines))]


async def _handle_fetch_molecule(client: httpx.AsyncClient, arguments: dict) -> list[TextContent]:
    """Handle __special__/fetch-molecule tool."""
    query = arguments.get("query")
    search_type = arguments.get("search_type", "name")
    cid = arguments.get("cid")

    if not query and not cid:
        return [TextContent(type="text", text="Provide a query (compound name/formula) or cid.")]

    # Resolve CID if not provided
    if not cid:
        resp = await client.get(f"{API_BASE}/pubchem/search", params={
            "term": query, "search_type": search_type, "max_results": 1,
        })
        if resp.status_code != 200:
            return [TextContent(type="text", text=f"PubChem search failed: {resp.text[:300]}")]
        compounds = resp.json().get("compounds", [])
        if not compounds:
            return [TextContent(type="text", text=f"No compound found for '{query}' on PubChem.")]
        cid = compounds[0]["cid"]
        compound_name = compounds[0].get("name", query)
        compound_formula = compounds[0].get("formula", "")
    else:
        compound_name = str(cid)
        compound_formula = ""

    # Fetch 3D structure (auto-falls back to 2D in the backend)
    resp = await client.get(f"{API_BASE}/pubchem/compound/{cid}", params={"record_type": "3d"})
    if resp.status_code != 200:
        return [TextContent(type="text", text=f"Failed to fetch compound {cid}: {resp.text[:300]}")]

    try:
        struct_dict = _pubchem_to_pymatgen(resp.json())
    except Exception as exc:
        return [TextContent(type="text", text=f"Failed to convert PubChem structure: {exc}")]

    push_err = await _push_structure_to_viewer(client, struct_dict, intent="load")

    nsites = len(struct_dict.get("sites", []))
    desc = compound_name
    if compound_formula:
        desc = f"{compound_name} ({compound_formula})"
    msg = f"Loaded {desc} (CID {cid}) from PubChem: {nsites} atoms."
    if push_err:
        msg += f" Warning: {push_err}"
    else:
        msg += " Structure is now displayed in the viewer."
    return [TextContent(type="text", text=msg)]
