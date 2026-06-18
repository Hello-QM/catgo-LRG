"""Shared helper functions for MCP tool handlers."""

import logging
import os
import re
from contextvars import ContextVar

import httpx
from mcp.types import TextContent

logger = logging.getLogger(__name__)

# Per-request tab identifier, set by the MCP HTTP middleware from the
# `X-CatGo-Tab-Id` header and read here when a tool helper is not given an
# explicit panel_id. Lets the SDK adapter on the frontend tell the backend
# which tab (= which viewer panel) should receive structure/workflow pushes,
# without threading tab_id through every MCP tool input schema.
#
# Defaults to "default" so the standalone MCP HTTP endpoints (Claude Code CLI,
# Gemini, Codex) keep working unchanged — they just land in the legacy
# single-panel bucket that the landing-page preview cards poll.
current_panel_id: ContextVar[str] = ContextVar("current_panel_id", default="default")


def _resolve_api_base() -> str:
    """Compute the CatGO backend base URL that MCP tools call back into.

    Same resolution order as
    ``catgo.routers.chat_multi.providers._get_catgo_api_url`` — we cannot
    import that module here without creating a cycle (chat_multi itself
    imports from mcp_tools), so the logic is duplicated.

    Order:
      1. ``CATGO_API`` env var  (explicit override for tests / docker)
      2. ``SERVER_PORT`` env var
      3. ``main.SERVER_PORT`` of the live FastAPI process, if importable
      4. Recompute from cwd using the worktree-offset hash shared with
         ``server/main.py::_worktree_offset`` and
         ``vite.shared.ts::worktree_offset`` — every worktree therefore
         targets its own backend without colliding with the main repo.
      5. Fall back to ``http://localhost:8000/api`` as last resort.
    """
    if url := os.environ.get("CATGO_API"):
        return url

    port = int(os.environ.get("SERVER_PORT", 0))

    if not port:
        import sys as _sys
        main_mod = _sys.modules.get("main") or _sys.modules.get("__main__")
        if main_mod is not None:
            live = getattr(main_mod, "SERVER_PORT", 0)
            if isinstance(live, int) and live:
                port = live

    if not port:
        cwd = os.path.abspath(".")
        match = re.search(r"\.(?:claude[/\\])?worktrees[/\\]([^/\\]+)", cwd)
        if match:
            h = 0
            for ch in match.group(1):
                h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
                if h & 0x80000000:
                    h -= 0x100000000
            port = 8000 + 1 + (abs(h) % 99)
        else:
            port = 8000

    return f"http://localhost:{port}/api"


API_BASE = _resolve_api_base()


def _strip_structure_from_schema(schema: dict) -> dict:
    """Remove 'structure' from MCP tool schemas — auto-injected from viewer."""
    schema = dict(schema)
    props = schema.get("properties", {})
    if "structure" in props:
        schema["properties"] = {k: v for k, v in props.items() if k != "structure"}
        req = schema.get("required", [])
        if "structure" in req:
            schema["required"] = [r for r in req if r != "structure"]
    return schema


def _summarize_structure_result(data: dict) -> str:
    """Return a concise summary of a structure-modifying tool result."""
    parts = []
    struct = data.get("structure", {})
    sites = struct.get("sites", [])
    num_sites = data.get("num_sites", len(sites))

    # Composition summary
    from collections import Counter
    species_count = Counter()
    for site in sites:
        label = site.get("label", site.get("species", [{}])[0].get("element", "?"))
        species_count[label] += 1
    formula = " ".join(f"{el}{n}" for el, n in sorted(species_count.items()))

    parts.append(f"Done. Structure updated in viewer: {num_sites} atoms ({formula}).")

    # Lattice info if present
    lat = struct.get("lattice", {})
    if lat:
        parts.append(
            f"Cell: a={lat.get('a', 0):.2f} b={lat.get('b', 0):.2f} c={lat.get('c', 0):.2f} \u00c5."
        )

    # Include any extra non-structure fields (e.g. "message", "adsorption_energy")
    for key, val in data.items():
        if key not in ("structure", "num_sites") and isinstance(val, (str, int, float)):
            parts.append(f"{key}: {val}")

    return " ".join(parts)


