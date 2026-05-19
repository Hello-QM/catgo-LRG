# CatGO CLI — P2 `analyze` Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `analyze` op group (`dos`/`band`/`cohp`/`freq`) to the CatGO CLI: offline, publication-grade DOS/band/COHP figures with an optional pylustrator GUI edit, plus a TS imaginary-mode animation and adsorbed/gas Gibbs-correction numbers from a local OUTCAR.

**Architecture:** Reuse the P1 `OperationRegistry`/`Session`/dual-form skeleton (`server/catgo/cli/`). Handlers `(session, params) -> OpResult`, `group="analyze"`, `mutates=False`. Backend = call underlying libs directly in import-mode: `catgo_dos`/`catgo_cohp` (in `extensions/`, sys.path-bootstrapped), pymatgen for band, a new local OUTCAR parser for freq, `catgo.utils.gibbs_calculator` for thermo. Plotting via SciencePlots baseline; `--edit` lazily starts pylustrator.

**Tech Stack:** Python 3.11, P1 CLI infra, pymatgen (`Vasprun` band structure), `matplotlib>=3.8` (Agg for tests), `scienceplots`, `pylustrator>=1.3` (lazy, `--edit` only), `catgo_dos`/`catgo_cohp` extension packages, `catgo.utils.gibbs_calculator`.

Spec: `docs/superpowers/specs/2026-05-19-catgo-cli-analyze-design.md`. Branch `feature/catgo-cli-analyze` (off `feature/catgo-cli` HEAD `9ee147f4`); independent PR base = `feature/catgo-cli`. Work from `/home/james0001/project/catgo-LRG` (MAIN repo); tests run `cd server && python -m pytest tests/cli/ -v`. Every task: confirm `git rev-parse --abbrev-ref HEAD` == `feature/catgo-cli-analyze` (repo may be detached at same commit → `git checkout feature/catgo-cli-analyze`; never reset/rebase/touch main).

---

## File Structure

- `server/catgo/cli/_extpath.py` — repo-root resolver + `ensure_extension(name)` that sys.path-inserts `extensions/<name>/` and returns the imported top package; raises `OpError` if missing.
- `server/catgo/cli/plotting.py` — `PlotSpec` dataclass + `render(spec, out, edit, latex)`: SciencePlots static baseline; `--edit` → lazy pylustrator; no-display degrade.
- `server/catgo/cli/vib.py` — local OUTCAR freq/eigenvector parser (`parse_outcar_freqs`), TS oscillation writer (`write_mode_animation`), gibbs orchestration helper.
- `server/catgo/cli/ops_analyze.py` — handlers `dos`, `band`, `cohp`, `freq`.
- `server/catgo/cli/ops.py` (P1) — append 4 `registry.add(...)`.
- `server/pyproject.toml` — add matplotlib/scienceplots/pylustrator deps.
- Tests: `server/tests/cli/test_extpath.py`, `test_plotting.py`, `test_vib.py`, `test_ops_analyze.py`, plus an appended dual-form check in `test_equivalence.py`.

Run all P2 tests: `cd server && python -m pytest tests/cli/ -v`

---

### Task 1: Dependencies + extension-path bootstrap

**Files:**
- Modify: `server/pyproject.toml` (add deps)
- Create: `server/catgo/cli/_extpath.py`
- Test: `server/tests/cli/test_extpath.py`

- [ ] **Step 1: Write the failing test**

`server/tests/cli/test_extpath.py`:

```python
import pytest
from catgo.cli._extpath import ensure_extension, repo_root
from catgo.cli.adapter import OpError


def test_repo_root_has_extensions():
    assert (repo_root() / "extensions").is_dir()


def test_ensure_extension_imports_catgo_dos():
    mod = ensure_extension("dos-analysis", "catgo_dos")
    assert hasattr(mod, "io")  # catgo_dos.io exists


def test_ensure_extension_missing_raises():
    with pytest.raises(OpError):
        ensure_extension("does-not-exist", "nope_pkg")


def test_ensure_extension_import_error_wrapped(monkeypatch):
    # present dir but broken/absent package -> OpError, cause preserved
    import importlib
    def _boom(name):
        raise ImportError("simulated missing transitive dep")
    monkeypatch.setattr(importlib, "import_module", _boom)
    with pytest.raises(OpError) as ei:
        ensure_extension("dos-analysis", "catgo_dos")
    assert isinstance(ei.value.__cause__, ImportError)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_extpath.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.cli._extpath'`

- [ ] **Step 3: Write minimal implementation**

`server/catgo/cli/_extpath.py`:

```python
"""Make the local extension packages (extensions/<name>/) importable.

catgo_dos / catgo_cohp live under extensions/ with their own pyproject and
are NOT installed in the CLI environment. The analyze handlers call this to
sys.path-insert the extension dir before a lazy import, with a clean OpError
if absent.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType

from catgo.cli.adapter import OpError


def repo_root() -> Path:
    # server/catgo/cli/_extpath.py -> parents[3] == repo root
    return Path(__file__).resolve().parents[3]


def ensure_extension(ext_dir: str, package: str) -> ModuleType:
    """sys.path-insert extensions/<ext_dir>/ and import <package>.

    Raises OpError if the directory or package is missing.
    """
    ext_path = repo_root() / "extensions" / ext_dir
    if not ext_path.is_dir():
        raise OpError(
            f"extension '{ext_dir}' not found at {ext_path} — "
            f"required for this analysis")
    p = str(ext_path)
    # prepend is safe: extension dirs contain only namespaced catgo_*
    # packages (+ README/pyproject), nothing that shadows stdlib/site
    if p not in sys.path:
        sys.path.insert(0, p)
    try:
        return importlib.import_module(package)
    except ImportError as exc:
        raise OpError(
            f"cannot import '{package}' from {ext_path}: {exc}") from exc
```

Add an `analyze` **optional** extra to `server/pyproject.toml` (NOT core
`dependencies` — pylustrator pulls a heavy Qt stack and neither P1 nor the
freq path uses these; the plot handlers lazy-import with a clean OpError).
Under `[project.optional-dependencies]`, after the existing `ml = [...]`
block, add:

```toml
analyze = [
    "matplotlib>=3.8",
    "scienceplots>=2.1",
    "pylustrator>=1.3",
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_extpath.py -v`
Expected: PASS (3 passed). If `catgo_dos` import still fails, the env lacks numpy/h5 deps of the extension — in that case the second test may xfail; report it (do NOT weaken the test). The bootstrap itself (path insert + OpError on missing) is the deliverable.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/_extpath.py server/tests/cli/test_extpath.py server/pyproject.toml
git commit -m "feat(cli): extension-path bootstrap + analyze deps (mpl/scienceplots/pylustrator)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: `PlotSpec` + static publication `render`

**Files:**
- Create: `server/catgo/cli/plotting.py`
- Test: `server/tests/cli/test_plotting.py`

- [ ] **Step 1: Write the failing test**

`server/tests/cli/test_plotting.py`:

```python
import matplotlib
matplotlib.use("Agg")  # headless, no GUI

from pathlib import Path
from catgo.cli.plotting import PlotSpec, render


def _spec():
    return PlotSpec(
        kind="dos", x=[0.0, 1.0, 2.0],
        series=[("s", [1.0, 2.0, 1.0], {})],
        xlabel="E - E_f (eV)", ylabel="DOS", vlines=[0.0], title="t")


def test_render_writes_png(tmp_path):
    out = tmp_path / "p.png"
    r = render(_spec(), out, edit=False, latex=False)
    assert r == out and out.exists() and out.stat().st_size > 0


def test_render_writes_pdf(tmp_path):
    out = tmp_path / "p.pdf"
    render(_spec(), out, edit=False, latex=False)
    assert out.exists() and out.stat().st_size > 0


def test_missing_matplotlib_raises_operror(tmp_path, monkeypatch):
    import sys, pytest
    from catgo.cli.adapter import OpError
    # simulate matplotlib absent (optional [analyze] extra not installed)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", None)
    with pytest.raises(OpError) as ei:
        render(_spec(), tmp_path / "p.png", edit=False, latex=False)
    assert "catgo-engine[analyze]" in str(ei.value)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_plotting.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.cli.plotting'`

