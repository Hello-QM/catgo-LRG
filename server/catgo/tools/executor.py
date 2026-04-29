# server/tools/executor.py
"""Unified tool execution — context assembly, trust dispatch, post-processing."""

from __future__ import annotations

import logging
from typing import Any, Optional

from .models import ToolEntry, ToolResult

logger = logging.getLogger(__name__)

# Known keys that are NOT params — extracted into context fields
_CONTEXT_KEYS = {"structure", "file_paths", "config"}


def build_context(category: str, arguments: dict) -> dict:
    """Assemble context dict from raw arguments based on category.

    IMPORTANT: Does NOT mutate arguments — makes a copy first.
    """
    args = dict(arguments) if arguments else {}
    structure = args.pop("structure", None)
    file_paths = args.pop("file_paths", None)
    config = args.pop("config", None)

    # Everything remaining is params
    params = args

    if category == "reader":
        return {"file_paths": file_paths or [], "params": params}
    elif category == "workflow_node":
        return {"structure": structure, "params": params, "config": config or {}}
    else:
        # general, calculator, optimizer
        return {"structure": structure, "params": params}


async def execute_tool(
    entry: ToolEntry,
    arguments: dict,
    *,
    injected_structure: Optional[dict] = None,
) -> ToolResult:
    """Execute a tool and return the result.

    Args:
        entry: The tool to execute
        arguments: Raw arguments from MCP/REST (not mutated)
        injected_structure: Auto-injected structure from viewer (if available)
    """
    if not entry.enabled:
        return ToolResult(
            data={}, output_type=entry.output_type, tool_id=entry.id,
            error=f"Tool '{entry.id}' is disabled",
        )

    if not entry.execute_fn:
        return ToolResult(
            data={}, output_type=entry.output_type, tool_id=entry.id,
            error=f"Tool '{entry.id}' has no execute function",
        )

    # Auto-inject structure if not provided (copy to avoid mutating caller's dict)
    args = dict(arguments)
    if injected_structure and "structure" not in args:
        args["structure"] = injected_structure

    context = build_context(entry.category, args)

    try:
        if entry.trust == "sandboxed":
            result_data = await _execute_sandboxed(entry, context)
        else:
            # builtin and user: direct call
            import asyncio
            if asyncio.iscoroutinefunction(entry.execute_fn):
                result_data = await entry.execute_fn(context)
            else:
                result_data = entry.execute_fn(context)

        if not isinstance(result_data, dict):
            result_data = {"content": str(result_data)}

        # Post-process by output_type
        result = ToolResult(
            data=result_data,
            output_type=entry.output_type,
            tool_id=entry.id,
        )
        await _post_process(result, entry)
        return result

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        logger.error("Tool %s execution failed: %s", entry.id, e)
        return ToolResult(
            data={}, output_type=entry.output_type, tool_id=entry.id,
            error=str(e), traceback=tb,
        )


async def _post_process(result: ToolResult, entry: ToolEntry) -> None:
    """Post-process result based on output_type.

    - electronic_dos/bands/cohp: create VaspData session, inject session_id
    - structure: auto-push to 3D viewer
    - atom_property: push property data to viewer
    """
    if result.error:
        return

    otype = result.output_type

    if otype in ("electronic_dos", "electronic_bands", "cohp"):
        try:
            # Create VaspData session (same as routers/plugins.py _create_dos_session_from_reader)
            from dos_analysis import create_session_from_dict
            session_id = create_session_from_dict(result.data, otype)
            result.session_id = session_id
            # Keep summary data but strip heavy arrays for the response
            result.data = {
                "session_id": session_id,
                "output_type": otype,
                "nions": result.data.get("nions", len(result.data.get("elements", []))),
                "elements": result.data.get("elements", []),
            }
        except ImportError:
            logger.warning("dos_analysis not available, skipping session creation")
        except Exception as e:
            logger.error("Failed to create %s session: %s", otype, e)

    elif otype == "structure":
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    "http://localhost:8000/api/view/structure/push",
                    json=result.data,
                )
        except Exception as e:
            logger.warning("Failed to push structure to viewer: %s", e)

    elif otype == "atom_property":
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as client:
                await client.post(
                    "http://localhost:8000/api/view/atom-property/push",
                    json=result.data,
                )
        except Exception as e:
            logger.warning("Failed to push atom_property to viewer: %s", e)


async def _execute_sandboxed(entry: ToolEntry, context: dict) -> dict:
    """Execute sandboxed tool via subprocess."""
    if not entry.path:
        raise RuntimeError("Sandboxed tool has no source path")

    source_path = entry.path / "tool.py"
    if not source_path.exists():
        raise RuntimeError(f"Tool source not found: {source_path}")

    source = source_path.read_text(encoding="utf-8")

    from .sandbox import execute_in_sandbox
    return execute_in_sandbox(source, context)
