"""Blocking findings from the PR #546 review.

Each test names the production failure it prevents. Grouped by "what was
untrue", because every one of these was a case where the layer claimed a
guarantee it did not deliver.
"""

import asyncio
import importlib
import inspect
import json
import subprocess

import pytest
from mcp.types import TextContent

mcp_http = importlib.import_module("catgo.routers.mcp_http")
scc = importlib.import_module("catgo.mcp_tools.server_claude_code")
enf = importlib.import_module("catgo.mcp_tools.verify_enforcement")
helpers = importlib.import_module("catgo.mcp_tools.helpers")
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
    enf.postmark("catgo_analyze", {"action": "rdf"}, ok=True, session_key=a)
    assert enf.precheck("catgo_workflow", {"action": "submit"}, session_key=a)[0] == enf.FORBIDDEN
    assert enf.precheck("catgo_workflow", {"action": "submit"}, session_key=b)[0] == enf.ALLOW


def test_the_wrapper_derives_a_session_key():
    assert scc._verification_session_key() == "default"


def test_http_transport_uses_protocol_sessions():
    assert mcp_http.session_manager.stateless is False
    if "session_idle_timeout" in inspect.signature(
        mcp_http.StreamableHTTPSessionManager,
    ).parameters:
        assert mcp_http.session_manager.session_idle_timeout == 3600.0


def test_http_session_manager_supports_legacy_and_new_mcp_signatures():
    calls = []

    class LegacyManager:
        def __init__(self, *, app, json_response, stateless):
            calls.append(("legacy", app, json_response, stateless, None))
            self.stateless = stateless

    class TimeoutManager:
        def __init__(
            self,
            *,
            app,
            json_response,
            stateless,
            session_idle_timeout=None,
        ):
            calls.append((
                "timeout", app, json_response, stateless,
                session_idle_timeout,
            ))
            self.stateless = stateless
            self.session_idle_timeout = session_idle_timeout

    legacy = mcp_http._make_session_manager(LegacyManager)
    modern = mcp_http._make_session_manager(TimeoutManager)

    assert legacy.stateless is False
    assert modern.stateless is False
    assert modern.session_idle_timeout == 3600.0
    assert calls == [
        ("legacy", mcp_http.mcp_server, True, False, None),
        ("timeout", mcp_http.mcp_server, True, False, 3600.0),
    ]


def test_bound_http_session_wins_over_stdio_default():
    token = helpers.current_verification_session_id.set("http:mcp:client-a")
    try:
        assert scc._verification_session_key() == "http:mcp:client-a"
    finally:
        helpers.current_verification_session_id.reset(token)


def test_low_level_mcp_sessions_get_distinct_stable_keys(monkeypatch):
    import gc
    from types import SimpleNamespace

    class Session:
        pass

    request = SimpleNamespace(session=Session())
    monkeypatch.setattr(
        type(scc.server),
        "request_context",
        property(lambda self: request),
    )
    first = scc._verification_session_key()
    assert first.startswith("mcp:")
    assert scc._verification_session_key() == first
    enf.postmark("catgo_analyze", {"action": "rdf"}, session_key=first)
    assert first in enf._sessions
    old_session = request.session
    request.session = Session()
    assert scc._verification_session_key() != first
    del old_session
    gc.collect()
    assert first not in enf._sessions


