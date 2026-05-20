"""IR spectrum from a parsed OUTCAR.

Pure functions:
- `parse_born_charges(text, n_atoms)` — extract Z*[a][i][j] from the
  OUTCAR `BORN EFFECTIVE CHARGES` block (present when LEPSILON=.TRUE.).
  Returns None when the block is absent or malformed.
- `compute_ir_spectrum(freqs_cm, eigenvectors, born, …)` — Gaussian-
  broadened spectrum on a 1 cm⁻¹ grid, using BEC-weighted intensities
  when `born` is provided, otherwise uniform = 1.0.
- `write_ir_text(spec, path)` — 2-column text dump.
- `write_ir_plot(spec, path, edit, latex)` — SciencePlots plot via
  the shared `plotting.PlotSpec` / `render` pipeline.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


_BORN_HDR = "BORN EFFECTIVE CHARGES"


@dataclass
class IrSpectrum:
    """Gaussian-broadened IR absorption spectrum on a regular ω-grid."""

    grid_cm: list  # ω-axis, cm⁻¹
    intensity: list  # arb. units (matches grid_cm length)
    used_bec: bool = False  # True iff BEC-weighted intensities used
    n_modes: int = 0  # number of (real) modes that fed the spectrum


def compute_ir_spectrum(
    freqs_cm,
    eigenvectors,
    born,
    emin: Optional[float],
    emax: Optional[float],
    sigma: float = 10.0,
    step_cm: float = 1.0,
) -> IrSpectrum:
    """Broadened IR spectrum.

    S(ω) = Σ_k I_k * exp(-(ω - ω_k)² / (2σ²))

    With BEC: I_k = Σ_j ( Σ_a Σ_i Z*_a[i][j] * e_k[a][i] )²  (sum over
    Cartesian j → scalar per mode, summed over the three E-field
    directions).
    Without BEC: I_k = 1.0 for every real mode (mode-count histogram).

    ω-grid is `[emin, emin+step, …, emax]` (step=1 cm⁻¹). When emin/emax
    are None the grid auto-spans `[min(ω)-4σ, max(ω)+4σ]` clamped to
    ω >= 0.
    """
    if not freqs_cm:
        return IrSpectrum(grid_cm=[], intensity=[],
                          used_bec=born is not None, n_modes=0)

    used_bec = born is not None
    if used_bec:
        intensities = _bec_intensities(eigenvectors, born)
    else:
        intensities = [1.0] * len(freqs_cm)

    lo = emin if emin is not None else max(0.0, min(freqs_cm) - 4 * sigma)
    hi = emax if emax is not None else max(freqs_cm) + 4 * sigma
    if hi <= lo:
        hi = lo + step_cm
    n = int(round((hi - lo) / step_cm)) + 1
    grid = [lo + i * step_cm for i in range(n)]
    two_s_sq = 2.0 * sigma * sigma
    intens = []
    for w in grid:
        total = 0.0
        for f, I in zip(freqs_cm, intensities):
            d = w - f
            total += I * math.exp(-(d * d) / two_s_sq)
        intens.append(total)
    return IrSpectrum(grid_cm=grid, intensity=intens, used_bec=used_bec,
                      n_modes=len(freqs_cm))


def write_ir_plot(spec: IrSpectrum, path, edit: bool = False,
                  latex: bool = False) -> Path:
    """Render the IR spectrum via the shared `plotting.PlotSpec`/`render`
    pipeline (SciencePlots baseline + optional pylustrator `--edit`).

    The matplotlib / scienceplots imports are kept inside `plotting`
    so the `[analyze]` extra error message is reused verbatim.
    """
    from catgo.cli.plotting import PlotSpec, render
    plot_spec = PlotSpec(
        kind="ir",
        x=list(spec.grid_cm),
        series=[("IR", list(spec.intensity), {})],
        xlabel=r"wavenumber (cm$^{-1}$)",
        ylabel="intensity (arb.)",
    )
    return render(plot_spec, path, edit, latex)


def write_ir_text(spec: IrSpectrum, path) -> Path:
    """Dump the spectrum as 2-column text: `freq_cm intensity`.

    A header `# IR spectrum: …` line records the BEC vs uniform regime
    and the mode count so the file is self-describing. Round-trippable
    by `numpy.loadtxt` / shell `awk '/^#/' {next} …`.
    """
    out = Path(path)
    header = (
        f"# IR spectrum  modes={spec.n_modes}  "
        f"intensities={'BEC' if spec.used_bec else 'uniform'}\n"
        "# freq_cm   intensity\n"
    )
    rows = "\n".join(
        f"{w:.6f} {y:.6e}" for w, y in zip(spec.grid_cm, spec.intensity)
    )
    out.write_text(header + rows + "\n")
    return out


def _bec_intensities(eigenvectors, born) -> list:
    """IR intensity per mode k:

        I_k = Σ_j ( Σ_a Σ_i Z*_a[i][j] * e_k[a][i] )²

    Sums are over Cartesian electric-field direction j ∈ {x,y,z}, atom
    index a, and Cartesian displacement direction i ∈ {x,y,z}. Returns
    a plain list of len(eigenvectors). Pure Python (no numpy needed for
    this size).
    """
    out: list[float] = []
    for vec in eigenvectors:
        # vec[a][i] are the per-atom Cartesian displacements of mode k.
        total = 0.0
        for j in range(3):
            s = 0.0
            for a, z in enumerate(born):
                # Defensive: skip atoms missing from eigenvector (shouldn't
                # happen — parser guarantees one per atom — but the test
                # surface deserves a soft floor).
                if a >= len(vec):
                    break
                e_a = vec[a]
                # Σ_i Z*[i][j] * e[i]
                s += sum(z[i][j] * e_a[i] for i in range(3))
            total += s * s
        out.append(total)
    return out


def parse_born_charges(text: str, n_atoms: int
                       ) -> Optional[list[list[list[float]]]]:
    """Parse OUTCAR BEC block. Returns Z*[atom][i][j] or None.

    Format VASP emits (LEPSILON=.TRUE.):

        BORN EFFECTIVE CHARGES (in e, cummulative output)
        ----------------------------------------------------------------
        ion    1
            1     z11  z12  z13
            2     z21  z22  z23
            3     z31  z32  z33
        ion    2
        ...

    Indices: row label (1..3) is the i index (electric-field direction);
    columns are the j indices (displacement direction). VASP convention
    matches the literature definition Z*[a][i][j] = ∂P_i / ∂u_j(a).

    Returns None when:
    - the BORN header is absent;
    - fewer than `n_atoms` blocks parse cleanly;
    - any block has fewer than 3 numeric rows.
    """
    idx = text.find(_BORN_HDR)
    if idx == -1:
        return None
    lines = text[idx:].splitlines()
    out: list[list[list[float]]] = []
    cur = 0
    while cur < len(lines) and len(out) < n_atoms:
        stripped = lines[cur].lstrip()
        if not stripped.startswith("ion"):
            cur += 1
            continue
        # Expect exactly 3 rows of "i  z1 z2 z3" following the ion line
        rows: list[list[float]] = []
        for j in range(cur + 1, cur + 4):
            if j >= len(lines):
                return None
            parts = lines[j].split()
            if len(parts) < 4:
                return None
            try:
                rows.append([float(parts[1]), float(parts[2]),
                             float(parts[3])])
            except ValueError:
                return None
        out.append(rows)
        cur += 4
    if len(out) != n_atoms:
        return None
    return out
