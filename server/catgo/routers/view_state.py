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
import re
import uuid
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
panel_manifests: dict[str, dict[str, Any]] = {}

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
pending_commands: dict[str, asyncio.Future] = {}


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
    frontend may prompt before overwriting). `had_structure` is the
    backend-authoritative "panel already occupied" flag. Both ride into the
    SSE payload so the frontend hold-gate (`should_apply_push`) survives the
    scene-remount race. See PR #372.
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


async def request_viewer_command(
    panel_id: str,
    action: str,
    arguments: dict[str, Any],
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Send a command to one mounted viewer and await its result."""
    if not has_subscribers(panel_id):
        return {
            "ok": False,
            "error": f"Viewer '{panel_id}' is not mounted or no longer exists.",
        }
    loop = asyncio.get_running_loop()
    # uuid (not id(loop)+loop.time(), which can collide for two commands issued
    # in the same tick and clobber each other's pending future).
    command_id = f"cmd-{uuid.uuid4().hex}"
    future = loop.create_future()
    pending_commands[command_id] = future
    _notify(panel_id, "command", {
        "command_id": command_id,
        "action": action,
        "arguments": arguments,
    })
    try:
        return await asyncio.wait_for(future, timeout=timeout)
    finally:
        pending_commands.pop(command_id, None)


def complete_viewer_command(command_id: str, result: dict[str, Any]) -> bool:
    future = pending_commands.get(command_id)
    if not future or future.done():
        return False
    future.set_result(result)
    return True


def push_trajectory(panel_id: str, content: str, filename: str) -> None:
    """Store trajectory + notify SSE subscribers + clear any stale
    single-structure cache for the same panel (mutually exclusive in
    the viewer — a pane shows EITHER a structure OR a trajectory).
    Replayed on (re)connect via the SSE snapshot mechanism."""
    panel_id = resolve_panel_id(panel_id)
    panel_trajectories[panel_id] = {"content": content, "filename": filename}
    panel_structures.pop(panel_id, None)
    panel_pending_updates.pop(panel_id, None)
    notify_trajectory(panel_id, content, filename)


def get_trajectory(panel_id: str) -> dict | None:
    """Return {'content': str, 'filename': str} or None."""
    return panel_trajectories.get(resolve_panel_id(panel_id))


def update_manifest(panel_id: str, manifest: dict[str, Any]) -> None:
    panel_manifests[panel_id] = {**manifest, "viewer_id": panel_id}


def remove_manifest(panel_id: str) -> None:
    panel_manifests.pop(panel_id, None)


def list_manifests(tab_id: str = "") -> list[dict[str, Any]]:
    manifests = [
        manifest for manifest in panel_manifests.values()
        if not tab_id or manifest.get("tab_id") == tab_id
    ]
    return sorted(manifests, key=lambda item: item.get("pane_number", 0))


def resolve_viewer_ref(ref: str, tab_id: str = "") -> tuple[str | None, str | None]:
    """Resolve an exact viewer id or a unique manifest position/name."""
    if ref in panel_manifests or has_subscribers(ref):
        return ref, None
    position_aliases = {
        "左": "left", "右": "right", "上": "top", "下": "bottom",
        "左上": "top-left", "右上": "top-right",
        "左下": "bottom-left", "右下": "bottom-right",
        "左上角": "top-left", "右上角": "top-right",
        "左下角": "bottom-left", "右下角": "bottom-right",
    }
    normalized = ref.strip().lower().replace(" ", "-")
    position = position_aliases.get(ref.strip(), normalized)
    ref_l = ref.strip().lower()
    pane_match = re.fullmatch(r"(?:pane|window|窗口)[-_ ]?(\d+)", normalized)
    pane_number = int(pane_match.group(1)) if pane_match else None

    def _filename_matches(filename: object) -> bool:
        # Exact name or stem only — substring ("o" → "POSCAR") routes to the
        # wrong pane.
        name = str(filename or "").lower()
        if not name:
            return False
        stem = name.rsplit(".", 1)[0] if "." in name else name
        return ref_l in (name, stem)

    matches = [
        manifest for manifest in list_manifests(tab_id)
        if manifest.get("position") == position
        or str(manifest.get("label") or "").lower() == ref_l
        or (pane_number is not None and manifest.get("pane_number") == pane_number)
        or _filename_matches(manifest.get("filename"))
    ]
    if len(matches) == 1:
        return str(matches[0]["viewer_id"]), None
    if len(matches) > 1:
        ids = ", ".join(str(item["viewer_id"]) for item in matches)
        return None, f"Viewer reference '{ref}' is ambiguous: {ids}"
    return None, f"Viewer '{ref}' was not found"


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
active_viewer_by_tab: dict[str, str] = {}


def _tab_id_for_viewer(panel_id: str) -> str | None:
    """Return the owning tab for a stable ``<tab>:<leaf>`` viewer id."""
    if ":" not in panel_id:
        return None
    tab_id, _leaf_id = panel_id.rsplit(":", 1)
    return tab_id or None


def resolve_panel_id(panel_id: str) -> str:
    """Resolve a legacy tab target to that tab's currently active viewer."""
    if ":" not in panel_id and panel_id in active_viewer_by_tab:
        return active_viewer_by_tab[panel_id]
    return panel_id


def mark_active(panel_id: str) -> None:
    """Mark a panel as the most recently active (user-touched)."""
    global last_active_panel_id
    if panel_id:
        last_active_panel_id = panel_id
        tab_id = _tab_id_for_viewer(panel_id)
        if tab_id:
            active_viewer_by_tab[tab_id] = panel_id


# ---------------------------------------------------------------------------
# Accessors
# ---------------------------------------------------------------------------


def get_panel_pending(panel_id: str) -> deque:
    panel_id = resolve_panel_id(panel_id)
    if panel_id not in panel_pending_updates:
        panel_pending_updates[panel_id] = deque(maxlen=16)
    return panel_pending_updates[panel_id]


def get_panel_selection(panel_id: str) -> Any:
    """Return selection state, creating an empty one if needed.

    Returns a dict (not SelectionState model) to avoid circular imports.
    """
    panel_id = resolve_panel_id(panel_id)
    if panel_id not in panel_selections:
        panel_selections[panel_id] = {"indices": [], "atoms": []}
    return panel_selections[panel_id]


# ---------------------------------------------------------------------------
# Structure operations (used by both HTTP endpoints and in-process MCP)
# ---------------------------------------------------------------------------


def get_structure(panel_id: str = "default") -> dict | None:
    """Get the structure dict for a SPECIFIC panel. Returns None if empty."""
    panel_id = resolve_panel_id(panel_id)
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

    `intent` ("edit" default | "load") rides into the SSE event so the
    frontend can prompt before overwriting on a fresh load. `had_structure`
    is the backend-authoritative hold signal; when None it is self-computed
    HERE against the RESOLVED panel, before the store write — the in-process
    path (upload-and-load, `_push_structure_direct`) overwrites the store
    itself, so occupancy must be captured first. See PR #372.
    """
    panel_id = resolve_panel_id(panel_id)
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
    panel_id = resolve_panel_id(panel_id)
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
        panel_manifests.pop(panel_id, None)
        pq = panel_pending_updates.pop(panel_id, None)
        if pq:
            pq.clear()
        if last_active_panel_id == panel_id:
            last_active_panel_id = "default"
        for tab_id, viewer_id in list(active_viewer_by_tab.items()):
            if viewer_id == panel_id:
                active_viewer_by_tab.pop(tab_id, None)
        logger.info("View state reset for panel '%s'", panel_id)
    else:
        panel_structures.clear()
        panel_structure_info.clear()
        panel_selections.clear()
        panel_trajectories.clear()
        panel_manifests.clear()
        for pq in panel_pending_updates.values():
            pq.clear()
        panel_pending_updates.clear()
        pending_workflow_id = ""
        last_active_panel_id = "default"
        active_viewer_by_tab.clear()
        logger.info("View state reset (all panels)")
