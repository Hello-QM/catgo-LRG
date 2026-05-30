"""Local execution: subprocess SSH runner, local command runner, local scheduler, and local file connection."""

import asyncio
import logging
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from catgo.models.hpc import JobDetailInfo, JobInfo, JobStatus, SchedulerType
from catgo.utils.hpc_connection import HPCConnection
from catgo.utils.hpc_client import LOCAL_SESSION_ID
from catgo.utils.scheduler_base import SchedulerInterface
from catgo.utils.ssh_file_ops import LocalFileOpsMixin

logger = logging.getLogger(__name__)


# ====== Subprocess SSH Runner ======


@dataclass
class SubprocessCompletedProcess:
    """Mimics asyncssh.SSHCompletedProcess for subprocess SSH."""
    exit_status: int
    stdout: str
    stderr: str


class SubprocessSSHRunner:
    """Runs commands via system ssh binary, piggybacking on ControlMaster.

    Implements the minimal conn.run() interface needed by SchedulerInterface._run().
    """

    def __init__(self, ssh_alias: str) -> None:
        self.ssh_alias = ssh_alias

    async def run(self, cmd: str, check: bool = False, timeout: float = 60) -> SubprocessCompletedProcess:
        # Wrap in login shell so module-managed tools (sbatch, squeue, etc.) are in PATH
        login_cmd = f"bash -l -c {shlex.quote(cmd)}"
        proc = await asyncio.create_subprocess_exec(
            # BatchMode=yes: ControlMaster mode assumes a master socket already
            # exists, so no prompt is ever needed. Without it, a missing master
            # makes ssh fall back to interactive auth → no TTY → it execs
            # /usr/bin/ssh-askpass and dies with "Connection closed ... port 65535"
            # instead of a clean "Permission denied / master not active" error.
            "ssh", "-o", "BatchMode=yes", self.ssh_alias, login_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except (asyncio.TimeoutError, TimeoutError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise TimeoutError(
                f"ssh '{self.ssh_alias}' command timed out after {timeout:g}s "
                f"(transferring a large file? cmd: {cmd[:80]})"
            )
        result = SubprocessCompletedProcess(
            exit_status=proc.returncode or 0,
            stdout=stdout_bytes.decode("utf-8", errors="replace"),
            stderr=stderr_bytes.decode("utf-8", errors="replace"),
        )
        if check and result.exit_status != 0:
            raise RuntimeError(f"Command failed ({result.exit_status}): {result.stderr}")
        return result

    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass


class LocalCommandRunner:
    """Runs commands on the local machine via subprocess.

    Same interface as SubprocessSSHRunner but executes locally (no ssh prefix).
    Used by LocalFileConnection so that existing code paths in job_parser.py
    (conn.run("cat ..."), conn.run("head -c ..."), etc.) work transparently.
    """

    async def run(self, cmd: str, check: bool = False, timeout: float = 60) -> SubprocessCompletedProcess:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
        result = SubprocessCompletedProcess(
            exit_status=proc.returncode or 0,
            stdout=stdout_bytes.decode("utf-8", errors="replace"),
            stderr=stderr_bytes.decode("utf-8", errors="replace"),
        )
        if check and result.exit_status != 0:
            raise RuntimeError(f"Command failed ({result.exit_status}): {result.stderr}")
        return result

    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass


# ====== Local Scheduler ======


class LocalScheduler(SchedulerInterface):
    """Runs job scripts directly as local subprocesses (no SLURM/PBS).

    Used by LocalFileConnection when the user selects 'Local' execution
    environment for a workflow step. Jobs are tracked by a synthetic ID
    mapped to an asyncio subprocess.
    """

    def __init__(self) -> None:
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._return_codes: dict[str, int] = {}
        self._counter = 0

    async def submit_job(
        self,
        conn: Any,
        script_content: str,
        job_name: str,
        work_dir: str,
        partition: Optional[str] = None,
        nodes: int = 1,
        ntasks: int = 1,
        cpus_per_task: int = 1,
        time_limit: str = "01:00:00",
        memory: Optional[str] = None,
    ) -> tuple[bool, str, Optional[str]]:
        """Run the job script as a background subprocess."""
        self._counter += 1
        job_id = f"local-{self._counter}"
        try:
            proc = await asyncio.create_subprocess_shell(
                f"cd {shlex.quote(work_dir)} && bash submit.sh",
                stdout=open(f"{work_dir}/stdout.log", "w"),
                stderr=open(f"{work_dir}/stderr.log", "w"),
            )
            self._processes[job_id] = proc
            # Start a background task to record the return code when done
            asyncio.create_task(self._wait_for(job_id, proc))
            return True, f"Started local process PID={proc.pid}", job_id
        except Exception as e:
            return False, f"Local execution failed: {e}", None

    async def _wait_for(self, job_id: str, proc: asyncio.subprocess.Process) -> None:
        """Background task to capture return code when process finishes."""
        try:
            await proc.wait()
            self._return_codes[job_id] = proc.returncode or 0
        except Exception:
            self._return_codes[job_id] = 1
        finally:
            self._processes.pop(job_id, None)

    async def get_job_status(self, conn: Any, job_id: str) -> Optional[JobInfo]:
        if job_id in self._processes:
            proc = self._processes[job_id]
            if proc.returncode is None:
                return JobInfo(job_id=job_id, job_name=job_id, status=JobStatus.RUNNING)
            status = JobStatus.COMPLETED if proc.returncode == 0 else JobStatus.FAILED
            return JobInfo(job_id=job_id, job_name=job_id, status=status)
        if job_id in self._return_codes:
            rc = self._return_codes[job_id]
            status = JobStatus.COMPLETED if rc == 0 else JobStatus.FAILED
            return JobInfo(job_id=job_id, job_name=job_id, status=status)
        return JobInfo(job_id=job_id, job_name=job_id, status=JobStatus.UNKNOWN)

    async def cancel_job(self, conn: Any, job_id: str) -> tuple[bool, str]:
        proc = self._processes.get(job_id)
        if proc and proc.returncode is None:
            proc.terminate()
            return True, "Process terminated"
        return False, "Process not found or already finished"

    async def list_jobs(
        self, conn: Any, username: str, start_time: str = ""
    ) -> list[JobInfo]:
        jobs: list[JobInfo] = []
        for jid, proc in self._processes.items():
            status = JobStatus.RUNNING if proc.returncode is None else (
                JobStatus.COMPLETED if proc.returncode == 0 else JobStatus.FAILED
            )
            jobs.append(JobInfo(job_id=jid, job_name=jid, status=status))
        return jobs

    async def get_job_detail(self, conn: Any, job_id: str) -> Optional[JobDetailInfo]:
        info = await self.get_job_status(conn, job_id)
        if not info:
            return None
        return JobDetailInfo(job_id=job_id, job_name=job_id, status=info.status)


# ====== Local File Connection ======


class LocalFileConnection(LocalFileOpsMixin, HPCConnection):
    """HPCConnection subclass for local filesystem operations.

    Uses LocalCommandRunner for conn.run() calls so that existing code paths
    (job_parser.read_remote_file, write_remote_file, etc.) work transparently.
    Overrides file I/O methods to use pathlib for reliability.
    """

    _local_scheduler: LocalScheduler | None = None

    def __init__(self) -> None:
        import getpass
        import socket
        super().__init__(
            session_id=LOCAL_SESSION_ID,
            conn=LocalCommandRunner(),
            scheduler_type=SchedulerType.SLURM,  # placeholder for type enum
            username=getpass.getuser(),
            host=socket.gethostname(),
        )
        self._local_scheduler = LocalScheduler()

    @property
    def scheduler(self) -> SchedulerInterface:
        """Override: use LocalScheduler instead of SLURM/PBS."""
        return self._local_scheduler  # type: ignore[return-value]

    @property
    def is_subprocess_mode(self) -> bool:
        return True

    async def get_sftp(self) -> None:
        return None

    def _resolve_local_path(self, path: str) -> Path:
        """Resolve ~ and return a pathlib Path. Works on both Unix and Windows."""
        if path == "~" or path.startswith("~/") or path.startswith("~\\"):
            path = path.replace("~", str(Path.home()), 1)
        return Path(path).resolve()

    async def read_file_content(self, file_path: str, max_bytes: int = 2 * 1024 * 1024) -> tuple[str, int]:
        """Read a local file using pathlib (cross-platform, no shell commands)."""
        p = self._resolve_local_path(file_path)
        if not p.exists() or p.is_dir():
            raise RuntimeError(f"Not found: {p}")
        content = p.read_text(encoding="utf-8", errors="replace")
        total_lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
        if len(content.encode("utf-8")) > max_bytes:
            # Truncate to max_bytes (approximate, respecting UTF-8 boundaries)
            content = content[:max_bytes]
        return content, total_lines

    async def mkdir_local(self, path: str) -> None:
        """Create directory using pathlib."""
        p = self._resolve_local_path(path)
        p.mkdir(parents=True, exist_ok=True)

    async def delete_local(self, path: str) -> None:
        """Delete file or directory using pathlib/shutil."""
        import shutil
        p = self._resolve_local_path(path)
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()

    async def rename_local(self, old_path: str, new_path: str) -> None:
        """Rename/move using pathlib."""
        old_p = self._resolve_local_path(old_path)
        new_p = self._resolve_local_path(new_path)
        old_p.rename(new_p)

    async def copy_local(self, src_path: str, dest_path: str) -> None:
        """Copy file using shutil."""
        import shutil
        src_p = self._resolve_local_path(src_path)
        dest_p = self._resolve_local_path(dest_path)
        if src_p.is_dir():
            shutil.copytree(src_p, dest_p)
        else:
            shutil.copy2(src_p, dest_p)

    async def close(self) -> None:
        """No-op: local connection never closes."""
        pass