- [ ] **Step 3: Write minimal implementation**

`server/catgo/cli/plotting.py`:

```python
"""Publication plotting for analyze ops.

Static baseline uses SciencePlots rcParams. `--edit` lazily starts
pylustrator (GUI, writes edits back as reproducible matplotlib code).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from catgo.cli.adapter import OpError


@dataclass
class PlotSpec:
    kind: str                       # "dos" | "band" | "cohp"
    x: list
    series: list                    # list[(label, y, style_dict)]
    xlabel: str
    ylabel: str
    vlines: list = field(default_factory=list)
    hlines: list = field(default_factory=list)
    title: str = ""


def _pyplot():
    """Lazy matplotlib.pyplot, or a clean OpError if the optional
    [analyze] extra is not installed (matplotlib is NOT a core dep)."""
    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        raise OpError(
            "matplotlib not installed (needed for analyze plots) — "
            "pip install 'catgo-engine[analyze]'") from exc
    return plt


def _apply_style(latex: bool) -> None:
    plt = _pyplot()
    try:
        import scienceplots  # noqa: F401  (registers styles)
    except ImportError:
        plt.rcParams.update({"figure.dpi": 300, "font.size": 9})
        return
    plt.style.use(["science"] if latex else ["science", "no-latex"])


def _build_figure(spec: PlotSpec):
    plt = _pyplot()
    fig, ax = plt.subplots(figsize=(3.3, 2.5))
    for label, y, style in spec.series:
        ax.plot(spec.x, y, label=label, **(style or {}))
    for vx in spec.vlines:
        ax.axvline(vx, color="0.5", lw=0.6, ls="--")
    for vy in spec.hlines:
        ax.axhline(vy, color="0.5", lw=0.6, ls="--")
    ax.set_xlabel(spec.xlabel)
    ax.set_ylabel(spec.ylabel)
    if spec.title:
        ax.set_title(spec.title)
    if any(lbl for lbl, _, _ in spec.series):
        ax.legend(frameon=False, fontsize=7)
    fig.tight_layout()
    return fig


def render(spec: PlotSpec, out, edit: bool, latex: bool) -> Path:
    out = Path(out)
    _apply_style(latex)
    if edit:
        return _render_edit(spec, out, latex)
    plt = _pyplot()
    fig = _build_figure(spec)
    fig.savefig(str(out), dpi=300, bbox_inches="tight")
    plt.close(fig)
    return out


def _render_edit(spec: PlotSpec, out: Path, latex: bool) -> Path:
    raise OpError("edit mode not yet available")  # implemented in Task 3
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_plotting.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/plotting.py server/tests/cli/test_plotting.py
git commit -m "feat(cli): PlotSpec + static publication render (SciencePlots, Agg-safe)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: pylustrator `--edit` path + no-display degrade

**Files:**
- Modify: `server/catgo/cli/plotting.py` (replace `_render_edit`)
- Test: `server/tests/cli/test_plotting.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_plotting.py`:

```python
import os, sys, types
import pytest
from catgo.cli.adapter import OpError


def test_edit_no_display_degrades(monkeypatch, tmp_path):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.setattr(sys, "platform", "linux")
    with pytest.raises(OpError) as ei:
        render(_spec(), tmp_path / "p.pdf", edit=True, latex=False)
    assert "--edit" in str(ei.value)


def test_edit_calls_pylustrator_start(monkeypatch, tmp_path):
    monkeypatch.setenv("DISPLAY", ":0")
    calls = {}
    fake = types.ModuleType("pylustrator")
    fake.start = lambda: calls.setdefault("start", True)
    monkeypatch.setitem(sys.modules, "pylustrator", fake)
    import matplotlib.pyplot as plt
    monkeypatch.setattr(plt, "show", lambda *a, **k: calls.setdefault("show", True))
    out = render(_spec(), tmp_path / "p.pdf", edit=True, latex=False)
    assert calls.get("start") and calls.get("show")
    assert out == tmp_path / "p.pdf"


def test_edit_pylustrator_missing_raises_operror(monkeypatch, tmp_path):
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setitem(sys.modules, "pylustrator", None)  # import -> ImportError
    with pytest.raises(OpError) as ei:
        render(_spec(), tmp_path / "p.pdf", edit=True, latex=False)
    assert "catgo-engine[analyze]" in str(ei.value)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_plotting.py -k edit -v`
Expected: FAIL — `OpError: edit mode not yet available`

- [ ] **Step 3: Write minimal implementation**

Replace `_render_edit` in `server/catgo/cli/plotting.py` with:

```python
def _has_display() -> bool:
    import os
    import sys
    if sys.platform == "darwin":
        return True
    return bool(os.environ.get("DISPLAY")
                or os.environ.get("WAYLAND_DISPLAY"))


def _render_edit(spec: PlotSpec, out: Path, latex: bool) -> Path:
    if not _has_display():
        raise OpError(
            "no display available for --edit; drop --edit to write a "
            "static publication figure instead")
    try:
        import pylustrator
    except ImportError as exc:
        raise OpError(
            "pylustrator not installed (needed for --edit) — "
            "pip install 'catgo-engine[analyze]'") from exc
    # NOTE: pylustrator.start() monkeypatches plt.figure/plt.show
    # process-wide and is NOT reversible. Acceptable: --edit is a terminal
    # user action; a long-lived shell should run it last.
    pylustrator.start()
    plt = _pyplot()
    _build_figure(spec)   # GUI captures this figure; user edits it
    plt.show()            # blocks in the pylustrator editor
    # Per design §2: the user exports the final figure to `out` from the
    # GUI (pylustrator also writes reproducible code back). We deliberately
    # do NOT write a fresh un-edited baseline to `out` here — that would
    # silently discard the user's interactive edits.
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_plotting.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/plotting.py server/tests/cli/test_plotting.py
git commit -m "feat(cli): pylustrator --edit path + no-display OpError degrade

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: local OUTCAR frequency/eigenvector parser (`vib.parse_outcar_freqs`)

**Files:**
- Create: `server/catgo/cli/vib.py`
- Test: `server/tests/cli/test_vib.py`

- [ ] **Step 1: Write the failing test**

`server/tests/cli/test_vib.py` (synthetic minimal OUTCAR — deterministic, no big fixture):

