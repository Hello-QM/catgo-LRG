"""View capture and structure info endpoints.

Provides screenshot capture via a WebSocket bridge pattern (backend requests,
frontend captures Three.js canvas and uploads), plus endpoints for the frontend
to push current structure and selection state.
"""

import asyncio
import json
import logging
import uuid
from collections import deque
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse
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


# --- catrender AI export bridge -------------------------------------------
# Mirrors the screenshot request/upload/pending pattern above: the backend
# (MCP plugin) asks the frontend to render the current structure with a
# given style; an open Render pane polls /catrender/pending, renders via the
# WASM core (so interactive bond overrides apply), and POSTs the SVG back.
_pending_catrender: dict[str, asyncio.Future] = {}
CATRENDER_TIMEOUT = 30.0


@router.post("/catrender/request")
async def request_catrender(payload: dict[str, Any]):
    """AI asks the frontend to render the current structure with payload.style.

    Mirrors the screenshot request/upload pattern."""
    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    _pending_catrender[request_id] = future
    future._params = {  # type: ignore[attr-defined]
        "request_id": request_id,
        "style": payload.get("style", {}),
        "format": payload.get("format", "svg"),
    }
    logger.info("catrender requested (id=%s, style=%s)", request_id, payload.get("style"))
    try:
        result = await asyncio.wait_for(future, timeout=CATRENDER_TIMEOUT)
        return result
    except asyncio.TimeoutError:
        logger.warning("catrender request %s timed out", request_id)
        raise HTTPException(
            status_code=504,
            detail=f"catrender timed out after {CATRENDER_TIMEOUT}s. "
            "Is a Render pane open and connected?",
        )
    finally:
        _pending_catrender.pop(request_id, None)


@router.get("/catrender/pending")
def list_pending_catrender():
    return {
        "pending": [
            getattr(f, "_params", {})
            for f in _pending_catrender.values()
            if not f.done()
        ]
    }


@router.post("/catrender/result")
def upload_catrender(payload: dict[str, Any]):
    future = _pending_catrender.get(payload.get("request_id", ""))
    if future is None:
        raise HTTPException(status_code=404, detail="No pending catrender request")
    if future.done():
        raise HTTPException(status_code=409, detail="Already fulfilled")
    future.set_result(payload)
    logger.info("catrender result received (id=%s, %d bytes)", payload.get("request_id"), len(payload.get("svg") or ""))
    return {"status": "ok"}


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
    intent: str = Query("edit", description="'edit' (apply in place) or 'load' (fresh load — frontend may prompt before overwriting)"),
):
    """Frontend pushes the full pymatgen structure dict for MCP tool access.

    Note: this endpoint does NOT call mark_active. Push fires every 5s
    from EVERY mounted pane regardless of user attention, so using it
    to track "active panel" causes oscillation. Explicit signal lives
    at POST /view/active-panel instead, driven by tm.active_tab_id in
    desktop/App.svelte.

    It also does NOT emit an SSE `structure` event — that is the job of
    /structure/pending-update (and view_state.push_structure on the
    upload/merge paths). `intent` is accepted here only so the dual-POST
    helper (`_push_structure_to_viewer`) can send the same query param to
    both endpoints; the live SSE tag is applied on the pending-update leg.
    """
    struct = data.get("structure", {})
    _panel_structures[panel_id] = struct
    n = len(struct.get("sites", []))
    logger.debug("Full structure pushed for panel '%s': %d sites (intent=%s)", panel_id, n, intent)
    return {"status": "ok", "num_sites": n}


@router.get("/structure/current")
def get_current_structure(
    panel_id: str = Query("default", description="Panel identifier for multi-panel support"),
):
    """Get the full pymatgen structure dict (for MCP tools).

    Falls back to any populated panel when the requested ``panel_id`` has no
    structure. Tool callers (MCP server, CatBot chat) typically pass
    ``panel_id="default"`` because they don't know the frontend's real panel
    id — the viewer normally pushes to ``structure-1`` or similar. Without
    the fallback every auto-capture path 404s.
    """
    struct = _panel_structures.get(panel_id, {})
    if not struct:
        # Only the "default" sentinel may borrow another panel's structure —
        # that's the value tool callers pass when they don't know the real
        # frontend panel id. An EXPLICIT panel that happens to be empty must
        # NOT inherit a different panel's (possibly stale) structure: doing so
        # made CatBot report a phantom structure the user couldn't find.
        if panel_id == "default":
            for pid, candidate in _panel_structures.items():
                if pid == panel_id:
                    continue
                if candidate:
                    logger.debug(
                        "get_current_structure: panel '%s' empty, falling back to '%s'",
                        panel_id, pid,
                    )
                    return candidate
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
    intent: str = Query("edit", description="'edit' (apply in place) or 'load' (fresh load — frontend may prompt before overwriting)"),
    had_structure: bool = Query(False, description="Whether the target panel was occupied BEFORE this push (backend-authoritative hold signal; probed by the MCP helper pre-push)"),
):
    """MCP tools push modified structures here for the frontend to pick up.

    `had_structure` is forwarded into the SSE event so the frontend's
    hold-gate can ORs it against its own (racy) structure read. The MCP
    helper probes the panel BEFORE either push leg overwrites the store and
    passes the value here; `notify_structure` rides it verbatim.
    """
    struct = data.get("structure", {})
    pending = _get_panel_pending(panel_id)
    pending.append(struct)
    view_state.notify_structure(panel_id, struct, intent=intent, had_structure=had_structure)
    logger.debug(
        "Pending structure update queued for panel '%s' (intent=%s, had_structure=%s)",
        panel_id, intent, had_structure,
    )
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
    view_state.notify_workflow(panel_id or "default", wf_id)
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


