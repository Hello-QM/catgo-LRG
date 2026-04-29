"""Tests for built-in local task function implementations."""

import pytest
from catgo.workflow.builtins import (
    structure_input,
    gibbs_energy,
    slab_gen,
    adsorbate_place,
    free_energy_diagram,
    dos_analysis,
    charge_analysis,
)


class TestStructureInput:
    def test_string_passthrough(self):
        result = structure_input(structure='{"sites": []}')
        assert result["structure"] == '{"sites": []}'

    def test_none_returns_none(self):
        result = structure_input()
        assert result["structure"] is None

    def test_dict_serialized(self):
        result = structure_input(structure={"sites": []})
        assert '"sites"' in result["structure"]

    def test_dict_roundtrips_as_json(self):
        import json
        d = {"lattice": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "sites": []}
        result = structure_input(structure=d)
        parsed = json.loads(result["structure"])
        assert parsed == d


class TestGibbsEnergy:
    def test_returns_gibbs(self):
        result = gibbs_energy(energy=-42.5, frequencies="[]", phase="adsorbed")
        assert result["gibbs"] is not None
        assert result["zpe"] is not None
        assert isinstance(result["gibbs"], float)

    def test_none_energy(self):
        result = gibbs_energy(energy=None)
        assert result["gibbs"] is None

    def test_with_frequencies(self):
        freqs = "[100.0, 200.0, 300.0, 400.0]"
        result = gibbs_energy(energy=-42.5, frequencies=freqs)
        assert result["gibbs"] != -42.5  # ZPE correction applied
        assert result["zpe"] > 0

    def test_negative_freqs_treated_as_imaginary(self):
        freqs = "[100.0, -50.0, 200.0]"
        result = gibbs_energy(energy=-10.0, frequencies=freqs)
        # Should not crash; negative freqs become imaginary
        assert isinstance(result["gibbs"], float)

    def test_dict_frequencies(self):
        freqs = [{"frequency_cm": 150.0}, {"frequency_cm": 250.0}]
        result = gibbs_energy(energy=-10.0, frequencies=freqs)
        assert result["zpe"] > 0

    def test_output_keys(self):
        result = gibbs_energy(energy=-5.0, frequencies="[100.0]")
        assert "gibbs" in result
        assert "zpe" in result
        assert "energy" in result
        assert "g_corr" in result
        assert "ts_correction" in result
        assert "system_name" in result

    def test_system_name_passed_through(self):
        result = gibbs_energy(energy=-5.0, frequencies="[]", system_name="CO_ads")
        assert result["system_name"] == "CO_ads"


class TestSlabGen:
    def test_requires_structure(self):
        with pytest.raises(ValueError, match="requires a structure"):
            slab_gen(structure=None)

    def test_requires_ferrox(self):
        """slab_gen needs ferrox (Rust) — skip if not installed."""
        pytest.importorskip("ferrox")
        # Use a real Cu FCC structure so ferrox can actually cut a slab
        import json
        cu_fcc = json.dumps({
            "lattice": {"matrix": [[0, 1.8075, 1.8075], [1.8075, 0, 1.8075], [1.8075, 1.8075, 0]]},
            "sites": [{"species": [{"element": "Cu", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]}],
        })
        result = slab_gen(structure=cu_fcc)
        assert "structure" in result


class TestAdsorbatePlace:
    def test_requires_structure(self):
        with pytest.raises(ValueError, match="requires a structure"):
            adsorbate_place(structure=None)

    def test_passthrough(self):
        pytest.importorskip("ferrox")
        import json
        cu_fcc = json.dumps({
            "lattice": {"matrix": [[0, 1.8075, 1.8075], [1.8075, 0, 1.8075], [1.8075, 1.8075, 0]]},
            "sites": [{"species": [{"element": "Cu", "occu": 1}], "abc": [0, 0, 0], "xyz": [0, 0, 0]}],
        })
        result = adsorbate_place(structure=cu_fcc)
        assert "structure" in result


class TestStubTasks:
    def test_free_energy_diagram_returns_none(self):
        result = free_energy_diagram()
        assert result == {"plotly_data": None}

    def test_dos_analysis_returns_data(self):
        result = dos_analysis(data={"bands": [1, 2]})
        assert result == {"dos_data": {"bands": [1, 2]}}

    def test_charge_analysis_returns_data(self):
        result = charge_analysis(data={"charges": [0.1]})
        assert result == {"charges": {"charges": [0.1]}}

    def test_dos_analysis_none(self):
        result = dos_analysis()
        assert result == {"dos_data": None}

    def test_charge_analysis_none(self):
        result = charge_analysis()
        assert result == {"charges": None}