```python
import textwrap
from catgo.cli.vib import parse_outcar_freqs

# 2-atom system, 1 real + 1 imaginary mode. Mirrors VASP OUTCAR layout:
# "ions per type", a POSITION/mass block, and the f= / f/i= mode blocks
# each followed by an "X Y Z dx dy dz" eigenvector table.
_OUTCAR = textwrap.dedent("""\
   ions per type =               1 1
  POMASS =   1.00 16.00
      direct lattice vectors                 reciprocal lattice vectors
     5.000000  0.000000  0.000000     0.200000  0.000000  0.000000
     0.000000  5.000000  0.000000     0.000000  0.200000  0.000000
     0.000000  0.000000  8.000000     0.000000  0.000000  0.125000
 position of ions in cartesian coordinates  (Angst):
   0.0000000  0.0000000  0.0000000
   0.0000000  0.0000000  1.1000000

 Eigenvectors and eigenvalues of the dynamical matrix
 ----------------------------------------------------

   1 f  =    5.000000 THz    31.4159 2PiTHz  166.7800 cm-1    20.6789 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.000000  0.700000
      0.000000  0.000000  1.100000     0.000000  0.000000 -0.700000

   2 f/i =    1.000000 THz     6.2832 2PiTHz   33.3560 cm-1     4.1358 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.100000  0.000000  0.000000
      0.000000  0.000000  1.100000    -0.100000  0.000000  0.000000
""")


def test_parse_outcar_freqs(tmp_path):
    p = tmp_path / "OUTCAR"
    p.write_text(_OUTCAR)
    r = parse_outcar_freqs(p)
    assert r.real_freqs_cm == [166.78]
    assert r.imag_freqs_cm == [33.356]
    assert r.num_imaginary == 1
    assert r.total_atoms == 2
    assert len(r.eigenvectors) == 2          # one per mode
    assert len(r.eigenvectors[0]) == 2       # per atom
    assert r.eigenvectors[0][1] == [0.0, 0.0, -0.7]
    assert r.masses_amu == [1.0, 16.0]
    assert r.atom_types == [0, 1]            # H -> type 0, O -> type 1
    assert len(r.positions) == 2
    assert r.lattice == [[5.0, 0.0, 0.0], [0.0, 5.0, 0.0], [0.0, 0.0, 8.0]]
    assert r.imag_mode_indices == [1]        # eigenvectors[1] is the imag mode


import pytest
from catgo.cli.adapter import OpError

# real VASP prints the freq table BEFORE the eigenvector section (no vec
# rows there) and again interleaved with eigenvectors; the parser must
# dedup by "only blocks with vec rows count". 3 real modes, no imaginary.
_OUTCAR_DEDUP = textwrap.dedent("""\
   ions per type =               1 1
  POMASS =   1.00 16.00; ZVAL = 1.0
  POMASS =   1.00 16.00
 position of ions in cartesian coordinates  (Angst):
   0.0000000  0.0000000  0.0000000
   0.0000000  0.0000000  1.1000000

   1 f  =    9.0 THz   56.5 2PiTHz  300.0000 cm-1   37.2 meV
   2 f  =    6.0 THz   37.7 2PiTHz  200.0000 cm-1   24.8 meV
   3 f  =    3.0 THz   18.8 2PiTHz  100.0000 cm-1   12.4 meV

 Eigenvectors and eigenvalues of the dynamical matrix
 ----------------------------------------------------

   1 f  =    9.0 THz   56.5 2PiTHz  300.0000 cm-1   37.2 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.000000  0.100000
      0.000000  0.000000  1.100000     0.000000  0.000000 -0.100000

   2 f  =    6.0 THz   37.7 2PiTHz  200.0000 cm-1   24.8 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.200000  0.000000
      0.000000  0.000000  1.100000     0.000000 -0.200000  0.000000

   3 f  =    3.0 THz   18.8 2PiTHz  100.0000 cm-1   12.4 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.300000  0.000000  0.000000
      0.000000  0.000000  1.100000    -0.300000  0.000000  0.000000
""")


def test_dedup_leading_freq_table_not_double_counted(tmp_path):
    p = tmp_path / "OUTCAR"
    p.write_text(_OUTCAR_DEDUP)
    r = parse_outcar_freqs(p)
    # 3 real modes, the pre-eigenvector listing must NOT double-count
    assert r.real_freqs_cm == [300.0, 200.0, 100.0]
    assert r.imag_freqs_cm == []
    assert r.num_imaginary == 0
    assert len(r.eigenvectors) == 3
    # POMASS summary line (no ';'/ZVAL) chosen over the per-POTCAR line
    assert r.masses_amu == [1.0, 16.0]
    assert r.atom_types == [0, 1]


def test_missing_outcar_raises():
    with pytest.raises(OpError):
        parse_outcar_freqs("/no/such/OUTCAR")


def test_unparseable_ions_per_type_raises(tmp_path):
    bad = tmp_path / "OUTCAR"
    bad.write_text("garbage with no ions-per-type line\n")
    with pytest.raises(OpError):
        parse_outcar_freqs(bad)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_vib.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.cli.vib'`

- [ ] **Step 3: Write minimal implementation**

`server/catgo/cli/vib.py`:

```python
"""Local OUTCAR vibrational parser + TS imaginary-mode animation.

A faithful local port of the frequency/eigenvector regexes used by
catgo.utils.vasp_freq_parser (which is SSH/AWK-only). Pure Python, reads a
local OUTCAR. pymatgen Vasprun has no normal-mode API in this build.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from catgo.cli.adapter import OpError

_F_RE = re.compile(
    r"^\s*(\d+)\s+f\s+=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+"
    r"([\d.]+)\s+cm-1\s+([\d.]+)\s+meV")
_FI_RE = re.compile(
    r"^\s*(\d+)\s+f/i\s*=\s+([\d.]+)\s+THz\s+([\d.]+)\s+2PiTHz\s+"
    r"([\d.]+)\s+cm-1\s+([\d.]+)\s+meV")
_VEC_RE = re.compile(
    r"^\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+"
    r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*$")


@dataclass
class FreqData:
    real_freqs_cm: list = field(default_factory=list)
    imag_freqs_cm: list = field(default_factory=list)
    # eigenvectors indexed in OUTCAR line order; real modes come first
    # in standard VASP output but downstream MUST use imag_mode_indices
    # rather than assume the boundary is len(real_freqs_cm).
    eigenvectors: list = field(default_factory=list)  # [mode][atom][dx,dy,dz]
    imag_mode_indices: list = field(default_factory=list)  # idx into eigenvectors
    positions: list = field(default_factory=list)      # [atom][x,y,z]
    lattice: list = field(default_factory=list)        # 3x3 direct Å
    masses_amu: list = field(default_factory=list)
    atom_types: list = field(default_factory=list)     # [atom] -> type idx
    total_atoms: int = 0
    num_imaginary: int = 0


def parse_outcar_freqs(path) -> FreqData:
    p = Path(path)
    if not p.exists():
        raise OpError(f"OUTCAR not found: {p}")
    text = p.read_text(errors="ignore")  # OUTCARs are ASCII; read whole
    lines = text.splitlines()

    m = re.search(r"ions per type\s*=\s*([\d ]+)", text)
    if not m:
        raise OpError("could not parse 'ions per type' from OUTCAR")
    counts = [int(x) for x in m.group(1).split()]
    total = sum(counts)

    # Per-POTCAR lines look like "POMASS =  16.00; ZVAL = 6.00" (one
    # value). The per-type SUMMARY line is "POMASS = m1 m2 ..." (only
    # floats, no ';'/ZVAL, one value per element type) — that is the one
    # we want; grabbing the first POMASS match would bind a single-type
    # POTCAR header on real multi-element OUTCARs.
    masses: list = []
    for ln in lines:
        s = ln.strip()
        if not s.startswith("POMASS") or ";" in s or "ZVAL" in s:
            continue
        mm = re.match(r"POMASS\s*=\s*([\d.\s]+)$", s)
        if mm:
            cand = [float(x) for x in mm.group(1).split()]
            if len(cand) == len(counts):
                masses = cand
                break

    masses_per_atom: list = []
    atom_types: list = []
    for ti, c in enumerate(counts):
        mass = masses[ti] if ti < len(masses) else 0.0
        masses_per_atom += [mass] * c
        atom_types += [ti] * c

    pos: list = []
    for i, ln in enumerate(lines):
        if "position of ions in cartesian coordinates" in ln:
            for j in range(i + 1, i + 1 + total):
                parts = lines[j].split()
                if len(parts) >= 3:
                    pos.append([float(parts[0]), float(parts[1]),
                                float(parts[2])])
            break

    # Direct lattice vectors: VASP prints
    #   "direct lattice vectors                 reciprocal lattice vectors"
    # then 3 rows "ax ay az   bx by bz"; we take the first 3 floats per row.
    # Needed so the written extxyz carries Lattice=... and CatGO can
    # render cross-cell bonds for slab TS visualization.
    lat: list = []
    for i, ln in enumerate(lines):
        if "direct lattice vectors" in ln:
            tmp: list = []
            for j in range(i + 1, i + 4):
                parts = lines[j].split()
                if len(parts) >= 3:
                    tmp.append([float(parts[0]), float(parts[1]),
                                float(parts[2])])
            if len(tmp) == 3:
                lat = tmp
                break

    data = FreqData(total_atoms=total, masses_amu=masses_per_atom,
                    atom_types=atom_types, positions=pos, lattice=lat)
    i = 0
    while i < len(lines):
        ln = lines[i]
        mr, mi = _F_RE.match(ln), _FI_RE.match(ln)
        if mr or mi:
            cm = float((mr or mi).group(4))
            # OUTCAR prints the freq table twice; the pre-eigenvector
            # listing has no vec rows after each line, so blocks with no
            # eigenvectors are skipped below (robust dedup substitute).
            vecs: list = []
            j = i + 2  # skip the "X Y Z dx dy dz" header line
            while j < len(lines):
                vm = _VEC_RE.match(lines[j])
                if not vm:
                    break
                vecs.append([float(vm.group(4)), float(vm.group(5)),
                             float(vm.group(6))])
                j += 1
            if vecs:  # only blocks that actually carry eigenvectors
                eig_idx = len(data.eigenvectors)
                if mr:
                    data.real_freqs_cm.append(cm)
                else:
                    data.imag_freqs_cm.append(cm)
                    data.imag_mode_indices.append(eig_idx)
                data.eigenvectors.append(vecs)
            i = j
            continue
        i += 1
    data.num_imaginary = len(data.imag_freqs_cm)
    return data
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_vib.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/vib.py server/tests/cli/test_vib.py
git commit -m "feat(cli): local OUTCAR freq/eigenvector parser (faithful, no SSH)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: TS imaginary-mode animation writer (`vib.write_mode_animation`)

**Files:**
- Modify: `server/catgo/cli/vib.py` (add function)
- Test: `server/tests/cli/test_vib.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_vib.py`:

```python
import math
from catgo.cli.vib import write_mode_animation


