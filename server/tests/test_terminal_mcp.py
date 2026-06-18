"""Unit tests for the catgo_terminal MCP handler."""
import asyncio

from catgo.mcp_tools import server_claude_code as scc
from catgo.routers import terminal_bridge as tb


def _run(args):
    return asyncio.run(scc._handle_terminal(args))


def test_handler_resolves_through_real_bridge():
    """End-to-end backend round-trip: the MCP handler awaits the REAL
    request_terminal, a (renderer-simulated) result POST resolves it."""
    async def go():
        handler_task = asyncio.ensure_future(
            scc._handle_terminal({"action": "read", "lines": 10})
        )
        pending = []
        for _ in range(20):
            await asyncio.sleep(0)
            pending = tb.list_pending()["pending"]
            if pending:
                break
        assert len(pending) == 1
        assert pending[0]["action"] == "read"
        rid = pending[0]["request_id"]
        tb.post_result({"request_id": rid, "output": "BUFFER_XYZ", "target": "local shell"})
        return await handler_task

    out = asyncio.run(go())
    assert "BUFFER_XYZ" in out[0].text
    assert "local shell" in out[0].text


def test_bad_action_rejected():
    out = _run({"action": "frobnicate"})
    assert "action must be" in out[0].text


def test_run_formats_output(monkeypatch):
    async def fake_request(action, payload):
        assert action == "run"
        assert payload == {"command": "pwd"}
        return {"output": "/home/x", "exit_code": 0, "target": "local shell"}

    monkeypatch.setattr(
        "catgo.routers.terminal_bridge.request_terminal", fake_request
    )
    out = _run({"action": "run", "command": "pwd"})
    assert "/home/x" in out[0].text
    assert "exit 0" in out[0].text


def test_denied(monkeypatch):
    async def fake_request(action, payload):
        return {"denied": True}

    monkeypatch.setattr(
        "catgo.routers.terminal_bridge.request_terminal", fake_request
    )
    out = _run({"action": "run", "command": "rm -rf /"})
    assert "denied" in out[0].text


def test_error_surfaced(monkeypatch):
    async def fake_request(action, payload):
        return {"error": "No terminal responded — timed out."}

    monkeypatch.setattr(
        "catgo.routers.terminal_bridge.request_terminal", fake_request
    )
    out = _run({"action": "read"})
    assert "No terminal responded" in out[0].text
