"""HPC connectivity router: SSH connections, job scheduling, file transfer, and profile management."""

import asyncio
import base64
import logging
import mimetypes
import os
import time
import re
import shlex
import uuid

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from catgo.models.hpc import (
    AuthMethod,
    CalcSoftware,
    ConnectionInfo,
    ConnectionStatusResponse,
    ConvergenceData,
    FileListRequest,
    FileListResponse,
    FileUploadResponse,
    HPCConnectionConfig,
    HPCOverview,
    HPCProfile,
    JobCancelResponse,
    JobDetailInfo,
    JobInfo,
    BinaryFileReadResponse,
    FileReadRequest,
    FileReadResponse,
    FileWriteRequest,
    FileWriteResponse,
    FileMkdirRequest,
    FileDeleteRequest,
    FileRenameRequest,
    FileCopyRequest,
    FileMoveRequest,
    FileOpResponse,
    JobFilesResponse,
    JobListResponse,
    JobLogResponse,
    JobResubmitResponse,
    JobStatus,
    JobSubmitRequest,
    JobSubmitResponse,
    SchedulerType,
)
from catgo.utils.hpc_client import pool, load_profiles, save_profile, delete_profile
from catgo.utils.job_parser import detect_calc_type, parse_vasp_convergence, parse_vasp_progress, get_structure_content, tail_remote_file, read_remote_file, write_remote_file, get_xdatcar_content, list_job_files, find_job_script, merge_structures_from_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hpc", tags=["hpc"])


def _configured_work_root(hpc) -> str:
    """Return the configured work-root boundary for a session, if any."""
    root = getattr(getattr(hpc, "config", None), "work_root", None)
    return root.strip() if isinstance(root, str) else ""


# POSIX-sh boundary check. Resolves the work root and every candidate path on
# the remote host in a SINGLE command (one channel open instead of N+1), so the
# guard does not undo the read-many batching win. `canon()` expands a leading
# tilde and canonicalises symlinks: `readlink -f` for existing paths, and
# `readlink -m` for not-yet-created ones (e.g. `mkdir -p a/b/c` where the parent
# chain is missing) so nested creation inside the root is not falsely rejected.
_WORK_ROOT_CHECK_SCRIPT = r"""
H=$HOME
canon() {
  case $1 in
    '~') p=$H ;;
    '~/'*) p=$H/${1#'~/'} ;;
    *) p=$1 ;;
  esac
  if [ -e "$p" ]; then
    readlink -f -- "$p" 2>/dev/null || (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"
  else
    readlink -m -- "$p" 2>/dev/null || printf '%s' "$p"
  fi
}
root=$(canon "$WR_ROOT"); root=${root%/}
if [ -z "$root" ]; then printf 'ERR\n'; exit 0; fi
for raw in "$@"; do
  pa=$(canon "$raw"); pa=${pa%/}
  if [ "$pa" != "$root" ] && [ "${pa#"$root"/}" = "$pa" ]; then
    printf 'DENY:%s\n' "$raw"; exit 0
  fi
done
printf 'OK\n'
"""


async def _ensure_within_work_root(hpc, *paths: str) -> None:
    """Enforce a session work-root boundary for remote file/job operations.

    Resolves the configured ``work_root`` and every candidate path on the remote
    host (following symlinks) and rejects any path that escapes the boundary.

    Threat model: ``work_root`` is an accident-prevention guardrail for a
    session's own operations, NOT a security sandbox against the authenticated
    user -- they already hold a shell on the host and can bypass it with plain
    ssh. The validation and the subsequent file op run as separate SSH commands,
    so a same-user symlink swap between them is technically a TOCTOU window, but
    closing it buys nothing the user could not already do directly. Enforcement
    is therefore intentionally non-atomic.
    """
    from catgo.utils.hpc_client import LocalFileConnection

    root = _configured_work_root(hpc)
    if not root or isinstance(hpc, LocalFileConnection):
        return

    clean_paths = [p.strip() for p in paths if isinstance(p, str) and p.strip()]
    if not clean_paths:
        return

    safe_args = " ".join(shlex.quote(p) for p in clean_paths)
    cmd = (
        f"WR_ROOT={shlex.quote(root)}; "
        f"set -- {safe_args}; "
        f"{_WORK_ROOT_CHECK_SCRIPT}"
    )

    async def _check() -> str:
        result = await hpc.conn.run(cmd, check=False)
        return (result.stdout or "").strip()

    out = await hpc.run_on_owner(_check)
    last = out.splitlines()[-1] if out else ""
    if last == "OK":
        return
    if last == "ERR" or not last:
        raise HTTPException(status_code=400, detail=f"Cannot resolve work root: {root}")
    if last.startswith("DENY:"):
        bad = last[len("DENY:"):]
        raise HTTPException(
            status_code=403,
            detail=f"Path is outside the configured work root ({root}): {bad}",
        )
    raise HTTPException(status_code=400, detail=f"Cannot validate path against work root: {root}")


class FileReadManyRequest(BaseModel):
    session_id: str
    file_paths: list[str]
    max_bytes: int = 65536


class FileReadManyItem(BaseModel):
    file_path: str
    success: bool
    content: str = ""
    total_lines: int = 0
    message: str = ""


class FileReadManyResponse(BaseModel):
    success: bool
    files: list[FileReadManyItem] = []
    message: str = ""


# ====== WebSocket: Interactive SSH Connection ======


@router.websocket("/connect")
async def ws_connect(ws: WebSocket) -> None:
    """
    WebSocket endpoint for interactive SSH connection with OTP support.

    Client sends:
      {action: "connect", config: {host, port, username, password, ...}}
      {action: "otp_response", otp_code: "123456"}
      {action: "disconnect"}

    Server sends:
      {type: "auth_challenge", prompt: "Verification code:"}
      {type: "connected", session_id: "xxx"}
      {type: "error", message: "..."}
      {type: "disconnected"}
    """
    await ws.accept()

    otp_future: asyncio.Future[str] | None = None

    connect_task: asyncio.Task | None = None

    try:
        while True:
            data = await ws.receive_json()
            action = data.get("action")

            if action == "connect":
                config_data = data.get("config", {})
                try:
                    config = HPCConnectionConfig(**config_data)
                except Exception as exc:
                    await ws.send_json({"type": "error", "message": f"Invalid config: {exc}"})
                    continue

                session_id = str(uuid.uuid4())

                async def otp_callback(prompt: str) -> str:
                    nonlocal otp_future
                    # Send OTP challenge to frontend
                    await ws.send_json({"type": "auth_challenge", "prompt": prompt})
                    # Create future and wait (WS loop continues to handle otp_response)
                    otp_future = asyncio.get_event_loop().create_future()
                    code = await asyncio.wait_for(otp_future, timeout=120)
                    return code

                async def do_connect() -> None:
                    """Background task: connect then notify frontend via WS."""
                    try:
                        needs_otp = config.auth_method in (AuthMethod.PASSWORD_OTP, AuthMethod.KEY_OTP)
                        cb = otp_callback if needs_otp else None
                        await pool.connect(config, session_id, otp_callback=cb)
                        await ws.send_json({
                            "type": "connected",
                            "session_id": session_id,
                            "work_root": config.work_root or "",
                            "message": f"Connected to {config.host}",
                        })
                    except asyncio.TimeoutError:
                        await ws.send_json({"type": "error", "message": "OTP timeout (120s)"})
                    except Exception as exc:
                        await ws.send_json({"type": "error", "message": str(exc)})

                # Run connection in background so WS loop can process otp_response
                connect_task = asyncio.create_task(do_connect())

            elif action == "otp_response":
                otp_code = data.get("otp_code", "")
                if otp_future and not otp_future.done():
                    otp_future.set_result(otp_code)
                else:
                    await ws.send_json({"type": "error", "message": "No pending OTP challenge"})

            elif action == "disconnect":
                sid = data.get("session_id", "")
                if sid:
                    await pool.disconnect(sid)
                await ws.send_json({"type": "disconnected", "message": "Disconnected"})
                break

    except WebSocketDisconnect:
        logger.info("HPC WebSocket client disconnected")
    except Exception as exc:
        logger.error(f"HPC WebSocket error: {exc}")
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            logger.debug("Failed to send error to HPC WebSocket client", exc_info=True)
    finally:
        if connect_task and not connect_task.done():
            connect_task.cancel()


