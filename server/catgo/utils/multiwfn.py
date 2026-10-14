"""Locate and drive Multiwfn non-interactively.

Multiwfn (http://sobereva.com/multiwfn) is menu driven; it is run here with
the wavefunction file as argument and the menu choices fed on stdin, inside a
scratch directory so concurrent runs do not collide on its output files.

Lookup order for the executable: an explicit path (file or directory), the
``CATGO_MULTIWFN`` environment variable, the ``Multiwfnpath`` directory that
Multiwfn's own installation instructions set, then ``PATH``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

EXECUTABLE_NAMES = (
    "Multiwfn_noGUI",
    "Multiwfn",
    "multiwfn",
    "Multiwfn_noGUI.exe",
    "Multiwfn.exe",
)

# Grid presets of main function 5 ("Output and plot specific property within
# a spatial region"): 1 low (~125k points), 2 medium (~512k), 3 high (~1.7M).
GRID_CHOICES = {"low": 1, "medium": 2, "high": 3}

DEFAULT_TIMEOUT = 600


class MultiwfnError(RuntimeError):
    """Multiwfn is missing or did not produce the expected output."""


def _is_multiwfn_name(path: Path) -> bool:
    return path.name.lower().startswith("multiwfn")


def _executable_in(path: Path) -> Path | None:
    if path.is_file():
        return path if _is_multiwfn_name(path) and os.access(path, os.X_OK) else None
    if path.is_dir():
        for name in EXECUTABLE_NAMES:
            candidate = path / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return candidate
    return None


def find_multiwfn(explicit: str | None = None) -> tuple[str | None, str | None]:
    """Return ``(path, source)`` of the Multiwfn executable, or ``(None, None)``.

    An explicit path must name a file whose basename starts with "Multiwfn",
    or a directory containing one, so the endpoint cannot be pointed at an
    arbitrary program.
    """
    if explicit:
        found = _executable_in(Path(explicit).expanduser())
        return (str(found), "setting") if found else (None, None)
    for env, source in (("CATGO_MULTIWFN", "CATGO_MULTIWFN"), ("Multiwfnpath", "Multiwfnpath")):
        value = os.environ.get(env)
        if value:
            found = _executable_in(Path(value).expanduser())
            if found:
                return str(found), source
    for name in EXECUTABLE_NAMES:
        found = shutil.which(name)
        if found:
            return found, "PATH"
    return None, None


def _env_for(executable: str) -> dict[str, str]:
    env = dict(os.environ)
    # Multiwfn looks for settings.ini in $Multiwfnpath; its manual also asks
    # for a large OpenMP stack to avoid crashes on big grids.
    env.setdefault("Multiwfnpath", str(Path(executable).parent))
    env.setdefault("KMP_STACKSIZE", "200M")
    env.setdefault("OMP_STACKSIZE", "200M")
    return env


def run_multiwfn(
    wavefunction: str | Path,
    keystrokes: list[str],
    workdir: str | Path,
    executable: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Run Multiwfn on ``wavefunction`` feeding ``keystrokes`` (one per line).

    Returns stdout. Raises :class:`MultiwfnError` on timeout or non-zero exit.
    """
    stdin = "\n".join(keystrokes) + "\n"
    try:
        proc = subprocess.run(
            [executable, str(wavefunction)],
            input=stdin,
            capture_output=True,
            text=True,
            cwd=str(workdir),
            env=_env_for(executable),
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise MultiwfnError(f"Multiwfn timed out after {timeout} s") from exc
    except OSError as exc:
        raise MultiwfnError(f"Could not start Multiwfn ({executable}): {exc}") from exc
    if proc.returncode != 0:
        tail = (proc.stdout or "")[-1500:] + (proc.stderr or "")[-500:]
        raise MultiwfnError(f"Multiwfn exited with code {proc.returncode}:\n{tail}")
    return proc.stdout


def _newest_cube(workdir: Path) -> Path | None:
    cubes = [p for p in workdir.iterdir() if p.suffix.lower() in (".cub", ".cube")]
    return max(cubes, key=lambda p: p.stat().st_mtime) if cubes else None


def orbital_cube(
    wavefunction: str | Path,
    orbital_index: int,
    grid: str = "medium",
    executable: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Generate a Gaussian cube of one orbital's wavefunction value.

    ``orbital_index`` is Multiwfn's 1-based orbital number (beta orbitals of
    an unrestricted wavefunction follow all alpha ones). Returns the cube
    file text.
    """
    if grid not in GRID_CHOICES:
        raise ValueError(f"grid must be one of {sorted(GRID_CHOICES)}")
    if orbital_index < 1:
        raise ValueError("orbital_index is 1-based")
    if executable is None:
        executable, _ = find_multiwfn()
    if not executable:
        raise MultiwfnError("Multiwfn was not found")

    keystrokes = [
        "5",                      # output/plot a real-space function on a grid
        "4",                      # function: orbital wavefunction value
        str(orbital_index),
        str(GRID_CHOICES[grid]),
        "2",                      # export the grid to a cube file (MOvalue.cub)
        "0",                      # back to the main menu
        "q",                      # quit
    ]
    with tempfile.TemporaryDirectory(prefix="catgo-multiwfn-") as tmp:
        workdir = Path(tmp)
        stdout = run_multiwfn(wavefunction, keystrokes, workdir, executable, timeout)
        cube = _newest_cube(workdir)
        if cube is None:
            raise MultiwfnError(
                "Multiwfn finished without writing a cube file. Last output:\n" + stdout[-1500:]
            )
        return cube.read_text()
