"""Locate and drive Multiwfn non-interactively.

Multiwfn (http://sobereva.com/multiwfn) is menu driven; it is run here with
the wavefunction file as argument and the menu choices fed on stdin, inside a
scratch directory so concurrent runs do not collide on its output files.

Lookup order for the executable: an explicit path (file or directory), the
``CATGO_MULTIWFN`` environment variable, the ``Multiwfnpath`` directory that
Multiwfn's own installation instructions set, then ``PATH``.
"""

from __future__ import annotations

import json
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


# ── keystroke recipes ──────────────────────────────────────────────────────
#
# Multiwfn's menus are driven by numbers that occasionally move between
# versions, so every sequence lives here and can be overridden without code
# changes: put a JSON object {"recipe name": [keystrokes...], ...} (and
# optionally "grid_function_codes": {...}) in the file named by
# $CATGO_MULTIWFN_RECIPES or ~/.catgo/multiwfn_recipes.json.
#
# Placeholders: {orbital} {grid} {function} {n_fragments}; a line that is
# exactly "{fragments}" expands to one line of atom indices per fragment.
# A run counts as successful when the expected output files exist, even if
# Multiwfn then aborts on end of input while unwinding its menus.

DEFAULT_RECIPES: dict[str, list[str]] = {
    # main function 5: real-space function on a grid -> 2: export cube
    "orbital_cube": ["5", "4", "{orbital}", "{grid}", "2", "0", "q"],
    "grid_function": ["5", "{function}", "{grid}", "2", "0", "q"],
    # main function 20: weak interaction -> 11: IGMH; post-processing 3
    # writes dg_inter.cub, dg_intra.cub, dg.cub and sl2r.cub
    "igmh": ["20", "11", "{n_fragments}", "{fragments}", "{grid}", "3", "0", "0", "q"],
    # main function 2: topology analysis; search CPs from nuclei (2), atom
    # pair midpoints (3), triangles (4), pyramids (5); 7 -> 0 writes CPprop.txt
    "aim": ["2", "2", "3", "4", "5", "7", "0", "-10", "q"],
}

# Function numbers in main function 5
DEFAULT_GRID_FUNCTION_CODES: dict[str, int] = {
    "density": 1,
    "gradient": 2,
    "laplacian": 3,
    "esp": 12,
    "sl2r": 15,
}

RECIPE_OUTPUTS: dict[str, tuple[str, ...]] = {
    "orbital_cube": ("*.cub", "*.cube"),
    "grid_function": ("*.cub", "*.cube"),
    "igmh": ("dg_inter.cub", "sl2r.cub"),
    "aim": ("CPprop.txt",),
}


def _recipe_overrides() -> dict:
    path = os.environ.get("CATGO_MULTIWFN_RECIPES") or str(
        Path.home() / ".catgo" / "multiwfn_recipes.json"
    )
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load_recipes() -> tuple[dict[str, list[str]], dict[str, int]]:
    overrides = _recipe_overrides()
    recipes = dict(DEFAULT_RECIPES)
    for name, keys in overrides.items():
        if name in recipes and isinstance(keys, list):
            recipes[name] = [str(k) for k in keys]
    codes = dict(DEFAULT_GRID_FUNCTION_CODES)
    extra = overrides.get("grid_function_codes")
    if isinstance(extra, dict):
        codes.update({str(k): int(v) for k, v in extra.items()})
    return recipes, codes


def expand_recipe(keys: list[str], params: dict) -> list[str]:
    out: list[str] = []
    for key in keys:
        if key == "{fragments}":
            out.extend(params.get("fragments", []))
        else:
            out.append(key.format(**params))
    return out


def fragment_spec(atoms: list[int]) -> str:
    """1-based atom indices as Multiwfn ranges, e.g. [1,2,3,7] -> "1-3,7"."""
    idx = sorted(set(int(a) for a in atoms))
    if not idx or idx[0] < 1:
        raise ValueError("fragment atoms are 1-based and must not be empty")
    parts, start, prev = [], idx[0], idx[0]
    for a in idx[1:] + [None]:
        if a is not None and a == prev + 1:
            prev = a
            continue
        parts.append(str(start) if start == prev else f"{start}-{prev}")
        if a is not None:
            start = prev = a
    return ",".join(parts)


