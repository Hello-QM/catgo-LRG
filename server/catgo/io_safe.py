"""Broken-pipe-safe stdout/stderr wrappers.

The desktop app launches this backend as a *sidecar* with stdout/stderr
connected to pipes the parent owns. If that parent dies but the backend keeps
running (e.g. the backend is reused across an app restart), the pipe's read end
closes and any subsequent write raises ``BrokenPipeError: [Errno 32] Broken
pipe``.

A bare ``print()`` in a request handler would then propagate that error all the
way out as an HTTP 500 — which is exactly how the workflow ``/run`` endpoint
started failing with a generic "Load failed" in the WebView. Wrapping the
streams so writes/flushes swallow the error makes a dead log pipe unable to
break request handling.
"""

from __future__ import annotations

import sys
from typing import Any, TextIO


class BrokenPipeSafeStream:
    """Text stream proxy whose ``write``/``flush`` never raise on a dead pipe.

    All other attribute access (``isatty``, ``fileno``, ``encoding`` …) is
    delegated to the wrapped stream so the proxy is a drop-in replacement for
    ``sys.stdout`` / ``sys.stderr`` (uvicorn's ColourizedFormatter calls
    ``isatty()``, for instance).
    """

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream

    def write(self, data: str) -> int:
        try:
            return self._stream.write(data)
        except (BrokenPipeError, OSError, ValueError):
            # ValueError: write to an already-closed stream.
            return len(data)

    def flush(self) -> None:
        try:
            self._stream.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def install_broken_pipe_guard() -> None:
    """Wrap ``sys.stdout``/``sys.stderr`` so writes survive a broken log pipe.

    Idempotent: a stream that is already wrapped (or ``None``) is left alone.
    Call this as early as possible — before ``logging.basicConfig`` binds a
    handler to ``sys.stderr`` — so the configured logger inherits the safe
    stream too.
    """
    for _name in ("stdout", "stderr"):
        stream = getattr(sys, _name, None)
        if stream is None or isinstance(stream, BrokenPipeSafeStream):
            continue
        setattr(sys, _name, BrokenPipeSafeStream(stream))
