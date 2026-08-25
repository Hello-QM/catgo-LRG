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
import contextlib
import io
import os
import sys
import threading
import traceback

CAMPAIGN_ACTIONS = (
    "new", "fetch-ref", "submit", "poll", "aggregate", "report", "ingest", "archive",
)

# server/ — this file is server/catgo/campaign_cli.py, so two dirnames up.
_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_IN_PROCESS_CAPTURE_LOCK = threading.Lock()


def campaign_argv(action: str, extra: list[str]) -> list[str]:
    """Build argv for the source/wheel Campaign subprocess (pure).

    A PyInstaller one-file bundle cannot safely launch ``sys.executable`` here:
    that is the complete ``catgo-server`` sidecar, not a Python interpreter,
    and Windows would unpack the hundreds-of-MB backend again for every
    Campaign action. Frozen callers must use the in-process path in
    :func:`run_campaign_cli`.
    """
    if getattr(sys, "frozen", False):
        raise RuntimeError("frozen Campaign actions execute in-process")
    return [sys.executable, "-m", "catgo", "campaign", action, *extra]


def _run_campaign_in_process(action: str, extra: list[str]) -> tuple[str, int]:
    """Run one Campaign action inside an already-extracted frozen backend."""

    from catgo.cli.campaign_cmd import run_campaign

    output = io.StringIO()
    # redirect_stdout/redirect_stderr are process-global. Serialize Campaign
    # invocations so two agent requests cannot steal each other's CLI output.
    # The server's logging handler already owns its original stream, so normal
    # backend logs remain visible while this short-lived capture is active.
    with (
        _IN_PROCESS_CAPTURE_LOCK,
        contextlib.redirect_stdout(output),
        contextlib.redirect_stderr(output),
    ):
        try:
            code = int(run_campaign([action, *extra]) or 0)
        except SystemExit as exc:
            if exc.code is None:
                code = 0
            elif isinstance(exc.code, int):
                code = exc.code
            else:
                print(exc.code, file=sys.stderr)
                code = 1
        except Exception:  # noqa: BLE001 — match subprocess traceback semantics
            traceback.print_exc()
            code = 1
    return output.getvalue(), code


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
    if getattr(sys, "frozen", False):
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(_run_campaign_in_process, action, extra),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            return ("", -1)

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
