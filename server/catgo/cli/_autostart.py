"""Spawn `catgo serve --daemon` for needs_server CLI ops, poll /health."""
from __future__ import annotations

import subprocess
import sys
import time

from catgo.cli.adapter import OpError
from catgo.cli.server_link import ServerLink


def spawn_daemon_and_wait(timeout: float = 20.0) -> ServerLink:
    """Spawn the daemon and poll /health with exponential backoff.

    Raises OpError on spawn failure or timeout. Does NOT kill the spawned
    process on timeout (port may already be in use by another service).
    """
    # In a PyInstaller build `sys.executable` is the frozen `catgo-server`
    # binary, which does NOT honor `-m catgo`; launching it bare starts the
    # server directly (and records ~/.catgo/server.port for discovery).
    if getattr(sys, "frozen", False):
        cmd = [sys.executable]
    else:
        cmd = [sys.executable, "-m", "catgo", "serve", "--daemon"]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"backend spawn failed: {exc}") from exc

    delay = 0.2
    waited = 0.0
    while waited < timeout:
        link = ServerLink.discover()
        if link is not None:
            return link
        time.sleep(delay)
        waited += delay
        delay = min(delay * 2, 2.0)

    err_tail = ""
    if proc.stderr is not None:
        try:
            err_tail = proc.stderr.read(1024).decode(errors="replace")
        except Exception:  # noqa: BLE001
            pass
    raise OpError(
        f"backend failed to start within {timeout:.0f}s; "
        f"try `catgo serve` manually. stderr: {err_tail!r}")
