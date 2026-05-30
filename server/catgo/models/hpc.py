"""Pydantic models for HPC connectivity: SSH connections, job scheduling, and file transfer."""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, SecretStr


# ====== Enums ======


class SchedulerType(str, Enum):
    SLURM = "slurm"
    PBS = "pbs"


class JobStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    UNKNOWN = "UNKNOWN"


class AuthMethod(str, Enum):
    PASSWORD = "password"
    PASSWORD_OTP = "password_otp"
    KEY = "key"
    KEY_OTP = "key_otp"
    SSH_CONFIG = "ssh_config"  # Use system ssh binary (ControlMaster)


# ====== Connection ======


class HPCConnectionConfig(BaseModel):
    """SSH connection configuration for HPC systems."""

    host: str
    port: int = 22
    username: str
    password: Optional[SecretStr] = None  # For password/password_otp methods
    auth_method: AuthMethod = AuthMethod.PASSWORD
    key_file: Optional[str] = None  # For key/key_otp methods (e.g. ~/.ssh/id_rsa_kaust)
    jump_host: Optional[str] = None
    jump_port: int = 22
    jump_username: Optional[str] = None
    jump_password: Optional[SecretStr] = None  # If empty, use SSH key/agent auth
    scheduler: SchedulerType = SchedulerType.SLURM
    ssh_alias: Optional[str] = None  # SSH config alias (e.g. "Shaheen"), for SSH_CONFIG mode
    # SOCKS5 proxy settings — route SSH traffic through a SOCKS5 proxy
    proxy_host: Optional[str] = None  # e.g. "127.0.0.1"
    proxy_port: int = 1080  # Default SOCKS5 port
    proxy_username: Optional[str] = None
    proxy_password: Optional[SecretStr] = None
    work_root: Optional[str] = None  # Optional remote directory boundary for file/job operations


class HPCProfile(BaseModel):
    """Saved HPC profile (no secrets — password/OTP never persisted)."""

    name: str
    host: str
    port: int = 22
    username: str
    auth_method: AuthMethod = AuthMethod.PASSWORD
    key_file: Optional[str] = None
    jump_host: Optional[str] = None
    jump_port: int = 22
    jump_username: Optional[str] = None
    scheduler: SchedulerType = SchedulerType.SLURM
    ssh_alias: Optional[str] = None  # SSH config alias for SSH_CONFIG mode
    # SOCKS5 proxy (host/port persisted, credentials NOT persisted)
    proxy_host: Optional[str] = None
    proxy_port: int = 1080
    proxy_username: Optional[str] = None
    work_root: Optional[str] = None  # Optional remote directory boundary for this profile


# ====== Jobs ======


class JobSubmitRequest(BaseModel):
    """Request to submit a job to the scheduler."""

    session_id: str
    script_content: str
    job_name: str = "catgo_job"
    partition: Optional[str] = None
    nodes: int = 1
    ntasks: int = 1
    cpus_per_task: int = 1
    time_limit: str = "01:00:00"
    memory: Optional[str] = None
    work_dir: str = "~"


class JobInfo(BaseModel):
    """Information about a scheduled job."""

    job_id: str
    job_name: str = ""
    status: JobStatus = JobStatus.UNKNOWN
    partition: str = ""
    nodes: str = ""
    time_elapsed: str = ""
    time_limit: str = ""
    submit_time: str = ""
    start_time: str = ""
    reason: str = ""
    work_dir: str = ""
    calc_software: str = ""  # "vasp", "qe", "lammps", "cp2k", "unknown"
    calc_type: str = ""  # "opt", "scf", "md", "freq", etc.


class JobSubmitResponse(BaseModel):
    success: bool
    message: str
    job_id: Optional[str] = None


class JobListResponse(BaseModel):
    success: bool
    jobs: list[JobInfo] = []
    message: str = ""


class JobCancelResponse(BaseModel):
    success: bool
    message: str


# ====== Files ======


class FileInfo(BaseModel):
    """Remote file metadata."""

    name: str
    path: str
    is_dir: bool = False
    size_bytes: int = 0
    modified_time: str = ""


class FileListRequest(BaseModel):
    session_id: str
    path: str = "~"


class FileListResponse(BaseModel):
    success: bool
    files: list[FileInfo] = []
    current_path: str = ""
    message: str = ""


class FileUploadResponse(BaseModel):
    success: bool
    message: str
    remote_path: str = ""


# ====== WebSocket Messages ======


class WSHPCMessage(BaseModel):
    """Base WebSocket message."""

    type: str
    message: str = ""


class WSHPCAuthChallenge(WSHPCMessage):
    """Server requests OTP from client."""

    type: str = "auth_challenge"
    prompt: str = ""


class WSHPCConnected(WSHPCMessage):
    """Connection established successfully."""

    type: str = "connected"
    session_id: str = ""


class WSHPCError(WSHPCMessage):
    """Connection or operation error."""

    type: str = "error"


class WSHPCDisconnected(WSHPCMessage):
    """Connection closed."""

    type: str = "disconnected"


class ConnectionStatusResponse(BaseModel):
    """Response for connection status check."""

    connected: bool
    session_id: str
    host: str = ""
    username: str = ""
    scheduler: SchedulerType = SchedulerType.SLURM
    uptime_seconds: float = 0
    work_root: str = ""


class ConnectionInfo(BaseModel):
    """Summary info for an active connection."""

    session_id: str
    host: str
    username: str
    scheduler: SchedulerType
    uptime_seconds: float
    work_root: str = ""


class JobSummary(BaseModel):
    """Aggregated job counts."""

    running: int = 0
    pending: int = 0
    completed: int = 0
    failed: int = 0
    total: int = 0