def test_write_mode_animation(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR)
    data = parse_outcar_freqs(p)
    out = tmp_path / "ts.xyz"
    n_frames = 10
    n = write_mode_animation(
        data, mode_index=1, out=out, frames=n_frames, amplitude=0.5,
        symbols=["H", "O"])
    assert n == n_frames
    txt = out.read_text().splitlines()
    stride = 2 + data.total_atoms                     # count + comment + N
    # frame count-lines at known strides (robust; no string.count False+)
    for k in range(n_frames):
        assert txt[k * stride].strip() == str(data.total_atoms)
    # extxyz header keys present (CatGO needs Lattice + Properties for PBC)
    assert "Lattice=" in txt[1]
    assert "Properties=species:S:1:pos:R:3" in txt[1]
    atom_lines = [l for l in txt if l.startswith(("H ", "O "))]
    assert len(atom_lines) == n_frames * data.total_atoms
    # Numeric anchor: frame 0 (sin=0) -> equilibrium positions exactly
    f0_h = atom_lines[0].split()
    assert float(f0_h[1]) == 0.0 and float(f0_h[2]) == 0.0
    assert float(f0_h[3]) == 0.0
    # mode_index=1 eigenvector for atom 0 = (0.1,0,0); at k=frames//4 sin=1
    qk = n_frames // 4
    f_qk_h = atom_lines[qk * data.total_atoms].split()
    expected_x = 0.0 + 0.5 * math.sin(2.0 * math.pi * qk / n_frames) * 0.1
    assert abs(float(f_qk_h[1]) - expected_x) < 1e-6


def test_write_mode_animation_bad_mode_index_raises(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR)
    data = parse_outcar_freqs(p)
    with pytest.raises(OpError):
        write_mode_animation(data, mode_index=99, out=tmp_path / "x.xyz",
                              frames=5, amplitude=0.1, symbols=["H", "O"])


def test_write_mode_animation_symbols_len_mismatch_raises(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR)
    data = parse_outcar_freqs(p)
    with pytest.raises(OpError):
        write_mode_animation(data, mode_index=0, out=tmp_path / "x.xyz",
                              frames=5, amplitude=0.1, symbols=["H"])  # 1 != 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_vib.py::test_write_mode_animation -v`
Expected: FAIL — `ImportError: cannot import name 'write_mode_animation'`

- [ ] **Step 3: Write minimal implementation**

Hoist `import math` to the top of `server/catgo/cli/vib.py` (next to `import re`) instead of mid-file (PEP 8). Then append the function:

```python
def write_mode_animation(data: FreqData, mode_index: int, out,
                          frames: int, amplitude: float,
                          symbols: list) -> int:
    """Write an extxyz oscillation trajectory R(t)=R0+A*sin(2*pi*t)*e
    for one normal mode, with Lattice= and Properties= keys so CatGO
    renders PBC cross-cell bonds. Returns the number of frames written.

    t = k/frames over [0,1) — no-duplicate-endpoint loop convention
    (matches CatGO's loop_playback default).
    """
    if not (0 <= mode_index < len(data.eigenvectors)):
        raise OpError(
            f"mode_index {mode_index} out of range "
            f"(0..{len(data.eigenvectors) - 1})")
    if len(symbols) != data.total_atoms:
        raise OpError(
            f"symbols length {len(symbols)} != atoms {data.total_atoms}")
    vec = data.eigenvectors[mode_index]
    out_path = Path(out)
    # extxyz comment header: Lattice + Properties (omit Lattice if the
    # OUTCAR lattice wasn't parsed — viewers fall back to non-periodic).
    if data.lattice and len(data.lattice) == 3:
        l = data.lattice
        lat_str = ('Lattice="'
                   + " ".join(f"{v:.6f}" for row in l for v in row)
                   + '" ')
    else:
        lat_str = ""
    header_keys = f'{lat_str}Properties=species:S:1:pos:R:3'
    with out_path.open("w") as fh:
        for k in range(frames):
            t = k / frames
            s = amplitude * math.sin(2.0 * math.pi * t)
            fh.write(f"{data.total_atoms}\n")
            fh.write(f'{header_keys} frame={k} mode={mode_index}\n')
            for a in range(data.total_atoms):
                x = data.positions[a][0] + s * vec[a][0]
                y = data.positions[a][1] + s * vec[a][1]
                z = data.positions[a][2] + s * vec[a][2]
                fh.write(f"{symbols[a]} {x:.6f} {y:.6f} {z:.6f}\n")
    return frames
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_vib.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/vib.py server/tests/cli/test_vib.py
git commit -m "feat(cli): TS imaginary-mode oscillation animation writer (extxyz)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: `freq` handler (parse + Gibbs adsorbed/gas + animation)

**Files:**
- Create: `server/catgo/cli/ops_analyze.py` (freq only this task)
- Test: `server/tests/cli/test_ops_analyze.py`

- [ ] **Step 1: Write the failing test**

`server/tests/cli/test_ops_analyze.py`:

```python
import textwrap
import pytest
from catgo.cli.session import Session
from catgo.cli import ops_analyze
from catgo.cli.adapter import OpError

_OUTCAR = textwrap.dedent("""\
   ions per type =               1 1
  POMASS =   1.00 16.00
      direct lattice vectors                 reciprocal lattice vectors
     5.000000  0.000000  0.000000     0.200000  0.000000  0.000000
     0.000000  5.000000  0.000000     0.000000  0.200000  0.000000
     0.000000  0.000000  8.000000     0.000000  0.000000  0.125000
 position of ions in cartesian coordinates  (Angst):
   0.0000000  0.0000000  0.0000000
   0.0000000  0.0000000  1.1000000

 Eigenvectors and eigenvalues of the dynamical matrix
 ----------------------------------------------------

   1 f  =    5.000000 THz    31.4159 2PiTHz  166.7800 cm-1    20.6789 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.000000  0.700000
      0.000000  0.000000  1.100000     0.000000  0.000000 -0.700000

   2 f/i =    1.000000 THz     6.2832 2PiTHz   33.3560 cm-1     4.1358 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.100000  0.000000  0.000000
      0.000000  0.000000  1.100000    -0.100000  0.000000  0.000000
""")


