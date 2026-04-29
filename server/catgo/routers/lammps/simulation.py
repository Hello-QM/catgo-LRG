"""LAMMPS MD simulation submission/monitoring endpoints.

Provides FastAPI endpoints for running LAMMPS simulations locally or on HPC
clusters, polling job status, retrieving results (thermo data, trajectories,
restart files), cancelling jobs, and listing all tracked jobs.
"""

__all__ = [
    "router",
    "LammpsRunRequest",
    "ThermoData",
    "LammpsJobStatus",
    "LammpsResults",
    "run_lammps_local",
    "monitor_local_job",
]

import asyncio
import base64
import shlex
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from catgo.models.hpc import JobStatus
from .utils import (
    ExecutionMode,
    LammpsJobState,
    parse_lammps_log,
    parse_lammps_dump,
)

router = APIRouter()


# Local job tracking: job_id -> job info
_local_jobs: dict[str, dict] = {}
_local_jobs_lock = asyncio.Lock()


# ============================================================================
# Request/Response Models for Execution
# ============================================================================

class LammpsRunRequest(BaseModel):
    """Request to run LAMMPS simulation."""

    # Input files
    input_script: str = Field(..., description="LAMMPS input script content")
    data_file: str = Field(default="", description="LAMMPS data file content (not used if restart_file is provided)")
    potential_file: Optional[str] = Field(None, description="Potential file content (for EAM, ReaxFF, etc.)")
    restart_file: Optional[str] = Field(None, description="Restart file content to continue simulation (base64 encoded)")

    # Output options
    write_restart: bool = Field(default=True, description="Write restart file at the end")

    # Execution configuration
    execution_mode: ExecutionMode = Field(
        default=ExecutionMode.LOCAL,
        description="Execution mode: local or HPC"
    )
    lmp_command: str = Field(
        default="lmp_serial",
        description="LAMMPS executable (lmp_serial, lmp_mpi, etc.)"
    )

    # HPC-specific parameters
    hpc_session_id: Optional[str] = Field(None, description="HPC session ID for HPC mode")
    job_name: str = Field(default="lammps_job", description="Job name for HPC submission")
    work_dir: Optional[str] = Field(None, description="Working directory (HPC or local)")
    nodes: int = Field(default=1, description="Number of nodes (HPC)")
    ntasks: int = Field(default=4, description="Number of tasks (HPC)")
    walltime: str = Field(default="01:00:00", description="Wall time limit (HPC)")


class ThermoData(BaseModel):
    """Thermodynamic data point from LAMMPS log."""
    step: int
    temp: Optional[float] = None
    press: Optional[float] = None
    pe: Optional[float] = None
    ke: Optional[float] = None
    etotal: Optional[float] = None
    vol: Optional[float] = None


class LammpsJobStatus(BaseModel):
    """LAMMPS job status response."""
    job_id: str
    status: LammpsJobState
    message: str = ""
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    exit_code: Optional[int] = None


class LammpsResults(BaseModel):
    """LAMMPS job results."""
    job_id: str
    status: LammpsJobState
    success: bool
    message: str = ""

    # Output files (text content)
    log_file: Optional[str] = None
    trajectory_file: Optional[str] = None
    final_data_file: Optional[str] = None

    # Restart file info (binary, so just filename)
    restart_filename: Optional[str] = None
    restart_size: Optional[int] = None

    # Parsed thermodynamic data
    thermo_data: list[ThermoData] = Field(default_factory=list)

    # Error output
    error_output: Optional[str] = None

    # File info
    output_files: list[str] = Field(default_factory=list)


# ============================================================================
# Local Execution Functions
# ============================================================================