@router.get("/structure/export")
def export_structure_text(
    format: str = Query("poscar", description="poscar | cif | xyz | extxyz | mol2 | pdb"),
    panel_id: str = Query("default", description="Panel to export. Defaults to External pane."),
):
    """Serialize the panel's current structure as POSCAR/CIF/XYZ/etc text.

    Counterpart to /upload-and-load: lets lab claude `curl > file` the
    output directly, skipping the MCP response path. ~50 tokens for the
    Bash invocation vs ~1500 tokens for a 100-atom POSCAR rendered
    through the catgo_structure export action.

    Usage from lab:
        curl "http://localhost:33413/api/view/structure/export?format=poscar" \\
             > /tmp/foo.poscar
    """
    struct_dict = _panel_structures.get(panel_id)
    if not struct_dict:
        raise HTTPException(status_code=404, detail=f"No structure in panel '{panel_id}'")
    # Reuse the existing ASE serializer pipeline.
    from catgo.routers.workflow import dict_to_ase, ase_serialize
    try:
        atoms = dict_to_ase(struct_dict)
        content, fmt = ase_serialize(atoms, format.lower())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("export_structure_text failed")
        raise HTTPException(status_code=500, detail=f"Serialize failed: {exc}")
    ext_for_fmt = {"poscar": "vasp", "extxyz": "extxyz"}.get(fmt, fmt)
    return PlainTextResponse(
        content,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="structure.{ext_for_fmt}"'},
    )


def _count_xyz_frames(content: str, *, stop_at: int | None = None) -> int:
    """Count frames in an XYZ / extxyz string. Mirrors the frontend
    `count_xyz_frames`. Pass `stop_at=2` to short-circuit when only
    "is multi-frame?" is needed (avoids walking huge MD trajectories)."""
    lines = content.splitlines()
    n_frames, i, total = 0, 0, len(lines)
    while i < total:
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        try:
            n_atoms = int(line)
        except ValueError:
            i += 1
            continue
        n_frames += 1
        if stop_at is not None and n_frames >= stop_at:
            return n_frames
        i += n_atoms + 2  # atom-count line + comment line + n_atoms coord lines
    return n_frames


def _is_trajectory(content: str, filename: str) -> bool:
    """Detect multi-frame trajectories. Mirrors `is_trajectory_file` in
    src/lib/trajectory/parse.ts so backend / frontend agree on what
    counts as a trajectory."""
    name = (filename or "").lower()
    # Strip compression extensions
    for ext in (".gz", ".bz2", ".xz", ".zst", ".zip"):
        if name.endswith(ext):
            name = name[: -len(ext)]
            break
    if name.endswith((".xyz", ".extxyz")):
        return _count_xyz_frames(content, stop_at=2) >= 2
    if name.endswith((".dump", ".lammpstrj")):
        return "ITEM: TIMESTEP" in content and "ITEM: NUMBER OF ATOMS" in content
    if "xdatcar" in name:
        return True
    # vasprun.xml — multiple <calculation> blocks means trajectory
    if name.endswith(".xml"):
        return content.count("<calculation>") >= 2
    return False