def _mat3_inverse(m: list[list[float]]) -> list[list[float]]:
    """Inverse of a 3x3 matrix using cofactor expansion (pure Python)."""
    a, b, c = m[0]
    d, e, f = m[1]
    g, h, i = m[2]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-12:
        raise ValueError("Singular lattice matrix")
    inv_det = 1.0 / det
    return [
        [(e * i - f * h) * inv_det, (c * h - b * i) * inv_det, (b * f - c * e) * inv_det],
        [(f * g - d * i) * inv_det, (a * i - c * g) * inv_det, (c * d - a * f) * inv_det],
        [(d * h - e * g) * inv_det, (b * g - a * h) * inv_det, (a * e - b * d) * inv_det],
    ]


def _cart_to_frac(lattice_matrix: list[list[float]], cart_xyz: list[float]) -> list[float]:
    """Convert Cartesian coordinates to fractional using lattice matrix inverse."""
    inv_m = _mat3_inverse(lattice_matrix)
    # frac = cart @ M^{-1}  (M rows = lattice vectors)
    return [
        sum(cart_xyz[j] * inv_m[j][k] for j in range(3))
        for k in range(3)
    ]


async def _push_structure_to_viewer(
    client: httpx.AsyncClient, struct_dict: dict, panel_id: str | None = None,
    intent: str = "edit",
) -> str | None:
    """Push a pymatgen structure dict to the CatGO viewer.

    Args:
        client: httpx client instance.
        struct_dict: pymatgen-compatible structure dictionary.
        panel_id: Target panel identifier. When None, falls back to the
            ``current_panel_id`` ContextVar — which MCP HTTP middleware sets
            from the ``X-CatGo-Tab-Id`` header so pushes land in the tab that
            actually issued the chat request.
        intent: ``"edit"`` (default — apply in place) or ``"load"`` (a fresh
            load; the frontend may prompt before overwriting an existing
            structure). Forwarded as a query param to BOTH endpoints so the
            SSE ``structure`` event carries the tag regardless of which leg
            the frontend acts on first.

    Returns None on success, or an error message string on failure.
    Never raises — errors are returned as strings so the tool can still
    report search results even if the viewer push fails.
    """
    target_panel = panel_id if panel_id is not None else current_panel_id.get()
    try:
        # Probe whether the target panel is ALREADY occupied BEFORE either
        # push leg overwrites the store. This backend-authoritative flag
        # rides into the SSE event so the frontend's hold-gate can OR it
        # against its own (racy) structure read — a load into an occupied
        # pane is held even when a scene remount makes the FE momentarily
        # read empty. The GET only borrows another panel's structure for the
        # "default" sentinel, so an explicit empty panel correctly 404s →
        # had_structure stays False.
        had_structure = False
        try:
            _r = await client.get(
                f"{API_BASE}/view/structure/current", params={"panel_id": target_panel}
            )
            if _r.status_code == 200:
                had_structure = bool((_r.json() or {}).get("sites"))
        except Exception:
            pass
        await client.post(
            f"{API_BASE}/view/structure/push",
            params={"panel_id": target_panel, "intent": intent},
            json={"structure": struct_dict},
        )
        await client.post(
            f"{API_BASE}/view/structure/pending-update",
            params={
                "panel_id": target_panel,
                "intent": intent,
                "had_structure": str(had_structure).lower(),
            },
            json={"structure": struct_dict},
        )
        return None
    except httpx.ConnectError:
        return f"Cannot connect to CatGO backend at {API_BASE} to push structure to viewer."
    except Exception as exc:
        return f"Failed to push structure to viewer: {exc}"


async def _push_workflow_navigate(
    client: httpx.AsyncClient, workflow_id: str, panel_id: str | None = None,
) -> None:
    """Signal the frontend to navigate to a workflow (best-effort, never raises).

    Carries panel_id (default: the ``current_panel_id`` ContextVar) so the
    backend can route the navigate signal to the tab that initiated the
    MCP call — otherwise it lands in a shared bucket and whichever tab
    polls first consumes it, potentially opening the workflow in the
    wrong tab.
    """
    target = panel_id if panel_id is not None else current_panel_id.get()
    try:
        await client.post(
            f"{API_BASE}/view/workflow/pending-navigate",
            json={"workflow_id": workflow_id, "panel_id": target},
        )
    except Exception:
        pass  # Non-critical: AI chat still shows text result