async def run_lammps_local(
    input_script: str,
    data_file: str,
    potential_file: Optional[str],
    restart_file: Optional[str] = None,
    lmp_command: str = "lmp_serial",
    work_dir: Optional[str] = None,
    write_restart: bool = True,
) -> dict:
    """Run LAMMPS locally as a subprocess.

    Args:
        input_script: LAMMPS input script content
        data_file: LAMMPS data file content
        potential_file: Optional potential file content
        restart_file: Optional base64-encoded restart file to continue simulation
        lmp_command: LAMMPS executable command
        work_dir: Working directory path
        write_restart: Whether to write restart file at end

    Returns:
        Dictionary with exit_code, stdout, stderr, and output_files
    """
    # Create temporary working directory
    if work_dir is None:
        work_dir = tempfile.mkdtemp(prefix="lammps_")
    else:
        Path(work_dir).mkdir(parents=True, exist_ok=True)

    input_path = Path(work_dir) / "in.lammps"
    data_path = Path(work_dir) / "system.data"
    log_path = Path(work_dir) / "lammps.log"
    dump_path = Path(work_dir) / "system.dump"
    final_data_path = Path(work_dir) / "final.data"

    # Write input files
    input_path.write_text(input_script)
    if data_file and not restart_file:
        data_path.write_text(data_file)

    # Write restart file if provided (base64 decoded)
    restart_input_path = None
    if restart_file:
        try:
            restart_input_path = Path(work_dir) / "input.restart"
            restart_bytes = base64.b64decode(restart_file)
            restart_input_path.write_bytes(restart_bytes)
        except Exception as e:
            # If decoding fails, assume it's already binary
            restart_input_path = Path(work_dir) / "input.restart"
            restart_input_path.write_bytes(restart_file.encode() if isinstance(restart_file, str) else restart_file)

    if potential_file:
        # Extract potential filename from input script or use default
        pot_path = Path(work_dir) / "potential.eam"
        pot_path.write_bytes(potential_file.encode() if isinstance(potential_file, str) else potential_file)
        # Update input script to reference local potential file
        input_script = input_script.replace("<POTENTIAL_FILE>", "potential.eam")
        input_script = input_script.replace("<REAX_POTENTIAL>", "potential.eam")
        input_path.write_text(input_script)

    # Build LAMMPS command
    cmd = [lmp_command, "-in", str(input_path), "-log", str(log_path)]

    # Run LAMMPS
    process = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=work_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    stdout, stderr = await asyncio.wait_for(
        process.communicate(),
        timeout=3600  # 1 hour timeout
    )

    # Collect output files
    output_files = []
    if log_path.exists():
        output_files.append("lammps.log")
    if dump_path.exists():
        output_files.append("system.dump")
    if final_data_path.exists():
        output_files.append("final.data")

    # Look for any restart file (*.restart or restart.dat)
    work_dir_path = Path(work_dir)
    restart_files = list(work_dir_path.glob("*.restart")) + ([work_dir_path / "restart.dat"] if (work_dir_path / "restart.dat").exists() else [])
    if restart_files:
        output_files.append(restart_files[0].name)

    return {
        "exit_code": process.returncode,
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace"),
        "work_dir": str(work_dir),
        "output_files": output_files,
        "restart_file": restart_files[0].name if restart_files else None,
    }


async def monitor_local_job(job_id: str, run_future: asyncio.Task):
    """Monitor a local LAMMPS job and update status."""
    async with _local_jobs_lock:
        _local_jobs[job_id]["status"] = LammpsJobState.RUNNING
        _local_jobs[job_id]["started_at"] = datetime.now().isoformat()

    try:
        result = await run_future
        async with _local_jobs_lock:
            if result["exit_code"] == 0:
                _local_jobs[job_id]["status"] = LammpsJobState.COMPLETED
                _local_jobs[job_id]["result"] = result
            else:
                _local_jobs[job_id]["status"] = LammpsJobState.FAILED
                _local_jobs[job_id]["error"] = result["stderr"]
            _local_jobs[job_id]["completed_at"] = datetime.now().isoformat()
            _local_jobs[job_id]["exit_code"] = result["exit_code"]
    except asyncio.TimeoutError:
        async with _local_jobs_lock:
            _local_jobs[job_id]["status"] = LammpsJobState.FAILED
            _local_jobs[job_id]["error"] = "Execution timeout"
            _local_jobs[job_id]["completed_at"] = datetime.now().isoformat()
    except Exception as e:
        async with _local_jobs_lock:
            _local_jobs[job_id]["status"] = LammpsJobState.FAILED
            _local_jobs[job_id]["error"] = str(e)
            _local_jobs[job_id]["completed_at"] = datetime.now().isoformat()


