"""Test adsorption energy with ZPE correction — simulates UMA Part 4 workflow.

Run with:
    cd server && python -m pytest tests/test_adsorption_energy_zpe.py -v
"""
import pytest
from workflow.engines.analysis import _analyze_adsorption_energy


def _make_step_results():
    """Mock step_results simulating H adsorption on Ni(111) with ZPE.

    Workflow topology:
      geo_slab_H (37 atoms) ─┐
      geo_slab   (36 atoms) ─┤
      geo_H2     (2 atoms)  ─┼── adsorption_energy
      freq_slab_H (37 atoms) ┤
      freq_H2    (2 atoms)  ─┘
    """
    return {
        "geo_slab_H": {
            "node_type": "geo_opt",
            "energy": -245.123,
            "n_atoms": 37,
        },
        "geo_slab": {
            "node_type": "geo_opt",
            "energy": -241.567,
            "n_atoms": 36,
        },
        "geo_H2": {
            "node_type": "geo_opt",
            "energy": -6.770,
            "n_atoms": 2,
        },
        "freq_slab_H": {
            "node_type": "mlp_vibrations",
            "zpe": 0.180,
            "n_atoms": 37,
            "frequencies": [1800.0, 800.0, 500.0],
        },
        "freq_H2": {
            "node_type": "mlp_vibrations",
            "zpe": 0.270,
            "n_atoms": 2,
            "frequencies": [4400.0],
        },
    }


class TestBasicAdsorptionEnergy:
    """Without freq nodes — standard electronic E_ads."""

    def test_three_parents(self):
        sr = _make_step_results()
        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2"]
        params = {"reference_coefficient": 0.5}

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        assert result["status"] == "completed"
        E_expected = -245.123 - (-241.567) - 0.5 * (-6.770)
        assert result["E_ads_eV"] == pytest.approx(E_expected, abs=1e-6)
        assert "E_ads_ZPE_eV" not in result  # No ZPE without freq nodes

    def test_two_parents_no_ref(self):
        sr = _make_step_results()
        parent_ids = ["geo_slab_H", "geo_slab"]
        params = {"reference_coefficient": 0.5}

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        assert result["status"] == "completed"
        E_expected = -245.123 - (-241.567)
        assert result["E_ads_eV"] == pytest.approx(E_expected, abs=1e-6)


class TestZPECorrection:
    """With freq nodes — ZPE-corrected E_ads."""

    def test_full_zpe(self):
        sr = _make_step_results()
        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2", "freq_slab_H", "freq_H2"]
        params = {"reference_coefficient": 0.5, "include_zpe": True}

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        assert result["status"] == "completed"
        E_ads = -245.123 - (-241.567) - 0.5 * (-6.770)
        dZPE = 0.180 - 0.5 * 0.270  # No ZPE for clean slab
        E_ads_zpe = E_ads + dZPE

        assert result["E_ads_eV"] == pytest.approx(E_ads, abs=1e-6)
        assert result["E_ads_ZPE_eV"] == pytest.approx(E_ads_zpe, abs=1e-6)
        assert result["dZPE_eV"] == pytest.approx(dZPE, abs=1e-6)
        assert result["ZPE_slab_adsorbate_eV"] == pytest.approx(0.180, abs=1e-6)
        assert result["ZPE_reference_eV"] == pytest.approx(0.270, abs=1e-6)

    def test_zpe_disabled(self):
        sr = _make_step_results()
        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2", "freq_slab_H", "freq_H2"]
        params = {"reference_coefficient": 0.5, "include_zpe": False}

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        assert result["status"] == "completed"
        assert "E_ads_ZPE_eV" not in result

    def test_partial_zpe(self):
        """Only freq for slab+H, no freq for H2."""
        sr = _make_step_results()
        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2", "freq_slab_H"]
        params = {"reference_coefficient": 0.5}

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        assert result["status"] == "completed"
        assert result["E_ads_ZPE_eV"] is not None
        assert result["ZPE_slab_adsorbate_eV"] == pytest.approx(0.180, abs=1e-6)
        assert "ZPE_reference_eV" not in result

    def test_zpe_computed_from_frequencies(self):
        """ZPE key missing but frequencies available — should compute."""
        from workflow.catalysis.free_energy import compute_zpe

        sr = _make_step_results()
        del sr["freq_slab_H"]["zpe"]
        del sr["freq_H2"]["zpe"]

        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2", "freq_slab_H", "freq_H2"]
        params = {"reference_coefficient": 0.5}

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        assert result["status"] == "completed"
        assert "E_ads_ZPE_eV" in result
        expected_zpe = compute_zpe([1800.0, 800.0, 500.0])
        assert result["ZPE_slab_adsorbate_eV"] == pytest.approx(expected_zpe, abs=1e-6)


class TestFreqNodeFiltering:
    """Freq nodes should not confuse the energy auto-detection."""

    def test_freq_nodes_excluded_from_energy_entries(self):
        """Freq nodes should not appear in the energy role assignment."""
        sr = _make_step_results()
        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2", "freq_slab_H", "freq_H2"]
        params = {"reference_coefficient": 0.5}

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        # Energy values should come from geo_opt nodes only
        assert result["E_slab_adsorbate_eV"] == pytest.approx(-245.123, abs=1e-6)
        assert result["E_clean_slab_eV"] == pytest.approx(-241.567, abs=1e-6)
        assert result["E_reference_eV"] == pytest.approx(-6.770, abs=1e-6)

    def test_insufficient_energy_parents(self):
        """Only freq nodes, no energy nodes — should error."""
        sr = _make_step_results()
        parent_ids = ["freq_slab_H", "freq_H2"]
        params = {"reference_coefficient": 0.5}

        result = _analyze_adsorption_energy(parent_ids, sr, params)
        assert result["status"] == "error"
