# server/routers/tools.py
"""REST API for the unified tool system."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Any, Optional

from catgo.tools import registry
from catgo.tools.executor import execute_tool
from catgo.tools.models import ToolResult

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tools", tags=["tools"])


# -- List / Get --

@router.get("/")
def list_tools(category: Optional[str] = None):
    """List all registered tools."""
    if category:
        tools = registry.list_by_category(category)
    else:
        tools = registry.list_all()
    return [t.to_dict() for t in tools]


@router.get("/calculators")
def list_calculators():
    return [t.to_dict() for t in registry.list_by_category("calculator")]


@router.get("/readers")
def list_readers():
    return [t.to_dict() for t in registry.list_by_category("reader")]


@router.get("/workflow-nodes")
def list_workflow_nodes():
    """List workflow node definitions from ToolRegistry plugins."""
    nodes = registry.get_all_workflow_node_definitions()
    return {"nodes": nodes}


@router.get("/{tool_id}")
def get_tool(tool_id: str):
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")
    return tool.to_dict()


# -- Execute --

@router.post("/{tool_id}/run")
async def run_tool(tool_id: str, arguments: dict = {}):
    """Execute a tool and return the result."""
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")

    # Auto-inject structure from viewer (internal call, not HTTP to self)
    injected = _get_current_structure()

    result = await execute_tool(tool, arguments, injected_structure=injected)
    return {
        "data": result.data,
        "output_type": result.output_type,
        "tool_id": result.tool_id,
        "error": result.error,
        "session_id": result.session_id,
    }


def _get_current_structure():
    """Get current structure from the view state store (internal, no HTTP)."""
    try:
        from catgo.routers.view_capture import _current_structure_dict
        return _current_structure_dict or None
    except Exception:
        return None


# -- Enable / Disable --

@router.post("/{tool_id}/enable")
def enable_tool(tool_id: str):
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")
    registry.enable(tool_id)
    return {"status": "enabled", "tool_id": tool_id}


@router.post("/{tool_id}/disable")
def disable_tool(tool_id: str):
    tool = registry.get(tool_id)
    if not tool:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")
    registry.disable(tool_id)
    return {"status": "disabled", "tool_id": tool_id}


# -- AI Create / Save / Upgrade / Delete --

class CreateToolRequest(BaseModel):
    code: str
    test_input: Optional[dict] = None


@router.post("/create")
async def create_tool(req: CreateToolRequest):
    """AI generate + audit + sandbox test + execute."""
    from tools.builder import create_from_code

    injected = _get_current_structure()

    try:
        result, ephemeral_id = await create_from_code(
            req.code,
            test_input=req.test_input,
            injected_structure=injected,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "data": result.data,
        "output_type": result.output_type,
        "tool_id": result.tool_id,
        "error": result.error,
        "ephemeral_id": ephemeral_id,
    }


class SaveToolRequest(BaseModel):
    ephemeral_id: str
    save_as: Optional[str] = None


@router.post("/{tool_id}/save")
def save_tool_endpoint(tool_id: str, req: SaveToolRequest):
    from tools.builder import save_tool
    try:
        entry = save_tool(req.ephemeral_id, save_as=req.save_as)
        # Register in registry
        registry.register(entry)
        return {"status": "saved", "tool": entry.to_dict()}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


class UpgradeToolRequest(BaseModel):
    trust: str = "user"


@router.post("/{tool_id}/upgrade")
def upgrade_tool_endpoint(tool_id: str, req: UpgradeToolRequest):
    from tools.builder import upgrade_trust
    try:
        upgrade_trust(tool_id, req.trust)
        # Update in-memory entry
        tool = registry.get(tool_id)
        if tool:
            tool.trust = req.trust
        return {"status": "upgraded", "tool_id": tool_id, "trust": req.trust}
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{tool_id}")
def delete_tool_endpoint(tool_id: str):
    from tools.builder import delete_tool
    registry.unregister(tool_id)
    deleted = delete_tool(tool_id)
    return {"status": "deleted" if deleted else "not_found", "tool_id": tool_id}


@router.post("/discover")
def discover_tools_endpoint():
    """Re-scan tool directories and register new tools."""
    from tools.discovery import discover_tools
    from pathlib import Path

    dirs = []
    project_plugins = Path(__file__).resolve().parent.parent.parent / "plugins"
    if project_plugins.exists():
        dirs.append(project_plugins)
    user_tools = Path.home() / ".catgo" / "tools"
    if user_tools.exists():
        dirs.append(user_tools)

    entries, errors = discover_tools(dirs)
    for entry in entries:
        registry.register(entry)

    return {
        "discovered": len(entries),
        "errors": [{"path": str(p), "error": e} for p, e in errors],
    }
