# server/tools/builder.py
"""AI tool lifecycle — create, save, upgrade, delete."""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Optional

from .models import ToolEntry, ToolResult
from .sandbox import audit_code, verify_tool_format, execute_in_sandbox

logger = logging.getLogger(__name__)

# Session-scoped ephemeral store: ephemeral_id -> (code, TOOL dict, ToolResult, timestamp)
_ephemeral_store: dict[str, tuple[str, dict, ToolResult, float]] = {}


def _cleanup_ephemeral(max_age: int = 3600):
    """Remove ephemeral entries older than max_age seconds."""
    now = time.time()
    expired = [k for k, v in _ephemeral_store.items() if now - v[3] > max_age]
    for k in expired:
        del _ephemeral_store[k]


async def create_from_code(
    code: str,
    test_input: Optional[dict] = None,
    injected_structure: Optional[dict] = None,
) -> tuple[ToolResult, str]:
    """Create, audit, test, and execute a tool from source code.

    Returns (result, ephemeral_id).
    Raises ValueError if audit or format check fails.
    """
    _cleanup_ephemeral()

    # Step 1: Audit
    violations = audit_code(code)
    if violations:
        raise ValueError(f"Audit failed:\n" + "\n".join(violations))

    # Step 2: Verify format
    format_errors = verify_tool_format(code)
    if format_errors:
        raise ValueError(f"Format check failed:\n" + "\n".join(format_errors))

    # Step 3: Extract TOOL dict (lightweight exec)
    tool_dict = _extract_tool_dict(code)

    # Step 4: Build context
    context = {"params": test_input or {}}
    if injected_structure:
        context["structure"] = injected_structure

    # Step 5: Execute in sandbox
    try:
        result_data = execute_in_sandbox(code, context)
    except RuntimeError as e:
        return ToolResult(
            data={}, output_type=tool_dict.get("output_type", "text"),
            tool_id=tool_dict.get("name", "unknown"),
            error=str(e),
        ), None  # None signals save is not possible

    result = ToolResult(
        data=result_data,
        output_type=tool_dict.get("output_type", "text"),
        tool_id=tool_dict.get("name", "unknown"),
    )

    # Step 6: Store ephemerally
    ephemeral_id = str(uuid.uuid4())[:8]
    _ephemeral_store[ephemeral_id] = (code, tool_dict, result, time.time())

    return result, ephemeral_id


def save_tool(
    ephemeral_id: str,
    save_as: Optional[str] = None,
    tools_dir: Optional[Path] = None,
) -> ToolEntry:
    """Persist an ephemeral tool to disk.

    Args:
        ephemeral_id: ID returned by create_from_code
        save_as: Override tool ID (defaults to TOOL["name"])
        tools_dir: Directory to save to (defaults to ~/.catgo/tools/)
    """
    if ephemeral_id not in _ephemeral_store:
        raise KeyError(f"Ephemeral tool not found: {ephemeral_id}")

    code, tool_dict, _, _ts = _ephemeral_store.pop(ephemeral_id)
    tool_id = save_as or tool_dict.get("name", ephemeral_id)

    if tools_dir is None:
        tools_dir = Path.home() / ".catgo" / "tools"
    tools_dir.mkdir(parents=True, exist_ok=True)

    tool_dir = tools_dir / tool_id
    tool_dir.mkdir(exist_ok=True)

    # Write tool.py
    (tool_dir / "tool.py").write_text(code, encoding="utf-8")

    # Write manifest
    manifest = {
        "name": tool_id,
        "version": tool_dict.get("version", "1.0.0"),
        "displayName": tool_dict.get("display_name", tool_id),
        "description": tool_dict.get("description", ""),
        "trust": "sandboxed",
    }
    (tool_dir / "catgo-tool.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # Load as ToolEntry
    from .discovery import load_tool_from_path
    return load_tool_from_path(tool_dir, default_trust="sandboxed")


def upgrade_trust(
    tool_id: str,
    trust: str,
    registry=None,
    tools_dir: Optional[Path] = None,
) -> None:
    """Upgrade a saved tool's trust level by updating its manifest."""
    if trust not in ("user",):
        raise ValueError(f"Cannot upgrade to trust level: {trust}")

    if tools_dir is None:
        tools_dir = Path.home() / ".catgo" / "tools"

    manifest_path = tools_dir / tool_id / "catgo-tool.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Tool manifest not found: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["trust"] = trust
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    logger.info("Upgraded tool %s to trust=%s", tool_id, trust)

    # Update in-memory registry entry
    if registry:
        tool = registry.get(tool_id)
        if tool:
            tool.trust = trust


def delete_tool(
    tool_id: str,
    registry=None,
    tools_dir: Optional[Path] = None,
) -> bool:
    """Delete a saved tool from disk."""
    # Unregister from memory first
    if registry:
        registry.unregister(tool_id)

    if tools_dir is None:
        tools_dir = Path.home() / ".catgo" / "tools"

    tool_dir = tools_dir / tool_id
    if not tool_dir.exists():
        return False

    import shutil
    shutil.rmtree(tool_dir)
    logger.info("Deleted tool %s", tool_id)
    return True


def list_ephemeral() -> list[str]:
    """List ephemeral tool IDs in the current session."""
    return list(_ephemeral_store.keys())


def _extract_tool_dict(code: str) -> dict:
    """Extract TOOL dict from source without full execution.

    Uses ast.literal_eval() instead of exec() for safety — only
    static dict literals are supported.
    """
    import ast
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "TOOL":
                    try:
                        return ast.literal_eval(node.value)
                    except (ValueError, TypeError):
                        return {}
    return {}
