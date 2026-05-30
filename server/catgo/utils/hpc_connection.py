"""HPCConnection — a pooled SSH connection with metadata and lifecycle management.

Loop ownership rules for HPCConnection:

  1. Every real asyncssh.SSHClientConnection has exactly one owner loop,
     recorded in `_owner_loop` at creation (see connection_pool.connect /
     connect_ssh_config).
  2. Code on the owner loop may call `await hpc.conn.*` directly.
  3. Code on any other loop MUST go through `hpc.run_on_owner(...)`.
  4. Objects derived from the connection (SFTP clients, SSHClientProcess
     for PTY, streaming pipes) inherit the owner loop. Do NOT pass these
     objects across loop boundaries. Open them, use them, close them on
     the owner loop in a single `run_on_owner` scope.
  5. LocalFileConnection is loop-agnostic; `_owner_loop` is None and
     `run_on_owner` is a pure passthrough.
"""

import asyncio
import logging
import socket
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, TypeVar

import asyncssh

from catgo.models.hpc import (
    HPCConnectionConfig,
    HPCOverview,
    JobStatus,
    JobSummary,
    SchedulerType,
)
from catgo.utils.scheduler_base import SchedulerInterface, _get_schedulers
from catgo.utils.ssh_file_ops import SSHFileOpsMixin

logger = logging.getLogger(__name__)

T = TypeVar("T")

# One-time log when we observe an unexpected loop hop, so we can spot
# misrouted code paths without flooding logs on the hot path.
_HOP_LOG_ONCE: set[str] = set()


async def _run_factory(coro_factory: Callable[[], Awaitable[T]]) -> T:
    """Call the factory on the current loop and await its coroutine.

    Used by `run_on_owner` to ensure the coroutine is created on the
    owner loop (not on the caller thread's loop), because asyncssh's
    loop-bound state is allocated when `conn.run(...)` is invoked, not
    when it's awaited.
    """
    return await coro_factory()


