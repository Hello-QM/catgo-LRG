"""Abstract base class for HPC job schedulers and lazy scheduler registry."""

import asyncio
import logging
import shlex
from abc import ABC, abstractmethod
from typing import Optional

import asyncssh

from catgo.models.hpc import JobDetailInfo, JobInfo, SchedulerType

logger = logging.getLogger(__name__)


class SchedulerInterface(ABC):
    """Abstract base class for job schedulers."""

    @abstractmethod
    async def submit_job(
        self,
        conn: asyncssh.SSHClientConnection,
        script_content: str,
        job_name: str,
        work_dir: str,
        partition: Optional[str],
        nodes: int,
        ntasks: int,
        cpus_per_task: int,
        time_limit: str,
        memory: Optional[str],
    ) -> tuple[bool, str, Optional[str]]:
        """Submit a job. Returns (success, message, job_id)."""

    @abstractmethod
    async def list_jobs(
        self, conn: asyncssh.SSHClientConnection, username: str,
        start_time: str = "",
    ) -> list[JobInfo]:
        """List jobs for a user."""

    @abstractmethod
    async def get_job_status(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> Optional[JobInfo]:
        """Get status of a specific job."""

    @abstractmethod
    async def cancel_job(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> tuple[bool, str]:
        """Cancel a job. Returns (success, message)."""

    @abstractmethod
    async def get_job_detail(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> Optional[JobDetailInfo]:
        """Get extended job information (work_dir, account, node_list, etc.)."""

    async def _run(
        self, conn: asyncssh.SSHClientConnection, cmd: str, timeout: float = 30
    ) -> asyncssh.SSHCompletedProcess:
        """Run a command on the remote host with timeout.

        Wraps in login shell so module-managed tools (sbatch, squeue) are in PATH.
        """
        login_cmd = f"bash -l -c {shlex.quote(cmd)}"
        try:
            return await asyncio.wait_for(conn.run(login_cmd, check=False), timeout=timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(f"SSH command timed out ({timeout}s): {cmd[:80]}")


# ====== Lazy scheduler loader ======

_SCHEDULERS: dict[SchedulerType, SchedulerInterface] | None = None


def _get_schedulers() -> dict[SchedulerType, SchedulerInterface]:
    global _SCHEDULERS
    if _SCHEDULERS is None:
        from catgo.utils.slurm import SLURMScheduler
        from catgo.utils.pbs import PBSScheduler
        _SCHEDULERS = {
            SchedulerType.SLURM: SLURMScheduler(),
            SchedulerType.PBS: PBSScheduler(),
        }
    return _SCHEDULERS
