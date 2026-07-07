"""PTY WebSocket endpoint: local shell or remote SSH terminal.

Provides a browser-accessible terminal. Supports two modes:
- Local: Python pty module for a local shell
- Remote: Reuses an existing HPC SSH connection for a remote shell

Protocol (JSON over WebSocket):
  Client → Server:
    {action: "open", cols: 80, rows: 24}                        # local PTY
    {action: "open", cols: 80, rows: 24, session_id: "uuid"}    # remote PTY
    {action: "input", data: "ls\r"}
    {action: "resize", cols: 120, rows: 40}
    {action: "close"}

  Server → Client:
    {type: "opened", id: N}
    {type: "output", data: "<base64-encoded bytes>"}
    {type: "closed"}
    {type: "error", message: "..."}
"""

import asyncio
import base64
import logging
import os
import platform
import struct
from typing import Optional

_IS_WINDOWS = platform.system() == "Windows"

# Unix-only modules for local PTY support
if not _IS_WINDOWS:
    import fcntl
    import pty
    import signal
    import termios

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pty", tags=["pty"])

_next_id = 0


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    """Set terminal window size on a file descriptor (Unix only)."""
    if _IS_WINDOWS:
        return
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


# ====== Local PTY Session ======


async def _run_local_pty(
    ws: WebSocket, pty_id: int, cols: int, rows: int
) -> None:
    """Run a local PTY session (fork + exec shell). Unix only."""
    if _IS_WINDOWS:
        await ws.send_json({"type": "error", "message": "Local PTY is not supported on Windows"})
        return
    shell = os.environ.get("SHELL", "/bin/bash")
    child_pid, master_fd = pty.fork()

    if child_pid == 0:
        # Child process: exec the shell
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.execlp(shell, shell)
        # Never reaches here

    # Parent process
    read_task: Optional[asyncio.Task] = None
    try:
        _set_winsize(master_fd, rows, cols)

        # Make master_fd non-blocking for async reads
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        await ws.send_json({"type": "opened", "id": pty_id})
        logger.info(f"[PTY {pty_id}] Local session opened (shell={shell}, {cols}x{rows})")

        # Background task: read PTY output → WebSocket
        async def read_loop() -> None:
            loop = asyncio.get_event_loop()
            try:
                while True:
                    fut: asyncio.Future[None] = loop.create_future()
                    loop.add_reader(master_fd, fut.set_result, None)
                    try:
                        await fut
                    finally:
                        loop.remove_reader(master_fd)

                    try:
                        output = os.read(master_fd, 8192)
                    except OSError:
                        break
                    if not output:
                        break
                    encoded = base64.b64encode(output).decode("ascii")
                    await ws.send_json({"type": "output", "data": encoded})
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.debug(f"[PTY {pty_id}] Read loop error: {exc}")

        read_task = asyncio.create_task(read_loop())

        # Main loop: receive input/resize/close from client
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")

            if action == "input":
                raw = msg.get("data", "")
                os.write(master_fd, raw.encode("utf-8"))
            elif action == "resize":
                new_cols = msg.get("cols", cols)
                new_rows = msg.get("rows", rows)
                _set_winsize(master_fd, new_rows, new_cols)
            elif action == "close":
                break

    finally:
        if read_task and not read_task.done():
            read_task.cancel()
            try:
                await read_task
            except asyncio.CancelledError:
                pass
        try:
            os.close(master_fd)
        except OSError:
            pass
        if child_pid > 0:
            try:
                os.kill(child_pid, signal.SIGKILL)
                os.waitpid(child_pid, 0)
            except (OSError, ChildProcessError):
                pass


# ====== Remote SSH PTY Session ======


async def _run_remote_pty(
    ws: WebSocket, pty_id: int, cols: int, rows: int, hpc_session_id: str
) -> None:
    """Run a remote PTY session over an existing HPC SSH connection."""
    from catgo.utils.hpc_client import pool

    hpc = pool.get_connection(hpc_session_id)
    if not hpc:
        await ws.send_json({"type": "error", "message": "HPC session not found or expired"})
        return

    if hpc.is_subprocess_mode:
        await _run_remote_subprocess_pty(ws, pty_id, cols, rows, hpc)
    else:
        await _run_remote_asyncssh_pty(ws, pty_id, cols, rows, hpc)


