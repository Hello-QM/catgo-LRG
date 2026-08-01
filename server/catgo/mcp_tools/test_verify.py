"""Tests for the physics-verification layer (verify_gates + verify_enforcement).

Runnable with pytest OR standalone (`python test_verify.py`). Covers the core
behavior plus regressions for four review findings:
  R1  enforcement matches the 61-tool variant's fine-grained numeric tool names
  R2  an empty catgo_verify (no gate ran) does NOT clear the unverified state
  R3  provenance with a present-but-empty value (None / []) is NOT certified
  R4  this file itself — Python test coverage in CI
"""
import os
import sys
import json
import asyncio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_gates as vg
import verify_enforcement as enf
import provenance as prov


# ---- value gates ----------------------------------------------------------
def test_gates_catch_recorded_failures():
    paw = vg.audit({"dG": -3.94,
                    "ads_titels": ["PAW_PBE Hf_sv 06Sep2000"],
                    "bare_titels": ["PAW_PBE Hf_pv 06Sep2000"]})
    st = {v["gate"]: v["status"] for v in paw["verdicts"]}
    assert st["paw_consistency"] == "FAIL"
    assert st["physical_range"] == "FAIL"


def test_clean_result_passes():
    clean = vg.audit({"dG": -1.204, "fmax": 0.015, "ediffg": -0.02,
                      "hessian_max_asym": 0.37, "opt_conv": "1"})
    assert not [v for v in clean["verdicts"] if v["status"] == "FAIL"]


def test_explicit_kpoints_precedence_is_consistent_with_vasp():
    verdicts = vg.precheck_inputs(
        "KSPACING = 0.25\nALGO = Fast\nENCUT = 520\nEDIFF = 1E-5\n",
        kpoints_text="mesh\n0\nGamma\n3 3 1\n0 0 0\n",
    )
    verdict = next(v for v in verdicts if v["gate"] == "in_kspacing_vs_kpoints")
    assert verdict["status"] == "PASS"
    assert "authoritative" in verdict["detail"]
    assert "KSPACING" in verdict["detail"]


def test_required_key_contract_is_tristate_and_checks_final_nonblank_values():
    def p17(text, required):
        return next(
            v for v in vg.precheck_inputs(text, required_keys=required)
            if v["gate"] == "in_required_keys_present"
        )

    assert p17("ENCUT=520\n", None)["status"] == "SKIP"
    assert p17("ENCUT=520\n", [])["status"] == "FAIL"
    assert p17("ENCUT=520\n", ["encut", "ediff"])["status"] == "FAIL"
    assert p17("ENCUT=520;EDIFF=1E-5\n", ["encut", "ediff"])["status"] == "PASS"
    assert p17("EDIFF=1E-5\nEDIFF=\n", ["EDIFF"])["status"] == "FAIL"
    assert p17("EDIFF==\n", ["EDIFF"])["status"] == "FAIL"
    assert p17("EDIFF=1E-5\nEDIFF==\n", ["EDIFF"])["status"] == "FAIL"

    for invalid in ("ENCUT", {"ENCUT": True}, ["ENCUT", "encut"], ["BAD-TAG"]):
        try:
            p17("ENCUT=520\n", invalid)
        except ValueError:
            pass
        else:
            assert False, f"invalid contract accepted: {invalid!r}"


def test_unresolved_overlay_is_skip_and_append_materialization_is_last_wins():
    unresolved = vg.materialize_incar(
        None, ["EDIFF=1E-5\n"], strategy="append",
    )
    verdicts = vg.precheck_inputs(
        unresolved,
        required_keys=["ENCUT", "EDIFF"],
        kpoints_policy="explicit_regular_mesh",
    )
    statuses = {v["gate"]: v["status"] for v in verdicts}
    assert statuses["in_required_keys_present"] == "SKIP"
    assert statuses["in_kspacing_vs_kpoints"] == "SKIP"

    final = vg.materialize_incar(
        "ENCUT=400\nEDIFF=1E-4",
        ["ENCUT=520; EDIFF=1E-5\n"],
        strategy="append",
    )
    assert vg._incar_tags(final)[0]["ENCUT"] == "520"
    assert next(
        v for v in vg.precheck_inputs(
            final, required_keys=["ENCUT", "EDIFF"],
        ) if v["gate"] == "in_required_keys_present"
    )["status"] == "PASS"


def test_explicit_regular_mesh_policy_fails_missing_or_malformed_file_only():
    def p4(text, kpoints, policy):
        return next(
            v for v in vg.precheck_inputs(
                text, kpoints_text=kpoints, kpoints_policy=policy,
            ) if v["gate"] == "in_kspacing_vs_kpoints"
        )

    assert p4("KSPACING=0.25\n", None, "vasp_default")["status"] == "PASS"
    assert p4("KSPACING=1_0\n", None, "vasp_default")["status"] == "FAIL"
    assert p4("KSPACING=0.25\n", "", "vasp_default")["status"] == "FAIL"
    assert p4(
        "KSPACING=0.25\nKGAMMA=.TRUE.\n",
        None,
        "explicit_regular_mesh",
    )["status"] == "FAIL"
    valid = "mesh\n0\nG\n4 4 1\n0 0 0\n"
    invalid_shift = "mesh\n0\nG\n4 4 1\n1_0 0 0\n"
    assert p4(
        "ENCUT=520\n", invalid_shift, "explicit_regular_mesh",
    )["status"] == "FAIL"
    unicode_mesh = "mesh\n0\nG\n٤ ٤ ١\n0 0 0\n"
    assert p4(
        "ENCUT=520\n", unicode_mesh, "explicit_regular_mesh",
    )["status"] == "FAIL"
    coexist = p4(
        "KSPACING=0.25\nKGAMMA=.TRUE.\n",
        valid,
        "explicit_regular_mesh",
    )
    assert coexist["status"] == "PASS"
    assert "not a physics override" in coexist["detail"]
    assert p4("ENCUT=520\n", "mesh\n1\nG\n4 4 1\n", "explicit_regular_mesh")[
        "status"
    ] == "FAIL"
    try:
        p4("ENCUT=520\n", valid, "unknown")
    except ValueError:
        pass
    else:
        assert False, "unknown kpoints policy accepted"