@router.post("/connect/ssh-config")
async def connect_ssh_config(config: HPCConnectionConfig) -> dict:
    """Connect using system SSH binary (ControlMaster mode). No WebSocket needed."""
    if config.auth_method != AuthMethod.SSH_CONFIG:
        raise HTTPException(status_code=400, detail="This endpoint requires auth_method='ssh_config'")

    session_id = str(uuid.uuid4())
    try:
        hpc = await pool.connect_ssh_config(config, session_id)
        return {
            "type": "connected",
            "session_id": session_id,
            "message": f"Connected to {hpc.host} via SSH config",
            "host": hpc.host,
            "username": hpc.username,
            "work_root": config.work_root or "",
        }
    except Exception as exc:
        logger.error(f"SSH config connection failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ====== Connection Status ======


@router.get("/status/{session_id}", response_model=ConnectionStatusResponse)
def connection_status(session_id: str) -> ConnectionStatusResponse:
    """Check if an SSH session is still active."""
    hpc = pool.get_connection(session_id)
    if hpc:
        return ConnectionStatusResponse(
            connected=True,
            session_id=session_id,
            host=hpc.host,
            username=hpc.username,
            scheduler=hpc.scheduler_type,
            uptime_seconds=time.time() - hpc.connected_at,
            work_root=_configured_work_root(hpc),
        )
    return ConnectionStatusResponse(connected=False, session_id=session_id)


@router.delete("/disconnect/{session_id}")
async def disconnect(session_id: str) -> dict[str, str]:
    """Disconnect an SSH session."""
    ok = await pool.disconnect(session_id)
    if ok:
        return {"status": "disconnected"}
    raise HTTPException(status_code=404, detail="Session not found")


# ====== Profile Management ======


@router.get("/profiles", response_model=list[HPCProfile])
def list_profiles() -> list[HPCProfile]:
    """List saved HPC connection profiles."""
    return load_profiles()


@router.post("/profiles")
def create_profile(profile: HPCProfile) -> dict[str, str]:
    """Save or update an HPC connection profile (no secrets stored)."""
    save_profile(profile)
    return {"status": "saved", "name": profile.name}


@router.delete("/profiles/{name}")
def remove_profile(name: str) -> dict[str, str]:
    """Delete a saved HPC connection profile."""
    if delete_profile(name):
        return {"status": "deleted", "name": name}
    raise HTTPException(status_code=404, detail=f"Profile '{name}' not found")


# ====== Job Management ======


def _get_hpc(session_id: str):
    """Get connection or raise 404."""
    hpc = pool.get_connection(session_id)
    if not hpc:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    return hpc


@router.post("/submit", response_model=JobSubmitResponse)
async def submit_job(request: JobSubmitRequest) -> JobSubmitResponse:
    """Submit a job to the HPC scheduler."""
    hpc = _get_hpc(request.session_id)
    try:
        work_dir = request.work_dir
        if _configured_work_root(hpc) and work_dir.strip() in ("", "~"):
            work_dir = _configured_work_root(hpc)
        await _ensure_within_work_root(hpc, work_dir)
        success, message, job_id = await hpc.scheduler.submit_job(
            hpc.conn,
            script_content=request.script_content,
            job_name=request.job_name,
            work_dir=work_dir,
            partition=request.partition,
            nodes=request.nodes,
            ntasks=request.ntasks,
            cpus_per_task=request.cpus_per_task,
            time_limit=request.time_limit,
            memory=request.memory,
        )
        return JobSubmitResponse(success=success, message=message, job_id=job_id)
    except Exception as exc:
        logger.error(f"Job submission failed: {exc}")
        return JobSubmitResponse(success=False, message=str(exc))


@router.get("/jobs", response_model=JobListResponse)
async def list_jobs(
    session_id: str = Query(...),
    start_time: str = Query("", description="sacct --starttime value, e.g. 'now-24hours'"),
) -> JobListResponse:
    """List jobs with optional time range filter. Uses squeue + sacct."""
    hpc = _get_hpc(session_id)
    try:
        jobs = await hpc.scheduler.list_jobs(hpc.conn, hpc.username, start_time=start_time)

        # Batch detect calc types for jobs that have work_dir
        work_dirs = [j.work_dir for j in jobs if j.work_dir]
        if _configured_work_root(hpc):
            allowed_dirs: list[str] = []
            for work_dir in set(work_dirs):
                try:
                    await _ensure_within_work_root(hpc, work_dir)
                    allowed_dirs.append(work_dir)
                except HTTPException:
                    continue
            work_dirs = allowed_dirs
        if work_dirs:
            from catgo.utils.job_parser import batch_detect_calc_types
            type_map = await batch_detect_calc_types(hpc.conn, list(set(work_dirs)))
            for j in jobs:
                if j.work_dir and j.work_dir in type_map:
                    sw, ct = type_map[j.work_dir]
                    j.calc_software = sw.value
                    j.calc_type = ct.value

        return JobListResponse(success=True, jobs=jobs)
    except Exception as e:
        return JobListResponse(success=False, message=str(e))


@router.get("/jobs/{job_id}", response_model=JobInfo)
async def get_job(job_id: str, session_id: str = Query(...)) -> JobInfo:
    """Get details of a specific job."""
    hpc = _get_hpc(session_id)
    try:
        info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
        if info:
            return info
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/jobs/{job_id}", response_model=JobCancelResponse)
async def cancel_job(job_id: str, session_id: str = Query(...)) -> JobCancelResponse:
    """Cancel a running or pending job."""
    hpc = _get_hpc(session_id)
    try:
        success, message = await hpc.scheduler.cancel_job(hpc.conn, job_id)
        return JobCancelResponse(success=success, message=message)
    except Exception as exc:
        return JobCancelResponse(success=False, message=str(exc))


@router.get("/jobs/{job_id}/detail", response_model=JobDetailInfo)
async def get_job_detail_endpoint(job_id: str, session_id: str = Query(...)) -> JobDetailInfo:
    """Extended job info with auto-detected calculation type."""
    hpc = _get_hpc(session_id)
    detail = await hpc.scheduler.get_job_detail(hpc.conn, job_id)
    if not detail:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    # Detect calc type if work_dir is available
    if detail.work_dir:
        try:
            await _ensure_within_work_root(hpc, detail.work_dir)
            software, calc_type = await detect_calc_type(hpc.conn, detail.work_dir)
            detail.calc_software = software
            detail.calc_type = calc_type
            # Get progress for running VASP jobs
            if detail.status == JobStatus.RUNNING and software == CalcSoftware.VASP:
                current, total = await parse_vasp_progress(hpc.conn, detail.work_dir)
                detail.current_step = current
                detail.total_steps = total
        except Exception as exc:
            logger.warning(f"Calc type detection failed: {exc}")
    return detail


@router.get("/jobs/{job_id}/convergence", response_model=ConvergenceData)
async def get_convergence(job_id: str, session_id: str = Query(...)) -> ConvergenceData:
    """Parse convergence data (energy/forces per ionic step)."""
    hpc = _get_hpc(session_id)
    detail = await hpc.scheduler.get_job_detail(hpc.conn, job_id)
    if not detail or not detail.work_dir:
        return ConvergenceData(success=False, message="Job or work_dir not found")
    try:
        await _ensure_within_work_root(hpc, detail.work_dir)
        software, _ = await detect_calc_type(hpc.conn, detail.work_dir)
        if software == CalcSoftware.VASP:
            return await parse_vasp_convergence(hpc.conn, detail.work_dir)
        return ConvergenceData(success=False, message=f"Convergence parsing not yet supported for {software.value}")
    except Exception as exc:
        logger.error(f"Convergence parsing failed: {exc}")
        return ConvergenceData(success=False, message=str(exc))


@router.get("/jobs/{job_id}/structure")
async def get_job_structure(job_id: str, session_id: str = Query(...)) -> dict:
    """Read structure file (CONTCAR/POSCAR) from job work_dir."""
    hpc = _get_hpc(session_id)
    detail = await hpc.scheduler.get_job_detail(hpc.conn, job_id)
    if not detail or not detail.work_dir:
        raise HTTPException(status_code=404, detail="Job or work_dir not found")
    try:
        await _ensure_within_work_root(hpc, detail.work_dir)
        software, _ = await detect_calc_type(hpc.conn, detail.work_dir)
        content = await get_structure_content(hpc.conn, detail.work_dir, software)
        if not content:
            raise HTTPException(status_code=404, detail="No structure file found in work_dir")
        fmt_map = {CalcSoftware.VASP: "poscar", CalcSoftware.CP2K: "cp2k"}
        fmt = fmt_map.get(software, "unknown")
        return {"content": content, "format": fmt}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/jobs/{job_id}/log", response_model=JobLogResponse)
async def get_job_log(
    job_id: str,
    session_id: str = Query(...),
    file: str = Query("stdout"),
    lines: int = Query(100, ge=10, le=5000),
) -> JobLogResponse:
    """Tail job stdout/stderr output file."""
    hpc = _get_hpc(session_id)
    detail = await hpc.scheduler.get_job_detail(hpc.conn, job_id)
    if not detail:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    path = detail.stdout_path if file == "stdout" else detail.stderr_path
    if not path:
        return JobLogResponse(success=False, message=f"No {file} path found for job {job_id}")
    try:
        await _ensure_within_work_root(hpc, path)
        content, total = await tail_remote_file(hpc.conn, path, lines)
        return JobLogResponse(success=True, content=content, file_path=path, total_lines=total)
    except Exception as exc:
        return JobLogResponse(success=False, message=str(exc))


@router.post("/files/read-content", response_model=FileReadResponse)
async def read_file_content(request: FileReadRequest) -> FileReadResponse:
    """Read full content of a remote file (no size limit)."""
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = _get_hpc(request.session_id)
    try:
        await _ensure_within_work_root(hpc, request.file_path)
        # max_bytes: explicit request value, or None (use default limit)
        max_bytes = request.max_bytes
        if isinstance(hpc, LocalFileConnection):
            kwargs = {"max_bytes": max_bytes} if max_bytes is not None and max_bytes > 0 else {}
            content, total = await hpc.read_file_content(request.file_path, **kwargs)
        else:
            content, total = await hpc.run_on_owner(
                lambda: read_remote_file(hpc.conn, request.file_path, max_bytes=max_bytes or 0)
            )
        return FileReadResponse(success=True, content=content, total_lines=total)
    except Exception as e:
        return FileReadResponse(success=False, message=str(e))


@router.post("/files/read-many", response_model=FileReadManyResponse)
async def read_many_file_content(request: FileReadManyRequest) -> FileReadManyResponse:
    """Read several small remote text files in one SSH command for UI prefetch."""
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = _get_hpc(request.session_id)
    paths = [p for p in request.file_paths if p][:16]
    if not paths:
        return FileReadManyResponse(success=True, files=[])

    max_bytes = max(1, min(request.max_bytes, 256 * 1024))
    try:
        await _ensure_within_work_root(hpc, *paths)
        if isinstance(hpc, LocalFileConnection):
            items: list[FileReadManyItem] = []
            for path in paths:
                try:
                    content, total = await hpc.read_file_content(path, max_bytes=max_bytes)
                    items.append(FileReadManyItem(
                        file_path=path,
                        success=True,
                        content=content,
                        total_lines=total,
                    ))
                except Exception as exc:
                    items.append(FileReadManyItem(file_path=path, success=False, message=str(exc)))
            return FileReadManyResponse(success=True, files=items)

        marker = f"__CATGO_READ_MANY_{uuid.uuid4().hex}__"

        async def _read_many_remote() -> str:
            parts: list[str] = []
            for idx, path in enumerate(paths):
                safe = shlex.quote(path)
                parts.append(
                    "printf '\\n{m}_BEGIN_{i}\\n'; "
                    "if [ -f {p} ]; then "
                    "wc -l < {p}; "
                    "printf '\\n{m}_CONTENT_{i}\\n'; "
                    "head -c {n} {p}; "
                    "printf '\\n{m}_END_{i}\\n'; "
                    "else "
                    "printf '0\\n{m}_CONTENT_{i}\\n\\n{m}_END_{i}\\n'; "
                    "fi".format(m=marker, i=idx, p=safe, n=max_bytes)
                )
            result = await hpc.conn.run(" ; ".join(parts), check=False)
            if result.exit_status not in (0, None):
                raise RuntimeError(result.stderr or f"read-many failed ({result.exit_status})")
            return result.stdout or ""

        raw = await hpc.run_on_owner(_read_many_remote)
        items = []
        for idx, path in enumerate(paths):
            begin = f"{marker}_BEGIN_{idx}\n"
            content_marker = f"\n{marker}_CONTENT_{idx}\n"
            end = f"\n{marker}_END_{idx}"
            _, found_begin, rest = raw.partition(begin)
            if not found_begin:
                items.append(FileReadManyItem(file_path=path, success=False, message="Missing response block"))
                continue
            header, found_content, after_content = rest.partition(content_marker)
            content, found_end, _ = after_content.partition(end)
            if not found_content or not found_end:
                items.append(FileReadManyItem(file_path=path, success=False, message="Incomplete response block"))
                continue
            try:
                total_lines = int(header.strip().splitlines()[-1])
            except Exception:
                total_lines = 0
            items.append(FileReadManyItem(
                file_path=path,
                success=True,
                content=content,
                total_lines=total_lines,
            ))
        return FileReadManyResponse(success=True, files=items)
    except Exception as exc:
        return FileReadManyResponse(success=False, message=str(exc))


@router.post("/files/read-binary", response_model=BinaryFileReadResponse)
async def read_binary_file_content(request: FileReadRequest) -> BinaryFileReadResponse:
    """Read a binary file from the remote system (no size limit)."""
    hpc = _get_hpc(request.session_id)
    try:
        await _ensure_within_work_root(hpc, request.file_path)
        chunks: list[bytes] = []
        async for chunk in hpc.stream_on_owner(lambda: hpc.download_remote_file(request.file_path)):
            chunks.append(chunk)
        raw = b"".join(chunks)
        mime_type, _ = mimetypes.guess_type(request.file_path)
        return BinaryFileReadResponse(
            success=True,
            data=base64.b64encode(raw).decode("ascii"),
            mime_type=mime_type or "application/octet-stream",
            size=len(raw),
        )
    except Exception as e:
        return BinaryFileReadResponse(success=False, message=str(e))


@router.post("/files/write-content", response_model=FileWriteResponse)
async def write_file_content(request: FileWriteRequest) -> FileWriteResponse:
    """Write content to a remote file."""
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = _get_hpc(request.session_id)
    try:
        await _ensure_within_work_root(hpc, request.file_path)
        if isinstance(hpc, LocalFileConnection):
            p = hpc._resolve_local_path(request.file_path)
            p.write_text(request.content, encoding="utf-8")
            ok = True
        else:
            ok = await hpc.run_on_owner(lambda: write_remote_file(hpc.conn, request.file_path, request.content))
        return FileWriteResponse(
            success=ok, message="File saved" if ok else "Write failed"
        )
    except Exception as e:
        return FileWriteResponse(success=False, message=str(e))


@router.get("/jobs/{job_id}/trajectory")
async def get_job_trajectory(
    job_id: str, session_id: str = Query(...)
) -> dict:
    """Fetch XDATCAR trajectory content from a VASP job."""
    hpc = _get_hpc(session_id)
    detail = await hpc.scheduler.get_job_detail(hpc.conn, job_id)
    if not detail or not detail.work_dir:
        raise HTTPException(status_code=404, detail="Job or work_dir not found")
    await _ensure_within_work_root(hpc, detail.work_dir)
    content = await get_xdatcar_content(hpc.conn, detail.work_dir)
    if not content:
        raise HTTPException(status_code=404, detail="XDATCAR not found in work directory")
    return {"content": content, "format": "xdatcar"}


@router.get("/jobs/{job_id}/files", response_model=JobFilesResponse)
async def get_job_files(
    job_id: str, session_id: str = Query(...)
) -> JobFilesResponse:
    """List editable input files in job's work directory."""
    hpc = _get_hpc(session_id)
    detail = await hpc.scheduler.get_job_detail(hpc.conn, job_id)
    if not detail or not detail.work_dir:
        return JobFilesResponse(success=False, message="No work_dir found for job")
    await _ensure_within_work_root(hpc, detail.work_dir)
    software, _ = await detect_calc_type(hpc.conn, detail.work_dir)
    files = await list_job_files(hpc.conn, detail.work_dir, software)
    return JobFilesResponse(success=True, files=files, work_dir=detail.work_dir)


@router.post("/jobs/{job_id}/resubmit", response_model=JobResubmitResponse)
async def resubmit_job_endpoint(
    job_id: str, session_id: str = Query(...)
) -> JobResubmitResponse:
    """Resubmit a job by re-running sbatch on the existing script."""
    hpc = _get_hpc(session_id)
    detail = await hpc.scheduler.get_job_detail(hpc.conn, job_id)
    if not detail or not detail.work_dir:
        raise HTTPException(status_code=404, detail="Job or work_dir not found")
    await _ensure_within_work_root(hpc, detail.work_dir)
    script = await find_job_script(hpc.conn, detail.work_dir)
    if not script:
        raise HTTPException(
            status_code=404, detail="No job script (.sh/.slurm) found in work directory"
        )
    safe_dir = shlex.quote(detail.work_dir)
    safe_script = shlex.quote(script)
    result = await hpc.run_on_owner(
        lambda: hpc.conn.run(f"cd {safe_dir} && sbatch {safe_script}", check=False)
    )
    if result.exit_status != 0:
        return JobResubmitResponse(
            success=False, message=(result.stderr or "").strip() or "sbatch failed"
        )
    match = re.search(r"(\d+)", result.stdout or "")
    new_id = match.group(1) if match else ""
    return JobResubmitResponse(
        success=True,
        message=(result.stdout or "").strip(),
        new_job_id=new_id,
    )


# ====== Job Monitor WebSocket ======


@router.websocket("/monitor")
async def ws_monitor(ws: WebSocket) -> None:
    """
    WebSocket for real-time job monitoring with exponential backoff polling.

    Client sends:
      {action: "watch", session_id: "...", job_ids: ["123", "456"]}
      {action: "stop"}

    Server sends:
      {type: "job_update", jobs: [...]}
      {type: "error", message: "..."}
    """
    await ws.accept()

    try:
        data = await ws.receive_json()
        if data.get("action") != "watch":
            await ws.send_json({"type": "error", "message": "Expected action: watch"})
            return

        session_id = data.get("session_id", "")
        job_ids: list[str] = data.get("job_ids", [])

        hpc = pool.get_connection(session_id)
        if not hpc:
            await ws.send_json({"type": "error", "message": "Session not found"})
            return

        poll_interval = 5.0  # Start at 5 seconds
        max_interval = 60.0

        while True:
            # Check for stop message (non-blocking)
            try:
                msg = await asyncio.wait_for(ws.receive_json(), timeout=0.1)
                if msg.get("action") == "stop":
                    break
            except asyncio.TimeoutError:
                pass

            # Poll job statuses
            jobs: list[dict] = []
            for jid in job_ids:
                info = await hpc.scheduler.get_job_status(hpc.conn, jid)
                if info:
                    jobs.append(info.model_dump())

            await ws.send_json({"type": "job_update", "jobs": jobs})

            # Check if all jobs are terminal
            terminal = {"COMPLETED", "FAILED", "CANCELLED"}
            all_done = all(
                j.get("status") in terminal for j in jobs
            ) if jobs else False

            if all_done:
                break

            await asyncio.sleep(poll_interval)
            poll_interval = min(poll_interval * 1.5, max_interval)

    except WebSocketDisconnect:
        pass  # Normal: client closed the connection
    except Exception as exc:
        logger.debug("Job monitor WebSocket closed with error: %s", exc)
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass  # Socket already closed, nothing to do


# ====== File Operations (SFTP) ======


@router.post("/files/list", response_model=FileListResponse)
async def list_files(request: FileListRequest) -> FileListResponse:
    """List files in a remote directory."""
    hpc = _get_hpc(request.session_id)
    try:
        target_path = request.path
        if _configured_work_root(hpc) and target_path.strip() in ("", "~"):
            target_path = _configured_work_root(hpc)
        await _ensure_within_work_root(hpc, target_path)
        resolved, files = await asyncio.wait_for(
            hpc.run_on_owner(lambda: hpc.list_remote_dir(target_path)),
            timeout=30.0,
        )
        return FileListResponse(success=True, files=files, current_path=resolved)
    except asyncio.TimeoutError as exc:
        logger.error(f"File listing timed out: {request.path}")
        message = str(exc) or f"Listing timed out for {request.path}"
        return FileListResponse(
            success=False,
            message=message,
        )
    except Exception as exc:
        logger.error(f"File listing failed: {exc}")
        return FileListResponse(success=False, message=str(exc))


@router.post("/upload", response_model=FileUploadResponse)
async def upload_file(
    session_id: str = Form(...),
    remote_path: str = Form(...),
    file: UploadFile = File(...),
) -> FileUploadResponse:
    """Upload a file to the remote host."""
    hpc = _get_hpc(session_id)
    try:
        content = await file.read()
        target = remote_path
        if file.filename and not target.endswith(file.filename or ""):
            target = f"{target}/{file.filename}"
        await _ensure_within_work_root(hpc, target)
        final_path = await hpc.run_on_owner(lambda: hpc.upload_remote_file(content, target))
        return FileUploadResponse(
            success=True,
            message=f"Uploaded {file.filename}",
            remote_path=final_path,
        )
    except Exception as exc:
        logger.error(f"Upload failed: {exc}")
        return FileUploadResponse(success=False, message=str(exc))


@router.get("/resolve-file")
async def resolve_file(
    session_id: str = Query(...),
    remote_path: str = Query(...),
    targets: str = Query("", description="Comma-separated target filenames, e.g. 'vaspout.h5,vasprun.xml'"),
) -> dict:
    """Resolve a remote path: if it's a directory, find a matching target file inside.

    Returns {"resolved_path": str, "is_dir": bool, "found": bool}.
    """
    hpc = _get_hpc(session_id)
    path = remote_path.strip()
    await _ensure_within_work_root(hpc, path)
    target_list = [t.strip() for t in targets.split(",") if t.strip()] if targets else []

    # Use stat to determine if path is a file or directory
    stat_result = await hpc.conn.run(
        f"stat -c '%F' {shlex.quote(path)} 2>/dev/null", check=False
    )
    file_type = (stat_result.stdout or "").strip().lower() if stat_result.exit_status == 0 else ""

    if "directory" not in file_type:
        # It's a regular file (or doesn't exist) — return as-is
        return {"resolved_path": path, "is_dir": False, "found": True}

    # It's a directory — search for target files
    try:
        resolved, files = await hpc.list_remote_dir(path)
    except Exception as exc:
        return {"resolved_path": path, "is_dir": True, "found": False,
                "error": f"Failed to list directory: {exc}"}

    if target_list:
        for target_name in target_list:
            for f in files:
                if f.name == target_name and not f.is_dir:
                    return {"resolved_path": f"{resolved}/{f.name}", "is_dir": True, "found": True}
        # No exact match — try extension matching
        target_exts = {t.rsplit(".", 1)[-1].lower() for t in target_list if "." in t}
        if target_exts:
            for f in files:
                if not f.is_dir and "." in f.name:
                    ext = f.name.rsplit(".", 1)[-1].lower()
                    if ext in target_exts:
                        return {"resolved_path": f"{resolved}/{f.name}", "is_dir": True, "found": True}
    return {"resolved_path": resolved, "is_dir": True, "found": False,
            "files": [f.name for f in files if not f.is_dir][:20]}


@router.get("/download")
async def download_file(
    session_id: str = Query(...),
    remote_path: str = Query(...),
    is_dir: bool | None = Query(None),
    skip_stat: bool = Query(False),
) -> StreamingResponse:
    """Download a file, or archive a directory before downloading it."""
    hpc = _get_hpc(session_id)
    try:
        await _ensure_within_work_root(hpc, remote_path)
        if is_dir is None:
            is_dir = await hpc.run_on_owner(lambda: hpc.is_remote_dir(remote_path))
        if is_dir:
            stem = re.split(r"[/\\]+", remote_path.rstrip("/\\"))[-1] or "archive"
            filename = f"{stem}.tar.gz"
            return StreamingResponse(
                hpc.stream_on_owner(lambda: hpc.download_remote_archive(remote_path)),
                media_type="application/gzip",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}"',
                },
            )

        filename = remote_path.rsplit("/", 1)[-1]
        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
        }
        if not skip_stat:
            file_size = await hpc.run_on_owner(lambda: hpc.get_remote_file_size(remote_path))
            # Only advertise Content-Length when the stat actually succeeded.
            # A failed stat returns 0 (SFTP fallback); sending "Content-Length: 0"
            # while the body streams real bytes makes clients truncate the file.
            if file_size > 0:
                headers["Content-Length"] = str(file_size)
        return StreamingResponse(
            hpc.stream_on_owner(lambda: hpc.download_remote_file(remote_path)),
            media_type="application/octet-stream",
            headers=headers,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/materialize_trajectory")
async def materialize_trajectory(
    session_id: str = Query(...),
    remote_path: str = Query(...),
) -> dict:
    """Pull a large remote trajectory to a local cache file, then index it.

    A 100s-of-MB remote XYZ can't be slurped into the webview (it freezes) and
    per-frame SFTP is too chatty over WAN. Instead we transfer the file ONCE,
    gzip-compressed on the wire (``download_remote_file`` already inflates text
    via ``gzip -c`` remotely), write the inflated bytes to a backend-local cache
    file, and index it. The frontend then streams frames from that local file
    through the existing ``/trajectory/{frames,metadata}`` endpoints — the
    webview only ever holds the current frames. Cached by (session, path, size)
    so re-opening is instant.
    """
    import hashlib
    from pathlib import Path

    hpc = _get_hpc(session_id)
    await _ensure_within_work_root(hpc, remote_path)
    size = await hpc.run_on_owner(lambda: hpc.get_remote_file_size(remote_path))

    key = hashlib.sha1(f"{session_id}\0{remote_path}\0{size}".encode()).hexdigest()[:16]
    ext = os.path.splitext(remote_path)[1] or ".xyz"
    cache_dir = Path.home() / ".catgoat" / "cache" / "traj"
    cache_dir.mkdir(parents=True, exist_ok=True)
    local = cache_dir / f"{key}{ext}"

    if not (local.is_file() and local.stat().st_size > 0):
        tmp = local.with_name(local.name + ".part")
        written = 0
        try:
            with tmp.open("wb") as fh:
                async for chunk in hpc.stream_on_owner(
                    lambda: hpc.download_remote_file(remote_path)
                ):
                    fh.write(chunk)
                    written += len(chunk)
            tmp.replace(local)
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"materialize failed: {exc}") from exc
        logger.info(
            "Materialized remote trajectory %s -> %s (%d bytes)", remote_path, local, written
        )

    from .trajectory_stream import _get_index

    try:
        _, idx = _get_index(str(local))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"index failed: {exc}") from exc

    return {
        "ok": True,
        "local_path": str(local),
        "total_frames": idx.total_frames,
        "n_atoms": idx.n_atoms,
        "file_size": idx.file_size,
    }


