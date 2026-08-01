"""Fail-closed human approval chain for verification overrides."""

import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient
from mcp.types import TextContent

from catgo.mcp_tools import helpers
from catgo.mcp_tools import server_claude_code as scc
from catgo.mcp_tools import verify_enforcement as enf
from catgo.routers.system import router as system_router


def _failed_override_session(key):
    enf._sessions.pop(key, None)
    enf.postmark("catgo_analyze", {"action": "rdf"}, ok=True, session_key=key)
    enf.mark_verified(
        True, failed_gates=["physical_range"], failed_taxa=["C1"],
        session_key=key,
    )
    enf.register_override(
        ["physical_range"],
        "This documented all-electron result is outside the pseudopotential range.",
        session_key=key,
    )


def test_prompt_is_fail_closed_and_exact_approved_retry_dispatches():
    key = "http:tab:override-wrapper"
    _failed_override_session(key)
    calls = []

    async def dispatch(name, arguments):
        calls.append((name, arguments))
        return [TextContent(type="text", text="submitted")]

    token = helpers.current_verification_session_id.set(key)
    try:
        first = asyncio.run(scc.run_with_verification(
            "catgo_workflow", {"action": "submit", "workflow_id": "wf-1"}, dispatch,
        ))
        assert calls == []
        assert "HUMAN APPROVAL REQUIRED" in first[0].text
        challenge = next(iter(enf.state(key)["approval_challenges"]))

        forged = asyncio.run(scc.run_with_verification(
            "catgo_workflow",
            {"action": "submit", "workflow_id": "wf-1",
             enf.APPROVAL_ARG: "agent-invented"},
            dispatch,
        ))
        assert calls == [] and "invalid" in forged[0].text

        enf.approve_override(challenge, session_key=key, approved_by="test-human")
        result = asyncio.run(scc.run_with_verification(
            "catgo_workflow",
            {"action": "submit", "workflow_id": "wf-1",
             enf.APPROVAL_ARG: challenge},
            dispatch,
        ))
    finally:
        helpers.current_verification_session_id.reset(token)

    assert calls == [("catgo_workflow", {"action": "submit", "workflow_id": "wf-1"})]
    assert "HUMAN-APPROVED OVERRIDE" in result[0].text
    audit = enf.state(key)["audit"][-1]
    assert audit["approval_id"] == challenge
    assert audit["approved_by"] == "test-human"


def test_approval_is_bound_to_exact_arguments_and_cannot_replay():
    key = "exact-override"
    _failed_override_session(key)
    enf.precheck(
        "catgo_workflow", {"action": "submit", "workflow_id": "wf-1"}, key,
    )
    challenge = next(iter(enf.state(key)["approval_challenges"]))
    enf.approve_override(challenge, session_key=key, approved_by="test-human")
    mismatch = enf.precheck(
        "catgo_workflow",
        {"action": "submit", "workflow_id": "wf-2", enf.APPROVAL_ARG: challenge},
        key,
    )
    assert mismatch[0] == enf.PROMPT
    allowed = enf.precheck(
        "catgo_workflow",
        {"action": "submit", "workflow_id": "wf-1", enf.APPROVAL_ARG: challenge},
        key,
    )
    assert allowed[0] == enf.ALLOW
    enf.register_override(
        ["physical_range"],
        "A second human review would be required for another irreversible release.",
        session_key=key,
    )
    replay = enf.precheck(
        "catgo_workflow",
        {"action": "submit", "workflow_id": "wf-1", enf.APPROVAL_ARG: challenge},
        key,
    )
    assert replay[0] == enf.PROMPT


def test_approved_d1_waiver_cannot_release_unverified_d2():
    key = "digest-bound-override"
    enf._sessions.pop(key, None)
    d1 = "sha256:" + "1" * 64
    d2 = "sha256:" + "2" * 64
    enf.postmark(
        "catgo_analyze", {"action": "rdf", "_result_digests": [d1]},
        session_key=key,
    )
    enf.mark_verified(
        True, failed_gates=["physical_range"], failed_taxa=["C1"],
        result_digest=d1, session_key=key,
    )
    enf.postmark(
        "catgo_analyze", {"action": "rdf", "_result_digests": [d2]},
        session_key=key,
    )
    enf.register_override(
        ["physical_range"],
        "The first result is a documented all-electron exception to this gate.",
        session_key=key,
    )
    call = {"action": "submit", "workflow_id": "wf-digests"}
    assert enf.precheck("catgo_workflow", call, key)[0] == enf.PROMPT
    challenge = next(iter(enf.state(key)["approval_challenges"]))
    enf.approve_override(challenge, session_key=key, approved_by="test-human")

    decision, reason = enf.precheck(
        "catgo_workflow", {**call, enf.APPROVAL_ARG: challenge}, key,
    )
    assert decision == enf.FORBIDDEN
    assert "1 other numeric result" in reason
    state = enf.state(key)
    assert state["override"] is not None
    assert state["audit"] == []


def test_endpoint_rejects_direct_forged_and_repeat_calls(tmp_path, monkeypatch):
    secret_file = tmp_path / "approval.key"
    monkeypatch.setenv("CATGO_VERIFY_APPROVAL_SECRET_FILE", str(secret_file))
    key = "http:tab:endpoint-override"
    _failed_override_session(key)
    enf.precheck("catgo_workflow", {"action": "submit"}, key)
    challenge = next(iter(enf.state(key)["approval_challenges"]))
    app = FastAPI()
    app.include_router(system_router, prefix="/api")
    client = TestClient(app)
    url = "/api/system/verification/approve-override"
    body = {"approval_id": challenge, "tab_id": "endpoint-override"}

    assert client.post(url, json=body).status_code == 403
    assert client.post(
        url, json=body, headers={"X-CatGo-Approval-Secret": "0" * 64},
    ).status_code == 403
    response = client.post(
        url, json=body,
        headers={"X-CatGo-Approval-Secret": enf.approval_secret()},
    )
    assert response.status_code == 200
    assert client.post(
        url, json=body,
        headers={"X-CatGo-Approval-Secret": enf.approval_secret()},
    ).status_code == 409
