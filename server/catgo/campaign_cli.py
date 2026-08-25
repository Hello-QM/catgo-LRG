"""Shared runner for the `catgo campaign` md-orchestration CLI.

Used by BOTH the SDK-agent MCP tool (``_handle_campaign`` in
``mcp_tools/server_claude_code.py``) and the client-direct HTTP route
(``POST /api/campaign/run`` in ``routers/campaign.py``) so both resolve the
``catgo`` module the same way and validate the action enum identically.

GOTCHA: ``catgo`` is not pip-installed and the backend process runs from a cwd
that is not ``server/``, so a bare ``python -m catgo`` subprocess fails with
"No module named catgo". We put ``server/`` on the child's PYTHONPATH.
"""
from __future__ import annotations

import asyncio
import os
import sys

CAMPAIGN_ACTIONS = (
    "new", "fetch-ref", "submit", "poll", "aggregate", "report", "ingest", "archive",
)

# server/ — this file is server/catgo/campaign_cli.py, so two dirnames up.
_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def campaign_argv(action: str, extra: list[str]) -> list[str]:
    """Build argv for the campaign subprocess (pure).

    In a PyInstaller bundle, ``sys.executable`` is the ``catgo-server``
    sidecar itself rather than a Python interpreter.  That executable exposes
    the regular CatGo CLI as ``catgo-server campaign ...``; passing ``-m`` to
    it would instead enter the backend argument parser and fail.  Source and
    wheel installs continue to use ``python -m catgo``.
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, "campaign", action, *extra]
    return [sys.executable, "-m", "catgo", "campaign", action, *extra]


async def run_campaign_cli(
    action: str, extra: list[str], timeout: float = 300.0,
) -> tuple[str, int]:
    """Run the campaign CLI; return ``(combined_output, exit_code)``.

    ``exit_code`` is ``-1`` on timeout. Raises ``ValueError`` for an action not
    in :data:`CAMPAIGN_ACTIONS`. No shell is used (argv is passed directly), so
    args cannot inject shell commands.
    """
    if action not in CAMPAIGN_ACTIONS:
        raise ValueError(
            f"action must be one of {', '.join(CAMPAIGN_ACTIONS)}"
        )
    env = {
        **os.environ,
        "PYTHONPATH": _SERVER_DIR + os.pathsep + os.environ.get("PYTHONPATH", ""),
    }
    proc = await asyncio.create_subprocess_exec(
        *campaign_argv(action, extra),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        return ("", -1)
    code = proc.returncode if proc.returncode is not None else -1
    return ((out or b"").decode("utf-8", "replace"), code)