def test_absent_inputs_are_skip_not_dropped():
    rep = vg.audit({})
    assert rep["coverage"]["ran"] == 0
    assert all(v["status"] == "SKIP" for v in rep["verdicts"])


def test_require_raises_on_blind_gate():
    try:
        vg.audit({}, require=["hessian_symmetry"])
    except ValueError as e:
        assert "hessian_symmetry" in str(e)
    else:
        assert False, "require= must raise when a mandated gate cannot run"


def test_force_convergence_only_applies_to_vasp_relaxation_modes():
    for ibrion in (-1, 0, 5, 6, 7, 8):
        report = vg.audit({
            "fmax": 0.5, "ediffg": -0.02, "ibrion": ibrion, "nsw": 100,
        })
        status = {v["gate"]: v["status"] for v in report["verdicts"]}
        assert status["force_convergence"] == "SKIP", ibrion

    for incomplete in (
        {"fmax": 0.5, "ediffg": -0.02, "nsw": 100},
        {"fmax": 0.5, "ediffg": -0.02, "ibrion": 2},
    ):
        status = {
            v["gate"]: v["status"]
            for v in vg.audit(incomplete)["verdicts"]
        }
        assert status["force_convergence"] == "SKIP"

    failed = vg.audit({
        "fmax": 0.5, "ediffg": -0.02, "ibrion": 2, "nsw": 100,
    })
    status = {v["gate"]: v["status"] for v in failed["verdicts"]}
    assert status["force_convergence"] == "FAIL"


# ---- verifiability + R3 (empty provenance not certified) ------------------
def test_verifiability_flags_missing_provenance():
    v = vg.verifiability({"dG": -0.28}, ["her_dGH"])
    assert v[0]["status"] == "UNVERIFIABLE"


def test_verifiability_certifies_with_provenance():
    v = vg.verifiability({"dG": -0.28, "gas_entropy_included": True}, ["her_dGH"])
    assert v[0]["status"] == "VERIFIABLE"


def test_R3_empty_value_is_not_provenance():
    # present key, empty value → must NOT be certified
    for empty in (None, [], {}, ""):
        v = vg.verifiability({"ads_titels": empty, "bare_titels": empty}, ["binding_Eads"])
        assert v[0]["status"] == "UNVERIFIABLE", f"empty {empty!r} wrongly certified"
    # PAW consistency alone is insufficient without explicit reference identity.
    v = vg.verifiability(
        {
            "ads_titels": ["PAW_PBE Hf_sv"],
            "bare_titels": ["PAW_PBE Hf_sv"],
            "reference_task_id": "clean-slab-1",
            "reference_digest": "sha256:" + "a" * 64,
            "slab_adsorbate_task_id": "slab-ads-1",
            "slab_adsorbate_digest": "sha256:" + "b" * 64,
            "pairing_mode": "explicit_clean_slab_step",
        },
        ["binding_Eads"],
    )
    assert v[0]["status"] == "UNVERIFIABLE"


def test_unknown_claim_is_default_deny():
    v = vg.verifiability({}, ["nonsense"])
    assert v[0]["status"] == "UNKNOWN-CLAIM"
    assert v[0]["status"] in vg.NOT_CERTIFIED


# ---- enforcement ----------------------------------------------------------
def _fresh(sk):
    enf._sessions.pop(sk, None)


def _arm_bound_result(sk, *, label, tool="catgo_analyze", action="test"):
    envelope = prov.envelope(
        {"energy": -1.0},
        tool=tool,
        action=action,
        inputs={"logical_result": label},
    )
    records = prov.extract_result_records(envelope)
    enf.postmark(
        tool,
        {"action": action, "_result_records": records},
        ok=True,
        session_key=sk,
    )
    return envelope


def test_R1_numeric_prefix_matches_both_variants():
    # merged-variant names AND 61-tool fine-grained names must all count as numeric
    for tool in ("catgo_analyze", "catgo_catalysis",
                 "catgo_catalysis_oer", "catgo_catalysis_free_energy",
                 "catgo_dos_compute", "catgo_dos_total", "catgo_cohp_data",
                 "catgo_bands_data", "catgo_energy", "catgo_freq_parse"):
        assert enf._is_numeric(tool, {}), f"{tool} should be numeric"
    # hub/admin and non-numeric tools must not
    assert not enf._is_numeric("catgo_analyze", {"action": "hub_search"})
    assert not enf._is_numeric("catgo_structure", {})
    assert not enf._is_numeric("catgo_view", {})


def test_workflow_batch_results_is_numeric_but_status_is_not():
    assert enf._is_numeric("catgo_workflow", {"action": "batch_results"})
    assert not enf._is_numeric("catgo_workflow", {"action": "status"})
    assert not enf._is_numeric("catgo_workflow", {"action": "results"})


