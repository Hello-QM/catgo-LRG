"""Hot-reload plugin loader for the CatGO MCP server.

Scans ~/.catgo/plugins/ for Python files that export:
  TOOL_DEF = {"name": "catgo_xxx", "description": "...", "inputSchema": {...}}
  async def handle(arguments: dict, client: httpx.AsyncClient, api_base: str) -> list[TextContent]

Plugins are reloaded automatically when their file mtime changes — no server restart needed.
"""

import importlib.util
import logging
import os
import sys

logger = logging.getLogger(__name__)

PLUGIN_DIR = os.path.join(os.path.expanduser("~"), ".catgo", "plugins")

# {filename_stem: {"tool_def": dict, "handler": callable, "mtime": float}}
PLUGIN_REGISTRY: dict[str, dict] = {}


def load_plugins() -> None:
    """Scan plugin directory; load new/changed files, remove deleted ones."""
    if not os.path.isdir(PLUGIN_DIR):
        return

    seen_keys: set[str] = set()
    for fname in os.listdir(PLUGIN_DIR):
        if not fname.endswith(".py") or fname.startswith("_"):
            continue
        key = fname[:-3]
        seen_keys.add(key)
        fpath = os.path.join(PLUGIN_DIR, fname)
        try:
            mtime = os.path.getmtime(fpath)
        except OSError:
            continue

        # Skip if already loaded and unchanged
        if key in PLUGIN_REGISTRY and PLUGIN_REGISTRY[key]["mtime"] == mtime:
            continue

        try:
            spec = importlib.util.spec_from_file_location(f"catgo_plugin_{key}", fpath)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)

            tool_def = getattr(mod, "TOOL_DEF", None)
            handler = getattr(mod, "handle", None)
            if tool_def is None or handler is None:
                logger.warning("[plugin] %s missing TOOL_DEF or handle(), skipped", fname)
                continue

            PLUGIN_REGISTRY[key] = {
                "tool_def": tool_def,
                "handler": handler,
                "mtime": mtime,
            }
            logger.info("[plugin] loaded: %s → %s", fname, tool_def["name"])
        except Exception as exc:
            logger.error("[plugin] failed to load %s: %s", fname, exc)

    # Remove plugins whose files were deleted
    for key in list(PLUGIN_REGISTRY):
        if key not in seen_keys:
            name = PLUGIN_REGISTRY[key]["tool_def"]["name"]
            del PLUGIN_REGISTRY[key]
            logger.info("[plugin] unloaded (file removed): %s", name)


def get_plugin_tool_defs() -> list[dict]:
    """Return tool definitions from all loaded plugins."""
    load_plugins()
    return [entry["tool_def"] for entry in PLUGIN_REGISTRY.values()]


async def dispatch_plugin(name: str, arguments: dict, client, api_base: str):
    """Try to dispatch a tool call to a plugin. Returns result list or None."""
    load_plugins()
    for entry in PLUGIN_REGISTRY.values():
        if entry["tool_def"]["name"] == name:
            return await entry["handler"](arguments, client, api_base)
    return None