def test_http_asgi_contexts_are_isolated_and_reset(monkeypatch):
    seen = {}

    async def fake_handle(scope, receive, send):
        await asyncio.sleep(0)
        seen[dict(scope["headers"])[b"x-test"]] = (
            helpers.current_panel_id.get(),
            helpers.current_verification_session_id.get(),
        )

    monkeypatch.setattr(mcp_http.session_manager, "handle_request", fake_handle)

    async def scenario():
        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            return None

        base = {"type": "http", "method": "POST", "path": "/"}
        await asyncio.gather(
            mcp_http.mcp_asgi_app(
                {**base, "headers": [
                    (b"x-test", b"tab"),
                    (b"x-catgo-tab-id", b"panel-a"),
                ]},
                receive,
                send,
            ),
            mcp_http.mcp_asgi_app(
                {**base, "headers": [
                    (b"x-test", b"mcp"),
                    (b"mcp-session-id", b"session-b"),
                ]},
                receive,
                send,
            ),
        )

    asyncio.run(scenario())
    assert seen == {
        b"tab": ("panel-a", "http:tab:panel-a"),
        b"mcp": ("default", "http:mcp:session-b"),
    }
    assert helpers.current_panel_id.get() == "default"
    assert helpers.current_verification_session_id.get() is None


# ---- declared deps must be the ones imported ------------------------------
def test_the_test_extra_declares_the_http_client_the_code_imports():
    import pathlib
    text = (pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    assert "httpx2" not in text, "httpx2 is not what the code imports"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))


def _drive_collector(
    use_custodian,
    *,
    incar_live="a" * 64,
    incar_text="",
    potcar_live="c" * 64,
    kpoints_entry=None,
    kpoints_live="d" * 64,
    poscar_exists=True,
    input_overrides=None,
    live_overrides=None,
    omit_live_status=(),
    input_policy=None,
):
    """Drive the REAL parser, not a reimplementation of its rules.

    A test that re-derives the comparison it is checking proves only that the
    test agrees with itself.
    """
    import json as _json
    inputs = {
        "INCAR": {"mandatory": True, "exists": True, "sha256": "a"*64},
        "POSCAR": {"mandatory": True, "exists": poscar_exists,
                   "sha256": "b"*64 if poscar_exists else None},
        "POTCAR": {"mandatory": True, "exists": True, "sha256": "c"*64},
        "KPOINTS": kpoints_entry or {"mandatory": True, "exists": True, "sha256": "d"*64},
    }
    inputs.update(input_overrides or {})
    manifest = {
        "schema_version": 1, "engine": "vasp", "ready": True,
        "binary_declared": True, "missing_mandatory_inputs": [],
        "hash_algorithm": "sha256", "hash_available": True,
        "resolved_run_command": "srun vasp_std", "binary_token": "vasp_std",
        "binary": "vasp_std", "command_source": "test",
        "use_custodian": use_custodian, "inputs": inputs,
    }
    if input_policy is not None:
        manifest["input_policy"] = input_policy
    live = {
        "INCAR": incar_live,
        "POSCAR": "b" * 64,
        "POTCAR": potcar_live,
        "KPOINTS": kpoints_live,
    }
    live.update(live_overrides or {})
    hashes = [
        f"{name} {digest}" if digest else f"{name} ABSENT"
        for name, digest in live.items()
        if name not in omit_live_status
    ]
    raw = (
        "__CATGO_INCAR__\n" + incar_text + "\n"
        "__CATGO_INPUT_MANIFEST__\n" + _json.dumps(manifest) + "\n"
        "__CATGO_INPUT_HASHES__\n" + "\n".join(hashes) + "\n"
    )
    return rc._parse_vasp_metadata(raw)


def _errors_of(res):
    return res.get("input_manifest_errors") or []


# ---- custodian self-healing is recorded provenance, not tampering ---------
def test_custodian_rewriting_the_incar_is_recorded_but_fails_closed():
    # The remote manifest does not independently prove who changed an input.
    # Keep the useful diff, but do not certify it until a submit-time ledger
    # anchors both custodian mode and correction evidence.
    res = _drive_collector(True, incar_live="9" * 64)
    assert "inputs.INCAR.unanchored_rewrite" in _errors_of(res)
    assert res["custodian_rewritten_inputs"]["INCAR"] == {
        "submitted": "a" * 64, "ran": "9" * 64,
    }


def test_the_same_rewrite_without_custodian_is_still_an_error():
    res = _drive_collector(False, incar_live="9" * 64)
    assert "inputs.INCAR.live_hash" in _errors_of(res)


