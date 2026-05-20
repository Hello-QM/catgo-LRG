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