@router.post("/upload-and-load")
async def upload_and_load(
    file: UploadFile = File(...),
    panel_id: str = Query("default", description="Target panel; 'default' = External pane"),
):
    """Upload a structure file (multipart/form-data) and push it to the viewer.

    Designed for low-token MCP usage: lab claude calls this via Bash+curl
    so the file body travels as binary through the reverse tunnel — never
    enters claude's conversation context. Compare to the MCP load_file
    action, which round-trips the file text twice (Read result + tool
    arg). For a 5 KB POSCAR that's ~1500 tokens vs ~80 tokens here.

    Usage from lab:
        curl -F "file=@/tmp/foo.poscar" \\
             "http://localhost:33413/api/view/upload-and-load?panel_id=default"

    Format is auto-detected from filename extension (poscar/vasp/contcar
    /cif/xyz/extxyz/mol2/pdb), with content-based fallback inside the
    parser when the extension is missing or unknown.
    """
    # Local imports to keep the file's top-level deps clean.
    from catgo.routers.vasp import parse_structure as _parse, ParseStructureRequest

    raw = (await file.read()).decode("utf-8", errors="replace")
    filename = file.filename or ""

    # Multi-frame detour: pymatgen's Structure.from_str only takes the first
    # frame, so for trajectories we hand the raw text to the frontend via
    # an SSE event and let parse_trajectory_data handle every format
    # consistently. Avoids re-implementing the trajectory parser server-side.
    if _is_trajectory(raw, filename):
        n_frames = _count_xyz_frames(raw) if filename.lower().endswith((".xyz", ".extxyz")) else None
        # push_trajectory stores in cache (replayed on SSE reconnect),
        # clears any stale single-structure cache for this panel, and
        # notifies subscribers.
        view_state.push_trajectory(panel_id, raw, filename)
        logger.info(
            "upload-and-load: %s → panel '%s', trajectory (%s frames)",
            filename or "<unnamed>", panel_id,
            f"~{n_frames}" if n_frames else "?",
        )
        return {
            "status": "ok",
            "type": "trajectory",
            "filename": filename,
            "panel_id": panel_id,
            "num_frames": n_frames,
        }

    fmt_hint: Optional[str] = None
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        fmt_hint = {
            "vasp": "poscar", "poscar": "poscar", "contcar": "poscar",
            "cif": "cif",
            "xyz": "xyz", "extxyz": "extxyz",
            "mol2": "mol2", "pdb": "pdb",
        }.get(ext)

    try:
        struct_dict = _parse(ParseStructureRequest(content=raw, format=fmt_hint))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Parse failed: {exc}")

    view_state.push_structure(struct_dict, panel_id, intent="load")
    n = len(struct_dict.get("sites", []))
    logger.info("upload-and-load: %s → panel '%s', %d sites", filename or "<unnamed>", panel_id, n)
    return {
        "status": "ok",
        "type": "structure",
        "filename": filename,
        "format": fmt_hint or "auto",
        "panel_id": panel_id,
        "num_sites": n,
    }


@router.post("/structure/merge-upload")
async def merge_upload(
    file: UploadFile = File(...),
    panel_id: str = Query("default", description="Base panel; defaults to External"),
    position: str = Query("0,0,0", description="Cartesian [x,y,z] for incoming structure's center, comma-separated"),
):
    """Multipart upload: merge an uploaded structure file into a panel's current structure.

    Counterpart to /upload-and-load. The MCP `catgo_structure merge`
    action takes the second structure as a full pymatgen dict in tool
    args (large + duplicates through claude's context). This endpoint
    streams the file as binary through the reverse tunnel — Lab claude
    only spends tokens on the curl command itself.

    Usage from lab:
        curl -F "file=@/tmp/molecule.xyz" \\
             "http://localhost:33413/api/view/structure/merge-upload?position=2,2,2"

    Reads the base from view_state.panel_structures[panel_id], parses
    the upload via the existing parser, calls merge_structures, then
    pushes the result back into the same panel.
    """
    from catgo.routers.vasp import parse_structure as _parse, ParseStructureRequest
    from catgo.routers.structure_ops import merge_structures, MergeRequest

    base = _panel_structures.get(panel_id)
    if not base:
        raise HTTPException(status_code=404, detail=f"No structure in panel '{panel_id}'")

    raw = (await file.read()).decode("utf-8", errors="replace")
    fmt_hint: Optional[str] = None
    if file.filename and "." in file.filename:
        ext = file.filename.rsplit(".", 1)[-1].lower()
        fmt_hint = {
            "vasp": "poscar", "poscar": "poscar", "contcar": "poscar",
            "cif": "cif", "xyz": "xyz", "extxyz": "extxyz",
            "mol2": "mol2", "pdb": "pdb",
        }.get(ext)

    try:
        incoming = _parse(ParseStructureRequest(content=raw, format=fmt_hint))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Parse failed: {exc}")

    try:
        pos = [float(x) for x in position.split(",")]
        if len(pos) != 3:
            raise ValueError("position must have 3 components")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Bad position: {exc}")

    try:
        result = merge_structures(MergeRequest(base=base, incoming=incoming, position=pos))
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("merge_upload failed")
        raise HTTPException(status_code=500, detail=f"Merge failed: {exc}")

    merged = result.structure if hasattr(result, "structure") else result.get("structure", {})
    view_state.push_structure(merged, panel_id, intent="edit")
    n = len(merged.get("sites", []))
    logger.info("merge-upload: %s + panel '%s' → %d sites at %s", file.filename or "<unnamed>", panel_id, n, pos)
    return {
        "status": "ok",
        "filename": file.filename,
        "panel_id": panel_id,
        "position": pos,
        "num_sites": n,
    }