def test_only_a_literal_zero_item_batch_is_empty():
    assert prov.batch_payload_is_empty('{"items": []}')
    assert not prov.batch_payload_is_empty(
        '{"items": [{"result": {"energy": null}}]}'
    )
    assert not prov.batch_payload_is_empty(
        '{"items": [{"result": {"foo": 1}}]}'
    )
    assert prov.workflow_payload_has_results(
        '{"steps": [{"result_json": {"energy": -1.0}}]}'
    )
    nested = {
        "steps": [{
            "id": "ads-analysis-1",
            "result_json": '{"summary":{"analysis_type":"adsorption_energy",'
                           '"E_ads_eV":-0.25,"E_ads_unit":"eV",'
                           '"reference_task_id":"clean-1",'
                           '"reference_digest":"sha256:'
                           + "a" * 64
                           + '","slab_adsorbate_task_id":"ads-1",'
                           '"slab_adsorbate_digest":"sha256:'
                           + "b" * 64
                           + '","pairing_mode":"explicit_roles"}}',
        }],
    }
    assert prov.workflow_payload_has_results(nested)
    wrapped = json.loads(prov.wrap_payload(
        json.dumps(nested), tool="catgo_workflow", action="status", inputs={},
    ))
    result_env = wrapped["steps"][0]["result_envelope"]
    assert result_env["claim"] == "binding_Eads"
    missing = result_env.get("unverifiable_without", [])
    assert "reference_task_id" not in missing
    assert "reference_digest" not in missing
    assert "slab_adsorbate_task_id" not in missing
    assert "slab_adsorbate_digest" not in missing
    assert "pairing_mode" not in missing
    assert not prov.workflow_payload_has_results(
        '{"steps": [{"result_json": null}]}'
    )
    assert not prov.workflow_payload_has_results(
        '{"steps": [{"result_json": {"n_files": 2, "exit_code": 0}}]}'
    )
    assert not prov.workflow_payload_has_results(
        '{"steps": [{"status": "failed", "result_json": {"exit_code": 1}}]}'
    )
    assert prov.workflow_payload_has_results(
        '{"steps": [{"id": "scalar", "result_json": -1.25}]}'
    )
    scalar = json.loads(prov.wrap_payload(
        '{"steps": [{"id": "scalar", "result_json": -1.25}]}',
        tool="catgo_workflow",
        action="results",
        inputs={"workflow_id": "wf"},
    ))
    assert scalar["steps"][0]["result_envelope"]["value"] == -1.25
    assert "claim" not in scalar["steps"][0]["result_envelope"]


def test_electronic_adsorption_and_complete_free_energy_use_distinct_claims():
    from catgo.mcp_tools.server_claude_code import _handle_catalysis, _handle_verify

    electronic = {
        "analysis_type": "adsorption_energy",
        "E_ads_eV": -0.25,
        "E_ads_unit": "eV",
    }
    wrapped = json.loads(prov.wrap_payload(
        json.dumps(electronic),
        tool="catgo_workflow",
        action="results",
        inputs={"workflow_id": "wf"},
    ))
    assert wrapped["claim"] == "binding_Eads"

    direct = asyncio.run(_handle_catalysis(None, {
        "action": "adsorption_energy",
        "params": {
            "e_slab_ads": -11.0,
            "e_slab": -8.0,
            "e_ref_molecule": -2.0,
            "zpe_correction": 0.1,
            "ts_correction": 0.2,
        },
    }))
    free_energy = json.loads(direct[0].text)
    assert free_energy["claim"] == "binding_dG"
    assert _handle_verify({"result": free_energy})[0].text.startswith(
        "catgo_verify → NOT-CERTIFIED"
    )


def test_scalar_and_prose_numeric_responses_receive_bound_digests():
    scalar = json.loads(prov.wrap_payload(
        "-1.25", tool="catgo_energy", action="parse", inputs={"task": "a"},
    ))
    prose = json.loads(prov.wrap_payload(
        "energy = -1.25 eV",
        tool="catgo_energy",
        action="parse",
        inputs={"task": "b"},
    ))
    for wrapped in (scalar, prose):
        assert prov.bound_result_digest(wrapped) == wrapped["result_digest"]
        assert len(prov.extract_result_records(wrapped)) == 1


def test_resume_retry_and_campaign_submit_are_irreversible():
    for tool, action in (
        ("catgo_workflow", "resume"),
        ("catgo_workflow", "retry"),
        ("catgo_campaign", "submit"),
    ):
        sk = f"{tool}:{action}"
        enf.postmark(
            "catgo_energy", {}, ok=True, session_key=sk,
        )
        assert enf.precheck(tool, {"action": action}, sk)[0] == enf.FORBIDDEN


def test_batch_results_get_per_item_envelope_without_shape_break():
    import json

    payload = {
        "items": [{
            "subtask_index": 0,
            "result": {
                "energy": -2.5,
                "n_atoms": 2,
                "potcar_titels": ["PAW_PBE H"],
                "nelect": 2.0,
                "kgrid": [1, 1, 1],
            },
        }],
        "total": 1,
    }
    wrapped = prov.wrap_payload(
        json.dumps(payload),
        tool="catgo_workflow",
        action="batch_results",
        inputs={"workflow_id": "wf", "step_id": "sp"},
    )
    data = json.loads(wrapped)
    assert data["items"][0]["result"]["energy"] == -2.5
    assert data["items"][0]["result_envelope"]["value"]["energy"] == -2.5
    assert data["provenance_envelope_count"] == 1


def test_unknown_placeholders_do_not_certify_energy():
    env = prov.envelope(
        -1.0, tool="t", action="a", claim="energy",
        n_atoms=1, xc_functional="unknown",
        potcar_titels=["unknown"], nelect=1.0, kgrid=[1, 1, 1],
    )
    assert env["unverifiable_without"] == [
        "xc_functional", "potcar_titels",
    ]


