"""Terminal round-trip bridge: lets a backend MCP tool drive the renderer's
visible terminal. Mirrors the catrender request/result pattern in view_capture.py
— the backend enqueues a request + awaits a Future; the renderer polls
/terminal/pending, executes via its terminal-registry, and POSTs /terminal/result.
"""
from __future__ import annotations

import asyncio
import re
import threading
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request

TERMINAL_TIMEOUT = 120.0  # seconds a `run` waits for the renderer

_pending_terminal: dict[str, asyncio.Future] = {}
_verification_input_buffers: dict[str, str] = {}
_verification_input_lock = threading.Lock()
_MAX_VERIFICATION_INPUT = 65_536
_CTRL_C_RE = re.compile(r"<c-c>", re.IGNORECASE)

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


@router.post("/verification-precheck")
def verification_precheck(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Apply the MCP verification ledger to a client-direct terminal action.

    Browser-side CatBot providers execute ``run_command`` / ``send_keys``
    directly against the visible PTY, so they do not naturally pass through
    MCP's :func:`run_with_verification`.  This endpoint deliberately delegates
    command classification and ledger policy to the same Python implementation
    instead of maintaining a second shell parser in TypeScript.

    ``X-CatGo-Tab-Id`` is the same identity the SDK adapters attach to MCP HTTP
    requests.  Consequently, switching a tab between an SDK provider and a
    client-direct provider cannot shed that tab's pending/failed results.
    """
    action = str(payload.get("action") or "").strip().lower()
    if action not in {"run", "send_keys"}:
        raise HTTPException(status_code=400, detail="action must be run|send_keys")

    tab_id = str(request.headers.get("x-catgo-tab-id") or "").strip()
    if not tab_id:
        tab_id = str(payload.get("panel_id") or "").strip()
    session_key = f"http:tab:{tab_id}" if tab_id else "default"

    from catgo.mcp_tools import verify_enforcement as enforcement

    args: dict[str, Any] = {"action": action}
    if action == "run":
        args["command"] = str(payload.get("command") or "")
        guarded = enforcement._terminal_starts_scheduler_job(args)
        decision, reason = enforcement.precheck(
            "catgo_terminal", args, session_key=session_key,
        )
    else:
        keys = str(payload.get("keys") or "")
        # A command can be typed in one send_keys call and executed by a later
        # bare <enter>.  Keep the unsubmitted line per tab so the second call is
        # classified by the exact same scheduler parser as an atomic request.
        # Only ALLOW commits the speculative buffer: PROMPT/FORBIDDEN never
        # write bytes to the PTY, so they must not advance this mirror either.
        with _verification_input_lock:
            pending = _verification_input_buffers.get(session_key, "")
            ctrl_c_parts = _CTRL_C_RE.split(keys)
            if len(ctrl_c_parts) > 1:
                pending = ""
                keys = ctrl_c_parts[-1]
            combined = pending + keys
            if len(combined) > _MAX_VERIFICATION_INPUT:
                raise HTTPException(
                    status_code=413,
                    detail="send_keys verification buffer exceeds the safe limit",
                )
            args["keys"] = combined
            guarded = enforcement._terminal_starts_scheduler_job(args)
            decision, reason = enforcement.precheck(
                "catgo_terminal", args, session_key=session_key,
            )
            if decision == enforcement.ALLOW:
                entered = enforcement._SEND_KEYS_ENTER_RE.split(combined)
                tail = entered[-1] if len(entered) > 1 else combined
                if tail:
                    _verification_input_buffers[session_key] = tail
                else:
                    _verification_input_buffers.pop(session_key, None)
    return {
        "decision": decision,
        "reason": reason,
        "guarded": guarded,
        "session_key": session_key,
    }
