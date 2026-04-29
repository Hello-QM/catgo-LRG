"""PBS/Torque workload manager implementation."""

import logging
import shlex
import time
from typing import Optional

import asyncssh

from catgo.models.hpc import JobDetailInfo, JobInfo, JobStatus
from catgo.utils.scheduler_base import SchedulerInterface

logger = logging.getLogger(__name__)


class PBSScheduler(SchedulerInterface):
    """PBS/Torque workload manager implementation."""

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
        safe_name = shlex.quote(job_name)
        safe_dir = shlex.quote(work_dir)

        lines = [
            "#!/bin/bash",
            f"#PBS -N {safe_name}",
            f"#PBS -l nodes={nodes}:ppn={cpus_per_task}",
            f"#PBS -l walltime={shlex.quote(time_limit)}",
        ]
        if partition:
            lines.append(f"#PBS -q {shlex.quote(partition)}")
        if memory:
            lines.append(f"#PBS -l mem={shlex.quote(memory)}")
        lines.append(f"#PBS -o {safe_name}_$PBS_JOBID.out")
        lines.append(f"#PBS -e {safe_name}_$PBS_JOBID.err")
        lines.append(f"cd {safe_dir}")
        lines.append("")
        lines.append(script_content)

        full_script = "\n".join(lines)
        script_path = f"{work_dir}/catgo_{job_name}_{int(time.time())}.sh"
        safe_script_path = shlex.quote(script_path)

        write_cmd = f"mkdir -p {safe_dir} && cat > {safe_script_path} << 'CATGO_EOF'\n{full_script}\nCATGO_EOF"
        result = await self._run(conn, write_cmd)
        if result.exit_status != 0:
            return False, f"Failed to write job script: {result.stderr}", None

        submit_result = await self._run(conn, f"qsub {safe_script_path}")
        if submit_result.exit_status != 0:
            return False, f"qsub failed: {submit_result.stderr}", None

        job_id = (submit_result.stdout or "").strip()
        if job_id:
            return True, f"Job submitted: {job_id}", job_id
        return False, "Could not parse job ID from qsub output", None

    async def list_jobs(
        self, conn, username: str, start_time: str = "",
    ) -> list[JobInfo]:
        safe_user = shlex.quote(username)
        result = await self._run(conn, f"qstat -u {safe_user}")
        if result.exit_status != 0 or not result.stdout:
            return []

        jobs: list[JobInfo] = []
        lines = result.stdout.strip().split("\n")
        # Skip header lines (typically first 5 lines in qstat output)
        for line in lines:
            line = line.strip()
            if not line or line.startswith("-") or line.startswith("Job") or line.startswith("Req"):
                continue
            parts = line.split()
            if len(parts) >= 6:
                jobs.append(
                    JobInfo(
                        job_id=parts[0],
                        job_name=parts[1] if len(parts) > 1 else "",
                        status=self._map_status(parts[4] if len(parts) > 4 else ""),
                        partition=parts[2] if len(parts) > 2 else "",
                        time_elapsed=parts[3] if len(parts) > 3 else "",
                        nodes=parts[5] if len(parts) > 5 else "",
                    )
                )
        return jobs

    async def get_job_status(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> Optional[JobInfo]:
        safe_id = shlex.quote(job_id)
        result = await self._run(conn, f"qstat -f {safe_id}")
        if result.exit_status != 0 or not result.stdout:
            return None

        # Parse qstat -f output (key = value format)
        info: dict[str, str] = {}
        for line in result.stdout.split("\n"):
            if "=" in line:
                key, _, val = line.partition("=")
                info[key.strip()] = val.strip()

        return JobInfo(
            job_id=job_id,
            job_name=info.get("Job_Name", ""),
            status=self._map_status(info.get("job_state", "")),
            partition=info.get("queue", ""),
            time_elapsed=info.get("resources_used.walltime", ""),
            time_limit=info.get("Resource_List.walltime", ""),
        )

    async def cancel_job(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> tuple[bool, str]:
        safe_id = shlex.quote(job_id)
        result = await self._run(conn, f"qdel {safe_id}")
        if result.exit_status == 0:
            return True, f"Job {job_id} cancelled"
        return False, f"qdel failed: {result.stderr}"

    async def get_job_detail(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> Optional[JobDetailInfo]:
        """Use qstat -f for PBS/Torque extended info."""
        safe_id = shlex.quote(job_id)
        result = await self._run(conn, f"qstat -f {safe_id} 2>/dev/null")
        if result.exit_status != 0 or not (result.stdout or "").strip():
            return None

        kv: dict[str, str] = {}
        current_key = ""
        for line in (result.stdout or "").split("\n"):
            stripped = line.strip()
            if " = " in stripped:
                key, _, val = stripped.partition(" = ")
                key = key.strip()
                current_key = key
                kv[key] = val.strip()
            elif current_key and stripped:
                # Continuation line
                kv[current_key] += stripped

        return JobDetailInfo(
            job_id=kv.get("Job Id", job_id),
            job_name=kv.get("Job_Name", ""),
            status=self._map_status(kv.get("job_state", "UNKNOWN")),
            partition=kv.get("queue", ""),
            account=kv.get("Account_Name", ""),
            work_dir=kv.get("init_work_dir", kv.get("Variable_List", "").split("PBS_O_WORKDIR=")[-1].split(",")[0] if "PBS_O_WORKDIR" in kv.get("Variable_List", "") else ""),
            stdout_path=kv.get("Output_Path", "").split(":")[-1],
            stderr_path=kv.get("Error_Path", "").split(":")[-1],
            time_elapsed=kv.get("resources_used.walltime", ""),
            time_limit=kv.get("Resource_List.walltime", ""),
            submit_time=kv.get("ctime", ""),
            start_time=kv.get("stime", kv.get("start_time", "")),
            node_list=kv.get("exec_host", ""),
            exit_code=kv.get("exit_status", ""),
        )

    @staticmethod
    def _map_status(pbs_state: str) -> JobStatus:
        mapping = {
            "Q": JobStatus.PENDING,
            "R": JobStatus.RUNNING,
            "C": JobStatus.COMPLETED,
            "E": JobStatus.RUNNING,  # Exiting
            "H": JobStatus.PENDING,  # Held
            "T": JobStatus.PENDING,  # Moving
            "W": JobStatus.PENDING,  # Waiting
            "S": JobStatus.RUNNING,  # Suspended
        }
        return mapping.get(pbs_state.strip(), JobStatus.UNKNOWN)
