"""File sandbox for CatBot-authored files.

Provides a staging/approval workflow for AI-generated files written to
~/.catgo/{plugins,scripts,config,tools}.  Files are validated, audited,
and held in an ephemeral proposal store until explicitly approved or
rejected by the user.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from .sandbox import audit_code

logger = logging.getLogger(__name__)

__all__ = [
    "SANDBOX_DIRS",
    "MAX_FILE_SIZE",
    "validate_path",
    "audit_file",
    "stage_file",
    "commit_file",
    "reject_file",
    "get_proposal",
    "write_direct",
    "get_template",
]

# ── Constants ──

SANDBOX_DIRS: dict[str, Path] = {
    "plugins": Path.home() / ".catgo" / "plugins",
    "scripts": Path.home() / ".catgo" / "scripts",
    "config":  Path.home() / ".catgo" / "config",
    "tools":   Path.home() / ".catgo" / "tools",
}

MAX_FILE_SIZE = 1_048_576  # 1 MB

_VALID_FILENAME = re.compile(r'^[a-zA-Z0-9_.\-]+$')

# ── Ephemeral proposal store ──
# proposal_id -> {content, target_path, description, timestamp, audit_warnings}
_proposals: dict[str, dict] = {}


def _cleanup_stale(max_age: int = 3600) -> None:
    """Remove proposals older than *max_age* seconds."""
    now = time.time()
    expired = [k for k, v in _proposals.items() if now - v["timestamp"] > max_age]
    for k in expired:
        del _proposals[k]
    if expired:
        logger.info("Cleaned up %d stale file proposals", len(expired))


# ── Validation helpers ──

def validate_path(target_path: str) -> tuple[bool, str, str]:
    """Validate that *target_path* falls within an allowed sandbox directory.

    Returns:
        (ok, message_or_resolved, category)
        On success: (True, resolved_absolute_path, category_name)
        On failure: (False, error_message, "")
    """
    expanded = Path(target_path).expanduser()
    resolved = expanded.resolve()

    # Check filename safety
    filename = resolved.name
    if ".." in filename:
        return (False, "Filename must not contain '..'", "")
    if "\x00" in filename:
        return (False, "Filename must not contain null bytes", "")
    if not _VALID_FILENAME.match(filename):
        return (
            False,
            f"Filename contains invalid characters: '{filename}'. "
            "Only alphanumerics, underscores, hyphens, and dots are allowed.",
            "",
        )

    # Check that the resolved path is inside one of the sandbox dirs
    for category, sandbox_dir in SANDBOX_DIRS.items():
        sandbox_resolved = sandbox_dir.resolve()
        if resolved.is_relative_to(sandbox_resolved):
            return (True, str(resolved), category)

    allowed = ", ".join(f"~/.catgo/{k}" for k in SANDBOX_DIRS)
    return (False, f"Path not within allowed sandbox directories: {allowed}", "")


def audit_file(content: str, filename: str) -> list[str]:
    """Audit file content based on its extension.

    Returns a list of warnings/violations (empty means clean).
    """
    if filename.endswith(".py"):
        return audit_code(content)

    if filename.endswith(".json"):
        try:
            json.loads(content)
        except (json.JSONDecodeError, ValueError) as e:
            return [f"Invalid JSON: {e}"]
        return []

    if filename.endswith((".yaml", ".yml")):
        return []

    return [f"File type '{Path(filename).suffix or 'unknown'}' is not audited — review content carefully before approving"]


# ── Stage / Commit / Reject ──

def stage_file(
    content: str,
    target_path: str,
    description: str = "",
    overwrite: bool = False,
) -> dict:
    """Stage a file for user approval.

    Raises:
        ValueError: If content exceeds size limit or path validation fails.
    """
    _cleanup_stale()

    # Size check
    if len(content.encode("utf-8")) > MAX_FILE_SIZE:
        raise ValueError(
            f"File content exceeds maximum size of {MAX_FILE_SIZE} bytes (1 MB)"
        )

    # Path validation
    ok, msg_or_path, category = validate_path(target_path)
    if not ok:
        raise ValueError(msg_or_path)

    resolved_path = msg_or_path
    filename = Path(resolved_path).name

    # Audit
    warnings = audit_file(content, filename)

    # Existence check
    target_exists = Path(resolved_path).exists()
    if target_exists and not overwrite:
        warnings.append("File already exists and will be overwritten")

    # Store proposal
    proposal_id = uuid.uuid4().hex[:12]
    _proposals[proposal_id] = {
        "content": content,
        "target_path": resolved_path,
        "description": description,
        "timestamp": time.time(),
        "audit_warnings": warnings,
    }

    logger.info(
        "Staged file proposal %s -> %s (%s, %d warnings)",
        proposal_id, resolved_path, category, len(warnings),
    )

    return {
        "proposal_id": proposal_id,
        "target_path": resolved_path,
        "category": category,
        "filename": filename,
        "content": content,
        "description": description,
        "audit_warnings": warnings,
        "file_exists": target_exists,
    }


def commit_file(proposal_id: str) -> dict:
    """Write a previously staged file to disk.

    Raises:
        KeyError: If proposal_id is not found.
    """
    proposal = _proposals.get(proposal_id)
    if proposal is None:
        raise KeyError(f"Proposal '{proposal_id}' not found or already consumed")

    target_path = Path(proposal["target_path"])

    # Defense-in-depth: re-validate path before writing
    ok, msg, _ = validate_path(str(target_path))
    if not ok:
        raise ValueError(f"Path validation failed on commit: {msg}")

    # Write first, then pop — so proposal survives if write fails
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(proposal["content"], encoding="utf-8")

    # Only remove from store after successful write
    _proposals.pop(proposal_id, None)
    logger.info("Committed file proposal %s -> %s", proposal_id, target_path)

    return {"status": "committed", "path": str(target_path)}


def reject_file(proposal_id: str) -> dict:
    """Reject and discard a staged file proposal.

    Raises:
        KeyError: If proposal_id is not found.
    """
    proposal = _proposals.pop(proposal_id, None)
    if proposal is None:
        raise KeyError(f"Proposal '{proposal_id}' not found or already consumed")

    logger.info("Rejected file proposal %s", proposal_id)

    return {"status": "rejected"}


def get_proposal(proposal_id: str) -> dict | None:
    """Return a proposal by ID, or None if not found."""
    return _proposals.get(proposal_id)


def write_direct(content: str, target_path: str) -> dict:
    """Validate, audit, and write a file directly (no staging).

    Intended for the Claude Code path where human approval is implicit.

    Raises:
        ValueError: If path validation fails or content exceeds size limit.
    """
    if len(content.encode("utf-8")) > MAX_FILE_SIZE:
        raise ValueError(
            f"File content exceeds maximum size of {MAX_FILE_SIZE} bytes (1 MB)"
        )

    ok, msg_or_path, category = validate_path(target_path)
    if not ok:
        raise ValueError(msg_or_path)

    resolved = msg_or_path
    filename = Path(resolved).name
    warnings = audit_file(content, filename)

    target = Path(resolved)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

    logger.info("Direct-wrote file %s (%s, %d warnings)", resolved, category, len(warnings))

    return {"status": "written", "path": resolved, "audit_warnings": warnings}


# ── Templates ──

_PLUGIN_TEMPLATE = '''\
"""CatGO MCP plugin — <description>.