# ============================================================================
# API Endpoints
# ============================================================================

@router.post("/run", response_model=LammpsJobStatus)
async def run_lammps(request: LammpsRunRequest) -> LammpsJobStatus:
    """Run LAMMPS simulation (local or HPC mode).

    - Local mode: Spawns subprocess, returns job_id for polling
    - HPC mode: Submits job via HPC client, returns HPC job_id
    """
    job_id = f"lammps_{uuid.uuid4().hex[:12]}"

    if request.execution_mode == ExecutionMode.LOCAL:
        # Create background task for local execution
        async def run_local():
            return await run_lammps_local(
                input_script=request.input_script,
                data_file=request.data_file,
                potential_file=request.potential_file,
                restart_file=request.restart_file,
                lmp_command=request.lmp_command,
                work_dir=request.work_dir,
                write_restart=request.write_restart,
            )

        # Initialize job tracking
        async with _local_jobs_lock:
            _local_jobs[job_id] = {
                "job_id": job_id,
                "status": LammpsJobState.PENDING,
                "execution_mode": "local",
                "created_at": datetime.now().isoformat(),
            }

        # Start background execution
        task = asyncio.create_task(run_local())
        asyncio.create_task(monitor_local_job(job_id, task))

        return LammpsJobStatus(
            job_id=job_id,
            status=LammpsJobState.PENDING,
            message="LAMMPS job queued for local execution",
        )

    else:  # HPC mode
        from catgo.utils.hpc_client import pool
        from catgo.utils.job_parser import write_remote_file

        if not request.hpc_session_id:
            raise HTTPException(
                status_code=400,
                detail="hpc_session_id required for HPC execution mode"
            )

        hpc = pool.get_connection(request.hpc_session_id)
        if not hpc:
            raise HTTPException(
                status_code=404,
                detail=f"HPC session {request.hpc_session_id} not found"
            )

        # Create work directory on HPC
        work_dir = request.work_dir or f"~/lammps_jobs/{job_id}"
        from catgo.utils.hpc_client import resolve_tilde
        work_dir = await resolve_tilde(hpc.conn, work_dir)

        # Create directory
        await hpc.conn.run(f"mkdir -p {shlex.quote(work_dir)}", check=False)

        # Write input files
        input_path = f"{work_dir}/in.lammps"
        data_path = f"{work_dir}/system.data"
        await write_remote_file(hpc.conn, input_path, request.input_script)
        await write_remote_file(hpc.conn, data_path, request.data_file)

        if request.potential_file:
            pot_path = f"{work_dir}/potential.eam"
            pot_content = (request.potential_file.encode()
                          if isinstance(request.potential_file, str)
                          else request.potential_file)
            await write_remote_file(hpc.conn, pot_path, pot_content)

        # Build job script
        script_lines = [
            "#!/bin/bash",
            f"#SBATCH --job-name={request.job_name}",
            f"#SBATCH --nodes={request.nodes}",
            f"#SBATCH --ntasks={request.ntasks}",
            f"#SBATCH --time={request.walltime}",
            f"#SBATCH --output={job_id}.out",
            f"#SBATCH --error={job_id}.err",
            "",
            f"cd {shlex.quote(work_dir)}",
            f"mpirun -np {request.ntasks} {request.lmp_command} -in in.lammps -log lammps.log",
        ]
        job_script = "\n".join(script_lines)

        # Submit job
        success, message, hpc_job_id = await hpc.scheduler.submit_job(
            conn=hpc.conn,
            script_content=job_script,
            job_name=request.job_name,
            work_dir=work_dir,
            partition=None,
            nodes=request.nodes,
            ntasks=request.ntasks,
            cpus_per_task=1,
            time_limit=request.walltime,
            memory=None,
        )

        if not success or not hpc_job_id:
            raise HTTPException(status_code=500, detail=f"Job submission failed: {message}")

        # Store job info
        async with _local_jobs_lock:
            _local_jobs[job_id] = {
                "job_id": job_id,
                "hpc_job_id": hpc_job_id,
                "status": LammpsJobState.RUNNING,
                "execution_mode": "hpc",
                "hpc_session_id": request.hpc_session_id,
                "work_dir": work_dir,
                "started_at": datetime.now().isoformat(),
            }

        return LammpsJobStatus(
            job_id=job_id,
            status=LammpsJobState.RUNNING,
            message=f"HPC job submitted: {hpc_job_id}",
        )


