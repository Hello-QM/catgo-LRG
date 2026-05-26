"""Shared helpers for consolidated-MCP functional tests.

These load REAL inputs (no synthetic happy-path stand-ins): real CIFs from
src/site/structures and a real multi-frame trajectory from src/site/trajectories.
"""
import base64
from pathlib import Path

# repo root = three levels up from this file (server/tests/_mcp_fixtures.py)
_REPO = Path(__file__).resolve().parents[2]
_STRUCTS = _REPO / "src" / "site" / "structures"
_TRAJ = _REPO / "src" / "site" / "trajectories"

TRAJECTORY_EXTXYZ = _TRAJ / "mp-1184225.extxyz"   # 6 frames, real
TIO2_CIF = _STRUCTS / "TiO2.cif"                   # rutile, real
QUARTZ_CIF = _STRUCTS / "quartz-alpha.cif"         # alpha-quartz, real


def load_cif_as_dict(path: Path) -> dict:
    """Parse a CIF into a pymatgen Structure .as_dict() (raw form)."""
    from pymatgen.core import Structure
    return Structure.from_file(str(path)).as_dict()


def trajectory_b64(path: Path = TRAJECTORY_EXTXYZ) -> str:
    """Base64 of a real trajectory file, for the MD endpoints' trajectory_b64 field."""
    return base64.b64encode(path.read_bytes()).decode("ascii")
