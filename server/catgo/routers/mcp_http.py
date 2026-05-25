"""MCP over Streamable HTTP — serves the consolidated CatGO tools.

Embeds the MCP server directly in the FastAPI backend so Claude Code
can connect with just a URL (no Python or source code needed on the client):

    ~/.claude/mcp.json:
    {"mcpServers": {"catgo": {"type": "http", "url": "http://localhost:8000/api/mcp"}}}

DEADLOCK PREVENTION:

This MCP server runs inside the same uvicorn process as the FastAPI backend
(single async worker). The tool handlers in server_claude_code.py call
_push_structure() and _get_current_structure() which normally make HTTP
requests to /view/* endpoints — but those endpoints are served by the same
worker, causing a deadlock.

Solution: Monkey-patch the two viewer helpers to use direct in-process access
via view_state.py (the shared state module). Computation endpoints like
/structure-ops/supercell are fine because they don't call back into /view/*.
"""

import logging
import sys
from pathlib import Path

import httpx

from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import TextContent, Tool

logger = logging.getLogger(__name__)

# Ensure server dir on path for mcp_tools imports
_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from catgo.mcp_tools.server_claude_code import (
    TOOLS,
    _handle_structure,
    _handle_fetch,
    _handle_workflow,
    _handle_analyze,
    _handle_view,
    _handle_catalysis,
    _handle_file,
    _handle_system,
    _handle_quickbuild,
    _handle_heterostructure,
    _handle_nanotube,
    _handle_moire,
    _handle_workflow_engine,
    _handle_diagnose,
    _handle_skills,
    API_BASE,
)

# ---------------------------------------------------------------------------
# Patch viewer helpers to use in-process state (avoids self-HTTP deadlock)
# ---------------------------------------------------------------------------

import catgo.mcp_tools.server_claude_code as _mcp_mod
from catgo.routers.view_state import (
    get_structure,
    push_structure,
    get_state_summary,
    get_selection_dict,
    get_active_structure,
    get_active_state_summary,
    get_active_selection_dict,
)


async def _get_current_structure_direct(
    client: httpx.AsyncClient, panel_id: str = "default",
) -> dict | None:
    """In-process replacement — reads shared memory instead of HTTP.

    Resolution order when ``panel_id == "default"``:
      1. ``X-CatGo-Tab-Id`` header captured by the MCP ASGI middleware into
         ``current_panel_id`` ContextVar — this is the chat tab that issued
         the tool call.  Reading the same tab that just pushed its viewer
         state via ``_push_structure_direct`` is what makes CatBot's
         ``set_lattice`` see the H₂O the user is looking at, instead of
         the empty Remote-pane "default" cache.
      2. Whichever panel the user most recently touched
         (``last_active_panel_id``).  This is the lab-claude-over-SSH path
         where no header is present.
      3. Any other panel that has a structure pushed into it — final
         fallback so a freshly opened tab whose ID we don't know yet still
         resolves something.  Without it CatBot raced the frontend's first
         heartbeat push and returned "No structure loaded in viewer".

    Explicit panel ids (``"structure-1"`` etc.) read that panel directly
    with no fallback so callers that knew which tab they wanted aren't
    silently rerouted.
    """
    if panel_id != "default":
        return get_structure(panel_id)

    from catgo.mcp_tools.helpers import current_panel_id
    from catgo.routers.view_state import panel_structures

    ctx_panel = current_panel_id.get()
    if ctx_panel and ctx_panel != "default":
        struct = get_structure(ctx_panel)
        if struct:
            return struct

    active = get_active_structure()
    if active:
        return active

    # Final fallback: any panel that has a structure.  Mirrors the HTTP
    # ``/view/structure/current`` route which already does this.
    for pid, candidate in panel_structures.items():
        if candidate:
            return candidate
    return None


async def _push_structure_direct(
    client: httpx.AsyncClient, struct: dict, panel_id: str = "default",
) -> str | None:
    """In-process replacement — writes shared memory instead of HTTP.

    When the caller passed ``panel_id="default"`` *and* the ASGI middleware
    extracted an ``X-CatGo-Tab-Id`` header for this request, route the push
    into the tab that originated the chat. Without this, every CatBot-fetched
    structure during an in-app chat landed in the literal "default" panel
    (= the External / Remote inbox), invisible to the catgo_structure
    mutations the same chat issued next on its own tab.

    External lab pushes (no header bound) still land in "default" as intended
    — that branch is reached only when the ContextVar has its default value,
    not when the SDK adapter explicitly set a tab id.
    """
    from catgo.mcp_tools.helpers import current_panel_id

    target = panel_id
    if panel_id == "default":
        ctx_panel = current_panel_id.get()
        if ctx_panel and ctx_panel != "default":
            target = ctx_panel

    try:
        push_structure(struct, target)
        return None
    except Exception as exc:
        return str(exc)


# Apply patches so all tool handlers use direct access
_mcp_mod._get_current_structure = _get_current_structure_direct  # type: ignore[attr-defined]
_mcp_mod._push_structure = _push_structure_direct  # type: ignore[attr-defined]

import json as _json


