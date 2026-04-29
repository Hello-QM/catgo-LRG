"""Shared in-process viewer state — the single source of truth.

Both the FastAPI HTTP endpoints (view_capture.py) and the in-process MCP
server (mcp_http.py) operate on the same data through these functions.

This avoids the deadlock that occurs when mcp_http.py makes HTTP requests
back to view_capture.py through the same single-worker uvicorn process.
"""

from __future__ import annotations

import logging
from collections import Counter, deque
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-panel state stores
# ---------------------------------------------------------------------------

panel_structures: dict[str, dict[str, Any]] = {}
panel_pending_updates: dict[str, deque] = {}
panel_structure_info: dict[str, dict[str, Any]] = {}
panel_selections: dict[str, Any] = {}

pending_workflow_id: str = ""


# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------


def get_panel_pending(panel_id: str) -> deque:
    if panel_id not in panel_pending_updates:
        panel_pending_updates[panel_id] = deque(maxlen=16)
    return panel_pending_updates[panel_id]


def get_panel_selection(panel_id: str) -> Any:
    """Return selection state, creating an empty one if needed.

    Returns a dict (not SelectionState model) to avoid circular imports.
    The caller can construct the model if needed.
    """
    if panel_id not in panel_selections:
        panel_selections[panel_id] = {"indices": [], "atoms": []}
    return panel_selections[panel_id]


# ---------------------------------------------------------------------------
# Structure operations (used by both HTTP endpoints and in-process MCP)
# ---------------------------------------------------------------------------


def get_structure(panel_id: str = "default") -> dict | None:
    """Get the current structure dict for a panel. Returns None if empty."""
    struct = panel_structures.get(panel_id, {})
    return struct if struct else None


def push_structure(struct: dict, panel_id: str = "default") -> None:
    """Store structure and queue it for frontend polling."""
    panel_structures[panel_id] = struct
    get_panel_pending(panel_id).append(struct)
    n = len(struct.get("sites", []))
    logger.debug("Structure pushed for panel '%s': %d sites", panel_id, n)


def get_state_summary(panel_id: str = "default") -> dict[str, Any]:
    """Compact state summary — formula, lattice, selection, etc."""
    struct_dict = panel_structures.get(panel_id, {})
    if not struct_dict:
        return {"has_structure": False}

    info = panel_structure_info.get(panel_id, {})
    lattice = struct_dict.get("lattice", {})
    sites = struct_dict.get("sites", [])

    elements = info.get("elements", []) if info else []
    formula = info.get("formula", "") if info else ""
    if not elements and sites:
        counts: Counter[str] = Counter()
        for site in sites:
            for sp in site.get("species", []):
                el = sp.get("element", "")
                if el:
                    counts[el] += sp.get("occu", 1)
        elements = sorted(counts.keys())
        if not formula:
            formula = "".join(
                f"{el}{int(n)}" if n != 1 else el
                for el, n in sorted(counts.items())
            )

    selection = get_panel_selection(panel_id)
    sel_indices = selection.get("indices", []) if isinstance(selection, dict) else getattr(selection, "indices", [])

    return {
        "has_structure": True,
        "formula": formula or "?",
        "num_sites": info.get("num_sites", len(sites)) if info else len(sites),
        "elements": elements,
        "lattice": {
            "a": round(lattice.get("a", 0), 2),
            "b": round(lattice.get("b", 0), 2),
            "c": round(lattice.get("c", 0), 2),
        } if lattice else None,
        "space_group": info.get("space_group") if info else None,
        "selection": {
            "count": len(sel_indices),
            "indices": sel_indices[:20],
        },
    }


def get_selection_dict(panel_id: str = "default") -> dict[str, Any]:
    """Get selection as a plain dict."""
    sel = get_panel_selection(panel_id)
    if isinstance(sel, dict):
        return sel
    return {"indices": getattr(sel, "indices", []), "atoms": getattr(sel, "atoms", [])}


# ---------------------------------------------------------------------------
# Reset
# ---------------------------------------------------------------------------


def reset(panel_id: str = "") -> None:
    """Clear state for a panel, or all panels if panel_id is empty."""
    global pending_workflow_id

    if panel_id:
        panel_structures.pop(panel_id, None)
        panel_structure_info.pop(panel_id, None)
        panel_selections.pop(panel_id, None)
        pq = panel_pending_updates.pop(panel_id, None)
        if pq:
            pq.clear()
        logger.info("View state reset for panel '%s'", panel_id)
    else:
        panel_structures.clear()
        panel_structure_info.clear()
        panel_selections.clear()
        for pq in panel_pending_updates.values():
            pq.clear()
        panel_pending_updates.clear()
        pending_workflow_id = ""
        logger.info("View state reset (all panels)")
