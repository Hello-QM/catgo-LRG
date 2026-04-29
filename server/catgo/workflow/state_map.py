# server/catgo/workflow/state_map.py
"""Map engine 14-state TaskState to frontend 6-state display status.

Engine states: WAITING, READY, GENERATING, UPLOADING, SUBMITTED, QUEUED,
               RUNNING, COMPLETED_REMOTE, COLLECTING, COMPLETED, FAILED,
               REMOTE_ERROR, PAUSED, CANCELLED

Frontend statuses (STATUS_COLORS in workflow-types.ts):
  pending, queued, running, completed, not_converged, failed, paused
"""

from __future__ import annotations

_ENGINE_TO_FRONTEND: dict[str, str] = {
    "WAITING": "pending",
    "READY": "pending",
    "PENDING_REVIEW": "pending_review",
    "GENERATING": "running",
    "UPLOADING": "running",
    "SUBMITTED": "queued",
    "QUEUED": "queued",
    "RUNNING": "running",
    "COMPLETED_REMOTE": "running",
    "COLLECTING": "running",
    "COMPLETED": "completed",
    "FAILED": "failed",
    "REMOTE_ERROR": "failed",
    "PAUSED": "paused",
    "CANCELLED": "failed",
    "SKIPPED": "skipped",
}

_FRONTEND_TO_ENGINE: dict[str, str] = {
    "pending": "WAITING",
    "queued": "QUEUED",
    "running": "RUNNING",
    "completed": "COMPLETED",
    "failed": "FAILED",
    "paused": "PAUSED",
    "not_converged": "COMPLETED",
}


def v2_to_v1_status(engine_status: str) -> str:
    """Convert engine TaskState string to frontend display status."""
    return _ENGINE_TO_FRONTEND.get(engine_status, engine_status)


def v1_to_v2_status(frontend_status: str) -> str:
    """Convert frontend display status to engine TaskState string."""
    return _FRONTEND_TO_ENGINE.get(frontend_status, frontend_status.upper())