def _outcar(tmp_path):
    p = tmp_path / "OUTCAR"; p.write_text(_OUTCAR); return p


def test_freq_adsorbed_gibbs_and_anim(tmp_path):
    src = _outcar(tmp_path); out = tmp_path / "ts.xyz"
    s = Session()
    r = ops_analyze.freq(s, {"input": str(src), "mode": "adsorbed",
                             "out": str(out), "symbols": "H,O"})
    assert r.ok
    assert "G_corr" in r.message and "imaginary=1" in r.message
    assert out.exists()                       # 1 imaginary -> animation written
    assert r.artifact == out


def test_freq_gibbs_matches_library(tmp_path):
    from catgo.utils.gibbs_calculator import calc_adsorbed
    src = _outcar(tmp_path)
    s = Session()
    r = ops_analyze.freq(s, {"input": str(src), "mode": "adsorbed",
                             "no_anim": True})
    direct = calc_adsorbed([166.78], [33.356], 298.15, 50.0)
    assert f"{direct['g_corr_ev']:.4f}" in r.message  # anti-drift


def test_freq_no_anim_skips_xyz(tmp_path):
    src = _outcar(tmp_path)
    r = ops_analyze.freq(Session(), {"input": str(src), "mode": "adsorbed",
                                     "no_anim": True})
    assert r.ok and r.artifact is None


