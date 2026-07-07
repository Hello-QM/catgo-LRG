"""Remote asyncssh PTY must be binary-safe and owner-loop-bound.

Regression: full-screen programs (vi/vim/less/top/tmux) dropped the SSH
connection *immediately*, while `cat` of a UTF-8 file worked. Root cause: the
asyncssh session was opened in asyncssh's default UTF-8 **text** mode, so the
first non-UTF-8 byte in a terminal redraw/escape stream raised
``UnicodeDecodeError`` inside ``process.stdout.read()``; the read loop treats any
read exception as channel death and closes the WebSocket. The fix opens the PTY
in **binary** mode (``encoding=None``) and drives every process op through the
connection's owner loop (``run_on_owner`` / ``stream_on_owner``).

pytest-asyncio is not installed here; coroutines are driven via ``asyncio.run``.
The fake stdout yields its chunks and then *blocks* (never EOFs), so the handler
is torn down deterministically by the client's ``close`` — no reliance on
background-task/event timing (which ``nest_asyncio`` in this env perturbs).
"""

import asyncio
import base64

from catgo.routers.pty import _run_remote_asyncssh_pty

# A terminal redraw burst that is NOT valid UTF-8: 0xff/0xfe/0x80/0xc0/0xc1 are
# illegal UTF-8 lead/continuation bytes. asyncssh text mode raises on these.
NON_UTF8 = b"\x1b[2J\x1b[H\xff\xfe\x80\x81 box \xc0\xc1 \xe2\x94\x80"


class FakeStream:
    """Yields the given chunks, then blocks until cancelled (a live PTY never
    spontaneously EOFs mid-session; the session ends via the client `close`)."""

    def __init__(self, chunks):
        self._chunks = list(chunks)
        self._blocked = asyncio.Event()  # never set

    async def read(self, _n):
        if self._chunks:
            return self._chunks.pop(0)
        await self._blocked.wait()  # block until the read task is cancelled
        return b""


class FakeStdin:
    def __init__(self):
        self.writes = []
        self.eof = False

    def write(self, data):
        self.writes.append(data)

    def write_eof(self):
        self.eof = True


class FakeProcess:
    def __init__(self, out_chunks):
        self.stdout = FakeStream(out_chunks)
        self.stdin = FakeStdin()
        self.resizes = []
        self.closed = False

    def change_terminal_size(self, cols, rows):
        self.resizes.append((cols, rows))

    def close(self):
        self.closed = True


class FakeConn:
    def __init__(self, process):
        self._process = process
        self.create_kwargs = None

    async def create_process(self, **kwargs):
        self.create_kwargs = kwargs
        return self._process


class FakeHPC:
    """Minimal HPCConnection stand-in with owner-loop passthroughs."""

    username = "user"
    host = "login.example.edu"

    def __init__(self, process):
        self.conn = FakeConn(process)
        self.run_on_owner_calls = 0

    async def run_on_owner(self, coro_factory):
        self.run_on_owner_calls += 1
        return await coro_factory()

    async def stream_on_owner(self, stream_factory):
        async for chunk in stream_factory():
            yield chunk


class FakeWS:
    def __init__(self, script):
        self._script = list(script)
        self.sent = []
        self.closed = False

    async def send_json(self, obj):
        self.sent.append(obj)

    async def receive_json(self):
        # A real yield so the background read task gets to forward any pending
        # output before the client advances the script.
        await asyncio.sleep(0.05)
        if self._script:
            return self._script.pop(0)
        return {"action": "close"}  # always terminate the main loop

    async def close(self):
        self.closed = True


def _run(out_chunks, script):
    async def driver():
        proc = FakeProcess(out_chunks)
        hpc = FakeHPC(proc)
        ws = FakeWS(script)
        await asyncio.wait_for(
            _run_remote_asyncssh_pty(ws, pty_id=1, cols=80, rows=24, hpc=hpc),
            timeout=10,
        )
        return proc, hpc, ws

    return asyncio.run(driver())


def test_non_utf8_output_survives_and_forwards_verbatim():
    proc, hpc, ws = _run([NON_UTF8], script=[{"action": "close"}])
    outputs = [m for m in ws.sent if m.get("type") == "output"]
    assert outputs, "no output forwarded — the read loop died (text-mode regression)"
    decoded = b"".join(base64.b64decode(m["data"]) for m in outputs)
    assert decoded == NON_UTF8, "binary terminal bytes were mangled or dropped"


def test_process_opened_in_binary_mode():
    proc, hpc, ws = _run([], script=[{"action": "close"}])
    assert hpc.conn.create_kwargs is not None, "create_process was never called"
    assert hpc.conn.create_kwargs.get("encoding", "MISSING") is None, (
        "PTY must be opened with encoding=None (binary); text mode breaks "
        "vi/top/tmux on the first non-UTF-8 byte"
    )


def test_input_is_written_as_bytes_on_owner_loop():
    proc, hpc, ws = _run(
        [], script=[{"action": "input", "data": "iHello"}, {"action": "close"}]
    )
    assert proc.stdin.writes == [b"iHello"], (
        f"terminal input must reach stdin as bytes, got {proc.stdin.writes!r}"
    )
    # create_process + the write both go through run_on_owner.
    assert hpc.run_on_owner_calls >= 2


def test_resize_is_routed_to_the_process():
    proc, hpc, ws = _run(
        [], script=[{"action": "resize", "cols": 120, "rows": 40}, {"action": "close"}]
    )
    assert (120, 40) in proc.resizes, f"resize not applied, got {proc.resizes!r}"


def test_process_closed_via_owner_loop_on_exit():
    proc, hpc, ws = _run([], script=[{"action": "close"}])
    assert proc.stdin.eof is True and proc.closed is True, "PTY not cleaned up on exit"