# ====== Connections Listing + Overview ======


@router.get("/connections", response_model=list[ConnectionInfo])
def list_connections() -> list[ConnectionInfo]:
    """List all active HPC connections."""
    return pool.list_connections()


@router.get("/overview/{session_id}", response_model=HPCOverview)
async def get_overview(session_id: str) -> HPCOverview:
    """Get overview data (job summary, disk usage, system info) for a connection."""
    hpc = _get_hpc(session_id)
    try:
        return await hpc.get_overview()
    except Exception as exc:
        logger.error(f"Overview fetch failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ====== Merge Structures from Directory ======


class MergeRequest(BaseModel):
    session_id: str
    dir_path: str
    pattern: str = "CONTCAR"


@router.post("/files/merge-structures")
async def merge_structures(request: MergeRequest):
    """Merge CONTCAR/POSCAR files from subdirectories into a trajectory."""
    hpc = _get_hpc(request.session_id)
    try:
        await _ensure_within_work_root(hpc, request.dir_path)
        ok, content, paths = await merge_structures_from_dir(
            hpc.conn, request.dir_path, request.pattern
        )
        return {
            "success": ok,
            "content": content,
            "files": paths,
            "count": len(paths),
        }
    except Exception as exc:
        logger.error(f"Merge structures failed: {exc}")
        return {"success": False, "content": "", "files": [], "count": 0, "error": str(exc)}


# ====== Remote CatGO Install ======


class InstallStatusResponse(BaseModel):
    installed: bool
    has_conda: bool
    has_env: bool
    has_server: bool
    has_frontend: bool
    accounts: list[str]
    catgo_dir: str
    conda_path: str = ""
    conda_activate: str = ""


@router.get("/install/status")
async def check_install_status(session_id: str = Query(...)) -> InstallStatusResponse:
    """Check if CatGO is already installed on the remote HPC system."""
    hpc_conn = pool.get_connection(session_id)
    if not hpc_conn:
        raise HTTPException(status_code=404, detail="Session not found")

    conn = hpc_conn.conn  # The actual SSH runner (asyncssh or SubprocessSSHRunner)
    catgo_dir = "~/catgo"

    # Run a single combined command to avoid parallel subprocess issues
    try:
        result = await conn.run(
            "echo \"CONDA:$(ls ~/miniforge3/bin/conda ~/miniforge3/condabin/conda ~/miniconda3/bin/conda ~/miniconda3/condabin/conda ~/anaconda3/bin/conda ~/anaconda3/condabin/conda 2>/dev/null | head -1)\";"
            f"echo \"SERVER:$(test -f {catgo_dir}/server/main.py && echo yes || echo no)\";"
            f"echo \"FRONTEND:$(test -f {catgo_dir}/frontend/index.html && echo yes || echo no)\";"
            "echo \"ACCOUNTS:$(sacctmgr show associations user=$USER format=account%30 --noheader --parsable 2>/dev/null | sort -u | tr '\\n' ',')\";"
            "echo \"ENV:$(conda env list 2>/dev/null | grep '^catgo ' || echo '')\""
        )
        stdout = result.stdout if hasattr(result, 'stdout') else str(result)
    except Exception as e:
        logger.error(f"Install status check failed: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to check remote system: {e}")

    # Parse the combined output
    lines = {line.split(":", 1)[0]: line.split(":", 1)[1].strip()
             for line in stdout.strip().split("\n")
             if ":" in line}

    conda_bin = lines.get("CONDA", "").strip()
    has_conda = bool(conda_bin)
    has_server = lines.get("SERVER", "") == "yes"
    has_frontend = lines.get("FRONTEND", "") == "yes"
    accounts_raw = lines.get("ACCOUNTS", "")
    accounts = [a.strip() for a in accounts_raw.split(",") if a.strip()]
    has_env = bool(lines.get("ENV", ""))

    # Build ready-to-use conda activation command from detected path
    conda_path = ""
    conda_activate = ""
    if conda_bin:
        # conda_bin is e.g. /home/user/miniforge3/bin/conda
        # We need the base dir: /home/user/miniforge3
        import os
        conda_base = os.path.dirname(os.path.dirname(conda_bin))
        conda_path = conda_base
        conda_activate = f"source {conda_base}/etc/profile.d/conda.sh\nconda activate catgo"

    return InstallStatusResponse(
        installed=has_server and has_frontend and has_env,
        has_conda=has_conda,
        has_env=has_env,
        has_server=has_server,
        has_frontend=has_frontend,
        accounts=accounts,
        catgo_dir=catgo_dir,
        conda_path=conda_path,
        conda_activate=conda_activate,
    )


class InstallRequest(BaseModel):
    session_id: str
    account: str = ""


class InstallResponse(BaseModel):
    success: bool
    log: list[str] = []
    error: str = ""


@router.post("/install/run")
async def run_install(req: InstallRequest) -> InstallResponse:
    """Run the CatGO installer on a connected HPC system.

    This may take 10-20 minutes. Returns the full install log on completion.
    """
    hpc_conn = pool.get_connection(req.session_id)
    if not hpc_conn:
        raise HTTPException(status_code=404, detail="SSH session not found")

    conn = hpc_conn.conn  # The actual SSH runner
    log: list[str] = []

    try:
        log.append("Uploading installer script...")

        # Read the install script from the repo's deploy directory
        # __file__ is server/routers/hpc.py → go up 2 levels to repo root
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        script_path = os.path.join(repo_root, "deploy", "hpc", "install-catgo.sh")

        # If the bundled script isn't available, download it on remote
        if not os.path.isfile(script_path):
            log.append("Downloading installer from GitHub...")
            result = await conn.run(
                "curl -fsSL https://raw.githubusercontent.com/Hello-QM/catgo-LRG/dev/deploy/hpc/install-catgo.sh -o /tmp/install-catgo.sh"
            )
            if getattr(result, 'exit_status', 1) != 0:
                return InstallResponse(success=False, log=log, error="Failed to download installer")
        else:
            # Upload the local script to remote
            script_content = open(script_path).read()
            await conn.run(f"cat > /tmp/install-catgo.sh << 'INSTALLER_EOF'\n{script_content}\nINSTALLER_EOF")

        log.append("Starting installation (this may take 10-20 minutes)...")

        # Run the installer. If account is provided, pipe it as input for the account prompt.
        install_cmd = "bash /tmp/install-catgo.sh"
        if req.account:
            install_cmd = f"echo '{shlex.quote(req.account)}' | bash /tmp/install-catgo.sh"

        result = await conn.run(install_cmd)
        stdout = getattr(result, 'stdout', '')
        stderr = getattr(result, 'stderr', '')

        # Collect output lines
        for line in stdout.split('\n'):
            line = line.strip()
            if line:
                log.append(line)

        if getattr(result, 'exit_status', 1) != 0:
            error_msg = stderr.strip() if stderr.strip() else "Installation failed"
            return InstallResponse(success=False, log=log, error=error_msg)

        return InstallResponse(success=True, log=log)

    except Exception as e:
        logger.exception("Install error")
        return InstallResponse(success=False, log=log, error=str(e))


@router.get("/install/stream")
def stream_install(
    session_id: str = Query(...),
    account: str = Query(""),
) -> StreamingResponse:
    """Stream the CatGO installer output line-by-line via SSE."""
    import asyncssh

    hpc_conn = pool.get_connection(session_id)
    if not hpc_conn:
        raise HTTPException(status_code=404, detail="SSH session not found")

    conn = hpc_conn.conn

    async def _event_stream():
        def sse(data: str, event: str = "log") -> str:
            return f"event: {event}\ndata: {data}\n\n"

        try:
            # --- Upload script ---
            yield sse("Uploading installer script...")
            repo_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            script_path = os.path.join(repo_root, "deploy", "hpc", "install-catgo.sh")

            if not os.path.isfile(script_path):
                yield sse("Install script not found on server", "error")
                return

            with open(script_path) as f:
                script_content = f.read()
            await conn.run(
                f"cat > /tmp/install-catgo.sh << 'INSTALLER_EOF'\n{script_content}\nINSTALLER_EOF"
            )
            yield sse("Script uploaded. Starting installation...")

            # --- Build command ---
            install_cmd = "bash /tmp/install-catgo.sh"
            if account:
                install_cmd = f"echo {shlex.quote(account)} | bash /tmp/install-catgo.sh"

            # --- Stream output ---
            if isinstance(conn, asyncssh.SSHClientConnection):
                # asyncssh: use create_process for streaming
                process = await conn.create_process(
                    install_cmd, stderr=asyncssh.STDOUT
                )
                try:
                    async for line in process.stdout:
                        stripped = line.rstrip("\n\r")
                        if stripped:
                            yield sse(stripped)
                finally:
                    process.close()
                    await process.wait_closed()
                exit_status = process.exit_status
            else:
                # SubprocessSSHRunner: launch subprocess for streaming
                login_cmd = f"bash -l -c {shlex.quote(install_cmd)}"
                ssh_alias = getattr(conn, "ssh_alias", None)
                if ssh_alias:
                    proc = await asyncio.create_subprocess_exec(
                        # BatchMode=yes: ControlMaster mode — master socket must
                        # already exist; never fall back to interactive askpass.
                        "ssh", "-o", "BatchMode=yes", ssh_alias, login_cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                    )
                else:
                    proc = await asyncio.create_subprocess_shell(
                        install_cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                    )
                assert proc.stdout is not None
                async for raw_line in proc.stdout:
                    stripped = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                    if stripped:
                        yield sse(stripped)
                await proc.wait()
                exit_status = proc.returncode

            if exit_status and exit_status != 0:
                yield sse(f"Installation exited with code {exit_status}", "error")
            else:
                yield sse("done", "done")

        except Exception as e:
            logger.exception("Install stream error")
            yield sse(str(e), "error")

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ====== CatGO Remote Launch ======


class CatgoLaunchRequest(BaseModel):
    session_id: str
    port: int = 8000


class CatgoLaunchResponse(BaseModel):
    success: bool
    message: str
    job_id: str = ""
    catgo_dir: str = ""


class CatgoTunnelRequest(BaseModel):
    session_id: str
    job_id: str
    remote_port: int = 8000
    local_port: int = 8000


class CatgoTunnelResponse(BaseModel):
    success: bool
    message: str
    local_port: int = 0
    remote_node: str = ""


class CatgoStatusResponse(BaseModel):
    state: str = "idle"  # idle | pending | running | ready | failed
    job_id: str = ""
    node: str = ""
    local_port: int = 0
    message: str = ""


@router.post("/catgo/launch", response_model=CatgoLaunchResponse)
async def catgo_launch(req: CatgoLaunchRequest) -> CatgoLaunchResponse:
    """Submit the CatGO job script on the remote HPC system."""
    hpc = _get_hpc(req.session_id)
    catgo_dir = "~/catgo"

    try:
        # Resolve tilde
        from catgo.utils.hpc_client import resolve_tilde
        resolved_dir = await resolve_tilde(hpc.conn, catgo_dir)

        # Verify job script exists
        check = await hpc.conn.run(
            f"test -f {shlex.quote(resolved_dir)}/catgo-job.sh && echo exists",
            check=False,
        )
        if "exists" not in (check.stdout or ""):
            return CatgoLaunchResponse(
                success=False,
                message="catgo-job.sh not found. Run install-catgo.sh first.",
            )

        # Submit via sbatch with optional port override
        env_prefix = f"CATGO_PORT={req.port} " if req.port != 8000 else ""
        submit_cmd = f"cd {shlex.quote(resolved_dir)} && {env_prefix}sbatch catgo-job.sh"
        result = await hpc.conn.run(submit_cmd, check=False)

        if result.exit_status != 0:
            return CatgoLaunchResponse(
                success=False,
                message=f"sbatch failed: {(result.stderr or '').strip()}",
            )

        # Parse job ID
        stdout = (result.stdout or "").strip()
        job_id = ""
        for word in stdout.split():
            if word.isdigit():
                job_id = word
                break

        if not job_id:
            return CatgoLaunchResponse(
                success=False,
                message=f"Could not parse job ID from: {stdout}",
            )

        hpc.catgo_job_id = job_id
        return CatgoLaunchResponse(
            success=True,
            message=f"Job submitted: {job_id}",
            job_id=job_id,
            catgo_dir=resolved_dir,
        )

    except Exception as exc:
        logger.error(f"CatGO launch failed: {exc}")
        return CatgoLaunchResponse(success=False, message=str(exc))


@router.post("/catgo/tunnel", response_model=CatgoTunnelResponse)
async def catgo_tunnel(req: CatgoTunnelRequest) -> CatgoTunnelResponse:
    """Set up an SSH tunnel to the CatGO compute node."""
    hpc = _get_hpc(req.session_id)

    try:
        # Get job detail to extract node name
        detail = await hpc.scheduler.get_job_detail(hpc.conn, req.job_id)
        if not detail:
            return CatgoTunnelResponse(
                success=False, message=f"Job {req.job_id} not found"
            )

        if detail.status != JobStatus.RUNNING:
            return CatgoTunnelResponse(
                success=False,
                message=f"Job is not running (state: {detail.status.value})",
            )

        node = detail.node_list
        if not node:
            return CatgoTunnelResponse(
                success=False, message="Could not determine compute node"
            )
        # node_list may be a range like "exp-1-23,exp-1-24"; take the first
        node = node.split(",")[0].split("[")[0].strip()

        actual_port = await hpc.setup_tunnel(node, req.remote_port, req.local_port)

        return CatgoTunnelResponse(
            success=True,
            message=f"Tunnel ready: localhost:{actual_port} -> {node}:{req.remote_port}",
            local_port=actual_port,
            remote_node=node,
        )

    except Exception as exc:
        logger.error(f"CatGO tunnel setup failed: {exc}")
        return CatgoTunnelResponse(success=False, message=str(exc))


@router.delete("/catgo/tunnel")
async def catgo_tunnel_teardown(session_id: str = Query(...)) -> dict:
    """Tear down the CatGO SSH tunnel."""
    hpc = _get_hpc(session_id)
    try:
        await hpc.teardown_tunnel()
        return {"success": True, "message": "Tunnel closed"}
    except Exception as exc:
        logger.error(f"Tunnel teardown failed: {exc}")
        return {"success": False, "message": str(exc)}


@router.get("/catgo/status", response_model=CatgoStatusResponse)
async def catgo_status(session_id: str = Query(...)) -> CatgoStatusResponse:
    """Get current CatGO launch state for a session."""
    hpc = _get_hpc(session_id)

    job_id = hpc.catgo_job_id or ""
    node = hpc.catgo_tunnel_node or ""
    local_port = hpc.catgo_tunnel_local_port or 0

    if not job_id:
        return CatgoStatusResponse(state="idle")

    # Check tunnel first
    if local_port:
        return CatgoStatusResponse(
            state="ready",
            job_id=job_id,
            node=node,
            local_port=local_port,
            message=f"CatGO ready at localhost:{local_port}",
        )

    # Check job status
    try:
        info = await hpc.scheduler.get_job_status(hpc.conn, job_id)
        if not info:
            return CatgoStatusResponse(
                state="failed", job_id=job_id, message="Job not found"
            )

        if info.status == JobStatus.RUNNING:
            return CatgoStatusResponse(
                state="running", job_id=job_id, message="Job is running"
            )
        elif info.status == JobStatus.PENDING:
            return CatgoStatusResponse(
                state="pending",
                job_id=job_id,
                message=info.reason or "Waiting for allocation",
            )
        elif info.status in (
            JobStatus.FAILED, JobStatus.CANCELLED, JobStatus.COMPLETED
        ):
            return CatgoStatusResponse(
                state="failed",
                job_id=job_id,
                message=f"Job {info.status.value}",
            )
        return CatgoStatusResponse(
            state="pending", job_id=job_id, message=f"State: {info.status.value}"
        )
    except Exception as exc:
        return CatgoStatusResponse(
            state="failed", job_id=job_id, message=str(exc)
        )


# ====== Remote File Operations ======


def _validate_path_safety(path: str) -> None:
    """Reject dangerous paths (root, home dir, system dirs)."""
    stripped = path.rstrip("/")
    if stripped in ("", "/", "~"):
        raise HTTPException(status_code=400, detail=f"Refusing to operate on path: {path}")
    # Count depth: /home/user/something = depth 3
    parts = [p for p in stripped.split("/") if p]
    if len(parts) < 2:
        raise HTTPException(status_code=400, detail=f"Path too shallow (safety check): {path}")


@router.post("/files/mkdir", response_model=FileOpResponse)
async def api_files_mkdir(req: FileMkdirRequest):
    """Create a directory on the remote system."""
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = pool.get_connection(req.session_id)
    if not hpc:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await _ensure_within_work_root(hpc, req.path)
        if isinstance(hpc, LocalFileConnection):
            await hpc.mkdir_local(req.path)
        else:
            safe_path = shlex.quote(req.path)
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"mkdir -p {safe_path}"))
            if result.exit_status != 0:
                return FileOpResponse(success=False, message=result.stderr.strip())
        return FileOpResponse(success=True, message=f"Created {req.path}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/delete", response_model=FileOpResponse)
