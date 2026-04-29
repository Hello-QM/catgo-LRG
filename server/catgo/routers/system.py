"""System status and diagnostics endpoints."""
from collections import deque
from datetime import datetime
from fastapi import APIRouter

router = APIRouter(prefix="/system", tags=["system"])

_error_log: deque[dict] = deque(maxlen=200)

def log_user_error(category: str, message: str, details: str = ""):
    """Record an error for the diagnostics panel."""
    _error_log.append({
        "timestamp": datetime.now().isoformat(),
        "category": category,
        "message": message,
        "details": details,
    })

@router.get("/errors")
def get_recent_errors(limit: int = 50):
    """Return the most recent error log entries."""
    return list(_error_log)[-limit:]

@router.get("/status")
def get_system_status():
    """Return backend and HPC connection status summary."""
    try:
        from catgo.utils.hpc_client import pool
        connections = pool.list_connections()
        sessions = []
        for c in connections:
            entry = {}
            if hasattr(c, 'host'):
                entry['host'] = c.host
            if hasattr(c, 'username'):
                entry['username'] = c.username
            if hasattr(c, 'uptime_seconds'):
                entry['uptime'] = c.uptime_seconds
            sessions.append(entry)
    except Exception:
        connections = []
        sessions = []

    return {
        "backend": "connected",
        "hpc_connections": len(connections),
        "hpc_sessions": sessions,
    }