class HPCOverview(BaseModel):
    """Overview data for a single HPC connection."""

    session_id: str
    host: str
    username: str
    scheduler: SchedulerType
    uptime_seconds: float
    job_summary: JobSummary = Field(default_factory=JobSummary)
    disk_usage: str = ""
    system_info: str = ""


# ====== Job Detail ======


class CalcSoftware(str, Enum):
    """Calculation software detected from job files."""

    VASP = "vasp"
    QE = "qe"
    LAMMPS = "lammps"
    CP2K = "cp2k"
    UNKNOWN = "unknown"


class CalcType(str, Enum):
    """Type of calculation being performed."""

    OPT = "opt"  # geometry optimization
    SCF = "scf"  # single-point
    MD = "md"  # molecular dynamics
    FREQ = "freq"  # frequency/phonon
    BAND = "band"
    DOS = "dos"
    NEB = "neb"
    UNKNOWN = "unknown"


class JobDetailInfo(BaseModel):
    """Detailed information about a specific job, including scheduler metadata
    and detected calculation properties."""

    job_id: str
    job_name: str = ""
    status: JobStatus = JobStatus.UNKNOWN
    partition: str = ""
    account: str = ""
    nodes: str = ""
    num_nodes: int = 0
    num_cpus: int = 0
    num_tasks: int = 0
    time_elapsed: str = ""
    time_limit: str = ""
    submit_time: str = ""
    start_time: str = ""
    end_time: str = ""
    work_dir: str = ""
    stdout_path: str = ""
    stderr_path: str = ""
    command: str = ""
    node_list: str = ""
    reason: str = ""
    exit_code: str = ""
    cpus_per_task: int = 0
    ntasks_per_node: int = 0
    calc_software: CalcSoftware = CalcSoftware.UNKNOWN
    calc_type: CalcType = CalcType.UNKNOWN
    current_step: int = 0
    total_steps: int = 0


class ConvergencePoint(BaseModel):
    """A single data point in the convergence history of a calculation."""

    step: int
    energy: float = 0.0
    energy_sigma0: float = 0.0
    dE: float = 0.0
    max_force: float = 0.0
    rms_force: float = 0.0
    max_step: float = 0.0      # MAX displacement (Bohr) — ORCA OPT only
    rms_step: float = 0.0      # RMS displacement (Bohr) — ORCA OPT only
    max_gradient: float = 0.0  # max |G| (Hartree/Bohr) — ORCA IRC only
    rms_gradient: float = 0.0  # RMS(G) (Hartree/Bohr)  — ORCA IRC only
    is_ts: bool = False        # True for the TS step (step 0)  — ORCA IRC only
    # CP2K MD-specific fields. Zero when the step isn't from an MD run so
    # consumers can show them only for MD nodes. All in eV / K — backend
    # parsers convert from CP2K's native Hartree before populating these.
    temperature: float = 0.0       # K — instantaneous ionic temperature
    kinetic_energy: float = 0.0    # eV — kinetic energy this step
    potential_energy: float = 0.0  # eV — potential energy this step
    conserved_energy: float = 0.0  # eV — CP2K's "CONSERVED QUANTITY" (should be ~const)


class ConvergenceData(BaseModel):
    """Convergence data extracted from calculation output files."""

    success: bool
    points: list[ConvergencePoint] = []
    converged: bool = False
    message: str = ""
    image_energies: Optional[dict[int, list[tuple[int, float]]]] = Field(
        default=None,
        description="Per-image energy data for NEB: {iteration: [(image_idx, energy_eh), ...]}"
    )
    convergence_thresholds: Optional[dict[str, float]] = Field(
        default=None,
        description="IRC convergence thresholds: {max_grad, rms_grad} in Hartree/Bohr"
    )


class JobLogResponse(BaseModel):
    """Response containing the contents of a job log file."""

    success: bool
    content: str = ""
    file_path: str = ""
    total_lines: int = 0
    message: str = ""


# ====== File I/O ======


class FileReadRequest(BaseModel):
    """Request to read a remote file."""

    session_id: str
    file_path: str
    max_bytes: int | None = None  # Override default 2MB limit (0 = unlimited, e.g. for trajectory files)


class FileReadResponse(BaseModel):
    """Response with remote file content."""

    success: bool
    content: str = ""
    total_lines: int = 0
    message: str = ""


class BinaryFileReadResponse(BaseModel):
    """Response with base64-encoded binary file content."""

    success: bool
    data: str = ""  # base64 encoded
    mime_type: str = ""
    size: int = 0
    message: str = ""


class FileWriteRequest(BaseModel):
    """Request to write content to a remote file."""

    session_id: str
    file_path: str
    content: str


class FileWriteResponse(BaseModel):
    """Response for file write operation."""

    success: bool
    message: str = ""


class JobFilesResponse(BaseModel):
    """Response listing editable files in a job's work directory."""

    success: bool
    files: list[str] = []
    work_dir: str = ""
    message: str = ""


class JobResubmitResponse(BaseModel):
    """Response for job resubmission."""

    success: bool
    message: str = ""
    new_job_id: str = ""


# ====== File Operations ======


class FileMkdirRequest(BaseModel):
    """Create a directory on the remote system."""
    session_id: str
    path: str


class FileDeleteRequest(BaseModel):
    """Delete a file or directory on the remote system."""
    session_id: str
    path: str


class FileRenameRequest(BaseModel):
    """Rename a file or directory on the remote system."""
    session_id: str
    old_path: str
    new_path: str


class FileCopyRequest(BaseModel):
    """Copy a file or directory on the remote system."""
    session_id: str
    source: str
    destination: str


class FileMoveRequest(BaseModel):
    """Move a file or directory on the remote system."""
    session_id: str
    source: str
    destination: str


class FileOpResponse(BaseModel):
    """Response for file operations."""
    success: bool
    message: str = ""
