"""Round-trip tests for the terminal bridge (backend <-> renderer)."""
import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from catgo.mcp_tools import verify_enforcement as enf
from catgo.routers import terminal_bridge as tb


def test_request_result_round_trip():
    async def go():
        task = asyncio.ensure_future(tb.request_terminal("run", {"command": "echo hi"}))
        await asyncio.sleep(0)  # let request_terminal register the future
        pending = tb.list_pending()["pending"]
        assert len(pending) == 1
        assert pending[0]["action"] == "run"
        assert pending[0]["command"] == "echo hi"
        rid = pending[0]["request_id"]
        tb.post_result({"request_id": rid, "output": "hi", "exit_code": 0})
        return await task

    res = asyncio.run(go())
    assert res["output"] == "hi"
    assert res["exit_code"] == 0
    # after fulfilment the pending list is empty
    assert tb.list_pending()["pending"] == []


def test_post_result_unknown_id_raises():
    with pytest.raises(HTTPException):
        tb.post_result({"request_id": "nope"})


def _request(tab_id: str = "") -> Request:
    headers = []
    if tab_id:
        headers.append((b"x-catgo-tab-id", tab_id.encode("latin-1")))
    return Request({"type": "http", "method": "POST", "headers": headers})


def test_client_direct_precheck_shares_tab_ledger_and_classifier():
    tab_id = "terminal-client-direct"
    session_key = f"http:tab:{tab_id}"
    enf.drop_session(session_key)
    enf.postmark(
        "catgo_analyze", {"action": "rdf"}, ok=True, session_key=session_key,
    )
    try:
        blocked = tb.verification_precheck(
            {"action": "run", "command": "env FOO=1 bash -lc 'sbatch job.sh'"},
            _request(tab_id),
        )
        assert blocked["guarded"] is True
        assert blocked["decision"] == enf.FORBIDDEN
        assert blocked["session_key"] == session_key

        diagnostic = tb.verification_precheck(
            {"action": "run", "command": "sacct -j 123"}, _request(tab_id),
        )
        assert diagnostic["guarded"] is False
        assert diagnostic["decision"] == enf.ALLOW
    finally:
        tb._verification_input_buffers.pop(session_key, None)
        enf.drop_session(session_key)


def test_client_direct_precheck_blocks_split_send_keys_submit_on_enter():
    tab_id = "terminal-client-direct-split"
    session_key = f"http:tab:{tab_id}"
    enf.drop_session(session_key)
    enf.postmark(
        "catgo_analyze", {"action": "rdf"}, ok=True, session_key=session_key,
    )
    try:
        typed = tb.verification_precheck(
            {"action": "send_keys", "keys": "sba"}, _request(tab_id),
        )
        assert typed["decision"] == enf.ALLOW
        assert typed["guarded"] is False

        submitted = tb.verification_precheck(
            {"action": "send_keys", "keys": "tch job.sh<enter>"},
            _request(tab_id),
        )
        assert submitted["decision"] == enf.FORBIDDEN
        assert submitted["guarded"] is True
    finally:
        tb._verification_input_buffers.pop(session_key, None)
        enf.drop_session(session_key)


def test_client_direct_precheck_rejects_non_terminal_actions():
    with pytest.raises(HTTPException) as exc:
        tb.verification_precheck({"action": "read"}, _request())
    assert exc.value.status_code == 400
