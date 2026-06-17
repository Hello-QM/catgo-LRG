"""Round-trip tests for the terminal bridge (backend <-> renderer)."""
import asyncio

import pytest
from fastapi import HTTPException

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
