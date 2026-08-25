#!/usr/bin/env python3
"""Exercise CatBot's packaged backend bridge through a frozen sidecar.

The smoke test covers the routes and MCP tools CatBot depends on without
requiring cloud credentials or an HPC cluster.  In particular it catches
missing PyInstaller resources/imports and recursive CLI argv mistakes that
source-only tests cannot see.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _request_json(
    url: str,
    payload: dict | None = None,
    *,
    timeout: float = 5,
) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with _OPENER.open(request, timeout=timeout) as response:
        return json.load(response)


def _process_group_options() -> dict[str, int | bool]:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _terminate_process_tree(process: subprocess.Popen) -> None:
    """Stop a one-file PyInstaller launcher and the extracted child process."""

    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
        )
    elif process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    try:
        process.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass

    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif process.poll() is None:
        process.kill()
    process.wait(timeout=10)


def _direct_httpx_client(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers=headers,
        timeout=timeout,
        auth=auth,
        trust_env=False,
    )


async def _smoke_mcp(base: str, campaign: Path) -> None:
    async with streamablehttp_client(
        f"{base}/api/mcp/",
        httpx_client_factory=_direct_httpx_client,
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = await session.list_tools()
            names = {tool.name for tool in listed.tools}
            required = {
                "catgo_analyze",
                "catgo_campaign",
                "catgo_catalysis",
                "catgo_diagnose",
                "catgo_fetch",
                "catgo_file",
                "catgo_heterostructure",
                "catgo_moire",
                "catgo_nanoparticle",
                "catgo_nanotube",
                "catgo_structure",
                "catgo_pane",
                "catgo_workflow",
                "catgo_workflow_engine",
                "catgo_system",
                "catgo_skills",
                "catgo_terminal",
                "catgo_quickbuild",
                "catgo_validate_config",
                "catgo_verify",
                "catgo_view",
            }
            missing = sorted(required - names)
            if missing:
                raise RuntimeError(f"frozen MCP is missing CatBot tools: {missing}")

            for name, arguments in [
                ("catgo_skills", {"action": "list"}),
                ("catgo_system", {"action": "status"}),
                ("catgo_workflow", {"action": "list"}),
                ("catgo_view", {"action": "get_state"}),
                ("catgo_pane", {"action": "list"}),
                ("catgo_structure", {"action": "get"}),
            ]:
                result = await session.call_tool(name, arguments)
                if result.isError:
                    raise RuntimeError(f"{name} failed in frozen MCP: {result.content}")

            result = await session.call_tool(
                "catgo_campaign",
                {
                    "action": "new",
                    "args": [
                        str(campaign),
                        "--name",
                        "Frozen MCP Campaign Smoke",
                        "--template",
                        "blank",
                    ],
                },
            )
            if result.isError or not (campaign / "plan.md").is_file():
                raise RuntimeError(
                    f"catgo_campaign failed in frozen MCP: {result.content}"
                )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("backend", type=Path)
    args = parser.parse_args()

    backend = args.backend.resolve()
    if not backend.is_file():
        parser.error(f"backend not found: {backend}")

    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="catgo-frozen-smoke-") as tmp:
        tmp_path = Path(tmp)
        campaign = tmp_path / "campaign"
        mcp_campaign = tmp_path / "mcp-campaign"
        log_path = tmp_path / "backend.log"
        with log_path.open("w+", encoding="utf-8") as log_file:
            process = subprocess.Popen(
                [str(backend), "--port", str(port)],
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
                env={
                    **os.environ,
                    # A real, fast-starting executable is enough to verify that
                    # packaged provider overrides survive into the backend.
                    # Reusing the one-file backend here would recursively unpack
                    # hundreds of MB during Codex model discovery on Windows.
                    "CATGO_CLAUDE_PATH": sys.executable,
                    "CATGO_CODEX_PATH": sys.executable,
                    "CATGO_GEMINI_PATH": sys.executable,
                },
                **_process_group_options(),
            )
            try:
                base = f"http://127.0.0.1:{port}"
                deadline = time.monotonic() + 90
                last_error: Exception | None = None
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log_file.seek(0)
                        raise RuntimeError(
                            f"backend exited with {process.returncode}:\n{log_file.read()}"
                        )
                    try:
                        health = _request_json(f"{base}/health")
                        if health.get("status") == "healthy":
                            break
                    except (OSError, urllib.error.URLError, TimeoutError) as exc:
                        last_error = exc
                    time.sleep(0.5)
                else:
                    raise RuntimeError(f"backend did not become healthy: {last_error}")

                skills = _request_json(f"{base}/api/skills/").get("skills", [])
                if "campaign" not in skills or "workflow_builder" not in skills:
                    raise RuntimeError("frozen backend did not bundle core CatBot skills")

                stt = _request_json(f"{base}/api/stt/health")
                if stt.get("available") is not True:
                    raise RuntimeError(f"frozen CatBot native voice input is unavailable: {stt}")

                providers = _request_json(f"{base}/api/chat/providers").get("providers", [])
                provider_map = {provider.get("id"): provider for provider in providers}
                expected_providers = {
                    "sdk-claude",
                    "sdk-codex",
                    "sdk-gemini",
                    "deepseek",
                    "qwen",
                    "kimi",
                    "zhipu",
                    "gemini",
                    "anthropic",
                    "custom",
                    "ollama",
                }
                missing_providers = sorted(expected_providers - provider_map.keys())
                if missing_providers:
                    raise RuntimeError(
                        f"frozen CatBot provider catalogue is incomplete: {missing_providers}"
                    )
                for provider_id in ("sdk-claude", "sdk-codex", "sdk-gemini"):
                    if provider_id not in provider_map:
                        raise RuntimeError(f"missing CatBot provider: {provider_id}")
                    if provider_map[provider_id].get("available") is not True:
                        raise RuntimeError(
                            f"CatBot ignored packaged provider override: {provider_id}"
                        )

                result = _request_json(
                    f"{base}/api/campaign/run",
                    {
                        "action": "new",
                        "args": [
                            str(campaign),
                            "--name",
                            "Frozen Campaign Smoke",
                            "--template",
                            "blank",
                        ],
                    },
                    # The first frozen Campaign invocation imports its CLI and
                    # stages bundled skills. Windows CI can legitimately need
                    # more than the generic five-second API smoke budget.
                    timeout=60,
                )
                if not result.get("ok"):
                    raise RuntimeError(f"campaign bridge failed: {result}")
                if not (campaign / "plan.md").is_file():
                    raise RuntimeError(f"campaign scaffold missing plan.md: {campaign}")

                asyncio.run(_smoke_mcp(base, mcp_campaign))
            finally:
                _terminate_process_tree(process)

    print(f"Frozen CatBot smoke test passed: {backend}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
