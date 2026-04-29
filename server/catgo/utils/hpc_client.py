"""HPC client — backward-compat shim.

Real implementations split across:
- scheduler_base.py  — SchedulerInterface ABC + scheduler registry
- hpc_connection.py  — HPCConnection dataclass
- connection_pool.py — HPCConnectionPool + profile persistence
- local_connection.py — LocalFileConnection, SubprocessSSHRunner, LocalScheduler
- ssh_auth.py        — Socks5Tunnel, KbdintSSHClient, OTP
- ssh_file_ops.py    — SSHFileOpsMixin, LocalFileOpsMixin
- slurm.py           — SLURMScheduler
- pbs.py             — PBSScheduler
"""

import asyncio
import logging

# ====== Direct re-exports (no circular dep risk) ======

from catgo.utils.scheduler_base import SchedulerInterface, _get_schedulers  # noqa: F401
from catgo.utils.hpc_connection import HPCConnection  # noqa: F401
from catgo.utils.ssh_file_ops import SSHFileOpsMixin, LocalFileOpsMixin  # noqa: F401

from catgo.models.hpc import SchedulerType  # noqa: F401

logger = logging.getLogger(__name__)

# Constants that external code imports from here
LOCAL_SESSION_ID = "__local__"


async def resolve_tilde(conn, path: str) -> str:
    """Resolve ~ to absolute home directory path on remote host."""
    if "~" not in path:
        return path
    try:
        result = await asyncio.wait_for(
            conn.run("echo $HOME", check=False),
            timeout=30.0,
        )
        home = (result.stdout or "").strip()
        if not home:
            raise RuntimeError("Could not determine remote home directory")
        return path.replace("~", home, 1)
    except asyncio.TimeoutError:
        logger.warning("Timed out resolving tilde for path: %s", path)
        raise RuntimeError("Could not resolve home directory (timeout)")
    except Exception:
        raise


# ====== Lazy re-exports (avoid circular deps with connection_pool/local_connection) ======

_REEXPORT_MAP = {
    # from catgo.utils.ssh_auth
    'Socks5Tunnel': 'catgo.utils.ssh_auth',
    'KbdintSSHClient': 'catgo.utils.ssh_auth',
    'OTPCallback': 'catgo.utils.ssh_auth',
    # from catgo.utils.connection_pool
    'HPCConnectionPool': 'catgo.utils.connection_pool',
    'pool': 'catgo.utils.connection_pool',
    'load_profiles': 'catgo.utils.connection_pool',
    'save_profile': 'catgo.utils.connection_pool',
    'delete_profile': 'catgo.utils.connection_pool',
    'PROFILES_DIR': 'catgo.utils.connection_pool',
    'PROFILES_FILE': 'catgo.utils.connection_pool',
    # from catgo.utils.local_connection
    'LocalFileConnection': 'catgo.utils.local_connection',
    'LocalCommandRunner': 'catgo.utils.local_connection',
    'SubprocessSSHRunner': 'catgo.utils.local_connection',
    'SubprocessCompletedProcess': 'catgo.utils.local_connection',
    'LocalScheduler': 'catgo.utils.local_connection',
    # from catgo.utils.slurm / pbs
    'SLURMScheduler': 'catgo.utils.slurm',
    'PBSScheduler': 'catgo.utils.pbs',
}


def __getattr__(name: str):
    if name in _REEXPORT_MAP:
        import importlib
        mod = importlib.import_module(_REEXPORT_MAP[name])
        value = getattr(mod, name)
        globals()[name] = value  # cache for subsequent access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
