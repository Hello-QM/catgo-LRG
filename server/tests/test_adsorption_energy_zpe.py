"""Test adsorption energy with ZPE correction — simulates UMA Part 4 workflow.

Run with:
    cd server && python -m pytest tests/test_adsorption_energy_zpe.py -v
"""
import json
import re

import pytest
from catgo.mcp_tools import provenance, verify_gates
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
            "work_dir": "/runs/geo_slab_H",
            "potcar_titels": ["PAW_PBE Ni_pv", "PAW_PBE H"],
            "nelect": 371.0,
        },
        "geo_slab": {
            "node_type": "geo_opt",
            "energy": -241.567,
            "n_atoms": 36,
            "work_dir": "/runs/geo_slab",
            "potcar_titels": ["PAW_PBE Ni_pv"],
            "nelect": 370.0,
        },
        "geo_H2": {
            "node_type": "geo_opt",
            "energy": -6.770,
            "n_atoms": 2,
            "work_dir": "/runs/geo_H2",
            "potcar_titels": ["PAW_PBE H"],
            "nelect": 2.0,
        },
        "freq_slab_H": {
            "node_type": "mlp_vibrations",
            "zpe": 0.180,
            "n_atoms": 37,
            "frequencies": [1800.0, 800.0, 500.0],
            "work_dir": "/runs/freq_slab_H",
        },
        "freq_H2": {
            "node_type": "mlp_vibrations",
            "zpe": 0.270,
            "n_atoms": 2,
            "frequencies": [4400.0],
            "work_dir": "/runs/freq_H2",
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
        assert result["E_ads_unit"] == "eV"
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


class TestCleanSlabReference:
    """The emitted reference must identify the clean slab, never the gas reference."""

    def test_explicit_clean_slab_step_takes_priority(self):
        sr = _make_step_results()
        # Make atom counts misleading to prove the explicit clean-slab role wins.
        sr["geo_slab"]["n_atoms"] = 1
        sr["geo_H2"]["n_atoms"] = 36
        parent_ids = ["geo_slab_H", "geo_H2", "geo_slab"]
        params = {
            "clean_slab_step": "geo_slab",
            "reference_coefficient": 0.5,
        }

        result = _analyze_adsorption_energy(parent_ids, sr, params)

        assert result["status"] == "completed"
        assert result["reference_task_id"] == "geo_slab"
        assert result["reference_dir"] == "/runs/geo_slab"
        assert result["reference_dir"] != sr["geo_H2"]["work_dir"]
        assert result["pairing_mode"] == "mixed_explicit_heuristic"


class TestContentBoundLineage:
    def test_every_energy_operand_has_sha256_lineage(self):
        sr = _make_step_results()
        result = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"],
            sr,
            {
                "reference_coefficient": 0.5,
                "slab_adsorbate_step": "geo_slab_H",
                "clean_slab_step": "geo_slab",
                "reference_step": "geo_H2",
            },
        )

        for field in (
            "slab_adsorbate_digest",
            "clean_slab_digest",
            "reference_digest",
            "gas_reference_digest",
        ):
            assert re.fullmatch(r"sha256:[0-9a-f]{64}", result[field]), field
        assert result["clean_slab_digest"] == result["reference_digest"]
        assert result["lineage_digest_schema"] == (
            "catgo.adsorption-operand.v1"
        )
        assert result["pairing_mode"] == "explicit_roles"
        assert result["ads_titels"] == sr["geo_slab_H"]["potcar_titels"]
        assert result["bare_titels"] == sr["geo_slab"]["potcar_titels"]

        wrapped = json.loads(provenance.wrap_payload(
            json.dumps(result),
            tool="catgo_catalysis",
            action="adsorption_energy",
            inputs={},
        ))
        flat, claims, conflicts = provenance.verification_view(wrapped)
        assert conflicts == {}
        assert claims == ["binding_Eads"]
        assert verify_gates.verifiability(flat, claims)[0]["status"] == "VERIFIABLE"

    def test_parent_content_change_changes_only_bound_operand_digest(self):
        original = _make_step_results()
        changed = _make_step_results()
        changed["geo_slab"]["energy"] -= 0.001

        first = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"], original, {}
        )
        second = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"], changed, {}
        )

        assert first["reference_digest"] != second["reference_digest"]
        assert (
            first["slab_adsorbate_digest"]
            == second["slab_adsorbate_digest"]
        )
        assert first["gas_reference_digest"] == second["gas_reference_digest"]

    def test_gas_reference_identity_without_digest_is_unverifiable(self):
        result = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"],
            _make_step_results(),
            {},
        )
        result.pop("gas_reference_digest")
        assert verify_gates.verifiability(
            result, ["binding_Eads"]
        )[0]["status"] == "UNVERIFIABLE"

    def test_heuristic_or_replayed_reference_cannot_certify(self):
        heuristic = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"],
            _make_step_results(),
            {},
        )
        assert heuristic["pairing_mode"] == "heuristic_atom_count"
        assert verify_gates.verifiability(
            heuristic, ["binding_Eads"]
        )[0]["status"] == "UNVERIFIABLE"

        explicit = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"],
            _make_step_results(),
            {
                "slab_adsorbate_step": "geo_slab_H",
                "clean_slab_step": "geo_slab",
                "reference_step": "geo_H2",
            },
        )
        explicit["reference_task_id"] = "wrong-but-existing-step"
        assert verify_gates.verifiability(
            explicit, ["binding_Eads"]
        )[0]["status"] == "UNVERIFIABLE"

    def test_electronic_adsorption_energy_has_own_range_gate(self):
        step_results = _make_step_results()
        step_results["geo_slab_H"]["energy"] = -345.123
        result = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"],
            step_results,
            {
                "slab_adsorbate_step": "geo_slab_H",
                "clean_slab_step": "geo_slab",
                "reference_step": "geo_H2",
                "reference_coefficient": 0.5,
            },
        )

        statuses = {
            verdict["gate"]: verdict["status"]
            for verdict in verify_gates.audit(result)["verdicts"]
        }
        assert result["E_ads_eV"] < -3.5
        assert statuses["adsorption_energy_range"] == "FAIL"
        assert statuses["physical_range"] == "SKIP"

    def test_electronic_adsorption_energy_is_not_complete_dG(self):
        result = _analyze_adsorption_energy(
            ["geo_slab_H", "geo_slab", "geo_H2"],
            _make_step_results(),
            {
                "slab_adsorbate_step": "geo_slab_H",
                "clean_slab_step": "geo_slab",
                "reference_step": "geo_H2",
            },
        )

        assert verify_gates.verifiability(
            result, ["binding_Eads"]
        )[0]["status"] == "VERIFIABLE"
        missing_unit = dict(result)
        missing_unit.pop("E_ads_unit")
        assert verify_gates.verifiability(
            missing_unit, ["binding_Eads"]
        )[0]["status"] == "UNVERIFIABLE"
        assert verify_gates.verifiability(
            result, ["binding_dG"]
        )[0]["status"] == "UNVERIFIABLE"

        complete = {
            **result,
            "dG_ads_eV": result["E_ads_eV"] + 0.1 - 0.2,
            "dG_ads_unit": "eV",
            "temperature": 298.15,
            "pressure": 1.0,
            "zpe_correction_eV": 0.1,
            "entropy_correction_eV": 0.2,
            "gas_entropy_included": True,
        }
        assert verify_gates.verifiability(
            complete, ["binding_dG"]
        )[0]["status"] == "VERIFIABLE"

    def test_heuristic_pairing_is_labeled(self):
        sr = _make_step_results()
        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2"]

        result = _analyze_adsorption_energy(parent_ids, sr, {})

        assert result["status"] == "completed"
        assert result["reference_task_id"] == "geo_slab"
        assert result["reference_dir"] == "/runs/geo_slab"
        assert result["reference_dir"] != sr["geo_H2"]["work_dir"]
        assert result["pairing_mode"] == "heuristic_atom_count"

    def test_missing_clean_slab_path_is_not_fabricated(self):
        sr = _make_step_results()
        del sr["geo_slab"]["work_dir"]
        parent_ids = ["geo_slab_H", "geo_slab", "geo_H2"]

        result = _analyze_adsorption_energy(parent_ids, sr, {
            "clean_slab_step": "geo_slab",
        })

        assert result["status"] == "completed"
        assert result["reference_task_id"] == "geo_slab"
        assert "reference_dir" not in result
        assert result["pairing_mode"] == "mixed_explicit_heuristic"
