"""Task and Workflow state enums with classification helpers."""

from __future__ import annotations
from enum import Enum


class TaskState(str, Enum):
    """14-state machine for task lifecycle."""

    WAITING = "WAITING"             # Parents not yet completed
    READY = "READY"                 # All parents done, can be picked up
    GENERATING = "GENERATING"       # Creating input files
    UPLOADING = "UPLOADING"         # Transferring files to HPC
    SUBMITTED = "SUBMITTED"         # sbatch done, got job_id
    QUEUED = "QUEUED"               # SLURM PENDING
    RUNNING = "RUNNING"             # SLURM RUNNING
    COMPLETED_REMOTE = "COMPLETED_REMOTE"  # HPC done, results on remote
    COLLECTING = "COLLECTING"       # Reading output files
    COMPLETED = "COMPLETED"         # Results in DB
    FAILED = "FAILED"               # Permanent failure
    REMOTE_ERROR = "REMOTE_ERROR"   # Transient error, retryable
    PENDING_REVIEW = "PENDING_REVIEW"  # Local done, waiting for user confirm before HPC submit
    PAUSED = "PAUSED"               # User paused
    CANCELLED = "CANCELLED"         # User cancelled
    SKIPPED = "SKIPPED"             # Condition not met, skipped
    MAPPED = "MAPPED"               # Template/controller — children were spawned

    @property
    def is_active(self) -> bool:
        return self in _ACTIVE_STATES

    @property
    def is_terminal(self) -> bool:
        return self in _TERMINAL_STATES

    @property
    def is_retryable(self) -> bool:
        return self == TaskState.REMOTE_ERROR

    @property
    def is_hpc_submitted(self) -> bool:
        return self in _HPC_SUBMITTED_STATES


_ACTIVE_STATES = {
    TaskState.GENERATING, TaskState.UPLOADING,
    TaskState.SUBMITTED, TaskState.QUEUED, TaskState.RUNNING,
    TaskState.COMPLETED_REMOTE, TaskState.COLLECTING,
}

_TERMINAL_STATES = {
    TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED,
    TaskState.SKIPPED, TaskState.MAPPED,
}

_HPC_SUBMITTED_STATES = {
    TaskState.SUBMITTED, TaskState.QUEUED, TaskState.RUNNING,
    TaskState.COMPLETED_REMOTE,
}


class WorkflowState(str, Enum):
    """Workflow-level states derived from task states."""

    DRAFT = "draft"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"

    @classmethod
    def from_task_states(cls, states: list[TaskState]) -> WorkflowState:
        """Derive workflow status from its tasks' states."""
        if not states:
            return cls.DRAFT
        state_set = set(states)
        if all(s in (TaskState.COMPLETED, TaskState.SKIPPED, TaskState.MAPPED) for s in states):
            return cls.COMPLETED
        if any(s == TaskState.FAILED for s in states):
            return cls.FAILED
        # Note: all-WAITING/READY no longer returns DRAFT here.
        # While-loop resets can put every task back to WAITING mid-run;
        # returning DRAFT would stop the scanner from processing the workflow.
        # DRAFT is only set explicitly at creation time.
        if any(s == TaskState.PAUSED for s in states):
            return cls.PAUSED
        if state_set & _ACTIVE_STATES:
            return cls.RUNNING
        return cls.RUNNING
