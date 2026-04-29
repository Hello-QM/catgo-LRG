"""View capture and structure info endpoints.

Provides screenshot capture via a WebSocket bridge pattern (backend requests,
frontend captures Three.js canvas and uploads), plus endpoints for the frontend
to push current structure and selection state.
"""

import asyncio
import logging
import uuid
from collections import deque
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/view", tags=["view-capture"])

# ---------------------------------------------------------------------------
# Screenshot capture state
# ---------------------------------------------------------------------------

SCREENSHOT_TIMEOUT = 30.0

# Pending screenshot requests: request_id -> asyncio.Future
_pending_screenshots: dict[str, asyncio.Future] = {}


class ScreenshotRequest(BaseModel):
    """Optional parameters for requesting a screenshot."""

    width: Optional[int] = Field(None, description="Desired image width in pixels")
    height: Optional[int] = Field(None, description="Desired image height in pixels")
    format: str = Field("png", description="Image format (png or jpeg)")


class ScreenshotUpload(BaseModel):
    """Payload sent by the frontend with captured image data."""

    request_id: str = Field(..., description="ID of the pending screenshot request")
    image: str = Field(..., description="Base64-encoded image data")
    width: int = Field(..., description="Actual captured width in pixels")
    height: int = Field(..., description="Actual captured height in pixels")


class ScreenshotResponse(BaseModel):
    """Response containing the captured screenshot."""

    image: str = Field(..., description="Base64-encoded image data")
    width: int
    height: int
    format: str


# ---------------------------------------------------------------------------
# Per-panel structure state
# ---------------------------------------------------------------------------

# Shared state lives in view_state.py — import mutable containers so HTTP
# endpoints and in-process MCP handlers operate on the same objects.
import catgo.routers.view_state as view_state

_panel_structures = view_state.panel_structures
_panel_pending_updates = view_state.panel_pending_updates
_panel_structure_info = view_state.panel_structure_info
_panel_selections = view_state.panel_selections
_get_panel_pending = view_state.get_panel_pending
# Pending workflow-navigate signals, keyed by panel_id (= frontend tab_id).
# Before Phase 2 of the tab isolation refactor this was a single string —
# whichever tab polled first consumed the signal, so a workflow created by
# CatBot in tab A could open in tab B instead. The per-panel dict lets the
# frontend poll for its own tab's pending signal without stealing from
# other tabs. An empty-string key is used by callers that don't supply
# panel_id (legacy / Codex / Gemini paths).
_pending_workflow_ids: dict[str, str] = {}


def _get_panel_selection(panel_id: str) -> "SelectionState":
    """Get or create a typed SelectionState for a panel."""
    raw = view_state.get_panel_selection(panel_id)
    if isinstance(raw, SelectionState):
        return raw
    sel = SelectionState(**raw) if isinstance(raw, dict) else SelectionState()
    _panel_selections[panel_id] = sel
    return sel


class AtomDetail(BaseModel):
    """Detail for a single atom in the selection."""

    index: int
    element: str
    position: list[float] = Field(..., description="[x, y, z] in Angstroms")


class SelectionState(BaseModel):
    """Currently selected atoms."""

    indices: list[int] = Field(default_factory=list)
    atoms: list[AtomDetail] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Reset endpoint — clear stale state from previous browser session
# ---------------------------------------------------------------------------


@router.post("/reset")
def reset_view_state(
    panel_id: str = Query("", description="Panel to reset. Empty string resets ALL panels."),
):
    """Clear cached view state. Called by the frontend on startup.

    If panel_id is provided, only that panel is cleared.
    If panel_id is empty (default), ALL panels are cleared.
    """
    if panel_id:
        # Clear a specific panel
        _panel_structures.pop(panel_id, None)
        _panel_structure_info.pop(panel_id, None)
        _panel_selections.pop(panel_id, None)
        pending = _panel_pending_updates.pop(panel_id, None)
        if pending:
            pending.clear()
        _pending_workflow_ids.pop(panel_id, None)
        logger.info("View state reset for panel '%s'", panel_id)
    else:
        # Clear ALL panels
        _panel_structures.clear()
        _panel_structure_info.clear()
        _panel_selections.clear()
        for pq in _panel_pending_updates.values():
            pq.clear()
        _panel_pending_updates.clear()
        _pending_workflow_ids.clear()
        logger.info("View state reset (all panels)")

    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Screenshot endpoints
