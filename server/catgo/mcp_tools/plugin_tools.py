"""Plugin tool handlers for the CatGO MCP server.

Contains plugin manager initialization, plugin tool listing,
and handlers for plugin analyzers and readers.
"""

import json
import logging

import httpx
from mcp.types import TextContent, Tool

from .helpers import API_BASE

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Plugin tool helpers (Phase 4: MCP dynamic tool registration)
# ---------------------------------------------------------------------------

_plugin_manager_initialized = False


async def _ensure_plugin_manager() -> "PluginManager | None":
    """Lazily initialize the plugin manager for standalone MCP server."""
    global _plugin_manager_initialized
    try:
        from catgo.plugins import plugin_manager

        if not _plugin_manager_initialized:
            await plugin_manager.initialize()
            _plugin_manager_initialized = True

        return plugin_manager
    except Exception as e:
        logger.debug(f"Plugin manager not available: {e}")
        return None


async def _get_plugin_tools() -> list[Tool]:
    """Generate MCP Tool entries from registered plugins."""
    tools: list[Tool] = []

    pm = await _ensure_plugin_manager()
    if pm is None:
        return tools

    # Analyzer plugins -> MCP tools
    for info in pm.get_all_analyzers():
        if not info.get("enabled", True):
            continue
        tools.append(Tool(
            name=f"catgo_analyze_{info['analyzer_id']}",
            description=f"[Plugin] {info.get('description', info['analyzer_id'])}",
            inputSchema=info.get("input_schema") or {
                "type": "object",
                "properties": {
                    "structure": {"type": "object", "description": "Pymatgen structure dict (auto-fetched from viewer if omitted)"},
                },
            },
        ))

    # Reader plugins -> MCP tools (skip built-in readers)
    for info in pm.get_all_readers():
        if not info.get("enabled", True):
            continue
        if info.get("name", "").startswith("builtin-"):
            continue
        tools.append(Tool(
            name=f"catgo_read_{info['reader_id']}",
            description=f"[Plugin] Read {', '.join(info.get('formats', []))} files. Output: {info.get('output_type', 'unknown')}",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Absolute paths to the files to read",
                    },
                    "options": {
                        "type": "object",
                        "description": "Optional reader parameters",
                    },
                },
                "required": ["file_paths"],
            },
        ))

    return tools


async def _handle_plugin_analyzer(analyzer_id: str, arguments: dict) -> list[TextContent]:
    """Handle an MCP call to a plugin analyzer."""
    try:
        pm = await _ensure_plugin_manager()
        if pm is None:
            return [TextContent(type="text", text="Plugin system not available.")]

        analyzer = pm.get_analyzer(analyzer_id)

        # Auto-fetch current structure from viewer if not provided
        if "structure" not in arguments:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(f"{API_BASE}/view/structure/current")
                    if resp.status_code == 200:
                        arguments["structure"] = resp.json()
            except Exception:
                pass

        result = await analyzer.analyze(arguments)
        return [TextContent(type="text", text=json.dumps(result, indent=2, ensure_ascii=False))]
    except Exception as e:
        return [TextContent(type="text", text=f"Analyzer error ({analyzer_id}): {e}")]


async def _handle_plugin_reader(reader_id: str, arguments: dict) -> list[TextContent]:
    """Handle an MCP call to a plugin reader."""
    try:
        pm = await _ensure_plugin_manager()
        if pm is None:
            return [TextContent(type="text", text="Plugin system not available.")]

        reader = pm.get_reader(reader_id)
        file_paths = arguments.get("file_paths", [])
        options = arguments.get("options", {})
        result = await reader.read(file_paths, options)

        # If output is a structure, push to viewer
        if reader.output_type == "structure" and isinstance(result, dict) and "structure" in result:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(f"{API_BASE}/view/structure/push", params={"intent": "load"}, json={"structure": result["structure"]})
                    await client.post(f"{API_BASE}/view/structure/pending-update", params={"intent": "load"}, json={"structure": result["structure"]})
            except Exception as exc:
                logger.warning(f"Failed to push reader result to viewer: {exc}")

        return [TextContent(type="text", text=json.dumps(
            {"reader_id": reader_id, "output_type": reader.output_type, "success": True, "data": result},
            indent=2, ensure_ascii=False, default=str,
        ))]
    except Exception as e:
        return [TextContent(type="text", text=f"Reader error ({reader_id}): {e}")]
