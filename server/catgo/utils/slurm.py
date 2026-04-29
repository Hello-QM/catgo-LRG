"""SLURM workload manager implementation."""

import logging
import shlex
import time
from typing import Optional

import asyncssh

from catgo.models.hpc import JobDetailInfo, JobInfo, JobStatus
from catgo.utils.scheduler_base import SchedulerInterface

logger = logging.getLogger(__name__)


class SLURMScheduler(SchedulerInterface):
    """SLURM workload manager implementation."""

    async def submit_job(
        self,
        conn: asyncssh.SSHClientConnection,
        script_content: str,
        job_name: str,
        work_dir: str,
        partition: Optional[str] = None,
        nodes: int = 1,
        ntasks: int = 1,
        cpus_per_task: int = 1,
        time_limit: str = "01:00:00",
        memory: Optional[str] = None,
        script_file: Optional[str] = None,
    ) -> tuple[bool, str, Optional[str]]:
        safe_dir = shlex.quote(work_dir)

        if script_file:
            # Submit a pre-written script file directly (no header generation)
            safe_script_path = shlex.quote(script_file)
            submit_result = await self._run(
                conn, f"cd {safe_dir} && sbatch {safe_script_path}"
            )
        else:
            # Legacy path: build SLURM header + script_content
            safe_name = shlex.quote(job_name)
            lines = [
                "#!/bin/bash",
                f"#SBATCH --job-name={safe_name}",
                f"#SBATCH --nodes={nodes}",
                f"#SBATCH --ntasks={ntasks}",
                f"#SBATCH --cpus-per-task={cpus_per_task}",
                f"#SBATCH --time={shlex.quote(time_limit)}",
            ]
            if partition:
                lines.append(f"#SBATCH --partition={shlex.quote(partition)}")
            if memory:
                lines.append(f"#SBATCH --mem={shlex.quote(memory)}")
            lines.append(f"#SBATCH --output={safe_name}_%j.out")
            lines.append(f"#SBATCH --error={safe_name}_%j.err")
            lines.append("")
            lines.append(script_content)

            full_script = "\n".join(lines)

            script_path = f"{work_dir}/catgo_{job_name}_{int(time.time())}.sh"
            safe_script_path = shlex.quote(script_path)

            write_cmd = (
                f"mkdir -p {safe_dir} && cat > {safe_script_path}"
                f" << 'CATGO_EOF'\n{full_script}\nCATGO_EOF"
            )
            result = await self._run(conn, write_cmd)
            if result.exit_status != 0:
                return False, f"Failed to write job script: {result.stderr}", None

            submit_result = await self._run(
                conn, f"cd {safe_dir} && sbatch {safe_script_path}"
            )

        if submit_result.exit_status != 0:
            return False, f"sbatch failed: {submit_result.stderr}", None

        # Parse job ID from "Submitted batch job 12345"
        stdout = (submit_result.stdout or "").strip()
        job_id = None
        for word in stdout.split():
            if word.isdigit():
                job_id = word
                break

        if job_id:
            return True, f"Job submitted: {job_id}", job_id
        return False, f"Could not parse job ID from: {stdout}", None

    async def list_jobs(
        self, conn, username: str, start_time: str = "",
    ) -> list[JobInfo]:
        """List jobs: current queue (squeue) + historical (sacct).

        Args:
            start_time: sacct --starttime value, e.g. "now-1hour", "now-24hours", "now-7days".
                        If empty, only returns current queue from squeue.
        """
        seen_ids: set[str] = set()
        jobs: list[JobInfo] = []

        # --- Current queue via squeue ---
        fmt = "%i|%j|%T|%P|%D|%M|%l|%V|%S|%r|%Z"
        result = await self._run(
            conn,
            f"squeue -u {shlex.quote(username)} -h -o '{fmt}'",
        )
        if result.exit_status == 0 and (result.stdout or "").strip():
            for line in result.stdout.strip().splitlines():
                parts = line.strip().split("|")
                if len(parts) < 10:
                    continue
                jid = parts[0].strip()
                if jid in seen_ids:
                    continue
                seen_ids.add(jid)
                status_str = parts[2].strip().upper()
                status = self._map_status(status_str)
                jobs.append(
                    JobInfo(
                        job_id=jid,
                        job_name=parts[1].strip(),
                        status=status,
                        partition=parts[3].strip(),
                        nodes=parts[4].strip(),
                        time_elapsed=parts[5].strip(),
                        time_limit=parts[6].strip(),
                        submit_time=parts[7].strip(),
                        start_time=parts[8].strip(),
                        reason=parts[9].strip(),
                        work_dir=parts[10].strip() if len(parts) > 10 else "",
                    )
                )

        # --- Historical jobs via sacct ---
        if start_time:
            sacct_fmt = "JobID,JobName,State,Partition,AllocNodes,Elapsed,Timelimit,Submit,Start,ExitCode,WorkDir"
            sacct_cmd = (
                f"sacct -u {shlex.quote(username)} --parsable2 --noheader "
                f"--starttime={shlex.quote(start_time)} "
                f"--format={sacct_fmt}"
            )
            sacct_result = await self._run(conn, sacct_cmd)
            if sacct_result.exit_status == 0 and (sacct_result.stdout or "").strip():
                for line in sacct_result.stdout.strip().splitlines():
                    parts = line.strip().split("|")
                    if len(parts) < 11:
                        continue
                    jid = parts[0].strip()
                    # Skip sub-steps like "12345.batch" or "12345.extern"
                    if "." in jid:
                        continue
                    if jid in seen_ids:
                        continue
                    seen_ids.add(jid)
                    status_str = parts[2].strip().upper()
                    # sacct status may include exit code like "COMPLETED" or "FAILED"
                    # Strip anything after a space
                    if " " in status_str:
                        status_str = status_str.split()[0]
                    status = self._map_status(status_str)
                    jobs.append(
                        JobInfo(
                            job_id=jid,
                            job_name=parts[1].strip(),
                            status=status,
                            partition=parts[3].strip(),
                            nodes=parts[4].strip(),
                            time_elapsed=parts[5].strip(),
                            time_limit=parts[6].strip(),
                            submit_time=parts[7].strip(),
                            start_time=parts[8].strip(),
                            reason="",
                            work_dir=parts[10].strip() if len(parts) > 10 else "",
                        )
                    )

        return jobs

    async def get_job_status(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> Optional[JobInfo]:
        safe_id = shlex.quote(job_id)
        fmt = "%i|%j|%T|%P|%D|%M|%l|%V|%S|%r"
        result = await self._run(conn, f"squeue -j {safe_id} -h -o '{fmt}'")

        # If squeue returns nothing, try sacct for completed jobs
        if result.exit_status != 0 or not (result.stdout or "").strip():
            sacct_result = await self._run(
                conn,
                f"sacct -j {safe_id} -n -o 'JobID,JobName%30,State,Partition,NNodes,Elapsed,Timelimit,Submit,Start' --parsable2",
            )
            if sacct_result.exit_status == 0 and (sacct_result.stdout or "").strip():
                for line in sacct_result.stdout.strip().split("\n"):
                    parts = line.split("|")
                    # Skip sub-steps (e.g., 12345.batch)
                    if len(parts) >= 9 and "." not in parts[0]:
                        return JobInfo(
                            job_id=parts[0].strip(),
                            job_name=parts[1].strip(),
                            status=self._map_status(parts[2].strip()),
                            partition=parts[3].strip(),
                            nodes=parts[4].strip(),
                            time_elapsed=parts[5].strip(),
                            time_limit=parts[6].strip(),
                            submit_time=parts[7].strip(),
                            start_time=parts[8].strip(),
                        )
            return None

        line = result.stdout.strip().split("\n")[0]
        parts = line.split("|")
        if len(parts) >= 10:
            return JobInfo(
                job_id=parts[0].strip(),
                job_name=parts[1].strip(),
                status=self._map_status(parts[2].strip()),
                partition=parts[3].strip(),
                nodes=parts[4].strip(),
                time_elapsed=parts[5].strip(),
                time_limit=parts[6].strip(),
                submit_time=parts[7].strip(),
                start_time=parts[8].strip(),
                reason=parts[9].strip(),
            )
        return None

    async def get_job_status_sacct(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> Optional[JobInfo]:
        """Query sacct directly, bypassing squeue. Used for periodic cross-check.

        This is useful for detecting completed jobs when squeue has lagged
        behind SLURM's actual state (e.g., reporting RUNNING for a finished job).
        """
        safe_id = shlex.quote(job_id)
        sacct_result = await self._run(
            conn,
            f"sacct -j {safe_id} -n -o 'JobID,JobName%30,State,Partition,NNodes,Elapsed,Timelimit,Submit,Start' --parsable2",
        )
        if sacct_result.exit_status == 0 and (sacct_result.stdout or "").strip():
            for line in sacct_result.stdout.strip().split("\n"):
                parts = line.split("|")
                # Skip sub-steps (e.g., 12345.batch)
                if len(parts) >= 9 and "." not in parts[0]:
                    return JobInfo(
                        job_id=parts[0].strip(),
                        job_name=parts[1].strip(),
                        status=self._map_status(parts[2].strip()),
                        partition=parts[3].strip(),
                        nodes=parts[4].strip(),
                        time_elapsed=parts[5].strip(),
                        time_limit=parts[6].strip(),
                        submit_time=parts[7].strip(),
                        start_time=parts[8].strip(),
                    )
        return None

    async def get_array_job_statuses(
        self, conn: asyncssh.SSHClientConnection, array_job_id: str, n: int
    ) -> dict[int, str]:
        """Query sacct for all subtask statuses of a SLURM array job.

        Parses the sacct output to extract individual array task states.
        Only considers lines with '_' separator (array tasks) and ignores
        sub-step lines (those containing '.').

        Args:
            conn: SSH connection to the HPC cluster.
            array_job_id: The parent SLURM array job ID.
            n: Expected number of array tasks (for logging only).

        Returns:
            Dict mapping subtask index (int) to SLURM status string.
        """
        safe_id = shlex.quote(array_job_id)
        result = await self._run(
            conn,
            f"sacct -j {safe_id} -n -o JobID,State --parsable2",
        )
        statuses: dict[int, str] = {}
        for line in (result.stdout or "").strip().split("\n"):
            if not line:
                continue
            parts = line.split("|")
            if len(parts) < 2:
                continue
            job_id_field = parts[0].strip()
            # Match array task lines like "12345_0", skip sub-steps like "12345_0.batch"
            if "_" in job_id_field and "." not in job_id_field:
                try:
                    idx = int(job_id_field.split("_")[1])
                    statuses[idx] = parts[1].strip()
                except (ValueError, IndexError):
                    continue
        return statuses

    async def cancel_job(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> tuple[bool, str]:
        safe_id = shlex.quote(job_id)
        result = await self._run(conn, f"scancel {safe_id}")
        if result.exit_status == 0:
            return True, f"Job {job_id} cancelled"
        return False, f"scancel failed: {result.stderr}"

    async def get_job_detail(
        self, conn: asyncssh.SSHClientConnection, job_id: str
    ) -> Optional[JobDetailInfo]:
        """Use scontrol show job to get extended info, fallback to sacct."""
        safe_id = shlex.quote(job_id)

        # Try scontrol first (for running/pending jobs)
        result = await self._run(conn, f"scontrol show job {safe_id} 2>/dev/null")
        if result.exit_status == 0 and (result.stdout or "").strip():
            return self._parse_scontrol(result.stdout, job_id)

        # Fallback to sacct for completed jobs
        sacct_fmt = "JobID,JobName%60,State,Partition,Account,NNodes,NCPUs,NTasks,Elapsed,Timelimit,Submit,Start,End,WorkDir%200,ExitCode,NodeList%100"
        result = await self._run(
            conn,
            f"sacct -j {safe_id} -n -o '{sacct_fmt}' --parsable2 2>/dev/null"
        )
        if result.exit_status == 0 and (result.stdout or "").strip():
            return self._parse_sacct_detail(result.stdout, job_id)

        return None

    def _parse_scontrol(self, output: str, job_id: str) -> Optional[JobDetailInfo]:
        """Parse scontrol show job output (key=value pairs)."""
        kv: dict[str, str] = {}
        for line in output.split("\n"):
            for pair in line.strip().split():
                if "=" in pair:
                    key, _, val = pair.partition("=")
                    kv[key] = val

        if not kv:
            return None

        return JobDetailInfo(
            job_id=kv.get("JobId", job_id),
            job_name=kv.get("JobName", ""),
            status=self._map_status(kv.get("JobState", "UNKNOWN")),
            partition=kv.get("Partition", ""),
            account=kv.get("Account", ""),
            nodes=kv.get("NumNodes", ""),
            num_nodes=int(kv.get("NumNodes", "0") or "0"),
            num_cpus=int(kv.get("NumCPUs", "0") or "0"),
            num_tasks=int(kv.get("NumTasks", "0") or "0"),
            cpus_per_task=int(kv.get("CPUsPerTask", kv.get("CpusPerTask", "0")) or "0"),
            ntasks_per_node=int(kv.get("NtasksPerNode", "0") or "0"),
            time_elapsed=kv.get("RunTime", ""),
            time_limit=kv.get("TimeLimit", ""),
            submit_time=kv.get("SubmitTime", ""),
            start_time=kv.get("StartTime", ""),
            end_time=kv.get("EndTime", ""),
            work_dir=kv.get("WorkDir", ""),
            stdout_path=kv.get("StdOut", ""),
            stderr_path=kv.get("StdErr", ""),
            command=kv.get("Command", ""),
            node_list=kv.get("NodeList", ""),
            reason=kv.get("Reason", ""),
            exit_code=kv.get("ExitCode", ""),
        )

    def _parse_sacct_detail(self, output: str, job_id: str) -> Optional[JobDetailInfo]:
        """Parse sacct --parsable2 output for completed jobs."""
        for line in output.strip().split("\n"):
            parts = line.split("|")
            # Skip sub-steps (e.g. 12345.batch)
            if len(parts) >= 16 and "." not in parts[0]:
                return JobDetailInfo(
                    job_id=parts[0].strip(),
                    job_name=parts[1].strip(),
                    status=self._map_status(parts[2].strip()),
                    partition=parts[3].strip(),
                    account=parts[4].strip(),
                    num_nodes=int(parts[5].strip() or "0"),
                    num_cpus=int(parts[6].strip() or "0"),
                    num_tasks=int(parts[7].strip() or "0"),
                    time_elapsed=parts[8].strip(),
                    time_limit=parts[9].strip(),
                    submit_time=parts[10].strip(),
                    start_time=parts[11].strip(),
                    end_time=parts[12].strip(),
                    work_dir=parts[13].strip(),
                    exit_code=parts[14].strip(),
                    node_list=parts[15].strip() if len(parts) > 15 else "",
                )
        return None

    @staticmethod
    def _map_status(slurm_state: str) -> JobStatus:
        """Map SLURM status string to JobStatus enum."""
        mapping = {
            "PENDING": JobStatus.PENDING,
            "RUNNING": JobStatus.RUNNING,
            "COMPLETED": JobStatus.COMPLETED,
            "FAILED": JobStatus.FAILED,
            "CANCELLED": JobStatus.CANCELLED,
            "TIMEOUT": JobStatus.FAILED,
            "NODE_FAIL": JobStatus.FAILED,
            "PREEMPTED": JobStatus.CANCELLED,
            "SUSPENDED": JobStatus.PENDING,
            "OUT_OF_MEMORY": JobStatus.FAILED,
            "CONFIGURING": JobStatus.PENDING,
            "COMPLETING": JobStatus.RUNNING,
        }
        # Handle states like "CANCELLED by 12345" or "CANCELLED+"
        base_state = slurm_state.split()[0].rstrip("+")
        return mapping.get(base_state, JobStatus.UNKNOWN)
