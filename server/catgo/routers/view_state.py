"""Shared in-process viewer state — the single source of truth.

Both the FastAPI HTTP endpoints (view_capture.py) and the in-process MCP
server (mcp_http.py) operate on the same data through these functions.

This avoids the deadlock that occurs when mcp_http.py makes HTTP requests
back to view_capture.py through the same single-worker uvicorn process.

Two cross-cutting concerns also live here:
  * SSE subscriber registry — push real-time structure/workflow events to
    the frontend without 500ms polling. See view_capture.py /subscribe.
  * Active-panel tracking — `last_active_panel_id` lets readers without a
    specific panel target (e.g., lab claude over SSH with no
    X-CatGo-Tab-Id header) see whichever panel the user is touching,
    rather than the literal "default" Remote-pane inbox.
"""

from __future__ import annotations

import asyncio
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
# Trajectories live in a separate map. Storage is the raw text plus a
# filename hint — the frontend's parse_trajectory_data already handles
# every supported format (xyz multi-frame, extxyz, LAMMPS dump, xdatcar,
# vasprun, ...) so we don't replicate the parser server-side.
panel_trajectories: dict[str, dict[str, str]] = {}

pending_workflow_id: str = ""

# ---------------------------------------------------------------------------
# SSE subscriber registry
# ---------------------------------------------------------------------------
#
# Each subscriber owns an asyncio.Queue. The /view/subscribe endpoint
# yields events from the queue to the client; writers (push_structure,
# notify_workflow) put events into every queue registered for the panel.
# QueueFull means a subscriber fell too far behind — drop the event for
# them rather than blocking the writer.

panel_subscribers: dict[str, list[asyncio.Queue]] = {}


def subscribe(panel_id: str) -> asyncio.Queue:
    """Register a new SSE subscriber. Returns its queue."""
    if panel_id not in panel_subscribers:
        panel_subscribers[panel_id] = []
    q: asyncio.Queue = asyncio.Queue(maxsize=32)
    panel_subscribers[panel_id].append(q)
    return q


def unsubscribe(panel_id: str, q: asyncio.Queue) -> None:
    """Remove a subscriber. Safe to call multiple times."""
    subs = panel_subscribers.get(panel_id, [])
    if q in subs:
        subs.remove(q)


def has_subscribers(panel_id: str) -> bool:
    """Whether any SSE subscriber is currently listening on this panel."""
    return bool(panel_subscribers.get(panel_id))


def _notify(panel_id: str, event: str, data: dict) -> None:
    msg = {"event": event, "data": data}
    for q in list(panel_subscribers.get(panel_id, [])):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            logger.warning(
                "SSE subscriber queue full for panel '%s' (event=%s) — dropping",
                panel_id, event,
            )


def notify_structure(
    panel_id: str, struct: dict, intent: str = "edit", had_structure: bool = False
) -> None:
    """Notify SSE subscribers that a new structure is available.

    `intent` tags whether this push EDITS the existing structure (default —
    the viewer applies it in place) or LOADS a fresh one ("load" — the
    frontend may prompt the user before overwriting). Carried through to the
    SSE event payload so the frontend can gate on it.

    `had_structure` is whether the target panel ALREADY held a non-empty
    structure BEFORE this push. The frontend's hold-gate ORs this
    backend-authoritative flag against its own (racy) structure read, so a
    `load` into an occupied pane is held even when a scene remount /
    `view/reset` momentarily makes the FE read empty. The PASSED value is
    used verbatim — do NOT self-compute here, because by the time the
    pending-update leg calls this the /push leg may have already overwritten
    the store (making a re-derived value wrong).
    """
    _notify(
        panel_id,
        "structure",
        {"structure": struct, "intent": intent, "had_structure": had_structure},
    )


def notify_workflow(panel_id: str, workflow_id: str) -> None:
    """Notify SSE subscribers of a workflow navigation request."""
    _notify(panel_id, "workflow", {"workflow_id": workflow_id})


def notify_trajectory(panel_id: str, content: str, filename: str) -> None:
    """Notify SSE subscribers of a multi-frame trajectory upload.

    Carries the raw text so the frontend's `parse_trajectory_data` can
    handle every supported format (XYZ multi-frame, extxyz, LAMMPS
    dump, XDATCAR, etc.) without re-implementing the parser server-side.
    """
    _notify(panel_id, "trajectory", {"content": content, "filename": filename})


def push_trajectory(panel_id: str, content: str, filename: str) -> None:
    """Store trajectory + notify SSE subscribers + clear any stale
    single-structure cache for the same panel (mutually exclusive in
    the viewer — a pane shows EITHER a structure OR a trajectory).
    Replayed on (re)connect via the SSE snapshot mechanism."""
    panel_trajectories[panel_id] = {"content": content, "filename": filename}
    panel_structures.pop(panel_id, None)
    panel_pending_updates.pop(panel_id, None)
    notify_trajectory(panel_id, content, filename)


