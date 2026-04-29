# server/tools/models.py
"""Core data classes for the Tool-First architecture."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

_VALID_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

VALID_OUTPUT_TYPES = frozenset({
    "scatter_plot", "bar_plot", "table", "text", "image",
    "structure", "atom_property", "trajectory",
    "electronic_dos", "electronic_bands", "cohp",
})

VALID_CATEGORIES = frozenset({
    "general", "calculator", "reader", "optimizer", "workflow_node",
})


def validate_tool_id(tool_id: str) -> bool:
    """Check if tool_id matches [a-z0-9][a-z0-9_-]*."""
    return bool(_VALID_ID.match(tool_id))


@dataclass
class ToolResult:
    """Result of a tool execution."""
    data: dict
    output_type: str
    tool_id: str
    error: Optional[str] = None
    traceback: Optional[str] = None
    session_id: Optional[str] = None


@dataclass
class ToolEntry:
    """A registered tool in the ToolRegistry."""

    # Identity
    id: str
    name: str
    description: str
    version: str = "1.0.0"
    author: str = ""

    # Behavior
    category: str = "general"
    input_schema: dict = field(default_factory=dict)
    output_type: str = "text"

    # Trust
    trust: str = "sandboxed"
    permissions: list[str] = field(default_factory=list)

    # Source
    source: str = "code"
    path: Optional[Path] = None
    ephemeral: bool = False

    # Callables (not serialized)
    execute_fn: Optional[Callable] = field(default=None, repr=False)
    extra_fns: dict[str, Callable] = field(default_factory=dict, repr=False)

    # Optional frontend
    frontend: Optional[dict] = None

    # Category-specific
    supported_elements: Optional[list[str]] = None
    supported_formats: Optional[list[str]] = None
    multi_file: bool = False
    node_definition: Optional[dict] = None
    supports_cell_optimization: bool = False

    # State
    enabled: bool = True

    # Lifecycle
    on_load_fn: Optional[Callable] = field(default=None, repr=False)
    on_unload_fn: Optional[Callable] = field(default=None, repr=False)

    def to_dict(self) -> dict:
        """Serialize to dict for REST/MCP (excludes callables)."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "category": self.category,
            "input_schema": self.input_schema,
            "output_type": self.output_type,
            "trust": self.trust,
            "permissions": self.permissions,
            "enabled": self.enabled,
            "source": self.source,
            "supported_elements": self.supported_elements,
            "supported_formats": self.supported_formats,
            "multi_file": self.multi_file,
            "node_definition": self.node_definition,
            "supports_cell_optimization": self.supports_cell_optimization,
            "has_frontend": self.frontend is not None,
        }