def run_multiwfn(
    wavefunction: str | Path,
    keystrokes: list[str],
    workdir: str | Path,
    executable: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> tuple[str, int | None]:
    """Run Multiwfn on ``wavefunction`` feeding ``keystrokes`` (one per line).

    Returns ``(stdout, returncode)``; ``returncode`` is None after a timeout.
    Callers judge success by the files written to ``workdir``.
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
        out = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        return out, None
    except OSError as exc:
        raise MultiwfnError(f"Could not start Multiwfn ({executable}): {exc}") from exc
    return (proc.stdout or "") + (proc.stderr or ""), proc.returncode


def run_recipe(
    wavefunction: str | Path,
    recipe: str,
    params: dict,
    executable: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    keystrokes: list[str] | None = None,
) -> dict[str, str]:
    """Run a named recipe and return ``{output filename: text}``.

    Raises :class:`MultiwfnError` (with the tail of Multiwfn's output) when
    none of the recipe's expected files was written.
    """
    if executable is None:
        executable, _ = find_multiwfn()
    if not executable:
        raise MultiwfnError("Multiwfn was not found")
    if keystrokes is None:
        recipes, _ = load_recipes()
        keystrokes = expand_recipe(recipes[recipe], params)
    with tempfile.TemporaryDirectory(prefix="catgo-multiwfn-") as tmp:
        workdir = Path(tmp)
        stdout, code = run_multiwfn(wavefunction, keystrokes, workdir, executable, timeout)
        found: dict[str, str] = {}
        for pattern in RECIPE_OUTPUTS[recipe]:
            for path in sorted(workdir.glob(pattern), key=lambda p: p.stat().st_mtime):
                found[path.name] = path.read_text(errors="replace")
        if not found:
            reason = "timed out" if code is None else f"finished (exit code {code})"
            raise MultiwfnError(
                f"Multiwfn {reason} without writing {', '.join(RECIPE_OUTPUTS[recipe])}. "
                f"Keystrokes: {' '.join(keystrokes)}. Last output:\n{stdout[-1500:]}"
            )
        return found


def _last_cube(outputs: dict[str, str]) -> str:
    # dicts keep insertion order, which run_recipe sorts by modification time
    return list(outputs.values())[-1]


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
    outputs = run_recipe(
        wavefunction, "orbital_cube",
        {"orbital": orbital_index, "grid": GRID_CHOICES[grid]}, executable, timeout,
    )
    return _last_cube(outputs)


def grid_function_cube(
    wavefunction: str | Path,
    function: str,
    grid: str = "medium",
    executable: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Cube of a real-space function: density, gradient, laplacian, esp, sl2r."""
    if grid not in GRID_CHOICES:
        raise ValueError(f"grid must be one of {sorted(GRID_CHOICES)}")
    _, codes = load_recipes()
    if function not in codes:
        raise ValueError(f"function must be one of {sorted(codes)}")
    outputs = run_recipe(
        wavefunction, "grid_function",
        {"function": codes[function], "grid": GRID_CHOICES[grid]}, executable, timeout,
    )
    return _last_cube(outputs)


def igmh_cubes(
    wavefunction: str | Path,
    fragments: list[list[int]],
    grid: str = "medium",
    executable: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, str]:
    """IGMH analysis; returns at least ``dg_inter.cub`` and ``sl2r.cub``."""
    if grid not in GRID_CHOICES:
        raise ValueError(f"grid must be one of {sorted(GRID_CHOICES)}")
    if len(fragments) < 2:
        raise ValueError("IGMH needs at least two fragments")
    specs = [fragment_spec(f) for f in fragments]
    outputs = run_recipe(
        wavefunction, "igmh",
        {"n_fragments": len(specs), "fragments": specs, "grid": GRID_CHOICES[grid]},
        executable, timeout,
    )
    missing = [n for n in ("dg_inter.cub", "sl2r.cub") if n not in outputs]
    if missing:
        raise MultiwfnError(f"IGMH run did not write {', '.join(missing)}")
    return outputs


def aim_cpprop(
    wavefunction: str | Path,
    executable: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """AIM critical-point search; returns the text of CPprop.txt."""
    return run_recipe(wavefunction, "aim", {}, executable, timeout)["CPprop.txt"]