@router.post("/active-panel")
def set_active_panel(
    panel_id: str = Query("", description="Panel ID the user is currently viewing"),
):
    """Frontend signals which pane the user is currently looking at.

    Asymmetric reads (lab claude with no X-CatGo-Tab-Id header) route
    to this panel via view_state.last_active_panel_id. Driven by a
    `$effect` watching `tm.active_tab_id` in desktop/App.svelte, so
    every tab switch (manual click, toast-open-External, programmatic)
    updates the backend's view of "what the user is looking at".
    """
    if panel_id:
        view_state.mark_active(panel_id)
    return {"status": "ok", "active_panel_id": view_state.last_active_panel_id}


@router.get("/manifest")
async def get_viewer_manifest(tab_id: str = ""):
    return {"viewers": view_state.list_manifests(tab_id)}


@router.post("/manifest/update")
async def update_viewer_manifest(data: dict):
    panel_id = str(data.get("viewer_id", "")).strip()
    if not panel_id:
        raise HTTPException(status_code=400, detail="viewer_id is required")
    view_state.update_manifest(panel_id, data)
    return {"ok": True}


@router.delete("/manifest")
async def delete_viewer_manifest(viewer_id: str):
    view_state.remove_manifest(viewer_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Unified state summary (for Claude Code)
# ---------------------------------------------------------------------------


@router.get("/state")
def get_view_state(
    panel_id: str = Query("default", description="Panel identifier. Bare 'default' routes to whichever panel the user is currently active in (asymmetric read)."),
):
    """Compact state summary for Claude Code MCP integration.

    Asymmetric read: bare "default" → active panel. Explicit panel_ids
    (e.g. "structure-1") read that panel literally. Lets lab claude over
    SSH (no X-CatGo-Tab-Id header) see whichever panel the user is
    touching, not the literal Remote-pane inbox.
    """
    if panel_id == "default":
        return view_state.get_active_state_summary()
    return view_state.get_state_summary(panel_id)


# ---------------------------------------------------------------------------
# SSE subscribe — replaces the 500ms polling loop
# ---------------------------------------------------------------------------


@router.get("/subscribe")
async def subscribe_view(
    panel_id: str = Query("default", description="Panel to subscribe to"),
):
    """SSE stream of structure / workflow events for a panel.

    The frontend (`tool-handler.ts`) opens an EventSource on this URL
    instead of polling /structure/pending-update. The backend pushes
    `event: structure` / `event: workflow` whenever something is queued.
    Heartbeat comments every 15s keep proxies and reverse-tunnels alive.
    """
    queue = view_state.subscribe(panel_id)

    async def event_stream():
        try:
            yield ": connected\n\n"
            # Replay current cached state on (re)connect. A pane shows
            # EITHER a structure OR a trajectory — push_trajectory clears
            # the structure cache, so at most one branch fires here.
            current_traj = view_state.get_trajectory(panel_id)
            if current_traj:
                # Trajectory replay: emit a "trajectory" event (same shape
                # as live updates) so the global App.svelte listener
                # injects it into the External pane on reconnect.
                yield f"event: trajectory\ndata: {json.dumps(current_traj)}\n\n"
            else:
                current = view_state.get_structure(panel_id)
                if current:
                    snapshot = json.dumps({"structure": current})
                    # `snapshot` is distinct from `structure` so global listeners
                    # (toast trigger) can ignore replays without missing real
                    # pushes. Per-pane subscribers handle both identically.
                    yield f"event: snapshot\ndata: {snapshot}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    event = msg["event"]
                    data_json = json.dumps(msg["data"])
                    yield f"event: {event}\ndata: {data_json}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            view_state.unsubscribe(panel_id, queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/command/result")
async def complete_viewer_command(data: dict):
    command_id = str(data.get("command_id", ""))
    if not command_id:
        raise HTTPException(status_code=400, detail="command_id is required")
    accepted = view_state.complete_viewer_command(command_id, data)
    return {"accepted": accepted}


@router.post("/command")
async def request_viewer_command(data: dict):
    viewer_ref = str(data.get("viewer_id", "")).strip()
    action = str(data.get("action", "")).strip()
    if not viewer_ref or not action:
        raise HTTPException(status_code=400, detail="viewer_id and action are required")
    panel_id, resolve_error = view_state.resolve_viewer_ref(
        viewer_ref,
        str(data.get("tab_id", "")).strip(),
    )
    if resolve_error or not panel_id:
        raise HTTPException(status_code=404, detail=resolve_error or "Viewer was not found")
    try:
        return await view_state.request_viewer_command(
            panel_id,
            action,
            data.get("arguments") or {},
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail=f"Viewer '{panel_id}' did not answer")
