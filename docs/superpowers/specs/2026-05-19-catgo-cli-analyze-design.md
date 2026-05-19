# CatGO CLI — P2 `analyze` Group Design Spec

Date: 2026-05-19
Status: Approved (brainstorming) — pending spec review
Stacks on: P1 (`feature/catgo-cli`, PR #93). Branch `feature/catgo-cli-analyze`,
independent PR base = `feature/catgo-cli` (do not bundle, do not wait for #93 merge).

## Goal

Add the P2 `analyze` operation group to the CatGO CLI: read local DFT output
files and produce publication-grade DOS / band / COHP figures (optionally
interactively editable) plus a transition-state imaginary-mode visualization
and Gibbs-correction numbers from frequency data — all offline (import-mode,
no server), reusing the P1 registry/Session/dual-form skeleton.

## Requirements (confirmed)

- Four ops in one slice: `dos`, `band`, `cohp`, `freq`.
- Backend = call underlying parser/compute libs directly (offline import-mode);
  inputs are local DFT output files.
- Every plotting analysis (`dos`/`band`/`cohp`) emits: a publication-grade
  figure **and** a data dump (json/csv) **and** key numbers to stdout.
- `dos` and `cohp` (pCOHP) — and `band` for free, same path — support an
  optional interactive GUI edit step (`--edit`): drag/move labels, change plot
  parameters, then save; edits are written back as reproducible matplotlib
  code. Publication-grade.
- `freq` is **not** a 2-D plot. Purpose: visualize the **imaginary-frequency**
  vibration direction in CatGO to confirm transition-state (TS) correctness.
  Also compute the **Gibbs correction** values.
- `freq` Gibbs: `--mode adsorbed|gas` + `--T` + `--P` (+ soft-mode cutoff,
  spin). Imaginary frequencies excluded from thermodynamics (with warning).
- All scientific parameters live-tunable, no hardcoding (project convention).

## Approach

**A — SciencePlots publication baseline + pylustrator `--edit`** (chosen over
hand-rolled draggable-annotation/Qt-figure-options, and over export-editable-
script). Architecture reuses P1: `OperationRegistry` single source of truth,
`(session, params) -> OpResult` handlers, registry-driven argparse + menu.

`pylustrator` (rgerum/pylustrator): `pylustrator.start()` before any figure
overloads `plt.show()` to a GUI where subplots/text/labels are dragged and
properties edited; on save it writes the changes back as plain matplotlib
code (reproducible; works with pylustrator removed). `SciencePlots` provides
the publication rcParams baseline so the non-edit path is already journal-
quality.

Sources: [pylustrator (GitHub)](https://github.com/rgerum/pylustrator) ·
[pylustrator: code generation for reproducible figures (arXiv 1910.00279)](https://ar5iv.labs.arxiv.org/html/1910.00279) ·
[pylustrator docs](https://pylustrator.readthedocs.io/en/latest/)

## §1 Architecture & backend

Stack: branch `feature/catgo-cli-analyze` from `feature/catgo-cli` HEAD;
independent PR base = `feature/catgo-cli`. Reuse P1 registry/Session/dual-form;
add only the `analyze` group.

Backend: underlying libs, import-mode, no server. Inputs = local DFT files:

| op | input file | parse lib | compute lib |
|----|-----------|-----------|-------------|
| `dos` | vaspout.h5 | `catgo_dos.io.read_vaspout_h5` | `catgo_dos.pdos.compute_pdos_groups` (+ d-band center) |
| `band` | vasprun.xml (+ optional KPOINTS) | `pymatgen.io.vasp.Vasprun` | pymatgen band-structure API |
| `cohp` | COHPCAR.lobster | `catgo_cohp.io.parse_cohpcar` | parsed data plotted directly |
| `freq` | OUTCAR | local OUTCAR parser in `vib.py` (faithful port of `vasp_freq_parser` regex) | `catgo.utils.gibbs_calculator.calc_adsorbed` / `calc_gas` |

**Key freq-backend decision (verified against the env):** pymatgen `Vasprun`
in this build has **no** normal-mode API (`normalmode_eigenvals`/
`normalmode_eigenvecs` absent — confirmed by introspection), so it cannot be
used. The existing `catgo.utils.vasp_freq_parser.parse_vasp_frequencies` is
async + SSH-only (its `f =`/`f/i =` frequency and eigenvector regexes parse
the *output of remote `awk`* over an SSH `conn.run`) — unfit for an offline
local CLI. Decision: `vib.py` ships a **local, pure-Python OUTCAR parser**
that reads a local `OUTCAR` and applies the same proven frequency/eigenvector
regex patterns as `vasp_freq_parser` (the AWK was only an SSH transport
optimization, not the parsing logic). Input = `OUTCAR`. Thermo reuses
`gibbs_calculator` (sync, frequency lists) unchanged.

**Extension-package bootstrap (dos/cohp):** `catgo_dos` and `catgo_cohp` are
local packages under `extensions/dos-analysis/` and `extensions/cohp-analysis/`
(each its own `pyproject.toml`), **not installed in the CLI environment**
(routers lazy-import them server-side). The `dos`/`cohp` handlers must
bootstrap `sys.path` with these two directories (resolved relative to the
repo root from `__file__`) before the lazy import, and raise a clear
`OpError` if the extension directory or package is missing. Confirmed APIs:
`catgo_dos.io.read_vaspout_h5(path) -> VaspData`, `catgo_dos.pdos` /
`catgo_dos.dband`; `catgo_cohp.io.parse_cohpcar(path) -> COHPData` /
`parse_icohplist`.

File structure (new, under `server/catgo/cli/`, P1 conventions):
- `ops_analyze.py` — handlers `dos`/`band`/`cohp`/`freq`, signature
  `(session, params) -> OpResult`.
- `plotting.py` — publication plot stack: SciencePlots baseline +
  `--edit`→`pylustrator.start()`; shared `render(spec, out, edit, latex)`.
- `vib.py` — freq-only: vasprun normal modes → imaginary-mode oscillation
  trajectory writer + thermo orchestration.
- `ops.py` (P1) — append 4 `registry.add(...)`, `group="analyze"`,
  all `mutates=False`.
- `server/pyproject.toml` — add `matplotlib>=3.8`, `scienceplots`,
  `pylustrator>=1.3`. pylustrator imported lazily only under `--edit`.

Registry reuse: analyze ops auto-appear as argparse subcommands and in the
interactive menu `analyze` group (P1 `_add_op_subparsers`/`_banner`
unchanged). `freq` has no `--edit` (not a plot). `dos`/`band`/`cohp` accept
`--edit`/`--dump`/`-o`.

## §2 Publication plotting + pylustrator edit (dos/band/cohp)

`plotting.py` single responsibility: analysis data → publication figure,
optionally interactively editable.

Baseline (no `--edit`, direct):
- `import scienceplots; plt.style.use(['science','no-latex'])`
  (`--latex` flag opts into LaTeX rendering).
- 300 dpi; output format from `-o` extension: `.pdf` (vector, default
  preferred) / `.svg` / `.png`. No `-o` → default `<analysis>.pdf`.
- Consistent: axis labels, Fermi-energy reference line (DOS/COHP on E−E_f),
  legend, colorblind-safe palette.

Edit mode (`--edit`):
- Lazy `import pylustrator; pylustrator.start()` (before any figure; heavy
  dependency loaded only here).
- Build figure normally → `plt.show()` opens pylustrator GUI: drag/resize
  subplots, move + edit text labels, property panel for params/colors.
- GUI "Save" writes changes back as plain matplotlib code into companion
  script `<out>.plot.py` (reproduces the publication figure with pylustrator
  removed); user exports final `<out>.pdf` from the GUI.
- No display ($DISPLAY empty and not macOS) → clear `OpError` advising to
  drop `--edit` for a static figure (no crash, no hang).

Shared interface:

```python
# plotting.py
@dataclass
class PlotSpec:
    kind: str                       # "dos" | "band" | "cohp"
    x: list[float]
    series: list[tuple]             # (label, y, style)
    xlabel: str
    ylabel: str
    vlines: list[float]             # e.g. Fermi level
    title: str

def render(spec: PlotSpec, out: Path, edit: bool, latex: bool) -> Path:
    """Return written path. edit=True opens the pylustrator GUI."""
```

Each handler maps its lib parse result into a `PlotSpec` (DOS fill, band
multi k-path segments, COHP +/- mirror live in the handler); `render` only
owns style/edit/write — clean boundary, independently testable (spec→file
under matplotlib `Agg`, no GUI path).

## §3 freq op — TS imaginary-mode animation + Gibbs correction

`vib.py` single responsibility: vasprun normal modes → (a) imaginary-mode
oscillation trajectory for viewing the TS in CatGO, (b) Gibbs-correction
numbers. `freq` handler orchestrates; no plotting, no pylustrator.

Parse: local pure-Python OUTCAR parser in `vib.py` (faithful to
`vasp_freq_parser` regex) → real/imaginary frequencies (cm⁻¹), per-mode
per-atom eigenvectors (displacements), positions, masses, atom types,
`num_imaginary`. Imaginary = OUTCAR `f/i =` lines.

(a) TS imaginary-mode animation (core purpose: confirm TS in CatGO):
- `num_imaginary` reported: a proper TS has exactly 1 imaginary frequency.
  N=1 ✓ TS; N=0 not a TS (minimum); N≥2 higher-order saddle.
- For each imaginary mode (or `--mode-index`): oscillation frames
  `R(t) = R₀ + A·sin(2πt)·ê`, t over `--frames` (default 20) frames,
  amplitude `--amplitude` (default 0.5 Å).
- Write multi-frame `<out>.xyz` (extxyz; per-frame comment with frame index).
  Message instructs the user to open it in CatGO (catgo-load skill / curl
  upload) and play frames to confirm the reaction-coordinate direction.
- Default animates imaginary modes only; `--all-modes` animates every mode
  (debug; low cost, retained).

(b) Gibbs correction (`--mode adsorbed|gas`):
- Imaginary frequencies excluded from thermodynamics (standard); if any →
  stderr warning "N imaginary modes excluded from G correction".
- `adsorbed`: `calc_adsorbed(real_freqs_cm, imag_freqs_cm, T, freq_cutoff)`.
- `gas`: `calc_gas(real_freqs_cm, imag_freqs_cm, positions, masses_amu,
  atom_types, T, P_Pa, n_unpaired)`; positions/masses/atom_types derived
  from the vasprun structure.
- Parameters (all tunable, no hardcoding): `--T` (K, default 298.15);
  `--P` (bar, default 1.0 → ×1e5 → Pa); `--freq-cutoff` (cm⁻¹, default
  50.0, soft-mode cutoff); `--unpaired` (default 0, gas only, → n_unpaired).
- Output to stdout + `--dump` (json): ZPE, ΔU_vib, T·S, H_corr, G_corr
  (eV), num_imaginary, count of soft modes raised to the cutoff.

Single op, dual output: `catgo freq OUTCAR --mode adsorbed -o ts.xyz`
writes the TS animation xyz **and** prints the Gibbs correction. Independent:
no imaginary freq → skip animation (message "0 imaginary — not a TS; no
animation"), still print Gibbs, exit 0; `--no-anim` skips animation when
only numbers are wanted.

Param schema (registry, `mutates=False`, no `--edit`): `input`=OUTCAR;
`--mode` (adsorbed|gas, choices); `--T --P --freq-cutoff --unpaired
--frames --amplitude --mode-index --all-modes --no-anim --dump -o`.

## §4 Output / error handling / testing

Output contract (every analyze op):
- `OpResult.artifact` = primary product path (dos/band/cohp: figure file;
  freq: TS animation xyz, or None if `--no-anim` / no imaginary freq).
- `OpResult.message` = key numbers to stdout (dos: d-band center eV;
  band: band gap eV + direct/indirect; cohp: ICOHP at E_f; freq: G_corr eV
  + num_imaginary).
- `--dump <path.json|.csv>` optional: raw numeric arrays (DOS/COHP curve
  points, band k-path energies, freq list + G decomposition); `.json`
  default, `.csv` flattened.
- `structure=None` (analyze is read-only, `mutates=False`, no undo snapshot).

Error handling (P1 `OpError`/`SessionError` boundary; no raw tracebacks):

| Scenario | Behavior |
|---|---|
| Input missing / wrong format (xml given where h5 expected) | `OpError` "expected vaspout.h5 for dos, got ..." exit 1 |
| Parse failure (lib raises / corrupt file / no normalmode data) | caught → `OpError("parse failed: …")`, no crash |
| `--edit` with no display | `OpError` "no display; drop --edit for static figure" exit 1 (no hang) |
| pylustrator/scienceplots not installed | `OpError` with install hint (plot ops only; freq independent) |
| freq 0 imaginary without `--no-anim` | not an error: skip animation, stderr note, still print Gibbs, exit 0 |
| freq `--mode gas` missing vasprun geometry | `OpError` naming the missing inputs |
| output exists without `--force` | P1 behavior: refuse + hint (menu asks y/N) |

Testing (TDD, pytest, `server/tests/cli/`, P1 style):
1. Fixtures: locate minimal real vaspout.h5 / OUTCAR (with imaginary freq + eigenvectors)
   / COHPCAR.lobster / band vasprun.xml in repo; if absent, `pytest.skip`
   with a note that the fixture must be supplied (do not fabricate
   scientific data).
2. Handler unit (matplotlib `Agg`, no GUI): each op parse→produce file;
   assert artifact exists, message contains the key number (d-band / gap /
   ICOHP / G_corr) anchored to the fixture's known value.
3. freq-specific: known-imaginary fixture → correct num_imaginary; TS
   animation frame count == `--frames`; atom count conserved each frame;
   imaginary freq not in G; `adsorbed` vs `gas` G_corr matches a direct
   `gibbs_calculator` call (anti-drift); `--no-anim` writes no xyz but
   still prints G.
4. Error injection: wrong format, corrupt file, `--edit` with no DISPLAY
   (mock env), missing package (mock ImportError) → `OpError` + exit 1,
   no traceback.
5. dump: `--dump x.json` schema correct and re-parseable.
6. Dual-form equivalence: argparse vs menu, same op+params → same OpResult
   (P1 `test_equivalence` style).
7. pylustrator path: `--edit` logic with monkeypatched stub (no real GUI /
   CI has no display) — assert `pylustrator.start` called; no-display →
   `OpError` degrade.

CI: default static path has no GUI dependency, runnable standalone; missing
fixtures skip (not red).

## Out of scope (YAGNI / later P2/P3)

- Non-imaginary normal-mode plotting/IR spectra (only TS-confirmation viz).
- DOS spin-decomposition UI beyond what `compute_pdos_groups` returns.
- Pushing figures/animation to a running CatGO viewer (HTTP) — that is P3
  viewer-sync; P2 writes files, CatGO loading is the existing catgo-load
  capability.
- HPC submission of analysis jobs (separate P2 HPC slice).