# ---------------------------------------------------------------------------


@router.post("/screenshot", response_model=ScreenshotResponse)
async def request_screenshot(request: ScreenshotRequest = ScreenshotRequest()):
    """Request a screenshot from the frontend.

    Creates a pending capture request and waits for the frontend to respond
    via ``POST /screenshot/upload``. The frontend polls /screenshot/pending
    to discover requests, captures the Three.js canvas, and uploads the result.
    """
    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    _pending_screenshots[request_id] = future

    logger.info(
        "Screenshot requested (id=%s, size=%sx%s, fmt=%s)",
        request_id,
        request.width or "auto",
        request.height or "auto",
        request.format,
    )

    try:
        future._capture_params = {  # type: ignore[attr-defined]
            "request_id": request_id,
            "width": request.width,
            "height": request.height,
            "format": request.format,
        }

        result: ScreenshotUpload = await asyncio.wait_for(
            future, timeout=SCREENSHOT_TIMEOUT
        )

        return ScreenshotResponse(
            image=result.image,
            width=result.width,
            height=result.height,
            format=request.format,
        )
    except asyncio.TimeoutError:
        logger.warning("Screenshot request %s timed out", request_id)
        raise HTTPException(
            status_code=504,
            detail=f"Screenshot capture timed out after {SCREENSHOT_TIMEOUT}s. "
            "Is the frontend connected and able to capture?",
        )
    finally:
        _pending_screenshots.pop(request_id, None)


@router.post("/screenshot/upload")
def upload_screenshot(upload: ScreenshotUpload):
    """Companion endpoint: frontend uploads the captured screenshot."""
    future = _pending_screenshots.get(upload.request_id)
    if future is None:
        raise HTTPException(
            status_code=404,
            detail=f"No pending screenshot request with id '{upload.request_id}'. "
            "It may have already timed out or been fulfilled.",
        )

    if future.done():
        raise HTTPException(
            status_code=409,
            detail=f"Screenshot request '{upload.request_id}' has already been fulfilled.",
        )

    future.set_result(upload)
    logger.info(
        "Screenshot uploaded (id=%s, %dx%d)",
        upload.request_id,
        upload.width,
        upload.height,
    )
    return {"status": "ok", "request_id": upload.request_id}


@router.get("/screenshot/pending")
def list_pending_screenshots():
    """List pending screenshot requests the frontend has not yet fulfilled."""
    pending = []
    for req_id, future in _pending_screenshots.items():
        if not future.done():
            params = getattr(future, "_capture_params", {})
            pending.append(params)
    return {"pending": pending}


# ---------------------------------------------------------------------------
# Structure info endpoints
# ---------------------------------------------------------------------------