def get_trajectory(panel_id: str) -> dict | None:
    """Return {'content': str, 'filename': str} or None."""
    return panel_trajectories.get(panel_id)


# ---------------------------------------------------------------------------
# Active-panel tracking (asymmetric read)
# ---------------------------------------------------------------------------
#
# When lab claude reads state without an X-CatGo-Tab-Id header, the
# legacy behavior was to read panel_id="default" — but that's the
# Remote-pane inbox, not whichever pane the user is touching.
# `last_active_panel_id` is updated by frontend-originated endpoints
# (/structure/push, /structure-info/update, /selection/update) and used
# by the get_active_* helpers below. MCP-originated pushes intentionally
# do NOT update it (lab shouldn't hijack the notion of "active").

last_active_panel_id: str = "default"


def mark_active(panel_id: str) -> None:
    """Mark a panel as the most recently active (user-touched)."""
    global last_active_panel_id
    if panel_id:
        last_active_panel_id = panel_id


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
    """
    if panel_id not in panel_selections:
        panel_selections[panel_id] = {"indices": [], "atoms": []}
    return panel_selections[panel_id]


# ---------------------------------------------------------------------------
# Structure operations (used by both HTTP endpoints and in-process MCP)
# ---------------------------------------------------------------------------


def get_structure(panel_id: str = "default") -> dict | None:
    """Get the structure dict for a SPECIFIC panel. Returns None if empty."""
    struct = panel_structures.get(panel_id, {})
    return struct if struct else None


def get_active_structure() -> dict | None:
    """Asymmetric-read entry: structure for whichever panel the user
    most recently touched. Used by lab claude with no panel header."""
    return get_structure(last_active_panel_id)


def push_structure(
    struct: dict,
    panel_id: str = "default",
    intent: str = "edit",
    had_structure: bool | None = None,
) -> None:
    """Store structure, queue for legacy poll, and notify SSE subscribers.

    Does NOT call mark_active — this is the path MCP pushes take, and lab
    pushes shouldn't change the user's idea of which panel is "active".

    `intent` ("edit" default | "load") rides along into the SSE event so the
    frontend can prompt before overwriting on a fresh load. See
    `notify_structure` for the full rationale.

    `had_structure` is whether the target panel was occupied BEFORE this
    push (the backend-authoritative hold signal). When None it is
    self-computed HERE, before the store write — this is the in-process
    path (upload-and-load, `_push_structure_direct`) which overwrites the
    store itself, so we must capture occupancy first.
    """
    if had_structure is None:
        had_structure = bool(panel_structures.get(panel_id))
    panel_structures[panel_id] = struct
    get_panel_pending(panel_id).append(struct)
    _notify(
        panel_id,
        "structure",
        {"structure": struct, "intent": intent, "had_structure": had_structure},
    )
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
        "panel_id": panel_id,
    }


def get_active_state_summary() -> dict[str, Any]:
    """Asymmetric-read entry: summary for whichever panel is currently active."""
    return get_state_summary(last_active_panel_id)


def get_selection_dict(panel_id: str = "default") -> dict[str, Any]:
    """Get selection as a plain dict for a specific panel."""
    sel = get_panel_selection(panel_id)
    if isinstance(sel, dict):
        return sel
    return {"indices": getattr(sel, "indices", []), "atoms": getattr(sel, "atoms", [])}


def get_active_selection_dict() -> dict[str, Any]:
    """Asymmetric-read entry: selection for whichever panel is currently active."""
    return get_selection_dict(last_active_panel_id)


# ---------------------------------------------------------------------------
# Reset
# ---------------------------------------------------------------------------


def reset(panel_id: str = "") -> None:
    """Clear state for a panel, or all panels if panel_id is empty."""
    global pending_workflow_id, last_active_panel_id

    if panel_id:
        panel_structures.pop(panel_id, None)
        panel_structure_info.pop(panel_id, None)
        panel_selections.pop(panel_id, None)
        panel_trajectories.pop(panel_id, None)
        pq = panel_pending_updates.pop(panel_id, None)
        if pq:
            pq.clear()
        if last_active_panel_id == panel_id:
            last_active_panel_id = "default"
        logger.info("View state reset for panel '%s'", panel_id)
    else:
        panel_structures.clear()
        panel_structure_info.clear()
        panel_selections.clear()
        panel_trajectories.clear()
        for pq in panel_pending_updates.values():
            pq.clear()
        panel_pending_updates.clear()
        pending_workflow_id = ""
        last_active_panel_id = "default"
        logger.info("View state reset (all panels)")
