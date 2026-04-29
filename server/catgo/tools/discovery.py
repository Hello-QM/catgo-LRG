# server/tools/discovery.py
"""Tool discovery — scan directories and load TOOL dicts."""

from __future__ import annotations

import importlib.util
import json
import logging
from pathlib import Path
from typing import Optional

from .models import ToolEntry

logger = logging.getLogger(__name__)


class ToolLoadError(Exception):
    pass


def load_tool_from_path(tool_dir: Path, default_trust: str = "sandboxed") -> ToolEntry:
    """Load a tool from a directory containing tool.py (+ optional catgo-tool.json).

    Raises ToolLoadError if the directory is not a valid tool.
    """
    tool_py = tool_dir / "tool.py"
    # Legacy fallback
    if not tool_py.exists():
        tool_py = tool_dir / "plugin.py"
    if not tool_py.exists():
        raise ToolLoadError(f"No tool.py found in {tool_dir}")

    # Load module
    module = _load_module(tool_py)

    # Extract TOOL dict
    tool_dict = getattr(module, "TOOL", None)
    if not tool_dict or not isinstance(tool_dict, dict):
        # Fallback: try legacy plugin format
        from .compat import load_legacy_plugin
        legacy = load_legacy_plugin(tool_dir)
        if legacy:
            return legacy
        raise ToolLoadError(f"No TOOL dict found in {tool_py}")

    # Extract functions
    execute_fn = getattr(module, "execute", None)
    extra_fns = {}
    for fn_name in ("get_calculator", "get_optimizer", "detect_files", "priority_score", "on_load", "on_unload"):
        fn = getattr(module, fn_name, None)
        if fn:
            extra_fns[fn_name] = fn

    # Load optional manifest (overrides TOOL dict)
    manifest = _load_manifest(tool_dir)

    # Build ToolEntry
    tool_id = tool_dict.get("name", tool_dir.name)
    entry = ToolEntry(
        id=tool_id,
        name=_get(manifest, "displayName", tool_dict.get("display_name", tool_id)),
        description=tool_dict.get("description", ""),
        version=_get(manifest, "version", tool_dict.get("version", "1.0.0")),
        author=_get(manifest, "author", tool_dict.get("author", "")),
        category=tool_dict.get("category", "general"),
        input_schema=tool_dict.get("input_schema", {}),
        output_type=tool_dict.get("output_type", "text"),
        trust=_get(manifest, "trust", default_trust),
        permissions=_get(manifest, "permissions", []),
        source="directory",
        path=tool_dir,
        execute_fn=execute_fn,
        extra_fns=extra_fns,
        frontend=_get(manifest, "frontend", tool_dict.get("frontend")),
        supported_elements=tool_dict.get("supported_elements"),
        supported_formats=tool_dict.get("supported_formats"),
        multi_file=tool_dict.get("multi_file", False),
        node_definition=tool_dict.get("node_definition"),
        supports_cell_optimization=tool_dict.get("supports_cell_optimization", False),
        on_load_fn=extra_fns.get("on_load"),
        on_unload_fn=extra_fns.get("on_unload"),
    )
    return entry


def discover_tools(
    dirs: list[Path],
    default_trust: str = "sandboxed",
) -> tuple[list[ToolEntry], list[tuple[Path, str]]]:
    """Scan directories for tools.

    Returns (entries, errors) where errors is [(path, error_msg)].
    """
    entries: list[ToolEntry] = []
    errors: list[tuple[Path, str]] = []

    for base_dir in dirs:
        if not base_dir.exists():
            continue
        for item in sorted(base_dir.iterdir()):
            if not item.is_dir():
                continue
            if item.name.startswith((".", "__")):
                continue
            try:
                entry = load_tool_from_path(item, default_trust=default_trust)
                entries.append(entry)
                logger.info("Discovered tool: %s at %s", entry.id, item)
            except Exception as e:
                errors.append((item, str(e)))
                logger.warning("Failed to load tool from %s: %s", item, e)

    return entries, errors


def _load_module(path: Path):
    """Import a Python module from file path."""
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if not spec or not spec.loader:
        raise ToolLoadError(f"Cannot create module spec for {path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        raise ToolLoadError(f"Failed to load {path}: {e}") from e
    return module


def _load_manifest(tool_dir: Path) -> Optional[dict]:
    """Load catgo-tool.json or catgo-plugin.json manifest."""
    for name in ("catgo-tool.json", "catgo-plugin.json"):
        p = tool_dir / name
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                logger.warning("Failed to parse %s", p)
    return None


def discover_builtin_tools() -> list[ToolEntry]:
    """Load built-in tools from server/tools/builtin/."""
    entries = []
    try:
        from .builtin import get_builtin_tool_modules
        for module in get_builtin_tool_modules():
            # Each module can export multiple tools via TOOLS list or single TOOL
            tools_list = getattr(module, "TOOLS", [])
            if not tools_list:
                tool = getattr(module, "TOOL", None)
                if tool:
                    tools_list = [tool]
            for tool_dict in tools_list:
                # Load execute fn from module
                fn_name = f"execute_{tool_dict['name']}"
                execute_fn = getattr(module, fn_name, getattr(module, "execute", None))
                extra_fns = {}
                for k in ("detect_files", "priority_score"):
                    fn = getattr(module, f"{k}_{tool_dict['name']}", None)
                    if fn:
                        extra_fns[k] = fn
                entries.append(ToolEntry(
                    id=tool_dict["name"],
                    name=tool_dict.get("display_name", tool_dict["name"]),
                    description=tool_dict.get("description", ""),
                    category="reader",
                    output_type=tool_dict.get("output_type", "electronic_dos"),
                    trust="builtin",
                    source="code",
                    execute_fn=execute_fn,
                    supported_formats=tool_dict.get("supported_formats", []),
                    multi_file=tool_dict.get("multi_file", False),
                    extra_fns=extra_fns,
                ))
    except ImportError:
        pass
    return entries


def _get(manifest: Optional[dict], key: str, default):
    """Get value from manifest, falling back to default."""
    if manifest is None:
        return default
    return manifest.get(key, default)
