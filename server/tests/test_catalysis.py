"""Tests for catalysis analysis module."""
import pytest


def test_gibbs_free_energy_basic():
    from workflow.catalysis.free_energy import gibbs_free_energy
    result = gibbs_free_energy(e_dft=-45.0, frequencies_cm=[3600, 1500, 500])
    assert result["E_DFT"] == -45.0
    assert result["ZPE"] > 0  # ZPE should be positive
    # G = E_DFT + ZPE + (-TS); for typical high-freq modes ZPE dominates so G > E_DFT
    assert result["G"] > result["E_DFT"]
    assert result["temperature"] == 298.15


def test_gibbs_ignores_imaginary_frequencies():
    from workflow.catalysis.free_energy import compute_zpe
    zpe_with_imag = compute_zpe([-200, 100, 3600])
    zpe_without = compute_zpe([100, 3600])
    assert zpe_with_imag == zpe_without  # Imaginary freq ignored


def test_oer_overpotential():
    from workflow.catalysis.oer import compute_oer_overpotential
    result = compute_oer_overpotential(dG_OH=1.0, dG_O=2.5, dG_OOH=4.2)
    assert result["overpotential"] > 0
    assert 1 <= result["limiting_step"] <= 4
    assert len(result["step_energies"]) == 4
    # Step 4: 4.92 - 4.2 = 0.72, which is < 1.23 → not limiting
    # Step 3: 4.2 - 2.5 = 1.7, which is > 1.23 → limiting
    assert result["limiting_step"] == 3


def test_oer_ideal_catalyst():
    """An ideal catalyst has eta approx 0."""
    from workflow.catalysis.oer import compute_oer_overpotential
    # At the ideal point: all steps = 1.23 eV
    result = compute_oer_overpotential(dG_OH=1.23, dG_O=2.46, dG_OOH=3.69)
    assert result["overpotential"] == pytest.approx(0.0, abs=0.01)


def test_co2rr_limiting_potential():
    from workflow.catalysis.co2rr import compute_co2rr_limiting_potential
    result = compute_co2rr_limiting_potential(dG_COOH=0.5, dG_CO=-0.3)
    assert "limiting_potential" in result
    assert result["pathway"] == "CO"
    assert len(result["step_energies"]) == 3


def test_nrr_overpotential():
    from workflow.catalysis.nrr import compute_nrr_overpotential
    result = compute_nrr_overpotential(dG_N2H=0.5)
    assert result["overpotential"] >= 0


def test_volcano_data_generation():
    from workflow.catalysis.volcano import generate_volcano_data
    data = generate_volcano_data([
        {"name": "A", "dG_OH": 1.0, "overpotential": 0.37},
        {"name": "B", "dG_OH": 1.5, "overpotential": 0.27},
    ], reaction="OER")
    assert len(data["points"]) == 2
    assert data["ideal_line"] is not None
    assert len(data["ideal_line"]["x"]) == 100


def test_scaling_relation():
    from workflow.catalysis.oer import estimate_dG_OOH_from_scaling
    # dG_OOH approx 0.84 * dG_OH + 3.29
    assert estimate_dG_OOH_from_scaling(1.0) == pytest.approx(4.13, abs=0.01)
