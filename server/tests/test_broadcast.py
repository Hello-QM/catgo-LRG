# server/tests/test_broadcast.py
"""Tests for WebSocket broadcast registry."""
import asyncio
import pytest

from catgo.workflow.engine.broadcast import (
    add_listener, remove_listener, broadcast, get_listeners,
)


@pytest.fixture(autouse=True)
def _clear_listeners():
    """Reset global listeners between tests."""
    from catgo.workflow.engine import broadcast as mod
    mod._listeners.clear()
    yield
    mod._listeners.clear()


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_add_and_remove_listener():
    q = add_listener("wf-1")
    assert len(get_listeners("wf-1")) == 1
    remove_listener("wf-1", q)
    assert len(get_listeners("wf-1")) == 0


def test_broadcast_delivers_message():
    q = add_listener("wf-1")
    _run(broadcast("wf-1", {"type": "task_status", "task_id": "t1", "status": "RUNNING"}))
    msg = q.get_nowait()
    assert msg["task_id"] == "t1"
    assert msg["status"] == "RUNNING"


def test_broadcast_ignores_other_workflows():
    q = add_listener("wf-1")
    _run(broadcast("wf-2", {"type": "task_status", "task_id": "t1", "status": "RUNNING"}))
    assert q.empty()


def test_broadcast_drops_when_full():
    q = add_listener("wf-1")
    for i in range(200):
        _run(broadcast("wf-1", {"type": "test", "i": i}))
    # Should not raise — drops silently when full
    _run(broadcast("wf-1", {"type": "overflow"}))