def _energy_result(**updates):
    result = {
        "energy": -2.0,
        "n_atoms": 2,
        "xc_functional": "PBE",
        "potcar_titels": ["PAW_PBE H"],
        "nelect": 2.0,
        "kgrid": [1, 1, 1],
    }
    result.update(updates)
    return result


def _energy_batch_envelope(**updates):
    result = _energy_result(**updates)
    text = prov.wrap_payload(
        json.dumps({"items": [{"subtask_index": 0, "result": result}], "total": 1}),
        tool="catgo_workflow",
        action="batch_results",
        inputs={"workflow_id": "wf", "step_id": "sp"},
    )
    return json.loads(text)["items"][0]["result_envelope"]


def test_energy_claim_registry_matches_emitter_and_is_field_strict():
    assert vg.ENERGY_PROVENANCE_FIELDS == tuple(prov.NEEDS["energy"])
    good = _energy_result()
    assert vg.verifiability(good, ["energy"])[0]["status"] == "VERIFIABLE"
    for field, bad in (
        ("energy", float("nan")),
        ("n_atoms", 0),
        ("xc_functional", "unknown"),
        ("potcar_titels", ["unknown"]),
        ("nelect", 0),
        ("kgrid", [0, 0, 0]),
    ):
        candidate = {**good, field: bad}
        assert vg.verifiability(candidate, ["energy"])[0]["status"] == "UNVERIFIABLE"


def test_verification_view_consumes_envelope_without_trusting_input_echoes():
    env = _energy_batch_envelope()
    flat, inferred, conflicts = prov.verification_view(env)
    assert inferred == ["energy"]
    assert conflicts == {}
    assert flat["energy"] == -2.0 and flat["xc_functional"] == "PBE"
    assert "inputs" not in flat
    assert vg.verifiability(flat, inferred)[0]["status"] == "VERIFIABLE"

    env["provenance"]["n_atoms"] = 3
    flat, inferred, conflicts = prov.verification_view(env)
    assert "n_atoms" not in flat and "n_atoms" in conflicts
    assert vg.verifiability(flat, inferred)[0]["status"] == "UNVERIFIABLE"


def _postmark_envelope(package_enf, tool, arguments, envelope, sk="default"):
    package_enf.postmark(
        tool,
        {**arguments, "_result_digests": [envelope["result_digest"]]},
        ok=True,
        session_key=sk,
    )


def test_energy_output_verify_submit_round_trip_and_fail_closed_cases():
    from catgo.mcp_tools import server_claude_code as scc
    from catgo.mcp_tools import verify_enforcement as package_enf

    sk = "default"
    package_enf._sessions.pop(sk, None)
    complete = _energy_batch_envelope()
    _postmark_envelope(
        package_enf, "catgo_workflow", {"action": "batch_results"}, complete, sk
    )
    response = scc._handle_verify({"result": complete})[0].text
    assert "claim 'energy': VERIFIABLE" in response
    assert "envelope claim(s) auto-included: energy" in response
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.ALLOW

    # Missing method provenance remains blocked; omitting `claims` cannot bypass
    # the claim carried by the envelope.
    package_enf._sessions.pop(sk, None)
    incomplete = _energy_batch_envelope(xc_functional=None)
    _postmark_envelope(
        package_enf, "catgo_workflow", {"action": "batch_results"}, incomplete, sk
    )
    response = scc._handle_verify({"result": incomplete})[0].text
    assert "catgo_verify → NOT-CERTIFIED" in response
    assert "claim 'energy': UNVERIFIABLE" in response
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.FORBIDDEN

    # Complete provenance never overrides a real numerical-physics failure.
    package_enf._sessions.pop(sk, None)
    unphysical = _energy_batch_envelope(energy=2.0, n_atoms=1)
    _postmark_envelope(
        package_enf, "catgo_workflow", {"action": "batch_results"}, unphysical, sk
    )
    response = scc._handle_verify({"result": unphysical})[0].text
    assert "catgo_verify → FAIL" in response and "energy_physical" in response
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.FORBIDDEN


def test_provenance_only_certification_is_explicit_and_clears_pending():
    from catgo.mcp_tools import server_claude_code as scc
    from catgo.mcp_tools import verify_enforcement as package_enf

    sk = "default"
    package_enf._sessions.pop(sk, None)
    env = prov.envelope(
        {"overpotential": 0.51},
        tool="catgo_catalysis",
        action="oer",
        claim="limiting_potential",
        ul_reaction="OER",
        ul_reference="CHE",
        ul_convention="reduction-potential",
    )
    _postmark_envelope(
        package_enf, "catgo_catalysis", {"action": "oer"}, env, sk
    )
    response = scc._handle_verify({"result": env})[0].text
    assert "catgo_verify → PROVENANCE-ONLY" in response
    assert "certifies checkability, not numeric correctness" in response
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.ALLOW