async def api_files_delete(req: FileDeleteRequest):
    """Delete a file or directory on the remote system."""
    _validate_path_safety(req.path)
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = pool.get_connection(req.session_id)
    if not hpc:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await _ensure_within_work_root(hpc, req.path)
        if isinstance(hpc, LocalFileConnection):
            await hpc.delete_local(req.path)
        else:
            safe_path = shlex.quote(req.path)
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"rm -rf {safe_path}"))
            if result.exit_status != 0:
                return FileOpResponse(success=False, message=result.stderr.strip())
        return FileOpResponse(success=True, message=f"Deleted {req.path}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/rename", response_model=FileOpResponse)
async def api_files_rename(req: FileRenameRequest):
    """Rename a file or directory on the remote system."""
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = pool.get_connection(req.session_id)
    if not hpc:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await _ensure_within_work_root(hpc, req.old_path, req.new_path)
        if isinstance(hpc, LocalFileConnection):
            await hpc.rename_local(req.old_path, req.new_path)
        else:
            safe_old = shlex.quote(req.old_path)
            safe_new = shlex.quote(req.new_path)
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"mv {safe_old} {safe_new}"))
            if result.exit_status != 0:
                return FileOpResponse(success=False, message=result.stderr.strip())
        return FileOpResponse(success=True, message=f"Renamed to {req.new_path}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/copy", response_model=FileOpResponse)