@router.get("/status/{job_id}", response_model=LammpsJobStatus)
async def get_lammps_status(job_id: str) -> LammpsJobStatus:
    """Check status of a LAMMPS job."""
    async with _local_jobs_lock:
        job_info = _local_jobs.get(job_id)

    if not job_info:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    status = job_info.get("status", LammpsJobStatus.UNKNOWN)
    message = ""

    # For HPC jobs, check current status
    if job_info.get("execution_mode") == "hpc":
        from catgo.utils.hpc_client import pool

        hpc_session_id = job_info.get("hpc_session_id")
        hpc_job_id = job_info.get("hpc_job_id")

        if hpc_session_id and hpc_job_id:
            hpc = pool.get_connection(hpc_session_id)
            if hpc:
                job_status = await hpc.scheduler.get_job_status(hpc.conn, hpc_job_id)
                if job_status:
                    # Map HPC status to LAMMPS status
                    if job_status.status == JobStatus.COMPLETED:
                        status = LammpsJobState.COMPLETED
                    elif job_status.status == JobStatus.FAILED:
                        status = LammpsJobState.FAILED
                    elif job_status.status == JobStatus.CANCELLED:
                        status = LammpsJobState.CANCELLED
                    elif job_status.status == JobStatus.PENDING:
                        status = LammpsJobState.PENDING
                    else:  # RUNNING
                        status = LammpsJobState.RUNNING

                    # Update stored status
                    async with _local_jobs_lock:
                        _local_jobs[job_id]["status"] = status
                        if status == LammpsJobState.COMPLETED:
                            _local_jobs[job_id]["completed_at"] = datetime.now().isoformat()

    return LammpsJobStatus(
        job_id=job_id,
        status=status,
        message=message,
        started_at=job_info.get("started_at"),
        completed_at=job_info.get("completed_at"),
        exit_code=job_info.get("exit_code"),
    )