def test_result_digest_is_tamper_evident_and_verification_is_result_scoped():
    from catgo.mcp_tools import server_claude_code as scc
    from catgo.mcp_tools import verify_enforcement as package_enf

    sk = "default"
    package_enf._sessions.pop(sk, None)
    first = _energy_batch_envelope(energy=-2.0)
    second = _energy_batch_envelope(energy=-3.0)
    assert first["result_digest"] != second["result_digest"]
    package_enf.postmark(
        "catgo_workflow",
        {
            "action": "batch_results",
            "_result_digests": [
                first["result_digest"],
                second["result_digest"],
            ],
        },
        ok=True,
        session_key=sk,
    )
    assert package_enf.state(sk)["unverified"] == 2

    clean = scc._handle_verify({"result": first})[0].text
    assert "catgo_verify → PASS" in clean
    assert package_enf.state(sk)["unverified"] == 1
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.FORBIDDEN

    tampered = json.loads(json.dumps(second))
    tampered["value"]["energy"] = -4.0
    bad = scc._handle_verify({"result": tampered})[0].text
    assert "provenance_conflict:result_digest" in bad
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.FORBIDDEN

    clean = scc._handle_verify({"result": second})[0].text
    assert "catgo_verify → PASS" in clean
    assert package_enf.state(sk)["unverified"] == 0
    assert package_enf.state(sk)["failed"] == []
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.ALLOW


def test_unbound_copied_digest_cannot_clear_another_result():
    from catgo.mcp_tools import server_claude_code as scc
    from catgo.mcp_tools import verify_enforcement as package_enf

    sk = "default"
    package_enf._sessions.pop(sk, None)
    pending = _energy_batch_envelope(energy=-2.0)
    _postmark_envelope(
        package_enf,
        "catgo_workflow",
        {"action": "batch_results"},
        pending,
        sk,
    )

    spoof = {
        "energy": -10.0,
        "n_atoms": 2,
        "result_digest": pending["result_digest"],
    }
    response = scc._handle_verify({"result": spoof})[0].text
    assert "catgo_verify → NOT-CERTIFIED" in response
    assert "provenance_conflict:result_digest" in response
    assert package_enf.state(sk)["unverified"] == 1
    assert pending["result_digest"] in package_enf.state(sk)["pending_digests"]
    assert package_enf.precheck(
        "catgo_workflow", {"action": "submit"}, sk
    )[0] == package_enf.FORBIDDEN


def test_both_dispatchers_postmark_only_real_batch_numerics():
    import importlib

    full_server = importlib.import_module("catgo.mcp_tools.server")
    from catgo.mcp_tools import server_claude_code as merged_server
    from catgo.mcp_tools import verify_enforcement as package_enf

    async def run_case(module, text):
        original = module._dispatch_tool

        async def fake_dispatch(name, arguments):
            return [module.TextContent(type="text", text=text)]

        module._dispatch_tool = fake_dispatch
        try:
            return await module.handle_call_tool(
                "catgo_workflow", {"action": "batch_results"}
            )
        finally:
            module._dispatch_tool = original

    success = json.dumps({
        "items": [{"subtask_index": 0, "result": _energy_result()}],
        "total": 1,
    })
    for module in (merged_server, full_server):
        for non_numeric in (
            "batch_results requires 'step_id'.",
            json.dumps({"items": [], "total": 0}),
            json.dumps({"error": "backend failed"}),
        ):
            package_enf._sessions.pop("default", None)
            asyncio.run(run_case(module, non_numeric))
            assert package_enf.state()["unverified"] == 0

        package_enf._sessions.pop("default", None)
        response = asyncio.run(run_case(module, success))
        assert package_enf.state()["unverified"] == 1
        data = json.loads(response[0].text)
        assert data["provenance_envelope_count"] == 1
        digest = data["items"][0]["result_envelope"]["result_digest"]
        assert list(package_enf.state()["pending_digests"]) == [digest]


def test_v2_results_action_reads_steps_and_both_dispatchers_arm_each_result():
    import importlib
    from types import SimpleNamespace

    from catgo.mcp_tools import workflow_tools
    from catgo.mcp_tools import verify_enforcement as package_enf

    payload = [{
        "id": "task-1",
        "result_json": {
            "energy": -2.0,
            "n_atoms": 2,
            "xc_functional": "PBE",
            "potcar_titels": ["PAW_PBE H"],
            "nelect": 2.0,
            "kgrid": [1, 1, 1],
        },
    }]

    class Client:
        async def get(self, url, **kwargs):
            assert url.endswith("/workflow/wf-1/steps")
            return SimpleNamespace(
                status_code=200,
                text=json.dumps(payload),
                json=lambda: payload,
            )

    direct = asyncio.run(workflow_tools._handle_workflow(
        Client(), {"action": "results", "workflow_id": "wf-1"}
    ))
    assert json.loads(direct[0].text) == {
        "workflow_id": "wf-1",
        "steps": payload,
    }

    async def run_case(module):
        original = module._dispatch_tool

        async def fake_dispatch(name, arguments):
            return [module.TextContent(type="text", text=direct[0].text)]

        module._dispatch_tool = fake_dispatch
        try:
            return await module.handle_call_tool(
                "catgo_workflow",
                {"action": "results", "workflow_id": "wf-1"},
            )
        finally:
            module._dispatch_tool = original

    full_server = importlib.import_module("catgo.mcp_tools.server")
    merged_server = importlib.import_module("catgo.mcp_tools.server_claude_code")
    for module in (merged_server, full_server):
        package_enf._sessions.pop("default", None)
        response = asyncio.run(run_case(module))
        body = json.loads(response[0].text)
        envelope = body["steps"][0]["result_envelope"]
        assert envelope["claim"] == "energy"
        assert package_enf.state()["unverified"] == 1
        assert list(package_enf.state()["pending_digests"]) == [
            envelope["result_digest"]
        ]


