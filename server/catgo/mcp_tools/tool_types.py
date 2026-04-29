"""Type definitions for MCP tool schemas."""

from typing import Any, TypedDict


class ToolInputSchema(TypedDict):
    type: str
    properties: dict[str, Any]
    required: list[str]


class ToolDefinition(TypedDict):
    name: str
    description: str
    inputSchema: ToolInputSchema