def test_freq_bad_input_errors(tmp_path):
    with pytest.raises(OpError):
        ops_analyze.freq(Session(), {"input": str(tmp_path / "nope"),
                                     "mode": "adsorbed"})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'catgo.cli.ops_analyze'`

- [ ] **Step 3: Write minimal implementation**

`server/catgo/cli/ops_analyze.py`:

```python
"""analyze-group handlers: dos / band / cohp / freq. (session, params)->OpResult.

Offline import-mode; mutates=False; structure unchanged.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from catgo.cli.adapter import OpError
from catgo.cli.registry import OpResult


def _dump(path, obj) -> None:
    Path(path).write_text(json.dumps(obj, indent=2))


def freq(session, params: dict) -> OpResult:
    from catgo.cli.vib import parse_outcar_freqs, write_mode_animation
    from catgo.utils.gibbs_calculator import calc_adsorbed, calc_gas

    src = params.get("input")
    if not src:
        raise OpError("freq requires an OUTCAR path")
    data = parse_outcar_freqs(src)

    mode = params.get("mode", "adsorbed")
    T = float(params.get("T", 298.15))
    cutoff = float(params.get("freq_cutoff", 50.0))
    if data.num_imaginary:
        print(f"warning: {data.num_imaginary} imaginary mode(s) excluded "
              f"from Gibbs correction", file=sys.stderr)
    if mode == "adsorbed":
        g = calc_adsorbed(data.real_freqs_cm, data.imag_freqs_cm, T, cutoff)
    elif mode == "gas":
        g = calc_gas(data.real_freqs_cm, data.imag_freqs_cm, data.positions,
                     data.masses_amu, data.atom_types, T,
                     float(params.get("P", 1.0)) * 1e5,
                     int(params.get("unpaired", 0)))
    else:
        raise OpError(f"--mode must be adsorbed|gas, got '{mode}'")

    artifact = None
    anim_note = ""
    if not params.get("no_anim"):
        if data.num_imaginary == 0:
            anim_note = "  (0 imaginary - not a TS; no animation)"
        else:
            out = params.get("out")
            if not out:
                raise OpError("-o/--out required to write the TS animation "
                              "(or pass --no-anim)")
            syms = params.get("symbols")
            if not syms:
                raise OpError("--symbols (comma-separated, one per atom) "
                              "required for the animation")
            symbols = [s.strip() for s in str(syms).split(",")]
            # imaginary modes are appended after reals in eigenvectors order
            idx = int(params.get("mode_index",
                                 len(data.real_freqs_cm)))
            write_mode_animation(
                data, mode_index=idx, out=Path(out),
                frames=int(params.get("frames", 20)),
                amplitude=float(params.get("amplitude", 0.5)),
                symbols=symbols)
            artifact = Path(out)

    if params.get("dump"):
        _dump(params["dump"], g)

    msg = (f"G_corr={g['g_corr_ev']:.4f} eV  ZPE={g['zpe_ev']:.4f}  "
           f"H_corr={g['h_corr_ev']:.4f}  TS={g['ts_vib_ev']:.4f}  "
           f"imaginary={data.num_imaginary}{anim_note}")
    return OpResult(ok=True, message=msg, artifact=artifact, structure=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -v`
Expected: PASS (4 passed). If `calc_gas` import path differs, read `server/catgo/utils/gibbs_calculator.py` and adjust the import only — do NOT change the assertion values.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops_analyze.py server/tests/cli/test_ops_analyze.py
git commit -m "feat(cli): freq handler — OUTCAR -> Gibbs (adsorbed/gas) + TS animation

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: `dos` handler (vaspout.h5 → PDOS plot + d-band + dump)

**Files:**
- Modify: `server/catgo/cli/ops_analyze.py` (add `dos`)
- Test: `server/tests/cli/test_ops_analyze.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_ops_analyze.py`:

```python
import os


def _find_fixture(*names):
    base = os.path.join(os.path.dirname(__file__), "fixtures")
    for n in names:
        p = os.path.join(base, n)
        if os.path.exists(p):
            return p
    return None


def test_dos_handler(tmp_path):
    h5 = _find_fixture("dos.h5", "vaspout.h5")
    if h5 is None:
        pytest.skip("no vaspout.h5 fixture in tests/cli/fixtures/ — supply one")
    out = tmp_path / "dos.png"
    r = ops_analyze.dos(Session(), {"input": h5, "out": str(out),
                                    "atoms": "all"})
    assert r.ok and out.exists()
    assert "d-band" in r.message.lower()


def test_dos_wrong_format_errors(tmp_path):
    bad = tmp_path / "x.xml"; bad.write_text("<xml/>")
    with pytest.raises(OpError):
        ops_analyze.dos(Session(), {"input": str(bad), "out": str(tmp_path/"o.png")})


def test_dos_missing_file_clean_error(tmp_path):
    with pytest.raises(OpError) as ei:
        ops_analyze.dos(Session(), {"input": str(tmp_path / "nope.h5"),
                                    "out": str(tmp_path / "o.png")})
    assert "not found" in str(ei.value)


def test_dos_bad_atoms_clean_error(tmp_path, monkeypatch):
    # Stub the extension imports so the validation runs without a real h5.
    import sys, types, importlib
    # Build a fake catgo_dos with the minimum surface dos() touches before
    # atoms validation runs: read_vaspout_h5 returns a stub with .nions.
    fake_io = types.ModuleType("catgo_dos.io")
    class _V:
        nions = 1
    fake_io.read_vaspout_h5 = lambda p: _V()
    fake_pdos = types.ModuleType("catgo_dos.pdos")
    fake_pdos.compute_pdos = lambda *a, **k: None  # not reached
    fake_dband = types.ModuleType("catgo_dos.dband")
    fake_dband.compute_d_center = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "catgo_dos.io", fake_io)
    monkeypatch.setitem(sys.modules, "catgo_dos.pdos", fake_pdos)
    monkeypatch.setitem(sys.modules, "catgo_dos.dband", fake_dband)
    h5 = tmp_path / "x.h5"; h5.write_bytes(b"\x89HDF")  # minimal stub
    with pytest.raises(OpError) as ei:
        ops_analyze.dos(Session(), {"input": str(h5),
                                    "atoms": "abc,xyz",
                                    "out": str(tmp_path / "o.png")})
    assert "comma-separated integers" in str(ei.value)


def test_dos_happy_path_monkeypatched(tmp_path, monkeypatch):
    # Cover the happy path (CI lacks real vaspout.h5) by stubbing the
    # catgo_dos surface dos() consumes.
    import sys, types
    import numpy as np

    class _V:
        nions = 2
    class _PDOS:
        grid = np.linspace(-5.0, 5.0, 11)
        pdos = np.ones((1, 11))      # (nspin, ngrid)
    class _DB:
        eps_rel = -1.234

    fake_io = types.ModuleType("catgo_dos.io")
    fake_io.read_vaspout_h5 = lambda p: _V()
    fake_pdos = types.ModuleType("catgo_dos.pdos")
    fake_pdos.compute_pdos = lambda vd, atoms, channels: _PDOS()
    fake_dband = types.ModuleType("catgo_dos.dband")
    fake_dband.compute_d_center = lambda vd, atoms: _DB()
    monkeypatch.setitem(sys.modules, "catgo_dos.io", fake_io)
    monkeypatch.setitem(sys.modules, "catgo_dos.pdos", fake_pdos)
    monkeypatch.setitem(sys.modules, "catgo_dos.dband", fake_dband)

    h5 = tmp_path / "x.h5"; h5.write_bytes(b"\x89HDF")
    out = tmp_path / "dos.png"
    dump = tmp_path / "dos.json"
    r = ops_analyze.dos(Session(),
                        {"input": str(h5), "out": str(out),
                         "atoms": "all", "channels": "d",
                         "dump": str(dump)})
    assert r.ok and out.exists()
    import re
    assert re.search(r"d-band center = -?\d+\.\d{4} eV", r.message)
    assert "-1.2340" in r.message            # the eps_rel value
    import json
    payload = json.loads(dump.read_text())
    assert payload["d_band_center_eV"] == -1.234
    assert len(payload["energy"]) == 11
    assert len(payload["pdos"]) == 11
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -k dos -v`
Expected: FAIL — `AttributeError: module 'catgo.cli.ops_analyze' has no attribute 'dos'`

- [ ] **Step 3: Write minimal implementation**

Append to `server/catgo/cli/ops_analyze.py`:

```python
def dos(session, params: dict) -> OpResult:
    from catgo.cli._extpath import ensure_extension
    from catgo.cli.plotting import PlotSpec, render

    src = params.get("input")
    if not src or not str(src).lower().endswith((".h5", ".hdf5")):
        raise OpError("dos expects a vaspout.h5 file (.h5)")
    if not Path(src).exists():
        raise OpError(f"vaspout.h5 not found: {src}")
    ensure_extension("dos-analysis", "catgo_dos")
    from catgo_dos.io import read_vaspout_h5
    from catgo_dos.pdos import compute_pdos
    try:
        vdata = read_vaspout_h5(str(src))
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"failed to parse vaspout.h5: {exc}") from exc

    atoms_p = params.get("atoms", "all")
    if atoms_p in ("all", None):
        atoms = list(range(vdata.nions))
    else:
        try:
            atoms = [int(x) for x in str(atoms_p).split(",")]
        except ValueError as exc:
            raise OpError(
                f"--atoms must be comma-separated integers or 'all', "
                f"got '{atoms_p}'") from exc

    channels = params.get("channels", "spd")
    res = compute_pdos(vdata, atoms, channels)

    from catgo_dos.dband import compute_d_center
    try:
        dband = compute_d_center(vdata, atoms)
        dband_val = float(getattr(dband, "eps_rel",
                                   getattr(dband, "center", dband)))
    except (TypeError, ValueError, IndexError, AttributeError) as exc:
        # Narrow catch: catgo_dos returns NaN-DBandCenter for non-d
        # systems natively (no exception). This fires only on real
        # errors (bad atoms, shape skew, version drift) — surface them.
        import sys as _sys
        print(f"warning: d-band fallback ({exc.__class__.__name__}: {exc})",
              file=_sys.stderr)
        dband_val = float("nan")

    energy = list(res.grid)
    total = list(res.pdos.sum(axis=0))   # collapse spins → (ngrid,)
    spec = PlotSpec(
        kind="dos", x=energy,
        series=[("PDOS", total, {})],
        xlabel="E - E_f (eV)", ylabel="DOS (states/eV)",
        vlines=[0.0])
    out = Path(params["out"]) if params.get("out") else Path("dos.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    if params.get("dump"):
        _dump(params["dump"], {"energy": energy, "pdos": total,
                               "d_band_center_eV": dband_val})
    return OpResult(ok=True,
                    message=f"d-band center = {dband_val:.4f} eV -> {out}",
                    artifact=out, structure=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -k dos -v`
Expected: PASS — `test_dos_wrong_format_errors` passes; `test_dos_handler` passes if a fixture exists, else SKIPS (acceptable). If `compute_pdos`/`compute_d_center`/`VaspData` attribute names differ from the assumptions, read `extensions/dos-analysis/catgo_dos/{io,pdos,dband}.py` and adjust the calls minimally to the real API — keep the PlotSpec/render and OpResult contract identical.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops_analyze.py server/tests/cli/test_ops_analyze.py
git commit -m "feat(cli): dos handler — vaspout.h5 -> PDOS publication plot + d-band

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: `cohp` handler (COHPCAR.lobster → pCOHP plot + ICOHP + dump)

**Files:**
- Modify: `server/catgo/cli/ops_analyze.py` (add `cohp`)
- Test: `server/tests/cli/test_ops_analyze.py` (append)

- [ ] **Step 1: Write the failing test**

Append:

```python
def test_cohp_handler(tmp_path):
    cc = _find_fixture("COHPCAR.lobster", "cohpcar.lobster")
    if cc is None:
        pytest.skip("no COHPCAR.lobster fixture — supply one")
    out = tmp_path / "cohp.png"
    r = ops_analyze.cohp(Session(), {"input": cc, "out": str(out)})
    assert r.ok and out.exists()
    assert "icohp" in r.message.lower()


def test_cohp_wrong_format_errors(tmp_path):
    bad = tmp_path / "x.h5"; bad.write_text("nope")
    with pytest.raises(OpError):
        ops_analyze.cohp(Session(), {"input": str(bad),
                                     "out": str(tmp_path / "o.png")})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -k cohp -v`
Expected: FAIL — `AttributeError: module 'catgo.cli.ops_analyze' has no attribute 'cohp'`

- [ ] **Step 3: Write minimal implementation**

Append to `server/catgo/cli/ops_analyze.py`:

```python
def cohp(session, params: dict) -> OpResult:
    from catgo.cli._extpath import ensure_extension
    from catgo.cli.plotting import PlotSpec, render

    src = params.get("input")
    if not src or "cohpcar" not in str(src).lower():
        raise OpError("cohp expects a COHPCAR.lobster file")
    ensure_extension("cohp-analysis", "catgo_cohp")
    from catgo_cohp.io import parse_cohpcar
    try:
        cd = parse_cohpcar(str(src))
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"failed to parse COHPCAR: {exc}") from exc

    # cd.cohp shape (n_pairs+1, n_energies); index 0 = average. Plot average,
    # sign-flipped so bonding is positive (pCOHP convention).
    e = list(cd.energies)
    avg = [-v for v in list(cd.cohp[0])]
    # ICOHP at E_f: integrated value of the average at the Fermi energy
    import bisect
    fi = min(range(len(e)), key=lambda k: abs(e[k] - cd.efermi))
    icohp_ef = float(cd.icohp[0][fi])

    spec = PlotSpec(
        kind="cohp", x=e, series=[("-pCOHP (avg)", avg, {})],
        xlabel="E - E_f (eV)", ylabel="-pCOHP",
        vlines=[cd.efermi], title="")
    out = Path(params["out"]) if params.get("out") else Path("cohp.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    if params.get("dump"):
        _dump(params["dump"], {"energy": e, "neg_pcohp_avg": avg,
                               "icohp_at_Ef": icohp_ef})
    return OpResult(ok=True,
                    message=f"ICOHP at E_f = {icohp_ef:.4f} -> {out}",
                    artifact=out, structure=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -k cohp -v`
Expected: PASS — `test_cohp_wrong_format_errors` passes; `test_cohp_handler` skips without a fixture. If `COHPData` field names differ, read `extensions/cohp-analysis/catgo_cohp/io.py` and adjust attribute access minimally; keep the OpResult/PlotSpec contract.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops_analyze.py server/tests/cli/test_ops_analyze.py
git commit -m "feat(cli): cohp handler — COHPCAR.lobster -> -pCOHP plot + ICOHP

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: `band` handler (vasprun.xml → band structure plot + gap + dump)

**Files:**
- Modify: `server/catgo/cli/ops_analyze.py` (add `band`)
- Test: `server/tests/cli/test_ops_analyze.py` (append)

- [ ] **Step 1: Write the failing test**

Append:

```python
def test_band_handler(tmp_path):
    vr = _find_fixture("band_vasprun.xml", "vasprun.xml")
    if vr is None:
        pytest.skip("no band vasprun.xml fixture — supply one")
    out = tmp_path / "band.png"
    r = ops_analyze.band(Session(), {"input": vr, "out": str(out)})
    assert r.ok and out.exists()
    assert "gap" in r.message.lower()


def test_band_missing_input_errors():
    with pytest.raises(OpError):
        ops_analyze.band(Session(), {"input": None})


def test_band_missing_file_clean_error(tmp_path):
    with pytest.raises(OpError) as ei:
        ops_analyze.band(Session(), {"input": str(tmp_path / "vasprun.xml")})
    assert "not found" in str(ei.value)


def test_band_happy_path_monkeypatched(tmp_path, monkeypatch):
    import sys, types
    import numpy as np
    from pymatgen.electronic_structure.core import Spin

    class _BS:
        distance = [0.0, 0.5, 1.0]
        # real shape: dict[Spin -> ndarray (nbands, nkpoints)]; plot ALL bands
        bands = {Spin.up: np.array([[0.0, 0.5, 1.0], [1.5, 2.0, 2.5]])}
        def get_band_gap(self):
            return {"energy": 1.234, "direct": True}

    class _VR:
        def __init__(self, *a, **kw): pass
        def get_band_structure(self, line_mode=True): return _BS()

    fake_outputs = types.ModuleType("pymatgen.io.vasp.outputs")
    fake_outputs.Vasprun = _VR
    monkeypatch.setitem(sys.modules, "pymatgen.io.vasp.outputs", fake_outputs)

    vr = tmp_path / "vasprun.xml"; vr.write_text("<?xml?>")
    out = tmp_path / "band.png"
    dump = tmp_path / "band.json"
    r = ops_analyze.band(Session(),
                         {"input": str(vr), "out": str(out),
                          "dump": str(dump)})
    assert r.ok and out.exists()
    import re
    assert re.search(r"band gap = -?\d+\.\d{4} eV \((direct|indirect)\)", r.message)
    assert "1.2340" in r.message
    import json
    payload = json.loads(dump.read_text())
    assert payload["band_gap_eV"] == 1.234
    assert payload["kind"] == "direct"
    assert len(payload["distance"]) == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -k band -v`
Expected: FAIL — `AttributeError: module 'catgo.cli.ops_analyze' has no attribute 'band'`

- [ ] **Step 3: Write minimal implementation**

Append to `server/catgo/cli/ops_analyze.py`:

```python
def band(session, params: dict) -> OpResult:
    from catgo.cli.plotting import PlotSpec, render

    src = params.get("input")
    if not src:
        raise OpError("band requires a vasprun.xml path")
    if not Path(src).exists():
        raise OpError(f"vasprun.xml not found: {src}")
    try:
        from pymatgen.io.vasp.outputs import Vasprun
        vr = Vasprun(str(src), parse_projected_eigen=False)
        bs = vr.get_band_structure(line_mode=True)
    except Exception as exc:  # noqa: BLE001
        raise OpError(f"failed to parse band structure: {exc}") from exc

    gap = bs.get_band_gap()
    gap_ev = float(gap.get("energy") or 0.0)
    kind = "direct" if gap.get("direct") else "indirect"

    # Plot ALL bands per spin (publication-grade). Label only the first
    # band of each spin channel and only when the system is spin-polarized
    # (otherwise the legend gets crowded for no information).
    dists = list(bs.distance)
    multi_spin = len(bs.bands) > 1
    spin_colors = ["C0", "C3"]   # up, down
    series = []
    for si, (spin, bands_arr) in enumerate(bs.bands.items()):
        color = spin_colors[si] if si < len(spin_colors) else None
        spin_name = getattr(spin, "name", str(spin))
        for bi in range(len(bands_arr)):
            label = (spin_name if multi_spin and bi == 0 else "")
            style = {"color": color} if color else {}
            series.append((label, list(bands_arr[bi]), style))
    spec = PlotSpec(
        kind="band", x=dists, series=series or [("", [], {})],
        xlabel="k-path", ylabel="E - E_f (eV)",
        vlines=[], hlines=[0.0])      # y=0 = Fermi reference
    out = Path(params["out"]) if params.get("out") else Path("band.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    if params.get("dump"):
        _dump(params["dump"], {"distance": dists,
                               "band_gap_eV": gap_ev, "kind": kind})
    return OpResult(
        ok=True,
        message=f"band gap = {gap_ev:.4f} eV ({kind}) -> {out}",
        artifact=out, structure=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/test_ops_analyze.py -k band -v`
Expected: PASS — `test_band_missing_input_errors` passes; `test_band_handler` skips without a fixture. If `get_band_structure(line_mode=True)` raises on a non-line-mode vasprun fixture, fall back to `bs = vr.get_band_structure()` — adjust only the parse call, keep the contract.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops_analyze.py server/tests/cli/test_ops_analyze.py
git commit -m "feat(cli): band handler — vasprun.xml -> band structure plot + gap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: register analyze ops + dual-form equivalence

**Files:**
- Modify: `server/catgo/cli/ops.py` (append 4 ops)
- Test: `server/tests/cli/test_equivalence.py` (append), `server/tests/cli/test_argparse.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/cli/test_equivalence.py`:

```python
def test_analyze_ops_registered():
    reg = build_registry()
    for name in ("dos", "band", "cohp", "freq"):
        op = reg.get(name)
        assert op.group == "analyze"
        assert op.mutates is False


def test_freq_via_registry(tmp_path):
    import textwrap
    from catgo.cli.session import Session
    outcar = tmp_path / "OUTCAR"
    outcar.write_text(textwrap.dedent("""\
       ions per type =               1
      POMASS =   1.00
     position of ions in cartesian coordinates  (Angst):
       0.0000000  0.0000000  0.0000000

     Eigenvectors and eigenvalues of the dynamical matrix
     ----------------------------------------------------

       1 f  =    5.000000 THz    31.4159 2PiTHz  166.7800 cm-1    20.6789 meV
                 X         Y         Z           dx          dy          dz
          0.000000  0.000000  0.000000     0.000000  0.000000  1.000000
    """))
    op = build_registry().get("freq")
    r = op.handler(Session(), {"input": str(outcar), "mode": "adsorbed",
                               "no_anim": True})
    assert r.ok and "G_corr" in r.message
```

Append to `server/tests/cli/test_argparse.py`:

```python
def test_analyze_subcommands_in_help():
    out = _run_catgo("--help")
    assert out.returncode == 0
    for c in ("dos", "band", "cohp", "freq"):
        assert c in out.stdout
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && python -m pytest tests/cli/test_equivalence.py tests/cli/test_argparse.py -k "analyze or freq_via" -v`
Expected: FAIL — `KeyError: 'dos'` (not yet registered)

- [ ] **Step 3: Write minimal implementation**

In `server/catgo/cli/ops.py`, add the import and append the four ops inside `build_registry()` before `return reg`:

```python
    from catgo.cli import ops_analyze
    reg.add(Operation(
        name="dos", group="analyze",
        summary="vaspout.h5 -> PDOS publication plot + d-band center",
        params=[
            Param("atoms", str, default="all", help="atom indices or 'all'"),
            Param("channels", str, default="spd",
                  help="orbital spec: s|p|d|spd|... (catgo_dos)"),
            Param("edit", bool, default=False, help="open pylustrator GUI editor"),
            Param("latex", bool, default=False, help="LaTeX text rendering"),
            Param("dump", str, default="", help="also write raw data JSON"),
        ],
        handler=ops_analyze.dos, mutates=False))
    reg.add(Operation(
        name="band", group="analyze",
        summary="vasprun.xml -> band structure plot + gap",
        params=[
            Param("edit", bool, default=False, help="open pylustrator GUI editor"),
            Param("latex", bool, default=False, help="LaTeX text rendering"),
            Param("dump", str, default="", help="also write raw data JSON"),
        ],
        handler=ops_analyze.band, mutates=False))
    reg.add(Operation(
        name="cohp", group="analyze",
        summary="COHPCAR.lobster -> -pCOHP plot + ICOHP",
        params=[
            Param("edit", bool, default=False, help="open pylustrator GUI editor"),
            Param("latex", bool, default=False, help="LaTeX text rendering"),
            Param("dump", str, default="", help="also write raw data JSON"),
        ],
        handler=ops_analyze.cohp, mutates=False))
    reg.add(Operation(
        name="freq", group="analyze",
        summary="OUTCAR -> Gibbs correction + TS imaginary-mode animation",
        params=[
            Param("mode", str, default="adsorbed",
                  help="adsorbed|gas", choices=["adsorbed", "gas"]),
            Param("T", float, default=298.15, help="temperature (K)"),
            Param("P", float, default=1.0, help="pressure (bar, gas)"),
            Param("freq_cutoff", float, default=50.0,
                  help="soft-mode cutoff (cm-1)"),
            Param("unpaired", int, default=0, help="unpaired electrons (gas)"),
            Param("frames", int, default=20, help="animation frames"),
            Param("amplitude", float, default=0.5,
                  help="animation amplitude (A)"),
            Param("mode_index", int, default=-1,
                  help="mode to animate (-1 = first imaginary)"),
            Param("symbols", str, default="",
                  help="comma element symbols, one per atom (animation)"),
            Param("no_anim", bool, default=False,
                  help="skip the TS animation, numbers only"),
            Param("dump", str, default="", help="also write Gibbs JSON"),
        ],
        handler=ops_analyze.freq, mutates=False))
```

Then in `server/catgo/cli/ops_analyze.py` `freq`, change the default
`mode_index` resolution to honor `-1` (first imaginary): replace
`idx = int(params.get("mode_index", len(data.real_freqs_cm)))` with:

```python
            mi = int(params.get("mode_index", -1))
            if mi >= 0:
                idx = mi
            elif data.imag_mode_indices:
                idx = data.imag_mode_indices[0]   # first imaginary mode
            else:
                raise OpError(
                    "no imaginary modes; pass --mode-index for a real mode")
```

(Param types `bool`/`int`/`float`/`str` are already handled by P1
`coerce_param`/argparse; `choices` already supported by P1
`_add_op_subparsers`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && python -m pytest tests/cli/ -v`
Expected: PASS — all P1 + P2 tests; the two new equivalence tests and the
help test pass; ZERO failures (fixture-less dos/band/cohp handler tests
SKIP). Paste the final summary line.

- [ ] **Step 5: Commit**

```bash
git add server/catgo/cli/ops.py server/catgo/cli/ops_analyze.py server/tests/cli/test_equivalence.py server/tests/cli/test_argparse.py
git commit -m "feat(cli): register dos/band/cohp/freq analyze ops (dual-form)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: Full suite + offline smoke + checkpoint

**Files:** Test only.

- [ ] **Step 1: Full suite**

Run: `cd /home/james0001/project/catgo-LRG/server && python -m pytest tests/cli/ -v`
Expected: ALL pass / SKIP (fixture-less), ZERO failures. Paste the summary line and per-file counts. If any FAIL, STOP and report BLOCKED with the traceback.

- [ ] **Step 2: Offline freq smoke (no server, synthetic OUTCAR)**

```bash
cd /home/james0001/project/catgo-LRG/server
python - <<'PY'
import textwrap, pathlib
pathlib.Path("/tmp/OUTCAR").write_text(textwrap.dedent("""\
   ions per type =               1
  POMASS =   1.00
 position of ions in cartesian coordinates  (Angst):
   0.0000000  0.0000000  0.0000000

 Eigenvectors and eigenvalues of the dynamical matrix
 ----------------------------------------------------

   1 f  =    5.000000 THz    31.4159 2PiTHz  166.7800 cm-1    20.6789 meV
             X         Y         Z           dx          dy          dz
      0.000000  0.000000  0.000000     0.000000  0.000000  1.000000