def test_a_changed_potcar_is_an_error_even_under_custodian():
    # Custodian never rewrites POTCAR; a change there is not self-healing.
    res = _drive_collector(True, potcar_live="9" * 64)
    assert "inputs.POTCAR.live_hash" in _errors_of(res)


def test_an_optional_missing_kpoints_is_accepted():
    # KSPACING jobs legitimately have no KPOINTS file.
    res = _drive_collector(
        False,
        kpoints_entry={"mandatory": False, "exists": False, "sha256": None},
        kpoints_live=None,
        incar_text="KSPACING = 0.25",
    )
    assert not _errors_of(res), _errors_of(res)


def _valid_input_policy(kpoints_policy="vasp_default", required_keys=None):
    return {
        "schema_version": 1,
        "required_keys": required_keys,
        "kpoints_policy": kpoints_policy,
        "artifact_kind": "exact",
        "materialization": {
            "strategy": "exact",
            "resolved": True,
            "base_sha256": None,
            "overlay_sha256": [],
            "materialized_sha256": "a" * 64,
        },
        "checked": True,
        "verdicts": {
            "P4": "PASS",
            "P17": "SKIP" if required_keys is None else "PASS",
        },
        "violations": [],
    }


def test_collector_accepts_legacy_v1_and_valid_input_policy_extension():
    legacy = _drive_collector(False)
    assert not _errors_of(legacy), _errors_of(legacy)
    assert "input_policy" not in legacy

    policy = _valid_input_policy(
        kpoints_policy="explicit_regular_mesh",
        required_keys=["ENCUT", "EDIFF"],
    )
    extended = _drive_collector(False, input_policy=policy)
    assert not _errors_of(extended), _errors_of(extended)
    assert extended["input_policy"] == policy


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda p: p.update({"schema_version": 2}), "input_policy.schema_version"),
        (lambda p: p.update({"required_keys": []}), "input_policy.required_keys"),
        (lambda p: p.update({"required_keys": ["encut"]}), "input_policy.required_keys"),
        (lambda p: p.update({"kpoints_policy": "unknown"}), "input_policy.kpoints_policy"),
        (lambda p: p.update({"checked": False}), "input_policy.checked"),
        (lambda p: p.update({"violations": ["P4:x"]}), "input_policy.violations"),
        (
            lambda p: p["materialization"].update(
                {"materialized_sha256": "9" * 64}
            ),
            "input_policy.materialization.incar_hash_mismatch",
        ),
    ],
)
def test_collector_rejects_malformed_input_policy_extension(mutate, expected):
    policy = _valid_input_policy()
    mutate(policy)
    res = _drive_collector(False, input_policy=policy)
    assert expected in _errors_of(res), _errors_of(res)


def test_collector_strict_policy_cannot_mark_kpoints_optional():
    policy = _valid_input_policy(kpoints_policy="explicit_regular_mesh")
    res = _drive_collector(
        False,
        input_policy=policy,
        kpoints_entry={"mandatory": False, "exists": False, "sha256": None},
        kpoints_live=None,
        incar_text="KSPACING=0.25",
    )
    assert "input_policy.explicit_kpoints_not_mandatory" in _errors_of(res)


def test_an_optional_kpoints_appearing_without_custodian_is_rejected():
    res = _drive_collector(
        False,
        kpoints_entry={"mandatory": False, "exists": False, "sha256": None},
        kpoints_live="d" * 64,
        incar_text="KSPACING = 0.25",
    )
    assert "inputs.KPOINTS.unexpected_live_file" in _errors_of(res)


def test_custodian_creating_optional_kpoints_is_recorded():
    res = _drive_collector(
        True,
        kpoints_entry={"mandatory": False, "exists": False, "sha256": None},
        kpoints_live="d" * 64,
        incar_text="KSPACING = 0.25",
    )
    assert "inputs.KPOINTS.unanchored_rewrite" in _errors_of(res)
    assert res["custodian_rewritten_inputs"]["KPOINTS"] == {
        "submitted": None, "ran": "d" * 64,
    }


