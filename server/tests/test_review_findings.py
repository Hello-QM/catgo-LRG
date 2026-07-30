"""Blocking findings from the PR #546 review.

Each test names the production failure it prevents. Grouped by "what was
untrue", because every one of these was a case where the layer claimed a
guarantee it did not deliver.
"""

import importlib

import pytest

mcp_http = importlib.import_module("catgo.routers.mcp_http")
scc = importlib.import_module("catgo.mcp_tools.server_claude_code")
enf = importlib.import_module("catgo.mcp_tools.verify_enforcement")
vg = importlib.import_module("catgo.mcp_tools.verify_gates")
vsub = importlib.import_module("catgo.workflow.engine.vasp_submission")
rc = importlib.import_module("catgo.workflow.engine.result_collector")


# ---- P0: the HTTP transport advertised a tool it could not run -------------
def test_the_http_path_dispatches_every_tool_it_advertises():
    # TOOLS is what /api/mcp lists; a name with no branch answers "Unknown tool".
    import inspect

    src = inspect.getsource(mcp_http._dispatch)
    advertised = {t.name for t in mcp_http.TOOLS}
    missing = [n for n in advertised if f'"{n}"' not in src]
    assert not missing, f"listed but not dispatched on the HTTP path: {missing}"


def test_the_http_path_runs_the_same_verification_wrapper():
    import inspect

    src = inspect.getsource(mcp_http.call_tool)
    assert "run_with_verification" in src, (
        "the HTTP transport bypassed precheck/postmark entirely"
    )


def test_the_wrapper_is_shared_not_copied():
    assert callable(scc.run_with_verification)


# ---- a gate that cannot see its own motivating failure ---------------------
def test_a_requested_incar_tag_absent_from_the_echo_fails():
    # The cp build drops every tag after the first on a line, so the tag never
    # reaches the echo. Skipping absent tags made this gate blind to exactly
    # that, while still reporting "all N requested tags echoed".
    v = vg.gate_incar_tag_echo_identity({"ENCUT": 450, "IVDW": 12}, {"ENCUT": 450})
    assert v["status"] == "FAIL" and "IVDW" in v["detail"]


def test_matching_tags_still_pass():
    v = vg.gate_incar_tag_echo_identity({"ENCUT": 450}, {"ENCUT": 450})
    assert v["status"] == "PASS"


# ---- one energy window cannot judge two families of code ------------------
def test_an_all_electron_energy_is_not_failed_as_unphysical():
    # ORCA -2080.5 eV on 3 atoms is -693 eV/atom: legitimate, and failing it
    # locked HPC submission behind a bogus "known bad result".
    assert vg.gate_energy_physical(-2080.5, 3, code="orca")["status"] == "PASS"


def test_a_pseudopotential_garbage_energy_still_fails():
    assert vg.gate_energy_physical(-90530.0, 100, code="vasp")["status"] == "FAIL"


def test_an_unlabelled_energy_skips_rather_than_guessing():
    verdicts = {v["gate"]: v["status"] for v in vg.audit(
        {"energy": -2080.5, "n_atoms": 3})["verdicts"]}
    assert verdicts["energy_physical"] == "SKIP"


# ---- a result the agent can read must arm the gate ------------------------
def test_reading_a_node_result_arms_verification():
    key = "t-getresult"
    enf._sessions.pop(key, None)
    assert enf._is_numeric("catgo_workflow_engine", {"action": "get_result"})
    enf.postmark("catgo_workflow_engine", {"action": "get_result"}, ok=True,
                 session_key=key)
    assert enf.precheck("catgo_workflow_engine", {"action": "submit"},
                        session_key=key)[0] == enf.FORBIDDEN


def test_progress_queries_stay_free():
    assert not enf._is_numeric("catgo_workflow_engine", {"action": "status"})


# ---- the shipped template must pass the validator it ships with -----------
def test_the_repos_own_shaheen_template_is_accepted():
    from catgo.models.workflow_run import JOB_SCRIPT_PRESETS

    tmpl = next((t["template"] for k, t in JOB_SCRIPT_PRESETS.items()
                 if "$(date)" in t.get("template", "")), None)
    assert tmpl, "the template this test guards no longer exists"
    script = (tmpl.replace("{{work_dir}}", "/scratch/run")
                  .replace("{{vasp_run_command}}", "srun vasp_std"))
    res = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    vsub.validate_vasp_job_script(script, res, use_custodian=False)


def test_command_substitution_on_an_execution_line_is_still_rejected():
    res = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    bad = "module load vasp\nexport X=$(cat /etc/passwd)\nsrun vasp_std\n"
    with pytest.raises(ValueError):
        vsub.validate_vasp_job_script(bad, res, use_custodian=False)


# ---- a quoted tilde is a literal directory --------------------------------
@pytest.mark.parametrize("path,expected", [
    ("~/calculations", "~/calculations"),
    ("~", "~"),
    ("/scratch/plain", "/scratch/plain"),
])
def test_a_home_relative_work_dir_still_expands(path, expected):
    assert rc._quote_remote_dir(path) == expected


def test_a_path_with_spaces_is_still_quoted():
    assert rc._quote_remote_dir("/scratch/a b") == "'/scratch/a b'"
    assert rc._quote_remote_dir("~/a b") == "~/'a b'"


# ---- one process, many clients -------------------------------------------
def test_verification_state_is_per_session_not_global():
    # On the HTTP transport one process serves every client: a shared key lets
    # one user's unverified result block another user's submit.
    a, b = "client-a", "client-b"
    for k in (a, b):
        enf._sessions.pop(k, None)
    enf.postmark("catgo_analyze", {"action": "dos"}, ok=True, session_key=a)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, session_key=a)[0] == enf.FORBIDDEN
    assert enf.precheck("catgo_workflow", {"action": "submit"}, session_key=b)[0] == enf.ALLOW


def test_the_wrapper_derives_a_session_key():
    assert isinstance(scc._verification_session_key(), str)


# ---- declared deps must be the ones imported ------------------------------
def test_the_test_extra_declares_the_http_client_the_code_imports():
    import pathlib
    text = (pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    assert "httpx2" not in text, "httpx2 is not what the code imports"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
