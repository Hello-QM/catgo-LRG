"""conftest.py — add server/ and plugin dirs to sys.path for tests."""
import sys
from pathlib import Path

import pytest

_root = Path(__file__).resolve().parent.parent
_server = _root / "server"
_server_catgo = _root / "server" / "catgo"
_cp2k_plugin = _root / "plugins" / "cp2k-dos-reader"

for p in [str(_server), str(_server_catgo), str(_cp2k_plugin)]:
    if p not in sys.path:
        sys.path.insert(0, p)


def pytest_configure(config):
    """Register asyncio_mode so pytest-asyncio uses auto mode."""
    config.addinivalue_line("markers", "asyncio: mark test as async")
    config.addinivalue_line(
        "markers", "integration: requires running backend server"
    )


def _backend_reachable():
    """Check if the CatGo backend is reachable."""
    import socket
    for port in (8000, 8050):
        try:
            with socket.create_connection(("localhost", port), timeout=1):
                return True
        except OSError:
            continue
    return False


_BACKEND_UP = _backend_reachable()


def pytest_collection_modifyitems(config, items):
    """Auto-skip integration tests when backend is not running."""
    if _BACKEND_UP:
        return
    skip_marker = pytest.mark.skip(reason="Backend server not running on localhost")
    # Files that require a running backend (use requests to localhost)
    integration_files = {
        "test_phase2_analyzer.py",
        "test_polymer_workflow.py",
        "test_lammps_api.py",
        "test_lammps_simple.py",
        "test_kremer_grest_polymer.py",
        "test_phase3_api.py",
        "test_ai_tools_e2e.py",
    }
    for item in items:
        if Path(item.fspath).name in integration_files:
            item.add_marker(skip_marker)