def test_a_mandatory_missing_input_is_still_an_error():
    res = _drive_collector(False, poscar_exists=False)
    assert "inputs.POSCAR.exists" in _errors_of(res)


@pytest.mark.parametrize("name", ["INCAR", "POSCAR", "POTCAR"])
def test_core_vasp_inputs_cannot_declare_themselves_optional(name):
    entry = {"mandatory": False, "exists": False, "sha256": None}
    parsed = _drive_collector(
        False,
        input_overrides={name: entry},
        live_overrides={name: None},
    )
    assert f"inputs.{name}.mandatory" in _errors_of(parsed)


@pytest.mark.parametrize("bad_bool", [0, 1])
def test_manifest_boolean_fields_reject_integers(bad_bool):
    entry = {"mandatory": bad_bool, "exists": True, "sha256": "d" * 64}
    res = _drive_collector(False, kpoints_entry=entry)
    assert "inputs.KPOINTS.mandatory" in _errors_of(res)


@pytest.mark.parametrize("bad_bool", [0, 1])
def test_manifest_exists_field_rejects_integers(bad_bool):
    entry = {"mandatory": True, "exists": bad_bool, "sha256": "d" * 64}
    res = _drive_collector(False, kpoints_entry=entry)
    assert "inputs.KPOINTS.exists" in _errors_of(res)


def test_manifest_custodian_mode_requires_a_real_boolean():
    res = _drive_collector(1)
    assert "use_custodian" in _errors_of(res)


def test_missing_live_input_status_fails_closed():
    res = _drive_collector(False, omit_live_status=("POTCAR",))
    assert "inputs.POTCAR.live_status" in _errors_of(res)


def test_present_but_unhashable_input_fails_closed():
    res = _drive_collector(False, live_overrides={"POTCAR": "UNAVAILABLE"})
    assert "inputs.POTCAR.live_hash" in _errors_of(res)


@pytest.mark.parametrize("incar", [
    "",
    "# KSPACING = 0.25",
    "KSPACING = 0",
    "KSPACING = -0.25",
    "KSPACING = nope",
])
def test_optional_kpoints_requires_active_positive_kspacing(incar):
    res = _drive_collector(
        False,
        kpoints_entry={"mandatory": False, "exists": False, "sha256": None},
        kpoints_live=None,
        incar_text=incar,
    )
    assert "inputs.KPOINTS.optional_without_kspacing" in _errors_of(res)


# ---- KSPACING jobs must survive the submit-side preflight -----------------
def test_the_preflight_exempts_kpoints_when_kspacing_is_set():
    cmd = vsub.build_vasp_input_manifest_command(
        "/scratch/run",
        vsub.VaspCommandResolution(command="srun vasp_std", binary_token="vasp_std",
                                   source="test"),
    )
    assert "KSPACING" in cmd, "the preflight cannot tell a KSPACING job apart"
    assert 'catgo_name" = KPOINTS' in cmd


def test_kspacing_preflight_marks_missing_kpoints_optional(tmp_path):
    for name, content in {
        "INCAR": "ENCUT = 520\nKSPACING = 0.25\n",
        "POSCAR": "structure\n",
        "POTCAR": "potential\n",
    }.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    resolution = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    command = vsub.build_vasp_input_manifest_command(str(tmp_path), resolution)
    completed = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    manifest = json.loads(
        (tmp_path / vsub.VASP_INPUT_MANIFEST).read_text(encoding="utf-8")
    )
    assert manifest["ready"] is True
    assert manifest["missing_mandatory_inputs"] == []
    assert manifest["inputs"]["KPOINTS"] == {
        "mandatory": False, "exists": False, "sha256": None,
    }


