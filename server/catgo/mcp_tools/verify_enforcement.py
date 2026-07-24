#!/usr/bin/env python3
"""Execution-side enforcement for the verification layer (additive, stdlib-only).

Borrowed design (cite openai/codex, Apache-2.0): execpolicy's tri-state
Decision {allow / prompt / forbidden} with strictest-wins, and the two-axis
idea that a tool's side-effect class — not the agent's intent — decides how
much scrutiny a call gets.

What this fixes: catgo_verify used to be an *optional* tool. An agent could
produce numeric results and submit HPC jobs / report conclusions without ever
calling it, and the omission left no trace (the same shape as AtomisticSkills
issue #30: exit 0, all tests pass, nobody ran the gate). Enforcement makes the
skip impossible instead of impolite:

  numeric-producing tool succeeds      -> session gains unverified results
  catgo_verify runs                    -> pending count clears
  irreversible tool (HPC submit) while
  unverified results are pending       -> FORBIDDEN (call blocked, agent is
                                          told to verify first)

ponytail: PROMPT (human approval for irreversible ops even when verified) is
delegated to the existing permission-manager / decide_tool_permission layer —
this module only adds the FORBIDDEN floor it lacked. State is per-process
(module dict keyed by session), matching the MCP stdio one-process-per-session
model; swap for a store if the server ever multiplexes sessions.
"""

ALLOW, PROMPT, FORBIDDEN = "allow", "prompt", "forbidden"
_SEVERITY = {ALLOW: 0, PROMPT: 1, FORBIDDEN: 2}


def strictest(*decisions):
    return max(decisions, key=lambda d: _SEVERITY[d])


# side-effect classes (comp-chem semantics of codex's sandbox modes)
READ_ONLY = {
    "catgo_analyze", "catgo_view", "catgo_diagnose", "catgo_validate_config",
    "catgo_verify", "catgo_skills", "catgo_system", "catgo_fetch",
}
WORKSPACE_WRITE = {
    "catgo_structure", "catgo_quickbuild", "catgo_file", "catgo_catalysis",
    "catgo_heterostructure", "catgo_nanotube", "catgo_moire",
}
# irreversible: spends shared HPC budget / submits jobs / cannot be rolled back
IRREVERSIBLE = {"catgo_workflow", "catgo_workflow_engine"}
# (tool, action) pairs that actually submit; other actions of the same tool are benign
_IRREVERSIBLE_ACTIONS = {"submit", "run", "execute", "start"}

# numeric-producing (tool, action-prefix) — outputs that downstream conclusions cite
_NUMERIC_TOOLS = {"catgo_analyze", "catgo_catalysis"}
_NUMERIC_EXEMPT_PREFIXES = ("hub_",)  # plugin-hub admin actions produce no physics

_sessions = {}  # session_key -> {"unverified": int, "last_numeric": str|None}


def _st(session_key="default"):
    return _sessions.setdefault(session_key, {"unverified": 0, "last_numeric": None})


def _is_submit(tool, args):
    if tool not in IRREVERSIBLE:
        return False
    action = str((args or {}).get("action", "")).lower()
    # workflow_engine's whole purpose is execution; catgo_workflow only on submit-like actions
    return tool == "catgo_workflow_engine" or action in _IRREVERSIBLE_ACTIONS


def _is_numeric(tool, args):
    if tool not in _NUMERIC_TOOLS:
        return False
    action = str((args or {}).get("action", ""))
    return not action.startswith(_NUMERIC_EXEMPT_PREFIXES)


def precheck(tool, args, session_key="default"):
    """Call BEFORE dispatching a tool. Returns (decision, reason).
    FORBIDDEN only when an irreversible call would launder unverified numbers."""
    st = _st(session_key)
    if _is_submit(tool, args) and st["unverified"] > 0:
        return (FORBIDDEN,
                f"BLOCKED: {st['unverified']} numeric result(s) from "
                f"{st['last_numeric']} have not passed catgo_verify. Run "
                f"catgo_verify on the parsed result (with claims=[...]) before "
                f"submitting — an unverified number must not spend HPC budget.")
    return (ALLOW, "")


def postmark(tool, args, ok=True, session_key="default"):
    """Call AFTER a tool ran. Tracks pending-verification state."""
    st = _st(session_key)
    if not ok:
        return
    if tool == "catgo_verify":
        st["unverified"] = 0
    elif _is_numeric(tool, args):
        st["unverified"] += 1
        st["last_numeric"] = tool


if __name__ == "__main__":
    # strictest-wins
    assert strictest(ALLOW, PROMPT) == PROMPT and strictest(PROMPT, FORBIDDEN) == FORBIDDEN

    sk = "t1"
    # clean session: submit is allowed (approval layer handles the human PROMPT)
    assert precheck("catgo_workflow", {"action": "submit"}, sk)[0] == ALLOW
    # numeric result produced -> submit becomes FORBIDDEN until verified
    postmark("catgo_analyze", {"action": "thermo_free_energy"}, ok=True, session_key=sk)
    dec, reason = precheck("catgo_workflow", {"action": "submit"}, sk)
    assert dec == FORBIDDEN and "catgo_verify" in reason
    # non-submit actions of the same tool stay allowed
    assert precheck("catgo_workflow", {"action": "status"}, sk)[0] == ALLOW
    # hub admin actions are not "numeric"
    postmark("catgo_analyze", {"action": "hub_search"}, ok=True, session_key="t2")
    assert precheck("catgo_workflow_engine", {}, "t2")[0] == ALLOW
    # verify clears the pending state
    postmark("catgo_verify", {}, ok=True, session_key=sk)
    assert precheck("catgo_workflow", {"action": "submit"}, sk)[0] == ALLOW
    # failed tool runs do not count as produced results
    postmark("catgo_analyze", {"action": "dos"}, ok=False, session_key="t3")
    assert precheck("catgo_workflow_engine", {}, "t3")[0] == ALLOW
    print("verify_enforcement self-test OK — tri-state strictest-wins; "
          "unverified numerics FORBID irreversible submits; verify clears; "
          "hub/admin and failed runs exempt")