@router.get("/structure-info")
def get_structure_info(
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Get the current loaded structure information."""
    info = _panel_structure_info.get(panel_id, {})
    if not info:
        raise HTTPException(
            status_code=404,
            detail=f"No structure info available for panel '{panel_id}'. "
            "The frontend has not pushed any state yet.",
        )
    return info


@router.post("/structure-info/update")
def update_structure_info(
    info: dict[str, Any],
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Frontend pushes the current structure context."""
    _panel_structure_info[panel_id] = info
    logger.debug("Structure info updated for panel '%s': %s", panel_id, list(info.keys()))
    return {"status": "ok", "keys_received": list(info.keys())}


@router.post("/structure/push")
def push_structure(
    data: dict[str, Any],
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Frontend pushes the full pymatgen structure dict for MCP tool access."""
    struct = data.get("structure", {})
    _panel_structures[panel_id] = struct
    n = len(struct.get("sites", []))
    logger.debug("Full structure pushed for panel '%s': %d sites", panel_id, n)
    return {"status": "ok", "num_sites": n}


@router.get("/structure/current")
def get_current_structure(
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Get the full pymatgen structure dict (for MCP tools)."""
    struct = _panel_structures.get(panel_id, {})
    if not struct:
        raise HTTPException(
            status_code=404,
            detail=f"No structure available for panel '{panel_id}'. "
            "Load a structure in the viewer first.",
        )
    return struct


@router.post("/structure/pending-update")
def set_pending_structure_update(
    data: dict[str, Any],
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """MCP tools push modified structures here for the frontend to pick up."""
    pending = _get_panel_pending(panel_id)
    pending.append(data.get("structure", {}))
    logger.debug("Pending structure update queued for panel '%s'", panel_id)
    return {"status": "ok"}


@router.get("/structure/pending-update")
def get_pending_structure_update(
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Frontend polls for pending structure updates from MCP tools.

    Returns the latest pending update and discards older ones (if multiple MCP
    tools pushed results between two poll cycles, only the final state matters).
    Also returns any pending workflow navigation requests.
    """
    pending = _get_panel_pending(panel_id)
    has_structure = bool(pending)
    # Check this panel's specific navigate signal first, then fall back to
    # the legacy empty-key slot so Codex/Gemini MCP pushes (which don't set
    # panel_id) continue to surface in whichever tab polls.
    pending_wf = _pending_workflow_ids.get(panel_id)
    if pending_wf is None:
        pending_wf = _pending_workflow_ids.get("")
        consumed_key = "" if pending_wf else None
    else:
        consumed_key = panel_id
    has_workflow = bool(pending_wf)

    if not has_structure and not has_workflow:
        return {"pending": False}

    result: dict[str, Any] = {"pending": has_structure or has_workflow}

    if has_structure:
        result["structure"] = pending[-1]  # Latest wins
        pending.clear()

    if has_workflow:
        result["workflow_id"] = pending_wf
        if consumed_key is not None:
            _pending_workflow_ids.pop(consumed_key, None)

    return result


# ---------------------------------------------------------------------------
# Workflow navigation signal (MCP tools → frontend)
# ---------------------------------------------------------------------------


@router.post("/workflow/pending-navigate")
def set_pending_workflow_navigate(data: dict[str, Any]):
    """MCP tools push a workflow ID here; frontend picks it up via pending-update poll.

    Accepts an optional ``panel_id`` in the JSON body so CatBot-created
    workflows open in the tab that initiated the chat rather than in
    whichever tab polls first. The SDK adapter attaches the tab_id via
    the ``X-CatGo-Tab-Id`` header → ``current_panel_id`` ContextVar →
    ``_push_workflow_navigate(panel_id=...)`` → this endpoint. Callers
    that omit panel_id land in the empty-key legacy slot (Codex/Gemini).
    """
    wf_id = data.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="workflow_id is required.")
    panel_id = str(data.get("panel_id", "") or "")
    _pending_workflow_ids[panel_id] = wf_id
    logger.info("Pending workflow navigation set for panel '%s': %s", panel_id or "<legacy>", wf_id)
    return {"status": "ok", "workflow_id": wf_id}


# ---------------------------------------------------------------------------
# Selection endpoints
# ---------------------------------------------------------------------------


@router.get("/selection", response_model=SelectionState)
def get_selection(
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Get currently selected atom indices and details."""
    return _get_panel_selection(panel_id)


@router.post("/selection/update", response_model=SelectionState)
def update_selection(
    selection: SelectionState,
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Frontend pushes the current atom selection state."""
    _panel_selections[panel_id] = selection
    logger.debug(
        "Selection updated for panel '%s': %d atoms selected",
        panel_id,
        len(selection.indices),
    )
    return selection


# ---------------------------------------------------------------------------
# Unified state summary (for Claude Code)
# ---------------------------------------------------------------------------


@router.get("/state")
def get_view_state(
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Compact state summary for Claude Code MCP integration.

    Combines structure info, selection, and lattice into a single
    lightweight response (~200 bytes).  Derives formula/elements from
    the structure dict when structure info is not available.
    """
    struct_dict = _panel_structures.get(panel_id, {})
    if not struct_dict:
        return {"has_structure": False}

    info = _panel_structure_info.get(panel_id, {})
    lattice = struct_dict.get("lattice", {})
    sites = struct_dict.get("sites", [])

    # Derive elements and formula from sites if info is incomplete
    elements = info.get("elements", []) if info else []
    formula = info.get("formula", "") if info else ""
    if not elements and sites:
        from collections import Counter
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

    selection = _get_panel_selection(panel_id)
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
            "count": len(selection.indices),
            "indices": selection.indices[:20],
        },
    }