@dataclass
class HPCConnection(SSHFileOpsMixin):
    """A pooled SSH connection with metadata."""

    session_id: str
    conn: Any  # asyncssh.SSHClientConnection or SubprocessSSHRunner
    jump_conn: Optional[asyncssh.SSHClientConnection] = None
    sftp: Optional[asyncssh.SFTPClient] = None
    config: Optional[HPCConnectionConfig] = None
    scheduler_type: SchedulerType = SchedulerType.SLURM
    username: str = ""
    host: str = ""
    ssh_alias: Optional[str] = None
    connected_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)
    # CatGO remote launch state
    catgo_job_id: Optional[str] = None
    catgo_tunnel_listener: Any = None  # asyncssh listener
    catgo_tunnel_process: Optional[asyncio.subprocess.Process] = None
    catgo_tunnel_local_port: Optional[int] = None
    catgo_tunnel_node: Optional[str] = None
    _sftp_failed: bool = False
    _alive: bool = True  # Set to False by connection_lost callback
    # Loop that owns this connection. asyncssh Futures/transports are
    # loop-bound, so every await on `conn` / `scheduler` / SFTP must run
    # on this loop. See module docstring and run_on_owner().
    _owner_loop: Optional[asyncio.AbstractEventLoop] = None

    async def run_on_owner(self, coro_factory: Callable[[], Awaitable[T]]) -> T:
        """Run a coroutine on the loop that owns this connection.

        `coro_factory` is a zero-arg callable returning a fresh coroutine.
        Same-loop calls are a zero-cost passthrough (one `is`-check).
        Cross-loop calls dispatch via `asyncio.run_coroutine_threadsafe`
        so the coroutine is constructed and awaited on the owner loop.

        This is the single authorized path for any engine-thread code
        that wants to touch `self.conn`, `self.scheduler`, an SFTP client
        derived from this connection, or any helper that internally does
        `await self.conn.*`. See module docstring for the full rules.
        """
        current = asyncio.get_running_loop()
        owner = self._owner_loop
        # Fast path: no owner (LocalFileConnection) or already on owner loop.
        if owner is None or owner is current:
            return await coro_factory()

        # Guard against a closed owner loop — would otherwise hang forever.
        if owner.is_closed():
            raise RuntimeError(
                f"HPCConnection {self.session_id}: owner loop is closed; "
                f"connection must be re-established."
            )

        # One-time log per session to confirm the hop is happening as designed.
        key = f"{self.session_id}:{id(current)}->{id(owner)}"
        if key not in _HOP_LOG_ONCE:
            _HOP_LOG_ONCE.add(key)
            logger.info(
                "HPCConnection %s: run_on_owner hopping loops (caller=%s -> owner=%s)",
                self.session_id, id(current), id(owner),
            )

        fut = asyncio.run_coroutine_threadsafe(_run_factory(coro_factory), owner)
        return await asyncio.wrap_future(fut)

    async def stream_on_owner(self, stream_factory: Callable[[], AsyncIterator[bytes]]) -> AsyncIterator[bytes]:
        """Yield an async byte stream from the connection owner loop.

        Streaming responses keep iterating on FastAPI's loop, but AsyncSSH
        streams must be opened and read on their owner loop. This bridges the
        two loops with a small queue while preserving backpressure.
        """
        current = asyncio.get_running_loop()
        owner = self._owner_loop
        if owner is None or owner is current:
            async for chunk in stream_factory():
                yield chunk
            return

        if owner.is_closed():
            raise RuntimeError(
                f"HPCConnection {self.session_id}: owner loop is closed; "
                f"connection must be re-established."
            )

        queue: asyncio.Queue[bytes | BaseException | object] = asyncio.Queue(maxsize=8)
        sentinel = object()

        async def put_on_caller(item: bytes | BaseException | object) -> None:
            fut = asyncio.run_coroutine_threadsafe(queue.put(item), current)
            await asyncio.wrap_future(fut)

        async def pump() -> None:
            try:
                async for chunk in stream_factory():
                    await put_on_caller(chunk)
            except BaseException as exc:
                await put_on_caller(exc)
            finally:
                await put_on_caller(sentinel)

        pump_future = asyncio.run_coroutine_threadsafe(pump(), owner)
        try:
            while True:
                item = await queue.get()
                if item is sentinel:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            if not pump_future.done():
                pump_future.cancel()

    @property
    def is_alive(self) -> bool:
        """Check if the connection appears alive (no network IO)."""
        if not self._alive:
            return False
        if self.is_subprocess_mode:
            return True  # subprocess mode: can't check without running a command
        # asyncssh: use public is_closed() API
        conn = self.conn
        try:
            if hasattr(conn, 'is_closed') and callable(conn.is_closed):
                if conn.is_closed():
                    return False
        except Exception:
            return False  # Connection check failed — treat as disconnected
        return True

    @property
    def scheduler(self) -> SchedulerInterface:
        return _get_schedulers()[self.scheduler_type]

    @property
    def is_subprocess_mode(self) -> bool:
        from catgo.utils.local_connection import SubprocessSSHRunner
        return isinstance(self.conn, SubprocessSSHRunner)

    async def get_sftp(self) -> Optional[asyncssh.SFTPClient]:
        """Get or create SFTP client (lazy init, reused).

        Returns None if SFTP is unavailable (subprocess mode or server
        doesn't support SFTP subsystem).  Callers should fall back to
        SSH exec-based operations when this returns None.
        """
        if self.is_subprocess_mode or self._sftp_failed:
            return None
        if self.sftp is None:
            try:
                self.sftp = await self.conn.start_sftp_client()
            except Exception as e:
                logger.warning(f"SFTP subsystem unavailable, will use SSH exec fallback: {e}")
                self._sftp_failed = True
                return None
        return self.sftp

    async def get_overview(self) -> HPCOverview:
        """Fetch overview data (job summary, disk usage, system info) in parallel."""
        scheduler = self.scheduler

        async def fetch_jobs() -> JobSummary:
            try:
                jobs = await scheduler.list_jobs(self.conn, self.username)
                summary = JobSummary(total=len(jobs))
                for j in jobs:
                    if j.status == JobStatus.RUNNING:
                        summary.running += 1
                    elif j.status == JobStatus.PENDING:
                        summary.pending += 1
                    elif j.status == JobStatus.COMPLETED:
                        summary.completed += 1
                    elif j.status in (JobStatus.FAILED, JobStatus.CANCELLED):
                        summary.failed += 1
                return summary
            except Exception as e:
                logger.debug("Failed to fetch job summary: %s", e)
                return JobSummary()

        async def fetch_disk() -> str:
            try:
                result = await asyncio.wait_for(
                    self.conn.run("df -h ~ 2>/dev/null | tail -1", check=False),
                    timeout=10,
                )
                return (result.stdout or "").strip()
            except Exception as e:
                logger.debug("Failed to fetch disk usage: %s", e)
                return ""

        async def fetch_system() -> str:
            try:
                result = await asyncio.wait_for(
                    self.conn.run("hostname -f 2>/dev/null || hostname", check=False),
                    timeout=10,
                )
                return (result.stdout or "").strip()
            except Exception as e:
                logger.debug("Failed to fetch system info: %s", e)
                return ""

        job_summary, disk_usage, system_info = await asyncio.gather(
            fetch_jobs(), fetch_disk(), fetch_system()
        )

        return HPCOverview(
            session_id=self.session_id,
            host=self.host,
            username=self.username,
            scheduler=self.scheduler_type,
            uptime_seconds=time.time() - self.connected_at,
            job_summary=job_summary,
            disk_usage=disk_usage,
            system_info=system_info,
        )

    @staticmethod
    def _find_available_port(preferred: int, scan_range: int = 100) -> int:
        """Find an available local port, starting from preferred."""
        for offset in range(scan_range):
            port = preferred + offset
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(('', port))
                    return port
            except OSError:
                continue
        raise RuntimeError(
            f"No available port found in range {preferred}-{preferred + scan_range - 1}"
        )

    async def setup_tunnel(
        self, node: str, remote_port: int, local_port: int = 8000
    ) -> int:
        """Create an SSH port forward from local_port to node:remote_port.

        Returns the actual local port used (may differ if preferred was busy).
        """
        # Clean up any existing tunnel first
        await self.teardown_tunnel()

        actual_port = self._find_available_port(local_port)

        if self.is_subprocess_mode:
            # Subprocess mode: spawn ssh -L
            alias = self.ssh_alias or self.host
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-N", "-L", f"{actual_port}:{node}:{remote_port}", alias,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            # Give it a moment to establish (or fail)
            await asyncio.sleep(1.5)
            if proc.returncode is not None:
                stderr = await proc.stderr.read()
                raise RuntimeError(
                    f"SSH tunnel failed: {stderr.decode('utf-8', errors='replace')}"
                )
            self.catgo_tunnel_process = proc
        else:
            # asyncssh mode: forward_local_port
            listener = await self.conn.forward_local_port(
                '', actual_port, node, remote_port
            )
            self.catgo_tunnel_listener = listener

        self.catgo_tunnel_local_port = actual_port
        self.catgo_tunnel_node = node
        logger.info(
            f"Tunnel established: localhost:{actual_port} -> {node}:{remote_port}"
        )
        return actual_port

    async def teardown_tunnel(self) -> None:
        """Close any active SSH tunnel."""
        if self.catgo_tunnel_listener:
            try:
                self.catgo_tunnel_listener.close()
            except Exception:
                pass  # Best-effort cleanup during teardown
            self.catgo_tunnel_listener = None

        if self.catgo_tunnel_process:
            try:
                self.catgo_tunnel_process.terminate()
                await asyncio.wait_for(
                    self.catgo_tunnel_process.wait(), timeout=5
                )
            except Exception:
                try:
                    self.catgo_tunnel_process.kill()
                except Exception:
                    pass  # Best-effort cleanup: process may already be dead
            self.catgo_tunnel_process = None

        if self.catgo_tunnel_local_port:
            logger.info(f"Tunnel on port {self.catgo_tunnel_local_port} closed")
        self.catgo_tunnel_local_port = None
        self.catgo_tunnel_node = None

    async def close(self) -> None:
        """Close all connections."""
        await self.teardown_tunnel()
        if self.sftp:
            self.sftp.exit()
            self.sftp = None
        self.conn.close()
        if hasattr(self.conn, 'wait_closed'):
            await self.conn.wait_closed()
        if self.jump_conn:
            self.jump_conn.close()
            await self.jump_conn.wait_closed()