@router.get("/results/{job_id}", response_model=LammpsResults)
async def get_lammps_results(job_id: str) -> LammpsResults:
    """Retrieve results from a completed LAMMPS job."""
    async with _local_jobs_lock:
        job_info = _local_jobs.get(job_id)

    if not job_info:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    status = job_info.get("status", LammpsJobState.PENDING)

    # Check if job is complete
    if status not in (LammpsJobState.COMPLETED, LammpsJobState.FAILED):
        return LammpsResults(
            job_id=job_id,
            status=status,
            success=False,
            message="Job not yet completed",
        )

    log_content = None
    trajectory_content = None
    final_data_content = None
    restart_filename = None
    restart_size = None
    thermo_data = []
    error_output = None
    output_files = []

    execution_mode = job_info.get("execution_mode")

    if execution_mode == "local":
        # Get results from local execution
        result = job_info.get("result", {})
        work_dir = result.get("work_dir")

        if work_dir:
            work_dir_path = Path(work_dir)
            log_path = work_dir_path / "lammps.log"
            dump_path = work_dir_path / "system.dump"
            final_data_path = work_dir_path / "final.data"

            if log_path.exists():
                log_content = log_path.read_text()
                thermo_data = parse_lammps_log(log_content)

            if dump_path.exists():
                trajectory_content = dump_path.read_text()

            if final_data_path.exists():
                final_data_content = final_data_path.read_text()

            # Look for any restart file (*.restart or restart.dat)
            restart_files = list(work_dir_path.glob("*.restart")) + ([work_dir_path / "restart.dat"] if (work_dir_path / "restart.dat").exists() else [])
            if restart_files:
                restart_filename = restart_files[0].name
                restart_size = restart_files[0].stat().st_size

            error_output = result.get("stderr")
            output_files = result.get("output_files", [])

    elif execution_mode == "hpc":
        # Get results from HPC
        from catgo.utils.hpc_client import pool
        from catgo.utils.job_parser import read_remote_file

        hpc_session_id = job_info.get("hpc_session_id")
        work_dir = job_info.get("work_dir")

        if hpc_session_id and work_dir:
            hpc = pool.get_connection(hpc_session_id)
            if hpc:
                # Read log file
                log_content_bytes, _ = await read_remote_file(
                    hpc.conn, f"{work_dir}/lammps.log"
                )
                if log_content_bytes:
                    log_content = log_content_bytes
                    thermo_data = parse_lammps_log(log_content)

                # Read dump file
                dump_content_bytes, _ = await read_remote_file(
                    hpc.conn, f"{work_dir}/system.dump"
                )
                if dump_content_bytes:
                    trajectory_content = dump_content_bytes

                # Read final data file
                final_data_bytes, _ = await read_remote_file(
                    hpc.conn, f"{work_dir}/final.data"
                )
                if final_data_bytes:
                    final_data_content = final_data_bytes

                # Check for restart file - try common patterns
                for restart_name in ["system.restart", "restart.dat", "restart"]:
                    try:
                        import os
                        # Check if file exists and get size
                        stdin, stdout, stderr = hpc.conn.exec_command(f"test -f {work_dir}/{restart_name} && wc -c < {work_dir}/{restart_name}")
                        size_str = stdout.read().decode().strip()
                        if size_str and size_str.isdigit():
                            restart_filename = restart_name
                            restart_size = int(size_str)
                            break
                    except Exception:
                        pass

                # Check for error file
                try:
                    error_bytes, _ = await read_remote_file(
                        hpc.conn, f"{work_dir}/{job_id}.err"
                    )
                    error_output = error_bytes if error_bytes else None
                except Exception:
                    pass

    success = (status == LammpsJobState.COMPLETED and
              (error_output is None or "ERROR" not in (error_output or "")))

    return LammpsResults(
        job_id=job_id,
        status=status,
        success=success,
        message="Results retrieved successfully" if success else "Job failed",
        log_file=log_content,
        trajectory_file=trajectory_content,
        final_data_file=final_data_content,
        restart_filename=restart_filename,
        restart_size=restart_size,
        thermo_data=thermo_data,
        error_output=error_output,
        output_files=output_files,
    )


@router.delete("/jobs/{job_id}")
async def cancel_lammps_job(job_id: str) -> dict:
    """Cancel a running LAMMPS job."""
    async with _local_jobs_lock:
        job_info = _local_jobs.get(job_id)

    if not job_info:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    execution_mode = job_info.get("execution_mode")

    if execution_mode == "hpc":
        from catgo.utils.hpc_client import pool

        hpc_session_id = job_info.get("hpc_session_id")
        hpc_job_id = job_info.get("hpc_job_id")

        if hpc_session_id and hpc_job_id:
            hpc = pool.get_connection(hpc_session_id)
            if hpc:
                success, message = await hpc.scheduler.cancel_job(hpc.conn, hpc_job_id)
                if success:
                    async with _local_jobs_lock:
                        _local_jobs[job_id]["status"] = LammpsJobState.CANCELLED
                        _local_jobs[job_id]["completed_at"] = datetime.now().isoformat()
                    return {"job_id": job_id, "cancelled": True, "message": message}
                return {"job_id": job_id, "cancelled": False, "message": message}

    # For local jobs, we can't easily cancel subprocess
    return {"job_id": job_id, "cancelled": False, "message": "Cancellation not supported for local jobs"}


@router.get("/jobs")
async def list_lammps_jobs() -> dict:
    """List all LAMMPS jobs."""
    async with _local_jobs_lock:
        jobs = []
        for job_id, info in _local_jobs.items():
            jobs.append({
                "job_id": job_id,
                "status": info.get("status"),
                "execution_mode": info.get("execution_mode"),
                "started_at": info.get("started_at"),
                "completed_at": info.get("completed_at"),
            })
        return {"jobs": jobs}