# --- asyncssh PTY ops, each awaited on the connection's OWNER loop ---
# asyncssh's SSHClientProcess and its stdin/stdout streams are bound to the loop
# that created the connection (see hpc_connection.py rule #4). These tiny
# coroutines let the WebSocket handler — which may run on a different loop —
# drive the process via ``hpc.run_on_owner(...)`` instead of mutating
# loop-private channel state directly (the cross-loop misuse that corrupts the
# session under the heavy, interleaved I/O a full-screen program produces).

async def _pty_write(process, data: bytes) -> None:
    process.stdin.write(data)


async def _pty_resize(process, cols: int, rows: int) -> None:
    process.change_terminal_size(cols, rows)


async def _pty_close(process) -> None:
    try:
        process.stdin.write_eof()
    except Exception:
        pass
    try:
        process.close()
    except Exception:
        pass


async def _run_remote_asyncssh_pty(
    ws: WebSocket, pty_id: int, cols: int, rows: int, hpc
) -> None:
    """Remote PTY via asyncssh interactive session.

    Two invariants make full-screen programs (vi/vim/less/top/tmux) survive:

    1. BINARY transport (``encoding=None``). A PTY carries arbitrary terminal
       bytes — escape sequences, box-drawing, non-UTF-8 payloads. In asyncssh's
       default UTF-8 text mode ``stdout.read()`` raises ``UnicodeDecodeError`` on
       the first non-UTF-8 byte; the read loop treats that as channel death and
       tears down the WebSocket — which is exactly why ``cat`` of a UTF-8 file
       worked while ``vi`` dropped the connection. Binary mode base64-forwards
       raw bytes untouched (matching the local/subprocess ``os.read`` paths).

    2. OWNER-LOOP affinity. The asyncssh process and its streams belong to the
       connection's owner loop (hpc_connection.py rule #4). create / read /
       write / resize / close are dispatched through ``hpc.run_on_owner`` /
       ``hpc.stream_on_owner`` so loop-private channel state is never mutated
       from a foreign loop. Both are a zero-cost passthrough when the handler is
       already on the owner loop, so the common single-loop path is unchanged.
    """
    read_task: Optional[asyncio.Task] = None
    monitor_task: Optional[asyncio.Task] = None
    process = None
    channel_closed = asyncio.Event()

    try:
        # Create the interactive PTY process on the owner loop, in binary mode.
        process = await hpc.run_on_owner(
            lambda: hpc.conn.create_process(
                term_type="xterm-256color",
                term_size=(cols, rows),
                encoding=None,
            )
        )

        await ws.send_json({"type": "opened", "id": pty_id})
        logger.info(
            f"[PTY {pty_id}] Remote asyncssh session opened "
            f"({hpc.username}@{hpc.host}, {cols}x{rows}, binary)"
        )

        # Read remote stdout on the owner loop; stream_on_owner bridges the raw
        # bytes back to this (FastAPI) loop, then base64 → WebSocket.
        async def stdout_chunks():
            while True:
                data = await process.stdout.read(8192)
                if not data:
                    break
                if isinstance(data, str):  # defensive: only if a text stream slips through
                    data = data.encode("utf-8", "surrogatepass")
                yield data

        async def read_loop() -> None:
            try:
                async for data in hpc.stream_on_owner(stdout_chunks):
                    encoded = base64.b64encode(data).decode("ascii")
                    await ws.send_json({"type": "output", "data": encoded})
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.debug(f"[PTY {pty_id}] Remote read error: {exc}")
            finally:
                channel_closed.set()

        # Monitor: close WebSocket when SSH channel dies, unblocking the main loop
        async def channel_monitor() -> None:
            await channel_closed.wait()
            logger.info(f"[PTY {pty_id}] SSH channel closed, notifying client")
            try:
                await ws.send_json({"type": "closed"})
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass

        read_task = asyncio.create_task(read_loop())
        monitor_task = asyncio.create_task(channel_monitor())

        # Main loop: receive input/resize/close from client
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")

            if action == "input":
                raw = msg.get("data", "")
                data = raw.encode("utf-8", "surrogatepass") if isinstance(raw, str) else bytes(raw)
                try:
                    await hpc.run_on_owner(lambda: _pty_write(process, data))
                except Exception as exc:
                    logger.debug(f"[PTY {pty_id}] Write error (channel closed?): {exc}")
                    break
            elif action == "resize":
                new_cols = msg.get("cols", cols)
                new_rows = msg.get("rows", rows)
                try:
                    await hpc.run_on_owner(lambda: _pty_resize(process, new_cols, new_rows))
                except Exception:
                    pass
            elif action == "close":
                break
            elif action == "ping":
                try:
                    await ws.send_json({"type": "pong"})
                except Exception:
                    break

    finally:
        for task in [read_task, monitor_task]:
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        if process is not None:
            try:
                await hpc.run_on_owner(lambda: _pty_close(process))
            except Exception:
                pass