Drop this file into ~/.catgo/plugins/ and it will be auto-loaded.
"""

TOOL_DEF = {
    "name": "catgo_my_tool",
    "description": "Short description of what this tool does",
    "inputSchema": {
        "type": "object",
        "properties": {
            "param1": {
                "type": "string",
                "description": "First parameter",
            },
        },
        "required": ["param1"],
    },
}


async def handle(arguments: dict, client, api_base: str):
    """Execute the tool.

    Args:
        arguments: Validated input matching inputSchema.
        client: httpx.AsyncClient for calling CatGO backend endpoints.
        api_base: Base URL of the CatGO API (e.g. "http://localhost:8000/api").

    Returns:
        list of TextContent dicts: [{"type": "text", "text": "..."}]
    """
    param1 = arguments.get("param1", "")

    # Example: call a backend endpoint
    # resp = await client.post(f"{api_base}/some/endpoint", json={"key": param1})
    # data = resp.json()

    return [{"type": "text", "text": f"Result for {param1}"}]
'''

_SCRIPT_TEMPLATE = '''\
"""CatGO analysis script — <description>.

This script can be executed via the CatBot sandbox runner.
Only stdlib + numpy/scipy/pymatgen/ase imports are allowed.
"""

import numpy as np


def analyze(data: dict) -> dict:
    """Run analysis on the provided data.

    Args:
        data: Input data dictionary.

    Returns:
        Results dictionary.
    """
    results = {}
    # Add your analysis logic here
    return results


if __name__ == "__main__":
    import json
    sample = {}
    print(json.dumps(analyze(sample), indent=2))
'''

_WORKFLOW_NODE_TEMPLATE = '''\
"""CatGO workflow node plugin — <description>.

Custom workflow step that integrates into the CatGO workflow engine.
"""

TOOL_DEF = {
    "name": "catgo_workflow_my_step",
    "description": "Custom workflow step",
    "inputSchema": {
        "type": "object",
        "properties": {
            "structure": {
                "type": "object",
                "description": "Input structure dict (pymatgen format)",
            },
        },
        "required": ["structure"],
    },
}


async def handle(arguments: dict, client, api_base: str):
    """Execute the workflow step.

    Args:
        arguments: Must contain 'structure' key with pymatgen-format dict.
        client: httpx.AsyncClient for backend calls.
        api_base: CatGO API base URL.

    Returns:
        list of TextContent with the resulting structure or status.
    """
    structure = arguments.get("structure", {})

    # Process the structure — example: pass through
    return [{"type": "text", "text": "Workflow step completed"}]
'''

_CONFIG_TEMPLATE = '''\
{
    "$schema": "https://catgo.dev/schemas/config.json",
    "name": "my-config",
    "description": "Configuration for ...",
    "settings": {}
}
'''

_TEMPLATES: dict[str, str] = {
    "plugin": _PLUGIN_TEMPLATE,
    "script": _SCRIPT_TEMPLATE,
    "workflow_node": _WORKFLOW_NODE_TEMPLATE,
    "config": _CONFIG_TEMPLATE,
}


def get_template(file_type: str) -> str:
    """Return a starter template for the given file type.

    Supported types: plugin, script, workflow_node, config.

    Raises:
        ValueError: If file_type is not recognized.
    """
    template = _TEMPLATES.get(file_type)
    if template is None:
        available = ", ".join(sorted(_TEMPLATES))
        raise ValueError(f"Unknown template type '{file_type}'. Available: {available}")
    return template
