# server/tools/__init__.py
"""Tool-First architecture — unified tool system."""
from .models import ToolEntry, ToolResult, validate_tool_id
from .registry import ToolRegistry

registry = ToolRegistry()

__all__ = ["registry", "ToolEntry", "ToolResult", "ToolRegistry", "validate_tool_id"]
