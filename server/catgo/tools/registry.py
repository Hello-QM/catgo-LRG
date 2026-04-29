# server/tools/registry.py
"""ToolRegistry — the single registration center for all tools."""

from __future__ import annotations

import logging
from typing import Any, Optional

from .models import ToolEntry, ToolResult, validate_tool_id

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Singleton registry for all tools."""

    def __init__(self):
        self._tools: dict[str, ToolEntry] = {}

    # ── Core ──

    def register(self, tool: ToolEntry) -> None:
        if not validate_tool_id(tool.id):
            raise ValueError(f"Invalid tool id: {tool.id!r}. Must match [a-z0-9][a-z0-9_-]*")
        if tool.id in self._tools:
            logger.warning("Tool %r already registered, overwriting", tool.id)
        self._tools[tool.id] = tool
        logger.info("Registered tool: %s (%s, trust=%s)", tool.id, tool.category, tool.trust)

    def unregister(self, tool_id: str) -> None:
        tool = self._tools.pop(tool_id, None)
        if tool and tool.on_unload_fn:
            try:
                import asyncio
                asyncio.get_event_loop().run_until_complete(tool.on_unload_fn())
            except Exception:
                logger.exception("on_unload failed for %s", tool_id)

    # ── Query ──

    def get(self, tool_id: str) -> Optional[ToolEntry]:
        return self._tools.get(tool_id)

    def list_all(self) -> list[ToolEntry]:
        return list(self._tools.values())

    def list_by_category(self, category: str) -> list[ToolEntry]:
        return [t for t in self._tools.values() if t.category == category]

    # ── Enable / Disable ──

    def enable(self, tool_id: str) -> None:
        tool = self._tools.get(tool_id)
        if tool:
            tool.enabled = True

    def disable(self, tool_id: str) -> None:
        tool = self._tools.get(tool_id)
        if tool:
            tool.enabled = False

    # ── Category-specific accessors ──

    def get_calculator(self, tool_id: str, **params) -> Any:
        """Return ASE Calculator from a calculator-category tool."""
        tool = self._tools.get(tool_id)
        if not tool or tool.category != "calculator":
            raise KeyError(f"Calculator tool not found: {tool_id}")
        if not tool.enabled:
            raise KeyError(f"Calculator tool disabled: {tool_id}")
        get_calc = tool.extra_fns.get("get_calculator")
        if not get_calc:
            raise KeyError(f"Tool {tool_id} has no get_calculator function")
        return get_calc(**params)

    def get_optimizer(self, tool_id: str, atoms: Any, **params) -> Any:
        """Return ASE Optimizer from an optimizer-category tool."""
        tool = self._tools.get(tool_id)
        if not tool or tool.category != "optimizer":
            raise KeyError(f"Optimizer tool not found: {tool_id}")
        if not tool.enabled:
            raise KeyError(f"Optimizer tool disabled: {tool_id}")
        get_opt = tool.extra_fns.get("get_optimizer")
        if not get_opt:
            raise KeyError(f"Tool {tool_id} has no get_optimizer function")
        return get_opt(atoms, **params)

    def find_reader_for_files(self, filenames: list[str]) -> Optional[ToolEntry]:
        """Find the best reader tool for the given filenames."""
        best: Optional[ToolEntry] = None
        best_score = -1
        for tool in self._tools.values():
            if tool.category != "reader" or not tool.enabled:
                continue
            detect = tool.extra_fns.get("detect_files")
            if detect and detect(filenames):
                priority = tool.extra_fns.get("priority_score")
                score = priority(filenames) if priority else 0
                if score > best_score:
                    best = tool
                    best_score = score
            elif not detect:
                # Fallback: match by supported_formats
                exts = tool.supported_formats or []
                if any(any(fn.lower().endswith(ext) for ext in exts) for fn in filenames):
                    if 0 > best_score:
                        best = tool
                        best_score = 0
        return best

    def get_all_workflow_node_definitions(self) -> list[dict]:
        """Return node_definition dicts for all enabled workflow_node tools."""
        return [
            t.node_definition
            for t in self._tools.values()
            if t.category == "workflow_node" and t.enabled and t.node_definition
        ]

    async def call(self, tool_id: str, arguments: dict, **kwargs) -> "ToolResult":
        """Execute a tool by ID. Central dispatch point for all callers."""
        from .executor import execute_tool
        tool = self.get(tool_id)
        if not tool:
            from .models import ToolResult
            return ToolResult(data={}, output_type="text", tool_id=tool_id, error=f"Tool not found: {tool_id}")
        return await execute_tool(tool, arguments, **kwargs)
