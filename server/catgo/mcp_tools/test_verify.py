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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_gates as vg
import verify_enforcement as enf


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
        v = vg.verifiability({"ads_titels": empty, "bare_titels": empty}, ["binding_dG"])
        assert v[0]["status"] == "UNVERIFIABLE", f"empty {empty!r} wrongly certified"
    # non-empty value → certified
    v = vg.verifiability({"ads_titels": ["PAW_PBE Hf_sv"], "bare_titels": ["PAW_PBE Hf_sv"]},
                         ["binding_dG"])
    assert v[0]["status"] == "VERIFIABLE"


def test_unknown_claim_is_default_deny():
    v = vg.verifiability({}, ["nonsense"])
    assert v[0]["status"] == "UNKNOWN-CLAIM"
    assert v[0]["status"] in vg.NOT_CERTIFIED


# ---- enforcement ----------------------------------------------------------
def _fresh(sk):
    enf._sessions.pop(sk, None)


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


def test_R1_fine_grained_numeric_blocks_submit():
    sk = "r1"; _fresh(sk)
    # a 61-tool numeric result must arm the gate
    enf.postmark("catgo_catalysis_oer", {}, ok=True, session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN


def test_R2_empty_verify_does_not_clear():
    sk = "r2"; _fresh(sk)
    enf.postmark("catgo_dos_total", {}, ok=True, session_key=sk)
    # an empty verify (no gate ran → covered False) must NOT clear
    enf.mark_verified(False, session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    # a real verify (a gate ran) clears it
    enf.mark_verified(True, session_key=sk)
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
    enf.postmark("catgo_analyze", {}, ok=True, session_key=sk)
    enf.mark_verified(True, uncertified_claims=["binding_dG"], session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.FORBIDDEN
    # fixing the result and re-verifying clean clears both flags
    enf.mark_verified(True, session_key=sk)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, sk)[0] == enf.ALLOW


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


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
    print(f"OK — {len(fns)} tests passed (incl. R1/R2/R3 regressions)")
