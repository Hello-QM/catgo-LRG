# server/catgo/workflow/engine/broadcast.py
"""WebSocket listener registry for real-time task updates.

Pattern: asyncio.Queue per listener. Non-blocking put -- drops if slow.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

_listeners: dict[str, list[asyncio.Queue]] = defaultdict(list)


def add_listener(workflow_id: str, maxsize: int = 128) -> asyncio.Queue:
    """Register a listener queue. Returns the queue to read from."""
    q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
    _listeners[workflow_id].append(q)
    return q


def remove_listener(workflow_id: str, q: asyncio.Queue) -> None:
    """Unregister a listener."""
    lst = _listeners.get(workflow_id, [])
    if q in lst:
        lst.remove(q)
    if not lst:
        _listeners.pop(workflow_id, None)


def get_listeners(workflow_id: str) -> list[asyncio.Queue]:
    """Get all listeners for a workflow (for testing)."""
    return _listeners.get(workflow_id, [])


async def broadcast(workflow_id: str, message: dict[str, Any]) -> None:
    """Send message to all listeners. Non-blocking -- drops if full."""
    for q in _listeners.get(workflow_id, []):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            pass
