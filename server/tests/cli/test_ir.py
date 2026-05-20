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


# ============================================================================
# E4 — BEC-weighted intensities
# ============================================================================


def test_bec_intensities_diagonal_isotropic():
    """One mode pure-z on a single atom whose Z* is isotropic 2.0:
    I = (Z * e)² = 4 (sum over j of (Z[2][j] * 1.0)² = 0+0+4)."""
    from catgo.cli.ir import _bec_intensities
    eigs = [[[0.0, 0.0, 1.0]]]   # 1 mode, 1 atom, z-displacement
    born = [[[2.0, 0.0, 0.0],    # Z*[atom=0]
             [0.0, 2.0, 0.0],
             [0.0, 0.0, 2.0]]]
    I = _bec_intensities(eigs, born)
    assert I == [pytest.approx(4.0)]


def test_bec_intensities_heavier_atom_taller_peak():
    """Same eigenvector on two atoms with different Z* → I scales with
    |Σ_a Z*_a · e(a)|²; the heavier Z* contributes more, so its
    in-phase mode beats the out-of-phase mode."""
    from catgo.cli.ir import _bec_intensities
    # Two modes, both 2-atom systems:
    # mode 0 — atoms move in-phase along z: e = [[0,0,1], [0,0,1]]
    # mode 1 — out of phase:                e = [[0,0,1], [0,0,-1]]
    eigs = [
        [[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]],
        [[0.0, 0.0, 1.0], [0.0, 0.0, -1.0]],
    ]
    born = [
        [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]],   # atom 0: Z = 1
        [[3.0, 0, 0], [0, 3.0, 0], [0, 0, 3.0]],   # atom 1: Z = 3
    ]
    I = _bec_intensities(eigs, born)
    # In-phase: sum(Z·e) along z = 1+3 = 4 → I = 16
    # Out-of-phase: 1-3 = -2 → I = 4
    assert I[0] == pytest.approx(16.0)
    assert I[1] == pytest.approx(4.0)
    assert I[0] > I[1]


# ============================================================================
# E5 — text writer
# ============================================================================


# ============================================================================
# E6 — plot writer
# ============================================================================


def test_write_ir_plot_builds_correct_spec(monkeypatch, tmp_path):
    """Monkeypatch catgo.cli.plotting.render and assert that
    write_ir_plot constructs a PlotSpec with the IR axes and the
    spectrum bound to the single series."""
    captured = {}

    def fake_render(spec, out, edit, latex):
        captured["spec"] = spec
        captured["out"] = out
        captured["edit"] = edit
        captured["latex"] = latex
        return out

    monkeypatch.setattr("catgo.cli.plotting.render", fake_render)
    from catgo.cli.ir import IrSpectrum, write_ir_plot
    spec = IrSpectrum(grid_cm=[100.0, 110.0, 120.0],
                      intensity=[0.1, 1.0, 0.1],
                      used_bec=True, n_modes=1)
    out = tmp_path / "ir.pdf"
    write_ir_plot(spec, out, edit=False, latex=False)
    ps = captured["spec"]
    assert ps.kind == "ir"
    assert ps.x == [100.0, 110.0, 120.0]
    assert len(ps.series) == 1
    label, y, style = ps.series[0]
    assert y == [0.1, 1.0, 0.1]
    # Axes labels look right
    assert "cm" in ps.xlabel  # "wavenumber (cm$^{-1}$)" or similar
    assert "intensity" in ps.ylabel.lower()


def test_write_ir_text_round_trips(tmp_path):
    from catgo.cli.ir import IrSpectrum, write_ir_text
    spec = IrSpectrum(grid_cm=[100.0, 200.0, 300.0],
                      intensity=[1.0, 0.5, 0.0],
                      used_bec=False, n_modes=3)
    out = tmp_path / "ir.dat"
    write_ir_text(spec, out)
    assert out.exists()
    # Parse back
    parsed = []
    for line in out.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        w, y = line.split()
        parsed.append((float(w), float(y)))
    assert parsed == [(100.0, 1.0), (200.0, 0.5), (300.0, 0.0)]


def test_compute_ir_spectrum_with_bec_taller_in_phase_peak():
    """End-to-end: feed two modes with the in-phase / out-of-phase
    eigenvectors above and verify the spectrum peak at ω_inphase is
    taller."""
    from catgo.cli.ir import compute_ir_spectrum
    eigs = [
        [[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]],
        [[0.0, 0.0, 1.0], [0.0, 0.0, -1.0]],
    ]
    born = [
        [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]],
        [[3.0, 0, 0], [0, 3.0, 0], [0, 0, 3.0]],
    ]
    freqs = [500.0, 1500.0]   # well-separated
    spec = compute_ir_spectrum(freqs, eigs, born=born,
                               emin=None, emax=None, sigma=20.0)
    assert spec.used_bec is True
    # Peak heights at the mode positions
    def at(w):
        idx = min(range(len(spec.grid_cm)),
                  key=lambda i: abs(spec.grid_cm[i] - w))
        return spec.intensity[idx]
    h_in = at(500.0)
    h_out = at(1500.0)
    # Ratio ≈ 16/4 = 4
    assert h_in > h_out
    assert h_in / h_out == pytest.approx(16.0 / 4.0, rel=1e-2)


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
