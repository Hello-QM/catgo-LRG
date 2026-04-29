# server/tools/compat.py
"""Backward compatibility for legacy plugin formats."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from .models import ToolEntry

logger = logging.getLogger(__name__)


def load_legacy_plugin(path: Path) -> Optional[ToolEntry]:
    """Try to load a legacy BasePlugin-style plugin and convert to ToolEntry.

    Returns None if the directory does not contain a legacy plugin.
    """
    plugin_py = path / "plugin.py"
    if not plugin_py.exists():
        return None

    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("legacy_plugin", plugin_py)
        if not spec or not spec.loader:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception as e:
        logger.warning("Failed to load legacy plugin %s: %s", path, e)
        return None

    # Check if it has old-style BasePlugin classes
    plugin_class = None
    try:
        from catgo.plugins.base import BasePlugin, CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if isinstance(attr, type) and issubclass(attr, BasePlugin) and attr is not BasePlugin:
                plugin_class = attr
                break
    except ImportError:
        return None

    if not plugin_class:
        return None

    plugin = plugin_class()

    # Detect category
    category_map = {}
    try:
        from catgo.plugins.base import CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin
        category_map = {
            CalculatorPlugin: "calculator",
            OptimizerPlugin: "optimizer",
            ReaderPlugin: "reader",
            AnalyzerPlugin: "general",
            WorkflowNodePlugin: "workflow_node",
        }
    except ImportError:
        pass

    category = "general"
    for base_cls, cat in category_map.items():
        if isinstance(plugin, base_cls):
            category = cat
            break

    # Extract extra functions
    extra_fns = {}
    for fn_name in ("get_calculator", "get_optimizer", "detect_files", "priority_score"):
        fn = getattr(plugin, fn_name, None)
        if fn:
            extra_fns[fn_name] = fn

    # Wrap execute method
    execute_fn = None
    for method_name in ("analyze", "read", "execute"):
        method = getattr(plugin, method_name, None)
        if method:
            execute_fn = _wrap_legacy_method(method, category)
            break

    return ToolEntry(
        id=getattr(plugin, "analyzer_id", None) or getattr(plugin, "reader_id", None)
           or getattr(plugin, "calculator_id", None) or plugin.name,
        name=getattr(plugin, "display_name", plugin.name),
        description=getattr(plugin, "description", ""),
        version=getattr(plugin, "version", "1.0.0"),
        author=getattr(plugin, "author", ""),
        category=category,
        input_schema=getattr(plugin, "input_schema", {}),
        output_type=getattr(plugin, "output_type", "text"),
        trust="user",
        source="directory",
        path=path,
        execute_fn=execute_fn,
        extra_fns=extra_fns,
        supported_elements=getattr(plugin, "supported_elements", None),
        supported_formats=getattr(plugin, "supported_formats", None),
        multi_file=getattr(plugin, "multi_file", False),
        node_definition=getattr(plugin, "node_definition", None),
        supports_cell_optimization=getattr(plugin, "supports_cell_optimization", False),
        on_load_fn=getattr(plugin, "on_load", None),
        on_unload_fn=getattr(plugin, "on_unload", None),
    )


def _wrap_legacy_method(method, category):
    """Wrap old-style plugin method to new execute(context) signature."""
    async def wrapped(context):
        if category == "reader":
            return await method(context["file_paths"], context.get("params", {}))
        elif category == "workflow_node":
            return await method(
                json.dumps(context.get("structure", {})),
                context.get("params", {}),
                context.get("config", {}),
            )
        else:
            input_data = {"structure": context.get("structure"), **context.get("params", {})}
            return await method(input_data)
    return wrapped