async def api_files_copy(req: FileCopyRequest):
    """Copy a file or directory on the remote system."""
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = pool.get_connection(req.session_id)
    if not hpc:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await _ensure_within_work_root(hpc, req.source, req.destination)
        if isinstance(hpc, LocalFileConnection):
            await hpc.copy_local(req.source, req.destination)
        else:
            safe_src = shlex.quote(req.source)
            safe_dst = shlex.quote(req.destination)
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"cp -r {safe_src} {safe_dst}"))
            if result.exit_status != 0:
                return FileOpResponse(success=False, message=result.stderr.strip())
        return FileOpResponse(success=True, message=f"Copied to {req.destination}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/files/move", response_model=FileOpResponse)
async def api_files_move(req: FileMoveRequest):
    """Move a file or directory on the remote system."""
    from catgo.utils.hpc_client import LocalFileConnection
    hpc = pool.get_connection(req.session_id)
    if not hpc:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await _ensure_within_work_root(hpc, req.source, req.destination)
        if isinstance(hpc, LocalFileConnection):
            await hpc.rename_local(req.source, req.destination)
        else:
            safe_src = shlex.quote(req.source)
            safe_dst = shlex.quote(req.destination)
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"mv {safe_src} {safe_dst}"))
            if result.exit_status != 0:
                return FileOpResponse(success=False, message=result.stderr.strip())
        return FileOpResponse(success=True, message=f"Moved to {req.destination}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ====== Claude Code Remote Setup ======


class ClaudeCodeSetupRequest(BaseModel):
    session_id: str


def _pick_tunnel_port(username: str) -> int:
    """Pick a deterministic high port for SSH tunnel based on username.

    Avoids port 8000 which is commonly used on shared HPC systems.
    Uses a hash of the username to get a port in range 30000-39999.
    """
    h = 0
    for ch in username:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return 30000 + (h % 10000)


@router.post("/setup-claude-code")
async def setup_claude_code(request: ClaudeCodeSetupRequest) -> dict:
    """Configure Claude Code on a remote server to connect back to local CatGO.

    1. Picks a unique high port based on username (avoids conflicts on shared HPC)
    2. Writes ~/.claude/mcp.json on the remote (URL-based, points to localhost:<port>)
    3. Sets up SSH reverse tunnel (remote:<port> → local CatGO backend)

    After this, the user can type `claude` in the remote terminal and
    Claude Code will have access to all catgo_* MCP tools.
    """
    hpc = _get_hpc(request.session_id)
    conn = hpc.conn

    # Pick a unique tunnel port to avoid conflicts on shared HPC systems
    username = getattr(hpc, "username", "") or "catgo"
    remote_port = _pick_tunnel_port(username)

    # State-context hook — fetches /api/view/state and emits it as
    # additionalContext. Wired into both:
    #   * SessionStart (matcher: startup) — initial greeting on `claude` start
    #   * UserPromptSubmit                 — refreshed every user turn so lab
    #                                        claude always sees current viewer
    #                                        state without needing to call
    #                                        catgo_view get_state explicitly
    # `panel_id` is included so claude knows which pane the asymmetric-read
    # routed it to (most recently active vs Remote-pane "default").
    hook_script = f'''#!/bin/bash
# Inject /api/view/state as additionalContext for SessionStart and
# UserPromptSubmit. Two design notes:
#   1. python3 instead of jq — jq often isn't on the non-interactive
#      shell PATH on shared HPC / lab boxes.
#   2. hookSpecificOutput wrapper — recent Claude Code silently ignores
#      the bare {{"additionalContext": ...}} shortcut, only the wrapped
#      form lands in the model's context.
STATE=$(curl -s --max-time 2 http://localhost:{remote_port}/api/view/state 2>/dev/null)
[ -z "$STATE" ] && exit 0
INPUT=$(cat 2>/dev/null || true)
EVENT=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('hook_event_name', 'UserPromptSubmit'))
except Exception:
    print('UserPromptSubmit')
" 2>/dev/null)
[ -z "$EVENT" ] && EVENT=UserPromptSubmit
python3 - "$STATE" "$EVENT" <<'PYEOF'
import json, sys
state, event = sys.argv[1], sys.argv[2]
try:
    d = json.loads(state)
except Exception:
    sys.exit(0)
if d.get("has_structure"):
    msg = "[CatGO viewer] %s (%s atoms, panel=%s). Use catgo_* MCP tools." % (d.get("formula","?"), d.get("num_sites",0), d.get("panel_id","?"))
else:
    msg = "[CatGO] Backend online, no structure loaded."
print(json.dumps({{"hookSpecificOutput": {{"hookEventName": event, "additionalContext": msg}}}}))
PYEOF
'''

    # settings.json registers the hook for two events:
    #   - SessionStart: greeting on `claude` startup
    #   - UserPromptSubmit: refresh state context on every user turn
    # The same script handles both — it self-detects the event from the
    # hook_event_name field on stdin and outputs hookSpecificOutput.
    #
    # We MERGE into an existing settings.json instead of overwriting:
    # other plugins (caveman, claude-mem, etc.) commonly register their
    # own hooks for the same events, and overwriting would silently
    # nuke them. The check looks for 'catgo-session-start' specifically
    # in each event's hook list — a coarse grep on event names is too
    # easily fooled by sibling plugins (this was a real bug we hit).
    settings_merge_script = (
        "python3 - <<'PY_SETTINGS_EOF'\n"
        "import json, os\n"
        "p = os.path.expanduser('~/.claude/settings.json')\n"
        "c = json.load(open(p)) if os.path.exists(p) else {}\n"
        "hooks = c.setdefault('hooks', {})\n"
        "def has_catgo(arr):\n"
        "    return any('catgo-session-start' in str(h) for h in arr)\n"
        "catgo_hook = {'type': 'command', 'command': 'bash ~/.claude/hooks/catgo-session-start.sh', 'timeout': 5}\n"
        "ss = hooks.setdefault('SessionStart', [])\n"
        "if not has_catgo(ss):\n"
        "    ss.append({'matcher': 'startup', 'hooks': [catgo_hook]})\n"
        "ups = hooks.setdefault('UserPromptSubmit', [])\n"
        "if not has_catgo(ups):\n"
        "    ups.append({'hooks': [catgo_hook]})\n"
        "with open(p, 'w') as f: json.dump(c, f, indent=2)\n"
        "print('catgo hooks merged into', p)\n"
        "PY_SETTINGS_EOF\n"
    )

    # CLAUDE.md hint — teaches lab claude to use Read+load_file when the
    # user gives a file path. The MCP server runs on the user's local
    # machine and can't read lab-side paths, so claude must read the file
    # contents first. Merged via sentinel so existing CLAUDE.md content
    # is preserved and the block is updated in place on re-Setup.
    # Built without nested f-strings: outer f-string only substitutes
    # {remote_port}; the inner block is plain triple-quoted text. ASCII
    # em-dash (--) avoids \xXX encoding pitfalls in the heredoc.
    claude_md_merge_script = (
        "python3 - <<'PY_CLAUDEMD_EOF'\n"
        "import os, re\n"
        "p = os.path.expanduser('~/.claude/CLAUDE.md')\n"
        "existing = open(p).read() if os.path.exists(p) else ''\n"
        "block = '''<!-- BEGIN catgo-hint -->\n"
        "## CatGO MCP -- Token-Efficient File Transfer\n"
        "\n"
        "The MCP server runs on the **user local machine**, NOT this lab box.\n"
        "Direct path args cannot work -- file content must traverse the reverse\n"
        "tunnel. The principle: **anything large that just passes through your\n"
        "conversation context wastes tokens** -- bypass MCP with curl over the\n"
        "tunnel (binary, never enters your context).\n"
        "\n"
        "### Loading a file INTO the viewer (POSCAR/CIF/XYZ/etc. by path)\n"
        "\n"
        "**PREFERRED -- multipart upload, ~80 tokens:**\n"
        "```\n"
        f"curl -F \"file=@/tmp/foo.cif\" \"http://localhost:{remote_port}/api/view/upload-and-load\"\n"
        "```\n"
        "Format auto-detected from extension. Lands in External pane (panel_id=default);\n"
        "add `?panel_id=structure-1` to target a specific pane.\n"
        "\n"
        "**Fallback (>10x more expensive, avoid for >1KB):** Read + `mcp__catgo__catgo_structure\n"
        "load_file file_content=<text>`. POSCAR text travels through your context\n"
        "twice (Read result + MCP arg).\n"
        "\n"
        "### Exporting the viewer's CURRENT structure to a file\n"
        "\n"
        "**PREFERRED -- direct download to disk, ~50 tokens:**\n"
        "```\n"
        f"curl \"http://localhost:{remote_port}/api/view/structure/export?format=poscar\" > /tmp/foo.poscar\n"
        "```\n"
        "Formats: poscar, cif, xyz, extxyz, mol2, pdb. Reads from the\n"
        "user's currently active panel (or `&panel_id=...` for explicit).\n"
        "\n"
        "**Use the MCP form** (`catgo_structure export`) **only when YOU need to read\n"
        "or reason about the structure content** -- e.g. analyzing a slab's symmetry\n"
        "before deciding what to do next. For HPC submission (scp/sbatch), curl-to-file\n"
        "is always the right choice.\n"
        "\n"
        "### Merging a second structure file into the viewer\n"
        "\n"
        "**PREFERRED -- multipart upload, ~80 tokens:**\n"
        "```\n"
        f"curl -F \"file=@/tmp/molecule.xyz\" \\\\\n"
        f"     \"http://localhost:{remote_port}/api/view/structure/merge-upload?position=2,2,2\"\n"
        "```\n"
        "Merges the uploaded molecule into the panel's current structure at the\n"
        "given Cartesian position (default 0,0,0). Pushes the result back to the\n"
        "same panel.\n"
        "\n"
        "**Fallback (avoid for files > 1KB):** `mcp__catgo__catgo_structure merge\n"
        "structure=<full pymatgen dict>`. The dict is large and travels through\n"
        "your context.\n"
        "<!-- END catgo-hint -->'''\n"
        "pattern = re.compile(r'<!-- BEGIN catgo-hint -->.*?<!-- END catgo-hint -->', re.DOTALL)\n"
        "if pattern.search(existing):\n"
        "    new = pattern.sub(block, existing)\n"
        "else:\n"
        "    sep = '\\n\\n' if existing.strip() else ''\n"
        "    new = existing + sep + block + '\\n'\n"
        "os.makedirs(os.path.dirname(p), exist_ok=True)\n"
        "open(p, 'w').write(new)\n"
        "print('catgo-hint merged into', p)\n"
        "PY_CLAUDEMD_EOF\n"
    )

    mcp_url = f"http://localhost:{remote_port}/api/mcp"

    try:
        # Register MCP server via `claude mcp add` (idempotent — overwrites if exists).
        # Writing ~/.claude/mcp.json directly does NOT work; Claude Code only reads
        # config registered through its own CLI.
        # Helper script for compute nodes: forwards port from login node
        compute_helper = f'''#!/bin/bash
# CatGO compute node helper — run this after srun/ssh to a compute node.
# Forwards the CatGO tunnel from the login node to this compute node.
LOGIN=$(cat ~/.claude/.catgo_login_host 2>/dev/null || echo "login01")
if curl -s --max-time 1 http://localhost:{remote_port}/health >/dev/null 2>&1; then
  echo "[CatGO] Tunnel already accessible on this node."
  exit 0
fi
ssh -L {remote_port}:localhost:{remote_port} "$LOGIN" -N -f 2>/dev/null && \\
  echo "[CatGO] Port forwarded from $LOGIN. Claude Code ready." || \\
  echo "[CatGO] Failed to forward. Run: ssh -L {remote_port}:localhost:{remote_port} $LOGIN -N -f"
'''

        # Non-interactive SSH does not source ~/.profile, so user-local
        # install paths (e.g., ~/.local/bin/claude from the official
        # install.sh) are invisible. Source common init files, then probe
        # known install locations as a fallback. `-s user` registers the
        # MCP at user scope so it's reachable from any cwd (default
        # `local` is per-project and silently disappears elsewhere).
        # `set -e` + no `2>/dev/null` so a missing `claude` fails loudly
        # instead of writing hooks atop a half-installed MCP and reporting
        # green success.
        setup_cmd = (
            "set -e\n"
            "{ [ -f ~/.profile ] && . ~/.profile >/dev/null 2>&1; } || true\n"
            "{ [ -f ~/.bashrc ] && . ~/.bashrc >/dev/null 2>&1; } || true\n"
            "CLAUDE_BIN=$(command -v claude 2>/dev/null || true)\n"
            'if [ -z "$CLAUDE_BIN" ]; then\n'
            "  for p in ~/.local/bin/claude ~/.npm-global/bin/claude ~/.bun/bin/claude /usr/local/bin/claude; do\n"
            '    if [ -x "$p" ]; then CLAUDE_BIN="$p"; break; fi\n'
            "  done\n"
            "fi\n"
            'if [ -z "$CLAUDE_BIN" ]; then\n'
            "  for p in ~/.nvm/versions/node/*/bin/claude; do\n"
            '    if [ -x "$p" ]; then CLAUDE_BIN="$p"; break; fi\n'
            "  done\n"
            "fi\n"
            'if [ -z "$CLAUDE_BIN" ]; then\n'
            '  echo "claude binary not found. Install: curl -fsSL https://claude.ai/install.sh | bash" >&2\n'
            "  exit 1\n"
            "fi\n"
            '"$CLAUDE_BIN" mcp remove catgo -s user >/dev/null 2>&1 || true\n'
            f'"$CLAUDE_BIN" mcp add catgo -s user --transport http {mcp_url}\n'
            "mkdir -p ~/.claude/hooks\n"
            "hostname > ~/.claude/.catgo_login_host\n"
            f"cat > ~/.claude/hooks/catgo-session-start.sh << 'HOOKEOF'\n{hook_script}HOOKEOF\n"
            "chmod +x ~/.claude/hooks/catgo-session-start.sh\n"
            f"cat > ~/catgo-compute-setup.sh << 'COMPEOF'\n{compute_helper}COMPEOF\n"
            "chmod +x ~/catgo-compute-setup.sh\n"
            + settings_merge_script
            + claude_md_merge_script
        )

        result = await conn.run(setup_cmd)
        if hasattr(result, "exit_status") and result.exit_status != 0:
            stderr = (getattr(result, "stderr", "") or "").strip()
            stdout = (getattr(result, "stdout", "") or "").strip()
            detail = stderr or stdout or "(no output)"
            return {"success": False, "message": f"Setup failed: {detail}"}

        # Set up reverse tunnel: remote:<port> → local:SERVER_PORT
        local_port = int(os.environ.get("SERVER_PORT", 0)) or 8000
        try:
            import asyncssh
            if isinstance(conn, asyncssh.SSHClientConnection):
                hpc.claude_tunnel = await conn.forward_remote_port(
                    "", remote_port, "localhost", local_port
                )
                logger.info(
                    "Reverse tunnel established: remote:%d → localhost:%d",
                    remote_port, local_port,
                )
            else:
                # SubprocessSSHRunner — can't set up tunnel programmatically
                return {
                    "success": True,
                    "message": f"Config written. Tunnel not available in ControlMaster mode. "
                               f"Reconnect with: ssh -R {remote_port}:localhost:{local_port}",
                    "tunnel": False,
                }
        except Exception as tunnel_err:
            logger.warning("Reverse tunnel failed: %s", tunnel_err)
            return {
                "success": True,
                "message": f"Config written but tunnel failed: {tunnel_err}. "
                           f"Reconnect with: ssh -R {remote_port}:localhost:{local_port}",
                "tunnel": False,
            }

        return {
            "success": True,
            "message": f"Claude Code configured (port {remote_port}). "
                       "Type `claude` in remote terminal. "
                       "On compute nodes: run ~/catgo-compute-setup.sh first.",
            "tunnel": True,
        }

    except Exception as exc:
        logger.error("Claude Code setup failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


# ====== Health Check ======


@router.get("/health")
def hpc_health() -> dict[str, str | int]:
    """HPC module health check."""
    return {
        "status": "healthy",
        "service": "hpc",
        "active_connections": len(pool.connections),
    }


# ====== VASP cluster config preflight ======


class VaspPreflightRequest(BaseModel):
    session_id: str
    potcar_root: str
    potcar_functional: str = "potpaw_PBE"
    vasp_command: str = ""
    elements: list[str] = []
    # Environment prelude the real job uses, so the binary check resolves the
    # executable the same way the submitted script will (module load / conda /
    # exports), instead of probing a bare login shell.
    module_loads: str = ""
    python_env: str = ""


class PreflightCheck(BaseModel):
    name: str
    ok: bool
    severity: str = "error"  # "error" gates success; "warn" is advisory
    detail: str = ""


class VaspPreflightResponse(BaseModel):
    success: bool
    checks: list[PreflightCheck] = []
    message: str = ""


@router.post("/preflight/vasp", response_model=VaspPreflightResponse)
async def preflight_vasp(request: VaspPreflightRequest) -> VaspPreflightResponse:
    """Validate VASP cluster settings against the live remote host.

    Checks that the POTCAR root/functional directories exist, that the tree
    actually contains element POTCARs (and each requested element when given),
    and that the VASP binary resolves. Lets users catch a broken config before
    submitting a job that would otherwise crash silently on the cluster.
    """
    from catgo.utils.vasp_preflight import run_vasp_preflight

    hpc = _get_hpc(request.session_id)
    success, checks, message = await run_vasp_preflight(
        hpc,
        potcar_root=request.potcar_root,
        potcar_functional=request.potcar_functional,
        vasp_command=request.vasp_command,
        elements=request.elements,
        module_loads=request.module_loads,
        python_env=request.python_env,
    )
    return VaspPreflightResponse(
        success=success,
        checks=[PreflightCheck(**c) for c in checks],
        message=message,
    )
