"""BrokenPipeSafeStream must not let a dead log pipe break the process.

Regression: the workflow `/run` endpoint 500'd with BrokenPipeError because a
bare print() wrote to a stdout pipe whose reader (a dead parent app) had gone
away. The wrapper swallows that error so writes/flushes are always safe.
"""

import io
import sys

import pytest

from catgo.io_safe import BrokenPipeSafeStream, install_broken_pipe_guard


class _DeadPipe(io.StringIO):
    """A stream whose write/flush behave like a pipe with a closed reader."""

    def write(self, _data):  # type: ignore[override]
        raise BrokenPipeError(32, "Broken pipe")

    def flush(self):  # type: ignore[override]
        raise BrokenPipeError(32, "Broken pipe")


def test_write_swallows_broken_pipe():
    stream = BrokenPipeSafeStream(_DeadPipe())
    # Must not raise, and reports the full length as written.
    assert stream.write("hello") == len("hello")


def test_flush_swallows_broken_pipe():
    stream = BrokenPipeSafeStream(_DeadPipe())
    stream.flush()  # must not raise


def test_print_to_wrapped_dead_pipe_does_not_raise():
    stream = BrokenPipeSafeStream(_DeadPipe())
    # print() calls write() then flush() — the original 500 trigger.
    print("debug line", file=stream, flush=True)


def test_write_passes_through_when_healthy():
    backing = io.StringIO()
    stream = BrokenPipeSafeStream(backing)
    stream.write("ok")
    stream.flush()
    assert backing.getvalue() == "ok"


def test_delegates_other_attributes():
    backing = io.StringIO()
    stream = BrokenPipeSafeStream(backing)
    # isatty is what uvicorn's ColourizedFormatter probes; must delegate.
    assert stream.isatty() is False


def test_install_guard_is_idempotent():
    orig_out, orig_err = sys.stdout, sys.stderr
    try:
        install_broken_pipe_guard()
        wrapped_out = sys.stdout
        assert isinstance(sys.stdout, BrokenPipeSafeStream)
        assert isinstance(sys.stderr, BrokenPipeSafeStream)
        # Second call must not double-wrap.
        install_broken_pipe_guard()
        assert sys.stdout is wrapped_out
    finally:
        sys.stdout, sys.stderr = orig_out, orig_err


def test_install_guard_skips_none_stream():
    orig_out = sys.stdout
    try:
        sys.stdout = None  # type: ignore[assignment]
        install_broken_pipe_guard()
        assert sys.stdout is None  # left alone, not wrapped
    finally:
        sys.stdout = orig_out
