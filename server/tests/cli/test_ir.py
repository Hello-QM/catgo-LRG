"""Tests for catgo.cli.ir — BEC parser + IR spectrum computation."""
from __future__ import annotations

import math
import textwrap

import pytest


# ============================================================================
# E2 — Born effective charges parser
# ============================================================================


_BEC_BLOCK = textwrap.dedent("""\
   BORN EFFECTIVE CHARGES (in e, cummulative output)
   ----------------------------------------------------------------
   ion    1
       1     2.000000  0.100000  0.000000
       2     0.100000  2.000000  0.000000
       3     0.000000  0.000000  1.500000
   ion    2
       1    -2.000000  0.000000  0.000000
       2     0.000000 -2.000000  0.000000
       3     0.000000  0.000000 -1.500000
""")


def test_parse_born_charges_minimal():
    from catgo.cli.ir import parse_born_charges
    born = parse_born_charges(_BEC_BLOCK, n_atoms=2)
    assert born is not None
    assert len(born) == 2
    assert len(born[0]) == 3 and len(born[0][0]) == 3
    assert born[0][0] == [2.0, 0.1, 0.0]
    assert born[1][2] == [0.0, 0.0, -1.5]


def test_parse_born_charges_missing_returns_none():
    from catgo.cli.ir import parse_born_charges
    assert parse_born_charges("nothing relevant here", n_atoms=2) is None


def test_parse_born_charges_truncated_returns_none():
    """Block present but rows are missing -> None (don't silently zero)."""
    from catgo.cli.ir import parse_born_charges
    bad = textwrap.dedent("""\
       BORN EFFECTIVE CHARGES (in e, cummulative output)
       ion    1
           1     2.000000  0.000000  0.000000
           2     0.000000  2.000000  0.000000
    """)  # only 2 rows
    assert parse_born_charges(bad, n_atoms=1) is None


# ============================================================================
# E3 — compute_ir_spectrum, uniform branch
# ============================================================================


def test_compute_ir_spectrum_uniform_three_peaks():
    from catgo.cli.ir import compute_ir_spectrum
    freqs = [100.0, 200.0, 300.0]
    # Dummy eigenvectors (1 atom, z-displacement) — unused without BEC
    eigs = [[[0.0, 0.0, 1.0]]] * 3
    spec = compute_ir_spectrum(freqs, eigs, born=None,
                               emin=None, emax=None, sigma=10.0)
    assert spec.used_bec is False
    assert spec.n_modes == 3
    assert len(spec.grid_cm) == len(spec.intensity)
    # ω grid covers all 3 peaks (within auto-padding 4σ each side)
    assert spec.grid_cm[0] <= 100.0
    assert spec.grid_cm[-1] >= 300.0
    # Find local maxima — sample at the exact mode positions
    def at(w):
        idx = min(range(len(spec.grid_cm)),
                  key=lambda i: abs(spec.grid_cm[i] - w))
        return spec.intensity[idx]
    # At each mode, intensity ~= 1.0 (the other peaks are 10σ away,
    # so their tail contribution is exp(-100/2) ~ 1e-22 — negligible).
    for w in freqs:
        assert at(w) == pytest.approx(1.0, abs=1e-3)
    # Between peaks the signal dips below half
    assert at(150.0) < 0.5


def test_compute_ir_spectrum_empty_returns_empty():
    from catgo.cli.ir import compute_ir_spectrum
    spec = compute_ir_spectrum([], [], born=None, emin=None, emax=None)
    assert spec.grid_cm == []
    assert spec.intensity == []
    assert spec.n_modes == 0


def test_compute_ir_spectrum_explicit_range():
    from catgo.cli.ir import compute_ir_spectrum
    spec = compute_ir_spectrum([1000.0], [[[0,0,1]]], born=None,
                               emin=500.0, emax=1500.0, sigma=10.0)
    assert spec.grid_cm[0] == pytest.approx(500.0)
    assert spec.grid_cm[-1] == pytest.approx(1500.0)


def test_parse_born_charges_two_atoms_but_only_one_block():
    """Asked for 2 atoms, OUTCAR has only 1 -> None."""
    from catgo.cli.ir import parse_born_charges
    half = textwrap.dedent("""\
       BORN EFFECTIVE CHARGES (in e, cummulative output)
       ion    1
           1     2.0  0.0  0.0
           2     0.0  2.0  0.0
           3     0.0  0.0  1.0
    """)
    assert parse_born_charges(half, n_atoms=2) is None