async def _handle_view_direct(client: httpx.AsyncClient, args: dict) -> list[TextContent]:
    """In-process replacement for _handle_view — avoids /view/* self-HTTP."""
    action = args.get("action", "")
    T = TextContent

    if action == "get_state":
        return [T(type="text", text=_json.dumps(get_active_state_summary(), indent=2, ensure_ascii=False))]

    if action == "selection":
        return [T(type="text", text=_json.dumps(get_active_selection_dict(), indent=2, ensure_ascii=False))]

    if action == "screenshot":
        # Screenshot requires WebSocket bridge — must go through HTTP
        resp = await client.post(f"{API_BASE}/view/screenshot", json={})
        if resp.status_code != 200:
            return [T(type="text", text=f"Screenshot failed ({resp.status_code}): {resp.text[:200]}")]
        data = resp.json()
        return [T(type="text", text=f"Screenshot captured ({data.get('width')}x{data.get('height')}). Base64 image: {data.get('image', '')[:100]}...")]

    return [T(type="text", text=f"Unknown view action '{action}'. Valid: get_state, selection, screenshot")]


# (Duplicate patch block removed — the assignments above at lines 79-80
#  already applied these patches. `_handle_view_direct` is dispatched
#  directly by name from `call_tool` below and does not need a module
#  patch on `_mcp_mod._handle_view`.)

logger.info("MCP HTTP: patched viewer helpers for in-process access")


# --- MCP Server + Session Manager (module-level singletons) ---

mcp_server = Server("catgo-claude-code-http")

session_manager = StreamableHTTPSessionManager(
    app=mcp_server,
    json_response=True,
    stateless=True,
)


@mcp_server.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


@mcp_server.call_tool()
async def call_tool(name: str, arguments: dict | None) -> list[TextContent]:
    arguments = arguments or {}
    T = TextContent
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            if name == "catgo_structure":
                return await _handle_structure(client, arguments)
            elif name == "catgo_fetch":
                return await _handle_fetch(client, arguments)
            elif name == "catgo_workflow":
                return await _handle_workflow(client, arguments)
            elif name == "catgo_quickbuild":
                return await _handle_quickbuild(client, arguments)
            elif name == "catgo_analyze":
                return await _handle_analyze(client, arguments)
            elif name == "catgo_view":
                return await _handle_view_direct(client, arguments)
            elif name == "catgo_catalysis":
                return await _handle_catalysis(client, arguments)
            elif name == "catgo_file":
                return await _handle_file(client, arguments)
            elif name == "catgo_system":
                return await _handle_system(client, arguments)
            elif name == "catgo_heterostructure":
                return await _handle_heterostructure(client, arguments)
            elif name == "catgo_nanotube":
                return await _handle_nanotube(client, arguments)
            elif name == "catgo_moire":
                return await _handle_moire(client, arguments)
            elif name == "catgo_workflow_engine":
                return await _handle_workflow_engine(arguments)
            elif name == "catgo_diagnose":
                return await _handle_diagnose(arguments)
            elif name == "catgo_skills":
                return await _handle_skills(arguments)
            else:
                return [T(type="text", text=f"Unknown tool: {name}")]
    except httpx.ConnectError:
        return [T(
            type="text",
            text=f"Cannot connect to CatGO backend at {API_BASE}. "
                 "Is the backend running?",
        )]
    except httpx.TimeoutException:
        logger.warning("MCP tool %s timed out", name)
        return [T(type="text", text=f"{name} timed out. The operation may still be running — try again or check the viewer.")]
    except (KeyError, ValueError, TypeError) as exc:
        logger.warning("MCP tool %s validation error: %s", name, exc)
        return [T(type="text", text=f"{name} failed: {exc}")]
    except Exception as exc:
        logger.error("MCP tool %s unexpected error: %s", name, exc, exc_info=True)
        return [T(type="text", text=f"{name} encountered an internal error. Check server logs for details.")]


async def mcp_asgi_app(scope, receive, send):
    """ASGI app that delegates HTTP requests to the MCP session manager.

    Must be used after session_manager.run() is entered (see main.py lifespan).

    Also extracts the ``X-CatGo-Tab-Id`` header set by the SvelteKit SDK
    adapter (see ``src/lib/server/agent-bridge/adapters/claude.ts``) and binds
    it to the ``current_panel_id`` ContextVar for the duration of the request.
    Tool helpers that push to the viewer (``_push_structure_to_viewer``,
    ``_push_workflow_navigate``) read this ContextVar when no explicit
    panel_id is given, so MCP-originated structure/workflow pushes land in
    the correct tab instead of a single shared "default" bucket.

    ContextVars are request-scoped for async handlers (each awaited coroutine
    inherits the current binding), so this works even though the MCP session
    manager dispatches tool calls deep inside ``session_manager.handle_request``.
    """
    if scope["type"] != "http":
        await session_manager.handle_request(scope, receive, send)
        return

    from catgo.mcp_tools.helpers import current_panel_id

    # ASGI headers are a list of (bytes, bytes) tuples; compare case-insensitive.
    tab_id = ""
    for header_name, header_value in scope.get("headers", []):
        if header_name == b"x-catgo-tab-id":
            try:
                tab_id = header_value.decode("latin-1").strip()
            except UnicodeDecodeError:
                # latin-1 is a 1-to-1 byte mapping, so this branch is
                # practically unreachable — but if a proxy ever mangles
                # the header we want a breadcrumb instead of a silent
                # fallback to "default".
                logger.warning(
                    "Malformed X-CatGo-Tab-Id header: %r — falling back to default panel",
                    header_value,
                )
                tab_id = ""
            break

    if tab_id:
        token = current_panel_id.set(tab_id)
        try:
            await session_manager.handle_request(scope, receive, send)
        finally:
            current_panel_id.reset(token)
    else:
        await session_manager.handle_request(scope, receive, send)
