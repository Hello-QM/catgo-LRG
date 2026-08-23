"""Task and Workflow state enums with classification helpers."""

from __future__ import annotations
from enum import Enum
from typing import Iterable


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


_DELETE_BLOCKING_TASK_STATES = {
    TaskState.GENERATING,
    TaskState.UPLOADING,
    TaskState.SUBMITTED,
    TaskState.QUEUED,
    TaskState.RUNNING,
    TaskState.COMPLETED_REMOTE,
    TaskState.COLLECTING,
}

_RUNNABLE_TASK_STATES = {
    TaskState.READY,
    *_DELETE_BLOCKING_TASK_STATES,
}


def _coerce_task_states(states: Iterable[str | TaskState]) -> set[TaskState]:
    """Normalize persisted task-state strings, ignoring unknown legacy values."""
    normalized: set[TaskState] = set()
    for state in states:
        try:
            normalized.add(state if isinstance(state, TaskState) else TaskState(str(state).upper()))
        except ValueError:
            continue
    return normalized


def workflow_display_status(
    workflow_status: str,
    task_states: Iterable[str | TaskState],
) -> str:
    """Return the user-facing workflow state without changing engine scheduling.

    A workflow waiting at the human review gate is persisted as ``running`` so
    the scanner can resume immediately after confirmation.  Calling that state
    RUNNING in list views is misleading because no calculation is executing.
    """
    status = str(workflow_status or "draft").lower()
    states = _coerce_task_states(task_states)
    if status == WorkflowState.RUNNING.value:
        if states & _DELETE_BLOCKING_TASK_STATES:
            return status
        if TaskState.PENDING_REVIEW in states:
            return "check"
        # FAILED and REMOTE_ERROR are both presented as failed task nodes in
        # the DAG.  If no task is executing or ready to run, keeping the card
        # labelled RUNNING contradicts the graph and the progress summary.
        # The persisted workflow may remain ``running`` so the scanner can
        # still auto-recover a transient SSH failure in the background.
        if (
            states & {TaskState.FAILED, TaskState.REMOTE_ERROR}
            and not (states & _RUNNABLE_TASK_STATES)
        ):
            return WorkflowState.FAILED.value
        if TaskState.PAUSED in states:
            return WorkflowState.PAUSED.value
    return status


def workflow_delete_block_reason(
    workflow_status: str,
    task_states: Iterable[str | TaskState],
    *,
    has_unresolved_remote_jobs: bool = False,
) -> str | None:
    """Explain why a workflow cannot be deleted, or return ``None``.

    PAUSED is explicitly deletable: it is a scheduling state, not proof that a
    job is still executing.  Terminal workflows are also deletable even when
    old rows contain stale active-looking task states.  For a live workflow we
    protect actual execution states, while a PENDING_REVIEW/CHECK gate is safe
    to remove because it has not submitted a calculation.
    """
    status = str(workflow_status or "draft").lower()
    states = _coerce_task_states(task_states)
    executing = states & _DELETE_BLOCKING_TASK_STATES

    if status == "resetting":
        return "workflow reset is in progress"
    if status in {
        WorkflowState.PAUSED.value,
        WorkflowState.COMPLETED.value,
        WorkflowState.FAILED.value,
    }:
        return None
    if status == WorkflowState.RUNNING.value:
        if TaskState.PENDING_REVIEW in states and not executing:
            return None
        if workflow_display_status(status, states) == WorkflowState.FAILED.value:
            if has_unresolved_remote_jobs:
                return "remote job status is unresolved"
            return None
        if executing:
            names = ", ".join(sorted(state.value for state in executing))
            return f"tasks are executing ({names})"
        return "workflow scheduler is active"
    if executing:
        names = ", ".join(sorted(state.value for state in executing))
        return f"tasks are executing ({names})"
    return None


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
        # All tasks in terminal states? Determine outcome by priority.
        if state_set <= _TERMINAL_STATES:
            if any(s == TaskState.FAILED for s in states):
                return cls.FAILED
            # All cancelled (none completed) → treat as failed
            if any(s == TaskState.CANCELLED for s in states) and not any(
                s == TaskState.COMPLETED for s in states
            ):
                return cls.FAILED
            return cls.COMPLETED
        # Some tasks are non-terminal. Only fail the workflow if there
        # are failed tasks AND nothing left that could still recover
        # (e.g. REMOTE_ERROR tasks waiting for SSH reconnection).
        if any(s == TaskState.FAILED for s in states):
            has_recoverable = any(
                s == TaskState.REMOTE_ERROR or s in _ACTIVE_STATES
                for s in states
            )
            if not has_recoverable:
                return cls.FAILED
        # Note: all-WAITING/READY no longer returns DRAFT here.
        # While-loop resets can put every task back to WAITING mid-run;
        # returning DRAFT would stop the scanner from processing the workflow.
        # DRAFT is only set explicitly at creation time.
        if any(s == TaskState.PAUSED for s in states):
            return cls.PAUSED
        return cls.RUNNING
