"""HPCConnection — a pooled SSH connection with metadata and lifecycle management."""

import asyncio
import logging
import socket
import time
from dataclasses import dataclass, field
from typing import Any, Optional

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