def test_identical_v2_values_from_distinct_steps_keep_distinct_digests():
    payload = {
        "workflow_id": "wf-1",
        "steps": [
            {"id": "task-A", "result_json": _energy_result()},
            {"id": "task-B", "result_json": _energy_result()},
        ],
    }
    wrapped = json.loads(prov.wrap_payload(
        json.dumps(payload),
        tool="catgo_workflow",
        action="results",
        inputs={"workflow_id": "wf-1"},
    ))
    envelopes = [step["result_envelope"] for step in wrapped["steps"]]
    digests = [item["result_digest"] for item in envelopes]

    assert len(set(digests)) == 2
    assert prov.extract_result_digests(wrapped) == digests
    assert {
        item["provenance"]["result_task_id"] for item in envelopes
    } == {"task-A", "task-B"}
    assert all("unverifiable_without" not in item for item in envelopes)

    sk = "v2-distinct"
    _fresh(sk)
    enf.postmark(
        "catgo_workflow",
        {
            "action": "results",
            "_numeric_response": True,
            "_result_digests": digests,
        },
        session_key=sk,
    )
    assert enf.state(sk)["unverified"] == 2
    enf.mark_verified(True, result_digest=digests[0], session_key=sk)
    assert enf.state(sk)["unverified"] == 1