"""))
PY
python -m catgo freq /tmp/OUTCAR --mode adsorbed --no-anim
```
Expected: exit 0, stdout line with `G_corr=… ZPE=… imaginary=0  (0 imaginary - not a TS; no animation)`. Paste actual stdout. Confirm no server/network used.

- [ ] **Step 3: Legacy + P1 intact**

Run (from server/): `python -m catgo --help` and `python -m catgo supercell /tmp/cu.vasp --scaling 2,2,2 -o /tmp/cu222.vasp` (create `/tmp/cu.vasp` first via the P1 smoke one-liner).
Expected: `--help` lists serve/setup/status/stop + slab/supercell/convert/inspect + dos/band/cohp/freq; supercell still works (P1 unbroken). Paste outputs.

- [ ] **Step 4: Checkpoint commit**

```bash
cd /home/james0001/project/catgo-LRG
git add -A server/tests/cli/
git commit -m "test(cli): P2 analyze suite green — offline freq verified

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- §1 backend libs + ext bootstrap → Task 1 (`_extpath`), Tasks 7/8 (dos/cohp use it). ✓
- §1 freq local OUTCAR parser (not pymatgen normalmode) → Task 4. ✓
- §2 SciencePlots static baseline + `render` → Task 2; pylustrator `--edit` + no-display degrade → Task 3. ✓
- §3 freq parse + TS animation + adsorbed/gas Gibbs + all params + dual output + `--no-anim`/0-imag note → Tasks 4,5,6,10. ✓
- §4 outputs (artifact/message/dump, structure=None), error model (wrong format, parse fail, no-display, missing input), tests (handler unit, freq anti-drift vs gibbs lib, dump, dual-form, pylustrator monkeypatch, fixture-skip) → Tasks 2–11. ✓
- Stacking on P1 (branch off feature/catgo-cli, base feature/catgo-cli) → header. ✓
- registry single-source dual-form (analyze auto in argparse + menu) → Task 10 + P1 infra. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output; fixture-absent handled by explicit `pytest.skip`. ✓

**Type consistency:** `PlotSpec(kind,x,series,xlabel,ylabel,vlines,title)` + `render(spec,out,edit,latex)->Path` consistent Tasks 2/3/7/8/9. `FreqData(real_freqs_cm,imag_freqs_cm,eigenvectors,positions,masses_amu,total_atoms,num_imaginary)` consistent Tasks 4/5/6. `parse_outcar_freqs(path)->FreqData`, `write_mode_animation(data,mode_index,out,frames,amplitude,symbols)->int` consistent Tasks 4/5/6. Handlers uniformly `(session,params)->OpResult` with `structure=None`, `mutates=False` in registry (Task 10). `OpError` from `catgo.cli.adapter` throughout. `ensure_extension(ext_dir,package)` consistent Tasks 1/7/8. ✓

**Known risk flagged in-task:** extension lib APIs (`compute_pdos`/`compute_d_center`/`VaspData.n_ions`/`COHPData` fields/pymatgen `get_band_structure`) are grounded in source inspection but may need minimal call-site adjustment against the real API — Tasks 7/8/9 Step 4 instruct reading the actual module and adjusting the call only, preserving the OpResult/PlotSpec contract and assertions. freq path is fully deterministic (synthetic OUTCAR), no fixture risk.