async def _run_remote_subprocess_pty(
    ws: WebSocket, pty_id: int, cols: int, rows: int, hpc
) -> None:
    """Remote PTY via ssh subprocess with PTY allocation (ControlMaster mode). Unix only."""
    if _IS_WINDOWS:
        await ws.send_json({"type": "error", "message": "Subprocess PTY mode is not supported on Windows. Use asyncssh mode instead."})
        return
    read_task: Optional[asyncio.Task] = None
    master_fd: Optional[int] = None
    child_pid: Optional[int] = None

    try:
        alias = hpc.ssh_alias or f"{hpc.username}@{hpc.host}"

        # Fork a PTY and exec ssh with -t for forced PTY allocation
        child_pid, master_fd = pty.fork()

        if child_pid == 0:
            # Child process
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLORTERM"] = "truecolor"
            os.execlp("ssh", "ssh", "-t", alias)
            # Never reaches here

        # Parent process
        _set_winsize(master_fd, rows, cols)
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        await ws.send_json({"type": "opened", "id": pty_id})
        logger.info(
            f"[PTY {pty_id}] Remote subprocess session opened "
            f"(alias={alias}, {cols}x{rows})"
        )

        # Background task: read PTY output → WebSocket
        async def read_loop() -> None:
            loop = asyncio.get_event_loop()
            try:
                while True:
                    fut: asyncio.Future[None] = loop.create_future()
                    loop.add_reader(master_fd, fut.set_result, None)
                    try:
                        await fut
                    finally:
                        loop.remove_reader(master_fd)

                    try:
                        output = os.read(master_fd, 8192)
                    except OSError:
                        break
                    if not output:
                        break
                    encoded = base64.b64encode(output).decode("ascii")
                    await ws.send_json({"type": "output", "data": encoded})
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.debug(f"[PTY {pty_id}] Remote subprocess read error: {exc}")

        read_task = asyncio.create_task(read_loop())

        # Main loop: receive input/resize/close from client
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")

            if action == "input":
                raw = msg.get("data", "")
                os.write(master_fd, raw.encode("utf-8"))
            elif action == "resize":
                new_cols = msg.get("cols", cols)
                new_rows = msg.get("rows", rows)
                _set_winsize(master_fd, new_rows, new_cols)
            elif action == "close":
                break

    finally:
        if read_task and not read_task.done():
            read_task.cancel()
            try:
                await read_task
            except asyncio.CancelledError:
                pass
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        if child_pid and child_pid > 0:
            try:
                os.kill(child_pid, signal.SIGKILL)
                os.waitpid(child_pid, 0)
            except (OSError, ChildProcessError):
                pass


# ====== WebSocket Endpoint ======


@router.websocket("/session")
async def ws_pty(ws: WebSocket) -> None:
    """WebSocket endpoint for an interactive PTY shell (local or remote)."""
    await ws.accept()

    try:
        # Wait for "open" message
        data = await ws.receive_json()
        if data.get("action") != "open":
            await ws.send_json({"type": "error", "message": "Expected action: open"})
            return

        cols = data.get("cols", 80)
        rows = data.get("rows", 24)
        hpc_session_id = data.get("session_id")  # None = local, string = remote

        global _next_id
        _next_id += 1
        pty_id = _next_id

        if hpc_session_id:
            await _run_remote_pty(ws, pty_id, cols, rows, hpc_session_id)
        else:
            await _run_local_pty(ws, pty_id, cols, rows)

    except WebSocketDisconnect:
        logger.info("[PTY] WebSocket client disconnected")
    except Exception as exc:
        logger.error(f"[PTY] Error: {exc}")
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        try:
            await ws.send_json({"type": "closed"})
        except Exception:
            pass
        logger.info("[PTY] Session closed")