def test_R1_fine_grained_numeric_blocks_submit():
    sk = "r1"; _fresh(sk)
    # a 61-tool numeric result must arm the gate
    enf.postmark("catgo_catalysis_oer", {}, ok=True, session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN


def test_R2_empty_verify_does_not_clear():
    sk = "r2"; _fresh(sk)
    result = _arm_bound_result(sk, label="r2", tool="catgo_dos_total")
    # an empty verify (no gate ran → covered False) must NOT clear
    enf.mark_verified(False, result_digest=result["result_digest"], session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    # a real verify (a gate ran) clears it
    enf.mark_verified(True, result_digest=result["result_digest"], session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.ALLOW


def test_clean_session_allows_submit():
    sk = "clean"; _fresh(sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.ALLOW


def test_failed_numeric_run_does_not_arm():
    sk = "fail"; _fresh(sk)
    enf.postmark("catgo_dos_compute", {}, ok=False, session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.ALLOW


def test_strictest_wins():
    assert enf.strictest(enf.ALLOW, enf.PROMPT) == enf.PROMPT
    assert enf.strictest(enf.PROMPT, enf.FORBIDDEN) == enf.FORBIDDEN


# ---- R5: a FAILING verify must not clear the gate -------------------------
# Found by driving the live MCP server as an agent: catgo_verify returned
# "FAIL — do NOT report this result as correct" and the very next submit went
# through, because clearing keyed on "a gate ran" alone.
def test_R5_failed_verify_keeps_submit_forbidden():
    sk = "r5"; _fresh(sk)
    enf.postmark("catgo_catalysis", {"action": "oer"}, ok=True, session_key=sk)
    enf.mark_verified(True, failed_gates=["ul_range"], failed_taxa=["G2"], session_key=sk)
    dec, why = enf.precheck("catgo_workflow", {"action": "submit"}, sk)
    assert dec == enf.FORBIDDEN and "ul_range" in why and "G2" in why


def test_R5_uncertified_claim_keeps_submit_forbidden():
    sk = "r5c"; _fresh(sk)
    result = _arm_bound_result(sk, label="r5c")
    enf.mark_verified(
        True,
        uncertified_claims=["binding_dG"],
        result_digest=result["result_digest"],
        session_key=sk,
    )
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    # fixing the result and re-verifying clean clears both flags
    enf.mark_verified(True, result_digest=result["result_digest"], session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.ALLOW


def test_two_legacy_results_cannot_be_cleared_by_one_unbound_verify():
    sk = "legacy-scope"; _fresh(sk)
    enf.postmark("catgo_energy", {}, ok=True, session_key=sk)
    enf.postmark("catgo_energy", {}, ok=True, session_key=sk)
    assert enf.state(sk)["legacy_unverified"] == 2
    enf.mark_verified(True, session_key=sk)
    assert enf.state(sk)["legacy_unverified"] == 2
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    assert enf.precheck("catgo_campaign", {"action": "report"}, sk)[0] == enf.FORBIDDEN


def test_corrected_result_supersedes_only_same_logical_identity():
    sk = "supersede"; _fresh(sk)
    first = prov.envelope(
        {"energy": -100.0}, tool="catgo_energy", action="parse",
        inputs={"workflow_id": "wf", "task_id": "task-1"},
    )
    second = prov.envelope(
        {"energy": -2.0}, tool="catgo_energy", action="parse",
        inputs={"workflow_id": "wf", "task_id": "task-1"},
    )
    unrelated = prov.envelope(
        {"energy": -3.0}, tool="catgo_energy", action="parse",
        inputs={"workflow_id": "wf", "task_id": "task-2"},
    )
    enf.postmark(
        "catgo_energy",
        {"_result_records": prov.extract_result_records(first)},
        session_key=sk,
    )
    enf.mark_verified(
        True,
        failed_gates=["energy_physical"],
        result_digest=first["result_digest"],
        session_key=sk,
    )
    enf.postmark(
        "catgo_energy",
        {"_result_records": prov.extract_result_records(second)},
        session_key=sk,
    )
    state = enf.state(sk)
    assert first["result_digest"] not in state["pending_digests"]
    assert first["result_digest"] not in state["failed_by_digest"]
    assert state["failed"] == [] and state["unverified"] == 1
    assert any(item.get("event") == "result_superseded" for item in state["audit"])

    enf.postmark(
        "catgo_energy",
        {"_result_records": prov.extract_result_records(unrelated)},
        session_key=sk,
    )
    enf.mark_verified(
        True, result_digest=second["result_digest"], session_key=sk,
    )
    assert enf.state(sk)["unverified"] == 1
    assert enf.precheck("catgo_campaign", {"action": "report"}, sk)[0] == enf.FORBIDDEN
    enf.mark_verified(
        True, result_digest=unrelated["result_digest"], session_key=sk,
    )
    assert enf.precheck("catgo_campaign", {"action": "report"}, sk)[0] == enf.ALLOW


def test_distinct_implicit_structure_records_cannot_supersede_each_other():
    sk = "implicit-structure-scope"; _fresh(sk)
    structure_a = {"charge": 0, "sites": [{"xyz": [0.0, 0.0, 0.0]}]}
    structure_b = {"sites": [{"xyz": [1.0, 0.0, 0.0]}]}
    record_a = prov.structure_input_record(structure_a, source="viewer")
    record_b = prov.structure_input_record(structure_b, source="viewer")
    # Dict key order must not perturb the content digest.
    assert record_a == prov.structure_input_record(
        {"sites": [{"xyz": [0.0, 0.0, 0.0]}], "charge": 0},
        source="viewer",
    )
    assert record_a["digest"] != record_b["digest"]

    envelopes = [
        prov.envelope(
            {"rdf": [1.0, 2.0]},
            tool="catgo_analyze",
            action="rdf",
            inputs={"action": "rdf", prov.STRUCTURE_INPUT_RECORD_KEY: record},
        )
        for record in (record_a, record_b)
    ]
    assert (
        envelopes[0]["provenance"]["result_identity"]
        != envelopes[1]["provenance"]["result_identity"]
    )
    for envelope in envelopes:
        enf.postmark(
            "catgo_analyze",
            {"action": "rdf", "_result_records": prov.extract_result_records(envelope)},
            session_key=sk,
        )
    state = enf.state(sk)
    assert set(state["pending_digests"]) == {
        envelope["result_digest"] for envelope in envelopes
    }
    assert not [
        event for event in state["audit"]
        if event.get("event") == "result_superseded"
    ]


def test_R5_override_is_narrow_justified_and_one_shot():
    sk = "r5o"; _fresh(sk)
    enf.postmark("catgo_catalysis", {"action": "oer"}, ok=True, session_key=sk)
    enf.mark_verified(True, failed_gates=["ul_range"], failed_taxa=["G2"], session_key=sk)
    for bad_gates, why in (([], "x" * 30),                       # no gate named
                           (["physical_range"], "x" * 30),       # not the failing gate
                           (["ul_range"], "ok")):                # justification too thin
        try:
            enf.register_override(bad_gates, why, session_key=sk)
        except ValueError:
            pass
        else:
            assert False, f"override should be refused: {bad_gates!r} {why!r}"
    enf.register_override(["ul_range"], "U_L window is reaction-dependent for CER; "
                                        "geometry verified in D-06", session_key=sk)
    dec, why = enf.precheck("catgo_workflow", {"action": "submit"}, sk)
    assert dec == enf.PROMPT and "OVERRIDE SPENT" in why
    # spent — the next submit is blocked again, and the waiver is on record
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    audit = enf.state(sk)["audit"]
    assert len(audit) == 1 and audit[0]["waived"] == ["ul_range"]


def test_R5_no_override_without_a_failure():
    sk = "r5n"; _fresh(sk)
    try:
        enf.register_override(["ul_range"], "x" * 40, session_key=sk)
    except ValueError:
        pass
    else:
        assert False, "override must be refused when nothing is failing"


def test_R6_uncertified_claim_counts_even_with_no_coverage():
    # found by the live provenance-loop probe: with zero runnable gates, a refused
    # claim was dropped, so the agent saw only the vaguer "unverified" message and
    # the refusal left no trace in the session state.
    sk = "r6"; _fresh(sk)
    enf.postmark("catgo_catalysis", {"action": "oer"}, ok=True, session_key=sk)
    enf.mark_verified(False, uncertified_claims=["limiting_potential"], session_key=sk)
    dec, why = enf.precheck("catgo_workflow", {"action": "submit"}, sk)
    assert dec == enf.FORBIDDEN and "claim:limiting_potential" in why, why
    # and a genuinely empty verify (nothing ran, nothing refused) still does not clear
    sk2 = "r6b"; _fresh(sk2)
    enf.postmark("catgo_catalysis", {"action": "oer"}, ok=True, session_key=sk2)
    enf.mark_verified(False, session_key=sk2)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk2)[0] == enf.FORBIDDEN
    assert enf.state(sk2)["failed"] == []


def test_R5_no_coverage_has_an_escape_hatch():
    # a result no gate can check: nothing failed, so there is nothing to fix —
    # without the sentinel waiver the session would be blocked forever.
    sk = "r5nc"; _fresh(sk)
    enf.postmark("catgo_analyze", {}, ok=True, session_key=sk)
    enf.mark_verified(False, session_key=sk)          # all gates SKIP
    dec, why = enf.precheck("catgo_workflow", {"action": "submit"}, sk)
    assert dec == enf.FORBIDDEN and enf.NO_COVERAGE in why
    try:
        enf.register_override([enf.NO_COVERAGE], "short", session_key=sk)
    except ValueError:
        pass
    else:
        assert False, "no-coverage waiver still needs a real justification"
    enf.register_override([enf.NO_COVERAGE],
                          "MD restart energies carry no field any gate reads; "
                          "trajectory checked by hand", session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.PROMPT
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    # and the hatch must not open when a gate actually failed — that must be fixed
    sk2 = "r5nc2"; _fresh(sk2)
    enf.postmark("catgo_analyze", {}, ok=True, session_key=sk2)
    enf.mark_verified(True, failed_gates=["ul_range"], failed_taxa=["G2"], session_key=sk2)
    try:
        enf.register_override([enf.NO_COVERAGE], "x" * 40, session_key=sk2)
    except ValueError:
        pass
    else:
        assert False, "no-coverage sentinel must not waive a real FAIL"


# ---- PR #546 review regressions -------------------------------------------
def test_R7_engine_readonly_actions_usable_while_pending():
    # blanket-treating catgo_workflow_engine as a submit blocked status / list /
    # get_result / pause — exactly the diagnostic calls an agent needs mid-pending
    sk = "r7"; _fresh(sk)
    enf.postmark("catgo_kmc_simulate", {}, ok=True, session_key=sk)
    for benign in ("status", "list", "get_result", "get_dag", "pause", "create",
                   "add_task", "modify_params", "reset"):
        assert enf.precheck("catgo_workflow_engine", {"action": benign}, sk)[0] == enf.ALLOW, benign
    for spend in ("submit", "retry", "resume"):
        assert enf.precheck("catgo_workflow_engine", {"action": spend}, sk)[0] == enf.FORBIDDEN, spend


def test_R8_md_kmc_optimize_families_arm_geometry_actions_exempt():
    for tool in ("catgo_kmc_simulate", "catgo_kmc_scan", "catgo_md_rdf", "catgo_md_msd",
                 "catgo_optimize", "catgo_cn_coupling_network"):
        assert enf._is_numeric(tool, {}), tool
    for exempt in ("adsorption_sites", "dft_input", "symmetry"):
        assert not enf._is_numeric("catgo_analyze", {"action": exempt}), exempt


def test_R10_bare_fail_then_clean_reverify_clears_no_dead_end():
    # live_mcp_probe found: a bare-dict verify that FAILed set legacy_failed, and no
    # later clean verify could ever clear it — the FORBIDDEN message's "a clean audit
    # clears this" was false, and the bare fix-and-reverify loop dead-ended
    sk = "r10"; _fresh(sk)
    enf.postmark("catgo_analyze", {"action": "rdf"}, ok=True, session_key=sk)
    enf.mark_verified(True, failed_gates=["physical_range"], failed_taxa=["A2"], session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    enf.mark_verified(True, session_key=sk)
    assert enf.state(sk)["failed"] == []
    # produced-result pending is NOT released by an unbound verify
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN


def test_R11_real_oer_envelope_certifies_and_clears_end_to_end():
    # the real catgo_catalysis oer flow: the envelope must carry producer-owned
    # ul_* provenance (CHE module properties) so the bound result certifies and
    # clears WITHOUT an override — previously every real oer/co2rr/nrr call
    # declared ul_* unverifiable and the digest binding made supplying them
    # impossible: certification was override-only
    from catgo.mcp_tools import server_claude_code as scc
    # use the SAME module instance scc's handlers use — the flat `enf` import is a
    # separate instance with its own _sessions (the package/flat dual-import trap)
    from catgo.mcp_tools import verify_enforcement as penf
    penf._sessions.pop("default", None)
    out = asyncio.run(scc._handle_catalysis(None, {
        "action": "oer", "params": {"dG_OH": 0.9, "dG_O": 2.4, "dG_OOH": 4.14}}))[0].text
    env = json.loads(out)
    assert "unverifiable_without" not in env, env.get("unverifiable_without")
    for k in ("ul_reaction", "ul_reference", "ul_convention"):
        assert env["provenance"][k], k
    recs = prov.extract_result_records(out)
    penf.postmark("catgo_catalysis", {"action": "oer", "_result_records": recs}, ok=True)
    assert penf.precheck("catgo_workflow", {"action": "submit"})[0] == penf.FORBIDDEN
    verdict = scc._handle_verify({"result": env})[0].text
    assert "PROVENANCE-ONLY" in verdict or "PASS" in verdict.splitlines()[0], verdict.splitlines()[0]
    assert penf.precheck("catgo_workflow", {"action": "submit"})[0] == penf.ALLOW


def test_R12_every_emitted_claim_type_is_registered():
    # provenance.py emits claims; verify_gates certifies them. A claim emitted but
    # not registered scores UNKNOWN-CLAIM even with complete provenance —
    # certification becomes override-only for that whole tool family
    emitted = set(prov.NEEDS) | set(prov.TOOL_CLAIM.values()) | set(prov.CATALYSIS_CLAIM.values())
    missing = sorted(emitted - set(vg.PROVENANCE_SPEC))
    assert not missing, f"emitted claim types without a PROVENANCE_SPEC entry: {missing}"


def test_R9_declared_missing_gas_entropy_fails_the_audit():
    # gas_entropy_included=False used to score PASS + VERIFIABLE: the verifiability
    # layer only checks presence, and no value gate read the value — certifying the
    # exact G-class error the her_dGH spec exists to catch
    rep = vg.audit({"gas_entropy_included": False})
    st = {v["gate"]: v["status"] for v in rep["verdicts"]}
    assert st["gas_entropy_declared"] == "FAIL"
    assert "G" in rep["coverage"]["failed_taxa"]
    ok = vg.audit({"gas_entropy_included": True})
    assert {v["gate"]: v["status"] for v in ok["verdicts"]}["gas_entropy_declared"] == "PASS"
    # presence still makes the claim checkable — the FAIL now comes from the value
    assert vg.verifiability({"gas_entropy_included": False}, ["her_dGH"])[0]["status"] == "VERIFIABLE"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
    print(f"OK — {len(fns)} tests passed (incl. R1/R2/R3 regressions)")
