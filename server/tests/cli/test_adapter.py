import pytest
from fastapi import HTTPException
from pydantic import BaseModel
from catgo.cli.adapter import call_route, OpError


class _Req(BaseModel):
    x: int


def _sync_route(req: _Req):
    if req.x < 0:
        raise HTTPException(status_code=400, detail="x must be >= 0")
    return {"doubled": req.x * 2}


async def _async_route(req: _Req):
    return {"doubled": req.x * 2}


def test_call_sync_route():
    assert call_route(_sync_route, _Req, x=3) == {"doubled": 6}


def test_call_async_route():
    assert call_route(_async_route, _Req, x=5) == {"doubled": 10}


def test_httpexception_becomes_operror():
    with pytest.raises(OpError) as ei:
        call_route(_sync_route, _Req, x=-1)
    assert "x must be >= 0" in str(ei.value)


def test_validation_error_becomes_operror():
    with pytest.raises(OpError) as ei:
        call_route(_sync_route, _Req, x="not-an-int")
    assert "invalid parameters" in str(ei.value)


def test_require_structure():
    from catgo.cli.adapter import require_structure

    class _S:  # minimal session stand-in
        structure = None

    with pytest.raises(OpError):
        require_structure(_S())
    s = _S(); s.structure = "X"
    assert require_structure(s) == "X"
