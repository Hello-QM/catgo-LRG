"""Terminal round-trip bridge: lets a backend MCP tool drive the renderer's
visible terminal. Mirrors the catrender request/result pattern in view_capture.py
— the backend enqueues a request + awaits a Future; the renderer polls
/terminal/pending, executes via its terminal-registry, and POSTs /terminal/result.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

TERMINAL_TIMEOUT = 120.0  # seconds a `run` waits for the renderer

_pending_terminal: dict[str, asyncio.Future] = {}

router = APIRouter(prefix="/terminal", tags=["terminal-bridge"])


async def request_terminal(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Enqueue a terminal request and await the renderer's result.

    ``action`` in {read, run, send_keys, interrupt}. Returns the renderer's
    result dict, or ``{'error': ...}`` on timeout (no renderer responded).
    """
    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _pending_terminal[request_id] = fut
    fut._params = {"request_id": request_id, "action": action, **payload}  # type: ignore[attr-defined]
    try:
        return await asyncio.wait_for(fut, timeout=TERMINAL_TIMEOUT)
    except asyncio.TimeoutError:
        return {"error": "No terminal responded (is a CatGo window open?) — timed out."}
    finally:
        _pending_terminal.pop(request_id, None)


@router.get("/pending")
def list_pending() -> dict[str, Any]:
    return {
        "pending": [
            getattr(f, "_params", {})
            for f in _pending_terminal.values()
            if not f.done()
        ]
    }


@router.post("/result")
def post_result(payload: dict[str, Any]) -> dict[str, str]:
    fut = _pending_terminal.get(payload.get("request_id", ""))
    if fut is None:
        raise HTTPException(status_code=404, detail="No pending terminal request")
    if fut.done():
        raise HTTPException(status_code=409, detail="Already fulfilled")
    fut.set_result(payload)
    return {"status": "ok"}