def test_preflight_still_requires_kpoints_without_kspacing(tmp_path):
    for name, content in {
        "INCAR": "ENCUT = 520\n",
        "POSCAR": "structure\n",
        "POTCAR": "potential\n",
    }.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    resolution = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    command = vsub.build_vasp_input_manifest_command(str(tmp_path), resolution)
    completed = subprocess.run(
        ["/bin/sh", "-c", command],
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 66
    manifest = json.loads(
        (tmp_path / vsub.VASP_INPUT_MANIFEST).read_text(encoding="utf-8")
    )
    assert manifest["ready"] is False
    assert manifest["missing_mandatory_inputs"] == ["KPOINTS"]


@pytest.mark.parametrize("incar", [
    "ENCUT = 520 KSPACING = 0.25",
    "ENCUT = 520; KSPACING = 2.5D-1",
    "KSPACING = -1; KSPACING = 0.25",
])
def test_preflight_accepts_active_multitag_kspacing(tmp_path, incar):
    for name, content in {
        "INCAR": incar + "\n",
        "POSCAR": "structure\n",
        "POTCAR": "potential\n",
    }.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    resolution = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    completed = subprocess.run(
        ["/bin/sh", "-c", vsub.build_vasp_input_manifest_command(
            str(tmp_path), resolution,
        )],
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr


@pytest.mark.parametrize("incar,expected_code,expected_p4", [
    ("# KSPACING = 0.25", 66, "SKIP"),
    ("KSPACING =", 68, "FAIL"),
    ("KSPACING = 0", 68, "FAIL"),
    ("KSPACING = -0.25", 68, "FAIL"),
    ("KSPACING = nope", 68, "FAIL"),
    ("KSPACING = 1_0", 68, "FAIL"),
    ("KSPACING = 0.25; KSPACING = -1", 68, "FAIL"),
])
def test_preflight_rejects_invalid_or_inactive_kspacing(
    tmp_path, incar, expected_code, expected_p4,
):
    for name, content in {
        "INCAR": incar + "\n",
        "POSCAR": "structure\n",
        "POTCAR": "potential\n",
    }.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    resolution = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    completed = subprocess.run(
        ["/bin/sh", "-c", vsub.build_vasp_input_manifest_command(
            str(tmp_path), resolution,
        )],
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == expected_code
    manifest = json.loads(
        (tmp_path / vsub.VASP_INPUT_MANIFEST).read_text(encoding="utf-8")
    )
    assert manifest["input_policy"]["verdicts"]["P4"] == expected_p4
    assert manifest["input_policy"]["violations"] == (
        ["P4:kspacing_not_positive_finite"] if expected_p4 == "FAIL" else []
    )


def test_the_manifest_records_whether_custodian_may_rewrite():
    res = vsub.VaspCommandResolution(command="srun vasp_std", binary_token="vasp_std",
                                     source="test")
    on = vsub.build_vasp_input_manifest_command("/w", res, use_custodian=True)
    off = vsub.build_vasp_input_manifest_command("/w", res, use_custodian=False)
    assert '"use_custodian": %s' in on
    assert '"true"' in on and '"false"' in off


# ---- the input audit must actually run -----------------------------------
def test_the_input_precheck_is_called_from_the_submit_path():
    import inspect
    src = inspect.getsource(vsub.write_vasp_input_manifest)
    assert "_audit_vasp_inputs" in src, "precheck_inputs was dead code"
    assert "precheck_inputs" in inspect.getsource(vsub._audit_vasp_inputs)


def test_input_precheck_receives_potcar_titels(monkeypatch):
    seen = {}

    def fake_precheck(incar, **kwargs):
        seen["incar"] = incar
        seen.update(kwargs)
        return []

    monkeypatch.setattr(vg, "precheck_inputs", fake_precheck)

    class Connection:
        async def run(self, command, check=False):
            return type("Response", (), {
                "stdout": (
                    "<<<CATGO_INCAR>>>\nENCUT = 520\n"
                    "<<<CATGO_KPOINTS>>>\nmesh\n"
                    "<<<CATGO_POTCAR_TITELS>>>\n"
                    "TITEL = PAW_PBE Fe_pv 06Sep2000\n"
                    "TITEL = PAW_PBE O 08Apr2002\n"
                ),
            })()

    class HPC:
        conn = Connection()

        async def run_on_owner(self, factory):
            return await factory()

    resolution = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    policy = vsub.VaspInputPolicy(required_keys=("ENCUT",))
    asyncio.run(
        vsub._audit_vasp_inputs(
            HPC(), "/work", resolution, input_policy=policy,
        )
    )
    assert seen["titels"] == [
        "PAW_PBE Fe_pv 06Sep2000",
        "PAW_PBE O 08Apr2002",
    ]
    assert seen["required_keys"] == ["ENCUT"]
    assert seen["kpoints_policy"] == "vasp_default"


def test_input_precheck_preserves_present_empty_kpoints(monkeypatch):
    seen = {}

    def fake_precheck(incar, **kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(vg, "precheck_inputs", fake_precheck)

    class Connection:
        async def run(self, command, check=False):
            return type("Response", (), {
                "stdout": (
                    "<<<CATGO_INCAR>>>\nENCUT=520\n"
                    "<<<CATGO_KPOINTS>>>\n"
                    "<<<CATGO_KPOINTS_EXISTS>>>\ntrue\n"
                    "<<<CATGO_POTCAR_TITELS>>>\n"
                ),
            })()

    class HPC:
        conn = Connection()

        async def run_on_owner(self, factory):
            return await factory()

    resolution = vsub.VaspCommandResolution(
        command="srun vasp_std", binary_token="vasp_std", source="test",
    )
    asyncio.run(vsub._audit_vasp_inputs(HPC(), "/work", resolution))
    assert seen["kpoints_text"] is not None
    assert not seen["kpoints_text"].strip()


# ---- a slow numeric call must not leave a race window --------------------
def test_a_numeric_call_blocks_submits_while_still_in_flight():
    key = "t-inflight"
    enf._sessions.pop(key, None)
    enf.arm_pending("catgo_analyze", session_key=key)
    assert enf.precheck("catgo_workflow", {"action": "submit"},
                        session_key=key)[0] == enf.FORBIDDEN


def test_a_failed_in_flight_call_does_not_wedge_the_session():
    key = "t-inflight-fail"
    enf._sessions.pop(key, None)
    enf.arm_pending("catgo_analyze", session_key=key)
    enf.postmark("catgo_analyze", {"action": "dos"}, ok=False, session_key=key)
    enf.finish_pending(session_key=key)
    assert enf.precheck("catgo_workflow", {"action": "submit"},
                        session_key=key)[0] == enf.ALLOW


def test_an_unrelated_postmark_cannot_retire_an_in_flight_numeric():
    key = "t-inflight-unrelated"
    enf._sessions.pop(key, None)
    enf.arm_pending("catgo_analyze", session_key=key)
    enf.postmark("catgo_view", {"action": "get_state"}, ok=True, session_key=key)
    assert enf.precheck(
        "catgo_workflow", {"action": "submit"}, session_key=key
    )[0] == enf.FORBIDDEN
    enf.finish_pending(session_key=key)


def test_a_failed_gate_override_cannot_waive_an_in_flight_numeric():
    key = "t-inflight-override"
    enf._sessions.pop(key, None)
    enf.postmark("catgo_analyze", {"action": "rdf"}, ok=True, session_key=key)
    enf.mark_verified(
        True, failed_gates=["physical_range"], failed_taxa=["C1"], session_key=key,
    )
    enf.register_override(
        ["physical_range"],
        "The range gate is inapplicable to this documented all-electron result.",
        session_key=key,
    )
    enf.arm_pending("catgo_energy", session_key=key)
    decision, reason = enf.precheck(
        "catgo_workflow", {"action": "submit"}, session_key=key,
    )
    assert decision == enf.FORBIDDEN
    assert "still running" in reason
    enf.finish_pending(session_key=key)


def test_both_mcp_variants_use_the_shared_lifecycle_wrapper():
    import inspect

    full_server = importlib.import_module("catgo.mcp_tools.server")
    assert "run_with_verification" in inspect.getsource(full_server.handle_call_tool)


def test_shared_wrapper_blocks_during_dispatch_and_retires_after_failure():
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_numeric(name, arguments):
            started.set()
            await release.wait()
            raise RuntimeError("synthetic dispatch failure")

        key = scc._verification_session_key()
        enf._sessions.pop(key, None)
        task = asyncio.create_task(
            scc.run_with_verification("catgo_analyze", {"action": "rdf"}, slow_numeric)
        )
        await started.wait()
        blocked = enf.precheck(
            "catgo_workflow", {"action": "submit"}, session_key=key,
        )
        release.set()
        with pytest.raises(RuntimeError, match="synthetic dispatch failure"):
            await task
        return blocked, enf.state(key)

    blocked, state = asyncio.run(scenario())
    assert blocked[0] == enf.FORBIDDEN
    assert state["in_flight"] == 0
    assert state["unverified"] == 0


def test_dos_guidance_does_not_arm_numeric_verification():
    async def dispatch(name, arguments):
        return await scc._handle_analyze(None, arguments)

    key = scc._verification_session_key()
    enf._sessions.pop(key, None)
    result = asyncio.run(scc.run_with_verification(
        "catgo_analyze", {"action": "dos"}, dispatch,
    ))
    assert "DOS needs an electronic-structure" in result[0].text
    assert not enf._is_numeric("catgo_analyze", {"action": "dos"})
    state = enf.state(key)
    assert state["in_flight"] == 0
    assert state["unverified"] == 0


@pytest.mark.parametrize("action", ["status", "results", "step_error"])
def test_dynamic_workflow_result_is_prearmed_before_response(action):
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_result(name, arguments):
            started.set()
            await release.wait()
            return [TextContent(
                type="text",
                text='{"steps":[{"id":"n1","result_json":{"energy":-1.0}}]}',
            )]

        key = scc._verification_session_key()
        enf._sessions.pop(key, None)
        task = asyncio.create_task(
            scc.run_with_verification(
                "catgo_workflow", {"action": action}, slow_result,
            )
        )
        await started.wait()
        blocked = enf.precheck(
            "catgo_workflow", {"action": "submit"}, session_key=key,
        )
        release.set()
        await task
        return blocked, enf.state(key)

    blocked, state = asyncio.run(scenario())
    assert blocked[0] == enf.FORBIDDEN
    assert state["in_flight"] == 0
    assert state["unverified"] == 1


def test_empty_dynamic_workflow_response_retires_speculative_marker():
    async def dispatch(name, arguments):
        return [TextContent(type="text", text='{"steps":[]}')]

    key = scc._verification_session_key()
    enf._sessions.pop(key, None)
    asyncio.run(scc.run_with_verification(
        "catgo_workflow", {"action": "results"}, dispatch,
    ))
    state = enf.state(key)
    assert state["in_flight"] == 0
    assert state["unverified"] == 0


@pytest.mark.parametrize("message", [
    "catgo_analyze timed out. The operation may still be running — try again.",
    "catgo_analyze encountered an internal error. Check server logs for details.",
])
def test_http_error_prose_does_not_create_a_pending_result(message):
    async def dispatch(name, arguments):
        return [TextContent(type="text", text=message)]

    key = scc._verification_session_key()
    enf._sessions.pop(key, None)
    asyncio.run(scc.run_with_verification(
        "catgo_analyze", {"action": "rdf"}, dispatch,
    ))
    state = enf.state(key)
    assert state["in_flight"] == 0
    assert state["unverified"] == 0
