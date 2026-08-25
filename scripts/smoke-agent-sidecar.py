#!/usr/bin/env python3
"""Smoke-test the compiled CatBot agent bridge on every desktop platform."""
from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _request(url: str, payload: dict | None = None, timeout: float = 30) -> str:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with _OPENER.open(request, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("agent", type=Path)
    parser.add_argument("backend", type=Path)
    args = parser.parse_args()

    agent = args.agent.resolve()
    backend = args.backend.resolve()
    for label, path in (("agent", agent), ("backend", backend)):
        if not path.is_file():
            parser.error(f"{label} executable not found: {path}")

    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="catgo-agent-smoke-") as tmp:
        log_path = Path(tmp) / "agent.log"
        env = {
            **os.environ,
            "CATGO_AGENT_PORT": str(port),
            "CATGO_BACKEND_PORT": "9",
            # Point every adapter at the runner's real Python executable,
            # which is intentionally not that provider's CLI. Each adapter
            # must terminate with a streamed error instead of hanging; this
            # also proves its packaged
            # SDK/import path is present and executable.
            "CATGO_CLAUDE_PATH": sys.executable,
            "CATGO_CODEX_PATH": sys.executable,
            "CATGO_GEMINI_PATH": sys.executable,
        }
        with log_path.open("w+", encoding="utf-8") as log_file:
            process = subprocess.Popen(
                [str(agent)],
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
            )
            try:
                base = f"http://127.0.0.1:{port}"
                deadline = time.monotonic() + 30
                last_error: Exception | None = None
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log_file.seek(0)
                        raise RuntimeError(
                            f"agent exited with {process.returncode}:\n{log_file.read()}"
                        )
                    try:
                        health = json.loads(_request(f"{base}/health", timeout=2))
                        if health.get("service") == "catgo-agent":
                            break
                    except (OSError, urllib.error.URLError, TimeoutError) as exc:
                        last_error = exc
                    time.sleep(0.25)
                else:
                    raise RuntimeError(f"agent did not become healthy: {last_error}")

                for provider in ("claude", "codex", "gemini"):
                    sessions = json.loads(
                        _request(
                            f"{base}/api/agent/sessions?agent={provider}",
                            timeout=10,
                        )
                    )
                    if not isinstance(sessions.get("sessions"), list):
                        raise RuntimeError(
                            f"{provider} packaged session discovery is unavailable: {sessions}"
                        )

                    stream = _request(
                        f"{base}/api/agent/stream",
                        {
                            "agent": provider,
                            "prompt": "packaged adapter smoke test",
                            "chatId": f"smoke-{provider}",
                            "attachments": [
                                {
                                    "type": "image",
                                    "name": "smoke.png",
                                    "mimeType": "image/png",
                                    "data": base64.b64encode(b"png").decode("ascii"),
                                }
                            ],
                        },
                        timeout=45,
                    )
                    if '"type":"done"' not in stream:
                        raise RuntimeError(
                            f"{provider} adapter did not close its error stream: {stream[-1000:]}"
                        )
                    if '"isError":true' not in stream:
                        raise RuntimeError(
                            f"{provider} adapter unexpectedly hid its spawn error: {stream[-1000:]}"
                        )

                permission = json.loads(
                    _request(
                        f"{base}/api/agent/permission",
                        {
                            "permissionId": "packaged-smoke-unknown",
                            "behavior": "deny",
                        },
                    )
                )
                if permission != {"ok": False}:
                    raise RuntimeError(
                        f"packaged permission route returned an invalid response: {permission}"
                    )
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)

    print(f"Packaged CatBot agent smoke test passed: {agent}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
